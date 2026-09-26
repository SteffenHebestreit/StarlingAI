/**
 * The pre-router bench: the question Laya is asked, the training items built from it, and the
 * scoring and gate simulation that decide whether a fast categorisation at message arrival could
 * replace the orchestrator's routing round. Pure logic only — no model, no sidecar, no network.
 */
import { describe, expect, it } from "vitest";

import {
  CAPSULE_MAX_AGENTS,
  DEFAULT_CANDIDATES,
  EMBEDDING_POLICY,
  LAYA_POLICY,
  LAYA_WINDOW_TOKENS,
  MAX_CANDIDATES,
  MAX_LAYA_OPTIONS,
  NONE_DESCRIPTION,
  NONE_KEY,
  OPTION_TOKEN_LIMIT,
  PRE_ROUTE_POINT,
  PRE_ROUTE_QUESTION,
  agentDescriptionText,
  answererName,
  benchVerdict,
  buildPreRouteQuestion,
  buildPreRouteReport,
  buildPreRouteTrainingItem,
  confidenceCurve,
  estimateSavings,
  estimateTokens,
  flawlessSamplesNeeded,
  foldOf,
  formatPreRouteMarkdown,
  isHit,
  mcnemarExactP,
  mergeCandidates,
  parseLayaAnswer,
  parsePreRouterArgs,
  isAnswererOutage,
  pickFromReadout,
  preRouteCalibration,
  preRouteGold,
  qualifyLevel,
  recallAtK,
  samplesNeeded,
  scorePreRoute,
  servedCriteria,
  shortenToTokens,
  simulateGate,
  splitOf,
  stageOneCriteria,
  trainingLabelKey,
  type GateSimulation,
  type PreRouteBenchSettings,
  type PreRouteObservation,
} from "../agent/pre-router-bench.js";
import { GATE_LEVELS, wilsonLowerBound } from "../decisions/gate.js";
import { applyTemperature, buildReadoutMessages, LETTERS } from "../decisions/logit-readout.js";
import type { RoutingEvalCase } from "../agent/routing-eval.js";

const LONG = "Web research specialist that finds external sources for a single topic and reports verifiable facts "
  + "with exact source attribution — official documentation, specifications and standards, release notes, vendor "
  + "pages, product and comparison research, and academic papers, then hands the findings to an author.";

function agents(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `agent_${String.fromCharCode(97 + (i % 26))}${i}`);
}

function build(candidates: readonly string[], k?: number, describe: (name: string) => string = () => LONG, message = "bitte recherchiere das") {
  return buildPreRouteQuestion({ id: "case-1", message, candidates, describe, ...(k === undefined ? {} : { k }) });
}

// ── The question ─────────────────────────────────────────────────────────────────────────────────

describe("the question", () => {
  it("offers K agents plus none, default 8, and none is always the last option", () => {
    const built = build(agents(30))!;
    expect(built.keys).toHaveLength(DEFAULT_CANDIDATES + 1);
    expect(built.keys.at(-1)).toBe(NONE_KEY);
    expect(built.request.options[NONE_KEY]).toBe(NONE_DESCRIPTION);
    expect(built.request.question).toBe(PRE_ROUTE_QUESTION);
    expect(built.request.question.startsWith("Which specialist should handle this request?")).toBe(true);
    expect(built.keys.slice(0, -1)).toEqual(agents(30).slice(0, DEFAULT_CANDIDATES));
  });

  it("never sends more options than the sidecar takes: 19 agents plus none, and K 20 is refused", () => {
    expect(MAX_LAYA_OPTIONS).toBe(20);
    expect(MAX_CANDIDATES).toBe(19);
    const widest = build(agents(40), MAX_CANDIDATES)!;
    expect(Object.keys(widest.request.options)).toHaveLength(MAX_LAYA_OPTIONS);
    expect(() => build(agents(40), MAX_CANDIDATES + 1)).toThrow(RangeError);
    expect(() => build(agents(40), 0)).toThrow(RangeError);
    expect(() => build(agents(40), 2.5)).toThrow(RangeError);
    // One agent is the smallest question the sidecar accepts: two options.
    expect(build(agents(40), 1)!.keys).toEqual([agents(1)[0], NONE_KEY]);
  });

  it("asks nothing when there is no agent to offer, and never offers an agent twice or one named like none", () => {
    expect(build([])).toBeNull();
    expect(build([NONE_KEY])).toBeNull();
    const built = build(["researcher", "researcher", NONE_KEY, "summarizer"])!;
    expect(built.keys).toEqual(["researcher", "summarizer", NONE_KEY]);
  });

  it("names each agent and cuts its description to the 48 tokens Laya reads", () => {
    const built = build(["researcher", "summarizer"], 2, (name) => (name === "researcher" ? LONG : "Condenses text."))!;
    expect(built.optionTokens).toBe(OPTION_TOKEN_LIMIT);
    const long = built.request.options["researcher"]!;
    expect(long.startsWith("researcher: Web research specialist")).toBe(true);
    expect(long.endsWith("…")).toBe(true);
    expect(estimateTokens(long)).toBeLessThanOrEqual(OPTION_TOKEN_LIMIT);
    expect(estimateTokens(`researcher: ${LONG}`)).toBeGreaterThan(OPTION_TOKEN_LIMIT);
    expect(built.request.options["summarizer"]).toBe("summarizer: Condenses text.");
  });

  it("shrinks the descriptions when many options would overflow Laya's window, and says when even that is not enough", () => {
    const wide = build(agents(40), MAX_CANDIDATES)!;
    expect(wide.optionTokens).toBeLessThan(OPTION_TOKEN_LIMIT);
    expect(wide.estimatedTokens).toBeLessThanOrEqual(LAYA_WINDOW_TOKENS);
    expect(wide.overWindow).toBe(false);
    for (const key of wide.keys) expect(estimateTokens(wide.request.options[key]!)).toBeLessThanOrEqual(OPTION_TOKEN_LIMIT);
    // One-letter words: a token each, so the 2,000 characters Laya is sent fill the window by themselves.
    const huge = build(agents(40), MAX_CANDIDATES, () => LONG, "a ".repeat(2_000))!;
    expect(huge.request.state.message.length).toBe(2_000);
    expect(huge.overWindow).toBe(true);
    // However tight the window, an option still names its agent and says a word about it.
    for (const key of huge.keys.slice(0, -1)) expect(huge.request.options[key]!.startsWith(`${key}: Web`)).toBe(true);
  });

  it("serves the options under letters in exactly the order the JSON body carries them", () => {
    const built = build(["zeta_agent", "alpha_agent", "mid_agent"], 3)!;
    const onTheWire = JSON.parse(JSON.stringify({ questions: [built.request] })) as { questions: Array<{ options: Record<string, string> }> };
    // docker/laya/app/generic.py to_laya: keys = list(options.keys()); LETTERS[i] -> options[keys[i]].
    const pythonKeys = Object.keys(onTheWire.questions[0]!.options);
    expect(pythonKeys).toEqual(built.keys);
    const { keys, criteria } = servedCriteria(built.request.options);
    expect(keys).toEqual(["zeta_agent", "alpha_agent", "mid_agent", NONE_KEY]);
    expect(Object.keys(criteria)).toEqual(["A", "B", "C", "D"]);
    expect(criteria["A"]).toBe(built.request.options["zeta_agent"]);
    expect(criteria["D"]).toBe(NONE_DESCRIPTION);
  });
});

