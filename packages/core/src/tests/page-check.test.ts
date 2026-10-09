import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBuiltPage, collectScripts, collectDeclaredElements, collectElementIds, runScripts, runScriptsIsolated } from "../tools/page-check.js";
import { judgeCanvasPainting } from "../tools/canvas-geometry.js";
import { _setTypeScriptForTests } from "../tools/page-check-runner.js";
import { getTool, type ToolContext } from "../tools/registry.js";
import "../tools/website.js";

const SHIPPED = `<!DOCTYPE html><html><body>
<canvas id="board-canvas" width="320" height="640"></canvas>
<script>
"use strict";
throw new Error("UNFINISHED_STUB: core");
</script>
</body></html>`;

const ID_MISMATCH = `<!DOCTYPE html><html><body>
<canvas id="board-canvas"></canvas>
<script>
"use strict";
const board=document.getElementById("board");
const bctx=board.getContext("2d");
</script>
</body></html>`;

const HEALTHY = `<!DOCTYPE html><html><body>
<canvas id="board"></canvas><div id="score">0</div>
<script>
"use strict";
const board=document.getElementById("board");
const ctx=board.getContext("2d");
let n=0;
function loop(){ n++; ctx.fillRect(0,0,10,10); document.getElementById("score").textContent=String(n); requestAnimationFrame(loop); }
requestAnimationFrame(loop);
</script>
</body></html>`;

/**
 * verify_page — the first thing in this harness that EXECUTES what it ships.
 *
 * Every fixture here is a real measured failure. SHIPPED is the file run 2dc5832c handed the
 * user, which the artifact probe passed and the assistant described in a formatted table as
 * fully playable; the user's browser was the first thing in the loop to run it. ID_MISMATCH is
 * the second defect in that same file — the script asks for `board`, the HTML defines
 * `board-canvas` — a guaranteed TypeError that reading the diff does not reveal and one
 * execution does.
 */
describe("verify_page — runs the page instead of reading it", () => {
  it("catches the UNFINISHED_STUB throw that shipped to the user", () => {
    const { scripts } = collectScripts(SHIPPED, "/w/index.html");
    const r = runScripts(scripts, collectElementIds(SHIPPED));
    expect(r.errors.join(" ")).toContain("UNFINISHED_STUB: core");
  });

  it("catches getElementById for an id the HTML does not define", () => {
    const { scripts } = collectScripts(ID_MISMATCH, "/w/index.html");
    const r = runScripts(scripts, collectElementIds(ID_MISMATCH));
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors.join(" ")).toMatch(/TypeError/);
  });

  it("PASSES a page that boots and survives frames", () => {
    const { scripts } = collectScripts(HEALTHY, "/w/index.html");
    const r = runScripts(scripts, collectElementIds(HEALTHY));
    expect(r.errors).toEqual([]);
    expect(r.framesRun).toBeGreaterThan(0);
  });
});

/**
 * THE CANVAS THE PAGE DECLARED, NOT THE ONE THE SHIM IMAGINED.
 *
 * The geometry verdict is a HARD failure that downgrades a finished build to "partial" and
 * sends the agent back to rewrite projection maths. It is therefore only as good as the
 * rectangle it measures against — and that rectangle used to be a hardcoded 300x600 for every
 * element, so the ordinary `<canvas width="960" height="600">` was judged at a third of its
 * width and a page that filled it correctly failed with "81% of the drawing lands outside".
 */
