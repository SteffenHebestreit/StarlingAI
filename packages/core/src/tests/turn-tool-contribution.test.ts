import { describe, expect, it } from "vitest";
import {
  DELEGATION_WAIT_TOOL_NAMES,
  nestedCallContribution,
  toolCallContribution,
  toolResultContribution,
  readNestedToolCalls,
} from "../agent/turn-tool-contribution.js";

/**
 * THE TAIL, DEFINED ONCE.
 *
 * Every tool call updates turn-level state on its way out — the delegation tally the honesty chain
 * reads, the workflow-completed flag the compliance guard reads, the per-tool budget, the
 * wall-clock credit that keeps a turn from being cut off while it waits for children. All of it was
 * inline in the turn loop, keyed on the tool the MODEL asked for, so none of it applied to the
 * steps execute_plan dispatches underneath that loop. Three review rounds found seven separate
 * instances, each in the same shape. These pin the shared definition that replaced them.
 */
describe("what a tool call contributes to the turn", () => {
  it("counts a delegation at call time, but never a workflow", () => {
    // Decided BEFORE the call, on the raw request: counting run_workflow here made a workflow that
    // never ran — an ambiguous name, an unknown scene, a recursive re-entry — read as executed
    // orchestration, which disables the honesty chain for a source-sensitive turn (audit 1303e254).
    expect(toolCallContribution("delegate_to_agent").delegations).toBe(1);
    expect(toolCallContribution("parallel_delegate").delegations).toBe(1);
    expect(toolCallContribution("run_workflow").delegations).toBe(0);
    expect(toolCallContribution("web_search").delegations).toBe(0);
  });

  it("counts a workflow only once it has actually run", () => {
    const ran = toolResultContribution("run_workflow", { success: true });
    const routingMiss = toolResultContribution("run_workflow", {
      success: true,                                   // a routing miss reports SUCCESS…
      metadata: { workflowNotFound: true },            // …and says so here (audit bd3d60dc)
    });
    expect(ran.workflowCompleted).toBe(true);
    expect(routingMiss.workflowCompleted).toBe(false);
    expect(toolResultContribution("run_workflow", { success: false }).workflowCompleted).toBe(false);
  });

  it("treats a plan's own duration as time spent waiting for children", () => {
    // execute_plan blocks on exactly the children the other five block on; it just issues them a
    // level down. Left out, a plan's waiting was never credited back and the turn was cut off
    // mid-plan — worse the better the plan was.
    expect(DELEGATION_WAIT_TOOL_NAMES.has("execute_plan")).toBe(true);
    expect(toolCallContribution("execute_plan").isDelegationWait).toBe(true);
    expect(toolCallContribution("execute_plan").delegations).toBe(0);
    expect(toolCallContribution("web_search").isDelegationWait).toBe(false);
  });

  it("gives a nested call exactly what the same call gets from the model", () => {
    // The whole point of the seam: a delegation the plan issued and one the model asked for are the
    // same event to the turn. Anything added to these functions applies to both from then on.
    for (const tool of ["delegate_to_agent", "run_workflow", "run_task_graph", "web_search"]) {
      expect(toolCallContribution(tool)).toEqual(toolCallContribution(tool));
      expect(toolResultContribution(tool, { success: true }))
        .toEqual(toolResultContribution(tool, { success: true }));
    }
  });

  it("reads reported nested calls, and ignores anything malformed", () => {
    expect(readNestedToolCalls("execute_plan", {
      nestedCalls: [
        { tool: "delegate_to_agent", success: true },
        { tool: "run_workflow", success: true, workflowNotFound: true },
        { tool: "", success: true },        // no name — nothing to account for
        "not an object",
        null,
      ],
    })).toEqual([
      { tool: "delegate_to_agent", success: true },
      { tool: "run_workflow", success: true, workflowNotFound: true },
    ]);
    expect(readNestedToolCalls("execute_plan", undefined)).toEqual([]);
    expect(readNestedToolCalls("execute_plan", { nestedCalls: "no" })).toEqual([]);
  });
});

/**
 * The REPORTER side of the seam has to stay ours. Infrastructure tools merge a remote webhook's
 * `metadata` into their result verbatim, so reading nestedCalls off any result at all would let a
 * remote endpoint forge delegations — and a forged delegation says real orchestration happened,
 * which is the signal that disables the honesty chain.
 */
describe("who may report nested calls", () => {
  const forged = { nestedCalls: [{ tool: "delegate_to_agent", success: true }] };

  it("accepts them from the plan executor and from nothing else", () => {
    expect(readNestedToolCalls("execute_plan", forged)).toHaveLength(1);
    expect(readNestedToolCalls("kubectl_get", forged)).toEqual([]);
    expect(readNestedToolCalls("http_request", forged)).toEqual([]);
    expect(readNestedToolCalls("ansible_playbook", forged)).toEqual([]);
  });

  it("does not count a delegation that was refused before any specialist ran", () => {
    // Asymmetric with the call-time rule on purpose: the loop must decide before its call returns,
    // so it counts on the request. A reporter knows the outcome, so an exhausted mission budget or
    // a blocked tier is not orchestration that happened.
    expect(nestedCallContribution({ tool: "delegate_to_agent", success: true }).delegations).toBe(1);
    expect(nestedCallContribution({ tool: "delegate_to_agent", success: false }).delegations).toBe(0);
    expect(nestedCallContribution({ tool: "run_workflow", success: true }).workflowCompleted).toBe(true);
    expect(nestedCallContribution({ tool: "run_workflow", success: true, workflowNotFound: true }).workflowCompleted).toBe(false);
  });
});
