// The request body is read exactly once, here, and the parsed JSON-RPC requests
// are carried on the context: middleware needs the request id to build error
// responses, and a Request body can only be consumed once.

import {
  handleProxyRequest,
  handleSessionDelete,
  handleStreamOpen,
} from "./mcp/proxy";
import { authMiddleware } from "./middleware/auth";
import { rateLimitMiddleware } from "./middleware/rateLimit";
import { jsonRpcError } from "./mcp/jsonrpc";
import { acceptsEventStream } from "./mcp/sse";
import {
  errorIdFor,
  JSONRPC_ERR_INVALID_REQUEST,
  JSONRPC_ERR_PARSE,
  MCP_ERR_FORBIDDEN_SERVER,
  MCP_ERR_UNKNOWN_SERVER,
  type CacheableTools,
  type Env,
  type JsonRpcRequest,
  type Middleware,
  type RequestContext,
  type UpstreamServerMap,
} from "./types";

export { SessionDO } from "./durable-objects/session";
export { RateLimiterDO } from "./durable-objects/rateLimiter";

/**
 * A batch already costs one rate-limit slot per sub-request, so the limit caps
 * the work a tenant can buy. This bounds the size of any single request the
 * Worker has to hold in memory and walk.
 */
const MAX_BATCH_SIZE = 100;

export function parseUpstreamServers(
  raw: string | undefined,
): UpstreamServerMap {
  if (!raw?.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("UPSTREAM_MCP_SERVERS must be a JSON object");
    }
    const out: UpstreamServerMap = {};
    for (const [name, url] of Object.entries(parsed)) {
      if (typeof url === "string" && url.trim()) out[name] = url.trim();
    }
    return out;
  } catch (err) {
    console.error("Invalid UPSTREAM_MCP_SERVERS, treating as empty:", err);
    return {};
  }
}

export function parseCacheableTools(
  raw: string | undefined,
  defaultTtlSeconds: number,
): CacheableTools {
  const tools: CacheableTools = new Map();
  if (!raw?.trim()) return tools;

  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const colon = entry.lastIndexOf(":");
    if (colon > 0) {
      const ttl = Number.parseInt(entry.slice(colon + 1), 10);
      if (Number.isFinite(ttl) && ttl > 0) {
        tools.set(entry.slice(0, colon).trim(), ttl);
        continue;
      }
    }
    tools.set(entry, defaultTtlSeconds);
  }
  return tools;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

type ParsedBody =
  | { ok: true; rpcReqs: JsonRpcRequest[]; isBatch: boolean }
  | { ok: false; response: Response };

function parseRpcBody(raw: unknown): ParsedBody {
  const fail = (
    code: number,
    message: string,
    id: string | number | null = null,
  ) => ({
    ok: false as const,
    response: jsonRpcError(code, message, id),
  });

  const validate = (value: unknown): JsonRpcRequest | string => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return "each JSON-RPC request must be an object";
    }
    const req = value as JsonRpcRequest;
    if (req.jsonrpc !== "2.0") return 'field "jsonrpc" must be "2.0"';
    if (typeof req.method !== "string" || !req.method)
      return 'missing "method" field';
    return req;
  };

  if (Array.isArray(raw)) {
    if (raw.length === 0) {
      return fail(
        JSONRPC_ERR_INVALID_REQUEST,
        "A batch must contain at least one request.",
      );
    }
    if (raw.length > MAX_BATCH_SIZE) {
      return fail(
        JSONRPC_ERR_INVALID_REQUEST,
        `A batch may contain at most ${MAX_BATCH_SIZE} requests (got ${raw.length}).`,
      );
    }

    const rpcReqs: JsonRpcRequest[] = [];
    for (const [index, entry] of raw.entries()) {
      const checked = validate(entry);
      if (typeof checked === "string") {
        return fail(
          JSONRPC_ERR_INVALID_REQUEST,
          `Invalid request at batch index ${index}: ${checked}.`,
        );
      }
      rpcReqs.push(checked);
    }
    return { ok: true, rpcReqs, isBatch: true };
  }

  const checked = validate(raw);
  if (typeof checked === "string") {
    const id =
      typeof raw === "object" && raw !== null
        ? ((raw as JsonRpcRequest).id ?? null)
        : null;
    return fail(
      JSONRPC_ERR_INVALID_REQUEST,
      checked.charAt(0).toUpperCase() + checked.slice(1) + ".",
      id,
    );
  }
  return { ok: true, rpcReqs: [checked], isBatch: false };
}

async function runChain(
  request: Request,
  ctx: RequestContext,
  middleware: Middleware[],
  final: (request: Request, ctx: RequestContext) => Promise<Response>,
): Promise<Response> {
  let next = () => final(request, ctx);
  for (const mw of [...middleware].reverse()) {
    const downstream = next;
    next = () => mw(request, ctx, downstream);
  }
  return next();
}

