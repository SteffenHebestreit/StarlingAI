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
          capabilities: ["multi-agent coordination", "web retrieval", "browser orchestration", "evidence synthesis"],
          tags: ["coordination", "web", "browser", "research"],
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

  it("auto-routes to a coordinator fallback when a broad current-source research task stalls", async () => {
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
        citation_researcher: {
          description: "Official source lookup specialist",
          tools: ["web_search", "web_fetch"],
          capabilities: ["citation research"],
          tags: ["citations", "sources"],
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
});