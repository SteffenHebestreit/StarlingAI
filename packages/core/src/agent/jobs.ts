/**
 * In-memory job store for async scene execution.
 *
 * POST /api/scenes/:name/run returns a jobId immediately;
 * the scene runs in the background.  Poll via
 * GET /api/scenes/jobs/:jobId until status is "completed" or "failed".
 *
 * Jobs are pruned after 1 hour to prevent unbounded growth.
 */
import { randomUUID } from "node:crypto";
import type { TurnPerformanceMetrics } from "./runtime.js";

export type JobStatus = "running" | "completed" | "failed";

export interface SceneJob {
  id: string;
  sceneName: string;
  sessionId: string;
  status: JobStatus;
  startedAt: string;
  completedAt?: string;
  response?: string;
  toolCallsExecuted?: number;
  blocked?: boolean;
  performance?: TurnPerformanceMetrics;
  error?: string;
}

const jobs = new Map<string, SceneJob>();

// Prune completed/failed jobs older than 1 hour
setInterval(() => {
  const cutoff = Date.now() - 3_600_000;
  for (const [id, job] of jobs) {
    if (job.status !== "running" && job.completedAt && new Date(job.completedAt).getTime() < cutoff) {
      jobs.delete(id);
    }
  }
}, 300_000).unref();

export function createJob(sceneName: string, sessionId: string): SceneJob {
  const job: SceneJob = {
    id: randomUUID(),
    sceneName,
    sessionId,
    status: "running",
    startedAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);
  return job;
}

export function completeJob(
  id: string,
  result: { response: string; toolCallsExecuted: number; blocked: boolean; performance?: TurnPerformanceMetrics }
): void {
  const job = jobs.get(id);
  if (!job) return;
  job.status = result.blocked ? "failed" : "completed";
  job.completedAt = new Date().toISOString();
  job.response = result.response;
  job.toolCallsExecuted = result.toolCallsExecuted;
  job.blocked = result.blocked;
  job.performance = result.performance;
}

export function failJob(id: string, error: string): void {
  const job = jobs.get(id);
  if (!job) return;
  job.status = "failed";
  job.completedAt = new Date().toISOString();
  job.error = error;
}

export function getJob(id: string): SceneJob | undefined {
  return jobs.get(id);
}
