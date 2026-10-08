import { describe, expect, it } from "vitest";
import { buildDirectiveDelegationContext, delegationRanAgent, isDelegationToAgent, nestedCallRanAgent } from "../agent/directive-agent.js";
import { MID_TURN_USER_MESSAGE_METADATA } from "../agent/turn-boundary.js";

/**
 * What releases a turn the user directed to one agent (`--agent NAME`): a tool RESULT that shows
 * the agent ran (agent/directive-agent.ts). The turn-level behaviour is in
 * runtime-directive-agent.test.ts; these pin how each result is read.
 */

const STARTED_AT = "2026-10-08T12:00:00.000Z";

/**
 * A run_task_graph result as the tool reports it: node ids by outcome, what each node this run
 * started named as its agents (nodeRuns), and the turn's swarm state with each task's attempts.
 */
function taskGraphResult(
  nodeRuns: Record<string, { agentName?: string; attemptedAgents?: string[] }>,
  outcome: { completed?: string[]; failed?: string[]; blocked?: string[] },
  attemptsByTask: Record<string, string[]> = {},
): Record<string, unknown> {
  return {
    completed: outcome.completed ?? [],
    failed: outcome.failed ?? [],
    blocked: outcome.blocked ?? [],
    nodeRuns,
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

describe("isDelegationToAgent", () => {
  it("is delegate_to_agent naming the agent, as the tool reads the name", () => {
    // delegate_to_agent trims the name it is given.
    expect(isDelegationToAgent({ name: "delegate_to_agent", arguments: { agentName: " code_analyst ", task: "t" } }, "code_analyst")).toBe(true);
    expect(isDelegationToAgent({ name: "delegate_to_agent", arguments: { agentName: "coder", task: "t" } }, "code_analyst")).toBe(false);
    // Undirected, it lets routing choose; unparseable, it names nobody.
    expect(isDelegationToAgent({ name: "delegate_to_agent", arguments: { task: "t" } }, "code_analyst")).toBe(false);
    expect(isDelegationToAgent({ name: "delegate_to_agent", arguments: null }, "code_analyst")).toBe(false);
  });

  it("is the agent's own name called as a tool, which becomes that delegation when it runs", () => {
    expect(isDelegationToAgent({ name: "code_analyst", arguments: { task: "t" } }, "code_analyst")).toBe(true);
  });

  it("is no other tool, whatever its arguments name", () => {
    expect(isDelegationToAgent({ name: "parallel_delegate", arguments: { agentName: "code_analyst" } }, "code_analyst")).toBe(false);
    expect(isDelegationToAgent({ name: "create_ephemeral_agent", arguments: { agentName: "code_analyst" } }, "code_analyst")).toBe(false);
  });
});

describe("delegationRanAgent, for a delegation", () => {
  it("reads the agent the result is from", () => {
    expect(delegationRanAgent("delegate_to_agent", { agentName: "code_analyst" }, "code_analyst")).toBe(true);
    expect(delegationRanAgent("swarm_delegate", { agentName: "code_analyst" }, "code_analyst")).toBe(true);
  });

  it("reads the agents a run that failed attempted: it still ran", () => {
    expect(delegationRanAgent("delegate_to_agent", { attemptedAgents: ["code_analyst"], delegationSucceeded: false }, "code_analyst")).toBe(true);
  });

  it("does not count a delegation turned away before the agent ran", () => {
    // Refused for the grant (no metadata), or by a budget check before the first attempt.
    expect(delegationRanAgent("delegate_to_agent", undefined, "code_analyst")).toBe(false);
    expect(delegationRanAgent("delegate_to_agent", { attemptedAgents: [], budgetExhausted: true }, "code_analyst")).toBe(false);
    expect(delegationRanAgent("delegate_to_agent", { agentName: "coder", attemptedAgents: ["coder"] }, "code_analyst")).toBe(false);
  });

  it("does not read another tool's result, whatever its metadata names", () => {
    // An infrastructure tool merges a remote endpoint's metadata into its result.
    expect(delegationRanAgent("vm_manage", { agentName: "code_analyst", attemptedAgents: ["code_analyst"] }, "code_analyst")).toBe(false);
    // An ephemeral agent is not the agent the user named.
    expect(delegationRanAgent("create_ephemeral_agent", { agentName: "code_analyst" }, "code_analyst")).toBe(false);
  });
});

describe("delegationRanAgent, for a task graph", () => {
  // A task graph's result names no agent of its own, and the release read only delegate_to_agent's
  // and swarm_delegate's results: a graph that had run the agent left the turn directed to it, and
  // the agent ran a second time (review of 6955e34, 2026-10-08).
  it("reads the agents a node of this run named, completed or failed", () => {
    expect(delegationRanAgent("run_task_graph", taskGraphResult({ find_bug: { agentName: "code_analyst", attemptedAgents: ["code_analyst"] } }, { completed: ["find_bug"] }), "code_analyst")).toBe(true);
    // A run that failed still ran.
    expect(delegationRanAgent("run_task_graph", taskGraphResult({ find_bug: { attemptedAgents: ["code_analyst"] } }, { failed: ["find_bug"] }), "code_analyst")).toBe(true);
  });

  it("does not count a node turned away before any agent ran, or one that ran another agent", () => {
    expect(delegationRanAgent("run_task_graph", taskGraphResult({ find_bug: {} }, { failed: ["find_bug"] }), "code_analyst")).toBe(false);
    expect(delegationRanAgent("run_task_graph", taskGraphResult({ find_bug: { agentName: "coder", attemptedAgents: ["coder"] } }, { completed: ["find_bug"] }), "code_analyst")).toBe(false);
    // An ephemeral agent the architect built for a node that named none.
    expect(delegationRanAgent("run_task_graph", taskGraphResult({ find_bug: { agentName: "menu_planner" } }, { completed: ["find_bug"] }), "code_analyst")).toBe(false);
  });

  it("does not read the swarm state, whose tasks may have been carried in from an earlier turn", () => {
    // The turn's swarm state is seeded with the previous turn's tasks, attempts included, and a node
    // whose id repeats one of them keeps that task's attempts. Node n1 was turned away this turn
    // before any agent ran, and the swarm state still showed code_analyst's attempt from the turn
    // before: the directive was released and code_analyst never ran (review of faeee22, 2026-10-08).
    const result = taskGraphResult({ n1: {} }, { failed: ["n1"] }, { n1: ["code_analyst"], earlier_task: ["code_analyst"] });
    expect(delegationRanAgent("run_task_graph", result, "code_analyst")).toBe(false);
  });

  it("reads a malformed report as no run", () => {
    expect(delegationRanAgent("run_task_graph", undefined, "code_analyst")).toBe(false);
    expect(delegationRanAgent("run_task_graph", { completed: ["find_bug"] }, "code_analyst")).toBe(false);
    expect(delegationRanAgent("run_task_graph", { completed: ["find_bug"], nodeRuns: null }, "code_analyst")).toBe(false);
    expect(delegationRanAgent("run_task_graph", { completed: ["find_bug"], nodeRuns: { find_bug: "code_analyst" } }, "code_analyst")).toBe(false);
    expect(delegationRanAgent("run_task_graph", { completed: ["find_bug"], nodeRuns: { find_bug: { attemptedAgents: "code_analyst" } } }, "code_analyst")).toBe(false);
  });
});

describe("nestedCallRanAgent: a plan step or a fan-out slice", () => {
  // A step or a slice that names no agent is routed within the turn's grant, and when routing finds
  // no match the architect fallback, which no grant binds, answers with an ephemeral agent. The
  // release counted every nested delegation that succeeded as the named agent's, so an ephemeral
  // agent's answer released the directive and the named agent never ran (review of 6955e34,
  // 2026-10-08).
  it("reads the agent the delegation's own result is from, or one it attempted", () => {
    expect(nestedCallRanAgent({ tool: "delegate_to_agent", success: true, agentName: "code_analyst", attemptedAgents: ["code_analyst"] }, "code_analyst")).toBe(true);
    // A run that failed still ran.
    expect(nestedCallRanAgent({ tool: "delegate_to_agent", success: false, attemptedAgents: ["code_analyst"] }, "code_analyst")).toBe(true);
  });

  it("does not count a delegation an ephemeral agent answered, or one that names no agent", () => {
    expect(nestedCallRanAgent({ tool: "delegate_to_agent", success: true, agentName: "menu_planner" }, "code_analyst")).toBe(false);
    expect(nestedCallRanAgent({ tool: "delegate_to_agent", success: true }, "code_analyst")).toBe(false);
  });

  it("does not count a call of another tool, whatever it names", () => {
    expect(nestedCallRanAgent({ tool: "run_workflow", success: true, agentName: "code_analyst" }, "code_analyst")).toBe(false);
  });
});

describe("buildDirectiveDelegationContext", () => {
  it("hands over this turn's document excerpts, and no earlier turn's", () => {
    const history = [
      { role: "user", content: "Hier ist das zweite Quartal." },
      { role: "system", content: "[DOCUMENT CONTEXT]\numsatz-q2-2026.csv\nApr;Nord;9100" },
      { role: "assistant", content: "Der Umsatz im zweiten Quartal betrug 27300 EUR." },
      { role: "user", content: "Und im dritten?" },
      { role: "system", content: "[DOCUMENT CONTEXT]\numsatz-q3-2026.csv\nJul;Nord;18432" },
      // Steering arrives inside the turn as a user-role message; the turn did not start there.
      { role: "user", content: "[USER STEERING — sent mid-turn] Nur Nord.", metadata: { [MID_TURN_USER_MESSAGE_METADATA]: true } },
    ];
    const { context, documents } = buildDirectiveDelegationContext(history, {});
    expect(documents).toContain("Jul;Nord;18432");
    expect(documents).not.toContain("Apr;Nord;9100");
    // Kept apart from the call's own context, which is recorded with the call: the session history,
    // the audit and the transcript kept a CSV's rows long after the [DOCUMENT CONTEXT] note was
    // pruned at the next turn (review of bf095a1, 2026-10-08).
    expect(context).toBeUndefined();
  });

  it("bounds the exchange before this request", () => {
    const { context = "", documents } = buildDirectiveDelegationContext([{ role: "user", content: "Und wie behebe ich das?" }], {
      priorUserRequest: `${"R".repeat(600)}REQUEST-TAIL`,
      priorAssistantAnswer: `${"A".repeat(1_500)}ANSWER-TAIL`,
    });
    expect(documents).toBeUndefined();
    expect(context).toContain(`Request: ${"R".repeat(600)}…`);
    expect(context).toContain(`Answer: ${"A".repeat(1_500)}…`);
    expect(context).not.toContain("REQUEST-TAIL");
    expect(context).not.toContain("ANSWER-TAIL");
  });

  it("hands over nothing when the request has nothing beside it", () => {
    expect(buildDirectiveDelegationContext([{ role: "user", content: "Warum fehlt ein Cent?" }], {})).toEqual({});
  });
});
