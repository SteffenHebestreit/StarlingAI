/**
 * Intent readout: the request's facets read off ONE grammar-bound reply, one option letter per
 * line, each letter's probability taken from the model's own top list at that line's slot.
 *
 * WHY. The swarm's intent routing reads almost nothing today: the per-turn classifier's routing
 * flags are hardwired false since the de-lex, the facet triage (agent/triage.ts) writes generative
 * JSON that gives labels without probabilities and runs in shadow at most, and the pre-router
 * exists only as a bench. The single-question letter readout (decisions/logit-readout.ts, C7) beat
 * the parsed incumbents on synthetic gold — fast_lane 97.5% vs 95%, source_sensitive 100% vs
 * 93.8%, 1 order flip in 160 — and read the pre-router question at 72.5% top-1 (embedding 46%,
 * Laya 18%), 78 of 80 right at a top probability of 0.85 or more. This asks every triage facet at
 * once, the same way.
 *
 * HOW. One routing-tier call, thinking off, with a GBNF grammar (CompletionCallOptions.grammar)
 * that fixes the reply to
 *
 *     mode: <letter>\ndomain: <letter>\n … \ndecision: <letter>\nquery_en: <one English sentence>
 *
 * and `logprobs` with a top list per generated token. Measured on the production llama-server
 * 2026-09-28: the reply came back in exactly that shape, one logprobs entry per token; each value
 * slot is ONE token, with a leading space (" C"), and its top list holds the other letters
 * (slot `mode` of a German price question: " B" -0.58, " A" -0.95, " E" -3.19, " D" -4.84, …).
 * That list is the RAW softmax — tokens the grammar forbids (" **", "\n") are on it — so each slot
 * is renormalised over its facet's letters (logit-readout.ts scoreLetters: " X" and "X" summed, a
 * missing letter at the list's floor as a ceiling, a control token on top or too little mass on
 * the letters is a miss). 0.86-1.16 s a call with the system prefix cached, 29 tokens generated.
 *
 * WHAT IS FIXED, AND WHY.
 *   - The facets are triage's IDCM taxonomy (agent/triage.ts TRIAGE_RESPONSE_SCHEMA), each value
 *     under a letter in the schema's own order (a test holds the two together), except `domain`:
 *     triage's is multi-valued, a slot reads ONE letter, so this reads the PRIMARY domain, with
 *     `other` (no domain, or none listed) last. Triage's parts, missing and confidence are not
 *     asked: the first two are text, and the readout's probabilities replace the third.
 *   - The facet lines come in triage's order (mode, domain, deliverable, multi, alone,
 *     source_sensitive, decision): every later slot is read conditioned on the letters written
 *     before it, and `decision`'s definition refers to the others (answer_direct = no tool and not
 *     source_sensitive), so it comes after them.
 *   - query_en comes LAST and is asked on every request, English too. Triage's free JSON wrote a
 *     restatement for 9 of 15 German requests, 8 of 15 with it placed last, 3 of 15 when told it
 *     was required (idcm-1 note: the model's own ceiling, "fix it with a mechanism"). Here the
 *     grammar is that mechanism: the line cannot be empty, so every request gets the sentence a
 *     second retrieval pass searches with. Last, so the letters are all decoded before it and a
 *     restatement cut by the token cap never costs a letter.
 *   - The system prefix is frozen and catalog-blind: it never names an agent or a workflow, so it
 *     can run beside the embedding shortlist instead of after it, and a catalog change never cools
 *     its KV cache (probe E2: a changed head is a cold prefill, 8-14 s). The user's message, and
 *     the prior-turn digest triage takes, go in the user message exactly as triage builds it.
 *   - `INTENT_READOUT_VERSION` names the prefix, the grammar and the case template (triage's
 *     user message): a change to any of them is a different readout, and its rows must never be
 *     counted with the old one's.
 *
 * The sampling temperature defaults to 0. A slot's top list is the raw distribution whatever the
 * sampler does (logit-readout.ts), but each later slot is conditioned on the letter SAMPLED before
 * it: at the routing tier's thinking-off 0.7 a runner-up written at `mode` would change what
 * `decision` is read on. At 0 every earlier slot holds its argmax, and each facet reads the same
 * for the same message. Each facet reports the letter written (`sampled`) beside its argmax.
 *
 * Nothing here decides anything or reads config. It reports per facet a choice, a probability per
 * option, the top probability and the margin over the runner-up; a facet that could not be read is
 * missing and says why, and the others still count. The callers own the thresholds, the
 * hysteresis across turns and what a reading may change.
 *
 * The pre-router's readout lives here too (askPreRouteReadout): the bench's question
 * (decisions/pre-route-question.ts) over the capsule's top K agents with "none" always offered
 * last, asked through askReadout, plus the margin — and "none" is protected: an agent is taken
 * only when it clears both thresholds (acceptPreRoute).
 */
