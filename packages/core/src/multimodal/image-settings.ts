/**
 * The settings step of generate_image: what the person is shown before a render, how their answer
 * is checked, and how it becomes the request that runs.
 *
 * The agent picks engine, prompt, size, steps and base picture from a sentence, and the person only
 * saw the result — two minutes of GPU later, on an engine they may not have wanted, with no way to
 * say "keep everything but the sky". So before each render in an interactive turn the tool offers
 * what it is about to run, and the person takes it (Auto), changes it (Configure, where they can
 * also pick an earlier picture as the base and paint the region that may change) or skips it.
 *
 * Everything the client sends is untrusted: engine names, sizes and bounds are checked against the
 * configuration, a base picture is named by an id this module handed out (never a path), and a
 * painted mask is decoded and measured before it goes anywhere near the backend.
 */
import { basename } from "node:path";
import Jimp from "jimp";
import { checkInput } from "../guardrails/input.js";
import type { UserInputFieldError, UserInputValidation } from "../agent/user-input.js";
import {
  DEFAULT_EDIT_STRENGTH,
  IMAGE_MASK_BLUR_BOUNDS,
  IMAGE_SIZE_BOUNDS,
  IMAGE_STEPS_BOUNDS,
  decodesWithinDeclaredSize,
  describeRenderDuration,
  expectedImageRenderSeconds,
  fitsImageSizeBounds,
  imageDeviceBusyMs,
  imageEngineLabel,
  imageRenderLimitSeconds,
  imageRenderOverLimit,
  imageTierChoices,
  imageTierDefaults,
  negativePromptHasNoEffect,
  previewImageRequest,
  readImageHeaderSize,
  type ImageGenerationBackendConfig,
  type ImageGenerationRequest,
  type ImageGenerationTier,
} from "./image-generation.js";

export const IMAGE_SETTINGS_KIND = "image_settings";

/** What the form may offer, and what an answer is held to. */
export const IMAGE_SETTINGS_BOUNDS = {
  size: { ...IMAGE_SIZE_BOUNDS },
  steps: [IMAGE_STEPS_BOUNDS.min, IMAGE_STEPS_BOUNDS.max],
  guidance: [0, 20],
  seed: [0, 4_294_967_295],
  strength: [0.05, 1],
  maskBlur: [IMAGE_MASK_BLUR_BOUNDS.min, IMAGE_MASK_BLUR_BOUNDS.max],
  promptMax: 4000,
  negativeMax: 2000,
} as const;

/** A painted mask larger than this is not a mask anyone painted by hand. */
export const MAX_MASK_BYTES = 8 * 1024 * 1024;

/** The answer carries the mask as base64 inside JSON, a third larger than its bytes. */
export const IMAGE_SETTINGS_MAX_ANSWER_BYTES = 12 * 1024 * 1024;

const THUMB_SIDE = 160;

/** The largest agent mask worth decoding for the painter: a 24 MP camera frame. */
const MAX_AGENT_MASK_PIXELS = 25_000_000;

export type BaseCandidateSource = "agent" | "latest_image" | "shared_fact" | "attachment";

/** A picture the form offers as the base of an edit. Its bytes and path never leave the server. */
export interface BaseCandidate {
  id: string;
  label: string;
  source: BaseCandidateSource;
  relativePath: string;
  bytes: Buffer;
  mime: string;
  /** 0 when the header named no size the server can read. */
  width: number;
  height: number;
  /**
   * Whether an edit can render at this picture's own size. Only the agent's own base is ever
   * offered without it: an edit of that one renders at the size the agent's request resolved to,
   * exactly as Auto would.
   */
  fitsBounds: boolean;
  /** "" when the picture could not be decoded for a thumbnail. */
  thumbDataUrl: string;
}

/** The agent's own mask, shown to the painter as its starting point. */
export interface AgentMask {
  relativePath: string;
  width: number;
  height: number;
  previewDataUrl: string;
  /** It is `latest_mask`: the region the user painted for an earlier render, passed again by the agent. */
  paintedEarlier?: boolean;
}

export interface ImageSettingsEngine {
  tier: ImageGenerationTier;
  model: string;
  label?: string;
  fixedSize: boolean;
  canEdit: boolean;
  /** What the engine renders with when nothing is set. */
  defaults: { width: number; height: number; steps: number; guidanceScale: number; negativePrompt?: string };
  /**
   * The expected time AT `defaults`, derived from the tier's measured reference render; the form
   * scales it from `defaults` to other settings, mirroring imageRenderWork.
   */
  expectedSeconds: number;
  /**
   * Set while the engine still finishes a render abandoned at its timeout: the next render waits
   * that out before it starts, minutes on the quality engine, and the time shown includes it.
   */
  busySeconds?: number;
}

