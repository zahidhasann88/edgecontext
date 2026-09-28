/// <reference types="@cloudflare/vitest-pool-workers/types" />

// `env` from "cloudflare:test" is typed as Cloudflare.Env. Declare it here from
// the Worker's own Env interface so src/types.ts stays the single source of
// truth and no code generation step is needed to typecheck the repo.
import type { Env as WorkerEnv } from "../src/types";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      /** Test-only: call counters written by test/upstream-mock.js. */
      UPSTREAM_STATE: KVNamespace;
    }
  }
}
