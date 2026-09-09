import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A FORCED CALL THAT RETURNS PROSE IS A FAILED TOOL CALL, NOT A TRUNCATED ANSWER.
 *
 * Session 887379b3, "wie wird das wetter morgen?", on the qwen backend:
 *
 *   record_plan      16.0 s    352 tok   tool_calls   10 tools
 *   BURN            150.0 s   8000 tok   length       10 tools (forced)
 *   continuation    155.3 s   8000 tok   length        0 tools
 *   continuation    143.2 s   8000 tok   length        0 tools
 *   synthesis        16.7 s     92 tok   stop         34 tools
 *
 * 448 s of a 506 s turn — 88.6% — generating 24,000 tokens, every one discarded, and the
 * accumulated prose was then rejected by `tool_free_research_answer_rejected` exactly as the
 * turn's own `upfront_source_sensitive_detected` flag (logged two minutes before the first burn)
 * implied it would be.
 *
 * continueLengthLimitedResponse is right for an answer the completion cap cut in half. Under
 * forceToolChoice it is the wrong instrument: the model was REQUIRED to emit an orchestration
 * tool call, prose means it did not, and extending that prose spends the budget on an answer the
 * runtime has already committed to rejecting. The existing `!partialContent.trim()` guard does
 * not catch it, because a burn produces plenty of content — just not a tool call.
 */

const streamMock = vi.hoisted(() => vi.fn());
const completeMock = vi.hoisted(() => vi.fn(async () => ({
  content: "synthesized",
  tool_calls: [],
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  finishReason: "stop",
})));
/** The routing-tier classifier. "VERDICT: yes" is what makes the turn source-sensitive. */
const routingCompleteMock = vi.hoisted(() => vi.fn(async () => ({
  content: "VERDICT: yes",
  tool_calls: [],
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  finishReason: "stop",
})));

vi.mock("../providers/index.js", () => {
  const provider = {
    checkHealth: async () => ({ healthy: true }),
    verifyToolCallSupport: async () => true,
    complete: (...args: unknown[]) => completeMock(...(args as [])),
    stream: (...args: unknown[]) => streamMock(...(args as [])),
    embed: async () => [],
    isHealthy: () => true,
  };
  const routingProvider = { ...provider, complete: (...args: unknown[]) => routingCompleteMock(...(args as [])) };
  return {
    applyActiveModelPreset: (model: unknown) => model,
    getChatProvider: () => provider,
    getChatProviderWithOverride: () => provider,
    // The default harness returns null here, which is why the classifier never fires in the
    // other runtime tests — and why forceToolChoice is unreachable in them.
    getChatProviderForTier: (tier: string) => (tier === "routing" ? routingProvider : null),
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
vi.mock("../audit/logger.js", () => ({ logAudit: vi.fn() }));

/** The burn: lots of prose, no tool call, cut at the completion cap. */
function burnStream(chars = 4000) {
  return (async function* () {
    yield { type: "text_delta", content: "x".repeat(chars) };
    yield {
      type: "done",
      finishReason: "length",
      usage: { promptTokens: 7963, completionTokens: 8000, totalTokens: 15963 },
    };
  })();
}

async function loadRuntime() {
  const dir = mkdtempSync(join(tmpdir(), "sai-forced-burn-"));
  writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
    agents: { mainAssistant: { toolMode: "orchestration_only" } },
    orchestration: {
      // Both are required for forceToolChoice to be reachable at all.
      upfrontSourceSensitiveClassifier: true,
      forceToolChoiceWhenOrchestrationRequired: true,
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

describe("a forced tool call that burns its budget is not continued", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    streamMock.mockReset();
    completeMock.mockClear();
    routingCompleteMock.mockClear();
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
  });

  /**
   * A CONTINUATION IS IDENTIFIABLE BY ITS TOOLS ARGUMENT.
   * continueLengthLimitedResponse calls `provider.stream(messages, [], signal)` — an empty tool
   * array. Every ordinary iteration passes a non-empty one. Counting all extra stream calls
   * conflates continuations with normal loop iterations, which is what my first version of this
   * test did: it read 3 and reported "3 continuations" when the loop was simply going round.
   */
  const continuationCalls = () =>
    streamMock.mock.calls.filter((args) => Array.isArray(args[1]) && (args[1] as unknown[]).length === 0).length;

  it("does not continue a forced call that returned prose at the cap", async () => {
    const { AgentSession, runTurn } = await loadRuntime();
    let call = 0;
    streamMock.mockImplementation(() => {
      call += 1;
      // Burn once, then answer cleanly so the iteration loop terminates and the test measures
      // the continuation path rather than the loop's own retries.
      if (call === 1) return burnStream();
      return (async function* () {
        yield { type: "text_delta", content: "done" };
        yield { type: "done", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      })();
    });

    const session = new AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });
    await runTurn({ session, userMessage: "wie wird das wetter morgen?" });

    // The classifier must actually have run, or forceToolChoice was never set and this proves
    // nothing about the burn path.
    expect(routingCompleteMock, "routing classifier did not run").toHaveBeenCalled();
    expect(continuationCalls(), "a forced burn must not be extended as prose").toBe(0);
  });

  it("still continues a genuinely truncated answer when the call was NOT forced", async () => {
    // Guards the over-broad version of this fix: an ordinary long answer cut by the completion
    // cap must still be stitched. Without forceToolChoice the continuation path is untouched.
    const { AgentSession, runTurn } = await loadRuntime();
    let call = 0;
    streamMock.mockImplementation(() => {
      call += 1;
      // First call burns; later calls finish cleanly so the loop terminates.
      if (call === 1) return burnStream();
      return (async function* () {
        yield { type: "text_delta", content: "tail" };
        yield { type: "done", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      })();
    });
    // No source-sensitivity -> requiresDelegatedResearch false -> forceToolChoice false.
    routingCompleteMock.mockImplementationOnce(async () => ({
      content: "VERDICT: no",
      tool_calls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: "stop",
    }));

    const session = new AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });
    await runTurn({ session, userMessage: "write me a long essay about caching" });

    expect(continuationCalls(), "an unforced truncated answer should still be continued")
      .toBeGreaterThan(0);
  });
});
