import { describe, expect, it } from "vitest";
import { AgentSession } from "../agent/session.js";
import {
  STATE_DEPENDENT_TOOL_NAMES,
  readNestedToolCalls,
  nestedCallContribution,
  toolCallContribution,
} from "../agent/turn-tool-contribution.js";

const makeSession = () => new AgentSession({
  channel: "test",
  workspacePath: "/workspace",
  systemPrompt: "You are a test agent.",
});

/**
 * The head is the KV-cache key, and getSystemPrompt() rebuilds it from two files a turn can
 * change while it runs: the assistant personality (the orchestrator holds the tool that writes it)
 * and the agent-outcome ledger (sub-agents append to it mid-turn). Measured ~9 s of re-prefill for
 * a 31-character change. The snapshot holds the prompt still until the next turn.
 */
describe("the base prompt is snapshotted for the turn", () => {
  it("returns the same string within a turn, even when the underlying prompt changes", () => {
    const session = makeSession();
    const first = session.getTurnSystemPrompt();
    // Stand in for a mid-turn personality/outcomes write.
    (session as unknown as { getSystemPrompt: () => string }).getSystemPrompt = () => "MUTATED";
    expect(session.getTurnSystemPrompt()).toBe(first);
    expect(session.getTurnSystemPrompt()).not.toBe("MUTATED");
  });

  it("picks the change up at the next turn boundary", () => {
    const session = makeSession();
    session.getTurnSystemPrompt();
    (session as unknown as { getSystemPrompt: () => string }).getSystemPrompt = () => "MUTATED";
    session.beginTurnSystemPrompt();
    expect(session.getTurnSystemPrompt()).toBe("MUTATED");
  });
});

describe("the orchestrator's situational-awareness tools are never replayed", () => {
  it("exempts the argument-less swarm reads from the identical-arguments cache", () => {
    // Both take no arguments, so every call in a turn has the identical signature.
    expect(STATE_DEPENDENT_TOOL_NAMES.has("get_swarm_state")).toBe(true);
    expect(STATE_DEPENDENT_TOOL_NAMES.has("get_swarm_budget")).toBe(true);
  });
});

/**
 * The turn counts one tool call as one delegation, so a fan-out that dispatched three specialists
 * looked like one — and the plan-continuation directive told the model to redo steps that had
 * already run.
 */
describe("a fan-out reports its children to the turn", () => {
  it("reads one nested delegation per parallel slice", () => {
    const calls = readNestedToolCalls("parallel_delegate", {
      taskCount: 3,
      succeeded: 2,
      nestedCalls: [
        { tool: "delegate_to_agent", success: true },
        { tool: "delegate_to_agent", success: true },
        { tool: "delegate_to_agent", success: false },
      ],
    });
    expect(calls).toHaveLength(3);
    const delegations = calls.filter((c) => nestedCallContribution(c).delegations > 0);
    expect(delegations).toHaveLength(2);   // the failed slice is not orchestration that happened
  });

  it("counts a fan-out as its children, not its children plus itself", () => {
    // parallel_delegate is a delegation-counting tool AND reports its slices. Counted at call time
    // as well as per slice, a three-slice fan-out read as four delegations — one more than ran.
    expect(toolCallContribution("parallel_delegate").delegations).toBe(0);
    expect(toolCallContribution("parallel_delegate").isDelegationWait).toBe(true);   // still parent-waiting time
    expect(toolCallContribution("delegate_to_agent").delegations).toBe(1);           // a non-reporter counts itself
    const nested = readNestedToolCalls("parallel_delegate", {
      nestedCalls: [
        { tool: "delegate_to_agent", success: true },
        { tool: "delegate_to_agent", success: true },
        { tool: "delegate_to_agent", success: true },
      ],
    });
    const total = toolCallContribution("parallel_delegate").delegations
      + nested.reduce((n, c) => n + nestedCallContribution(c).delegations, 0);
    expect(total).toBe(3);
  });

  it("reads nothing from a tool that does not report children", () => {
    expect(readNestedToolCalls("web_search", { nestedCalls: [{ tool: "delegate_to_agent", success: true }] })).toEqual([]);
  });
});