async function handleMcp(
  request: Request,
  env: Env,
  url: URL,
  execCtx: ExecutionContext,
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== "POST" && method !== "GET" && method !== "DELETE") {
    return jsonRpcError(
      JSONRPC_ERR_INVALID_REQUEST,
      "MCP endpoints accept POST (JSON-RPC), GET (event stream) and DELETE (end session).",
      null,
      { status: 405, headers: { Allow: "POST, GET, DELETE" } },
    );
  }

  let rpcReqs: JsonRpcRequest[] = [];
  let isBatch = false;

  if (method === "POST") {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return jsonRpcError(
        JSONRPC_ERR_PARSE,
        "Request body is not valid JSON.",
        null,
      );
    }

    const parsed = parseRpcBody(raw);
    if (!parsed.ok) return parsed.response;
    rpcReqs = parsed.rpcReqs;
    isBatch = parsed.isBatch;
  }

  const upstreamServers = parseUpstreamServers(env.UPSTREAM_MCP_SERVERS);
  const segments = url.pathname.split("/").filter(Boolean); // ["mcp", "<name>"]
  const serverName = segments[1] ?? "default";
  const upstreamUrl = upstreamServers[serverName];

  const singleId =
    !isBatch && rpcReqs.length === 1 ? (rpcReqs[0].id ?? null) : null;

  if (!upstreamUrl) {
    const known = Object.keys(upstreamServers);
    return jsonRpcError(
      MCP_ERR_UNKNOWN_SERVER,
      `Unknown upstream server "${serverName}".`,
      singleId,
      {
        data: {
          configured: known,
          hint: known.length
            ? `Use one of: ${known.join(", ")}`
            : "No upstreams are configured. Set UPSTREAM_MCP_SERVERS in wrangler.toml.",
        },
      },
    );
  }

  const cacheTtlSeconds = parsePositiveInt(env.CACHE_TTL_SECONDS, 300);
  const projectId = request.headers.get("X-EdgeContext-Project")?.trim();

  const ctx: RequestContext = {
    env,
    waitUntil: (promise) => execCtx.waitUntil(promise),
    requestId: crypto.randomUUID(),
    rpcReqs,
    isBatch,
    acceptsEventStream: acceptsEventStream(request.headers.get("Accept")),
    clientHeaders: request.headers,
    serverName,
    upstreamUrl,
    projectId: projectId || "default",
    upstreamServers,
    cacheableTools: parseCacheableTools(env.CACHEABLE_TOOLS, cacheTtlSeconds),
    defaultRateLimit: parsePositiveInt(env.DEFAULT_RATE_LIMIT, 60),
    cacheTtlSeconds,
  };

  return runChain(
    request,
    ctx,
    [authMiddleware, rateLimitMiddleware],
    async (req, c) => {
      const allowed = c.tenantConfig?.allowedServers ?? [];
      if (!allowed.includes(c.serverName)) {
        return jsonRpcError(
          MCP_ERR_FORBIDDEN_SERVER,
          `Tenant is not authorised for upstream server "${c.serverName}".`,
          errorIdFor(c),
          { data: { allowedServers: allowed } },
        );
      }

      const verb = req.method.toUpperCase();
      if (verb === "GET") return handleStreamOpen(c);
      if (verb === "DELETE") return handleSessionDelete(c);
      return handleProxyRequest(c);
    },
  );
}

export default {
  async fetch(
    request: Request,
    env: Env,
    execCtx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      return handleMcp(request, env, url, execCtx);
    }

    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({ status: "ok", timestamp: Date.now() }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    return serveIndex();
  },
} satisfies ExportedHandler<Env>;

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>EdgeContext</title>
  <style>
    :root { --bg: #0f172a; --fg: #e2e8f0; --accent: #38bdf8; --muted: #64748b; }
    body { background: var(--bg); color: var(--fg); font-family: system-ui, sans-serif; margin: 0; padding: 2rem; }
    main { max-width: 46rem; margin: 0 auto; }
    h1 { color: var(--accent); margin-bottom: 0.25rem; }
    .sub { color: var(--muted); margin-top: 0; margin-bottom: 2rem; }
    code { background: #1e293b; padding: 0.15rem 0.4rem; border-radius: 4px; font-size: 0.9em; }
    pre { background: #1e293b; padding: 1rem; border-radius: 8px; overflow-x: auto; }
    pre code { background: none; padding: 0; }
    a { color: var(--accent); }
  </style>
</head>
<body>
  <main>
    <h1>EdgeContext</h1>
    <p class="sub">MCP context relay on Cloudflare Workers</p>
    <p>EdgeContext sits between MCP clients (Claude Code, Claude Desktop, &hellip;) and upstream MCP servers, adding:</p>
    <ul>
      <li>Persistent cross-session memory via <code>Durable Objects</code></li>
      <li>Multi-tenant routing with API-key auth and per-tenant rate limits</li>
      <li>Edge caching of expensive tool calls via <code>Workers KV</code></li>
      <li>JSON-line logging to <code>R2</code> for offline analysis</li>
    </ul>
    <h2>Endpoints</h2>
    <pre><code>POST   /mcp/&lt;serverName&gt;   JSON-RPC (single or batched); may stream SSE
GET    /mcp/&lt;serverName&gt;   open the server&rarr;client event stream
DELETE /mcp/&lt;serverName&gt;   end the upstream session
GET    /health             liveness probe</code></pre>
    <p>See <code>README.md</code> for setup instructions.</p>
  </main>
</body>
</html>`;

function serveIndex(): Response {
  return new Response(INDEX_HTML, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
