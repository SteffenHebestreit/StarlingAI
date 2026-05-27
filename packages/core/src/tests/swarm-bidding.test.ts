import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SubAgentRunOptions, SubAgentRunResult } from "../agent/sub-agent.js";

const runSubAgentMock = vi.fn(async ({ agentName, task }: SubAgentRunOptions) => `${agentName}:${task}:done`);

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

describe("swarm autonomous bidding", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    runSubAgentMock.mockReset();
    vi.resetModules();

    const [{ resetSwarmBusForTests }, { resetAutonomousBiddingForTests }, configLoader] = await Promise.all([
      import("../swarm/bus.js"),
      import("../swarm/bidding.js"),
      import("../config/loader.js"),
    ]);

    resetSwarmBusForTests();
    resetAutonomousBiddingForTests();
    configLoader.resetConfigForTests();
  });

  it("emits ranked task bids for autonomous task announcements", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-swarm-bidding-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      agents: {
        defaults: {
          model: { primary: "lmstudio/qwen/qwen3.5-9b" },
        },
      },
      subAgents: {
        browser_agent: {
          description: "Logs into sites and automates forms in the browser.",
          systemPrompt: "Inspect the page and fill the login form.",
          tools: ["get_site_credentials", "mcp__playwright__browser_click"],
          maxIterations: 4,
        },
        researcher: {
          description: "Finds facts on the web and summarizes them.",
          tools: ["web_search", "web_fetch"],
          maxIterations: 4,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    try {
      const [{ emitSwarmEvent }, { collectTaskBids, startAutonomousBidding }] = await Promise.all([
        import("../swarm/bus.js"),
        import("../swarm/bidding.js"),
      ]);
      await import("../tools/sub-agent.js");

      startAutonomousBidding();
      emitSwarmEvent("task_announced", {
        sessionId: "swarm-1",
        taskId: "task-1",
        task: "Complete the login form automation flow",
        data: {
          dispatchMode: "autonomous_bidding",
          routingQuery: "login form automation",
        },
      });

      const bids = await collectTaskBids("task-1", 150);
      expect(bids.length).toBeGreaterThan(0);
      expect(bids[0]?.agentName).toBe("browser_agent");
      expect(bids[0]?.confidence).toMatch(/high|medium|low/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("uses autonomous bids before direct fallback routing in task graphs", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-swarm-bidding-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      agents: {
        defaults: {
          model: { primary: "lmstudio/qwen/qwen3.5-9b" },
        },
      },
      subAgents: {
        browser_agent: {
          description: "Logs into sites and automates forms in the browser.",
          systemPrompt: "Inspect the page and fill the login form.",
          tools: ["get_site_credentials", "mcp__playwright__browser_click"],
          maxIterations: 4,
        },
        researcher: {
          description: "Finds facts on the web and summarizes them.",
          tools: ["web_search", "web_fetch"],
          maxIterations: 4,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    try {
      const [{ getTool }, { startAutonomousBidding }] = await Promise.all([
        import("../tools/registry.js"),
        import("../swarm/bidding.js"),
      ]);
      await import("../tools/sub-agent.js");

      startAutonomousBidding();

      const runTaskGraph = getTool("run_task_graph");
      expect(runTaskGraph).toBeDefined();

      const swarmState: import("../tools/registry.js").SwarmState = {
        objective: "Autonomous bidding",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tasks: {},
      };

      const result = await runTaskGraph!.execute({
        objective: "Let the swarm self-select the best agent",
        nodes: [
          { id: "login", task: "Complete the login form automation flow", routingQuery: "login form automation" },
        ],
      }, {
        sessionId: "swarm-2",
        workspacePath: tempDir,
        swarmState,
      });

      expect(result.success).toBe(true);
      expect(runSubAgentMock).toHaveBeenCalled();
      expect(runSubAgentMock.mock.calls[0]?.[0]?.agentName).toBe("browser_agent");
      expect(result.output).toContain("browser_agent");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 15000);

  it("can restart autonomous bidding after it has been stopped", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-swarm-bidding-restart-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      agents: {
        defaults: {
          model: { primary: "lmstudio/qwen/qwen3.5-9b" },
        },
      },
      subAgents: {
        browser_agent: {
          description: "Logs into sites and automates forms in the browser.",
          systemPrompt: "Inspect the page and fill the login form.",
          tools: ["get_site_credentials", "mcp__playwright__browser_click"],
          maxIterations: 4,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    try {
      const [{ emitSwarmEvent }, { collectTaskBids, startAutonomousBidding, stopAutonomousBidding }] = await Promise.all([
        import("../swarm/bus.js"),
        import("../swarm/bidding.js"),
      ]);
      await import("../tools/sub-agent.js");

      startAutonomousBidding();
      emitSwarmEvent("task_announced", {
        sessionId: "swarm-restart-1",
        taskId: "task-restart-1",
        task: "Complete the login form automation flow",
        data: {
          dispatchMode: "autonomous_bidding",
          routingQuery: "login form automation",
        },
      });

      const firstRound = await collectTaskBids("task-restart-1", 150);
      expect(firstRound[0]?.agentName).toBe("browser_agent");

      stopAutonomousBidding();
      startAutonomousBidding();

      emitSwarmEvent("task_announced", {
        sessionId: "swarm-restart-2",
        taskId: "task-restart-2",
        task: "Complete the login form automation flow again",
        data: {
          dispatchMode: "autonomous_bidding",
          routingQuery: "login form automation",
        },
      });

      const secondRound = await collectTaskBids("task-restart-2", 150);
      expect(secondRound[0]?.agentName).toBe("browser_agent");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 30_000);
});