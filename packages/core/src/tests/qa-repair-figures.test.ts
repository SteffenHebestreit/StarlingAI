import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A QA REPAIR DOES NOT SHIP A FIGURE NOTHING IN THE CONVERSATION HELD (E2E 2026-10-12).
 *
 * The browser run summed eight prices to 227,40 and the answer said so. The QA reviewer added them up
 * itself, got 227,30, and failed the answer for "a mathematical error"; the repair rewrote the total
 * to 227,30. A repair runs without tools, so a figure it introduces is its own arithmetic: such a
 * rewrite is refused, and the answer it was asked to repair ships. A rewrite whose figures all come
 * from the conversation is still accepted.
 */

const streamMock = vi.hoisted(() => vi.fn());
const completeMock = vi.hoisted(() => vi.fn());
const logAuditMock = vi.hoisted(() => vi.fn());

vi.mock("../providers/index.js", () => {
  const provider = {
    checkHealth: async () => ({ healthy: true }),
    verifyToolCallSupport: async () => true,
    complete: (...args: unknown[]) => completeMock(...args),
    stream: (...args: unknown[]) => streamMock(...args),
    embed: async () => [],
    isHealthy: () => true,
  };
  return {
    applyActiveModelPreset: (model: unknown) => model,
    getChatProvider: () => provider,
    getChatProviderWithOverride: () => provider,
    getChatProviderForTier: () => null,
    createChatProvider: () => provider,
    tierModelDefaults: (tier: string) => (tier === "routing" ? { enableThinking: false, reasoningEffort: "none" } : {}),
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
vi.mock("../audit/logger.js", () => ({ logAudit: logAuditMock }));

import { AgentSession, resetSessionsForTests } from "../agent/session.js";
import { runTurn } from "../agent/runtime.js";
import { persistTurnPlan } from "../agent/turn-plan.js";
import { getConfig, resetConfigForTests } from "../config/loader.js";
import { registerTool, unregisterTool } from "../tools/registry.js";

const DELEGATED = "[browser_agent]: Artikel unter 50 €: NW-1201 34,90 €, NW-1203 27,50 €, NW-2102 39,90 €, NW-3101 19,90 €, "
  + "NW-3102 8,90 €, NW-3103 22,40 €, NW-3105 49,00 €, NW-3106 24,90 €. Summe mit web_table berechnet: 227,40 €.";
const ANSWER = "Die acht Artikel unter 50 € kosten zusammen 227,40 € (NW-1201, NW-1203, NW-2102, NW-3101, NW-3102, NW-3103, NW-3105 und NW-3106). Die Preise stammen aus der Produkttabelle der drei Katalogseiten; Versandkosten sind nicht eingerechnet, und das Sonderangebot NW-3106 zählt mit seinem aktuellen Preis.";
const REVIEWER_FLAW = "FAIL: Die Summe der aufgeführten Preise beträgt 227,30 €, nicht 227,40 €.";

async function runRepairedTurn(rewrite: string) {
  getConfig().orchestration.qaDeliveryLoop = true;
  getConfig().orchestration.relaySingleDeliverable = false;
  const session = new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "You are a test agent." });
  let llmCalls = 0;
  streamMock.mockImplementation(() => {
    llmCalls += 1;
    return llmCalls === 1
      ? toolCallStream("delegate_1", "delegate_to_agent", { agentName: "browser_agent", task: "Sum the catalogue's articles under 50 EUR." })
      : textStream(ANSWER);
  });
  completeMock.mockImplementation(async (messages: Array<{ role: string; content: string }>) => ({
    content: messages[0]?.content.startsWith("You are a concise QA reviewer") ? REVIEWER_FLAW : rewrite,
    tool_calls: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    finishReason: "stop",
  }));
  registerTool({
    name: "delegate_to_agent",
    description: "Delegate to a specialist.",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      await persistTurnPlan(session.id, {
        objective: "Sum the catalogue",
        steps: [],
        acceptanceCriteria: ["Die Antwort nennt die korrekte Summe aller Artikel unter 50 €."],
        stopConditions: [],
        riskTier: "low",
        wide: false,
        createdAt: new Date().toISOString(),
      });
      return { success: true, output: DELEGATED, metadata: { agentName: "browser_agent", delegationSucceeded: true } };
    },
  });
  return runTurn({ session, userMessage: "Was kosten alle Artikel unter 50 € zusammen?" });
}

const refusals = () => logAuditMock.mock.calls
  .filter(([type, data]) => type === "guardrail_flagged" && (data as { type?: string }).type === "repair_rewrite_invented_figures");

describe("a QA repair and the figures it states", () => {
  afterEach(() => {
    resetConfigForTests();
    unregisterTool("delegate_to_agent");
    streamMock.mockReset();
    completeMock.mockReset();
    logAuditMock.mockClear();
    resetSessionsForTests();
  });

  it("is refused when it states a total nothing in the conversation held, and the computed one ships", async () => {
    const turn = await runRepairedTurn("Die acht Artikel unter 50 € kosten zusammen 227,30 € (NW-1201, NW-1203, NW-2102, NW-3101, NW-3102, NW-3103, NW-3105 und NW-3106). Die Preise stammen aus der Produkttabelle der drei Katalogseiten; Versandkosten sind nicht eingerechnet, und das Sonderangebot NW-3106 zählt mit seinem aktuellen Preis.");

    expect(turn.response).toContain("227,40");
    expect(turn.response).not.toContain("227,30");
    expect(refusals().length).toBeGreaterThan(0);
  });

  it("control: is accepted when its figures all come from the conversation", async () => {
    const reworded = "Zusammen kosten die acht Artikel unter 50 € genau 227,40 €: NW-1201, NW-1203, NW-2102, NW-3101, NW-3102, NW-3103, NW-3105 und NW-3106. Die Preise stammen aus der Produkttabelle der drei Katalogseiten; Versandkosten sind nicht eingerechnet, und das Sonderangebot NW-3106 zählt mit seinem aktuellen Preis.";
    const turn = await runRepairedTurn(reworded);

    expect(turn.response).toContain("Zusammen kosten die acht Artikel");
    expect(refusals()).toEqual([]);
  });
});

function toolCallStream(callId: string, toolName: string, args: Record<string, unknown>) {
  return (async function* () {
    yield { type: "tool_call_start", toolCallId: callId, toolName };
    yield { type: "tool_call_delta", toolCallId: callId, argumentsDelta: JSON.stringify(args) };
    yield { type: "done", finishReason: "tool_calls", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  })();
}

function textStream(text: string) {
  return (async function* () {
    yield { type: "text_delta", content: text };
    yield { type: "done", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  })();
}
