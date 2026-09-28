// One instance per project_id, holding a rolling window of recent activity and a
// buffer of log entries that the alarm flushes to R2.
//
// Isolation comes from the namespace itself: the Worker addresses instances with
// `idFromName(projectId)`, so two project ids are two objects with separate
// storage and no shared key space to leak across.

import {
  JSONRPC_ERR_INVALID_PARAMS,
  type Env,
  type LogEntry,
  type NotesMode,
  type RecallParams,
  type RecallResult,
  type RememberParams,
  type ResourceReadRecord,
  type SessionState,
  type ToolCallRecord,
} from "../types";
import { flushLogsToR2 } from "../logging/logger";

const DEFAULT_MAX_TOOL_CALLS = 50;
const DEFAULT_MAX_RESOURCE_READS = 30;
const ALARM_INTERVAL_MS = 60_000;

const MAX_NOTES_BYTES = 8_192;

const MAX_BUFFERED_LOGS = 1_000;

const STATE_KEY = "sessionState";
const LOG_BUFFER_KEY = "pendingLogs";

export class SessionDO implements DurableObject {
  private readonly state: DurableObjectState;
  private readonly env: Env;

  private session!: SessionState;
  private pendingLogs: LogEntry[] = [];

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<SessionState>(STATE_KEY);
      this.session = stored ? this.normalise(stored) : this.initialState();
      this.pendingLogs = (await this.state.storage.get<LogEntry[]>(LOG_BUFFER_KEY)) ?? [];
    });
  }

  private initialState(): SessionState {
    return {
      projectId: this.state.id.name ?? "unknown",
      notes: "",
      toolCalls: [],
      resourceReads: [],
      maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
      maxResourceReads: DEFAULT_MAX_RESOURCE_READS,
      updatedAt: Date.now(),
    };
  }

  private normalise(stored: Partial<SessionState>): SessionState {
    const base = this.initialState();
    return {
      ...base,
      ...stored,
      toolCalls: Array.isArray(stored.toolCalls) ? stored.toolCalls : [],
      resourceReads: Array.isArray(stored.resourceReads) ? stored.resourceReads : [],
      maxToolCalls: stored.maxToolCalls ?? base.maxToolCalls,
      maxResourceReads: stored.maxResourceReads ?? base.maxResourceReads,
    };
  }

  private async persist(): Promise<void> {
    this.session.updatedAt = Date.now();
    await this.state.storage.put(STATE_KEY, this.session);
  }

  private async persistLogs(): Promise<void> {
    await this.state.storage.put(LOG_BUFFER_KEY, this.pendingLogs);
  }

  async alarm(): Promise<void> {
    await this.flushLogs();

    if (this.pendingLogs.length > 0) {
      await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
  }

  private async flushLogs(): Promise<number> {
    if (this.pendingLogs.length === 0) return 0;

    const batch = this.pendingLogs;
    this.pendingLogs = [];
    await this.persistLogs();

    try {
      await flushLogsToR2(this.env.LOGS, this.session.projectId, batch);
      return batch.length;
    } catch (err) {
      console.error("SessionDO: R2 flush failed, re-buffering entries:", err);
      this.pendingLogs = [...batch, ...this.pendingLogs].slice(-MAX_BUFFERED_LOGS);
      await this.persistLogs();
      return 0;
    }
  }

  private async ensureAlarm(): Promise<void> {
    const existing = await this.state.storage.getAlarm();
    if (existing === null) {
      await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);

    const headerProject = request.headers.get("X-EdgeContext-Project")?.trim();
    if (headerProject && this.session.projectId === "unknown") {
      this.session.projectId = headerProject;
      await this.persist();
    }

    try {
      switch (pathname) {
        case "/state":
          if (request.method === "GET") return this.json(this.session);
          if (request.method === "POST") return await this.handlePostState(request);
          return this.rpcError(405, "Method not allowed on /state");

        case "/remember":
          return await this.handleRemember(request);

        case "/recall":
          return await this.handleRecall(request);

        case "/tool-call":
          return await this.handleToolCall(request);

        case "/resource-read":
          return await this.handleResourceRead(request);

        case "/log":
          return await this.handleLog(request);

        case "/flush":
          return this.json({ ok: true, flushed: await this.flushLogs() });

        default:
          return this.rpcError(404, `Unknown SessionDO endpoint: ${pathname}`);
      }
    } catch (err) {
      console.error("SessionDO.fetch failed:", err);
      return this.rpcError(500, "Internal Durable Object error");
    }
  }

  private async handlePostState(request: Request): Promise<Response> {
    const body = await this.readJson<Partial<SessionState>>(request);
    if (!body) return this.badParams("Invalid JSON body for /state");

    this.session = this.normalise({
      ...this.session,
      ...body,
      projectId: this.session.projectId,
    });
    await this.persist();
    return this.json(this.session);
  }

  private async handleRemember(request: Request): Promise<Response> {
    const body = await this.readJson<RememberParams>(request);
    if (!body) return this.badParams("Invalid JSON body for /remember");

    if (typeof body.notes !== "string" || !body.notes.trim()) {
      return this.badParams("/remember requires { notes: string }");
    }

    const mode: NotesMode = body.mode === "append" ? "append" : "replace";
    const incoming = body.notes.trim();

    const combined =
      mode === "append" && this.session.notes
        ? `${this.session.notes}\n${incoming}`
        : incoming;

    this.session.notes = capNotes(combined);
    await this.persist();
    return this.json({
      ok: true,
      mode,
      notes: this.session.notes,
      truncated: combined.length !== this.session.notes.length,
    });
  }

  private async handleRecall(request: Request): Promise<Response> {
    const params = (await this.readJson<RecallParams>(request)) ?? {};
    const maxEntries = clampPositive(params.maxEntries, 10);

    const result: RecallResult = {
      projectId: this.session.projectId,
      notes: this.session.notes,
      toolCalls:
        params.includeToolCalls === false ? [] : this.session.toolCalls.slice(-maxEntries),
      resourceReads:
        params.includeResources === false
          ? []
          : this.session.resourceReads.slice(-maxEntries),
      totalToolCalls: this.session.toolCalls.length,
      totalResourceReads: this.session.resourceReads.length,
    };
    return this.json(result);
  }

  private async handleToolCall(request: Request): Promise<Response> {
    const body = await this.readJson<{ record: ToolCallRecord }>(request);
    if (!body?.record || typeof body.record.toolName !== "string") {
      return this.badParams("/tool-call requires { record: ToolCallRecord }");
    }

    this.session.toolCalls.push(body.record);
    if (this.session.toolCalls.length > this.session.maxToolCalls) {
      this.session.toolCalls = this.session.toolCalls.slice(-this.session.maxToolCalls);
    }
    await this.persist();
    return this.json({ ok: true, total: this.session.toolCalls.length });
  }

  private async handleResourceRead(request: Request): Promise<Response> {
    const body = await this.readJson<{ record: ResourceReadRecord }>(request);
    if (!body?.record || typeof body.record.resourceUri !== "string") {
      return this.badParams("/resource-read requires { record: ResourceReadRecord }");
    }

    this.session.resourceReads.push(body.record);
    if (this.session.resourceReads.length > this.session.maxResourceReads) {
      this.session.resourceReads = this.session.resourceReads.slice(
        -this.session.maxResourceReads
      );
    }
    await this.persist();
    return this.json({ ok: true, total: this.session.resourceReads.length });
  }

  private async handleLog(request: Request): Promise<Response> {
    const body = await this.readJson<{ entry: LogEntry }>(request);
    if (!body?.entry || typeof body.entry !== "object") {
      return this.badParams("/log requires { entry: LogEntry }");
    }

    this.pendingLogs.push(body.entry);
    if (this.pendingLogs.length > MAX_BUFFERED_LOGS) {
      this.pendingLogs = this.pendingLogs.slice(-MAX_BUFFERED_LOGS);
    }
    await this.persistLogs();
    await this.ensureAlarm();

    return this.json({ ok: true, buffered: this.pendingLogs.length });
  }

  private async readJson<T>(request: Request): Promise<T | null> {
    try {
      const text = await request.text();
      if (!text.trim()) return null;
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  private badParams(message: string): Response {
    return this.json(
      { jsonrpc: "2.0", error: { code: JSONRPC_ERR_INVALID_PARAMS, message }, id: null },
      400
    );
  }

  private rpcError(status: number, message: string): Response {
    return this.json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }, status);
  }
}

function capNotes(notes: string): string {
  if (notes.length <= MAX_NOTES_BYTES) return notes;

  const tail = notes.slice(notes.length - MAX_NOTES_BYTES);
  const firstBreak = tail.indexOf("\n");
  return firstBreak === -1 ? tail : tail.slice(firstBreak + 1);
}

function clampPositive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}
