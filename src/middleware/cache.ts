// Caching applies only to tools named in CACHEABLE_TOOLS. Keys are
// `cache:<tenantHash>:<toolName>:<sha256(stableStringify(args))>`, so entries
// never cross tenants and re-ordered argument keys still hit.

import type { RequestContext } from "../types";

const KV_MIN_EXPIRATION_TTL = 60;

export interface CachedEntry {
  result: unknown;
  timestamp: number;
  ttlSeconds: number;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Serialise with object keys sorted, so two argument objects differing only in
 * key order produce the same cache key. Array order is preserved: it is
 * meaningful.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(",")}}`;
}

async function cacheKeyFor(
  tenantHash: string,
  toolName: string,
  args: unknown
): Promise<string> {
  return `cache:${tenantHash}:${toolName}:${await sha256Hex(stableStringify(args))}`;
}

export function ttlForTool(ctx: RequestContext, toolName: string): number | undefined {
  return ctx.cacheableTools.get(toolName);
}

export function isCacheable(ctx: RequestContext, toolName: string): boolean {
  return ctx.cacheableTools.has(toolName) && Boolean(ctx.hashedKey);
}

export async function checkCache(
  ctx: RequestContext,
  toolName: string,
  args: unknown
): Promise<{ hit: true; result: unknown } | { hit: false }> {
  if (!isCacheable(ctx, toolName)) return { hit: false };

  try {
    const key = await cacheKeyFor(ctx.hashedKey!, toolName, args);
    const raw = await ctx.env.CACHE.get(key);
    if (!raw) return { hit: false };

    const entry = JSON.parse(raw) as CachedEntry;
    if (Date.now() - entry.timestamp > entry.ttlSeconds * 1000) {
      await ctx.env.CACHE.delete(key);
      return { hit: false };
    }
    return { hit: true, result: entry.result };
  } catch (err) {
    console.error(`cache: read failed for ${toolName}, treating as miss:`, err);
    return { hit: false };
  }
}

export async function storeCache(
  ctx: RequestContext,
  toolName: string,
  args: unknown,
  result: unknown
): Promise<void> {
  const ttlSeconds = ttlForTool(ctx, toolName);
  if (ttlSeconds === undefined || !ctx.hashedKey) return;

  try {
    const key = await cacheKeyFor(ctx.hashedKey, toolName, args);
    const entry: CachedEntry = { result, timestamp: Date.now(), ttlSeconds };
    await ctx.env.CACHE.put(key, JSON.stringify(entry), {
      expirationTtl: Math.max(ttlSeconds, KV_MIN_EXPIRATION_TTL),
    });
  } catch (err) {
    console.error(`cache: write failed for ${toolName}:`, err);
  }
}
