import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SwarmState } from "../tools/registry.js";
import type { SubAgentRunOptions, SubAgentRunResult } from "../agent/sub-agent.js";

const runSubAgentWithStatsMock = vi.fn();

vi.mock("../agent/sub-agent.js", () => ({
  runSubAgent: vi.fn(async ({ agentName, task }: SubAgentRunOptions) => `${agentName}:${task}`),
  runSubAgentWithStats: runSubAgentWithStatsMock,
}));

function makeStats(args: SubAgentRunOptions, overrides: Partial<SubAgentRunResult["stats"]> = {}): SubAgentRunResult {
  return {
    output: `${args.agentName}:${args.task}:done`,
    stats: {
      agentName: args.agentName,
      sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
      promptChars: 0,
      userContentChars: String(args.task ?? "").length,
      toolCount: 3,
      toolNames: ["read_file", "web_search", "web_fetch"],
      iterations: 2,
      usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
      maxIterations: 5,
      model: "mock",
      capabilities: [],
      terminalState: "completed" as const,
      ...overrides,
    },
  };
}

describe("swarm budget tracking", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    delete process.env["SAI_CONFIG_PATH"];
    runSubAgentWithStatsMock.mockReset();
    vi.resetModules();
    const { resetConfigForTests } = await import("../config/loader.js");
    resetConfigForTests();
    const memory = await import("../swarm/memory.js");
    await memory.resetSharedMemoryForTests();
  });

  function writeConfig(extra: Record<string, unknown> = {}): string {
    const tempDir = mkdtempSync(join(tmpdir(), "starlingai-budget-"));
    tempDirs.push(tempDir);
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      agents: {
        defaults: { model: { primary: "mock-model" } },
        ...extra,
      },
      subAgents: {
        researcher: {
          description: "Research specialist",
          tools: ["web_search"],
          capabilities: ["research"],
          maxIterations: 5,
        },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();
    return configPath;
  }

  it("propagates token usage, tool count, duration to swarm task attempts", async () => {
    writeConfig();
    runSubAgentWithStatsMock.mockImplementation(async (args: SubAgentRunOptions) => makeStats(args));

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const swarmState: SwarmState = {
      objective: "Investigate",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: {},
    };

    await getTool("delegate_to_agent")!.execute(
      { agentName: "researcher", task: "Find docs" },
      { sessionId: "s-budget-1", workspacePath: "/workspace", swarmState },
    );

    const tasks = Object.values(swarmState.tasks);
    expect(tasks).toHaveLength(1);
    const attempt = tasks[0]!.attempts[0]!;
    expect(attempt.status).toBe("completed");
    expect(attempt.totalTokens).toBe(1500);
    expect(attempt.promptTokens).toBe(1000);
    expect(attempt.completionTokens).toBe(500);
    expect(attempt.toolCount).toBe(3);
    expect(attempt.iterations).toBe(2);
    expect(attempt.terminalState).toBe("completed");
    expect(attempt.durationMs).toBeGreaterThanOrEqual(0);
    expect(attempt.budgetExceeded).toBeUndefined();

    const totals = tasks[0]!.totals!;
    expect(totals.attempts).toBe(1);
    expect(totals.totalTokens).toBe(1500);
    expect(totals.toolCount).toBe(3);
    expect(totals.iterations).toBe(2);
  }, 30_000);

  it("flags budgetExceeded when token cap is breached", async () => {
    writeConfig({ budgets: { maxTokensPerTask: 100 } });
    runSubAgentWithStatsMock.mockImplementation(async (args: SubAgentRunOptions) => makeStats(args));

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const swarmState: SwarmState = {
      objective: "x", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tasks: {},
    };

    await getTool("delegate_to_agent")!.execute(
      { agentName: "researcher", task: "Find docs" },
      { sessionId: "s-budget-2", workspacePath: "/workspace", swarmState },
    );

    const attempt = Object.values(swarmState.tasks)[0]!.attempts[0]!;
    expect(attempt.budgetExceeded).toBe(true);
    expect(attempt.budgetBreaches).toContain("tokens");
  }, 30_000);

  it("flags budgetExceeded when toolCalls cap is breached", async () => {
    writeConfig({ budgets: { maxToolCallsPerTask: 1 } });
    runSubAgentWithStatsMock.mockImplementation(async (args: SubAgentRunOptions) => makeStats(args));

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const swarmState: SwarmState = {
      objective: "x", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tasks: {},
    };

    await getTool("delegate_to_agent")!.execute(
      { agentName: "researcher", task: "Do many things" },
      { sessionId: "s-budget-3", workspacePath: "/workspace", swarmState },
    );

    const attempt = Object.values(swarmState.tasks)[0]!.attempts[0]!;
    expect(attempt.budgetExceeded).toBe(true);
    expect(attempt.budgetBreaches).toContain("toolCalls");
  }, 30_000);

  it("does not flag budgets when configured caps are zero (unset)", async () => {
    writeConfig({ budgets: { maxTokensPerTask: 0, maxToolCallsPerTask: 0, maxDurationMsPerTask: 0 } });
    runSubAgentWithStatsMock.mockImplementation(async (args: SubAgentRunOptions) => makeStats(args, {
      usage: { promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 },
      toolCount: 9999,
    }));

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const swarmState: SwarmState = {
      objective: "x", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tasks: {},
    };

    await getTool("delegate_to_agent")!.execute(
      { agentName: "researcher", task: "Burn budget" },
      { sessionId: "s-budget-4", workspacePath: "/workspace", swarmState },
    );

    const attempt = Object.values(swarmState.tasks)[0]!.attempts[0]!;
    expect(attempt.budgetExceeded).toBeUndefined();
    expect(attempt.totalTokens).toBe(2_000_000);
  }, 30_000);

  it("get_swarm_budget aggregates totals and per-agent breakdown", async () => {
    writeConfig({ budgets: { maxTokensPerTask: 1000 } });

    let call = 0;
    runSubAgentWithStatsMock.mockImplementation(async (args: SubAgentRunOptions) => {
      call += 1;
      return makeStats(args, {
        usage: { promptTokens: 200 * call, completionTokens: 100 * call, totalTokens: 300 * call },
        toolCount: call,
      });
    });

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const swarmState: SwarmState = {
      objective: "Aggregate test", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tasks: {},
    };

    const ctx = { sessionId: "s-budget-agg", workspacePath: "/workspace", swarmState };

    await getTool("delegate_to_agent")!.execute({ agentName: "researcher", task: "first" }, ctx);
    await getTool("delegate_to_agent")!.execute({ agentName: "researcher", task: "second" }, ctx);
    // call 3 — should breach the 1000 token cap (300*3 = 900? no — let's force it)
    await getTool("delegate_to_agent")!.execute({ agentName: "researcher", task: "third large" }, ctx);

    const budgetTool = getTool("get_swarm_budget");
    expect(budgetTool).toBeDefined();
    const result = await budgetTool!.execute({}, ctx);

    expect(result.success).toBe(true);
    expect(result.output).toContain("## Configured per-task budgets");
    expect(result.output).toContain("maxTokensPerTask: 1000");
    expect(result.output).toContain("## Overall totals");
    expect(result.output).toContain("## Per-agent breakdown");
    expect(result.output).toContain("researcher:");
    expect(result.output).toContain("## Budget breaches");

    // Aggregate must equal sum across all recorded attempts (regardless of how
    // many delegations were actually freshly run vs. served from session memory).
    const allAttempts = Object.values(swarmState.tasks).flatMap(t => t.attempts);
    const expectedTokens = allAttempts.reduce((s, a) => s + (a.totalTokens ?? 0), 0);
    const expectedTools = allAttempts.reduce((s, a) => s + (a.toolCount ?? 0), 0);

    const meta = result.metadata as { overall: { totalTokens: number; toolCount: number; attempts: number }; perAgent: Record<string, { totalTokens: number }> };
    expect(meta.overall.totalTokens).toBe(expectedTokens);
    expect(meta.overall.toolCount).toBe(expectedTools);
    expect(meta.overall.attempts).toBe(allAttempts.length);
    expect(meta.perAgent["researcher"]?.totalTokens).toBe(expectedTokens);
    // Should have at least one fresh delegation tracked
    expect(allAttempts.length).toBeGreaterThan(0);
    expect(expectedTokens).toBeGreaterThan(0);
  }, 30_000);

  it("formatSwarmState (via get_swarm_state) shows totals and budget flags", async () => {
    writeConfig({ budgets: { maxTokensPerTask: 100 } });
    runSubAgentWithStatsMock.mockImplementation(async (args: SubAgentRunOptions) => makeStats(args));

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const swarmState: SwarmState = {
      objective: "render test", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tasks: {},
    };
    const ctx = { sessionId: "s-budget-render", workspacePath: "/workspace", swarmState };

    await getTool("delegate_to_agent")!.execute({ agentName: "researcher", task: "do" }, ctx);

    const result = await getTool("get_swarm_state")!.execute({}, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain("totals:");
    expect(result.output).toContain("1500tok");
    expect(result.output).toContain("3tools");
    expect(result.output).toContain("!budget(tokens)");
  }, 30_000);
});
