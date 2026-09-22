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
  /** Models that generate one fixed resolution and reject anything else. */
  fixedSizeModels?: string[];
  /**
   * Models whose backend actually honours a base image. EMPTY means no model does.
   *
   * An allowlist rather than an attempt, because the failure mode of guessing is the worst
   * one available here: the endpoint measured today accepts `image`, `init_image`,
   * `init_images`, `reference_image`, `ref_images` and `image_b64` with HTTP 200 and ignores
   * every one of them. So "edit this image" would return a brand-new unrelated picture and
   * look like it worked — which is exactly what happened to a user asking three times to
   * continue from a previous render, and getting three unrelated beaches.
   */
  initImageModels?: string[];
  defaultWidth?: number;
  defaultHeight?: number;
  defaultSteps?: number;
  defaultGuidanceScale?: number;
  defaultNegativePrompt?: string;
  /** Sampling defaults for the quality tier, where they differ from the fast tier's. */
  qualityDefaults?: {
    steps?: number;
    guidanceScale?: number;
    negativePrompt?: string;
  };
  /** A different backend for the quality tier; see the schema for why this exists. */
  qualityBackend?: {
    api?: ImageGenerationApi;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    timeoutMs?: number;
  };
}

/**
 * What a caller asks for. Everything except the prompt is optional on purpose.
 *
 * Callers used to fill these in themselves from config, and the rule was duplicated in two
 * places that then disagreed: the REST route sent the FAST tier's guidance to the quality
 * model and used the fast tier's 120s timeout for a render that takes ~340s at that guidance,
 * aborting every default-sized request while the device kept working on an image nobody
 * would receive. Resolution happens once, in `requestImageGeneration`, so a new caller
 * cannot reintroduce that by forgetting a field.
 */
export interface ImageGenerationRequest {
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  guidanceScale?: number;
  seed?: number;
  model?: string;
  tier?: ImageGenerationTier;
  /**
   * A base image to work FROM, as bare base64 (no data: prefix).
   *
   * Without this there is no iteration: "now add the palms" and "make the sky warmer"
   * each produce a brand-new picture that shares nothing with the last one but the words.
   * That is what happened live — three rounds of "continue from the previous image" returned
   * three unrelated beaches, and the palms the user asked to keep were gone by round two.
   */
  initImage?: string;
  /**
   * How far the result may move from `initImage`, in [0,1]. 0 keeps it, 1 ignores it.
   *
   * Same sense as stable-diffusion.cpp's own `strength` and A1111's `denoising_strength`,
   * so the number means one thing across the adapters.
   */
  strength?: number;
  /**
   * Which REGION of `initImage` may change, as a bare-base64 RGBA PNG.
   *
   * ALPHA semantics, the OpenAI convention: a TRANSPARENT pixel may be edited, an OPAQUE one
   * is protected. This is the opposite of stable-diffusion.cpp's luminance convention
   * underneath, and the endpoint converts — but the distinction matters here because getting
   * it backwards edits precisely the region the caller meant to keep, returns HTTP 200, and
   * produces a picture that looks entirely plausible. Only a per-region pixel measurement
   * tells the two apart, so this is not a mistake any amount of eyeballing would catch.
   *
   * Requires `initImage`; the generations route rejects a mask outright. A mask selecting
   * nothing, selecting everything, or that is not an image is rejected with param "mask",
   * and the endpoint answers 502 if the engine ignored the mask at runtime rather than
   * returning a silently unmasked result.
   *
   * THE LIMIT: Qwen-Image 2.1 has no inpainting mask channels, so the model never sees the
   * mask — the endpoint composites the result. Feathering makes the join invisible, but it
   * cannot make CONTENT continuous. Good for replacing a region; not for "extend this wall
   * across the gap", which needs an inpainting-trained model.
   */
  mask?: string;
  /**
   * Feather width in pixels for the mask edge. The engine binarizes masks, so the blend is
   * done by the endpoint rather than the model; without it a mask leaves a hard seam.
   */
  maskBlur?: number;
}

/** A request after defaults are applied — what every adapter actually receives. */
interface ResolvedImageRequest extends ImageGenerationRequest {
  tier: ImageGenerationTier;
  /** True when the tier was raised because the one asked for cannot edit. */
  tierUpgradedForEdit?: boolean;
  width: number;
  height: number;
  steps: number;
  guidanceScale: number;
}

