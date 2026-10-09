import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A FORCED TOOL CALL RUNS THINKING-OFF WITH A BOUNDED OUTPUT — EXCEPT THE ONE THAT PLANS.
 *
 * Audit log turn 2, 10 Sept, "wie wird das wetter morgen?": the forced iteration (tool_choice
 * "required", 10 orchestration tools, the orchestrator's thinking ON) reasoned for 8,000 tokens,
 * finished with reason "length" and ZERO tool calls — 150.0 s of a 208 s turn. 1f4a295 stops the
 * runtime from CONTINUING such a call (forced-tool-call-burn.test.ts); this file covers the burn
 * itself. That burn was the DISPATCH iteration, which only has to name an agent and a task, so it
 * goes out with thinking off and a 4,000-token ceiling.
 *
 * The FIRST forced iteration of an orchestration turn is a different call: while no plan exists,
 * filterForcedOrchestrationTools offers record_plan and withholds execute_plan, so that call is
 * the one that writes the steps and acceptance criteria — the turn's real deliberation, measured
 * at 13.1 s with thinking on and a plan at the end of it. It keeps its thinking; only the token
 * ceiling applies (it was sized to clear a record_plan in the first place).
 *
 * The assertion is on what reached the provider: the 4th argument of provider.stream.
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
    // A routing tier is what lets the classifier run, and its "yes" is what makes the
    // first iteration a forced one.
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

/**
 * Whether this turn already has a recorded plan. The forced-call options branch on exactly this
 * (runtime: `forcedPlanState.planRecorded`), so the mock is the switch between the two cases.
 * Only loadTurnPlan is swapped; the rest of the module is the real one.
 */
const planState = vi.hoisted(() => ({ recorded: false }));
vi.mock("../agent/turn-plan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agent/turn-plan.js")>();
  return {
    ...actual,
    loadTurnPlan: async (sessionId: string) => (planState.recorded
      ? {
          objective: "answer the weather question with researched data",
          steps: [{ id: "s1", description: "research tomorrow's weather", kind: "delegate" as const }],
          acceptanceCriteria: ["cites a source"],
          stopConditions: [],
          riskTier: "low" as const,
          wide: false,
          createdAt: new Date().toISOString(),
        }
      : actual.loadTurnPlan(sessionId)),
  };
});

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
  const dir = mkdtempSync(join(tmpdir(), "sai-forced-controls-"));
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

/** The options bag each provider.stream call received (its 4th argument). */
const streamOptions = () => streamMock.mock.calls.map((args) => args[3] as Record<string, unknown> | undefined);

describe("a forced tool call is issued thinking-off with a bounded output — unless it is the one recording the plan", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    streamMock.mockReset();
    completeMock.mockClear();
    routingCompleteMock.mockClear();
    planState.recorded = false;
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
  });

  /** One burned forced call, then a clean non-forced answer so the turn terminates. */
  function burnThenAnswer() {
    let call = 0;
    streamMock.mockImplementation(() => {
      call += 1;
      if (call === 1) return burnStream();
      return (async function* () {
        yield { type: "text_delta", content: "done" };
        yield { type: "done", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      })();
    });
  }

  it("with a plan already recorded, sends controls {enableThinking:false, reasoningEffort:'none'} and maxTokens 4000 on the forced call only", async () => {
    planState.recorded = true;
    const { AgentSession, runTurn } = await loadRuntime();
    burnThenAnswer();

    const session = new AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });
    await runTurn({ session, userMessage: "wie wird das wetter morgen?" });

    // The classifier must actually have run, or forceToolChoice was never set and the first
    // call's options prove nothing about the forced path.
    expect(routingCompleteMock, "routing classifier did not run").toHaveBeenCalled();
    const options = streamOptions();
    expect(options.length, "expected a forced call followed by a non-forced one").toBeGreaterThanOrEqual(2);

    // This is the DISPATCH shape the burn was measured on: the plan exists, so the forced call
    // only has to name an agent and a task.
    const forced = options[0];
    expect(forced?.["toolChoice"], "first call was not the forced call").toBe("required");
    expect(forced?.["controls"]).toEqual({ enableThinking: false, reasoningEffort: "none" });
    expect(forced?.["maxTokens"]).toBe(4000);
    // Thinking-off made the burn rarer, not impossible (9 of 12 forced calls on a prompt the model
    // wanted to answer itself). The prefill is asked for on every forced call, bare when no tool
    // is the one right answer; the provider sends it only where ModelConfig.toolCallPrefill is set.
    expect(forced?.["prefillToolCall"]).toEqual({});

    // The next call is not forced: no options at all, so the instance config (thinking ON, the
    // derived max_tokens budget) applies exactly as before this change.
    const unforced = options[1];
    expect(unforced, "the non-forced call must carry no per-call options").toBeUndefined();
  });

  it("with no plan yet, leaves the planning call its thinking and sends the ceiling alone", async () => {
    planState.recorded = false;
    const { AgentSession, runTurn } = await loadRuntime();
    burnThenAnswer();

    const session = new AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });
    await runTurn({ session, userMessage: "wie wird das wetter morgen?" });

    expect(routingCompleteMock, "routing classifier did not run").toHaveBeenCalled();
    const options = streamOptions();
    const forced = options[0];
    // Still forced, still capped — record_plan with steps + acceptance criteria fits inside 4,000.
    expect(forced?.["toolChoice"], "first call was not the forced call").toBe("required");
    expect(forced?.["maxTokens"]).toBe(4000);
    // But NOT silenced: this is the call that writes the plan, and thinking-off was justified by
    // "the plan was recorded one call earlier" — which is false for the call recording it.
    expect(forced?.["controls"], "the planning call was sent thinking-off").toBeUndefined();
    // The prefill is asked for here too. Where the flag sends it, the continuation starts after a
    // closed think block, so this call stops deliberating; a two-phase plan call is the follow-up.
    expect(forced?.["prefillToolCall"]).toEqual({});
  });
});
