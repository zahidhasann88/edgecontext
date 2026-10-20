# EdgeContext

EdgeContext is a small proxy for **MCP servers** that runs on **Cloudflare Workers**.

You put it between your AI client (like Claude Desktop) and your MCP servers. It forwards every request, and also gives you:

- **Memory per project.** Notes and recent activity are saved and survive restarts.
- **API keys.** Each team gets its own key and can only reach the servers it's allowed to use.
- **Rate limiting.** Each team gets a requests-per-minute limit.
- **Caching.** Results of slow tools can be reused (only for tools you choose).
- **Logs.** Tool calls are saved to Cloudflare R2.

It runs only on Cloudflare services, so you don't need your own server or database.

## How it works

```text
AI client  ──►  EdgeContext (Cloudflare Worker)  ──►  Your MCP server(s)
                  checks key, rate limit, cache
                  saves project memory and logs
```

Requests EdgeContext doesn't recognize are passed through unchanged, so your existing MCP setup keeps working.

## Built-in tools

EdgeContext adds three tools of its own:

| Tool | What it does |
| --- | --- |
| `edgecontext_remember` | Save a note for this project |
| `edgecontext_recall` | Show recent activity and saved notes |
| `edgecontext_get_session_summary` | Get a Markdown summary of the project |

## Run it locally

You'll need Node.js 20+ and pnpm.

**1. Install**

```bash
pnpm install
```

**2. Configure.** Copy `.dev.vars.example` to `.dev.vars` and set your MCP server URL:

```ini
UPSTREAM_MCP_SERVERS={"default":"http://127.0.0.1:8902/mcp"}
```

**3. Create a test API key.** Only the key's hash is stored:

```bash
# Hash the key "demo-key-123"
node -e "console.log(require('crypto').createHash('sha256').update('demo-key-123').digest('hex'))"

# Save it (replace <hash> with the output above)
pnpm exec wrangler kv key put --local --preview --binding TENANTS \
  "tenant:<hash>" '{"name":"demo","allowedServers":["default"],"rateLimitRpm":60}'
```

**4. Start it**

```bash
pnpm dev
```

**5. Try it**

```bash
curl -X POST http://127.0.0.1:8787/mcp/default \
  -H 'Authorization: Bearer demo-key-123' \
  -H 'X-EdgeContext-Project: my-project' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

## Deploy to Cloudflare

**1. Create storage**

```bash
pnpm exec wrangler kv namespace create TENANTS
pnpm exec wrangler kv namespace create TENANTS --preview
pnpm exec wrangler kv namespace create CACHE
pnpm exec wrangler kv namespace create CACHE --preview
pnpm exec wrangler r2 bucket create edgecontext-logs
pnpm exec wrangler r2 bucket create edgecontext-logs-preview
```

**2. Paste the IDs.** Each `kv namespace create` command prints an ID. Paste them into `wrangler.toml`, replacing the placeholder `id` and `preview_id` values.

**3. Set your MCP servers and deploy**

```bash
pnpm exec wrangler secret put UPSTREAM_MCP_SERVERS
pnpm exec wrangler deploy
```

Add a real API key the same way as in step 3, using `--remote` instead of `--local --preview`.

## Connect your AI client

Point your client to `https://<your-worker>/mcp/<serverName>` and send two headers:

- `Authorization: Bearer <your-api-key>`
- `X-EdgeContext-Project: <project-name>`, which picks the project's memory

For an example, see [`examples/claude-desktop-config.json`](examples/claude-desktop-config.json).

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `UPSTREAM_MCP_SERVERS` | `{}` | Your MCP servers, as `{"name": "url"}` |
| `DEFAULT_RATE_LIMIT` | `60` | Requests per minute if a team has no limit set |
| `CACHE_TTL_SECONDS` | `300` | How long cached results last |
| `CACHEABLE_TOOLS` | empty | Tools to cache, e.g. `search_codebase:600,fetch_docs` |

## Design choices

- **Rate limiting uses Durable Objects, not KV.** KV can't count requests safely when many arrive at once, so it would let too many through.
- **API keys are stored only as SHA-256 hashes.** The real key can't be recovered from storage.
- **Each project has its own Durable Object.** Projects can't read each other's memory.
- **Batches can't bypass the rate limit.** Every request inside a batch uses one slot.
- **Errors are never cached.** If the cache fails, the request goes to the MCP server as normal.

## Tests

```bash
pnpm test
pnpm typecheck
```

The 147 tests run inside the real Cloudflare Workers runtime, with real KV, Durable Objects and R2. Only the upstream MCP server is mocked.

## Known limitations

- There's no dashboard for logs. They are only stored in R2.
- Requests in a batch run one at a time. This keeps them in order but is slower.
- Cached results of streamed calls come back as plain JSON, not as a stream.

## License

MIT. See [LICENSE](LICENSE).