/** Default for how far an edit may move from its base: a visible change that still recognisably follows it. */
const DEFAULT_EDIT_STRENGTH = 0.45;

export interface ImageGenerationHealth {
  ok: boolean;
  disabled?: true;
  status?: number;
  error?: string;
}

export interface ImageGenerationResult {
  imageBase64: string;
  /** The tier actually used, which is not always the one asked for — see resolveImageRequest. */
  tier?: ImageGenerationTier;
  /** Set when the tier was raised because editing needs a tier the caller did not ask for. */
  tierUpgradedForEdit?: boolean;
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

  const request = resolveImageRequest(config, input);

  // Refuse an edit the backend cannot perform, instead of returning something unrelated.
  //
  // Silence is the danger here: the endpoint returns 200 for a reference field it discards,
  // so without this the caller receives a fresh image and reports it as an iteration. An
  // agent told honestly that editing is unavailable can say so, or start over deliberately;
  // one handed a plausible wrong answer cannot.
  if (request.initImage) {
    const target = request.model
      ?? (request.tier === "quality" ? config.qualityModel ?? config.model : config.model)
      ?? "";
    if (!config.initImageModels?.includes(target)) {
      throw new Error(
        `This backend cannot edit an existing image: ${target || "the configured model"} is not in`
        + " multimodal.imageGeneration.initImageModels. Generate a new image from a full prompt"
        + " instead, and say plainly that the previous one could not be used as a base —"
        + " do NOT present a fresh generation as an edit of an earlier one.",
      );
    }
  }

  // The tier can point at an entirely different backend, so it is resolved BEFORE the
  // protocol is chosen — otherwise the quality tier would be dispatched by the fast tier's
  // api and never reach the route that honours its parameters.
  const effective = resolveTierBackend(config, request.tier);

  if (effective.api === "comfyui") {
    return requestComfyUiImageGeneration(effective, request);
  }

  if (effective.api === "openai-compatible") {
    return requestOpenAiImageGeneration(effective, request);
  }

  return requestAutomatic1111ImageGeneration(effective, request);
}

/**
 * Fill in everything the caller did not specify, once, for every caller.
 *
 * Two things happen here that no caller should have to remember.
 *
 * The TIER IS INFERRED FROM THE MODEL when it was not stated. Naming `image-quality` and
 * saying nothing about the tier used to select the fast tier's timeout and the fast tier's
 * guidance, which is the worst of both: the quality model rendering at a guidance its own
 * config calls redundant — roughly doubling its ~170s — against a 120s abort. Every such
 * request failed, and the device carried on producing an image nobody would receive while
 * the released slot let the next caller queue behind it inside the backend.
 *
 * The SAMPLING DEFAULTS ARE PER TIER, because the two tiers disagree and both read the
 * fields. Measured with the seed pinned so only the parameter could vary: the fast tier
 * renders differently at guidance 1.0 than at 7.5, and the quality tier takes 22s at
 * guidance 4 against 11s at 1.0.
 */
