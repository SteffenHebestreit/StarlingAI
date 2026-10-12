import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildModelVisibleToolResult,
  stripWorkflowPreamble,
  truncatePlainText,
  workflowRunResultMaxChars,
} from "../agent/tool-result-format.js";
import { budgetCutLine, stripBudgetCutLines, stripPresentationFormatting } from "../agent/runtime-utils.js";
import { findRecentDelegateEvidence } from "../agent/interrupted-delegation-evidence.js";
import { AgentSession } from "../agent/session.js";
import { getConfig } from "../config/loader.js";
import { runWithEffortContext } from "../runtime/effort-context.js";

/**
 * A WORKFLOW RUN'S ANSWER IS THE EVIDENCE THE TURN ANSWERS FROM (E2E core-ix-workflow-job-sourced-report).
 *
 * The job ran all five of its step agents, and its answer held the four error codes the user asked
 * for, after its sections on maintenance and warranty. The frame cut run_workflow's result to 1,600
 * characters and the collapsed history to the 2,000 of a delegation snippet, on the turn that ran
 * the job as well, where it also said the full result was "preserved in the original tool call
 * above". Behind a header of some 750 characters the model read 1,164 of the job's 3,070, and the
 * codes were not among them.
 */

const JOB = "source_grounded_paper_packet";
const E45_ROW = "| E45 | Kommunikation mit dem Akku gestört |";
const PAGE_URL = "http://www.nordlicht-werkzeuge.test/dokumentation.html";
/** A note the report adds on each point of a section it covers before the error codes. */
const point = (topic: string, n: number): string =>
  `- ${topic} ${n}: laut Dokumentation zu beachten; ${"Hinweise zu Inbetriebnahme, Pflege und Zubehör. ".repeat(3)}`;
/**
 * The job's answer in the order the deployed job wrote it: maintenance, warranty, then the error
 * codes, whose last row sits past character 2,000 of the tool's output.
 */
const ANSWER = [
  "## Quellenbericht Akku-Schrauber NW-AS 18",
  "",
  `Grundlage: Kurzanleitung und Fehlercode-Tabelle (${PAGE_URL}).`,
  "",
  "### Wartung",
  ...[1, 2, 3, 4, 5].map((n) => point("Wartung", n)),
  "",
  "### Garantie",
  ...[1, 2, 3, 4, 5].map((n) => point("Garantie", n)),
  "",
  "### Fehlercodes",
  "| Code | Bedeutung |",
  "| --- | --- |",
  "| E17 | Motor überhitzt |",
  "| E22 | Akku-Unterspannung |",
  "| E31 | Drehmomentsensor ohne Signal |",
  E45_ROW,
  "",
  `Fundstelle: ${PAGE_URL}`,
].join("\n");
/** run_workflow's output for a job (tools/workflow-catalog.ts): its status line, then the job's answer. */
const OUTPUT = `Workflow ${JOB} [job] completed.\n\n${ANSWER}`;
const ARTIFACTS = ["generated/nw-as-18/bericht.md", "generated/nw-as-18/folien.html", "generated/nw-as-18/notizen.md"];
const METADATA = {
  workflowName: JOB,
  workflowType: "job",
  blocked: false,
  toolCallsExecuted: 5,
  stepCount: 1,
  executedSteps: 1,
  artifacts: ARTIFACTS.map((outputPath) => ({ outputPath, filename: outputPath.split("/").pop() })),
};
/** The job's answer as the frame shows it within budget: no status line, markdown unmarked as before. */
const EVIDENCE = stripPresentationFormatting(ANSWER);
const MIDDLE_CUT_LINE = /\n\n\[Cut to fit the context budget: (\d+) characters between the beginning above and the end below are not shown\.\]\n\n/;
const EVIDENCE_MARKER = "Observed evidence:\n";
/** A frame cut from the middle, split at its cut line: the beginning it kept, the count, the end. */
function splitAtCut(visible: string, note = ""): { head: string; missing: number; end: string } {
  const evidence = visible.slice(visible.indexOf(EVIDENCE_MARKER) + EVIDENCE_MARKER.length, visible.length - note.length);
  const cut = MIDDLE_CUT_LINE.exec(evidence);
  expect(cut, "no cut line in the middle of the bounded run").not.toBeNull();
  return { head: evidence.slice(0, cut!.index), missing: Number(cut![1]), end: evidence.slice(cut!.index + cut![0].length) };
}
/** The cut left out exactly what the line says, between what it kept of `whole`. */
function expectCutOf(whole: string, kept: { head: string; missing: number; end: string }): void {
  expect(whole.startsWith(kept.head)).toBe(true);
  expect(whole.endsWith(kept.end)).toBe(true);
  expect(kept.missing).toBe(whole.length - kept.head.length - kept.end.length);
}

