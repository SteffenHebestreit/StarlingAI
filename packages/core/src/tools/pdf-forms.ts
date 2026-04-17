/**
 * Tier 2 (execute, per-call approval) — Fill AcroForm fields in existing PDF files.
 *
 * Loads a PDF, inspects its AcroForm, fills the requested fields by name,
 * and saves the result back to the workspace.  XFA forms are detected and
 * rejected with a clear error (pdf-lib cannot fill XFA).
 *
 * Supported field types:
 *  - Text fields      → setText(value)
 *  - Checkboxes       → check() / uncheck()
 *  - Radio groups     → select(option)
 *  - Dropdowns        → select(option)
 *  - Option lists     → select([options])
 *
 * Requires per-call approval because it modifies existing documents.
 */
import { existsSync, statSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, extname } from "node:path";
import {
  PDFDocument,
  PDFCheckBox,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
} from "pdf-lib";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { childLogger } from "../logger.js";
import { resolvePathWithinWorkspace } from "./workspace-path.js";

const log = childLogger("tool:pdf-forms");

/** Hard cap on input PDF size. */
const MAX_PDF_BYTES = 50 * 1024 * 1024; // 50 MB

// ─── Helpers ────────────────────────────────────────────────────────────────

function fail(error: string): ToolResult {
  return { success: false, output: "", error };
}

// ─── Tool registration ───────────────────────────────────────────────────────

