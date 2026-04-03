import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { useStorage } from "@vueuse/core";
import { useAuditStore } from "./audit";
import { useComputerStore } from "./computer";
import { useNotificationStore } from "./notifications";

export interface TurnUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface TurnPerf {
  turnDurationMs: number;
  llmCalls: number;
  llmTimeMs: number;
  toolIterations: number;
  finishReason: string;
}

export interface InterventionAction {
  kind: "stop_turn" | "new_session" | "request_approval";
  label: string;
  prompt?: string;
}

export interface InterventionNotice {
  reasonCode: string;
  severity: "warn" | "error";
  summary: string;
  detail: string;
  toolName?: string;
  actions: InterventionAction[];
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
  attachments?: Array<{
    filename: string;
    dataUrl?: string;
    relativePath?: string;
    contentType?: string;
    previewMode?: "image" | "html" | "pdf" | "text" | "json" | "audio" | "download";
    size?: number;
    isDirectory?: boolean;
    title?: string;
    sourceTool?: string;
  }>;
  toolCalls?: Array<{ id?: string; name: string; args: Record<string, unknown>; result?: string; metadata?: Record<string, unknown> }>;
  guardrailEvents?: Array<{ type: string; details: string }>;
  blocked?: boolean;
  swarmState?: SwarmState;
  usage?: TurnUsage;
  perf?: TurnPerf;
}

export interface SwarmTaskAttempt {
  agentName: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  finishedAt?: string;
  summary?: string;
  toolCount?: number;
  iterations?: number;
  toolNames?: string[];
}

export interface SwarmTaskState {
  id: string;
  title: string;
  status: "pending" | "running" | "completed" | "failed" | "blocked";
  dependsOn: string[];
  selectedAgent?: string;
  attempts: SwarmTaskAttempt[];
  output?: string;
  error?: string;
}

export interface SwarmState {
  objective: string;
  startedAt: string;
  updatedAt: string;
  tasks: Record<string, SwarmTaskState>;
}

export interface SwarmRunRecord {
  id: string;
  sessionId: string;
  status: "ok" | "blocked" | "error";
  recordedAt: string;
  state: SwarmState;
}

export interface SwarmSessionHistory {
  sessionId: string;
  runCount: number;
  lastRecordedAt: string;
  lastStatus: SwarmRunRecord["status"];
  lastObjective: string;
}

export interface GatewaySession {
  id: string;
  channel: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  turns: number;
  messageCount: number;
  lastMessageAt?: string;
  preview?: string;
}

export interface GatewaySessionTranscriptMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  toolCalls?: Array<{ id?: string; name: string; args: Record<string, unknown>; result?: string; metadata?: Record<string, unknown> }>;
}

export interface GatewaySessionTranscript {
  session: GatewaySession;
  transcript: GatewaySessionTranscriptMessage[];
  totalMessages: number;
  nextBeforeMessageId?: string;
}

const SESSION_TRANSCRIPT_PAGE_SIZE = 100;
const CONNECT_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 25_000;
const HEARTBEAT_RPC_TIMEOUT_MS = 8_000;
const RECONNECT_DELAY_MS = 3_000;
const LEGACY_DIRECT_GATEWAY_WS_URL = "ws://localhost:8765/ws";

export function defaultGatewayWsUrl(): string {
  if (typeof window === "undefined") {
    return LEGACY_DIRECT_GATEWAY_WS_URL;
  }

  const { protocol, host } = window.location;
  if (!host || protocol === "file:") {
    return LEGACY_DIRECT_GATEWAY_WS_URL;
  }

  const wsProtocol = protocol === "https:" ? "wss:" : "ws:";
  return `${wsProtocol}//${host}/ws`;
}

function normalizeGatewayWsUrl(raw: string | null | undefined): string {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === LEGACY_DIRECT_GATEWAY_WS_URL) {
    return defaultGatewayWsUrl();
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
    }
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      return defaultGatewayWsUrl();
    }
    if (!parsed.pathname || parsed.pathname === "/") {
      parsed.pathname = "/ws";
    }
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

export interface FileToMarkdownResult {
  success: boolean;
  markdown?: string;
  title?: string;
  filename?: string;
  error?: string;
}

export interface SpeechToTextResult {
  text: string;
  language?: string;
  duration?: number;
}

export interface SavedTtsVoiceResult {
  status: string;
  voice_id: string;
  name: string;
  ref_text?: string;
  processing_time?: number;
}

export interface SceneInfo {
  name: string;
  description: string;
}

export interface ChatAttachment {
  filename: string;
  dataUrl?: string;
  relativePath?: string;
  contentType?: string;
  previewMode?: "image" | "html" | "pdf" | "text" | "json" | "audio" | "download";
  size?: number;
  isDirectory?: boolean;
  title?: string;
  sourceTool?: string;
}

function cloneToolCalls(toolCalls: ChatMessage["toolCalls"]): ChatMessage["toolCalls"] {
  if (!toolCalls?.length) return undefined;
  return toolCalls.map((toolCall) => ({
    ...toolCall,
    args: { ...(toolCall.args ?? {}) },
    metadata: toolCall.metadata && typeof toolCall.metadata === "object"
      ? { ...toolCall.metadata }
      : undefined,
  }));
}

function cloneAttachments(attachments: ChatMessage["attachments"]): ChatMessage["attachments"] {
  if (!attachments?.length) return undefined;
  return attachments.map((attachment) => ({ ...attachment }));
}

function cloneGuardrailEvents(events: ChatMessage["guardrailEvents"]): ChatMessage["guardrailEvents"] {
  if (!events?.length) return undefined;
  return events.map((event) => ({ ...event }));
}