describe("verify_page — measures against the declared canvas", () => {
  const WIDE = `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
</head><body>
<canvas id="stage" width="960" height="600"></canvas>
<script>
"use strict";
const c=document.getElementById("stage");
const ctx=c.getContext("2d");
for(let x=0;x<960;x+=120){ ctx.fillRect(x,10,100,80); }
</script>
</body></html>`;

  it("reads width/height off the canvas element", () => {
    const declared = collectDeclaredElements(WIDE);
    expect(declared.get("stage")).toEqual({ tag: "canvas", width: 960, height: 600 });
  });

  it("does not mistake a viewport meta tag for a canvas size", () => {
    // `content="width=device-width"` contains `width=`; a bare scan reads it as an attribute
    // of that element, and any element it lands on inherits a non-numeric size.
    const declared = collectDeclaredElements(WIDE);
    expect([...declared.keys()]).toEqual(["stage"]);
    const cssish = collectDeclaredElements('<canvas id="fluid" width="100%" height="60vh"></canvas>');
    expect(cssish.get("fluid")).toEqual({ tag: "canvas" });   // layout size, not intrinsic
  });

  it("PASSES painting that fills the canvas the HTML declared", () => {
    const { scripts } = collectScripts(WIDE, "/w/index.html");
    const r = runScripts(scripts, collectElementIds(WIDE), collectDeclaredElements(WIDE));
    expect(r.errors).toEqual([]);
    const paint = r.canvasPainting.get("stage");
    expect(paint).toBeDefined();
    const report = paint!();
    expect(report.width).toBe(960);          // 300 before the fix
    expect(report.outsidePoints).toBe(0);
    expect(judgeCanvasPainting("stage", report).status).toBe("pass");
  });

  it("still catches painting that really does land off the canvas", () => {
    const OFF = WIDE.replace("ctx.fillRect(x,10,100,80);", "ctx.fillRect(x+2400,10,100,80);");
    const { scripts } = collectScripts(OFF, "/w/index.html");
    const r = runScripts(scripts, collectElementIds(OFF), collectDeclaredElements(OFF));
    const report = r.canvasPainting.get("stage")!();
    expect(judgeCanvasPainting("stage", report).status).toBe("fail");
  });

  it("takes the element tag from the markup, not from the id string", () => {
    // The shim used to guess `canvas` only when the ID happened to contain the word, so the
    // conventional `<canvas id="game">` reported itself as a DIV.
    expect(collectDeclaredElements('<canvas id="game"></canvas>').get("game")?.tag).toBe("canvas");
  });
});

/**
 * WHAT THIS PROBE MUST NOT DO TO THE PROCESS IT RUNS IN.
 *
 * checkBuiltPage is called with no tool call at all — artifact-probes runs it on every
 * delivered .html — so its failure modes are the gateway's failure modes. These pin the two
 * that were: a frame callback that never returns, and a <script src> that points outside the
 * page's own directory.
 */
describe("verify_page — bounded, and confined to the page's own folder", () => {
  const ws = () => mkdtempSync(join(tmpdir(), "sai-pagecheck-"));

  it("kills a frame callback that never returns instead of hanging the thread", () => {
    const HANG = `<!DOCTYPE html><html><body><div id="app"></div><script>
"use strict";
function loop(){ while(true){} }
requestAnimationFrame(loop);
</script></body></html>`;
    const { scripts } = collectScripts(HANG, "/w/index.html");
    const startedAt = Date.now();
    const r = runScripts(scripts, collectElementIds(HANG));
    const elapsed = Date.now() - startedAt;
    // The vm watchdog is 3 s per script; without it this call never returns at all.
    expect(elapsed).toBeLessThan(20_000);
    expect(r.errors.join(" ")).toMatch(/animation frame 1/);
    expect(r.errors.join(" ")).toMatch(/timed out/i);
  }, 30_000);

  it("does not read a script the page points at outside its own directory", async () => {
    const root = ws();
    mkdirSync(join(root, "generated", "game"), { recursive: true });
    writeFileSync(join(root, "secret.env"), "OPENAI_API_KEY=sk-live-not-a-real-key\n");
    const page = join(root, "generated", "game", "index.html");
    writeFileSync(page, '<html><body><script src="../../secret.env"></script><script>const x=1;</script></body></html>');

    const { scripts, externalMisses } = collectScripts(
      '<html><body><script src="../../secret.env"></script><script>const x=1;</script></body></html>',
      page,
    );
    expect(externalMisses).toEqual(["../../secret.env"]);
    expect(scripts.map((s2) => s2.code).join(" ")).not.toContain("sk-live-not-a-real-key");

    // …and nothing about that file reaches the verdict text either.
    const verdict = await checkBuiltPage(page, "generated/game/index.html");
    expect(JSON.stringify(verdict)).not.toContain("sk-live-not-a-real-key");
  });

  it("treats a missing sibling script as soft, but a page with nothing to run as broken", async () => {
    const root = ws();
    mkdirSync(join(root, "site"), { recursive: true });

    const withInline = join(root, "site", "a.html");
    writeFileSync(withInline, '<html><body><script src="./later.js"></script><script>const x=1;</script></body></html>');
    // later.js has not been written yet — the page still runs, so this must not hard-fail.
    expect((await checkBuiltPage(withInline, "site/a.html")).ok).toBe(true);

    const onlyMissing = join(root, "site", "b.html");
    writeFileSync(onlyMissing, '<html><body><script src="./only.js"></script></body></html>');
    const dead = await checkBuiltPage(onlyMissing, "site/b.html");
    expect(dead.ok).toBe(false);
    expect(dead.detail).toContain("only.js");
  });
});

