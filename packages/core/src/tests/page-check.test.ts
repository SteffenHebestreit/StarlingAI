import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBuiltPage, collectScripts, collectDeclaredElements, collectElementIds, runScripts, runScriptsIsolated } from "../tools/page-check.js";
import { judgeCanvasPainting } from "../tools/canvas-geometry.js";

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
