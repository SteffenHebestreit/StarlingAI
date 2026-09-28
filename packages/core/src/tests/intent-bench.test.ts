/**
 * intent:bench — the labelled synthetic cases (eval/intent/intent.example.jsonl) and the arithmetic that
 * scores the intent readout against them (agent/intent-bench.ts), plus the readout's `facets` option the
 * --order-swap pass asks through. Pure logic and recorded provider answers only: no model is called.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { benchSplit } from "../agent/decisions-bench.js";
import {
  buildIntentBenchReport,
  CONFIDENCE_LEVELS,
  facetCalibration,
  facetVerdict,
  INTENT_FACET_NAMES,
  lintIntentCases,
  MARGIN_LEVELS,
  MIN_SCORED_PER_FACET,
  parseIntentBenchArgs,
  parseIntentCases,
  profileIntentCases,
  readoutArmFrom,
  renderIntentBenchMarkdown,
  reversedFacets,
  scoreFacetSlice,
  scoreLanguageSlice,
  selectIntentCases,
  suggestTemperatures,
  triageArmFrom,
  TURN_TRIAGE_TIMEOUT_MS,
  type FacetReading,
  type IntentBenchCase,
  type IntentBenchResult,
  type IntentBenchSettings,
  type IntentGold,
  type ReadoutArm,
} from "../agent/intent-bench.js";
import type { TriageVerdict } from "../agent/triage.js";
import {
  askIntentReadout,
  buildIntentGrammar,
  buildIntentReadoutSystemPrompt,
  INTENT_FACET_BY_NAME,
  INTENT_FACETS,
  INTENT_READOUT_GRAMMAR,
  INTENT_READOUT_SYSTEM_PROMPT,
  type IntentFacetDefinition,
  type IntentFacetName,
} from "../decisions/intent-readout.js";
import { LETTERS } from "../decisions/logit-readout.js";
import type { CompletionCallOptions, LLMMessage, LLMResponse, LLMTokenLogprob } from "../providers/lmstudio.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

function loadExample(): IntentBenchCase[] {
  return parseIntentCases(readFileSync(join(REPO, "eval", "intent", "intent.example.jsonl"), "utf8"));
}

// ── Recorded replies ─────────────────────────────────────────────────────────────────────────────

type Top = Array<[string, number]>;

function tok(token: string, top: Top = [[token, -0.01], ["\n", -6]]): LLMTokenLogprob {
  const own = top.find(([t]) => t === token)?.[1] ?? -0.01;
  return { token, logprob: own, topLogprobs: top.map(([t, logprob]) => ({ token: t, logprob })) };
}

/**
 * A reply as llama-server tokenised it on 2026-09-28 (label, ":", " X", newline; the restatement last),
 * writing `answers[facet]` under the letter `facets` gives it, with `confidence` on that letter and the
 * rest of the mass on the next letter.
 */
function recordedReply(answers: Partial<IntentGold>, facets: readonly IntentFacetDefinition[] = INTENT_FACETS, query = " A restated request.", confidence = 0.9): LLMTokenLogprob[] {
  const tokens: LLMTokenLogprob[] = [];
  for (const definition of facets) {
    const answer = answers[definition.name];
    if (answer === undefined) continue;
    const index = definition.keys.indexOf(answer);
    const letter = LETTERS[index]!;
    const other = LETTERS[(index + 1) % definition.keys.length]!;
    if (tokens.length > 0) tokens.push(tok("\n"));
    tokens.push(tok(definition.name), tok(":"), tok(` ${letter}`, [[` ${letter}`, Math.log(confidence)], [` ${other}`, Math.log(1 - confidence)], ["\n", -9]]));
  }
  tokens.push(tok("\n"), tok("query"), tok("_en"), tok(":"));
  for (const word of query.match(/ ?[^ ]+/g) ?? []) tokens.push(tok(word));
  return tokens;
}

