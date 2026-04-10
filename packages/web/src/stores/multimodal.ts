import { defineStore } from "pinia";
import { ref } from "vue";
import { useGatewayStore } from "./gateway";

export interface MultimodalServiceConfig {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
}

export interface MultimodalFileConfig extends MultimodalServiceConfig {
  toolName: string;
  visionModel?: string;
  visionBaseUrl?: string;
  visionApiKey?: string;
}

export interface MultimodalSttConfig extends MultimodalServiceConfig {
  api: "auto" | "openai-compatible" | "transcribe-only";
  model: string;
}

export interface MultimodalTtsConfig extends MultimodalServiceConfig {
  api: "qwen-compatible" | "openai-compatible";
  model?: string;
  defaultLanguage: string;
  defaultSpeaker: string;
  defaultVoiceId?: string;
  voiceSamplePath?: string;
  voiceSampleText?: string;
  defaultQuality: string;
  /** Auto-speak a summary of the assistant reply after each turn when voice-input mode is active. */
  speakReplySummary?: boolean;
  /** Maximum number of sentences in the spoken reply summary (1-5). */
  speakReplySummaryMaxSentences?: number;
}

export interface MultimodalImageGenerationConfig extends MultimodalServiceConfig {
  api: "automatic1111-compatible" | "comfyui";
  model?: string;
  defaultWidth: number;
  defaultHeight: number;
  defaultSteps: number;
  defaultGuidanceScale: number;
  defaultNegativePrompt?: string;
}

export interface MultimodalWakeWordConfig {
  enabled: boolean;
  language: "de-DE" | "en-US" | "pl-PL";
  keywords: string[];
  stopPhrases: string[];
  silenceTimeoutMs: number;
}

export interface MultimodalConfig {
  maxUploadBytes: number;
  files: MultimodalFileConfig;
  stt: MultimodalSttConfig;
  tts: MultimodalTtsConfig;
  wakeWord: MultimodalWakeWordConfig;
  imageGeneration?: MultimodalImageGenerationConfig;
}

export interface MultimodalServiceStatus {
  ok: boolean;
  disabled?: boolean;
  status?: number;
  error?: string;
  modelId?: string;
  modelName?: string;
  capabilities?: string[];
  voiceCloneSupported?: boolean;
  customVoiceSupported?: boolean;
}

export interface MultimodalStatus {
  files: MultimodalServiceStatus;
  vision: MultimodalServiceStatus | null;
  stt: MultimodalServiceStatus;
  tts: MultimodalServiceStatus;
  imageGeneration: MultimodalServiceStatus | null;
  wakeWord: MultimodalWakeWordConfig;
}

const DEFAULT_MULTIMODAL_CONFIG: MultimodalConfig = {
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
    baseUrl: "",
    apiKey: "",
    timeoutMs: 60_000,
    api: "auto",
    model: "whisper-1",
  },
  tts: {
    baseUrl: "",
    apiKey: "",
    timeoutMs: 60_000,
    api: "openai-compatible",
    model: "tts-1",
    defaultLanguage: "English",
    defaultSpeaker: "Luna",
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

function cloneConfig(config: MultimodalConfig): MultimodalConfig {
  return structuredClone(config);
}

function parseJsonArray(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : null;
  } catch {
    return null;
  }
}

function syncWakeWordStorage(config: MultimodalConfig): void {
  localStorage.setItem("gc_wake_keywords", JSON.stringify(config.wakeWord.keywords));
  localStorage.setItem("gc_wake_stop_phrases", JSON.stringify(config.wakeWord.stopPhrases));
  localStorage.setItem("gc_wake_language", config.wakeWord.language);
  localStorage.setItem("gc_wake_silence_ms", JSON.stringify(config.wakeWord.silenceTimeoutMs));
}

/** Read/write the speak-reply-summary toggle from localStorage (client-side only, not persisted to server). */
export function readSpeakReplySummaryStorage(): boolean {
  try {
    return localStorage.getItem("sai_speak_reply") === "true";
  } catch {
    return false;
  }
}

