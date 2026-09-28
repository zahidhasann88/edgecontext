// SSE streaming: passing an upstream event stream through to the client, and
// adapting one for a client that cannot take it.
//
// The proxy must forward the stream rather than buffer it, and still do its
// bookkeeping — session record, log line, and caching — once it completes.

import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  contentText,
  createTenant,
  mcpRequest,
  rpcBody,
  upstreamToolCalls,
  type RpcBody,
} from "./helpers";
import { MCP_ERR_UPSTREAM } from "../src/types";
import {
  acceptsEventStream,
  findResponseEnvelope,
  parseSseMessages,
} from "../src/mcp/sse";

const KEY = "streaming-key";
const SERVERS = ["default", "notstream", "broken"];

beforeAll(async () => {
  await createTenant(KEY, { allowedServers: SERVERS, rateLimitRpm: 10_000 });
});

let seq = 0;
const nextProject = () => `stream-${++seq}`;

function streamingRequest(opts: {
  method: string;
  params?: Record<string, unknown>;
  projectId?: string;
  serverName?: string;
  id?: string | number;
  accept?: string;
  sessionId?: string;
}): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${KEY}`,
    Accept: opts.accept ?? "application/json, text/event-stream",
  };
  if (opts.projectId) headers["X-EdgeContext-Project"] = opts.projectId;
  if (opts.sessionId) headers["Mcp-Session-Id"] = opts.sessionId;

  return new Request(`https://edgecontext.test/mcp/${opts.serverName ?? "default"}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: opts.method,
      ...(opts.params ? { params: opts.params } : {}),
      id: opts.id ?? 1,
    }),
  });
}

const callStreamTool = (
  tool: string,
  projectId: string,
  extra: Partial<Parameters<typeof streamingRequest>[0]> & {
    args?: Record<string, unknown>;
  } = {}
) => {
  const { args, ...rest } = extra;
  return SELF.fetch(
    streamingRequest({
      method: "tools/call",
      params: { name: tool, arguments: args ?? { q: "x" } },
      projectId,
      ...rest,
    })
  );
};

async function lastUpstreamHeaders(): Promise<Record<string, string | null>> {
  const raw = await env.UPSTREAM_STATE.get("last:headers");
  return raw ? JSON.parse(raw) : {};
}

describe("streamed tool calls", () => {
  it("passes an upstream event stream through as text/event-stream", async () => {
    const res = await callStreamTool("stream_basic", nextProject());

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");

    const text = await res.text();
    const messages = parseSseMessages(text) as {
      method?: string;
      result?: { content?: { text: string }[] };
    }[];

    // Both the progress notification and the final result reached the client.
    expect(messages.map((m) => m.method).filter(Boolean)).toEqual([
      "notifications/progress",
    ]);
    const final = messages.find((m) => m.result);
    expect(final?.result?.content?.[0].text).toBe("streamed stream_basic");
  });

  it("does not buffer: the body arrives as a readable stream", async () => {
    const res = await callStreamTool("stream_basic", nextProject());

    expect(res.body).not.toBeNull();
    expect(res.headers.get("Content-Length")).toBeNull();

    // Read incrementally — the first chunk should be available before the last.
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toContain("stream open");
    await reader.cancel();
  });

  it("records a streamed call in the session once the stream completes", async () => {
    const projectId = nextProject();

    const res = await callStreamTool("stream_basic", projectId);
    // Drain the stream: the bookkeeping runs when it ends.
    await res.text();

    const recalled = await rpcBody(
      await SELF.fetch(
        mcpRequest({
          method: "tools/call",
          params: { name: "edgecontext_recall", arguments: {} },
          apiKey: KEY,
          projectId,
        })
      )
    );

    const data = JSON.parse(contentText(recalled.result)) as {
      toolCalls: { toolName: string; streamed?: boolean; success: boolean }[];
    };
    const recorded = data.toolCalls.find((t) => t.toolName === "stream_basic");
    expect(recorded).toBeDefined();
    expect(recorded!.streamed).toBe(true);
    expect(recorded!.success).toBe(true);
  });

  it("records a streamed JSON-RPC error as unsuccessful", async () => {
    const projectId = nextProject();

    const res = await callStreamTool("stream_fail", projectId);
    const messages = parseSseMessages(await res.text());
    const envelope = findResponseEnvelope(messages, null);
    expect(envelope?.error?.message).toBe("streamed failure");

    const recalled = await rpcBody(
      await SELF.fetch(
        mcpRequest({
          method: "tools/call",
          params: { name: "edgecontext_recall", arguments: {} },
          apiKey: KEY,
          projectId,
        })
      )
    );
    const data = JSON.parse(contentText(recalled.result)) as {
      toolCalls: { toolName: string; success: boolean; resultSummary: string }[];
    };
    const failed = data.toolCalls.find((t) => t.toolName === "stream_fail");
    expect(failed?.success).toBe(false);
    expect(failed?.resultSummary).toMatch(/streamed failure/);
  });
});

