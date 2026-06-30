/**
 * Quorum drain for parallel delegation (orchestration.quorumEarlySynthesis).
 *
 * Runs N slices concurrently and resolves as soon as K of them SUCCEED (or all settle),
 * then gives in-flight stragglers a grace window before ABORTING them — so a fan-out can
 * synthesize on a sufficient majority instead of blocking on the slowest slice. Each slice
 * gets its own AbortSignal (chained to the parent), so abandoned stragglers truly stop
 * rather than orphan. If fewer than K succeed, it waits for ALL to settle (never abandons
 * prematurely). Generic + dependency-injected (setTimeoutFn) so it is unit-testable without
 * real timers, and `default-off` at the call site restores plain Promise.all (wait-for-all).
 */

export interface QuorumOptions<T> {
  /** Number of SUCCESSFUL results that forms the quorum. */
  k: number;
  /** Grace window (ms) granted to stragglers after the quorum is reached. */
  graceMs: number;
  isSuccess: (result: T) => boolean;
  /** Build the placeholder for a slice whose runner threw. */
  onError: (err: unknown, index: number) => T;
  /** Build the placeholder for a slice abandoned after the quorum + grace. */
  onAbandon: (index: number) => T;
  /** Aborting this signal aborts every still-running slice. */
  parentSignal?: AbortSignal;
  /** Injectable timer (tests). Defaults to setTimeout. */
  setTimeoutFn?: (cb: () => void, ms: number) => void;
}

export async function awaitQuorum<T>(
  runners: ReadonlyArray<(signal: AbortSignal) => Promise<T>>,
  opts: QuorumOptions<T>,
): Promise<T[]> {
  const n = runners.length;
  const results = new Array<T | undefined>(n);
  const aborts = runners.map(() => new AbortController());
  const onParentAbort = (): void => { for (const a of aborts) a.abort(); };
  opts.parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  const schedule = opts.setTimeoutFn ?? ((cb: () => void, ms: number): void => { setTimeout(cb, ms); });
  const k = Math.max(1, Math.min(opts.k, n));
  let succeeded = 0;
  let settled = 0;
  let finalized = false;
  let resolveDone!: () => void;
  const quorumOrAll = new Promise<void>((res) => { resolveDone = res; });

  const tasks = runners.map((run, i) =>
    run(aborts[i]!.signal)
      .then((r) => { if (!finalized) { results[i] = r; if (opts.isSuccess(r) && ++succeeded >= k) resolveDone(); } })
      .catch((err) => { if (!finalized) results[i] = opts.onError(err, i); })
      .finally(() => { if (!finalized && ++settled >= n) resolveDone(); }),
  );

  await quorumOrAll;

  // Quorum reached (or everything settled) — let any stragglers finish within the grace
  // window, then stop waiting. Whichever of (all settled) / (grace elapsed) comes first wins.
  if (settled < n) {
    await new Promise<void>((res) => {
      let done = false;
      const finish = (): void => { if (!done) { done = true; res(); } };
      schedule(finish, opts.graceMs);
      void Promise.allSettled(tasks).then(finish);
    });
  }

  // Freeze: ignore any late slice callbacks so an abandoned placeholder cannot be
  // overwritten after we hand the array back.
  finalized = true;
  for (let i = 0; i < n; i++) {
    if (results[i] === undefined) {
      aborts[i]!.abort();
      results[i] = opts.onAbandon(i);
    }
  }
  opts.parentSignal?.removeEventListener("abort", onParentAbort);
  return results as T[];
}
