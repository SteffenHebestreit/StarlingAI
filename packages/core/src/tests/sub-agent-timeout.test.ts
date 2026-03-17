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
});