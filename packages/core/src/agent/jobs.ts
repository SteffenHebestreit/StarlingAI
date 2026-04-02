import { randomUUID } from "node:crypto";
import pg from "pg";
import type { TurnPerformanceMetrics } from "./runtime.js";
import { childLogger } from "../logger.js";
import { publishNotification } from "../runtime/notifications.js";

const log = childLogger("agent:jobs");
const { Pool } = pg;
const STALE_JOB_MS = 120_000;

export type JobStatus = "queued" | "running" | "cancelling" | "cancelled" | "completed" | "failed";

export interface SceneJobProgress {
  stage: string;
  message?: string;
  percent?: number;
  totalSteps?: number;
  completedSteps?: number;
  currentStep?: string;
  toolCallsRequested: number;
  toolCallsCompleted: number;
  approvalsRequested: number;
  subAgentsStarted: number;
  swarmTasksTotal: number;
  swarmTasksCompleted: number;
  lastEventAt: string;
  lastEventType?: string;
  currentTool?: string;
  currentAgent?: string;
}

export interface SceneJob {
  id: string;
  sceneName: string;
  definitionType?: "scene" | "job";
  sessionId: string;
  userId?: string;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  response?: string;
  toolCallsExecuted?: number;
  blocked?: boolean;
  performance?: TurnPerformanceMetrics;
  error?: string;
  progress: SceneJobProgress;
}

export interface JobExecutionStep {
  sceneName: string;
  label: string;
  task: string;
  params?: Record<string, string>;
  allowedAgents?: string[];
  humanInLoopSteps?: string[];
  approvalChannel?: string;
}

export interface SceneJobPayload {
  definitionType?: "scene" | "job";
  task?: string;
  steps?: JobExecutionStep[];
  allowedAgents?: string[];
  humanInLoopSteps?: string[];
  approvalChannel?: string;
  params?: Record<string, string>;
  turnTimeoutMs: number;
}

export interface CreateSceneJobInput {
  sceneName: string;
  definitionType?: "scene" | "job";
  userId?: string;
  task?: string;
  steps?: JobExecutionStep[];
  allowedAgents?: string[];
  humanInLoopSteps?: string[];
  approvalChannel?: string;
  params?: Record<string, string>;
  turnTimeoutMs: number;
}

export interface ClaimedSceneJob extends SceneJob {
  payload: SceneJobPayload;
  claimedBy?: string;
  claimedAt?: string;
  heartbeatAt?: string;
  cancelRequestedAt?: string;
}

interface SceneJobStore {
  createJob(input: CreateSceneJobInput): Promise<SceneJob>;
  listJobs(opts?: { limit?: number; status?: JobStatus }): Promise<SceneJob[]>;
  getJob(id: string): Promise<SceneJob | undefined>;
  claimNextJob(workerId: string): Promise<ClaimedSceneJob | undefined>;
  updateProgress(id: string, patch: Partial<SceneJobProgress>): Promise<void>;
  heartbeatJob(id: string, workerId: string): Promise<void>;
  cancelJob(id: string): Promise<SceneJob | undefined>;
  markCancelled(id: string, reason: string): Promise<void>;
  completeJob(
    id: string,
    result: { response: string; toolCallsExecuted: number; blocked: boolean; performance?: TurnPerformanceMetrics }
  ): Promise<void>;
  failJob(id: string, error: string): Promise<void>;
  recoverStaleJobs(staleMs: number): Promise<number>;
  close(): Promise<void>;
  reset?(): Promise<void>;
}

interface StoredSceneJob extends SceneJob {
  payload: SceneJobPayload;
  claimedBy?: string;
  claimedAt?: string;
  heartbeatAt?: string;
  cancelRequestedAt?: string;
}

interface SceneJobRow {
  id: string;
  scene_name: string;
  definition_type: string | null;
  session_id: string;
  user_id: string | null;
  status: JobStatus;
  created_at: string | Date;
  started_at: string | Date | null;
  completed_at: string | Date | null;
  claimed_by: string | null;
  claimed_at: string | Date | null;
  heartbeat_at: string | Date | null;
  cancel_requested_at: string | Date | null;
  response: string | null;
  tool_calls_executed: number | null;
  blocked: boolean | null;
  error: string | null;
  performance: TurnPerformanceMetrics | null;
  progress: unknown;
  payload: unknown;
}

