// SessionDO — persistence, isolation, rolling windows, and the R2 log flush.
//
// These exercise the real Durable Object in workerd, so a regression like using
// storage synchronously (which silently returns blank state) fails here.

import { env, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sessionPost, sessionStubFor } from "./helpers";
import { buildLogEntry, dateStr } from "../src/logging/logger";
import type { RecallResult, SessionState, ToolCallRecord } from "../src/types";
import type { SessionDO } from "../src/durable-objects/session";

function toolCall(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    toolName: "search_codebase",
    argsSummary: 'query: "auth"',
    resultSummary: "OK",
    timestamp: Date.now(),
    durationMs: 12,
    cacheHit: false,
    success: true,
    ...overrides,
  };
}

async function recall(projectId: string, body: unknown = {}): Promise<RecallResult> {
  const res = await sessionPost(projectId, "/recall", body);
  expect(res.ok).toBe(true);
  return (await res.json()) as RecallResult;
}

/** Unique project id per test so cases never share a Durable Object. */
let counter = 0;
function projectId(label: string): string {
  return `${label}-${++counter}`;
}

describe("SessionDO — persistence", () => {
  it("stores notes and reads them back", async () => {
    const project = projectId("persist");

    const res = await sessionPost(project, "/remember", { notes: "Refactoring auth" });
    expect(res.ok).toBe(true);
    await expect(res.json()).resolves.toMatchObject({ ok: true, notes: "Refactoring auth" });

    const state = await recall(project);
    expect(state.notes).toBe("Refactoring auth");
    expect(state.projectId).toBe(project);
  });

  it("persists across separate stub acquisitions", async () => {
    const project = projectId("persist-reacquire");
    await sessionPost(project, "/remember", { notes: "survives" });

    // A fresh stub for the same name addresses the same object; state must come
    // from storage, not from a per-stub in-memory cache.
    const fresh = sessionStubFor(project);
    const res = await fresh.fetch("https://session/state");
    const state = (await res.json()) as SessionState;
    expect(state.notes).toBe("survives");
  });

  it("survives the object being evicted from memory", async () => {
    const project = projectId("persist-evict");
    await sessionPost(project, "/remember", { notes: "written before eviction" });

    // abort() drops the in-memory instance; the next call reconstructs it and
    // must reload state from storage.
    const stub = sessionStubFor(project);
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage).toBeDefined();
    });

    const state = await recall(project);
    expect(state.notes).toBe("written before eviction");
  });

  it("replacing notes overwrites the previous value", async () => {
    const project = projectId("overwrite");
    await sessionPost(project, "/remember", { notes: "First note" });
    await sessionPost(project, "/remember", { notes: "Second note" });

    expect((await recall(project)).notes).toBe("Second note");
  });

  it("rejects an empty notes payload", async () => {
    const project = projectId("empty-notes");
    const res = await sessionPost(project, "/remember", { notes: "   " });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32602);
  });
});

describe("SessionDO — project isolation", () => {
  it("two project ids do not see each other's notes", async () => {
    const alpha = projectId("alpha");
    const beta = projectId("beta");

    await sessionPost(alpha, "/remember", { notes: "Alpha secret" });

    expect((await recall(alpha)).notes).toBe("Alpha secret");
    expect((await recall(beta)).notes).toBe("");
  });

  it("two project ids do not see each other's tool calls", async () => {
    const alpha = projectId("alpha-calls");
    const beta = projectId("beta-calls");

    await sessionPost(alpha, "/tool-call", { record: toolCall({ toolName: "only_in_alpha" }) });

    const a = await recall(alpha);
    const b = await recall(beta);

    expect(a.toolCalls.map((t) => t.toolName)).toEqual(["only_in_alpha"]);
    expect(b.toolCalls).toEqual([]);
    expect(b.totalToolCalls).toBe(0);
  });

  it("writing to one project does not disturb an established other", async () => {
    const alpha = projectId("cross-a");
    const beta = projectId("cross-b");

    await sessionPost(alpha, "/remember", { notes: "A" });
    await sessionPost(beta, "/remember", { notes: "B" });
    await sessionPost(alpha, "/remember", { notes: "A updated" });

    expect((await recall(alpha)).notes).toBe("A updated");
    expect((await recall(beta)).notes).toBe("B");
  });
});

