import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SubAgentRunOptions, SubAgentRunResult } from "../agent/sub-agent.js";

const runSubAgentMock = vi.fn(async ({ agentName, task }: SubAgentRunOptions) => {
  if (agentName === "agent_architect") {
    return JSON.stringify({
      agentName: "investor_memo_writer",
      description: "Writes focused investor memos.",
      systemPrompt: "Write a concise investor memo grounded in the provided task.",
      tools: ["read_file", "write_file"],
      maxIterations: 4,
      model: {
        primary: "lmstudio/qwen/qwen3.6-35b-a3b",
        temperature: 0.1,
      },
    });
  }

  if (agentName.startsWith("ephemeral:")) {
    return `${agentName}:${task}:done`;
  }

  return `${agentName}:${task}`;
});

const collectTaskBidsMock = vi.fn(async (): Promise<Array<Record<string, unknown>>> => []);
const clearTaskBidsMock = vi.fn();
const isAutonomousBiddingStartedMock = vi.fn(() => true);
// Default stats include a realistic write_file call so artifact-task tests
// (anything matching WORKSPACE_MUTATION_TASK_RE with an artifact tool
// granted) don't trip the new ephemeral-agent narrative-only guard. Specific
// tests override this when they want a failure path.
const runSubAgentWithStatsMock = vi.hoisted(() => vi.fn(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => ({
  output: await runSubAgentMock(args),
  stats: {
    agentName: args.agentName,
    sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
    promptChars: 0,
    userContentChars: String(args.task ?? "").length,
    toolCount: 1,
    toolNames: ["write_file"],
    iterations: 1,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    maxIterations: 5,
    model: "mock",
    capabilities: [],
    terminalState: "completed",
  },
})));

vi.mock("../agent/sub-agent.js", () => ({
  runSubAgent: runSubAgentMock,
  runSubAgentWithStats: runSubAgentWithStatsMock,
}));

vi.mock("../swarm/bidding.js", async () => {
  const actual = await vi.importActual<typeof import("../swarm/bidding.js")>("../swarm/bidding.js");
  return {
    ...actual,
    collectTaskBids: collectTaskBidsMock,
    clearTaskBids: clearTaskBidsMock,
    isAutonomousBiddingStarted: isAutonomousBiddingStartedMock,
  };
});

