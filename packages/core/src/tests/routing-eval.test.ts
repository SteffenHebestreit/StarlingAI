/**
 * The routing decision suite, run as a test so it gates every commit.
 *
 * The suite itself is data (`eval/routing/decision-cases.jsonl`); this file runs it and
 * guards the measuring apparatus. The apparatus is what has failed before: a benchmark that
 * dropped gated rows, a fixture that echoed the description it was routing to, a suite that
 * scored nothing and reported green.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_EVAL_THRESHOLDS,
  decisionResolver,
  formatRoutingEvalReport,
  lexicalOverlap,
  lintCases,
  parseCaseFile,
  runRoutingEval,
  type RoutingEvalCase,
  type RoutingEvalResolver,
} from "../agent/routing-eval.js";
import { PROBES } from "../scripts/routing-eval-discriminance.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const CASES_PATH = join(REPO_ROOT, "eval", "routing", "decision-cases.jsonl");

function loadCases(): RoutingEvalCase[] {
  return parseCaseFile(readFileSync(CASES_PATH, "utf8"));
}

/** A resolver that pretends every case was gated away, for the gate-accounting tests. */
const alwaysGated: RoutingEvalResolver = async () => ({
  decision: {
    branch: "general", shortlist: [], k: 0, margin: 0,
    agreementClass: "unknown", sourceSensitive: false, reasons: ["nothing"],
  },
  ranked: [],
  gated: true,
  hasVerdict: true,
});

describe("routing decision suite", () => {
  it("passes against the committed cases", async () => {
    const cases = loadCases();
    const report = await runRoutingEval(cases, decisionResolver(), { mode: "decision" });
    expect(report.failures, formatRoutingEvalReport(report)).toEqual([]);
    expect(report.passedGate).toBe(true);
  });

  it("is large enough and clean enough to mean something", () => {
    const cases = loadCases();
    // Not a style rule. A suite that shrinks below this has lost the coverage the
    // discriminance harness depends on, and the harness would then report STALE anchors
    // rather than silently proving less.
    expect(cases.length).toBeGreaterThanOrEqual(20);
    expect(lintCases(cases)).toEqual([]);
    // Every case must carry candidates, or decision mode scores it vacuously.
    for (const evalCase of cases) {
      expect(evalCase.candidates, `${evalCase.id} has no candidates`).toBeDefined();
      expect(evalCase.note, `${evalCase.id} does not say why it exists`).toBeTruthy();
    }
  });

  it("keeps a control beside every case the discriminance harness relies on", () => {
    const ids = new Set(loadCases().map((evalCase) => evalCase.id));
    const missing: string[] = [];
    for (const probe of PROBES) {
      for (const id of [...probe.mustFail, ...(probe.mustPass ?? [])]) {
        if (!ids.has(id)) missing.push(`${probe.name} -> ${id}`);
      }
    }
    // A probe pointing at a deleted case reports "did NOT break" and reads as a weak case,
    // when the truth is that the case is gone. Catch the drift here, cheaply.
    expect(missing).toEqual([]);
  });
});

describe("gate accounting", () => {
  it("counts a gated case as a miss rather than dropping it", async () => {
    const cases: RoutingEvalCase[] = [
      { id: "a", query: "q", expect: { target: "coder" } },
      { id: "b", query: "q", expect: { target: "coder" } },
    ];
    const report = await runRoutingEval(cases, alwaysGated, { mode: "decision" });
    expect(report.gated).toBe(2);
    expect(report.gatedRate).toBe(1);
    // The e1151d8 shape: the denominator must still be 2, and the run must fail.
    expect(report.targetScored).toBe(2);
    expect(report.targetCorrect).toBe(0);
    expect(report.passedGate).toBe(false);
    expect(report.failures.some((failure) => failure.includes("gated"))).toBe(true);
  });

  it("reports INCONCLUSIVE rather than a pass when nothing could be scored", async () => {
    const cases: RoutingEvalCase[] = [
      // A branch expectation with no verdict is skipped, leaving zero applicable checks.
      { id: "only-skippable", query: "q", candidates: [], verdict: null, expect: { branch: "single_agent" } },
    ];
    const report = await runRoutingEval(cases, decisionResolver(), { mode: "decision" });
    expect(report.scored).toBe(0);
    expect(report.inconclusive).toBe(true);
    expect(report.passedGate).toBe(false);
    expect(formatRoutingEvalReport(report)).toContain("INCONCLUSIVE");
  });

  it("does not charge a user-named agent to the recall figure", async () => {
    const shared = {
      query: "have the researcher look at this",
      candidates: [{ name: "coder", family: "agent" as const, score: 0.9, floor: 0.72 }],
      verdict: null,
    };
    const directive: RoutingEvalCase = {
      id: "directive", ...shared,
      flags: { directiveAgent: "researcher" },
      expect: { target: "researcher" },
    };
    const retrieval: RoutingEvalCase = { id: "retrieval", ...shared, expect: { target: "researcher" } };

    const withDirective = await runRoutingEval([directive], decisionResolver(), { mode: "decision" });
    const withoutDirective = await runRoutingEval([retrieval], decisionResolver(), { mode: "decision" });
    // The directive case names an entry the router was never asked to find.
    expect(withDirective.recallScored).toBe(0);
    // The control proves the exclusion is about the directive, not about target cases.
    expect(withoutDirective.recallScored).toBe(1);
    expect(withoutDirective.recallHit).toBe(0);
  });
});