import { detectTextLanguage } from "../agent/text-language.js";
import { buildTriageMessages, type TriageInput, type TriageVerdict } from "../agent/triage.js";
import type { RequestFacets } from "../agent/routing-taxonomy.js";
import type { ChatProvider, LLMMessage, LLMTokenLogprob } from "../providers/lmstudio.js";
import { languageBucket, type LanguageBucket } from "./gate.js";
import {
  askReadout,
  DEFAULT_MIN_LETTER_MASS,
  LETTERS,
  letterOfToken,
  MAX_TOP_LOGPROBS,
  READOUT_CONTROLS,
  readoutAnswer,
  scoreLetters,
  type ReadoutMissReason,
  type ReadoutResult,
} from "./logit-readout.js";
import { buildPreRouteQuestion, NONE_KEY, PRE_ROUTE_POINT } from "./pre-route-question.js";

/**
 * The readout's version: the frozen prefix, the grammar and the case template together. Bump it
 * with any change to one of them — a facet, an option, its order or its wording, or the user
 * message triage builds (buildTriageMessages: its wording and its cuts, which live in
 * agent/triage.ts and so can change without a line of this file changing) — so rows of two
 * readouts are never counted together (a test pins all three to this version).
 */
export const INTENT_READOUT_VERSION = "intent-readout-v1";

/** The facets, in the order the reply writes them. */
export type IntentFacetName = "mode" | "domain" | "deliverable" | "multi" | "alone" | "source_sensitive" | "decision";

export interface IntentFacetDefinition {
  /** The facet, and the label its line starts with ("mode: C"). */
  readonly name: IntentFacetName;
  /** What the facet asks, as the prefix states it. */
  readonly question: string;
  /** The option keys in letter order: `keys[i]` is written as `LETTERS[i]`. */
  readonly keys: readonly string[];
  /** What an option means, where it needs more than its key. */
  readonly descriptions: Readonly<Partial<Record<string, string>>>;
  /** A line after the options: the boundary the options alone leave open. */
  readonly note?: string;
}

function facet(definition: IntentFacetDefinition): IntentFacetDefinition {
  return Object.freeze({ ...definition, keys: Object.freeze([...definition.keys]), descriptions: Object.freeze({ ...definition.descriptions }) });
}

const YES_NO = ["yes", "no"] as const;

/**
 * The facets, their options and letters. Wording from triage's frozen prefix (TRIAGE_SYSTEM_PROMPT,
 * idcm-1) wherever it has one, so the two can be compared in shadow on the same definitions.
 */
