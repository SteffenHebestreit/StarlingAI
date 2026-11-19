/**
 * AN EDIT OF A LARGE PHOTO KEEPS THE PHOTO'S RESOLUTION WHERE IT DID NOT CHANGE.
 *
 * The engines draw about one megapixel, so a phone photo is scaled down before it is edited
 * (image-generation.ts sendableEditBase) and the render comes back at that size: "remove the cars
 * in the background" returned a 1184x896 picture of a 4000x3000 photo, every leaf softer. Most
 * edits change a few regions and leave the rest alone, so the render is laid back onto the
 * original instead: where the render differs from the base it was given, the render (scaled up)
 * replaces the photo, feathered at the edges; everywhere else the photo's own pixels stay.
 *
 * What counts as changed is measured, not asked: the difference between the base the engine was
 * sent and the render, blurred so the engine's re-drawing of grass and leaves (a reference edit
 * re-renders the whole frame, ~10 mean difference measured on an unchanged scene) stays below the
 * line and an object taken out (tens to a hundred and more) is far above it. A change that covers
 * most of the picture — a new colour grade, a new sky over everything — is not composited: the
 * render is the result, at the size it was drawn, and the caller says so.
 *
 * The patched regions are the render's, scaled up, so they are softer than the photo around them;
 * that is the trade for everything else being the original.
 */
import Jimp from "jimp";

/** Above this share of the picture the edit is the picture, and nothing is kept from the original. */
export const WHOLE_PICTURE_EDIT_SHARE = 0.6;
/** The blurred per-pixel difference (0-255, the largest channel) below which nothing changed. */
const MIN_CHANGE_LEVEL = 32;
/** At least this many times the picture's own noise floor, so a noisy render needs a clearer change. */
const NOISE_FLOOR_FACTOR = 3;
/**
 * The line never rises above this. The noise floor is the median difference, and when the whole
 * picture changed the median IS the change: uncapped, a regraded picture (median ~150) drew its
 * line above 255 and was reported as an edit that changed nothing.
 */
const MAX_CHANGE_LEVEL = 64;
/** A tone shift between the render and the base larger than this is a change, not drift, and is not corrected. */
const MAX_TONE_SHIFT = 40;
const JPEG_QUALITY = 92;

export interface EditComposite {
  imageBase64: string;
  mimeType: string;
  extension: string;
  width: number;
  height: number;
}

export interface EditCompositeOutcome {
  /** The original with the changed regions replaced; absent when nothing was composited. */
  composite?: EditComposite;
  /** The share of the picture the edit changed, measured at the render's size (0-1). */
  changedShare: number;
  /** Why nothing was composited. */
  skipped?: "whole_picture" | "no_change" | "undecodable";
}

/**
 * Lay `edited` (the render) onto `original` wherever it differs from `sent` (the scaled base the
 * engine was given, at the render's size). All three are encoded pictures; the result keeps the
 * original's format when that is a JPEG, and is a PNG otherwise.
 */
export async function compositeEditOntoOriginal(original: Buffer, sent: Buffer, edited: Buffer): Promise<EditCompositeOutcome> {
  const [base, render] = await Promise.all([Jimp.read(sent), Jimp.read(edited)]).catch(() => [undefined, undefined]);
  if (!base || !render) return { changedShare: 0, skipped: "undecodable" };
  const width = base.bitmap.width;
  const height = base.bitmap.height;
  if (render.bitmap.width !== width || render.bitmap.height !== height) render.resize(width, height, Jimp.RESIZE_BILINEAR);

  const mask = changeMask(base.bitmap.data, render.bitmap.data, width, height);
  if (mask.share === 0) return { changedShare: 0, skipped: "no_change" };
  if (mask.share > WHOLE_PICTURE_EDIT_SHARE) return { changedShare: mask.share, skipped: "whole_picture" };

  const photo = await Jimp.read(original).catch(() => undefined);
  if (!photo) return { changedShare: mask.share, skipped: "undecodable" };
  const offset = toneOffset(base.bitmap.data, render.bitmap.data, mask.soft);
  const outWidth = photo.bitmap.width;
  const outHeight = photo.bitmap.height;
  render.resize(outWidth, outHeight, Jimp.RESIZE_BICUBIC);
  blendInto(photo.bitmap.data, render.bitmap.data, outWidth, outHeight, mask.soft, width, height, offset);

  const jpeg = original[0] === 0xff && original[1] === 0xd8;
  const bytes = jpeg
    ? await photo.quality(JPEG_QUALITY).getBufferAsync(Jimp.MIME_JPEG)
    : await photo.getBufferAsync(Jimp.MIME_PNG);
  return {
    changedShare: mask.share,
    composite: {
      imageBase64: bytes.toString("base64"),
      mimeType: jpeg ? "image/jpeg" : "image/png",
      extension: jpeg ? ".jpg" : ".png",
      width: outWidth,
      height: outHeight,
    },
  };
}

/**
 * Where the render changed the base, as a feathered 0-1 map at the render's size, and the share of
 * the picture it covers. The difference is blurred before the line is drawn, specks narrower than a
 * few pixels are dropped, and what is left is grown a little so an object's outline goes with it.
 */
