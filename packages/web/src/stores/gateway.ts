import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { useStorage } from "@vueuse/core";
import { useAuditStore } from "./audit";

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
  toolCalls?: Array<{ name: string; args: Record<string, unknown>; result?: string }>;
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
  turns: number;
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

export interface SceneInfo {
  name: string;
  description: string;
}

export const useGatewayStore = defineStore("gateway", () => {
  const audit = useAuditStore();
  const token = useStorage<string>("gc_token", "");
  const wsUrl = useStorage<string>("gc_ws_url", "ws://localhost:8765/ws");
  const swarmRunsBySession = useStorage<Record<string, SwarmRunRecord[]>>("gc_swarm_runs", {});

  const connected = ref(false);
  const connecting = ref(false);
  const currentSessionId = ref<string | null>(null);
  const sessions = ref<GatewaySession[]>([]);
  const scenes = ref<SceneInfo[]>([]);
  const messages = ref<ChatMessage[]>([]);
  const pendingRequestId = ref<string | null>(null);
  const streamingText = ref("");
  const liveSwarmState = ref<SwarmState | null>(null);
  const selectedSwarmRunId = ref<string | null>(null);
  const isStreaming = ref(false);   // true while text chunks are arriving
  const isError = ref(false);       // true when last turn ended in an error
  const authFailed = ref(false);    // true when connection was rejected due to bad token
  const pendingIntervention = ref<InterventionNotice | null>(null);

  interface PendingApproval {
    approvalId: string;
    requestId: string;
    toolName: string;
    args: Record<string, unknown>;
  }
  const pendingApproval = ref<PendingApproval | null>(null);

  let ws: WebSocket | null = null;
  const messageHandlers = new Map<string, (payload: unknown) => void>();

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

  function restBaseUrl(): string {
    return (wsUrl.value ?? "ws://localhost:8765/ws").replace(/^ws(s?)/, "http$1").replace(/\/ws$/, "");
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

  function connect() {
    if (ws?.readyState === WebSocket.OPEN) return;
    connecting.value = true;
    authFailed.value = false;

    const url = `${wsUrl.value}?token=${encodeURIComponent(token.value)}`;
    const socket = new WebSocket(url);
    ws = socket;

    socket.onopen = () => {
      if (ws !== socket) return;          // stale socket
      connected.value = true;
      connecting.value = false;
    };

    socket.onclose = (ev: CloseEvent) => {
      if (ws !== socket) return;          // stale socket — already replaced
      ws = null;
      connected.value = false;
      connecting.value = false;

      // Auth failure (4401) or rate-limited (4429) — stop reconnecting
      if (ev.code === 4401 || ev.code === 4429) {
        authFailed.value = true;
        token.value = "";
        return;
      }

      // If a turn was in-flight, surface it as an error — the response is now lost
      if (pendingRequestId.value) {
        failPendingTurn("Connection lost while waiting for a response. Please try again.");
      }
      // Auto-reconnect after 3s only for non-auth failures
      setTimeout(() => { if (token.value) connect(); }, 3000);
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

  function disconnect() {
    const old = ws;
    ws = null;                            // detach first so old handlers bail out
    old?.close();
    connected.value = false;
    connecting.value = false;
    currentSessionId.value = null;
  }

  function handleServerMessage(msg: Record<string, unknown>) {
    const type = msg["type"] as string;

    if (type === "hello-ok") {
      const data = msg["data"] as Record<string, unknown>;
      sessions.value = (data["sessions"] as GatewaySession[]) ?? [];
      return;
    }

    if (type === "rpc.response") {
      const id = msg["id"] as string;
      const handler = messageHandlers.get(id);
      if (handler) {
        handler(msg);
        messageHandlers.delete(id);
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
        const last = messages.value[messages.value.length - 1];
        if (last && last.role === "assistant" && last.id === "streaming") {
          last.toolCalls = [...(last.toolCalls ?? []), {
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
        pendingApproval.value = {
          approvalId: String(data["approvalId"]),
          requestId: String(data["requestId"]),
          toolName: String(data["toolName"]),
          args: (data["args"] ?? {}) as Record<string, unknown>,
        };
      }
      return;
    }

    if (type === "agent.intervention") {
      const data = msg["data"] as Record<string, unknown>;
      if (data["requestId"] === pendingRequestId.value) {
        pendingIntervention.value = data["notice"] as InterventionNotice;
      }
      return;
    }

    if (type === "agent.tool_done") {
      const data = msg["data"] as Record<string, unknown>;
      if (data["requestId"] === pendingRequestId.value) {
        const last = messages.value[messages.value.length - 1];
        if (last?.toolCalls) {
          const tc = last.toolCalls.find(t => t.name === String(data["name"]));
          if (tc) tc.result = String(data["result"] ?? "");
        }
      }
      return;
    }

    if (type === "status") {
      const data = msg["data"] as Record<string, unknown>;
      if (data["requestId"] !== pendingRequestId.value) return;

      const status = data["status"] as string;

      if (status === "ok" || status === "blocked") {
        // Replace streaming placeholder with final message
        const idx = messages.value.findIndex(m => m.id === "streaming");
        const isBlocked = status === "blocked";
        const swarmState = normalizeSwarmState(data["swarmState"]) ?? liveSwarmState.value;
        const rawPerf = data["performance"] as Record<string, unknown> | undefined;
        const finalMsg: ChatMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: String(data["response"] ?? ""),
          timestamp: new Date(),
          guardrailEvents: data["guardrailEvents"] as ChatMessage["guardrailEvents"],
          toolCalls: idx >= 0 ? messages.value[idx]?.toolCalls : undefined,
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

  async function rpc(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("Not connected");
    const id = Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("RPC timeout")), 30000);
      messageHandlers.set(id, (payload) => {
        clearTimeout(timeout);
        const p = payload as Record<string, unknown>;
        if (p["ok"]) resolve(p["payload"]);
        else reject(new Error(String(p["error"] ?? "RPC error")));
      });
      ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  async function createSession(): Promise<string> {
    // End the previous session on the server before creating a new one
    if (currentSessionId.value) {
      try { await rpc("session.end", { sessionId: currentSessionId.value }); } catch { /* already gone */ }
    }
    const result = await rpc("session.create", { channel: "webchat" }) as Record<string, unknown>;
    const sid = result["sessionId"] as string;
    currentSessionId.value = sid;
    messages.value = [];
    streamingText.value = "";
    pendingRequestId.value = null;
    pendingApproval.value = null;
    pendingIntervention.value = null;
    liveSwarmState.value = null;
    const existingRuns = swarmRunsBySession.value[sid] ?? [];
    selectedSwarmRunId.value = existingRuns[existingRuns.length - 1]?.id ?? null;
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
    // End on server — silently ignore if already ended or not found
    if (ws?.readyState === WebSocket.OPEN) {
      try { await rpc("session.end", { sessionId }); } catch { /* already ended */ }
    }
    // Clear local swarm history for this session
    const next = { ...swarmRunsBySession.value };
    delete next[sessionId];
    swarmRunsBySession.value = next;
    // If this was the active chat session, reset it so the user starts fresh
    if (currentSessionId.value === sessionId) {
      currentSessionId.value = null;
      messages.value = [];
      streamingText.value = "";
      pendingRequestId.value = null;
      pendingApproval.value = null;
      liveSwarmState.value = null;
      selectedSwarmRunId.value = null;
    }
  }

  async function sendMessage(text: string): Promise<void> {
    if (!currentSessionId.value) await createSession();

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      timestamp: new Date(),
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
    createSession,
    loadScenes,
    sendMessage,
    convertFileToMarkdown,
    transcribeAudio,
    listVoices,
    synthesizeSpeech,
    summarizeForSpeech,
    analyzeImageFile,
    uploadToWorkspace,
    respondApproval,
    dismissIntervention,
    cancelTurn,
    deleteSession,
    getSwarmRuns,
    selectSwarmRun,
  };
});
