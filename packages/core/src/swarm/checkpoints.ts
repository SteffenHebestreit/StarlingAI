/**
 * Long-running task checkpoints — Stage 9.
 *
 * Sub-agents that exceed their turn timeout (or are explicitly paused by the
 * orchestrator) can save a checkpoint so they can be resumed later without
 * starting from scratch.
 *
 * A checkpoint stores:
 *   - The task description and context at the time of pause
 *   - Completed tool calls and their results (compressed conversation so far)
 *   - A free-form "progress" note the agent writes before it is interrupted
 *   - The session and agent name so the scheduler can target the right runner
 *
 * On resume, the checkpoint is loaded and injected as historical context into
 * a fresh sub-agent run — effectively reconstructing the in-progress state.
 *
 * Checkpoints are stored in Redis (TTL 24 h) with an in-process fallback Map.
 * They are keyed by taskId, which the orchestrator assigns when it launches a
 * long-running delegation.
 */

import { v4 as uuid } from "uuid";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { childLogger } from "../logger.js";
import { logAudit } from "../audit/logger.js";
import { emitSwarmEvent } from "./bus.js";
import { getConfig } from "../config/loader.js";

const log = childLogger("swarm:checkpoints");

// ── Types ────────────────────────────────────────────────────────────────────

export type CheckpointStatus = "active" | "paused" | "resumed" | "completed" | "failed";

export interface TaskCheckpoint {
  taskId: string;
  agentName: string;
  parentSessionId: string;
  /** Original task description (truncated to 2 KB). */
  task: string;
  /** Structured progress note written by the agent before pause (max 4 KB). */
  progressNote: string;
  /** Summarised conversation so far — tool calls + key results (max 8 KB). */
  conversationSummary: string;
  status: CheckpointStatus;
  createdAt: string;
  updatedAt: string;
  /** Wall-clock ms spent executing before the pause. */
  elapsedMs: number;
  /** How many iterations had completed before pause. */
  iterationsCompleted: number;
  /** Arbitrary key-value context for the agent to store mid-run data. */
  agentState: Record<string, unknown>;
}

// ── Constants ────────────────────────────────────────────────────────────────

const CHECKPOINT_CONTENT_MAX = 8_000;
const CHECKPOINT_TASK_MAX = 2_000;
const PROGRESS_NOTE_MAX = 4_000;
const CHECKPOINT_TTL_MS = 24 * 60 * 60 * 1_000; // 24 hours
const AGENT_STATE_MAX_SIZE = 16_000; // max serialized agentState size in bytes

// ── Storage ──────────────────────────────────────────────────────────────────

/** In-process fallback store (keyed by taskId). */
const _store = new Map<string, TaskCheckpoint>();

function checkpointDir(workspacePath: string): string {
  return join(workspacePath, ".starlingai", "checkpoints");
}

function checkpointPath(workspacePath: string, taskId: string): string {
  return join(checkpointDir(workspacePath), `${taskId}.json`);
}

