/**
 * Editing an image must either happen or be refused — never be faked.
 *
 * A user asked three times to continue from an earlier render: "make it real", "use the first
 * image as a base", "the palms are missing — how is that a continuation?". Each round
 * produced an unrelated beach, because `generate_image` had no notion of a base image and
 * every request was a fresh text-to-image render. The palms went missing between round one
 * and round two and never came back.
 *
 * At the time the backend made that invisible: it returned HTTP 200 for a reference image
 * sent under six different field names and ignored every one. It has since been rebuilt —
 * editing is POST /v1/images/edits, `image` is the only accepted spelling, unknown parameters
 * are rejected by name rather than ignored, and sending a reference to /images/generations
 * now answers 400 "does not accept 'image'". So both ends are loud today.
 *
 * The guards stay anyway, and these tests are mostly about them. An allowlist keeps us off a
 * backend that cannot edit, and `usage.mode` is checked on the way out, because the failure
 * being prevented — a fresh render returned as a revision — is indistinguishable from success
 * by looking at the picture. The one comparison that needs care is `strength`: the engine
 * reports what it APPLIED, a float32 round-trip of what was asked, so 0.35 comes back as
 * 0.3499999940395355 and equality would fail almost every edit.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  requestImageGeneration,
  type ImageGenerationBackendConfig,
} from "../multimodal/image-generation.js";

const BASE: ImageGenerationBackendConfig = {
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
};

/** The backend as it is today: editing nowhere in the allowlist. */
const NO_EDITS: ImageGenerationBackendConfig = { ...BASE, initImageModels: [] };
/** The backend once a route exists and the model is enabled. */
const EDITS: ImageGenerationBackendConfig = { ...BASE, initImageModels: ["image-quality"] };

const REF = Buffer.from("pretend-png-bytes").toString("base64");

/**
 * `usage` mirrors the real endpoint: the applied strength is a float32 round-trip of the
 * requested one, which is why the client compares with a tolerance rather than for equality.
 */
