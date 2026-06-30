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
  /** Auto-speak a summary of the assistant reply after each turn when voice-input mode is active. */
  speakReplySummary: z.boolean().default(false),
  /** Maximum number of spoken sentences in the auto-generated reply summary. */
  speakReplySummaryMaxSentences: z.number().int().min(1).max(5).default(3),
});

export const MultimodalImageGenerationSchema = MultimodalServiceSchema.extend({
  baseUrl: OptionalEndpointUrlSchema.default(""),
  api: z.enum(["automatic1111-compatible", "comfyui"]).default("automatic1111-compatible"),
  model: z.string().min(1).optional(),
  defaultWidth: z.number().int().min(256).max(2048).default(1024),
  defaultHeight: z.number().int().min(256).max(2048).default(1024),
  defaultSteps: z.number().int().min(1).max(100).default(28),
  defaultGuidanceScale: z.number().min(0).max(20).default(7),
  /** Default negative prompt appended to every generate_image call unless the agent supplies one. */
  defaultNegativePrompt: z.string().optional(),
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