describe("shortening and counting", () => {
  it("counts a run of letters per four characters and every other visible character as one", () => {
    expect(estimateTokens("image_creator")).toBe(5);
    expect(estimateTokens("  ")).toBe(0);
    expect(estimateTokens("ab, cd.")).toBe(4);
  });

  it("keeps text within the budget untouched, and cuts everything else to fit it", () => {
    expect(shortenToTokens("  kurz   und\nklar ", 48)).toBe("kurz und klar");
    const texts = [LONG, `https://intern.firmanetz.de/${"x".repeat(300)}`, "Donaudampfschifffahrtsgesellschaftskapitänsmütze".repeat(4), "a, b; c: d. ".repeat(40)];
    for (const text of texts) {
      for (const budget of [2, 5, 12, 20, 48]) {
        const cut = shortenToTokens(text, budget);
        expect(estimateTokens(cut)).toBeLessThanOrEqual(budget);
        if (estimateTokens(text) > budget) {
          expect(cut.endsWith("…")).toBe(true);
          expect(cut.length).toBeGreaterThan(1);
        } else {
          expect(cut).toBe(text.replace(/\s+/g, " ").trim());
        }
      }
    }
  });
});

describe("the candidates", () => {
  it("puts the production capsule first, then the embedding ranking, without duplicates or excluded agents", () => {
    const merged = mergeCandidates(["b", "a"], ["a", "c", "agent_factory", "d", "e"], 4, (name) => name === "agent_factory");
    expect(merged).toEqual(["b", "a", "c", "d"]);
    expect(mergeCandidates(["b"], ["a"], 1)).toEqual(["b"]);
  });

  it("describes an agent by its catalog description unless the one-liner is asked for, each falling back to the other", () => {
    const entry = { description: "Finds sources.", routingGenerated: { oneLiner: "GATHER(research) note" } };
    expect(agentDescriptionText(entry, "description")).toBe("Finds sources.");
    expect(agentDescriptionText(entry, "oneliner")).toBe("GATHER(research) note");
    expect(agentDescriptionText({ routingGenerated: { oneLiner: "only this" } }, "description")).toBe("only this");
    expect(agentDescriptionText({ description: "only that" }, "oneliner")).toBe("only that");
    expect(agentDescriptionText(undefined, "description")).toBe("");
  });
});

// ── Laya's answer ────────────────────────────────────────────────────────────────────────────────

describe("Laya's answer", () => {
  const keys = ["researcher", "summarizer", NONE_KEY];

  it("takes a choice among the options whose probability is the highest", () => {
    expect(parseLayaAnswer({ choice: "summarizer", probabilities: { researcher: 0.2, summarizer: 0.7, none: 0.1 } }, keys))
      .toEqual({ choice: "summarizer", top: 0.7, probabilities: { researcher: 0.2, summarizer: 0.7, none: 0.1 } });
  });

  it("refuses anything that breaks the contract", () => {
    expect(parseLayaAnswer(null, keys)).toBeNull();
    expect(parseLayaAnswer({ choice: "coder", probabilities: { researcher: 0.2, summarizer: 0.7, none: 0.1 } }, keys)).toBeNull();
    expect(parseLayaAnswer({ choice: "summarizer", probabilities: { researcher: 0.2, summarizer: 0.7 } }, keys)).toBeNull();
    expect(parseLayaAnswer({ choice: "summarizer", probabilities: { researcher: 0.8, summarizer: 0.1, none: 0.1 } }, keys)).toBeNull();
    expect(parseLayaAnswer({ choice: "summarizer", probabilities: { researcher: Number.NaN, summarizer: 0.7, none: 0.1 } }, keys)).toBeNull();
  });
});

// ── Cases, halves and training items ─────────────────────────────────────────────────────────────

function routingCase(expect: RoutingEvalCase["expect"], extra: Partial<RoutingEvalCase> = {}): RoutingEvalCase {
  return { id: "c", query: "q", expect, ...extra };
}

describe("the gold of a routing case", () => {
  it("is the acceptable set, with a named target or top added", () => {
    expect(preRouteGold(routingCase({ acceptable: ["a", "b"], admitted: true }))).toEqual({ gold: { kind: "agents", acceptable: ["a", "b"] } });
    expect(preRouteGold(routingCase({ acceptable: ["a"], target: "c", top: "a" }))).toEqual({ gold: { kind: "agents", acceptable: ["a", "c"] } });
  });

  it("is none for a message that should admit no specialist", () => {
    expect(preRouteGold(routingCase({ admitted: false }))).toEqual({ gold: { kind: "none" } });
  });

  it("does not exist for a directive or a case that names nothing", () => {
    expect(preRouteGold(routingCase({ acceptable: ["a"] }, { flags: { directiveAgent: "a" } }))).toHaveProperty("skip");
    expect(preRouteGold(routingCase({ admitted: true }))).toHaveProperty("skip");
  });
});

describe("the halves", () => {
  const ids = Array.from({ length: 400 }, (_, i) => `live-case-${i}`);

  it("depend on the id alone, so adding or reordering cases moves no other case", () => {
    const before = ids.map(splitOf);
    const after = [...ids].reverse().map(splitOf).reverse();
    expect(after).toEqual(before);
    expect(splitOf("live-device-url-spinner")).toBe(splitOf("live-device-url-spinner"));
  });

  it("are roughly even, and the cross-fitting fold is a different cut than the split", () => {
    const calibration = ids.filter((id) => splitOf(id) === "calibration").length;
    expect(calibration).toBeGreaterThan(160);
    expect(calibration).toBeLessThan(240);
    const agreeing = ids.filter((id) => (splitOf(id) === "calibration") === (foldOf(id) === 0)).length;
    expect(agreeing).toBeGreaterThan(120);
    expect(agreeing).toBeLessThan(280);
  });
});

