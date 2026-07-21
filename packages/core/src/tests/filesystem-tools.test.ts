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
    writeFileSync(join(tempDir, ".env"), "SAI_JWT_SECRET=supersecret\n");
    writeFileSync(join(tempDir, ".env.example"), "SAI_JWT_SECRET=changeme\n");
    await import("../tools/filesystem.js");
  });

  it("read_file refuses .env case-insensitively (the case-mount bypass this fixes)", async () => {
    const { getTool } = await import("../tools/registry.js");
    const read = getTool("read_file")!;
    // .env is denied; on a case-insensitive host mount `.ENV`/`.Env` resolve to the same
    // real file, so the denylist must match regardless of case and never leak the secret.
    for (const p of [".env", ".ENV", ".Env"]) {
      const r = await read.execute({ path: p }, { sessionId: "s", workspacePath: tempDir });
      expect(r.success).toBe(false);
      expect(r.output).not.toContain("supersecret");
    }
  });

  it("isSensitiveWorkspacePath flags secrets/VCS internals case-insensitively", async () => {
    const { isSensitiveWorkspacePath } = await import("../tools/filesystem.js");
    for (const p of [".env", ".ENV", ".env.production", ".git/config", ".GIT/config", ".starlingai/credentials.enc", "sub/.STARLINGAI/x", "credentials.enc", ".jwt_secret"]) {
      expect(isSensitiveWorkspacePath(p)).toBe(true);
    }
    for (const p of [".env.example", "src/index.ts", "uploads/a.png", "notes.md"]) {
      expect(isSensitiveWorkspacePath(p)).toBe(false);
    }
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

  // Missing-path repair (audit 0ac7d3fc): the slow model spent ~2 minutes generating a
  // complete app, then emitted parsed args with content but NO path; failing on "path is
  // required" threw away the expensive part to protect the cheap part. The path is now
  // defaulted structurally from the content itself.
  it("defaults a missing path from substantial content instead of discarding it (audit 0ac7d3fc)", async () => {
    const { getTool } = await import("../tools/registry.js");
    const { existsSync } = await import("node:fs");
    const tool = getTool("write_file")!;
    const ctx = { sessionId: "session-defaulted-path", workspacePath: tempDir };

    const appHtml = "<!DOCTYPE html>\n<html>\n<head><style>.quiz{padding:4px}</style></head>\n<body>"
      + "<div class=\"quiz\">Frage 1</div>".repeat(20)
      + "<script>let i=0;</script></body></html>";
    const result = await tool.execute({ path: "", content: appHtml }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain("defaulted to \"index.html\"");
    expect(result.metadata).toMatchObject({ outputPath: "generated/index.html" });
    expect(existsSync(join(tempDir, "generated", "index.html"))).toBe(true);
  });

  it("does NOT default a path for mode:'append' or for small content", async () => {
    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("write_file")!;
    const ctx = { sessionId: "session-no-default", workspacePath: tempDir };

    // Append without a path: there is no way to know which file the chunk belongs to.
    const appendNoPath = await tool.execute({ path: "", content: "x".repeat(500), mode: "append" }, ctx);
    expect(appendNoPath.success).toBe(false);
    expect(appendNoPath.error).toMatch(/path is required/i);

    // Small content is not worth a guessed artifact.
    const tiny = await tool.execute({ path: "", content: "short note" }, ctx);
    expect(tiny.success).toBe(false);
    expect(tiny.error).toMatch(/path is required/i);
  });

  it("sniffs the default path from content structure (defaultWritePathForContent)", async () => {
    const { defaultWritePathForContent } = await import("../tools/filesystem.js");
    expect(defaultWritePathForContent("<!DOCTYPE html><html><body>app</body></html>")).toBe("index.html");
    expect(defaultWritePathForContent("<html lang=\"de\"><body>app</body></html>")).toBe("index.html");
    expect(defaultWritePathForContent("<svg viewBox=\"0 0 10 10\"></svg>")).toBe("image.svg");
    expect(defaultWritePathForContent("<?xml version=\"1.0\"?><root/>")).toBe("document.xml");
    expect(defaultWritePathForContent(JSON.stringify({ questions: [1, 2, 3] }))).toBe("data.json");
    expect(defaultWritePathForContent("# Lernplan\n\nKapitel 1 …")).toBe("document.md");
    expect(defaultWritePathForContent("{ not valid json")).toBe("output.txt");
    expect(defaultWritePathForContent("plain prose paragraph")).toBe("output.txt");
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

describe("write_file regeneration-churn detection (structural)", () => {
  const bigA = "A".repeat(1200);       // ≥500 bytes, identical opening across overwrites
  const bigB = "B".repeat(1200);       // a genuinely different replacement

  it("commonPrefixLength measures the shared leading run, capped at the 2 KB sample", async () => {
    const { commonPrefixLength } = await import("../tools/filesystem.js");
    expect(commonPrefixLength("hello world", "hello there")).toBe(6);   // "hello " matches
    expect(commonPrefixLength("abc", "xyz")).toBe(0);                    // diverge immediately
    expect(commonPrefixLength("Z".repeat(5000), "Z".repeat(5000))).toBe(2048); // sampled, capped
  });

  it("does NOT churn on the FIRST overwrite of a substantial file", async () => {
    const { evaluateWriteChurn } = await import("../tools/filesystem.js");
    const tracker = { count: 0 };
    const r = evaluateWriteChurn(bigA, bigA, tracker);
    expect(r.churned).toBe(false);
    expect(r.prefixPct).toBeGreaterThanOrEqual(90);
    expect(tracker.count).toBe(1);
  });

  it("churns on the SECOND near-identical overwrite (regeneration from the top)", async () => {
    const { evaluateWriteChurn } = await import("../tools/filesystem.js");
    const tracker = { count: 0 };
    evaluateWriteChurn(bigA, bigA, tracker);                 // 1st overwrite
    const r = evaluateWriteChurn(bigA, bigA, tracker);       // 2nd near-identical overwrite
    expect(r.churned).toBe(true);
    expect(tracker.count).toBe(2);
  });

  it("never churns a genuinely DIFFERENT replacement (prefix diverges early) — no false nudge", async () => {
    const { evaluateWriteChurn } = await import("../tools/filesystem.js");
    const tracker = { count: 0 };
    evaluateWriteChurn(bigA, bigB, tracker);                 // different content each time
    const r = evaluateWriteChurn(bigA, bigB, tracker);
    expect(r.churned).toBe(false);
    expect(r.prefixPct).toBeLessThan(90);
    expect(tracker.count).toBe(0);                           // divergent overwrites never count toward churn
  });

  it("never churns a small file (below the 500-byte substance floor)", async () => {
    const { evaluateWriteChurn } = await import("../tools/filesystem.js");
    const tracker = { count: 0 };
    evaluateWriteChurn("short", "short", tracker);
    const r = evaluateWriteChurn("short", "short", tracker);
    expect(r.churned).toBe(false);
    expect(tracker.count).toBe(0);
  });
});
describe("filesystem tools — sensitive-path denylist (#9)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-fs-denylist-"));

  beforeAll(async () => {
    writeFileSync(join(tempDir, ".env"), "SAI_JWT_SECRET=supersecret\nPOSTGRES_PASSWORD=hunter2\n");
    mkdirSync(join(tempDir, ".starlingai"), { recursive: true });
    writeFileSync(join(tempDir, ".starlingai", "credentials.enc"), "encrypted-blob");
    writeFileSync(join(tempDir, "notes.md"), "public notes\n");
    await import("../tools/filesystem.js");
  });

  it("read_file refuses secrets/VCS internals but allows normal files", async () => {
    const { getTool } = await import("../tools/registry.js");
    const read = getTool("read_file")!;
    const ctx = { sessionId: "s-denylist", workspacePath: tempDir };
    expect((await read.execute({ path: ".env" }, ctx)).success).toBe(false);
    expect((await read.execute({ path: ".starlingai/credentials.enc" }, ctx)).success).toBe(false);
    // Normal workspace files are unaffected.
    expect((await read.execute({ path: "notes.md" }, ctx)).success).toBe(true);
  });

  it("isSensitiveWorkspacePath classifies secrets, VCS internals, and the public template", async () => {
    const { isSensitiveWorkspacePath } = await import("../tools/filesystem.js");
    expect(isSensitiveWorkspacePath(".env")).toBe(true);
    expect(isSensitiveWorkspacePath(".env.local")).toBe(true);
    expect(isSensitiveWorkspacePath(".starlingai/credentials.enc")).toBe(true);
    expect(isSensitiveWorkspacePath(".starlingai/memory/user/x.json")).toBe(true);
    expect(isSensitiveWorkspacePath(".git/config")).toBe(true);
    expect(isSensitiveWorkspacePath(".env.example")).toBe(false); // public template
    expect(isSensitiveWorkspacePath("src/index.ts")).toBe(false);
    expect(isSensitiveWorkspacePath("workspace/agents/00-platform.jsonc")).toBe(false);
  });

  it("blocks shell commands and scripts that target protected workspace paths", async () => {
    await import("../tools/shell.js");
    const { getTool } = await import("../tools/registry.js");
    const ctx = { sessionId: "s-shell-denylist", workspacePath: tempDir };
    const shell = getTool("shell_exec")!;
    const script = getTool("run_script")!;

    const commandResult = await shell.execute({ command: "cat /workspace/.env" }, ctx);
    expect(commandResult.success).toBe(false);
    expect(commandResult.error).toMatch(/protected workspace data/i);

    const scriptResult = await script.execute({ path: ".env" }, ctx);
    expect(scriptResult.success).toBe(false);
    expect(scriptResult.error).toMatch(/protected workspace data/i);
  });

  it("blocks the ./ and archive-a-directory forms that the raw-regex guard missed", async () => {
    await import("../tools/shell.js");
    const { getTool } = await import("../tools/registry.js");
    const ctx = { sessionId: "s-shell-denylist-2", workspacePath: tempDir };
    const shell = getTool("shell_exec")!;
    const script = getTool("run_script")!;

    for (const command of ["cat ./.env", "cat .env|base64", "tar czf x.tgz .git", "cp -r .starlingai /tmp/x"]) {
      const result = await shell.execute({ command }, ctx);
      expect(result.success, `expected "${command}" to be blocked`).toBe(false);
      expect(result.error).toMatch(/protected workspace data/i);
      // The error names the offending path, not a raw regex source.
      expect(result.error).not.toMatch(/\?:|\\s|\[\\s/);
    }

    // A protected path passed as a script argument is rejected too.
    const argResult = await script.execute({ path: "run.sh", args: ["/workspace/.env"] }, ctx);
    expect(argResult.success).toBe(false);
    expect(argResult.error).toMatch(/protected workspace data/i);
  });

  it("allows the public .env.example template through the shell guard", async () => {
    await import("../tools/shell.js");
    const { getTool } = await import("../tools/registry.js");
    const ctx = { sessionId: "s-shell-allowlist", workspacePath: tempDir };
    const shell = getTool("shell_exec")!;
    // .env.example is not protected; the guard must not false-positive on it.
    // (The command itself will fail in the sandbox, but not on the guard.)
    const result = await shell.execute({ command: "cat .env.example" }, ctx);
    if (!result.success) {
      expect(result.error).not.toMatch(/protected workspace data/i);
    }
  });
});
