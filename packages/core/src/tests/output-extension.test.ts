import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extensionNote, withRequiredExtension } from "../tools/output-extension.js";

/** Emitters correct a wrong output extension instead of refusing the whole artifact. */

describe("withRequiredExtension", () => {
  it.each([
    ["diagramme/abhaengigkeiten.md", ".mmd", "diagramme/abhaengigkeiten.mmd", ".md"],
    ["report", ".pdf", "report.pdf", undefined],
    ["Report.PDF", ".pdf", "Report.PDF", undefined],
    ["charts/plan.v2", ".svg", "charts/plan.svg", ".v2"],
  ])("%s with %s → %s", (requested, ext, path, replaced) => {
    expect(withRequiredExtension(requested, ext)).toEqual({ path, ...(replaced ? { replacedExtension: replaced } : {}) });
  });

  it("notes a replacement, and only a replacement", () => {
    expect(extensionNote({ path: "a.mmd", replacedExtension: ".md" }, ".mmd")).toMatch(/ended in \.md; this output is always \.mmd/);
    expect(extensionNote({ path: "a.mmd" }, ".mmd")).toBe("");
  });
});

describe("artifact emitters and a wrong extension", () => {
  let tempDir: string;
  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "starlingai-output-ext-"));
    await import("../tools/artifact-emitters.js");
  });
  afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

  async function run(name: string, args: Record<string, unknown>) {
    const { executeTool } = await import("../tools/registry.js");
    return executeTool(name, args, { sessionId: "output-ext-test", workspacePath: tempDir });
  }

  it("generate_svg saves an SVG asked for as .png under .svg", async () => {
    const result = await run("generate_svg", { svg: "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>", output_file: "logo.png" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("logo.svg");
    expect(result.output).toMatch(/ended in \.png/);
    expect(existsSync(join(tempDir, "generated", "logo.svg"))).toBe(true);
  });

  it("generate_ics saves a calendar asked for as .txt under .ics", async () => {
    const result = await run("generate_ics", {
      events: [{ summary: "Review", start: "2026-11-02T10:00:00Z", end: "2026-11-02T11:00:00Z" }],
      output_file: "termine.txt",
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain("termine.ics");
  });
});
