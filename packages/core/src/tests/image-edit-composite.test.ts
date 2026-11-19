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
