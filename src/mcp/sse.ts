// MCP's Streamable HTTP transport lets a server answer a POST with either a
// single `application/json` body or a `text/event-stream` whose events each carry
// one JSON-RPC message. Both shapes have to work, so a stream is either forwarded
// to a client that accepts SSE or drained into one JSON body for a client that
// does not.

const MAX_OBSERVED_BYTES = 1_048_576; // 1 MiB

export function isEventStream(response: Response): boolean {
  return (response.headers.get("Content-Type") ?? "")
    .toLowerCase()
    .includes("text/event-stream");
}

export function acceptsEventStream(accept: string | null): boolean {
  if (!accept) return false;
  const lower = accept.toLowerCase();
  return lower.includes("text/event-stream") || lower.includes("*/*");
}

/**
 * Extract the JSON-RPC messages carried by an SSE payload.
 *
 * Events are separated by a blank line, and one event may spread its payload
 * over several `data:` lines, which are joined before parsing. Unparseable
 * blocks are skipped: a comment or keep-alive line is not an error.
 */
export function parseSseMessages(text: string): unknown[] {
  const messages: unknown[] = [];

  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).replace(/^ /, ""))
      .join("\n");

    if (!data.trim()) continue;
    try {
      messages.push(JSON.parse(data));
    } catch {
      // A comment, a keep-alive, or a partial final event.
    }
  }

  return messages;
}

export interface SseEnvelope {
  jsonrpc?: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  id?: string | number | null;
}

/**
 * Find the response to a given request id among SSE messages.
 *
 * A stream also carries notifications and server-initiated requests, so the
 * reply wanted is the one echoing our id. Some servers do not echo ids
 * faithfully; the fallback is the last message that looks like a response, which
 * is the one that ends the exchange.
 */
export function findResponseEnvelope(
  messages: unknown[],
  id: string | number | null
): SseEnvelope | undefined {
  const responses = messages.filter(
    (m): m is SseEnvelope =>
      typeof m === "object" &&
      m !== null &&
      ("result" in m || "error" in m)
  );

  return responses.find((m) => m.id === id) ?? responses[responses.length - 1];
}

/**
 * Forward a streamed response while copying its text aside.
 *
 * Bytes reach the client as they arrive; the copy is incidental, and exists only
 * so `onComplete` can cache and record the call once the stream ends. It
 * receives the accumulated text and whether the cap truncated it.
 */
export function observeStream(
  response: Response,
  extraHeaders: Record<string, string>,
  onComplete: (text: string, truncated: boolean) => void
): Response {
  if (!response.body) {
    onComplete("", false);
    return new Response(null, {
      status: response.status,
      headers: mergeHeaders(response.headers, extraHeaders),
    });
  }

  const decoder = new TextDecoder();
  let observed = "";
  let truncated = false;
  let settled = false;

  const finish = () => {
    if (settled) return;
    settled = true;
    try {
      onComplete(observed, truncated);
    } catch (err) {
      console.error("sse: observer failed:", err);
    }
  };

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);

      if (truncated) return;
      if (observed.length > MAX_OBSERVED_BYTES) {
        truncated = true;
        observed = "";
        return;
      }
      observed += decoder.decode(chunk, { stream: true });
    },
    flush() {
      if (!truncated) observed += decoder.decode();
      finish();
    },
    cancel() {
      truncated = true;
      finish();
    },
  });

  return new Response(response.body.pipeThrough(transform), {
    status: response.status,
    headers: mergeHeaders(response.headers, extraHeaders),
  });
}

export async function drainSse(response: Response): Promise<unknown[]> {
  const text = await response.text();
  return parseSseMessages(text);
}

function mergeHeaders(source: Headers, extra: Record<string, string>): Headers {
  const headers = new Headers(source);
  headers.delete("Content-Length");
  headers.delete("Content-Encoding");
  for (const [key, value] of Object.entries(extra)) headers.set(key, value);
  return headers;
}
