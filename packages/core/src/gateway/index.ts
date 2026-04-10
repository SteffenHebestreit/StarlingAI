import { Hono } from "hono";
import { cors } from "hono/cors";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { timingSafeEqual } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, basename, extname } from "node:path";
import JSON5 from "json5";
import { z } from "zod";
import { WebSocketServer } from "ws";
import { ZipFile } from "yazl";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getConfig, updateConfig } from "../config/loader.js";
import { verifyToken, extractBearerToken, checkAuthRateLimit, recordAuthFailure, clearAuthFailures } from "./auth.js";
import { RpcConnection } from "./rpc.js";
import { getAllSessions } from "../agent/session.js";
import { buildSessionAuditMarkdown, buildSessionDebugMarkdown } from "../agent/debug-session-export.js";
import { listSiteCredentials, saveSiteCredential, deleteSiteCredential, resolveSiteCredential, hasConfigSiteCredential } from "../credentials/sites.js";
import { listAllScenes, getScene, saveScene, deleteScene } from "../credentials/scenes.js";
import {
  listAllJobs as listJobDefinitions,
  getJobDefinition,
  saveJobDefinition,
  deleteJobDefinition,
  resolveJobSteps,
  getApiWebhookKeys,
} from "../credentials/jobs.js";
import { getGuardrails, updateGuardrails, resetGuardrails } from "../guardrails/store.js";
import { handleAguiStream } from "./agui.js";
import { runSubAgent } from "../agent/sub-agent.js";
import { createJob, cancelJob, getJob as getExecutionJob, listJobs } from "../agent/jobs.js";
import { resolveApproval, getPendingApproval } from "../approval/store.js";
import { childLogger } from "../logger.js";
import { handleSlackEvent } from "../channels/slack.js";
import { handleWhatsappEvent, handleWhatsappVerify } from "../channels/whatsapp.js";
import { getChannelStatuses } from "../channels/registry.js";
import { buildSpeechSummarySystemPrompt, buildSpeechSummaryUserPrompt } from "./speech-summary.js";
import { CHANNEL_TYPES, getStoredChannelConfig, saveChannelConfig, deleteChannelConfig, getEffectiveChannelConfig, getChannelConfigSource, redactChannelSecrets, type StoredChannelConfig } from "../credentials/channels.js";
import { getChannelRuntimeSupport, reloadChannel } from "../channels/runtime.js";
import { getRuntimeStatusSnapshot } from "../runtime/status.js";
import { getModelEndpointHealthSnapshot, syncModelEndpointRuntimeStatus } from "../runtime/model-endpoints.js";
import { getDeadLetterCount, readDeadLetters, type DeadLetterEntry } from "../channels/dead-letter.js";
import { checkImageGenerationHealth, imageGenerationServiceConfigured, requestImageGeneration } from "../multimodal/image-generation.js";
import { sendChunkedTtsRequests } from "../multimodal/tts-chunking.js";
import { resolveProviderEndpointForModel, syncChatProviderRuntimeStatus } from "../providers/index.js";
import { resolveAgentRouting } from "../tools/sub-agent.js";
import { logAudit } from "../audit/logger.js";
import { getConcurrencySnapshot } from "../swarm/concurrency.js";
import { isSwarmBusConnected } from "../swarm/bus.js";
import { getAgentCapabilitySnapshot } from "../swarm/capabilities.js";
import { getBidderWorkerStatus } from "../swarm/bidder-worker.js";
import { getAgentMessageBacklogSnapshot } from "../swarm/memory.js";
import { getLoadedDynamicTools, listPromotionCandidates, approvePromotion, rejectPromotion, getDynamicToolStats } from "../tools/dynamic-tools.js";
import { listCapabilityGaps } from "../agent/self-improve.js";
import { getWardenAlerts } from "../agent/warden.js";
import { listCheckpoints, resumeCheckpoint, completeCheckpoint } from "../swarm/checkpoints.js";
import { ModelConfigSchema, MultimodalSchema, RetrievalRerankerSchema } from "../config/schema.js";
import { getMcpConnections } from "../mcp/registry.js";
import { computerSessionManager } from "../agent/computer-session.js";
import { proposeConversationConfigChange } from "../agent/config-assistant.js";
import {
  applyPromptChange,
  appendConversationConfigProposalFeedback,
  applyObjectPath,
  createConversationConfigProposal,
  getConversationConfigProposal,
  hasPromptTarget,
  listConversationConfigProposals,
  MAIN_ASSISTANT_PROMPT_TARGET,
  updateConversationConfigProposal,
} from "../agent/config-assistant-proposals.js";
import { appendFlowMemoryEntry, readFlowMemoryEntries } from "../agent/flow-memory.js";
import {
  MainAssistantPersonalityEditableSchema,
  loadMainAssistantPersonality,
  resetMainAssistantPersonality,
  saveMainAssistantPersonality,
} from "../personality/service.js";
import { resolvePathWithinWorkspace } from "../tools/workspace-path.js";
import { JobConfigSchema } from "../config/schema.js";
import { syncConfiguredJobTriggers } from "../runtime/job-triggers.js";

const log = childLogger("gateway");

function applyTemplate(template: string, params: Record<string, string>): string {
  return template.replace(/\{\{(\w+)(?:\|([^}]*))?\}\}/g, (match, key: string, defaultVal?: string) => {
    if (key in params) return params[key] ?? "";
    if (defaultVal !== undefined) return defaultVal;
    return match;
  });
}

function resolveWebhookSecret(secret: string | undefined): string {
  if (!secret) return "";
  return secret.startsWith("$") ? (process.env[secret.slice(1)] ?? "") : secret;
}

function originFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function createGateway() {
  const config = getConfig();
  const app = new Hono();
  const turnTimeoutMs = config.gateway.turnTimeoutMs;
  const currentMultimodalConfig = () => getConfig().multimodal;
  const ModelEndpointGuardSchema = z.object({
    enabled: z.boolean(),
    model: z.string().min(1),
    baseUrl: z.string().url(),
    apiKey: z.string(),
  });
  const ModelEndpointConfigSchema = z.object({
    orchestrator: ModelConfigSchema.pick({
      primary: true,
      baseUrl: true,
      apiKey: true,
    }),
    embeddings: z.object({
      embeddingModel: z.string().min(1).optional(),
      embeddingBaseUrl: z.string().url().optional(),
      embeddingApiKey: z.string().optional(),
    }),
    reranker: RetrievalRerankerSchema.pick({
      enabled: true,
      model: true,
      baseUrl: true,
      apiKey: true,
    }),
    guard: ModelEndpointGuardSchema,
  });
  const ConfigAssistantRequestSchema = z.object({
    request: z.string().min(1).max(4000),
    mode: z.enum(["setup", "enhancement", "prompt"]).default("enhancement"),
    targetAgent: z.string().min(1).optional(),
  });
  const MainAssistantPersonalityRequestSchema = MainAssistantPersonalityEditableSchema.extend({
    reason: z.string().trim().min(1).max(400).optional(),
  });
  const ConfigAssistantFeedbackSchema = z.object({
    outcome: z.enum(["success", "failure", "partial", "rejected"]),
    lesson: z.string().min(1).max(400).optional(),
    notes: z.string().min(1).max(600).optional(),
  });
  const FlowMemoryCreateSchema = z.object({
    scope: z.enum(["setup", "enhancement", "prompt", "workflow"]),
    request: z.string().min(1).max(4000),
    summary: z.string().min(1).max(1200),
    assistantAgent: z.string().min(1).optional(),
    targetAgent: z.string().min(1).optional(),
    actions: z.array(z.string().min(1).max(240)).default([]),
    outcome: z.enum(["proposed", "applied", "success", "failure", "partial", "rejected"]),
    lesson: z.string().min(1).max(800).optional(),
    tags: z.array(z.string().min(1).max(40)).default([]),
  });

  // ── Request body size limit ──────────────────────────────────────────────
  const maxBodyBytes = config.gateway.maxBodyBytes ?? 1_048_576;
  app.use("*", async (c, next) => {
    const contentLength = c.req.header("Content-Length");
    const maxMultimodalBodyBytes = currentMultimodalConfig().maxUploadBytes ?? maxBodyBytes;
    const limit = c.req.path.startsWith("/api/multimodal/") ? maxMultimodalBodyBytes : maxBodyBytes;
    if (contentLength && Number(contentLength) > limit) {
      return c.json({ error: "Request body too large" }, 413);
    }
    await next();
  });

  app.use("*", cors({
    origin: Array.from(new Set([
      `http://localhost:${config.channels.webchat.port}`,
      `http://127.0.0.1:${config.channels.webchat.port}`,
      `http://host.docker.internal:${config.channels.webchat.port}`,
      "http://localhost:3001",   // Vite dev server
      "http://127.0.0.1:3001",
      "http://host.docker.internal:3001",
      originFromUrl(config.gateway.publicUrl),
      ...(config.gateway.corsAllowedOrigins ?? []).map((entry) => originFromUrl(entry)),
    ].filter((origin): origin is string => Boolean(origin)))),
    credentials: true,
  }));

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

  function bytesToBlob(bytes: Uint8Array, contentType: string): Blob {
    const arrayBuffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    return new Blob([arrayBuffer], { type: contentType });
  }

  function guessWorkspaceContentType(filePath: string): string {
    const extension = extname(filePath).toLowerCase();
    const contentTypes: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".htm": "text/html; charset=utf-8",
      ".md": "text/markdown; charset=utf-8",
      ".txt": "text/plain; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".pdf": "application/pdf",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
      ".wav": "audio/wav",
      ".mp3": "audio/mpeg",
      ".m4a": "audio/mp4",
      ".ogg": "audio/ogg",
      ".webm": "audio/webm",
      ".csv": "text/csv; charset=utf-8",
    };
    return contentTypes[extension] ?? "application/octet-stream";
  }

  function buildContentDisposition(filename: string, disposition: "inline" | "attachment"): string {
    const sanitized = filename.replace(/[\r\n"]/g, "_");
    return `${disposition}; filename="${sanitized}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
  }

  function resolveWorkspaceTarget(requestedPath: string): { resolved: string; relativePath: string } {
    return resolvePathWithinWorkspace(requestedPath, getConfig().workspacePath);
  }

  function mapWorkspaceRouteError(error: unknown): { status: 400 | 404 | 500; message: string } {
    if (error instanceof Error) {
      if (/workspace boundary|relative path within the workspace/i.test(error.message)) {
        return { status: 400, message: "Path must stay within the workspace" };
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { status: 404, message: "Workspace path not found" };
      }
      return { status: 500, message: error.message };
    }
    return { status: 500, message: String(error) };
  }

  async function addWorkspacePathToZip(zipFile: ZipFile, absolutePath: string, archivePath: string): Promise<void> {
    const fileStat = await stat(absolutePath);
    const normalizedArchivePath = archivePath.replace(/\\/g, "/");

    if (fileStat.isFile()) {
      zipFile.addFile(absolutePath, normalizedArchivePath);
      return;
    }

    if (!fileStat.isDirectory()) {
      throw new Error(`Unsupported workspace entry for archive: ${archivePath}`);
    }

    const entries = await readdir(absolutePath, { withFileTypes: true });
    if (entries.length === 0) {
      zipFile.addEmptyDirectory(normalizedArchivePath);
      return;
    }

    for (const entry of entries) {
      await addWorkspacePathToZip(zipFile, resolve(absolutePath, entry.name), `${normalizedArchivePath}/${entry.name}`);
    }
  }

  async function estimateDirectorySize(dirPath: string): Promise<{ totalBytes: number; entryCount: number }> {
    let totalBytes = 0;
    let entryCount = 0;
    const visit = async (current: string) => {
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        entryCount++;
        const fullPath = resolve(current, entry.name);
        if (entry.isFile()) {
          const fileStat = await stat(fullPath);
          totalBytes += fileStat.size;
        } else if (entry.isDirectory()) {
          await visit(fullPath);
        }
      }
    };
    await visit(dirPath);
    return { totalBytes, entryCount };
  }

  async function buildWorkspaceArchiveBuffer(absolutePath: string, archiveRoot: string): Promise<Buffer> {
    const zipFile = new ZipFile();
    const chunks: Buffer[] = [];

    const bufferPromise = new Promise<Buffer>((resolvePromise, rejectPromise) => {
      zipFile.outputStream.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      zipFile.outputStream.on("end", () => {
        resolvePromise(Buffer.concat(chunks));
      });
      zipFile.outputStream.on("error", rejectPromise);
    });

    await addWorkspacePathToZip(zipFile, absolutePath, archiveRoot);
    zipFile.end();
    return bufferPromise;
  }

  function currentModelEndpointConfig(cfg = getConfig()) {
    return {
      orchestrator: {
        primary: cfg.agents.defaults.model.primary,
        baseUrl: cfg.agents.defaults.model.baseUrl,
        apiKey: cfg.agents.defaults.model.apiKey,
      },
      embeddings: {
        embeddingModel: cfg.agents.defaults.model.embeddingModel,
        embeddingBaseUrl: cfg.agents.defaults.model.embeddingBaseUrl,
        embeddingApiKey: cfg.agents.defaults.model.embeddingApiKey,
      },
      reranker: {
        enabled: cfg.retrieval.reranker.enabled,
        model: cfg.retrieval.reranker.model,
        baseUrl: cfg.retrieval.reranker.baseUrl,
        apiKey: cfg.retrieval.reranker.apiKey,
      },
      guard: {
        enabled: cfg.guardrails.modelModeration.enabled,
        model: cfg.guardrails.modelModeration.model,
        baseUrl: cfg.guardrails.modelModeration.baseUrl,
        apiKey: cfg.guardrails.modelModeration.apiKey,
      },
    };
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

  async function callMultimodalToolViaMcp(input: {
    serverName: string;
    toolName: string;
    filename: string;
    contentType: string;
    fileBytes: ArrayBuffer;
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

  async function checkEndpointHealth(input: {
    baseUrl: string;
    apiKey?: string;
    timeoutMs: number;
    path: string;
    method?: "GET" | "POST" | "OPTIONS";
    body?: FormData | string;
    headers?: Record<string, string>;
    successStatuses?: number[];
  }): Promise<{ ok: boolean; status?: number; error?: string }> {
    const successStatuses = input.successStatuses ?? [200];

    try {
      const response = await fetchWithTimeout(
        upstreamUrl(input.baseUrl, input.path),
        {
          method: input.method ?? "GET",
          headers: upstreamHeaders(input.apiKey, input.headers),
          body: input.body,
        },
        Math.min(input.timeoutMs, 5000),
      );

      if (successStatuses.includes(response.status)) {
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

  function multimodalServiceConfigured(baseUrl: string | undefined): boolean {
    return typeof baseUrl === "string" && baseUrl.trim().length > 0;
  }

  function disabledServiceStatus(message: string): { ok: false; disabled: true; error: string } {
    return { ok: false, disabled: true, error: message };
  }

  function disabledServiceResponse(message: string): Response {
    return Response.json({ error: message, disabled: true }, { status: 503 });
  }

  async function checkSttHealth(baseUrl: string, apiKey: string | undefined, timeoutMs: number, model: string): Promise<{ ok: boolean; status?: number; error?: string }> {
    return checkSttHealthByApi("auto", baseUrl, apiKey, timeoutMs, model);
  }

  async function checkSttHealthByApi(api: "auto" | "openai-compatible" | "transcribe-only", baseUrl: string, apiKey: string | undefined, timeoutMs: number, model: string): Promise<{ ok: boolean; status?: number; error?: string }> {
    if (!multimodalServiceConfigured(baseUrl)) {
      return disabledServiceStatus("Disabled: no STT endpoint configured.");
    }

    if (api === "transcribe-only") {
      const healthProbe = await checkEndpointHealth({
        baseUrl,
        apiKey,
        timeoutMs,
        path: "/health",
        successStatuses: [200],
      });

      if (healthProbe.ok) return healthProbe;

      return checkEndpointHealth({
        baseUrl,
        apiKey,
        timeoutMs,
        path: "/transcribe",
        method: "POST",
        body: new FormData(),
        successStatuses: [200, 400, 401, 422],
      });
    }

    const openAiProbe = await checkEndpointHealth({
      baseUrl,
      apiKey,
      timeoutMs,
      path: "/v1/audio/transcriptions",
      method: "POST",
      body: (() => {
        const probe = new FormData();
        probe.append("model", model);
        return probe;
      })(),
      successStatuses: [200, 400, 401, 422],
    });

    if (api === "openai-compatible" || openAiProbe.ok || (openAiProbe.status !== 404 && openAiProbe.status !== 405)) {
      return openAiProbe;
    }

    const healthProbe = await checkEndpointHealth({
      baseUrl,
      apiKey,
      timeoutMs,
      path: "/health",
      successStatuses: [200],
    });

    return healthProbe.ok ? healthProbe : openAiProbe;
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

  async function readWorkspaceBinaryFile(path: string): Promise<{ filename: string; contentType: string; bytes: Uint8Array }> {
    const workspaceRoot = resolve(getConfig().workspacePath);
    const targetPath = resolve(workspaceRoot, path);
    if (!targetPath.startsWith(workspaceRoot)) {
      throw new Error("Audio example path escapes the workspace");
    }
    const fileStat = await stat(targetPath);
    if (!fileStat.isFile()) {
      throw new Error(`Audio example is not a file: ${path}`);
    }
    const bytes = await readFile(targetPath);
    const extension = extname(targetPath).toLowerCase();
    const contentTypes: Record<string, string> = {
      ".wav": "audio/wav",
      ".mp3": "audio/mpeg",
      ".m4a": "audio/mp4",
      ".webm": "audio/webm",
      ".ogg": "audio/ogg",
      ".flac": "audio/flac",
    };
    return {
      filename: basename(targetPath),
      contentType: contentTypes[extension] ?? "application/octet-stream",
      bytes,
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

  async function fetchTtsVoiceCatalog(config: {
    api: "qwen-compatible" | "openai-compatible";
    baseUrl: string;
    apiKey?: string;
    timeoutMs: number;
  }): Promise<Record<string, unknown>> {
    if (!multimodalServiceConfigured(config.baseUrl)) {
      throw new Error("TTS is disabled: no endpoint configured.");
    }

    if (config.api === "openai-compatible") {
      const [voicesResponse, modelsResponse] = await Promise.all([
        fetchWithTimeout(upstreamUrl(config.baseUrl, "/voices"), { headers: upstreamHeaders(config.apiKey) }, config.timeoutMs),
        fetchWithTimeout(upstreamUrl(config.baseUrl, "/models"), { headers: upstreamHeaders(config.apiKey) }, config.timeoutMs),
      ]);

      if (!modelsResponse.ok) throw new Error(await extractUpstreamError(modelsResponse, "Failed to load TTS models"));

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

    if (!voicesResponse.ok) throw new Error(await extractUpstreamError(voicesResponse, "Failed to load saved voices"));
    if (!speakersResponse.ok) throw new Error(await extractUpstreamError(speakersResponse, "Failed to load speakers"));
    if (!modelsResponse.ok) throw new Error(await extractUpstreamError(modelsResponse, "Failed to load TTS models"));

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

  // TTL-cached TTS capability snapshot (avoid hitting /models on every TTS request)
  let _ttsCapabilityCache: { result: Awaited<ReturnType<typeof getQwenTtsCapabilitySnapshotUncached>>; cachedAt: number } | null = null;
  const TTS_CAPABILITY_CACHE_TTL_MS = 60_000;

  async function getQwenTtsCapabilitySnapshot(input: {
    baseUrl: string;
    apiKey?: string;
    timeoutMs: number;
    requestedModel?: string;
  }) {
    if (_ttsCapabilityCache && (Date.now() - _ttsCapabilityCache.cachedAt) < TTS_CAPABILITY_CACHE_TTL_MS) {
      return _ttsCapabilityCache.result;
    }
    const result = await getQwenTtsCapabilitySnapshotUncached(input);
    _ttsCapabilityCache = { result, cachedAt: Date.now() };
    return result;
  }

  async function getQwenTtsCapabilitySnapshotUncached(input: {
    baseUrl: string;
    apiKey?: string;
    timeoutMs: number;
    requestedModel?: string;
  }): Promise<{
    modelId?: string;
    modelName?: string;
    capabilities?: string[];
    voiceCloneSupported?: boolean;
    customVoiceSupported?: boolean;
  } | null> {
    try {
      const response = await fetchWithTimeout(
        upstreamUrl(input.baseUrl, "/models"),
        { headers: upstreamHeaders(input.apiKey) },
        input.timeoutMs,
      );
      if (!response.ok) return null;

      const body = await parseUpstreamJsonResponse(response, "TTS model list returned a non-JSON response");
      const models = body["models"];
      if (!models || typeof models !== "object") return null;

      const modelMap = models as Record<string, unknown>;
      const requestedModel = input.requestedModel?.trim();
      const currentModel = typeof body["current_model"] === "string" ? body["current_model"] : undefined;
      const modelKey = requestedModel && requestedModel in modelMap
        ? requestedModel
        : currentModel && currentModel in modelMap
          ? currentModel
          : undefined;
      if (!modelKey) return null;

      const modelInfo = modelMap[modelKey];
      if (!modelInfo || typeof modelInfo !== "object") return null;

      const typedModelInfo = modelInfo as Record<string, unknown>;
      const capabilities = Array.isArray(typedModelInfo["capabilities"])
        ? (typedModelInfo["capabilities"] as unknown[]).map(String)
        : [];

      return {
        modelId: modelKey,
        modelName: typeof typedModelInfo["name"] === "string" ? typedModelInfo["name"] : modelKey,
        capabilities,
        voiceCloneSupported: capabilities.includes("voice_clone"),
        customVoiceSupported: capabilities.includes("custom_voice"),
      };
    } catch (err) {
      log.debug({ err }, "Failed to fetch TTS capability snapshot");
      return null;
    }
  }

  function qwenBuiltInSpeakerSupport(snapshot: {
    voiceCloneSupported?: boolean;
    customVoiceSupported?: boolean;
  } | null): boolean | undefined {
    if (!snapshot) return undefined;
    if (snapshot.customVoiceSupported) return true;
    if (snapshot.voiceCloneSupported) return false;
    return undefined;
  }

  async function sendTtsRequest(input: {
    api: "qwen-compatible" | "openai-compatible";
    baseUrl: string;
    apiKey?: string;
    timeoutMs: number;
    text: string;
    model?: string;
    language: string;
    speaker?: string;
    savedVoiceId?: string;
    audioExample?: { filename: string; contentType: string; bytes: Uint8Array };
    referenceText?: string;
    saveVoiceAs?: string;
    allowVoiceCloneFallback?: boolean;
    quality?: string;
    gender?: string;
    speed?: number;
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
    speaker?: string;
    savedVoiceId?: string;
    audioExample?: { filename: string; contentType: string; bytes: Uint8Array };
    referenceText?: string;
    saveVoiceAs?: string;
    allowVoiceCloneFallback?: boolean;
    quality?: string;
    gender?: string;
    speed?: number;
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
      if (!loadModelResponse.ok) return loadModelResponse;
    }

    const qwenCapabilitySnapshot = await getQwenTtsCapabilitySnapshot({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      timeoutMs: input.timeoutMs,
      requestedModel: model,
    });

    if (input.savedVoiceId) {
      if (qwenCapabilitySnapshot?.voiceCloneSupported === false) {
        const modelName = qwenCapabilitySnapshot.modelName ?? qwenCapabilitySnapshot.modelId ?? "The selected model";
        return new Response(JSON.stringify({
          error: `${modelName} does not support saved-voice playback. Switch to a qwen-compatible model with voice_clone capability.`,
        }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      const formData = new FormData();
      formData.append("text", input.text);
      formData.append("lang", language);
      return fetchWithTimeout(
        upstreamUrl(input.baseUrl, `/voices/${encodeURIComponent(input.savedVoiceId)}/tts`),
        { method: "POST", headers: upstreamHeaders(input.apiKey), body: formData },
        input.timeoutMs,
      );
    }

    if (input.audioExample) {
      const cloneSupported = qwenCapabilitySnapshot?.voiceCloneSupported;
      if (cloneSupported === false) {
        if (input.allowVoiceCloneFallback) {
          const builtInSpeakerSupported = qwenBuiltInSpeakerSupport(qwenCapabilitySnapshot);
          if (builtInSpeakerSupported === false) {
            const modelName = qwenCapabilitySnapshot?.modelName ?? qwenCapabilitySnapshot?.modelId ?? "The selected model";
            return new Response(JSON.stringify({
              error: `${modelName} does not support either voice cloning or built-in speaker synthesis in this qwen-compatible backend. Switch models or remove the voice sample and configure a saved voice ID instead.`,
            }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
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
          { method: "POST", headers: upstreamHeaders(input.apiKey), body: saveForm },
          input.timeoutMs,
        );
        if (!saveResponse.ok) return saveResponse;
        const savedVoice = await parseUpstreamJsonResponse(saveResponse, "Saved voice response was not JSON");
        const voiceId = typeof savedVoice["voice_id"] === "string" ? savedVoice["voice_id"] : input.saveVoiceAs;
        const formData = new FormData();
        formData.append("text", input.text);
        formData.append("lang", language);
        return fetchWithTimeout(
          upstreamUrl(input.baseUrl, `/voices/${encodeURIComponent(voiceId)}/tts`),
          { method: "POST", headers: upstreamHeaders(input.apiKey), body: formData },
          input.timeoutMs,
        );
      }

      const formData = new FormData();
      formData.append("text", input.text);
      formData.append("lang", language);
      formData.append("file", bytesToBlob(input.audioExample.bytes, input.audioExample.contentType), input.audioExample.filename);
      const route = input.referenceText ? "/clone-with-ref-text" : "/clone";
      if (input.referenceText) formData.append("ref_text", input.referenceText);
      return fetchWithTimeout(
        upstreamUrl(input.baseUrl, route),
        { method: "POST", headers: upstreamHeaders(input.apiKey), body: formData },
        input.timeoutMs,
      );
    }

    if (qwenBuiltInSpeakerSupport(qwenCapabilitySnapshot) === false) {
      const modelName = qwenCapabilitySnapshot?.modelName ?? qwenCapabilitySnapshot?.modelId ?? "The selected model";
      return new Response(JSON.stringify({
        error: `${modelName} does not support built-in speaker synthesis in this qwen-compatible backend. Use a saved voice ID or audio example, or switch to a model with custom_voice capability.`,
      }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
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
    return (await getQwenTtsCapabilitySnapshot(input))?.voiceCloneSupported;
  }

  // ── Health endpoints ─────────────────────────────────────────────────────
  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.get("/readyz", (c) => {
    const sessions = getAllSessions().length;
    return c.json({ status: "ready", sessions });
  });

  // ── Status endpoint (auth required) ─────────────────────────────────────
  app.get("/api/status", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    return c.json({
      version: "0.1.0",
      uptime: process.uptime(),
      sessions: getAllSessions().map(s => ({
        id: s.id,
        channel: s.channel,
        createdAt: s.createdAt,
        turns: s.getTurnCount(),
      })),
    });
  });

  app.get("/api/runtime/status", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    return c.json(getRuntimeStatusSnapshot());
  });

  app.get("/api/model-endpoints/status", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const endpoints = await syncModelEndpointRuntimeStatus();
    return c.json({
      healthy: endpoints.every((endpoint) => endpoint.ok),
      endpoints: endpoints.length > 0 ? endpoints : getModelEndpointHealthSnapshot(),
    });
  });

  app.get("/api/providers/status", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    return c.json(await syncChatProviderRuntimeStatus());
  });

  app.get("/api/model-endpoints/config", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    return c.json(currentModelEndpointConfig());
  });

  app.put("/api/model-endpoints/config", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = ModelEndpointConfigSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid model endpoint configuration", details: parsed.error.flatten() }, 400);
    }

    try {
      const updatedConfig = updateConfig((raw) => {
        const agents = (raw["agents"] as Record<string, unknown> | undefined) ?? {};
        const defaults = (agents["defaults"] as Record<string, unknown> | undefined) ?? {};
        const defaultModel = (defaults["model"] as Record<string, unknown> | undefined) ?? {};
        const retrieval = (raw["retrieval"] as Record<string, unknown> | undefined) ?? {};
        const reranker = (retrieval["reranker"] as Record<string, unknown> | undefined) ?? {};
        const guardrails = (raw["guardrails"] as Record<string, unknown> | undefined) ?? {};
        const modelModeration = (guardrails["modelModeration"] as Record<string, unknown> | undefined) ?? {};

        raw["agents"] = {
          ...agents,
          defaults: {
            ...defaults,
            model: {
              ...defaultModel,
              primary: parsed.data.orchestrator.primary,
              baseUrl: parsed.data.orchestrator.baseUrl,
              apiKey: parsed.data.orchestrator.apiKey,
              embeddingModel: parsed.data.embeddings.embeddingModel,
              embeddingBaseUrl: parsed.data.embeddings.embeddingBaseUrl,
              embeddingApiKey: parsed.data.embeddings.embeddingApiKey,
            },
          },
        };

        raw["retrieval"] = {
          ...retrieval,
          reranker: {
            ...reranker,
            enabled: parsed.data.reranker.enabled,
            model: parsed.data.reranker.model,
            baseUrl: parsed.data.reranker.baseUrl,
            apiKey: parsed.data.reranker.apiKey,
          },
        };

        raw["guardrails"] = {
          ...guardrails,
          modelModeration: {
            ...modelModeration,
            enabled: parsed.data.guard.enabled,
            model: parsed.data.guard.model,
            baseUrl: parsed.data.guard.baseUrl,
            apiKey: parsed.data.guard.apiKey,
          },
        };
      });

      await syncModelEndpointRuntimeStatus();
      return c.json(currentModelEndpointConfig(updatedConfig));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.get("/api/multimodal/status", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const multimodalConfig = currentMultimodalConfig();

    const imageGenHealthPromise = multimodalConfig.imageGeneration
      ? checkImageGenerationHealth(multimodalConfig.imageGeneration)
      : Promise.resolve(null);
    const ttsCapabilityPromise = multimodalConfig.tts.api === "qwen-compatible" && multimodalServiceConfigured(multimodalConfig.tts.baseUrl)
      ? getQwenTtsCapabilitySnapshot({
          baseUrl: multimodalConfig.tts.baseUrl,
          apiKey: multimodalConfig.tts.apiKey,
          timeoutMs: multimodalConfig.tts.timeoutMs,
          requestedModel: multimodalConfig.tts.model,
        })
      : Promise.resolve(null);

    const visionModel = multimodalConfig.files.visionModel;
    const vision = visionModel
      ? checkEndpointHealth({
          baseUrl: resolveProviderEndpointForModel(
            visionModel,
            {
              baseUrl: multimodalConfig.files.visionBaseUrl,
              apiKey: multimodalConfig.files.visionApiKey,
            },
            getConfig(),
          ).baseUrl,
          apiKey: resolveProviderEndpointForModel(
            visionModel,
            {
              baseUrl: multimodalConfig.files.visionBaseUrl,
              apiKey: multimodalConfig.files.visionApiKey,
            },
            getConfig(),
          ).apiKey,
          timeoutMs: multimodalConfig.files.timeoutMs,
          path: "/models",
        })
      : Promise.resolve(null);

    const [files, stt, tts, imageGeneration, visionHealth, ttsCapabilitySnapshot] = await Promise.all([
      checkEndpointHealth({
        baseUrl: multimodalConfig.files.baseUrl,
        apiKey: multimodalConfig.files.apiKey,
        timeoutMs: multimodalConfig.files.timeoutMs,
        path: "/api/health",
      }),
      checkSttHealthByApi(multimodalConfig.stt.api, multimodalConfig.stt.baseUrl, multimodalConfig.stt.apiKey, multimodalConfig.stt.timeoutMs, multimodalConfig.stt.model),
      !multimodalServiceConfigured(multimodalConfig.tts.baseUrl)
        ? Promise.resolve(disabledServiceStatus("Disabled: no TTS endpoint configured."))
        : multimodalConfig.tts.api === "openai-compatible"
          ? checkEndpointHealth({
              baseUrl: multimodalConfig.tts.baseUrl,
              apiKey: multimodalConfig.tts.apiKey,
              timeoutMs: multimodalConfig.tts.timeoutMs,
              path: "/models",
            })
          : checkEndpointHealth({
              baseUrl: multimodalConfig.tts.baseUrl,
              apiKey: multimodalConfig.tts.apiKey,
              timeoutMs: multimodalConfig.tts.timeoutMs,
              path: "/health",
            }),
      imageGenHealthPromise,
      vision,
      ttsCapabilityPromise,
    ]);

    return c.json({
      files,
      vision: visionHealth,
      stt,
      tts: {
        ...tts,
        ...(ttsCapabilitySnapshot ?? {}),
      },
      imageGeneration,
      wakeWord: multimodalConfig.wakeWord,
    });
  });


  app.get("/api/multimodal/config", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    return c.json(currentMultimodalConfig());
  });

  app.put("/api/multimodal/config", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = MultimodalSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid multimodal configuration", details: parsed.error.flatten() }, 400);
    }

    try {
      const updatedConfig = updateConfig((raw) => {
        raw["multimodal"] = parsed.data;
      });
      return c.json(updatedConfig.multimodal);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.post("/api/multimodal/file-to-markdown", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const multimodalConfig = currentMultimodalConfig();

    const formData = await c.req.raw.formData();
    const uploadedFile = formData.get("file");
    if (!(uploadedFile instanceof File)) {
      return c.json({ error: "file is required" }, 400);
    }

    const isImage = uploadedFile.type.startsWith("image/");
    const fileBytes = await uploadedFile.arrayBuffer();

    // Buffer image bytes once — needed for both upstream and the vision fallback
    const imageBytes = isImage ? fileBytes : null;

    let markdownFromUpstream = "";

    if (multimodalConfig.files.mcpServer) {
      try {
        const body = await callMultimodalToolViaMcp({
          serverName: multimodalConfig.files.mcpServer,
          toolName: multimodalConfig.files.toolName,
          filename: uploadedFile.name,
          contentType: uploadedFile.type,
          fileBytes,
          timeoutMs: multimodalConfig.files.timeoutMs,
        });
        markdownFromUpstream = (typeof body["markdown"] === "string" ? body["markdown"] : "").trim();
        if (markdownFromUpstream) {
          return c.json({ ...body, filename: typeof body["filename"] === "string" ? body["filename"] : uploadedFile.name });
        }
      } catch (err) {
        if (!isImage) {
          return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
        }
        log.warn({ err, filename: uploadedFile.name, server: multimodalConfig.files.mcpServer }, "MCP file_to_markdown failed for image — trying REST/vision fallbacks");
      }
    }

    const upstreamFormData = new FormData();
    if (imageBytes) {
      upstreamFormData.append("file", new Blob([imageBytes], { type: uploadedFile.type }), uploadedFile.name);
    } else {
      upstreamFormData.append("file", uploadedFile, uploadedFile.name);
    }

    try {
      const upstream = await fetchWithTimeout(
        upstreamUrl(multimodalConfig.files.baseUrl, `/api/tools/${multimodalConfig.files.toolName}`),
        {
          method: "POST",
          headers: upstreamHeaders(multimodalConfig.files.apiKey),
          body: upstreamFormData,
        },
        multimodalConfig.files.timeoutMs,
      );
      if (upstream.ok) {
        const body = await parseUpstreamJsonResponse(upstream, "File conversion returned a non-JSON response") as Record<string, unknown>;
        markdownFromUpstream = (typeof body["markdown"] === "string" ? body["markdown"] : "").trim();
        if (markdownFromUpstream) return c.json(body);
      } else if (!isImage) {
        return new Response(JSON.stringify({ error: await extractUpstreamError(upstream, "File conversion failed") }), {
          status: upstream.status,
          headers: { "Content-Type": "application/json" },
        });
      }
    } catch (err) {
      if (!isImage) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
      }
      log.warn({ err, filename: uploadedFile.name }, "file_to_markdown upstream failed for image — trying vision fallback");
    }

    // ── Vision model fallback for images ──────────────────────────────────────
    // Triggered when: file is an image AND upstream returned empty markdown (no vision LLM
    // configured in markitdown) OR upstream call failed entirely.
    if (isImage && imageBytes && multimodalConfig.files.visionModel) {
      try {
        const base64 = Buffer.from(imageBytes).toString("base64");
        const dataUrl = `data:${uploadedFile.type};base64,${base64}`;
        const providerConfig = getConfig().providers?.lmstudio;
        const visionBaseUrl = (multimodalConfig.files.visionBaseUrl ?? providerConfig?.baseUrl ?? "http://host.docker.internal:1234/v1").replace(/\/$/, "");
        const visionApiKey = multimodalConfig.files.visionApiKey ?? providerConfig?.apiKey ?? "lm-studio";
        // Strip provider prefix (e.g. "lmstudio/qwen2-vl-7b-instruct" → "qwen2-vl-7b-instruct")
        const modelId = multimodalConfig.files.visionModel.replace(/^[^/]+\//, "");

        const visionRes = await fetchWithTimeout(
          `${visionBaseUrl}/chat/completions`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${visionApiKey}` },
            body: JSON.stringify({
              model: modelId,
              messages: [{
                role: "user",
                content: [
                  { type: "image_url", image_url: { url: dataUrl } },
                  { type: "text", text: "Analyze this image in detail. Extract all visible text exactly as written. Identify key UI elements, data, charts, error messages, or any other relevant content. Provide a structured Markdown description." },
                ],
              }],
              max_tokens: 2048,
              temperature: 0.1,
            }),
          },
          multimodalConfig.files.timeoutMs,
        );

        if (visionRes.ok) {
          const visionBody = await visionRes.json() as { choices?: Array<{ message?: { content?: string } }> };
          const description = visionBody.choices?.[0]?.message?.content?.trim() ?? "";
          if (description) {
            log.info({ filename: uploadedFile.name, model: modelId }, "Vision model fallback succeeded");
            return c.json({ markdown: description, filename: uploadedFile.name });
          }
        } else {
          log.warn({ status: visionRes.status, filename: uploadedFile.name }, "Vision model fallback returned non-OK status");
        }
      } catch (err) {
        log.warn({ err, filename: uploadedFile.name }, "Vision model fallback failed");
      }
    }

    // Return empty markdown — frontend keeps the image placeholder and the assistant can decide
    // whether to use direct vision analysis or delegate specialist follow-up.
    return c.json({ markdown: "", filename: uploadedFile.name });
  });

  app.post("/api/multimodal/transcribe", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const multimodalConfig = currentMultimodalConfig();

    const formData = await c.req.raw.formData();
    const uploadedFile = formData.get("file");
    if (!(uploadedFile instanceof File)) {
      return c.json({ error: "file is required" }, 400);
    }
    if (uploadedFile.size <= 0) {
      return c.json({ error: "Audio upload was empty. Record a little longer and try again." }, 400);
    }
    if (!multimodalServiceConfigured(multimodalConfig.stt.baseUrl)) {
      return disabledServiceResponse("STT is disabled: configure multimodal.stt.baseUrl to enable transcription.");
    }

    const audioBlob = new Blob([await uploadedFile.arrayBuffer()], { type: uploadedFile.type || "application/octet-stream" });
    const filename = uploadedFile.name || "audio.wav";
    const model = String(formData.get("model") ?? multimodalConfig.stt.model);

    const languageValue = formData.get("language");
    const language = typeof languageValue === "string" && languageValue.trim() ? languageValue.trim() : undefined;

    const promptValue = formData.get("prompt");
    const prompt = typeof promptValue === "string" && promptValue.trim() ? promptValue.trim() : undefined;

    try {
      const upstream = await sendSttRequest({
        api: multimodalConfig.stt.api,
        baseUrl: multimodalConfig.stt.baseUrl,
        apiKey: multimodalConfig.stt.apiKey,
        timeoutMs: multimodalConfig.stt.timeoutMs,
        model,
        audioBlob,
        filename,
        language,
        prompt,
      });
      if (!upstream.ok) {
        return new Response(JSON.stringify({ error: await extractUpstreamError(upstream, "Transcription failed") }), {
          status: upstream.status,
          headers: { "Content-Type": "application/json" },
        });
      }
      const body = await parseUpstreamJsonResponse(upstream, "Transcription returned a non-JSON response");
      const segments = Array.isArray(body["segments"])
        ? body["segments"].map((segment) => {
            if (typeof segment === "string") return segment;
            if (segment && typeof segment === "object" && "text" in segment) return String(segment["text"] ?? "");
            return "";
          }).filter(Boolean).join(" ").trim()
        : "";
      return c.json({
        text: String(body["text"] ?? body["transcription"] ?? body["result"] ?? segments ?? ""),
        language: body["language"] ?? body["detected_language"] ?? body["lang"],
        duration: body["duration"] ?? body["processing_time"],
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
  });

  app.get("/api/multimodal/voices", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const multimodalConfig = currentMultimodalConfig();

    if (!multimodalServiceConfigured(multimodalConfig.tts.baseUrl)) {
      return disabledServiceResponse("TTS is disabled: configure multimodal.tts.baseUrl to enable voice discovery.");
    }

    try {
      return c.json(await fetchTtsVoiceCatalog(multimodalConfig.tts));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
  });

  app.post("/api/multimodal/voices/save", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const multimodalConfig = currentMultimodalConfig();

    if (!multimodalServiceConfigured(multimodalConfig.tts.baseUrl)) {
      return disabledServiceResponse("TTS is disabled: configure multimodal.tts.baseUrl to enable voice saving.");
    }

    const formData = await c.req.raw.formData();
    const uploadedFile = formData.get("file");
    if (!(uploadedFile instanceof File)) {
      return c.json({ error: "file is required" }, 400);
    }

    const nameValue = formData.get("name");
    const name = typeof nameValue === "string" ? nameValue.trim() : "";
    if (!name) {
      return c.json({ error: "name is required" }, 400);
    }

    const languageValue = formData.get("language");
    const language = typeof languageValue === "string" && languageValue.trim()
      ? normalizeTtsLanguage(languageValue.trim(), multimodalConfig.tts.api)
      : normalizeTtsLanguage(multimodalConfig.tts.defaultLanguage, multimodalConfig.tts.api);
    const referenceTextValue = formData.get("referenceText") ?? formData.get("ref_text");
    const referenceText = typeof referenceTextValue === "string" && referenceTextValue.trim()
      ? referenceTextValue.trim()
      : "";

    if (multimodalConfig.tts.api !== "qwen-compatible") {
      return c.json({ error: "Voice sample saving is only supported for qwen-compatible TTS backends." }, 400);
    }

    try {
      if (multimodalConfig.tts.model?.trim()) {
        const loadModelResponse = await fetchWithTimeout(
          upstreamUrl(multimodalConfig.tts.baseUrl, "/load_model"),
          {
            method: "POST",
            headers: upstreamHeaders(multimodalConfig.tts.apiKey, { "Content-Type": "application/json" }),
            body: JSON.stringify({ model: multimodalConfig.tts.model }),
          },
          multimodalConfig.tts.timeoutMs,
        );
        if (!loadModelResponse.ok) {
          return new Response(JSON.stringify({ error: await extractUpstreamError(loadModelResponse, "Failed to load Qwen3 TTS model") }), {
            status: loadModelResponse.status,
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      const qwenCapabilitySnapshot = await getQwenTtsCapabilitySnapshot({
        baseUrl: multimodalConfig.tts.baseUrl,
        apiKey: multimodalConfig.tts.apiKey,
        timeoutMs: multimodalConfig.tts.timeoutMs,
        requestedModel: multimodalConfig.tts.model,
      });
      if (qwenCapabilitySnapshot?.voiceCloneSupported === false) {
        const modelName = qwenCapabilitySnapshot.modelName ?? qwenCapabilitySnapshot.modelId ?? "The selected model";
        return c.json({
          error: `${modelName} does not support saving or replaying cloned voices. Switch to a qwen-compatible Base model with voice_clone capability.`,
        }, 400);
      }

      const upstreamForm = new FormData();
      upstreamForm.append("name", name);
      upstreamForm.append("lang", language);
      upstreamForm.append("file", uploadedFile, uploadedFile.name);
      if (referenceText) upstreamForm.append("ref_text", referenceText);

      const upstream = await fetchWithTimeout(
        upstreamUrl(multimodalConfig.tts.baseUrl, "/voices/save"),
        {
          method: "POST",
          headers: upstreamHeaders(multimodalConfig.tts.apiKey),
          body: upstreamForm,
        },
        multimodalConfig.tts.timeoutMs,
      );

      if (!upstream.ok) {
        return new Response(JSON.stringify({ error: await extractUpstreamError(upstream, "Saving voice sample failed") }), {
          status: upstream.status,
          headers: { "Content-Type": "application/json" },
        });
      }

      return c.json(await parseUpstreamJsonResponse(upstream, "Saved voice response was not JSON"));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
  });

  app.post("/api/multimodal/tts", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const multimodalConfig = currentMultimodalConfig();

    if (!multimodalServiceConfigured(multimodalConfig.tts.baseUrl)) {
      return disabledServiceResponse("TTS is disabled: configure multimodal.tts.baseUrl to enable speech synthesis.");
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const text = String(body["text"] ?? "").trim();
    if (!text) return c.json({ error: "text is required" }, 400);

    try {
      const explicitAudioExamplePath = typeof body["audioExamplePath"] === "string" && body["audioExamplePath"].trim()
        ? body["audioExamplePath"].trim()
        : undefined;
      const explicitReferenceText = typeof body["referenceText"] === "string" && body["referenceText"].trim()
        ? body["referenceText"].trim()
        : undefined;
      const explicitSaveVoiceAs = typeof body["saveVoiceAs"] === "string" && body["saveVoiceAs"].trim()
        ? body["saveVoiceAs"].trim()
        : undefined;
      const audioExamplePath = explicitAudioExamplePath
        ? explicitAudioExamplePath
        : multimodalConfig.tts.voiceSamplePath;
      const upstream = await sendTtsRequest({
        api: multimodalConfig.tts.api,
        baseUrl: multimodalConfig.tts.baseUrl,
        apiKey: multimodalConfig.tts.apiKey,
        timeoutMs: multimodalConfig.tts.timeoutMs,
        text,
        model: typeof body["model"] === "string" && body["model"].trim()
          ? body["model"].trim()
          : multimodalConfig.tts.model,
        language: typeof body["language"] === "string" && body["language"].trim()
          ? body["language"].trim()
          : multimodalConfig.tts.defaultLanguage,
        speaker: typeof body["speaker"] === "string" && body["speaker"].trim()
          ? body["speaker"].trim()
          : multimodalConfig.tts.defaultSpeaker,
        savedVoiceId: typeof body["voiceId"] === "string" && body["voiceId"].trim()
          ? body["voiceId"].trim()
          : typeof body["voice"] === "string" && body["voice"].trim()
            ? body["voice"].trim()
            : multimodalConfig.tts.defaultVoiceId,
        audioExample: audioExamplePath ? await readWorkspaceBinaryFile(audioExamplePath) : undefined,
        referenceText: explicitReferenceText ?? multimodalConfig.tts.voiceSampleText,
        saveVoiceAs: explicitSaveVoiceAs,
        allowVoiceCloneFallback: !explicitAudioExamplePath && !explicitReferenceText && !explicitSaveVoiceAs,
        quality: typeof body["quality"] === "string" ? body["quality"] : multimodalConfig.tts.defaultQuality,
        gender: typeof body["gender"] === "string" ? body["gender"] : undefined,
        speed: typeof body["speed"] === "number" ? body["speed"] : undefined,
      });

      if (!upstream.ok) {
        return new Response(JSON.stringify({ error: await extractUpstreamError(upstream, "Speech synthesis failed") }), {
          status: upstream.status,
          headers: { "Content-Type": "application/json" },
        });
      }

      const audio = await upstream.arrayBuffer();
      return new Response(audio, {
        status: 200,
        headers: {
          "Content-Type": upstream.headers.get("content-type") ?? "audio/wav",
          "Cache-Control": "no-store",
        },
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
  });

  // ── Summarize-for-speech ─────────────────────────────────────────────────
  // POST /api/multimodal/summarize-for-speech
  //   Body: { text: string, maxSentences?: number }
  //   Returns: { summary: string }
  // Condenses a long assistant reply to a spoken-friendly summary using the
  // configured LLM.  Used by the auto-speak feature in the web UI.

  app.post("/api/multimodal/summarize-for-speech", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const text = String(body["text"] ?? "").trim();
    if (!text) return c.json({ error: "text is required" }, 400);

    const multimodalConfig = currentMultimodalConfig();
    const maxSentences = typeof body["maxSentences"] === "number"
      ? Math.min(Math.max(1, Math.round(body["maxSentences"])), 5)
      : (multimodalConfig.tts.speakReplySummaryMaxSentences ?? 3);

    try {
      const { getChatProvider } = await import("../providers/index.js");
      const provider = getChatProvider();
      const llmResponse = await provider.complete(
        [
          {
            role: "system",
            content: buildSpeechSummarySystemPrompt(maxSentences, text),
          },
          {
            role: "user",
            content: buildSpeechSummaryUserPrompt(text),
          },
        ],
        [],
      );
      const summary = (llmResponse.content ?? "").trim();
      if (!summary) return c.json({ error: "Summarisation returned empty response" }, 500);
      return c.json({ summary });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
  });

  // ── Direct image analysis ────────────────────────────────────────────────
  // POST /api/multimodal/analyze-image
  //   Multipart form: field "file" — any image (PNG, JPEG, WebP, GIF, BMP)
  //   Optional form field "prompt" — custom question about the image
  //   Returns: { analysis: string }
  // Encodes the image as base64 and sends it directly to the vision LLM —
  // nothing is written to disk.

  app.post("/api/multimodal/analyze-image", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const formData = await c.req.raw.formData();
    const uploadedFile = formData.get("file");
    if (!(uploadedFile instanceof File)) return c.json({ error: "file field is required" }, 400);

    const promptValue = formData.get("prompt");
    const userPrompt = typeof promptValue === "string" && promptValue.trim()
      ? promptValue.trim()
      : "Analyze this image in detail. Extract all visible text exactly as written. Identify all UI elements, data, charts, diagrams, error messages, and any other relevant content. Provide a structured Markdown description.";

    const imageBytes = new Uint8Array(await uploadedFile.arrayBuffer());
    const base64 = Buffer.from(imageBytes).toString("base64");
    const mimeType = uploadedFile.type || "image/png";
    const dataUrl = `data:${mimeType};base64,${base64}`;

    const cfg = getConfig();
    const multimodalConfig = currentMultimodalConfig();
    const visionModelRaw = multimodalConfig.files.visionModel ?? cfg.agents.defaults.model.primary;
    const visionEndpoint = resolveProviderEndpointForModel(
      visionModelRaw,
      {
        baseUrl: multimodalConfig.files.visionBaseUrl,
        apiKey: multimodalConfig.files.visionApiKey,
      },
      cfg,
    );
    const visionBaseUrl = visionEndpoint.baseUrl.replace(/\/$/, "");
    const visionApiKey = visionEndpoint.apiKey;

    // Use dedicated vision model if configured, otherwise fall back to default LLM
    // (qwen3.5-35b is vision-enabled so no separate model is needed)
    const modelId = visionModelRaw.replace(/^[^/]+\//, "");

    try {
      const res = await fetchWithTimeout(
        `${visionBaseUrl}/chat/completions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${visionApiKey}` },
          body: JSON.stringify({
            model: modelId,
            messages: [{
              role: "user",
              content: [
                { type: "image_url", image_url: { url: dataUrl } },
                { type: "text", text: userPrompt },
              ],
            }],
            max_tokens: 2048,
            temperature: 0.1,
          }),
        },
        multimodalConfig.files.timeoutMs,
      );

      if (!res.ok) {
        return c.json({ error: await extractUpstreamError(res, "Vision LLM returned an error") }, 502);
      }

      const body = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      const analysis = body.choices?.[0]?.message?.content?.trim() ?? "";
      if (!analysis) return c.json({ error: "Vision model returned empty analysis" }, 500);

      return c.json({ analysis, model: modelId, filename: uploadedFile.name });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
  });

  // ── Image generation ─────────────────────────────────────────────────────
  // POST /api/multimodal/generate-image
  //   Body: { prompt, negativePrompt?, width?, height?, steps?, guidanceScale?, seed? }
  //   Returns: { image: "<base64-png>", width, height, seed, model, elapsed_ms }
  // Proxies to the configured image-generation service. The agent generate_image tool uses the
  // same service directly; this endpoint is for dashboard / programmatic use.

  app.post("/api/multimodal/generate-image", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const multimodalConfig = currentMultimodalConfig();

    if (!multimodalConfig.imageGeneration) {
      return c.json({ error: "Image generation is not configured. Add multimodal.imageGeneration to starlingai.json." }, 503);
    }
    if (!imageGenerationServiceConfigured(multimodalConfig.imageGeneration.baseUrl)) {
      return disabledServiceResponse("Image generation is disabled: configure multimodal.imageGeneration.baseUrl to enable it.");
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.json() as Record<string, unknown>;
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const prompt = typeof body["prompt"] === "string" ? body["prompt"].trim() : "";
    if (!prompt) return c.json({ error: "prompt is required" }, 400);

    const imgConfig = multimodalConfig.imageGeneration;
    try {
      const result = await requestImageGeneration(imgConfig, {
        prompt,
        model: typeof body["model"] === "string" && body["model"].trim() ? body["model"].trim() : imgConfig.model,
        negativePrompt: typeof body["negativePrompt"] === "string" ? body["negativePrompt"] : imgConfig.defaultNegativePrompt,
        width: typeof body["width"] === "number" ? body["width"] : imgConfig.defaultWidth,
        height: typeof body["height"] === "number" ? body["height"] : imgConfig.defaultHeight,
        steps: typeof body["steps"] === "number" ? body["steps"] : imgConfig.defaultSteps,
        guidanceScale: typeof body["guidanceScale"] === "number" ? body["guidanceScale"] : imgConfig.defaultGuidanceScale,
        seed: typeof body["seed"] === "number" ? body["seed"] : undefined,
      });

      return c.json({
        image: result.imageBase64,
        contentType: result.mimeType,
        extension: result.extension,
        width: result.width,
        height: result.height,
        seed: result.seed,
        model: result.model,
        elapsed_ms: result.elapsedMs,
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
  });

  // ── Workspace file upload ────────────────────────────────────────────────
  // POST /api/workspace/upload
  //   Multipart form: field "file" — any file type
  //   Optional form field "subdir" — subdirectory under workspace (default: "uploads")
  //   Returns: { workspacePath: "<configured-workspace>/uploads/foo.png", relativePath: "uploads/foo.png", filename: "foo.png" }
  // Saves the uploaded file into the workspace volume so agents can access it.

  app.post("/api/workspace/upload", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const formData = await c.req.raw.formData();
    const uploadedFile = formData.get("file");
    if (!(uploadedFile instanceof File)) {
      return c.json({ error: "file field is required" }, 400);
    }

    const subdirRaw = formData.get("subdir");
    const subdir = (typeof subdirRaw === "string" && /^[\w/-]+$/.test(subdirRaw))
      ? subdirRaw
      : "uploads";

    // Sanitise filename: keep extension, replace unsafe characters
    const ext = extname(uploadedFile.name);
    const safeName = basename(uploadedFile.name, ext)
      .replace(/[^\w\s.-]/g, "_")
      .replace(/\s+/g, "_")
      .slice(0, 120) + ext;

    const workspaceRoot = getConfig().workspacePath;
    const targetDir = resolve(workspaceRoot, subdir);
    const targetPath = resolve(targetDir, safeName);

    // Prevent path traversal
    if (!targetPath.startsWith(resolve(workspaceRoot))) {
      return c.json({ error: "Invalid upload path" }, 400);
    }

    try {
      await mkdir(targetDir, { recursive: true });
      const buffer = new Uint8Array(await uploadedFile.arrayBuffer());
      await writeFile(targetPath, buffer);

      const relativePath = `${subdir}/${safeName}`;
      return c.json({
        workspacePath: `${workspaceRoot}/${subdir}/${safeName}`,
        relativePath,
        filename: safeName,
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  const WORKSPACE_FILE_MAX_BYTES = 256 * 1024 * 1024; // 256 MB
  const WORKSPACE_ARCHIVE_MAX_BYTES = 512 * 1024 * 1024; // 512 MB
  const WORKSPACE_ARCHIVE_MAX_ENTRIES = 10_000;

  app.get("/api/workspace/file", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const requestedPath = c.req.query("path")?.trim();
    if (!requestedPath) {
      return c.json({ error: "path query parameter is required" }, 400);
    }

    const disposition = c.req.query("disposition") === "attachment" ? "attachment" : "inline";

    try {
      const { resolved, relativePath } = resolveWorkspaceTarget(requestedPath);
      const fileStat = await stat(resolved);
      if (!fileStat.isFile()) {
        return c.json({ error: "Requested workspace path is not a file" }, 400);
      }
      if (fileStat.size > WORKSPACE_FILE_MAX_BYTES) {
        return c.json({ error: `File too large (${Math.round(fileStat.size / 1024 / 1024)} MB). Maximum is ${WORKSPACE_FILE_MAX_BYTES / 1024 / 1024} MB.` }, 413);
      }

      const bytes = await readFile(resolved);
      const filename = basename(resolved);
      return c.body(bytes, 200, {
        "Content-Type": guessWorkspaceContentType(filename),
        "Content-Disposition": buildContentDisposition(filename, disposition),
        "X-Workspace-Path": relativePath,
      });
    } catch (error) {
      const mapped = mapWorkspaceRouteError(error);
      return c.json({ error: mapped.message }, mapped.status);
    }
  });

  app.get("/api/workspace/archive", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const requestedPath = c.req.query("path")?.trim();
    if (!requestedPath) {
      return c.json({ error: "path query parameter is required" }, 400);
    }

    try {
      const { resolved, relativePath } = resolveWorkspaceTarget(requestedPath);
      const fileStat = await stat(resolved);
      if (!fileStat.isFile() && !fileStat.isDirectory()) {
        return c.json({ error: "Requested workspace path must be a file or directory" }, 400);
      }

      // Pre-flight size/entry check for directories
      if (fileStat.isDirectory()) {
        const { totalBytes, entryCount } = await estimateDirectorySize(resolved);
        if (entryCount > WORKSPACE_ARCHIVE_MAX_ENTRIES) {
          return c.json({ error: `Directory has too many entries (${entryCount}). Maximum is ${WORKSPACE_ARCHIVE_MAX_ENTRIES}.` }, 413);
        }
        if (totalBytes > WORKSPACE_ARCHIVE_MAX_BYTES) {
          return c.json({ error: `Directory too large (${Math.round(totalBytes / 1024 / 1024)} MB). Maximum is ${WORKSPACE_ARCHIVE_MAX_BYTES / 1024 / 1024} MB.` }, 413);
        }
      } else if (fileStat.size > WORKSPACE_ARCHIVE_MAX_BYTES) {
        return c.json({ error: `File too large (${Math.round(fileStat.size / 1024 / 1024)} MB). Maximum is ${WORKSPACE_ARCHIVE_MAX_BYTES / 1024 / 1024} MB.` }, 413);
      }

      const archiveBaseName = basename(resolved) || "workspace";
      const archiveBytes = await buildWorkspaceArchiveBuffer(resolved, archiveBaseName);
      const archiveName = `${archiveBaseName}.zip`;
      const responseBytes = new Uint8Array(archiveBytes);

      return c.body(responseBytes, 200, {
        "Content-Type": "application/zip",
        "Content-Disposition": buildContentDisposition(archiveName, "attachment"),
        "X-Workspace-Path": relativePath,
      });
    } catch (error) {
      const mapped = mapWorkspaceRouteError(error);
      return c.json({ error: mapped.message }, mapped.status);
    }
  });

  app.get("/api/sessions/:sessionId/debug-markdown", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const sessionId = c.req.param("sessionId")?.trim();
    if (!sessionId) {
      return c.json({ error: "sessionId is required" }, 400);
    }

    try {
      const markdown = await buildSessionDebugMarkdown(sessionId);
      const filename = `starlingai-session-${sessionId.slice(0, 8)}-debug.md`;
      return c.body(markdown, 200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": buildContentDisposition(filename, "attachment"),
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("Session not found")) {
        return c.json({ error: error.message }, 404);
      }
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.get("/api/sessions/:sessionId/audit-markdown", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const sessionId = c.req.param("sessionId")?.trim();
    if (!sessionId) {
      return c.json({ error: "sessionId is required" }, 400);
    }

    try {
      const markdown = await buildSessionAuditMarkdown(sessionId);
      const filename = `starlingai-session-${sessionId.slice(0, 8)}-audit.md`;
      return c.body(markdown, 200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": buildContentDisposition(filename, "attachment"),
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("Session not found")) {
        return c.json({ error: error.message }, 404);
      }
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  // ── Site credentials API ─────────────────────────────────────────────────
  // GET  /api/sites          — list all sites (usernames only, no passwords)
  // POST /api/sites/:host    — create or update a site credential
  // DELETE /api/sites/:host  — remove a site credential

  app.get("/api/sites", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    return c.json(listSiteCredentials());
  });

  app.post("/api/sites/:hostname", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const hostname = c.req.param("hostname");
    if (hasConfigSiteCredential(hostname)) {
      return c.json({ error: "Sites declared in starlingai.json are read-only in the dashboard" }, 403);
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const username = String(body["username"] ?? "").trim();
    const existing = resolveSiteCredential(hostname);
    const password = String(body["password"] ?? "").trim() || (existing?.source === "store" ? existing.password : "");
    if (!username || !password) {
      return c.json({ error: "username and password are required" }, 400);
    }

    saveSiteCredential(hostname, {
      username,
      password,
      loginUrl: body["loginUrl"] ? String(body["loginUrl"]) : undefined,
      urls: body["urls"] && typeof body["urls"] === "object" && !Array.isArray(body["urls"])
        ? Object.fromEntries(Object.entries(body["urls"] as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
        : undefined,
      usernameSelector: body["usernameSelector"] ? String(body["usernameSelector"]) : undefined,
      passwordSelector: body["passwordSelector"] ? String(body["passwordSelector"]) : undefined,
      submitSelector: body["submitSelector"] ? String(body["submitSelector"]) : undefined,
      notes: body["notes"] ? String(body["notes"]) : undefined,
    });
    return c.json({ ok: true, hostname });
  });

  app.delete("/api/sites/:hostname", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    deleteSiteCredential(c.req.param("hostname"));
    return c.json({ ok: true });
  });

  // ── Guardrails API ────────────────────────────────────────────────────────
  // GET  /api/guardrails         — read current guardrail state
  // PUT  /api/guardrails         — update (partial patch)
  // POST /api/guardrails/reset   — reset to config defaults

  app.get("/api/guardrails", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    return c.json(getGuardrails());
  });

  app.put("/api/guardrails", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const patch: Parameters<typeof updateGuardrails>[0] = {};
    if (typeof body["promptInjectionBlock"] === "boolean") patch.promptInjectionBlock = body["promptInjectionBlock"];
    if (typeof body["outputSecretScan"] === "boolean") patch.outputSecretScan = body["outputSecretScan"];
    if (typeof body["maxInputLength"] === "number") patch.maxInputLength = body["maxInputLength"];
    const updated = updateGuardrails(patch);
    log.info({ patch }, "Guardrails updated");
    return c.json(updated);
  });

  app.post("/api/guardrails/reset", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const reset = resetGuardrails();
    log.info("Guardrails reset to config defaults");
    return c.json(reset);
  });

  // ── Sub-agents API ────────────────────────────────────────────────────────
  // GET   /api/agents            — list all configured sub-agents with their model config
  // PATCH /api/agents/:name/model — hot-patch a sub-agent's model config in memory

  app.get("/api/agents", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const cfg = getConfig();
    const agents = Object.entries(cfg.subAgents ?? {}).map(([name, agent]) => ({
      name,
      description: agent.description,
      capabilities: agent.capabilities,
      tags: agent.tags,
      model: agent.model ?? {},
      maxIterations: agent.maxIterations,
    }));
    return c.json(agents);
  });

  app.get("/api/agents/resolve", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const query = String(c.req.query("query") ?? "").trim();
    if (!query) return c.json({ error: "query is required" }, 400);

    const rawMinConfidence = String(c.req.query("minConfidence") ?? "medium");
    const minConfidence = rawMinConfidence === "high" || rawMinConfidence === "low"
      ? rawMinConfidence
      : "medium";

    return c.json(await resolveAgentRouting(query, { minConfidence }));
  });

  app.patch("/api/agents/:name/model", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const name = c.req.param("name");
    const cfg = getConfig();
    const agent = cfg.subAgents?.[name];
    if (!agent) return c.json({ error: `Agent '${name}' not found` }, 404);
    let body: Record<string, unknown>;
    try {
      body = await c.req.json() as Record<string, unknown>;
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const allowed = ["primary", "baseUrl", "apiKey", "temperature", "maxTokens", "topP", "topK", "minP", "repeatPenalty", "seed", "contextWindow", "enableThinking"];
    const patch: Record<string, unknown> = {};
    for (const key of allowed) {
      if (key in body) patch[key] = body[key];
    }
    agent.model = { ...(agent.model ?? {}), ...patch } as typeof agent.model;
    log.info({ agent: name, patch }, "Sub-agent model config patched");
    return c.json({ name, model: agent.model });
  });

  // GET /api/agents/outcomes — per-agent execution stats from agent_outcomes.ndjson
  app.get("/api/agents/outcomes", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const { readFileSync, existsSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const workspacePath = getConfig().workspacePath;
    const outcomesFile = resolve(workspacePath, ".starlingai/agent_outcomes.ndjson");

    if (!existsSync(outcomesFile)) return c.json({ agents: [], totalEntries: 0 });

    type OutcomeRow = { ts: string; agent: string; task: string; outcome: string; iterations: number; totalTokens: number; lesson?: string };
    let entries: OutcomeRow[] = [];
    try {
      entries = readFileSync(outcomesFile, "utf-8")
        .trim().split("\n").filter(Boolean)
        .map(line => { try { return JSON.parse(line) as OutcomeRow; } catch { return null; } })
        .filter((e): e is OutcomeRow => e !== null);
    } catch {
      return c.json({ agents: [], totalEntries: 0 });
    }

    const statsMap = new Map<string, { success: number; failure: number; partial: number; totalTokens: number; totalIterations: number; calls: number; latestLesson?: string; lastSeen: string }>();
    for (const e of entries) {
      const s = statsMap.get(e.agent) ?? { success: 0, failure: 0, partial: 0, totalTokens: 0, totalIterations: 0, calls: 0, lastSeen: "" };
      (s[e.outcome as "success" | "failure" | "partial"] as number)++;
      s.calls++;
      s.totalTokens += e.totalTokens ?? 0;
      s.totalIterations += e.iterations ?? 0;
      if (e.lesson) s.latestLesson = e.lesson;
      if (!s.lastSeen || e.ts > s.lastSeen) s.lastSeen = e.ts;
      statsMap.set(e.agent, s);
    }

    const agents = [...statsMap.entries()].map(([name, s]) => ({
      name,
      calls: s.calls,
      success: s.success,
      failure: s.failure,
      partial: s.partial,
      successRate: s.calls > 0 ? Math.round((s.success / s.calls) * 100) : 0,
      avgTokens: s.calls > 0 ? Math.round(s.totalTokens / s.calls) : 0,
      avgIterations: s.calls > 0 ? Math.round((s.totalIterations / s.calls) * 10) / 10 : 0,
      latestLesson: s.latestLesson,
      lastSeen: s.lastSeen,
    })).sort((a, b) => b.calls - a.calls);

    return c.json({ agents, totalEntries: entries.length });
  });

  app.get("/api/flow-memory", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const limitRaw = Number(c.req.query("limit") ?? "50");
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.trunc(limitRaw))) : 50;
    const entries = readFlowMemoryEntries(getConfig().workspacePath, limit).reverse();
    return c.json({ entries, totalEntries: entries.length });
  });

  app.post("/api/flow-memory", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = FlowMemoryCreateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid flow-memory entry", details: parsed.error.flatten() }, 400);
    }

    const entry = appendFlowMemoryEntry(getConfig().workspacePath, parsed.data);
    return c.json(entry, 201);
  });

  app.get("/api/config-assistant/proposals", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const limitRaw = Number(c.req.query("limit") ?? "50");
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, Math.trunc(limitRaw))) : 50;
    const proposals = listConversationConfigProposals(getConfig().workspacePath, limit);
    return c.json({ proposals, totalEntries: proposals.length });
  });

  app.get("/api/personality", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    return c.json(loadMainAssistantPersonality());
  });

  app.put("/api/personality", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    try {
      const body = await c.req.json<Record<string, unknown>>();
      const parsed = MainAssistantPersonalityRequestSchema.parse(body);
      const profile = saveMainAssistantPersonality(parsed, {
        updatedBy: "user",
        reason: parsed.reason,
        revisionBase: loadMainAssistantPersonality().revision,
      });
      return c.json(profile);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.post("/api/personality/reset", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    return c.json(resetMainAssistantPersonality("user", "Reset from dashboard"));
  });

  app.post("/api/config-assistant/proposals", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = ConfigAssistantRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid config-assistant request", details: parsed.error.flatten() }, 400);
    }

    const cfg = getConfig();
    if (!hasPromptTarget(cfg, parsed.data.targetAgent)) {
      return c.json({ error: `Agent '${parsed.data.targetAgent}' not found` }, 404);
    }

    try {
      const result = await proposeConversationConfigChange({
        request: parsed.data.request,
        mode: parsed.data.mode,
        targetAgent: parsed.data.targetAgent,
        workspacePath: cfg.workspacePath,
      });

      const proposal = createConversationConfigProposal(cfg.workspacePath, {
        status: "pending",
        mode: parsed.data.mode,
        request: parsed.data.request,
        summary: result.draft.summary,
        assistantAgent: result.assistantAgent,
        targetAgent: parsed.data.targetAgent,
        configChanges: result.draft.configChanges,
        promptChanges: result.draft.promptChanges,
        validations: result.draft.validations,
        tags: result.draft.tags,
        lesson: result.draft.lesson,
      });

      const flowEntry = appendFlowMemoryEntry(cfg.workspacePath, {
        scope: parsed.data.mode,
        request: parsed.data.request,
        summary: proposal.summary,
        assistantAgent: proposal.assistantAgent,
        targetAgent: proposal.targetAgent,
        actions: [
          ...proposal.configChanges.map((change) => `set ${change.path}`),
          ...proposal.promptChanges.map((change) => `${change.strategy} prompt ${change.agentName}`),
        ],
        outcome: "proposed",
        lesson: proposal.lesson,
        tags: proposal.tags,
      });

      // Structured attribution audit trail — creation event (GAP-3)
      logAudit("config_proposal_created", {
        proposalId: proposal.id,
        proposingAgent: proposal.assistantAgent ?? null,
        targetAgent: proposal.targetAgent ?? null,
        mode: proposal.mode,
        summary: proposal.summary,
      }, { severity: "info", channel: "config-assistant" });

      return c.json({ proposal, flowMemoryId: flowEntry.id }, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.post("/api/config-assistant/proposals/:id/apply", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const id = c.req.param("id");
    const cfg = getConfig();
    const proposal = getConversationConfigProposal(cfg.workspacePath, id);
    if (!proposal) return c.json({ error: "Proposal not found" }, 404);
    if (proposal.status !== "pending") {
      return c.json({ error: `Proposal is already ${proposal.status}` }, 409);
    }

    const protectedChange = proposal.configChanges.find((change) => /secret|password|token|apikey|api_key|privatekey|private_key|credential|credentials/i.test(change.path));
    if (protectedChange) {
      return c.json({ error: `Protected config path cannot be applied automatically: ${protectedChange.path}` }, 400);
    }

    const missingAgent = proposal.promptChanges.find((change) => !hasPromptTarget(cfg, change.agentName));
    if (missingAgent) {
      return c.json({ error: `Prompt target agent '${missingAgent.agentName}' not found` }, 404);
    }

    try {
      updateConfig((raw) => {
        for (const change of proposal.configChanges) {
          applyObjectPath(raw, change.path, change.value);
        }

        if (proposal.promptChanges.length > 0) {
          for (const change of proposal.promptChanges) {
            applyPromptChange(raw, change);
          }
        }
      });

      const updated = updateConversationConfigProposal(cfg.workspacePath, id, (current) => ({
        ...current,
        status: "applied",
        appliedAt: new Date().toISOString(),
      }));

      // Structured attribution audit trail for self-improvement traceability (GAP-3)
      logAudit("self_improvement_applied", {
        proposalId: id,
        proposingAgent: proposal.assistantAgent ?? null,
        targetAgent: proposal.targetAgent ?? null,
        mode: proposal.mode,
        configChanges: proposal.configChanges.map((change) => ({ path: change.path, newValue: change.value })),
        promptChanges: proposal.promptChanges.map((change) => ({
          agentName: change.agentName === MAIN_ASSISTANT_PROMPT_TARGET ? "main_assistant" : change.agentName,
          strategy: change.strategy,
        })),
        summary: proposal.summary,
      }, { severity: "info", channel: "config-assistant" });

      logAudit("config_proposal_applied", {
        proposalId: id,
        proposingAgent: proposal.assistantAgent ?? null,
        targetAgent: proposal.targetAgent ?? null,
      }, { severity: "info", channel: "config-assistant" });

      appendFlowMemoryEntry(cfg.workspacePath, {
        scope: proposal.mode,
        request: proposal.request,
        summary: proposal.summary,
        assistantAgent: proposal.assistantAgent,
        targetAgent: proposal.targetAgent,
        actions: [
          ...proposal.configChanges.map((change) => `set ${change.path}`),
          ...proposal.promptChanges.map((change) => `${change.strategy} prompt ${change.agentName === MAIN_ASSISTANT_PROMPT_TARGET ? "main assistant" : change.agentName}`),
        ],
        outcome: "applied",
        lesson: proposal.lesson,
        tags: proposal.tags,
      });

      return c.json({ proposal: updated ?? proposal });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.post("/api/config-assistant/proposals/:id/feedback", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const id = c.req.param("id");
    const cfg = getConfig();
    const proposal = getConversationConfigProposal(cfg.workspacePath, id);
    if (!proposal) return c.json({ error: "Proposal not found" }, 404);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = ConfigAssistantFeedbackSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid feedback payload", details: parsed.error.flatten() }, 400);
    }

    const withFeedback = appendConversationConfigProposalFeedback(cfg.workspacePath, id, {
      outcome: parsed.data.outcome,
      lesson: parsed.data.lesson,
      notes: parsed.data.notes,
    });
    const updated = parsed.data.outcome === "rejected"
      ? updateConversationConfigProposal(cfg.workspacePath, id, (current) => ({
          ...current,
          status: "rejected",
        }))
      : withFeedback;

    appendFlowMemoryEntry(cfg.workspacePath, {
      scope: proposal.mode,
      request: proposal.request,
      summary: proposal.summary,
      assistantAgent: proposal.assistantAgent,
      targetAgent: proposal.targetAgent,
      actions: [
        ...proposal.configChanges.map((change) => `set ${change.path}`),
        ...proposal.promptChanges.map((change) => `${change.strategy} prompt ${change.agentName}`),
      ],
      outcome: parsed.data.outcome,
      lesson: parsed.data.lesson ?? proposal.lesson,
      tags: proposal.tags,
    });

    return c.json({ proposal: updated ?? proposal });
  });

  // ── AG-UI streaming chat (SSE) ────────────────────────────────────────────
  // POST /api/chat/stream  →  Server-Sent Events following the AG-UI protocol
  // Frontend can use @ag-ui/client HttpAgent or plain EventSource / fetch + ReadableStream.

  // ── A2A sub-agent endpoints ───────────────────────────────────────────────
  // POST /a2a/agents/:name  →  JSON-RPC 2.0 task delegation to a named sub-agent
  // Exposes each configured subAgent as an A2A-compatible HTTP endpoint.

  // ── HTTP server handles AG-UI + A2A directly (bypasses Hono for streaming) ─
  // Both endpoints are wired in the httpServer.on("request") handler below.

  // ── Scenes API ────────────────────────────────────────────────────────────
  // GET    /api/scenes           — list all scenes (config + store, auth required)
  // POST   /api/scenes/:name     — create or update a scene in the store
  // DELETE /api/scenes/:name     — delete a scene from the store (config scenes are read-only)
  // POST   /api/scenes/:name/run — trigger a scene; auth via Bearer token OR
  //                                ?key=<webhookKey> / X-Scene-Key header

  app.get("/api/scenes", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    return c.json(listAllScenes());
  });

  app.post("/api/scenes/:name", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const name = c.req.param("name");
    const existing = getScene(name);
    if (existing?.source === "config") {
      return c.json({ error: "Scenes declared in starlingai.json are read-only in the dashboard" }, 403);
    }

    let body: Record<string, unknown>;
    try { body = await c.req.json<Record<string, unknown>>(); } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const description = String(body["description"] ?? "").trim();
    const task = String(body["task"] ?? "").trim();
    if (!description || !task) return c.json({ error: "description and task are required" }, 400);
    if (task.length > 32_768) return c.json({ error: "task exceeds maximum length of 32 768 characters" }, 400);

    try {
      saveScene(name, {
        description,
        task,
        webhookKey: body["webhookKey"] ? String(body["webhookKey"]) : undefined,
      });
      return c.json({ ok: true, name });
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  app.delete("/api/scenes/:name", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const name = c.req.param("name");
    const existing = getScene(name);
    if (!existing) return c.json({ error: `Scene not found: ${name}` }, 404);
    if (existing.source === "config") return c.json({ error: "Config-file scenes cannot be deleted via the API — edit starlingai.json instead" }, 403);
    deleteScene(name);
    return c.json({ ok: true });
  });

  app.post("/api/scenes/:name/run", async (c) => {
    const sceneName = c.req.param("name");
    const scene = getScene(sceneName);
    if (!scene) return c.json({ error: `Scene not found: ${sceneName}` }, 404);

    // Auth: Bearer token OR scene webhook key
    const bearerToken = extractBearerToken(c.req.header("Authorization"));
    const keyParam = c.req.query("key") ?? c.req.header("X-Scene-Key") ?? "";
    const resolvedKey = resolveWebhookSecret(scene.webhookKey);

    const authed = (bearerToken && await verifyToken(bearerToken)) ||
      (resolvedKey.length >= 16 && keyParam.length === resolvedKey.length &&
        timingSafeEqual(Buffer.from(keyParam), Buffer.from(resolvedKey)));

    if (!authed) return c.json({ error: "Unauthorized" }, 401);

    // Read optional params from request body to apply template substitution
    let bodyParams: Record<string, string> = {};
    try {
      const body = await c.req.json<Record<string, unknown>>();
      if (body && typeof body["params"] === "object" && body["params"] !== null) {
        bodyParams = Object.fromEntries(
          Object.entries(body["params"] as Record<string, unknown>).map(([k, v]) => [k, String(v)])
        );
      }
    } catch { /* body is optional */ }

    // Merge scene defaults with request params
    const mergedParams: Record<string, string> = {};
    for (const [key, def] of Object.entries(scene.params ?? {})) {
      if (def.default !== undefined) mergedParams[key] = def.default;
    }
    Object.assign(mergedParams, bodyParams);

    const task = mergedParams && Object.keys(mergedParams).length > 0
      ? applyTemplate(scene.task, mergedParams)
      : scene.task;

    const job = await createJob({
      sceneName,
      definitionType: "scene",
      userId: `scene:${sceneName}`,
      task,
      allowedAgents: scene.allowedAgents,
      humanInLoopSteps: scene.humanInLoopSteps,
      approvalChannel: scene.approvalChannel,
      params: mergedParams,
      turnTimeoutMs,
    });
    log.info({ sceneName, sessionId: job.sessionId, jobId: job.id }, "Scene job queued");

    return c.json({ ok: true, sceneName, jobId: job.id, sessionId: job.sessionId, status: job.status });
  });

  app.get("/api/jobs", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    return c.json(listJobDefinitions());
  });

  app.post("/api/jobs/:name", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const name = c.req.param("name");
    const existing = getJobDefinition(name);
    if (existing?.source === "config") {
      return c.json({ error: "Jobs declared in starlingai.json are read-only in the dashboard" }, 403);
    }

    let body: Record<string, unknown>;
    try { body = await c.req.json<Record<string, unknown>>(); } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    try {
      const input = JobConfigSchema.parse(body);
      saveJobDefinition(name, input);
      syncConfiguredJobTriggers(turnTimeoutMs);
      return c.json({ ok: true, name });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.delete("/api/jobs/:name", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const name = c.req.param("name");
    const existing = getJobDefinition(name);
    if (!existing) return c.json({ error: `Job not found: ${name}` }, 404);
    if (existing.source === "config") return c.json({ error: "Config-file jobs cannot be deleted via the API — edit starlingai.json instead" }, 403);
    deleteJobDefinition(name);
    syncConfiguredJobTriggers(turnTimeoutMs);
    return c.json({ ok: true });
  });

  app.post("/api/jobs/:name/run", async (c) => {
    const jobName = c.req.param("name");
    const definition = getJobDefinition(jobName);
    if (!definition) return c.json({ error: `Job not found: ${jobName}` }, 404);

    const bearerToken = extractBearerToken(c.req.header("Authorization"));
    const keyParam = c.req.query("key") ?? c.req.header("X-Job-Key") ?? "";
    const resolvedWebhookKeys = getApiWebhookKeys(definition).map((key) => resolveWebhookSecret(key));
    const webhookAuthorized = resolvedWebhookKeys.some((resolvedKey) =>
      resolvedKey.length >= 16 && keyParam.length === resolvedKey.length && timingSafeEqual(Buffer.from(keyParam), Buffer.from(resolvedKey))
    );
    const authed = (bearerToken && await verifyToken(bearerToken)) || webhookAuthorized;
    if (!authed) return c.json({ error: "Unauthorized" }, 401);

    let bodyParams: Record<string, string> = {};
    try {
      const body = await c.req.json<Record<string, unknown>>();
      if (body && typeof body["params"] === "object" && body["params"] !== null) {
        bodyParams = Object.fromEntries(
          Object.entries(body["params"] as Record<string, unknown>).map(([key, value]) => [key, String(value)])
        );
      }
    } catch { /* body is optional */ }

    let steps;
    try {
      steps = resolveJobSteps(definition, bodyParams);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }

    const queued = await createJob({
      sceneName: jobName,
      definitionType: "job",
      userId: `job:${jobName}`,
      steps,
      turnTimeoutMs,
    });
    log.info({ jobName, sessionId: queued.sessionId, jobId: queued.id }, "Job workflow queued");

    return c.json({ ok: true, sceneName: jobName, definitionType: "job", jobId: queued.id, sessionId: queued.sessionId, status: queued.status });
  });

  // ── Approval callback endpoints ──────────────────────────────────────────
  // GET  /api/approval/:id?approved=true|false&secret=X
  //        — one-click link handler (Slack / WhatsApp / email).  Returns HTML.
  // POST /api/approval/:id
  //        — programmatic callback (n8n / outbound_webhook receivers).
  //          Body: { approved: boolean, secret: string }
  //          OR   Authorization: Bearer <secret>  +  body: { approved: boolean }

  app.get("/api/approval/:approvalId", async (c) => {
    const id = c.req.param("approvalId");
    const approved = c.req.query("approved") === "true";
    const secret = c.req.query("secret") ?? "";

    const pending = getPendingApproval(id);
    if (!pending) {
      return c.html("<html><body><h2>Approval request not found or already resolved.</h2></body></html>", 404);
    }

    // Verify secret if one was set (slack/outbound_webhook channels always set one)
    if (pending.secret && pending.secret !== secret) {
      return c.html("<html><body><h2>Invalid approval secret.</h2></body></html>", 403);
    }

    resolveApproval(id, approved);
    const action = approved ? "✅ Approved" : "❌ Denied";
    const safeName = pending.toolName.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    return c.html(`<html><body style="font-family:sans-serif;padding:2rem"><h2>${action}</h2><p>Tool: <strong>${safeName}</strong></p><p>You can close this tab.</p></body></html>`);
  });

  app.post("/api/approval/:approvalId", async (c) => {
    const id = c.req.param("approvalId");
    let body: Record<string, unknown>;
    try { body = await c.req.json<Record<string, unknown>>(); } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const approved = Boolean(body["approved"]);
    const bodySecret = body["secret"] ? String(body["secret"]) : "";
    const headerSecret = extractBearerToken(c.req.header("Authorization")) ?? "";
    const secret = bodySecret || headerSecret;

    const pending = getPendingApproval(id);
    if (!pending) return c.json({ error: "Approval request not found or already resolved" }, 404);

    if (pending.secret && pending.secret !== secret) {
      return c.json({ error: "Invalid approval secret" }, 403);
    }

    resolveApproval(id, approved);
    return c.json({ ok: true, approved });
  });

  // GET /api/scenes/jobs — list recent async scene execution jobs
  app.get("/api/scenes/jobs", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const limitParam = c.req.query("limit");
    const statusParam = c.req.query("status");
    const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
    const allowedStatuses = new Set(["queued", "running", "cancelling", "cancelled", "completed", "failed"]);
    const status = statusParam && allowedStatuses.has(statusParam) ? statusParam as "queued" | "running" | "cancelling" | "cancelled" | "completed" | "failed" : undefined;

    return c.json({
      jobs: await listJobs({ limit, status }),
    });
  });

  // GET /api/scenes/jobs/:jobId — poll async scene execution status
  app.get("/api/scenes/jobs/:jobId", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const jobId = c.req.param("jobId");
    const job = await getExecutionJob(jobId);
    if (!job) return c.json({ error: `Job not found: ${jobId}` }, 404);
    return c.json(job);
  });

  app.post("/api/scenes/jobs/:jobId/cancel", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const jobId = c.req.param("jobId");
    const job = await cancelJob(jobId);
    if (!job) return c.json({ error: `Job not found: ${jobId}` }, 404);
    return c.json({ ok: true, job });
  });

  // ── Channel webhook endpoints (no auth — use their own verification) ────────
  // Slack Events API
  app.post("/channels/slack/events", (c) => handleSlackEvent(c));

  // WhatsApp Meta Cloud API
  app.get("/channels/whatsapp/webhook", (c) => handleWhatsappVerify(c));
  app.post("/channels/whatsapp/webhook", (c) => handleWhatsappEvent(c));

  // ── Channel management API ────────────────────────────────────────────────
  // GET  /api/channels                — list all channels with status
  // GET  /api/channels/dead-letters   — dead-letter queue entry count
  // GET  /api/channels/:type          — get config for a channel type (tokens redacted)
  // PUT  /api/channels/:type          — save/update a channel config
  // DELETE /api/channels/:type        — remove a stored channel config

  app.get("/api/channels/dead-letters", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    try {
      return c.json({
        count: getDeadLetterCount(),
        entries: readDeadLetters({ limit: 50 }),
      });
    } catch {
      return c.json({ count: 0, entries: [] });
    }
  });

  // ── Swarm status (concurrency + bus health) ──────────────────────────────
  app.get("/api/swarm/status", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const concurrency = getConcurrencySnapshot();
    const busConnected = isSwarmBusConnected();
    const capabilities = getAgentCapabilitySnapshot();
    const directMessages = getAgentMessageBacklogSnapshot();
    const bottlenecks = concurrency
      .filter(s => s.oldestQueuedMs > 0 || s.utilization >= 0.9)
      .sort((left, right) => right.oldestQueuedMs - left.oldestQueuedMs || right.utilization - left.utilization);

    return c.json({
      bus: { connected: busConnected, mode: busConnected ? "redis" : "in-process" },
      bidderWorker: getBidderWorkerStatus(),
      capabilities,
      directMessages,
      concurrency,
      bottlenecks,
      summary: {
        activeAgents: concurrency.filter(s => s.active > 0).length,
        announcedAgents: capabilities.length,
        busyAgents: capabilities.filter((entry) => entry.availability === "busy" && !entry.stale).length,
        staleAnnouncements: capabilities.filter((entry) => entry.stale).length,
        pendingDirectMessages: directMessages.reduce((sum, entry) => sum + entry.pending, 0),
        queuedTasks: concurrency.reduce((sum, s) => sum + s.queued, 0),
        bottleneckCount: bottlenecks.length,
        peakQueuedWaitMs: concurrency.reduce((max, s) => Math.max(max, s.oldestQueuedMs), 0),
      },
    });
  });

  // ── Swarm health dashboard — aggregated operator view ────────────────────
  app.get("/api/swarm/health", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    return c.json({
      wardenAlerts: getWardenAlerts(),
      capabilityGaps: listCapabilityGaps(),
      promotionCandidates: listPromotionCandidates(),
      dynamicToolStats: getDynamicToolStats(),
    });
  });

  // ── Dynamic tool promotion queue ─────────────────────────────────────────
  app.get("/api/tools/dynamic", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    return c.json({ tools: getLoadedDynamicTools(), stats: getDynamicToolStats() });
  });

  app.get("/api/tools/dynamic/promotion", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    return c.json({ candidates: listPromotionCandidates() });
  });

  app.post("/api/tools/dynamic/:name/promote", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const name = c.req.param("name");
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const reviewedBy = typeof body["reviewedBy"] === "string" ? body["reviewedBy"] : "operator";

    const ok = approvePromotion(name, reviewedBy);
    if (!ok) return c.json({ error: "Tool not found or not in pending promotion state" }, 404);

    logAudit("tool_promoted", { toolName: name, reviewedBy }, { severity: "info", channel: "self-improvement" });
    return c.json({ success: true, toolName: name, reviewedBy });
  });

  app.post("/api/tools/dynamic/:name/reject-promotion", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const name = c.req.param("name");
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const reviewedBy = typeof body["reviewedBy"] === "string" ? body["reviewedBy"] : "operator";

    const ok = rejectPromotion(name, reviewedBy);
    if (!ok) return c.json({ error: "Tool not found or not in pending promotion state" }, 404);

    logAudit("tool_promotion_rejected", { toolName: name, reviewedBy }, { severity: "info", channel: "self-improvement" });
    return c.json({ success: true, toolName: name, reviewedBy });
  });

  // ── Capability gaps ───────────────────────────────────────────────────────
  app.get("/api/capability-gaps", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const status = c.req.query("status");
    let gaps = listCapabilityGaps();
    if (status) gaps = gaps.filter(g => g.status === status);
    return c.json({ gaps });
  });

  // ── Long-running task checkpoints ─────────────────────────────────────────
  app.get("/api/checkpoints", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const statusParam = c.req.query("status");
    const agentName = c.req.query("agentName");
    const validStatuses = ["active", "paused", "resumed", "completed", "failed"] as const;
    type CS = typeof validStatuses[number];
    const status = validStatuses.includes(statusParam as CS) ? (statusParam as CS) : undefined;
    return c.json({ checkpoints: listCheckpoints({ status, agentName }) });
  });

  app.post("/api/checkpoints/:taskId/resume", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const taskId = c.req.param("taskId");
    const cp = resumeCheckpoint(taskId);
    if (!cp) return c.json({ error: "Checkpoint not found or not in paused state" }, 404);
    return c.json({ checkpoint: cp });
  });

  app.post("/api/checkpoints/:taskId/complete", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const taskId = c.req.param("taskId");
    const ok = completeCheckpoint(taskId);
    if (!ok) return c.json({ error: "Checkpoint not found" }, 404);
    return c.json({ success: true, taskId });
  });

  app.get("/api/channels", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const currentConfig = getConfig();
    const registeredStatuses = new Map(getChannelStatuses().map((status) => [status.type, status]));
    const statuses = CHANNEL_TYPES.map((type) => {
      const status = registeredStatuses.get(type);
      const channelStatus = {
        type,
        enabled: status?.enabled ?? Boolean(getEffectiveChannelConfig(type, currentConfig.channels[type]).enabled),
        running: status?.running ?? false,
        error: status?.error,
        health: status?.health,
        metrics: status?.metrics,
        ...getChannelRuntimeSupport(type),
      };
      return {
        ...channelStatus,
        operatorState: buildChannelOperatorState(channelStatus, []),
      };
    });
    return c.json(statuses);
  });

  app.get("/api/channels/:type", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const type = c.req.param("type") as Parameters<typeof getStoredChannelConfig>[0];
    if (!CHANNEL_TYPES.includes(type)) {
      return c.json({ error: `Unknown channel type: ${type}` }, 400);
    }

    const currentConfig = getConfig();
    const effective = getEffectiveChannelConfig(type, currentConfig.channels[type]);
    const status = getChannelStatuses().find((entry) => entry.type === type) ?? {
      type,
      enabled: Boolean(effective.enabled),
      running: false,
    };
    const runtimeSupport = getChannelRuntimeSupport(type);
    const recentDeadLetters = readDeadLetters({ channel: type, limit: 5 });
    return c.json({
      type,
      source: getChannelConfigSource(type),
      config: redactChannelSecrets(effective),
      status: {
        ...status,
        ...runtimeSupport,
        operatorState: buildChannelOperatorState({ ...status, ...runtimeSupport }, recentDeadLetters),
      },
      operator: {
        recentDeadLetters,
        recoveryProcedures: getChannelRecoveryProcedures(type),
      },
    });
  });

  app.put("/api/channels/:type", async (c) => {
    const authToken = extractBearerToken(c.req.header("Authorization"));
    if (!authToken || !await verifyToken(authToken)) return c.json({ error: "Unauthorized" }, 401);

    const type = c.req.param("type");
    if (!CHANNEL_TYPES.includes(type as Parameters<typeof saveChannelConfig>[0])) {
      return c.json({ error: `Unknown channel type: ${type}` }, 400);
    }

    let body: StoredChannelConfig;
    try { body = await c.req.json<StoredChannelConfig>(); } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    // If a field is "••••••••" (redacted placeholder), preserve existing value
    const currentConfig = getConfig();
    const existing = getEffectiveChannelConfig(type as Parameters<typeof saveChannelConfig>[0], currentConfig.channels[type as keyof typeof currentConfig.channels]);
    const secretFields = ["botToken", "appToken", "signingSecret", "token", "appSecret", "accessToken", "imapPassword", "smtpPassword"] as const;
    for (const f of secretFields) {
      if ((body as Record<string, unknown>)[f] === "••••••••") {
        (body as Record<string, unknown>)[f] = existing[f];
      }
    }

    saveChannelConfig(type as Parameters<typeof saveChannelConfig>[0], body);
    await reloadChannel(type as Parameters<typeof saveChannelConfig>[0]);
    return c.json({ ok: true, type });
  });

  app.delete("/api/channels/:type", async (c) => {
    const authToken = extractBearerToken(c.req.header("Authorization"));
    if (!authToken || !await verifyToken(authToken)) return c.json({ error: "Unauthorized" }, 401);

    const type = c.req.param("type");
    if (!CHANNEL_TYPES.includes(type as Parameters<typeof deleteChannelConfig>[0])) {
      return c.json({ error: `Unknown channel type: ${type}` }, 400);
    }
    deleteChannelConfig(type as Parameters<typeof deleteChannelConfig>[0]);
    await reloadChannel(type as Parameters<typeof deleteChannelConfig>[0]);
    return c.json({ ok: true });
  });

  // ── Computer-use session routes ────────────────────────────────────────────

  app.get("/api/computer-sessions", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    return c.json(computerSessionManager.listSessions());
  });

  app.get("/api/computer-sessions/active", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    return c.json(computerSessionManager.listActiveSessions());
  });

  app.get("/api/computer-sessions/:id", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const id = c.req.param("id");
    const sessions = computerSessionManager.listSessions();
    const session = sessions.find(s => s.id === id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    return c.json(session);
  });

  app.post("/api/computer-sessions/:id/emergency-stop", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const id = c.req.param("id");
    const body = await c.req.json<{ reason?: string }>().catch((): { reason?: string } => ({}));
    const reason = body.reason ?? "api:manual_stop";
    computerSessionManager.emergencyStop(id, reason);
    return c.json({ ok: true });
  });

  app.post("/api/computer-sessions/:id/heartbeat", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const id = c.req.param("id");
    computerSessionManager.heartbeat(id);
    return c.json({ ok: true });
  });

  app.get("/api/computer-sessions/config", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const cfg = getConfig();
    const computerUse = (cfg as Record<string, unknown>)["computerUse"] ?? {};
    return c.json(computerUse);
  });

  // ── REST chat endpoint (for simple integrations) ─────────────────────────
  app.post("/api/chat", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const { message, sessionId } = await c.req.json<{ message: string; sessionId?: string }>();
    // Full implementation delegates to WS channel; REST returns 501 for streaming turns
    return c.json({ error: "Use WebSocket for chat. REST chat coming in v0.2." }, 501);
  });

  // ── HTTP server with WS upgrade ──────────────────────────────────────────
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const requestUrl = new URL(req.url ?? "/", "http://localhost");
    const pathname = requestUrl.pathname;

    // ── AG-UI streaming endpoint ─────────────────────────────────────────────
    if (req.method === "POST" && pathname === "/api/chat/stream") {
      const token = req.headers["authorization"]
        ? extractBearerToken(req.headers["authorization"] as string)
        : requestUrl.searchParams.get("token");

      if (!token || !await verifyToken(token)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      let rawBody = "";
      req.on("data", (chunk: Buffer) => { rawBody += chunk.toString(); });
      req.on("end", async () => {
        try {
          const body = JSON.parse(rawBody) as { sessionId?: string; message: string };
          await handleAguiStream(res, body);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON body" }));
        }
      });
      return;
    }

    // ── A2A agent endpoint ────────────────────────────────────────────────────
    // POST /a2a/agents/:name  — JSON-RPC 2.0 task delegation
    const a2aMatch = pathname.match(/^\/a2a\/agents\/([^/?]+)$/);
    if (req.method === "POST" && a2aMatch) {
      const token = req.headers["authorization"]
        ? extractBearerToken(req.headers["authorization"] as string)
        : null;

      if (!token || !await verifyToken(token)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null }));
        return;
      }

      const agentName = decodeURIComponent(a2aMatch[1]!);
      let rawBody = "";
      req.on("data", (chunk: Buffer) => { rawBody += chunk.toString(); });
      req.on("end", async () => {
        let rpcId: unknown = null;
        try {
          const rpc = JSON.parse(rawBody) as { jsonrpc: string; method: string; params: Record<string, unknown>; id: unknown };
          rpcId = rpc.id;

          if (rpc.method !== "tasks/send") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32601, message: "Method not found — use tasks/send" }, id: rpcId }));
            return;
          }

          const task  = String(rpc.params?.["task"] ?? "");
          const ctx   = rpc.params?.["context"] ? String(rpc.params["context"]) : undefined;
          const sessId = rpc.params?.["sessionId"] ? String(rpc.params["sessionId"]) : `a2a:${Date.now()}`;
          const autoApprove = rpc.params?.["autoApprove"] === true;

          const result = await runSubAgent({
            agentName,
            task,
            context: ctx,
            parentSessionId: sessId,
            workspacePath: getConfig().workspacePath,
            approvalCallback: autoApprove
              ? async () => true
              : undefined,
          });

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", result: { output: result, agentName }, id: rpcId }));
        } catch (err) {
          log.error({ err, agentName }, "A2A task failed");
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: String(err) }, id: rpcId }));
        }
      });
      return;
    }

    // ── Delegate all other requests to Hono ───────────────────────────────────
    const method = req.method ?? "GET";
    const honoReq = new Request(requestUrl, {
      method,
      headers: req.headers as Record<string, string>,
      body: method === "GET" || method === "HEAD" ? undefined : Readable.toWeb(req),
      duplex: method === "GET" || method === "HEAD" ? undefined : "half",
    } as RequestInit & { duplex?: "half" });
    void Promise.resolve(app.fetch(honoReq)).then((honoRes: Response) => {
      const responseHeaders: Record<string, string> = {};
      honoRes.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      res.writeHead(honoRes.status, responseHeaders);
      return honoRes.arrayBuffer().then((body) => res.end(Buffer.from(body)));
    }).catch(() => {
      res.writeHead(500);
      res.end("Internal Server Error");
    });
  });

  function buildChannelOperatorState(
    status: {
      type: string;
      enabled: boolean;
      running: boolean;
      supported?: boolean;
      reason?: string | null;
      error?: string;
      health?: { healthy: boolean; error?: string };
      metrics?: {
        ingressDenied?: number;
        lastDeliveryError?: string;
        deliveryWindows?: { last5m?: { failed: number } };
      };
    },
    recentDeadLetters: DeadLetterEntry[],
  ): { severity: "ok" | "warning" | "critical"; summary: string } {
    if (status.supported === false) {
      return { severity: "warning", summary: status.reason ?? "Runtime not implemented" };
    }
    if (status.error) {
      return { severity: "critical", summary: status.error };
    }
    if (status.health && !status.health.healthy) {
      return { severity: "critical", summary: status.health.error ?? "Health check failing" };
    }
    const recentFailures = status.metrics?.deliveryWindows?.last5m?.failed ?? 0;
    if (recentFailures > 0 || recentDeadLetters.length > 0 || status.metrics?.lastDeliveryError) {
      return {
        severity: "warning",
        summary: recentFailures > 0
          ? recentFailures + " delivery failure" + (recentFailures === 1 ? "" : "s") + " in the last 5 minutes"
          : "Recent delivery failures require attention",
      };
    }
    if ((status.metrics?.ingressDenied ?? 0) > 0) {
      return { severity: "warning", summary: "Ingress requests were blocked by policy or rate limiting" };
    }
    if (status.enabled && !status.running) {
      return { severity: "warning", summary: "Channel is enabled but not running" };
    }
    if (!status.enabled) {
      return { severity: "ok", summary: "Channel is disabled" };
    }
    return { severity: "ok", summary: "Channel is operating normally" };
  }

  function getChannelRecoveryProcedures(type: string): string[] {
    switch (type) {
      case "telegram":
        return [
          "Verify botToken is configured and valid by calling Telegram getMe or reopening the dashboard channel status.",
          "Confirm allowedUserIds is empty or includes the sender if the bot appears reachable but ignores messages.",
          "Restart the gateway after token changes so the Grammy bot reconnects cleanly.",
        ];
      case "slack":
        return [
          "Verify botToken and signingSecret are set and that Slack auth.test succeeds.",
          "If using Events API, confirm the public callback URL is reachable and still matches Slack app settings.",
          "If using Socket Mode, confirm appToken is present and reinstall the app after scope changes.",
        ];
      case "discord":
        return [
          "Verify the bot token and confirm Message Content Intent remains enabled in the Discord developer portal.",
          "Check guildIds restrictions and bot channel permissions if messages arrive in some servers but not others.",
          "Restart the gateway to force a fresh Discord gateway session after token or intent changes.",
        ];
      case "whatsapp":
        return [
          "Confirm accessToken, phoneNumberId, verifyToken, and appSecret all match the Meta app and webhook configuration.",
          "Verify the public webhook URL is reachable and that inbound requests pass X-Hub-Signature-256 validation.",
          "Rotate the access token or re-register the webhook if Meta starts returning authorization or signature errors.",
        ];
      case "email":
        return [
          "Verify IMAP and SMTP credentials separately, especially app passwords for Gmail or Microsoft 365 accounts.",
          "Check pollIntervalMs and mailbox connectivity if inbound mail is delayed but outbound SMTP works.",
          "Restart the gateway after credential changes so the poller reconnects with the new settings.",
        ];
      case "signal":
        return [
          "Verify signal-cli is installed on the gateway host and that channels.signal.signalCliPath points to the correct binary.",
          "Confirm channels.signal.account is already linked or registered in signal-cli and appears in signal-cli listAccounts output.",
          "If Signal stops receiving messages, rerun signal-cli receive manually to confirm the local account session is still healthy.",
        ];
      default:
        return ["Review the channel config, runtime status, and recent dead-letter entries before retrying delivery."];
    }
  }

  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", async (ws, req) => {
    const ip = req.socket.remoteAddress ?? "unknown";

    // Auth check
    const url = new URL(req.url ?? "/", "http://localhost");
    const token = url.searchParams.get("token") ??
                  extractBearerToken(req.headers["authorization"]);

    const rlCheck = checkAuthRateLimit(ip);
    if (!rlCheck.allowed) {
      ws.close(4429, "Too many auth failures");
      return;
    }

    if (!token || !await verifyToken(token)) {
      recordAuthFailure(ip);
      ws.close(4401, "Unauthorized — provide token as ?token= or Authorization header");
      return;
    }

    clearAuthFailures(ip);

    const conn = new RpcConnection(ws);

    ws.on("message", async (raw) => {
      await conn.handleMessage(raw.toString());
    });

    ws.on("close", () => conn.close());
    ws.on("error", (err) => log.error({ err, connId: conn.connId }, "WS error"));
  });

  return {
    start(): Promise<void> {
      const port = config.gateway.port;
      return new Promise((resolve, reject) => {
        const handleError = (error: Error) => {
          httpServer.off("error", handleError);
          reject(error);
        };

        httpServer.once("error", handleError);
        httpServer.listen(port, "0.0.0.0", () => {
          httpServer.off("error", handleError);
          log.info({ port }, `Gateway listening — ws://0.0.0.0:${port}/ws`);
          resolve();
        });
      });
    },
    stop(): Promise<void> {
      return new Promise((resolve) => {
        for (const client of wss.clients) {
          client.terminate();
        }

        wss.close();
        httpServer.close(() => resolve());
        httpServer.closeAllConnections?.();
      });
    },
  };
}
