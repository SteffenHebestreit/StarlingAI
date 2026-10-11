/**
 * HTML tables as rows, and a column's aggregates over all of them, for the web_table tool.
 *
 * web_fetch's text flattens a table: stripHtml replaces every tag with a space, so a row reaches
 * the model as "NW-2101 Laser-Entfernungsmesser Lumen 50 19 11 14 20", where the article's own
 * "50" shifts every column after it. On the fixture site's stock page that cost an agent the
 * Südtal total (it read 19, Nordhafen's value, for 11). Here the table's structure is kept: cells
 * stay cells, colspan and rowspan expand into a grid, the header names the columns, and a column's
 * values are read and added by tools/table-numbers.ts. The model names a column and a condition;
 * it never transcribes a value into a computation.
 *
 * The scanner makes one forward pass and never backtracks. Comments and raw-text elements
 * (<script>, <style>, …) are skipped by searching for their end marker once, and a tag's attributes
 * are tokenized the way a browser does, so an unclosed quote or comment ends the document instead
 * of being searched for again from every later "<" (the throwaway prototype's lazy regexes took
 * minutes on a hostile 5 MB page). Every structure is capped (tables, rows, grid cells, spans).
 *
 * Page text is data. Every string taken from the page is stripped of control and format
 * characters before it is shown, and the computed lines come first, so nothing the page controls
 * can pose as a computed line.
 *
 * Pure: no network, no registry. tools/web-table.ts fetches the pages and calls in here.
 */
import { decodeHTML, decodeHTMLAttribute } from "entities";
import {
  averageScaled,
  compareScaled,
  conditionFigure,
  describeReading,
  figureValue,
  formatScaled,
  inferColumnReading,
  normalizeText,
  readCellValue,
  residueCheck,
  sumScaled,
  type CellValue,
  type ColumnReadingResult,
  type Scaled,
} from "./table-numbers.js";

// ─── Caps ─────────────────────────────────────────────────────────────────────

export const TABLE_LIMITS = Object.freeze({
  tablesPerPage: 50,
  rowsPerTable: 5_000,
  cellsPerTable: 100_000,
  cellsPerCall: 250_000,
  span: 50,
  /** A tag's attributes are read from its first 8 kB; a longer tag keeps its name, not its attributes. */
  tagAttributeChars: 8 * 1024,
  /** Text kept per cell (value and struck part each): more than any data cell holds. */
  cellChars: 10_000,
  /** The rows section of the output, as web_fetch's default maxLength. */
  rowsChars: 8_000,
});

/** The grid cells one call may still expand, shared by every page of the call. */
export interface CellBudget {
  cellsLeft: number;
}

export function newCellBudget(): CellBudget {
  return { cellsLeft: TABLE_LIMITS.cellsPerCall };
}

// ─── Work counters ────────────────────────────────────────────────────────────

/**
 * Work counted at the steps whose repetition once made one page cost seconds or the heap: the
 * parse counters for the last parseHtmlTables call, the computation counters for the last
 * computeTables call. Tests bound each by the size of the input instead of timing the call;
 * nothing else reads them.
 */
export interface TableWork {
  /** Parse: characters the scanner's searches and tag reads passed over, at most the document's length. */
  scannedChars: number;
  /** Parse: characters of page text entity-decoded into cell, struck and caption text. */
  decodedChars: number;
  /** Parse: positions visited once the grid is laid out, header positions named and row positions built. */
  gridPositions: number;
  /** Computation: characters of cell text read for values, conditions, groups, labels and the page signature. */
  cellTextChars: number;
  /** Computation: column names normalized for comparison. */
  namesNormalized: number;
}

const work: TableWork = { scannedChars: 0, decodedChars: 0, gridPositions: 0, cellTextChars: 0, namesNormalized: 0 };

export function tableWorkForTests(): TableWork {
  return { ...work };
}

// ─── Parsed model ─────────────────────────────────────────────────────────────

export interface TableCell {
  /** The cell's text without struck-through parts: its value. */
  text: string;
  /** Text inside <s>, <del> or <strike>: shown as ~~…~~, never part of the value. */
  struck: string;
}

export interface ParsedTable {
  /** 1-based position in the document, opening order. */
  number: number;
  id: string;
  caption: string;
  columns: string[];
  headerSource: "thead" | "th" | "none";
  /** Each row up to its last cell: a row may be shorter than `columns`, and a missing cell is empty. */
  rows: TableCell[][];
  footer: TableCell[][];
  /** A cap cut the table: rows after the first `rows.length` were not read. */
  truncated: boolean;
}

export interface ParsedDocument {
  tables: ParsedTable[];
  /** Tables past the per-page cap, listed as not read. */
  tablesNotRead: number;
  lang: string | null;
  /** The first link the page marks rel="next", as written (relative or absolute). */
  nextHref: string | null;
}

type Section = "head" | "body" | "foot";

interface RawCell {
  th: boolean;
  text: string;
  struck: string;
  colspan: number;
  rowspan: number;
}

interface RawRow {
  section: Section;
  cells: RawCell[];
  hidden: boolean;
}

interface OpenCell extends RawCell {
  hidden: boolean;
  struckDepth: number;
}

interface OpenTable {
  order: number;
  id: string;
  caption: string;
  inCaption: boolean;
  section: Section;
  rows: RawRow[];
  row: RawRow | null;
  cell: OpenCell | null;
  dropped: boolean;
  rawCells: number;
  truncated: boolean;
}

const RAW_TEXT_ELEMENTS = new Set(["script", "style", "template", "textarea", "title", "xmp", "iframe", "noembed", "noframes"]);
const STRUCK_ELEMENTS = new Set(["s", "del", "strike"]);

function isSpaceCode(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12;
}

function isAsciiAlphaCode(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/** ASCII letters lowered, every other character kept, so indices stay aligned with the source. */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}

interface ScannedTag {
  name: string;
  end: boolean;
  attrs: Map<string, string>;
  next: number;
}

/**
 * The tag starting at `lt`, tokenized as a browser does: attributes until a ">" outside quotes.
 * Null when the document ends inside it. Attributes ending past the first 8 kB are not kept.
 */
function scanTag(html: string, lt: number): ScannedTag | null {
  const length = html.length;
  let i = lt + 1;
  const end = html.charCodeAt(i) === 47;
  if (end) i++;
  const nameStart = i;
  while (i < length) {
    const code = html.charCodeAt(i);
    if (isSpaceCode(code) || code === 47 || code === 62) break;
    i++;
  }
  const name = asciiLower(html.slice(nameStart, i));
  const attrs = new Map<string, string>();
  const attributeLimit = lt + TABLE_LIMITS.tagAttributeChars;
  for (;;) {
    while (i < length && (isSpaceCode(html.charCodeAt(i)) || html.charCodeAt(i) === 47)) i++;
    if (i >= length) return null;
    if (html.charCodeAt(i) === 62) return { name, end, attrs, next: i + 1 };
    const attrStart = i;
    i++;
    while (i < length) {
      const code = html.charCodeAt(i);
      if (isSpaceCode(code) || code === 47 || code === 62 || code === 61) break;
      i++;
    }
    const attrName = asciiLower(html.slice(attrStart, i));
    while (i < length && isSpaceCode(html.charCodeAt(i))) i++;
    let value = "";
    if (html.charCodeAt(i) === 61) {
      i++;
      while (i < length && isSpaceCode(html.charCodeAt(i))) i++;
      const quote = html[i];
      if (quote === "\"" || quote === "'") {
        const close = html.indexOf(quote, i + 1);
        if (close < 0) return null;
        value = html.slice(i + 1, close);
        i = close + 1;
      } else {
        const valueStart = i;
        while (i < length && !isSpaceCode(html.charCodeAt(i)) && html.charCodeAt(i) !== 62) i++;
        value = html.slice(valueStart, i);
      }
    }
    if (i <= attributeLimit && !attrs.has(attrName)) attrs.set(attrName, decodeHTMLAttribute(value));
  }
}

