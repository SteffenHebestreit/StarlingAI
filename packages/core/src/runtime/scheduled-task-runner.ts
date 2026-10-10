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
  disableScheduledTask,
  listScheduledTaskRecords,
  loadScheduledTasks,
  type ScheduledTaskRecord,
} from "./scheduled-tasks.js";
import { sameAccountId } from "./accounts.js";
import { childLogger } from "../logger.js";

const log = childLogger("scheduled-task-runner");

// record id -> the ephemeral in-memory cron job id, so a remove stops the right job.
const _cronIdByRecord = new Map<string, string>();

function turnTimeoutMs(): number {
  return getConfig().gateway?.turnTimeoutMs ?? 900_000;
}

// Legacy schedules already reported as skipped, so a schedule that fires every minute logs once.
const _legacySkipsLogged = new Set<string>();

/**
 * Under multi-user auth a schedule that names a user but neither an account nor a principal kind
 * was created before account ids existed. Its run would derive storage from the username alone,
 * which is the bucket an account kept before ids or the one a deleted account of that name left:
 * the derivation refuses it (runtime/user-scope.ts), and the job would fail every time it fires.
 * It is skipped instead, and logged once, until the account migration stamps it.
 */
function legacyScheduleSkipped(rec: ScheduledTaskRecord): boolean {
  let multiUser = true;
  try {
    multiUser = getConfig().auth?.enabled === true;
  } catch { /* fail closed */ }
  if (!multiUser || !rec.userId || rec.account || rec.principal) return false;
  if (!_legacySkipsLogged.has(rec.id)) {
    _legacySkipsLogged.add(rec.id);
    log.warn({ scheduleId: rec.id, label: rec.label }, "Scheduled task skipped: it predates account ids and runs again once the account migration stamps it");
  }
  return true;
}

/** Whether the stored schedule has been disabled since its cron job was registered. Disabling
 *  removes the job as well; this keeps a tick that was already due from running it. */
function disabledSinceRegistered(id: string): boolean {
  return loadScheduledTasks().some((stored) => stored.id === id && stored.disabled !== undefined);
}

/** Register the in-memory cron job that runs a scheduled task as a real turn. A disabled schedule
 *  gets none. */
function register(rec: ScheduledTaskRecord): string | undefined {
  if (rec.disabled) return undefined;
  const job = createCronJob(rec.cron, rec.label, `scheduled task: ${rec.task}`, async () => {
    if (disabledSinceRegistered(rec.id)) return;
    if (legacyScheduleSkipped(rec)) return;
    try {
      const queued = await createJob({
        sceneName: rec.label,
        definitionType: "scene",
        task: rec.task,
        ...(rec.userId ? { userId: rec.userId } : {}),
        ...(rec.userId && rec.account ? { account: rec.account } : {}),
        ...(rec.userId && !rec.account && rec.principal ? { principal: rec.principal } : {}),
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
  if (prev) { removeCronJob(prev); _cronIdByRecord.delete(rec.id); }
  saveScheduledTask(rec);
  register(rec);
}

/** Stop + unpersist a scheduled task. Returns false if there was no such schedule. */
export function removeScheduledTask(id: string): boolean {
  const cronId = _cronIdByRecord.get(id);
  if (cronId) { removeCronJob(cronId); _cronIdByRecord.delete(id); }
  return deleteScheduledTask(id);
}

/** Re-register all persisted schedules on boot (so they survive a restart). A disabled one stays
 *  stored and is not registered. */
export function rehydrateScheduledTasks(): void {
  let n = 0;
  for (const rec of listScheduledTaskRecords()) {
    try { if (register(rec)) n += 1; }
    catch (err) { log.error({ err, scheduleId: rec.id }, "failed to rehydrate scheduled task"); }
  }
  if (n > 0) log.info({ count: n }, "rehydrated scheduled tasks from disk");
}

/**
 * Disable every schedule of an account that was deleted or retired, and stop its cron jobs. Its
 * schedules kept firing: each run queued a turn as an account nobody can sign in as any more, in
 * storage nobody can reach. They are kept, disabled, with the reason (an admin can still read and
 * remove them), and are not registered again at the next boot. Returns the ids it disabled.
 */
export function disableAccountScheduledTasks(account: string, reason: string, at: string = new Date().toISOString()): string[] {
  const disabled: string[] = [];
  for (const rec of listScheduledTaskRecords()) {
    if (!rec.account || !sameAccountId(rec.account, account) || rec.disabled) continue;
    const cronId = _cronIdByRecord.get(rec.id);
    if (cronId) { removeCronJob(cronId); _cronIdByRecord.delete(rec.id); }
    if (disableScheduledTask(rec.id, { at, reason })) disabled.push(rec.id);
  }
  if (disabled.length > 0) log.info({ account, count: disabled.length, reason }, "disabled the scheduled tasks of an ended account");
  return disabled;
}

/** Number of currently-active scheduled tasks. */
export function activeScheduledTaskCount(): number {
  return _cronIdByRecord.size;
}

/** Test hook: stop + forget all active schedules (does not touch the store). */
export function _resetScheduledTaskRuntimeForTests(): void {
  for (const cronId of _cronIdByRecord.values()) removeCronJob(cronId);
  _cronIdByRecord.clear();
  _legacySkipsLogged.clear();
}
