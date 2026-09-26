/**
 * decisions:readout — the arithmetic that says whether the incumbent read by its logits answers as the parsed
 * incumbent does: the cases it runs, what a readout call is scored as, agreement, calibration before and after a
 * held-out temperature fit, order flips, the verdict and the report. Pure logic, and askReadout against a recorded
 * provider — no model is called.
 */
import { describe, expect, it } from "vitest";

import {
  buildReadoutReport,
  calibrationBlock,
  casesFromBootstrap,
  casesFromFixtures,
  pointVerdict,
  readoutArm,
  renderReadoutMarkdown,
  scoreReadoutSlice,
  selectCases,
  suggestedTemperatures,
  swappedOrder,
  type ReadoutBenchCase,
  type ReadoutBenchResult,
} from "../agent/decisions-readout.js";
import { benchSplit, type DecisionBenchCase } from "../agent/decisions-bench.js";
import type { LedgerRow } from "../decisions/ledger.js";
import { applyTemperature, askReadout } from "../decisions/logit-readout.js";
import { SOURCE_SENSITIVE } from "../decisions/points.js";
import type { CompletionCallOptions, LLMMessage, LLMResponse } from "../providers/lmstudio.js";

// ── Cases ────────────────────────────────────────────────────────────────────────────────────────

const fixture = (id: string, point: string, language: string, message: string, gold?: string): DecisionBenchCase => ({
  id, point, language, state: { message }, ...(gold ? { gold } : {}),
});

const bootRow = (point: string, language: "de" | "en" | "other", message: string): LedgerRow => ({
  ts: "2026-09-25T10:00:00Z", point, language, state: { message }, mode: "bootstrap", incumbent: { choice: "no", ms: 900 }, decidedBy: "incumbent", sessionId: "bootstrap",
});

describe("the cases", () => {
  it("takes the hand-labelled cases of the points it can run, with their gold", () => {
    const cases = casesFromFixtures([fixture("ss-1", "source_sensitive", "de", "Was kostet X?", "yes"), fixture("g-1", "goal_met", "en", "x")]);
    expect(cases).toEqual([{ id: "ss-1", point: "source_sensitive", language: "de", state: { message: "Was kostet X?" }, gold: "yes", source: "fixture" }]);
  });

  it("gives a bootstrap message an id of its own that does not move between runs, and drops its recorded label", () => {
    const [one] = casesFromBootstrap([bootRow("source_sensitive", "en", "What is a hash map?")]);
    const [again] = casesFromBootstrap([bootRow("source_sensitive", "en", "What is a hash map?")]);
    expect(one!.id).toMatch(/^boot-source_sensitive-[0-9a-f]{12}$/);
    expect(again!.id).toBe(one!.id);
    expect(one!.gold).toBeUndefined();
    expect(casesFromBootstrap([bootRow("goal_met", "en", "x")])).toEqual([]);
  });

  it("selects up to N per point and language, hand-labelled first, each message once, German and English only", () => {
    const cases: ReadoutBenchCase[] = [
      ...casesFromBootstrap([bootRow("source_sensitive", "de", "boot de 1"), bootRow("source_sensitive", "de", "fix de 1"), bootRow("source_sensitive", "other", "hola")]),
      ...casesFromFixtures([fixture("f1", "source_sensitive", "de", "fix de 1", "yes"), fixture("f2", "source_sensitive", "de", "fix de 2", "no"), fixture("f3", "fast_lane", "en", "hi", "small_talk")]),
    ];
    const picked = selectCases(cases, ["source_sensitive"], 2);
    expect(picked.map((c) => c.id).sort()).toEqual(["f1", "f2"]);
    const all = selectCases(cases, ["source_sensitive", "fast_lane"], 0);
    expect(all.map((c) => c.id).slice(0, 3).sort()).toEqual(["f1", "f2", "f3"]);
    expect(all.map((c) => c.id).slice(3)).toEqual([cases[0]!.id]);
  });

  it("spreads a quota over the gold labels of a file grouped by label", () => {
    const grouped = [
      ...Array.from({ length: 10 }, (_, i) => fixture(`st-${i}`, "fast_lane", "de", `hallo ${i}`, "small_talk")),
      ...Array.from({ length: 10 }, (_, i) => fixture(`task-${i}`, "fast_lane", "de", `rechne ${i}`, "task")),
    ];
    const picked = selectCases(casesFromFixtures(grouped), ["fast_lane"], 4);
    expect(picked.filter((c) => c.gold === "small_talk")).toHaveLength(2);
    expect(picked.filter((c) => c.gold === "task")).toHaveLength(2);
  });

  it("swaps the options for the position-bias measurement", () => {
    expect(swappedOrder("source_sensitive")).toEqual(["no", "yes"]);
  });
});

