import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * THE PLAN ROUND FOLD, THROUGH A REAL TURN (orchestration.planRoundFold, finding 2026-10-05).
 *
 * plan-round-fold.test.ts pins the tool. This pins the seam the tool cannot see: the turn loop
 * has to tell record_plan what else its response asked for (ToolContext.responseToolCalls), and
 * has to account for what the folded run dispatched. Measured on what reached the provider: a
 * response that only records a plan is followed directly by the answering call, with the step's
 * result already in its prompt — no round spent issuing execute_plan.
 */

const streamMock = vi.hoisted(() => vi.fn());
const completeMock = vi.hoisted(() => vi.fn(async () => ({
  content: "synthesized",
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
vi.mock("../audit/logger.js", () => ({ logAudit: vi.fn() }));

/** The specialist the plan's step goes to — stubbed; everything else is the real registry. */
const delegated = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("../tools/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools/registry.js")>();
  return {
    ...actual,
    executeTool: vi.fn(async (name: string, args: Record<string, unknown>, ctx: never, meta?: never) => {
      if (name === "delegate_to_agent") {
        delegated.push(args);
        return {
          success: true,
          output: "Delegated result from researcher — TASK COMPLETED.\nObserved evidence:\nRECORDER-B-WINS (step evidence)",
          metadata: { agentName: "researcher", delegationSucceeded: true, delegationOutcome: "success", terminalState: "completed" },
        };
      }
      return actual.executeTool(name, args, ctx, meta);
    }),
  };
});

const PLAN_ARGS = {
  objective: "pick the better recorder",
  steps: [{ id: "s1", description: "compare recorder A and B", kind: "delegate", agent: "researcher" }],
  acceptanceCriteria: ["names a winner"],
};

function toolCallStream(calls: Array<{ id: string; name: string; args: Record<string, unknown> }>) {
  return (async function* () {
    for (const call of calls) {
      yield { type: "tool_call_start", toolCallId: call.id, toolName: call.name };
      yield { type: "tool_call_delta", toolCallId: call.id, argumentsDelta: JSON.stringify(call.args) };
    }
    yield { type: "done", finishReason: "tool_calls", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  })();
}

function answerStream(text: string) {
  return (async function* () {
    yield { type: "text_delta", content: text };
    yield { type: "done", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  })();
}

async function loadRuntime(orchestration: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sai-plan-fold-"));
  writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
    agents: { mainAssistant: { toolMode: "orchestration_only" } },
    orchestration,
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
  vi.resetModules();
  // The plan tools register on import, as register-builtins does in the gateway.
  await import("../tools/turn-plan-tool.js");
  const [{ AgentSession }, { runTurn }] = await Promise.all([
    import("../agent/session.js"),
    import("../agent/runtime.js"),
  ]);
  return { AgentSession, runTurn };
}

/** Every message the given provider.stream call was sent, as one text. */
const promptOf = (callIndex: number): string =>
  ((streamMock.mock.calls[callIndex]?.[0] ?? []) as Array<{ content?: unknown }>)
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");

describe("a turn whose response only records a plan does not spend a round issuing execute_plan", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    streamMock.mockReset();
    completeMock.mockClear();
    delegated.length = 0;
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
  });

  it("dispatches the plan inside record_plan, and the very next call answers from its result", async () => {
    const { AgentSession, runTurn } = await loadRuntime();
    let call = 0;
    streamMock.mockImplementation(() => {
      call += 1;
      return call === 1
        ? toolCallStream([{ id: "call_plan", name: "record_plan", args: PLAN_ARGS }])
        : answerStream("Recorder B wins.");
    });

    const session = new AgentSession({ channel: "test", workspacePath: mkdtempSync(join(tmpdir(), "sai-plan-fold-ws-")), systemPrompt: "You are a test agent." });
    const result = await runTurn({ session, userMessage: "which recorder should I buy, A or B?" });

    // The step ran from inside the planning call...
    expect(delegated).toHaveLength(1);
    // ...so the second model call is already the answer, with the step's evidence in its prompt.
    expect(promptOf(1)).toContain("RECORDER-B-WINS");
    expect(promptOf(1)).toContain("EXECUTED in this same call");
    expect(streamMock).toHaveBeenCalledTimes(2);
    // And the turn counted the folded delegation as its own.
    expect(result.qualityScorecard?.delegationCount).toBe(1);
    // The plan nudge says the same thing the tool does: record_plan alone, no execute_plan after it.
    expect(promptOf(0)).toContain("Make record_plan the ONLY call");
    expect(promptOf(0)).not.toMatch(/call execute_plan once/i);
  });

  it("keeps the two-round nudge and shape when orchestration.planRoundFold is off", async () => {
    const { AgentSession, runTurn } = await loadRuntime({ planRoundFold: false });
    let call = 0;
    streamMock.mockImplementation(() => {
      call += 1;
      return call === 1
        ? toolCallStream([{ id: "call_plan", name: "record_plan", args: PLAN_ARGS }])
        : answerStream("Recorder B wins.");
    });

    const session = new AgentSession({ channel: "test", workspacePath: mkdtempSync(join(tmpdir(), "sai-plan-fold-ws-")), systemPrompt: "You are a test agent." });
    await runTurn({ session, userMessage: "which recorder should I buy, A or B?" });

    expect(delegated).toHaveLength(0);
    expect(promptOf(0)).toMatch(/call execute_plan once/i);
    expect(promptOf(0)).not.toContain("Make record_plan the ONLY call");
  });

  it("does not fold when the same response also issued the first step by hand", async () => {
    const { AgentSession, runTurn } = await loadRuntime();
    let call = 0;
    streamMock.mockImplementation(() => {
      call += 1;
      return call === 1
        ? toolCallStream([
            { id: "call_plan", name: "record_plan", args: PLAN_ARGS },
            { id: "call_step", name: "delegate_to_agent", args: { agentName: "researcher", task: "compare recorder A and B" } },
          ])
        : answerStream("Recorder B wins.");
    });

    const session = new AgentSession({ channel: "test", workspacePath: mkdtempSync(join(tmpdir(), "sai-plan-fold-ws-")), systemPrompt: "You are a test agent." });
    await runTurn({ session, userMessage: "which recorder should I buy, A or B?" });

    // Only the model's own delegation ran: the plan was not executed a second time behind it.
    expect(delegated).toHaveLength(1);
    expect(delegated[0]?.["task"]).toBe("compare recorder A and B");
  });
});
