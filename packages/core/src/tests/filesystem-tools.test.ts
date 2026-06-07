import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("filesystem tools", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-filesystem-tools-"));

  beforeAll(async () => {
    mkdirSync(join(tempDir, "uploads"), { recursive: true });
    writeFileSync(join(tempDir, "uploads", "screenshot.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    writeFileSync(join(tempDir, "workspace-config.jsonc"), "{\n  // pentest shard comment\n  \"enabled\": true\n}\n");
    writeFileSync(join(tempDir, "protocol-map.mmd"), "graph TD\n  MCP --> Tools\n");
    await import("../tools/filesystem.js");
  });

  it("reads jsonc files used by workspace agent shards", async () => {
    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("read_file");

    const result = await tool!.execute({ path: "workspace-config.jsonc" }, {
      sessionId: "session-read-jsonc",
      workspacePath: tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("// pentest shard comment");
    expect(result.metadata).toMatchObject({
      path: "workspace-config.jsonc",
      ext: ".jsonc",
    });
  });

  it("reads Mermaid source artifacts as plain text", async () => {
    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("read_file");

    const result = await tool!.execute({ path: "protocol-map.mmd" }, {
      sessionId: "session-read-mmd",
      workspacePath: tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("graph TD");
    expect(result.metadata).toMatchObject({
      path: "protocol-map.mmd",
      ext: ".mmd",
    });
  });

  it("lists files for a /workspace-prefixed directory", async () => {
    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("list_files");

    const result = await tool!.execute({ path: "/workspace/uploads" }, {
      sessionId: "session-list-workspace-prefix",
      workspacePath: tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("screenshot.png");
  });

  it("exports an existing file as a chat artifact with normalized metadata", async () => {
    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("export_workspace_artifact");

    const result = await tool!.execute({ path: "/workspace/uploads/screenshot.png", title: "Screenshot" }, {
      sessionId: "session-export-file",
      workspacePath: tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.metadata).toMatchObject({
      artifactKind: "workspace_file",
      outputPath: "uploads/screenshot.png",
      filename: "screenshot.png",
      title: "Screenshot",
      contentType: "image/png",
      previewMode: "image",
      isDirectory: false,
      size: 8,
    });
  });

  it("roots write_file outputs under the generated/ subfolder, away from config", async () => {
    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("write_file");

    const result = await tool!.execute({ path: "reports/recorder.md", content: "# Recorder\n\nPartial design." }, {
      sessionId: "session-write-artifact",
      workspacePath: tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.metadata).toMatchObject({
      artifactKind: "workspace_file",
      path: "reports/recorder.md",
      // Rooted one layer deeper so generated output never mixes with the
      // config zone (agents/, jobs/, scenes/).
      outputPath: "generated/reports/recorder.md",
      filename: "recorder.md",
      contentType: "text/markdown; charset=utf-8",
      previewMode: "text",
      isDirectory: false,
      size: 27,
      textPreview: "# Recorder Partial design.",
    });
    // The file physically lives under generated/.
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(tempDir, "generated", "reports", "recorder.md"))).toBe(true);
    expect(existsSync(join(tempDir, "reports", "recorder.md"))).toBe(false);
  });

  it("does not double-nest when the path already targets generated/", async () => {
    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("write_file");

    const result = await tool!.execute({ path: "generated/site/index.html", content: "<h1>hi</h1>" }, {
      sessionId: "session-write-idempotent",
      workspacePath: tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.metadata).toMatchObject({ outputPath: "generated/site/index.html" });
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(tempDir, "generated", "site", "index.html"))).toBe(true);
    expect(existsSync(join(tempDir, "generated", "generated", "site", "index.html"))).toBe(false);
  });

  // Incremental large-file build (general fix for the slow-model single-call
  // timeout): the model writes a head chunk then appends the rest, so no single
  // write_file call has to emit a 30 KB+ blob. General across HTML/report/script.
  it("builds a file incrementally with mode:'append' (head + chunks)", async () => {
    const { getTool } = await import("../tools/registry.js");
    const { readFileSync, existsSync } = await import("node:fs");
    const tool = getTool("write_file")!;
    const ctx = { sessionId: "session-append-build", workspacePath: tempDir };

    const head = await tool.execute({ path: "deck/index.html", content: "<!doctype html><html><body>" }, ctx);
    expect(head.success).toBe(true);
    expect(head.metadata).toMatchObject({ writeMode: "overwrite", size: "<!doctype html><html><body>".length });

    const mid = await tool.execute({ path: "deck/index.html", content: "<section>Slide 1</section>", mode: "append" }, ctx);
    expect(mid.success).toBe(true);
    expect(mid.metadata).toMatchObject({ writeMode: "append" });
    expect(mid.output).toMatch(/Appended 26 chars to .+\(now \d+ chars total\)/);

    const tail = await tool.execute({ path: "deck/index.html", content: "</body></html>", mode: "append" }, ctx);
    expect(tail.success).toBe(true);

    const full = readFileSync(join(tempDir, "generated", "deck", "index.html"), "utf-8");
    expect(full).toBe("<!doctype html><html><body><section>Slide 1</section></body></html>");
    expect(tail.metadata?.["size"]).toBe(full.length);
    expect(existsSync(join(tempDir, "generated", "deck", "index.html"))).toBe(true);
  });

  it("rejects an empty-content / empty-path write instead of producing a 0-byte junk artifact (audit ca36debc)", async () => {
    const { getTool } = await import("../tools/registry.js");
    const { existsSync } = await import("node:fs");
    const tool = getTool("write_file")!;
    const ctx = { sessionId: "session-empty-write", workspacePath: tempDir };

    // The slow 35B blew its completion budget mid-tool-call (finishReason:"length"), so
    // write_file arrived with empty path + empty content; it used to write a 0-byte
    // "generated" file and surface it to the user as a download. Now it fails cleanly.
    const emptyPath = await tool.execute({ path: "", content: "" }, ctx);
    expect(emptyPath.success).toBe(false);
    expect(emptyPath.error).toMatch(/path is required/i);
    expect(emptyPath.metadata).toBeUndefined();

    const emptyContent = await tool.execute({ path: "reports/plan.md", content: "   " }, ctx);
    expect(emptyContent.success).toBe(false);
    expect(emptyContent.error).toMatch(/content is required/i);
    expect(emptyContent.metadata).toBeUndefined();
    // No 0-byte file was created on the empty-content path.
    expect(existsSync(join(tempDir, "generated", "reports", "plan.md"))).toBe(false);
  });

  it("mode:'append' creates the file when it does not exist yet", async () => {
    const { getTool } = await import("../tools/registry.js");
    const { readFileSync } = await import("node:fs");
    const tool = getTool("write_file")!;
    const result = await tool.execute(
      { path: "notes/log.md", content: "first line\n", mode: "append" },
      { sessionId: "session-append-create", workspacePath: tempDir },
    );
    expect(result.success).toBe(true);
    expect(readFileSync(join(tempDir, "generated", "notes", "log.md"), "utf-8")).toBe("first line\n");
  });

  it("mode:'create' refuses to clobber an existing file", async () => {
    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("write_file")!;
    const ctx = { sessionId: "session-create-guard", workspacePath: tempDir };
    const first = await tool.execute({ path: "once/seed.txt", content: "original", mode: "create" }, ctx);
    expect(first.success).toBe(true);
    const second = await tool.execute({ path: "once/seed.txt", content: "clobber", mode: "create" }, ctx);
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/already exists/i);
  });

  it("exports an existing folder as a downloadable archive artifact", async () => {
    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("export_workspace_artifact");

    const result = await tool!.execute({ path: "uploads" }, {
      sessionId: "session-export-dir",
      workspacePath: tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.metadata).toMatchObject({
      artifactKind: "workspace_directory",
      outputPath: "uploads",
      filename: "uploads",
      contentType: "application/x-directory",
      previewMode: "download",
      isDirectory: true,
      entryCount: 1,
    });
  });

  it("rejects export paths outside the workspace", async () => {
    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("export_workspace_artifact");

    const result = await tool!.execute({ path: "../../secret.txt" }, {
      sessionId: "session-export-escape",
      workspacePath: tempDir,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/workspace boundary/i);
  });
});