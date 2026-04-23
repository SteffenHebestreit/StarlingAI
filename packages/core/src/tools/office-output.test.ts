import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("Wave C office artifact emitters", () => {
  const cleanup: string[] = [];
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "starlingai-office-"));
    cleanup.push(workspace);
  });

  afterEach(() => {
    for (const dir of cleanup.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  async function getTool(name: string) {
    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./office-output.js"),
    ]);
    return getTool(name)!;
  }

  function ctx() {
    return { sessionId: "s1", workspacePath: workspace };
  }

  function isPkZip(path: string): boolean {
    const buf = readFileSync(path);
    // OOXML files are ZIP containers — magic bytes "PK\x03\x04"
    return buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04;
  }

  // ── generate_docx ────────────────────────────────────────────────────────

  it("generate_docx writes a valid .docx from Markdown content", async () => {
    const result = await (await getTool("generate_docx")).execute({
      title: "Project Brief",
      content: "# Goals\n\nDeliver a Q3 release.\n\n- Faster onboarding\n- Better metrics\n\n## Risks\n\nScope creep on the auth refactor.",
      author: "StarlingAI Bot",
    }, ctx());

    expect(result.success).toBe(true);
    expect(result.metadata?.["artifactKind"]).toBe("document");
    expect(result.metadata?.["format"]).toBe("docx");
    expect(result.metadata?.["outputPath"]).toBe("project-brief.docx");

    const fullPath = join(workspace, "project-brief.docx");
    expect(isPkZip(fullPath)).toBe(true);
    expect(statSync(fullPath).size).toBeGreaterThan(1000);
  });

  it("generate_docx renders structured blocks (heading, paragraph, table, bullets)", async () => {
    const result = await (await getTool("generate_docx")).execute({
      title: "Launch Checklist",
      blocks: [
        { type: "heading", level: 1, text: "Launch Checklist" },
        { type: "paragraph", text: "Pre-launch sanity checks for the v0.8.0 release." },
        { type: "heading", level: 2, text: "Smoke tests" },
        { type: "bullets", items: ["Auth login round-trip", "Payment webhook delivery", "Webchat fallback"] },
        { type: "heading", level: 2, text: "Owners" },
        { type: "table", rows: [["Area", "Owner", "Status"], ["Auth", "Alice", "Done"], ["Payments", "Bob", "In progress"]] },
        { type: "page_break" },
        { type: "heading", level: 2, text: "Notes" },
        { type: "numbered", items: ["Rollback plan validated", "On-call rotation acknowledged"] },
      ],
      output_file: "launch.docx",
    }, ctx());

    expect(result.success).toBe(true);
    const fullPath = join(workspace, "launch.docx");
    expect(isPkZip(fullPath)).toBe(true);
  });

  it("generate_docx rejects when neither content nor blocks is provided", async () => {
    const result = await (await getTool("generate_docx")).execute({
      title: "Empty",
    }, ctx());
    expect(result.success).toBe(false);
    expect(result.error).toContain("content or blocks");
  });

  it("generate_docx rejects non-.docx output_file", async () => {
    const result = await (await getTool("generate_docx")).execute({
      title: "X",
      content: "hello",
      output_file: "out.txt",
    }, ctx());
    expect(result.success).toBe(false);
    expect(result.error).toContain(".docx");
  });

  it("generate_docx refuses overwrite when overwrite=false and file exists", async () => {
    await (await getTool("generate_docx")).execute({
      title: "Brief",
      content: "first",
      output_file: "brief.docx",
    }, ctx());
    const second = await (await getTool("generate_docx")).execute({
      title: "Brief",
      content: "second",
      output_file: "brief.docx",
      overwrite: false,
    }, ctx());
    expect(second.success).toBe(false);
    expect(second.error).toContain("Refusing");
  });

  // ── generate_pptx ────────────────────────────────────────────────────────

  it("generate_pptx writes a valid .pptx with title + content slides", async () => {
    const result = await (await getTool("generate_pptx")).execute({
      title: "Q3 Kickoff",
      author: "StarlingAI Bot",
      slides: [
        { layout: "title", title: "Q3 Kickoff", subtitle: "Goals & Workstreams · 2026-04-23" },
        { layout: "title-content", title: "Goals", bullets: ["Ship the new auth flow", "Land observability dashboards", "Cut the on-call paging volume by 40%"] },
        { layout: "two-column", title: "Workstreams", leftBullets: ["Auth", "Payments"], rightBullets: ["Observability", "On-call quality"] },
        { layout: "section-divider", title: "Risks", subtitle: "What could derail us" },
        { layout: "title-content", title: "Top risks", body: "Scope creep on auth refactor; staffing gap on payments; unknown DB migration cost.", notes: "Speaker notes — bring up the migration owner question." },
      ],
      output_file: "q3-kickoff.pptx",
    }, ctx());

    expect(result.success).toBe(true);
    expect(result.metadata?.["artifactKind"]).toBe("document");
    expect(result.metadata?.["format"]).toBe("pptx");
    expect(result.metadata?.["slideCount"]).toBe(5);

    const fullPath = join(workspace, "q3-kickoff.pptx");
    expect(isPkZip(fullPath)).toBe(true);
    expect(statSync(fullPath).size).toBeGreaterThan(2000);
  });

  it("generate_pptx rejects empty slides", async () => {
    const result = await (await getTool("generate_pptx")).execute({
      title: "Empty",
      slides: [],
    }, ctx());
    expect(result.success).toBe(false);
    expect(result.error).toContain("non-empty");
  });

  it("generate_pptx rejects non-.pptx output_file", async () => {
    const result = await (await getTool("generate_pptx")).execute({
      title: "X",
      slides: [{ layout: "title", title: "X" }],
      output_file: "deck.ppt",
    }, ctx());
    expect(result.success).toBe(false);
    expect(result.error).toContain(".pptx");
  });
});
