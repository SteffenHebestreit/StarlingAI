/**
 * A FIFO concurrency ceiling, shared by everything in this process that talks to one
 * finite backend resource.
 *
 * This was written for embeddings and is now also what bounds image generation, so the
 * mechanism lives here and each caller owns an instance. The shape is the same in both
 * cases and is worth stating once:
 *
 *  - Requests over the limit WAIT rather than fail. These calls sit on a turn's critical
 *    path, and a queued request that completes beats a refused one that whichever caller
 *    happened to lose then has to retry.
 *  - The queue is FIFO, so a burst cannot starve the request that arrived first.
 *  - The slot is released in a `finally`. A throwing call that kept its slot would shrink
 *    the ceiling permanently, and the symptom — requests getting slower and then stopping
 *    — would look nothing like its cause.
 *
 * Deliberately NOT a rate limit and not a batcher. It bounds concurrency only, because a
 * slot count is what these backends are actually constrained on.
 *
 * Note what a gate does NOT do: it cannot make an unreachable endpoint reachable. The
 * embedding ceiling was first written after a run failed with "the embedding backend is
 * unavailable" and concurrency looked like the cause. It was not — the container had been
 * recreated without its endpoint variable. The tell was the timing: a capacity problem does
 * not fail instantly on request one.
 */

export interface ConcurrencyGateStats {
  limit: number;
  inFlight: number;
  waiting: number;
  /** Highest simultaneous in-flight count seen since the last reset. */
  peakInFlight: number;
  /** How many calls had to wait at all. Zero means the ceiling never bound. */
  queued: number;
  /** Total time spent waiting, across every call that waited. */
  totalWaitMs: number;
}

export interface ConcurrencyGate {
  withSlot<T>(work: () => Promise<T>): Promise<T>;
  setLimit(limit: number): void;
  stats(): ConcurrencyGateStats;
  /** Test-only: drop the counters and the queue. */
  reset(limit?: number): void;
}

export function createConcurrencyGate(defaultLimit: number): ConcurrencyGate {
  let limit = Math.max(1, Math.floor(defaultLimit));
  let inFlight = 0;
  const queue: Array<() => void> = [];

  let peakInFlight = 0;
  let queuedCount = 0;
  let totalWaitMs = 0;

  function drain(): void {
    while (inFlight < limit && queue.length > 0) {
      const next = queue.shift()!;
      inFlight += 1;
      if (inFlight > peakInFlight) peakInFlight = inFlight;
      next();
    }
  }

  return {
    async withSlot<T>(work: () => Promise<T>): Promise<T> {
      if (inFlight < limit) {
        inFlight += 1;
        if (inFlight > peakInFlight) peakInFlight = inFlight;
      } else {
        queuedCount += 1;
        const waitStarted = Date.now();
        await new Promise<void>((resolve) => { queue.push(resolve); });
        totalWaitMs += Date.now() - waitStarted;
      }
      try {
        return await work();
      } finally {
        inFlight -= 1;
        drain();
      }
    },

    /**
     * Raising the ceiling releases waiters immediately; lowering it never interrupts a
     * request already in flight, it only stops new ones starting until the count drains.
     */
    setLimit(next: number): void {
      limit = Math.max(1, Math.floor(next));
      drain();
    },

    stats(): ConcurrencyGateStats {
      return {
        limit,
        inFlight,
        waiting: queue.length,
        peakInFlight,
        queued: queuedCount,
        totalWaitMs: Math.round(totalWaitMs),
      };
    },

    reset(next = defaultLimit): void {
      limit = Math.max(1, Math.floor(next));
      inFlight = 0;
      queue.length = 0;
      peakInFlight = 0;
      queuedCount = 0;
      totalWaitMs = 0;
    },
  };
}

/**
 * A family of gates keyed by name, each with its own independent ceiling.
 *
 * Image generation needs this: the fast and quality tiers run on DIFFERENT devices (an NPU
 * and an iGPU on the measured cluster), and a measurement showed they do not contend — an
 * NPU job during an iGPU generation still returned, about 50% slower. A single global slot
 * would therefore be actively wrong, parking a 10-second request behind a 140-second one
 * for no hardware reason at all.
 */
export function createConcurrencyGateFamily(defaultLimit: number): {
  for(key: string): ConcurrencyGate;
  stats(): Record<string, ConcurrencyGateStats>;
  reset(): void;
} {
  const gates = new Map<string, ConcurrencyGate>();
  return {
    for(key: string): ConcurrencyGate {
      let gate = gates.get(key);
      if (!gate) {
        gate = createConcurrencyGate(defaultLimit);
        gates.set(key, gate);
      }
      return gate;
    },
    stats(): Record<string, ConcurrencyGateStats> {
      return Object.fromEntries([...gates].map(([key, gate]) => [key, gate.stats()]));
    },
    reset(): void {
      gates.clear();
    },
  };
}