function stub(usage?: Record<string, unknown> | null) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url, body });
    if (url.includes("/sdapi/")) {
      return new Response(JSON.stringify({ images: ["QUJD"], info: JSON.stringify({ seed: 7 }) }),
        { headers: { "Content-Type": "application/json" } });
    }
    const asked = typeof body["strength"] === "number" ? body["strength"] : undefined;
    const reported = usage === null ? undefined : (usage ?? (url.includes("/edits")
      ? { mode: "img2img", strength: Math.fround(asked ?? 0), strength_requested: asked }
      : undefined));
    return new Response(JSON.stringify({ data: [{ b64_json: "QUJD" }], ...(reported ? { usage: reported } : {}) }),
      { headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

describe("editing an existing image", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("REFUSES when the backend is not known to honour a base image, without calling it", async () => {
    const net = stub();

    await expect(requestImageGeneration(NO_EDITS, {
      prompt: "make it photorealistic", tier: "quality", initImage: REF,
    })).rejects.toThrow(/cannot edit an existing image/);

    // Not a wasted render: the refusal is local.
    expect(net.fetchMock).not.toHaveBeenCalled();
  });

  it("tells the caller what to do instead, in words an agent can act on", async () => {
    stub();
    const error = await requestImageGeneration(NO_EDITS, {
      prompt: "add the palms", tier: "quality", initImage: REF,
    }).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));

    expect(error).toMatch(/initImageModels/);
    // The sentence that stops the lie the user actually received.
    expect(error).toMatch(/do NOT present a fresh generation as an edit/i);
  });

  it("sends the base image once the model is allowlisted", async () => {
    const net = stub();

    await requestImageGeneration(EDITS, {
      prompt: "make it photorealistic", tier: "quality", initImage: REF, strength: 0.3,
    });

    const body = net.calls[0]!.body;
    // ONE spelling. The endpoint rejects unknown parameters by name rather than ignoring
    // them, so the old belt-and-braces aliases would now be a 400.
    expect(body["image"]).toBe(REF);
    expect(body["strength"]).toBe(0.3);
    expect(body["init_image"]).toBeUndefined();
    expect(body["init_images"]).toBeUndefined();
    expect(body["denoising_strength"]).toBeUndefined();
    // And it goes to the EDITS route: /images/generations answers 400 for `image`.
    expect(net.calls[0]!.url).toBe("http://cluster:8080/v1/images/edits");
  });

  it("uses the GENERATIONS route when there is no base image — the control", async () => {
    const net = stub();
    await requestImageGeneration(EDITS, { prompt: "a lighthouse", tier: "quality" });
    expect(net.calls[0]!.url).toBe("http://cluster:8080/v1/images/generations");
  });

  it("refuses the result when the backend reports it did NOT edit", async () => {
    // The silent-failure guard, now reading what the engine says it did. A txt2img mode on
    // an edit request means a fresh render came back wearing an edit's name.
    stub({ mode: "txt2img" });

    await expect(requestImageGeneration(EDITS, {
      prompt: "add the palms", tier: "quality", initImage: REF, strength: 0.35,
    })).rejects.toThrow(/did not apply the base image/);
  });

  it("accepts a float32 round-trip of the requested strength", async () => {
    // 0.35 comes back as 0.3499999940395355. Comparing for equality would fail every edit
    // whose strength is not exactly representable, which is most of them.
    stub({ mode: "img2img", strength: 0.3499999940395355, strength_requested: 0.35 });

    const result = await requestImageGeneration(EDITS, {
      prompt: "add the palms", tier: "quality", initImage: REF, strength: 0.35,
    });
    expect(result.imageBase64).toBe("QUJD");
  });

  it("refuses when the applied strength is nowhere near what was asked", async () => {
    // The control for the tolerance: it must not be so loose that an ignored value passes.
    stub({ mode: "img2img", strength: 0.75, strength_requested: 0.35 });

    await expect(requestImageGeneration(EDITS, {
      prompt: "add the palms", tier: "quality", initImage: REF, strength: 0.35,
    })).rejects.toThrow(/strength 0.75 against 0.35 requested/);
  });

  it("routes an edit to the tier that CAN edit when no tier was stated", async () => {
    // The defect session 3a438b35 hit. `generate_image` resolved an absent tier to "fast",
    // whose model is `image`, and only `image-quality` is in initImageModels — so the agent
    // passed baseImage, was refused, and silently generated a fresh picture. The capability
    // was configured, tested and unreachable by the request that wants it.
    const net = stub();

    await requestImageGeneration(EDITS, { prompt: "make it photorealistic", initImage: REF, strength: 0.3 });

    expect(net.calls[0]!.url).toBe("http://cluster:8080/v1/images/edits");
    expect(net.calls[0]!.body["model"]).toBe("image-quality");
    // And it gets the quality tier's guidance, not the fast tier's.
    expect(net.calls[0]!.body["guidance_scale"]).toBe(1);
  });

  it("does NOT upgrade the tier for an ordinary generation — the control", async () => {
    // Without this, the rule could be "always use quality", which would spend the worker's
    // GPU on every picture and serialise the cluster for requests that never needed it.
    const net = stub();

    await requestImageGeneration(EDITS, { prompt: "a lighthouse" });

    expect(net.calls[0]!.body["model"]).toBe("image");
    expect(net.calls[0]!.body["guidance_scale"]).toBe(7.5);
  });

  it("respects an EXPLICIT fast tier, refusing rather than quietly upgrading", async () => {
    // Quality costs everyone else latency. A caller who said "fast" and asked for an edit
    // has stated a contradiction, and should hear about it rather than be billed for the
    // resolution.
    const net = stub();

    await expect(requestImageGeneration(EDITS, {
      prompt: "make it photorealistic", initImage: REF, tier: "fast",
    })).rejects.toThrow(/cannot edit an existing image/);
    expect(net.fetchMock).not.toHaveBeenCalled();
  });

  it("sends NO reference fields when there is no base image — the control", async () => {
    // Without this, always attaching the fields would pass the case above while changing
    // every ordinary generation into something the backend has to ignore.
    const net = stub();

    await requestImageGeneration(EDITS, { prompt: "a lighthouse", tier: "quality" });

    const body = net.calls[0]!.body;
    expect(body["image"]).toBeUndefined();
    expect(body["init_images"]).toBeUndefined();
    expect(body["strength"]).toBeUndefined();
  });

  it("uses the img2img ENDPOINT on an AUTOMATIC1111 backend, not a flag on txt2img", async () => {
    const net = stub();
    const a1111: ImageGenerationBackendConfig = {
      ...EDITS, api: "automatic1111-compatible", baseUrl: "http://worker:8080", model: "qwen_image_2.1-Q8_0",
      initImageModels: ["qwen_image_2.1-Q8_0"],
    };

    await requestImageGeneration(a1111, { prompt: "add the palms", initImage: REF, strength: 0.35 });

    expect(net.calls[0]!.url).toBe("http://worker:8080/sdapi/v1/img2img");
    expect(net.calls[0]!.body["init_images"]).toEqual([REF]);
    expect(net.calls[0]!.body["denoising_strength"]).toBe(0.35);
  });

  it("still uses txt2img on that backend when there is no base image", async () => {
    const net = stub();
    const a1111: ImageGenerationBackendConfig = {
      ...EDITS, api: "automatic1111-compatible", baseUrl: "http://worker:8080", model: "qwen_image_2.1-Q8_0",
    };

    await requestImageGeneration(a1111, { prompt: "a lighthouse" });

    expect(net.calls[0]!.url).toBe("http://worker:8080/sdapi/v1/txt2img");
  });
});
