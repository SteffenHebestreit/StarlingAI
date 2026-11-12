/**
 * Runtime side of the "standing agent" scheduler: turns a persisted
 * ScheduledTaskRecord into a live cron job whose tick runs the task as a REAL turn
 * (createJob, the same path config-defined cron triggers use), and rehydrates all
 * persisted schedules on boot so they survive a restart.
 *
 * A record with `at` instead of `cron` runs once, at that time: a timer, armed again at boot, and
 * run at once when its time passed while the gateway was down. Every run it queues names its
 * schedule (scheduleId), which is how the worker hands the result back (runtime/follow-up.ts).
 *
 * Split from the pure persistence store (scheduled-tasks.ts) so that module stays
 * dependency-free and unit-testable; this one wires in the scheduler + job runner.
 */
import { createCronJob, listCronJobs, removeCronJob } from "./scheduler.js";
import { createJob } from "../agent/jobs.js";
import { getConfig } from "../config/loader.js";
import {
  saveScheduledTask,
  deleteScheduledTask,
  disableScheduledTask,
  getScheduledTask,
  listScheduledTaskRecords,
  updateScheduledTask,
  type ScheduledTaskRecord,
} from "./scheduled-tasks.js";
import { sameAccountId } from "./accounts.js";
import { childLogger } from "../logger.js";

const log = childLogger("scheduled-task-runner");

// record id -> the ephemeral in-memory cron job id, so a remove stops the right job.
const _cronIdByRecord = new Map<string, string>();
// record id -> the timer of a one-shot that has not run yet.
const _timerByRecord = new Map<string, ReturnType<typeof setTimeout>>();
// record id -> when its queued run started: a schedule's next tick waits for the run before it.
const _runInFlightSince = new Map<string, number>();

/** setTimeout takes at most 2^31-1 ms, about 24.8 days: a later time is reached in hops. */
const MAX_TIMER_MS = 2_000_000_000;
/** A one-shot whose run could not be queued is tried again after this long. */
const ONE_SHOT_RETRY_MS = 60_000;
/** Past the turn's own time limit by this much, a run that never reported back no longer holds
 *  its schedule's next tick. */
const RUN_IN_FLIGHT_GRACE_MS = 120_000;

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

/**
 * Is the run this schedule queued before still out? Two runs of one watch at once would each post
 * the same news. Cleared when the run settles (scheduledRunSettled); a run that never does stops
 * counting once it is past the turn's time limit and a grace.
 */
function runStillInFlight(id: string): boolean {
  const since = _runInFlightSince.get(id);
  if (since === undefined) return false;
  if (Date.now() - since <= turnTimeoutMs() + RUN_IN_FLIGHT_GRACE_MS) return true;
  _runInFlightSince.delete(id);
  return false;
}

/** The run a schedule queued has ended, whichever way: its next tick may queue the next. */
export function scheduledRunSettled(id: string): void {
  _runInFlightSince.delete(id);
}

/**
 * Queue one run of the schedule as a real turn, as it is stored NOW: a schedule removed or disabled
 * since its cron job or timer was set runs nothing. Returns whether a run was queued; throws when
 * queuing itself failed.
 */
async function queueRun(id: string): Promise<boolean> {
  const rec = getScheduledTask(id);
  if (!rec || rec.disabled) return false;
  if (legacyScheduleSkipped(rec)) return false;
  if (runStillInFlight(id)) {
    log.warn({ scheduleId: id, label: rec.label }, "scheduled task skipped a tick: its previous run has not ended");
    return false;
  }
  _runInFlightSince.set(id, Date.now());
  try {
    const queued = await createJob({
      sceneName: rec.label,
      definitionType: "scene",
      task: rec.task,
      ...(rec.userId ? { userId: rec.userId } : {}),
      ...(rec.userId && rec.account ? { account: rec.account } : {}),
      ...(rec.userId && !rec.account && rec.principal ? { principal: rec.principal } : {}),
      turnTimeoutMs: turnTimeoutMs(),
      scheduleId: rec.id,
    });
    log.info({ scheduleId: rec.id, label: rec.label, queuedJobId: queued.id }, "scheduled task fired — queued a real turn");
    return true;
  } catch (err) {
    _runInFlightSince.delete(id);
    throw err;
  }
}

