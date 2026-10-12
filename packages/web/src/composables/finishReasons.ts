/**
 * The turn finish reasons the dashboard calls out. The runtime sets them
 * (packages/core/src/agent/runtime.ts, terminalFinishReason); the web package does not depend on
 * core, so the names are mirrored here — keep them in step with runtime.ts.
 */

/**
 * A turn that ran out of tool iterations, or that a loop brake ended before the cap: one tool in
 * every iteration, or the same set of tools (runtime.ts LOOP_BRAKE_FINISH_REASONS). The brakes
 * reported max_tool_iterations until they had finish reasons of their own.
 */
export const ITERATION_STOP_FINISH_REASONS: ReadonlySet<string> = new Set([
  "max_tool_iterations",
  "tool_streak_across_iterations",
  "iteration_tool_set_repeat",
]);

/** Other finish reasons of a turn that did not end on its own. */
const OTHER_ATTENTION_FINISH_REASONS: ReadonlySet<string> = new Set([
  "timeout",
  "budget_exceeded",
  "blocked",
  "interrupted",
  "error",
]);

/**
 * Whether a message's finish reason gets the warning chip: the turn did not end on its own, which
 * the user usually wants to know. "max_iterations", which the chip used to look for, is a reason
 * the runtime never sends.
 */
export function finishReasonNeedsAttention(reason: string | undefined | null): boolean {
  if (!reason) return false;
  return ITERATION_STOP_FINISH_REASONS.has(reason) || OTHER_ATTENTION_FINISH_REASONS.has(reason);
}
