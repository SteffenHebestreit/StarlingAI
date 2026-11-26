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
 * The patched regions are the render's, enlarged to the photo's size. Interpolated, a patch three
 * to four times smaller than the photo is that much softer than the pixels around it: the pavement
 * left where a car was taken out looked out of focus. So the changed region alone is cut from the
 * render and enlarged by an upscaling model when the caller has one (comfyui-upscale.ts), and only
 * interpolated when it has none or the model does not answer.
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
/** Render pixels kept around the changed region when it is cut out: an upscaler draws its edges from what is beside them. */
const PATCH_MARGIN = 8;
/** Below this enlargement interpolation loses little, and the model is not asked. */
const MODEL_UPSCALE_MIN_FACTOR = 1.5;

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
  /** How the changed region was enlarged to the photo's size: by the upscaling model, or interpolated. */
  patchScaling?: "model" | "interpolated";
}

export interface EditCompositeOptions {
  /**
   * Enlarges a PNG of the changed region (an upscaling model, by its own factor). Nothing back,
   * no function, or a picture of another shape, and the region is interpolated instead.
   */
  upscale?: (png: Buffer) => Promise<Buffer | undefined>;
}

interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Lay `edited` (the render) onto `original` wherever it differs from `sent` (the scaled base the
 * engine was given, at the render's size). All three are encoded pictures; the result keeps the
 * original's format when that is a JPEG, and is a PNG otherwise.
 */
export async function compositeEditOntoOriginal(
  original: Buffer, sent: Buffer, edited: Buffer, options: EditCompositeOptions = {},
): Promise<EditCompositeOutcome> {
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
  const region = maskBounds(mask.soft, width, height);
  const target = scaledRegion(region, outWidth / width, outHeight / height, outWidth, outHeight);
  const crop = render.clone().crop(region.x, region.y, region.width, region.height);
  const { patch, scaling } = await enlargePatch(crop, target, options.upscale);
  const weights = weightsIn(target, mask.soft, width, height, outWidth, outHeight);
  const grain = grainToAdd(photo.bitmap.data, outWidth, patch.bitmap.data, target, weights);
  blendInto(photo.bitmap.data, outWidth, patch.bitmap.data, target, weights, offset, grain);

  const jpeg = original[0] === 0xff && original[1] === 0xd8;
  const bytes = jpeg
    ? await photo.quality(JPEG_QUALITY).getBufferAsync(Jimp.MIME_JPEG)
    : await photo.getBufferAsync(Jimp.MIME_PNG);
  return {
    changedShare: mask.share,
    patchScaling: scaling,
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

/** The smallest rectangle, in render pixels, holding every pixel the mask touches, with PATCH_MARGIN around it. */
function maskBounds(soft: Float32Array, width: number, height: number): Region {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (soft[y * width + x]! <= 0.001) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (right < 0) return { x: 0, y: 0, width, height };
  const x = Math.max(0, left - PATCH_MARGIN);
  const y = Math.max(0, top - PATCH_MARGIN);
  return { x, y, width: Math.min(width, right + 1 + PATCH_MARGIN) - x, height: Math.min(height, bottom + 1 + PATCH_MARGIN) - y };
}

/** The same rectangle in the photo's pixels, rounded outward. */
function scaledRegion(region: Region, scaleX: number, scaleY: number, outWidth: number, outHeight: number): Region {
  const x = Math.floor(region.x * scaleX);
  const y = Math.floor(region.y * scaleY);
  const right = Math.min(outWidth, Math.ceil((region.x + region.width) * scaleX));
  const bottom = Math.min(outHeight, Math.ceil((region.y + region.height) * scaleY));
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

/** The cut-out region at the size it covers in the photo: enlarged by the model when there is one and it answers, else interpolated. */
async function enlargePatch(
  crop: Jimp, target: Region, upscale: EditCompositeOptions["upscale"],
): Promise<{ patch: Jimp; scaling: "model" | "interpolated" }> {
  const cropWidth = crop.bitmap.width;
  const cropHeight = crop.bitmap.height;
  if (upscale && target.width >= cropWidth * MODEL_UPSCALE_MIN_FACTOR) {
    const bytes = await upscale(await crop.getBufferAsync(Jimp.MIME_PNG)).catch(() => undefined);
    const upscaled = bytes ? await Jimp.read(bytes).catch(() => undefined) : undefined;
    // Larger, and still the crop's shape: anything else is not this region enlarged.
    const sameShape = upscaled
      && Math.abs(upscaled.bitmap.width / upscaled.bitmap.height - cropWidth / cropHeight) < 0.02;
    if (upscaled && sameShape && upscaled.bitmap.width > cropWidth) {
      // The default resampler averages when it shrinks the model's x4 to the photo's factor.
      upscaled.resize(target.width, target.height);
      return { patch: upscaled, scaling: "model" };
    }
  }
  crop.resize(target.width, target.height, Jimp.RESIZE_BICUBIC);
  return { patch: crop, scaling: "interpolated" };
}

/** The mask sampled bilinearly at the photo's size, for each pixel of `target` (0: the photo, 1: the patch). */
function weightsIn(
  target: Region, soft: Float32Array, maskWidth: number, maskHeight: number, photoWidth: number, photoHeight: number,
): Float32Array {
  const weights = new Float32Array(target.width * target.height);
  const scaleX = maskWidth / photoWidth;
  const scaleY = maskHeight / photoHeight;
  for (let row = 0; row < target.height; row += 1) {
    const my = Math.min(maskHeight - 1, Math.max(0, (target.y + row + 0.5) * scaleY - 0.5));
    const y0 = Math.floor(my);
    const y1 = Math.min(maskHeight - 1, y0 + 1);
    const fy = my - y0;
    for (let column = 0; column < target.width; column += 1) {
      const mx = Math.min(maskWidth - 1, Math.max(0, (target.x + column + 0.5) * scaleX - 0.5));
      const x0 = Math.floor(mx);
      const x1 = Math.min(maskWidth - 1, x0 + 1);
      const fx = mx - x0;
      const top = soft[y0 * maskWidth + x0]! * (1 - fx) + soft[y0 * maskWidth + x1]! * fx;
      const bottom = soft[y1 * maskWidth + x0]! * (1 - fx) + soft[y1 * maskWidth + x1]! * fx;
      weights[row * target.width + column] = top * (1 - fy) + bottom * fy;
    }
  }
  return weights;
}

/** Fewer untouched (or fully patched) pixels than this inside the rectangle, and the grain is not measured. */
const GRAIN_MIN_SAMPLES = 2_000;
/** The most grain added, as a standard deviation in 0-255 levels: a photo noisier than this is noise, not grain. */
const MAX_GRAIN = 10;

/**
 * The grain the patch lacks, as the standard deviation of the noise to add to it. A render enlarged
 * from a megapixel is smooth, and laid into a photo it reads as pasted on: the photo has a sensor's
 * grain, the patch has none. Measured on both sides of the line inside the rectangle (the photo
 * where nothing changed, the patch where it is laid in whole) as the median of the fine detail
 * (each pixel against its four neighbours), which edges and texture barely move and grain sets.
 */
function grainToAdd(photo: Buffer, photoWidth: number, patch: Buffer, target: Region, weights: Float32Array): number {
  const photoLevels = new Uint32Array(256);
  const patchLevels = new Uint32Array(256);
  const luma = (bytes: Buffer, at: number) => 0.299 * bytes[at]! + 0.587 * bytes[at + 1]! + 0.114 * bytes[at + 2]!;
  for (let row = 1; row < target.height - 1; row += 1) {
    for (let column = 1; column < target.width - 1; column += 1) {
      const weight = weights[row * target.width + column]!;
      if (weight > 0.001 && weight < 0.999) continue;
      const inPatch = weight >= 0.999;
      const bytes = inPatch ? patch : photo;
      const stride = (inPatch ? target.width : photoWidth) * 4;
      const at = inPatch ? (row * target.width + column) * 4 : ((target.y + row) * photoWidth + target.x + column) * 4;
      const around = (luma(bytes, at - 4) + luma(bytes, at + 4) + luma(bytes, at - stride) + luma(bytes, at + stride)) / 4;
      (inPatch ? patchLevels : photoLevels)[Math.min(255, Math.round(Math.abs(luma(bytes, at) - around)))]! += 1;
    }
  }
  const count = (levels: Uint32Array) => levels.reduce((sum, value) => sum + value, 0);
  if (count(photoLevels) < GRAIN_MIN_SAMPLES || count(patchLevels) < GRAIN_MIN_SAMPLES) return 0;
  // A normal deviation from its median absolute value; the four-neighbour difference of white noise
  // has 1.25 times the noise's variance.
  const deviation = (levels: Uint32Array) => (1.4826 * histogramMedian(levels)) / Math.sqrt(1.25);
  const missing = deviation(photoLevels) ** 2 - deviation(patchLevels) ** 2;
  return missing > 0 ? Math.min(MAX_GRAIN, Math.sqrt(missing)) : 0;
}

/**
 * Mix the enlarged patch into the photo inside `target` by `weights`, with the tone shift and
 * `grain` (a fixed noise pattern, so the same edit gives the same picture). Outside `target` the
 * mask is zero, so the photo is not touched there.
 */
function blendInto(
  photo: Buffer, photoWidth: number, patch: Buffer, target: Region,
  weights: Float32Array, offset: [number, number, number], grain: number,
): void {
  const noise = grain > 0 ? gaussianNoise(0x5eed) : undefined;
  for (let row = 0; row < target.height; row += 1) {
    for (let column = 0; column < target.width; column += 1) {
      const weight = weights[row * target.width + column]!;
      if (weight <= 0.001) continue;
      const at = ((target.y + row) * photoWidth + target.x + column) * 4;
      const from = (row * target.width + column) * 4;
      const speck = noise ? noise() * grain : 0;
      for (let channel = 0; channel < 3; channel += 1) {
        const patched = Math.max(0, Math.min(255, patch[from + channel]! + offset[channel]! + speck));
        photo[at + channel] = Math.round(photo[at + channel]! * (1 - weight) + patched * weight);
      }
    }
  }
}

/** Standard normal numbers from a seeded generator (mulberry32 and Box-Muller). */
function gaussianNoise(seed: number): () => number {
  let state = seed >>> 0;
  const uniform = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (((value ^ (value >>> 14)) >>> 0) + 0.5) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
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
  return histogramMedian(histogram);
}

/** The median level of a 0-255 histogram. */
function histogramMedian(histogram: Uint32Array): number {
  const total = histogram.reduce((sum, value) => sum + value, 0);
  let seen = 0;
  for (let level = 0; level < 256; level += 1) {
    seen += histogram[level]!;
    if (seen * 2 >= total) return level;
  }
  return 255;
}