describe("training items", () => {
  const built = build(["summarizer", "researcher", "coder"], 3)!;

  it("label the first right agent in the order offered, else none", () => {
    expect(trainingLabelKey({ kind: "agents", acceptable: ["coder", "researcher"] }, built.keys)).toBe("researcher");
    expect(trainingLabelKey({ kind: "agents", acceptable: ["browser_agent"] }, built.keys)).toBe(NONE_KEY);
    expect(trainingLabelKey({ kind: "none" }, built.keys)).toBe(NONE_KEY);
  });

  it("are the question exactly as served, with a one-hot gold under its letter", () => {
    const item = buildPreRouteTrainingItem(built, { kind: "agents", acceptable: ["coder"] }, "de");
    expect(item.point).toBe(PRE_ROUTE_POINT);
    expect(item.language).toBe("de");
    expect(JSON.parse(item.state)).toEqual(built.request.state);
    const question = item.questions[PRE_ROUTE_POINT]!;
    expect(question.instructions).toBe(built.request.question);
    expect(question.criteria).toEqual(servedCriteria(built.request.options).criteria);
    expect(question.criteria["C"]).toBe(built.request.options["coder"]);
    expect(item.gold[PRE_ROUTE_POINT]).toEqual({ label: "C", probabilities: { A: 0, B: 0, C: 1, D: 0 } });
    const unreachable = buildPreRouteTrainingItem(built, { kind: "agents", acceptable: ["browser_agent"] }, "en");
    expect(unreachable.gold[PRE_ROUTE_POINT]!.label).toBe("D");
    expect(unreachable.questions[PRE_ROUTE_POINT]!.criteria["D"]).toBe(NONE_DESCRIPTION);
  });
});

// ── Scoring ──────────────────────────────────────────────────────────────────────────────────────

let seq = 0;
function obs(partial: Partial<PreRouteObservation> & { gold: PreRouteObservation["gold"] }): PreRouteObservation {
  seq += 1;
  const options = partial.options ?? ["a", "b", "c"];
  return {
    id: partial.id ?? `o${seq}`,
    language: partial.language ?? "de",
    split: partial.split ?? "test",
    fold: partial.fold ?? 0,
    capsule: partial.capsule ?? options.slice(0, 2),
    order: partial.order ?? options,
    options,
    optionScores: partial.optionScores ?? options.map(() => 0.8),
    ...partial,
  };
}

function laya(choice: string, top = 0.95): PreRouteObservation["laya"] {
  return { choice, top, ms: 20, serverMs: 15, model: "laya#multilingual" };
}

describe("scoring", () => {
  const cases = [
    // right agent first: embedding and Laya both right
    obs({ gold: { kind: "agents", acceptable: ["a"] }, laya: laya("a") }),
    // right agent second: only Laya right
    obs({ gold: { kind: "agents", acceptable: ["b"] }, capsule: ["a"], laya: laya("b") }),
    // right agent offered, Laya wrong, embedding right
    obs({ gold: { kind: "agents", acceptable: ["a", "x"] }, capsule: [], laya: laya("c") }),
    // no right agent offered: Laya hands it back
    obs({ gold: { kind: "agents", acceptable: ["z"] }, order: ["a", "b", "c", "z"], laya: laya(NONE_KEY) }),
    // gold none: Laya dispatches anyway; the capsule is empty, which is right
    obs({ gold: { kind: "none" }, capsule: [], language: "en", laya: laya("a") }),
    // Laya not reachable for this one
    obs({ gold: { kind: "agents", acceptable: ["a"] }, language: "en", layaError: "HTTP 500" }),
  ];

  it("measures the capsule, the options, the baselines and Laya on the same cases", () => {
    const score = scorePreRoute(cases);
    expect(score.cases).toBe(6);
    expect(score.goldAgents).toBe(5);
    expect(score.goldNone).toBe(1);
    expect(score.capsuleRecall).toEqual({ hit: 2, of: 5 });
    expect(score.optionRecall).toEqual({ hit: 4, of: 5 });
    expect(score.capsuleTop1).toEqual({ hit: 3, of: 6 });
    expect(score.embeddingTop1).toEqual({ hit: 3, of: 6 });
    expect(score.majority).toEqual({ hit: 3, of: 6, label: "a" });
    expect(score.laya.asked).toBe(6);
    expect(score.laya.answered).toBe(5);
    expect(score.laya.failed).toBe(1);
    expect(score.laya.top1).toEqual({ hit: 2, of: 5 });
    expect(score.laya.givenOptions).toEqual({ hit: 2, of: 3 });
    expect(score.laya.abstainWhenUnreachable).toEqual({ hit: 1, of: 1 });
    expect(score.laya.noneRecall).toEqual({ hit: 0, of: 1 });
    expect(score.laya.pickedNone).toBe(1);
    expect(score.laya.versusEmbedding.layaOnly).toBe(1);
    expect(score.laya.versusEmbedding.embeddingOnly).toBe(1);
    expect(score.laya.msP50).toBe(20);
  });

  it("shows a classifier that answers one label for everything, which a skewed corpus would reward", () => {
    const skewed = [
      ...Array.from({ length: 8 }, () => obs({ gold: { kind: "agents", acceptable: ["a"] }, laya: laya("a") })),
      obs({ gold: { kind: "agents", acceptable: ["b"] }, laya: laya("a") }),
      obs({ gold: { kind: "agents", acceptable: ["c"] }, laya: laya("a") }),
    ];
    const score = scorePreRoute(skewed);
    expect(score.laya.top1).toEqual({ hit: 8, of: 10 });
    expect(score.majority).toEqual({ hit: 8, of: 10, label: "a" });
    expect(score.laya.topPick).toEqual({ label: "a", share: 1 });
    expect(score.goldTopShare).toEqual({ label: "a", share: 0.8 });
    const perLabel = Object.fromEntries(score.perLabel.map((row) => [row.label, row.laya]));
    expect(perLabel["b"]).toEqual({ hit: 0, of: 1 });
    expect(perLabel["c"]).toEqual({ hit: 0, of: 1 });
    expect(perLabel["a"]).toEqual({ hit: 8, of: 8 });
  });

  it("takes the majority baseline from the gold, not from the ranking", () => {
    const score = scorePreRoute([
      ...Array.from({ length: 3 }, () => obs({ gold: { kind: "agents", acceptable: ["x"] }, options: ["a", "x"] })),
      obs({ gold: { kind: "agents", acceptable: ["a"] }, options: ["a", "x"] }),
    ]);
    expect(score.majority).toEqual({ hit: 3, of: 4, label: "x" });
    expect(score.embeddingTop1).toEqual({ hit: 1, of: 4 });
  });

  it("counts a none pick right only on a gold none", () => {
    expect(isHit(NONE_KEY, { kind: "none" })).toBe(true);
    expect(isHit(NONE_KEY, { kind: "agents", acceptable: ["a"] })).toBe(false);
    expect(isHit("a", { kind: "none" })).toBe(false);
    expect(isHit(undefined, { kind: "agents", acceptable: ["a"] })).toBe(false);
  });

  it("gives recall of the candidate order at every K", () => {
    const rows = recallAtK([
      obs({ gold: { kind: "agents", acceptable: ["a"] }, order: ["a", "b", "c"] }),
      obs({ gold: { kind: "agents", acceptable: ["c"] }, order: ["a", "b", "c"] }),
      obs({ gold: { kind: "agents", acceptable: ["q"] }, order: ["a", "b", "c"] }),
      obs({ gold: { kind: "none" } }),
    ], CAPSULE_MAX_AGENTS);
    expect(rows.map((row) => row.hit)).toEqual([1, 1, 2, 2]);
    expect(rows.every((row) => row.of === 3)).toBe(true);
  });

  it("tests the discordant pairs exactly", () => {
    expect(mcnemarExactP(0, 0)).toBe(1);
    expect(mcnemarExactP(5, 0)).toBeCloseTo(0.0625, 10);
    expect(mcnemarExactP(10, 2)).toBeCloseTo((2 * 79) / 4096, 10);
    expect(mcnemarExactP(2, 10)).toBeCloseTo(mcnemarExactP(10, 2), 12);
    expect(mcnemarExactP(3, 3)).toBe(1);
    expect(mcnemarExactP(2_000, 1_950)).toBeGreaterThan(0);
  });
});

