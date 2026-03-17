import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import JSON5 from "json5";
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";
import { getMcpConnections } from "../mcp/registry.js";
import { registerTool, type ToolResult } from "./registry.js";
import { resolvePathWithinWorkspace } from "./workspace-path.js";

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

registerTool({
  name: "extract_file_content",
  description: "Convert a workspace file into Markdown using the configured file-conversion backend.",
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
      const response = await sendSttRequest({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        timeoutMs: config.timeoutMs,
        model: String(args["model"] ?? config.model),
        audioBlob: new Blob([file.bytes], { type: file.contentType }),
        filename: file.filename,
        language: stringArg(args["language"]),
        prompt: stringArg(args["prompt"]),
      });

      if (!response.ok) {
        return fail(await extractUpstreamError(response, "Transcription failed"));
      }

      const body = await parseUpstreamJsonResponse(response, "Transcription returned a non-JSON response");
      const segments = Array.isArray(body["segments"])
        ? body["segments"].map(segment => {
            if (typeof segment === "string") return segment;
            if (segment && typeof segment === "object" && "text" in segment) return String(segment["text"] ?? "");
            return "";
          }).filter(Boolean).join(" ").trim()
        : "";
      const text = String(body["text"] ?? body["transcription"] ?? body["result"] ?? segments ?? "").trim();
      if (!text) return fail(`No transcript was returned for ${path}`);

      return {
        success: true,
        output: text,
        metadata: {
          path,
          language: body["language"] ?? body["detected_language"] ?? body["lang"],
          duration: body["duration"] ?? body["processing_time"],
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
      voiceId: { type: "string", description: "Optional saved Qwen3 voice ID" },
      speaker: { type: "string", description: "Optional built-in Qwen3 speaker name" },
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
      const audioExamplePath = stringArg(args["audioExamplePath"]) ?? config.voiceSamplePath;
      const referenceText = stringArg(args["referenceText"]) ?? config.voiceSampleText;
      const savedVoiceId = stringArg(args["voiceId"]) ?? stringArg(args["voice"]) ?? config.defaultVoiceId;
      const speaker = stringArg(args["speaker"]) ?? (savedVoiceId ? undefined : config.defaultSpeaker);
      const response = await sendTtsRequest({
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
        saveVoiceAs: stringArg(args["saveVoiceAs"]),
      });

      if (!response.ok) {
        return fail(await extractUpstreamError(response, "Speech synthesis failed"));
      }

      const audio = new Uint8Array(await response.arrayBuffer());
      const outputPath = stringArg(args["outputPath"]) ?? `.starlingai/generated/tts-${Date.now()}.wav`;
      const resolvedOutput = resolveWorkspacePath(outputPath, ctx.workspacePath);
      await mkdir(resolve(resolvedOutput.resolved, ".."), { recursive: true });
      await writeFile(resolvedOutput.resolved, audio);

      return {
        success: true,
        output: `Audio saved to ${outputPath}`,
        metadata: {
          outputPath,
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

registerBrowserTool({
  name: "browser_navigate",
  description: "Navigate the shared browser session to a public URL.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to open" },
    },
    required: ["url"],
  },
  mcpToolName: "browser_navigate",
});

registerBrowserTool({
  name: "browser_snapshot",
  description: "Capture an accessibility snapshot of the current browser page.",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  mcpToolName: "browser_snapshot",
});

registerBrowserTool({
  name: "browser_wait_for",
  description: "Wait for text to appear or disappear on the current browser page.",
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
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

function registerBrowserTool(input: {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  mcpToolName: string;
}): void {
  registerTool({
    name: input.name,
    description: input.description,
    parameters: input.parameters,
    async execute(args) {
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
  const fileStat = await stat(resolved.resolved);
  if (!fileStat.isFile()) {
    throw new Error(`Path is not a file: ${path}`);
  }

  const bytes = await readFile(resolved.resolved);
  return {
    resolvedPath: resolved.resolved,
    filename: basename(resolved.resolved),
    contentType: inferMimeType(resolved.resolved),
    bytes,
  };
}

function resolveWorkspacePath(path: string, workspacePath: string): { resolved: string } {
  const { resolved } = resolvePathWithinWorkspace(path, workspacePath);
  return { resolved };
}

async function convertFileToMarkdown(file: WorkspaceBinaryFile): Promise<Record<string, unknown>> {
  const config = getConfig().multimodal.files;
  const isImage = file.contentType.startsWith("image/");

  if (config.mcpServer) {
    try {
      const body = await callMultimodalToolViaMcp({
        serverName: config.mcpServer,
        toolName: config.toolName,
        filename: file.filename,
        contentType: file.contentType,
        fileBytes: file.bytes,
        timeoutMs: config.timeoutMs,
      });
      if (String(body["markdown"] ?? "").trim()) {
        return body;
      }
    } catch (error) {
      if (!isImage) throw error;
      log.warn({ error, filename: file.filename }, "MCP file conversion failed for image, falling back");
    }
  }

  const upstreamFormData = new FormData();
  upstreamFormData.append("file", new Blob([file.bytes], { type: file.contentType }), file.filename);

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
      const body = await parseUpstreamJsonResponse(upstream, "File conversion returned a non-JSON response");
      if (String(body["markdown"] ?? "").trim()) return body;
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

async function analyzeImageBytes(bytes: Uint8Array, contentType: string, configuredModel: string, prompt: string): Promise<string> {
  const providerConfig = getConfig().providers.lmstudio;
  const baseUrl = (providerConfig?.baseUrl ?? "http://host.docker.internal:1234/v1").replace(/\/$/, "");
  const apiKey = providerConfig?.apiKey ?? "lm-studio";
  const modelId = configuredModel.replace(/^[^/]+\//, "");
  const dataUrl = `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`;

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
      }),
    },
    getConfig().multimodal.files.timeoutMs,
  );

  if (!response.ok) {
    throw new Error(await extractUpstreamError(response, "Vision analysis failed"));
  }

  const body = await parseUpstreamJsonResponse(response, "Vision analysis returned a non-JSON response");
  const choices = Array.isArray(body["choices"]) ? body["choices"] : [];
  const firstChoice = choices[0];
  const content = firstChoice && typeof firstChoice === "object" && "message" in firstChoice
    ? (firstChoice["message"] as Record<string, unknown>)["content"]
    : undefined;
  return typeof content === "string" ? content.trim() : "";
}

async function callPlaywrightTool(toolName: string, args: Record<string, unknown>): Promise<string> {
  const connection = getMcpConnections().get("playwright");
  if (!connection) {
    throw new Error("Playwright MCP server is not connected");
  }

  const result = await connection.client.callTool({ name: toolName, arguments: args });
  const output = (result.content as Array<{ type: string; text?: string }> | undefined)
    ?.map(item => (item.type === "text" ? (item.text ?? "") : JSON.stringify(item)))
    .join("\n")
    .trim() ?? "";

  if ((result as { isError?: boolean }).isError) {
    throw new Error(output || `Playwright tool ${toolName} failed`);
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
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  model: string;
  audioBlob: Blob;
  filename: string;
  language?: string;
  prompt?: string;
}): Promise<Response> {
  const openAiForm = new FormData();
  openAiForm.append("file", input.audioBlob, input.filename);
  openAiForm.append("model", input.model);
  if (input.language) openAiForm.append("language", input.language);
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
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
}): Promise<Record<string, unknown>> {
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

async function sendTtsRequest(input: {
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
}): Promise<Response> {
  const language = normalizeQwenLanguage(input.language);
  const model = input.model?.trim();

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
    if (input.saveVoiceAs) {
      const saveForm = new FormData();
      saveForm.append("name", input.saveVoiceAs);
      saveForm.append("lang", language);
      saveForm.append("file", new Blob([input.audioExample.bytes], { type: input.audioExample.contentType }), input.audioExample.filename);
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
    formData.append("file", new Blob([input.audioExample.bytes], { type: input.audioExample.contentType }), input.audioExample.filename);
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