function spanOf(value: string | undefined, zeroMeans: number): number {
  const parsed = Number.parseInt(value ?? "1", 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 1;
  if (parsed === 0) return zeroMeans;
  return Math.min(TABLE_LIMITS.span, parsed);
}

function hiddenBy(attrs: Map<string, string>): boolean {
  return attrs.has("hidden") || /display\s*:\s*none/i.test(attrs.get("style") ?? "");
}

function relHasNext(rel: string | undefined): boolean {
  return (rel ?? "").toLowerCase().split(/\s+/).includes("next");
}

/** Control characters become spaces and format characters (zero-width, bidi overrides) go. */
function stripInvisible(text: string): string {
  return text.replace(/\p{Cc}/gu, " ").replace(/\p{Cf}/gu, "");
}

/**
 * `raw` decoded and appended to `current`, up to TABLE_LIMITS.cellChars in all; what lies past the
 * cap is never decoded. The cap was checked before appending, and one text node was appended
 * whole: a cell made of a single 4.8 MB text node kept all of it. A decoded entity is never longer
 * than its source, so decoding grows from `room` source characters until it fills the room, and a
 * cut is moved before an "&" just behind it, so no entity is decoded from half its source.
 */
function appendDecoded(current: string, raw: string): string {
  const room = TABLE_LIMITS.cellChars - current.length;
  if (room <= 0) return current;
  for (let take = room; ; take *= 2) {
    let end = Math.min(raw.length, take);
    if (end < raw.length) {
      const amp = raw.lastIndexOf("&", end - 1);
      if (amp >= 0 && end - amp < 40) end = amp;
    }
    work.decodedChars += end;
    const decoded = decodeHTML(raw.slice(0, end));
    if (decoded.length >= room || end >= raw.length) {
      if (decoded.length <= room) return current + decoded;
      const cut = /[\uD800-\uDBFF]/.test(decoded[room - 1]!) ? room - 1 : room;
      return current + decoded.slice(0, cut);
    }
  }
}

/** A cell's stored text: invisible characters out, ASCII whitespace evened out. No-break spaces stay,
 *  because they group thousands ("1 234"). */
function cellText(parts: string): string {
  return stripInvisible(parts).replace(/[ \t\n\r\f]+/g, " ").trim();
}

/**
 * Every table of an HTML document, as grids with named columns. `budget` is shared by the pages of
 * one call; a table whose cells run past it, or past its own cap, keeps the rows read so far and
 * is marked truncated.
 */
export function parseHtmlTables(html: string, budget: CellBudget = newCellBudget(), options: { cut?: boolean } = {}): ParsedDocument {
  work.scannedChars = 0;
  work.decodedChars = 0;
  work.gridPositions = 0;
  const lower = asciiLower(html);
  const length = html.length;
  /** Where `needle` next stands in `text` (html or lower) from `from`, or -1; what the search passed over is counted. */
  const find = (text: string, needle: string, from: number): number => {
    const at = text.indexOf(needle, from);
    work.scannedChars += (at < 0 ? length : at) - from;
    return at;
  };
  const stack: OpenTable[] = [];
  const finished: OpenTable[] = [];
  let opened = 0;
  let recorded = 0;
  let tablesNotRead = 0;
  let lang: string | null = null;
  let nextHref: string | null = null;

  const top = (): OpenTable | undefined => stack[stack.length - 1];

  const onText = (raw: string): void => {
    const table = top();
    if (!table || table.dropped) return;
    if (table.cell) {
      const cell = table.cell;
      if (cell.hidden) return;
      if (cell.struckDepth > 0) cell.struck = appendDecoded(cell.struck, raw);
      else cell.text = appendDecoded(cell.text, raw);
      return;
    }
    if (table.inCaption) table.caption = appendDecoded(table.caption, raw);
  };

  const closeCell = (table: OpenTable): void => {
    const cell = table.cell;
    if (!cell) return;
    table.cell = null;
    if (cell.hidden || !table.row) return;
    table.row.cells.push({ th: cell.th, text: cell.text, struck: cell.struck, colspan: cell.colspan, rowspan: cell.rowspan });
  };

  const closeRow = (table: OpenTable): void => {
    closeCell(table);
    const row = table.row;
    if (!row) return;
    table.row = null;
    if (!row.hidden) table.rows.push(row);
  };

  const openRow = (table: OpenTable, hidden: boolean): void => {
    closeRow(table);
    if (table.dropped || table.truncated) return;
    if (table.rows.length >= TABLE_LIMITS.rowsPerTable) {
      table.truncated = true;
      return;
    }
    table.row = { section: table.section, cells: [], hidden };
  };

  const closeTable = (): void => {
    const table = stack.pop();
    if (!table) return;
    closeRow(table);
    if (!table.dropped) finished.push(table);
  };

  const onTag = (tag: ScannedTag): void => {
    const { name, end, attrs } = tag;
    if (!end && name === "html" && lang === null) lang = attrs.get("lang") ?? attrs.get("xml:lang") ?? null;
    if (!end && (name === "a" || name === "link") && nextHref === null && relHasNext(attrs.get("rel"))) {
      const href = attrs.get("href");
      if (href && href.trim()) nextHref = href.trim();
    }
    if (name === "table") {
      if (end) {
        closeTable();
        return;
      }
      const dropped = recorded >= TABLE_LIMITS.tablesPerPage;
      if (dropped) tablesNotRead++;
      else recorded++;
      stack.push({
        order: ++opened,
        id: attrs.get("id") ?? "",
        caption: "",
        inCaption: false,
        section: "body",
        rows: [],
        row: null,
        cell: null,
        dropped,
        rawCells: 0,
        truncated: false,
      });
      return;
    }
    const table = top();
    if (!table) return;
    switch (name) {
      case "caption":
        if (!table.cell) table.inCaption = !end;
        return;
      case "thead":
      case "tbody":
      case "tfoot":
        closeRow(table);
        table.section = end ? "body" : name === "thead" ? "head" : name === "tfoot" ? "foot" : "body";
        return;
      case "tr":
        if (end) closeRow(table);
        else openRow(table, hiddenBy(attrs));
        return;
      case "td":
      case "th": {
        if (end) {
          closeCell(table);
          return;
        }
        closeCell(table);
        if (!table.row) openRow(table, false);
        if (!table.row) return;
        const colspan = spanOf(attrs.get("colspan"), 1);
        if (table.rawCells + colspan > TABLE_LIMITS.cellsPerTable) {
          table.truncated = true;
          table.row = null;
          return;
        }
        table.rawCells += colspan;
        table.cell = {
          th: name === "th",
          text: "",
          struck: "",
          colspan,
          rowspan: spanOf(attrs.get("rowspan"), TABLE_LIMITS.span),
          hidden: hiddenBy(attrs),
          struckDepth: 0,
        };
        return;
      }
      default:
        break;
    }
    const cell = table.cell;
    if (!cell) return;
    if (STRUCK_ELEMENTS.has(name)) {
      cell.struckDepth = Math.max(0, cell.struckDepth + (end ? -1 : 1));
      return;
    }
    // Any other tag inside a cell is a boundary: "18<br>V" is "18 V", not "18V".
    onText(" ");
  };

  let pos = 0;
  scan: while (pos < length) {
    const lt = find(html, "<", pos);
    if (lt < 0) {
      onText(html.slice(pos));
      break;
    }
    if (lt > pos) onText(html.slice(pos, lt));
    if (html.startsWith("<!--", lt)) {
      if (html.startsWith("<!-->", lt)) {
        pos = lt + 5;
        continue;
      }
      if (html.startsWith("<!--->", lt)) {
        pos = lt + 6;
        continue;
      }
      const close = find(html, "-->", lt + 4);
      if (close < 0) break;
      pos = close + 3;
      continue;
    }
    const next = html.charCodeAt(lt + 1);
    if (next === 33 || next === 63) {
      const close = find(html, ">", lt + 2);
      if (close < 0) break;
      pos = close + 1;
      continue;
    }
    const nameCode = next === 47 ? html.charCodeAt(lt + 2) : next;
    if (!isAsciiAlphaCode(nameCode)) {
      onText("<");
      pos = lt + 1;
      continue;
    }
    const tag = scanTag(html, lt);
    work.scannedChars += (tag ? tag.next : length) - lt;
    if (!tag) break;
    pos = tag.next;
    if (!tag.end && RAW_TEXT_ELEMENTS.has(tag.name)) {
      let search = pos;
      for (;;) {
        const close = find(lower, `</${tag.name}`, search);
        if (close < 0) break scan;
        const after = html.charCodeAt(close + 2 + tag.name.length);
        if (Number.isNaN(after) || isSpaceCode(after) || after === 47 || after === 62) {
          const gt = find(html, ">", close);
          if (gt < 0) break scan;
          pos = gt + 1;
          break;
        }
        search = close + 2;
      }
      continue;
    }
    onTag(tag);
  }
  // A table left open at the end of the document (cut, or never closed) is read as far as it went;
  // when the document itself was cut short, by a cap here or by the body cap of the fetch, it has more.
  while (stack.length > 0) {
    const table = top()!;
    if (pos < length || options.cut) table.truncated = true;
    closeTable();
  }

  finished.sort((a, b) => a.order - b.order);
  const tables = finished.map((table, index) => finishTable(table, index + 1, budget));
  return { tables, tablesNotRead, lang: lang === null ? null : String(lang).trim() || null, nextHref };
}

interface GridCell {
  th: boolean;
  cell: TableCell;
}

/** What a row holds at a position no cell of its own covers, and past its last cell. Shared, never written. */
const EMPTY_CELL: TableCell = Object.freeze({ text: "", struck: "" });

/** A column's name is at most this long: a header is a few words. */
const COLUMN_NAME_CHARS = 200;

/** A parsed table's grid, header and rows, its expanded cells counted against both budgets. */
function finishTable(raw: OpenTable, number: number, budget: CellBudget): ParsedTable {
  let truncated = raw.truncated;
  let tableCells = 0;
  const grid: Array<{ section: Section; cells: Array<GridCell | undefined> }> = [];
  let pending: Array<{ cell: GridCell; left: number } | undefined> = [];
  let section: Section | null = null;
  const take = (count = 1): boolean => {
    if (tableCells + count > TABLE_LIMITS.cellsPerTable || count > budget.cellsLeft) return false;
    tableCells += count;
    budget.cellsLeft -= count;
    return true;
  };
  rows: for (const row of raw.rows) {
    // A rowspan never reaches across a row group (thead, tbody, tfoot).
    if (row.section !== section) {
      pending = [];
      section = row.section;
    }
    const out: Array<GridCell | undefined> = [];
    let col = 0;
    let covered = 0;
    const fillPendingAt = (index: number): boolean => {
      const carried = pending[index];
      if (!carried || carried.left <= 0) return false;
      if (!take()) return false;
      out[index] = carried.cell;
      covered++;
      carried.left--;
      return true;
    };
    for (const cell of row.cells) {
      while (pending[col] && pending[col]!.left > 0) {
        if (!fillPendingAt(col)) {
          truncated = true;
          break rows;
        }
        col++;
      }
      const value: GridCell = { th: cell.th, cell: { text: cellText(cell.text), struck: cellText(cell.struck) } };
      for (let k = 0; k < cell.colspan; k++) {
        if (!take()) {
          truncated = true;
          break rows;
        }
        out[col] = value;
        covered++;
        pending[col] = cell.rowspan > 1 ? { cell: value, left: cell.rowspan - 1 } : undefined;
        col++;
      }
    }
    for (let index = col; index < pending.length; index++) {
      if (pending[index] && pending[index]!.left > 0 && !fillPendingAt(index)) {
        truncated = true;
        break rows;
      }
    }
    // A gap left of a rowspan carried further right is stored as an empty cell, so it is paid
    // for like one: the stored rows hold no more positions than the caps allow.
    if (!take(out.length - covered)) {
      truncated = true;
      break rows;
    }
    grid.push({ section: row.section, cells: out });
  }

  let headerRows: typeof grid;
  let bodyRows: typeof grid;
  let headerSource: ParsedTable["headerSource"] = "none";
  if (grid.some((row) => row.section === "head")) {
    headerRows = grid.filter((row) => row.section === "head");
    bodyRows = grid.filter((row) => row.section === "body");
    headerSource = "thead";
  } else {
    let leading = 0;
    while (leading < grid.length && grid[leading]!.section === "body" && grid[leading]!.cells.length > 0
      && grid[leading]!.cells.every((cell) => cell?.th)) leading++;
    headerRows = grid.slice(0, leading);
    bodyRows = grid.slice(leading).filter((row) => row.section === "body");
    if (leading > 0) headerSource = "th";
  }
  const width = grid.reduce((max, row) => Math.max(max, row.cells.length), 0);
  // A column's name joins the distinct texts its header rows hold, top to bottom. Only the
  // positions a header row covers are visited, and a header cell's text is shown once however
  // many columns it spans: walking header rows × width for every column took 2,000 one-cell
  // header rows over a 98,000-column row through 196 million steps. A name is capped, so a
  // header cell's text past the cap is never shown, and a column stops taking parts past it.
  const shownHeader = new Map<GridCell, string>();
  const parts: string[][] = [];
  const partChars: number[] = [];
  for (const row of headerRows) {
    work.gridPositions += row.cells.length;
    row.cells.forEach((cell, index) => {
      if (!cell) return;
      let text = shownHeader.get(cell);
      if (text === undefined) {
        const shown = displayText(cell.cell.text);
        text = shown.slice(0, codePointEnd(shown, COLUMN_NAME_CHARS + 1));
        shownHeader.set(cell, text);
      }
      const list = (parts[index] ??= []);
      if (!text || list[list.length - 1] === text || (partChars[index] ?? 0) > 2 * COLUMN_NAME_CHARS + 3) return;
      list.push(text);
      partChars[index] = (partChars[index] ?? 0) + text.length + 3;
    });
  }
  const columns: string[] = [];
  const seen = new Map<string, number>();
  for (let index = 0; index < width; index++) {
    let name = capped(parts[index]?.join(" / ") ?? "", COLUMN_NAME_CHARS) || String(index + 1);
    const key = normalizeText(name);
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count > 1) name = `${name} (${count})`;
    columns.push(name);
  }
  // A row keeps its own positions only, and a reader takes a missing one as empty. Padding every
  // row to the widest row's width held rows × width cells for a page that paid for far fewer:
  // 64.5 kB of empty rows under one 100,000-column row ran the gateway out of heap.
  const asRow = (row: { cells: Array<GridCell | undefined> }): TableCell[] => {
    const cells = Array.from(row.cells, (cell) => cell?.cell ?? EMPTY_CELL);
    work.gridPositions += cells.length;
    return cells;
  };
  const nonEmpty = (cells: TableCell[]): boolean => cells.some((cell) => cell.text || cell.struck);
  return {
    number,
    id: displayText(raw.id),
    caption: displayText(raw.caption),
    columns,
    headerSource,
    rows: bodyRows.map(asRow).filter(nonEmpty),
    footer: grid.filter((row) => row.section === "foot").map(asRow).filter(nonEmpty),
    truncated,
  };
}

