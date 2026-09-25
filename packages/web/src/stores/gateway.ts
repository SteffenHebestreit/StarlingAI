import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { useStorage } from "@vueuse/core";
import { useAuditStore } from "./audit";
import { useComputerStore } from "./computer";
import { useNotificationStore } from "./notifications";
import { useShellStore } from "./shell";
import { isDelegation, isFailedResult, stepsFromToolCalls, type TurnStep } from "../composables/turnSteps";
import { mergeFinalAssistantContent, mergeSegmentAssistantContent, transcriptAssistantContent } from "../composables/assistantContent";
import {
  appendUnread, landTurn, liveCallId, markUnread, newSteerMessage, progressSteps, readSteeringEntries, resteer, resumeTurnSegments,
  routeToolDone, settleSteps, splitAtSteering, takeFollowUp, turnBubbles, unreadAbove, unreadPlace, withoutOutdatedSegments, withResumedStep, type SteerMark,
  type SteerState, type SteeringEntry,
} from "../composables/turnSegments";
import { dropRunningTail, markRunningTail, mergeHydrated, sameList, sameMessage } from "../composables/hydration";
import { namesTurns, nextOpenerIndex, recoveryVerdict, savedEnding, type RecoveryVerdict } from "../composables/turnRecovery";
import { needsOlderTranscript, rewindHistoryIndex, transcriptHistoryIndex } from "../composables/rewind";
import {
  addUserInput, anchorStepFor, askUserExpiresAt, closesAskUser, dropTurnInputs, expiredInputIds, holdsStallRecovery,
  isExpiredAnswer, nextExpiryAt, openInputsFor, outcomeOfChoice, placeUserInputs, readFieldErrors, readUserInputList,
  readUserInputRequest, readUserInputResolution, rehydrateUserInputs, removeUserInput, serverClockSkew, stepUserInputRecord,
  type UserInputFieldError, type UserInputMap, type UserInputResolution,
} from "../composables/userInputs";

export { sanitizeAssistantMessageContent } from "../composables/assistantContent";

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
  /** Main assistant chain-of-thought captured during the turn (collapsible in the UI). */
  reasoning?: string;
  /** Per-sub-agent chain-of-thought, surfaced behind a debug toggle. */
  subAgentReasoning?: Array<{ agent: string; text: string }>;
  /**
   * The turn as it happened, in order: each tool call (the orchestrator's own and those made
   * inside a delegated specialist) plus the runtime's narration between them. Recorded live
   * from the turn's events; absent on a message reloaded from the transcript, where it is
   * reconstructed from `toolCalls` instead.
   */
  steps?: TurnStep[];
  /** The turn this bubble belongs to — shared by every segment of a turn the user spoke into. */
  requestId?: string;
  /** A user message read inside a running turn rather than opening one. */
  midTurn?: boolean;
  /** An assistant segment the turn continued past after reading a mid-turn message; not its answer. */
  continued?: boolean;
  /** Only on a message sent into a running turn: where it stands (see turnSegments). */
  steer?: SteerMark;
  /** Made by this page and never saved on the server — an error note, a stopped stub (see hydration). */
  pageOnly?: boolean;
  /** A page-only note on a turn the user stopped: the server records no stop, only what the turn did. */
  stopped?: boolean;
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
  attachments?: ChatAttachment[];
  toolCalls?: Array<{ id?: string; name: string; args: Record<string, unknown>; result?: string; metadata?: Record<string, unknown> }>;
  swarmState?: SwarmState;
  /** A user message sent into a running turn; `content` is only what the user wrote. */
  midTurn?: true;
  steeringId?: string;
  /** An assistant segment followed by a mid-turn message of the same turn. */
  continued?: true;
  segmentStartedAt?: string;
  /**
   * The chat.send request id of the turn the entry belongs to — for a mid-turn message, the turn
   * that read it. Absent on an older server, in history saved before, and for turns no chat.send
   * started; the page then tells turns apart by their words.
   */
  requestId?: string;
}

interface SendMessageOptions {
  userMessageId?: string;
}

interface GatewayAuditEvent {
  id: string;
  timestamp: string;
  type: string;
  sessionId?: string;
  data: Record<string, unknown>;
}

export type EffortTier = "low" | "medium" | "high" | "max";

/** Whether a render asks for the user's settings first ("ask") or goes ahead with the agent's ("auto"). */
export type ImageSettingsPrompt = "ask" | "auto";

/** How a message sent into a running turn fared — or "sent": it already went out as the next turn. */
export type SteerOutcome = SteerState | "sent";

export interface SessionEffortSettings {
  effort?: EffortTier;
  turnTimeoutSecOverride?: number;
  imageSettingsPrompt?: ImageSettingsPrompt;
}

export interface GatewaySessionTranscript {
  session: GatewaySession;
  transcript: GatewaySessionTranscriptMessage[];
  totalMessages: number;
  nextBeforeMessageId?: string;
  settings?: SessionEffortSettings;
  /** A turn is running on this session right now. */
  activeTurn?: boolean;
  /** That turn's requestId, while it runs — a page that did not start it can follow it by that. */
  activeTurnRequestId?: string;
  /** When that turn started (epoch ms). */
  activeTurnStartedAt?: number;
  /** Questions a running turn put to the user that are still waiting for an answer. */
  openUserInputs?: unknown[];
  /** The server's clock when it answered (epoch ms). */
  serverNow?: number;
  /**
   * Messages finished turns never read, kept by the server when the final status that lists them
   * found the connection that started the turn gone — until the session's next turn starts.
   */
  unreadSteering?: Array<{ id: string; text: string; requestId: string }>;
}

const SESSION_TRANSCRIPT_PAGE_SIZE = 100;
const CONNECT_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 25_000;
const HEARTBEAT_RPC_TIMEOUT_MS = 8_000;
const PENDING_TURN_LIVENESS_PROBE_TIMEOUT_MS = 8_000;
const RECONNECT_DELAY_MS = 3_000;
const TURN_RECOVERY_POLL_MS = 2_000;
// While the server confirms the lost turn is still running, its answer can be many minutes off;
// reading the transcript every two seconds for all of that would be wasted work.
const TURN_RECOVERY_RUNNING_POLL_MS = 5_000;
const TURN_RECOVERY_TIMEOUT_MS = 60_000;
/** How many older transcript pages a Restart reads back to find the message it restarts from. */
const REWIND_MAX_TRANSCRIPT_PAGES = 5;
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

