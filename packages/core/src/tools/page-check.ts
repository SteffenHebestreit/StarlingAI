/**
 * verify_page — RUN a built page's JavaScript and report what it throws.
 *
 * THE GAP THIS FILLS. Nothing in this harness has ever executed the code it ships. serve_app
 * starts a container, verify_app fetches it over HTTP, and its own description concedes the
 * limit: "For a CLIENT-RENDERED app (map/canvas/SPA) it returns 'PASS (server) — RENDER
 * UNCONFIRMED' because a server fetch only proves the shell loaded, not that the UI painted."
 * A page whose script dies on line 1 still answers 200.
 *
 * Run 2dc5832c is what that costs. The delivered file opened with
 * `throw new Error("UNFINISHED_STUB: core")`, the artifact probe reported PASS, the assistant
 * told the user in a formatted table that the game was fully playable, and the USER'S BROWSER
 * was the first thing in the loop to actually run it. The same file also called
 * `document.getElementById("board")` for an element the HTML names `board-canvas` — a
 * guaranteed TypeError that no amount of reading the diff catches and one execution does.
 *
 * WHY A SHIM AND NOT A BROWSER. The real browser lives in a separate CDP container that is
 * often not running, and a self-check the builder skips when the stack is cold is not a check.
 * This needs no dependency, no container and no network, so it can be the routine step before
 * "done". It is deliberately NOT a rendering test: it proves the script parses, initialises,
 * and survives one animation frame. That is the band almost every measured failure sat in.
 *
 * `vm` IS NOT A SANDBOX, SO THE PAGE DOES NOT RUN HERE. It isolates globals, not realms: every
 * host function the shim puts in the context hands the page `.constructor`, and through it the
 * host `Function` — `document.getElementById.constructor("return process")()` returns the real
 * `process`, with the gateway's environment and `child_process` behind it. Measured: that page
 * read 125 env keys, ran `execSync`, and wrote outside the workspace while this check reported
 * it healthy. And it needs no tool call, because the artifact probe executes every delivered
 * .html on its own.
 *
 * So execution moved out of this process entirely (runScriptsIsolated → page-check-worker.ts):
 * a child node with a scrubbed environment, a working directory in the OS temp dir, a hard
 * kill, and no shared memory with the gateway. An escape there finds no secrets, no sessions
 * and no event loop to block. The child runs as the same OS user and can still reach the
 * filesystem — full containment belongs to the sandbox runner (shell_exec / run_script); this
 * is the bounded check that can run on every build without one.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { judgeCanvasPainting, type CanvasPaintReport } from "./canvas-geometry.js";
import { childLogger } from "../logger.js";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { resolvePathWithinWorkspace } from "./workspace-path.js";
import {
  collectScripts,
  collectDeclaredElements,
  collectElementIds,
  type DeclaredElement,
  type RunReport,
  type ScriptSource,
} from "./page-check-runner.js";

export {
  collectScripts,
  collectDeclaredElements,
  collectElementIds,
  runScripts,
  type DeclaredElement,
  type RunReport,
  type ScriptSource,
} from "./page-check-runner.js";

const log = childLogger("tools:page-check");

/**
 * Parent-side ceiling on ONE isolated check. Deliberately well above the in-vm per-script
 * ceiling (3 s each, plus two frames) so the vm's own timeout produces a useful error message
 * first; this fires only for the cases the vm cannot see — a child wedged outside JS, or one
 * that never writes its answer.
 */
const ISOLATED_RUN_TIMEOUT_MS = 25_000;
/** A page cannot talk its way into unbounded parent memory. */
const ISOLATED_MAX_OUTPUT_BYTES = 4_000_000;

/**
 * How to start the worker, most-likely-correct first. Deployed we run compiled JS next to this
 * file; from source (vitest, `pnpm dev`) the sibling is still TypeScript, which recent Node
 * runs directly and older Node needs `tsx` for — tsx being the devDependency every other
 * source-mode entrypoint in this package already uses. The first candidate that answers is
 * cached, so the fallback costs one spawn per process, not one per check.
 */
