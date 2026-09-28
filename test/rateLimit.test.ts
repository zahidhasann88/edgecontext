// Rate limiting — the sliding window in RateLimiterDO, and its enforcement
// through the Worker.
//
// The window is driven by real time inside workerd, so these tests use small
// limits and short windows rather than waiting a minute for one to roll over.

import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createTenant, mcpRequest, rpcBody, upstreamMethodCalls } from "./helpers";
import { MCP_ERR_RATE_LIMIT } from "../src/types";
import type { RateLimitCheck } from "../src/durable-objects/rateLimiter";

/** Ask a tenant's rate limiter directly. */
async function check(
  tenant: string,
  limit: number,
  windowMs = 60_000
): Promise<RateLimitCheck> {
  const stub = env.RATE_LIMITER_DO.get(env.RATE_LIMITER_DO.idFromName(tenant));
  const res = await stub.fetch("https://rate-limiter/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ limit, windowMs }),
  });
  return (await res.json()) as RateLimitCheck;
}

let seq = 0;
const nextTenant = (label: string) => `${label}-${++seq}`;

const call = (opts: Parameters<typeof mcpRequest>[0]) => SELF.fetch(mcpRequest(opts));

describe("RateLimiterDO — sliding window", () => {
  it("admits requests up to the limit, then rejects", async () => {
    const tenant = nextTenant("basic");

    expect(await check(tenant, 3)).toMatchObject({ allowed: true, remaining: 2 });
    expect(await check(tenant, 3)).toMatchObject({ allowed: true, remaining: 1 });
    expect(await check(tenant, 3)).toMatchObject({ allowed: true, remaining: 0 });

    const rejected = await check(tenant, 3);
    expect(rejected.allowed).toBe(false);
    expect(rejected.remaining).toBe(0);
    expect(rejected.retryAfterMs).toBeGreaterThan(0);
  });

  it("counts each tenant separately", async () => {
    const a = nextTenant("tenant-a");
    const b = nextTenant("tenant-b");

    await check(a, 1);
    expect((await check(a, 1)).allowed).toBe(false);

    // b has its own object and its own window.
    expect((await check(b, 1)).allowed).toBe(true);
  });

  it("persists the window across a fresh stub", async () => {
    const tenant = nextTenant("persist");
    await check(tenant, 1);

    // A new stub for the same name is the same object; the count must survive.
    expect((await check(tenant, 1)).allowed).toBe(false);
  });

  it("admits again once entries slide out of the window", async () => {
    const tenant = nextTenant("slide");

    expect((await check(tenant, 1, 50)).allowed).toBe(true);
    expect((await check(tenant, 1, 50)).allowed).toBe(false);

    await scheduler.wait(80);

    // The earlier hit has aged out, so capacity is back.
    expect((await check(tenant, 1, 50)).allowed).toBe(true);
  });

  it("is a sliding window, not a fixed bucket", async () => {
    const tenant = nextTenant("sliding");

    // Fill the window, then let only part of it elapse.
    expect((await check(tenant, 2, 400)).allowed).toBe(true);
    await scheduler.wait(200);
    expect((await check(tenant, 2, 400)).allowed).toBe(true);

    // Both hits are still inside a 400 ms window, so this must be refused. A
    // fixed window keyed on wall-clock buckets would wrongly admit it.
    expect((await check(tenant, 2, 400)).allowed).toBe(false);

    // Once the first hit ages out, exactly one slot frees up.
    await scheduler.wait(250);
    expect((await check(tenant, 2, 400)).allowed).toBe(true);
    expect((await check(tenant, 2, 400)).allowed).toBe(false);
  });

  it("reports a retryAfterMs no larger than the window", async () => {
    const tenant = nextTenant("retry-after");
    await check(tenant, 1, 1_000);

    const rejected = await check(tenant, 1, 1_000);
    expect(rejected.retryAfterMs).toBeGreaterThan(0);
    expect(rejected.retryAfterMs).toBeLessThanOrEqual(1_000);
  });

  it("falls back to defaults on a malformed body rather than disabling limiting", async () => {
    const stub = env.RATE_LIMITER_DO.get(env.RATE_LIMITER_DO.idFromName(nextTenant("bad")));
    const res = await stub.fetch("https://rate-limiter/check", {
      method: "POST",
      body: "not json",
    });
    const body = (await res.json()) as RateLimitCheck;
    expect(body.allowed).toBe(true);
    expect(body.limit).toBe(60);
  });

  it("rejects an unknown endpoint", async () => {
    const stub = env.RATE_LIMITER_DO.get(env.RATE_LIMITER_DO.idFromName(nextTenant("path")));
    const res = await stub.fetch("https://rate-limiter/nope", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("rate limiting through the Worker", () => {
  it("returns a JSON-RPC error once the tenant's limit is exceeded", async () => {
    const key = "ratelimited-key";
    await createTenant(key, { allowedServers: ["default"], rateLimitRpm: 2 });

    const request = () =>
      call({
        method: "tools/call",
        params: { name: "uncached_tool", arguments: { n: 1 } },
        apiKey: key,
        projectId: "rl-project",
      });

    const first = await request();
    expect((await rpcBody(first)).error).toBeUndefined();
    expect(first.headers.get("X-EdgeContext-RateLimit-Limit")).toBe("2");
    expect(first.headers.get("X-EdgeContext-RateLimit-Remaining")).toBe("1");

    const second = await request();
    expect((await rpcBody(second)).error).toBeUndefined();
    expect(second.headers.get("X-EdgeContext-RateLimit-Remaining")).toBe("0");

    const third = await request();
    expect(third.status).toBe(429);

    const body = await rpcBody(third);
    expect(body.error?.code).toBe(MCP_ERR_RATE_LIMIT);
    expect(body.error?.message).toMatch(/Rate limit exceeded \(2 requests\/minute\)/);
    expect(body.error?.data).toMatchObject({ limit: 2 });
    expect(third.headers.get("Retry-After")).toBeTruthy();
  });

  it("rejects before reaching the upstream, so a throttled call costs nothing", async () => {
    const key = "no-upstream-key";
    await createTenant(key, { allowedServers: ["default"], rateLimitRpm: 1 });

    const request = () =>
      call({ method: "resources/list", apiKey: key, projectId: "rl-cheap" });

    await request();
    const before = await upstreamMethodCalls("resources/list");

    const rejected = await request();
    expect(rejected.status).toBe(429);
    // The decisive assertion: the upstream was never contacted.
    expect(await upstreamMethodCalls("resources/list")).toBe(before);
  });

  it("echoes the request id in the rate-limit error", async () => {
    const key = "ratelimited-id-key";
    await createTenant(key, { allowedServers: ["default"], rateLimitRpm: 1 });

    await call({ method: "resources/list", apiKey: key, projectId: "rl-id", id: 1 });

    const res = await call({
      method: "resources/list",
      apiKey: key,
      projectId: "rl-id",
      id: "second-call",
    });
    expect(res.status).toBe(429);
    expect((await rpcBody(res)).id).toBe("second-call");
  });

  it("applies DEFAULT_RATE_LIMIT when the tenant has no override", async () => {
    const key = "default-limit-key";
    await createTenant(key, { allowedServers: ["default"] });

    const res = await call({
      method: "resources/list",
      apiKey: key,
      projectId: "rl-default",
    });

    // DEFAULT_RATE_LIMIT is 60 in the test bindings.
    expect(res.headers.get("X-EdgeContext-RateLimit-Limit")).toBe("60");
  });

  it("counts limits per tenant, not globally", async () => {
    const capped = "capped-key";
    const roomy = "roomy-key";
    await createTenant(capped, { allowedServers: ["default"], rateLimitRpm: 1 });
    await createTenant(roomy, { allowedServers: ["default"], rateLimitRpm: 50 });

    await call({ method: "resources/list", apiKey: capped, projectId: "rl-multi" });
    const cappedSecond = await call({
      method: "resources/list",
      apiKey: capped,
      projectId: "rl-multi",
    });
    expect(cappedSecond.status).toBe(429);

    // The other tenant is unaffected.
    const roomyRes = await call({
      method: "resources/list",
      apiKey: roomy,
      projectId: "rl-multi",
    });
    expect(roomyRes.status).toBe(200);
  });

  it("does not consume quota for a request that fails auth", async () => {
    const key = "quota-after-auth-key";
    await createTenant(key, { allowedServers: ["default"], rateLimitRpm: 1 });

    // An unauthenticated request is rejected before the limiter runs, so the
    // tenant's single slot must still be available.
    await call({ method: "resources/list", apiKey: "bogus", projectId: "rl-auth" });

    const allowed = await call({
      method: "resources/list",
      apiKey: key,
      projectId: "rl-auth",
    });
    expect(allowed.status).toBe(200);
  });
});
