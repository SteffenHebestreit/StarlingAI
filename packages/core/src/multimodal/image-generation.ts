import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { inflateSync } from "node:zlib";
import { Agent as UndiciAgent } from "undici";
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
  /** What each tier's engine is called, so a user naming one can be understood. */
  tierLabels?: Partial<Record<ImageGenerationTier, string>>;
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
  /**
   * How long the image server itself waits for a render before it gives up, in ms; absent where it
   * has no such limit. No timeout here can extend it, so a render expected to take longer is
   * refused before it is sent (imageRenderLimitError).
   */
  maxRenderMs?: number;
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
  /** True when an `<sd_cpp_extra_args>` block was removed from the prompt (stripEngineArgs). */
  engineArgsRemoved?: boolean;
  width: number;
  height: number;
  steps: number;
  guidanceScale: number;
}

/** Default for how far an edit may move from its base: a visible change that still recognisably follows it. */
export const DEFAULT_EDIT_STRENGTH = 0.45;

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
  /** Set when an `<sd_cpp_extra_args>` block was removed from the prompt before it was sent. */
  engineArgsRemoved?: boolean;
  /** Set when the render carried a negative prompt at guidance ≤ 1, where it changes nothing. */
  negativePromptIgnored?: boolean;
  mimeType: string;
  extension: string;
  width?: number;
  height?: number;
  seed?: number;
  model?: string;
  elapsedMs?: number;
  /**
   * How long the render waited, before its own clock started, for the device to finish a render
   * abandoned earlier (see deviceBusyUntil). Not in `elapsedMs`, and minutes long on the quality
   * engine — said, so a slow answer after a timeout is not a mystery.
   */
  deviceWaitMs?: number;
}

interface ComfyUiImageRef {
  filename: string;
  subfolder?: string;
  type?: string;
}

/** One configured engine, as an agent should hear about it. */
export interface ImageTierChoice {
  tier: ImageGenerationTier;
  model: string;
  label?: string;
}

/**
 * The engines this deployment actually has, by tier.
 *
 * Session f4ebf47b: the user said "nimm das qwen model", the agent sent `model: "Qwen"`, the
 * router answered 404, and the agent retried on the fast tier and reported the picture as
 * Qwen's. Nothing it could read said that the quality tier IS the Qwen engine — that lived
 * only in config comments. These choices are what the tool shows and checks names against.
 */
export function imageTierChoices(config: ImageGenerationBackendConfig): ImageTierChoice[] {
  const choices: ImageTierChoice[] = [];
  const add = (tier: ImageGenerationTier, model: string | undefined): void => {
    if (!model) return;
    const label = config.tierLabels?.[tier]?.trim();
    choices.push({ tier, model, ...(label ? { label } : {}) });
  };
  add("fast", config.model);
  if (config.qualityModel !== config.model) add("quality", config.qualityModel);
  return choices;
}

/**
 * The tier a named engine belongs to — by exact model id or exact label, ignoring case.
 * Deliberately no partial matching: "Qwen" is not "Qwen-Image 2.1", and guessing which
 * engine a fragment meant is how a request ends up on the wrong one without anyone saying so.
 */
export function resolveNamedImageEngine(
  config: ImageGenerationBackendConfig,
  name: string,
): ImageGenerationTier | undefined {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return undefined;
  return imageTierChoices(config)
    .find((choice) => choice.model.toLowerCase() === wanted || choice.label?.toLowerCase() === wanted)
    ?.tier;
}

/** `fast` = Segmind Vega (model "image"); `quality` = … — for tool text and refusals. */
export function describeImageTierChoices(config: ImageGenerationBackendConfig): string {
  return imageTierChoices(config)
    .map((choice) => `\`${choice.tier}\` = ${choice.label ? `${choice.label} (model "${choice.model}")` : `model "${choice.model}"`}`)
    .join("; ");
}

