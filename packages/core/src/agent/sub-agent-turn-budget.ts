/**
 * Sub-Agent Turn Budget
 *
 * The ONE rule for combining a caller's turn budget with a sub-agent's own declared one,
 * plus the soft-deadline offset derived from it.
 *
 * They live together because they drifted apart. The hard deadline is resolved in
 * agent/sub-agent.ts; the E18 soft deadline is resolved in tools/sub-agent.ts, a different
 * module that cannot import the first one (tools/sub-agent.ts already imports the runner,
 * so the edge would be circular). The moment the hard side started treating a caller
 * budget as a CEILING rather than a replacement, the soft side — still deriving 70% of the
 * caller budget alone — began landing AFTER the hard deadline for every agent declaring
 * less than 0.7x the turn, and the wrap-up nudge silently stopped firing for them. A leaf
 * module both sides import is the only shape in which that cannot recur.
 *
 * Pure and dependency-free, so the precedence is unit-testable with no runner.
 */

/**
 * The hard turn budget a sub-agent runs under, before the adaptive/default fallbacks.
 *
 * A caller-supplied budget is a CEILING ("do not outlive my turn"), not a GRANT ("you may
 * run this long"), so when both sides state a number the SMALLER wins. That is a policy
 * choice: gateway/rpc.ts sets a caller budget on every turn, so without it an agent's own
 * `turnTimeoutMs` was silently overwritten on every delegated run.
 *
 * Return values are a tri-state and callers must keep them distinct:
 *   - a positive number → that is the budget
 *   - `0`               → EXPLICITLY unbounded (the agent declared "unbound", or the caller
 *                         passed 0, which is how the max-effort profile disables the turn
 *                         timeout). Not "zero time".
 *   - `undefined`       → nobody said anything; fall through to your own default.
 */
export function resolveTurnBudgetMs(input: {
  callerCeilingMs: number | undefined;
  agentTurnTimeout: number | "unbound" | undefined;
}): number | undefined {
  const { callerCeilingMs, agentTurnTimeout } = input;
  if (callerCeilingMs !== undefined) {
    return typeof agentTurnTimeout === "number"
      ? Math.min(callerCeilingMs, agentTurnTimeout)
      : callerCeilingMs;
  }
  if (agentTurnTimeout === "unbound") return 0;
  return agentTurnTimeout;
}

/**
 * E18 soft deadline, as an offset in ms from now: 70% of the budget the specialist will
 * ACTUALLY run under, so it starts wrapping up before its hard deadline aborts it.
 *
 * The two non-bounds are pushed out of reach rather than collapsed to zero. "unbound"
 * means the agent declared no self-limit; a caller budget of 0 means max effort disabled
 * the turn timeout. Multiplying either by 0.70 nudges "wrap up now" into iteration 1 of a
 * run that was explicitly told to take as long as it needs.
 */
export function resolveSoftDeadlineOffsetMs(
  callerBudgetMs: number | undefined,
  agentTurnTimeout: number | "unbound" | undefined,
  fallbackMs = 60_000,
): number {
  const budget = resolveTurnBudgetMs({ callerCeilingMs: callerBudgetMs, agentTurnTimeout });
  const effective = budget === undefined
    ? fallbackMs // nobody stated a budget — keep the historical 60 s assumption
    : budget > 0
      ? budget
      : Number.MAX_SAFE_INTEGER; // explicitly unbounded
  return Math.floor(effective * 0.70);
}
