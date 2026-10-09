/**
 * The quality tier can live on a different backend, and must actually be sent there.
 *
 * Both tiers on this cluster answer on one OpenAI-compatible endpoint, but that route parses
 * `prompt` and `size` and throws the rest away — eight probes varying steps, seed, cfg and
 * negative prompt all came back with an identical record (steps=8 seed=42 txt_cfg=6). Its
 * `--seed -1` randomises once per SERVER PROCESS too, so one prompt returned one image until
 * a restart, and "make me another one" could not work at any layer above it.
 *
 * The same sd-server speaks AUTOMATIC1111 on another path, and that one honours everything.
 * Verified live: `seed: -1` produced 1152108546 then 1467603400 with different images, an
 * explicit seed 7 reproduced byte-for-byte twice, and steps/cfg_scale came back echoed in
 * `info`.
 *
 * So the tier is resolved to a backend BEFORE the protocol is chosen. Get that order wrong
 * and the quality tier is dispatched by the fast tier's `api`, silently landing back on the
 * route that discards its parameters — which looks like the feature working.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  requestImageGeneration,
  type ImageGenerationBackendConfig,
} from "../multimodal/image-generation.js";

const CLUSTER: ImageGenerationBackendConfig = {
  api: "openai-compatible",
  baseUrl: "http://head:8080/v1",
  model: "image",
  qualityModel: "image-quality",
  timeoutMs: 120_000,
  qualityTimeoutMs: 210_000,
  fixedSizeModels: ["image"],
  qualityBackend: {
    api: "automatic1111-compatible",
    baseUrl: "http://worker:8080/upstream/qwen-image",
    model: "qwen_image_2.1-Q8_0",
    timeoutMs: 300_000,
  },
};

const REQUEST = { prompt: "a lighthouse", width: 1024, height: 1024, steps: 20, guidanceScale: 1 };

/** Answers both protocols, so a misrouted request still resolves and the URL is the evidence. */
function stubBothBackends() {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const payload = url.includes("/sdapi/v1/txt2img")
      ? { images: ["QUJD"], info: JSON.stringify({ seed: 1152108546, steps: 20, cfg_scale: 1, width: 1024, height: 1024 }) }
      : { data: [{ b64_json: "QUJD" }] };
    return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

describe("per-tier image backend", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("sends the QUALITY tier to the override backend, with its parameters", async () => {
    const net = stubBothBackends();

    const result = await requestImageGeneration(CLUSTER, { ...REQUEST, tier: "quality", seed: 7 });

    expect(net.calls).toHaveLength(1);
    expect(net.calls[0]!.url).toBe("http://worker:8080/upstream/qwen-image/sdapi/v1/txt2img");

    // The whole reason this route exists: these fields reach the model.
    const body = net.calls[0]!.body;
    expect(body["steps"]).toBe(20);
    expect(body["cfg_scale"]).toBe(1);
    expect(body["seed"]).toBe(7);
    expect(body["width"]).toBe(1024);
    // And the checkpoint name, not the router alias the head node uses.
    expect(body["override_settings"]).toEqual({ sd_model_checkpoint: "qwen_image_2.1-Q8_0" });

    // The seed actually used comes back, so a caller can reproduce or vary deliberately.
    expect(result.seed).toBe(1152108546);
    // And so does the tier. Only the OpenAI adapter used to report it, so a render routed here
    // came back unlabelled and nobody downstream could say which engine had made it.
    expect(result.tier).toBe("quality");
  });

  it("leaves the FAST tier on the original backend — the control", async () => {
    // Without this, redirecting every tier would satisfy the case above while moving the
    // NPU tier off the endpoint it is built around.
    const net = stubBothBackends();

    await requestImageGeneration(CLUSTER, { ...REQUEST, tier: "fast" });

    expect(net.calls).toHaveLength(1);
    expect(net.calls[0]!.url).toBe("http://head:8080/v1/images/generations");
    expect(net.calls[0]!.body["model"]).toBe("image");
  });

  it("defaults seed to -1 so an unspecified request VARIES", async () => {
    // The defect this whole route was chosen to fix. -1 is what makes the backend draw a
    // fresh seed per request; omitting the field or pinning it reintroduces "same prompt,
    // same picture forever".
    const net = stubBothBackends();

    await requestImageGeneration(CLUSTER, { ...REQUEST, tier: "quality" });

    expect(net.calls[0]!.body["seed"]).toBe(-1);
  });

  it("does not redirect anything when no override is configured", async () => {
    // A deployment with one backend must behave exactly as before.
    const { qualityBackend, ...single } = CLUSTER;
    void qualityBackend;
    const net = stubBothBackends();

    await requestImageGeneration(single, { ...REQUEST, tier: "quality" });

    expect(net.calls[0]!.url).toBe("http://head:8080/v1/images/generations");
    expect(net.calls[0]!.body["model"]).toBe("image-quality");
  });

  it("does not impose the fast tier's fixed size on the redirected tier", async () => {
    // `fixedSizeModels` names the NPU model, which the quality tier is no longer using.
    const net = stubBothBackends();

    await requestImageGeneration(CLUSTER, { ...REQUEST, width: 1024, height: 768, tier: "quality" });

    expect(net.calls[0]!.body["height"]).toBe(768);
  });
});
