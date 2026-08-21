/**
 * The page runner: parse a built page, then EXECUTE it against a minimal DOM.
 *
 * Split out of page-check.ts so it can be loaded by two very different callers — the tool
 * itself, and the isolated child process that runs untrusted page code (page-check-worker.ts).
 * Nothing here may import the tool registry, the logger or the config: the worker starts one of
 * these per check, and every import it drags in is startup latency on a hot path.
 *
 * NOT A SECURITY BOUNDARY. `vm` isolates globals, not realms — every host function placed in
 * the context hands the page `.constructor`, and through it the host `Function`, `process` and
 * `child_process`. That is why this module is not called in-process by the gateway any more.
 * The isolation lives in page-check.ts (runScriptsIsolated), which runs it in a child process
 * with a scrubbed environment, a working directory outside the workspace, and a hard kill.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve as resolvePath } from "node:path";
import { createContext, runInContext } from "node:vm";
import { createRecordingContext, type CanvasPaintReport } from "./canvas-geometry.js";
import { describeErrorSite, SCRIPT_VM_FILENAME } from "./error-site.js";

/** Wall-clock ceiling for one script. A game loop that never yields must not run unbounded. */
const SCRIPT_TIMEOUT_MS = 3_000;
/** Frames pumped after load, so the render path runs and not merely the declarations. */
const FRAMES_TO_PUMP = 2;