function resolveImageRequest(
  config: ImageGenerationBackendConfig,
  input: ImageGenerationRequest,
): ResolvedImageRequest {
  // A NAMED MODEL DECIDES ITS OWN TIER. The two are not independent knobs: the tier exists to
  // pick a model and its sampling defaults, so honouring both separately produced incoherent
  // requests. `{model: "image", tier: "quality"}` rendered on the FAST model while taking the
  // quality tier's steps, guidance and 300 s budget, and reported `tier: "quality"` back to
  // the caller — a render on one engine labelled as the other.
  const tierOfModel = (named: string | undefined): ImageGenerationTier | undefined =>
    !named ? undefined
      : config.qualityModel && named === config.qualityModel ? "quality"
        : config.model && named === config.model ? "fast"
          : undefined; // A model outside the configured pair: the stated tier picks defaults.
  let tier: ImageGenerationTier = tierOfModel(input.model) ?? input.tier ?? "fast";
  let model = input.model;

  // AN EDIT GOES TO A TIER THAT CAN EDIT, whatever tier was asked for.
  //
  // Only one tier here has an edit route, and it is not the default one. This first upgraded
  // only when no tier was stated, on the reasoning that an explicit "fast" was a cost choice
  // to respect. That was wrong in practice: the agent states "fast" because the tool
  // documents it as the default, not because it weighed anything — and the refusal it earned
  // sent it straight to a fresh unrelated picture, which is the failure the whole capability
  // exists to prevent. Observed twice in a row on "nimm das Bild als Basis".
  //
  // There is no fast edit to fall back to, so the real choice is "edit on the slower tier" or
  // "silently do something else". Upgrading is the only one that answers the request, and
  // `tierUpgradedForEdit` carries the cost up to the caller so it can be said out loud
  // instead of being discovered in the latency.
  //
  // The upgrade must move the MODEL, not just the tier label. An earlier version derived both
  // candidates from `input.model`, so naming a model made the two comparisons identical, the
  // upgrade could never fire, and the request fell through to a flat refusal further down —
  // defeating the capability for exactly the caller who was most specific about what it wanted.
  let tierUpgradedForEdit = false;
  if (input.initImage) {
    const canEdit = (named: string | undefined): boolean =>
      Boolean(named) && (config.initImageModels?.includes(named!) ?? false);
    const editModel = config.qualityModel ?? config.model;
    const current = model
      ?? (tier === "quality" ? config.qualityModel ?? config.model : config.model);
    if (!canEdit(current) && canEdit(editModel)) {
      tier = "quality";
      model = editModel;
      tierUpgradedForEdit = true;
    }
  }

  const tierDefaults = tier === "quality" ? config.qualityDefaults : undefined;

  return {
    ...input,
    tier,
    ...(model ? { model } : {}),
    ...(tierUpgradedForEdit ? { tierUpgradedForEdit: true } : {}),
    width: input.width ?? config.defaultWidth ?? OPENAI_IMAGE_SIZE,
    height: input.height ?? config.defaultHeight ?? OPENAI_IMAGE_SIZE,
    steps: input.steps ?? tierDefaults?.steps ?? config.defaultSteps ?? 20,
    guidanceScale: input.guidanceScale ?? tierDefaults?.guidanceScale ?? config.defaultGuidanceScale ?? 7.5,
    negativePrompt: input.negativePrompt ?? tierDefaults?.negativePrompt ?? config.defaultNegativePrompt,
  };
}

/**
 * Flatten a tier's overrides onto the base config.
 *
 * Only the quality tier can be redirected, because only it has a reason to be: the fast tier
 * is the one whose protocol the deployment is built around. `model` becomes the plain
 * `model` here so the chosen adapter needs no tier awareness at all — it is handed one
 * backend and one model, exactly as if that were the only one configured.
 */
function resolveTierBackend(
  config: ImageGenerationBackendConfig,
  tier: ImageGenerationTier,
): ImageGenerationBackendConfig {
  const override = config.qualityBackend;
  if (tier !== "quality" || !override) return config;
  return {
    ...config,
    api: override.api ?? config.api,
    baseUrl: override.baseUrl ?? config.baseUrl,
    model: override.model ?? config.qualityModel ?? config.model,
    // Cleared so the adapter cannot fall back to a tier alias this backend never heard of.
    qualityModel: override.model ?? config.qualityModel,
    ...(override.apiKey ? { apiKey: override.apiKey } : {}),
    timeoutMs: override.timeoutMs ?? config.qualityTimeoutMs ?? config.timeoutMs,
  };
}

/** Both tiers of the cluster endpoint run fixed-resolution pipelines. */
const OPENAI_IMAGE_SIZE = 1024;

/**
 * Statuses the endpoint uses to mean "ask again", not "your request is wrong".
 *
 * Both are documented behaviours of this cluster rather than guesses. 429 is a busy signal:
 * each tier generates one image at a time, a second request waits, and a third is refused
 * outright rather than queued behind a two-minute job. 503 is the fast tier reporting that
 * its neural accelerator wedged, rebuilt itself, and wants the request again.
 *
 * Treating either as a failure hands the user "image generation failed" for a condition the
 * server explicitly said was temporary. Retrying is bounded and keeps the concurrency slot,
 * so a retry never lets a later caller overtake the one that was already waiting.
 */
