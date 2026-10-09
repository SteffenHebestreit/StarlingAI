import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnLoopRecord } from "../agent/delegation-loop-notes.js";

/**
 * THE TURN'S RECORD OF LOOPED RUNS REACHES A NESTED DELEGATION (orchestration.loopAwareDelegation).
 *
 * c297c5ea's looping content_writers ran under a mission_coordinator: two delegations below the
 * turn. The artifact gate and the turn oversight read ONE list per turn (ToolContext._turnLoopRuns),
 * so a sub-agent has to hand that same list to the tools it runs; a delegation that finds none
 * starts its own, which nobody at the turn ever reads. Driven through the real sub-agent loop.
 */

const completeMock = vi.fn();

vi.mock("../providers/lmstudio.js", async (importActual) => ({
  ...(await importActual<typeof import("../providers/lmstudio.js")>()),
  LMStudioProvider: class {
    async complete(messages: unknown, tools: unknown, signal?: AbortSignal, options?: unknown) {
      return completeMock(messages, tools, signal, options);
    }
  },
}));

describe("the turn's record of looped runs in a sub-agent", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    completeMock.mockReset();
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
  });

  it("is the same list in the context of every tool the sub-agent runs", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "starlingai-loop-record-"));
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        mission_coordinator: { description: "Coordinates", systemPrompt: "Coordinate.", tools: ["grep_files"], maxIterations: 4 },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();
    const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
    const { registerTool, unregisterTool } = await import("../tools/registry.js");
    let seen: TurnLoopRecord[] | undefined;
    registerTool({
      name: "grep_files",
      description: "Stub: any tool the sub-agent runs sees the context a nested delegation would.",
      parameters: { type: "object", properties: {} },
      async execute(_args, ctx) {
        seen = ctx._turnLoopRuns;
        return { success: true, output: "delegated." };
      },
    });
    let turns = 0;
    completeMock.mockImplementation(async (_messages: unknown, _tools: unknown, _signal: unknown, options?: { toolChoice?: string }) => {
      const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
      if (options?.toolChoice === "none" || turns++ >= 1) return { content: "Done.", tool_calls: [], usage, finishReason: "stop" };
      return { content: "", tool_calls: [{ id: "call-1", name: "grep_files", arguments: {} }], usage, finishReason: "tool_calls" };
    });

    const turnRecord: TurnLoopRecord[] = [];
    try {
      await runSubAgentWithStats({
        agentName: "mission_coordinator",
        task: "Build the deck and the paper.",
        parentSessionId: "loop-record-nesting",
        workspacePath: tempDir,
        _turnLoopRuns: turnRecord,
      });
      expect(seen).toBe(turnRecord);
    } finally {
      unregisterTool("grep_files");
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
