import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import JSON5 from "json5";
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";
import { sendChunkedTtsRequests } from "../multimodal/tts-chunking.js";
import { getMcpConnections } from "../mcp/registry.js";
import {
  ImageGenerationTimeoutError,
  ImageRenderTooLongError,
  ImageUpstreamRequestError,
  checkImageGenerationHealth,
  describeImageTierChoices,
  imageEngineLabel,
  imageGenerationServiceConfigured,
  imageRenderLimitError,
  imageRequestBoundsError,
  imageTierChoices,
  previewImageRequest,
  readImageHeaderSize,
  requestImageGeneration,
  resolveNamedImageEngine,
  type ImageGenerationRequest,
} from "../multimodal/image-generation.js";
import {
  IMAGE_SETTINGS_KIND,
  IMAGE_SETTINGS_MAX_ANSWER_BYTES,
  applyImageSettings,
  buildImageSettingsProposal,
  collectBaseCandidates,
  describeAgentMask,
  describeImageSettingsForAgent,
  describeRenderSettings,
  describeReusedMaskForAgent,
  describeSettingsChange,
  truncate,
  validateImageSettingsAnswer,
  type AgentMask,
  type BaseCandidate,
  type BaseCandidateSource,
  type CandidateSourceEntry,
  type ImageSettingsDecision,
  type ImageSettingsProposal,
  type ImageSettingsSource,
} from "../multimodal/image-settings.js";
import { encodeImageAs, transformImage, type ImageTransformOp } from "../multimodal/image-transform.js";
import { readAllFacts, writeSharedFact } from "../swarm/memory.js";
import { getSessionRecord } from "../agent/session.js";
import { holdTurnClocks } from "../agent/user-input-broker.js";
import { DECLINED_BY_USER_METADATA_KEY } from "../agent/user-input.js";
import { currentRequestContext } from "../runtime/request-context.js";
import type { MultimodalImageGenerationConfig } from "../config/schemas/multimodal.js";
import { deriveSharedSessionId } from "./memory.js";
import { resolveProviderEndpointForModel } from "../providers/index.js";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { resolvePathWithinWorkspace, resolveWorkspaceWritePath } from "./workspace-path.js";

const log = childLogger("tool:multimodal");

const MIME_TYPES: Record<string, string> = {
  ".aac": "audio/aac",
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".m4a": "audio/mp4",
  ".md": "text/markdown",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
  ".webp": "image/webp",
};

function bytesToBlob(bytes: Uint8Array, contentType: string): Blob {
  const arrayBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new Blob([arrayBuffer], { type: contentType });
}

function multimodalServiceConfigured(baseUrl: string | undefined): boolean {
  return typeof baseUrl === "string" && baseUrl.trim().length > 0;
}

/**
 * The fastapi-mcp-template REST/MCP endpoint wraps every tool result in
 * `{ success, result: {...} }`, so the actual `{ markdown, ... }` payload lives
 * under `.result`. Other/older conversion backends return it at the top level.
 * Normalize both shapes so callers can read `body.markdown` / `body.error`
 * directly. (Without this, file_to_markdown extraction silently returned ""
 * because `body.markdown` was undefined — the markdown was nested in `result`.)
 */
function unwrapConversionResult(body: Record<string, unknown>): Record<string, unknown> {
  const inner = body["result"];
  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
    return inner as Record<string, unknown>;
  }
  return body;
}

registerTool({
  name: "extract_file_content",
  description: "Convert a workspace file into Markdown using the configured file-conversion backend.",
  embeddingDescription: "Extract, convert, read text from PDF, DOCX, PPTX, XLSX, images, binary documents. Text aus PDF extrahieren, DOCX lesen, Dokument in Markdown konvertieren. OCR, document parsing.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative path to a file inside the workspace" },
    },
    required: ["path"],
  },
  async execute(args, ctx) {
    const path = String(args["path"] ?? "").trim();
    if (!path) return fail("path is required");

    try {
      const file = await readWorkspaceBinaryFile(path, ctx.workspacePath);
      const body = await convertFileToMarkdown(file);
      const markdown = String(body["markdown"] ?? "").trim();
      if (!markdown) return fail(`No markdown content was returned for ${path}`);

      return {
        success: true,
        output: markdown,
        metadata: {
          path,
          filename: typeof body["filename"] === "string" ? body["filename"] : file.filename,
        },
      };
    } catch (error) {
      log.error({ error, path }, "extract_file_content failed");
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
});

registerTool({
  name: "transcribe_audio",
  description: "Transcribe an audio file from the workspace using the configured STT backend.",
  embeddingDescription: "Transcribe, convert, speech-to-text, STT, audio to text. Audio transkribieren, Sprache zu Text, Tonaufnahme abtippen, Mitschrift erzeugen. Whisper, voice recognition.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative path to an audio file inside the workspace" },
      language: { type: "string", description: "Optional language hint, e.g. en or de" },
      prompt: { type: "string", description: "Optional transcription prompt or context" },
      model: { type: "string", description: "Optional STT model override" },
    },
    required: ["path"],
  },
  async execute(args, ctx) {
    const path = String(args["path"] ?? "").trim();
    if (!path) return fail("path is required");

    try {
      const file = await readWorkspaceBinaryFile(path, ctx.workspacePath);
      const config = getConfig().multimodal.stt;
      if (!multimodalServiceConfigured(config.baseUrl)) {
        return fail("STT is disabled: configure multimodal.stt.baseUrl to enable transcription.");
      }
      const response = await sendSttRequest({
        api: config.api,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        timeoutMs: config.timeoutMs,
        model: String(args["model"] ?? config.model),
        audioBlob: bytesToBlob(file.bytes, file.contentType),
        filename: file.filename,
        language: stringArg(args["language"]),
        prompt: stringArg(args["prompt"]),
      });

      if (!response.ok) {
        return fail(await extractUpstreamError(response, "Transcription failed"));
      }

      const body = await parseUpstreamJsonResponse(response, "Transcription returned a non-JSON response");
      // Hoist a nested { result: {...} } envelope so a backend that wraps its payload
      // doesn't make `result` an OBJECT that String()-coerces to "[object Object]"
      // and ships as a bogus successful transcript.
      const payload = unwrapConversionResult(body);
      const segments = Array.isArray(payload["segments"])
        ? payload["segments"].map(segment => {
            if (typeof segment === "string") return segment;
            if (segment && typeof segment === "object" && "text" in segment) return String((segment as Record<string, unknown>)["text"] ?? "");
            return "";
          }).filter(Boolean).join(" ").trim()
        : "";
      // Only accept a STRING transcript candidate — a non-string `result`/`text` must
      // fall through to segments or an honest failure, never coerce to "[object Object]".
      const firstString = (...vals: unknown[]): string => {
        for (const v of vals) if (typeof v === "string" && v.trim()) return v;
        return "";
      };
      const text = (firstString(payload["text"], payload["transcription"], payload["result"]) || segments).trim();
      if (!text) return fail(`No transcript was returned for ${path}`);

      return {
        success: true,
        output: text,
        metadata: {
          path,
          language: payload["language"] ?? payload["detected_language"] ?? payload["lang"],
          duration: payload["duration"] ?? payload["processing_time"],
        },
      };
    } catch (error) {
      log.error({ error, path }, "transcribe_audio failed");
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
});

registerTool({
  name: "list_tts_voices",
  description: "List the available voices from the configured TTS backend.",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  async execute() {
    try {
      const config = getConfig().multimodal.tts;
      if (!multimodalServiceConfigured(config.baseUrl)) {
        return fail("TTS is disabled: configure multimodal.tts.baseUrl to enable voice discovery.");
      }
      const body = await fetchTtsVoiceCatalog(config);
      return {
        success: true,
        output: JSON.stringify(body, null, 2),
        metadata: {
          voiceCount: Array.isArray(body["voices"]) ? body["voices"].length : undefined,
          speakerCount: Array.isArray(body["speakers"]) ? body["speakers"].length : undefined,
        },
      };
    } catch (error) {
      log.error({ error }, "list_tts_voices failed");
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
});

registerTool({
  name: "synthesize_speech",
  description: "Synthesize speech from text and save the generated audio inside the workspace.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text to synthesize" },
      outputPath: { type: "string", description: "Optional relative output path for the generated WAV file" },
      voice: { type: "string", description: "Optional voice name" },
      voiceId: { type: "string", description: "Optional provider voice ID or saved qwen-compatible voice ID" },
      speaker: { type: "string", description: "Optional speaker or voice name" },
      language: { type: "string", description: "Optional language override" },
      quality: { type: "string", description: "Optional quality override" },
      gender: { type: "string", description: "Optional gender hint" },
      speed: { type: "number", description: "Optional playback speed multiplier" },
      model: { type: "string", description: "Optional TTS model override" },
      audioExamplePath: { type: "string", description: "Optional workspace-relative audio example for voice cloning" },
      referenceText: { type: "string", description: "Optional transcript for the audio example" },
      saveVoiceAs: { type: "string", description: "Optional saved voice ID/name to cache from the audio example before synthesis" },
    },
    required: ["text"],
  },
  async execute(args, ctx) {
    const text = String(args["text"] ?? "").trim();
    if (!text) return fail("text is required");

    try {
      const config = getConfig().multimodal.tts;
      if (!multimodalServiceConfigured(config.baseUrl)) {
        return fail("TTS is disabled: configure multimodal.tts.baseUrl to enable speech synthesis.");
      }
      const explicitAudioExamplePath = stringArg(args["audioExamplePath"]);
      const explicitReferenceText = stringArg(args["referenceText"]);
      const explicitSaveVoiceAs = stringArg(args["saveVoiceAs"]);
      const audioExamplePath = explicitAudioExamplePath ?? config.voiceSamplePath;
      const referenceText = explicitReferenceText ?? config.voiceSampleText;
      const savedVoiceId = stringArg(args["voiceId"]) ?? stringArg(args["voice"]) ?? config.defaultVoiceId;
      const speaker = stringArg(args["speaker"]) ?? (savedVoiceId ? undefined : config.defaultSpeaker);
      const response = await sendTtsRequest({
        api: config.api,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        timeoutMs: config.timeoutMs,
        text,
        model: stringArg(args["model"]) ?? config.model,
        language: String(args["language"] ?? config.defaultLanguage),
        quality: String(args["quality"] ?? config.defaultQuality),
        gender: stringArg(args["gender"]),
        speed: typeof args["speed"] === "number" ? args["speed"] : 1,
        speaker,
        savedVoiceId,
        audioExample: audioExamplePath ? await readWorkspaceBinaryFile(audioExamplePath, ctx.workspacePath) : undefined,
        referenceText,
        saveVoiceAs: explicitSaveVoiceAs,
        allowVoiceCloneFallback: !explicitAudioExamplePath && !explicitReferenceText && !explicitSaveVoiceAs,
      });

      if (!response.ok) {
        return fail(await extractUpstreamError(response, "Speech synthesis failed"));
      }

      const audio = new Uint8Array(await response.arrayBuffer());
      const requestedOutputPath = stringArg(args["outputPath"]);
      const outputPath = requestedOutputPath ?? `tts-${Date.now()}.wav`;
      const resolvedOutput = requestedOutputPath
        ? resolveWorkspacePath(outputPath, ctx.workspacePath)
        : resolveDefaultArtifactPath(outputPath, ctx.workspacePath);
      await mkdir(resolve(resolvedOutput.resolved, ".."), { recursive: true });
      await writeFile(resolvedOutput.resolved, audio);

      // REPORT WHERE THE FILE IS, NOT WHERE IT WAS ASKED FOR. The write goes to the RESOLVED
      // path — which the zoning may re-root, and which the per-user artifact partition
      // certainly does — while the raw request was what came back in the output text and the
      // artifact record. Anything that later opens the reported path (the artifact probe, the
      // serve routes, the model's own next read) was looking somewhere the file is not.
      return {
        success: true,
        output: `Audio saved to ${resolvedOutput.relativePath}`,
        metadata: {
          outputPath: resolvedOutput.relativePath,
          requestedPath: outputPath,
          bytes: audio.byteLength,
          contentType: response.headers.get("content-type") ?? "audio/wav",
        },
      };
    } catch (error) {
      log.error({ error }, "synthesize_speech failed");
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
});

registerTool({
  name: "analyze_image",
  description: "Analyze an image file from the workspace with the configured vision-capable LLM.",
  embeddingDescription: "Analyze, describe, interpret, caption an image, photo, screenshot, diagram. Bild analysieren, Foto beschreiben, Screenshot interpretieren, visuelle Analyse. Image understanding, OCR visual.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative path to an image inside the workspace" },
      prompt: { type: "string", description: "Optional analysis instructions for the vision model" },
      model: { type: "string", description: "Optional vision model override, e.g. lmstudio/qwen2-vl" },
    },
    required: ["path"],
  },
  async execute(args, ctx) {
    const path = String(args["path"] ?? "").trim();
    if (!path) return fail("path is required");

    try {
      const file = await readWorkspaceBinaryFile(path, ctx.workspacePath);
      if (!file.contentType.startsWith("image/")) {
        return fail(`Unsupported image type for ${path}`);
      }

      const configuredModel = stringArg(args["model"]) ?? getConfig().multimodal.files.visionModel;
      if (!configuredModel) {
        return fail("No vision model is configured. Set multimodal.files.visionModel or pass a model override.");
      }

      const instruction = stringArg(args["prompt"])
        ?? "Analyze this image in detail. Extract all visible text exactly as written. Identify key UI elements, data, charts, error messages, or any other relevant content. Return a structured Markdown response.";
      const markdown = await analyzeImageBytes(file.bytes, file.contentType, configuredModel, instruction);
      if (!markdown) {
        return fail(`Vision model returned no usable analysis for ${path}`);
      }

      return {
        success: true,
        output: markdown,
        metadata: { path, model: configuredModel },
      };
    } catch (error) {
      log.error({ error, path }, "analyze_image failed");
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
});

