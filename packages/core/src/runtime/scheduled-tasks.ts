/**
 * Durable store for runtime-created scheduled tasks ("standing agent" schedules).
 *
 * The in-memory scheduler (runtime/scheduler.ts) loses every job on restart, so a
 * schedule_task created at runtime would silently vanish on the next deploy — an
 * automation feature is only credible if it survives a restart. This persists the
 * schedule DEFINITIONS (cron + the free-text task to run) to a workspace JSON so they
 * can be rehydrated on boot. Lives in the workspace `.starlingai` zone (host bind, so
 * it rides restarts; not a wiped runtime DB volume).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";
import type { PrincipalKind } from "./accounts.js";

const log = childLogger("scheduled-tasks");

export interface ScheduledTaskRecord {
  /** Stable id (survives rehydration); the in-memory cron job id is ephemeral. */
  id: string;
  /** 5- or 6-field cron expression (UTC). */
  cron: string;
  /** Short human label. */
  label: string;
  /** The free-text task run as a real turn (a scene) each time it fires. */
  task: string;
  /** Owner — scopes the scheduled run to a user (auth-on deployments). */
  userId?: string;
  /** With `userId`, from one identity: the owner's account id, or (instead) its principal kind.
   *  Under multi-user auth a schedule with a userId and neither predates account ids, and the
   *  runner skips it (scheduled-task-runner.ts). */
  account?: string;
  principal?: PrincipalKind;
  createdAt: string;
  /** Set when the schedule must not run again (its owner's account was deleted or retired). It is
   *  kept, not removed: its owner's data stays until a purge, and an admin can still read and remove
   *  it. The runner registers no cron job for it. */
  disabled?: { at: string; reason: string };
}

let _cache: ScheduledTaskRecord[] | null = null;
let _pathOverride: string | null = null;

function storePath(): string {
  if (_pathOverride) return _pathOverride;
  return join(getConfig().workspacePath, ".starlingai", "scheduled-tasks.json");
}

function isValid(t: unknown): t is ScheduledTaskRecord {
  const r = t as ScheduledTaskRecord;
  return !!r && typeof r.id === "string" && typeof r.cron === "string"
    && typeof r.label === "string" && typeof r.task === "string";
}

/** Load all persisted schedules (cached after first read). */
export function loadScheduledTasks(): ScheduledTaskRecord[] {
  if (_cache) return _cache;
  const path = storePath();
  if (!existsSync(path)) { _cache = []; return _cache; }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { tasks?: unknown[] };
    _cache = Array.isArray(parsed.tasks) ? parsed.tasks.filter(isValid) : [];
  } catch (err) {
    log.error({ err }, "Failed to read scheduled-tasks store — starting empty");
    _cache = [];
  }
  return _cache;
}

function persist(tasks: ScheduledTaskRecord[]): void {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ tasks }, null, 2)}\n`, { mode: 0o600 });
  _cache = tasks;
}

/** Add a schedule, or replace the one with the same id, and persist. */
export function saveScheduledTask(rec: ScheduledTaskRecord): void {
  const tasks = loadScheduledTasks().filter((t) => t.id !== rec.id);
  tasks.push(rec);
  persist(tasks);
}

/** Mark a schedule disabled, in place, and persist. Returns false if it wasn't there or was
 *  disabled already. */
export function disableScheduledTask(id: string, disabled: { at: string; reason: string }): boolean {
  const tasks = loadScheduledTasks();
  const target = tasks.find((t) => t.id === id);
  if (!target || target.disabled) return false;
  persist(tasks.map((t) => (t.id === id ? { ...t, disabled } : t)));
  return true;
}

/** Remove a schedule by id. Returns false if it wasn't there. */
export function deleteScheduledTask(id: string): boolean {
  const tasks = loadScheduledTasks();
  const next = tasks.filter((t) => t.id !== id);
  if (next.length === tasks.length) return false;
  persist(next);
  return true;
}

export function listScheduledTaskRecords(): ScheduledTaskRecord[] {
  return [...loadScheduledTasks()];
}

/** Test hook: point the store at a temp file and clear the cache. */
export function _setScheduledTasksPathForTests(path: string | null): void {
  _pathOverride = path;
  _cache = null;
}
