import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runWithRequestContext } from "../runtime/request-context.js";

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

  it("read_file on a missing file says that creating it is not changing it, on a line of its own", async () => {
    // E2E guards: the coder was told to change a file and not to create one. read_file said
    // "File not found", and the coder created the file with write_file anyway.
    const { getTool } = await import("../tools/registry.js");
    const { MISSING_FILE_IS_NOT_A_CHANGE } = await import("../tools/filesystem.js");
    const r = await getTool("read_file")!.execute(
      { path: "generated/e2e-guards/sommeraktion.html" },
      { sessionId: "session-read-missing", workspacePath: tempDir },
    );
    expect(r.success).toBe(false);
    // The first line, which audit rows and failure lists keep, is what it always was.
    expect(r.error).toBe(`File not found: generated/e2e-guards/sommeraktion.html\n${MISSING_FILE_IS_NOT_A_CHANGE}`);
    expect(MISSING_FILE_IS_NOT_A_CHANGE).not.toContain("\n");
    expect(MISSING_FILE_IS_NOT_A_CHANGE).toMatch(/report it as missing instead of creating it/);
  });

  it("edit_file on a missing file says the same, so the direct path to a change carries it too", async () => {
    // edit_file is the tool for changing a file. A coder told to change a missing file that goes
    // to it first, rather than to read_file, meets the missing file there.
    const { getTool } = await import("../tools/registry.js");
    const { MISSING_FILE_IS_NOT_A_CHANGE } = await import("../tools/filesystem.js");
    const r = await getTool("edit_file")!.execute(
      { path: "generated/e2e-guards/sommeraktion.html", old_string: "20 %", new_string: "25 %" },
      { sessionId: "session-edit-missing", workspacePath: tempDir },
    );
    expect(r.success).toBe(false);
    // The first line, which audit rows and failure lists keep, is what it always was.
    expect(r.error).toBe(`File not found: generated/e2e-guards/sommeraktion.html\n${MISSING_FILE_IS_NOT_A_CHANGE}`);
    expect(existsSync(join(tempDir, "generated/e2e-guards/sommeraktion.html"))).toBe(false);
  });

  it("write_file asks once before it creates a file its run found missing", async () => {
    // E2E guards, 2026-10-23: qa_guard read the file it was to change, got the line above, and
    // created the file with its next write.
    const { getTool } = await import("../tools/registry.js");
    const path = "generated/e2e-guards/sommeraktion.html";
    const target = join(tempDir, path);
    const run = { sessionId: "sub:root-missing:qa_guard:1", workspacePath: tempDir };
    const content = "<h1>Sommeraktion 2026</h1>";
    expect((await getTool("read_file")!.execute({ path }, run)).success).toBe(false);

    const first = await getTool("write_file")!.execute({ path, content, mode: "create" }, run);
    expect(first.success).toBe(false);
    expect(first.error).toMatch(/^Not written: generated\/e2e-guards\/sommeraktion\.html did not exist when this run read it\./);
    expect(first.error).toMatch(/If your task is to create it, call write_file again\.$/);
    expect(existsSync(target)).toBe(false);

    // Asked once: the run that means to create it does so with its next call.
    const second = await getTool("write_file")!.execute({ path, content, mode: "create" }, run);
    expect(second.success).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(content);
  });

  it("asks only the run that found the file missing, and after edit_file too", async () => {
    const { getTool } = await import("../tools/registry.js");
    const path = "generated/e2e-guards/neu.html";
    const content = "<p>neu</p>";
    // Another run that never looked writes it straight away.
    const other = { sessionId: "sub:root-other:web_coder:1", workspacePath: tempDir };
    const edited = { sessionId: "sub:root-edit:coder:1", workspacePath: tempDir };
    expect((await getTool("edit_file")!.execute({ path, old_string: "a", new_string: "b" }, edited)).success).toBe(false);
    expect((await getTool("write_file")!.execute({ path, content }, other)).success).toBe(true);
    rmSync(join(tempDir, path));
    // The run whose edit_file found it missing is asked, in every write mode.
    const asked = await getTool("write_file")!.execute({ path, content, mode: "append" }, edited);
    expect(asked.error).toMatch(/^Not written: /);
    // A file that exists by the time of the write is no longer the missing file: nothing to ask.
    const again = { sessionId: "sub:root-exists:coder:1", workspacePath: tempDir };
    expect((await getTool("read_file")!.execute({ path }, again)).success).toBe(false);
    writeFileSync(join(tempDir, path), "<p>alt</p>");
    expect((await getTool("write_file")!.execute({ path, content }, again)).success).toBe(true);
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
      // The path it acted on, as outputPath: not the one it was given.
      path: "generated/reports/recorder.md",
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

  // The denylist also covers `*.env` files at any depth (prod.env), and a runtime's env accessor
  // ends the same way — so a coder's everyday `node -e "…process.env…"` was refused as a secret read.
  it("lets runtime env accessors through but still blocks *.env files", async () => {
    await import("../tools/shell.js");
    const { getTool } = await import("../tools/registry.js");
    const ctx = { sessionId: "s-shell-env-accessor", workspacePath: tempDir };
    const shell = getTool("shell_exec")!;

    for (const command of ['node -e "void process.env"', "grep -rn import.meta.env src", "grep -rn Deno.env ."]) {
      const result = await shell.execute({ command }, ctx);
      if (!result.success) {
        expect(result.error, `"${command}" hit the guard`).not.toMatch(/protected workspace data/i);
      }
    }
    for (const command of ["cat prod.env", "cat config/process.env", "cp docker/staging.env /tmp/x"]) {
      const result = await shell.execute({ command }, ctx);
      expect(result.success, `expected "${command}" to be blocked`).toBe(false);
      expect(result.error).toMatch(/protected workspace data/i);
    }
  });
});

