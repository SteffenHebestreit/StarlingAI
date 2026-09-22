import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const completeMock = vi.fn();

vi.mock("../providers/lmstudio.js", async (importActual) => ({
  ...(await importActual<typeof import("../providers/lmstudio.js")>()),
  LMStudioProvider: class {
    async complete(messages: unknown, tools: unknown, signal?: AbortSignal) {
      return completeMock(messages, tools, signal);
    }
  },
}));

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return {
    content: "",
    tool_calls: [{ id, name, arguments: args }],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    finishReason: "tool_calls",
  };
}

const DONE = {
  content: "Summary of the findings.",
  tool_calls: [],
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  finishReason: "stop",
};

/**
 * EVERY CALL THAT ANNOUNCES A START ANNOUNCES AN END.
 *
 * The chat renders a specialist's tool calls as live rows: a `tool_start` opens a row with a
 * spinner and a ticking timer, the matching `tool_done` closes it with its outcome. Seven
 * branches in the sub-agent loop answer a call WITHOUT running it — the duplicate-call caches,
 * the per-tool / per-path / failure / artifact caps, the write-loop guard — and each skipped
 * past the only `tool_done`. Its `tool_start` was already sent, so the row kept spinning for
 * the rest of the turn and was finally labelled "no result reported", although the call had
 * been answered instantly. The caches fire routinely on local models.
 */
describe("sub-agent progress events pair up", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    completeMock.mockReset();
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
  });

  it("closes a call the duplicate cache answered, and says it was not run", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "starlingai-progress-pairing-"));
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        researcher: {
          description: "Finds sources on the web.",
          systemPrompt: "Research the question.",
          tools: ["web_search"],
          maxIterations: 8,
        },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    // The same search twice in a row: the second is served from the duplicate cache.
    const responses = [
      toolCall("s1", "web_search", { query: "strix halo npu" }),
      toolCall("s2", "web_search", { query: "strix halo npu" }),
      DONE,
    ];
    completeMock.mockImplementation(async () => responses.shift() ?? DONE);

    const { registerTool, unregisterTool } = await import("../tools/registry.js");
    registerTool({
      name: "web_search", description: "Search the web.",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { success: true, output: "Three sources about the Strix Halo NPU and its image throughput." };
      },
    });

    const events: Array<{ kind: string; toolCallId?: string; metadata?: Record<string, unknown> }> = [];
    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      await runSubAgentWithStats({
        agentName: "researcher",
        task: "Find sources on the Strix Halo NPU.",
        parentSessionId: "parent-progress-pairing",
        workspacePath: "/workspace",
        onProgress: (event) => {
          if (event.kind === "tool_start" || event.kind === "tool_done") {
            events.push({ kind: event.kind, toolCallId: event.toolCallId, metadata: event.metadata as Record<string, unknown> | undefined });
          }
        },
      });
    } finally {
      unregisterTool("web_search");
      rmSync(tempDir, { recursive: true, force: true });
    }

    const started = events.filter(e => e.kind === "tool_start").map(e => e.toolCallId);
    const finished = events.filter(e => e.kind === "tool_done").map(e => e.toolCallId);
    // Both calls were announced — the precondition, or this test proves nothing.
    expect(started).toEqual(["s1", "s2"]);
    // The pairing that was broken: every started call finished.
    expect(new Set(finished)).toEqual(new Set(started));

    // The one that really ran is an ordinary completion — the control.
    const real = events.find(e => e.kind === "tool_done" && e.toolCallId === "s1");
    expect(real?.metadata?.["notExecuted"]).toBeUndefined();
    // The cached one says what it was, so the row can say "cached" instead of implying work.
    const cached = events.find(e => e.kind === "tool_done" && e.toolCallId === "s2");
    expect(cached?.metadata).toMatchObject({ notExecuted: true, cached: true });
  });
});
