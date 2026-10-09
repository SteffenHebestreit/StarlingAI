/**
 * The QA verdicts run thinking-off, are labelled in the provider rows, count in turn_performance,
 * and an empty verdict is recorded as no verdict.
 *
 * Session f4ebf47b turn 4: two delivery-loop verdicts on the thinking-on orchestrator cost 30.1 s
 * and 47.4 s (1,646 and 2,682 completion tokens) — 77 s of a 145 s turn — and every one of the
 * loop's calls was logged as agentName main, callSite main_turn, while turn_performance.llmTimeMs
 * said 19 s. The owner measured the 35B serially on the same classification (2026-09-25): 1.4–5×
 * faster with reasoning off, and with it on it sometimes returned nothing at all.
 *
 * The provider is a spy: what a real provider's provider_model_call row reads for its
 * agentName/callSite is currentCallAttribution() at call time (lmstudio.ts / anthropic.ts), so
 * the spy records exactly that.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

type Msg = { role: string; content: string };
type CallRecord = { kind: string; options: unknown; attribution: Record<string, unknown> };

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
import { tryReceptionistFastLaneDetailed } from "../agent/receptionist.js";
import { persistTurnPlan } from "../agent/turn-plan.js";
import { getConfig, resetConfigForTests } from "../config/loader.js";
import { currentCallAttribution, runWithRequestContext } from "../runtime/request-context.js";
import { registerTool, unregisterTool } from "../tools/registry.js";

const THINKING_OFF = { enableThinking: false, reasoningEffort: "none" };
const CRITERION = "Recommends one offer and says why";
// Long enough for both gates (the QA loop wants >200 chars, the consistency gate >=600).
// No file is claimed: the false-completion guard would otherwise replace it before either gate.
const ANSWER = ("Das zweite Angebot ist die beste Wahl: Es kostet 12.000 € bei zehn Wochen Laufzeit und bietet den "
  + "größten Leistungsumfang. Das erste ist günstiger, deckt aber keine Wartung ab; das dritte kostet mehr bei "
  + "gleicher Laufzeit. ").repeat(4);

function kindOf(messages: Msg[]): string {
  const system = messages[0]?.content ?? "";
  const last = messages[messages.length - 1]?.content ?? "";
  if (system.startsWith("You are a concise QA reviewer")) return "qa_verdict";
  if (system.startsWith("You are a precise consistency auditor")) return "consistency_verdict";
  if (last.includes("QA REVIEW found")) return "qa_improve";
  if (last.startsWith("[SYSTEM INSTRUCTION — RESPOND NOW]")) return "synthesis";
  return "other";
}

/** Install the provider spy: `replies` maps a call kind to the reply for its n-th call. */
function spyProvider(replies: Record<string, string[]>): CallRecord[] {
  const calls: CallRecord[] = [];
  const seen: Record<string, number> = {};
  completeMock.mockImplementation(async (messages: Msg[], _tools: unknown, _signal: unknown, options: unknown) => {
    const kind = kindOf(messages);
    calls.push({ kind, options, attribution: { ...currentCallAttribution().data } });
    const n = seen[kind] ?? 0;
    seen[kind] = n + 1;
    const list = replies[kind] ?? [];
    const content = list[Math.min(n, list.length - 1)] ?? ANSWER;
    return { content, tool_calls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop" };
  });
  return calls;
}

function auditRows(type: string): Array<Record<string, unknown>> {
  return logAuditMock.mock.calls.filter(([t]) => t === type).map(([, data]) => data as Record<string, unknown>);
}

async function runDeliverableTurn(opts: { plan: boolean; riskTier?: "low" | "high" }): Promise<void> {
  getConfig().orchestration.relaySingleDeliverable = false;
  const session = new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "You are a test agent." });
  let llmCalls = 0;
  streamMock.mockImplementation(() => {
    llmCalls += 1;
    return llmCalls === 1
      ? toolCallStream("delegate_1", "delegate_to_agent", { agentName: "researcher", task: "Compare the three offers." })
      : textStream(ANSWER);
  });
  registerTool({
    name: "delegate_to_agent",
    description: "Delegate to a specialist.",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      if (opts.plan) {
        await persistTurnPlan(session.id, {
          objective: "Compare the offers",
          steps: [],
          acceptanceCriteria: [CRITERION],
          stopConditions: [],
          riskTier: opts.riskTier ?? "low",
          wide: false,
          createdAt: new Date().toISOString(),
        });
      }
      return {
        success: true,
        output: "[researcher]: Angebot 1: 9.000 €, ohne Wartung. Angebot 2: 12.000 €, zehn Wochen. Angebot 3: 15.000 €, zehn Wochen.",
        metadata: { agentName: "researcher", delegationSucceeded: true },
      };
    },
  });
  await runTurn({ session, userMessage: "Welches der drei Angebote ist das beste?" });
}

