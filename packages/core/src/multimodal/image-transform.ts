/**
 * Deterministic raster edits — sharpen, soften, resize, crop, rotate, adjust.
 *
 * These are NOT diffusion. That distinction is the whole reason this module exists: a user
 * asking to sharpen a picture wants that picture sharper, and routing it through the image
 * model would spend ~170 s of a GPU the whole cluster shares AND return a different picture,
 * which is exactly the failure that lost a user their palm trees across three rounds of
 * "continue from the last one". Here the output is the input with one transform applied, in
 * milliseconds, and nothing else can change.
 *
 * Operations are applied in the order given, so a single call can crop then sharpen without
 * writing an intermediate file or paying twice.
 */
import Jimp from "jimp";
import { decodesWithinDeclaredSize, readImageHeaderSize } from "./image-generation.js";

/**
 * The most pixels a transform decodes, produces or works in — the last meaning the buffers Jimp
 * fills on the way to a result, which can be far larger than the result (rotate's canvas, the rows
 * resize widens). About where Jimp's own JPEG decoder stops (jpeg-js's 512 MB of working memory:
 * measured, a 6000x4000 JPEG decodes in 1 s and a 7000x5000 one is refused). A PNG has no such
 * stop: 40 MP is 160 MB once decoded, and each operation copies it.
 */
export const MAX_TRANSFORM_PIXELS = 40_000_000;

/**
 * The widest soften Jimp computes correctly. Its blur sums each channel over a (2r+1)² box and
 * scales the sum with a 32-bit multiply, which overflows from radius 145 on: measured, radius 145
 * turns a white picture black and radius 300 leaves every pixel fully transparent — while the
 * tool reported the soften as applied. Every radius up to this one keeps the scaled sums within 32 bits.
 */
const MAX_SOFTEN_RADIUS = 144;

export type ImageTransformOp =
  | { op: "sharpen"; amount?: number }
  | { op: "soften"; radius?: number }
  | { op: "resize"; width?: number; height?: number }
  | { op: "crop"; x: number; y: number; width: number; height: number }
  | { op: "rotate"; degrees: number }
  | { op: "flip"; horizontal?: boolean; vertical?: boolean }
  | { op: "brightness"; amount: number }
  | { op: "contrast"; amount: number }
  | { op: "grayscale" }
  | { op: "normalize" };

export interface ImageTransformResult {
  bytes: Buffer;
  before: { width: number; height: number };
  after: { width: number; height: number };
  applied: string[];
}

/**
 * A 3x3 sharpen kernel, scaled by `amount`.
 *
 * At amount 1 this is the textbook [[0,-1,0],[-1,5,-1],[0,-1,0]]. Scaling toward 0 blends it
 * back to the identity, so "a little sharper" is expressible — a fixed kernel only offers
 * "sharpened" or "not", and repeated application to reach something milder instead amplifies
 * noise and halos.
 */
function sharpenKernel(amount: number | undefined): number[][] {
  const a = sharpenAmount(amount);
  return [
    [0, -a, 0],
    [-a, 1 + 4 * a, -a],
    [0, -a, 0],
  ];
}

/**
 * The side of the square Jimp turns a picture on for any angle but a right one — its own
 * arithmetic (the turned bounding box plus a border pixel, rounded up to even), then as wide as
 * the longest side before or after. It fills that canvas, turns it into a second buffer the same
 * size, and only then crops to the result.
 */
