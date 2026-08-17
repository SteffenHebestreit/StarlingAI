import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";

import {
  STAGED_BUILD_TASK_CHAR_THRESHOLD,
  UNFINISHED_STUB_MARKER,
  isStagedArtifactBuildRun,
  buildStagedArtifactBuildGuidance,
} from "../agent/sub-agent-prompt-guidance.js";

/**
 * Staged artifact builds (run f08195d2).
 *
 * A write-capable specialist handed a whole-artifact SPEC reasons past its budget and
 * never reaches a tool call: content_writer ran the full 1,200,000 ms stream cap with
 * 64,587 reasoning chars and ZERO tool calls; an ephemeral burned 20,129 completion
 * tokens and returned a 37-character result. The live probe fixed the mechanism — a
 * 46-char task calls its tool in ~4 s, a 2,400-char 8-group spec produces nothing in
 * 20 minutes — so the harness classifies the run and (behind the prompt flag) tells the
 * model to build in passes.
 */

// The two measured probe points, verbatim.
const PROBE_SMALL_TASK = "Write a file hello.txt containing exactly: hi";
const PROBE_LARGE_TASK = [
  "Build a complete single-file browser game as one self-contained HTML document.",
  "1) Canvas rendering loop with a fixed timestep, an accumulator and a capped frame delta.",
  "2) Player entity with acceleration, friction, clamped velocity and screen-edge wrapping.",
  "3) Enemy spawner with three difficulty ramps, per-wave budgets and off-screen placement.",
  "4) Broad-phase collision detection between every entity pair, then a precise circle test.",
  "5) Particle system for impacts, deaths and thruster exhaust, pooled to avoid allocation.",
  "6) HUD with score, lives, a wave counter and a combo multiplier that decays over time.",
  "7) Start, pause and game-over screens with full keyboard handling and focus management.",
  "8) LocalStorage high-score table holding the top ten entries with initials and a date.",
  "Ship it as one file with no external assets, no build step and no network requests.",
  "Rendering: draw order background, particles, enemies, player, HUD; no per-frame allocation.",
  "Input: arrow keys and WASD both bound, space to fire, escape to pause, enter to restart.",
  "Audio: WebAudio oscillator blips for fire, hit and death, muted by default with an M toggle.",
  "Balance: enemy speed and spawn rate scale per wave, with a hard ceiling so it stays playable.",
  "State: a single game object holding entities, timers and flags, reset cleanly on restart.",
  "Styling: dark background, monospace HUD, a CSS-only vignette, responsive to the viewport.",
  "Accessibility: visible focus rings on the menu buttons and a prefers-reduced-motion branch.",
  "Persistence: read the high-score table on load, write it on game over, tolerate bad JSON.",
  "Robustness: guard against a missing canvas context and against localStorage being blocked.",
  "Document the controls in an on-screen help panel that the H key toggles at any time.",
  "Keep every subsystem in its own clearly commented section of the single script block.",
].join("\n");

/**
 * The delegation task from run 3959f3ac, reconstructed to its measured size.
 *
 * That run is the reason the directive flag is default ON. The audit recorded
 * `sub_agent_staged_build_detected {taskChars: 2473, threshold: 600, maxIterations: 14,
 * directiveInjected: false}` — every precondition met, the mechanism announcing itself
 * as active, and not one word of it in the prompt, because the shipped flag value was
 * false and every existing test in this file hand-supplies that flag instead of reading
 * what ships. 2,473 chars exactly: the assertion on the audit record below is the run's
 * real number, so a fixture that merely "exceeds the threshold" would not reproduce it.
 */