/** Run a one-shot whose time has come. Once: register arms no timer for one that was fired. */
async function fireOnce(id: string): Promise<void> {
  const rec = getScheduledTask(id);
  if (!rec || rec.disabled) return;
  // Marked before the run is queued: a crash between the two loses the run, the other order could
  // run it a second time after the restart.
  updateScheduledTask(id, { firedAt: new Date().toISOString() });
  try {
    if (!(await queueRun(id))) updateScheduledTask(id, { firedAt: undefined });
  } catch (err) {
    log.error({ err, scheduleId: id }, "one-shot scheduled task could not be queued — trying again");
    updateScheduledTask(id, { firedAt: undefined });
    armTimer(id, ONE_SHOT_RETRY_MS);
  }
}

function armTimer(id: string, waitMs: number): void {
  const previous = _timerByRecord.get(id);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(() => {
    _timerByRecord.delete(id);
    const due = Date.parse(getScheduledTask(id)?.at ?? "");
    // A hop on the way to a time further off than one timer reaches.
    if (Number.isFinite(due) && due - Date.now() > 0) {
      armTimer(id, due - Date.now());
      return;
    }
    void fireOnce(id);
  }, Math.min(Math.max(0, waitMs), MAX_TIMER_MS));
  timer.unref?.();
  _timerByRecord.set(id, timer);
}

/**
 * Register what runs a scheduled task as a real turn: a cron job for one that repeats, a timer for
 * one that runs once. A disabled schedule gets neither, nor does a one-shot whose run was already
 * queued (the job store finishes that run, or it is lost with the store). Returns whether it is
 * active now.
 */
function register(rec: ScheduledTaskRecord): boolean {
  if (rec.disabled) return false;
  if (rec.at !== undefined && !rec.cron) {
    if (rec.firedAt) return false;
    const due = Date.parse(rec.at);
    if (!Number.isFinite(due)) {
      log.error({ scheduleId: rec.id, at: rec.at }, "scheduled task has no readable time — not armed");
      return false;
    }
    // Overdue (its time passed while the gateway was down): now.
    armTimer(rec.id, due - Date.now());
    return true;
  }
  if (!rec.cron) return false;
  const job = createCronJob(rec.cron, rec.label, `scheduled task: ${rec.task}`, async () => {
    try {
      await queueRun(rec.id);
    } catch (err) {
      log.error({ err, scheduleId: rec.id }, "scheduled task run failed");
    }
  }, rec.timeZone ?? "UTC");
  _cronIdByRecord.set(rec.id, job.id);
  return true;
}

function unregister(id: string): void {
  const cronId = _cronIdByRecord.get(id);
  if (cronId) { removeCronJob(cronId); _cronIdByRecord.delete(id); }
  const timer = _timerByRecord.get(id);
  if (timer) { clearTimeout(timer); _timerByRecord.delete(id); }
}

/** The in-memory cron jobs that belong to scheduled tasks: a listing of triggers leaves them out,
 *  since each carries its owner's task text. */
export function scheduledTaskCronIds(): Set<string> {
  return new Set(_cronIdByRecord.values());
}

/** Create + persist + activate a scheduled task (replaces any existing one with the same id). */
export function addAndActivateScheduledTask(rec: ScheduledTaskRecord): void {
  unregister(rec.id);
  saveScheduledTask(rec);
  register(rec);
}

/** Stop + unpersist a scheduled task. Returns false if there was no such schedule. */
export function removeScheduledTask(id: string): boolean {
  unregister(id);
  _runInFlightSince.delete(id);
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
    unregister(rec.id);
    if (disableScheduledTask(rec.id, { at, reason })) disabled.push(rec.id);
  }
  if (disabled.length > 0) log.info({ account, count: disabled.length, reason }, "disabled the scheduled tasks of an ended account");
  return disabled;
}

/** When the schedule runs next, as far as the live scheduler knows: nothing for one that is
 *  disabled, not registered, or a one-shot whose run is already out. */
export function nextScheduledRun(rec: ScheduledTaskRecord): string | undefined {
  if (rec.disabled) return undefined;
  if (rec.at !== undefined && !rec.cron) return rec.firedAt ? undefined : rec.at;
  const cronId = _cronIdByRecord.get(rec.id);
  if (!cronId) return undefined;
  return listCronJobs().find((job) => job.id === cronId)?.nextFireAt ?? undefined;
}

/** Number of currently-active scheduled tasks. */
export function activeScheduledTaskCount(): number {
  return _cronIdByRecord.size + _timerByRecord.size;
}

/** Test hook: stop + forget all active schedules (does not touch the store). */
export function _resetScheduledTaskRuntimeForTests(): void {
  for (const cronId of _cronIdByRecord.values()) removeCronJob(cronId);
  _cronIdByRecord.clear();
  for (const timer of _timerByRecord.values()) clearTimeout(timer);
  _timerByRecord.clear();
  _runInFlightSince.clear();
  _legacySkipsLogged.clear();
}
