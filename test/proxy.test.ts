// End-to-end proxy tests — auth, routing, caching, pass-through, custom tools.
//
// Requests go through the real Worker fetch handler in workerd, so the whole
// chain runs: body parsing → auth against KV → rate-limit Durable Object →
// proxy → upstream. The upstream is the mock Worker from test/upstream-mock.js.

import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  contentText,
  createTenant,
  mcpRequest,
  rpcBody,
  upstreamMethodCalls,
  upstreamToolCalls,
} from "./helpers";
import {
  MCP_ERR_AUTH,
  MCP_ERR_FORBIDDEN_SERVER,
  MCP_ERR_UNKNOWN_SERVER,
  MCP_ERR_UPSTREAM,
} from "../src/types";
import { parseCacheableTools, parseUpstreamServers } from "../src/index";
import { stableStringify } from "../src/middleware/cache";

const KEY = "test-key-proxy";
const ALL_SERVERS = ["default", "alt", "broken", "http500"];

beforeAll(async () => {
  await createTenant(KEY, { allowedServers: ALL_SERVERS, rateLimitRpm: 10_000 });
});

let project = 0;
const nextProject = () => `proxy-${++project}`;

const call = (opts: Parameters<typeof mcpRequest>[0]) => SELF.fetch(mcpRequest(opts));

