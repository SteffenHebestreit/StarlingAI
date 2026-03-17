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
    },
    stt: {
        baseUrl: "http://host.docker.internal:8000",
        apiKey: "",
        timeoutMs: 60_000,
        model: "whisper-1",
    },
    tts: {
        baseUrl: "http://host.docker.internal:5000",
        apiKey: "",
        timeoutMs: 60_000,
        defaultLanguage: "en_US",
        defaultQuality: "medium",
    },
    wakeWord: {
        enabled: false,
        language: "en-US",
        keywords: ["Hey Guarded", "Okay Guarded", "Luna"],
        stopPhrases: ["stop recording", "end recording", "stop listening", "luna stop"],
        silenceTimeoutMs: 4000,
    },
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
    async function fetchStatus() {
        if (!gateway.token)
            return;
        statusLoading.value = true;
        try {
            const response = await window.fetch(`${baseUrl()}/api/multimodal/status`, {
                headers: { Authorization: `Bearer ${gateway.token}` },
            });
            if (!response.ok) {
                const body = await response.json();
                throw new Error(body.error ?? `HTTP ${response.status}`);
            }
            status.value = await response.json();
        }
        catch {
            status.value = {
                files: { ok: false },
                stt: { ok: false },
                tts: { ok: false },
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
                const body = await response.json();
                throw new Error(body.error ?? `HTTP ${response.status}`);
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
                const body = await response.json();
                throw new Error(body.error ?? `HTTP ${response.status}`);
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