/** Drop a trailing extension without touching directory separators in the path. */
function stripFileExtension(value: string): string {
  const ext = extname(value);
  return ext ? value.slice(0, -ext.length) : value;
}

/**
 * Publish a produced image where the NEXT agent can find it, without anyone remembering to.
 *
 * Session 2c6bdb30: turn one generated a sunset, turn two was asked to make it realistic. The
 * orchestrator's task said "basierend auf dem Originalbild" and named no path, and turn one's
 * agent had not called share_finding, so the shared facts were empty. image_creator then
 * probed `/workspace/workspace/users/<seg>`, `workspace/users/<seg>` and the same path again
 * — all directories, all ENOENT — and fell back to a fresh generation. The user got another
 * unrelated beach and no indication that "based on the original" had been dropped.
 *
 * Relying on the producing agent to publish is what failed: it is one instruction among
 * many, and turn one skipped it. Writing the fact here makes the path available whether or
 * not any agent remembers, under the SHARED session id so a sibling or a later turn sees it
 * rather than only the sub-session that made it.
 *
 * Best-effort by construction: a memory backend that is down must never fail a generation
 * that already succeeded and is already on disk.
 */
async function publishImageArtifact(sessionId: string | undefined, relativePath: string): Promise<void> {
  if (!sessionId) return;
  try {
    const shared = deriveSharedSessionId(sessionId);
    // A stable pointer for "the image we just made", plus a durable per-file entry, because
    // "the previous one" and "the one called sunset_beach" are both things users say.
    await writeSharedFact(shared, "latest_image", relativePath);
    await writeSharedFact(shared, `image:${basename(relativePath)}`, relativePath);
  } catch {
    // Nothing here is worth failing a finished image for.
  }
}


/** Test seam: the handoff is the behaviour under test, not an implementation detail. */
export const publishImageArtifactForTests = publishImageArtifact;

registerTool({
  name: "transform_image",
  description:
    "Apply exact, deterministic edits to an existing image in the workspace: sharpen, soften,"
    + " resize, crop, rotate, flip, brightness, contrast, grayscale, normalize. Runs locally in"
    + " milliseconds and costs the cluster nothing — it does NOT re-generate the picture, so"
    + " everything you are not changing stays exactly as it was. Use this, never the image model,"
    + " when the request is about the image as a picture rather than about its content.",
  embeddingDescription:
    "Sharpen, soften, blur, resize, scale, crop, trim, rotate, flip, brighten, darken, contrast,"
    + " grayscale, black and white, normalize an existing image. Bild schärfen, weichzeichnen,"
    + " skalieren, zuschneiden, drehen, spiegeln, heller, dunkler, Kontrast, Graustufen."
    + " Post-processing, retouch, adjust a picture without regenerating it.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative workspace path to the image to transform" },
      operations: {
        type: "array",
        description:
          "Operations applied IN ORDER, so one call can crop and then sharpen. Each item is"
          + " {op, ...}: sharpen{amount 0-3, default 1}, soften{radius 1-144, default 2},"
          + " resize{width?, height?} (omit one to keep the aspect ratio), crop{x,y,width,height},"
          + " rotate{degrees}, flip{horizontal?, vertical?}, brightness{amount -1..1},"
          + " contrast{amount -1..1}, grayscale{}, normalize{}.",
        items: { type: "object" },
      },
      outputPath: {
        type: "string",
        description:
          "Optional relative output path. Omitted, the result is written NEXT TO the source with a"
          + " suffix — the original is never overwritten, so an unwanted edit costs nothing.",
      },
    },
    required: ["path", "operations"],
  },
  async execute(args, ctx) {
    const path = String(args["path"] ?? "").trim();
    if (!path) return fail("path is required");
    const operations = Array.isArray(args["operations"]) ? args["operations"] as ImageTransformOp[] : [];
    if (operations.length === 0) {
      return fail("operations is required — e.g. [{\"op\":\"sharpen\",\"amount\":0.5}]");
    }

    try {
      const source = await readWorkspaceBinaryFile(path, ctx.workspacePath);
      const result = await transformImage(Buffer.from(source.bytes), operations);

      const requested = stringArg(args["outputPath"]);
      // Same rule as generate_image: the bytes decide the extension. transformImage returns
      // PNG, so a caller naming ".jpg" is encoded to JPEG rather than mislabelled.
      const requestedExt = requested ? extname(requested).toLowerCase() : "";
      const encoded = await encodeImageAs(result.bytes, requestedExt, ".png");
      // A sibling by default. Overwriting the source would destroy the only copy of an image
      // that may have cost minutes of GPU, and an edit the user dislikes would be unrecoverable.
      const outputPath = requested
        ? (requestedExt
            ? `${stripFileExtension(requested)}${encoded.extension}`
            : `${requested}${encoded.extension}`)
        : `${stripFileExtension(path)}-edited-${Date.now()}${encoded.extension}`;
      const resolved = resolveWorkspacePath(outputPath, ctx.workspacePath);
      await mkdir(resolve(resolved.resolved, ".."), { recursive: true });
      await writeFile(resolved.resolved, encoded.bytes);
      await publishImageArtifact(ctx.sessionId, resolved.relativePath);

      const resized = result.before.width !== result.after.width || result.before.height !== result.after.height;
      return {
        success: true,
        output: `Applied ${result.applied.join(", ")} to ${path}. Saved to ${resolved.relativePath}`
          + (resized ? ` (${result.before.width}x${result.before.height} -> ${result.after.width}x${result.after.height})` : ""),
        metadata: {
          sourcePath: path,
          outputPath: resolved.relativePath,
          filename: basename(resolved.relativePath),
          bytes: encoded.bytes.byteLength,
          contentType: encoded.mimeType,
          applied: result.applied,
          width: result.after.width,
          height: result.after.height,
          originalWidth: result.before.width,
          originalHeight: result.before.height,
        },
      };
    } catch (error) {
      log.error({ error, path }, "transform_image failed");
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
});

const GENERATE_IMAGE_DESCRIPTION =
  "Generate an image from a text prompt and save it to the workspace. Two tiers: `fast` (the default,"
  + " ~10s on dedicated hardware, costs the rest of the system nothing) and `quality` (~2-3 min, runs one"
  + " at a time cluster-wide and slows every other model on that machine while it runs). See the `tier`"
  + " parameter for when each is right. In a chat the user may first see your settings and keep them,"
  + " change engine, prompt, size, steps, seed or base picture, paint a mask, or skip the render; the"
  + " output says which settings ran and who chose them. Report those, and never re-render to restore yours.";

/**
 * The engines behind the tiers, named, so "the qwen model" can be matched to a tier.
 *
 * Read from config each time the description is read rather than baked in at registration:
 * the names belong to the deployment, not to this file. Deterministic for a given config, so
 * the tool block stays byte-identical between calls and only moves when the config does.
 */
function describeImageEngines(): string {
  try {
    const config = getConfig().multimodal?.imageGeneration;
    const engines = config ? describeImageTierChoices(config) : "";
    // The server's limit, so the agent does not propose a render it would cut off.
    const limit = config?.maxRenderMs
      ? ` The image server gives up on any render after ${Math.round(config.maxRenderMs / 60_000)} min, and a render`
        + " expected to take longer is refused before it runs: more steps, a larger size and guidance above an engine's"
        + " default of 1 or less (which doubles the time) all make it longer."
      : "";
    return (engines ? ` Engines: ${engines}. A user who names one of these is asking for that tier.` : "") + limit;
  } catch {
    return "";
  }
}