const RETRYABLE_IMAGE_STATUS = new Set([429, 503]);
const IMAGE_RETRY_BACKOFF_MS = [1_500, 4_000];

const delay = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

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
 * The AUTOMATIC1111 adapter is gated too, because the quality tier now runs through it and
 * that is the device where serialising actually matters. ComfyUI is left alone: it has its
 * own queue and nothing measured here says it serialises.
 */
const imageGates = createConcurrencyGateFamily(1);

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
  input: ResolvedImageRequest,
): Promise<ImageGenerationResult> {
  const tier = input.tier;
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

  // Only the models that actually refuse other sizes. Measured: the NPU tier answers HTTP
  // 502 in ~13ms for anything but 1024x1024, while the iGPU tier served 64x64 in 1.2s and
  // 1024x768 in 91s. Guarding both alike refused a request the backend would have served.
  if (config.fixedSizeModels?.includes(model)
    && (input.width !== OPENAI_IMAGE_SIZE || input.height !== OPENAI_IMAGE_SIZE)) {
    throw new Error(
      `The ${model} model generates ${OPENAI_IMAGE_SIZE}x${OPENAI_IMAGE_SIZE} only and rejects any other`
      + ` size (asked for ${input.width}x${input.height}). Generate at`
      + ` ${OPENAI_IMAGE_SIZE}x${OPENAI_IMAGE_SIZE}, or use a tier that accepts other shapes.`,
    );
  }

  const payload: Record<string, unknown> = {
    model,
    prompt: input.prompt,
    n: 1,
    size: `${input.width}x${input.height}`,
    response_format: "b64_json",
  };
  // Extras the fast tier accepts. Sent only when the caller asked for them, so a backend
  // that ignores or rejects unknown fields is not handed any by default.
  if (input.initImage) {
    // ONE spelling. An earlier version sent `image`, `init_image` and `init_images` together
    // because no shim agreed on the name; this endpoint settled on `image`, and `strength` is
    // likewise the single accepted spelling — not `denoising_strength`.
    //
    // CORRECTION, measured 2026-09-22: this comment used to claim the endpoint "rejects
    // unknown parameters by name rather than ignoring them". It does NOT. A request carrying
    // `__definitely_not_real__: 1` returned HTTP 200 and a real image; so did `mask_image`,
    // which is the near-miss spelling of a field that DOES exist. Most unknown names are
    // silently dropped, so a misspelled parameter costs a full render and changes nothing,
    // and you cannot use a rejection to discover which names the backend honours — that reads
    // as a working feature and is how a silent no-op gets shipped. A few names ARE
    // special-cased loudly: `mask` is validated and rejected with param "mask" when it selects
    // nothing, selects everything, or is not an image.
    payload["image"] = input.initImage;
    payload["strength"] = input.strength ?? DEFAULT_EDIT_STRENGTH;
    if (input.mask) {
      payload["mask"] = input.mask;
      if (typeof input.maskBlur === "number") payload["mask_blur"] = input.maskBlur;
    }
  } else if (input.mask) {
    // Loud rather than silently dropped: the generations route rejects a mask anyway, and a
    // caller who built one has a region in mind that would simply have been ignored.
    throw new Error(
      "A mask needs a base image to mask. Pass the image being edited as well, or drop the mask.",
    );
  }
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
  const gate = imageGates.for(model);
  gate.setLimit(concurrencyForModel(config, model));
  return gate.withSlot(
    () => sendOpenAiImageRequest(config, input, model, payload, timeoutMs),
  );
}

/**
 * The same payload as multipart, with `image` and `mask` promoted to file parts.
 *
 * Both are held as bare base64 in the payload because that is what the JSON path sends; here
 * they are decoded back to bytes. Every other field goes across as its string form, which is
 * all multipart can carry — the endpoint parses the numbers back out.
 */
function buildEditForm(payload: Record<string, unknown>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(payload)) {
    if (key === "image" || key === "mask" || value === undefined || value === null) continue;
    form.set(key, String(value));
  }
  for (const key of ["image", "mask"] as const) {
    const encoded = payload[key];
    if (typeof encoded !== "string" || !encoded) continue;
    const bytes = Buffer.from(encoded, "base64");
    form.set(key, new Blob([bytes], { type: "image/png" }), `${key}.png`);
  }
  return form;
}

