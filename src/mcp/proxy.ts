// Dispatch returns an RpcOutcome rather than a Response so that one code path
// serves all three shapes of reply: a single JSON response, a JSON array for a
// batch, and a passed-through event stream.
//
// The upstream's envelope is unwrapped: its `result` becomes our `result`, and
// its `error` is propagated as our error under the client's own request id.

import {
  MCP_ERR_TOOL_FAILED,
  MCP_ERR_UPSTREAM,
  JSONRPC_ERR_INVALID_PARAMS,
  type CacheStatus,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type RequestContext,
  type ResourceReadRecord,
  type RpcOutcome,
  type SessionDoStub,
  type ToolCallRecord,
} from "../types";
import { JSON_HEADERS, jsonRpcError, jsonRpcSuccess } from "./jsonrpc";
import { EDGE_CONTEXT_TOOLS, handleCustomTool, isCustomTool } from "./tools";
import { checkCache, isCacheable, storeCache } from "../middleware/cache";
import { buildLogEntry } from "../logging/logger";
import {
  drainSse,
  findResponseEnvelope,
  isEventStream,
  observeStream,
  parseSseMessages,
  type SseEnvelope,
} from "./sse";

const UPSTREAM_TIMEOUT_MS = 30_000;

// Mcp-Session-Id is how a server tracks a logical session across requests, so a
// proxy that drops it breaks every stateful upstream. Last-Event-ID is how a
// client resumes an interrupted stream.
const FORWARDED_TO_UPSTREAM = [
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
];
const FORWARDED_TO_CLIENT = ["mcp-session-id"];

interface UpstreamEnvelope extends SseEnvelope {}

type UpstreamReply =
  | { kind: "json"; envelope: UpstreamEnvelope }
  | { kind: "stream"; response: Response };

export async function handleProxyRequest(ctx: RequestContext): Promise<Response> {
  return ctx.isBatch ? handleBatch(ctx) : handleSingle(ctx);
}

async function handleSingle(ctx: RequestContext): Promise<Response> {
  const rpcReq = ctx.rpcReqs[0];
  const id = rpcReq.id ?? null;
  const outcome = await dispatch(ctx, rpcReq, ctx.acceptsEventStream);

  if (outcome.kind === "stream") return outcome.response;

  if (outcome.kind === "none") {
    return new Response(null, { status: 202, headers: upstreamEchoHeaders(ctx) });
  }

  const headers = {
    ...upstreamEchoHeaders(ctx),
    ...(outcome.cache ? { "X-EdgeContext-Cache": outcome.cache } : {}),
  };

  return outcome.kind === "result"
    ? jsonRpcSuccess(outcome.result, id, headers)
    : jsonRpcError(outcome.code, outcome.message, id, {
        ...(outcome.data !== undefined ? { data: outcome.data } : {}),
        headers,
      });
}

/**
 * Sub-requests run in order rather than concurrently: a batch of twenty should
 * not open twenty simultaneous upstream connections on one client's behalf, and
 * sequential execution keeps recorded session history in the order the client
 * wrote it.
 */
async function handleBatch(ctx: RequestContext): Promise<Response> {
  const responses: JsonRpcResponse[] = [];

  for (const rpcReq of ctx.rpcReqs) {
    const outcome = await dispatch(ctx, rpcReq, false);
    if (outcome.kind === "none") continue;

    const id = rpcReq.id ?? null;
    if (outcome.kind === "result") {
      responses.push({ jsonrpc: "2.0", result: outcome.result, id });
    } else if (outcome.kind === "error") {
      responses.push({
        jsonrpc: "2.0",
        error: {
          code: outcome.code,
          message: outcome.message,
          ...(outcome.data !== undefined ? { data: outcome.data } : {}),
        },
        id,
      });
    }
  }

  if (responses.length === 0) {
    return new Response(null, { status: 202, headers: upstreamEchoHeaders(ctx) });
  }

  return new Response(JSON.stringify(responses), {
    status: 200,
    headers: { ...JSON_HEADERS, ...upstreamEchoHeaders(ctx) },
  });
}

/**
 * The channel an MCP server uses to push requests and notifications outside of
 * any single call. Forwarded live, with no buffering or inspection.
 */