/** What runs if the person takes the agent's settings. */
export interface ImageSettingsAgentView {
  prompt: string;
  negativePrompt?: string;
  tier: ImageGenerationTier;
  width: number;
  height: number;
  steps: number;
  guidanceScale: number;
  seed?: number;
  baseCandidateId?: string;
  strength?: number;
  maskBlur?: number;
  hasMask: boolean;
}

export interface ImageSettingsProposal {
  mode: "generate" | "edit";
  agent: ImageSettingsAgentView;
  engines: ImageSettingsEngine[];
  bounds: typeof IMAGE_SETTINGS_BOUNDS;
  baseCandidates: Array<Pick<BaseCandidate, "id" | "label" | "source" | "width" | "height" | "fitsBounds" | "thumbDataUrl">>;
  agentMask?: { width: number; height: number; previewDataUrl: string; paintedEarlier?: boolean };
  /**
   * The image server's own limit, where one is configured: `serverSeconds` is when it gives up on a
   * render, `allowedSeconds` the longest a render may be expected to take (imageRenderLimitSeconds).
   * The form stops settings that would run past it; they are refused here as well.
   */
  renderLimit?: { allowedSeconds: number; serverSeconds: number };
}

/** The settings the person chose, checked. */
export interface ChosenImageSettings {
  tier: ImageGenerationTier;
  prompt: string;
  /** "" means none. */
  negativePrompt: string;
  width: number;
  height: number;
  steps: number;
  guidanceScale: number;
  seed: number | null;
  edit: null | {
    base: BaseCandidate;
    strength: number;
    /** A mask the person painted: PNG bytes, and the share of the picture it lets change. */
    mask?: { bytes: Buffer; coverage: number };
    keepAgentMask: boolean;
    maskBlur?: number;
  };
}

export interface ImageSettingsDecision {
  choice: "auto" | "configure" | "skip";
  /** "Always Auto in this chat" was ticked. */
  alwaysAuto: boolean;
  settings?: ChosenImageSettings;
}

/** Who decided the settings that ran — metadata.settings.source. */
export type ImageSettingsSource =
  | "user"
  | "auto"
  | "timeout"
  | "session_preference"
  | "no_channel"
  | "disconnected_expired"
  /** Nothing ran: the person chose Skip. Carried on the failed result so a skip is not read as a failure. */
  | "user_skipped";

// ── Candidates ─────────────────────────────────────────────────────────────────────────────────

/** A picture that might be offered, in the order it was found. */
export interface CandidateSourceEntry {
  relativePath: string;
  source: BaseCandidateSource;
  read(): Promise<Uint8Array>;
}

/**
 * Read, decode and thumbnail the pictures that may serve as a base, in the order given (the agent's
 * own first, then newest first), keeping the first `max` that decode and fit the size bounds. A
 * picture that cannot be read or decoded is skipped: the form must not offer what an edit could not
 * use. So is one outside the size bounds, because an edit renders at its base's size — judged from
 * the size its header declares, before anything is decoded (see readImageHeaderSize) — and one the
 * decoder would not keep to that size (a TIFF, an interlaced PNG that inflates past it; see
 * decodesWithinDeclaredSize).
 *
 * The AGENT'S OWN BASE is the exception, and is offered whatever `max` says: without a thumbnail
 * when it does not decode (a WebP, a HEIC), and with `fitsBounds: false` when it is too large to
 * edit at its own size (a 4032x3024 phone photo). Leaving it out made Configure start from "None —
 * new picture", so changing only the steps turned the agent's edit into an unrelated new picture,
 * and the agent was told the person had chosen that.
 */
export async function collectBaseCandidates(entries: CandidateSourceEntry[], max: number): Promise<BaseCandidate[]> {
  const candidates: BaseCandidate[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const agentBase = entry.source === "agent";
    if (!agentBase && candidates.length >= max) break;
    const key = entry.relativePath.replace(/\\/g, "/");
    if (seen.has(key)) continue;
    seen.add(key);
    let bytes: Buffer;
    try {
      bytes = Buffer.from(await entry.read());
    } catch {
      continue;
    }
    const declared = readImageHeaderSize(bytes);
    const declaredFits = Boolean(declared && fitsImageSizeBounds(declared));
    if (!declaredFits && !agentBase) continue;
    const decoded = declaredFits ? await decodeForThumbnail(bytes) : undefined;
    const fitsBounds = decoded ? fitsImageSizeBounds(decoded) : declaredFits;
    if (!agentBase && (!decoded || !fitsBounds)) continue;
    candidates.push({
      id: `c${candidates.length + 1}`,
      label: basename(key),
      source: entry.source,
      relativePath: key,
      bytes,
      mime: decoded?.mime ?? mimeOfPath(key),
      width: decoded?.width ?? declared?.width ?? 0,
      height: decoded?.height ?? declared?.height ?? 0,
      fitsBounds,
      thumbDataUrl: decoded?.thumbDataUrl ?? "",
    });
  }
  return candidates;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".bmp": "image/bmp", ".webp": "image/webp", ".heic": "image/heic", ".avif": "image/avif",
  ".tif": "image/tiff", ".tiff": "image/tiff",
};