const RUN_3959F3AC_TASK_CHARS = 2473;
const RUN_3959F3AC_MAX_ITERATIONS = 14;
const OBSERVED_BUILD_TASK = [
  "Build a playable 2.5D Tetris web app and serve it as a live instance.",
  "1) A Node.js/Express server that serves the static front-end and listens on 0.0.0.0 and process.env.PORT.",
  "2) An index.html shell, a styles.css, and a game.js that holds the whole game loop.",
  "3) A 10x20 playfield drawn on a canvas with a faux-isometric 2.5D projection and per-cell shading.",
  "4) All seven tetromino shapes, each with its own colour and wall-kick-aware rotation in both directions.",
  "5) Gravity on a fixed timestep, soft drop, hard drop, and a lock delay that resets on a successful move.",
  "6) Line clearing for one to four rows at once, scored with the standard single/double/triple/tetris values.",
  "7) A level counter that speeds gravity every ten cleared lines, plus a next-piece preview and a hold slot.",
  "8) Keyboard controls for move, rotate, soft drop, hard drop, hold and pause, all bound and shown on screen.",
  "9) A game-over overlay with the final score and a restart that resets every timer and flag cleanly.",
  "10) A HUD showing score, level, lines and the preview, styled to stay legible over the board.",
  "11) A seven-bag randomiser so the piece sequence is fair rather than uniformly random.",
  "12) A ghost piece showing where the active tetromino would land, toggleable from the HUD.",
  "13) A pause overlay that freezes gravity and input without losing the board or the timers.",
  "14) A localStorage high-score entry that tolerates missing or malformed stored values.",
  "15) A responsive layout so the board and the HUD stay usable down to a narrow viewport.",
  "16) A soft-lock counter that forces the piece down after a bounded number of resets so a spin loop cannot stall the run.",
  "17) A line-clear animation that holds for a few frames without blocking the fixed-timestep accumulator or the input queue.",
  "18) An on-screen help panel listing every binding, toggled by the H key and hidden again on a second press.",
  "Rendering order is background, settled cells, ghost, active piece, HUD, with no per-frame allocation.",
  "Guard against a missing canvas context and against localStorage being blocked by the browser.",
  "No external assets, no build step and no network calls at runtime; keep the dependencies to express alone.",
  "Build the smallest working version first, then enrich it; never re-emit a whole file to change part of it.",
  "Launch it via serve_app once it runs, verify it with verify_app, and keep looping until verification passes.",
  "The final answer MUST include the working public URL (/api/app/<id>/...).",
].join("\n");

describe("staged artifact build — detection", () => {
  it("does not fire on the task size the probe showed WORKS", () => {
    // 46 chars, 109 reasoning chars, tool call in ~4 s. Staging this would add a
    // pointless extra round trip to a task that already lands.
    expect(PROBE_SMALL_TASK.length).toBeLessThan(STAGED_BUILD_TASK_CHAR_THRESHOLD);
    expect(isStagedArtifactBuildRun(["write_file", "edit_file", "read_file"], PROBE_SMALL_TASK)).toBe(false);
  });

  it("fires on the task size the probe showed FAILS", () => {
    // 2,400 chars, 8 numbered requirement groups → 60,385 reasoning chars, zero tool
    // calls, killed at the stream cap.
    expect(PROBE_LARGE_TASK.length).toBeGreaterThan(STAGED_BUILD_TASK_CHAR_THRESHOLD);
    expect(isStagedArtifactBuildRun(["write_file", "edit_file", "read_file"], PROBE_LARGE_TASK)).toBe(true);
  });

  it("DISCRIMINATES on capability, not on the task", () => {
    // Same oversized task. An agent that cannot amend a file in place cannot stage
    // anything — telling it to fill stubs with edit_file would be an instruction to
    // call a tool it does not have.
    expect(isStagedArtifactBuildRun(["write_file", "read_file"], PROBE_LARGE_TASK)).toBe(false);
    expect(isStagedArtifactBuildRun(["edit_file", "read_file"], PROBE_LARGE_TASK)).toBe(false);
    expect(isStagedArtifactBuildRun(["web_search", "web_fetch"], PROBE_LARGE_TASK)).toBe(false);
    expect(isStagedArtifactBuildRun(undefined, PROBE_LARGE_TASK)).toBe(false);
    // ...and the same agent with a small task is still not staged.
    expect(isStagedArtifactBuildRun(["write_file", "edit_file"], PROBE_SMALL_TASK)).toBe(false);
  });

  it("measures the trimmed task, so whitespace padding cannot trip it", () => {
    const padded = `${PROBE_SMALL_TASK}${" ".repeat(2_000)}`;
    expect(isStagedArtifactBuildRun(["write_file", "edit_file"], padded)).toBe(false);
  });
});

