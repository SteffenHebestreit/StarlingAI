/**
 * Swarm Concurrency Manager — per-agent-type concurrency caps with queuing,
 * plus a global ceiling across all agent types.
 *
 * Problem: without limits, a parallel_delegate call can spawn N containers
 * simultaneously for the same agent type, exhausting host memory under load.
 * The per-agent cap alone is not enough: a fan-out across many *distinct*
 * agent types has no upstream admission control, so the total number of
 * in-flight containers on a single host is unbounded. The Warden and
 * backpressure events only catch the symptom after the fact.
 *
 * Solution: every `runSubAgent` call passes through two semaphores — one keyed
 * by agent name (`maxConcurrent`) and one shared global ceiling. A call must
 * hold both to run. Calls that exceed either cap are queued FIFO and released
 * as slots free. Queue depth and wait time are tracked and emitted via the
 * swarm bus as backpressure data so operators can observe bottlenecks.
 *
 * Acquisition order is per-agent first, then global — consistent across all
 * callers, so the shared global semaphore can never participate in a
 * lock-ordering cycle. (These are counting semaphores, not exclusive locks,
 * so they are deadlock-resistant regardless, but the consistent order keeps
 * the reasoning simple.)
 *
 * Configuration:
 *   per agent in starlingai.json: "maxConcurrent": 3  — simultaneous containers for this agent type
 *   global via env: STARLINGAI_MAX_GLOBAL_CONCURRENCY — total simultaneous containers across all types
 *
 * Default per-agent cap (when maxConcurrent is absent): DEFAULT_CONCURRENCY.
 * Default global cap: DEFAULT_GLOBAL_CONCURRENCY.
 *
 * Usage: wrap runSubAgent calls with acquireSlot / releaseSlot.
 */
import { childLogger } from "../logger.js";
import { emitSwarmEvent } from "./bus.js";

const log = childLogger("swarm:concurrency");

/** Default per-agent-type concurrency when not specified in agent config. */
export const DEFAULT_CONCURRENCY = 3;

/** Default global ceiling across all agent types when not overridden by env. */
export const DEFAULT_GLOBAL_CONCURRENCY = 16;

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

function makeSemaphore(maxConcurrent: number): Semaphore {
  return {
    maxConcurrent,
    active: 0,
    queue: [],
    totalAcquisitions: 0,
    queuedAcquisitions: 0,
    totalWaitMs: 0,
    lastWaitMs: 0,
    maxWaitMs: 0,
  };
}

const _semaphores = new Map<string, Semaphore>();

function resolveGlobalMax(): number {
  const raw = Number(process.env["STARLINGAI_MAX_GLOBAL_CONCURRENCY"]);
  if (Number.isFinite(raw) && raw >= 1) return Math.floor(raw);
  return DEFAULT_GLOBAL_CONCURRENCY;
}

/** Shared ceiling across every agent type. */
const _global: Semaphore = makeSemaphore(resolveGlobalMax());