/** For a picture that did not decode: its preview is still served, typed by its name. */
function mimeOfPath(path: string): string {
  const dot = path.lastIndexOf(".");
  return (dot >= 0 ? MIME_BY_EXTENSION[path.slice(dot).toLowerCase()] : undefined) ?? "application/octet-stream";
}

/**
 * Jimp.read, for a picture whose declared size was judged already — and only where the decoder
 * stays inside that size (see decodesWithinDeclaredSize); undefined for anything else, and for
 * what does not decode.
 */
async function decodeWithinDeclaredSize(bytes: Buffer): Promise<Jimp | undefined> {
  if (!decodesWithinDeclaredSize(bytes)) return undefined;
  return Jimp.read(bytes).catch(() => undefined);
}

async function decodeForThumbnail(bytes: Buffer): Promise<{ width: number; height: number; mime: string; thumbDataUrl: string } | undefined> {
  try {
    const image = await decodeWithinDeclaredSize(bytes);
    if (!image) return undefined;
    const { width, height } = image.bitmap;
    const thumb = await image.clone().scaleToFit(THUMB_SIDE, THUMB_SIDE).quality(72).getBufferAsync(Jimp.MIME_JPEG);
    return { width, height, mime: image.getMIME(), thumbDataUrl: `data:image/jpeg;base64,${thumb.toString("base64")}` };
  } catch {
    return undefined;
  }
}

/** The agent's mask as the painter starts from it: its alpha only, so the preview is small. */
export async function describeAgentMask(bytes: Uint8Array, relativePath: string): Promise<AgentMask | undefined> {
  // Its declared size is judged before the decode, which allocates whatever that is (see
  // readImageHeaderSize). Generous, because it matches the agent's base and a phone photo is 12 MP.
  const declared = readImageHeaderSize(bytes);
  if (!declared || declared.width * declared.height > MAX_AGENT_MASK_PIXELS) return undefined;
  try {
    const image = await decodeWithinDeclaredSize(Buffer.from(bytes));
    if (!image) return undefined;
    const data = image.bitmap.data;
    for (let index = 0; index < data.length; index += 4) {
      data[index] = 0;
      data[index + 1] = 0;
      data[index + 2] = 0;
    }
    const png = await image.getBufferAsync(Jimp.MIME_PNG);
    return {
      relativePath,
      width: image.bitmap.width,
      height: image.bitmap.height,
      previewDataUrl: `data:image/png;base64,${png.toString("base64")}`,
    };
  } catch {
    return undefined;
  }
}

// ── Proposal ───────────────────────────────────────────────────────────────────────────────────

/** The engines as the form lists them, each with the defaults it would render with. */
export function imageSettingsEngines(config: ImageGenerationBackendConfig): ImageSettingsEngine[] {
  const choices = imageTierChoices(config);
  // A deployment that names no model still renders, on whatever the backend defaults to.
  const listed = choices.length > 0 ? choices : [{ tier: "fast" as const, model: "" }];
  return listed.map((choice) => {
    const defaults = imageTierDefaults(config, choice.tier);
    const label = "label" in choice ? choice.label : undefined;
    const busySeconds = Math.ceil(imageDeviceBusyMs(config, choice.tier) / 1000);
    return {
      tier: choice.tier,
      model: choice.model,
      ...(label ? { label } : {}),
      fixedSize: Boolean(choice.model) && (config.fixedSizeModels?.includes(choice.model) ?? false),
      canEdit: Boolean(choice.model) && (config.initImageModels?.includes(choice.model) ?? false),
      // The size is sent with the steps and guidance because the form scales the time by all of
      // them: 57 steps at 1344x768 is ~8 minutes on the quality engine, not "~3 min".
      defaults: {
        width: defaults.width,
        height: defaults.height,
        steps: defaults.steps,
        guidanceScale: defaults.guidanceScale,
        ...(defaults.negativePrompt ? { negativePrompt: defaults.negativePrompt } : {}),
      },
      // At the defaults, not the reference: the form scales from `defaults`, so a quality default
      // of 40 steps must arrive as ~340 s, or its "~3 min" would be half the real time.
      expectedSeconds: Math.round(expectedImageRenderSeconds(config, { tier: choice.tier, ...defaults })),
      ...(busySeconds > 0 ? { busySeconds } : {}),
    };
  });
}

