/**
 * The intent readout (decisions/intent-readout.ts): the grammar and the frozen prefix generated from
 * the facet definitions, each facet's letter located in a recorded token list and read off its top
 * list, the renormalisation, the temperature, the margin, the call, the both-orders readout (the
 * options reversed on a second call, the two averaged per option), and the pre-router's readout
 * with "none" protected. Pure logic and recorded providers only — no model is called.
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { warmTextLanguageDetector } from "../agent/text-language.js";
import { buildTriageMessages, TRIAGE_RESPONSE_SCHEMA, TRIAGE_SYSTEM_PROMPT, type TriageVerdict } from "../agent/triage.js";
import {
  acceptPreRoute,
  askIntentReadout,
  askPreRouteReadout,
  averageOrderReadings,
  buildIntentGrammar,
  buildIntentReadoutMessages,
  buildIntentReadoutSystemPrompt,
  DEFAULT_CONFIDENCE,
  INTENT_FACET_BY_NAME,
  INTENT_FACETS,
  INTENT_READOUT_BOTH_ORDERS_VERSION,
  INTENT_READOUT_GRAMMAR,
  INTENT_READOUT_MAX_TOKENS,
  INTENT_READOUT_SYSTEM_PROMPT,
  INTENT_READOUT_VERSION,
  intentRequestFacets,
  isConfident,
  locateSlot,
  marginOf,
  parseIntentReadout,
  preRouteReadoutFrom,
  readFacetSlot,
  reversedFacets,
  slotLetterOf,
  triageVerdictKeys,
  type IntentFacetDefinition,
  type IntentFacetName,
  type PreRouteReadout,
} from "../decisions/intent-readout.js";
import { applyTemperature, LETTERS } from "../decisions/logit-readout.js";
import { NONE_DESCRIPTION, NONE_KEY, PRE_ROUTE_QUESTION } from "../decisions/pre-route-question.js";
import type { CompletionCallOptions, LLMMessage, LLMResponse, LLMTokenLogprob } from "../providers/lmstudio.js";

type Top = Array<[string, number]>;

/** sha256 of the intent-readout-v1 prefix and grammar, first 16 hex digits. */
const PINNED_HASH = "8befdb40c9a072b9";

/** sha256 of the intent-readout-v1 case template (triage's user message, its wording and cuts), first 16 hex digits. */
const PINNED_CASE_HASH = "0fa0b81078aa2c65";

/** sha256 of the intent-readout-v1:both-orders prefixes and grammars (served, then reversed), first 16 hex digits. */
const PINNED_BOTH_ORDERS_HASH = "ede0afae784d6e12";

/** One generated token as readChoiceLogprobs hands it over. */
function tok(token: string, top: Top = [[token, -0.01], ["\n", -6]]): LLMTokenLogprob {
  const own = top.find(([t]) => t === token)?.[1] ?? -0.01;
  return { token, logprob: own, topLogprobs: top.map(([t, logprob]) => ({ token: t, logprob })) };
}

/**
 * A reply as llama-server tokenised it on 2026-09-28: the label, ":", the letter WITH its leading
 * space as one token (" C"), a newline; the restatement last. `slots` gives each facet's written
 * letter and its top list; a facet left out has no line at all.
 */
function reply(slots: Partial<Record<string, { written: string; top: Top }>>, query = " Restated request."): LLMTokenLogprob[] {
  const tokens: LLMTokenLogprob[] = [];
  for (const definition of INTENT_FACETS) {
    const slot = slots[definition.name];
    if (!slot) continue;
    if (tokens.length > 0) tokens.push(tok("\n"));
    tokens.push(tok(definition.name), tok(":"), tok(` ${slot.written}`, slot.top));
  }
  tokens.push(tok("\n"), tok("query"), tok("_en"), tok(":"));
  for (const word of query.match(/ ?[^ ]+/g) ?? []) tokens.push(tok(word));
  return tokens;
}

/** The slot `mode` of a German price question, as measured (the letters, then raw non-letter tokens). */
const MEASURED_MODE: Top = [[" B", -0.58], [" A", -0.95], [" E", -3.19], [" D", -4.84], [" **", -5.2], ["\n", -6.1]];

/** A confident two-letter slot. */
const YES: Top = [[" A", -0.02], [" B", -4.1], ["\n", -7]];
const NO: Top = [[" B", -0.05], [" A", -3.2], ["\n", -7]];

const FULL = {
  mode: { written: "B", top: MEASURED_MODE },
  domain: { written: "A", top: [[" A", -0.1], [" D", -2.6], [" K", -4.0], ["\n", -8]] as Top },
  deliverable: { written: "A", top: [[" A", -0.3], [" B", -1.6], [" L", -3.3], [" O", -4.4]] as Top },
  multi: { written: "B", top: NO },
  alone: { written: "A", top: YES },
  source_sensitive: { written: "A", top: YES },
  decision: { written: "B", top: [[" B", -0.4], [" A", -1.3], [" D", -3.0], [" C", -5.5]] as Top },
};