/** The human name of the engine behind a tier, when one is configured. */
export function imageEngineLabel(
  config: ImageGenerationBackendConfig,
  tier: ImageGenerationTier | undefined,
): string | undefined {
  return tier ? config.tierLabels?.[tier]?.trim() || undefined : undefined;
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
  const outOfBounds = imageRequestBoundsError(input);
  if (outOfBounds) throw new Error(`${outOfBounds}. Nothing was rendered.`);

  // Measured only when it can matter: an edit with no size stated renders at its base's size.
  const baseSize = input.initImage && input.width === undefined && input.height === undefined
    ? await measureImage(input.initImage)
    : undefined;
  const request = resolveImageRequest(config, input, baseSize);
  // Before the slot and the backend: a render the server would cut off fails now, not in ten minutes.
  const tooLong = imageRenderLimitError(config, request);
  if (tooLong) throw new ImageRenderTooLongError(tooLong);
  const budget = renderBudget(config, request);

  // Refuse an edit the backend cannot perform, instead of returning something unrelated.
  //
  // Silence is the danger here: the endpoint returns 200 for a reference field it discards,
  // so without this the caller receives a fresh image and reports it as an iteration. An
  // agent told honestly that editing is unavailable can say so, or start over deliberately;
  // one handed a plausible wrong answer cannot.
  if (request.initImage) {
    const target = request.model ?? engineModelForTier(config, request.tier) ?? "";
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

  const result = effective.api === "comfyui"
    ? await requestComfyUiImageGeneration(effective, request, budget)
    : effective.api === "openai-compatible"
      ? await requestOpenAiImageGeneration(effective, request, budget)
      : await requestAutomatic1111ImageGeneration(effective, request, budget);

  // Every adapter reports which tier rendered, not only the OpenAI one. Without this a render
  // routed to the quality tier's own backend came back with no tier at all, so the caller
  // could not say which engine made the picture — and the edit-upgrade notice was lost.
  return {
    ...result,
    tier: result.tier ?? request.tier,
    ...(request.tierUpgradedForEdit ? { tierUpgradedForEdit: true } : {}),
    ...(request.engineArgsRemoved ? { engineArgsRemoved: true } : {}),
    ...(negativePromptHasNoEffect(request) ? { negativePromptIgnored: true } : {}),
  };
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
  /** The natural size of `input.initImage`, when the caller measured it. */
  baseSize?: ImageSize,
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

  const tierDefaults = imageTierDefaults(config, tier);

  // AN EDIT KEEPS ITS BASE'S SHAPE when no size was asked for. The configured default is a
  // square, so a 1024x768 picture edited without a size came back 1024x1024 — the picture
  // stretched, and a mask painted on the base no longer lined up with the result. A fixed-size
  // engine still gets its one size, and a base outside the size bounds keeps the default.
  const targetModel = model ?? engineModelForTier(config, tier);
  const editSize = input.initImage && input.width === undefined && input.height === undefined
    && baseSize && fitsImageSizeBounds(baseSize)
    && !(targetModel && config.fixedSizeModels?.includes(targetModel))
    ? baseSize
    : undefined;

  // Settings travel in their own fields and nowhere else; see stripEngineArgs.
  const prompt = stripEngineArgs(input.prompt);
  if (!prompt.text) {
    throw new Error("The prompt is empty once its <sd_cpp_extra_args> block is removed. Nothing was rendered: describe the picture in the prompt.");
  }
  const negativeRaw = input.negativePrompt ?? tierDefaults.negativePrompt;
  const negative = negativeRaw === undefined ? undefined : stripEngineArgs(negativeRaw);

  return {
    ...input,
    prompt: prompt.text,
    tier,
    ...(model ? { model } : {}),
    ...(tierUpgradedForEdit ? { tierUpgradedForEdit: true } : {}),
    ...(prompt.removed || negative?.removed ? { engineArgsRemoved: true } : {}),
    width: input.width ?? editSize?.width ?? tierDefaults.width,
    height: input.height ?? editSize?.height ?? tierDefaults.height,
    steps: input.steps ?? tierDefaults.steps,
    guidanceScale: input.guidanceScale ?? tierDefaults.guidanceScale,
    negativePrompt: negative?.text,
  };
}

/**
 * The prompt without stable-diffusion.cpp's `<sd_cpp_extra_args>{json}</sd_cpp_extra_args>` block.
 *
 * sd-server reads that block out of the PROMPT TEXT and applies it over the request's own fields.
 * Measured 2026-09-26 on the quality engine: it set the sampler, the scheduler and the STEPS — asked
 * for 2, the engine ran 4 while the endpoint's `usage.steps` still said 2. So a pasted prompt could
 * start a render the image server cuts off at 600 s, past the limit check and the settings step,
 * and every record of it would name the wrong settings. Each tag becomes a space, repeated until
 * none is left, so removing one cannot splice two halves into a new one.
 */
export function stripEngineArgs(text: string): { text: string; removed: boolean } {
  let out = text;
  for (;;) {
    const next = out
      .replace(/<sd_cpp_extra_args>[\s\S]*?<\/sd_cpp_extra_args>/gi, " ")
      .replace(/<\/?sd_cpp_extra_args>/gi, " ");
    if (next === out) break;
    out = next;
  }
  return out === text ? { text, removed: false } : { text: out.replace(/\s{2,}/g, " ").trim(), removed: true };
}

/**
 * A negative prompt that cannot change the picture: at guidance ≤ 1 there is no classifier-free
 * guidance, so the negative prompt has nothing to steer against. Measured 2026-09-26 on the quality
 * engine with the seed pinned: identical pixels with and without one at guidance 1, a mean distance
 * of 56 at guidance 4 — at twice the time.
 */
export function negativePromptHasNoEffect(request: { negativePrompt?: string; guidanceScale: number }): boolean {
  return Boolean(request.negativePrompt?.trim()) && request.guidanceScale <= 1;
}

/** What a tier renders with when the request names nothing: the size, steps and guidance its time was measured at. */
export interface ImageTierDefaults {
  width: number;
  height: number;
  steps: number;
  guidanceScale: number;
  negativePrompt?: string;
}

export function imageTierDefaults(config: ImageGenerationBackendConfig, tier: ImageGenerationTier): ImageTierDefaults {
  const tierDefaults = tier === "quality" ? config.qualityDefaults : undefined;
  const negativePrompt = tierDefaults?.negativePrompt ?? config.defaultNegativePrompt;
  return {
    width: config.defaultWidth ?? OPENAI_IMAGE_SIZE,
    height: config.defaultHeight ?? OPENAI_IMAGE_SIZE,
    steps: tierDefaults?.steps ?? config.defaultSteps ?? 20,
    guidanceScale: tierDefaults?.guidanceScale ?? config.defaultGuidanceScale ?? 7.5,
    ...(negativePrompt !== undefined ? { negativePrompt } : {}),
  };
}

/**
 * How long each tier takes for its REFERENCE RENDER (IMAGE_TIER_REFERENCE_RENDER), in seconds:
 * about ten for the fast engine, ~170 for a quality render at 1024x1024 and 20 steps (measured
 * 169 s). Every other request's time is this scaled by imageRenderWork.
 */
export const IMAGE_TIER_EXPECTED_SECONDS: Record<ImageGenerationTier, number> = { fast: 10, quality: 170 };

/**
 * The render each IMAGE_TIER_EXPECTED_SECONDS figure was MEASURED at. A fact about the hardware,
 * so it is fixed here rather than read from the tier's configured defaults: the two used to be the
 * same thing, and raising the quality default from 20 steps to the model's official 40 would then
 * have kept "170 s at the defaults" — a 40-step render handed the 300 s budget of a 20-step one and
 * abandoned at 300 s while the engine rendered on (the session 807684e9 failure). The same holds
 * for a defaultSteps an administrator changes on the Settings page.
 */
export const IMAGE_TIER_REFERENCE_RENDER: Record<ImageGenerationTier, ImageSize & { steps: number; guidanceScale: number }> = {
  fast: { width: 1024, height: 1024, steps: 20, guidanceScale: 7.5 },
  quality: { width: 1024, height: 1024, steps: 20, guidanceScale: 1 },
};

/** The parts of a resolved request that decide how long it renders. */
export type ImageRenderShape = Pick<ImageRequestPreview, "tier" | "width" | "height" | "steps" | "guidanceScale">;

/**
 * The work a resolved request is, relative to its tier's reference render: 1 renders in the tier's
 * measured time, 2.8 takes 2.8 times as long.
 *
 * A diffusion render costs one forward pass per step per latent pixel, so the time scales with
 * steps and with area; and true CFG runs a second pass per step, which on an engine that renders
 * at guidance ≤ 1 (no CFG) doubles it — measured 22 s against 11 s on the quality tier. Session
 * 807684e9: the user set a quality render to 57 steps at 1344x768, about eight minutes, against a
 * fixed 300 s budget; it was abandoned at exactly 300 s while the device kept rendering, and the
 * retry queued behind the abandoned render inside the backend.
 */
export function imageRenderWork(_config: ImageGenerationBackendConfig, request: ImageRenderShape): number {
  const reference = IMAGE_TIER_REFERENCE_RENDER[request.tier];
  const steps = request.steps / reference.steps;
  const area = (request.width * request.height) / (reference.width * reference.height);
  const cfg = reference.guidanceScale <= 1 && request.guidanceScale > 1 ? 2 : 1;
  const work = steps * area * cfg;
  return Number.isFinite(work) && work > 0 ? work : 1;
}

/** The budget a tier is configured with, before the request's own work scales it. */
function tierTimeoutMs(config: ImageGenerationBackendConfig, tier: ImageGenerationTier): number {
  if (tier !== "quality") return config.timeoutMs;
  return config.qualityBackend?.timeoutMs ?? config.qualityTimeoutMs ?? Math.max(config.timeoutMs, 200_000);
}

/**
 * How long this request may take before it is abandoned: the tier's configured timeout, scaled up
 * by the request's work and never below it. The configured figure is sized for the tier's
 * reference render plus a weight reload after idle, so a smaller request keeps that margin rather
 * than losing it.
 */
export function imageRequestTimeoutMs(config: ImageGenerationBackendConfig, request: ImageRenderShape): number {
  const scaled = Math.round(tierTimeoutMs(config, request.tier) * Math.max(1, imageRenderWork(config, request)));
  // Never waits past the moment the image server itself gives up: no answer can come after it.
  return config.maxRenderMs ? Math.min(scaled, config.maxRenderMs + IMAGE_SERVER_CUT_GRACE_MS) : scaled;
}

/** How long this request should take: the tier's measured time, scaled by the request's work. */
export function expectedImageRenderSeconds(config: ImageGenerationBackendConfig, request: ImageRenderShape): number {
  return IMAGE_TIER_EXPECTED_SECONDS[request.tier] * imageRenderWork(config, request);
}

/** How long past the server's own limit its answer may take to arrive before this side stops waiting. */
const IMAGE_SERVER_CUT_GRACE_MS = 30_000;

/**
 * The share of the image server's limit a render may be expected to fill. The estimate is close —
 * 50 steps at 1344x768 on the quality engine: 418 s expected, 414 s measured (session fa673f2c) —
 * but a quality render reloads its weights after ten idle minutes (~25 s) and shares its machine,
 * so the last tenth is margin.
 */
export const IMAGE_RENDER_LIMIT_HEADROOM = 0.9;

/**
 * The longest a render may be expected to take, in seconds: the image server's own limit
 * (maxRenderMs) less the headroom. Undefined where no limit is configured.
 */
export function imageRenderLimitSeconds(config: ImageGenerationBackendConfig): number | undefined {
  return config.maxRenderMs ? (config.maxRenderMs / 1000) * IMAGE_RENDER_LIMIT_HEADROOM : undefined;
}

/**
 * What would bring a render within `allowedSeconds`, as one sentence: guidance back to the
 * engine's default where true CFG doubles the time, else the steps that fit at this size.
 */
function renderFitAdvice(config: ImageGenerationBackendConfig, request: ImageRenderShape, allowedSeconds: number): string {
  const defaults = imageTierDefaults(config, request.tier);
  const cfgDoubles = defaults.guidanceScale <= 1 && request.guidanceScale > 1;
  const withoutCfg = expectedImageRenderSeconds(config, cfgDoubles ? { ...request, guidanceScale: defaults.guidanceScale } : request);
  // Not "without improving the picture": the quality engine is meant to render without guidance,
  // but guidance is also what gives a negative prompt its effect, and that is the person's call.
  const cfgNote = `guidance above ${defaults.guidanceScale} doubles the time on this engine`;
  if (cfgDoubles && withoutCfg <= allowedSeconds) {
    return `At guidance ${defaults.guidanceScale}, the engine's default, the same steps and size take about`
      + ` ${formatRenderDuration(withoutCfg)} — ${cfgNote}.`;
  }
  const maxSteps = Math.floor((request.steps * allowedSeconds) / withoutCfg);
  const at = `${request.width}x${request.height}${cfgDoubles ? ` with guidance ${defaults.guidanceScale} (${cfgNote})` : ""}`;
  return maxSteps >= IMAGE_STEPS_BOUNDS.min
    ? `At ${at}, at most ${maxSteps} steps fit.`
    : `Even one step at ${at} does not fit: use a smaller size.`;
}

/**
 * Why a resolved request cannot finish within the image server's own limit, with what would fit;
 * undefined when it can, or where no limit is configured.
 *
 * Session fa673f2c: the quality engine was asked for 60 steps with guidance 2.5 — about 17 minutes —
 * behind a proxy that gives up on any request after 10. The client's own budget allowed 30, so the
 * render was sent, cut at exactly 600 s, sent again and cut again: twenty minutes of the cluster's
 * slowest device for nothing, while the engine kept rendering what nobody would receive.
 */
export function imageRenderLimitError(config: ImageGenerationBackendConfig, request: ImageRenderShape): string | undefined {
  const over = imageRenderOverLimit(config, request);
  if (!over) return undefined;
  return `${renderEngineName(config, request)} would need about ${formatRenderDuration(over.expectedSeconds)} for`
    + ` ${request.steps} steps at ${request.width}x${request.height} with guidance ${request.guidanceScale}, and the image`
    + ` server gives up on any render after ${formatRenderDuration(over.serverSeconds)}, so it would fail. Nothing`
    + ` was rendered. ${over.advice}`;
}

/** A render too long for the image server: what it would take, the server's limit, and what would fit. */
export interface ImageRenderOverLimit {
  expectedSeconds: number;
  serverSeconds: number;
  advice: string;
}

/** The same judgement for a person choosing settings (the settings form words it its own way). */
export function imageRenderOverLimit(config: ImageGenerationBackendConfig, request: ImageRenderShape): ImageRenderOverLimit | undefined {
  const allowed = imageRenderLimitSeconds(config);
  if (!config.maxRenderMs || allowed === undefined) return undefined;
  const expectedSeconds = expectedImageRenderSeconds(config, request);
  if (expectedSeconds <= allowed) return undefined;
  return { expectedSeconds, serverSeconds: config.maxRenderMs / 1000, advice: renderFitAdvice(config, request, allowed) };
}

/** "8 min" / "40 s", as the render limit's messages word a duration. */
export function describeRenderDuration(seconds: number): string {
  return formatRenderDuration(seconds);
}

/** A render refused before it was sent because it could not finish within the image server's limit. */
export class ImageRenderTooLongError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageRenderTooLongError";
  }
}

