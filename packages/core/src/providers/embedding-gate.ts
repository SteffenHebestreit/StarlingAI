/**
 * A global ceiling on how many embedding requests are in flight at once.
 *
 * WHY THIS EXISTS. Embedding requests come from a dozen independent places — the agent index
 * build, every routing query, memory writes, skill lookup, self-improvement, the failover
 * binding. Each is individually well-behaved and none can see the others, so nothing in the
 * process knows its own total load on the endpoint. That means the ceiling cannot live in any
 * caller; it belongs at the one place they all pass through.
 *
 * Requests over the limit WAIT rather than fail. An embedding call sits on a turn's critical
 * path, and a queued request that completes is better than a refused one that whichever
 * caller happened to lose then has to retry.
 *
 * A NOTE ON WHAT THIS DOES NOT FIX, because the record should be accurate. This was written
 * after a run failed with "the embedding backend is unavailable", and concurrency looked like
 * the cause. It was not. The run was in a throwaway container that had been recreated without
 * SAI_PRIMARY_MODEL_URL, so the provider fell back to the config default and dialled a host
 * that does not resolve there. Every mode failed on its very first request, four seconds in.
 * No ceiling would have changed that, and the tell was in the timing: a capacity problem does
 * not fail instantly on request one.
 *
 * The ceiling is still worth having, for a reason of its own rather than that one: nothing in
 * this process can see its own total load on the endpoint, and the endpoint has a finite slot
 * count. It is a bound on a real unknown.
 *
 * Deliberately NOT a rate limit and not a batcher. It bounds concurrency only, because a slot
 * count is what the endpoint is actually constrained on.
 */

/** Waiters, oldest first — FIFO, so a burst cannot starve the request that arrived first. */
let _limit = 8;
let _inFlight = 0;
const _queue: Array<() => void> = [];

/** Peak concurrency and total wait, so the ceiling's cost is observable rather than assumed. */
let _peakInFlight = 0;
let _queuedCount = 0;
let _totalWaitMs = 0;

export interface EmbeddingGateStats {
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

export function getEmbeddingGateStats(): EmbeddingGateStats {
  return {
    limit: _limit,
    inFlight: _inFlight,
    waiting: _queue.length,
    peakInFlight: _peakInFlight,
    queued: _queuedCount,
    totalWaitMs: Math.round(_totalWaitMs),
  };
}

/**
 * Set the ceiling. Raising it releases waiters immediately; lowering it never interrupts a
 * request already in flight, it only stops new ones starting until the count drains.
 */
export function setEmbeddingConcurrency(limit: number): void {
  _limit = Math.max(1, Math.floor(limit));
  drain();
}

function drain(): void {
  while (_inFlight < _limit && _queue.length > 0) {
    const next = _queue.shift()!;
    _inFlight += 1;
    if (_inFlight > _peakInFlight) _peakInFlight = _inFlight;
    next();
  }
}

/**
 * Run `work` with a slot held, releasing it however `work` ends.
 *
 * The release is in a `finally`: a throwing call that kept its slot would shrink the ceiling
 * permanently, and the symptom — embeddings getting slower and then stopping — would look
 * nothing like its cause.
 */
export async function withEmbeddingSlot<T>(work: () => Promise<T>): Promise<T> {
  if (_inFlight < _limit) {
    _inFlight += 1;
    if (_inFlight > _peakInFlight) _peakInFlight = _inFlight;
  } else {
    _queuedCount += 1;
    const waitStarted = Date.now();
    await new Promise<void>((resolve) => { _queue.push(resolve); });
    _totalWaitMs += Date.now() - waitStarted;
  }
  try {
    return await work();
  } finally {
    _inFlight -= 1;
    drain();
  }
}

/** Test-only: drop the counters and the queue. */
export function _resetEmbeddingGateForTests(limit = 8): void {
  _limit = limit;
  _inFlight = 0;
  _queue.length = 0;
  _peakInFlight = 0;
  _queuedCount = 0;
  _totalWaitMs = 0;
}