registerTool({
  name: "generate_image",
  get description() {
    return GENERATE_IMAGE_DESCRIPTION + describeImageEngines();
  },
  embeddingDescription: "Generate, create, make an image, picture, illustration from a text prompt. Bild generieren, erzeugen, Illustration erstellen, KI-Bild aus Text. AI image generation, DALL-E style.",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "Text description of the image to generate. It sets the VISUAL REGISTER — photograph,"
          + " illustration, painting — so write it in the register the user asked for, and put"
          + " the register FIRST: measured here with the seed pinned, the fast engine rendered"
          + " one 250-word description as a painting when its camera terms came last and as a"
          + " photograph when they led, on two seeds out of two. Decorative wording"
          + " ('beautiful', 'vibrant', 'stunning', named saturated colours) produces a stylised,"
          + " poster-like image; for a photograph describe one the way a photographer would —"
          + " camera and lens, natural unedited colour, real material texture, haze or grain."
          + " Wording cannot make the fast engine follow a detailed layout; see `tier`.",
      },
      model: {
        type: "string",
        description:
          "Rarely needed — choose the engine with `tier`. Accepts only the model ids or engine names"
          + " listed in this tool's description; any other name is refused before anything renders.",
      },
      negativePrompt: { type: "string", description: "Optional negative prompt to steer generation away from unwanted content" },
      width: {
        type: "number",
        description:
          "OMIT THIS unless you know the backend accepts the size. Nothing is resampled: a backend that"
          + " generates one fixed resolution REJECTS any other width outright, costing a wasted call."
          + " Leaving it out uses the configured default, which always fits. At most 2048.",
      },
      height: {
        type: "number",
        description: "OMIT THIS. Same rule as `width` — leaving it out uses the configured default.",
      },
      steps: {
        type: "number",
        description: "Number of diffusion steps, 1 to 100 (higher = better quality, slower: the render time grows with them). Omit to use the configured default.",
      },
      guidanceScale: { type: "number", description: "Guidance scale — how closely the model follows the prompt. Omit to use the configured default." },
      seed: { type: "number", description: "Optional random seed for reproducible results" },
      tier: {
        type: "string",
        enum: ["fast", "quality"],
        description:
          "Which engine renders it. 'fast' is the default: about ten seconds on dedicated hardware,"
          + " costing the rest of the system nothing — right for an ordinary picture, a realistic"
          + " one included (with the register first it comes back photographic). 'quality' takes"
          + " two to three minutes, runs one at a time across the whole cluster and slows every"
          + " other model on that machine by roughly 70% while it runs. Choose 'quality' when the"
          + " user was unhappy with a fast result or asks for a better one, names the quality"
          + " engine, or when the new picture must keep an EXISTING picture's layout: measured here"
          + " with the seed pinned, the fast engine ignored a described layout in 6 renders out of"
          + " 6, while the quality engine followed it. A user who names an engine or tier gets"
          + " exactly that one; if it fails, say so — never render on the other tier and present"
          + " it as what they asked for.",
      },
      baseImage: {
        type: "string",
        description:
          "Relative workspace path to an existing image to EDIT rather than replace. Use this when"
          + " the user wants something changed INSIDE a picture while its look stays — add, remove,"
          + " fix, recolour — because without it the elements they asked to keep will disappear."
          + " Do NOT use it to change the picture's LOOK ('make it realistic', 'as a painting'):"
          + " an edit inherits its base's look at every strength that keeps the layout, so the"
          + " result comes back in the old style. For that, describe the existing layout in the"
          + " prompt and generate without baseImage on tier 'quality' — measured here, that engine"
          + " reproduced a described layout as a photograph, where a 0.75 edit of the same picture"
          + " stayed an illustration and the fast engine ignored the layout. If the"
          + " backend cannot edit, this fails with a clear message: report that honestly instead"
          + " of passing a fresh generation off as a revision.",
      },
      strength: {
        type: "number",
        description:
          "With `baseImage`, how much of the original is re-rendered, 0 to 1. Low (0.2-0.35)"
          + " moves tone and colour only and cannot add or remove anything; 0.65-0.8 rebuilds"
          + " most of the content while the broad layout survives; above ~0.85 keeps nothing"
          + " and is a fresh image with extra steps. Defaults to 0.45. To ADD, REMOVE or"
          + " REPLACE something while keeping the rest, pair `mask` with 0.6-0.85: only the"
          + " masked region is rebuilt."
          + " WHAT STRENGTH CANNOT DO: it does not change the VISUAL REGISTER of the base."
          + " An edit inherits whether its base looks like a photograph, an illustration or a"
          + " painting, at every strength that still preserves the composition. Measured: a"
          + " stylised base edited at 0.75 with an explicitly photographic prompt AND an"
          + " anti-illustration negative prompt stayed an illustration (mean pixel distance"
          + " from the base 31.2, against 32.7 for a plain prompt — the prompt work bought"
          + " nothing), while the SAME call from a photographic base stayed photographic. So if"
          + " the user asks for a different register ('make it real', 'less cartoonish'),"
          + " raising strength will NOT deliver it. Generate a new image instead on tier 'quality',"
          + " describing the composition you want to keep in words, and say plainly that the composition"
          + " is re-interpreted rather than preserved. Use an edit for what an edit does: keep"
          + " this picture, change something in it.",
      },
      mask: {
        type: "string",
        description:
          "With `baseImage`, a relative workspace path to an RGBA PNG selecting WHICH REGION may"
          + " change — everything outside it is returned untouched. ALPHA semantics: a"
          + " TRANSPARENT pixel may be edited, an OPAQUE pixel is protected. Getting that"
          + " backwards edits exactly the part the user wanted kept and still returns a"
          + " perfectly plausible picture, so never guess the polarity. The mask must select"
          + " something and not everything; both are rejected. Pass one only when a mask file"
          + " already exists — you cannot draw one, and inventing a path fails. In a chat the user"
          + " can paint one in the settings step, so for add/remove/replace without a mask still"
          + " call with baseImage; a mask they painted is kept as the shared fact `latest_mask`. It selects"
          + " one region of the pictures in `latest_mask_base`: reuse it only to change that SAME region again;"
          + " for another region or picture call without it — it is refused on any other picture."
          + " Useful for 'change only the sky', 'replace the car', 'leave her face alone'."
          + " LIMIT: the model never sees the"
          + " mask — the region is composited in — so this REPLACES a region cleanly but cannot"
          + " continue existing content across it. 'Extend this wall into the gap' will not"
          + " work; 'put boulders on this beach' will.",
      },
      maskBlur: {
        type: "number",
        description:
          "Feather width in pixels for the mask edge, with `mask`. Around 24 is a good default;"
          + " 0 gives a hard cut. Without feathering the composited region meets the original"
          + " at a visible seam.",
      },
      outputPath: { type: "string", description: "Optional relative output path inside the workspace for the generated PNG" },
    },
    required: ["prompt"],
  },
  async execute(args, ctx) {
    const prompt = String(args["prompt"] ?? "").trim();
    if (!prompt) return fail("prompt is required");

    try {
      const config = getConfig().multimodal.imageGeneration;
      if (!config) {
        return fail("Image generation is not configured. Add multimodal.imageGeneration to starlingai.json.");
      }
      if (!imageGenerationServiceConfigured(config.baseUrl)) {
        return fail("Image generation is disabled: configure multimodal.imageGeneration.baseUrl to enable it.");
      }

      // Names are checked HERE, before anything touches the backend. Session f4ebf47b sent
      // `model: "Qwen"`, the router answered 404, and the agent's only recovery was to drop the
      // name — which lands on the fast tier, the opposite of what the user asked for. A refusal
      // that lists what exists costs one cheap iteration and points at the right engine.
      const choices = imageTierChoices(config);
      const statedTier = stringArg(args["tier"])?.toLowerCase();
      if (statedTier && statedTier !== "fast" && statedTier !== "quality") {
        return fail(
          `Unknown tier "${stringArg(args["tier"])}". This deployment has: ${describeImageTierChoices(config) || "`fast`"}.`
          + " Nothing was rendered.",
        );
      }
      let requestedTier = statedTier as "fast" | "quality" | undefined;
      const namedModel = stringArg(args["model"]);
      if (namedModel && choices.length > 0) {
        const tierOfName = resolveNamedImageEngine(config, namedModel);
        if (!tierOfName) {
          return fail(
            `Unknown image engine "${namedModel}". This deployment has: ${describeImageTierChoices(config)}.`
            + " Choose one with `tier` and omit `model`. Nothing was rendered.",
          );
        }
        // The engine the user named wins over a tier stated beside it — the same rule the
        // library applies — and only the tier travels on, so the backend resolves its own model.
        requestedTier = tierOfName;
      }

      // Held to what may be rendered before anything else runs: the render's budget grows with its
      // steps and size, so 1000 steps at 2048x2048 would have been offered on the settings card as a
      // 19-hour render.
      const outOfBounds = imageRequestBoundsError({
        ...(typeof args["steps"] === "number" ? { steps: args["steps"] } : {}),
        ...(typeof args["width"] === "number" ? { width: args["width"] } : {}),
        ...(typeof args["height"] === "number" ? { height: args["height"] } : {}),
      });
      if (outOfBounds) {
        return fail(`${outOfBounds}. Nothing was rendered: call again within those bounds, or leave them out for the engine's defaults.`);
      }

      const health = await checkImageGenerationHealth(config);
      if (!health.ok) {
        if (health.disabled) {
          return fail(health.error ?? "Image generation is disabled.");
        }
        if (health.status) {
          return fail(`Image generation service is unhealthy (${health.status}). Do not retry - inform the user.`);
        }
        return fail(`Image generation service is offline (${config.baseUrl}). The endpoint is unavailable. Do not retry - inform the user.`);
      }

      // Pass the tier ONLY when the caller stated one (or named an engine, above). Forcing
      // "fast" on every call that omitted it is what made editing unreachable:
      // requestImageGeneration then had no way to tell "the caller wants fast" from "the caller
      // did not say", so a baseImage request was pinned to a tier that cannot edit and refused.
      // An unknown tier used to fall back to fast silently; it is refused above instead,
      // because a quiet fallback is the same wrong-engine outcome with no one told.
      // The tiers want DIFFERENT sampling defaults and both read the fields. Measured with
      // the seed pinned so only the parameter could vary: the fast tier renders differently
      // at guidance 1.0 than at 7.5, and the quality tier costs 22s at guidance 4 against
      // 11s at 1.0 because its model carries embedded guidance and true CFG doubles the
      // forward passes. One shared default is wrong for one of them whichever value it takes.
      // Read the base image before anything else touches the backend, so a bad path fails
      // immediately rather than after a two-minute render.
      let baseFile: WorkspaceBinaryFile | undefined;
      const baseImagePath = stringArg(args["baseImage"]);
      if (baseImagePath) {
        try {
          baseFile = await readWorkspaceBinaryFile(baseImagePath, ctx.workspacePath);
        } catch (error) {
          return fail(
            `Could not read baseImage "${baseImagePath}": ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      let maskFile: WorkspaceBinaryFile | undefined;
      const maskPath = stringArg(args["mask"]);
      if (maskPath) {
        try {
          maskFile = await readWorkspaceBinaryFile(maskPath, ctx.workspacePath);
        } catch (error) {
          return fail(
            `Could not read mask "${maskPath}": ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      // A painted mask selects one region of ONE picture, and the agent cannot see which. Offered
      // for any later edit, it rebuilt the sky again when the user had asked to remove the boat.
      let paintedMaskFor: string | undefined;
      if (maskFile && baseFile) {
        const fits = await paintedMaskFits(ctx, maskFile.relativePath);
        paintedMaskFor = fits?.[0];
        if (fits && !fits.includes(baseFile.relativePath)) {
          return fail(
            `The mask ${maskFile.relativePath} was painted for ${fits[0]}, not for ${baseFile.relativePath}: a mask`
            + " selects one region of one picture. Nothing was rendered. For another picture or another region, call"
            + " generate_image without `mask`; in a chat the user paints the region in the settings step.",
          );
        }
      }

      const agentRequest: ImageGenerationRequest = {
        prompt,
        ...(requestedTier ? { tier: requestedTier } : {}),
        // No `?? config.model` here: the backend resolves the tier's model itself, and
        // defaulting to the fast model would silently turn a quality request into a fast one.
        // A name is forwarded only where no engines are configured to check it against.
        ...(namedModel && choices.length === 0 ? { model: namedModel } : {}),
        // Only what the caller asked for; requestImageGeneration applies the tier's defaults.
        ...(stringArg(args["negativePrompt"]) ? { negativePrompt: stringArg(args["negativePrompt"])! } : {}),
        ...(typeof args["width"] === "number" ? { width: args["width"] } : {}),
        ...(typeof args["height"] === "number" ? { height: args["height"] } : {}),
        ...(typeof args["steps"] === "number" ? { steps: args["steps"] } : {}),
        ...(typeof args["guidanceScale"] === "number" ? { guidanceScale: args["guidanceScale"] } : {}),
        ...(typeof args["seed"] === "number" ? { seed: args["seed"] } : {}),
        ...(baseFile ? { initImage: Buffer.from(baseFile.bytes).toString("base64") } : {}),
        ...(typeof args["strength"] === "number" ? { strength: args["strength"] } : {}),
        ...(maskFile ? { mask: Buffer.from(maskFile.bytes).toString("base64") } : {}),
        ...(typeof args["maskBlur"] === "number" ? { maskBlur: args["maskBlur"] } : {}),
      };

      // A picture the person skipped is not put to them again in the same turn. The skip told the
      // agent not to retry; it sent the same picture again seconds later, and again after the
      // second skip (session fa673f2c). The refusal is flagged as theirs, like the skip itself.
      const skipKey = skippedRenderKey(agentRequest.prompt, baseFile?.relativePath);
      if (ctx.turnUserWords && skippedRenders.get(ctx.turnUserWords)?.has(skipKey)) {
        return {
          ...fail(
            "The user already skipped this picture in the settings step this turn, so it was not put to them again"
            + " and nothing was rendered. Do not call generate_image for it again: finish, and say the render was skipped.",
          ),
          metadata: { settings: { source: "user_skipped", changed: [], waitedMs: 0 }, [DECLINED_BY_USER_METADATA_KEY]: true },
        };
      }

      // A render the image server would cut off is refused before anyone is asked to approve it,
      // with what would fit: the agent can correct it before the person ever sees it.
      const tooLong = imageRenderLimitError(
        config,
        previewImageRequest(config, agentRequest, baseFile ? readImageHeaderSize(baseFile.bytes) : undefined),
      );
      if (tooLong) return fail(tooLong);

      // The person may now take, change or skip what the agent chose. Asked AFTER the health
      // probe, so an offline backend never keeps anyone waiting, and after the agent's own base
      // and mask were read, so a bad path fails at once and the agent's picture can be offered.
      const settingsStep = await askForImageSettings(ctx, config, agentRequest, { base: baseFile, mask: maskFile, paintedMaskFor });
      if (settingsStep.stop) {
        // A Skip is the person's choice, not a broken render: flagged, so the run record lists it
        // apart from the calls that failed instead of telling the orchestrator the render broke.
        const declined = settingsStep.metadata?.["source"] === "user_skipped";
        if (declined && ctx.turnUserWords) {
          const skipped = skippedRenders.get(ctx.turnUserWords) ?? new Set<string>();
          skippedRenders.set(ctx.turnUserWords, skipped.add(skipKey));
        }
        return {
          ...fail(settingsStep.stop),
          ...(settingsStep.metadata
            ? { metadata: { settings: settingsStep.metadata, ...(declined ? { [DECLINED_BY_USER_METADATA_KEY]: true } : {}) } }
            : {}),
        };
      }

      // A render the person approved in the settings step runs as long as its settings need —
      // minutes, on the quality engine — and none of the run's clocks may read that as a stall
      // (session 807684e9). Held for the render only, and only where somebody really answered.
      const release = settingsStep.answered ? holdTurnClocks(ctx.sessionId, "image_render") : undefined;
      let result: Awaited<ReturnType<typeof requestImageGeneration>>;
      try {
        result = await requestImageGeneration(config, settingsStep.request);
      } catch (error) {
        if (error instanceof ImageRenderTooLongError) return fail(error.message);
        if (!(error instanceof ImageGenerationTimeoutError)) throw error;
        return timedOutRender(error, settingsStep.metadata);
      } finally {
        release?.();
      }

      // Its picture is one the painted mask fits, so the tool cannot tell a second change to the
      // same region from a different change; only a person looking can, and the output says whether one did.
      const maskNote = paintedMaskFor && agentRequest.mask && settingsStep.request.mask === agentRequest.mask
        ? describeReusedMaskForAgent(paintedMaskFor, settingsStep.metadata?.["source"] as ImageSettingsSource | undefined)
        : "";

      const imageBytes = Buffer.from(result.imageBase64, "base64");
      const requestedOutputPath = stringArg(args["outputPath"]);
      // The backend produces PNG only, so a caller naming ".jpg" used to get PNG bytes under
      // that name. The artifact verifier then refused the file and the swarm burned eight
      // minutes trying to repair it. Encode into the format actually asked for, or correct
      // the name — never write a mismatch.
      const requestedExtension = requestedOutputPath ? extname(requestedOutputPath).toLowerCase() : "";
      const encoded = await encodeImageAs(imageBytes, requestedExtension, result.extension);
      const outputPath = requestedOutputPath
        ? (requestedExtension
            ? `${stripFileExtension(requestedOutputPath)}${encoded.extension}`
            : `${requestedOutputPath}${encoded.extension}`)
        : `image-${Date.now()}${encoded.extension}`;
      const resolvedOutput = requestedOutputPath
        ? resolveWorkspacePath(outputPath, ctx.workspacePath)
        : resolveDefaultArtifactPath(outputPath, ctx.workspacePath);
      await mkdir(resolve(resolvedOutput.resolved, ".."), { recursive: true });
      await writeFile(resolvedOutput.resolved, encoded.bytes);
      await publishImageArtifact(ctx.sessionId, resolvedOutput.relativePath);
      await recordMaskedRender(ctx, settingsStep, maskFile, resolvedOutput.relativePath);

      // Which engine rendered it is said in the OUTPUT, not only in metadata. The specialist
      // reads the output and nothing else; in f4ebf47b it retried on the fast tier after a
      // failed named-model call, never learned the difference, and the picture was reported
      // as the engine the user asked for.
      const engine = imageEngineLabel(config, result.tier);
      const seconds = typeof result.elapsedMs === "number" ? ` in ${(result.elapsedMs / 1000).toFixed(1)} s` : "";
      // Not in that time, and minutes long after a timeout: said, or the slow answer is unexplained.
      const waited = result.deviceWaitMs
        ? `, after waiting ${Math.round(result.deviceWaitMs / 1000)} s for the engine to finish an earlier render that timed out`
        : "";
      const renderedBy = result.tier
        ? `on the ${result.tier} tier${engine ? ` (${engine})` : result.model ? ` (model ${result.model})` : ""}${seconds}${waited}`
        : "";

      // Same as synthesize_speech above: the resolved path is the one the bytes are at.
      return {
        success: true,
        output: `Image generated${renderedBy ? ` ${renderedBy}` : " successfully"}. Saved to ${resolvedOutput.relativePath}`
          + settingsStep.note
          + maskNote
          + (result.tierUpgradedForEdit
            ? ` — NOTE: editing is only available on the slower quality tier, so this used it`
              + " rather than the fast one. Say so if the user asked for speed."
            : "")
          + (encoded.correctedFrom
            ? ` — NOTE: ${encoded.correctedFrom} cannot be produced here, so the file is ${encoded.extension}.`
              + " Use this path; the one you asked for does not exist."
            : ""),
        metadata: {
          outputPath: resolvedOutput.relativePath,
          requestedPath: outputPath,
          filename: basename(resolvedOutput.relativePath),
          bytes: encoded.bytes.byteLength,
          contentType: encoded.mimeType,
          dataUrl: `data:${encoded.mimeType};base64,${encoded.bytes.toString("base64")}`,
          ...(encoded.correctedFrom ? { requestedFormat: encoded.correctedFrom, writtenFormat: encoded.extension } : {}),
          width: result.width,
          height: result.height,
          seed: result.seed,
          model: result.model,
          tier: result.tier,
          ...(engine ? { engine } : {}),
          elapsedMs: result.elapsedMs,
          ...(result.deviceWaitMs ? { deviceWaitMs: result.deviceWaitMs } : {}),
          ...(settingsStep.metadata ? { settings: settingsStep.metadata } : {}),
        },
      };
    } catch (error) {
      // `err`, the key the logger serializes: under `error` the row read {} and hid the cause.
      log.error({ err: error }, "generate_image failed");
      const msg = error instanceof Error ? error.message : String(error);
      // "Offline" only for an endpoint that could not be reached at all. Any "fetch failed" used to
      // read as offline — including a render cut short on the way, which is what session 9cc3f362
      // was told twice while the service was up and had rendered a picture a minute earlier.
      if (error instanceof ImageUpstreamRequestError && error.unreachable) {
        const config = getConfig().multimodal?.imageGeneration;
        return fail(`Image generation service is offline (${config?.baseUrl ?? "not configured"}). The endpoint is unavailable. Do not retry - inform the user the service is unavailable.`);
      }
      return fail(msg);
    }
  },
});

/** What the settings step decided: the request to render, and what to tell the agent about it. */
interface ImageSettingsStep {
  request: ImageGenerationRequest;
  /** Appended to the tool output; empty where nobody could be asked. */
  note: string;
  /** metadata.settings: who chose, what changed, how long the person took. */
  metadata?: Record<string, unknown>;
  /** Set when nothing may be rendered; the tool fails with it. */
  stop?: string;
  /** The person answered — Auto or their own settings — rather than a deadline or a standing choice. */
  answered?: boolean;
}

/**
 * The pictures the person skipped in the settings step, per turn. Keyed by the turn's own words
 * object — one per turn, handed by reference to every specialist in it — so a skip holds for the
 * whole turn and is forgotten with it: the next message is free to ask for the picture again.
 */
const skippedRenders = new WeakMap<object, Set<string>>();

/** The same picture: the same prompt (spacing and case aside) on the same base, whatever the settings. */
function skippedRenderKey(prompt: string, basePath: string | undefined): string {
  return `${prompt.replace(/\s+/g, " ").trim().toLowerCase()}\u0000${basePath ?? ""}`;
}

/**
 * A render that ran out of its time, as the agent must hear it: the error names the engine, the
 * limit, the settings and what they were expected to take, and that the same settings must not be
 * tried again. `dispatchUncertain`, because the engine is still rendering what we abandoned.
 */
function timedOutRender(error: ImageGenerationTimeoutError, settings: Record<string, unknown> | undefined): ToolResult {
  const { tier, model, timeoutMs, expectedSeconds, steps, width, height, cutByServerAfterMs } = error.details;
  return {
    success: false,
    output: "",
    error: error.message,
    dispatchUncertain: true,
    metadata: {
      timedOut: true,
      tier,
      ...(model ? { model } : {}),
      timeoutMs,
      ...(cutByServerAfterMs !== undefined ? { cutByServerAfterMs } : {}),
      expectedSeconds: Math.round(expectedSeconds),
      steps,
      width,
      height,
      ...(settings ? { settings } : {}),
    },
  };
}

/**
 * Put the render to the person before it runs (multimodal/image-settings.ts). Asked on EVERY call:
 * a repeat call is a new render, and "make another one" deserves the same chance to change it.
 * Where nobody can answer, or the chat is set to Auto, the broker says so at once and the agent's
 * request runs unchanged; the proposal is only built when someone will really see it.
 */
async function askForImageSettings(
  ctx: ToolContext,
  config: MultimodalImageGenerationConfig,
  agentRequest: ImageGenerationRequest,
  agentFiles: { base?: WorkspaceBinaryFile; mask?: WorkspaceBinaryFile; paintedMaskFor?: string | undefined },
): Promise<ImageSettingsStep> {
  const prompt = config.settingsPrompt;
  if (!ctx.requestUserInput || prompt?.enabled === false) return { request: agentRequest, note: "" };

  let candidates: BaseCandidate[] = [];
  let agentMask: AgentMask | undefined;
  let proposal: ImageSettingsProposal | undefined;
  const outcome = await ctx.requestUserInput<ImageSettingsDecision>({
    kind: IMAGE_SETTINGS_KIND,
    // Says who is asking and for what; the card and form already label themselves as settings.
    title: `${ctx.currentAgentName ?? "The assistant"} wants to ${agentRequest.initImage ? "edit a picture" : "render a new picture"}`,
    payload: async () => {
      // Even at a cap of 0 the agent's own base is offered (see collectBaseCandidates).
      const max = prompt?.maxBaseCandidates ?? 6;
      candidates = await collectBaseCandidates(await baseCandidateEntries(ctx, agentFiles.base, max), max);
      agentMask = agentFiles.mask ? await describeAgentMask(agentFiles.mask.bytes, agentFiles.mask.relativePath) : undefined;
      // Said on the card, so an Auto on it is an Auto on that region.
      if (agentMask && agentFiles.paintedMaskFor) agentMask = { ...agentMask, paintedEarlier: true };
      proposal = buildImageSettingsProposal(config, agentRequest, candidates, agentMask);
      return proposal as unknown as Record<string, unknown>;
    },
    ...(prompt?.timeoutMs ? { timeoutMs: prompt.timeoutMs } : {}),
    ...(prompt?.configureTimeoutMs ? { holdTimeoutMs: prompt.configureTimeoutMs } : {}),
    maxAnswerBytes: IMAGE_SETTINGS_MAX_ANSWER_BYTES,
    validate: (answer) => proposal
      ? validateImageSettingsAnswer(answer, { config, proposal, candidates, ...(agentMask ? { agentMask } : {}) })
      : { ok: false, errors: [{ field: "inputId", message: "expired" }] },
    preview: (candidateId) => {
      const candidate = candidates.find((entry) => entry.id === candidateId);
      return candidate
        ? { dataUrl: `data:${candidate.mime};base64,${candidate.bytes.toString("base64")}`, width: candidate.width, height: candidate.height }
        : null;
    },
    autoIf: (settings) => settings.imageSettingsPrompt === "auto",
  });

  const decision = "value" in outcome ? outcome.value : undefined;
  if (decision?.alwaysAuto && outcome.rootSessionId) {
    // "Always Auto in this chat": a standing choice for the chat, read by every later render.
    getSessionRecord(outcome.rootSessionId)?.setSettings({ imageSettingsPrompt: "auto" });
  }

  if (outcome.outcome === "cancelled") {
    if (outcome.reason === "user_skipped") {
      ctx.turnUserWords?.midTurn.push("(image settings) skipped this render");
      return {
        request: agentRequest,
        note: "",
        stop: "The user skipped this render in the settings step, so nothing was rendered. Do not retry;"
          + " tell the user and ask what they want instead.",
        // The failure stays a failure for the agent, which must not retry; the tag is what lets the
        // chat show a choice the user made as "Skipped by you" rather than as a red failed step.
        metadata: { source: "user_skipped", changed: [], waitedMs: outcome.waitedMs },
      };
    }
    return { request: agentRequest, note: "", stop: "The turn was stopped during the settings step, so nothing was rendered." };
  }

  if (outcome.outcome === "auto") {
    const source: ImageSettingsSource = outcome.reason === "user" ? "auto" : outcome.reason;
    return {
      request: agentRequest,
      note: describeImageSettingsForAgent({ source }),
      ...(source !== "no_channel" ? { metadata: { source, changed: [], waitedMs: outcome.waitedMs } } : {}),
      ...(source === "auto" ? { answered: true } : {}),
    };
  }

  const settings = outcome.value.settings;
  if (!settings || !proposal) return { request: agentRequest, note: "" };
  let maskPath: string | undefined;
  if (settings.edit?.mask) {
    maskPath = await writePaintedMask(ctx, settings.edit.base.relativePath, settings.edit.mask.bytes);
  } else if (settings.edit?.keepAgentMask) {
    maskPath = agentFiles.mask?.relativePath;
  }
  const request = applyImageSettings(agentRequest, settings);
  const change = describeSettingsChange(proposal, settings);
  // Their choices are the person's own words for every specialist that runs after this one.
  ctx.turnUserWords?.midTurn.push(
    `(image settings) ${change.summary}`
    + (change.changed.includes("prompt") ? ` — their prompt: "${truncate(settings.prompt, 300)}"` : ""),
  );
  const ran = describeRenderSettings(config, request, {
    ...(settings.edit ? { baseLabel: settings.edit.base.relativePath } : {}),
    ...(maskPath ? { maskPath } : {}),
    ...(settings.edit?.mask ? { maskCoverage: settings.edit.mask.coverage } : {}),
  });
  return {
    request,
    note: describeImageSettingsForAgent({ source: "user", ran, change, prompt: settings.prompt }),
    answered: true,
    metadata: {
      source: "user",
      changed: change.changed,
      waitedMs: outcome.waitedMs,
      ...(maskPath ? { maskPath } : {}),
      ...(settings.edit ? { baseImage: settings.edit.base.relativePath } : {}),
    },
  };
}

const RASTER_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

/**
 * The pictures that may be offered as a base, agent's first, then newest first: the latest image,
 * the chat's image attachments from the newest message back (uploads and earlier renders alike),
 * then the older renders the shared facts remember. Paths go through the workspace guard here and
 * again when read; the client only ever sees the ids handed out for them.
 */
async function baseCandidateEntries(
  ctx: ToolContext,
  agentBase: WorkspaceBinaryFile | undefined,
  max: number,
): Promise<CandidateSourceEntry[]> {
  const entries: CandidateSourceEntry[] = [];
  const seen = new Set<string>();
  const add = (path: string | undefined, source: BaseCandidateSource, read?: () => Promise<Uint8Array>) => {
    if (!path?.trim()) return;
    let relativePath: string;
    try {
      relativePath = resolveWorkspacePath(path.trim(), ctx.workspacePath).relativePath;
    } catch {
      return;
    }
    if (seen.has(relativePath)) return;
    seen.add(relativePath);
    entries.push({
      relativePath,
      source,
      read: read ?? (async () => (await readWorkspaceBinaryFile(relativePath, ctx.workspacePath)).bytes),
    });
  };
  if (agentBase) add(agentBase.relativePath, "agent", async () => agentBase.bytes);

  const shared = deriveSharedSessionId(ctx.sessionId);
  let facts: Record<string, string> = {};
  try {
    facts = await readAllFacts(shared);
  } catch {
    // Without the memory backend the chat's own attachments are still offered.
  }
  add(facts["latest_image"], "latest_image");
  const rootSessionId = currentRequestContext()?.userInput?.rootSessionId ?? shared;
  const history = getSessionRecord(rootSessionId)?.getHistory() ?? [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const attachments = history[index]?.metadata?.["attachments"];
    if (!Array.isArray(attachments)) continue;
    for (const attachment of attachments as Array<Record<string, unknown>>) {
      const path = typeof attachment?.["relativePath"] === "string" ? attachment["relativePath"] : undefined;
      const contentType = typeof attachment?.["contentType"] === "string" ? attachment["contentType"] : "";
      const isRaster = contentType
        ? contentType.startsWith("image/") && !contentType.includes("svg")
        : attachment?.["previewMode"] === "image" || RASTER_EXTENSIONS.has(extname(path ?? "").toLowerCase());
      if (path && isRaster) add(path, "attachment");
    }
  }
  for (const key of Object.keys(facts).filter((name) => name.startsWith("image:")).reverse()) {
    add(facts[key], "shared_fact");
  }
  // Reading stops once enough decode; a bound on the scan keeps a long chat from reading them all.
  return entries.slice(0, Math.max(1, max) * 4);
}

/**
 * Keep a painted mask where the agent can reuse it: a follow-up "change it again" passes it as
 * `mask` instead of asking the person to paint the same region twice. Best-effort — the render
 * carries the mask's bytes itself, so a failed write costs only the reuse.
 */
async function writePaintedMask(ctx: ToolContext, baseRelativePath: string, bytes: Buffer): Promise<string | undefined> {
  try {
    const stem = basename(stripFileExtension(baseRelativePath)).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60) || "image";
    const target = resolveWorkspaceWritePath(`generated/image-masks/${stem}-mask-${Date.now()}.png`, ctx.workspacePath);
    await mkdir(resolve(target.resolved, ".."), { recursive: true });
    await writeFile(target.resolved, bytes);
    try {
      const shared = deriveSharedSessionId(ctx.sessionId);
      await writeSharedFact(shared, "latest_mask", target.relativePath);
      await writeSharedFact(shared, LATEST_MASK_BASE, JSON.stringify([baseRelativePath]));
    } catch {
      // The file is there; only the pointer to it is missing.
    }
    return target.relativePath;
  } catch (error) {
    log.warn({ error }, "Could not keep the painted mask");
    return undefined;
  }
}

