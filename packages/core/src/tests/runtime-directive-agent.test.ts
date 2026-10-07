import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `--agent NAME` delegates the turn to that agent (RunTurnOptions.directiveAgent, found by the E2E
 * suite 2026-10-07).
 *
 * The flag only narrowed allowedAgents to the one agent, and the orchestrator answered such a turn
 * itself: code_analyst never ran on two diagnoses the suite pinned to it, and the agent evaluations
 * that pin an agent the same way were measuring the orchestrator. Until the turn has delegated, its
 * tool call is forced and a line names the agent.
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

/** The specialist, stubbed; everything else is the real registry. */
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
          output: "Delegated result from code_analyst — TASK COMPLETED.\nObserved evidence:\nTRUNCATION-IN-INVOICES-AND-RECEIPTS",
          metadata: { agentName: "code_analyst", delegationSucceeded: true, delegationOutcome: "success", terminalState: "completed" },
        };
      }
      return actual.executeTool(name, args, ctx, meta);
    }),
  };
});

function delegateStream() {
  return (async function* () {
    yield { type: "tool_call_start", toolCallId: "call_delegate", toolName: "delegate_to_agent" };
    yield { type: "tool_call_delta", toolCallId: "call_delegate", argumentsDelta: JSON.stringify({ agentName: "code_analyst", task: "Find the bug in invoices.py." }) };
    yield { type: "done", finishReason: "tool_calls", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  })();
}

function answerStream(text: string) {
  return (async function* () {
    yield { type: "text_delta", content: text };
    yield { type: "done", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  })();
}

async function loadRuntime() {
  const dir = mkdtempSync(join(tmpdir(), "sai-directive-"));
  writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
    agents: { mainAssistant: { toolMode: "orchestration_only" } },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
  vi.resetModules();
  const { AgentSession } = await import("../agent/session.js");
  const { runTurn } = await import("../agent/runtime.js");
  return { AgentSession, runTurn };
}

/** Every message the given provider.stream call was sent, as one text. */
const promptOf = (callIndex: number): string =>
  ((streamMock.mock.calls[callIndex]?.[0] ?? []) as Array<{ content?: unknown }>)
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");
/** The tool choice the given provider.stream call was made with. */
const toolChoiceOf = (callIndex: number): unknown =>
  (streamMock.mock.calls[callIndex]?.[3] as { toolChoice?: unknown } | undefined)?.toolChoice;

const MESSAGE = "Why does invoices.py undercharge by a cent? def total(subtotal, tax): return int(subtotal + tax)";
const DIRECTIVE_LINE = 'directed this request to the agent "code_analyst"';

describe("a turn the user directed to one agent", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    streamMock.mockReset();
    completeMock.mockClear();
    delegated.length = 0;
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
  });

  it("forces the delegation to that agent, then answers freely from its result", async () => {
    const { AgentSession, runTurn } = await loadRuntime();
    let call = 0;
    streamMock.mockImplementation(() => {
      call += 1;
      return call === 1 ? delegateStream() : answerStream("Both files truncate with int(); round instead.");
    });

    const session = new AgentSession({ channel: "test", workspacePath: mkdtempSync(join(tmpdir(), "sai-directive-ws-")), systemPrompt: "You are a test agent." });
    await runTurn({ session, userMessage: MESSAGE, allowedAgents: ["code_analyst"], directiveAgent: "code_analyst" });

    expect(toolChoiceOf(0)).toBe("required");
    expect(promptOf(0)).toContain(DIRECTIVE_LINE);
    expect(delegated).toHaveLength(1);
    // Delegated: the answer is the model's own again.
    expect(toolChoiceOf(1)).toBeUndefined();
    expect(promptOf(1)).not.toContain(DIRECTIVE_LINE);
  });

  it("dispatches the delegation itself when the model answers in prose anyway", async () => {
    // Live, the local model wrote 13,000 characters of prose under `tool_choice: required`, and the
    // turn shipped them (E2E, 2026-10-07).
    const { AgentSession, runTurn } = await loadRuntime();
    let call = 0;
    streamMock.mockImplementation(() => {
      call += 1;
      return call === 1
        ? answerStream("int() truncates; use round(). I answered this myself instead of delegating.")
        : answerStream("Both files truncate with int(); round instead.");
    });

    const session = new AgentSession({ channel: "test", workspacePath: mkdtempSync(join(tmpdir(), "sai-directive-ws-")), systemPrompt: "You are a test agent." });
    const result = await runTurn({ session, userMessage: MESSAGE, allowedAgents: ["code_analyst"], directiveAgent: "code_analyst" });

    expect(delegated).toHaveLength(1);
    expect(delegated[0]).toMatchObject({ agentName: "code_analyst", task: MESSAGE });
    expect(result.response).not.toContain("I answered this myself");
  });

  it("forces nothing when the agents are only narrowed (a scene's grant)", async () => {
    const { AgentSession, runTurn } = await loadRuntime();
    streamMock.mockImplementation(() => answerStream("int() truncates; use round()."));

    const session = new AgentSession({ channel: "test", workspacePath: mkdtempSync(join(tmpdir(), "sai-directive-ws-")), systemPrompt: "You are a test agent." });
    await runTurn({ session, userMessage: MESSAGE, allowedAgents: ["code_analyst"] });

    expect(toolChoiceOf(0)).toBeUndefined();
    expect(promptOf(0)).not.toContain(DIRECTIVE_LINE);
  });
});