/** The proposal's `renderLimit`, or nothing where the image server has no limit configured. */
function renderLimitOf(config: ImageGenerationBackendConfig): Pick<ImageSettingsProposal, "renderLimit"> {
  const allowedSeconds = imageRenderLimitSeconds(config);
  return config.maxRenderMs && allowedSeconds !== undefined
    ? { renderLimit: { allowedSeconds: Math.floor(allowedSeconds), serverSeconds: Math.round(config.maxRenderMs / 1000) } }
    : {};
}

/**
 * What the form shows. `agent` is resolved through previewImageRequest — the resolution the render
 * itself applies — so Auto runs exactly what the form said it would.
 */
export function buildImageSettingsProposal(
  config: ImageGenerationBackendConfig,
  agentRequest: ImageGenerationRequest,
  candidates: BaseCandidate[],
  agentMask?: AgentMask,
): ImageSettingsProposal {
  const agentBase = agentRequest.initImage ? candidates.find((candidate) => candidate.source === "agent") : undefined;
  const resolved = previewImageRequest(
    config,
    agentRequest,
    agentBase ? { width: agentBase.width, height: agentBase.height } : undefined,
  );
  return {
    mode: agentRequest.initImage ? "edit" : "generate",
    agent: {
      prompt: agentRequest.prompt,
      ...(resolved.negativePrompt ? { negativePrompt: resolved.negativePrompt } : {}),
      tier: resolved.tier,
      width: resolved.width,
      height: resolved.height,
      steps: resolved.steps,
      guidanceScale: resolved.guidanceScale,
      ...(typeof agentRequest.seed === "number" ? { seed: agentRequest.seed } : {}),
      ...(agentBase ? { baseCandidateId: agentBase.id } : {}),
      ...(agentRequest.initImage ? { strength: agentRequest.strength ?? DEFAULT_EDIT_STRENGTH } : {}),
      ...(typeof agentRequest.maskBlur === "number" ? { maskBlur: agentRequest.maskBlur } : {}),
      hasMask: Boolean(agentRequest.mask),
    },
    engines: imageSettingsEngines(config),
    bounds: IMAGE_SETTINGS_BOUNDS,
    ...renderLimitOf(config),
    baseCandidates: candidates.map(({ id, label, source, width, height, fitsBounds, thumbDataUrl }) => ({ id, label, source, width, height, fitsBounds, thumbDataUrl })),
    ...(agentMask
      ? {
          agentMask: {
            width: agentMask.width,
            height: agentMask.height,
            previewDataUrl: agentMask.previewDataUrl,
            ...(agentMask.paintedEarlier ? { paintedEarlier: true } : {}),
          },
        }
      : {}),
  };
}

// ── Validation ─────────────────────────────────────────────────────────────────────────────────

export interface ImageSettingsValidationContext {
  config: ImageGenerationBackendConfig;
  proposal: ImageSettingsProposal;
  candidates: BaseCandidate[];
  agentMask?: AgentMask;
  /** The input guardrail; the prompts become the words a model reads. */
  checkText?: (text: string) => { allowed: boolean; reason?: string };
}

const PNG_DATA_URL_PREFIX = "data:image/png;base64,";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Check an answer field by field. Every problem is reported at once, against the field it belongs
 * to, and any problem keeps the request open so the person can correct it. Nothing is repaired: a
 * tier that cannot edit is refused rather than upgraded, because the person chose it.
 */
export async function validateImageSettingsAnswer(
  raw: unknown,
  context: ImageSettingsValidationContext,
): Promise<UserInputValidation<ImageSettingsDecision>> {
  if (!isRecord(raw)) return { ok: false, errors: [{ field: "answer", message: "must be an object" }] };
  const errors: UserInputFieldError[] = [];
  const choice = raw["choice"];
  if (choice !== "auto" && choice !== "configure" && choice !== "skip") {
    errors.push({ field: "choice", message: "must be auto, configure or skip" });
  }
  const alwaysAutoRaw = raw["alwaysAuto"];
  if (alwaysAutoRaw !== undefined && typeof alwaysAutoRaw !== "boolean") {
    errors.push({ field: "alwaysAuto", message: "must be true or false" });
  }
  if (errors.length > 0) return { ok: false, errors };
  const alwaysAuto = alwaysAutoRaw === true;
  const later = alwaysAuto ? "; Auto from now on in this chat" : "";

  if (choice === "auto") return { ok: true, outcome: "auto", value: { choice, alwaysAuto }, summary: `Auto${later}` };
  if (choice === "skip") return { ok: true, outcome: "cancelled", value: { choice, alwaysAuto }, summary: `skipped this render${later}` };

  const settings = await checkSettings(raw["settings"], context, errors);
  if (!settings || errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { choice: "configure", alwaysAuto, settings },
    summary: `${describeSettingsChange(context.proposal, settings).summary}${later}`,
  };
}

