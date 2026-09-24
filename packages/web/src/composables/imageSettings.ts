/**
 * The image settings card's form: what the agent proposed, what the user may change, and the
 * answer that goes back.
 *
 * The server builds the proposal (engines, bounds, base pictures) and is the authority on every
 * rule; the checks here mirror its rules so a mistake shows next to its field before the round
 * trip, not instead of it. Measured with the seed pinned, both engines honour seed, steps,
 * guidance and the negative prompt, so no field is greyed out per engine — only the size of a
 * fixed-size engine and editing on one that cannot edit are.
 *
 * Deliberately free of Vue and of the store, like turnSteps.
 */
import type { UserInputFieldError } from "./userInputs";

export interface ImageEngine {
  tier: string;
  model: string;
  label?: string;
  /** Renders 1024×1024 only. */
  fixedSize: boolean;
  /** Can take a base picture (and a mask) to edit. */
  canEdit: boolean;
  /** What it renders with when nothing is set — the settings `expectedSeconds` was measured at. */
  defaults: { width: number; height: number; steps: number; guidanceScale: number; negativePrompt?: string };
  /** At `defaults`; estimateRenderSeconds scales it to any other settings. */
  expectedSeconds: number;
  /**
   * Set while the engine still finishes a render abandoned at its timeout, when the question was
   * put: the next render waits that out before it starts.
   */
  busySeconds?: number;
}

export interface BaseCandidate {
  /** Opaque: the client never sees or sends a path. */
  id: string;
  label: string;
  source: "agent" | "latest_image" | "shared_fact" | "attachment";
  /** 0 when the server could not read the size. */
  width: number;
  height: number;
  /**
   * False for the agent's own picture when it is too large to edit at its own size (a phone
   * photo): the edit then renders at the size the agent's request resolved to, as Auto would, and
   * no mask can be painted on it.
   */
  fitsBounds: boolean;
  /** "" when the server could not decode it for a thumbnail. */
  thumbDataUrl: string;
}

export interface ImageSettingsBounds {
  size: { min: number; max: number; step: number; fixed: number };
  steps: [number, number];
  guidance: [number, number];
  seed: [number, number];
  strength: [number, number];
  maskBlur: [number, number];
  promptMax: number;
  negativeMax: number;
}