// ── One readout call as the bench records it ─────────────────────────────────────────────────────

describe("a readout call as the bench scores it", () => {
  it("an answer carried a top list; a list without a usable answer did too; a failed call or no list did not", () => {
    const answered = readoutArm({ ok: true, answer: { choice: "yes", top: 0.9, probabilities: { yes: 0.9, no: 0.1 }, logScores: { yes: -0.1, no: -2.3 }, mass: 0.99, temperature: 1, topToken: "A", ms: 800 } });
    expect(answered).toMatchObject({ logprobs: true, choice: "yes", logScores: { yes: -0.1, no: -2.3 } });
    expect(readoutArm({ ok: false, reason: "control_token", ms: 700, topToken: "<think>" })).toEqual({ ms: 700, logprobs: true, miss: "control_token", topToken: "<think>" });
    expect(readoutArm({ ok: false, reason: "no_letter", ms: 700, topToken: "Yes" }).logprobs).toBe(true);
    expect(readoutArm({ ok: false, reason: "low_mass", ms: 700, topToken: "The" }).logprobs).toBe(true);
    expect(readoutArm({ ok: false, reason: "no_logprobs", ms: 700 }).logprobs).toBe(false);
    expect(readoutArm({ ok: false, reason: "aborted", ms: 60_000 }).logprobs).toBe(false);
    expect(readoutArm({ ok: false, reason: "error", ms: 5, error: "HTTP 500" })).toMatchObject({ logprobs: false, miss: "error", error: "HTTP 500" });
  });
});

// ── Scoring ──────────────────────────────────────────────────────────────────────────────────────

function result(id: string, language: "de" | "en", parsed: string | undefined, readout: string | undefined, extra: Partial<ReadoutBenchResult> = {}): ReadoutBenchResult {
  const p = readout === "yes" ? 0.8 : 0.2;
  return {
    caseId: id,
    point: "source_sensitive",
    language,
    split: benchSplit(id),
    source: "fixture",
    ...(parsed !== undefined ? { parsed: { choice: parsed, ms: 1_100 } } : { parsed: { ms: 1_000, error: "the reply held no answer" } }),
    ...(readout !== undefined
      ? { readout: { ms: 800, logprobs: true, choice: readout, top: Math.max(p, 1 - p), logScores: { yes: Math.log(p), no: Math.log(1 - p) }, mass: 0.99 } }
      : { readout: { ms: 750, logprobs: false, miss: "no_logprobs" } }),
    ...extra,
  };
}

describe("a slice's scores", () => {
  const results: ReadoutBenchResult[] = [
    result("a1", "de", "yes", "yes", { gold: "yes", swapped: { ms: 800, logprobs: true, choice: "yes" } }),
    result("a2", "de", "no", "no", { gold: "no", swapped: { ms: 800, logprobs: true, choice: "yes" } }),
    result("a3", "de", "yes", "no", { gold: "yes" }),
    result("a4", "en", "no", "no"),
    result("a5", "en", undefined, "yes"),
    result("a6", "en", "no", undefined),
    { ...result("a7", "en", "no", "no"), readout: { ms: 3, logprobs: false, miss: "error", error: "HTTP 500" } },
    { caseId: "g1", point: "source_sensitive", language: "de", split: "test", source: "fixture", gated: true },
  ];

  it("counts agreement where both answered, with its lower bound and per parsed answer", () => {
    const all = scoreReadoutSlice(results, "source_sensitive", "all");
    expect(all.cases).toBe(8);
    expect(all.gated).toBe(1);
    expect(all.agreement).toMatchObject({ hits: 3, n: 4, rate: 0.75 });
    expect(all.agreement.lowerBound).toBeGreaterThan(0);
    expect(all.agreement.lowerBound).toBeLessThan(0.75);
    expect(all.agreementByParsed["yes"]).toMatchObject({ hits: 1, n: 2 });
    expect(all.agreementByParsed["no"]).toMatchObject({ hits: 2, n: 2 });
  });

  it("(a) counts a top list per call that reached the server, a failed call apart", () => {
    const all = scoreReadoutSlice(results, "source_sensitive", "all");
    expect(all.logprobsArrived).toMatchObject({ hits: 5, n: 6 });
    expect(all.coverage).toMatchObject({ hits: 5, n: 7 });
    expect(all.misses).toEqual({ no_logprobs: 1, error: 1 });
    expect(all.failed).toEqual({ parsed: 1, readout: 1 });
  });

  it("slices by language, and scores gold accuracy, wall time and order flips", () => {
    const de = scoreReadoutSlice(results, "source_sensitive", "de");
    expect(de.agreement).toMatchObject({ hits: 2, n: 3 });
    expect(de.goldAccuracy.parsed).toMatchObject({ hits: 3, n: 3 });
    expect(de.goldAccuracy.readout).toMatchObject({ hits: 2, n: 3 });
    expect(de.flips).toMatchObject({ hits: 1, n: 2 });
    expect(de.ms.parsed?.p50).toBe(1_100);
    expect(de.ms.readout?.p50).toBe(800);
    const en = scoreReadoutSlice(results, "source_sensitive", "en");
    // Four readouts: three reached the server (one without a top list), one failed before it.
    expect(en.ms.readout?.n, "a failed call's time is not a readout's").toBe(3);
  });
});