describe("staged artifact build — directive", () => {
  const directive = buildStagedArtifactBuildGuidance(14, 24);

  it("names only tool capabilities that actually exist", () => {
    expect(directive).toContain("write_file");
    expect(directive).toContain("edit_file");
    expect(directive).toContain("old_string");
    expect(directive).toContain("read_file");
    expect(directive).toContain("grep_files");
  });

  it("never promises a range/line patch — no such tool exists", () => {
    // edit_file is an EXACT unique-match string replacement. A directive that told the
    // model to "patch lines 40-80" would send it at a capability the runtime does not
    // have, and every pass would fail on arguments.
    expect(directive).not.toMatch(/lines?\s+\d+\s*[-–]\s*\d+/i);
    expect(directive).not.toMatch(/line\s+(?:number|range)/i);
    expect(directive).not.toMatch(/\bpatch\s+lines?\b/i);
  });

  it("requires a skeleton that closes, with unique anchors", () => {
    // The whole point: a run cut off after pass 3 must leave a file that opens.
    expect(directive).toMatch(/CLOSES/);
    expect(directive).toMatch(/UNIQUE anchor/i);
  });

  it("forbids the SILENT placeholder that shipped the dead file (session a7b8fe3e)", () => {
    // The old text asked for "a short stub preceded by a UNIQUE anchor comment". The
    // agent obeyed it exactly: a skeleton whose script block was two block comments,
    // 2,684 bytes, structurally perfect, no game. Nothing about that file was wrong by
    // the old directive's own rules, which is why the fix has to be in the rules.
    expect(directive).toMatch(/never a placeholder comment, a TODO or an empty stub body/i);
    expect(directive).toMatch(/silent/i);
    // ...and the fill pass may not swap one placeholder for a smaller one.
    expect(directive).toMatch(/COMPLETE content as new_string/);
    expect(directive).toMatch(/never a partial version, never a smaller placeholder/i);
  });

  it("makes an unbuilt subsystem announce itself in the artifact and to the harness", () => {
    // Loud on both channels: it throws where it sits, and it is one literal a checker
    // can find. "Verify at the end" was already step 3 of the old directive and the run
    // never reached it — an instruction the agent can run out of budget before reading
    // is not a guard, so the guard is moved into the artifact itself at step 1.
    expect(directive).toContain(UNFINISHED_STUB_MARKER);
    expect(directive).toMatch(new RegExp(`throw new Error\\("${UNFINISHED_STUB_MARKER}: `));
    expect(directive).toMatch(/greps for it/i);
    expect(directive).toMatch(/INCOMPLETE/);
    // The marker must be planted by the FIRST tool call, not by a later pass.
    expect(directive.indexOf(UNFINISHED_STUB_MARKER)).toBeLessThan(directive.indexOf("2. FILL"));
  });

  it("spends the budget on writing, not on re-reading what it already read", () => {
    // 54,586 bytes read against 141 bytes written: five of ten iterations went on
    // re-reading a 16,091-char source file already read whole at iteration 1.
    expect(directive).toMatch(/Read each source file ONCE, whole/);
    expect(directive).toMatch(/re-reading is a pass not spent writing/i);
    // And it must land in the PREAMBLE — before step 1 — so the model has it before it
    // plans its first call, not buried after the fill instructions.
    expect(directive.indexOf("ONCE, whole")).toBeLessThan(directive.indexOf("1. SKELETON"));
  });

  it("no longer tells the agent a cut-off artifact is fine as it stands", () => {
    // The retired closing line — "the artifact on disk is still valid and is handed back
    // as a partial" — is the sentence that blessed the dead file. A partial is only
    // acceptable when it is LABELLED, which is what the marker buys.
    expect(directive).not.toMatch(/still valid and is handed back/);
    expect(directive).toMatch(/never mistaken for a finished artifact/i);
  });

  it("derives the pass budget from the run's own iteration cap", () => {
    // Reserve the skeleton, the verification read and the tool-stripped final synthesis.
    expect(buildStagedArtifactBuildGuidance(14, 24)).toContain("about 11 of them");
    expect(buildStagedArtifactBuildGuidance(10, 24)).toContain("about 7 of them");
  });

  it("never promises more passes than PER_PATH_EDIT_CAP allows", () => {
    // Discriminates against a fixed pass budget: with an unbounded iteration cap the
    // directive must still stop at the harness ceiling, or the agent plans 30 fills and
    // gets blocked at the cap with the artifact half-stubbed.
    expect(buildStagedArtifactBuildGuidance(Number.MAX_SAFE_INTEGER, 24)).toContain("about 24 of them");
    // ...and a tiny iteration budget never goes below a floor of 2.
    expect(buildStagedArtifactBuildGuidance(3, 24)).toContain("about 2 of them");
  });
});

