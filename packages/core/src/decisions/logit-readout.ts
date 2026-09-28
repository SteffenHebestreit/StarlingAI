/**
 * A decision point's incumbent read by its logits: the resident model is asked the point's question
 * with the options under letters, for ONE token with thinking off, and the probabilities it gives
 * the option letters are the answer.
 *
 * Today each incumbent writes a verdict ("VERDICT: yes", a JSON object, "DONE") that a parser
 * reads, and gives no probability at all. Read off the distribution instead, the same weights
 * give a probability per option — in German as in English, where Laya is weakest — and a verdict
 * of several tokens costs one decode step: measured on the production llama-server 2026-09-26
 * (E1), the progress judge decodes 41 tokens (647 ms of 1,830 ms), the QA verdicts 60 (944 ms);
 * the receptionist and the source judge only 6 (84 ms), so there it is the probabilities, not the
 * time. The prefill floor (~0.7-0.8 s) stays either way.
 *
 * The question is the point's own (decisions/points.ts), written as Laya reads it: its options
 * under the neutral letters the sidecar uses (docker/laya/app/generic.py LETTERS, in the point's
 * order), so the readout, Laya and the fine-tuning export all ask one question. The answer is read
 * from the first generated token's top list:
 *
 *   - each option's letter is summed over its spellings: "A" and " A" (measured: "A" -0.185,
 *     " A" -2.589 on the same answer), also "A." / "A)" / "A:" — the letter as a list writes it.
 *     Not lowercase: "a" and "i" are English words, so their mass is no vote for an option; it
 *     measured at -8.99, e^-8.99 ≈ 0.0001, so leaving it out loses nothing either;
 *   - the sums are renormalised over the option letters and divided by a temperature fitted per
 *     point and language (`fitTemperature`, softmax(z / T));
 *   - a letter missing from the list is less likely than the list's last entry, so it gets that
 *     entry as a ceiling rather than zero: otherwise one listed letter would read as certainty.
 *
 * No answer — and the point's parsed incumbent decides as today — when the server sends no top
 * list, when no option letter is on it, when its most likely token is a control token (`<think>`,
 * a tool-call opener, end of turn: the model was about to do something else), or when the letters
 * together hold less than `minMass` of the probability.
 *
 * No sampling temperature is sent. llama-server's `top_logprobs` are the softmax of the raw logits
 * over the whole vocabulary, untouched by the sampler, grammar or logit_bias (`post_sampling_probs`
 * is off unless a request asks for it), so the sampler's temperature never reaches what is read
 * here, and the sampled token itself is never read. A backend that reported post-sampling probabilities would, at temperature 0, report a
 * degenerate 1.0 for its pick: sending 0 could only make such a readout worse.
 */
import type { ChatProvider, LLMMessage } from "../providers/lmstudio.js";

/** The sidecar's letters (docker/laya/app/generic.py LETTERS): option i is shown as LETTERS[i]. */
export const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** docker/laya/app/generic.py MAX_OPTIONS, and the most alternatives a server lists per token. */
export const MAX_READOUT_OPTIONS = 20;

/** OpenAI's cap on `top_logprobs`, and the one llama.cpp is discussing (#29456, 2026-09-26). */
export const MAX_TOP_LOGPROBS = 20;

/** Below this share on the option letters, the model was about to write something else. */
export const DEFAULT_MIN_LETTER_MASS = 0.5;

/** The range a fitted temperature is kept in; a fit that lands on either end says so (`clamped`). */
export const TEMPERATURE_BOUNDS = Object.freeze({ min: 0.05, max: 20 });

/**
 * Thinking off by both fields, as the synthesis passes send it (agent/sub-agent.ts
 * SYNTHESIS_CALL_CONTROLS): the enable_thinking family withholds the flag when a graded pin vetoes
 * it, and an explicit "none" is the only value that reaches the wire past that pin. A thinking
 * model's first token would be `<think>`, which is no answer. Exported for the intent readout
 * (decisions/intent-readout.ts), whose slots are read the same way.
 */
export const READOUT_CONTROLS = { enableThinking: false, reasoningEffort: "none" } as const;

/** What a readout asks: a decision point's definition fits as it is. */
export interface ReadoutQuestion {
  question: string;
  /** Each answer's key and what it means, in the order the letters are given. */
  options: Readonly<Record<string, string>>;
}

export interface ReadoutMessages {
  messages: LLMMessage[];
  /** The option keys in letter order: `keys[i]` is shown as `LETTERS[i]`. */
  keys: string[];
}

