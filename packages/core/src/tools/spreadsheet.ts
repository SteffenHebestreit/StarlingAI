/**
 * Tier 1 (read) / Tier 2 (write) — Read and write spreadsheet files (XLSX, XLS, ODS, CSV).
 *
 * spreadsheet_read  — Reads a workspace spreadsheet and returns sheets as JSON row arrays.
 * spreadsheet_write — Writes JSON row data to an XLSX file in the workspace.
 *
 * Powered by SheetJS (xlsx package).
 */
import { existsSync, statSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, extname } from "node:path";
import * as XLSX from "xlsx";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { childLogger } from "../logger.js";
import { resolvePathWithinWorkspace } from "./workspace-path.js";
import { guardPath } from "./filesystem.js";
import { MAX_TOOL_RESULT_CHARS } from "./result-shaping.js";

const log = childLogger("tool:spreadsheet");

/** Maximum file size we're willing to load into memory. */
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB
/** Per-sheet row cap to prevent overwhelming the model context. */
const MAX_ROWS_PER_SHEET = 2_000;
/**
 * Characters of row JSON one answer carries. A sub-agent cuts every tool result above
 * MAX_TOOL_RESULT_CHARS (32,768) to head 70 % + tail 20 %; at the old 64,000 a 2,000-row CSV came
 * back as "rows 1-730 … start_row=731" while the agent saw rows 1-263 and 657-730 — 393 rows lost,
 * and the hint skipped them for good. The JSON gets the cap minus headroom for the summary lines.
 */
const MAX_JSON_CHARS = MAX_TOOL_RESULT_CHARS - 2_768;

const SUPPORTED_READ_EXTENSIONS = new Set([".xlsx", ".xls", ".xlsm", ".xlsb", ".ods", ".csv"]);
const SUPPORTED_WRITE_EXTENSIONS = new Set([".xlsx", ".csv"]);

// ─── Helpers ────────────────────────────────────────────────────────────────

function fail(error: string): ToolResult {
  return { success: false, output: "", error };
}

function normaliseRows(raw: unknown[]): Record<string, unknown>[] {
  return raw.map((row) => {
    if (row && typeof row === "object" && !Array.isArray(row)) {
      return row as Record<string, unknown>;
    }
    return {};
  });
}

/** One sheet as returned: a window of its data rows, numbered from 1 below the header row. */
interface SheetView {
  columns: string[];
  totalRows: number;
  /** 1-based data-row numbers of the first and last row shown; 0/0 when none are. */
  firstRow: number;
  lastRow: number;
  rows: Record<string, unknown>[];
  /** Why rows after lastRow are missing, when they are. */
  cutBy?: "max_rows" | "output budget";
}

/**
 * The sheets as JSON, one row per line. Laid out by hand so every row's cost is known before it
 * is added: the output used to be pretty-printed whole and then sliced at a character cap, which
 * cut through the middle of a row and dropped the `totalRows`/`capped` fields that followed it
 * together with every later sheet — the caller saw a partial table with nothing saying so.
 */
function renderSheetsJson(sheets: Array<[string, SheetView]>): string {
  const parts = sheets.map(([name, s]) => {
    const rows = s.rows.map((row) => `      ${JSON.stringify(row)}`).join(",\n");
    return `  ${JSON.stringify(name)}: {\n`
      + `    "columns": ${JSON.stringify(s.columns)},\n`
      + `    "totalRows": ${s.totalRows},\n`
      + `    "firstRow": ${s.firstRow},\n`
      + `    "lastRow": ${s.lastRow},\n`
      + `    "rows": [${rows ? `\n${rows}\n    ` : ""}]\n  }`;
  });
  return `{\n${parts.join(",\n")}\n}`;
}

