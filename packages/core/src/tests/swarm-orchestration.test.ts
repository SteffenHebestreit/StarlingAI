import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SwarmState } from "../tools/registry.js";
import type { SubAgentRunOptions, SubAgentRunResult } from "../agent/sub-agent.js";

const runSubAgentMock = vi.fn(async ({ agentName, task }: SubAgentRunOptions) => `${agentName}:${task}`);
const runSubAgentWithStatsMock = vi.fn(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => ({
  output: await runSubAgentMock(args),
  stats: {
    agentName: args.agentName,
    sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
    promptChars: 0,
    userContentChars: String(args.task ?? "").length,
    toolCount: 0,
    toolNames: [],
    iterations: 0,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    maxIterations: 5,
    model: "mock",
    capabilities: [],
    terminalState: "completed" as const,
  },
}));

vi.mock("../agent/sub-agent.js", () => ({
  runSubAgent: runSubAgentMock,
  runSubAgentWithStats: runSubAgentWithStatsMock,
}));

describe("swarm orchestration tools", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    delete process.env["SAI_CONFIG_PATH"];
    vi.resetModules();
    const { resetConfigForTests } = await import("../config/loader.js");
    resetConfigForTests();
    runSubAgentMock.mockClear();
    runSubAgentWithStatsMock.mockClear();
    runSubAgentWithStatsMock.mockImplementation(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => ({
      output: await runSubAgentMock(args),
      stats: {
        agentName: args.agentName,
        sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
        promptChars: 0,
        userContentChars: String(args.task ?? "").length,
        toolCount: 0,
        toolNames: [],
        iterations: 0,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        maxIterations: 5,
        model: "mock",
        capabilities: [],
        terminalState: "completed",
      },
    }));
    vi.resetModules();
    const memory = await import("../swarm/memory.js");
    await memory.resetSharedMemoryForTests();

    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
  });

  it("falls back to an alternative agent and updates swarm state", async () => {
    runSubAgentMock.mockImplementation(async ({ agentName, task }: SubAgentRunOptions) => {
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

  it("treats sub-agent exit-code stubs as failures and continues to fallback agents", async () => {
    runSubAgentWithStatsMock.mockImplementation(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => {
      if (args.agentName === "web_task_coordinator") {
        return {
          output: "Sub-agent 'web_task_coordinator' exited with code 125. Output:",
          stats: {
            agentName: args.agentName,
            sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
            promptChars: 0,
            userContentChars: String(args.task ?? "").length,
            toolCount: 0,
            toolNames: [],
            iterations: 0,
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            maxIterations: 5,
            model: "mock",
            capabilities: [],
            terminalState: "completed",
            outcome: "success",
          },
        };
      }

      return {
        output: `${args.agentName}: gathered live headlines`,
        stats: {
          agentName: args.agentName,
          sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
          promptChars: 0,
          userContentChars: String(args.task ?? "").length,
          toolCount: 2,
          toolNames: ["web_search", "web_fetch"],
          iterations: 1,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          maxIterations: 5,
          model: "mock",
          capabilities: [],
          terminalState: "completed",
          outcome: "success",
        },
      };
    });

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const delegate = getTool("delegate_to_agent");
    expect(delegate).toBeDefined();

    const result = await delegate!.execute({
      agentName: "web_task_coordinator",
      fallbackAgents: ["researcher"],
      task: "Ermittle die aktuellen Top-Headlines von heute.",
    }, {
      sessionId: "session-exit-code-fallback",
      workspacePath: "/workspace",
      swarmState: {
        objective: "Fetch headlines",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tasks: {},
      },
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("researcher");
    expect(result.metadata?.["attemptedAgents"]).toEqual(["web_task_coordinator", "researcher"]);
    expect(runSubAgentWithStatsMock.mock.calls.map((call) => call[0].agentName)).toEqual(["web_task_coordinator", "researcher"]);
  }, 30_000);

  it("reuses session/task memory for duplicate research delegations instead of spawning another researcher", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-swarm-memory-reuse-"));
    tempDirs.push(tempDir);

    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      agents: {
        defaults: {
          model: { primary: "mock-model" },
        },
      },
      subAgents: {
        researcher: {
          description: "Research specialist.",
          tools: ["web_search", "web_fetch"],
          capabilities: ["research", "documentation lookup"],
          maxIterations: 4,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const memory = await import("../swarm/memory.js");
    await memory.writeSharedFact(
      "session-memory-reuse",
      "a2a_protocol_sources",
      "A2A Protocol Primary Sources: official specification https://a2a-protocol.org/latest/specification/ and repository https://github.com/a2aproject/A2A",
    );
    await memory.appendPartialResult({
      sessionId: "session-memory-reuse",
      taskId: "task_a2a_sources",
      agentName: "researcher",
      content: "A2A official specification: https://a2a-protocol.org/latest/specification/ ; GitHub repository: https://github.com/a2aproject/A2A",
      ts: new Date().toISOString(),
    });

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const delegate = getTool("delegate_to_agent");
    expect(delegate).toBeDefined();

    const swarmState: SwarmState = {
      objective: "Find A2A sources",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: {},
    };

    const result = await delegate!.execute({
      agentName: "researcher",
      task: "Find citation-grade primary sources for the A2A protocol and summarize the official specification.",
      routingQuery: "A2A protocol official specification primary sources",
    }, {
      sessionId: "session-memory-reuse",
      workspacePath: "/workspace",
      swarmState,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Reused relevant session/task memory");
    expect(result.output).toContain("a2a_protocol_sources");
    expect(result.metadata?.["reusedFromSessionMemory"]).toBe(true);
    expect(runSubAgentWithStatsMock).not.toHaveBeenCalled();
    expect(Object.values(swarmState.tasks)).toHaveLength(1);
    expect(Object.values(swarmState.tasks)[0]?.status).toBe("completed");
  }, 30_000);

  it("reuses protocol facts for punctuation-heavy multilingual research retries", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "starlingai-memory-reuse-multilingual-"));
    tempDirs.push(tempDir);

    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      workspacePath: tempDir,
      agents: {
        defaults: {
          model: { primary: "mock-model" },
        },
      },
      subAgents: {
        researcher: {
          description: "Research specialist.",
          tools: ["web_search", "web_fetch"],
          capabilities: ["research", "documentation lookup"],
          maxIterations: 4,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const memory = await import("../swarm/memory.js");
    await memory.writeSharedFact(
      "session-memory-reuse-multilingual",
      "a2a_protocol_v1_official_spec",
      "A2A Protocol v1.0 official specification for agent to agent communication over HTTP and gRPC.",
    );
    await memory.writeSharedFact(
      "session-memory-reuse-multilingual",
      "a2a_github_repository",
      "Official GitHub repository for the A2A protocol with SDKs, samples, and implementation guidance.",
    );
    await memory.appendPartialResult({
      sessionId: "session-memory-reuse-multilingual",
      taskId: "evidence_gather_a2a",
      agentName: "researcher",
      content: "A2A official specification, GitHub repository, and enterprise feature documentation were already collected for the protocol comparison paper.",
      ts: new Date().toISOString(),
    });

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const delegate = getTool("delegate_to_agent");
    expect(delegate).toBeDefined();

    const result = await delegate!.execute({
      agentName: "researcher",
      task: "Sammle aktuelle, zitierfahige Quellen zum Agent-to-Agent (A2A) Protokoll - Standards, Implementierungen, Use Cases.",
    }, {
      sessionId: "session-memory-reuse-multilingual",
      workspacePath: tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Reused relevant session/task memory");
    expect(result.output).toContain("a2a_protocol_v1_official_spec");
    expect(result.output).toContain("a2a_github_repository");
    expect(result.metadata?.["reusedFromSessionMemory"]).toBe(true);
    expect(runSubAgentWithStatsMock).not.toHaveBeenCalled();
  }, 30_000);

  it("ignores undefined fallback agents instead of attempting them", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-swarm-delegate-"));
    tempDirs.push(tempDir);

    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      agents: {
        defaults: {
          model: { primary: "mock-model" },
        },
      },
      subAgents: {
        researcher: {
          description: "Research specialist.",
          tools: ["web_search"],
          maxIterations: 4,
        },
        retrieval_analyst: {
          description: "Retrieval analyst.",
          tools: ["read_file"],
          maxIterations: 4,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    runSubAgentMock.mockImplementation(async ({ agentName, task }: SubAgentRunOptions) => {
      if (agentName === "researcher") return `Error: failed to complete ${task}`;
      return `${agentName}:${task}:ok`;
    });

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);
    const delegate = getTool("delegate_to_agent");
    expect(delegate).toBeDefined();

    const result = await delegate!.execute({
      agentName: "researcher",
      fallbackAgents: ["vulnerability_analyst", "retrieval_analyst"],
      task: "Find API docs",
    }, {
      sessionId: "session-invalid-fallback",
      workspacePath: "/workspace",
      swarmState: {
        objective: "Find API docs",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tasks: {},
      },
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("retrieval_analyst");
    expect(result.metadata?.["attemptedAgents"]).toEqual(["researcher", "retrieval_analyst"]);
    expect(runSubAgentWithStatsMock.mock.calls.map((call) => call[0].agentName)).toEqual(["researcher", "retrieval_analyst"]);
  }, 30_000);

  it("drops an unknown explicit agent name and auto-routes the task instead of failing immediately", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-swarm-unknown-explicit-"));
    tempDirs.push(tempDir);

    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      agents: {
        defaults: {
          model: { primary: "mock-model" },
        },
      },
      subAgents: {
        researcher: {
          description: "Research specialist for official protocol documentation.",
          capabilities: ["research", "documentation lookup", "web analysis"],
          tools: ["web_search", "web_fetch"],
          maxIterations: 4,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    runSubAgentWithStatsMock.mockImplementation(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => ({
      output: `${args.agentName}: gathered protocol sources for ${args.task}`,
      stats: {
        agentName: args.agentName,
        sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
        promptChars: 0,
        userContentChars: String(args.task ?? "").length,
        toolCount: 1,
        toolNames: ["web_search"],
        iterations: 1,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        maxIterations: 5,
        model: "mock",
        capabilities: [],
        terminalState: "completed",
        outcome: "success",
      },
    }));

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);
    const delegate = getTool("delegate_to_agent");
    expect(delegate).toBeDefined();

    const swarmState: SwarmState = {
      objective: "Collect MCP sources",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: {},
    };

    const result = await delegate!.execute({
      agentName: "research_coordinator",
      task: "Recherchiere aktuelle Informationen zu MCP und sammle offizielle Quellen.",
      routingQuery: "MCP official sources protocol research",
    }, {
      sessionId: "session-unknown-explicit",
      workspacePath: "/workspace",
      swarmState,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("researcher");
    expect(result.output).not.toContain("research_coordinator");
    expect(runSubAgentWithStatsMock).toHaveBeenCalledTimes(1);
    expect(runSubAgentWithStatsMock.mock.calls[0]?.[0]?.agentName).toBe("researcher");
    expect(Object.values(swarmState.tasks)).toHaveLength(1);
    expect(Object.values(swarmState.tasks)[0]?.status).toBe("completed");
  }, 30_000);

  it("auto-routes unknown explicit agents inside parallel_delegate instead of dropping the research task", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-parallel-unknown-explicit-"));
    tempDirs.push(tempDir);

    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      agents: {
        defaults: {
          model: { primary: "mock-model" },
        },
      },
      subAgents: {
        paper_author: {
          description: "Paper drafting specialist.",
          capabilities: ["paper drafting", "reports"],
          tools: ["read_shared_facts", "generate_document"],
          maxIterations: 4,
        },
        researcher: {
          description: "Research specialist for official protocol documentation.",
          capabilities: ["research", "documentation lookup", "web analysis"],
          tools: ["web_search", "web_fetch"],
          maxIterations: 4,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    runSubAgentWithStatsMock.mockImplementation(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => ({
      output: `${args.agentName}: completed ${args.task}`,
      stats: {
        agentName: args.agentName,
        sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
        promptChars: 0,
        userContentChars: String(args.task ?? "").length,
        toolCount: args.agentName === "researcher" ? 1 : 0,
        toolNames: args.agentName === "researcher" ? ["web_search"] : [],
        iterations: 1,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        maxIterations: 5,
        model: "mock",
        capabilities: [],
        terminalState: "completed",
        outcome: "success",
      },
    }));

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);
    const parallelDelegate = getTool("parallel_delegate");
    expect(parallelDelegate).toBeDefined();

    const swarmState: SwarmState = {
      objective: "Research and draft protocol paper",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: {},
    };

    const result = await parallelDelegate!.execute({
      tasks: [
        {
          agentName: "paper_author",
          task: "Schreibe eine kurze Struktur fuer das Paper.",
        },
        {
          agentName: "research_coordinator",
          task: "Recherchiere aktuelle Informationen zu MCP, A2A und AG-UI.",
          routingQuery: "MCP A2A AG-UI protocol official sources research",
        },
      ],
    }, {
      sessionId: "session-parallel-unknown-explicit",
      workspacePath: "/workspace",
      swarmState,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("paper_author");
    expect(result.output).toContain("researcher");
    expect(result.output).not.toContain("is not defined in config.subAgents");
    expect(runSubAgentWithStatsMock).toHaveBeenCalledTimes(2);
    expect(runSubAgentWithStatsMock.mock.calls.map((call) => call[0]?.agentName)).toEqual([
      "paper_author",
      "researcher",
    ]);
  }, 30_000);

  it("keeps earlier parallel task statuses when a later parallel batch fails", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-parallel-task-ids-"));
    tempDirs.push(tempDir);

    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      agents: {
        defaults: {
          model: { primary: "mock-model" },
        },
      },
      subAgents: {
        researcher: {
          description: "Research and citation lookup specialist.",
          capabilities: ["official source lookup", "web research"],
          tools: ["web_search", "web_fetch"],
          maxIterations: 4,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    runSubAgentWithStatsMock.mockImplementation(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => {
      const taskText = String(args.task ?? "");
      const failed = taskText.includes("Second batch");
      return {
        output: failed
          ? "Error: source lookup still incomplete."
          : `Collected verified sources for ${taskText}`,
        stats: {
          agentName: args.agentName,
          sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
          promptChars: 0,
          userContentChars: taskText.length,
          toolCount: failed ? 1 : 2,
          toolNames: failed ? ["web_search"] : ["web_search", "web_fetch"],
          iterations: 1,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          maxIterations: 5,
          model: "mock",
          capabilities: [],
          terminalState: "completed",
          outcome: failed ? "failure" : "success",
        },
      };
    });

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);
    const parallelDelegate = getTool("parallel_delegate");
    expect(parallelDelegate).toBeDefined();

    const swarmState: SwarmState = {
      objective: "Compare protocol sources across multiple parallel batches",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: {},
    };

    const first = await parallelDelegate!.execute({
      tasks: [
        {
          agentName: "researcher",
          task: "First batch MCP sources",
        },
        {
          agentName: "researcher",
          task: "First batch A2A sources",
        },
      ],
    }, {
      sessionId: "session-parallel-ids",
      workspacePath: "/workspace",
      swarmState,
    });

    const second = await parallelDelegate!.execute({
      tasks: [
        {
          agentName: "researcher",
          task: "Second batch A2A retry",
        },
        {
          agentName: "researcher",
          task: "Second batch AG-UI retry",
        },
      ],
    }, {
      sessionId: "session-parallel-ids",
      workspacePath: "/workspace",
      swarmState,
    });

    expect(first.success).toBe(true);
    expect(second.success).toBe(false);
    expect(Object.keys(swarmState.tasks)).toEqual([
      "parallel_1",
      "parallel_2",
      "parallel_3",
      "parallel_4",
    ]);
    expect(swarmState.tasks["parallel_1"]?.title).toContain("First batch MCP sources");
    expect(swarmState.tasks["parallel_1"]?.status).toBe("completed");
    expect(swarmState.tasks["parallel_2"]?.title).toContain("First batch A2A sources");
    expect(swarmState.tasks["parallel_2"]?.status).toBe("completed");
    expect(swarmState.tasks["parallel_3"]?.title).toContain("Second batch A2A retry");
    expect(swarmState.tasks["parallel_3"]?.status).toBe("failed");
    expect(swarmState.tasks["parallel_4"]?.title).toContain("Second batch AG-UI retry");
    expect(swarmState.tasks["parallel_4"]?.status).toBe("failed");
  }, 30_000);

  it("forwards allowedAgents scope into delegated sub-agent runs", async () => {
    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const delegate = getTool("delegate_to_agent");
    expect(delegate).toBeDefined();

    const swarmState: SwarmState = {
      objective: "Coordinate scoped work",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: {},
    };

    const result = await delegate!.execute({
      agentName: "project_planner",
      task: "Plan a scoped maintenance task.",
    }, {
      sessionId: "session-allowed-scope",
      workspacePath: "/workspace",
      swarmState,
      allowedAgents: ["project_planner", "coder"],
    });

    expect(result.success).toBe(true);
    expect(runSubAgentWithStatsMock).toHaveBeenCalledTimes(1);
    expect(runSubAgentWithStatsMock.mock.calls[0]?.[0]).toMatchObject({
      agentName: "project_planner",
      allowedAgents: ["project_planner", "coder"],
    });
  });

  it("forwards shared delegation budget state into delegated sub-agent runs", async () => {
    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const delegate = getTool("delegate_to_agent");
    expect(delegate).toBeDefined();

    const swarmState: SwarmState = {
      objective: "Coordinate nested work",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: {},
    };
    const sharedCounts = new Map<string, number>([["researcher", 1]]);
    const repeatLimitOverrides = { researcher: 4 };
    const onSwarmState = vi.fn();

    const result = await delegate!.execute({
      agentName: "project_planner",
      task: "Plan nested specialist work.",
    }, {
      sessionId: "session-shared-budget",
      workspacePath: "/workspace",
      swarmState,
      onSwarmState,
      _turnAgentCounts: sharedCounts,
      _turnAgentRepeatLimitOverrides: repeatLimitOverrides,
      _turnTotalDelegationLimitOverride: 9,
    });

    expect(result.success).toBe(true);
    expect(runSubAgentWithStatsMock).toHaveBeenCalledTimes(1);
    expect(runSubAgentWithStatsMock.mock.calls[0]?.[0]?._turnAgentCounts).toBe(sharedCounts);
    expect(runSubAgentWithStatsMock.mock.calls[0]?.[0]?._turnAgentRepeatLimitOverrides).toBe(repeatLimitOverrides);
    expect(runSubAgentWithStatsMock.mock.calls[0]?.[0]?._turnTotalDelegationLimitOverride).toBe(9);
    expect(runSubAgentWithStatsMock.mock.calls[0]?.[0]?.swarmState).toBe(swarmState);
    expect(runSubAgentWithStatsMock.mock.calls[0]?.[0]?.onSwarmState).toBe(onSwarmState);
  });

  it("does not let search_agents suggest the invoking coordinator itself", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-search-agents-self-exclude-"));
    tempDirs.push(tempDir);

    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      agents: {
        defaults: {
          model: {
            primary: "mock-model",
          },
        },
      },
      subAgents: {
        web_task_coordinator: {
          description: "Coordinator for freshness-sensitive web tasks that need research, browser interaction, and evidence synthesis.",
          capabilities: ["multi-agent coordination", "web retrieval", "browser orchestration", "evidence synthesis", "web analysis"],
          tags: ["coordination", "web", "browser", "research", "analysis"],
          tools: ["search_agents", "delegate_to_agent"],
        },
        researcher: {
          description: "Research specialist for architecture and web analysis.",
          capabilities: ["research", "web analysis", "architecture review"],
          tags: ["research", "analysis"],
          tools: ["read_file"],
        },
        evidence_analyst: {
          description: "Evidence synthesis specialist.",
          capabilities: ["analysis", "evidence synthesis"],
          tags: ["analysis"],
          tools: ["read_file"],
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const [{ getTool }, { resetConfigForTests }] = await Promise.all([
      import("../tools/registry.js"),
      import("../config/loader.js"),
      import("../tools/sub-agent.js"),
    ]);
    resetConfigForTests();

    const searchAgents = getTool("search_agents");
    expect(searchAgents).toBeDefined();

    const result = await searchAgents!.execute({
      query: "researcher web analysis architecture",
    }, {
      sessionId: "session-self-exclude",
      workspacePath: tempDir,
      currentAgentName: "web_task_coordinator",
    });

    expect(result.success).toBe(true);
    expect(result.output).not.toContain('delegate_to_agent(agentName="web_task_coordinator"');
    expect(result.output).toContain("Self excluded from routing suggestions: web_task_coordinator");
  });

  it("clamps search_agents minConfidence=high back to medium", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-search-agents-confidence-"));
    tempDirs.push(tempDir);

    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      workspacePath: tempDir,
      agents: {
        defaults: {
          model: {
            primary: "mock-model",
          },
        },
      },
      subAgents: {
        researcher: {
          description: "General-purpose web research specialist for public web lookup, documentation, news, security advisories, CVE tracking, and vulnerability reports.",
          capabilities: ["web research", "documentation lookup", "security advisory research", "CVE lookup"],
          tags: ["research", "security", "cve", "vulnerability"],
          tools: ["web_search", "web_fetch"],
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const [{ getTool }, { resetConfigForTests }] = await Promise.all([
      import("../tools/registry.js"),
      import("../config/loader.js"),
      import("../tools/sub-agent.js"),
    ]);
    resetConfigForTests();

    const searchAgents = getTool("search_agents");
    expect(searchAgents).toBeDefined();

    const result = await searchAgents!.execute({
      query: "security researcher CVE vulnerability",
      minConfidence: "high",
    }, {
      sessionId: "session-confidence-clamp",
      workspacePath: tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('delegate_to_agent(agentName="researcher"');
    expect(result.output).not.toContain("with high confidence or better");
  });

  it("treats empty delegated output as failure and uses the fallback agent", async () => {
    runSubAgentMock.mockImplementation(async ({ agentName, task }: SubAgentRunOptions) => {
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

  it("treats placeholder no-response delegated output as failure and uses the fallback agent", async () => {
    runSubAgentWithStatsMock.mockImplementation(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => {
      if (args.agentName === "researcher") {
        return {
          output: "Sub-agent produced no final response.",
          stats: {
            agentName: args.agentName,
            sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
            promptChars: 0,
            userContentChars: String(args.task ?? "").length,
            toolCount: 0,
            toolNames: [],
            iterations: 1,
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            maxIterations: 5,
            model: "mock",
            capabilities: [],
            outcome: "success",
            terminalState: "completed",
          },
        };
      }

      return {
        output: `${args.agentName}:${args.task}:ok`,
        stats: {
          agentName: args.agentName,
          sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
          promptChars: 0,
          userContentChars: String(args.task ?? "").length,
          toolCount: 0,
          toolNames: [],
          iterations: 0,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          maxIterations: 5,
          model: "mock",
          capabilities: [],
          outcome: "success",
          terminalState: "completed",
        },
      };
    });

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const delegate = getTool("delegate_to_agent");
    expect(delegate).toBeDefined();

    const swarmState: SwarmState = {
      objective: "Research improvements",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: {},
    };

    const result = await delegate!.execute({
      agentName: "researcher",
      fallbackAgents: ["retrieval_analyst"],
      task: "Research how StarlingAI can improve itself",
    }, {
      sessionId: "session-placeholder-output",
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

  it("treats planning-only completed delegation output as failure and uses the fallback agent", async () => {
    runSubAgentWithStatsMock.mockImplementation(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => {
      if (args.agentName === "researcher") {
        return {
          output: "Let me get the remaining critical datasheet pages for electrical specs and pricing details.",
          stats: {
            agentName: args.agentName,
            sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
            promptChars: 0,
            userContentChars: String(args.task ?? "").length,
            toolCount: 5,
            toolNames: ["web_search", "web_fetch"],
            iterations: 5,
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            maxIterations: 5,
            model: "mock",
            capabilities: [],
            outcome: "success",
            terminalState: "completed",
          },
        };
      }

      return {
        output: `${args.agentName}:${args.task}:ok`,
        stats: {
          agentName: args.agentName,
          sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
          promptChars: 0,
          userContentChars: String(args.task ?? "").length,
          toolCount: 0,
          toolNames: [],
          iterations: 0,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          maxIterations: 5,
          model: "mock",
          capabilities: [],
          outcome: "success",
          terminalState: "completed",
        },
      };
    });

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const delegate = getTool("delegate_to_agent");
    expect(delegate).toBeDefined();

    const swarmState: SwarmState = {
      objective: "Research MCP source metadata",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: {},
    };

    const result = await delegate!.execute({
      agentName: "researcher",
      fallbackAgents: ["retrieval_analyst"],
      task: "Research exact microphone specs, reviews, known issues, pricing, and availability.",
    }, {
      sessionId: "session-planning-fetch-output",
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

  it("redirects broad hardware verification away from web_task_coordinator", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "starlingai-swarm-hardware-routing-"));
    tempDirs.push(workspacePath);
    const configPath = join(workspacePath, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      workspacePath,
      agents: {
        defaults: {
          model: {
            primary: "lmstudio/qwen3.5-4b",
            contextWindow: 32768,
            temperature: 0.3,
            maxTokens: 4096,
          },
        },
      },
      subAgents: {
        web_task_coordinator: {
          description: "Coordinates live web and browser tasks.",
          tools: ["web_search", "web_fetch", "parallel_delegate"],
          tags: ["coordination"],
        },
        mission_coordinator: {
          description: "Coordinates source-grounded research and final synthesis.",
          tools: ["delegate_to_agent", "parallel_delegate", "share_finding"],
          tags: ["coordination"],
        },
        researcher: {
          description: "Researches external sources.",
          tools: ["web_search", "web_fetch"],
        },
      },
    }));
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    runSubAgentWithStatsMock.mockImplementation(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => ({
      output: `${args.agentName}: verified hardware findings with cited datasheets and pricing notes.`,
      stats: {
        agentName: args.agentName,
        sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
        promptChars: 0,
        userContentChars: String(args.task ?? "").length,
        toolCount: 3,
        toolNames: ["web_search", "web_fetch", "share_finding"],
        iterations: 2,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        maxIterations: 5,
        model: "mock",
        capabilities: [],
        outcome: "success",
        terminalState: "completed",
      },
    }));

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const delegate = getTool("delegate_to_agent");
    expect(delegate).toBeDefined();

    const result = await delegate!.execute({
      agentName: "web_task_coordinator",
      fallbackAgents: ["researcher"],
      task: "Validate and verify the portable ESP32 recorder hardware findings online, include improvements, product suggestions, datasheets, pricing, and availability.",
    }, {
      sessionId: "session-hardware-verification-routing",
      workspacePath,
      swarmState: {
        objective: "Verify hardware findings",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tasks: {},
      },
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("mission_coordinator");
    expect(runSubAgentWithStatsMock.mock.calls[0]?.[0].agentName).toBe("mission_coordinator");
    expect(runSubAgentWithStatsMock).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("adds maintenance fallbacks automatically for swarm_maintainer", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "starlingai-swarm-maintainer-"));
    tempDirs.push(workspacePath);
    const configPath = join(workspacePath, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      workspacePath,
      agents: {
        defaults: {
          model: {
            primary: "lmstudio/qwen3.5-4b",
            contextWindow: 32768,
            temperature: 0.3,
            maxTokens: 4096,
          },
        },
      },
      subAgents: {
        swarm_maintainer: {
          description: "Maintains the swarm",
          tools: ["read_file", "write_file"],
          capabilities: ["maintenance"],
          tags: ["swarm"],
        },
        integration_builder: {
          description: "Integration specialist",
          tools: ["read_file", "write_file", "shell_exec"],
          capabilities: ["integration"],
          tags: ["integration"],
        },
        coder: {
          description: "Coding specialist",
          tools: ["read_file", "write_file"],
          capabilities: ["code"],
          tags: ["code"],
        },
        prompt_optimizer: {
          description: "Prompt specialist",
          tools: ["read_file", "write_file"],
          capabilities: ["prompts"],
          tags: ["prompts"],
        },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    runSubAgentMock.mockImplementation(async ({ agentName, task }: SubAgentRunOptions) => {
      if (agentName === "swarm_maintainer") {
        return `Sub-agent '${agentName}' timed out after 120000ms while working on ${task}`;
      }
      return `${agentName}:${task}:ok`;
    });

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const delegate = getTool("delegate_to_agent");
    expect(delegate).toBeDefined();

    const swarmState: SwarmState = {
      objective: "Maintain StarlingAI",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: {},
    };

    const result = await delegate!.execute({
      agentName: "swarm_maintainer",
      task: "Implement a maintenance change",
    }, {
      sessionId: "session-maintenance-fallback",
      workspacePath,
      swarmState,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("integration_builder");

    const tasks = Object.values(swarmState.tasks);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.attempts).toHaveLength(2);
    expect(tasks[0]?.attempts[0]?.agentName).toBe("swarm_maintainer");
    expect(tasks[0]?.attempts[0]?.status).toBe("failed");
    expect(tasks[0]?.attempts[1]?.agentName).toBe("integration_builder");
    expect(tasks[0]?.status).toBe("completed");
  }, 30_000);

  it("uses explicit fallbackAgents when a broad current-source research task stalls", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "starlingai-swarm-routing-"));
    tempDirs.push(workspacePath);
    const configPath = join(workspacePath, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      workspacePath,
      agents: {
        defaults: {
          model: {
            primary: "lmstudio/qwen3.5-4b",
            contextWindow: 32768,
            temperature: 0.3,
            maxTokens: 4096,
          },
        },
      },
      subAgents: {
        researcher: {
          description: "Research specialist",
          tools: ["web_search", "web_fetch"],
          capabilities: ["web research"],
          tags: ["research"],
        },
        web_task_coordinator: {
          description: "Coordinator for broad web research tasks",
          tools: ["delegate_to_agent", "parallel_delegate", "run_task_graph"],
          capabilities: ["web retrieval", "evidence synthesis"],
          tags: ["coordination", "web", "research"],
        },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();
    const { getConfig, resetConfigForTests } = await import("../config/loader.js");
    expect(getConfig().subAgents.web_task_coordinator).toBeDefined();
    resetConfigForTests();

    runSubAgentMock.mockImplementation(async ({ agentName, task }: SubAgentRunOptions) => {
      if (agentName === "researcher") {
        return `Sub-agent '${agentName}' reached the maximum number of tool-call iterations (6). Partial result may be incomplete for ${task}`;
      }
      if (agentName === "web_task_coordinator") {
        return `${agentName}:${task}:ok`;
      }
      return `${agentName}:${task}:unexpected`;
    });

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const delegate = getTool("delegate_to_agent");
    expect(delegate).toBeDefined();

    const swarmState: SwarmState = {
      objective: "Accessibility research guide",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: {},
    };

    const result = await delegate!.execute({
      agentName: "researcher",
      fallbackAgents: ["web_task_coordinator"],
      task: "Provide a comprehensive guide on web accessibility testing for 2026 with official sources and a step-by-step WCAG audit workflow.",
    }, {
      sessionId: "session-auto-coordinator-fallback",
      workspacePath,
      swarmState,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("web_task_coordinator");

    const tasks = Object.values(swarmState.tasks);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.attempts).toHaveLength(2);
    expect(tasks[0]?.attempts[0]?.agentName).toBe("researcher");
    expect(tasks[0]?.attempts[0]?.status).toBe("failed");
    expect(tasks[0]?.attempts[1]?.agentName).toBe("web_task_coordinator");
    expect(tasks[0]?.status).toBe("completed");
  }, 30_000);

  it("returns an explicit agent's partial result instead of silently escalating to a coordinator", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "starlingai-explicit-partial-no-escalation-"));
    tempDirs.push(workspacePath);
    const configPath = join(workspacePath, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      workspacePath,
      agents: {
        defaults: {
          model: {
            primary: "lmstudio/qwen3.5-4b",
            contextWindow: 32768,
            temperature: 0.3,
            maxTokens: 4096,
          },
        },
      },
      subAgents: {
        researcher: {
          description: "Research specialist",
          tools: ["web_search", "web_fetch"],
          capabilities: ["web research"],
          tags: ["research"],
        },
        web_task_coordinator: {
          description: "Coordinator for broad web research tasks",
          tools: ["delegate_to_agent", "parallel_delegate", "run_task_graph"],
          capabilities: ["web retrieval", "evidence synthesis"],
          tags: ["coordination", "web", "research"],
        },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    runSubAgentWithStatsMock.mockImplementation(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => {
      if (args.agentName === "researcher") {
        return {
          output: [
            "Collected before hitting the iteration limit:",
            "- WCAG 2.2 testing still depends on current official guidance and supporting sources.",
            "- The verified source set is incomplete, but the grounded findings above are usable.",
          ].join("\n"),
          stats: {
            agentName: args.agentName,
            sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
            promptChars: 0,
            userContentChars: String(args.task ?? "").length,
            toolCount: 6,
            toolNames: ["web_search", "web_fetch"],
            iterations: 6,
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            maxIterations: 6,
            model: "mock",
            capabilities: [],
            outcome: "partial",
            terminalState: "max_iterations",
          },
        };
      }

      return {
        output: `${args.agentName}:${args.task}:unexpected`,
        stats: {
          agentName: args.agentName,
          sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
          promptChars: 0,
          userContentChars: String(args.task ?? "").length,
          toolCount: 0,
          toolNames: [],
          iterations: 0,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          maxIterations: 5,
          model: "mock",
          capabilities: [],
          outcome: "success",
          terminalState: "completed",
        },
      };
    });

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const delegate = getTool("delegate_to_agent");
    expect(delegate).toBeDefined();

    const swarmState: SwarmState = {
      objective: "Accessibility research guide",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: {},
    };

    const result = await delegate!.execute({
      agentName: "researcher",
      task: "Provide a comprehensive guide on web accessibility testing for 2026 with official sources and a step-by-step WCAG audit workflow.",
    }, {
      sessionId: "session-explicit-partial-no-escalation",
      workspacePath,
      swarmState,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("researcher");
    expect(result.output).not.toContain("web_task_coordinator");
    expect(result.metadata?.["delegationOutcome"]).toBe("partial");
    expect(result.metadata?.["attemptedAgents"]).toEqual(["researcher"]);
    expect(runSubAgentWithStatsMock).toHaveBeenCalledTimes(1);

    const tasks = Object.values(swarmState.tasks);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.status).toBe("partial");
    expect(tasks[0]?.selectedAgent).toBe("researcher");
    expect(tasks[0]?.attempts).toHaveLength(1);
    expect(tasks[0]?.attempts[0]?.agentName).toBe("researcher");
    expect(tasks[0]?.attempts[0]?.status).toBe("partial");
  }, 30_000);

  it("does not surface planning-only max-iteration output as a reusable partial result", async () => {
    runSubAgentWithStatsMock.mockImplementation(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => ({
      output: "Let me check if there's any configuration in the runtime folder that might have connection details:",
      stats: {
        agentName: args.agentName,
        sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
        promptChars: 0,
        userContentChars: String(args.task ?? "").length,
        toolCount: 5,
        toolNames: ["shell_exec", "shell_exec", "ssh_exec", "list_files", "read_file"],
        iterations: 5,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        maxIterations: 5,
        model: "mock",
        capabilities: [],
        outcome: "partial",
        terminalState: "max_iterations",
      },
    }));

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const delegate = getTool("delegate_to_agent");
    expect(delegate).toBeDefined();

    const result = await delegate!.execute({
      agentName: "shell_agent",
      task: "List all running Docker containers on the n8n server using docker ps.",
    }, {
      sessionId: "session-shell-planning-only",
      workspacePath: "/workspace",
      swarmState: {
        objective: "List n8n server containers",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tasks: {},
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("All candidate agents failed");
  }, 30_000);

  it("auto-routes unsourced market chart requests to mission_coordinator", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "starlingai-market-chart-routing-"));
    tempDirs.push(workspacePath);
    const configPath = join(workspacePath, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      workspacePath,
      agents: {
        defaults: {
          model: {
            primary: "lmstudio/qwen3.5-4b",
            contextWindow: 32768,
            temperature: 0.3,
            maxTokens: 4096,
          },
        },
      },
      subAgents: {
        researcher: {
          description: "Research specialist",
          tools: ["web_search", "web_fetch"],
          capabilities: ["web research"],
          tags: ["research"],
        },
        chart_designer: {
          description: "Creates grounded HTML charts from verified data.",
          tools: ["generate_chart_html", "read_shared_facts"],
          capabilities: ["html charts", "data visualization"],
          tags: ["chart", "visualization", "data"],
        },
        mission_coordinator: {
          description: "Execution coordinator for multi-step evidence-to-artifact missions.",
          tools: ["delegate_to_agent", "parallel_delegate", "run_task_graph"],
          capabilities: ["multi-agent coordination", "dependency management", "quality gating"],
          tags: ["coordination", "workflow", "quality"],
        },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    runSubAgentMock.mockImplementation(async ({ agentName, task }: SubAgentRunOptions) => `${agentName}:${task}:ok`);

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const delegate = getTool("delegate_to_agent");
    expect(delegate).toBeDefined();

    const swarmState: SwarmState = {
      objective: "Market chart",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: {},
    };

    const result = await delegate!.execute({
      task: "Generate a chart showing the performance of the MSCI World ETF over the last 12 months.",
    }, {
      sessionId: "session-market-chart-routing",
      workspacePath,
      swarmState,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("mission_coordinator");
    expect(runSubAgentWithStatsMock).toHaveBeenCalledWith(expect.objectContaining({
      agentName: "mission_coordinator",
      task: "Generate a chart showing the performance of the MSCI World ETF over the last 12 months.",
    }));
  }, 30_000);

  it("surfaces partial delegated progress when the selected agent times out", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "starlingai-timeout-partial-progress-"));
    tempDirs.push(workspacePath);
    const configPath = join(workspacePath, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      workspacePath,
      agents: {
        defaults: {
          model: {
            primary: "lmstudio/qwen3.5-4b",
            contextWindow: 32768,
            temperature: 0.3,
            maxTokens: 4096,
          },
        },
      },
      subAgents: {
        mission_coordinator: {
          description: "Execution coordinator for multi-step evidence-to-artifact missions.",
          tools: ["delegate_to_agent", "parallel_delegate", "run_task_graph"],
          capabilities: ["multi-agent coordination", "dependency management", "quality gating"],
          tags: ["coordination", "workflow", "quality"],
        },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    runSubAgentWithStatsMock.mockImplementationOnce(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => ({
      output: [
        `Sub-agent '${args.agentName}' timed out after 60000ms`,
        "Partial progress before interruption:",
        "- fetch [completed] Fetch monthly ETF figures via researcher | Collected monthly MSCI World ETF figures.",
        "- Tool calls executed: 3 (list_agents, share_finding, run_task_graph)",
      ].join("\n"),
      stats: {
        agentName: args.agentName,
        sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
        promptChars: 0,
        userContentChars: String(args.task ?? "").length,
        toolCount: 3,
        toolNames: ["list_agents", "share_finding", "run_task_graph"],
        iterations: 2,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        maxIterations: 5,
        model: "mock",
        capabilities: [],
        terminalState: "timeout",
      },
    }));

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const delegate = getTool("delegate_to_agent");
    expect(delegate).toBeDefined();

    const result = await delegate!.execute({
      task: "Generate a chart showing the performance of the MSCI World ETF over the last 12 months.",
    }, {
      sessionId: "session-timeout-partial-progress",
      workspacePath,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("All candidate agents failed");
    expect(result.error).toContain("Partial progress before interruption");
    expect(result.error).toContain("fetch [completed] Fetch monthly ETF figures via researcher");
  }, 30_000);

  it("treats sessionId planning chatter as failure and uses the fallback agent", async () => {
    runSubAgentWithStatsMock.mockImplementation(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => {
      const { agentName, task, parentSessionId } = args;
      if (agentName === "researcher") {
        return {
          output: "Let me try with an empty string or null for the sessionId:",
          stats: {
            agentName,
            sessionId: `sub:${parentSessionId}:${agentName}:test`,
            promptChars: 0,
            userContentChars: String(task ?? "").length,
            toolCount: 1,
            toolNames: ["computer_list_windows"],
            iterations: 1,
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            maxIterations: 5,
            model: "mock",
            capabilities: [],
            terminalState: "completed" as const,
          },
        };
      }

      return {
        output: `${agentName}:${task}:ok`,
        stats: {
          agentName,
          sessionId: `sub:${parentSessionId}:${agentName}:test`,
          promptChars: 0,
          userContentChars: String(task ?? "").length,
          toolCount: 1,
          toolNames: ["computer_type"],
          iterations: 1,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          maxIterations: 5,
          model: "mock",
          capabilities: [],
          terminalState: "completed" as const,
        },
      };
    });

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const delegate = getTool("delegate_to_agent");
    expect(delegate).toBeDefined();

    const swarmState: SwarmState = {
      objective: "Desktop automation",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: {},
    };

    const result = await delegate!.execute({
      agentName: "researcher",
      fallbackAgents: ["retrieval_analyst"],
      task: "Type Hello World into the visible Copilot chat input.",
    }, {
      sessionId: "session-sessionid-chatter",
      workspacePath: "/workspace",
      swarmState,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("retrieval_analyst");

    const tasks = Object.values(swarmState.tasks);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.attempts[0]?.agentName).toBe("researcher");
    expect(tasks[0]?.attempts[0]?.status).toBe("failed");
    expect(tasks[0]?.attempts[1]?.agentName).toBe("retrieval_analyst");
    expect(tasks[0]?.status).toBe("completed");
  }, 30_000);

  it("treats max-iteration delegated runs as failure even when the summary sounds plausible", async () => {
    runSubAgentWithStatsMock.mockImplementation(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => {
      const { agentName, task, parentSessionId } = args;
      if (agentName === "researcher") {
        return {
          output: "Now I can see the screen clearly. There is a chat panel visible, and I will try the command palette again.",
          stats: {
            agentName,
            sessionId: `sub:${parentSessionId}:${agentName}:test`,
            promptChars: 0,
            userContentChars: String(task ?? "").length,
            toolCount: 15,
            toolNames: ["computer_snapshot", "computer_click"],
            iterations: 15,
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            maxIterations: 15,
            model: "mock",
            capabilities: [],
            terminalState: "max_iterations" as const,
          },
        };
      }

      return {
        output: `${agentName}:${task}:ok`,
        stats: {
          agentName,
          sessionId: `sub:${parentSessionId}:${agentName}:test`,
          promptChars: 0,
          userContentChars: String(task ?? "").length,
          toolCount: 1,
          toolNames: ["computer_type"],
          iterations: 1,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          maxIterations: 5,
          model: "mock",
          capabilities: [],
          terminalState: "completed" as const,
        },
      };
    });

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const delegate = getTool("delegate_to_agent");
    expect(delegate).toBeDefined();

    const swarmState: SwarmState = {
      objective: "Desktop automation",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: {},
    };

    const result = await delegate!.execute({
      agentName: "researcher",
      fallbackAgents: ["retrieval_analyst"],
      task: "Type Hello World into the visible chat input.",
    }, {
      sessionId: "session-max-iterations",
      workspacePath: "/workspace",
      swarmState,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("retrieval_analyst");
    const tasks = Object.values(swarmState.tasks);
    expect(tasks[0]?.attempts[0]?.status).toBe("failed");
    expect(tasks[0]?.attempts[0]?.iterations).toBe(15);
    expect(tasks[0]?.attempts[1]?.status).toBe("completed");
  }, 30_000);

  it("executes dependency-aware task graphs and exposes the shared swarm state", async () => {
    runSubAgentMock.mockImplementation(async ({ agentName, task }: SubAgentRunOptions) => `${agentName}:${task}:done`);

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
    runSubAgentMock.mockImplementation(async ({ agentName, task }: SubAgentRunOptions) => `${agentName}:${task}:done`);

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

  it("reuses partial graph nodes with the same taskId and signature instead of rerunning duplicate research", async () => {
    runSubAgentWithStatsMock.mockImplementation(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => ({
      output: [
        `Sub-agent '${args.agentName}' timed out after 1000ms`,
        "Partial progress before interruption:",
        "- Tool calls executed: 3 (web_search, web_fetch, share_finding)",
        "- Iterations completed: 1",
      ].join("\n"),
      stats: {
        agentName: args.agentName,
        sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
        promptChars: 0,
        userContentChars: String(args.task ?? "").length,
        toolCount: 3,
        toolNames: ["web_search", "web_fetch", "share_finding"],
        iterations: 1,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        maxIterations: 5,
        model: "mock",
        capabilities: [],
        outcome: "partial",
        terminalState: "timeout",
      },
    }));

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const runTaskGraph = getTool("run_task_graph");
    expect(runTaskGraph).toBeDefined();

    const swarmState: SwarmState = {
      objective: "Research protocols",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: {},
    };

    const graphArgs = {
      objective: "Research protocols",
      nodes: [
        { id: "gather_mcp", agentName: "researcher", task: "Find official MCP specification" },
      ],
    };

    const first = await runTaskGraph!.execute(graphArgs, {
      sessionId: "session-graph-reuse",
      workspacePath: "/workspace",
      swarmState,
    });

    const second = await runTaskGraph!.execute(graphArgs, {
      sessionId: "session-graph-reuse",
      workspacePath: "/workspace",
      swarmState,
    });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(runSubAgentWithStatsMock).toHaveBeenCalledTimes(1);
    expect(swarmState.tasks["gather_mcp"]?.status).toBe("partial");
    expect(second.output).toContain("gather_mcp [partial]");
  }, 15000);

  it("refuses to replay an identical failed delegated task in the same turn", async () => {
    runSubAgentWithStatsMock.mockImplementation(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => {
      const { agentName, task, parentSessionId } = args;
      return {
      output: "Let me try with an empty string or null for the sessionId:",
      stats: {
        agentName,
        sessionId: `sub:${parentSessionId}:${agentName}:test`,
        promptChars: 0,
        userContentChars: String(task ?? "").length,
        toolCount: 1,
        toolNames: ["computer_list_windows"],
        iterations: 1,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        maxIterations: 5,
        model: "mock",
        capabilities: [],
        terminalState: "completed",
      },
    };
    });

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const delegate = getTool("delegate_to_agent");
    expect(delegate).toBeDefined();

    const swarmState: SwarmState = {
      objective: "Desktop automation",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: {},
    };

    const args = {
      agentName: "researcher",
      task: "Type Hello World into the visible Copilot chat input.",
    };

    const first = await delegate!.execute(args, {
      sessionId: "session-repeat-failure",
      workspacePath: "/workspace",
      swarmState,
    });

    const second = await delegate!.execute(args, {
      sessionId: "session-repeat-failure",
      workspacePath: "/workspace",
      swarmState,
    });

    expect(first.success).toBe(false);
    expect(first.error).toContain("All candidate agents failed");
    expect(second.success).toBe(false);
    expect(second.error).toContain("already failed earlier in this turn");
    expect(runSubAgentWithStatsMock).toHaveBeenCalledTimes(1);
    expect(Object.values(swarmState.tasks)).toHaveLength(1);
  }, 15_000);

  it("allows retrying a failed task with a different explicit agent in the same turn", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-swarm-explicit-retry-"));
    tempDirs.push(tempDir);

    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      agents: {
        defaults: {
          model: { primary: "mock-model" },
        },
      },
      subAgents: {
        evidence_analyst: {
          description: "Evidence analyst.",
          tools: ["web_search", "web_fetch"],
          maxIterations: 4,
        },
        researcher: {
          description: "Research specialist.",
          tools: ["web_search", "web_fetch"],
          maxIterations: 4,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    runSubAgentWithStatsMock.mockImplementation(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => {
      const { agentName, task, parentSessionId } = args;
      return {
        output: agentName === "evidence_analyst"
          ? "Sub-agent produced no final response."
          : `${agentName}: official MCP sources collected for ${task}`,
        stats: {
          agentName,
          sessionId: `sub:${parentSessionId}:${agentName}:test`,
          promptChars: 0,
          userContentChars: String(task ?? "").length,
          toolCount: 1,
          toolNames: ["web_fetch"],
          iterations: 1,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          maxIterations: 5,
          model: "mock",
          capabilities: [],
          terminalState: "completed",
        },
      };
    });

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const delegate = getTool("delegate_to_agent");
    expect(delegate).toBeDefined();

    const swarmState: SwarmState = {
      objective: "Recover failed source lookup",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: {},
    };

    const first = await delegate!.execute({
      agentName: "evidence_analyst",
      task: "Find citation-grade primary sources for MCP.",
    }, {
      sessionId: "session-explicit-retry",
      workspacePath: "/workspace",
      swarmState,
    });

    const second = await delegate!.execute({
      agentName: "researcher",
      task: "Find citation-grade primary sources for MCP.",
    }, {
      sessionId: "session-explicit-retry",
      workspacePath: "/workspace",
      swarmState,
    });

    expect(first.success).toBe(false);
    expect(second.success).toBe(true);
    expect(second.metadata?.["taskId"]).toBe(first.metadata?.["taskId"]);
    expect(second.output).toContain("researcher");
    expect(runSubAgentWithStatsMock).toHaveBeenCalledTimes(2);

    const tasks = Object.values(swarmState.tasks);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.status).toBe("completed");
    expect(tasks[0]?.selectedAgent).toBe("researcher");
    expect(tasks[0]?.attempts).toHaveLength(2);
    expect(tasks[0]?.attempts[0]?.agentName).toBe("evidence_analyst");
    expect(tasks[0]?.attempts[1]?.agentName).toBe("researcher");
  }, 15_000);

  it("does not invoke architect fallback after an explicitly requested agent fails", async () => {
    runSubAgentWithStatsMock.mockImplementation(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => {
      const { agentName, task, parentSessionId } = args;
      return {
      output: "Let me try with an empty string or null for the sessionId:",
      stats: {
        agentName,
        sessionId: `sub:${parentSessionId}:${agentName}:test`,
        promptChars: 0,
        userContentChars: String(task ?? "").length,
        toolCount: 1,
        toolNames: ["computer_session_attach"],
        iterations: 1,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        maxIterations: 5,
        model: "mock",
        capabilities: [],
        terminalState: "completed",
      },
    };
    });

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const delegate = getTool("delegate_to_agent");
    expect(delegate).toBeDefined();

    const swarmState: SwarmState = {
      objective: "Remote desktop access",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: {},
    };

    const result = await delegate!.execute({
      agentName: "computer_use_agent",
      task: "Access the remote Windows machine at IP 10.10.0.2.",
    }, {
      sessionId: "session-explicit-agent-failure",
      workspacePath: "/workspace",
      swarmState,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("All candidate agents failed");
    expect(result.error).not.toContain("Architect-designed agent");
    expect(runSubAgentWithStatsMock).toHaveBeenCalledTimes(1);

    const tasks = Object.values(swarmState.tasks);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.attempts).toHaveLength(1);
    expect(tasks[0]?.attempts[0]?.agentName).toBe("computer_use_agent");
    expect(tasks[0]?.attempts[0]?.status).toBe("failed");
  }, 15_000);

  it("preserves browser findings across a coordinator task graph for downstream specialists", async () => {
    runSubAgentMock.mockImplementation(async ({ agentName }: SubAgentRunOptions) => {
      if (agentName === "browser_agent") {
        return [
          "FACT: draw_date = 2026-03-24",
          "FACT: winning_numbers = 9 15 23 43 48",
          "FACT: euro_numbers = 3 5",
        ].join("\n");
      }
      if (agentName === "vision_browser_analyst") {
        return "FACT: evidence_source = official_results_page";
      }
      return "Summary completed from shared browser evidence.";
    });

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const runTaskGraph = getTool("run_task_graph");
    expect(runTaskGraph).toBeDefined();

    const swarmState: SwarmState = {
      objective: "Collect live draw results",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: {},
    };

    const result = await runTaskGraph!.execute({
      objective: "Collect and synthesize browser evidence",
      nodes: [
        { id: "browse", agentName: "browser_agent", task: "Capture the rendered results page" },
        { id: "interpret", agentName: "vision_browser_analyst", task: "Interpret the captured browser evidence", dependsOn: ["browse"] },
        { id: "summarize", agentName: "summarizer", task: "Produce the final synthesis from shared evidence", dependsOn: ["interpret"] },
      ],
    }, {
      sessionId: "session-browser-graph",
      workspacePath: "/workspace",
      swarmState,
    });

    expect(result.success).toBe(true);
    expect(runSubAgentMock).toHaveBeenCalledTimes(3);
    expect(runSubAgentMock.mock.calls[0]?.[0]?.agentName).toBe("browser_agent");
    expect(runSubAgentMock.mock.calls[1]?.[0]?.agentName).toBe("vision_browser_analyst");
    expect(runSubAgentMock.mock.calls[2]?.[0]?.agentName).toBe("summarizer");

    const memory = await import("../swarm/memory.js");
    const facts = await memory.readAllFacts("session-browser-graph");
    expect(facts["draw_date"]).toBe("2026-03-24");
    expect(facts["winning_numbers"]).toBe("9 15 23 43 48");
    expect(facts["euro_numbers"]).toBe("3 5");
    expect(facts["evidence_source"]).toBe("official_results_page");
    expect(swarmState.tasks["summarize"]?.status).toBe("completed");
  }, 15000);

  it("preserves computer-use partial progress instead of classifying it as failed", async () => {
    runSubAgentWithStatsMock.mockImplementation(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => {
      if (args.agentName === "computer_use_agent") {
        return {
          output: [
            "Sub-agent 'computer_use_agent' timed out after 1000ms",
            "Partial progress before interruption:",
            "- Tool calls executed: 3 (computer_list_nodes, computer_session_start, computer_snapshot)",
            "- Iterations completed: 1",
          ].join("\n"),
          stats: {
            agentName: args.agentName,
            sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
            promptChars: 0,
            userContentChars: String(args.task ?? "").length,
            toolCount: 3,
            toolNames: ["computer_list_nodes", "computer_session_start", "computer_snapshot"],
            iterations: 1,
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            maxIterations: 5,
            model: "mock",
            capabilities: [],
            outcome: "partial",
            terminalState: "timeout",
          },
        };
      }

      return {
        output: await runSubAgentMock(args),
        stats: {
          agentName: args.agentName,
          sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
          promptChars: 0,
          userContentChars: String(args.task ?? "").length,
          toolCount: 0,
          toolNames: [],
          iterations: 0,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          maxIterations: 5,
          model: "mock",
          capabilities: [],
          outcome: "success",
          terminalState: "completed",
        },
      };
    });

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const delegate = getTool("delegate_to_agent");
    expect(delegate).toBeDefined();

    const swarmState: SwarmState = {
      objective: "Inspect desktop models",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: {},
    };

    const result = await delegate!.execute({
      task: "Check on my PC which models are loaded in LM Studio.",
    }, {
      sessionId: "session-computer-partial",
      workspacePath: "/workspace",
      swarmState,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("computer_use_agent");
    expect(result.metadata?.["delegationOutcome"]).toBe("partial");

    const tasks = Object.values(swarmState.tasks);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.status).toBe("partial");
    expect(tasks[0]?.attempts).toHaveLength(1);
    expect(tasks[0]?.attempts[0]?.agentName).toBe("computer_use_agent");
    expect(tasks[0]?.attempts[0]?.status).toBe("partial");
  }, 15000);

  it("accepts artifact-backed partial delegation without falling through to another agent", async () => {
    runSubAgentWithStatsMock.mockImplementation(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => {
      if (args.agentName === "paper_author") {
        return {
          output: "Saved the comparison paper draft and summarized the remaining caveats.",
          stats: {
            agentName: args.agentName,
            sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
            promptChars: 0,
            userContentChars: String(args.task ?? "").length,
            toolCount: 1,
            toolNames: ["generate_document"],
            iterations: 1,
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            maxIterations: 5,
            model: "mock",
            capabilities: [],
            outcome: "partial",
            terminalState: "max_iterations",
          },
          artifacts: [
            {
              outputPath: "reports/protocol-comparison.md",
              filename: "protocol-comparison.md",
              contentType: "text/markdown; charset=utf-8",
              previewMode: "markdown",
              sourceTool: "generate_document",
            },
          ],
        };
      }

      return {
        output: `${args.agentName}:${args.task}:fallback`,
        stats: {
          agentName: args.agentName,
          sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
          promptChars: 0,
          userContentChars: String(args.task ?? "").length,
          toolCount: 0,
          toolNames: [],
          iterations: 0,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          maxIterations: 5,
          model: "mock",
          capabilities: [],
          outcome: "success",
          terminalState: "completed",
        },
      };
    });

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const delegate = getTool("delegate_to_agent");
    expect(delegate).toBeDefined();

    const swarmState: SwarmState = {
      objective: "Draft the comparison packet",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: {},
    };

    const result = await delegate!.execute({
      agentName: "paper_author",
      fallbackAgents: ["summarizer"],
      task: "Write the protocol comparison paper.",
    }, {
      sessionId: "session-artifact-partial",
      workspacePath: "/workspace",
      swarmState,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("paper_author");
    expect(result.metadata?.["delegationOutcome"]).toBe("partial");
    expect(result.metadata?.["attemptedAgents"]).toEqual(["paper_author"]);
    expect(result.metadata?.["artifacts"]).toEqual([
      expect.objectContaining({
        outputPath: "reports/protocol-comparison.md",
        previewMode: "markdown",
        sourceTool: "generate_document",
      }),
    ]);
    expect(runSubAgentWithStatsMock).toHaveBeenCalledTimes(1);

    const tasks = Object.values(swarmState.tasks);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.status).toBe("partial");
    expect(tasks[0]?.attempts).toHaveLength(1);
    expect(tasks[0]?.attempts[0]?.agentName).toBe("paper_author");
    expect(tasks[0]?.attempts[0]?.status).toBe("partial");
  }, 15000);

  it("injects artifact paths from earlier partial results into downstream agent context", async () => {
    runSubAgentWithStatsMock.mockImplementation(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => {
      if (args.agentName === "paper_author") {
        return {
          output: "Saved the comparison paper draft and summarized the remaining caveats.",
          stats: {
            agentName: args.agentName,
            sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
            promptChars: 0,
            userContentChars: String(args.task ?? "").length,
            toolCount: 1,
            toolNames: ["generate_document"],
            iterations: 1,
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            maxIterations: 5,
            model: "mock",
            capabilities: [],
            outcome: "partial",
            terminalState: "max_iterations",
          },
          artifacts: [
            {
              outputPath: "reports/protocol-comparison.md",
              filename: "protocol-comparison.md",
              contentType: "text/markdown; charset=utf-8",
              previewMode: "markdown",
              sourceTool: "generate_document",
            },
          ],
        };
      }

      return {
        output: `${args.agentName}:${args.task}:ok`,
        stats: {
          agentName: args.agentName,
          sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
          promptChars: 0,
          userContentChars: String(args.task ?? "").length,
          toolCount: 0,
          toolNames: [],
          iterations: 0,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          maxIterations: 5,
          model: "mock",
          capabilities: [],
          outcome: "success",
          terminalState: "completed",
        },
      };
    });

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const delegate = getTool("delegate_to_agent");
    expect(delegate).toBeDefined();

    const swarmState: SwarmState = {
      objective: "Draft and review the comparison packet",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: {},
    };

    const draftResult = await delegate!.execute({
      agentName: "paper_author",
      task: "Write the protocol comparison paper.",
    }, {
      sessionId: "session-artifact-context",
      workspacePath: "/workspace",
      swarmState,
    });

    expect(draftResult.success).toBe(true);
    expect(draftResult.metadata?.["delegationOutcome"]).toBe("partial");

    const reviewResult = await delegate!.execute({
      agentName: "quality_supervisor",
      task: "Review the generated protocol comparison paper and decide whether one corrective pass is needed.",
    }, {
      sessionId: "session-artifact-context",
      workspacePath: "/workspace",
      swarmState,
    });

    expect(reviewResult.success).toBe(true);
    expect(runSubAgentWithStatsMock).toHaveBeenCalledTimes(2);
    expect(runSubAgentWithStatsMock.mock.calls[1]?.[0]?.context).toContain("reports/protocol-comparison.md");
    expect(runSubAgentWithStatsMock.mock.calls[1]?.[0]?.context).toContain("generate_document");
  }, 15000);

  it("returns the best partial result when later fallbacks only produce inability disclaimers", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-swarm-partial-"));
    tempDirs.push(tempDir);

    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      agents: {
        defaults: {
          model: { primary: "mock-model" },
        },
      },
      subAgents: {
        security_researcher: {
          description: "Security research specialist for CVE lookup and vulnerability advisories.",
          tools: ["web_search", "web_fetch"],
          maxIterations: 8,
        },
        distance_specialist: {
          description: "Navigation specialist for route distance and travel time.",
          tags: ["navigation", "distance", "travel"],
          tools: ["geocode_location", "route_distance_time"],
          maxIterations: 4,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    runSubAgentWithStatsMock.mockImplementation(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => {
      if (args.agentName === "security_researcher") {
        return {
          output: [
            "Top findings collected before iteration limit:",
            "- CVE-2026-0001 | CVSS 9.8 | Internet-facing RCE in Example Gateway",
            "- Exploit status: active exploitation reported by vendor advisory",
          ].join("\n"),
          stats: {
            agentName: args.agentName,
            sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
            promptChars: 0,
            userContentChars: String(args.task ?? "").length,
            toolCount: 8,
            toolNames: ["web_search", "web_fetch"],
            iterations: 8,
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            maxIterations: 8,
            model: "mock",
            capabilities: [],
            outcome: "partial",
            terminalState: "max_iterations",
          },
        };
      }

      return {
        output: "I cannot access real-time databases or the internet to retrieve the latest CVEs released in the last 30 days.",
        stats: {
          agentName: args.agentName,
          sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
          promptChars: 0,
          userContentChars: String(args.task ?? "").length,
          toolCount: 0,
          toolNames: [],
          iterations: 0,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          maxIterations: 4,
          model: "mock",
          capabilities: [],
          outcome: "success",
          terminalState: "completed",
        },
      };
    });

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const delegate = getTool("delegate_to_agent");
    expect(delegate).toBeDefined();

    const swarmState: SwarmState = {
      objective: "Research recent CVEs",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: {},
    };

    const result = await delegate!.execute({
      agentName: "security_researcher",
      fallbackAgents: ["distance_specialist"],
      task: "Research the top 3 most critical CVEs released in the last 30 days.",
    }, {
      sessionId: "session-security-partial",
      workspacePath: "/workspace",
      swarmState,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("security_researcher");
    expect(result.output).toContain("CVE-2026-0001");
    expect(result.metadata?.["agentName"]).toBe("security_researcher");
    expect(result.metadata?.["delegationOutcome"]).toBe("partial");
    expect(result.metadata?.["attemptedAgents"]).toEqual(["security_researcher"]);

    const tasks = Object.values(swarmState.tasks);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.status).toBe("partial");
    expect(tasks[0]?.selectedAgent).toBe("security_researcher");
  }, 15000);
});