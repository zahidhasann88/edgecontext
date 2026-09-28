import type { LogEntry } from "../types";

const LOGS_PREFIX = "logs";

export function buildLogEntry(params: {
  tenant: string;
  projectId: string;
  toolName: string;
  latencyMs: number;
  cacheHit: boolean;
  success: boolean;
  error?: string;
  requestId: string;
}): LogEntry {
  return {
    tenant: params.tenant,
    projectId: params.projectId,
    toolName: params.toolName,
    latencyMs: params.latencyMs,
    cacheHit: params.cacheHit,
    success: params.success,
    ...(params.error ? { error: params.error } : {}),
    timestamp: Date.now(),
    requestId: params.requestId,
  };
}

export function dateStr(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function formatLogBatch(entries: LogEntry[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
  return cleaned || "unknown";
}

export function logObjectKey(projectId: string, timestamp: number): string {
  const rand = crypto.randomUUID().slice(0, 8);
  return `${LOGS_PREFIX}/${dateStr(timestamp)}/${safeSegment(projectId)}/${timestamp}-${rand}.jsonl`;
}

export async function flushLogsToR2(
  bucket: R2Bucket,
  projectId: string,
  entries: LogEntry[]
): Promise<string | null> {
  if (entries.length === 0) return null;

  const byDate = new Map<string, LogEntry[]>();
  for (const entry of entries) {
    const day = dateStr(entry.timestamp);
    const bucketed = byDate.get(day);
    if (bucketed) bucketed.push(entry);
    else byDate.set(day, [entry]);
  }

  let lastKey: string | null = null;
  for (const group of byDate.values()) {
    const key = logObjectKey(projectId, group[0].timestamp);
    await bucket.put(key, formatLogBatch(group), {
      httpMetadata: { contentType: "application/x-ndjson" },
    });
    lastKey = key;
  }
  return lastKey;
}