/** One line per sheet saying which rows are shown and how to get the rest. */
function describeSheetWindow(name: string, s: SheetView): string {
  const label = `Sheet ${JSON.stringify(name)}`;
  if (s.totalRows === 0) return `${label}: no data rows.`;
  if (s.rows.length === 0) {
    return s.cutBy === "output budget"
      ? `${label}: ${s.totalRows} data rows, none fit in this answer's output budget — pass sheet=${JSON.stringify(name)} to read it on its own.`
      : `${label}: ${s.totalRows} data rows; start_row is past the last one.`;
  }
  if (s.firstRow === 1 && s.lastRow === s.totalRows) return `${label}: all ${s.totalRows} data rows.`;
  const more = s.lastRow < s.totalRows
    ? ` — rows ${s.lastRow + 1}-${s.totalRows} not shown (${s.cutBy ?? "max_rows"}); pass sheet=${JSON.stringify(name)}, start_row=${s.lastRow + 1} for the next ones.`
    : ".";
  return `${label}: data rows ${s.firstRow}-${s.lastRow} of ${s.totalRows}${more}`;
}

// ─── spreadsheet_read ───────────────────────────────────────────────────────

registerTool({
  name: "spreadsheet_read",
  description:
    "Read a spreadsheet file from the workspace (.xlsx, .xls, .xlsm, .ods, .csv) and return " +
    "its contents as structured JSON. Each sheet is returned as an array of row objects. " +
    "Use this to inspect data before analysis, transformation, or reporting. " +
    "Results are capped at 2,000 rows per sheet and ~30,000 characters in total; the first lines say " +
    "which rows of which sheets are shown — page through the rest with start_row, or read one sheet with sheet.",
  embeddingDescription: "Read, parse, load a spreadsheet, Excel file, CSV, XLSX, ODS. Tabelle lesen, Excel-Datei öffnen, CSV parsen, Tabellenkalkulation auswerten. Import tabular data.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Workspace-relative path to the spreadsheet file.",
      },
      sheet: {
        type: "string",
        description:
          "Name of a specific sheet to read. When omitted, all sheets are returned.",
      },
      max_rows: {
        type: "number",
        description: `Maximum rows to return per sheet (1–${MAX_ROWS_PER_SHEET}, default ${MAX_ROWS_PER_SHEET}).`,
        default: MAX_ROWS_PER_SHEET,
      },
      header_row: {
        type: "number",
        description:
          "1-based row index to treat as the header. Rows before this index are skipped. Default 1.",
        default: 1,
      },
      start_row: {
        type: "number",
        description:
          "1-based data row (counted below the header row) to start from — for reading the rows after a capped window. Default 1.",
        default: 1,
      },
    },
    required: ["path"],
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const inputPath = String(args["path"] ?? "").trim();
    const sheetFilter = args["sheet"] != null ? String(args["sheet"]) : null;
    const positiveInt = (value: unknown, fallback: number): number => {
      const n = Math.floor(Number(value ?? fallback));
      return Number.isFinite(n) && n >= 1 ? n : fallback;
    };
    const maxRows = Math.min(positiveInt(args["max_rows"], MAX_ROWS_PER_SHEET), MAX_ROWS_PER_SHEET);
    // header_row was declared and documented but never read, so a sheet with a title block above
    // its header came back keyed by the title cells.
    const headerRow = positiveInt(args["header_row"], 1);
    const startRow = positiveInt(args["start_row"], 1);

    if (!inputPath) return fail("path is required");
    // read_file's guard: a spreadsheet read is a file read, and `.env`-style or `.starlingai/…`
    // paths must not come back through it (a CSV parser reads a dotenv file happily).
    if (!guardPath(inputPath, ctx.workspacePath).safe) return fail("path must be a non-protected file within the workspace");

    let resolved: string;
    let relativePath: string;
    try {
      ({ resolved, relativePath } = resolvePathWithinWorkspace(inputPath, ctx.workspacePath));
    } catch {
      return fail("path must be within the workspace");
    }

    if (!existsSync(resolved)) return fail(`File not found: ${inputPath}`);
    const stat = statSync(resolved);
    if (stat.isDirectory()) return fail("path is a directory, not a file");
    if (stat.size > MAX_FILE_BYTES) {
      return fail(`File too large (${stat.size} bytes > ${MAX_FILE_BYTES} byte limit)`);
    }

    const ext = extname(resolved).toLowerCase();
    if (!SUPPORTED_READ_EXTENSIONS.has(ext)) {
      return fail(`Unsupported file type: ${ext}. Supported: ${[...SUPPORTED_READ_EXTENSIONS].join(", ")}`);
    }

    let workbook: XLSX.WorkBook;
    try {
      const buffer = await readFile(resolved);
      workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
    } catch (err) {
      log.error({ err, relativePath }, "spreadsheet_read: failed to parse file");
      return fail(`Failed to parse spreadsheet: ${String(err)}`);
    }

    const targetSheets = sheetFilter
      ? [sheetFilter]
      : workbook.SheetNames;

    if (sheetFilter && !workbook.SheetNames.includes(sheetFilter)) {
      return fail(
        `Sheet "${sheetFilter}" not found. Available sheets: ${workbook.SheetNames.join(", ")}`,
      );
    }

    const parsed = targetSheets
      .filter((name) => workbook.Sheets[name])
      .map((name) => ({
        name,
        allRows: normaliseRows(XLSX.utils.sheet_to_json<unknown>(workbook.Sheets[name]!, { defval: null, dateNF: "YYYY-MM-DD", range: headerRow - 1 })),
      }));

    /** The sheets' rows that fit in `budget` characters of JSON. Each sheet gets an even share of
     *  what is left, so one wide sheet cannot starve every sheet after it; what a sheet leaves
     *  unused carries over to the next. */
    const selectRows = (total: number): Array<[string, SheetView]> => {
      let budget = total;
      return parsed.map(({ name, allRows }, i): [string, SheetView] => {
        const windowRows = allRows.slice(startRow - 1, startRow - 1 + maxRows);
        const share = Math.floor(budget / (parsed.length - i));
        const rows: Record<string, unknown>[] = [];
        let used = 200 + name.length;   // the sheet's own keys and brackets
        for (const row of windowRows) {
          let cost: number;
          try { cost = JSON.stringify(row).length + 8; } catch { cost = Infinity; }
          if (used + cost > share) break;
          rows.push(row);
          used += cost;
        }
        budget -= Math.min(used, share);
        const columnSet = new Set<string>();
        for (const row of rows.length > 0 ? rows : allRows.slice(0, 1)) for (const key of Object.keys(row)) columnSet.add(key);
        const cutBy = rows.length < windowRows.length ? "output budget" as const
          : startRow - 1 + windowRows.length < allRows.length ? "max_rows" as const
            : undefined;
        return [name, {
          columns: [...columnSet],
          totalRows: allRows.length,
          firstRow: rows.length > 0 ? startRow : 0,
          lastRow: rows.length > 0 ? startRow + rows.length - 1 : 0,
          rows,
          ...(cutBy ? { cutBy } : {}),
        }];
      });
    };
    const render = (sheets: Array<[string, SheetView]>): string => {
      let json: string;
      try {
        json = renderSheetsJson(sheets);
      } catch {
        json = `[sheets: ${sheets.map(([name]) => name).join(", ")} — data contains non-serialisable values]`;
      }
      // What is shown comes FIRST, so no cut can remove it.
      const summaryLines = [
        ...(headerRow > 1 ? [`Row ${headerRow} is the header; the ${headerRow - 1} row(s) above it were skipped.`] : []),
        ...(startRow > 1 ? [`Starting at data row ${startRow}.`] : []),
        ...sheets.map(([name, s]) => describeSheetWindow(name, s)),
      ];
      return `${summaryLines.join("\n")}\n\n${json}`;
    };

    // The whole answer — summary lines included — must pass the tool-result cap untouched. Above
    // it the result is cut to head + tail, and the rows in the cut-out middle vanish while the
    // summary still lists them and its start_row hint skips past them. Long sheet names or wide
    // headers can push the summary past the headroom, so measure and shrink until it fits.
    let jsonBudget = MAX_JSON_CHARS;
    let sheets = selectRows(jsonBudget);
    let output = render(sheets);
    for (let attempt = 0; attempt < 4 && output.length > MAX_TOOL_RESULT_CHARS; attempt++) {
      jsonBudget -= output.length - MAX_TOOL_RESULT_CHARS + 500;
      sheets = selectRows(Math.max(0, jsonBudget));
      output = render(sheets);
    }

    const summary = sheets
      .map(([name, s]) => `${name}: ${s.rows.length}/${s.totalRows} rows, ${s.columns.length} columns${s.rows.length < s.totalRows ? " (partial)" : ""}`)
      .join("; ");

    return {
      success: true,
      output,
      metadata: {
        path: relativePath,
        sheetNames: sheets.map(([name]) => name),
        summary,
      },
    };
  },
});