/** The steps a render may ask for — the settings form's bound as well. */
export const IMAGE_STEPS_BOUNDS = { min: 1, max: 100 } as const;

/**
 * Why a request's steps or size are outside what may be rendered, or undefined.
 *
 * The budget scales with the work, so nothing else bounds it: 1000 steps at 2048x2048 with true
 * CFG is 400 times a default render — a timeout of about 33 hours, with the run's clocks held
 * for all of it once the user took the settings. Refused rather than clamped, because a quietly
 * different render is reported as the one asked for. The minimum size is left to the backend: a
 * 64x64 render is a real request on the quality engine.
 */
export function imageRequestBoundsError(input: Pick<ImageGenerationRequest, "steps" | "width" | "height">): string | undefined {
  const problems: string[] = [];
  const { min, max } = IMAGE_STEPS_BOUNDS;
  if (input.steps !== undefined && !(Number.isInteger(input.steps) && input.steps >= min && input.steps <= max)) {
    problems.push(`steps must be a whole number from ${min} to ${max} (asked for ${input.steps})`);
  }
  for (const [name, side] of [["width", input.width], ["height", input.height]] as const) {
    if (side !== undefined && !(Number.isInteger(side) && side > 0 && side <= IMAGE_SIZE_BOUNDS.max)) {
      problems.push(`${name} must be a whole number of pixels up to ${IMAGE_SIZE_BOUNDS.max} (asked for ${side})`);
    }
  }
  return problems.length > 0 ? problems.join("; ") : undefined;
}

/** "8 min" / "40 s" — a duration as a person reads it. */
function formatRenderDuration(seconds: number): string {
  return seconds < 90 ? `${Math.max(1, Math.round(seconds))} s` : `${Math.round(seconds / 60)} min`;
}

/**
 * A render that ran out of time. A class, so the tool can tell it from every other failure and say
 * so in its metadata as well as in words.
 *
 * The words carry what the agent needs to not repeat session 807684e9, where the only message was
 * "This operation was aborted": the agent retried with identical settings, the retry queued inside
 * the backend behind the render it had just abandoned, and timed out as well.
 */
export class ImageGenerationTimeoutError extends Error {
  readonly timedOut = true;

