// Tenants live in the TENANTS KV namespace at `tenant:<sha256-hex-of-api-key>`,
// valued with a JSON TenantConfig. Only the hash is ever stored or logged, so a
// dump of the namespace yields no usable API keys.

import { jsonRpcError } from "../mcp/jsonrpc";
import { errorIdFor, MCP_ERR_AUTH, type Middleware, type TenantConfig } from "../types";

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function authError(message: string, id: string | number | null): Response {
  return jsonRpcError(MCP_ERR_AUTH, message, id, {
    data: "Provide a valid API key in the Authorization: Bearer <key> header.",
    status: 401,
    headers: { "WWW-Authenticate": 'Bearer realm="edgecontext"' },
  });
}

export const authMiddleware: Middleware = async (request, ctx, next) => {
  const id = errorIdFor(ctx);
  const authHeader = request.headers.get("Authorization");

  if (!authHeader) {
    return authError("Missing Authorization header.", id);
  }

  if (!/^Bearer(\s|$)/i.test(authHeader)) {
    return authError('Authorization header must use the "Bearer <key>" scheme.', id);
  }

  const rawKey = authHeader.replace(/^Bearer\s*/i, "").trim();
  if (!rawKey) {
    return authError("Empty Bearer token.", id);
  }

  const hashedKey = await sha256Hex(rawKey);

  let stored: string | null;
  try {
    stored = await ctx.env.TENANTS.get(`tenant:${hashedKey}`);
  } catch (err) {
    console.error("auth: TENANTS KV lookup failed:", err);
    return authError("Unable to verify API key, please retry.", id);
  }

  if (!stored) {
    return authError("Unknown or revoked API key.", id);
  }

  let tenantConfig: TenantConfig;
  try {
    const parsed = JSON.parse(stored) as TenantConfig;
    if (!parsed || !Array.isArray(parsed.allowedServers)) {
      throw new Error("missing allowedServers");
    }
    tenantConfig = parsed;
  } catch (err) {
    console.error(`auth: corrupt tenant record for ${hashedKey.slice(0, 8)}:`, err);
    return authError("Tenant configuration is invalid, contact the administrator.", id);
  }

  ctx.tenantConfig = tenantConfig;
  ctx.hashedKey = hashedKey;

  return next();
};