/** Deterministic pseudo-random numbers (mulberry32). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A readout overconfident by exactly `trueT`: the parsed answer is drawn from softmax(z / trueT). */
function overconfident(trueT: number, n: number, language: "de" | "en" = "de"): ReadoutBenchResult[] {
  const random = prng(11);
  return Array.from({ length: n }, (_, i) => {
    const margin = 6 * (random() - 0.5);
    const logScores = [margin / 2, -margin / 2];
    const p = applyTemperature(logScores, trueT);
    const parsed = random() < p[0]! ? "yes" : "no";
    const own = applyTemperature(logScores, 1);
    const id = `c${language}${i}`;
    return {
      caseId: id, point: "source_sensitive", language, split: benchSplit(id), source: "bootstrap",
      parsed: { choice: parsed, ms: 1_000 },
      readout: { ms: 800, logprobs: true, choice: own[0]! >= own[1]! ? "yes" : "no", top: Math.max(...own), logScores: { yes: logScores[0]!, no: logScores[1]! }, mass: 1 },
    } satisfies ReadoutBenchResult;
  });
}

describe("(d) calibration against a held-out half", () => {
  it("fits the temperature on the calibration half and measures on the test half only", () => {
    const results = overconfident(2.5, 3_000);
    const block = calibrationBlock(results, "parsed")!;
    expect(block.calibrationCases + block.testCases).toBe(3_000);
    expect(block.calibrationCases).toBe(results.filter((r) => r.split === "calibration").length);
    expect(Math.abs(block.fit.temperature - 2.5) / 2.5).toBeLessThan(0.1);
    expect(block.eceAfter!).toBeLessThan(block.eceBefore!);
    expect(block.nllAfter!).toBeLessThan(block.nllBefore!);
  });

  it("takes its temperature from the calibration half alone, never from the half it is scored on", () => {
    // Calibration half miscalibrated by T = 3, test half by T = 1: a fit on the test half would find ~1.
    const calibrationHalf = overconfident(3, 3_000).filter((r) => r.split === "calibration");
    const testHalf = overconfident(1, 3_000).filter((r) => r.split === "test");
    const block = calibrationBlock([...calibrationHalf, ...testHalf], "parsed")!;
    expect(block.fit.temperature).toBeGreaterThan(2.5);
    expect(block.testCases).toBe(testHalf.length);
  });

  it("has nothing to say without both halves, or against a gold nobody labelled", () => {
    expect(calibrationBlock(overconfident(2, 40).filter((r) => r.split === "test"), "parsed")).toBeNull();
    expect(calibrationBlock(overconfident(2, 40), "gold")).toBeNull();
  });

  it("suggests a temperature per point and language, fitted on every answered case", () => {
    const suggested = suggestedTemperatures([...overconfident(2.5, 2_000, "de"), ...overconfident(0.8, 2_000, "en")]);
    expect(Math.abs(suggested["source_sensitive"]!["de"]!.temperature - 2.5) / 2.5).toBeLessThan(0.1);
    expect(Math.abs(suggested["source_sensitive"]!["en"]!.temperature - 0.8) / 0.8).toBeLessThan(0.1);
  });
});

describe("the verdict", () => {
  it("meets the target at 95% agreement, falls below it under, and says so when no top list ever arrived", () => {
    const agreeing = Array.from({ length: 20 }, (_, i) => result(`m${i}`, "de", "yes", "yes"));
    const meets = buildReadoutReport([...agreeing.slice(0, 19), result("m19", "de", "yes", "no")]);
    expect(meets.points[0]!.verdict).toBe("meets_target");
    expect(meets.exitCode).toBe(0);
    const below = buildReadoutReport([...agreeing.slice(0, 18), result("m18", "de", "yes", "no"), result("m19", "de", "no", "yes")]);
    expect(below.points[0]!.verdict).toBe("below_target");
    expect(below.exitCode).toBe(1);
    const none = buildReadoutReport(Array.from({ length: 5 }, (_, i) => result(`n${i}`, "de", "yes", undefined)));
    expect(none.points[0]!.verdict).toBe("no_logprobs");
    expect(none.exitCode).toBe(1);
    expect(buildReadoutReport([]).exitCode).toBe(2);
  });

  it("is inconclusive when nothing was answered by both", () => {
    const slice = scoreReadoutSlice([result("x", "de", undefined, "yes")], "source_sensitive", "all");
    expect(pointVerdict(slice, 0.95).verdict).toBe("inconclusive");
  });
});