registerTool({
  name: "pdf_fill",
  description:
    "Fill AcroForm fields in an existing PDF and save the result to a new file in the workspace. " +
    "Provide a map of field names to values. " +
    "Text fields accept any string; checkboxes accept true/false; " +
    "radio groups, dropdowns, and option lists accept the option label string. " +
    "Use list_pdf_form_fields first to discover available field names and types. " +
    "Requires per-call approval because it modifies existing documents.",
  parameters: {
    type: "object",
    properties: {
      input_path: {
        type: "string",
        description: "Workspace-relative path to the source PDF containing the AcroForm.",
      },
      output_path: {
        type: "string",
        description:
          "Workspace-relative path for the filled PDF output. " +
          "If omitted, defaults to <input_name>-filled.pdf in the same directory.",
      },
      fields: {
        type: "object",
        description:
          "Object mapping form field names to their fill values. " +
          "String values fill text fields, dropdowns, radio groups, and option lists. " +
          "Boolean true/false checks or unchecks checkboxes.",
        additionalProperties: {},
      },
      flatten: {
        type: "boolean",
        description:
          "When true (default), flatten the form after filling so fields become static text. " +
          "Set to false to keep fields editable.",
        default: true,
      },
      overwrite: {
        type: "boolean",
        description: "When false, fail instead of overwriting an existing output file.",
        default: true,
      },
    },
    required: ["input_path", "fields"],
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const inputPathArg = String(args["input_path"] ?? "").trim();
    const outputPathArg = args["output_path"] != null ? String(args["output_path"]).trim() : "";
    const fieldsArg = args["fields"] && typeof args["fields"] === "object" && !Array.isArray(args["fields"])
      ? (args["fields"] as Record<string, unknown>)
      : null;
    const shouldFlatten = Boolean(args["flatten"] ?? true);
    const overwrite = Boolean(args["overwrite"] ?? true);

    if (!inputPathArg) return fail("input_path is required");
    if (!fieldsArg || Object.keys(fieldsArg).length === 0) {
      return fail("fields must be a non-empty object mapping field names to values");
    }

    // Resolve input path
    let resolvedInput: string;
    let relativeInput: string;
    try {
      ({ resolved: resolvedInput, relativePath: relativeInput } = resolvePathWithinWorkspace(inputPathArg, ctx.workspacePath));
    } catch {
      return fail("input_path must be within the workspace");
    }

    if (!existsSync(resolvedInput)) return fail(`Input file not found: ${inputPathArg}`);
    const stat = statSync(resolvedInput);
    if (stat.isDirectory()) return fail("input_path is a directory, not a PDF file");
    if (stat.size > MAX_PDF_BYTES) {
      return fail(`Input PDF is too large (${stat.size} bytes > ${MAX_PDF_BYTES} byte limit)`);
    }
    if (extname(resolvedInput).toLowerCase() !== ".pdf") {
      return fail("input_path must be a .pdf file");
    }

    // Derive output path
    let resolvedOutput: string;
    let relativeOutput: string;
    if (outputPathArg) {
      try {
        ({ resolved: resolvedOutput, relativePath: relativeOutput } = resolvePathWithinWorkspace(outputPathArg, ctx.workspacePath));
      } catch {
        return fail("output_path must be within the workspace");
      }
    } else {
      const baseName = relativeInput.replace(/\.pdf$/i, "-filled.pdf");
      try {
        ({ resolved: resolvedOutput, relativePath: relativeOutput } = resolvePathWithinWorkspace(baseName, ctx.workspacePath));
      } catch {
        return fail("Could not derive a safe output path");
      }
    }

    if (extname(resolvedOutput).toLowerCase() !== ".pdf") {
      return fail("output_path must end with .pdf");
    }

    if (!overwrite && existsSync(resolvedOutput)) {
      return fail(`Refusing to overwrite existing file: ${relativeOutput}`);
    }

    // Load PDF
    let pdfDoc: PDFDocument;
    try {
      const pdfBytes = await readFile(resolvedInput);
      pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: false });
    } catch (err) {
      log.error({ err, relativeInput }, "pdf_fill: failed to load PDF");
      return fail(`Failed to load PDF: ${String(err)}`);
    }

    // Check for XFA
    let xfaDetected = false;
    try {
      const form = pdfDoc.getForm();
      const acroFormDict = (form as unknown as { acroForm: { has: (k: unknown) => boolean; context: { obj: (k: string) => unknown } } }).acroForm;
      if (acroFormDict && typeof acroFormDict.has === "function") {
        xfaDetected = acroFormDict.has(acroFormDict.context.obj("XFA"));
      }
    } catch {
      // Ignore — if getForm() itself throws, the PDF probably has no AcroForm
      xfaDetected = false;
    }

    if (xfaDetected) {
      return fail(
        "This PDF uses XFA forms, which are not supported by pdf_fill. " +
        "XFA forms require Adobe Acrobat or a specialised XFA processor. " +
        "Only AcroForm-based PDFs are supported.",
      );
    }

    // Fill fields
    let form = pdfDoc.getForm();
    const fieldsFilled: string[] = [];
    const fieldsSkipped: Array<{ name: string; reason: string }> = [];

    for (const [fieldName, rawValue] of Object.entries(fieldsArg)) {
      try {
        let fieldWidget;
        try {
          fieldWidget = form.getField(fieldName);
        } catch {
          fieldsSkipped.push({ name: fieldName, reason: "field not found in form" });
          continue;
        }

        if (fieldWidget instanceof PDFTextField) {
          fieldWidget.setText(rawValue != null ? String(rawValue) : "");
          fieldsFilled.push(fieldName);
        } else if (fieldWidget instanceof PDFCheckBox) {
          const checked =
            rawValue === true ||
            rawValue === 1 ||
            (typeof rawValue === "string" && /^(true|yes|1|on|checked)$/i.test(rawValue));
          if (checked) {
            fieldWidget.check();
          } else {
            fieldWidget.uncheck();
          }
          fieldsFilled.push(fieldName);
        } else if (fieldWidget instanceof PDFRadioGroup) {
          fieldWidget.select(String(rawValue));
          fieldsFilled.push(fieldName);
        } else if (fieldWidget instanceof PDFDropdown) {
          fieldWidget.select(String(rawValue));
          fieldsFilled.push(fieldName);
        } else if (fieldWidget instanceof PDFOptionList) {
          const options = Array.isArray(rawValue)
            ? (rawValue as unknown[]).map(String)
            : [String(rawValue)];
          fieldWidget.select(options);
          fieldsFilled.push(fieldName);
        } else {
          fieldsSkipped.push({ name: fieldName, reason: `unsupported field type: ${fieldWidget.constructor.name}` });
        }
      } catch (err) {
        fieldsSkipped.push({ name: fieldName, reason: `error filling field: ${String(err)}` });
      }
    }

    if (shouldFlatten) {
      try {
        form.flatten();
      } catch (err) {
        log.warn({ err }, "pdf_fill: flatten() failed, saving without flattening");
      }
    }

    // Save
    let filledBytes: Uint8Array;
    try {
      filledBytes = await pdfDoc.save();
    } catch (err) {
      log.error({ err, relativeOutput }, "pdf_fill: failed to save PDF");
      return fail(`Failed to save filled PDF: ${String(err)}`);
    }

    try {
      await mkdir(dirname(resolvedOutput), { recursive: true });
      await writeFile(resolvedOutput, filledBytes);
    } catch (err) {
      log.error({ err, relativeOutput }, "pdf_fill: failed to write output file");
      return fail(`Failed to write output file: ${String(err)}`);
    }

    log.info({ relativeInput, relativeOutput, fieldsFilled: fieldsFilled.length }, "pdf_fill completed");

    const skippedNote = fieldsSkipped.length > 0
      ? `\nSkipped ${fieldsSkipped.length} field(s): ${fieldsSkipped.map((s) => `${s.name} (${s.reason})`).join(", ")}`
      : "";

    return {
      success: true,
      output:
        `Filled ${fieldsFilled.length} field(s) and saved to ${relativeOutput}.${skippedNote}`,
      metadata: {
        inputPath: relativeInput,
        outputPath: relativeOutput,
        fieldsFilled,
        fieldsSkipped,
        flattened: shouldFlatten,
        sizeBytes: filledBytes.length,
      },
    };
  },
});

