import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The runner would start real cron jobs and timers; the store is what these tests read.
const h = vi.hoisted(() => ({ activated: [] as Array<Record<string, unknown>> }));
vi.mock("../runtime/scheduled-task-runner.js", () => ({
  addAndActivateScheduledTask: vi.fn((rec: Record<string, unknown>) => { h.activated.push(rec); }),
  removeScheduledTask: vi.fn(() => true),
}));

import { ALWAYS_AVAILABLE_MAIN_TOOL_NAMES } from "../agent/default-tools.js";
import { getToolTier } from "../guardrails/tool-tiers.js";
import { runWithRequestContext } from "../runtime/request-context.js";
import { DEFAULT_WATCH_RUNS, _setScheduledTasksPathForTests } from "../runtime/scheduled-tasks.js";
import { executeTool, getTool } from "../tools/registry.js";
import { readScheduleRequest, scheduleWhen } from "../tools/schedule.js";

// 15:00 in Berlin.
const NOW = new Date("2026-11-12T14:00:00Z");
const BERLIN = "Europe/Berlin";
let dir = "";

beforeEach(() => {
  h.activated.length = 0;
  dir = mkdtempSync(join(tmpdir(), "schedule-tool-"));
  _setScheduledTasksPathForTests(join(dir, "scheduled-tasks.json"));
});
afterEach(() => {
  vi.useRealTimers();
  _setScheduledTasksPathForTests(null);
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = ""; }
});

