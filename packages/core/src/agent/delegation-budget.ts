// Pure D5 delegation-wait budget helpers, kept in their own tiny module so the two timeout layers
// (the runtime abort in runtime.ts and the gateway hard timeout in gateway/rpc.ts) can BOTH import
// them without rpc.ts pulling them through runtime.js — which tests routinely vi.mock() with a
// partial factory (rpc-timeout.test.ts). Living here keeps the shared math out of that mock surface.

/** Absolute wall-clock ceiling (30 min) for the delegation-wait deadline extension — a hung or
 *  unbounded child can never push a non-max turn past this. Both timeout layers cap at this bound. */
export const DELEGATION_WAIT_CEILING_MS = 1_800_000;

/** Push a deadline out by delegation-wait `waitMs`, never past `ceilingMs`. A non-positive wait leaves
 *  it unchanged; the ceiling can only cap, never raise. Both layers use this so they extend by exactly
 *  the same bounded amount. Pure/exported for direct unit testing. */
export function extendDeadlineForDelegationWait(currentDeadlineMs: number, waitMs: number, ceilingMs: number): number {
  if (waitMs <= 0) return currentDeadlineMs;
  return Math.min(currentDeadlineMs + waitMs, ceilingMs);
}
