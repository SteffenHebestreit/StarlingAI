/**
 * The runtime hands the prompt assembly what the turn has called, so the plan-first nudge reaches
 * iteration 1 of a turn whose iteration 0 only searched (E2E new-plan-round-fold-site-facts,
 * session 9991d150), and does not reach it once the turn has delegated.
 *
 * Run under stableToolBlock "freeze": the head and the tool block must not move between the two
 * iterations, and record_plan, which the nudge asks for, must be on the wire both times.
 *
 * It also hands each response's routing tools ToolContext.planFirstPending, so search_agents does not
 * tell the model to delegate now while that nudge asks for a plan (tools/sub-agent.ts).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LLMMessage } from "../providers/lmstudio.js";

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
    complete: (...args: Parameters<typeof completeMock>) => completeMock(...args),
    stream: (...args: Parameters<typeof streamMock>) => streamMock(...args),
    embed: async () => [],
    isHealthy: () => true,
  };
  return {
    applyActiveModelPreset: (model: unknown) => model,
    getChatProvider: () => provider,
    getChatProviderWithOverride: () => provider,
    // No routing tier: nothing forces orchestration, so iteration 1 is an ordinary one.
    getChatProviderForTier: () => null,
    createChatProvider: () => provider,
    tierModelDefaults: () => ({}),
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

const tempDirs: string[] = [];
/** ToolContext.planFirstPending as each search_agents call of the turn saw it. */
const pointerFlags: Array<boolean | undefined> = [];

afterEach(() => {
  streamMock.mockReset();
  completeMock.mockClear();
  delete process.env["SAI_CONFIG_PATH"];
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  pointerFlags.length = 0;
});