/**
 * The pictures `latest_mask` fits, next to it in the shared facts: the one it was painted for, then
 * the latest render made with it — the picture a follow-up "change it again" edits.
 */
const LATEST_MASK_BASE = "latest_mask_base";

/** The pictures a mask fits, when it is the painted `latest_mask`; undefined for any other mask. */
async function paintedMaskFits(ctx: ToolContext, maskRelativePath: string): Promise<string[] | undefined> {
  let facts: Record<string, string>;
  try {
    facts = await readAllFacts(deriveSharedSessionId(ctx.sessionId));
  } catch {
    return undefined;
  }
  const normalize = (path: string | undefined): string | undefined => {
    if (!path?.trim()) return undefined;
    try {
      return resolveWorkspacePath(path.trim(), ctx.workspacePath).relativePath;
    } catch {
      return undefined;
    }
  };
  if (normalize(facts["latest_mask"]) !== maskRelativePath) return undefined;
  const recorded = facts[LATEST_MASK_BASE];
  if (!recorded) return undefined;
  let paths: unknown;
  try {
    paths = JSON.parse(recorded);
  } catch {
    paths = [recorded];
  }
  const fits = (Array.isArray(paths) ? paths : [paths])
    .map((path) => normalize(typeof path === "string" ? path : undefined))
    .filter((path): path is string => Boolean(path));
  return fits.length > 0 ? fits : undefined;
}

