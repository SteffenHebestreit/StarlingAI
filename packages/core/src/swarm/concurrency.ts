/**
 * Swarm Concurrency Manager — per-agent-type concurrency caps with queuing.
 *
 * Problem: without limits, a parallel_delegate call can spawn N containers
 * simultaneously for the same agent type, exhausting host memory under load.
 *
 * Solution: every `runSubAgent` call passes through a semaphore keyed by
 * agent name.  Calls that exceed `maxConcurrent` are queued and released as
 * slots free.  Queue depth and wait time are tracked and emitted via the
 * swarm bus as `backpressure` data so operators can observe bottlenecks.
 *
 * Configuration (per agent in starlingai.json):
 *   "maxConcurrent": 3   — max simultaneous containers for this agent type
 *
 * Default (applied when maxConcurrent is absent): DEFAULT_CONCURRENCY.
 *
 * Usage: wrap runSubAgent calls with acquireSlot / releaseSlot.
 */
import { childLogger } from "../logger.js";
import { emitSwarmEvent } from "./bus.js";

const log = childLogger("swarm:concurrency");

/** Default concurrency when not specified in agent config. */
export const DEFAULT_CONCURRENCY = 3;

/** Minimum wait time (ms) before flagging backpressure. */
const BACKPRESSURE_WARN_MS = 5_000;

interface Semaphore {
  maxConcurrent: number;
  active: number;
  queue: Array<{ resolve: () => void; enqueuedAt: number }>;
  totalAcquisitions: number;
  queuedAcquisitions: number;
  totalWaitMs: number;
  lastWaitMs: number;
  maxWaitMs: number;
}

const _semaphores = new Map<string, Semaphore>();

function getSemaphore(agentName: string, maxConcurrent: number): Semaphore {
  let sem = _semaphores.get(agentName);
  if (!sem) {
    sem = {
      maxConcurrent,
      active: 0,
      queue: [],
      totalAcquisitions: 0,
      queuedAcquisitions: 0,
      totalWaitMs: 0,
      lastWaitMs: 0,
      maxWaitMs: 0,
    };
    _semaphores.set(agentName, sem);
  } else if (sem.maxConcurrent !== maxConcurrent) {
    // Config was hot-reloaded — update the cap but keep active/queue state
    sem.maxConcurrent = maxConcurrent;
  }
  return sem;
}

function recordAcquisition(sem: Semaphore, waitMs: number, wasQueued: boolean): void {
  sem.totalAcquisitions += 1;
  sem.lastWaitMs = waitMs;
  if (wasQueued) {
    sem.queuedAcquisitions += 1;
    sem.totalWaitMs += waitMs;
    sem.maxWaitMs = Math.max(sem.maxWaitMs, waitMs);
  }
}

/**
 * Acquire a concurrency slot for the given agent.
 * If at capacity, waits in a FIFO queue until a slot frees.
 * Returns an opaque handle (the agentName) used to release.
 */
export async function acquireSlot(
  agentName: string,
  maxConcurrent: number = DEFAULT_CONCURRENCY,
  sessionId?: string,
): Promise<void> {
  const sem = getSemaphore(agentName, maxConcurrent);

  if (sem.active < sem.maxConcurrent) {
    sem.active++;
    recordAcquisition(sem, 0, false);
    log.debug({ agentName, active: sem.active, max: sem.maxConcurrent }, "Slot acquired");
    return;
  }

  // At capacity — enqueue
  const enqueuedAt = Date.now();
  log.debug({ agentName, active: sem.active, queued: sem.queue.length + 1 }, "Slot queued — at concurrency cap");

  await new Promise<void>(resolve => {
    sem.queue.push({ resolve, enqueuedAt });
  });

  const waitMs = Date.now() - enqueuedAt;
  recordAcquisition(sem, waitMs, true);
  if (waitMs >= BACKPRESSURE_WARN_MS) {
    log.warn({ agentName, waitMs, active: sem.active }, "Backpressure: agent slot wait exceeded threshold");
    emitSwarmEvent("task_requeued", {
      sessionId,
      agentName,
      data: { reason: "concurrency_backpressure", waitMs, active: sem.active, max: sem.maxConcurrent },
    });
  }
  log.debug({ agentName, waitMs }, "Slot acquired after queue wait");
}

/**
 * Release a concurrency slot, unblocking the next waiter if any.
 */
export function releaseSlot(agentName: string): void {
  const sem = _semaphores.get(agentName);
  if (!sem) return;

  if (sem.queue.length > 0) {
    // Hand the slot directly to the next waiter — active count stays the same
    const next = sem.queue.shift()!;
    next.resolve();
    log.debug({ agentName, active: sem.active, remaining: sem.queue.length }, "Slot handed to next waiter");
  } else {
    sem.active = Math.max(0, sem.active - 1);
    log.debug({ agentName, active: sem.active }, "Slot released");
  }
}

// ── Observability ─────────────────────────────────────────────────────────────

export interface ConcurrencySnapshot {
  agentName: string;
  active: number;
  queued: number;
  maxConcurrent: number;
  utilization: number; // 0–1
  totalAcquisitions: number;
  queuedAcquisitions: number;
  lastWaitMs: number;
  avgWaitMs: number;
  maxWaitMs: number;
  oldestQueuedMs: number;
}

/**
 * Return a snapshot of all agent concurrency states.
 * Only agents that have had at least one slot acquired are included.
 */
export function getConcurrencySnapshot(): ConcurrencySnapshot[] {
  return [..._semaphores.entries()].map(([agentName, sem]) => ({
    agentName,
    active: sem.active,
    queued: sem.queue.length,
    maxConcurrent: sem.maxConcurrent,
    utilization: sem.maxConcurrent > 0 ? sem.active / sem.maxConcurrent : 0,
    totalAcquisitions: sem.totalAcquisitions,
    queuedAcquisitions: sem.queuedAcquisitions,
    lastWaitMs: sem.lastWaitMs,
    avgWaitMs: sem.queuedAcquisitions > 0 ? Math.round(sem.totalWaitMs / sem.queuedAcquisitions) : 0,
    maxWaitMs: sem.maxWaitMs,
    oldestQueuedMs: sem.queue.length > 0 ? Date.now() - sem.queue[0]!.enqueuedAt : 0,
  }));
}

/** Reset all semaphores — for use in tests only. */
export function resetConcurrencyForTests(): void {
  // Resolve all queued waiters so tests don't hang
  for (const sem of _semaphores.values()) {
    for (const waiter of sem.queue) waiter.resolve();
    sem.queue.length = 0;
    sem.active = 0;
  }
  _semaphores.clear();
}
