/** Bindings declared in wrangler.toml. Passed to `fetch` by the runtime. */
export interface Env {
  TENANTS: KVNamespace;
  CACHE: KVNamespace;
  LOGS: R2Bucket;
  SESSION_DO: DurableObjectNamespace;
  RATE_LIMITER_DO: DurableObjectNamespace;

  UPSTREAM_MCP_SERVERS?: string;
  DEFAULT_RATE_LIMIT?: string;
  CACHE_TTL_SECONDS?: string;
  CACHEABLE_TOOLS?: string;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
  /** Absent for notifications, which get no response. */
  id?: string | number | null;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  result: unknown;
  id: string | number | null;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  error: { code: number; message: string; data?: unknown };
  id: string | number | null;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

/**
 * The outcome of dispatching one JSON-RPC request.
 *
 * `stream` is only produced for a single non-batched request whose client
 * accepts text/event-stream. A batch can never stream, because its replies have
 * to be collected into one JSON array.
 */
export type RpcOutcome =
  | { kind: "result"; result: unknown; cache?: CacheStatus }
  | { kind: "error"; code: number; message: string; data?: unknown; cache?: CacheStatus }
  | { kind: "stream"; response: Response }
  | { kind: "none" };

export type CacheStatus = "HIT" | "MISS";

/** Stored in the TENANTS KV namespace under `tenant:<sha256(apiKey)>`. */
export interface TenantConfig {
  name?: string;
  allowedServers: string[];
  rateLimitRpm?: number;
}

export interface ToolCallRecord {
  toolName: string;
  argsSummary: string;
  resultSummary: string;
  timestamp: number;
  durationMs: number;
  cacheHit: boolean;
  success: boolean;
  streamed?: boolean;
}

export interface ResourceReadRecord {
  resourceUri: string;
  timestamp: number;
}

export interface SessionState {
  projectId: string;
  notes: string;
  toolCalls: ToolCallRecord[];
  resourceReads: ResourceReadRecord[];
  maxToolCalls: number;
  maxResourceReads: number;
  updatedAt: number;
}

/** One newline-delimited JSON line flushed to R2. */
export interface LogEntry {
  tenant: string;
  projectId: string;
  toolName: string;
  latencyMs: number;
  cacheHit: boolean;
  success: boolean;
  error?: string;
  streamed?: boolean;
  timestamp: number;
  requestId: string;
}

export type UpstreamServerMap = Record<string, string>;

/** Tool name to cache TTL in seconds. */
export type CacheableTools = Map<string, number>;

export interface RequestContext {
  env: Env;
  waitUntil(promise: Promise<unknown>): void;
  requestId: string;
  rpcReqs: JsonRpcRequest[];
  isBatch: boolean;
  acceptsEventStream: boolean;
  clientHeaders: Headers;
  serverName: string;
  upstreamUrl: string;
  projectId: string;
  upstreamServers: UpstreamServerMap;
  cacheableTools: CacheableTools;
  defaultRateLimit: number;
  cacheTtlSeconds: number;

  tenantConfig?: TenantConfig;
  /** SHA-256 hex of the presented API key. Set by authMiddleware. */
  hashedKey?: string;
}


export function errorIdFor(ctx: RequestContext): string | number | null {
  if (ctx.isBatch || ctx.rpcReqs.length !== 1) return null;
  return ctx.rpcReqs[0].id ?? null;
}
export interface SessionDoStub {
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
}

export type NextFn = () => Promise<Response>;

export type Middleware = (
  request: Request,
  ctx: RequestContext,
  next: NextFn
) => Promise<Response>;

export type NotesMode = "replace" | "append";

export interface RememberParams {
  notes: string;
  mode?: NotesMode;
}

export interface RecallParams {
  includeToolCalls?: boolean;
  includeResources?: boolean;
  maxEntries?: number;
}

export interface SessionSummaryParams extends RecallParams {
  includeNotes?: boolean;
}

export interface RecallResult {
  projectId: string;
  notes: string;
  toolCalls: ToolCallRecord[];
  resourceReads: ResourceReadRecord[];
  totalToolCalls: number;
  totalResourceReads: number;
}

// -32700..-32600 are reserved by JSON-RPC itself; -32000..-32099 is the
// implementation-defined server-error range, where EdgeContext's codes live.

export const JSONRPC_ERR_PARSE = -32700;
export const JSONRPC_ERR_INVALID_REQUEST = -32600;
export const JSONRPC_ERR_METHOD_NOT_FOUND = -32601;
export const JSONRPC_ERR_INVALID_PARAMS = -32602;

export const MCP_ERR_AUTH = -32001;
export const MCP_ERR_RATE_LIMIT = -32002;
export const MCP_ERR_FORBIDDEN_SERVER = -32003;
export const MCP_ERR_UPSTREAM = -32004;
export const MCP_ERR_UNKNOWN_SERVER = -32005;
export const MCP_ERR_TOOL_FAILED = -32006;