// ── The gate ─────────────────────────────────────────────────────────────────────────────────────

const GATE = { targetAgreement: 0.9, minSamples: 30 };

describe("the gate's level", () => {
  const samples = (n: number, agree: boolean, confidence = 0.95) => Array.from({ length: n }, () => ({ confidence, agree }));

  it("needs 35 flawless cases at a 0.9 target: 30 of 30 is not enough", () => {
    expect(qualifyLevel(samples(35, true), GATE_LEVELS, GATE)).toBe(0.5);
    expect(qualifyLevel(samples(34, true), GATE_LEVELS, GATE)).toBeNull();
    expect(qualifyLevel(samples(30, true), GATE_LEVELS, { targetAgreement: 0.9, minSamples: 5 })).toBeNull();
    expect(samplesNeeded(1, 0.9)).toBe(35);
  });

  it("rises past the unsure wrong cases to the level where the rest agree", () => {
    expect(qualifyLevel([...samples(40, false, 0.55), ...samples(40, true, 0.95)], GATE_LEVELS, GATE)).toBe(0.6);
  });

  it("stops once too few cases remain above a level", () => {
    expect(qualifyLevel([...samples(40, false, 0.55), ...samples(20, true, 0.99)], GATE_LEVELS, GATE)).toBeNull();
  });

  it("says how many cases a precision needs, and never for one at or below the target", () => {
    expect(samplesNeeded(0.9, 0.9)).toBeNull();
    expect(samplesNeeded(0.85, 0.9)).toBeNull();
    const n = samplesNeeded(0.95, 0.9)!;
    expect(wilsonLowerBound(0.95 * n, n)).toBeGreaterThanOrEqual(0.9);
    expect(wilsonLowerBound(0.95 * (n - 1), n - 1)).toBeLessThan(0.9);
  });
});

function confident(count: number, options: { fold: 0 | 1; right: boolean; language?: "de" | "en"; choice?: string; top?: number }): PreRouteObservation[] {
  return Array.from({ length: count }, () => {
    const choice = options.choice ?? "a";
    return obs({
      fold: options.fold,
      language: options.language ?? "de",
      gold: { kind: "agents", acceptable: options.right ? [choice] : ["b"] },
      laya: laya(choice, options.top ?? 0.97),
    });
  });
}