/**
 * THE ESCAPE IS REAL, SO THE PROCESS HAS TO BE THE BOUNDARY.
 *
 * `vm` isolates globals, not realms: every host function in the shim hands the page
 * `.constructor` and through it the host `Function`. Measured against the old in-process
 * runner, `document.getElementById.constructor("return process")()` returned the gateway's own
 * process — 125 env keys, `child_process`, the lot — while the check reported the page healthy.
 * These pin what the child process changed: the escape still succeeds INSIDE the child, and
 * finds nothing worth having.
 */
describe("page execution is isolated from the gateway process", () => {
  const ESCAPE = `
    var out = {};
    try {
      var F = document.getElementById.constructor;
      var proc = F("return process")();
      out.escaped = true;
      out.sawSentinel = proc.env.SAI_PAGE_CHECK_SENTINEL || null;
      out.envKeys = Object.keys(proc.env).length;
      out.samePid = proc.pid;
    } catch (e) { out.escaped = false; out.why = e.message; }
    console.error(JSON.stringify(out));
  `;

  it("does not hand a page the gateway's environment or its process", async () => {
    process.env["SAI_PAGE_CHECK_SENTINEL"] = "sk-ant-oat-do-not-leak";
    try {
      const report = await runScriptsIsolated(
        [{ label: "escape", code: ESCAPE }],
        new Set(["app"]),
        new Map(),
      );
      expect(report).not.toBeNull();
      const observed = JSON.parse(report!.consoleErrors[0] ?? "{}") as {
        escaped?: boolean; sawSentinel?: string | null; envKeys?: number; samePid?: number;
      };
      // The escape itself is expected to work — vm cannot stop it. What matters is where it lands.
      expect(observed.escaped).toBe(true);
      expect(observed.sawSentinel).toBeNull();          // the secret was never handed down
      expect(observed.samePid).not.toBe(process.pid);   // not this process
      // Only what node itself needs to start on this platform — a small fraction of what the
      // gateway process carries, and none of it a credential.
      expect(observed.envKeys).toBeLessThan(Math.max(8, Object.keys(process.env).length / 4));
    } finally {
      delete process.env["SAI_PAGE_CHECK_SENTINEL"];
    }
  }, 40_000);

  it("runs the page somewhere the workspace is not", async () => {
    const report = await runScriptsIsolated(
      [{ label: "cwd", code: 'console.error(document.getElementById.constructor("return process")().cwd());' }],
      new Set(), new Map(),
    );
    const cwd = (report?.consoleErrors[0] ?? "").toLowerCase();
    expect(cwd.length).toBeGreaterThan(0);
    expect(cwd).not.toContain("starlingai");   // a relative write cannot reach the repo/workspace
  }, 40_000);
});

