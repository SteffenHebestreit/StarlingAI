/**
 * decisions:bench — the arithmetic that says whether Laya pays off at a decision point, the labelled datasets it runs
 * on, and the two defects of decisions:bootstrap and decisions:export it depends on. No model and no sidecar: every
 * result here is constructed, and the two scripts run in child processes that exit before any call.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BENCH_PROFILES,
  alwaysMajorityResults,
  benchExitCode,
  benchLedgerRow,
  benchSplit,
  buildBenchReport,
  caseMessage,
  flawlessSamplesNeeded,
  levelCurve,
  lintDecisionCases,
  negationPairs,
  orderSwapFlips,
  reversedOptions,
  parseDecisionCases,
  pointVerdict,
  profileDataset,
  projectSavings,
  gateReplayOrder,
  qualifyLevel,
  readTimings,
  renderBenchMarkdown,
  simulateGate,
  summarizeBench,
  type BenchResult,
  type BenchReportSettings,
  type DecisionBenchCase,
  type GateSimulation,
  type ProjectionSettings,
} from "../agent/decisions-bench.js";
import { CONFIRM_SAMPLES, GATE_LEVELS, qualifiedLevel, recordAgreementSample, resetGateForTests, wilsonLowerBound } from "../decisions/gate.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE = resolve(HERE, "../..");
const REPO = resolve(CORE, "../..");
const tempDir = mkdtempSync(join(tmpdir(), "sai-decisions-bench-"));

beforeAll(async () => {
  writeFileSync(join(tempDir, "starlingai.json"), JSON.stringify({ workspacePath: tempDir, gateway: { jwtSecret: "t".repeat(32) } }), "utf8");
  process.env["SAI_CONFIG_PATH"] = join(tempDir, "starlingai.json");
  (await import("../config/loader.js")).resetConfigForTests();
});

afterAll(() => {
  delete process.env["SAI_CONFIG_PATH"];
  rmSync(tempDir, { recursive: true, force: true });
});

const SS = BENCH_PROFILES.source_sensitive;
const FL = BENCH_PROFILES.fast_lane;
const GATE = { targetAgreement: 0.9, minSamples: 30 };

/** A deterministic PRNG, so a failure names the same samples every run. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function laya(choice: string, top: number, ms = 20, model = "m1"): BenchResult["laya"] {
  return { choice, top, ms, model, probabilities: { [choice]: top } };
}

/** `count` results of one shape, numbered from `from`. */
function many(count: number, shape: Omit<BenchResult, "caseId" | "attempt"> & { attempt?: number }, prefix: string, from = 0): BenchResult[] {
  return Array.from({ length: count }, (_, i) => ({ attempt: 0, ...shape, caseId: `${prefix}-${from + i}` }));
}