describe("the grammar and the prefix, generated from the facets", () => {
  it("writes one line per facet in order, with exactly that facet's letters, and the restatement last", () => {
    expect(INTENT_READOUT_GRAMMAR).toBe(
      "root ::= \"mode: \" [A-F] \"\\ndomain: \" [A-K] \"\\ndeliverable: \" [A-O] \"\\nmulti: \" [A-B] \"\\nalone: \" [A-B] "
      + "\"\\nsource_sensitive: \" [A-B] \"\\ndecision: \" [A-E] \"\\nquery_en: \" [^\\r\\n]{1,200}",
    );
  });

  it("sizes each letter class from the facet's options and bounds the sentence as asked", () => {
    const facets: IntentFacetDefinition[] = [
      { name: "multi", question: "q", keys: ["yes", "no", "maybe"], descriptions: {} },
      { name: "alone", question: "q", keys: ["yes", "no"], descriptions: {} },
    ];
    expect(buildIntentGrammar(facets, 50)).toBe("root ::= \"multi: \" [A-C] \"\\nalone: \" [A-B] \"\\nquery_en: \" [^\\r\\n]{1,50}");
    expect(() => buildIntentGrammar([{ name: "mode", question: "q", keys: ["only"], descriptions: {} }])).toThrow(RangeError);
    expect(() => buildIntentGrammar(facets, 0)).toThrow(RangeError);
  });

  it("shows every option under the letter the grammar gives it, and asks for the lines in the grammar's order", () => {
    for (const definition of INTENT_FACETS) {
      definition.keys.forEach((key, i) => {
        expect(INTENT_READOUT_SYSTEM_PROMPT).toContain(`\n${LETTERS[i]}: ${key}`);
      });
    }
    const form = INTENT_READOUT_SYSTEM_PROMPT.slice(INTENT_READOUT_SYSTEM_PROMPT.lastIndexOf("Reply in exactly this form"));
    expect(form.split("\n").slice(1).map((line) => line.split(":")[0])).toEqual([...INTENT_FACETS.map((f) => f.name), "query_en"]);
  });

  it("offers triage's own values in triage's order, the primary domain adding 'other' last", () => {
    const properties = TRIAGE_RESPONSE_SCHEMA["properties"] as Record<string, { enum?: string[]; items?: { enum: string[] } }>;
    expect(INTENT_FACET_BY_NAME.mode.keys).toEqual(properties["mode"]!.enum);
    expect(INTENT_FACET_BY_NAME.deliverable.keys).toEqual(properties["deliverable"]!.enum);
    expect(INTENT_FACET_BY_NAME.decision.keys).toEqual(properties["decision"]!.enum);
    expect(INTENT_FACET_BY_NAME.domain.keys).toEqual([...properties["domain"]!.items!.enum, "other"]);
    for (const name of ["multi", "alone", "source_sensitive"] as const) expect(INTENT_FACET_BY_NAME[name].keys).toEqual(["yes", "no"]);
  });

  it("defines source sensitivity with the judge's contract as triage states it", () => {
    const contract = "SPECIFIC checkable real-world facts: a named organisation, product, price, rate, statistic, law, version, or exactly how a particular real system works";
    expect(TRIAGE_SYSTEM_PROMPT).toContain(contract);
    expect(INTENT_FACET_BY_NAME.source_sensitive.question).toContain(contract);
  });

  it("keeps the prefix frozen and catalog-blind: every request shares it, and the case is the user message triage builds", () => {
    const one = buildIntentReadoutMessages({ userMessage: "first request" });
    const two = buildIntentReadoutMessages({ userMessage: "second request", priorTurnDigest: "earlier turn" });
    expect(one[0]).toEqual(two[0]);
    expect(one[0]!.content).toBe(INTENT_READOUT_SYSTEM_PROMPT);
    expect(one[1]).toEqual(buildTriageMessages({ userMessage: "first request" })[1]);
    expect(two[1]).toEqual(buildTriageMessages({ userMessage: "second request", priorTurnDigest: "earlier turn" })[1]);
  });

  it("changes the prefix or the grammar only with the version", () => {
    // A failure here means the prefix or the grammar changed: bump INTENT_READOUT_VERSION and record the new hash.
    const hash = createHash("sha256").update(INTENT_READOUT_SYSTEM_PROMPT).update("\u0000").update(INTENT_READOUT_GRAMMAR).digest("hex").slice(0, 16);
    expect({ version: INTENT_READOUT_VERSION, hash }).toEqual({ version: "intent-readout-v1", hash: PINNED_HASH });
  });

  it("changes the case template only with the version, though triage's file holds it", () => {
    // The user message is triage's (buildTriageMessages), so its wording or its cuts can change in
    // agent/triage.ts without a line of the readout changing — and the model reads a different case.
    // A failure here means that happened: bump INTENT_READOUT_VERSION and record the new hash.
    const cases = [
      buildIntentReadoutMessages({ userMessage: "<message>" })[1]!.content,
      buildIntentReadoutMessages({ userMessage: "<message>", priorTurnDigest: "<digest>" })[1]!.content,
      buildIntentReadoutMessages({ userMessage: "m".repeat(5000), priorTurnDigest: "d".repeat(5000) })[1]!.content,
    ];
    const caseHash = createHash("sha256").update(JSON.stringify(cases)).digest("hex").slice(0, 16);
    expect({ version: INTENT_READOUT_VERSION, caseHash }).toEqual({ version: "intent-readout-v1", caseHash: PINNED_CASE_HASH });
  });

  it("names the both-orders readout apart from one order's, and changes its reversed prefix only with it", () => {
    // Its readings are not one pass's: two rows of the two modes are never counted together.
    expect(INTENT_READOUT_BOTH_ORDERS_VERSION).not.toBe(INTENT_READOUT_VERSION);
    // A failure here means the served or the reversed prefix or grammar changed: bump the version
    // (INTENT_READOUT_VERSION for the prefix; the suffix for how the two are combined) and record the new hash.
    const reversed = reversedFacets();
    const hash = createHash("sha256")
      .update(INTENT_READOUT_SYSTEM_PROMPT).update("\u0000").update(INTENT_READOUT_GRAMMAR).update("\u0000")
      .update(buildIntentReadoutSystemPrompt(reversed)).update("\u0000").update(buildIntentGrammar(reversed))
      .digest("hex").slice(0, 16);
    expect({ version: INTENT_READOUT_BOTH_ORDERS_VERSION, hash }).toEqual({ version: "intent-readout-v1:both-orders", hash: PINNED_BOTH_ORDERS_HASH });
  });
});

describe("finding a facet's letter in the token list", () => {
  it("takes the token that covers the letter: ' C' after ':' on the measured tokenisation", () => {
    const tokens = [tok("mode"), tok(":"), tok(" C"), tok("\n"), tok("domain"), tok(":"), tok(" A")];
    expect(locateSlot(tokens, "mode")).toEqual({ tokenIndex: 2, valueOffset: 6, lead: " " });
    expect(locateSlot(tokens, "domain")).toEqual({ tokenIndex: 6, valueOffset: 16, lead: " " });
  });

  it("finds a letter merged with the colon (':C', ': C') and a bare one after a separate space", () => {
    expect(locateSlot([tok("mode"), tok(":C"), tok("\n")], "mode")).toEqual({ tokenIndex: 1, valueOffset: 5, lead: ":" });
    expect(locateSlot([tok("mode"), tok(": C"), tok("\n")], "mode")).toEqual({ tokenIndex: 1, valueOffset: 6, lead: ": " });
    expect(locateSlot([tok("mode"), tok(": "), tok("C")], "mode")).toEqual({ tokenIndex: 2, valueOffset: 6, lead: "" });
  });

  it("has no slot for a missing line, an empty value, or a label that does not start its line", () => {
    const tokens = [tok("mode"), tok(":"), tok(" C"), tok("\n"), tok("query"), tok("_en"), tok(":"), tok(" the"), tok(" decision:"), tok(" B")];
    expect(locateSlot(tokens, "alone")).toBeUndefined();
    expect(locateSlot(tokens, "decision")).toBeUndefined();
    expect(locateSlot([tok("mode"), tok(":"), tok("\n"), tok("domain")], "mode")).toBeUndefined();
    expect(locateSlot([tok("mode"), tok(":")], "mode")).toBeUndefined();
  });

  it("reads an alternative only where it could stand in the slot", () => {
    const merged = slotLetterOf(":", 6);
    expect([":A", ": B", " :C", " A", "A", ":G", ":"].map(merged)).toEqual(["A", "B", "C", undefined, undefined, undefined, undefined]);
    const spaced = slotLetterOf(" ", 6);
    expect([" A", "A", "B.", " F", " G", " **", "\n"].map(spaced)).toEqual(["A", "A", "B", "F", undefined, undefined, undefined]);
  });
});