function normalizeHydratedMessages(input: ChatMessage[]): ChatMessage[] {
  const normalized: ChatMessage[] = [];

  for (const entry of input) {
    const message: ChatMessage = {
      ...entry,
      timestamp: new Date(entry.timestamp),
      attachments: cloneAttachments(entry.attachments),
      toolCalls: cloneToolCalls(entry.toolCalls),
      guardrailEvents: cloneGuardrailEvents(entry.guardrailEvents),
    };
    const previous = normalized[normalized.length - 1];

    if (previous?.role === "assistant" && message.role === "assistant") {
      previous.id = message.id;
      previous.timestamp = message.timestamp;
      previous.toolCalls = [
        ...(previous.toolCalls ?? []),
        ...(message.toolCalls ?? []),
      ];
      previous.attachments = [
        ...(previous.attachments ?? []),
        ...(message.attachments ?? []),
      ];
      previous.guardrailEvents = [
        ...(previous.guardrailEvents ?? []),
        ...(message.guardrailEvents ?? []),
      ];
      previous.blocked = previous.blocked || message.blocked;
      previous.swarmState = message.swarmState ?? previous.swarmState;
      previous.usage = message.usage ?? previous.usage;
      previous.perf = message.perf ?? previous.perf;
      if (message.content.trim()) {
        previous.content = message.content;
      }
      continue;
    }

    normalized.push(message);
  }

  return normalized;
}

const THINKING_BLOCK_RE = /<(thinking|think)>[\s\S]*?<\/(thinking|think)>/gi;
const NARRATED_TOOL_TEXT_RE = /<tool_call>|<function=|<parameter=|\[Tool:/i;
const EXECUTION_CHATTER_START_RE = /^\s*(let me|now let me|first let me|i(?:'m| am) going to|i(?:'ll| will)|i found some useful information|let me fetch|let me search|now let me create|now i can)\b/i;

function stripNarratedToolTags(text: string): string {
  return text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/<function=[^>]*>[\s\S]*?<\/function>/gi, "")
    .replace(/<parameter=[^>]*>[\s\S]*?<\/parameter>/gi, "")
    .replace(/<\/?tool_call>/gi, "")
    .trim();
}

export function sanitizeAssistantMessageContent(
  content: string | null | undefined,
  toolCalls?: Array<unknown>,
): string {
  const raw = typeof content === "string" ? content.trim() : "";
  if (!raw) return "";

  let cleaned = stripNarratedToolTags(raw)
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("[Tool:"))
    .join("\n")
    .trim();

  if (!cleaned) return "";

  if (NARRATED_TOOL_TEXT_RE.test(raw) || (toolCalls?.length ?? 0) > 0) {
    cleaned = cleaned
      .split(/\n\s*\n/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean)
      .filter((paragraph) => !EXECUTION_CHATTER_START_RE.test(paragraph))
      .join("\n\n")
      .trim();
  }

  return cleaned;
}