// ─── list_pdf_form_fields ────────────────────────────────────────────────────

registerTool({
  name: "list_pdf_form_fields",
  description:
    "List all AcroForm fields in a PDF, including their names, types, and current values. " +
    "Use this before pdf_fill to discover available field names.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Workspace-relative path to the PDF file.",
      },
    },
    required: ["path"],
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const inputPathArg = String(args["path"] ?? "").trim();

    if (!inputPathArg) return fail("path is required");

    let resolvedInput: string;
    let relativeInput: string;
    try {
      ({ resolved: resolvedInput, relativePath: relativeInput } = resolvePathWithinWorkspace(inputPathArg, ctx.workspacePath));
    } catch {
      return fail("path must be within the workspace");
    }

    if (!existsSync(resolvedInput)) return fail(`File not found: ${inputPathArg}`);
    const stat = statSync(resolvedInput);
    if (stat.isDirectory()) return fail("path is a directory");
    if (stat.size > MAX_PDF_BYTES) {
      return fail(`File too large (${stat.size} bytes > ${MAX_PDF_BYTES} byte limit)`);
    }
    if (extname(resolvedInput).toLowerCase() !== ".pdf") {
      return fail("path must be a .pdf file");
    }

    let pdfDoc: PDFDocument;
    try {
      const pdfBytes = await readFile(resolvedInput);
      pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: false });
    } catch (err) {
      return fail(`Failed to load PDF: ${String(err)}`);
    }

    let fields: Array<{ name: string; type: string; value: unknown }>;
    try {
      const form = pdfDoc.getForm();
      fields = form.getFields().map((f) => {
        const name = f.getName();
        let type = f.constructor.name.replace(/^PDF/, "");
        let value: unknown = null;

        if (f instanceof PDFTextField) {
          type = "TextField";
          value = f.getText() ?? null;
        } else if (f instanceof PDFCheckBox) {
          type = "CheckBox";
          value = f.isChecked();
        } else if (f instanceof PDFRadioGroup) {
          type = "RadioGroup";
          value = f.getSelected() ?? null;
        } else if (f instanceof PDFDropdown) {
          type = "Dropdown";
          value = f.getSelected();
        } else if (f instanceof PDFOptionList) {
          type = "OptionList";
          value = f.getSelected();
        }

        return { name, type, value };
      });
    } catch {
      return {
        success: true,
        output: "This PDF has no AcroForm or the form is empty.",
        metadata: { path: relativeInput, fieldCount: 0, fields: [] },
      };
    }

    const output = JSON.stringify(fields, null, 2);
    return {
      success: true,
      output,
      metadata: {
        path: relativeInput,
        fieldCount: fields.length,
      },
    };
  },
});
