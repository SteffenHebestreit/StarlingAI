/**
 * The adaptive gate's statistics, replayed on seeded streams of cases (adoption plan 2026-09-26, C10).
 *
 * The gate re-tests a key after every new case, for as long as the key lives. Until 2026-09-26 it took the lowest of
 * nine levels whose lower bound passed, in any order: nine tests at once, repeated after each case, so a key whose
 * true agreement sits just under the target opened on a lucky run. These streams measure that against the rule that
 * replaced it — the fixed sequence from the highest level down, levels too thin to test skipped, the confirmation
 * without the newest cases, the drift window — on the gate itself (decisions/gate.ts), not on a copy of it. The old
 * rule is reproduced here as the baseline, from its last version (git 9533fd9).
 *
 * Every stream: 2,000 cases, Laya's confidence drawn uniformly from 0.5 to 1, agreement with the incumbent drawn at a
 * fixed true rate. Target 0.9, 30 cases at least: the defaults.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { GATE_LEVELS, levelSampleFloor, qualifiedLevel, recordAgreementSample, resetGateForTests, wilsonLowerBound } from "../decisions/gate.js";

const SETTINGS = { targetAgreement: 0.9, minSamples: 30 };
const STREAMS = 500;
const CASES = 2_000;

/** A deterministic PRNG, so a failure names the same stream every run. */
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

/**
 * The rule until 2026-09-26, on running per-level counts: the lowest level, scanning upwards, whose cases number at
 * least minSamples and whose Wilson lower bound reaches the target; once too few remain, none.
 */
class OldRule {
  private readonly n = GATE_LEVELS.map(() => 0);
  private readonly agree = GATE_LEVELS.map(() => 0);

  add(top: number, agree: boolean): void {
    for (let j = 0; j < GATE_LEVELS.length && top >= GATE_LEVELS[j]!; j += 1) {
      this.n[j]! += 1;
      if (agree) this.agree[j]! += 1;
    }
  }

  level(): number | null {
    for (let j = 0; j < GATE_LEVELS.length; j += 1) {
      if (this.n[j]! < SETTINGS.minSamples) break;
      if (wilsonLowerBound(this.agree[j]!, this.n[j]!) < SETTINGS.targetAgreement) continue;
      return GATE_LEVELS[j]!;
    }
    return null;
  }
}

interface StreamTrace {
  /** Per case (1-based index - 1): was the key open after it, under the gate and under the old rule? */
  gate: boolean[];
  old: boolean[];
}

/** One stream through the real gate and the old rule, both asked after every case. */
function runStream(seed: number, agreement: (index: number) => number): StreamTrace {
  const random = prng(seed);
  const old = new OldRule();
  const trace: StreamTrace = { gate: [], old: [] };
  resetGateForTests();
  for (let i = 0; i < CASES; i += 1) {
    const top = 0.5 + 0.5 * random();
    const agree = random() < agreement(i);
    recordAgreementSample("source_sensitive", "de", "yes", top, agree, "sim");
    old.add(top, agree);
    trace.gate.push(qualifiedLevel("source_sensitive", "de", "yes", SETTINGS, "sim") !== null);
    trace.old.push(old.level() !== null);
  }
  return trace;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], share: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))]!;
}

beforeEach(() => resetGateForTests());

