/**
 * A DOWNSCALED EDIT GOES BACK ONTO THE FULL-SIZE ORIGINAL, AND ONLY WHERE IT CHANGED SOMETHING.
 *
 * A phone photo is edited at the engines' size (about one megapixel) and used to come back at that
 * size. Now the regions the render changed are laid onto the original and everything else stays
 * the original's own pixels. The fixtures are a textured "photo" with a red block (the thing to
 * remove); the "render" is the scaled-down base with the block painted over and the engine's
 * re-drawing simulated as small noise everywhere.
 */
import Jimp from "jimp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compositeEditOntoOriginal, WHOLE_PICTURE_EDIT_SHARE } from "../multimodal/image-edit-composite.js";
import { requestImageGeneration, type ImageGenerationBackendConfig } from "../multimodal/image-generation.js";
import { imageRequestFields } from "./helpers/image-request-fields.js";

const WIDTH = 2400;
const HEIGHT = 1800;
/** The block to remove, in the original's pixels. */
const BLOCK = { x: 1500, y: 300, w: 300, h: 200 };

/** A deterministic texture: a gradient with a fine pattern, like grass and sky, not a flat field. */
function texture(x: number, y: number): [number, number, number] {
  const fine = ((x * 7 + y * 13) % 17) - 8;
  return [60 + Math.round((x / WIDTH) * 60) + fine, 120 + Math.round((y / HEIGHT) * 60) + fine, 70 + fine];
}

function photo(): Jimp {
  const picture = new Jimp(WIDTH, HEIGHT, 0x000000ff);
  picture.scan(0, 0, WIDTH, HEIGHT, (x, y, at) => {
    const inBlock = x >= BLOCK.x && x < BLOCK.x + BLOCK.w && y >= BLOCK.y && y < BLOCK.y + BLOCK.h;
    const [r, g, b] = inBlock ? [220, 30, 30] : texture(x, y);
    picture.bitmap.data[at] = r; picture.bitmap.data[at + 1] = g; picture.bitmap.data[at + 2] = b; picture.bitmap.data[at + 3] = 255;
  });
  return picture;
}

/** What an engine would hand back for "remove the red block": the base with the block repainted, and a little re-drawing noise. */
async function renderWithoutBlock(sent: Buffer, noise = 3): Promise<Buffer> {
  const picture = await Jimp.read(sent);
  const scale = picture.bitmap.width / WIDTH;
  picture.scan(0, 0, picture.bitmap.width, picture.bitmap.height, (x, y, at) => {
    const ox = x / scale;
    const oy = y / scale;
    const inBlock = ox >= BLOCK.x - 4 && ox < BLOCK.x + BLOCK.w + 4 && oy >= BLOCK.y - 4 && oy < BLOCK.y + BLOCK.h + 4;
    const jitter = ((x * 31 + y * 17) % (2 * noise + 1)) - noise;
    for (let channel = 0; channel < 3; channel += 1) {
      const value = inBlock ? texture(ox, oy)[channel]! : picture.bitmap.data[at + channel]!;
      picture.bitmap.data[at + channel] = Math.max(0, Math.min(255, value + jitter));
    }
  });
  return picture.getBufferAsync(Jimp.MIME_PNG);
}

async function scaledDown(original: Jimp, width: number, height: number): Promise<Buffer> {
  return original.clone().resize(width, height, Jimp.RESIZE_BILINEAR).getBufferAsync(Jimp.MIME_PNG);
}

function pixel(picture: Jimp, x: number, y: number): [number, number, number] {
  const at = (y * picture.bitmap.width + x) * 4;
  return [picture.bitmap.data[at]!, picture.bitmap.data[at + 1]!, picture.bitmap.data[at + 2]!];
}