/**
 * A LIBRARY FROM A CDN IS NOT A BUG IN THE PAGE.
 *
 * This check never fetches a remote <script src>. generate_presentation loads reveal.js from
 * jsDelivr and then calls Reveal.initialize inline, so every deck it built failed here with
 * "ReferenceError: Reveal is not defined". The staged build then resumed content_writer to "fix"
 * a correct deck, and once the artifact gate probed the deck's index.html it would have failed
 * every deck too. These pin both sides: what a remote script would define is not counted, and
 * everything else a page gets wrong still is.
 */
describe("verify_page — globals a remote script would define", () => {
  const ws = () => mkdtempSync(join(tmpdir(), "sai-pagecheck-remote-"));
  const run = (html: string) => {
    const { scripts } = collectScripts(html, "/w/index.html");
    return runScripts(scripts, collectElementIds(html), collectDeclaredElements(html));
  };
  const CDN = '<script src="https://cdn.jsdelivr.net/npm/lib@1/dist/lib.js"></script>';

  it("passes the reveal.js deck generate_presentation builds", async () => {
    const root = ws();
    const ctx = { sessionId: "t", workspacePath: root } as unknown as ToolContext;
    const result = await getTool("generate_presentation")!.execute({
      outputDir: "wartungsplan",
      title: "Digitaler Wartungsplan",
      slides: [
        { title: "Ziel", content: "Ein **digitaler** Plan." },
        { title: "Schritte", bullets: ["Erfassen", "Planen", "Prüfen"], notes: "Kurz halten." },
      ],
    }, ctx);
    expect(result.success).toBe(true);
    const page = join(root, "generated", "wartungsplan", "index.html");

    const verdict = await checkBuiltPage(page, "generated/wartungsplan/index.html");
    expect(verdict).toEqual({ ok: true, detail: "" });

    // The worker names what it did not run past, so verify_page can say so.
    const html = readFileSync(page, "utf8");
    const { scripts } = collectScripts(html, page);
    const report = await runScriptsIsolated(scripts, collectElementIds(html), collectDeclaredElements(html));
    expect(report?.errors).toEqual([]);
    expect(report?.remoteGlobals).toEqual(["Reveal"]);
    const tool = await getTool("verify_page")!.execute({ path: "generated/wartungsplan/index.html" }, ctx);
    expect(tool.success).toBe(true);
    expect(tool.output).toContain("not run past Reveal");
    // Said as an assumption the agent can check, not as a verdict that the name is fine.
    expect(tool.output).toMatch(/not run past Reveal: not declared by this page's own scripts.*if no library the page loads defines it, that is a bug/);
  }, 40_000);

  it("does not count a global the remote script before it would define, in a script or a frame", () => {
    const inScript = run(`<html><body>${CDN}<script>Lib.init({ hash: true });</script></body></html>`);
    expect(inScript.errors).toEqual([]);
    expect(inScript.remoteGlobals).toEqual(["Lib"]);

    const inFrame = run(`<html><body>${CDN}<script>function loop(){ Lib.tick(); } requestAnimationFrame(loop);</script></body></html>`);
    expect(inFrame.errors).toEqual([]);
    expect(inFrame.remoteGlobals).toEqual(["Lib"]);
  });

  it("still counts the same error where no remote script could have defined the name", () => {
    // No remote script at all: a misspelt name is the page's own bug, and the request is unchanged.
    const page = `<html><body><script>Lib.init();</script></body></html>`;
    expect(collectScripts(page, "/w/index.html").scripts.some((s2) => "afterRemote" in s2)).toBe(false);
    expect(run(page).errors.join(" ")).toMatch(/ReferenceError: Lib is not defined/);
    expect(run(page).remoteGlobals).toBeUndefined();

    // The remote script comes AFTER the code that needs it, so a browser throws here too.
    expect(run(`<html><body><script>Lib.init();</script>${CDN}</body></html>`).errors.join(" "))
      .toMatch(/ReferenceError: Lib is not defined/);

    // A deferred, async or module script runs after the parser has moved on, so top-level code
    // after it cannot use its globals in a browser either.
    for (const attr of ["defer", "async", 'type="module"']) {
      const deferred = `<html><body><script src="https://cdn.example/lib.js" ${attr}></script><script>Lib.init();</script></body></html>`;
      expect(run(deferred).errors.join(" "), attr).toMatch(/ReferenceError: Lib is not defined/);
    }
    // ...and a URL that merely contains the word is not the attribute.
    expect(run(`<html><body><script src="https://cdn.example/defer/async.js"></script><script>Lib.init();</script></body></html>`).errors)
      .toEqual([]);
  });

  it("still fails a page after a remote script when the page itself is broken", async () => {
    // Any other error is the page's: an element the HTML does not define, a let read too early.
    expect(run(`<html><body>${CDN}<script>document.getElementById("nope").textContent = "x";</script></body></html>`).errors.join(" "))
      .toMatch(/TypeError/);
    expect(run(`<html><body>${CDN}<script>count++; let count = 0;</script></body></html>`).errors.join(" "))
      .toMatch(/ReferenceError: Cannot access 'count' before initialization/);

    // And the same through the isolated worker, the path the artifact gate takes.
    const root = ws();
    const broken = join(root, "broken.html");
    writeFileSync(broken, `<html><body>${CDN}<div id="app"></div><script>document.getElementById("ap").textContent = "x";</script></body></html>`);
    const verdict = await checkBuiltPage(broken, "broken.html");
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toMatch(/TypeError/);
  }, 40_000);

  /**
   * The exemption is for a name nothing in the page defines. A page that loads three.js or the
   * Tailwind CDN and declares `const state` inside init() but reads `state.x` in its draw loop has
   * its own scoping bug, the one the `runs` probe was added for; it passed once a CDN tag stood
   * before it, and verify_page called it "not a defect".
   */
  it("still counts a name the page's own code binds, read where that binding is out of scope", async () => {
    const STATE = 'function init() { const state = { x: 10 }; }\n'
      + 'function draw() { document.getElementById("c").getContext("2d").fillRect(state.x, 0, 5, 5); }';
    // In a script after the remote one, and in a frame.
    for (const tail of ["init(); draw();", "init(); requestAnimationFrame(draw);"]) {
      const r = run(`<html><body>${CDN}<canvas id="c"></canvas><script>${STATE}\n${tail}</script></body></html>`);
      expect(r.errors.join(" "), tail).toMatch(/ReferenceError: state is not defined/);
      expect(r.remoteGlobals, tail).toBeUndefined();
    }

    // Any binding of the name counts, in any of the page's own scripts, before or after the remote one.
    for (const binds of [
      "function f(state) {}",
      "const f = ({ state }) => 0;",
      "function f() { let [a, state] = [1, 2]; return a; }",
      "function f() { var state; }",
      "function f() { function state() {} }",
      "function f() { class state {} }",
      "try { throw 1; } catch (state) {}",
      "function f() { state = 1; }",
    ]) {
      const r = run(`<html><body>${CDN}<script>${binds}\nstate.x;</script></body></html>`);
      expect(r.errors.join(" "), binds).toMatch(/ReferenceError: state is not defined/);
    }
    expect(run(`<html><body><script>function f(state) {}</script>${CDN}<script>state.x;</script></body></html>`).errors.join(" "))
      .toMatch(/ReferenceError: state is not defined/);

    // Through the isolated worker: the artifact gate's `runs` probe and verify_page both fail it.
    const root = ws();
    const ctx = { sessionId: "t", workspacePath: root } as unknown as ToolContext;
    mkdirSync(join(root, "spiel"), { recursive: true });
    const page = join(root, "spiel", "index.html");
    writeFileSync(page, `<html><head>${CDN}</head><body><canvas id="c"></canvas><script>${STATE}\ninit(); requestAnimationFrame(draw);</script></body></html>`);
    const verdict = await checkBuiltPage(page, "spiel/index.html");
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toMatch(/ReferenceError: state is not defined/);
    const tool = await getTool("verify_page")!.execute({ path: "spiel/index.html" }, ctx);
    expect(tool.success).toBe(false);
    expect(tool.error).toMatch(/ReferenceError: state is not defined/);
  }, 40_000);

  it("counts the error when it cannot tell whether the page binds the name", () => {
    _setTypeScriptForTests(null);
    try {
      expect(run(`<html><body>${CDN}<script>Lib.init();</script></body></html>`).errors.join(" "))
        .toMatch(/ReferenceError: Lib is not defined/);
    } finally {
      _setTypeScriptForTests(undefined);
    }
    expect(run(`<html><body>${CDN}<script>Lib.init();</script></body></html>`).errors).toEqual([]);
  });
});

/**
 * AN ES MODULE THAT IMPORTS CANNOT RUN HERE, AND THAT IS NOT A DEFECT OF THE PAGE.
 *
 * This check runs every script as a classic script and never loads a module graph. A module
 * script with an import therefore failed with "SyntaxError: Cannot use import statement outside a
 * module" before a line of it ran: generate_website with includeMermaid writes exactly that, so
 * the artifact gate hard-failed a correct site and sent it for a repair. A module script that does
 * compile as a classic script still runs, and a broken one still counts.
 */
describe("verify_page — a module script this check cannot run", () => {
  const run = (html: string) => {
    const { scripts } = collectScripts(html, "/w/index.html");
    return runScripts(scripts, collectElementIds(html), collectDeclaredElements(html));
  };
  const MERMAID = '<script type="module">\n'
    + '  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";\n'
    + '  mermaid.initialize({ startOnLoad: true, theme: "default" });\n'
    + "</script>";

  it("does not count a module script that fails only because it imports, and says it did not run it", async () => {
    const page = `<html><body><div id="app"></div>${MERMAID}<script>document.getElementById("app").textContent = "ok";</script></body></html>`;
    const r = run(page);
    expect(r.errors).toEqual([]);
    expect(r.modulesNotRun).toEqual(["inline script #1"]);

    // Through the worker, the artifact gate's path and verify_page's.
    const root = mkdtempSync(join(tmpdir(), "sai-pagecheck-module-"));
    writeFileSync(join(root, "index.html"), page);
    expect(await checkBuiltPage(join(root, "index.html"), "index.html")).toEqual({ ok: true, detail: "" });
    const tool = await getTool("verify_page")!.execute({ path: "index.html" }, { sessionId: "t", workspacePath: root } as unknown as ToolContext);
    expect(tool.success).toBe(true);
    expect(tool.output).toContain("runs: 1 script(s) executed");
    expect(tool.output).toContain("not run: inline script #1");
  }, 40_000);

  it("still counts a module script's runtime error, and a module script that does not parse", () => {
    // No import: it compiles as a classic script, so it runs as before, and what it throws counts.
    expect(run('<html><body><script type="module">document.getElementById("nope").textContent = "x";</script></body></html>').errors.join(" "))
      .toMatch(/TypeError/);
    expect(run('<html><body><script type="module">JSON.parse("{");</script></body></html>').errors.join(" "))
      .toMatch(/SyntaxError/);
    // An import, and the module is cut off: a browser cannot run it either.
    expect(run('<html><body><script type="module">import m from "https://x.example/m.mjs"; m.init({</script></body></html>').errors.join(" "))
      .toMatch(/SyntaxError/);
    // An import in a classic script is the page's bug.
    expect(run('<html><body><script>import m from "https://x.example/m.mjs"; m.init();</script></body></html>').errors.join(" "))
      .toMatch(/SyntaxError: Cannot use import statement outside a module/);
    // A page without a module script sends the worker the same request as before.
    expect(collectScripts("<html><body><script>let a = 1;</script></body></html>", "/w/index.html").scripts.some((s2) => "module" in s2))
      .toBe(false);
  });

  it("counts the module script when it cannot tell a module from a broken script", () => {
    _setTypeScriptForTests(null);
    try {
      expect(run(`<html><body>${MERMAID}</body></html>`).errors.join(" "))
        .toMatch(/SyntaxError: Cannot use import statement outside a module/);
    } finally {
      _setTypeScriptForTests(undefined);
    }
    expect(run(`<html><body>${MERMAID}</body></html>`).errors).toEqual([]);
  });
});