export function changeMask(base: Uint8Array | Buffer, render: Uint8Array | Buffer, width: number, height: number): { soft: Float32Array; share: number } {
  const pixels = width * height;
  const difference = new Float32Array(pixels);
  for (let index = 0, offset = 0; index < pixels; index += 1, offset += 4) {
    difference[index] = Math.max(
      Math.abs(base[offset]! - render[offset]!),
      Math.abs(base[offset + 1]! - render[offset + 1]!),
      Math.abs(base[offset + 2]! - render[offset + 2]!),
    );
  }
  const longSide = Math.max(width, height);
  const blurred = boxBlur(difference, width, height, Math.max(2, Math.round(longSide * 0.004)));
  const level = Math.min(MAX_CHANGE_LEVEL, Math.max(MIN_CHANGE_LEVEL, NOISE_FLOOR_FACTOR * median(blurred)));

  let changed: Float32Array = new Float32Array(pixels);
  for (let index = 0; index < pixels; index += 1) changed[index] = blurred[index]! > level ? 1 : 0;
  // Open (erode, then dilate) to drop specks, then grow to take the outline along.
  changed = threshold(boxBlur(changed, width, height, 2), 0.999);
  changed = threshold(boxBlur(changed, width, height, 2), 0.001);
  const grow = Math.max(4, Math.round(longSide * 0.012));
  changed = threshold(boxBlur(changed, width, height, grow), 0.001);

  let count = 0;
  for (let index = 0; index < pixels; index += 1) count += changed[index]!;
  const share = count / pixels;
  const soft = boxBlur(changed, width, height, Math.max(2, Math.round(grow / 2)));
  return { soft, share };
}

/** The render's average tone shift against the base where nothing changed, per channel, so a patch matches its surroundings. */
function toneOffset(base: Uint8Array | Buffer, render: Uint8Array | Buffer, soft: Float32Array): [number, number, number] {
  const sums = [0, 0, 0];
  let count = 0;
  for (let index = 0, offset = 0; index < soft.length; index += 1, offset += 4) {
    if (soft[index]! > 0) continue;
    for (let channel = 0; channel < 3; channel += 1) sums[channel]! += base[offset + channel]! - render[offset + channel]!;
    count += 1;
  }
  if (count === 0) return [0, 0, 0];
  const clamp = (value: number) => Math.max(-MAX_TONE_SHIFT, Math.min(MAX_TONE_SHIFT, value));
  return [clamp(sums[0]! / count), clamp(sums[1]! / count), clamp(sums[2]! / count)];
}

/** Mix the scaled-up render into the photo, weighted by the mask sampled bilinearly at the photo's size. */
function blendInto(
  photo: Buffer, render: Buffer, width: number, height: number,
  soft: Float32Array, maskWidth: number, maskHeight: number, offset: [number, number, number],
): void {
  const scaleX = maskWidth / width;
  const scaleY = maskHeight / height;
  for (let y = 0; y < height; y += 1) {
    const my = Math.min(maskHeight - 1, Math.max(0, (y + 0.5) * scaleY - 0.5));
    const y0 = Math.floor(my);
    const y1 = Math.min(maskHeight - 1, y0 + 1);
    const fy = my - y0;
    for (let x = 0; x < width; x += 1) {
      const mx = Math.min(maskWidth - 1, Math.max(0, (x + 0.5) * scaleX - 0.5));
      const x0 = Math.floor(mx);
      const x1 = Math.min(maskWidth - 1, x0 + 1);
      const fx = mx - x0;
      const top = soft[y0 * maskWidth + x0]! * (1 - fx) + soft[y0 * maskWidth + x1]! * fx;
      const bottom = soft[y1 * maskWidth + x0]! * (1 - fx) + soft[y1 * maskWidth + x1]! * fx;
      const weight = top * (1 - fy) + bottom * fy;
      if (weight <= 0.001) continue;
      const at = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        const patched = Math.max(0, Math.min(255, render[at + channel]! + offset[channel]!));
        photo[at + channel] = Math.round(photo[at + channel]! * (1 - weight) + patched * weight);
      }
    }
  }
}

/** A square box blur of radius `radius`, separable, with running sums; edges average what is inside. */
function boxBlur(source: Float32Array, width: number, height: number, radius: number): Float32Array {
  const across = new Float32Array(source.length);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let sum = 0;
    let count = 0;
    for (let x = 0; x <= Math.min(radius, width - 1); x += 1) { sum += source[row + x]!; count += 1; }
    for (let x = 0; x < width; x += 1) {
      across[row + x] = sum / count;
      const enter = x + radius + 1;
      const leave = x - radius;
      if (enter < width) { sum += source[row + enter]!; count += 1; }
      if (leave >= 0) { sum -= source[row + leave]!; count -= 1; }
    }
  }
  const out = new Float32Array(source.length);
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    let count = 0;
    for (let y = 0; y <= Math.min(radius, height - 1); y += 1) { sum += across[y * width + x]!; count += 1; }
    for (let y = 0; y < height; y += 1) {
      out[y * width + x] = sum / count;
      const enter = y + radius + 1;
      const leave = y - radius;
      if (enter < height) { sum += across[enter * width + x]!; count += 1; }
      if (leave >= 0) { sum -= across[leave * width + x]!; count -= 1; }
    }
  }
  return out;
}

function threshold(values: Float32Array, above: number): Float32Array {
  const out = new Float32Array(values.length);
  for (let index = 0; index < values.length; index += 1) out[index] = values[index]! > above ? 1 : 0;
  return out;
}

/** The median of values in 0-255, by histogram. */
function median(values: Float32Array): number {
  const histogram = new Uint32Array(256);
  for (let index = 0; index < values.length; index += 1) histogram[Math.min(255, Math.max(0, Math.round(values[index]!)))]! += 1;
  let seen = 0;
  for (let level = 0; level < 256; level += 1) {
    seen += histogram[level]!;
    if (seen * 2 >= values.length) return level;
  }
  return 255;
}