export const INTENT_FACETS: readonly IntentFacetDefinition[] = Object.freeze([
  facet({
    name: "mode",
    question: "what the request asks the assistant to DO (the verb, never the topic)",
    keys: ["converse", "GATHER", "PRODUCE", "ACT", "VERIFY", "ORCHESTRATE"],
    descriptions: {
      converse: "greeting, chit-chat, or a question answerable from stable general knowledge with no tool",
      GATHER: "find, read, diagnose or analyse information; the result is facts or findings",
      PRODUCE: "author a durable artifact (text, code, app, chart, image, deck, plan) from inputs",
      ACT: "cause an effect on an EXTERNAL system (send, deploy, mutate a repo/DB/host, drive a live browser or PC, call a live service)",
      VERIFY: "judge something that already exists against criteria and return a verdict",
      ORCHESTRATE: "the work spans several different capabilities and must be planned first",
    },
    note: "Running code in an isolated sandbox to produce a result is PRODUCE, not ACT — ACT means something outside changes.",
  }),
  facet({
    name: "domain",
    question: "the capability the WORK needs, NOT the subject of the request; where two are needed, the primary one",
    keys: ["research", "software", "authoring", "data", "media", "device_control", "comms", "infra_ops", "security", "swarm_meta", "other"],
    descriptions: {
      research: "finding and verifying external information on any topic, including reading advisories or docs",
      software: "writing, running, reviewing or version-controlling code; calling APIs",
      authoring: "audience-facing written deliverables",
      data: "structured/tabular data, databases, extracting from documents",
      media: "charts, diagrams, images — producing or interpreting visuals",
      device_control: "driving a live browser session or a real desktop",
      comms: "mail, calendar, outbound notifications",
      infra_ops: "servers, clusters, deployments, logs, incidents",
      security: "AUTHORIZED offensive security under a written scope (reading about vulnerabilities is research)",
      swarm_meta: "changing the assistant's own agents, prompts, tools or durable memory",
      other: "none of these, or no work at all (converse)",
    },
    note: "\"Research the best image model\" is GATHER + research: the work is research, \"image\" is only the topic.",
  }),
  facet({
    name: "deliverable",
    question: "what the user ends up with",
    keys: ["evidence", "prose_doc", "deck", "website", "code", "running_app", "chart", "diagram", "image", "data_table", "plan", "verdict", "message", "config_change", "none"],
    descriptions: { none: "nothing is produced" },
  }),
  facet({
    name: "multi",
    question: "the request contains clauses needing different capabilities (e.g. research something AND then build something from it)",
    keys: YES_NO,
    descriptions: {},
  }),
  facet({
    name: "alone",
    question: "ONE specialist or ONE prebuilt workflow could plausibly finish the whole request",
    keys: YES_NO,
    descriptions: {},
  }),
  facet({
    name: "source_sensitive",
    // The up-front source judge's contract as triage states it (idcm-1), true/false written as the
    // letters' yes/no: the verdict that arms forced research, so a shadow run compares like with like.
    question: "yes when answering correctly requires SPECIFIC checkable real-world facts: a named organisation, product, price, rate, "
      + "statistic, law, version, or exactly how a particular real system works — including \"which X is best / latest / "
      + "recommended\", comparisons, and anything whose answer changes over time. It stays yes when the request is phrased as "
      + "advice. It is no for general principles, concepts, how something works in the abstract, the user's own pasted content, "
      + "and requests about the assistant itself",
    keys: YES_NO,
    descriptions: {},
  }),
  facet({
    name: "decision",
    question: "the smallest path that would work",
    keys: ["answer_direct", "single_agent", "workflow", "coordinate", "clarify"],
    descriptions: {
      answer_direct: "no tool needed and not source_sensitive",
      single_agent: "one specialist does all of it",
      workflow: "a prebuilt multi-step pipeline is exactly what was asked for",
      coordinate: "needs a plan first — the output crosses a specialist boundary, or takes many steps, or two of {two or more domains, independent sub-questions, open-ended research}",
      clarify: "a GOAL or required INPUT is missing and no sensible default exists. Never for a request that is merely broad",
    },
  }),
]);

/** Each facet's definition by name. */
export const INTENT_FACET_BY_NAME: Readonly<Record<IntentFacetName, IntentFacetDefinition>> = Object.freeze(
  Object.fromEntries(INTENT_FACETS.map((definition) => [definition.name, definition])) as Record<IntentFacetName, IntentFacetDefinition>,
);

/** The free-text line, always last. */
export const QUERY_EN_LABEL = "query_en";

/** The restatement's cap in the grammar: one sentence. */
export const MAX_QUERY_EN_CHARS = 200;

/** What is kept of a restatement read from a reply the grammar did not bind: triage's own cap. */
const MAX_QUERY_EN_KEPT = 400;

/**
 * Output ceiling. Seven label-and-letter lines are about 35 tokens, a 200-character sentence 40 to
 * 60 more (29 in all on the live probe with three facets); the cap only stops a reply that the
 * grammar would otherwise let run, and a cut restatement leaves every letter readable.
 */
export const INTENT_READOUT_MAX_TOKENS = 120;

// ── The prefix, the messages and the grammar ────────────────────────────────────────────────────

function facetBlock(definition: IntentFacetDefinition): string {
  const options = definition.keys.map((key, i) => {
    const description = definition.descriptions[key];
    return `${LETTERS[i]}: ${key}${description ? ` — ${description}` : ""}`;
  });
  return [`${definition.name} — ${definition.question}:`, ...options, ...(definition.note ? [definition.note] : [])].join("\n");
}

