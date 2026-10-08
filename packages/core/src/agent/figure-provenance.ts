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

/** Add the key of every figure in `text` to `into`. */
export function addFigureKeys(into: Set<string>, text: string | null | undefined): void {
  if (!text) return;
  for (const match of text.matchAll(FIGURE_RE)) {
    const key = figureKey(match[0]);
    if (countsAsFigure(key)) into.add(key);
  }
}

/** `text` with every figure whose key is not in `observed` replaced by the marker, and how many were. */
export function maskUnobservedFigures(text: string, observed: ReadonlySet<string>): { text: string; masked: number } {
  let masked = 0;
  const result = text.replace(FIGURE_RE, (figure) => {
    const key = figureKey(figure);
    if (!countsAsFigure(key) || observed.has(key)) return figure;
    masked++;
    return UNOBSERVED_FIGURE_MARKER;
  });
  return { text: masked > 0 ? result : text, masked };
}

/** How many figures in `text` maskUnobservedFigures would replace. */
export function countUnobservedFigures(text: string, observed: ReadonlySet<string>): number {
  let count = 0;
  for (const match of text.matchAll(FIGURE_RE)) {
    const key = figureKey(match[0]);
    if (countsAsFigure(key) && !observed.has(key)) count++;
  }
  return count;
}