async function checkSettings(
  raw: unknown,
  context: ImageSettingsValidationContext,
  errors: UserInputFieldError[],
): Promise<ChosenImageSettings | undefined> {
  if (!isRecord(raw)) {
    errors.push({ field: "settings", message: "required with configure" });
    return undefined;
  }
  const { proposal } = context;
  const bounds = IMAGE_SETTINGS_BOUNDS;
  const checkText = context.checkText ?? ((text: string) => checkInput(text));
  const fail = (field: string, message: string): undefined => {
    errors.push({ field: `settings.${field}`, message });
    return undefined;
  };

  const engine = proposal.engines.find((candidate) => candidate.tier === raw["tier"]);
  if (!engine) fail("tier", `must be one of: ${proposal.engines.map((candidate) => candidate.tier).join(", ")}`);

  const prompt = typeof raw["prompt"] === "string" ? raw["prompt"].trim() : undefined;
  if (prompt === undefined) fail("prompt", "must be text");
  else if (!prompt) fail("prompt", "must not be empty");
  else if (prompt.length > bounds.promptMax) fail("prompt", `at most ${bounds.promptMax} characters`);
  else {
    const verdict = checkText(prompt);
    if (!verdict.allowed) fail("prompt", verdict.reason ?? "rejected by the input guardrail");
  }

  const negativeRaw = raw["negativePrompt"] ?? "";
  const negativePrompt = typeof negativeRaw === "string" ? negativeRaw.trim() : undefined;
  if (negativePrompt === undefined) fail("negativePrompt", "must be text");
  else if (negativePrompt.length > bounds.negativeMax) fail("negativePrompt", `at most ${bounds.negativeMax} characters`);
  else if (negativePrompt) {
    const verdict = checkText(negativePrompt);
    if (!verdict.allowed) fail("negativePrompt", verdict.reason ?? "rejected by the input guardrail");
  }

  const steps = integerIn(raw["steps"], bounds.steps[0], bounds.steps[1]) ?? fail("steps", `a whole number from ${bounds.steps[0]} to ${bounds.steps[1]}`);
  const guidanceScale = numberIn(raw["guidanceScale"], bounds.guidance[0], bounds.guidance[1])
    ?? fail("guidanceScale", `a number from ${bounds.guidance[0]} to ${bounds.guidance[1]}`);
  let seed: number | null = null;
  if (raw["seed"] !== null && raw["seed"] !== undefined) {
    seed = integerIn(raw["seed"], bounds.seed[0], bounds.seed[1]) ?? null;
    if (seed === null) fail("seed", `empty for random, or a whole number from ${bounds.seed[0]} to ${bounds.seed[1]}`);
  }

  const edit = await checkEdit(raw["edit"], engine, context, errors);

  const width = raw["width"];
  const height = raw["height"];
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    fail("width", "width and height must be whole numbers");
  } else if (edit) {
    // An edit renders at its base's size; any other size stretches the picture and moves the mask.
    // The agent's base can be too large for that, and then renders at the size its request
    // resolved to — what Auto runs — so that is the one size the form may send for it.
    const size = edit.base.fitsBounds ? edit.base : context.proposal.agent;
    if (width !== size.width || height !== size.height) {
      fail("width", edit.base.fitsBounds
        ? `must be ${size.width}x${size.height}, the size of the base picture`
        : `must be ${size.width}x${size.height}; the base picture is too large to edit at its own size`);
    }
  } else if (edit === null) {
    // (An invalid edit block has its own errors; the size is judged once the base is known.)
    if (engine?.fixedSize && (width !== bounds.size.fixed || height !== bounds.size.fixed)) {
      fail("width", `${engine.label ?? engine.tier} renders ${bounds.size.fixed}x${bounds.size.fixed} only`);
    } else if (!engine?.fixedSize) {
      for (const [field, side] of [["width", width as number], ["height", height as number]] as const) {
        if (side < bounds.size.min || side > bounds.size.max || side % bounds.size.step !== 0) {
          fail(field, `from ${bounds.size.min} to ${bounds.size.max} in steps of ${bounds.size.step}`);
        }
      }
    }
  }

  if (errors.length > 0 || !engine || prompt === undefined || negativePrompt === undefined
    || steps === undefined || guidanceScale === undefined || edit === undefined) {
    return undefined;
  }
  // Settings the image server would cut off are the person's to change, like any other bad field:
  // said against the steps, with what would fit, and the question stays open.
  const over = imageRenderOverLimit(context.config, {
    tier: engine.tier, width: width as number, height: height as number, steps, guidanceScale,
  });
  if (over) {
    return fail("steps", `about ${describeRenderDuration(over.expectedSeconds)}, and the image server stops any render`
      + ` after ${describeRenderDuration(over.serverSeconds)}. ${over.advice}`);
  }
  return {
    tier: engine.tier,
    prompt,
    negativePrompt,
    width: width as number,
    height: height as number,
    steps,
    guidanceScale,
    seed,
    edit,
  };
}

