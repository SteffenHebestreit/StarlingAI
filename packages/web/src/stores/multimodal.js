import { defineStore } from "pinia";
import { ref } from "vue";
import { useGatewayStore } from "./gateway";
const DEFAULT_MULTIMODAL_CONFIG = {
    maxUploadBytes: 20_971_520,
    files: {
        baseUrl: "http://host.docker.internal:8010",
        apiKey: "",
        timeoutMs: 60_000,
        toolName: "file_to_markdown",
        visionModel: "",
        visionBaseUrl: "",
        visionApiKey: "",
    },
    stt: {
        baseUrl: "http://qwen3-asr-service:5002",
        apiKey: "",
        timeoutMs: 60_000,
        model: "Qwen/Qwen3-ASR-1.7B",
    },
    tts: {
        baseUrl: "http://qwen3-tts-service:5004",
        apiKey: "",
        timeoutMs: 60_000,
        model: "Qwen/Qwen3-TTS-12Hz-0.6B-Instruct",
        defaultLanguage: "English",
        defaultSpeaker: "Vivian",
        defaultVoiceId: "",
        voiceSamplePath: "",
        voiceSampleText: "",
        defaultQuality: "medium",
        speakReplySummary: false,
        speakReplySummaryMaxSentences: 3,
    },
    wakeWord: {
        enabled: false,
        language: "en-US",
        keywords: ["Hey Guarded", "Okay Guarded", "Luna"],
        stopPhrases: ["stop recording", "end recording", "stop listening", "luna stop"],
        silenceTimeoutMs: 4000,
    },
    // imageGeneration is optional — not added to defaults so the section only
    // appears in Settings when the user explicitly configures it.
};
function cloneConfig(config) {
    return structuredClone(config);
}
function parseJsonArray(raw) {
    if (!raw)
        return null;
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : null;
    }
    catch {
        return null;
    }
}
function syncWakeWordStorage(config) {
    localStorage.setItem("gc_wake_keywords", JSON.stringify(config.wakeWord.keywords));
    localStorage.setItem("gc_wake_stop_phrases", JSON.stringify(config.wakeWord.stopPhrases));
    localStorage.setItem("gc_wake_language", config.wakeWord.language);
    localStorage.setItem("gc_wake_silence_ms", JSON.stringify(config.wakeWord.silenceTimeoutMs));
}
/** Read/write the speak-reply-summary toggle from localStorage (client-side only, not persisted to server). */
export function readSpeakReplySummaryStorage() {
    try {
        return localStorage.getItem("sai_speak_reply") === "true";
    }
    catch {
        return false;
    }
}
export function writeSpeakReplySummaryStorage(enabled) {
    try {
        localStorage.setItem("sai_speak_reply", enabled ? "true" : "false");
    }
    catch {
        // ignore — best-effort localStorage
    }
}
function mergeBrowserWakeWord(config) {
    const merged = cloneConfig(config);
    const storedKeywords = parseJsonArray(localStorage.getItem("gc_wake_keywords"));
    const storedStopPhrases = parseJsonArray(localStorage.getItem("gc_wake_stop_phrases"));
    const storedLanguage = localStorage.getItem("gc_wake_language");
    const storedSilence = localStorage.getItem("gc_wake_silence_ms");
    if (storedKeywords?.length)
        merged.wakeWord.keywords = storedKeywords;
    if (storedStopPhrases?.length)
        merged.wakeWord.stopPhrases = storedStopPhrases;
    if (storedLanguage === "de-DE" || storedLanguage === "en-US" || storedLanguage === "pl-PL") {
        merged.wakeWord.language = storedLanguage;
    }
    if (storedSilence) {
        const silenceTimeoutMs = Number(JSON.parse(storedSilence));
        if (Number.isFinite(silenceTimeoutMs) && silenceTimeoutMs > 0) {
            merged.wakeWord.silenceTimeoutMs = silenceTimeoutMs;
        }
    }
    return merged;
}
export const useMultimodalStore = defineStore("multimodal", () => {
    const gateway = useGatewayStore();
    const config = ref(cloneConfig(DEFAULT_MULTIMODAL_CONFIG));
    const status = ref(null);
    const loading = ref(false);
    const saving = ref(false);
    const statusLoading = ref(false);
    const error = ref("");
    function baseUrl() {
        return (gateway.wsUrl ?? "ws://localhost:8765/ws").replace(/^ws/, "http").replace(/\/ws$/, "");
    }
    async function parseErrorResponse(response) {
        const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
        if (contentType.includes("application/json")) {
            try {
                const body = await response.json();
                return body.error ?? body.detail ?? response.statusText ?? `HTTP ${response.status}`;
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
    async function fetchStatus() {
        if (!gateway.token)
            return;
        statusLoading.value = true;
        try {
            const response = await window.fetch(`${baseUrl()}/api/multimodal/status`, {
                headers: { Authorization: `Bearer ${gateway.token}` },
            });
            if (!response.ok) {
                throw new Error(await parseErrorResponse(response));
            }
            status.value = await response.json();
        }
        catch {
            status.value = {
                files: { ok: false },
                vision: config.value.files.visionModel ? { ok: false } : null,
                stt: { ok: false },
                tts: { ok: false },
                imageGeneration: config.value.imageGeneration ? { ok: false } : null,
                wakeWord: config.value.wakeWord,
            };
        }
        finally {
            statusLoading.value = false;
        }
    }
    async function fetch() {
        if (!gateway.token)
            return;
        loading.value = true;
        error.value = "";
        try {
            const response = await window.fetch(`${baseUrl()}/api/multimodal/config`, {
                headers: { Authorization: `Bearer ${gateway.token}` },
            });
            if (!response.ok) {
                throw new Error(await parseErrorResponse(response));
            }
            const body = await response.json();
            config.value = mergeBrowserWakeWord(body);
            syncWakeWordStorage(config.value);
            await fetchStatus();
        }
        catch (err) {
            error.value = String(err);
        }
        finally {
            loading.value = false;
        }
    }
    async function save(nextConfig) {
        if (!gateway.token)
            return;
        saving.value = true;
        error.value = "";
        try {
            const response = await window.fetch(`${baseUrl()}/api/multimodal/config`, {
                method: "PUT",
                headers: {
                    Authorization: `Bearer ${gateway.token}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(nextConfig),
            });
            if (!response.ok) {
                throw new Error(await parseErrorResponse(response));
            }
            const body = await response.json();
            config.value = cloneConfig(body);
            syncWakeWordStorage(config.value);
            await fetchStatus();
        }
        catch (err) {
            error.value = String(err);
        }
        finally {
            saving.value = false;
        }
    }
    function resetLocalWakeWordOverrides() {
        syncWakeWordStorage(config.value);
    }
    return {
        config,
        status,
        loading,
        saving,
        statusLoading,
        error,
        fetch,
        fetchStatus,
        save,
        resetLocalWakeWordOverrides,
    };
});
