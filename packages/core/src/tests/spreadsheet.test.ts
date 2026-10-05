import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTool, type ToolContext, type ToolHandler } from "../tools/registry.js";
import "../tools/spreadsheet.js"; // registers spreadsheet_read / spreadsheet_write
import { MAX_TOOL_RESULT_CHARS, truncateToolResult } from "../tools/result-shaping.js";

let ws: string;
let ctx: ToolContext;
beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), "sai-ss-"));
  ctx = { workspacePath: ws } as unknown as ToolContext;
});
afterAll(async () => { await rm(ws, { recursive: true, force: true }); });

const t = (name: string): ToolHandler => {
  const h = getTool(name);
  if (!h) throw new Error(`tool ${name} not registered`);
  return h;
};
const write = () => t("spreadsheet_write");
const read = () => t("spreadsheet_read");
/** The JSON after the summary lines spreadsheet_read puts first. */
const jsonPart = (output: string): string => output.slice(output.indexOf("\n\n") + 2);

describe("spreadsheet tools", () => {
  it("validates args", async () => {
    expect((await write().execute({ sheets: [{ name: "S", rows: [{ a: 1 }] }] }, ctx)).success).toBe(false); // no path
    expect((await write().execute({ path: "x.xlsx", sheets: [] }, ctx)).success).toBe(false); // empty sheets
    expect((await write().execute({ path: "x.txt", sheets: [{ rows: [{ a: 1 }] }] }, ctx)).success).toBe(false); // bad ext
    expect((await read().execute({}, ctx)).success).toBe(false); // no path
    expect((await read().execute({ path: "nope.xlsx" }, ctx)).success).toBe(false); // missing file
  });

  it("round-trips an .xlsx workbook (write → read)", async () => {
    const w = await write().execute(
      { path: "data.xlsx", sheets: [{ name: "People", rows: [{ name: "Ann", age: 30 }, { name: "Bo", age: 25 }] }] },
      ctx,
    );
    expect(w.success).toBe(true);
    expect(w.metadata?.["totalRows"]).toBe(2);

    const r = await read().execute({ path: "data.xlsx" }, ctx);
    expect(r.success).toBe(true);
    expect(r.output.split("\n")[0]).toBe('Sheet "People": all 2 data rows.');
    const parsed = JSON.parse(jsonPart(r.output)) as Record<string, { columns: string[]; rows: Record<string, unknown>[] }>;
    expect(parsed["People"]!.rows).toHaveLength(2);
    expect(parsed["People"]!.columns).toEqual(expect.arrayContaining(["name", "age"]));
    expect(parsed["People"]!.rows[0]!["name"]).toBe("Ann");
  });

  it("reads a single named sheet and reports unknown sheets", async () => {
    await write().execute(
      { path: "multi.xlsx", sheets: [{ name: "A", rows: [{ x: 1 }] }, { name: "B", rows: [{ y: 2 }] }] },
      ctx,
    );
    const only = await read().execute({ path: "multi.xlsx", sheet: "B" }, ctx);
    expect(only.success).toBe(true);
    expect(only.metadata?.["sheetNames"]).toEqual(["B"]);

    const missing = await read().execute({ path: "multi.xlsx", sheet: "Z" }, ctx);
    expect(missing.success).toBe(false);
  });

  it("writes + reads .csv and honors overwrite:false", async () => {
    const w = await write().execute({ path: "rows.csv", sheets: [{ rows: [{ a: 1, b: 2 }] }] }, ctx);
    expect(w.success).toBe(true);
    expect(w.metadata?.["format"]).toBe("csv");

    const r = await read().execute({ path: "rows.csv" }, ctx);
    expect(r.success).toBe(true);

    const refuse = await write().execute({ path: "rows.csv", sheets: [{ rows: [{ a: 9 }] }], overwrite: false }, ctx);
    expect(refuse.success).toBe(false);
  });

  it("rejects a path that escapes the workspace", async () => {
    const r = await read().execute({ path: "../../etc/passwd" }, ctx);
    expect(r.success).toBe(false);
  });
});

/**
 * spreadsheet_read pretty-printed every sheet and sliced the text at 64,000 characters: the cut fell
 * mid-row, took the totalRows/capped fields after it and every later sheet, and nothing said so.
 * header_row was declared and never read. The answer now opens with which rows of which sheets it
 * holds, budgets rows per sheet, and pages with start_row.
 */
