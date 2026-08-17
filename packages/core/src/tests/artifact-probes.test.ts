import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkStructuralCompleteness, findLocalAssetRefs, probeArtifacts, probeHtmlStructure } from "../agent/artifact-probes.js";

// Temp workspace, not process.cwd(): vitest runs from packages/core, so rooting
// the fixtures at cwd/tmp wrote into the source tree — and the old afterAll only
// removed the probe-fixtures child, leaving an empty packages/core/tmp/ behind
// after every run. probeArtifacts resolves each `location` against
// `workspacePath`, so the workspace and the fixture dir have to move together.
const WORKSPACE = mkdtempSync(join(tmpdir(), "sai-probe-ws-"));
const ROOT = join(WORKSPACE, "probe-fixtures");

/**
 * The two halves of the measured failure (session a7b8fe3e), as files:
 *
 *   staged-build-dead.html     what shipped — a staged skeleton whose JS slots were
 *                              never filled. Well-formed, balanced, and dead.
 *   staged-build-inlined.html  the same deliverable finished, carrying every
 *                              legitimate construct the rule must not fire on.
 */
// Newlines normalised: whether these check out CRLF or LF is a git setting, and the
// assertions below are about content, not about which line ending the clone happens to
// have. (The probe itself is agnostic — it trims every line before reading it.)
const readFixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const DEAD_BUNDLE = readFixture("staged-build-dead.html");
const INLINED_BUNDLE = readFixture("staged-build-inlined.html");

// File-scoped, not per-describe: the fixtures are shared by both suites below, and an
// afterAll nested in the first one deleted the workspace before the second ever ran.
beforeAll(async () => {
  await mkdir(ROOT, { recursive: true });
  await writeFile(resolve(ROOT, "valid.json"), JSON.stringify({ ok: true, items: [1, 2, 3] }));
  await writeFile(resolve(ROOT, "broken.json"), '{"ok": true, "items": [1, 2'); // truncated
  await writeFile(resolve(ROOT, "valid.html"), "<html><body><script>const x = 1;</script><p>hi</p></body></html>");
  await writeFile(resolve(ROOT, "truncated.html"), "<html><body><script>const data = [1,2,3"); // mid-write cut
  await writeFile(resolve(ROOT, "empty.txt"), "");
  await writeFile(resolve(ROOT, "staged-build-dead.html"), DEAD_BUNDLE);
  await writeFile(resolve(ROOT, "staged-build-inlined.html"), INLINED_BUNDLE);
  await writeFile(resolve(ROOT, "linked.html"), '<html><head><link rel="stylesheet" href="styles.css"></head><body><h1>Hi</h1><script src="./game.js"></script></body></html>');
});
afterAll(async () => {
  await rm(WORKSPACE, { recursive: true, force: true });
});

describe("deterministic artifact probes (QA-304)", () => {
  it("passes valid JSON and HTML with hash receipts", async () => {
    const report = await probeArtifacts(
      [{ kind: "file", location: "probe-fixtures/valid.json" }, { kind: "file", location: "probe-fixtures/valid.html" }],
      { workspacePath: WORKSPACE },
    );
    expect(report.status).toBe("pass");
    expect(report.receipts.every((r) => r.status === "pass")).toBe(true);
    expect(report.receipts.some((r) => r.probe === "json_parse")).toBe(true);
    expect(report.receipts.some((r) => r.probe === "html_structure")).toBe(true);
    expect(report.receipts.every((r) => !r.contentHash || /^[0-9a-f]{16}$/.test(r.contentHash))).toBe(true);
  });

  it("fails truncated JSON with a parse receipt", async () => {
    const report = await probeArtifacts([{ kind: "file", location: "probe-fixtures/broken.json" }], { workspacePath: WORKSPACE });
    expect(report.status).toBe("fail");
    expect(report.receipts.find((r) => r.probe === "json_parse")?.status).toBe("fail");
  });

  it("fails HTML that ends mid-write (unclosed script) — the classic truncated build", async () => {
    const report = await probeArtifacts([{ kind: "file", location: "probe-fixtures/truncated.html" }], { workspacePath: WORKSPACE });
    expect(report.status).toBe("fail");
    const receipt = report.receipts.find((r) => r.probe === "html_structure");
    expect(receipt?.status).toBe("fail");
    expect(receipt?.detail).toMatch(/unclosed|mid-tag/);
  });

  it("fails zero-byte and missing files", async () => {
    const report = await probeArtifacts(
      [{ kind: "file", location: "probe-fixtures/empty.txt" }, { kind: "file", location: "probe-fixtures/nope.bin" }],
      { workspacePath: WORKSPACE },
    );
    expect(report.status).toBe("fail");
    expect(report.receipts.filter((r) => r.status === "fail")).toHaveLength(2);
  });

  it("fails a dead served URL", async () => {
    const report = await probeArtifacts([{ kind: "url", location: "http://127.0.0.1:59999/api/app/dead/" }], { workspacePath: WORKSPACE });
    expect(report.status).toBe("fail");
    expect(report.receipts[0]?.probe).toBe("served_health");
  }, 15_000);

  it("html structure heuristics stand alone", () => {
    expect(probeHtmlStructure("<html><body></body></html>").ok).toBe(true);
    expect(probeHtmlStructure("<html><body>").ok).toBe(false);
    expect(probeHtmlStructure("text <div").ok).toBe(false);
    expect(probeHtmlStructure("").ok).toBe(false);
  });

  it("no artifacts → not_applicable", async () => {
    expect((await probeArtifacts([], { workspacePath: WORKSPACE })).status).toBe("not_applicable");
  });
});