/** The option keys in the order given, checked: every key once, and only the question's own. */
function orderedKeys(question: ReadoutQuestion, order?: readonly string[]): string[] {
  const own = Object.keys(question.options);
  if (own.length < 2 || own.length > MAX_READOUT_OPTIONS) {
    throw new RangeError(`a readout needs 2 to ${MAX_READOUT_OPTIONS} options; got ${own.length}`);
  }
  if (!order) return own;
  if (order.length !== own.length || new Set(order).size !== order.length || order.some((key) => !own.includes(key))) {
    throw new RangeError(`the order must name each of the ${own.length} options once`);
  }
  return [...order];
}

function letterList(count: number): string {
  const letters = [...LETTERS.slice(0, count)];
  return count <= 3 ? `${letters.slice(0, -1).join(", ")} or ${letters.at(-1)}` : `one of ${letters[0]} to ${letters.at(-1)}`;
}

/** The case as the model reads it: one labelled section per field, text as it is, anything else as JSON. */
export function renderReadoutState(state: Record<string, unknown>): string {
  return Object.entries(state)
    .map(([key, value]) => `${key}:\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`)
    .join("\n\n");
}

/**
 * The readout's messages. Everything fixed for the point — the instruction, the question and the
 * lettered options — is the system message, so consecutive readouts of one point share their
 * prefix and only the case is new prefill (E2: a change inside the system text keeps none of the
 * cache). `order` reorders the options, for measuring letter-position bias; default the point's.
 */
export function buildReadoutMessages(question: ReadoutQuestion, state: Record<string, unknown>, order?: readonly string[]): ReadoutMessages {
  const keys = orderedKeys(question, order);
  const system = [
    "You answer one multiple-choice question about a case.",
    "",
    `Question: ${question.question.trim()}`,
    "",
    "Options:",
    ...keys.map((key, i) => `${LETTERS[i]}: ${question.options[key]!.trim()}`),
    "",
    `Reply with the letter of the one option that fits the case best (${letterList(keys.length)}): the letter alone, nothing else.`,
  ].join("\n");
  return {
    messages: [
      { role: "system", content: system },
      { role: "user", content: `Case:\n\n${renderReadoutState(state)}\n\nAnswer with the letter alone.` },
    ],
    keys,
  };
}

// ── Reading the letters off the top list ────────────────────────────────────────────────────────

export interface TopLogprob {
  token: string;
  logprob: number;
}

/** A letter, with the whitespace and the list punctuation it may be spelled with. */
const LETTER_TOKEN_RE = /^\s*([A-Z])[.):]?\s*$/;

/** The option letter a token spells, if it spells one of the first `count`. */
export function letterOfToken(token: string, count: number): string | undefined {
  const match = LETTER_TOKEN_RE.exec(token);
  if (!match) return undefined;
  const index = LETTERS.indexOf(match[1]!);
  return index >= 0 && index < count ? match[1] : undefined;
}

/**
 * A special token rather than text: `<think>`, `</think>`, `<tool_call>`, `<|im_end|>`. Its being
 * the most likely next token means the model was not about to answer with a letter.
 */
export function isControlToken(token: string): boolean {
  const text = token.trim();
  return /^<\/?[A-Za-z_][\w-]*>$/.test(text) || /^<\|[^|<>]+\|>$/.test(text);
}

export type ReadoutMissReason = "no_logprobs" | "no_letter" | "control_token" | "low_mass";

export interface LetterDistribution {
  /** Per option, in letter order: the log of its letter's probability, spellings summed. */
  logScores: number[];
  /** The probability the option letters hold together, as listed (ceilings not counted). */
  mass: number;
  /** The most likely token listed. */
  topToken: string;
}

/**
 * The option letters' log-probabilities from one token's top list, or why there are none. `count`
 * options, lettered A, B, … in order.
 *
 * `letterOf` says which option letter a listed token spells; default `letterOfToken`. The intent
 * readout passes its own for a slot whose token also carries the text before the letter (a
 * tokenizer that merges ":" and "C" into ":C" lists ":A", ":B" as the alternatives).
 */
