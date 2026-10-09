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
  // Waiting on a human is not model time either: a two-minute ask_user consumed the turn budget
  // the way a stalled model did, and the turn timed out on the user's answer.
  "ask_user",
  "request_human_assist",
  "delegate_to_agent", "swarm_delegate", "parallel_delegate", "run_task_graph", "run_workflow",
  // execute_plan blocks on exactly the same children — it just issues them a level down. Left out,
  // a plan of four five-minute steps had none of its waiting credited back: the deadline never
  // moved, later steps were handed the floor of the budget, and the turn was cut off mid-plan.
  "execute_plan",
  // ...and record_plan runs execute_plan inside its own call when it folds the plan round
  // (orchestration.planRoundFold). Unfolded it returns in milliseconds, or after the operator's
  // plan approval, which is a wait on a person like ask_user's — neither is the model's time.
  "record_plan",
]);

/**
 * Tools whose result is NOT a function of their arguments.
 *
 * The turn caches a tool's result against its arguments and replays it for an identical repeat
 * call. That is right for a lookup and wrong for a tool that reads state another tool writes: the
 * repeat is the whole point, and serving the old answer makes it a silent no-op. Anything added
 * here must be a tool whose second identical call is legitimately expected to do something new.
 */
export const STATE_DEPENDENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  // The orchestrator's only view of what its delegations are doing. Both take NO arguments, so
  // every call in a turn has the identical signature and the cache replayed the first snapshot
  // for the rest of the turn — a coordinator polling "what is still running" was answered with
  // the state from before anything ran. Both are in-memory reads with no model call, so exempting
  // them costs nothing.
  "get_swarm_state",
  "get_swarm_budget",
  // A question's answer is not a function of its arguments — the identical-arguments cache
  // replayed the first answer for every later identical question in the turn.
  "ask_user",
  "request_human_assist",
  // Each call delegates again; two identical delegations are two pieces of work.
  "delegate_to_agent",
  // Each call is a new render: "make another one" repeats the call verbatim, and in a chat the
  // person may choose different settings for it. A replay handed back the previous picture as new.
  "generate_image",
  // Takes no required arguments, so its signature never varies — and its result depends entirely on
  // the plan and the outcomes recorded against it, both of which change between calls. Its resume
  // path is a second call with the same shape.
  "execute_plan",
]);

/**
 * Tools trusted to report the calls they made on the turn's behalf.
 *
 * NOT every tool result's metadata is ours. The infrastructure tools merge a REMOTE webhook's
 * `metadata` object into their result verbatim (tools/infrastructure-shared.ts, tools/proxmox.ts),
 * so reading `nestedCalls` off any result at all would let a remote endpoint forge delegations: the
 * turn's tally and workflow flag would say real orchestration happened, which is precisely the
 * signal that disables the honesty chain (audit 1303e254) — reachable from a payload rather than
 * from a tool name. An allowlist keeps the reporter side of this seam ours.
 */
// record_plan: a folded plan round (orchestration.planRoundFold) runs execute_plan inside the call
// and reports the steps it dispatched exactly as execute_plan does.
const NESTED_CALL_REPORTERS: ReadonlySet<string> = new Set(["execute_plan", "parallel_delegate", "record_plan"]);

/**
 * Whether a tool result is a plan-execution report: execute_plan's, or record_plan's when it folded
 * the plan round and ran the plan in its own call (orchestration.planRoundFold). Every place that
 * gives the plan report its own treatment by tool NAME — the model-visible frame, the history
 * snippet — asks this instead, so the folded report is not cut to a generic tool result's size.
 */
export function isPlanReportResult(toolName: string, metadata: Record<string, unknown> | undefined): boolean {
  return toolName === "execute_plan" || (toolName === "record_plan" && metadata?.["planExecution"] === true);
}

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
    // A tool that REPORTS the calls it made (NESTED_CALL_REPORTERS) is not counted here as well.
    // parallel_delegate is a counting tool AND, since 4160d3f, reports its slices — each slice was
    // then counted again when the result landed, so a three-slice fan-out read as four
    // delegations. The report is the honest count (the children that actually ran, failures
    // excluded, as for execute_plan); the call itself adds nothing.
    delegations: DELEGATION_COUNTING_TOOL_NAMES.has(toolName) && !NESTED_CALL_REPORTERS.has(toolName) ? 1 : 0,
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

