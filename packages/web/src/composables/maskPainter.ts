/**
 * The pixel side of painting an edit mask — kept apart from the canvas so it can be checked on
 * its own.
 *
 * The mask is the size of the base picture and its ALPHA is the whole message: a TRANSPARENT
 * pixel may be changed by the render, an OPAQUE one is kept. It starts fully opaque (nothing may
 * change), the brush makes pixels transparent, the eraser makes them opaque again. The colour
 * channels stay 0 throughout, so the exported PNG is small and a canvas's premultiplied alpha
 * cannot shift anything.
 *
 * Polarity mistakes are silent — a mask the wrong way round still renders, it just changes the
 * part that was meant to be kept — so every rule here says which way it goes.
 */

export interface MaskImage {
  width: number;
  height: number;
  /** RGBA, row-major, like an ImageData's. */
  data: Uint8ClampedArray;
}

export interface Point {
  x: number;
  y: number;
}

export interface DirtyRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type BrushMode = "paint" | "erase";

/** The alpha below which the server counts a pixel as "may change". */
const EDITABLE_BELOW = 128;
export const MIN_BRUSH = 4;
export const MAX_BRUSH = 256;
export const UNDO_LIMIT = 20;

/** A mask the size of the base in which nothing may change yet. */
export function createMask(width: number, height: number): MaskImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { width, height, data };
}

/**
 * Bring a mask loaded from elsewhere (the agent's own) to this module's form: colour cleared,
 * alpha either fully transparent or fully opaque on the server's own threshold.
 */
export function normalizeMask(mask: MaskImage): MaskImage {
  const { data } = mask;
  for (let i = 0; i < data.length; i += 4) {
    const editable = data[i + 3]! < EDITABLE_BELOW;
    data[i] = 0;
    data[i + 1] = 0;
    data[i + 2] = 0;
    data[i + 3] = editable ? 0 : 255;
  }
  return mask;
}

export function isEditable(mask: MaskImage, x: number, y: number): boolean {
  return mask.data[(y * mask.width + x) * 4 + 3]! < EDITABLE_BELOW;
}

/**
 * One brush movement: round discs along the segment, close enough together that a fast stroke
 * leaves no gaps. `paint` makes the pixels transparent (may change); `erase` makes them opaque
 * (kept). Returns the rectangle touched, or null when the segment lies outside the picture.
 */
export function paintSegment(mask: MaskImage, from: Point, to: Point, radius: number, mode: BrushMode): DirtyRect | null {
  const r = Math.max(0.5, radius);
  const minX = Math.max(0, Math.floor(Math.min(from.x, to.x) - r));
  const minY = Math.max(0, Math.floor(Math.min(from.y, to.y) - r));
  const maxX = Math.min(mask.width - 1, Math.ceil(Math.max(from.x, to.x) + r));
  const maxY = Math.min(mask.height - 1, Math.ceil(Math.max(from.y, to.y) + r));
  if (minX > maxX || minY > maxY) return null;

  const alpha = mode === "paint" ? 0 : 255;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSq = dx * dx + dy * dy;
  const rSq = r * r;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      // Distance from the pixel centre to the segment — a capsule, which is the union of every
      // disc along the stroke without having to stamp them one by one.
      const px = x + 0.5 - from.x;
      const py = y + 0.5 - from.y;
      const t = lengthSq > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / lengthSq)) : 0;
      const ex = px - t * dx;
      const ey = py - t * dy;
      if (ex * ex + ey * ey <= rSq) mask.data[(y * mask.width + x) * 4 + 3] = alpha;
    }
  }
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Swap what may change and what is kept. */
export function invertMask(mask: MaskImage): void {
  const { data } = mask;
  for (let i = 3; i < data.length; i += 4) data[i] = 255 - data[i]!;
}

/** Back to the start: nothing may change. */
export function clearMask(mask: MaskImage): void {
  const { data } = mask;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 0;
    data[i + 1] = 0;
    data[i + 2] = 0;
    data[i + 3] = 255;
  }
}