export interface AgentProposal {
  prompt: string;
  negativePrompt?: string;
  tier: string;
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

export interface ImageSettingsPayload {
  mode: "generate" | "edit";
  agent: AgentProposal;
  engines: ImageEngine[];
  bounds: ImageSettingsBounds;
  baseCandidates: BaseCandidate[];
  /** `paintedEarlier`: the region the user painted for an earlier render, which the agent passed again. */
  agentMask?: { width: number; height: number; previewDataUrl: string; paintedEarlier?: boolean };
}

export type MaskChoice = "none" | "agent" | "painted";

export interface ImageSettingsForm {
  tier: string;
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  steps: number;
  guidanceScale: number;
  /** null = a new random seed on every render. */
  seed: number | null;
  /** null = a new picture rather than an edit. */
  baseCandidateId: string | null;
  strength: number;
  maskBlur: number;
  mask: MaskChoice;
  /** The painted mask, when `mask` is "painted". */
  maskDataUrl?: string;
  /** Fields the user set themselves: these stay put when the engine changes; the rest follow its defaults. */
  touched: Partial<Record<"steps" | "guidanceScale" | "negativePrompt" | "maskBlur", true>>;
}

export interface ImageSettingsAnswer {
  choice: "auto" | "configure" | "skip";
  alwaysAuto?: boolean;
  settings?: {
    tier: string;
    prompt: string;
    negativePrompt: string;
    width: number;
    height: number;
    steps: number;
    guidanceScale: number;
    seed: number | null;
    edit: null | {
      baseCandidateId: string;
      strength: number;
      maskDataUrl?: string | null;
      keepAgentMask?: boolean;
      maskBlur?: number;
    };
  };
}

/** The fields an error can be shown against. Anything else goes above the footer. */
export type ImageSettingsField =
  | "tier" | "prompt" | "negativePrompt" | "width" | "height" | "steps" | "guidanceScale" | "seed"
  | "baseCandidateId" | "strength" | "mask" | "maskBlur" | "_form";

const DEFAULT_BOUNDS: ImageSettingsBounds = {
  size: { min: 256, max: 2048, step: 64, fixed: 1024 },
  steps: [1, 100],
  guidance: [0, 20],
  seed: [0, 4294967295],
  strength: [0.05, 1],
  maskBlur: [0, 256],
  promptMax: 4000,
  negativeMax: 2000,
};

/** Where a first edit starts when the agent proposed none: a tonal change that keeps the picture. */
const DEFAULT_STRENGTH = 0.3;
const DEFAULT_MASK_BLUR = 24;

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const str = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function range(value: unknown, fallback: [number, number]): [number, number] {
  return Array.isArray(value) && value.length === 2 && num(value[0]) !== undefined && num(value[1]) !== undefined
    ? [value[0] as number, value[1] as number]
    : fallback;
}

/** The card's payload, or null when it cannot be read — the card then offers only Auto and Skip. */
export function readImageSettingsPayload(raw: unknown): ImageSettingsPayload | null {
  const data = record(raw);
  const agent = record(data?.["agent"]);
  if (!data || !agent || typeof agent["prompt"] !== "string" || typeof agent["tier"] !== "string") return null;
  const engines: ImageEngine[] = (Array.isArray(data["engines"]) ? data["engines"] : []).flatMap((entry) => {
    const engine = record(entry);
    const defaults = record(engine?.["defaults"]);
    if (!engine || typeof engine["tier"] !== "string" || !defaults) return [];
    return [{
      tier: engine["tier"],
      model: str(engine["model"]) ?? engine["tier"],
      ...(str(engine["label"]) ? { label: str(engine["label"]) } : {}),
      fixedSize: engine["fixedSize"] === true,
      canEdit: engine["canEdit"] === true,
      defaults: {
        width: num(defaults["width"]) ?? DEFAULT_BOUNDS.size.fixed,
        height: num(defaults["height"]) ?? DEFAULT_BOUNDS.size.fixed,
        steps: num(defaults["steps"]) ?? 20,
        guidanceScale: num(defaults["guidanceScale"]) ?? 1,
        ...(str(defaults["negativePrompt"]) !== undefined ? { negativePrompt: str(defaults["negativePrompt"]) } : {}),
      },
      expectedSeconds: num(engine["expectedSeconds"]) ?? 0,
      ...((num(engine["busySeconds"]) ?? 0) > 0 ? { busySeconds: num(engine["busySeconds"]) } : {}),
    }];
  });
  if (engines.length === 0) return null;
  const boundsRaw = record(data["bounds"]);
  const sizeRaw = record(boundsRaw?.["size"]);
  const bounds: ImageSettingsBounds = {
    size: {
      min: num(sizeRaw?.["min"]) ?? DEFAULT_BOUNDS.size.min,
      max: num(sizeRaw?.["max"]) ?? DEFAULT_BOUNDS.size.max,
      step: num(sizeRaw?.["step"]) ?? DEFAULT_BOUNDS.size.step,
      fixed: num(sizeRaw?.["fixed"]) ?? DEFAULT_BOUNDS.size.fixed,
    },
    steps: range(boundsRaw?.["steps"], DEFAULT_BOUNDS.steps),
    guidance: range(boundsRaw?.["guidance"], DEFAULT_BOUNDS.guidance),
    seed: range(boundsRaw?.["seed"], DEFAULT_BOUNDS.seed),
    strength: range(boundsRaw?.["strength"], DEFAULT_BOUNDS.strength),
    maskBlur: range(boundsRaw?.["maskBlur"], DEFAULT_BOUNDS.maskBlur),
    promptMax: num(boundsRaw?.["promptMax"]) ?? DEFAULT_BOUNDS.promptMax,
    negativeMax: num(boundsRaw?.["negativeMax"]) ?? DEFAULT_BOUNDS.negativeMax,
  };
  const baseCandidates: BaseCandidate[] = (Array.isArray(data["baseCandidates"]) ? data["baseCandidates"] : []).flatMap((entry) => {
    const candidate = record(entry);
    const id = str(candidate?.["id"]);
    const width = num(candidate?.["width"]);
    const height = num(candidate?.["height"]);
    // Offered without a size only when it cannot be edited at its own size anyway.
    const fitsBounds = candidate?.["fitsBounds"] !== false;
    if (!candidate || !id || (fitsBounds && (!width || !height))) return [];
    const source = str(candidate["source"]);
    return [{
      id,
      label: str(candidate["label"]) ?? id,
      source: source === "agent" || source === "latest_image" || source === "shared_fact" || source === "attachment" ? source : "shared_fact",
      width: width ?? 0,
      height: height ?? 0,
      fitsBounds,
      thumbDataUrl: str(candidate["thumbDataUrl"]) ?? "",
    }];
  });
  const maskRaw = record(data["agentMask"]);
  const agentMask = maskRaw && num(maskRaw["width"]) && num(maskRaw["height"]) && str(maskRaw["previewDataUrl"])
    ? {
        width: maskRaw["width"] as number,
        height: maskRaw["height"] as number,
        previewDataUrl: maskRaw["previewDataUrl"] as string,
        ...(maskRaw["paintedEarlier"] === true ? { paintedEarlier: true } : {}),
      }
    : undefined;
  return {
    mode: data["mode"] === "edit" ? "edit" : "generate",
    agent: {
      prompt: agent["prompt"],
      ...(str(agent["negativePrompt"]) !== undefined ? { negativePrompt: str(agent["negativePrompt"]) } : {}),
      tier: agent["tier"],
      width: num(agent["width"]) ?? bounds.size.fixed,
      height: num(agent["height"]) ?? bounds.size.fixed,
      steps: num(agent["steps"]) ?? engines[0]!.defaults.steps,
      guidanceScale: num(agent["guidanceScale"]) ?? engines[0]!.defaults.guidanceScale,
      ...(num(agent["seed"]) !== undefined ? { seed: num(agent["seed"]) } : {}),
      ...(str(agent["baseCandidateId"]) ? { baseCandidateId: str(agent["baseCandidateId"]) } : {}),
      ...(num(agent["strength"]) !== undefined ? { strength: num(agent["strength"]) } : {}),
      ...(num(agent["maskBlur"]) !== undefined ? { maskBlur: num(agent["maskBlur"]) } : {}),
      hasMask: agent["hasMask"] === true,
    },
    engines,
    bounds,
    baseCandidates,
    ...(agentMask ? { agentMask } : {}),
  };
}

export function engineFor(payload: ImageSettingsPayload, tier: string): ImageEngine | undefined {
  return payload.engines.find((engine) => engine.tier === tier);
}

export function engineLabel(engine: ImageEngine | undefined, fallback = "image engine"): string {
  return engine?.label ?? engine?.model ?? engine?.tier ?? fallback;
}

export function candidateFor(payload: ImageSettingsPayload, id: string | null | undefined): BaseCandidate | undefined {
  return id ? payload.baseCandidates.find((candidate) => candidate.id === id) : undefined;
}

/** "~10 s" / "~3 min" — what the engine usually takes. */
export function etaLabel(seconds: number): string {
  if (!(seconds > 0)) return "";
  return seconds < 60 ? `~${Math.round(seconds)} s` : `~${Math.max(1, Math.round(seconds / 60))} min`;
}

/** Past this a render ties up its engine for long enough that the form says so before it runs. */
export const LONG_RENDER_SECONDS = 600;

/**
 * How long a render on `engine` should take with these settings: its time at its own defaults,
 * scaled by steps × area, and doubled where the engine's default guidance is ≤ 1 (embedded
 * guidance) and these settings turn on true CFG, which runs a second forward pass per step.
 *
 * Mirrors imageRenderWork / expectedImageRenderSeconds in core's multimodal/image-generation.ts,
 * which sets the render's timeout by the same figure — change both together. Session 807684e9
 * showed "~3 min" for 57 steps at 1344x768, a render of about eight.
 */
export function estimateRenderSeconds(
  engine: Pick<ImageEngine, "defaults" | "expectedSeconds"> | undefined,
  settings: { steps: number; width: number; height: number; guidanceScale: number },
): number {
  if (!engine || !(engine.expectedSeconds > 0)) return 0;
  const { defaults } = engine;
  const steps = settings.steps / defaults.steps;
  const area = (settings.width * settings.height) / (defaults.width * defaults.height);
  const cfg = defaults.guidanceScale <= 1 && settings.guidanceScale > 1 ? 2 : 1;
  const work = steps * area * cfg;
  return engine.expectedSeconds * (Number.isFinite(work) && work > 0 ? work : 1);
}

/** What the agent's own settings should take — the collapsed card's time, and Auto's. */
export function agentEstimateSeconds(payload: ImageSettingsPayload): number {
  return estimateRenderSeconds(engineFor(payload, payload.agent.tier), payload.agent);
}

/** What the form's settings should take on the engine they name. */
export function formEstimateSeconds(form: ImageSettingsForm, payload: ImageSettingsPayload): number {
  return estimateRenderSeconds(engineFor(payload, form.tier), form);
}

/**
 * What the form's settings would take on `tier` — for the engine list: as they are on the engine
 * selected, and as switching would leave them on another (untouched steps follow its defaults).
 */
export function engineEstimateSeconds(form: ImageSettingsForm, payload: ImageSettingsPayload, tier: string): number {
  return estimateRenderSeconds(engineFor(payload, tier), tier === form.tier ? form : selectEngine(form, payload, tier));
}

/**
 * How long `tier`'s engine still finishes a render abandoned earlier, `now`, for a question asked at
 * `askedAt` (this page's clock): the engine's busy time when it was asked, less what has passed.
 * The render waits that out before it starts — a wait the settings' own time does not include.
 */
export function engineWaitSeconds(payload: ImageSettingsPayload, tier: string, askedAt: number, now: number): number {
  const busy = engineFor(payload, tier)?.busySeconds ?? 0;
  return busy > 0 ? Math.max(0, busy - Math.max(0, now - askedAt) / 1000) : 0;
}

/** Said beside the time when the engine must first finish an earlier render; "" when it need not. */
export function engineWaitNote(seconds: number): string {
  return seconds >= 1
    ? `The engine first finishes an earlier render that timed out: ${etaLabel(seconds)} before this one starts.`
    : "";
}

/** "About 14 min — …" when a render is long enough to warn about, else "". */
export function longRenderWarning(seconds: number): string {
  return seconds > LONG_RENDER_SECONDS
    ? `About ${Math.round(seconds / 60)} min. The engine renders one picture at a time and is busy for all of it.`
    : "";
}

/**
 * The size an edit of `base` renders at: its own, or — for the agent's picture when it is too large
 * for that — the size the agent's request resolved to, which is what Auto runs.
 */
export function editSize(payload: ImageSettingsPayload, base: BaseCandidate): { width: number; height: number } {
  return base.fitsBounds ? { width: base.width, height: base.height } : { width: payload.agent.width, height: payload.agent.height };
}

/**
 * The agent proposed an edit but its picture is not among the offered ones (an older server, or a
 * picture it could not read). The form cannot keep that edit, and says so rather than quietly
 * starting from "None — new picture".
 */
export function editBaseMissing(payload: ImageSettingsPayload): boolean {
  return payload.mode === "edit" && !candidateFor(payload, payload.agent.baseCandidateId);
}

/** The agent's proposal in one line, for the compact card. */
export function summarizeProposal(payload: ImageSettingsPayload): string {
  const { agent } = payload;
  const base = candidateFor(payload, agent.baseCandidateId);
  return [
    engineLabel(engineFor(payload, agent.tier), agent.tier),
    `${agent.width}×${agent.height}`,
    base ? `edit of ${base.label}` : payload.mode === "edit" ? "edit" : "new picture",
    base || payload.mode === "edit"
      ? `mask: ${agent.hasMask ? (payload.agentMask?.paintedEarlier ? "the region you painted earlier" : "yes") : "none"}`
      : undefined,
  ].filter(Boolean).join(" · ");
}

/**
 * The agent's mask as the compact card shows it: over the base's thumbnail, with what it means.
 * "mask: yes" alone let the region painted for the sky go through Auto again for "remove the boat"
 * without anyone seeing which region it was. Null when the agent passed no mask the card can show.
 */
export function agentMaskPreview(payload: ImageSettingsPayload): { maskUrl: string; baseUrl: string; width: number; height: number; caption: string } | null {
  const mask = payload.agentMask;
  if (!payload.agent.hasMask || !mask) return null;
  return {
    maskUrl: mask.previewDataUrl,
    baseUrl: candidateFor(payload, payload.agent.baseCandidateId)?.thumbDataUrl ?? "",
    width: mask.width,
    height: mask.height,
    caption: mask.paintedEarlier
      ? "Only the bright region may change: the one you painted for an earlier render."
      : "Only the bright region may change: the agent's mask.",
  };
}

/**
 * A picture's box inside a `side`-wide square, in its own shape. The compact card cropped the mask
 * to a square, so a 768x1344 portrait lost 21% at the top and at the bottom — enough to hide a
 * painted sky entirely under "Only the bright region may change".
 */
export function fitInSquare(width: number, height: number, side: number): { width: number; height: number } {
  const scale = side / Math.max(width, height, 1);
  return { width: width * scale, height: height * scale };
}

/** The form as the agent proposed it — also what "reset" goes back to. */
export function initialForm(payload: ImageSettingsPayload): ImageSettingsForm {
  const { agent } = payload;
  const engine = engineFor(payload, agent.tier) ?? payload.engines[0]!;
  const base = candidateFor(payload, agent.baseCandidateId);
  const size = base ? editSize(payload, base) : agent;
  return {
    tier: engine.tier,
    prompt: agent.prompt,
    negativePrompt: agent.negativePrompt ?? "",
    width: size.width,
    height: size.height,
    steps: agent.steps,
    guidanceScale: agent.guidanceScale,
    seed: agent.seed ?? null,
    baseCandidateId: base?.id ?? null,
    strength: agent.strength ?? DEFAULT_STRENGTH,
    maskBlur: agent.maskBlur ?? DEFAULT_MASK_BLUR,
    mask: base && agent.hasMask && payload.agentMask ? "agent" : "none",
    touched: {},
  };
}

/**
 * Switch engine. Settings the user left alone follow the new engine's defaults; ones they set
 * stay. A fixed-size engine takes its one size.
 */
export function selectEngine(form: ImageSettingsForm, payload: ImageSettingsPayload, tier: string): ImageSettingsForm {
  const engine = engineFor(payload, tier);
  if (!engine) return form;
  const next: ImageSettingsForm = { ...form, tier, touched: { ...form.touched } };
  if (!form.touched.steps) next.steps = engine.defaults.steps;
  if (!form.touched.guidanceScale) next.guidanceScale = engine.defaults.guidanceScale;
  if (!form.touched.negativePrompt && engine.defaults.negativePrompt !== undefined) next.negativePrompt = engine.defaults.negativePrompt;
  if (engine.fixedSize && !next.baseCandidateId) {
    next.width = payload.bounds.size.fixed;
    next.height = payload.bounds.size.fixed;
  }
  return next;
}

/**
 * Pick the picture to edit, or none for a new one. An edit renders at the base's own size, needs
 * an engine that can edit, and cannot keep a mask made for a different picture.
 */
export function selectBase(form: ImageSettingsForm, payload: ImageSettingsPayload, candidateId: string | null): ImageSettingsForm {
  const base = candidateFor(payload, candidateId);
  if (!base) {
    const engine = engineFor(payload, form.tier);
    const size = engine?.fixedSize ? payload.bounds.size.fixed : undefined;
    return {
      ...form,
      baseCandidateId: null,
      mask: "none",
      maskDataUrl: undefined,
      width: size ?? payload.agent.width,
      height: size ?? payload.agent.height,
    };
  }
  const size = editSize(payload, base);
  let next: ImageSettingsForm = { ...form, baseCandidateId: base.id, ...size };
  if (base.id !== form.baseCandidateId) {
    next.mask = base.id === payload.agent.baseCandidateId && payload.agent.hasMask && payload.agentMask ? "agent" : "none";
    next.maskDataUrl = undefined;
  }
  if (!engineFor(payload, next.tier)?.canEdit) {
    const editor = payload.engines.find((engine) => engine.canEdit);
    if (editor) next = selectEngine(next, payload, editor.tier);
    // selectEngine may resize a fixed-size engine; an edit always keeps its own size.
    next.width = size.width;
    next.height = size.height;
  }
  return next;
}

/** Whether width and height can be edited, and why not. */
export function sizeLock(form: ImageSettingsForm, payload: ImageSettingsPayload): { locked: boolean; reason?: "base" | "fixed" } {
  if (form.baseCandidateId) return { locked: true, reason: "base" };
  if (engineFor(payload, form.tier)?.fixedSize) return { locked: true, reason: "fixed" };
  return { locked: false };
}

export interface SizePreset {
  label: string;
  width: number;
  height: number;
}

/** A few common shapes that fit the bounds, square first. */
export function sizePresets(bounds: ImageSettingsBounds): SizePreset[] {
  const presets: SizePreset[] = [
    { label: "Square", width: 1024, height: 1024 },
    { label: "Landscape 4:3", width: 1152, height: 896 },
    { label: "Portrait 3:4", width: 896, height: 1152 },
    { label: "Wide 16:9", width: 1344, height: 768 },
    { label: "Tall 9:16", width: 768, height: 1344 },
    { label: "Small", width: 512, height: 512 },
  ];
  const fits = (value: number) => value >= bounds.size.min && value <= bounds.size.max && value % bounds.size.step === 0;
  return presets.filter((preset) => fits(preset.width) && fits(preset.height));
}

/** What a strength does, in the two bands that are known to work. */
export function strengthBand(strength: number): string {
  if (strength < 0.2) return "barely changes it";
  if (strength <= 0.35) return "tone and colour — keeps the picture";
  if (strength < 0.6) return "restyles it";
  if (strength <= 0.85) return "replaces the region — use with a mask";
  return "close to a new picture";
}

export function randomSeed(max = DEFAULT_BOUNDS.seed[1]): number {
  return Math.floor(Math.random() * (max + 1));
}

const isInt = (value: number) => Number.isInteger(value);

/** The server's rules, checked before sending. Empty when the form can go. */
export function validateForm(form: ImageSettingsForm, payload: ImageSettingsPayload): UserInputFieldError[] {
  const errors: UserInputFieldError[] = [];
  const { bounds } = payload;
  const engine = engineFor(payload, form.tier);
  const base = candidateFor(payload, form.baseCandidateId);
  const add = (field: ImageSettingsField, message: string) => errors.push({ field, message });

  if (!engine) add("tier", "Pick an engine.");
  const prompt = form.prompt.trim();
  if (!prompt) add("prompt", "The prompt cannot be empty.");
  else if (prompt.length > bounds.promptMax) add("prompt", `At most ${bounds.promptMax} characters.`);
  if (form.negativePrompt.trim().length > bounds.negativeMax) add("negativePrompt", `At most ${bounds.negativeMax} characters.`);

  if (form.baseCandidateId && !base) add("baseCandidateId", "That picture is no longer available.");
  if (base && engine && !engine.canEdit) add("tier", `${engineLabel(engine)} cannot edit a picture.`);

  if (!isInt(form.width) || !isInt(form.height)) {
    add("width", "Width and height must be whole pixels.");
  } else if (base) {
    const size = editSize(payload, base);
    if (form.width !== size.width || form.height !== size.height) {
      add("width", base.fitsBounds
        ? `An edit renders at the picture's own size, ${size.width}×${size.height}.`
        : `This picture is too large to edit at its own size; it renders at ${size.width}×${size.height}.`);
    } else if (engine?.fixedSize && (size.width !== bounds.size.fixed || size.height !== bounds.size.fixed)) {
      add("width", `${engineLabel(engine)} renders ${bounds.size.fixed}×${bounds.size.fixed} only.`);
    }
  } else if (engine?.fixedSize) {
    if (form.width !== bounds.size.fixed || form.height !== bounds.size.fixed) add("width", `${engineLabel(engine)} renders ${bounds.size.fixed}×${bounds.size.fixed} only.`);
  } else {
    for (const [field, value] of [["width", form.width], ["height", form.height]] as const) {
      if (value < bounds.size.min || value > bounds.size.max) add(field, `Between ${bounds.size.min} and ${bounds.size.max}.`);
      else if (value % bounds.size.step !== 0) add(field, `A multiple of ${bounds.size.step}.`);
    }
  }

  if (!isInt(form.steps) || form.steps < bounds.steps[0] || form.steps > bounds.steps[1]) add("steps", `A whole number from ${bounds.steps[0]} to ${bounds.steps[1]}.`);
  if (!Number.isFinite(form.guidanceScale) || form.guidanceScale < bounds.guidance[0] || form.guidanceScale > bounds.guidance[1]) {
    add("guidanceScale", `From ${bounds.guidance[0]} to ${bounds.guidance[1]}.`);
  }
  if (form.seed !== null && (!isInt(form.seed) || form.seed < bounds.seed[0] || form.seed > bounds.seed[1])) {
    add("seed", `A whole number from ${bounds.seed[0]} to ${bounds.seed[1]}, or random.`);
  }

  if (base) {
    if (!Number.isFinite(form.strength) || form.strength < bounds.strength[0] || form.strength > bounds.strength[1]) {
      add("strength", `From ${bounds.strength[0]} to ${bounds.strength[1]}.`);
    }
    if (form.mask === "painted" && !form.maskDataUrl) add("mask", "Paint the region that may change, or choose no mask.");
    if (form.mask === "painted" && !base.fitsBounds) add("mask", "This picture is too large to paint a mask on.");
    if (form.mask === "agent" && base.id !== payload.agent.baseCandidateId) add("mask", "The agent's mask belongs to a different picture.");
    if (form.mask !== "none" && (!isInt(form.maskBlur) || form.maskBlur < bounds.maskBlur[0] || form.maskBlur > bounds.maskBlur[1])) {
      add("maskBlur", `A whole number from ${bounds.maskBlur[0]} to ${bounds.maskBlur[1]}.`);
    }
  }
  return errors;
}

/** The answer for "render with these settings". */
export function buildConfigureAnswer(form: ImageSettingsForm, payload: ImageSettingsPayload, alwaysAuto: boolean): ImageSettingsAnswer {
  const base = candidateFor(payload, form.baseCandidateId);
  // The feather goes only when the user set it or the agent had, so the server's own default is
  // not replaced by this card's slider position.
  const sendBlur = form.touched.maskBlur || payload.agent.maskBlur !== undefined;
  const mask = form.mask === "painted" && form.maskDataUrl
    ? { maskDataUrl: form.maskDataUrl }
    : form.mask === "agent"
      ? { keepAgentMask: true }
      : { maskDataUrl: null };
  return {
    choice: "configure",
    ...(alwaysAuto ? { alwaysAuto: true } : {}),
    settings: {
      tier: form.tier,
      prompt: form.prompt.trim(),
      negativePrompt: form.negativePrompt.trim(),
      width: form.width,
      height: form.height,
      steps: form.steps,
      guidanceScale: form.guidanceScale,
      seed: form.seed,
      edit: base
        ? {
            baseCandidateId: base.id,
            strength: form.strength,
            ...mask,
            ...(form.mask !== "none" && sendBlur ? { maskBlur: form.maskBlur } : {}),
          }
        : null,
    },
  };
}

/**
 * The server's objections by form field. It may name a field by its path in the answer
 * (`settings.edit.maskDataUrl`); the last segment decides, and the mask's several spellings all
 * land on the mask section.
 */
export function imageFieldErrors(errors: UserInputFieldError[] | undefined): Partial<Record<ImageSettingsField, string>> {
  const known = new Set<ImageSettingsField>([
    "tier", "prompt", "negativePrompt", "width", "height", "steps", "guidanceScale", "seed",
    "baseCandidateId", "strength", "mask", "maskBlur",
  ]);
  const alias: Record<string, ImageSettingsField> = {
    maskDataUrl: "mask", keepAgentMask: "mask", size: "width", guidance: "guidanceScale", engine: "tier", model: "tier",
    base: "baseCandidateId", baseImage: "baseCandidateId", negative: "negativePrompt",
  };
  const out: Partial<Record<ImageSettingsField, string>> = {};
  for (const error of errors ?? []) {
    const last = (error.field ?? "").split(".").pop() ?? "";
    const field: ImageSettingsField = known.has(last as ImageSettingsField) ? last as ImageSettingsField : alias[last] ?? "_form";
    out[field] = out[field] ? `${out[field]} ${error.message}` : error.message;
  }
  return out;
}
