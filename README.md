# EdgeContext

A Cloudflare Workers MCP context relay. It sits between MCP clients and upstream MCP servers as a transparent Streamable HTTP proxy, and adds persistent project-scoped context, multi-tenant isolation, per-tenant rate limiting, edge caching, and durable request logging at the edge.

Entirely Cloudflare-native — Workers, Durable Objects, KV, and R2. No Node server, no external database.

## Architecture

```text
MCP Client
   │  JSON-RPC / SSE + Bearer API key
   ▼
┌──────────────────────────────────────────────┐
│              EdgeContext Worker              │
│                                              │
│  Auth ──────► KV (tenant config)             │
│  Rate limit ► RateLimiterDO (per tenant)     │
│  Routing ───► tenant upstream allow-list     │
│                                              │
│  ┌────────── MCP dispatch ────────────────┐  │
│  │ edgecontext_*   ──► SessionDO          │  │
│  │ cacheable tool  ──► KV cache           │  │
│  │ everything else ──► upstream MCP       │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  SessionDO ──► project context + log buffer  │
│  Alarm ──────► R2 (JSONL logs)               │
└──────────────────────┬───────────────────────┘
                       ▼
                Upstream MCP servers
```

Unrecognized methods and tools pass through untouched, so any MCP client and server pair keeps working; the edge features are additive.

## Core Design

### Context & project isolation

One `SessionDO` per project ID, addressed by name, so state survives Worker restarts and client reconnects. Each session holds project notes plus a rolling history of the last 50 tool calls and 30 resource reads.

Projects are isolated at the Durable Object level — separate namespaces, no shared storage — so one project cannot read another's session state. The cache, by contrast, is tenant-scoped, so a tenant reuses cached tool results across its projects.

### Authentication & routing

Clients send two headers:

```http
Authorization: Bearer <api-key>
X-EdgeContext-Project: <project-id>
```

The key is SHA-256 hashed and used to look up `tenant:<hash>` in KV; the raw key is never stored and is unrecoverable after creation. Each tenant record carries its own upstream allow-list and rate limit. A request to `/mcp/:serverName` is rejected before any upstream contact unless that server is both configured and present in the tenant's allow-list.

### Rate limiting

One Durable Object per tenant maintains a sliding window. Durable Objects are used rather than KV because admission control needs a serialized read-increment-check: KV is eventually consistent and offers no atomic increment, so concurrent requests would over-admit.

Each JSON-RPC request consumes one slot, and a batch consumes one slot per sub-request — batching cannot be used to bypass the limit. Throttled requests are rejected at the edge:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 58
X-EdgeContext-RateLimit-Limit: 60
X-EdgeContext-RateLimit-Remaining: 0
```

### Caching

Caching is opt-in per tool through `CACHEABLE_TOOLS`; nothing is cached unless explicitly configured. Keys are tenant-scoped:

```text
cache:<tenantHash>:<toolName>:<sha256(stableStringify(arguments))>
```

`stableStringify` sorts object keys recursively, so semantically equivalent argument objects hash identically while array order stays significant.

Responses carry `X-EdgeContext-Cache: HIT | MISS`. Upstream errors are never cached, and a cache read or write failure degrades to a normal upstream request rather than failing the MCP call.

### Streaming & batching

EdgeContext implements MCP Streamable HTTP: `POST` for JSON-RPC, `GET` for event streams, `DELETE` for session termination, with `Mcp-Session-Id`, `MCP-Protocol-Version`, and `Last-Event-ID` handled across the hop. SSE responses are forwarded as they arrive rather than buffered.

A streamed call can still be cached, but only once its final result is observed — a client-abandoned stream is never cached. A cached result from a previously streamed call is served as final JSON, not as a reconstructed event sequence.

JSON-RPC arrays are accepted up to 100 sub-requests, executed **sequentially** so session history stays ordered, later sub-requests can observe earlier ones, and a single client cannot fan out dozens of concurrent upstream calls. Failures are scoped accordingly: a per-request error stays attached to its request ID, while a transport-level failure rejects the batch with one error and a `null` ID. Notifications produce no response, and a notification-only request returns `202 Accepted`.

### Logging

Tool calls are buffered in the project's `SessionDO` and flushed to R2 by a 60-second alarm:

```text
logs/<YYYY-MM-DD>/<projectId>/<timestamp>-<random>.jsonl
```

Each flush writes a new object instead of appending to a shared daily file, which avoids read-modify-write races between concurrently flushing projects. A failed R2 write is re-buffered for the next flush.

## MCP Context Tools

Three tools are served locally from the `SessionDO` and never reach the upstream:

| Tool | Purpose |
| --- | --- |
| `edgecontext_remember` | Store project notes |
| `edgecontext_recall` | Return recent activity and notes |
| `edgecontext_get_session_summary` | Return the project context as Markdown |

## Quick Start

Requires Node.js 20+ and pnpm 10+.

```bash
pnpm install
pnpm test
pnpm typecheck
```

For local development, copy `.dev.vars.example` to `.dev.vars`:

```ini
UPSTREAM_MCP_SERVERS={"default":"http://127.0.0.1:8902/mcp"}
CACHEABLE_TOOLS=search_codebase:600
DEFAULT_RATE_LIMIT=60
CACHE_TTL_SECONDS=300
```

Seed a tenant with the SHA-256 hash of a test key, then start the Worker:

```bash
node -e "console.log(require('crypto').createHash('sha256').update('demo-key-123').digest('hex'))"