function workerCommandCandidates(): string[][] {
  const candidates: string[][] = [];
  const compiled = fileURLToPath(new URL("./page-check-worker.js", import.meta.url));
  if (existsSync(compiled)) candidates.push([compiled]);
  const source = fileURLToPath(new URL("./page-check-worker.ts", import.meta.url));
  if (existsSync(source)) {
    candidates.push([source]);
    try {
      const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
      candidates.push(["--import", tsx, source]);
    } catch { /* tsx is a devDependency; absent in a production install, where the .js exists */ }
  }
  return candidates;
}
let workerCommand: string[] | undefined;

/**
 * The environment the page gets: as close to nothing as node will start with.
 *
 * This is the half of the isolation that matters most. An escape inside the child reaches a
 * `process` whose `env` holds no ANTHROPIC_API_KEY, no JWT secret, no Postgres URL — because
 * they were never handed down. NODE_OPTIONS is dropped deliberately too: inherited flags are a
 * way to smuggle a loader into the child.
 */
function scrubbedChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (process.platform === "win32") {
    // Windows resolves DLLs against these; node will not start cleanly without them.
    for (const key of ["SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP", "PATHEXT"]) {
      const value = process.env[key];
      if (value) env[key] = value;
    }
  }
  return env;
}

function spawnWorker(argv: string[], payload: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, {
      cwd: tmpdir(),                 // a relative write cannot reach the workspace
      env: scrubbedChildEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const killTimer = setTimeout(() => {
      // The vm timeout bounds JS; this bounds everything else. SIGKILL because a page that got
      // this far has already ignored one deadline.
      child.kill("SIGKILL");
    }, ISOLATED_RUN_TIMEOUT_MS);
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      fn();
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length > ISOLATED_MAX_OUTPUT_BYTES) { child.kill("SIGKILL"); return; }
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 8_000) stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => finish(() => reject(err)));
    child.on("close", (code) => finish(() => resolve({ code, stdout, stderr })));
    child.stdin.on("error", () => { /* the child died before reading; `close` reports it */ });
    child.stdin.end(payload);
  });
}

/**
 * Run a page's scripts in a child process and bring the report home.
 *
 * `null` means the check could not be RUN — no worker on disk, a spawn that failed, a child
 * that answered with nothing parseable. That is not evidence about the page, and every caller
 * treats it that way: a harness failure must never invent a defect.
 */
export async function runScriptsIsolated(
  scripts: ScriptSource[],
  ids: Set<string>,
  declared: Map<string, DeclaredElement>,
): Promise<RunReport | null> {
  const payload = JSON.stringify({ scripts, ids: [...ids], declared: [...declared.entries()] });
  const candidates = workerCommand ? [workerCommand] : workerCommandCandidates();
  let lastStderr = "";
  for (const argv of candidates) {
    let result: { code: number | null; stdout: string; stderr: string };
    try {
      result = await spawnWorker(argv, payload);
    } catch (err) {
      lastStderr = err instanceof Error ? err.message : String(err);
      continue;
    }
    if (!result.stdout.trim()) {
      // A killed child (hung page) exits without writing. That IS a verdict about the page,
      // not a broken harness — but only once we know this command works at all.
      if (workerCommand && result.code !== 0) {
        return {
          errors: [`the page did not finish within ${Math.round(ISOLATED_RUN_TIMEOUT_MS / 1000)}s and was stopped`],
          consoleErrors: [], framesRun: 0, canvasPainting: new Map(),
        };
      }
      lastStderr = result.stderr;
      continue;
    }
    try {
      const parsed = JSON.parse(result.stdout) as {
        errors: string[]; consoleErrors: string[]; framesRun: number;
        canvases: Array<[string, CanvasPaintReport]>;
      };
      workerCommand = argv;
      return {
        errors: parsed.errors ?? [],
        consoleErrors: parsed.consoleErrors ?? [],
        framesRun: parsed.framesRun ?? 0,
        canvasPainting: new Map((parsed.canvases ?? []).map(([id, report]) => [id, () => report])),
      };
    } catch {
      lastStderr = result.stderr || result.stdout.slice(0, 500);
    }
  }
  log.warn({ stderr: lastStderr.slice(0, 500) }, "page check could not start its isolated runner");
  return null;
}