afterEach(() => {
  resetConfigForTests();
  unregisterTool("delegate_to_agent");
  streamMock.mockReset();
  completeMock.mockReset();
  logAuditMock.mockReset();
  resetSessionsForTests();
});

describe("the QA delivery loop's verdict", () => {
  it("runs thinking-off by default, labelled qa / qa_verdict, and its rewrite is labelled synthesis / qa_improve", async () => {
    getConfig().orchestration.qaDeliveryLoop = true;
    const calls = spyProvider({ qa_verdict: ["FAIL: the answer does not say why", "PASS — evidence: it recommends offer 2 for its scope"] });
    await runDeliverableTurn({ plan: true });

    const verdicts = calls.filter((c) => c.kind === "qa_verdict");
    expect(verdicts).toHaveLength(2);
    for (const verdict of verdicts) {
      expect((verdict.options as { controls?: unknown } | undefined)?.controls).toEqual(THINKING_OFF);
      expect(verdict.attribution).toEqual({ agentName: "qa_verdict", callSite: "qa" });
    }
    const improve = calls.filter((c) => c.kind === "qa_improve");
    expect(improve).toHaveLength(1);
    expect(improve[0]!.attribution).toEqual({ agentName: "qa_improve", callSite: "synthesis" });

    // turn_performance: the three QA calls are counted beside llmTimeMs, not in it.
    const [perf] = auditRows("turn_performance");
    expect(perf!["qaLlmCalls"]).toBe(3);
    expect(typeof perf!["qaLlmTimeMs"]).toBe("number");
    expect((perf!["phaseTimingsMs"] as Record<string, number>)["qaDeliveryLoop"]).toBeGreaterThanOrEqual(0);
    expect(perf!["llmCalls"]).toBe(2); // the orchestrator loop's own two stream calls, unchanged
  });

  it("keeps the provider's own controls when orchestration.qaVerdictReasoning is on", async () => {
    getConfig().orchestration.qaDeliveryLoop = true;
    getConfig().orchestration.qaVerdictReasoning = true;
    const calls = spyProvider({ qa_verdict: ["PASS — evidence: it recommends offer 2 for its scope"] });
    await runDeliverableTurn({ plan: true });

    const verdicts = calls.filter((c) => c.kind === "qa_verdict");
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.options).toBeUndefined();
  });

  it("records an empty verdict as no verdict — passed:false, status unverified — and asks for no rewrite", async () => {
    getConfig().orchestration.qaDeliveryLoop = true;
    const calls = spyProvider({ qa_verdict: [""] });
    await runDeliverableTurn({ plan: true });

    expect(calls.filter((c) => c.kind === "qa_improve")).toHaveLength(0);
    const rows = auditRows("flow_verification_passed").filter((row) => row["reason"] === "qa_delivery_loop");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ passed: false, status: "unverified", noVerdict: true });
    const [scorecard] = auditRows("turn_scorecard");
    expect(scorecard!["qaStatus"]).toBe("unverified");
  });
});