// ─── spreadsheet_write ──────────────────────────────────────────────────────

registerTool({
  name: "spreadsheet_write",
  description:
    "Write structured JSON data to a new or existing spreadsheet file (.xlsx or .csv) in the workspace. " +
    "Each entry in 'sheets' becomes a separate worksheet. For .csv output, only the first sheet is written. " +
    "Existing files are overwritten by default.",
  embeddingDescription: "Write, export, save data to Excel, XLSX, or CSV spreadsheet. Tabelle erstellen, Excel-Datei schreiben, CSV exportieren, Daten in Tabelle speichern. Export tabular results.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Workspace-relative output path. Extension determines format: .xlsx (default) or .csv.",
      },
      sheets: {
        type: "array",
        description: "One or more sheet definitions.",
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Sheet tab name (default: 'Sheet1').",
            },
            rows: {
              type: "array",
              description:
                "Array of row objects. Keys become column headers; order of keys in the first row determines column order.",
              items: { type: "object" },
            },
          },
          required: ["rows"],
        },
      },
      overwrite: {
        type: "boolean",
        description: "When false, fail instead of overwriting an existing file.",
        default: true,
      },
    },
    required: ["path", "sheets"],
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const outputPath = String(args["path"] ?? "").trim();
    const sheetsInput = Array.isArray(args["sheets"]) ? args["sheets"] : [];
    const overwrite = Boolean(args["overwrite"] ?? true);

    if (!outputPath) return fail("path is required");
    if (sheetsInput.length === 0) return fail("sheets must contain at least one entry");

    let resolved: string;
    let relativePath: string;
    try {
      ({ resolved, relativePath } = resolvePathWithinWorkspace(outputPath, ctx.workspacePath));
    } catch {
      return fail("path must be within the workspace");
    }

    const ext = extname(resolved).toLowerCase() || ".xlsx";
    if (!SUPPORTED_WRITE_EXTENSIONS.has(ext)) {
      return fail(`Unsupported output format: ${ext}. Supported: .xlsx, .csv`);
    }

    if (!overwrite && existsSync(resolved)) {
      return fail(`Refusing to overwrite existing file: ${relativePath}`);
    }

    // Build workbook
    const wb = XLSX.utils.book_new();
    let totalRows = 0;

    for (let i = 0; i < sheetsInput.length; i++) {
      const sheetDef = sheetsInput[i] as Record<string, unknown>;
      const sheetName = String(sheetDef["name"] ?? `Sheet${i + 1}`).slice(0, 31); // Excel 31-char limit
      const rows = Array.isArray(sheetDef["rows"]) ? (sheetDef["rows"] as Record<string, unknown>[]) : [];
      totalRows += rows.length;

      // For CSV, only first sheet
      if (ext === ".csv" && i > 0) break;

      const ws = XLSX.utils.json_to_sheet(rows);
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
    }

    try {
      await mkdir(dirname(resolved), { recursive: true });

      let fileData: Buffer | string;
      if (ext === ".csv") {
        fileData = XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]!]!);
        await writeFile(resolved, fileData, "utf8");
      } else {
        fileData = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
        await writeFile(resolved, fileData);
      }
    } catch (err) {
      log.error({ err, relativePath }, "spreadsheet_write failed");
      return fail(`Failed to write spreadsheet: ${String(err)}`);
    }

    return {
      success: true,
      output: `Spreadsheet written to ${relativePath} (${sheetsInput.length} sheet(s), ${totalRows} total rows).`,
      metadata: {
        // `outputPath` is the key the artifact collector reads (runtime
        // collectTurnArtifactAttachments). Emitting `path` alone made every generated
        // spreadsheet invisible: not offered as a download, and never verified.
        artifactKind: "document",
        outputPath: relativePath,
        filename: relativePath.replace(/\\/g, "/").split("/").pop() || relativePath,
        format: ext.slice(1),
        sheetCount: sheetsInput.length,
        totalRows,
        contentType: ext === ".csv"
          ? "text/csv; charset=utf-8"
          : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        previewMode: "download",
      },
    };
  },
});
