/**
 * Every scenario file under eval/e2e/scenarios must load: the contract (src/e2e/scenario.ts), unique
 * ids, compiling regexes, fixtures that exist, sound min/max pairs. CI validates scenarios with this;
 * locally, `pnpm e2e:validate` prints the same problems.
 *
 * Scenarios whose expectations read rows the runtime builds are also checked against rows built by
 * the runtime's own code, so a scenario cannot pass on the regression it is there to catch.
 */
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { loadScenarios } from "../e2e/loader.js";
import { resolveE2EPaths } from "../e2e/paths.js";
import { evaluateEventExpectations } from "../e2e/assertions.js";
import { buildIntentShadowRowData, type IntentShadowOutcome } from "../agent/intent-shadow.js";

describe("e2e scenario files", () => {
  const paths = resolveE2EPaths();

  it("all validate", () => {
    expect(existsSync(paths.scenariosDir), `${paths.scenariosDir} is missing`).toBe(true);
    const { scenarios, issues } = loadScenarios(paths.scenariosDir, paths.fixturesDir);
    expect(issues.map((issue) => `${issue.file}: ${issue.message}`)).toEqual([]);
    // At least the commented example, so a broken loader cannot pass by loading nothing.
    expect(scenarios.some((entry) => entry.template && entry.scenario.id === "example-site-and-mail")).toBe(true);
  });

  it("the intent-shadow scenario fails a broken readout that the row reports as a timeout, and tolerates a real one", () => {
    // After the readout failed (error, no_logprobs), the shadow still asks the pre-route question when
    // the turn had a capsule with agents; when that starves past the shadow's deadline, the row's
    // reason says "timeout" and only readoutFailure keeps the readout's own (agent/intent-shadow.ts).
    const { scenarios } = loadScenarios(paths.scenariosDir, paths.fixturesDir);
    const scenario = scenarios.find((entry) => entry.scenario.id === "new-intent-readout-shadow-row")?.scenario;
    const turn = scenario?.steps.find((step) => step.kind === "turn");
    expect(turn?.kind).toBe("turn");
    const expectation = turn?.kind === "turn" ? turn.expect : undefined;
    const outcome: IntentShadowOutcome = {
      fastLane: "not_offered",
      fastLaneReason: null,
      judge: { status: "not_run", verdict: null, decidedBy: null },
      capsule: { status: "ok", agents: ["researcher", "web_coder"], trimmed: false },
      subAgentRuns: [],
      workflowRuns: 0,
      moduleChars: null,
      triage: null,
      wallMs: 9_000,
      workflowPressure: [],
      workflowForced: false,
      moduleSplit: false,
    };
    const judge = (readings: Parameters<typeof buildIntentShadowRowData>[3]) => evaluateEventExpectations(expectation, [{
      type: "intent_readout_shadow",
      sessionId: "sess-1",
      data: buildIntentShadowRowData({ turnId: "e2e-6f1c2a0e-6b1d-4d2e-9a3f-2b8c4d5e6f70", userMessage: "Wofür benutzt man einen Drehmomentschlüssel?", priorTurnDigest: undefined }, outcome, "de", readings),
    }]);
    const starvedPreRoute = { ok: false as const, reason: "aborted" as const, ms: 14_960 };

    for (const failure of ["error", "no_logprobs"] as const) {
      expect(judge({ status: "failed", reason: "timeout", intent: { ok: false, reason: failure, ms: 40 }, preRoute: starvedPreRoute }), failure).not.toEqual([]);
    }
    // The readout itself ran into the deadline: the environment's, as the scenario allows.
    expect(judge({ status: "failed", reason: "timeout", intent: { ok: false, reason: "aborted", ms: 15_001 }, preRoute: null })).toEqual([]);
    // A row without a readout failure carries null there, as every row of a readout that answered
    // does: the second mustNot must not match it, or the scenario fails on every healthy run.
    expect(judge({ status: "skipped", reason: "busy", intent: null, preRoute: null })).toEqual([]);
    expect(judge({ status: "failed", reason: "error", intent: { ok: false, reason: "error", ms: 40 }, preRoute: null })).not.toEqual([]);
    expect(judge({ status: "failed", reason: "no_provider", intent: null, preRoute: null })).not.toEqual([]);
  });

  it("the cart assessment fails any file write in its turn, and names a write to cart.js apart", () => {
    // Ground truth: a "why" question, so a diagnosis and no file change. A failed run wrote a
    // report, cart_bug_analyse.md; the scenario caught it only because its /cart/ path match
    // also matched the report's name, and the same report under another name passed.
    const { scenarios } = loadScenarios(paths.scenariosDir, paths.fixturesDir);
    const scenario = scenarios.find((entry) => entry.scenario.id === "core-build-code-assessment-no-edit")?.scenario;
    const turn = scenario?.steps.find((step) => step.kind === "turn");
    expect(turn?.kind).toBe("turn");
    const expectation = turn?.kind === "turn" ? turn.expect : undefined;
    const sessionId = "sub:4d048a29:code_analyst:1791500810464";
    const ran = { type: "sub_agent_started", sessionId, data: { agentName: "code_analyst" } };
    // The row sub-agent.ts logs when it dispatches a call (buildSubAgentToolAuditPayload, phase start).
    const call = (tool: string, path: string) => ({
      type: "sub_agent_tool_call",
      sessionId,
      data: { agentName: "code_analyst", tool, phase: "start", toolCallId: `call-${tool}-${path}`, args: { path } },
    });
    const failures = (...events: Array<ReturnType<typeof call> | typeof ran>) => evaluateEventExpectations(expectation, [ran, ...events]);
    const namesCartSource = (list: string[]) => list.some((failure) => failure.startsWith("events.mustNot"));

    expect(failures()).toEqual([]);
    // The same report under a name that has nothing to do with the cart is still a file change.
    expect(failures(call("write_file", "generated/analyse.md"))).not.toEqual([]);
    // The report the run wrote: a file change, and not an edit of cart.js.
    const report = failures(call("write_file", "cart_bug_analyse.md"), call("edit_file", "generated/cart_bug_analyse.md"));
    expect(report).not.toEqual([]);
    expect(namesCartSource(report)).toBe(false);
    // The unasked fix, wherever the source sits.
    for (const path of ["cart.js", "generated/cart.js"]) {
      expect(namesCartSource(failures(call("edit_file", path))), path).toBe(true);
    }
  });
});
