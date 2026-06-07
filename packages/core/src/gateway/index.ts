import { Hono } from "hono";
import { cors } from "hono/cors";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { timingSafeEqual } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, basename, extname, sep } from "node:path";
import JSON5 from "json5";
import { z } from "zod";
import { WebSocketServer, WebSocket } from "ws";
import { ZipFile } from "yazl";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getConfig, updateConfig } from "../config/loader.js";
import { verifyToken, extractBearerToken, checkAuthRateLimit, recordAuthFailure, clearAuthFailures, authenticatedUser, userHasRole, hashPassword, verifyPassword, createToken, type AuthRole } from "./auth.js";
import { mountFederationRoutes } from "./federation-router.js";
import { handleFederationDelegateStream } from "./federation-stream.js";
import { RpcConnection } from "./rpc.js";
import { getAllSessions } from "../agent/session.js";
import { getEventLoopLagSnapshot } from "../observability/event-loop-monitor.js";
import { getProviderActivitySnapshot } from "../observability/provider-activity-monitor.js";
import { probeDockerReachability } from "../agent/container-runner.js";
import {
  buildSessionAuditMarkdownDetached,
  buildSessionDebugMarkdownDetached,
  SessionExportBusyError,
} from "../agent/debug-session-export.js";
import { listSiteCredentials, saveSiteCredential, deleteSiteCredential, getStoredSiteCredentialRecord, hasConfigSiteCredential } from "../credentials/sites.js";
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
import { createJob, cancelJob, getJob as getExecutionJob, listJobs, deleteSceneJob } from "../agent/jobs.js";
import { resolveApproval, getPendingApproval, listPendingApprovals } from "../approval/store.js";
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
import { getConcurrencySnapshot, getGlobalConcurrencySnapshot } from "../swarm/concurrency.js";
import { isSwarmBusConnected } from "../swarm/bus.js";
import { getAgentCapabilitySnapshot } from "../swarm/capabilities.js";
import { getBidderWorkerStatus } from "../swarm/bidder-worker.js";
import { getAgentMessageBacklogSnapshot, readAllFacts } from "../swarm/memory.js";
import { deriveSharedSessionId } from "../tools/memory.js";
import { turnSteeringManager } from "../agent/turn-steering.js";
import { getLoadedDynamicTools, listPromotionCandidates, approvePromotion, rejectPromotion, getDynamicToolStats } from "../tools/dynamic-tools.js";
import { listCapabilityGaps } from "../agent/self-improve.js";
import { getWardenAlerts } from "../agent/warden.js";
import { listCheckpoints, resumeCheckpoint, completeCheckpoint } from "../swarm/checkpoints.js";
import { ModelConfigSchema, MultimodalSchema, RetrievalRerankerSchema, OrchestrationSchema, SkillLibrarySchema, ToolPipelineSchema } from "../config/schema.js";
import { getMcpConnections } from "../mcp/registry.js";
import { handleMcpHttpRequest, getMcpHttpSessionCount } from "../mcp/server-http.js";
import { getMcpExposeSummary } from "../mcp/server.js";
import { computerSessionManager } from "../agent/computer-session.js";
import { browserSessionManager } from "../agent/browser-session.js";
import { longRunningGenerationManager } from "../agent/long-running-generation.js";
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
      // Web
      ".html": "text/html; charset=utf-8",
      ".htm": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".mjs": "text/javascript; charset=utf-8",
      ".ts": "text/plain; charset=utf-8",
      ".jsx": "text/plain; charset=utf-8",
      ".tsx": "text/plain; charset=utf-8",
      // Documents
      ".md": "text/markdown; charset=utf-8",
      ".txt": "text/plain; charset=utf-8",
      ".pdf": "application/pdf",
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".doc": "application/msword",
      ".odt": "application/vnd.oasis.opendocument.text",
      ".rtf": "application/rtf",
      // Spreadsheets
      ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".xls": "application/vnd.ms-excel",
      ".ods": "application/vnd.oasis.opendocument.spreadsheet",
      ".csv": "text/csv; charset=utf-8",
      // Presentations
      ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ".ppt": "application/vnd.ms-powerpoint",
      ".odp": "application/vnd.oasis.opendocument.presentation",
      // Data
      ".json": "application/json; charset=utf-8",
      ".jsonc": "application/json; charset=utf-8",
      ".jsonl": "application/json; charset=utf-8",
      ".yaml": "application/yaml; charset=utf-8",
      ".yml": "application/yaml; charset=utf-8",
      ".xml": "application/xml; charset=utf-8",
      ".toml": "text/plain; charset=utf-8",
      ".sql": "text/plain; charset=utf-8",
      ".sh": "text/plain; charset=utf-8",
      ".py": "text/plain; charset=utf-8",
      ".log": "text/plain; charset=utf-8",
      // Images
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
      ".bmp": "image/bmp",
      ".tiff": "image/tiff",
      ".avif": "image/avif",
      // Audio
      ".wav": "audio/wav",
      ".mp3": "audio/mpeg",
      ".m4a": "audio/mp4",
      ".ogg": "audio/ogg",
      ".webm": "audio/webm",
      ".flac": "audio/flac",
      // Video
      ".mp4": "video/mp4",
      ".mov": "video/quicktime",
      ".avi": "video/x-msvideo",
      ".mkv": "video/x-matroska",
      // Archives
      ".zip": "application/zip",
      ".tar": "application/x-tar",
      ".gz": "application/gzip",
      // Fonts
      ".woff": "font/woff",
      ".woff2": "font/woff2",
      ".ttf": "font/ttf",
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
    // Latest event-loop lag sample (cheap, no probes) so operators can poll
    // whether the main thread is stalling without hitting the authed deep checks.
    const eventLoopLag = getEventLoopLagSnapshot();
    // In-flight provider activity (is the remote LLM producing / prefilling / stalled).
    const providerActivity = getProviderActivitySnapshot();
    return c.json({
      status: "ready",
      sessions,
      ...(eventLoopLag ? { eventLoopLag } : {}),
      providerActivity,
    });
  });

  // Deep subsystem self-checks (authed) — actively probe embeddings (non-zero
  // vectors), pgvector, MemGraph, and QuestDB telemetry so SILENT degradation
  // (e.g. all-zero embeddings) becomes visible instead of failing quietly.
  // Kept off /healthz so the Docker liveness probe stays cheap and stable.
  app.get("/api/health/subsystems", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const { runSubsystemChecks } = await import("../observability/health-checks.js");
    const report = await runSubsystemChecks();
    return c.json(report, report.healthy ? 200 : 503);
  });

  // Recovery-net firing counts (authed). Shows which of the ~34 orchestration
  // autopilots actually fire — the evidence needed to retire dead scaffolding.
  app.get("/api/observability/recovery-nets", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const { getRecoveryMetricsSnapshot } = await import("../observability/recovery-metrics.js");
    return c.json(getRecoveryMetricsSnapshot());
  });

  // ── Role-based access control (Wave B) ───────────────────────────────────
  // Mutating verbs (POST/PUT/PATCH/DELETE) require the operator role by
  // default.  Viewers can read every dashboard endpoint but cannot mutate
  // persistent state.  Routes that don't fit this default — e.g. login
  // (no user yet) and externally-driven webhooks — are explicitly bypassed.
  //
  // The middleware is a no-op when:
  //   - `auth.enabled` is false (legacy single-operator mode)
  //   - the request has no Authorization header (existing auth check elsewhere returns 401)
  //   - the route's verb is read-only (GET / HEAD / OPTIONS)
  //   - the route is on the bypass allowlist
  const ROLE_GATE_BYPASS = new Set<string>([
    "/api/auth/login",
    "/channels/slack/events",
    "/channels/discord/events",
    "/channels/whatsapp/webhook",
    "/channels/email/webhook",
    "/channels/signal/webhook",
  ]);
  app.use("/api/*", async (c, next) => {
    if (!getConfig().auth.enabled) return next();
    const method = c.req.method.toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
    if (ROLE_GATE_BYPASS.has(c.req.path)) return next();
    const user = await authenticatedUser(c.req.header("Authorization"));
    // No user → fall through; the route's own auth check will return 401.
    if (!user) return next();
    if (!userHasRole(user, "operator")) {
      logAudit("rbac_denied", {
        username: user.username,
        role: user.role,
        method,
        path: c.req.path,
      }, { userId: user.username, severity: "warn" });
      return c.json({ error: "Operator role required for this action" }, 403);
    }
    return next();
  });

  // ── Multi-user authentication (Wave A) ───────────────────────────────────
  // Routes are mounted unconditionally; behavior gates on auth.enabled at
  // request time so the operator can flip the flag without a restart.

  app.post("/api/auth/login", async (c) => {
    const ip = c.req.header("X-Forwarded-For") ?? "unknown";
    const rate = checkAuthRateLimit(ip);
    if (!rate.allowed) {
      return c.json({ error: "Too many failed attempts. Try again later." }, 429);
    }

    let body: { username?: unknown; password?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!username || !password) {
      return c.json({ error: "Username and password are required" }, 400);
    }

    const authConfig = getConfig().auth;
    if (!authConfig.enabled) {
      return c.json({ error: "Username/password login is disabled. Set auth.enabled = true and configure auth.users[] to enable it." }, 503);
    }

    const user = authConfig.users.find((u) => u.username.toLowerCase() === username);
    if (!user) {
      recordAuthFailure(ip);
      return c.json({ error: "Invalid username or password" }, 401);
    }

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      recordAuthFailure(ip);
      return c.json({ error: "Invalid username or password" }, 401);
    }

    clearAuthFailures(ip);
    const token = await createToken(user.username, {
      role: user.role,
      ...(user.displayName ? { displayName: user.displayName } : {}),
    });
    logAudit("auth_success", { username: user.username, role: user.role }, { userId: user.username });
    return c.json({
      token,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
    });
  });

  app.get("/api/auth/me", async (c) => {
    const user = await authenticatedUser(c.req.header("Authorization"));
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    return c.json(user);
  });

  app.get("/api/auth/users", async (c) => {
    const user = await authenticatedUser(c.req.header("Authorization"));
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const users = getConfig().auth.users.map((u) => ({
      username: u.username,
      displayName: u.displayName,
      role: u.role,
      createdAt: u.createdAt,
    }));
    return c.json({ enabled: getConfig().auth.enabled, users });
  });

  app.post("/api/auth/users", async (c) => {
    const actor = await authenticatedUser(c.req.header("Authorization"));
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    if (!userHasRole(actor, "operator")) {
      return c.json({ error: "Operator role required" }, 403);
    }

    let body: { username?: unknown; password?: unknown; displayName?: unknown; role?: unknown };
    try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const displayName = typeof body.displayName === "string" ? body.displayName : undefined;
    const role: AuthRole = body.role === "viewer" ? "viewer" : "operator";
    if (!username || !/^[a-z0-9_.-]+$/.test(username)) {
      return c.json({ error: "username must be alphanumeric/_/-/." }, 400);
    }
    if (password.length < 8) {
      return c.json({ error: "password must be at least 8 characters" }, 400);
    }

    if (getConfig().auth.users.find((u) => u.username.toLowerCase() === username)) {
      return c.json({ error: `User '${username}' already exists` }, 409);
    }

    const passwordHash = await hashPassword(password);
    const createdAt = new Date().toISOString();

    updateConfig((raw) => {
      const auth = (raw["auth"] = (raw["auth"] as Record<string, unknown>) ?? {});
      const users = (auth["users"] = (auth["users"] as unknown[] | undefined) ?? []);
      (users as unknown[]).push({ username, passwordHash, displayName, role, createdAt });
      // Auto-enable so the first added user makes the feature usable.
      if (auth["enabled"] !== true) auth["enabled"] = true;
    });

    logAudit("auth_user_created", { actor: actor.username, username, displayName: displayName ?? null, role }, { userId: actor.username, severity: "info" });
    return c.json({ username, displayName, role, createdAt });
  });

  app.delete("/api/auth/users/:username", async (c) => {
    const actor = await authenticatedUser(c.req.header("Authorization"));
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    if (!userHasRole(actor, "operator")) {
      return c.json({ error: "Operator role required" }, 403);
    }

    const target = c.req.param("username").toLowerCase();
    const targetUser = getConfig().auth.users.find((u) => u.username.toLowerCase() === target);
    if (!targetUser) {
      return c.json({ error: `User '${target}' not found` }, 404);
    }
    const remaining = getConfig().auth.users.filter((u) => u.username.toLowerCase() !== target);
    // Prevent locking the deployment out of administration: at least one
    // operator must remain.  Viewers don't count toward this floor.
    const remainingOperators = remaining.filter((u) => u.role === "operator");
    if (remainingOperators.length === 0) {
      return c.json({ error: "Refusing to delete the last operator — promote another account first" }, 400);
    }

    updateConfig((raw) => {
      const auth = (raw["auth"] as Record<string, unknown>) ?? {};
      auth["users"] = remaining.map((u) => ({
        username: u.username,
        passwordHash: u.passwordHash,
        role: u.role,
        ...(u.displayName ? { displayName: u.displayName } : {}),
        ...(u.createdAt ? { createdAt: u.createdAt } : {}),
      }));
      raw["auth"] = auth;
    });

    logAudit("auth_user_deleted", { actor: actor.username, username: target, role: targetUser.role }, { userId: actor.username, severity: "warn" });
    return c.json({ ok: true });
  });

  // Federation routes — gated at request time on federation.enabled, so
  // toggling the config flag takes effect without a gateway restart.
  mountFederationRoutes(app);

  // ── Federation dashboard endpoints (user-JWT auth, not HMAC) ─────────────
  // These power the /federation Vue page; they read from the local capability
  // cache + audit ring buffer rather than re-fetching on every poll.
  app.get("/api/federation/peers", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const fedConfig = getConfig().federation;
    if (!fedConfig.enabled) {
      return c.json({ enabled: false, instanceId: fedConfig.instanceId, peers: [] });
    }

    const { fetchPeerCapability, pingPeer } = await import("../federation/index.js");
    const wantsPing = c.req.query("ping") === "1";
    const wantsRefresh = c.req.query("refresh") === "1";

    const peers = await Promise.all(fedConfig.peers.map(async (peer) => {
      const summary: Record<string, unknown> = {
        id: peer.id,
        url: peer.url,
        description: peer.description ?? null,
        tags: peer.tags,
      };
      try {
        const capability = await fetchPeerCapability(peer.id, { force: wantsRefresh });
        summary["instanceId"] = capability.instanceId;
        summary["protocolVersion"] = capability.protocolVersion;
        summary["agents"] = capability.agents;
        summary["toolNames"] = capability.toolNames;
        summary["capabilitiesFetchedAt"] = capability.generatedAt;
      } catch (err) {
        summary["capabilityError"] = (err as Error).message;
      }
      if (wantsPing) {
        summary["ping"] = await pingPeer(peer.id);
      }
      return summary;
    }));

    return c.json({
      enabled: true,
      instanceId: fedConfig.instanceId,
      peers,
    });
  });

  app.get("/api/federation/activity", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const limit = Math.min(200, Math.max(1, Number(c.req.query("limit")) || 50));
    const { getRecentFederationEvents } = await import("../federation/index.js");
    const events = getRecentFederationEvents(limit);
    return c.json({ events });
  });

  // ── Cost governance (dashboard) ─────────────────────────────────────────
  // Both routes are read-only and surface aggregated token usage + estimated
  // dollar spend.  The summary prefers the durable QuestDB `llm_usage` series
  // (survives restarts, full history) and falls back to the in-process cost
  // aggregator when QuestDB is unavailable or empty.  When cost.enabled is
  // false the aggregator stays idle and the endpoints return zeroed buckets —
  // operators can still wire the dashboard up without committing to alerting.
  app.get("/api/cost/summary", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const range = Math.min(90, Math.max(1, Number(c.req.query("range")) || 30));
    const cfg = getConfig().cost;
    const { getCostSummary } = await import("../observability/cost.js");
    const { getCostSummaryFromTimeseries } = await import("../observability/telemetry.js");
    const durable = await getCostSummaryFromTimeseries(range);
    return c.json({
      enabled: cfg.enabled,
      budgets: cfg.budgets,
      source: durable ? "questdb" : "memory",
      summary: durable ?? getCostSummary(range),
    });
  });

  app.get("/api/cost/projection", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const window = Math.min(30, Math.max(1, Number(c.req.query("window")) || 7));
    const { getCostProjection } = await import("../observability/cost.js");
    return c.json(getCostProjection(window));
  });

  // ── Tracing status (dashboard) ───────────────────────────────────────────
  app.get("/api/tracing/status", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const cfg = getConfig().tracing;
    const { isTracingEnabled } = await import("../observability/tracing.js");
    return c.json({
      configured: cfg.enabled,
      active: isTracingEnabled(),
      endpoint: cfg.otlpEndpoint,
      serviceName: cfg.serviceName,
      sampleRate: cfg.sampleRate,
    });
  });

  // ── Plugin SDK dashboard endpoint ────────────────────────────────────────
  // Lists plugins loaded at startup with their tool surface.  Operators can
  // sanity-check what third-party code is running.
  app.get("/api/plugins", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const { listLoadedPlugins, resolvePluginsDir } = await import("../plugin/loader.js");
    return c.json({
      enabled: getConfig().plugins?.enabled !== false,
      directory: resolvePluginsDir(),
      plugins: listLoadedPlugins(),
    });
  });

  // ── MCP integration (Stage 12 — Open Interop) ────────────────────────────
  //
  //   GET    /api/mcp/servers           — list configured + active inbound servers
  //   POST   /api/mcp/servers           — add/replace one (validates against schema, persists, syncs)
  //   PATCH  /api/mcp/servers/:id       — partial update (e.g. flip autoStart)
  //   DELETE /api/mcp/servers/:id       — remove + tear down
  //   POST   /api/mcp/servers/:id/reconnect — force a fresh handshake
  //
  //   GET    /api/mcp/expose            — outbound server status + advertised surface
  //   PATCH  /api/mcp/expose            — toggle / re-allowlist exposure
  //
  // Mutating routes inherit the existing operator-only RBAC middleware
  // mounted at the top of /api/*; no extra role check required here.

  app.get("/api/mcp/servers", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const config = getConfig();
    const connections = getMcpConnections();
    const servers = Object.entries(config.mcp.servers ?? {}).map(([id, cfg]) => {
      const conn = connections.get(id);
      return {
        id,
        config: cfg,
        status: conn ? "connected" : (cfg.autoStart ? "disconnected" : "disabled"),
        toolCount: conn?.tools.length ?? 0,
        tools: conn?.tools.map((t) => ({ name: t.name, description: t.description })) ?? [],
      };
    });
    return c.json({ servers });
  });

  app.post("/api/mcp/servers", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    let body: { id?: unknown; config?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id || !/^[a-z0-9_-]+$/i.test(id)) {
      return c.json({ error: "id is required and must match /^[a-z0-9_-]+$/i" }, 400);
    }

    const { McpServerConfigSchema } = await import("../config/schema.js");
    const parsed = McpServerConfigSchema.safeParse(body.config);
    if (!parsed.success) {
      return c.json({ error: "Invalid MCP server config", issues: parsed.error.issues }, 400);
    }

    updateConfig((raw) => {
      const mcp = (raw["mcp"] ??= {}) as Record<string, unknown>;
      const servers = (mcp["servers"] ??= {}) as Record<string, unknown>;
      servers[id] = body.config as Record<string, unknown>;
    });

    const { syncMcpServers } = await import("../mcp/registry.js");
    try {
      await syncMcpServers();
    } catch (err) {
      logAudit("mcp_server_connect_failed", { id, reason: String(err) }, { severity: "warn" });
      return c.json({ ok: false, id, error: String(err) }, 502);
    }

    logAudit("mcp_server_added", { id, transport: parsed.data.transport });
    const conn = getMcpConnections().get(id);
    return c.json({
      ok: true,
      id,
      status: conn ? "connected" : "disconnected",
      toolCount: conn?.tools.length ?? 0,
    });
  });

  app.patch("/api/mcp/servers/:id", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const id = c.req.param("id");
    const existing = getConfig().mcp.servers?.[id];
    if (!existing) return c.json({ error: "Unknown MCP server id" }, 404);

    let patch: Record<string, unknown>;
    try {
      patch = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const merged = { ...existing, ...patch };
    const { McpServerConfigSchema } = await import("../config/schema.js");
    const parsed = McpServerConfigSchema.safeParse(merged);
    if (!parsed.success) {
      return c.json({ error: "Invalid MCP server config", issues: parsed.error.issues }, 400);
    }

    updateConfig((raw) => {
      const mcp = (raw["mcp"] ??= {}) as Record<string, unknown>;
      const servers = (mcp["servers"] ??= {}) as Record<string, unknown>;
      servers[id] = merged;
    });

    const { syncMcpServers } = await import("../mcp/registry.js");
    try {
      await syncMcpServers();
    } catch (err) {
      logAudit("mcp_server_connect_failed", { id, reason: String(err) }, { severity: "warn" });
      return c.json({ ok: false, id, error: String(err) }, 502);
    }

    logAudit("mcp_server_updated", { id, transport: parsed.data.transport });
    return c.json({ ok: true, id });
  });

  app.delete("/api/mcp/servers/:id", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const id = c.req.param("id");
    if (!getConfig().mcp.servers?.[id]) {
      return c.json({ error: "Unknown MCP server id" }, 404);
    }

    updateConfig((raw) => {
      const mcp = (raw["mcp"] ??= {}) as Record<string, unknown>;
      const servers = (mcp["servers"] ??= {}) as Record<string, unknown>;
      delete servers[id];
    });

    const { syncMcpServers } = await import("../mcp/registry.js");
    try {
      await syncMcpServers();
    } catch (err) {
      log.warn({ err, id }, "MCP sync after delete threw");
    }

    logAudit("mcp_server_removed", { id });
    return c.json({ ok: true, id });
  });

  app.post("/api/mcp/servers/:id/reconnect", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const id = c.req.param("id");
    if (!getConfig().mcp.servers?.[id]) {
      return c.json({ error: "Unknown MCP server id" }, 404);
    }

    const { syncMcpServers } = await import("../mcp/registry.js");
    try {
      await syncMcpServers();
      logAudit("mcp_server_reconnected", { id });
      const conn = getMcpConnections().get(id);
      return c.json({
        ok: true,
        id,
        status: conn ? "connected" : "disconnected",
        toolCount: conn?.tools.length ?? 0,
      });
    } catch (err) {
      logAudit("mcp_server_connect_failed", { id, reason: String(err) }, { severity: "warn" });
      return c.json({ ok: false, id, error: String(err) }, 502);
    }
  });

  app.get("/api/mcp/expose", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    return c.json({
      ...getMcpExposeSummary(),
      activeHttpSessions: getMcpHttpSessionCount(),
      stdioCommandHint: "node packages/core/dist/mcp-stdio.js",
    });
  });

  // ── Public A2A protocol — peer + expose management ──────────────────────
  app.get("/api/a2a/status", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const a2a = getConfig().a2a;
    const { listA2APeers } = await import("../a2a/client.js");
    return c.json({
      enabled: a2a.enabled,
      exposeAgents: a2a.exposeAgents,
      requireSharedBearer: !!a2a.inboundBearerToken,
      peers: listA2APeers().map((p) => ({
        id: p.id,
        url: p.url,
        description: p.description,
        skillCount: p.skills.length,
        skills: p.skills.map((s) => ({ id: s.id, name: s.name, description: s.description, tags: s.tags })),
        virtualAgents: p.virtualAgents,
        lastPolledAt: p.lastPolledAt,
        lastError: p.lastError,
      })),
    });
  });

  app.post("/api/a2a/peers", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    let body: Record<string, unknown>;
    try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
    const { A2APeerSchema } = await import("../config/schema.js");
    const parsed = A2APeerSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid A2A peer", issues: parsed.error.issues }, 400);
    }

    updateConfig((raw) => {
      const a2a = (raw["a2a"] ??= {}) as Record<string, unknown>;
      const peers = (a2a["peers"] ??= []) as Array<Record<string, unknown>>;
      const idx = peers.findIndex((p) => p["id"] === parsed.data.id);
      if (idx >= 0) peers[idx] = parsed.data;
      else peers.push(parsed.data);
    });

    const { startA2AClient } = await import("../a2a/client.js");
    await startA2AClient();
    return c.json({ ok: true, id: parsed.data.id });
  });

  app.delete("/api/a2a/peers/:id", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const id = c.req.param("id");

    updateConfig((raw) => {
      const a2a = (raw["a2a"] ??= {}) as Record<string, unknown>;
      const peers = (a2a["peers"] as Array<Record<string, unknown>> | undefined) ?? [];
      a2a["peers"] = peers.filter((p) => p["id"] !== id);
    });

    const { startA2AClient } = await import("../a2a/client.js");
    await startA2AClient();
    return c.json({ ok: true, id });
  });

  app.patch("/api/mcp/expose", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    let patch: Record<string, unknown>;
    try {
      patch = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { McpServerExposeSchema } = await import("../config/schema.js");
    const merged = { ...getConfig().mcp.expose, ...patch };
    const parsed = McpServerExposeSchema.safeParse(merged);
    if (!parsed.success) {
      return c.json({ error: "Invalid expose config", issues: parsed.error.issues }, 400);
    }

    updateConfig((raw) => {
      const mcp = (raw["mcp"] ??= {}) as Record<string, unknown>;
      mcp["expose"] = parsed.data;
    });

    return c.json({ ok: true, expose: getMcpExposeSummary() });
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

    try {
      await syncChatProviderRuntimeStatus();
    } catch {
      // Return the last known runtime snapshot even if the refresh probe fails.
    }

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

  // ── Orchestration tuning ──────────────────────────────────────────────────
  // GET /api/orchestration/config — returns current config plus built-in defaults
  // PUT /api/orchestration/config — validates and persists the orchestration section
  app.get("/api/orchestration/config", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    return c.json({
      config: getConfig().orchestration,
      defaults: {
        maxParallelSlices: 2,
        subAgentToolCaps: { web_search: 14, web_fetch: 16, write_file: 3, delegate_to_agent: 3, computer_snapshot: 8 },
        coordinatorToolCaps: { delegate_to_agent: 6, swarm_delegate: 6, web_search: 20, web_fetch: 25 },
        perTurnCaps: { delegate_to_agent: 5, computer_click: 8, computer_type: 6, computer_hotkey: 6, computer_snapshot: 3 },
      },
    });
  });

  app.put("/api/orchestration/config", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = OrchestrationSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid orchestration configuration", details: parsed.error.flatten() }, 400);
    }

    try {
      const updatedConfig = updateConfig((raw) => {
        raw["orchestration"] = parsed.data;
      });
      return c.json(updatedConfig.orchestration);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  // ── Skill Library + Tool Pipeline feature config ──────────────────────────
  // GET returns both feature sections; PUT accepts a partial { skillLibrary?,
  // toolPipeline? } and validates each section independently.
  app.get("/api/skill-library/config", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const cfg = getConfig();
    return c.json({ skillLibrary: cfg.skillLibrary, toolPipeline: cfg.toolPipeline });
  });

  app.put("/api/skill-library/config", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    let body: { skillLibrary?: unknown; toolPipeline?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    let skillLibrary: ReturnType<typeof SkillLibrarySchema.parse> | undefined;
    let toolPipeline: ReturnType<typeof ToolPipelineSchema.parse> | undefined;
    if (body.skillLibrary !== undefined) {
      const parsed = SkillLibrarySchema.safeParse(body.skillLibrary);
      if (!parsed.success) return c.json({ error: "Invalid skillLibrary configuration", details: parsed.error.flatten() }, 400);
      skillLibrary = parsed.data;
    }
    if (body.toolPipeline !== undefined) {
      const parsed = ToolPipelineSchema.safeParse(body.toolPipeline);
      if (!parsed.success) return c.json({ error: "Invalid toolPipeline configuration", details: parsed.error.flatten() }, 400);
      toolPipeline = parsed.data;
    }
    if (!skillLibrary && !toolPipeline) {
      return c.json({ error: "Provide skillLibrary and/or toolPipeline" }, 400);
    }

    try {
      const updated = updateConfig((raw) => {
        if (skillLibrary) raw["skillLibrary"] = skillLibrary;
        if (toolPipeline) raw["toolPipeline"] = toolPipeline;
      });
      return c.json({ skillLibrary: updated.skillLibrary, toolPipeline: updated.toolPipeline });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  // ── Skill Library inspector ───────────────────────────────────────────────
  // GET  /api/skills                 — list skills (filter by status/query)
  // GET  /api/skills/:slug/history   — inspect mutation history
  // POST /api/skills/:slug/patch     — exact-string patch SKILL.md/support file
  // POST /api/skills/:slug/rollback  — restore a history entry
  // POST /api/skills/:slug/support-file — write support file
  // GET/DELETE /api/skills/:slug/support-file?filePath=... — read/remove support file
  // POST /api/skills/:slug/archive   — archive a skill
  // DELETE /api/skills/:slug         — delete a skill
  app.get("/api/skills", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    try {
      const { listSkillSupportFiles, listSkills, skillSuccessRate } = await import("../skills/store.js");
      const cfg = getConfig();
      const includeArchived = c.req.query("includeArchived") === "true";
      const statusFilter = c.req.query("status");
      const query = (c.req.query("query") ?? "").toLowerCase().trim();
      let skills = listSkills(cfg.workspacePath, { includeArchived });
      if (statusFilter) skills = skills.filter((s) => s.frontmatter.status === statusFilter);
      if (query) {
        skills = skills.filter((s) =>
          s.frontmatter.name.toLowerCase().includes(query)
          || s.frontmatter.description.toLowerCase().includes(query)
          || s.frontmatter.whenToUse.toLowerCase().includes(query)
          || s.frontmatter.tags.some((t) => t.toLowerCase().includes(query)));
      }
      const records = skills.map((s) => ({
        slug: s.frontmatter.slug,
        name: s.frontmatter.name,
        description: s.frontmatter.description,
        whenToUse: s.frontmatter.whenToUse,
        version: s.frontmatter.version,
        status: s.frontmatter.status,
        tags: s.frontmatter.tags,
        agents: s.frontmatter.agents,
        tools: s.frontmatter.tools,
        origin: s.meta.origin,
        curatorManaged: s.meta.curatorManaged,
        pinned: s.meta.pinned,
        views: s.meta.views,
        uses: s.meta.uses,
        successes: s.meta.successes,
        failures: s.meta.failures,
        patches: s.meta.patches,
        successRate: skillSuccessRate(s.meta),
        updatedAt: s.meta.updatedAt,
        lastViewedAt: s.meta.lastViewedAt,
        lastUsedAt: s.meta.lastUsedAt,
        lastPatchedAt: s.meta.lastPatchedAt,
        archivedAt: s.meta.archivedAt,
        supportFiles: listSkillSupportFiles(cfg.workspacePath, s.frontmatter.slug),
        body: s.body,
      }));
      return c.json({ total: records.length, records });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/api/skills/:slug/history", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    try {
      const { getSkill, listSkillHistory } = await import("../skills/store.js");
      const cfg = getConfig();
      const slug = c.req.param("slug");
      if (!getSkill(cfg.workspacePath, slug)) return c.json({ error: "Skill not found" }, 404);
      return c.json({ slug, history: listSkillHistory(cfg.workspacePath, slug) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/skills/:slug/patch", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    let body: Record<string, unknown>;
    try { body = await c.req.json() as Record<string, unknown>; } catch { return c.json({ error: "Invalid JSON body" }, 400); }
    try {
      const { getSkill, patchSkill } = await import("../skills/store.js");
      const cfg = getConfig();
      const slug = c.req.param("slug");
      if (!getSkill(cfg.workspacePath, slug)) return c.json({ error: "Skill not found" }, 404);
      const oldString = typeof body["oldString"] === "string" ? body["oldString"] : "";
      const newString = typeof body["newString"] === "string" ? body["newString"] : undefined;
      if (!oldString || newString === undefined) return c.json({ error: "oldString and newString are required" }, 400);
      const skill = patchSkill(cfg.workspacePath, slug, {
        oldString,
        newString,
        replaceAll: body["replaceAll"] === true,
        filePath: typeof body["filePath"] === "string" ? body["filePath"] : undefined,
      });
      return c.json({ slug: skill.frontmatter.slug, version: skill.frontmatter.version, patches: skill.meta.patches });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/skills/:slug/rollback", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    try {
      const { getSkill, rollbackSkillHistory } = await import("../skills/store.js");
      const cfg = getConfig();
      const slug = c.req.param("slug");
      if (!getSkill(cfg.workspacePath, slug)) return c.json({ error: "Skill not found" }, 404);
      const historyId = typeof body["historyId"] === "string" ? body["historyId"] : undefined;
      const skill = rollbackSkillHistory(cfg.workspacePath, slug, historyId);
      return c.json({ slug: skill.frontmatter.slug, version: skill.frontmatter.version, patches: skill.meta.patches });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/skills/:slug/support-file", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    let body: Record<string, unknown>;
    try { body = await c.req.json() as Record<string, unknown>; } catch { return c.json({ error: "Invalid JSON body" }, 400); }
    try {
      const { getSkill, listSkillSupportFiles, writeSkillSupportFile } = await import("../skills/store.js");
      const cfg = getConfig();
      const slug = c.req.param("slug");
      if (!getSkill(cfg.workspacePath, slug)) return c.json({ error: "Skill not found" }, 404);
      const filePath = typeof body["filePath"] === "string" ? body["filePath"].trim() : "";
      const fileContent = typeof body["fileContent"] === "string" ? body["fileContent"] : undefined;
      if (!filePath || fileContent === undefined) return c.json({ error: "filePath and fileContent are required" }, 400);
      const skill = writeSkillSupportFile(cfg.workspacePath, slug, filePath, fileContent);
      return c.json({ slug: skill.frontmatter.slug, filePath, supportFiles: listSkillSupportFiles(cfg.workspacePath, skill.frontmatter.slug) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/api/skills/:slug/support-file", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    try {
      const { getSkill, readSkillSupportFile } = await import("../skills/store.js");
      const cfg = getConfig();
      const slug = c.req.param("slug");
      if (!getSkill(cfg.workspacePath, slug)) return c.json({ error: "Skill not found" }, 404);
      const filePath = c.req.query("filePath")?.trim() ?? "";
      if (!filePath) return c.json({ error: "filePath is required" }, 400);
      return c.json({ slug, filePath, content: readSkillSupportFile(cfg.workspacePath, slug, filePath) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.delete("/api/skills/:slug/support-file", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    try {
      const { getSkill, listSkillSupportFiles, removeSkillSupportFile } = await import("../skills/store.js");
      const cfg = getConfig();
      const slug = c.req.param("slug");
      if (!getSkill(cfg.workspacePath, slug)) return c.json({ error: "Skill not found" }, 404);
      const filePath = c.req.query("filePath")?.trim() ?? "";
      if (!filePath) return c.json({ error: "filePath is required" }, 400);
      const skill = removeSkillSupportFile(cfg.workspacePath, slug, filePath);
      return c.json({ slug: skill.frontmatter.slug, filePath, supportFiles: listSkillSupportFiles(cfg.workspacePath, skill.frontmatter.slug) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/skills/:slug/pin", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    try {
      const { getSkill, setSkillPinned } = await import("../skills/store.js");
      const cfg = getConfig();
      const slug = c.req.param("slug");
      if (!getSkill(cfg.workspacePath, slug)) return c.json({ error: "Skill not found" }, 404);
      setSkillPinned(cfg.workspacePath, slug, true);
      return c.json({ slug, pinned: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/skills/:slug/unpin", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    try {
      const { getSkill, setSkillPinned } = await import("../skills/store.js");
      const cfg = getConfig();
      const slug = c.req.param("slug");
      if (!getSkill(cfg.workspacePath, slug)) return c.json({ error: "Skill not found" }, 404);
      setSkillPinned(cfg.workspacePath, slug, false);
      return c.json({ slug, pinned: false });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/skills/:slug/archive", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    try {
      const { getSkill, setSkillStatus } = await import("../skills/store.js");
      const cfg = getConfig();
      const slug = c.req.param("slug");
      if (!getSkill(cfg.workspacePath, slug)) return c.json({ error: "Skill not found" }, 404);
      if (!setSkillStatus(cfg.workspacePath, slug, "archived")) return c.json({ error: "Skill is pinned and cannot be archived" }, 409);
      return c.json({ slug, status: "archived" });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.delete("/api/skills/:slug", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    try {
      const { getSkill, deleteSkill } = await import("../skills/store.js");
      const cfg = getConfig();
      const slug = c.req.param("slug");
      if (!getSkill(cfg.workspacePath, slug)) return c.json({ error: "Skill not found" }, 404);
      if (!deleteSkill(cfg.workspacePath, slug)) return c.json({ error: "Skill is pinned and cannot be deleted" }, 409);
      return c.json({ slug, deleted: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
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

  app.delete("/api/multimodal/voices/:id", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const multimodalConfig = currentMultimodalConfig();

    if (!multimodalServiceConfigured(multimodalConfig.tts.baseUrl)) {
      return disabledServiceResponse("TTS is disabled: configure multimodal.tts.baseUrl to enable voice management.");
    }

    if (multimodalConfig.tts.api !== "qwen-compatible") {
      return c.json({ error: "Voice deletion is only supported for qwen-compatible TTS backends." }, 400);
    }

    const voiceId = c.req.param("id");
    if (!voiceId?.trim()) return c.json({ error: "voice id is required" }, 400);

    try {
      const upstream = await fetchWithTimeout(
        upstreamUrl(multimodalConfig.tts.baseUrl, `/voices/${encodeURIComponent(voiceId)}`),
        {
          method: "DELETE",
          headers: upstreamHeaders(multimodalConfig.tts.apiKey),
        },
        multimodalConfig.tts.timeoutMs,
      );

      if (!upstream.ok) {
        return new Response(JSON.stringify({ error: await extractUpstreamError(upstream, "Failed to delete voice") }), {
          status: upstream.status,
          headers: { "Content-Type": "application/json" },
        });
      }

      return c.json({ ok: true, voice_id: voiceId });
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

  // ── Workspace static preview server ──────────────────────────────────────
  // GET /api/workspace/preview?root=<dir>&file=<rel>&token=<jwt>
  //
  // Serves any file within a workspace directory as a proper static response.
  // Designed for iframe use: the token travels as a query parameter because
  // browsers cannot set Authorization headers on iframe src attributes.
  // `root` is the workspace-relative directory that forms the document root.
  // `file` is the file path relative to that root (defaults to index.html).
  // Only files strictly inside the root are served (path-traversal blocked).
  //
  // This enables multi-file web projects (HTML + CSS + JS + assets) to load
  // with all relative imports resolved correctly, including fonts and images.
  app.get("/api/workspace/preview", async (c) => {
    const queryToken = c.req.query("token")?.trim();
    if (!queryToken || !await verifyToken(queryToken)) {
      return c.text("Unauthorized", 401);
    }

    const root = c.req.query("root")?.trim();
    const file = c.req.query("file")?.trim() || "index.html";

    if (!root) return c.text("root query parameter is required", 400);

    // Validate that both root and file stay within the workspace
    let rootResolved: string;
    let fileResolved: string;
    try {
      const rootTarget = resolveWorkspaceTarget(root);
      rootResolved = rootTarget.resolved;

      // Resolve the requested file within the root (not the workspace) to
      // block path traversal attempts like `../../etc/passwd`.
      const candidate = resolve(rootResolved, file.replace(/^\/+/, ""));
      if (!candidate.startsWith(rootResolved + sep) && candidate !== rootResolved) {
        return c.text("File path escapes root directory", 400);
      }
      fileResolved = candidate;
    } catch {
      return c.text("Path escapes workspace boundary", 400);
    }

    const fileStat = await stat(fileResolved).catch(() => null);
    if (!fileStat?.isFile()) {
      return c.text("File not found", 404);
    }
    if (fileStat.size > WORKSPACE_FILE_MAX_BYTES) {
      return c.text("File too large", 413);
    }

    const bytes = await readFile(fileResolved);
    const filename = basename(fileResolved);
    return c.body(bytes, 200, {
      "Content-Type": guessWorkspaceContentType(filename),
      // Allow the iframe's scripts to make requests back to the same origin
      // for additional assets via /api/workspace/preview, but nothing else.
      "Cross-Origin-Resource-Policy": "same-origin",
    });
  });

  // ── Memory inspector endpoints ────────────────────────────────────────────  // Read-only views into the durable memory store and the MemGraph knowledge
  // graph for the operator UI under /memory. Both endpoints degrade gracefully
  // when their backing store is offline.

  app.get("/api/memory/entries", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const scope = c.req.query("scope") === "user" ? "user" : "workspace";
    try {
      const { listWorkspaceMemoryRecords, listUserMemoryRecords } = await import("../memory/service.js");
      const cfg = (await import("../config/loader.js")).getConfig();
      const records = scope === "user"
        ? listUserMemoryRecords(cfg.workspacePath)
        : listWorkspaceMemoryRecords(cfg.workspacePath);
      const limit = Math.max(1, Math.min(500, Number(c.req.query("limit") ?? 200)));
      const query = (c.req.query("query") ?? "").toLowerCase().trim();
      const filtered = query
        ? records.filter((r) => r.content?.toLowerCase().includes(query)
          || r.subject?.toLowerCase().includes(query)
          || r.key?.toLowerCase().includes(query)
          || (r.tags ?? []).some((t) => t.toLowerCase().includes(query)))
        : records;
      const paged = filtered.slice(0, limit);
      return c.json({ scope, total: filtered.length, returned: paged.length, records: paged });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // ── Memory curation steward ───────────────────────────────────────────────
  // GET  /api/memory/curation — duplicate/stale report + nudge (read-only)
  // POST /api/memory/curate   — compact duplicates (apply)
  app.get("/api/memory/curation", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    try {
      const { computeMemoryCurationReport } = await import("../memory/steward.js");
      const cfg = getConfig();
      return c.json(computeMemoryCurationReport(cfg.workspacePath));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/memory/curate", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    try {
      const { computeMemoryCurationReport } = await import("../memory/steward.js");
      const { compactWorkspaceMemoryRecords } = await import("../memory/service.js");
      const cfg = getConfig();
      const before = computeMemoryCurationReport(cfg.workspacePath);
      const after = compactWorkspaceMemoryRecords(cfg.workspacePath);
      return c.json({ before, after });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/api/graph/labels", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    try {
      const { isGraphDbAvailable, runCypher, toPlainRecords } = await import("../db/neo4j.js");
      if (!isGraphDbAvailable()) return c.json({ available: false, labels: [] });
      const result = await runCypher(`
        MATCH (n)
        UNWIND labels(n) AS label
        RETURN label, count(*) AS count
        ORDER BY count DESC
      `);
      const labels = result ? toPlainRecords(result).map((r) => ({ label: String(r["label"]), count: Number(r["count"] ?? 0) })) : [];
      return c.json({ available: true, labels });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/api/graph/overview", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    try {
      const { isGraphDbAvailable, runCypher, toPlainRecords } = await import("../db/neo4j.js");
      if (!isGraphDbAvailable()) {
        return c.json({ available: false, nodes: [], edges: [], note: "MemGraph is offline. Set MEMGRAPH_URL and start the memgraph service to enable the knowledge-graph view." });
      }
      const labelFilter = (c.req.query("label") ?? "").trim();
      const limit = Math.max(10, Math.min(500, Number(c.req.query("limit") ?? 150)));
      // Pull a label-scoped (or global) sample of nodes plus their immediate
      // neighbours. The visualization is a rendered bird's-eye view, not the
      // full graph — operators that need deeper queries should use graph_query.
      const cypher = labelFilter
        ? `MATCH (n:${labelFilter})
           WITH n LIMIT $limit
           OPTIONAL MATCH (n)-[r]-(m)
           RETURN n, r, m`
        : `MATCH (n)
           WITH n LIMIT $limit
           OPTIONAL MATCH (n)-[r]-(m)
           RETURN n, r, m`;
      const result = await runCypher(cypher, { limit });
      const records = result ? toPlainRecords(result) : [];
      const nodesById = new Map<string, Record<string, unknown>>();
      const edgesByKey = new Map<string, Record<string, unknown>>();
      const captureNode = (raw: unknown): string | undefined => {
        if (!raw || typeof raw !== "object") return undefined;
        const node = raw as { identity?: { toString(): string } | string; labels?: string[]; properties?: Record<string, unknown> };
        const id = typeof node.identity === "object" && node.identity !== null && "toString" in node.identity
          ? (node.identity as { toString(): string }).toString()
          : String(node.identity ?? "");
        if (!id) return undefined;
        if (!nodesById.has(id)) {
          const props = node.properties ?? {};
          const name = typeof (props as { name?: unknown }).name === "string" ? String((props as { name: string }).name) : "";
          nodesById.set(id, {
            id,
            labels: Array.isArray(node.labels) ? node.labels : [],
            name,
            properties: props,
          });
        }
        return id;
      };
      const captureEdge = (raw: unknown, sourceId: string | undefined, targetId: string | undefined): void => {
        if (!raw || typeof raw !== "object" || !sourceId || !targetId) return;
        const rel = raw as { identity?: { toString(): string } | string; type?: string; properties?: Record<string, unknown> };
        const rid = typeof rel.identity === "object" && rel.identity !== null && "toString" in rel.identity
          ? (rel.identity as { toString(): string }).toString()
          : String(rel.identity ?? "");
        const key = rid || `${sourceId}-${rel.type ?? "RELATED"}-${targetId}`;
        if (edgesByKey.has(key)) return;
        edgesByKey.set(key, {
          id: key,
          source: sourceId,
          target: targetId,
          type: rel.type ?? "RELATED",
          properties: rel.properties ?? {},
        });
      };
      for (const row of records) {
        const sourceId = captureNode(row["n"]);
        const targetId = captureNode(row["m"]);
        captureEdge(row["r"], sourceId, targetId);
      }
      return c.json({
        available: true,
        labelFilter: labelFilter || null,
        nodes: Array.from(nodesById.values()),
        edges: Array.from(edgesByKey.values()),
        truncated: nodesById.size >= limit,
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/api/triggers/cron", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    try {
      const { listCronJobs } = await import("../runtime/scheduler.js");
      const jobs = listCronJobs();
      return c.json({ jobs });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
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
      const markdown = await buildSessionDebugMarkdownDetached(sessionId);
      const filename = `starlingai-session-${sessionId.slice(0, 8)}-debug.md`;
      return c.body(markdown, 200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": buildContentDisposition(filename, "attachment"),
      });
    } catch (error) {
      if (error instanceof SessionExportBusyError) {
        return c.json({ error: error.message }, 409);
      }
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
      const markdown = await buildSessionAuditMarkdownDetached(sessionId);
      const filename = `starlingai-session-${sessionId.slice(0, 8)}-audit.md`;
      return c.body(markdown, 200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": buildContentDisposition(filename, "attachment"),
      });
    } catch (error) {
      if (error instanceof SessionExportBusyError) {
        return c.json({ error: error.message }, 409);
      }
      if (error instanceof Error && error.message.includes("Session not found")) {
        return c.json({ error: error.message }, 404);
      }
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  // GET /api/sessions/:sessionId/shared-facts — the swarm's shared session memory
  // (what sub-agents published via share_finding + auto-extracted findings) for a session.
  // Read-only; powers the MemoryInspector "Shared facts" view so a run's evidence is
  // inspectable (e.g. what image_sourcer shared vs. what content_writer embedded).
  app.get("/api/sessions/:sessionId/shared-facts", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const sessionId = c.req.param("sessionId")?.trim();
    if (!sessionId) return c.json({ error: "sessionId is required" }, 400);

    try {
      const sharedSessionId = deriveSharedSessionId(sessionId);
      const facts = await readAllFacts(sharedSessionId);
      // Curated (share_finding) facts first, then auto-extracted `auto_*` findings; each group alphabetical.
      const items = Object.entries(facts)
        .map(([key, value]) => ({ key, value, auto: key.startsWith("auto_") }))
        .sort((a, b) => (a.auto === b.auto ? a.key.localeCompare(b.key) : (a.auto ? 1 : -1)));
      return c.json({ sessionId, sharedSessionId, count: items.length, facts: items });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  // POST /api/sessions/:sessionId/steer — fold a user message into a RUNNING turn
  // (mid-turn steering). Only queues when a turn is actually in flight; returns
  // steered:false otherwise so the client can fall back to sending a normal message.
  app.post("/api/sessions/:sessionId/steer", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const sessionId = c.req.param("sessionId")?.trim();
    if (!sessionId) return c.json({ error: "sessionId is required" }, 400);

    let message = "";
    try {
      const body = await c.req.json() as { message?: unknown };
      message = typeof body?.message === "string" ? body.message : "";
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (!message.trim()) return c.json({ error: "message is required" }, 400);

    const steered = turnSteeringManager.enqueueIfActive(sessionId, message);
    // active mirrors steered here, but expose it explicitly so the client knows
    // whether to fall back to a normal new-message send.
    return c.json({ steered, active: turnSteeringManager.isTurnActive(sessionId) });
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

    const existing = getStoredSiteCredentialRecord(hostname);
    const username = String(body["username"] ?? "").trim() || (existing?.username ?? "");
    const password = String(body["password"] ?? "").trim() || (existing?.password ?? "");
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

  // ── Dialectic user model ──────────────────────────────────────────────────
  app.get("/api/user-model", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const { loadUserModel } = await import("../user-model/service.js");
    return c.json(loadUserModel());
  });

  app.put("/api/user-model", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    try {
      const body = await c.req.json<Record<string, unknown>>();
      const toList = (v: unknown): string[] | undefined =>
        Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : undefined;
      const { updateUserModel } = await import("../user-model/service.js");
      const profile = updateUserModel({
        goals: toList(body["goals"]),
        expertise: toList(body["expertise"]),
        workingStyle: toList(body["workingStyle"]),
        communication: toList(body["communication"]),
        openQuestions: toList(body["openQuestions"]),
        append: body["append"] === true,
        reset: body["reset"] === true,
      }, "user");
      return c.json(profile);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.post("/api/user-model/reset", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const { updateUserModel } = await import("../user-model/service.js");
    return c.json(updateUserModel({ reset: true }, "user"));
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

    // Run identity: an authenticated operator's dropdown run executes under THEIR
    // username, so per-user RBAC-scoped resources (site credentials with
    // allowedUsers, mail accounts) resolve exactly as if they ran the scene from
    // chat. Webhook-key triggers have no user → fall back to the scene identity
    // (which only resolves credentials that aren't user-scoped).
    const triggeredBy = bearerToken ? await authenticatedUser(c.req.header("Authorization")) : null;
    const runUserId = triggeredBy?.username ?? `scene:${sceneName}`;

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
      userId: runUserId,
      task,
      allowedAgents: scene.allowedAgents,
      humanInLoopSteps: scene.humanInLoopSteps,
      approvalChannel: scene.approvalChannel,
      approvalTimeoutMs: scene.approvalTimeoutMs,
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

    // Run identity: authenticated operator → their username (per-user RBAC
    // resolves their credentials); webhook key → synthetic job identity.
    const triggeredBy = bearerToken ? await authenticatedUser(c.req.header("Authorization")) : null;
    const runUserId = triggeredBy?.username ?? `job:${jobName}`;

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
      userId: runUserId,
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

  // Dashboard surface: list every pending approval so an authenticated operator
  // can respond from the UI (not just via the Slack/webhook callback links).
  // Covers detached scene/job runs triggered from the dropdown.
  app.get("/api/approvals/pending", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    return c.json(listPendingApprovals());
  });

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
    const bearer = extractBearerToken(c.req.header("Authorization")) ?? "";

    const pending = getPendingApproval(id);
    if (!pending) return c.json({ error: "Approval request not found or already resolved" }, 404);

    // Two ways to authorize: the channel secret (Slack/webhook callbacks), OR a
    // valid operator JWT (the dashboard — so detached scene/job runs can be
    // approved from the UI without knowing the per-approval secret).
    const operatorAuthed = bearer && await verifyToken(bearer);
    if (!operatorAuthed && pending.secret && pending.secret !== (bodySecret || bearer)) {
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

  // DELETE /api/scenes/jobs/:jobId — remove a finished scene-job execution row
  // from the store (operator cleanup of completed/failed/cancelled runs). The
  // store rejects deletion of active jobs (queued/running/cancelling) — cancel
  // them first; the session transcript itself is unaffected.
  app.delete("/api/scenes/jobs/:jobId", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const jobId = c.req.param("jobId");
    const existing = await getExecutionJob(jobId);
    if (!existing) return c.json({ error: `Job not found: ${jobId}` }, 404);
    if (existing.status === "queued" || existing.status === "running" || existing.status === "cancelling") {
      return c.json({ error: `Cannot delete an active job (status=${existing.status}). Cancel it first.` }, 409);
    }
    const deleted = await deleteSceneJob(jobId);
    if (!deleted) return c.json({ error: `Job could not be deleted (it may have transitioned back to active or already been removed).` }, 409);
    return c.json({ ok: true, deletedJobId: jobId });
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
    const globalConcurrency = getGlobalConcurrencySnapshot();
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
      globalConcurrency,
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

  // ── Browser-session routes (noVNC live preview + human handoff) ──────────────
  // The live pixels travel over the authenticated WS proxy at /ws/browser-vnc/:id
  // (wired in the upgrade dispatcher below); these REST routes carry the state:
  // which sessions are live, which are waiting on a human, and the operator's
  // "I solved it — continue" resolution.

  // Tells the dashboard whether to offer the browser preview at all (a backend
  // must be reachable) without leaking the internal target.
  app.get("/api/browser-sessions/config", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const enabled = browserSessionManager.isEnabled();
    // Probe the backend only when the feature is configured at all — saves a
    // pointless TCP attempt when the env var is empty.
    const reachable = enabled ? await browserSessionManager.pingBackend() : false;
    return c.json({ enabled, reachable });
  });

  app.get("/api/browser-sessions", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    return c.json(browserSessionManager.listSessions());
  });

  app.get("/api/browser-sessions/active", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    return c.json(browserSessionManager.listActiveSessions());
  });

  app.get("/api/browser-sessions/:id", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const session = browserSessionManager.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "Session not found" }, 404);
    return c.json(session);
  });

  // Operator clicked "I solved it — continue" — unblocks the waiting agent.
  app.post("/api/browser-sessions/:id/resolve-assist", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const user = await authenticatedUser(c.req.header("Authorization"));
    const ok = browserSessionManager.resolveAssist(c.req.param("id"), user?.username ?? "operator");
    if (!ok) return c.json({ error: "Session not found" }, 404);
    return c.json({ ok: true });
  });

  // ── Long-running-generation routes ──────────────────────────────────────────
  // Surface paused sub-agent runs to the dashboard and accept the operator's
  // decision (continue / unbounded / stop). See
  // agent/long-running-generation.ts for the failure mode this addresses.
  app.get("/api/long-running/active", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    return c.json(longRunningGenerationManager.listPending());
  });

  app.post("/api/long-running/:id/respond", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    let body: { outcome?: unknown };
    try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
    const outcome = typeof body.outcome === "string" ? body.outcome : "";
    if (outcome !== "continue" && outcome !== "unbounded" && outcome !== "stop") {
      return c.json({ error: "outcome must be one of: continue, unbounded, stop" }, 400);
    }
    const user = await authenticatedUser(c.req.header("Authorization"));
    const resolved = longRunningGenerationManager.resolveRequest(
      c.req.param("id"),
      outcome,
      user?.username ?? "operator",
    );
    if (!resolved) return c.json({ error: "Request not found or already resolved" }, 404);
    return c.json({ ok: true, request: resolved });
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

    // ── Federation streaming delegate ────────────────────────────────────────
    // Auth handled inside the helper (HMAC bearer, NOT user JWT).  Returns
    // true when matched + handled so we short-circuit before hitting Hono.
    if (await handleFederationDelegateStream(req, res)) {
      return;
    }

    // ── Outbound MCP server (HTTP/SSE) ───────────────────────────────────────
    // Mounted at /mcp.  Handler enforces auth + transport dispatch; returns
    // true when the request belongs to MCP so we never hit Hono with it.
    if (await handleMcpHttpRequest(req, res)) {
      return;
    }

    // ── Public A2A protocol — agent card + JSON-RPC /a2a/v1 ───────────────
    // Note: this is the *public* A2A surface.  The internal `/a2a/agents/:name`
    // path below is the legacy in-process A2A and stays for backward compat.
    {
      const { handleA2ARequest } = await import("../a2a/server.js");
      if (await handleA2ARequest(req, res)) {
        return;
      }
    }

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

  // Two WebSocket surfaces share the one HTTP server: the RPC channel at /ws and
  // the noVNC proxy at /ws/browser-vnc/:id. Both use `noServer` and a single
  // upgrade dispatcher below — a `server`-bound WSS with a fixed `path` would
  // `abortHandshake` (destroy the socket) on any non-matching path, so the two
  // surfaces can't each bind the same server with different paths.
  const wss = new WebSocketServer({ noServer: true });
  const vncWss = new WebSocketServer({
    noServer: true,
    // Echo a subprotocol so older noVNC clients (which require "binary") connect;
    // newer clients offer none and we reply with none.
    handleProtocols: (protocols: Set<string>) =>
      (protocols.has("binary") ? "binary" : (protocols.values().next().value ?? false)),
  });

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

  // ── noVNC proxy ──────────────────────────────────────────────────────────────
  // The embedded @novnc client connects here; we authenticate the operator, then
  // bridge raw RFB frames to websockify inside the browser-vnc container. This
  // keeps port 6080 off the host — the live browser is reachable only *through*
  // the gateway's auth.
  vncWss.on("connection", (clientWs: WebSocket, req: IncomingMessage) => {
    const target = browserSessionManager.getVncTarget();
    if (!target) { clientWs.close(4404, "Browser preview not configured"); return; }

    const protoHeader = (req.headers["sec-websocket-protocol"] as string | undefined) ?? "";
    const protocols = protoHeader.split(",").map((s) => s.trim()).filter(Boolean);
    const backendUrl = `ws://${target.host}:${target.port}${target.path}`;
    const backendWs = new WebSocket(backendUrl, protocols.length ? protocols : undefined);

    const queue: unknown[] = [];
    const closeBoth = () => {
      try { if (clientWs.readyState === WebSocket.OPEN) clientWs.close(); } catch { /* noop */ }
      try { if (backendWs.readyState === WebSocket.OPEN || backendWs.readyState === WebSocket.CONNECTING) backendWs.close(); } catch { /* noop */ }
    };

    backendWs.on("open", () => {
      for (const buf of queue) backendWs.send(buf as Buffer, { binary: true });
      queue.length = 0;
    });
    backendWs.on("message", (data, isBinary) => {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data, { binary: isBinary });
    });
    clientWs.on("message", (data, isBinary) => {
      if (backendWs.readyState === WebSocket.OPEN) backendWs.send(data, { binary: isBinary });
      else if (backendWs.readyState === WebSocket.CONNECTING) queue.push(data);
    });

    backendWs.on("close", closeBoth);
    clientWs.on("close", closeBoth);
    backendWs.on("error", (err) => { log.warn({ err, backendUrl }, "noVNC backend error"); closeBoth(); });
    clientWs.on("error", () => closeBoth());
  });

  // ── WS upgrade dispatcher ────────────────────────────────────────────────────
  // Routes the HTTP upgrade to the right WSS by path, after auth for the VNC
  // surface (browsers can't set headers on a WS handshake, so the token rides in
  // ?token=). Unknown paths are rejected so stray upgrades don't hang.
  httpServer.on("upgrade", async (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    if (pathname === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
      return;
    }

    if (pathname.startsWith("/ws/browser-vnc")) {
      const ip = req.socket.remoteAddress ?? "unknown";
      const token = url.searchParams.get("token") ?? extractBearerToken(req.headers["authorization"]);
      const rl = checkAuthRateLimit(ip);
      if (!rl.allowed) { socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n"); socket.destroy(); return; }
      if (!token || !await verifyToken(token)) {
        recordAuthFailure(ip);
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      clearAuthFailures(ip);
      vncWss.handleUpgrade(req, socket, head, (ws) => vncWss.emit("connection", ws, req));
      return;
    }

    socket.destroy();
  });

  return {
    async start(): Promise<void> {
      // Docker reachability gate. When the operator has enabled
      // agents.defaultContainerized, sub-agents will be expected to run inside
      // Docker by default. If Docker is unreachable, refusing to start is the
      // only safe choice — silently falling back to in-process execution would
      // erase the isolation guarantee the operator turned the flag on for.
      if (config.agents.defaultContainerized) {
        const probe = await probeDockerReachability();
        if (!probe.reachable) {
          const msg = `agents.defaultContainerized is true but Docker is unreachable (${probe.error ?? "unknown"}). ` +
            `Refusing to start — sub-agents would silently fall back to in-process execution. ` +
            `Either start Docker, set agents.defaultContainerized to false explicitly, or mark each agent with container.disabled: true.`;
          log.error({ probe }, msg);
          throw new Error(msg);
        }
        log.info({ serverVersion: probe.serverVersion, durationMs: probe.durationMs },
          "Docker reachable — defaultContainerized sub-agents enabled");
      }

      const port = config.gateway.port;
      return new Promise<void>((resolve, reject) => {
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
        for (const client of vncWss.clients) {
          client.terminate();
        }

        wss.close();
        vncWss.close();
        httpServer.close(() => resolve());
        httpServer.closeAllConnections?.();
      });
    },
  };
}