  constructor(readonly details: {
    engine: string;
    tier: ImageGenerationTier;
    model?: string;
    timeoutMs: number;
    expectedSeconds: number;
    steps: number;
    width: number;
    height: number;
    /**
     * Set when the image server gave up rather than this side: how long it had waited. Its limit is
     * its own, so no budget here can extend it (session fa673f2c).
     */
    cutByServerAfterMs?: number;
    /** The server's own words for the cut, kept so the reader can see where it came from. */
    serverSaid?: string;
    /** What would fit within the limit that ended it, as renderFitAdvice words it. */
    advice?: string;
  }) {
    const cutByServer = details.cutByServerAfterMs !== undefined;
    super(
      (cutByServer
        ? `${details.engine} was still rendering when the image server gave up waiting after`
          + ` ${formatRenderDuration(details.cutByServerAfterMs! / 1000)} — the server's own limit, which no request can exceed:`
        : `${details.engine} did not finish within ${formatRenderDuration(details.timeoutMs / 1000)}, the limit for this`
          + " request:")
      + ` ${details.steps} steps at ${details.width}x${details.height} were expected to take about`
      + ` ${formatRenderDuration(details.expectedSeconds)}. The engine renders one picture at a time and keeps working on an`
      + " abandoned one, so it stays busy for a while yet. This is not transient: do NOT call generate_image again with"
      + " the same settings. Tell the user it timed out, and offer fewer steps or a smaller size."
      + (details.advice ? ` ${details.advice}` : "")
      + (details.serverSaid ? ` The server said: ${details.serverSaid}` : ""),
    );
    this.name = "ImageGenerationTimeoutError";
  }
}

/** What one render may spend, and the error to throw when it spends it all. */
interface RenderBudget {
  timeoutMs: number;
  expectedSeconds: number;
  timedOut(): ImageGenerationTimeoutError;
  /** The image server gave up after `elapsedMs`, saying `serverSaid`: its limit, not ours, ended the render. */
  cutByServer(elapsedMs: number, serverSaid: string): ImageGenerationTimeoutError;
}

/** "Qwen-Image 2.1 (the quality tier)" — the engine a request renders on, as the agent reads it. */
function renderEngineName(config: ImageGenerationBackendConfig, request: Pick<ImageRenderShape, "tier"> & { model?: string }): string {
  const model = request.model ?? engineModelForTier(config, request.tier);
  const label = imageEngineLabel(config, request.tier);
  return label
    ? `${label} (the ${request.tier} tier)`
    : `The ${request.tier} tier${model ? ` (model ${model})` : ""}`;
}

function renderBudget(config: ImageGenerationBackendConfig, request: ResolvedImageRequest): RenderBudget {
  const timeoutMs = imageRequestTimeoutMs(config, request);
  const expectedSeconds = expectedImageRenderSeconds(config, request);
  const model = request.model ?? engineModelForTier(config, request.tier);
  const details = {
    engine: renderEngineName(config, request),
    tier: request.tier,
    ...(model ? { model } : {}),
    timeoutMs,
    expectedSeconds,
    steps: request.steps,
    width: request.width,
    height: request.height,
  };
  return {
    timeoutMs,
    expectedSeconds,
    timedOut: () => new ImageGenerationTimeoutError(details),
    cutByServer: (elapsedMs, serverSaid) => {
      // What fits in the limit the server just showed, with the same margin a configured one gets.
      // A render that should have fitted was not cut for its own length but for a wait inside the
      // backend, and lowering its settings would not have saved it.
      const allowed = (elapsedMs / 1000) * IMAGE_RENDER_LIMIT_HEADROOM;
      return new ImageGenerationTimeoutError({
        ...details,
        cutByServerAfterMs: elapsedMs,
        serverSaid,
        advice: expectedSeconds <= allowed
          ? "These settings fit within that limit, so the engine was most likely still busy with another render first."
          : renderFitAdvice(config, request, allowed),
      });
    },
  };
}

/** What a request will run as, without running it. */
export interface ImageRequestPreview {
  tier: ImageGenerationTier;
  /** The model the tier resolves to; empty when nothing is configured. */
  model: string;
  tierUpgradedForEdit: boolean;
  width: number;
  height: number;
  steps: number;
  guidanceScale: number;
  negativePrompt?: string;
}

/**
 * The resolution requestImageGeneration applies, for a caller that must show it before the render
 * — the settings step offers the person exactly what would run. Re-deriving the tier, the edit
 * upgrade and the per-tier defaults anywhere else is the drift the note on ImageGenerationRequest
 * describes. `baseSize` is the natural size of `input.initImage`; the render measures it itself.
 */
export function previewImageRequest(
  config: ImageGenerationBackendConfig,
  input: ImageGenerationRequest,
  baseSize?: ImageSize,
): ImageRequestPreview {
  const request = resolveImageRequest(config, input, baseSize);
  return {
    tier: request.tier,
    model: request.model ?? engineModelForTier(config, request.tier) ?? "",
    tierUpgradedForEdit: request.tierUpgradedForEdit === true,
    width: request.width,
    height: request.height,
    steps: request.steps,
    guidanceScale: request.guidanceScale,
    ...(request.negativePrompt ? { negativePrompt: request.negativePrompt } : {}),
  };
}

/** The model a tier renders on when no model was named. */
export function engineModelForTier(
  config: ImageGenerationBackendConfig,
  tier: ImageGenerationTier,
): string | undefined {
  return tier === "quality" ? config.qualityModel ?? config.model : config.model;
}

export interface ImageSize {
  width: number;
  height: number;
}

/** Inside the sizes a render may ask for (the schema's own width/height bounds). */
export function fitsImageSizeBounds(size: ImageSize): boolean {
  const fits = (side: number) => Number.isInteger(side)
    && side >= IMAGE_SIZE_BOUNDS.min && side <= IMAGE_SIZE_BOUNDS.max;
  return fits(size.width) && fits(size.height);
}

/**
 * The natural size of an encoded picture, read from its header, or undefined when the header is
 * not one readImageHeaderSize knows. It used to decode the whole picture just to learn two numbers.
 */
export async function measureImage(base64: string): Promise<ImageSize | undefined> {
  return readImageHeaderSize(Buffer.from(base64, "base64"));
}

/**
 * The size an encoded picture DECLARES — PNG, JPEG, GIF, BMP, WebP or TIFF — read from its header
 * without decoding it; undefined for anything else, for a structure cut short, for a picture that
 * declares a size twice, and for a JPEG with more EXIF than a camera writes (MAX_EXIF_ENTRIES).
 *
 * Read BEFORE any decode, because the decoders allocate whatever the header declares and do it
 * synchronously: a 1.5 MB PNG declaring 20000x20000 held the event loop for 3 s and took RSS to
 * about 5 GB before it was rejected as the wrong size, and a chat of phone photos cost ~1.6 s of
 * blocked gateway per photo, each thrown away afterwards as larger than 2048.
 *
 * TWICE is "not known" because a decoder need not read the declaration read here. pngjs keeps the
 * LAST IHDR it parses: a 243 KB PNG declaring 320x256 and then 8000x8000 passed as a 320x256 mask
 * and was decoded at 8000x8000, the loop held for half a second and RSS up by 700 MB. jpeg-js
 * allocates for every frame header before it refuses a second one, and omggif sizes its buffer by
 * the first frame, not by the screen the GIF declares. So the whole structure is walked — chunk
 * and segment headers only, never the pixels.
 *
 * A JPEG's size is the one it is SHOWN at: an EXIF orientation of 5–8 swaps the sides, as the
 * decoder, the browser and so the painted mask all do. Reading the stored sides had Auto render a
 * portrait photo at 2048x1536 while the card and the form said 1536x2048.
 */