// ─── Charset ──────────────────────────────────────────────────────────────────

function charsetFromContentType(contentType: string | null | undefined): string | null {
  const match = /charset\s*=\s*["']?([^"';\s]+)/i.exec(contentType ?? "");
  return match ? match[1]! : null;
}

/** The charset a document declares in its first 1,024 bytes (<meta charset> or http-equiv), if any. */
function charsetFromMeta(bytes: Uint8Array): string | null {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  const direct = /<meta[^>]*?\scharset\s*=\s*["']?([^"'\s/>;]+)/i.exec(head);
  if (direct) return direct[1]!;
  const equiv = /<meta[^>]*?http-equiv\s*=\s*["']?content-type["']?[^>]*?content\s*=\s*["']([^"']*)["']/i.exec(head)
    ?? /<meta[^>]*?content\s*=\s*["']([^"']*)["'][^>]*?http-equiv\s*=\s*["']?content-type/i.exec(head);
  return equiv ? charsetFromContentType(equiv[1]) : null;
}

/**
 * A page body as text: the charset from the Content-Type header, else a <meta> declaration in the
 * first 1,024 bytes, else UTF-8. TextDecoder knows the WHATWG labels (Node's full ICU decodes
 * windows-1252); an unknown label decodes as UTF-8 and is reported.
 */
export function decodeHtmlBytes(bytes: Uint8Array, contentType: string | null | undefined): { text: string; charset: string; unknownLabel?: string } {
  const label = charsetFromContentType(contentType) ?? charsetFromMeta(bytes);
  if (label) {
    try {
      const decoder = new TextDecoder(label.trim().toLowerCase());
      return { text: decoder.decode(bytes), charset: decoder.encoding };
    } catch {
      return { text: new TextDecoder("utf-8").decode(bytes), charset: "utf-8", unknownLabel: label };
    }
  }
  return { text: new TextDecoder("utf-8").decode(bytes), charset: "utf-8" };
}

// ─── Showing page text ────────────────────────────────────────────────────────

/** Page text as it may be shown: control and format characters out, whitespace on one line. */
export function displayText(text: string): string {
  return stripInvisible(text).replace(/\s+/gu, " ").trim();
}

/** Where the first `count` code points of `text` end, as a UTF-16 index: its length when it has fewer. */
function codePointEnd(text: string, count: number): number {
  let index = 0;
  for (let seen = 0; seen < count && index < text.length; seen++) {
    const code = text.charCodeAt(index);
    const pair = code >= 0xd800 && code <= 0xdbff && (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00;
    index += pair ? 2 : 1;
  }
  return index;
}

/** At most `max` code points, the last one "…" when cut. Reads only as far as the cut, not the whole text. */
function capped(text: string, max: number): string {
  if (text.length <= max || codePointEnd(text, max) >= text.length) return text;
  return `${text.slice(0, codePointEnd(text, max - 1))}…`;
}

/** Page text JSON-quoted on one line, capped: an id or caption at 80, a header at 60. */
export function quoted(text: string, max: number): string {
  return JSON.stringify(capped(displayText(text), max));
}

/** A column's name as the output shows it, unquoted: on one line, at most 60 characters. */
export function shownColumnName(name: string): string {
  return capped(displayText(name), HEADER_CHARS);
}

const ID_CHARS = 80;
const CAP_NOTE = `cut at a cap: at most ${TABLE_LIMITS.rowsPerTable} rows and ${TABLE_LIMITS.cellsPerTable} cells per table, ${TABLE_LIMITS.cellsPerCall} per call`;
const HEADER_CHARS = 60;
const CELL_CHARS = 200;
/** Cells shown of a listed or footer row: its first 200 columns. */
const ROW_CELLS_SHOWN = 200;
const LABEL_CHARS = 60;

function describeTable(table: ParsedTable): string {
  const parts = [`table ${table.number}`];
  if (table.id) parts.push(`id ${quoted(table.id, ID_CHARS)}`);
  if (table.caption) parts.push(`caption ${quoted(table.caption, ID_CHARS)}`);
  return parts.join(" ");
}

function columnName(columns: readonly string[], index: number): string {
  return `column ${index + 1} ${quoted(columns[index] ?? "", HEADER_CHARS)}`;
}

function listTables(tables: readonly ParsedTable[], tablesNotRead: number): string {
  const lines = tables.map((table) => {
    const head = table.columns.slice(0, 12).map((name) => quoted(name, HEADER_CHARS)).join(" | ");
    return `  ${describeTable(table)}: ${table.rows.length} rows × ${table.columns.length} columns — ${head}${table.columns.length > 12 ? " | …" : ""}`;
  });
  if (tablesNotRead > 0) lines.push(`  ${tablesNotRead} more tables not read (at most ${TABLE_LIMITS.tablesPerPage} per page)`);
  return lines.join("\n");
}

/** Columns as "1 "Name" | 2 …", the first 40 of a wider table. */
function listColumns(columns: readonly string[]): string {
  const shown = columns.slice(0, 40).map((name, index) => `${index + 1} ${quoted(name, HEADER_CHARS)}`).join(" | ");
  return columns.length > 40 ? `${shown} | … ${columns.length - 40} more` : shown;
}

function isDataTable(table: ParsedTable): boolean {
  return table.columns.length >= 2 && table.rows.length >= 1;
}

// ─── Query ────────────────────────────────────────────────────────────────────

export const AGGREGATES = ["sum", "count", "min", "max", "avg"] as const;
export type AggregateName = typeof AGGREGATES[number];
export const CONDITION_OPS = ["<", "<=", ">", ">=", "=", "!=", "contains"] as const;
export type ConditionOp = typeof CONDITION_OPS[number];

export interface Condition {
  column: string;
  op: ConditionOp;
  /** A JSON number or a string; kept as given, the comparison rules depend on it. */
  value: number | string;
}

export interface TableQuery {
  table?: string;
  column?: string;
  aggregates?: AggregateName[];
  where?: Condition[];
  groupBy?: string;
}

/** One page of a call, as the fetch or tab layer read it. */
export interface PageInput {
  /** The page's position among the call's URLs, 1-based: rows are labelled page·row with it. */
  page: number;
  url: string;
  doc: ParsedDocument;
}

export interface ComputeOptions {
  /** How the pages were read, for the "read:" line ("fetched directly (…)", "read from the browser tab …"). */
  sourceNote: string;
  /** Lines the fetch layer adds after the computed lines (skipped pages, a cut page, the pager hint). */
  notes?: string[];
  rowsChars?: number;
}

export interface ComputeSuccess {
  ok: true;
  output: string;
  table: string;
  rows: number;
  columns: string[];
  /** Each computed value by a short key ("sum(4 Südtal)"), as written in the output. */
  aggregates: Record<string, string>;
  /**
   * The values no single cell states: every count, and each sum or average over two numbers or
   * more. A min or a max is a cell's value, which any listing of the rows states as well; a reply
   * relaying one of these is relaying the computation (the orchestrator's coverage check).
   */
  computed: string[];
  pagesSkipped: Array<{ page: number; reason: string }>;
}

export interface ComputeFailure {
  ok: false;
  error: string;
  /** The source held no <table> at all. */
  noTable?: boolean;
}

export type ComputeResult = ComputeSuccess | ComputeFailure;

interface UnionRow {
  page: number;
  r: number;
  cells: TableCell[];
}

function rowRef(row: UnionRow): string {
  return `${row.page}·${row.r}`;
}

type ColumnResolution = { ok: true; index: number } | { ok: false; error: string; ambiguous?: boolean };

/**
 * A header's names as columns compare them, normalized once per header: a table may have up to
 * 100,000 columns, and each named column, condition and candidate table resolves against them.
 */
const NORMALIZED_NAMES = new WeakMap<readonly string[], string[]>();

function normalizedNames(columns: readonly string[]): string[] {
  let names = NORMALIZED_NAMES.get(columns);
  if (!names) {
    work.namesNormalized += columns.length;
    names = columns.map(normalizeText);
    NORMALIZED_NAMES.set(columns, names);
  }
  return names;
}

/**
 * A column argument against a header: its exact name (NFKC, case folded, whitespace evened out),
 * else its 1-based number, else the one header containing it ("Preis" for "Preis (€)").
 */
export function resolveColumn(columns: readonly string[], argument: string): ColumnResolution {
  const wanted = normalizeText(argument);
  const names = normalizedNames(columns);
  const exact = names.indexOf(wanted);
  if (exact >= 0) return { ok: true, index: exact };
  if (/^\d+$/.test(wanted)) {
    const number = Number(wanted);
    if (number >= 1 && number <= columns.length) return { ok: true, index: number - 1 };
  }
  if (wanted) {
    const containing = columns.map((name, index) => ({ name, index })).filter(({ index }) => names[index]!.includes(wanted));
    if (containing.length === 1) return { ok: true, index: containing[0]!.index };
    if (containing.length > 1) {
      const listed = containing.slice(0, 12).map(({ name, index }) => `${index + 1} ${quoted(name, HEADER_CHARS)}`).join(" | ");
      return {
        ok: false,
        ambiguous: true,
        error: `column ${quoted(argument, HEADER_CHARS)} matches several columns: ${listed}${containing.length > 12 ? ` | … ${containing.length - 12} more` : ""}; name it exactly or by number`,
      };
    }
  }
  return { ok: false, error: `there is no column ${quoted(argument, HEADER_CHARS)}; the columns are: ${listColumns(columns)}` };
}

/** The table a `table` argument names: its number, else an exact id, else an exact caption. */
function tableByArgument(tables: readonly ParsedTable[], argument: string): ParsedTable | undefined {
  const wanted = argument.trim();
  if (/^\d+$/.test(wanted)) return tables.find((table) => table.number === Number(wanted));
  const normalized = normalizeText(wanted);
  return tables.find((table) => table.id && normalizeText(table.id) === normalized)
    ?? tables.find((table) => table.caption && normalizeText(table.caption) === normalized);
}

function chooseTable(page: PageInput, query: TableQuery, namedColumns: readonly string[], pageCount: number): { table: ParsedTable } | { error: string } {
  const where = pageCount > 1 ? ` on page ${page.page} (${capped(displayText(page.url), 120)})` : "";
  const tables = page.doc.tables;
  if (query.table !== undefined) {
    const table = tableByArgument(tables, query.table);
    if (table) return { table };
    return { error: `no table ${quoted(query.table, ID_CHARS)}${where}; its tables:\n${listTables(tables, page.doc.tablesNotRead)}` };
  }
  const candidates = tables.filter(isDataTable);
  if (namedColumns.length === 0) {
    if (candidates.length === 1) return { table: candidates[0]! };
    return { error: `${candidates.length === 0 ? "no data table" : `${candidates.length} tables`}${where}; name one with table (its number or id):\n${listTables(tables, page.doc.tablesNotRead)}` };
  }
  const fitting = candidates.filter((table) => namedColumns.every((name) => resolveColumn(table.columns, name).ok));
  if (fitting.length === 1) return { table: fitting[0]! };
  const named = namedColumns.map((name) => quoted(name, HEADER_CHARS)).join(", ");
  if (fitting.length === 0) {
    return { error: `no table${where} has the column(s) ${named}; its tables:\n${listTables(tables, page.doc.tablesNotRead)}` };
  }
  return { error: `${fitting.length} tables${where} have the column(s) ${named}; name one with table (its number or id):\n${listTables(fitting, 0)}` };
}

/** Ids of normalized cell texts, shared by the pages of one call; the empty text is 0. */
interface CellIds {
  byText: Map<string, number>;
  byCell: Map<TableCell, number>;
}

function newCellIds(): CellIds {
  return { byText: new Map([["", 0]]), byCell: new Map() };
}

/**
 * A table's rows as pages compare them: the width, then each row's cells as ids of their
 * normalized text, trailing empty cells left out. Equal exactly when the rows padded to the width
 * are, without building rows × width; a cell spanning rows and columns is one object at every
 * position it covers and is normalized once.
 */
function rowSignature(rows: readonly TableCell[][], width: number, ids: CellIds): string {
  const idOf = (cell: TableCell): number => {
    let id = ids.byCell.get(cell);
    if (id === undefined) {
      work.cellTextChars += cell.text.length + cell.struck.length;
      const text = normalizeText(`${cell.text} ${cell.struck}`);
      id = ids.byText.get(text);
      if (id === undefined) {
        id = ids.byText.size;
        ids.byText.set(text, id);
      }
      ids.byCell.set(cell, id);
    }
    return id;
  };
  const shown = rows.map((cells) => {
    const row = cells.map(idOf);
    let end = row.length;
    while (end > 0 && row[end - 1] === 0) end--;
    return row.slice(0, end).join(",");
  });
  return `${width}:${shown.join(";")}`;
}

function headerSignature(columns: readonly string[]): string {
  return normalizedNames(columns).join("\u0001");
}

/** A cell as it is listed: its value, its struck part as ~~…~~, capped and on one line. */
function showCell(cell: TableCell): string {
  const text = displayText(cell.text);
  const struck = displayText(cell.struck);
  return capped(struck ? `${text}${text ? " " : ""}~~${struck}~~` : text, CELL_CHARS);
}

/** A row's first `count` cells, a missing one as empty. */
function cellsUpTo(cells: readonly TableCell[], count: number): TableCell[] {
  return Array.from({ length: count }, (_, index) => cells[index] ?? EMPTY_CELL);
}

/** What names a row in a computed line: its first column, or its second when the first is the one computed. */
function rowLabel(row: UnionRow, computedColumn: number, width: number): string {
  const index = computedColumn === 0 && width > 1 ? 1 : 0;
  return `${rowRef(row)} ${quoted(row.cells[index]?.text ?? "", LABEL_CHARS)}`;
}

interface ColumnFacts {
  values: Array<CellValue>;
  reading: ColumnReadingResult;
}

/**
 * Text work on a cell, done once per cell object for one call. A cell spanning rows is the same
 * object in each of the up to 50 rows it covers; read, compared and grouped once per row, 100
 * cells of 10,000 characters spanning 50 rows each put 50 MB of text work on a 1.1 MB page and
 * held the event loop for seconds a page.
 */
interface CellTexts {
  value(cell: TableCell | undefined): CellValue;
  normalized(cell: TableCell | undefined): string;
  /** The cell's text quoted for a figure's label, at most 40 characters. */
  label(cell: TableCell | undefined): string;
}

function newCellTexts(): CellTexts {
  const memo = <T>(compute: (text: string) => T): ((cell: TableCell | undefined) => T) => {
    const cache = new Map<TableCell, T>();
    return (cell) => {
      const key = cell ?? EMPTY_CELL;
      let result = cache.get(key);
      if (result === undefined) {
        work.cellTextChars += key.text.length;
        result = compute(key.text);
        cache.set(key, result);
      }
      return result;
    };
  };
  return { value: memo(readCellValue), normalized: memo(normalizeText), label: memo((text) => quoted(text, 40)) };
}

/** Every row's value in one column, and the column's reading, taken over all rows of the union. */
function columnFacts(rows: readonly UnionRow[], index: number, lang: string | null, texts: CellTexts): ColumnFacts {
  const values = rows.map((row) => texts.value(row.cells[index]));
  const figures: Array<{ raw: string; label: string }> = [];
  values.forEach((value, i) => {
    if (value.kind === "number") figures.push({ raw: value.raw, label: `${rowRef(rows[i]!)} ${texts.label(rows[i]!.cells[index])}` });
  });
  return { values, reading: inferColumnReading(figures, lang) };
}

type Refusal = { refused: string } | null;

/** Why figures of a column cannot be compared or added: conflicting decimal conventions, or more than one unit. */
function computeRefusal(columns: readonly string[], index: number, facts: ColumnFacts, rows: readonly UnionRow[], positions: readonly number[], what: string): Refusal {
  const name = columnName(columns, index);
  if (facts.reading.conflict) {
    return { refused: `${what} refused: ${name} has conflicting decimal conventions (${facts.reading.conflict.comma} has a decimal comma, ${facts.reading.conflict.point} a decimal point)` };
  }
  const report = residueCheck(positions.flatMap((position) => {
    const value = facts.values[position]!;
    return value.kind === "number" ? [{ residue: value.residue, label: rowRef(rows[position]!) }] : [];
  }));
  if (!report.uniform) {
    const forms = report.forms.map((form) => `${JSON.stringify(capped(form.residue, 40))} ×${form.count} (${form.examples.join(", ")})`).join("; ");
    return { refused: `${what} refused: the numbers in ${name} are written in more than one form, which may be different units: ${forms}. Compute one form at a time with a where condition (op "contains") on that column.` };
  }
  return null;
}

/** "cells differ only in marks" note for a column whose residues differ in nothing that names a unit. */
function marksNote(facts: ColumnFacts, positions: readonly number[], rows: readonly UnionRow[]): string {
  const report = residueCheck(positions.flatMap((position) => {
    const value = facts.values[position]!;
    return value.kind === "number" ? [{ residue: value.residue, label: rowRef(rows[position]!) }] : [];
  }));
  if (report.forms.length <= 1) return "";
  return `; the numbers carry different marks: ${report.forms.slice(0, 4).map((form) => `${JSON.stringify(capped(form.residue, 30))} ×${form.count}`).join(", ")}`;
}

function conditionText(condition: Condition, columns: readonly string[], index: number): string {
  const value = typeof condition.value === "number" ? String(condition.value) : quoted(condition.value, HEADER_CHARS);
  return `${columnName(columns, index)} ${condition.op} ${value}`;
}

const ORDERING_OPS = new Set<ConditionOp>(["<", "<=", ">", ">="]);

function compares(op: ConditionOp, order: number): boolean {
  switch (op) {
    case "<": return order < 0;
    case "<=": return order <= 0;
    case ">": return order > 0;
    case ">=": return order >= 0;
    case "=": return order === 0;
    case "!=": return order !== 0;
    default: return false;
  }
}

/**
 * Compute the query over the pages of one call. Pages whose chosen table repeats an earlier page's
 * rows are skipped; every page's table must carry the same header. Fails, never guesses, when the
 * table, a column, a condition value or a column's numbers are ambiguous.
 */
export function computeTables(pages: readonly PageInput[], query: TableQuery, options: ComputeOptions): ComputeResult {
  work.cellTextChars = 0;
  work.namesNormalized = 0;
  if (pages.length === 0) return { ok: false, error: "no page was read" };
  if (pages.every((page) => page.doc.tables.length === 0)) return { ok: false, error: "no <table>", noTable: true };
  const extraction = query.column === undefined && (query.aggregates?.length ?? 0) === 0 && (query.where?.length ?? 0) === 0 && query.groupBy === undefined;
  if (extraction && pages.length === 1 && query.table === undefined) return extractAll(pages[0]!, options);

  const namedColumns = [query.column, ...(query.where ?? []).map((condition) => condition.column), query.groupBy]
    .filter((name): name is string => typeof name === "string");
  const chosen: Array<{ page: PageInput; table: ParsedTable }> = [];
  const pagesSkipped: Array<{ page: number; reason: string }> = [];
  const signatures = new Map<string, number>();
  const cellIds = newCellIds();
  for (const page of pages) {
    const choice = chooseTable(page, query, namedColumns, pages.length);
    if ("error" in choice) return { ok: false, error: choice.error, ...(page.doc.tables.length === 0 ? { noTable: true } : {}) };
    const signature = rowSignature(choice.table.rows, choice.table.columns.length, cellIds);
    const earlier = signatures.get(signature);
    if (earlier !== undefined && choice.table.rows.length > 0) {
      pagesSkipped.push({ page: page.page, reason: `its table has the same rows as page ${earlier}` });
      continue;
    }
    signatures.set(signature, page.page);
    if (chosen.length > 0 && headerSignature(choice.table.columns) !== headerSignature(chosen[0]!.table.columns)) {
      return {
        ok: false,
        error: `the table on page ${page.page} (${capped(displayText(page.url), 120)}) has other columns than page ${chosen[0]!.page.page}'s: ${listColumns(choice.table.columns)} instead of ${listColumns(chosen[0]!.table.columns)}`,
      };
    }
    chosen.push({ page, table: choice.table });
  }
  const columns = chosen[0]!.table.columns;
  const lang = chosen[0]!.page.doc.lang;
  const rows: UnionRow[] = chosen.flatMap(({ page, table }) => table.rows.map((cells, index) => ({ page: page.page, r: index + 1, cells })));
  const truncated = chosen.some(({ table }) => table.truncated);
  const tableDescription = chosen.length === 1 ? describeTable(chosen[0]!.table) : `${describeTable(chosen[0]!.table)} on each`;

  const resolve = (argument: string): ColumnResolution => resolveColumn(columns, argument);
  const texts = newCellTexts();
  const factsCache = new Map<number, ColumnFacts>();
  const factsOf = (index: number): ColumnFacts => {
    let facts = factsCache.get(index);
    if (!facts) {
      facts = columnFacts(rows, index, lang, texts);
      factsCache.set(index, facts);
    }
    return facts;
  };

  const head: string[] = [];
  const aggregates: Record<string, string> = {};
  const computed: string[] = [];
  const record = (key: string, value: string, name: AggregateName, numeric?: number): void => {
    if (Object.keys(aggregates).length < 64) aggregates[key] = value;
    // A min or a max is a cell's value, and so is a sum or an average over one number.
    if (computed.length < 64 && (name === "count" || ((name === "sum" || name === "avg") && (numeric ?? 0) >= 2))) computed.push(value);
  };

  // where: each condition narrows the rows the previous one kept.
  let kept = rows.map((_, index) => index);
  const conditionTexts: string[] = [];
  let notComparable = 0;
  for (const condition of query.where ?? []) {
    const resolved = resolve(condition.column);
    if (!resolved.ok) return { ok: false, error: `where: ${resolved.error}` };
    const index = resolved.index;
    const facts = factsOf(index);
    conditionTexts.push(conditionText(condition, columns, index));
    const nonEmpty = kept.filter((position) => facts.values[position]!.kind !== "empty");
    const numericCount = nonEmpty.filter((position) => facts.values[position]!.kind === "number").length;
    const numericColumn = nonEmpty.length > 0 && numericCount * 2 >= nonEmpty.length;
    const figure = numericColumn ? conditionFigure(condition.value, facts.reading) : null;
    if (ORDERING_OPS.has(condition.op)) {
      if (!numericColumn) return { ok: false, error: `where: ${columnName(columns, index)} holds text; ${condition.op} needs a numeric column` };
      const refusal = computeRefusal(columns, index, facts, rows, nonEmpty, `where ${condition.op}`);
      if (refusal) return { ok: false, error: refusal.refused };
      if (!figure) {
        return { ok: false, error: `where: ${JSON.stringify(condition.value)} is not a number as ${columnName(columns, index)} writes them (${describeReading(facts.reading)}); give one figure, such as 50 or ${JSON.stringify(facts.reading.reading === "comma" ? "49,90" : "49.90")}` };
      }
    }
    const numericCompare = condition.op !== "contains" && figure !== null && (ORDERING_OPS.has(condition.op) || numericColumn);
    if (numericCompare && !ORDERING_OPS.has(condition.op) && facts.reading.conflict) {
      return { ok: false, error: computeRefusal(columns, index, facts, rows, nonEmpty, `where ${condition.op}`)!.refused };
    }
    const wantedText = normalizeText(String(condition.value));
    kept = kept.filter((position) => {
      const value = facts.values[position]!;
      if (numericCompare) {
        if (value.kind !== "number") {
          notComparable++;
          return false;
        }
        const cellFigure = figureValue(value.raw, value.sign, facts.reading.reading);
        if (!cellFigure) {
          notComparable++;
          return false;
        }
        return compares(condition.op, compareScaled(cellFigure, figure!));
      }
      const text = texts.normalized(rows[position]!.cells[index]);
      if (condition.op === "contains") return text.includes(wantedText);
      if (condition.op === "=") return text === wantedText;
      if (condition.op === "!=") return text !== wantedText;
      return false;
    });
  }
  const scope = conditionTexts.length > 0 ? `${kept.length} rows kept` : `all ${rows.length} rows`;
  if (conditionTexts.length > 0) {
    head.push(`where ${conditionTexts.join(" and ")} → ${kept.length} of ${rows.length} rows kept${notComparable > 0 ? `; not comparable (not a number): ${notComparable}` : ""}`);
  }
  const capNote = truncated ? `; over the first ${rows.length} rows only; the table has more` : "";

  // The aggregates to compute; a column without any defaults to everything that applies.
  let wanted: AggregateName[] = [...new Set(query.aggregates ?? [])];
  let columnIndex: number | null = null;
  if (query.column !== undefined) {
    const resolved = resolve(query.column);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    columnIndex = resolved.index;
  }
  if (wanted.length === 0) {
    if (columnIndex !== null && !extraction) {
      // A column named without aggregates gets every one that applies: all five on a numeric
      // column (half of its non-empty cells numbers, the rule ordering conditions use), else count.
      const facts = factsOf(columnIndex);
      const nonEmpty = kept.filter((position) => facts.values[position]!.kind !== "empty").length;
      const numeric = kept.filter((position) => facts.values[position]!.kind === "number").length;
      wanted = numeric > 0 && numeric * 2 >= nonEmpty ? ["count", "sum", "min", "max", "avg"] : ["count"];
    } else if (!extraction) {
      wanted = ["count"];
    }
  }
  const needsColumn = wanted.filter((name) => name !== "count");
  if (needsColumn.length > 0 && columnIndex === null) {
    return { ok: false, error: `${needsColumn.join(", ")} need a column: name it with column (its header or number); the columns are: ${listColumns(columns)}` };
  }

  let groupIndex: number | null = null;
  if (query.groupBy !== undefined) {
    const resolved = resolve(query.groupBy);
    if (!resolved.ok) return { ok: false, error: `group_by: ${resolved.error}` };
    groupIndex = resolved.index;
  }

  if (columnIndex !== null && needsColumn.length > 0) {
    const facts = factsOf(columnIndex);
    const refusal = computeRefusal(columns, columnIndex, facts, rows, kept, needsColumn.join(", "));
    if (refusal) return { ok: false, error: refusal.refused };
    if (!kept.some((position) => facts.values[position]!.kind === "number") && kept.length > 0) {
      return { ok: false, error: `${needsColumn.join(", ")} refused: ${columnName(columns, columnIndex)} has no number in the ${scope}` };
    }
  }

  const groups: Array<{ key: string; label: string; positions: number[] }> = [];
  if (groupIndex !== null) {
    const byKey = new Map<string, { key: string; label: string; positions: number[] }>();
    for (const position of kept) {
      const cell = rows[position]!.cells[groupIndex];
      const key = texts.normalized(cell);
      let group = byKey.get(key);
      if (!group) {
        group = { key, label: displayText(cell?.text ?? ""), positions: [] };
        byKey.set(key, group);
        groups.push(group);
      }
      group.positions.push(position);
    }
  }

  const footerValue = (index: number): string => {
    for (const { table } of chosen) {
      for (const footerRow of table.footer) {
        const cell = footerRow[index];
        if (cell && texts.value(cell).kind === "number") return displayText(cell.text);
      }
    }
    return "";
  };

  /** One aggregate over a set of rows, as its value text and the rows it names (min/max). */
  const aggregateOver = (name: AggregateName, positions: readonly number[]): { value: string; at?: string; numeric?: number } | null => {
    if (name === "count") return { value: String(positions.length) };
    const index = columnIndex!;
    const facts = factsOf(index);
    const reading = facts.reading.reading;
    const numericPositions = positions.filter((position) => facts.values[position]!.kind === "number");
    const values: Array<{ position: number; value: Scaled }> = [];
    for (const position of numericPositions) {
      const cell = facts.values[position] as Extract<CellValue, { kind: "number" }>;
      const value = figureValue(cell.raw, cell.sign, reading);
      if (value) values.push({ position, value });
    }
    if (values.length === 0) return null;
    if (name === "sum") return { value: formatScaled(sumScaled(values.map((entry) => entry.value)), reading), numeric: values.length };
    if (name === "avg") return { value: formatScaled(averageScaled(values.map((entry) => entry.value))!, reading), numeric: values.length };
    let best = values[0]!;
    for (const entry of values) {
      const order = compareScaled(entry.value, best.value);
      if (name === "min" ? order < 0 : order > 0) best = entry;
    }
    const ties = values.filter((entry) => compareScaled(entry.value, best.value) === 0);
    const at = ties.slice(0, 5).map((entry) => rowLabel(rows[entry.position]!, index, columns.length)).join(", ") + (ties.length > 5 ? `, and ${ties.length - 5} more` : "");
    return { value: formatScaled(best.value, reading), at, numeric: values.length };
  };

  const nonNumericNote = (positions: readonly number[]): string => {
    if (columnIndex === null) return "";
    const facts = factsOf(columnIndex);
    const others = positions.filter((position) => facts.values[position]!.kind !== "number");
    if (others.length === 0) return "";
    const listed = others.slice(0, 5).map((position) => `${rowRef(rows[position]!)} ${quoted(rows[position]!.cells[columnIndex!]?.text ?? "", 40)}`).join(", ");
    return `  not numeric in ${columnName(columns, columnIndex)}: ${listed}${others.length > 5 ? `, and ${others.length - 5} more` : ""}`;
  };

  if (groupIndex === null) {
    for (const name of wanted) {
      if (name === "count") {
        head.push(`count = ${kept.length}${capNote}`);
        record("count", String(kept.length), "count");
        continue;
      }
      const result = aggregateOver(name, kept);
      const index = columnIndex!;
      const facts = factsOf(index);
      const label = `${name}(${columnName(columns, index)})`;
      if (!result) {
        head.push(`${label}: no number among the ${scope}`);
        continue;
      }
      let line = `${label} = ${result.value}${result.at ? ` at ${result.at}` : ""} — ${scope}, ${result.numeric} numeric of ${kept.length} (${describeReading(facts.reading)})${marksNote(facts, kept, rows)}${capNote}`;
      if (name === "sum") {
        const stated = footerValue(index);
        if (stated) line += `; the table's footer states ${JSON.stringify(capped(stated, 40))}`;
      }
      head.push(line);
      record(`${name}(${index + 1} ${capped(displayText(columns[index]!), 40)})`, result.value, name, result.numeric);
    }
    const note = nonNumericNote(kept);
    if (note && needsColumn.length > 0) head.push(note);
  } else {
    const groupName = columnName(columns, groupIndex);
    const shownGroups = groups.slice(0, 50);
    for (const name of wanted) {
      const facts = columnIndex !== null && name !== "count" ? factsOf(columnIndex) : null;
      const label = name === "count" ? "count" : `${name}(${columnName(columns, columnIndex!)})`;
      head.push(`${label} per ${groupName} — ${groups.length} groups over ${scope}${facts ? ` (${describeReading(facts.reading)})` : ""}${capNote}:`);
      for (const group of shownGroups) {
        const result = aggregateOver(name, group.positions);
        const groupLabel = JSON.stringify(capped(group.label, LABEL_CHARS));
        if (!result) {
          head.push(`  ${groupLabel}: no number (${group.positions.length} rows)`);
          continue;
        }
        const detail = name === "count" ? "" : ` (${result.numeric} numeric of ${group.positions.length})`;
        head.push(`  ${groupLabel}: ${result.value}${result.at ? ` at ${result.at}` : ""}${detail}`);
        record(`${name === "count" ? "count" : `${name}(${columnIndex! + 1} ${capped(displayText(columns[columnIndex!]!), 40)})`} [${capped(group.label, 40)}]`, result.value, name, result.numeric);
      }
      if (groups.length > shownGroups.length) head.push(`  … ${groups.length - shownGroups.length} more groups not shown`);
    }
  }

  // After the computed lines: what was read, then notes, then the rows themselves.
  const lines = [...head];
  const firstUrl = displayText(chosen[0]!.page.url);
  const readWhat = pages.length === 1 ? capped(firstUrl, 200) : `${chosen.length} page${chosen.length === 1 ? "" : "s"}`;
  lines.push(`read: ${readWhat}, ${tableDescription}, ${rows.length} rows × ${columns.length} columns${truncated ? ` (${CAP_NOTE})` : ""}, ${options.sourceNote}`);
  for (const skipped of pagesSkipped) {
    const page = pages.find((entry) => entry.page === skipped.page)!;
    lines.push(`page ${skipped.page} (${capped(displayText(page.url), 120)}) skipped: ${skipped.reason}`);
  }
  for (const note of options.notes ?? []) lines.push(note);
  const struckCells = rows.reduce((count, row) => count + row.cells.filter((cell) => cell.struck).length, 0);
  if (struckCells > 0) lines.push(`${struckCells} cell${struckCells === 1 ? " has" : "s have"} struck-through text (~~…~~), not part of ${struckCells === 1 ? "its value" : "their values"}`);
  const footerRows = chosen.flatMap(({ table }) => table.footer);
  if (footerRows.length > 0) {
    lines.push(`footer (not computed): ${footerRows.slice(0, 3).map((cells) => cellsUpTo(cells, Math.min(columns.length, ROW_CELLS_SHOWN)).map(showCell).join(" | ")).join(" ‖ ")}`);
  }
  lines.push(`columns: ${listColumns(columns)}`);
  const listed = conditionTexts.length > 0 ? kept : rows.map((_, index) => index);
  lines.push(renderRows(listed.map((position) => rows[position]!), conditionTexts.length > 0 ? "rows kept" : "rows", options.rowsChars ?? TABLE_LIMITS.rowsChars, !extraction, columns.length));

  return {
    ok: true,
    output: lines.join("\n"),
    table: tableDescription,
    rows: rows.length,
    columns,
    aggregates,
    computed,
    pagesSkipped,
  };
}

/** The rows section, within its character budget, saying what a cut left out. */
function renderRows(rows: readonly UnionRow[], title: string, budget: number, computed: boolean, width: number): string {
  const lines: string[] = [];
  let used = 0;
  for (const row of rows) {
    const line = capped(`${rowRef(row)} | ${cellsUpTo(row.cells, Math.min(width, ROW_CELLS_SHOWN)).map(showCell).join(" | ")}`, budget);
    if (used + line.length + 1 > budget && lines.length > 0) break;
    lines.push(line);
    used += line.length + 1;
  }
  const header = lines.length < rows.length
    ? `${title} (page·row), ${title === "rows" ? "rows" : "kept rows"} 1-${lines.length} of ${rows.length} shown${computed ? `; the computed lines above cover all ${rows.length}` : ""}:`
    : `${title} (page·row):`;
  return [header, ...lines].join("\n");
}

/** Extraction from one page without a table argument: every data table, each with its rows. */
function extractAll(page: PageInput, options: ComputeOptions): ComputeResult {
  const tables = page.doc.tables.filter(isDataTable);
  if (tables.length === 0) {
    return { ok: false, error: `no data table (2 columns and a row at least) on the page; its tables:\n${listTables(page.doc.tables, page.doc.tablesNotRead)}` };
  }
  const lines = [`read: ${capped(displayText(page.url), 200)}, ${tables.length} data table${tables.length === 1 ? "" : "s"}, ${options.sourceNote}`];
  for (const note of options.notes ?? []) lines.push(note);
  if (page.doc.tablesNotRead > 0) lines.push(`${page.doc.tablesNotRead} more tables not read (at most ${TABLE_LIMITS.tablesPerPage} per page)`);
  let budget = options.rowsChars ?? TABLE_LIMITS.rowsChars;
  for (const table of tables) {
    lines.push(`${describeTable(table)}: ${table.rows.length} rows × ${table.columns.length} columns${table.truncated ? ` (${CAP_NOTE})` : ""}`);
    lines.push(`columns: ${listColumns(table.columns)}`);
    const rows = table.rows.map((cells, index) => ({ page: page.page, r: index + 1, cells }));
    const section = renderRows(rows, "rows", Math.max(200, budget), false, table.columns.length);
    lines.push(section);
    budget -= section.length;
  }
  return {
    ok: true,
    output: lines.join("\n"),
    table: tables.map(describeTable).join(", "),
    rows: tables.reduce((count, table) => count + table.rows.length, 0),
    columns: tables[0]!.columns,
    aggregates: {},
    computed: [],
    pagesSkipped: [],
  };
}
