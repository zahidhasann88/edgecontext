// Every client-facing error is a JSON-RPC error object. MCP clients parse the
// envelope, not the HTTP status, so a bare 401 or 429 surfaces as a transport
// error with no usable message. Responses default to status 200 and set a
// matching HTTP status only where an HTTP-aware intermediary benefits from it.

import type { JsonRpcError, JsonRpcSuccess } from "../types";

export const JSON_HEADERS = { "Content-Type": "application/json" } as const;

export function jsonRpcSuccess(
  result: unknown,
  id: string | number | null,
  extraHeaders?: Record<string, string>
): Response {
  const body: JsonRpcSuccess = { jsonrpc: "2.0", result, id };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

export function jsonRpcError(
  code: number,
  message: string,
  id: string | number | null,
  options: { data?: unknown; status?: number; headers?: Record<string, string> } = {}
): Response {
  const body: JsonRpcError = {
    jsonrpc: "2.0",
    error: { code, message, ...(options.data !== undefined ? { data: options.data } : {}) },
    id,
  };
  return new Response(JSON.stringify(body), {
    status: options.status ?? 200,
    headers: { ...JSON_HEADERS, ...options.headers },
  });
}
