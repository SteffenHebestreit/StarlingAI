import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const completeMock = vi.fn();

vi.mock("../providers/lmstudio.js", async (importActual) => ({
  ...(await importActual<typeof import("../providers/lmstudio.js")>()),
  LMStudioProvider: class {
    async complete(messages: unknown, tools: unknown, signal?: AbortSignal) {
      return completeMock(messages, tools, signal);
    }
  },
}));

/**
 * Session 807684e9: a quality render the person had configured ran for minutes inside
 * image_creator, whose own deadline and "keep going?" threshold read those minutes as a stall.
 * holdTurnClocks holds every clock of the run around such work and credits the time afterwards.
 */
describe("holdTurnClocks inside a specialist", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env["SAI_CONFIG_PATH"];
    completeMock.mockReset();
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    await (await import("../swarm/memory.js")).resetSharedMemoryForTests();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function loadWithRenderTool(turnTimeoutMs: number, renderMs: number) {
    const tempDir = mkdtempSync(join(tmpdir(), "sai-hold-clocks-"));
    tempDirs.push(tempDir);
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        image_creator: {
          description: "Renders images",
          systemPrompt: "Render what you are asked for.",
          tools: ["generate_image"],
          maxIterations: 3,
          turnTimeoutMs,
        },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const [{ registerTool }, { holdTurnClocks }, { longRunningGenerationManager }, { runSubAgentWithStats }] = await Promise.all([
      import("../tools/registry.js"),
      import("../agent/user-input-broker.js"),
      import("../agent/long-running-generation.js"),
      import("../agent/sub-agent.js"),
    ]);
    const seen: { liveBefore?: number; liveAfter?: number } = {};
    registerTool({
      name: "generate_image",
      description: "Render an image the person configured.",
      parameters: { type: "object", properties: {} },
      async execute(_args, ctx) {
        seen.liveBefore = ctx._liveTurnDeadlineMs?.();
        const release = holdTurnClocks(ctx.sessionId, "image_render");
        try {
          await new Promise((resolve) => setTimeout(resolve, renderMs));
        } finally {
          release();
        }
        seen.liveAfter = ctx._liveTurnDeadlineMs?.();
        return { success: true, output: "Rendered generated/harbour.png" };
      },
    });
    completeMock
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{ id: "call-render", name: "generate_image", arguments: {} }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
      })
      .mockResolvedValue({
        content: "The harbour render is done: generated/harbour.png.",
        tool_calls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      });
    return { runSubAgentWithStats, longRunningGenerationManager, seen };
  }

  it("holds the specialist's deadline through the render and credits it afterwards", async () => {
    // A 1 s deadline and a 2 s render: unheld, the deadline latches mid-render and the run comes
    // back from it into timeout synthesis.
    const { runSubAgentWithStats, seen } = await loadWithRenderTool(1_000, 2_000);
    const handedDeadline = Date.now() + 60_000;
    const result = await runSubAgentWithStats({
      agentName: "image_creator",
      task: "Render the harbour at sunset.",
      parentSessionId: "chat-hold",
      workspacePath: "/workspace",
      _turnDeadlineMs: handedDeadline,
    });

    expect(result.stats.terminalState).toBe("completed");
    expect(result.output).toContain("The harbour render is done");
    // A delegation this run made after the render would clamp to the credited deadline.
    expect(seen.liveBefore).toBe(handedDeadline);
    expect(seen.liveAfter! - seen.liveBefore!).toBeGreaterThanOrEqual(2_000);
  }, 60_000);

  it("does not ask \"keep going?\" about minutes it was held", async () => {
    // Past the 3-minute soft threshold in wall time, almost none of it the run's own.
    const { runSubAgentWithStats, longRunningGenerationManager } = await loadWithRenderTool(600_000, 200_000);
    const notify = vi.spyOn(longRunningGenerationManager, "notifyLongRunning");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    let result: Awaited<ReturnType<typeof runSubAgentWithStats>> | undefined;
    const run = runSubAgentWithStats({
      agentName: "image_creator",
      task: "Render the harbour at sunset.",
      parentSessionId: "chat-held-lrg",
      workspacePath: "/workspace",
    }).then((out) => { result = out; });
    for (let step = 0; step < 600 && !result; step += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      await new Promise((resolve) => setImmediate(resolve));
    }
    await run;

    expect(result!.stats.terminalState).toBe("completed");
    expect(notify).not.toHaveBeenCalled();
  }, 60_000);
});
