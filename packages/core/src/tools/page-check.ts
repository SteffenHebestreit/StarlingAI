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
 * NOT A SECURITY SANDBOX. `vm` isolates globals, not the process, so the context is built
 * bare — no require, no process, no passthrough to the host globalThis — and every run is
 * wall-clock bounded. It executes the swarm's own generated front-end code, which this system
 * already runs far less carefully inside serve_app containers.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { createRecordingContext, judgeCanvasPainting, type CanvasPaintReport } from "./canvas-geometry.js";
import { createContext, runInContext } from "node:vm";
import { childLogger } from "../logger.js";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { resolvePathWithinWorkspace } from "./workspace-path.js";

const log = childLogger("tools:page-check");

/** Wall-clock ceiling for one script. A game loop that never yields must not hang the gateway. */
const SCRIPT_TIMEOUT_MS = 3_000;
/** Frames pumped after load, so the render path runs and not merely the declarations. */
const FRAMES_TO_PUMP = 2;

interface ScriptSource {
  label: string;
  code: string;
}

/** Inline <script> bodies plus same-directory <script src> files, in document order. */
export function collectScripts(html: string, htmlPath: string): { scripts: ScriptSource[]; externalMisses: string[] } {
  const scripts: ScriptSource[] = [];
  const externalMisses: string[] = [];
  const tagRe = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = tagRe.exec(html)) !== null) {
    index++;
    const attrs = match[1] ?? "";
    const body = match[2] ?? "";
    // Skip data blocks (application/json, importmap, text/template …). Only real JS is executed.
    const typeMatch = /type\s*=\s*["']([^"']+)["']/i.exec(attrs);
    const type = typeMatch?.[1]?.toLowerCase();
    if (type && !/javascript|module/.test(type)) continue;

    const srcMatch = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs);
    if (srcMatch?.[1]) {
      const ref = srcMatch[1];
      if (/^(https?:)?\/\//i.test(ref)) continue; // remote — out of scope, never fetched
      const abs = resolvePath(dirname(htmlPath), ref);
      if (existsSync(abs) && statSync(abs).isFile()) {
        scripts.push({ label: ref, code: readFileSync(abs, "utf-8") });
      } else {
        externalMisses.push(ref);
      }
      continue;
    }
    if (body.trim()) scripts.push({ label: `inline script #${index}`, code: body });
  }
  return { scripts, externalMisses };
}

/** Element ids the document actually defines — the set getElementById may resolve. */
export function collectElementIds(html: string): Set<string> {
  const ids = new Set<string>();
  const re = /\bid\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[1]) ids.add(m[1]);
  }
  return ids;
}

interface RunReport {
  errors: string[];
  consoleErrors: string[];
  framesRun: number;
  /** Where the page actually painted, per canvas it touched. Empty for a page with none. */
  canvasPainting: Map<string, () => CanvasPaintReport>;
}

/**
 * Minimal DOM. getElementById returns null for an id the HTML does NOT define, which is the
 * whole point: that mismatch is invisible to review and fatal at runtime, and it is exactly
 * what shipped in run 2dc5832c (`getElementById("board")` against `id="board-canvas"`).
 */
function buildDomContext(ids: Set<string>, report: RunReport): Record<string, unknown> {
  const noop = (): void => {};
  const makeCtx2d = (): Record<string, unknown> => new Proxy({}, {
    get: (_t, prop) => {
      if (prop === "canvas") return makeElement("canvas");
      if (prop === "measureText") return () => ({ width: 0 });
      if (prop === "getImageData") return () => ({ data: new Uint8ClampedArray(4) });
      if (prop === "createLinearGradient" || prop === "createRadialGradient") {
        return () => ({ addColorStop: noop });
      }
      return typeof prop === "string" ? noop : undefined;
    },
    set: () => true,
  });

  const makeElement = (tag: string, id?: string): Record<string, unknown> => {
    // One recorder per canvas element, created lazily on the first getContext so a page that
    // never draws still reports zero draw calls rather than nothing at all.
    let recording: { ctx: Record<string, unknown>; report: () => CanvasPaintReport } | undefined;
    const el: Record<string, unknown> = {
      tagName: tag.toUpperCase(),
      style: {},
      classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
      dataset: {},
      width: 300,
      height: 600,
      clientWidth: 300,
      clientHeight: 600,
      textContent: "",
      innerHTML: "",
      appendChild: noop,
      removeChild: noop,
      setAttribute: noop,
      getAttribute: () => null,
      addEventListener: noop,
      removeEventListener: noop,
      focus: noop,
      getBoundingClientRect: () => ({ x: 0, y: 0, width: 300, height: 600, top: 0, left: 0, right: 300, bottom: 600 }),
      getContext: (kind?: unknown) => {
        // Only 2D is recorded. A WebGL page paints through a completely different API and
        // guessing at its geometry would be worse than admitting we cannot see it.
        if (kind !== undefined && String(kind) !== "2d") return makeCtx2d();
        if (!recording) {
          // Getters, not values: the page may resize this canvas after taking its context.
          recording = createRecordingContext(
            () => Number(el["width"]) || 300,
            () => Number(el["height"]) || 600,
          );
          if (id) report.canvasPainting.set(id, recording.report);
        }
        return recording.ctx;
      },
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    return el;
  };

  const elementCache = new Map<string, Record<string, unknown>>();
  const elementFor = (id: string): Record<string, unknown> | null => {
    if (!ids.has(id)) return null;
    let el = elementCache.get(id);
    if (!el) {
      el = makeElement(/canvas/i.test(id) ? "canvas" : "div", id);
      el["id"] = id;
      elementCache.set(id, el);
    }
    return el;
  };

  const documentObj: Record<string, unknown> = {
    getElementById: (id: unknown) => elementFor(String(id)),
    querySelector: (sel: unknown) => {
      const s = String(sel);
      return s.startsWith("#") ? elementFor(s.slice(1)) : makeElement("div");
    },
    querySelectorAll: () => [],
    createElement: (tag: unknown) => makeElement(String(tag)),
    addEventListener: noop,
    removeEventListener: noop,
    body: makeElement("body"),
    documentElement: makeElement("html"),
    readyState: "complete",
  };

  const frameCallbacks: Array<(t: number) => void> = [];
  const windowObj: Record<string, unknown> = {
    document: documentObj,
    devicePixelRatio: 1,
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener: noop,
    removeEventListener: noop,
    requestAnimationFrame: (cb: (t: number) => void) => { frameCallbacks.push(cb); return frameCallbacks.length; },
    cancelAnimationFrame: noop,
    setTimeout: (cb: () => void) => { void cb; return 0; },
    clearTimeout: noop,
    setInterval: () => 0,
    clearInterval: noop,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop, clear: noop },
    performance: { now: () => 0 },
    alert: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop, addListener: noop }),
  };

  const consoleObj = {
    log: noop,
    info: noop,
    warn: noop,
    debug: noop,
    error: (...args: unknown[]) => { report.consoleErrors.push(args.map((a) => String(a)).join(" ")); },
  };

  return {
    window: windowObj,
    document: documentObj,
    console: consoleObj,
    navigator: { userAgent: "StarlingAI-verify_page" },
    location: { href: "file:///verify_page", search: "", hash: "" },
    Image: function Image(this: Record<string, unknown>) { return makeElement("img"); },
    __frames: frameCallbacks,
    requestAnimationFrame: windowObj["requestAnimationFrame"],
    cancelAnimationFrame: noop,
    setTimeout: windowObj["setTimeout"],
    clearTimeout: noop,
    setInterval: windowObj["setInterval"],
    clearInterval: noop,
    localStorage: windowObj["localStorage"],
    performance: windowObj["performance"],
    devicePixelRatio: 1,
    innerWidth: 1280,
    innerHeight: 800,
    alert: noop,
    addEventListener: noop,
    removeEventListener: noop,
  };
}