/**
 * Is this built page actually working? The same judgement verify_page makes, callable from
 * the runner rather than only by an agent that remembers to ask.
 *
 * WHY THIS EXISTS. Resume detection asks one question — are there unfilled markers on disk —
 * and treats a build with none as finished. Run 9 reached zero markers and left a page whose
 * first script dies on `SyntaxError: Identifier 'started' has already been declared`; the
 * previous run left one that runs and paints its playfield off the side of its own canvas.
 * Both look complete to a marker count, so the orchestrator had nothing to resume and simply
 * stopped. A build is not done because the placeholders are gone; it is done when the thing
 * it built works.
 */
export async function checkBuiltPage(absHtmlPath: string, relLabel: string): Promise<{ ok: boolean; detail: string }> {
  let html: string;
  try {
    html = readFileSync(absHtmlPath, "utf-8");
  } catch {
    return { ok: true, detail: "" };   // unreadable is not evidence of breakage
  }
  const { scripts, externalMisses } = collectScripts(html, absHtmlPath);
  if (scripts.length === 0 && externalMisses.length === 0) return { ok: true, detail: "" };

  let report: RunReport | null;
  try {
    report = await runScriptsIsolated(scripts, collectElementIds(html), collectDeclaredElements(html));
  } catch {
    return { ok: true, detail: "" };   // a harness failure must never invent a defect
  }
  if (!report) return { ok: true, detail: "" };   // the check could not run; that is not a defect

  const problems = [...report.errors, ...report.consoleErrors.map((c) => `console.error — ${c}`)];
  // A REF THIS PROBE CANNOT OPEN IS NOT PROOF THE PAGE IS BROKEN.
  //
  // The sibling `self_contained` receipt reports the very same references and is deliberately
  // SOFT, because a multi-file site is a legitimate deliverable and a part may still be on its
  // way to disk. This verdict is HARD — it downgrades a finished build to "partial" and can
  // spend a corrective build — so it fires only when the misses leave the page with nothing to
  // run at all, which is unambiguous whatever the page intended. The verify_page tool still
  // names every miss to the agent, where it is advice rather than a gate.
  if (externalMisses.length > 0 && scripts.length === 0) {
    problems.push(`no runnable script: the page loads ${externalMisses.join(", ")}, which is not on disk`);
  }
  const canvasReports = [...report.canvasPainting.entries()].map(([id, read]) => [id, read()] as const);
  const anyPainted = canvasReports.some(([, r]) => r.drawCalls > 0);
  for (const [id, r] of canvasReports) {
    const verdict = judgeCanvasPainting(id, r, anyPainted && r.drawCalls === 0);
    if (verdict.status === "fail") problems.push(verdict.detail);
  }

  if (problems.length === 0) return { ok: true, detail: "" };
  return { ok: false, detail: `${relLabel}: ${problems[0]}` };
}