function attachmentsForRpc(attachments: ChatMessage["attachments"]): ChatMessage["attachments"] {
  if (!attachments?.length) return undefined;
  return attachments.map(({ dataUrl: _dataUrl, ...attachment }) => ({ ...attachment }));
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

export interface OrchestrationConfig {
  maxParallelSlices: number;
  subAgentToolCaps: Record<string, number>;
  coordinatorToolCaps: Record<string, number>;
  perTurnCaps: Record<string, number>;
}

export interface OrchestrationConfigResponse {
  config: OrchestrationConfig;
  defaults: OrchestrationConfig;
}

export interface SkillLibraryConfig {
  enabled: boolean;
  autoAuthor: boolean;
  minStepsToAuthor: number;
  maxInjected: number;
  retireBelowSuccessRate: number;
  retireMinUses: number;
  autoPromoteToScene: boolean;
}

export interface ToolPipelineConfig {
  enabled: boolean;
  maxSteps: number;
  maxTemplateOutputChars: number;
}

export interface SkillFeatureConfig {
  skillLibrary: SkillLibraryConfig;
  toolPipeline: ToolPipelineConfig;
}

export interface ManagedDocumentScope {
  scope: "session" | "user" | "workspace" | "unknown";
  source: string;
  relativePath?: string;
  contentType?: string;
  size?: number;
}
export interface ManagedDocument {
  id: string;
  title: string | null;
  chunkCount: number;
  createdAt: string | null;
  hasFile: boolean;
  /** Marked outdated (engram invalidation) — retrieval skips it; re-upload reinstates. */
  invalidated?: boolean;
  scopes: ManagedDocumentScope[];
}
export interface DocumentListResponse {
  documents: ManagedDocument[];
  engramAvailable: boolean;
  currentUser: string | null;
}

export interface DocumentRagConfig {
  enabled: boolean;
  engramBaseUrl: string;
  engramApiKey?: string;
  ingestTimeoutMs: number;
  searchTimeoutMs: number;
  autoIngestAttachments: boolean;
  injectContext: boolean;
  retrievalTopK: number;
  candidateTopK: number;
  minRerankScore: number;
  maxContextChars: number;
  includeUserDocs: boolean;
  includeWorkspaceDocs: boolean;
  workspaceName: string;
}

export interface UserModelProfile {
  schemaVersion: 1;
  goals: string[];
  expertise: string[];
  workingStyle: string[];
  communication: string[];
  openQuestions: string[];
  revision: number;
  updatedAt: string;
  updatedBy: "user" | "assistant" | "system";
}

export interface UserModelInput {
  goals?: string[];
  expertise?: string[];
  workingStyle?: string[];
  communication?: string[];
  openQuestions?: string[];
  append?: boolean;
  reset?: boolean;
}

export interface MemoryCurationReport {
  totalRecords: number;
  duplicateClusters: number;
  removableDuplicates: number;
  staleVolatile: number;
  nudge: string;
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
  // True when the gateway reports the primary model endpoint is unreachable (a
  // local LM Studio/Ollama that isn't running yet) — the dashboard shows a banner
  // so a fresh install doesn't just fail every turn with an unexplained empty answer.
  const modelUnreachable = ref(false);
  let lastModelHealthAt = 0;
  const MODEL_HEALTH_INTERVAL_MS = 30_000;
  const currentSessionId = useStorage<string | null>("gc_current_session_id", null);
  const sessions = ref<GatewaySession[]>([]);
  const scenes = ref<SceneInfo[]>([]);
  const messages = ref<ChatMessage[]>([]);
  const currentSessionTranscriptTotalMessages = ref(0);
  const currentSessionTranscriptNextBeforeMessageId = ref<string | null>(null);
  const currentSessionTranscriptLoading = ref(false);
  // Per-session effort tier + optional time-limit override (composer-controlled,
  // persisted on the session). Hydrated on load; defaults to "medium" until known.
  const currentSessionEffort = ref<EffortTier>("medium");
  const currentSessionTimeLimitSec = ref<number | null>(null);
  const currentSessionImageSettingsPrompt = ref<ImageSettingsPrompt>("ask");
  const pendingRequestId = ref<string | null>(null);
  // The session the pending turn runs in. The page shows one session at a time, and a turn goes
  // on running on the server when the user switches away: its events must never land in the
  // session on screen, and nothing typed there may steer or stop it.
  let pendingTurnSessionId: string | null = null;
  // Turns the page stopped following when the user switched sessions mid-turn, by session. Going
  // back while one still runs picks it up again. `connection` is the connection its events come
  // to — null when they never came here — so a turn left before a reconnect is followed by
  // reading the transcript, not by waiting for events that go to the connection that is gone.
  const detachedTurns = new Map<string, { requestId: string; connection: number | null }>();
  // The turn followServerTurn picked up from the transcript. What it did before is in its resumed
  // segments, not in the live bubble — which holds nothing at all when `transcriptOnly`: no event
  // of it ever comes here, and it is followed by reading the transcript alone.
  let pickedUpTurn: { requestId: string; transcriptOnly: boolean } | null = null;
  // Counts the connections this page has had; a turn's events come to the one it started on.
  let connectionEpoch = 0;
  // The session each turn this page sent or followed runs in. The list can still hold another
  // session's messages while the one switched to loads, and what was typed there must not run
  // as a turn here.
  const turnSessions = new Map<string, string>();
  // What turns in other sessions never read, kept until that session is on screen again — the
  // server hands it back only once, in the turn's final status, and nothing saves it.
  const unreadSteering = new Map<string, Array<{ requestId: string; entries: SteeringEntry[]; error: string }>>();
  // Messages already sent on as the next turn (takeFollowUp), which no longer carry their mark.
  const sentAsFollowUp = new Set<string>();
  // The turn whose own tool events have been seen. From then on they are the record of its calls,
  // and the audit log's copies of the same calls are not applied on top of them.
  let liveToolEventsTurn: string | null = null;
  const streamingText = ref("");
  // Live chain-of-thought for the in-flight turn. streamingReasoning is the
  // main assistant's CoT; streamingSubAgentReasoning accumulates one entry per
  // delegated sub-agent reasoning event (shown behind a debug toggle).
  const streamingReasoning = ref("");
  const streamingSubAgentReasoning = ref<Array<{ agent: string; text: string }>>([]);
  const liveSwarmState = ref<SwarmState | null>(null);
  const syntheticSwarmState = ref<SwarmState | null>(null);
  const selectedSwarmRunId = ref<string | null>(null);
  const isStreaming = ref(false);   // true while text chunks are arriving

  // B7: coalesce per-token streaming appends into ONE reactive write per animation
  // frame. The message bubble re-parses + sanitizes the entire buffer on every
  // streamingText change (O(n) per token → O(n²) per reply); batching makes it
  // O(n) per frame. The rAF callback discards stale buffered text if the turn was
  // reset (isStreaming false); flushStreamTextNow() applies the residual eagerly
  // before the final message is built so the rendered text stays exact.
  let _pendingStreamText = "";
  let _streamRaf: number | null = null;
  function flushPendingStreamText(): void {
    _streamRaf = null;
    if (_pendingStreamText && isStreaming.value) streamingText.value += _pendingStreamText;
    _pendingStreamText = "";
  }
  function appendStreamText(text: string): void {
    if (!text) return;
    _pendingStreamText += text;
    if (_streamRaf !== null) return;
    if (typeof requestAnimationFrame === "function") _streamRaf = requestAnimationFrame(flushPendingStreamText);
    else flushPendingStreamText();
  }
  function flushStreamTextNow(): void {
    if (_streamRaf !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(_streamRaf);
    _streamRaf = null;
    if (_pendingStreamText) { streamingText.value += _pendingStreamText; _pendingStreamText = ""; }
  }

  // Reasoning gets the same rAF coalescing as the text lane, and for the same reason: a
  // build turn emits tens of thousands of reasoning characters, and a reactive write per
  // token would re-render the panel on each one.
  //
  // It also gets something the text lane does not need — a bounded tail. Reasoning is a
  // live view of what an agent is doing right now, not a transcript; the full
  // chain-of-thought is already in the audit log. Retaining all of it would grow the
  // rendered DOM without bound on exactly the long runs where the panel matters most, so
  // each lane keeps its last REASONING_TAIL_CHARS and drops the rest from the head.
  const REASONING_TAIL_CHARS = 8_000;
  function boundedTail(existing: string, addition: string): string {
    const combined = existing + addition;
    return combined.length > REASONING_TAIL_CHARS ? combined.slice(-REASONING_TAIL_CHARS) : combined;
  }

  let _pendingReasoning = "";
  const _pendingSubAgentReasoning = new Map<string, string>();
  let _reasoningRaf: number | null = null;
  // The turn the buffered reasoning belongs to. A buffer is thrown away only when that turn is no
  // longer the live one (it ended, was stopped or was replaced). It used to be thrown away
  // whenever no answer TEXT had streamed yet — isStreaming is set by text chunks only — which is
  // every turn that thinks and calls tools before it writes: both lanes stayed empty for the
  // whole of a delegation, and only the last frame reached the finished message.
  let _reasoningTurn: string | null = null;
  function flushPendingReasoning(): void {
    _reasoningRaf = null;
    if (_reasoningTurn === null || _reasoningTurn !== pendingRequestId.value) {
      _pendingReasoning = "";
      _pendingSubAgentReasoning.clear();
      return;
    }
    if (_pendingReasoning) {
      streamingReasoning.value = boundedTail(streamingReasoning.value, _pendingReasoning);
      _pendingReasoning = "";
    }
    if (_pendingSubAgentReasoning.size > 0) {
      // One entry per agent, in first-seen order, so the panel shows a stable lane per
      // delegate rather than an interleaved scroll of everyone's thoughts.
      const next = streamingSubAgentReasoning.value.map(entry => ({ ...entry }));
      for (const [agent, text] of _pendingSubAgentReasoning) {
        const existing = next.find(entry => entry.agent === agent);
        if (existing) existing.text = boundedTail(existing.text, text);
        else next.push({ agent, text: boundedTail("", text) });
      }
      streamingSubAgentReasoning.value = next;
      _pendingSubAgentReasoning.clear();
    }
  }
  function scheduleReasoningFlush(): void {
    if (_reasoningRaf !== null) return;
    if (typeof requestAnimationFrame === "function") _reasoningRaf = requestAnimationFrame(() => flushPendingReasoning());
    else flushPendingReasoning();
  }
  function appendReasoning(text: string, agent?: string): void {
    if (!text) return;
    if (_reasoningTurn !== pendingRequestId.value) {
      // Another turn's leftovers never join this one's lanes.
      _pendingReasoning = "";
      _pendingSubAgentReasoning.clear();
      _reasoningTurn = pendingRequestId.value;
    }
    if (agent) _pendingSubAgentReasoning.set(agent, (_pendingSubAgentReasoning.get(agent) ?? "") + text);
    else _pendingReasoning += text;
    scheduleReasoningFlush();
  }
  function flushReasoningNow(): void {
    if (_reasoningRaf !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(_reasoningRaf);
    _reasoningRaf = null;
    flushPendingReasoning();
  }

  const isError = ref(false);       // true when last turn ended in an error
  // One timer for the error flash: with one per failure, a blocked turn's 3 s timer cleared the
  // flash of an error that came a second later, two seconds into its five.
  let errorFlashTimer: ReturnType<typeof setTimeout> | null = null;
  function flashError(ms: number): void {
    if (errorFlashTimer) clearTimeout(errorFlashTimer);
    isError.value = true;
    errorFlashTimer = setTimeout(() => {
      errorFlashTimer = null;
      isError.value = false;
    }, ms);
  }
  function clearErrorFlash(): void {
    if (errorFlashTimer) clearTimeout(errorFlashTimer);
    errorFlashTimer = null;
    isError.value = false;
  }
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
    timeoutMs?: number;
    expiresAt?: string;
  }

  interface PendingInputRequest {
    inputId: string;
    requestId: string;
    question: string;
    choices?: string[];
    /** When the server stops waiting and answers for the user; drives the banner's countdown. */
    expiresAt?: string;
    /** The ask_user call that asked — its completion closes the banner. */
    toolCallId?: string;
  }

  interface PendingTurnRecovery {
    /**
     * The turn being recovered. Recovery answers for that turn only: a Stop or a new message
     * while it waits ends it, and a result that arrives later must not land on the next turn.
     */
    requestId: string;
    sessionId: string;
    baselineTotalMessages: number;
    startedAt: number;
    /** The user's message that opened the turn, to find the turn in a transcript that names no turns. */
    openerText?: string;
    /** The user pressed Stop and the server said the turn runs no longer (cancelTurn). */
    stopped?: boolean;
    /**
     * The server accepted the turn (chat.send) before the connection dropped, so it has the
     * turn's opening message: a later one in the transcript came after it, not instead of it.
     */
    openerSaved?: boolean;
    /**
     * Its final status came to this page (endUnlessReplaced), with what it never read: no
     * connection dropped. `data`, the status itself, when a lost connection cut the read short:
     * a turn the read does not show landed says how it ended by that.
     */
    finalStatus?: { leftovers: SteeringEntry[]; data?: Record<string, unknown> };
  }

  const pendingApproval = ref<PendingApproval | null>(null);
  const pendingInputRequest = ref<PendingInputRequest | null>(null);
  let inputRequestExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  // Structured questions (the image settings card), keyed by inputId. Separate from the ask_user
  // banner on purpose: that banner takes over the composer, and a settings card must not — the
  // user can keep steering while it waits.
  const userInputs = ref<UserInputMap>({});
  // The engine the user picked on a card, from the moment the answer goes out until the card is
  // settled here — which the server's "resolved" event does before its reply arrives.
  const chosenSettings = new Map<string, { tier?: string; expectedSeconds?: number }>();
  let userInputExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  /** The card whose full form is open. The page draws it, so it survives its card being re-mounted. */
  const configuringUserInputId = ref<string | null>(null);
  const pendingTurnRecovery = ref<PendingTurnRecovery | null>(null);
  // The turn the user asked to stop. Its own final status can still arrive as "blocked", and
  // what it never read must not then go out as though it had ended on its own.
  let stoppedRequestId: string | null = null;
  // The newest turn this page sent that the server accepted (chat.send's reply).
  let acceptedRequestId: string | null = null;
  // The turn whose final status endUnlessReplaced lands, once a read said nothing replaced it.
  let finalStatusRead: string | null = null;
  // Final statuses endUnlessReplaced holds while it reads the session, by turn. The turn has
  // ended: a Stop or a message typed meanwhile lands its status as it came.
  const heldFinalStatuses = new Map<string, Record<string, unknown>>();
  // The last turn's thinking setting, for the turn made of messages the previous one never read.
  let lastEnableThinking: boolean | undefined;
  let heldSendTimer: ReturnType<typeof setTimeout> | null = null;
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

  /**
   * A turn waiting on the user's answer sends no progress, by design. Silence then is not a
   * stall, and recovering from it would be worse than useless: the recovery drops the socket, and
   * the server reads a vanished connection as the user walking away from the question.
   */
  function turnWaitsOnUser(): boolean {
    return holdsStallRecovery(userInputs.value, currentSessionId.value, Date.now(), Boolean(pendingInputRequest.value));
  }

  async function warnAboutPossiblyStalledTurn(delegated: boolean): Promise<void> {
    const requestId = pendingRequestId.value;
    if (!requestId) return;
    if (turnWaitsOnUser()) {
      turnLikelyStalled.value = false;
      armPendingTurnWatchdog();
      return;
    }

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
    if (turnWaitsOnUser()) {
      turnLikelyStalled.value = false;
      armPendingTurnWatchdog();
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
    const pendingToolCalls = turnBubbles(messages.value, pendingRequestId.value)
      .flatMap((bubble) => bubble.toolCalls?.filter((tc) => tc.result === undefined) ?? []);
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

  // Poll the authed subsystem health for the primary-model reachability signal.
  // Failures to reach the health endpoint are ignored (connection issues surface
  // elsewhere) — only a definitive "unavailable" from the gateway flips the flag.
  async function checkModelHealth(): Promise<void> {
    lastModelHealthAt = Date.now();
    try {
      const res = await authorizedFetch("/api/health/subsystems");
      const report = await res.json() as { checks?: Array<{ name: string; status: string }> };
      const model = report.checks?.find((c) => c.name === "primary_model");
      if (model) modelUnreachable.value = model.status === "unavailable";
    } catch { /* leave the flag as-is */ }
  }

  function startHeartbeat(): void {
    stopHeartbeat();
    void checkModelHealth(); // immediate check on (re)connect
    heartbeatTimer = setInterval(async () => {
      if (!connected.value || !ws || ws.readyState !== WebSocket.OPEN) return;
      // Throttled model-health poll (much slower than the heartbeat itself).
      if (Date.now() - lastModelHealthAt > MODEL_HEALTH_INTERVAL_MS) void checkModelHealth();
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

  /** The user's message that opened the pending turn — not one sent into it while it ran. */
  function pendingTurnOpenerText(): string | undefined {
    const liveIndex = messages.value.findIndex((message) => message.id === "streaming");
    for (let index = (liveIndex >= 0 ? liveIndex : messages.value.length) - 1; index >= 0; index -= 1) {
      const message = messages.value[index]!;
      if (message.role === "user" && !message.midTurn && !message.steer) return message.content;
    }
    return undefined;
  }

  function beginPendingTurnRecovery(): void {
    const requestId = pendingRequestId.value;
    if (!requestId) return;

    const sessionId = pendingTurnSessionId ?? currentSessionId.value;
    if (!sessionId) {
      failPendingTurn("Connection lost while waiting for a response. Please try again.");
      return;
    }

    if (pendingTurnRecovery.value?.requestId !== requestId) {
      clearPendingTurnRecovery();
      pendingTurnRecovery.value = {
        requestId,
        sessionId,
        baselineTotalMessages: currentSessionTranscriptTotalMessages.value,
        startedAt: Date.now(),
        openerText: pendingTurnOpenerText(),
        openerSaved: acceptedRequestId === requestId,
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

  /** Whether a recovery still speaks for the turn on screen — a Stop or a new message ends it. */
  function recoveryIsCurrent(recovery: PendingTurnRecovery): boolean {
    return pendingTurnRecovery.value?.requestId === recovery.requestId && pendingRequestId.value === recovery.requestId;
  }

  async function recoverPendingTurn(): Promise<void> {
    const recovery = pendingTurnRecovery.value;
    if (!recovery || !connected.value || turnRecoveryInFlight) return;
    if (!recoveryIsCurrent(recovery)) {
      clearPendingTurnRecovery();
      return;
    }

    turnRecoveryInFlight = true;
    try {
      const listedAt = Date.now();
      const result = await getSessionTranscript(recovery.sessionId, { limit: SESSION_TRANSCRIPT_PAGE_SIZE });
      // The user stopped the turn, sent another or switched away while this was out: whatever it
      // says is about a turn no longer on screen.
      if (!recoveryIsCurrent(recovery)) return;
      // A question the turn put while the connection was down is still waiting on the server.
      rehydrateOpenUserInputs(recovery.sessionId, result.openUserInputs, listedAt, result.serverNow);

      // Archived, it runs no more: it ends as the read says it did, else as the transcript shows it.
      // Ended as the transcript shows it whatever the read said, a turn another tab's message had
      // replaced read as "completed without a text summary" (review of round 4, D #6).
      if (result.session.archivedAt) {
        if (!endRecoveredTurn(recovery, result, readRecoveryVerdict(recovery, result))) finishRecoveredTurn(recovery, result);
        return;
      }

      const verdict = readRecoveryVerdict(recovery, result);
      if (endRecoveredTurn(recovery, result, verdict)) return;

      if (verdict === "lost") {
        clearPendingTurnRecovery();
        if (recovery.stopped) failPendingTurn("Turn cancelled by user.", false, [], true);
        else failRecoveredTurn(recovery, "The connection dropped and the turn ended without an answer. Please try again.");
        return;
      }

      if (verdict === "running") {
        // Alive on the server, but its events went to the connection that was lost. Its answer
        // is read from the transcript once it lands; until then this is not a timeout.
        recovery.startedAt = Date.now();
        // A turn picked up by reading the transcript lost no connection here (a reload, a second
        // tab): its status line stays as followServerTurn set it, and its steps move with each read.
        if (readsTranscriptOnly(recovery.requestId)) refreshPickedUpTurn(recovery.requestId, result);
        else updateStreamingStatus("Reconnected — this turn is still running on the server. Its answer appears here when it finishes.", { appendHistory: false });
        scheduleTurnRecovery(TURN_RECOVERY_RUNNING_POLL_MS);
        return;
      }

      // A turn waiting on the user's answer is not a lost turn: it cannot reply before they do,
      // and giving up here would take their open card away with it.
      if (openInputsFor(userInputs.value, recovery.sessionId, Date.now()).length > 0) recovery.startedAt = Date.now();

      if (Date.now() - recovery.startedAt >= TURN_RECOVERY_TIMEOUT_MS) {
        clearPendingTurnRecovery();
        failRecoveredTurn(recovery, "Connection was lost and the active turn could not be recovered. Please try again.");
        return;
      }

      scheduleTurnRecovery();
    } catch {
      if (!recoveryIsCurrent(recovery)) return;
      // A Stop is not kept waiting on a read that failed: the turn has ended either way.
      if (recovery.stopped) {
        clearPendingTurnRecovery();
        failPendingTurn("Turn cancelled by user.", false, [], true);
        return;
      }
      if (Date.now() - recovery.startedAt >= TURN_RECOVERY_TIMEOUT_MS) {
        clearPendingTurnRecovery();
        failRecoveredTurn(recovery, "Connection was lost and the active turn could not be recovered. Please try again.");
        return;
      }

      scheduleTurnRecovery();
    } finally {
      turnRecoveryInFlight = false;
    }
  }

  /**
   * End a recovered turn the transcript does not show landed: by its own final status when that
   * came here before the connection dropped (endUnlessReplaced). The page had "Provider
   * unreachable", and said the connection had dropped (review of round 5, D R2).
   *
   * What the turn never read is marked undelivered first, and the status lands without it: after
   * a lost connection nothing is sent on unasked (finishRecoveredTurn). A "blocked" status lands
   * as a turn that ended on its own, and sent them out as the next turn (review of round 6, D I1).
   */
  function failRecoveredTurn(recovery: PendingTurnRecovery, errorText: string): void {
    const status = recovery.finalStatus;
    if (!status?.data) {
      failPendingTurn(errorText);
      return;
    }
    messages.value = markUnread(messages.value, recovery.requestId, status.leftovers, "undelivered", {
      at: new Date(),
      newId: () => crypto.randomUUID(),
      error: "The turn ended before it read this.",
    });
    landHeldStatus({ ...status.data, unconsumedSteering: [] });
  }

  /** What a read of the session says of the turn the page recovers. */
  function readRecoveryVerdict(recovery: PendingTurnRecovery, result: GatewaySessionTranscript): RecoveryVerdict {
    return recoveryVerdict({
      activeTurn: result.activeTurn,
      transcript: result.transcript,
      totalMessages: result.totalMessages,
      baselineTotalMessages: recovery.baselineTotalMessages,
      openerText: recovery.openerText,
      // A turn the server runs under another name is the message from another tab that
      // replaced this one — and so, after a Stop the server says found nothing running, is
      // any turn running there. Waited on as this one, it kept the page spinning this turn's
      // steps until that turn ended too, then said the connection had dropped (review of
      // round 3, D #1).
      requestId: recovery.requestId,
      activeTurnRequestId: result.activeTurnRequestId,
      stopped: recovery.stopped,
      // Read from the transcript, or accepted by the server before the connection dropped. The
      // page's own turn, replaced by another tab's message that ended before the reconnect, said
      // the connection had dropped and hid that message and its answer (review of round 4, D #4).
      openerSaved: recovery.openerSaved === true || readsTranscriptOnly(recovery.requestId),
    });
  }

  /** End the recovered turn when the read says it has ended: true when it did. */
  function endRecoveredTurn(recovery: PendingTurnRecovery, result: GatewaySessionTranscript, verdict: RecoveryVerdict): boolean {
    if (verdict !== "landed" && verdict !== "moved-on") return false;
    const saved = savedEnding(result.transcript, recovery);
    finishRecoveredTurn(recovery, result, {
      // A Stop on a turn that had ended keeps its note unless what the server saved ends in an
      // answer: taken for one, its partial step read as a success (review of round 3, D #2). A
      // turn another tab's message replaced is noted as replaced unless it ends in an answer —
      // between two calls as well as in one: noted only when cut in a call, a turn replaced
      // between two steps read as "completed without a text summary" (review of round 4, D #3).
      ending: recovery.stopped ? (saved === "answer" ? undefined : "stopped") : verdict === "moved-on" && saved !== "answer" ? "replaced" : undefined,
      movedOn: verdict === "moved-on",
    });
    return true;
  }

  /**
   * The lost turn is over and the transcript has its answer: show the transcript. The live
   * bubble goes with the turn, and a message the turn never read is marked undelivered — it is
   * not known how the turn ended, so nothing is sent on unasked.
   *
   * `ending`, when what the server saved of the turn is not how it ended: the user's Stop, or a
   * message from another tab that replaced it. Its note goes where the live bubble was, holding
   * the step it ended in, before the transcript is merged — which then places it (hydration).
   *
   * `movedOn`, when the session went on to a turn opened after this one. One still running there
   * is followed, as a reload would: the page no longer looks idle while it runs, and a message
   * typed here steers it — sent as a new turn, it stopped that turn on the server (review of
   * round 3, D #1).
   */
  function finishRecoveredTurn(
    recovery: PendingTurnRecovery,
    result: GatewaySessionTranscript,
    options: { ending?: "stopped" | "replaced"; movedOn?: boolean } = {},
  ): void {
    if (options.ending === "stopped") failPendingTurn("Turn cancelled by user.", false, [], true);
    else if (options.ending === "replaced") landReplacedTurn(recovery.requestId, true);
    currentSessionId.value = result.session.archivedAt ? null : recovery.sessionId;
    currentSessionTranscriptTotalMessages.value = result.totalMessages;
    currentSessionTranscriptNextBeforeMessageId.value = result.nextBeforeMessageId ?? null;
    const runsOn = options.movedOn === true && result.activeTurn === true;
    const fetched = mapTranscriptMessages(runsOn ? markRunningTail(result.transcript) : result.transcript);
    // The turn's segments the server has moved past, or saved as how it ended, are the page's
    // stale copies: the server's stand.
    const local = withoutOutdatedSegments(messages.value.filter((message) => message.id !== "streaming"), recovery.requestId, fetched);
    const merged = mergeHydrated(fetched, local, {
      knownBefore: new Set(local.map((message) => message.id)),
      sameSession: true,
    });
    messages.value = markUnread(merged, recovery.requestId, recovery.finalStatus?.leftovers ?? [], "undelivered", {
      at: new Date(),
      newId: () => crypto.randomUUID(),
      // Picked up after a reload or in a second tab, or ended with a status that came here: no
      // connection of this page dropped.
      error: readsTranscriptOnly(recovery.requestId) || recovery.finalStatus
        ? "The turn ended before it read this."
        : "The connection dropped and the turn ended before it read this.",
    });
    pendingRequestId.value = null;
    // Sent from another tab or connection, it has no bubble here; the server kept it (session.get).
    restoreServerUnread(recovery.sessionId, result.unreadSteering);
    // What this turn never read was typed before the message that opened the turn after it, and
    // goes above that message: a bubble this page already had for it as well as one just restored.
    // Only this turn's: another turn's leftovers can be the newer turn's own, and above its
    // message they read as typed before it (review of round 4, D #1 and #2). The message is the
    // first the transcript has after this turn's, by its id: the newest, with two turns opened
    // since, put them below the first one's message and work (review of round 5, D E1).
    const nextOpener = options.movedOn ? nextOpenerIndex(result.transcript, recovery) : -1;
    if (nextOpener >= 0) messages.value = unreadAbove(messages.value, recovery.requestId, result.transcript[nextOpener]!.id);
    applyCurrentSessionRunSelection(currentSessionId.value ?? recovery.sessionId);
    pendingApproval.value = null;
    pendingInputRequest.value = null;
    dropUserInputsOfTurn(recovery.requestId);
    pendingIntervention.value = null;
    streamingText.value = "";
    streamingReasoning.value = "";
    streamingSubAgentReasoning.value = [];
    liveSwarmState.value = null;
    syntheticSwarmState.value = null;
    isStreaming.value = false;
    if (options.ending !== "stopped") clearErrorFlash();
    clearTurnStallState();
    clearPendingTurnRecovery();
    const next = runsOn && !result.session.archivedAt ? serverTurnToFollow(recovery.sessionId, result) : null;
    if (next && next.requestId !== recovery.requestId) followServerTurn(next.requestId, recovery.sessionId, next);
  }

  /**
   * The final status of a turn this page follows live and did not stop ("blocked" or "error"):
   * landed as it came — unless the session runs another turn now. A message from another tab
   * ends the turn so (chat.send stops the turn running on the session); landed, it left the page
   * idle while that tab's turn ran, and a message typed next went out as a new turn and stopped
   * that one in turn (review of round 4, D #7). Then the turn ends as one followed by reading the
   * transcript does when another tab replaced it: that tab's message shows, this turn reads as
   * replaced, and the turn running now is followed, so a message typed here steers it.
   *
   * Until the server has saved that turn's message the session is read again: before, the turn
   * that ended is the newest the transcript has, and its work read as the new turn's. A transcript
   * that names the turn of each entry says exactly when that is, and is read until then, as long as
   * a lost turn is: the turn's input checks can hold its message up for seconds, and landed after
   * three reads the status left the page idle while that turn ran — a message typed next stopped it
   * (review of round 6, G1). One that names none is read a few times, not for a minute: a message
   * from another tab in this turn's words is the newest there for good, and the page spun the
   * ended turn for a minute, then landed it and went idle (review of round 5, D R1); that message
   * is not told from this turn's own, and the status lands as it came.
   */
  async function endUnlessReplaced(data: Record<string, unknown>): Promise<void> {
    const requestId = String(data["requestId"]);
    const sessionId = pendingTurnSessionId;
    const leftovers = readSteeringEntries(data["unconsumedSteering"]);
    // Read before the first await: a Continue while the read was out moved the live bubble below
    // another tab's message, which was then taken for this turn's (review of round 5, D R4).
    const openerText = pendingTurnOpenerText();
    const startedAt = Date.now();
    heldFinalStatuses.set(requestId, data);
    for (let attempt = 0; sessionId; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, TURN_RECOVERY_POLL_MS));
      let result: GatewaySessionTranscript;
      try {
        result = await getSessionTranscript(sessionId, { limit: SESSION_TRANSCRIPT_PAGE_SIZE });
      } catch {
        break;
      }
      if (pendingRequestId.value !== requestId || pendingTurnRecovery.value) break;
      const another = result.activeTurn === true && Boolean(result.activeTurnRequestId) && result.activeTurnRequestId !== requestId;
      if (!another) break;
      const recovery: PendingTurnRecovery = {
        requestId,
        sessionId,
        baselineTotalMessages: currentSessionTranscriptTotalMessages.value,
        startedAt,
        openerText,
        finalStatus: { leftovers },
      };
      const verdict = readRecoveryVerdict(recovery, result);
      if (verdict === "moved-on") {
        heldFinalStatuses.delete(requestId);
        endRecoveredTurn(recovery, result, verdict);
        return;
      }
      const named = namesTurns(result.transcript);
      if (verdict !== "running" || (named ? Date.now() - startedAt >= TURN_RECOVERY_TIMEOUT_MS : attempt >= 2)) break;
    }
    // Landed while the read was out, by a Stop or a message typed here (takeHeldStatus).
    if (!heldFinalStatuses.delete(requestId)) return;
    // Stopped or replaced from here while the read was out, or picked up by a recovery after a
    // lost connection: what the turn never read still shows, as undelivered. The recovery keeps
    // the status: a turn it does not see land ends by that.
    if (pendingRequestId.value !== requestId || pendingTurnRecovery.value) {
      const recovering = pendingTurnRecovery.value;
      if (recovering?.requestId === requestId && pendingRequestId.value === requestId) recovering.finalStatus = { leftovers, data };
      else if (leftovers.length > 0 && sessionId) keepUnread(sessionId, requestId, leftovers, "The turn ended before it read this.");
      return;
    }
    landHeldStatus(data);
  }

  /** Land a final status held for a read of the session as it came: read for again, it never lands. */
  function landHeldStatus(data: Record<string, unknown>): void {
    finalStatusRead = String(data["requestId"]);
    try {
      handleServerMessage({ type: "status", data });
    } finally {
      finalStatusRead = null;
    }
  }

  /**
   * The final status held for the turn, taken to land: while endUnlessReplaced reads the session,
   * or kept by the recovery that took over when the connection dropped meanwhile.
   */
  function takeHeldStatus(requestId: string): Record<string, unknown> | undefined {
    const held = heldFinalStatuses.get(requestId)
      ?? (pendingTurnRecovery.value?.requestId === requestId ? pendingTurnRecovery.value.finalStatus?.data : undefined);
    heldFinalStatuses.delete(requestId);
    return held;
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
      // A message sent into the running turn redirects it; the turn's objective is what opened it.
      if (message?.role === "user" && !message.midTurn && !message.steer && message.content.trim()) {
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
      // The audit log reports a call BEFORE the call's own start event arrives, so the entry is
      // often made from the audit copy first. The real id replaces the stand-in: kept, it left
      // the call's own completion (looked up by the real id) nowhere to land.
      if (toolCallId && !toolCallId.startsWith("audit:") && (!existing.id || existing.id.startsWith("audit:"))) {
        existing.id = toolCallId;
      }
      return;
    }
    streamingMessage.toolCalls = [...(streamingMessage.toolCalls ?? []), {
      id: toolCallId,
      name,
      args,
    }];
  }

  // ── The step stream ───────────────────────────────────────────────────────
  // Recorded alongside `toolCalls` rather than derived from it, because `toolCalls` loses two
  // things the stream needs: WHEN each call ran, and WHICH specialist it ran inside (a
  // delegated `generate_image` lands in the same flat list as the orchestrator's own calls).

  // Phases worth keeping on the finished answer: each is a course-correction the reader would
  // otherwise never learn happened. "synthesizing" is only the FORCED path now (a loop or the
  // iteration cap cut the turn short); the routine after-every-round line is "reviewing" and
  // stays live-status only.
  /** Tools that run several specialists under one call — progress hosts, never a single target. */
  const FAN_OUT_TOOLS = new Set(["parallel_delegate", "execute_plan", "run_task_graph", "run_workflow"]);

  // Not "steering": a message read mid-turn now shows as the user's own bubble between the
  // segments before and after it, and a note saying so as well would tell it twice.
  const NARRATION_PHASES = new Set(["oversight", "recovered", "guardrail", "synthesizing"]);

  /** A live event's call id, keyed by the specialist it ran in when it ran in one (see liveCallId). */
  function eventCallId(data: Record<string, unknown>): string | undefined {
    const toolCallId = typeof data["toolCallId"] === "string" ? data["toolCallId"] : undefined;
    if (!toolCallId) return undefined;
    return liveCallId(toolCallId, data["delegated"] === true && typeof data["sourceAgent"] === "string" ? data["sourceAgent"] : undefined);
  }

  function recordStepStart(data: Record<string, unknown>): void {
    const streamingMessage = getStreamingMessage();
    if (!streamingMessage) return;
    const name = String(data["name"]);
    const delegated = data["delegated"] === true;
    const toolCallId = eventCallId(data);
    const steps = streamingMessage.steps ?? [];

    let id = toolCallId ?? `${name}-${Date.now()}-${steps.length}`;
    const existing = steps.find(step => step.id === id);
    if (existing) {
      // A repeated start for a call still running is the same call announced twice.
      if (existing.status === "running") return;
      // A finished id seen again is a NEW call reusing it — the sub-agent fallback id is
      // agent:tool:iteration, which two calls in one iteration share.
      id = `${id}#${steps.length}`;
    }

    streamingMessage.steps = [...steps, {
      id,
      kind: "tool",
      name,
      ...(delegated && typeof data["sourceAgent"] === "string" ? { agent: data["sourceAgent"] } : {}),
      depth: delegated ? 1 : 0,
      status: "running",
      startedAt: Date.now(),
      args: (data["args"] as Record<string, unknown>) ?? {},
    }];
  }

  function finishStep(step: TurnStep, data: Record<string, unknown>): void {
    const result = String(data["result"] ?? "");
    const metadata = data["metadata"] && typeof data["metadata"] === "object"
      ? data["metadata"] as Record<string, unknown>
      : undefined;
    step.status = isFailedResult(result, metadata) ? "failed" : "done";
    step.endedAt = Date.now();
    step.result = result;
    if (metadata) step.metadata = metadata;
    step.progress = undefined;
  }

  /**
   * A line from inside a running delegation. It belongs to the delegation's row rather than
   * becoming a row of its own — "image_creator finished" is the delegation's progress, and as
   * a separate line it would duplicate the row it describes.
   */
  function recordDelegationProgress(agent: string | undefined, message: string): void {
    const steps = progressSteps(messages.value, pendingRequestId.value);
    if (!steps?.length) return;
    const running = [...steps].reverse().filter(step => step.depth === 0 && step.status === "running");
    const single = running.filter(isDelegation);
    const direct = single.find(candidate => agent && (candidate.args?.["agentName"] === agent || candidate.target === agent))
      // The orchestrator may not have named the specialist, in which case the runtime picked
      // one and this event is the first place its name appears.
      ?? single.find(candidate => !candidate.args?.["agentName"] && !candidate.target);
    if (direct) {
      // Only the FIRST name heard becomes the target. Nested runs share this progress sink,
      // so once a coordinator starts delegating, its grandchildren's lines arrive here too —
      // and letting each overwrite the target flipped the row to "Delegated to researcher"
      // for a delegation that went to mission_coordinator.
      if (agent && !direct.args?.["agentName"] && !direct.target) direct.target = agent;
      direct.progress = message;
      return;
    }
    // Anything that fans work out — or a line from deeper in a single delegation — goes to the
    // newest running host as progress only. Before, a fan-out row had no way to receive these
    // at all and they were dropped, leaving the row silent while several specialists worked.
    const host = running.find(candidate => FAN_OUT_TOOLS.has(candidate.name)) ?? single[0];
    if (!host) return;
    host.progress = agent && !message.toLowerCase().includes(agent.toLowerCase())
      ? `${agent}: ${message}`
      : message;
  }

  function recordNarration(phase: string, message: string): void {
    const streamingMessage = getStreamingMessage();
    if (!streamingMessage) return;
    const steps = streamingMessage.steps ?? [];
    // The runtime re-announces a phase on each iteration; one line per distinct sentence.
    if (steps.some(step => step.kind === "note" && step.text === message)) return;
    const now = Date.now();
    streamingMessage.steps = [...steps, {
      id: `note-${now}-${steps.length}`,
      kind: "note",
      name: phase,
      depth: 0,
      status: "done",
      startedAt: now,
      endedAt: now,
      text: message,
    }];
  }

  function resolveStreamingToolCall(name: string, result: string, toolCallId?: string): void {
    const { toolCall } = routeToolDone(messages.value, pendingRequestId.value, { name, toolCallId });
    if (toolCall) {
      toolCall.result = result;
    }
  }

  // ── Questions put to the user ────────────────────────────────────────────
  // The image settings card and any later kind (see userInputs). A request lives here from its
  // "needed" event until its "resolved" event, an accepted answer, the end of its turn, or its
  // deadline — whichever comes first. A lost connection is not one of them: the server keeps the
  // question open, and a reload lists it again.

  /** Past the deadline, the server has gone ahead; this is only how long its word may take to arrive. */
  const USER_INPUT_EXPIRY_GRACE_MS = 3_000;

  function scheduleUserInputExpiry(): void {
    if (userInputExpiryTimer) {
      clearTimeout(userInputExpiryTimer);
      userInputExpiryTimer = null;
    }
    const at = nextExpiryAt(userInputs.value, USER_INPUT_EXPIRY_GRACE_MS);
    if (at === null) return;
    userInputExpiryTimer = setTimeout(() => {
      userInputExpiryTimer = null;
      for (const inputId of expiredInputIds(userInputs.value, Date.now(), USER_INPUT_EXPIRY_GRACE_MS)) {
        settleUserInput({ inputId, outcome: "auto", reason: "timeout" });
      }
      scheduleUserInputExpiry();
    }, Math.max(0, at - Date.now()));
  }

  function receiveUserInput(raw: unknown): void {
    const request = readUserInputRequest(raw, Date.now());
    if (!request) return;
    const before = userInputs.value;
    // Only the bubbles of the turn that asked — after a reload the live bubble can be another turn's.
    const bubbles = turnBubbles(messages.value, request.requestId).filter((bubble) => !bubble.requestId || bubble.requestId === request.requestId);
    const anchorStepId = anchorStepFor(bubbles, request);
    userInputs.value = addUserInput(before, anchorStepId ? { ...request, anchorStepId } : request, currentSessionId.value);
    // Another session's question: this page shows one conversation.
    if (userInputs.value === before) return;
    if (request.requestId === pendingRequestId.value) notePendingTurnActivity();
    scheduleUserInputExpiry();
    notifications.pushLocalNotification({
      id: `user-input:${request.inputId}`,
      title: request.title,
      message: "The agent is waiting for your answer before it goes on.",
      level: "info",
      category: "input",
      sessionId: request.sessionId,
    });
  }

  /**
   * Close a card and keep on its step how it came out. `chosen` is what this page sent, when the
   * answer came from here (or as noted when it went out, see respondUserInput) — the step's hint
   * then follows the user's engine, not the agent's. On Auto it follows the agent's settings
   * (stepUserInputRecord).
   */
  function settleUserInput(resolution: UserInputResolution, chosen?: { tier?: string; expectedSeconds?: number }): void {
    const picked = chosen ?? (resolution.outcome === "configured" ? chosenSettings.get(resolution.inputId) : undefined);
    chosenSettings.delete(resolution.inputId);
    const request = userInputs.value[resolution.inputId];
    if (!request) return;
    userInputs.value = removeUserInput(userInputs.value, resolution.inputId);
    notifications.dismiss(`user-input:${resolution.inputId}`);
    if (configuringUserInputId.value === resolution.inputId) configuringUserInputId.value = null;
    const stepId = request.anchorStepId ?? anchorStepFor(turnBubbles(messages.value, request.requestId), request);
    // Searched across the whole list, newest first: a turn that has already landed moved its
    // steps into its answer.
    const step = stepId
      ? [...messages.value].reverse().flatMap((message) => message.steps ?? []).find((candidate) => candidate.id === stepId)
      : undefined;
    if (step) step.userInput = stepUserInputRecord(request, resolution, Date.now(), picked);
    scheduleUserInputExpiry();
    // The wait is over; the stall watchdog counts silence from here, not from when it was asked.
    if (request.requestId === pendingRequestId.value) notePendingTurnActivity();
  }

  function setUserInputErrors(inputId: string, errors: UserInputFieldError[]): void {
    const request = userInputs.value[inputId];
    if (!request) return;
    userInputs.value = { ...userInputs.value, [inputId]: { ...request, errors } };
  }

  /**
   * Replace the session's cards with the server's list of its open questions. `serverNow`, the
   * server's clock sent with the list, gives a question first seen here its deadline on this
   * page's clock (serverClockSkew) — without it a reloaded card on a browser ahead of the gateway
   * was pruned at once and settled as timed out while the server still waited.
   */
  function rehydrateOpenUserInputs(sessionId: string, raw: unknown, listedAt: number, serverNow: unknown): void {
    const now = Date.now();
    userInputs.value = rehydrateUserInputs(userInputs.value, sessionId, readUserInputList(raw, now, serverClockSkew(serverNow, listedAt, now)), now, listedAt);
    scheduleUserInputExpiry();
  }

  function clearUserInputs(): void {
    for (const inputId of Object.keys(userInputs.value)) notifications.dismiss(`user-input:${inputId}`);
    userInputs.value = {};
    configuringUserInputId.value = null;
    scheduleUserInputExpiry();
  }

  /** A turn ended: what it asked is settled server-side, and its cards go with it. */
  function dropUserInputsOfTurn(requestId: string | null | undefined): void {
    const next = dropTurnInputs(userInputs.value, requestId);
    if (next === userInputs.value) return;
    for (const inputId of Object.keys(userInputs.value)) if (!next[inputId]) notifications.dismiss(`user-input:${inputId}`);
    userInputs.value = next;
    scheduleUserInputExpiry();
  }

  /**
   * Answer a card. An accepted answer closes it at once, in case no "resolved" event comes to this
   * connection. Objections stay on the card, which stays open.
   *
   * The engine the user picked is noted BEFORE the answer goes out: the server announces the card
   * resolved before it replies, so that event closes the card here first — and the choice, applied
   * only on the reply, found nothing left to go on, and the running step kept the agent's ETA.
   */
  async function respondUserInput(
    inputId: string,
    answer: { choice: "auto" | "configure" | "skip"; alwaysAuto?: boolean; settings?: unknown },
    chosen?: { tier?: string; expectedSeconds?: number },
  ): Promise<{ ok: boolean; errors?: UserInputFieldError[] }> {
    if (!userInputs.value[inputId]) return { ok: false, errors: [{ field: "inputId", message: "expired" }] };
    if (answer.choice === "configure" && chosen) chosenSettings.set(inputId, chosen);
    else chosenSettings.delete(inputId);
    let result: { ok?: unknown; errors?: unknown } | undefined;
    try {
      result = await rpc("userInput.respond", { inputId, answer }) as { ok?: unknown; errors?: unknown } | undefined;
    } catch (error) {
      chosenSettings.delete(inputId);
      const errors = [{ field: "_form", message: error instanceof Error ? error.message : String(error) }];
      setUserInputErrors(inputId, errors);
      return { ok: false, errors };
    }
    if (result?.ok === true) {
      settleUserInput({ inputId, ...outcomeOfChoice(answer.choice) }, answer.choice === "configure" ? chosen : undefined);
      return { ok: true };
    }
    chosenSettings.delete(inputId);
    const errors = readFieldErrors(result?.errors);
    if (isExpiredAnswer(errors)) {
      settleUserInput({ inputId, outcome: "auto", reason: "timeout" });
      notifications.pushLocalNotification({
        title: "That answer came too late",
        message: "The agent had already gone ahead with its own settings.",
        level: "warn",
        category: "input",
      });
      return { ok: false, errors };
    }
    const shown = errors.length ? errors : [{ field: "_form", message: "The answer was not accepted." }];
    setUserInputErrors(inputId, shown);
    return { ok: false, errors: shown };
  }

  /**
   * Open a card's full form. The short deadline is for choosing Auto or Configure; a form takes
   * longer to fill in, so the server is asked for the longer one. If it refuses, the form still
   * opens and its countdown stays honest about the shorter deadline.
   */
  function openUserInputForm(inputId: string): void {
    if (!userInputs.value[inputId]) return;
    configuringUserInputId.value = inputId;
    void holdUserInput(inputId);
  }

  function closeUserInputForm(): void {
    configuringUserInputId.value = null;
  }

  /** Ask the server for the longer configure deadline. */
  async function holdUserInput(inputId: string): Promise<boolean> {
    try {
      const result = await rpc("userInput.hold", { inputId }) as { expiresAt?: unknown } | undefined;
      const request = userInputs.value[inputId];
      if (request) {
        const expiresAt = typeof result?.expiresAt === "string" && !Number.isNaN(Date.parse(result.expiresAt))
          ? result.expiresAt
          : request.expiresAt;
        userInputs.value = { ...userInputs.value, [inputId]: { ...request, phase: "configure", expiresAt } };
        scheduleUserInputExpiry();
      }
      return true;
    } catch {
      return false;
    }
  }

  /** A base picture at full size, for painting a mask over it. */
  async function previewUserInputCandidate(inputId: string, candidateId: string): Promise<{ dataUrl: string; width: number; height: number }> {
    const result = await rpc("userInput.preview", { inputId, candidateId }, 60_000) as Record<string, unknown> | undefined;
    const dataUrl = result?.["dataUrl"];
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) throw new Error("The picture could not be loaded.");
    return { dataUrl, width: Number(result?.["width"]) || 0, height: Number(result?.["height"]) || 0 };
  }

  function applyAuditEventFallback(event: GatewayAuditEvent): void {
    if (!pendingRequestId.value || !currentSessionId.value || pendingTurnSessionId !== currentSessionId.value) return;

    const sessionId = event.sessionId ?? "";
    const parentSessionId = currentSessionId.value;
    const isMainSessionEvent = sessionId === parentSessionId;
    const isSubSessionEvent = sessionId.startsWith(`sub:${parentSessionId}:`);
    if (!isMainSessionEvent && !isSubSessionEvent) return;

    if (isMainSessionEvent) {
      // A fallback for when the turn's own tool events do not arrive. Once they do, they are the
      // record: applied on top, the audit copies matched calls by name alone and wrote
      // "Completed." over whichever same-named call was still open.
      if (liveToolEventsTurn === pendingRequestId.value) return;
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

  /**
   * What becomes of the messages a turn never read, once it has ended. After a turn that ended
   * on its own they go out together as the next turn. After a stop or an error nothing sends
   * them unasked — they are marked undelivered, with a Resend.
   */
  function settleUnreadSteering(requestId: string, leftovers: SteeringEntry[], endedOnItsOwn: boolean): void {
    const stopped = !endedOnItsOwn || stoppedRequestId === requestId;
    if (stoppedRequestId === requestId) stoppedRequestId = null;
    messages.value = markUnread(messages.value, requestId, leftovers, stopped ? "undelivered" : "held", {
      at: new Date(),
      newId: () => crypto.randomUUID(),
      error: "The turn ended before it read this.",
    });
    if (!stopped) scheduleHeldSend();
  }

  /** `stopped` when the user ended the turn: its note then stays beside what the server saved of it (hydration). */
  function failPendingTurn(errorText: string, preservePendingState = false, leftovers: SteeringEntry[] = [], stopped = false) {
    const requestId = pendingRequestId.value;
    // A turn picked up part-way has the step it is in above its live bubble as well: the note
    // takes all of it, so it stands in for what the server saved of that step (withResumedStep).
    const list = requestId && !preservePendingState ? withResumedStep(messages.value, requestId) : messages.value;
    const idx = list.findIndex(m => m.id === "streaming");
    // No turn and no live bubble: whatever failed has already ended — its own final status got
    // here first. Reporting it now would add a second error under the first.
    if (!requestId && idx < 0) return;
    const streamingMessage = idx >= 0 ? list[idx] : undefined;
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
      pageOnly: true,
      ...(stopped ? { stopped: true } : {}),
      swarmState: preservedSwarmState ?? undefined,
      toolCalls: streamingMessage?.toolCalls,
      attachments: streamingMessage?.attachments,
      // Keep what DID happen before the failure — that is exactly what someone reading an
      // error wants to see, and dropping it left only the error line.
      steps: settleSteps(streamingMessage?.steps, Date.now()),
      ...(requestId ? { requestId } : {}),
    };

    if (!preservePendingState) {
      messages.value = landTurn(list, requestId, errorMsg, Date.now());
      if (requestId) settleUnreadSteering(requestId, leftovers, false);
      streamingText.value = "";
      streamingReasoning.value = "";
      streamingSubAgentReasoning.value = [];
      pendingRequestId.value = null;
      pendingApproval.value = null;
      pendingInputRequest.value = null;
      dropUserInputsOfTurn(requestId);
      pendingIntervention.value = null;
      isStreaming.value = false;
      clearTurnStallState();
      appendSwarmRun("error", preservedSwarmState);
      liveSwarmState.value = null;
      syntheticSwarmState.value = null;
      clearPendingTurnRecovery();
    }

    flashError(5000);
  }

  /**
   * Stop following the pending turn without stopping it: the user moved to another session.
   * The turn goes on on the server; none of its state may stay on the page that now shows
   * something else — its events are dropped from here on, and its banners and buffers go.
   * It is remembered by session, so going back while it still runs can pick it up again.
   *
   * Its live bubble goes at once. Left in the list until the other session's transcript replaced
   * it, it was the bubble a message sent meanwhile found as "the" live one: that turn's steps
   * went into it, and both vanished when the transcript landed. Returned, so a switch that fails
   * can put it back.
   */
  function detachPendingTurn(): { index: number; message: ChatMessage } | undefined {
    const requestId = pendingRequestId.value;
    if (!requestId) return undefined;
    if (pendingTurnSessionId) {
      const eventsComeHere = pendingTurnRecovery.value?.requestId !== requestId;
      detachedTurns.set(pendingTurnSessionId, { requestId, connection: eventsComeHere ? connectionEpoch : null });
    }
    const liveIndex = messages.value.findIndex((message) => message.id === "streaming");
    const live = liveIndex >= 0 ? { index: liveIndex, message: messages.value[liveIndex]! } : undefined;
    if (live) messages.value = messages.value.filter((message) => message !== live.message);
    flushStreamTextNow();
    streamingText.value = "";
    streamingReasoning.value = "";
    streamingSubAgentReasoning.value = [];
    _pendingReasoning = "";
    _pendingSubAgentReasoning.clear();
    pendingRequestId.value = null;
    pendingTurnSessionId = null;
    pendingApproval.value = null;
    pendingInputRequest.value = null;
    pendingIntervention.value = null;
    liveSwarmState.value = null;
    syntheticSwarmState.value = null;
    isStreaming.value = false;
    clearTurnStallState();
    clearPendingTurnRecovery();
    return live;
  }

  /**
   * Follow a turn running on the server that this page is not following: one left when the user
   * switched away, or — after a reload, or in a second tab — one it never saw start. What it did
   * so far is in the transcript, as the segments before a fresh live bubble; from here the
   * composer steers it and Stop stops it.
   *
   * `live` when its events still come to this connection. Otherwise they go to the one it
   * started on, and its answer is read from the transcript once it lands, as after a lost
   * connection — the page no longer looks idle while it runs, and a message typed meanwhile
   * steers it instead of starting a second turn beside it.
   */
  function followServerTurn(requestId: string, sessionId: string, options: { live: boolean; startedAt?: number }): void {
    pendingRequestId.value = requestId;
    pendingTurnSessionId = sessionId;
    pickedUpTurn = { requestId, transcriptOnly: !options.live };
    turnSessions.set(requestId, sessionId);
    messages.value = resumeTurnSegments(messages.value, requestId, stepsFromToolCalls);
    const status = options.live ? "Still working on it…" : "Still running on the server — its answer appears here when it finishes.";
    messages.value.push({
      id: "streaming",
      role: "assistant",
      content: "",
      timestamp: options.startedAt ? new Date(options.startedAt) : new Date(),
      statusText: status,
      statusHistory: [status],
      steps: [],
      requestId,
    });
    if (!options.live) readTranscriptUntilLanded(requestId, sessionId);
    armPendingTurnWatchdog();
  }

  /** Follow the pending turn by reading the transcript until its answer is there (recoverPendingTurn). */
  function readTranscriptUntilLanded(requestId: string, sessionId: string): void {
    clearPendingTurnRecovery();
    pendingTurnRecovery.value = {
      requestId,
      sessionId,
      baselineTotalMessages: currentSessionTranscriptTotalMessages.value,
      startedAt: Date.now(),
      openerText: pendingTurnOpenerText(),
    };
    scheduleTurnRecovery(TURN_RECOVERY_RUNNING_POLL_MS);
  }

  /** Whether the page follows this turn by reading the transcript alone (pickedUpTurn). */
  function readsTranscriptOnly(requestId: string): boolean {
    return pickedUpTurn?.requestId === requestId && pickedUpTurn.transcriptOnly;
  }

  /**
   * Bring a turn followed by reading the transcript up to date with a read of it: no event of it
   * comes here, so its steps only moved when it landed. Only from the message that opened it on
   * — what is above stays as it is, older pages the user loaded included — and only while that
   * message is the server's newest opener.
   */
  function refreshPickedUpTurn(requestId: string, result: GatewaySessionTranscript): void {
    const fetched = mapTranscriptMessages(markRunningTail(result.transcript));
    const from = turnOpenerIndex(fetched);
    const at = turnOpenerIndex(messages.value);
    if (from < 0 || at < 0 || !sameMessage(fetched[from]!, messages.value[at]!)) return;
    const shown = messages.value.slice(at);
    const serverTail = fetched.slice(from);
    const merged = mergeHydrated(serverTail, withoutOutdatedSegments(shown, requestId, serverTail), {
      knownBefore: new Set(shown.map((message) => message.id)),
      sameSession: true,
    });
    const tail = resumeTurnSegments(merged, requestId, stepsFromToolCalls);
    if (!sameList(tail, shown)) messages.value = [...messages.value.slice(0, at), ...tail];
  }

  /** Where the newest turn starts: the last message that opened one — not one sent into it. */
  function turnOpenerIndex(list: ChatMessage[]): number {
    let index = list.length - 1;
    while (index >= 0 && !(list[index]!.role === "user" && !list[index]!.midTurn && !list[index]!.steer)) index -= 1;
    return index;
  }

  /**
   * The turn a freshly read session has running that this page should follow, if any. Its id is
   * the server's word when it gives one; an older server says only that a turn runs, and then
   * only a turn this page left there can be picked up.
   */
  function serverTurnToFollow(sessionId: string, result: GatewaySessionTranscript): { requestId: string; live: boolean; startedAt?: number } | null {
    const detached = detachedTurns.get(sessionId);
    const running = result.activeTurn !== true
      ? undefined
      : typeof result.activeTurnRequestId === "string" && result.activeTurnRequestId ? result.activeTurnRequestId : detached?.requestId;
    // A turn left here stays remembered while its final status can still come to this
    // connection: that status is the only place it says what it never read (noteDetachedTurnEnd).
    if (detached && (detached.requestId === running || detached.connection !== connectionEpoch)) detachedTurns.delete(sessionId);
    if (!running || pendingRequestId.value) return null;
    return {
      requestId: running,
      live: detached?.requestId === running && detached.connection === connectionEpoch,
      ...(typeof result.activeTurnStartedAt === "number" ? { startedAt: result.activeTurnStartedAt } : {}),
    };
  }

  /**
   * A turn the page left in another session ended. What it never read comes back only in this
   * final status, and the bubbles it was typed into left the page with the switch — so it is
   * kept for its session and shown there as undelivered, with a Resend, instead of vanishing.
   */
  function noteDetachedTurnEnd(data: Record<string, unknown>): void {
    const status = data["status"];
    if (status !== "ok" && status !== "blocked" && status !== "error") return;
    const requestId = String(data["requestId"] ?? "");
    const sessionId = [...detachedTurns].find(([, turn]) => turn.requestId === requestId)?.[0];
    if (!sessionId) return;
    detachedTurns.delete(sessionId);
    const leftovers = readSteeringEntries(data["unconsumedSteering"]);
    if (leftovers.length > 0) keepUnread(sessionId, requestId, leftovers, "The turn ended before it read this.");
  }

  /** Messages a turn never read, as undelivered: on screen when their session is, else kept until it is. */
  function keepUnread(sessionId: string, requestId: string | undefined, entries: SteeringEntry[], error: string): void {
    const turnId = requestId ?? "";
    if (currentSessionId.value === sessionId) {
      messages.value = appendUnread(messages.value, turnId, entries, "undelivered", { at: new Date(), newId: () => crypto.randomUUID(), error });
      return;
    }
    unreadSteering.set(sessionId, [...(unreadSteering.get(sessionId) ?? []), { requestId: turnId, entries, error }]);
  }

  function restoreUnreadSteering(sessionId: string): void {
    const kept = unreadSteering.get(sessionId);
    if (!kept) return;
    unreadSteering.delete(sessionId);
    let next = messages.value;
    for (const record of kept) {
      next = appendUnread(next, record.requestId, record.entries, "undelivered", { at: new Date(), newId: () => crypto.randomUUID(), error: record.error });
    }
    if (next !== messages.value) messages.value = next;
  }

  /**
   * What finished turns of the session never read, as the server kept it (session.get
   * `unreadSteering`): their final status found the connection that started them gone — the page
   * was reloaded, or reconnected while the user was elsewhere — so no page ever heard of it, and
   * the message vanished without a trace (review of #10/#32). Shown once each as undelivered,
   * with a Resend; nothing sends it on its own. An older server sends no list.
   *
   * For a session not on screen — the user moved on while the request was out — the list is kept
   * until it is (keepUnread): the server retired it with that answer, and dropped here it was
   * shown to nobody (review of round 3, D M6). They go after the turn they were typed into where
   * the list names its message (unreadPlace). Otherwise `before` places the bubbles above that
   * message — the opening message of a turn after theirs; those of the turn running now go at the end.
   */
  function restoreServerUnread(sessionId: string, raw: unknown, before?: string): void {
    if (!Array.isArray(raw)) return;
    const byTurn = new Map<string, SteeringEntry[]>();
    for (const item of raw) {
      const [entry] = readSteeringEntries([item]);
      // Already sent on as a turn of its own, which no longer carries its mark.
      if (!entry || sentAsFollowUp.has(entry.id)) continue;
      const requestId = typeof (item as Record<string, unknown>)["requestId"] === "string" ? String((item as Record<string, unknown>)["requestId"]) : "";
      // Its Resend goes out in this session (belongsOnScreen).
      if (requestId) turnSessions.set(requestId, sessionId);
      byTurn.set(requestId, [...(byTurn.get(requestId) ?? []), entry]);
    }
    if (currentSessionId.value !== sessionId) {
      for (const [requestId, entries] of byTurn) keepUnread(sessionId, requestId, entries, "The turn ended before it read this.");
      return;
    }
    let next = messages.value;
    for (const [requestId, entries] of byTurn) {
      // After the turn they were typed into, where the list names its message; else above `before`.
      const place = requestId ? unreadPlace(next, requestId) : undefined;
      const above = place === undefined ? (requestId !== pendingRequestId.value ? before : undefined) : place ?? undefined;
      next = appendUnread(next, requestId, entries, "undelivered", {
        at: new Date(),
        newId: () => crypto.randomUUID(),
        error: "The turn ended before it read this.",
        ...(above ? { before: above } : {}),
      });
    }
    if (next !== messages.value) messages.value = next;
  }

  /** Whether a message may go out from the session on screen — not one typed into another session's turn. */
  function belongsOnScreen(message: ChatMessage): boolean {
    return !message.requestId || turnSessions.get(message.requestId) === currentSessionId.value;
  }

  function resetLocalSessionState() {
    detachPendingTurn();
    clearPendingTurnRecovery();
    clearTurnStallState();
    messages.value = [];
    currentSessionTranscriptTotalMessages.value = 0;
    currentSessionTranscriptNextBeforeMessageId.value = null;
    currentSessionTranscriptLoading.value = false;
    streamingText.value = "";
    streamingReasoning.value = "";
    streamingSubAgentReasoning.value = [];
    pendingRequestId.value = null;
    pendingApproval.value = null;
    pendingInputRequest.value = null;
    clearUserInputs();
    pendingIntervention.value = null;
    liveSwarmState.value = null;
    syntheticSwarmState.value = null;
    isStreaming.value = false;
    selectedSwarmRunId.value = null;
  }

  function mapTranscriptMessages(transcript: GatewaySessionTranscriptMessage[]): ChatMessage[] {
    // Dedupe attachments across the entire transcript. The runtime now pins
    // the consolidated artifact list onto the final assistant message of each
    // turn, but the iteration messages still carry tool-call metadata that
    // would otherwise re-extract the same artifact cards. Walk transcript
    // newest → oldest and skip any artifact already attributed upstream so
    // each artifact appears exactly once (preferentially on the final
    // synthesis message, which is the natural "here's what I made" surface).
    const seenKeys = new Set<string>();
    const attachmentKey = (att: ChatAttachment): string =>
      [att.relativePath ?? "", att.dataUrl ?? "", att.externalUrl ?? "", att.filename, att.sourceTool ?? ""].join("::");

    const reversed = transcript.slice().reverse();
    const mappedReversed = reversed.map((message) => {
      const candidate: ChatAttachment[] = [
        ...(message.attachments ?? []),
        ...(message.toolCalls ?? []).flatMap((toolCall) => extractToolAttachments(toolCall.name, toolCall.metadata)),
      ];
      const attachments: ChatAttachment[] = [];
      for (const att of candidate) {
        const key = attachmentKey(att);
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        attachments.push(att);
      }
      return {
        id: message.id,
        role: message.role,
        // A segment the turn continued past is not its answer, so it gets no stand-in text.
        content: message.role === "assistant" ? transcriptAssistantContent(message) : message.content,
        timestamp: new Date(message.timestamp),
        toolCalls: message.toolCalls,
        swarmState: normalizeSwarmState(message.swarmState) ?? undefined,
        attachments,
        ...(message.midTurn ? { midTurn: true } : {}),
        // Read by its turn, under the id this page sent it with — so a copy still marked queued
        // here is recognised as the same message when the transcript comes back.
        ...(message.midTurn && message.steeringId ? { steer: { clientId: message.steeringId, state: "consumed" as const } } : {}),
        ...(message.continued ? { continued: true } : {}),
        // The turn it belongs to, so a message another tab sent in the same words is never taken
        // for this page's own (hydration, turnRecovery).
        ...(message.requestId ? { requestId: message.requestId } : {}),
      };
    });
    return normalizeHydratedMessages(mappedReversed.reverse());
  }


  function getStreamingMessage(): ChatMessage | undefined {
    return messages.value.find((entry) => entry.id === "streaming");
  }

  function updateStreamingStatus(content: string, options: { appendHistory?: boolean } = {}): void {
    const trimmed = content.trim();
    if (!trimmed) return;

    // No live bubble, no line: a routine "Running …" / "Completed …" is part of the turn's
    // bubble, and made into a bubble of its own it read as a message — in whichever
    // conversation was on screen. Connection notices use insertSystemFeedbackMessage directly.
    const streamingMessage = getStreamingMessage();
    if (!streamingMessage) return;

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
    // A turn running in another session goes on running there, but is no longer followed here:
    // its events would land in this session, and a message typed here would steer — or, when
    // that failed, cancel — a turn the user can no longer see.
    const leftBehind = pendingRequestId.value && pendingTurnSessionId !== sessionId ? pendingRequestId.value : null;
    const leftBubble = leftBehind ? detachPendingTurn() : undefined;
    // What the page holds as it asks. Anything added while the answer is on its way — a message
    // sent meanwhile and its live bubble — is not in that answer and must survive it.
    const knownBefore = new Set(messages.value.map((message) => message.id));
    currentSessionId.value = sessionId;
    try {
      const listedAt = Date.now();
      const result = await getSessionTranscript(sessionId, { limit: SESSION_TRANSCRIPT_PAGE_SIZE });
      if (currentSessionId.value !== sessionId) return; // concurrent switch won
      if (!allowArchived && result.session.archivedAt) {
        currentSessionId.value = previousSessionId;
        throw new Error("Archived sessions cannot be resumed");
      }
      currentSessionId.value = result.session.archivedAt ? null : sessionId;
      currentSessionTranscriptTotalMessages.value = result.totalMessages;
      currentSessionTranscriptNextBeforeMessageId.value = result.nextBeforeMessageId ?? null;
      currentSessionEffort.value = result.settings?.effort ?? "medium";
      currentSessionTimeLimitSec.value = result.settings?.turnTimeoutSecOverride ?? null;
      currentSessionImageSettingsPrompt.value = result.settings?.imageSettingsPrompt === "auto" ? "auto" : "ask";
      // The session's open questions replace whatever the page had — a reload's cards come back,
      // another session's go.
      rehydrateOpenUserInputs(sessionId, result.openUserInputs, listedAt, result.serverNow);
      // A read that shows the turn this page recovers has ended — another tab's message replaced
      // it, or it landed between two of the recovery's reads — ends it here, as that read would
      // have. Merged as a turn still running, the next turn's work became this one's, and the note
      // on how it ended went below that work (review of round 3, D #1). An archived session's
      // too: left to the recovery's next read, it did just that until then, and the turn read as
      // "completed without a text summary" after (review of round 4, D #6). A recovery still there
      // once the answer came is for this session's turn on screen: every Stop, send and switch
      // clears it, and a switch that won meanwhile has returned above.
      const recovering = pendingTurnRecovery.value;
      if (recovering && endRecoveredTurn(recovering, result, readRecoveryVerdict(recovering, result))) {
        restoreUnreadSteering(sessionId);
        return;
      }
      // A turn running here that this page does not follow — left when the user switched away,
      // or started before a reload or in another tab: follow it.
      const follow = serverTurnToFollow(sessionId, result);
      // This session's turn, already followed by this page. Where its work so far is shown decides
      // what to do with what the transcript saved of it — not whether its events come here: the
      // page's own turn, seen from its start, has it in its live bubble (dropped here, or shown
      // twice), even while it is read from the transcript after a lost connection; a turn picked
      // up from the transcript has it in its resumed segments (dropped, it vanished).
      const followed = !follow && pendingRequestId.value !== null && pendingTurnSessionId === sessionId ? pendingRequestId.value : null;
      const pickedUp = followed !== null && pickedUpTurn?.requestId === followed;
      const inLiveBubble = followed !== null && !pickedUp && Boolean(getStreamingMessage());
      const transcript = inLiveBubble
        ? dropRunningTail(result.transcript, { requestId: followed ?? undefined, openerText: pendingTurnOpenerText() })
        : follow || followed ? markRunningTail(result.transcript) : result.transcript;
      const fetched = mapTranscriptMessages(transcript);
      // A turn picked up on return and followed live: its events keep the page's copy of it — the
      // segments resumed at the pick-up, then the live bubble — up to date, and the server's copy
      // of that work lags behind. Taken in its place, a call the live bubble showed came back in
      // the server's copy of a segment too, twice, and stayed "never reported back" there once the
      // turn landed (review of round 2, D #3). So the server's list is read up to the message that
      // opened the turn, and the page's own copy follows it — the reverse of refreshPickedUpTurn.
      const ownFrom = pickedUp && followed && !readsTranscriptOnly(followed) && previousSessionId === sessionId ? turnOpenerIndex(messages.value) : -1;
      const serverFrom = ownFrom >= 0 ? turnOpenerIndex(fetched) : -1;
      const ownTurn = serverFrom >= 0 && sameMessage(fetched[serverFrom]!, messages.value[ownFrom]!) ? messages.value.slice(ownFrom + 1) : null;
      const local = ownTurn ? messages.value.slice(0, ownFrom + 1)
        : followed && readsTranscriptOnly(followed) ? withoutOutdatedSegments(messages.value, followed, fetched) : messages.value;
      const merged = mergeHydrated(ownTurn ? fetched.slice(0, serverFrom + 1) : fetched, local, { knownBefore, sameSession: previousSessionId === sessionId });
      // The server's copies that replaced them, and any segment saved since, are the turn's too.
      const shown = ownTurn ? [...merged, ...ownTurn] : pickedUp && followed ? resumeTurnSegments(merged, followed, stepsFromToolCalls) : merged;
      if (!sameList(shown, messages.value)) messages.value = shown;
      restoreUnreadSteering(sessionId);
      restoreServerUnread(sessionId, result.unreadSteering);
      if (follow) followServerTurn(follow.requestId, sessionId, follow);
      applyCurrentSessionRunSelection(currentSessionId.value ?? sessionId);
    } catch (err) {
      if (currentSessionId.value === sessionId) {
        currentSessionId.value = previousSessionId;
      }
      // The switch did not happen, so the turn left behind for it is on screen again, live
      // bubble and all: follow it again as if nothing had changed.
      if (leftBehind && previousSessionId && currentSessionId.value === previousSessionId && !pendingRequestId.value) {
        const left = detachedTurns.get(previousSessionId);
        detachedTurns.delete(previousSessionId);
        if (leftBubble && !getStreamingMessage()) {
          const restored = [...messages.value];
          restored.splice(Math.min(leftBubble.index, restored.length), 0, leftBubble.message);
          messages.value = restored;
        }
        pendingRequestId.value = leftBehind;
        pendingTurnSessionId = previousSessionId;
        // Its events do not come here: go on reading the transcript for its answer.
        if (left?.requestId === leftBehind && left.connection !== connectionEpoch) readTranscriptUntilLanded(leftBehind, previousSessionId);
        armPendingTurnWatchdog();
      }
      throw err;
    } finally {
      currentSessionTranscriptLoading.value = false;
    }
  }

  async function switchSession(sessionId: string): Promise<void> {
    await loadSession(sessionId);
  }

  /**
   * Persist a per-session effort/time-limit setting. Optimistically updates the
   * local refs, then sends the patch; reconciles with the server's echoed value.
   * Pass `effort: null` / `turnTimeoutSec: null` to clear an override.
   */
  async function updateSessionSettings(patch: {
    effort?: EffortTier | null;
    turnTimeoutSec?: number | null;
    imageSettingsPrompt?: ImageSettingsPrompt;
  }): Promise<void> {
    const sessionId = currentSessionId.value;
    if (!sessionId) return;
    if (patch.effort !== undefined) currentSessionEffort.value = patch.effort ?? "medium";
    if (patch.turnTimeoutSec !== undefined) currentSessionTimeLimitSec.value = patch.turnTimeoutSec;
    if (patch.imageSettingsPrompt !== undefined) currentSessionImageSettingsPrompt.value = patch.imageSettingsPrompt;
    try {
      const result = await rpc("session.updateSettings", {
        sessionId,
        ...(patch.effort !== undefined ? { effort: patch.effort ?? "default" } : {}),
        ...(patch.turnTimeoutSec !== undefined ? { turnTimeoutSec: patch.turnTimeoutSec ?? "" } : {}),
        ...(patch.imageSettingsPrompt !== undefined ? { imageSettingsPrompt: patch.imageSettingsPrompt } : {}),
      }) as { settings?: SessionEffortSettings };
      currentSessionEffort.value = result.settings?.effort ?? "medium";
      currentSessionTimeLimitSec.value = result.settings?.turnTimeoutSecOverride ?? null;
      const prompt = result.settings?.imageSettingsPrompt;
      if (prompt === "ask" || prompt === "auto") currentSessionImageSettingsPrompt.value = prompt;
    } catch {
      /* keep the optimistic value; a reload reconciles from the server */
    }
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
      connectTimeoutTimer = null;
      if (ws !== socket || connected.value) return;
      // Closing detaches the socket first, so its own onclose bails as stale — this has to do
      // everything that onclose would. It used to only close, which left `connecting` set
      // forever: every automatic retry refuses to start while a connect is in progress.
      closeActiveSocket("Connect timeout");
      handleConnectionLost("Connect timeout");
    }, CONNECT_TIMEOUT_MS);

    socket.onopen = () => {
      if (ws !== socket) return;          // stale socket
      connecting.value = true;
    };

    socket.onclose = (ev: CloseEvent) => {
      if (ws !== socket) return;          // stale socket — already replaced
      ws = null;

      // Auth failure (4401) or rate-limited (4429) — stop reconnecting
      if (ev.code === 4401 || ev.code === 4429) {
        connected.value = false;
        connecting.value = false;
        notificationsSubscribed.value = false;
        clearConnectTimeout();
        stopHeartbeat();
        rejectPendingRpcs("Connection closed");
        clearReconnectTimer();
        authFailed.value = true;
        token.value = "";
        return;
      }

      handleConnectionLost("Connection closed");
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

  /** A socket that closed, or never opened in time: settle the connection state, keep the turn, retry. */
  function handleConnectionLost(reason: string): void {
    connected.value = false;
    connecting.value = false;
    notificationsSubscribed.value = false;
    clearConnectTimeout();
    stopHeartbeat();
    rejectPendingRpcs(reason);
    if (pendingRequestId.value) {
      beginPendingTurnRecovery();
    }
    scheduleReconnect();
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
    // Clear stale UI state so reconnect starts clean (open questions come back with the session)
    pendingApproval.value = null;
    pendingInputRequest.value = null;
    clearUserInputs();
    pendingIntervention.value = null;
    notificationsSubscribed.value = false;
    liveSwarmState.value = null;
    syntheticSwarmState.value = null;
    isStreaming.value = false;
  }

  /**
   * Whether an event belongs to the turn this page follows, in the session it shows. Both: a
   * turn keeps sending events after the user switched sessions, and a requestId alone once let
   * them into whichever session was on screen.
   */
  function isLiveTurnEvent(data: Record<string, unknown> | undefined): boolean {
    return Boolean(data) && pendingRequestId.value !== null && data!["requestId"] === pendingRequestId.value
      && pendingTurnSessionId === currentSessionId.value;
  }

  function handleServerMessage(msg: Record<string, unknown>) {
    const type = msg["type"] as string;

    if (type === "hello-ok") {
      clearConnectTimeout();
      connected.value = true;
      connecting.value = false;
      consecutiveReconnects = 0;
      connectionEpoch += 1;
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
        // Read again even when nothing changed: the read is also what subscribes this new
        // connection to the session's open questions. Nothing on screen is rebuilt for it —
        // the merge keeps the page's own copy of every message the server still agrees on.
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
      if (isLiveTurnEvent(data)) {
        notePendingTurnActivity();
        isStreaming.value = true;
        appendStreamText(String(data["text"] ?? ""));
      }
      return;
    }

    if (type === "agent.reasoning") {
      const data = msg["data"] as Record<string, unknown>;
      if (isLiveTurnEvent(data)) {
        notePendingTurnActivity();
        // The reasoning lanes were built end-to-end — reset, persisted onto the finished
        // message, rendered by MessageBubble behind its toggle — but this handler dropped
        // every event, so both were always empty. On a delegated build that left the user
        // watching a spinner for twenty-odd minutes with no way to tell work from a hang,
        // which is also the state in which they need to decide whether to stop the run.
        //
        // `delegated` splits the two lanes: a sub-agent's thinking is attributed to the
        // agent that produced it, the orchestrator's own stays in the main lane.
        const text = typeof data["text"] === "string" ? data["text"] : "";
        const sourceAgent = typeof data["sourceAgent"] === "string" ? data["sourceAgent"] : undefined;
        if (text) appendReasoning(text, data["delegated"] === true ? (sourceAgent ?? "sub-agent") : undefined);
      }
      return;
    }

    if (type === "agent.tool_start") {
      const data = msg["data"] as Record<string, unknown>;
      if (isLiveTurnEvent(data)) {
        notePendingTurnActivity();
        liveToolEventsTurn = pendingRequestId.value;
        useShellStore().handleToolStart(data);
        const streamingMessage = getStreamingMessage();
        if (streamingMessage) {
          ensureStreamingToolCall(
            String(data["name"]),
            (data["args"] as Record<string, unknown>) ?? {},
            eventCallId(data),
          );
          recordStepStart(data);
        }
        updateStreamingStatus(`Running ${String(data["name"])}...`, { appendHistory: true });
      }
      return;
    }

    if (type === "agent.swarm") {
      const data = msg["data"] as Record<string, unknown>;
      if (isLiveTurnEvent(data)) {
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
      if (isLiveTurnEvent(data)) {
        notePendingTurnActivity();
        const approvalId = String(data["approvalId"]);
        pendingApproval.value = {
          approvalId,
          requestId: String(data["requestId"]),
          toolName: String(data["toolName"]),
          args: (data["args"] ?? {}) as Record<string, unknown>,
          timeoutMs: typeof data["timeoutMs"] === "number" ? data["timeoutMs"] : undefined,
          expiresAt: typeof data["expiresAt"] === "string" ? String(data["expiresAt"]) : undefined,
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
      if (isLiveTurnEvent(data)) {
        notePendingTurnActivity();
        const inputId = String(data["inputId"]);
        const rawChoices = data["choices"];
        const expiresAt = askUserExpiresAt(data, Date.now());
        pendingInputRequest.value = {
          inputId,
          requestId: String(data["requestId"]),
          question: String(data["question"] ?? ""),
          choices: Array.isArray(rawChoices) ? rawChoices.map(String) : undefined,
          ...(expiresAt ? { expiresAt } : {}),
          ...(typeof data["toolCallId"] === "string" ? { toolCallId: data["toolCallId"] } : {}),
        };
        // Past its deadline the server has answered for the user; a banner still asking would
        // take an answer nothing is waiting for.
        if (inputRequestExpiryTimer) clearTimeout(inputRequestExpiryTimer);
        inputRequestExpiryTimer = expiresAt
          ? setTimeout(() => {
              inputRequestExpiryTimer = null;
              if (pendingInputRequest.value?.inputId === inputId) pendingInputRequest.value = null;
            }, Math.max(0, Date.parse(expiresAt) - Date.now()))
          : null;
      }
      return;
    }

    if (type === "agent.user_input_needed") {
      receiveUserInput(msg["data"]);
      return;
    }

    if (type === "agent.user_input_resolved") {
      const resolution = readUserInputResolution(msg["data"]);
      if (resolution) settleUserInput(resolution);
      return;
    }

    if (type === "agent.intervention") {
      const data = msg["data"] as Record<string, unknown>;
      if (isLiveTurnEvent(data)) {
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
      if (isLiveTurnEvent(data)) {
        notePendingTurnActivity();
        useShellStore().handleToolDone(data);
        // The ask_user call returned, so its question is answered — from here, another tab, or
        // by its timeout — and the banner is stale.
        if (closesAskUser(pendingInputRequest.value, data)) pendingInputRequest.value = null;
        // A call that started before a mid-turn message was read finishes in the segment it
        // started in — its result, its step and anything it made — not in whichever bubble is
        // live when the result arrives.
        const route = routeToolDone(messages.value, pendingRequestId.value, {
          name: String(data["name"]),
          toolCallId: typeof data["toolCallId"] === "string" ? data["toolCallId"] : undefined,
          agent: data["delegated"] === true && typeof data["sourceAgent"] === "string" ? data["sourceAgent"] : undefined,
        });
        if (route.toolCall) {
          route.toolCall.result = String(data["result"] ?? "");
          if (data["metadata"] && typeof data["metadata"] === "object") {
            route.toolCall.metadata = data["metadata"] as Record<string, unknown>;
          }
        }
        if (route.step) finishStep(route.step, data);
        const attachments = extractToolAttachments(String(data["name"]), data["metadata"]);
        if (route.owner && attachments.length) {
          route.owner.attachments = [...(route.owner.attachments ?? []), ...attachments];
        }
        const streamingMessage = getStreamingMessage();
        if (streamingMessage) {
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

    // Sent the moment the runtime reads the queued mid-turn messages, BEFORE its "steering"
    // status, so the status line already lands on the bubble that follows the cut.
    if (type === "agent.steering_consumed") {
      const data = msg["data"] as Record<string, unknown>;
      if (isLiveTurnEvent(data)) {
        notePendingTurnActivity();
        splitStreamingAtSteering(data);
      }
      return;
    }

    // What a turn never read, kept by the server because the connection that started the turn was
    // gone when it ended — told to every page attached to the session. It came only with the reply
    // to the session's next message, below that turn's answer, or with a reload (review of round
    // 3, B #1). Shown as undelivered, once per message, with a Resend: nothing sends it unasked.
    if (type === "agent.unread_steering") {
      const data = msg["data"] as Record<string, unknown> | undefined;
      if (!data || typeof data["sessionId"] !== "string") return;
      // It comes once the stopped turn has unwound, often after the session's next turn started:
      // typed before that turn's message, it goes above it. Only for a turn whose events come
      // here: a turn followed by reading the transcript can itself have been replaced by the
      // turn the message was typed into, and above its message the message read as typed before
      // it (review of round 4, D #2). There it goes at the end. So it does once the followed
      // turn's final status is here, held for a read of the session: the turn has ended, and
      // another tab's turn can have replaced it (review of round 5, D R3). All this is for a turn
      // the list does not name: one it names places its messages itself (restoreServerUnread).
      const sessionId = data["sessionId"];
      const followedLive = pendingRequestId.value !== null && pendingTurnRecovery.value?.requestId !== pendingRequestId.value
        && !heldFinalStatuses.has(pendingRequestId.value);
      const opener = followedLive && pendingTurnSessionId === sessionId ? messages.value[turnOpenerIndex(messages.value)] : undefined;
      restoreServerUnread(sessionId, data["messages"], opener?.id);
      return;
    }

    if (type === "status") {
      const data = msg["data"] as Record<string, unknown>;
      if (!isLiveTurnEvent(data)) {
        if (data) noteDetachedTurnEnd(data);
        return;
      }
      notePendingTurnActivity();

      const status = data["status"] as string;

      if (status === "accepted") {
        const feedback = buildAcceptedStatusMessage(data);
        if (feedback) {
          updateStreamingStatus(feedback, { appendHistory: true });
        }
        return;
      }

      // An allowlist rather than a passthrough, because the runtime also emits internal
      // bookkeeping phases (`shared_finding_auto`, `shared_finding_skipped`) that mean nothing
      // to a reader. But it had fallen behind what the runtime emits: `steering`, `oversight`
      // and `recovered` were all being dropped on the floor. Those are the three a reader most
      // wants — that an interjection was folded in, that the turn corrected itself, and that it
      // recovered from a failure — and dropping them is why a long turn looks silent.
      if (["routing", "reviewing", "synthesizing", "guardrail", "delegating",
        "steering", "oversight", "recovered"].includes(status)) {
        const message = String(data["message"] ?? "").trim();
        if (message) {
          updateStreamingStatus(message, { appendHistory: true });
          if (data["delegated"] === true) {
            recordDelegationProgress(typeof data["sourceAgent"] === "string" ? data["sourceAgent"] : undefined, message);
          } else if (NARRATION_PHASES.has(status)) {
            recordNarration(status, message);
          }
        }
        return;
      }

      // A turn that ends with a status this page did not cause — no Stop here — may have been
      // replaced by a message from another tab: the session is read first (endUnlessReplaced).
      if ((status === "blocked" || status === "error") && stoppedRequestId !== data["requestId"] && finalStatusRead !== data["requestId"]) {
        void endUnlessReplaced(data);
        return;
      }

      if (status === "ok" || status === "blocked") {
        flushStreamTextNow(); // apply any buffered streamed text before snapshotting it
        flushReasoningNow();  // …and the buffered reasoning, which is snapshotted with it
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
          steps: settleSteps(streamingMessage?.steps, Date.now()),
          // The whole turn's figures, on its answer: the segments before a mid-turn message
          // keep only their own work.
          swarmState: swarmState ?? undefined,
          usage: data["usage"] as TurnUsage | undefined,
          perf: rawPerf ? {
            turnDurationMs: Number(rawPerf["turnDurationMs"] ?? 0),
            llmCalls: Number(rawPerf["llmCalls"] ?? 0),
            llmTimeMs: Number(rawPerf["llmTimeMs"] ?? 0),
            toolIterations: Number(rawPerf["toolIterations"] ?? 0),
            finishReason: String(rawPerf["finishReason"] ?? ""),
          } : undefined,
          reasoning: streamingReasoning.value.trim() || undefined,
          subAgentReasoning: streamingSubAgentReasoning.value.length > 0
            ? streamingSubAgentReasoning.value.map((entry) => ({ ...entry }))
            : undefined,
          requestId: String(data["requestId"]),
        };
        messages.value = landTurn(messages.value, String(data["requestId"]), finalMsg, Date.now());
        streamingText.value = "";
        streamingReasoning.value = "";
        streamingSubAgentReasoning.value = [];
        pendingRequestId.value = null;
        isStreaming.value = false;
        clearTurnStallState();
        clearPendingTurnRecovery();
        if (isBlocked) flashError(3000);
        else clearErrorFlash();
        pendingApproval.value = null;
        pendingInputRequest.value = null;
        dropUserInputsOfTurn(String(data["requestId"]));
        appendSwarmRun(isBlocked ? "blocked" : "ok", swarmState);
        liveSwarmState.value = null;
        syntheticSwarmState.value = null;
        settleUnreadSteering(String(data["requestId"]), readSteeringEntries(data["unconsumedSteering"]), true);
        return;
      }

      if (status === "error") {
        const errorText = String(data["error"] ?? "An unexpected error occurred.");
        failPendingTurn(errorText, false, readSteeringEntries(data["unconsumedSteering"]));
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
    currentSessionImageSettingsPrompt.value = "ask";
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

  /**
   * Answer the agent's question. False when the answer came too late: the server had already
   * given the agent an empty one, and says so rather than let the person believe they were heard.
   */
  async function respondInput(inputId: string, answer: string): Promise<boolean> {
    const result = await rpc("input.respond", { inputId, answer }) as { ok?: unknown; errors?: unknown } | undefined;
    if (pendingInputRequest.value?.inputId === inputId) pendingInputRequest.value = null;
    if (result?.ok === false && isExpiredAnswer(readFieldErrors(result.errors))) {
      notifications.pushLocalNotification({
        title: "That answer came too late",
        message: "The agent had already gone on without it.",
        level: "warn",
        category: "input",
      });
      return false;
    }
    return true;
  }

  function dismissIntervention(): void {
    pendingIntervention.value = null;
  }

  async function cancelTurn(): Promise<void> {
    const rid = pendingRequestId.value;
    if (!rid) return;
    // A turn this page follows by reading the transcript was started on another connection —
    // before a reload, in another tab — and that connection is the one holding it.
    const elsewhere = pendingTurnRecovery.value?.requestId === rid;
    const sessionId = pendingTurnSessionId ?? currentSessionId.value;
    // Noted before the cancel goes out: the stopped turn's own final status can arrive first,
    // and what it never read must not then be sent on as though it had ended by itself.
    stoppedRequestId = rid;
    // Its final status is here, held for a read of the session: the turn has ended, and that
    // status says how. The Stop's note in its place read an error the page already had as the
    // user's Stop (review of round 5, D R2).
    const held = takeHeldStatus(rid);
    if (held) {
      landHeldStatus(held);
      return;
    }
    let reply: { cancelled?: unknown; known?: unknown } | undefined;
    try {
      reply = await rpc("chat.cancel", { requestId: rid }) as typeof reply;
    } catch { /* ignore — WS may have closed */ }
    let stopped = reply ? reply.cancelled === true : undefined;
    // Stopped by its session only when the server does not know the turn — another instance
    // holds it — or could not be asked. One it knows has ended, or was stopped already by a
    // message from another tab: a session-wide Stop sent for it stopped the turn running there
    // now (review of round 2, B #2).
    if (elsewhere && stopped !== true && (!reply || reply.known === false) && sessionId) stopped = await stopSessionTurn(sessionId);
    // The stopped turn's own final status can arrive while the cancel is out, and land the turn
    // itself; a new message may even have started the next one. Either way this turn is no
    // longer pending, and failing "it" now would add a second error — or fail the new turn.
    if (pendingRequestId.value !== rid) return;
    // Nothing was running to stop: it ended on its own, or was stopped already. Its answer, if it
    // has one, is in the transcript — read once, not waited on: a turn running there now is another.
    if (elsewhere && stopped === false) {
      stoppedRequestId = null;
      if (pendingTurnRecovery.value?.requestId === rid) pendingTurnRecovery.value.stopped = true;
      void recoverPendingTurn();
      return;
    }
    // Surface cancellation locally even if RPC failed
    failPendingTurn("Turn cancelled by user.", false, [], true);
  }

  /** Stop whatever turn runs on a session. True when one was running, undefined when the request failed. */
  async function stopSessionTurn(sessionId: string): Promise<boolean | undefined> {
    try {
      const res = await authorizedFetch(`/api/sessions/${encodeURIComponent(sessionId)}/stop`, { method: "POST" });
      const data = await res.json() as { stopping?: unknown; active?: unknown };
      return data?.stopping === true || data?.active === true;
    } catch {
      return undefined;
    }
  }

  /**
   * End a turn a newer message replaced — this page's, or another tab's (finishRecoveredTurn) —
   * with a stub where its live bubble was.
   *
   * Keep what the cancelled turn already DID. Deleting the placeholder outright threw away
   * its steps and any file it had produced, so an image generated a minute into a turn
   * vanished from the conversation the moment the user sent something else. A turn that
   * did nothing yet still disappears, as before. A turn picked up part-way has the step it was
   * in above its live bubble too (withResumedStep). `didWork` when the server's copy says the turn
   * did something the live bubble does not show: a step with words stays above it, and without
   * the stub that step read as the turn's answer.
   */
  function landReplacedTurn(rid: string, didWork = false): void {
    const list = withResumedStep(messages.value, rid);
    const placeholder = list.find((message) => message.id === "streaming");
    const steps = settleSteps(placeholder?.steps, Date.now());
    const stub: ChatMessage | null = placeholder && (didWork || steps?.length || placeholder.toolCalls?.length || placeholder.attachments?.length)
      ? {
          id: crypto.randomUUID(),
          role: "assistant",
          content: "_Stopped — replaced by your next message._",
          timestamp: new Date(),
          pageOnly: true,
          stopped: true,
          steps,
          toolCalls: placeholder.toolCalls,
          attachments: placeholder.attachments,
          requestId: rid,
        }
      : null;
    messages.value = landTurn(list, rid, stub, Date.now());
  }

  async function supersedePendingTurn(): Promise<void> {
    const rid = pendingRequestId.value;
    if (!rid) return;

    try {
      await rpc("chat.cancel", { requestId: rid });
    } catch {
      // Ignore transport failures here so a replacement turn can still start.
    }
    // It landed on its own while the cancel was out; its answer stands, and there is no live
    // bubble left to turn into a stub.
    if (pendingRequestId.value !== rid) return;

    landReplacedTurn(rid);
    settleUnreadSteering(rid, [], false);

    streamingText.value = "";
    streamingReasoning.value = "";
    streamingSubAgentReasoning.value = [];
    pendingRequestId.value = null;
    pendingApproval.value = null;
    pendingInputRequest.value = null;
    dropUserInputsOfTurn(rid);
    pendingIntervention.value = null;
    liveSwarmState.value = null;
    syntheticSwarmState.value = null;
    isStreaming.value = false;
    clearTurnStallState();
    clearPendingTurnRecovery();
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
   *
   * Both sides are cut, or neither: when the server's copy of the message cannot be found, this
   * throws and nothing changes — cutting only here left the page and the server telling two
   * different conversations. Never while a turn runs, which would cut its history under it.
   */
  async function rewindToMessage(msgId: string): Promise<string> {
    const sid = currentSessionId.value;
    if (!sid) throw new Error("No active session");
    if (pendingRequestId.value) throw new Error("a turn is still running — stop it first");

    const msgIndex = messages.value.findIndex((m) => m.id === msgId);
    if (msgIndex < 0) throw new Error("Message not found");

    const msg = messages.value[msgIndex]!;
    const text = msg.content;

    let historyIndex = transcriptHistoryIndex(msgId);
    if (historyIndex === null) {
      // Sent from this page, so known here by a local id: find its place in the transcript, reading
      // older pages until the transcript reaches back to it.
      let transcript: GatewaySessionTranscriptMessage[] = [];
      let beforeMessageId: string | undefined;
      for (let page = 0; page < REWIND_MAX_TRANSCRIPT_PAGES; page += 1) {
        const result = await getSessionTranscript(sid, { limit: 200, ...(beforeMessageId ? { beforeMessageId } : {}) });
        transcript = [...result.transcript, ...transcript];
        beforeMessageId = result.nextBeforeMessageId;
        if (!needsOlderTranscript(messages.value, msgIndex, transcript) || !beforeMessageId) break;
      }
      historyIndex = rewindHistoryIndex(messages.value, msgIndex, transcript);
    }
    if (historyIndex === null) throw new Error("that message is not in the saved conversation");
    if (currentSessionId.value !== sid || pendingRequestId.value) throw new Error("the conversation changed while restarting");

    await rpc("session.rewind", { sessionId: sid, historyIndex });

    // Truncate local messages to exclude the target message and everything after
    messages.value = messages.value.slice(0, msgIndex);
    return text;
  }

  async function appendPendingUserMessage(content: string, attachments?: ChatAttachment[]): Promise<string> {
    if (!currentSessionId.value) await createSession();

    const id = crypto.randomUUID();
    // The message that opens the next turn (one whose attachments had to be read first). A
    // message sent INTO a running turn does not come through here: it goes to the end marked
    // queued, and moves to where the turn read it (steerRunningTurn).
    messages.value.push({
      id,
      role: "user",
      content,
      timestamp: new Date(),
      attachments: cloneAttachments(attachments),
    });
    return id;
  }

  /**
   * Hand a message to the RUNNING turn on this session: the server queues it for the model's
   * next step and says whether a turn took it. Never throws. A transport or HTTP failure —
   * including the input guardrail refusing the text — comes back as `error`, never as "no turn
   * is running", because the caller must not treat a refused message as one to send anew.
   *
   * `requestId` names the turn it was typed into, and only that turn takes it. Without it the
   * server queued it into whichever turn held the session: a page still showing a turn another
   * tab had replaced steered the replacement, and the message stayed "Queued" under a turn that
   * would never read it, or went twice after a Resend (review of round 5, D E3). The server's
   * refusal comes back as `ended`, its words, with the turn running now as `runningNow` when it
   * names one, and as `replacedBy` the turn that took the session from the one it was typed into,
   * when one did — named even after that turn has ended too.
   */
  async function steerTurn(
    sessionId: string,
    message: string,
    clientMessageId?: string,
    requestId?: string,
  ): Promise<{ steered: boolean; active: boolean; id?: string; error?: string; ended?: string; runningNow?: string; replaced?: true; replacedBy?: string }> {
    try {
      const res = await authorizedFetch(`/api/sessions/${encodeURIComponent(sessionId)}/steer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, ...(clientMessageId ? { clientMessageId } : {}), ...(requestId ? { requestId } : {}) }),
      });
      const data = await res.json() as { steered?: boolean; active?: boolean; id?: string; error?: unknown; activeTurnRequestId?: unknown; replaced?: unknown; replacedBy?: unknown };
      return {
        steered: data?.steered === true,
        active: data?.active === true,
        ...(typeof data?.id === "string" ? { id: data.id } : {}),
        ...(data?.steered !== true && typeof data?.error === "string" ? { ended: data.error } : {}),
        ...(typeof data?.activeTurnRequestId === "string" && data.activeTurnRequestId ? { runningNow: data.activeTurnRequestId } : {}),
        // A turn no chat.send started (a job, AG-UI) takes the session with no id to name: `replaced`
        // alone says the chat moved on (turn-ids review round 2, LOW 2).
        ...(data?.steered !== true && data?.replaced === true ? { replaced: true as const } : {}),
        ...(data?.steered !== true && typeof data?.replacedBy === "string" && data.replacedBy ? { replacedBy: data.replacedBy } : {}),
      };
    } catch (error) {
      return { steered: false, active: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  function findSteer(clientId: string): ChatMessage | undefined {
    return messages.value.find((message) => message.role === "user" && message.steer?.clientId === clientId);
  }

  /**
   * Send a message into the running turn. Its bubble goes at the END first, marked queued, and
   * only then is it sent: the server can read it before the reply to this request arrives, and
   * that read needs a bubble to move. The running turn is never cancelled for it — a message
   * that cannot be delivered says so and offers a resend.
   */
  async function steerRunningTurn(text: string): Promise<SteerOutcome | null> {
    const requestId = pendingRequestId.value;
    const sessionId = currentSessionId.value;
    if (!requestId || !sessionId) return null;
    const clientId = crypto.randomUUID();
    // Steered even while this turn's final status is held for a read of the session: the turn that
    // replaced it may be the one running now, and /steer reaches it. Landing the held status first
    // and sending the message by chat.send stopped that other tab's turn (review of round 6, G1).
    // A message no running turn took, typed into a turn no other replaced, lands the held status in
    // deliverSteer, then goes out as the next turn.
    messages.value.push(newSteerMessage({ id: crypto.randomUUID(), clientId, text, requestId, at: new Date() }) as ChatMessage);
    return deliverSteer(sessionId, clientId);
  }

  /**
   * Null only when nothing went out. Every other answer means the text is on its way or in the
   * chat, and the caller must not hand it back to the composer, where Enter sent it twice.
   * "sent": it has already gone out as the next turn.
   */
  async function deliverSteer(sessionId: string, clientId: string): Promise<SteerOutcome | null> {
    const pending = findSteer(clientId);
    if (!pending) return null;
    const { content: text, requestId } = pending;
    const reply = await steerTurn(sessionId, text, clientId, requestId);
    // Look again: while the request was out, the turn may have read it, ended, or failed — or
    // the user moved to another session.
    const message = findSteer(clientId);
    if (!message?.steer || currentSessionId.value !== sessionId) {
      // The turn's final status listed it before this reply came back, and it has already gone
      // out as the next turn, without its mark.
      if (sentAsFollowUp.has(clientId)) return "sent";
      // The turn has it: it reads it, or lists it when it ends (noteDetachedTurnEnd).
      if (reply.steered) return "queued";
      // Nothing took it, and nothing here may send it on — the session on screen may be another.
      const error = reply.error ?? "The turn ended before it read this.";
      if (message?.steer?.state === "queued") message.steer = { clientId, state: "undelivered", error };
      keepUnread(sessionId, requestId, [{ id: clientId, text }], error);
      return "undelivered";
    }
    if (message.steer.state !== "queued") return message.steer.state;
    if (reply.error) {
      message.steer = { clientId, state: "undelivered", error: reply.error };
      return "undelivered";
    }
    if (reply.steered && pendingRequestId.value === message.requestId) return "queued";
    // Another turn holds the session, or took it from the one this was typed into and has ended
    // since (`replacedBy`): a message from another tab moved the chat on. It is not the other
    // turn's to read unasked — offered to Resend, which sends it into the turn the page follows by
    // then — and the page moves on to that turn. With nothing running it was taken for a turn that
    // simply ended, and went out by itself as a new turn after the other tab's (turn-ids review, LOW 2).
    if (reply.ended !== undefined && (reply.active || reply.replaced === true || reply.replacedBy !== undefined)) {
      message.steer = { clientId, state: "undelivered", error: reply.ended };
      followReplacement(sessionId, message.requestId, reply.runningNow);
      return "undelivered";
    }
    // No running turn holds it, and none took the session from the turn it was typed into: the
    // server had already finished that turn (its final status is still on its way), or that turn
    // ended without listing it. Either way it goes out as the next turn.
    // The turn's final status may be here, held for a read of the session (endUnlessReplaced): it
    // lands first, so the message goes out as the next turn once it has. scheduleHeldSend, not an
    // awaited send, so the page still sees the landed turn's loading edge (review of round 6, G2).
    const held = message.requestId ? heldFinalStatuses.get(message.requestId) : undefined;
    if (held) {
      heldFinalStatuses.delete(message.requestId!);
      landHeldStatus(held);
    }
    const again = findSteer(clientId);
    if (again?.steer) again.steer = { clientId, state: "held" };
    scheduleHeldSend();
    return "held";
  }

  /**
   * The server refused a message typed into `requestId`: that turn has ended, and another holds
   * the session — `runningNow`, when the server names it. The page moves on to that turn as it
   * would once a read showed it. Followed by reading the transcript, the turn is read at once
   * rather than at the next poll; followed live, its final status is on its way or held for a read
   * of the session (endUnlessReplaced), and either moves on. Landed already, as it came — the read
   * was out before the other turn started — the turn running now is picked up as a Continue does.
   * A turn that took the session and has ended too (`replacedBy`, nothing running) leaves none to
   * pick up.
   */
  function followReplacement(sessionId: string, requestId: string | undefined, runningNow: string | undefined): void {
    if (currentSessionId.value !== sessionId) return;
    if (requestId && pendingRequestId.value === requestId) {
      if (pendingTurnRecovery.value?.requestId === requestId) {
        clearTurnRecoveryTimer();
        scheduleTurnRecovery(0);
      }
      return;
    }
    if (!pendingRequestId.value && runningNow) void loadSession(sessionId).catch(() => undefined);
  }

  /**
   * Send what is held as the next turn, once nothing runs. Deferred a tick so the turn that just
   * ended is SEEN to end: the finished-turn watchers (read the answer aloud, re-arm the voice
   * loop) fire on that edge, and starting the next turn in the same tick would swallow it.
   */
  function scheduleHeldSend(): void {
    if (heldSendTimer !== null) return;
    heldSendTimer = setTimeout(() => {
      heldSendTimer = null;
      void sendHeldSteers();
    }, 0);
  }

  async function sendHeldSteers(): Promise<void> {
    // A running turn sends them itself when it lands.
    if (pendingRequestId.value) return;
    const followUp = takeFollowUp(messages.value, new Date(), belongsOnScreen, () => crypto.randomUUID());
    if (!followUp) return;
    for (const clientId of followUp.clientIds) sentAsFollowUp.add(clientId);
    for (const oldest of sentAsFollowUp) {
      if (sentAsFollowUp.size <= 200) break;
      sentAsFollowUp.delete(oldest);
    }
    messages.value = followUp.messages;
    try {
      await sendMessage(followUp.text, lastEnableThinking, undefined, undefined, { userMessageId: followUp.messageId });
    } catch {
      // sendMessage has already turned the failure into an error bubble.
    }
  }

  /** Try an undelivered message again: into the running turn when there is one, else as a turn of its own. */
  async function resendSteer(messageId: string): Promise<void> {
    const message = messages.value.find((entry) => entry.id === messageId && entry.steer?.state === "undelivered");
    const sessionId = currentSessionId.value;
    if (!message?.steer || !sessionId || !belongsOnScreen(message)) return;
    const clientId = message.steer.clientId;
    if (pendingRequestId.value) {
      messages.value = resteer(messages.value, messageId, "queued", pendingRequestId.value, new Date());
      await deliverSteer(sessionId, clientId);
      return;
    }
    messages.value = resteer(messages.value, messageId, "held", null, new Date());
    await sendHeldSteers();
  }

  /** The runtime read the queued mid-turn messages: cut the live bubble at that point (see turnSegments). */
  function splitStreamingAtSteering(data: Record<string, unknown>): void {
    const read = readSteeringEntries(data["messages"]);
    if (read.length === 0) return;
    flushStreamTextNow();
    flushReasoningNow();
    const live = getStreamingMessage();
    const at = typeof data["at"] === "string" && !Number.isNaN(Date.parse(data["at"])) ? new Date(data["at"]) : new Date();
    const segmentText = data["discardedDraft"] === true || typeof data["segmentText"] !== "string" ? "" : data["segmentText"];
    messages.value = splitAtSteering(messages.value, { requestId: String(data["requestId"]), at, messages: read }, {
      // The server's word for what the transcript keeps of the part before the cut, so a reload
      // reads the same. Never the streamed text: a step that calls tools does not stream its
      // words, so all that can be in the stream at a cut is a draft the runtime rejected and
      // never kept — frozen above the user's message as if it were part of the answer.
      content: mergeSegmentAssistantContent(segmentText, live?.toolCalls),
      reasoning: streamingReasoning.value,
      subAgentReasoning: streamingSubAgentReasoning.value,
      swarmState: liveSwarmState.value ?? syntheticSwarmState.value ?? undefined,
    }, () => crypto.randomUUID());
    // The segment took the live text and thinking with it; the bubble after the cut starts empty.
    // isStreaming stays as it is: the turn is still running, and the reasoning lane only keeps
    // what arrives while it is set.
    streamingText.value = "";
    streamingReasoning.value = "";
    streamingSubAgentReasoning.value = [];
  }

  async function sendMessage(
    text: string,
    enableThinking?: boolean,
    displayContent?: string,
    attachments?: ChatAttachment[],
    options: SendMessageOptions = {},
  ): Promise<void> {
    if (pendingRequestId.value) {
      await supersedePendingTurn();
    }

    if (!currentSessionId.value) await createSession();

    lastEnableThinking = enableThinking;
    const displayText = displayContent ?? text;
    const existingUserMessage = options.userMessageId
      ? messages.value.find((message) => message.id === options.userMessageId && message.role === "user")
      : undefined;
    const openerId = existingUserMessage?.id ?? crypto.randomUUID();
    const requestId = Math.random().toString(36).slice(2);
    // The turn's message names the turn, as the server's copy of it does: another tab's message
    // in the same words is then never taken for it (hydration's sameMessage).
    if (existingUserMessage) {
      existingUserMessage.content = displayText;
      existingUserMessage.attachments = cloneAttachments(attachments);
      existingUserMessage.requestId = requestId;
    } else {
      messages.value.push({
        id: openerId,
        role: "user",
        content: displayText,
        timestamp: new Date(),
        attachments: cloneAttachments(attachments),
        requestId,
      });
    }

    pendingRequestId.value = requestId;
    pendingTurnSessionId = currentSessionId.value;
    if (pendingTurnSessionId) turnSessions.set(requestId, pendingTurnSessionId);
    liveToolEventsTurn = null;
    streamingText.value = "";
    streamingReasoning.value = "";
    streamingSubAgentReasoning.value = [];
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
      steps: [],
      requestId,
    });
    armPendingTurnWatchdog();

    const sentTo = currentSessionId.value;
    try {
      const reply = await rpc("chat.send", {
        sessionId: currentSessionId.value,
        message: text,
        requestId,
        displayContent: displayText,
        attachments: attachmentsForRpc(attachments),
        ...(enableThinking !== undefined && { enableThinking }),
      }) as { accepted?: unknown; unreadSteering?: unknown } | undefined;
      if (reply?.accepted === true) acceptedRequestId = requestId;
      // What the turn this one replaced never read, retired as this one started: this page's own
      // messages are marked already (supersedePendingTurn), but one sent into it from another tab
      // was kept for the session and dropped by this very start, shown to nobody (review of
      // round 2, B #5). Typed before this turn's message, they go above it.
      if (sentTo) restoreServerUnread(sentTo, reply?.unreadSteering, openerId);
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

  /**
   * Persist a document into the session's workspace uploads/ folder and return
   * its workspace-relative path. Sent as an attachment on the next message so the
   * runtime's document-RAG hook ingests it into engram (instead of inlining the
   * whole file into the prompt).
   */
  async function persistAttachment(
    file: File,
    sessionId: string,
  ): Promise<{ filename: string; relativePath: string; contentType: string; size: number }> {
    const formData = new FormData();
    formData.append("file", file, file.name);
    formData.append("sessionId", sessionId);
    const response = await authorizedFetch("/api/multimodal/persist-attachment", {
      method: "POST",
      body: formData,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `Attachment upload failed (HTTP ${response.status})`);
    }
    return await response.json() as { filename: string; relativePath: string; contentType: string; size: number };
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

  // ── Orchestration tuning ────────────────────────────────────────────────
  async function getOrchestrationConfig(): Promise<OrchestrationConfigResponse> {
    const response = await authorizedFetch("/api/orchestration/config");
    return await response.json() as OrchestrationConfigResponse;
  }

  async function saveOrchestrationConfig(config: OrchestrationConfig): Promise<OrchestrationConfig> {
    const response = await authorizedFetch("/api/orchestration/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    return await response.json() as OrchestrationConfig;
  }

  // ── Effort profiles (global default tier) ───────────────────────────────
  async function getEffortConfig(): Promise<{ config: { default: EffortTier }; tiers: EffortTier[] }> {
    const response = await authorizedFetch("/api/effort/config");
    return await response.json() as { config: { default: EffortTier }; tiers: EffortTier[] };
  }

  async function saveEffortDefault(tier: EffortTier): Promise<void> {
    await authorizedFetch("/api/effort/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ default: tier }),
    });
  }

  async function getSkillLibraryConfig(): Promise<SkillFeatureConfig> {
    const response = await authorizedFetch("/api/skill-library/config");
    return await response.json() as SkillFeatureConfig;
  }

  async function saveSkillLibraryConfig(config: Partial<SkillFeatureConfig>): Promise<SkillFeatureConfig> {
    const response = await authorizedFetch("/api/skill-library/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    return await response.json() as SkillFeatureConfig;
  }

  async function getDocumentRagConfig(): Promise<DocumentRagConfig> {
    const response = await authorizedFetch("/api/retrieval/document-rag/config");
    return (await response.json() as { documentRag: DocumentRagConfig }).documentRag;
  }

  async function saveDocumentRagConfig(config: Partial<DocumentRagConfig>): Promise<DocumentRagConfig> {
    const response = await authorizedFetch("/api/retrieval/document-rag/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentRag: config }),
    });
    return (await response.json() as { documentRag: DocumentRagConfig }).documentRag;
  }

  // ── Document RAG management ─────────────────────────────────────────────
  async function listDocuments(): Promise<DocumentListResponse> {
    const response = await authorizedFetch("/api/documents");
    return await response.json() as DocumentListResponse;
  }

  async function uploadDocument(file: File, scope: "user" | "workspace" | "session", sessionId?: string): Promise<{ documentId: string; title: string; scope: string; chunkCount: number }> {
    const formData = new FormData();
    formData.append("file", file, file.name);
    formData.append("scope", scope);
    if (sessionId) formData.append("sessionId", sessionId);
    const response = await authorizedFetch("/api/documents", { method: "POST", body: formData });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `Upload failed (HTTP ${response.status})`);
    }
    return await response.json() as { documentId: string; title: string; scope: string; chunkCount: number };
  }

  async function invalidateDocument(id: string, sessionId?: string): Promise<void> {
    const q = sessionId ? `?${new URLSearchParams({ sessionId })}` : "";
    const response = await authorizedFetch(`/api/documents/${encodeURIComponent(id)}/invalidate${q}`, { method: "POST" });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `Mark-outdated failed (HTTP ${response.status})`);
    }
  }

  async function deleteDocument(id: string, scope?: string, sessionId?: string): Promise<void> {
    const q = new URLSearchParams();
    if (scope) q.set("scope", scope);
    if (sessionId) q.set("sessionId", sessionId);
    const qs = q.toString();
    const response = await authorizedFetch(`/api/documents/${encodeURIComponent(id)}${qs ? `?${qs}` : ""}`, { method: "DELETE" });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `Delete failed (HTTP ${response.status})`);
    }
  }

  async function fetchDocumentFileBlob(id: string): Promise<Blob> {
    const response = await authorizedFetch(`/api/documents/${encodeURIComponent(id)}/file`);
    if (!response.ok) throw new Error(`Could not load the original file (HTTP ${response.status})`);
    return await response.blob();
  }

  async function getUserModel(): Promise<UserModelProfile> {
    const response = await authorizedFetch("/api/user-model");
    return await response.json() as UserModelProfile;
  }

  async function saveUserModel(input: UserModelInput): Promise<UserModelProfile> {
    const response = await authorizedFetch("/api/user-model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    return await response.json() as UserModelProfile;
  }

  async function resetUserModel(): Promise<UserModelProfile> {
    const response = await authorizedFetch("/api/user-model/reset", { method: "POST" });
    return await response.json() as UserModelProfile;
  }

  async function getMemoryCuration(): Promise<MemoryCurationReport> {
    const response = await authorizedFetch("/api/memory/curation");
    return await response.json() as MemoryCurationReport;
  }

  async function curateMemory(): Promise<{ before: MemoryCurationReport; after: { kept: number; removed: number; merged: number } }> {
    const response = await authorizedFetch("/api/memory/curate", { method: "POST" });
    return await response.json() as { before: MemoryCurationReport; after: { kept: number; removed: number; merged: number } };
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

  /**
   * Build a URL for the workspace static site preview server.
   * The directory is base64url-encoded into a single PATH segment so RELATIVE
   * urls inside the HTML (theme.css, sub-pages like bom.html, images) resolve
   * against the document path — the older ?root=&file= form dropped them to
   * /api/workspace/<file> and 404'd, leaving multi-page sites unstyled with dead
   * inter-page links. The token rides in ?token= on the first navigation; the
   * gateway mirrors it into a path-scoped cookie so the browser's relative
   * sub-resource requests authenticate.
   * `root` is the workspace-relative directory. `file` is relative to that root.
   */
  function buildWorkspacePreviewUrl(root: string, file = "index.html"): string {
    const enc = base64UrlEncode(root);
    const filePath = file.replace(/^\/+/, "") || "index.html";
    const params = new URLSearchParams({ token: token.value });
    return `${restBaseUrl()}/api/workspace/site/${enc}/${filePath}?${params.toString()}`;
  }

  /** base64url-encode a (UTF-8) string for use as a single URL path segment. */
  function base64UrlEncode(value: string): string {
    const utf8 = Array.from(new TextEncoder().encode(value), (b) => String.fromCharCode(b)).join("");
    return btoa(utf8).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  // WebSocket URL for the authenticated noVNC proxy (browser-session handoff).
  // The token rides in ?token= because a browser can't set headers on a WS
  // handshake — the gateway verifies it pre-handshake.
  function buildBrowserVncUrl(sessionId: string): string {
    const parsed = new URL(normalizeGatewayWsUrl(wsUrl.value));
    parsed.pathname = `/ws/browser-vnc/${encodeURIComponent(sessionId)}`;
    parsed.search = token.value ? `?token=${encodeURIComponent(token.value)}` : "";
    parsed.hash = "";
    return parsed.toString();
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
  /** This session's open cards, the first asked first. */
  const sessionUserInputs = computed(() => openInputsFor(userInputs.value, currentSessionId.value));
  const hasOpenUserInput = computed(() => sessionUserInputs.value.length > 0);
  /** Which step each card sits under; the rest have no step on screen and are shown after the conversation. */
  const userInputPlacement = computed(() => placeUserInputs(sessionUserInputs.value, messages.value, "streaming"));
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
    modelUnreachable,
    authFailed,
    currentSessionId,
    sessions,
    activeSessions,
    archivedSessions,
    currentSessionTranscriptTotalMessages,
    currentSessionTranscriptLoading,
    currentSessionHasOlderMessages,
    currentSessionEffort,
    currentSessionTimeLimitSec,
    currentSessionImageSettingsPrompt,
    scenes,
    messages,
    streamingText,
    streamingReasoning,
    streamingSubAgentReasoning,
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
    userInputs,
    sessionUserInputs,
    hasOpenUserInput,
    userInputPlacement,
    configuringUserInputId,
    connect,
    disconnect,
    rpc,
    refreshSessions,
    getSessionTranscript,
    loadSession,
    switchSession,
    updateSessionSettings,
    loadOlderCurrentSessionTranscript,
    createSession,
    loadScenes,
    appendPendingUserMessage,
    sendMessage,
    steerTurn,
    steerRunningTurn,
    resendSteer,
    rewindToMessage,
    convertFileToMarkdown,
    persistAttachment,
    transcribeAudio,
    listVoices,
    saveTtsVoice,
    removeTtsVoice,
    synthesizeSpeech,
    summarizeForSpeech,
    analyzeImageFile,
    getOrchestrationConfig,
    saveOrchestrationConfig,
    getEffortConfig,
    saveEffortDefault,
    getSkillLibraryConfig,
    saveSkillLibraryConfig,
    getDocumentRagConfig,
    saveDocumentRagConfig,
    listDocuments,
    invalidateDocument,
    uploadDocument,
    deleteDocument,
    fetchDocumentFileBlob,
    getUserModel,
    saveUserModel,
    resetUserModel,
    getMemoryCuration,
    curateMemory,
    uploadToWorkspace,
    fetchWorkspaceArtifactBlob,
    downloadWorkspaceArtifact,
    buildWorkspacePreviewUrl,
    buildBrowserVncUrl,
    authorizedFetch,
    downloadSessionDebugMarkdown,
    downloadSessionAuditMarkdown,
    respondApproval,
    respondInput,
    respondUserInput,
    openUserInputForm,
    closeUserInputForm,
    previewUserInputCandidate,
    dismissIntervention,
    cancelTurn,
    archiveSession,
    deleteSession,
    getSwarmRuns,
    selectSwarmRun,
  };
});