describe("the gate simulation", () => {
  it("sets each fold's level on the other fold only, so a threshold is never tested on the cases that chose it", () => {
    const observations = [...confident(40, { fold: 0, right: true }), ...confident(40, { fold: 1, right: false })];
    const gate = simulateGate(observations, LAYA_POLICY, GATE);
    // Fold 1 is judged by fold 0's level and fails; fold 0 is judged by fold 1's, which never qualified.
    expect(gate.evaluated).toBe(80);
    expect(gate.taken).toBe(40);
    expect(gate.correct).toBe(0);
    expect(gate.errors).toBe(40);
    expect(gate.coverage).toBe(0.5);
    expect(gate.errorRate).toBe(1);
    // Wrong, but a right agent was offered and the gold was an agent: neither special kind.
    expect(gate.takenUnreachable).toBe(0);
    expect(gate.takenGoldNone).toBe(0);
    expect(gate.folds.find((fold) => fold.fold === 1)!.qualified).toEqual({ de: 0.5 });
    expect(gate.folds.find((fold) => fold.fold === 0)!.qualified).toEqual({});
  });

  it("skips the rounds whose picks agree, with the error rate's upper bound", () => {
    const observations = [...confident(40, { fold: 0, right: true }), ...confident(40, { fold: 1, right: true })];
    const gate = simulateGate(observations, LAYA_POLICY, GATE);
    expect(gate.taken).toBe(80);
    expect(gate.errors).toBe(0);
    expect(gate.errorRate).toBe(0);
    expect(gate.errorRateUpper).toBeCloseTo(1 - wilsonLowerBound(80, 80), 12);
  });

  it("never takes a none pick: that turn goes to the orchestrator as it does today", () => {
    const observations = [
      ...confident(40, { fold: 0, right: true }),
      ...confident(40, { fold: 1, right: true }),
      ...Array.from({ length: 10 }, () => obs({ fold: 0, gold: { kind: "none" }, laya: laya(NONE_KEY, 0.99) })),
    ];
    const gate = simulateGate(observations, LAYA_POLICY, GATE);
    expect(gate.evaluated).toBe(90);
    expect(gate.taken).toBe(80);
    expect(gate.errors).toBe(0);
  });

  it("counts a dispatch on a gold none, and one where no right agent was offered, as the errors they are", () => {
    const observations = [
      ...confident(40, { fold: 0, right: true }),
      ...confident(40, { fold: 1, right: true }),
      obs({ fold: 1, gold: { kind: "none" }, laya: laya("a", 0.99) }),
      obs({ fold: 1, gold: { kind: "agents", acceptable: ["z"] }, options: ["a", "b"], laya: laya("a", 0.99) }),
    ];
    const gate = simulateGate(observations, LAYA_POLICY, GATE);
    expect(gate.errors).toBe(2);
    expect(gate.takenGoldNone).toBe(1);
    expect(gate.takenUnreachable).toBe(1);
  });

  it("keeps languages apart: German evidence does not vouch for English picks", () => {
    const observations = [
      ...confident(40, { fold: 0, right: true }),
      ...confident(40, { fold: 1, right: true }),
      ...confident(10, { fold: 0, right: true, language: "en" }),
      ...confident(10, { fold: 1, right: true, language: "en" }),
    ];
    const gate = simulateGate(observations, LAYA_POLICY, GATE);
    expect(gate.byLanguage["de"]).toEqual({ evaluated: 80, taken: 80, correct: 80 });
    expect(gate.byLanguage["en"]).toEqual({ evaluated: 20, taken: 0, correct: 0 });
  });

  it("keyed per answer, as production keys it, a pick spread over many agents never gathers enough cases", () => {
    const spread = (["a", "b", "c", "d"] as const).flatMap((choice) => [
      ...confident(10, { fold: 0, right: true, choice }),
      ...confident(10, { fold: 1, right: true, choice }),
    ]);
    expect(simulateGate(spread, LAYA_POLICY, GATE, "language").taken).toBe(80);
    const perAnswer = simulateGate(spread, LAYA_POLICY, GATE, "answer");
    expect(perAnswer.taken).toBe(0);
    expect(perAnswer.folds.every((fold) => Object.keys(fold.qualified).length === 0)).toBe(true);
  });

  it("knows the most cases a perfect answerer could have qualified on, from the gold alone", () => {
    const observations = [
      ...confident(40, { fold: 0, right: false }),
      ...confident(33, { fold: 1, right: false }),
      ...confident(12, { fold: 1, right: false, language: "en" }),
      ...Array.from({ length: 9 }, () => obs({ fold: 1, gold: { kind: "none" }, laya: laya(NONE_KEY) })),
    ];
    // Levels for fold 0 are set on fold 1 (33 German gold-agent cases), and back (40): the gold
    // decides it, so every wrong answer here still leaves a perfect answerer 40.
    expect(simulateGate(observations, LAYA_POLICY, GATE).capacity).toBe(40);
    // Per answer a perfect answerer puts each case in the bucket of an agent it is right for.
    const perAnswer = [
      ...Array.from({ length: 20 }, () => obs({ fold: 0, gold: { kind: "agents", acceptable: ["a", "b"] }, laya: laya("c") })),
      ...Array.from({ length: 7 }, () => obs({ fold: 0, gold: { kind: "agents", acceptable: ["b"] }, laya: laya("c") })),
      ...Array.from({ length: 5 }, () => obs({ fold: 0, gold: { kind: "agents", acceptable: ["d"] }, laya: laya("c") })),
    ];
    expect(simulateGate(perAnswer, LAYA_POLICY, GATE, "answer").capacity).toBe(27);
    expect(simulateGate(perAnswer, LAYA_POLICY, GATE, "language").capacity).toBe(32);
    expect(simulateGate([], LAYA_POLICY, GATE).capacity).toBe(0);
  });

  it("finds a threshold on the embedding score the same way, from the scores it saw", () => {
    const scored = (fold: 0 | 1) => [
      ...Array.from({ length: 40 }, () => obs({ fold, gold: { kind: "agents", acceptable: ["a"] }, optionScores: [0.9, 0.7, 0.6] })),
      ...Array.from({ length: 40 }, () => obs({ fold, gold: { kind: "agents", acceptable: ["b"] }, optionScores: [0.7, 0.69, 0.6] })),
    ];
    const gate = simulateGate([...scored(0), ...scored(1)], EMBEDDING_POLICY, GATE);
    expect(gate.folds.map((fold) => fold.qualified["de"])).toEqual([0.9, 0.9]);
    expect(gate.taken).toBe(80);
    expect(gate.errors).toBe(0);
  });

  it("describes the confidence curve over every answered case, none picks left out", () => {
    const observations = [
      ...confident(10, { fold: 0, right: true, top: 0.99 }),
      ...confident(10, { fold: 0, right: false, top: 0.55 }),
      obs({ gold: { kind: "none" }, laya: laya(NONE_KEY, 0.99) }),
    ];
    const curve = confidenceCurve(observations, 0.9);
    expect(curve.map((row) => row.level)).toEqual([...GATE_LEVELS]);
    expect(curve[0]).toMatchObject({ level: 0.5, taken: 20, correct: 10 });
    expect(curve.find((row) => row.level === 0.6)).toMatchObject({ taken: 10, correct: 10, samplesNeeded: 35 });
    expect(curve[0]!.coverage).toBeCloseTo(20 / 21, 12);
    // Never fewer than the gate's own floor.
    expect(confidenceCurve(observations, 0.9, 50).find((row) => row.level === 0.6)!.samplesNeeded).toBe(50);
  });
});

// ── Verdict, savings, report ─────────────────────────────────────────────────────────────────────

function gateWith(partial: Partial<GateSimulation>): GateSimulation {
  return {
    policy: "laya",
    keying: "language",
    settings: GATE,
    evaluated: 100,
    taken: 0,
    correct: 0,
    errors: 0,
    takenGoldNone: 0,
    takenUnreachable: 0,
    coverage: 0,
    errorRate: null,
    errorRateUpper: null,
    capacity: 100,
    byLanguage: {},
    folds: [],
    ...partial,
  };
}

