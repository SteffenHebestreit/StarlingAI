import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { useStorage } from "@vueuse/core";
import { useAuditStore } from "./audit";
import { useComputerStore } from "./computer";
import { useNotificationStore } from "./notifications";
import { useShellStore } from "./shell";

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
  statusText?: string;
  statusHistory?: string[];
  attachments?: Array<{
    filename: string;
    dataUrl?: string;
    relativePath?: string;
    externalUrl?: string;
    contentType?: string;
    previewMode?: "image" | "html" | "pdf" | "text" | "markdown" | "json" | "audio" | "mermaid" | "website" | "download";
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
  status: "running" | "completed" | "partial" | "failed";
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
  status: "pending" | "running" | "completed" | "partial" | "failed" | "blocked";
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
  swarmState?: SwarmState;
}

interface GatewayAuditEvent {
  id: string;
  timestamp: string;
  type: string;
  sessionId?: string;
  data: Record<string, unknown>;
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
const PENDING_TURN_LIVENESS_PROBE_TIMEOUT_MS = 8_000;
const RECONNECT_DELAY_MS = 3_000;
const TURN_RECOVERY_POLL_MS = 2_000;
const TURN_RECOVERY_TIMEOUT_MS = 60_000;
const TURN_STALL_WARNING_MS = 20_000;
const TURN_STALL_RECOVERY_MS = 45_000;
const TURN_DELEGATED_STALL_WARNING_MS = 60_000;
const TURN_DELEGATED_STALL_RECOVERY_MS = 120_000;
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

export interface SavedTtsVoice {
  voice_id: string;
  name: string;
  lang?: string;
  ref_text?: string;
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
  externalUrl?: string;
  contentType?: string;
  previewMode?: "image" | "html" | "pdf" | "text" | "markdown" | "json" | "audio" | "mermaid" | "website" | "download";
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

function cloneStatusHistory(history: ChatMessage["statusHistory"]): ChatMessage["statusHistory"] {
  if (!history?.length) return undefined;
  return [...history];
}

function normalizeHydratedMessages(input: ChatMessage[]): ChatMessage[] {
  return input.map((entry) => ({
    ...entry,
    timestamp: new Date(entry.timestamp),
    statusHistory: cloneStatusHistory(entry.statusHistory),
    attachments: cloneAttachments(entry.attachments),
    toolCalls: cloneToolCalls(entry.toolCalls),
    guardrailEvents: cloneGuardrailEvents(entry.guardrailEvents),
  }));
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

function summarizeToolOnlyAssistantTurn(toolCalls?: ChatMessage["toolCalls"]): string {
  if (!toolCalls?.length) return "";

  const toolNames = [...new Set(toolCalls.map((toolCall) => toolCall.name).filter(Boolean))];
  if (toolNames.length === 0) return "";

  if (toolNames.length === 1) {
    const toolName = toolNames[0];
    if (toolName === "delegate_to_agent") {
      const rawTask = toolCalls.find((toolCall) => toolCall.name === toolName)?.args?.task;
      const task = typeof rawTask === "string" ? rawTask.replace(/\s+/g, " ").trim() : "";
      if (task) {
        const summary = task.length > 160 ? `${task.slice(0, 157)}...` : task;
        return `Delegated work completed without a text summary: ${summary}`;
      }
      return "Delegated work completed without a text summary. See execution details below.";
    }

    if (toolName === "parallel_delegate") {
      const rawTasks = toolCalls.find((toolCall) => toolCall.name === toolName)?.args?.tasks;
      const taskCount = Array.isArray(rawTasks) ? rawTasks.length : 0;
      const suffix = taskCount > 0 ? ` (${taskCount} task${taskCount === 1 ? "" : "s"})` : "";
      return `Parallel delegation completed without a text summary${suffix}. See execution details below.`;
    }

    if (toolName === "run_task_graph") {
      return "Task graph execution completed without a text summary. See execution details below.";
    }
  }

  return `This turn completed via ${toolNames.join(", ")} without a text summary. See execution details below.`;
}

function inferContentTypeFromPath(path: string): string {
  const normalized = path.toLowerCase();
  if (normalized.endsWith(".html") || normalized.endsWith(".htm")) return "text/html; charset=utf-8";
  if (normalized.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (normalized.endsWith(".mmd") || normalized.endsWith(".mermaid")) return "text/vnd.mermaid; charset=utf-8";
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
  if (contentType.startsWith("text/markdown")) return "markdown";
  if (contentType.startsWith("text/vnd.mermaid")) return "mermaid";
  if (contentType.startsWith("text/")) return "text";
  return "download";
}

function filenameFromRelativePath(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function filenameFromExternalUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const lastSegment = parsed.pathname.split("/").filter(Boolean).pop();
    return lastSegment ? decodeURIComponent(lastSegment) : parsed.hostname;
  } catch {
    return "linked-source.html";
  }
}

function buildToolAttachment(name: string, value: Record<string, unknown>): ChatAttachment | null {
  const outputPath = typeof value["outputPath"] === "string" ? value["outputPath"] : "";
  const dataUrl = typeof value["dataUrl"] === "string" ? value["dataUrl"] : undefined;
  const externalUrl = typeof value["externalUrl"] === "string"
    ? value["externalUrl"]
    : typeof value["sourceUrl"] === "string"
      ? value["sourceUrl"]
      : undefined;
  const filename = typeof value["filename"] === "string"
    ? value["filename"]
    : outputPath
      ? filenameFromRelativePath(outputPath)
      : externalUrl
        ? filenameFromExternalUrl(externalUrl)
      : dataUrl
        ? "generated-image.png"
        : "artifact";
  const contentType = typeof value["contentType"] === "string"
    ? value["contentType"]
    : outputPath
      ? inferContentTypeFromPath(outputPath)
      : externalUrl
        ? "text/html; charset=utf-8"
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

  if (!outputPath && !dataUrl && !externalUrl) {
    return null;
  }

  if (name === "generate_image" && dataUrl?.startsWith("data:image/")) {
    return {
      filename,
      dataUrl,
      relativePath: outputPath || undefined,
      externalUrl,
      contentType,
      previewMode: "image",
      size,
      title: typeof value["title"] === "string" ? value["title"] : undefined,
      sourceTool: typeof value["sourceTool"] === "string" ? value["sourceTool"] : name,
    };
  }

  return {
    filename,
    dataUrl,
    relativePath: outputPath || undefined,
    externalUrl,
    contentType,
    previewMode,
    size,
    isDirectory: value["isDirectory"] === true,
    title: typeof value["title"] === "string" ? value["title"] : undefined,
    sourceTool: typeof value["sourceTool"] === "string" ? value["sourceTool"] : name,
  };
}

function extractToolAttachments(name: string, metadata: unknown): ChatAttachment[] {
  if (!metadata || typeof metadata !== "object") {
    return [];
  }

  const attachments: ChatAttachment[] = [];
  const seen = new Set<string>();

  const visit = (value: unknown, inheritedToolName: string): void => {
    if (!value || typeof value !== "object") {
      return;
    }

    const entry = value as Record<string, unknown>;
    const toolName = typeof entry["sourceTool"] === "string" ? entry["sourceTool"] : inheritedToolName;
    const attachment = buildToolAttachment(toolName, entry);
    if (attachment) {
      const key = [attachment.relativePath ?? "", attachment.dataUrl ?? "", attachment.filename, attachment.sourceTool ?? ""].join("::");
      if (!seen.has(key)) {
        seen.add(key);
        attachments.push(attachment);
      }
    }

    const nestedArtifacts = entry["artifacts"];
    if (Array.isArray(nestedArtifacts)) {
      for (const nestedArtifact of nestedArtifacts) {
        visit(nestedArtifact, toolName);
      }
    }
  };

  visit(metadata, name);
  return attachments;
}

function extractCompletedThinkingBlocks(text: string): string {
  return (text.match(THINKING_BLOCK_RE) ?? []).join("\n\n").trim();
}

function extractVisibleAssistantContent(
  content: string | null | undefined,
  toolCalls?: ChatMessage["toolCalls"],
): string {
  const raw = typeof content === "string" ? content.trim() : "";
  if (!raw) return "";
  const withoutThinking = raw.replace(THINKING_BLOCK_RE, "").trim();
  if (!withoutThinking) return "";
  return sanitizeAssistantMessageContent(withoutThinking, toolCalls) || withoutThinking;
}

function mergeCompletedThinkingBlocks(...values: Array<string | null | undefined>): string {
  const blocks = values
    .flatMap((value) => (typeof value === "string" ? (value.match(THINKING_BLOCK_RE) ?? []) : []))
    .map((block) => block.trim())
    .filter(Boolean);
  return [...new Set(blocks)].join("\n\n").trim();
}

function mergeFinalAssistantContent(response: unknown, streamedText: string, toolCalls?: ChatMessage["toolCalls"]): string {
  const finalResponse = String(response ?? "").trim();
  const completedThinking = mergeCompletedThinkingBlocks(streamedText, finalResponse);
  const visibleFinal = extractVisibleAssistantContent(finalResponse, toolCalls);
  const visibleStreamed = extractVisibleAssistantContent(streamedText, toolCalls);
  const visibleContent = visibleFinal || visibleStreamed || summarizeToolOnlyAssistantTurn(toolCalls);
  const merged = [completedThinking, visibleContent].filter(Boolean).join("\n\n").trim();

  return merged
    || visibleContent
    || finalResponse
    || streamedText.trim()
    || summarizeToolOnlyAssistantTurn(toolCalls);
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
  const syntheticSwarmState = ref<SwarmState | null>(null);
  const selectedSwarmRunId = ref<string | null>(null);
  const isStreaming = ref(false);   // true while text chunks are arriving
  const isError = ref(false);       // true when last turn ended in an error
  const turnLikelyStalled = ref(false);
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

  interface PendingInputRequest {
    inputId: string;
    requestId: string;
    question: string;
    choices?: string[];
  }

  interface PendingTurnRecovery {
    sessionId: string;
    baselineTotalMessages: number;
    startedAt: number;
  }

  const pendingApproval = ref<PendingApproval | null>(null);
  const pendingInputRequest = ref<PendingInputRequest | null>(null);
  const pendingTurnRecovery = ref<PendingTurnRecovery | null>(null);
  const notificationsSubscribed = ref(false);

  let ws: WebSocket | null = null;
  const pendingRpcs = new Map<string, PendingRpc>();
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let connectTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let turnRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  let turnStallWarningTimer: ReturnType<typeof setTimeout> | null = null;
  let turnStallRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatInFlight = false;
  let turnRecoveryInFlight = false;
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

  function clearTurnRecoveryTimer(): void {
    if (turnRecoveryTimer) {
      clearTimeout(turnRecoveryTimer);
      turnRecoveryTimer = null;
    }
  }

  function clearTurnStallTimers(): void {
    if (turnStallWarningTimer) {
      clearTimeout(turnStallWarningTimer);
      turnStallWarningTimer = null;
    }
    if (turnStallRecoveryTimer) {
      clearTimeout(turnStallRecoveryTimer);
      turnStallRecoveryTimer = null;
    }
  }

  function clearTurnStallState(): void {
    clearTurnStallTimers();
    turnLikelyStalled.value = false;
  }

  function clearPendingTurnRecovery(): void {
    clearTurnRecoveryTimer();
    pendingTurnRecovery.value = null;
    turnRecoveryInFlight = false;
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

  async function probePendingTurnLiveness(requestId: string): Promise<{ connectionHealthy: boolean; requestActive: boolean }> {
    if (!connected.value || !ws || ws.readyState !== WebSocket.OPEN) {
      return { connectionHealthy: false, requestActive: false };
    }

    try {
      const status = await rpc("gateway.status", { requestId }, PENDING_TURN_LIVENESS_PROBE_TIMEOUT_MS) as Record<string, unknown>;
      return {
        connectionHealthy: true,
        requestActive: status["activeTurn"] === true,
      };
    } catch {
      return { connectionHealthy: false, requestActive: false };
    }
  }

  async function warnAboutPossiblyStalledTurn(delegated: boolean): Promise<void> {
    const requestId = pendingRequestId.value;
    if (!requestId) return;

    const liveness = await probePendingTurnLiveness(requestId);
    if (pendingRequestId.value !== requestId) return;

    if (liveness.connectionHealthy && liveness.requestActive) {
      turnLikelyStalled.value = false;
      armPendingTurnWatchdog();
      return;
    }

    turnLikelyStalled.value = true;
    updateStreamingStatus(
      delegated
        ? "Work is still in progress, but the backend has stopped confirming that this run is active. Watching closely before recovery."
        : "No progress signal has arrived recently, and the backend no longer confirms the run as active.",
      { appendHistory: false },
    );
  }

  async function recoverFromStalledTurn(): Promise<void> {
    const requestId = pendingRequestId.value;
    if (!requestId) {
      clearTurnStallState();
      return;
    }

    const liveness = await probePendingTurnLiveness(requestId);
    if (pendingRequestId.value !== requestId) {
      clearTurnStallState();
      return;
    }

    if (liveness.connectionHealthy && liveness.requestActive) {
      turnLikelyStalled.value = false;
      updateStreamingStatus(
        "The backend is still generating this response. Keeping the turn open while waiting for the next progress event.",
        { appendHistory: false },
      );
      armPendingTurnWatchdog();
      return;
    }

    turnLikelyStalled.value = true;
    updateStreamingStatus(
      "No progress signal was received for this turn. Reconnecting to recover the active session.",
      { appendHistory: true },
    );

    beginPendingTurnRecovery();
    stopHeartbeat();
    connected.value = false;
    connecting.value = false;
    rejectPendingRpcs("Connection stalled");
    closeActiveSocket("Turn stalled");
    scheduleReconnect(0);
  }

  const DELEGATION_TOOL_NAMES = new Set(["delegate_to_agent", "parallel_delegate", "run_task_graph"]);

  function hasActiveWorkInFlight(): boolean {
    const streamingMessage = getStreamingMessage();
    const pendingToolCalls = streamingMessage?.toolCalls?.filter((tc) => tc.result === undefined) ?? [];
    const hasActiveDelegation = pendingToolCalls.some((tc) => DELEGATION_TOOL_NAMES.has(tc.name));
    const hasPendingToolCall = pendingToolCalls.length > 0;
    const activeSwarmTask = Object.values((liveSwarmState.value ?? syntheticSwarmState.value)?.tasks ?? {}).some((task) => task.status === "running" || task.status === "pending");
    return hasActiveDelegation || hasPendingToolCall || activeSwarmTask;
  }

  function getPendingTurnWatchdogDelays(): { warningMs: number; recoveryMs: number; delegated: boolean } {
    const delegated = hasActiveWorkInFlight();
    return delegated
      ? {
          warningMs: TURN_DELEGATED_STALL_WARNING_MS,
          recoveryMs: TURN_DELEGATED_STALL_RECOVERY_MS,
          delegated: true,
        }
      : {
          warningMs: TURN_STALL_WARNING_MS,
          recoveryMs: TURN_STALL_RECOVERY_MS,
          delegated: false,
        };
  }

  function armPendingTurnWatchdog(): void {
    clearTurnStallTimers();
    if (!pendingRequestId.value) {
      turnLikelyStalled.value = false;
      return;
    }

    const { warningMs, recoveryMs, delegated } = getPendingTurnWatchdogDelays();

    turnStallWarningTimer = setTimeout(() => {
      void warnAboutPossiblyStalledTurn(delegated);
    }, warningMs);

    turnStallRecoveryTimer = setTimeout(() => {
      void recoverFromStalledTurn();
    }, recoveryMs);
  }

  function notePendingTurnActivity(): void {
    if (!pendingRequestId.value) return;
    turnLikelyStalled.value = false;
    armPendingTurnWatchdog();
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

  function scheduleTurnRecovery(delayMs = TURN_RECOVERY_POLL_MS): void {
    if (turnRecoveryTimer || !pendingTurnRecovery.value) return;
    turnRecoveryTimer = setTimeout(() => {
      turnRecoveryTimer = null;
      void recoverPendingTurn();
    }, delayMs);
  }

  function beginPendingTurnRecovery(): void {
    if (!pendingRequestId.value) return;

    const sessionId = currentSessionId.value;
    if (!sessionId) {
      failPendingTurn("Connection lost while waiting for a response. Please try again.");
      return;
    }

    if (!pendingTurnRecovery.value) {
      pendingTurnRecovery.value = {
        sessionId,
        baselineTotalMessages: currentSessionTranscriptTotalMessages.value,
        startedAt: Date.now(),
      };
      insertSystemFeedbackMessage("Connection lost. Reconnecting and recovering the active turn.");
    }

    pendingApproval.value = null;
      pendingInputRequest.value = null;
    liveSwarmState.value = null;
    syntheticSwarmState.value = null;
    isStreaming.value = false;
    clearTurnStallTimers();
  }

  async function recoverPendingTurn(): Promise<void> {
    const recovery = pendingTurnRecovery.value;
    if (!recovery || !connected.value || turnRecoveryInFlight) return;

    turnRecoveryInFlight = true;
    try {
      const result = await getSessionTranscript(recovery.sessionId, { limit: SESSION_TRANSCRIPT_PAGE_SIZE });
      const lastMessage = result.transcript[result.transcript.length - 1];
      const hasRecoveredAssistantReply = result.totalMessages > recovery.baselineTotalMessages
        && lastMessage?.role === "assistant";

      if (hasRecoveredAssistantReply || result.session.archivedAt) {
        currentSessionId.value = result.session.archivedAt ? null : recovery.sessionId;
        currentSessionTranscriptTotalMessages.value = result.totalMessages;
        currentSessionTranscriptNextBeforeMessageId.value = result.nextBeforeMessageId ?? null;
        hydrateTranscript(result.transcript);
        applyCurrentSessionRunSelection(currentSessionId.value ?? recovery.sessionId);
        pendingRequestId.value = null;
        pendingApproval.value = null;
        pendingInputRequest.value = null;
        pendingIntervention.value = null;
        isStreaming.value = false;
        isError.value = false;
        clearTurnStallState();
        clearPendingTurnRecovery();
        return;
      }

      if (Date.now() - recovery.startedAt >= TURN_RECOVERY_TIMEOUT_MS) {
        clearPendingTurnRecovery();
        failPendingTurn("Connection was lost and the active turn could not be recovered. Please try again.");
        return;
      }

      scheduleTurnRecovery();
    } catch {
      if (Date.now() - recovery.startedAt >= TURN_RECOVERY_TIMEOUT_MS) {
        clearPendingTurnRecovery();
        failPendingTurn("Connection was lost and the active turn could not be recovered. Please try again.");
        return;
      }

      scheduleTurnRecovery();
    } finally {
      turnRecoveryInFlight = false;
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

  function toolArgsSignature(args: Record<string, unknown> | undefined): string {
    try {
      return JSON.stringify(args ?? {});
    } catch {
      return "{}";
    }
  }

  function formatSwarmProgressStatus(swarmState: SwarmState): string | null {
    const tasks = Object.values(swarmState.tasks ?? {});
    const runningCount = tasks.filter((task) => task.status === "running").length;
    const pendingCount = tasks.filter((task) => task.status === "pending").length;
    const completedCount = tasks.filter((task) => task.status === "completed").length;
    const partialCount = tasks.filter((task) => task.status === "partial").length;
    const failedCount = tasks.filter((task) => task.status === "failed" || task.status === "blocked").length;
    const statusParts: string[] = [];
    if (runningCount > 0) statusParts.push(`${runningCount} running`);
    if (pendingCount > 0) statusParts.push(`${pendingCount} pending`);
    if (completedCount > 0) statusParts.push(`${completedCount} done`);
    if (partialCount > 0) statusParts.push(`${partialCount} partial`);
    if (failedCount > 0) statusParts.push(`${failedCount} failed`);
    return statusParts.length > 0 ? `Swarm plan active: ${statusParts.join(" · ")}` : null;
  }

  function currentTurnObjectiveFallback(): string {
    for (let index = messages.value.length - 1; index >= 0; index -= 1) {
      const message = messages.value[index];
      if (message?.role === "user" && message.content.trim()) {
        return summarizeTaskTitle(message.content, 140);
      }
    }
    return "Delegated turn in progress";
  }

  function updateSwarmStatusFromState(swarmState: SwarmState, appendHistory = false): void {
    const statusText = formatSwarmProgressStatus(swarmState);
    if (statusText) {
      updateStreamingStatus(statusText, { appendHistory });
    }
  }

  function ensureSyntheticSwarmState(seedObjective?: string): SwarmState {
    const now = new Date().toISOString();
    const objective = seedObjective?.trim() || currentTurnObjectiveFallback();
    if (!syntheticSwarmState.value) {
      syntheticSwarmState.value = {
        objective,
        startedAt: now,
        updatedAt: now,
        tasks: {},
      };
    } else {
      syntheticSwarmState.value.updatedAt = now;
      if (!syntheticSwarmState.value.objective.trim()) {
        syntheticSwarmState.value.objective = objective;
      }
    }
    attachSwarmStateToMessage("streaming", syntheticSwarmState.value);
    return syntheticSwarmState.value;
  }

  function ensureSyntheticSwarmTask(event: GatewayAuditEvent): SwarmTaskState {
    const agentName = typeof event.data["agentName"] === "string" && event.data["agentName"].trim()
      ? String(event.data["agentName"])
      : "sub_agent";
    const taskText = typeof event.data["task"] === "string" && event.data["task"].trim()
      ? String(event.data["task"])
      : agentName;
    const state = ensureSyntheticSwarmState(taskText);
    const taskId = event.sessionId ? `audit:${event.sessionId}` : `audit:${event.id}`;
    const existing = state.tasks[taskId];
    if (existing) {
      existing.selectedAgent = existing.selectedAgent ?? agentName;
      existing.status = existing.status === "completed" ? "completed" : "running";
      state.updatedAt = event.timestamp;
      attachSwarmStateToMessage("streaming", state);
      return existing;
    }

    state.tasks[taskId] = {
      id: taskId,
      title: summarizeTaskTitle(taskText, 120),
      status: "running",
      dependsOn: [],
      selectedAgent: agentName,
      attempts: [{
        agentName,
        status: "running",
        startedAt: event.timestamp,
        toolCount: 0,
        iterations: 0,
        toolNames: [],
      }],
    };
    state.updatedAt = event.timestamp;
    attachSwarmStateToMessage("streaming", state);
    updateSwarmStatusFromState(state, false);
    return state.tasks[taskId]!;
  }

  function ensureStreamingToolCall(name: string, args: Record<string, unknown>, toolCallId?: string): void {
    const streamingMessage = getStreamingMessage();
    if (!streamingMessage) return;
    const signature = toolArgsSignature(args);
    const existing = (streamingMessage.toolCalls ?? []).find((toolCall) =>
      (toolCallId && toolCall.id === toolCallId)
      || (toolCall.result === undefined && toolCall.name === name && toolArgsSignature(toolCall.args) === signature)
    );
    if (existing) {
      if (toolCallId && !existing.id) existing.id = toolCallId;
      return;
    }
    streamingMessage.toolCalls = [...(streamingMessage.toolCalls ?? []), {
      id: toolCallId,
      name,
      args,
    }];
  }

  function resolveStreamingToolCall(name: string, result: string, toolCallId?: string): void {
    const streamingMessage = getStreamingMessage();
    if (!streamingMessage?.toolCalls) return;
    const toolCall = toolCallId
      ? streamingMessage.toolCalls.find((entry) => entry.id === toolCallId)
      : streamingMessage.toolCalls.find((entry) => entry.name === name && entry.result === undefined);
    if (toolCall) {
      toolCall.result = result;
    }
  }

  function applyAuditEventFallback(event: GatewayAuditEvent): void {
    if (!pendingRequestId.value || !currentSessionId.value) return;

    const sessionId = event.sessionId ?? "";
    const parentSessionId = currentSessionId.value;
    const isMainSessionEvent = sessionId === parentSessionId;
    const isSubSessionEvent = sessionId.startsWith(`sub:${parentSessionId}:`);
    if (!isMainSessionEvent && !isSubSessionEvent) return;

    if (isMainSessionEvent) {
      if (event.type === "tool_call_requested") {
        const toolName = typeof event.data["tool"] === "string" ? String(event.data["tool"]) : "";
        const args = event.data["args"] && typeof event.data["args"] === "object"
          ? event.data["args"] as Record<string, unknown>
          : {};
        if (toolName) {
          ensureStreamingToolCall(toolName, args, `audit:${event.id}`);
          updateStreamingStatus(`Running ${toolName}...`, { appendHistory: true });
        }
        return;
      }

      if (event.type === "tool_call_completed") {
        const toolName = typeof event.data["tool"] === "string" ? String(event.data["tool"]) : "";
        if (toolName) {
          resolveStreamingToolCall(toolName, "Completed.");
        }
        return;
      }

      if (event.type === "tool_call_failed") {
        const toolName = typeof event.data["tool"] === "string" ? String(event.data["tool"]) : "";
        const errorText = typeof event.data["error"] === "string" && event.data["error"].trim()
          ? `Error: ${String(event.data["error"])}`
          : "Error: Tool call failed.";
        if (toolName) {
          resolveStreamingToolCall(toolName, errorText);
        }
        return;
      }
    }

    if (!isSubSessionEvent || liveSwarmState.value) return;

    const task = ensureSyntheticSwarmTask(event);
    const attempt = task.attempts[task.attempts.length - 1];
    if (!attempt) return;

    switch (event.type) {
      case "sub_agent_started": {
        task.status = "running";
        attempt.status = "running";
        break;
      }
      case "sub_agent_tool_call": {
        const phase = typeof event.data["phase"] === "string" ? String(event.data["phase"]).toLowerCase() : "start";
        const toolName = typeof event.data["tool"] === "string" ? String(event.data["tool"]) : "tool";
        attempt.status = "running";
        if (phase !== "done") {
          attempt.toolCount = (attempt.toolCount ?? 0) + 1;
          attempt.toolNames = [...(attempt.toolNames ?? []), toolName];
        }
        break;
      }
      case "sub_agent_completed": {
        const outcome = typeof event.data["outcome"] === "string" ? String(event.data["outcome"]).toLowerCase() : "success";
        const terminalState = typeof event.data["terminalState"] === "string" ? String(event.data["terminalState"]).toLowerCase() : "completed";
        const failed = outcome === "failure" || terminalState === "error" || terminalState === "missing_config";
        const partial = !failed && (outcome === "partial" || terminalState === "timeout" || terminalState === "cancelled");
        task.status = failed ? "failed" : partial ? "partial" : "completed";
        attempt.status = failed ? "failed" : partial ? "partial" : "completed";
        attempt.finishedAt = event.timestamp;
        if (typeof event.data["toolCount"] === "number") attempt.toolCount = Number(event.data["toolCount"]);
        if (typeof event.data["iterations"] === "number") attempt.iterations = Number(event.data["iterations"]);
        if (typeof event.data["error"] === "string" && event.data["error"].trim()) {
          task.error = String(event.data["error"]);
        }
        const agentLabel = task.selectedAgent ?? attempt.agentName;
        attempt.summary = failed
          ? `${agentLabel} failed`
          : partial
            ? `${agentLabel} returned a partial result`
            : `Completed ${agentLabel}`;
        break;
      }
      case "sub_agent_max_iterations": {
        task.status = "partial";
        attempt.status = "partial";
        attempt.finishedAt = event.timestamp;
        if (typeof event.data["toolCount"] === "number") attempt.toolCount = Number(event.data["toolCount"]);
        if (typeof event.data["iterations"] === "number") attempt.iterations = Number(event.data["iterations"]);
        attempt.summary = `${task.selectedAgent ?? attempt.agentName} hit max iterations`;
        break;
      }
      default:
        return;
    }

    syntheticSwarmState.value!.updatedAt = event.timestamp;
    attachSwarmStateToMessage("streaming", syntheticSwarmState.value);
    updateSwarmStatusFromState(syntheticSwarmState.value!, false);
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

  function summarizeTaskTitle(task: string, maxLength = 80): string {
    const compact = task.replace(/\s+/g, " ").trim();
    return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
  }

  function synthesizeSwarmStateFromToolCalls(
    toolCalls: ChatMessage["toolCalls"],
    errorText: string,
  ): SwarmState | null {
    if (!toolCalls?.length) return null;

    const delegatedCall = toolCalls.find((toolCall) => toolCall.name === "delegate_to_agent");
    if (!delegatedCall) return null;

    const task = typeof delegatedCall.args?.task === "string" ? delegatedCall.args.task.trim() : "";
    const agentName = typeof delegatedCall.args?.agentName === "string" ? delegatedCall.args.agentName.trim() : "delegated_agent";
    const now = new Date().toISOString();
    const title = task ? summarizeTaskTitle(task) : `Delegated task via ${agentName}`;

    return {
      objective: task || `Delegated task via ${agentName}`,
      startedAt: now,
      updatedAt: now,
      tasks: {
        task_1: {
          id: "task_1",
          title,
          status: "failed",
          dependsOn: [],
          selectedAgent: agentName,
          attempts: [{
            agentName,
            status: "failed",
            startedAt: now,
            finishedAt: now,
            summary: summarizeTaskTitle(errorText, 220),
            toolCount: 0,
            iterations: 0,
          }],
          error: errorText,
        },
      },
    };
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
    const streamingMessage = idx >= 0 ? messages.value[idx] : undefined;
    const preservedSwarmState = liveSwarmState.value
      ?? syntheticSwarmState.value
      ?? streamingMessage?.swarmState
      ?? synthesizeSwarmStateFromToolCalls(streamingMessage?.toolCalls, errorText);
    const errorMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: `⚠️ ${errorText}`,
      timestamp: new Date(),
      blocked: true,
      swarmState: preservedSwarmState ?? undefined,
      toolCalls: streamingMessage?.toolCalls,
      attachments: streamingMessage?.attachments,
    };

    if (!preservePendingState) {
      if (idx >= 0) messages.value.splice(idx, 1, errorMsg);
      else messages.value.push(errorMsg);
      streamingText.value = "";
      pendingRequestId.value = null;
      pendingApproval.value = null;
      pendingInputRequest.value = null;
      pendingIntervention.value = null;
      isStreaming.value = false;
      clearTurnStallState();
      appendSwarmRun("error", preservedSwarmState);
      liveSwarmState.value = null;
      syntheticSwarmState.value = null;
    }

    isError.value = true;
    setTimeout(() => { isError.value = false; }, 5000);
  }

  function resetLocalSessionState() {
    clearPendingTurnRecovery();
    clearTurnStallState();
    messages.value = [];
    currentSessionTranscriptTotalMessages.value = 0;
    currentSessionTranscriptNextBeforeMessageId.value = null;
    currentSessionTranscriptLoading.value = false;
    streamingText.value = "";
    pendingRequestId.value = null;
    pendingApproval.value = null;
    pendingInputRequest.value = null;
    pendingIntervention.value = null;
    liveSwarmState.value = null;
    syntheticSwarmState.value = null;
    isStreaming.value = false;
    selectedSwarmRunId.value = null;
  }

  function mapTranscriptMessages(transcript: GatewaySessionTranscriptMessage[]): ChatMessage[] {
    return normalizeHydratedMessages(transcript.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.role === "assistant"
        ? mergeFinalAssistantContent(message.content, "", message.toolCalls)
        : message.content,
      timestamp: new Date(message.timestamp),
      toolCalls: message.toolCalls,
      swarmState: normalizeSwarmState(message.swarmState) ?? undefined,
      attachments: (message.toolCalls ?? []).flatMap((toolCall) => extractToolAttachments(toolCall.name, toolCall.metadata)),
    })));
  }

  function hydrateTranscript(transcript: GatewaySessionTranscriptMessage[]) {
    messages.value = mapTranscriptMessages(transcript);
  }

  function getStreamingMessage(): ChatMessage | undefined {
    return messages.value.find((entry) => entry.id === "streaming");
  }

  function updateStreamingStatus(content: string, options: { appendHistory?: boolean } = {}): void {
    const trimmed = content.trim();
    if (!trimmed) return;

    const streamingMessage = getStreamingMessage();
    if (!streamingMessage) {
      insertSystemFeedbackMessage(trimmed);
      return;
    }

    streamingMessage.statusText = trimmed;

    if (options.appendHistory === false) return;

    const nextHistory = [...(streamingMessage.statusHistory ?? [])];
    if (nextHistory[nextHistory.length - 1] !== trimmed) {
      nextHistory.push(trimmed);
      streamingMessage.statusHistory = nextHistory.slice(-6);
    }
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
    // Stake the target session id BEFORE awaiting so the post-await guard can
    // distinguish "user switched FROM a prior session" (the normal case) from
    // "a second loadSession call superseded this one" (the race we want to
    // drop).  The previous logic compared against `null`, which conflated the
    // two and silently discarded every legitimate switch from one session to
    // another — leaving the chat showing the prior transcript and chat.send
    // routing to the wrong session id.
    const previousSessionId = currentSessionId.value;
    currentSessionId.value = sessionId;
    try {
      const result = await getSessionTranscript(sessionId, { limit: SESSION_TRANSCRIPT_PAGE_SIZE });
      if (currentSessionId.value !== sessionId) return; // concurrent switch won
      if (!allowArchived && result.session.archivedAt) {
        currentSessionId.value = previousSessionId;
        throw new Error("Archived sessions cannot be resumed");
      }
      currentSessionId.value = result.session.archivedAt ? null : sessionId;
      currentSessionTranscriptTotalMessages.value = result.totalMessages;
      currentSessionTranscriptNextBeforeMessageId.value = result.nextBeforeMessageId ?? null;
      hydrateTranscript(result.transcript);
      applyCurrentSessionRunSelection(currentSessionId.value ?? sessionId);
    } catch (err) {
      if (currentSessionId.value === sessionId) {
        currentSessionId.value = previousSessionId;
      }
      throw err;
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

      if (pendingRequestId.value) {
        beginPendingTurnRecovery();
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
    pendingInputRequest.value = null;
    pendingIntervention.value = null;
    notificationsSubscribed.value = false;
    liveSwarmState.value = null;
    syntheticSwarmState.value = null;
    isStreaming.value = false;
  }

  function handleServerMessage(msg: Record<string, unknown>) {
    const type = msg["type"] as string;

    if (type === "hello-ok") {
      clearConnectTimeout();
      connected.value = true;
      connecting.value = false;
      consecutiveReconnects = 0;
      notePendingTurnActivity();
      startHeartbeat();
      const data = msg["data"] as Record<string, unknown>;
      sessions.value = (data["sessions"] as GatewaySession[]) ?? [];
      if (pendingTurnRecovery.value) {
        const recoverySessionId = pendingTurnRecovery.value.sessionId;
        if (sessions.value.some((session) => session.id === recoverySessionId)) {
          currentSessionId.value = recoverySessionId;
          void recoverPendingTurn();
        } else {
          clearPendingTurnRecovery();
          failPendingTurn("Connection was restored, but the active session no longer exists.");
        }
      } else if (currentSessionId.value && sessions.value.some((session) => session.id === currentSessionId.value && !session.archivedAt)) {
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
        notePendingTurnActivity();
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
        applyAuditEventFallback(data as GatewayAuditEvent);
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
        notePendingTurnActivity();
        isStreaming.value = true;
        streamingText.value += String(data["text"] ?? "");
      }
      return;
    }

    if (type === "agent.tool_start") {
      const data = msg["data"] as Record<string, unknown>;
      if (data["requestId"] === pendingRequestId.value) {
        notePendingTurnActivity();
        useShellStore().handleToolStart(data);
        const streamingMessage = getStreamingMessage();
        if (streamingMessage) {
          ensureStreamingToolCall(
            String(data["name"]),
            (data["args"] as Record<string, unknown>) ?? {},
            typeof data["toolCallId"] === "string" ? data["toolCallId"] : undefined,
          );
        }
        updateStreamingStatus(`Running ${String(data["name"])}...`, { appendHistory: true });
      }
      return;
    }

    if (type === "agent.swarm") {
      const data = msg["data"] as Record<string, unknown>;
      if (data["requestId"] === pendingRequestId.value) {
        notePendingTurnActivity();
        const swarmState = normalizeSwarmState(data["swarmState"]);
        if (swarmState) {
          liveSwarmState.value = swarmState;
          syntheticSwarmState.value = null;
          attachSwarmStateToMessage("streaming", swarmState);
          updateSwarmStatusFromState(swarmState, false);
        }
      }
      return;
    }

    if (type === "agent.approval_needed") {
      const data = msg["data"] as Record<string, unknown>;
      if (data["requestId"] === pendingRequestId.value) {
        notePendingTurnActivity();
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

    if (type === "agent.input_needed") {
      const data = msg["data"] as Record<string, unknown>;
      if (data["requestId"] === pendingRequestId.value) {
        notePendingTurnActivity();
        const inputId = String(data["inputId"]);
        const rawChoices = data["choices"];
        pendingInputRequest.value = {
          inputId,
          requestId: String(data["requestId"]),
          question: String(data["question"] ?? ""),
          choices: Array.isArray(rawChoices) ? rawChoices.map(String) : undefined,
        };
      }
      return;
    }

    if (type === "agent.intervention") {
      const data = msg["data"] as Record<string, unknown>;
      if (data["requestId"] === pendingRequestId.value) {
        notePendingTurnActivity();
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
        notePendingTurnActivity();
        useShellStore().handleToolDone(data);
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

          const completedTools = streamingMessage.toolCalls?.filter((toolCall) => toolCall.result !== undefined).length ?? 0;
          const shouldCheckpoint = completedTools <= 2 || completedTools % 3 === 0;
          updateStreamingStatus(
            completedTools > 0
              ? `Completed ${completedTools} tool call${completedTools === 1 ? "" : "s"}. Latest: ${String(data["name"])}.`
              : `Completed ${String(data["name"])}.`,
            { appendHistory: shouldCheckpoint },
          );
        }
      }
      return;
    }

    if (type === "status") {
      const data = msg["data"] as Record<string, unknown>;
      if (data["requestId"] !== pendingRequestId.value) return;
      notePendingTurnActivity();

      const status = data["status"] as string;

      if (status === "accepted") {
        const feedback = buildAcceptedStatusMessage(data);
        if (feedback) {
          updateStreamingStatus(feedback, { appendHistory: true });
        }
        return;
      }

      if (["routing", "synthesizing", "guardrail"].includes(status)) {
        const message = String(data["message"] ?? "").trim();
        if (message) {
          updateStreamingStatus(message, { appendHistory: true });
        }
        return;
      }

      if (status === "ok" || status === "blocked") {
        // Replace streaming placeholder with final message
        const idx = messages.value.findIndex(m => m.id === "streaming");
        const isBlocked = status === "blocked";
        const streamingMessage = idx >= 0 ? messages.value[idx] : undefined;
        const swarmState = normalizeSwarmState(data["swarmState"]) ?? liveSwarmState.value ?? streamingMessage?.swarmState ?? syntheticSwarmState.value;
        const rawPerf = data["performance"] as Record<string, unknown> | undefined;
        const finalMsg: ChatMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: mergeFinalAssistantContent(data["response"], streamingText.value, streamingMessage?.toolCalls),
          timestamp: new Date(),
          guardrailEvents: data["guardrailEvents"] as ChatMessage["guardrailEvents"],
          toolCalls: streamingMessage?.toolCalls,
          attachments: streamingMessage?.attachments,
          blocked: isBlocked,
          statusText: streamingMessage?.statusText,
          statusHistory: cloneStatusHistory(streamingMessage?.statusHistory),
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
        clearTurnStallState();
        isError.value = isBlocked;
        pendingApproval.value = null;
        pendingInputRequest.value = null;
        appendSwarmRun(isBlocked ? "blocked" : "ok", swarmState);
        liveSwarmState.value = null;
        syntheticSwarmState.value = null;
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

  async function respondInput(inputId: string, answer: string): Promise<void> {
    await rpc("input.respond", { inputId, answer });
    pendingInputRequest.value = null;
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

  async function supersedePendingTurn(): Promise<void> {
    const rid = pendingRequestId.value;
    if (!rid) return;

    try {
      await rpc("chat.cancel", { requestId: rid });
    } catch {
      // Ignore transport failures here so a replacement turn can still start.
    }

    const idx = messages.value.findIndex((message) => message.id === "streaming");
    if (idx >= 0) {
      messages.value.splice(idx, 1);
    }

    streamingText.value = "";
    pendingRequestId.value = null;
    pendingApproval.value = null;
    pendingInputRequest.value = null;
    pendingIntervention.value = null;
    liveSwarmState.value = null;
    syntheticSwarmState.value = null;
    isStreaming.value = false;
    clearTurnStallState();
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

  /**
   * Rewind the current session to just before the message with the given client ID.
   * The message's text is returned so the caller can pre-fill the composer.
   * The local messages array is truncated to exclude that message and everything after it.
   */
  async function rewindToMessage(msgId: string): Promise<string> {
    const sid = currentSessionId.value;
    if (!sid) throw new Error("No active session");

    const msgIndex = messages.value.findIndex((m) => m.id === msgId);
    if (msgIndex < 0) throw new Error("Message not found");

    const msg = messages.value[msgIndex]!;
    const text = msg.content;

    // Parse the server-side history index from transcript IDs formatted as "${sessionId}:${index}"
    let historyIndex: number | null = null;
    const colonIdx = msgId.lastIndexOf(":");
    if (colonIdx > 0) {
      const parsed = Number(msgId.slice(colonIdx + 1));
      if (Number.isInteger(parsed) && parsed >= 0) historyIndex = parsed;
    }

    if (historyIndex === null) {
      // Live message (UUID) — fetch transcript to resolve the server-side index
      try {
        const transcript = await getSessionTranscript(sid, { limit: 200 });
        const found = transcript.transcript.find((t) => t.role === "user" && t.content === text);
        if (found) {
          const ci = found.id.lastIndexOf(":");
          if (ci > 0) historyIndex = Number(found.id.slice(ci + 1));
        }
      } catch {
        // If we can't resolve the index, we still truncate locally
      }
    }

    if (historyIndex !== null) {
      await rpc("session.rewind", { sessionId: sid, historyIndex });
    }

    // Truncate local messages to exclude the target message and everything after
    messages.value = messages.value.slice(0, msgIndex);
    return text;
  }

  async function sendMessage(text: string, enableThinking?: boolean, displayContent?: string, attachments?: Array<{ filename: string; dataUrl: string }>): Promise<void> {
    if (pendingRequestId.value) {
      await supersedePendingTurn();
    }

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
    syntheticSwarmState.value = null;
    pendingIntervention.value = null;
    turnLikelyStalled.value = false;

    // Add streaming placeholder
    messages.value.push({
      id: "streaming",
      role: "assistant",
      content: "",
      timestamp: new Date(),
      statusText: "Working on it...",
      statusHistory: ["Working on it..."],
    });
    armPendingTurnWatchdog();

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

  async function listVoices(): Promise<{ voices: SavedTtsVoice[]; speakers: string[]; models: Record<string, unknown>; currentModel?: string }> {
    const response = await authorizedFetch("/api/multimodal/voices");
    return await response.json() as { voices: SavedTtsVoice[]; speakers: string[]; models: Record<string, unknown>; currentModel?: string };
  }

  async function removeTtsVoice(voiceId: string): Promise<void> {
    const response = await authorizedFetch(`/api/multimodal/voices/${encodeURIComponent(voiceId)}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `Failed to delete voice: ${response.status}`);
    }
  }

  async function saveTtsVoice(input: {
    file: File;
    name: string;
    language?: string;
    referenceText?: string;
  }): Promise<SavedTtsVoiceResult> {
    const formData = new FormData();
    formData.append("file", input.file, input.file.name);
    formData.append("name", input.name);
    if (input.language) formData.append("language", input.language);
    if (input.referenceText) formData.append("referenceText", input.referenceText);

    const response = await authorizedFetch("/api/multimodal/voices/save", {
      method: "POST",
      body: formData,
    });
    return await response.json() as SavedTtsVoiceResult;
  }

  async function synthesizeSpeech(input: {
    text: string;
    voice?: string;
    voiceId?: string;
    speaker?: string;
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

  async function downloadSessionDebugMarkdown(sessionId: string): Promise<void> {
    try {
      const response = await authorizedFetch(`/api/sessions/${encodeURIComponent(sessionId)}/debug-markdown`);
      const blob = await response.blob();
      const filename = parseContentDispositionFilename(response.headers.get("content-disposition"))
        ?? `starlingai-session-${sessionId.slice(0, 8)}-debug.md`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      notifications.pushLocalNotification({
        title: "Debug export unavailable",
        message: error instanceof Error ? error.message : String(error),
        level: "warn",
        category: "export",
        sessionId,
      });
    }
  }

  async function downloadSessionAuditMarkdown(sessionId: string): Promise<void> {
    try {
      const response = await authorizedFetch(`/api/sessions/${encodeURIComponent(sessionId)}/audit-markdown`);
      const blob = await response.blob();
      const filename = parseContentDispositionFilename(response.headers.get("content-disposition"))
        ?? `starlingai-session-${sessionId.slice(0, 8)}-audit.md`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      notifications.pushLocalNotification({
        title: "Audit export unavailable",
        message: error instanceof Error ? error.message : String(error),
        level: "warn",
        category: "export",
        sessionId,
      });
    }
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
    if (syntheticSwarmState.value) return syntheticSwarmState.value;
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
    turnLikelyStalled,
    pendingApproval,
    pendingInputRequest,
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
    rewindToMessage,
    convertFileToMarkdown,
    transcribeAudio,
    listVoices,
    saveTtsVoice,
    removeTtsVoice,
    synthesizeSpeech,
    summarizeForSpeech,
    analyzeImageFile,
    uploadToWorkspace,
    fetchWorkspaceArtifactBlob,
    downloadWorkspaceArtifact,
    downloadSessionDebugMarkdown,
    downloadSessionAuditMarkdown,
    respondApproval,
    respondInput,
    dismissIntervention,
    cancelTurn,
    archiveSession,
    deleteSession,
    getSwarmRuns,
    selectSwarmRun,
  };
});