describe("the gate replay qualifies exactly as decisions/gate.ts does", () => {
  it("gives the gate's own level for any samples and settings", () => {
    const random = prng(7);
    const tops = [...GATE_LEVELS, 0.55, 0.72, 0.99, 1];
    for (let round = 0; round < 300; round += 1) {
      const settings = [GATE, { targetAgreement: 0.8, minSamples: 10 }, { targetAgreement: 0.95, minSamples: 50 }][round % 3]!;
      const agreeShare = 0.7 + random() * 0.3;
      const samples = Array.from({ length: Math.floor(random() * 140) }, () => ({ top: tops[Math.floor(random() * tops.length)]!, agree: random() < agreeShare }));
      resetGateForTests();
      for (const sample of samples) recordAgreementSample("source_sensitive", "de", "no", sample.top, sample.agree, "m");
      expect(qualifyLevel(samples, settings), `round ${round}`).toBe(qualifiedLevel("source_sensitive", "de", "no", settings, "m"));
    }
    resetGateForTests();
  });

  it("gives the gate's own level per language and answer, the protected answer's recall guard included", () => {
    const random = prng(11);
    const tops = [...GATE_LEVELS, 0.55, 0.72, 0.99, 1];
    let guardedBuckets = 0;
    for (let round = 0; round < 150; round += 1) {
      const settings = [GATE, { targetAgreement: 0.8, minSamples: 10 }][round % 2]!;
      // Mostly "no" traffic with a varying share of "yes", and a Laya that misses a varying share of the "yes".
      const yesShare = random() * 0.6;
      const missShare = random() * 0.3;
      const flipShare = random() * 0.1;
      const results: BenchResult[] = Array.from({ length: 40 + Math.floor(random() * 260) }, (_, i) => {
        const incumbent = random() < yesShare ? "yes" : "no";
        const choice = incumbent === "yes" ? (random() < missShare ? "no" : "yes") : (random() < flipShare ? "yes" : "no");
        const language = random() < 0.6 ? "de" : "en";
        return { caseId: `r${round}-${i}`, point: "source_sensitive", language, gateLanguage: language, gold: incumbent, split: "calibration", attempt: 0, incumbent: { choice: incumbent, ms: 1 }, laya: laya(choice, tops[Math.floor(random() * tops.length)]!, 20, "m") };
      });
      resetGateForTests();
      // In the order the replay feeds the gate: the gate reads order (its confirmation and drift window).
      for (const result of gateReplayOrder(results)) {
        recordAgreementSample("source_sensitive", result.gateLanguage!, result.laya!.choice, result.laya!.top, result.laya!.choice === result.incumbent!.choice, "m", result.incumbent!.choice);
      }
      // Every case in the calibration half: the replay splits a run with no test case again, so ask for the buckets
      // of a run whose test half is one extra case.
      const [simulation] = simulateGate([...results, { ...results[0]!, caseId: `r${round}-test`, split: "test" }], SS, settings);
      expect(simulation!.nestedSplit).toBe(false);
      for (const bucket of simulation!.buckets) {
        expect(bucket.qualifiedLevel, `round ${round} ${bucket.language} ${bucket.answer}`).toBe(qualifiedLevel("source_sensitive", bucket.language, bucket.answer, settings, "m", SS.protect));
        if (bucket.recallGuard) guardedBuckets += 1;
      }
    }
    expect(SS.protect).toBe("yes");
    expect(guardedBuckets).toBeGreaterThan(100);
    resetGateForTests();
  });

  it("needs 38 cases that all agree at 0.9 — 35 for the bound, and the same again without the newest three", () => {
    expect(flawlessSamplesNeeded(GATE)).toBe(35 + CONFIRM_SAMPLES);
    expect(wilsonLowerBound(30, 30)).toBeLessThan(0.9);
    expect(wilsonLowerBound(35, 35)).toBeGreaterThanOrEqual(0.9);
    expect(flawlessSamplesNeeded({ targetAgreement: 0.9, minSamples: 40 })).toBe(40 + CONFIRM_SAMPLES);
    const needed = flawlessSamplesNeeded({ targetAgreement: 0.8, minSamples: 5 }) - CONFIRM_SAMPLES;
    expect(wilsonLowerBound(needed, needed)).toBeGreaterThanOrEqual(0.8);
    expect(wilsonLowerBound(needed - 1, needed - 1)).toBeLessThan(0.8);
    // And the gate itself opens exactly there.
    const flawless = (n: number) => Array.from({ length: n }, () => ({ top: 0.99, agree: true }));
    expect(qualifyLevel(flawless(35 + CONFIRM_SAMPLES), GATE)).toBe(0.5);
    expect(qualifyLevel(flawless(35 + CONFIRM_SAMPLES - 1), GATE)).toBeNull();
    expect(flawlessSamplesNeeded({ targetAgreement: 1, minSamples: 5 })).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("an always-majority Laya", () => {
  // The live traffic: the judge said "clear" on 25 of 25 turns. A Laya that always says "no" agrees every time.
  const results: BenchResult[] = [
    ...many(76, { point: "source_sensitive", language: "de", gold: "no", split: "calibration", incumbent: { choice: "no", ms: 1_800 }, laya: laya("no", 0.97) }, "cal"),
    ...many(4, { point: "source_sensitive", language: "de", gold: "yes", split: "calibration", incumbent: { choice: "no", ms: 1_800 }, laya: laya("no", 0.97) }, "cal", 76),
    ...many(34, { point: "source_sensitive", language: "de", gold: "no", split: "test", incumbent: { choice: "no", ms: 1_800 }, laya: laya("no", 0.97) }, "test"),
    ...many(6, { point: "source_sensitive", language: "de", gold: "yes", split: "test", incumbent: { choice: "no", ms: 1_800 }, laya: laya("no", 0.97) }, "test", 34),
    ...many(36, { point: "source_sensitive", language: "en", gold: "no", split: "calibration", incumbent: { choice: "no", ms: 1_800 }, laya: laya("no", 0.97) }, "cal-en"),
    ...many(4, { point: "source_sensitive", language: "en", gold: "yes", split: "calibration", incumbent: { choice: "no", ms: 1_800 }, laya: laya("no", 0.97) }, "cal-en", 36),
    ...many(30, { point: "source_sensitive", language: "en", gold: "no", split: "test", incumbent: { choice: "no", ms: 1_800 }, laya: laya("no", 0.97) }, "test-en"),
  ];

  // The gate as it would be without the recall guard of source_sensitive's protected "yes": precision alone.
  const { protect: _protect, ...PRECISION_ONLY } = SS;

  it("qualifies on agreement alone, and only the rare-class miss rate exposes it", () => {
    const [simulation] = simulateGate(results, PRECISION_ONLY, GATE);
    expect(simulation!.status).toBe("qualified");
    const all = simulation!.test.find((slice) => slice.language === "all")!;
    expect(all.coverage.rate).toBe(1);
    expect(all.wrongVsReference).toMatchObject({ hits: 0, n: 70 });
    expect(all.wrongVsGold.rate).toBeCloseTo(6 / 70);
    expect(all.rareMissVsGold).toMatchObject({ hits: 6, n: 6, rate: 1 });
    expect(all.rareMiss).toMatchObject({ hits: 6, n: 6 });
    // The incumbent is wrong on the same six: the handover adds no error against it, and still loses every one.
    expect(all.incumbentWrongVsGold).toMatchObject({ hits: 6, n: 70 });
    expect(all.regressions).toMatchObject({ hits: 0, n: 70 });
    const [projection] = projectSavings(results, simulation!, PRECISION_ONLY, { ...PROJECTION, auditRate: 0 }).filter((p) => p.mix === "prior");
    // Precision alone says "pays off": it never disagrees with the incumbent on what it takes.
    const judged = pointVerdict(simulation!, projection, PRECISION_ONLY, { targetAgreement: 0.9, maxRareMiss: 0.1 });
    expect(judged.verdict).toBe("unsafe");
    expect(judged.reasons.join(" ")).toMatch(/6 of 6 "yes" cases/);
  });

  it("is not handed the point by the real gate, whose recall guard has seen no \"yes\" from the incumbent", () => {
    const [simulation] = simulateGate(results, SS, GATE);
    const no = simulation!.buckets.find((bucket) => bucket.language === "de" && bucket.answer === "no")!;
    expect(no).toMatchObject({ samples: 80, agreeing: 80, qualifiedLevel: null, recallGuard: { protect: "yes", cases: 0, answeredThis: 0 } });
    expect(simulation!.status).toBe("insufficient_calibration");
    expect(simulation!.takenCaseIds).toEqual([]);
    const judged = pointVerdict(simulation!, undefined, SS, { targetAgreement: 0.9, maxRareMiss: 0.1 });
    expect(judged.verdict).toBe("inconclusive");
    expect(judged.reasons[0]).toMatch(/recall guard needs 35 "yes" cases .* holds at most 0/);
  });

  it("is refused by the recall guard where its precision alone would pass", () => {
    // 1,000 "no" and 35 "yes" from the incumbent: "always no" agrees on 96.6% (lower bound 0.954) and misses all 35.
    const lopsided: BenchResult[] = [
      ...many(1_000, { point: "source_sensitive", language: "de", gold: "no", split: "calibration", incumbent: { choice: "no", ms: 1_800 }, laya: laya("no", 0.97) }, "n"),
      ...many(35, { point: "source_sensitive", language: "de", gold: "yes", split: "calibration", incumbent: { choice: "yes", ms: 1_800 }, laya: laya("no", 0.97) }, "y"),
      ...many(10, { point: "source_sensitive", language: "de", gold: "no", split: "test", incumbent: { choice: "no", ms: 1_800 }, laya: laya("no", 0.97) }, "t"),
    ];
    expect(simulateGate(lopsided, PRECISION_ONLY, GATE)[0]!.status).toBe("qualified");
    const [simulation] = simulateGate(lopsided, SS, GATE);
    expect(simulation!.buckets[0]).toMatchObject({ answer: "no", recallGuard: { cases: 35, answeredThis: 35 }, qualifiedLevel: null });
    expect(simulation!.status).toBe("not_qualified");
    expect(simulation!.takenCaseIds).toEqual([]);
  });

  it("is refused by the gate once the incumbent itself finds the rare class", () => {
    const honest = results.map((result) => ({ ...result, incumbent: { choice: result.gold!, ms: 1_800 } }));
    const baseline = alwaysMajorityResults(honest, SS);
    expect(baseline.every((result) => result.laya?.choice === "no" && result.laya.top === 1)).toBe(true);
    // With the rare class in it, "always no" agrees on 76 of 80 German calibration cases: 95%, but a lower bound of
    // 0.878; on 36 of 40 English ones, 0.77. Precision alone refuses it already.
    const [simulation] = simulateGate(baseline, PRECISION_ONLY, GATE);
    expect(simulation!.status).toBe("not_qualified");
    expect(simulation!.takenCaseIds).toEqual([]);
    expect(simulateGate(baseline, SS, GATE)[0]!.takenCaseIds).toEqual([]);
  });
});

describe("the gate replay", () => {
  it("never hands Laya an answer the point keeps for the incumbent", () => {
    const fast: BenchResult[] = [
      ...many(40, { point: "fast_lane", language: "de", gold: "small_talk", split: "calibration", incumbent: { choice: "small_talk", ms: 1_800 }, laya: laya("small_talk", 0.99) }, "st"),
      ...many(40, { point: "fast_lane", language: "de", gold: "task", split: "calibration", incumbent: { choice: "task", ms: 1_800 }, laya: laya("task", 0.99) }, "t"),
      ...many(10, { point: "fast_lane", language: "de", gold: "small_talk", split: "test", incumbent: { choice: "small_talk", ms: 1_800 }, laya: laya("small_talk", 0.99) }, "st", 40),
      ...many(10, { point: "fast_lane", language: "de", gold: "task", split: "test", incumbent: { choice: "task", ms: 1_800 }, laya: laya("task", 0.99) }, "t", 40),
    ];
    const [simulation] = simulateGate(fast, FL, GATE);
    const smallTalk = simulation!.buckets.find((bucket) => bucket.answer === "small_talk")!;
    expect(smallTalk.qualifiedLevel).not.toBeNull();
    expect(smallTalk.mayTake).toBe(false);
    expect(simulation!.takenCaseIds).toHaveLength(10);
    expect(simulation!.takenCaseIds.every((id) => id.startsWith("t-"))).toBe(true);
  });

  it("keeps the languages apart, keyed on the language a turn detects", () => {
    const mixed: BenchResult[] = [
      ...many(40, { point: "fast_lane", language: "en", gold: "task", split: "calibration", incumbent: { choice: "task", ms: 1_800 }, laya: laya("task", 0.95) }, "en"),
      ...many(10, { point: "fast_lane", language: "de", gold: "task", split: "calibration", incumbent: { choice: "task", ms: 1_800 }, laya: laya("task", 0.95) }, "de"),
      ...many(5, { point: "fast_lane", language: "en", gold: "task", split: "test", incumbent: { choice: "task", ms: 1_800 }, laya: laya("task", 0.95) }, "en", 40),
      ...many(5, { point: "fast_lane", language: "de", gold: "task", split: "test", incumbent: { choice: "task", ms: 1_800 }, laya: laya("task", 0.95) }, "de", 10),
      // Labelled German, but a bare "ok" carries no language a turn could detect: the gate files it under "other".
      ...many(5, { point: "fast_lane", language: "de", gateLanguage: "other", gold: "task", split: "test", incumbent: { choice: "task", ms: 1_800 }, laya: laya("task", 0.95) }, "ok"),
    ];
    const [simulation] = simulateGate(mixed, FL, GATE);
    expect(simulation!.buckets.map((bucket) => [bucket.language, bucket.samples, bucket.qualifiedLevel !== null])).toEqual([["de", 10, false], ["en", 40, true]]);
    expect(simulation!.takenCaseIds.every((id) => id.startsWith("en-"))).toBe(true);
    expect(simulation!.test.find((slice) => slice.language === "de")).toMatchObject({ cases: 10, taken: 0 });
  });

  it("counts one run per case: repeats are not independent evidence", () => {
    const repeated = [0, 1, 2].flatMap((attempt) => [
      ...many(20, { point: "source_sensitive", language: "de", gold: "no", split: "calibration", attempt, incumbent: { choice: "no", ms: 1_800 }, laya: laya("no", 0.99) }, "c"),
      ...many(5, { point: "source_sensitive", language: "de", gold: "no", split: "test", attempt, incumbent: { choice: "no", ms: 1_800 }, laya: laya("no", 0.99) }, "t"),
      ...many(5, { point: "source_sensitive", language: "en", gold: "no", split: "test", attempt, incumbent: { choice: "no", ms: 1_800 }, laya: laya("no", 0.99) }, "e"),
    ]);
    const [simulation] = simulateGate(repeated, SS, GATE);
    expect(simulation!.calibrationCases).toBe(20);
    expect(simulation!.status).toBe("insufficient_calibration");
    const judged = pointVerdict(simulation!, undefined, SS, { targetAgreement: 0.9, maxRareMiss: 0.1 });
    expect(judged.verdict).toBe("inconclusive");
    expect(judged.reasons[0]).toMatch(/at most 20 cases .* needs 38/);
  });

  it("splits a run that holds one half only a second time", () => {
    const testOnly = many(60, { point: "source_sensitive", language: "de", gold: "no", split: "test", incumbent: { choice: "no", ms: 1_800 }, laya: laya("no", 0.9) }, "x");
    const [simulation] = simulateGate(testOnly, SS, GATE);
    expect(simulation!.nestedSplit).toBe(true);
    expect(simulation!.calibrationCases + simulation!.testCases).toBe(60);
    expect(simulation!.calibrationCases).toBeGreaterThan(0);
    expect(simulation!.testCases).toBeGreaterThan(0);
  });

  it("describes every level on every case, without choosing one", () => {
    const cases = [
      ...many(5, { point: "source_sensitive", language: "de", gold: "yes", split: "test", incumbent: { choice: "yes", ms: 1 }, laya: laya("no", 0.65) }, "a"),
      ...many(5, { point: "source_sensitive", language: "de", gold: "no", split: "calibration", incumbent: { choice: "no", ms: 1 }, laya: laya("no", 0.95) }, "b"),
    ];
    const [curve] = levelCurve(cases, SS);
    const at = (level: number) => curve!.levels.find((point) => point.level === level)!;
    expect(at(0.6)).toMatchObject({ taken: 10, cases: 10 });
    expect(at(0.6).rareMiss).toMatchObject({ hits: 5, n: 5 });
    expect(at(0.7)).toMatchObject({ taken: 5 });
    expect(at(0.7).rareMiss).toMatchObject({ hits: 0, n: 5 });
  });
});

const PROJECTION: ProjectionSettings = { auditRate: 0, timeToFirstTokenMs: 8_200, turnMs: 46_700 };

describe("the projection", () => {
  const cases: BenchResult[] = [
    { caseId: "A", point: "source_sensitive", language: "de", gold: "no", split: "test", attempt: 0, incumbent: { choice: "no", ms: 2_000 }, laya: laya("no", 0.99, 20) },
    { caseId: "B", point: "source_sensitive", language: "de", gold: "no", split: "test", attempt: 0, incumbent: { choice: "no", ms: 1_800 }, laya: laya("no", 0.99, 30) },
    { caseId: "C", point: "source_sensitive", language: "en", gold: "yes", split: "test", attempt: 0, incumbent: { choice: "yes", ms: 1_600 }, laya: laya("yes", 0.6, 25) },
    { caseId: "D", point: "source_sensitive", language: "en", gold: "yes", split: "test", attempt: 0, incumbent: { choice: "yes", ms: 2_200 }, laya: laya("no", 0.99, 25) },
  ];
  const simulation = { model: "m1", nestedSplit: false, takenCaseIds: ["A", "B", "D"] } as unknown as GateSimulation;

  it("saves the incumbent's time less Laya's on what Laya takes, for both orders", () => {
    const [dataset] = projectSavings(cases, simulation, SS, PROJECTION);
    expect(dataset!.mix).toBe("dataset");
    expect(dataset!.coverage).toBe(0.75);
    // A 1980 + B 1770 + D 2175; C is not taken and Laya was the faster one, so it cost nothing concurrently.
    expect(dataset!.concurrent.savedMsPerDecision).toBeCloseTo(5_925 / 4);
    expect(dataset!.concurrent.secondsPer100Turns).toBeCloseTo(148.125);
    expect(dataset!.concurrent.shareOfTimeToFirstToken).toBeCloseTo(1_481.25 / 8_200);
    // Laya first: C pays Laya's 25 ms before its incumbent starts.
    expect(dataset!.layaFirst.savedMsPerDecision).toBeCloseTo(5_900 / 4);
    expect(dataset!.layaFirst.incumbentCallsAvoidedPer100Turns).toBeCloseTo(75);
    expect(dataset!.rareMissesPer100Turns).toBeCloseTo(25);
    expect(dataset!.incumbentMs.source).toBe("measured");
  });

  it("leaves the audited share with the incumbent", () => {
    const [dataset] = projectSavings(cases, simulation, SS, { ...PROJECTION, auditRate: 0.1 });
    expect(dataset!.concurrent.savedMsPerDecision).toBeCloseTo(5_332.5 / 4);
    expect(dataset!.layaFirst.savedMsPerDecision).toBeCloseTo(5_300 / 4);
    expect(dataset!.layaFirst.incumbentCallsAvoidedPer100Turns).toBeCloseTo(67.5);
  });

  it("reweighs the enriched dataset to the rare class's traffic share", () => {
    const prior = projectSavings(cases, simulation, SS, { ...PROJECTION, rareClassPrior: 0.1 }).find((p) => p.mix === "prior")!;
    // Rare cases weigh 0.1 / 0.5, common ones 0.9 / 0.5.
    expect(prior.rareClassPrior).toBe(0.1);
    expect(prior.coverage).toBeCloseTo(0.95);
    expect(prior.concurrent.savedMsPerDecision).toBeCloseTo(7_185 / 4);
    expect(prior.rareMissesPer100Turns).toBeCloseTo(5);
  });

  it("charges the fast lane the full path for small talk Laya sends on", () => {
    const fast: BenchResult[] = [
      { caseId: "E", point: "fast_lane", language: "de", gold: "small_talk", split: "test", attempt: 0, incumbent: { choice: "small_talk", ms: 1_500 }, laya: laya("task", 0.99, 20) },
      { caseId: "F", point: "fast_lane", language: "de", gold: "task", split: "test", attempt: 0, incumbent: { choice: "task", ms: 1_500 }, laya: laya("task", 0.99, 20) },
    ];
    const [dataset] = projectSavings(fast, { model: "m1", nestedSplit: false, takenCaseIds: ["E", "F"] } as unknown as GateSimulation, FL, PROJECTION);
    expect(dataset!.concurrent.savedMsPerDecision).toBeCloseTo((1_480 - 6_720) / 2);
  });

  it("uses the attributed incumbent time when the run did not measure one", () => {
    const unmeasured = cases.map(({ incumbent: _incumbent, ...rest }) => rest);
    const [dataset] = projectSavings(unmeasured, simulation, SS, PROJECTION);
    expect(dataset!.incumbentMs).toEqual({ source: "fallback", p50: SS.incumbentMsFallback });
    expect(dataset!.concurrent.savedMsPerDecision).toBeCloseTo(((1_819 - 20) + (1_819 - 30) + (1_819 - 25)) / 4);
  });
});

describe("the metrics per slice", () => {
  const results: BenchResult[] = [
    { caseId: "s1", point: "source_sensitive", language: "de", gold: "yes", split: "test", attempt: 0, incumbent: { choice: "yes", ms: 1_000, calls: 1, timings: { promptN: 40, cacheN: 490 } }, laya: laya("yes", 0.9, 10) },
    { caseId: "s1", point: "source_sensitive", language: "de", gold: "yes", split: "test", attempt: 1, incumbent: { choice: "no", ms: 3_000, calls: 2 }, laya: laya("yes", 0.9, 30) },
    { caseId: "s2", point: "source_sensitive", language: "de", gold: "yes", split: "test", attempt: 0, incumbent: { choice: "no", ms: 2_000, calls: 1 }, laya: laya("no", 0.8, 20) },
    { caseId: "s3", point: "source_sensitive", language: "de", gold: "no", split: "test", attempt: 0, incumbent: { choice: "no", ms: 1_500, calls: 1 }, laya: laya("no", 0.7, 20) },
    { caseId: "s4", point: "source_sensitive", language: "de", gold: "no", split: "test", attempt: 0, incumbent: { ms: 900, error: "the reply held no answer", calls: 1 }, layaFailure: { ms: 1_500, error: "timeout" } },
    { caseId: "f1", point: "fast_lane", language: "de", gold: "task", split: "test", attempt: 0, gated: true },
  ];

  it("scores each arm against gold and against each other, per answer and language", () => {
    const slices = summarizeBench(results);
    const de = slices.find((slice) => slice.point === "source_sensitive" && slice.language === "de")!;
    expect(de.model).toBe("m1");
    expect(de.cases).toBe(4);
    expect(de.rows).toBe(5);
    expect(de.gold).toEqual({ yes: 3, no: 2 });
    expect(de.answered).toEqual({ laya: 4, incumbent: 4, both: 4 });
    expect(de.failures).toEqual({ laya: 1, incumbent: 1 });
    expect(de.accuracy.laya).toEqual({ hits: 3, n: 4, rate: 0.75 });
    expect(de.accuracy.incumbent).toEqual({ hits: 2, n: 4, rate: 0.5 });
    expect(de.agreement).toEqual({ hits: 3, n: 4, rate: 0.75 });
    expect(de.perClass["yes"]!.layaVsGold.recall).toEqual({ hits: 2, n: 3, rate: 2 / 3 });
    expect(de.perClass["yes"]!.layaVsGold.precision).toEqual({ hits: 2, n: 2, rate: 1 });
    expect(de.perClass["yes"]!.incumbentVsGold.recall).toEqual({ hits: 1, n: 3, rate: 1 / 3 });
    expect(de.perClass["no"]!.layaVsIncumbent.recall).toEqual({ hits: 2, n: 3, rate: 2 / 3 });
    expect(de.baselines.majorityGold).toEqual({ choice: "yes", accuracy: { hits: 3, n: 5, rate: 0.6 } });
    expect(de.baselines.majorityIncumbent).toEqual({ choice: "no", agreement: { hits: 3, n: 4, rate: 0.75 } });
    expect(de.latency.incumbentMs).toMatchObject({ n: 5, p50: 1_500 });
    expect(de.latency.incumbentCallsPerDecision).toBeCloseTo(6 / 5);
    expect(de.latency.timings?.cacheN).toMatchObject({ n: 1, p50: 490 });
    expect(de.incumbentConsistency).toEqual({ cases: 1, flipped: 1 });
    // No English case: the slice is still there, with nothing made up.
    const en = slices.find((slice) => slice.point === "source_sensitive" && slice.language === "en")!;
    expect(en.cases).toBe(0);
    expect(en.accuracy.laya.rate).toBeNull();
    const fast = slices.find((slice) => slice.point === "fast_lane" && slice.language === "all")!;
    expect(fast).toMatchObject({ cases: 1, rows: 0, gatedOut: 1 });
  });

  it("breaks a tie for the majority by the point's option order, never by which case came first", () => {
    const tie = (first: string, second: string): BenchResult[] => [
      { caseId: "t1", point: "source_sensitive", language: "de", gold: first, split: "calibration", attempt: 0, incumbent: { choice: first, ms: 1 } },
      { caseId: "t2", point: "source_sensitive", language: "de", gold: second, split: "calibration", attempt: 0, incumbent: { choice: second, ms: 1 } },
    ];
    for (const results of [tie("no", "yes"), tie("yes", "no")]) {
      const de = summarizeBench(results).find((slice) => slice.language === "de")!;
      expect(de.baselines.majorityGold?.choice).toBe("yes");
      expect(alwaysMajorityResults(results, SS)[0]!.laya!.choice).toBe("yes");
    }
  });
});

describe("the verdict", () => {
  function evenly(yesTop: number, noTop: number, wrongNo: number): BenchResult[] {
    return (["de", "en"] as const).flatMap((language) => [
      ...many(40, { point: "source_sensitive", language, gold: "no", split: "calibration", incumbent: { choice: "no", ms: 1_800 }, laya: laya("no", noTop) }, `${language}-cn`),
      ...many(40, { point: "source_sensitive", language, gold: "yes", split: "calibration", incumbent: { choice: "yes", ms: 1_800 }, laya: laya("yes", yesTop) }, `${language}-cy`),
      ...many(20 - wrongNo, { point: "source_sensitive", language, gold: "no", split: "test", incumbent: { choice: "no", ms: 1_800 }, laya: laya("no", noTop) }, `${language}-tn`),
      ...many(wrongNo, { point: "source_sensitive", language, gold: "no", split: "test", incumbent: { choice: "no", ms: 1_800 }, laya: laya("yes", yesTop) }, `${language}-tw`),
      ...many(20, { point: "source_sensitive", language, gold: "yes", split: "test", incumbent: { choice: "yes", ms: 1_800 }, laya: laya("yes", yesTop) }, `${language}-ty`),
    ]);
  }
  const settings: BenchReportSettings = {
    gate: GATE,
    reference: "incumbent",
    projection: { ...PROJECTION, auditRate: 0.1 },
    verdict: { targetAgreement: 0.9, maxRareMiss: 0.1 },
  };

  it("pays off when what the gate hands Laya is right and saves time", () => {
    const report = buildBenchReport(evenly(0.95, 0.95, 0), settings);
    const point = report.points.find((candidate) => candidate.point === "source_sensitive")!;
    expect(point.verdict).toBe("pays_off");
    expect(report.exitCode).toBe(0);
    expect(point.projections.find((p) => p.mix === "prior")!.concurrent.secondsPer100Turns).toBeGreaterThan(0);
  });

  it("is unsafe when, on held-out cases, what it would take disagrees with the incumbent too often", () => {
    const report = buildBenchReport(evenly(0.95, 0.95, 8), settings);
    const all = report.points[0]!.simulation.test.find((slice) => slice.language === "all")!;
    expect(all.wrongVsReference).toMatchObject({ hits: 16, n: 80 });
    expect(all.regressions).toMatchObject({ hits: 16, n: 80 });
    expect(all.improvements).toMatchObject({ hits: 0, n: 80 });
    expect(report.points[0]!.verdict).toBe("unsafe");
    expect(report.points[0]!.reasons[0]).toMatch(/20\.0% of the 80 held-out cases Laya would take disagree with the incumbent/);
    expect(report.exitCode).toBe(1);
  });

  it("is not unsafe for repeating the incumbent's own errors", () => {
    // Gold says "yes" on some "no" test cases; the incumbent says "no", and so does Laya.
    const shared = evenly(0.95, 0.95, 0).map((result, index) => (result.split === "test" && result.gold === "no" && index % 5 < 2 ? { ...result, gold: "yes" } : result));
    const report = buildBenchReport(shared, { ...settings, verdict: { targetAgreement: 0.9, maxRareMiss: 1 } });
    const all = report.points[0]!.simulation.test.find((slice) => slice.language === "all")!;
    expect(all.wrongVsGold.hits).toBeGreaterThan(8);
    expect(all.incumbentWrongVsGold.hits).toBe(all.wrongVsGold.hits);
    expect(all.regressions.hits).toBe(0);
    expect(report.points[0]!.verdict).toBe("pays_off");
  });

  it("says nothing without a scored case in each language", () => {
    const germanOnly = evenly(0.95, 0.95, 0).filter((result) => result.language === "de");
    const report = buildBenchReport(germanOnly, settings);
    expect(report.points[0]!.verdict).toBe("inconclusive");
    expect(report.points[0]!.reasons).toContain("no English test case has a Laya answer");
    expect(report.exitCode).toBe(2);
  });

  it("finds no payoff when enough cases qualify nothing", () => {
    const unsure = evenly(0.95, 0.95, 0).map((result) => ({ ...result, incumbent: { choice: result.laya!.choice === "yes" ? "no" : "yes", ms: 1_800 } }));
    expect(buildBenchReport(unsure, settings).points[0]!.verdict).toBe("no_payoff");
  });

  it("takes the per-point overrides of frequency and prior", () => {
    const base = buildBenchReport(evenly(0.95, 0.95, 0), settings).points[0]!.projections[1]!;
    const halved = buildBenchReport(evenly(0.95, 0.95, 0), { ...settings, overrides: { source_sensitive: { frequencyPerTurn: 0.5, rareClassPrior: 0.3 } } }).points[0]!.projections[1]!;
    expect(halved.frequencyPerTurn).toBe(0.5);
    expect(halved.rareClassPrior).toBe(0.3);
    expect(base.rareClassPrior).toBeCloseTo(1 / 27);
  });

  it("exits 1 on an unsafe point, 2 when nothing could be judged, else 0", () => {
    expect(benchExitCode([])).toBe(2);
    expect(benchExitCode(["inconclusive", "inconclusive"])).toBe(2);
    expect(benchExitCode(["pays_off", "unsafe"])).toBe(1);
    expect(benchExitCode(["no_payoff", "inconclusive"])).toBe(0);
  });

  it("renders the verdicts, both languages and the baseline", () => {
    const report = buildBenchReport(evenly(0.95, 0.95, 0), settings);
    const markdown = renderBenchMarkdown(report, ["Run x."]);
    expect(markdown).toContain("## Verdicts");
    expect(markdown).toContain("| source_sensitive | m1 | **pays_off** |");
    expect(markdown).toMatch(/\n\| de \| 120 \|/);
    expect(markdown).toMatch(/\n\| en \| 120 \|/);
    expect(markdown).toMatch(/Always-majority Laya \(always-(yes|no)\)/);
    expect(markdown).toContain("Run x.");
    expect(markdown).toContain("against the incumbent;");
    expect(renderBenchMarkdown({ ...report, settings: { ...report.settings, reference: "gold" } })).toContain("against the gold labels;");
    expect(markdown).toContain('- calibration de "no": 40/40 agree, recall guard: Laya said "no" on 0 of 40 "yes" cases → qualified from');
    expect(markdown).toMatch(/\| share of time to first token \| share of turn \|/);
  });
});

describe("the rows", () => {
  it("are decision-ledger rows the report reads and the fine-tune export takes, marked as the bench's", async () => {
    const { buildDecisionReport } = await import("../scripts/decisions-report.js");
    const { buildTrainingItems } = await import("../scripts/decisions-export.js");
    const both: BenchResult = { caseId: "c1", point: "source_sensitive", language: "de", gateLanguage: "de", gold: "yes", split: "calibration", attempt: 0, incumbent: { choice: "yes", ms: 1_234, timings: { promptN: 12 }, calls: 1, model: "qwen" }, laya: laya("no", 0.7, 18) };
    const layaOnly: BenchResult = { caseId: "c2", point: "source_sensitive", language: "en", gold: "no", split: "test", attempt: 0, laya: laya("no", 0.9, 18) };
    const rowA = benchLedgerRow(both, { message: "Was kostet ein Deutschlandticket?" }, "2026-09-26T00:00:00.000Z");
    const rowB = benchLedgerRow(layaOnly, { message: "What is recursion?" }, "2026-09-26T00:00:00.000Z");
    expect(rowA).toMatchObject({ mode: "bench", sessionId: "bench", decidedBy: "incumbent", language: "de", gold: "yes", caseId: "c1", incumbent: { choice: "yes", ms: 1_234 }, laya: { choice: "no", model: "m1" }, incumbentTimings: { promptN: 12 }, incumbentModel: "qwen" });
    expect(rowB.incumbent).toBeUndefined();
    const [report] = buildDecisionReport([rowA], 0.9, 30);
    expect(report).toMatchObject({ point: "source_sensitive", model: "m1", bothAnswered: 1, agreement: 0 });
    const items = buildTrainingItems([rowA, rowB]);
    expect(items).toHaveLength(1);
    expect(items[0]!.gold["source_sensitive"]!.label).toBe("A");
  });

  it("reads llama-server's timings in either spelling, and no made-up zeros", () => {
    expect(readTimings({ prompt_n: 40, cache_n: 480, prompt_ms: 51.5, predicted_n: 6, predicted_ms: 101 })).toEqual({ promptN: 40, cacheN: 480, promptMs: 51.5, predictedN: 6, predictedMs: 101 });
    expect(readTimings({ promptN: 3, cacheN: -1 })).toEqual({ promptN: 3 });
    expect(readTimings({ cache_n: -1 })).toBeUndefined();
    expect(readTimings(undefined)).toBeUndefined();
    expect(readTimings([1, 2])).toBeUndefined();
  });
});

// ── The datasets ────────────────────────────────────────────────────────────────────────────────────

function loadDataset(point: "fast_lane" | "source_sensitive"): DecisionBenchCase[] {
  return parseDecisionCases(readFileSync(join(REPO, "eval", "decisions", `${point}.example.jsonl`), "utf8"));
}

function loadNegationPairs(): DecisionBenchCase[] {
  return parseDecisionCases(readFileSync(join(REPO, "eval", "decisions", "negation.example.jsonl"), "utf8"));
}

describe("negation pairs and option order", () => {
  /** One pair: two cases of source_sensitive, gold `goldA`/`goldB`, answered by Laya and the incumbent as given. */
  function pair(id: string, language: string, goldA: string, goldB: string, laya: [string, string], incumbent: [string, string]): BenchResult[] {
    return [0, 1].map((i) => ({
      caseId: `${id}${i === 0 ? "a" : "b"}`, point: "source_sensitive", language, gold: i === 0 ? goldA : goldB, split: "test" as const, attempt: 0, pair: id,
      laya: { choice: laya[i]!, top: 0.9, ms: 20, model: "m1", probabilities: { [laya[i]!]: 0.9 } },
      incumbent: { choice: incumbent[i]!, ms: 1_000 },
    }));
  }

  it("counts, per pair the negation flips, whether each arm read it — and per control pair, whether it kept its answer", () => {
    const results = [
      // Laya reads past the negation twice and reads it once; the incumbent reads it every time.
      ...pair("p1", "de", "no", "yes", ["no", "no"], ["no", "yes"]),
      ...pair("p2", "de", "no", "yes", ["yes", "yes"], ["no", "yes"]),
      ...pair("p3", "en", "no", "yes", ["no", "yes"], ["no", "yes"]),
      // Controls: the negation changes nothing; Laya flips on one of them.
      ...pair("c1", "de", "yes", "yes", ["yes", "no"], ["yes", "yes"]),
      ...pair("c2", "en", "no", "no", ["no", "no"], ["no", "no"]),
    ];
    const all = negationPairs(results).find((slice) => slice.language === "all")!;
    expect(all).toMatchObject({ point: "source_sensitive", model: "m1", flipPairs: 3, controlPairs: 2 });
    expect(all.layaSameAnswer).toMatchObject({ hits: 2, n: 3 });
    expect(all.layaBothRight).toMatchObject({ hits: 1, n: 3 });
    expect(all.incumbentBothRight).toMatchObject({ hits: 3, n: 3 });
    expect(all.incumbentSameAnswer).toMatchObject({ hits: 0, n: 3 });
    expect(all.layaKept).toMatchObject({ hits: 1, n: 2 });
    expect(all.incumbentKept).toMatchObject({ hits: 2, n: 2 });
    expect(negationPairs(results).find((slice) => slice.language === "de")!.flipPairs).toBe(2);
  });

  it("keeps the pairs out of the slices, the gate replay and the verdict", () => {
    const plain = many(40, { point: "source_sensitive", language: "de", gold: "no", split: "calibration", incumbent: { choice: "no", ms: 1_800 }, laya: laya("no", 0.97) }, "x");
    const withPairs = [...plain, ...pair("p1", "de", "no", "yes", ["no", "no"], ["no", "yes"])];
    const settings: BenchReportSettings = { gate: GATE, reference: "incumbent", projection: PROJECTION, verdict: { targetAgreement: 0.9, maxRareMiss: 0.1 } };
    const without = buildBenchReport(plain, settings);
    const report = buildBenchReport(withPairs, settings);
    expect(report.slices).toEqual(without.slices);
    expect(report.points.map((point) => point.simulation)).toEqual(without.points.map((point) => point.simulation));
    expect(report.negation.find((slice) => slice.language === "all")!.flipPairs).toBe(1);
    expect(without.negation).toEqual([]);
    expect(renderBenchMarkdown(report)).toContain("## Negation pairs");
  });

  it("reports how often Laya's choice changed with the order of the options, per point and language", () => {
    const swapped = (id: string, language: string, choice: string, again: string): BenchResult => ({
      caseId: id, point: "fast_lane", language, gold: "task", split: "test", attempt: 0,
      laya: { choice, top: 0.8, ms: 20, model: "m1", probabilities: { [choice]: 0.8 } },
      layaSwapped: { choice: again, top: 0.7, ms: 20, model: "m1", probabilities: { [again]: 0.7, [choice]: again === choice ? 0.7 : 0.3 } },
    });
    const results = [swapped("a", "de", "task", "small_talk"), swapped("b", "de", "task", "task"), swapped("c", "en", "task", "task"), swapped("d", "en", "small_talk", "small_talk")];
    const slices = orderSwapFlips(results);
    expect(slices.find((slice) => slice.language === "all")!.flips).toMatchObject({ hits: 1, n: 4, rate: 0.25 });
    expect(slices.find((slice) => slice.language === "de")!.flips).toMatchObject({ hits: 1, n: 2 });
    expect(slices.find((slice) => slice.language === "all")!.meanTopShift).toBeCloseTo((0.5 + 0.1 + 0.1 + 0.1) / 4, 6);
    expect(Object.keys(reversedOptions({ small_talk: "s", task: "t" }))).toEqual(["task", "small_talk"]);
  });

  it("lints a pair that is not two cases of one point and language", () => {
    const base: DecisionBenchCase = { id: "a", point: "fast_lane", language: "de", state: { message: "hi" }, gold: "small_talk", pair: "p" };
    expect(lintDecisionCases([base, { ...base, id: "b" }])).toEqual([]);
    expect(lintDecisionCases([base])).toEqual(["pair p has 1 cases, not 2"]);
    expect(lintDecisionCases([base, { ...base, id: "b", language: "en" }])).toEqual(["pair p mixes points or languages"]);
  });
});

describe("the case files", () => {
  it("parse JSONL with comment lines, and name the line that is not JSON", () => {
    expect(parseDecisionCases('// header\n\n{"id":"a","point":"fast_lane","language":"de","state":{"message":"hi"},"gold":"small_talk"}\n')).toHaveLength(1);
    expect(() => parseDecisionCases('// header\n{"id":"a"}\n{not json\n')).toThrow(/line 3/);
  });

  it("lint away every case that would measure nothing", () => {
    const good: DecisionBenchCase = { id: "a", point: "fast_lane", language: "de", state: { message: "hi" }, gold: "small_talk", tags: ["greeting"] };
    expect(lintDecisionCases([good], { requireGold: true })).toEqual([]);
    const problems = lintDecisionCases([
      good,
      { ...good },
      { ...good, id: "b", gold: "yes" },
      { ...good, id: "c", point: "goal_met" },
      { ...good, id: "d", language: "fr" },
      { ...good, id: "e", state: { message: " " } },
      { ...good, id: "f", gold: undefined },
      { ...good, id: "g", tags: ["x", 3 as unknown as string] },
    ], { requireGold: true });
    expect(problems).toEqual([
      "duplicate case id: a",
      '[b] gold "yes" is not an option of fast_lane',
      '[c] point "goal_met" has no bench incumbent',
      "[c] gold \"small_talk\" is not an option of goal_met",
      '[d] language must be "de" or "en"',
      "[e] state.message is empty",
      "[f] has no gold label",
      "[g] tags must be a list of strings",
    ]);
  });

  for (const point of ["fast_lane", "source_sensitive"] as const) {
    describe(point, () => {
      const cases = loadDataset(point);
      const scored = cases.filter((benchCase) => !benchCase.tags?.includes("gated"));
      const rare = BENCH_PROFILES[point].rareClass;

      it("is well formed: unique ids, gold an option of the point, one point", () => {
        expect(lintDecisionCases(cases, { requireGold: true })).toEqual([]);
        expect(new Set(cases.map((benchCase) => benchCase.point))).toEqual(new Set([point]));
      });

      it("has at least 120 scored cases, mostly German, enriched with the rare class in both languages", () => {
        expect(scored.length).toBeGreaterThanOrEqual(120);
        const [profile] = profileDataset(scored);
        expect(profile!.germanShare).toBeGreaterThanOrEqual(0.55);
        expect(profile!.rareShare).toBeGreaterThanOrEqual(0.35);
        for (const language of ["de", "en"]) {
          expect(scored.filter((benchCase) => benchCase.language === language && benchCase.gold === rare).length, `${language} ${rare}`).toBeGreaterThanOrEqual(25);
        }
      });

      it("covers the near-misses in both languages", () => {
        const kinds = point === "fast_lane"
          ? ["small-talk-plus-request", "brand-in-passing", "do-not-look-up", "own-text", "casual-fact", "typo", "one-word", "follow-up", "about-user"]
          : ["brand-in-passing", "do-not-look-up", "own-text", "casual-fact", "typo", "one-word", "follow-up", "lookup-verb"];
        for (const language of ["de", "en"]) {
          for (const kind of kinds) {
            expect(scored.some((benchCase) => benchCase.language === language && benchCase.tags?.includes(kind)), `${language} ${kind}`).toBe(true);
          }
        }
      });

      it("splits into halves that both hold the rare class", () => {
        const calibration = scored.filter((benchCase) => benchSplit(benchCase.id) === "calibration");
        expect(calibration.length / scored.length).toBeGreaterThan(0.35);
        expect(calibration.length / scored.length).toBeLessThan(0.65);
        expect(calibration.filter((benchCase) => benchCase.gold === rare).length).toBeGreaterThanOrEqual(20);
        expect(scored.filter((benchCase) => benchSplit(benchCase.id) === "test" && benchCase.gold === rare).length).toBeGreaterThanOrEqual(20);
      });
    });
  }

  it("fast_lane: the front desk refuses exactly the cases tagged gated", async () => {
    const { classifyFrontDesk } = await import("../agent/receptionist.js");
    for (const benchCase of loadDataset("fast_lane")) {
      const lets = classifyFrontDesk(caseMessage(benchCase), { alwaysEscalateTerms: [], confidenceAttempt: false }).fastLane;
      expect(lets, benchCase.id).toBe(!benchCase.tags?.includes("gated"));
    }
  });

  it("source_sensitive: every message fits the 2,000 characters a turn hands the judge", () => {
    for (const benchCase of loadDataset("source_sensitive")) expect(caseMessage(benchCase).length, benchCase.id).toBeLessThanOrEqual(2_000);
  });

  it("no id is used in both files", () => {
    const ids = [...loadDataset("fast_lane"), ...loadDataset("source_sensitive"), ...loadNegationPairs()].map((benchCase) => benchCase.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  describe("negation pairs", () => {
    const cases = loadNegationPairs();
    const pairs = [...new Set(cases.map((benchCase) => benchCase.pair!))].map((pair) => cases.filter((benchCase) => benchCase.pair === pair));

    it("is well formed: every case in a pair of two, of one point and language, gold an option of the point", () => {
      expect(lintDecisionCases(cases, { requireGold: true })).toEqual([]);
      expect(cases.every((benchCase) => typeof benchCase.pair === "string")).toBe(true);
      expect(pairs.every((members) => members.length === 2)).toBe(true);
    });

    it("has pairs the negation flips and pairs it does not, for both points in both languages", () => {
      for (const point of ["fast_lane", "source_sensitive"]) {
        for (const language of ["de", "en"]) {
          const mine = pairs.filter(([a]) => a!.point === point && a!.language === language);
          const flips = mine.filter(([a, b]) => a!.gold !== b!.gold);
          const controls = mine.filter(([a, b]) => a!.gold === b!.gold);
          expect(flips.length, `${point} ${language} flip pairs`).toBeGreaterThanOrEqual(3);
          expect(controls.length, `${point} ${language} control pairs`).toBeGreaterThanOrEqual(2);
          // The tags say which kind a pair is, and must agree with the labels.
          for (const [a, b] of flips) expect([a!.tags, b!.tags]).toEqual([["negation-pair", "flip"], ["negation-pair", "flip"]]);
          for (const [a, b] of controls) expect([a!.tags, b!.tags]).toEqual([["negation-pair", "control"], ["negation-pair", "control"]]);
        }
      }
    });

    it("reaches the fast lane's model: the front desk refuses none of its cases", async () => {
      const { classifyFrontDesk } = await import("../agent/receptionist.js");
      for (const benchCase of cases.filter((candidate) => candidate.point === "fast_lane")) {
        expect(classifyFrontDesk(caseMessage(benchCase), { alwaysEscalateTerms: [], confidenceAttempt: false }).fastLane, benchCase.id).toBe(true);
      }
    });
  });

  it("a case keeps its half whatever else is in the file", () => {
    expect(benchSplit("ss-de-001")).toBe(benchSplit("ss-de-001"));
    const ids = Array.from({ length: 200 }, (_, i) => `id-${i}`);
    const plain = ids.map((id) => benchSplit(id));
    const salted = ids.map((id) => benchSplit(id, "nested:"));
    expect(plain.filter((half) => half === "calibration").length).toBeGreaterThan(70);
    expect(plain.filter((half) => half === "calibration").length).toBeLessThan(130);
    expect(salted).not.toEqual(plain);
  });
});

// ── decisions:bootstrap and decisions:export ────────────────────────────────────────────────────────

const require = createRequire(import.meta.url);
const TSX_CLI = require.resolve("tsx/cli");

function runScript(script: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [TSX_CLI, join(CORE, "src", "scripts", script), ...args], { cwd, env, encoding: "utf8", timeout: 90_000 });
}

/** A child's environment with nothing that points it at a real backend or a real config. */
function isolatedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, SAI_PRIMARY_MODEL_URL: "http://127.0.0.1:9/v1", SAI_AUDIT_LOG: join(tempDir, "child-audit.jsonl"), ...extra };
  delete env["SAI_CONFIG_PATH"];
  delete env["SAI_DECISIONS_LEDGER"];
  delete env["SAI_LAYA_URL"];
  return env;
}

describe("decisions:bootstrap and decisions:export", () => {
  it("bootstrap writes its labels where export reads them, unless the ledger is configured elsewhere", async () => {
    const { bootstrapLedgerPath } = await import("../scripts/decisions-bootstrap.js");
    delete process.env["SAI_DECISIONS_LEDGER"];
    expect(bootstrapLedgerPath()).toBe(join(REPO, ".starlingai", "decisions", "bootstrap-ledger.jsonl"));
    process.env["SAI_DECISIONS_LEDGER"] = join(tempDir, "elsewhere", "ledger.jsonl");
    try {
      expect(bootstrapLedgerPath()).toBe(join(tempDir, "elsewhere", "bootstrap-ledger.jsonl"));
    } finally {
      delete process.env["SAI_DECISIONS_LEDGER"];
    }
  });

  it("bootstrap refuses to run where the config loader would read a stub, before any call", () => {
    const corpus = join(tempDir, "empty-corpus.jsonl");
    writeFileSync(corpus, "", "utf8");
    const run = runScript("decisions-bootstrap.ts", ["--corpus", corpus, "--out", join(tempDir, "bootstrap-out", "bootstrap-ledger.jsonl")], CORE, isolatedEnv());
    expect(run.status, run.stderr).toBe(2);
    expect(run.stderr).toMatch(/run from the repository root/);
    expect(existsSync(join(tempDir, "bootstrap-out"))).toBe(false);
  });

  it("export turns bootstrap labels into training data when no real ledger exists yet", async () => {
    const { bootstrapRow } = await import("../scripts/decisions-bootstrap.js");
    const dir = join(tempDir, "export-only-bootstrap");
    mkdirSync(join(dir, "decisions"), { recursive: true });
    writeFileSync(join(dir, "decisions", "bootstrap-ledger.jsonl"), [
      JSON.stringify(bootstrapRow("source_sensitive", "Was kostet ein Deutschlandticket?", "yes", 900)),
      JSON.stringify(bootstrapRow("fast_lane", "hallo", "small_talk", 700)),
    ].join("\n") + "\n", "utf8");
    const out = join(dir, "data", "ledger-export.jsonl");
    const run = runScript("decisions-export.ts", ["--ledger", join(dir, "decisions", "ledger.jsonl"), "--out", out], CORE, isolatedEnv());
    expect(run.status, run.stderr).toBe(0);
    expect(existsSync(out), run.stdout).toBe(true);
    const items = readFileSync(out, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { point: string });
    expect(items.map((item) => item.point).sort()).toEqual(["fast_lane", "source_sensitive"]);
  });
});
