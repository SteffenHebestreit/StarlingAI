import { describe, expect, it, vi } from "vitest";
import type { ToolContext, ToolResult } from "../tools/registry.js";
import { formatDelegatedOutput } from "../agent/runtime-evidence-dump.js";

/**
 * The evidence the runtime's backstops may ship as the reply (findRecentDelegateEvidence) carries a
 * plan's step results, not its report. In the E2E run new-plan-round-fold-site-facts the coverage
 * backstop (hallucinated_truncation_bypass) shipped a folded record_plan result verbatim: "Plan
 * recorded … and EXECUTED in this same call — every step has run, so do NOT call execute_plan
 * again …", the RESULTS heading, and the "[browser_agent]:" labels of its steps.
 *
 * The real record_plan and executor run here; only the delegations they dispatch are stubbed.
 */
vi.mock("../tools/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools/registry.js")>();
  return {
    ...actual,
    executeTool: vi.fn(async (name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
      if (name === "execute_plan") return actual.executeTool(name, args, ctx);
      const agentName = String(args["agentName"] ?? "browser_agent");
      return {
        success: true,
        output: formatDelegatedOutput(agentName, String(args["task"]).includes("prices") ? PRICES : STAFF, { confidence: "high", matchedTerms: [] }),
        metadata: { delegationOutcome: "success", delegationSucceeded: true, agentName },
      };
    }),
  };
});

const STAFF = "index.html states: Mitarbeiterinnen und Mitarbeiter: 146. The company was founded in 1987 and runs warehouses in Nordhafen, Südtal and Westmark; "
  + "the page lists the head office address and a contact form, and names no other staff figure anywhere on the site.";
const PRICES = "preise.html lists 18 articles in six categories, from 4,90 € (Schraubendreher-Bits) to 189,00 € (Akku-Bohrschrauber), "
  + "with free shipping from 50 € and a 30-day return window stated in the footer of the page.";

const { getTool } = await import("../tools/registry.js");
await import("../tools/turn-plan-tool.js");
await import("../tools/plan-executor.js");
const { clearTurnPlanForSession } = await import("../agent/turn-plan.js");
const { buildModelVisibleToolResult } = await import("../agent/tool-result-format.js");
const { findRecentDelegateEvidence } = await import("../agent/interrupted-delegation-evidence.js");
const { planReportResultsForDisplay } = await import("../agent/runtime-evidence-dump.js");

const SESSION = "plan-report-evidence";

const PLAN = {
  objective: "Report the staff count and the price range from the site",
  steps: [
    { id: "s1", description: "Open index.html and read the staff count", kind: "delegate", agent: "browser_agent", parallelGroup: 1 },
    { id: "s2", description: "Open preise.html and read the prices", kind: "delegate", agent: "browser_agent", parallelGroup: 1 },
    { id: "s3", description: "Write the answer", kind: "direct", dependsOn: ["s1", "s2"] },
  ],
  acceptanceCriteria: ["states the staff count"],
};

/** A turn's history after a record_plan that folded the plan round, its result as the model saw it. */
async function historyAfterFoldedPlan() {
  await clearTurnPlanForSession(SESSION);
  const result = await getTool("record_plan")!.execute(PLAN, { sessionId: SESSION, workspacePath: "/w", responseToolCalls: ["record_plan"] } as ToolContext);
  expect(result.metadata?.["planRoundFold"]).toBe(true);
  return {
    result,
    history: [
      { role: "user", content: "Wie viele Mitarbeiter hat die Firma, und was kosten die Artikel?" },
      { role: "assistant", content: "", tool_calls: [{ id: "p1", type: "function", function: { name: "record_plan", arguments: "{}" } }] },
      { role: "tool", content: buildModelVisibleToolResult("record_plan", result.output, result.metadata), tool_call_id: "p1", metadata: result.metadata },
    ],
  };
}

describe("a plan report as backstop evidence", () => {
  it("is its steps' results, without the report's instructions or the relay labels", async () => {
    const { result, history } = await historyAfterFoldedPlan();
    // The report the orchestrator reads keeps all of it.
    expect(result.output).toContain("do NOT call execute_plan again");
    expect(result.output).toContain("[browser_agent]:");

    const evidence = findRecentDelegateEvidence(history, { scopeToCurrentTurn: true })?.evidence ?? "";

    expect(evidence).toContain(STAFF);
    expect(evidence).toContain(PRICES);
    for (const scaffold of ["Plan recorded", "execute_plan", "Plan: 3/3", "COMPLETED:", "RESULTS —", "FINAL STEP", "Every step has run", "[browser_agent]", "Auto-routed", "[s1]", "[s2]"]) {
      expect(evidence).not.toContain(scaffold);
    }
  });

  it("a delegated result as backstop evidence loses its routing note as well as its label", () => {
    const answer = `${STAFF}\n\n${PRICES}`;
    const evidence = findRecentDelegateEvidence([
      { role: "user", content: "Wie viele Mitarbeiter hat die Firma?" },
      {
        role: "tool",
        content: formatDelegatedOutput("browser_agent", answer, { confidence: "high", matchedTerms: [] }),
        metadata: { delegationOutcome: "success", delegationSucceeded: true, agentName: "browser_agent" },
      },
    ], { scopeToCurrentTurn: true })?.evidence;

    expect(evidence).toBe(answer);
  });

  it("keeps a step's header when the report does not name its steps, and has nothing without results", () => {
    const report = "Plan: 1/1 step(s) completed.\n\nCOMPLETED:\n  - s1 (delegate) Read the staff count\n\n"
      + `RESULTS — write the final answer from these:\n\n[s1] Read the staff count\n${formatDelegatedOutput("browser_agent", STAFF)}\n\n`
      + "Every step has run. Synthesize the final answer from the results above, against the acceptance criteria.";
    expect(planReportResultsForDisplay(report)).toBe(`[s1] Read the staff count\n${STAFF}`);
    expect(planReportResultsForDisplay(report, ["s1"])).toBe(STAFF);
    expect(planReportResultsForDisplay("Plan: 0/1 step(s) completed.\n\nFAILED — retry with execute_plan({retry:[\"<id>\"]}), reroute, or tell the user:\n  - s1 (delegate) x")).toBeNull();
  });
});