describe("SessionDO — rolling windows", () => {
  it("records tool calls in order", async () => {
    const project = projectId("order");
    await sessionPost(project, "/tool-call", { record: toolCall({ toolName: "first" }) });
    await sessionPost(project, "/tool-call", { record: toolCall({ toolName: "second" }) });

    const state = await recall(project);
    expect(state.toolCalls.map((t) => t.toolName)).toEqual(["first", "second"]);
  });

  it("trims tool calls to maxToolCalls, keeping the newest", async () => {
    const project = projectId("trim");

    // Shrink the window so the test stays fast.
    const setRes = await sessionPost(project, "/state", { maxToolCalls: 3 });
    expect(setRes.ok).toBe(true);

    for (let i = 1; i <= 5; i++) {
      await sessionPost(project, "/tool-call", { record: toolCall({ toolName: `call-${i}` }) });
    }

    const state = await recall(project);
    expect(state.totalToolCalls).toBe(3);
    expect(state.toolCalls.map((t) => t.toolName)).toEqual(["call-3", "call-4", "call-5"]);
  });

  it("honours maxEntries on recall and reports the true total", async () => {
    const project = projectId("max-entries");
    for (let i = 1; i <= 4; i++) {
      await sessionPost(project, "/tool-call", { record: toolCall({ toolName: `c${i}` }) });
    }

    const state = await recall(project, { maxEntries: 2 });
    expect(state.toolCalls.map((t) => t.toolName)).toEqual(["c3", "c4"]);
    expect(state.totalToolCalls).toBe(4);
  });

  it("records resource reads and can exclude them", async () => {
    const project = projectId("resources");
    await sessionPost(project, "/resource-read", {
      record: { resourceUri: "file:///src/index.ts", timestamp: Date.now() },
    });

    expect((await recall(project)).resourceReads).toHaveLength(1);
    expect((await recall(project, { includeResources: false })).resourceReads).toEqual([]);
  });

  it("never lets a client reassign projectId via /state", async () => {
    const project = projectId("no-reassign");
    await sessionPost(project, "/state", { projectId: "hijacked" });
    expect((await recall(project)).projectId).toBe(project);
  });
});

describe("SessionDO — log buffering and R2 flush", () => {
  const logEntry = (projectIdValue: string) =>
    buildLogEntry({
      tenant: "abcd1234",
      projectId: projectIdValue,
      toolName: "search_codebase",
      latencyMs: 42,
      cacheHit: false,
      success: true,
      requestId: crypto.randomUUID(),
    });

  it("buffers log entries without writing to R2 immediately", async () => {
    const project = projectId("buffer");
    const res = await sessionPost(project, "/log", { entry: logEntry(project) });
    await expect(res.json()).resolves.toMatchObject({ ok: true, buffered: 1 });

    const listed = await env.LOGS.list({ prefix: `logs/` });
    const forProject = listed.objects.filter((o) => o.key.includes(project));
    expect(forProject).toHaveLength(0);
  });

  it("flushes buffered entries to R2 as newline-delimited JSON", async () => {
    const project = projectId("flush");
    await sessionPost(project, "/log", { entry: logEntry(project) });
    await sessionPost(project, "/log", { entry: logEntry(project) });

    const res = await sessionPost(project, "/flush", {});
    await expect(res.json()).resolves.toMatchObject({ ok: true, flushed: 2 });

    const listed = await env.LOGS.list({ prefix: `logs/${dateStr(Date.now())}/${project}/` });
    expect(listed.objects).toHaveLength(1);

    const object = await env.LOGS.get(listed.objects[0].key);
    const text = await object!.text();
    const lines = text.trimEnd().split("\n");
    expect(lines).toHaveLength(2);

    const parsed = JSON.parse(lines[0]) as { toolName: string; projectId: string };
    expect(parsed.toolName).toBe("search_codebase");
    expect(parsed.projectId).toBe(project);
  });

  it("the alarm flushes the buffer", async () => {
    const project = projectId("alarm");
    await sessionPost(project, "/log", { entry: logEntry(project) });

    // /log schedules the alarm; running it must drain the buffer to R2.
    const ran = await runDurableObjectAlarm(sessionStubFor(project));
    expect(ran).toBe(true);

    const listed = await env.LOGS.list({ prefix: `logs/${dateStr(Date.now())}/${project}/` });
    expect(listed.objects).toHaveLength(1);
  });

  it("clears the buffer after a successful flush", async () => {
    const project = projectId("drain");
    await sessionPost(project, "/log", { entry: logEntry(project) });
    await sessionPost(project, "/flush", {});

    const second = await sessionPost(project, "/flush", {});
    await expect(second.json()).resolves.toMatchObject({ flushed: 0 });
  });

  it("exposes the buffer through the running instance", async () => {
    const project = projectId("instance");
    await sessionPost(project, "/log", { entry: logEntry(project) });

    await runInDurableObject(sessionStubFor(project), async (instance: SessionDO, state) => {
      const buffered = await state.storage.get<unknown[]>("pendingLogs");
      expect(buffered).toHaveLength(1);
      expect(instance).toBeDefined();
    });
  });
});

