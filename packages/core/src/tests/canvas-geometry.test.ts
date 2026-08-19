/**
 * A PAGE THAT RUNS IS NOT A PAGE THAT LOOKS RIGHT.
 *
 * neon-tetris passed verify_page cleanly — one script executed, two animation frames
 * survived, no uncaught errors — and rendered its playfield as a skewed diamond hanging off
 * the side of the viewport with both side panels blank. Nothing threw. The projection was
 * simply wrong, and every check that only asks "did it run" is blind to that by construction.
 *
 * The measured artifact: a 300x600 board canvas painted into x -320..160 — a full canvas
 * width past its own left edge — with holdCanvas and nextCanvas never drawn on at all.
 */
import { describe, expect, it } from "vitest";
import {
  createRecordingContext,
  judgeCanvasPainting,
  OFF_CANVAS_POINT_RATIO,
  OFF_CANVAS_OVERSHOOT_FACTOR,
} from "../tools/canvas-geometry.js";

describe("the recorder measures where a page actually painted", () => {
  it("records draw calls inside the canvas as in-bounds", () => {
    const { ctx, report } = createRecordingContext(() => 300, () => 600);
    (ctx["fillRect"] as (...a: number[]) => void)(10, 10, 40, 40);
    (ctx["fillRect"] as (...a: number[]) => void)(100, 200, 30, 30);

    const r = report();
    expect(r.drawCalls).toBe(2);
    expect(r.outsidePoints).toBe(0);
    expect(judgeCanvasPainting("board", r).status).toBe("pass");
  });

  it("follows translate/rotate/scale — raw coordinates would be a lie", () => {
    // THE CORE OF THE DESIGN. Arguments to fillRect are in the context's CURRENT user space,
    // and any 2.5D projection sets a transform first. A recorder that stored raw arguments
    // would be confidently wrong in exactly the cases it exists to catch.
    const { ctx, report } = createRecordingContext(() => 300, () => 600);
    (ctx["translate"] as (...a: number[]) => void)(-500, 0);
    (ctx["fillRect"] as (...a: number[]) => void)(10, 10, 20, 20);   // device x ≈ -490

    const r = report();
    expect(r.bounds!.minX).toBeLessThan(-400);
    expect(r.outsidePoints).toBe(r.totalPoints);
    expect(judgeCanvasPainting("board", r).status).toBe("fail");
  });

  it("honours save/restore so a scoped transform does not leak", () => {
    const { ctx, report } = createRecordingContext(() => 300, () => 600);
    (ctx["save"] as () => void)();
    (ctx["translate"] as (...a: number[]) => void)(-900, 0);
    (ctx["restore"] as () => void)();
    (ctx["fillRect"] as (...a: number[]) => void)(10, 10, 20, 20);   // back at the origin

    const r = report();
    expect(r.outsidePoints).toBe(0);
    expect(judgeCanvasPainting("board", r).status).toBe("pass");
  });
});

describe("the verdict names what is wrong, and stays quiet when nothing is", () => {
  it("fails a page that painted NOWHERE — unambiguous whatever it intended", () => {
    const { report } = createRecordingContext(() => 120, () => 120);
    const verdict = judgeCanvasPainting("board", report(), false);
    expect(verdict.status).toBe("fail");
    expect(verdict.detail).toContain("drew nothing");
  });

  it("does NOT fail a quiet panel beside a painted one — the pre-start false positive", () => {
    // The scripts run from the page's initial state: start overlay up, nothing held, nothing
    // spawned. A hold or preview canvas that legitimately fills in once play begins looks
    // identical to one the page never draws, and this check cannot drive the game far enough
    // to tell them apart. The neon-tetris repair hit exactly that — board fixed, run still
    // failing on two panels that may be behaving perfectly — and a check that fails correct
    // pages teaches agents to discount it.
    const { report } = createRecordingContext(() => 120, () => 120);
    const verdict = judgeCanvasPainting("holdCanvas", report(), true);
    expect(verdict.status).toBe("pass");
    // Still reported, so a human can judge it.
    expect(verdict.detail).toContain("nothing drawn");
  });

  it("fails the measured neon-tetris board and quotes the numbers", () => {
    // Reproduced to scale: a 300x600 canvas painted from x -320 to 160.
    const { ctx, report } = createRecordingContext(() => 300, () => 600);
    const rect = ctx["fillRect"] as (...a: number[]) => void;
    rect(-320, 32, 10, 10);
    rect(150, 500, 10, 10);
    rect(-200, 100, 10, 10);

    const verdict = judgeCanvasPainting("board", report());
    expect(verdict.status).toBe("fail");
    expect(verdict.detail).toContain("300x600");
    expect(verdict.detail).toContain("outside the canvas");
    expect(verdict.detail).toContain("projection");
  });

  it("catches a badly placed drawing even when the ratio rule alone would not", () => {
    // THE REASON THERE ARE TWO RULES. The real board scored 54% against a 50% threshold set
    // before anything was measured — a slightly less broken projection would have passed. A
    // page that paints mostly in-bounds but escapes by more than a whole canvas width is
    // still misplaced, and that judgement does not depend on the guessed number.
    const { ctx, report } = createRecordingContext(() => 300, () => 600);
    const rect = ctx["fillRect"] as (...a: number[]) => void;
    for (let i = 0; i < 20; i++) rect(10 + i, 10, 5, 5);   // 20 points well inside
    rect(-400, 10, 5, 5);                                   // one point 1.3 canvases out

    const r = report();
    expect(r.outsidePoints / r.totalPoints).toBeLessThan(OFF_CANVAS_POINT_RATIO);
    expect(judgeCanvasPainting("board", r).status).toBe("fail");
  });

  it("PASSES a page that merely clips at its edges — the discriminator", () => {
    // A guard that fired on any overspill would be noise: pieces sliding in, shapes clipped
    // by design, and strokes straddling the border are all normal. This must stay quiet.
    const { ctx, report } = createRecordingContext(() => 300, () => 600);
    const rect = ctx["fillRect"] as (...a: number[]) => void;
    for (let i = 0; i < 20; i++) rect(20, 20 * i, 40, 18);
    rect(-8, 300, 20, 20);      // straddling the left edge
    rect(290, 40, 20, 20);      // straddling the right edge

    const r = report();
    const verdict = judgeCanvasPainting("board", r);
    expect(verdict.status).toBe("pass");
  });

  it("keeps thresholds in a defensible range", () => {
    expect(OFF_CANVAS_POINT_RATIO).toBeGreaterThan(0.25);
    expect(OFF_CANVAS_POINT_RATIO).toBeLessThanOrEqual(0.75);
    // Escaping by a whole canvas dimension is the point; anything under one is too eager.
    expect(OFF_CANVAS_OVERSHOOT_FACTOR).toBeGreaterThanOrEqual(1);
  });
});