export async function handleStreamOpen(ctx: RequestContext): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(ctx.upstreamUrl, {
      method: "GET",
      headers: outgoingHeaders(ctx, { Accept: "text/event-stream" }),
    });
  } catch (err) {
    return upstreamErrorResponse(err, null);
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 500);
    return jsonRpcError(
      MCP_ERR_UPSTREAM,
      `Upstream returned ${res.status} ${res.statusText} for the event stream.`,
      null,
      { ...(detail ? { data: { detail } } : {}) }
    );
  }

  if (!isEventStream(res)) {
    return jsonRpcError(
      MCP_ERR_UPSTREAM,
      "Upstream did not return an event stream for GET.",
      null,
      { data: { contentType: res.headers.get("Content-Type") } }
    );
  }

  const headers = new Headers();
  headers.set("Content-Type", "text/event-stream");
  headers.set("Cache-Control", "no-cache");
  copyHeaders(res.headers, headers, FORWARDED_TO_CLIENT);
  return new Response(res.body, { status: res.status, headers });
}

export async function handleSessionDelete(ctx: RequestContext): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(ctx.upstreamUrl, {
      method: "DELETE",
      headers: outgoingHeaders(ctx),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    return upstreamErrorResponse(err, null);
  }

  const headers = new Headers();
  copyHeaders(res.headers, headers, FORWARDED_TO_CLIENT);
  return new Response(null, { status: res.status, headers });
}

async function dispatch(
  ctx: RequestContext,
  rpcReq: JsonRpcRequest,
  allowStreaming: boolean
): Promise<RpcOutcome> {
  const session = sessionStub(ctx);

  switch (rpcReq.method) {
    case "tools/list":
      return listTools(ctx, rpcReq);
    case "tools/call":
      return callTool(ctx, rpcReq, session, allowStreaming);
    case "resources/read":
      return readResource(ctx, rpcReq, session, allowStreaming);
    default:
      return passThrough(ctx, rpcReq, allowStreaming);
  }
}

function sessionStub(ctx: RequestContext): SessionDoStub {
  return ctx.env.SESSION_DO.get(ctx.env.SESSION_DO.idFromName(ctx.projectId));
}

function isNotification(rpcReq: JsonRpcRequest): boolean {
  return !("id" in rpcReq) || rpcReq.id === undefined;
}

async function callUpstream(
  ctx: RequestContext,
  method: string,
  params: unknown,
  options: { allowStreaming: boolean; upstreamId: string }
): Promise<UpstreamReply> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    method,
    ...(params === undefined ? {} : { params }),
    id: options.upstreamId,
  });

  const accept = options.allowStreaming
    ? "application/json, text/event-stream"
    : "application/json";

  const res = await fetch(ctx.upstreamUrl, {
    method: "POST",
    headers: outgoingHeaders(ctx, { "Content-Type": "application/json", Accept: accept }),
    body,
    ...(options.allowStreaming ? {} : { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) }),
  });

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 500);
    throw new UpstreamError(
      `Upstream returned ${res.status} ${res.statusText}`,
      detail || undefined
    );
  }

  if (isEventStream(res)) {
    if (options.allowStreaming) return { kind: "stream", response: res };

    const messages = await drainSse(res);
    const envelope = findResponseEnvelope(messages, options.upstreamId);
    if (!envelope) {
      throw new UpstreamError("Upstream event stream carried no JSON-RPC response");
    }
    return { kind: "json", envelope };
  }

  try {
    return { kind: "json", envelope: (await res.json()) as UpstreamEnvelope };
  } catch {
    throw new UpstreamError("Upstream response was not valid JSON");
  }
}

async function callUpstreamJson(
  ctx: RequestContext,
  method: string,
  params: unknown,
  upstreamId = ctx.requestId
): Promise<UpstreamEnvelope> {
  const reply = await callUpstream(ctx, method, params, {
    allowStreaming: false,
    upstreamId,
  });
  return (reply as { kind: "json"; envelope: UpstreamEnvelope }).envelope;
}