/** After a render made with the painted mask: the result is a picture that mask fits too. */
async function recordMaskedRender(
  ctx: ToolContext,
  step: ImageSettingsStep,
  agentMask: WorkspaceBinaryFile | undefined,
  outputRelativePath: string,
): Promise<void> {
  if (!step.request.mask || !step.request.initImage) return;
  // The person's settings name their own mask; anything else ran the agent's.
  const mask = step.metadata?.["source"] === "user" ? step.metadata["maskPath"] : agentMask?.relativePath;
  if (typeof mask !== "string") return;
  const fits = await paintedMaskFits(ctx, mask);
  if (!fits) return;
  try {
    await writeSharedFact(deriveSharedSessionId(ctx.sessionId), LATEST_MASK_BASE, JSON.stringify([...new Set([fits[0]!, outputRelativePath])]));
  } catch {
    // Only the follow-up loses: it is refused the mask and the user paints the region again.
  }
}

registerBrowserTool({
  name: "browser_navigate",
  description: "Navigate the shared browser session to a public URL. After navigating, use browser_snapshot or browser_wait_for to inspect rendered page content.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to open" },
    },
    required: ["url"],
  },
  mcpToolName: "browser_navigate",
  guardUrlArg: "url",
});

registerBrowserTool({
  name: "browser_snapshot",
  description: "Capture an accessibility snapshot of the current browser page. Use this after browser_navigate to read rendered text and page structure, including JavaScript-loaded content.",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  mcpToolName: "browser_snapshot",
});

