/**
 * What one tool call contributes to the turn.
 *
 * THE TURN LOOP HAS A TAIL. Every tool call the orchestrator makes updates turn-level state on its
 * way out: the delegation tally the honesty chain reads, the workflow-completed flag the
 * compliance guard reads, the per-tool budget the caps enforce, the wall-clock credit that keeps a
 * turn from being cut off while it waits for children. All of it lived inline in the loop, keyed on
 * the name of the tool the MODEL asked for.
 *
 * `execute_plan` dispatches tools underneath that loop, so none of it applied to a plan's steps —
 * and each missing piece had to be rediscovered one at a time. Three review rounds found seven of
 * them, in the same shape every round: one more thing the loop did that the plan path did not.
 *
 * So the tail is defined HERE, once, and both callers apply it: the loop for the calls the model
 * makes, and the plan executor's result for the calls it made on the turn's behalf. Anything added
 * to these functions applies to both from then on, which is the property that was missing.
 */

/** Tools whose invocation IS a delegation for the turn's tally. */
const DELEGATION_COUNTING_TOOL_NAMES: ReadonlySet<string> = new Set([
  "delegate_to_agent",
  "parallel_delegate",
  "run_task_graph",
  "swarm_delegate",
  "create_ephemeral_agent",
]);

/**
 * Tools where the orchestrator BLOCKS awaiting delegated children — their wall-clock is the
 * "parent waiting for kids" time excluded from the turn budget by D5
 * (excludeDelegationWaitFromTurnBudget).
 */
export const DELEGATION_WAIT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "delegate_to_agent", "swarm_delegate", "parallel_delegate", "run_task_graph", "run_workflow",
  // execute_plan blocks on exactly the same children — it just issues them a level down. Left out,
  // a plan of four five-minute steps had none of its waiting credited back: the deadline never
  // moved, later steps were handed the floor of the budget, and the turn was cut off mid-plan.
  "execute_plan",
]);

/** What is known BEFORE the call runs, from the tool name alone. */
export interface ToolCallContribution {
  /** How much this call adds to the turn's delegation tally. */
  delegations: number;
  /** Whether its duration is parent-waiting-for-children time. */
  isDelegationWait: boolean;
}

export function toolCallContribution(toolName: string): ToolCallContribution {
  return {
    // run_workflow is deliberately NOT counted here. This is decided BEFORE the call, on the raw
    // request, so counting it made a workflow that never ran — an ambiguous name, an unknown
    // scene, a recursive re-entry — read as executed orchestration. That poisoned signal disables
    // the honesty chain for a source-sensitive turn (audit 1303e254). The honest signal is the
    // result-side `workflowCompleted` below.
    delegations: DELEGATION_COUNTING_TOOL_NAMES.has(toolName) ? 1 : 0,
    isDelegationWait: DELEGATION_WAIT_TOOL_NAMES.has(toolName),
  };
}

/** What is only knowable once the call has returned. */
export interface ToolResultContribution {
  /** A workflow genuinely executed — not a routing miss, which returns success with a flag. */
  workflowCompleted: boolean;
}

export function toolResultContribution(
  toolName: string,
  result: { success: boolean; metadata?: Record<string, unknown> },
): ToolResultContribution {
  return {
    workflowCompleted: toolName === "run_workflow"
      && result.success
      && result.metadata?.["workflowNotFound"] !== true,
  };
}

/** One tool call a tool made on the turn's behalf, reported so the turn can account for it. */
export interface NestedToolCall {
  tool: string;
  success: boolean;
  workflowNotFound?: boolean;
}

/** Read a tool result's reported nested calls, tolerating anything malformed. */
export function readNestedToolCalls(metadata: Record<string, unknown> | undefined): NestedToolCall[] {
  const raw = metadata?.["nestedCalls"];
  if (!Array.isArray(raw)) return [];
  const calls: NestedToolCall[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const tool = typeof record["tool"] === "string" ? record["tool"] : "";
    if (!tool) continue;
    calls.push({
      tool,
      success: record["success"] === true,
      ...(record["workflowNotFound"] === true ? { workflowNotFound: true } : {}),
    });
  }
  return calls;
}
