/**
 * Runtime side of the "standing agent" scheduler: turns a persisted
 * ScheduledTaskRecord into a live cron job whose tick runs the task as a REAL turn
 * (createJob, the same path config-defined cron triggers use), and rehydrates all
 * persisted schedules on boot so they survive a restart.
 *
 * Split from the pure persistence store (scheduled-tasks.ts) so that module stays
 * dependency-free and unit-testable; this one wires in the scheduler + job runner.
 */
import { createCronJob, removeCronJob } from "./scheduler.js";
import { createJob } from "../agent/jobs.js";
import { getConfig } from "../config/loader.js";
import {
  saveScheduledTask,
  deleteScheduledTask,
  listScheduledTaskRecords,
  type ScheduledTaskRecord,
} from "./scheduled-tasks.js";
import { childLogger } from "../logger.js";

const log = childLogger("scheduled-task-runner");

// record id -> the ephemeral in-memory cron job id, so a remove stops the right job.
const _cronIdByRecord = new Map<string, string>();

function turnTimeoutMs(): number {
  return getConfig().gateway?.turnTimeoutMs ?? 900_000;
}

/** Register the in-memory cron job that runs a scheduled task as a real turn. */
function register(rec: ScheduledTaskRecord): string {
  const job = createCronJob(rec.cron, rec.label, `scheduled task: ${rec.task}`, async () => {
    try {
      const queued = await createJob({
        sceneName: rec.label,
        definitionType: "scene",
        task: rec.task,
        ...(rec.userId ? { userId: rec.userId } : {}),
        turnTimeoutMs: turnTimeoutMs(),
      });
      log.info({ scheduleId: rec.id, label: rec.label, queuedJobId: queued.id }, "scheduled task fired — queued a real turn");
    } catch (err) {
      log.error({ err, scheduleId: rec.id }, "scheduled task run failed");
    }
  });
  _cronIdByRecord.set(rec.id, job.id);
  return job.id;
}

/** Create + persist + activate a scheduled task (replaces any existing one with the same id). */
export function addAndActivateScheduledTask(rec: ScheduledTaskRecord): void {
  const prev = _cronIdByRecord.get(rec.id);
  if (prev) removeCronJob(prev);
  saveScheduledTask(rec);
  register(rec);
}

/** Stop + unpersist a scheduled task. Returns false if there was no such schedule. */
export function removeScheduledTask(id: string): boolean {
  const cronId = _cronIdByRecord.get(id);
  if (cronId) { removeCronJob(cronId); _cronIdByRecord.delete(id); }
  return deleteScheduledTask(id);
}

/** Re-register all persisted schedules on boot (so they survive a restart). */
export function rehydrateScheduledTasks(): void {
  let n = 0;
  for (const rec of listScheduledTaskRecords()) {
    try { register(rec); n += 1; }
    catch (err) { log.error({ err, scheduleId: rec.id }, "failed to rehydrate scheduled task"); }
  }
  if (n > 0) log.info({ count: n }, "rehydrated scheduled tasks from disk");
}

/** Number of currently-active scheduled tasks. */
export function activeScheduledTaskCount(): number {
  return _cronIdByRecord.size;
}

/** Test hook: stop + forget all active schedules (does not touch the store). */
export function _resetScheduledTaskRuntimeForTests(): void {
  for (const cronId of _cronIdByRecord.values()) removeCronJob(cronId);
  _cronIdByRecord.clear();
}
