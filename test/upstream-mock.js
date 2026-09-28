// Mock upstream MCP server, used only by the test suite.
//
// Wired in as Miniflare's `outboundService` (see vitest.config.ts), so it
// receives every outbound fetch the Worker under test makes. That means tests
// cannot reach the real network, and a call the Worker was not supposed to make
// shows up as an unexpected counter increment rather than a silent success.
//
// Behaviour is chosen by request path, verb and tool name, so tests stay
// declarative:
//
//   POST   /mcp              normal MCP replies (application/json)
//   POST   /http500          replies 502 with a non-JSON body
//   GET    /mcp              a server→client event stream
//   GET    /notstream        answers a GET with JSON instead of a stream
//   DELETE /mcp              session termination, echoing the session id
//
//   tool fail_rpc            a JSON-RPC error envelope (a valid reply, not a failure)
//   tool stream_*            replies as text/event-stream
//   tool stream_fail         streams, but the final message is a JSON-RPC error
//   tool stream_no_response  streams only notifications, never a response
//
// The "unreachable upstream" case does not come through here at all: that
// upstream is configured with an unsupported URL scheme, so fetch() rejects
// before any request is made — the same code path as a dead host.
//
// Every call increments counters in the UPSTREAM_STATE KV namespace, which tests
// read directly to assert how many times the upstream was actually hit. The
// transport headers of the most recent request are stored too, so tests can
// check that the MCP header set was forwarded.

async function bump(state, key) {
  const current = Number((await state.get(key)) ?? "0");
  const next = current + 1;
  await state.put(key, String(next));
  return next;
}

function rpc(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sseEvent(payload) {
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** Emit a sequence of SSE events, then close. */
function sseResponse(events, { sessionId } = {}) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      // A comment line first: the parser must tolerate non-data lines.
      controller.enqueue(encoder.encode(": stream open\n\n"));
      for (const event of events) {
        controller.enqueue(encoder.encode(sseEvent(event)));
      }
      controller.close();
    },
  });

  const headers = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  return new Response(stream, { status: 200, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    // Record the transport headers of the latest request for assertions.
    await env.UPSTREAM_STATE.put(
      "last:headers",
      JSON.stringify({
        accept: request.headers.get("accept"),
        sessionId: request.headers.get("mcp-session-id"),
        protocolVersion: request.headers.get("mcp-protocol-version"),
        lastEventId: request.headers.get("last-event-id"),
      })
    );

    if (method === "GET") {
      await bump(env.UPSTREAM_STATE, "calls:get");
      if (url.pathname === "/notstream") {
        return rpc({ jsonrpc: "2.0", result: { notAStream: true }, id: null });
      }
      return sseResponse([
        { jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } },
        { jsonrpc: "2.0", method: "notifications/message", params: { level: "debug" } },
      ]);
    }

    if (method === "DELETE") {
      await bump(env.UPSTREAM_STATE, "calls:delete");
      const sessionId = request.headers.get("mcp-session-id");
      return new Response(null, {
        status: 204,
        headers: sessionId ? { "Mcp-Session-Id": sessionId } : {},
      });
    }

    if (url.pathname === "/http500") {
      await bump(env.UPSTREAM_STATE, "calls:http500");
      return new Response("upstream is sad", { status: 502 });
    }

    let body = {};
    try {
      body = await request.json();
    } catch {
      // fall through with an empty body
    }

    const rpcMethod = body.method ?? "unknown";
    const params = body.params ?? {};
    const id = body.id ?? null;

    await bump(env.UPSTREAM_STATE, "calls:total");
    await bump(env.UPSTREAM_STATE, `calls:method:${rpcMethod}`);

    if (rpcMethod === "tools/list") {
      return rpc({
        jsonrpc: "2.0",
        result: { tools: [{ name: "upstream_tool", description: "from upstream" }] },
        id,
      });
    }

    if (rpcMethod === "tools/call") {
      const name = params.name ?? "unknown";
      const calls = await bump(env.UPSTREAM_STATE, `calls:tool:${name}`);

      if (name === "fail_rpc") {
        return rpc({
          jsonrpc: "2.0",
          error: { code: -32000, message: "tool exploded", data: { detail: "boom" } },
          id,
        });
      }

      if (typeof name === "string" && name.startsWith("stream_")) {
        const progress = {
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: { progress: 1, total: 2 },
        };

        if (name === "stream_no_response") {
          return sseResponse([progress]);
        }

        if (name === "stream_fail") {
          return sseResponse([
            progress,
            { jsonrpc: "2.0", error: { code: -32050, message: "streamed failure" }, id },
          ]);
        }

        return sseResponse([
          progress,
          {
            jsonrpc: "2.0",
            result: {
              content: [{ type: "text", text: `streamed ${name}` }],
              echo: params.arguments ?? {},
              upstreamCallCount: calls,
            },
            id,
          },
        ]);
      }

      return rpc({
        jsonrpc: "2.0",
        result: {
          content: [{ type: "text", text: `called ${name}` }],
          echo: params.arguments ?? {},
          upstreamCallCount: calls,
        },
        id,
      });
    }

    if (rpcMethod === "resources/list") {
      return rpc({ jsonrpc: "2.0", result: { resources: [{ uri: "file:///a.ts" }] }, id });
    }

    if (rpcMethod === "resources/read") {
      return rpc({
        jsonrpc: "2.0",
        result: { contents: [{ uri: params.uri ?? null, text: "file contents" }] },
        id,
      });
    }

    return rpc({ jsonrpc: "2.0", result: { pong: true, method: rpcMethod }, id });
  },
};