describe("compositeEditOntoOriginal", () => {
  it("replaces the changed region at full size and keeps every other pixel of the original", async () => {
    const original = photo();
    const originalPng = await original.getBufferAsync(Jimp.MIME_PNG);
    const sent = await scaledDown(original, 1184, 888);
    const edited = await renderWithoutBlock(sent);

    const outcome = await compositeEditOntoOriginal(originalPng, sent, edited);

    expect(outcome.composite, JSON.stringify({ ...outcome, composite: undefined })).toBeDefined();
    const result = await Jimp.read(Buffer.from(outcome.composite!.imageBase64, "base64"));
    expect([result.bitmap.width, result.bitmap.height]).toEqual([WIDTH, HEIGHT]);
    // The block is gone: its centre now looks like the texture around it, not red.
    const centre = pixel(result, BLOCK.x + BLOCK.w / 2, BLOCK.y + BLOCK.h / 2);
    expect(centre[0]).toBeLessThan(160);
    // Far from it, the original's own pixels, exactly — not the softer, noisier render.
    for (const [x, y] of [[100, 100], [600, 1500], [2300, 1700], [1200, 900]] as const) {
      expect(pixel(result, x, y)).toEqual(pixel(original, x, y));
    }
    // The change was a few percent of the picture, not the picture.
    expect(outcome.changedShare).toBeGreaterThan(0.005);
    expect(outcome.changedShare).toBeLessThan(0.1);
    expect(outcome.composite!.mimeType).toBe("image/png");
  });

  it("keeps a JPEG original a JPEG", async () => {
    const original = photo();
    const originalJpeg = await original.quality(95).getBufferAsync(Jimp.MIME_JPEG);
    const sent = await scaledDown(original, 1184, 888);

    const outcome = await compositeEditOntoOriginal(originalJpeg, sent, await renderWithoutBlock(sent));

    expect(outcome.composite?.mimeType).toBe("image/jpeg");
    expect(outcome.composite?.extension).toBe(".jpg");
  });

  it("does not composite a change that covers the whole picture — the render is the result", async () => {
    const original = photo();
    const sent = await scaledDown(original, 1184, 888);
    const regraded = (await Jimp.read(sent)).invert();

    const outcome = await compositeEditOntoOriginal(await original.getBufferAsync(Jimp.MIME_PNG), sent, await regraded.getBufferAsync(Jimp.MIME_PNG));

    expect(outcome.composite).toBeUndefined();
    expect(outcome.skipped).toBe("whole_picture");
    expect(outcome.changedShare).toBeGreaterThan(WHOLE_PICTURE_EDIT_SHARE);
  });

  it("reports an edit that changed nothing, beyond the engine's re-drawing, as no change", async () => {
    const original = photo();
    const sent = await scaledDown(original, 1184, 888);
    const redrawn = await Jimp.read(sent);
    redrawn.scan(0, 0, redrawn.bitmap.width, redrawn.bitmap.height, (x, y, at) => {
      const jitter = ((x * 31 + y * 17) % 7) - 3;
      for (let channel = 0; channel < 3; channel += 1) redrawn.bitmap.data[at + channel] = Math.max(0, Math.min(255, redrawn.bitmap.data[at + channel]! + jitter));
    });

    const outcome = await compositeEditOntoOriginal(await original.getBufferAsync(Jimp.MIME_PNG), sent, await redrawn.getBufferAsync(Jimp.MIME_PNG));

    expect(outcome).toMatchObject({ changedShare: 0, skipped: "no_change" });
  });
});

/**
 * THE PATCH IS ENLARGED BY THE UPSCALER, AND ONLY THE PATCH.
 *
 * Interpolated three and a half times, a patch was visibly softer than the photo around it (the
 * flower edit of session b0a37996, rebuilt: blurred sleeve and stem). The changed region alone is
 * cut out, enlarged by an upscaling model and laid in; with no model, or no answer, it is
 * interpolated as before.
 */