export function writeSpeakReplySummaryStorage(enabled: boolean): void {
  try {
    localStorage.setItem("sai_speak_reply", enabled ? "true" : "false");
  } catch {
    // ignore — best-effort localStorage
  }
}

function mergeBrowserWakeWord(config: MultimodalConfig): MultimodalConfig {
  const merged = cloneConfig(config);
  const storedKeywords = parseJsonArray(localStorage.getItem("gc_wake_keywords"));
  const storedStopPhrases = parseJsonArray(localStorage.getItem("gc_wake_stop_phrases"));
  const storedLanguage = localStorage.getItem("gc_wake_language");
  const storedSilence = localStorage.getItem("gc_wake_silence_ms");

  if (storedKeywords?.length) merged.wakeWord.keywords = storedKeywords;
  if (storedStopPhrases?.length) merged.wakeWord.stopPhrases = storedStopPhrases;
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
  const config = ref<MultimodalConfig>(cloneConfig(DEFAULT_MULTIMODAL_CONFIG));
  const status = ref<MultimodalStatus | null>(null);
  const loading = ref(false);
  const saving = ref(false);
  const statusLoading = ref(false);
  const error = ref("");

  function baseUrl(): string {
    return (gateway.wsUrl ?? "ws://localhost:8765/ws").replace(/^ws/, "http").replace(/\/ws$/, "");
  }

  async function parseErrorResponse(response: Response): Promise<string> {
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.includes("application/json")) {
      try {
        const body = await response.json() as { error?: string; detail?: string };
        return body.error ?? body.detail ?? response.statusText ?? `HTTP ${response.status}`;
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

  async function fetchStatus(): Promise<void> {
    if (!gateway.token) return;
    statusLoading.value = true;
    try {
      const response = await window.fetch(`${baseUrl()}/api/multimodal/status`, {
        headers: { Authorization: `Bearer ${gateway.token}` },
      });
      if (!response.ok) {
        throw new Error(await parseErrorResponse(response));
      }
      status.value = await response.json() as MultimodalStatus;
    } catch {
      status.value = {
        files: { ok: false },
        vision: config.value.files.visionModel ? { ok: false } : null,
        stt: config.value.stt.baseUrl.trim()
          ? { ok: false }
          : { ok: false, disabled: true, error: "Disabled: no STT endpoint configured." },
        tts: config.value.tts.baseUrl.trim()
          ? { ok: false }
          : { ok: false, disabled: true, error: "Disabled: no TTS endpoint configured." },
        imageGeneration: config.value.imageGeneration
          ? (config.value.imageGeneration.baseUrl.trim()
              ? { ok: false }
              : { ok: false, disabled: true, error: "Disabled: no image generation endpoint configured." })
          : null,
        wakeWord: config.value.wakeWord,
      };
    } finally {
      statusLoading.value = false;
    }
  }

  async function fetch(): Promise<void> {
    if (!gateway.token) return;
    loading.value = true;
    error.value = "";
    try {
      const response = await window.fetch(`${baseUrl()}/api/multimodal/config`, {
        headers: { Authorization: `Bearer ${gateway.token}` },
      });
      if (!response.ok) {
        throw new Error(await parseErrorResponse(response));
      }
      const body = await response.json() as MultimodalConfig;
      config.value = mergeBrowserWakeWord(body);
      syncWakeWordStorage(config.value);
      await fetchStatus();
    } catch (err) {
      error.value = String(err);
    } finally {
      loading.value = false;
    }
  }

  async function save(nextConfig: MultimodalConfig): Promise<void> {
    if (!gateway.token) return;
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
      const body = await response.json() as MultimodalConfig;
      config.value = cloneConfig(body);
      syncWakeWordStorage(config.value);
      await fetchStatus();
    } catch (err) {
      error.value = String(err);
    } finally {
      saving.value = false;
    }
  }

  function resetLocalWakeWordOverrides(): void {
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
