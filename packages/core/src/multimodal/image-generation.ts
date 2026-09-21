import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { createConcurrencyGateFamily } from "../runtime/concurrency-gate.js";

export type ImageGenerationApi = "automatic1111-compatible" | "comfyui" | "openai-compatible";

/**
 * Which tier a request asks for, on a backend that offers more than one.
 *
 * Not a quality knob — a COST knob. On the cluster this was written against the two tiers
 * differ by more than ten times in wall clock, and the slow one runs on the worker station's
 * graphics chip and drops that station's chat throughput by about 70% while it runs, one
 * generation at a time cluster-wide. So a caller asking for "quality" is spending someone
 * else's latency, and the choice belongs in the request rather than in a default.
 */
export type ImageGenerationTier = "fast" | "quality";

export interface ImageGenerationBackendConfig {
  api: ImageGenerationApi;
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  model?: string;
  /** Model id for the slow, higher-fidelity tier. Absent means the backend has only one. */
  qualityModel?: string;
  /** Wall-clock bound for the quality tier, which is far longer than the fast one. */
  qualityTimeoutMs?: number;
  /** How many generations may run at once for a model. Hardware-dependent; see the schema. */
  maxConcurrent?: number;
  maxConcurrentPerModel?: Record<string, number>;
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
  tier?: ImageGenerationTier;
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

  const path = config.api === "comfyui"
    ? "/system_stats"
    // An OpenAI-compatible endpoint has no /sdapi; `/models` is its own liveness check and
    // the doc calls it authoritative, so a tier that has been unloaded still answers here.
    : config.api === "openai-compatible" ? "/models" : "/sdapi/v1/sd-models";
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
      error: await extractUpstreamError(response, "Upstream rejected the health probe"),
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

  if (config.api === "openai-compatible") {
    return requestOpenAiImageGeneration(config, input);
  }

  return requestAutomatic1111ImageGeneration(config, input);
}

/** Both tiers of the cluster endpoint run fixed-resolution pipelines. */
const OPENAI_IMAGE_SIZE = 1024;

/**
 * One in-flight generation per MODEL, because the model is what maps to a device.
 *
 * sd-server generates serially, so a second request for the same model does not run in
 * parallel — it waits in the backend with the clock already running. That turns the client
 * timeout into a lie: a 210 s cap against a 140 s generation looks generous until two
 * requests arrive together and the second is abandoned at 210 s having generated for 70.
 * Queuing here instead means the timeout measures generation rather than queue position.
 *
 * Per model rather than globally, because the tiers run on different devices and a
 * measurement showed they do not contend: an NPU job issued during an iGPU generation still
 * returned, about 50% slower. A single global slot would park a 10-second fast request
 * behind a 140-second quality one for no hardware reason.
 *
 * Only the OpenAI-compatible adapter is gated. AUTOMATIC1111 and ComfyUI have their own
 * queueing and no measurement here says they serialize, and serializing a backend that
 * handles parallelism fine would be a self-inflicted slowdown.
 */
const openAiImageGates = createConcurrencyGateFamily(1);

/**
 * The ceiling for one model, read fresh on every call.
 *
 * Fresh rather than cached because the hardware behind a model id changes without this
 * process restarting — the fast tier gained a second station mid-development and went from
 * serial to two-at-a-time. A ceiling captured at import time would have kept half of it idle
 * until the next deploy.
 */
function concurrencyForModel(config: ImageGenerationBackendConfig, model: string): number {
  const perModel = config.maxConcurrentPerModel?.[model];
  return Math.max(1, Math.floor(perModel ?? config.maxConcurrent ?? 1));
}

/**
 * OpenAI-compatible `POST /v1/images/generations`.
 *
 * Three things about this contract are not the OpenAI default and each one has bitten a
 * client that assumed otherwise:
 *
 *  - The response carries base64 in `b64_json`, never a URL. There is no file host behind
 *    the endpoint, so a client that reads `data[0].url` gets undefined and reports success.
 *  - The resolution is FIXED. Any other `size` is rejected rather than quietly resampled, so
 *    a width the caller asked for is refused here with the reason rather than sent to fail.
 *  - The quality tier needs up to 150 s, and after ten minutes idle it reloads its weights
 *    first, adding about 25 s. A 30 s client default — which many are — abandons a request
 *    that was going to succeed.
 */
