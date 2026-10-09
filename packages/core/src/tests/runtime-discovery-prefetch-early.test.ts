import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * THE DISCOVERY PREFETCH STARTS BESIDE THE JUDGE (finding 2026-10-05).
 *
 * The capsule reads only the user's message and the turn's agent grant. It used to start inside
 * the first prompt assembly — after the source judge's wait and the document retrieval — so its
 * embedding round-trip, up to its 2.5 s cap, sat on the path to the first orchestrator token. The
 * runtime now starts it as soon as the fast lane declines the turn and hands the promise to
 * iteration 0. Observed here as an ORDER: the judge does not answer until the prefetch has
 * started (or 1.5 s pass), so the prefetch must have started before the judge resolved.
 */

const events = vi.hoisted(() => [] as string[]);
const prefetchStarted = vi.hoisted(() => {
  let resolve: () => void = () => {};
  const state = { promise: new Promise<void>((r) => { resolve = r; }), resolve: () => resolve() };
  return state;
});
const prefetchCalls = vi.hoisted(() => ({ count: 0 }));
const streamMock = vi.hoisted(() => vi.fn());

vi.mock("../providers/index.js", () => {
  const answer = (content: string) => ({ content, tool_calls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop" });
  const provider = {
    checkHealth: async () => ({ healthy: true }),
    verifyToolCallSupport: async () => true,
    complete: async () => answer("synthesized"),
    stream: (...args: unknown[]) => streamMock(...(args as [])),
    embed: async () => [],
    isHealthy: () => true,
  };
  // The source judge: it answers only once the prefetch has started, or after 1.5 s.
  const routingProvider = {
    ...provider,
    complete: async () => {
      await Promise.race([prefetchStarted.promise, new Promise((r) => setTimeout(r, 1_500))]);
      events.push("judge_resolved");
      return answer("VERDICT: no");
    },
  };
  return {
    applyActiveModelPreset: (model: unknown) => model,
    getChatProvider: () => provider,
    getChatProviderWithOverride: () => provider,
    getChatProviderForTier: (tier: string) => (tier === "routing" ? routingProvider : null),
  };
});

vi.mock("../agent/discovery-prefetch.js", () => ({
  formatDiscoveryCapsule: () => "",
  prefetchCapabilityCandidates: async () => {
    prefetchCalls.count += 1;
    events.push("prefetch_started");
    prefetchStarted.resolve();
    return "[CAPABILITY CANDIDATES — discovered up-front for this turn]\n- researcher";
  },
}));

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

async function loadRuntime() {
  const dir = mkdtempSync(join(tmpdir(), "sai-prefetch-early-"));
  writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
    agents: { mainAssistant: { toolMode: "orchestration_only" } },
    orchestration: {
      discoveryPrefetch: true,
      upfrontSourceSensitiveClassifier: true,
      planFirst: false,
      qaDeliveryLoop: false,
      riskGatedQA: false,
      finalResponseQaGate: false,
    },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
  vi.resetModules();
  const [{ AgentSession }, { runTurn }] = await Promise.all([
    import("../agent/session.js"),
    import("../agent/runtime.js"),
  ]);
  return { AgentSession, runTurn };
}

describe("the discovery prefetch is started beside the source judge, not after it", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    streamMock.mockReset();
    events.length = 0;
    prefetchCalls.count = 0;
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
  });

  it("starts before the judge resolves, runs once, and its capsule reaches the first call", async () => {
    const { AgentSession, runTurn } = await loadRuntime();
    streamMock.mockImplementation(() => (async function* () {
      yield { type: "text_delta", content: "Here is the answer." };
      yield { type: "done", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    })());

    const session = new AgentSession({ channel: "test", workspacePath: mkdtempSync(join(tmpdir(), "sai-prefetch-ws-")), systemPrompt: "You are a test agent." });
    await runTurn({ session, userMessage: "which recorder should I buy for interviews?" });

    // The judge must actually have run, or the order below proves nothing.
    expect(events).toContain("judge_resolved");
    expect(events.indexOf("prefetch_started")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("prefetch_started")).toBeLessThan(events.indexOf("judge_resolved"));
    // Iteration 0 consumed the promise it was handed instead of starting a second prefetch...
    expect(prefetchCalls.count).toBe(1);
    // ...and the capsule it produced is in the first orchestrator call.
    const firstPrompt = ((streamMock.mock.calls[0]?.[0] ?? []) as Array<{ content?: unknown }>)
      .map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    expect(firstPrompt).toContain("[CAPABILITY CANDIDATES");
  });
});