/** The frozen system prefix, generated from the facet definitions so its letters and the grammar's never disagree. */
export function buildIntentReadoutSystemPrompt(facets: readonly IntentFacetDefinition[] = INTENT_FACETS): string {
  return [
    "You label a user request for an assistant's router. Each field below is answered with the LETTER of one option from its list; "
      + "the last field is one sentence of text. Reply in exactly the form given at the end — no prose, no explanation, no reasoning.",
    ...facets.map(facetBlock),
    `${QUERY_EN_LABEL} — the request restated in English in one sentence, also when it is already English.`,
    [
      "Reply in exactly this form, the letter alone after each colon:",
      ...facets.map((definition) => `${definition.name}: <letter>`),
      `${QUERY_EN_LABEL}: <one English sentence>`,
    ].join("\n"),
  ].join("\n\n");
}

export const INTENT_READOUT_SYSTEM_PROMPT = buildIntentReadoutSystemPrompt();

/** The character class of a facet's letters: `[A-F]` for six options. */
function letterClass(count: number): string {
  if (!Number.isInteger(count) || count < 2 || count > LETTERS.length) throw new RangeError(`a facet needs 2 to ${LETTERS.length} options; got ${count}`);
  return `[A-${LETTERS[count - 1]}]`;
}

/**
 * The GBNF grammar of the reply, generated from the facet definitions: each facet's line with its
 * letters, then the restatement, one line of 1 to `maxQueryChars` characters. For the default
 * facets:
 *
 *     root ::= "mode: " [A-F] "\ndomain: " [A-K] … "\ndecision: " [A-E] "\nquery_en: " [^\r\n]{1,200}
 */
export function buildIntentGrammar(facets: readonly IntentFacetDefinition[] = INTENT_FACETS, maxQueryChars = MAX_QUERY_EN_CHARS): string {
  if (!Number.isInteger(maxQueryChars) || maxQueryChars < 1) throw new RangeError(`maxQueryChars must be a whole number of 1 or more; got ${maxQueryChars}`);
  const lines = facets.map((definition, i) => `"${i === 0 ? "" : "\\n"}${definition.name}: " ${letterClass(definition.keys.length)}`);
  const query = `"${facets.length === 0 ? "" : "\\n"}${QUERY_EN_LABEL}: " [^\\r\\n]{1,${maxQueryChars}}`;
  return `root ::= ${[...lines, query].join(" ")}`;
}

export const INTENT_READOUT_GRAMMAR = buildIntentGrammar();

/**
 * The readout's messages: the frozen prefix as the system message, and the user message exactly as
 * triage builds it (buildTriageMessages: the request, and the prior turn's digest when there is
 * one, each cut to triage's lengths), so the two read the same case. `facets` other than the
 * default give another prefix (intent:bench --order-swap), which is not INTENT_READOUT_VERSION's.
 */
export function buildIntentReadoutMessages(input: TriageInput, facets?: readonly IntentFacetDefinition[]): LLMMessage[] {
  const tail = buildTriageMessages(input).at(-1)!;
  return [{ role: "system", content: facets ? buildIntentReadoutSystemPrompt(facets) : INTENT_READOUT_SYSTEM_PROMPT }, tail];
}

// ── Reading the reply ────────────────────────────────────────────────────────────────────────────

/** Where a facet's letter sits in the token list. */
export interface SlotLocation {
  /** The token that holds the letter. */
  tokenIndex: number;
  /** The letter's offset in the reply rebuilt from the tokens. */
  valueOffset: number;
  /** That token's text before the letter: " " for " C", ":" for a merged ":C", "" for "C". */
  lead: string;
}

/**
 * The slot of the line `name: <letter>` in the reply rebuilt from its tokens, or undefined when the
 * reply has no such line or nothing after its colon. The line must start the reply or follow a
 * newline; the letter is the first character after the colon and any spaces, and the slot is the
 * token that covers it — whether that token is the letter alone, " C", or merged with the colon
 * before it. Pure.
 */
export function locateSlot(tokens: ReadonlyArray<{ token: string }>, name: string): SlotLocation | undefined {
  const text = tokens.map((entry) => entry.token).join("");
  const marker = `${name}:`;
  let at = text.startsWith(marker) ? 0 : -1;
  if (at < 0) {
    const line = text.indexOf(`\n${marker}`);
    if (line >= 0) at = line + 1;
  }
  if (at < 0) return undefined;
  let value = at + marker.length;
  while (value < text.length && (text[value] === " " || text[value] === "\t")) value += 1;
  if (value >= text.length || text[value] === "\n" || text[value] === "\r") return undefined;
  let start = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const end = start + tokens[i]!.token.length;
    if (value < end) return { tokenIndex: i, valueOffset: value, lead: tokens[i]!.token.slice(0, value - start) };
    start = end;
  }
  return undefined;
}