let _storePromise: Promise<SceneJobStore> | null = null;

export async function initSceneJobStore(): Promise<void> {
  await getStore();
}

export async function shutdownSceneJobStore(): Promise<void> {
  if (!_storePromise) return;
  const store = await _storePromise;
  await store.close();
  _storePromise = null;
}

export async function createJob(input: CreateSceneJobInput): Promise<SceneJob> {
  return (await getStore()).createJob(input);
}

export async function listJobs(opts?: { limit?: number; status?: JobStatus }): Promise<SceneJob[]> {
  return (await getStore()).listJobs(opts);
}

export async function getJob(id: string): Promise<SceneJob | undefined> {
  return (await getStore()).getJob(id);
}

export async function claimNextJob(workerId: string): Promise<ClaimedSceneJob | undefined> {
  return (await getStore()).claimNextJob(workerId);
}

export async function updateJobProgress(id: string, patch: Partial<SceneJobProgress>): Promise<void> {
  await (await getStore()).updateProgress(id, patch);
}

export async function heartbeatJob(id: string, workerId: string): Promise<void> {
  await (await getStore()).heartbeatJob(id, workerId);
}

export async function cancelJob(id: string): Promise<SceneJob | undefined> {
  const store = await getStore();
  const job = await store.cancelJob(id);
  if (job && (job.status === "cancelled" || job.status === "cancelling")) {
    publishNotification({
      title: job.status === "cancelled" ? "Job cancelled" : "Job cancellation requested",
      message: `${job.sceneName} ${job.status === "cancelled" ? "was cancelled" : "is being cancelled"}.`,
      level: "info",
      category: "job",
      sessionId: job.sessionId,
      jobId: job.id,
      targetPath: "/jobs",
      sticky: job.status === "cancelling",
    });
  }
  return job;
}

export async function markJobCancelled(id: string, reason: string): Promise<void> {
  const store = await getStore();
  await store.markCancelled(id, reason);
  const job = await store.getJob(id);
  if (job) {
    publishNotification({
      title: "Job cancelled",
      message: `${job.sceneName} was cancelled. ${reason}`,
      level: "warn",
      category: "job",
      sessionId: job.sessionId,
      jobId: job.id,
      targetPath: "/jobs",
      sticky: true,
    });
  }
}

export async function completeJob(
  id: string,
  result: { response: string; toolCallsExecuted: number; blocked: boolean; performance?: TurnPerformanceMetrics }
): Promise<void> {
  const store = await getStore();
  await store.completeJob(id, result);
  const job = await store.getJob(id);
  if (job) {
    publishNotification({
      title: result.blocked ? "Job blocked" : "Job completed",
      message: result.blocked
        ? `${job.sceneName} was blocked by guardrails.`
        : `${job.sceneName} finished successfully.`,
      level: result.blocked ? "warn" : "success",
      category: "job",
      sessionId: job.sessionId,
      jobId: job.id,
      targetPath: "/jobs",
      sticky: result.blocked,
    });
  }
}

export async function failJob(id: string, error: string): Promise<void> {
  const store = await getStore();
  await store.failJob(id, error);
  const job = await store.getJob(id);
  if (job) {
    publishNotification({
      title: "Job failed",
      message: `${job.sceneName} failed. ${error}`,
      level: "error",
      category: "job",
      sessionId: job.sessionId,
      jobId: job.id,
      targetPath: "/jobs",
      sticky: true,
    });
  }
}

export async function recoverStaleSceneJobs(staleMs = STALE_JOB_MS): Promise<number> {
  return (await getStore()).recoverStaleJobs(staleMs);
}

export async function resetJobsForTests(): Promise<void> {
  if (!_storePromise) return;
  const store = await _storePromise;
  if (store.reset) {
    await store.reset();
  }
  await store.close();
  _storePromise = null;
}

async function getStore(): Promise<SceneJobStore> {
  if (_storePromise) return _storePromise;
  _storePromise = (async () => {
    const url = process.env["DATABASE_URL"]?.trim();
    if (!url) return new InMemorySceneJobStore();
    const store = new PostgresSceneJobStore(url);
    await store.init();
    return store;
  })().catch(err => {
    _storePromise = null;
    throw err;
  });
  return _storePromise;
}

class InMemorySceneJobStore implements SceneJobStore {
  private readonly jobs = new Map<string, StoredSceneJob>();