describe("shortlist expectations", () => {
  const candidates = [
    { name: "a", family: "agent" as const, score: 0.99, floor: 0.72 },
    { name: "b", family: "agent" as const, score: 0.95, floor: 0.72 },
    { name: "c", family: "agent" as const, score: 0.94, floor: 0.72 },
  ];

  it("checks the shortlist size", async () => {
    const tight = await runRoutingEval(
      [{ id: "k", query: "q", candidates, verdict: null, expect: { maxShortlist: 1 } }],
      decisionResolver(), { mode: "decision" },
    );
    const loose = await runRoutingEval(
      [{ id: "k", query: "q", candidates, verdict: null, expect: { maxShortlist: 3 } }],
      decisionResolver(), { mode: "decision" },
    );
    expect(tight.passed).toBe(0);
    expect(loose.passed).toBe(1);
  });

  it("checks the leader's margin", async () => {
    const report = await runRoutingEval(
      [{ id: "m", query: "q", candidates, verdict: null, expect: { minMargin: 0.9 } }],
      decisionResolver(), { mode: "decision" },
    );
    expect(report.passed).toBe(0);
    expect(report.failures.join(" ")).toContain("margin");
  });
});

describe("lexical leakage flag", () => {
  const description = "Reviews, explains and retrieves code across the workspace, locating symbols and references";

  it("flags a query written by echoing the entry's own description", () => {
    const echoed = "reviews explains retrieves code workspace locating symbols references";
    expect(lexicalOverlap(echoed, description)).toBeGreaterThanOrEqual(DEFAULT_EVAL_THRESHOLDS.leakOverlap);
  });

  it("leaves a query written in the user's own words alone", () => {
    const natural = "where do we decide whether a delegation is allowed to run twice";
    expect(lexicalOverlap(natural, description)).toBeLessThan(DEFAULT_EVAL_THRESHOLDS.leakOverlap);
  });

  it("reports the leaked ids and a pass rate computed without them", async () => {
    const cases: RoutingEvalCase[] = [
      {
        id: "echoed",
        query: "reviews explains retrieves code workspace locating symbols references",
        candidates: [{ name: "code_analyst", family: "agent", score: 0.9, floor: 0.72 }],
        verdict: null,
        expect: { top: "code_analyst" },
      },
    ];
    const report = await runRoutingEval(cases, decisionResolver(), {
      mode: "decision",
      catalogText: { code_analyst: description },
    });
    expect(report.leaked).toEqual(["echoed"]);
    // Every scored case is leaked, so nothing clean remains to compute a rate from.
    expect(report.cleanPassRate).toBeNull();
    expect(formatRoutingEvalReport(report)).toContain("LEXICALLY LEAKED");
  });
});

describe("case file handling", () => {
  it("parses one object per line and ignores comments", () => {
    const text = [
      "// a comment",
      JSON.stringify({ id: "a", query: "q", expect: { target: "x" } }),
      "",
      JSON.stringify({ id: "b", query: "q", expect: { target: "y" } }),
    ].join("\n");
    expect(parseCaseFile(text).map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("names the offending line when a case is malformed", () => {
    const text = `${JSON.stringify({ id: "a", query: "q", expect: {} })}\n{not json`;
    expect(() => parseCaseFile(text)).toThrow(/line 2/);
  });

  it("rejects a file that cannot measure anything", () => {
    const problems = lintCases([
      { id: "dup", query: "q", expect: { target: "x" } },
      { id: "dup", query: "q", expect: { target: "x" } },
      { id: "empty", query: "q", expect: {} },
      { id: "", query: "", expect: { target: "x" } },
    ]);
    expect(problems.some((problem) => problem.includes("duplicate case id: dup"))).toBe(true);
    expect(problems.some((problem) => problem.includes("asserts nothing"))).toBe(true);
    expect(problems.some((problem) => problem.includes("no id"))).toBe(true);
  });
});