// ── Injection into the real sub-agent system prompt ────────────────────────────
const completeMock = vi.fn();
const logAuditMock = vi.fn();

vi.mock("../providers/lmstudio.js", async (importActual) => ({
  ...(await importActual<typeof import("../providers/lmstudio.js")>()),
  LMStudioProvider: class {
    async complete(messages: unknown, tools: unknown, signal?: AbortSignal) {
      return completeMock(messages, tools, signal);
    }
  },
}));

// Spread the real module: sub-agent.ts only takes logAudit from it, but other modules
// pulled in by the same graph take the writer/reader helpers, and a bare factory would
// leave those undefined.
vi.mock("../audit/logger.js", async (importActual) => ({
  ...(await importActual<typeof import("../audit/logger.js")>()),
  logAudit: (...args: unknown[]) => logAuditMock(...args),
}));

describe("staged artifact build — directive injection", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    completeMock.mockReset();
    logAuditMock.mockReset();
    vi.resetModules();
    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
    const swarmMemory = await import("../swarm/memory.js");
    await swarmMemory.resetSharedMemoryForTests();
  });

  /**
   * Run one sub-agent turn and return the system message it was actually sent.
   * `orchestration` omitted means the config file carries no orchestration block at
   * all, so the run resolves the SHIPPED schema defaults — the only way to test the
   * value operators actually get.
   */
  const runAndCaptureSystemPrompt = async (
    orchestration: Record<string, unknown> | undefined,
    task: string,
    tools: string[],
  ): Promise<string> => {
    const tempDir = mkdtempSync(join(tmpdir(), "sai-staged-build-"));
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      ...(orchestration ? { orchestration } : {}),
      subAgents: {
        staged_builder: {
          description: "Staged build test agent",
          systemPrompt: "You build files.",
          tools,
          maxIterations: 14,
          turnTimeoutMs: 60_000,
        },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    // Drop any config a previous test in this file already cached: a stale cache
    // resolves `staged_builder` to missing_config and the run returns before the
    // provider is ever called, which reads as "no directive" for the wrong reason.
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();

    let systemPrompt = "";
    completeMock.mockImplementation((messages: Array<{ role: string; content: string }>) => {
      systemPrompt = messages.find((m) => m.role === "system")?.content ?? "";
      return {
        content: "Done.",
        tool_calls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      };
    });

    const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
    await runSubAgentWithStats({
      agentName: "staged_builder",
      task,
      parentSessionId: `parent-${Math.random().toString(36).slice(2)}`,
      workspacePath: tempDir,
    });
    return systemPrompt;
  };

  it("injects the directive at ITERATION 0 when the prompt flag is on", async () => {
    // Iteration 0 is the only one that matters: the measured failure never completed a
    // single iteration, so any nudge gated on prior tool calls or on a fraction of the
    // iteration budget can never reach it.
    const prompt = await runAndCaptureSystemPrompt(
      { stagedArtifactBuilds: true, stagedArtifactBuildDirective: true },
      PROBE_LARGE_TASK,
      ["write_file", "edit_file", "read_file"],
    );
    expect(prompt).toContain("STAGED BUILD");
    expect(prompt).toContain("You build files."); // the agent's own prompt is preserved
  });

  it("does NOT inject it with the prompt flag off — the pass^k gate", async () => {
    // Same agent, same task, only the flag differs. This is the discriminating pair:
    // if the injection ignored the flag, this assertion fails while the one above passes.
    const prompt = await runAndCaptureSystemPrompt(
      { stagedArtifactBuilds: true, stagedArtifactBuildDirective: false },
      PROBE_LARGE_TASK,
      ["write_file", "edit_file", "read_file"],
    );
    expect(prompt).not.toContain("STAGED BUILD");
  });

  it("does NOT inject it for a small task, flag on", async () => {
    const prompt = await runAndCaptureSystemPrompt(
      { stagedArtifactBuilds: true, stagedArtifactBuildDirective: true },
      PROBE_SMALL_TASK,
      ["write_file", "edit_file", "read_file"],
    );
    expect(prompt).not.toContain("STAGED BUILD");
  });

  it("does NOT inject it for an agent that cannot edit in place, flag on", async () => {
    const prompt = await runAndCaptureSystemPrompt(
      { stagedArtifactBuilds: true, stagedArtifactBuildDirective: true },
      PROBE_LARGE_TASK,
      ["write_file", "read_file"],
    );
    expect(prompt).not.toContain("STAGED BUILD");
  });

  it("the mechanical kill switch disarms the prompt half too", async () => {
    const prompt = await runAndCaptureSystemPrompt(
      { stagedArtifactBuilds: false, stagedArtifactBuildDirective: true },
      PROBE_LARGE_TASK,
      ["write_file", "edit_file", "read_file"],
    );
    expect(prompt).not.toContain("STAGED BUILD");
  });

  it("REGRESSION run 3959f3ac — the SHIPPED default injects it, and the audit says so", async () => {
    // No orchestration block in the config at all, so this run resolves the schema
    // defaults. That is the whole point: every assertion above hands the flag in by
    // hand, which is why the suite stayed green while the value that ships was false
    // and `directiveInjected` was false on a run with all preconditions met.
    expect(OBSERVED_BUILD_TASK.trim().length).toBe(RUN_3959F3AC_TASK_CHARS);

    const prompt = await runAndCaptureSystemPrompt(
      undefined,
      OBSERVED_BUILD_TASK,
      // backend_coder's effective toolset, trimmed to what the classifier reads.
      ["read_file", "write_file", "edit_file", "list_files", "grep_files", "serve_app", "verify_app"],
    );

    // The guidance text is in the messages the provider was actually handed.
    expect(prompt).toContain("STAGED BUILD — THIS TASK IS TOO LARGE FOR ONE PASS.");
    expect(prompt).toContain(UNFINISHED_STUB_MARKER);
    // ...sized from this run's own iteration cap, not a constant.
    expect(prompt).toContain("about 11 of them");

    // And the audit record that reported the defect now reports the fix.
    expect(logAuditMock).toHaveBeenCalledWith(
      "sub_agent_staged_build_detected",
      expect.objectContaining({
        agentName: "staged_builder",
        taskChars: RUN_3959F3AC_TASK_CHARS,
        threshold: STAGED_BUILD_TASK_CHAR_THRESHOLD,
        maxIterations: RUN_3959F3AC_MAX_ITERATIONS,
        directiveInjected: true,
      }),
      expect.anything(),
    );
  });

  it("keeps the agent's own prompt LAST so its finish contract outranks the directive", async () => {
    // backend_coder must end on serve_app + verify_app + the live /api/app/<id>/ URL.
    // Appended after the agent prompt, the directive's generic "FINISH ... report the
    // path" was the last thing the model read — which is the shape of the run that
    // wrote five files and never served them. Order is the guard.
    const prompt = await runAndCaptureSystemPrompt(
      undefined,
      OBSERVED_BUILD_TASK,
      ["read_file", "write_file", "edit_file", "list_files", "grep_files", "serve_app", "verify_app"],
    );
    expect(prompt.indexOf("STAGED BUILD —")).toBeGreaterThanOrEqual(0);
    expect(prompt.indexOf("STAGED BUILD —")).toBeLessThan(prompt.indexOf("You build files."));
    // ...and the directive itself no longer asserts the path is the only valid finish.
    expect(prompt).toContain("report the path or the live URL");
  });
});

