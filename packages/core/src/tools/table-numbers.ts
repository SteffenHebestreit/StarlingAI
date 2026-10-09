/**
 * The value of a table cell, read exactly, and arithmetic over such values without floats.
 *
 * E2E 2026-10-09: agents read the stock table of the fixture site and added 18 cells in their
 * heads. One misread a cell (the article "Lumen 50" carries a number in its name, which shifted
 * the count of numeric columns in a flattened row) and then added its own 18 terms wrongly too;
 * others dropped the article at 49,00 € from a "under 50 €" count. These rules make a cell's value
 * a structural fact, so web_table computes over every row and the model never transcribes one.
 *
 * A cell is numeric when it holds exactly one figure (figure-provenance's FIGURE_BODY) that is not
 * part of an identifier. Its decimal separator is inferred per column from the figures themselves,
 * then from the page's language through Intl, and only then read as thousands grouping. Values
 * are integers of minor units with a scale (8,90 is 890 with scale 2), so sums are exact.
 *
 * Pure and without side effects; shared by the table tool and its tests.
 */
import { asciiDigit, FIGURE_BODY } from "../agent/figure-provenance.js";

export type DecimalConvention = "comma" | "point";
/** How a column's figures are read: a decimal comma or point, or (no evidence and no language)
 *  a lone separator before three digits groups thousands. */
export type ColumnReading = DecimalConvention | "group";

/** A number as an integer of minor units and its count of decimal places: 8,90 is { units: 890n, scale: 2 }. */
export interface Scaled {
  units: bigint;
  scale: number;
}

/** One cell's value as the table tool reads it. */
export type CellValue =
  | { kind: "empty" }
  | { kind: "number"; raw: string; sign: 1 | -1; residue: string }
  | { kind: "text"; reason: "no figure" | "several figures" | "in brackets" };

/** A figure that no letter, digit or "_" precedes; the identifier rule below then drops glued ones. */
const FIGURE_IN_TEXT_RE = new RegExp(String.raw`(?<![\p{L}\p{N}_])${FIGURE_BODY}`, "gu");
const LETTER_OR_DIGIT_RE = /[\p{L}\p{N}]/u;
const SIGN_CHARS = new Set(["-", "−"]);
const GLUE_CHARS = new Set(["-", "/"]);
const CURRENCY_RE = /\p{Sc}/u;
const SEPARATOR_RE = /[^\p{Nd}]/gu;
const HAS_SEPARATOR_RE = /[^\p{Nd}]/u;

/** Whitespace evened out, NFKC applied and case folded: how headers, residues and text values compare. */
export function normalizeText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}

interface FoundFigure {
  raw: string;
  start: number;
  end: number;
  sign: 1 | -1;
  /** Where the figure begins with its sign, so the residue replaces both. */
  signedStart: number;
}

/**
 * The figures of a text that are values: a figure glued by "-" or "/" to a letter or digit on either
 * side is part of an identifier (NW-1101, 12-tlg., 2026-10-09, 1/2) and is not one. A "-" or "−"
 * right before a free-standing figure is its sign.
 */
function valueFigures(text: string): FoundFigure[] {
  const found: FoundFigure[] = [];
  for (const match of text.matchAll(FIGURE_IN_TEXT_RE)) {
    const start = match.index;
    const end = start + match[0].length;
    const before = text[start - 1] ?? "";
    const beforeThat = text[start - 2] ?? "";
    const after = text[end] ?? "";
    const afterThat = text[end + 1] ?? "";
    if (GLUE_CHARS.has(before) && LETTER_OR_DIGIT_RE.test(beforeThat)) continue;
    if (GLUE_CHARS.has(after) && LETTER_OR_DIGIT_RE.test(afterThat)) continue;
    const signed = SIGN_CHARS.has(before) && !LETTER_OR_DIGIT_RE.test(beforeThat);
    found.push({ raw: match[0], start, end, sign: signed ? -1 : 1, signedStart: signed ? start - 1 : start });
  }
  return found;
}

/** The nearest character on one side of [from, to) that is neither whitespace nor a currency symbol. */
function nearestMark(text: string, index: number, step: 1 | -1): string {
  for (let i = index; i >= 0 && i < text.length; i += step) {
    const ch = text[i]!;
    if (/\s/u.test(ch) || CURRENCY_RE.test(ch)) continue;
    return ch;
  }
  return "";
}

/**
 * A cell's value: empty, one number, or text. More than one figure makes a cell text (a range
 * "1–9 Stück", "Akku-Pack 18 V / 5,0 Ah", a date "30.09.2026", a footnote reference "1,234[12]").
 * A figure in parentheses is text too: whether "(1.234)" is an accounting negative is not guessed.
 * The residue is the cell with its figure replaced by "#", evened out and case folded; it is how
 * a column's cells are checked for one unit (residueCheck).
 */
