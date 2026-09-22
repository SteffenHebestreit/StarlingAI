import { z } from "zod";

const OptionalEndpointUrlSchema = z.preprocess(
  (value) => typeof value === "string" ? value.trim() : value,
  z.union([z.literal(""), z.string().url()]),
);

export const MultimodalServiceSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),
  timeoutMs: z.number().int().min(1000).max(300000).default(60000),
});

export const MultimodalFileServiceSchema = MultimodalServiceSchema.extend({
  baseUrl: z.string().url().default("http://host.docker.internal:8010"),
  mcpServer: z.string().min(1).optional(),
  toolName: z.string().min(1).default("file_to_markdown"),
  /** Vision model used as fallback for images when file_to_markdown returns no content.
   *  Format: same as agents.defaults.model.primary, e.g. "lmstudio/qwen2-vl-7b-instruct"
   *  When set, the gateway encodes the image as base64 and calls the LM Studio vision API. */
  visionModel: z.string().min(1).optional(),
  /** Optional dedicated OpenAI-compatible endpoint for the vision model fallback. */
  visionBaseUrl: z.string().url().optional(),
  /** Optional API key for the dedicated vision endpoint. */
  visionApiKey: z.string().optional(),
  /** Timeout for vision LLM calls in milliseconds (default: 120 000).
   *  Kept separate from timeoutMs (which applies to the file-to-markdown service)
   *  because local LLM inference on large screenshots can take 60–120 s. */
  visionTimeoutMs: z.number().int().positive().default(120_000),
});

export const MultimodalSpeechToTextSchema = MultimodalServiceSchema.extend({
  baseUrl: OptionalEndpointUrlSchema.default(""),
  api: z.enum(["auto", "openai-compatible", "transcribe-only"]).default("auto"),
  model: z.string().min(1).default("whisper-1"),
});

export const MultimodalTextToSpeechSchema = MultimodalServiceSchema.extend({
  baseUrl: OptionalEndpointUrlSchema.default(""),
  api: z.enum(["qwen-compatible", "openai-compatible"]).default("openai-compatible"),
  // Empty string is a meaningful value: on qwen-compatible it tells the
  // runtime to skip the /load_model preflight (use whatever the upstream
  // already has loaded); on openai-compatible the runtime falls back to
  // "tts-1" when this is empty. See sendSingleTtsRequest in multimodal.ts.
  model: z.string().default("tts-1"),
  defaultLanguage: z.string().min(2).default("English"),
  defaultSpeaker: z.string().min(1).default("alloy"),
  defaultVoiceId: z.string().min(1).optional(),
  voiceSamplePath: z.string().min(1).optional(),
  voiceSampleText: z.string().min(1).optional(),
  defaultQuality: z.string().min(1).default("medium"),
  // (`speakReplySummary` used to gate this; nothing ever read it. The web client
  // decides from TTS availability + the caller's forceFullText, so the flag was a
  // switch wired to nothing.)
  /** Maximum number of spoken sentences in the auto-generated reply summary. */
  speakReplySummaryMaxSentences: z.number().int().min(1).max(5).default(3),
});