/**
 * Which of a slot's `count` letters a listed token spells. Whitespace before the letter is no part
 * of it (" B" and "B" are both B, summed by scoreLetters); anything else the slot's own token
 * carries before its letter (a merged ":C") must stand before the alternative's letter too, since
 * a listed " A" after "mode" is not a value for the slot at all. Pure.
 */
export function slotLetterOf(lead: string, count: number): (token: string) => string | undefined {
  const core = lead.replace(/\s+/gu, "");
  return (token) => {
    if (!core) return letterOfToken(token, count);
    const trimmed = token.replace(/^\s+/u, "");
    return trimmed.startsWith(core) ? letterOfToken(trimmed.slice(core.length), count) : undefined;
  };
}

/** The runner-up and how far the top option leads it; a margin of 1 when there is no runner-up. */
export function marginOf(probabilities: Readonly<Record<string, number>>): { runnerUp: string | undefined; margin: number } {
  const ranked = Object.entries(probabilities).filter(([, p]) => Number.isFinite(p)).sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return { runnerUp: undefined, margin: 0 };
  if (ranked.length === 1) return { runnerUp: undefined, margin: 1 };
  return { runnerUp: ranked[1]![0], margin: ranked[0]![1] - ranked[1]![1] };
}

export interface IntentFacetRead {
  /** The option with the highest probability. */
  choice: string;
  /** Its probability. */
  top: number;
  runnerUp: string | undefined;
  /** `top` minus the runner-up's probability. */
  margin: number;
  /** Per option key, after the temperature. */
  probabilities: Record<string, number>;
  /** Per option key, before it: what a temperature fit reads. */
  logScores: Record<string, number>;
  /** The probability the facet's letters held on the raw top list. */
  mass: number;
  temperature: number;
  /** The option the reply actually wrote at this slot, when its token spells one; later slots were read after it. */
  sampled?: string;
}

/** Why a facet has no reading: its line or letter is not in the reply, or its slot's top list gave no answer. */
export type IntentFacetMiss = "no_slot" | ReadoutMissReason;

export interface IntentFacetMissDetail {
  reason: IntentFacetMiss;
  /** The slot's most likely raw token, where there was a list (model text, not the user's). */
  topToken?: string;
}

/** Per facet and language, the temperature its letters are divided by (fitTemperature); 1 where absent. */
export type IntentTemperatures = Partial<Record<IntentFacetName, Partial<Record<LanguageBucket, number>>>>;

export interface IntentReadout {
  version: string;
  /** Every facet that could be read. */
  facets: Partial<Record<IntentFacetName, IntentFacetRead>>;
  /** Every facet that could not, and why. */
  misses: Partial<Record<IntentFacetName, IntentFacetMissDetail>>;
  /**
   * The English restatement; empty when the reply has none. The user's request in other words:
   * it goes to a retrieval pass, never into an audit row, a ledger or a report (its length may).
   */
  queryEn: string;
  language: LanguageBucket;
  /** Generated tokens with a log-probability. */
  tokens: number;
  /** Round trip, when the reading came from a call. */
  ms: number;
}

export interface ParseIntentReadoutOptions {
  language?: LanguageBucket;
  temperatures?: IntentTemperatures;
  minMass?: number;
  /**
   * The reply's text as the provider returned it, for the restatement: a token of a character
   * split across tokens can come back garbled on its own, the joined reply cannot. The letters are
   * always read from the tokens.
   */
  content?: string | null;
  ms?: number;
  facets?: readonly IntentFacetDefinition[];
}

function temperatureFor(temperatures: IntentTemperatures | undefined, name: IntentFacetName, language: LanguageBucket): number {
  const t = temperatures?.[name]?.[language];
  return typeof t === "number" && Number.isFinite(t) && t > 0 ? t : 1;
}