describe("the deliverable-consistency verdict", () => {
  it("runs thinking-off, labelled qa / consistency_verdict; its repair is synthesis / consistency_repair; timed as a stage", async () => {
    getConfig().orchestration.deliverableConsistencyQa = true;
    const calls = spyProvider({ consistency_verdict: ["FAIL: the recommendation contradicts the stated budget"] });
    await runDeliverableTurn({ plan: false });

    const verdicts = calls.filter((c) => c.kind === "consistency_verdict");
    expect(verdicts).toHaveLength(1);
    expect((verdicts[0]!.options as { controls?: unknown } | undefined)?.controls).toEqual(THINKING_OFF);
    expect(verdicts[0]!.attribution).toEqual({ agentName: "consistency_verdict", callSite: "qa" });
    const repairs = calls.filter((c) => c.kind === "synthesis" && c.attribution["agentName"] === "consistency_repair");
    expect(repairs).toHaveLength(1);
    expect(repairs[0]!.attribution).toEqual({ agentName: "consistency_repair", callSite: "synthesis" });

    const [perf] = auditRows("turn_performance");
    expect(perf!["qaLlmCalls"]).toBe(2);
    expect((perf!["phaseTimingsMs"] as Record<string, number>)["deliverableConsistencyQa"]).toBeGreaterThanOrEqual(0);
  });

  it("keeps the provider's own controls when orchestration.qaVerdictReasoning is on", async () => {
    getConfig().orchestration.deliverableConsistencyQa = true;
    getConfig().orchestration.qaVerdictReasoning = true;
    const calls = spyProvider({ consistency_verdict: ["PASS"] });
    await runDeliverableTurn({ plan: false });

    const verdicts = calls.filter((c) => c.kind === "consistency_verdict");
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.options).toBeUndefined();
  });

  it("logs a genuine bare PASS as status pass: this gate's contract asks for nothing more", async () => {
    // The shared parser reads a bare PASS as unverified for want of evidence, so every genuine pass
    // was logged status "unverified" (review of the thinking-off verdicts, D1).
    getConfig().orchestration.deliverableConsistencyQa = true;
    spyProvider({ consistency_verdict: ["PASS"] });
    await runDeliverableTurn({ plan: false });

    const rows = auditRows("deliverable_consistency_passed");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ passed: true, status: "pass", repaired: false });
  });

  it("logs a FAIL whose repair came back empty as deliverable_consistency_failed, not passed", async () => {
    // It logged deliverable_consistency_passed with passed:false in its own row (review of the
    // thinking-off verdicts, D3c).
    getConfig().orchestration.deliverableConsistencyQa = true;
    spyProvider({ consistency_verdict: ["FAIL: the recommendation contradicts the stated budget"], synthesis: [""] });
    await runDeliverableTurn({ plan: false });

    expect(auditRows("deliverable_consistency_passed")).toHaveLength(0);
    const rows = auditRows("deliverable_consistency_failed");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ passed: false, status: "fail", repaired: false });
  });

  it("records an empty verdict as deliverable_consistency_unverified, never as passed", async () => {
    getConfig().orchestration.deliverableConsistencyQa = true;
    spyProvider({ consistency_verdict: [""] });
    await runDeliverableTurn({ plan: false });

    expect(auditRows("deliverable_consistency_passed")).toHaveLength(0);
    const rows = auditRows("deliverable_consistency_unverified");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ passed: false, status: "unverified", noVerdict: true, repaired: false });
  });
});

describe("the receptionist micro-call", () => {
  it("is labelled routing_tier / receptionist inside the turn's main_turn context", async () => {
    const config = getConfig();
    config.receptionist = { ...config.receptionist, enabled: true };
    // The mocked tier resolver returns null (as under a model preset); the fallback builds the provider.
    config.orchestration.routingTierPresetFallback = true;
    const attributions: Array<Record<string, unknown>> = [];
    completeMock.mockImplementation(async () => {
      attributions.push({ ...currentCallAttribution().data });
      return { content: "Hallo! Wie kann ich helfen?", tool_calls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop" };
    });
    const outcome = await runWithRequestContext({ agentName: "main", callSite: "main_turn" }, () => tryReceptionistFastLaneDetailed("hi"));

    expect(outcome.handled).toBe(true);
    expect(attributions).toEqual([{ agentName: "receptionist", callSite: "routing_tier" }]);
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

describe("the one-shot risk-gated verify (QA loop off)", () => {
  it("logs an empty verify reply as unverified, never as a pass", async () => {
    // With nothing back it logged flow_verification_passed{reason:"verify_produced_no_better_candidate"},
    // a pass nobody gave (review of the thinking-off verdicts, D3b).
    getConfig().orchestration.qaDeliveryLoop = false;
    getConfig().orchestration.riskGatedQA = true;
    spyProvider({ synthesis: [""] });
    await runDeliverableTurn({ plan: true, riskTier: "high" });

    expect(auditRows("flow_verification_passed")).toHaveLength(0);
    expect(auditRows("flow_high_stakes_unverified")).toEqual([expect.objectContaining({ reason: "verify_returned_nothing" })]);
  });
});