function getSemaphore(agentName: string, maxConcurrent: number): Semaphore {
  let sem = _semaphores.get(agentName);
  if (!sem) {
    sem = makeSemaphore(maxConcurrent);
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
 * Acquire one slot on a semaphore. If at capacity, waits in a FIFO queue until
 * a slot frees. Returns how long the caller waited and whether it was queued.
 * Active count stays constant across a queued hand-off (see `releaseOn`).
 */
async function acquireOn(sem: Semaphore): Promise<{ waitMs: number; wasQueued: boolean }> {
  if (sem.active < sem.maxConcurrent) {
    sem.active++;
    recordAcquisition(sem, 0, false);
    return { waitMs: 0, wasQueued: false };
  }

  const enqueuedAt = Date.now();
  await new Promise<void>((resolve) => {
    sem.queue.push({ resolve, enqueuedAt });
  });

  const waitMs = Date.now() - enqueuedAt;
  recordAcquisition(sem, waitMs, true);
  return { waitMs, wasQueued: true };
}

/** Release one slot, handing it directly to the next FIFO waiter if any. */
function releaseOn(sem: Semaphore): void {
  if (sem.queue.length > 0) {
    // Hand the slot straight to the next waiter — active count stays the same.
    const next = sem.queue.shift()!;
    next.resolve();
  } else {
    sem.active = Math.max(0, sem.active - 1);
  }
}

/**
 * Acquire a concurrency slot for the given agent.
 *
 * Holds both the per-agent cap and the shared global ceiling for the duration
 * of the sub-agent run. The per-agent slot is acquired first; the global slot
 * second. Pair every call with exactly one `releaseSlot(agentName)`.
 */
export async function acquireSlot(
  agentName: string,
  maxConcurrent: number = DEFAULT_CONCURRENCY,
  sessionId?: string,
): Promise<void> {
  const sem = getSemaphore(agentName, maxConcurrent);

  const perAgent = await acquireOn(sem);
  if (perAgent.wasQueued) {
    if (perAgent.waitMs >= BACKPRESSURE_WARN_MS) {
      log.warn({ agentName, waitMs: perAgent.waitMs, active: sem.active }, "Backpressure: agent slot wait exceeded threshold");
      emitSwarmEvent("task_requeued", {
        sessionId,
        agentName,
        data: { reason: "concurrency_backpressure", waitMs: perAgent.waitMs, active: sem.active, max: sem.maxConcurrent },
      });
    }
    log.debug({ agentName, waitMs: perAgent.waitMs }, "Per-agent slot acquired after queue wait");
  } else {
    log.debug({ agentName, active: sem.active, max: sem.maxConcurrent }, "Per-agent slot acquired");
  }

  // Global ceiling is acquired last so the shared semaphore is never held while
  // waiting on a per-agent cap — that keeps it out of any lock-ordering cycle.
  _global.maxConcurrent = resolveGlobalMax();
  const global = await acquireOn(_global);
  if (global.wasQueued && global.waitMs >= BACKPRESSURE_WARN_MS) {
    log.warn({ agentName, waitMs: global.waitMs, globalActive: _global.active, globalMax: _global.maxConcurrent }, "Backpressure: global concurrency ceiling reached");
    emitSwarmEvent("task_requeued", {
      sessionId,
      agentName,
      data: { reason: "global_concurrency_backpressure", waitMs: global.waitMs, active: _global.active, max: _global.maxConcurrent },
    });
  }
}

/**
 * Release a concurrency slot, unblocking the next waiter on each semaphore.
 * Releases the global slot first, then the per-agent slot (reverse of acquire).
 */
export function releaseSlot(agentName: string): void {
  releaseOn(_global);

  const sem = _semaphores.get(agentName);
  if (!sem) return;
  releaseOn(sem);
  log.debug({ agentName, active: sem.active, remaining: sem.queue.length }, "Slot released");
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

function snapshotOf(agentName: string, sem: Semaphore): ConcurrencySnapshot {
  return {
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
  };
}

/**
 * Return a snapshot of all agent concurrency states.
 * Only agents that have had at least one slot acquired are included.
 */
export function getConcurrencySnapshot(): ConcurrencySnapshot[] {
  return [..._semaphores.entries()].map(([agentName, sem]) => snapshotOf(agentName, sem));
}

/** Return a snapshot of the shared global concurrency ceiling. */
export function getGlobalConcurrencySnapshot(): ConcurrencySnapshot {
  return snapshotOf("__global__", _global);
}

/** Reset all semaphores — for use in tests only. */
export function resetConcurrencyForTests(): void {
  // Resolve all queued waiters so tests don't hang
  for (const sem of [..._semaphores.values(), _global]) {
    for (const waiter of sem.queue) waiter.resolve();
    sem.queue.length = 0;
    sem.active = 0;
    sem.totalAcquisitions = 0;
    sem.queuedAcquisitions = 0;
    sem.totalWaitMs = 0;
    sem.lastWaitMs = 0;
    sem.maxWaitMs = 0;
  }
  _semaphores.clear();
  _global.maxConcurrent = resolveGlobalMax();
}