/** The text after `name:` on its line, trimmed; empty when there is no such line. */
function lineValue(text: string, name: string): string {
  const marker = `${name}:`;
  let at = text.startsWith(marker) ? 0 : -1;
  if (at < 0) {
    const line = text.indexOf(`\n${marker}`);
    if (line >= 0) at = line + 1;
  }
  if (at < 0) return "";
  const rest = text.slice(at + marker.length);
  const end = rest.search(/[\r\n]/u);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

/** One facet read off its slot: the reading, or why there is none. Pure. */
export function readFacetSlot(
  tokens: readonly LLMTokenLogprob[],
  definition: IntentFacetDefinition,
  temperature: number,
  minMass = DEFAULT_MIN_LETTER_MASS,
): { ok: true; read: IntentFacetRead } | { ok: false; miss: IntentFacetMissDetail } {
  const slot = locateSlot(tokens, definition.name);
  if (!slot) return { ok: false, miss: { reason: "no_slot" } };
  const count = definition.keys.length;
  const letterOf = slotLetterOf(slot.lead, count);
  const token = tokens[slot.tokenIndex]!;
  const scored = scoreLetters(token.topLogprobs, count, minMass, letterOf);
  if (!scored.ok) return { ok: false, miss: { reason: scored.reason, ...(scored.topToken !== undefined ? { topToken: scored.topToken } : {}) } };
  const answer = readoutAnswer(definition.keys, scored.value, temperature, 0);
  const { runnerUp, margin } = marginOf(answer.probabilities);
  const written = letterOf(token.token);
  const sampled = written === undefined ? undefined : definition.keys[LETTERS.indexOf(written)];
  return {
    ok: true,
    read: {
      choice: answer.choice,
      top: answer.top,
      runnerUp,
      margin,
      probabilities: answer.probabilities,
      logScores: answer.logScores,
      mass: answer.mass,
      temperature,
      ...(sampled !== undefined ? { sampled } : {}),
    },
  };
}

/**
 * Every facet read off a reply's token list. A facet whose slot cannot be read is left out and its
 * miss recorded; the others still count. Pure.
 */
export function parseIntentReadout(tokens: readonly LLMTokenLogprob[], options: ParseIntentReadoutOptions = {}): IntentReadout {
  const language = options.language ?? "other";
  const facets: IntentReadout["facets"] = {};
  const misses: IntentReadout["misses"] = {};
  for (const definition of options.facets ?? INTENT_FACETS) {
    const read = readFacetSlot(tokens, definition, temperatureFor(options.temperatures, definition.name, language), options.minMass ?? DEFAULT_MIN_LETTER_MASS);
    if (read.ok) facets[definition.name] = read.read;
    else misses[definition.name] = read.miss;
  }
  const fromContent = typeof options.content === "string" ? lineValue(options.content, QUERY_EN_LABEL) : "";
  const queryEn = (fromContent || lineValue(tokens.map((entry) => entry.token).join(""), QUERY_EN_LABEL)).slice(0, MAX_QUERY_EN_KEPT);
  return { version: INTENT_READOUT_VERSION, facets, misses, queryEn, language, tokens: tokens.length, ms: options.ms ?? 0 };
}

// ── Asking ───────────────────────────────────────────────────────────────────────────────────────

export interface IntentReadoutOptions {
  signal?: AbortSignal;
  /** The language bucket the temperatures are looked up under; default the request's, detected. */
  language?: LanguageBucket;
  temperatures?: IntentTemperatures;
  /** Default and at most 20: the deliverable facet has 15 letters, and a letter off the list only gets a ceiling. */
  topLogprobs?: number;
  minMass?: number;
  maxTokens?: number;
  /** The sampling temperature; default 0, the argmax path (see the file header). */
  samplingTemperature?: number;
  /**
   * Other facet definitions — the same facets with their options in another order — for measuring
   * letter-position bias (intent:bench --order-swap): the prefix, the grammar and the reading all
   * follow them. Such a readout is not INTENT_READOUT_VERSION's; its rows must be kept apart.
   */
  facets?: readonly IntentFacetDefinition[];
}

export type IntentReadoutResult =
  | { ok: true; readout: IntentReadout }
  | { ok: false; reason: "no_logprobs" | "error" | "aborted"; ms: number; error?: string };

/**
 * Ask the routing tier for the request's facets in one grammar-bound call and read them. Never
 * throws: a failed call is a miss, and the caller proceeds as it does without a reading.
 */
export async function askIntentReadout(
  provider: Pick<ChatProvider, "complete">,
  input: TriageInput,
  options: IntentReadoutOptions = {},
): Promise<IntentReadoutResult> {
  const started = Date.now();
  const topLogprobs = Math.max(2, Math.min(MAX_TOP_LOGPROBS, Math.floor(options.topLogprobs ?? MAX_TOP_LOGPROBS)));
  const maxTokens = Math.max(1, Math.floor(options.maxTokens ?? INTENT_READOUT_MAX_TOKENS));
  const language = options.language ?? languageBucket(detectTextLanguage(input.userMessage)?.code);
  try {
    const response = await provider.complete(buildIntentReadoutMessages(input, options.facets), [], options.signal, {
      controls: READOUT_CONTROLS,
      maxTokens,
      logprobs: true,
      topLogprobs,
      grammar: options.facets ? buildIntentGrammar(options.facets) : INTENT_READOUT_GRAMMAR,
      temperature: options.samplingTemperature ?? 0,
    });
    const ms = Date.now() - started;
    if (!response.logprobs || response.logprobs.length === 0) return { ok: false, reason: "no_logprobs", ms };
    return {
      ok: true,
      readout: parseIntentReadout(response.logprobs, {
        language,
        ...(options.temperatures ? { temperatures: options.temperatures } : {}),
        ...(options.minMass !== undefined ? { minMass: options.minMass } : {}),
        content: response.content,
        ms,
        ...(options.facets ? { facets: options.facets } : {}),
      }),
    };
  } catch (err) {
    const ms = Date.now() - started;
    if (options.signal?.aborted) return { ok: false, reason: "aborted", ms };
    return { ok: false, reason: "error", ms, error: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300) };
  }
}

