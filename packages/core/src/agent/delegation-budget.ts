// Pure D5 delegation-wait budget helpers, kept in their own tiny module so the two timeout layers
// (the runtime abort in runtime.ts and the gateway hard timeout in gateway/rpc.ts) can BOTH import
// them without rpc.ts pulling them through runtime.js — which tests routinely vi.mock() with a
// partial factory (rpc-timeout.test.ts). Living here keeps the shared math out of that mock surface.

/** Absolute wall-clock ceiling (30 min) for the delegation-wait deadline extension — a hung or
 *  unbounded child can never push a non-max turn past this. Both timeout layers cap at this bound. */
export const DELEGATION_WAIT_CEILING_MS = 1_800_000;

/** Push a deadline out by delegation-wait `waitMs`, never past `ceilingMs`, and NEVER shorten it.
 *  A non-positive wait leaves it unchanged. The ceiling caps the EXTENSION amount only — it must
 *  not clip a deadline that legitimately already exceeds it: when an operator/effort profile sets a
 *  turn timeout above the 30-min ceiling, the configured (larger) deadline is honored as its own
 *  floor, so the first delegation wait cannot guillotine the turn back to 30 min (both timeout
 *  layers had this inversion). Monotonic non-decreasing. Pure/exported for direct unit testing. */
export function extendDeadlineForDelegationWait(currentDeadlineMs: number, waitMs: number, ceilingMs: number): number {
  if (waitMs <= 0) return currentDeadlineMs;
  return Math.max(currentDeadlineMs, Math.min(currentDeadlineMs + waitMs, ceilingMs));
}
