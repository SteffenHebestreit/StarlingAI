import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkImageGenerationHealth,
  requestImageGeneration,
  type ImageGenerationBackendConfig,
} from "../multimodal/image-generation.js";

function responseJson(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function responseBytes(bytes: Uint8Array, init: ResponseInit = {}): Response {
  return new Response(bytes as unknown as BodyInit, init);
}

describe("image generation adapters", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reports disabled health when no endpoint is configured", async () => {
    const result = await checkImageGenerationHealth({
      api: "automatic1111-compatible",
      baseUrl: "",
      timeoutMs: 5000,
    });

    expect(result).toMatchObject({
      ok: false,
      disabled: true,
    });
  });

  it("checks AUTOMATIC1111 health via the sd-models endpoint", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("http://image-host/sdapi/v1/sd-models");
      return responseJson([{ title: "model-a" }], { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await checkImageGenerationHealth({
      api: "automatic1111-compatible",
      baseUrl: "http://image-host",
      timeoutMs: 5000,
    });

    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends AUTOMATIC1111 txt2img requests with model override support", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("http://auto1111/sdapi/v1/txt2img");
      expect(init?.method).toBe("POST");

      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(payload).toMatchObject({
        prompt: "draw a starling",
        negative_prompt: "blurry",
        width: 1024,
        height: 768,
        steps: 30,
        cfg_scale: 6.5,
        seed: 42,
      });
      expect(payload["override_settings"]).toMatchObject({
        sd_model_checkpoint: "flux-dev.safetensors",
      });

      return responseJson({
        images: ["data:image/png;base64,cG5nLWRhdGE="],
        info: JSON.stringify({
          seed: 42,
          sd_model_name: "flux-dev.safetensors",
          elapsed: 1.5,
        }),
        parameters: {
          width: 1024,
          height: 768,
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await requestImageGeneration({
      api: "automatic1111-compatible",
      baseUrl: "http://auto1111",
      timeoutMs: 10_000,
      model: "base-model.safetensors",
    }, {
      prompt: "draw a starling",
      model: "flux-dev.safetensors",
      negativePrompt: "blurry",
      width: 1024,
      height: 768,
      steps: 30,
      guidanceScale: 6.5,
      seed: 42,
    });

    expect(result).toMatchObject({
      imageBase64: "cG5nLWRhdGE=",
      mimeType: "image/png",
      extension: ".png",
      width: 1024,
      height: 768,
      seed: 42,
      model: "flux-dev.safetensors",
      elapsedMs: 1500,
    });
  });

  it("runs the ComfyUI prompt-history-view flow and returns image bytes", async () => {
    const webpBytes = Uint8Array.from([82, 73, 70, 70]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === "http://comfy/prompt") {
        expect(init?.method).toBe("POST");
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body["prompt"]).toBeTruthy();
        return responseJson({ prompt_id: "prompt-123" });
      }

      if (url === "http://comfy/history/prompt-123") {
        return responseJson({
          "prompt-123": {
            outputs: {
              "7": {
                images: [{ filename: "starling.webp", subfolder: "", type: "output" }],
              },
            },
          },
        });
      }

      if (url === "http://comfy/view?filename=starling.webp&subfolder=&type=output") {
        return responseBytes(webpBytes, {
          status: 200,
          headers: { "Content-Type": "image/webp" },
        });
      }

      throw new Error(`Unexpected URL ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await requestImageGeneration({
      api: "comfyui",
      baseUrl: "http://comfy",
      timeoutMs: 10_000,
      model: "sd_xl_base_1.0.safetensors",
    }, {
      prompt: "cinematic starling",
      negativePrompt: "low quality",
      width: 1024,
      height: 1024,
      steps: 28,
      guidanceScale: 7,
    });

    expect(result).toMatchObject({
      imageBase64: Buffer.from(webpBytes).toString("base64"),
      mimeType: "image/webp",
      extension: ".webp",
      width: 1024,
      height: 1024,
      model: "sd_xl_base_1.0.safetensors",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("surfaces nested ComfyUI error messages from history polling", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "http://comfy/prompt") {
        return responseJson({ prompt_id: "prompt-123" });
      }
      if (url === "http://comfy/history/prompt-123") {
        return responseJson({
          "prompt-123": {
            status: {
              status_str: "error",
              messages: [["execution_error", { exception_message: "Checkpoint not found" }]],
            },
          },
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const config: ImageGenerationBackendConfig = {
      api: "comfyui",
      baseUrl: "http://comfy",
      timeoutMs: 10_000,
      model: "missing-model.safetensors",
    };

    await expect(requestImageGeneration(config, {
      prompt: "cinematic starling",
      width: 1024,
      height: 1024,
      steps: 28,
      guidanceScale: 7,
    })).rejects.toThrow("Checkpoint not found");
  });
});