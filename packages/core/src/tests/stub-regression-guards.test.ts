import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * THE THREE MECHANICAL GUARDS AROUND A STAGED BUILD'S UNFINISHED MARKERS.
 *
 * Run 2dc5832c failed three separate ways around one token, and each of these is one of them:
 *
 *  1. write_file overwrote a file in which six of eight subsystems had just been filled with a
 *     fresh skeleton carrying all eight markers again — thirteen iterations of work destroyed by
 *     one call, and nothing objected.
 *  2. The artifact probe reported `artifactProbeStatus: "pass"` on the delivered file, because it
 *     inspects COMMENT BODIES and the marker the directive asks for is a `throw` — executable
 *     code, by design, so a half-built file fails loudly rather than looking finished.
 *  3. The staged-build classifier reads task size and tool capability only, so a "finish the
 *     existing file" delegation received the "start with a skeleton" directive. All four runs in
 *     that session logged directiveInjected: true.
 *
 * Each test below fails if its guard is reverted.
 */

const MARKER = "UNFINISHED_STUB";

describe("write_file refuses to replace finished work with placeholders", () => {
  it("blocks an overwrite that RAISES the unfilled-marker count", async () => {
    const { evaluateStubRegression } = await import("../tools/filesystem.js");

    // The measured shape: six subsystems filled, replacement re-stubs all eight.
    const filled = `<script>${MARKER}: input\nconst real = 1;\n</script>`;
    const skeleton = Array.from({ length: 8 }, (_, i) => `throw new Error("${MARKER}: s${i}")`).join("\n");

    const regression = evaluateStubRegression(filled, skeleton);
    expect(regression.regressed).toBe(true);
    expect(regression.existingStubs).toBe(1);
    expect(regression.newStubs).toBe(8);
  });

  it("ALLOWS progress and allows an equal re-skeleton — only a rise is loss", () => {
    // THE DISCRIMINATOR. A guard that fires on any overwrite of a file containing markers would
    // block edit-shaped progress and the legitimate first write, which is worse than the bug.
    return import("../tools/filesystem.js").then(({ evaluateStubRegression }) => {
      const eight = Array.from({ length: 8 }, (_, i) => `${MARKER}: s${i}`).join("\n");
      const two = `${MARKER}: a\n${MARKER}: b`;
      const none = "const done = true;";

      expect(evaluateStubRegression(eight, two).regressed).toBe(false);   // filling in
      expect(evaluateStubRegression(eight, eight).regressed).toBe(false); // no loss
      expect(evaluateStubRegression(eight, none).regressed).toBe(false);  // finished
      expect(evaluateStubRegression(none, two).regressed).toBe(true);     // finished → stubbed
    });
  });

  it("the real write_file tool rejects the call and names edit_file", async () => {
    // WIRING, not arithmetic: the pure function above proves nothing about whether write_file
    // consults it. This drives the registered tool against a real workspace file.
    const dir = mkdtempSync(join(tmpdir(), "sai-stub-guard-"));
    try {
      // write_file ROOTS agent writes under generated/ (resolveWorkspaceWritePath), so the
      // existing file has to sit where the tool will actually land — putting it at the
      // workspace root makes fileExists false and silently skips the guard under test.
      mkdirSync(join(dir, "generated"), { recursive: true });
      const target = join(dir, "generated", "index.html");
      writeFileSync(target, `<script>\nconst core = 1;\nthrow new Error("${MARKER}: loop");\n</script>`, "utf8");

      const { getTool } = await import("../tools/registry.js");
      const writeFile = getTool("write_file");
      expect(writeFile, "write_file must be registered").toBeTruthy();

      const result = await writeFile!.execute(
        {
          path: "index.html",
          content: Array.from({ length: 5 }, (_, i) => `throw new Error("${MARKER}: s${i}")`).join("\n"),
        },
        { workspacePath: dir, sessionId: "stub-guard-test" } as never,
      );

      expect(result.success).toBe(false);
      expect(String(result.error)).toContain("edit_file");
      expect(String(result.error)).toContain(MARKER);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the artifact probe fails a file that still carries the marker", () => {
  it("catches the marker in EXECUTABLE code, not only in comments", async () => {
    const { checkStructuralCompleteness } = await import("../agent/artifact-probes.js");

    // Byte-for-byte the shape that shipped and was reported as a pass.
    const shipped = `<!DOCTYPE html><html><body><script>\n"use strict";\nthrow new Error("${MARKER}: core");\n</script></body></html>`;
    const verdict = checkStructuralCompleteness("generated/tetris25d/index.html", shipped);

    expect(verdict?.status).toBe("fail");
    expect(String(verdict?.detail)).toContain(MARKER);
  });

  it("catches it in a .css too, where an unfilled marker is SILENT", async () => {
    // A CSS stub does not throw: the page loads unstyled and merely looks poor, so this is the
    // case that most needs a mechanical checker rather than a human noticing.
    const { checkStructuralCompleteness } = await import("../agent/artifact-probes.js");
    const verdict = checkStructuralCompleteness("generated/app/styles.css", `.a{color:red}\n/* ${MARKER}: styles */`);
    expect(verdict?.status).toBe("fail");
  });

  it("still passes a finished artifact", async () => {
    const { checkStructuralCompleteness } = await import("../agent/artifact-probes.js");
    const done = `<!DOCTYPE html><html><body><script>const game = 1;</script></body></html>`;
    expect(checkStructuralCompleteness("generated/app/index.html", done)?.status).toBe("pass");
  });
});

describe("resume detection reads the workspace, not the task text", () => {
  afterEach(() => { vi.resetModules(); });

  it("finds unfilled markers on disk and names the files", async () => {
    const { findUnfilledStubFiles } = await import("../agent/sub-agent.js");
    const dir = mkdtempSync(join(tmpdir(), "sai-resume-scan-"));
    try {
      mkdirSync(join(dir, "generated", "game"), { recursive: true });
      writeFileSync(join(dir, "generated", "game", "index.html"), `throw new Error("${MARKER}: core");\nthrow new Error("${MARKER}: loop");`, "utf8");
      writeFileSync(join(dir, "generated", "game", "done.js"), "const finished = true;", "utf8");

      const found = findUnfilledStubFiles(dir);
      expect(found.count).toBe(2);
      expect(found.files.join(",")).toContain("index.html");
      expect(found.files.join(",")).not.toContain("done.js");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("IGNORES the marker where it is documentation, not evidence", async () => {
    // THE db88fa5b REGRESSION. Four agent systemPrompts in workspace/agents/10-core-agents.jsonc
    // TEACH the staged-build convention and therefore contain the literal token. The first
    // version of this scan walked the whole workspace, found them, and reported
    // `mode: "resume", unfilledMarkers: 13` on a brand-new "build me a Tetris game" request —
    // telling a fresh build "RESUME AN EXISTING BUILD … NEVER call write_file". On every run,
    // forever. Scope is the entire correctness of this function: the token is evidence of an
    // unfinished build only where builds are written.
    const { findUnfilledStubFiles } = await import("../agent/sub-agent.js");
    const dir = mkdtempSync(join(tmpdir(), "sai-resume-scope-"));
    try {
      mkdirSync(join(dir, "agents"), { recursive: true });
      writeFileSync(
        join(dir, "agents", "10-core-agents.jsonc"),
        `{"subAgents":{"web_coder":{"systemPrompt":"... write each section as one line carrying the exact token ${MARKER} and its name ..."}}}`,
        "utf8",
      );
      writeFileSync(join(dir, "README.md"), `We mark unbuilt parts with ${MARKER}.`, "utf8");

      expect(findUnfilledStubFiles(dir).count, "config prose must not read as a resume").toBe(0);

      // ...and a real unfinished artifact in the output zone still does.
      mkdirSync(join(dir, "generated", "game"), { recursive: true });
      writeFileSync(join(dir, "generated", "game", "app.js"), `throw new Error("${MARKER}: loop");`, "utf8");
      const found = findUnfilledStubFiles(dir);
      expect(found.count).toBe(1);
      expect(found.files.join(",")).toContain("app.js");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports NOTHING for a clean workspace — a fresh build must stay fresh", async () => {
    const { findUnfilledStubFiles } = await import("../agent/sub-agent.js");
    const dir = mkdtempSync(join(tmpdir(), "sai-resume-clean-"));
    try {
      writeFileSync(join(dir, "notes.md"), "nothing staged here", "utf8");
      expect(findUnfilledStubFiles(dir).count).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the RESUME directive forbids write_file; the FRESH one demands it", async () => {
    const { buildStagedBuildResumeGuidance, buildStagedArtifactBuildGuidance } =
      await import("../agent/sub-agent-prompt-guidance.js");

    const resume = buildStagedBuildResumeGuidance(["generated/game/index.html"], 6);
    const fresh = buildStagedArtifactBuildGuidance(14, 6);

    // The two directives must say OPPOSITE things about write_file — that opposition is the
    // entire fix. Run 2dc5832c handed a resume task the fresh text and lost six subsystems.
    expect(resume).toContain("NEVER call write_file");
    expect(resume).toContain("RESUME AN EXISTING BUILD");
    expect(resume).toContain("6");
    expect(fresh).toContain("SKELETON (first tool call)");
    expect(fresh).not.toContain("NEVER call write_file");
  });
});

describe("a missed stub edit names the markers that are actually left", () => {
  // Importing the module is what registers its tools; getTool() is empty without it.
  beforeAll(async () => { await import("../tools/filesystem.js"); });

  it("lists the remaining markers when old_string targets an already-filled one", async () => {
    // Run 5, iteration 10: the model aimed edit_file at `UNFINISHED_STUB: scoring`, which an
    // earlier iteration had already filled. All it got back was "old_string not found in
    // file", so it spent iteration 11 on grep_files and iteration 12 on read_file
    // rediscovering the four markers the file could have named immediately — three of a
    // fourteen-iteration budget burned on a question the file already answered.
    const { getTool } = await import("../tools/registry.js");
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-stubmiss-"));
    try {
      mkdirSync(join(tempDir, "generated"), { recursive: true });
      writeFileSync(join(tempDir, "generated", "index.html"), [
        "<script>",
        "function scoring() { return 42; }",           // already filled
        `/* ${MARKER}: panels */`,
        `/* ${MARKER}: input */`,
        `throw new Error('${MARKER}: boot');`,
        "</script>",
      ].join("\n"), "utf8");

      const edit = getTool("edit_file")!;
      const result = await edit.execute(
        { path: "index.html", old_string: `/* ${MARKER}: scoring */`, new_string: "x" },
        { sessionId: "s", workspacePath: tempDir },
      );

      expect(result.success).toBe(false);
      // The three markers that ARE there must be named, so the next call can land directly.
      expect(result.error).toContain("panels");
      expect(result.error).toContain("input");
      expect(result.error).toContain("boot");
      // …and not the one it wrongly aimed at, which is already gone.
      expect(result.error).not.toContain("scoring");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("says so plainly when every marker is already filled", async () => {
    // The other half of losing track: the build is finished and the model tries one more
    // fill. "not found" reads as a mistake to correct; it needs to hear that it is done.
    const { getTool } = await import("../tools/registry.js");
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-stubdone-"));
    try {
      mkdirSync(join(tempDir, "generated"), { recursive: true });
      writeFileSync(join(tempDir, "generated", "index.html"), "<script>function boot(){}</script>", "utf8");
      const edit = getTool("edit_file")!;
      const result = await edit.execute(
        { path: "index.html", old_string: `throw new Error('${MARKER}: boot');`, new_string: "x" },
        { sessionId: "s", workspacePath: tempDir },
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("No " + MARKER + " markers remain");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("leaves an ordinary miss alone — no marker noise on a normal edit", async () => {
    const { getTool } = await import("../tools/registry.js");
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-plainmiss-"));
    try {
      mkdirSync(join(tempDir, "generated"), { recursive: true });
      writeFileSync(join(tempDir, "generated", "app.js"), "const a = 1;\n", "utf8");
      const edit = getTool("edit_file")!;
      const result = await edit.execute(
        { path: "app.js", old_string: "const b = 2;", new_string: "x" },
        { sessionId: "s", workspacePath: tempDir },
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("old_string not found");
      expect(result.error).not.toContain(MARKER);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("a staged build cannot report success while its markers remain", () => {
  it("downgrades success to partial when the artifact still throws on a marker", async () => {
    // Run 5 ended `outcome: "success"` on a page whose last line was
    // throw new Error('UNFINISHED_STUB: boot') — four subsystems unwritten. Every other
    // outcome signal reads how the run ENDED; none of them looked at the file.
    const { stagedBuildHonestOutcome } = await import("../agent/sub-agent.js");
    const dir = mkdtempSync(join(tmpdir(), "sai-honest-outcome-"));
    try {
      mkdirSync(join(dir, "generated", "neon-tetris"), { recursive: true });
      writeFileSync(
        join(dir, "generated", "neon-tetris", "index.html"),
        `<script>const core=1;
throw new Error('${MARKER}: boot');</script>`,
        "utf8",
      );
      expect(stagedBuildHonestOutcome("success", true, dir)).toBe("partial");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves a genuinely finished staged build alone", async () => {
    // THE DISCRIMINATOR: a rule that downgraded every staged build would make the outcome
    // field meaningless in the other direction.
    const { stagedBuildHonestOutcome } = await import("../agent/sub-agent.js");
    const dir = mkdtempSync(join(tmpdir(), "sai-honest-done-"));
    try {
      mkdirSync(join(dir, "generated", "game"), { recursive: true });
      writeFileSync(join(dir, "generated", "game", "index.html"), "<script>const done=1;</script>", "utf8");
      expect(stagedBuildHonestOutcome("success", true, dir)).toBe("success");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not judge a run that never signed up to fill markers", async () => {
    const { stagedBuildHonestOutcome } = await import("../agent/sub-agent.js");
    const dir = mkdtempSync(join(tmpdir(), "sai-honest-nonstaged-"));
    try {
      mkdirSync(join(dir, "generated"), { recursive: true });
      writeFileSync(join(dir, "generated", "leftover.js"), `throw new Error('${MARKER}: x');`, "utf8");
      // A research agent must not inherit someone else's unfinished artifact as its verdict.
      expect(stagedBuildHonestOutcome("success", false, dir)).toBe("success");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never turns a failure into something better, or worse", async () => {
    const { stagedBuildHonestOutcome } = await import("../agent/sub-agent.js");
    const dir = mkdtempSync(join(tmpdir(), "sai-honest-fail-"));
    try {
      mkdirSync(join(dir, "generated"), { recursive: true });
      writeFileSync(join(dir, "generated", "a.js"), `throw new Error('${MARKER}: x');`, "utf8");
      expect(stagedBuildHonestOutcome("failure", true, dir)).toBe("failure");
      expect(stagedBuildHonestOutcome("partial", true, dir)).toBe("partial");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the resume directive hands over located markers, not a search task", () => {
  it("reports each marker's file, line and exact text", async () => {
    // Run 6 spent seven of fourteen iterations paging a 446-line file to find the single
    // marker left in it, because the directive said "locate the markers" and the scan that
    // had already walked past every one of them reported only a count and a filename.
    const { findUnfilledStubFiles } = await import("../agent/sub-agent.js");
    const dir = mkdtempSync(join(tmpdir(), "sai-marker-sites-"));
    try {
      mkdirSync(join(dir, "generated", "neon-tetris"), { recursive: true });
      writeFileSync(
        join(dir, "generated", "neon-tetris", "index.html"),
        ["<script>", "const core = 1;", `/* ${MARKER}: loop */`, "const tail = 2;"].join("\n"),
        "utf8",
      );

      const found = findUnfilledStubFiles(dir);
      expect(found.count).toBe(1);
      expect(found.markers).toHaveLength(1);
      const site = found.markers[0]!;
      expect(site.file).toContain("index.html");
      expect(site.line).toBe(3);                       // 1-based, as read_file reports it
      expect(site.text).toBe(`/* ${MARKER}: loop */`); // usable verbatim as old_string
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("puts those locations in the directive and drops the search instruction", async () => {
    const { buildStagedBuildResumeGuidance } = await import("../agent/sub-agent-prompt-guidance.js");
    const withSites = buildStagedBuildResumeGuidance(
      ["generated/neon-tetris/index.html"], 1,
      [{ file: "generated/neon-tetris/index.html", line: 365, text: `/* ${MARKER}: loop */` }],
    );
    expect(withSites).toContain("generated/neon-tetris/index.html:365");
    expect(withSites).toContain(`/* ${MARKER}: loop */`);
    expect(withSites).toContain("do NOT need to search");

    // THE DISCRIMINATOR: with no located markers the directive must still tell the agent how
    // to find them, or a scan that failed would leave it with no instruction at all.
    const withoutSites = buildStagedBuildResumeGuidance(["generated/app/index.html"], 2);
    expect(withoutSites).toContain("grep_files");
    expect(withoutSites).not.toContain("do NOT need to search");
  });
});

describe("a build that keeps reading is told to write", () => {
  it("names the exact marker and forbids further reads", async () => {
    // Runs 6 and 7 called a tool on EVERY iteration — read_file, read_file, grep_files,
    // read_file — so the announced-without-acting nudge (which needs a turn with no tool
    // call at all) never fired, and a busy non-circling agent sailed past every guard while
    // the marker count never moved. Run 6 burned seven of fourteen iterations that way.
    const { buildReadOnlyStreakCorrection } = await import("../agent/sub-agent-prompt-guidance.js");
    const text = buildReadOnlyStreakCorrection({
      streak: 4,
      markerCount: 1,
      markerSites: [{ file: "generated/neon-tetris/index.html", line: 365, text: `/* ${MARKER}: loop */` }],
      iterationsLeft: 6,
    });

    expect(text).toContain("WITHOUT WRITING");
    expect(text).toContain("generated/neon-tetris/index.html line 365");
    expect(text).toContain(`/* ${MARKER}: loop */`);   // usable verbatim as old_string
    expect(text).toContain("edit_file");
    expect(text).toContain("6 iteration(s) left");
  });

  it("holds a streak limit that allows a real look-around but not an endless one", async () => {
    const { STAGED_BUILD_READ_ONLY_STREAK_LIMIT } = await import("../agent/sub-agent-prompt-guidance.js");
    // Enough for locate + read context + check one reference; short of the measured pattern.
    expect(STAGED_BUILD_READ_ONLY_STREAK_LIMIT).toBeGreaterThanOrEqual(2);
    expect(STAGED_BUILD_READ_ONLY_STREAK_LIMIT).toBeLessThanOrEqual(5);
  });

  it("counts an edit as progress when there are no markers left to move", async () => {
    // Run 12, live: repair mode holds the marker count at zero forever, so "the count
    // changed" never resets the streak — and the correction fired at an agent that had just
    // landed two real edits to fitCanvas. What counts as progress depends on the mode: a
    // fill is judged by markers moving, a repair by an edit happening at all, with the page
    // check judging on the next pass whether it helped.
    const { findUnfilledStubFiles } = await import("../agent/sub-agent.js");
    const dir = mkdtempSync(join(tmpdir(), "sai-repair-progress-"));
    try {
      mkdirSync(join(dir, "generated", "g"), { recursive: true });
      const file = join(dir, "generated", "g", "index.html");
      writeFileSync(file, "<script>const a=1;</script>", "utf8");
      // No markers before or after a repair edit — the count cannot express this work.
      expect(findUnfilledStubFiles(dir).count).toBe(0);
      writeFileSync(file, "<script>const a=2;</script>", "utf8");
      expect(findUnfilledStubFiles(dir).count).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("measures progress by the marker count, which a cosmetic edit cannot fake", async () => {
    // Run 8, iteration 3: the model DID call edit_file — and spent it refining the keyboard
    // handler, code that already worked, while the one marker it owed went untouched. A
    // "did a write tool run" test reads that as progress and hands the run another three
    // iterations of reading. The count is the thing that cannot be faked.
    const { findUnfilledStubFiles } = await import("../agent/sub-agent.js");
    const dir = mkdtempSync(join(tmpdir(), "sai-marker-progress-"));
    try {
      mkdirSync(join(dir, "generated", "g"), { recursive: true });
      const file = join(dir, "generated", "g", "index.html");

      writeFileSync(file, `const a=1;
/* ${MARKER}: loop */`, "utf8");
      expect(findUnfilledStubFiles(dir).count).toBe(1);

      // An edit elsewhere in the file: real bytes changed, marker count unmoved.
      writeFileSync(file, `const a=2;
/* ${MARKER}: loop */`, "utf8");
      expect(findUnfilledStubFiles(dir).count).toBe(1);

      // The fill itself is what moves it.
      writeFileSync(file, "const a=2;\nfunction loop(){}", "utf8");
      expect(findUnfilledStubFiles(dir).count).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("zero markers is not the same as a working page", () => {
  it("refuses success when the run's own page check failed", async () => {
    // Run 8: filled its last marker, called verify_page, was told the page throws on its
    // first inline script, edited twice, finished reporting success. Markers were zero and
    // the page was dead — the evidence was already in the run's own history.
    const { stagedBuildHonestOutcome } = await import("../agent/sub-agent.js");
    const dir = mkdtempSync(join(tmpdir(), "sai-pagecheck-"));
    try {
      mkdirSync(join(dir, "generated", "g"), { recursive: true });
      writeFileSync(join(dir, "generated", "g", "index.html"), "<script>const done=1;</script>", "utf8");

      expect(stagedBuildHonestOutcome("success", true, dir, { lastPassed: false })).toBe("partial");
      // A pass that has since been edited past verified different bytes.
      expect(stagedBuildHonestOutcome("success", true, dir, { lastPassed: true, mutatedSince: true })).toBe("partial");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still allows success for a checked, unmodified, marker-free page", async () => {
    // THE DISCRIMINATOR: a rule that never returned success would make the field useless.
    const { stagedBuildHonestOutcome } = await import("../agent/sub-agent.js");
    const dir = mkdtempSync(join(tmpdir(), "sai-pagecheck-ok-"));
    try {
      mkdirSync(join(dir, "generated", "g"), { recursive: true });
      writeFileSync(join(dir, "generated", "g", "index.html"), "<script>const done=1;</script>", "utf8");

      expect(stagedBuildHonestOutcome("success", true, dir, { lastPassed: true, mutatedSince: false })).toBe("success");
      // A build that never ran a page check is judged on markers alone, as before.
      expect(stagedBuildHonestOutcome("success", true, dir, {})).toBe("success");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tells a finishing run to re-check rather than merely recording the failure", async () => {
    const { buildPageCheckCorrection } = await import("../agent/sub-agent-prompt-guidance.js");
    const failed = buildPageCheckCorrection({ stale: false, iterationsLeft: 3 });
    expect(failed).toContain("DOES NOT RUN");
    expect(failed).toContain("verify_page");
    expect(failed).toContain("FIRST error");

    const stale = buildPageCheckCorrection({ stale: true, iterationsLeft: 3 });
    expect(stale).toContain("AFTER ITS LAST SUCCESSFUL CHECK");
  });
});

describe("a build whose page does not work is not a finished build", () => {
  it("finds a built page whose script throws, and one that paints off its canvas", async () => {
    // Resume detection asked only "are there unfilled markers". Run 9 reached zero markers
    // and left a page dying on `SyntaxError: Identifier 'started' has already been declared`;
    // the run before it left one that runs and paints its playfield off the side of its own
    // canvas. Both read as complete to a marker count, so nothing was handed back and the
    // user was the first thing in the loop to look at the result.
    const { findBrokenBuiltPages } = await import("../agent/sub-agent.js");
    const dir = mkdtempSync(join(tmpdir(), "sai-broken-page-"));
    try {
      mkdirSync(join(dir, "generated", "a"), { recursive: true });
      mkdirSync(join(dir, "generated", "b"), { recursive: true });

      writeFileSync(join(dir, "generated", "a", "index.html"),
        "<html><body><script>const started=1; const started=2;</script></body></html>", "utf8");

      // Runs cleanly, paints far outside a 300x600 canvas — the measured projection bug.
      writeFileSync(join(dir, "generated", "b", "index.html"),
        "<html><body><canvas id=\"board\"></canvas><script>"
        + "const c=document.getElementById('board').getContext('2d');"
        + "c.fillRect(-800,10,20,20); c.fillRect(-700,50,20,20);"
        + "</script></body></html>", "utf8");

      const broken = findBrokenBuiltPages(dir);
      expect(broken).toHaveLength(2);
      expect(broken.join(" ")).toContain("already been declared");
      expect(broken.join(" ")).toContain("outside the canvas");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stays silent on a page that works — the discriminator", async () => {
    // A scan that flagged healthy builds would put every finished artifact back into repair.
    const { findBrokenBuiltPages } = await import("../agent/sub-agent.js");
    const dir = mkdtempSync(join(tmpdir(), "sai-good-page-"));
    try {
      mkdirSync(join(dir, "generated", "g"), { recursive: true });
      writeFileSync(join(dir, "generated", "g", "index.html"),
        "<html><body><canvas id=\"board\"></canvas><script>"
        + "const c=document.getElementById('board').getContext('2d'); c.fillRect(10,10,40,40);"
        + "</script></body></html>", "utf8");
      expect(findBrokenBuiltPages(dir)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hands the agent the fault to repair instead of markers that are not there", async () => {
    const { buildStagedBuildResumeGuidance } = await import("../agent/sub-agent-prompt-guidance.js");
    const text = buildStagedBuildResumeGuidance([], 0, [], [
      "generated/neon-tetris/index.html: canvas 'board' is 440x313, but the page painted into x -320..160",
    ]);
    expect(text).toContain("FIX THE EXISTING BUILD");
    expect(text).toContain("440x313");
    expect(text).toContain("verify_page");
    expect(text).toContain("NEVER call write_file");
    // It must not send an agent hunting for markers when there are none left.
    expect(text).not.toContain("Replace ONE");
  });
});

describe("the read-without-writing correction also works in repair mode", () => {
  it("names the failing page when there are no markers to point at", async () => {
    // The streak correction was written for a FILL and gated on markers still being on disk.
    // A repair run has zero markers by definition, so that gate silently disabled the one
    // guard that stops an agent reading forever — in the mode that needs it just as much.
    const { buildReadOnlyRepairCorrection } = await import("../agent/sub-agent-prompt-guidance.js");
    const text = buildReadOnlyRepairCorrection({
      streak: 4,
      brokenPages: ["generated/neon-tetris/index.html: canvas 'board' is 440x313, but the page painted into x -320..160"],
      iterationsLeft: 7,
    });

    expect(text).toContain("WITHOUT CHANGING ANYTHING");
    expect(text).toContain("440x313");
    expect(text).toContain("edit_file");
    expect(text).toContain("verify_page");
    expect(text).toContain("7 iteration(s) left");
    // It must not send a repair run hunting for markers that do not exist.
    expect(text).not.toContain(MARKER);
  });
});

describe("an incomplete artifact still earns a corrective build", () => {
  it("reports work outstanding for a partial build and for a broken page", async () => {
    // The clean-slate validation run: a real 20 KB artifact with two subsystems unwritten,
    // probe=fail, qa=fail — and the corrective build was skipped, because its gate asked only
    // "was an artifact produced at all". That gate was written for the model that DESCRIBES an
    // app instead of building one; a build that exists and does not work needs it just as
    // much, and the QA loop cannot close the gap because its improve() rewrites the answer,
    // never the file. Only a build can fix a build.
    const { findUnfilledStubFiles, findBrokenBuiltPages } = await import("../agent/sub-agent.js");
    const dir = mkdtempSync(join(tmpdir(), "sai-incomplete-artifact-"));
    try {
      mkdirSync(join(dir, "generated", "t"), { recursive: true });
      const file = join(dir, "generated", "t", "index.html");

      // Shape 1: partially filled — markers remain.
      writeFileSync(file, `<script>const core=1;
throw new Error('${MARKER}: input');</script>`, "utf8");
      expect(findUnfilledStubFiles(dir).count).toBeGreaterThan(0);

      // Shape 2: no markers, but the page does not run.
      writeFileSync(file, "<script>const a=1; const a=2;</script>", "utf8");
      expect(findUnfilledStubFiles(dir).count).toBe(0);
      expect(findBrokenBuiltPages(dir).length).toBeGreaterThan(0);

      // THE DISCRIMINATOR: a finished, working artifact must NOT trigger a rebuild, or every
      // successful turn would pay for an extra delegation.
      writeFileSync(file, "<html><body><script>const done=1;</script></body></html>", "utf8");
      expect(findUnfilledStubFiles(dir).count).toBe(0);
      expect(findBrokenBuiltPages(dir)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
