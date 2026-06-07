import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const completeMock = vi.fn();

vi.mock("../providers/lmstudio.js", () => ({
  LMStudioProvider: class {
    async complete(messages: unknown, tools: unknown, signal?: AbortSignal) {
      return completeMock(messages, tools, signal);
    }
  },
}));

/**
 * audit d20a9a5e: a coordinator ran parallel_delegate, got partial evidence, then ran
 * parallel_delegate AGAIN with the same canonical body — re-researching everything (~2x turn).
 * parallel_delegate slices carry an auto-allocated `parallel_N` taskId, which used to skip
 * cross-call signature reuse entirely. With allowSignatureReuse, a second round that re-issues
 * the same-signature research reuses the first round's evidence instead of re-running it.
 */
describe("parallel_delegate cross-round reuse", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    completeMock.mockReset();
    vi.resetModules();
    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
    const swarmMemory = await import("../swarm/memory.js");
    await swarmMemory.resetSharedMemoryForTests();
  });

  it("reuses an earlier same-signature slice instead of re-running the researcher", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "sai-parallel-reuse-"));
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        coord: { description: "Coordinator", systemPrompt: "Coordinate the research mission.", tools: ["parallel_delegate"], maxIterations: 5 },
        researcher: { description: "Researcher", systemPrompt: "Research from sources only.", tools: [], maxIterations: 1 },
      },
      orchestration: { maxParallelSlices: 3 },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();
    await import("../tools/sub-agent.js");

    const RESEARCH_BODY =
      "WEB RESEARCH TASK — gather fresh sourced evidence from official primary sources about the "
      + "portable ESP32 microphone-array recording device: confirm every concrete spec, part number, "
      + "and source URL from authoritative datasheets and report anything you could not confirm.";

    let coordCalls = 0;
    let researcherRuns = 0;
    completeMock.mockImplementation((messages: Array<{ role: string; content?: string }>) => {
      const sys = messages.map((m) => m.content ?? "").join("\n");
      if (sys.includes("Research from sources only")) {
        researcherRuns += 1;
        return Promise.resolve({
          content: "ROUND1_EVIDENCE: IM73A135V01 is an analog differential MEMS microphone (Source: infineon.com).",
          tool_calls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          finishReason: "stop",
        });
      }
      // Coordinator: issue parallel_delegate twice with the SAME body, then synthesize.
      coordCalls += 1;
      if (coordCalls <= 2) {
        return Promise.resolve({
          content: "",
          tool_calls: [{
            id: `parallel-${coordCalls}`,
            name: "parallel_delegate",
            arguments: { tasks: [{ agentName: "researcher", task: RESEARCH_BODY }] },
          }],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          finishReason: "tool_calls",
        });
      }
      return Promise.resolve({
        content: "Final synthesis based on the gathered evidence.",
        tool_calls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      });
    });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "coord",
        task: "Coordinate the portable recorder research.",
        parentSessionId: "parent-parallel-reuse",
        workspacePath: tempDir,
      });

      expect(result.output).toBeTruthy();
      // The coordinator issued parallel_delegate twice, but the researcher ran ONCE —
      // the second round reused the first round's evidence.
      expect(coordCalls).toBeGreaterThanOrEqual(2);
      expect(researcherRuns).toBe(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 15000);
});
