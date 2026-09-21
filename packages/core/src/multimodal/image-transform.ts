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
function sharpenKernel(amount: number): number[][] {
  const a = Math.max(0, Math.min(3, amount));
  return [
    [0, -a, 0],
    [-a, 1 + 4 * a, -a],
    [0, -a, 0],
  ];
}

/** Human-readable record of what was done, so the caller can state it rather than guess. */
function describe(operation: ImageTransformOp): string {
  switch (operation.op) {
    case "sharpen": return `sharpen(${operation.amount ?? 1})`;
    case "soften": return `soften(radius ${operation.radius ?? 2})`;
    case "resize": return `resize(${operation.width ?? "auto"}x${operation.height ?? "auto"})`;
    case "crop": return `crop(${operation.x},${operation.y} ${operation.width}x${operation.height})`;
    case "rotate": return `rotate(${operation.degrees}°)`;
    case "flip": return `flip(${operation.horizontal ? "h" : ""}${operation.vertical ? "v" : ""})`;
    case "brightness": return `brightness(${operation.amount})`;
    case "contrast": return `contrast(${operation.amount})`;
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

  const image = await Jimp.read(input);
  const before = { width: image.bitmap.width, height: image.bitmap.height };
  const applied: string[] = [];

  for (const operation of operations) {
    switch (operation.op) {
      case "sharpen":
        image.convolute(sharpenKernel(operation.amount ?? 1));
        break;
      case "soften":
        image.blur(Math.max(1, Math.round(operation.radius ?? 2)));
        break;
      case "resize": {
        if (operation.width === undefined && operation.height === undefined) {
          throw new Error("resize needs a width, a height, or both.");
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
      case "rotate":
        image.rotate(operation.degrees);
        break;
      case "flip":
        image.flip(operation.horizontal === true, operation.vertical === true);
        break;
      case "brightness":
        image.brightness(Math.max(-1, Math.min(1, operation.amount)));
        break;
      case "contrast":
        image.contrast(Math.max(-1, Math.min(1, operation.amount)));
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
    applied.push(describe(operation));
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