export const MultimodalImageGenerationSchema = MultimodalServiceSchema.extend({
  baseUrl: OptionalEndpointUrlSchema.default(""),
  /**
   * `openai-compatible` targets `POST {baseUrl}/images/generations` and expects base64 in
   * `b64_json` — there is no file host behind such an endpoint, so a response carrying a URL
   * is treated as a contract change rather than a success.
   */
  api: z.enum(["automatic1111-compatible", "comfyui", "openai-compatible"]).default("automatic1111-compatible"),
  /** The default model: the FAST tier where a backend offers more than one. */
  model: z.string().min(1).optional(),
  /**
   * The slow, higher-fidelity tier, when the backend has one.
   *
   * Left unset unless a deployment really has a second tier, because the choice is a cost
   * decision and not a quality dial. On the cluster this was written for, the quality tier
   * takes about 120 s against the fast tier's 10 s, runs on the worker station's graphics
   * chip, drops that station's chat throughput by roughly 70% while it runs, and serialises
   * cluster-wide. A turn that picks it is spending everyone else's latency.
   */
  qualityModel: z.string().min(1).optional(),
  /**
   * Wall clock for the quality tier. Separate from `timeoutMs` so the fast tier is not made
   * to hang for minutes on a stalled request.
   *
   * The documented worst case is 150 s of generation plus about 25 s of weight reload after
   * ten minutes idle, so anything under ~180 s abandons requests that were going to succeed.
   */
  qualityTimeoutMs: z.number().int().min(10_000).max(600_000).default(210_000),
  /**
   * How many generations may run at once for a model, when the backend serialises per device.
   *
   * One by default, because a single image device generates serially: a second request does
   * not run in parallel, it waits inside the backend with the client's clock already running.
   * Queueing client-side instead keeps the timeout a measure of generation rather than of
   * queue position.
   *
   * This is a HARDWARE fact, so it is configuration and not a constant. The cluster this was
   * written for changed under exactly this feature: the fast tier moved from one NPU to two
   * and now load-balances across them — six concurrent requests finished in 38.5 s in a
   * 9.9 / 10.0 / 19.5 / 19.5 / 29.1 / 38.5 stagger, which is two at a time. A ceiling of one
   * there would leave half the tier idle; a ceiling of two on the single-iGPU quality tier
   * would go back to lying about the timeout.
   */
  maxConcurrent: z.number().int().min(1).max(16).default(1),
  /** Per-model override of `maxConcurrent`, keyed by the model id sent upstream. */
  maxConcurrentPerModel: z.record(z.string(), z.number().int().min(1).max(16)).default({}),
  /**
   * Models that generate ONE fixed resolution and reject anything else.
   *
   * Measured rather than assumed, because the two tiers on this cluster disagree. The NPU
   * tier (`image`) answers HTTP 502 in about 13 ms for any size but 1024x1024 — an ugly
   * rejection, but a rejection, and worth catching locally so the caller gets a reason
   * instead of a bad gateway. The iGPU tier (`image-quality`, Qwen-Image via
   * stable-diffusion.cpp) accepts whatever it is given: 64x64 came back in 1.2 s and
   * 1024x768 in 91 s.
   *
   * Applying one rule to both was wrong in the expensive direction: an agent asked for
   * 1024x768 on the quality tier and this client refused a request the backend would have
   * served.
   */
  fixedSizeModels: z.array(z.string()).default([]),
  /**
   * Models whose backend genuinely honours a base image, for "change this picture" rather
   * than "make a new one". EMPTY by default, which disables editing.
   *
   * An allowlist, because the endpoint measured here accepts a reference image under six
   * different field names with HTTP 200 and ignores all of them — so an attempt returns a
   * brand-new unrelated picture that looks like a successful edit. A user asked three times
   * to continue from an earlier render and got three unrelated beaches, losing the palms
   * they had asked to keep. Refusing is the honest answer until a route exists.
   *
   * To enable: expose a reference image on the generation route (or A1111's
   * POST /sdapi/v1/img2img with `init_images` + `denoising_strength`), then list the model
   * here. The client already sends both shapes.
   */
  initImageModels: z.array(z.string()).default([]),
  /**
   * Generation defaults for the QUALITY tier, where they differ from the fast tier's.
   *
   * They do differ, and one value for both is actively harmful. Measured against the live
   * endpoint with the seed pinned so only the parameter could vary: the fast tier at
   * guidance 1.0 and at 7.5 produced different images, so it genuinely reads the field and
   * wants 7.5. The quality tier wants 1.0 — Qwen-Image carries embedded guidance (3.5 in its
   * own record), so true CFG is redundant there AND doubles the forward passes per step:
   * guidance 4 measured 22 s against 11 s at guidance 1, same size and step count.
   *
   * So sending the fast tier's 7.5 to the quality tier would double its cost for a worse
   * picture, and sending the quality tier's 1.0 to the fast tier would flatten that one.
   * Anything left unset here falls back to the `default*` fields above.
   */
  qualityDefaults: z.object({
    steps: z.number().int().min(1).max(100).optional(),
    guidanceScale: z.number().min(0).max(20).optional(),
    negativePrompt: z.string().optional(),
  }).optional(),
  /**
   * A DIFFERENT backend for the quality tier, when the fast tier's protocol cannot express
   * what the quality tier needs.
   *
   * This deployment is exactly that case. Both tiers answer on one OpenAI-compatible
   * endpoint, but that route parses `prompt` and `size` and discards everything else —
   * measured with eight probes varying steps, seed, cfg and negative prompt, all returning
   * an identical record. Worse, its `--seed -1` randomises ONCE per server process, so the
   * same prompt returns the same image until the server restarts and "make me another one"
   * cannot work at all.
   *
   * The same sd-server also speaks the AUTOMATIC1111 protocol, and that route honours the
   * lot. Verified against it: `seed: -1` gives a different seed and a different image on
   * every request, an explicit seed reproduces byte-for-byte, and `steps` / `cfg_scale` come
   * back echoed in `info`.
   *
   * So the quality tier points at that route instead. Anything left unset here falls through
   * to the settings above.
   */
  qualityBackend: z.object({
    api: z.enum(["automatic1111-compatible", "comfyui", "openai-compatible"]).optional(),
    baseUrl: OptionalEndpointUrlSchema.optional(),
    /** The checkpoint name this backend reports, not the tier alias the router uses. */
    model: z.string().min(1).optional(),
    apiKey: z.string().optional(),
    timeoutMs: z.number().int().min(10_000).max(900_000).optional(),
  }).optional(),
  defaultWidth: z.number().int().min(256).max(2048).default(1024),
  defaultHeight: z.number().int().min(256).max(2048).default(1024),
  defaultSteps: z.number().int().min(1).max(100).default(28),
  defaultGuidanceScale: z.number().min(0).max(20).default(7),
  /** Default negative prompt appended to every generate_image call unless the agent supplies one. */
  defaultNegativePrompt: z.string().optional(),
  /**
   * What each tier's engine is called ("Qwen-Image 2.1"), shown to agents in generate_image's
   * description and accepted as a name for the tier. Without it a user asking for "the qwen
   * model" had nothing to be matched against: the agent guessed `model: "Qwen"`, the router
   * answered 404, and the retry quietly landed on the other engine.
   */
  tierLabels: z.record(z.enum(["fast", "quality"]), z.string().min(1)).default({}),
});

export const MultimodalWakeWordSchema = z.object({
  enabled: z.boolean().default(false),
  language: z.enum(["de-DE", "en-US", "pl-PL"]).default("en-US"),
  keywords: z.array(z.string().min(1)).default(["Hey Guarded", "Okay Guarded", "Luna"]),
  stopPhrases: z.array(z.string().min(1)).default(["stop recording", "end recording", "stop listening", "luna stop"]),
  silenceTimeoutMs: z.number().int().min(1000).max(15000).default(4000),
});

export const MultimodalSchema = z.object({
  maxUploadBytes: z.number().int().min(1024).max(104_857_600).default(20_971_520),
  files: MultimodalFileServiceSchema.default({}),
  stt: MultimodalSpeechToTextSchema.default({}),
  tts: MultimodalTextToSpeechSchema.default({}),
  wakeWord: MultimodalWakeWordSchema.default({}),
  imageGeneration: MultimodalImageGenerationSchema.optional(),
});

export type MultimodalFileConfig = z.infer<typeof MultimodalFileServiceSchema>;
export type MultimodalSpeechToTextConfig = z.infer<typeof MultimodalSpeechToTextSchema>;
export type MultimodalTextToSpeechConfig = z.infer<typeof MultimodalTextToSpeechSchema>;