  async createJob(input: CreateSceneJobInput): Promise<SceneJob> {
    this.pruneTerminalJobs();
    const createdAt = nowIso();
    const sessionId = randomUUID();
    const definitionType = input.definitionType ?? (input.steps?.length ? "job" : "scene");
    const job: StoredSceneJob = {
      id: randomUUID(),
      sceneName: input.sceneName,
      definitionType,
      sessionId,
      userId: input.userId,
      status: "queued",
      createdAt,
      progress: defaultProgress("queued", "Queued for worker execution"),
      payload: {
        definitionType,
        task: input.task,
        steps: input.steps,
        allowedAgents: input.allowedAgents,
        humanInLoopSteps: input.humanInLoopSteps,
        approvalChannel: input.approvalChannel,
        params: input.params,
        turnTimeoutMs: input.turnTimeoutMs,
      },
    };
    this.jobs.set(job.id, job);
    return toPublicJob(job);
  }

  async listJobs(opts?: { limit?: number; status?: JobStatus }): Promise<SceneJob[]> {
    this.pruneTerminalJobs();
    const limit = normalizeListLimit(opts?.limit);
    return [...this.jobs.values()]
      .filter((job) => !opts?.status || job.status === opts.status)
      .sort((left, right) => (right.completedAt ?? right.startedAt ?? right.createdAt).localeCompare(left.completedAt ?? left.startedAt ?? left.createdAt))
      .slice(0, limit)
      .map((job) => toPublicJob(job));
  }

  async getJob(id: string): Promise<SceneJob | undefined> {
    this.pruneTerminalJobs();
    const job = this.jobs.get(id);
    return job ? toPublicJob(job) : undefined;
  }

  async claimNextJob(workerId: string): Promise<ClaimedSceneJob | undefined> {
    this.pruneTerminalJobs();
    const next = [...this.jobs.values()]
      .filter(job => job.status === "queued")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
    if (!next) return undefined;
    const claimedAt = nowIso();
    next.status = "running";
    next.startedAt = next.startedAt ?? claimedAt;
    next.claimedBy = workerId;
    next.claimedAt = claimedAt;
    next.heartbeatAt = claimedAt;
    next.progress = mergeProgress(next.progress, {
      stage: "running",
      message: "Worker claimed job",
      percent: Math.max(next.progress.percent ?? 0, 5),
      lastEventAt: claimedAt,
      lastEventType: "job_claimed",
    }, next.status);
    return structuredClone(next);
  }

  async updateProgress(id: string, patch: Partial<SceneJobProgress>): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    job.progress = mergeProgress(job.progress, patch, job.status);
  }

  async heartbeatJob(id: string, workerId: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job || job.claimedBy !== workerId || job.status !== "running") return;
    job.heartbeatAt = nowIso();
  }

  async cancelJob(id: string): Promise<SceneJob | undefined> {
    const job = this.jobs.get(id);
    if (!job) return undefined;

    if (job.status === "queued") {
      const completedAt = nowIso();
      job.status = "cancelled";
      job.completedAt = completedAt;
      job.cancelRequestedAt = completedAt;
      job.error = "Scene job cancelled before execution";
      job.progress = mergeProgress(job.progress, {
        stage: "cancelled",
        message: "Scene job cancelled before worker execution",
        percent: 100,
        lastEventAt: completedAt,
        lastEventType: "job_cancelled",
      }, job.status);
      return toPublicJob(job);
    }

    if (job.status === "running") {
      const cancelRequestedAt = nowIso();
      job.status = "cancelling";
      job.cancelRequestedAt = cancelRequestedAt;
      job.progress = mergeProgress(job.progress, {
        stage: "cancelling",
        message: "Cancellation requested",
        lastEventAt: cancelRequestedAt,
        lastEventType: "job_cancelling",
      }, job.status);
    }

    return toPublicJob(job);
  }

  async markCancelled(id: string, reason: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    const completedAt = nowIso();
    job.status = "cancelled";
    job.completedAt = completedAt;
    job.error = reason;
    job.progress = mergeProgress(job.progress, {
      stage: "cancelled",
      message: reason,
      percent: 100,
      lastEventAt: completedAt,
      lastEventType: "job_cancelled",
    }, job.status);
  }

  async completeJob(
    id: string,
    result: { response: string; toolCallsExecuted: number; blocked: boolean; performance?: TurnPerformanceMetrics }
  ): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    const completedAt = nowIso();
    job.status = result.blocked ? "failed" : "completed";
    job.completedAt = completedAt;
    job.response = result.response;
    job.toolCallsExecuted = result.toolCallsExecuted;
    job.blocked = result.blocked;
    job.performance = result.performance;
    job.error = result.blocked ? "Scene job was blocked by guardrails" : undefined;
    job.progress = mergeProgress(job.progress, {
      stage: result.blocked ? "failed" : "completed",
      message: result.blocked ? "Scene job blocked by guardrails" : "Scene job completed",
      percent: 100,
      lastEventAt: completedAt,
      lastEventType: result.blocked ? "job_failed" : "job_completed",
    }, job.status);
  }

  async failJob(id: string, error: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    const completedAt = nowIso();
    job.status = "failed";
    job.completedAt = completedAt;
    job.error = error;
    job.progress = mergeProgress(job.progress, {
      stage: "failed",
      message: error,
      percent: 100,
      lastEventAt: completedAt,
      lastEventType: "job_failed",
    }, job.status);
  }

  async recoverStaleJobs(): Promise<number> {
    return 0;
  }

  async close(): Promise<void> {
    this.jobs.clear();
  }

  async reset(): Promise<void> {
    this.jobs.clear();
  }

  private pruneTerminalJobs(): void {
    const cutoff = Date.now() - 12 * 60 * 60 * 1000;
    for (const [id, job] of this.jobs) {
      if ((job.status === "completed" || job.status === "failed" || job.status === "cancelled")
        && job.completedAt
        && new Date(job.completedAt).getTime() < cutoff) {
        this.jobs.delete(id);
      }
    }
  }
}