describe("the changed region's enlargement", () => {
  /** A stand-in for the model: x4 by repeating pixels, with the blue channel marked so its pixels can be found. */
  const markingUpscaler = (seen: Array<[number, number]>) => async (png: Buffer) => {
    const crop = await Jimp.read(png);
    seen.push([crop.bitmap.width, crop.bitmap.height]);
    crop.resize(crop.bitmap.width * 4, crop.bitmap.height * 4, Jimp.RESIZE_NEAREST_NEIGHBOR);
    crop.scan(0, 0, crop.bitmap.width, crop.bitmap.height, (_x, _y, at) => { crop.bitmap.data[at + 2] = 250; });
    return crop.getBufferAsync(Jimp.MIME_PNG);
  };

  it("sends the upscaler the changed region, not the picture, and lays its result in", async () => {
    const original = photo();
    const sent = await scaledDown(original, 1184, 888);
    const seen: Array<[number, number]> = [];

    const outcome = await compositeEditOntoOriginal(
      await original.getBufferAsync(Jimp.MIME_PNG), sent, await renderWithoutBlock(sent), { upscale: markingUpscaler(seen) },
    );

    expect(outcome.patchScaling).toBe("model");
    expect(seen).toHaveLength(1);
    // The block is 148x99 render pixels; with the grown outline and the margin, far less than 1184x888.
    expect(seen[0]![0]).toBeLessThan(300);
    expect(seen[0]![1]).toBeLessThan(250);
    const result = await Jimp.read(Buffer.from(outcome.composite!.imageBase64, "base64"));
    expect(pixel(result, BLOCK.x + BLOCK.w / 2, BLOCK.y + BLOCK.h / 2)[2]).toBeGreaterThan(200);
    for (const [x, y] of [[100, 100], [600, 1500], [2300, 1700]] as const) {
      expect(pixel(result, x, y)).toEqual(pixel(original, x, y));
    }
  });

  it("interpolates when the upscaler gives nothing back, or a picture of another shape", async () => {
    const original = photo();
    const originalPng = await original.getBufferAsync(Jimp.MIME_PNG);
    const sent = await scaledDown(original, 1184, 888);
    const edited = await renderWithoutBlock(sent);
    const square = await new Jimp(800, 800, 0x0000ffff).getBufferAsync(Jimp.MIME_PNG);

    const nothing = await compositeEditOntoOriginal(originalPng, sent, edited, { upscale: async () => undefined });
    const wrongShape = await compositeEditOntoOriginal(originalPng, sent, edited, { upscale: async () => square });
    const plain = await compositeEditOntoOriginal(originalPng, sent, edited);

    expect([nothing.patchScaling, wrongShape.patchScaling, plain.patchScaling]).toEqual(["interpolated", "interpolated", "interpolated"]);
    expect(nothing.composite!.imageBase64).toBe(plain.composite!.imageBase64);
    expect(wrongShape.composite!.imageBase64).toBe(plain.composite!.imageBase64);
  });
});

/**
 * A SMOOTH PATCH IN A GRAINY PHOTO GETS THE PHOTO'S GRAIN.
 *
 * Even sharp, a patch enlarged from a megapixel render has no sensor grain, and in a photo it reads
 * as pasted on. The grain the photo has around the patch and the patch lacks is added to it; a
 * picture with no grain gets none.
 */