/** Execute every script in one shared context, then pump frames. First error per script wins. */
export function runScripts(scripts: ScriptSource[], ids: Set<string>): RunReport {
  const report: RunReport = { errors: [], consoleErrors: [], framesRun: 0, canvasPainting: new Map() };
  const sandbox = buildDomContext(ids, report);
  // `globalThis` inside the context must be the context itself, so top-level `var`/function
  // declarations in one script are visible to the next exactly as they are in a browser.
  const context = createContext(sandbox);

  for (const script of scripts) {
    try {
      runInContext(script.code, context, { timeout: SCRIPT_TIMEOUT_MS, displayErrors: true });
    } catch (err) {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      report.errors.push(`${script.label} — ${message}`);
      // Later scripts usually depend on the failed one; keep going so the report names the
      // FIRST cause rather than only the last symptom, but stop after a few.
      if (report.errors.length >= 4) return report;
    }
  }

  const frames = (context as unknown as Record<string, unknown>)["__frames"] as Array<(t: number) => void> | undefined;
  for (let i = 0; i < FRAMES_TO_PUMP && frames && frames.length > 0; i++) {
    const cb = frames.shift();
    if (!cb) break;
    try {
      runInContext("(__cb) => __cb(0)", context, { timeout: SCRIPT_TIMEOUT_MS })(cb);
      report.framesRun++;
    } catch (err) {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      report.errors.push(`animation frame ${i + 1} — ${message}`);
      break;
    }
  }
  return report;
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
export function checkBuiltPage(absHtmlPath: string, relLabel: string): { ok: boolean; detail: string } {
  let html: string;
  try {
    html = readFileSync(absHtmlPath, "utf-8");
  } catch {
    return { ok: true, detail: "" };   // unreadable is not evidence of breakage
  }
  const { scripts, externalMisses } = collectScripts(html, absHtmlPath);
  if (scripts.length === 0 && externalMisses.length === 0) return { ok: true, detail: "" };

  let report: RunReport;
  try {
    report = runScripts(scripts, collectElementIds(html));
  } catch {
    return { ok: true, detail: "" };   // a harness failure must never invent a defect
  }

  const problems = [...report.errors, ...report.consoleErrors.map((c) => `console.error — ${c}`)];
  if (externalMisses.length > 0) {
    problems.push(`missing local script file(s): ${externalMisses.join(", ")}`);
  }
  for (const [id, read] of report.canvasPainting) {
    const verdict = judgeCanvasPainting(id, read());
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

    let report: RunReport;
    try {
      report = runScripts(scripts, ids);
    } catch (err) {
      log.error({ err, path: rel }, "verify_page harness failure");
      return { success: false, output: "", error: `verify_page could not run '${rel}': ${err instanceof Error ? err.message : String(err)}` };
    }

    const problems = [...report.errors, ...report.consoleErrors.map((c) => `console.error — ${c}`)];
    if (externalMisses.length > 0) {
      problems.push(`missing local script file(s) the page loads: ${externalMisses.join(", ")}`);
    }

    // WHERE THE PAGE PAINTED, not merely whether it survived painting. neon-tetris passed
    // every check above — one script, two animation frames, no errors — and drew its
    // playfield off the side of its own canvas. Code that throws is caught by the errors
    // above; code that is confidently wrong about geometry is only caught here.
    const canvasVerdicts = [...report.canvasPainting.entries()]
      .map(([id, read]) => judgeCanvasPainting(id, read()));
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
