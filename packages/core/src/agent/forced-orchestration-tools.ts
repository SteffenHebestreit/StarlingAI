/**
 * The tool subset a FORCED orchestration iteration sends (tool_choice "required").
 *
 * Moved out of agent/runtime.ts verbatim (runtime.ts re-exports it, so every existing import
 * keeps working) so that the prompt-cache warm-keeper can derive the forced heads from the SAME
 * function the turn uses without importing runtime.ts, which imports the warm-keeper. A warm-up
 * that re-listed the subset by hand would drift from the turn the first time this allowlist
 * changed, and a warmed head that differs from the sent one by a single tool is worth nothing
 * (live probe E7: a switch to the subset reused 0% of the prompt, 8.3 s).
 */

/**
 * ALLOWLIST of tools that actually ADVANCE a "must orchestrate before answering"
 * turn — delegation launchers + the discovery tools that feed them. When the
 * runtime forces a tool call to COMPEL orchestration (cost-center 1), the forced
 * candidate set is restricted to THESE only.
 *
 * This is deliberately an allowlist, not a blocklist: tool_choice:"required" forces
 * SOME tool, and the slow local model otherwise satisfies it with whatever cheap
 * no-op tool is in scope and loops on it without ever delegating — first
 * memory_store (audit be828e39: ×3 → max_tool_iterations → unsourced fabrication),
 * then record_plan (audit, 5-mic probe: ×3 → "writing final from evidence" with
 * zero research). A blocklist just moves the escape hatch to the next no-op tool;
 * an allowlist closes them all, including any added later. Memory/self/plan/state
 * tools (memory_*, recall_context, record_plan, get_swarm_state, …) are excluded
 * by omission — they're still freely available on non-forced iterations.
 */
const FORCE_ORCHESTRATION_TOOLS = new Set([
  "delegate_to_agent",
  "parallel_delegate",
  "swarm_delegate",
  "run_workflow",
  "run_task_graph",
  "search_agents",
  "search_workflows",
  "list_agents",
  "create_ephemeral_agent",
  // execute_plan dispatches every step of the recorded plan — the one call that advances a
  // planned turn the most, and the one call a forced iteration could not make: the model
  // recorded a plan, was forced to delegate, and had to re-issue the plan's first step by hand.
  "execute_plan",
]);

/** Keep only orchestration/delegation tools so a forced tool call can ONLY be
 * satisfied by an action that advances the turn. Exported for testing. */
export function filterForcedOrchestrationTools<T extends { name: string }>(
  tools: readonly T[],
  plan?: { planRecorded: boolean },
): T[] {
  return tools.filter((tool) => {
    // ONE-SHOT record_plan. execute_plan can only run a plan that exists, and record_plan was
    // hidden on every forced iteration — so on a first forced iteration execute_plan was a
    // guaranteed "No plan recorded". While no plan exists the model may record one (once); the
    // moment it exists, execute_plan is the way forward and record_plan is an escape hatch again.
    if (tool.name === "record_plan") return plan?.planRecorded === false;
    if (tool.name === "execute_plan") return plan?.planRecorded !== false;
    return FORCE_ORCHESTRATION_TOOLS.has(tool.name);
  });
}