export function readImageHeaderSize(bytes: Uint8Array): ImageSize | undefined {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (data.length >= 8 && data.readUInt32BE(0) === 0x89504e47) return readPngSize(data);
    if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) return readJpegSize(data);
    if (data.length >= 13 && data.toString("latin1", 0, 3) === "GIF") return readGifSize(data);
    // BMP: the DIB header; the 12-byte OS/2 form has 16-bit sides, the rest signed 32-bit ones
    // (a negative height is a top-down bitmap, not a small one).
    if (data.length >= 26 && data.toString("latin1", 0, 2) === "BM") {
      return data.readUInt32LE(14) === 12
        ? sized(data.readUInt16LE(18), data.readUInt16LE(20))
        : sized(Math.abs(data.readInt32LE(18)), Math.abs(data.readInt32LE(22)));
    }
    // WebP: RIFF…WEBP, then a lossy (VP8), lossless (VP8L) or extended (VP8X) first chunk.
    if (data.length >= 30 && data.toString("latin1", 0, 4) === "RIFF" && data.toString("latin1", 8, 12) === "WEBP") {
      const chunk = data.toString("latin1", 12, 16);
      if (chunk === "VP8 ") return sized(data.readUInt16LE(26) & 0x3fff, data.readUInt16LE(28) & 0x3fff);
      if (chunk === "VP8L") {
        const bits = data.readUInt32LE(21);
        return sized((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
      }
      if (chunk === "VP8X") return sized(data.readUIntLE(24, 3) + 1, data.readUIntLE(27, 3) + 1);
      return undefined;
    }
    // TIFF: the first page's ImageWidth and ImageLength — the page a backend reads.
    const tiff = readTiff(data);
    if (tiff) {
      const width = tiff.tag(tiff.firstIfd, 256);
      const height = tiff.tag(tiff.firstIfd, 257);
      return width !== undefined && height !== undefined ? sized(width, height) : undefined;
    }
  } catch {
    // A structure cut short reads past the end; that is "not known", not a crash.
  }
  return undefined;
}

