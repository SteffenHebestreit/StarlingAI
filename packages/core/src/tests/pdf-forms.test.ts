import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { getTool, type ToolContext, type ToolHandler } from "../tools/registry.js";
import "../tools/pdf-forms.js"; // registers pdf_fill / list_pdf_form_fields

let ws: string;
let ctx: ToolContext;

// Build a small AcroForm PDF fixture (one text field + one checkbox) in the workspace.
async function writeFormFixture(name: string): Promise<void> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([300, 200]);
  const form = pdf.getForm();
  const tf = form.createTextField("fullName");
  tf.addToPage(page, { x: 20, y: 150, width: 200, height: 20 });
  const cb = form.createCheckBox("agree");
  cb.addToPage(page, { x: 20, y: 120, width: 15, height: 15 });
  await writeFile(join(ws, name), await pdf.save());
}

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), "sai-pdf-"));
  ctx = { workspacePath: ws } as unknown as ToolContext;
  await writeFormFixture("form.pdf");
});
afterAll(async () => { await rm(ws, { recursive: true, force: true }); });

const t = (name: string): ToolHandler => {
  const h = getTool(name);
  if (!h) throw new Error(`tool ${name} not registered`);
  return h;
};
const fill = () => t("pdf_fill");
const list = () => t("list_pdf_form_fields");

describe("pdf-forms tools", () => {
  it("validates args", async () => {
    expect((await fill().execute({ fields: { a: 1 } }, ctx)).success).toBe(false); // no input_path
    expect((await fill().execute({ input_path: "form.pdf", fields: {} }, ctx)).success).toBe(false); // empty fields
    expect((await fill().execute({ input_path: "missing.pdf", fields: { a: 1 } }, ctx)).success).toBe(false); // missing file
    expect((await list().execute({}, ctx)).success).toBe(false); // no path
    expect((await list().execute({ path: "missing.pdf" }, ctx)).success).toBe(false); // missing file
  });

  it("lists the AcroForm fields", async () => {
    const r = await list().execute({ path: "form.pdf" }, ctx);
    expect(r.success).toBe(true);
    expect(r.metadata?.["fieldCount"]).toBe(2);
    const fields = JSON.parse(r.output) as Array<{ name: string; type: string }>;
    const byName = Object.fromEntries(fields.map((f) => [f.name, f.type]));
    expect(byName["fullName"]).toBe("TextField");
    expect(byName["agree"]).toBe("CheckBox");
  });

  it("fills fields (kept editable) and the values read back", async () => {
    const w = await fill().execute(
      { input_path: "form.pdf", output_path: "out.pdf", fields: { fullName: "Ann", agree: true }, flatten: false },
      ctx,
    );
    expect(w.success).toBe(true);
    expect(w.metadata?.["fieldsFilled"]).toEqual(expect.arrayContaining(["fullName", "agree"]));

    const r = await list().execute({ path: "out.pdf" }, ctx);
    const fields = JSON.parse(r.output) as Array<{ name: string; value: unknown }>;
    const byName = Object.fromEntries(fields.map((f) => [f.name, f.value]));
    expect(byName["fullName"]).toBe("Ann");
    expect(byName["agree"]).toBe(true);
  });

  it("reports unknown field names as skipped", async () => {
    const w = await fill().execute(
      { input_path: "form.pdf", output_path: "skip.pdf", fields: { nope: "x" }, flatten: false },
      ctx,
    );
    // Tool succeeds overall but records the unmatched field as skipped.
    const skipped = w.metadata?.["fieldsSkipped"] as Array<{ name: string }> | undefined;
    expect(skipped?.some((s) => s.name === "nope")).toBe(true);
  });

  it("rejects a non-pdf input path", async () => {
    await writeFile(join(ws, "note.txt"), "not a pdf");
    const r = await fill().execute({ input_path: "note.txt", fields: { a: 1 } }, ctx);
    expect(r.success).toBe(false);
  });
});
