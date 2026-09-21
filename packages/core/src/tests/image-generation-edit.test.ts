/**
 * Editing an image must either happen or be refused — never be faked.
 *
 * A user asked three times to continue from an earlier render: "make it real", "use the first
 * image as a base", "the palms are missing — how is that a continuation?". Each round
 * produced an unrelated beach, because `generate_image` had no notion of a base image and
 * every request was a fresh text-to-image render. The palms went missing between round one
 * and round two and never came back.
 *
 * The backend makes that failure invisible: measured, it returns HTTP 200 for a reference
 * image sent as `image`, `init_image`, `init_images`, `reference_image`, `ref_images` or
 * `image_b64`, and ignores all six — the generation record still reads mode=img_gen,
 * strength=0.75 (its default, not the value sent), refImages=0. So an attempt looks exactly
 * like a success.
 *
 * Hence an allowlist rather than an attempt, and a check on the way out. An agent told
 * plainly that editing is unavailable can say so; one handed a plausible wrong answer
 * cannot.
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

function stub() {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const payload = String(input).includes("/sdapi/")
      ? { images: ["QUJD"], info: JSON.stringify({ seed: 7 }) }
      : { data: [{ b64_json: "QUJD" }] };
    return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
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
    // Several field names on purpose: OpenAI-shaped endpoints have no standard one.
    expect(body["image"]).toBe(REF);
    expect(body["init_image"]).toBe(REF);
    expect(body["init_images"]).toEqual([REF]);
    expect(body["strength"]).toBe(0.3);
    expect(body["denoising_strength"]).toBe(0.3);
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
