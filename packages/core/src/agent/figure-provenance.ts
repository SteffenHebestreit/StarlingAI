/**
 * Which figures in a run's answer some input of the run actually contained.
 *
 * E2E 2026-10-07 (session 3c0c5ce1): the coder wrote primes.js, and all seven of its sandbox runs
 * failed or printed nothing. Its answer still gave a table with "8.393" primes summing to
 * "7.597.648.268" (the true values are 8392 and 1255204276), and the single-deliverable relay
 * shipped it word for word. Nothing the run had received or executed contained either number: the
 * model computed them in its head and presented them as the script's result.
 *
 * A figure is compared by its digits alone, so the grouping a locale writes ("8.393", "8,393",
 * "8 393" with a narrow no-break space) and the plain form a program prints ("8393") are one key.
 * A digit run glued to a letter, digit or underscore in front of it is part of an identifier
 * (v18, x86_64, ES2020, a session id) and not a figure. One-digit keys are ignored: they are
 * everywhere and prove nothing.
 *
 * Pure and without imports, so the sub-agent loop, the frame builder and the tests share one
 * definition of a figure.
 */

/** What an unobserved figure is replaced with. It holds no digit, so masking twice changes nothing. */
export const UNOBSERVED_FIGURE_MARKER = "[not observed]";

/** A run of digits, optionally grouped in threes by . , ' ’ NBSP or NNBSP, with an optional decimal
 *  tail; never one that continues a word or a number in front of it. */
