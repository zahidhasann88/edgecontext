// One instance per tenant, keeping the timestamps of recent requests and
// admitting a request only if the window has room.
//
// A Durable Object rather than KV because KV has no atomic increment — two
// concurrent requests both read the same count and both write count+1, so the
// limit leaks under exactly the load it exists to control — and KV reads are
// eventually consistent, so a counter can read stale for up to a minute. A
// Durable Object serialises a tenant's requests on one thread, which is what a
// counter needs.

const DEFAULT_WINDOW_MS = 60_000;
const HITS_KEY = "hits";

export interface RateLimitCheck {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterMs: number;
  cost: number;
  unsatisfiable?: boolean;
}

export class RateLimiterDO implements DurableObject {
  private readonly state: DurableObjectState;

  private hits: number[] = [];

  constructor(state: DurableObjectState) {
    this.state = state;
    this.state.blockConcurrencyWhile(async () => {
      this.hits = (await this.state.storage.get<number[]>(HITS_KEY)) ?? [];
    });
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname !== "/check") {
      return this.json({ error: `Unknown RateLimiterDO endpoint: ${pathname}` }, 404);
    }

    let limit = 60;
    let windowMs = DEFAULT_WINDOW_MS;
    let cost = 1;
    try {
      const body = (await request.json()) as {
        limit?: number;
        windowMs?: number;
        cost?: number;
      };
      if (typeof body.limit === "number" && body.limit > 0) limit = Math.floor(body.limit);
      if (typeof body.windowMs === "number" && body.windowMs > 0) {
        windowMs = Math.floor(body.windowMs);
      }
      if (typeof body.cost === "number" && body.cost >= 1) cost = Math.floor(body.cost);
    } catch {
      // Defaults stand: a malformed body must not disable limiting.
    }

    return this.json(await this.check(limit, windowMs, cost));
  }

  private async check(
    limit: number,
    windowMs: number,
    cost: number
  ): Promise<RateLimitCheck> {
    const now = Date.now();
    const cutoff = now - windowMs;

    this.hits = this.hits.filter((ts) => ts > cutoff);

    if (cost > limit) {
      await this.state.storage.put(HITS_KEY, this.hits);
      return {
        allowed: false,
        limit,
        remaining: Math.max(0, limit - this.hits.length),
        retryAfterMs: 0,
        cost,
        unsatisfiable: true,
      };
    }

    if (this.hits.length + cost > limit) {
      const needed = this.hits.length + cost - limit;
      const oldest = this.hits[needed - 1] ?? this.hits[0];
      const retryAfterMs = Math.max(1, oldest + windowMs - now);
      await this.state.storage.put(HITS_KEY, this.hits);
      return {
        allowed: false,
        limit,
        remaining: Math.max(0, limit - this.hits.length),
        retryAfterMs,
        cost,
      };
    }

    for (let i = 0; i < cost; i++) this.hits.push(now);
    await this.state.storage.put(HITS_KEY, this.hits);

    return {
      allowed: true,
      limit,
      remaining: Math.max(0, limit - this.hits.length),
      retryAfterMs: 0,
      cost,
    };
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}
