// Per-tenant sliding window, delegated to RateLimiterDO. See
// src/durable-objects/rateLimiter.ts for why a Durable Object rather than KV.

import { jsonRpcError } from "../mcp/jsonrpc";
import { errorIdFor, MCP_ERR_RATE_LIMIT, type Middleware } from "../types";
import type { RateLimitCheck } from "../durable-objects/rateLimiter";

const WINDOW_MS = 60_000;

export const rateLimitMiddleware: Middleware = async (_request, ctx, next) => {
  const id = errorIdFor(ctx);

  if (!ctx.hashedKey) {
    console.error("rateLimit: ctx.hashedKey is unset; auth middleware must run first");
    return jsonRpcError(MCP_ERR_RATE_LIMIT, "Rate limiter is misconfigured.", id, {
      status: 500,
    });
  }

  const limit = ctx.tenantConfig?.rateLimitRpm ?? ctx.defaultRateLimit;
  const cost = Math.max(1, ctx.rpcReqs.length);

  let check: RateLimitCheck;
  try {
    const stub = ctx.env.RATE_LIMITER_DO.get(
      ctx.env.RATE_LIMITER_DO.idFromName(ctx.hashedKey)
    );
    const res = await stub.fetch("https://rate-limiter/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit, windowMs: WINDOW_MS, cost }),
    });
    check = (await res.json()) as RateLimitCheck;
  } catch (err) {
    console.error("rateLimit: RateLimiterDO unreachable, allowing request:", err);
    return next();
  }

  if (!check.allowed) {
    const retryAfterSec = Math.ceil(check.retryAfterMs / 1000);
    const message = check.unsatisfiable
      ? `Batch of ${cost} requests exceeds the rate limit of ${check.limit} requests/minute.`
      : `Rate limit exceeded (${check.limit} requests/minute).`;

    return jsonRpcError(MCP_ERR_RATE_LIMIT, message, id, {
      data: {
        limit: check.limit,
        ...(cost > 1 ? { cost } : {}),
        ...(check.unsatisfiable ? {} : { retryAfterSec }),
      },
      status: 429,
      headers: {
        ...(check.unsatisfiable ? {} : { "Retry-After": String(retryAfterSec) }),
        "X-EdgeContext-RateLimit-Limit": String(check.limit),
        "X-EdgeContext-RateLimit-Remaining": String(check.remaining),
      },
    });
  }

  const response = await next();

  const withHeaders = new Response(response.body, response);
  withHeaders.headers.set("X-EdgeContext-RateLimit-Limit", String(check.limit));
  withHeaders.headers.set("X-EdgeContext-RateLimit-Remaining", String(check.remaining));
  return withHeaders;
};
