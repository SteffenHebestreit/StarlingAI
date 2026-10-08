import { describe, expect, it } from "vitest";
import { delegationRanAgent } from "../agent/directive-agent.js";

/**
 * What releases a turn the user directed to one agent (`--agent NAME`): a tool RESULT that shows
 * the agent ran (agent/directive-agent.ts). The turn-level behaviour is in
 * runtime-directive-agent.test.ts; these pin how each result is read.
 */

const STARTED_AT = "2026-10-08T12:00:00.000Z";

/** A run_task_graph result as the tool reports it: node ids by outcome, attempts in the swarm state. */
function taskGraphResult(
  attemptsByTask: Record<string, string[]>,
  outcome: { completed?: string[]; failed?: string[]; blocked?: string[] },
): Record<string, unknown> {
  return {
    completed: outcome.completed ?? [],
    failed: outcome.failed ?? [],
    blocked: outcome.blocked ?? [],
    swarmState: {
      objective: "Swarm task graph",
      startedAt: STARTED_AT,
      updatedAt: STARTED_AT,
      tasks: Object.fromEntries(Object.entries(attemptsByTask).map(([id, agents]) => [id, {
        id,
        title: id,
        status: "completed",
        dependsOn: [],
        attempts: agents.map((agentName) => ({ agentName, status: "completed", startedAt: STARTED_AT })),
      }])),
    },
  };
}

describe("delegationRanAgent, for a task graph", () => {
  // A task graph's result names no agent of its own, and the release read only delegate_to_agent's
  // and swarm_delegate's results: a graph that had run the agent left the turn directed to it, and
  // the agent ran a second time (review of 6955e34, 2026-10-08).
  it("reads the agent a node of the graph attempted, completed or failed", () => {
    expect(delegationRanAgent("run_task_graph", taskGraphResult({ find_bug: ["code_analyst"] }, { completed: ["find_bug"] }), "code_analyst")).toBe(true);
    // A run that failed still ran.
    expect(delegationRanAgent("run_task_graph", taskGraphResult({ find_bug: ["code_analyst"] }, { failed: ["find_bug"] }), "code_analyst")).toBe(true);
  });

  it("does not count a node turned away before any agent ran, or one that ran another agent", () => {
    expect(delegationRanAgent("run_task_graph", taskGraphResult({ find_bug: [] }, { failed: ["find_bug"] }), "code_analyst")).toBe(false);
    expect(delegationRanAgent("run_task_graph", taskGraphResult({ find_bug: ["coder"] }, { completed: ["find_bug"] }), "code_analyst")).toBe(false);
  });

  it("reads only the graph's own nodes, not the rest of the turn's swarm state", () => {
    // The swarm state the result carries is the whole turn's: a task an earlier call ran is in it.
    const result = taskGraphResult({ earlier_task: ["code_analyst"], find_bug: [] }, { failed: ["find_bug"] });
    expect(delegationRanAgent("run_task_graph", result, "code_analyst")).toBe(false);
  });

  it("reads a malformed report as no run", () => {
    expect(delegationRanAgent("run_task_graph", undefined, "code_analyst")).toBe(false);
    expect(delegationRanAgent("run_task_graph", { completed: ["find_bug"] }, "code_analyst")).toBe(false);
    expect(delegationRanAgent("run_task_graph", { completed: ["find_bug"], swarmState: { tasks: null } }, "code_analyst")).toBe(false);
    expect(delegationRanAgent("run_task_graph", { completed: ["find_bug"], swarmState: { tasks: { find_bug: { attempts: "code_analyst" } } } }, "code_analyst")).toBe(false);
    expect(delegationRanAgent("run_task_graph", { completed: ["find_bug"], swarmState: { tasks: { find_bug: { attempts: [null, "code_analyst"] } } } }, "code_analyst")).toBe(false);
  });
});