describe("the report", () => {
  it("names each measurement and prints the temperatures to configure, leaving a clamped fit out", () => {
    const report = buildReadoutReport(overconfident(2.5, 400));
    const markdown = renderReadoutMarkdown(report, ["Run x."]);
    for (const label of ["(a) top list arrived", "(b) agrees with parsed", "(c) ms p50 / p90 readout", "(d) ECE vs parsed", "(e) flips when the order is swapped"]) {
      expect(markdown).toContain(label);
    }
    expect(markdown).toContain("| | de | en | all |");
    expect(markdown).toContain("\"temperatures\"");
    const clamped = buildReadoutReport(Array.from({ length: 30 }, (_, i) => ({
      ...result(`k${i}`, "de", "no", "yes"),
      readout: { ms: 800, logprobs: true, choice: "yes", top: 0.95, logScores: { yes: Math.log(0.95), no: Math.log(0.05) }, mass: 1 },
    })));
    const clampedMarkdown = renderReadoutMarkdown(clamped);
    expect(clampedMarkdown).toContain("CLAMPED");
    expect(clampedMarkdown).toContain("\"temperatures\": {}");
  });
});

// ── End to end against a recorded provider ───────────────────────────────────────────────────────

/**
 * A model with a position bias: it favours whatever option is lettered A. Unswapped, the letter A is
 * "yes"; swapped, it is "no" — so a case where it is unsure flips with the order.
 */
function positionBiasedModel(sureOf: (message: string) => number) {
  return {
    complete: async (messages: LLMMessage[], _tools: unknown, _signal?: AbortSignal, options?: CompletionCallOptions): Promise<LLMResponse> => {
      expect(options).toMatchObject({ maxTokens: 1, logprobs: true, topLogprobs: 20 });
      const yesIsA = /\nA: Yes/.test(messages[0]!.content ?? "");
      const pYes = sureOf(String(messages[1]!.content));
      const pA = Math.min(0.98, (yesIsA ? pYes : 1 - pYes) + 0.15);
      const top = [{ token: "A", logprob: Math.log(pA) }, { token: "B", logprob: Math.log(0.99 - pA) }, { token: "The", logprob: Math.log(0.01) }].sort((a, b) => b.logprob - a.logprob);
      return { content: top[0]!.token, tool_calls: [], usage: { promptTokens: 300, completionTokens: 1, totalTokens: 301 }, finishReason: "length", logprobs: [{ ...top[0]!, topLogprobs: top }] };
    },
  };
}

describe("a run against a recorded provider", () => {
  it("scores agreement and order flips from what the provider answered", async () => {
    const provider = positionBiasedModel((message) => (message.includes("certain:") ? 0.95 : 0.45));
    const cases = [
      { id: "r1", message: "certain: what does a Deutschlandticket cost?", parsed: "yes" },
      { id: "r2", message: "unsure: how do hash maps work?", parsed: "no" },
    ];
    const results: ReadoutBenchResult[] = [];
    for (const c of cases) {
      const readout = readoutArm(await askReadout(provider, SOURCE_SENSITIVE, { message: c.message }));
      const swapped = readoutArm(await askReadout(provider, SOURCE_SENSITIVE, { message: c.message }, { order: swappedOrder("source_sensitive") }));
      results.push({ caseId: c.id, point: "source_sensitive", language: "en", split: benchSplit(c.id), source: "fixture", parsed: { choice: c.parsed, ms: 1_000 }, readout, swapped });
    }
    const all = scoreReadoutSlice(results, "source_sensitive", "all");
    // The unsure case: 0.45 + the bias of letter A reads "yes" one way round and "no" the other.
    expect(results[1]!.readout!.choice).toBe("yes");
    expect(results[1]!.swapped!.choice).toBe("no");
    expect(all.flips).toMatchObject({ hits: 1, n: 2 });
    expect(all.agreement).toMatchObject({ hits: 1, n: 2 });
    expect(all.logprobsArrived).toMatchObject({ hits: 2, n: 2 });
  });
});
