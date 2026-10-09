/**
 * Explicit addition chains in an answer whose terms do not come to the total it states.
 *
 * E2E 2026-10-09 (session d1ba2275): browser_agent listed 18 stock values and wrote
 * "**Rechnung:** 17 + 9 + 1 + 38 + 22 + 0 + 19 + 30 + 5 + 0 + 4 + 2 + 95 + 180 + 36 + 44 + 29 + 73 = **609**".
 * Those 18 terms come to 604, and the single-deliverable relay would have shipped the line as it
 * was. This finds such a chain: "a + b + … = N" on one line, whose terms add (or subtract, for a
 * spaced minus) to something other than N under every decimal convention the chain can be read in.
 *
 * The grammar is anchored, so it fails open on anything that is not plainly a sum: a chain must
 * start the line, or follow a letter, ":", "|" or a list or quote marker; the stated total may not
 * be followed by an operator, a bracket, "%" or a digit; and between the terms there is nothing but
 * a "+" or a spaced minus. That rejects products and percentages ("3 × 19,90 € + 4,90 € = 64,60 €",
 * "200 € + 19 % = 238 €"), divisions and powers, bracketed and quoted parts, "a = b + c = d", an
 * elided "+ … +" chain and space-grouped thousands ("1 234 + 1 = 1 235"). Double emphasis (**, __)
 * and code are blanked first, keeping offsets: the real line above wraps its total in "**". A
 * single "*" stays, since it can mean multiplication.
 *
 * Both conventions are tried: "1.234 + 1 = 1.235" is a grouped sum and "1,5 + 1 = 2,5" a decimal
 * one, and neither is a mismatch. A stated total with more decimals than any term
 * ("0.1 + 0.2 = 0.30000000000000004") is not a sum anyone checked by hand, and is skipped.
 * Rounded shares written without "%" ("33 + 33 + 33 = 100") are kept in on purpose: a tolerance
 * wide enough for them would pass 609 against 604 as well. Shadow mode measures how often they occur.
 *
 * Pure: no config, no I/O. The sub-agent loop decides what a mismatch leads to.
 */
import { FIGURE_BODY } from "./figure-provenance.js";
import { strictFigureValue, type DecimalConvention, type Scaled } from "../tools/table-numbers.js";

export interface ArithmeticMismatch {
  /** The chain as the answer wrote it, at most 160 characters. */
  excerpt: string;
  /** Each term as written, sign and currency included, in order. */
  terms: string[];
  /** The operator before each term after the first: "+" or "-". */
  operators: Array<"+" | "-">;
  stated: string;
  /** What the terms come to, written in the convention the chain uses. */
  computed: string;
}

const MAX_TEXT_CHARS = 200_000;
const MAX_TERMS = 199;
const MAX_TERM_VALUE = 10n ** 15n;
const EXCERPT_CHARS = 160;

const FIGURE_RE = new RegExp(String.raw`(?<![\p{L}\p{N}_])${FIGURE_BODY}`, "gu");
const LETTER_OR_DIGIT_RE = /[\p{L}\p{N}]/u;
const CURRENCY_RE = /\p{Sc}/u;
const SIGNS = new Set(["-", "−"]);
const GLUE = new Set(["-", "/"]);
const PLUS_JOINER_RE = /^[ \t\u00a0\u202f]*\+[ \t\u00a0\u202f]*$/u;
const MINUS_JOINER_RE = /^[ \t\u00a0\u202f]+[-\u2212][ \t\u00a0\u202f]+$/u;
const EQUALS_RE = /^[ \t\u00a0\u202f]*=[ \t\u00a0\u202f]*$/u;
const LINE_SPACE_RE = /[ \t\u00a0\u202f]/u;
/** What may stand right before a chain, besides the start of the line and a letter. */
const LEAD_MARKS = new Set([":", "|"]);
/** A list or quote marker alone at the start of the line. */
const LINE_MARKER_RE = /^[ \t]*(?:[-•>]|\d+\.)$/u;
/** What may not follow the stated total: an operator, a bracket, "%" (and a digit, checked apart). */
const AFTER_REJECT = new Set(["+", "-", "−", "×", "*", "·", "/", "÷", "^", "=", "(", ")", "[", "]", "{", "}", "%", "…"]);