registerTool({
  name: "verify_page",
  description:
    "RUN a built HTML page's JavaScript and report what it throws, BEFORE you report the page as done. "
    + "Loads the file from the workspace, executes every inline and same-folder <script> against a minimal DOM, "
    + "then pumps two animation frames so the render path runs too. Catches what reading the code does not: "
    + "syntax errors, an element id the script asks for but the HTML does not define, a function called before "
    + "it is defined, undefined property access in the draw loop, and any placeholder that throws. "
    + "Returns PASS or the exact error with its script and message — on FAIL, fix that error and run it again. "
    + "This is a logic check, not a rendering check: it proves the page boots and survives a frame, not that it looks right.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative path to the .html file to run (e.g. 'generated/game/index.html')." },
    },
    required: ["path"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const rel = String(args["path"] ?? "").trim();
    if (!rel) {
      return { success: false, output: "", error: "path is required — the workspace-relative .html file to run." };
    }
    let resolved: string;
    try {
      // Throws on escape, and re-roots under generated/ for scope-confined agents — the same
      // resolution read_file uses, so a path the builder just wrote resolves to that same file.
      ({ resolved } = resolvePathWithinWorkspace(rel, ctx.workspacePath));
    } catch (err) {
      return { success: false, output: "", error: err instanceof Error ? err.message : "Path escapes workspace boundary" };
    }
    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      return { success: false, output: "", error: `No such file in the workspace: '${rel}'. Use list_files to find the built page.` };
    }

    let html: string;
    try {
      html = readFileSync(resolved, "utf-8");
    } catch (err) {
      return { success: false, output: "", error: `Could not read '${rel}': ${err instanceof Error ? err.message : String(err)}` };
    }

    const { scripts, externalMisses } = collectScripts(html, resolved);
    const ids = collectElementIds(html);
    const declared = collectDeclaredElements(html);

    if (scripts.length === 0) {
      const missNote = externalMisses.length > 0
        ? ` The page references ${externalMisses.length} local script file(s) that do not exist: ${externalMisses.join(", ")} — the page would load with no behaviour at all.`
        : "";
      return {
        success: externalMisses.length === 0,
        output: externalMisses.length === 0
          ? `PASS — '${rel}' contains no scripts to run (static page).`
          : "",
        ...(externalMisses.length > 0 ? { error: `FAIL — '${rel}' has no runnable script.${missNote}` } : {}),
      };
    }

    let report: RunReport | null;
    try {
      report = await runScriptsIsolated(scripts, ids, declared);
    } catch (err) {
      log.error({ err, path: rel }, "verify_page harness failure");
      return { success: false, output: "", error: `verify_page could not run '${rel}': ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!report) {
      // Say so rather than passing the page: an agent that reads "PASS" here would take it as
      // evidence the build works, which is exactly the claim this check could not make.
      return {
        success: false,
        output: "",
        error: `verify_page could not start its isolated runner, so '${rel}' was NOT checked. This is a harness problem, not a defect in your page — do not treat it as either a pass or a failure.`,
      };
    }

    const problems = [...report.errors, ...report.consoleErrors.map((c) => `console.error — ${c}`)];
    if (externalMisses.length > 0) {
      problems.push(`missing local script file(s) the page loads: ${externalMisses.join(", ")}`);
    }

    // WHERE THE PAGE PAINTED, not merely whether it survived painting. neon-tetris passed
    // every check above — one script, two animation frames, no errors — and drew its
    // playfield off the side of its own canvas. Code that throws is caught by the errors
    // above; code that is confidently wrong about geometry is only caught here.
    const canvasReports = [...report.canvasPainting.entries()].map(([id, read]) => [id, read()] as const);
    const anyPainted = canvasReports.some(([, r]) => r.drawCalls > 0);
    const canvasVerdicts = canvasReports.map(([id, r]) => judgeCanvasPainting(id, r, anyPainted && r.drawCalls === 0));
    for (const verdict of canvasVerdicts) {
      if (verdict.status === "fail") problems.push(verdict.detail);
    }

    if (problems.length > 0) {
      return {
        success: false,
        output: "",
        error: `FAIL — '${rel}' does not run:\n`
          + problems.map((p) => `  - ${p}`).join("\n")
          + `\n\nFix the FIRST error above (the later ones are usually its consequences), then call verify_page again. `
          + `Known element ids in this page: ${[...ids].slice(0, 12).join(", ") || "(none)"}.`,
        metadata: { path: rel, errors: report.errors, consoleErrors: report.consoleErrors, scripts: scripts.length },
      };
    }

    return {
      success: true,
      output: `PASS — '${rel}' runs: ${scripts.length} script(s) executed, ${report.framesRun} animation frame(s) survived, no uncaught errors.`
        + (canvasVerdicts.length > 0
          ? "\n" + canvasVerdicts.map((v) => `  - ${v.detail}`).join("\n")
          : "")
        + "\n(Logic and drawing-geometry check. It does not judge colour, layout or whether the result looks GOOD — "
        + "if you can render or screenshot the page, look at it before calling it done.)",
      metadata: {
        path: rel, scripts: scripts.length, framesRun: report.framesRun,
        canvases: canvasVerdicts.length,
      },
    };
  },
});

