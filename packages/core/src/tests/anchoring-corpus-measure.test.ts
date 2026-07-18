/**
 * Measured precision of the evidence-anchoring repair trigger
 * (`orchestration.evidenceAnchoringOnGatheredEvidence`, default OFF, pass^k-gated).
 *
 * With the flag ON, a turn that delegated research re-synthesizes its answer whenever
 * answerNeedsEvidenceAnchoringRepair() judges the answer unanchored. The flag's own docs
 * name the risk ("it can re-synthesize an answer"), so the decisive number for default-on
 * is how often it discards an answer that was ALREADY correctly grounded.
 *
 * Corpus: fixtures/anchoring-corpus.json — 30 (evidence, answer) pairs across software
 * releases, weather, opening hours/prices, hardware specs, regulation and travel, balanced
 * 15 de / 15 en, 18 grounded / 12 ungrounded. Every pair was relabelled by an independent
 * reader that never saw the intended label; all 30 agreed, so the labels are not
 * self-reported by whoever wrote the answer.
 *
 * Measured baseline (2026-07-18, see the flag's docstring in config/schemas/orchestration.ts):
 *
 *     ALL  n=30  FP=15/18 (83%)  FN=1/12 ( 8%)  accuracy 47%
 *     de   n=15  FP= 8/9  (89%)  FN=1/6  (17%)  accuracy 40%
 *     en   n=15  FP= 7/9  (78%)  FN=0/6  ( 0%)  accuracy 53%
 *
 * 47% is WORSE than never firing at all (18/30 = 60%), so enabling the flag as-is costs a
 * re-synthesis on most successful research turns and buys almost no correctness.
 *
 * Cause: condition 2 of looksEvidenceAnchored treats every hyphenated token as a falsifiable
 * spec that must appear verbatim in the evidence. Ordinary prose trips it in BOTH languages
 * ("half-hour", "13-inch", "user-replaceable", "wartungs-release", "bug-fixes"), and so does
 * locale date reformatting (answer "20.02.2025" vs evidence "2025-02-20").
 *
 * This test is intentionally NON-ASSERTING on the rates: it prints them and only checks the
 * corpus is intact, so improving the detector does not fail the suite. Re-run it after any
 * change to evidence-anchoring.ts and compare against the baseline above.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { answerNeedsEvidenceAnchoringRepair } from "../agent/evidence-recovery.js";

type Pair = {
  id: string;
  language: string;
  groundTruth: "grounded" | "ungrounded";
  evidence: string;
  answer: string;
};

const CORPUS_PATH = fileURLToPath(new URL("./fixtures/anchoring-corpus.json", import.meta.url));

describe("evidence-anchoring trigger — measured precision over a labelled corpus", () => {
  it("reports false-positive / false-negative rates", () => {
    const { pairs } = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as { pairs: Pair[] };
    expect(pairs.length).toBeGreaterThan(0);

    const rows = pairs.map((p) => {
      // fired == the guard would discard this answer and re-synthesize it.
      const fired = answerNeedsEvidenceAnchoringRepair(p.answer, p.evidence);
      const correct = p.groundTruth === "ungrounded" ? fired : !fired;
      return { ...p, fired, correct };
    });

    const tally = (subset: typeof rows) => {
      const grounded = subset.filter((r) => r.groundTruth === "grounded");
      const ungrounded = subset.filter((r) => r.groundTruth === "ungrounded");
      const fp = grounded.filter((r) => r.fired).length;
      const fn = ungrounded.filter((r) => !r.fired).length;
      return {
        n: subset.length,
        fp, fn,
        g: grounded.length,
        u: ungrounded.length,
        fpRate: grounded.length ? fp / grounded.length : NaN,
        fnRate: ungrounded.length ? fn / ungrounded.length : NaN,
        acc: subset.length ? subset.filter((r) => r.correct).length / subset.length : NaN,
      };
    };
    const pct = (x: number) => (Number.isNaN(x) ? " n/a" : `${(x * 100).toFixed(0).padStart(3)}%`);
    const row = (label: string, t: ReturnType<typeof tally>) =>
      `  ${label.padEnd(4)} n=${String(t.n).padStart(2)}  FP=${t.fp}/${t.g} (${pct(t.fpRate)})`
      + `  FN=${t.fn}/${t.u} (${pct(t.fnRate)})  acc=${pct(t.acc)}`;

    const all = tally(rows);
    // eslint-disable-next-line no-console
    console.log([
      "",
      "[anchoring] FP = a GROUNDED answer would be discarded and re-synthesized",
      "[anchoring] FN = an UNGROUNDED answer ships unrepaired (what the flag exists to catch)",
      row("ALL", all),
      row("de", tally(rows.filter((r) => r.language === "de"))),
      row("en", tally(rows.filter((r) => r.language === "en"))),
      `  always-silent baseline accuracy: ${pct(rows.filter((r) => r.groundTruth === "grounded").length / rows.length)}`,
      "",
    ].join("\n"));

    // Structural only — every pair must be measurable. Rates are reported, not asserted.
    expect(rows).toHaveLength(pairs.length);
    expect(rows.every((r) => typeof r.fired === "boolean")).toBe(true);
  });
});
