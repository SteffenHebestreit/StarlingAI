/**
 * A global ceiling on how many embedding requests are in flight at once.
 *
 * WHY THIS EXISTS. Embedding requests come from a dozen independent places — the agent index
 * build, every routing query, memory writes, skill lookup, self-improvement, the failover
 * binding. Each is individually well-behaved and none can see the others, so nothing in the
 * process knows its own total load on the endpoint. That means the ceiling cannot live in any
 * caller; it belongs at the one place they all pass through.
 *
 * The queue mechanics — FIFO, wait rather than fail, release in a `finally` — live in
 * runtime/concurrency-gate.ts, which image generation now also uses. The rationale for each of
 * those choices is documented there.
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
 */
import { createConcurrencyGate, type ConcurrencyGateStats } from "../runtime/concurrency-gate.js";

const DEFAULT_EMBEDDING_CONCURRENCY = 8;

const gate = createConcurrencyGate(DEFAULT_EMBEDDING_CONCURRENCY);

export type EmbeddingGateStats = ConcurrencyGateStats;

export function getEmbeddingGateStats(): EmbeddingGateStats {
  return gate.stats();
}

/**
 * Set the ceiling. Raising it releases waiters immediately; lowering it never interrupts a
 * request already in flight, it only stops new ones starting until the count drains.
 */
export function setEmbeddingConcurrency(limit: number): void {
  gate.setLimit(limit);
}

/** Run `work` with a slot held, releasing it however `work` ends. */
export async function withEmbeddingSlot<T>(work: () => Promise<T>): Promise<T> {
  return gate.withSlot(work);
}

/** Test-only: drop the counters and the queue. */
export function _resetEmbeddingGateForTests(limit = DEFAULT_EMBEDDING_CONCURRENCY): void {
  gate.reset(limit);
}
