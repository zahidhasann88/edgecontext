// Advertised in tools/list but handled locally, never forwarded upstream. All
// three operate on the caller's SessionDO instance, so what they read and write
// is scoped to the X-EdgeContext-Project value.

import type {
  NotesMode,
  RecallResult,
  SessionDoStub,
  SessionSummaryParams,
} from "../types";

export const EDGE_CONTEXT_TOOLS = [
  {
    name: "edgecontext_remember",
    description:
      "Store freeform notes in the current project's persistent context. Notes " +
      "survive across sessions and are visible to any client using the same " +
      "project id. Replaces the existing notes by default; pass mode:\"append\" " +
      "to add to them instead.",
    inputSchema: {
      type: "object",
      properties: {
        notes: {
          type: "string",
          description: "The notes to store.",
        },
        mode: {
          type: "string",
          enum: ["replace", "append"],
          description:
            "\"replace\" (default) overwrites the stored notes; \"append\" adds " +
            "these notes on a new line after them. Notes are capped at 8 KB, " +
            "and appending past the cap discards the oldest lines.",
        },
      },
      required: ["notes"],
    },
  },
  {
    name: "edgecontext_recall",
    description:
      "Retrieve recent activity for the current project: tool calls, resource " +
      "reads and stored notes, as structured data.",
    inputSchema: {
      type: "object",
      properties: {
        includeToolCalls: {
          type: "boolean",
          description: "Include recent tool calls (default true).",
        },
        includeResources: {
          type: "boolean",
          description: "Include recent resource reads (default true).",
        },
        maxEntries: {
          type: "number",
          description: "Maximum entries per category (default 10).",
        },
      },
    },
  },
  {
    name: "edgecontext_get_session_summary",
    description:
      "Return a human-readable Markdown summary of the current project's stored " +
      "context — notes, recent tool calls and resource reads. Call this at the " +
      "start of a session to see what happened last time.",
    inputSchema: {
      type: "object",
      properties: {
        includeToolCalls: {
          type: "boolean",
          description: "Include tool call history (default true).",
        },
        includeResources: {
          type: "boolean",
          description: "Include resource read history (default true).",
        },
        includeNotes: {
          type: "boolean",
          description: "Include stored notes (default true).",
        },
        maxEntries: {
          type: "number",
          description: "Maximum entries per category (default 10).",
        },
      },
    },
  },
] as const;

const CUSTOM_TOOL_NAMES: ReadonlySet<string> = new Set(
  EDGE_CONTEXT_TOOLS.map((t) => t.name)
);

export function isCustomTool(name: string): boolean {
  return CUSTOM_TOOL_NAMES.has(name);
}

export interface ToolCallContext {
  projectId: string;
  session: SessionDoStub;
}

/**
 * Results use the standard MCP content-block shape, so ordinary clients render
 * them without special-casing EdgeContext.
 */
export async function handleCustomTool(
  toolName: string,
  args: unknown,
  ctx: ToolCallContext
): Promise<unknown> {
  const params = (args ?? {}) as Record<string, unknown>;

  switch (toolName) {
    case "edgecontext_remember":
      return remember(params, ctx);
    case "edgecontext_recall":
      return recall(params, ctx);
    case "edgecontext_get_session_summary":
      return sessionSummary(params, ctx);
    default:
      throw new Error(`Unknown custom tool: ${toolName}`);
  }
}

async function remember(
  params: Record<string, unknown>,
  ctx: ToolCallContext
): Promise<unknown> {
  const notes = params.notes;
  if (typeof notes !== "string" || !notes.trim()) {
    throw new Error("edgecontext_remember requires a non-empty string in `notes`.");
  }

  const rawMode = params.mode;
  if (rawMode !== undefined && rawMode !== "replace" && rawMode !== "append") {
    throw new Error('edgecontext_remember `mode` must be "replace" or "append".');
  }
  const mode: NotesMode = rawMode === "append" ? "append" : "replace";

  const body = await callSession<{
    ok: boolean;
    mode: NotesMode;
    notes: string;
    truncated: boolean;
  }>(ctx, "/remember", { notes, mode });

  const verb = body.mode === "append" ? "Appended to" : "Replaced";
  const trimmed = body.truncated ? " Oldest lines were dropped to stay within 8 KB." : "";

  return {
    content: [
      {
        type: "text",
        text: `${verb} notes; ${body.notes.length} characters stored.${trimmed}`,
      },
    ],
    isError: false,
  };
}

async function recall(
  params: Record<string, unknown>,
  ctx: ToolCallContext
): Promise<unknown> {
  const data = await callSession<RecallResult>(ctx, "/recall", params);
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    isError: false,
  };
}

async function sessionSummary(
  params: Record<string, unknown>,
  ctx: ToolCallContext
): Promise<unknown> {
  const data = await callSession<RecallResult>(ctx, "/recall", params);
  return {
    content: [{ type: "text", text: renderSummary(data, params as SessionSummaryParams) }],
    isError: false,
  };
}

async function callSession<T>(
  ctx: ToolCallContext,
  path: string,
  body: unknown
): Promise<T> {
  const res = await ctx.session.fetch(`https://session${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-EdgeContext-Project": ctx.projectId,
    },
    body: JSON.stringify(body),
  });

  const parsed = (await res.json().catch(() => null)) as
    | (T & { error?: { message?: string } })
    | null;

  if (!res.ok) {
    const message = parsed?.error?.message ?? `SessionDO ${path} returned ${res.status}`;
    throw new Error(message);
  }
  if (parsed === null) {
    throw new Error(`SessionDO ${path} returned an unreadable response`);
  }
  return parsed;
}

export function renderSummary(
  data: RecallResult,
  params: SessionSummaryParams = {}
): string {
  const includeNotes = params.includeNotes !== false;
  const includeToolCalls = params.includeToolCalls !== false;
  const includeResources = params.includeResources !== false;

  const lines: string[] = [`# EdgeContext session — project "${data.projectId}"`, ""];
  let wroteSection = false;

  if (includeNotes && data.notes) {
    lines.push("## Notes", data.notes, "");
    wroteSection = true;
  }

  if (includeToolCalls && data.toolCalls.length > 0) {
    lines.push("## Recent tool calls");
    for (const tc of data.toolCalls) {
      const flags = [
        tc.cacheHit ? "cache hit" : null,
        tc.success === false ? "failed" : null,
      ].filter(Boolean);
      const suffix = flags.length ? ` — ${flags.join(", ")}` : "";
      lines.push(
        `- **${tc.toolName}** (${tc.durationMs}ms, ${new Date(tc.timestamp).toISOString()})${suffix}`
      );
      if (tc.argsSummary) lines.push(`  - args: ${tc.argsSummary}`);
      lines.push(`  - result: ${tc.resultSummary}`);
    }
    const hidden = data.totalToolCalls - data.toolCalls.length;
    if (hidden > 0) lines.push(`- …and ${hidden} older call(s) not shown`);
    lines.push("");
    wroteSection = true;
  }

  if (includeResources && data.resourceReads.length > 0) {
    lines.push("## Recent resource reads");
    for (const rr of data.resourceReads) {
      lines.push(`- ${rr.resourceUri} (${new Date(rr.timestamp).toISOString()})`);
    }
    const hidden = data.totalResourceReads - data.resourceReads.length;
    if (hidden > 0) lines.push(`- …and ${hidden} older read(s) not shown`);
    lines.push("");
    wroteSection = true;
  }

  if (!wroteSection) {
    lines.push("No stored context yet for this project.");
  }

  return lines.join("\n").trimEnd();
}