describe("create_ephemeral_agent policy", () => {
  beforeEach(() => {
    vi.resetModules();
    runSubAgentMock.mockClear();
    runSubAgentWithStatsMock.mockClear();
    runSubAgentWithStatsMock.mockImplementation(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => ({
      output: await runSubAgentMock(args),
      stats: {
        agentName: args.agentName,
        sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
        promptChars: 0,
        userContentChars: String(args.task ?? "").length,
        toolCount: 1,
        toolNames: ["write_file"],
        iterations: 1,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        maxIterations: 5,
        model: "mock",
        capabilities: [],
        terminalState: "completed",
      },
    }));
    collectTaskBidsMock.mockReset();
    clearTaskBidsMock.mockReset();
    isAutonomousBiddingStartedMock.mockReset();
    isAutonomousBiddingStartedMock.mockReturnValue(true);
  });

  afterEach(() => {
    delete process.env["SAI_CONFIG_PATH"];
    vi.resetModules();
  });

  it("rejects mixed execution families for ephemeral agents", async () => {
    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const createEphemeralAgent = getTool("create_ephemeral_agent");
    expect(createEphemeralAgent).toBeTruthy();

    const result = await createEphemeralAgent!.execute({
      agentName: "mixed_operator",
      systemPrompt: "You are a mixed operator. RULES: use tools carefully and stop when complete.",
      tools: ["shell_exec", "mcp__playwright__browser_navigate"],
      task: "Do multiple privileged things",
    }, {
      sessionId: "test-session",
      workspacePath: "/workspace",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("cannot mix multiple execution families");
  }, 15000);

  it("rejects overly broad ephemeral coordinators", async () => {
    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const createEphemeralAgent = getTool("create_ephemeral_agent");
    expect(createEphemeralAgent).toBeTruthy();

    const result = await createEphemeralAgent!.execute({
      agentName: "broad_coordinator",
      systemPrompt: "You are a coordinator. RULES: coordinate and stop.",
      tools: ["parallel_delegate", "shell_exec", "read_file"],
      task: "Coordinate and execute",
    }, {
      sessionId: "test-session",
      workspacePath: "/workspace",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("parallel_delegate");
  }, 15000);

  // Regression: a coordinator created an external-research ephemeral agent
  // with only local workspace tools. The agent then looped over empty local
  // search results before timing out. The validator must reject this at spawn
  // time so the coordinator gets immediate feedback to retry with web tools.
  it("rejects research-shaped ephemeral agents that lack web/browser tools", async () => {
    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const createEphemeralAgent = getTool("create_ephemeral_agent");
    expect(createEphemeralAgent).toBeTruthy();

    const result = await createEphemeralAgent!.execute({
      agentName: "external_sourcing_researcher",
      description: "External sourcing specialist for current product options, availability, and implementation constraints.",
      systemPrompt: "You are a senior sourcing researcher. Component Sourcing: Specific product options from current vendor pages with pricing and availability. RULES: Always provide SPECIFIC product identifiers, not generic descriptions.",
      tools: ["workspace_search", "read_file", "list_files"],
      task: "Erstelle einen aktuellen Sourcing-Leitfaden mit konkreten Produktnamen und Verfuegbarkeit.",
    }, {
      sessionId: "test-session",
      workspacePath: "/workspace",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("external research");
    expect(result.error).toContain("web_search");
  }, 15000);

  it("accepts research-shaped ephemeral agents that include web_search", async () => {
    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const createEphemeralAgent = getTool("create_ephemeral_agent");
    expect(createEphemeralAgent).toBeTruthy();

    const result = await createEphemeralAgent!.execute({
      agentName: "external_sourcing_researcher",
      description: "External sourcing specialist for current product options and integration constraints.",
      systemPrompt: "You are a senior sourcing researcher. Component Sourcing: Specific product options from current vendor pages with pricing and availability.",
      tools: ["web_search", "web_fetch", "read_file"],
      task: "Erstelle einen aktuellen Sourcing-Leitfaden mit konkreten Produktnamen.",
    }, {
      sessionId: "test-session",
      workspacePath: "/workspace",
    });

    expect(result.success).toBe(true);
  }, 15000);

  it("rejects invented ephemeral tools after semantic tool discovery", async () => {
    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const createEphemeralAgent = getTool("create_ephemeral_agent");
    expect(createEphemeralAgent).toBeTruthy();

    const result = await createEphemeralAgent!.execute({
      agentName: "current_docs_researcher",
      description: "Researches current public documentation and source-backed facts.",
      systemPrompt: "Use current public documentation and cite sources.",
      tools: ["google_search_the_web", "web_fetch"],
      task: "Find current documentation for an integration feature.",
    }, {
      sessionId: "test-session",
      workspacePath: "/workspace",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown tool(s) requested");
    expect(result.error).toContain("search_tools/semantic tool discovery");
    expect(result.metadata?.["suggestedTools"]).toEqual(expect.arrayContaining(["web_search"]));
  }, 15000);

  it("accepts non-research ephemeral agents without web tools", async () => {
    // The validator must NOT fire on agents whose description is pure
    // analysis / writing / refactoring — only when the spec explicitly
    // mentions external sourcing / datasheets / current availability.
    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const createEphemeralAgent = getTool("create_ephemeral_agent");
    expect(createEphemeralAgent).toBeTruthy();

    const result = await createEphemeralAgent!.execute({
      agentName: "investor_memo_writer",
      description: "Writes focused investor memos from inline context.",
      systemPrompt: "Write a concise investor memo grounded in the provided task.",
      tools: ["read_file", "write_file"],
      task: "Draft an investor memo summarizing the attached pitch deck.",
    }, {
      sessionId: "test-session",
      workspacePath: "/workspace",
    });

    expect(result.success).toBe(true);
  }, 15000);

  it("generates and starts an ephemeral agent when the best skill match is below threshold", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "starlingai-ephemeral-threshold-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      agents: {
        defaults: {
          model: { primary: "lmstudio/qwen3.5-4b" },
        },
        ephemeralGeneration: {
          enabled: true,
          skillMatchThreshold: 0.75,
          architectAgentName: "agent_architect",
        },
      },
      subAgents: {
        researcher: {
          description: "Finds web documentation.",
          tools: ["web_search"],
          maxIterations: 4,
        },
        agent_architect: {
          description: "Designs ephemeral agents.",
          tools: ["list_agents"],
          maxIterations: 4,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    collectTaskBidsMock.mockResolvedValue([
      {
        agentName: "researcher",
        confidence: "low",
        matchedTerms: ["memo"],
        score: 0.4,
      },
    ]);

    try {
      const [{ getTool }] = await Promise.all([
        import("../tools/registry.js"),
        import("../tools/sub-agent.js"),
      ]);

      const parallelDelegate = getTool("parallel_delegate");
      expect(parallelDelegate).toBeTruthy();

      const result = await parallelDelegate!.execute({
        tasks: [
          {
            task: "Draft an investor memo focused on unit economics.",
            routingQuery: "investor memo unit economics",
            skillMatchThreshold: 0.75,
          },
        ],
      }, {
        sessionId: "threshold-session",
        workspacePath: tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain("ephemeral:investor_memo_writer");
      expect(runSubAgentMock).toHaveBeenCalledTimes(2);
      expect(runSubAgentMock.mock.calls[0]?.[0]?.agentName).toBe("agent_architect");
      expect(runSubAgentMock.mock.calls[1]?.[0]?.agentName).toBe("ephemeral:investor_memo_writer");
      expect(runSubAgentMock.mock.calls[1]?.[0]?.task).toBe("Draft an investor memo focused on unit economics.");
      expect(runSubAgentMock.mock.calls[1]?.[0]?.inlineConfig?.model?.primary).toBe("lmstudio/qwen/qwen3.6-35b-a3b");
      expect(runSubAgentMock.mock.calls.some((call) => call[0]?.agentName === "researcher")).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 15000);

  it("prefers a high-confidence catalog agent over architect fallback for current-news tasks", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "starlingai-ephemeral-high-confidence-route-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      agents: {
        defaults: {
          model: { primary: "lmstudio/qwen3.5-4b" },
        },
        ephemeralGeneration: {
          enabled: true,
          skillMatchThreshold: 0.75,
          architectAgentName: "agent_architect",
        },
      },
      subAgents: {
        researcher: {
          description: "Finds facts on the web and summarizes them.",
          capabilities: ["web research", "documentation lookup", "source triangulation"],
          tags: ["research", "web", "docs"],
          tools: ["web_search", "web_fetch"],
          maxIterations: 4,
        },
        web_task_coordinator: {
          description: "Coordinator for freshness-sensitive web tasks that need research, browser interaction, and evidence synthesis.",
          capabilities: ["multi-agent coordination", "web retrieval", "browser orchestration", "evidence synthesis"],
          tags: ["coordination", "web", "browser", "research"],
          tools: ["search_agents", "delegate_to_agent", "parallel_delegate", "run_task_graph"],
          maxIterations: 6,
        },
        agent_architect: {
          description: "Designs ephemeral agents.",
          tools: ["list_agents"],
          maxIterations: 4,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    collectTaskBidsMock.mockResolvedValue([]);

    try {
      const [{ getTool }] = await Promise.all([
        import("../tools/registry.js"),
        import("../tools/sub-agent.js"),
      ]);

      const parallelDelegate = getTool("parallel_delegate");
      expect(parallelDelegate).toBeTruthy();

      const result = await parallelDelegate!.execute({
        tasks: [
          {
            task: "Collect today's top headlines from major German and international sources.",
            routingQuery: "today top headlines current news",
            skillMatchThreshold: 0.75,
          },
        ],
      }, {
        sessionId: "high-confidence-route-session",
        workspacePath: tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain("web_task_coordinator");
      expect(runSubAgentMock.mock.calls.some((call) => call[0]?.agentName === "agent_architect")).toBe(false);
      expect(runSubAgentMock.mock.calls[0]?.[0]?.agentName).toBe("web_task_coordinator");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 15000);

  it("accepts architect responses that append trailing text after the JSON object", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "starlingai-ephemeral-trailing-json-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      agents: {
        defaults: {
          model: { primary: "lmstudio/qwen3.5-4b" },
        },
        ephemeralGeneration: {
          enabled: true,
          skillMatchThreshold: 0.75,
          architectAgentName: "agent_architect",
        },
      },
      subAgents: {
        researcher: {
          description: "Finds web documentation.",
          tools: ["web_search"],
          maxIterations: 4,
        },
        agent_architect: {
          description: "Designs ephemeral agents.",
          tools: ["list_agents"],
          maxIterations: 4,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    collectTaskBidsMock.mockResolvedValue([]);

    runSubAgentMock.mockImplementation(async ({ agentName, task }: SubAgentRunOptions) => {
      if (agentName === "agent_architect") {
        return `${JSON.stringify({
          agentName: "headline_fetcher",
          description: "Fetches current headlines.",
          systemPrompt: "Fetch current headlines and stop when enough evidence is collected.",
          tools: ["web_search", "web_fetch"],
          maxIterations: 4,
          model: {
            primary: "lmstudio/qwen/qwen3.6-35b-a3b",
            temperature: 0.1,
          },
        })}\nNEXT ACTION: use the agent above.`;
      }

      if (agentName.startsWith("ephemeral:")) {
        return `${agentName}:${task}:done`;
      }

      return `${agentName}:${task}`;
    });

    try {
      const [{ getTool }] = await Promise.all([
        import("../tools/registry.js"),
        import("../tools/sub-agent.js"),
      ]);

      const parallelDelegate = getTool("parallel_delegate");
      expect(parallelDelegate).toBeTruthy();

      const result = await parallelDelegate!.execute({
        tasks: [
          {
            task: "Collect today's top headlines.",
            routingQuery: "today top headlines current news",
            skillMatchThreshold: 0.75,
          },
        ],
      }, {
        sessionId: "trailing-json-session",
        workspacePath: tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain("ephemeral:headline_fetcher");
      expect(runSubAgentMock.mock.calls[0]?.[0]?.agentName).toBe("agent_architect");
      expect(runSubAgentMock.mock.calls[1]?.[0]?.agentName).toBe("ephemeral:headline_fetcher");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 15000);

  it("treats architect-generated ephemeral agents that hit max iterations as failure", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "starlingai-ephemeral-failure-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      agents: {
        defaults: {
          model: { primary: "lmstudio/qwen3.5-4b" },
        },
        ephemeralGeneration: {
          enabled: true,
          skillMatchThreshold: 0.75,
          architectAgentName: "agent_architect",
        },
      },
      subAgents: {
        researcher: {
          description: "Finds web documentation.",
          tools: ["web_search"],
          maxIterations: 4,
        },
        agent_architect: {
          description: "Designs ephemeral agents.",
          tools: ["list_agents"],
          maxIterations: 4,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    collectTaskBidsMock.mockResolvedValue([
      {
        agentName: "researcher",
        confidence: "low",
        matchedTerms: ["memo"],
        score: 0.4,
      },
    ]);

    runSubAgentWithStatsMock.mockImplementation(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => {
      if (String(args.agentName).startsWith("ephemeral:")) {
        return {
          output: "Let me try with an empty string or null for the sessionId:",
          stats: {
            agentName: args.agentName,
            sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
            promptChars: 0,
            userContentChars: String(args.task ?? "").length,
            toolCount: 6,
            toolNames: ["computer_list_windows"],
            iterations: 6,
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            maxIterations: 6,
            model: "mock",
            capabilities: [],
            terminalState: "max_iterations",
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
          terminalState: "completed",
        },
      };
    });

    try {
      const [{ getTool }] = await Promise.all([
        import("../tools/registry.js"),
        import("../tools/sub-agent.js"),
      ]);

      const parallelDelegate = getTool("parallel_delegate");
      expect(parallelDelegate).toBeTruthy();

      const result = await parallelDelegate!.execute({
        tasks: [
          {
            task: "Draft an investor memo focused on unit economics.",
            routingQuery: "investor memo unit economics",
            skillMatchThreshold: 0.75,
          },
        ],
      }, {
        sessionId: "threshold-session-failure",
        workspacePath: tempDir,
      });

      expect(result.success).toBe(false);
      expect(result.output).toContain("could not complete the task");
      expect(runSubAgentMock.mock.calls[0]?.[0]?.agentName).toBe("agent_architect");
      expect(runSubAgentWithStatsMock).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("grants higher iteration cap for computer-use ephemeral agents", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "sai-test-"));
    writeFileSync(
      join(tempDir, "starlingai.json"),
      JSON.stringify({
        server: { port: 0 },
        llm: { providers: [{ name: "mock", type: "openai", baseUrl: "http://localhost:1234/v1", apiKey: "k", models: ["m"] }] },
        agents: {
          defaults: { model: { primary: "m" } },
          ephemeralGeneration: { enabled: true, skillMatchThreshold: 0.75, architectAgentName: "agent_architect" },
          catalog: {
            agent_architect: {
              description: "Designs agents",
              capabilities: [],
              tags: [],
              tools: [],
            },
          },
        },
      }),
    );
    process.env["SAI_CONFIG_PATH"] = join(tempDir, "starlingai.json");

    // Architect returns a computer-use ephemeral agent with maxIterations=5
    runSubAgentMock.mockImplementation(async ({ agentName }: SubAgentRunOptions) => {
      if (agentName === "agent_architect") {
        return JSON.stringify({
          agentName: "desktop_clicker",
          description: "Clicks things on screen",
          systemPrompt: "You click UI elements. Do not repeat identical tool calls.",
          tools: ["computer_list_windows", "computer_focus_window", "computer_snapshot", "computer_click", "computer_type"],
          maxIterations: 5,
          model: { primary: "m", temperature: 0.1 },
        });
      }
      return `${agentName}:done`;
    });

    collectTaskBidsMock.mockResolvedValue([]);

    // Mock runSubAgentWithStats to capture the inlineConfig maxIterations
    let capturedMaxIterations: number | undefined;
    runSubAgentWithStatsMock.mockImplementation(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => {
      if (String(args.agentName).startsWith("ephemeral:")) {
        capturedMaxIterations = args.inlineConfig?.maxIterations;
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
          maxIterations: 20,
          model: "mock",
          capabilities: [],
          terminalState: "completed",
        },
      };
    });

    try {
      const [{ getTool }] = await Promise.all([
        import("../tools/registry.js"),
        import("../tools/sub-agent.js"),
      ]);

      const parallelDelegate = getTool("parallel_delegate");
      expect(parallelDelegate).toBeTruthy();

      await parallelDelegate!.execute({
        tasks: [
          {
            task: "Click the button on screen",
            routingQuery: "desktop automation click button",
            skillMatchThreshold: 0.75,
          },
        ],
      }, {
        sessionId: "computer-iter-test",
        workspacePath: tempDir,
      });

      // The architect was called, then the ephemeral agent was run
      // Because the ephemeral has computer tools, maxIterations should be raised
      // from the architect's 5 to at least 8 (the floor for computer-use)
      expect(capturedMaxIterations).toBeDefined();
      expect(capturedMaxIterations).toBeGreaterThanOrEqual(8);
      expect(capturedMaxIterations).toBeLessThanOrEqual(20);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 15_000);
});