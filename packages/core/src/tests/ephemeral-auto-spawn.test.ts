/**
 * G34 — Ephemeral auto-spawn tests.
 *
 * Verifies that when all catalog agents return low-confidence matches,
 * the delegation machinery (executeDelegationWithFallback) calls the
 * architect fallback to design and run a purpose-built ephemeral agent.
 *
 * The LLM and sub-agent runner are fully mocked; no real network calls are made.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SubAgentRunOptions, SubAgentRunResult } from "../agent/sub-agent.js";
import type { SwarmState } from "../tools/registry.js";

// ── Mocks ──────────────────────────────────────────────────────────────────

/**
 * Architect spec returned by the mocked chat provider.
 * Matches the ArchitectEphemeralSpec shape expected by requestArchitectSpec().
 */
const MOCK_SPEC = {
  agentName: "niche_specialist",
  description: "One-shot specialist for the test task",
  systemPrompt: "You are a specialist. Complete the task and produce a final answer.",
  tools: ["web_search"],
  maxIterations: 3,
};

const chatProviderMock = {
  chat: vi.fn(async () => ({
    content: JSON.stringify(MOCK_SPEC),
    tool_calls: [],
    finishReason: "stop",
    usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
  })),
  stream: vi.fn(async function* () { yield { content: "", tool_calls: [], done: true }; }),
};

vi.mock("../providers/index.js", () => ({
  getChatProvider: () => chatProviderMock,
  getChatProviderWithOverride: () => chatProviderMock,
}));

const runSubAgentWithStatsMock = vi.fn(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => ({
  output: `ephemeral:niche_specialist: task completed successfully`,
  stats: {
    agentName: args.agentName,
    sessionId: `sub:${args.parentSessionId ?? "test"}:${args.agentName}:test`,
    promptChars: 0,
    userContentChars: String(args.task ?? "").length,
    toolCount: 2,
    toolNames: ["web_search"],
    iterations: 2,
    usage: { promptTokens: 50, completionTokens: 80, totalTokens: 130 },
    maxIterations: 3,
    model: "mock",
    capabilities: [],
    terminalState: "completed" as const,
    outcome: "success" as const,
  },
}));

vi.mock("../agent/sub-agent.js", () => ({
  runSubAgent: vi.fn(async ({ agentName, task }: SubAgentRunOptions) => `${agentName}:${task}`),
  runSubAgentWithStats: runSubAgentWithStatsMock,
}));

// ── Helpers ────────────────────────────────────────────────────────────────