describe("reading a schedule_task call", () => {
  const base = { label: "Release watch", task: "Check whether the full release is out." };
  /** `zone` null: a conversation whose time zone is not known. */
  const read = (args: Record<string, unknown>, zone: string | null = BERLIN) => readScheduleRequest({ ...base, ...args }, NOW, zone ?? undefined);

  it("takes a watch: a schedule that repeats on the user's clock until something has happened, with a last run", async () => {
    expect(await read({ kind: "watch", cron: "0 7 * * *", until: "the release is out" })).toEqual({
      ...base, cron: "0 7 * * *", timeZone: BERLIN, until: "the release is out", maxRuns: DEFAULT_WATCH_RUNS,
    });
    expect(await read({ kind: "watch", cron: "0 7 * * *", until: "the release is out", maxRuns: 5 })).toMatchObject({ maxRuns: 5 });
  });

  it("takes a schedule that repeats and posts every run", async () => {
    expect(await read({ kind: "repeat", cron: "0 8 * * 1-5" })).toEqual({ ...base, cron: "0 8 * * 1-5", timeZone: BERLIN });
    expect(await read({ kind: "repeat", cron: "0 8 * * 1-5", maxRuns: 10 })).toMatchObject({ maxRuns: 10 });
  });

  it("takes one run at a time on the user's clock and stores the instant", async () => {
    expect(await read({ kind: "once", at: "2026-11-13T09:00" })).toEqual({ ...base, at: "2026-11-13T08:00:00.000Z", timeZone: BERLIN });
    // The same words mean another instant for somebody in New York.
    expect(await read({ kind: "once", at: "2026-11-13T09:00" }, "America/New_York")).toMatchObject({ at: "2026-11-13T14:00:00.000Z" });
  });

  it("takes a time that names its own offset as that instant", async () => {
    expect(await read({ kind: "once", at: "2026-11-13T09:00:00+05:30" })).toMatchObject({ at: "2026-11-13T03:30:00.000Z" });
  });

  it("takes one run a number of minutes from now, with no clock to read", async () => {
    expect(await read({ kind: "once", inMinutes: 120 })).toEqual({ ...base, at: "2026-11-12T16:00:00.000Z", timeZone: BERLIN });
    expect(await read({ kind: "once", inMinutes: 20 }, null)).toEqual({ ...base, at: "2026-11-12T14:20:00.000Z" });
    expect(await read({ kind: "once", inMinutes: 0 })).toEqual({ error: expect.stringContaining("inMinutes must be") });
  });

  it("takes a time as UTC, and marks it, where no zone is known", async () => {
    expect(await read({ kind: "once", at: "2026-11-13T09:00" }, null)).toEqual({ ...base, at: "2026-11-13T09:00:00.000Z", assumedUtc: true });
    expect(await read({ kind: "repeat", cron: "0 7 * * *" }, null)).toEqual({ ...base, cron: "0 7 * * *" });
  });

  // Left to itself the model set a daily cron, wrote "report only when something is new" into the
  // task and gave no `until`: every run would have been posted. It has to say which kind it means.
  it("asks for the kind and never guesses it", async () => {
    expect(await read({ cron: "0 7 * * *", until: "the release is out" })).toEqual({ error: expect.stringContaining("kind is required") });
    expect(await read({ kind: "sometimes", cron: "0 7 * * *" })).toEqual({ error: expect.stringContaining("kind is required") });
  });

  it("a watch must say what it waits for, and when it looks", async () => {
    expect(await read({ kind: "watch", cron: "0 7 * * *" })).toEqual({ error: expect.stringContaining("kind \"watch\" needs `until`") });
    expect(await read({ kind: "watch", until: "the release is out" })).toEqual({ error: expect.stringContaining("kind \"watch\" needs `cron`") });
    expect(await read({ kind: "watch", inMinutes: 5, until: "the release is out" })).toEqual({ error: expect.stringContaining("kind \"watch\" repeats") });
  });

  it("keeps each kind to its own arguments", async () => {
    expect(await read({ kind: "repeat", cron: "0 7 * * *", until: "it is out" })).toEqual({ error: expect.stringContaining("is kind \"watch\"") });
    expect(await read({ kind: "repeat" })).toEqual({ error: expect.stringContaining("kind \"repeat\" needs `cron`") });
    expect(await read({ kind: "once" })).toEqual({ error: expect.stringContaining("kind \"once\" needs `at`") });
    expect(await read({ kind: "once", cron: "0 7 * * *" })).toEqual({ error: expect.stringContaining("kind \"once\" runs one time") });
    expect(await read({ kind: "once", at: "2026-11-13T09:00", inMinutes: 5 })).toEqual({ error: "Give `at` or `inMinutes`, not both." });
    expect(await read({ kind: "once", at: "2026-11-13T09:00", until: "it is out" })).toEqual({ error: expect.stringContaining("`until` belongs to kind \"watch\"") });
    expect(await read({ kind: "once", inMinutes: 30, maxRuns: 3 })).toEqual({ error: expect.stringContaining("maxRuns belongs to a repeating schedule") });
  });

  it("refuses a time in the past and says what time it is there, but lets a minute pass", async () => {
    expect(await read({ kind: "once", at: "2026-11-12T14:00" })).toEqual({
      error: "at is in the past: 2026-11-12 14:00 (Europe/Berlin). It is 2026-11-12 15:00 there now.",
    });
    expect(await read({ kind: "once", at: "2026-11-12T14:59:30" })).toMatchObject({ at: "2026-11-12T13:59:30.000Z" });
  });

  it("refuses what is not a time, not a cron expression, or no number of runs", async () => {
    expect(await read({ kind: "once", at: "tomorrow at nine" })).toEqual({ error: expect.stringContaining("at is not a time") });
    expect(await read({ kind: "repeat", cron: "every morning" })).toEqual({ error: "Invalid cron expression: every morning" });
    expect(await read({ kind: "repeat", cron: "0 7 * * *", maxRuns: 0 })).toEqual({ error: expect.stringContaining("maxRuns must be") });
    expect(await read({ kind: "repeat", cron: "0 7 * * *", maxRuns: 2.5 })).toEqual({ error: expect.stringContaining("maxRuns must be") });
  });

  it("needs a label and a task", async () => {
    expect(await readScheduleRequest({ kind: "repeat", cron: "0 7 * * *", task: "x" }, NOW, BERLIN)).toEqual({ error: "label is required" });
    expect(await readScheduleRequest({ kind: "repeat", cron: "0 7 * * *", label: "x", task: "  " }, NOW, BERLIN)).toEqual({ error: "task is required" });
  });

  it("says when a schedule runs as its maker's clock shows it", () => {
    expect(scheduleWhen({ at: "2026-11-13T08:00:00.000Z", timeZone: BERLIN })).toBe("once at 2026-11-13 09:00 (Europe/Berlin)");
    expect(scheduleWhen({ cron: "0 8 * * 1-5", timeZone: BERLIN })).toBe("`0 8 * * 1-5` (Europe/Berlin)");
    expect(scheduleWhen({ cron: "0 8 * * 1-5" })).toBe("`0 8 * * 1-5` (UTC)");
  });
});