export interface MaskCoverage {
  /** Pixels that may change. */
  editable: number;
  total: number;
  ratio: number;
}

export function maskCoverage(mask: MaskImage): MaskCoverage {
  const { data } = mask;
  let editable = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i]! < EDITABLE_BELOW) editable += 1;
  const total = mask.width * mask.height;
  return { editable, total, ratio: total ? editable / total : 0 };
}

/**
 * A mask is worth sending only when it marks SOME but not ALL of the picture: nothing marked
 * changes nothing, everything marked is just an unmasked edit — and the render service refuses
 * both.
 */
export function canExportMask(coverage: MaskCoverage): boolean {
  return coverage.editable > 0 && coverage.editable < coverage.total;
}

/** "18%", never rounded onto the two ends that cannot be sent. */
export function coverageLabel(coverage: MaskCoverage): string {
  if (coverage.editable === 0) return "0%";
  if (coverage.editable === coverage.total) return "100%";
  const percent = Math.round(coverage.ratio * 100);
  if (percent < 1) return "<1%";
  if (percent > 99) return ">99%";
  return `${percent}%`;
}

/** Where a pointer lands on the picture, from where it lands on the scaled element showing it. */
export function mapPointerToImage(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  width: number,
  height: number,
): Point {
  const x = rect.width > 0 ? ((clientX - rect.left) / rect.width) * width : 0;
  const y = rect.height > 0 ? ((clientY - rect.top) / rect.height) * height : 0;
  return { x: Math.max(0, Math.min(width, x)), y: Math.max(0, Math.min(height, y)) };
}

export function clampBrush(size: number): number {
  return Math.max(MIN_BRUSH, Math.min(MAX_BRUSH, Math.round(size)));
}

/** About a twentieth of the shorter side — big enough to paint a region in a few strokes. */
export function defaultBrushSize(width: number, height: number): number {
  return clampBrush(Math.min(width, height) * 0.05);
}

/**
 * The tint drawn over the base to show the region that may change. `out` is the overlay's own
 * RGBA buffer (same size as the mask); only `rect` is redrawn when given.
 */
export function renderOverlay(mask: MaskImage, out: Uint8ClampedArray, rect?: DirtyRect): void {
  const x0 = rect?.x ?? 0;
  const y0 = rect?.y ?? 0;
  const x1 = rect ? rect.x + rect.width : mask.width;
  const y1 = rect ? rect.y + rect.height : mask.height;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * mask.width + x) * 4;
      const editable = mask.data[i + 3]! < EDITABLE_BELOW;
      out[i] = 167;
      out[i + 1] = 139;
      out[i + 2] = 250;
      out[i + 3] = editable ? 140 : 0;
    }
  }
}

/** Memory the undo history may take. Only alpha is kept — the colour is always 0. */
const UNDO_BYTES = 48 * 1024 * 1024;

/** How many steps back fit the budget at this size: the full twenty for a normal picture, fewer for a huge one. */
export function undoLimitFor(width: number, height: number): number {
  return Math.max(3, Math.min(UNDO_LIMIT, Math.floor(UNDO_BYTES / Math.max(1, width * height))));
}

/** Remember the mask before a change, dropping the oldest past the limit. */
export function pushUndo(stack: Uint8Array[], mask: MaskImage, limit = undoLimitFor(mask.width, mask.height)): Uint8Array[] {
  const alpha = new Uint8Array(mask.width * mask.height);
  for (let p = 0, i = 3; p < alpha.length; p += 1, i += 4) alpha[p] = mask.data[i]!;
  const next = [...stack, alpha];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/** Put the last remembered mask back. Returns the stack without it; the mask is unchanged when there is none. */
export function popUndo(stack: Uint8Array[], mask: MaskImage): Uint8Array[] {
  const last = stack[stack.length - 1];
  if (!last || last.length !== mask.width * mask.height) return stack;
  for (let p = 0, i = 3; p < last.length; p += 1, i += 4) mask.data[i] = last[p]!;
  return stack.slice(0, -1);
}