let savedMaxDelegatedResultChars: number;
beforeEach(() => {
  savedMaxDelegatedResultChars = getConfig().agents.performance.maxDelegatedResultChars;
  getConfig().agents.performance.maxDelegatedResultChars = 10_000;
});
afterEach(() => {
  getConfig().agents.performance.maxDelegatedResultChars = savedMaxDelegatedResultChars;
});

describe("the model-visible frame of a workflow run", () => {
  it("keeps the error code past character 2,000, newlines and table rows intact", () => {
    // The fixture has the shape that lost the codes: the row lies past the old cut and past the
    // delegation snippet, with maintenance and warranty ahead of it.
    expect(OUTPUT.indexOf(E45_ROW)).toBeGreaterThan(2_000);
    expect(OUTPUT.indexOf("### Wartung")).toBeLessThan(OUTPUT.indexOf("### Garantie"));
    expect(truncatePlainText(OUTPUT, 1_600)).not.toContain("E45");

    const visible = buildModelVisibleToolResult("run_workflow", OUTPUT, METADATA);
    expect(visible.startsWith(`Workflow ${JOB} [job] completed. Executed steps: 1/1.`)).toBe(true);
    for (const path of ARTIFACTS) expect(visible).toContain(`- ${path}`);
    expect(visible).toContain(E45_ROW);
    expect(visible).toContain("| E17 | Motor überhitzt |\n| E22 | Akku-Unterspannung |");
    // Within the budget the evidence is the job's whole answer, and the tool's status line is not
    // repeated under the header that already says it.
    expect(visible.slice(visible.indexOf(EVIDENCE_MARKER) + EVIDENCE_MARKER.length)).toBe(EVIDENCE);
    expect(visible.match(/completed\./g)).toHaveLength(1);
  });

  it("holds a run over budget to it, header included, keeping its beginning and its end and counting what is missing between", () => {
    getConfig().agents.performance.maxDelegatedResultChars = 2_000;
    const visible = buildModelVisibleToolResult("run_workflow", OUTPUT, METADATA);
    expect(visible.length).toBeLessThanOrEqual(2_000);
    expect(visible.startsWith(`Workflow ${JOB} [job] completed. Executed steps: 1/1.`)).toBe(true);
    expect(visible).toContain(`- ${ARTIFACTS[2]}`);
    expect(visible).toContain(point("Wartung", 1));
    expect(visible).not.toContain(point("Garantie", 1));
    expect(visible).toContain(E45_ROW);
    expectCutOf(EVIDENCE, splitAtCut(visible));
  });

  it("keeps the last step's section whole and cuts from the middle", () => {
    // A job's answer has a section per step, the last one the step that writes the deliverable
    // (tools/workflow-catalog.ts runJobInline); a cut from the end took it first.
    getConfig().agents.performance.maxDelegatedResultChars = 3_000;
    const report = [
      "## Bericht",
      "",
      "Fehlercodes laut Fehlercode-Tabelle:",
      "| Code | Bedeutung |",
      "| --- | --- |",
      "| E17 | Motor überhitzt |",
      "| E22 | Akku-Unterspannung |",
      "| E31 | Drehmomentsensor ohne Signal |",
      E45_ROW,
      "",
      `${"Zusammenfassung der Wartungs- und Garantiehinweise. ".repeat(8)}SCHLUSS`,
    ].join("\n");
    const steps = `Workflow ${JOB} [job] completed.\n\n## Recherche\n\n${[...Array(20).keys()].map((n) => point("Quelle", n + 1)).join("\n")}\n\n${report}`;
    const visible = buildModelVisibleToolResult("run_workflow", steps, METADATA);
    expect(visible.length).toBeLessThanOrEqual(3_000);
    expect(visible).toContain(point("Quelle", 1));
    expect(visible).not.toContain(point("Quelle", 10));
    const kept = splitAtCut(visible);
    expect(kept.end.endsWith(stripPresentationFormatting(report))).toBe(true);
    expectCutOf(stripPresentationFormatting(stripWorkflowPreamble(steps)), kept);
  });

  it("keeps the turn loop's note after the end it keeps", () => {
    getConfig().agents.performance.maxDelegatedResultChars = 2_000;
    const cachedNote = "\n\n[Note: This is a cached result — you already called 'run_workflow' with identical arguments earlier in this turn. "
      + "Do NOT call it again. Use this result and move to a different step.]";
    const visible = buildModelVisibleToolResult("run_workflow", `${OUTPUT}${cachedNote}`, METADATA, { runtimeNote: cachedNote });
    expect(visible.length).toBeLessThanOrEqual(2_000);
    expect(visible.endsWith(`Fundstelle: ${PAGE_URL}${cachedNote}`)).toBe(true);
    expectCutOf(EVIDENCE, splitAtCut(visible, cachedNote));
  });

  it("takes the budget of a delegated result relayed verbatim, effort-scaled", () => {
    getConfig().agents.performance.maxDelegatedResultChars = 7_777;
    expect(workflowRunResultMaxChars()).toBe(7_777);
    // The low effort tier relays at most 6,000 characters of a delegated result.
    const long = `${OUTPUT}\n\n${"Weitere Hinweise zur Wartung des Zubehörs. ".repeat(100)}SCHLUSS`;
    expect(long.length).toBeGreaterThan(6_000);
    const full = buildModelVisibleToolResult("run_workflow", long, METADATA);
    expect(full.length).toBeLessThanOrEqual(7_777);
    expect(full).toContain("SCHLUSS");
    const low = runWithEffortContext("low", () => buildModelVisibleToolResult("run_workflow", long, METADATA));
    expect(low.length).toBeLessThanOrEqual(6_000);
    expect(low).toContain("SCHLUSS");
    expect(low).not.toContain(E45_ROW);
    expect(low).toMatch(MIDDLE_CUT_LINE);
  });

  it("shows no more than 40,000 characters, whatever an effort tier allows a delegated result", () => {
    // The max tier relays 120,000 characters of a delegated result, the high tier 40,000.
    const long = `${OUTPUT}\n\n${"Weitere Hinweise zur Wartung des Zubehörs. ".repeat(1_500)}SCHLUSS`;
    expect(long.length).toBeGreaterThan(60_000);
    for (const tier of ["max", "high"] as const) {
      expect(runWithEffortContext(tier, () => workflowRunResultMaxChars())).toBe(40_000);
      const visible = runWithEffortContext(tier, () => buildModelVisibleToolResult("run_workflow", long, METADATA));
      expect(visible.length, tier).toBeLessThanOrEqual(40_000);
      expect(visible.length, tier).toBeGreaterThan(39_000);
    }
  });

  it("holds a turn's runs to one budget, and a late one to a quarter of it", () => {
    // A retry, a duplicate or a second run of the turn shares what the first left, instead of
    // carrying a second whole budget into every prompt after it.
    const shown = { chars: 0 };
    const first = buildModelVisibleToolResult("run_workflow", OUTPUT, METADATA, { workflowShown: shown });
    expect(first).toContain(E45_ROW);
    expect(shown.chars).toBe(first.length);
    const long = `${OUTPUT}\n\n${"Weitere Hinweise zur Wartung des Zubehörs. ".repeat(250)}SCHLUSS`;
    expect(long.length).toBeGreaterThan(10_000);
    const second = buildModelVisibleToolResult("run_workflow", long, METADATA, { workflowShown: shown });
    expect(second.length).toBeLessThanOrEqual(10_000 - first.length);
    expect(second.length).toBeGreaterThan(10_000 - first.length - 200);
    expect(shown.chars).toBe(first.length + second.length);
    const third = buildModelVisibleToolResult("run_workflow", long, METADATA, { workflowShown: shown });
    expect(third.length).toBeLessThanOrEqual(2_500);
    expect(third.length).toBeGreaterThan(2_300);
    // Without a tally a run is allowed the whole budget, as before.
    expect(buildModelVisibleToolResult("run_workflow", long, METADATA).length).toBeGreaterThan(9_800);
    // A call that ran no workflow does not draw on it.
    const before = shown.chars;
    buildModelVisibleToolResult("run_workflow", "Error: Workflow name 'packet' is ambiguous.", { workflowMatches: [] }, { workflowShown: shown });
    expect(shown.chars).toBe(before);
  });

  it("keeps a call that ran no workflow at the 1,600 characters it had", () => {
    // An ambiguous name is refused with the matches and no workflow named (tools/workflow-catalog.ts).
    const refusal = `Error: Workflow name 'packet' is ambiguous. Matching workflows: ${"source_grounded_paper_packet [job], ".repeat(60)}end.`;
    expect(refusal.length).toBeGreaterThan(1_600);
    const visible = buildModelVisibleToolResult("run_workflow", refusal, { workflowMatches: [] });
    const evidence = visible.slice(visible.indexOf(EVIDENCE_MARKER) + EVIDENCE_MARKER.length);
    expect(evidence).toBe(truncatePlainText(refusal, 1_600));
  });
});

