import { afterEach, describe, expect, it, vi } from "vitest";
import type { SwarmState } from "../tools/registry.js";

const runSubAgentMock = vi.fn(async ({ agentName, task }: { agentName: string; task: string }) => `${agentName}:${task}`);

vi.mock("../agent/sub-agent.js", () => ({
  runSubAgent: runSubAgentMock,
}));

describe("swarm orchestration tools", () => {
  afterEach(async () => {
    runSubAgentMock.mockClear();
    vi.resetModules();

    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
  });

  it("falls back to an alternative agent and updates swarm state", async () => {
    runSubAgentMock.mockImplementation(async ({ agentName, task }: { agentName: string; task: string }) => {
      if (agentName === "researcher") return `Error: failed to complete ${task}`;
      return `${agentName}:${task}:ok`;
    });

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const delegate = getTool("delegate_to_agent");
    expect(delegate).toBeDefined();

    const swarmState: SwarmState = {
      objective: "Find and summarize docs",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: {},
    };

    const result = await delegate!.execute({
      agentName: "researcher",
      fallbackAgents: ["retrieval_analyst"],
      task: "Find API docs",
    }, {
      sessionId: "session-1",
      workspacePath: "/workspace",
      swarmState,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("retrieval_analyst");

    const tasks = Object.values(swarmState.tasks);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.status).toBe("completed");
    expect(tasks[0]?.attempts).toHaveLength(2);
    expect(tasks[0]?.attempts[0]?.agentName).toBe("researcher");
    expect(tasks[0]?.attempts[1]?.agentName).toBe("retrieval_analyst");
  }, 30_000);

  it("treats empty delegated output as failure and uses the fallback agent", async () => {
    runSubAgentMock.mockImplementation(async ({ agentName, task }: { agentName: string; task: string }) => {
      if (agentName === "researcher") return "";
      return `${agentName}:${task}:ok`;
    });

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const delegate = getTool("delegate_to_agent");
    expect(delegate).toBeDefined();

    const swarmState: SwarmState = {
      objective: "Research MCP",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: {},
    };

    const result = await delegate!.execute({
      agentName: "researcher",
      fallbackAgents: ["retrieval_analyst"],
      task: "Find official Model Context Protocol sources",
    }, {
      sessionId: "session-empty-output",
      workspacePath: "/workspace",
      swarmState,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("retrieval_analyst");

    const tasks = Object.values(swarmState.tasks);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.attempts).toHaveLength(2);
    expect(tasks[0]?.attempts[0]?.agentName).toBe("researcher");
    expect(tasks[0]?.attempts[0]?.status).toBe("failed");
    expect(tasks[0]?.attempts[1]?.agentName).toBe("retrieval_analyst");
    expect(tasks[0]?.status).toBe("completed");
  }, 30_000);

  it("executes dependency-aware task graphs and exposes the shared swarm state", async () => {
    runSubAgentMock.mockImplementation(async ({ agentName, task }: { agentName: string; task: string }) => `${agentName}:${task}:done`);

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const runTaskGraph = getTool("run_task_graph");
    const getSwarmState = getTool("get_swarm_state");
    expect(runTaskGraph).toBeDefined();
    expect(getSwarmState).toBeDefined();

    const swarmState: SwarmState = {
      objective: "Initial",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: {},
    };

    const graphResult = await runTaskGraph!.execute({
      objective: "Research then summarize",
      nodes: [
        { id: "research", agentName: "researcher", task: "Collect facts" },
        { id: "summary", agentName: "summarizer", task: "Summarize facts", dependsOn: ["research"] },
        { id: "code", agentName: "code_analyst", task: "Inspect implementation" },
      ],
    }, {
      sessionId: "session-2",
      workspacePath: "/workspace",
      swarmState,
    });

    expect(graphResult.success).toBe(true);
    expect(runSubAgentMock).toHaveBeenCalledTimes(3);
    expect(swarmState.objective).toBe("Research then summarize");
    expect(swarmState.tasks["research"]?.status).toBe("completed");
    expect(swarmState.tasks["summary"]?.status).toBe("completed");
    expect(swarmState.tasks["summary"]?.dependsOn).toEqual(["research"]);

    const stateResult = await getSwarmState!.execute({}, {
      sessionId: "session-2",
      workspacePath: "/workspace",
      swarmState,
    });

    expect(stateResult.success).toBe(true);
    expect(stateResult.output).toContain("research [completed]");
    expect(stateResult.output).toContain("summary [completed]");
  }, 15000);

  it("reuses an identical completed swarm task instead of creating a duplicate card", async () => {
    runSubAgentMock.mockImplementation(async ({ agentName, task }: { agentName: string; task: string }) => `${agentName}:${task}:done`);

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const delegate = getTool("delegate_to_agent");
    expect(delegate).toBeDefined();

    const swarmState: SwarmState = {
      objective: "Find and summarize docs",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: {},
    };

    const first = await delegate!.execute({
      agentName: "researcher",
      task: "Find official MCP specification",
    }, {
      sessionId: "session-3",
      workspacePath: "/workspace",
      swarmState,
    });

    const second = await delegate!.execute({
      agentName: "researcher",
      task: "Find official MCP specification",
    }, {
      sessionId: "session-3",
      workspacePath: "/workspace",
      swarmState,
    });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(Object.values(swarmState.tasks)).toHaveLength(1);
    expect(runSubAgentMock).toHaveBeenCalledTimes(1);
  }, 15000);
});