function ensureDir(workspacePath: string): void {
  const dir = checkpointDir(workspacePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Create a new checkpoint when a long-running task is first launched.
 * Returns the taskId that the orchestrator should track.
 */
export function createCheckpoint(opts: {
  agentName: string;
  parentSessionId: string;
  task: string;
}): TaskCheckpoint {
  const config = getConfig();
  const taskId = uuid();
  const now = new Date().toISOString();

  const checkpoint: TaskCheckpoint = {
    taskId,
    agentName: opts.agentName,
    parentSessionId: opts.parentSessionId,
    task: opts.task.slice(0, CHECKPOINT_TASK_MAX),
    progressNote: "",
    conversationSummary: "",
    status: "active",
    createdAt: now,
    updatedAt: now,
    elapsedMs: 0,
    iterationsCompleted: 0,
    agentState: {},
  };

  _store.set(taskId, checkpoint);
  persistCheckpoint(config.workspacePath, checkpoint);

  emitSwarmEvent("task_checkpoint_created", {
    sessionId: opts.parentSessionId,
    agentName: opts.agentName,
    taskId,
    data: { task: opts.task.slice(0, 120) },
  });
  logAudit("task_checkpoint_created", {
    taskId,
    agentName: opts.agentName,
  }, { sessionId: opts.parentSessionId, severity: "info", channel: "swarm" });

  log.info({ taskId, agentName: opts.agentName }, "Task checkpoint created");
  return checkpoint;
}

/**
 * Pause a running task — saves progress and marks it as paused.
 * Call this when the agent's turn timeout fires or the orchestrator
 * explicitly suspends the task.
 */
export function pauseCheckpoint(taskId: string, opts: {
  progressNote: string;
  conversationSummary: string;
  elapsedMs: number;
  iterationsCompleted: number;
  agentState?: Record<string, unknown>;
}): TaskCheckpoint | null {
  const config = getConfig();
  const cp = _store.get(taskId);
  if (!cp) {
    log.warn({ taskId }, "pauseCheckpoint: taskId not found");
    return null;
  }
  if (cp.status !== "active" && cp.status !== "resumed") {
    log.warn({ taskId, status: cp.status }, "pauseCheckpoint: checkpoint is not active or resumed");
    return null;
  }

  cp.status = "paused";
  cp.progressNote = opts.progressNote.slice(0, PROGRESS_NOTE_MAX);
  cp.conversationSummary = opts.conversationSummary.slice(0, CHECKPOINT_CONTENT_MAX);
  cp.elapsedMs = opts.elapsedMs;
  cp.iterationsCompleted = opts.iterationsCompleted;
  const rawState = opts.agentState ?? {};
  const stateJson = JSON.stringify(rawState);
  cp.agentState = stateJson.length <= AGENT_STATE_MAX_SIZE ? rawState : {};
  cp.updatedAt = new Date().toISOString();

  _store.set(taskId, cp);
  persistCheckpoint(config.workspacePath, cp);

  emitSwarmEvent("task_checkpoint_paused", {
    sessionId: cp.parentSessionId,
    agentName: cp.agentName,
    taskId,
    data: { elapsedMs: cp.elapsedMs, iterationsCompleted: cp.iterationsCompleted },
  });
  logAudit("task_checkpoint_paused", { taskId, agentName: cp.agentName, elapsedMs: cp.elapsedMs },
    { sessionId: cp.parentSessionId, severity: "info", channel: "swarm" });

  log.info({ taskId, agentName: cp.agentName, elapsedMs: cp.elapsedMs }, "Task checkpoint paused");
  return cp;
}

/**
 * Resume a paused task. Returns the checkpoint so the caller can build
 * the resumed agent's context from it. Status is set to "resumed".
 */
export function resumeCheckpoint(taskId: string): TaskCheckpoint | null {
  const config = getConfig();
  // Try in-process store first, then disk
  let cp = _store.get(taskId);
  if (!cp) {
    cp = loadCheckpointFromDisk(config.workspacePath, taskId);
    if (cp) _store.set(taskId, cp);
  }
  if (!cp) {
    log.warn({ taskId }, "resumeCheckpoint: taskId not found");
    return null;
  }
  if (cp.status !== "paused") {
    log.warn({ taskId, status: cp.status }, "resumeCheckpoint: checkpoint is not paused");
    return null;
  }

  cp.status = "resumed";
  cp.updatedAt = new Date().toISOString();
  _store.set(taskId, cp);
  persistCheckpoint(config.workspacePath, cp);

  emitSwarmEvent("task_checkpoint_resumed", {
    sessionId: cp.parentSessionId,
    agentName: cp.agentName,
    taskId,
  });
  logAudit("task_checkpoint_resumed", { taskId, agentName: cp.agentName },
    { sessionId: cp.parentSessionId, severity: "info", channel: "swarm" });

  log.info({ taskId, agentName: cp.agentName }, "Task checkpoint resumed");
  return cp;
}

/** Mark a checkpoint complete (called when the resumed agent finishes). */
export function completeCheckpoint(taskId: string): boolean {
  const config = getConfig();
  let cp = _store.get(taskId);
  if (!cp) {
    cp = loadCheckpointFromDisk(config.workspacePath, taskId);
    if (cp) _store.set(taskId, cp);
  }
  if (!cp) return false;

  cp.status = "completed";
  cp.updatedAt = new Date().toISOString();
  _store.set(taskId, cp);
  persistCheckpoint(config.workspacePath, cp);
  logAudit("task_checkpoint_completed", { taskId, agentName: cp.agentName },
    { sessionId: cp.parentSessionId, severity: "info", channel: "swarm" });
  log.info({ taskId }, "Task checkpoint completed");
  return true;
}

/** Return all in-memory checkpoints (for the dashboard). */
export function listCheckpoints(filter?: { status?: CheckpointStatus; agentName?: string }): TaskCheckpoint[] {
  const all = [..._store.values()];
  if (!filter) return all;
  return all.filter(cp => {
    if (filter.status && cp.status !== filter.status) return false;
    if (filter.agentName && cp.agentName !== filter.agentName) return false;
    return true;
  });
}

/** Build the resume context string to prepend to the agent's new turn. */
export function buildResumeContext(cp: TaskCheckpoint): string {
  const parts: string[] = [
    `## Resumed task (taskId: ${cp.taskId})`,
    `Agent: ${cp.agentName}`,
    `Original task: ${cp.task}`,
    `Total elapsed before pause: ${Math.round(cp.elapsedMs / 1000)}s`,
    `Iterations completed before pause: ${cp.iterationsCompleted}`,
  ];
  if (cp.progressNote) {
    parts.push(`\nProgress note (written before pause):\n${cp.progressNote}`);
  }
  if (cp.conversationSummary) {
    parts.push(`\nWork completed so far:\n${cp.conversationSummary}`);
  }
  if (Object.keys(cp.agentState).length > 0) {
    parts.push(`\nSaved agent state:\n${JSON.stringify(cp.agentState, null, 2)}`);
  }
  parts.push("\nContinue from where you left off.");
  return parts.join("\n");
}

/** Load all checkpoints from disk on startup (warm the in-process store). */
export function loadCheckpointsFromDisk(workspacePath: string): void {
  const dir = checkpointDir(workspacePath);
  if (!existsSync(dir)) return;

  const cutoff = Date.now() - CHECKPOINT_TTL_MS;
  let loaded = 0;

  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith(".json"));
  } catch (err) {
    log.warn({ err, dir }, "Failed to read checkpoints directory");
    return;
  }

  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), "utf-8");
      const cp = JSON.parse(raw) as TaskCheckpoint;
      if (new Date(cp.updatedAt).getTime() < cutoff) {
        // Expired — delete from disk silently
        unlinkSync(join(dir, file));
        continue;
      }
      _store.set(cp.taskId, cp);
      loaded++;
    } catch {
      // Corrupt file — ignore
    }
  }

  if (loaded > 0) log.info({ loaded }, "Task checkpoints loaded from disk");
}

// ── Internal ─────────────────────────────────────────────────────────────────

function persistCheckpoint(workspacePath: string, cp: TaskCheckpoint): void {
  try {
    ensureDir(workspacePath);
    writeFileSync(checkpointPath(workspacePath, cp.taskId), JSON.stringify(cp, null, 2), "utf-8");
  } catch (err) {
    // Checkpoint is still held in _store (in-process), but will NOT survive a
    // gateway restart. Log a warn with enough context for operators to notice.
    log.warn(
      { err, taskId: cp.taskId, agentName: cp.agentName, status: cp.status },
      "Failed to persist checkpoint to disk — paused task will be lost on restart",
    );
  }
}

function loadCheckpointFromDisk(workspacePath: string, taskId: string): TaskCheckpoint | undefined {
  try {
    const raw = readFileSync(checkpointPath(workspacePath, taskId), "utf-8");
    return JSON.parse(raw) as TaskCheckpoint;
  } catch {
    return undefined;
  }
}