/** `undefined` when the edit block is invalid (errors pushed), `null` for a new picture. */
async function checkEdit(
  raw: unknown,
  engine: ImageSettingsEngine | undefined,
  context: ImageSettingsValidationContext,
  errors: UserInputFieldError[],
): Promise<ChosenImageSettings["edit"] | undefined> {
  if (raw === null || raw === undefined) return null;
  const fail = (field: string, message: string): undefined => {
    errors.push({ field: `settings.edit${field ? `.${field}` : ""}`, message });
    return undefined;
  };
  if (!isRecord(raw)) return fail("", "must be an object, or null for a new picture");
  const before = errors.length;

  if (engine && !engine.canEdit) {
    // Refused, not upgraded: the person picked this engine, and a quiet switch to the slow one
    // is the same wrong-engine outcome with nobody told.
    const editors = context.proposal.engines.filter((candidate) => candidate.canEdit).map((candidate) => candidate.label ?? candidate.tier);
    errors.push({
      field: "settings.tier",
      message: editors.length > 0
        ? `${engine.label ?? engine.tier} cannot edit a picture; choose ${editors.join(" or ")}, or render without a base`
        : "no engine here can edit a picture; render without a base",
    });
  }

  const base = context.candidates.find((candidate) => candidate.id === raw["baseCandidateId"]);
  if (!base) fail("baseCandidateId", "not one of the offered pictures");

  const bounds = IMAGE_SETTINGS_BOUNDS;
  const strength = numberIn(raw["strength"], bounds.strength[0], bounds.strength[1])
    ?? fail("strength", `a number from ${bounds.strength[0]} to ${bounds.strength[1]}`);
  let maskBlur: number | undefined;
  if (raw["maskBlur"] !== undefined && raw["maskBlur"] !== null) {
    maskBlur = integerIn(raw["maskBlur"], bounds.maskBlur[0], bounds.maskBlur[1])
      ?? fail("maskBlur", `a whole number from ${bounds.maskBlur[0]} to ${bounds.maskBlur[1]}`);
  }

  const keepRaw = raw["keepAgentMask"];
  if (keepRaw !== undefined && typeof keepRaw !== "boolean") fail("keepAgentMask", "must be true or false");
  const keepAgentMask = keepRaw === true;
  if (keepAgentMask && (!context.agentMask || base?.source !== "agent")) {
    // The agent's mask was drawn for the agent's picture; on any other base it selects nothing in particular.
    fail("keepAgentMask", "only with the agent's own picture and mask");
  }

  let mask: { bytes: Buffer; coverage: number } | undefined;
  const maskRaw = raw["maskDataUrl"];
  if (maskRaw !== undefined && maskRaw !== null) {
    if (keepAgentMask) fail("maskDataUrl", "paint a new mask or keep the agent's, not both");
    else if (typeof maskRaw !== "string") fail("maskDataUrl", "must be a PNG data URL");
    // A mask is painted at the base's own size, and this base does not render at it.
    else if (base && !base.fitsBounds) fail("maskDataUrl", "this picture is too large to paint a mask on; render without one");
    else if (base) mask = await checkMask(maskRaw, base, fail);
  }

  if (errors.length > before || !base || strength === undefined) return undefined;
  return {
    base,
    strength,
    ...(mask ? { mask } : {}),
    keepAgentMask,
    ...(maskBlur !== undefined ? { maskBlur } : {}),
  };
}

/**
 * A painted mask: a PNG with an alpha channel, the base's exact size, selecting something and not
 * everything. The backend rejects the last two as well, but only after the render slot was
 * waited for; a wrong size it may not reject at all.
 */
