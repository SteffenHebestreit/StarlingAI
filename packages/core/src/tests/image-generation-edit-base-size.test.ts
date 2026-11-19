/**
 * AN EDIT OF A PHONE PHOTO KEEPS THE PHOTO'S SHAPE, AND THE ENGINE GETS A PICTURE ITS SIZE.
 *
 * A base outside the size bounds (256-2048 a side) used to render at the 1024x1024 default, so a
 * 4:3 photo came back squashed into a square, and the whole photo went across as it was: 16.7 MB
 * of JPEG for a one-megapixel render (session bf079002, "remove the cars in the background"). It
 * now renders at the default's area in its own shape, and the base is scaled to that before it is
 * sent. A base the engines take as it is goes across untouched.
 */
import Jimp from "jimp";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  editSizeForBase,
  requestImageGeneration,
  type ImageGenerationBackendConfig,
} from "../multimodal/image-generation.js";
import { imageRequestFields } from "./helpers/image-request-fields.js";

const EDITS: ImageGenerationBackendConfig = {
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

async function pictureBase64(width: number, height: number, mime: string = Jimp.MIME_JPEG): Promise<string> {
  const picture = new Jimp(width, height, 0x3060c0ff);
  return (await picture.getBufferAsync(mime)).toString("base64");
}

function stub() {
  const sent: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const fields = await imageRequestFields(init?.body);
    sent.push(fields);
    return new Response(JSON.stringify({
      data: [{ b64_json: "QUJD" }],
      usage: { mode: "img2img", strength: Math.fround(Number(fields["strength"])) },
    }), { headers: { "Content-Type": "application/json" } });
  }));
  return sent;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the size an edit renders at", () => {
  it("keeps a base the engines take at its own size", () => {
    expect(editSizeForBase({ width: 1024, height: 768 }, 1024 * 1024)).toEqual({ width: 1024, height: 768 });
  });

  it("renders a phone photo at the default's area in the photo's own shape, on the size grid", () => {
    expect(editSizeForBase({ width: 4000, height: 3000 }, 1024 * 1024)).toEqual({ width: 1184, height: 896 });
    expect(editSizeForBase({ width: 3000, height: 4000 }, 1024 * 1024)).toEqual({ width: 896, height: 1184 });
  });
});

describe("the base picture an edit sends", () => {
  it("scales a base too large for the engines down to the render, in its shape, as a PNG", async () => {
    const sent = stub();
    const base = await pictureBase64(2400, 1800);

    await requestImageGeneration(EDITS, { prompt: "remove the cars", tier: "quality", initImage: base, strength: 0.6 });

    expect(sent[0]!["size"]).toBe("1184x896");
    const image = Buffer.from(String(sent[0]!["image"]), "base64");
    const decoded = await Jimp.read(image);
    expect([decoded.getWidth(), decoded.getHeight()]).toEqual([1184, 896]);
    expect(decoded.getMIME()).toBe(Jimp.MIME_PNG);
  });

  it("sends a base the engines take exactly as it was — the control", async () => {
    const sent = stub();
    const base = await pictureBase64(1024, 768, Jimp.MIME_PNG);

    await requestImageGeneration(EDITS, { prompt: "warmer light", tier: "quality", initImage: base, strength: 0.6 });

    expect(sent[0]!["size"]).toBe("1024x768");
    expect(sent[0]!["image"]).toBe(base);
  });
});
