/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { ref, computed, nextTick, watch, onUnmounted, defineAsyncComponent } from "vue";
import { useRouter } from "vue-router";
import { useStorage } from "@vueuse/core";
import { useGatewayStore } from "@/stores/gateway";
import { useScenesStore } from "@/stores/scenes";
import { useMultimodalStore } from "@/stores/multimodal";
import { marked } from "marked";
import MessageBubble from "@/components/MessageBubble.vue";
import SwarmStatusPanel from "@/components/SwarmStatusPanel.vue";
const OrbCanvas = defineAsyncComponent(() => import("@/components/OrbCanvas.vue"));
const gateway = useGatewayStore();
const scenesStore = useScenesStore();
const multimodalStore = useMultimodalStore();
const router = useRouter();
const inputText = ref("");
const messagesEl = ref(null);
const fileInputEl = ref(null);
const audioInputEl = ref(null);
const audioPlayerEl = ref(null);
const audioPreviewUrl = ref(null);
const multimodalBusy = ref(false);
const recordingState = ref("idle");
const wakeListening = ref(false);
const wakeStatus = ref("Voice idle");
const wakeKeywords = useStorage("gc_wake_keywords", ["Hey Guarded", "Okay Guarded", "Luna"]);
const wakeStopPhrases = useStorage("gc_wake_stop_phrases", ["stop recording", "end recording", "stop listening", "luna stop"]);
const wakeLanguage = useStorage("gc_wake_language", "en-US");
const wakeSilenceTimeoutMs = useStorage("gc_wake_silence_ms", 4000);
let wakeRecognition = null;
let wakeRestartTimer = null;
let mediaRecorder = null;
let mediaStream = null;
let audioContext = null;
let analyser = null;
let audioIntervalId = null;
let lastAudioActivityAt = 0;
let observedSpeech = false;
const recordedChunks = [];
const activeFlags = computed(() => {
    const text = inputText.value;
    const chips = [];
    if (/--auto\b/.test(text))
        chips.push({ label: "--auto: skip approvals", pattern: /\s*--auto\b/g, color: "amber" });
    const iterMatch = text.match(/--iter\s+(\d+)\b/);
    if (iterMatch)
        chips.push({ label: `--iter ${iterMatch[1]}`, pattern: /\s*--iter\s+\d+\b/, color: "sky" });
    const agentMatch = text.match(/--agent\s+(\S+)/);
    if (agentMatch)
        chips.push({ label: `--agent ${agentMatch[1]}`, pattern: /\s*--agent\s+\S+/, color: "purple" });
    const timeoutMatch = text.match(/--timeout\s+(\d+)\b/);
    if (timeoutMatch)
        chips.push({ label: `--timeout ${timeoutMatch[1]}s`, pattern: /\s*--timeout\s+\d+\b/, color: "sky" });
    return chips;
});
function removeFlag(pattern) {
    inputText.value = inputText.value.replace(pattern, "").trim();
}
function flagChipClass(color) {
    if (color === "amber")
        return "border-amber-500/40 bg-amber-900/25 text-amber-300 hover:border-red-500/40 hover:text-red-300";
    if (color === "sky")
        return "border-sky-500/40 bg-sky-900/25 text-sky-300 hover:border-red-500/40 hover:text-red-300";
    return "border-purple-500/40 bg-purple-900/25 text-purple-300 hover:border-red-500/40 hover:text-red-300";
}
const orbAiState = computed(() => {
    if (!gateway.connected)
        return "default";
    if (gateway.isError)
        return "error";
    if (gateway.isStreaming)
        return "output";
    if (gateway.isLoading)
        return "activity";
    return "default";
});
const displayMessages = computed(() => gateway.messages);
const sceneJobs = computed(() => scenesStore.recentJobs);
const latestAssistantText = computed(() => {
    for (let index = gateway.messages.length - 1; index >= 0; index -= 1) {
        const message = gateway.messages[index];
        if (message?.role === "assistant" && !message.blocked && message.content.trim()) {
            return message.content;
        }
    }
    return "";
});
const multimodalStatus = computed(() => multimodalStore.status);
const filesAvailable = computed(() => Boolean(multimodalStatus.value?.files.ok));
const sttAvailable = computed(() => Boolean(multimodalStatus.value?.stt.ok));
const ttsAvailable = computed(() => Boolean(multimodalStatus.value?.tts.ok));
const wakeConfigured = computed(() => Boolean(multimodalStore.config.wakeWord.enabled));
const showFileInput = computed(() => filesAvailable.value);
const showAudioUpload = computed(() => sttAvailable.value);
const showRecording = computed(() => sttAvailable.value);
const showWakeMode = computed(() => sttAvailable.value && wakeConfigured.value);
const showSpeechPlayback = computed(() => ttsAvailable.value);
const showMultimodalStatus = computed(() => showFileInput.value || showAudioUpload.value || showRecording.value || showWakeMode.value || showSpeechPlayback.value);
const voiceStatus = computed(() => {
    if (recordingState.value === "recording")
        return "Recording from microphone";
    if (recordingState.value === "processing")
        return "Transcribing audio";
    return wakeStatus.value;
});
function appendToComposer(text) {
    inputText.value = inputText.value.trim()
        ? `${inputText.value.trim()}\n\n${text.trim()}`
        : text.trim();
}
function revokeAudioPreview() {
    if (!audioPreviewUrl.value)
        return;
    URL.revokeObjectURL(audioPreviewUrl.value);
    audioPreviewUrl.value = null;
}
function createSpeechRecognition() {
    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Ctor)
        return null;
    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = wakeLanguage.value;
    recognition.onresult = handleWakeResult;
    recognition.onerror = handleWakeError;
    recognition.onend = () => {
        if (wakeListening.value && recordingState.value === "idle") {
            scheduleWakeRestart(150);
        }
    };
    return recognition;
}
function scheduleWakeRestart(delayMs) {
    if (!wakeListening.value)
        return;
    if (wakeRestartTimer !== null)
        window.clearTimeout(wakeRestartTimer);
    wakeRestartTimer = window.setTimeout(() => {
        wakeRestartTimer = null;
        try {
            wakeRecognition?.start();
            wakeStatus.value = "Wake listening";
        }
        catch {
            scheduleWakeRestart(500);
        }
    }, delayMs);
}
function stopWakeRecognition() {
    if (wakeRestartTimer !== null) {
        window.clearTimeout(wakeRestartTimer);
        wakeRestartTimer = null;
    }
    wakeRecognition?.abort();
    wakeRecognition = null;
}
function handleWakeResult(event) {
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result?.[0]?.transcript?.trim();
        if (!transcript)
            continue;
        const lowered = transcript.toLowerCase();
        if (wakeStopPhrases.value.some((phrase) => lowered.includes(phrase.toLowerCase()))) {
            void stopRecording(true);
            wakeStatus.value = "Stop phrase detected";
            return;
        }
        const matchedKeyword = wakeKeywords.value.find((phrase) => lowered.includes(phrase.toLowerCase()));
        if (matchedKeyword) {
            wakeStatus.value = `Wake phrase detected: ${matchedKeyword}`;
            void startRecording(true);
            return;
        }
    }
}
function handleWakeError(event) {
    const error = event.error ?? "unknown";
    wakeStatus.value = `Wake recognition error: ${error}`;
    if (wakeListening.value && !["not-allowed", "service-not-allowed"].includes(error)) {
        scheduleWakeRestart(1000);
    }
}
async function toggleWakeListening() {
    if (wakeListening.value) {
        wakeListening.value = false;
        stopWakeRecognition();
        wakeStatus.value = "Wake mode off";
        return;
    }
    const recognition = createSpeechRecognition();
    if (!recognition) {
        wakeStatus.value = "SpeechRecognition unavailable in this browser";
        return;
    }
    wakeRecognition = recognition;
    wakeListening.value = true;
    wakeStatus.value = "Wake listening";
    recognition.start();
}
function cleanupRecordingResources() {
    if (audioIntervalId !== null) {
        window.clearInterval(audioIntervalId);
        audioIntervalId = null;
    }
    analyser?.disconnect();
    analyser = null;
    audioContext?.close().catch(() => undefined);
    audioContext = null;
    mediaStream?.getTracks().forEach((track) => track.stop());
    mediaStream = null;
}
async function startRecording(fromWakeWord = false) {
    if (recordingState.value !== "idle")
        return;
    if (!navigator.mediaDevices?.getUserMedia) {
        wakeStatus.value = "Microphone capture unavailable";
        return;
    }
    if (fromWakeWord)
        stopWakeRecognition();
    revokeAudioPreview();
    multimodalBusy.value = true;
    recordingState.value = "recording";
    wakeStatus.value = fromWakeWord ? "Wake-triggered recording" : "Recording from microphone";
    recordedChunks.length = 0;
    observedSpeech = false;
    lastAudioActivityAt = Date.now();
    try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(mediaStream);
        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0)
                recordedChunks.push(event.data);
        };
        mediaRecorder.onstop = () => {
            void finalizeRecording();
        };
        audioContext = new AudioContext();
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 2048;
        const source = audioContext.createMediaStreamSource(mediaStream);
        source.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        audioIntervalId = window.setInterval(() => {
            if (!analyser || recordingState.value !== "recording")
                return;
            analyser.getByteFrequencyData(data);
            const avg = data.reduce((sum, value) => sum + value, 0) / data.length;
            if (avg > 18) {
                observedSpeech = true;
                lastAudioActivityAt = Date.now();
            }
            if (observedSpeech && Date.now() - lastAudioActivityAt > wakeSilenceTimeoutMs.value) {
                void stopRecording(true);
            }
        }, 150);
        mediaRecorder.start(250);
    }
    catch (error) {
        cleanupRecordingResources();
        recordingState.value = "idle";
        multimodalBusy.value = false;
        wakeStatus.value = error instanceof Error ? error.message : String(error);
        if (wakeListening.value) {
            wakeRecognition = createSpeechRecognition();
            scheduleWakeRestart(500);
        }
    }
}
async function stopRecording(restartWake = false) {
    if (recordingState.value !== "recording")
        return;
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
        mediaRecorder.stop();
    }
    if (!restartWake)
        wakeListening.value = false;
}
async function finalizeRecording() {
    cleanupRecordingResources();
    recordingState.value = "processing";
    wakeStatus.value = "Transcribing recorded audio";
    try {
        const audioBlob = new Blob(recordedChunks, { type: mediaRecorder?.mimeType || "audio/webm" });
        const result = await gateway.transcribeAudio(audioBlob, { language: wakeLanguage.value });
        if (result.text.trim()) {
            appendToComposer(result.text);
            wakeStatus.value = `Transcript ready${result.language ? ` (${result.language})` : ""}`;
        }
        else {
            wakeStatus.value = "No transcription returned";
        }
    }
    catch (error) {
        wakeStatus.value = error instanceof Error ? error.message : String(error);
    }
    finally {
        mediaRecorder = null;
        recordingState.value = "idle";
        multimodalBusy.value = false;
        if (wakeListening.value) {
            wakeRecognition = createSpeechRecognition();
            scheduleWakeRestart(300);
        }
    }
}
async function toggleRecording() {
    if (recordingState.value === "recording") {
        await stopRecording(false);
        return;
    }
    await startRecording(false);
}
async function onDocumentSelected(event) {
    const input = event.target;
    const file = input.files?.[0];
    input.value = "";
    if (!file)
        return;
    multimodalBusy.value = true;
    wakeStatus.value = `Converting ${file.name}`;
    try {
        const result = await gateway.convertFileToMarkdown(file);
        const markdown = result.markdown?.trim();
        if (!markdown)
            throw new Error(result.error ?? "File conversion returned no markdown");
        appendToComposer(`Context extracted from ${result.filename ?? file.name}:\n\n${markdown}`);
        wakeStatus.value = `Attached ${file.name}`;
    }
    catch (error) {
        wakeStatus.value = error instanceof Error ? error.message : String(error);
    }
    finally {
        multimodalBusy.value = false;
    }
}
async function onAudioSelected(event) {
    const input = event.target;
    const file = input.files?.[0];
    input.value = "";
    if (!file)
        return;
    multimodalBusy.value = true;
    wakeStatus.value = `Transcribing ${file.name}`;
    try {
        const result = await gateway.transcribeAudio(file, { language: wakeLanguage.value });
        if (!result.text.trim())
            throw new Error("Audio transcription returned no text");
        appendToComposer(result.text);
        wakeStatus.value = `Audio added from ${file.name}`;
    }
    catch (error) {
        wakeStatus.value = error instanceof Error ? error.message : String(error);
    }
    finally {
        multimodalBusy.value = false;
    }
}
async function speakLatestAssistant() {
    const text = latestAssistantText.value.trim();
    if (!text)
        return;
    multimodalBusy.value = true;
    wakeStatus.value = "Generating speech";
    try {
        const audioBlob = await gateway.synthesizeSpeech({ text });
        revokeAudioPreview();
        audioPreviewUrl.value = URL.createObjectURL(audioBlob);
        await nextTick();
        await audioPlayerEl.value?.play().catch(() => undefined);
        wakeStatus.value = "Reply ready for playback";
    }
    catch (error) {
        wakeStatus.value = error instanceof Error ? error.message : String(error);
    }
    finally {
        multimodalBusy.value = false;
    }
}
async function sendMessage() {
    const text = inputText.value.trim();
    if (!text || gateway.isLoading)
        return;
    inputText.value = "";
    await gateway.sendMessage(text);
}
async function triggerScene(name) {
    if (gateway.isLoading)
        return;
    await scenesStore.run(name);
}
async function approveAction(approved) {
    if (!gateway.pendingApproval)
        return;
    await gateway.respondApproval(gateway.pendingApproval.approvalId, approved);
}
async function handleInterventionAction(action) {
    if (action.kind === "stop_turn") {
        await gateway.cancelTurn();
        gateway.dismissIntervention();
        return;
    }
    if (action.kind === "new_session") {
        await gateway.createSession();
        gateway.dismissIntervention();
        return;
    }
    if (action.kind === "request_approval") {
        inputText.value = action.prompt ?? "Stop the current external process and ask for approval before any destructive action.";
        gateway.dismissIntervention();
    }
}
async function resetSession() {
    await gateway.createSession();
}
function openInSessions() {
    if (!gateway.currentSessionId)
        return;
    const latestRunId = gateway.currentSessionSwarmRuns[gateway.currentSessionSwarmRuns.length - 1]?.id ?? null;
    const runId = gateway.selectedSwarmRunId ?? latestRunId;
    router.push({
        path: "/sessions",
        query: {
            sessionId: gateway.currentSessionId,
            ...(runId ? { runId } : {}),
        },
    });
}
function isSceneRunning(name) {
    return scenesStore.runningJobs.some((job) => job.sceneName === name);
}
function formatSceneName(name) {
    return (name ?? "").replace(/_/g, " ");
}
function shortJobId(jobId) {
    return `${jobId.slice(0, 8)}…`;
}
function sceneStatusClass(status) {
    if (status === "completed")
        return "rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] uppercase tracking-wide text-emerald-300";
    if (status === "failed")
        return "rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] uppercase tracking-wide text-red-300";
    return "rounded-full bg-sky-500/15 px-2 py-0.5 text-[11px] uppercase tracking-wide text-sky-300";
}
function formatSceneTimestamp(value) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime()))
        return "unknown";
    return parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function formatDuration(value) {
    if (!Number.isFinite(value) || value <= 0)
        return "0 ms";
    if (value < 1_000)
        return `${Math.round(value)} ms`;
    if (value < 60_000)
        return `${(value / 1_000).toFixed(1)} s`;
    return `${(value / 60_000).toFixed(1)} min`;
}
function formatCompactNumber(value) {
    return new Intl.NumberFormat([], { notation: "compact", maximumFractionDigits: 1 }).format(value);
}
// ── Export helpers ────────────────────────────────────────────────────────────
function buildMarkdownExport() {
    const sessionId = gateway.currentSessionId ?? "unknown";
    const date = new Date().toLocaleString();
    const lines = [
        `# StarlingAI Conversation`,
        ``,
        `**Session:** \`${sessionId}\`  `,
        `**Exported:** ${date}`,
        ``,
        `---`,
        ``,
    ];
    for (const msg of gateway.messages) {
        const role = msg.role === "user" ? "**You**" : "**StarlingAI**";
        const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        lines.push(`### ${role} — ${time}`);
        lines.push(``);
        if (msg.content)
            lines.push(msg.content);
        lines.push(``);
        lines.push(`---`);
        lines.push(``);
    }
    return lines.join("\n");
}
function exportMarkdown() {
    const content = buildMarkdownExport();
    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `starlingai-${(gateway.currentSessionId ?? "session").slice(0, 8)}.md`;
    a.click();
    URL.revokeObjectURL(url);
}
function exportPDF() {
    const sessionId = gateway.currentSessionId ?? "unknown";
    const date = new Date().toLocaleString();
    const messageHtml = gateway.messages.map(msg => {
        const role = msg.role === "user" ? "You" : "StarlingAI";
        const roleClass = msg.role === "user" ? "role-user" : "role-ai";
        const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        const bodyHtml = msg.content
            ? marked.parse(msg.content, { async: false })
            : "<em>(no content)</em>";
        return `
      <div class="message ${roleClass}">
        <div class="message-header"><span class="role">${role}</span><span class="time">${time}</span></div>
        <div class="message-body">${bodyHtml}</div>
      </div>`;
    }).join("\n");
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>StarlingAI Conversation</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 13px; color: #1a1a2e; max-width: 860px; margin: 0 auto; padding: 2rem; }
    h1 { font-size: 1.4rem; color: #4c1d95; margin-bottom: 0.25rem; }
    .meta { font-size: 0.78rem; color: #6b7280; margin-bottom: 1.5rem; }
    .message { margin-bottom: 1.25rem; border-radius: 8px; padding: 0.75rem 1rem; page-break-inside: avoid; }
    .role-user { background: #f5f3ff; border: 1px solid #ddd6fe; }
    .role-ai   { background: #fafafa;  border: 1px solid #e5e7eb; }
    .message-header { display: flex; justify-content: space-between; margin-bottom: 0.5rem; }
    .role { font-weight: 700; font-size: 0.8rem; color: #6d28d9; }
    .role-user .role { color: #7c3aed; }
    .time { font-size: 0.72rem; color: #9ca3af; }
    .message-body p { margin: 0 0 0.4rem; }
    .message-body p:last-child { margin-bottom: 0; }
    .message-body code { background: #f3f4f6; padding: 0.1em 0.3em; border-radius: 3px; font-size: 0.85em; }
    .message-body pre { background: #1e1e2e; color: #e2e8f0; padding: 0.75rem; border-radius: 6px; overflow-x: auto; font-size: 0.82em; }
    .message-body pre code { background: none; color: inherit; padding: 0; }
    .message-body ul, .message-body ol { padding-left: 1.25rem; margin: 0.25rem 0; }
    .message-body h1, .message-body h2, .message-body h3 { margin: 0.5rem 0 0.25rem; }
    .message-body table { border-collapse: collapse; width: 100%; }
    .message-body th, .message-body td { border: 1px solid #d1d5db; padding: 0.3rem 0.5rem; }
    .message-body th { background: #f3f4f6; font-weight: 600; }
    @media print { body { padding: 0; } }
  </style>
</head>
<body>
  <h1>StarlingAI Conversation</h1>
  <div class="meta">Session: ${sessionId} &nbsp;·&nbsp; Exported: ${date}</div>
  ${messageHtml}
</body>
</html>`;
    const win = window.open("", "_blank");
    if (!win)
        return;
    win.document.write(html);
    win.document.close();
    win.focus();
    setTimeout(() => { win.print(); }, 300);
}
function scrollToBottom() {
    nextTick(() => { if (messagesEl.value)
        messagesEl.value.scrollTop = messagesEl.value.scrollHeight; });
}
watch(() => gateway.messages.length, scrollToBottom);
watch(() => gateway.streamingText, scrollToBottom);
watch(() => gateway.connected, async (connected) => {
    if (!connected)
        return;
    if (!gateway.currentSessionId)
        await gateway.createSession();
    await multimodalStore.fetch();
    await gateway.loadScenes();
    await scenesStore.fetch();
}, { immediate: true });
// onMounted intentionally omitted — the watch above handles the initial case,
// including when connected is already true at mount time.
onUnmounted(() => {
    stopWakeRecognition();
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
        mediaRecorder.stop();
    }
    cleanupRecordingResources();
    revokeAudioPreview();
});
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "relative flex flex-col" },
    ...{ style: {} },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "absolute inset-0 pointer-events-none flex items-center justify-center overflow-hidden" },
});
const __VLS_0 = {}.OrbCanvas;
/** @type {[typeof __VLS_components.OrbCanvas, ]} */ ;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({
    aiState: (__VLS_ctx.orbAiState),
    ...{ class: "w-full h-full" },
}));
const __VLS_2 = __VLS_1({
    aiState: (__VLS_ctx.orbAiState),
    ...{ class: "w-full h-full" },
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "relative z-10 bg-gray-900/60 backdrop-blur-md border-b border-purple-500/10 px-5 py-2 flex items-center justify-between" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "flex items-center gap-3 text-xs text-gray-500" },
});
if (__VLS_ctx.gateway.currentSessionId) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.code, __VLS_intrinsicElements.code)({
        ...{ class: "font-mono text-gray-400 ml-1" },
    });
    (__VLS_ctx.gateway.currentSessionId.substring(0, 8));
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "italic" },
    });
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "flex gap-2" },
});
if (!__VLS_ctx.gateway.currentSessionId) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                if (!(!__VLS_ctx.gateway.currentSessionId))
                    return;
                __VLS_ctx.gateway.createSession();
            } },
        ...{ class: "btn-grad px-3 py-1 rounded-lg text-xs" },
    });
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (__VLS_ctx.exportMarkdown) },
        disabled: (__VLS_ctx.gateway.messages.length === 0),
        ...{ class: "btn-ghost px-3 py-1 rounded-lg text-xs disabled:opacity-40" },
        title: "Download conversation as Markdown",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (__VLS_ctx.exportPDF) },
        disabled: (__VLS_ctx.gateway.messages.length === 0),
        ...{ class: "btn-ghost px-3 py-1 rounded-lg text-xs disabled:opacity-40" },
        title: "Export conversation as PDF",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (__VLS_ctx.resetSession) },
        ...{ class: "btn-ghost px-3 py-1 rounded-lg text-xs" },
    });
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ref: "messagesEl",
    ...{ class: "relative z-10 flex-1 overflow-y-auto p-5 space-y-4" },
});
/** @type {typeof __VLS_ctx.messagesEl} */ ;
if (__VLS_ctx.gateway.visibleSwarmState) {
    /** @type {[typeof SwarmStatusPanel, ]} */ ;
    // @ts-ignore
    const __VLS_4 = __VLS_asFunctionalComponent(SwarmStatusPanel, new SwarmStatusPanel({
        ...{ 'onSelectRun': {} },
        ...{ 'onOpenArchive': {} },
        state: (__VLS_ctx.gateway.visibleSwarmState),
        active: (__VLS_ctx.gateway.isLoading),
        runs: (__VLS_ctx.gateway.currentSessionSwarmRuns),
        selectedRunId: (__VLS_ctx.gateway.selectedSwarmRunId),
        showArchiveAction: (Boolean(__VLS_ctx.gateway.currentSessionId)),
    }));
    const __VLS_5 = __VLS_4({
        ...{ 'onSelectRun': {} },
        ...{ 'onOpenArchive': {} },
        state: (__VLS_ctx.gateway.visibleSwarmState),
        active: (__VLS_ctx.gateway.isLoading),
        runs: (__VLS_ctx.gateway.currentSessionSwarmRuns),
        selectedRunId: (__VLS_ctx.gateway.selectedSwarmRunId),
        showArchiveAction: (Boolean(__VLS_ctx.gateway.currentSessionId)),
    }, ...__VLS_functionalComponentArgsRest(__VLS_4));
    let __VLS_7;
    let __VLS_8;
    let __VLS_9;
    const __VLS_10 = {
        onSelectRun: (__VLS_ctx.gateway.selectSwarmRun)
    };
    const __VLS_11 = {
        onOpenArchive: (__VLS_ctx.openInSessions)
    };
    var __VLS_6;
}
for (const [msg] of __VLS_getVForSourceType((__VLS_ctx.displayMessages))) {
    /** @type {[typeof MessageBubble, ]} */ ;
    // @ts-ignore
    const __VLS_12 = __VLS_asFunctionalComponent(MessageBubble, new MessageBubble({
        key: (msg.id),
        message: (msg),
        isStreaming: (msg.id === 'streaming'),
        streamingText: (msg.id === 'streaming' ? __VLS_ctx.gateway.streamingText : undefined),
    }));
    const __VLS_13 = __VLS_12({
        key: (msg.id),
        message: (msg),
        isStreaming: (msg.id === 'streaming'),
        streamingText: (msg.id === 'streaming' ? __VLS_ctx.gateway.streamingText : undefined),
    }, ...__VLS_functionalComponentArgsRest(__VLS_12));
}
const __VLS_15 = {}.Transition;
/** @type {[typeof __VLS_components.Transition, typeof __VLS_components.Transition, ]} */ ;
// @ts-ignore
const __VLS_16 = __VLS_asFunctionalComponent(__VLS_15, new __VLS_15({
    name: "approval",
}));
const __VLS_17 = __VLS_16({
    name: "approval",
}, ...__VLS_functionalComponentArgsRest(__VLS_16));
__VLS_18.slots.default;
if (__VLS_ctx.gateway.pendingApproval) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "relative z-20 mx-5 mb-2 rounded-2xl overflow-hidden" },
        ...{ style: {} },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "px-5 py-4" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "flex items-center gap-2 mb-2" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "text-xs font-semibold tracking-widest uppercase" },
        ...{ style: {} },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "text-sm text-gray-300 mb-1" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.code, __VLS_intrinsicElements.code)({
        ...{ class: "text-purple-300 bg-purple-900/30 px-1.5 py-0.5 rounded font-mono text-xs" },
    });
    (__VLS_ctx.gateway.pendingApproval.toolName);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.pre, __VLS_intrinsicElements.pre)({
        ...{ class: "text-xs text-gray-400 bg-gray-900/60 rounded-lg px-3 py-2 overflow-x-auto mb-4 max-h-36" },
        ...{ style: {} },
    });
    (JSON.stringify(__VLS_ctx.gateway.pendingApproval.args, null, 2));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "flex gap-3" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.gateway.pendingApproval))
                    return;
                __VLS_ctx.approveAction(true);
            } },
        ...{ class: "btn-grad px-5 py-2 rounded-xl text-sm font-semibold" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.gateway.pendingApproval))
                    return;
                __VLS_ctx.approveAction(false);
            } },
        ...{ class: "btn-ghost px-5 py-2 rounded-xl text-sm font-semibold" },
        ...{ style: {} },
    });
}
var __VLS_18;
const __VLS_19 = {}.Transition;
/** @type {[typeof __VLS_components.Transition, typeof __VLS_components.Transition, ]} */ ;
// @ts-ignore
const __VLS_20 = __VLS_asFunctionalComponent(__VLS_19, new __VLS_19({
    name: "approval",
}));
const __VLS_21 = __VLS_20({
    name: "approval",
}, ...__VLS_functionalComponentArgsRest(__VLS_20));
__VLS_22.slots.default;
if (__VLS_ctx.gateway.pendingIntervention) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "relative z-20 mx-5 mb-2 rounded-2xl overflow-hidden" },
        ...{ class: (__VLS_ctx.gateway.pendingIntervention.severity === 'error' ? 'border border-red-500/45' : 'border border-amber-500/45') },
        ...{ style: {} },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "px-5 py-4" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "flex items-center justify-between gap-3 mb-2" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "text-xs font-semibold tracking-widest uppercase text-amber-300" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "mt-1 text-sm text-gray-100" },
    });
    (__VLS_ctx.gateway.pendingIntervention.summary);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.gateway.pendingIntervention))
                    return;
                __VLS_ctx.gateway.dismissIntervention();
            } },
        ...{ class: "rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-gray-400 transition hover:border-white/20 hover:text-gray-200" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "text-sm text-gray-300 mb-3" },
    });
    (__VLS_ctx.gateway.pendingIntervention.detail);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "flex flex-wrap gap-3" },
    });
    for (const [action] of __VLS_getVForSourceType((__VLS_ctx.gateway.pendingIntervention.actions))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.gateway.pendingIntervention))
                        return;
                    __VLS_ctx.handleInterventionAction(action);
                } },
            key: (action.kind),
            disabled: (action.kind === 'stop_turn' && !__VLS_ctx.gateway.isLoading),
            ...{ class: "btn-ghost px-4 py-2 rounded-xl text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed" },
        });
        (action.label);
    }
}
var __VLS_22;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "relative z-10 bg-gray-900/70 backdrop-blur-lg border-t border-purple-500/15 px-5 py-4" },
});
if (__VLS_ctx.gateway.scenes.length > 0) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "flex flex-wrap gap-2 mb-3" },
    });
    for (const [scene] of __VLS_getVForSourceType((__VLS_ctx.gateway.scenes))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.gateway.scenes.length > 0))
                        return;
                    __VLS_ctx.triggerScene(scene.name);
                } },
            key: (scene.name),
            disabled: (__VLS_ctx.gateway.isLoading || !__VLS_ctx.gateway.connected || __VLS_ctx.isSceneRunning(scene.name)),
            title: (scene.description),
            ...{ class: "\u0067\u0072\u006f\u0075\u0070\u0020\u0066\u006c\u0065\u0078\u0020\u0069\u0074\u0065\u006d\u0073\u002d\u0063\u0065\u006e\u0074\u0065\u0072\u0020\u0067\u0061\u0070\u002d\u0031\u002e\u0035\u0020\u0070\u0078\u002d\u0033\u0020\u0070\u0079\u002d\u0031\u0020\u0074\u0065\u0078\u0074\u002d\u0078\u0073\u0020\u0066\u006f\u006e\u0074\u002d\u006d\u0065\u0064\u0069\u0075\u006d\u000a\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0062\u0067\u002d\u0070\u0075\u0072\u0070\u006c\u0065\u002d\u0039\u0030\u0030\u002f\u0033\u0030\u0020\u0068\u006f\u0076\u0065\u0072\u003a\u0062\u0067\u002d\u0070\u0075\u0072\u0070\u006c\u0065\u002d\u0038\u0030\u0030\u002f\u0035\u0030\u000a\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0062\u006f\u0072\u0064\u0065\u0072\u0020\u0062\u006f\u0072\u0064\u0065\u0072\u002d\u0070\u0075\u0072\u0070\u006c\u0065\u002d\u0037\u0030\u0030\u002f\u0034\u0030\u0020\u0068\u006f\u0076\u0065\u0072\u003a\u0062\u006f\u0072\u0064\u0065\u0072\u002d\u0070\u0075\u0072\u0070\u006c\u0065\u002d\u0035\u0030\u0030\u002f\u0036\u0030\u000a\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0074\u0065\u0078\u0074\u002d\u0070\u0075\u0072\u0070\u006c\u0065\u002d\u0033\u0030\u0030\u0020\u0068\u006f\u0076\u0065\u0072\u003a\u0074\u0065\u0078\u0074\u002d\u0070\u0075\u0072\u0070\u006c\u0065\u002d\u0032\u0030\u0030\u000a\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0072\u006f\u0075\u006e\u0064\u0065\u0064\u002d\u0066\u0075\u006c\u006c\u0020\u0074\u0072\u0061\u006e\u0073\u0069\u0074\u0069\u006f\u006e\u002d\u0061\u006c\u006c\u0020\u0064\u0069\u0073\u0061\u0062\u006c\u0065\u0064\u003a\u006f\u0070\u0061\u0063\u0069\u0074\u0079\u002d\u0034\u0030\u0020\u0064\u0069\u0073\u0061\u0062\u006c\u0065\u0064\u003a\u0063\u0075\u0072\u0073\u006f\u0072\u002d\u006e\u006f\u0074\u002d\u0061\u006c\u006c\u006f\u0077\u0065\u0064" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "text-purple-500 group-hover:text-purple-300 transition-colors" },
        });
        (__VLS_ctx.isSceneRunning(scene.name) ? '●' : '▶');
        (scene.name.replace(/_/g, ' '));
    }
}
if (__VLS_ctx.sceneJobs.length > 0 || __VLS_ctx.scenesStore.runError) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "mb-3 grid gap-2 lg:grid-cols-2" },
    });
    for (const [job] of __VLS_getVForSourceType((__VLS_ctx.sceneJobs))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            key: (job.id),
            ...{ class: ([
                    'rounded-2xl border px-3 py-3 text-sm backdrop-blur-md',
                    job.status === 'completed'
                        ? 'border-emerald-500/20 bg-emerald-950/15'
                        : job.status === 'failed'
                            ? 'border-red-500/20 bg-red-950/15'
                            : 'border-sky-500/20 bg-sky-950/15'
                ]) },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "flex items-start justify-between gap-3" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "flex items-center gap-2" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "text-sm font-medium text-gray-100" },
        });
        (__VLS_ctx.formatSceneName(job.sceneName));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: (__VLS_ctx.sceneStatusClass(job.status)) },
        });
        (job.status);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "mt-1 text-[11px] uppercase tracking-wide text-gray-500" },
        });
        (__VLS_ctx.shortJobId(job.id));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.sceneJobs.length > 0 || __VLS_ctx.scenesStore.runError))
                        return;
                    __VLS_ctx.scenesStore.dismissJob(job.id);
                } },
            ...{ class: "rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-gray-400 transition hover:border-white/20 hover:text-gray-200" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "mt-2 flex flex-wrap gap-2 text-[11px] text-gray-400" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
        (__VLS_ctx.formatSceneTimestamp(job.startedAt));
        if (job.completedAt) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
            (__VLS_ctx.formatSceneTimestamp(job.completedAt));
        }
        if (job.performance) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
            (__VLS_ctx.formatDuration(job.performance.turnDurationMs));
        }
        if (typeof job.toolCallsExecuted === 'number') {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
            (job.toolCallsExecuted);
            (job.toolCallsExecuted === 1 ? '' : 's');
        }
        if (job.status === 'running') {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
                ...{ class: "mt-2 text-xs text-sky-200/90" },
            });
        }
        else if (job.error) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
                ...{ class: "mt-2 line-clamp-3 text-xs text-red-200/90" },
            });
            (job.error);
        }
        else if (job.response) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
                ...{ class: "mt-2 line-clamp-4 text-xs text-gray-300/90" },
            });
            (job.response);
        }
        if (job.performance) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "mt-3 grid grid-cols-2 gap-2 text-[11px] text-gray-300 sm:grid-cols-4" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "rounded-xl bg-black/20 px-2 py-1.5" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "text-gray-500" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "mt-1 text-gray-100" },
            });
            (job.performance.llmCalls);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "rounded-xl bg-black/20 px-2 py-1.5" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "text-gray-500" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "mt-1 text-gray-100" },
            });
            (__VLS_ctx.formatDuration(job.performance.llmTimeMs));
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "rounded-xl bg-black/20 px-2 py-1.5" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "text-gray-500" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "mt-1 text-gray-100" },
            });
            (__VLS_ctx.formatCompactNumber(job.performance.promptChars));
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "rounded-xl bg-black/20 px-2 py-1.5" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "text-gray-500" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "mt-1 text-gray-100" },
            });
            (job.performance.finishReason);
        }
    }
    if (__VLS_ctx.scenesStore.runError) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "rounded-2xl border border-red-500/20 bg-red-950/15 px-3 py-3 text-xs text-red-200" },
        });
        (__VLS_ctx.scenesStore.runError);
    }
}
if (__VLS_ctx.activeFlags.length > 0) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "flex flex-wrap gap-1.5 mb-2" },
    });
    for (const [flag] of __VLS_getVForSourceType((__VLS_ctx.activeFlags))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.activeFlags.length > 0))
                        return;
                    __VLS_ctx.removeFlag(flag.pattern);
                } },
            key: (flag.label),
            ...{ class: (['flex items-center gap-1 px-2 py-0.5 text-xs rounded-full border transition-colors', __VLS_ctx.flagChipClass(flag.color)]) },
            title: "Click to remove flag",
        });
        (flag.label);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "opacity-50 ml-0.5" },
        });
    }
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "mb-3 flex flex-wrap items-center gap-2 text-xs text-gray-300" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
    ...{ onChange: (__VLS_ctx.onDocumentSelected) },
    ref: "fileInputEl",
    type: "file",
    ...{ class: "hidden" },
    accept: ".pdf,.doc,.docx,.txt,.md,.csv,image/*",
});
/** @type {typeof __VLS_ctx.fileInputEl} */ ;
__VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
    ...{ onChange: (__VLS_ctx.onAudioSelected) },
    ref: "audioInputEl",
    type: "file",
    ...{ class: "hidden" },
    accept: "audio/*",
});
/** @type {typeof __VLS_ctx.audioInputEl} */ ;
if (__VLS_ctx.showFileInput) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.showFileInput))
                    return;
                __VLS_ctx.fileInputEl?.click();
            } },
        disabled: (__VLS_ctx.multimodalBusy),
        ...{ class: "btn-brand-ghost multimodal-action multimodal-icon-button px-3 py-1.5 rounded-xl disabled:opacity-40" },
        title: "Attach a document or image",
        'aria-label': "Attach file",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.svg, __VLS_intrinsicElements.svg)({
        ...{ class: "multimodal-icon" },
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        'stroke-width': "1.75",
        'stroke-linecap': "round",
        'stroke-linejoin': "round",
        'aria-hidden': "true",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
        d: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
        d: "M14 3v5h5",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
        d: "M8.5 15.5l2.5-2.5 2.5 2.5 2-2 1.5 1.5",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.circle)({
        cx: "9",
        cy: "10",
        r: "1",
    });
}
if (__VLS_ctx.showAudioUpload) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.showAudioUpload))
                    return;
                __VLS_ctx.audioInputEl?.click();
            } },
        disabled: (__VLS_ctx.multimodalBusy),
        ...{ class: "btn-brand-ghost multimodal-action multimodal-icon-button px-3 py-1.5 rounded-xl disabled:opacity-40" },
        title: "Upload an audio file for transcription",
        'aria-label': "Upload audio",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.svg, __VLS_intrinsicElements.svg)({
        ...{ class: "multimodal-icon" },
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        'stroke-width': "1.75",
        'stroke-linecap': "round",
        'stroke-linejoin': "round",
        'aria-hidden': "true",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
        d: "M12 16V4",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
        d: "M8.5 7.5 12 4l3.5 3.5",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
        d: "M4 15v2a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-2",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
        d: "M8 12.5a4 4 0 0 0 8 0",
    });
}
if (__VLS_ctx.showRecording) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.showRecording))
                    return;
                __VLS_ctx.toggleRecording();
            } },
        disabled: (__VLS_ctx.multimodalBusy && __VLS_ctx.recordingState !== 'recording'),
        ...{ class: "btn-brand-ghost multimodal-action multimodal-icon-button px-3 py-1.5 rounded-xl disabled:opacity-40" },
        ...{ class: (__VLS_ctx.recordingState === 'recording' ? 'multimodal-action-active' : '') },
        title: (__VLS_ctx.recordingState === 'recording' ? 'Stop microphone recording' : 'Record voice from the microphone'),
        'aria-label': (__VLS_ctx.recordingState === 'recording' ? 'Stop recording' : 'Record voice'),
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.svg, __VLS_intrinsicElements.svg)({
        ...{ class: "multimodal-icon" },
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        'stroke-width': "1.75",
        'stroke-linecap': "round",
        'stroke-linejoin': "round",
        'aria-hidden': "true",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
        d: "M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3Z",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
        d: "M6.5 10.5a5.5 5.5 0 0 0 11 0",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
        d: "M12 16v4",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
        d: "M8.5 20h7",
    });
}
if (__VLS_ctx.showWakeMode) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.showWakeMode))
                    return;
                __VLS_ctx.toggleWakeListening();
            } },
        disabled: (__VLS_ctx.recordingState === 'processing'),
        ...{ class: "btn-brand-ghost multimodal-action multimodal-icon-button px-3 py-1.5 rounded-xl disabled:opacity-40" },
        ...{ class: (__VLS_ctx.wakeListening ? 'multimodal-action-active' : '') },
        title: (__VLS_ctx.wakeListening ? 'Disable wake-word detection' : 'Enable wake-word detection'),
        'aria-label': (__VLS_ctx.wakeListening ? 'Stop wake mode' : 'Start wake mode'),
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.svg, __VLS_intrinsicElements.svg)({
        ...{ class: "multimodal-icon" },
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        'stroke-width': "1.75",
        'stroke-linecap': "round",
        'stroke-linejoin': "round",
        'aria-hidden': "true",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
        d: "M14.75 4.5c-2.9 0-5.25 2.35-5.25 5.25v4.5c0 2.07 1.68 3.75 3.75 3.75h.25",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
        d: "M14.25 7.5a2.75 2.75 0 0 0-2.75 2.75v3.5a1.75 1.75 0 0 0 1.75 1.75",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
        d: "M13.5 18.25c0 1.8 1.45 3.25 3.25 3.25S20 20.05 20 18.25 18.55 15 16.75 15c-1.17 0-2.19.62-2.76 1.54",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
        d: "M18.1 16.9 15.5 19.5",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
        d: "m15.5 16.9 2.6 2.6",
    });
}
if (__VLS_ctx.showSpeechPlayback) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.showSpeechPlayback))
                    return;
                __VLS_ctx.speakLatestAssistant();
            } },
        disabled: (__VLS_ctx.multimodalBusy || !__VLS_ctx.latestAssistantText),
        ...{ class: "btn-brand-ghost multimodal-action multimodal-icon-button px-3 py-1.5 rounded-xl disabled:opacity-40" },
        title: "Generate spoken playback for the latest assistant reply",
        'aria-label': "Speak reply",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.svg, __VLS_intrinsicElements.svg)({
        ...{ class: "multimodal-icon" },
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        'stroke-width': "1.75",
        'stroke-linecap': "round",
        'stroke-linejoin': "round",
        'aria-hidden': "true",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
        d: "M5 9v6",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
        d: "M9 7v10",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
        d: "M13 4v16",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
        d: "M17 8a4 4 0 0 1 0 8",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
        d: "M19 5a7.5 7.5 0 0 1 0 14",
    });
}
if (__VLS_ctx.showMultimodalStatus) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "multimodal-status rounded-full px-3 py-1 text-[11px] uppercase tracking-wide" },
    });
    (__VLS_ctx.voiceStatus);
}
if (__VLS_ctx.showWakeMode && __VLS_ctx.wakeListening) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "multimodal-status multimodal-status-live rounded-full px-3 py-1 text-[11px] uppercase tracking-wide" },
    });
    (__VLS_ctx.wakeKeywords.join(" / "));
}
if (__VLS_ctx.audioPreviewUrl) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "mb-3 rounded-2xl border border-white/10 bg-black/20 px-3 py-3" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.audio)({
        ref: "audioPlayerEl",
        src: (__VLS_ctx.audioPreviewUrl),
        controls: true,
        ...{ class: "w-full" },
    });
    /** @type {typeof __VLS_ctx.audioPlayerEl} */ ;
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "flex gap-3 items-end" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.textarea)({
    ...{ onKeydown: (__VLS_ctx.sendMessage) },
    ...{ onKeydown: (...[$event]) => {
            __VLS_ctx.inputText += '\n';
        } },
    value: (__VLS_ctx.inputText),
    disabled: (__VLS_ctx.gateway.isLoading || !__VLS_ctx.gateway.connected),
    ...{ class: "\u0066\u006c\u0065\u0078\u002d\u0031\u0020\u0062\u0067\u002d\u0067\u0072\u0061\u0079\u002d\u0038\u0030\u0030\u002f\u0035\u0030\u0020\u0062\u006f\u0072\u0064\u0065\u0072\u0020\u0062\u006f\u0072\u0064\u0065\u0072\u002d\u0070\u0075\u0072\u0070\u006c\u0065\u002d\u0035\u0030\u0030\u002f\u0032\u0030\u0020\u0068\u006f\u0076\u0065\u0072\u003a\u0062\u006f\u0072\u0064\u0065\u0072\u002d\u0070\u0075\u0072\u0070\u006c\u0065\u002d\u0035\u0030\u0030\u002f\u0034\u0030\u000a\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0066\u006f\u0063\u0075\u0073\u003a\u0062\u006f\u0072\u0064\u0065\u0072\u002d\u0070\u0075\u0072\u0070\u006c\u0065\u002d\u0035\u0030\u0030\u002f\u0036\u0030\u0020\u0066\u006f\u0063\u0075\u0073\u003a\u0062\u0067\u002d\u0067\u0072\u0061\u0079\u002d\u0038\u0030\u0030\u002f\u0037\u0030\u000a\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0072\u006f\u0075\u006e\u0064\u0065\u0064\u002d\u0032\u0078\u006c\u0020\u0070\u0078\u002d\u0034\u0020\u0070\u0079\u002d\u0033\u0020\u0074\u0065\u0078\u0074\u002d\u0073\u006d\u0020\u0072\u0065\u0073\u0069\u007a\u0065\u002d\u006e\u006f\u006e\u0065\u000a\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0066\u006f\u0063\u0075\u0073\u003a\u006f\u0075\u0074\u006c\u0069\u006e\u0065\u002d\u006e\u006f\u006e\u0065\u0020\u0064\u0069\u0073\u0061\u0062\u006c\u0065\u0064\u003a\u006f\u0070\u0061\u0063\u0069\u0074\u0079\u002d\u0034\u0030\u000a\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0074\u0065\u0078\u0074\u002d\u0067\u0072\u0061\u0079\u002d\u0031\u0030\u0030\u0020\u0070\u006c\u0061\u0063\u0065\u0068\u006f\u006c\u0064\u0065\u0072\u002d\u0067\u0072\u0061\u0079\u002d\u0036\u0030\u0030\u000a\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0074\u0072\u0061\u006e\u0073\u0069\u0074\u0069\u006f\u006e\u002d\u0061\u006c\u006c\u0020\u0064\u0075\u0072\u0061\u0074\u0069\u006f\u006e\u002d\u0032\u0030\u0030" },
    placeholder: "Message StarlingAI… (Enter to send, Shift+Enter for newline)",
    rows: "1",
    ...{ style: {} },
});
if (__VLS_ctx.gateway.isLoading) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.gateway.isLoading))
                    return;
                __VLS_ctx.gateway.cancelTurn();
            } },
        ...{ class: "\u0070\u0078\u002d\u0035\u0020\u0070\u0079\u002d\u0033\u0020\u0072\u006f\u0075\u006e\u0064\u0065\u0064\u002d\u0032\u0078\u006c\u0020\u0074\u0065\u0078\u0074\u002d\u0073\u006d\u0020\u0073\u0068\u0072\u0069\u006e\u006b\u002d\u0030\u0020\u0066\u006f\u006e\u0074\u002d\u0073\u0065\u006d\u0069\u0062\u006f\u006c\u0064\u0020\u0074\u0072\u0061\u006e\u0073\u0069\u0074\u0069\u006f\u006e\u002d\u0063\u006f\u006c\u006f\u0072\u0073\u000a\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0062\u0067\u002d\u0072\u0065\u0064\u002d\u0036\u0030\u0030\u002f\u0038\u0030\u0020\u0068\u006f\u0076\u0065\u0072\u003a\u0062\u0067\u002d\u0072\u0065\u0064\u002d\u0035\u0030\u0030\u002f\u0039\u0030\u0020\u0062\u006f\u0072\u0064\u0065\u0072\u0020\u0062\u006f\u0072\u0064\u0065\u0072\u002d\u0072\u0065\u0064\u002d\u0034\u0030\u0030\u002f\u0034\u0030\u0020\u0074\u0065\u0078\u0074\u002d\u0077\u0068\u0069\u0074\u0065" },
        title: "Stop the current turn",
    });
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (__VLS_ctx.sendMessage) },
        disabled: (!__VLS_ctx.inputText.trim() || !__VLS_ctx.gateway.connected),
        ...{ class: "btn-grad px-5 py-3 rounded-2xl text-sm shrink-0" },
    });
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "text-xs text-gray-700 mt-2 px-1" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.code, __VLS_intrinsicElements.code)({
    ...{ class: "font-mono" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.code, __VLS_intrinsicElements.code)({
    ...{ class: "font-mono" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.code, __VLS_intrinsicElements.code)({
    ...{ class: "font-mono" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.code, __VLS_intrinsicElements.code)({
    ...{ class: "font-mono" },
});
/** @type {__VLS_StyleScopedClasses['relative']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['flex-col']} */ ;
/** @type {__VLS_StyleScopedClasses['absolute']} */ ;
/** @type {__VLS_StyleScopedClasses['inset-0']} */ ;
/** @type {__VLS_StyleScopedClasses['pointer-events-none']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-center']} */ ;
/** @type {__VLS_StyleScopedClasses['overflow-hidden']} */ ;
/** @type {__VLS_StyleScopedClasses['w-full']} */ ;
/** @type {__VLS_StyleScopedClasses['h-full']} */ ;
/** @type {__VLS_StyleScopedClasses['relative']} */ ;
/** @type {__VLS_StyleScopedClasses['z-10']} */ ;
/** @type {__VLS_StyleScopedClasses['bg-gray-900/60']} */ ;
/** @type {__VLS_StyleScopedClasses['backdrop-blur-md']} */ ;
/** @type {__VLS_StyleScopedClasses['border-b']} */ ;
/** @type {__VLS_StyleScopedClasses['border-purple-500/10']} */ ;
/** @type {__VLS_StyleScopedClasses['px-5']} */ ;
/** @type {__VLS_StyleScopedClasses['py-2']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-3']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-400']} */ ;
/** @type {__VLS_StyleScopedClasses['ml-1']} */ ;
/** @type {__VLS_StyleScopedClasses['italic']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-grad']} */ ;
/** @type {__VLS_StyleScopedClasses['px-3']} */ ;
/** @type {__VLS_StyleScopedClasses['py-1']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-lg']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-ghost']} */ ;
/** @type {__VLS_StyleScopedClasses['px-3']} */ ;
/** @type {__VLS_StyleScopedClasses['py-1']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-lg']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['disabled:opacity-40']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-ghost']} */ ;
/** @type {__VLS_StyleScopedClasses['px-3']} */ ;
/** @type {__VLS_StyleScopedClasses['py-1']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-lg']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['disabled:opacity-40']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-ghost']} */ ;
/** @type {__VLS_StyleScopedClasses['px-3']} */ ;
/** @type {__VLS_StyleScopedClasses['py-1']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-lg']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['relative']} */ ;
/** @type {__VLS_StyleScopedClasses['z-10']} */ ;
/** @type {__VLS_StyleScopedClasses['flex-1']} */ ;
/** @type {__VLS_StyleScopedClasses['overflow-y-auto']} */ ;
/** @type {__VLS_StyleScopedClasses['p-5']} */ ;
/** @type {__VLS_StyleScopedClasses['space-y-4']} */ ;
/** @type {__VLS_StyleScopedClasses['relative']} */ ;
/** @type {__VLS_StyleScopedClasses['z-20']} */ ;
/** @type {__VLS_StyleScopedClasses['mx-5']} */ ;
/** @type {__VLS_StyleScopedClasses['mb-2']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-2xl']} */ ;
/** @type {__VLS_StyleScopedClasses['overflow-hidden']} */ ;
/** @type {__VLS_StyleScopedClasses['px-5']} */ ;
/** @type {__VLS_StyleScopedClasses['py-4']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
/** @type {__VLS_StyleScopedClasses['mb-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['font-semibold']} */ ;
/** @type {__VLS_StyleScopedClasses['tracking-widest']} */ ;
/** @type {__VLS_StyleScopedClasses['uppercase']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['mb-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-purple-300']} */ ;
/** @type {__VLS_StyleScopedClasses['bg-purple-900/30']} */ ;
/** @type {__VLS_StyleScopedClasses['px-1.5']} */ ;
/** @type {__VLS_StyleScopedClasses['py-0.5']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-400']} */ ;
/** @type {__VLS_StyleScopedClasses['bg-gray-900/60']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-lg']} */ ;
/** @type {__VLS_StyleScopedClasses['px-3']} */ ;
/** @type {__VLS_StyleScopedClasses['py-2']} */ ;
/** @type {__VLS_StyleScopedClasses['overflow-x-auto']} */ ;
/** @type {__VLS_StyleScopedClasses['mb-4']} */ ;
/** @type {__VLS_StyleScopedClasses['max-h-36']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-3']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-grad']} */ ;
/** @type {__VLS_StyleScopedClasses['px-5']} */ ;
/** @type {__VLS_StyleScopedClasses['py-2']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-xl']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['font-semibold']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-ghost']} */ ;
/** @type {__VLS_StyleScopedClasses['px-5']} */ ;
/** @type {__VLS_StyleScopedClasses['py-2']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-xl']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['font-semibold']} */ ;
/** @type {__VLS_StyleScopedClasses['relative']} */ ;
/** @type {__VLS_StyleScopedClasses['z-20']} */ ;
/** @type {__VLS_StyleScopedClasses['mx-5']} */ ;
/** @type {__VLS_StyleScopedClasses['mb-2']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-2xl']} */ ;
/** @type {__VLS_StyleScopedClasses['overflow-hidden']} */ ;
/** @type {__VLS_StyleScopedClasses['px-5']} */ ;
/** @type {__VLS_StyleScopedClasses['py-4']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-3']} */ ;
/** @type {__VLS_StyleScopedClasses['mb-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['font-semibold']} */ ;
/** @type {__VLS_StyleScopedClasses['tracking-widest']} */ ;
/** @type {__VLS_StyleScopedClasses['uppercase']} */ ;
/** @type {__VLS_StyleScopedClasses['text-amber-300']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-100']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-full']} */ ;
/** @type {__VLS_StyleScopedClasses['border']} */ ;
/** @type {__VLS_StyleScopedClasses['border-white/10']} */ ;
/** @type {__VLS_StyleScopedClasses['px-2']} */ ;
/** @type {__VLS_StyleScopedClasses['py-0.5']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-400']} */ ;
/** @type {__VLS_StyleScopedClasses['transition']} */ ;
/** @type {__VLS_StyleScopedClasses['hover:border-white/20']} */ ;
/** @type {__VLS_StyleScopedClasses['hover:text-gray-200']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['mb-3']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['flex-wrap']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-3']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-ghost']} */ ;
/** @type {__VLS_StyleScopedClasses['px-4']} */ ;
/** @type {__VLS_StyleScopedClasses['py-2']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-xl']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['font-semibold']} */ ;
/** @type {__VLS_StyleScopedClasses['disabled:opacity-40']} */ ;
/** @type {__VLS_StyleScopedClasses['disabled:cursor-not-allowed']} */ ;
/** @type {__VLS_StyleScopedClasses['relative']} */ ;
/** @type {__VLS_StyleScopedClasses['z-10']} */ ;
/** @type {__VLS_StyleScopedClasses['bg-gray-900/70']} */ ;
/** @type {__VLS_StyleScopedClasses['backdrop-blur-lg']} */ ;
/** @type {__VLS_StyleScopedClasses['border-t']} */ ;
/** @type {__VLS_StyleScopedClasses['border-purple-500/15']} */ ;
/** @type {__VLS_StyleScopedClasses['px-5']} */ ;
/** @type {__VLS_StyleScopedClasses['py-4']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['flex-wrap']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
/** @type {__VLS_StyleScopedClasses['mb-3']} */ ;
/** @type {__VLS_StyleScopedClasses['group']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-1.5']} */ ;
/** @type {__VLS_StyleScopedClasses['px-3']} */ ;
/** @type {__VLS_StyleScopedClasses['py-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['font-medium']} */ ;
/** @type {__VLS_StyleScopedClasses['bg-purple-900/30']} */ ;
/** @type {__VLS_StyleScopedClasses['hover:bg-purple-800/50']} */ ;
/** @type {__VLS_StyleScopedClasses['border']} */ ;
/** @type {__VLS_StyleScopedClasses['border-purple-700/40']} */ ;
/** @type {__VLS_StyleScopedClasses['hover:border-purple-500/60']} */ ;
/** @type {__VLS_StyleScopedClasses['text-purple-300']} */ ;
/** @type {__VLS_StyleScopedClasses['hover:text-purple-200']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-full']} */ ;
/** @type {__VLS_StyleScopedClasses['transition-all']} */ ;
/** @type {__VLS_StyleScopedClasses['disabled:opacity-40']} */ ;
/** @type {__VLS_StyleScopedClasses['disabled:cursor-not-allowed']} */ ;
/** @type {__VLS_StyleScopedClasses['text-purple-500']} */ ;
/** @type {__VLS_StyleScopedClasses['group-hover:text-purple-300']} */ ;
/** @type {__VLS_StyleScopedClasses['transition-colors']} */ ;
/** @type {__VLS_StyleScopedClasses['mb-3']} */ ;
/** @type {__VLS_StyleScopedClasses['grid']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
/** @type {__VLS_StyleScopedClasses['lg:grid-cols-2']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-start']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-3']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['font-medium']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-100']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['uppercase']} */ ;
/** @type {__VLS_StyleScopedClasses['tracking-wide']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-full']} */ ;
/** @type {__VLS_StyleScopedClasses['border']} */ ;
/** @type {__VLS_StyleScopedClasses['border-white/10']} */ ;
/** @type {__VLS_StyleScopedClasses['px-2']} */ ;
/** @type {__VLS_StyleScopedClasses['py-0.5']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-400']} */ ;
/** @type {__VLS_StyleScopedClasses['transition']} */ ;
/** @type {__VLS_StyleScopedClasses['hover:border-white/20']} */ ;
/** @type {__VLS_StyleScopedClasses['hover:text-gray-200']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-2']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['flex-wrap']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-400']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sky-200/90']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-2']} */ ;
/** @type {__VLS_StyleScopedClasses['line-clamp-3']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-red-200/90']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-2']} */ ;
/** @type {__VLS_StyleScopedClasses['line-clamp-4']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300/90']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-3']} */ ;
/** @type {__VLS_StyleScopedClasses['grid']} */ ;
/** @type {__VLS_StyleScopedClasses['grid-cols-2']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['sm:grid-cols-4']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-xl']} */ ;
/** @type {__VLS_StyleScopedClasses['bg-black/20']} */ ;
/** @type {__VLS_StyleScopedClasses['px-2']} */ ;
/** @type {__VLS_StyleScopedClasses['py-1.5']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-100']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-xl']} */ ;
/** @type {__VLS_StyleScopedClasses['bg-black/20']} */ ;
/** @type {__VLS_StyleScopedClasses['px-2']} */ ;
/** @type {__VLS_StyleScopedClasses['py-1.5']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-100']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-xl']} */ ;
/** @type {__VLS_StyleScopedClasses['bg-black/20']} */ ;
/** @type {__VLS_StyleScopedClasses['px-2']} */ ;
/** @type {__VLS_StyleScopedClasses['py-1.5']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-100']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-xl']} */ ;
/** @type {__VLS_StyleScopedClasses['bg-black/20']} */ ;
/** @type {__VLS_StyleScopedClasses['px-2']} */ ;
/** @type {__VLS_StyleScopedClasses['py-1.5']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-100']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-2xl']} */ ;
/** @type {__VLS_StyleScopedClasses['border']} */ ;
/** @type {__VLS_StyleScopedClasses['border-red-500/20']} */ ;
/** @type {__VLS_StyleScopedClasses['bg-red-950/15']} */ ;
/** @type {__VLS_StyleScopedClasses['px-3']} */ ;
/** @type {__VLS_StyleScopedClasses['py-3']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-red-200']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['flex-wrap']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-1.5']} */ ;
/** @type {__VLS_StyleScopedClasses['mb-2']} */ ;
/** @type {__VLS_StyleScopedClasses['opacity-50']} */ ;
/** @type {__VLS_StyleScopedClasses['ml-0.5']} */ ;
/** @type {__VLS_StyleScopedClasses['mb-3']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['flex-wrap']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['hidden']} */ ;
/** @type {__VLS_StyleScopedClasses['hidden']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-brand-ghost']} */ ;
/** @type {__VLS_StyleScopedClasses['multimodal-action']} */ ;
/** @type {__VLS_StyleScopedClasses['multimodal-icon-button']} */ ;
/** @type {__VLS_StyleScopedClasses['px-3']} */ ;
/** @type {__VLS_StyleScopedClasses['py-1.5']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-xl']} */ ;
/** @type {__VLS_StyleScopedClasses['disabled:opacity-40']} */ ;
/** @type {__VLS_StyleScopedClasses['multimodal-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-brand-ghost']} */ ;
/** @type {__VLS_StyleScopedClasses['multimodal-action']} */ ;
/** @type {__VLS_StyleScopedClasses['multimodal-icon-button']} */ ;
/** @type {__VLS_StyleScopedClasses['px-3']} */ ;
/** @type {__VLS_StyleScopedClasses['py-1.5']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-xl']} */ ;
/** @type {__VLS_StyleScopedClasses['disabled:opacity-40']} */ ;
/** @type {__VLS_StyleScopedClasses['multimodal-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-brand-ghost']} */ ;
/** @type {__VLS_StyleScopedClasses['multimodal-action']} */ ;
/** @type {__VLS_StyleScopedClasses['multimodal-icon-button']} */ ;
/** @type {__VLS_StyleScopedClasses['px-3']} */ ;
/** @type {__VLS_StyleScopedClasses['py-1.5']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-xl']} */ ;
/** @type {__VLS_StyleScopedClasses['disabled:opacity-40']} */ ;
/** @type {__VLS_StyleScopedClasses['multimodal-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-brand-ghost']} */ ;
/** @type {__VLS_StyleScopedClasses['multimodal-action']} */ ;
/** @type {__VLS_StyleScopedClasses['multimodal-icon-button']} */ ;
/** @type {__VLS_StyleScopedClasses['px-3']} */ ;
/** @type {__VLS_StyleScopedClasses['py-1.5']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-xl']} */ ;
/** @type {__VLS_StyleScopedClasses['disabled:opacity-40']} */ ;
/** @type {__VLS_StyleScopedClasses['multimodal-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-brand-ghost']} */ ;
/** @type {__VLS_StyleScopedClasses['multimodal-action']} */ ;
/** @type {__VLS_StyleScopedClasses['multimodal-icon-button']} */ ;
/** @type {__VLS_StyleScopedClasses['px-3']} */ ;
/** @type {__VLS_StyleScopedClasses['py-1.5']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-xl']} */ ;
/** @type {__VLS_StyleScopedClasses['disabled:opacity-40']} */ ;
/** @type {__VLS_StyleScopedClasses['multimodal-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['multimodal-status']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-full']} */ ;
/** @type {__VLS_StyleScopedClasses['px-3']} */ ;
/** @type {__VLS_StyleScopedClasses['py-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['uppercase']} */ ;
/** @type {__VLS_StyleScopedClasses['tracking-wide']} */ ;
/** @type {__VLS_StyleScopedClasses['multimodal-status']} */ ;
/** @type {__VLS_StyleScopedClasses['multimodal-status-live']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-full']} */ ;
/** @type {__VLS_StyleScopedClasses['px-3']} */ ;
/** @type {__VLS_StyleScopedClasses['py-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['uppercase']} */ ;
/** @type {__VLS_StyleScopedClasses['tracking-wide']} */ ;
/** @type {__VLS_StyleScopedClasses['mb-3']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-2xl']} */ ;
/** @type {__VLS_StyleScopedClasses['border']} */ ;
/** @type {__VLS_StyleScopedClasses['border-white/10']} */ ;
/** @type {__VLS_StyleScopedClasses['bg-black/20']} */ ;
/** @type {__VLS_StyleScopedClasses['px-3']} */ ;
/** @type {__VLS_StyleScopedClasses['py-3']} */ ;
/** @type {__VLS_StyleScopedClasses['w-full']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-3']} */ ;
/** @type {__VLS_StyleScopedClasses['items-end']} */ ;
/** @type {__VLS_StyleScopedClasses['flex-1']} */ ;
/** @type {__VLS_StyleScopedClasses['bg-gray-800/50']} */ ;
/** @type {__VLS_StyleScopedClasses['border']} */ ;
/** @type {__VLS_StyleScopedClasses['border-purple-500/20']} */ ;
/** @type {__VLS_StyleScopedClasses['hover:border-purple-500/40']} */ ;
/** @type {__VLS_StyleScopedClasses['focus:border-purple-500/60']} */ ;
/** @type {__VLS_StyleScopedClasses['focus:bg-gray-800/70']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-2xl']} */ ;
/** @type {__VLS_StyleScopedClasses['px-4']} */ ;
/** @type {__VLS_StyleScopedClasses['py-3']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['resize-none']} */ ;
/** @type {__VLS_StyleScopedClasses['focus:outline-none']} */ ;
/** @type {__VLS_StyleScopedClasses['disabled:opacity-40']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-100']} */ ;
/** @type {__VLS_StyleScopedClasses['placeholder-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['transition-all']} */ ;
/** @type {__VLS_StyleScopedClasses['duration-200']} */ ;
/** @type {__VLS_StyleScopedClasses['px-5']} */ ;
/** @type {__VLS_StyleScopedClasses['py-3']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-2xl']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['shrink-0']} */ ;
/** @type {__VLS_StyleScopedClasses['font-semibold']} */ ;
/** @type {__VLS_StyleScopedClasses['transition-colors']} */ ;
/** @type {__VLS_StyleScopedClasses['bg-red-600/80']} */ ;
/** @type {__VLS_StyleScopedClasses['hover:bg-red-500/90']} */ ;
/** @type {__VLS_StyleScopedClasses['border']} */ ;
/** @type {__VLS_StyleScopedClasses['border-red-400/40']} */ ;
/** @type {__VLS_StyleScopedClasses['text-white']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-grad']} */ ;
/** @type {__VLS_StyleScopedClasses['px-5']} */ ;
/** @type {__VLS_StyleScopedClasses['py-3']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-2xl']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['shrink-0']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-700']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-2']} */ ;
/** @type {__VLS_StyleScopedClasses['px-1']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            MessageBubble: MessageBubble,
            SwarmStatusPanel: SwarmStatusPanel,
            OrbCanvas: OrbCanvas,
            gateway: gateway,
            scenesStore: scenesStore,
            inputText: inputText,
            messagesEl: messagesEl,
            fileInputEl: fileInputEl,
            audioInputEl: audioInputEl,
            audioPlayerEl: audioPlayerEl,
            audioPreviewUrl: audioPreviewUrl,
            multimodalBusy: multimodalBusy,
            recordingState: recordingState,
            wakeListening: wakeListening,
            wakeKeywords: wakeKeywords,
            activeFlags: activeFlags,
            removeFlag: removeFlag,
            flagChipClass: flagChipClass,
            orbAiState: orbAiState,
            displayMessages: displayMessages,
            sceneJobs: sceneJobs,
            latestAssistantText: latestAssistantText,
            showFileInput: showFileInput,
            showAudioUpload: showAudioUpload,
            showRecording: showRecording,
            showWakeMode: showWakeMode,
            showSpeechPlayback: showSpeechPlayback,
            showMultimodalStatus: showMultimodalStatus,
            voiceStatus: voiceStatus,
            toggleWakeListening: toggleWakeListening,
            toggleRecording: toggleRecording,
            onDocumentSelected: onDocumentSelected,
            onAudioSelected: onAudioSelected,
            speakLatestAssistant: speakLatestAssistant,
            sendMessage: sendMessage,
            triggerScene: triggerScene,
            approveAction: approveAction,
            handleInterventionAction: handleInterventionAction,
            resetSession: resetSession,
            openInSessions: openInSessions,
            isSceneRunning: isSceneRunning,
            formatSceneName: formatSceneName,
            shortJobId: shortJobId,
            sceneStatusClass: sceneStatusClass,
            formatSceneTimestamp: formatSceneTimestamp,
            formatDuration: formatDuration,
            formatCompactNumber: formatCompactNumber,
            exportMarkdown: exportMarkdown,
            exportPDF: exportPDF,
        };
    },
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
});
; /* PartiallyEnd: #4569/main.vue */