describe("clients that cannot take a stream", () => {
  it("drains the stream and answers with a single JSON response", async () => {
    const res = await callStreamTool("stream_basic", nextProject(), {
      accept: "application/json",
    });

    expect(res.headers.get("Content-Type")).toContain("application/json");
    const body = await rpcBody(res);
    expect((body.result as { content: { text: string }[] }).content[0].text).toBe(
      "streamed stream_basic"
    );
  });

  it("reports a stream that carried no response as an upstream error", async () => {
    const res = await callStreamTool("stream_no_response", nextProject(), {
      accept: "application/json",
    });

    const body = await rpcBody(res);
    expect(body.error?.code).toBe(MCP_ERR_UPSTREAM);
    expect(body.error?.message).toMatch(/carried no JSON-RPC response/);
  });

  it("only offers SSE upstream when the client accepts it", async () => {
    await callStreamTool("stream_basic", nextProject(), { accept: "application/json" });
    expect((await lastUpstreamHeaders()).accept).toBe("application/json");

    await callStreamTool("stream_basic", nextProject());
    expect((await lastUpstreamHeaders()).accept).toBe(
      "application/json, text/event-stream"
    );
  });
});

describe("caching streamed calls", () => {
  it("caches the streamed result, so the second call does not reach upstream", async () => {
    const projectId = "stream-cache";
    const before = await upstreamToolCalls("stream_cached");

    const args = { q: "cache-probe" };

    const first = await callStreamTool("stream_cached", projectId, { args });
    expect(first.headers.get("X-EdgeContext-Cache")).toBe("MISS");
    expect(first.headers.get("Content-Type")).toContain("text/event-stream");
    // The stream must be drained for the result to be cached.
    await first.text();
    expect(await upstreamToolCalls("stream_cached")).toBe(before + 1);

    // The cached reply is a plain JSON response — there is nothing left to stream.
    const second = await callStreamTool("stream_cached", projectId, { args });
    expect(second.headers.get("X-EdgeContext-Cache")).toBe("HIT");
    expect(second.headers.get("Content-Type")).toContain("application/json");
    expect(await upstreamToolCalls("stream_cached")).toBe(before + 1);

    const body = await rpcBody(second);
    expect((body.result as { content: { text: string }[] }).content[0].text).toBe(
      "streamed stream_cached"
    );
  });

  it("does not cache a stream the client abandoned midway", async () => {
    const projectId = "stream-abandon";
    const args = { q: "abandon-probe" };
    const before = await upstreamToolCalls("stream_cached");

    // Cancel after the first chunk: the result was never fully observed.
    const res = await callStreamTool("stream_cached", projectId, { id: 99, args });
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();

    // A later call must go upstream again rather than serve a partial result.
    const retry = await callStreamTool("stream_cached", projectId, { id: 100, args });
    expect(retry.headers.get("X-EdgeContext-Cache")).toBe("MISS");
    await retry.text();
    expect(await upstreamToolCalls("stream_cached")).toBe(before + 2);
  });
});

describe("GET /mcp/:serverName", () => {
  const openStream = (serverName = "default", headers: Record<string, string> = {}) =>
    SELF.fetch(
      new Request(`https://edgecontext.test/mcp/${serverName}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${KEY}`,
          Accept: "text/event-stream",
          ...headers,
        },
      })
    );

  it("proxies the upstream event stream", async () => {
    const res = await openStream();

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");

    const messages = parseSseMessages(await res.text()) as { method?: string }[];
    expect(messages.map((m) => m.method)).toEqual([
      "notifications/message",
      "notifications/message",
    ]);
  });

  it("requires authentication", async () => {
    const res = await SELF.fetch(
      new Request("https://edgecontext.test/mcp/default", { method: "GET" })
    );
    expect(res.status).toBe(401);
  });

  it("errors clearly when the upstream does not return a stream", async () => {
    const res = await openStream("notstream");
    const body = await rpcBody(res);
    expect(body.error?.code).toBe(MCP_ERR_UPSTREAM);
    expect(body.error?.message).toMatch(/did not return an event stream/);
  });

  it("reports an unreachable upstream", async () => {
    const res = await openStream("broken");
    expect((await rpcBody(res)).error?.code).toBe(MCP_ERR_UPSTREAM);
  });
});