/** The network half, run with a slot held. Everything here assumes the request is valid. */
async function sendOpenAiImageRequest(
  config: ImageGenerationBackendConfig,
  input: ResolvedImageRequest,
  model: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<ImageGenerationResult> {
  // Started after the slot is held, so `elapsedMs` reports how long the image took rather
  // than how long this call queued — the same thing the field means in the other adapters.
  const startedAt = Date.now();
  let response: Response | undefined;
  for (let attempt = 0; ; attempt += 1) {
    response = await fetchWithTimeout(
      // Editing has its own route. Sending a reference to /images/generations returns
      // 400 "does not accept 'image'. Use /v1/images/edits" — a good error, and one we
      // should never provoke.
      upstreamUrl(config.baseUrl, input.initImage ? "/images/edits" : "/images/generations"),
      // A MASK IS A FILE PART, so a masked edit cannot go as JSON. Everything else stays on
      // the JSON path, which is measured-equivalent to multipart for the `image` field and is
      // the shape already in production — no reason to churn the working case.
      //
      // `Content-Type` is deliberately omitted for multipart: fetch generates it WITH the
      // boundary, and setting it by hand produces a header with no boundary that the server
      // cannot parse.
      input.mask
        ? { method: "POST", headers: upstreamHeaders(config.apiKey), body: buildEditForm(payload) }
        : {
          method: "POST",
          headers: upstreamHeaders(config.apiKey, { "Content-Type": "application/json" }),
          body: JSON.stringify(payload),
        },
      timeoutMs,
    );
    if (response.ok) break;
    const backoff = IMAGE_RETRY_BACKOFF_MS[attempt];
    if (!RETRYABLE_IMAGE_STATUS.has(response.status) || backoff === undefined) {
      throw new Error(await extractUpstreamError(response, `Image generation failed (${model})`));
    }
    // Drain the body so the connection is not left half-read between attempts.
    await response.text().catch(() => "");
    await delay(backoff);
  }

  const body = await parseUpstreamJsonResponse(response, "Image generation returned a non-JSON response");
  const first = Array.isArray(body["data"]) && isRecord(body["data"][0]) ? body["data"][0] : undefined;
  const image = stripBase64Prefix(stringField(first?.["b64_json"]) ?? "");
  assertEditWasApplied(input, body);
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
    tier: input.tier,
    ...(input.tierUpgradedForEdit ? { tierUpgradedForEdit: true } : {}),
    width: input.width,
    height: input.height,
    ...(typeof input.seed === "number" ? { seed: input.seed } : {}),
    model,
    elapsedMs: Date.now() - startedAt,
  };
}

async function requestAutomatic1111ImageGeneration(
  config: ImageGenerationBackendConfig,
  input: ResolvedImageRequest,
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
  // An edit is a different ENDPOINT in this protocol, not a flag on the same one.
  if (input.initImage) {
    payload["init_images"] = [input.initImage];
    payload["denoising_strength"] = input.strength ?? DEFAULT_EDIT_STRENGTH;
  }

  if (model) {
    payload["override_settings"] = {
      sd_model_checkpoint: model,
    };
  }

  // One in flight per model here as well: the quality tier reaches its device through this
  // adapter, and that device generates serially.
  const gateKey = model ?? config.baseUrl;
  const gate = imageGates.for(gateKey);
  gate.setLimit(concurrencyForModel(config, gateKey));
  return gate.withSlot(() => sendAutomatic1111Request(config, input, model, payload));
}

