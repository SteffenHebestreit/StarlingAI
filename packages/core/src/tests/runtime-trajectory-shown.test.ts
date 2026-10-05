import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * THE TRAJECTORY CACHE IS SCORED ONLY ON WHAT THE MODEL SAW (finding 2026-10-05).
 *
 * Two defects in one path. The lookup (a query embedding plus a parse of the cache file) ran on
 * the critical path of every turn, but under agents.performance.leanContextInjection — the
 * default — the prompt never injects its result. And the turn's outcome then scored the hit
 * anyway: an apology invalidated an entry the model had never been shown, a good answer logged it
 * as used. Same when the prompt-budget trimmer dropped it.
 *
 * Observed on the cache module's own entry points: was it looked up, and was it invalidated.
 */

const lookupTrajectory = vi.hoisted(() => vi.fn());
const invalidateTrajectory = vi.hoisted(() => vi.fn());
vi.mock("../memory/trajectory-cache.js", () => ({
  lookupTrajectory,
  invalidateTrajectory,
  writeTrajectory: vi.fn(async () => {}),
}));

const streamMock = vi.hoisted(() => vi.fn());
vi.mock("../providers/index.js", () => {
  const provider = {
    checkHealth: async () => ({ healthy: true }),
    verifyToolCallSupport: async () => true,
    complete: async () => ({ content: "synthesized", tool_calls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop" }),
    stream: (...args: unknown[]) => streamMock(...(args as [])),
    embed: async () => [],
    isHealthy: () => true,
  };
  return {
    applyActiveModelPreset: (model: unknown) => model,
    getChatProvider: () => provider,
    getChatProviderWithOverride: () => provider,
    getChatProviderForTier: () => null,
  };
});
vi.mock("../guardrails/rate-limiter.js", () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })) }));
vi.mock("../guardrails/input.js", () => ({
  checkInput: vi.fn(() => ({ allowed: true, detectedPatterns: [] })),
  checkToolOutput: vi.fn(() => ({ allowed: true })),
}));
vi.mock("../guardrails/moderation.js", () => ({
  moderateInputText: vi.fn(async () => null),
  moderateToolResultText: vi.fn(async () => null),
}));
vi.mock("../guardrails/output.js", () => ({ scanOutput: vi.fn((text: string) => ({ safe: true, redacted: text })) }));
vi.mock("../audit/logger.js", () => ({ logAudit: vi.fn(), subscribeToAudit: () => () => {} }));

const HIT = {
  entry: {
    finishedAt: new Date().toISOString(),
    channel: "test",
    ttlSeconds: 86_400,
    normalizedQuery: "which recorder should i buy",
    queryEmbedding: [1, 0],
    sharedFindings: ["recorder B has the better preamp"],
    finalAnswer: `CACHED-ANSWER ${"Recorder B is the better pick for interviews. ".repeat(20)}`,
  },
  similarity: 0.93,
};

async function runApologyTurn(performance: Record<string, unknown>): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "sai-trajectory-shown-"));
  writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
    agents: { performance },
    orchestration: { planFirst: false, qaDeliveryLoop: false, riskGatedQA: false, finalResponseQaGate: false },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
  vi.resetModules();
  const [{ AgentSession }, { runTurn }] = await Promise.all([
    import("../agent/session.js"),
    import("../agent/runtime.js"),
  ]);
  // A stub answer: the outcome that invalidates the injected entry.
  streamMock.mockImplementation(() => (async function* () {
    yield { type: "text_delta", content: "Sorry." };
    yield { type: "done", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  })());
  const session = new AgentSession({ channel: "test", workspacePath: mkdtempSync(join(tmpdir(), "sai-trajectory-ws-")), systemPrompt: "You are a test agent." });
  await runTurn({ session, userMessage: "which recorder should I buy?" });
  return ((streamMock.mock.calls[0]?.[0] ?? []) as Array<{ content?: unknown }>)
    .map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
}

describe("the trajectory cache is looked up and scored only when its entry reaches the model", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    streamMock.mockReset();
    lookupTrajectory.mockReset();
    invalidateTrajectory.mockReset();
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
  });

  it("does not look it up at all under leanContextInjection, which never injects it", async () => {
    lookupTrajectory.mockResolvedValue(HIT);
    await runApologyTurn({ leanContextInjection: true });
    expect(lookupTrajectory).not.toHaveBeenCalled();
    expect(invalidateTrajectory).not.toHaveBeenCalled();
  });

  it("scores an entry that was shown: a stub answer invalidates it", async () => {
    // The control: without it, the case below would pass with the scoring deleted entirely.
    lookupTrajectory.mockResolvedValue(HIT);
    const prompt = await runApologyTurn({ leanContextInjection: false });
    expect(prompt).toContain("CACHED-ANSWER");
    expect(invalidateTrajectory).toHaveBeenCalledTimes(1);
  });

  it("does not score an entry the prompt-budget trimmer dropped before the model saw it", async () => {
    lookupTrajectory.mockResolvedValue(HIT);
    const prompt = await runApologyTurn({ leanContextInjection: false, promptBudgetChars: 1_000 });
    expect(lookupTrajectory).toHaveBeenCalledTimes(1);
    expect(prompt).not.toContain("CACHED-ANSWER");
    expect(invalidateTrajectory).not.toHaveBeenCalled();
  });
});