describe("the collapsed history the turn's prompts are built from", () => {
  /** The turn loop stores the framed result with the tool's metadata (agent/turn-tool-execution.ts). */
  function sessionWithRun() {
    const session = new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "You are a test agent." });
    session.addMessage({ role: "user", content: "Erstelle einen quellenbasierten Bericht zum NW-AS 18: Wartung, Garantie und alle Fehlercodes." });
    session.addMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_wf", type: "function", function: { name: "run_workflow", arguments: JSON.stringify({ name: JOB, workflowType: "job" }) } }],
    } as never);
    session.addMessage({ role: "tool", tool_call_id: "call_wf", content: buildModelVisibleToolResult("run_workflow", OUTPUT, METADATA), metadata: METADATA } as never);
    return session;
  }
  const collapsedText = (session: AgentSession) => session.getCollapsedHistory().map((m) => String(m.content)).join("\n");

  it("keeps this turn's run whole, the error code past the delegation snippet's 2,000 characters included", () => {
    // Both main-loop iterations and the forced synthesis read this view, not the tool message.
    const framed = buildModelVisibleToolResult("run_workflow", OUTPUT, METADATA);
    expect(framed.indexOf(E45_ROW)).toBeGreaterThan(2_000);
    const collapsed = collapsedText(sessionWithRun());
    expect(collapsed).toContain(E45_ROW);
    expect(collapsed).not.toContain("snippet summarized for prior-turn history");
  });

  it("holds it to the delegation snippet once the turn is over", () => {
    const session = sessionWithRun();
    session.addMessage({ role: "assistant", content: "Fehlercodes: E17, E22, E31, E45. Der Bericht liegt als Datei bei." });
    session.addMessage({ role: "user", content: "Und was bedeutet E22?" });
    const framed = buildModelVisibleToolResult("run_workflow", OUTPUT, METADATA);
    const collapsed = collapsedText(session);
    expect(collapsed).toContain(`${framed.substring(0, 2_000)} [snippet summarized for prior-turn history; full result preserved in the original tool call above, ${framed.length} chars total]`);
    expect(collapsed).not.toContain(E45_ROW);
  });
});

