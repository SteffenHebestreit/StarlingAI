import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const completeMock = vi.fn();

vi.mock("../providers/lmstudio.js", async (importActual) => ({
  // Spread the real module: sub-agent.ts and its helpers import value exports
  // (computePromptTokenBudget, DeadlineAbort, ...) from here, and a mock that
  // replaced the whole module broke every time production code grew an export.
  ...(await importActual<typeof import("../providers/lmstudio.js")>()),
  LMStudioProvider: class {
    async complete(messages: unknown, tools: unknown, signal?: AbortSignal) {
      return completeMock(messages, tools, signal);
    }
  },
}));

/**
 * audit 411ed14f: a coordinator ran parallel_delegate where one slice (a builder)
 * actually WROTE a full multi-file deliverable, but parallel_delegate's aggregate
 * metadata only carried {taskCount, succeeded, failed} — it dropped every slice's
 * artifacts. The built files therefore surfaced ZERO downloads on the parent turn and
 * every artifact-aware honesty guard saw "0 produced", so the turn shipped a
 * research-only stub with no sign of the built app. Single delegate_to_agent and
 * run_workflow already propagate their delegate's artifacts; parallel_delegate must too.
 */
describe("parallel_delegate artifact propagation", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    completeMock.mockReset();
    vi.resetModules();
    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
    const swarmMemory = await import("../swarm/memory.js");
    await swarmMemory.resetSharedMemoryForTests();
  });

  it("surfaces a slice's built file as an artifact on the parent coordinator turn", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "sai-pd-artifacts-"));
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        coord: { description: "Coordinator", systemPrompt: "Coordinate the build mission.", tools: ["parallel_delegate"], maxIterations: 5 },
        builder: { description: "Builder", systemPrompt: "Build files into the workspace.", tools: ["write_file"], maxIterations: 4 },
      },
      orchestration: { maxParallelSlices: 3 },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();
    await import("../tools/sub-agent.js");
    await import("../tools/filesystem.js"); // register write_file for the builder slice

    let coordCalls = 0;
    completeMock.mockImplementation((messages: Array<{ role: string; content?: string }>) => {
      const convo = messages.map((m) => m.content ?? "").join("\n");
      const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
      // Builder: write one file on the first turn, then synthesize.
      if (convo.includes("Build files into the workspace")) {
        if (convo.includes("File written") || convo.includes("index.html (")) {
          return Promise.resolve({ content: "Built the index.html file.", tool_calls: [], usage, finishReason: "stop" });
        }
        return Promise.resolve({
          content: "",
          tool_calls: [{
            id: "wf-1",
            name: "write_file",
            arguments: { path: "generated/app/index.html", content: "<!DOCTYPE html><html><body>App</body></html>" },
          }],
          usage,
          finishReason: "tool_calls",
        });
      }
      // Coordinator: fan out to the builder once, then synthesize.
      coordCalls += 1;
      if (coordCalls === 1) {
        return Promise.resolve({
          content: "",
          tool_calls: [{
            id: "pd-1",
            name: "parallel_delegate",
            arguments: { tasks: [{ agentName: "builder", task: "Build the index.html file for the web app." }] },
          }],
          usage,
          finishReason: "tool_calls",
        });
      }
      return Promise.resolve({ content: "Done — the app was built.", tool_calls: [], usage, finishReason: "stop" });
    });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "coord",
        task: "Coordinate building the web app.",
        parentSessionId: "parent-pd-artifacts",
        workspacePath: tempDir,
      });

      expect(result.output).toBeTruthy();
      // The file the builder slice wrote must surface as an artifact on the
      // coordinator (parent) turn — proving parallel_delegate propagated it.
      const paths = (result.artifacts ?? []).map((a) =>
        String((a as Record<string, unknown>)["relativePath"] ?? (a as Record<string, unknown>)["filename"] ?? ""));
      expect(paths.some((p) => p.includes("index.html"))).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 15000);
});
