import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The default reply language reaches every call that can need it (2026-10-07).
 *
 * The system prompt's rule names no default language any more: named there it pulled English
 * questions into German. The per-turn line names it for a message with no language of its own, and
 * that line went out on the first call only, so a bare link that needed a delegation reached its
 * answer with the default nowhere in view. Later calls now repeat the line for such a message, and
 * only for such a message.
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

vi.mock("../tools/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools/registry.js")>();
  return {
    ...actual,
    executeTool: vi.fn(async (name: string, args: Record<string, unknown>, ctx: never, meta?: never) => {
      if (name === "delegate_to_agent") {
        return {
          success: true,
          output: "Delegated result from researcher — TASK COMPLETED.\nObserved evidence:\nThe article explains winter battery storage.",
          metadata: { agentName: "researcher", delegationSucceeded: true, delegationOutcome: "success", terminalState: "completed" },
        };
      }
      return actual.executeTool(name, args, ctx, meta);
    }),
  };
});

function delegateStream() {
  return (async function* () {
    yield { type: "tool_call_start", toolCallId: "call_delegate", toolName: "delegate_to_agent" };
    yield { type: "tool_call_delta", toolCallId: "call_delegate", argumentsDelta: JSON.stringify({ agentName: "researcher", task: "Summarize the linked article." }) };
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
  const dir = mkdtempSync(join(tmpdir(), "sai-reply-language-"));
  writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
    agents: { mainAssistant: { toolMode: "orchestration_only", defaultLanguage: "German" } },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
  vi.resetModules();
  // The gateway warms the detector at boot; without it every message reads as having no language.
  await (await import("../agent/text-language.js")).warmTextLanguageDetector();
  const { AgentSession } = await import("../agent/session.js");
  const { runTurn } = await import("../agent/runtime.js");
  return { AgentSession, runTurn };
}

/** Every message the given provider.stream call was sent, as one text. */
const promptOf = (callIndex: number): string =>
  ((streamMock.mock.calls[callIndex]?.[0] ?? []) as Array<{ content?: unknown }>)
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");

async function runDelegatingTurn(userMessage: string): Promise<void> {
  const { AgentSession, runTurn } = await loadRuntime();
  let call = 0;
  streamMock.mockImplementation(() => {
    call += 1;
    return call === 1 ? delegateStream() : answerStream("Die Akkus kühl und halb geladen lagern.");
  });
  const session = new AgentSession({ channel: "test", workspacePath: mkdtempSync(join(tmpdir(), "sai-reply-language-ws-")), systemPrompt: "You are a test agent." });
  await runTurn({ session, userMessage });
}

describe("the default reply language on later calls of a turn", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    streamMock.mockReset();
    completeMock.mockClear();
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
  });

  it("is repeated after a delegation when the message has no language of its own", async () => {
    await runDelegatingTurn("https://example.com/winter-battery-storage");
    expect(streamMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(promptOf(0)).toContain("(German if there is none)");
    expect(promptOf(1)).toContain("(German if there is none)");
  });

  it("is named on no call when the message has a language of its own", async () => {
    await runDelegatingTurn("Please summarize what this article says about storing power tool batteries over the winter.");
    expect(streamMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(promptOf(0)).not.toContain("if there is none)");
    expect(promptOf(1)).not.toContain("if there is none)");
  });
});