export function readCellValue(text: string): CellValue {
  if (!text.trim()) return { kind: "empty" };
  const figures = valueFigures(text);
  if (figures.length === 0) return { kind: "text", reason: "no figure" };
  if (figures.length > 1) return { kind: "text", reason: "several figures" };
  const figure = figures[0]!;
  if (nearestMark(text, figure.signedStart - 1, -1) === "(" && nearestMark(text, figure.end, 1) === ")") {
    return { kind: "text", reason: "in brackets" };
  }
  const residue = normalizeText(`${text.slice(0, figure.signedStart)}#${text.slice(figure.end)}`);
  return { kind: "number", raw: figure.raw, sign: figure.sign, residue };
}

/**
 * What one figure says about the decimal separator, or null when it says nothing. ",dd" and
 * ".ddd,dd" mean a decimal comma, ".dd" and ",ddd.dd" a decimal point: a separator followed by a
 * digit count other than three is the decimal separator, of two different separators the last one
 * is, and a separator repeated is grouping, so the decimal separator is the other one. A lone
 * separator after a lone 0 is decimal too ("0,125"): grouping never follows a bare zero. "1.234"
 * and "1,234" on their own say nothing.
 */
export function decimalEvidence(raw: string): DecimalConvention | null {
  const separators = raw.match(SEPARATOR_RE) ?? [];
  if (separators.length === 0) return null;
  const decimalOf = (separator: string): DecimalConvention | null => separator === "," ? "comma" : separator === "." ? "point" : null;
  const distinct = new Set(separators);
  if (distinct.size >= 2) return decimalOf(separators[separators.length - 1]!);
  const separator = separators[0]!;
  if (separators.length >= 2) return separator === "." ? "comma" : separator === "," ? "point" : null;
  const at = raw.lastIndexOf(separator);
  const tail = raw.slice(at + 1);
  const head = raw.slice(0, at);
  if ([...tail].length !== 3 || (/^\p{Nd}$/u.test(head) && asciiDigit(head) === "0")) return decimalOf(separator);
  return null;
}

/** The decimal separator a page language writes, from the locale data Intl carries; null when unknown. */
export function languageDecimal(lang: string | null | undefined): DecimalConvention | null {
  if (!lang || !lang.trim()) return null;
  try {
    const decimal = new Intl.NumberFormat(lang.trim()).formatToParts(1.5).find((part) => part.type === "decimal")?.value;
    return decimal === "," ? "comma" : decimal === "." ? "point" : null;
  } catch {
    return null;
  }
}

/** Where a column's reading came from, printed on every aggregate line that uses it. */
export type ReadingSource = "cells" | "language" | "grouping" | "whole numbers";

export interface ColumnReadingResult {
  reading: ColumnReading;
  source: ReadingSource;
  lang?: string;
  /** Two figures that disagree: the column has no single convention and is not computed over. */
  conflict?: { comma: string; point: string };
}

/**
 * The reading of a column's figures: the convention every figure that says anything agrees on; else
 * the page language's decimal separator; else thousands grouping. `figures` pairs each figure with a
 * label (its row) for the conflict report.
 */
export function inferColumnReading(figures: ReadonlyArray<{ raw: string; label: string }>, lang?: string | null): ColumnReadingResult {
  let comma: string | undefined;
  let point: string | undefined;
  let anySeparator = false;
  for (const figure of figures) {
    if (HAS_SEPARATOR_RE.test(figure.raw)) anySeparator = true;
    const evidence = decimalEvidence(figure.raw);
    if (evidence === "comma") comma ??= figure.label;
    if (evidence === "point") point ??= figure.label;
  }
  if (comma !== undefined && point !== undefined) return { reading: "group", source: "cells", conflict: { comma, point } };
  if (comma !== undefined) return { reading: "comma", source: "cells" };
  if (point !== undefined) return { reading: "point", source: "cells" };
  if (!anySeparator) return { reading: "group", source: "whole numbers" };
  const fromLanguage = languageDecimal(lang);
  if (fromLanguage) return { reading: fromLanguage, source: "language", lang: String(lang).trim() };
  return { reading: "group", source: "grouping" };
}

/** How the aggregate line names the reading it used. */
export function describeReading(result: ColumnReadingResult): string {
  switch (result.source) {
    case "whole numbers":
      return "whole numbers";
    case "cells":
      return `decimal ${result.reading === "comma" ? "comma" : "point"}, from the cells`;
    case "language":
      return `decimal ${result.reading === "comma" ? "comma" : "point"}, from the page language ${JSON.stringify(result.lang ?? "")}`;
    case "grouping":
      return "no decimal separator found: a lone separator before three digits read as thousands grouping";
  }
}

function digitsOf(text: string): string {
  return [...text].filter((ch) => /\p{Nd}/u.test(ch)).map(asciiDigit).join("");
}

/**
 * A figure's value under a reading, or null when the figure does not fit it (a second decimal
 * separator). Under "group" every separator groups thousands.
 */