/**
 * A deck with inlined photos is a text file of several megabytes (run c297c5ea: 3.9 MB). read_file and
 * edit_file refused anything over 1 MB, so the agent that built the deck could neither check nor fix it.
 */
describe("read_file and edit_file on a generated file of several megabytes", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-fs-big-"));
  const photo = `<img src="data:image/jpeg;base64,${"QUJD".repeat(750_000)}">`;   // one 3 MB line

  beforeAll(async () => {
    mkdirSync(join(tempDir, "generated", "deck"), { recursive: true });
    writeFileSync(join(tempDir, "generated", "deck", "index.html"),
      ["<!DOCTYPE html>", `  ${photo}`, "<script>Reveal.initialize({ hash: true });</script>", ""].join("\n"));
    await import("../tools/filesystem.js");
  });

  const ctx = { sessionId: "s", workspacePath: tempDir };

  it("reads a window of it with the long line clipped", async () => {
    const { getTool } = await import("../tools/registry.js");
    const r = await getTool("read_file")!.execute({ path: "generated/deck/index.html", offset: 1, limit: 3 }, ctx);
    expect(r.success).toBe(true);
    const out = String(r.output);
    expect(out).toContain("3\t<script>Reveal.initialize({ hash: true });</script>");
    expect(out).toMatch(/2\t {2}<img src="data:image\/jpeg;base64,QUJD.*\[\d+ chars not shown\]/);
    expect(out.length).toBeLessThan(3_000);
  });

  it("reads it unwindowed as head and tail", async () => {
    const { getTool } = await import("../tools/registry.js");
    const r = await getTool("read_file")!.execute({ path: "generated/deck/index.html" }, ctx);
    expect(r.success).toBe(true);
    expect(r.metadata?.["truncated"]).toBe(true);
    expect(String(r.output).length).toBeLessThan(20_000);
  });

  it("edits it", async () => {
    const { getTool } = await import("../tools/registry.js");
    const r = await getTool("edit_file")!.execute(
      { path: "deck/index.html", old_string: "hash: true", new_string: "hash: true, slideNumber: true" }, ctx);
    expect(r.success).toBe(true);
    const back = await getTool("read_file")!.execute({ path: "generated/deck/index.html", offset: 3, limit: 1 }, ctx);
    expect(String(back.output)).toContain("slideNumber: true");
  });
});

/**
 * A NAME THAT IS ON DISK IS THAT FILE (review 2026-10-12).
 *
 * The resolvers take a path that repeats the root (`users/<segment>/x.html`) as the root itself. Turns
 * before that rule left files under such a name, and list_files shows them there: dropping the repeat
 * from that name too made read_file, edit_file and delete_file act on generated/x.html instead, and the
 * delete then reported the name it was given.
 */