/** The network half, run with a slot held. */
async function sendAutomatic1111Request(
  config: ImageGenerationBackendConfig,
  input: ResolvedImageRequest,
  model: string | undefined,
  payload: Record<string, unknown>,
): Promise<ImageGenerationResult> {
  const response = await fetchWithTimeout(
    upstreamUrl(config.baseUrl, input.initImage ? "/sdapi/v1/img2img" : "/sdapi/v1/txt2img"),
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
  input: ResolvedImageRequest,
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

/**
 * Prove the base image was actually used, from what the ENGINE reports rather than what we
 * asked for.
 *
 * The response carries `usage.mode` ("img2img" or "txt2img"), `usage.strength` — the value
 * the sampler actually applied — and `usage.strength_requested`. A `txt2img` mode, or a
 * missing strength, means the reference did not land and the picture is a fresh generation
 * wearing an edit's name. That distinction is the whole safety property here: a user told
 * three times that their image had been revised, when each round was an unrelated render,
 * is the failure this exists to make impossible.
 *
 * Compared with a TOLERANCE, never for equality. The applied value is a float32 round-trip
 * of what was sent: 0.35 comes back as 0.3499999940395355 and 0.85 likewise. An exact
 * comparison would fail every edit whose strength is not representable, which is most of
 * them.
 */
/**
 * Do NOT try to confirm an edit from the PNG's own generation record.
 *
 * Every image this backend returns carries a tEXt "parameters" chunk, and for a genuine
 * img2img it still reads `"mode":"img_gen"` with no `ref_images` entry — that string names
 * stable-diffusion.cpp's entry point, not whether a reference was used. Reading it as proof
 * of a text-to-image render sends you hunting a backend bug that is not there.
 *
 * What actually discriminates is `strength`, measured on decoded pixels against the base:
 * 0.15 -> 10.1, 0.5 -> 16.3, 0.65 -> 21.8, 0.78 -> 23.8, and 0.9 -> 55.3 against 58.2 for a
 * text-to-image control of the same prompt. Strength near 1 converging on the control is the
 * signature of a reference that IS being applied.
 */
function assertEditWasApplied(input: ResolvedImageRequest, body: Record<string, unknown>): void {
  if (!input.initImage) return;
  const usage = isRecord(body["usage"]) ? body["usage"] : undefined;
  if (!usage) return; // A backend that reports nothing cannot be checked; the allowlist gates those.

  const mode = stringField(usage["mode"]);
  const applied = numericField(usage["strength"]);
  const asked = input.strength ?? DEFAULT_EDIT_STRENGTH;

  if (mode !== "img2img" || applied === undefined || Math.abs(applied - asked) > 0.01) {
    throw new Error(
      "The backend did not apply the base image"
      + `${mode ? ` (mode "${mode}"` : " (no mode reported"}`
      + `${applied === undefined ? ", no strength reported" : `, strength ${applied} against ${asked} requested`})`
      + ". The result is a fresh generation, not an edit — do not present it as a revision of the"
      + " earlier image.",
    );
  }

  assertMaskWasRespected(input, usage);
}

/**
 * A mask that was ignored, or applied backwards, returns HTTP 200 and a plausible picture.
 *
 * Unlike `usage.mode` — which only echoes which route we posted to, and so confirms nothing
 * about the work — `usage.mask` carries the endpoint's own MEASUREMENTS of what moved. That
 * makes two distinct failures catchable here:
 *
 *  - Ignored. `respected: false`, or no mask report at all when we sent one. The endpoint
 *    answers 502 when the engine drops the mask at runtime, so reaching this branch means
 *    something upstream of that check let it through.
 *  - INVERTED. The OpenAI alpha convention and stable-diffusion.cpp's luminance convention are
 *    opposites, so an unconverted mask edits exactly the region the caller meant to protect.
 *    `protected_delta` exceeding `edited_delta` is that signature, and it is invisible to the
 *    eye — the picture looks fine, it is just the wrong half of it that changed.
 */
function assertMaskWasRespected(input: ResolvedImageRequest, usage: Record<string, unknown>): void {
  if (!input.mask) return;
  const report = isRecord(usage["mask"]) ? usage["mask"] : undefined;
  if (!report) {
    throw new Error(
      "A mask was sent but the backend reported nothing about it, so there is no evidence the"
      + " edit was confined to the requested region. Treat the result as an unmasked edit.",
    );
  }
  if (report["respected"] === false) {
    throw new Error(
      "The backend did not apply the mask, so the whole image was edited rather than the"
      + " selected region. Do not present the result as a local change.",
    );
  }

  const edited = numericField(report["edited_delta"]);
  const protectedDelta = numericField(report["protected_delta"]);
  if (edited !== undefined && protectedDelta !== undefined && protectedDelta > edited) {
    throw new Error(
      `The mask appears INVERTED: the protected region changed more than the edited one`
      + ` (protected ${protectedDelta}, edited ${edited}). A mask is alpha-based here —`
      + " transparent marks what may change, opaque what must be kept.",
    );
  }
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