describe("the verdict", () => {
  const base = { layaSkipped: false, observed: 100, unrouted: 0, asked: 100, answered: 100, minCoverage: 0 };

  it("is never a pass when nothing was scored", () => {
    expect(benchVerdict({ ...base, layaSkipped: true, gate: gateWith({}) }).code).toBe(2);
    expect(benchVerdict({ ...base, asked: 0, answered: 0, gate: gateWith({ evaluated: 0 }) }).code).toBe(2);
  });

  it("blames the environment when Laya did not answer", () => {
    expect(benchVerdict({ ...base, answered: 0, gate: gateWith({}) }).code).toBe(3);
    expect(benchVerdict({ ...base, answered: 89, gate: gateWith({ taken: 50, correct: 50, coverage: 0.5, errorRate: 0 }) }).code).toBe(3);
  });

  it("blames the environment when the embedding search failed on more than a tenth of the cases", () => {
    const passing = gateWith({ taken: 50, correct: 50, coverage: 0.5, errorRate: 0 });
    expect(benchVerdict({ ...base, observed: 89, unrouted: 11, gate: passing }).code).toBe(3);
    expect(benchVerdict({ ...base, observed: 0, unrouted: 5, asked: 0, answered: 0, gate: gateWith({ evaluated: 0 }) }).code).toBe(3);
    expect(benchVerdict({ ...base, observed: 0, unrouted: 5, layaSkipped: true, gate: gateWith({}) }).code).toBe(3);
    expect(benchVerdict({ ...base, observed: 90, unrouted: 10, gate: passing }).code).toBe(0);
  });

  it("is inconclusive, not a failure, when no bucket could have qualified even with every pick right", () => {
    expect(flawlessSamplesNeeded(GATE)).toBe(35);
    expect(flawlessSamplesNeeded({ targetAgreement: 0.9, minSamples: 50 })).toBe(50);
    expect(flawlessSamplesNeeded({ targetAgreement: 1, minSamples: 30 })).toBeNull();
    const inconclusive = benchVerdict({ ...base, gate: gateWith({ capacity: 34 }) });
    expect(inconclusive.code).toBe(2);
    expect(inconclusive.reasons[0]).toContain("at least 35 flawless");
    expect(benchVerdict({ ...base, gate: gateWith({ capacity: 35 }) }).code).toBe(1);
    expect(benchVerdict({ ...base, gate: gateWith({ capacity: 1_000, settings: { targetAgreement: 1, minSamples: 30 } }) }).code).toBe(2);
  });

  it("allows exactly the error the target allows", () => {
    expect(benchVerdict({ ...base, gate: gateWith({ taken: 50, correct: 45, errors: 5, coverage: 0.5, errorRate: 0.1 }) }).code).toBe(0);
    expect(benchVerdict({ ...base, gate: gateWith({ taken: 50, correct: 44, errors: 6, coverage: 0.5, errorRate: 0.12 }) }).code).toBe(1);
  });

  it("fails when no round could be skipped, or the skipped ones were too often wrong, or too few", () => {
    expect(benchVerdict({ ...base, gate: gateWith({}) }).code).toBe(1);
    expect(benchVerdict({ ...base, gate: gateWith({ taken: 50, correct: 40, errors: 10, coverage: 0.5, errorRate: 0.2 }) }).code).toBe(1);
    expect(benchVerdict({ ...base, minCoverage: 0.6, gate: gateWith({ taken: 50, correct: 50, coverage: 0.5, errorRate: 0 }) }).code).toBe(1);
  });

  it("passes when a pick qualified and held on the other fold", () => {
    const verdict = benchVerdict({ ...base, gate: gateWith({ taken: 50, correct: 48, errors: 2, coverage: 0.5, errorRate: 0.04 }) });
    expect(verdict.code).toBe(0);
    expect(verdict.status).toBe("PASS");
  });
});

describe("the savings estimate", () => {
  it("credits only correct picks with a saved round and charges Laya on every turn", () => {
    const savings = estimateSavings(gateWith({ evaluated: 200, taken: 60, correct: 50, errors: 10 }), 20, 8_000);
    expect(savings.per100Turns).toEqual({
      skippedCorrectly: 25,
      wrongDispatches: 5,
      grossSecondsSaved: 200,
      layaSecondsSpent: 2,
      netSeconds: 198,
    });
    expect(estimateSavings(gateWith({ evaluated: 0 }), 20, 8_000).per100Turns).toBeNull();
  });
});

const SETTINGS: PreRouteBenchSettings = {
  k: 8,
  split: "all",
  describe: "description",
  keying: "language",
  target: 0.9,
  minSamples: 30,
  roundMs: 7_900,
  minCoverage: 0,
  layaUrl: "http://127.0.0.1:18080",
  casesFile: "eval/routing/live-cases.jsonl",
};

describe("the report", () => {
  const observations = [
    ...confident(40, { fold: 0, right: true }).map((o) => ({ ...o, split: "calibration" as const })),
    ...confident(40, { fold: 1, right: true }).map((o) => ({ ...o, split: "test" as const })),
    ...confident(6, { fold: 0, right: true, language: "en" }).map((o) => ({ ...o, split: "test" as const })),
  ];

  it("slices by language and by the test half, and reads the verdict off the headline gate", () => {
    const report = buildPreRouteReport({ settings: SETTINGS, observations, loaded: 90, skipped: [{ id: "d", reason: "directive" }], noCandidates: [], overWindow: 0, layaSkipped: false });
    expect(Object.keys(report.slices)).toEqual(["all", "de", "en", "test", "test/de", "test/en"]);
    expect(report.slices["test"]!.cases).toBe(46);
    expect(report.gate.headline).toBe("laya");
    expect(report.gate.laya.taken).toBe(80);
    expect(report.gate.layaPerAnswer.taken).toBe(80);
    expect(report.gate.layaTestHalf?.evaluated).toBe(46);
    expect(report.verdict.code).toBe(0);
    expect(report.warnings.some((warning) => warning.includes("no gold-none"))).toBe(true);
    const markdown = formatPreRouteMarkdown(report);
    expect(markdown).toContain("**PASS**");
    expect(markdown).toContain("| | all | de | en | test | test/de | test/en |");
    expect(markdown).toContain("same agent as last turn");
    expect(markdown).toContain("| largest bucket |");
  });

  it("reads the per-answer gate when asked to, as production would key it", () => {
    const spread = (["a", "b", "c", "d"] as const).flatMap((choice) => [
      ...confident(10, { fold: 0, right: true, choice }),
      ...confident(10, { fold: 1, right: true, choice }),
    ]);
    const report = buildPreRouteReport({ settings: { ...SETTINGS, keying: "answer" }, observations: spread, loaded: 80, skipped: [], noCandidates: [], overWindow: 0, layaSkipped: false });
    expect(report.gate.headline).toBe("layaPerAnswer");
    expect(report.gate.laya.taken).toBe(80);
    // Ten cases per agent per fold: no answer could have gathered 35, so this says nothing either way.
    expect(report.gate.layaPerAnswer.capacity).toBe(10);
    expect(report.verdict.code).toBe(2);
  });

  it("blames the environment when the embedding search lost more than a tenth of the cases", () => {
    const lost = Array.from({ length: 10 }, (_, i) => `lost-${i}`);
    const report = buildPreRouteReport({ settings: SETTINGS, observations, loaded: 96, skipped: [], noCandidates: lost, overWindow: 0, layaSkipped: false });
    expect(report.gate.laya.taken).toBe(80);
    expect(report.verdict.code).toBe(3);
    expect(report.verdict.reasons[0]).toContain("10 of 96");
  });

  it("reports a run without Laya as inconclusive, with the baselines still measured", () => {
    const withoutLaya = observations.map(({ laya: _laya, ...rest }) => rest);
    const report = buildPreRouteReport({ settings: { ...SETTINGS, layaUrl: null }, observations: withoutLaya, loaded: 86, skipped: [], noCandidates: ["x"], overWindow: 2, layaSkipped: true });
    expect(report.verdict.code).toBe(2);
    expect(report.slices["all"]!.embeddingTop1.of).toBe(86);
    expect(report.gate.embedding.evaluated).toBe(86);
    expect(report.warnings.some((warning) => warning.includes("window"))).toBe(true);
    expect(formatPreRouteMarkdown(report)).toContain("**INCONCLUSIVE**");
    expect(formatPreRouteMarkdown(report)).toContain("1 case(s) could not be ranked");
  });
});

