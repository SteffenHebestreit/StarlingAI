import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { useStorage } from "@vueuse/core";
import { useAuditStore } from "./audit";
function extractToolAttachments(name, metadata) {
    if (name !== "generate_image" || !metadata || typeof metadata !== "object") {
        return [];
    }
    const value = metadata;
    const dataUrl = typeof value["dataUrl"] === "string" ? value["dataUrl"] : "";
    if (!dataUrl.startsWith("data:image/")) {
        return [];
    }
    const filename = typeof value["filename"] === "string"
        ? value["filename"]
        : typeof value["outputPath"] === "string"
            ? String(value["outputPath"]).split(/[\\/]/).pop() || "generated-image.png"
            : "generated-image.png";
    return [{ filename, dataUrl }];
}
export const useGatewayStore = defineStore("gateway", () => {
    const audit = useAuditStore();
    const token = useStorage("gc_token", "");
    const wsUrl = useStorage("gc_ws_url", "ws://localhost:8765/ws");
    const swarmRunsBySession = useStorage("gc_swarm_runs", {});
    const connected = ref(false);
    const connecting = ref(false);
    const currentSessionId = useStorage("gc_current_session_id", null);
    const sessions = ref([]);
    const scenes = ref([]);
    const messages = ref([]);
    const pendingRequestId = ref(null);
    const streamingText = ref("");
    const liveSwarmState = ref(null);
    const selectedSwarmRunId = ref(null);
    const isStreaming = ref(false); // true while text chunks are arriving
    const isError = ref(false); // true when last turn ended in an error
    const authFailed = ref(false); // true when connection was rejected due to bad token
    const pendingIntervention = ref(null);
    const pendingApproval = ref(null);
    let ws = null;
    const messageHandlers = new Map();
    async function parseErrorResponse(response) {
        const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
        if (contentType.includes("application/json")) {
            try {
                const body = await response.json();
                return String(body["error"] ?? body["detail"] ?? response.statusText ?? `HTTP ${response.status}`);
            }
            catch {
                return response.statusText || `HTTP ${response.status}`;
            }
        }
        try {
            const text = (await response.text()).trim();
            if (!text)
                return response.statusText || `HTTP ${response.status}`;
            if (text.startsWith("<!DOCTYPE") || text.startsWith("<html")) {
                return "Received HTML instead of JSON from the gateway. Check the web server API proxy and configured gateway URL.";
            }
            return text.slice(0, 240);
        }
        catch {
            return response.statusText || `HTTP ${response.status}`;
        }
    }
    function restBaseUrl() {
        return (wsUrl.value ?? "ws://localhost:8765/ws").replace(/^ws(s?)/, "http$1").replace(/\/ws$/, "");
    }
    async function authorizedFetch(path, init = {}) {
        const headers = new Headers(init.headers ?? {});
        if (token.value)
            headers.set("Authorization", `Bearer ${token.value}`);
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
    function normalizeSwarmState(raw) {
        if (!raw || typeof raw !== "object")
            return null;
        const value = raw;
        if (typeof value["objective"] !== "string")
            return null;
        const tasks = typeof value["tasks"] === "object" && value["tasks"] !== null
            ? value["tasks"]
            : {};
        return {
            objective: String(value["objective"]),
            startedAt: String(value["startedAt"] ?? ""),
            updatedAt: String(value["updatedAt"] ?? ""),
            tasks,
        };
    }
    function attachSwarmStateToMessage(messageId, swarmState) {
        if (!swarmState)
            return;
        const message = messages.value.find((entry) => entry.id === messageId);
        if (message) {
            message.swarmState = swarmState;
        }
    }
    function cloneSwarmState(swarmState) {
        return structuredClone(swarmState);
    }
    function appendSwarmRun(status, swarmState) {
        if (!swarmState || !currentSessionId.value)
            return;
        const sessionId = currentSessionId.value;
        const previous = swarmRunsBySession.value[sessionId] ?? [];
        const next = {
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
    function selectSwarmRun(runId) {
        selectedSwarmRunId.value = runId;
    }
    function getSwarmRuns(sessionId) {
        if (!sessionId)
            return [];
        return swarmRunsBySession.value[sessionId] ?? [];
    }
    function failPendingTurn(errorText, preservePendingState = false) {
        const idx = messages.value.findIndex(m => m.id === "streaming");
        const errorMsg = {
            id: crypto.randomUUID(),
            role: "assistant",
            content: `⚠️ ${errorText}`,
            timestamp: new Date(),
            blocked: true,
            swarmState: liveSwarmState.value ?? undefined,
        };
        if (!preservePendingState) {
            if (idx >= 0)
                messages.value.splice(idx, 1, errorMsg);
            else
                messages.value.push(errorMsg);
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
        streamingText.value = "";
        pendingRequestId.value = null;
        pendingApproval.value = null;
        pendingIntervention.value = null;
        liveSwarmState.value = null;
        isStreaming.value = false;
        selectedSwarmRunId.value = null;
    }
    function hydrateTranscript(transcript) {
        messages.value = transcript.map((message) => ({
            id: message.id,
            role: message.role,
            content: message.content,
            timestamp: new Date(message.timestamp),
            toolCalls: message.toolCalls,
        }));
    }
    function applyCurrentSessionRunSelection(sessionId) {
        const existingRuns = sessionId ? (swarmRunsBySession.value[sessionId] ?? []) : [];
        selectedSwarmRunId.value = existingRuns[existingRuns.length - 1]?.id ?? null;
    }
    async function refreshSessions() {
        const result = await rpc("session.list");
        sessions.value = result;
        return result;
    }
    async function loadSession(sessionId, allowArchived = false) {
        const result = await rpc("session.get", { sessionId });
        if (!allowArchived && result.session.archivedAt) {
            throw new Error("Archived sessions cannot be resumed");
        }
        currentSessionId.value = result.session.archivedAt ? null : sessionId;
        hydrateTranscript(result.transcript);
        applyCurrentSessionRunSelection(currentSessionId.value ?? sessionId);
    }
    async function switchSession(sessionId) {
        await loadSession(sessionId);
    }
    function connect() {
        if (ws?.readyState === WebSocket.OPEN)
            return;
        connecting.value = true;
        authFailed.value = false;
        const url = `${wsUrl.value}?token=${encodeURIComponent(token.value)}`;
        const socket = new WebSocket(url);
        ws = socket;
        socket.onopen = () => {
            if (ws !== socket)
                return; // stale socket
            connected.value = true;
            connecting.value = false;
        };
        socket.onclose = (ev) => {
            if (ws !== socket)
                return; // stale socket — already replaced
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
            setTimeout(() => { if (token.value)
                connect(); }, 3000);
        };
        socket.onerror = () => {
            if (ws !== socket)
                return;
            connecting.value = false;
        };
        socket.onmessage = (event) => {
            if (ws !== socket)
                return;
            try {
                const msg = JSON.parse(event.data);
                handleServerMessage(msg);
            }
            catch { /* ignore malformed */ }
        };
    }
    function disconnect() {
        const old = ws;
        ws = null; // detach first so old handlers bail out
        old?.close();
        connected.value = false;
        connecting.value = false;
    }
    function handleServerMessage(msg) {
        const type = msg["type"];
        if (type === "hello-ok") {
            const data = msg["data"];
            sessions.value = data["sessions"] ?? [];
            if (currentSessionId.value && sessions.value.some((session) => session.id === currentSessionId.value && !session.archivedAt)) {
                void loadSession(currentSessionId.value).catch(() => {
                    currentSessionId.value = null;
                    resetLocalSessionState();
                });
            }
            else if (currentSessionId.value && !sessions.value.some((session) => session.id === currentSessionId.value)) {
                currentSessionId.value = null;
                resetLocalSessionState();
            }
            return;
        }
        if (type === "rpc.response") {
            const id = msg["id"];
            const handler = messageHandlers.get(id);
            if (handler) {
                handler(msg);
                messageHandlers.delete(id);
            }
            return;
        }
        if (type === "audit.event") {
            const data = msg["data"];
            if (data) {
                audit.addEvent(data);
            }
            return;
        }
        if (type === "agent.chunk") {
            const data = msg["data"];
            if (data["requestId"] === pendingRequestId.value) {
                isStreaming.value = true;
                streamingText.value += String(data["text"] ?? "");
            }
            return;
        }
        if (type === "agent.tool_start") {
            const data = msg["data"];
            if (data["requestId"] === pendingRequestId.value) {
                const last = messages.value[messages.value.length - 1];
                if (last && last.role === "assistant" && last.id === "streaming") {
                    last.toolCalls = [...(last.toolCalls ?? []), {
                            name: String(data["name"]),
                            args: data["args"],
                        }];
                }
            }
            return;
        }
        if (type === "agent.swarm") {
            const data = msg["data"];
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
            const data = msg["data"];
            if (data["requestId"] === pendingRequestId.value) {
                pendingApproval.value = {
                    approvalId: String(data["approvalId"]),
                    requestId: String(data["requestId"]),
                    toolName: String(data["toolName"]),
                    args: (data["args"] ?? {}),
                };
            }
            return;
        }
        if (type === "agent.intervention") {
            const data = msg["data"];
            if (data["requestId"] === pendingRequestId.value) {
                pendingIntervention.value = data["notice"];
            }
            return;
        }
        if (type === "agent.tool_done") {
            const data = msg["data"];
            if (data["requestId"] === pendingRequestId.value) {
                const last = messages.value[messages.value.length - 1];
                if (last?.toolCalls) {
                    const tc = last.toolCalls.find(t => t.name === String(data["name"]));
                    if (tc)
                        tc.result = String(data["result"] ?? "");
                }
                if (last) {
                    const attachments = extractToolAttachments(String(data["name"]), data["metadata"]);
                    if (attachments.length) {
                        last.attachments = [...(last.attachments ?? []), ...attachments];
                    }
                }
            }
            return;
        }
        if (type === "status") {
            const data = msg["data"];
            if (data["requestId"] !== pendingRequestId.value)
                return;
            const status = data["status"];
            if (status === "ok" || status === "blocked") {
                // Replace streaming placeholder with final message
                const idx = messages.value.findIndex(m => m.id === "streaming");
                const isBlocked = status === "blocked";
                const swarmState = normalizeSwarmState(data["swarmState"]) ?? liveSwarmState.value;
                const rawPerf = data["performance"];
                const streamingMessage = idx >= 0 ? messages.value[idx] : undefined;
                const finalMsg = {
                    id: crypto.randomUUID(),
                    role: "assistant",
                    content: String(data["response"] ?? ""),
                    timestamp: new Date(),
                    guardrailEvents: data["guardrailEvents"],
                    toolCalls: streamingMessage?.toolCalls,
                    attachments: streamingMessage?.attachments,
                    blocked: isBlocked,
                    swarmState: swarmState ?? undefined,
                    usage: data["usage"],
                    perf: rawPerf ? {
                        turnDurationMs: Number(rawPerf["turnDurationMs"] ?? 0),
                        llmCalls: Number(rawPerf["llmCalls"] ?? 0),
                        llmTimeMs: Number(rawPerf["llmTimeMs"] ?? 0),
                        toolIterations: Number(rawPerf["toolIterations"] ?? 0),
                        finishReason: String(rawPerf["finishReason"] ?? ""),
                    } : undefined,
                };
                if (idx >= 0)
                    messages.value.splice(idx, 1, finalMsg);
                else
                    messages.value.push(finalMsg);
                streamingText.value = "";
                pendingRequestId.value = null;
                isStreaming.value = false;
                isError.value = isBlocked;
                pendingApproval.value = null;
                appendSwarmRun(isBlocked ? "blocked" : "ok", swarmState);
                liveSwarmState.value = null;
                if (isBlocked)
                    setTimeout(() => { isError.value = false; }, 3000);
                return;
            }
            if (status === "error") {
                const errorText = String(data["error"] ?? "An unexpected error occurred.");
                failPendingTurn(errorText);
            }
        }
    }
    async function rpc(method, params) {
        if (!ws || ws.readyState !== WebSocket.OPEN)
            throw new Error("Not connected");
        const id = Math.random().toString(36).slice(2);
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("RPC timeout")), 30000);
            messageHandlers.set(id, (payload) => {
                clearTimeout(timeout);
                const p = payload;
                if (p["ok"])
                    resolve(p["payload"]);
                else
                    reject(new Error(String(p["error"] ?? "RPC error")));
            });
            ws.send(JSON.stringify({ id, method, params }));
        });
    }
    async function createSession() {
        const result = await rpc("session.create", { channel: "webchat" });
        const sid = result["sessionId"];
        currentSessionId.value = sid;
        resetLocalSessionState();
        applyCurrentSessionRunSelection(sid);
        await refreshSessions();
        return sid;
    }
    async function loadScenes() {
        try {
            scenes.value = (await rpc("scenes.list"));
        }
        catch {
            // scenes unavailable — not critical
        }
    }
    async function respondApproval(approvalId, approved) {
        await rpc("approval.respond", { approvalId, approved });
        pendingApproval.value = null;
    }
    function dismissIntervention() {
        pendingIntervention.value = null;
    }
    async function cancelTurn() {
        const rid = pendingRequestId.value;
        if (!rid)
            return;
        try {
            await rpc("chat.cancel", { requestId: rid });
        }
        catch { /* ignore — WS may have closed */ }
        // Surface cancellation locally even if RPC failed
        failPendingTurn("Turn cancelled by user.");
    }
    async function deleteSession(sessionId) {
        if (ws?.readyState === WebSocket.OPEN) {
            try {
                await rpc("session.delete", { sessionId });
            }
            catch { /* already deleted */ }
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
    async function archiveSession(sessionId) {
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
    async function sendMessage(text, enableThinking, displayContent, attachments) {
        if (!currentSessionId.value)
            await createSession();
        const userMsg = {
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
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage === "RPC timeout" && connected.value && pendingRequestId.value === requestId) {
                return;
            }
            failPendingTurn(errorMessage);
            throw error;
        }
    }
    async function convertFileToMarkdown(file) {
        const formData = new FormData();
        formData.append("file", file, file.name);
        const response = await authorizedFetch("/api/multimodal/file-to-markdown", {
            method: "POST",
            body: formData,
        });
        return await response.json();
    }
    async function transcribeAudio(file, options = {}) {
        const formData = new FormData();
        const filename = file instanceof File ? file.name : "recording.webm";
        formData.append("file", file, filename);
        if (options.language)
            formData.append("language", options.language);
        if (options.prompt)
            formData.append("prompt", options.prompt);
        if (options.model)
            formData.append("model", options.model);
        const response = await authorizedFetch("/api/multimodal/transcribe", {
            method: "POST",
            body: formData,
        });
        return await response.json();
    }
    async function listVoices() {
        const response = await authorizedFetch("/api/multimodal/voices");
        return await response.json();
    }
    async function saveTtsVoice(input) {
        const formData = new FormData();
        formData.append("file", input.file, input.file.name);
        formData.append("name", input.name);
        if (input.language)
            formData.append("language", input.language);
        const response = await authorizedFetch("/api/multimodal/voices/save", {
            method: "POST",
            body: formData,
        });
        return await response.json();
    }
    async function synthesizeSpeech(input) {
        const response = await authorizedFetch("/api/multimodal/tts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
        });
        return await response.blob();
    }
    async function analyzeImageFile(file) {
        const form = new FormData();
        form.append("file", file);
        const response = await authorizedFetch("/api/multimodal/analyze-image", { method: "POST", body: form });
        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body.error ?? `Image analysis failed: ${response.status}`);
        }
        const body = await response.json();
        if (!body.analysis)
            throw new Error(body.error ?? "No analysis returned");
        return body.analysis;
    }
    async function uploadToWorkspace(file, subdir = "uploads") {
        const form = new FormData();
        form.append("file", file);
        form.append("subdir", subdir);
        const response = await authorizedFetch("/api/workspace/upload", { method: "POST", body: form });
        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body.error ?? `Upload failed: ${response.status}`);
        }
        return await response.json();
    }
    async function summarizeForSpeech(input) {
        const response = await authorizedFetch("/api/multimodal/summarize-for-speech", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
        });
        if (!response.ok) {
            throw new Error(`Summarisation failed: ${response.status}`);
        }
        const body = await response.json();
        if (!body.summary)
            throw new Error(body.error ?? "Empty summary returned");
        return body.summary;
    }
    const isLoading = computed(() => pendingRequestId.value !== null);
    const currentSessionSwarmRuns = computed(() => {
        if (!currentSessionId.value)
            return [];
        return swarmRunsBySession.value[currentSessionId.value] ?? [];
    });
    const activeSessions = computed(() => sessions.value.filter((session) => !session.archivedAt));
    const archivedSessions = computed(() => sessions.value.filter((session) => Boolean(session.archivedAt)));
    const swarmSessionHistory = computed(() => Object.entries(swarmRunsBySession.value)
        .map(([sessionId, runs]) => {
        const latestRun = runs[runs.length - 1];
        if (!latestRun)
            return null;
        return {
            sessionId,
            runCount: runs.length,
            lastRecordedAt: latestRun.recordedAt,
            lastStatus: latestRun.status,
            lastObjective: latestRun.state.objective,
        };
    })
        .filter((entry) => entry !== null)
        .sort((left, right) => right.lastRecordedAt.localeCompare(left.lastRecordedAt)));
    const visibleSwarmState = computed(() => {
        if (liveSwarmState.value)
            return liveSwarmState.value;
        if (selectedSwarmRunId.value) {
            const selected = currentSessionSwarmRuns.value.find((run) => run.id === selectedSwarmRunId.value);
            if (selected)
                return selected.state;
        }
        for (let index = messages.value.length - 1; index >= 0; index -= 1) {
            const swarmState = messages.value[index]?.swarmState;
            if (swarmState)
                return swarmState;
        }
        const latestRun = currentSessionSwarmRuns.value[currentSessionSwarmRuns.value.length - 1];
        if (latestRun)
            return latestRun.state;
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
        loadSession,
        switchSession,
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
        respondApproval,
        dismissIntervention,
        cancelTurn,
        archiveSession,
        deleteSession,
        getSwarmRuns,
        selectSwarmRun,
    };
});