export function scoreLetters(
  top: readonly TopLogprob[],
  count: number,
  minMass = DEFAULT_MIN_LETTER_MASS,
  letterOf: (token: string) => string | undefined = (token) => letterOfToken(token, count),
): { ok: true; value: LetterDistribution } | { ok: false; reason: ReadoutMissReason; topToken?: string } {
  const listed = top.filter((entry) => typeof entry.token === "string" && Number.isFinite(entry.logprob));
  if (listed.length < 2) return { ok: false, reason: "no_logprobs" };
  const sorted = [...listed].sort((a, b) => b.logprob - a.logprob);
  const topToken = sorted[0]!.token;
  if (isControlToken(topToken)) return { ok: false, reason: "control_token", topToken };
  const probability = new Array<number>(count).fill(0);
  const seen = new Set<string>();
  for (const entry of sorted) {
    // A server lists each token once; a repeat is not a second vote.
    if (seen.has(entry.token)) continue;
    seen.add(entry.token);
    const letter = letterOf(entry.token);
    const index = letter === undefined ? -1 : LETTERS.indexOf(letter);
    if (index >= 0 && index < count) probability[index]! += Math.exp(entry.logprob);
  }
  const mass = probability.reduce((sum, p) => sum + p, 0);
  if (mass === 0) return { ok: false, reason: "no_letter", topToken };
  if (mass < minMass) return { ok: false, reason: "low_mass", topToken };
  const ceiling = sorted.at(-1)!.logprob;
  return {
    ok: true,
    value: { logScores: probability.map((p) => (p > 0 ? Math.log(p) : ceiling)), mass, topToken },
  };
}

/** The letters' distribution, or `undefined` whenever the parsed incumbent must decide instead. */
export function parseLetterReadout(top: readonly TopLogprob[], count: number, minMass = DEFAULT_MIN_LETTER_MASS): LetterDistribution | undefined {
  const scored = scoreLetters(top, count, minMass);
  return scored.ok ? scored.value : undefined;
}

/** softmax(z / T) over the options: T = 1 is the model's own distribution renormalised to its letters. */
export function applyTemperature(logScores: readonly number[], temperature: number): number[] {
  const t = Number.isFinite(temperature) && temperature > 0 ? temperature : 1;
  const scaled = logScores.map((z) => z / t);
  const max = Math.max(...scaled);
  const exp = scaled.map((z) => Math.exp(z - max));
  const sum = exp.reduce((total, value) => total + value, 0);
  return exp.map((value) => value / sum);
}

// ── Asking ───────────────────────────────────────────────────────────────────────────────────────

export interface ReadoutAnswer {
  /** The option with the highest probability. */
  choice: string;
  /** Its probability. */
  top: number;
  /** Per option key, after the temperature. */
  probabilities: Record<string, number>;
  /** Per option key, before it: what a later temperature fit reads. */
  logScores: Record<string, number>;
  mass: number;
  temperature: number;
  topToken: string;
  /** Round trip, as measured here. */
  ms: number;
}

export type ReadoutResult =
  | { ok: true; answer: ReadoutAnswer }
  | { ok: false; reason: ReadoutMissReason | "error" | "aborted"; ms: number; topToken?: string; error?: string };

export interface ReadoutOptions {
  signal?: AbortSignal;
  /** The options in this order instead of the question's. */
  order?: readonly string[];
  /** Default 1. */
  temperature?: number;
  /** Default and at most 20. */
  topLogprobs?: number;
  minMass?: number;
}

/** The answer from a scored top list: argmax, probabilities keyed by option. Pure. */
export function readoutAnswer(keys: readonly string[], letters: LetterDistribution, temperature: number, ms: number): ReadoutAnswer {
  const probabilities = applyTemperature(letters.logScores, temperature);
  let best = 0;
  for (let i = 1; i < probabilities.length; i += 1) if (probabilities[i]! > probabilities[best]!) best = i;
  return {
    choice: keys[best]!,
    top: probabilities[best]!,
    probabilities: Object.fromEntries(keys.map((key, i) => [key, probabilities[i]!])),
    logScores: Object.fromEntries(keys.map((key, i) => [key, letters.logScores[i]!])),
    mass: letters.mass,
    temperature,
    topToken: letters.topToken,
    ms,
  };
}

/**
 * Ask the question for one token and read the answer off its top list. Never throws: a failed call
 * is a miss, and the caller's parsed incumbent decides.
 */
export async function askReadout(
  provider: Pick<ChatProvider, "complete">,
  question: ReadoutQuestion,
  state: Record<string, unknown>,
  options: ReadoutOptions = {},
): Promise<ReadoutResult> {
  const started = Date.now();
  let built: ReadoutMessages;
  try {
    built = buildReadoutMessages(question, state, options.order);
  } catch (err) {
    return { ok: false, reason: "error", ms: 0, error: err instanceof Error ? err.message : String(err) };
  }
  const topLogprobs = Math.max(2, Math.min(MAX_TOP_LOGPROBS, Math.floor(options.topLogprobs ?? MAX_TOP_LOGPROBS)));
  try {
    const response = await provider.complete(built.messages, [], options.signal, {
      controls: READOUT_CONTROLS,
      maxTokens: 1,
      logprobs: true,
      topLogprobs,
    });
    const ms = Date.now() - started;
    const first = response.logprobs?.[0];
    if (!first) return { ok: false, reason: "no_logprobs", ms };
    const scored = scoreLetters(first.topLogprobs, built.keys.length, options.minMass ?? DEFAULT_MIN_LETTER_MASS);
    if (!scored.ok) return { ok: false, reason: scored.reason, ms, ...(scored.topToken !== undefined ? { topToken: scored.topToken } : {}) };
    return { ok: true, answer: readoutAnswer(built.keys, scored.value, options.temperature ?? 1, ms) };
  } catch (err) {
    const ms = Date.now() - started;
    if (options.signal?.aborted) return { ok: false, reason: "aborted", ms };
    return { ok: false, reason: "error", ms, error: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300) };
  }
}

