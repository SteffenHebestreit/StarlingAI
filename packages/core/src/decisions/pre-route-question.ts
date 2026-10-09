/**
 * The pre-router's question: which one listed specialist should take the user's message, or
 * "none" — the orchestrator keeps the turn. Built from the embedding ranking's top K agents with
 * "none" always offered, last.
 *
 * Moved here from agent/pre-router-bench.ts (which re-exports every name, so the bench and its
 * tests are unchanged) because a production readout now asks it too
 * (decisions/intent-readout.ts askPreRouteReadout): the bench measured this exact question — the
 * readout backend at 72.5% top-1, 78 of 80 right at a top probability of 0.85 or more
 * (2026-09-27) — so the production readout asks it word for word, with the same option cuts,
 * rather than a copy that could drift from what was measured.
 *
 * The option budget is still sized to Laya's window (LAYA_WINDOW_TOKENS): the question is one
 * question for both answerers, so the bench's Laya and readout figures stay comparable.
 */

/** The decision point's id in training items and reports. */
export const PRE_ROUTE_POINT = "pre_route";

/** The option that leaves the turn to the orchestrator. */
export const NONE_KEY = "none";

/** docker/laya/app/generic.py MAX_OPTIONS: the sidecar refuses more, and accuracy falls off past it. */
export const MAX_LAYA_OPTIONS = 20;

/** Agents per question: one option is always "none", so at most 19 agents fit the sidecar's 20. */
export const MAX_CANDIDATES = MAX_LAYA_OPTIONS - 1;

export const DEFAULT_CANDIDATES = 8;

/** decisions/points.ts: Laya cuts each option to 48 tokens, so a longer one loses its tail unseen. */
export const OPTION_TOKEN_LIMIT = 48;

/**
 * Laya reads the question, every option and the state in one window of about 1024 tokens. Nineteen
 * options at 48 tokens fill it on their own, and what the model then cuts is not ours to choose —
 * it could be the message. So the per-option budget shrinks with the option count instead.
 */
export const LAYA_WINDOW_TOKENS = 1024;

/** An agent's name and a few words: below this an option says nothing its name does not. */
const MIN_OPTION_TOKENS = 12;

/** The same cut the up-front source-sensitivity judge applies to the message it hands Laya. */
const MAX_STATE_MESSAGE_CHARS = 2_000;

export const PRE_ROUTE_QUESTION = "Which specialist should handle this request? An AI assistant can hand the user's "
  + "message straight to one specialist agent, or leave it to its orchestrator, which answers directly, splits the work "
  + "across several specialists, or first gathers context from earlier in the conversation. Choose the one listed "
  + "specialist that can handle the whole message on its own. Choose none when no listed specialist fits it, when it "
  + "needs several of them, or when it needs no specialist at all.";

export const NONE_DESCRIPTION = "none: answer directly, or the orchestrator plans it — no listed specialist fits the whole request alone.";

/** A crude upper estimate of the characters one subword token covers in German and English text. */
const CHARS_PER_TOKEN = 4;

