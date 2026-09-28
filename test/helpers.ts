// Shared test helpers.
//
// These tests run inside workerd via @cloudflare/vitest-pool-workers, so `env`
// carries real KV namespaces, real Durable Objects and a real R2 bucket. Nothing
// mocks the platform. The upstream MCP server is a real Worker installed as
// Miniflare's outboundService — see test/upstream-mock.js.

import { env } from "cloudflare:test";
import { expect } from "vitest";
import { sha256Hex } from "../src/middleware/auth";
import type { TenantConfig } from "../src/types";

/** Register a tenant in the real TENANTS KV namespace. Returns the raw key. */
export async function createTenant(
  rawKey: string,
  config: Partial<TenantConfig> = {}
): Promise<string> {
  const tenant: TenantConfig = {
    name: config.name ?? "test-tenant",
    allowedServers: config.allowedServers ?? ["default"],
    ...(config.rateLimitRpm !== undefined ? { rateLimitRpm: config.rateLimitRpm } : {}),
  };
  await env.TENANTS.put(`tenant:${await sha256Hex(rawKey)}`, JSON.stringify(tenant));
  return rawKey;
}

export interface McpRequestOptions {
  method: string;
  params?: Record<string, unknown>;
  /** `null` omits the Authorization header entirely. */
  apiKey?: string | null;
  projectId?: string;
  serverName?: string;
  id?: string | number | null;
}

export function mcpRequest(opts: McpRequestOptions): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.apiKey !== null && opts.apiKey !== undefined) {
    headers.Authorization = `Bearer ${opts.apiKey}`;
  }
  if (opts.projectId) headers["X-EdgeContext-Project"] = opts.projectId;

  return new Request(`https://edgecontext.test/mcp/${opts.serverName ?? "default"}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: opts.method,
      ...(opts.params ? { params: opts.params } : {}),
      id: opts.id ?? 1,
    }),
  });
}

export interface RpcBody {
  jsonrpc: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  id: string | number | null;
}

export async function rpcBody(res: Response): Promise<RpcBody> {
  return (await res.json()) as RpcBody;
}

/** Extract the text of the first MCP content block from a tool result. */
export function contentText(result: unknown): string {
  const blocks = (result as { content?: { text?: string }[] } | null)?.content;
  expect(Array.isArray(blocks)).toBe(true);
  return blocks![0].text!;
}

async function counter(key: string): Promise<number> {
  return Number((await env.UPSTREAM_STATE.get(key)) ?? "0");
}

/** How many times the upstream was asked to run a given tool. */
export function upstreamToolCalls(toolName: string): Promise<number> {
  return counter(`calls:tool:${toolName}`);
}

/** How many times the upstream received a given JSON-RPC method. */
export function upstreamMethodCalls(method: string): Promise<number> {
  return counter(`calls:method:${method}`);
}

export function upstreamTotalCalls(): Promise<number> {
  return counter("calls:total");
}

export function sessionStubFor(projectId: string) {
  return env.SESSION_DO.get(env.SESSION_DO.idFromName(projectId));
}

export async function sessionPost(
  projectId: string,
  path: string,
  body: unknown
): Promise<Response> {
  return sessionStubFor(projectId).fetch(`https://session${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-EdgeContext-Project": projectId,
    },
    body: JSON.stringify(body),
  });
}