class PostgresSceneJobStore implements SceneJobStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 5 });
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS scene_jobs (
        id                  UUID PRIMARY KEY,
        scene_name          TEXT NOT NULL,
        definition_type     TEXT,
        session_id          TEXT NOT NULL,
        user_id             TEXT,
        status              TEXT NOT NULL,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at          TIMESTAMPTZ,
        completed_at        TIMESTAMPTZ,
        claimed_by          TEXT,
        claimed_at          TIMESTAMPTZ,
        heartbeat_at        TIMESTAMPTZ,
        cancel_requested_at TIMESTAMPTZ,
        response            TEXT,
        tool_calls_executed INTEGER,
        blocked             BOOLEAN,
        error               TEXT,
        performance         JSONB,
        progress            JSONB NOT NULL DEFAULT '{}'::jsonb,
        payload             JSONB NOT NULL DEFAULT '{}'::jsonb
      );
      CREATE INDEX IF NOT EXISTS idx_scene_jobs_status_created ON scene_jobs (status, created_at);
      CREATE INDEX IF NOT EXISTS idx_scene_jobs_session ON scene_jobs (session_id);
      CREATE INDEX IF NOT EXISTS idx_scene_jobs_heartbeat ON scene_jobs (heartbeat_at);
    `);
    await this.pool.query(`ALTER TABLE scene_jobs ADD COLUMN IF NOT EXISTS definition_type TEXT`);
    await this.recoverStaleJobs(STALE_JOB_MS);
    log.info("Scene job table ready");
  }

  async createJob(input: CreateSceneJobInput): Promise<SceneJob> {
    const id = randomUUID();
    const sessionId = randomUUID();
    const createdAt = nowIso();
    const progress = defaultProgress("queued", "Queued for worker execution");
    const definitionType = input.definitionType ?? (input.steps?.length ? "job" : "scene");
    const payload: SceneJobPayload = {
      definitionType,
      task: input.task,
      steps: input.steps,
      allowedAgents: input.allowedAgents,
      humanInLoopSteps: input.humanInLoopSteps,
      approvalChannel: input.approvalChannel,
      params: input.params,
      turnTimeoutMs: input.turnTimeoutMs,
    };

    await this.pool.query(
      `INSERT INTO scene_jobs (
         id, scene_name, definition_type, session_id, user_id, status, created_at, progress, payload
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)`,
      [id, input.sceneName, definitionType, sessionId, input.userId ?? null, "queued", createdAt, JSON.stringify(progress), JSON.stringify(payload)]
    );

    return {
      id,
      sceneName: input.sceneName,
      definitionType,
      sessionId,
      userId: input.userId,
      status: "queued",
      createdAt,
      progress,
    };
  }

  async listJobs(opts?: { limit?: number; status?: JobStatus }): Promise<SceneJob[]> {
    const limit = normalizeListLimit(opts?.limit);
    const values: Array<JobStatus | number> = [];
    const where = opts?.status
      ? (() => {
          values.push(opts.status);
          return `WHERE status = $${values.length}`;
        })()
      : "";
    values.push(limit);
    const limitParam = `$${values.length}`;

    const result = await this.pool.query<SceneJobRow>(
      `SELECT *
       FROM scene_jobs
       ${where}
       ORDER BY COALESCE(completed_at, started_at, created_at) DESC
       LIMIT ${limitParam}`,
      values,
    );

    return result.rows.map((row) => toPublicJob(this.rowToStoredJob(row)));
  }

  async getJob(id: string): Promise<SceneJob | undefined> {
    const row = await this.getStoredJob(id);
    return row ? toPublicJob(row) : undefined;
  }

  async claimNextJob(workerId: string): Promise<ClaimedSceneJob | undefined> {
    const claimedAt = nowIso();
    const result = await this.pool.query<SceneJobRow>(
      `WITH next_job AS (
         SELECT id
         FROM scene_jobs
         WHERE status = 'queued'
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE scene_jobs AS jobs
       SET status = 'running',
           started_at = COALESCE(jobs.started_at, $2::timestamptz),
           claimed_by = $1,
           claimed_at = $2::timestamptz,
           heartbeat_at = $2::timestamptz,
           progress = COALESCE(jobs.progress, '{}'::jsonb) || $3::jsonb
       FROM next_job
       WHERE jobs.id = next_job.id
       RETURNING jobs.*`,
      [
        workerId,
        claimedAt,
        JSON.stringify({
          stage: "running",
          message: "Worker claimed job",
          percent: 5,
          lastEventAt: claimedAt,
          lastEventType: "job_claimed",
        }),
      ]
    );

    const row = result.rows[0];
    return row ? this.rowToStoredJob(row) : undefined;
  }

  async updateProgress(id: string, patch: Partial<SceneJobProgress>): Promise<void> {
    const job = await this.getStoredJob(id);
    if (!job) return;
    const progress = mergeProgress(job.progress, patch, job.status);
    await this.pool.query(
      `UPDATE scene_jobs
       SET progress = $2::jsonb
       WHERE id = $1`,
      [id, JSON.stringify(progress)]
    );
  }

  async heartbeatJob(id: string, workerId: string): Promise<void> {
    await this.pool.query(
      `UPDATE scene_jobs
       SET heartbeat_at = NOW()
       WHERE id = $1 AND claimed_by = $2 AND status = 'running'`,
      [id, workerId]
    );
  }

  async cancelJob(id: string): Promise<SceneJob | undefined> {
    const job = await this.getStoredJob(id);
    if (!job) return undefined;

    if (job.status === "queued") {
      const completedAt = nowIso();
      const progress = mergeProgress(job.progress, {
        stage: "cancelled",
        message: "Scene job cancelled before worker execution",
        percent: 100,
        lastEventAt: completedAt,
        lastEventType: "job_cancelled",
      }, "cancelled");
      await this.pool.query(
        `UPDATE scene_jobs
         SET status = 'cancelled',
             completed_at = $2::timestamptz,
             cancel_requested_at = $2::timestamptz,
             error = $3,
             progress = $4::jsonb
         WHERE id = $1`,
        [id, completedAt, "Scene job cancelled before execution", JSON.stringify(progress)]
      );
      return { ...toPublicJob(job), status: "cancelled", completedAt, error: "Scene job cancelled before execution", progress };
    }

    if (job.status === "running") {
      const cancelRequestedAt = nowIso();
      const progress = mergeProgress(job.progress, {
        stage: "cancelling",
        message: "Cancellation requested",
        lastEventAt: cancelRequestedAt,
        lastEventType: "job_cancelling",
      }, "cancelling");
      await this.pool.query(
        `UPDATE scene_jobs
         SET status = 'cancelling',
             cancel_requested_at = $2::timestamptz,
             progress = $3::jsonb
         WHERE id = $1`,
        [id, cancelRequestedAt, JSON.stringify(progress)]
      );
      return { ...toPublicJob(job), status: "cancelling", progress };
    }

    return toPublicJob(job);
  }

  async markCancelled(id: string, reason: string): Promise<void> {
    const job = await this.getStoredJob(id);
    if (!job) return;
    const completedAt = nowIso();
    const progress = mergeProgress(job.progress, {
      stage: "cancelled",
      message: reason,
      percent: 100,
      lastEventAt: completedAt,
      lastEventType: "job_cancelled",
    }, "cancelled");
    await this.pool.query(
      `UPDATE scene_jobs
       SET status = 'cancelled',
           completed_at = $2::timestamptz,
           error = $3,
           progress = $4::jsonb
       WHERE id = $1`,
      [id, completedAt, reason, JSON.stringify(progress)]
    );
  }

  async completeJob(
    id: string,
    result: { response: string; toolCallsExecuted: number; blocked: boolean; performance?: TurnPerformanceMetrics }
  ): Promise<void> {
    const completedAt = nowIso();
    const status: JobStatus = result.blocked ? "failed" : "completed";
    const current = await this.getStoredJob(id);
    const progress = mergeProgress(current?.progress ?? defaultProgress(status), {
      stage: result.blocked ? "failed" : "completed",
      message: result.blocked ? "Scene job blocked by guardrails" : "Scene job completed",
      percent: 100,
      lastEventAt: completedAt,
      lastEventType: result.blocked ? "job_failed" : "job_completed",
    }, status);
    await this.pool.query(
      `UPDATE scene_jobs
       SET status = $2,
           completed_at = $3::timestamptz,
           response = $4,
           tool_calls_executed = $5,
           blocked = $6,
           performance = $7::jsonb,
           error = $8,
           progress = $9::jsonb
       WHERE id = $1`,
      [
        id,
        status,
        completedAt,
        result.response,
        result.toolCallsExecuted,
        result.blocked,
        result.performance ? JSON.stringify(result.performance) : null,
        result.blocked ? "Scene job was blocked by guardrails" : null,
        JSON.stringify(progress),
      ]
    );
  }

  async failJob(id: string, error: string): Promise<void> {
    const completedAt = nowIso();
    const current = await this.getStoredJob(id);
    const progress = mergeProgress(current?.progress ?? defaultProgress("failed"), {
      stage: "failed",
      message: error,
      percent: 100,
      lastEventAt: completedAt,
      lastEventType: "job_failed",
    }, "failed");
    await this.pool.query(
      `UPDATE scene_jobs
       SET status = 'failed',
           completed_at = $2::timestamptz,
           error = $3,
           progress = $4::jsonb
       WHERE id = $1`,
      [id, completedAt, error, JSON.stringify(progress)]
    );
  }

  async recoverStaleJobs(staleMs: number): Promise<number> {
    const staleIntervalSeconds = Math.max(1, Math.ceil(staleMs / 1000));
    const recoveredRunning = await this.pool.query(
      `UPDATE scene_jobs
       SET status = 'queued',
           claimed_by = NULL,
           claimed_at = NULL,
           heartbeat_at = NULL,
           progress = COALESCE(progress, '{}'::jsonb) || $2::jsonb
       WHERE status = 'running'
         AND heartbeat_at IS NOT NULL
         AND heartbeat_at < NOW() - ($1 * INTERVAL '1 second')`,
      [staleIntervalSeconds, JSON.stringify({ message: "Recovered stale worker lease", stage: "queued", lastEventAt: nowIso(), lastEventType: "job_recovered" })]
    );
    const recoveredCancelling = await this.pool.query(
      `UPDATE scene_jobs
       SET status = 'cancelled',
           completed_at = NOW(),
           heartbeat_at = NULL,
           claimed_by = NULL,
           claimed_at = NULL,
           error = COALESCE(error, 'Scene job cancelled during worker recovery'),
           progress = COALESCE(progress, '{}'::jsonb) || $2::jsonb
       WHERE status = 'cancelling'
         AND heartbeat_at IS NOT NULL
         AND heartbeat_at < NOW() - ($1 * INTERVAL '1 second')`,
      [staleIntervalSeconds, JSON.stringify({ message: "Scene job cancelled during worker recovery", stage: "cancelled", percent: 100, lastEventAt: nowIso(), lastEventType: "job_cancelled" })]
    );
    return (recoveredRunning.rowCount ?? 0) + (recoveredCancelling.rowCount ?? 0);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async getStoredJob(id: string): Promise<StoredSceneJob | undefined> {
    const result = await this.pool.query<SceneJobRow>(`SELECT * FROM scene_jobs WHERE id = $1`, [id]);
    const row = result.rows[0];
    return row ? this.rowToStoredJob(row) : undefined;
  }

  private rowToStoredJob(row: SceneJobRow): StoredSceneJob {
    const status = row.status;
    return {
      id: row.id,
      sceneName: row.scene_name,
      definitionType: row.definition_type === "job" ? "job" : "scene",
      sessionId: row.session_id,
      userId: row.user_id ?? undefined,
      status,
      createdAt: toIso(row.created_at) ?? nowIso(),
      startedAt: toIso(row.started_at),
      completedAt: toIso(row.completed_at),
      response: row.response ?? undefined,
      toolCallsExecuted: typeof row.tool_calls_executed === "number" ? row.tool_calls_executed : undefined,
      blocked: typeof row.blocked === "boolean" ? row.blocked : undefined,
      performance: row.performance ?? undefined,
      error: row.error ?? undefined,
      progress: normalizeProgress(row.progress, status),
      payload: normalizePayload(row.payload),
      claimedBy: row.claimed_by ?? undefined,
      claimedAt: toIso(row.claimed_at),
      heartbeatAt: toIso(row.heartbeat_at),
      cancelRequestedAt: toIso(row.cancel_requested_at),
    };
  }
}

function normalizePayload(value: unknown): SceneJobPayload {
  if (!value || typeof value !== "object") {
    return { definitionType: "scene", task: "", turnTimeoutMs: 900_000 };
  }
  const payload = value as Record<string, unknown>;
  return {
    definitionType: payload.definitionType === "job" ? "job" : "scene",
    task: typeof payload.task === "string" ? payload.task : "",
    steps: Array.isArray(payload.steps)
      ? payload.steps.flatMap((step): JobExecutionStep[] => {
          if (!step || typeof step !== "object") return [];
          const value = step as Record<string, unknown>;
          if (typeof value.sceneName !== "string" || typeof value.label !== "string" || typeof value.task !== "string") return [];
          return [{
            sceneName: value.sceneName,
            label: value.label,
            task: value.task,
            params: typeof value.params === "object" && value.params !== null
              ? Object.fromEntries(Object.entries(value.params as Record<string, unknown>).map(([key, entry]) => [key, String(entry)]))
              : undefined,
            allowedAgents: Array.isArray(value.allowedAgents) ? value.allowedAgents.filter((entry): entry is string => typeof entry === "string") : undefined,
            humanInLoopSteps: Array.isArray(value.humanInLoopSteps) ? value.humanInLoopSteps.filter((entry): entry is string => typeof entry === "string") : undefined,
            approvalChannel: typeof value.approvalChannel === "string" ? value.approvalChannel : undefined,
          }];
        })
      : undefined,
    allowedAgents: Array.isArray(payload.allowedAgents) ? payload.allowedAgents.filter((entry): entry is string => typeof entry === "string") : undefined,
    humanInLoopSteps: Array.isArray(payload.humanInLoopSteps) ? payload.humanInLoopSteps.filter((entry): entry is string => typeof entry === "string") : undefined,
    approvalChannel: typeof payload.approvalChannel === "string" ? payload.approvalChannel : undefined,
    params: typeof payload.params === "object" && payload.params !== null
      ? Object.fromEntries(Object.entries(payload.params as Record<string, unknown>).map(([key, entry]) => [key, String(entry)]))
      : undefined,
    turnTimeoutMs: typeof payload.turnTimeoutMs === "number" && Number.isFinite(payload.turnTimeoutMs) ? payload.turnTimeoutMs : 900_000,
  };
}

function defaultProgress(status: JobStatus, message?: string): SceneJobProgress {
  const lastEventAt = nowIso();
  return {
    stage: status,
    message,
    percent: status === "completed" || status === "cancelled" || status === "failed" ? 100 : 0,
    totalSteps: 0,
    completedSteps: 0,
    toolCallsRequested: 0,
    toolCallsCompleted: 0,
    approvalsRequested: 0,
    subAgentsStarted: 0,
    swarmTasksTotal: 0,
    swarmTasksCompleted: 0,
    lastEventAt,
  };
}

function normalizeProgress(value: unknown, status: JobStatus): SceneJobProgress {
  const base = defaultProgress(status);
  if (!value || typeof value !== "object") return base;
  const progress = value as Record<string, unknown>;
  return {
    stage: typeof progress.stage === "string" ? progress.stage : base.stage,
    message: typeof progress.message === "string" ? progress.message : base.message,
    percent: clampPercent(progress.percent, base.percent),
    totalSteps: toCount(progress.totalSteps),
    completedSteps: toCount(progress.completedSteps),
    currentStep: typeof progress.currentStep === "string" ? progress.currentStep : undefined,
    toolCallsRequested: toCount(progress.toolCallsRequested),
    toolCallsCompleted: toCount(progress.toolCallsCompleted),
    approvalsRequested: toCount(progress.approvalsRequested),
    subAgentsStarted: toCount(progress.subAgentsStarted),
    swarmTasksTotal: toCount(progress.swarmTasksTotal),
    swarmTasksCompleted: toCount(progress.swarmTasksCompleted),
    lastEventAt: typeof progress.lastEventAt === "string" ? progress.lastEventAt : base.lastEventAt,
    lastEventType: typeof progress.lastEventType === "string" ? progress.lastEventType : undefined,
    currentTool: typeof progress.currentTool === "string" ? progress.currentTool : undefined,
    currentAgent: typeof progress.currentAgent === "string" ? progress.currentAgent : undefined,
  };
}

function mergeProgress(current: SceneJobProgress, patch: Partial<SceneJobProgress>, status: JobStatus): SceneJobProgress {
  const merged: SceneJobProgress = {
    ...current,
    ...patch,
    totalSteps: patch.totalSteps ?? current.totalSteps,
    completedSteps: patch.completedSteps ?? current.completedSteps,
    currentStep: patch.currentStep ?? current.currentStep,
    toolCallsRequested: patch.toolCallsRequested ?? current.toolCallsRequested,
    toolCallsCompleted: patch.toolCallsCompleted ?? current.toolCallsCompleted,
    approvalsRequested: patch.approvalsRequested ?? current.approvalsRequested,
    subAgentsStarted: patch.subAgentsStarted ?? current.subAgentsStarted,
    swarmTasksTotal: patch.swarmTasksTotal ?? current.swarmTasksTotal,
    swarmTasksCompleted: patch.swarmTasksCompleted ?? current.swarmTasksCompleted,
    lastEventAt: patch.lastEventAt ?? current.lastEventAt ?? nowIso(),
  };

  if (status === "completed" || status === "failed" || status === "cancelled") {
    merged.percent = 100;
  } else {
    merged.percent = clampPercent(merged.percent, derivePercent(merged, status));
  }

  return merged;
}

function derivePercent(progress: SceneJobProgress, status: JobStatus): number {
  if (status === "queued") return 0;
  if ((progress.totalSteps ?? 0) > 0) {
    const completedRatio = (progress.completedSteps ?? 0) / Math.max(1, progress.totalSteps ?? 0);
    return Math.max(5, Math.min(95, Math.round(5 + completedRatio * 75)));
  }
  if (progress.swarmTasksTotal > 0) {
    return Math.max(5, Math.min(95, Math.round((progress.swarmTasksCompleted / progress.swarmTasksTotal) * 100)));
  }
  if (progress.toolCallsRequested > 0) {
    const completedRatio = progress.toolCallsCompleted / Math.max(1, progress.toolCallsRequested);
    return Math.max(10, Math.min(95, Math.round(10 + completedRatio * 70)));
  }
  return status === "running" ? 5 : 0;
}

function clampPercent(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function toCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function toIso(value: string | Date | null | undefined): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeListLimit(value: number | undefined): number {
  if (!Number.isFinite(value) || !value) return 50;
  return Math.max(1, Math.min(200, Math.trunc(value)));
}

function toPublicJob(job: StoredSceneJob): SceneJob {
  return {
    id: job.id,
    sceneName: job.sceneName,
    definitionType: job.definitionType,
    sessionId: job.sessionId,
    userId: job.userId,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    response: job.response,
    toolCallsExecuted: job.toolCallsExecuted,
    blocked: job.blocked,
    performance: job.performance,
    error: job.error,
    progress: structuredClone(job.progress),
  };
}
