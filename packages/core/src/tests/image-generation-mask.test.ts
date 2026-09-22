/**
 * A mask that is ignored, or applied backwards, returns HTTP 200 and a picture that looks fine.
 *
 * Two conventions collide here. The OpenAI surface is ALPHA-based — transparent marks what may
 * change — while stable-diffusion.cpp underneath is LUMINANCE-based. An unconverted mask edits
 * precisely the region the caller meant to protect, and nothing about the response says so:
 * same status, same shape, a plausible image. The operator hit exactly this, along with a
 * silent no-op from the near-miss field name `mask_image` whose output was byte-identical to
 * an unmasked edit.
 *
 * So the client checks the endpoint's own measurements rather than trusting the call. Note the
 * asymmetry with `usage.mode`, which is NOT evidence of anything — it reports which route was
 * posted to, and comes back "img2img" for every request to /images/edits. `usage.mask` is
 * different: `edited_delta` and `protected_delta` are measured from the pixels.
 *
 * The standing limit, which no test here can change: Qwen-Image 2.1 has no inpainting mask
 * channels, so the model never sees the mask and the endpoint composites the result.
 * Feathering hides the join; it cannot make content continuous across it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  requestImageGeneration,
  type ImageGenerationBackendConfig,
} from "../multimodal/image-generation.js";

const EDITS: ImageGenerationBackendConfig = {
  api: "openai-compatible",
  baseUrl: "http://cluster:8080/v1",
  model: "image",
  qualityModel: "image-quality",
  timeoutMs: 120_000,
  qualityTimeoutMs: 300_000,
  defaultWidth: 1024,
  defaultHeight: 1024,
  qualityDefaults: { steps: 20, guidanceScale: 1 },
  initImageModels: ["image-quality"],
};

const REF = Buffer.from("pretend-png-bytes").toString("base64");
const MASK = Buffer.from("pretend-mask-bytes").toString("base64");

/** A healthy mask report: the edited region moved, the protected one barely did. */
const RESPECTED = {
  mode: "img2img",
  strength: Math.fround(0.6),
  mask: {
    semantics: "alpha", coverage: 0.5, respected: true, feather_px: 24,
    edited_delta: 4.41, protected_delta: 0.74,
  },
};

interface SeenCall { url: string; form?: FormData; json?: Record<string, unknown> }

function stub(usage: Record<string, unknown> | undefined = RESPECTED) {
  const calls: SeenCall[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body;
    calls.push(body instanceof FormData
      ? { url, form: body }
      : { url, json: JSON.parse(String(body)) as Record<string, unknown> });
    return new Response(
      JSON.stringify({ data: [{ b64_json: "QUJD" }], ...(usage ? { usage } : {}) }),
      { headers: { "Content-Type": "application/json" } },
    );
  }));
  return calls;
}

const maskedEdit = (overrides: Record<string, unknown> = {}) => requestImageGeneration(EDITS, {
  prompt: "boulders on the sand",
  tier: "quality",
  initImage: REF,
  mask: MASK,
  strength: 0.6,
  ...overrides,
});

describe("masked edits", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("sends a masked edit as MULTIPART, with image and mask as file parts", async () => {
    // `mask` is a file part on this endpoint, so a masked edit cannot go as JSON. This is the
    // one case that forced a multipart path — an earlier measurement had found JSON and
    // multipart equivalent, but that only ever covered `image`.
    const calls = stub();

    await maskedEdit();

    const call = calls[0]!;
    expect(call.url).toContain("/images/edits");
    expect(call.form, "a masked edit must not be sent as JSON").toBeInstanceOf(FormData);
    expect(call.form!.get("image")).toBeInstanceOf(Blob);
    expect(call.form!.get("mask")).toBeInstanceOf(Blob);
    // Scalars still ride along, as their string forms — all multipart can carry.
    expect(call.form!.get("model")).toBe("image-quality");
    expect(call.form!.get("strength")).toBe("0.6");
  });

  it("carries mask_blur when asked, because the engine binarizes and the seam is the tell", async () => {
    const calls = stub();

    await maskedEdit({ maskBlur: 24 });

    expect(calls[0]!.form!.get("mask_blur")).toBe("24");
  });

  it("still sends an UNMASKED edit as JSON — the control that keeps the working path working", async () => {
    // Without this, "always multipart" would satisfy the cases above while churning the shape
    // that is already in production and measured fine.
    const calls = stub({ mode: "img2img", strength: Math.fround(0.6) });

    await requestImageGeneration(EDITS, {
      prompt: "warmer light", tier: "quality", initImage: REF, strength: 0.6,
    });

    expect(calls[0]!.form).toBeUndefined();
    expect(calls[0]!.json!["image"]).toBe(REF);
    expect(calls[0]!.json!["mask"]).toBeUndefined();
  });

  it("REFUSES a mask with no base image to mask", async () => {
    stub();

    await expect(requestImageGeneration(EDITS, {
      prompt: "boulders", tier: "quality", mask: MASK,
    })).rejects.toThrow(/needs a base image/i);
  });

  it("refuses a result the backend says it did not mask", async () => {
    stub({ mode: "img2img", strength: Math.fround(0.6), mask: { respected: false } });

    await expect(maskedEdit()).rejects.toThrow(/did not apply the mask/i);
  });

  it("refuses a result with no mask report at all", async () => {
    // Silence is not consent: an endpoint that masked nothing and an endpoint that forgot to
    // say are indistinguishable from here, and one of them hands back a whole-image edit.
    stub({ mode: "img2img", strength: Math.fround(0.6) });

    await expect(maskedEdit()).rejects.toThrow(/reported nothing about it/i);
  });

  it("catches an INVERTED mask, which is the failure no one can see", async () => {
    // The alpha/luminance collision. The picture is fine; the wrong half of it changed.
    stub({
      mode: "img2img",
      strength: Math.fround(0.6),
      mask: { semantics: "alpha", respected: true, edited_delta: 0.74, protected_delta: 4.41 },
    });

    await expect(maskedEdit()).rejects.toThrow(/INVERTED/);
  });

  it("accepts a healthy masked edit — the control that keeps the guards from refusing everything", async () => {
    stub();

    const result = await maskedEdit();

    expect(result.imageBase64).toBe("QUJD");
    expect(result.tier).toBe("quality");
  });

  it("leaves an UNMASKED edit unaffected by the mask guards", async () => {
    // The mask checks must not fire for callers who never sent one — otherwise every ordinary
    // edit starts demanding a mask report the endpoint has no reason to produce.
    stub({ mode: "img2img", strength: Math.fround(0.6) });

    const result = await requestImageGeneration(EDITS, {
      prompt: "warmer light", tier: "quality", initImage: REF, strength: 0.6,
    });

    expect(result.imageBase64).toBe("QUJD");
  });
});
