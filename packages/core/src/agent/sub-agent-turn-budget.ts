/**
 * Sub-Agent Turn Budget
 *
 * The ONE rule for combining a caller's turn budget with a sub-agent's own declared one,
 * plus the soft-deadline offset derived from it and the parent-RELATIVE ceiling/deadline a
 * delegation hands down.
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
 * Floor for a parent-relative delegation budget, used when the parent turn is nearly (or already)
 * out of time. Two independent reasons it cannot be 0:
 *
 *   1. `0` is not "no time" anywhere in this module — `resolveTurnBudgetMs` reads it as EXPLICITLY
 *      UNBOUNDED. A parent that has run out of budget must never hand its child an unlimited one.
 *   2. Below one model completion a child cannot open a stream and salvage a partial, so a smaller
 *      grant is indistinguishable from not delegating at all. 120 s is one completion on the
 *      audited endpoint (mean 124,293 ms over backend_coder's 13 iterations, run 3959f3ac),
 *      rounded down to the nearest round number.
 *
 * The floor may exceed the parent's remaining time. That is deliberate and safe: the parent's abort
 * signal is threaded into every child, so the real wall-clock is still bounded by the turn.
 */
export const SUB_AGENT_MIN_DELEGATION_MS = 120_000;

/**
 * The largest share of a parent's REMAINING time that may be carved out as synthesis reserve.
 *
 * The reserve is a fixed number of milliseconds and the deadline it carves from shrinks at every
 * level (see resolveDelegationDeadlineMs), so a flat subtraction compounds: at the shipped
 * 420,000 ms reserve, depth 2 removed 840,000 ms — 14 minutes of a 30-minute turn — from a child
 * that had not started yet. Below a certain remaining time that stops being "headroom for the
 * parent" and becomes "the child does not get to work", which is the inversion this cap fixes:
 * a reserve may take a QUARTER of what is left, never a fixed slab of it.
 *
 * A quarter, not a third or a tenth, because it is the largest fraction that still leaves the
 * child three of the four remaining completions on the audited endpoint (one orchestrator
 * completion ≈ 124,293 ms, run 3959f3ac) — the parent needs roughly one to synthesise, and the
 * child needs the rest to have anything worth synthesising.
 */
export const MAX_SYNTHESIS_RESERVE_FRACTION = 0.25;

/** The reserve actually applied: the configured amount, bounded by the fraction above. Pure. */
function effectiveReserveMs(remainingMs: number, synthesisReserveMs: number): number {
  if (synthesisReserveMs <= 0 || remainingMs <= 0) return 0;
  return Math.min(synthesisReserveMs, Math.floor(remainingMs * MAX_SYNTHESIS_RESERVE_FRACTION));
}

/**
 * How long a child may run given the parent turn's REMAINING time, before the child's own declared
 * budget is considered: `max(floor, remaining - effectiveReserve(remaining))`.
 *
 * `undefined` when the parent stated no deadline — the caller must then leave the existing budget
 * alone rather than invent one.
 */
function parentRelativeBudgetMs(
  parentDeadlineMs: number | undefined,
  nowMs: number,
  synthesisReserveMs: number,
  floorMs: number,
): number | undefined {
  if (typeof parentDeadlineMs !== "number" || !Number.isFinite(parentDeadlineMs)) return undefined;
  const remainingMs = parentDeadlineMs - nowMs;
  return Math.max(floorMs, remainingMs - effectiveReserveMs(remainingMs, synthesisReserveMs));
}