function makeConfig(ws: string) {
  return {
    workspacePath: ws,
    agents: {
      defaults: {
        model: { primary: "mock-model" },
        maxIterations: 5,
        turnTimeoutMs: 30_000,
      },
      performance: { promptBudgetChars: 100_000 },
      maxTotalDelegationsPerTurn: 5,
      maxToolIterations: 20,
      ephemeralGeneration: {
        enabled: true,
        skillMatchThreshold: 0.70,
        architectAgentName: "agent_architect",
      },
    },
    // No matching sub-agents — forces low-confidence routing
    subAgents: {},
    guardrails: { enabled: false },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("G34: ephemeral auto-spawn", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    delete process.env["SAI_CONFIG_PATH"];
    vi.resetModules();
    runSubAgentWithStatsMock.mockClear();
    chatProviderMock.chat.mockClear();
    const { resetConfigForTests } = await import("../config/loader.js");
    resetConfigForTests();
    const memory = await import("../swarm/memory.js");
    await memory.resetSharedMemoryForTests();
  });

  it("drafts and runs an ephemeral agent when no catalog match exists", async () => {
    const ws = mkdtempSync(join(tmpdir(), "sai-g34-"));
    mkdirSync(join(ws, ".starlingai"), { recursive: true });
    tempDirs.push(ws);

    // Write a minimal config with no sub-agents so routing finds nothing
    const cfgPath = join(ws, "starlingai.json");
    writeFileSync(cfgPath, JSON.stringify({
      workspacePath: ws,
      agents: {
        defaults: { model: { primary: "mock-model" } },
        ephemeralGeneration: {
          enabled: true,
          skillMatchThreshold: 0.70,
          architectAgentName: "agent_architect",
        },
      },
      subAgents: {},
    }), "utf-8");
    process.env["SAI_CONFIG_PATH"] = cfgPath;

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const delegate = getTool("delegate_to_agent");
    expect(delegate).toBeDefined();

    const swarmState: SwarmState = {
      objective: "Perform a niche task with no matching catalog agent",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: {},
    };

    const result = await delegate!.execute({
      task: "Fetch the current status of the experimental niche-data-api endpoint and parse the JSON response",
    }, {
      sessionId: "session-g34",
      workspacePath: ws,
      swarmState,
    });

    // Architect fallback should produce a successful result
    expect(result.success).toBe(true);
    expect(result.output).toBeTruthy();
    // The ephemeral agent name should appear in output or metadata
    const outputOrMeta = result.output + JSON.stringify(result.metadata ?? {});
    expect(outputOrMeta).toMatch(/ephemeral|niche_specialist|architect/i);
    // Sub-agent runner should have been called (for the ephemeral agent run)
    expect(runSubAgentWithStatsMock).toHaveBeenCalled();
  }, 30_000);

  it("ephemeral fallback is skipped when architect generation is disabled", async () => {
    const ws = mkdtempSync(join(tmpdir(), "sai-g34-disabled-"));
    mkdirSync(join(ws, ".starlingai"), { recursive: true });
    tempDirs.push(ws);

    const cfgPath = join(ws, "starlingai.json");
    writeFileSync(cfgPath, JSON.stringify({
      workspacePath: ws,
      agents: {
        defaults: { model: { primary: "mock-model" } },
        ephemeralGeneration: {
          enabled: false,  // <-- disabled
          skillMatchThreshold: 0.70,
          architectAgentName: "agent_architect",
        },
      },
      subAgents: {},
    }), "utf-8");
    process.env["SAI_CONFIG_PATH"] = cfgPath;

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const delegate = getTool("delegate_to_agent");
    expect(delegate).toBeDefined();

    const swarmState: SwarmState = {
      objective: "test",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: {},
    };

    await delegate!.execute({
      task: "Perform a completely novel task with no matching agent",
    }, {
      sessionId: "session-g34-disabled",
      workspacePath: ws,
      swarmState,
    });

    // The architect chat provider must NOT have been called when disabled
    // (even if heuristic coordinator fallbacks still produce some result)
    expect(chatProviderMock.chat).not.toHaveBeenCalled();
  }, 15_000);

  it("promoted ephemeral agent is preferred on the second matching task", async () => {
    const ws = mkdtempSync(join(tmpdir(), "sai-g34-promote-"));
    mkdirSync(join(ws, ".starlingai"), { recursive: true });
    tempDirs.push(ws);

    // Pre-seed a promoted agent entry to simulate a previously-successful ephemeral
    const promotedPath = join(ws, ".starlingai", "promoted_agents.json");
    writeFileSync(promotedPath, JSON.stringify({
      niche_specialist: {
        description: "One-shot specialist for niche-data-api tasks",
        capabilities: ["niche data", "api parsing"],
        tags: ["niche", "api", "data"],
        systemPrompt: "You are a specialist for niche-data-api. Fetch and parse the endpoint.",
        tools: ["web_search", "web_fetch"],
        maxIterations: 3,
        successCount: 3,
        successRate: 1.0,
      },
    }), "utf-8");

    const cfgPath = join(ws, "starlingai.json");
    writeFileSync(cfgPath, JSON.stringify({
      workspacePath: ws,
      agents: {
        defaults: { model: { primary: "mock-model" } },
        ephemeralGeneration: {
          enabled: true,
          skillMatchThreshold: 0.70,
          architectAgentName: "agent_architect",
        },
      },
      subAgents: {},
    }), "utf-8");
    process.env["SAI_CONFIG_PATH"] = cfgPath;

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const delegate = getTool("delegate_to_agent");
    expect(delegate).toBeDefined();

    const swarmState: SwarmState = {
      objective: "test promoted",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: {},
    };

    const result = await delegate!.execute({
      task: "Fetch the current niche data api status",
    }, {
      sessionId: "session-g34-promoted",
      workspacePath: ws,
      swarmState,
    });

    expect(result.success).toBe(true);
    // Promoted agent should have been used (routing picks it up from promoted_agents.json)
    expect(runSubAgentWithStatsMock).toHaveBeenCalled();
  }, 30_000);
});
