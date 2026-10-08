import { describe, expect, it } from "vitest";
import { buildDirectiveDelegationContext, delegationRanAgent, isDelegationToAgent } from "../agent/directive-agent.js";
import { MID_TURN_USER_MESSAGE_METADATA } from "../agent/turn-boundary.js";

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

describe("buildDirectiveDelegationContext", () => {
  it("carries this turn's document excerpts, and no earlier turn's", () => {
    const history = [
      { role: "user", content: "Hier ist das zweite Quartal." },
      { role: "system", content: "[DOCUMENT CONTEXT]\numsatz-q2-2026.csv\nApr;Nord;9100" },
      { role: "assistant", content: "Der Umsatz im zweiten Quartal betrug 27300 EUR." },
      { role: "user", content: "Und im dritten?" },
      { role: "system", content: "[DOCUMENT CONTEXT]\numsatz-q3-2026.csv\nJul;Nord;18432" },
      // Steering arrives inside the turn as a user-role message; the turn did not start there.
      { role: "user", content: "[USER STEERING — sent mid-turn] Nur Nord.", metadata: { [MID_TURN_USER_MESSAGE_METADATA]: true } },
    ];
    const context = buildDirectiveDelegationContext(history, {}) ?? "";
    expect(context).toContain("Jul;Nord;18432");
    expect(context).not.toContain("Apr;Nord;9100");
  });

  it("bounds the exchange before this request", () => {
    const context = buildDirectiveDelegationContext([{ role: "user", content: "Und wie behebe ich das?" }], {
      priorUserRequest: `${"R".repeat(600)}REQUEST-TAIL`,
      priorAssistantAnswer: `${"A".repeat(1_500)}ANSWER-TAIL`,
    }) ?? "";
    expect(context).toContain(`Request: ${"R".repeat(600)}…`);
    expect(context).toContain(`Answer: ${"A".repeat(1_500)}…`);
    expect(context).not.toContain("REQUEST-TAIL");
    expect(context).not.toContain("ANSWER-TAIL");
  });

  it("is undefined when the request has nothing beside it", () => {
    expect(buildDirectiveDelegationContext([{ role: "user", content: "Warum fehlt ein Cent?" }], {})).toBeUndefined();
  });
});