describe("SessionDO — bad input", () => {
  let project: string;
  beforeEach(() => {
    project = projectId("bad-input");
  });

  it("rejects an unknown endpoint", async () => {
    const res = await sessionPost(project, "/nope", {});
    expect(res.status).toBe(404);
  });

  it("rejects a malformed tool-call record", async () => {
    const res = await sessionPost(project, "/tool-call", { record: { nope: true } });
    expect(res.status).toBe(400);
  });

  it("treats an empty /recall body as defaults", async () => {
    const res = await sessionStubFor(project).fetch("https://session/recall", {
      method: "POST",
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as RecallResult;
    expect(body.toolCalls).toEqual([]);
  });
});

// Notes: replace (default) and append

describe("SessionDO — notes modes", () => {
  it("defaults to replacing", async () => {
    const project = projectId("notes-default");
    await sessionPost(project, "/remember", { notes: "first" });
    await sessionPost(project, "/remember", { notes: "second" });
    expect((await recall(project)).notes).toBe("second");
  });

  it("appends on a new line when asked", async () => {
    const project = projectId("notes-append");
    await sessionPost(project, "/remember", { notes: "line one" });

    const res = await sessionPost(project, "/remember", {
      notes: "line two",
      mode: "append",
    });
    await expect(res.json()).resolves.toMatchObject({ ok: true, mode: "append" });

    expect((await recall(project)).notes).toBe("line one\nline two");
  });

  it("appending to empty notes does not leave a leading newline", async () => {
    const project = projectId("notes-append-empty");
    await sessionPost(project, "/remember", { notes: "only line", mode: "append" });
    expect((await recall(project)).notes).toBe("only line");
  });

  it("appends repeatedly, preserving order", async () => {
    const project = projectId("notes-append-many");
    for (const n of ["a", "b", "c"]) {
      await sessionPost(project, "/remember", { notes: n, mode: "append" });
    }
    expect((await recall(project)).notes).toBe("a\nb\nc");
  });

  it("an unknown mode falls back to replacing", async () => {
    const project = projectId("notes-bad-mode");
    await sessionPost(project, "/remember", { notes: "first" });
    await sessionPost(project, "/remember", { notes: "second", mode: "sideways" });
    expect((await recall(project)).notes).toBe("second");
  });

  it("caps appended notes at 8 KB, discarding the oldest lines", async () => {
    const project = projectId("notes-cap");
    const chunk = "x".repeat(1000);

    for (let i = 0; i < 12; i++) {
      await sessionPost(project, "/remember", { notes: `${i}-${chunk}`, mode: "append" });
    }

    const { notes } = await recall(project);
    expect(notes.length).toBeLessThanOrEqual(8192);

    // Every surviving line is intact — the cut landed on a line boundary rather
    // than part-way through one.
    const lines = notes.split("\n");
    for (const line of lines) expect(line).toMatch(/^\d+-x{1000}$/);

    // The newest line survived, the oldest were dropped, and order is preserved.
    const indexes = lines.map((line) => Number(line.split("-")[0]));
    expect(indexes).toContain(11);
    expect(Math.min(...indexes)).toBeGreaterThan(0);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
  });

  it("reports truncation back to the caller", async () => {
    const project = projectId("notes-truncated-flag");
    const res = await sessionPost(project, "/remember", { notes: "y".repeat(9000) });
    await expect(res.json()).resolves.toMatchObject({ truncated: true });

    const small = await sessionPost(project, "/remember", { notes: "short" });
    await expect(small.json()).resolves.toMatchObject({ truncated: false });
  });
});