describe("reading a slot", () => {
  it("renormalises the raw top list over the facet's letters, ' X' and 'X' summed, a missing letter at the list's floor", () => {
    const top: Top = [[" B", -0.58], [" A", -0.95], ["B", -2.0], [" E", -3.19], [" D", -4.84], [" **", -5.2], ["\n", -6.1]];
    const read = readFacetSlot([tok("mode"), tok(":"), tok(" B", top)], INTENT_FACET_BY_NAME.mode, 1);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const b = Math.exp(-0.58) + Math.exp(-2.0);
    const raw = { converse: Math.exp(-0.95), GATHER: b, PRODUCE: Math.exp(-6.1), ACT: Math.exp(-4.84), VERIFY: Math.exp(-3.19), ORCHESTRATE: Math.exp(-6.1) };
    const sum = Object.values(raw).reduce((s, p) => s + p, 0);
    for (const [key, p] of Object.entries(raw)) expect(read.read.probabilities[key]).toBeCloseTo(p / sum, 10);
    expect(read.read.choice).toBe("GATHER");
    expect(read.read.mass).toBeCloseTo(Math.exp(-0.95) + b + Math.exp(-3.19) + Math.exp(-4.84), 10);
    expect(read.read.sampled).toBe("GATHER");
  });

  it("reads a merged ':C' slot over its ':X' alternatives and not over a ' X' that could not stand there", () => {
    const top: Top = [[":C", -0.3], [":A", -1.6], [" A", -1.9], [": B", -2.5], ["\n", -7]];
    const read = readFacetSlot([tok("mode"), tok(":C", top), tok("\n")], INTENT_FACET_BY_NAME.mode, 1);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const floor = Math.exp(-7);
    const raw = [Math.exp(-1.6), Math.exp(-2.5), Math.exp(-0.3), floor, floor, floor];
    const sum = raw.reduce((s, p) => s + p, 0);
    expect(read.read.probabilities["converse"]).toBeCloseTo(raw[0]! / sum, 10);
    expect(read.read.probabilities["PRODUCE"]).toBeCloseTo(raw[2]! / sum, 10);
    expect(read.read.choice).toBe("PRODUCE");
    expect(read.read.sampled).toBe("PRODUCE");
  });

  it("reports the argmax beside the letter the sampler wrote, when they differ", () => {
    const top: Top = [[" A", -0.3], [" B", -1.4], ["\n", -6]];
    const read = readFacetSlot([tok("multi"), tok(":"), tok(" B", top)], INTENT_FACET_BY_NAME.multi, 1);
    expect(read.ok && read.read.choice).toBe("yes");
    expect(read.ok && read.read.sampled).toBe("no");
  });

  it("misses, and says why, on a control token on top, no letter, too little mass or no list", () => {
    const at = (top: Top) => readFacetSlot([tok("alone"), tok(":"), tok(" A", top)], INTENT_FACET_BY_NAME.alone, 1);
    expect(at([["<|im_end|>", -0.1], [" A", -2.5]])).toEqual({ ok: false, miss: { reason: "control_token", topToken: "<|im_end|>" } });
    expect(at([[" **", -0.1], ["\n", -2.5]])).toEqual({ ok: false, miss: { reason: "no_letter", topToken: " **" } });
    expect(at([[" **", -0.2], [" A", -2.5], ["\n", -3]])).toEqual({ ok: false, miss: { reason: "low_mass", topToken: " **" } });
    expect(at([])).toEqual({ ok: false, miss: { reason: "no_logprobs" } });
  });
});

describe("the whole reply", () => {
  it("reads every facet off a recorded reply, with the restatement", () => {
    const readout = parseIntentReadout(reply(FULL), { language: "de" });
    expect(Object.fromEntries(Object.entries(readout.facets).map(([name, read]) => [name, read!.choice]))).toEqual({
      mode: "GATHER", domain: "research", deliverable: "evidence", multi: "no", alone: "yes", source_sensitive: "yes", decision: "single_agent",
    });
    expect(readout.misses).toEqual({});
    expect(readout.queryEn).toBe("Restated request.");
    expect(readout.version).toBe(INTENT_READOUT_VERSION);
    expect(readout.language).toBe("de");
  });

  it("leaves out a facet it cannot read and still counts the others", () => {
    const { alone: _alone, ...rest } = FULL;
    const tokens = reply({ ...rest, decision: { written: "B", top: [["<think>", -0.2], [" B", -2]] } });
    const readout = parseIntentReadout(tokens);
    expect(readout.facets.alone).toBeUndefined();
    expect(readout.facets.decision).toBeUndefined();
    expect(readout.misses).toEqual({ alone: { reason: "no_slot" }, decision: { reason: "control_token", topToken: "<think>" } });
    expect(Object.keys(readout.facets).sort()).toEqual(["deliverable", "domain", "mode", "multi", "source_sensitive"]);
  });

  it("misses a facet whose letter token was dropped from the list, rather than reading its neighbour", () => {
    const tokens = reply(FULL).filter((entry, i, all) => !(entry.token === " B" && all[i - 2]?.token === "mode"));
    const readout = parseIntentReadout(tokens);
    expect(readout.misses.mode).toEqual({ reason: "no_slot" });
    expect(readout.facets.domain?.choice).toBe("research");
  });

  it("takes the restatement from the reply's own text when given, the tokens otherwise", () => {
    const tokens = reply(FULL, " Tokens� text.");
    expect(parseIntentReadout(tokens).queryEn).toBe("Tokens� text.");
    expect(parseIntentReadout(tokens, { content: "mode: B\nquery_en: The reply's text." }).queryEn).toBe("The reply's text.");
    expect(parseIntentReadout([tok("mode"), tok(":"), tok(" B", MEASURED_MODE)]).queryEn).toBe("");
  });
});

describe("the temperature and the margin", () => {
  it("divides a facet's letters by its temperature for the request's language, and by 1 elsewhere", () => {
    const temperatures = { mode: { de: 2.5 } };
    const de = parseIntentReadout(reply(FULL), { language: "de", temperatures });
    const en = parseIntentReadout(reply(FULL), { language: "en", temperatures });
    const mode = de.facets.mode!;
    const order = INTENT_FACET_BY_NAME.mode.keys.map((key) => mode.logScores[key]!);
    const expected = applyTemperature(order, 2.5);
    INTENT_FACET_BY_NAME.mode.keys.forEach((key, i) => expect(mode.probabilities[key]).toBeCloseTo(expected[i]!, 10));
    expect(mode.temperature).toBe(2.5);
    expect(en.facets.mode!.temperature).toBe(1);
    expect(de.facets.domain!.temperature).toBe(1);
    expect(mode.top).toBeLessThan(en.facets.mode!.top);
    const invalid = parseIntentReadout(reply(FULL), { language: "de", temperatures: { mode: { de: 0 }, domain: { de: Number.NaN } } });
    expect(invalid.facets.mode!.temperature).toBe(1);
    expect(invalid.facets.domain!.temperature).toBe(1);
  });

  it("gives the lead of the top option over the runner-up", () => {
    expect(marginOf({ a: 0.6, b: 0.3, c: 0.1 })).toEqual({ runnerUp: "b", margin: expect.closeTo(0.3, 10) });
    expect(marginOf({ a: 1 })).toEqual({ runnerUp: undefined, margin: 1 });
    expect(marginOf({})).toEqual({ runnerUp: undefined, margin: 0 });
    const mode = parseIntentReadout(reply(FULL)).facets.mode!;
    expect(mode.runnerUp).toBe("converse");
    expect(mode.margin).toBeCloseTo(mode.probabilities["GATHER"]! - mode.probabilities["converse"]!, 10);
  });

  it("is confident only with both the top probability and the margin", () => {
    expect(isConfident({ top: 0.9, margin: 0.8 })).toBe(true);
    expect(isConfident({ top: 0.84, margin: 0.8 })).toBe(false);
    expect(isConfident({ top: 0.9, margin: 0.1 }, { minTop: 0.5, minMargin: 0.15 })).toBe(false);
    expect(isConfident(undefined)).toBe(false);
    expect(DEFAULT_CONFIDENCE).toEqual({ minTop: 0.85, minMargin: 0.15 });
  });
});

