import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";
import { loadWorkspaceAgents } from "./support/workspace-shards.js";

import {
  STAGED_BUILD_TASK_CHAR_THRESHOLD,
  UNFINISHED_STUB_MARKER,
  isStagedArtifactBuildRun,
  stagedBuildTaskChars,
  taskOwnWordChars,
  buildStagedArtifactBuildGuidance,
  buildStagedBuildFirstStepInstruction,
  ONE_SHOT_ASSEMBLER_TOOLS,
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

/**
 * The cart assessment (E2E core-build-code-assessment-no-edit). The user pasted cart.js and
 * asked why its total goes negative; the orchestrator copied the code into the delegation.
 * That made the task 681 chars, about 420 of them code. code_analyst holds write_file and
 * edit_file, so it was told to build in passes and wrote a report file nobody asked for.
 * Both shapes below are what a delegating model writes: the fence on its own lines, and the
 * fence opened after a colon and closed in front of the next sentence.
 */
const CART_JS = [
  "// Shopping cart totals.",
  "",
  "function applyDiscount(subtotal, percent) {",
  "  // percent is used as a fraction here, but callers pass whole numbers (20 for 20%).",
  "  return subtotal - subtotal * percent;",
  "}",
  "",
  "function cartTotal(items, discountPercent) {",
  "  const subtotal = items.reduce((sum, it) => sum + it.price * it.qty, 0);",
  "  return applyDiscount(subtotal, discountPercent);",
  "}",
  "",
  "module.exports = { applyDiscount, cartTotal };",
].join("\n");
const CART_QUESTION = "Erkläre, warum cartTotal für einen Warenkorb von 50 $ mit 20 % Rabatt einen negativen Betrag "
  + "statt 40 $ liefert. Analysiere das folgende Code-Fragment, Zeile für Zeile, mit den Werten aus der Frage:";
const CART_CLOSING = "Gebe die Ursache des Fehlers präzise an und zeige die Korrektur auf. Antworte auf Deutsch.";
const CART_TASK_FENCE_ON_OWN_LINES = `${CART_QUESTION}\n\`\`\`javascript\n${CART_JS}\n\`\`\`\n${CART_CLOSING}`;
const CART_TASK_FENCE_IN_LINE = `${CART_QUESTION} \`\`\`javascript\n${CART_JS}\n\`\`\` ${CART_CLOSING}`;
const WRITE_AND_EDIT = ["read_file", "write_file", "edit_file", "list_files", "grep_files"];

/**
 * A deck delegation the size of the ones that failed in E2E core-build-artifact-revealjs-deck
 * (817-1,349 chars): with `deliverable` in its schema the orchestrator restates the file format and
 * the design, and the task crosses the staged-build threshold.
 */
const DECK_TASK = [
  "Erstelle eine reveal.js-Präsentation zum Thema \"Digitaler Wartungsplan für Produktionsanlagen\" als einzelne HTML-Datei.",
  "Verwende reveal.js über das CDN und ein ruhiges, helles Theme mit einer Akzentfarbe in Dunkelblau.",
  "Folien: 1) Titelfolie mit Untertitel und Datum. 2) Ausgangslage: ungeplante Stillstände, Papierlisten, fehlende Historie.",
  "3) Ziele: planbare Wartung, weniger Ausfallzeit, nachvollziehbare Prüfungen. 4) Aufbau des Plans: Anlagen, Intervalle, Verantwortliche.",
  "5) Ablauf einer Wartung vom Auftrag bis zur Freigabe. 6) Kennzahlen: MTBF, MTTR, Termintreue. 7) Einführung in drei Phasen.",
  "8) Risiken und Gegenmaßnahmen. 9) Nächste Schritte mit Terminen. 10) Abschlussfolie mit Kontakt.",
  "Halte jede Folie kurz, höchstens fünf Stichpunkte, und lege die Sprechernotizen in die Notizen der Folien.",
].join("\n");

/**
 * A lookup step as execute_plan hands it over (buildStepTask): a one-line description, then the
 * turn's objective and acceptance criteria. Shaped on E2E new-delegation-routing-bounded-fanout,
 * session 62b04e8b, whose steps reached browser_agent at 594, 603 and 640 chars.
 */
const PLAN_STEP_LOOKUP_TASK = [
  "STEP s2 — Preis für 30 Stück NW-3102 inklusive Mengenrabatt und Versand aus /preise.html und dem Produktkatalog ermitteln",
  "OBJECTIVE (the whole turn): Für einen Lagerbericht der Nordlicht Werkzeuge GmbH (http://www.nordlicht-werkzeuge.test/) drei unabhängige Teilergebnisse ermitteln und danach in einer kurzen Übersicht zusammenfassen.",
  "ACCEPTANCE CRITERIA for the turn: Alle Artikel unter Mindestbestand mit ihrem Gesamtbestand genannt; Preis für 30 Stück NW-3102 mit Mengenrabatt und Versand berechnet; Bedeutung von Fehlercode E22 aus der Dokumentation wiedergegeben; die drei Ergebnisse in einer kurzen Übersicht zusammengefasst",
].join("\n\n");

describe("staged artifact build — only the task's own words count", () => {
  it("does not stage a question about pasted code, whichever way the fence is written", () => {
    for (const task of [CART_TASK_FENCE_ON_OWN_LINES, CART_TASK_FENCE_IN_LINE]) {
      // The precondition that fired in the run: the whole task is past the threshold...
      expect(task.trim().length).toBeGreaterThan(STAGED_BUILD_TASK_CHAR_THRESHOLD);
      // ...while the question itself is well short of it.
      expect(taskOwnWordChars(task)).toBe(`${CART_QUESTION}\n${CART_CLOSING}`.length);
      expect(taskOwnWordChars(task)).toBeLessThan(STAGED_BUILD_TASK_CHAR_THRESHOLD);
      expect(isStagedArtifactBuildRun(WRITE_AND_EDIT, task)).toBe(false);
    }
  });

  it("still counts the same code when nothing marks it as pasted", () => {
    // No fence, so nothing says where the task's words end: it is measured as before.
    const unfenced = `${CART_QUESTION}\n${CART_JS}\n${CART_CLOSING}`;
    expect(taskOwnWordChars(unfenced)).toBe(unfenced.trim().length);
    expect(isStagedArtifactBuildRun(WRITE_AND_EDIT, unfenced)).toBe(true);
  });

  it("still stages a specification that brings code along", () => {
    const specWithCode = `${PROBE_LARGE_TASK}\nThe current loop, for reference:\n\`\`\`js\n${CART_JS}\n\`\`\``;
    expect(taskOwnWordChars(specWithCode)).toBe(`${PROBE_LARGE_TASK}\nThe current loop, for reference:`.length);
    expect(isStagedArtifactBuildRun(WRITE_AND_EDIT, specWithCode)).toBe(true);
  });

  it("does not count quoted lines, and counts the same lines unquoted", () => {
    const quoted = `Summarise what this message asks of us.\n${PROBE_LARGE_TASK.split("\n").map((line) => `> ${line}`).join("\n")}`;
    expect(taskOwnWordChars(quoted)).toBe("Summarise what this message asks of us.".length);
    expect(isStagedArtifactBuildRun(WRITE_AND_EDIT, quoted)).toBe(false);
    expect(isStagedArtifactBuildRun(WRITE_AND_EDIT, quoted.replace(/^> /gm, ""))).toBe(true);
  });

  it("counts a fence that is never closed, lines and all", () => {
    const unclosed = `Fix this:\n\`\`\`js\n${PROBE_LARGE_TASK}`;
    expect(taskOwnWordChars(unclosed)).toBe(unclosed.trim().length);
    expect(isStagedArtifactBuildRun(WRITE_AND_EDIT, unclosed)).toBe(true);
  });

  it("measures the whole task when it holds a fence opener it does not read", () => {
    // An info string of more than one word, and a run glued to the word before it. Neither
    // was read as an opener, so the first block's bare closing ``` opened a block instead,
    // which ran to the end of the second block: the requirements between the two were set
    // aside as material, and the task measured 57 and 27 chars.
    for (const opening of ["Fix the bug in this file:\n```js title=\"a.js\"", "Fix the bug in this file:```js"]) {
      const task = `${opening}\nconst a = 1;\n\`\`\`\n${PROBE_LARGE_TASK}\nFor reference the helper:\n\`\`\`js\nconst b = 2;\n\`\`\``;
      expect(taskOwnWordChars(task), opening).toBe(task.trim().length);
      expect(isStagedArtifactBuildRun(WRITE_AND_EDIT, task), opening).toBe(true);
    }
  });

  it("measures the whole task when a block holds a run that could have been its end", () => {
    // The first block's end is written after code on its line, so it closes nothing; the
    // reader went on through the requirements and closed the block at the end of the second.
    const task = `Fix this:\n\`\`\`js\nconst a = 1; \`\`\`\n${PROBE_LARGE_TASK}\n\`\`\`js\nconst b = 2;\n\`\`\``;
    expect(taskOwnWordChars(task)).toBe(task.trim().length);
    expect(isStagedArtifactBuildRun(WRITE_AND_EDIT, task)).toBe(true);
  });

  it("measures the whole task when a block is left open, whatever it set aside before it", () => {
    // The first block is never closed, so its intended end pairs with the next block's
    // start: the requirements in between are read as code, and the last ``` opens a block
    // that nothing closes. Counting only that last block measured the task at 26 chars.
    const task = `Material:\n\`\`\`\nconst a = 1;\n${PROBE_LARGE_TASK}\n\`\`\`\nconst b = 2;\n\`\`\``;
    expect(taskOwnWordChars(task)).toBe(task.trim().length);
    expect(isStagedArtifactBuildRun(WRITE_AND_EDIT, task)).toBe(true);
  });

  it("measures a run that holds a builder tool on the whole task, so a fenced spec still stages it", () => {
    // What a builder is handed in a fence is often what it builds: a requirement list the
    // delegator fenced, or a Markdown body to turn into a page. Measured on its own words
    // this task is 31 chars, and web_coder would build the whole page in one completion.
    const fencedSpec = `Build the page described below.\n\`\`\`\n${PROBE_LARGE_TASK}\n\`\`\``;
    const builderTools = [...WRITE_AND_EDIT, "verify_page"];
    expect(taskOwnWordChars(fencedSpec)).toBeLessThan(STAGED_BUILD_TASK_CHAR_THRESHOLD);
    expect(stagedBuildTaskChars(builderTools, fencedSpec)).toBe(fencedSpec.trim().length);
    expect(isStagedArtifactBuildRun(builderTools, fencedSpec)).toBe(true);
    // A run with no builder tool measures its own words: the fence is input to its answer.
    expect(stagedBuildTaskChars(WRITE_AND_EDIT, fencedSpec)).toBe(taskOwnWordChars(fencedSpec));
    expect(isStagedArtifactBuildRun(WRITE_AND_EDIT, fencedSpec)).toBe(false);
  });

  it("gives the shipped builders the whole-task measure and code_analyst its own words", () => {
    type Agent = { tools?: string[] };
    const agents = loadWorkspaceAgents<Agent>();
    const fencedSpec = `Build the page described below.\n\`\`\`\n${PROBE_LARGE_TASK}\n\`\`\``;
    for (const name of ["web_coder", "content_writer", "backend_coder"]) {
      expect(isStagedArtifactBuildRun(agents[name]?.tools, fencedSpec), name).toBe(true);
    }
    const codeAnalystTools = agents["code_analyst"]?.tools;
    expect(codeAnalystTools).toEqual(expect.arrayContaining(["write_file", "edit_file"]));
    expect(isStagedArtifactBuildRun(codeAnalystTools, CART_TASK_FENCE_ON_OWN_LINES)).toBe(false);
    expect(isStagedArtifactBuildRun(codeAnalystTools, fencedSpec)).toBe(false);
  });

  it("still sets material aside when the text places every fence it holds", () => {
    // Two blocks, each opened and closed, with the requirements between them.
    const task = `Fix the bug in this file:\n\`\`\`js\nconst a = 1;\n\`\`\`\n${PROBE_LARGE_TASK}\nFor reference the helper:\n\`\`\`js\nconst b = 2;\n\`\`\``;
    expect(taskOwnWordChars(task)).toBe(`Fix the bug in this file:\n${PROBE_LARGE_TASK}\nFor reference the helper:`.length);
  });

  it("measures a task with nothing fenced or quoted exactly as before", () => {
    for (const task of [PROBE_SMALL_TASK, PROBE_LARGE_TASK, OBSERVED_BUILD_TASK, `  ${PROBE_SMALL_TASK}\r\n\r\n`]) {
      expect(taskOwnWordChars(task)).toBe(task.trim().length);
    }
    // Backticks in prose open nothing: an inline span, a run named in a sentence.
    const prose = "Wrap each snippet in ``` fences.\nUse ```inline``` spans for names.\n```";
    expect(taskOwnWordChars(prose)).toBe(prose.trim().length);
  });

  it("closes a block only with a run of its own character, at least as long", () => {
    // A four-backtick block quoting Markdown that itself holds a ``` block; and a tilde block.
    const nested = "Review this README:\n````md\n# Title\n```sh\nnpm test\n```\n````\nList what is missing.";
    expect(taskOwnWordChars(nested)).toBe("Review this README:\nList what is missing.".length);
    const tilde = "Explain:\n~~~\n```\nnot a closer\n~~~\nBriefly.";
    expect(taskOwnWordChars(tilde)).toBe("Explain:\nBriefly.".length);
  });
});

describe("staged artifact build — directive", () => {
  const directive = buildStagedArtifactBuildGuidance();

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

  it("carries no run-derived number: the head is the KV-cache key", () => {
    // The directive used to say "about 11 of them". What the effort tier changes about a
    // sub-agent is maxIterations plus the model overlay — enableThinking, reasoningEffort and
    // (only for an agent that already pinned one) maxTokens — and NONE of those render into
    // the head; maxIterations did, through this interpolated count, so every tier owned its
    // own cold head. The measurement behind that is the station probe: a byte-identical head
    // restored from host RAM after 8 evictions (16 tokens processed), while a head differing
    // by one number is a full cold prefill.
    expect(directive).not.toMatch(/about \d+ of them/);
    expect(directive).not.toMatch(/\b(?:11|24)\b/);
    // ...and the FILL step still tells the model where the count went.
    expect(directive).toContain("2. FILL (one subsystem per iteration; the task states how many passes you have)");
  });

  it("derives the pass budget from the run's own iteration cap — in the USER turn", () => {
    // Reserve the skeleton, the verification read and the tool-stripped final synthesis.
    expect(buildStagedBuildFirstStepInstruction(14, 24)).toContain("about 11 fill passes");
    expect(buildStagedBuildFirstStepInstruction(10, 24)).toContain("about 7 fill passes");
  });

  it("never promises more passes than PER_PATH_EDIT_CAP allows", () => {
    // Discriminates against a fixed pass budget: with an unbounded iteration cap the
    // instruction must still stop at the harness ceiling, or the agent plans 30 fills and
    // gets blocked at the cap with the artifact half-stubbed.
    expect(buildStagedBuildFirstStepInstruction(Number.MAX_SAFE_INTEGER, 24)).toContain("about 24 fill passes");
    // ...and a tiny iteration budget never goes below a floor of 2.
    expect(buildStagedBuildFirstStepInstruction(3, 24)).toContain("about 2 fill passes");
  });

  it("keeps the first-step sentences the count was added next to", () => {
    const instruction = buildStagedBuildFirstStepInstruction(14, 24);
    expect(instruction).toContain("THIS TURN: the specification above is REFERENCE MATERIAL for later passes, not the work of this turn.");
    expect(instruction).toContain("Decide only what the parts are CALLED, not how they work.");
    expect(instruction).toContain("Do not attempt to satisfy the specification in this turn. You have further turns for that, one part at a time.");
    // The count sits between naming the parts and the closing "do not attempt" line.
    expect(instruction.indexOf("about 11 fill passes")).toBeGreaterThan(instruction.indexOf("CALLED"));
    expect(instruction.indexOf("about 11 fill passes")).toBeLessThan(instruction.indexOf("Do not attempt"));
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
  /**
   * The first USER turn of the captured run.
   *
   * Separate from the system prompt because placement is the entire point of the
   * first-step instruction: run dfe964f3 logged `directiveInjected: true` and burned
   * 45,001 characters anyway. The strategy was in the system prompt; the specification
   * the model was actually answering was in the user turn. A test that only reads the
   * system prompt cannot tell those two situations apart.
   */
  let firstUserTurn = "";

  const runAndCaptureSystemPrompt = async (
    orchestration: Record<string, unknown> | undefined,
    task: string,
    tools: string[],
    workspaceDir?: string,
    /** Stands in for the effort tier's sub-agent budget (200 under tier max). */
    maxIterationsOverride?: number,
    /** What the delegating call declared, as tools/sub-agent.ts hands it to the runner. */
    deliverable?: "file" | "answer",
  ): Promise<string> => {
    const tempDir = workspaceDir ?? mkdtempSync(join(tmpdir(), "sai-staged-build-"));
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
      firstUserTurn = messages.find((m) => m.role === "user")?.content ?? "";
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
      ...(maxIterationsOverride !== undefined ? { maxIterationsOverride } : {}),
      ...(deliverable ? { deliverable } : {}),
    });
    return systemPrompt;
  };

  it("sends the SAME system prompt bytes under a 14- and a 200-iteration budget", async () => {
    // THE CACHE-KEY PROBE. The effort tier changes maxIterations and nothing else about
    // the agent, and the head used to carry "about 11 of them" vs "about 24 of them" —
    // one number, two cold prefills. Compare the bytes that went on the wire.
    // One workspace for both runs: the head names it ("Current workspace: ..."), and
    // that is a function of the AGENT's deployment, not of the tier.
    const shared = mkdtempSync(join(tmpdir(), "sai-staged-tier-"));
    const tools = ["read_file", "write_file", "edit_file", "list_files", "grep_files"];
    const flags = { stagedArtifactBuilds: true, stagedArtifactBuildDirective: true };
    const at14 = await runAndCaptureSystemPrompt(flags, OBSERVED_BUILD_TASK, tools, shared, 14);
    const userTurnAt14 = firstUserTurn;
    const at200 = await runAndCaptureSystemPrompt(flags, OBSERVED_BUILD_TASK, tools, shared, 200);
    const userTurnAt200 = firstUserTurn;
    rmSync(shared, { recursive: true, force: true });

    expect(at14).toContain("STAGED BUILD — THIS TASK IS TOO LARGE FOR ONE PASS.");
    expect(at200).toBe(at14);
    // The budget still reaches the model — in the user turn, sized from the run's own cap
    // (14 - 3 = 11; 200 - 3 clamped to PER_PATH_EDIT_CAP = 24).
    expect(userTurnAt14).toContain("about 11 fill passes");
    expect(userTurnAt200).toContain("about 24 fill passes");
    expect(userTurnAt14).not.toContain("about 24 fill passes");
  });

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

  it("REGRESSION run 3959f3ac — what this DEPLOYMENT ships injects it, and the audit says so", async () => {
    // Every other assertion here hands the flag in by hand, which is why the suite stayed
    // green while the value that actually SHIPPED was false and `directiveInjected` was false
    // on a run with every precondition met. So this one reads the number that ships.
    //
    // It reads it from the config SHARD, not from the schema default: the directive rewrites
    // the system prompt of 39 of the 49 shipped agents, so it defaults OFF for anyone who
    // forks this repo and is turned ON here, next to the measurement that justifies it. The
    // regression this test exists for is "the deployment believes it is on while the model
    // never sees a word of it" — and that is a question about the shard.
    const shard = JSON5.parse(readFileSync(
      new URL("../../../../config/gateway/40-orchestration.jsonc", import.meta.url), "utf8",
    )) as { orchestration?: Record<string, unknown> };
    expect(shard.orchestration?.["stagedArtifactBuilds"]).toBe(true);
    expect(shard.orchestration?.["stagedArtifactBuildDirective"]).toBe(true);

    expect(OBSERVED_BUILD_TASK.trim().length).toBe(RUN_3959F3AC_TASK_CHARS);

    const prompt = await runAndCaptureSystemPrompt(
      {
        stagedArtifactBuilds: shard.orchestration?.["stagedArtifactBuilds"],
        stagedArtifactBuildDirective: shard.orchestration?.["stagedArtifactBuildDirective"],
      },
      OBSERVED_BUILD_TASK,
      // backend_coder's effective toolset, trimmed to what the classifier reads.
      ["read_file", "write_file", "edit_file", "list_files", "grep_files", "serve_app", "verify_app"],
    );

    // The guidance text is in the messages the provider was actually handed.
    expect(prompt).toContain("STAGED BUILD — THIS TASK IS TOO LARGE FOR ONE PASS.");
    expect(prompt).toContain(UNFINISHED_STUB_MARKER);
    // ...and the pass budget is NOT in it (the head is the cache key); it is sized from
    // this run's own iteration cap in the user turn instead.
    expect(prompt).not.toMatch(/about \d+ of them/);
    expect(firstUserTurn).toContain("about 11 fill passes");

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

  it("REGRESSION cart assessment — a question about pasted code gets no staged directive", async () => {
    // code_analyst held write_file and edit_file and received a 681-char "why" question,
    // about 420 chars of it cart.js. The directive and its user-turn line ("produce only the
    // skeleton — one write_file call") made it write a report file with four markers.
    const prompt = await runAndCaptureSystemPrompt(
      { stagedArtifactBuilds: true, stagedArtifactBuildDirective: true },
      CART_TASK_FENCE_IN_LINE,
      WRITE_AND_EDIT,
    );
    expect(prompt).toContain("You build files.");
    expect(prompt).not.toContain("STAGED BUILD");
    expect(firstUserTurn).toContain("cartTotal");
    expect(firstUserTurn).not.toContain("THIS TURN:");
    expect(logAuditMock.mock.calls.some((args) => args[0] === "sub_agent_staged_build_detected")).toBe(false);
  });

  it("the audit reports the size the classifier compared, not the code pasted with it", async () => {
    const specWithCode = `${OBSERVED_BUILD_TASK}\n\`\`\`js\n${CART_JS}\n\`\`\``;
    const prompt = await runAndCaptureSystemPrompt(
      { stagedArtifactBuilds: true, stagedArtifactBuildDirective: true },
      specWithCode,
      WRITE_AND_EDIT,
    );
    expect(prompt).toContain("STAGED BUILD — THIS TASK IS TOO LARGE FOR ONE PASS.");
    expect(logAuditMock).toHaveBeenCalledWith(
      "sub_agent_staged_build_detected",
      expect.objectContaining({ taskChars: RUN_3959F3AC_TASK_CHARS, threshold: STAGED_BUILD_TASK_CHAR_THRESHOLD }),
      expect.anything(),
    );
  });

  it("a builder handed its spec in a fence gets the directive, and the audit reports the whole task", async () => {
    const fencedSpec = `Build the page described below.\n\`\`\`\n${OBSERVED_BUILD_TASK}\n\`\`\``;
    const prompt = await runAndCaptureSystemPrompt(
      { stagedArtifactBuilds: true, stagedArtifactBuildDirective: true },
      fencedSpec,
      [...WRITE_AND_EDIT, "verify_page"],
    );
    expect(prompt).toContain("STAGED BUILD — THIS TASK IS TOO LARGE FOR ONE PASS.");
    expect(logAuditMock).toHaveBeenCalledWith(
      "sub_agent_staged_build_detected",
      expect.objectContaining({ taskChars: fencedSpec.trim().length, threshold: STAGED_BUILD_TASK_CHAR_THRESHOLD }),
      expect.anything(),
    );
  });

  it("switches to RESUME when the workspace already holds unfilled markers", async () => {
    // THE REGRESSION PROBE for run 2dc5832c, and for the skeleton-first instruction added the
    // night before it. The classifier reads task size and tools, so a "finish the existing file"
    // delegation is indistinguishable from "build me one" — and it received "SKELETON (first tool
    // call): one write_file" plus a user turn saying "produce only the skeleton". The fourth run
    // obeyed exactly that and overwrote six filled subsystems with eight fresh markers.
    //
    // Revert either half (the resume branch in sub-agent.ts, or the `!isResumeBuild` condition on
    // the user-turn instruction) and this fails.
    const seeded = mkdtempSync(join(tmpdir(), "sai-staged-resume-"));
    mkdirSync(join(seeded, "generated", "game"), { recursive: true });
    writeFileSync(
      join(seeded, "generated", "game", "index.html"),
      `<script>throw new Error("${UNFINISHED_STUB_MARKER}: core");</script>`,
      "utf8",
    );

    const prompt = await runAndCaptureSystemPrompt(
      { stagedArtifactBuilds: true, stagedArtifactBuildDirective: true },
      OBSERVED_BUILD_TASK,
      ["read_file", "write_file", "edit_file", "list_files", "grep_files"],
      seeded,
    );

    expect(prompt).toContain("RESUME AN EXISTING BUILD");
    expect(prompt).toContain("NEVER call write_file");
    expect(prompt).not.toContain("STAGED BUILD — THIS TASK IS TOO LARGE FOR ONE PASS.");
    // ...and the user turn must NOT carry the skeleton-first instruction on a resume.
    expect(firstUserTurn).not.toContain("THIS TURN:");

    rmSync(seeded, { recursive: true, force: true });
  });

  it("narrows the USER turn too, because that is the turn the model answers", async () => {
    // Run dfe964f3: directive injected, preconditions met, 45,001 reasoning chars, zero
    // tools. The system prompt already said "SKELETON (first tool call): one write_file".
    // It lost to a 1,709-char specification of a finished artifact sitting in the user
    // turn. So the narrowing is repeated where the ask lives, LAST, demoting the spec to
    // reference material in the same breath as it names this turn's job.
    await runAndCaptureSystemPrompt(
      { stagedArtifactBuilds: true, stagedArtifactBuildDirective: true },
      OBSERVED_BUILD_TASK,
      ["read_file", "write_file", "edit_file", "list_files", "grep_files"],
    );

    expect(firstUserTurn).toContain("THIS TURN:");
    expect(firstUserTurn).toContain("REFERENCE MATERIAL");
    // Appended, never substituted — the spec is what lets the model NAME the subsystems.
    expect(firstUserTurn).toContain(OBSERVED_BUILD_TASK.trim().slice(0, 80));
    // ...and it is the LAST thing in the turn, after the spec.
    expect(firstUserTurn.indexOf("THIS TURN:")).toBeGreaterThan(
      firstUserTurn.indexOf(OBSERVED_BUILD_TASK.trim().slice(0, 80)),
    );
  });

  it("leaves the user turn untouched when the directive is off", async () => {
    // THE DISCRIMINATOR, and the gate that keeps the two halves from disagreeing: the
    // user-turn narrowing hangs off the SAME condition as the system directive, so a
    // deployment with the directive disabled behaves exactly as it did before this existed.
    await runAndCaptureSystemPrompt(
      { stagedArtifactBuilds: true, stagedArtifactBuildDirective: false },
      OBSERVED_BUILD_TASK,
      ["read_file", "write_file", "edit_file", "list_files", "grep_files"],
    );

    expect(firstUserTurn).not.toContain("THIS TURN:");
    expect(firstUserTurn).toContain(OBSERVED_BUILD_TASK.trim().slice(0, 80));
  });

  it("gives a FRESH build no skeleton directive when the run holds a one-shot assembler", async () => {
    // E2E core-build-artifact-revealjs-deck: content_writer, handed a deck task past the threshold,
    // was told "SKELETON (first tool call): one write_file" and hand-wrote index.html instead of
    // calling generate_presentation. Its shipped tool set, the same deck task.
    expect(DECK_TASK.trim().length).toBeGreaterThan(800);
    expect(DECK_TASK.trim().length).toBeLessThan(1000);
    const contentWriterTools = loadWorkspaceAgents<{ tools?: string[] }>()["content_writer"]?.tools ?? [];
    expect(contentWriterTools).toEqual(expect.arrayContaining(["write_file", "edit_file", "generate_presentation"]));
    expect(isStagedArtifactBuildRun(contentWriterTools, DECK_TASK)).toBe(true);

    const prompt = await runAndCaptureSystemPrompt(
      { stagedArtifactBuilds: true, stagedArtifactBuildDirective: true },
      DECK_TASK,
      contentWriterTools,
    );

    expect(prompt).toContain("You build files.");
    expect(prompt).not.toContain("STAGED BUILD");
    expect(firstUserTurn).toContain(DECK_TASK.slice(0, 60));
    expect(firstUserTurn).not.toContain("THIS TURN:");
    // Still classified, so the audit row and the rest of the staged-build handling are unchanged.
    expect(logAuditMock).toHaveBeenCalledWith(
      "sub_agent_staged_build_detected",
      expect.objectContaining({ mode: "fresh", directiveInjected: false }),
      expect.anything(),
    );
  });

  it("still gives the same deck task the directive in a run without an assembler", async () => {
    const prompt = await runAndCaptureSystemPrompt(
      { stagedArtifactBuilds: true, stagedArtifactBuildDirective: true },
      DECK_TASK,
      WRITE_AND_EDIT,
    );
    expect(prompt).toContain("STAGED BUILD — THIS TASK IS TOO LARGE FOR ONE PASS.");
    expect(firstUserTurn).toContain("THIS TURN:");
    expect(logAuditMock).toHaveBeenCalledWith(
      "sub_agent_staged_build_detected",
      expect.objectContaining({ mode: "fresh", directiveInjected: true }),
      expect.anything(),
    );
  });

  it("keeps the directive for web_coder, which hand-builds pages beside generate_website", async () => {
    const webCoderTools = loadWorkspaceAgents<{ tools?: string[] }>()["web_coder"]?.tools ?? [];
    expect(webCoderTools).toEqual(expect.arrayContaining(["write_file", "edit_file", "generate_website"]));
    expect(webCoderTools.some((tool) => ONE_SHOT_ASSEMBLER_TOOLS.has(tool))).toBe(false);
    const prompt = await runAndCaptureSystemPrompt(
      { stagedArtifactBuilds: true, stagedArtifactBuildDirective: true },
      OBSERVED_BUILD_TASK,
      webCoderTools,
    );
    expect(prompt).toContain("STAGED BUILD — THIS TASK IS TOO LARGE FOR ONE PASS.");
    expect(firstUserTurn).toContain("THIS TURN:");
  });

  it("does not stage a run declared deliverable \"answer\", and stages the same run undeclared or declared \"file\"", async () => {
    // E2E new-delegation-routing-bounded-fanout (session 62b04e8b): lookup steps reached
    // browser_agent past the threshold with the turn's objective and criteria, were staged, and
    // spent 329 s and 612 s writing files instead of navigating. Each had declared "answer".
    const browserAgentTools = loadWorkspaceAgents<{ tools?: string[] }>()["browser_agent"]?.tools ?? [];
    expect(browserAgentTools).toEqual(expect.arrayContaining(["write_file", "edit_file", "browser_navigate"]));
    expect(PLAN_STEP_LOOKUP_TASK.length).toBeGreaterThan(STAGED_BUILD_TASK_CHAR_THRESHOLD);
    expect(PLAN_STEP_LOOKUP_TASK.length).toBeLessThan(700);
    expect(isStagedArtifactBuildRun(browserAgentTools, PLAN_STEP_LOOKUP_TASK)).toBe(true);
    const flags = { stagedArtifactBuilds: true, stagedArtifactBuildDirective: true };
    const audited = () => logAuditMock.mock.calls.some((args) => args[0] === "sub_agent_staged_build_detected");

    const answer = await runAndCaptureSystemPrompt(flags, PLAN_STEP_LOOKUP_TASK, browserAgentTools, undefined, undefined, "answer");
    expect(answer).toContain("You build files.");
    expect(answer).not.toContain("STAGED BUILD");
    expect(firstUserTurn).toContain("NW-3102");
    expect(firstUserTurn).not.toContain("THIS TURN:");
    expect(audited()).toBe(false);

    for (const deliverable of [undefined, "file"] as const) {
      logAuditMock.mockReset();
      const prompt = await runAndCaptureSystemPrompt(flags, PLAN_STEP_LOOKUP_TASK, browserAgentTools, undefined, undefined, deliverable);
      expect(prompt, String(deliverable)).toContain("STAGED BUILD — THIS TASK IS TOO LARGE FOR ONE PASS.");
      expect(audited(), String(deliverable)).toBe(true);
    }
  });

  it("still RESUMES an unfinished build in a run that holds a one-shot assembler", async () => {
    const seeded = mkdtempSync(join(tmpdir(), "sai-staged-resume-assembler-"));
    mkdirSync(join(seeded, "generated", "deck"), { recursive: true });
    writeFileSync(
      join(seeded, "generated", "deck", "index.html"),
      `<script>throw new Error("${UNFINISHED_STUB_MARKER}: slides");</script>`,
      "utf8",
    );
    const prompt = await runAndCaptureSystemPrompt(
      { stagedArtifactBuilds: true, stagedArtifactBuildDirective: true },
      DECK_TASK,
      [...WRITE_AND_EDIT, "generate_presentation"],
      seeded,
    );
    expect(prompt).toContain("RESUME AN EXISTING BUILD");
    rmSync(seeded, { recursive: true, force: true });
  });

  it("does not ask an assembler run for a skeleton after a reasoning burn", async () => {
    // The burn correction names the skeleton for a staged build. Without the directive, that line
    // would be the run's only skeleton instruction, and it points at write_file again.
    const burnThenDone = async (tools: string[]): Promise<string> => {
      // Writes the agent's config; the answer it is given here is replaced below.
      await runAndCaptureSystemPrompt(
        { stagedArtifactBuilds: true, stagedArtifactBuildDirective: true },
        DECK_TASK,
        tools,
      );
      let calls = 0;
      const userTurns: string[] = [];
      completeMock.mockReset();
      completeMock.mockImplementation((messages: Array<{ role: string; content: string }>) => {
        calls++;
        userTurns.push(messages.filter((m) => m.role === "user").at(-1)?.content ?? "");
        return calls === 1
          ? {
              content: null,
              reasoning: "r".repeat(45_000),
              tool_calls: [],
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
              finishReason: "length",
              truncatedBy: "reasoning_burn",
            }
          : { content: "Done.", tool_calls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "stop" };
      });
      const workspace = mkdtempSync(join(tmpdir(), "sai-staged-burn-"));
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      await runSubAgentWithStats({
        agentName: "staged_builder",
        task: DECK_TASK,
        parentSessionId: `parent-${Math.random().toString(36).slice(2)}`,
        workspacePath: workspace,
      });
      rmSync(workspace, { recursive: true, force: true });
      expect(calls).toBeGreaterThanOrEqual(2);
      return userTurns[1] ?? "";
    };

    const assemblerCorrection = await burnThenDone([...WRITE_AND_EDIT, "generate_presentation"]);
    expect(assemblerCorrection).toContain("STOP PLANNING");
    expect(assemblerCorrection).not.toContain("skeleton");
    const plainCorrection = await burnThenDone(WRITE_AND_EDIT);
    expect(plainCorrection).toContain("STOP PLANNING");
    expect(plainCorrection).toContain("skeleton");
  });

  it("keeps the agent's own prompt LAST so its finish contract outranks the directive", async () => {
    // backend_coder must end on serve_app + verify_app + the live /api/app/<id>/ URL.
    // Appended after the agent prompt, the directive's generic "FINISH ... report the
    // path" was the last thing the model read — which is the shape of the run that
    // wrote five files and never served them. Order is the guard.
    const prompt = await runAndCaptureSystemPrompt(
      { stagedArtifactBuilds: true, stagedArtifactBuildDirective: true },
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
  type Agent = { systemPrompt?: string; maxIterations?: number; turnTimeoutMs?: number };
  // Per-ENTRY merge — see support/workspace-shards.ts.
  const subAgents: Record<string, Agent> = loadWorkspaceAgents<Agent>();

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
    // Reverting the shard to 10 makes this "about 7 fill passes" and the assertion fails.
    const contentWriter = subAgents["content_writer"];
    expect(contentWriter).toBeDefined();
    const promise = buildStagedBuildFirstStepInstruction(contentWriter?.maxIterations ?? 0, 24);
    expect(promise).toContain("about 11 fill passes");
    expect(promise).toBe(buildStagedBuildFirstStepInstruction(subAgents["web_coder"]?.maxIterations ?? 0, 24));
  });

  it("leaves an execution agent on its own budget rather than raising everything", () => {
    // Discriminates against "bump every maxIterations": coder builds files too, but its
    // deliverable is a run result on a 15-minute clock, so it is untouched at 10.
    expect(subAgents["coder"]?.maxIterations).toBe(10);
    expect(builders.map(([name]) => name)).not.toContain("coder");
  });
});