// ── Arguments ────────────────────────────────────────────────────────────────────────────────────

describe("the command line", () => {
  it("defaults to K 8, every case, the local sidecar and a 0.9 target", () => {
    expect(parsePreRouterArgs([])).toEqual({
      k: 8,
      layaUrl: "http://127.0.0.1:18080",
      split: "all",
      describe: "description",
      keying: "language",
      target: 0.9,
      minSamples: 30,
      roundMs: 7_900,
      minCoverage: 0,
      noLaya: false,
    });
  });

  it("reads every flag", () => {
    expect(parsePreRouterArgs([
      "--cases", "x.jsonl", "--k", "12", "--laya-url", "http://h:1/", "--out", "o", "--split", "test",
      "--train-out", "t.jsonl", "--describe", "oneliner", "--keying", "answer", "--target", "0.95",
      "--min-samples", "35", "--round-ms", "5000", "--min-coverage", "0.2", "--limit", "10", "--no-laya",
    ])).toEqual({
      cases: "x.jsonl", k: 12, layaUrl: "http://h:1", out: "o", split: "test", trainOut: "t.jsonl",
      describe: "oneliner", keying: "answer", target: 0.95, minSamples: 35, roundMs: 5_000, minCoverage: 0.2,
      limit: 10, noLaya: true,
    });
  });

  it("passes over the separator pnpm may hand through", () => {
    expect(parsePreRouterArgs(["--", "--k", "4"]).k).toBe(4);
  });

  it("refuses K 20, which would send 21 options, and any other mistake rather than running the defaults", () => {
    expect(() => parsePreRouterArgs(["--k", "20"])).toThrow(/at most 19 agents/);
    expect(() => parsePreRouterArgs(["--k", "0"])).toThrow();
    expect(() => parsePreRouterArgs(["--K", "8"])).toThrow(/unknown flag/);
    expect(() => parsePreRouterArgs(["--k"])).toThrow(/needs a value/);
    expect(() => parsePreRouterArgs(["--split", "train"])).toThrow(/one of/);
    expect(() => parsePreRouterArgs(["--target", "1.5"])).toThrow();
  });
});

// ── The readout backend ──────────────────────────────────────────────────────────────────────────

/** A readout's pick: its log-scores over the options served, "none" last; argmax and top at T = 1. */
function readoutPick(scores: number[], keys: readonly string[]): PreRouteObservation["laya"] {
  const p = applyTemperature(scores, 1);
  const best = p.indexOf(Math.max(...p));
  return { choice: keys[best]!, top: p[best]!, ms: 900, model: "readout:qwen", logScores: scores };
}