function sized(width: number, height: number): ImageSize | undefined {
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/** PNG: IHDR is the first chunk, width and height at 16..23; then every chunk header up to IEND. */
function readPngSize(data: Buffer): ImageSize | undefined {
  if (data.length < 33 || data.readUInt32BE(8) !== 13 || data.toString("latin1", 12, 16) !== "IHDR") return undefined;
  for (let offset = 33; ;) {
    if (offset + 8 > data.length) return undefined;
    const type = data.toString("latin1", offset + 4, offset + 8);
    if (type === "IEND") break;
    if (type === "IHDR") return undefined;
    offset += 12 + data.readUInt32BE(offset);
  }
  return sized(data.readUInt32BE(16), data.readUInt32BE(20));
}

/** C0–CF, except the DHT, JPG and DAC markers that share the range. */
const isJpegFrameMarker = (marker: number): boolean =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

/**
 * More scans than any encoder writes. jpeg-js walks every block of the picture once per scan, so a
 * progressive 2048x2048 JPEG of 16-byte scans held the gateway 5 s for 340 KB, and the 20 MB upload
 * cap allowed minutes. libjpeg's progressive scripts write 10 scans for colour, 24 at most for CMYK.
 */
const MAX_JPEG_SCANS = 64;

interface JpegStructure {
  frame: ImageSize;
  components: number;
  /** Adobe's APP14, without which jpeg-js outputs no 4-component picture. */
  adobe: boolean;
  scans: number;
}

/**
 * JPEG: every marker segment up to EOI — whatever follows EOI (a phone's depth map, say) is another
 * picture the decoder never reads — and one frame header.
 */
function readJpegStructure(data: Buffer): JpegStructure | undefined {
  let frame: ImageSize | undefined;
  let components = 0;
  let adobe = false;
  let scans = 0;
  let offset = 2;
  while (offset + 1 < data.length) {
    if (data[offset] !== 0xff) return undefined;
    const marker = data[offset + 1]!;
    if (marker === 0xff) { offset += 1; continue; }
    if (marker === 0xd9) break;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    const length = data.readUInt16BE(offset + 2);
    if (isJpegFrameMarker(marker)) {
      if (frame) return undefined;
      frame = sized(data.readUInt16BE(offset + 7), data.readUInt16BE(offset + 5));
      if (!frame) return undefined;
      components = data[offset + 9]!;
    } else if (marker === 0xee && data.toString("latin1", offset + 4, offset + 10) === "Adobe\0") {
      adobe = true;
    }
    offset += 2 + length;
    if (marker === 0xda) {
      scans += 1;
      // A scan's entropy-coded data carries no length: it runs to the next marker that is neither a
      // stuffed 0xFF00, a restart marker nor fill.
      offset = nextJpegMarker(data, offset);
    }
  }
  return frame ? { frame, components, adobe, scans } : undefined;
}

/** A JPEG's size as it is shown — turned as Jimp turns it (readExifOrientation). */
function readJpegSize(data: Buffer): ImageSize | undefined {
  const frame = readJpegStructure(data)?.frame;
  const orientation = frame ? readExifOrientation(data) : undefined;
  if (!frame || orientation === undefined) return undefined;
  return [5, 6, 7, 8].includes(orientation) ? { width: frame.height, height: frame.width } : frame;
}

function nextJpegMarker(data: Buffer, from: number): number {
  for (let index = data.indexOf(0xff, from); index >= 0 && index + 1 < data.length; index = data.indexOf(0xff, index + 1)) {
    const next = data[index + 1]!;
    if (next !== 0x00 && next !== 0xff && (next < 0xd0 || next > 0xd7)) return index;
  }
  return data.length;
}

/**
 * More IFD entries than a camera writes — its EXIF holds about a hundred. exif-parser reads every
 * entry of every IFD in every APP1, so a 1 MB file of small APP1s that all point at one 65535-entry
 * IFD is hundreds of millions of entries to read, here and again in Jimp. Like one with too many
 * scans, that JPEG is not decoded.
 */
const MAX_EXIF_ENTRIES = 2048;

interface ExifTag { type: number; count: number; at: number; little: boolean }

const EXIF_TOO_LARGE = new Error("more EXIF than a camera writes");

/**
 * The EXIF orientation Jimp turns a JPEG by — 1, "as stored", when it turns it by none — or
 * undefined for more EXIF than a camera writes (MAX_EXIF_ENTRIES).
 *
 * Jimp turns a picture by what exif-parser returns, and makes any error of exif-parser's into no
 * turn at all while the picture still decodes. So this reads what exif-parser reads, the way it
 * reads it, and fails where it fails: the segments up to the first scan and every EXIF APP1 among
 * them; in each, IFD0, then IFD1 whenever the pointer to it is not zero, then the GPS, Exif and
 * Interop IFDs, at offsets into the whole file rather than the segment. The first Orientation tag
 * wins, and turns the picture only as one number from 2 to 8. Reading IFD1 only when IFD0 had no
 * orientation, and letting a bad pointer throw out of the size read, lost the size of a picture
 * Jimp decoded at 2048x1536 — Auto rendered it square — and turned one that Jimp did not.
 */
function readExifOrientation(data: Buffer): number | undefined {
  const tags = new Map<number, ExifTag>();
  const budget = { entries: MAX_EXIF_ENTRIES };
  try {
    let marker = 0;
    for (let at = 0; at < data.length && marker !== 0xda;) {
      if (data.readUInt8(at) !== 0xff) return 1;
      marker = data.readUInt8(at + 1);
      if ((marker >= 0xd0 && marker <= 0xd9) || marker === 0xda) { at += 2; continue; }
      const length = data.readUInt16BE(at + 2) - 2;
      if (marker === 0xe1) readExifApp1(data, at + 4, tags, budget);
      at += 4 + length;
    }
    // exif-parser then turns three date tags into timestamps, and throws on one it cannot split.
    if ([0x0132, 0x9003, 0x9004].some((tag) => exifDateThrows(data, tags.get(tag)))) return 1;
  } catch (error) {
    if (error === EXIF_TOO_LARGE) return undefined;
    // exif-parser threw, so Jimp does not turn it: the picture decodes as stored.
    return 1;
  }
  const orientation = tags.get(0x0112);
  return orientation && orientation.count === 1 && orientation.type !== 0 && orientation.type !== 2
    ? exifNumber(data, orientation.at, orientation.type, orientation.little)
    : 1;
}

/** Bytes per value of each EXIF type exif-parser knows; a type it does not know, it cannot read. */
const EXIF_VALUE_BYTES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

/**
 * One APP1 as exif-parser's parseTags reads it, keeping the first of each tag it reports. A header
 * it cannot read makes it pass the segment by; anything after that throws, as it does there.
 */
function readExifApp1(data: Buffer, start: number, tags: Map<number, ExifTag>, budget: { entries: number }): void {
  const tiff = start + 6;
  if (data.toString("latin1", start, tiff) !== "Exif\0\0" || tiff + 4 > data.length) return;
  const order = data.readUInt16BE(tiff);
  if (order !== 0x4949 && order !== 0x4d4d) return;
  const little = order === 0x4949;
  const u16 = (at: number) => (little ? data.readUInt16LE(at) : data.readUInt16BE(at));
  const u32 = (at: number) => (little ? data.readUInt32LE(at) : data.readUInt32BE(at));
  if (u16(tiff + 2) !== 42) return;

  /** An IFD's entries, each handed on once its values would have read; returns where they end. */
  const readIfd = (ifd: number, onTag: (tag: number, value: ExifTag) => void): number => {
    let entry = tiff + ifd + 2;
    for (let left = u16(tiff + ifd); left > 0; left -= 1, entry += 12) {
      if (--budget.entries < 0) throw EXIF_TOO_LARGE;
      const [tag, type, count] = [u16(entry), u16(entry + 2), u32(entry + 4)];
      const size = EXIF_VALUE_BYTES[type] ?? 0;
      const at = size * count > 4 ? tiff + u32(entry + 8) : entry + 8;
      // Numbers are read one by one, so a list past the end throws; so does a type with no reader.
      if (count > 0 && type !== 0 && type !== 2 && type !== 7 && (size === 0 || at + size * count > data.length)) {
        throw new RangeError("EXIF value");
      }
      onTag(tag, { type, count, at, little });
    }
    return entry;
  };
  const report = (tag: number, value: ExifTag): void => {
    // Binary tags are left out. The thumbnail's tags are read for their first value, which a tag
    // of type 0 does not have.
    if (value.type === 7) return;
    if (value.type === 0 && (tag === 0x0103 || tag === 0x0201 || tag === 0x0202)) throw new TypeError("EXIF value");
    if (!tags.has(tag)) tags.set(tag, value);
  };
  /** A pointer tag's first value as exif-parser follows it: an offset, 0 for none, null where following it throws. */
  const pointer = ({ type, count, at }: ExifTag): number | null => {
    if (type === 0) throw new TypeError("EXIF pointer");
    if (count === 0) return 0;
    if (type === 2) return data.toString("utf8", at, at + count).split("\0")[0] ? null : 0;
    if (type === 7) return data[at] ?? 0;
    if (type === 5 || type === 10) return null;
    return exifNumber(data, at, type, little) || 0;
  };
  const follow = (offset: number | null, onTag: (tag: number, value: ExifTag) => void): void => {
    if (offset === null) throw new TypeError("EXIF pointer");
    if (offset !== 0) readIfd(offset, onTag);
  };

  let gps: number | null = 0;
  let exif: number | null = 0;
  let interop: number | null = 0;
  const ifd0End = readIfd(u32(tiff + 4), (tag, value) => {
    if (tag === 0x8825) gps = pointer(value);
    else if (tag === 0x8769) exif = pointer(value);
    else report(tag, value);
  });
  const ifd1 = u32(ifd0End);
  if (ifd1 !== 0) readIfd(ifd1, report);
  follow(gps, report);
  follow(exif, (tag, value) => {
    if (tag === 0xa005) interop = pointer(value);
    else report(tag, value);
  });
  follow(interop, report);
}

/** Whether exif-parser throws casting this date tag: a list of 19 or 25 values, or 19 characters with no space. */
function exifDateThrows(data: Buffer, date: ExifTag | undefined): boolean {
  if (!date || date.type === 0) return false;
  if (date.type !== 2) return date.count === 19 || date.count === 25;
  const text = data.toString("utf8", date.at, date.at + date.count).split("\0")[0]!;
  return text.length === 19 && text[4] === ":" && !text.includes(" ");
}

/** One EXIF value as exif-parser simplifies it: a rational becomes its quotient. */
function exifNumber(data: Buffer, at: number, type: number, little: boolean): number {
  const u32 = (offset: number) => (little ? data.readUInt32LE(offset) : data.readUInt32BE(offset));
  const i32 = (offset: number) => (little ? data.readInt32LE(offset) : data.readInt32BE(offset));
  switch (type) {
    case 1: return data[at]!;
    case 3: case 8: return little ? data.readUInt16LE(at) : data.readUInt16BE(at);
    case 5: return u32(at) / u32(at + 4);
    case 6: return data.readInt8(at);
    case 10: return i32(at) / i32(at + 4);
    case 11: return little ? data.readFloatLE(at) : data.readFloatBE(at);
    case 12: return little ? data.readDoubleLE(at) : data.readDoubleBE(at);
    default: return u32(at);
  }
}

interface TiffReader {
  firstIfd: number;
  /** A SHORT or LONG tag of the IFD at that offset. */
  tag(ifd: number, tag: number): number | undefined;
}

/** A .tif file's structure: its byte order, its first IFD and the tags in it. */
function readTiff(data: Buffer): TiffReader | undefined {
  const order = data.toString("latin1", 0, 2);
  if (data.length < 8 || (order !== "II" && order !== "MM")) return undefined;
  const little = order === "II";
  const u16 = (at: number) => (little ? data.readUInt16LE(at) : data.readUInt16BE(at));
  const u32 = (at: number) => (little ? data.readUInt32LE(at) : data.readUInt32BE(at));
  if (u16(2) !== 42) return undefined;
  return {
    firstIfd: u32(4),
    tag(ifd, tag) {
      const end = ifd + 2 + u16(ifd) * 12;
      for (let entry = ifd + 2; entry < end; entry += 12) {
        if (u16(entry) !== tag) continue;
        const type = u16(entry + 2);
        return type === 3 ? u16(entry + 8) : type === 4 ? u32(entry + 8) : undefined;
      }
      return undefined;
    },
  };
}

/** GIF: the logical screen — with the first frame, which omggif sizes its buffer by, inside it. */
function readGifSize(data: Buffer): ImageSize | undefined {
  const screen = sized(data.readUInt16LE(6), data.readUInt16LE(8));
  if (!screen) return undefined;
  const flags = data[10]!;
  let offset = 13 + (flags & 0x80 ? 3 * 2 ** ((flags & 0x07) + 1) : 0);
  while (offset < data.length) {
    const block = data[offset];
    if (block === 0x2c) {
      const [x, y, width, height] = [1, 3, 5, 7].map((at) => data.readUInt16LE(offset + at)) as [number, number, number, number];
      return x + width <= screen.width && y + height <= screen.height ? screen : undefined;
    }
    // An extension: its label, then sub-blocks up to a zero length. Anything else before a frame
    // (the trailer, garbage) means there is no picture to decode.
    if (block !== 0x21) return undefined;
    offset += 2;
    while (offset < data.length && data[offset] !== 0) offset += data[offset]! + 1;
    offset += 1;
  }
  return undefined;
}

/**
 * Whether Jimp decodes these bytes within the size they declare — asked once that size has been
 * judged (readImageHeaderSize), before the decode that would allocate it.
 *
 * One declaration is not enough for every decoder. pngjs inflates an INTERLACED PNG with no output
 * limit: a 597 KB PNG honestly declaring 320x256 inflated to 600 MB before it failed, so its pixel
 * stream is inflated here first, capped at exactly what that size needs. bmp-js reads 32-bit sides
 * from an OS/2 header, whose sides are 16-bit, and allocates what that misreading says. utif2
 * inflates a TIFF strip with no limit either, and Jimp decodes every page: a TIFF is not decoded.
 *
 * jpeg-js allocates for every component a frame names before it looks at how many there are, and
 * turns only 1 (grey), 3 (colour) or 4 (CMYK, behind Adobe's APP14) into pixels: a 187-byte JPEG
 * honestly declaring 2048x2048 with 20 components held the gateway 836 ms and took RSS to 1 GB
 * before it threw "Unsupported color mode". Never decoded, it never counted against the candidate
 * cap, so every generate_image call in that chat paid it again. And it walks the whole picture once
 * per scan (MAX_JPEG_SCANS). The first refusal loses no JPEG it decodes, the second none an encoder
 * writes.
 */
export function decodesWithinDeclaredSize(bytes: Uint8Array): boolean {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declared = readImageHeaderSize(data);
  if (!declared) return false;
  if (data.readUInt32BE(0) === 0x89504e47) return data[28] !== 1 || interlacedPngFits(data, declared);
  if (data[0] === 0xff && data[1] === 0xd8) {
    const jpeg = readJpegStructure(data);
    return jpeg !== undefined && jpeg.scans <= MAX_JPEG_SCANS
      && (jpeg.components === 1 || jpeg.components === 3 || (jpeg.components === 4 && jpeg.adobe));
  }
  if (data.toString("latin1", 0, 3) === "GIF") return true;
  if (data.toString("latin1", 0, 2) === "BM") return data.readUInt32LE(14) !== 12;
  return false;
}

/** Adam7's seven passes: where each starts, and how far it steps across and down. */
const ADAM7_PASSES = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] as const;
const PNG_CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function interlacedPngFits(data: Buffer, size: ImageSize): boolean {
  const channels = PNG_CHANNELS[data[25]!];
  if (!channels) return false;
  const bitsPerPixel = channels * data[24]!;
  let raw = 0;
  for (const [x, y, stepX, stepY] of ADAM7_PASSES) {
    const width = Math.ceil((size.width - x) / stepX);
    const height = Math.ceil((size.height - y) / stepY);
    // Each row of a pass is its filter byte, then its pixels.
    if (width > 0 && height > 0) raw += height * (1 + Math.ceil((width * bitsPerPixel) / 8));
  }
  const idat: Buffer[] = [];
  for (let offset = 8; offset + 8 <= data.length;) {
    const length = data.readUInt32BE(offset);
    const type = data.toString("latin1", offset + 4, offset + 8);
    if (type === "IEND") break;
    if (type === "IDAT") idat.push(data.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  try {
    inflateSync(Buffer.concat(idat), { maxOutputLength: Math.max(1, raw) });
    return true;
  } catch {
    // Longer than the declared size needs — or no zlib stream at all, which does not decode either.
    return false;
  }
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
 * The sizes a render may ask for: the schema's bounds, a 32-pixel grid, and the one size a
 * fixed-size engine accepts.
 *
 * 32, not 64: Qwen-Image 2.1's own pipeline requires multiples of 32 (VAE factor 16 × patch 2) and
 * picks its sizes on that grid — round(√(area × ratio) / 32) × 32 gives 1376x768 for 16:9 at 1 MP,
 * which a 64 grid cannot express. Rendered live at exactly 1376x768 on 2026-09-27.
 */
export const IMAGE_SIZE_BOUNDS = { min: 256, max: 2048, step: 32, fixed: OPENAI_IMAGE_SIZE } as const;

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
 * Until when a model's device is still working on a render WE abandoned, by gate key.
 *
 * The slot is released when our request times out, but the engine does not stop: it finishes the
 * abandoned picture first. In session 807684e9 the retry took the free slot, went straight into
 * the backend's own queue with its clock already running, and timed out behind the render nobody
 * was waiting for. So a timeout marks the device busy for the abandoned render's expected time
 * (capped by its timeout), and the next request waits that out inside its slot, before its own
 * clock starts. A finished render is the proof the device is free again and clears the mark.
 */
const deviceBusyUntil = new Map<string, number>();

/** Test-only: forget the renders abandoned so far, so one test's timeout does not delay the next. */
export function resetImageDeviceBusyForTests(): void {
  deviceBusyUntil.clear();
}

/**
 * How much longer a tier's device is busy with a render we abandoned, in ms; 0 when it is free.
 * The settings step adds it to the time it shows, because the next render waits it out first.
 */
export function imageDeviceBusyMs(config: ImageGenerationBackendConfig, tier: ImageGenerationTier, model?: string): number {
  const gateKey = renderGateKey(resolveTierBackend(config, tier), tier, model);
  return gateKey ? Math.max(0, (deviceBusyUntil.get(gateKey) ?? 0) - Date.now()) : 0;
}

/** The key each adapter holds its slot and busy mark under; ComfyUI queues on its own and has none. */
function renderGateKey(effective: ImageGenerationBackendConfig, tier: ImageGenerationTier, model?: string): string | undefined {
  if (effective.api === "comfyui") return undefined;
  if (effective.api === "openai-compatible") return model ?? engineModelForTier(effective, tier);
  return model ?? effective.model ?? effective.baseUrl;
}

/** One render with its model's slot held: waits out an abandoned render first, then runs. */
function renderInSlot(
  config: ImageGenerationBackendConfig,
  gateKey: string,
  budget: RenderBudget,
  work: () => Promise<ImageGenerationResult>,
): Promise<ImageGenerationResult> {
  const gate = imageGates.for(gateKey);
  gate.setLimit(concurrencyForModel(config, gateKey));
  return gate.withSlot(async () => {
    const busyFor = (deviceBusyUntil.get(gateKey) ?? 0) - Date.now();
    if (busyFor > 0) await delay(busyFor);
    try {
      const result = await work();
      deviceBusyUntil.delete(gateKey);
      return busyFor > 0 ? { ...result, deviceWaitMs: busyFor } : result;
    } catch (error) {
      if (error instanceof ServerRenderTimeoutError) {
        // The server stopped waiting; the engine did not stop rendering. It is busy for what the
        // render has left — at least a minute, since one that overran its estimate is still going.
        const expectedMs = budget.expectedSeconds * 1000;
        const left = Math.max(expectedMs - error.elapsedMs, Math.min(SERVER_CUT_MIN_BUSY_MS, expectedMs));
        deviceBusyUntil.set(gateKey, Date.now() + left);
        throw budget.cutByServer(error.elapsedMs, error.message);
      }
      if (!(error instanceof UpstreamTimeoutError)) throw error;
      deviceBusyUntil.set(gateKey, Date.now() + Math.min(budget.expectedSeconds * 1000, budget.timeoutMs));
      throw budget.timedOut();
    }
  });
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
  budget: RenderBudget,
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
    // The endpoint's behaviour on unknown names has flipped twice. 2026-09-22 it silently dropped
    // them (`__definitely_not_real__` and the near-miss `mask_image` both returned 200 and a
    // picture). Re-measured 2026-09-26 it REJECTS them by name with HTTP 400 and lists what it
    // takes: guidance_scale, image, mask, mask_blur, model, n, negative_prompt, output_format,
    // prompt, response_format, seed, size, steps, strength, user. Send only those; a sampler,
    // scheduler or flow shift has no field here at all (see stripEngineArgs for the one way
    // around that, which is closed). `mask` is also validated and rejected with param "mask"
    // when it selects nothing, selects everything, or is not an image.
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

  // Below this line the request is valid and the only thing left is the backend. Everything
  // that can be rejected locally — an unset quality model, a size this endpoint refuses —
  // has already thrown, so a config mistake still fails in milliseconds rather than after
  // waiting out someone else's generation.
  return renderInSlot(config, model, budget,
    () => sendOpenAiImageRequest(config, input, model, payload, budget.timeoutMs),
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
      const message = await extractUpstreamError(response, `Image generation failed (${model})`);
      const elapsedMs = Date.now() - startedAt;
      if (isServerRenderTimeout(response.status, message, elapsedMs)) throw new ServerRenderTimeoutError(message, elapsedMs);
      throw new Error(message);
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
  budget: RenderBudget,
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
  return renderInSlot(config, gateKey, budget, () => sendAutomatic1111Request(config, input, model, payload, budget.timeoutMs));
}

/** The network half, run with a slot held. */
async function sendAutomatic1111Request(
  config: ImageGenerationBackendConfig,
  input: ResolvedImageRequest,
  model: string | undefined,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<ImageGenerationResult> {
  const startedAt = Date.now();
  const response = await fetchWithTimeout(
    upstreamUrl(config.baseUrl, input.initImage ? "/sdapi/v1/img2img" : "/sdapi/v1/txt2img"),
    {
      method: "POST",
      headers: upstreamHeaders(config.apiKey, { "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    },
    timeoutMs,
  );

  if (!response.ok) {
    const message = await extractUpstreamError(response, "Image generation failed");
    const elapsedMs = Date.now() - startedAt;
    if (isServerRenderTimeout(response.status, message, elapsedMs)) throw new ServerRenderTimeoutError(message, elapsedMs);
    throw new Error(message);
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
  budget: RenderBudget,
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

  // The request's own budget, not the tier's flat one: the render is what the deadline bounds.
  const deadline = Date.now() + budget.timeoutMs;
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

  throw budget.timedOut();
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

/**
 * OUR timer ran out, as opposed to the connection failing. Told apart because the two mean
 * different things to the caller: "This operation was aborted" was all session 807684e9 heard of
 * a render that simply needed longer than its budget, and it retried the same settings.
 */
/**
 * The image server (or a proxy in front of it) gave up waiting for the render and answered with a
 * gateway timeout. llama-swap words it `HTTP 502 … peer proxy error: net/http: timeout awaiting
 * response headers`: its peer transport has a response-header limit, and the image engine sends no
 * headers until the picture is done — so every render longer than that limit is cut at exactly it
 * (600 s on the cluster this was written for, twice in session fa673f2c), while the engine renders on.
 */
class ServerRenderTimeoutError extends Error {
  constructor(message: string, readonly elapsedMs: number) {
    super(message);
    this.name = "ServerRenderTimeoutError";
  }
}

/**
 * A 504, or a 502 that says it timed out, after the render had been running a while: the server's
 * own limit ended the wait. One that answers at once never had a render to cut — the proxy could
 * not reach its upstream — and stays an ordinary failure, with no device marked busy.
 */
function isServerRenderTimeout(status: number, message: string, elapsedMs: number): boolean {
  if (elapsedMs < SERVER_CUT_MIN_ELAPSED_MS) return false;
  return status === 504 || (status === 502 && /\btime(?:d)?\s?out\b/i.test(message));
}

/** Shorter than any server limit a render could meet (llama-swap's was 60 s at its lowest). */
const SERVER_CUT_MIN_ELAPSED_MS = 30_000;

/** However short the rest looks, the engine is still on the render for this long, or its whole expected time if shorter. */
const SERVER_CUT_MIN_BUSY_MS = 60_000;

class UpstreamTimeoutError extends Error {
  constructor(readonly url: string, readonly timeoutMs: number) {
    super(`Request to ${url} timed out after ${Math.round(timeoutMs / 1000)} s`);
    this.name = "UpstreamTimeoutError";
  }
}

/**
 * The transport under every image request, with undici's own timeouts OFF: this module's timer
 * (imageRequestTimeoutMs, scaled to the render) is the only fuse. Node's fetch is undici, which
 * gives up on a response whose headers have not arrived after 300 s — and an image endpoint sends
 * its headers only when the picture is done. So every quality render longer than five minutes died
 * at exactly 300 s whatever budget it had been given: session 9cc3f362 rendered 47 and then 50
 * steps at 1344x768 (budget ~11 min), and both failed at 300.0 s as "fetch failed", which the tool
 * then reported as the service being offline. The chat provider zeroed the same default for the
 * same reason (providers/lmstudio.ts, providerDispatcher).
 */
export const IMAGE_TRANSPORT_OPTIONS = { headersTimeout: 0, bodyTimeout: 0, keepAliveTimeout: 60_000 } as const;
const imageDispatcher = new UndiciAgent(IMAGE_TRANSPORT_OPTIONS);

/** Connection-level failure codes: the endpoint could not be reached at all. */
const UNREACHABLE_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);

/** A request that failed below HTTP, with the transport's own code kept for the caller to judge. */
export class ImageUpstreamRequestError extends Error {
  constructor(message: string, readonly code: string | undefined) {
    super(message);
    this.name = "ImageUpstreamRequestError";
  }

  /** The endpoint could not be reached at all — not a request that started and then failed. */
  get unreachable(): boolean {
    return this.code !== undefined && UNREACHABLE_CODES.has(this.code);
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal, dispatcher: imageDispatcher } as RequestInit);
  } catch (error) {
    if (timedOut) throw new UpstreamTimeoutError(url, timeoutMs);
    // "fetch failed" alone says nothing; the cause says whether the endpoint was unreachable or the
    // request died on the way, and only the first is "offline".
    const cause = (error as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
    const code = typeof cause?.code === "string" ? cause.code : undefined;
    const detail = error instanceof Error ? error.message : String(error);
    const causeText = code ? ` (${code}${typeof cause?.message === "string" && cause.message ? `: ${cause.message}` : ""})` : "";
    throw new ImageUpstreamRequestError(`Request to ${url} failed: ${detail}${causeText}`, code);
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