export function figureValue(raw: string, sign: 1 | -1, reading: ColumnReading): Scaled | null {
  const decimal = reading === "comma" ? "," : reading === "point" ? "." : null;
  let integerPart = raw;
  let fraction = "";
  if (decimal !== null) {
    const first = raw.indexOf(decimal);
    const last = raw.lastIndexOf(decimal);
    if (first !== last) return null;
    if (last >= 0) {
      integerPart = raw.slice(0, last);
      fraction = raw.slice(last + 1);
      // A grouping separator after the decimal one ("1,234.567" read with a decimal comma).
      if (HAS_SEPARATOR_RE.test(fraction)) return null;
    }
  }
  const digits = digitsOf(integerPart) + digitsOf(fraction);
  if (!digits) return null;
  return { units: BigInt(sign) * BigInt(digits), scale: [...fraction].length };
}

function rescale(value: Scaled, scale: number): bigint {
  return value.units * 10n ** BigInt(scale - value.scale);
}

export function compareScaled(a: Scaled, b: Scaled): number {
  const scale = Math.max(a.scale, b.scale);
  const x = rescale(a, scale);
  const y = rescale(b, scale);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** The exact sum, at the largest scale of its terms. */
export function sumScaled(values: readonly Scaled[]): Scaled {
  const scale = values.reduce((max, value) => Math.max(max, value.scale), 0);
  return { units: values.reduce((total, value) => total + rescale(value, scale), 0n), scale };
}

/** Divide exactly and round half away from zero to `scale` places. */
export function divideScaled(value: Scaled, divisor: number, scale: number): Scaled {
  const numerator = rescale(value, scale);
  const d = BigInt(divisor);
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  let quotient = magnitude / d;
  if ((magnitude % d) * 2n >= d) quotient += 1n;
  return { units: negative ? -quotient : quotient, scale };
}

/** The average, exact and rounded half away from zero to two places more than its terms carry. */
export function averageScaled(values: readonly Scaled[]): Scaled | null {
  if (values.length === 0) return null;
  const total = sumScaled(values);
  return divideScaled(total, values.length, total.scale + 2);
}

/** A value written in a column's convention, without thousands grouping: 227,40 / 227.40 / 596. */
export function formatScaled(value: Scaled, reading: ColumnReading): string {
  const negative = value.units < 0n;
  const digits = (negative ? -value.units : value.units).toString().padStart(value.scale + 1, "0");
  const separator = reading === "comma" ? "," : ".";
  const body = value.scale > 0 ? `${digits.slice(0, -value.scale)}${separator}${digits.slice(-value.scale)}` : digits;
  return `${negative ? "-" : ""}${body}`;
}

/**
 * A comparison value given to a `where` condition, as a figure under the column's reading. A JSON
 * number is read from its decimal string (String(49.9) is "49.9"), never through a float. A string
 * must hold exactly one figure; one whose own separators contradict the column's reading ("49.90"
 * on a decimal-comma column) is refused rather than read as 4990. Null means "not a figure".
 */
export function conditionFigure(value: unknown, column: ColumnReadingResult): Scaled | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const text = String(value);
    if (/e/i.test(text)) return null;
    const negative = text.startsWith("-");
    return figureValue(negative ? text.slice(1) : text, negative ? -1 : 1, "point");
  }
  if (typeof value !== "string") return null;
  const cell = readCellValue(value);
  if (cell.kind !== "number") return null;
  const evidence = decimalEvidence(cell.raw);
  if (evidence !== null && column.reading !== "group" && evidence !== column.reading) return null;
  const reading: ColumnReading = evidence ?? column.reading;
  return figureValue(cell.raw, cell.sign, reading);
}

/** The residue's marks that decide a unit: letters, currency symbols and brackets, around the "#". */
function unitOf(residue: string): string {
  return [...residue].filter((ch) => ch === "#" || /[\p{L}\p{Sc}()[\]{}]/u.test(ch)).join("");
}

export interface ResidueForm {
  residue: string;
  count: number;
  examples: string[];
}

export interface ResidueReport {
  /** The numeric cells carry one unit: a sum over them means something. */
  uniform: boolean;
  /** The distinct residues with counts, most frequent first. */
  forms: ResidueForm[];
}

/**
 * Whether a column's numeric cells carry one unit. Residues that differ in a letter, a currency
 * symbol or a bracket ("# €" beside "# mio. €", "$#" beside "#k") are not one unit, and a sum over
 * them would add millions to units; residues that differ only in other marks ("#*", "#†") are, and
 * the aggregate line notes them. Unicode categories, not a list of unit words.
 */
export function residueCheck(cells: ReadonlyArray<{ residue: string; label: string }>): ResidueReport {
  const forms = new Map<string, ResidueForm>();
  const units = new Set<string>();
  for (const cell of cells) {
    units.add(unitOf(cell.residue));
    const form = forms.get(cell.residue) ?? { residue: cell.residue, count: 0, examples: [] };
    form.count += 1;
    if (form.examples.length < 2) form.examples.push(cell.label);
    forms.set(cell.residue, form);
  }
  return { uniform: units.size <= 1, forms: [...forms.values()].sort((a, b) => b.count - a.count) };
}