/**
 * The hard turn budget handed DOWN to a delegated sub-agent as its caller ceiling:
 *
 *   min(callerBudget, max(floor, parentRemaining − synthesisReserve))
 *
 * Why the parent's REMAINING time and not its configured one: a caller budget is a static number
 * (gateway/rpc.ts sets the whole turn timeout on every turn), so a child delegated 3 minutes into a
 * 30-minute turn was still offered the full 30 minutes. Run 3959f3ac is what that costs — a
 * specialist declaring 1,500,000 ms ran 1,615,806 ms of an 1,800,000 ms turn (90%), the orchestrator
 * was cut mid-synthesis (finishReason "aborted_synthesized", recoveredAssistantText false), and the
 * files the child had written were never delivered.
 *
 * Why a reserve on top: the parent still has work AFTER the child returns, and that work is not
 * free. See `orchestration.subAgentSynthesisReserveMs` in config/gateway/40-orchestration.jsonc for
 * the measured derivation of this deployment's value, and MAX_SYNTHESIS_RESERVE_FRACTION above for
 * the bound that stops it compounding a nested child down to the floor.
 *
 * What this clamp is NOT: a health check. It knows how much room is left and nothing about whether
 * the child is doing anything with it, so it must only ever shape the room a child is GIVEN — it
 * must never be the thing that ends a child that is working. That job belongs to the progress
 * supervisor, and to the operator via the long-running dock.
 *
 * Degenerate inputs, and what each one gets:
 *   - caller budget `undefined` → `undefined`. NEVER manufacture a ceiling where none existed: for
 *     an agent that declares no budget of its own, `resolveTurnBudgetMs` treats a caller ceiling as
 *     a REPLACEMENT, so inventing one here would LENGTHEN a leaf's budget from its adaptive/default
 *     (~60 s) to the whole remaining turn. That case is covered by the runner-side clamp instead
 *     (orchestration.clampSubAgentTimeoutToParent), which applies after the defaults resolve and can
 *     only reduce.
 *   - caller budget `0` / non-finite → passed through unchanged (0 = explicitly unbounded, the
 *     max-effort profile's "as long as it needs").
 *   - no parent deadline → the static carve-out only (`callerBudget − reserve`), i.e. exactly what
 *     reserveSubAgentTimeout did before this became parent-relative.
 *   - parent already past its deadline → the floor, never 0 and never negative (see
 *     SUB_AGENT_MIN_DELEGATION_MS).
 *
 * A clamp only ever REDUCES: the result is never larger than `callerBudgetMs`.
 */
export function resolveDelegationCeilingMs(input: {
  /** The caller's own turn budget (ToolContext.turnTimeoutOverrideMs). */
  callerBudgetMs: number | undefined;
  /** The parent turn's absolute epoch-ms deadline (ToolContext._turnDeadlineMs). */
  parentDeadlineMs: number | undefined;
  nowMs: number;
  /** Headroom the parent keeps for synthesis + delivery after the child returns. */
  synthesisReserveMs: number;
  floorMs?: number;
}): number | undefined {
  const { callerBudgetMs, parentDeadlineMs, nowMs, synthesisReserveMs } = input;
  const floorMs = input.floorMs ?? SUB_AGENT_MIN_DELEGATION_MS;
  if (callerBudgetMs === undefined) return undefined;
  if (!Number.isFinite(callerBudgetMs) || callerBudgetMs <= 0) return callerBudgetMs;
  const parentRelative = parentRelativeBudgetMs(parentDeadlineMs, nowMs, synthesisReserveMs, floorMs);
  if (parentRelative === undefined) {
    // Same fractional bound as the parent-relative arm: a static carve-out that eats most of a
    // short caller budget is the same defect in a different branch.
    const reserveMs = effectiveReserveMs(callerBudgetMs, synthesisReserveMs);
    return reserveMs > 0 ? Math.max(floorMs, callerBudgetMs - reserveMs) : callerBudgetMs;
  }
  return Math.min(callerBudgetMs, parentRelative);
}

/**
 * The absolute deadline handed DOWN to a delegated sub-agent (ToolContext._turnDeadlineMs), tightened
 * by the same synthesis reserve as the ceiling above: `min(parentDeadline, now + parentRelative)`.
 *
 * This is what makes nesting work without a depth counter. agent/sub-agent.ts propagates the deadline
 * it RECEIVED onto the tool context of everything the child itself delegates, so each level subtracts
 * the reserve from an already-tightened deadline: depth 1 ends by `D − reserve`, depth 2 by
 * `D − 2×reserve`, and so on. Every level therefore keeps its own synthesis headroom, and the
 * sequence is monotonically non-increasing — a deeper delegation can never be granted more time than
 * a shallower one, so no amount of nesting can push the subtree past the turn's deadline.
 *
 * Monotone by construction: the result is never LATER than `parentDeadlineMs`. When the parent is
 * nearly exhausted the deadline is left exactly where it was (the floor belongs to the budget, not
 * to the deadline — pushing a deadline outward would be the one direction this must never move).
 * `undefined` in → `undefined` out (a turn with no deadline).
 */
export function resolveDelegationDeadlineMs(input: {
  parentDeadlineMs: number | undefined;
  nowMs: number;
  synthesisReserveMs: number;
  floorMs?: number;
}): number | undefined {
  const { parentDeadlineMs, nowMs, synthesisReserveMs } = input;
  const floorMs = input.floorMs ?? SUB_AGENT_MIN_DELEGATION_MS;
  const parentRelative = parentRelativeBudgetMs(parentDeadlineMs, nowMs, synthesisReserveMs, floorMs);
  if (parentRelative === undefined || parentDeadlineMs === undefined) return parentDeadlineMs;
  return Math.min(parentDeadlineMs, nowMs + parentRelative);
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