class UpstreamError extends Error {
  constructor(
    message: string,
    readonly detail?: string
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

function upstreamErrorOutcome(err: unknown): RpcOutcome {
  if (err instanceof UpstreamError) {
    return {
      kind: "error",
      code: MCP_ERR_UPSTREAM,
      message: err.message,
      ...(err.detail ? { data: { detail: err.detail } } : {}),
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    kind: "error",
    code: MCP_ERR_UPSTREAM,
    message: `Upstream request failed: ${message}`,
  };
}

function upstreamErrorResponse(err: unknown, id: string | number | null): Response {
  const outcome = upstreamErrorOutcome(err);
  if (outcome.kind !== "error") throw new Error("unreachable");
  return jsonRpcError(outcome.code, outcome.message, id, {
    ...(outcome.data !== undefined ? { data: outcome.data } : {}),
  });
}

function outgoingHeaders(
  ctx: RequestContext,
  extra: Record<string, string> = {}
): Headers {
  const headers = new Headers(extra);
  copyHeaders(ctx.clientHeaders, headers, FORWARDED_TO_UPSTREAM);
  return headers;
}

function copyHeaders(from: Headers, to: Headers, names: string[]): void {
  for (const name of names) {
    const value = from.get(name);
    if (value !== null) to.set(name, value);
  }
}

function upstreamEchoHeaders(ctx: RequestContext): Record<string, string> {
  const sessionId = ctx.clientHeaders.get("mcp-session-id");
  return sessionId ? { "Mcp-Session-Id": sessionId } : {};
}

async function listTools(
  ctx: RequestContext,
  rpcReq: JsonRpcRequest
): Promise<RpcOutcome> {
  if (isNotification(rpcReq)) return { kind: "none" };

  let upstreamTools: unknown[] = [];
  let upstreamUnavailable: string | undefined;

  try {
    const envelope = await callUpstreamJson(ctx, "tools/list", rpcReq.params ?? {});
    if (envelope.error) {
      upstreamUnavailable = envelope.error.message;
    } else {
      upstreamTools = extractToolList(envelope.result);
    }
  } catch (err) {
    upstreamUnavailable = err instanceof Error ? err.message : String(err);
    console.warn("tools/list: upstream unavailable:", upstreamUnavailable);
  }

  return {
    kind: "result",
    result: {
      tools: [...upstreamTools, ...EDGE_CONTEXT_TOOLS],
      ...(upstreamUnavailable
        ? { _meta: { edgecontext: { upstreamUnavailable } } }
        : {}),
    },
  };
}

function extractToolList(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object") {
    const tools = (result as { tools?: unknown }).tools;
    if (Array.isArray(tools)) return tools;
  }
  return [];
}

async function callTool(
  ctx: RequestContext,
  rpcReq: JsonRpcRequest,
  session: SessionDoStub,
  allowStreaming: boolean
): Promise<RpcOutcome> {
  const params = (rpcReq.params ?? {}) as Record<string, unknown>;
  const toolName = params.name;

  if (typeof toolName !== "string" || !toolName) {
    if (isNotification(rpcReq)) return { kind: "none" };
    return {
      kind: "error",
      code: JSONRPC_ERR_INVALID_PARAMS,
      message: 'tools/call requires a string "name" parameter.',
    };
  }

  const args = params.arguments ?? {};
  const tenantPrefix = ctx.hashedKey?.slice(0, 8) ?? "unknown";
  const started = Date.now();
  const notification = isNotification(rpcReq);

  if (isCustomTool(toolName)) {
    try {
      const result = await handleCustomTool(toolName, args, {
        projectId: ctx.projectId,
        session,
      });
      await record(ctx, session, {
        toolName,
        args,
        resultSummary: "OK",
        durationMs: Date.now() - started,
        cacheHit: false,
        success: true,
        tenantPrefix,
      });
      return notification ? { kind: "none" } : { kind: "result", result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await record(ctx, session, {
        toolName,
        args,
        resultSummary: `ERROR: ${message}`,
        durationMs: Date.now() - started,
        cacheHit: false,
        success: false,
        tenantPrefix,
        error: message,
      });
      return notification
        ? { kind: "none" }
        : {
            kind: "error",
            code: MCP_ERR_TOOL_FAILED,
            message: `Tool "${toolName}" failed: ${message}`,
          };
    }
  }

  const cacheable = isCacheable(ctx, toolName);
  if (cacheable) {
    const cached = await checkCache(ctx, toolName, args);
    if (cached.hit) {
      await record(ctx, session, {
        toolName,
        args,
        resultSummary: "OK (cached)",
        durationMs: Date.now() - started,
        cacheHit: true,
        success: true,
        tenantPrefix,
      });
      return notification
        ? { kind: "none" }
        : { kind: "result", result: cached.result, cache: "HIT" };
    }
  }

  const cacheStatus: CacheStatus | undefined = cacheable ? "MISS" : undefined;

  let reply: UpstreamReply;
  try {
    reply = await callUpstream(
      ctx,
      "tools/call",
      { name: toolName, arguments: args },
      { allowStreaming, upstreamId: ctx.requestId }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await record(ctx, session, {
      toolName,
      args,
      resultSummary: `ERROR: ${message}`,
      durationMs: Date.now() - started,
      cacheHit: false,
      success: false,
      tenantPrefix,
      error: message,
    });
    return notification ? { kind: "none" } : upstreamErrorOutcome(err);
  }

  if (reply.kind === "stream") {
    return {
      kind: "stream",
      response: streamToolCall(ctx, session, reply.response, {
        toolName,
        args,
        started,
        tenantPrefix,
        cacheable,
        cacheStatus,
      }),
    };
  }

  const envelope = reply.envelope;
  const durationMs = Date.now() - started;

  if (envelope.error) {
    await record(ctx, session, {
      toolName,
      args,
      resultSummary: `ERROR: ${envelope.error.message}`,
      durationMs,
      cacheHit: false,
      success: false,
      tenantPrefix,
      error: envelope.error.message,
    });
    return notification
      ? { kind: "none" }
      : {
          kind: "error",
          code: envelope.error.code,
          message: envelope.error.message,
          ...(envelope.error.data !== undefined ? { data: envelope.error.data } : {}),
          ...(cacheStatus ? { cache: cacheStatus } : {}),
        };
  }

  if (cacheable) await storeCache(ctx, toolName, args, envelope.result);

  await record(ctx, session, {
    toolName,
    args,
    resultSummary: "OK",
    durationMs,
    cacheHit: false,
    success: true,
    tenantPrefix,
  });

  return notification
    ? { kind: "none" }
    : {
        kind: "result",
        result: envelope.result,
        ...(cacheStatus ? { cache: cacheStatus } : {}),
      };
}

interface StreamBookkeeping {
  toolName: string;
  args: unknown;
  started: number;
  tenantPrefix: string;
  cacheable: boolean;
  cacheStatus: CacheStatus | undefined;
}

/**
 * Forwards a streamed tool call, then caches and records it once it completes.
 *
 * The client never waits on the bookkeeping: the session and cache writes happen
 * after the last byte, extended past the response with waitUntil. A stream the
 * client abandoned, or one too large to hold, is recorded but not cached, since a
 * partial result must not become a cache entry.
 */
function streamToolCall(
  ctx: RequestContext,
  session: SessionDoStub,
  upstream: Response,
  book: StreamBookkeeping
): Response {
  const extraHeaders: Record<string, string> = {
    ...upstreamEchoHeaders(ctx),
    ...(book.cacheStatus ? { "X-EdgeContext-Cache": book.cacheStatus } : {}),
  };

  return observeStream(upstream, extraHeaders, (text, truncated) => {
    const durationMs = Date.now() - book.started;
    const envelope = truncated
      ? undefined
      : findResponseEnvelope(parseSseMessages(text), ctx.requestId);

    const failed = envelope?.error;
    const summary = truncated
      ? "OK (streamed, not cached)"
      : failed
        ? `ERROR: ${failed.message}`
        : "OK (streamed)";

    const work = (async () => {
      if (!truncated && envelope && !failed && book.cacheable) {
        await storeCache(ctx, book.toolName, book.args, envelope.result);
      }
      await record(ctx, session, {
        toolName: book.toolName,
        args: book.args,
        resultSummary: summary,
        durationMs,
        cacheHit: false,
        success: !failed,
        tenantPrefix: book.tenantPrefix,
        streamed: true,
        ...(failed ? { error: failed.message } : {}),
      });
    })();

    ctx.waitUntil(work);
  });
}

async function readResource(
  ctx: RequestContext,
  rpcReq: JsonRpcRequest,
  session: SessionDoStub,
  allowStreaming: boolean
): Promise<RpcOutcome> {
  const outcome = await passThrough(ctx, rpcReq, allowStreaming);

  const uri = (rpcReq.params as { uri?: unknown } | undefined)?.uri;
  const succeeded = outcome.kind === "result" || outcome.kind === "stream";
  if (succeeded && typeof uri === "string" && uri) {
    const read: ResourceReadRecord = { resourceUri: uri, timestamp: Date.now() };
    const write = postToSession(session, "/resource-read", { record: read });
    if (outcome.kind === "stream") ctx.waitUntil(write);
    else await write;
  }

  return outcome;
}

async function passThrough(
  ctx: RequestContext,
  rpcReq: JsonRpcRequest,
  allowStreaming: boolean
): Promise<RpcOutcome> {
  try {
    const reply = await callUpstream(ctx, rpcReq.method, rpcReq.params, {
      allowStreaming,
      upstreamId: ctx.requestId,
    });

    if (reply.kind === "stream") {
      return {
        kind: "stream",
        response: observeStream(reply.response, upstreamEchoHeaders(ctx), () => {}),
      };
    }

    if (isNotification(rpcReq)) return { kind: "none" };

    const { envelope } = reply;
    if (envelope.error) {
      return {
        kind: "error",
        code: envelope.error.code,
        message: envelope.error.message,
        ...(envelope.error.data !== undefined ? { data: envelope.error.data } : {}),
      };
    }
    return { kind: "result", result: envelope.result };
  } catch (err) {
    if (isNotification(rpcReq)) {
      console.warn(`passThrough: notification ${rpcReq.method} failed:`, err);
      return { kind: "none" };
    }
    return upstreamErrorOutcome(err);
  }
}

interface RecordParams {
  toolName: string;
  args: unknown;
  resultSummary: string;
  durationMs: number;
  cacheHit: boolean;
  success: boolean;
  tenantPrefix: string;
  error?: string;
  streamed?: boolean;
}

/**
 * Writes both the session's rolling tool-call record and the R2-bound log line.
 * Neither is worth failing an otherwise successful tool call over, so failures
 * are logged and swallowed.
 */
async function record(
  ctx: RequestContext,
  session: SessionDoStub,
  p: RecordParams
): Promise<void> {
  const toolCall: ToolCallRecord = {
    toolName: p.toolName,
    argsSummary: summariseArgs(p.args),
    resultSummary: p.resultSummary,
    timestamp: Date.now(),
    durationMs: p.durationMs,
    cacheHit: p.cacheHit,
    success: p.success,
    ...(p.streamed ? { streamed: true } : {}),
  };

  const entry = buildLogEntry({
    tenant: p.tenantPrefix,
    projectId: ctx.projectId,
    toolName: p.toolName,
    latencyMs: p.durationMs,
    cacheHit: p.cacheHit,
    success: p.success,
    ...(p.error ? { error: p.error } : {}),
    ...(p.streamed ? { streamed: true } : {}),
    requestId: ctx.requestId,
  });

  await Promise.all([
    postToSession(session, "/tool-call", { record: toolCall }),
    postToSession(session, "/log", { entry }),
  ]);
}

async function postToSession(
  session: SessionDoStub,
  path: string,
  body: unknown
): Promise<void> {
  try {
    const res = await session.fetch(`https://session${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn(`SessionDO ${path} returned ${res.status}`);
    }
  } catch (err) {
    console.warn(`SessionDO ${path} failed:`, err);
  }
}

export function summariseArgs(args: unknown): string {
  if (args === null || typeof args !== "object") {
    return truncate(JSON.stringify(args) ?? String(args), 80);
  }
  if (Array.isArray(args)) return truncate(JSON.stringify(args), 120);

  const parts = Object.entries(args as Record<string, unknown>)
    .slice(0, 5)
    .map(([k, v]) => `${k}: ${truncate(JSON.stringify(v) ?? String(v), 40)}`);
  const extra = Object.keys(args as Record<string, unknown>).length - parts.length;
  return parts.join(", ") + (extra > 0 ? `, …(+${extra} more)` : "");
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
