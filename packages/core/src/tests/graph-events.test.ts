/**
 * Tests for event-driven task graph execution.
 *
 * Validates that run_task_graph emits lifecycle events on the swarm bus:
 * - graph_started when a task graph begins
 * - graph_node_ready when a node's dependencies are met
 * - graph_node_blocked when a node is blocked by a failed dependency
 * - graph_completed when the graph finishes
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SwarmState } from "../tools/registry.js";
import type { SwarmEvent } from "../swarm/bus.js";

const runSubAgentMock = vi.fn(async ({ agentName, task }: { agentName: string; task: string }) => `${agentName}:${task}:done`);

vi.mock("../agent/sub-agent.js", () => ({
  runSubAgent: runSubAgentMock,
}));

describe("event-driven task graph", () => {
  beforeEach(async () => {
    runSubAgentMock.mockClear();
    vi.resetModules();
    const [{ resetSwarmBusForTests }, configLoader] = await Promise.all([
      import("../swarm/bus.js"),
      import("../config/loader.js"),
    ]);
    resetSwarmBusForTests();
    configLoader.resetConfigForTests();
  });

  afterEach(async () => {
    runSubAgentMock.mockClear();
    vi.resetModules();
    const [{ resetSwarmBusForTests }, configLoader] = await Promise.all([
      import("../swarm/bus.js"),
      import("../config/loader.js"),
    ]);
    resetSwarmBusForTests();
    configLoader.resetConfigForTests();
  });

  it("emits graph lifecycle events during task graph execution", async () => {
    runSubAgentMock.mockImplementation(async ({ agentName, task }: { agentName: string; task: string }) =>
      `${agentName}:${task}:done`,
    );

    const [{ getTool }, , { onSwarmEvent }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
      import("../swarm/bus.js"),
    ]);

    const events: SwarmEvent[] = [];
    const unsub = onSwarmEvent((event) => {
      if (event.type.startsWith("graph_") || event.type === "task_announced" || event.type === "task_claimed" || event.type === "task_completed") {
        events.push(event);
      }
    });

    const runTaskGraph = getTool("run_task_graph");
    expect(runTaskGraph).toBeDefined();

    const swarmState: SwarmState = {
      objective: "Test graph events",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: {},
    };

    const result = await runTaskGraph!.execute({
      objective: "Event test graph",
      nodes: [
        { id: "step1", agentName: "researcher", task: "Find facts" },
        { id: "step2", agentName: "summarizer", task: "Summarize", dependsOn: ["step1"] },
      ],
    }, {
      sessionId: "graph-session-1",
      workspacePath: "/workspace",
      swarmState,
    });

    expect(result.success).toBe(true);

    // Verify graph_started event
    const graphStarted = events.filter(e => e.type === "graph_started");
    expect(graphStarted).toHaveLength(1);
    expect(graphStarted[0]?.data?.["nodeCount"]).toBe(2);
    expect(graphStarted[0]?.data?.["nodeIds"]).toEqual(["step1", "step2"]);

    // Verify graph_node_ready events (one for step1, one for step2)
    const nodeReady = events.filter(e => e.type === "graph_node_ready");
    expect(nodeReady).toHaveLength(2);
    expect(nodeReady[0]?.taskId).toBe("step1");
    expect(nodeReady[1]?.taskId).toBe("step2");
    // step2 should show step1 in completedDeps
    expect(nodeReady[1]?.data?.["completedDeps"]).toContain("step1");

    // Verify graph_completed event
    const graphCompleted = events.filter(e => e.type === "graph_completed");
    expect(graphCompleted).toHaveLength(1);
    expect(graphCompleted[0]?.data?.["success"]).toBe(true);
    expect(graphCompleted[0]?.data?.["completedNodes"]).toEqual(["step1", "step2"]);
    expect(graphCompleted[0]?.data?.["failedNodes"]).toEqual([]);

    unsub();
  }, 15_000);

  it("emits graph_node_blocked when a dependency fails", async () => {
    runSubAgentMock.mockImplementation(async ({ agentName, task }: { agentName: string; task: string }) => {
      if (agentName === "researcher") return `Error: failed to find ${task}`;
      return `${agentName}:${task}:done`;
    });

    const [{ getTool }, , { onSwarmEvent }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
      import("../swarm/bus.js"),
    ]);

    const events: SwarmEvent[] = [];
    const unsub = onSwarmEvent((event) => {
      if (event.type.startsWith("graph_")) events.push(event);
    });

    const runTaskGraph = getTool("run_task_graph");
    const swarmState: SwarmState = {
      objective: "Test blocked graph",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: {},
    };

    const result = await runTaskGraph!.execute({
      objective: "Blocked test",
      nodes: [
        { id: "step1", agentName: "researcher", task: "Find data" },
        { id: "step2", agentName: "summarizer", task: "Summarize data", dependsOn: ["step1"] },
      ],
    }, {
      sessionId: "graph-session-2",
      workspacePath: "/workspace",
      swarmState,
    });

    // step1 fails, so step2 is blocked → graph has failures
    expect(result.success).toBe(false);

    // Verify blocked event
    const blockedEvents = events.filter(e => e.type === "graph_node_blocked");
    expect(blockedEvents).toHaveLength(1);
    expect(blockedEvents[0]?.taskId).toBe("step2");
    expect(blockedEvents[0]?.data?.["reason"]).toBe("dependency_failed");

    // Verify completion event shows failure
    const graphCompleted = events.filter(e => e.type === "graph_completed");
    expect(graphCompleted).toHaveLength(1);
    expect(graphCompleted[0]?.data?.["success"]).toBe(false);
    expect(graphCompleted[0]?.data?.["failedNodes"]).toContain("step1");
    expect(graphCompleted[0]?.data?.["blockedNodes"]).toContain("step2");

    unsub();
  }, 15_000);

  it("emits graph_completed with all-success for independent parallel nodes", async () => {
    runSubAgentMock.mockImplementation(async ({ agentName, task }: { agentName: string; task: string }) =>
      `${agentName}:${task}:done`,
    );

    const [{ getTool }, , { onSwarmEvent }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
      import("../swarm/bus.js"),
    ]);

    const events: SwarmEvent[] = [];
    const unsub = onSwarmEvent((event) => {
      if (event.type.startsWith("graph_")) events.push(event);
    });

    const runTaskGraph = getTool("run_task_graph");
    const swarmState: SwarmState = {
      objective: "Parallel test",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: {},
    };

    const result = await runTaskGraph!.execute({
      objective: "Parallel graph",
      nodes: [
        { id: "a", agentName: "researcher", task: "Research one" },
        { id: "b", agentName: "coder", task: "Code two" },
        { id: "c", agentName: "summarizer", task: "Summarize three" },
      ],
    }, {
      sessionId: "graph-session-3",
      workspacePath: "/workspace",
      swarmState,
    });

    expect(result.success).toBe(true);

    // All 3 nodes should be ready at the same time (no dependencies)
    const nodeReady = events.filter(e => e.type === "graph_node_ready");
    expect(nodeReady).toHaveLength(3);

    const graphCompleted = events.filter(e => e.type === "graph_completed");
    expect(graphCompleted).toHaveLength(1);
    expect(graphCompleted[0]?.data?.["completedNodes"]).toHaveLength(3);
    expect(graphCompleted[0]?.data?.["failedNodes"]).toHaveLength(0);

    unsub();
  }, 15_000);
});
