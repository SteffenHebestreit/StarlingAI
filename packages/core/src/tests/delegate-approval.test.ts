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

  it.skip("does not pin Top-Themen news queries to shell_agent when routing points to web research", async () => { // needs live embedding/model backend
    const tempDir = mkdtempSync(join(tmpdir(), "starlingai-news-delegate-"));
    tempDirs.push(tempDir);
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      agents: {
        defaults: {
          model: { primary: "lmstudio/qwen/qwen3.5-9b" },
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