async function requestOpenAiImageGeneration(
  config: ImageGenerationBackendConfig,
  input: ImageGenerationRequest,
): Promise<ImageGenerationResult> {
  const tier: ImageGenerationTier = input.tier ?? "fast";
  const model = input.model
    ?? (tier === "quality" ? config.qualityModel ?? config.model : config.model);
  if (!model) {
    throw new Error(
      "No image model configured. Set multimodal.imageGeneration.model (and qualityModel for the slow tier).",
    );
  }
  if (tier === "quality" && !config.qualityModel && !input.model) {
    throw new Error(
      "The quality tier was requested but multimodal.imageGeneration.qualityModel is not set."
      + " Configure it, or generate on the fast tier.",
    );
  }

  if (input.width !== OPENAI_IMAGE_SIZE || input.height !== OPENAI_IMAGE_SIZE) {
    throw new Error(
      `This backend generates ${OPENAI_IMAGE_SIZE}x${OPENAI_IMAGE_SIZE} only and rejects any other size`
      + ` (asked for ${input.width}x${input.height}). Generate at ${OPENAI_IMAGE_SIZE}x${OPENAI_IMAGE_SIZE}`
      + " and resize afterwards if a different shape is needed.",
    );
  }

  const payload: Record<string, unknown> = {
    model,
    prompt: input.prompt,
    n: 1,
    size: `${OPENAI_IMAGE_SIZE}x${OPENAI_IMAGE_SIZE}`,
    response_format: "b64_json",
  };
  // Extras the fast tier accepts. Sent only when the caller asked for them, so a backend
  // that ignores or rejects unknown fields is not handed any by default.
  if (input.negativePrompt) payload["negative_prompt"] = input.negativePrompt;
  if (typeof input.seed === "number") payload["seed"] = input.seed;
  if (typeof input.steps === "number") payload["steps"] = input.steps;
  if (typeof input.guidanceScale === "number") payload["guidance_scale"] = input.guidanceScale;

  const timeoutMs = tier === "quality"
    ? config.qualityTimeoutMs ?? Math.max(config.timeoutMs, 200_000)
    : config.timeoutMs;

  // Below this line the request is valid and the only thing left is the backend. Everything
  // that can be rejected locally — an unset quality model, a size this endpoint refuses —
  // has already thrown, so a config mistake still fails in milliseconds rather than after
  // waiting out someone else's generation.
  const gate = openAiImageGates.for(model);
  gate.setLimit(concurrencyForModel(config, model));
  return gate.withSlot(
    () => sendOpenAiImageRequest(config, input, model, payload, timeoutMs),
  );
}

/** The network half, run with a slot held. Everything here assumes the request is valid. */
async function sendOpenAiImageRequest(
  config: ImageGenerationBackendConfig,
  input: ImageGenerationRequest,
  model: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<ImageGenerationResult> {
  // Started after the slot is held, so `elapsedMs` reports how long the image took rather
  // than how long this call queued — the same thing the field means in the other adapters.
  const startedAt = Date.now();
  const response = await fetchWithTimeout(
    upstreamUrl(config.baseUrl, "/images/generations"),
    {
      method: "POST",
      headers: upstreamHeaders(config.apiKey, { "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    },
    timeoutMs,
  );

  if (!response.ok) {
    throw new Error(await extractUpstreamError(response, `Image generation failed (${model})`));
  }

  const body = await parseUpstreamJsonResponse(response, "Image generation returned a non-JSON response");
  const first = Array.isArray(body["data"]) && isRecord(body["data"][0]) ? body["data"][0] : undefined;
  const image = stripBase64Prefix(stringField(first?.["b64_json"]) ?? "");
  if (!image) {
    // Said explicitly rather than returning an empty success: a URL here would mean the
    // endpoint changed contract, and silently writing a zero-byte PNG is the worse failure.
    throw new Error(
      first?.["url"]
        ? "Image generation returned a URL instead of base64; this endpoint has no file host behind it."
        : "Image generation service returned no image data",
    );
  }

  return {
    imageBase64: image,
    mimeType: "image/png",
    extension: ".png",
    width: OPENAI_IMAGE_SIZE,
    height: OPENAI_IMAGE_SIZE,
    ...(typeof input.seed === "number" ? { seed: input.seed } : {}),
    model,
    elapsedMs: Date.now() - startedAt,
  };
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

/** Keys an upstream might hang its message on, in the order we prefer them. */
const UPSTREAM_DETAIL_KEYS = ["detail", "error", "message", "exception_message"] as const;

/**
 * Dig a human-readable message out of an error body, following nested `error` objects.
 *
 * The flat lookup this replaces stopped at the first hit and required it to be a string, so
 * an OpenAI-shaped `{"error": {"message": ...}}` — which is what both llama-swap and the
 * OpenAI API itself send — yielded an object, failed the string test, and lost the message.
 */
function findUpstreamDetail(value: unknown, depth = 0): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (depth >= 4 || !isRecord(value)) return undefined;
  for (const key of UPSTREAM_DETAIL_KEYS) {
    if (!(key in value)) continue;
    const found = findUpstreamDetail(value[key], depth + 1);
    if (found) return found;
  }
  return undefined;
}

/**
 * The upstream's own words about a failure, plus the status that carried them.
 *
 * This used to return the bare `fallback` whenever a JSON body's detail was not a string,
 * which is exactly the shape a llama-swap gateway sends:
 *
 *   {"src":"llama-swap","error":{"message":"peer proxy error: net/http: timeout awaiting
 *    response headers","type":"server_error","code":"bad_gateway"}}
 *
 * So a 502 carrying a precise diagnostic reached the agent as "Image generation failed
 * (image)" and the log learned nothing at all. That distinction is not cosmetic: a proxy
 * that never got response headers is a different failure from a model that refused the
 * prompt, and only one of them is ours to fix.
 *
 * The body is read as text first and parsed afterwards, so a JSON error served with the
 * wrong content-type — common from proxies and error pages — is still mined rather than
 * truncated to a generic sentence. When nothing parses, the raw text is the evidence.
 */
async function extractUpstreamError(response: Response, fallback: string): Promise<string> {
  const status = `HTTP ${response.status}`;

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `${fallback} (${status}, body unreadable: ${detail})`;
  }

  if (!text.trim()) return `${fallback} (${status}, empty body)`;

  let detail: string | undefined;
  try {
    detail = findUpstreamDetail(JSON.parse(text) as unknown);
  } catch {
    // Not JSON. The raw text is still the best evidence we have, so fall through to it.
  }

  return `${fallback} (${status}): ${summarizeUpstreamText(detail ?? text)}`;
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