registerBrowserTool({
  name: "browser_wait_for",
  description: "Wait for text to appear or disappear on the current browser page before taking a browser_snapshot or interacting with the page.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "Optional text to wait for" },
      textGone: { type: "string", description: "Optional text to wait to disappear" },
      time: { type: "number", description: "Optional time to wait in seconds" },
    },
  },
  mcpToolName: "browser_wait_for",
});

registerBrowserTool({
  name: "browser_click",
  description: "Click an element on the current browser page.",
  parameters: {
    type: "object",
    properties: {
      element: { type: "string", description: "Human-readable element description" },
      ref: { type: "string", description: "Exact element reference from a page snapshot" },
    },
    required: ["element", "ref"],
  },
  mcpToolName: "browser_click",
});

registerBrowserTool({
  name: "browser_type",
  description: "Type text into a form field on the current browser page.",
  parameters: {
    type: "object",
    properties: {
      element: { type: "string", description: "Human-readable element description" },
      ref: { type: "string", description: "Exact element reference from a page snapshot" },
      text: { type: "string", description: "Text to type" },
      submit: { type: "boolean", description: "Press Enter after typing" },
      slowly: { type: "boolean", description: "Type character by character" },
    },
    required: ["element", "ref", "text"],
  },
  mcpToolName: "browser_type",
});

registerBrowserTool({
  name: "browser_select_option",
  description: "Select an option in a dropdown on the current browser page.",
  parameters: {
    type: "object",
    properties: {
      element: { type: "string", description: "Human-readable element description" },
      ref: { type: "string", description: "Exact element reference from a page snapshot" },
      values: {
        type: "array",
        items: { type: "string" },
        description: "Option value or values to select",
      },
    },
    required: ["element", "ref", "values"],
  },
  mcpToolName: "browser_select_option",
});

registerBrowserTool({
  name: "browser_screenshot",
  description: "Capture a screenshot of the current browser page.",
  parameters: {
    type: "object",
    properties: {
      fullPage: { type: "boolean", description: "Capture the full page when supported" },
    },
  },
  mcpToolName: "browser_screenshot",
});