describe("the gate on seeded streams", () => {
  it("rarely opens a key whose true agreement is just under the target: 0.87 against 0.9", () => {
    let gateOpened = 0;
    let oldOpened = 0;
    for (let s = 0; s < STREAMS; s += 1) {
      const trace = runStream(1_000 + s, () => 0.87);
      if (trace.gate.some(Boolean)) gateOpened += 1;
      if (trace.old.some(Boolean)) oldOpened += 1;
    }
    const gateRate = gateOpened / STREAMS;
    const oldRate = oldOpened / STREAMS;
    // The baseline this replaces: nine levels tested at once, after every case (51 of these 500 streams; the gate: 6).
    expect(oldRate, `old rule opened ${oldOpened} of ${STREAMS}`).toBeGreaterThan(0.07);
    expect(gateRate, `the gate opened ${gateOpened} of ${STREAMS} (old rule ${oldOpened})`).toBeLessThanOrEqual(0.05);
  }, 120_000);

  it("opens a key whose true agreement is 0.96 at most 1.3 times later than the old rule did", () => {
    const gateFirst: number[] = [];
    const oldFirst: number[] = [];
    for (let s = 0; s < STREAMS; s += 1) {
      const trace = runStream(5_000 + s, () => 0.96);
      const g = trace.gate.indexOf(true);
      const o = trace.old.indexOf(true);
      // Never opened: counted at the end of the stream, the latest it could have been.
      gateFirst.push(g < 0 ? CASES : g + 1);
      oldFirst.push(o < 0 ? CASES : o + 1);
    }
    expect(gateFirst.filter((first) => first >= CASES).length, "streams the gate never opened").toBeLessThanOrEqual(STREAMS * 0.01);
    // The median moves in the Wilson bound's steps (35 flawless cases, 53 with one miss, 69, 84 ...), so the mean is
    // checked too: it does not jump from one step to the next with the seeds.
    const gateMedian = median(gateFirst);
    const oldMedian = median(oldFirst);
    expect(gateMedian, `median cases to open: gate ${gateMedian}, old rule ${oldMedian}`).toBeLessThanOrEqual(1.3 * oldMedian);
    const gateMean = mean(gateFirst);
    const oldMean = mean(oldFirst);
    expect(gateMean, `mean cases to open: gate ${gateMean.toFixed(1)}, old rule ${oldMean.toFixed(1)}`).toBeLessThanOrEqual(1.3 * oldMean);
  }, 120_000);

  it("closes a key within 150 cases once its agreement drifts from 0.96 to 0.8", () => {
    const DRIFT_AT = 1_000;
    const gateLag: number[] = [];
    const oldLag: number[] = [];
    for (let s = 0; s < STREAMS; s += 1) {
      const trace = runStream(9_000 + s, (i) => (i < DRIFT_AT ? 0.96 : 0.8));
      // Only a key open when the drift began can close on it.
      if (trace.gate[DRIFT_AT - 1]) {
        const closed = trace.gate.indexOf(false, DRIFT_AT);
        gateLag.push(closed < 0 ? CASES : closed + 1 - DRIFT_AT);
      }
      if (trace.old[DRIFT_AT - 1]) {
        const closed = trace.old.indexOf(false, DRIFT_AT);
        oldLag.push(closed < 0 ? CASES : closed + 1 - DRIFT_AT);
      }
    }
    expect(gateLag.length, "streams open when the drift began").toBeGreaterThan(STREAMS * 0.9);
    // A key open at a high level sees a drift through fewer of its cases: the few stragglers are those.
    expect(percentile(gateLag, 0.95), `gate: median ${median(gateLag)}, 95th percentile ${percentile(gateLag, 0.95)}`).toBeLessThanOrEqual(150);
    expect(median(gateLag)).toBeLessThanOrEqual(100);
    // The old rule waited for the drift to sink the bound over every case it kept.
    expect(median(oldLag), `old rule: median ${median(oldLag)}`).toBeGreaterThan(150);
  }, 120_000);
});