pnpm exec wrangler kv key put --local --preview --binding TENANTS \
  "tenant:<hash>" '{"name":"demo","allowedServers":["default"],"rateLimitRpm":60}'

pnpm dev
```

```bash
curl -X POST http://127.0.0.1:8787/mcp/default \
  -H 'Authorization: Bearer demo-key-123' \
  -H 'X-EdgeContext-Project: my-project' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

## Deployment

```bash
# Storage
pnpm exec wrangler kv namespace create TENANTS
pnpm exec wrangler kv namespace create TENANTS --preview
pnpm exec wrangler kv namespace create CACHE
pnpm exec wrangler kv namespace create CACHE --preview
pnpm exec wrangler r2 bucket create edgecontext-logs
pnpm exec wrangler r2 bucket create edgecontext-logs-preview

# Upstreams, then deploy
pnpm exec wrangler secret put UPSTREAM_MCP_SERVERS
pnpm exec wrangler deploy
```

Durable Object migrations are declared in `wrangler.toml`; no manual Durable Object setup is required.

Provision a tenant by storing only the hash of its key:

```bash
KEY=$(openssl rand -hex 32)
HASH=$(node -e "console.log(require('crypto').createHash('sha256').update('$KEY').digest('hex'))")

pnpm exec wrangler kv key put --remote --binding TENANTS \
  "tenant:$HASH" '{"name":"my-team","allowedServers":["docs"],"rateLimitRpm":120}'

echo "API key: $KEY"
```

Point an MCP client at `https://<worker>/mcp/<serverName>` with the `Authorization` and `X-EdgeContext-Project` headers; the project ID selects the persistent context namespace.

## Configuration

| Binding | Type | Purpose |
| --- | --- | --- |
| `TENANTS` | KV | API-key hashes and tenant configuration |
| `CACHE` | KV | Cached MCP tool results |
| `LOGS` | R2 | Durable request logs |
| `SESSION_DO` | Durable Object | Project context and log buffering |
| `RATE_LIMITER_DO` | Durable Object | Per-tenant rate limiting |

| Variable | Default | Purpose |
| --- | ---: | --- |
| `UPSTREAM_MCP_SERVERS` | `{}` | Named upstream MCP servers |
| `DEFAULT_RATE_LIMIT` | `60` | Requests/minute when a tenant sets none |
| `CACHE_TTL_SECONDS` | `300` | Default cache TTL |
| `CACHEABLE_TOOLS` | `""` | Cacheable tools, with optional per-tool TTL — `search_codebase:600,fetch_docs:120` |

JSON-RPC errors use implementation-specific codes in the `-32000` range, alongside standard HTTP statuses (`401`, `405`, `429`):

| Code | Meaning |
| --- | --- |
| `-32001` | Missing or invalid API key |
| `-32002` | Rate limit exceeded |
| `-32003` | Tenant not authorized for upstream |
| `-32004` | Upstream unavailable |
| `-32005` | Unknown upstream |
| `-32006` | Local EdgeContext tool failure |

## Testing

```bash
pnpm test
pnpm typecheck
pnpm exec wrangler deploy --dry-run
```

147 tests run inside the real Workers runtime via `@cloudflare/vitest-pool-workers`, against real KV namespaces, Durable Objects, and R2 rather than in-memory fakes. Only the upstream MCP server is mocked, through Miniflare's `outboundService`, so no test makes a real network request.

Coverage spans authentication and tenant isolation, upstream routing, cache behavior, Durable Object persistence and project isolation, sliding-window rate limiting under concurrent requests, SSE streaming, GET/DELETE transport handling, JSON-RPC batching, notifications, and R2 log flushing.

## Known Limitations

* **No dashboard:** logs land in R2 with no UI for browsing them.
* **Sequential batches:** batches trade throughput for ordering and upstream fan-out control by design.
* **Whole-batch admission:** a batch exceeding the remaining rate-limit budget is rejected in full rather than partially.
* **Stream cache replay:** cached streamed calls replay as final JSON, not as the original SSE event sequence.

## License

MIT — see [LICENSE](LICENSE).