/** Fenced code, inline code and double emphasis markers replaced by spaces, offsets and line breaks kept. */
function blankMarkup(text: string): string {
  const blank = (match: string): string => match.replace(/[^\n]/g, " ");
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, blank)
    .replace(/`[^`\n]*`/g, blank)
    .replace(/\*\*|__/g, "  ");
}

interface Term {
  start: number;
  end: number;
  raw: string;
  sign: 1 | -1;
  text: string;
}

/** The figures of a line as terms (sign and currency attached), and where a figure is an identifier's. */
function termsOf(line: string): Array<Term | { blocker: true; start: number; end: number }> {
  const items: Array<Term | { blocker: true; start: number; end: number }> = [];
  for (const match of line.matchAll(FIGURE_RE)) {
    const figureStart = match.index;
    const figureEnd = figureStart + match[0].length;
    const before = line[figureStart - 1] ?? "";
    const after = line[figureEnd] ?? "";
    if ((GLUE.has(before) && LETTER_OR_DIGIT_RE.test(line[figureStart - 2] ?? "")) || (GLUE.has(after) && LETTER_OR_DIGIT_RE.test(line[figureEnd + 1] ?? ""))) {
      items.push({ blocker: true, start: figureStart, end: figureEnd });
      continue;
    }
    let start = figureStart;
    let end = figureEnd;
    // A currency symbol before the figure, at most one space away, then a sign glued to either.
    const currencyBefore = CURRENCY_RE.test(line[start - 1] ?? "") ? start - 1
      : LINE_SPACE_RE.test(line[start - 1] ?? "") && CURRENCY_RE.test(line[start - 2] ?? "") ? start - 2 : -1;
    if (currencyBefore >= 0) start = currencyBefore;
    let sign: 1 | -1 = 1;
    if (SIGNS.has(line[start - 1] ?? "") && !LETTER_OR_DIGIT_RE.test(line[start - 2] ?? "")) {
      sign = -1;
      start -= 1;
    }
    if (CURRENCY_RE.test(line[end] ?? "")) end += 1;
    else if (LINE_SPACE_RE.test(line[end] ?? "") && CURRENCY_RE.test(line[end + 1] ?? "")) end += 2;
    items.push({ start, end, raw: match[0], sign, text: line.slice(start, end) });
  }
  return items;
}

function isTerm(item: Term | { blocker: true }): item is Term {
  return !("blocker" in item);
}

function roundHalfUp(value: Scaled, scale: number): bigint {
  if (value.scale <= scale) return value.units * 10n ** BigInt(scale - value.scale);
  const divisor = 10n ** BigInt(value.scale - scale);
  const negative = value.units < 0n;
  const magnitude = negative ? -value.units : value.units;
  let quotient = magnitude / divisor;
  if ((magnitude % divisor) * 2n >= divisor) quotient += 1n;
  return negative ? -quotient : quotient;
}

function format(units: bigint, scale: number, convention: DecimalConvention): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, "0");
  const body = scale > 0 ? `${digits.slice(0, -scale)}${convention === "comma" ? "," : "."}${digits.slice(-scale)}` : digits;
  return `${negative ? "-" : ""}${body}`;
}

/** The chain's verdict under one convention: null when a figure is ill-formed under it or too large. */
function evaluate(terms: Term[], operators: Array<"+" | "-">, stated: Term, convention: DecimalConvention): { matches: boolean; computed: string } | "skip" | null {
  const values: Scaled[] = [];
  for (const term of terms) {
    const value = strictFigureValue(term.raw, term.sign, convention);
    if (!value) return null;
    if ((value.units < 0n ? -value.units : value.units) > MAX_TERM_VALUE * 10n ** BigInt(value.scale)) return "skip";
    values.push(value);
  }
  const statedValue = strictFigureValue(stated.raw, stated.sign, convention);
  if (!statedValue) return null;
  const scale = values.reduce((max, value) => Math.max(max, value.scale), 0);
  // A total with more decimals than any of its terms is not a sum written by hand.
  if (statedValue.scale > scale) return "skip";
  let total = 0n;
  values.forEach((value, index) => {
    const units = value.units * 10n ** BigInt(scale - value.scale);
    total += index > 0 && operators[index - 1] === "-" ? -units : units;
  });
  const rounded = roundHalfUp({ units: total, scale }, statedValue.scale);
  return { matches: rounded === statedValue.units, computed: format(total, scale, convention) };
}

function leadAllowed(line: string, start: number): boolean {
  const prefix = line.slice(0, start).replace(/[ \t\u00a0\u202f]+$/u, "");
  if (prefix === "") return true;
  const last = prefix[prefix.length - 1]!;
  return /\p{L}/u.test(last) || LEAD_MARKS.has(last) || LINE_MARKER_RE.test(prefix);
}

function tailAllowed(line: string, end: number): boolean {
  const suffix = line.slice(end).replace(/^[ \t\u00a0\u202f]+/u, "");
  if (suffix === "") return true;
  const first = suffix[0]!;
  return !AFTER_REJECT.has(first) && !/\p{N}/u.test(first) && !suffix.startsWith("...");
}

/** One line's chains that do not add up. */
function lineMismatches(line: string, original: string): ArithmeticMismatch[] {
  const found: ArithmeticMismatch[] = [];
  const items = termsOf(line);
  let chain: Term[] = [];
  let operators: Array<"+" | "-"> = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    if (!isTerm(item)) {
      chain = [];
      operators = [];
      continue;
    }
    if (chain.length === 0) {
      chain = [item];
      operators = [];
      continue;
    }
    const previous = chain[chain.length - 1]!;
    const gap = line.slice(previous.end, item.start);
    if (PLUS_JOINER_RE.test(gap) || MINUS_JOINER_RE.test(gap)) {
      chain.push(item);
      operators.push(PLUS_JOINER_RE.test(gap) ? "+" : "-");
      continue;
    }
    if (EQUALS_RE.test(gap) && chain.length >= 2 && chain.length <= MAX_TERMS) {
      const stated = item;
      if (leadAllowed(line, chain[0]!.start) && tailAllowed(line, stated.end)) {
        const verdicts = (["comma", "point"] as const).map((convention) => ({ convention, verdict: evaluate(chain, operators, stated, convention) }));
        const readable = verdicts.filter((entry) => entry.verdict !== null);
        const skipped = readable.some((entry) => entry.verdict === "skip");
        const valid = readable.filter((entry): entry is { convention: DecimalConvention; verdict: { matches: boolean; computed: string } } => entry.verdict !== null && entry.verdict !== "skip");
        if (!skipped && valid.length > 0 && valid.every((entry) => !entry.verdict.matches)) {
          // Written in the convention the chain's own figures show, else the first that reads it.
          const shown = valid.find((entry) => /,\p{Nd}{1,2}$/u.test(stated.raw) === (entry.convention === "comma")) ?? valid[0]!;
          const excerpt = original.slice(chain[0]!.start, stated.end).trim();
          found.push({
            excerpt: excerpt.length > EXCERPT_CHARS ? `${excerpt.slice(0, EXCERPT_CHARS - 1)}…` : excerpt,
            terms: chain.map((term) => term.text.trim()),
            operators: [...operators],
            stated: stated.text.trim(),
            computed: shown.verdict.computed,
          });
        }
      }
    }
    // Anything else between two figures ends the chain; the figure after it may start the next.
    // A stated total starts nothing: "17 + 9 = 26 + 1" was refused by its tail above.
    chain = EQUALS_RE.test(gap) ? [] : [item];
    operators = [];
  }
  return found;
}

/**
 * The explicit addition chains in `text` whose terms do not come to the total stated, under either
 * decimal convention. Empty for a text over 200,000 characters.
 */
export function findArithmeticMismatches(text: string): ArithmeticMismatch[] {
  if (!text || text.length > MAX_TEXT_CHARS) return [];
  const blanked = blankMarkup(text);
  const lines = blanked.split("\n");
  const originals = text.split("\n");
  const found: ArithmeticMismatch[] = [];
  lines.forEach((line, index) => {
    if (!line.includes("=")) return;
    found.push(...lineMismatches(line, originals[index] ?? line));
  });
  return found;
}

/** A chain as the nudge shows it: every term up to three, else the first two, "…" and the last. */
export function describeChain(mismatch: ArithmeticMismatch): string {
  const { terms, operators } = mismatch;
  const joined = (from: number, to: number): string => terms.slice(from, to).map((term, offset) => {
    const index = from + offset;
    return index === 0 ? term : `${operators[index - 1]} ${term}`;
  }).join(" ");
  if (terms.length <= 3) return joined(0, terms.length);
  const allPlus = operators.every((operator) => operator === "+");
  const last = `${operators[operators.length - 1]} ${terms[terms.length - 1]}`;
  return allPlus ? `${joined(0, 2)} + … ${last}` : `${joined(0, 2)} … ${last}`;
}
