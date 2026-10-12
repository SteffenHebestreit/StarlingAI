import { describe, expect, it, vi } from "vitest";
import type { ToolContext, ToolResult } from "../tools/registry.js";

/**
 * THE COVERAGE CHECK DOES NOT HOLD A MERGED ANSWER TO A PLAN'S OVERLAPPING STEPS (E2E 2026-10-12).
 *
 * Two browser steps both summed the same catalogue, and the orchestrator's reply stated the total
 * once. The coverage check counted both steps' items against it, asked for every one of them, and,
 * when the rewrite still came out short, shipped the raw report — step headings, duplicates and all.
 * QA flagged the duplicates, and its rewrite lost the total. A report of two or more step results is
 * not one deliverable to cover; a single delegated result still is.
 */

const completeMock = vi.hoisted(() => vi.fn(async () => ({
  content: "REWRITE",
  tool_calls: [],
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  finishReason: "stop",
})));
const logAuditMock = vi.hoisted(() => vi.fn());

vi.mock("../providers/index.js", () => {
  const provider = {
    checkHealth: async () => ({ healthy: true }),
    verifyToolCallSupport: async () => true,
    complete: (...args: unknown[]) => completeMock(...(args as [])),
    stream: vi.fn(),
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
vi.mock("../audit/logger.js", () => ({ logAudit: logAuditMock }));

/** Each step's answer: the same eight articles, as both browser steps found them. */
const LISTING = [
  "- NW-1201 Bithalter: 34,90 €", "- NW-1203 Wasserwaage: 27,50 €", "- NW-2102 Zange: 39,90 €",
  "- NW-3101 Bit-Set: 19,90 €", "- NW-3102 Schraubendreher: 8,90 €", "- NW-3103 Maßband: 22,40 €",
  "- NW-3105 Cuttermesser: 49,00 €", "- NW-3106 Handschuhe: 24,90 €",
].join("\n");
const STEP_ANSWER = `Artikel unter 50 € im Katalog (drei Seiten):\n${LISTING}\nSumme: 227,40 €. `
  + "Die Preise stammen aus der Tabelle \"produkte\" auf seite-1.html bis seite-3.html; Versandkosten sind nicht "
  + "eingerechnet, und Sonderangebote sind mit ihrem aktuellen Preis gezählt.";

vi.mock("../tools/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools/registry.js")>();
  return {
    ...actual,
    executeTool: vi.fn(async (name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
      if (name === "execute_plan") return actual.executeTool(name, args, ctx);
      return {
        success: true,
        output: `[browser_agent]: ${STEP_ANSWER}`,
        metadata: { delegationOutcome: "success", delegationSucceeded: true, agentName: "browser_agent" },
      };
    }),
  };
});

const { getTool } = await import("../tools/registry.js");
await import("../tools/turn-plan-tool.js");
await import("../tools/plan-executor.js");
const { clearTurnPlanForSession } = await import("../agent/turn-plan.js");
const { buildModelVisibleToolResult } = await import("../agent/tool-result-format.js");
const { findRecentDelegateEvidence } = await import("../agent/interrupted-delegation-evidence.js");
const { AgentSession } = await import("../agent/session.js");
const { enforceDelegateCoverage } = await import("../agent/runtime.js");

const REPLY = "Die acht Artikel unter 50 € kosten zusammen 227,40 € (NW-1201, NW-1203, NW-2102, NW-3101, NW-3102, NW-3103, NW-3105 und NW-3106).";
const QUESTION = "Was kosten alle Artikel unter 50 € zusammen?";

/** A session whose turn ran a two-step plan (both steps answering the same listing), as the model saw it. */
async function sessionAfterTwoStepPlan() {
  const session = new AgentSession({ channel: "test", workspacePath: "/w", systemPrompt: "You are a test agent." });
  await clearTurnPlanForSession(session.id);
  const result = await getTool("record_plan")!.execute({
    objective: "Sum the catalogue's articles under 50 EUR",
    steps: [
      { id: "s1", description: "Read catalogue page 1 and sum its articles under 50 EUR", kind: "delegate", agent: "browser_agent" },
      { id: "s2", description: "Read the further catalogue pages and sum their articles", kind: "delegate", agent: "browser_agent" },
    ],
    acceptanceCriteria: ["states the total"],
  }, { sessionId: session.id, workspacePath: "/w", responseToolCalls: ["record_plan"] } as ToolContext);
  expect(result.metadata?.["planRoundFold"]).toBe(true);
  session.addMessage({ role: "user", content: QUESTION });
  session.addMessage({ role: "assistant", content: "", tool_calls: [{ id: "p1", type: "function", function: { name: "record_plan", arguments: "{}" } }] });
  session.addMessage({ role: "tool", tool_call_id: "p1", content: buildModelVisibleToolResult("record_plan", result.output, result.metadata), metadata: result.metadata });
  return session;
}

/** The same listing as ONE delegated result. */
function sessionAfterOneDelegation() {
  const session = new AgentSession({ channel: "test", workspacePath: "/w", systemPrompt: "You are a test agent." });
  const metadata = { agentName: "browser_agent", delegationOutcome: "success", delegationSucceeded: true, terminalState: "completed" };
  session.addMessage({ role: "user", content: QUESTION });
  session.addMessage({ role: "assistant", content: "", tool_calls: [{ id: "d1", type: "function", function: { name: "delegate_to_agent", arguments: "{}" } }] });
  session.addMessage({ role: "tool", tool_call_id: "d1", content: buildModelVisibleToolResult("delegate_to_agent", `[browser_agent]: ${STEP_ANSWER}`, metadata), metadata });
  return session;
}

const resyntheses = () => logAuditMock.mock.calls.filter(([type]) => type === "coverage_shortfall_resynthesis");

describe("the coverage check and a plan's report", () => {
  it("knows how many step results a plan's report carries", async () => {
    const plan = await sessionAfterTwoStepPlan();
    expect(findRecentDelegateEvidence(plan.getHistory(), { scopeToCurrentTurn: true })?.planStepResults).toBe(2);
    expect(findRecentDelegateEvidence(sessionAfterOneDelegation().getHistory(), { scopeToCurrentTurn: true })?.planStepResults).toBeUndefined();
  });

  it("leaves a merged answer to two overlapping steps as it is", async () => {
    logAuditMock.mockClear();
    const session = await sessionAfterTwoStepPlan();
    const answer = await enforceDelegateCoverage(REPLY, 1, session, {} as never, new AbortController().signal);
    expect(answer).toBe(REPLY);
    expect(resyntheses()).toEqual([]);
  });

  it("control: still holds the same answer to one delegated listing", async () => {
    logAuditMock.mockClear();
    await enforceDelegateCoverage(REPLY, 1, sessionAfterOneDelegation(), {} as never, new AbortController().signal);
    expect(resyntheses()).toHaveLength(1);
  });
});