describe("the call", () => {
  function recorded(response: Partial<LLMResponse> | Error) {
    const calls: Array<{ messages: LLMMessage[]; options?: CompletionCallOptions }> = [];
    const provider = {
      complete: async (messages: LLMMessage[], _tools: unknown, _signal?: AbortSignal, options?: CompletionCallOptions): Promise<LLMResponse> => {
        calls.push({ messages, ...(options ? { options } : {}) });
        if (response instanceof Error) throw response;
        return { content: null, tool_calls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop", ...response };
      },
    };
    return { provider, calls };
  }

  it("asks once, grammar-bound, thinking off, greedy, with a top list per token, and reads the reply", async () => {
    const { provider, calls } = recorded({ content: "mode: B\nquery_en: Restated request.", logprobs: reply(FULL) });
    const result = await askIntentReadout(provider, { userMessage: "a request" }, { language: "en" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options).toEqual({
      controls: { enableThinking: false, reasoningEffort: "none" },
      maxTokens: INTENT_READOUT_MAX_TOKENS,
      logprobs: true,
      topLogprobs: 20,
      grammar: INTENT_READOUT_GRAMMAR,
      temperature: 0,
      repeatPenalty: 1,
    });
    expect(calls[0]!.messages).toEqual(buildIntentReadoutMessages({ userMessage: "a request" }));
    expect(result.ok && result.readout.facets.decision?.choice).toBe("single_agent");
    expect(result.ok && result.readout.language).toBe("en");
  });

  it("is a miss, never a throw, without a list, on an error or when aborted", async () => {
    expect((await askIntentReadout(recorded({ content: "mode: B" }).provider, { userMessage: "x" })).ok).toBe(false);
    expect(await askIntentReadout(recorded({ content: "mode: B" }).provider, { userMessage: "x" })).toMatchObject({ reason: "no_logprobs" });
    expect(await askIntentReadout(recorded(new Error("400 grammar")).provider, { userMessage: "x" })).toMatchObject({ ok: false, reason: "error", error: "400 grammar" });
    const controller = new AbortController();
    controller.abort();
    expect(await askIntentReadout(recorded(new Error("aborted")).provider, { userMessage: "x" }, { signal: controller.signal })).toMatchObject({ ok: false, reason: "aborted" });
  });
});

describe("comparing with triage", () => {
  const verdict: TriageVerdict = {
    mode: "GATHER", domain: ["research", "data"], deliverable: "evidence", multi: false, parts: [], alone: true,
    sourceSensitive: true, decision: "single_agent", missing: [], queryEn: "", language: "de", confidence: 0.8,
  };

  it("writes a triage verdict in the readout's keys, the first domain as the primary one", () => {
    expect(triageVerdictKeys(verdict)).toEqual({
      mode: "GATHER", domain: "research", deliverable: "evidence", multi: "no", alone: "yes", source_sensitive: "yes", decision: "single_agent",
    });
    expect(triageVerdictKeys({ ...verdict, mode: "converse", domain: [] }).domain).toBe("other");
    const readout = parseIntentReadout(reply(FULL));
    const keys = triageVerdictKeys(verdict);
    expect(INTENT_FACETS.every((f) => readout.facets[f.name]!.choice === keys[f.name])).toBe(true);
  });

  it("gives the fusion's request facets, 'other' and 'none' as no value, and only confident ones when asked", () => {
    expect(intentRequestFacets(parseIntentReadout(reply(FULL)))).toEqual({ mode: "GATHER", domain: ["research"], deliverable: "evidence" });
    const converse = parseIntentReadout(reply({
      ...FULL,
      mode: { written: "A", top: [[" A", -0.01], [" B", -6]] },
      domain: { written: "K", top: [[" K", -0.01], [" A", -6]] },
      deliverable: { written: "O", top: [[" O", -0.01], [" A", -6]] },
    }));
    expect(intentRequestFacets(converse)).toEqual({ mode: "converse", domain: [] });
    // The measured mode slot is 0.56 / 0.39: not confident, so no facets at all.
    expect(intentRequestFacets(parseIntentReadout(reply(FULL)), DEFAULT_CONFIDENCE)).toBeUndefined();
    expect(intentRequestFacets(parseIntentReadout([]))).toBeUndefined();
  });
});

describe("the pre-router's readout", () => {
  const describeAgent = (name: string) => `does ${name} work`;

  function oneToken(top: Top) {
    const calls: Array<{ messages: LLMMessage[]; options?: CompletionCallOptions }> = [];
    const provider = {
      complete: async (messages: LLMMessage[], _tools: unknown, _signal?: AbortSignal, options?: CompletionCallOptions): Promise<LLMResponse> => {
        calls.push({ messages, ...(options ? { options } : {}) });
        return {
          content: top[0]![0], tool_calls: [], usage: { promptTokens: 0, completionTokens: 1, totalTokens: 1 }, finishReason: "length",
          logprobs: [tok(top[0]![0], top)],
        };
      },
    };
    return { provider, calls };
  }

  it("offers the top K agents and 'none' last, asks the bench's question, and reads the margin", async () => {
    const { provider, calls } = oneToken([["B", -0.05], ["A", -3.5], ["D", -4.5], ["\n", -9]]);
    const result = await askPreRouteReadout(provider, { message: "a request", candidates: ["researcher", "coder", "writer", "painter"], describe: describeAgent, k: 3 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.readout.keys).toEqual(["researcher", "coder", "writer", NONE_KEY]);
    expect(result.readout.choice).toBe("coder");
    expect(result.readout.runnerUp).toBe("researcher");
    expect(result.readout.margin).toBeCloseTo(result.readout.probabilities["coder"]! - result.readout.probabilities["researcher"]!, 10);
    const system = calls[0]!.messages[0]!.content as string;
    expect(system).toContain(PRE_ROUTE_QUESTION);
    expect(system).toContain(`D: ${NONE_DESCRIPTION}`);
    expect(calls[0]!.options).toMatchObject({ maxTokens: 1, logprobs: true, controls: { enableThinking: false, reasoningEffort: "none" } });
    expect(acceptPreRoute(result.readout)).toBe("coder");
  });

  it("keeps 'none' offered however many agents are cut, and says so when there is no agent to offer", async () => {
    const { provider } = oneToken([["A", -0.1], ["B", -3]]);
    const many = Array.from({ length: 30 }, (_, i) => `agent_${i}`);
    const result = await askPreRouteReadout(provider, { message: "m", candidates: many, describe: describeAgent, k: 19 });
    expect(result.ok && result.readout.keys.at(-1)).toBe(NONE_KEY);
    expect(result.ok && result.readout.keys).toHaveLength(20);
    expect(await askPreRouteReadout(provider, { message: "m", candidates: [], describe: describeAgent })).toEqual({ ok: false, reason: "no_candidates", ms: 0 });
    expect(await askPreRouteReadout(provider, { message: "m", candidates: ["a"], describe: describeAgent, k: 20 })).toMatchObject({ ok: false, reason: "error" });
  });

  it("protects 'none': an agent is taken only past both thresholds", () => {
    const base: PreRouteReadout = {
      choice: "coder", top: 0.9, runnerUp: "researcher", margin: 0.82, probabilities: {}, logScores: {}, keys: ["coder", "researcher", NONE_KEY],
      mass: 1, temperature: 1, ms: 1,
    };
    expect(acceptPreRoute(base)).toBe("coder");
    expect(acceptPreRoute({ ...base, top: 0.8 })).toBe(NONE_KEY);
    expect(acceptPreRoute({ ...base, margin: 0.1 })).toBe(NONE_KEY);
    expect(acceptPreRoute({ ...base, choice: NONE_KEY, top: 0.99, margin: 0.98 })).toBe(NONE_KEY);
    expect(acceptPreRoute(undefined)).toBe(NONE_KEY);
  });

  it("passes a readout's miss through, and refuses an answer that does not fit the options", () => {
    expect(preRouteReadoutFrom({ ok: false, reason: "low_mass", ms: 3, topToken: "The" }, ["a", NONE_KEY])).toEqual({ ok: false, reason: "low_mass", ms: 3, topToken: "The" });
    const answer = { choice: "x", top: 1, probabilities: { x: 1 }, logScores: { x: 0 }, mass: 1, temperature: 1, topToken: "A", ms: 2 };
    expect(preRouteReadoutFrom({ ok: true, answer }, ["a", NONE_KEY])).toMatchObject({ ok: false, reason: "error" });
  });
});

// ── Verifier additions: each closes a mutation the tests above let through ─────────────────────────

/** A recorded provider for the intent call, keeping every call's options. */
function recordedIntent(response: Partial<LLMResponse>) {
  const calls: Array<{ messages: LLMMessage[]; options?: CompletionCallOptions }> = [];
  const provider = {
    complete: async (messages: LLMMessage[], _tools: unknown, _signal?: AbortSignal, options?: CompletionCallOptions): Promise<LLMResponse> => {
      calls.push({ messages, ...(options ? { options } : {}) });
      return { content: null, tool_calls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop", ...response };
    },
  };
  return { provider, calls };
}

describe("the margin, on readings the readout can actually produce", () => {
  it("cannot bind at the default top threshold: a top of 0.85 leaves the runner-up at most 0.15", () => {
    // Probabilities sum to 1, so top >= 0.85 forces margin >= 0.70: at the defaults the margin is
    // implied, and a fixture with top 0.9 and margin 0.1 is a reading no top list can give.
    const decision = parseIntentReadout(reply({ ...FULL, decision: { written: "B", top: [[" B", -0.1], [" A", -2.6], ["\n", -9]] } })).facets.decision!;
    expect(decision.top).toBeGreaterThanOrEqual(DEFAULT_CONFIDENCE.minTop);
    expect(decision.margin).toBeGreaterThanOrEqual(2 * decision.top - 1 - 1e-12);
    expect(isConfident(decision)).toBe(true);
  });

  it("binds where the top threshold is below (1 + minMargin) / 2: two options near a coin flip are no answer", () => {
    // decision: B 0.50, A 0.40, D 0.08, the rest at the list's floor 0.02 → B 0.49, A 0.39.
    const top: Top = [[" B", Math.log(0.5)], [" A", Math.log(0.4)], [" D", Math.log(0.08)], ["\n", Math.log(0.02)]];
    const read = parseIntentReadout(reply({ ...FULL, decision: { written: "B", top } })).facets.decision!;
    expect(read.choice).toBe("single_agent");
    expect(read.top).toBeGreaterThan(0.45);
    expect(read.margin).toBeLessThan(0.15);
    expect(isConfident(read, { minTop: 0.45, minMargin: 0.15 })).toBe(false);
    expect(isConfident(read, { minTop: 0.45, minMargin: 0.05 })).toBe(true);
  });

  it("keeps 'none' for a pre-router reading whose lead is too small, on a real top list", async () => {
    const { provider } = recordedIntent({
      content: "B",
      logprobs: [tok("B", [["B", Math.log(0.52)], ["A", Math.log(0.42)], ["C", Math.log(0.06)]])],
    });
    const result = await askPreRouteReadout(provider, { message: "m", candidates: ["researcher", "coder"], describe: (name) => name, k: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.readout.choice).toBe("coder");
    expect(result.readout.margin).toBeCloseTo(0.1, 10);
    expect(acceptPreRoute(result.readout, { minTop: 0.5, minMargin: 0.15 })).toBe(NONE_KEY);
    expect(acceptPreRoute(result.readout, { minTop: 0.5, minMargin: 0.05 })).toBe("coder");
    expect(acceptPreRoute(result.readout)).toBe(NONE_KEY);
  });
});

describe("the fusion's request facets, facet by facet under thresholds", () => {
  const sure = (letter: string, runnerUp: string): { written: string; top: Top } => ({ written: letter, top: [[` ${letter}`, -0.01], [` ${runnerUp}`, -6]] });

  it("drops an unsure domain but keeps a sure deliverable, and the reverse", () => {
    const unsureDomain = parseIntentReadout(reply({
      ...FULL,
      mode: sure("B", "A"),
      domain: { written: "A", top: [[" A", Math.log(0.55)], [" D", Math.log(0.44)], ["\n", -9]] },
      deliverable: sure("A", "B"),
    }));
    expect(intentRequestFacets(unsureDomain, DEFAULT_CONFIDENCE)).toEqual({ mode: "GATHER", domain: [], deliverable: "evidence" });
    const unsureDeliverable = parseIntentReadout(reply({
      ...FULL,
      mode: sure("B", "A"),
      domain: sure("A", "D"),
      deliverable: { written: "A", top: [[" A", Math.log(0.55)], [" B", Math.log(0.44)], ["\n", -9]] },
    }));
    expect(intentRequestFacets(unsureDeliverable, DEFAULT_CONFIDENCE)).toEqual({ mode: "GATHER", domain: ["research"] });
    // Without thresholds both unsure readings count.
    expect(intentRequestFacets(unsureDomain)).toEqual({ mode: "GATHER", domain: ["research"], deliverable: "evidence" });
  });
});

describe("the call's options and the reading's inputs reach where they are used", () => {
  it("looks the temperatures up under the request's detected language when none is given", async () => {
    await warmTextLanguageDetector();
    const { provider } = recordedIntent({ content: "", logprobs: reply(FULL) });
    const temperatures = { mode: { de: 2, en: 3 } };
    // Synthetic requests, one per language.
    const de = await askIntentReadout(provider, { userMessage: "Bitte fasse mir die wichtigsten Ergebnisse der Besprechung von gestern kurz zusammen." }, { temperatures });
    const en = await askIntentReadout(provider, { userMessage: "Please summarise the most important results of yesterday's meeting for me." }, { temperatures });
    expect(de.ok && de.readout.language).toBe("de");
    expect(de.ok && de.readout.facets.mode?.temperature).toBe(2);
    expect(en.ok && en.readout.language).toBe("en");
    expect(en.ok && en.readout.facets.mode?.temperature).toBe(3);
  });

  it("passes the caller's top-list size, token cap, sampling temperature and letter mass through, clamped", async () => {
    const { provider, calls } = recordedIntent({ content: "", logprobs: reply(FULL) });
    const result = await askIntentReadout(provider, { userMessage: "x" }, { language: "en", topLogprobs: 8, maxTokens: 60, samplingTemperature: 0.3, minMass: 0.999 });
    expect(calls[0]!.options).toMatchObject({ topLogprobs: 8, maxTokens: 60, temperature: 0.3 });
    // The measured mode slot holds 0.996 of the list on its letters: under 0.999, a miss.
    expect(result.ok && result.readout.misses.mode).toEqual({ reason: "low_mass", topToken: " B" });
    await askIntentReadout(provider, { userMessage: "x" }, { language: "en", topLogprobs: 50 });
    await askIntentReadout(provider, { userMessage: "x" }, { language: "en", topLogprobs: 1 });
    expect(calls.slice(1).map((call) => call.options?.topLogprobs)).toEqual([20, 2]);
  });

  it("takes the restatement from the provider's reply text over the token list", async () => {
    const { provider } = recordedIntent({ content: "mode: B\nquery_en: From the reply text.", logprobs: reply(FULL, " From the tokens.") });
    const result = await askIntentReadout(provider, { userMessage: "x" }, { language: "en" });
    expect(result.ok && result.readout.queryEn).toBe("From the reply text.");
  });

  it("is a miss on an empty token list, as on none", async () => {
    const { provider } = recordedIntent({ content: "mode: B", logprobs: [] });
    expect(await askIntentReadout(provider, { userMessage: "x" }, { language: "en" })).toMatchObject({ ok: false, reason: "no_logprobs" });
  });

  it("passes the pre-router's temperature, top-list size and letter mass through", async () => {
    const top: Top = [["B", -0.05], ["A", -3.5], ["\n", -9]];
    const { provider, calls } = recordedIntent({ content: "B", logprobs: [tok("B", top)] });
    const input = { message: "m", candidates: ["researcher", "coder"], describe: (name: string) => name, k: 2 };
    const warm = await askPreRouteReadout(provider, input, { temperature: 2, topLogprobs: 5 });
    expect(warm.ok && warm.readout.temperature).toBe(2);
    expect(calls[0]!.options).toMatchObject({ topLogprobs: 5 });
    expect(await askPreRouteReadout(provider, input, { minMass: 0.999 })).toMatchObject({ ok: false, reason: "low_mass" });
  });
});

// ── Both orders ──────────────────────────────────────────────────────────────────────────────────

const REVERSED_PREFIX = buildIntentReadoutSystemPrompt(reversedFacets());

type Slot = { written: string; top: Top };

/** A slot as the reply to the reversed prefix writes it: every letter moved to where its option stands there. */
function mirrored(slot: Slot, count: number): Slot {
  const flip = (letter: string) => LETTERS[count - 1 - LETTERS.indexOf(letter)]!;
  return {
    written: flip(slot.written),
    top: slot.top.map(([token, logprob]) => {
      const letter = /^ ([A-Z])$/.exec(token)?.[1];
      return [letter ? ` ${flip(letter)}` : token, logprob];
    }),
  };
}

/** Every slot mirrored: the reversed order read to exactly the same distribution per option. */
function mirroredSlots(slots: Partial<Record<string, Slot>>): Partial<Record<string, Slot>> {
  return Object.fromEntries(Object.entries(slots).map(([name, slot]) => [name, mirrored(slot!, INTENT_FACET_BY_NAME[name as IntentFacetName].keys.length)]));
}

/** An answer: a reply, a thrown error, or a reply that waits on the call's signal. */
type OrderAnswer = Partial<LLMResponse> | Error | ((signal: AbortSignal | undefined) => Promise<Partial<LLMResponse>>);

/** A recorded routing tier that answers the served prefix and the reversed one each its own way, and counts the calls open at once. */
function bothOrdersProvider(served: OrderAnswer, reversed: OrderAnswer) {
  const calls: Array<{ reversed: boolean; messages: LLMMessage[]; options?: CompletionCallOptions }> = [];
  let open = 0;
  let maxOpen = 0;
  const provider = {
    complete: async (messages: LLMMessage[], _tools: unknown, signal?: AbortSignal, options?: CompletionCallOptions): Promise<LLMResponse> => {
      const isReversed = messages[0]!.content === REVERSED_PREFIX;
      calls.push({ reversed: isReversed, messages, ...(options ? { options } : {}) });
      open += 1;
      maxOpen = Math.max(maxOpen, open);
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        const answer = isReversed ? reversed : served;
        if (answer instanceof Error) throw answer;
        const body = typeof answer === "function" ? await answer(signal) : answer;
        return { content: null, tool_calls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop", ...body };
      } finally {
        open -= 1;
      }
    },
  };
  return { provider, calls, maxOpen: () => maxOpen };
}

const ln = Math.log;

// mode: PRODUCE (C) 0.70 and GATHER (B) 0.20 served; reversed, PRODUCE is D and GATHER E, at 0.50 and 0.45.
const SERVED_MODE: Slot = { written: "C", top: [[" C", ln(0.7)], [" B", ln(0.2)], [" A", ln(0.04)], [" D", ln(0.03)], [" E", ln(0.02)], [" F", ln(0.01)]] };
const REVERSED_MODE: Slot = { written: "D", top: [[" D", ln(0.5)], [" E", ln(0.45)], [" A", ln(0.02)], [" B", ln(0.01)], [" C", ln(0.01)], [" F", ln(0.01)]] };
// decision: single_agent (B) 0.55 over answer_direct (A) 0.40 served; reversed, answer_direct (E) 0.80 over single_agent (D) 0.15.
const SERVED_DECISION: Slot = { written: "B", top: [[" B", ln(0.55)], [" A", ln(0.4)], [" C", ln(0.02)], [" D", ln(0.02)], [" E", ln(0.01)]] };
const REVERSED_DECISION: Slot = { written: "E", top: [[" E", ln(0.8)], [" D", ln(0.15)], [" A", ln(0.02)], [" B", ln(0.02)], [" C", ln(0.01)]] };
// alone: yes (A) 0.6 served; reversed [no, yes], no (A) 0.9 — each renormalised over its letters,
// which hold 0.6 of the served list and 0.9 of the reversed one (the rest on "\n"): averaging the
// raw letter probabilities instead would weigh the pass with more letter mass more.
const SERVED_ALONE: Slot = { written: "A", top: [[" A", ln(0.36)], [" B", ln(0.24)], ["\n", ln(0.4)]] };
const REVERSED_ALONE: Slot = { written: "A", top: [[" A", ln(0.81)], [" B", ln(0.09)], ["\n", ln(0.1)]] };

const SERVED_SLOTS = { ...FULL, mode: SERVED_MODE, decision: SERVED_DECISION, alone: SERVED_ALONE };
const REVERSED_SLOTS: Partial<Record<string, Slot>> = { ...mirroredSlots(FULL), mode: REVERSED_MODE, decision: REVERSED_DECISION, alone: REVERSED_ALONE };

describe("both orders", () => {
  it("asks the served order, then every facet reversed, one call after the other, on the same grammar and case", async () => {
    const { provider, calls, maxOpen } = bothOrdersProvider({ logprobs: reply(SERVED_SLOTS) }, { logprobs: reply(REVERSED_SLOTS) });
    const result = await askIntentReadout(provider, { userMessage: "a request", priorTurnDigest: "an earlier turn" }, { language: "en", bothOrders: true });
    expect(calls.map((call) => call.reversed)).toEqual([false, true]);
    expect(calls[0]!.messages[0]!.content).toBe(INTENT_READOUT_SYSTEM_PROMPT);
    expect(calls[1]!.messages[0]!.content).toBe(buildIntentReadoutSystemPrompt(reversedFacets()));
    expect(calls[1]!.messages[1]).toEqual(calls[0]!.messages[1]);
    expect(calls.map((call) => call.options?.grammar)).toEqual([INTENT_READOUT_GRAMMAR, INTENT_READOUT_GRAMMAR]);
    expect(calls[1]!.options).toEqual(calls[0]!.options);
    expect(maxOpen()).toBe(1);
    expect(result.ok && result.readout.version).toBe(INTENT_READOUT_BOTH_ORDERS_VERSION);
    // Off by default: one call, one order's version.
    const one = bothOrdersProvider({ logprobs: reply(SERVED_SLOTS) }, { logprobs: reply(REVERSED_SLOTS) });
    const single = await askIntentReadout(one.provider, { userMessage: "a request" }, { language: "en" });
    expect(one.calls).toHaveLength(1);
    expect(single.ok && single.readout.version).toBe(INTENT_READOUT_VERSION);
    expect(single.ok && single.readout.facets.mode?.orders).toBeUndefined();
  });

  it("averages the two orders' probabilities per option, the reversed letters read back as the options they stood for", async () => {
    const { provider } = bothOrdersProvider({ logprobs: reply(SERVED_SLOTS, " Served restatement.") }, { logprobs: reply(REVERSED_SLOTS, " Reversed restatement.") });
    const result = await askIntentReadout(provider, { userMessage: "a request" }, { language: "en", bothOrders: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { facets } = result.readout;
    const expectProbabilities = (name: IntentFacetName, expected: Record<string, number>) => {
      for (const [key, p] of Object.entries(expected)) expect(facets[name]!.probabilities[key], `${name} ${key}`).toBeCloseTo(p, 10);
    };
    // mode, the orders agreeing: PRODUCE (0.70 + 0.50) / 2, GATHER (0.20 + 0.45) / 2, …
    expectProbabilities("mode", { converse: 0.025, GATHER: 0.325, PRODUCE: 0.6, ACT: 0.02, VERIFY: 0.015, ORCHESTRATE: 0.015 });
    expect(facets.mode).toMatchObject({ choice: "PRODUCE", runnerUp: "GATHER", orders: { served: "PRODUCE", reversed: "PRODUCE", agreed: true } });
    expect(facets.mode!.top).toBeCloseTo(0.6, 10);
    expect(facets.mode!.margin).toBeCloseTo(0.275, 10);
    // decision, a disagreeing pair: served single_agent, reversed answer_direct; the average's side wins.
    expectProbabilities("decision", { answer_direct: 0.6, single_agent: 0.35, workflow: 0.015, coordinate: 0.02, clarify: 0.015 });
    expect(facets.decision).toMatchObject({ choice: "answer_direct", runnerUp: "single_agent", orders: { served: "single_agent", reversed: "answer_direct", agreed: false } });
    expect(facets.decision!.margin).toBeCloseTo(0.25, 10);
    // alone, a disagreeing yes/no pair: yes (0.6 + 0.1) / 2, no (0.4 + 0.9) / 2 — each pass
    // renormalised over its letters first (raw letter probabilities would give 0.30 / 0.70).
    expectProbabilities("alone", { yes: 0.35, no: 0.65 });
    expect(facets.alone).toMatchObject({ choice: "no", orders: { served: "yes", reversed: "no", agreed: false } });
    expect(facets.alone!.logScores["no"]).toBeCloseTo(Math.log(0.65), 10);
    // The letter mass is the two passes' mean: (0.6 + 0.9) / 2.
    expect(facets.alone!.mass).toBeCloseTo(0.75, 10);
    // A facet both orders read alike (the reversed reply mirrored) keeps one pass's distribution.
    const one = parseIntentReadout(reply(FULL));
    for (const name of ["domain", "deliverable", "multi", "source_sensitive"] as const) {
      expect(facets[name]!.orders).toEqual({ served: one.facets[name]!.choice, reversed: one.facets[name]!.choice, agreed: true });
      for (const key of INTENT_FACET_BY_NAME[name].keys) expect(facets[name]!.probabilities[key], `${name} ${key}`).toBeCloseTo(one.facets[name]!.probabilities[key]!, 10);
    }
    // The restatement is the served pass's; the tokens are both calls'.
    expect(result.readout.queryEn).toBe("Served restatement.");
    const servedTokens = reply(SERVED_SLOTS, " Served restatement.").length;
    const reversedTokens = reply(REVERSED_SLOTS, " Reversed restatement.").length;
    expect(result.readout.tokens).toBe(servedTokens + reversedTokens);
    expect(result.readout.reversed).toMatchObject({ tokens: reversedTokens });
    expect(result.readout.reversed!.failure).toBeUndefined();
    // The reversed call's own round trip (the recorded tier answers after 5 ms), inside the wall time of both.
    expect(result.readout.reversed!.ms).toBeGreaterThan(0);
    expect(result.readout.ms).toBeGreaterThanOrEqual(result.readout.reversed!.ms);
    expect(facets.mode!.sampled).toBe("PRODUCE");
  });

  it("breaks a tie in the average toward the served order's earlier option", () => {
    // yes 0.6 / no 0.4 served, the reverse reversed: exactly 0.5 each on average.
    const tied = averageOrderReadings(["yes", "no"], { choice: "yes", logScores: { yes: ln(0.6), no: ln(0.4) } }, { choice: "no", logScores: { yes: ln(0.4), no: ln(0.6) } });
    expect(tied).toMatchObject({ choice: "yes", runnerUp: "no", orders: { served: "yes", reversed: "no", agreed: false } });
    expect(tied!.top).toBeCloseTo(0.5, 10);
    expect(tied!.margin).toBeCloseTo(0, 10);
    expect(averageOrderReadings(["yes", "no"], undefined, undefined)).toBeUndefined();
  });

  it("applies a facet's temperature to the log of the average, not to each order before it", async () => {
    const { provider } = bothOrdersProvider({ logprobs: reply(SERVED_SLOTS) }, { logprobs: reply(REVERSED_SLOTS) });
    const result = await askIntentReadout(provider, { userMessage: "a request" }, { language: "en", bothOrders: true, temperatures: { alone: { en: 2 } } });
    const alone = result.ok ? result.readout.facets.alone! : undefined;
    const expected = applyTemperature([Math.log(0.35), Math.log(0.65)], 2);
    expect(alone?.temperature).toBe(2);
    expect(alone?.probabilities["yes"]).toBeCloseTo(expected[0]!, 10);
    expect(alone?.probabilities["no"]).toBeCloseTo(expected[1]!, 10);
    // The log-scores stay the average's at T = 1: what a temperature for this mode is fitted on.
    expect(alone?.logScores["yes"]).toBeCloseTo(Math.log(0.35), 10);
    expect(result.ok && result.readout.facets.mode!.temperature).toBe(1);
  });

  it("takes a facet one order missed from the other order alone, says which, and misses a facet both missed", async () => {
    const { multi: _multi, domain: _servedDomain, ...served } = SERVED_SLOTS;
    const controlToken = (written: string): Slot => ({ written, top: [["<|im_end|>", -0.1], [` ${written}`, -2.5]] });
    const reversed = { ...REVERSED_SLOTS, source_sensitive: controlToken("B"), domain: controlToken("K") };
    const { provider } = bothOrdersProvider({ logprobs: reply(served) }, { logprobs: reply(reversed) });
    const result = await askIntentReadout(provider, { userMessage: "a request" }, { language: "en", bothOrders: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const one = parseIntentReadout(reply(FULL));
    // multi: no line in the served reply, read by the reversed order alone.
    expect(result.readout.facets.multi).toMatchObject({ choice: "no", orders: { reversed: "no", singlePass: "reversed" } });
    expect(result.readout.facets.multi!.orders!.agreed).toBeUndefined();
    expect(result.readout.facets.multi!.probabilities["no"]).toBeCloseTo(one.facets.multi!.probabilities["no"]!, 10);
    expect(result.readout.facets.multi!.mass).toBeCloseTo(one.facets.multi!.mass, 10);
    // What that pass wrote, as the option its letter stood for there (A under [no, yes]).
    expect(result.readout.facets.multi!.sampled).toBe("no");
    // source_sensitive: a control token in the reversed reply, read by the served order alone.
    expect(result.readout.facets.source_sensitive).toMatchObject({ choice: "yes", orders: { served: "yes", singlePass: "served" } });
    expect(result.readout.facets.source_sensitive!.probabilities["yes"]).toBeCloseTo(one.facets.source_sensitive!.probabilities["yes"]!, 10);
    // domain: neither order read it (no line served, a control token reversed), and the served order's reason stands.
    expect(result.readout.facets.domain).toBeUndefined();
    expect(result.readout.misses).toEqual({ domain: { reason: "no_slot" } });
    expect(result.readout.facets.mode!.orders!.singlePass).toBeUndefined();
  });

  it("leaves every facet the served order's alone when the reversed call fails, and asks nothing more when the served call fails", async () => {
    const failed = bothOrdersProvider({ logprobs: reply(SERVED_SLOTS) }, new Error("500 slot unavailable"));
    const result = await askIntentReadout(failed.provider, { userMessage: "a request" }, { language: "en", bothOrders: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const one = parseIntentReadout(reply(SERVED_SLOTS));
    expect(result.readout.version).toBe(INTENT_READOUT_BOTH_ORDERS_VERSION);
    expect(result.readout.reversed).toMatchObject({ tokens: 0, failure: "error" });
    for (const definition of INTENT_FACETS) {
      expect(result.readout.facets[definition.name], definition.name).toMatchObject({ choice: one.facets[definition.name]!.choice, orders: { singlePass: "served" } });
      expect(result.readout.facets[definition.name]!.top).toBeCloseTo(one.facets[definition.name]!.top, 10);
    }
    const noList = bothOrdersProvider({ logprobs: reply(SERVED_SLOTS) }, { logprobs: [] });
    const withoutList = await askIntentReadout(noList.provider, { userMessage: "a request" }, { language: "en", bothOrders: true });
    expect(withoutList.ok && withoutList.readout.reversed?.failure).toBe("no_logprobs");
    for (const served of [new Error("400 grammar"), { logprobs: [] }] as OrderAnswer[]) {
      const { provider, calls } = bothOrdersProvider(served, { logprobs: reply(REVERSED_SLOTS) });
      const outcome = await askIntentReadout(provider, { userMessage: "a request" }, { language: "en", bothOrders: true });
      expect(outcome.ok).toBe(false);
      expect(calls).toHaveLength(1);
    }
  });

  it("stops at an abort: nothing is sent after it, and one during the reversed call is an aborted readout, never half a reading", async () => {
    // Aborted while the served call answers: the reversed call is never sent.
    const early = new AbortController();
    const first = bothOrdersProvider(async () => {
      early.abort();
      return { logprobs: reply(SERVED_SLOTS) };
    }, { logprobs: reply(REVERSED_SLOTS) });
    expect(await askIntentReadout(first.provider, { userMessage: "a request" }, { language: "en", bothOrders: true, signal: early.signal })).toMatchObject({ ok: false, reason: "aborted" });
    expect(first.calls).toHaveLength(1);
    // Aborted during the reversed call: that call sees the abort, and the served pass is not passed off as the reading.
    const late = new AbortController();
    const seen: boolean[] = [];
    const second = bothOrdersProvider({ logprobs: reply(SERVED_SLOTS) }, (signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        seen.push(signal.aborted);
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true });
      setTimeout(() => late.abort(), 5);
    }));
    expect(await askIntentReadout(second.provider, { userMessage: "a request" }, { language: "en", bothOrders: true, signal: late.signal })).toMatchObject({ ok: false, reason: "aborted" });
    expect(second.calls.map((call) => call.reversed)).toEqual([false, true]);
    expect(seen).toEqual([true]);
  });
});