function inferContentTypeFromPath(path: string): string {
  const normalized = path.toLowerCase();
  if (normalized.endsWith(".html") || normalized.endsWith(".htm")) return "text/html; charset=utf-8";
  if (normalized.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (normalized.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (normalized.endsWith(".json")) return "application/json; charset=utf-8";
  if (normalized.endsWith(".pdf")) return "application/pdf";
  if (normalized.endsWith(".png")) return "image/png";
  if (normalized.endsWith(".jpg") || normalized.endsWith(".jpeg")) return "image/jpeg";
  if (normalized.endsWith(".gif")) return "image/gif";
  if (normalized.endsWith(".webp")) return "image/webp";
  if (normalized.endsWith(".svg")) return "image/svg+xml";
  if (normalized.endsWith(".wav")) return "audio/wav";
  if (normalized.endsWith(".mp3")) return "audio/mpeg";
  if (normalized.endsWith(".m4a")) return "audio/mp4";
  if (normalized.endsWith(".ogg")) return "audio/ogg";
  if (normalized.endsWith(".webm")) return "audio/webm";
  return "application/octet-stream";
}

function inferPreviewMode(contentType: string): ChatAttachment["previewMode"] {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType.startsWith("text/html")) return "html";
  if (contentType.startsWith("application/pdf")) return "pdf";
  if (contentType.startsWith("application/json")) return "json";
  if (contentType.startsWith("text/")) return "text";
  return "download";
}

function filenameFromRelativePath(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function extractToolAttachments(name: string, metadata: unknown): ChatAttachment[] {
  if (!metadata || typeof metadata !== "object") {
    return [];
  }

  const value = metadata as Record<string, unknown>;
  const outputPath = typeof value["outputPath"] === "string" ? value["outputPath"] : "";
  const dataUrl = typeof value["dataUrl"] === "string" ? value["dataUrl"] : undefined;
  const filename = typeof value["filename"] === "string"
    ? value["filename"]
    : outputPath
      ? filenameFromRelativePath(outputPath)
      : dataUrl
        ? "generated-image.png"
        : "artifact";
  const contentType = typeof value["contentType"] === "string"
    ? value["contentType"]
    : outputPath
      ? inferContentTypeFromPath(outputPath)
      : dataUrl?.startsWith("data:")
        ? dataUrl.slice(5, dataUrl.indexOf(";"))
        : "application/octet-stream";
  const previewMode = typeof value["previewMode"] === "string"
    ? value["previewMode"] as ChatAttachment["previewMode"]
    : inferPreviewMode(contentType);
  const size = typeof value["bytes"] === "number"
    ? value["bytes"]
    : typeof value["size"] === "number"
      ? value["size"]
      : undefined;

  if (!outputPath && !dataUrl) {
    return [];
  }

  if (name === "generate_image" && dataUrl?.startsWith("data:image/")) {
    return [{
      filename,
      dataUrl,
      relativePath: outputPath || undefined,
      contentType,
      previewMode: "image",
      size,
      title: typeof value["title"] === "string" ? value["title"] : undefined,
      sourceTool: name,
    }];
  }

  return [{
    filename,
    dataUrl,
    relativePath: outputPath || undefined,
    contentType,
    previewMode,
    size,
    isDirectory: value["isDirectory"] === true,
    title: typeof value["title"] === "string" ? value["title"] : undefined,
    sourceTool: name,
  }];
}

function extractCompletedThinkingBlocks(text: string): string {
  return (text.match(THINKING_BLOCK_RE) ?? []).join("\n\n").trim();
}

function mergeFinalAssistantContent(response: unknown, streamedText: string, toolCalls?: ChatMessage["toolCalls"]): string {
  const finalResponse = String(response ?? "").trim();
  if (/<(thinking|think)>/i.test(finalResponse)) {
    return finalResponse;
  }

  const completedThinking = extractCompletedThinkingBlocks(streamedText);
  if (!completedThinking) {
    return sanitizeAssistantMessageContent(finalResponse, toolCalls) || finalResponse;
  }

  const merged = [completedThinking, finalResponse].filter(Boolean).join("\n\n");
  return sanitizeAssistantMessageContent(merged, toolCalls) || merged;
}

function buildAcceptedStatusMessage(data: Record<string, unknown>): string | null {
  const segments: string[] = [];
  const info = typeof data["info"] === "string" ? data["info"].trim() : "";
  if (info) {
    segments.push(info);
  }

  const activeFlags = data["activeFlags"];
  if (activeFlags && typeof activeFlags === "object") {
    const flags = activeFlags as Record<string, unknown>;
    const labels: string[] = [];
    if (flags["autoApprove"] === true) labels.push("auto-approve");
    if (typeof flags["maxIterations"] === "number") labels.push(`iter ${flags["maxIterations"]}`);
    if (typeof flags["agent"] === "string" && flags["agent"].trim()) labels.push(`agent ${flags["agent"].trim()}`);
    if (typeof flags["timeout"] === "number") labels.push(`timeout ${flags["timeout"]}s`);
    if (labels.length > 0) {
      segments.push(`Active overrides: ${labels.join(", ")}`);
    }
  }

  if (segments.length === 0) {
    return null;
  }

  return segments.join("\n");
}

export const useGatewayStore = defineStore("gateway", () => {
  const audit = useAuditStore();
  const notifications = useNotificationStore();
  const token = useStorage<string>("gc_token", "");
  const wsUrl = useStorage<string>("gc_ws_url", defaultGatewayWsUrl());
  const swarmRunsBySession = useStorage<Record<string, SwarmRunRecord[]>>("gc_swarm_runs", {});

  wsUrl.value = normalizeGatewayWsUrl(wsUrl.value);

  const connected = ref(false);
  const connecting = ref(false);
  const currentSessionId = useStorage<string | null>("gc_current_session_id", null);
  const sessions = ref<GatewaySession[]>([]);
  const scenes = ref<SceneInfo[]>([]);
  const messages = ref<ChatMessage[]>([]);
  const currentSessionTranscriptTotalMessages = ref(0);
  const currentSessionTranscriptNextBeforeMessageId = ref<string | null>(null);
  const currentSessionTranscriptLoading = ref(false);
  const pendingRequestId = ref<string | null>(null);
  const streamingText = ref("");
  const liveSwarmState = ref<SwarmState | null>(null);
  const selectedSwarmRunId = ref<string | null>(null);
  const isStreaming = ref(false);   // true while text chunks are arriving
  const isError = ref(false);       // true when last turn ended in an error
  const authFailed = ref(false);    // true when connection was rejected due to bad token
  const pendingIntervention = ref<InterventionNotice | null>(null);

  interface PendingRpc {
    resolve: (payload: unknown) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }

  interface PendingApproval {
    approvalId: string;
    requestId: string;
    toolName: string;
    args: Record<string, unknown>;
  }
  const pendingApproval = ref<PendingApproval | null>(null);
  const notificationsSubscribed = ref(false);

  let ws: WebSocket | null = null;
  const pendingRpcs = new Map<string, PendingRpc>();
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let connectTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatInFlight = false;
  let lifecycleHooksInstalled = false;
  let consecutiveReconnects = 0;
  const MAX_RECONNECT_ATTEMPTS = 12;
  const MAX_RECONNECT_DELAY_MS = 30_000;

  function clearReconnectTimer(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function clearConnectTimeout(): void {
    if (connectTimeoutTimer) {
      clearTimeout(connectTimeoutTimer);
      connectTimeoutTimer = null;
    }
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    heartbeatInFlight = false;
  }

  function closeActiveSocket(reason?: string): void {
    const activeSocket = ws;
    if (!activeSocket) return;
    ws = null;
    try {
      activeSocket.close(4000, reason);
    } catch {
      activeSocket.close();
    }
  }

  function scheduleReconnect(delayMs?: number): void {
    if (reconnectTimer || !token.value || authFailed.value) return;
    if (consecutiveReconnects >= MAX_RECONNECT_ATTEMPTS) {
      console.warn(`[gateway] gave up reconnecting after ${MAX_RECONNECT_ATTEMPTS} attempts`);
      return;
    }
    const backoff = delayMs ?? Math.min(
      RECONNECT_DELAY_MS * Math.pow(1.5, consecutiveReconnects),
      MAX_RECONNECT_DELAY_MS,
    );
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!token.value || authFailed.value || connected.value || connecting.value) return;
      consecutiveReconnects++;
      connect();
    }, backoff);
  }

  function installLifecycleHooks(): void {
    if (lifecycleHooksInstalled || typeof window === "undefined") return;
    lifecycleHooksInstalled = true;

    const resumeConnection = () => {
      if (!token.value || authFailed.value) return;
      if (connected.value || connecting.value) return;
      connect();
    };

    window.addEventListener("online", resumeConnection);
    window.addEventListener("focus", resumeConnection);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        resumeConnection();
      }
    });
  }

  function startHeartbeat(): void {
    stopHeartbeat();
    heartbeatTimer = setInterval(async () => {
      if (!connected.value || !ws || ws.readyState !== WebSocket.OPEN) return;
      if (pendingRequestId.value || heartbeatInFlight) return;
      heartbeatInFlight = true;
      try {
        await rpc("gateway.status", undefined, HEARTBEAT_RPC_TIMEOUT_MS);
      } catch {
        stopHeartbeat();
        closeActiveSocket("Heartbeat timeout");
        connected.value = false;
        connecting.value = false;
        rejectPendingRpcs("Heartbeat timeout");
        scheduleReconnect();
      } finally {
        heartbeatInFlight = false;
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  function rejectPendingRpcs(message: string): void {
    for (const [id, pendingRpc] of pendingRpcs) {
      clearTimeout(pendingRpc.timeout);
      pendingRpc.reject(new Error(message));
      pendingRpcs.delete(id);
    }
  }

  async function parseErrorResponse(response: Response): Promise<string> {
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.includes("application/json")) {
      try {
        const body = await response.json() as Record<string, unknown>;
        return String(body["error"] ?? body["detail"] ?? response.statusText ?? `HTTP ${response.status}`);
      } catch {
        return response.statusText || `HTTP ${response.status}`;
      }
    }

    try {
      const text = (await response.text()).trim();
      if (!text) return response.statusText || `HTTP ${response.status}`;
      if (text.startsWith("<!DOCTYPE") || text.startsWith("<html")) {
        return "Received HTML instead of JSON from the gateway. Check the web server API proxy and configured gateway URL.";
      }
      return text.slice(0, 240);
    } catch {
      return response.statusText || `HTTP ${response.status}`;
    }
  }

  function parseContentDispositionFilename(headerValue: string | null): string | null {
    if (!headerValue) return null;

    const utf8Match = headerValue.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8Match?.[1]) {
      try {
        return decodeURIComponent(utf8Match[1]);
      } catch {
        return utf8Match[1];
      }
    }

    const plainMatch = headerValue.match(/filename="?([^";]+)"?/i);
    return plainMatch?.[1] ?? null;
  }

  function restBaseUrl(): string {
    const parsed = new URL(normalizeGatewayWsUrl(wsUrl.value));
    parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
    parsed.pathname = parsed.pathname.replace(/\/ws$/, "");
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  }

  async function authorizedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers ?? {});
    if (token.value) headers.set("Authorization", `Bearer ${token.value}`);
    const response = await fetch(`${restBaseUrl()}${path}`, {
      ...init,
      headers,
    });
    if (!response.ok) {
      const message = await parseErrorResponse(response);
      throw new Error(message);
    }
    return response;
  }

  function normalizeSwarmState(raw: unknown): SwarmState | null {
    if (!raw || typeof raw !== "object") return null;
    const value = raw as Record<string, unknown>;
    if (typeof value["objective"] !== "string") return null;
    const tasks = typeof value["tasks"] === "object" && value["tasks"] !== null
      ? value["tasks"] as Record<string, SwarmTaskState>
      : {};
    return {
      objective: String(value["objective"]),
      startedAt: String(value["startedAt"] ?? ""),
      updatedAt: String(value["updatedAt"] ?? ""),
      tasks,
    };
  }

  function attachSwarmStateToMessage(messageId: string, swarmState: SwarmState | null) {
    if (!swarmState) return;
    const message = messages.value.find((entry) => entry.id === messageId);
    if (message) {
      message.swarmState = swarmState;
    }
  }

  function cloneSwarmState(swarmState: SwarmState): SwarmState {
    return structuredClone(swarmState);
  }

  function appendSwarmRun(status: SwarmRunRecord["status"], swarmState: SwarmState | null) {
    if (!swarmState || !currentSessionId.value) return;
    const sessionId = currentSessionId.value;
    const previous = swarmRunsBySession.value[sessionId] ?? [];
    const next: SwarmRunRecord = {
      id: crypto.randomUUID(),
      sessionId,
      status,
      recordedAt: new Date().toISOString(),
      state: cloneSwarmState(swarmState),
    };
    swarmRunsBySession.value = {
      ...swarmRunsBySession.value,
      [sessionId]: [...previous, next].slice(-20),
    };
    selectedSwarmRunId.value = next.id;
  }

  function selectSwarmRun(runId: string | null) {
    selectedSwarmRunId.value = runId;
  }

  function getSwarmRuns(sessionId: string | null): SwarmRunRecord[] {
    if (!sessionId) return [];
    return swarmRunsBySession.value[sessionId] ?? [];
  }

  function failPendingTurn(errorText: string, preservePendingState = false) {
    const idx = messages.value.findIndex(m => m.id === "streaming");
    const errorMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: `⚠️ ${errorText}`,
      timestamp: new Date(),
      blocked: true,
      swarmState: liveSwarmState.value ?? undefined,
    };

    if (!preservePendingState) {
      if (idx >= 0) messages.value.splice(idx, 1, errorMsg);
      else messages.value.push(errorMsg);
      streamingText.value = "";
      pendingRequestId.value = null;
      pendingApproval.value = null;
      pendingIntervention.value = null;
      isStreaming.value = false;
      appendSwarmRun("error", liveSwarmState.value);
      liveSwarmState.value = null;
    }

    isError.value = true;
    setTimeout(() => { isError.value = false; }, 5000);
  }

  function resetLocalSessionState() {
    messages.value = [];
    currentSessionTranscriptTotalMessages.value = 0;
    currentSessionTranscriptNextBeforeMessageId.value = null;
    currentSessionTranscriptLoading.value = false;
    streamingText.value = "";
    pendingRequestId.value = null;
    pendingApproval.value = null;
    pendingIntervention.value = null;
    liveSwarmState.value = null;
    isStreaming.value = false;
    selectedSwarmRunId.value = null;
  }

  function mapTranscriptMessages(transcript: GatewaySessionTranscriptMessage[]): ChatMessage[] {
    return normalizeHydratedMessages(transcript.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.role === "assistant"
        ? sanitizeAssistantMessageContent(message.content, message.toolCalls)
        : message.content,
      timestamp: new Date(message.timestamp),
      toolCalls: message.toolCalls,
      attachments: (message.toolCalls ?? []).flatMap((toolCall) => extractToolAttachments(toolCall.name, toolCall.metadata)),
    })));
  }

  function hydrateTranscript(transcript: GatewaySessionTranscriptMessage[]) {
    messages.value = mapTranscriptMessages(transcript);
  }

  function getStreamingMessage(): ChatMessage | undefined {
    return messages.value.find((entry) => entry.id === "streaming");
  }

  function insertSystemFeedbackMessage(content: string): void {
    const trimmed = content.trim();
    if (!trimmed) return;

    const systemMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "system",
      content: trimmed,
      timestamp: new Date(),
    };

    const streamingIndex = messages.value.findIndex((entry) => entry.id === "streaming");
    if (streamingIndex >= 0) {
      messages.value.splice(streamingIndex, 0, systemMessage);
      return;
    }

    messages.value.push(systemMessage);
  }

  function applyCurrentSessionRunSelection(sessionId: string | null) {
    const existingRuns = sessionId ? (swarmRunsBySession.value[sessionId] ?? []) : [];
    selectedSwarmRunId.value = existingRuns[existingRuns.length - 1]?.id ?? null;
  }

  async function refreshSessions(): Promise<GatewaySession[]> {
    const result = await rpc("session.list") as GatewaySession[];
    sessions.value = result;

    // Prune swarmRunsBySession for sessions the server no longer knows about
    const knownIds = new Set(result.map(s => s.id));
    const storedKeys = Object.keys(swarmRunsBySession.value);
    if (storedKeys.length > knownIds.size + 10) {
      const pruned: Record<string, SwarmRunRecord[]> = {};
      for (const key of storedKeys) {
        if (knownIds.has(key)) pruned[key] = swarmRunsBySession.value[key];
      }
      swarmRunsBySession.value = pruned;
    }

    return result;
  }

  async function getSessionTranscript(
    sessionId: string,
    options: { limit?: number; beforeMessageId?: string } = {},
  ): Promise<GatewaySessionTranscript> {
    return await rpc("session.get", {
      sessionId,
      ...(options.limit ? { limit: options.limit } : {}),
      ...(options.beforeMessageId ? { beforeMessageId: options.beforeMessageId } : {}),
    }) as GatewaySessionTranscript;
  }

  async function loadSession(sessionId: string, allowArchived = false): Promise<void> {
    currentSessionTranscriptLoading.value = true;
    try {
      const result = await getSessionTranscript(sessionId, { limit: SESSION_TRANSCRIPT_PAGE_SIZE });
      // Guard: if the user switched sessions while we were loading, discard.
      if (currentSessionId.value !== null && currentSessionId.value !== sessionId) return;
      if (!allowArchived && result.session.archivedAt) {
        throw new Error("Archived sessions cannot be resumed");
      }
      currentSessionId.value = result.session.archivedAt ? null : sessionId;
      currentSessionTranscriptTotalMessages.value = result.totalMessages;
      currentSessionTranscriptNextBeforeMessageId.value = result.nextBeforeMessageId ?? null;
      hydrateTranscript(result.transcript);
      applyCurrentSessionRunSelection(currentSessionId.value ?? sessionId);
    } finally {
      currentSessionTranscriptLoading.value = false;
    }
  }

  async function switchSession(sessionId: string): Promise<void> {
    await loadSession(sessionId);
  }

  async function loadOlderCurrentSessionTranscript(): Promise<void> {
    const sessionId = currentSessionId.value;
    const beforeMessageId = currentSessionTranscriptNextBeforeMessageId.value;
    if (!sessionId || !beforeMessageId || currentSessionTranscriptLoading.value) {
      return;
    }

    currentSessionTranscriptLoading.value = true;
    try {
      const result = await getSessionTranscript(sessionId, {
        limit: SESSION_TRANSCRIPT_PAGE_SIZE,
        beforeMessageId,
      });
      if (currentSessionId.value !== sessionId) {
        return;
      }

      const existingIds = new Set(messages.value.map((message) => message.id));
      const olderMessages = mapTranscriptMessages(result.transcript)
        .filter((message) => !existingIds.has(message.id));
      messages.value = normalizeHydratedMessages([...olderMessages, ...messages.value]);
      currentSessionTranscriptTotalMessages.value = result.totalMessages;
      currentSessionTranscriptNextBeforeMessageId.value = result.nextBeforeMessageId ?? null;
    } finally {
      currentSessionTranscriptLoading.value = false;
    }
  }

  function connect() {
    installLifecycleHooks();
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    clearReconnectTimer();
    clearConnectTimeout();
    connecting.value = true;
    authFailed.value = false;

    const normalizedWsUrl = normalizeGatewayWsUrl(wsUrl.value);
    wsUrl.value = normalizedWsUrl;
    const url = new URL(normalizedWsUrl);
    url.searchParams.set("token", token.value);
    const socket = new WebSocket(url);
    ws = socket;
    connectTimeoutTimer = setTimeout(() => {
      if (ws !== socket || connected.value) return;
      closeActiveSocket("Connect timeout");
    }, CONNECT_TIMEOUT_MS);

    socket.onopen = () => {
      if (ws !== socket) return;          // stale socket
      connecting.value = true;
    };

    socket.onclose = (ev: CloseEvent) => {
      if (ws !== socket) return;          // stale socket — already replaced
      ws = null;
      connected.value = false;
      connecting.value = false;
      notificationsSubscribed.value = false;
      clearConnectTimeout();
      stopHeartbeat();
      rejectPendingRpcs("Connection closed");

      // Auth failure (4401) or rate-limited (4429) — stop reconnecting
      if (ev.code === 4401 || ev.code === 4429) {
        clearReconnectTimer();
        authFailed.value = true;
        token.value = "";
        return;
      }

      // If a turn was in-flight, surface it as an error — the response is now lost
      if (pendingRequestId.value) {
        failPendingTurn("Connection lost while waiting for a response. Please try again.");
      }
      scheduleReconnect();
    };

    socket.onerror = () => {
      if (ws !== socket) return;
      connecting.value = false;
    };

    socket.onmessage = (event: MessageEvent) => {
      if (ws !== socket) return;
      try {
        const msg = JSON.parse(event.data as string) as Record<string, unknown>;
        handleServerMessage(msg);
      } catch { /* ignore malformed */ }
    };
  }

  async function ensureNotificationSubscription(): Promise<void> {
    if (!connected.value || notificationsSubscribed.value) return;
    try {
      await rpc("notifications.subscribe");
      notificationsSubscribed.value = true;
    } catch {
      notificationsSubscribed.value = false;
    }
  }

  function disconnect() {
    clearReconnectTimer();
    clearConnectTimeout();
    stopHeartbeat();
    rejectPendingRpcs("Disconnected");
    const old = ws;
    ws = null;                            // detach first so old handlers bail out
    old?.close();
    connected.value = false;
    connecting.value = false;
    // Clear stale UI state so reconnect starts clean
    pendingApproval.value = null;
    pendingIntervention.value = null;
    notificationsSubscribed.value = false;
    liveSwarmState.value = null;
    isStreaming.value = false;
  }

  function handleServerMessage(msg: Record<string, unknown>) {
    const type = msg["type"] as string;

    if (type === "hello-ok") {
      clearConnectTimeout();
      connected.value = true;
      connecting.value = false;
      consecutiveReconnects = 0;
      startHeartbeat();
      const data = msg["data"] as Record<string, unknown>;
      sessions.value = (data["sessions"] as GatewaySession[]) ?? [];
      if (currentSessionId.value && sessions.value.some((session) => session.id === currentSessionId.value && !session.archivedAt)) {
        void loadSession(currentSessionId.value).catch(() => {
          currentSessionId.value = null;
          resetLocalSessionState();
        });
      } else if (currentSessionId.value && !sessions.value.some((session) => session.id === currentSessionId.value)) {
        currentSessionId.value = null;
        resetLocalSessionState();
      }
      void ensureNotificationSubscription();
      return;
    }

    if (type === "rpc.response") {
      const id = msg["id"] as string;
      const pendingRpc = pendingRpcs.get(id);
      if (pendingRpc) {
        clearTimeout(pendingRpc.timeout);
        pendingRpcs.delete(id);
        if (msg["ok"]) pendingRpc.resolve(msg["payload"]);
        else pendingRpc.reject(new Error(String(msg["error"] ?? "RPC error")));
      }
      return;
    }

    if (type === "audit.event") {
      const data = msg["data"] as Parameters<typeof audit.addEvent>[0] | undefined;
      if (data) {
        audit.addEvent(data);
      }
      return;
    }

    if (type === "notification.event") {
      const data = msg["data"] as Record<string, unknown> | undefined;
      if (data) {
        notifications.pushServerNotification({
          id: typeof data["id"] === "string" ? data["id"] : undefined,
          title: String(data["title"] ?? "Notification"),
          message: String(data["message"] ?? ""),
          level: (data["level"] as "info" | "success" | "warn" | "error" | undefined) ?? "info",
          createdAt: typeof data["createdAt"] === "string" ? data["createdAt"] : undefined,
          category: typeof data["category"] === "string" ? data["category"] : undefined,
          sessionId: typeof data["sessionId"] === "string" ? data["sessionId"] : undefined,
          jobId: typeof data["jobId"] === "string" ? data["jobId"] : undefined,
          targetPath: typeof data["targetPath"] === "string" ? data["targetPath"] : undefined,
          sticky: data["sticky"] === true,
        });
      }
      return;
    }

    if (type === "agent.chunk") {
      const data = msg["data"] as Record<string, unknown>;
      if (data["requestId"] === pendingRequestId.value) {
        isStreaming.value = true;
        streamingText.value += String(data["text"] ?? "");
      }
      return;
    }

    if (type === "agent.tool_start") {
      const data = msg["data"] as Record<string, unknown>;
      if (data["requestId"] === pendingRequestId.value) {
        const streamingMessage = getStreamingMessage();
        if (streamingMessage) {
          streamingMessage.toolCalls = [...(streamingMessage.toolCalls ?? []), {
            id: typeof data["toolCallId"] === "string" ? data["toolCallId"] : undefined,
            name: String(data["name"]),
            args: data["args"] as Record<string, unknown>,
          }];
        }
      }
      return;
    }

    if (type === "agent.swarm") {
      const data = msg["data"] as Record<string, unknown>;
      if (data["requestId"] === pendingRequestId.value) {
        const swarmState = normalizeSwarmState(data["swarmState"]);
        if (swarmState) {
          liveSwarmState.value = swarmState;
          attachSwarmStateToMessage("streaming", swarmState);
        }
      }
      return;
    }

    if (type === "agent.approval_needed") {
      const data = msg["data"] as Record<string, unknown>;
      if (data["requestId"] === pendingRequestId.value) {
        const approvalId = String(data["approvalId"]);
        pendingApproval.value = {
          approvalId,
          requestId: String(data["requestId"]),
          toolName: String(data["toolName"]),
          args: (data["args"] ?? {}) as Record<string, unknown>,
        };
        notifications.pushLocalNotification({
          id: `approval:${approvalId}`,
          title: "Approval required",
          message: `The agent is waiting for approval to run ${String(data["toolName"])}.`,
          level: "warn",
          category: "approval",
          sticky: true,
        });
      }
      return;
    }

    if (type === "agent.intervention") {
      const data = msg["data"] as Record<string, unknown>;
      if (data["requestId"] === pendingRequestId.value) {
        pendingIntervention.value = data["notice"] as InterventionNotice;
        const notice = data["notice"] as InterventionNotice;
        notifications.pushLocalNotification({
          id: `intervention:${String(data["requestId"])}:${notice.reasonCode}`,
          title: "Operator action suggested",
          message: notice.summary,
          level: notice.severity,
          category: "intervention",
          sticky: notice.severity === "error",
        });
      }
      return;
    }

    // ── Computer-use events ──────────────────────────────────────────────
    if (type.startsWith("computer.")) {
      const computerStore = useComputerStore();
      computerStore.handleServerMessage({ type, data: msg["data"] });
      return;
    }

    if (type === "agent.tool_done") {
      const data = msg["data"] as Record<string, unknown>;
      if (data["requestId"] === pendingRequestId.value) {
        const streamingMessage = getStreamingMessage();
        if (streamingMessage?.toolCalls) {
          const toolCallId = typeof data["toolCallId"] === "string" ? data["toolCallId"] : undefined;
          const tc = toolCallId
            ? streamingMessage.toolCalls.find((toolCall) => toolCall.id === toolCallId)
            : streamingMessage.toolCalls.find((toolCall) => toolCall.name === String(data["name"]) && toolCall.result === undefined);
          if (tc) tc.result = String(data["result"] ?? "");
          if (tc && data["metadata"] && typeof data["metadata"] === "object") {
            tc.metadata = data["metadata"] as Record<string, unknown>;
          }
        }
        if (streamingMessage) {
          const attachments = extractToolAttachments(String(data["name"]), data["metadata"]);
          if (attachments.length) {
            streamingMessage.attachments = [...(streamingMessage.attachments ?? []), ...attachments];
          }
        }
      }
      return;
    }

    if (type === "status") {
      const data = msg["data"] as Record<string, unknown>;
      if (data["requestId"] !== pendingRequestId.value) return;

      const status = data["status"] as string;

      if (status === "accepted") {
        const feedback = buildAcceptedStatusMessage(data);
        if (feedback) {
          insertSystemFeedbackMessage(feedback);
        }
        return;
      }

      if (status === "ok" || status === "blocked") {
        // Replace streaming placeholder with final message
        const idx = messages.value.findIndex(m => m.id === "streaming");
        const isBlocked = status === "blocked";
        const swarmState = normalizeSwarmState(data["swarmState"]) ?? liveSwarmState.value;
        const rawPerf = data["performance"] as Record<string, unknown> | undefined;
        const streamingMessage = idx >= 0 ? messages.value[idx] : undefined;
        const finalMsg: ChatMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: mergeFinalAssistantContent(data["response"], streamingText.value, streamingMessage?.toolCalls),
          timestamp: new Date(),
          guardrailEvents: data["guardrailEvents"] as ChatMessage["guardrailEvents"],
          toolCalls: streamingMessage?.toolCalls,
          attachments: streamingMessage?.attachments,
          blocked: isBlocked,
          swarmState: swarmState ?? undefined,
          usage: data["usage"] as TurnUsage | undefined,
          perf: rawPerf ? {
            turnDurationMs: Number(rawPerf["turnDurationMs"] ?? 0),
            llmCalls: Number(rawPerf["llmCalls"] ?? 0),
            llmTimeMs: Number(rawPerf["llmTimeMs"] ?? 0),
            toolIterations: Number(rawPerf["toolIterations"] ?? 0),
            finishReason: String(rawPerf["finishReason"] ?? ""),
          } : undefined,
        };
        if (idx >= 0) messages.value.splice(idx, 1, finalMsg);
        else messages.value.push(finalMsg);
        streamingText.value = "";
        pendingRequestId.value = null;
        isStreaming.value = false;
        isError.value = isBlocked;
        pendingApproval.value = null;
        appendSwarmRun(isBlocked ? "blocked" : "ok", swarmState);
        liveSwarmState.value = null;
        if (isBlocked) setTimeout(() => { isError.value = false; }, 3000);
        return;
      }

      if (status === "error") {
        const errorText = String(data["error"] ?? "An unexpected error occurred.");
        failPendingTurn(errorText);
      }
    }
  }

  async function rpc(method: string, params?: Record<string, unknown>, timeoutMs = 30000): Promise<unknown> {
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("Not connected");
    const id = Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingRpcs.delete(id);
        reject(new Error("RPC timeout"));
      }, timeoutMs);
      pendingRpcs.set(id, {
        resolve,
        reject,
        timeout,
      });
      ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  async function createSession(): Promise<string> {
    const result = await rpc("session.create", { channel: "webchat" }) as Record<string, unknown>;
    const sid = result["sessionId"] as string;
    currentSessionId.value = sid;
    resetLocalSessionState();
    applyCurrentSessionRunSelection(sid);
    await refreshSessions();
    return sid;
  }

  async function loadScenes(): Promise<void> {
    try {
      scenes.value = (await rpc("scenes.list")) as SceneInfo[];
    } catch {
      // scenes unavailable — not critical
    }
  }

  async function respondApproval(approvalId: string, approved: boolean): Promise<void> {
    await rpc("approval.respond", { approvalId, approved });
    pendingApproval.value = null;
  }

  function dismissIntervention(): void {
    pendingIntervention.value = null;
  }

  async function cancelTurn(): Promise<void> {
    const rid = pendingRequestId.value;
    if (!rid) return;
    try {
      await rpc("chat.cancel", { requestId: rid });
    } catch { /* ignore — WS may have closed */ }
    // Surface cancellation locally even if RPC failed
    failPendingTurn("Turn cancelled by user.");
  }

  async function deleteSession(sessionId: string): Promise<void> {
    if (ws?.readyState === WebSocket.OPEN) {
      try { await rpc("session.delete", { sessionId }); } catch { /* already deleted */ }
    }
    const next = { ...swarmRunsBySession.value };
    delete next[sessionId];
    swarmRunsBySession.value = next;
    if (currentSessionId.value === sessionId) {
      currentSessionId.value = null;
      resetLocalSessionState();
    }
    sessions.value = sessions.value.filter((session) => session.id !== sessionId);
  }

  async function archiveSession(sessionId: string): Promise<void> {
    if (ws?.readyState === WebSocket.OPEN) {
      await rpc("session.archive", { sessionId });
    }
    sessions.value = sessions.value.map((session) => session.id === sessionId
      ? { ...session, archivedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
      : session);
    if (currentSessionId.value === sessionId) {
      currentSessionId.value = null;
      resetLocalSessionState();
    }
  }

  async function sendMessage(text: string, enableThinking?: boolean, displayContent?: string, attachments?: Array<{ filename: string; dataUrl: string }>): Promise<void> {
    if (!currentSessionId.value) await createSession();

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: displayContent ?? text,
      timestamp: new Date(),
      ...(attachments?.length && { attachments }),
    };
    messages.value.push(userMsg);

    const requestId = Math.random().toString(36).slice(2);
    pendingRequestId.value = requestId;
    streamingText.value = "";
    liveSwarmState.value = null;
    pendingIntervention.value = null;

    // Add streaming placeholder
    messages.value.push({
      id: "streaming",
      role: "assistant",
      content: "",
      timestamp: new Date(),
    });

    try {
      await rpc("chat.send", {
        sessionId: currentSessionId.value,
        message: text,
        requestId,
        ...(enableThinking !== undefined && { enableThinking }),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage === "RPC timeout" && connected.value && pendingRequestId.value === requestId) {
        return;
      }
      failPendingTurn(errorMessage);
      throw error;
    }
  }

  async function convertFileToMarkdown(file: File): Promise<FileToMarkdownResult> {
    const formData = new FormData();
    formData.append("file", file, file.name);
    const response = await authorizedFetch("/api/multimodal/file-to-markdown", {
      method: "POST",
      body: formData,
    });
    return await response.json() as FileToMarkdownResult;
  }

  async function transcribeAudio(file: Blob | File, options: { language?: string; prompt?: string; model?: string } = {}): Promise<SpeechToTextResult> {
    const formData = new FormData();
    const filename = file instanceof File ? file.name : "recording.webm";
    formData.append("file", file, filename);
    if (options.language) formData.append("language", options.language);
    if (options.prompt) formData.append("prompt", options.prompt);
    if (options.model) formData.append("model", options.model);

    const response = await authorizedFetch("/api/multimodal/transcribe", {
      method: "POST",
      body: formData,
    });
    return await response.json() as SpeechToTextResult;
  }

  async function listVoices(): Promise<Record<string, unknown>> {
    const response = await authorizedFetch("/api/multimodal/voices");
    return await response.json() as Record<string, unknown>;
  }

  async function saveTtsVoice(input: {
    file: File;
    name: string;
    language?: string;
  }): Promise<SavedTtsVoiceResult> {
    const formData = new FormData();
    formData.append("file", input.file, input.file.name);
    formData.append("name", input.name);
    if (input.language) formData.append("language", input.language);

    const response = await authorizedFetch("/api/multimodal/voices/save", {
      method: "POST",
      body: formData,
    });
    return await response.json() as SavedTtsVoiceResult;
  }

  async function synthesizeSpeech(input: {
    text: string;
    voice?: string;
    language?: string;
    quality?: string;
    gender?: string;
    speed?: number;
  }): Promise<Blob> {
    const response = await authorizedFetch("/api/multimodal/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    return await response.blob();
  }

  async function analyzeImageFile(file: File): Promise<string> {
    const form = new FormData();
    form.append("file", file);
    const response = await authorizedFetch("/api/multimodal/analyze-image", { method: "POST", body: form });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `Image analysis failed: ${response.status}`);
    }
    const body = await response.json() as { analysis?: string; error?: string };
    if (!body.analysis) throw new Error(body.error ?? "No analysis returned");
    return body.analysis;
  }

  async function uploadToWorkspace(file: File, subdir = "uploads"): Promise<{ workspacePath: string; relativePath: string; filename: string }> {
    const form = new FormData();
    form.append("file", file);
    form.append("subdir", subdir);
    const response = await authorizedFetch("/api/workspace/upload", { method: "POST", body: form });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `Upload failed: ${response.status}`);
    }
    return await response.json() as { workspacePath: string; relativePath: string; filename: string };
  }

  async function fetchWorkspaceArtifactBlob(path: string, options: { archive?: boolean; disposition?: "inline" | "attachment" } = {}): Promise<{ blob: Blob; filename: string; contentType: string }> {
    const archive = options.archive ?? false;
    const disposition = options.disposition ?? "inline";
    const search = new URLSearchParams({ path });
    if (!archive) search.set("disposition", disposition);

    const response = await authorizedFetch(`${archive ? "/api/workspace/archive" : "/api/workspace/file"}?${search.toString()}`);
    const blob = await response.blob();
    const filename = parseContentDispositionFilename(response.headers.get("content-disposition"))
      ?? (archive ? `${filenameFromRelativePath(path)}.zip` : filenameFromRelativePath(path));
    const contentType = response.headers.get("content-type") ?? blob.type ?? inferContentTypeFromPath(filename);
    return { blob, filename, contentType };
  }

  async function downloadWorkspaceArtifact(path: string, options: { archive?: boolean; suggestedFilename?: string } = {}): Promise<void> {
    const artifact = await fetchWorkspaceArtifactBlob(path, {
      archive: options.archive,
      disposition: "attachment",
    });
    const url = URL.createObjectURL(artifact.blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = options.suggestedFilename ?? artifact.filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function summarizeForSpeech(input: {
    text: string;
    maxSentences?: number;
  }): Promise<string> {
    const response = await authorizedFetch("/api/multimodal/summarize-for-speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      throw new Error(`Summarisation failed: ${response.status}`);
    }
    const body = await response.json() as { summary?: string; error?: string };
    if (!body.summary) throw new Error(body.error ?? "Empty summary returned");
    return body.summary;
  }

  const isLoading = computed(() => pendingRequestId.value !== null);
  const currentSessionSwarmRuns = computed<SwarmRunRecord[]>(() => {
    if (!currentSessionId.value) return [];
    return swarmRunsBySession.value[currentSessionId.value] ?? [];
  });
  const activeSessions = computed(() => sessions.value.filter((session) => !session.archivedAt));
  const archivedSessions = computed(() => sessions.value.filter((session) => Boolean(session.archivedAt)));
  const currentSessionHasOlderMessages = computed(() => Boolean(currentSessionTranscriptNextBeforeMessageId.value));
  const swarmSessionHistory = computed<SwarmSessionHistory[]>(() => Object.entries(swarmRunsBySession.value)
    .map(([sessionId, runs]) => {
      const latestRun = runs[runs.length - 1];
      if (!latestRun) return null;
      return {
        sessionId,
        runCount: runs.length,
        lastRecordedAt: latestRun.recordedAt,
        lastStatus: latestRun.status,
        lastObjective: latestRun.state.objective,
      };
    })
    .filter((entry): entry is SwarmSessionHistory => entry !== null)
    .sort((left, right) => right.lastRecordedAt.localeCompare(left.lastRecordedAt)));
  const visibleSwarmState = computed<SwarmState | null>(() => {
    if (liveSwarmState.value) return liveSwarmState.value;
    if (selectedSwarmRunId.value) {
      const selected = currentSessionSwarmRuns.value.find((run) => run.id === selectedSwarmRunId.value);
      if (selected) return selected.state;
    }
    for (let index = messages.value.length - 1; index >= 0; index -= 1) {
      const swarmState = messages.value[index]?.swarmState;
      if (swarmState) return swarmState;
    }
    const latestRun = currentSessionSwarmRuns.value[currentSessionSwarmRuns.value.length - 1];
    if (latestRun) return latestRun.state;
    return null;
  });

  return {
    token,
    wsUrl,
    connected,
    connecting,
    authFailed,
    currentSessionId,
    sessions,
    activeSessions,
    archivedSessions,
    currentSessionTranscriptTotalMessages,
    currentSessionTranscriptLoading,
    currentSessionHasOlderMessages,
    scenes,
    messages,
    streamingText,
    currentSessionSwarmRuns,
    swarmSessionHistory,
    selectedSwarmRunId,
    visibleSwarmState,
    isLoading,
    isStreaming,
    isError,
    pendingApproval,
    pendingIntervention,
    connect,
    disconnect,
    rpc,
    refreshSessions,
    getSessionTranscript,
    loadSession,
    switchSession,
    loadOlderCurrentSessionTranscript,
    createSession,
    loadScenes,
    sendMessage,
    convertFileToMarkdown,
    transcribeAudio,
    listVoices,
    saveTtsVoice,
    synthesizeSpeech,
    summarizeForSpeech,
    analyzeImageFile,
    uploadToWorkspace,
    fetchWorkspaceArtifactBlob,
    downloadWorkspaceArtifact,
    respondApproval,
    dismissIntervention,
    cancelTurn,
    archiveSession,
    deleteSession,
    getSwarmRuns,
    selectSwarmRun,
  };
});