describe("the readout backend", () => {
  it("asks the resident model the same question under the same letters Laya reads, none last and always offered", () => {
    const built = build(agents(30), 5)!;
    const { messages, keys } = buildReadoutMessages(built.request, built.request.state);
    const { criteria } = servedCriteria(built.request.options);
    expect(keys).toEqual(built.keys);
    expect(keys.at(-1)).toBe(NONE_KEY);
    for (const [letter, description] of Object.entries(criteria)) expect(messages[0]!.content).toContain(`${letter}: ${description}`);
    expect(messages[0]!.content).toContain(`${LETTERS[keys.length - 1]}: ${NONE_DESCRIPTION}`);
    expect(messages[1]!.content).toContain(built.request.state.message);
  });

  it("takes a readout's answer as the observation's pick, with its log-scores in the order served", () => {
    const keys = ["researcher", "coder", NONE_KEY];
    const pick = pickFromReadout({
      ok: true,
      answer: { choice: "coder", top: 0.7, probabilities: {}, logScores: { researcher: -2, coder: -0.4, none: -1.5 }, mass: 0.97, temperature: 1, topToken: "B", ms: 850 },
    }, keys, "readout:qwen");
    expect(pick).toEqual({ choice: "coder", top: 0.7, ms: 850, model: "readout:qwen", logScores: [-2, -0.4, -1.5] });
  });

  it("counts a miss as no answer, as a failed Laya call is: the turn would go to the orchestrator", () => {
    expect(pickFromReadout({ ok: false, reason: "control_token", ms: 800, topToken: "<think>" }, ["a", NONE_KEY], "m")).toEqual({ error: 'readout: control_token (top token "<think>")' });
    expect(pickFromReadout({ ok: false, reason: "no_logprobs", ms: 800 }, ["a", NONE_KEY], "m")).toEqual({ error: "readout: no_logprobs" });
  });

  it("refuses an answer that does not score every option served: its log-scores would not line up with the letters", () => {
    const answer = { choice: "a", top: 0.9, probabilities: {}, logScores: { a: -0.1 }, mass: 0.99, temperature: 1, topToken: "A", ms: 850 };
    expect(pickFromReadout({ ok: true, answer }, ["a", NONE_KEY], "m")).toEqual({ error: "readout: the answer does not fit the options" });
    expect(pickFromReadout({ ok: true, answer: { ...answer, choice: "b" } }, ["a", NONE_KEY], "m")).toMatchObject({ error: expect.any(String) });
  });

  it("tells a readout's miss from an outage: only an outage trips the run's breaker or stops its warm-up", () => {
    const miss = (reason: "no_letter" | "control_token" | "low_mass", topToken: string) => {
      const picked = pickFromReadout({ ok: false, reason, ms: 800, topToken }, ["a", NONE_KEY], "m");
      return "error" in picked ? picked.error : "";
    };
    expect(isAnswererOutage(miss("no_letter", "The"))).toBe(false);
    expect(isAnswererOutage(miss("control_token", "<think>"))).toBe(false);
    expect(isAnswererOutage(miss("low_mass", "Sure"))).toBe(false);
    for (const reason of ["no_logprobs", "error", "aborted"] as const) {
      const picked = pickFromReadout({ ok: false, reason, ms: 10_000 }, ["a", NONE_KEY], "m");
      expect(isAnswererOutage("error" in picked ? picked.error : ""), reason).toBe(true);
    }
    expect(isAnswererOutage("readout: the answer does not fit the options")).toBe(true);
    expect(isAnswererOutage("HTTP 503"), "every failed Laya answer is one").toBe(true);
  });

  it("never dispatches on a confident none: the protected answer hands the turn back", () => {
    const keys = ["a", "b", "c", NONE_KEY];
    const observations = Array.from({ length: 80 }, (_, i) => obs({
      fold: (i % 2) as 0 | 1,
      gold: { kind: "none" },
      laya: readoutPick([-6, -6, -6, -0.01], keys),
    }));
    const gate = simulateGate(observations, LAYA_POLICY, GATE);
    expect(gate.evaluated).toBe(80);
    expect(gate.taken).toBe(0);
  });

  it("scores its calibration cross-fitted: each fold at the temperature fitted on the other, and a fit helps an overconfident readout", () => {
    const keys = ["a", "b", "c", NONE_KEY];
    // Always 99% sure of "a", right half the time: overconfident, which a temperature above 1 repairs.
    const observations = Array.from({ length: 200 }, (_, i) => obs({
      fold: (i % 2) as 0 | 1,
      gold: { kind: "agents", acceptable: [i % 4 < 2 ? "a" : "b"] },
      laya: readoutPick([0, -5.3, -8, -8], keys),
    }));
    const block = preRouteCalibration(observations)!;
    expect(block.cases).toBe(200);
    expect(block.folds.map((fold) => fold.fittedOn)).toEqual([100, 100]);
    expect(block.folds.every((fold) => fold.temperature > 1)).toBe(true);
    expect(block.eceBefore).toBeGreaterThan(0.4);
    expect(block.eceAfter!).toBeLessThan(block.eceBefore!);
    expect(preRouteCalibration([obs({ gold: { kind: "none" }, laya: laya(NONE_KEY) })]), "Laya's answers carry no log-scores").toBeNull();
  });

  it("scores each fold at the other fold's temperature: an always-right fold 1 sharpens fold 0, an overconfident fold 0 softens fold 1", () => {
    const keys = ["a", "b", "c", NONE_KEY];
    const foldZero = Array.from({ length: 100 }, (_, i) => obs({ fold: 0, gold: { kind: "agents", acceptable: [i % 2 === 0 ? "a" : "b"] }, laya: readoutPick([0, -5.3, -8, -8], keys) }));
    const foldOne = Array.from({ length: 100 }, () => obs({ fold: 1, gold: { kind: "agents", acceptable: ["a"] }, laya: readoutPick([0, -1, -2, -2], keys) }));
    const block = preRouteCalibration([...foldZero, ...foldOne])!;
    const [zero, one] = block.folds;
    expect(zero!.temperature, "fold 0 is scored at fold 1's temperature").toBeLessThan(1);
    expect(one!.temperature, "fold 1 is scored at fold 0's temperature").toBeGreaterThan(1);
  });

  it("puts the top-1 threshold exactly at 85%", () => {
    const keys = ["a", "b", "c", NONE_KEY];
    const cases = (right: number, wrong: number) => [
      ...Array.from({ length: right }, () => obs({ gold: { kind: "agents", acceptable: ["a"] }, laya: readoutPick([-0.05, -4, -5, -5], keys) })),
      ...Array.from({ length: wrong }, () => obs({ gold: { kind: "agents", acceptable: ["b"] }, laya: readoutPick([-0.05, -4, -5, -5], keys) })),
      ...Array.from({ length: 80 }, () => obs({ gold: { kind: "none" }, laya: readoutPick([-5, -5, -5, -0.05], keys) })),
    ];
    // 170 of 200 is 85%; 169 of 200 is not.
    expect(stageOneCriteria(scorePreRoute(cases(90, 30))).met).toBe(true);
    expect(stageOneCriteria(scorePreRoute(cases(89, 31))).met).toBe(false);
  });

  it("says stage 1 is met only at 85% top-1 and a none-recall lower bound of 0.95", () => {
    const keys = ["a", "b", "c", NONE_KEY];
    const right = (n: number) => Array.from({ length: n }, () => obs({ gold: { kind: "agents", acceptable: ["a"] }, laya: readoutPick([-0.05, -4, -5, -5], keys) }));
    const none = (n: number, missed = 0) => Array.from({ length: n }, (_, i) => obs({ gold: { kind: "none" }, laya: readoutPick(i < missed ? [-0.05, -4, -5, -5] : [-5, -5, -5, -0.05], keys) }));
    // 73 of 73 is the fewest flawless "none" cases whose lower bound reaches 0.95.
    expect(wilsonLowerBound(73, 73)).toBeGreaterThanOrEqual(0.95);
    expect(wilsonLowerBound(72, 72)).toBeLessThan(0.95);
    expect(stageOneCriteria(scorePreRoute([...right(100), ...none(73)])).met).toBe(true);
    const fewNone = stageOneCriteria(scorePreRoute([...right(100), ...none(72)]));
    expect(fewNone.met).toBe(false);
    expect(fewNone.reasons.join(" ")).toContain("lower bound");
    const oneMissed = stageOneCriteria(scorePreRoute([...right(300), ...none(100, 1)]));
    expect(oneMissed.met, "a none dispatched to a specialist costs minutes").toBe(false);
    const weak = stageOneCriteria(scorePreRoute([...right(50), ...Array.from({ length: 50 }, () => obs({ gold: { kind: "agents", acceptable: ["b"] }, laya: readoutPick([-0.05, -4, -5, -5], keys) })), ...none(80)]));
    expect(weak.met).toBe(false);
    expect(weak.reasons.join(" ")).toContain("top-1");
    expect(stageOneCriteria(scorePreRoute([])).met).toBe(false);
  });

  it("names the readout in the report and adds the stage and calibration sections; Laya's window does not apply", () => {
    const keys = ["a", "b", "c", NONE_KEY];
    const observations = Array.from({ length: 80 }, (_, i) => obs({
      fold: (i % 2) as 0 | 1,
      split: "test",
      gold: { kind: "agents", acceptable: ["a"] },
      laya: readoutPick([-0.05, -4, -5, -5], keys),
    }));
    const report = buildPreRouteReport({
      settings: { ...SETTINGS, layaUrl: null, backend: "readout", readoutModel: "qwen" },
      observations, loaded: 80, skipped: [], noCandidates: [], overWindow: 3, layaSkipped: false,
    });
    expect(report.calibration?.["all"]?.cases).toBe(80);
    expect(report.stage.top1).toBe(1);
    expect(report.warnings.some((warning) => warning.includes("window"))).toBe(false);
    expect(report.warnings.some((warning) => warning.includes("whether Readout leaves"))).toBe(true);
    const markdown = formatPreRouteMarkdown(report);
    expect(markdown).toContain("**Readout top-1**");
    expect(markdown).toContain("Readout of qwen");
    expect(markdown).toContain("## Stage 1");
    expect(markdown).toContain("## Calibration");
    expect(markdown).toContain("| level | taken | right | misrouted |");
    expect(markdown).not.toContain("Laya top-1");
    expect(answererName(undefined)).toBe("Laya");
  });

  it("reads --backend, and refuses anything but laya or readout", () => {
    expect(parsePreRouterArgs(["--backend", "readout"]).backend).toBe("readout");
    expect(parsePreRouterArgs(["--backend", "laya"]).backend).toBe("laya");
    expect(parsePreRouterArgs([]).backend).toBeUndefined();
    expect(() => parsePreRouterArgs(["--backend", "jev"])).toThrow(/one of laya, readout/);
  });
});