/**
 * Whether a call the turn made itself brought knowledge-base content back: a search_knowledge_base
 * that returned excerpts, or a use_knowledge_base whose worker ran. A source-sensitive turn is
 * forced to retrieve before it answers, and the turn counted only delegations and workflows as
 * retrieval, so a turn told to "search the knowledge base X" that did exactly that was still forced
 * on, and its answer from the excerpts was rejected as ungrounded (E2E, 2026-10-08).
 *
 * Fails closed. A search that found nothing still reports success, so only a positive `hits` count
 * counts. Not applied to the calls a tool reports making (readNestedToolCalls): those reports carry
 * no result metadata, so a nested search that found nothing cannot be told from one that found
 * something; a turn whose knowledge-base read ran only inside a plan keeps its research requirement.
 */
export function retrievedKnowledgeBaseContent(
  toolName: string,
  result: { success: boolean; metadata?: Record<string, unknown> },
): boolean {
  if (!result.success) return false;
  if (toolName === "search_knowledge_base") {
    const hits = result.metadata?.["hits"];
    return typeof hits === "number" && hits > 0;
  }
  return toolName === "use_knowledge_base";
}

/** One tool call a tool made on the turn's behalf, reported so the turn can account for it. */
export interface NestedToolCall {
  tool: string;
  success: boolean;
  workflowNotFound?: boolean;
  /**
   * For a delegation: the agent its result is from and the agents it attempted, as its own result
   * named them (delegationAgentsOf). A step or a slice that names no agent is routed, and when
   * routing finds no match the architect fallback answers it with an ephemeral agent, which no
   * grant binds: who ran cannot be read from the turn's grant (agent/directive-agent.ts).
   */
  agentName?: string;
  attemptedAgents?: string[];
}

/**
 * The agents a delegation's result names: the agent the result is from, and the agents it
 * attempted. A reporter stamps them on the nested call it reports for that delegation, and
 * run_task_graph reports them per node. Anything malformed is left out.
 */
export function delegationAgentsOf(
  metadata: Record<string, unknown> | undefined,
): Pick<NestedToolCall, "agentName" | "attemptedAgents"> {
  const agentName = metadata?.["agentName"];
  const attempted = metadata?.["attemptedAgents"];
  const attemptedAgents = Array.isArray(attempted)
    ? attempted.filter((name): name is string => typeof name === "string" && name.length > 0)
    : [];
  return {
    ...(typeof agentName === "string" && agentName.length > 0 ? { agentName } : {}),
    ...(attemptedAgents.length > 0 ? { attemptedAgents } : {}),
  };
}

/**
 * What a call a tool made on the turn's behalf contributes.
 *
 * Deliberately asymmetric with `toolCallContribution`, and the asymmetry is the honest half: the
 * loop must decide before its call returns, so it counts a delegation on the request. A reporter
 * already knows the outcome, so a delegation that was refused before any specialist ran — an
 * exhausted mission budget, a blocked tier, a saturated swarm — is not counted as orchestration
 * that happened.
 */
export function nestedCallContribution(call: NestedToolCall): ToolCallContribution & ToolResultContribution {
  const base = toolCallContribution(call.tool);
  return {
    delegations: call.success ? base.delegations : 0,
    isDelegationWait: base.isDelegationWait,
    workflowCompleted: toolResultContribution(call.tool, {
      success: call.success,
      ...(call.workflowNotFound ? { metadata: { workflowNotFound: true } } : {}),
    }).workflowCompleted,
  };
}

/** Read a tool result's reported nested calls, tolerating anything malformed. */
export function readNestedToolCalls(
  toolName: string,
  metadata: Record<string, unknown> | undefined,
): NestedToolCall[] {
  if (!NESTED_CALL_REPORTERS.has(toolName)) return [];
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
      ...delegationAgentsOf(record),
    });
  }
  return calls;
}