describe("spreadsheet_read says which rows it returned", () => {
  type Sheets = Record<string, { columns: string[]; rows: Record<string, unknown>[]; totalRows: number; firstRow: number; lastRow: number }>;

  it("budgets rows across sheets instead of cutting the later ones off", async () => {
    const wide = Array.from({ length: 3000 }, (_, i) => ({ id: i + 1, note: `row ${i + 1} ${"lorem ipsum ".repeat(5)}` }));
    await write().execute({ path: "quarters.xlsx", sheets: [{ name: "Q3", rows: wide }, { name: "Q4", rows: [{ id: 1, note: "q4 first" }, { id: 2, note: "q4 second" }] }] }, ctx);

    const r = await read().execute({ path: "quarters.xlsx" }, ctx);
    expect(r.success).toBe(true);
    const [q3Line, q4Line] = r.output.split("\n");
    expect(q3Line).toMatch(/^Sheet "Q3": data rows 1-(\d+) of 3000 — rows \d+-3000 not shown \(output budget\); pass sheet="Q3", start_row=\d+ for the next ones\.$/);
    expect(q4Line).toBe('Sheet "Q4": all 2 data rows.');
    const parsed = JSON.parse(jsonPart(r.output)) as Sheets;
    expect(parsed["Q4"]!.rows.map((row) => row["note"])).toEqual(["q4 first", "q4 second"]);
    expect(parsed["Q3"]!.totalRows).toBe(3000);
    expect(parsed["Q3"]!.lastRow).toBe(parsed["Q3"]!.rows.length);
    expect(r.output.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
  });

  it("uses header_row and pages with start_row", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(ws, "report.csv"), "Quarterly report,\nprepared by finance,\nname,amount\nAnn,1\nBo,2\nCy,3\nDi,4\nEd,5\n");

    const r = await read().execute({ path: "report.csv", header_row: 3, start_row: 4, max_rows: 1 }, ctx);
    expect(r.success).toBe(true);
    const lines = r.output.split("\n");
    expect(lines[0]).toBe("Row 3 is the header; the 2 row(s) above it were skipped.");
    expect(r.output).toContain('Sheet "Sheet1": data rows 4-4 of 5 — rows 5-5 not shown (max_rows); pass sheet="Sheet1", start_row=5 for the next ones.');
    const parsed = JSON.parse(jsonPart(r.output)) as Sheets;
    expect(parsed["Sheet1"]!.columns).toEqual(["name", "amount"]);
    expect(parsed["Sheet1"]!.rows).toEqual([{ name: "Di", amount: 4 }]);
  });

  it("refuses a protected path, as read_file does", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(ws, ".starlingai"), { recursive: true });
    await writeFile(join(ws, ".starlingai", "secrets.csv"), "key,value\nJWT,supersecret\n");
    const r = await read().execute({ path: ".starlingai/secrets.csv" }, ctx);
    expect(r.success).toBe(false);
    expect(r.output).not.toContain("supersecret");
  });
});

/**
 * The answer has to reach a sub-agent whole. Sub-agents cut any tool result above
 * MAX_TOOL_RESULT_CHARS to head + tail; budgeted to 64,000 characters, a 2,000-row CSV said
 * "rows 1-730 … start_row=731" while the agent saw rows 1-263 and 657-730, and the hint skipped
 * the lost rows for good.
 */
describe("spreadsheet_read fits the sub-agent tool-result cap", () => {
  it("returns a window the cap leaves untouched, and its start_row hint continues from the last row shown", async () => {
    const { writeFile } = await import("node:fs/promises");
    const lines = ["id,customer,region,amount,note"];
    for (let i = 1; i <= 2000; i++) lines.push(`${i},Customer ${i},Region ${i % 7},${(i * 13.37).toFixed(2)},routine order number ${i}`);
    await writeFile(join(ws, "orders.csv"), `${lines.join("\n")}\n`);

    const r = await read().execute({ path: "orders.csv" }, ctx);
    expect(r.success).toBe(true);
    expect(truncateToolResult(r.output, "spreadsheet_read"), "a sub-agent would see a different answer").toBe(r.output);

    const parsed = JSON.parse(jsonPart(r.output)) as Record<string, { rows: Array<Record<string, unknown>>; lastRow: number }>;
    const shown = parsed["Sheet1"]!;
    const match = /data rows 1-(\d+) of 2000 — rows (\d+)-2000 not shown \(output budget\); pass sheet="Sheet1", start_row=(\d+)/.exec(r.output);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(shown.rows.length);
    expect(shown.rows.at(-1)!["id"]).toBe(shown.rows.length);
    expect(Number(match![3])).toBe(shown.rows.length + 1);

    const next = await read().execute({ path: "orders.csv", start_row: Number(match![3]) }, ctx);
    const nextRows = (JSON.parse(jsonPart(next.output)) as Record<string, { rows: Array<Record<string, unknown>> }>)["Sheet1"]!.rows;
    expect(nextRows[0]!["id"]).toBe(shown.rows.length + 1);
  });
});

describe("spreadsheet_read keeps its summary inside the cap", () => {
  it("shrinks the rows when many sheets' summary lines outgrow the headroom", async () => {
    // 40 sheets with 31-character names (Excel's limit): ~180 characters of summary each, past
    // the room left beside the row budget — the answer has to shrink rows to stay under the cap
    // (measured: 34,398 characters without the shrink, 32,219 for 20 sheets, which fit).
    const sheets = Array.from({ length: 40 }, (_, s) => ({
      name: `Quarterly regional sales ${String(s).padStart(2, "0")}xx`.slice(0, 31),
      rows: Array.from({ length: 300 }, (_, i) => ({ id: i + 1, region: `Region ${i % 9}`, amount: i * 3 })),
    }));
    await write().execute({ path: "many.xlsx", sheets }, ctx);

    const r = await read().execute({ path: "many.xlsx" }, ctx);
    expect(r.success).toBe(true);
    expect(r.output.split("\n").filter((line) => line.startsWith("Sheet ")).length).toBe(40);
    expect(r.output.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
    expect(truncateToolResult(r.output, "spreadsheet_read")).toBe(r.output);
  });
});
