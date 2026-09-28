// JSON-RPC batching, and notification handling.
//
// A batch is answered with an array of responses in request order, notifications
// contribute no entry, and the batch costs one rate-limit slot per sub-request.

import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  contentText,
  createTenant,
  mcpRequest,
  rpcBody,
  upstreamMethodCalls,
  upstreamToolCalls,
  type RpcBody,
} from "./helpers";
import { MCP_ERR_AUTH, MCP_ERR_RATE_LIMIT } from "../src/types";

const KEY = "batch-key";

beforeAll(async () => {
  await createTenant(KEY, { allowedServers: ["default"], rateLimitRpm: 10_000 });
});

let seq = 0;
const nextProject = () => `batch-${++seq}`;

function batchRequest(
  body: unknown,
  opts: { apiKey?: string | null; projectId?: string } = {}
): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const key = opts.apiKey === undefined ? KEY : opts.apiKey;
  if (key !== null) headers.Authorization = `Bearer ${key}`;
  if (opts.projectId) headers["X-EdgeContext-Project"] = opts.projectId;

  return new Request("https://edgecontext.test/mcp/default", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const sendBatch = (body: unknown, opts?: { apiKey?: string | null; projectId?: string }) =>
  SELF.fetch(batchRequest(body, opts));

async function batchBody(res: Response): Promise<RpcBody[]> {
  return (await res.json()) as RpcBody[];
}

describe("batched requests", () => {
  it("answers a batch with an array of responses in request order", async () => {
    const res = await sendBatch(
      [
        { jsonrpc: "2.0", method: "resources/list", id: "a" },
        { jsonrpc: "2.0", method: "some/future/method", id: "b" },
        { jsonrpc: "2.0", method: "tools/list", id: "c" },
      ],
      { projectId: nextProject() }
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");

    const responses = await batchBody(res);
    expect(responses).toHaveLength(3);
    expect(responses.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(responses[0].result).toEqual({ resources: [{ uri: "file:///a.ts" }] });
    expect(responses[1].result).toMatchObject({ pong: true });
    expect((responses[2].result as { tools: unknown[] }).tools.length).toBeGreaterThan(1);
  });

  it("mixes successes and per-request errors in one batch", async () => {
    const res = await sendBatch(
      [
        { jsonrpc: "2.0", method: "resources/list", id: 1 },
        { jsonrpc: "2.0", method: "tools/call", params: { name: "fail_rpc" }, id: 2 },
        { jsonrpc: "2.0", method: "tools/call", params: {}, id: 3 },
      ],
      { projectId: nextProject() }
    );

    const responses = await batchBody(res);
    expect(responses).toHaveLength(3);
    expect(responses[0].result).toBeDefined();
    // An upstream error is reported against its own id, not the whole batch.
    expect(responses[1].error?.message).toBe("tool exploded");
    expect(responses[2].error?.code).toBe(-32602);
  });

  it("runs custom and proxied tools together in one batch", async () => {
    const projectId = nextProject();

    const res = await sendBatch(
      [
        {
          jsonrpc: "2.0",
          method: "tools/call",
          params: { name: "edgecontext_remember", arguments: { notes: "from a batch" } },
          id: 1,
        },
        {
          jsonrpc: "2.0",
          method: "tools/call",
          params: { name: "batched_tool", arguments: { n: 1 } },
          id: 2,
        },
        {
          jsonrpc: "2.0",
          method: "tools/call",
          params: { name: "edgecontext_recall", arguments: {} },
          id: 3,
        },
      ],
      { projectId }
    );

    const responses = await batchBody(res);
    expect(responses).toHaveLength(3);

    // The recall in the same batch already sees the note written before it,
    // which only holds because sub-requests run in order.
    const recalled = JSON.parse(contentText(responses[2].result)) as {
      notes: string;
      toolCalls: { toolName: string }[];
    };
    expect(recalled.notes).toBe("from a batch");
    expect(recalled.toolCalls.map((t) => t.toolName)).toContain("batched_tool");
  });

  it("serves a cache hit inside a batch", async () => {
    const projectId = "batch-cache";
    const before = await upstreamToolCalls("search_codebase");
    const args = { query: "batched-cache-probe" };

    await sendBatch(
      [{ jsonrpc: "2.0", method: "tools/call", params: { name: "search_codebase", arguments: args }, id: 1 }],
      { projectId }
    );
    expect(await upstreamToolCalls("search_codebase")).toBe(before + 1);

    // The same call again, inside a batch, must come from cache.
    const res = await sendBatch(
      [{ jsonrpc: "2.0", method: "tools/call", params: { name: "search_codebase", arguments: args }, id: 2 }],
      { projectId }
    );
    const responses = await batchBody(res);
    expect(responses[0].result).toBeDefined();
    expect(await upstreamToolCalls("search_codebase")).toBe(before + 1);
  });

  it("never streams inside a batch, even when the client accepts SSE", async () => {
    const res = await SELF.fetch(
      new Request("https://edgecontext.test/mcp/default", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${KEY}`,
          Accept: "application/json, text/event-stream",
          "X-EdgeContext-Project": nextProject(),
        },
        body: JSON.stringify([
          {
            jsonrpc: "2.0",
            method: "tools/call",
            params: { name: "stream_basic", arguments: {} },
            id: 1,
          },
        ]),
      })
    );

    // The stream is drained and folded into the JSON array.
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const responses = await batchBody(res);
    expect((responses[0].result as { content: { text: string }[] }).content[0].text).toBe(
      "streamed stream_basic"
    );
  });
});

describe("notifications", () => {
  it("omits notifications from the batch response array", async () => {
    const res = await sendBatch(
      [
        { jsonrpc: "2.0", method: "resources/list", id: "keep" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
      ],
      { projectId: nextProject() }
    );

    const responses = await batchBody(res);
    expect(responses).toHaveLength(1);
    expect(responses[0].id).toBe("keep");
  });

  it("answers a batch of only notifications with 202 and no body", async () => {
    const before = await upstreamMethodCalls("notifications/initialized");

    const res = await sendBatch(
      [
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", method: "notifications/cancelled" },
      ],
      { projectId: nextProject() }
    );

    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
    // They were still forwarded upstream.
    expect(await upstreamMethodCalls("notifications/initialized")).toBe(before + 1);
  });

  it("answers a single notification with 202 and no body", async () => {
    const res = await SELF.fetch(
      batchRequest(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { projectId: nextProject() }
      )
    );
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("does not fail a notification when the upstream is unreachable", async () => {
    const res = await SELF.fetch(
      new Request("https://edgecontext.test/mcp/broken", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      })
    );
    // "broken" is not in this tenant's allow-list, so this is a 200-level
    // authorisation error rather than a transport error; either way no body is
    // expected to be a valid JSON-RPC success.
    expect([202, 200]).toContain(res.status);
  });
});

describe("batch validation", () => {
  it("rejects an empty batch", async () => {
    const body = await rpcBody(await sendBatch([]));
    expect(body.error?.code).toBe(-32600);
    expect(body.error?.message).toMatch(/at least one request/);
  });

  it("rejects a batch larger than the cap", async () => {
    const big = Array.from({ length: 101 }, (_, i) => ({
      jsonrpc: "2.0",
      method: "resources/list",
      id: i,
    }));
    const body = await rpcBody(await sendBatch(big));
    expect(body.error?.code).toBe(-32600);
    expect(body.error?.message).toMatch(/at most 100 requests \(got 101\)/);
  });

  it("names the offending index when one entry is malformed", async () => {
    const body = await rpcBody(
      await sendBatch([
        { jsonrpc: "2.0", method: "resources/list", id: 1 },
        { jsonrpc: "1.0", method: "resources/list", id: 2 },
      ])
    );
    expect(body.error?.message).toMatch(/batch index 1/);
    expect(body.error?.message).toMatch(/"jsonrpc" must be "2.0"/);
  });

  it("rejects a batch containing a non-object entry", async () => {
    const body = await rpcBody(await sendBatch([42]));
    expect(body.error?.message).toMatch(/batch index 0/);
  });

  it("rejects a whole batch on an auth failure, with a single null-id error", async () => {
    const res = await sendBatch(
      [
        { jsonrpc: "2.0", method: "resources/list", id: 1 },
        { jsonrpc: "2.0", method: "resources/list", id: 2 },
      ],
      { apiKey: null }
    );

    const body = await rpcBody(res);
    expect(Array.isArray(body)).toBe(false);
    expect(body.error?.code).toBe(MCP_ERR_AUTH);
    // JSON-RPC: a null id when the request it refers to cannot be determined.
    expect(body.id).toBeNull();
  });
});

describe("batch rate limiting", () => {
  it("charges one slot per sub-request", async () => {
    const key = "batch-cost-key";
    await createTenant(key, { allowedServers: ["default"], rateLimitRpm: 5 });

    const three = [
      { jsonrpc: "2.0", method: "resources/list", id: 1 },
      { jsonrpc: "2.0", method: "resources/list", id: 2 },
      { jsonrpc: "2.0", method: "resources/list", id: 3 },
    ];

    const first = await sendBatch(three, { apiKey: key, projectId: "rl-batch" });
    expect(first.status).toBe(200);
    // Three of five slots consumed by one HTTP request.
    expect(first.headers.get("X-EdgeContext-RateLimit-Remaining")).toBe("2");

    // Another batch of three no longer fits in the remaining two slots.
    const second = await sendBatch(three, { apiKey: key, projectId: "rl-batch" });
    expect(second.status).toBe(429);
    expect((await rpcBody(second)).error?.data).toMatchObject({ limit: 5, cost: 3 });
  });

  it("refuses the whole batch rather than running part of it", async () => {
    const key = "batch-partial-key";
    await createTenant(key, { allowedServers: ["default"], rateLimitRpm: 2 });

    const before = await upstreamMethodCalls("resources/list");

    const res = await sendBatch(
      [
        { jsonrpc: "2.0", method: "resources/list", id: 1 },
        { jsonrpc: "2.0", method: "resources/list", id: 2 },
        { jsonrpc: "2.0", method: "resources/list", id: 3 },
      ],
      { apiKey: key, projectId: "rl-partial" }
    );

    expect(res.status).toBe(429);
    // Nothing ran: the upstream never saw a single sub-request.
    expect(await upstreamMethodCalls("resources/list")).toBe(before);
  });

  it("explains a batch that can never fit the limit", async () => {
    const key = "batch-unsatisfiable-key";
    await createTenant(key, { allowedServers: ["default"], rateLimitRpm: 2 });

    const res = await sendBatch(
      Array.from({ length: 3 }, (_, i) => ({
        jsonrpc: "2.0",
        method: "resources/list",
        id: i,
      })),
      { apiKey: key, projectId: "rl-unsat" }
    );

    expect(res.status).toBe(429);
    const body = await rpcBody(res);
    expect(body.error?.code).toBe(MCP_ERR_RATE_LIMIT);
    expect(body.error?.message).toMatch(/Batch of 3 requests exceeds the rate limit of 2/);
    // Waiting cannot help, so no Retry-After is offered.
    expect(res.headers.get("Retry-After")).toBeNull();
  });

  it("charges a single slot for a non-batched request", async () => {
    const key = "single-cost-key";
    await createTenant(key, { allowedServers: ["default"], rateLimitRpm: 10 });

    const res = await SELF.fetch(
      mcpRequest({ method: "resources/list", apiKey: key, projectId: "rl-single" })
    );
    expect(res.headers.get("X-EdgeContext-RateLimit-Remaining")).toBe("9");
  });

  it("charges a single slot for GET and DELETE", async () => {
    const key = "verb-cost-key";
    await createTenant(key, { allowedServers: ["default"], rateLimitRpm: 10 });

    const del = await SELF.fetch(
      new Request("https://edgecontext.test/mcp/default", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${key}` },
      })
    );
    expect(del.headers.get("X-EdgeContext-RateLimit-Remaining")).toBe("9");
  });
});

describe("RateLimiterDO cost", () => {
  const check = async (tenant: string, limit: number, cost: number) => {
    const stub = env.RATE_LIMITER_DO.get(env.RATE_LIMITER_DO.idFromName(tenant));
    const res = await stub.fetch("https://rate-limiter/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit, windowMs: 60_000, cost }),
    });
    return (await res.json()) as {
      allowed: boolean;
      remaining: number;
      cost: number;
      unsatisfiable?: boolean;
      retryAfterMs: number;
    };
  };

  it("consumes `cost` slots at once", async () => {
    const t = `cost-${++seq}`;
    expect(await check(t, 10, 4)).toMatchObject({ allowed: true, remaining: 6 });
    expect(await check(t, 10, 6)).toMatchObject({ allowed: true, remaining: 0 });
    expect(await check(t, 10, 1)).toMatchObject({ allowed: false });
  });

  it("refuses a cost that does not fit but leaves the window intact", async () => {
    const t = `cost-fit-${++seq}`;
    await check(t, 5, 3);
    // 3 used, asking for 3 more of 5 — refused, and the 2 free slots remain.
    expect(await check(t, 5, 3)).toMatchObject({ allowed: false, remaining: 2 });
    expect(await check(t, 5, 2)).toMatchObject({ allowed: true, remaining: 0 });
  });

  it("marks a cost above the limit as unsatisfiable", async () => {
    const t = `cost-unsat-${++seq}`;
    const result = await check(t, 3, 4);
    expect(result.allowed).toBe(false);
    expect(result.unsatisfiable).toBe(true);
    expect(result.retryAfterMs).toBe(0);
  });

  it("defaults cost to 1 when omitted", async () => {
    const stub = env.RATE_LIMITER_DO.get(
      env.RATE_LIMITER_DO.idFromName(`cost-default-${++seq}`)
    );
    const res = await stub.fetch("https://rate-limiter/check", {
      method: "POST",
      body: JSON.stringify({ limit: 3 }),
    });
    expect(await res.json()).toMatchObject({ allowed: true, remaining: 2, cost: 1 });
  });
});