describe("structural completeness — the unfilled-placeholder failure", () => {
  it("hard-fails the delivered skeleton whose JS slots were never filled", async () => {
    const report = await probeArtifacts([{ kind: "file", location: "probe-fixtures/staged-build-dead.html" }], { workspacePath: WORKSPACE });

    expect(report.status).toBe("fail");
    const completeness = report.receipts.find((r) => r.probe === "completeness");
    expect(completeness?.status).toBe("fail");
    expect(completeness?.severity).not.toBe("soft"); // hard, so it can actually fail the report
    expect(completeness?.detail).toContain("JS_PART1");

    // The point of the fixture: every probe that existed BEFORE this check still passes
    // on it. `exists` + `html_structure` are the two probes that made the real run
    // report artifactProbeStatus "pass" / artifactProbeCount 2 over a dead file.
    expect(report.receipts.find((r) => r.probe === "exists")?.status).toBe("pass");
    expect(report.receipts.find((r) => r.probe === "html_structure")?.status).toBe("pass");
  });

  it("passes the finished bundle, including the constructs that look like markers", async () => {
    // Guard the guard: if a later edit strips these out of the fixture, the pass below
    // stops proving anything about false positives.
    expect(INLINED_BUNDLE).toContain("Roadmap: TODO");                  // prose in visible text
    expect(INLINED_BUNDLE).toContain("// TODO\n");                      // bare marker inside a <pre> code sample
    expect(INLINED_BUNDLE).toContain("/* PLACEHOLDER */");               // ditto, block form
    expect(INLINED_BUNDLE).toContain("/* ===== PART 2: INPUT ===== */"); // screaming-case section banner
    expect(INLINED_BUNDLE).toContain("/* PARTICLES */");                 // single caps token, not a stub word
    expect(INLINED_BUNDLE).toContain("// TODO: throttle");               // a real annotation, with prose
    expect(INLINED_BUNDLE).toContain("HIGH_SCORE_TODO_KEY");             // compound identifier carrying a stub word

    const report = await probeArtifacts([{ kind: "file", location: "probe-fixtures/staged-build-inlined.html" }], { workspacePath: WORKSPACE });
    expect(report.status).toBe("pass");
    expect(report.receipts.find((r) => r.probe === "completeness")?.status).toBe("pass");
  });

  it("catches the marker shapes without a table of this run's exact strings", () => {
    const wrap = (inner: string) => `<html><body><div id="app"></div><script>\n${inner}\n</script></body></html>`;
    for (const inner of [
      "/* JS_PART1 */",             // the observed shape
      "/* CSS_STUB */",
      "/* PLACEHOLDER */",
      "// SECTION_TBD",
      "/* BEGIN GAME_PART2 */",     // marker plus a delimiter word: caught because the block is dead
      "<!-- FIXME -->",
    ]) {
      expect(checkStructuralCompleteness("bundle.html", wrap(inner))?.status, inner).toBe("fail");
    }
    // A dead file with no markup wrapper at all — the whole file is the block.
    expect(checkStructuralCompleteness("game.js", "/* JS_PART2 */\n")?.status).toBe("fail");
  });

  it("does not fire on prose, annotations, banners, or near-miss identifiers", () => {
    const live = (inner: string) => `<html><body><script>\n${inner}\nconst score = 0;\nrender(score);\n</script></body></html>`;
    for (const inner of [
      "// TODO: handle the resize when the canvas is detached",  // annotation, carries prose
      "/* ===== PART 2: RENDERING ===== */",                     // banner, several tokens
      "/* PARTICLES */",                                          // stub word only as a prefix
      "// see MAX_TODO_ITEMS for the cap",                        // identifier inside a sentence
      '// docs at https://example.invalid/TODO',                  // a URL, not a marker
    ]) {
      expect(checkStructuralCompleteness("bundle.html", live(inner))?.status, inner).toBe("pass");
    }
    // A <pre> code sample is not a comment: outside script/style, `//` and `/* */` are text.
    expect(checkStructuralCompleteness("page.html", "<html><body><pre>\n// TODO\n/* STUB */\n</pre></body></html>")?.status).toBe("pass");
    // A <script src> element legitimately has an empty body.
    expect(checkStructuralCompleteness("page.html", '<html><body><script src="app.js"></script></body></html>')?.status).toBe("pass");
    // Prose formats are out of scope — a stub word there is content, not a hole.
    expect(checkStructuralCompleteness("notes.md", "# Plan\n\n// TODO\n")).toBeNull();
  });

  it("reports a page that still links its own css/js — soft, so it never costs a rebuild", async () => {
    const report = await probeArtifacts([{ kind: "file", location: "probe-fixtures/linked.html" }], { workspacePath: WORKSPACE });
    const selfContained = report.receipts.find((r) => r.probe === "self_contained");
    expect(selfContained?.status).toBe("fail");
    expect(selfContained?.severity).toBe("soft");
    expect(selfContained?.detail).toContain("styles.css");
    // Soft — a multi-file site is a legitimate deliverable and the probe cannot see the
    // request, so the report as a whole must still pass.
    expect(report.status).toBe("pass");

    expect(findLocalAssetRefs('<script src="https://cdn.invalid/lib.js"></script><link href="//cdn.invalid/a.css">')).toEqual([]);
    expect(findLocalAssetRefs('<link rel="icon" href="favicon.ico">')).toEqual([]);
  });
});
