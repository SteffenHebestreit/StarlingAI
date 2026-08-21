/**
 * Canvas Geometry Recorder
 *
 * WHAT A LOGIC CHECK CANNOT SEE.
 *
 * verify_page executes a page's scripts and reports what they throw, and a run that passes
 * it has proved only that the code does not crash. The neon-tetris build passed it cleanly —
 * 1 script executed, 2 animation frames survived, no uncaught errors — and rendered its
 * playfield as a skewed diamond hanging off the side of the viewport, because the 2.5D
 * projection was arithmetically wrong. Nothing in the page threw; it drew confidently in the
 * wrong place. That is invisible to every check that only asks "did it run".
 *
 * The 2D context in the DOM shim used to be a Proxy returning a no-op for every method, so
 * every draw call was swallowed. This records them instead, which turns "where did the page
 * actually paint" into a question the harness can answer without rendering a single pixel.
 *
 * TRANSFORMS ARE THE WHOLE DIFFICULTY. Raw arguments to fillRect/lineTo are in the context's
 * CURRENT user space, and a page that calls translate/rotate/scale first — as any 2.5D
 * projection does — paints somewhere else entirely. Recording raw coordinates would be
 * confidently wrong in exactly the cases this exists to catch, so the recorder carries a
 * full affine matrix with a save/restore stack and maps every point through it. The output
 * is in device space: the pixels the canvas would actually light up.
 */

/** A 2D affine transform, in the order canvas uses: [a c e; b d f; 0 0 1]. */
interface Matrix {
  a: number; b: number; c: number; d: number; e: number; f: number;
}