async function loadRuntime() {
  const dir = mkdtempSync(join(tmpdir(), "sai-plan-nudge-runtime-"));
  tempDirs.push(dir);
  const configPath = join(dir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({
    agents: { mainAssistant: { toolMode: "orchestration_only" }, performance: { leanContextInjection: true } },
    orchestration: {
      stableToolBlock: "freeze",
      discoveryPrefetch: false,
      qaDeliveryLoop: false,
      riskGatedQA: false,
      finalResponseQaGate: false,
    },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configPath;
  vi.resetModules();
  // The plan tools register on import, as register-builtins does in the gateway.
  await import("../tools/turn-plan-tool.js");
  const { AgentSession, resetSessionsForTests } = await import("../agent/session.js");
  const { runTurn } = await import("../agent/runtime.js");
  const { registerTool } = await import("../tools/registry.js");
  const { foldedSystemText } = await import("../agent/turn-system-prompt.js");
  resetSessionsForTests();
  // No workflow fits, as in the diagnosed run: the search finds nothing strong.
  registerTool({
    name: "search_workflows",
    description: "search the workflow catalog",
    parameters: { type: "object", properties: { query: { type: "string" } } },
    execute: async () => ({ success: true, output: "No reusable workflow matches this request.", metadata: { workflowMatches: [] } }),
  });
  registerTool({
    name: "search_agents",
    description: "search the agent catalog",
    parameters: { type: "object", properties: { query: { type: "string" } } },
    execute: async (_args, ctx) => {
      pointerFlags.push(ctx.planFirstPending);
      return {
        success: true,
        output: "**browser_agent** high confidence",
        metadata: { resultCount: 1, topResult: "browser_agent", topResultConfidence: "high" },
      };
    },
  });
  registerTool({
    name: "delegate_to_agent",
    description: "delegate a task",
    parameters: { type: "object", properties: { agentName: { type: "string" }, task: { type: "string" } } },
    execute: async () => ({
      success: true,
      output: "browser_agent: the home page lists 146 employees.",
      metadata: { delegationOutcome: "success", agentName: "browser_agent" },
    }),
  });
  const session = new AgentSession({ channel: "test", workspacePath: dir, systemPrompt: "You are a test agent." });
  return { session, runTurn, foldedSystemText };
}

function toolCallStream(callId: string, toolName: string, args: Record<string, unknown>) {
  return (async function* () {
    yield { type: "tool_call_start", toolCallId: callId, toolName };
    yield { type: "tool_call_delta", toolCallId: callId, argumentsDelta: JSON.stringify(args) };
    yield { type: "done", finishReason: "tool_calls", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  })();
}

function toolCallsStream(calls: Array<[callId: string, toolName: string, args: Record<string, unknown>]>) {
  return (async function* () {
    for (const [callId, toolName, args] of calls) {
      yield { type: "tool_call_start", toolCallId: callId, toolName };
      yield { type: "tool_call_delta", toolCallId: callId, argumentsDelta: JSON.stringify(args) };
    }
    yield { type: "done", finishReason: "tool_calls", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  })();
}

function textStream(text: string) {
  return (async function* () {
    yield { type: "text_delta", content: text };
    yield { type: "done", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  })();
}

/** Shaped like the E2E message: 300+ characters and three questions, so the multi-domain nudge. */
const USER_MESSAGE =
  "For a short company note I need three details from the website of the Nordlicht tools company:\n"
  + "1. How many employees does the company have according to the home page?\n"
  + "2. What does express shipping cost there?\n"
  + "3. Which torque level is the NW-AS 18 cordless screwdriver set to at the factory, according to the documentation?\n"
  + "Plan the steps briefly, then work through the plan. Summarise the three details in at most four sentences.";

const messagesOfCall = (index: number): LLMMessage[] => (streamMock.mock.calls[index]?.[0] ?? []) as LLMMessage[];
const toolNamesOfCall = (index: number): string[] =>
  ((streamMock.mock.calls[index]?.[1] ?? []) as Array<{ name: string }>).map((tool) => tool.name);

function planNudge(messages: readonly LLMMessage[]): string | undefined {
  const found = messages.find((message) => message.role === "system"
    && typeof message.content === "string" && message.content.startsWith("PLAN FIRST"));
  return found?.content as string | undefined;
}

describe("the plan-first nudge across iterations of a real turn", () => {
  it("reaches iteration 1 when iteration 0 only searched, with the head and the tool block unchanged", async () => {
    const { session, runTurn, foldedSystemText } = await loadRuntime();
    streamMock
      .mockImplementationOnce(() => toolCallStream("w1", "search_workflows", { query: "visit a website and extract facts" }))
      .mockImplementation(() => textStream("146 employees."));

    await runTurn({ session, userMessage: USER_MESSAGE });

    expect(streamMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    const nudge = planNudge(messagesOfCall(0));
    expect(nudge, "iteration 0 carries the nudge").toBeDefined();
    expect(planNudge(messagesOfCall(1))).toBe(nudge);
    expect(foldedSystemText(messagesOfCall(1))).toBe(foldedSystemText(messagesOfCall(0)));
    expect(JSON.stringify(streamMock.mock.calls[1]?.[1])).toBe(JSON.stringify(streamMock.mock.calls[0]?.[1]));
    expect(toolNamesOfCall(1)).toContain("record_plan");
  });

  it("does not reach iteration 1 once iteration 0 delegated", async () => {
    const { session, runTurn } = await loadRuntime();
    streamMock
      .mockImplementationOnce(() => toolCallStream("d1", "delegate_to_agent", { agentName: "browser_agent", task: "Read the home page." }))
      .mockImplementation(() => textStream("146 employees."));

    await runTurn({ session, userMessage: USER_MESSAGE });

    expect(streamMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(planNudge(messagesOfCall(0))).toBeDefined();
    expect(planNudge(messagesOfCall(1))).toBeUndefined();
  });
});

/** Under 300 characters, so the single-domain nudge, which asks for no search first. */
const SINGLE_DOMAIN_MESSAGE =
  "Visit the shop's website: find the employee count on the home page, the express shipping price on the pricing page "
  + "and the torque setting in the documentation. Plan the steps briefly, then work through the plan.";

describe("the routing pointer's plan-first flag across a real turn", () => {
  it("is set for a response that only searches under the multi-domain nudge", async () => {
    const { session, runTurn } = await loadRuntime();
    streamMock
      .mockImplementationOnce(() => toolCallsStream([
        ["w1", "search_workflows", { query: "visit a website and extract facts" }],
        ["a1", "search_agents", { query: "browse a website and read pages" }],
      ]))
      .mockImplementation(() => textStream("146 employees."));

    await runTurn({ session, userMessage: USER_MESSAGE });

    expect(pointerFlags).toEqual([true]);
  });

  it("stays set on iteration 1 while the turn has still only searched", async () => {
    const { session, runTurn } = await loadRuntime();
    streamMock
      .mockImplementationOnce(() => toolCallStream("w1", "search_workflows", { query: "visit a website and extract facts" }))
      .mockImplementationOnce(() => toolCallStream("a1", "search_agents", { query: "browse a website and read pages" }))
      .mockImplementation(() => textStream("146 employees."));

    await runTurn({ session, userMessage: USER_MESSAGE });

    expect(pointerFlags).toEqual([true]);
  });

  it("is not set for the single-domain nudge", async () => {
    const { session, runTurn } = await loadRuntime();
    streamMock
      .mockImplementationOnce(() => toolCallStream("a1", "search_agents", { query: "browse a website and read pages" }))
      .mockImplementation(() => textStream("146 employees."));

    await runTurn({ session, userMessage: SINGLE_DOMAIN_MESSAGE });

    expect(pointerFlags).toEqual([false]);
  });

  it("is not set when the same response also acts", async () => {
    const { session, runTurn } = await loadRuntime();
    streamMock
      .mockImplementationOnce(() => toolCallsStream([
        ["a1", "search_agents", { query: "browse a website and read pages" }],
        ["p1", "record_plan", { objective: "Report three facts", steps: [{ id: "s1", description: "Write the note", kind: "direct" }] }],
      ]))
      .mockImplementation(() => textStream("146 employees."));

    await runTurn({ session, userMessage: USER_MESSAGE });

    expect(pointerFlags).toEqual([false]);
  });
});
