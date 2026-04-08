import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutcomeEntry } from "../agent/outcomes.js";

const completeMock = vi.fn();

vi.mock("../providers/lmstudio.js", () => ({
  LMStudioProvider: class {
    async complete(messages: unknown, tools: unknown, signal?: AbortSignal) {
      return completeMock(messages, tools, signal);
    }
  },
}));

describe("sub-agent turn timeouts", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    completeMock.mockReset();
    vi.resetModules();

    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
  });

  it("aborts long-running sub-agent LLM calls using per-agent turnTimeoutMs", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-timeout-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        slow_agent: {
          description: "Timeout test agent",
          systemPrompt: "Wait for the task to finish.",
          tools: [],
          maxIterations: 2,
          turnTimeoutMs: 1000,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;

    completeMock.mockImplementation((_messages: unknown, _tools: unknown, signal?: AbortSignal) => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "slow_agent",
        task: "Do a very slow thing.",
        parentSessionId: "parent-1",
        workspacePath: "/workspace",
      });

      expect(result.output).toContain("timed out after 1000ms");
      expect(completeMock).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 10000);

  it("includes partial swarm progress in timeout output when work was already underway", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-timeout-progress-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        coordinator_agent: {
          description: "Coordinator timeout test agent",
          systemPrompt: "Coordinate the task and use tools.",
          tools: ["get_swarm_state"],
          maxIterations: 3,
          turnTimeoutMs: 1000,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const { registerTool, unregisterTool } = await import("../tools/registry.js");
    registerTool({
      name: "get_swarm_state",
      description: "Populate swarm progress for timeout testing",
      parameters: { type: "object", properties: {} },
      async execute(_args, context) {
        const startedAt = new Date().toISOString();
        context.swarmState = {
          objective: "Build ETF chart",
          startedAt,
          updatedAt: startedAt,
          tasks: {
            fetch: {
              id: "fetch",
              title: "Fetch monthly ETF figures",
              status: "completed",
              dependsOn: [],
              selectedAgent: "researcher",
              attempts: [{
                agentName: "researcher",
                status: "completed",
                startedAt,
                finishedAt: startedAt,
                summary: "Collected monthly MSCI World ETF figures.",
              }],
              output: "Collected monthly MSCI World ETF figures.",
            },
          },
        };
        return { success: true, output: "Progress seeded" };
      },
    });

    completeMock
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [
          {
            id: "seed-1",
            name: "get_swarm_state",
            arguments: {},
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
      })
      .mockImplementationOnce((_messages: unknown, _tools: unknown, signal?: AbortSignal) => new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }));

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "coordinator_agent",
        task: "Coordinate an ETF chart build.",
        parentSessionId: "parent-progress",
        workspacePath: tempDir,
      });

      expect(result.output).toContain("timed out after 1000ms");
      expect(result.output).toContain("Partial progress before interruption");
      expect(result.stats.outcome).toBe("partial");
      expect(result.output).toContain("fetch [completed] Fetch monthly ETF figures via researcher");
      expect(result.output).toContain("Tool calls executed: 1 (get_swarm_state)");
    } finally {
      unregisterTool("get_swarm_state");
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 10000);

  it("gives coordinator agents (with run_task_graph) an elevated default timeout floor", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-coordinator-timeout-"));
    const configPath = join(tempDir, "starlingai.json");
    const turnTimeoutMs = 900_000; // 15 min gateway turn timeout

    writeFileSync(configPath, JSON.stringify({
      gateway: { turnTimeoutMs },
      subAgents: {
        coord_agent: {
          description: "Coordinator that uses run_task_graph",
          systemPrompt: "Coordinate work.",
          tools: ["run_task_graph", "parallel_delegate", "delegate_to_agent"],
          maxIterations: 4,
          // NO turnTimeoutMs — should get 85% of gateway turn timeout as floor
        },
      },
    }), "utf8");

    // Seed short outcome history so adaptive would normally pick a LOW timeout
    const stateDir = join(tempDir, ".starlingai");
    mkdirSync(stateDir, { recursive: true });
    const outcomesFile = join(stateDir, "agent_outcomes.ndjson");
    const makeOutcome = (durationMs: number): OutcomeEntry => ({
      ts: new Date().toISOString(),
      agent: "coord_agent",
      task: "simple delegation",
      outcome: "success",
      iterations: 2,
      totalTokens: 100,
      durationMs,
      timeoutMs: 60_000,
    });
    // 3 short completions that would produce an adaptive timeout of ~45s × 1.5 = 67.5s
    for (const durationMs of [40_000, 42_000, 45_000]) {
      appendFileSync(outcomesFile, JSON.stringify(makeOutcome(durationMs)) + "\n");
    }

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    // Mock LLM to immediately return so we can inspect the audit event
    completeMock.mockResolvedValue({
      content: "coordinated",
      tool_calls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: "stop",
    });

    // Capture audit events via subscriber
    const { subscribeToAudit } = await import("../audit/logger.js");
    const auditEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const unsubscribe = subscribeToAudit((event) => {
      auditEvents.push({ type: event.type, data: event.data as Record<string, unknown> });
    });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "coord_agent",
        task: "Run a complex task graph.",
        parentSessionId: "parent-coord",
        workspacePath: tempDir,
      });

      expect(result.output).toBe("coordinated");

      // The coordinator default floor = 900_000 * 0.85 = 765_000 ms.
      // Adaptive p95 from history = 45_000 * 1.5 = 67_500, but Math.max(67_500, 765_000) = 765_000.
      // So the resolved timeout should be >= 765_000 ms (the coordinator floor wins).
      const startEvent = auditEvents.find(
        (e) => e.type === "sub_agent_started" && e.data?.agentName === "coord_agent",
      );
      expect(startEvent).toBeDefined();
      // timeoutMs should be at least the coordinator floor (765s), NOT the short adaptive value (67.5s)
      expect(startEvent!.data.timeoutMs).toBeGreaterThanOrEqual(765_000);
    } finally {
      unsubscribe();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 10000);

  it("passes an adaptive timeout-derived signal when the agent has enough recent duration history", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-adaptive-timeout-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      agents: {
        performance: {
          subAgentTurnSloMs: 60_000,
        },
      },
      subAgents: {
        adaptive_agent: {
          description: "Adaptive timeout test agent",
          systemPrompt: "Finish quickly.",
          tools: [],
          maxIterations: 1,
        },
      },
    }), "utf8");

    const stateDir = join(tempDir, ".starlingai");
    mkdirSync(stateDir, { recursive: true });
    const outcomesFile = join(stateDir, "agent_outcomes.ndjson");
    const makeOutcome = (durationMs: number): OutcomeEntry => ({
      ts: new Date().toISOString(),
      agent: "adaptive_agent",
      task: "historical",
      outcome: "success",
      iterations: 1,
      totalTokens: 50,
      durationMs,
      timeoutMs: 60_000,
    });
    for (const durationMs of [90_000, 100_000, 110_000]) {
      appendFileSync(outcomesFile, JSON.stringify(makeOutcome(durationMs)) + "\n");
    }

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    completeMock.mockResolvedValue({
      content: "done",
      tool_calls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: "stop",
    });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "adaptive_agent",
        task: "Use adaptive timeout.",
        parentSessionId: "parent-2",
        workspacePath: tempDir,
      });

      expect(result.output).toBe("done");
      expect(completeMock).toHaveBeenCalledTimes(1);
      const passedSignal = completeMock.mock.calls[0]?.[2] as AbortSignal | undefined;
      expect(passedSignal).toBeDefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reduces computer-use agents to read-only tools for observation tasks", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-computer-observe-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        computer_use_agent: {
          description: "Computer use agent",
          systemPrompt: "Inspect the user's desktop.",
          tools: [
            "computer_list_nodes",
            "computer_list_sessions",
            "computer_session_start",
            "computer_session_attach",
            "computer_list_windows",
            "computer_snapshot",
            "computer_capture_region",
            "computer_click",
            "computer_type",
            "computer_hotkey",
          ],
          maxIterations: 2,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const { registerTool, unregisterTool } = await import("../tools/registry.js");
    const stubToolNames = [
      "computer_list_nodes",
      "computer_list_sessions",
      "computer_session_start",
      "computer_session_attach",
      "computer_list_windows",
      "computer_snapshot",
      "computer_capture_region",
      "computer_click",
      "computer_type",
      "computer_hotkey",
    ];
    for (const toolName of stubToolNames) {
      registerTool({
        name: toolName,
        description: `Stub tool ${toolName}`,
        parameters: { type: "object", properties: {} },
        async execute() {
          return { success: true, output: `${toolName} ok` };
        },
      });
    }

    completeMock.mockImplementationOnce(async (_messages: unknown, tools: unknown) => {
      const toolNames = Array.isArray(tools)
        ? (tools as Array<{ name?: string }>).map((tool) => tool.name).filter(Boolean)
        : [];
      expect(toolNames).toContain("computer_snapshot");
      expect(toolNames).not.toContain("computer_click");
      expect(toolNames).not.toContain("computer_type");
      expect(toolNames).not.toContain("computer_hotkey");
      return {
        content: "snapshot reviewed",
        tool_calls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      };
    });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "computer_use_agent",
        task: "Take a screenshot of the remote PC and describe what is visible on screen.",
        parentSessionId: "parent-observe",
        workspacePath: tempDir,
      });

      expect(result.output).toBe("snapshot reviewed");
      expect(completeMock).toHaveBeenCalledTimes(1);
    } finally {
      for (const toolName of stubToolNames) {
        unregisterTool(toolName);
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("treats maxIterationsOverride=0 as unlimited for delegated sub-agents", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-unlimited-iterations-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        unlimited_agent: {
          description: "Unlimited iteration test agent",
          systemPrompt: "Inspect the workspace before replying.",
          tools: ["read_file"],
          maxIterations: 1,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const { registerTool, unregisterTool } = await import("../tools/registry.js");
    registerTool({
      name: "read_file",
      description: "Stub read tool",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { success: true, output: "workspace overview" };
      },
    });

    completeMock
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [
          {
            id: "read-1",
            name: "read_file",
            arguments: { path: "workspace/README.md" },
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
      })
      .mockResolvedValueOnce({
        content: "finished after reading",
        tool_calls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "unlimited_agent",
        task: "Review the workspace.",
        parentSessionId: "parent-unlimited",
        workspacePath: tempDir,
        maxIterationsOverride: 0,
      });

      expect(result.output).toBe("finished after reading");
      expect(result.stats.toolCount).toBe(1);
      expect(result.stats.iterations).toBe(1);
      expect(completeMock).toHaveBeenCalledTimes(2);
    } finally {
      unregisterTool("read_file");
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects coordinator-style completion claims when no tool calls were executed", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-hallucinated-completion-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        pentest_coordinator: {
          description: "Pentest coordinator",
          systemPrompt: "Coordinate a pentest and report results.",
          tools: ["delegate_to_agent", "parallel_delegate", "run_task_graph", "pentest_set_scope"],
          maxIterations: 2,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    completeMock.mockResolvedValue({
      content: [
        "Let me check the agent outputs directly. The task graph completed successfully, which means all phases were executed.",
        "Passive Reconnaissance - osint_agent completed",
        "Comprehensive Report Generation - report_writer_agent completed",
      ].join("\n"),
      tool_calls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: "stop",
    });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "pentest_coordinator",
        task: "Run the pentest.",
        parentSessionId: "parent-3",
        workspacePath: tempDir,
      });

      expect(result.output).toContain("claimed delegated work completed without executing any tool calls");
      expect(result.stats.toolCount).toBe(0);
      expect(completeMock).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("injects explicit tool inventory and delegate catalog guidance for coordinator agents", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-coordinator-guidance-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        mission_coordinator: {
          description: "Mission coordinator",
          systemPrompt: "Coordinate the work.",
          tools: ["list_agents", "search_agents", "delegate_to_agent", "run_task_graph"],
          maxIterations: 2,
        },
        researcher: {
          description: "Research specialist",
          systemPrompt: "Research things.",
          tools: ["read_file"],
          maxIterations: 1,
        },
        coder: {
          description: "Coding specialist",
          systemPrompt: "Write code.",
          tools: ["write_file"],
          maxIterations: 1,
        },
        browser_agent: {
          description: "Browser specialist",
          systemPrompt: "Browse pages.",
          tools: ["browser_navigate"],
          maxIterations: 1,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    completeMock.mockResolvedValue({
      content: "Coordinator finished.",
      tool_calls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: "stop",
    });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      await runSubAgentWithStats({
        agentName: "mission_coordinator",
        task: "Coordinate a repo maintenance task.",
        parentSessionId: "parent-coordinator-guidance",
        workspacePath: tempDir,
        allowedAgents: ["researcher", "coder"],
      });

      expect(completeMock).toHaveBeenCalledTimes(1);
      const messages = completeMock.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
      const systemMessage = messages?.find((message) => message.role === "system")?.content ?? "";

      expect(systemMessage).toContain("TOOL INVENTORY");
      expect(systemMessage).toContain("You may use only these tools in this run: list_agents, search_agents, delegate_to_agent, run_task_graph");
      expect(systemMessage).toContain("AGENT DISCOVERY");
      expect(systemMessage).toContain("Delegation in this run is restricted to these agents: researcher, coder");
      expect(systemMessage).toContain("- researcher: Research specialist");
      expect(systemMessage).toContain("- coder: Coding specialist");
      expect(systemMessage).not.toContain("browser_agent");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects narrated tool-call markup when no tool calls were executed", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-narrated-tool-call-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        pentest_specialist: {
          description: "Pentest specialist",
          systemPrompt: "Use tools to test the target.",
          tools: ["browser_navigate", "browser_snapshot"],
          maxIterations: 2,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    completeMock.mockResolvedValue({
      content: [
        "<tool_call>",
        "<function=mcp_playwright_browser_navigate>",
        "<parameter=url>",
        "https://steffen-hebestreit.com/swagger-ui.html",
        "</parameter>",
        "</function>",
        "</tool_call>",
      ].join("\n"),
      tool_calls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: "stop",
    });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "pentest_specialist",
        task: "Open the target in the browser.",
        parentSessionId: "parent-4",
        workspacePath: tempDir,
      });

      expect(result.output).toContain("emitted narrated tool-call text without executing any tool calls");
      expect(result.stats.toolCount).toBe(0);
      expect(completeMock).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects unsupported scan-blocking claims when no tool calls were executed", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-scan-blocking-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        recon_agent: {
          description: "Recon agent",
          systemPrompt: "Run recon and report blockers truthfully.",
          tools: ["nmap_scan", "pentest_exec"],
          maxIterations: 2,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    completeMock.mockResolvedValue({
      content: "I am unable to proceed with active reconnaissance due to persistent HTTP 403 Forbidden responses when attempting browser navigation and scanning.",
      tool_calls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: "stop",
    });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "recon_agent",
        task: "Run reconnaissance.",
        parentSessionId: "parent-5",
        workspacePath: tempDir,
      });

      expect(result.output).toContain("reported scan blocking or HTTP findings without executing any tool calls");
      expect(result.stats.toolCount).toBe(0);
      expect(completeMock).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reduces mail_agent tools for simple inbox-read tasks", async () => {
    const { getEffectiveToolNames } = await import("../agent/sub-agent.js");

    const toolNames = getEffectiveToolNames(
      "mail_agent",
      [
        "mail_list_accounts",
        "mail_list_mailboxes",
        "mail_search",
        "mail_read",
        "mail_list_unread",
        "mail_prepare_draft",
        "mail_update_draft",
        "mail_get_draft",
        "mail_categorize",
        "mail_send_draft",
        "read_shared_facts",
        "share_finding",
      ],
      "Check mal ob ich neue email bekommen habe",
    );

    expect(toolNames).toEqual([
      "mail_list_accounts",
      "mail_list_mailboxes",
      "mail_search",
      "mail_read",
      "mail_list_unread",
    ]);
  });

  it("completes simple inbox checks through deterministic mail tools without invoking the LLM", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-mail-deterministic-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      agents: {
        defaults: {
          model: {
            primary: "lmstudio/gemma-4-26b-a4b-it",
            temperature: 0.1,
            maxTokens: 1024,
          },
        },
      },
      subAgents: {
        mail_agent: {
          description: "Mail agent",
          systemPrompt: "Use mail tools first.",
          tools: [
            "mail_list_accounts",
            "mail_list_unread",
            "mail_read",
          ],
          maxIterations: 2,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const { registerTool, unregisterTool } = await import("../tools/registry.js");

    registerTool({
      name: "mail_list_accounts",
      description: "List mail accounts",
      parameters: { type: "object", properties: {} },
      async execute() {
        return {
          success: true,
          output: "- work: user@example.com <user@example.com>",
          metadata: { accounts: [{ id: "work", address: "user@example.com" }] },
        };
      },
    });

    registerTool({
      name: "mail_list_unread",
      description: "List unread messages",
      parameters: { type: "object", properties: {} },
      async execute() {
        return {
          success: true,
          output: "- [work] Project Update from boss@example.com (INBOX#101 on 2026-04-03)",
          metadata: {
            messages: [{
              accountId: "work",
              mailbox: "INBOX",
              uid: 101,
              subject: "Project Update",
              from: "boss@example.com",
              date: "2026-04-03",
            }],
          },
        };
      },
    });

    registerTool({
      name: "mail_read",
      description: "Read a message",
      parameters: { type: "object", properties: {} },
      async execute() {
        return {
          success: true,
          output: "Project Update body",
          metadata: {
            message: {
              textBody: "Here is the latest project update with the next milestones and owners.",
            },
          },
        };
      },
    });

    completeMock.mockResolvedValue({
      content: "should not be used",
      tool_calls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: "stop",
    });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "mail_agent",
        task: "Check mal ob ich neue email bekommen habe",
        parentSessionId: "parent-mail-2",
        workspacePath: tempDir,
      });

      expect(result.output).toContain("Unread messages found: 1.");
      expect(result.output).toContain("Project Update");
      expect(result.stats.toolCount).toBe(3);
      expect(completeMock).not.toHaveBeenCalled();
    } finally {
      unregisterTool("mail_list_accounts");
      unregisterTool("mail_list_unread");
      unregisterTool("mail_read");
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("forwards computer callbacks into delegated tool execution", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-computer-callbacks-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        computer_use_agent: {
          description: "Computer automation agent",
          systemPrompt: "Use the computer tools.",
          tools: ["workspace_search"],
          maxIterations: 2,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const { registerTool, unregisterTool } = await import("../tools/registry.js");
    registerTool({
      name: "workspace_search",
      description: "Emit synthetic computer callbacks for tests.",
      parameters: { type: "object", properties: {} },
      async execute(_args, context) {
        context.onComputerSessionState?.({ computerSessionId: "session-test", state: "active" });
        context.onComputerAction?.({ computerSessionId: "session-test", actionType: "snapshot" });
        context.onComputerScreenshot?.({
          computerSessionId: "session-test",
          dataUrl: "data:image/png;base64,AA==",
          width: 1,
          height: 1,
        });
        return { success: true, output: "callback emitted" };
      },
    });

    completeMock
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{ id: "call-1", name: "workspace_search", arguments: {} }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
      })
      .mockResolvedValueOnce({
        content: "done",
        tool_calls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      });

    const seenStates: string[] = [];
    const seenActions: string[] = [];
    const seenScreenshots: string[] = [];

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "computer_use_agent",
        task: "Emit a synthetic computer event.",
        parentSessionId: "parent-callbacks",
        workspacePath: tempDir,
        onComputerSessionState(event) {
          seenStates.push(event.state);
        },
        onComputerAction(event) {
          seenActions.push(event.actionType);
        },
        onComputerScreenshot(event) {
          seenScreenshots.push(event.dataUrl);
        },
      });

      expect(result.output).toBe("done");
      expect(seenStates).toEqual(["active"]);
      expect(seenActions).toEqual(["snapshot"]);
      expect(seenScreenshots).toEqual(["data:image/png;base64,AA=="]);
    } finally {
      unregisterTool("workspace_search");
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("deduplicates consecutive identical tool calls and returns cached result", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-dedup-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        dedup_agent: {
          description: "Dedup test agent",
          systemPrompt: "Use tools as needed.",
          tools: ["workspace_search"],
          maxIterations: 5,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    let executeCount = 0;
    const { registerTool, unregisterTool } = await import("../tools/registry.js");
    registerTool({
      name: "workspace_search",
      description: "A searchable tool.",
      parameters: { type: "object", properties: { query: { type: "string" } } },
      async execute() {
        executeCount++;
        return { success: true, output: "search result: found 3 items" };
      },
    });

    completeMock
      // Iteration 1: model calls workspace_search twice with identical args
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [
          { id: "call-1", name: "workspace_search", arguments: { query: "hello" } },
          { id: "call-2", name: "workspace_search", arguments: { query: "hello" } },
        ],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
      })
      // Iteration 2: model calls it AGAIN with same args
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [
          { id: "call-3", name: "workspace_search", arguments: { query: "hello" } },
        ],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
      })
      // Iteration 3: model returns final answer
      .mockResolvedValueOnce({
        content: "Found 3 items.",
        tool_calls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "dedup_agent",
        task: "Search for things.",
        parentSessionId: "parent-dedup",
        workspacePath: tempDir,
      });

      expect(result.output).toBe("Found 3 items.");
      // The tool should only have been ACTUALLY executed once (first call).
      // The second call in iteration 1 and the call in iteration 2 should be deduped.
      expect(executeCount).toBe(1);
      // But all 3 tool calls should be counted
      expect(result.stats.toolCount).toBe(3);
    } finally {
      unregisterTool("workspace_search");
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});