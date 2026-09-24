import { describe, expect, it } from "vitest";
import { mergeMultimodalConfigUpdate } from "../gateway/multimodal-config-merge.js";

/**
 * PUT /api/multimodal/config stored the parsed body as the whole section. The Settings page sends
 * only the fields it shows, so one Save click erased the quality tier, image editing, the engine
 * names and the settings step, and the overlay writer made the loss permanent.
 */
describe("PUT /api/multimodal/config merges over the stored section", () => {
  // The raw section as the shards store it: no materialized defaults.
  const stored = {
    files: { baseUrl: "http://files.local", visionModel: "lmstudio/qwen", visionTimeoutMs: 90_000 },
    imageGeneration: {
      baseUrl: "http://img.local/v1",
      api: "openai-compatible",
      model: "image",
      qualityModel: "image-quality",
      tierLabels: { fast: "Segmind Vega", quality: "Qwen-Image 2.1" },
      qualityTimeoutMs: 300_000,
      fixedSizeModels: ["image"],
      initImageModels: ["image-quality"],
      qualityDefaults: { steps: 20, guidanceScale: 1 },
      settingsPrompt: { timeoutMs: 90_000 },
      defaultSteps: 20,
    },
  };

  // What the Settings page sends for image generation: the fields it shows.
  const pageBody = {
    imageGeneration: {
      baseUrl: "http://img.local/v1",
      api: "openai-compatible",
      timeoutMs: 120_000,
      model: "image",
      defaultWidth: 1024,
      defaultHeight: 1024,
      defaultSteps: 12,
      defaultGuidanceScale: 7.5,
    },
  };

  it("keeps every key the body did not send", () => {
    const result = mergeMultimodalConfigUpdate(stored, pageBody);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const image = result.value.imageGeneration!;
    expect(image.defaultSteps).toBe(12);                       // what the page changed
    expect(image.qualityModel).toBe("image-quality");          // what it did not
    expect(image.initImageModels).toEqual(["image-quality"]);
    expect(image.fixedSizeModels).toEqual(["image"]);
    expect(image.tierLabels).toEqual({ fast: "Segmind Vega", quality: "Qwen-Image 2.1" });
    expect(image.qualityTimeoutMs).toBe(300_000);
    expect(image.qualityDefaults).toEqual({ steps: 20, guidanceScale: 1 });
    expect(image.settingsPrompt.timeoutMs).toBe(90_000);
    expect(result.value.files.visionTimeoutMs).toBe(90_000);
    expect(result.value.files.visionModel).toBe("lmstudio/qwen");
  });

  it("persists the stored keys plus the sent ones, never the materialized defaults", () => {
    const result = mergeMultimodalConfigUpdate(stored, pageBody);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stored).toEqual({
      files: stored.files,
      imageGeneration: { ...stored.imageGeneration, ...pageBody.imageGeneration },
    });
    // No stt/tts/wakeWord sections the store never had.
    expect(Object.keys(result.stored).sort()).toEqual(["files", "imageGeneration"]);
  });

  it("merges a record key by key", () => {
    const result = mergeMultimodalConfigUpdate(stored, { imageGeneration: { tierLabels: { fast: "Vega 2" } } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.imageGeneration?.tierLabels).toEqual({ fast: "Vega 2", quality: "Qwen-Image 2.1" });
  });

  it("removes a key the body sends as null — the only way to clear one", () => {
    const cleared = mergeMultimodalConfigUpdate(stored, { files: { visionModel: null }, imageGeneration: { qualityModel: null } });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.value.files.visionModel).toBeUndefined();
    expect(cleared.value.imageGeneration?.qualityModel).toBeUndefined();
    expect(cleared.stored["files"]).toEqual({ baseUrl: "http://files.local", visionTimeoutMs: 90_000 });

    const off = mergeMultimodalConfigUpdate(stored, { imageGeneration: null });
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(off.value.imageGeneration).toBeUndefined();
    expect("imageGeneration" in off.stored).toBe(false);
  });

  it("does not store keys the schema does not know", () => {
    const result = mergeMultimodalConfigUpdate(stored, { imageGeneration: { defaultSteps: 8, madeUp: true }, alsoMadeUp: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stored).not.toHaveProperty("alsoMadeUp");
    expect(result.stored["imageGeneration"]).not.toHaveProperty("madeUp");
    expect((result.stored["imageGeneration"] as Record<string, unknown>)["defaultSteps"]).toBe(8);
  });

  it("rejects a body that fails validation, and a body that is not an object", () => {
    expect(mergeMultimodalConfigUpdate(stored, { imageGeneration: { defaultSteps: 0 } }).ok).toBe(false);
    expect(mergeMultimodalConfigUpdate(stored, { files: { baseUrl: "not a url" } }).ok).toBe(false);
    expect(mergeMultimodalConfigUpdate(stored, [1, 2]).ok).toBe(false);
  });

  it("is a full, well-formed section even over an empty store", () => {
    const result = mergeMultimodalConfigUpdate(undefined, { maxUploadBytes: 4_194_304 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.maxUploadBytes).toBe(4_194_304);
    expect(result.value.files.toolName).toBe("file_to_markdown");
    expect(result.stored).toEqual({ maxUploadBytes: 4_194_304 });
  });
});