async function checkMask(
  dataUrl: string,
  base: BaseCandidate,
  fail: (field: string, message: string) => undefined,
): Promise<{ bytes: Buffer; coverage: number } | undefined> {
  if (!dataUrl.startsWith(PNG_DATA_URL_PREFIX)) return fail("maskDataUrl", "must be a PNG data URL");
  const bytes = Buffer.from(dataUrl.slice(PNG_DATA_URL_PREFIX.length), "base64");
  if (bytes.length > MAX_MASK_BYTES) return fail("maskDataUrl", `larger than ${MAX_MASK_BYTES / (1024 * 1024)} MB`);
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return fail("maskDataUrl", "not a PNG");
  // The size its header DECLARES is judged before the decode, which allocates whatever that is and
  // blocks the gateway while it does: a 1.5 MB PNG declaring 20000x20000 held the event loop for 3 s
  // and took RSS to ~5 GB before being refused as the wrong size.
  const declared = readImageHeaderSize(bytes);
  if (!declared) return fail("maskDataUrl", "does not decode as a PNG");
  if (declared.width !== base.width || declared.height !== base.height) {
    return fail("maskDataUrl", `is ${declared.width}x${declared.height}; it must be ${base.width}x${base.height}, the size of the base picture`);
  }
  if (!pngHasAlphaChannel(bytes)) return fail("maskDataUrl", "has no transparency; the transparent region is what may change");
  const image = await decodeWithinDeclaredSize(bytes);
  if (!image) return fail("maskDataUrl", "does not decode as a PNG");
  const { width, height, data } = image.bitmap;
  if (width !== base.width || height !== base.height) {
    return fail("maskDataUrl", `is ${width}x${height}; it must be ${base.width}x${base.height}, the size of the base picture`);
  }
  let transparent = 0;
  for (let index = 3; index < data.length; index += 4) {
    if (data[index]! < 128) transparent += 1;
  }
  const total = width * height;
  if (transparent === 0) return fail("maskDataUrl", "selects nothing; paint the region that may change");
  if (transparent === total) return fail("maskDataUrl", "selects the whole picture; use no mask instead");
  return { bytes, coverage: transparent / total };
}

/** Colour type 4 or 6 carries alpha per pixel; any other type has it only through a tRNS chunk. */
function pngHasAlphaChannel(bytes: Buffer): boolean {
  if (bytes.length < 33) return false;
  const colourType = bytes[25];
  if (colourType === 4 || colourType === 6) return true;
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    if (type === "tRNS") return true;
    if (type === "IDAT" || type === "IEND") return false;
    offset += 12 + length;
  }
  return false;
}

// ── Applying and describing ────────────────────────────────────────────────────────────────────

/**
 * The request that runs after the person configured it. Built from their settings alone: the
 * agent's model name is dropped, because the tier they picked decides the engine, and the agent's
 * base and mask survive only where they chose to keep them.
 */
export function applyImageSettings(
  agentRequest: ImageGenerationRequest,
  settings: ChosenImageSettings,
): ImageGenerationRequest {
  const edit = settings.edit;
  const mask = edit?.mask ? edit.mask.bytes.toString("base64") : edit?.keepAgentMask ? agentRequest.mask : undefined;
  const maskBlur = edit?.maskBlur ?? (edit?.keepAgentMask ? agentRequest.maskBlur : undefined);
  return {
    prompt: settings.prompt,
    tier: settings.tier,
    // "" stays "": the resolver fills a default only for a missing negative prompt, and the person
    // clearing it means none.
    negativePrompt: settings.negativePrompt,
    width: settings.width,
    height: settings.height,
    steps: settings.steps,
    guidanceScale: settings.guidanceScale,
    ...(settings.seed !== null ? { seed: settings.seed } : {}),
    ...(edit ? { initImage: edit.base.bytes.toString("base64"), strength: edit.strength } : {}),
    ...(mask ? { mask } : {}),
    ...(mask && typeof maskBlur === "number" ? { maskBlur } : {}),
  };
}

/** What the person changed against the agent's settings: keys for metadata, words for people. */
export function describeSettingsChange(
  proposal: ImageSettingsProposal,
  chosen: ChosenImageSettings,
): { changed: string[]; summary: string } {
  const agent = proposal.agent;
  const changed: string[] = [];
  const parts: string[] = [];
  const note = (key: string, text: string) => {
    changed.push(key);
    parts.push(text);
  };
  if (chosen.tier !== agent.tier) note("tier", `tier ${agent.tier}→${chosen.tier}`);
  if (chosen.prompt !== agent.prompt.trim()) note("prompt", "prompt");
  if (chosen.negativePrompt !== (agent.negativePrompt ?? "").trim()) {
    note("negativePrompt", chosen.negativePrompt ? "negative prompt" : "no negative prompt");
  }
  if (chosen.width !== agent.width || chosen.height !== agent.height) note("size", `size ${chosen.width}x${chosen.height}`);
  if (chosen.steps !== agent.steps) note("steps", `steps ${chosen.steps}`);
  if (chosen.guidanceScale !== agent.guidanceScale) note("guidanceScale", `guidance ${chosen.guidanceScale}`);
  if (chosen.seed !== (agent.seed ?? null)) note("seed", chosen.seed === null ? "random seed" : `seed ${chosen.seed}`);
  const edit = chosen.edit;
  if (!edit) {
    // Only when the agent's base was on offer: a picture the person never saw is not one they dropped.
    if (proposal.mode === "edit" && agent.baseCandidateId) note("baseImage", "no base picture (a new picture)");
  } else {
    if (edit.base.id !== agent.baseCandidateId) note("baseImage", `base ${edit.base.label}`);
    if (edit.strength !== agent.strength) note("strength", `strength ${edit.strength}`);
    if (edit.mask) note("mask", `painted a mask (~${Math.max(1, Math.round(edit.mask.coverage * 100))}% of the picture)`);
    else if (agent.hasMask && !edit.keepAgentMask) note("mask", "no mask");
    if (edit.maskBlur !== undefined && edit.maskBlur !== agent.maskBlur) note("maskBlur", `feather ${edit.maskBlur}`);
  }
  return { changed, summary: parts.length > 0 ? `changed ${parts.join(", ")}` : "kept the agent's settings" };
}