// ── Never discard a cut-off build (requirement 5) ──────────────────────────────
describe("staged artifact build — on-disk salvage", () => {
  it("reports the files a cut-off run left behind, flagging the incomplete one", async () => {
    const { describeMutatedWorkspaceFiles } = await import("../agent/sub-agent.js");
    const root = mkdtempSync(join(tmpdir(), "sai-staged-salvage-"));
    mkdirSync(join(root, "generated"), { recursive: true });
    // Pass 0 skeleton + two filled subsystems, then the run dies: the file opens but
    // never got its closing tag.
    writeFileSync(join(root, "generated", "game.html"), "<!DOCTYPE html>\n<html><body><script>let a=1;", "utf8");
    writeFileSync(join(root, "generated", "data.json"), "[{\"id\":1}]", "utf8");

    const lines = describeMutatedWorkspaceFiles(["generated/game.html", "generated/data.json"], root);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("generated/game.html");
    expect(lines[0]).toContain("bytes on disk");
    expect(lines[0]).toContain("INCOMPLETE");
    // The complete file must NOT be branded incomplete, or the signal is worthless.
    expect(lines[1]).toContain("generated/data.json");
    expect(lines[1]).not.toContain("INCOMPLETE");
  });

  /**
   * The delivered file from session a7b8fe3e, at its real shape: doctype, head, the CSS
   * that iteration 5 really did fill, body, script, closing tags. The only thing missing
   * is the game. Rendered from a template so the ONLY difference between the two cases
   * below is how the unbuilt subsystems were marked.
   */
  const deadBundle = (part1: string, part2: string): string => [
    "<!DOCTYPE html>",
    "<html lang=\"en\">",
    "<head><meta charset=\"utf-8\"><title>Game</title>",
    "<style>body{margin:0;background:#111;color:#eee}canvas{display:block}</style>",
    "</head>",
    "<body><canvas id=\"c\" width=\"640\" height=\"480\"></canvas>",
    "<script>",
    part1,
    part2,
    "</script>",
    "</body>",
    "</html>",
    "",
  ].join("\n");

  it("REGRESSION a7b8fe3e — a skeleton whose subsystems were never filled is NOT complete", async () => {
    const { artifactFileLooksTruncated } = await import("../agent/sub-agent.js");
    const root = mkdtempSync(join(tmpdir(), "sai-staged-stub-"));
    mkdirSync(join(root, "generated"), { recursive: true });

    // What actually shipped: two block comments where the game should be. Every FORMAT
    // rule passes — the doctype is there, the </html> closes, it is not JSON — so the
    // detector returned null and the run was reported complete. This assertion is the
    // defect, kept as documentation of why the comment convention had to go.
    const asComments = join(root, "generated", "comments.html");
    writeFileSync(asComments, deadBundle("/* JS_PART1 */", "/* JS_PART2 */"), "utf8");
    expect(artifactFileLooksTruncated({ path: asComments, filename: "comments.html" })).toBeNull();

    // Same interruption, same bytes of real content, marked the way the directive now
    // requires. Nothing about the file's structure changed — only that it says so.
    const asMarkers = join(root, "generated", "markers.html");
    writeFileSync(asMarkers, deadBundle(
      `throw new Error("${UNFINISHED_STUB_MARKER}: game loop");`,
      `throw new Error("${UNFINISHED_STUB_MARKER}: input handling");`,
    ), "utf8");
    const reason = artifactFileLooksTruncated({ path: asMarkers, filename: "markers.html" });
    expect(reason).toContain(UNFINISHED_STUB_MARKER);
    expect(reason).toContain("stopped before that subsystem was written");
  });

  it("clears once the last subsystem is filled — not a permanent brand on the file", async () => {
    // Discriminates against a check that just fails every staged artifact: the same
    // document with real code in place of the markers must come back clean, or the
    // signal is noise and the next fix will be to delete it.
    const { artifactFileLooksTruncated } = await import("../agent/sub-agent.js");
    const root = mkdtempSync(join(tmpdir(), "sai-staged-filled-"));
    const filled = join(root, "filled.html");
    writeFileSync(filled, deadBundle(
      "const ctx = document.getElementById('c').getContext('2d');",
      "requestAnimationFrame(function tick(){ ctx.clearRect(0,0,640,480); requestAnimationFrame(tick); });",
    ), "utf8");
    expect(artifactFileLooksTruncated({ path: filled, filename: "filled.html" })).toBeNull();
  });

  it("carries the marker through to the salvage report the parent reads", async () => {
    // artifactFileLooksTruncated is what describeMutatedWorkspaceFiles brands INCOMPLETE
    // with, so an abandoned staged build is named as abandoned in the handback rather
    // than listed as a delivered path with a byte count.
    const { describeMutatedWorkspaceFiles } = await import("../agent/sub-agent.js");
    const root = mkdtempSync(join(tmpdir(), "sai-staged-stub-salvage-"));
    mkdirSync(join(root, "generated"), { recursive: true });
    writeFileSync(
      join(root, "generated", "app.js"),
      `function boot(){ throw new Error("${UNFINISHED_STUB_MARKER}: physics"); }\n`,
      "utf8",
    );
    const [line] = describeMutatedWorkspaceFiles(["generated/app.js"], root);
    expect(line).toContain("INCOMPLETE");
    expect(line).toContain(UNFINISHED_STUB_MARKER);
  });

  it("skips paths that are not files on disk rather than inventing them", async () => {
    const { describeMutatedWorkspaceFiles } = await import("../agent/sub-agent.js");
    const root = mkdtempSync(join(tmpdir(), "sai-staged-salvage-"));
    expect(describeMutatedWorkspaceFiles(["generated/never-written.html"], root)).toEqual([]);
  });

  it("resolves a write_file artifact's RELATIVE path against the workspace root", async () => {
    // write_file's metadata records the path the MODEL passed, not the resolved one.
    // Without a workspace root the probe existsSync'd it against the gateway's cwd,
    // found nothing and returned null — i.e. every half-written build was silently
    // reported as a completed deliverable. Reverting the workspaceRoot argument turns
    // the second expectation into null and this test fails.
    const { artifactFileLooksTruncated } = await import("../agent/sub-agent.js");
    const root = mkdtempSync(join(tmpdir(), "sai-staged-truncation-"));
    mkdirSync(join(root, "generated"), { recursive: true });
    writeFileSync(join(root, "generated", "cut.html"), "<!DOCTYPE html>\n<html><body><script>", "utf8");

    const artifact = { path: "generated/cut.html", outputPath: "generated/cut.html", filename: "cut.html" };
    expect(artifactFileLooksTruncated(artifact)).toBeNull();
    expect(artifactFileLooksTruncated(artifact, root)).toContain("</html>");
  });
});

