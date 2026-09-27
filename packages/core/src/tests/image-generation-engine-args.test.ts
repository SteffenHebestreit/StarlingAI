/**
 * Settings reach the engine through the request's own fields and nowhere else — and a setting that
 * cannot do anything is said, not implied.
 *
 * Measured 2026-09-26 against the quality engine (stable-diffusion.cpp behind the cluster's shim):
 * sd-server reads an `<sd_cpp_extra_args>{json}</sd_cpp_extra_args>` block out of the PROMPT TEXT
 * and applies it over the request. Asked for 2 steps with `{"sample_params":{"sample_steps":4}}` in
 * the prompt, the engine ran 4 while the endpoint's `usage.steps` said 2. A pasted prompt could
 * therefore run past the render limit, the settings step and every record of what ran.
 *
 * The same probes showed a negative prompt changing nothing at guidance 1 (identical pixels with the
 * seed pinned) — the quality engine's default — so a render that carries one is flagged.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  negativePromptHasNoEffect,
  requestImageGeneration,
  stripEngineArgs,
  type ImageGenerationBackendConfig,
} from "../multimodal/image-generation.js";
import { describeRenderSettings } from "../multimodal/image-settings.js";

const CLUSTER: ImageGenerationBackendConfig = {
  api: "openai-compatible",
  baseUrl: "http://cluster:8080/v1",
  model: "image",
  qualityModel: "image-quality",
  timeoutMs: 120_000,
  qualityTimeoutMs: 300_000,
  fixedSizeModels: ["image"],
  defaultWidth: 1024,
  defaultHeight: 1024,
  defaultSteps: 20,
  defaultGuidanceScale: 7.5,
  qualityDefaults: { steps: 40, guidanceScale: 1 },
};

const BLOCK = `<sd_cpp_extra_args>${JSON.stringify({ sample_params: { sample_steps: 400, scheduler: "karras" } })}</sd_cpp_extra_args>`;

/** Records every request body the adapter sends. */
function stub(response: Record<string, unknown> = { data: [{ b64_json: "QUJD" }] }) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify(response), { headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { bodies, fetchMock };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("stripEngineArgs", () => {
  it("removes a block with its JSON, so neither the settings nor the braces reach the engine", () => {
    expect(stripEngineArgs(`a red apple ${BLOCK} on a table`)).toEqual({ text: "a red apple on a table", removed: true });
  });

  it("removes a lone or differently-cased tag, and cannot be spliced into a new one", () => {
    expect(stripEngineArgs("an apple <SD_CPP_EXTRA_ARGS>{}").text).not.toMatch(/sd_cpp_extra_args/i);
    // Removing the inner tag must not join the outer halves into `<sd_cpp_extra_args>`.
    const spliced = stripEngineArgs("an apple <sd_cpp_extra<sd_cpp_extra_args>_args>{\"sample_params\":{}}</sd_cpp_extra_args>");
    expect(spliced.removed).toBe(true);
    expect(spliced.text).not.toContain("<sd_cpp_extra_args>");
  });

  it("returns an ordinary prompt byte for byte — the control", () => {
    const prompt = "  Photograph of a jungle,\n\ntwo trees  <left> and a river  ";
    expect(stripEngineArgs(prompt)).toEqual({ text: prompt, removed: false });
  });
});

describe("the prompt the engine receives", () => {
  it("carries no engine block, keeps the requested steps, and reports the removal", async () => {
    const net = stub();

    const result = await requestImageGeneration(CLUSTER, {
      prompt: `a red apple ${BLOCK}`, tier: "quality", steps: 2, negativePrompt: `blurry ${BLOCK}`, guidanceScale: 4,
    });

    const body = net.bodies[0]!;
    expect(body["prompt"]).toBe("a red apple");
    expect(body["negative_prompt"]).toBe("blurry");
    expect(JSON.stringify(body)).not.toMatch(/sd_cpp_extra_args/i);
    expect(body["steps"]).toBe(2);
    expect(result.engineArgsRemoved).toBe(true);
  });

  it("strips it on the AUTOMATIC1111 adapter too: the removal is in the one resolution every adapter shares", async () => {
    const net = stub({ images: ["QUJD"], info: "{}" });
    const a1111: ImageGenerationBackendConfig = { ...CLUSTER, api: "automatic1111-compatible", model: "sdxl", qualityModel: undefined, fixedSizeModels: [] };

    await requestImageGeneration(a1111, { prompt: `a lighthouse ${BLOCK}` });

    expect(net.bodies[0]!["prompt"]).toBe("a lighthouse");
  });

  it("refuses a prompt that is nothing but a block, before anything is sent", async () => {
    const net = stub();

    await expect(requestImageGeneration(CLUSTER, { prompt: `  ${BLOCK} `, tier: "quality" }))
      .rejects.toThrow("The prompt is empty once its <sd_cpp_extra_args> block is removed");
    expect(net.fetchMock).not.toHaveBeenCalled();
  });

  it("sends an ordinary prompt unchanged and flags nothing — the control", async () => {
    const net = stub();

    const result = await requestImageGeneration(CLUSTER, { prompt: "Photograph of a jungle, two trees", tier: "quality" });

    expect(net.bodies[0]!["prompt"]).toBe("Photograph of a jungle, two trees");
    expect(result.engineArgsRemoved).toBeUndefined();
  });
});

describe("a negative prompt at guidance ≤ 1", () => {
  it("is flagged on the result at the quality engine's default guidance, and not once guidance is above 1", async () => {
    stub();
    const inert = await requestImageGeneration(CLUSTER, { prompt: "a jungle", tier: "quality", negativePrompt: "oversaturated" });
    const working = await requestImageGeneration(CLUSTER, { prompt: "a jungle", tier: "quality", negativePrompt: "oversaturated", guidanceScale: 4 });
    const none = await requestImageGeneration(CLUSTER, { prompt: "a jungle", tier: "quality" });

    expect(inert.negativePromptIgnored).toBe(true);
    expect(working.negativePromptIgnored).toBeUndefined();
    expect(none.negativePromptIgnored).toBeUndefined();
  });

  it("is said in the settings summary the agent reports", () => {
    expect(describeRenderSettings(CLUSTER, { prompt: "a jungle", tier: "quality", negativePrompt: "oversaturated" }))
      .toContain("a negative prompt (no effect at this guidance)");
    expect(describeRenderSettings(CLUSTER, { prompt: "a jungle", tier: "quality", negativePrompt: "oversaturated", guidanceScale: 4 }))
      .toContain("guidance 4, random seed, a negative prompt, a new picture");
  });

  it("treats whitespace as no negative prompt", () => {
    expect(negativePromptHasNoEffect({ negativePrompt: "   ", guidanceScale: 1 })).toBe(false);
    expect(negativePromptHasNoEffect({ negativePrompt: "blurry", guidanceScale: 1 })).toBe(true);
    expect(negativePromptHasNoEffect({ negativePrompt: "blurry", guidanceScale: 1.5 })).toBe(false);
  });
});