describe("the evidence the backstops can hand the user", () => {
  it("carries a plain […] where the frame cut the run, not the frame's cut line", () => {
    // The coverage check, the terminal and empty-reply backstops and the delegation-loop reply ship
    // this text as the answer; the cut line is the harness speaking to the model.
    getConfig().agents.performance.maxDelegatedResultChars = 2_000;
    const framed = buildModelVisibleToolResult("run_workflow", OUTPUT, METADATA);
    expect(framed).toMatch(MIDDLE_CUT_LINE);
    const history = [
      { role: "user", content: "Erstelle einen quellenbasierten Bericht zum NW-AS 18." },
      { role: "assistant", content: "" },
      { role: "tool", content: framed, metadata: METADATA },
    ];
    const found = findRecentDelegateEvidence(history, { scopeToCurrentTurn: true });
    expect(found).not.toBeNull();
    expect(found!.evidence).not.toContain("Cut to fit the context budget");
    expect(found!.evidence).toContain("\n\n[…]\n\n");
    expect(found!.evidence.endsWith(`Fundstelle: ${PAGE_URL}`)).toBe(true);
    // A cut from the end, as a knowledge-base worker's report gets, leaves "[…]" at the end.
    expect(stripBudgetCutLines(`${EVIDENCE.slice(0, 500)}${budgetCutLine(EVIDENCE.length - 500)}`).endsWith("\n\n[…]")).toBe(true);
    expect(found!.evidence).toContain(point("Wartung", 1).trim());
  });
});