describe("file tools on a name under a repeated root", () => {
  const SEGMENT = "eval-19e81d52fcab8153";
  const LEGACY = `generated/users/${SEGMENT}`;
  let account = "";
  const ctx = () => ({ sessionId: "s-repeated-root", workspacePath: account });
  const scoped = <T,>(fn: () => Promise<T>): Promise<T> => runWithRequestContext({ workspaceScope: "generated" }, fn);
  const tool = async (name: string) => (await import("../tools/registry.js")).getTool(name)!;
  const text = (rel: string) => readFileSync(join(account, rel), "utf8");

  beforeAll(async () => { await import("../tools/filesystem.js"); });
  beforeEach(() => {
    account = join(mkdtempSync(join(tmpdir(), "starlingai-fs-repeated-root-")), "users", SEGMENT);
    mkdirSync(join(account, LEGACY), { recursive: true });
    writeFileSync(join(account, LEGACY, "old.html"), "stale", "utf8");
    writeFileSync(join(account, "generated", "old.html"), "current", "utf8");
    writeFileSync(join(account, "generated", "only-current.txt"), "x", "utf8");
  });
  afterEach(() => { rmSync(join(account, "..", ".."), { recursive: true, force: true }); });

  it("read_file reads the file it names", async () => {
    const r = await scoped(async () => (await tool("read_file")).execute({ path: `${LEGACY}/old.html` }, ctx()));
    expect(String(r.output)).toContain("stale");
    expect(String(r.output)).not.toContain("current");
  });

  it("edit_file and write_file change the file they name, and leave the other alone", async () => {
    const edit = await scoped(async () => (await tool("edit_file")).execute(
      { path: `${LEGACY}/old.html`, old_string: "stale", new_string: "edited" }, ctx()));
    expect(edit.success).toBe(true);
    expect(text(`${LEGACY}/old.html`)).toBe("edited");
    const write = await scoped(async () => (await tool("write_file")).execute(
      { path: `users/${SEGMENT}/old.html`, content: "rewritten" }, ctx()));
    expect(write.success).toBe(true);
    expect(text(`${LEGACY}/old.html`)).toBe("rewritten");
    expect(text("generated/old.html")).toBe("current");
  });

  it("delete_file deletes the file it names, and says which", async () => {
    const r = await scoped(async () => (await tool("delete_file")).execute({ path: `${LEGACY}/old.html` }, ctx()));
    expect(r.success).toBe(true);
    expect(existsSync(join(account, LEGACY, "old.html"))).toBe(false);
    expect(text("generated/old.html")).toBe("current");
    expect(r.output).toBe(`File deleted: ${LEGACY}/old.html`);
  });

  it("list_files lists the directory it names", async () => {
    const r = await scoped(async () => (await tool("list_files")).execute({ path: LEGACY }, ctx()));
    expect(String(r.output)).toContain("old.html");
    expect(String(r.output)).not.toContain("only-current");
  });

  it("a name that is not there yet still lands where the plain name goes", async () => {
    const r = await scoped(async () => (await tool("write_file")).execute({ path: `users/${SEGMENT}/new.html`, content: "new" }, ctx()));
    expect(r.output).toBe("File written: generated/new.html (3 chars)");
    expect(text("generated/new.html")).toBe("new");
  });

  it("delete_file, edit_file, create_dir and write_file report the path they acted on, not the one they were given", async () => {
    const edit = await scoped(async () => (await tool("edit_file")).execute({ path: "old.html", old_string: "current", new_string: "edited" }, ctx()));
    expect(edit.output).toBe("File edited: generated/old.html (1 replacement).");
    expect(edit.metadata?.["path"]).toBe("generated/old.html");
    const dir = await scoped(async () => (await tool("create_dir")).execute({ path: "assets" }, ctx()));
    expect(dir.output).toBe("Directory created: generated/assets");
    expect(dir.metadata?.["path"]).toBe("generated/assets");
    const write = await scoped(async () => (await tool("write_file")).execute({ path: "notes.md", content: "n" }, ctx()));
    expect(write.metadata?.["path"]).toBe("generated/notes.md");
    const removed = await scoped(async () => (await tool("delete_file")).execute({ path: "old.html" }, ctx()));
    expect(removed.output).toBe("File deleted: generated/old.html");
    expect(removed.metadata?.["path"]).toBe("generated/old.html");
  });
});

describe("file tools at a shared root named workspace", () => {
  // Auth off: the root is the shared one, whose own name is a plain word that can name a file or a
  // directory in it as well (review 2026-10-12).
  let root = "";
  const ctx = () => ({ sessionId: "s-shared-root", workspacePath: root });
  const write = async (path: string, content: string) =>
    (await import("../tools/registry.js")).getTool("write_file")!.execute({ path, content }, ctx());

  beforeAll(async () => { await import("../tools/filesystem.js"); });
  beforeEach(() => {
    root = join(mkdtempSync(join(tmpdir(), "starlingai-fs-shared-root-")), "workspace");
    mkdirSync(root, { recursive: true });
  });
  afterEach(() => { rmSync(join(root, ".."), { recursive: true, force: true }); });

  it("keeps workspace/index.html and index.html two files", async () => {
    expect((await write("workspace/index.html", "nested")).success).toBe(true);
    expect((await write("index.html", "top")).success).toBe(true);
    expect((await write("generated/workspace/app.js", "nested js")).success).toBe(true);
    expect((await write("generated/app.js", "top js")).success).toBe(true);
    expect(readFileSync(join(root, "generated", "workspace", "index.html"), "utf8")).toBe("nested");
    expect(readFileSync(join(root, "generated", "index.html"), "utf8")).toBe("top");
    expect(readFileSync(join(root, "generated", "workspace", "app.js"), "utf8")).toBe("nested js");
    expect(readFileSync(join(root, "generated", "app.js"), "utf8")).toBe("top js");
  });

  it("writes a Bazel WORKSPACE file as a file", async () => {
    const r = await write("WORKSPACE", "workspace(name = \"demo\")\n");
    expect(r.success).toBe(true);
    expect(readFileSync(join(root, "generated", "WORKSPACE"), "utf8")).toBe("workspace(name = \"demo\")\n");
  });
});
