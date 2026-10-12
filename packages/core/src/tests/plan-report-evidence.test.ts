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
      if (failTaskContaining && String(args["task"]).includes(failTaskContaining)) {
        return { success: false, output: "", error: "browser_agent: the page could not be reached.", metadata: { delegationSucceeded: false, agentName } };
      }
      return {
        success: true,
        output: formatDelegatedOutput(agentName, String(args["task"]).includes("prices") ? PRICES : (stepAnswer ?? STAFF), { confidence: "high", matchedTerms: [] }),
        metadata: { delegationOutcome: "success", delegationSucceeded: true, agentName },
      };
    }),
  };
});

/** A step whose task contains this fails; and what the other steps answer, when set. */
let failTaskContaining: string | null = null;
let stepAnswer: string | null = null;

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
const { runWithRequestContext } = await import("../runtime/request-context.js");

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
async function historyAfterFoldedPlan(plan: Record<string, unknown> = PLAN) {
  await clearTurnPlanForSession(SESSION);
  const result = await getTool("record_plan")!.execute(plan, { sessionId: SESSION, workspacePath: "/w", responseToolCalls: ["record_plan"] } as ToolContext);
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
    // Two results: each under its step's description.
    expect(evidence).toContain(`**Open index.html and read the staff count**\n${STAFF}`);
    expect(evidence).toContain(`**Open preise.html and read the prices**\n${PRICES}`);
    // Every step ran: nothing to disclose.
    expect(evidence).not.toMatch(/Not completed|nicht abgeschlossen|left out|weggelassen/);
  });

  // A plan that half ran must not read as finished. The report said which steps failed or did not
  // run, but in sections addressed to the orchestrator, which do not ship.
  it("names the steps that failed or did not run under the results", async () => {
    failTaskContaining = "Konkurrenz-Preisliste";
    stepAnswer = `${STAFF} ${PRICES}`;
    try {
      const { history } = await historyAfterFoldedPlan({
        objective: "Staff count, and the position against the competitor",
        steps: [
          { id: "s1", description: "Open index.html and read the staff count", kind: "delegate", agent: "browser_agent" },
          { id: "s2", description: "Fetch the competitor list (Konkurrenz-Preisliste)", kind: "delegate", agent: "browser_agent" },
          { id: "s3", description: "Rank the company against the competitor", kind: "delegate", agent: "browser_agent", dependsOn: ["s2"] },
        ],
        acceptanceCriteria: ["states the staff count"],
      });

      const evidence = runWithRequestContext({ userMessageLanguage: "English" }, () => findRecentDelegateEvidence(history, { scopeToCurrentTurn: true })?.evidence ?? "");

      expect(evidence.startsWith(stepAnswer)).toBe(true);
      expect(evidence).toContain("Not completed in this run: Fetch the competitor list (Konkurrenz-Preisliste) (failed); Rank the company against the competitor (did not run).");
      expect(evidence).not.toContain("execute_plan");
    } finally {
      failTaskContaining = null;
      stepAnswer = null;
    }
  });

  // The review's probe: s1 done, s2 failed, s3 not run, two results omitted for length. The results
  // alone read "Spec A is 5W." and a source, a partial plan shipped as complete.
  it("says what the shown results leave out, in the language the person wrote in", () => {
    const report = [
      "Plan: 3/5 step(s) completed.",
      "FAILED — retry with execute_plan({retry:[\"<id>\"]}), reroute, or tell the user:\n  - s2 (delegate) Measure spec B — researcher: no source reachable",
      "NOT RUN — waiting further back in the chain:\n  - s3 (delegate) Compare A and B",
      "COMPLETED:\n  - s1 (delegate) Read spec A",
      `RESULTS — write the final answer from these:\n\n[s1] Read spec A\n${formatDelegatedOutput("researcher", "Spec A is 5W.\n\n[1]: https://example.com/spec")}\n\n(2 further result(s) omitted for length.)`,
      "Do NOT write the final answer while steps above are outstanding.",
    ].join("\n\n");
    const facts = {
      reportedResultIds: ["s1"],
      outstandingSteps: [
        { id: "s2", status: "failed", description: "Measure spec B" },
        { id: "s3", status: "pending", description: "Compare A and B" },
      ],
    };

    expect(runWithRequestContext({ userMessageLanguage: "English" }, () => planReportResultsForDisplay(report, facts))).toBe(
      "Spec A is 5W.\n\n[1]: https://example.com/spec\n\n"
        + "Not completed in this run: Measure spec B (failed); Compare A and B (did not run). Further step results were left out for length (2).",
    );
    expect(runWithRequestContext({ userMessageLanguage: "German" }, () => planReportResultsForDisplay(report, facts))).toBe(
      "Spec A is 5W.\n\n[1]: https://example.com/spec\n\n"
        + "In diesem Lauf nicht abgeschlossen: Measure spec B (fehlgeschlagen); Compare A and B (nicht ausgeführt). "
        + "Weitere Schrittergebnisse wurden aus Platzgründen weggelassen (2).",
    );
    // A report whose metadata does not name its steps still says that something is missing.
    expect(runWithRequestContext({ userMessageLanguage: "English" }, () => planReportResultsForDisplay(report))).toMatch(
      /Not every step of the plan was completed in this run\. Further step results were left out for length \(2\)\.$/,
    );
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
    expect(planReportResultsForDisplay(report, { reportedResultIds: ["s1"] })).toBe(STAFF);
    expect(planReportResultsForDisplay("Plan: 0/1 step(s) completed.\n\nFAILED — retry with execute_plan({retry:[\"<id>\"]}), reroute, or tell the user:\n  - s1 (delegate) x")).toBeNull();
  });
});
