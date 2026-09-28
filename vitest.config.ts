import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// Tests run inside workerd — the same runtime the Worker deploys to — with real
// KV namespaces, real Durable Objects and a real R2 bucket supplied by Miniflare.
// Bindings come from wrangler.toml, so the test environment cannot drift from the
// deployed one.
//
// The upstream MCP server is the only stub. It is a real Worker (see
// test/upstream-mock.js) installed as `outboundService`, which intercepts every
// outbound fetch: tests never touch the network, and any unintended upstream call
// is visible as a counter increment.
// Relative to the project root, which is vitest's working directory. A plain
// string avoids pulling Node's URL type into a Workers-typed project.
const upstreamMock = readFileSync("./test/upstream-mock.js", "utf8");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        // Test-only vars. These take precedence over both wrangler.toml [vars]
        // and any local .dev.vars, so the suite is hermetic: a contributor's
        // local dev config cannot change test results.
        bindings: {
          UPSTREAM_MCP_SERVERS: JSON.stringify({
            default: "https://upstream.test/mcp",
            alt: "https://alt-upstream.test/mcp",
            // An unsupported scheme makes fetch() reject outright, which is how the
            // suite exercises an unreachable upstream.
            broken: "ftp://upstream.invalid/mcp",
            notstream: "https://upstream.test/notstream",
            http500: "https://upstream.test/http500",
          }),
          CACHEABLE_TOOLS: "search_codebase:600,fetch_docs,stream_cached",
          DEFAULT_RATE_LIMIT: "60",
          CACHE_TTL_SECONDS: "300",
        },
        // Shared with the mock upstream so tests can read its call counters.
        kvNamespaces: ["UPSTREAM_STATE"],
        outboundService: "upstream-mock",
        workers: [
          {
            name: "upstream-mock",
            modules: [{ type: "ESModule", path: "index.mjs", contents: upstreamMock }],
            compatibilityDate: "2026-08-01",
            kvNamespaces: ["UPSTREAM_STATE"],
          },
        ],
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