// ── Calibration ──────────────────────────────────────────────────────────────────────────────────

export interface TemperatureSample {
  /** Per option, the log-score the readout recorded (`ReadoutAnswer.logScores` in letter order). */
  logScores: readonly number[];
  /** The index of the answer that was right. */
  label: number;
}

export interface TemperatureFit {
  temperature: number;
  /** Mean negative log-likelihood at the fitted temperature, and at T = 1. */
  nll: number;
  nllAtOne: number;
  /** The fit landed on an end of TEMPERATURE_BOUNDS: the true optimum lies beyond it. */
  clamped: boolean;
  samples: number;
}

/** Mean −log softmax(β·z)[label] over the samples. */
export function meanNll(samples: readonly TemperatureSample[], beta: number): number {
  let total = 0;
  for (const { logScores, label } of samples) {
    const scaled = logScores.map((z) => beta * z);
    const max = Math.max(...scaled);
    const logSum = max + Math.log(scaled.reduce((sum, z) => sum + Math.exp(z - max), 0));
    total += logSum - scaled[label]!;
  }
  return total / samples.length;
}

/**
 * The temperature that makes the readout's probabilities match how often it is right: T minimising
 * the mean negative log-likelihood of the right answers (temperature scaling, one parameter).
 *
 * The NLL is convex in β = 1/T, and so has one minimum along log β, which a golden-section search
 * over log β finds without derivatives. Samples whose label is not an option are skipped.
 */
export function fitTemperature(samples: readonly TemperatureSample[], bounds: { min: number; max: number } = TEMPERATURE_BOUNDS): TemperatureFit {
  const usable = samples.filter((s) => Number.isInteger(s.label) && s.label >= 0 && s.label < s.logScores.length && s.logScores.every(Number.isFinite));
  if (usable.length === 0) return { temperature: 1, nll: Number.NaN, nllAtOne: Number.NaN, clamped: false, samples: 0 };
  const f = (u: number) => meanNll(usable, Math.exp(u));
  let lo = Math.log(1 / bounds.max);
  let hi = Math.log(1 / bounds.min);
  const ratio = (Math.sqrt(5) - 1) / 2;
  let a = hi - ratio * (hi - lo);
  let b = lo + ratio * (hi - lo);
  let fa = f(a);
  let fb = f(b);
  for (let i = 0; i < 200 && hi - lo > 1e-10; i += 1) {
    if (fa <= fb) {
      hi = b;
      b = a;
      fb = fa;
      a = hi - ratio * (hi - lo);
      fa = f(a);
    } else {
      lo = a;
      a = b;
      fa = fb;
      b = lo + ratio * (hi - lo);
      fb = f(b);
    }
  }
  const u = (lo + hi) / 2;
  const temperature = 1 / Math.exp(u);
  const clamped = temperature <= bounds.min * 1.001 || temperature >= bounds.max * 0.999;
  return { temperature, nll: f(u), nllAtOne: f(0), clamped, samples: usable.length };
}

/**
 * Expected calibration error: over equal-width confidence bins, the gap between how sure the
 * answers were and how often they were right, weighted by the bin's share. `null` without samples.
 */
export function expectedCalibrationError(samples: ReadonlyArray<{ confidence: number; correct: boolean }>, bins = 10): number | null {
  const usable = samples.filter((s) => Number.isFinite(s.confidence));
  if (usable.length === 0) return null;
  const count = new Array<number>(bins).fill(0);
  const confidence = new Array<number>(bins).fill(0);
  const correct = new Array<number>(bins).fill(0);
  for (const sample of usable) {
    const bin = Math.min(bins - 1, Math.max(0, Math.floor(sample.confidence * bins)));
    count[bin]! += 1;
    confidence[bin]! += sample.confidence;
    if (sample.correct) correct[bin]! += 1;
  }
  let ece = 0;
  for (let bin = 0; bin < bins; bin += 1) {
    if (count[bin] === 0) continue;
    ece += (count[bin]! / usable.length) * Math.abs(correct[bin]! / count[bin]! - confidence[bin]! / count[bin]!);
  }
  return ece;
}
