import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { refreshWorkspaceArtifactSnapshot } from "../agent/sub-agent.js";

/**
 * A STAGED BUILD OUTLIVES ITS OWN ARTIFACT RECORD (session 00b3675d, 2026-09-07).
 *
 * The user asked what a subscription costs, and the report they were shown a preview of was
 * 469 bytes of stub scaffolding — while the finished document sat complete on disk at 16 KB.
 *
 * The record is written once. `recordArtifacts` only sees metadata carrying an outputPath,
 * and of the two tools a staged build uses only write_file emits one: edit_file returns
 * `{ path, replacements }`, so every fill pass is invisible to it. Pass one's skeleton
 * snapshot — its `size` and its `textPreview` — therefore describes the artifact forever,
 * however many passes fill it afterwards.
 */
describe("workspace artifact snapshot refresh", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-artifact-refresh-"));
  const SKELETON = [
    "# OpenAI vs Anthropic subscription comparison",
    "",
    "UNFINISHED_STUB: executive_summary",
    "UNFINISHED_STUB: pricing_table",
    "UNFINISHED_STUB: recommendation",
  ].join("\n");

  /** The metadata write_file actually returns, minus the fields this function never touches. */
  const skeletonArtifact = (): Record<string, unknown> => ({
    artifactKind: "workspace_file",
    path: "generated/comparison.md",
    outputPath: "generated/comparison.md",
    filename: "comparison.md",
    contentType: "text/markdown",
    previewMode: "text",
    isDirectory: false,
    size: SKELETON.length,
    writeMode: "write",
    textPreview: SKELETON.replace(/\s+/g, " ").trim(),
  });

  beforeAll(() => {
    mkdirSync(join(tempDir, "generated"), { recursive: true });
    writeFileSync(join(tempDir, "generated", "comparison.md"), SKELETON, "utf8");
  });

  it("keeps the write-time snapshot when nothing has changed", () => {
    const refreshed = refreshWorkspaceArtifactSnapshot(skeletonArtifact(), tempDir);
    expect(refreshed["size"]).toBe(SKELETON.length);
    expect(String(refreshed["textPreview"])).toContain("UNFINISHED_STUB: pricing_table");
  });

  it("reports the FILLED document once the fill passes have run", () => {
    // What passes 2..13 do: edit_file replacing one marker line at a time. None of them
    // records an artifact, so without the refresh the record still says 469-ish bytes of stubs.
    const file = join(tempDir, "generated", "comparison.md");
    let filled = readFileSync(file, "utf8");
    filled = filled.replace(
      "UNFINISHED_STUB: executive_summary",
      "## Executive summary\n\nBoth vendors sell individual and team tiers; the gap is in the top tier.",
    );
    filled = filled.replace(
      "UNFINISHED_STUB: pricing_table",
      ["## Pricing", "", "| Plan | Price |", "| --- | --- |", "| Pro | $20/mo |", "| Max | $100/mo |"].join("\n"),
    );
    filled = filled.replace(
      "UNFINISHED_STUB: recommendation",
      "## Recommendation\n\n" + "The heavier tier pays for itself above roughly forty sessions a month. ".repeat(40),
    );
    writeFileSync(file, filled, "utf8");

    const stale = skeletonArtifact();
    const refreshed = refreshWorkspaceArtifactSnapshot(stale, tempDir);

    expect(refreshed["size"]).toBe(filled.length);
    expect(Number(refreshed["size"])).toBeGreaterThan(Number(stale["size"]) * 4);
    expect(String(refreshed["textPreview"])).toContain("Executive summary");
    expect(String(refreshed["textPreview"])).not.toContain("UNFINISHED_STUB");
    // Same preview shape write_file would have produced for a single write of this content.
    expect(String(refreshed["textPreview"]).length).toBeLessThanOrEqual(1_200);
    // Non-destructive: the caller's record is untouched, and identity fields survive.
    expect(stale["size"]).toBe(SKELETON.length);
    expect(refreshed["filename"]).toBe("comparison.md");
    expect(refreshed["outputPath"]).toBe("generated/comparison.md");
    expect(refreshed["previewMode"]).toBe("text");
  });

  it("leaves non-workspace artifacts alone — they have no on-disk state", () => {
    // The path here deliberately RESOLVES to a real file, so the kind guard is the only
    // thing that can hold this back. A rendered chart's size and preview describe the image
    // it carries, not whatever happens to sit at a colliding workspace path.
    const chart = {
      artifactKind: "inline_image",
      dataUrl: "data:image/png;base64,iVBOR",
      path: "generated/comparison.md",
      outputPath: "generated/comparison.md",
      size: 5,
      textPreview: "chart of plan prices",
    };
    expect(refreshWorkspaceArtifactSnapshot(chart, tempDir)).toEqual(chart);
  });

  it("fails open when the file is gone, keeping what the record already had", () => {
    const moved = { ...skeletonArtifact(), path: "generated/deleted.md", outputPath: "generated/deleted.md" };
    const refreshed = refreshWorkspaceArtifactSnapshot(moved, tempDir);
    expect(refreshed["size"]).toBe(SKELETON.length);
    expect(String(refreshed["textPreview"])).toContain("UNFINISHED_STUB");
  });

  it("resolves through `path` when outputPath is absent", () => {
    const onlyPath = { ...skeletonArtifact(), outputPath: undefined };
    expect(Number(refreshWorkspaceArtifactSnapshot(onlyPath, tempDir)["size"])).toBeGreaterThan(SKELETON.length);
  });
});

/**
 * The premise, pinned against the real tools rather than described. If edit_file ever starts
 * emitting an outputPath, `recordArtifacts` will see fill passes on its own and this refresh
 * becomes belt-and-braces rather than the only thing keeping the record current — worth
 * knowing when that changes.
 */
describe("why the refresh is needed at all", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-artifact-premise-"));

  it("edit_file records no artifact, so a fill pass cannot update the record", async () => {
    await import("../tools/filesystem.js");
    const { getTool } = await import("../tools/registry.js");
    const ctx = { sessionId: "s", workspacePath: tempDir };

    const write = await getTool("write_file")!.execute(
      { path: "generated/doc.md", content: "# Title\n\nUNFINISHED_STUB: body\n" }, ctx,
    );
    expect(write.success).toBe(true);
    expect(write.metadata?.["outputPath"]).toBeTruthy();   // recordArtifacts can see this
    expect(write.metadata?.["textPreview"]).toContain("UNFINISHED_STUB");

    const edit = await getTool("edit_file")!.execute(
      { path: "generated/doc.md", old_string: "UNFINISHED_STUB: body", new_string: "The body, written in full." }, ctx,
    );
    expect(edit.success).toBe(true);
    expect(edit.metadata?.["outputPath"]).toBeUndefined();  // …and nothing here for it to see
    expect(edit.metadata?.["textPreview"]).toBeUndefined();
  });
});