const FIGURE_RE = /(?<![\p{L}\p{N}_])(?:\p{Nd}{1,3}(?:[.,'\u2019\u00a0\u202f]\p{Nd}{3})+(?:[.,]\p{Nd}+)?|\p{Nd}+(?:[.,]\p{Nd}+)?)(?!\p{N})/gu;

const DECIMAL_DIGIT_RE = /\p{Nd}/u;

/**
 * The value of one decimal digit of any script, as an ASCII digit. Unicode assigns decimal digits
 * only in contiguous runs of ten, zero first, so a digit's value is its distance from the start of
 * its run, modulo ten (several scripts' runs sit back to back, which the modulo absorbs).
 */
function asciiDigit(digit: string): string {
  const codePoint = digit.codePointAt(0)!;
  if (codePoint >= 0x30 && codePoint <= 0x39) return digit;
  let start = codePoint;
  while (start > 0 && DECIMAL_DIGIT_RE.test(String.fromCodePoint(start - 1))) start--;
  return String((codePoint - start) % 10);
}

/** The digits of a figure, without the separators and the leading zeros. "8.393" → "8393". */
export function figureKey(raw: string): string {
  return raw.replace(/\p{Nd}/gu, asciiDigit).replace(/\D/g, "").replace(/^0+/, "");
}

/** Only keys of two or more digits carry provenance. */
function countsAsFigure(key: string): boolean {
  return key.length >= 2;
}

/** Add the key of every figure in `text` to `into`, except the keys in `except`. */
export function addFigureKeys(into: Set<string>, text: string | null | undefined, except?: ReadonlySet<string>): void {
  if (!text) return;
  for (const match of text.matchAll(FIGURE_RE)) {
    const key = figureKey(match[0]);
    if (countsAsFigure(key) && !except?.has(key)) into.add(key);
  }
}

/**
 * Add the key of every figure in a tool call's arguments: each string and number, at any depth.
 * Read value by value, not from the call's JSON, where an escape glues a letter to the figure
 * behind it ("Anzahl:\n8393" is "Anzahl:\\n8393" there, and "n8393" is no figure).
 */
export function addArgumentFigureKeys(into: Set<string>, value: unknown, depth = 0): void {
  if (typeof value === "string") addFigureKeys(into, value);
  else if (typeof value === "number" && Number.isFinite(value)) addFigureKeys(into, String(value));
  else if (value && typeof value === "object" && depth < 8) {
    for (const entry of Array.isArray(value) ? value : Object.values(value)) addArgumentFigureKeys(into, entry, depth + 1);
  }
}

/** A stretch of an answer, by character offsets, that the figure check reads past. */
export interface FigureCheckSpan {
  readonly start: number;
  readonly end: number;
}

function insideSpan(offset: number, spans: readonly FigureCheckSpan[]): boolean {
  return spans.some((span) => offset >= span.start && offset < span.end);
}

/**
 * `text` with every figure whose key is not in `observed` replaced by the marker, and how many were.
 * A figure inside one of `skip` is left alone and not counted.
 */
export function maskUnobservedFigures(
  text: string,
  observed: ReadonlySet<string>,
  skip: readonly FigureCheckSpan[] = [],
): { text: string; masked: number } {
  let masked = 0;
  const result = text.replace(FIGURE_RE, (figure: string, offset: number) => {
    const key = figureKey(figure);
    if (!countsAsFigure(key) || observed.has(key) || insideSpan(offset, skip)) return figure;
    masked++;
    return UNOBSERVED_FIGURE_MARKER;
  });
  return { text: masked > 0 ? result : text, masked };
}

/** How many figures in `text` maskUnobservedFigures would replace. */
export function countUnobservedFigures(text: string, observed: ReadonlySet<string>, skip: readonly FigureCheckSpan[] = []): number {
  let count = 0;
  for (const match of text.matchAll(FIGURE_RE)) {
    const key = figureKey(match[0]);
    if (countsAsFigure(key) && !observed.has(key) && !insideSpan(match.index ?? 0, skip)) count++;
  }
  return count;
}

/**
 * The bodies of the fenced code blocks in `text` that quote one of `sources` verbatim: whole lines
 * of it, in order, compared without trailing whitespace or line-ending style. A figure there is a
 * figure of the code it quotes, not one the answer states. A fence that never closes, a body that
 * is part of a line, and a line the answer changed are no such quote.
 */
export function verbatimQuotedCodeSpans(text: string, sources: readonly string[]): FigureCheckSpan[] {
  const quotable = sources.map(normalizeQuotedLines).filter(Boolean).map((source) => `\n${source}\n`);
  if (quotable.length === 0) return [];
  return fencedBlockSpans(text, (body) => quotable.some((source) => source.includes(`\n${body}\n`)));
}

/**
 * The inline code spans and the closed fenced code blocks in `text` that quote one of `commands`
 * whole: their content, compared without line-ending style, trailing whitespace or the blank lines
 * and spaces around it, IS the command. A figure there is one of the command the run executed.
 * Part of a command is no such quote, and neither are some of its lines: a fence that repeats the
 * lines of a heredoc the command wrote would hand that file's figures back as the command's.
 */
export function verbatimQuotedCommandSpans(text: string, commands: readonly string[]): FigureCheckSpan[] {
  const quotable = new Set(commands.map(normalizedCommand).filter(Boolean));
  if (quotable.size === 0) return [];
  const spans: FigureCheckSpan[] = [];
  for (const match of text.matchAll(/(?<!`)(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g)) {
    if (!quotable.has(normalizedCommand(match[2]!))) continue;
    const start = match.index ?? 0;
    spans.push({ start, end: start + match[0].length });
  }
  return [...spans, ...fencedBlockSpans(text, (body) => quotable.has(body.trim()))];
}

function normalizedCommand(text: string): string {
  return normalizeQuotedLines(text).trim();
}

/** The bodies of the closed fenced code blocks in `text` whose normalized body `accept` takes. */
function fencedBlockSpans(text: string, accept: (body: string) => boolean): FigureCheckSpan[] {
  if (!/^ {0,3}(?:`{3,}|~{3,})/m.test(text)) return [];
  const lines: Array<{ text: string; start: number }> = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    lines.push({ text: line.replace(/\r$/, ""), start: offset });
    offset += line.length + 1;
  }
  const spans: FigureCheckSpan[] = [];
  for (let open = 0; open < lines.length; open++) {
    const opening = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(lines[open]!.text);
    if (!opening) continue;
    const indent = opening[1]!.length;
    const fence = opening[2]!;
    // A backtick fence's info string holds no backtick (CommonMark): "```x```" is inline code.
    if (fence.startsWith("`") && opening[3]!.includes("`")) continue;
    let close = open + 1;
    while (close < lines.length && !closesFence(lines[close]!.text, fence)) close++;
    // An open fence runs to the end of the answer, and nothing in it is a delimited quote.
    if (close >= lines.length) break;
    const body = normalizeQuotedLines(lines.slice(open + 1, close).map((line) => withoutIndent(line.text, indent)).join("\n"));
    if (body && accept(body)) {
      spans.push({ start: lines[open + 1]!.start, end: lines[close]!.start });
    }
    open = close;
  }
  return spans;
}

function closesFence(line: string, fence: string): boolean {
  const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return closing !== null && closing[1]![0] === fence[0] && closing[1]!.length >= fence.length;
}

/** "\n" line endings, nothing trailing on a line, no blank lines around. */
function normalizeQuotedLines(text: string): string {
  return text.replace(/\r\n?/g, "\n").split("\n").map((line) => line.replace(/[ \t]+$/, "")).join("\n").replace(/^\n+|\n+$/g, "");
}

/** The line without up to `columns` spaces: the fence's own indent (CommonMark). */
function withoutIndent(line: string, columns: number): string {
  let removed = 0;
  while (removed < columns && line[removed] === " ") removed++;
  return line.slice(removed);
}