export interface ScriptSource {
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
      // THE REF IS MODEL-CONTROLLED, SO IT IS NOT A PATH UNTIL IT IS CHECKED.
      //
      // The tool's own `path` argument goes through resolvePathWithinWorkspace, but the
      // refs INSIDE the file never did, and this reads whatever they name and then quotes
      // the failing line back into the tool output. `<script src="../../.env">` therefore
      // read the gateway's own secrets and printed them into the model's context and the
      // AG-UI stream (a `.env` is not JS, so it throws, and describeErrorSite quotes the
      // offending source line). Confine the ref to the page's own directory tree — which is
      // all this ever claimed to load ("same-directory <script src> files", above) — and
      // treat anything else exactly like a file that is not there.
      const abs = resolvePath(dirname(htmlPath), ref);
      const withinPage = relative(dirname(htmlPath), abs);
      if (isAbsolute(ref) || /^file:/i.test(ref)
        || withinPage.startsWith("..") || isAbsolute(withinPage)) {
        // A Windows drive ref ("C:\secrets") needs no clause of its own: on win32
        // isAbsolute already says true, and on POSIX it is just an odd filename inside
        // the page's own directory, which relative() confirms is contained.
        externalMisses.push(ref);
        continue;
      }
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

/** What the document declares about one element: its tag, and its intrinsic size if it states one. */
export interface DeclaredElement {
  tag: string;
  /** The `width` attribute, when it is a plain number — a canvas's INTRINSIC width. */
  width?: number;
  height?: number;
}

/**
 * THE CANVAS IS THE SIZE THE HTML SAYS IT IS.
 *
 * The geometry verdict compares where a page painted against the canvas rectangle, so that
 * rectangle has to be the real one. The shim used to hand every element a fabricated 300x600
 * and only learned better if the page happened to assign `canvas.width` in JS — so the most
 * ordinary case of all, `<canvas id="game" width="960" height="600">` sized once in the markup
 * and never touched again, was judged against a canvas a third of its width. Painting that
 * fills such a canvas correctly then scores most of its points "outside" and HARD-fails a
 * working page, with a verdict telling the agent to go fix projection maths that is not wrong.
 *
 * Attributes are read with a real attribute tokenizer, not a bare /width=/ scan: the latter
 * matches inside `<meta content="width=device-width">` and any other quoted value that
 * happens to contain the word.
 */
export function collectDeclaredElements(html: string): Map<string, DeclaredElement> {
  const declared = new Map<string, DeclaredElement>();
  const tagRe = /<([a-zA-Z][\w-]*)((?:\s+[^\s"'=<>`/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
  const attrRe = /([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let tag: RegExpExecArray | null;
  while ((tag = tagRe.exec(html)) !== null) {
    const attrs = new Map<string, string>();
    attrRe.lastIndex = 0;
    let a: RegExpExecArray | null;
    while ((a = attrRe.exec(tag[2] ?? "")) !== null) {
      attrs.set((a[1] ?? "").toLowerCase(), a[2] ?? a[3] ?? a[4] ?? "");
    }
    const id = attrs.get("id");
    if (!id) continue;
    const entry: DeclaredElement = { tag: (tag[1] ?? "div").toLowerCase() };
    // Only a plain number counts. "100%", "device-width" and other CSS-ish values state a
    // LAYOUT size, which is not the intrinsic size the drawing is measured against.
    for (const dim of ["width", "height"] as const) {
      const rawValue = attrs.get(dim);
      if (rawValue === undefined) continue;
      const n = Number(rawValue.trim());
      if (Number.isFinite(n) && n > 0) entry[dim] = Math.round(n);
    }
    // First declaration wins, matching getElementById on a document with a duplicate id.
    if (!declared.has(id)) declared.set(id, entry);
  }
  return declared;
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

export interface RunReport {
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
function buildDomContext(
  ids: Set<string>,
  report: RunReport,
  declared: Map<string, DeclaredElement> = new Map(),
): Record<string, unknown> {
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

  const makeElement = (tag: string, id?: string, decl?: DeclaredElement): Record<string, unknown> => {
    // One recorder per canvas element, created lazily on the first getContext so a page that
    // never draws still reports zero draw calls rather than nothing at all.
    let recording: { ctx: Record<string, unknown>; report: () => CanvasPaintReport } | undefined;
    const el: Record<string, unknown> = {
      tagName: tag.toUpperCase(),
      style: {},
      classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
      dataset: {},
      // The size the document declares, when it declares one. The fallback stays deliberately
      // generous — larger than the browser's own 300x150 default for a canvas — so a size
      // nothing states can only ever make the geometry verdict MORE forgiving, never invent
      // a defect out of a number the harness guessed.
      width: decl?.width ?? 300,
      height: decl?.height ?? 600,
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
      const decl = declared.get(id);
      // The real tag when the document declares one. The id-name guess behind it is the last
      // resort for an id that reaches getElementById without ever appearing in the markup.
      el = makeElement(decl?.tag ?? (/canvas/i.test(id) ? "canvas" : "div"), id, decl);
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
export function runScripts(
  scripts: ScriptSource[],
  ids: Set<string>,
  declared: Map<string, DeclaredElement> = new Map(),
): RunReport {
  const report: RunReport = { errors: [], consoleErrors: [], framesRun: 0, canvasPainting: new Map() };
  const sandbox = buildDomContext(ids, report, declared);
  // `globalThis` inside the context must be the context itself, so top-level `var`/function
  // declarations in one script are visible to the next exactly as they are in a browser.
  const context = createContext(sandbox);

  for (const script of scripts) {
    try {
      runInContext(script.code, context, {
        timeout: SCRIPT_TIMEOUT_MS,
        displayErrors: true,
        // Named so the failing frame is identifiable in the stack, which is where the line
        // and column live.
        filename: SCRIPT_VM_FILENAME,
      });
    } catch (err) {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      report.errors.push(`${script.label} — ${message}${describeErrorSite(err, script.code)}`);
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
      // CALL IT INSIDE THE TIMED SCRIPT, NOT AFTER IT.
      //
      // vm's `timeout` bounds the runInContext CALL. Returning the arrow and applying it on
      // the host stack — `runInContext("(__cb) => __cb(0)", …)(cb)` — armed the watchdog for
      // the microseconds it took to compile an arrow function and tore it down before the
      // frame body ran, so `function loop(){ while(true){} }; requestAnimationFrame(loop)`
      // hung this thread forever. That is the gateway's only thread, and the probe path runs
      // it with no tool call at all (artifact-probes.ts), so one generated page could take
      // the whole process down. Handing the callback to the context and invoking it from
      // inside the script puts the loop body under the same 3 s ceiling as the top level.
      (context as unknown as Record<string, unknown>)["__pendingFrame"] = cb;
      runInContext("__pendingFrame(0)", context, { timeout: SCRIPT_TIMEOUT_MS });
      report.framesRun++;
    } catch (err) {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      report.errors.push(`animation frame ${i + 1} — ${message}${describeErrorSite(err, scripts.map(s2 => s2.code).join("\n"))}`);
      break;
    }
  }
  return report;
}