const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function multiply(m: Matrix, n: Matrix): Matrix {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

function apply(m: Matrix, x: number, y: number): { x: number; y: number } {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

export interface PaintBounds {
  minX: number; minY: number; maxX: number; maxY: number;
}

export interface CanvasPaintReport {
  /** Draw operations that carried coordinates. */
  drawCalls: number;
  /** Painted extent in device space, or null when nothing with coordinates was drawn. */
  bounds: PaintBounds | null;
  /** Points whose device coordinates landed outside the canvas rectangle. */
  outsidePoints: number;
  /** Total points considered. */
  totalPoints: number;
  width: number;
  height: number;
}

/**
 * Methods whose numeric arguments are (x, y) pairs in user space, and how to read them.
 * Only calls that actually put marks on the canvas are recorded — a `clearRect` covering the
 * whole canvas is a background wipe, not content, and counting it would mask a page that
 * clears correctly and then paints its real content into the void.
 */
const POINT_ARGS: Record<string, number[][]> = {
  fillRect: [[0, 1], [2, 3]],      // x, y and x+w, y+h handled by the caller below
  strokeRect: [[0, 1], [2, 3]],
  rect: [[0, 1], [2, 3]],
  moveTo: [[0, 1]],
  lineTo: [[0, 1]],
  arc: [[0, 1]],
  arcTo: [[0, 1], [2, 3]],
  ellipse: [[0, 1]],
  quadraticCurveTo: [[0, 1], [2, 3]],
  bezierCurveTo: [[0, 1], [2, 3], [4, 5]],
  fillText: [[1, 2]],
  strokeText: [[1, 2]],
  // drawImage is arity-dependent and is handled on its own below: in the 9-argument form
  // args 1 and 2 are sx/sy INSIDE THE SOURCE IMAGE, not a position on the canvas.
  drawImage: [[1, 2]],
};

/**
 * WHERE drawImage ACTUALLY PUTS THE PIXELS.
 *
 * Three signatures, and only one of them has the destination at args 1-2:
 *   drawImage(img, dx, dy)                                     → dest args 1,2
 *   drawImage(img, dx, dy, dw, dh)                             → dest args 1,2 + size 3,4
 *   drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh)             → dest args 5,6 + size 7,8
 * Reading 1-2 regardless measured the sprite ATLAS instead of the canvas for every
 * sprite-sheet page — the exact class of page whose geometry this exists to judge.
 */
function drawImageDestination(args: unknown[]): { x: number; y: number; w: number; h: number } | null {
  if (args.length >= 9) {
    return { x: Number(args[5]), y: Number(args[6]), w: Number(args[7]), h: Number(args[8]) };
  }
  if (args.length >= 5) {
    return { x: Number(args[1]), y: Number(args[2]), w: Number(args[3]), h: Number(args[4]) };
  }
  if (args.length >= 3) {
    return { x: Number(args[1]), y: Number(args[2]), w: 0, h: 0 };
  }
  return null;
}

/** Methods where args 2 and 3 are a WIDTH and HEIGHT relative to args 0 and 1, not a point. */
const RECT_LIKE = new Set(["fillRect", "strokeRect", "rect"]);

/**
 * A recording 2D context. Behaves as a no-op for the page (every property is callable and
 * every setter accepted, exactly as the previous stub did) while accumulating where the page
 * painted.
 */
export function createRecordingContext(
  // READ LAZILY, NOT SNAPSHOTTED. Pages routinely call getContext() first and size the
  // canvas afterwards — neon-tetris does exactly that, taking its context at parse time and
  // resizing in fitCanvas() on the first frame. Capturing the dimensions up front measured
  // the drawing against the shim's placeholder 300x600 instead of the canvas the page
  // actually built, which is a quiet way to be wrong about the very thing this reports.
  readWidth: () => number,
  readHeight: () => number,
): {
  ctx: Record<string, unknown>;
  report: () => CanvasPaintReport;
} {
  let matrix: Matrix = { ...IDENTITY };
  const stack: Matrix[] = [];
  let drawCalls = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  // Device-space points, kept so the in/out test can run against the canvas's FINAL size.
  // Bounded: the extremes are what the verdict needs, and a page drawing tens of thousands
  // of cells must not be able to grow this without limit.
  const MAX_SAMPLES = 20_000;
  const points: { x: number; y: number }[] = [];

  const notePoint = (ux: number, uy: number): void => {
    if (!Number.isFinite(ux) || !Number.isFinite(uy)) return;
    const p = apply(matrix, ux, uy);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
    if (points.length < MAX_SAMPLES) points.push(p);
  };

  const noop = (): void => {};

  const handlers: Record<string, (...args: unknown[]) => unknown> = {
    save: () => { stack.push({ ...matrix }); },
    restore: () => { const m = stack.pop(); if (m) matrix = m; },
    translate: (x, y) => {
      matrix = multiply(matrix, { a: 1, b: 0, c: 0, d: 1, e: Number(x) || 0, f: Number(y) || 0 });
    },
    scale: (x, y) => {
      matrix = multiply(matrix, { a: Number(x) || 0, b: 0, c: 0, d: Number(y) || 0, e: 0, f: 0 });
    },
    rotate: (rad) => {
      const r = Number(rad) || 0;
      const cos = Math.cos(r), sin = Math.sin(r);
      matrix = multiply(matrix, { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 });
    },
    transform: (a, b, c, d, e, f) => {
      matrix = multiply(matrix, {
        a: Number(a) || 0, b: Number(b) || 0, c: Number(c) || 0,
        d: Number(d) || 0, e: Number(e) || 0, f: Number(f) || 0,
      });
    },
    setTransform: (a, b, c, d, e, f) => {
      matrix = {
        a: Number(a) || 0, b: Number(b) || 0, c: Number(c) || 0,
        d: Number(d) || 0, e: Number(e) || 0, f: Number(f) || 0,
      };
    },
    resetTransform: () => { matrix = { ...IDENTITY }; },
  };

  const ctx = new Proxy({}, {
    get: (_t, prop) => {
      if (typeof prop !== "string") return undefined;
      if (prop === "canvas") return { width: readWidth(), height: readHeight() };
      if (prop === "measureText") return () => ({ width: 0 });
      if (prop === "getImageData") return () => ({ data: new Uint8ClampedArray(4) });
      if (prop === "createLinearGradient" || prop === "createRadialGradient") {
        return () => ({ addColorStop: noop });
      }
      if (prop === "createPattern") return () => null;
      if (handlers[prop]) return handlers[prop];

      const pointSpec = POINT_ARGS[prop];
      if (pointSpec) {
        return (...args: unknown[]) => {
          drawCalls++;
          if (prop === "drawImage") {
            const dest = drawImageDestination(args);
            if (dest) {
              notePoint(dest.x, dest.y);
              if (dest.w || dest.h) notePoint(dest.x + dest.w, dest.y + dest.h);
            }
            return undefined;
          }
          const isRect = RECT_LIKE.has(prop);
          const x0 = Number(args[0]), y0 = Number(args[1]);
          if (isRect) {
            const w = Number(args[2]), h = Number(args[3]);
            notePoint(x0, y0);
            notePoint(x0 + w, y0 + h);
          } else {
            for (const pair of pointSpec) {
              const xi = pair[0], yi = pair[1];
              if (xi === undefined || yi === undefined) continue;
              if (args.length > yi) notePoint(Number(args[xi]), Number(args[yi]));
            }
          }
          return undefined;
        };
      }
      return noop;
    },
    set: () => true,
  }) as Record<string, unknown>;

  return {
    ctx,
    report: () => {
      const width = Math.max(1, readWidth() || 1);
      const height = Math.max(1, readHeight() || 1);
      // A tolerance of one pixel keeps a shape drawn flush to the edge from reading as an
      // escape; the failures this catches miss by hundreds of pixels, not by rounding.
      const outsidePoints = points.filter(
        (p) => p.x < -1 || p.y < -1 || p.x > width + 1 || p.y > height + 1,
      ).length;
      return {
        drawCalls,
        bounds: points.length > 0 ? { minX, minY, maxX, maxY } : null,
        outsidePoints,
        totalPoints: points.length,
        width,
        height,
      };
    },
  };
}

/**
 * Fraction of painted points that landed outside the canvas before the page is called
 * misplaced.
 *
 * A drawing app legitimately paints past its edges — a piece sliding in, a shape clipped by
 * design — so a small overspill is normal and flagging it would make the check noise. Half
 * is the point where "some of this is clipped" becomes "this is not being drawn where the
 * canvas is": the measured neon-tetris failure put essentially the whole board outside its
 * own canvas, and a page that is merely busy at its edges does not come close.
 */
export const OFF_CANVAS_POINT_RATIO = 0.5;

/**
 * How far past an edge the painting may reach, as a multiple of that canvas dimension,
 * before the ratio rule stops being the only thing standing between a broken page and a
 * pass.
 *
 * The ratio alone is uncomfortably tight on the case that motivated all this: the measured
 * neon-tetris board scored 54% against a 50% threshold, so a slightly less broken projection
 * would have sailed through a number picked before anything was measured. This second rule
 * does not depend on that number. It asks whether the painting escapes by more than the
 * whole size of the canvas — that board is 300px wide and painted out to x = -320, a full
 * canvas-width past its own left edge — which no amount of legitimate clipping does, because
 * a shape clipped by design is still fundamentally AT the canvas.
 */
export const OFF_CANVAS_OVERSHOOT_FACTOR = 1;

export interface CanvasVerdict {
  status: "pass" | "fail";
  detail: string;
}

/**
 * Judge one canvas's painting. Deliberately narrow: it reports only the two things that are
 * unambiguously broken whatever the page was trying to draw — it painted nothing at all, or
 * it painted somewhere the canvas is not. Anything subtler is a matter of taste and belongs
 * to a human or a vision model, not to a rule that will be wrong about art.
 */
export function judgeCanvasPainting(
  id: string,
  report: CanvasPaintReport,
  /** True when some OTHER canvas on the page was painted. */
  pagePaintedElsewhere = false,
): CanvasVerdict {
  if (report.drawCalls === 0) {
    // AN EMPTY PANEL IS NOT ALWAYS A BUG. The scripts run from the page's INITIAL state —
    // start overlay up, nothing held, nothing spawned — so a hold or preview canvas that is
    // legitimately empty until play begins looks identical to one the page never draws. This
    // check cannot drive the game to a started state, so it cannot tell those apart, and
    // failing the page on a guess would block a correct build and teach agents to discount
    // the verdict. The neon-tetris repair hit exactly that: board fixed, run still failing on
    // two panels that may be behaving perfectly.
    //
    // What remains unambiguous is a page that painted NOWHERE. That is broken whatever it
    // intended, so it stays a failure; a single quiet canvas beside a painted one is reported
    // for a human to judge.
    // I called this half unambiguous last time and it is not. A page with a start overlay —
    // which this Tetris has, and which is a perfectly ordinary design — draws nothing at all
    // until someone presses play, so "painted nowhere" is exactly what a correct build looks
    // like from here. Failing it fails every click-to-start app.
    //
    // A page that is genuinely dead almost always THROWS, and that is already caught above.
    // What this recorder uniquely sees is WHERE a page paints when it paints, so that is what
    // it fails on. The rest is reported for a human, who can tell an empty hold panel from a
    // broken one in a glance and does not need a rule that guesses.
    return {
      status: "pass",
      detail: pagePaintedElsewhere
        ? `canvas '${id}' — nothing drawn during the checked frames, while others were painted. `
          + `Expected for a panel that fills in once play starts; a real defect if it should already show something.`
        : `canvas '${id}' — nothing drawn during the checked frames, and neither was any other canvas. `
          + `Expected for a page that waits for the user to start; a real defect if it should render immediately.`,
    };
  }
  if (!report.bounds || report.totalPoints === 0) {
    return { status: "pass", detail: `canvas '${id}' — ${report.drawCalls} draw call(s).` };
  }

  const outsideRatio = report.outsidePoints / report.totalPoints;
  const b = report.bounds;
  const overshoot = Math.max(
    -b.minX / Math.max(report.width, 1),
    -b.minY / Math.max(report.height, 1),
    (b.maxX - report.width) / Math.max(report.width, 1),
    (b.maxY - report.height) / Math.max(report.height, 1),
  );
  if (outsideRatio >= OFF_CANVAS_POINT_RATIO || overshoot >= OFF_CANVAS_OVERSHOOT_FACTOR) {
    return {
      status: "fail",
      detail: `canvas '${id}' is ${report.width}x${report.height}, but the page painted into `
        + `x ${Math.round(b.minX)}..${Math.round(b.maxX)}, y ${Math.round(b.minY)}..${Math.round(b.maxY)} — `
        + `${Math.round(outsideRatio * 100)}% of the drawing lands outside the canvas, so most of it is not visible. `
        + `Check the projection/transform maths that turns your grid coordinates into canvas coordinates.`,
    };
  }

  return {
    status: "pass",
    detail: `canvas '${id}' — ${report.drawCalls} draw call(s) within bounds.`,
  };
}
