/**
 * In-memory cron scheduler — manages named CronJob instances.
 *
 * Jobs fire a turnless callback (typically writes a shared finding or
 * sends a channel message).  They are NOT persisted — a process restart
 * clears all scheduled jobs.
 */
import { CronJob } from "cron";
import { childLogger } from "../logger.js";

const log = childLogger("scheduler");

export interface ScheduledJob {
  id: string;
  label: string;
  expression: string;
  action: string;
  createdAt: Date;
  lastFiredAt: Date | null;
  fireCount: number;
}

interface InternalJob extends ScheduledJob {
  cron: CronJob;
  executing: boolean;
}

const _jobs = new Map<string, InternalJob>();

let _nextId = 1;

/**
 * Create a new cron job.
 * @param expression  Standard 5- or 6-field cron expression.
 * @param label       Human-readable label.
 * @param action      User-defined action description (stored for reference).
 * @param onTick      Callback invoked each time the job fires.
 * @returns The created job metadata.
 */
export function createCronJob(
  expression: string,
  label: string,
  action: string,
  onTick: () => void | Promise<void>,
): ScheduledJob {
  const id = `cron_${_nextId++}`;

  const jobMeta: InternalJob = {
    id,
    label,
    expression,
    action,
    createdAt: new Date(),
    lastFiredAt: null,
    fireCount: 0,
    executing: false,
    cron: null as unknown as CronJob, // will be set below
  };

  const cron = CronJob.from({
    cronTime: expression,
    onTick: async () => {
      if (jobMeta.executing) {
        log.warn({ id, label }, "cron job still executing, skipping tick");
        return;
      }
      jobMeta.executing = true;
      jobMeta.lastFiredAt = new Date();
      jobMeta.fireCount++;
      log.info({ id, label, fireCount: jobMeta.fireCount }, "cron job fired");
      try {
        await onTick();
      } catch (err) {
        log.error({ id, err }, "cron job callback failed");
      } finally {
        jobMeta.executing = false;
      }
    },
    start: true,
    timeZone: "UTC",
  });

  jobMeta.cron = cron;
  _jobs.set(id, jobMeta);
  log.info({ id, label, expression }, "cron job created");

  return toPublic(jobMeta);
}

/** Stop and remove a cron job by ID. */
export function removeCronJob(id: string): boolean {
  const job = _jobs.get(id);
  if (!job) return false;
  job.cron.stop();
  _jobs.delete(id);
  log.info({ id, label: job.label }, "cron job removed");
  return true;
}

/** List all active cron jobs. */
export function listCronJobs(): ScheduledJob[] {
  return [..._jobs.values()].map(toPublic);
}

/** Get a single job by ID. */
export function getCronJob(id: string): ScheduledJob | undefined {
  const job = _jobs.get(id);
  return job ? toPublic(job) : undefined;
}

/** Stop all cron jobs (e.g. on shutdown). */
export function stopAllCronJobs(): void {
  for (const job of _jobs.values()) {
    job.cron.stop();
  }
  _jobs.clear();
  log.info("all cron jobs stopped");
}

function toPublic(j: InternalJob): ScheduledJob {
  return {
    id: j.id,
    label: j.label,
    expression: j.expression,
    action: j.action,
    createdAt: j.createdAt,
    lastFiredAt: j.lastFiredAt,
    fireCount: j.fireCount,
  };
}
