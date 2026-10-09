import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Shared mock state (hoisted so the vi.mock factories can reference it).
const h = vi.hoisted(() => {
  let n = 0;
  return {
    cronJobs: new Map<string, { onTick: () => void | Promise<void> }>(),
    removed: [] as string[],
    createJobMock: vi.fn(async (_input?: Record<string, unknown>) => ({ id: "job_123" })),
    nextId: () => `cron_${++n}`,
    multiUser: false,
  };
});

// Mock the in-memory scheduler: capture the onTick + hand back a fake job id.
vi.mock("../runtime/scheduler.js", () => ({
  createCronJob: vi.fn((_expr: string, _label: string, _action: string, onTick: () => void | Promise<void>) => {
    const id = h.nextId();
    h.cronJobs.set(id, { onTick });
    return { id };
  }),
  removeCronJob: vi.fn((id: string) => { h.removed.push(id); return h.cronJobs.delete(id); }),
}));

// Mock createJob so a fired tick records the call instead of queuing a real job.
vi.mock("../agent/jobs.js", () => ({ createJob: h.createJobMock }));

// Mock getConfig for the turn timeout the runner reads.
vi.mock("../config/loader.js", () => ({ getConfig: () => ({ gateway: { turnTimeoutMs: 123456 }, auth: { enabled: h.multiUser } }) }));

import {
  addAndActivateScheduledTask,
  removeScheduledTask,
  rehydrateScheduledTasks,
  activeScheduledTaskCount,
  _resetScheduledTaskRuntimeForTests,
} from "../runtime/scheduled-task-runner.js";
import { _setScheduledTasksPathForTests, listScheduledTaskRecords } from "../runtime/scheduled-tasks.js";

let dir = "";
beforeEach(() => {
  h.cronJobs.clear(); h.removed.length = 0; h.createJobMock.mockClear(); h.multiUser = false;
  dir = mkdtempSync(join(tmpdir(), "sched-runner-"));
  _setScheduledTasksPathForTests(join(dir, ".starlingai", "scheduled-tasks.json"));
});
afterEach(() => {
  _resetScheduledTaskRuntimeForTests();
  _setScheduledTasksPathForTests(null);
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = ""; }
});

describe("scheduled-task-runner", () => {
  it("activates + persists a schedule, and a fired tick runs the task as a real (scene) turn", async () => {
    addAndActivateScheduledTask({ id: "s1", cron: "0 8 * * 1-5", label: "Brief", task: "research X", userId: "admin", createdAt: "x" });
    expect(activeScheduledTaskCount()).toBe(1);
    expect(listScheduledTaskRecords()).toHaveLength(1); // persisted to the store

    // Fire the captured cron tick → it createJob()s the task as a scene turn.
    const cron = [...h.cronJobs.values()][0]!;
    await cron.onTick();
    expect(h.createJobMock).toHaveBeenCalledTimes(1);
    expect(h.createJobMock).toHaveBeenCalledWith(expect.objectContaining({
      definitionType: "scene",
      task: "research X",
      userId: "admin",
      turnTimeoutMs: 123456,
    }));
  });

  it("removes a schedule (stops the cron job AND unpersists it)", () => {
    addAndActivateScheduledTask({ id: "s1", cron: "* * * * *", label: "a", task: "t", createdAt: "x" });
    expect(removeScheduledTask("s1")).toBe(true);
    expect(activeScheduledTaskCount()).toBe(0);
    expect(h.removed).toHaveLength(1);                  // removeCronJob was called
    expect(listScheduledTaskRecords()).toHaveLength(0); // and it was unpersisted
    expect(removeScheduledTask("nope")).toBe(false);
  });

  it("rehydrates persisted schedules on boot (survives restart)", () => {
    addAndActivateScheduledTask({ id: "s1", cron: "* * * * *", label: "a", task: "t1", createdAt: "x" });
    addAndActivateScheduledTask({ id: "s2", cron: "* * * * *", label: "b", task: "t2", createdAt: "x" });
    // Simulate a restart: clear the in-memory runtime; the store file persists.
    _resetScheduledTaskRuntimeForTests();
    expect(activeScheduledTaskCount()).toBe(0);
    rehydrateScheduledTasks();
    expect(activeScheduledTaskCount()).toBe(2);
  });

  // Under multi-user auth a run is its owner's whole: the account id travels with the name. A
  // schedule from before account ids names a user and no account; its run would derive storage from
  // the username, which the derivation refuses, so the job would fail every time it fires. It is
  // skipped, and logged once, until the account migration stamps it.
  it("under multi-user auth, runs a schedule as its owner's account, and skips one from before account ids", async () => {
    h.multiUser = true;
    addAndActivateScheduledTask({ id: "acct", cron: "* * * * *", label: "a", task: "t1", userId: "alice", account: "alice-0123456789abcdef", createdAt: "x" });
    addAndActivateScheduledTask({ id: "bot", cron: "* * * * *", label: "b", task: "t2", userId: "job:x", principal: "synthetic", createdAt: "x" });
    addAndActivateScheduledTask({ id: "legacy", cron: "* * * * *", label: "c", task: "t3", userId: "alice", createdAt: "x" });
    for (const cron of h.cronJobs.values()) await cron.onTick();
    expect(h.createJobMock.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({ task: "t1", userId: "alice", account: "alice-0123456789abcdef" }),
      expect.objectContaining({ task: "t2", userId: "job:x", principal: "synthetic" }),
    ]);
    expect(h.createJobMock.mock.calls[0]![0]).not.toHaveProperty("principal");
  });

  it("with one operator, runs a schedule that names only a user, as before", async () => {
    addAndActivateScheduledTask({ id: "legacy", cron: "* * * * *", label: "c", task: "t3", userId: "alice", createdAt: "x" });
    await [...h.cronJobs.values()][0]!.onTick();
    expect(h.createJobMock).toHaveBeenCalledTimes(1);
    expect(h.createJobMock.mock.calls[0]![0]).not.toHaveProperty("account");
  });
});
