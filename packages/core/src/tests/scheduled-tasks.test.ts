import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  saveScheduledTask,
  deleteScheduledTask,
  listScheduledTaskRecords,
  loadScheduledTasks,
  _setScheduledTasksPathForTests,
} from "../runtime/scheduled-tasks.js";

let dir = "";
afterEach(() => {
  _setScheduledTasksPathForTests(null);
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = ""; }
});

function tempStore(): string {
  dir = mkdtempSync(join(tmpdir(), "sched-"));
  const p = join(dir, ".starlingai", "scheduled-tasks.json");
  _setScheduledTasksPathForTests(p);
  return p;
}

describe("scheduled-tasks store", () => {
  it("persists a schedule and reloads it across a fresh load (survives restart)", () => {
    const p = tempStore();
    saveScheduledTask({ id: "sched_1", cron: "0 9 * * 1-5", label: "Morning brief", task: "research X and brief me", userId: "admin", createdAt: "2026-06-28T00:00:00Z" });
    expect(existsSync(p)).toBe(true);
    // Simulate a restart: drop the in-memory cache, then load from disk again.
    _setScheduledTasksPathForTests(p);
    const reloaded = loadScheduledTasks();
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]?.task).toBe("research X and brief me");
    expect(reloaded[0]?.cron).toBe("0 9 * * 1-5");
  });

  it("replaces a schedule by id and deletes it", () => {
    tempStore();
    saveScheduledTask({ id: "s1", cron: "* * * * *", label: "a", task: "t1", createdAt: "x" });
    saveScheduledTask({ id: "s1", cron: "* * * * *", label: "a", task: "t2", createdAt: "x" }); // replace
    expect(listScheduledTaskRecords()).toHaveLength(1);
    expect(listScheduledTaskRecords()[0]?.task).toBe("t2");
    expect(deleteScheduledTask("s1")).toBe(true);
    expect(listScheduledTaskRecords()).toHaveLength(0);
    expect(deleteScheduledTask("nope")).toBe(false);
  });

  it("starts empty (never throws) on a corrupt store file", () => {
    const p = tempStore();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "{ not valid json", "utf8");
    _setScheduledTasksPathForTests(p);
    expect(loadScheduledTasks()).toEqual([]);
  });
});