describe("the patch's grain", () => {
  const FLAT: [number, number, number] = [110, 150, 95];
  /** A flat field, with a deterministic grain of `grain` levels (0: none), and the red block. */
  function grainyPhoto(grain: number): Jimp {
    const picture = new Jimp(WIDTH, HEIGHT, 0x000000ff);
    picture.scan(0, 0, WIDTH, HEIGHT, (x, y, at) => {
      const inBlock = x >= BLOCK.x && x < BLOCK.x + BLOCK.w && y >= BLOCK.y && y < BLOCK.y + BLOCK.h;
      const hash = Math.imul(x * 374761393 + y * 668265263, 1274126177) >>> 0;
      const speck = grain > 0 ? ((hash >>> 8) % (2 * grain + 1)) - grain : 0;
      for (let channel = 0; channel < 3; channel += 1) {
        picture.bitmap.data[at + channel] = inBlock ? [220, 30, 30][channel]! : FLAT[channel]! + speck;
      }
    });
    return picture;
  }

  /** The render: the base with the block painted over in the flat colour, smooth. */
  async function smoothRender(sent: Buffer): Promise<Buffer> {
    const picture = await Jimp.read(sent);
    const scale = picture.bitmap.width / WIDTH;
    picture.scan(0, 0, picture.bitmap.width, picture.bitmap.height, (x, y, at) => {
      const ox = x / scale;
      const oy = y / scale;
      if (ox < BLOCK.x - 6 || ox >= BLOCK.x + BLOCK.w + 6 || oy < BLOCK.y - 6 || oy >= BLOCK.y + BLOCK.h + 6) return;
      for (let channel = 0; channel < 3; channel += 1) picture.bitmap.data[at + channel] = FLAT[channel]!;
    });
    return picture.getBufferAsync(Jimp.MIME_PNG);
  }

  /** The median fine detail (green against its four neighbours) in a rectangle. */
  function fineDetail(picture: Jimp, x0: number, y0: number, width: number, height: number): number {
    const values: number[] = [];
    for (let y = y0; y < y0 + height; y += 1) {
      for (let x = x0; x < x0 + width; x += 1) {
        const around = (pixel(picture, x - 1, y)[1] + pixel(picture, x + 1, y)[1] + pixel(picture, x, y - 1)[1] + pixel(picture, x, y + 1)[1]) / 4;
        values.push(Math.abs(pixel(picture, x, y)[1] - around));
      }
    }
    values.sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)]!;
  }

  const inside = { x: BLOCK.x + 60, y: BLOCK.y + 50, w: BLOCK.w - 120, h: BLOCK.h - 100 };

  it("adds the grain the photo has around the patch", async () => {
    const original = grainyPhoto(6);
    const sent = await scaledDown(original, 1184, 888);

    const outcome = await compositeEditOntoOriginal(await original.getBufferAsync(Jimp.MIME_PNG), sent, await smoothRender(sent));

    const result = await Jimp.read(Buffer.from(outcome.composite!.imageBase64, "base64"));
    const photoGrain = fineDetail(original, 200, 1200, 200, 100);
    const patchGrain = fineDetail(result, inside.x, inside.y, inside.w, inside.h);
    expect(photoGrain).toBeGreaterThan(1);
    expect(patchGrain).toBeGreaterThan(photoGrain * 0.5);
    expect(patchGrain).toBeLessThan(photoGrain * 1.6);
  });

  it("adds none to a picture that has none — the control", async () => {
    const original = grainyPhoto(0);
    const sent = await scaledDown(original, 1184, 888);

    const outcome = await compositeEditOntoOriginal(await original.getBufferAsync(Jimp.MIME_PNG), sent, await smoothRender(sent));

    const result = await Jimp.read(Buffer.from(outcome.composite!.imageBase64, "base64"));
    expect(fineDetail(result, inside.x, inside.y, inside.w, inside.h)).toBe(0);
    expect(pixel(result, BLOCK.x + BLOCK.w / 2, BLOCK.y + BLOCK.h / 2)).toEqual(FLAT);
  });
});

describe("an edit of a picture larger than the engines draw", () => {
  const CONFIG: ImageGenerationBackendConfig = {
    api: "openai-compatible",
    baseUrl: "http://cluster:8080/v1",
    model: "image",
    qualityModel: "image-quality",
    timeoutMs: 120_000,
    qualityTimeoutMs: 300_000,
    defaultWidth: 1024,
    defaultHeight: 1024,
    defaultSteps: 20,
    defaultGuidanceScale: 7.5,
    qualityDefaults: { steps: 20, guidanceScale: 1 },
    initImageModels: ["image-quality"],
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("comes back at the original's size, with the change in it, and says how it was made", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const fields = await imageRequestFields(init?.body);
      const edited = await renderWithoutBlock(Buffer.from(String(fields["image"]), "base64"));
      return new Response(JSON.stringify({
        data: [{ b64_json: edited.toString("base64") }],
        usage: { mode: "img2img", strength: Math.fround(Number(fields["strength"])) },
      }), { headers: { "Content-Type": "application/json" } });
    }));
    const original = photo();

    const result = await requestImageGeneration(CONFIG, {
      prompt: "Remove the red block. Keep everything else as it is.", tier: "quality",
      initImage: (await original.getBufferAsync(Jimp.MIME_PNG)).toString("base64"), strength: 0.6,
    });

    expect([result.width, result.height]).toEqual([WIDTH, HEIGHT]);
    expect(result.editAtReducedSize).toMatchObject({ renderWidth: 1184, renderHeight: 896, composited: true });
    const picture = await Jimp.read(Buffer.from(result.imageBase64, "base64"));
    expect(pixel(picture, 100, 100)).toEqual(pixel(original, 100, 100));
    expect(pixel(picture, BLOCK.x + BLOCK.w / 2, BLOCK.y + BLOCK.h / 2)[0]).toBeLessThan(160);
  });
});