const PIECE_RE = /[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu;
const WORD_START_RE = /^[\p{L}\p{N}]/u;

/**
 * A conservative token count without the sidecar's tokenizer: every run of letters and digits
 * costs one token per four characters, every other visible character one token. Subword
 * tokenizers usually do better on common words, so this errs towards cutting a little early,
 * which only shortens a description — never the message.
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const piece of text.match(PIECE_RE) ?? []) {
    tokens += WORD_START_RE.test(piece) ? Math.ceil(piece.length / CHARS_PER_TOKEN) : 1;
  }
  return tokens;
}

/** `text` with whitespace collapsed, cut to at most `budget` estimated tokens, an ellipsis marking a cut. */
export function shortenToTokens(text: string, budget: number): string {
  const limit = Math.max(2, Math.floor(budget));
  const clean = text.replace(/\s+/g, " ").trim();
  if (estimateTokens(clean) <= limit) return clean;
  const kept: string[] = [];
  let used = 1; // the ellipsis
  for (const word of clean.split(" ")) {
    const cost = estimateTokens(word);
    if (used + cost > limit) break;
    kept.push(word);
    used += cost;
  }
  if (kept.length > 0) {
    // A cut that ends on a separator reads as a sentence that stopped; drop it before the ellipsis.
    return `${kept.join(" ").replace(/[\s,;:.]+$/u, "")}…`;
  }
  // The first word alone is over the budget (a URL, a long compound): cut it by characters.
  const chars = [...clean];
  let length = Math.min(chars.length, (limit - 1) * CHARS_PER_TOKEN);
  while (length > 1 && estimateTokens(`${chars.slice(0, length).join("")}…`) > limit) length -= 1;
  return `${chars.slice(0, length).join("")}…`;
}

export type DescriptionSource = "description" | "oneliner";

export interface DescribableAgent {
  description?: string;
  routingGenerated?: { oneLiner?: string };
}

/**
 * The text an agent's option is written from. The catalog description by default: the generated
 * one-liners are the taxonomy labeller's notes (facet names, lint findings, "unreachable by any
 * scene"), written to justify a label rather than to say what the agent does for a user. Either
 * falls back to the other when it is empty.
 */
export function agentDescriptionText(entry: DescribableAgent | undefined, source: DescriptionSource): string {
  const description = entry?.description?.trim() ?? "";
  const oneLiner = entry?.routingGenerated?.oneLiner?.trim() ?? "";
  return source === "oneliner" ? oneLiner || description : description || oneLiner;
}

/**
 * The candidates in the order they are offered: the production capsule first, as the orchestrator
 * would read it, then the rest of the embedding ranking. Duplicates, excluded agents (production
 * drops meta-factory agents from undirected routing) and anything named like the "none" option are
 * left out, and the list stops at `limit`.
 */
export function mergeCandidates(
  capsule: readonly string[],
  ranked: readonly string[],
  limit: number,
  exclude: (name: string) => boolean = () => false,
): string[] {
  const out: string[] = [];
  for (const name of [...capsule, ...ranked]) {
    if (out.length >= limit) break;
    if (!name || name === NONE_KEY || out.includes(name) || exclude(name)) continue;
    out.push(name);
  }
  return out;
}

/** Exactly what is POSTed to /v1/decide as one question. */
export interface PreRouteQuestion {
  id: string;
  question: string;
  options: Record<string, string>;
  state: { message: string };
}

export interface BuiltPreRouteQuestion {
  request: PreRouteQuestion;
  /**
   * The option keys in the order the sidecar receives them. Read back from the options object,
   * never assumed: that is the order JSON.stringify writes and generic.to_laya letters A, B, C…
   */
  keys: string[];
  /** The per-option token budget the descriptions were cut to. */
  optionTokens: number;
  /** The whole question's estimated size, and whether it is over Laya's window even so. */
  estimatedTokens: number;
  overWindow: boolean;
}

/**
 * The question for one message, or null when there is no agent to offer: the sidecar needs at
 * least two options, and "none" alone asks nothing.
 */
export function buildPreRouteQuestion(input: {
  id: string;
  message: string;
  candidates: readonly string[];
  describe: (name: string) => string;
  k?: number;
}): BuiltPreRouteQuestion | null {
  const k = input.k ?? DEFAULT_CANDIDATES;
  if (!Number.isInteger(k) || k < 1 || k > MAX_CANDIDATES) {
    throw new RangeError(`k must be a whole number from 1 to ${MAX_CANDIDATES} (the sidecar takes at most ${MAX_LAYA_OPTIONS} options, one of them "none"); got ${k}`);
  }
  const agents = mergeCandidates([], input.candidates, k);
  if (agents.length === 0) return null;
  const state = { message: input.message.slice(0, MAX_STATE_MESSAGE_CHARS) };
  const fixed = estimateTokens(PRE_ROUTE_QUESTION) + estimateTokens(JSON.stringify(state)) + estimateTokens(NONE_DESCRIPTION);
  const optionTokens = Math.max(
    MIN_OPTION_TOKENS,
    Math.min(OPTION_TOKEN_LIMIT, Math.floor((LAYA_WINDOW_TOKENS - fixed) / agents.length)),
  );
  const options: Record<string, string> = {};
  for (const name of agents) {
    const text = input.describe(name).trim();
    options[name] = shortenToTokens(text ? `${name}: ${text}` : name, optionTokens);
  }
  options[NONE_KEY] = NONE_DESCRIPTION;
  const keys = Object.keys(options);
  const estimatedTokens = fixed - estimateTokens(NONE_DESCRIPTION)
    + keys.reduce((sum, key) => sum + estimateTokens(options[key]!), 0);
  return {
    request: { id: input.id, question: PRE_ROUTE_QUESTION, options, state },
    keys,
    optionTokens,
    estimatedTokens,
    overWindow: estimatedTokens > LAYA_WINDOW_TOKENS,
  };
}