function rotationCanvasSide(width: number, height: number, degrees: number): number {
  const radians = ((degrees % 360) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  const even = (side: number) => side + (side % 2);
  const turnedWidth = even(Math.ceil(width * cos + height * sin) + 1);
  const turnedHeight = even(Math.ceil(width * sin + height * cos) + 1);
  return Math.max(turnedWidth, turnedHeight, width, height);
}

/**
 * The longest side this picture could be resized to — one side given, so resize keeps the aspect
 * ratio exactly as computed here — and still turn by `degrees` within the bound. A refusal that
 * names it gives the caller a way forward instead of a dead end: a 24 MP photo straightened by 5°
 * is refused, and resized a little first it goes through. Bisected, since the canvas only grows
 * with the picture.
 */
function longestSideThatTurns(width: number, height: number, degrees: number): number {
  const long = Math.max(width, height);
  const turns = (side: number): boolean => {
    const scale = side / long;
    const canvas = rotationCanvasSide(Math.round(width * scale) || 1, Math.round(height * scale) || 1, degrees);
    return canvas * canvas <= MAX_TRANSFORM_PIXELS;
  };
  let fits = 1;
  let tooLong = long;
  while (tooLong - fits > 1) {
    const middle = Math.floor((fits + tooLong) / 2);
    if (turns(middle)) fits = middle;
    else tooLong = middle;
  }
  return fits;
}

/**
 * A refusal for a value that is not the number an operation takes, worded so the caller can see
 * what to change. Text is quoted and called text: `{degrees: "90"}` refused as "not 90" reads as
 * though 90 itself were wrong, and the same call comes back.
 */
function needsANumber(what: string, value: unknown, kind = "a finite number"): string {
  if (typeof value === "string") return `${what} as a number, not the text ${JSON.stringify(value)}.`;
  return `${what} as ${kind}, not ${typeof value === "object" && value !== null ? JSON.stringify(value) : String(value)}.`;
}

/**
 * `value`, refused unless it is a finite number. Nothing further along refuses one: a soften of
 * radius "abc" left every pixel transparent black and was reported as `soften(radius NaN)`, and a
 * brightness, contrast or sharpen of "abc" turned the picture black — each of them a success.
 */
function finiteNumber(what: string, value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(needsANumber(what, value));
}

/** The radius soften really uses, so what is reported is what was done. */
function softenRadius(radius: number | undefined): number {
  return Math.max(1, Math.min(MAX_SOFTEN_RADIUS, Math.round(finiteNumber("soften needs its radius", radius ?? 2))));
}

/** The amount sharpen really uses, within the kernel's 0-3, for the same reason. */
function sharpenAmount(amount: number | undefined): number {
  return Math.max(0, Math.min(3, finiteNumber("sharpen needs its amount", amount ?? 1)));
}

/** The amount brightness or contrast really uses, within Jimp's -1 to 1, for the same reason. */
function unitAmount(operation: { op: "brightness" | "contrast"; amount: number }): number {
  return Math.max(-1, Math.min(1, finiteNumber(`${operation.op} needs its amount`, operation.amount)));
}

/**
 * Human-readable record of what was done, so the caller can state it rather than guess. `made` is
 * the picture's size after the operation: a resize reports that, not the sides asked for, which
 * read resize(0.4x10) for a picture Jimp made 1x10 (r6 C-image, remaining 5).
 */
function describe(operation: ImageTransformOp, made: { width: number; height: number }): string {
  switch (operation.op) {
    case "sharpen": return `sharpen(${sharpenAmount(operation.amount)})`;
    case "soften": return `soften(radius ${softenRadius(operation.radius)})`;
    case "resize": return `resize(${made.width}x${made.height})`;
    case "crop": return `crop(${operation.x},${operation.y} ${operation.width}x${operation.height})`;
    case "rotate": return `rotate(${operation.degrees}°)`;
    case "flip": return `flip(${operation.horizontal ? "h" : ""}${operation.vertical ? "v" : ""})`;
    case "brightness": return `brightness(${unitAmount(operation)})`;
    case "contrast": return `contrast(${unitAmount(operation)})`;
    case "grayscale": return "grayscale";
    case "normalize": return "normalize";
  }
}

export async function transformImage(
  input: Buffer,
  operations: readonly ImageTransformOp[],
): Promise<ImageTransformResult> {
  if (operations.length === 0) {
    throw new Error("No operations given. transform_image needs at least one, e.g. {op:'sharpen'}.");
  }

  // Judged from the header before anything decodes it: Jimp allocates whatever a picture declares,
  // synchronously, and a small crafted file declares gigabytes — or a size its decoder does not
  // keep to (see readImageHeaderSize and decodesWithinDeclaredSize).
  const declared = readImageHeaderSize(input);
  if (!declared || !decodesWithinDeclaredSize(input)) {
    throw new Error(
      "transform_image reads PNG, JPEG, GIF and BMP pictures, and this file is none of them or is built to decode"
      + " larger than it declares. Nothing was changed.",
    );
  }
  if (declared.width * declared.height > MAX_TRANSFORM_PIXELS) {
    throw new Error(
      `The picture is ${declared.width}x${declared.height}; transform_image works on pictures up to`
      + ` ${MAX_TRANSFORM_PIXELS / 1_000_000} MP. Nothing was changed.`,
    );
  }
  const image = await Jimp.read(input);
  const before = { width: image.bitmap.width, height: image.bitmap.height };
  const applied: string[] = [];

  for (const operation of operations) {
    switch (operation.op) {
      case "sharpen":
        image.convolute(sharpenKernel(operation.amount));
        break;
      case "soften":
        image.blur(softenRadius(operation.radius));
        break;
      case "resize": {
        if (operation.width == null && operation.height == null) {
          throw new Error("resize needs a width, a height, or both.");
        }
        // A side given must be a size. Jimp reads -1 as the side that keeps the aspect ratio, so
        // {width: -1, height: 8000} passed a bound that multiplied the -1 in and made 10667x8000,
        // 85 MP. Omitting the side asks for that, and leaves nothing for a bound to misread.
        for (const [name, side] of [["width", operation.width], ["height", operation.height]] as const) {
          if (side !== undefined && side !== null && !(typeof side === "number" && Number.isFinite(side) && side > 0)) {
            throw new Error(`${needsANumber(`resize needs its ${name}`, side, "a finite number above 0")} Omit a side to keep the aspect ratio.`);
          }
        }
        // The same bound on what it produces as on what it reads: a resize allocates its result.
        // (An 8000-wide resize of a small picture ended in an unhandled "Invalid array length".)
        // Both bounds are on the sides Jimp makes, each rounded and at least 1, not the ones asked
        // for: 0.4x100000000 multiplies to 40 MP, which passed, and Jimp makes it 1x100000000.
        const { width, height } = image.bitmap;
        const newWidth = Math.round(operation.width ?? width * (operation.height! / height)) || 1;
        const newHeight = Math.round(operation.height ?? height * (operation.width! / width)) || 1;
        if (newWidth * newHeight > MAX_TRANSFORM_PIXELS) {
          throw new Error(`resize to ${operation.width ?? "auto"}x${operation.height ?? "auto"} is larger than the ${MAX_TRANSFORM_PIXELS / 1_000_000} MP transform_image works within.`);
        }
        // And on what it works in: Jimp first widens every source row to the new width, as floats
        // at 16 bytes a pixel, and only then changes the height. A 7x7000 strip made 7000x7 is
        // 0.05 MP either side of the call but a 7000x7000 buffer, 784 MB; 10x100000 made 100000x10
        // hung past a minute, synchronously, for every user. Changing the height first, at the old
        // width, skips that pass, so the refusal says so — and both steps it names pass, since the
        // size they end at has already passed the bound above.
        if (newWidth * height > MAX_TRANSFORM_PIXELS) {
          throw new Error(
            `resize to ${operation.width ?? "auto"}x${operation.height ?? "auto"} first widens all ${height} rows of this`
            + ` ${width}x${height} picture to ${newWidth}, larger than the ${MAX_TRANSFORM_PIXELS / 1_000_000} MP transform_image`
            + ` works within. Change the height first: resize{width: ${width}, height: ${newHeight}}, then`
            + ` resize{width: ${newWidth}, height: ${newHeight}} (one call can do both, in that order).`,
          );
        }
        // One side omitted keeps the aspect ratio rather than guessing a square.
        image.resize(operation.width ?? Jimp.AUTO, operation.height ?? Jimp.AUTO);
        break;
      }
      case "crop": {
        const { x, y, width, height } = operation;
        if (x < 0 || y < 0 || width <= 0 || height <= 0
          || x + width > image.bitmap.width || y + height > image.bitmap.height) {
          // Refused rather than clamped: a silently shrunk crop returns a different picture
          // from the one asked for, and nothing downstream would notice.
          throw new Error(
            `crop ${width}x${height} at (${x},${y}) does not fit inside ${image.bitmap.width}x${image.bitmap.height}.`,
          );
        }
        image.crop(x, y, width, height);
        break;
      }
      case "rotate": {
        // The same bound again, on the canvas Jimp allocates rather than on what comes out: only
        // resize was bounded, while a 40 MP picture turned 45° needs about 85 MP. The result alone
        // would not do either — a 20000x1000 panorama turned 1° comes out at 27 MP but is turned
        // on a 20016x20016 canvas, 400 MP twice over. A right angle only swaps the sides.
        // An angle that is not a finite number would make that canvas NaN, which no bound refuses,
        // and Jimp then fails with a message about a buffer size — so it is refused by name here.
        if (!Number.isFinite(operation.degrees)) {
          throw new Error(needsANumber("rotate needs its degrees", operation.degrees));
        }
        if (operation.degrees % 90 !== 0) {
          const side = rotationCanvasSide(image.bitmap.width, image.bitmap.height, operation.degrees);
          if (side * side > MAX_TRANSFORM_PIXELS) {
            const longest = longestSideThatTurns(image.bitmap.width, image.bitmap.height, operation.degrees);
            throw new Error(
              `rotate(${operation.degrees}°) turns this ${image.bitmap.width}x${image.bitmap.height} picture on a`
              + ` ${side}x${side} canvas, larger than the ${MAX_TRANSFORM_PIXELS / 1_000_000} MP transform_image works within.`
              + ` Resize its longer side to ${longest} or less first (one call can do both, in that order).`,
            );
          }
        }
        image.rotate(operation.degrees);
        break;
      }
      case "flip":
        image.flip(operation.horizontal === true, operation.vertical === true);
        break;
      case "brightness":
        image.brightness(unitAmount(operation));
        break;
      case "contrast":
        image.contrast(unitAmount(operation));
        break;
      case "grayscale":
        image.greyscale();
        break;
      case "normalize":
        image.normalize();
        break;
      default: {
        const unknown = operation as { op: string };
        throw new Error(`Unknown operation "${unknown.op}".`);
      }
    }
    applied.push(describe(operation, image.bitmap));
  }

  const bytes = Buffer.from(await image.getBufferAsync(Jimp.MIME_PNG));
  return { bytes, before, after: { width: image.bitmap.width, height: image.bitmap.height }, applied };
}

/**
 * Make the BYTES match the name, or make the name match the bytes. Never ship a mismatch.
 *
 * This is not pedantry about file extensions. An agent asked for `sunset_beach.jpg`, the
 * image backend only produces PNG, and the client wrote PNG bytes under that name. The
 * artifact verifier correctly refused it — "named .jpg but its bytes are PNG" — and the
 * swarm then spent EIGHT MINUTES trying to repair it: an artifact-repair coordinator, a
 * rejected ephemeral agent, a 221-second coder run transcoding the file, and two
 * progress-verifier interventions. All of it downstream of one line that trusted the
 * caller's extension.
 *
 * So a requested format we can actually encode is produced, and one we cannot is corrected
 * in the name rather than lied about. The caller is told which happened; silently renaming
 * would leave an agent reporting a path that is not the one on disk.
 */
export interface EncodedImage {
  bytes: Buffer;
  extension: string;
  mimeType: string;
  /** Set when the requested extension could not be honoured and the name was corrected. */
  correctedFrom?: string;
}

const ENCODABLE: Record<string, string> = {
  ".png": Jimp.MIME_PNG,
  ".jpg": Jimp.MIME_JPEG,
  ".jpeg": Jimp.MIME_JPEG,
  ".bmp": Jimp.MIME_BMP,
};

export async function encodeImageAs(
  pngBytes: Buffer,
  requestedExtension: string,
  sourceExtension = ".png",
): Promise<EncodedImage> {
  const wanted = requestedExtension.toLowerCase();
  if (!wanted || wanted === sourceExtension) {
    return { bytes: pngBytes, extension: sourceExtension, mimeType: Jimp.MIME_PNG };
  }

  const mime = ENCODABLE[wanted];
  if (!mime) {
    // Nothing we can encode. The bytes are what they are, so the NAME is what changes.
    return {
      bytes: pngBytes, extension: sourceExtension, mimeType: Jimp.MIME_PNG, correctedFrom: wanted,
    };
  }

  const image = await Jimp.read(pngBytes);
  return { bytes: Buffer.from(await image.getBufferAsync(mime)), extension: wanted, mimeType: mime };
}
