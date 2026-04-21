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

const log = childLogger("tool:spreadsheet");

/** Maximum file size we're willing to load into memory. */
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB
/** Per-sheet row cap to prevent overwhelming the model context. */
const MAX_ROWS_PER_SHEET = 2_000;
/** Output character cap. */
const MAX_OUTPUT_CHARS = 64_000;

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

// ─── spreadsheet_read ───────────────────────────────────────────────────────

registerTool({
  name: "spreadsheet_read",
  description:
    "Read a spreadsheet file from the workspace (.xlsx, .xls, .xlsm, .ods, .csv) and return " +
    "its contents as structured JSON. Each sheet is returned as an array of row objects. " +
    "Use this to inspect data before analysis, transformation, or reporting. " +
    "Results are capped at 2,000 rows per sheet.",
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
    },
    required: ["path"],
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const inputPath = String(args["path"] ?? "").trim();
    const sheetFilter = args["sheet"] != null ? String(args["sheet"]) : null;
    const maxRows = Math.min(Math.max(Number(args["max_rows"] ?? MAX_ROWS_PER_SHEET), 1), MAX_ROWS_PER_SHEET);

    if (!inputPath) return fail("path is required");

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

    const sheets: Record<string, { columns: string[]; rows: Record<string, unknown>[]; totalRows: number; capped: boolean }> = {};

    for (const name of targetSheets) {
      const ws = workbook.Sheets[name];
      if (!ws) continue;

      const allRows = normaliseRows(XLSX.utils.sheet_to_json<unknown>(ws, { defval: null, dateNF: "YYYY-MM-DD" }));
      const capped = allRows.length > maxRows;
      const sliced = allRows.slice(0, maxRows);
      const columnSet = new Set<string>();
      for (const row of sliced) for (const key of Object.keys(row)) columnSet.add(key);
      const columns = [...columnSet];

      sheets[name] = { columns, rows: sliced, totalRows: allRows.length, capped };
    }

    let output: string;
    try {
      output = JSON.stringify(sheets, null, 2);
    } catch {
      output = `[sheets: ${Object.keys(sheets).join(", ")} — data contains non-serialisable values]`;
    }

    if (output.length > MAX_OUTPUT_CHARS) {
      output = output.slice(0, MAX_OUTPUT_CHARS) + `\n\n[Output truncated at ${MAX_OUTPUT_CHARS} chars]`;
    }

    const summary = Object.entries(sheets)
      .map(([name, s]) => `${name}: ${s.rows.length}/${s.totalRows} rows, ${s.columns.length} columns${s.capped ? " (capped)" : ""}`)
      .join("; ");

    return {
      success: true,
      output,
      metadata: {
        path: relativePath,
        sheetNames: Object.keys(sheets),
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
        path: relativePath,
        format: ext.slice(1),
        sheetCount: sheetsInput.length,
        totalRows,
      },
    };
  },
});
