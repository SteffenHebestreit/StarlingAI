import { randomUUID } from "node:crypto";
import { extname } from "node:path";

export type ImageGenerationApi = "automatic1111-compatible" | "comfyui";

export interface ImageGenerationBackendConfig {
  api: ImageGenerationApi;
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  model?: string;
}

export interface ImageGenerationRequest {
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  steps: number;
  guidanceScale: number;
  seed?: number;
  model?: string;
}

export interface ImageGenerationHealth {
  ok: boolean;
  disabled?: true;
  status?: number;
  error?: string;
}

export interface ImageGenerationResult {
  imageBase64: string;
  mimeType: string;
  extension: string;
  width?: number;
  height?: number;
  seed?: number;
  model?: string;
  elapsedMs?: number;
}

interface ComfyUiImageRef {
  filename: string;
  subfolder?: string;
  type?: string;
}

export function imageGenerationServiceConfigured(baseUrl: string | undefined): boolean {
  return typeof baseUrl === "string" && baseUrl.trim().length > 0;
}

export async function checkImageGenerationHealth(config: ImageGenerationBackendConfig): Promise<ImageGenerationHealth> {
  if (!imageGenerationServiceConfigured(config.baseUrl)) {
    return { ok: false, disabled: true, error: "Disabled: no image generation endpoint configured." };
  }

  const path = config.api === "comfyui" ? "/system_stats" : "/sdapi/v1/sd-models";
  try {
    const response = await fetchWithTimeout(
      upstreamUrl(config.baseUrl, path),
      { method: "GET", headers: upstreamHeaders(config.apiKey) },
      Math.min(config.timeoutMs, 5000),
    );

    if (response.ok) {
      return { ok: true, status: response.status };
    }

    return {
      ok: false,
      status: response.status,
      error: await extractUpstreamError(response, `Upstream returned HTTP ${response.status}`),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function requestImageGeneration(
  config: ImageGenerationBackendConfig,
  input: ImageGenerationRequest,
): Promise<ImageGenerationResult> {
  if (!imageGenerationServiceConfigured(config.baseUrl)) {
    throw new Error("Image generation is disabled: configure multimodal.imageGeneration.baseUrl to enable it.");
  }

  if (config.api === "comfyui") {
    return requestComfyUiImageGeneration(config, input);
  }

  return requestAutomatic1111ImageGeneration(config, input);
}

async function requestAutomatic1111ImageGeneration(
  config: ImageGenerationBackendConfig,
  input: ImageGenerationRequest,
): Promise<ImageGenerationResult> {
  const model = input.model ?? config.model;
  const payload: Record<string, unknown> = {
    prompt: input.prompt,
    negative_prompt: input.negativePrompt ?? "",
    width: input.width,
    height: input.height,
    steps: input.steps,
    cfg_scale: input.guidanceScale,
    seed: typeof input.seed === "number" ? input.seed : -1,
    send_images: true,
    save_images: false,
  };

  if (model) {
    payload["override_settings"] = {
      sd_model_checkpoint: model,
    };
  }

  const response = await fetchWithTimeout(
    upstreamUrl(config.baseUrl, "/sdapi/v1/txt2img"),
    {
      method: "POST",
      headers: upstreamHeaders(config.apiKey, { "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    },
    config.timeoutMs,
  );

  if (!response.ok) {
    throw new Error(await extractUpstreamError(response, "Image generation failed"));
  }

  const body = await parseUpstreamJsonResponse(response, "Image generation returned a non-JSON response");
  const image = Array.isArray(body["images"]) && typeof body["images"][0] === "string"
    ? stripBase64Prefix(body["images"][0])
    : "";
  if (!image) {
    throw new Error("Image generation service returned no image data");
  }

  const info = parseJsonObjectLike(body["info"]);
  const parameters = isRecord(body["parameters"]) ? body["parameters"] : undefined;

  return {
    imageBase64: image,
    mimeType: "image/png",
    extension: ".png",
    width: numericField(parameters?.["width"]) ?? numericField(info?.["width"]) ?? input.width,
    height: numericField(parameters?.["height"]) ?? numericField(info?.["height"]) ?? input.height,
    seed: numericField(info?.["seed"]) ?? (typeof input.seed === "number" ? input.seed : undefined),
    model: stringField(info?.["sd_model_name"]) ?? stringField(info?.["model"]) ?? model,
    elapsedMs: secondsToMs(numericField(info?.["elapsed"])),
  };
}

async function requestComfyUiImageGeneration(
  config: ImageGenerationBackendConfig,
  input: ImageGenerationRequest,
): Promise<ImageGenerationResult> {
  const model = input.model ?? config.model;
  if (!model) {
    throw new Error("ComfyUI image generation requires a model name. Set multimodal.imageGeneration.model or pass model in the request.");
  }

  const promptResponse = await fetchWithTimeout(
    upstreamUrl(config.baseUrl, "/prompt"),
    {
      method: "POST",
      headers: upstreamHeaders(config.apiKey, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        client_id: randomUUID(),
        prompt: buildComfyUiWorkflow(input, model),
      }),
    },
    config.timeoutMs,
  );

  if (!promptResponse.ok) {
    throw new Error(await extractUpstreamError(promptResponse, "Image generation failed"));
  }

  const promptBody = await parseUpstreamJsonResponse(promptResponse, "ComfyUI prompt submission returned a non-JSON response");
  const promptId = stringField(promptBody["prompt_id"]);
  if (!promptId) {
    throw new Error("ComfyUI did not return a prompt_id");
  }

  const deadline = Date.now() + config.timeoutMs;
  while (Date.now() < deadline) {
    const historyResponse = await fetchWithTimeout(
      upstreamUrl(config.baseUrl, `/history/${encodeURIComponent(promptId)}`),
      { method: "GET", headers: upstreamHeaders(config.apiKey) },
      Math.min(5000, Math.max(1000, deadline - Date.now())),
    );

    if (!historyResponse.ok) {
      throw new Error(await extractUpstreamError(historyResponse, "Failed to read ComfyUI history"));
    }

    const historyBody = await parseUpstreamJsonResponse(historyResponse, "ComfyUI history returned a non-JSON response");
    const historyEntry = isRecord(historyBody[promptId]) ? historyBody[promptId] : undefined;
    const promptError = extractComfyUiError(historyEntry);
    if (promptError) {
      throw new Error(promptError);
    }

    const imageRef = extractFirstComfyUiImageRef(historyEntry);
    if (imageRef) {
      const viewUrl = new URL(upstreamUrl(config.baseUrl, "/view"));
      viewUrl.searchParams.set("filename", imageRef.filename);
      viewUrl.searchParams.set("subfolder", imageRef.subfolder ?? "");
      viewUrl.searchParams.set("type", imageRef.type ?? "output");

      const imageResponse = await fetchWithTimeout(
        viewUrl.toString(),
        { method: "GET", headers: upstreamHeaders(config.apiKey) },
        Math.min(5000, Math.max(1000, deadline - Date.now())),
      );

      if (!imageResponse.ok) {
        throw new Error(await extractUpstreamError(imageResponse, "Failed to fetch generated image"));
      }

      const imageBytes = Buffer.from(await imageResponse.arrayBuffer());
      const mimeType = imageResponse.headers.get("content-type") || inferMimeTypeFromFilename(imageRef.filename);
      return {
        imageBase64: imageBytes.toString("base64"),
        mimeType,
        extension: extensionFromFilenameOrMime(imageRef.filename, mimeType),
        width: input.width,
        height: input.height,
        seed: typeof input.seed === "number" ? input.seed : undefined,
        model,
      };
    }

    await sleep(750);
  }

  throw new Error(`ComfyUI image generation timed out after ${config.timeoutMs}ms`);
}

function buildComfyUiWorkflow(input: ImageGenerationRequest, model: string): Record<string, unknown> {
  return {
    "1": {
      inputs: { ckpt_name: model },
      class_type: "CheckpointLoaderSimple",
    },
    "2": {
      inputs: { text: input.prompt, clip: ["1", 1] },
      class_type: "CLIPTextEncode",
    },
    "3": {
      inputs: { text: input.negativePrompt ?? "", clip: ["1", 1] },
      class_type: "CLIPTextEncode",
    },
    "4": {
      inputs: { width: input.width, height: input.height, batch_size: 1 },
      class_type: "EmptyLatentImage",
    },
    "5": {
      inputs: {
        seed: typeof input.seed === "number" ? input.seed : Math.floor(Math.random() * 2_147_483_647),
        steps: input.steps,
        cfg: input.guidanceScale,
        sampler_name: "euler",
        scheduler: "normal",
        denoise: 1,
        model: ["1", 0],
        positive: ["2", 0],
        negative: ["3", 0],
        latent_image: ["4", 0],
      },
      class_type: "KSampler",
    },
    "6": {
      inputs: { samples: ["5", 0], vae: ["1", 2] },
      class_type: "VAEDecode",
    },
    "7": {
      inputs: { images: ["6", 0], filename_prefix: "starlingai" },
      class_type: "SaveImage",
    },
  };
}

function extractFirstComfyUiImageRef(historyEntry: Record<string, unknown> | undefined): ComfyUiImageRef | null {
  if (!historyEntry || !isRecord(historyEntry["outputs"])) return null;
  for (const output of Object.values(historyEntry["outputs"])) {
    if (!isRecord(output) || !Array.isArray(output["images"])) continue;
    for (const image of output["images"]) {
      if (!isRecord(image)) continue;
      const filename = stringField(image["filename"]);
      if (!filename) continue;
      return {
        filename,
        subfolder: stringField(image["subfolder"]) ?? undefined,
        type: stringField(image["type"]) ?? undefined,
      };
    }
  }
  return null;
}

function extractComfyUiError(historyEntry: Record<string, unknown> | undefined): string | null {
  if (!historyEntry) return null;
  const status = isRecord(historyEntry["status"]) ? historyEntry["status"] : undefined;
  const errorMessage = firstNestedErrorString(status?.["messages"])
    ?? stringField(status?.["status_str"] === "error" ? status?.["status_str"] : undefined)
    ?? firstNestedErrorString(historyEntry["messages"]);
  return errorMessage ?? null;
}

function upstreamUrl(baseUrl: string, routePath: string): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(routePath.replace(/^\//, ""), normalizedBase).toString();
}

function upstreamHeaders(apiKey?: string, init: Record<string, string> | Headers = {}): Headers {
  const headers = new Headers(init);
  if (apiKey && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }
  return headers;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Request to ${url} failed: ${detail}`);
  } finally {
    clearTimeout(timer);
  }
}

async function extractUpstreamError(response: Response, fallback: string): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";

  try {
    if (contentType.includes("application/json")) {
      const body = await response.json() as Record<string, unknown>;
      const detail = body["detail"] ?? body["error"] ?? body["message"] ?? body["exception_message"];
      if (typeof detail === "string" && detail.trim()) {
        return detail.trim();
      }
      return fallback;
    }

    const text = await response.text();
    if (text.trim()) {
      return `${fallback}: ${summarizeUpstreamText(text)}`;
    }
  } catch {
    // Ignore parse failures and fall back to the generic message.
  }

  return fallback;
}

async function parseUpstreamJsonResponse(response: Response, fallback: string): Promise<Record<string, unknown>> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    const text = await response.text();
    throw new Error(`${fallback}: ${summarizeUpstreamText(text)}`);
  }

  try {
    return await response.json() as Record<string, unknown>;
  } catch (error) {
    throw new Error(error instanceof Error ? `${fallback}: ${error.message}` : fallback);
  }
}

function summarizeUpstreamText(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) return "empty response";
  return collapsed.length > 240 ? `${collapsed.slice(0, 237)}...` : collapsed;
}

function stripBase64Prefix(value: string): string {
  return value.replace(/^data:[^;]+;base64,/, "").trim();
}

function parseJsonObjectLike(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function extensionFromFilenameOrMime(filename: string, mimeType: string): string {
  const ext = extname(filename).toLowerCase();
  if (ext) return ext;
  if (mimeType.includes("png")) return ".png";
  if (mimeType.includes("jpeg")) return ".jpg";
  if (mimeType.includes("webp")) return ".webp";
  return ".png";
}

function inferMimeTypeFromFilename(filename: string): string {
  const ext = extname(filename).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstNestedString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = firstNestedString(entry);
      if (nested) return nested;
    }
  }

  if (isRecord(value)) {
    for (const entry of Object.values(value)) {
      const nested = firstNestedString(entry);
      if (nested) return nested;
    }
  }

  return undefined;
}

function firstNestedErrorString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (Array.isArray(entry)) {
        const nestedPayload = entry.length > 1 ? firstNestedErrorString(entry[1]) : undefined;
        if (nestedPayload) return nestedPayload;
      }

      const nested = firstNestedErrorString(entry);
      if (nested) return nested;
    }
    return undefined;
  }

  if (isRecord(value)) {
    for (const entry of Object.values(value)) {
      const nested = firstNestedErrorString(entry);
      if (nested) return nested;
    }
    return undefined;
  }

  const text = stringField(value);
  if (!text) return undefined;
  return /^(error|execution_error|status|failed)$/i.test(text) ? undefined : text;
}

function numericField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && value.trim() && Number.isFinite(Number(value))
      ? Number(value)
      : undefined;
}

function secondsToMs(value: number | undefined): number | undefined {
  return typeof value === "number" ? Math.round(value * 1000) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}