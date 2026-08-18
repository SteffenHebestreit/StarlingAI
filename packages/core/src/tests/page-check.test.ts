import { describe, expect, it } from "vitest";
import { collectScripts, collectElementIds, runScripts } from "../tools/page-check.js";

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