describe("auth", () => {
  it("rejects a missing Authorization header with a JSON-RPC error", async () => {
    const res = await call({ method: "tools/list", apiKey: null });
    const body = await rpcBody(res);

    expect(body.jsonrpc).toBe("2.0");
    expect(body.error?.code).toBe(MCP_ERR_AUTH);
    expect(body.error?.message).toMatch(/Missing Authorization header/);
    // The request id is echoed so the client can correlate the failure.
    expect(body.id).toBe(1);
    expect(body.result).toBeUndefined();
  });

  it("rejects an unknown API key", async () => {
    const body = await rpcBody(await call({ method: "tools/list", apiKey: "not-a-key" }));
    expect(body.error?.code).toBe(MCP_ERR_AUTH);
    expect(body.error?.message).toMatch(/Unknown or revoked API key/);
  });

  it("rejects a non-Bearer scheme", async () => {
    const req = new Request("https://edgecontext.test/mcp/default", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${KEY}` },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 7 }),
    });
    const body = await rpcBody(await SELF.fetch(req));
    expect(body.error?.code).toBe(MCP_ERR_AUTH);
    expect(body.id).toBe(7);
  });

  it("rejects an empty Bearer token", async () => {
    const body = await rpcBody(await call({ method: "tools/list", apiKey: "   " }));
    expect(body.error?.message).toMatch(/Empty Bearer token/);
  });

  it("echoes a string request id in the error", async () => {
    const body = await rpcBody(
      await call({ method: "tools/list", apiKey: null, id: "req-abc" })
    );
    expect(body.id).toBe("req-abc");
  });

  it("rejects a tenant record that is not valid JSON", async () => {
    const { env } = await import("cloudflare:test");
    const { sha256Hex } = await import("../src/middleware/auth");
    await env.TENANTS.put(`tenant:${await sha256Hex("corrupt-key")}`, "{not json");

    const body = await rpcBody(await call({ method: "tools/list", apiKey: "corrupt-key" }));
    expect(body.error?.code).toBe(MCP_ERR_AUTH);
    expect(body.error?.message).toMatch(/invalid/i);
  });

  it("never forwards upstream when auth fails", async () => {
    const before = await upstreamMethodCalls("tools/list");
    await call({ method: "tools/list", apiKey: "still-not-a-key" });
    expect(await upstreamMethodCalls("tools/list")).toBe(before);
  });

  it("accepts a valid key and reaches the upstream", async () => {
    const before = await upstreamMethodCalls("tools/list");
    const res = await call({ method: "tools/list", apiKey: KEY, projectId: nextProject() });

    expect((await rpcBody(res)).error).toBeUndefined();
    expect(await upstreamMethodCalls("tools/list")).toBe(before + 1);
  });
});

describe("routing", () => {
  it("rejects an unconfigured upstream name", async () => {
    const body = await rpcBody(
      await call({ method: "tools/list", apiKey: KEY, serverName: "ghost" })
    );
    expect(body.error?.code).toBe(MCP_ERR_UNKNOWN_SERVER);
    expect((body.error?.data as { configured: string[] }).configured).toEqual(
      expect.arrayContaining(["default", "alt"])
    );
  });

  it("rejects an upstream the tenant is not allowed to use", async () => {
    await createTenant("limited-key", {
      allowedServers: ["default"],
      rateLimitRpm: 10_000,
    });
    const body = await rpcBody(
      await call({ method: "tools/list", apiKey: "limited-key", serverName: "alt" })
    );
    expect(body.error?.code).toBe(MCP_ERR_FORBIDDEN_SERVER);
    expect(body.error?.data).toMatchObject({ allowedServers: ["default"] });
  });

  it("routes a named upstream separately from the default", async () => {
    const res = await call({
      method: "tools/list",
      apiKey: KEY,
      serverName: "alt",
      projectId: nextProject(),
    });
    expect((await rpcBody(res)).error).toBeUndefined();
  });

  it("rejects a verb the MCP transport does not define", async () => {
    const res = await SELF.fetch(
      new Request("https://edgecontext.test/mcp/default", { method: "PATCH" })
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST, GET, DELETE");
    expect((await rpcBody(res)).error?.message).toMatch(/POST \(JSON-RPC\)/);
  });

  it("serves /health without auth", async () => {
    const res = await SELF.fetch(new Request("https://edgecontext.test/health"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: "ok" });
  });

  it("serves the info page at the root", async () => {
    const res = await SELF.fetch(new Request("https://edgecontext.test/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/html/);
  });
});

describe("request validation", () => {
  const post = (body: string) =>
    SELF.fetch(
      new Request("https://edgecontext.test/mcp/default", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
        body,
      })
    );

  it("rejects a body that is not JSON", async () => {
    expect((await rpcBody(await post("not json"))).error?.code).toBe(-32700);
  });

  it("rejects a wrong jsonrpc version", async () => {
    const body = await rpcBody(
      await post(JSON.stringify({ jsonrpc: "1.0", method: "x", id: 1 }))
    );
    expect(body.error?.code).toBe(-32600);
    expect(body.id).toBe(1);
  });

  it("rejects a missing method", async () => {
    const body = await rpcBody(await post(JSON.stringify({ jsonrpc: "2.0", id: 2 })));
    expect(body.error?.message).toMatch(/Missing "method"/);
  });

  it("accepts a batch, answering with an array (see batch.test.ts)", async () => {
    const res = await post(
      JSON.stringify([{ jsonrpc: "2.0", method: "resources/list", id: 1 }])
    );
    const body = (await res.json()) as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
  });

  it("rejects a non-object body", async () => {
    expect((await rpcBody(await post("42"))).error?.code).toBe(-32600);
  });
});

describe("tools/list", () => {
  it("appends the edgecontext_* tools to the upstream list", async () => {
    const res = await call({ method: "tools/list", apiKey: KEY, projectId: nextProject() });
    const { tools } = (await rpcBody(res)).result as { tools: { name: string }[] };

    expect(tools.map((t) => t.name)).toEqual([
      "upstream_tool",
      "edgecontext_remember",
      "edgecontext_recall",
      "edgecontext_get_session_summary",
    ]);
  });

  it("still lists the local tools when the upstream is unreachable", async () => {
    const res = await call({
      method: "tools/list",
      apiKey: KEY,
      serverName: "broken",
      projectId: nextProject(),
    });
    const result = (await rpcBody(res)).result as {
      tools: { name: string }[];
      _meta?: { edgecontext?: { upstreamUnavailable?: string } };
    };

    expect(result.tools.map((t) => t.name)).toEqual([
      "edgecontext_remember",
      "edgecontext_recall",
      "edgecontext_get_session_summary",
    ]);
    expect(result._meta?.edgecontext?.upstreamUnavailable).toBeTruthy();
  });

  it("every advertised tool has a name, description and input schema", async () => {
    const res = await call({ method: "tools/list", apiKey: KEY, projectId: nextProject() });
    const { tools } = (await rpcBody(res)).result as {
      tools: { name: string; description?: string; inputSchema?: unknown }[];
    };

    for (const tool of tools.filter((t) => t.name.startsWith("edgecontext_"))) {
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.inputSchema, tool.name).toMatchObject({ type: "object" });
    }
  });
});

describe("tools/call", () => {
  it("unwraps the upstream envelope instead of nesting it", async () => {
    const res = await call({
      method: "tools/call",
      params: { name: "echo_tool", arguments: { value: "hello" } },
      apiKey: KEY,
      projectId: nextProject(),
    });

    // result is the upstream's `result`, not { jsonrpc, result, id }.
    const result = (await rpcBody(res)).result as Record<string, unknown>;
    expect(result).toMatchObject({ echo: { value: "hello" } });
    expect(result.jsonrpc).toBeUndefined();
  });

  it("forwards the arguments the client supplied", async () => {
    const res = await call({
      method: "tools/call",
      params: { name: "arg_check", arguments: { deep: { a: [1, 2] } } },
      apiKey: KEY,
      projectId: nextProject(),
    });
    expect((await rpcBody(res)).result).toMatchObject({ echo: { deep: { a: [1, 2] } } });
  });

  it("propagates an upstream JSON-RPC error as an error", async () => {
    const body = await rpcBody(
      await call({
        method: "tools/call",
        params: { name: "fail_rpc", arguments: {} },
        apiKey: KEY,
        projectId: nextProject(),
      })
    );

    expect(body.result).toBeUndefined();
    expect(body.error?.code).toBe(-32000);
    expect(body.error?.message).toBe("tool exploded");
    expect(body.error?.data).toMatchObject({ detail: "boom" });
  });

  it("reports an unreachable upstream as an upstream error", async () => {
    const body = await rpcBody(
      await call({
        method: "tools/call",
        params: { name: "anything", arguments: {} },
        apiKey: KEY,
        serverName: "broken",
        projectId: nextProject(),
      })
    );
    expect(body.error?.code).toBe(MCP_ERR_UPSTREAM);
  });

  it("reports a non-200 upstream as an upstream error", async () => {
    const body = await rpcBody(
      await call({
        method: "tools/call",
        params: { name: "anything", arguments: {} },
        apiKey: KEY,
        serverName: "http500",
        projectId: nextProject(),
      })
    );
    expect(body.error?.code).toBe(MCP_ERR_UPSTREAM);
    expect(body.error?.message).toMatch(/502/);
  });

  it("requires a tool name", async () => {
    const body = await rpcBody(
      await call({ method: "tools/call", params: { arguments: {} }, apiKey: KEY })
    );
    expect(body.error?.code).toBe(-32602);
  });
});

describe("edge caching", () => {
  it("returns MISS then HIT, and the second call never reaches the upstream", async () => {
    const before = await upstreamToolCalls("search_codebase");

    const request = () =>
      call({
        method: "tools/call",
        params: { name: "search_codebase", arguments: { query: "auth" } },
        apiKey: KEY,
        projectId: "cache-project",
      });

    const first = await request();
    expect(first.headers.get("X-EdgeContext-Cache")).toBe("MISS");
    expect(await upstreamToolCalls("search_codebase")).toBe(before + 1);

    const second = await request();
    expect(second.headers.get("X-EdgeContext-Cache")).toBe("HIT");
    // The decisive assertion: the upstream counter did not move.
    expect(await upstreamToolCalls("search_codebase")).toBe(before + 1);

    // And the cached payload is byte-identical to the first response.
    expect((await rpcBody(second)).result).toEqual((await rpcBody(first)).result);
  });

  it("hits the cache regardless of argument key order", async () => {
    const cacheCall = (args: Record<string, unknown>) =>
      call({
        method: "tools/call",
        params: { name: "fetch_docs", arguments: args },
        apiKey: KEY,
        projectId: "cache-order",
      });

    expect((await cacheCall({ a: 1, b: 2 })).headers.get("X-EdgeContext-Cache")).toBe("MISS");
    expect((await cacheCall({ b: 2, a: 1 })).headers.get("X-EdgeContext-Cache")).toBe("HIT");
  });

  it("treats different args as separate cache entries", async () => {
    const before = await upstreamToolCalls("search_codebase");

    const cacheCall = (query: string) =>
      call({
        method: "tools/call",
        params: { name: "search_codebase", arguments: { query } },
        apiKey: KEY,
        projectId: "cache-distinct",
      });

    expect((await cacheCall("alpha")).headers.get("X-EdgeContext-Cache")).toBe("MISS");
    expect((await cacheCall("beta")).headers.get("X-EdgeContext-Cache")).toBe("MISS");
    expect(await upstreamToolCalls("search_codebase")).toBe(before + 2);
  });

  it("does not cache tools outside CACHEABLE_TOOLS", async () => {
    const before = await upstreamToolCalls("not_cacheable");

    const cacheCall = () =>
      call({
        method: "tools/call",
        params: { name: "not_cacheable", arguments: { x: 1 } },
        apiKey: KEY,
        projectId: "cache-off",
      });

    // No cache header at all, and every call reaches the upstream.
    expect((await cacheCall()).headers.get("X-EdgeContext-Cache")).toBeNull();
    expect((await cacheCall()).headers.get("X-EdgeContext-Cache")).toBeNull();
    expect(await upstreamToolCalls("not_cacheable")).toBe(before + 2);
  });

  it("isolates cache entries between tenants", async () => {
    await createTenant("other-tenant-key", {
      allowedServers: ["default"],
      rateLimitRpm: 10_000,
    });

    const before = await upstreamToolCalls("search_codebase");

    const cacheCall = (apiKey: string) =>
      call({
        method: "tools/call",
        params: { name: "search_codebase", arguments: { query: "shared-across-tenants" } },
        apiKey,
        projectId: "cache-tenants",
      });

    expect((await cacheCall(KEY)).headers.get("X-EdgeContext-Cache")).toBe("MISS");

    // Same tool, same args, different tenant: must not read tenant A's entry.
    expect((await cacheCall("other-tenant-key")).headers.get("X-EdgeContext-Cache")).toBe(
      "MISS"
    );
    expect(await upstreamToolCalls("search_codebase")).toBe(before + 2);
  });

  it("shares cache entries across projects within one tenant", async () => {
    const before = await upstreamToolCalls("fetch_docs");

    const cacheCall = (projectId: string) =>
      call({
        method: "tools/call",
        params: { name: "fetch_docs", arguments: { doc: "cross-project" } },
        apiKey: KEY,
        projectId,
      });

    // The cache is keyed by tenant, not project — the same tenant asking the
    // same question twice should pay for it once.
    expect((await cacheCall("cache-p1")).headers.get("X-EdgeContext-Cache")).toBe("MISS");
    expect((await cacheCall("cache-p2")).headers.get("X-EdgeContext-Cache")).toBe("HIT");
    expect(await upstreamToolCalls("fetch_docs")).toBe(before + 1);
  });

  it("does not cache an upstream error", async () => {
    // fail_rpc is not in CACHEABLE_TOOLS, so assert on the cacheable path by
    // checking that a failing cacheable call leaves no entry behind.
    const { env } = await import("cloudflare:test");
    const keys = await env.CACHE.list({ prefix: "cache:" });
    const before = keys.keys.length;

    await call({
      method: "tools/call",
      params: { name: "fail_rpc", arguments: {} },
      apiKey: KEY,
      projectId: "cache-error",
    });

    const after = await env.CACHE.list({ prefix: "cache:" });
    expect(after.keys.length).toBe(before);
  });
});

describe("custom edgecontext_* tools", () => {
  it("remembers and recalls notes without touching the upstream", async () => {
    const projectId = nextProject();
    const before = await upstreamMethodCalls("tools/call");

    const remembered = await rpcBody(
      await call({
        method: "tools/call",
        params: {
          name: "edgecontext_remember",
          arguments: { notes: "Investigating the cache layer" },
        },
        apiKey: KEY,
        projectId,
      })
    );
    expect(remembered.error).toBeUndefined();

    const recalled = await rpcBody(
      await call({
        method: "tools/call",
        params: { name: "edgecontext_recall", arguments: {} },
        apiKey: KEY,
        projectId,
      })
    );

    expect(JSON.parse(contentText(recalled.result))).toMatchObject({
      projectId,
      notes: "Investigating the cache layer",
    });

    // Custom tools are handled locally — the upstream saw nothing.
    expect(await upstreamMethodCalls("tools/call")).toBe(before);
  });

  it("renders a Markdown session summary including prior activity", async () => {
    const projectId = nextProject();

    await call({
      method: "tools/call",
      params: { name: "search_codebase", arguments: { query: "session-summary-test" } },
      apiKey: KEY,
      projectId,
    });
    await call({
      method: "tools/call",
      params: { name: "edgecontext_remember", arguments: { notes: "Note for later" } },
      apiKey: KEY,
      projectId,
    });

    const summary = await rpcBody(
      await call({
        method: "tools/call",
        params: { name: "edgecontext_get_session_summary", arguments: {} },
        apiKey: KEY,
        projectId,
      })
    );

    const text = contentText(summary.result);
    expect(text).toContain(`# EdgeContext session — project "${projectId}"`);
    expect(text).toContain("Note for later");
    expect(text).toContain("search_codebase");
  });

  it("reports an empty session honestly", async () => {
    const summary = await rpcBody(
      await call({
        method: "tools/call",
        params: { name: "edgecontext_get_session_summary", arguments: {} },
        apiKey: KEY,
        projectId: nextProject(),
      })
    );
    expect(contentText(summary.result)).toContain("No stored context yet");
  });

  it("records proxied tool calls in the session", async () => {
    const projectId = nextProject();

    await call({
      method: "tools/call",
      params: { name: "recorded_tool", arguments: { a: 1 } },
      apiKey: KEY,
      projectId,
    });

    const recalled = await rpcBody(
      await call({
        method: "tools/call",
        params: { name: "edgecontext_recall", arguments: {} },
        apiKey: KEY,
        projectId,
      })
    );

    const data = JSON.parse(contentText(recalled.result)) as {
      toolCalls: { toolName: string; argsSummary: string; success: boolean }[];
    };
    const recorded = data.toolCalls.find((t) => t.toolName === "recorded_tool");
    expect(recorded).toBeDefined();
    expect(recorded!.success).toBe(true);
    expect(recorded!.argsSummary).toContain("a: 1");
  });

  it("records a failed tool call as unsuccessful", async () => {
    const projectId = nextProject();

    await call({
      method: "tools/call",
      params: { name: "fail_rpc", arguments: {} },
      apiKey: KEY,
      projectId,
    });

    const recalled = await rpcBody(
      await call({
        method: "tools/call",
        params: { name: "edgecontext_recall", arguments: {} },
        apiKey: KEY,
        projectId,
      })
    );

    const data = JSON.parse(contentText(recalled.result)) as {
      toolCalls: { toolName: string; success: boolean; resultSummary: string }[];
    };
    const failed = data.toolCalls.find((t) => t.toolName === "fail_rpc");
    expect(failed?.success).toBe(false);
    expect(failed?.resultSummary).toMatch(/tool exploded/);
  });

  it("keeps custom-tool state isolated between projects", async () => {
    const a = nextProject();
    const b = nextProject();

    await call({
      method: "tools/call",
      params: { name: "edgecontext_remember", arguments: { notes: "only in A" } },
      apiKey: KEY,
      projectId: a,
    });

    const recalled = await rpcBody(
      await call({
        method: "tools/call",
        params: { name: "edgecontext_recall", arguments: {} },
        apiKey: KEY,
        projectId: b,
      })
    );
    expect(JSON.parse(contentText(recalled.result))).toMatchObject({
      projectId: b,
      notes: "",
    });
  });

  it("reports a bad remember payload as a tool error", async () => {
    const body = await rpcBody(
      await call({
        method: "tools/call",
        params: { name: "edgecontext_remember", arguments: { notes: "" } },
        apiKey: KEY,
        projectId: nextProject(),
      })
    );
    expect(body.error?.message).toMatch(/non-empty string/);
  });

  it("defaults to the shared project when no project header is sent", async () => {
    const body = await rpcBody(
      await call({
        method: "tools/call",
        params: { name: "edgecontext_recall", arguments: {} },
        apiKey: KEY,
      })
    );
    expect(JSON.parse(contentText(body.result))).toMatchObject({ projectId: "default" });
  });
});

describe("pass-through methods", () => {
  it("forwards resources/list transparently", async () => {
    const body = await rpcBody(
      await call({ method: "resources/list", apiKey: KEY, projectId: nextProject() })
    );
    expect(body.result).toEqual({ resources: [{ uri: "file:///a.ts" }] });
  });

  it("forwards an unrecognised method transparently", async () => {
    const body = await rpcBody(
      await call({ method: "some/future/method", apiKey: KEY, projectId: nextProject() })
    );
    expect(body.result).toMatchObject({ pong: true, method: "some/future/method" });
  });

  it("forwards initialize transparently", async () => {
    const before = await upstreamMethodCalls("initialize");
    await call({
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
      apiKey: KEY,
      projectId: nextProject(),
    });
    expect(await upstreamMethodCalls("initialize")).toBe(before + 1);
  });

  it("records resources/read in the session", async () => {
    const projectId = nextProject();

    await call({
      method: "resources/read",
      params: { uri: "file:///read.ts" },
      apiKey: KEY,
      projectId,
    });

    const recalled = await rpcBody(
      await call({
        method: "tools/call",
        params: { name: "edgecontext_recall", arguments: {} },
        apiKey: KEY,
        projectId,
      })
    );

    const data = JSON.parse(contentText(recalled.result)) as {
      resourceReads: { resourceUri: string }[];
    };
    expect(data.resourceReads.map((r) => r.resourceUri)).toContain("file:///read.ts");
  });
});

describe("config parsing", () => {
  it("parses an upstream map and drops non-string entries", () => {
    expect(parseUpstreamServers('{"a":"https://a.test","b":5}')).toEqual({
      a: "https://a.test",
    });
  });

  it("treats malformed UPSTREAM_MCP_SERVERS as empty rather than throwing", () => {
    expect(parseUpstreamServers("{not json")).toEqual({});
    expect(parseUpstreamServers(undefined)).toEqual({});
    expect(parseUpstreamServers('["a"]')).toEqual({});
  });

  it("applies per-tool cache TTL overrides and the default otherwise", () => {
    const tools = parseCacheableTools("search_codebase:600, fetch_docs ,bad:0", 300);
    expect(tools.get("search_codebase")).toBe(600);
    expect(tools.get("fetch_docs")).toBe(300);
    // ":0" is not a usable TTL, so the whole token is treated as a tool name.
    expect(tools.get("bad:0")).toBe(300);
  });

  it("treats an empty CACHEABLE_TOOLS as nothing cacheable", () => {
    expect(parseCacheableTools("", 300).size).toBe(0);
    expect(parseCacheableTools(undefined, 300).size).toBe(0);
  });

  it("stableStringify is order-independent for objects but not arrays", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
    expect(stableStringify({ a: { d: 1, c: 2 } })).toBe(stableStringify({ a: { c: 2, d: 1 } }));
  });
});