describe("schedule_task", () => {
  const call = { kind: "watch", cron: "0 7 * * *", label: "Release watch", task: "Check whether the full release is out.", until: "the full release is out" };
  const inBerlin = <T>(fn: () => T): T => runWithRequestContext({ userTimeZone: BERLIN }, fn);

  it("is the main assistant's, with its list and its remove, and asks on every call", () => {
    for (const name of ["schedule_task", "schedule_list", "schedule_remove"]) {
      expect(ALWAYS_AVAILABLE_MAIN_TOOL_NAMES, name).toContain(name);
      expect(getTool(name), name).toBeDefined();
    }
    expect(getToolTier("schedule_task").requiresPerCallApproval).toBe(true);
    expect(getToolTier("schedule_remove").requiresPerCallApproval).toBe(true);
  });

  it("stores the watch with the conversation it was made in, its owner and the user's zone", async () => {
    const approvalCallback = vi.fn(async () => true);
    const result = await inBerlin(() => executeTool("schedule_task", call, {
      sessionId: "chat-1", workspacePath: dir, userId: "alice", identity: { userId: "alice", account: "alice-0123456789abcdef" }, approvalCallback,
    }));
    expect(result.success).toBe(true);
    expect(approvalCallback).toHaveBeenCalledTimes(1);
    expect(h.activated).toEqual([expect.objectContaining({
      cron: "0 7 * * *", timeZone: BERLIN, label: "Release watch", task: "Check whether the full release is out.", until: "the full release is out",
      maxRuns: DEFAULT_WATCH_RUNS, sessionId: "chat-1", userId: "alice", account: "alice-0123456789abcdef",
    })]);
    expect(h.activated[0]).not.toHaveProperty("assumedUtc");
    expect(result.output).toContain("Runs on `0 7 * * *` (Europe/Berlin), next at ");
    expect(result.output).toContain("A watch: runs stay silent until one finds that this has happened");
    expect(result.output).toContain("posted into this conversation");
    expect(result.output).not.toContain("taken as UTC");
    expect(result.metadata).toMatchObject({ watch: true, cron: "0 7 * * *", timeZone: BERLIN });
  });

  it("tells a single run's time back on the user's clock", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const result = await inBerlin(() => executeTool("schedule_task", { kind: "once", at: "2026-11-13T09:00", label: "Reminder", task: "Remind about the call." }, {
      sessionId: "chat-1", workspacePath: dir, approvalCallback: async () => true,
    }));
    expect(result.success).toBe(true);
    expect(result.output).toContain("Runs once at 2026-11-13 09:00 (Europe/Berlin).");
    expect(h.activated[0]).toMatchObject({ at: "2026-11-13T08:00:00.000Z", timeZone: BERLIN, sessionId: "chat-1" });
    expect(h.activated[0]).not.toHaveProperty("cron");
  });

  it("says so when it had to take the time as UTC", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const result = await executeTool("schedule_task", { kind: "once", at: "2026-11-13T09:00", label: "Reminder", task: "Remind about the call." }, {
      sessionId: "chat-1", workspacePath: dir, approvalCallback: async () => true,
    });
    expect(result.output).toContain("Runs once at 2026-11-13 09:00 (UTC). No time zone is known for this conversation, so the time was taken as UTC: say so.");
    expect(h.activated[0]).toMatchObject({ at: "2026-11-13T09:00:00.000Z" });
    expect(h.activated[0]).not.toHaveProperty("timeZone");
    expect(h.activated[0]).not.toHaveProperty("assumedUtc");
  });

  // The call needs approval on every call: one that cannot work must not reach the person first.
  it("refuses a call that cannot work before anyone is asked to approve it", async () => {
    const approvalCallback = vi.fn(async () => true);
    const result = await executeTool("schedule_task", { ...call, cron: "every morning" }, { sessionId: "chat-1", workspacePath: dir, approvalCallback });
    expect(result).toMatchObject({ success: false, error: "Invalid cron expression: every morning" });
    expect(approvalCallback).not.toHaveBeenCalled();
    expect(h.activated).toHaveLength(0);
  });

  it("stores nothing when the person says no", async () => {
    const result = await executeTool("schedule_task", call, { sessionId: "chat-1", workspacePath: dir, approvalCallback: async () => false });
    expect(result.success).toBe(false);
    expect(h.activated).toHaveLength(0);
  });

  // A scheduled run has nobody to ask, so it cannot schedule more runs.
  it("is refused where there is nobody to approve it", async () => {
    const result = await executeTool("schedule_task", call, { sessionId: "run-1", workspacePath: dir });
    expect(result).toMatchObject({ success: false, error: expect.stringContaining("no approval channel") });
    expect(h.activated).toHaveLength(0);
  });

  it("does not take a sub-agent's or a workflow's session for a conversation", async () => {
    await executeTool("schedule_task", call, { sessionId: "sub:chat-1:researcher:1794", workspacePath: dir, approvalCallback: async () => true });
    expect(h.activated[0]).not.toHaveProperty("sessionId");
  });
});
