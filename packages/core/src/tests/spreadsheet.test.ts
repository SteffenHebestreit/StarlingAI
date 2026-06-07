import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTool, type ToolContext, type ToolHandler } from "../tools/registry.js";
import "../tools/spreadsheet.js"; // registers spreadsheet_read / spreadsheet_write

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
    const parsed = JSON.parse(r.output) as Record<string, { columns: string[]; rows: Record<string, unknown>[] }>;
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