// ── The pass budget the SHIPPED roster actually gets ───────────────────────────
/**
 * Iteration budgets are read off the committed workspace shards, never hand-supplied.
 *
 * The directive sizes itself from `maxIterations`, so an agent's shard value IS its
 * pass budget — and content_writer shipped at 10 while holding the same 25-minute turn
 * deadline and the same hand-build-in-passes instruction as web_coder and backend_coder
 * at 14. A test that passed its own number in would have agreed with either value.
 *
 * The arithmetic at 10: the directive reserves 3 (skeleton, verification read, the
 * tool-stripped final synthesis) and promises maxIterations - 3 = 7 fills, but that
 * reserve buys ZERO input reads. Session a7b8fe3e had to read styles.css and game.js
 * before it could concatenate them, so 7 promised fills were 5 affordable ones, and a
 * single rejected edit_file (the directive's own recovery is grep_files then retry, two
 * more iterations) ate two of those five. It stopped at iteration 9 of 10.
 */
describe("staged artifact build — the shipped iteration budget", () => {
  const agentsDir = fileURLToPath(new URL("../../../../workspace/agents/", import.meta.url));
  type Agent = { systemPrompt?: string; maxIterations?: number; turnTimeoutMs?: number };
  const subAgents: Record<string, Agent> = {};
  for (const file of readdirSync(agentsDir)) {
    if (!file.endsWith(".jsonc")) continue;
    const shard = JSON5.parse<{ subAgents?: Record<string, Agent> }>(readFileSync(join(agentsDir, file), "utf-8"));
    Object.assign(subAgents, shard.subAgents ?? {});
  }

  // The whole-artifact builders: told to build in staged passes AND carrying the
  // 25-minute deadline that only a whole-file emitter needs. `coder` matches the first
  // half and not the second (900,000 ms — it runs scripts, its deliverable is a computed
  // result rather than a file), so it is correctly outside this group at 10.
  const WHOLE_ARTIFACT_TURN_TIMEOUT_MS = 1_500_000;
  const builders = Object.entries(subAgents).filter(([, a]) =>
    (a.systemPrompt ?? "").includes(UNFINISHED_STUB_MARKER)
    && a.turnTimeoutMs === WHOLE_ARTIFACT_TURN_TIMEOUT_MS);

  it("has a roster to measure (guards against a silently empty parse)", () => {
    expect(Object.keys(subAgents).length).toBeGreaterThan(20);
    expect(builders.map(([name]) => name)).toEqual(
      expect.arrayContaining(["content_writer", "web_coder", "backend_coder"]),
    );
  });

  it("gives every whole-artifact builder the same passes, not just the same wall clock", () => {
    // 14 is the value PER_PATH_EDIT_CAP's own comment is sized against ("the widest
    // builder iteration budget in the workspace is 14 … which the directive turns into
    // 11 fill passes"). content_writer at 10 made that comment false and left one agent
    // doing the same job on 4 fewer passes for no stated reason.
    for (const [name, agent] of builders) {
      expect(agent.maxIterations, `${name} hand-builds artifacts on a 25-min deadline`).toBeGreaterThanOrEqual(14);
    }
  });

  it("turns content_writer's shipped budget into the same promise the other builders get", () => {
    // Reverting the shard to 10 makes this "about 7 of them" and the assertion fails.
    const contentWriter = subAgents["content_writer"];
    expect(contentWriter).toBeDefined();
    const promise = buildStagedArtifactBuildGuidance(contentWriter?.maxIterations ?? 0, 24);
    expect(promise).toContain("about 11 of them");
    expect(promise).toBe(buildStagedArtifactBuildGuidance(subAgents["web_coder"]?.maxIterations ?? 0, 24));
  });

  it("leaves an execution agent on its own budget rather than raising everything", () => {
    // Discriminates against "bump every maxIterations": coder builds files too, but its
    // deliverable is a run result on a 15-minute clock, so it is untouched at 10.
    expect(subAgents["coder"]?.maxIterations).toBe(10);
    expect(builders.map(([name]) => name)).not.toContain("coder");
  });
});
