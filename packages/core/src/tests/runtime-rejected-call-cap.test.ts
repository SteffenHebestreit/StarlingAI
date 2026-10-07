import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A call its tool turned away before doing anything does not use up the per-turn allowance
 * (ToolResult.rejectedBeforeEffect, found by the E2E suite 2026-10-07).
 *
 * create_ephemeral_agent has a cap of one call a turn. It rejected a grant that mixed the shell and
 * code-sandbox families with "split the mission into focused agents instead", and the corrected
 * call that followed was turned away as over the limit: the turn answered from the model's own
 * arithmetic without running anything. The allowance comes back once per tool and turn, so a
 * model that keeps sending invalid calls still runs into the cap.
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

/** create_ephemeral_agent, stubbed: the n-th call gets the n-th scripted result. */
const factoryCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const factoryResults = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("../tools/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools/registry.js")>();
  return {
    ...actual,
    executeTool: vi.fn(async (name: string, args: Record<string, unknown>, ctx: never, meta?: never) => {
      if (name === "create_ephemeral_agent") {
        factoryCalls.push(args);
        return factoryResults[factoryCalls.length - 1] ?? { success: false, output: "", error: "unscripted call" };
      }
      return actual.executeTool(name, args, ctx, meta);
    }),
  };
});

const REJECTED = {
  success: false,
  output: "",
  error: "Ephemeral agents cannot mix multiple execution families (shell, code). Split the mission into focused agents instead.",
  rejectedBeforeEffect: true,
};
const RAN = { success: true, output: "Ephemeral agent result: PRIMES-COUNT 8392, PRIMES-SUM 1255204276" };

const MIXED = { agentName: "prime_calculator", systemPrompt: "You compute.", task: "count primes", tools: ["mcp__code_sandbox__run_js", "shell_exec"] };
const FOCUSED = { agentName: "prime_calculator", systemPrompt: "You compute.", task: "count primes", tools: ["mcp__code_sandbox__run_js"] };

function toolCallStream(id: string, args: Record<string, unknown>) {
  return (async function* () {
    yield { type: "tool_call_start", toolCallId: id, toolName: "create_ephemeral_agent" };
    yield { type: "tool_call_delta", toolCallId: id, argumentsDelta: JSON.stringify(args) };
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
  const dir = mkdtempSync(join(tmpdir(), "sai-rejected-cap-"));
  writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
    agents: { mainAssistant: { toolMode: "orchestration_only" } },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
  vi.resetModules();
  await import("../tools/ephemeral-agent-factory.js");
  const { AgentSession } = await import("../agent/session.js");
  const { runTurn } = await import("../agent/runtime.js");
  return { AgentSession, runTurn };
}

/** Every message the given provider.stream call was sent, as one text. */
const promptOf = (callIndex: number): string =>
  ((streamMock.mock.calls[callIndex]?.[0] ?? []) as Array<{ content?: unknown }>)
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");

describe("a call turned away before any effect does not use up the per-turn cap", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    streamMock.mockReset();
    completeMock.mockClear();
    factoryCalls.length = 0;
    factoryResults.length = 0;
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
  });

  it("runs the corrected create_ephemeral_agent after a rejected one", async () => {
    const { AgentSession, runTurn } = await loadRuntime();
    factoryResults.push(REJECTED, RAN);
    let call = 0;
    streamMock.mockImplementation(() => {
      call += 1;
      if (call === 1) return toolCallStream("call_mixed", MIXED);
      if (call === 2) return toolCallStream("call_focused", FOCUSED);
      return answerStream("There are 8392 primes; their sum is 1255204276.");
    });

    const session = new AgentSession({ channel: "test", workspacePath: mkdtempSync(join(tmpdir(), "sai-rejected-cap-ws-")), systemPrompt: "You are a test agent." });
    await runTurn({ session, userMessage: "Count the primes between 100000 and 200000 with a script and give their sum." });

    expect(factoryCalls).toHaveLength(2);
    expect(factoryCalls[1]?.["tools"]).toEqual(["mcp__code_sandbox__run_js"]);
    expect(promptOf(2)).toContain("PRIMES-SUM 1255204276");
  });

  // In a turn, two failed iterations in a row already end it before a third call, so the once-a-turn
  // bound is pinned on the helper the turn loop calls.
  it("gives the allowance back only once per tool and turn, and only for a call that did nothing", async () => {
    await loadRuntime();
    const { giveBackRejectedCall } = await import("../agent/delegation-response-collapse.js");
    const counts = new Map([["create_ephemeral_agent", 1], ["search_agents", 1], ["web_search", 1]]);
    const givenBack = new Set<string>();

    expect(giveBackRejectedCall(counts, givenBack, "create_ephemeral_agent", REJECTED)).toBe(true);
    expect(counts.get("create_ephemeral_agent")).toBe(0);
    // The next rejection of the same tool in this turn keeps its count.
    counts.set("create_ephemeral_agent", 1);
    expect(giveBackRejectedCall(counts, givenBack, "create_ephemeral_agent", REJECTED)).toBe(false);
    expect(counts.get("create_ephemeral_agent")).toBe(1);
    // A failure that may have acted, and a success, keep theirs.
    expect(giveBackRejectedCall(counts, givenBack, "search_agents", { success: false })).toBe(false);
    expect(giveBackRejectedCall(counts, givenBack, "search_agents", { success: true, rejectedBeforeEffect: true })).toBe(false);
    expect(counts.get("search_agents")).toBe(1);
    // A tool without a per-turn cap has nothing to give back.
    expect(giveBackRejectedCall(counts, givenBack, "web_search", REJECTED)).toBe(false);
    expect(counts.get("web_search")).toBe(1);
  });
});