// ── Confidence ───────────────────────────────────────────────────────────────────────────────────

export interface ConfidenceThresholds {
  /** The top option's probability must reach this. */
  minTop: number;
  /** And lead the runner-up by this much. */
  minMargin: number;
}

/**
 * The pre-router readout was right on 78 of 80 answers at a top probability of 0.85 or more
 * (2026-09-27); the margin is the ecosystem recipe's (pi-laya-router, DecisionKit): two options
 * both near 0.5 are no answer, however the top one rounds.
 *
 * At THESE defaults the margin never binds. A reading's probabilities sum to 1, so a top of 0.85
 * leaves the runner-up at most 0.15 and the margin at least 2 × 0.85 − 1 = 0.70 (200,000 random
 * readings of 2 to 20 options: smallest margin at top ≥ 0.85 was 0.7001). The margin binds only
 * where minTop is below (1 + minMargin) / 2 — 0.575 with a margin of 0.15 — e.g. a per-facet
 * threshold lowered after calibration. At the defaults, "confidence AND margin" is confidence.
 */
export const DEFAULT_CONFIDENCE: Readonly<ConfidenceThresholds> = Object.freeze({ minTop: 0.85, minMargin: 0.15 });

/** Does a reading clear both thresholds? */
export function isConfident(read: { top: number; margin: number } | undefined, thresholds: ConfidenceThresholds = DEFAULT_CONFIDENCE): boolean {
  return read !== undefined && read.top >= thresholds.minTop && read.margin >= thresholds.minMargin;
}

// ── Comparing with triage ────────────────────────────────────────────────────────────────────────

/**
 * A triage verdict in this readout's keys, facet by facet, for a shadow run that counts where the
 * two agree: the first domain as the primary one ("other" when there is none), booleans as
 * yes/no. Triage's `multi` is true only with two or more `parts` (parseTriageVerdict); the
 * readout's has no such gate, so part of any disagreement counted on `multi` is that gate. Pure.
 */
export function triageVerdictKeys(verdict: TriageVerdict): Record<IntentFacetName, string> {
  const yesNo = (value: boolean) => (value ? "yes" : "no");
  return {
    mode: verdict.mode,
    domain: verdict.domain[0] ?? "other",
    deliverable: verdict.deliverable,
    multi: yesNo(verdict.multi),
    alone: yesNo(verdict.alone),
    source_sensitive: yesNo(verdict.sourceSensitive),
    decision: verdict.decision,
  };
}

/**
 * The request-side facets the routing fusion scores against (agent/triage.ts verdictFacets),
 * from a reading: undefined without a mode; the primary domain alone, none for `other`; no
 * deliverable for `none`. Only facets that clear `thresholds` count, when given. Pure.
 */
export function intentRequestFacets(readout: IntentReadout, thresholds?: ConfidenceThresholds): RequestFacets | undefined {
  const usable = (name: IntentFacetName): IntentFacetRead | undefined => {
    const read = readout.facets[name];
    return read && (!thresholds || isConfident(read, thresholds)) ? read : undefined;
  };
  const mode = usable("mode");
  if (!mode) return undefined;
  const domain = usable("domain");
  const deliverable = usable("deliverable");
  return {
    mode: mode.choice as RequestFacets["mode"],
    domain: domain && domain.choice !== "other" ? [domain.choice as RequestFacets["domain"][number]] : [],
    ...(deliverable && deliverable.choice !== "none" ? { deliverable: deliverable.choice as NonNullable<RequestFacets["deliverable"]> } : {}),
  };
}