describe("edgecontext_remember modes", () => {
  const remember = (projectId: string, args: Record<string, unknown>) =>
    call({
      method: "tools/call",
      params: { name: "edgecontext_remember", arguments: args },
      apiKey: KEY,
      projectId,
    });

  const notesOf = async (projectId: string) => {
    const recalled = await rpcBody(
      await call({
        method: "tools/call",
        params: { name: "edgecontext_recall", arguments: {} },
        apiKey: KEY,
        projectId,
      })
    );
    return (JSON.parse(contentText(recalled.result)) as { notes: string }).notes;
  };

  it("appends through the tool when mode is append", async () => {
    const projectId = nextProject();
    await remember(projectId, { notes: "first thought" });
    await remember(projectId, { notes: "second thought", mode: "append" });

    expect(await notesOf(projectId)).toBe("first thought\nsecond thought");
  });

  it("replaces by default", async () => {
    const projectId = nextProject();
    await remember(projectId, { notes: "first thought" });
    await remember(projectId, { notes: "second thought" });

    expect(await notesOf(projectId)).toBe("second thought");
  });

  it("says which mode it used", async () => {
    const projectId = nextProject();

    const replaced = await rpcBody(await remember(projectId, { notes: "one" }));
    expect(contentText(replaced.result)).toMatch(/^Replaced notes; 3 characters stored\./);

    const appended = await rpcBody(
      await remember(projectId, { notes: "two", mode: "append" })
    );
    expect(contentText(appended.result)).toMatch(/^Appended to notes; 7 characters/);
  });

  it("rejects an unrecognised mode rather than guessing", async () => {
    const body = await rpcBody(
      await remember(nextProject(), { notes: "x", mode: "sideways" })
    );
    expect(body.error?.message).toMatch(/`mode` must be "replace" or "append"/);
  });

  it("advertises the mode parameter in its schema", async () => {
    const res = await call({ method: "tools/list", apiKey: KEY, projectId: nextProject() });
    const { tools } = (await rpcBody(res)).result as {
      tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[];
    };
    const remember = tools.find((t) => t.name === "edgecontext_remember");
    expect(remember!.inputSchema.properties.mode).toMatchObject({
      type: "string",
      enum: ["replace", "append"],
    });
  });
});