describe("DELETE /mcp/:serverName", () => {
  it("forwards the termination and echoes the session id", async () => {
    const before = Number((await env.UPSTREAM_STATE.get("calls:delete")) ?? "0");

    const res = await SELF.fetch(
      new Request("https://edgecontext.test/mcp/default", {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${KEY}`,
          "Mcp-Session-Id": "session-abc",
        },
      })
    );

    expect(res.status).toBe(204);
    expect(res.headers.get("Mcp-Session-Id")).toBe("session-abc");
    expect(Number(await env.UPSTREAM_STATE.get("calls:delete"))).toBe(before + 1);
  });

  it("rejects an unsupported verb with Allow", async () => {
    const res = await SELF.fetch(
      new Request("https://edgecontext.test/mcp/default", { method: "PUT" })
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST, GET, DELETE");
  });
});

describe("MCP transport header forwarding", () => {
  it("forwards Mcp-Session-Id and protocol version upstream", async () => {
    await SELF.fetch(
      new Request("https://edgecontext.test/mcp/default", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${KEY}`,
          "Mcp-Session-Id": "sess-42",
          "MCP-Protocol-Version": "2025-06-18",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "resources/list", id: 1 }),
      })
    );

    const headers = await lastUpstreamHeaders();
    expect(headers.sessionId).toBe("sess-42");
    expect(headers.protocolVersion).toBe("2025-06-18");
  });

  it("forwards Last-Event-ID so a client can resume a stream", async () => {
    await SELF.fetch(
      new Request("https://edgecontext.test/mcp/default", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${KEY}`,
          Accept: "text/event-stream",
          "Last-Event-ID": "event-7",
        },
      })
    );
    expect((await lastUpstreamHeaders()).lastEventId).toBe("event-7");
  });

  it("echoes Mcp-Session-Id back on a non-streaming reply", async () => {
    const res = await SELF.fetch(
      streamingRequest({ method: "resources/list", sessionId: "sess-echo" })
    );
    expect(res.headers.get("Mcp-Session-Id")).toBe("sess-echo");
  });
});

describe("SSE parsing", () => {
  it("joins multi-line data fields and ignores comments", () => {
    const text = [
      ": keep-alive",
      "",
      "event: message",
      'data: {"jsonrpc":"2.0",',
      'data: "result":{"ok":true},"id":1}',
      "",
    ].join("\n");

    expect(parseSseMessages(text)).toEqual([
      { jsonrpc: "2.0", result: { ok: true }, id: 1 },
    ]);
  });

  it("skips unparseable events rather than throwing", () => {
    const text = 'data: not json\n\ndata: {"result":1,"id":"a"}\n\n';
    expect(parseSseMessages(text)).toEqual([{ result: 1, id: "a" }]);
  });

  it("handles CRLF line endings", () => {
    expect(parseSseMessages('data: {"result":1,"id":2}\r\n\r\n')).toEqual([
      { result: 1, id: 2 },
    ]);
  });

  it("finds the response matching an id, ignoring notifications", () => {
    const messages = [
      { jsonrpc: "2.0", method: "notifications/progress" },
      { jsonrpc: "2.0", result: { a: 1 }, id: "wanted" },
    ];
    expect(findResponseEnvelope(messages, "wanted")?.result).toEqual({ a: 1 });
  });

  it("falls back to the last response when no id matches", () => {
    const messages = [
      { jsonrpc: "2.0", result: { a: 1 }, id: "other" },
      { jsonrpc: "2.0", result: { b: 2 }, id: "another" },
    ];
    expect(findResponseEnvelope(messages, "missing")?.result).toEqual({ b: 2 });
  });

  it("returns undefined when there is no response at all", () => {
    expect(findResponseEnvelope([{ method: "notifications/x" }], "id")).toBeUndefined();
  });

  it("reads Accept headers correctly", () => {
    expect(acceptsEventStream("application/json, text/event-stream")).toBe(true);
    expect(acceptsEventStream("*/*")).toBe(true);
    expect(acceptsEventStream("application/json")).toBe(false);
    expect(acceptsEventStream(null)).toBe(false);
  });
});

export type { RpcBody };