// ── The pre-router ───────────────────────────────────────────────────────────────────────────────

export interface PreRouteReadoutInput {
  message: string;
  /** The embedding ranking, capsule first; the first `k` are offered, "none" always after them. */
  candidates: readonly string[];
  /** An agent's option text (agentDescriptionText); its name is prefixed. */
  describe: (name: string) => string;
  /** Agents offered; default and bounds as the bench's (DEFAULT_CANDIDATES, MAX_CANDIDATES). */
  k?: number;
}

export interface PreRouteReadout {
  choice: string;
  top: number;
  runnerUp: string | undefined;
  margin: number;
  probabilities: Record<string, number>;
  logScores: Record<string, number>;
  /** The options in the order offered, "none" last. */
  keys: string[];
  mass: number;
  temperature: number;
  ms: number;
}

export type PreRouteReadoutResult =
  | { ok: true; readout: PreRouteReadout }
  | { ok: false; reason: ReadoutMissReason | "error" | "aborted" | "no_candidates"; ms: number; topToken?: string; error?: string };

export interface PreRouteReadoutOptions {
  signal?: AbortSignal;
  /** The letters' temperature (fitTemperature), per language by the caller; default 1. */
  temperature?: number;
  topLogprobs?: number;
  minMass?: number;
}

/** A single-token readout of the pre-route question as a pre-router reading, over the keys offered. Pure. */
export function preRouteReadoutFrom(result: ReadoutResult, keys: readonly string[]): PreRouteReadoutResult {
  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason,
      ms: result.ms,
      ...(result.topToken !== undefined ? { topToken: result.topToken } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
  }
  const { answer } = result;
  if (!keys.includes(answer.choice) || keys.some((key) => !Number.isFinite(answer.probabilities[key]))) {
    return { ok: false, reason: "error", ms: answer.ms, error: "the answer does not fit the options" };
  }
  const { runnerUp, margin } = marginOf(answer.probabilities);
  return {
    ok: true,
    readout: {
      choice: answer.choice,
      top: answer.top,
      runnerUp,
      margin,
      probabilities: answer.probabilities,
      logScores: answer.logScores,
      keys: [...keys],
      mass: answer.mass,
      temperature: answer.temperature,
      ms: answer.ms,
    },
  };
}

/**
 * Ask the pre-route question — the bench's own, word for word (decisions/pre-route-question.ts) —
 * of the routing tier, read by its logits (askReadout: one token, thinking off). Never throws.
 */
export async function askPreRouteReadout(
  provider: Pick<ChatProvider, "complete">,
  input: PreRouteReadoutInput,
  options: PreRouteReadoutOptions = {},
): Promise<PreRouteReadoutResult> {
  let built: ReturnType<typeof buildPreRouteQuestion>;
  try {
    built = buildPreRouteQuestion({
      id: PRE_ROUTE_POINT,
      message: input.message,
      candidates: input.candidates,
      describe: input.describe,
      ...(input.k !== undefined ? { k: input.k } : {}),
    });
  } catch (err) {
    return { ok: false, reason: "error", ms: 0, error: err instanceof Error ? err.message : String(err) };
  }
  if (!built) return { ok: false, reason: "no_candidates", ms: 0 };
  const result = await askReadout(provider, built.request, built.request.state, {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.topLogprobs !== undefined ? { topLogprobs: options.topLogprobs } : {}),
    ...(options.minMass !== undefined ? { minMass: options.minMass } : {}),
  });
  return preRouteReadoutFrom(result, built.keys);
}

/**
 * The pre-router's answer with "none" protected: the agent read, only when it is an agent and
 * clears both thresholds; "none" — the orchestrator keeps the turn, as it does today — otherwise.
 * A wrong specialist costs a failed delegation and a retry, minutes; "none" costs the routing
 * round it would have saved. Pure.
 */
export function acceptPreRoute(readout: PreRouteReadout | undefined, thresholds: ConfidenceThresholds = DEFAULT_CONFIDENCE): string {
  if (!readout || readout.choice === NONE_KEY) return NONE_KEY;
  return isConfident(readout, thresholds) ? readout.choice : NONE_KEY;
}