describe("the fixed sequence", () => {
  it("skips a level too thin to test instead of failing it, and does not let it close the levels below", () => {
    // 600 cases at 0.7 (3 disagree), and among them 86 at 0.99 of which every other one disagrees: the levels above
    // 0.7 hold 86, above minSamples but far below the cases a level needs before its failure means anything.
    let thin = 0;
    let thinAgree = 0;
    for (let i = 0; i < 600; i += 1) {
      recordAgreementSample("source_sensitive", "de", "yes", 0.7, i % 200 !== 0, "thin");
      if (i % 7 === 3) {
        thin += 1;
        if (thin % 2 === 0) thinAgree += 1;
        recordAgreementSample("source_sensitive", "de", "yes", 0.99, thin % 2 === 0, "thin");
      }
    }
    expect(thin).toBeGreaterThanOrEqual(SETTINGS.minSamples);
    expect(wilsonLowerBound(thinAgree, thin), "the thin level fails on its own").toBeLessThan(0.9);
    expect(qualifiedLevel("source_sensitive", "de", "yes", SETTINGS, "thin")).toBe(0.5);
    expect(thin, "the thin levels hold fewer than a tested level needs").toBeLessThan(levelSampleFloor(SETTINGS));
    expect(levelSampleFloor(SETTINGS)).toBe(200);
  });

  it("stops at the first level that fails, from the top: a lower level that passes does not reopen it", () => {
    // 250 cases at 0.99 with 30 disagreements fail on their own; 2,000 at 0.55 that agree would carry level 0.5 past
    // the bound. Scanning upwards took 0.5 — and with it the failing confident answers.
    for (let i = 0; i < 250; i += 1) recordAgreementSample("source_sensitive", "de", "yes", 0.99, i % 25 >= 3, "seq");
    for (let i = 0; i < 1_700; i += 1) recordAgreementSample("source_sensitive", "de", "yes", 0.55, true, "seq");
    const old = new OldRule();
    for (let i = 0; i < 250; i += 1) old.add(0.99, i % 25 >= 3);
    for (let i = 0; i < 1_700; i += 1) old.add(0.55, true);
    expect(old.level(), "the old rule takes the lowest level that passes").toBe(0.5);
    expect(qualifiedLevel("source_sensitive", "de", "yes", SETTINGS, "seq")).toBeNull();
  });
});

describe("the confirmation and the drift window", () => {
  it("opens at the higher of the two levels: one the newest cases alone carried is not taken", () => {
    // 25 unsure cases (0.87) of which 22 disagree, 300 sure ones (0.95) that agree, then 3 unsure ones that agree.
    // With all of them level 0.85 passes (306 of 328: 0.9005) and the sequence runs down to 0.5; without the newest
    // three it fails (303 of 325: 0.8996) and stops at 0.9. The unsure answers passed on three cases of luck.
    for (let i = 0; i < 25; i += 1) recordAgreementSample("source_sensitive", "de", "yes", 0.87, i >= 22, "confirm");
    for (let i = 0; i < 300; i += 1) recordAgreementSample("source_sensitive", "de", "yes", 0.95, true, "confirm");
    for (let i = 0; i < 3; i += 1) recordAgreementSample("source_sensitive", "de", "yes", 0.87, true, "confirm");
    expect(wilsonLowerBound(306, 328)).toBeGreaterThanOrEqual(SETTINGS.targetAgreement);
    expect(wilsonLowerBound(303, 325)).toBeLessThan(SETTINGS.targetAgreement);
    expect(qualifiedLevel("source_sensitive", "de", "yes", SETTINGS, "confirm")).toBe(0.9);
  });

  it("keeps a drifted key closed until its newest cases reach the target itself, not just the drift floor", () => {
    const record = (agree: boolean) => recordAgreementSample("source_sensitive", "de", "yes", 0.99, agree, "hysteresis");
    const level = () => qualifiedLevel("source_sensitive", "de", "yes", SETTINGS, "hysteresis");
    for (let i = 0; i < 400; i += 1) record(true);
    expect(level(), "400 flawless cases").toBe(0.5);
    // 100 cases at 0.8: the newest window sinks below the target minus the tolerance (0.87), and the key closes,
    // although every case it kept together still passes the bound.
    for (let i = 0; i < 100; i += 1) record(i % 5 !== 0);
    expect(level(), "drifted to 0.8").toBeNull();
    // 100 at 0.88: above the drift floor, below the target. Right after a window below the floor, that is not enough.
    for (let i = 0; i < 100; i += 1) record(i % 25 >= 3);
    expect(level(), "recovered to 0.88 only").toBeNull();
    // Each agreeing case now pushes out one of the window's first disagreements: 89 of 100, then 90 — the target.
    record(true);
    expect(level(), "89 of the newest 100").toBeNull();
    record(true);
    expect(level(), "90 of the newest 100").toBe(0.5);
  });
});