interface WorkspaceBinaryFile {
  resolvedPath: string;
  /** The guard-approved workspace-relative form of the path. */
  relativePath: string;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

function registerBrowserTool(input: {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  mcpToolName: string;
  /** Name of a URL argument to SSRF-guard before handing it to Playwright. The
   *  browser sits on the service network with no guard of its own, so a URL that
   *  resolves to an internal/private host is refused (see web.ts checkUrlSsrf). */
  guardUrlArg?: string;
}): void {
  registerTool({
    name: input.name,
    description: input.description,
    parameters: input.parameters,
    async execute(args) {
      if (input.guardUrlArg) {
        const raw = args[input.guardUrlArg];
        if (typeof raw === "string" && raw.trim()) {
          const { checkUrlSsrf } = await import("./web.js");
          const blocked = await checkUrlSsrf(raw);
          if (blocked) return fail(`Refusing to navigate the browser: ${blocked}.`);
        }
      }
      try {
        const output = await callPlaywrightTool(input.mcpToolName, args);
        return { success: true, output, metadata: { server: "playwright", tool: input.mcpToolName } };
      } catch (error) {
        log.error({ error, tool: input.mcpToolName }, "browser tool failed");
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  });
}

async function readWorkspaceBinaryFile(path: string, workspacePath: string): Promise<WorkspaceBinaryFile> {
  const resolved = resolveWorkspacePath(path, workspacePath);
  const describe = (bytes: Buffer): WorkspaceBinaryFile => ({
    resolvedPath: resolved.resolved,
    relativePath: resolved.relativePath,
    filename: basename(resolved.resolved),
    contentType: inferMimeType(resolved.resolved),
    bytes,
  });

  try {
    const fileStat = await stat(resolved.resolved);
    if (!fileStat.isFile()) {
      throw new Error(`Path is not a file: ${path}`);
    }
    return describe(await readFile(resolved.resolved));
  } catch (err) {
    // Uploads go through the object store, and under `storage.backend: "s3"` (the bundled
    // compose default) they never touch the workspace disk — so an agent re-opening an
    // attachment it was told about would ENOENT here. Fall back to the store before failing.
    // Key the store off the RESOLVED relative path, never the caller's raw string.
    // The confinement guard ran on `resolved`; deriving the key from the raw input
    // hands the store a path the guard never approved. Under
    // `storage.backend: "local"` getUpload re-joins that key against workspacePath
    // with no zone or traversal check, so a scope-confined agent calling
    // extract_file_content({path:"uploads/../.env"}) read the real .env the guard
    // had just denied — API keys, JWT secret, S3 credentials, rendered to markdown.
    // Using relativePath also repairs the accepted "/workspace/..." form, whose raw
    // key could never match what putUpload actually stored.
    const { getUpload } = await import("../storage/object-store.js");
    const stored = await getUpload(resolved.relativePath.replace(/\\/g, "/").replace(/^\/+/, ""));
    if (!stored) throw err;
    return describe(Buffer.from(stored));
  }
}

/**
 * Where a file lands that the caller did not name: wherever the write resolver roots a plain name —
 * the artifact zone in the scoped workspaces, and the workspace root itself in scope "full", which
 * no agent holding these tools runs in today. The defaults used to be
 * `.starlingai/generated/<name>`, which the zone then re-rooted into
 * `generated/.starlingai/generated/<name>` — a hidden, doubled directory, every time (session
 * 807684e9). A plain name, rooted by the write resolver, lands once under `generated/`. Files
 * already written at the old place are still read by the paths the facts and transcripts carry.
 */
function resolveDefaultArtifactPath(name: string, workspacePath: string): { resolved: string; relativePath: string } {
  const { resolved, relativePath } = resolveWorkspaceWritePath(name, workspacePath);
  return { resolved, relativePath };
}

function resolveWorkspacePath(path: string, workspacePath: string): { resolved: string; relativePath: string } {
  // relativePath is carried through deliberately: it is the guard-approved form, and
  // it is what any downstream lookup (e.g. the object store) must be keyed on.
  const { resolved, relativePath } = resolvePathWithinWorkspace(path, workspacePath);
  return { resolved, relativePath };
}

async function convertFileToMarkdown(file: WorkspaceBinaryFile): Promise<Record<string, unknown>> {
  const config = getConfig().multimodal.files;
  const isImage = file.contentType.startsWith("image/");

  if (config.mcpServer) {
    try {
      const body = unwrapConversionResult(await callMultimodalToolViaMcp({
        serverName: config.mcpServer,
        toolName: config.toolName,
        filename: file.filename,
        contentType: file.contentType,
        fileBytes: file.bytes,
        timeoutMs: config.timeoutMs,
      }));
      if (String(body["markdown"] ?? "").trim()) {
        return body;
      }
    } catch (error) {
      if (!isImage) throw error;
      log.warn({ error, filename: file.filename }, "MCP file conversion failed for image, falling back");
    }
  }

  const upstreamFormData = new FormData();
  upstreamFormData.append("file", bytesToBlob(file.bytes, file.contentType), file.filename);

  try {
    const upstream = await fetchWithTimeout(
      upstreamUrl(config.baseUrl, `/api/tools/${config.toolName}`),
      {
        method: "POST",
        headers: upstreamHeaders(config.apiKey),
        body: upstreamFormData,
      },
      config.timeoutMs,
    );
    if (upstream.ok) {
      const body = unwrapConversionResult(
        await parseUpstreamJsonResponse(upstream, "File conversion returned a non-JSON response"),
      );
      if (String(body["markdown"] ?? "").trim()) return body;
      // The service wraps a tool-level failure as { success:false, error } inside
      // the result envelope (HTTP is still 200). Surface it for non-image files
      // instead of silently returning empty markdown.
      const innerError = typeof body["error"] === "string" ? body["error"].trim() : "";
      if (!isImage && innerError) throw new Error(`File conversion failed: ${innerError}`);
    } else if (!isImage) {
      throw new Error(await extractUpstreamError(upstream, "File conversion failed"));
    }
  } catch (error) {
    if (!isImage) throw error;
    log.warn({ error, filename: file.filename }, "REST file conversion failed for image, falling back to vision");
  }

  if (isImage && config.visionModel) {
    const markdown = await analyzeImageBytes(
      file.bytes,
      file.contentType,
      config.visionModel,
      "Analyze this image in detail. Extract all visible text exactly as written. Identify key UI elements, data, charts, error messages, or any other relevant content. Return a structured Markdown response.",
    );
    if (markdown) {
      return { markdown, filename: file.filename };
    }
  }

  return { markdown: "", filename: file.filename };
}

/**
 * Convert raw document bytes (e.g. a PDF fetched from a URL by web_fetch) to
 * markdown text via the configured multimodal extraction service — the same path
 * extract_file_content uses for workspace files. Returns the extracted markdown,
 * or "" when no extraction service is configured, it is unavailable, or the
 * document yielded no text. Never throws. (Audit 97085c6b: web_fetch returned raw
 * %PDF bytes for the IM73A135V01 datasheet, so the analog spec never reached synthesis.)
 */
export async function extractDocumentBytesToMarkdown(
  bytes: Uint8Array,
  filename: string,
  contentType: string,
): Promise<string> {
  const config = getConfig().multimodal.files;
  if (!config.mcpServer && !multimodalServiceConfigured(config.baseUrl)) return "";
  try {
    const body = await convertFileToMarkdown({ resolvedPath: filename, relativePath: filename, filename, contentType, bytes });
    return String(body["markdown"] ?? "").trim();
  } catch (error) {
    log.warn({ error, filename }, "extractDocumentBytesToMarkdown failed");
    return "";
  }
}

async function callMultimodalToolViaMcp(input: {
  serverName: string;
  toolName: string;
  filename: string;
  contentType: string;
  fileBytes: Uint8Array;
  timeoutMs: number;
}): Promise<Record<string, unknown>> {
  const connection = getMcpConnections().get(input.serverName);
  if (!connection) {
    throw new Error(`Configured MCP server not connected: ${input.serverName}`);
  }

  const result = await withTimeout(
    connection.client.callTool({
      name: input.toolName,
      arguments: {
        filename: input.filename,
        content_type: input.contentType,
        base64_content: Buffer.from(input.fileBytes).toString("base64"),
      },
    }),
    input.timeoutMs,
    `MCP tool ${input.serverName}/${input.toolName}`,
  );

  const text = (result.content as Array<{ type: string; text?: string }> | undefined)
    ?.map(item => (item.type === "text" ? (item.text ?? "") : JSON.stringify(item)))
    .join("\n")
    .trim() ?? "";

  if ((result as { isError?: boolean }).isError) {
    throw new Error(text || `MCP tool ${input.serverName}/${input.toolName} failed`);
  }

  return parseMcpToolTextResponse(text, `MCP tool ${input.serverName}/${input.toolName} returned an unparsable response`);
}

export async function analyzeImageBytes(bytes: Uint8Array, contentType: string, configuredModel: string, prompt: string): Promise<string> {
  const config = getConfig();
  const endpoint = resolveProviderEndpointForModel(
    configuredModel,
    {
      baseUrl: config.multimodal.files.visionBaseUrl,
      apiKey: config.multimodal.files.visionApiKey,
    },
    config,
  );
  const baseUrl = endpoint.baseUrl.replace(/\/$/, "");
  const apiKey = endpoint.apiKey;
  const modelId = configuredModel.replace(/^[^/]+\//, "");
  const dataUrl = `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`;

  // Disable thinking mode for vision calls — models like Qwen3.5 default
  // to thinking-on, which consumes most of max_tokens on <think> reasoning
  // and leaves the actual content field empty.
  const needsThinkingOff = /(qwen|gemma-4)/i.test(modelId);

  const response = await fetchWithTimeout(
    `${baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{
          role: "user",
          content: [
            { type: "image_url", image_url: { url: dataUrl } },
            { type: "text", text: prompt },
          ],
        }],
        max_tokens: 2048,
        temperature: 0.1,
        ...(needsThinkingOff && {
          chat_template_kwargs: { enable_thinking: false },
        }),
      }),
    },
    config.multimodal.files.visionTimeoutMs,
  );

  if (!response.ok) {
    throw new Error(await extractUpstreamError(response, "Vision analysis failed"));
  }

  const body = await parseUpstreamJsonResponse(response, "Vision analysis returned a non-JSON response");
  const choices = Array.isArray(body["choices"]) ? body["choices"] : [];
  const firstChoice = choices[0];
  const message = firstChoice && typeof firstChoice === "object" && "message" in firstChoice
    ? (firstChoice["message"] as Record<string, unknown>)
    : undefined;
  const content = message?.["content"];
  // Some providers return content as an array of {type,text} segments.
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? (content as Array<Record<string, unknown>>).map(s => typeof s["text"] === "string" ? s["text"] : "").join("")
      : "";
  return text.trim();
}

export async function callPlaywrightTool(toolName: string, args: Record<string, unknown>): Promise<string> {
  const connection = getMcpConnections().get("playwright");
  if (!connection) {
    throw new Error("Playwright MCP server is not connected");
  }

  const availableTools = new Set((connection.tools ?? []).map((tool) => tool.name));
  const resolvedToolName = toolName === "browser_screenshot" && !availableTools.has(toolName) && availableTools.has("browser_take_screenshot")
    ? "browser_take_screenshot"
    : toolName;

  if (resolvedToolName !== toolName) {
    log.info({ requestedToolName: toolName, resolvedToolName }, "Resolved legacy Playwright tool name");
  }

  const result = await connection.client.callTool({ name: resolvedToolName, arguments: args });
  const output = (result.content as Array<{ type: string; text?: string }> | undefined)
    ?.map(item => (item.type === "text" ? (item.text ?? "") : JSON.stringify(item)))
    .join("\n")
    .trim() ?? "";

  if ((result as { isError?: boolean }).isError) {
    throw new Error(output || `Playwright tool ${resolvedToolName} failed`);
  }

  return output;
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function summarizeUpstreamText(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) return "empty response";
  return collapsed.length > 240 ? `${collapsed.slice(0, 237)}...` : collapsed;
}

async function extractUpstreamError(response: Response, fallback: string): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";

  try {
    if (contentType.includes("application/json")) {
      const body = await response.json() as Record<string, unknown>;
      const detail = body["detail"] ?? body["error"] ?? body["message"];
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

async function sendSttRequest(input: {
  api: "auto" | "openai-compatible" | "transcribe-only";
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  model: string;
  audioBlob: Blob;
  filename: string;
  language?: string;
  prompt?: string;
}): Promise<Response> {
  const normalizedLanguage = normalizeSttLanguage(input.language);

  if (input.api === "transcribe-only") {
    const directResponse = await sendDirectTranscribeRequest({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      timeoutMs: input.timeoutMs,
      audioBlob: input.audioBlob,
      filename: input.filename,
      language: normalizedLanguage,
      prompt: input.prompt,
    });

    if (shouldRetryTranscribeWithoutLanguage(directResponse.status, normalizedLanguage)) {
      return sendDirectTranscribeRequest({
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        timeoutMs: input.timeoutMs,
        audioBlob: input.audioBlob,
        filename: input.filename,
        prompt: input.prompt,
      });
    }

    return directResponse;
  }

  const openAiForm = new FormData();
  openAiForm.append("file", input.audioBlob, input.filename);
  openAiForm.append("model", input.model);
  if (normalizedLanguage) openAiForm.append("language", normalizedLanguage);
  if (input.prompt) openAiForm.append("prompt", input.prompt);

  const openAiResponse = await fetchWithTimeout(
    upstreamUrl(input.baseUrl, "/v1/audio/transcriptions"),
    {
      method: "POST",
      headers: upstreamHeaders(input.apiKey),
      body: openAiForm,
    },
    input.timeoutMs,
  );

  if (openAiResponse.status !== 404 && openAiResponse.status !== 405) {
    return openAiResponse;
  }

  if (input.api === "openai-compatible") {
    return openAiResponse;
  }

  const directFallbackResponse = await sendDirectTranscribeRequest({
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    timeoutMs: input.timeoutMs,
    audioBlob: input.audioBlob,
    filename: input.filename,
    language: normalizedLanguage,
    prompt: input.prompt,
  });

  if (shouldRetryTranscribeWithoutLanguage(directFallbackResponse.status, normalizedLanguage)) {
    return sendDirectTranscribeRequest({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      timeoutMs: input.timeoutMs,
      audioBlob: input.audioBlob,
      filename: input.filename,
      prompt: input.prompt,
    });
  }

  return directFallbackResponse;
}

function normalizeSttLanguage(language: string | undefined): string | undefined {
  if (!language) return undefined;
  const normalized = language.trim();
  if (!normalized) return undefined;

  const lower = normalized.toLowerCase().replace(/_/g, "-");
  const directMap: Record<string, string> = {
    auto: "auto",
    german: "de",
    "de-de": "de",
    de: "de",
    english: "en",
    "en-us": "en",
    en: "en",
    polish: "pl",
    "pl-pl": "pl",
    pl: "pl",
  };
  if (directMap[lower]) return directMap[lower];

  if (/^[a-z]{2,3}(?:-[a-z0-9]{2,8})+$/i.test(lower)) {
    return lower.split("-")[0];
  }

  return normalized;
}

function shouldRetryTranscribeWithoutLanguage(status: number, language: string | undefined): boolean {
  if (!language || language === "auto") return false;
  return status === 400 || status === 422 || status >= 500;
}

async function sendDirectTranscribeRequest(input: {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  audioBlob: Blob;
  filename: string;
  language?: string;
  prompt?: string;
}): Promise<Response> {
  const fallbackForm = new FormData();
  fallbackForm.append("audio", input.audioBlob, input.filename);
  if (input.language) fallbackForm.append("language", input.language);
  if (input.prompt) fallbackForm.append("initial_prompt", input.prompt);

  return fetchWithTimeout(
    upstreamUrl(input.baseUrl, "/transcribe"),
    {
      method: "POST",
      headers: upstreamHeaders(input.apiKey),
      body: fallbackForm,
    },
    input.timeoutMs,
  );
}

async function fetchTtsVoiceCatalog(config: {
  api: "qwen-compatible" | "openai-compatible";
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
}): Promise<Record<string, unknown>> {
  if (config.api === "openai-compatible") {
    const [voicesResponse, modelsResponse] = await Promise.all([
      fetchWithTimeout(upstreamUrl(config.baseUrl, "/voices"), { headers: upstreamHeaders(config.apiKey) }, config.timeoutMs),
      fetchWithTimeout(upstreamUrl(config.baseUrl, "/models"), { headers: upstreamHeaders(config.apiKey) }, config.timeoutMs),
    ]);

    if (!modelsResponse.ok) {
      throw new Error(await extractUpstreamError(modelsResponse, "Failed to load TTS models"));
    }

    const modelsBody = await parseUpstreamJsonResponse(modelsResponse, "Model list returned a non-JSON response");
    let voices: unknown[] = [];

    if (voicesResponse.ok) {
      const voicesBody = await parseUpstreamJsonResponse(voicesResponse, "Voice list returned a non-JSON response");
      voices = Array.isArray(voicesBody["voices"]) ? voicesBody["voices"] : [];
    } else if (voicesResponse.status !== 404 && voicesResponse.status !== 405) {
      throw new Error(await extractUpstreamError(voicesResponse, "Failed to load saved voices"));
    }

    return {
      voices,
      speakers: [],
      models: modelsBody["models"] ?? {},
      currentModel: modelsBody["current_model"] ?? undefined,
    };
  }

  const [voicesResponse, speakersResponse, modelsResponse] = await Promise.all([
    fetchWithTimeout(upstreamUrl(config.baseUrl, "/voices"), { headers: upstreamHeaders(config.apiKey) }, config.timeoutMs),
    fetchWithTimeout(upstreamUrl(config.baseUrl, "/speakers"), { headers: upstreamHeaders(config.apiKey) }, config.timeoutMs),
    fetchWithTimeout(upstreamUrl(config.baseUrl, "/models"), { headers: upstreamHeaders(config.apiKey) }, config.timeoutMs),
  ]);

  if (!voicesResponse.ok) {
    throw new Error(await extractUpstreamError(voicesResponse, "Failed to load saved voices"));
  }
  if (!speakersResponse.ok) {
    throw new Error(await extractUpstreamError(speakersResponse, "Failed to load speakers"));
  }
  if (!modelsResponse.ok) {
    throw new Error(await extractUpstreamError(modelsResponse, "Failed to load TTS models"));
  }

  const voicesBody = await parseUpstreamJsonResponse(voicesResponse, "Voice list returned a non-JSON response");
  const speakersBody = await parseUpstreamJsonResponse(speakersResponse, "Speaker list returned a non-JSON response");
  const modelsBody = await parseUpstreamJsonResponse(modelsResponse, "Model list returned a non-JSON response");

  return {
    voices: Array.isArray(voicesBody["voices"]) ? voicesBody["voices"] : [],
    speakers: Array.isArray(speakersBody["speakers"]) ? speakersBody["speakers"] : [],
    models: modelsBody["models"] ?? {},
    currentModel: modelsBody["current_model"] ?? undefined,
  };
}

function normalizeQwenLanguage(language: string): string {
  const normalized = language.trim();
  const map: Record<string, string> = {
    en: "English",
    "en-us": "English",
    en_us: "English",
    english: "English",
    de: "German",
    "de-de": "German",
    de_de: "German",
    german: "German",
    es: "Spanish",
    spanish: "Spanish",
    fr: "French",
    french: "French",
    it: "Italian",
    italian: "Italian",
    pt: "Portuguese",
    portuguese: "Portuguese",
    ru: "Russian",
    russian: "Russian",
    ja: "Japanese",
    japanese: "Japanese",
    ko: "Korean",
    korean: "Korean",
    zh: "Chinese",
    chinese: "Chinese",
  };
  return map[normalized.toLowerCase()] ?? normalized;
}

function normalizeTtsLanguage(language: string, api: "qwen-compatible" | "openai-compatible"): string {
  return api === "qwen-compatible" ? normalizeQwenLanguage(language) : language.trim();
}

async function sendTtsRequest(input: {
  api: "qwen-compatible" | "openai-compatible";
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  text: string;
  model?: string;
  language: string;
  quality?: string;
  gender?: string;
  speed?: number;
  speaker?: string;
  savedVoiceId?: string;
  audioExample?: WorkspaceBinaryFile;
  referenceText?: string;
  saveVoiceAs?: string;
  allowVoiceCloneFallback?: boolean;
}): Promise<Response> {
  if (input.saveVoiceAs) {
    return sendSingleTtsRequest(input);
  }

  return sendChunkedTtsRequests(input, {
    requestChunk: sendSingleTtsRequest,
  });
}

async function sendSingleTtsRequest(input: {
  api: "qwen-compatible" | "openai-compatible";
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  text: string;
  model?: string;
  language: string;
  quality?: string;
  gender?: string;
  speed?: number;
  speaker?: string;
  savedVoiceId?: string;
  audioExample?: WorkspaceBinaryFile;
  referenceText?: string;
  saveVoiceAs?: string;
  allowVoiceCloneFallback?: boolean;
}): Promise<Response> {
  const language = normalizeTtsLanguage(input.language, input.api);
  const model = input.model?.trim();

  if (input.api === "openai-compatible") {
    if (input.audioExample || input.saveVoiceAs || input.referenceText) {
      throw new Error("Voice cloning is only supported for qwen-compatible TTS backends.");
    }

    return fetchWithTimeout(
      upstreamUrl(input.baseUrl, "/v1/audio/speech"),
      {
        method: "POST",
        headers: upstreamHeaders(input.apiKey, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          model: model || "tts-1",
          input: input.text,
          voice: input.savedVoiceId ?? input.speaker ?? "alloy",
          response_format: "wav",
          ...(input.speed !== undefined ? { speed: input.speed } : {}),
        }),
      },
      input.timeoutMs,
    );
  }

  if (model) {
    const loadModelResponse = await fetchWithTimeout(
      upstreamUrl(input.baseUrl, "/load_model"),
      {
        method: "POST",
        headers: upstreamHeaders(input.apiKey, { "Content-Type": "application/json" }),
        body: JSON.stringify({ model }),
      },
      input.timeoutMs,
    );
    if (!loadModelResponse.ok) {
      return loadModelResponse;
    }
  }

  if (input.savedVoiceId) {
    const formData = new FormData();
    formData.append("text", input.text);
    formData.append("lang", language);
    return fetchWithTimeout(
      upstreamUrl(input.baseUrl, `/voices/${encodeURIComponent(input.savedVoiceId)}/tts`),
      {
        method: "POST",
        headers: upstreamHeaders(input.apiKey),
        body: formData,
      },
      input.timeoutMs,
    );
  }

  if (input.audioExample) {
    const cloneSupported = await qwenTtsSupportsVoiceClone({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      timeoutMs: input.timeoutMs,
      requestedModel: model,
    });
    if (cloneSupported === false) {
      if (input.allowVoiceCloneFallback) {
        return fetchWithTimeout(
          upstreamUrl(input.baseUrl, "/tts"),
          {
            method: "POST",
            headers: upstreamHeaders(input.apiKey, { "Content-Type": "application/json" }),
            body: JSON.stringify({
              text: input.text,
              lang: language,
              speaker: input.speaker ?? "Vivian",
              instruct: input.gender ?? input.quality ?? "",
            }),
          },
          input.timeoutMs,
        );
      }

      return new Response(JSON.stringify({
        error: "The selected qwen-compatible TTS model does not support voice cloning. Remove the voice sample or switch to a model with voice_clone capability.",
      }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (input.saveVoiceAs) {
      const saveForm = new FormData();
      saveForm.append("name", input.saveVoiceAs);
      saveForm.append("lang", language);
      saveForm.append("file", bytesToBlob(input.audioExample.bytes, input.audioExample.contentType), input.audioExample.filename);
      const saveResponse = await fetchWithTimeout(
        upstreamUrl(input.baseUrl, "/voices/save"),
        {
          method: "POST",
          headers: upstreamHeaders(input.apiKey),
          body: saveForm,
        },
        input.timeoutMs,
      );
      if (!saveResponse.ok) {
        return saveResponse;
      }
      const savedVoice = await parseUpstreamJsonResponse(saveResponse, "Saved voice response was not JSON");
      const voiceId = typeof savedVoice["voice_id"] === "string" ? savedVoice["voice_id"] : input.saveVoiceAs;
      const formData = new FormData();
      formData.append("text", input.text);
      formData.append("lang", language);
      return fetchWithTimeout(
        upstreamUrl(input.baseUrl, `/voices/${encodeURIComponent(voiceId)}/tts`),
        {
          method: "POST",
          headers: upstreamHeaders(input.apiKey),
          body: formData,
        },
        input.timeoutMs,
      );
    }

    const formData = new FormData();
    formData.append("text", input.text);
    formData.append("lang", language);
    formData.append("file", bytesToBlob(input.audioExample.bytes, input.audioExample.contentType), input.audioExample.filename);
    const route = input.referenceText ? "/clone-with-ref-text" : "/clone";
    if (input.referenceText) {
      formData.append("ref_text", input.referenceText);
    }
    return fetchWithTimeout(
      upstreamUrl(input.baseUrl, route),
      {
        method: "POST",
        headers: upstreamHeaders(input.apiKey),
        body: formData,
      },
      input.timeoutMs,
    );
  }

  return fetchWithTimeout(
    upstreamUrl(input.baseUrl, "/tts"),
    {
      method: "POST",
      headers: upstreamHeaders(input.apiKey, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        text: input.text,
        lang: language,
        speaker: input.speaker ?? "Vivian",
        instruct: input.gender ?? input.quality ?? "",
      }),
    },
    input.timeoutMs,
  );
}

async function qwenTtsSupportsVoiceClone(input: {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  requestedModel?: string;
}): Promise<boolean | undefined> {
  try {
    const response = await fetchWithTimeout(
      upstreamUrl(input.baseUrl, "/models"),
      { headers: upstreamHeaders(input.apiKey) },
      input.timeoutMs,
    );
    if (!response.ok) return undefined;

    const body = await parseUpstreamJsonResponse(response, "TTS model list returned a non-JSON response");
    const models = body["models"];
    if (!models || typeof models !== "object") return undefined;

    const requestedModel = input.requestedModel?.trim();
    const currentModel = typeof body["current_model"] === "string" ? body["current_model"] : undefined;
    const modelKey = requestedModel && requestedModel in (models as Record<string, unknown>)
      ? requestedModel
      : currentModel && currentModel in (models as Record<string, unknown>)
        ? currentModel
        : undefined;
    if (!modelKey) return undefined;

    const modelInfo = (models as Record<string, unknown>)[modelKey];
    if (!modelInfo || typeof modelInfo !== "object") return undefined;
    const capabilities = Array.isArray((modelInfo as Record<string, unknown>)["capabilities"])
      ? ((modelInfo as Record<string, unknown>)["capabilities"] as unknown[]).map(String)
      : [];
    return capabilities.includes("voice_clone");
  } catch {
    return undefined;
  }
}

function normalizePythonLiteralText(value: string): string {
  let output = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (let index = 0; index < value.length;) {
    const char = value[index];

    if (quote) {
      output += char;
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === quote) {
        quote = null;
      }
      index += 1;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      output += char;
      index += 1;
      continue;
    }

    const before = index === 0 ? "" : (value[index - 1] ?? "");
    const afterTrue = value[index + 4] ?? "";
    const afterFalse = value[index + 5] ?? "";
    const afterNone = value[index + 4] ?? "";
    const boundaryBefore = before === "" || /[^A-Za-z0-9_]/.test(before);

    if (boundaryBefore && value.startsWith("True", index) && (afterTrue === "" || /[^A-Za-z0-9_]/.test(afterTrue))) {
      output += "true";
      index += 4;
      continue;
    }

    if (boundaryBefore && value.startsWith("False", index) && (afterFalse === "" || /[^A-Za-z0-9_]/.test(afterFalse))) {
      output += "false";
      index += 5;
      continue;
    }

    if (boundaryBefore && value.startsWith("None", index) && (afterNone === "" || /[^A-Za-z0-9_]/.test(afterNone))) {
      output += "null";
      index += 4;
      continue;
    }

    output += char;
    index += 1;
  }

  return output;
}

function parseMcpToolTextResponse(text: string, fallback: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error(fallback);
  }

  try {
    return JSON5.parse(normalizePythonLiteralText(trimmed)) as Record<string, unknown>;
  } catch (error) {
    throw new Error(error instanceof Error ? `${fallback}: ${error.message}` : fallback);
  }
}

function inferMimeType(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function stringArg(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function fail(error: string): ToolResult {
  return { success: false, output: "", error };
}