/** One line naming what a request runs as: "quality tier (Qwen-Image 2.1), 1024x768, 20 steps…". */
export function describeRenderSettings(
  config: ImageGenerationBackendConfig,
  request: ImageGenerationRequest,
  extras: { baseLabel?: string; maskPath?: string; maskCoverage?: number } = {},
): string {
  const resolved = previewImageRequest(config, request);
  const engine = imageEngineLabel(config, resolved.tier);
  const parts = [
    `${resolved.tier} tier${engine ? ` (${engine})` : ""}`,
    `${resolved.width}x${resolved.height}`,
    `${resolved.steps} steps`,
    `guidance ${resolved.guidanceScale}`,
    typeof request.seed === "number" ? `seed ${request.seed}` : "random seed",
    !resolved.negativePrompt ? "no negative prompt"
      : negativePromptHasNoEffect(resolved) ? "a negative prompt (no effect at this guidance)"
        : "a negative prompt",
  ];
  if (request.initImage) {
    const mask = extras.maskPath
      ? ` with the mask ${extras.maskPath}${extras.maskCoverage !== undefined ? ` (~${Math.max(1, Math.round(extras.maskCoverage * 100))}% may change)` : ""}`
      : request.mask ? " with a mask" : ", no mask";
    parts.push(`an edit of ${extras.baseLabel ?? "the base picture"} at strength ${request.strength ?? DEFAULT_EDIT_STRENGTH}${mask}`);
  } else {
    parts.push("a new picture");
  }
  return parts.join(", ");
}

/**
 * The clause generate_image appends to its output, so the agent reports what really ran and who
 * chose it. Short for the cases where the agent's own settings ran; nothing at all where nobody
 * could have been asked, which is every run before this step existed.
 */
export function describeImageSettingsForAgent(input: {
  source: ImageSettingsSource;
  ran?: string;
  change?: { changed: string[]; summary: string };
  prompt?: string;
}): string {
  switch (input.source) {
    // Nobody could be asked; or nothing rendered, which the tool's failure already says.
    case "no_channel":
    case "user_skipped":
      return "";
    case "session_preference":
      return " — SETTINGS: yours; this chat is set to Auto.";
    case "auto":
      return " — SETTINGS: yours; the user chose Auto.";
    case "timeout":
    case "disconnected_expired":
      return " — SETTINGS: yours; the user did not answer the settings step in time.";
    case "user": {
      const changed = input.change && input.change.changed.length > 0
        ? ` They ${input.change.summary}.`
        : " They kept yours.";
      const prompt = input.change?.changed.includes("prompt") && input.prompt
        ? ` Their prompt: "${truncate(input.prompt, 300)}".`
        : "";
      return ` — SETTINGS chosen by the user in the settings step: ${input.ran ?? "their settings"}.${changed}${prompt}`
        + " Report THESE settings, not the ones you proposed, and do not re-render to restore yours.";
    }
  }
}

/**
 * The clause generate_image adds when the agent passed `latest_mask` again — the region the user
 * painted for an earlier render. It fits that picture's later renders too, so "remove the boat" on
 * the render made with the painted sky passed every check and rebuilt the sky again; and where
 * nobody confirmed it, only "SETTINGS: yours" came back and neither the agent nor the user learnt
 * the old region had been used. Silent when the user kept it themselves in Configure: their
 * settings name the mask already.
 */
export function describeReusedMaskForAgent(paintedFor: string, source: ImageSettingsSource | undefined): string {
  if (source === "user") return "";
  const used = ` — MASK: this re-used the region the user painted earlier on ${paintedFor}`;
  return source === "auto"
    ? `${used}; the settings card showed it and they chose Auto.`
    : `${used}, and nobody confirmed it for this request: say so, and if they asked to change a different part, that part is unchanged.`;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integerIn(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

function numberIn(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : undefined;
}