function recordedProvider(reply: (messages: LLMMessage[]) => Partial<LLMResponse>) {
  const calls: Array<{ messages: LLMMessage[]; options?: CompletionCallOptions }> = [];
  const provider = {
    complete: async (messages: LLMMessage[], _tools: unknown, _signal?: AbortSignal, options?: CompletionCallOptions): Promise<LLMResponse> => {
      calls.push({ messages, ...(options ? { options } : {}) });
      return { content: null, tool_calls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop", ...reply(messages) };
    },
  };
  return { provider, calls };
}

// ── Constructed results ──────────────────────────────────────────────────────────────────────────

const GOLD: IntentGold = { mode: "GATHER", domain: "research", deliverable: "evidence", multi: "no", alone: "yes", source_sensitive: "yes", decision: "single_agent" };

/** A facet reading with `top` on `choice` and the rest on `runnerUp` (or spread when none is given). */
function reading(facet: IntentFacetName, choice: string, top: number, runnerUp?: string, sampled?: string): FacetReading {
  const keys = INTENT_FACET_BY_NAME[facet].keys;
  const second = runnerUp ?? keys.find((key) => key !== choice)!;
  const rest = keys.filter((key) => key !== choice && key !== second);
  const tiny = 1e-6;
  const secondP = 1 - top - tiny * rest.length;
  const p: Record<string, number> = Object.fromEntries(keys.map((key) => [key, key === choice ? top : key === second ? secondP : tiny]));
  return {
    choice,
    top,
    margin: top - secondP,
    runnerUp: second,
    logScores: Object.fromEntries(Object.entries(p).map(([key, value]) => [key, Math.log(value)])),
    ...(sampled !== undefined ? { sampled } : {}),
  };
}

function arm(facets: Partial<Record<IntentFacetName, FacetReading>>, extra: Partial<ReadoutArm> = {}): ReadoutArm {
  return { ms: 1_000, ok: true, facets, misses: {}, queryEnChars: 20, tokens: 40, ...extra };
}

let serial = 0;
function result(language: "de" | "en", gold: Partial<IntentGold>, readout: ReadoutArm | undefined, extra: Partial<IntentBenchResult> = {}): IntentBenchResult {
  serial += 1;
  const caseId = extra.caseId ?? `c-${serial}`;
  return { caseId, language, split: benchSplit(caseId), gold: { ...GOLD, ...gold }, ...(readout ? { readout } : {}), ...extra };
}

const SETTINGS: IntentBenchSettings = { casesFiles: ["x"], split: "all", withTriage: false, orderSwap: false, samplingTemperature: 0, topLogprobs: 20, minMass: 0.5 };

// ── The dataset ──────────────────────────────────────────────────────────────────────────────────

describe("the committed cases (eval/intent/intent.example.jsonl)", () => {
  const cases = loadExample();
  const profile = profileIntentCases(cases);

  it("are well formed, at least 240, and at least 55% German", () => {
    expect(lintIntentCases(cases)).toEqual([]);
    expect(cases.length).toBeGreaterThanOrEqual(240);
    expect(profile.germanShare).toBeGreaterThanOrEqual(0.55);
    for (const benchCase of cases) expect(benchCase.id, benchCase.id).toMatch(new RegExp(`^in-${benchCase.language}-\\d{3}$`));
  });

  it("hold every value of every facet with up to six values at least 8 times, and every value of the others at least 4 times", () => {
    for (const facet of INTENT_FACET_NAMES) {
      const floor = INTENT_FACET_BY_NAME[facet].keys.length <= 6 ? 8 : 4;
      for (const [value, count] of Object.entries(profile.perFacet[facet])) expect(count, `${facet}=${value}`).toBeGreaterThanOrEqual(floor);
    }
  });

  it("hold the hard cases in both languages", () => {
    // Every tag the README's table names.
    const kinds = [
      "follow-up", "short", "one-word", "confirm", "mixed", "small-talk-plus-request", "do-not-look-up", "brand-in-passing", "own-text",
      "vague", "no-context", "routine", "many-steps", "about-assistant", "concept", "calculation", "writing", "code-snippet",
    ];
    for (const language of ["de", "en"]) {
      for (const kind of kinds) expect(cases.some((benchCase) => benchCase.language === language && benchCase.tags?.includes(kind)), `${language} ${kind}`).toBe(true);
      // Requests best answered directly, with no specialist: the pre-router's missing class.
      expect(cases.filter((benchCase) => benchCase.language === language && benchCase.gold.decision === "answer_direct").length, `${language} answer_direct`).toBeGreaterThanOrEqual(20);
    }
  });

  it("follow the labelling rules that are fixed (README: the rules that settle a label)", () => {
    for (const { id, gold } of cases) {
      // converse is the only mode without work: no domain, nothing produced, nothing to look up, answered directly.
      expect(gold.mode === "converse", `${id} converse ⇔ domain other`).toBe(gold.domain === "other");
      if (gold.mode === "converse") expect([gold.deliverable, gold.source_sensitive, gold.decision], id).toEqual(["none", "no", "answer_direct"]);
      // answer_direct is "no tool needed and not source_sensitive".
      if (gold.source_sensitive === "yes") expect(gold.decision, id).not.toBe("answer_direct");
      // alone is "no" exactly when the request needs a plan first.
      expect(gold.alone === "no", `${id} alone no ⇔ coordinate`).toBe(gold.decision === "coordinate");
      // ORCHESTRATE is an ad-hoc request across capabilities.
      if (gold.mode === "ORCHESTRATE") expect([gold.decision, gold.multi], id).toEqual(["coordinate", "yes"]);
      if (gold.decision === "workflow") expect(gold.mode, id).not.toBe("ORCHESTRATE");
    }
  });

  it("split into halves that both hold each language and each decision", () => {
    for (const split of ["calibration", "test"] as const) {
      const half = cases.filter((benchCase) => benchSplit(benchCase.id) === split);
      expect(half.length / cases.length, split).toBeGreaterThan(0.35);
      for (const decision of INTENT_FACET_BY_NAME.decision.keys) expect(half.some((benchCase) => benchCase.gold.decision === decision), `${split} ${decision}`).toBe(true);
      for (const language of ["de", "en"]) expect(half.some((benchCase) => benchCase.language === language), `${split} ${language}`).toBe(true);
    }
  });
});

describe("the case lint", () => {
  const good: IntentBenchCase = { id: "a", language: "de", message: "hallo", gold: { ...GOLD } };

  it("passes a good case and names every problem of a bad one", () => {
    expect(lintIntentCases([good])).toEqual([]);
    const { decision: _decision, ...noDecision } = GOLD;
    expect(lintIntentCases([
      good,
      { ...good },
      { ...good, id: "b", language: "fr" },
      { ...good, id: "c", message: " " },
      { ...good, id: "d", message: "x".repeat(1_201) },
      { ...good, id: "e", gold: noDecision as IntentGold },
      { ...good, id: "f", gold: { ...GOLD, mode: "gather" } },
      { ...good, id: "g", gold: { ...GOLD, confidence: "high" } as unknown as IntentGold },
      { ...good, id: "h", tags: ["x", 3 as unknown as string] },
      { ...good, id: "i", prior: "" },
    ])).toEqual([
      "duplicate case id: a",
      '[b] language must be "de" or "en"',
      "[c] message is empty",
      "[d] message is over the 1200 characters the readout reads",
      "[e] has no gold for decision",
      '[f] gold mode "gather" is not an option of mode',
      "[g] gold names confidence, which the readout does not ask",
      "[h] tags must be a list of strings",
      "[i] prior must be a non-empty digest of at most 400 characters",
    ]);
  });

  it("parses JSONL with comment lines and names the line that is not JSON", () => {
    expect(parseIntentCases(`// header\n\n${JSON.stringify(good)}\n`)).toHaveLength(1);
    expect(() => parseIntentCases(`// header\n${JSON.stringify(good)}\n{not json\n`)).toThrow(/line 3/);
  });
});

// ── The order swap, through the readout itself ───────────────────────────────────────────────────

describe("the order swap", () => {
  it("reverses every facet's options and leaves the grammar as it is", () => {
    const swapped = reversedFacets();
    for (const definition of swapped) expect(definition.keys).toEqual([...INTENT_FACET_BY_NAME[definition.name].keys].reverse());
    expect(buildIntentGrammar(swapped)).toBe(INTENT_READOUT_GRAMMAR);
    expect(buildIntentReadoutSystemPrompt(swapped)).toContain("\nA: ORCHESTRATE");
    expect(buildIntentReadoutSystemPrompt(swapped)).not.toBe(INTENT_READOUT_SYSTEM_PROMPT);
  });

  it("asks the readout under the reversed letters and reads each letter back to the same option", async () => {
    const swapped = reversedFacets();
    const { provider, calls } = recordedProvider(() => ({ content: "", logprobs: recordedReply(GOLD, swapped) }));
    const result = await askIntentReadout(provider, { userMessage: "x" }, { language: "en", facets: swapped });
    expect(calls[0]!.messages[0]!.content).toBe(buildIntentReadoutSystemPrompt(swapped));
    expect(calls[0]!.options?.grammar).toBe(INTENT_READOUT_GRAMMAR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // GATHER is under E when reversed: read back as GATHER, not as the default order's E (VERIFY).
    expect(Object.fromEntries(Object.entries(result.readout.facets).map(([name, read]) => [name, read!.choice]))).toEqual(GOLD);
  });

  it("leaves the default call as it was", async () => {
    const { provider, calls } = recordedProvider(() => ({ content: "", logprobs: recordedReply(GOLD) }));
    const result = await askIntentReadout(provider, { userMessage: "x" }, { language: "en" });
    expect(calls[0]!.messages[0]!.content).toBe(INTENT_READOUT_SYSTEM_PROMPT);
    expect(result.ok && result.readout.facets.mode?.choice).toBe("GATHER");
  });
});

// ── The arms ─────────────────────────────────────────────────────────────────────────────────────

describe("an arm keeps letters and numbers, never text", () => {
  it("keeps each facet's choice, probabilities and the restatement's length", async () => {
    const restatement = " Please look up the current price of a monthly rail pass.";
    const { provider } = recordedProvider(() => ({ content: null, logprobs: recordedReply(GOLD, INTENT_FACETS, restatement) }));
    const kept = readoutArmFrom(await askIntentReadout(provider, { userMessage: "Was kostet die Monatskarte?" }, { language: "de" }));
    expect(kept.ok).toBe(true);
    expect(Object.fromEntries(Object.entries(kept.facets).map(([name, read]) => [name, read.choice]))).toEqual(GOLD);
    // 0.9 on the written letter; the four letters off the list get its floor as a ceiling.
    expect(kept.facets.mode!.top).toBeCloseTo(0.9, 3);
    expect(kept.queryEnChars).toBe(restatement.trim().length);
    expect(kept.detected).toBe("de");
    expect(JSON.stringify(kept)).not.toContain("rail pass");
  });

  it("records a miss per facet, and a failed call as a failure with no facets", async () => {
    const { mode: _mode, ...rest } = GOLD;
    const { provider } = recordedProvider(() => ({ content: null, logprobs: recordedReply(rest) }));
    const kept = readoutArmFrom(await askIntentReadout(provider, { userMessage: "x" }, { language: "en" }));
    expect(kept.misses).toEqual({ mode: "no_slot" });
    expect(readoutArmFrom({ ok: false, reason: "error", ms: 12, error: "HTTP 400" })).toEqual({ ms: 12, ok: false, failure: "error", error: "HTTP 400", facets: {}, misses: {}, queryEnChars: 0, tokens: 0 });
  });

  it("keeps triage's verdict in the readout's keys, and why there is none", () => {
    const verdict: TriageVerdict = {
      mode: "PRODUCE", domain: ["media", "authoring"], deliverable: "image", multi: false, parts: [], alone: true, sourceSensitive: false,
      decision: "single_agent", missing: [], queryEn: "Draw a fox.", language: "de", confidence: 0.8,
    };
    const kept = triageArmFrom({ verdict, attempts: 1, elapsedMs: 1_400 });
    expect(kept).toEqual({
      ms: 1_400, attempts: 1, queryEnChars: 11,
      verdict: { mode: "PRODUCE", domain: "media", deliverable: "image", multi: "no", alone: "yes", source_sensitive: "no", decision: "single_agent" },
    });
    expect(JSON.stringify(kept)).not.toContain("fox");
    expect(triageArmFrom({ verdict: null, failureReason: "timeout", attempts: 1, elapsedMs: 8_000 })).toEqual({ ms: 8_000, attempts: 1, failure: "timeout" });
  });
});

// ── Scoring ──────────────────────────────────────────────────────────────────────────────────────

describe("a facet's slice", () => {
  it("scores accuracy against gold and against the always-majority answer on the same readings", () => {
    const results = [
      result("de", { multi: "no" }, arm({ multi: reading("multi", "no", 0.9) })),
      result("de", { multi: "no" }, arm({ multi: reading("multi", "yes", 0.6) })),
      result("en", { multi: "yes" }, arm({ multi: reading("multi", "yes", 0.95) })),
      result("en", { multi: "no" }, arm({ multi: reading("multi", "no", 0.8) })),
      // Not read: counts for the coverage, not the accuracy or the majority.
      result("en", { multi: "yes" }, arm({}, { misses: { multi: "low_mass" } })),
      // The call failed: not asked.
      result("en", { multi: "yes" }, arm({}, { ok: false, failure: "error" })),
    ];
    const all = scoreFacetSlice(results, "multi", "all");
    expect(all.asked).toBe(5);
    expect(all.read).toMatchObject({ hits: 4, n: 5 });
    expect(all.misses).toEqual({ low_mass: 1 });
    expect(all.accuracy).toMatchObject({ hits: 3, n: 4, rate: 0.75 });
    expect(all.majority).toMatchObject({ label: "no", hits: 3, n: 4 });
    expect(all.perGold).toMatchObject({ yes: { hits: 1, n: 1 }, no: { hits: 2, n: 3 } });
    expect(all.confusion).toEqual({ keys: ["yes", "no"], counts: [[1, 0], [1, 2]] });
    expect(scoreFacetSlice(results, "multi", "de").accuracy).toMatchObject({ hits: 1, n: 2 });
  });

  it("breaks a majority tie toward the facet's first option, never by the order of the cases", () => {
    const tie = [
      result("de", { alone: "no", decision: "coordinate" }, arm({ alone: reading("alone", "no", 0.9) })),
      result("de", { alone: "yes" }, arm({ alone: reading("alone", "no", 0.9) })),
    ];
    expect(scoreFacetSlice(tie, "alone", "all").majority).toMatchObject({ label: "yes", hits: 1, n: 2 });
    expect(scoreFacetSlice([...tie].reverse(), "alone", "all").majority).toMatchObject({ label: "yes", hits: 1, n: 2 });
  });

  it("counts coverage and accuracy at or above each confidence and margin level", () => {
    const results = [
      result("de", {}, arm({ source_sensitive: reading("source_sensitive", "yes", 0.99) })),
      result("de", {}, arm({ source_sensitive: reading("source_sensitive", "yes", 0.9) })),
      result("en", {}, arm({ source_sensitive: reading("source_sensitive", "no", 0.7) })),
      result("en", {}, arm({ source_sensitive: reading("source_sensitive", "no", 0.55) })),
    ];
    const slice = scoreFacetSlice(results, "source_sensitive", "all");
    expect(slice.confidenceCurve.map((row) => row.level)).toEqual([...CONFIDENCE_LEVELS]);
    expect(slice.confidenceCurve.find((row) => row.level === 0.85)).toEqual({ level: 0.85, taken: 2, correct: 2, coverage: 0.5, accuracy: 1 });
    expect(slice.confidenceCurve.find((row) => row.level === 0.6)).toMatchObject({ taken: 3, correct: 2 });
    expect(slice.confidenceCurve.find((row) => row.level === 0.5)).toMatchObject({ taken: 4, coverage: 1, accuracy: 0.5 });
    // Margins 0.98, 0.8, 0.4, 0.1: a margin gate at 0.15 drops only the last.
    expect(slice.marginCurve.map((row) => row.level)).toEqual([...MARGIN_LEVELS]);
    expect(slice.marginCurve.find((row) => row.level === 0.15)).toMatchObject({ taken: 3, correct: 2 });
    expect(slice.marginCurve.find((row) => row.level === 0.5)).toMatchObject({ taken: 2, correct: 2 });
    expect(slice.confidenceCurve.find((row) => row.level === 0.99)).toMatchObject({ taken: 1 });
  });

  it("counts readings whose written letter was not the argmax", () => {
    const results = [
      result("de", {}, arm({ mode: reading("mode", "GATHER", 0.6, "converse", "converse") })),
      result("de", {}, arm({ mode: reading("mode", "GATHER", 0.6, "converse", "GATHER") })),
    ];
    expect(scoreFacetSlice(results, "mode", "all").sampledDiffers).toBe(1);
  });

  it("counts a flip when the reversed order changes the choice, and the shift of the first choice's probability", () => {
    const results = [
      result("de", {}, arm({ mode: reading("mode", "GATHER", 0.8, "VERIFY") }), { swapped: arm({ mode: reading("mode", "VERIFY", 0.7, "GATHER") }) }),
      result("en", {}, arm({ mode: reading("mode", "GATHER", 0.9, "VERIFY") }), { swapped: arm({ mode: reading("mode", "GATHER", 0.8, "VERIFY") }) }),
      // No swapped reading: not in the rate.
      result("en", {}, arm({ mode: reading("mode", "GATHER", 0.9) })),
    ];
    const flips = scoreFacetSlice(results, "mode", "all").flips;
    expect(flips).toMatchObject({ hits: 1, n: 2, rate: 0.5 });
    // GATHER 0.8 → ~0.3 and 0.9 → 0.8.
    expect(flips.meanTopShift!).toBeCloseTo((0.5 + 0.1) / 2, 4);
    expect(scoreFacetSlice(results, "mode", "de").flips).toMatchObject({ hits: 1, n: 1 });
  });

  it("compares with triage on the cases both answered, with the discordant pairs", () => {
    const keysOf = (overrides: Partial<IntentGold>) => ({ ...GOLD, ...overrides });
    const results = [
      // Both right.
      result("de", {}, arm({ mode: reading("mode", "GATHER", 0.9) }), { triage: { ms: 1_500, attempts: 1, verdict: keysOf({}) } }),
      // Only the readout right, twice.
      result("de", {}, arm({ mode: reading("mode", "GATHER", 0.9) }), { triage: { ms: 1_500, attempts: 1, verdict: keysOf({ mode: "VERIFY" }) } }),
      result("en", {}, arm({ mode: reading("mode", "GATHER", 0.9) }), { triage: { ms: 1_500, attempts: 1, verdict: keysOf({ mode: "PRODUCE" }) } }),
      // Only triage right.
      result("en", {}, arm({ mode: reading("mode", "ACT", 0.9) }), { triage: { ms: 1_500, attempts: 1, verdict: keysOf({}) } }),
      // Triage gave no verdict: in neither paired count.
      result("en", {}, arm({ mode: reading("mode", "GATHER", 0.9) }), { triage: { ms: 8_000, attempts: 1, failure: "timeout" } }),
      // The readout missed the facet, triage answered it: in triage's own accuracy, not in the paired counts.
      result("en", {}, arm({}, { misses: { mode: "low_mass" } }), { triage: { ms: 1_500, attempts: 1, verdict: keysOf({}) } }),
    ];
    const comparison = scoreFacetSlice(results, "mode", "all").triage!;
    expect(comparison.accuracy).toMatchObject({ hits: 3, n: 5 });
    expect(comparison.readoutOnBoth).toMatchObject({ hits: 3, n: 4 });
    expect(comparison.triageOnBoth).toMatchObject({ hits: 2, n: 4 });
    expect(comparison.agreement).toMatchObject({ hits: 1, n: 4 });
    expect([comparison.readoutOnly, comparison.triageOnly]).toEqual([2, 1]);
    expect(comparison.pExact).toBeCloseTo(1, 6);
    expect(scoreFacetSlice([result("de", {}, arm({ mode: reading("mode", "GATHER", 0.9) }))], "mode", "all").triage).toBeNull();
  });
});

describe("calibration", () => {
  /** `n` readings at `top`, right on the first `right` of them, in the given half. */
  function readingsAt(split: "calibration" | "test", n: number, right: number, top: number): IntentBenchResult[] {
    const out: IntentBenchResult[] = [];
    for (let i = 0; out.length < n; i += 1) {
      const caseId = `${split}-${top}-${i}`;
      if (benchSplit(caseId) !== split) continue;
      const choice = out.length < right ? "yes" : "no";
      out.push({ caseId, language: "de", split, gold: { ...GOLD, source_sensitive: "yes" }, readout: arm({ source_sensitive: reading("source_sensitive", choice, top) }) });
    }
    return out;
  }

  it("fits the temperature on the calibration half and measures the test half before and after it", () => {
    // Overconfident: 0.95 said, 60% right, in both halves.
    const results = [...readingsAt("calibration", 40, 24, 0.95), ...readingsAt("test", 40, 24, 0.95)];
    const block = facetCalibration(results, "source_sensitive")!;
    expect(block).toMatchObject({ calibrationCases: 40, testCases: 40 });
    expect(block.fit.temperature).toBeGreaterThan(1);
    expect(block.eceBefore!).toBeCloseTo(0.35, 6);
    expect(block.eceAfter!).toBeLessThan(0.05);
    // The NLL at the fitted T (β = 1/T) is below the NLL at T = 1 on the same overconfident half.
    expect(block.nllAfter!).toBeLessThan(block.nllBefore!);
  });

  it("never reads the fit off the test half", () => {
    const calibration = readingsAt("calibration", 40, 24, 0.95);
    const one = facetCalibration([...calibration, ...readingsAt("test", 40, 24, 0.95)], "source_sensitive")!;
    const other = facetCalibration([...calibration, ...readingsAt("test", 40, 40, 0.95)], "source_sensitive")!;
    expect(other.fit.temperature).toBe(one.fit.temperature);
    expect(other.eceBefore).not.toBe(one.eceBefore);
    expect(facetCalibration(calibration, "source_sensitive")).toBeNull();
  });

  it("suggests per facet and language the temperature of every reading, keyed for the readout and for config, without clamped fits", () => {
    const results = [...readingsAt("calibration", 20, 12, 0.95), ...readingsAt("test", 20, 12, 0.95)];
    const suggested = suggestTemperatures(results);
    const t = suggested.intentTemperatures.source_sensitive?.de;
    expect(t).toBeGreaterThan(1);
    expect(suggested.config).toEqual({ "intent.source_sensitive": { de: t } });
    // Always wrong at 0.95: the fit runs to the highest temperature the range allows and is left out.
    const wrong = suggestTemperatures(readingsAt("test", 20, 0, 0.95));
    expect(wrong.fits.source_sensitive?.de?.clamped).toBe(true);
    expect(wrong.config).toEqual({});
    expect(wrong.intentTemperatures).toEqual({});
  });
});

describe("the language rows", () => {
  it("report wall time, restatements and failures per language", () => {
    const results = [
      result("de", {}, arm({}, { ms: 900, queryEnChars: 30, detected: "de", timings: { promptN: 12, cacheN: 900 } }), { triage: { ms: 1_600, attempts: 1, verdict: GOLD, queryEnChars: 0 } }),
      result("de", {}, arm({}, { ms: 1_100, queryEnChars: 0, detected: "other" }), { triage: { ms: 1_800, attempts: 1, verdict: GOLD, queryEnChars: 25 } }),
      result("de", {}, arm({}, { ok: false, failure: "error", ms: 5 }), { triage: { ms: 8_000, attempts: 1, failure: "timeout" } }),
      result("en", {}, arm({}, { ms: 800, queryEnChars: 40, detected: "en" })),
    ];
    const de = scoreLanguageSlice(results, "de");
    expect(de.readoutOk).toMatchObject({ hits: 2, n: 3 });
    expect(de.readoutFailures).toEqual({ error: 1 });
    expect(de.ms.readout).toMatchObject({ n: 2, p50: 900, p90: 1_100 });
    expect(de.queryEn.readout).toMatchObject({ hits: 1, n: 2 });
    expect(de.queryEn.triage).toMatchObject({ hits: 1, n: 2 });
    expect(de.triage).toEqual({ answered: { hits: 2, n: 3, rate: 2 / 3 }, failures: { timeout: 1 } });
    expect(de.ms.triage).toMatchObject({ n: 3 });
    expect(de.cachedTokens).toMatchObject({ n: 1, p50: 900 });
    expect(de.detectedElsewhere).toBe(1);
    expect(scoreLanguageSlice(results, "en").triage).toBeNull();
    expect(scoreLanguageSlice(results, "all").detectedElsewhere).toBe(1);
  });
});

// ── Verdict and report ───────────────────────────────────────────────────────────────────────────

/** `n` results per language whose `facet` reading is right on the first `right` of them; gold alternates so the majority is 50%. */
function facetRun(facet: "source_sensitive" | "multi", perLanguage: number, right: number, triageRight?: number): IntentBenchResult[] {
  const out: IntentBenchResult[] = [];
  for (const language of ["de", "en"] as const) {
    for (let i = 0; i < perLanguage; i += 1) {
      const gold = i % 2 === 0 ? "yes" : "no";
      const wrong = gold === "yes" ? "no" : "yes";
      const readoutChoice = i < right ? gold : wrong;
      const golds: Partial<IntentGold> = { [facet]: gold };
      out.push(result(language, golds, arm({ [facet]: reading(facet, readoutChoice, 0.9) }), triageRight === undefined ? {} : {
        triage: { ms: 1_500, attempts: 1, verdict: { ...GOLD, ...golds, [facet]: i < triageRight ? gold : wrong } },
      }));
    }
  }
  return out;
}

describe("the verdict", () => {
  const slicesOf = (results: IntentBenchResult[], facet: IntentFacetName) => (["de", "en", "all"] as const).map((language) => scoreFacetSlice(results, facet, language));

  it("holds when the readout reads the facet better than the constant answer", () => {
    expect(facetVerdict(slicesOf(facetRun("source_sensitive", 20, 18), "source_sensitive")).verdict).toBe("holds");
  });

  it("is below the majority when it reads no better than the constant answer", () => {
    // 10 of 20 right, the majority 10 of 20.
    expect(facetVerdict(slicesOf(facetRun("source_sensitive", 20, 10), "source_sensitive")).verdict).toBe("below_majority");
  });

  it("is below triage only when triage's lead on the discordant cases is significant", () => {
    expect(facetVerdict(slicesOf(facetRun("multi", 20, 12, 20), "multi")).verdict).toBe("below_triage");
    // Triage right on two more cases: not significant.
    expect(facetVerdict(slicesOf(facetRun("multi", 20, 16, 17), "multi")).verdict).toBe("holds");
  });

  it("is inconclusive with too few readings or none in a language", () => {
    const few = facetRun("source_sensitive", MIN_SCORED_PER_FACET / 2 - 1, 9);
    expect(facetVerdict(slicesOf(few, "source_sensitive")).verdict).toBe("inconclusive");
    const germanOnly = facetRun("source_sensitive", 30, 28).filter((entry) => entry.language === "de");
    expect(facetVerdict(slicesOf(germanOnly, "source_sensitive")).verdict).toBe("inconclusive");
  });

  it("sets the exit code: 0 all hold, 1 one fails, 2 nothing judged, 1 when no top list ever arrived", () => {
    // Every facet right on 18 of 20 per language, gold alternating between two values.
    const good: IntentBenchResult[] = [];
    for (const language of ["de", "en"] as const) {
      for (let i = 0; i < 20; i += 1) {
        const gold = Object.fromEntries(INTENT_FACET_NAMES.map((facet) => [facet, INTENT_FACET_BY_NAME[facet].keys[i % 2]!])) as IntentGold;
        const facets = Object.fromEntries(INTENT_FACET_NAMES.map((facet) => {
          const keys = INTENT_FACET_BY_NAME[facet].keys;
          return [facet, reading(facet, i < 18 ? gold[facet] : keys[(i + 1) % 2]!, 0.9)];
        }));
        good.push(result(language, gold, arm(facets)));
      }
    }
    expect(buildIntentBenchReport(good, SETTINGS).exitCode).toBe(0);
    const oneFails = good.map((entry) => ({ ...entry, readout: { ...entry.readout!, facets: { ...entry.readout!.facets, multi: reading("multi", "yes", 0.9) } } }));
    const failing = buildIntentBenchReport(oneFails, SETTINGS);
    expect(failing.facets.find((entry) => entry.facet === "multi")!.verdict).toBe("below_majority");
    expect(failing.exitCode).toBe(1);
    expect(buildIntentBenchReport(good.slice(0, 5), SETTINGS).exitCode).toBe(2);
    const noLists = good.map((entry) => ({ ...entry, readout: arm({}, { ok: false, failure: "no_logprobs" }) }));
    const none = buildIntentBenchReport(noLists, SETTINGS);
    expect(none.exitCode).toBe(1);
    expect(none.warnings.join(" ")).toMatch(/does not send logprobs/);
    expect(buildIntentBenchReport(good.map((entry) => ({ ...entry, readout: arm({}, { ok: false, failure: "error" }) })), SETTINGS).exitCode).toBe(2);
  });
});

describe("the verdict cannot be passed for the wrong reason", () => {
  const slicesOf = (results: IntentBenchResult[], facet: IntentFacetName) => (["de", "en", "all"] as const).map((language) => scoreFacetSlice(results, facet, language));
  const many = (language: "de" | "en", facet: IntentFacetName, gold: string, choice: string, n: number) =>
    Array.from({ length: n }, () => result(language, { [facet]: gold }, arm({ [facet]: reading(facet, choice, 0.9) })));
  const unreadIn = (language: "de" | "en", facet: IntentFacetName, n: number) =>
    Array.from({ length: n }, () => result(language, {}, arm({}, { misses: { [facet]: "low_mass" } })));

  /** Every facet right on 18 of 20 per language, gold alternating between its first two values: all hold. */
  function goodRun(): IntentBenchResult[] {
    const out: IntentBenchResult[] = [];
    for (const language of ["de", "en"] as const) {
      for (let i = 0; i < 20; i += 1) {
        const gold = Object.fromEntries(INTENT_FACET_NAMES.map((facet) => [facet, INTENT_FACET_BY_NAME[facet].keys[i % 2]!])) as IntentGold;
        const facets = Object.fromEntries(INTENT_FACET_NAMES.map((facet) => [facet, reading(facet, i < 18 ? gold[facet] : INTENT_FACET_BY_NAME[facet].keys[(i + 1) % 2]!, 0.9)]));
        out.push(result(language, gold, arm(facets)));
      }
    }
    return out;
  }

  it("fails a facet the readout was asked in German and could not read there, instead of leaving it inconclusive at exit 0", () => {
    const english = [...many("en", "multi", "no", "no", 15), ...many("en", "multi", "yes", "yes", 15)];
    const verdict = facetVerdict(slicesOf([...english, ...unreadIn("de", "multi", 30)], "multi"));
    expect(verdict.verdict).toBe("unread");
    expect(verdict.reasons.join(" ")).toContain("0/30");
    // The whole run: six facets hold, `decision` is never read in German.
    const run = goodRun().map((entry) => {
      if (entry.language !== "de") return entry;
      const { decision: _decision, ...rest } = entry.readout!.facets;
      return { ...entry, readout: { ...entry.readout!, facets: rest, misses: { decision: "low_mass" } } };
    });
    const report = buildIntentBenchReport(run, SETTINGS);
    expect(report.facets.find((entry) => entry.facet === "decision")!.verdict).toBe("unread");
    expect(report.facets.filter((entry) => entry.verdict === "holds")).toHaveLength(6);
    expect(report.exitCode).toBe(1);
  });

  it("fails a facet read on fewer than half of a language's calls, and warns below 90%", () => {
    const english = [...many("en", "multi", "no", "no", 15), ...many("en", "multi", "yes", "yes", 15)];
    const germanFew = [...many("de", "multi", "no", "no", 7), ...many("de", "multi", "yes", "yes", 7), ...unreadIn("de", "multi", 16)];
    expect(facetVerdict(slicesOf([...english, ...germanFew], "multi")).verdict).toBe("unread");
    const germanMost = [...many("de", "multi", "no", "no", 12), ...many("de", "multi", "yes", "yes", 12), ...unreadIn("de", "multi", 6)];
    expect(facetVerdict(slicesOf([...english, ...germanMost], "multi")).verdict).toBe("holds");
    const warnings = buildIntentBenchReport([...english, ...germanMost], SETTINGS).warnings.join(" ");
    expect(warnings).toMatch(/fewer than 90% .*multi de 24\/30/);
    expect(warnings).not.toMatch(/multi en/);
  });

  it("does not hold a facet one case above a skewed constant answer", () => {
    // Gold 92% "yes": always-yes scores 46 of 50; the readout, right on one "no" per language, 48 of 50.
    const skewed = (language: "de" | "en") => [...many(language, "alone", "yes", "yes", 23), ...many(language, "alone", "no", "no", 1), ...many(language, "alone", "no", "yes", 1)];
    const verdict = facetVerdict(slicesOf([...skewed("de"), ...skewed("en")], "alone"));
    expect(verdict.verdict).toBe("unproven");
    const all = scoreFacetSlice([...skewed("de"), ...skewed("en")], "alone", "all");
    expect(all.majority).toMatchObject({ label: "yes", hits: 46, n: 50, readoutOnly: 2, constantOnly: 0 });
    expect(all.majority.pExact).toBeCloseTo(0.5, 9);
    // The whole run: six facets hold, `alone` is 19 of 20 per language against the constant's 18.
    const run = goodRun().map((entry, i) => {
      const minority = i % 20 >= 18;
      const choice = minority && i % 20 === 19 ? "yes" : minority ? "no" : "yes";
      return { ...entry, gold: { ...entry.gold, alone: minority ? "no" : "yes" }, readout: { ...entry.readout!, facets: { ...entry.readout!.facets, alone: reading("alone", choice, 0.9) } } };
    });
    const report = buildIntentBenchReport(run, SETTINGS);
    expect(report.facets.find((entry) => entry.facet === "alone")!.verdict).toBe("unproven");
    expect(report.facets.filter((entry) => entry.verdict === "holds")).toHaveLength(6);
    expect(report.exitCode).toBe(1);
    // The same facet reading the minority well holds.
    const readsIt = (language: "de" | "en") => [...many(language, "alone", "yes", "yes", 15), ...many(language, "alone", "no", "no", 10)];
    expect(facetVerdict(slicesOf([...readsIt("de"), ...readsIt("en")], "alone")).verdict).toBe("holds");
  });

  it("fails a facet no better than the constant answer in one language, even when the other carries the pool", () => {
    const english = [...many("en", "multi", "no", "no", 15), ...many("en", "multi", "yes", "yes", 15)];
    const german = [...many("de", "multi", "no", "no", 27), ...many("de", "multi", "yes", "no", 3)];
    const all = scoreFacetSlice([...english, ...german], "multi", "all");
    expect(all.accuracy.rate!).toBeGreaterThan(all.majority.rate!);
    const verdict = facetVerdict(slicesOf([...english, ...german], "multi"));
    expect(verdict.verdict).toBe("below_majority");
    expect(verdict.reasons.join(" ")).toContain("in de");
  });

  it("fits the temperatures under the bucket the readout looks them up under, the detected one", () => {
    const overconfident = (language: "de" | "en", detected: string) => Array.from({ length: 20 }, (_, i) => result(language, { source_sensitive: "yes" },
      arm({ source_sensitive: reading("source_sensitive", i < 12 ? "yes" : "no", 0.95) }, { detected })));
    const suggested = suggestTemperatures([...overconfident("de", "other"), ...overconfident("en", "en")]);
    expect(suggested.fits.source_sensitive?.other?.samples).toBe(20);
    expect(suggested.fits.source_sensitive?.de).toBeUndefined();
    expect(Object.keys(suggested.intentTemperatures.source_sensitive ?? {}).sort()).toEqual(["en", "other"]);
    expect(Object.keys(suggested.config["intent.source_sensitive"] ?? {}).sort()).toEqual(["en", "other"]);
  });
});

describe("a whole run on recorded answers", () => {
  it("scores the example cases end to end and writes no message and no restatement into the report", async () => {
    const cases = loadExample().slice(0, 30);
    const restatement = " The restated request in plain English.";
    const results: IntentBenchResult[] = [];
    for (const benchCase of cases) {
      // A readout that gets everything right except `domain` on every third case.
      const answers: IntentGold = { ...benchCase.gold };
      if (results.length % 3 === 0) answers.domain = benchCase.gold.domain === "other" ? "research" : "other";
      const { provider } = recordedProvider(() => ({ content: null, logprobs: recordedReply(answers, INTENT_FACETS, restatement) }));
      const readout = readoutArmFrom(await askIntentReadout(provider, { userMessage: benchCase.message }, { language: benchCase.language === "de" ? "de" : "en" }));
      results.push({ caseId: benchCase.id, language: benchCase.language, split: benchSplit(benchCase.id), gold: benchCase.gold, readout });
    }
    const report = buildIntentBenchReport(results, SETTINGS);
    const domain = report.facets.find((entry) => entry.facet === "domain")!.slices.find((slice) => slice.language === "all")!;
    expect(domain.accuracy).toMatchObject({ hits: 20, n: 30 });
    const mode = report.facets.find((entry) => entry.facet === "mode")!.slices.find((slice) => slice.language === "all")!;
    expect(mode.accuracy).toMatchObject({ hits: 30, n: 30 });
    const markdown = renderIntentBenchMarkdown(report, ["header line"]);
    expect(markdown).toContain("## Verdict per facet");
    expect(markdown).toContain("Confusion (all; rows gold, columns readout)");
    const written = JSON.stringify(report) + markdown;
    expect(written).not.toContain("restated request");
    for (const benchCase of cases) {
      // Every message longer than a label: a one-word greeting ("Hallo!") may appear as a word elsewhere.
      if (benchCase.message.length > 12) expect(written.includes(benchCase.message), benchCase.id).toBe(false);
    }
  });
});

describe("the command line", () => {
  it("reads the defaults", () => {
    expect(parseIntentBenchArgs([])).toEqual({
      withTriage: false, orderSwap: false, split: "all", topLogprobs: 20, minMass: 0.5, samplingTemperature: 0,
      triageTimeoutMs: TURN_TRIAGE_TIMEOUT_MS, timeoutMs: 60_000,
    });
  });

  it("reads every flag, keeps every --cases file in order, and passes over pnpm's separator", () => {
    expect(parseIntentBenchArgs([
      "--", "--cases", "a.jsonl", "--with-triage", "--order-swap", "--split", "test", "--limit", "10", "--top-logprobs", "8",
      "--min-mass", "0.4", "--sampling-temperature", "0.7", "--triage-timeout-ms", "20000", "--timeout-ms", "30000", "--out", "o", "--cases", "b.jsonl",
    ])).toEqual({
      cases: ["a.jsonl", "b.jsonl"], withTriage: true, orderSwap: true, split: "test", limit: 10, topLogprobs: 8, minMass: 0.4,
      samplingTemperature: 0.7, triageTimeoutMs: 20_000, timeoutMs: 30_000, out: "o",
    });
  });

  it("refuses a mistake rather than running the defaults", () => {
    expect(() => parseIntentBenchArgs(["--split", "train"])).toThrow(/all, calibration or test/);
    expect(() => parseIntentBenchArgs(["--top-logprobs", "21"])).toThrow(/from 2 to 20/);
    expect(() => parseIntentBenchArgs(["--with-triag"])).toThrow(/unknown option/);
    expect(() => parseIntentBenchArgs(["--limit"])).toThrow(/needs a value/);
    expect(() => parseIntentBenchArgs(["--cases", "a", "--cases", "a"])).toThrow(/given twice/);
    expect(() => parseIntentBenchArgs(["cases"])).toThrow(/unexpected argument/);
  });

  it("selects a half by the case id alone, and a limited run as a stable spread over the file, not its head", () => {
    const cases = loadExample();
    const test = selectIntentCases(cases, "test");
    expect(test.every((benchCase) => benchSplit(benchCase.id) === "test")).toBe(true);
    expect(test.length + selectIntentCases(cases, "calibration").length).toBe(cases.length);
    const some = selectIntentCases(cases, "all", 24);
    expect(some).toHaveLength(24);
    expect(selectIntentCases(cases, "all", 24)).toEqual(some);
    // The file's head is 24 German small-talk cases; a spread holds both languages and several decisions.
    expect(new Set(some.map((benchCase) => benchCase.language))).toEqual(new Set(["de", "en"]));
    expect(new Set(some.map((benchCase) => benchCase.gold.decision)).size).toBeGreaterThanOrEqual(3);
    // In file order, and a limit past the cases is all of them.
    expect(some.map((benchCase) => cases.indexOf(benchCase))).toEqual([...some.map((benchCase) => cases.indexOf(benchCase))].sort((a, b) => a - b));
    expect(selectIntentCases(cases, "test", 10_000)).toEqual(test);
  });
});
