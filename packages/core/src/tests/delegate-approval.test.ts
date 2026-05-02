import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubAgentRunOptions, SubAgentRunResult } from "../agent/sub-agent.js";

const runSubAgentMock = vi.fn(async (_args: SubAgentRunOptions) => "delegated");

vi.mock("../agent/sub-agent.js", () => ({
  runSubAgent: runSubAgentMock,
  runSubAgentWithStats: vi.fn(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => ({
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
    },
  })),
}));

describe("delegate_to_agent approval propagation", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    delete process.env["SAI_CONFIG_PATH"];
    runSubAgentMock.mockClear();
    vi.resetModules();

    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
  });

  it("passes approval settings from the parent tool context to sub-agents", async () => {
    const [{ getTool }, _subAgentTools] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const delegate = getTool("delegate_to_agent");
    expect(delegate).toBeDefined();

    const approvalCallback = vi.fn(async () => true);
    const result = await delegate!.execute(
      {
        agentName: "browser_agent",
        task: "Pruefe n8n auf neue Projekte.",
      },
      {
        sessionId: "session-1",
        workspacePath: "/workspace",
        approvalCallback,
        humanInLoopSteps: ["site_fill_credentials", "mcp__playwright__browser_navigate"],
      },
    );

    expect(result.success).toBe(true);
    expect(runSubAgentMock).toHaveBeenCalledTimes(1);
    expect(runSubAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      agentName: "browser_agent",
      parentSessionId: "session-1",
      workspacePath: "/workspace",
      signal: undefined,
      approvalCallback,
      humanInLoopSteps: ["site_fill_credentials", "mcp__playwright__browser_navigate"],
    }));
  });

  it("pins owned-computer access tasks to computer_use_agent when agentName is omitted", async () => {
    const [{ getTool }, _subAgentTools] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const delegate = getTool("delegate_to_agent");
    expect(delegate).toBeDefined();

    const result = await delegate!.execute(
      {
        task: "check auf meinem pc unter 10.10.0.2 welche models geladen sind in lm studio",
      },
      {
        sessionId: "session-2",
        workspacePath: "/workspace",
      },
    );

    expect(result.success).toBe(true);
    expect(runSubAgentMock).toHaveBeenCalledTimes(1);
    expect(runSubAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      agentName: "computer_use_agent",
      parentSessionId: "session-2",
      workspacePath: "/workspace",
    }));
  });

  it("pins durable memory save tasks to productivity_agent when agentName is omitted", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "starlingai-memory-delegate-"));
    tempDirs.push(tempDir);
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      agents: {
        defaults: {
          model: { primary: "lmstudio/qwen3.5-9b" },
        },
      },
      subAgents: {
        productivity_agent: {
          description: "Personal productivity specialist for notes, reminders, timers, and lightweight follow-up tracking.",
          capabilities: ["note taking", "workspace memory", "reminder scheduling", "timer management"],
          tags: ["productivity", "notes", "reminder", "timer", "alarm", "todo"],
          tools: ["memory_store", "memory_search", "reminder_create", "reminder_list", "timer_start", "timer_list", "timer_cancel"],
          maxIterations: 6,
        },
        web_task_coordinator: {
          description: "Coordinates live web research and browser tasks.",
          capabilities: ["web retrieval", "research"],
          tags: ["web", "research"],
          tools: ["delegate_to_agent", "share_finding"],
          maxIterations: 6,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const [{ getTool }, _subAgentTools] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const delegate = getTool("delegate_to_agent");
    expect(delegate).toBeDefined();

    const result = await delegate!.execute(
      {
        task: "Store the following user information in persistent memory: User's personal public portfolio website URL is https://steffen-hebestreit.com",
      },
      {
        sessionId: "session-memory-1",
        workspacePath: tempDir,
      },
    );

    expect(result.success).toBe(true);
    expect(runSubAgentMock).toHaveBeenCalledTimes(1);
    expect(runSubAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      agentName: "productivity_agent",
      parentSessionId: "session-memory-1",
      workspacePath: tempDir,
    }));
  });

  it("pins durable memory save tasks for swarm_delegate too", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "starlingai-memory-swarm-"));
    tempDirs.push(tempDir);
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      agents: {
        defaults: {
          model: { primary: "lmstudio/qwen3.5-9b" },
        },
      },
      subAgents: {
        productivity_agent: {
          description: "Personal productivity specialist for notes, reminders, timers, and lightweight follow-up tracking.",
          capabilities: ["note taking", "workspace memory", "reminder scheduling", "timer management"],
          tags: ["productivity", "notes", "reminder", "timer", "alarm", "todo"],
          tools: ["memory_store", "memory_search", "reminder_create", "reminder_list", "timer_start", "timer_list", "timer_cancel"],
          maxIterations: 6,
        },
        web_task_coordinator: {
          description: "Coordinates live web research and browser tasks.",
          capabilities: ["web retrieval", "research"],
          tags: ["web", "research"],
          tools: ["delegate_to_agent", "share_finding"],
          maxIterations: 6,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const [{ getTool }, _subAgentTools] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const swarmDelegate = getTool("swarm_delegate");
    expect(swarmDelegate).toBeDefined();

    const result = await swarmDelegate!.execute(
      {
        task: "Store the following user identity information in persistent memory: User's name is Steffen. He is the operator and main user of the system.",
      },
      {
        sessionId: "session-memory-2",
        workspacePath: tempDir,
      },
    );

    expect(result.success).toBe(true);
    expect(runSubAgentMock).toHaveBeenCalledTimes(1);
    expect(runSubAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      agentName: "productivity_agent",
      parentSessionId: "session-memory-2",
      workspacePath: tempDir,
    }));
  });

  it("pins SSH and Docker server tasks to a server-capable agent when agentName is omitted", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "starlingai-server-delegate-"));
    tempDirs.push(tempDir);
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      computerUse: {
        nodes: {
          "n8n-server": {
            adapter: "remote_ssh",
            host: "n8n.k2o",
            port: 22,
            username: "Steffen",
            authMethod: "password",
            credentials: "$SAI_N8N_SSH_PASSWORD",
          },
        },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();

    const [{ getTool }, _subAgentTools] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const delegate = getTool("delegate_to_agent");
    expect(delegate).toBeDefined();

    const result = await delegate!.execute(
      {
        task: "ssh into my n8n-server and tell me which docker containers are running",
      },
      {
        sessionId: "session-3",
        workspacePath: "/workspace",
      },
    );

    expect(result.success).toBe(true);
    expect(runSubAgentMock).toHaveBeenCalledTimes(1);
    expect(runSubAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      agentName: "shell_agent",
      context: expect.stringContaining("nodeName: n8n-server"),
      parentSessionId: "session-3",
      workspacePath: "/workspace",
    }));
  });

  it("does not pin Top-Themen news queries to shell_agent when routing points to web research", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "starlingai-news-delegate-"));
    tempDirs.push(tempDir);
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      agents: {
        defaults: {
          model: { primary: "lmstudio/qwen3.5-9b" },
        },
      },
      subAgents: {
        web_task_coordinator: {
          description: "Coordinator for freshness-sensitive web tasks that need research, browser interaction, and evidence synthesis.",
          capabilities: ["multi-agent coordination", "web retrieval", "browser orchestration", "evidence synthesis"],
          tags: ["coordination", "web", "browser", "research"],
          tools: ["search_agents", "delegate_to_agent", "parallel_delegate", "run_task_graph"],
          maxIterations: 6,
        },
        researcher: {
          description: "Finds facts on the web and summarizes them.",
          capabilities: ["web research", "documentation lookup", "source triangulation"],
          tags: ["research", "web", "docs"],
          tools: ["web_search", "web_fetch"],
          maxIterations: 4,
        },
        shell_agent: {
          description: "Executes shell commands and terminal operations.",
          capabilities: ["shell execution", "terminal commands", "scripting", "system operations"],
          tags: ["shell", "terminal", "devops"],
          tools: ["execute_shell"],
          maxIterations: 5,
        },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();

    const [{ getTool }, _subAgentTools] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const delegate = getTool("delegate_to_agent");
    expect(delegate).toBeDefined();

    const result = await delegate!.execute(
      {
        task: "Gib mir eine Übersicht der wichtigsten aktuellen Nachrichten und Entwicklungen vom 18.–19. April 2026. Fokus auf: Politik (Deutschland/Europa), Wirtschaft/Technologie, und ein oder zwei internationale Top-Themen. Kurze, prägnante Zusammenfassung mit Quellenangaben.",
        routingQuery: "web research news current events",
      },
      {
        sessionId: "session-4",
        workspacePath: "/workspace",
      },
    );

    expect(result.success).toBe(true);
    expect(runSubAgentMock).toHaveBeenCalledTimes(1);
    expect(runSubAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      agentName: "web_task_coordinator",
      parentSessionId: "session-4",
      workspacePath: "/workspace",
    }));
  });
});