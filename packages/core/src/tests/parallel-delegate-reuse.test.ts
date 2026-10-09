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

  // Lever #1 (audit 1fd36e04): the first reuse hands the cached evidence over, but a
  // SECOND identical re-delegation of the same already-gathered research is a loop —
  // the pipeline must stop replaying the cache and return a hard "already gathered,
  // author/synthesize now" stop (which counts toward the caller's failure budget),
  // instead of silently serving the same evidence again while the slow model burns a
  // generation each round. The prompt's own anti-loop rule did not prevent this live.
  it("stops replaying the cache after the reuse limit and tells the agent to author", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "sai-reuse-limit-"));
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        coord: { description: "Coordinator", systemPrompt: "Coordinate the research mission.", tools: ["parallel_delegate"], maxIterations: 6 },
        researcher: { description: "Researcher", systemPrompt: "Research from sources only.", tools: [], maxIterations: 1 },
      },
      orchestration: { maxParallelSlices: 3 },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();
    await import("../tools/sub-agent.js");

    // ≥240 compacted chars so the per-round "gap" suffix below falls beyond the
    // buildTaskSignature(summarizeText(task, 240)) window → identical signature.
    const RESEARCH_PREFIX =
      "WEB RESEARCH TASK — gather fresh sourced evidence from official primary sources about the "
      + "portable ESP32 microphone-array recording device: confirm every concrete spec, part number, "
      + "and source URL from authoritative datasheets and report anything you could not confirm before drafting.";
    // Each round re-issues the SAME canonical research (identical signature) but with a
    // DIFFERENT trailing gap note — so the loop's identical-args cache MISSES and the call
    // reaches the cross-call signature-reuse pipeline, exactly as in the live audit.
    const roundBody = (n: number) => `${RESEARCH_PREFIX} Round ${n} gap to fill: drill into open sub-detail number ${n}.`;

    let coordCalls = 0;
    let researcherRuns = 0;
    let sawExhaustedStop = false;
    completeMock.mockImplementation((messages: Array<{ role: string; content?: string }>) => {
      const convo = messages.map((m) => m.content ?? "").join("\n");
      if (convo.includes("Research from sources only")) {
        researcherRuns += 1;
        return Promise.resolve({
          content: "ROUND1_EVIDENCE: IM73A135V01 is an analog differential MEMS microphone (Source: infineon.com).",
          tool_calls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          finishReason: "stop",
        });
      }
      // The coordinator sees the exhausted-reuse stop fed back as a prior tool result.
      if (convo.includes("ALREADY GATHERED")) sawExhaustedStop = true;
      coordCalls += 1;
      // Re-issue the same-signature research three times, then synthesize.
      if (coordCalls <= 3) {
        return Promise.resolve({
          content: "",
          tool_calls: [{
            id: `parallel-${coordCalls}`,
            name: "parallel_delegate",
            arguments: { tasks: [{ agentName: "researcher", task: roundBody(coordCalls) }] },
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
        parentSessionId: "parent-reuse-limit",
        workspacePath: tempDir,
      });

      expect(result.output).toBeTruthy();
      // Despite THREE identical research rounds, the researcher still ran exactly once.
      expect(researcherRuns).toBe(1);
      // Round 1 ran fresh; round 2 served the cache; round 3 hit the limit and was told
      // to stop re-researching and author/synthesize — surfaced back to the coordinator.
      expect(sawExhaustedStop).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 15000);
});
