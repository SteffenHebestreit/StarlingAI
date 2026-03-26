/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { computed, reactive, watch } from "vue";
import { useGatewayStore } from "@/stores/gateway";
import { useGuardrailsStore } from "@/stores/guardrails";
import { useSitesStore } from "@/stores/sites";
import { useScenesStore } from "@/stores/scenes";
import { useChannelsStore } from "@/stores/channels";
import { useRuntimeStore } from "@/stores/runtime";
import { useAgentsStore } from "@/stores/agents";
import { useMultimodalStore } from "@/stores/multimodal";
import ToggleSwitch from "@/components/ToggleSwitch.vue";
import ChannelIcon from "@/components/ChannelIcon.vue";
const gateway = useGatewayStore();
const guardrails = useGuardrailsStore();
const sites = useSitesStore();
const scenesStore = useScenesStore();
const channelsStore = useChannelsStore();
const runtime = useRuntimeStore();
const agentsStore = useAgentsStore();
const multimodalStore = useMultimodalStore();
const routingLab = reactive({
    query: "",
    minConfidence: "medium",
});
const multimodalLoaded = computed(() => Boolean(multimodalStore.config.files.baseUrl));
const IMAGE_GEN_NEGATIVE_PRESETS = [
    {
        label: "Quality",
        value: "low quality, worst quality, blurry, pixelated, noisy, grainy, jpeg artifacts, compression artifacts, oversaturated, washed out, overexposed, underexposed",
    },
    {
        label: "Human Realism",
        value: "deformed fingers, extra fingers, missing fingers, fused fingers, bad hands, mutated hands, distorted hands, ai-looking, uncanny valley, plastic skin, waxy skin, doll face, dead eyes, empty eyes",
    },
    {
        label: "Face Detail",
        value: "blurry face, distorted face, asymmetric face, cross-eyed, bad eyes, deformed eyes, no face details, flat face, zombie face, deformed nose, unnatural mouth, bad teeth",
    },
    {
        label: "Anatomy",
        value: "bad anatomy, deformed body, mutated, extra limbs, missing limbs, disproportionate body, floating limbs, disconnected limbs, malformed limbs, twisted spine",
    },
    {
        label: "Artifacts",
        value: "watermark, text, signature, logo, banner, border, frame, copyright, censored, cropped, out of frame, duplicate, tiling",
    },
    {
        label: "All",
        value: "low quality, worst quality, blurry, pixelated, noisy, grainy, jpeg artifacts, compression artifacts, deformed fingers, extra fingers, missing fingers, fused fingers, bad hands, mutated hands, ai-looking, uncanny valley, plastic skin, waxy skin, doll face, dead eyes, blurry face, distorted face, asymmetric face, no face details, flat face, bad anatomy, deformed body, mutated, extra limbs, missing limbs, disproportionate, floating limbs, watermark, text, signature, logo, border, frame, out of frame, duplicate",
    },
];
const multimodalForm = reactive({
    maxUploadBytes: 20_971_520,
    filesBaseUrl: "",
    filesApiKey: "",
    filesTimeoutMs: 60_000,
    fileToolName: "file_to_markdown",
    visionModel: "",
    visionBaseUrl: "",
    visionApiKey: "",
    sttBaseUrl: "",
    sttApi: "auto",
    sttApiKey: "",
    sttTimeoutMs: 60_000,
    sttModel: "Qwen/Qwen3-ASR-1.7B",
    ttsBaseUrl: "",
    ttsApi: "qwen-compatible",
    ttsApiKey: "",
    ttsTimeoutMs: 60_000,
    ttsModel: "",
    ttsDefaultLanguage: "English",
    ttsDefaultSpeaker: "Vivian",
    ttsDefaultVoiceId: "",
    ttsVoiceSamplePath: "",
    ttsVoiceSampleText: "",
    ttsDefaultQuality: "medium",
    imageGenBaseUrl: "",
    imageGenApiKey: "",
    imageGenTimeoutMs: 120_000,
    imageGenModel: "",
    imageGenDefaultWidth: 1024,
    imageGenDefaultHeight: 1024,
    imageGenDefaultSteps: 28,
    imageGenGuidanceScale: 5.0,
    imageGenDefaultNegativePrompt: "",
    wakeEnabled: false,
    wakeLanguage: "en-US",
    wakeSilenceTimeoutMs: 4000,
    wakeKeywordsText: "Hey Guarded, Okay Guarded, Luna",
    wakeStopPhrasesText: "stop recording, end recording, stop listening, luna stop",
    error: "",
});
const savedVoiceForm = reactive({
    file: null,
    fileName: "",
    name: "",
    language: "English",
    saving: false,
    error: false,
    message: "",
});
const modelEndpointForm = reactive({
    loaded: false,
    loading: false,
    saving: false,
    error: "",
    lastLoaded: null,
    orchestratorModel: "",
    orchestratorBaseUrl: "",
    orchestratorApiKey: "",
    embeddingModel: "",
    embeddingBaseUrl: "",
    embeddingApiKey: "",
    rerankerEnabled: false,
    rerankerModel: "Qwen/Qwen3-Reranker-4B",
    rerankerBaseUrl: "http://host.docker.internal:1234/v1",
    rerankerApiKey: "lm-studio",
    guardEnabled: false,
    guardModel: "Qwen/Qwen3Guard-Gen-4B",
    guardBaseUrl: "http://host.docker.internal:1234/v1",
    guardApiKey: "lm-studio",
});
function settingsBaseUrl() {
    return (gateway.wsUrl ?? "ws://localhost:8765/ws").replace(/^ws(s?)/, "http$1").replace(/\/ws$/, "");
}
async function parseSettingsError(response) {
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
        return text || response.statusText || `HTTP ${response.status}`;
    }
    catch {
        return response.statusText || `HTTP ${response.status}`;
    }
}
function syncModelEndpointForm(config) {
    modelEndpointForm.lastLoaded = structuredClone(config);
    modelEndpointForm.loaded = true;
    modelEndpointForm.orchestratorModel = config.orchestrator.primary;
    modelEndpointForm.orchestratorBaseUrl = config.orchestrator.baseUrl ?? "";
    modelEndpointForm.orchestratorApiKey = config.orchestrator.apiKey ?? "";
    modelEndpointForm.embeddingModel = config.embeddings.embeddingModel ?? "";
    modelEndpointForm.embeddingBaseUrl = config.embeddings.embeddingBaseUrl ?? "";
    modelEndpointForm.embeddingApiKey = config.embeddings.embeddingApiKey ?? "";
    modelEndpointForm.rerankerEnabled = config.reranker.enabled;
    modelEndpointForm.rerankerModel = config.reranker.model;
    modelEndpointForm.rerankerBaseUrl = config.reranker.baseUrl;
    modelEndpointForm.rerankerApiKey = config.reranker.apiKey;
    modelEndpointForm.guardEnabled = config.guard.enabled;
    modelEndpointForm.guardModel = config.guard.model;
    modelEndpointForm.guardBaseUrl = config.guard.baseUrl;
    modelEndpointForm.guardApiKey = config.guard.apiKey;
    modelEndpointForm.error = "";
}
function resetModelEndpointConfig() {
    if (modelEndpointForm.lastLoaded)
        syncModelEndpointForm(modelEndpointForm.lastLoaded);
}
function getModelEndpointStatus(role) {
    return runtime.modelEndpoints?.endpoints.find((endpoint) => endpoint.role === role) ?? null;
}
async function fetchModelEndpointConfig() {
    if (!gateway.token)
        return;
    modelEndpointForm.loading = true;
    modelEndpointForm.error = "";
    try {
        const response = await window.fetch(`${settingsBaseUrl()}/api/model-endpoints/config`, {
            headers: { Authorization: `Bearer ${gateway.token}` },
        });
        if (!response.ok) {
            throw new Error(await parseSettingsError(response));
        }
        syncModelEndpointForm(await response.json());
    }
    catch (error) {
        modelEndpointForm.error = error instanceof Error ? error.message : String(error);
    }
    finally {
        modelEndpointForm.loading = false;
    }
}
async function submitModelEndpointConfig() {
    if (!gateway.token)
        return;
    modelEndpointForm.error = "";
    if (!modelEndpointForm.orchestratorModel.trim()) {
        modelEndpointForm.error = "Orchestrator primary model is required";
        return;
    }
    if (!modelEndpointForm.rerankerModel.trim() || !modelEndpointForm.rerankerBaseUrl.trim()) {
        modelEndpointForm.error = "Reranker model and endpoint are required";
        return;
    }
    if (!modelEndpointForm.guardModel.trim() || !modelEndpointForm.guardBaseUrl.trim()) {
        modelEndpointForm.error = "Guard model and endpoint are required";
        return;
    }
    modelEndpointForm.saving = true;
    try {
        const payload = {
            orchestrator: {
                primary: modelEndpointForm.orchestratorModel.trim(),
                baseUrl: modelEndpointForm.orchestratorBaseUrl.trim() || undefined,
                apiKey: modelEndpointForm.orchestratorApiKey.trim() || undefined,
            },
            embeddings: {
                embeddingModel: modelEndpointForm.embeddingModel.trim() || undefined,
                embeddingBaseUrl: modelEndpointForm.embeddingBaseUrl.trim() || undefined,
                embeddingApiKey: modelEndpointForm.embeddingApiKey.trim() || undefined,
            },
            reranker: {
                enabled: modelEndpointForm.rerankerEnabled,
                model: modelEndpointForm.rerankerModel.trim(),
                baseUrl: modelEndpointForm.rerankerBaseUrl.trim(),
                apiKey: modelEndpointForm.rerankerApiKey.trim() || "lm-studio",
            },
            guard: {
                enabled: modelEndpointForm.guardEnabled,
                model: modelEndpointForm.guardModel.trim(),
                baseUrl: modelEndpointForm.guardBaseUrl.trim(),
                apiKey: modelEndpointForm.guardApiKey.trim() || "lm-studio",
            },
        };
        const response = await window.fetch(`${settingsBaseUrl()}/api/model-endpoints/config`, {
            method: "PUT",
            headers: {
                Authorization: `Bearer ${gateway.token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
        });
        if (!response.ok) {
            throw new Error(await parseSettingsError(response));
        }
        syncModelEndpointForm(await response.json());
        await runtime.fetch();
    }
    catch (error) {
        modelEndpointForm.error = error instanceof Error ? error.message : String(error);
    }
    finally {
        modelEndpointForm.saving = false;
    }
}
function applyNegativePreset(value) {
    const current = multimodalForm.imageGenDefaultNegativePrompt.trim();
    if (!current) {
        multimodalForm.imageGenDefaultNegativePrompt = value;
    }
    else {
        // Append only terms that aren't already present (case-insensitive)
        const existing = new Set(current.toLowerCase().split(",").map(s => s.trim()));
        const newTerms = value.split(",").map(s => s.trim()).filter(t => !existing.has(t.toLowerCase()));
        if (newTerms.length) {
            multimodalForm.imageGenDefaultNegativePrompt = current + ", " + newTerms.join(", ");
        }
    }
}
function listFromCsv(value) {
    return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}
function syncMultimodalForm(config) {
    multimodalForm.maxUploadBytes = config.maxUploadBytes;
    multimodalForm.filesBaseUrl = config.files.baseUrl;
    multimodalForm.filesApiKey = config.files.apiKey ?? "";
    multimodalForm.filesTimeoutMs = config.files.timeoutMs;
    multimodalForm.fileToolName = config.files.toolName;
    multimodalForm.visionModel = config.files.visionModel ?? "";
    multimodalForm.visionBaseUrl = config.files.visionBaseUrl ?? "";
    multimodalForm.visionApiKey = config.files.visionApiKey ?? "";
    multimodalForm.sttBaseUrl = config.stt.baseUrl;
    multimodalForm.sttApi = config.stt.api;
    multimodalForm.sttApiKey = config.stt.apiKey ?? "";
    multimodalForm.sttTimeoutMs = config.stt.timeoutMs;
    multimodalForm.sttModel = config.stt.model;
    multimodalForm.ttsBaseUrl = config.tts.baseUrl;
    multimodalForm.ttsApi = config.tts.api;
    multimodalForm.ttsApiKey = config.tts.apiKey ?? "";
    multimodalForm.ttsTimeoutMs = config.tts.timeoutMs;
    multimodalForm.ttsModel = config.tts.model ?? "";
    multimodalForm.ttsDefaultLanguage = config.tts.defaultLanguage;
    multimodalForm.ttsDefaultSpeaker = config.tts.defaultSpeaker;
    multimodalForm.ttsDefaultVoiceId = config.tts.defaultVoiceId ?? "";
    multimodalForm.ttsVoiceSamplePath = config.tts.voiceSamplePath ?? "";
    multimodalForm.ttsVoiceSampleText = config.tts.voiceSampleText ?? "";
    multimodalForm.ttsDefaultQuality = config.tts.defaultQuality;
    savedVoiceForm.language = config.tts.defaultLanguage;
    multimodalForm.imageGenBaseUrl = config.imageGeneration?.baseUrl ?? "";
    multimodalForm.imageGenApiKey = config.imageGeneration?.apiKey ?? "";
    multimodalForm.imageGenTimeoutMs = config.imageGeneration?.timeoutMs ?? 120_000;
    multimodalForm.imageGenModel = config.imageGeneration?.model ?? "";
    multimodalForm.imageGenDefaultWidth = config.imageGeneration?.defaultWidth ?? 1024;
    multimodalForm.imageGenDefaultHeight = config.imageGeneration?.defaultHeight ?? 1024;
    multimodalForm.imageGenDefaultSteps = config.imageGeneration?.defaultSteps ?? 28;
    multimodalForm.imageGenGuidanceScale = config.imageGeneration?.defaultGuidanceScale ?? 5.0;
    multimodalForm.imageGenDefaultNegativePrompt = config.imageGeneration?.defaultNegativePrompt ?? "";
    multimodalForm.wakeEnabled = config.wakeWord.enabled;
    multimodalForm.wakeLanguage = config.wakeWord.language;
    multimodalForm.wakeSilenceTimeoutMs = config.wakeWord.silenceTimeoutMs;
    multimodalForm.wakeKeywordsText = config.wakeWord.keywords.join(", ");
    multimodalForm.wakeStopPhrasesText = config.wakeWord.stopPhrases.join(", ");
    multimodalForm.error = "";
}
function resetMultimodalForm() {
    syncMultimodalForm(multimodalStore.config);
}
function onSavedVoiceFileSelected(event) {
    const input = event.target;
    const file = input.files?.[0] ?? null;
    savedVoiceForm.file = file;
    savedVoiceForm.fileName = file?.name ?? "";
    savedVoiceForm.message = "";
    savedVoiceForm.error = false;
}
async function saveVoiceSampleToLibrary() {
    savedVoiceForm.message = "";
    savedVoiceForm.error = false;
    if (!savedVoiceForm.file) {
        savedVoiceForm.error = true;
        savedVoiceForm.message = "Select a voice sample file first";
        return;
    }
    if (!savedVoiceForm.name.trim()) {
        savedVoiceForm.error = true;
        savedVoiceForm.message = "Voice name is required";
        return;
    }
    savedVoiceForm.saving = true;
    try {
        const result = await gateway.saveTtsVoice({
            file: savedVoiceForm.file,
            name: savedVoiceForm.name.trim(),
            language: savedVoiceForm.language.trim() || undefined,
        });
        multimodalForm.ttsDefaultVoiceId = result.voice_id;
        if (!multimodalForm.ttsVoiceSampleText.trim() && result.ref_text) {
            multimodalForm.ttsVoiceSampleText = result.ref_text;
        }
        savedVoiceForm.error = false;
        savedVoiceForm.message = `Saved voice '${result.name}' as '${result.voice_id}'`;
    }
    catch (error) {
        savedVoiceForm.error = true;
        savedVoiceForm.message = error instanceof Error ? error.message : String(error);
    }
    finally {
        savedVoiceForm.saving = false;
    }
}
async function submitMultimodalForm() {
    multimodalForm.error = "";
    const wakeKeywords = listFromCsv(multimodalForm.wakeKeywordsText);
    const wakeStopPhrases = listFromCsv(multimodalForm.wakeStopPhrasesText);
    if (!multimodalForm.filesBaseUrl.trim() || !multimodalForm.sttBaseUrl.trim() || !multimodalForm.ttsBaseUrl.trim()) {
        multimodalForm.error = "Files, STT, and TTS endpoints are required";
        return;
    }
    if (!wakeKeywords.length) {
        multimodalForm.error = "At least one wake keyword is required";
        return;
    }
    if (!wakeStopPhrases.length) {
        multimodalForm.error = "At least one wake stop phrase is required";
        return;
    }
    const imageGenBaseUrl = multimodalForm.imageGenBaseUrl.trim();
    await multimodalStore.save({
        maxUploadBytes: multimodalForm.maxUploadBytes,
        files: {
            baseUrl: multimodalForm.filesBaseUrl.trim(),
            apiKey: multimodalForm.filesApiKey.trim() || undefined,
            timeoutMs: multimodalForm.filesTimeoutMs,
            toolName: multimodalForm.fileToolName.trim(),
            visionModel: multimodalForm.visionModel.trim() || undefined,
            visionBaseUrl: multimodalForm.visionBaseUrl.trim() || undefined,
            visionApiKey: multimodalForm.visionApiKey.trim() || undefined,
        },
        stt: {
            baseUrl: multimodalForm.sttBaseUrl.trim(),
            api: multimodalForm.sttApi,
            apiKey: multimodalForm.sttApiKey.trim() || undefined,
            timeoutMs: multimodalForm.sttTimeoutMs,
            model: multimodalForm.sttModel.trim(),
        },
        tts: {
            baseUrl: multimodalForm.ttsBaseUrl.trim(),
            api: multimodalForm.ttsApi,
            apiKey: multimodalForm.ttsApiKey.trim() || undefined,
            timeoutMs: multimodalForm.ttsTimeoutMs,
            model: multimodalForm.ttsModel.trim() || undefined,
            defaultLanguage: multimodalForm.ttsDefaultLanguage.trim(),
            defaultSpeaker: multimodalForm.ttsDefaultSpeaker.trim(),
            defaultVoiceId: multimodalForm.ttsDefaultVoiceId.trim() || undefined,
            voiceSamplePath: multimodalForm.ttsVoiceSamplePath.trim() || undefined,
            voiceSampleText: multimodalForm.ttsVoiceSampleText.trim() || undefined,
            defaultQuality: multimodalForm.ttsDefaultQuality.trim(),
        },
        wakeWord: {
            enabled: multimodalForm.wakeEnabled,
            language: multimodalForm.wakeLanguage,
            keywords: wakeKeywords,
            stopPhrases: wakeStopPhrases,
            silenceTimeoutMs: multimodalForm.wakeSilenceTimeoutMs,
        },
        imageGeneration: imageGenBaseUrl ? {
            baseUrl: imageGenBaseUrl,
            apiKey: multimodalForm.imageGenApiKey.trim() || undefined,
            timeoutMs: multimodalForm.imageGenTimeoutMs,
            model: multimodalForm.imageGenModel.trim() || undefined,
            defaultWidth: multimodalForm.imageGenDefaultWidth,
            defaultHeight: multimodalForm.imageGenDefaultHeight,
            defaultSteps: multimodalForm.imageGenDefaultSteps,
            defaultGuidanceScale: multimodalForm.imageGenGuidanceScale,
            cpuOffload: true,
            defaultNegativePrompt: multimodalForm.imageGenDefaultNegativePrompt.trim() || undefined,
        } : undefined,
    });
    if (!multimodalStore.error) {
        syncMultimodalForm(multimodalStore.config);
    }
    else {
        multimodalForm.error = multimodalStore.error;
    }
}
const siteForm = reactive({
    open: false,
    editing: null,
    hostname: "", username: "", password: "", loginUrl: "",
    urlEntries: [],
    notes: "", usernameSelector: "", passwordSelector: "", submitSelector: "",
    error: "",
});
function openSiteForm(site) {
    siteForm.error = "";
    if (site) {
        siteForm.editing = site.hostname;
        siteForm.hostname = site.hostname;
        siteForm.username = site.username;
        siteForm.password = "";
        siteForm.loginUrl = site.loginUrl ?? "";
        siteForm.urlEntries = Object.entries(site.urls ?? {}).map(([label, url]) => ({ label, url }));
        siteForm.notes = site.notes ?? "";
        siteForm.usernameSelector = "";
        siteForm.passwordSelector = "";
        siteForm.submitSelector = "";
    }
    else {
        siteForm.editing = null;
        siteForm.hostname = "";
        siteForm.username = "";
        siteForm.password = "";
        siteForm.loginUrl = "";
        siteForm.urlEntries = [];
        siteForm.notes = "";
        siteForm.usernameSelector = "";
        siteForm.passwordSelector = "";
        siteForm.submitSelector = "";
    }
    siteForm.open = true;
}
function addUrlEntry() { siteForm.urlEntries.push({ label: "", url: "" }); }
async function submitSiteForm() {
    siteForm.error = "";
    if (!siteForm.hostname.trim()) {
        siteForm.error = "Hostname is required";
        return;
    }
    if (!siteForm.username.trim()) {
        siteForm.error = "Username is required";
        return;
    }
    if (!siteForm.password.trim() && !siteForm.editing) {
        siteForm.error = "Password is required";
        return;
    }
    const urls = {};
    for (const e of siteForm.urlEntries) {
        if (e.label.trim() && e.url.trim())
            urls[e.label.trim()] = e.url.trim();
    }
    await sites.save(siteForm.hostname.trim(), {
        username: siteForm.username.trim(),
        password: siteForm.password.trim() || undefined,
        loginUrl: siteForm.loginUrl.trim() || undefined,
        urls: Object.keys(urls).length ? urls : undefined,
        notes: siteForm.notes.trim() || undefined,
        usernameSelector: siteForm.usernameSelector.trim() || undefined,
        passwordSelector: siteForm.passwordSelector.trim() || undefined,
        submitSelector: siteForm.submitSelector.trim() || undefined,
    });
    if (!sites.error)
        siteForm.open = false;
    else
        siteForm.error = sites.error;
}
async function confirmDeleteSite(hostname) {
    if (confirm(`Delete credentials for ${hostname}?`))
        await sites.remove(hostname);
}
// ── Scene form ───────────────────────────────────────────────────────────────
const sceneForm = reactive({
    open: false,
    editing: null,
    name: "", description: "", task: "", webhookKey: "",
    error: "",
});
function openSceneForm(scene) {
    sceneForm.error = "";
    if (scene) {
        sceneForm.editing = scene.name;
        sceneForm.name = scene.name;
        sceneForm.description = scene.description;
        sceneForm.task = scene.task;
        sceneForm.webhookKey = scene.webhookKey ?? "";
    }
    else {
        sceneForm.editing = null;
        sceneForm.name = "";
        sceneForm.description = "";
        sceneForm.task = "";
        sceneForm.webhookKey = "";
    }
    sceneForm.open = true;
}
async function submitSceneForm() {
    sceneForm.error = "";
    if (!sceneForm.name.trim()) {
        sceneForm.error = "Name is required";
        return;
    }
    if (!sceneForm.description.trim()) {
        sceneForm.error = "Description is required";
        return;
    }
    if (!sceneForm.task.trim()) {
        sceneForm.error = "Task prompt is required";
        return;
    }
    await scenesStore.save(sceneForm.name.trim(), {
        description: sceneForm.description.trim(),
        task: sceneForm.task.trim(),
        webhookKey: sceneForm.webhookKey.trim() || undefined,
    });
    if (!scenesStore.error)
        sceneForm.open = false;
    else
        sceneForm.error = scenesStore.error;
}
async function confirmDeleteScene(name) {
    if (confirm(`Delete scene "${name}"?`))
        await scenesStore.remove(name);
}
// ── Channel form ─────────────────────────────────────────────────────────────
const CHANNEL_DEFS = [
    { type: "telegram", label: "Telegram", description: "Grammy bot with optional user allowlist", fields: ["botToken", "allowedUserIds"] },
    { type: "slack", label: "Slack", description: "Connect your Slack workspace", fields: ["botToken", "signingSecret", "appToken"] },
    { type: "discord", label: "Discord", description: "Connect your Discord server", fields: ["token", "guildIds"] },
    { type: "whatsapp", label: "WhatsApp", description: "Meta Cloud API webhook", fields: ["verifyToken", "appSecret", "accessToken", "phoneNumberId"] },
    { type: "email", label: "Email", description: "IMAP polling + SMTP replies", fields: ["imapHost", "imapUser", "imapPassword", "smtpHost", "smtpUser", "smtpPassword", "smtpFrom"] },
    { type: "signal", label: "Signal", description: "signal-cli bridge", fields: ["account"] },
];
const DEFAULT_CHANNEL_CONFIG = {
    enabled: false,
    dmPolicy: "pairing",
    allowFrom: [],
    historyLimit: 50,
    perSenderRateLimitCount: 12,
    perSenderRateLimitWindowMs: 60000,
};
const channelForm = reactive({
    open: false,
    type: "",
    label: "",
    fields: [],
    config: {},
    details: null,
    loadingDetails: false,
    error: "",
});
const channelRuntimeSupport = computed(() => {
    return channelsStore.channels.find((channel) => channel.type === channelForm.type) ?? { supported: true, reason: undefined };
});
function getChannelStatus(type) {
    return channelsStore.channels.find((channel) => channel.type === type) ?? {
        type,
        enabled: false,
        running: false,
    };
}
function operatorStateBadgeClass(channel) {
    const severity = channel.operatorState?.severity ?? "ok";
    if (severity === "critical")
        return "badge-health-bad";
    if (severity === "warning")
        return "badge-config";
    return "badge-running";
}
function operatorStateTextClass(channel) {
    const severity = channel.operatorState?.severity ?? "ok";
    if (severity === "critical")
        return "text-red-300";
    if (severity === "warning")
        return "text-amber-300";
    return "text-emerald-300";
}
function windowSuccessRateClass(rate) {
    if (rate === undefined)
        return "text-gray-300";
    if (rate < 90)
        return "text-red-300";
    if (rate < 99)
        return "text-amber-300";
    return "text-emerald-300";
}
function formatPercent(value) {
    return value === undefined ? "n/a" : `${value.toFixed(value % 1 === 0 ? 0 : 2)}%`;
}
function formatTimestamp(value) {
    if (!value)
        return "never";
    return new Date(value).toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function formatHealthTitle(channel) {
    if (!channel.health)
        return "No health check yet";
    const parts = [channel.health.healthy ? "Healthy" : "Degraded"];
    if (channel.health.latencyMs !== undefined)
        parts.push(`${channel.health.latencyMs} ms`);
    if (channel.health.checkedAt)
        parts.push(`checked ${formatTimestamp(channel.health.checkedAt)}`);
    if (channel.health.error)
        parts.push(channel.health.error);
    return parts.join(" • ");
}
async function openChannelForm(def) {
    channelForm.error = "";
    channelForm.type = def.type;
    channelForm.label = def.label;
    channelForm.fields = [...def.fields];
    channelForm.config = { ...DEFAULT_CHANNEL_CONFIG };
    channelForm.details = null;
    channelForm.loadingDetails = true;
    channelForm.open = true;
    const detail = await channelsStore.fetchDetails(def.type);
    if (detail) {
        channelForm.details = detail;
        channelForm.config = { ...DEFAULT_CHANNEL_CONFIG, ...detail.config };
    }
    channelForm.loadingDetails = false;
}
async function submitChannelForm() {
    channelForm.error = "";
    await channelsStore.save(channelForm.type, channelForm.config);
    await channelsStore.fetchDeadLetterCount();
    await runtime.fetch();
    if (!channelsStore.error)
        closeChannelForm();
    else
        channelForm.error = channelsStore.error;
}
function closeChannelForm() {
    channelForm.open = false;
    channelForm.details = null;
    channelForm.loadingDetails = false;
}
function formatRuntimeName(name) {
    return (name ?? "").replace(/_/g, " ");
}
function formatModelEndpointRole(role) {
    return role.replace(/^subagent:/, "sub-agent: ").replace(/_/g, " ");
}
async function runRoutingLab() {
    const query = routingLab.query.trim();
    if (!query)
        return;
    await agentsStore.resolve(query, routingLab.minConfidence);
}
function clearRoutingLab() {
    routingLab.query = "";
    routingLab.minConfidence = "medium";
    agentsStore.clearRoutingResult();
}
// ── Auto-load when connected ─────────────────────────────────────────────────
watch(() => gateway.connected, (connected) => {
    if (connected) {
        if (!guardrails.state)
            guardrails.fetch();
        sites.fetch();
        scenesStore.fetch();
        channelsStore.fetch();
        channelsStore.fetchDeadLetterCount();
        runtime.fetch();
        agentsStore.fetch();
        multimodalStore.fetch();
        fetchModelEndpointConfig();
    }
}, { immediate: true });
watch(() => multimodalStore.config, (config) => {
    syncMultimodalForm(config);
}, { deep: true, immediate: true });
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['settings-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['multimodal-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['multimodal-health-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['site-row']} */ ;
/** @type {__VLS_StyleScopedClasses['channel-row']} */ ;
/** @type {__VLS_StyleScopedClasses['routing-lab-controls']} */ ;
/** @type {__VLS_StyleScopedClasses['scene-row']} */ ;
/** @type {__VLS_StyleScopedClasses['agent-row']} */ ;
/** @type {__VLS_StyleScopedClasses['icon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['icon-btn--danger']} */ ;
/** @type {__VLS_StyleScopedClasses['modal-close']} */ ;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "settings-page" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "settings-grid" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "space-y-5" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "glass-card p-5" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({
    ...{ class: "section-title" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "space-y-4" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
    ...{ class: "field-label" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
    value: (__VLS_ctx.gateway.wsUrl),
    type: "text",
    ...{ class: "input-box" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
    ...{ class: "field-label" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
    type: "password",
    ...{ class: "input-box" },
    autocomplete: "current-password",
});
(__VLS_ctx.gateway.token);
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "flex gap-2 pt-1" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
    ...{ onClick: (...[$event]) => {
            __VLS_ctx.gateway.connect();
        } },
    ...{ class: "btn-grad px-4 py-2 rounded-xl text-sm" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
    ...{ onClick: (...[$event]) => {
            __VLS_ctx.gateway.disconnect();
        } },
    ...{ class: "btn-ghost px-4 py-2 rounded-xl text-sm" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "glass-card p-5" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({
    ...{ class: "section-title" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "space-y-3 text-sm" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "flex justify-between items-center" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "text-gray-400" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "flex items-center gap-2" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span)({
    ...{ class: (['status-dot', __VLS_ctx.gateway.connected ? 'status-dot--on' : 'status-dot--off']) },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: (__VLS_ctx.gateway.connected ? 'text-green-400' : 'text-red-400') },
});
(__VLS_ctx.gateway.connected ? 'Connected' : 'Disconnected');
__VLS_asFunctionalElement(__VLS_intrinsicElements.div)({
    ...{ class: "border-t border-purple-500/10" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "flex justify-between items-center" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "text-gray-400" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "font-mono text-xs text-gray-300 bg-gray-800/60 px-2 py-1 rounded-lg" },
});
(__VLS_ctx.gateway.currentSessionId?.substring(0, 12) ?? 'None');
__VLS_asFunctionalElement(__VLS_intrinsicElements.div)({
    ...{ class: "border-t border-purple-500/10" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "flex justify-between items-center" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "text-gray-400" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "flex items-center gap-2" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span)({
    ...{ class: (['status-dot', __VLS_ctx.runtime.snapshot?.healthy ? 'status-dot--on' : 'status-dot--off']) },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: (__VLS_ctx.runtime.snapshot?.healthy ? 'text-green-400' : 'text-amber-400') },
});
(__VLS_ctx.runtime.snapshot?.healthy ? 'Healthy' : 'Needs Attention');
if (__VLS_ctx.runtime.loading) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "text-xs text-gray-500" },
    });
}
else if (__VLS_ctx.runtime.error) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "text-xs text-red-400" },
    });
    (__VLS_ctx.runtime.error);
}
else if (__VLS_ctx.runtime.snapshot) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "space-y-1.5 pt-1" },
    });
    for (const [component] of __VLS_getVForSourceType((__VLS_ctx.runtime.snapshot.components))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            key: (component.name),
            ...{ class: "flex items-start justify-between gap-3 text-xs" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "min-w-0" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-gray-300" },
        });
        (__VLS_ctx.formatRuntimeName(component.name));
        if (component.lastError) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "text-red-400 truncate" },
                title: (component.lastError),
            });
            (component.lastError);
        }
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: (component.healthy ? 'text-green-400' : 'text-amber-400') },
        });
        (component.healthy ? 'ok' : 'degraded');
    }
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div)({
    ...{ class: "border-t border-purple-500/10" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "flex justify-between items-center" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "text-gray-400" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "flex items-center gap-2" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span)({
    ...{ class: (['status-dot', __VLS_ctx.runtime.modelEndpoints?.healthy ? 'status-dot--on' : 'status-dot--off']) },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: (__VLS_ctx.runtime.modelEndpoints?.healthy ? 'text-green-400' : 'text-amber-400') },
});
(__VLS_ctx.runtime.modelEndpoints?.healthy ? 'Healthy' : 'Needs Attention');
if (__VLS_ctx.runtime.modelEndpointError) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "text-xs text-red-400" },
    });
    (__VLS_ctx.runtime.modelEndpointError);
}
else if (__VLS_ctx.runtime.modelEndpoints?.endpoints?.length) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "space-y-2 pt-1" },
    });
    for (const [endpoint] of __VLS_getVForSourceType((__VLS_ctx.runtime.modelEndpoints.endpoints))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            key: (`${endpoint.role}-${endpoint.baseUrl}-${endpoint.model}`),
            ...{ class: "model-endpoint-row" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "min-w-0" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-gray-300 text-xs" },
        });
        (__VLS_ctx.formatModelEndpointRole(endpoint.role));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-[11px] text-gray-500 font-mono truncate" },
            title: (endpoint.model),
        });
        (endpoint.model);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-[11px] text-gray-600 font-mono truncate" },
            title: (endpoint.baseUrl),
        });
        (endpoint.baseUrl);
        if (endpoint.error) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "text-[11px] text-red-400 truncate" },
                title: (endpoint.error),
            });
            (endpoint.error);
        }
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: (endpoint.ok ? 'text-green-400' : 'text-amber-400') },
            ...{ class: "text-xs shrink-0" },
        });
        (endpoint.ok ? 'ok' : 'down');
    }
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "glass-card p-5" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "flex items-center justify-between mb-4 gap-3" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({
    ...{ class: "section-title mb-0" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "text-xs text-gray-500 mt-1" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "flex items-center gap-2" },
});
if (__VLS_ctx.gateway.connected) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.gateway.connected))
                    return;
                __VLS_ctx.multimodalStore.fetch();
            } },
        disabled: (__VLS_ctx.multimodalStore.loading || __VLS_ctx.multimodalStore.saving),
        ...{ class: "btn-ghost px-3 py-1.5 rounded-lg text-xs" },
    });
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
    ...{ onClick: (__VLS_ctx.resetMultimodalForm) },
    disabled: (__VLS_ctx.multimodalStore.loading || __VLS_ctx.multimodalStore.saving),
    ...{ class: "btn-ghost px-3 py-1.5 rounded-lg text-xs" },
});
if (!__VLS_ctx.gateway.connected) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "empty-state" },
    });
}
else if (__VLS_ctx.multimodalStore.loading && !__VLS_ctx.multimodalLoaded) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "empty-state" },
    });
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "space-y-4" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "rounded-xl border border-cyan-500/15 bg-cyan-500/5 px-3 py-2 text-xs text-cyan-100/80" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "font-mono text-cyan-200" },
    });
    if (__VLS_ctx.multimodalStore.status) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "multimodal-health-panel" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "flex items-center justify-between gap-3 flex-wrap" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-xs uppercase tracking-[0.18em] text-gray-500" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-xs text-gray-500 mt-1" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
            ...{ onClick: (...[$event]) => {
                    if (!!(!__VLS_ctx.gateway.connected))
                        return;
                    if (!!(__VLS_ctx.multimodalStore.loading && !__VLS_ctx.multimodalLoaded))
                        return;
                    if (!(__VLS_ctx.multimodalStore.status))
                        return;
                    __VLS_ctx.multimodalStore.fetchStatus();
                } },
            disabled: (__VLS_ctx.multimodalStore.statusLoading || __VLS_ctx.multimodalStore.loading || __VLS_ctx.multimodalStore.saving),
            ...{ class: "btn-ghost px-3 py-1.5 rounded-lg text-xs" },
        });
        (__VLS_ctx.multimodalStore.statusLoading ? 'Checking…' : 'Check Health');
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "mt-3 multimodal-health-grid" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "multimodal-health-card" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "flex items-center justify-between gap-2" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "text-gray-300 text-sm" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: (__VLS_ctx.multimodalStore.status.files.ok ? 'badge-running' : 'badge-health-bad') },
        });
        (__VLS_ctx.multimodalStore.status.files.ok ? 'available' : 'offline');
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "mt-2 text-[11px] text-gray-500 font-mono break-all" },
        });
        (__VLS_ctx.multimodalForm.filesBaseUrl);
        if (__VLS_ctx.multimodalStore.status.files.error) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "mt-1 text-[11px] text-red-300" },
            });
            (__VLS_ctx.multimodalStore.status.files.error);
        }
        if (__VLS_ctx.multimodalStore.status.vision !== null) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "multimodal-health-card" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "flex items-center justify-between gap-2" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "text-gray-300 text-sm" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: (__VLS_ctx.multimodalStore.status.vision?.ok ? 'badge-running' : 'badge-health-bad') },
            });
            (__VLS_ctx.multimodalStore.status.vision?.ok ? 'available' : 'offline');
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "mt-2 text-[11px] text-gray-500 font-mono break-all" },
            });
            (__VLS_ctx.multimodalForm.visionBaseUrl || __VLS_ctx.multimodalForm.filesBaseUrl);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "mt-1 text-[11px] text-gray-600 font-mono break-all" },
            });
            (__VLS_ctx.multimodalForm.visionModel || 'uses default model');
            if (__VLS_ctx.multimodalStore.status.vision?.error) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "mt-1 text-[11px] text-red-300" },
                });
                (__VLS_ctx.multimodalStore.status.vision.error);
            }
        }
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "multimodal-health-card" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "flex items-center justify-between gap-2" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "text-gray-300 text-sm" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: (__VLS_ctx.multimodalStore.status.stt.ok ? 'badge-running' : 'badge-health-bad') },
        });
        (__VLS_ctx.multimodalStore.status.stt.ok ? 'available' : 'offline');
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "mt-2 text-[11px] text-gray-500 font-mono break-all" },
        });
        (__VLS_ctx.multimodalForm.sttBaseUrl);
        if (__VLS_ctx.multimodalStore.status.stt.error) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "mt-1 text-[11px] text-red-300" },
            });
            (__VLS_ctx.multimodalStore.status.stt.error);
        }
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "multimodal-health-card" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "flex items-center justify-between gap-2" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "text-gray-300 text-sm" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: (__VLS_ctx.multimodalStore.status.tts.ok ? 'badge-running' : 'badge-health-bad') },
        });
        (__VLS_ctx.multimodalStore.status.tts.ok ? 'available' : 'offline');
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "mt-2 text-[11px] text-gray-500 font-mono break-all" },
        });
        (__VLS_ctx.multimodalForm.ttsBaseUrl);
        if (__VLS_ctx.multimodalStore.status.tts.error) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "mt-1 text-[11px] text-red-300" },
            });
            (__VLS_ctx.multimodalStore.status.tts.error);
        }
        if (__VLS_ctx.multimodalStore.status.imageGeneration !== null) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "multimodal-health-card" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "flex items-center justify-between gap-2" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "text-gray-300 text-sm" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: (__VLS_ctx.multimodalStore.status.imageGeneration?.ok ? 'badge-running' : 'badge-health-bad') },
            });
            (__VLS_ctx.multimodalStore.status.imageGeneration?.ok ? 'available' : 'offline');
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "mt-2 text-[11px] text-gray-500 font-mono break-all" },
            });
            (__VLS_ctx.multimodalForm.imageGenBaseUrl);
            if (__VLS_ctx.multimodalStore.status.imageGeneration?.error) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "mt-1 text-[11px] text-red-300" },
                });
                (__VLS_ctx.multimodalStore.status.imageGeneration.error);
            }
        }
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "multimodal-grid" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        type: "number",
        min: "1024",
        ...{ class: "input-box" },
    });
    (__VLS_ctx.multimodalForm.maxUploadBytes);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.select, __VLS_intrinsicElements.select)({
        value: (__VLS_ctx.multimodalForm.wakeLanguage),
        ...{ class: "input-box" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
        value: "en-US",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
        value: "de-DE",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
        value: "pl-PL",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "border-t border-purple-500/10 pt-3 space-y-3" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "text-xs uppercase tracking-[0.18em] text-gray-500" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "multimodal-grid" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "md:col-span-2" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        value: (__VLS_ctx.multimodalForm.filesBaseUrl),
        type: "text",
        ...{ class: "input-box font-mono" },
        placeholder: "http://host.docker.internal:8010",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        value: (__VLS_ctx.multimodalForm.fileToolName),
        type: "text",
        ...{ class: "input-box font-mono" },
        placeholder: "file_to_markdown",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        type: "number",
        min: "1000",
        ...{ class: "input-box" },
    });
    (__VLS_ctx.multimodalForm.filesTimeoutMs);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "md:col-span-2" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "text-gray-600 font-normal" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        type: "password",
        ...{ class: "input-box" },
        autocomplete: "off",
        placeholder: "Bearer token if required",
    });
    (__VLS_ctx.multimodalForm.filesApiKey);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "md:col-span-2 border-t border-purple-500/10 pt-3 mt-1" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "text-xs uppercase tracking-[0.18em] text-gray-500 mb-3" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "multimodal-grid" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "md:col-span-2" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "text-gray-600 font-normal" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        value: (__VLS_ctx.multimodalForm.visionModel),
        type: "text",
        ...{ class: "input-box font-mono" },
        placeholder: "lmstudio/qwen/qwen3.5-9b or Qwen/Qwen2.5-VL-7B-Instruct",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "md:col-span-2" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "text-gray-600 font-normal" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        value: (__VLS_ctx.multimodalForm.visionBaseUrl),
        type: "text",
        ...{ class: "input-box font-mono" },
        placeholder: "defaults to orchestrator endpoint",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "md:col-span-2" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "text-gray-600 font-normal" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        type: "password",
        ...{ class: "input-box" },
        autocomplete: "off",
        placeholder: "uses provider or dedicated vision key",
    });
    (__VLS_ctx.multimodalForm.visionApiKey);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "border-t border-purple-500/10 pt-3 space-y-3" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "text-xs uppercase tracking-[0.18em] text-gray-500" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "multimodal-grid" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "md:col-span-2" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        value: (__VLS_ctx.multimodalForm.sttBaseUrl),
        type: "text",
        ...{ class: "input-box font-mono" },
        placeholder: "http://host.docker.internal:8000",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        value: (__VLS_ctx.multimodalForm.sttModel),
        type: "text",
        ...{ class: "input-box font-mono" },
        placeholder: "Qwen/Qwen3-ASR-1.7B",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        type: "number",
        min: "1000",
        ...{ class: "input-box" },
    });
    (__VLS_ctx.multimodalForm.sttTimeoutMs);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "md:col-span-2" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "text-gray-600 font-normal" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        type: "password",
        ...{ class: "input-box" },
        autocomplete: "off",
        placeholder: "Bearer token if required",
    });
    (__VLS_ctx.multimodalForm.sttApiKey);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "border-t border-purple-500/10 pt-3 space-y-3" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "text-xs uppercase tracking-[0.18em] text-gray-500" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "multimodal-grid" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "md:col-span-2" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        value: (__VLS_ctx.multimodalForm.ttsBaseUrl),
        type: "text",
        ...{ class: "input-box font-mono" },
        placeholder: "http://host.docker.internal:5000",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "text-gray-600 font-normal" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        value: (__VLS_ctx.multimodalForm.ttsModel),
        type: "text",
        ...{ class: "input-box font-mono" },
        placeholder: "service default",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        value: (__VLS_ctx.multimodalForm.ttsDefaultLanguage),
        type: "text",
        ...{ class: "input-box font-mono" },
        placeholder: "English",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        value: (__VLS_ctx.multimodalForm.ttsDefaultSpeaker),
        type: "text",
        ...{ class: "input-box font-mono" },
        placeholder: "Vivian",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "text-gray-600 font-normal" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        value: (__VLS_ctx.multimodalForm.ttsDefaultVoiceId),
        type: "text",
        ...{ class: "input-box font-mono" },
        placeholder: "saved voice id from Qwen3 /voices",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        type: "number",
        min: "1000",
        ...{ class: "input-box" },
    });
    (__VLS_ctx.multimodalForm.ttsTimeoutMs);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "text-gray-600 font-normal" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        type: "password",
        ...{ class: "input-box" },
        autocomplete: "off",
        placeholder: "Bearer token if required",
    });
    (__VLS_ctx.multimodalForm.ttsApiKey);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "md:col-span-2" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "text-gray-600 font-normal" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        value: (__VLS_ctx.multimodalForm.ttsVoiceSamplePath),
        type: "text",
        ...{ class: "input-box font-mono" },
        placeholder: "workspace-relative sample, e.g. samples/my-voice.wav",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "md:col-span-2" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "text-gray-600 font-normal" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.textarea)({
        value: (__VLS_ctx.multimodalForm.ttsVoiceSampleText),
        ...{ class: "input-box font-mono text-xs resize-none" },
        rows: "3",
        placeholder: "Exact words spoken in the audio example for higher quality cloning",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "rounded-xl border border-purple-500/10 bg-gray-950/40 p-3 space-y-3" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "text-xs uppercase tracking-[0.18em] text-gray-500" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "text-xs text-gray-500 mt-1" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "multimodal-grid" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        value: (__VLS_ctx.savedVoiceForm.name),
        type: "text",
        ...{ class: "input-box" },
        placeholder: "e.g. Steffen Voice",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        value: (__VLS_ctx.savedVoiceForm.language),
        type: "text",
        ...{ class: "input-box font-mono" },
        placeholder: "English",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "md:col-span-2" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        ...{ onChange: (__VLS_ctx.onSavedVoiceFileSelected) },
        type: "file",
        accept: "audio/*",
        ...{ class: "input-box" },
    });
    if (__VLS_ctx.savedVoiceForm.fileName) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "mt-2 text-[11px] text-gray-500" },
        });
        (__VLS_ctx.savedVoiceForm.fileName);
    }
    if (__VLS_ctx.savedVoiceForm.message) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-xs" },
            ...{ class: (__VLS_ctx.savedVoiceForm.error ? 'text-red-400' : 'text-green-300') },
        });
        (__VLS_ctx.savedVoiceForm.message);
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "flex justify-end" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (__VLS_ctx.saveVoiceSampleToLibrary) },
        disabled: (__VLS_ctx.savedVoiceForm.saving || !__VLS_ctx.savedVoiceForm.file),
        ...{ class: "btn-ghost px-4 py-2 rounded-xl text-xs" },
    });
    (__VLS_ctx.savedVoiceForm.saving ? 'Saving Voice…' : 'Upload And Save Voice');
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "border-t border-purple-500/10 pt-3 space-y-3" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "text-xs uppercase tracking-[0.18em] text-gray-500" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "text-xs text-gray-500" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "multimodal-grid" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "md:col-span-2" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "text-gray-600 font-normal" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        value: (__VLS_ctx.multimodalForm.imageGenBaseUrl),
        type: "text",
        ...{ class: "input-box font-mono" },
        placeholder: "http://image-generation-service:5005",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "text-gray-600 font-normal" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        value: (__VLS_ctx.multimodalForm.imageGenModel),
        type: "text",
        ...{ class: "input-box font-mono" },
        placeholder: "black-forest-labs/FLUX.1-schnell",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        type: "number",
        min: "1000",
        ...{ class: "input-box" },
    });
    (__VLS_ctx.multimodalForm.imageGenTimeoutMs);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        type: "number",
        min: "256",
        max: "2048",
        step: "64",
        ...{ class: "input-box" },
    });
    (__VLS_ctx.multimodalForm.imageGenDefaultWidth);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        type: "number",
        min: "256",
        max: "2048",
        step: "64",
        ...{ class: "input-box" },
    });
    (__VLS_ctx.multimodalForm.imageGenDefaultHeight);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        type: "number",
        min: "1",
        max: "100",
        ...{ class: "input-box" },
    });
    (__VLS_ctx.multimodalForm.imageGenDefaultSteps);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        type: "number",
        min: "0",
        max: "20",
        step: "0.5",
        ...{ class: "input-box" },
    });
    (__VLS_ctx.multimodalForm.imageGenGuidanceScale);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "md:col-span-2" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "text-gray-600 font-normal" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        type: "password",
        ...{ class: "input-box" },
        autocomplete: "off",
        placeholder: "Bearer token if required",
    });
    (__VLS_ctx.multimodalForm.imageGenApiKey);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "md:col-span-2 space-y-2" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "text-gray-600 font-normal" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.textarea)({
        value: (__VLS_ctx.multimodalForm.imageGenDefaultNegativePrompt),
        ...{ class: "input-box font-mono text-xs resize-none w-full" },
        rows: "3",
        placeholder: "e.g. low quality, blurry, deformed fingers, watermark",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "space-y-1.5" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "text-[11px] text-gray-500" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "flex flex-wrap gap-1.5" },
    });
    for (const [preset] of __VLS_getVForSourceType((__VLS_ctx.IMAGE_GEN_NEGATIVE_PRESETS))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
            ...{ onClick: (...[$event]) => {
                    if (!!(!__VLS_ctx.gateway.connected))
                        return;
                    if (!!(__VLS_ctx.multimodalStore.loading && !__VLS_ctx.multimodalLoaded))
                        return;
                    __VLS_ctx.applyNegativePreset(preset.value);
                } },
            key: (preset.label),
            ...{ class: "px-2.5 py-1 rounded-lg text-xs border border-purple-500/20 bg-purple-900/20 text-purple-200 hover:bg-purple-700/30 hover:border-purple-400/40 transition-colors" },
            title: (preset.value),
        });
        (preset.label);
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                if (!!(!__VLS_ctx.gateway.connected))
                    return;
                if (!!(__VLS_ctx.multimodalStore.loading && !__VLS_ctx.multimodalLoaded))
                    return;
                __VLS_ctx.multimodalForm.imageGenDefaultNegativePrompt = '';
            } },
        ...{ class: "px-2.5 py-1 rounded-lg text-xs border border-red-500/20 bg-red-900/10 text-red-300 hover:bg-red-800/20 transition-colors" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "border-t border-purple-500/10 pt-3 space-y-3" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "flex items-center justify-between gap-4" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "text-xs uppercase tracking-[0.18em] text-gray-500" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "text-xs text-gray-500 mt-1" },
    });
    /** @type {[typeof ToggleSwitch, ]} */ ;
    // @ts-ignore
    const __VLS_0 = __VLS_asFunctionalComponent(ToggleSwitch, new ToggleSwitch({
        ...{ 'onChange': {} },
        value: (__VLS_ctx.multimodalForm.wakeEnabled),
    }));
    const __VLS_1 = __VLS_0({
        ...{ 'onChange': {} },
        value: (__VLS_ctx.multimodalForm.wakeEnabled),
    }, ...__VLS_functionalComponentArgsRest(__VLS_0));
    let __VLS_3;
    let __VLS_4;
    let __VLS_5;
    const __VLS_6 = {
        onChange: (...[$event]) => {
            if (!!(!__VLS_ctx.gateway.connected))
                return;
            if (!!(__VLS_ctx.multimodalStore.loading && !__VLS_ctx.multimodalLoaded))
                return;
            __VLS_ctx.multimodalForm.wakeEnabled = $event;
        }
    };
    var __VLS_2;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "multimodal-grid" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        type: "number",
        min: "1000",
        max: "15000",
        ...{ class: "input-box" },
    });
    (__VLS_ctx.multimodalForm.wakeSilenceTimeoutMs);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "text-gray-600 font-normal" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        value: (__VLS_ctx.multimodalForm.wakeKeywordsText),
        type: "text",
        ...{ class: "input-box" },
        placeholder: "Hey Guarded, Okay Guarded, Luna",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "md:col-span-2" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "text-gray-600 font-normal" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        value: (__VLS_ctx.multimodalForm.wakeStopPhrasesText),
        type: "text",
        ...{ class: "input-box" },
        placeholder: "stop recording, end recording, stop listening",
    });
    if (__VLS_ctx.multimodalStore.error || __VLS_ctx.multimodalForm.error) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-sm text-red-400" },
        });
        (__VLS_ctx.multimodalForm.error || __VLS_ctx.multimodalStore.error);
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "flex justify-end" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (__VLS_ctx.submitMultimodalForm) },
        disabled: (__VLS_ctx.multimodalStore.saving || __VLS_ctx.multimodalStore.loading),
        ...{ class: "btn-grad px-5 py-2 rounded-xl text-sm" },
    });
    (__VLS_ctx.multimodalStore.saving ? 'Saving…' : 'Save Multimodal Settings');
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "glass-card p-5" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "flex items-center justify-between mb-4" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({
    ...{ class: "section-title mb-0" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "flex items-center gap-2" },
});
if (__VLS_ctx.guardrails.state) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.guardrails.state))
                    return;
                __VLS_ctx.guardrails.reset();
            } },
        disabled: (__VLS_ctx.guardrails.loading),
        ...{ class: "text-xs text-gray-500 hover:text-purple-400 transition-colors" },
    });
}
if (!__VLS_ctx.guardrails.state && __VLS_ctx.gateway.connected) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                if (!(!__VLS_ctx.guardrails.state && __VLS_ctx.gateway.connected))
                    return;
                __VLS_ctx.guardrails.fetch();
            } },
        disabled: (__VLS_ctx.guardrails.loading),
        ...{ class: "btn-ghost px-3 py-1.5 rounded-lg text-xs" },
    });
}
if (!__VLS_ctx.gateway.connected) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "empty-state" },
    });
}
else if (__VLS_ctx.guardrails.loading && !__VLS_ctx.guardrails.state) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "empty-state" },
    });
}
else if (__VLS_ctx.guardrails.error) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "text-sm text-red-400" },
    });
    (__VLS_ctx.guardrails.error);
}
else if (__VLS_ctx.guardrails.state) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "space-y-4" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "flex items-start justify-between gap-4" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "text-sm text-gray-200" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "text-xs text-gray-500 mt-0.5" },
    });
    /** @type {[typeof ToggleSwitch, ]} */ ;
    // @ts-ignore
    const __VLS_7 = __VLS_asFunctionalComponent(ToggleSwitch, new ToggleSwitch({
        ...{ 'onChange': {} },
        value: (__VLS_ctx.guardrails.state.promptInjectionBlock),
        disabled: (__VLS_ctx.guardrails.loading),
    }));
    const __VLS_8 = __VLS_7({
        ...{ 'onChange': {} },
        value: (__VLS_ctx.guardrails.state.promptInjectionBlock),
        disabled: (__VLS_ctx.guardrails.loading),
    }, ...__VLS_functionalComponentArgsRest(__VLS_7));
    let __VLS_10;
    let __VLS_11;
    let __VLS_12;
    const __VLS_13 = {
        onChange: (...[$event]) => {
            if (!!(!__VLS_ctx.gateway.connected))
                return;
            if (!!(__VLS_ctx.guardrails.loading && !__VLS_ctx.guardrails.state))
                return;
            if (!!(__VLS_ctx.guardrails.error))
                return;
            if (!(__VLS_ctx.guardrails.state))
                return;
            __VLS_ctx.guardrails.update({ promptInjectionBlock: $event });
        }
    };
    var __VLS_9;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div)({
        ...{ class: "border-t border-purple-500/10" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "flex items-start justify-between gap-4" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "text-sm text-gray-200" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "text-xs text-gray-500 mt-0.5" },
    });
    /** @type {[typeof ToggleSwitch, ]} */ ;
    // @ts-ignore
    const __VLS_14 = __VLS_asFunctionalComponent(ToggleSwitch, new ToggleSwitch({
        ...{ 'onChange': {} },
        value: (__VLS_ctx.guardrails.state.outputSecretScan),
        disabled: (__VLS_ctx.guardrails.loading),
    }));
    const __VLS_15 = __VLS_14({
        ...{ 'onChange': {} },
        value: (__VLS_ctx.guardrails.state.outputSecretScan),
        disabled: (__VLS_ctx.guardrails.loading),
    }, ...__VLS_functionalComponentArgsRest(__VLS_14));
    let __VLS_17;
    let __VLS_18;
    let __VLS_19;
    const __VLS_20 = {
        onChange: (...[$event]) => {
            if (!!(!__VLS_ctx.gateway.connected))
                return;
            if (!!(__VLS_ctx.guardrails.loading && !__VLS_ctx.guardrails.state))
                return;
            if (!!(__VLS_ctx.guardrails.error))
                return;
            if (!(__VLS_ctx.guardrails.state))
                return;
            __VLS_ctx.guardrails.update({ outputSecretScan: $event });
        }
    };
    var __VLS_16;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div)({
        ...{ class: "border-t border-purple-500/10" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "space-y-2" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "flex items-center justify-between" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "text-sm text-gray-200" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "text-xs text-gray-500 mt-0.5" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "text-sm font-mono text-purple-300 tabular-nums" },
    });
    (__VLS_ctx.guardrails.state.maxInputLength.toLocaleString());
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        ...{ onChange: (...[$event]) => {
                if (!!(!__VLS_ctx.gateway.connected))
                    return;
                if (!!(__VLS_ctx.guardrails.loading && !__VLS_ctx.guardrails.state))
                    return;
                if (!!(__VLS_ctx.guardrails.error))
                    return;
                if (!(__VLS_ctx.guardrails.state))
                    return;
                __VLS_ctx.guardrails.update({ maxInputLength: Number($event.target.value) });
            } },
        type: "range",
        min: "1000",
        max: "100000",
        step: "1000",
        value: (__VLS_ctx.guardrails.state.maxInputLength),
        disabled: (__VLS_ctx.guardrails.loading),
        ...{ class: "w-full accent-purple-500" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "flex justify-between text-xs text-gray-600" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div)({
        ...{ class: "border-t border-purple-500/10" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "flex items-start justify-between gap-4 opacity-50" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "text-sm text-gray-200" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "ml-1 text-xs text-amber-500" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "text-xs text-gray-500 mt-0.5" },
    });
    /** @type {[typeof ToggleSwitch, ]} */ ;
    // @ts-ignore
    const __VLS_21 = __VLS_asFunctionalComponent(ToggleSwitch, new ToggleSwitch({
        value: (true),
        disabled: (true),
    }));
    const __VLS_22 = __VLS_21({
        value: (true),
        disabled: (true),
    }, ...__VLS_functionalComponentArgsRest(__VLS_21));
}
else if (__VLS_ctx.gateway.connected && !__VLS_ctx.guardrails.state && !__VLS_ctx.guardrails.loading) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "empty-state" },
    });
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "glass-card p-5" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({
    ...{ class: "section-title" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "text-sm text-gray-500 space-y-1" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "text-gray-300" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
    ...{ class: "text-xs mt-2" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "space-y-5" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "glass-card p-5" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "flex items-center justify-between mb-4" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({
    ...{ class: "section-title mb-0" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "flex gap-2" },
});
if (__VLS_ctx.gateway.connected && !__VLS_ctx.sites.sites.length) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.gateway.connected && !__VLS_ctx.sites.sites.length))
                    return;
                __VLS_ctx.sites.fetch();
            } },
        ...{ class: "btn-ghost px-3 py-1.5 rounded-lg text-xs" },
    });
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
    ...{ onClick: (...[$event]) => {
            __VLS_ctx.openSiteForm(null);
        } },
    disabled: (!__VLS_ctx.gateway.connected),
    ...{ class: "btn-grad px-3 py-1.5 rounded-lg text-xs" },
});
if (!__VLS_ctx.gateway.connected) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "empty-state" },
    });
}
else if (__VLS_ctx.sites.loading && !__VLS_ctx.sites.sites.length) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "empty-state" },
    });
}
else if (__VLS_ctx.sites.error) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "text-sm text-red-400" },
    });
    (__VLS_ctx.sites.error);
}
else if (__VLS_ctx.sites.sites.length) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "space-y-2" },
    });
    for (const [site] of __VLS_getVForSourceType((__VLS_ctx.sites.sites))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            key: (site.hostname),
            ...{ class: "site-row" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "min-w-0 flex-1" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "flex items-center gap-2 flex-wrap" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "text-sm font-mono text-gray-100" },
        });
        (site.hostname);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: (site.source === 'config' ? 'badge-config' : 'badge-store') },
        });
        (site.source);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-xs text-gray-500 mt-0.5" },
        });
        (site.username);
        if (site.loginUrl) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "text-xs text-gray-600 truncate mt-0.5" },
            });
            (site.loginUrl);
        }
        if (site.urls && Object.keys(site.urls).length) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "flex flex-wrap gap-1 mt-1.5" },
            });
            for (const [url, label] of __VLS_getVForSourceType((site.urls))) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    key: (label),
                    ...{ class: "text-xs bg-purple-900/30 text-purple-300 border border-purple-700/30 px-1.5 py-0.5 rounded-full" },
                    title: (url),
                });
                (label);
            }
        }
        if (site.notes) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "text-xs text-gray-600 italic mt-0.5" },
            });
            (site.notes);
        }
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "flex gap-1 shrink-0" },
        });
        if (site.source === 'store') {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
                ...{ onClick: (...[$event]) => {
                        if (!!(!__VLS_ctx.gateway.connected))
                            return;
                        if (!!(__VLS_ctx.sites.loading && !__VLS_ctx.sites.sites.length))
                            return;
                        if (!!(__VLS_ctx.sites.error))
                            return;
                        if (!(__VLS_ctx.sites.sites.length))
                            return;
                        if (!(site.source === 'store'))
                            return;
                        __VLS_ctx.openSiteForm(site);
                    } },
                ...{ class: "icon-btn" },
                title: "Edit",
            });
        }
        else {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
                ...{ class: "icon-btn opacity-40 cursor-not-allowed" },
                title: "Defined in starlingai.json",
                disabled: true,
            });
        }
        if (site.source === 'store') {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
                ...{ onClick: (...[$event]) => {
                        if (!!(!__VLS_ctx.gateway.connected))
                            return;
                        if (!!(__VLS_ctx.sites.loading && !__VLS_ctx.sites.sites.length))
                            return;
                        if (!!(__VLS_ctx.sites.error))
                            return;
                        if (!(__VLS_ctx.sites.sites.length))
                            return;
                        if (!(site.source === 'store'))
                            return;
                        __VLS_ctx.confirmDeleteSite(site.hostname);
                    } },
                disabled: (__VLS_ctx.sites.loading),
                ...{ class: "icon-btn icon-btn--danger" },
                title: "Delete",
            });
        }
    }
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "empty-state" },
    });
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "glass-card p-5" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "flex items-center justify-between mb-4" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({
    ...{ class: "section-title mb-0" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "flex gap-2" },
});
if (__VLS_ctx.gateway.connected && !__VLS_ctx.scenesStore.scenes.length) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.gateway.connected && !__VLS_ctx.scenesStore.scenes.length))
                    return;
                __VLS_ctx.scenesStore.fetch();
            } },
        ...{ class: "btn-ghost px-3 py-1.5 rounded-lg text-xs" },
    });
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
    ...{ onClick: (...[$event]) => {
            __VLS_ctx.openSceneForm(null);
        } },
    disabled: (!__VLS_ctx.gateway.connected),
    ...{ class: "btn-grad px-3 py-1.5 rounded-lg text-xs" },
});
if (!__VLS_ctx.gateway.connected) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "empty-state" },
    });
}
else if (__VLS_ctx.scenesStore.loading && !__VLS_ctx.scenesStore.scenes.length) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "empty-state" },
    });
}
else if (__VLS_ctx.scenesStore.error) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "text-sm text-red-400" },
    });
    (__VLS_ctx.scenesStore.error);
}
else if (__VLS_ctx.scenesStore.scenes.length) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "space-y-2" },
    });
    for (const [scene] of __VLS_getVForSourceType((__VLS_ctx.scenesStore.scenes))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            key: (scene.name),
            ...{ class: "scene-row" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "flex items-start justify-between gap-3" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "min-w-0 flex-1" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "flex items-center gap-2 flex-wrap" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "text-sm font-mono text-gray-100" },
        });
        (scene.name);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: (scene.source === 'config' ? 'badge-config' : 'badge-store') },
        });
        (scene.source);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-xs text-gray-400 mt-0.5" },
        });
        (scene.description);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "flex gap-1 shrink-0" },
        });
        if (scene.source === 'store') {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
                ...{ onClick: (...[$event]) => {
                        if (!!(!__VLS_ctx.gateway.connected))
                            return;
                        if (!!(__VLS_ctx.scenesStore.loading && !__VLS_ctx.scenesStore.scenes.length))
                            return;
                        if (!!(__VLS_ctx.scenesStore.error))
                            return;
                        if (!(__VLS_ctx.scenesStore.scenes.length))
                            return;
                        if (!(scene.source === 'store'))
                            return;
                        __VLS_ctx.openSceneForm(scene);
                    } },
                ...{ class: "icon-btn" },
                title: "Edit",
            });
        }
        else {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
                ...{ class: "icon-btn opacity-40 cursor-not-allowed" },
                title: "Defined in starlingai.json",
                disabled: true,
            });
        }
        if (scene.source === 'store') {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
                ...{ onClick: (...[$event]) => {
                        if (!!(!__VLS_ctx.gateway.connected))
                            return;
                        if (!!(__VLS_ctx.scenesStore.loading && !__VLS_ctx.scenesStore.scenes.length))
                            return;
                        if (!!(__VLS_ctx.scenesStore.error))
                            return;
                        if (!(__VLS_ctx.scenesStore.scenes.length))
                            return;
                        if (!(scene.source === 'store'))
                            return;
                        __VLS_ctx.confirmDeleteScene(scene.name);
                    } },
                disabled: (__VLS_ctx.scenesStore.loading),
                ...{ class: "icon-btn icon-btn--danger" },
                title: "Delete",
            });
        }
        __VLS_asFunctionalElement(__VLS_intrinsicElements.details, __VLS_intrinsicElements.details)({
            ...{ class: "mt-2" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.summary, __VLS_intrinsicElements.summary)({
            ...{ class: "text-xs text-gray-600 cursor-pointer hover:text-purple-400 transition-colors select-none" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.pre, __VLS_intrinsicElements.pre)({
            ...{ class: "text-xs text-gray-500 mt-1.5 whitespace-pre-wrap break-words bg-gray-950/60 border border-purple-500/10 rounded-lg p-2.5 max-h-40 overflow-y-auto" },
        });
        (scene.task);
    }
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "empty-state" },
    });
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "glass-card p-5" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "flex items-center justify-between mb-4" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({
    ...{ class: "section-title mb-0" },
});
if (__VLS_ctx.gateway.connected) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.gateway.connected))
                    return;
                __VLS_ctx.agentsStore.fetch();
            } },
        ...{ class: "btn-ghost px-3 py-1.5 rounded-lg text-xs" },
    });
}
if (!__VLS_ctx.gateway.connected) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "empty-state" },
    });
}
else if (__VLS_ctx.agentsStore.loading && !__VLS_ctx.agentsStore.agents.length) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "empty-state" },
    });
}
else if (__VLS_ctx.agentsStore.error) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "text-sm text-red-400" },
    });
    (__VLS_ctx.agentsStore.error);
}
else if (__VLS_ctx.agentsStore.agents.length) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "space-y-4" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "routing-lab" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "flex items-start justify-between gap-3 flex-wrap" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "text-sm text-gray-200" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "text-xs text-gray-500 mt-0.5" },
    });
    if (__VLS_ctx.agentsStore.routingResult) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-[11px] text-gray-500" },
        });
        (__VLS_ctx.agentsStore.routingResult.mode);
        (__VLS_ctx.routingLab.minConfidence);
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "routing-lab-controls mt-3" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        ...{ onKeydown: (__VLS_ctx.runRoutingLab) },
        value: (__VLS_ctx.routingLab.query),
        type: "text",
        ...{ class: "input-box" },
        placeholder: "Try: login form automation, financial analysis, draft customer reply",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.select, __VLS_intrinsicElements.select)({
        value: (__VLS_ctx.routingLab.minConfidence),
        ...{ class: "input-box" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
        value: "high",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
        value: "medium",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
        value: "low",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (__VLS_ctx.runRoutingLab) },
        disabled: (__VLS_ctx.agentsStore.routingLoading || !__VLS_ctx.routingLab.query.trim()),
        ...{ class: "btn-grad px-3 py-2 rounded-xl text-xs" },
    });
    (__VLS_ctx.agentsStore.routingLoading ? 'Testing…' : 'Resolve');
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (__VLS_ctx.clearRoutingLab) },
        disabled: (__VLS_ctx.agentsStore.routingLoading),
        ...{ class: "btn-ghost px-3 py-2 rounded-xl text-xs" },
    });
    if (__VLS_ctx.agentsStore.routingError) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-xs text-red-400 mt-3" },
        });
        (__VLS_ctx.agentsStore.routingError);
    }
    else if (__VLS_ctx.agentsStore.routingResult) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "space-y-3 mt-3" },
        });
        if (!__VLS_ctx.agentsStore.routingResult.results.length && !__VLS_ctx.agentsStore.routingResult.weakCandidates.length) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "empty-state !py-4" },
            });
        }
        if (__VLS_ctx.agentsStore.routingResult.results.length) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "space-y-2" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "text-[11px] uppercase tracking-[0.18em] text-gray-500" },
            });
            for (const [candidate] of __VLS_getVForSourceType((__VLS_ctx.agentsStore.routingResult.results))) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    key: (`accepted-${candidate.name}`),
                    ...{ class: "routing-result-card" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "flex items-start justify-between gap-3" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "text-sm font-mono text-gray-100" },
                });
                (candidate.name);
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "text-xs text-gray-500 mt-0.5" },
                });
                (candidate.description);
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "text-right shrink-0" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: (['routing-confidence', `routing-confidence--${candidate.confidence}`]) },
                });
                (candidate.confidence);
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "text-[11px] text-gray-600 mt-1" },
                });
                (candidate.model.split('/').pop());
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "routing-meta-row mt-2" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
                (candidate.score.toFixed(2));
                if (candidate.matchedTerms.length) {
                    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
                    (candidate.matchedTerms.join(', '));
                }
                if (candidate.capabilities.length) {
                    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                        ...{ class: "routing-chip-row mt-2" },
                    });
                    for (const [capability] of __VLS_getVForSourceType((candidate.capabilities))) {
                        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                            key: (`${candidate.name}-${capability}`),
                            ...{ class: "routing-chip" },
                        });
                        (capability);
                    }
                }
            }
        }
        if (__VLS_ctx.agentsStore.routingResult.weakCandidates.length) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "space-y-2" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "text-[11px] uppercase tracking-[0.18em] text-gray-500" },
            });
            (__VLS_ctx.agentsStore.routingResult.gated ? 'Gated Candidates' : 'Weak Candidates');
            for (const [candidate] of __VLS_getVForSourceType((__VLS_ctx.agentsStore.routingResult.weakCandidates))) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    key: (`weak-${candidate.name}`),
                    ...{ class: "routing-result-card routing-result-card--weak" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "flex items-start justify-between gap-3" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "text-sm font-mono text-gray-100" },
                });
                (candidate.name);
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "text-xs text-gray-500 mt-0.5" },
                });
                (candidate.description);
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: (['routing-confidence', `routing-confidence--${candidate.confidence}`]) },
                });
                (candidate.confidence);
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "routing-meta-row mt-2" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
                (candidate.score.toFixed(2));
                if (candidate.matchedTerms.length) {
                    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
                    (candidate.matchedTerms.join(', '));
                }
            }
        }
    }
    for (const [agent] of __VLS_getVForSourceType((__VLS_ctx.agentsStore.agents))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.details, __VLS_intrinsicElements.details)({
            key: (agent.name),
            ...{ class: "agent-row" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.summary, __VLS_intrinsicElements.summary)({
            ...{ class: "flex items-center justify-between cursor-pointer select-none py-1" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "text-sm font-mono text-gray-100" },
        });
        (agent.name);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "text-xs text-gray-500 ml-2" },
        });
        (agent.model.primary?.split('/').pop());
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "text-xs text-gray-600" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "mt-3 space-y-3 pl-1" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-xs text-gray-500 italic mb-2" },
        });
        (agent.description);
        if (agent.capabilities?.length || agent.tags?.length) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "space-y-2" },
            });
            if (agent.capabilities?.length) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "routing-chip-row" },
                });
                for (const [capability] of __VLS_getVForSourceType((agent.capabilities))) {
                    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                        key: (`${agent.name}-cap-${capability}`),
                        ...{ class: "routing-chip" },
                    });
                    (capability);
                }
            }
            if (agent.tags?.length) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "routing-meta-row" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
                (agent.tags.join(', '));
            }
        }
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "grid grid-cols-2 gap-3" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
            ...{ class: "field-label text-xs" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
            ...{ onChange: (...[$event]) => {
                    if (!!(!__VLS_ctx.gateway.connected))
                        return;
                    if (!!(__VLS_ctx.agentsStore.loading && !__VLS_ctx.agentsStore.agents.length))
                        return;
                    if (!!(__VLS_ctx.agentsStore.error))
                        return;
                    if (!(__VLS_ctx.agentsStore.agents.length))
                        return;
                    __VLS_ctx.agentsStore.patchModel(agent.name, { temperature: +$event.target.value });
                } },
            type: "number",
            step: "0.05",
            min: "0",
            max: "2",
            value: (agent.model.temperature ?? 0.3),
            ...{ class: "input-box text-sm" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
            ...{ class: "field-label text-xs" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
            ...{ onChange: (...[$event]) => {
                    if (!!(!__VLS_ctx.gateway.connected))
                        return;
                    if (!!(__VLS_ctx.agentsStore.loading && !__VLS_ctx.agentsStore.agents.length))
                        return;
                    if (!!(__VLS_ctx.agentsStore.error))
                        return;
                    if (!(__VLS_ctx.agentsStore.agents.length))
                        return;
                    __VLS_ctx.agentsStore.patchModel(agent.name, { maxTokens: +$event.target.value });
                } },
            type: "number",
            step: "256",
            min: "256",
            max: "16384",
            value: (agent.model.maxTokens ?? 4096),
            ...{ class: "input-box text-sm" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
            ...{ class: "field-label text-xs" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
            ...{ onChange: (...[$event]) => {
                    if (!!(!__VLS_ctx.gateway.connected))
                        return;
                    if (!!(__VLS_ctx.agentsStore.loading && !__VLS_ctx.agentsStore.agents.length))
                        return;
                    if (!!(__VLS_ctx.agentsStore.error))
                        return;
                    if (!(__VLS_ctx.agentsStore.agents.length))
                        return;
                    __VLS_ctx.agentsStore.patchModel(agent.name, { topP: $event.target.value ? +$event.target.value : undefined });
                } },
            type: "number",
            step: "0.01",
            min: "0",
            max: "1",
            value: (agent.model.topP ?? ''),
            placeholder: "default",
            ...{ class: "input-box text-sm" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
            ...{ class: "field-label text-xs" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
            ...{ onChange: (...[$event]) => {
                    if (!!(!__VLS_ctx.gateway.connected))
                        return;
                    if (!!(__VLS_ctx.agentsStore.loading && !__VLS_ctx.agentsStore.agents.length))
                        return;
                    if (!!(__VLS_ctx.agentsStore.error))
                        return;
                    if (!(__VLS_ctx.agentsStore.agents.length))
                        return;
                    __VLS_ctx.agentsStore.patchModel(agent.name, { topK: $event.target.value ? +$event.target.value : undefined });
                } },
            type: "number",
            step: "1",
            min: "1",
            max: "200",
            value: (agent.model.topK ?? ''),
            placeholder: "default",
            ...{ class: "input-box text-sm" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
            ...{ class: "field-label text-xs" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
            ...{ onChange: (...[$event]) => {
                    if (!!(!__VLS_ctx.gateway.connected))
                        return;
                    if (!!(__VLS_ctx.agentsStore.loading && !__VLS_ctx.agentsStore.agents.length))
                        return;
                    if (!!(__VLS_ctx.agentsStore.error))
                        return;
                    if (!(__VLS_ctx.agentsStore.agents.length))
                        return;
                    __VLS_ctx.agentsStore.patchModel(agent.name, { minP: $event.target.value ? +$event.target.value : undefined });
                } },
            type: "number",
            step: "0.01",
            min: "0",
            max: "1",
            value: (agent.model.minP ?? ''),
            placeholder: "default",
            ...{ class: "input-box text-sm" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
            ...{ class: "field-label text-xs" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
            ...{ onChange: (...[$event]) => {
                    if (!!(!__VLS_ctx.gateway.connected))
                        return;
                    if (!!(__VLS_ctx.agentsStore.loading && !__VLS_ctx.agentsStore.agents.length))
                        return;
                    if (!!(__VLS_ctx.agentsStore.error))
                        return;
                    if (!(__VLS_ctx.agentsStore.agents.length))
                        return;
                    __VLS_ctx.agentsStore.patchModel(agent.name, { repeatPenalty: $event.target.value ? +$event.target.value : undefined });
                } },
            type: "number",
            step: "0.05",
            min: "0.5",
            max: "2",
            value: (agent.model.repeatPenalty ?? ''),
            placeholder: "default",
            ...{ class: "input-box text-sm" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
            ...{ class: "field-label text-xs" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
            ...{ onChange: (...[$event]) => {
                    if (!!(!__VLS_ctx.gateway.connected))
                        return;
                    if (!!(__VLS_ctx.agentsStore.loading && !__VLS_ctx.agentsStore.agents.length))
                        return;
                    if (!!(__VLS_ctx.agentsStore.error))
                        return;
                    if (!(__VLS_ctx.agentsStore.agents.length))
                        return;
                    __VLS_ctx.agentsStore.patchModel(agent.name, { seed: $event.target.value ? +$event.target.value : undefined });
                } },
            type: "number",
            step: "1",
            value: (agent.model.seed ?? ''),
            placeholder: "random",
            ...{ class: "input-box text-sm" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
            ...{ class: "field-label text-xs" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
            ...{ onChange: (...[$event]) => {
                    if (!!(!__VLS_ctx.gateway.connected))
                        return;
                    if (!!(__VLS_ctx.agentsStore.loading && !__VLS_ctx.agentsStore.agents.length))
                        return;
                    if (!!(__VLS_ctx.agentsStore.error))
                        return;
                    if (!(__VLS_ctx.agentsStore.agents.length))
                        return;
                    __VLS_ctx.agentsStore.patchModel(agent.name, { primary: $event.target.value });
                } },
            type: "text",
            value: (agent.model.primary ?? ''),
            ...{ class: "input-box text-sm font-mono" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "md:col-span-2" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
            ...{ class: "field-label text-xs" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "text-gray-600 font-normal" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
            ...{ onChange: (...[$event]) => {
                    if (!!(!__VLS_ctx.gateway.connected))
                        return;
                    if (!!(__VLS_ctx.agentsStore.loading && !__VLS_ctx.agentsStore.agents.length))
                        return;
                    if (!!(__VLS_ctx.agentsStore.error))
                        return;
                    if (!(__VLS_ctx.agentsStore.agents.length))
                        return;
                    __VLS_ctx.agentsStore.patchModel(agent.name, { baseUrl: $event.target.value || undefined });
                } },
            type: "text",
            value: (agent.model.baseUrl ?? ''),
            placeholder: "uses provider default",
            ...{ class: "input-box text-sm font-mono" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "md:col-span-2" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
            ...{ class: "field-label text-xs" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "text-gray-600 font-normal" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
            ...{ onChange: (...[$event]) => {
                    if (!!(!__VLS_ctx.gateway.connected))
                        return;
                    if (!!(__VLS_ctx.agentsStore.loading && !__VLS_ctx.agentsStore.agents.length))
                        return;
                    if (!!(__VLS_ctx.agentsStore.error))
                        return;
                    if (!(__VLS_ctx.agentsStore.agents.length))
                        return;
                    __VLS_ctx.agentsStore.patchModel(agent.name, { apiKey: $event.target.value || undefined });
                } },
            type: "password",
            value: (agent.model.apiKey ?? ''),
            placeholder: "uses provider default",
            autocomplete: "off",
            ...{ class: "input-box text-sm" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "md:col-span-2 flex items-center justify-between gap-4 pt-1" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
            ...{ class: "field-label text-xs" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "text-gray-600 font-normal" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
            ...{ class: "text-[11px] text-gray-600 mt-0.5" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.code, __VLS_intrinsicElements.code)({
            ...{ class: "text-gray-400" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.code, __VLS_intrinsicElements.code)({
            ...{ class: "text-gray-400" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.select, __VLS_intrinsicElements.select)({
            ...{ onChange: (...[$event]) => {
                    if (!!(!__VLS_ctx.gateway.connected))
                        return;
                    if (!!(__VLS_ctx.agentsStore.loading && !__VLS_ctx.agentsStore.agents.length))
                        return;
                    if (!!(__VLS_ctx.agentsStore.error))
                        return;
                    if (!(__VLS_ctx.agentsStore.agents.length))
                        return;
                    __VLS_ctx.agentsStore.patchModel(agent.name, { enableThinking: $event.target.value === '' ? undefined : $event.target.value === 'on' });
                } },
            value: (agent.model.enableThinking === undefined ? '' : agent.model.enableThinking ? 'on' : 'off'),
            ...{ class: "input-box text-sm w-24 shrink-0" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
            value: "",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
            value: "on",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
            value: "off",
        });
    }
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "empty-state" },
    });
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "glass-card p-5" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "flex items-center justify-between mb-4 gap-3" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({
    ...{ class: "section-title mb-0" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "text-xs text-gray-500 mt-1" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "flex items-center gap-2" },
});
if (__VLS_ctx.gateway.connected) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (__VLS_ctx.fetchModelEndpointConfig) },
        disabled: (__VLS_ctx.modelEndpointForm.loading || __VLS_ctx.modelEndpointForm.saving),
        ...{ class: "btn-ghost px-3 py-1.5 rounded-lg text-xs" },
    });
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
    ...{ onClick: (__VLS_ctx.resetModelEndpointConfig) },
    disabled: (!__VLS_ctx.modelEndpointForm.lastLoaded || __VLS_ctx.modelEndpointForm.loading || __VLS_ctx.modelEndpointForm.saving),
    ...{ class: "btn-ghost px-3 py-1.5 rounded-lg text-xs" },
});
if (!__VLS_ctx.gateway.connected) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "empty-state" },
    });
}
else if (__VLS_ctx.modelEndpointForm.loading && !__VLS_ctx.modelEndpointForm.loaded) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "empty-state" },
    });
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "space-y-4" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "rounded-xl border border-cyan-500/15 bg-cyan-500/5 px-3 py-2 text-xs text-cyan-100/80" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "border-t border-purple-500/10 pt-3 space-y-3" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "flex items-center justify-between gap-3" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "text-xs uppercase tracking-[0.18em] text-gray-500" },
    });
    if (__VLS_ctx.getModelEndpointStatus('orchestrator')) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: (__VLS_ctx.getModelEndpointStatus('orchestrator')?.ok ? 'badge-running' : 'badge-health-bad') },
        });
        (__VLS_ctx.getModelEndpointStatus('orchestrator')?.ok ? 'healthy' : 'mismatch');
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "multimodal-grid" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "md:col-span-2" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        value: (__VLS_ctx.modelEndpointForm.orchestratorModel),
        type: "text",
        ...{ class: "input-box font-mono" },
        placeholder: "lmstudio/qwen/qwen3.5-35b-a3b",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "md:col-span-2" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "text-gray-600 font-normal" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        value: (__VLS_ctx.modelEndpointForm.orchestratorBaseUrl),
        type: "text",
        ...{ class: "input-box font-mono" },
        placeholder: "uses provider default when empty",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "md:col-span-2" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "text-gray-600 font-normal" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        type: "password",
        ...{ class: "input-box" },
        autocomplete: "off",
        placeholder: "uses provider default when empty",
    });
    (__VLS_ctx.modelEndpointForm.orchestratorApiKey);
    if (__VLS_ctx.getModelEndpointStatus('orchestrator')?.error) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-[11px] text-red-300" },
        });
        (__VLS_ctx.getModelEndpointStatus('orchestrator')?.error);
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "border-t border-purple-500/10 pt-3 space-y-3" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "flex items-center justify-between gap-3" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "text-xs uppercase tracking-[0.18em] text-gray-500" },
    });
    if (__VLS_ctx.getModelEndpointStatus('embeddings')) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: (__VLS_ctx.getModelEndpointStatus('embeddings')?.ok ? 'badge-running' : 'badge-health-bad') },
        });
        (__VLS_ctx.getModelEndpointStatus('embeddings')?.ok ? 'healthy' : 'mismatch');
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "multimodal-grid" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "md:col-span-2" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "text-gray-600 font-normal" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        value: (__VLS_ctx.modelEndpointForm.embeddingModel),
        type: "text",
        ...{ class: "input-box font-mono" },
        placeholder: "leave empty to disable semantic embeddings",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "md:col-span-2" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "text-gray-600 font-normal" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        value: (__VLS_ctx.modelEndpointForm.embeddingBaseUrl),
        type: "text",
        ...{ class: "input-box font-mono" },
        placeholder: "uses orchestrator/provider endpoint when empty",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "md:col-span-2" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "text-gray-600 font-normal" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        type: "password",
        ...{ class: "input-box" },
        autocomplete: "off",
        placeholder: "uses orchestrator/provider key when empty",
    });
    (__VLS_ctx.modelEndpointForm.embeddingApiKey);
    if (__VLS_ctx.getModelEndpointStatus('embeddings')?.error) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-[11px] text-red-300" },
        });
        (__VLS_ctx.getModelEndpointStatus('embeddings')?.error);
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "border-t border-purple-500/10 pt-3 space-y-3" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "flex items-center justify-between gap-4" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "text-xs uppercase tracking-[0.18em] text-gray-500" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "text-xs text-gray-500 mt-1" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "flex items-center gap-2" },
    });
    if (__VLS_ctx.getModelEndpointStatus('reranker')) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: (__VLS_ctx.getModelEndpointStatus('reranker')?.ok ? 'badge-running' : 'badge-health-bad') },
        });
        (__VLS_ctx.getModelEndpointStatus('reranker')?.ok ? 'healthy' : 'mismatch');
    }
    /** @type {[typeof ToggleSwitch, ]} */ ;
    // @ts-ignore
    const __VLS_24 = __VLS_asFunctionalComponent(ToggleSwitch, new ToggleSwitch({
        ...{ 'onChange': {} },
        value: (__VLS_ctx.modelEndpointForm.rerankerEnabled),
    }));
    const __VLS_25 = __VLS_24({
        ...{ 'onChange': {} },
        value: (__VLS_ctx.modelEndpointForm.rerankerEnabled),
    }, ...__VLS_functionalComponentArgsRest(__VLS_24));
    let __VLS_27;
    let __VLS_28;
    let __VLS_29;
    const __VLS_30 = {
        onChange: (...[$event]) => {
            if (!!(!__VLS_ctx.gateway.connected))
                return;
            if (!!(__VLS_ctx.modelEndpointForm.loading && !__VLS_ctx.modelEndpointForm.loaded))
                return;
            __VLS_ctx.modelEndpointForm.rerankerEnabled = $event;
        }
    };
    var __VLS_26;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "multimodal-grid" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "md:col-span-2" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        value: (__VLS_ctx.modelEndpointForm.rerankerModel),
        type: "text",
        ...{ class: "input-box font-mono" },
        placeholder: "Qwen/Qwen3-Reranker-4B",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "md:col-span-2" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        value: (__VLS_ctx.modelEndpointForm.rerankerBaseUrl),
        type: "text",
        ...{ class: "input-box font-mono" },
        placeholder: "http://host.docker.internal:1234/v1",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "md:col-span-2" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        type: "password",
        ...{ class: "input-box" },
        autocomplete: "off",
        placeholder: "lm-studio",
    });
    (__VLS_ctx.modelEndpointForm.rerankerApiKey);
    if (__VLS_ctx.getModelEndpointStatus('reranker')?.error) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-[11px] text-red-300" },
        });
        (__VLS_ctx.getModelEndpointStatus('reranker')?.error);
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "border-t border-purple-500/10 pt-3 space-y-3" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "flex items-center justify-between gap-4" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "text-xs uppercase tracking-[0.18em] text-gray-500" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "text-xs text-gray-500 mt-1" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "flex items-center gap-2" },
    });
    if (__VLS_ctx.getModelEndpointStatus('guard')) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: (__VLS_ctx.getModelEndpointStatus('guard')?.ok ? 'badge-running' : 'badge-health-bad') },
        });
        (__VLS_ctx.getModelEndpointStatus('guard')?.ok ? 'healthy' : 'mismatch');
    }
    /** @type {[typeof ToggleSwitch, ]} */ ;
    // @ts-ignore
    const __VLS_31 = __VLS_asFunctionalComponent(ToggleSwitch, new ToggleSwitch({
        ...{ 'onChange': {} },
        value: (__VLS_ctx.modelEndpointForm.guardEnabled),
    }));
    const __VLS_32 = __VLS_31({
        ...{ 'onChange': {} },
        value: (__VLS_ctx.modelEndpointForm.guardEnabled),
    }, ...__VLS_functionalComponentArgsRest(__VLS_31));
    let __VLS_34;
    let __VLS_35;
    let __VLS_36;
    const __VLS_37 = {
        onChange: (...[$event]) => {
            if (!!(!__VLS_ctx.gateway.connected))
                return;
            if (!!(__VLS_ctx.modelEndpointForm.loading && !__VLS_ctx.modelEndpointForm.loaded))
                return;
            __VLS_ctx.modelEndpointForm.guardEnabled = $event;
        }
    };
    var __VLS_33;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "multimodal-grid" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "md:col-span-2" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        value: (__VLS_ctx.modelEndpointForm.guardModel),
        type: "text",
        ...{ class: "input-box font-mono" },
        placeholder: "Qwen/Qwen3Guard-Gen-4B",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "md:col-span-2" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        value: (__VLS_ctx.modelEndpointForm.guardBaseUrl),
        type: "text",
        ...{ class: "input-box font-mono" },
        placeholder: "http://host.docker.internal:1234/v1",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "md:col-span-2" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        type: "password",
        ...{ class: "input-box" },
        autocomplete: "off",
        placeholder: "lm-studio",
    });
    (__VLS_ctx.modelEndpointForm.guardApiKey);
    if (__VLS_ctx.getModelEndpointStatus('guard')?.error) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-[11px] text-red-300" },
        });
        (__VLS_ctx.getModelEndpointStatus('guard')?.error);
    }
    if (__VLS_ctx.modelEndpointForm.error) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-sm text-red-400" },
        });
        (__VLS_ctx.modelEndpointForm.error);
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "flex justify-end" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (__VLS_ctx.submitModelEndpointConfig) },
        disabled: (__VLS_ctx.modelEndpointForm.loading || __VLS_ctx.modelEndpointForm.saving),
        ...{ class: "btn-grad px-5 py-2 rounded-xl text-sm" },
    });
    (__VLS_ctx.modelEndpointForm.saving ? 'Saving…' : 'Save Model Routing');
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "glass-card p-5" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "flex items-center justify-between mb-4" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "flex items-center gap-3" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({
    ...{ class: "section-title mb-0" },
});
if (__VLS_ctx.channelsStore.deadLetterCount > 0) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "text-xs px-2 py-0.5 rounded-full bg-red-900/60 text-red-300 font-medium" },
        title: "Messages that failed all delivery retries",
    });
    (__VLS_ctx.channelsStore.deadLetterCount);
    (__VLS_ctx.channelsStore.deadLetterCount === 1 ? '' : 's');
}
if (__VLS_ctx.gateway.connected) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.gateway.connected))
                    return;
                __VLS_ctx.channelsStore.fetch();
                __VLS_ctx.channelsStore.fetchDeadLetterCount();
            } },
        ...{ class: "btn-ghost px-3 py-1.5 rounded-lg text-xs" },
    });
}
if (!__VLS_ctx.gateway.connected) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "empty-state" },
    });
}
else if (__VLS_ctx.channelsStore.loading && !__VLS_ctx.channelsStore.channels.length) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "empty-state" },
    });
}
else if (__VLS_ctx.channelsStore.error) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "text-sm text-red-400" },
    });
    (__VLS_ctx.channelsStore.error);
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "space-y-2" },
    });
    if (__VLS_ctx.channelsStore.deadLetters.length) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "channel-incident-panel" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "flex items-center justify-between gap-3" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-sm text-gray-200" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-xs text-gray-500 mt-0.5" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-[11px] text-red-300" },
        });
        (__VLS_ctx.channelsStore.deadLetters.length);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "mt-3 space-y-2" },
        });
        for (const [entry] of __VLS_getVForSourceType((__VLS_ctx.channelsStore.deadLetters.slice(0, 4)))) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                key: (`${entry.channel}-${entry.ts}-${entry.error}`),
                ...{ class: "channel-incident-row" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "flex items-center justify-between gap-3" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "badge-health-bad" },
            });
            (entry.channel);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "text-[11px] text-gray-600" },
            });
            (__VLS_ctx.formatTimestamp(entry.ts));
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "text-xs text-gray-300 mt-2 break-words" },
            });
            (entry.error);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "text-[11px] text-gray-500 mt-1" },
            });
            (entry.attempts);
            (entry.messagePreview || 'No preview available');
        }
    }
    for (const [def] of __VLS_getVForSourceType((__VLS_ctx.CHANNEL_DEFS))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            key: (def.type),
            ...{ class: "channel-row" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "flex items-center justify-between gap-3" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "flex items-center gap-3 min-w-0 flex-1" },
        });
        /** @type {[typeof ChannelIcon, ]} */ ;
        // @ts-ignore
        const __VLS_38 = __VLS_asFunctionalComponent(ChannelIcon, new ChannelIcon({
            type: (def.type),
            ...{ class: "shrink-0" },
        }));
        const __VLS_39 = __VLS_38({
            type: (def.type),
            ...{ class: "shrink-0" },
        }, ...__VLS_functionalComponentArgsRest(__VLS_38));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "min-w-0" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "flex items-center gap-2 flex-wrap" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "text-sm font-medium text-gray-100" },
        });
        (def.label);
        if (__VLS_ctx.getChannelStatus(def.type).supported === false) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "badge-planned" },
                title: (__VLS_ctx.getChannelStatus(def.type).reason ?? 'Channel runtime is not implemented yet'),
            });
        }
        if (__VLS_ctx.getChannelStatus(def.type).running) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "badge-running" },
            });
        }
        else if (__VLS_ctx.getChannelStatus(def.type).enabled) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "badge-config" },
            });
        }
        else {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "badge-off" },
            });
        }
        if (__VLS_ctx.getChannelStatus(def.type).health) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: (__VLS_ctx.getChannelStatus(def.type).health?.healthy ? 'badge-running' : 'badge-health-bad') },
                title: (__VLS_ctx.formatHealthTitle(__VLS_ctx.getChannelStatus(def.type))),
            });
            (__VLS_ctx.getChannelStatus(def.type).health?.healthy ? 'healthy' : 'degraded');
        }
        if (__VLS_ctx.getChannelStatus(def.type).operatorState) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: (__VLS_ctx.operatorStateBadgeClass(__VLS_ctx.getChannelStatus(def.type))) },
                title: (__VLS_ctx.getChannelStatus(def.type).operatorState?.summary),
            });
            (__VLS_ctx.getChannelStatus(def.type).operatorState?.severity);
        }
        if (__VLS_ctx.getChannelStatus(def.type).error) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "text-xs text-red-400 truncate" },
                title: (__VLS_ctx.getChannelStatus(def.type).error),
            });
        }
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-xs text-gray-500 mt-0.5" },
        });
        (def.description);
        if (__VLS_ctx.getChannelStatus(def.type).operatorState?.summary) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "mt-1 text-[11px]" },
                ...{ class: (__VLS_ctx.operatorStateTextClass(__VLS_ctx.getChannelStatus(def.type))) },
            });
            (__VLS_ctx.getChannelStatus(def.type).operatorState?.summary);
        }
        if (__VLS_ctx.getChannelStatus(def.type).metrics) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "mt-2 channel-metrics-grid text-[11px] text-gray-500" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
            __VLS_asFunctionalElement(__VLS_intrinsicElements.strong, __VLS_intrinsicElements.strong)({
                ...{ class: "text-gray-300" },
            });
            (__VLS_ctx.getChannelStatus(def.type).metrics?.delivered);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
            __VLS_asFunctionalElement(__VLS_intrinsicElements.strong, __VLS_intrinsicElements.strong)({
                ...{ class: (__VLS_ctx.getChannelStatus(def.type).metrics?.deliveryFailures ? 'text-red-300' : 'text-gray-300') },
            });
            (__VLS_ctx.getChannelStatus(def.type).metrics?.deliveryFailures);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
            __VLS_asFunctionalElement(__VLS_intrinsicElements.strong, __VLS_intrinsicElements.strong)({
                ...{ class: (__VLS_ctx.getChannelStatus(def.type).metrics?.ingressDenied ? 'text-amber-300' : 'text-gray-300') },
            });
            (__VLS_ctx.getChannelStatus(def.type).metrics?.ingressDenied);
            if (__VLS_ctx.getChannelStatus(def.type).health?.latencyMs !== undefined) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
                __VLS_asFunctionalElement(__VLS_intrinsicElements.strong, __VLS_intrinsicElements.strong)({
                    ...{ class: "text-gray-300" },
                });
                (__VLS_ctx.getChannelStatus(def.type).health?.latencyMs);
            }
            if (__VLS_ctx.getChannelStatus(def.type).metrics?.deliveryWindows?.last5m) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
                __VLS_asFunctionalElement(__VLS_intrinsicElements.strong, __VLS_intrinsicElements.strong)({
                    ...{ class: (__VLS_ctx.windowSuccessRateClass(__VLS_ctx.getChannelStatus(def.type).metrics?.deliveryWindows?.last5m?.successRatePct)) },
                });
                (__VLS_ctx.formatPercent(__VLS_ctx.getChannelStatus(def.type).metrics?.deliveryWindows?.last5m?.successRatePct));
            }
            if (__VLS_ctx.getChannelStatus(def.type).metrics?.deliveryLatency?.p95Ms !== undefined) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
                __VLS_asFunctionalElement(__VLS_intrinsicElements.strong, __VLS_intrinsicElements.strong)({
                    ...{ class: "text-gray-300" },
                });
                (__VLS_ctx.getChannelStatus(def.type).metrics?.deliveryLatency?.p95Ms);
            }
        }
        if (__VLS_ctx.getChannelStatus(def.type).metrics?.lastDeliveryError || __VLS_ctx.getChannelStatus(def.type).health?.error || __VLS_ctx.getChannelStatus(def.type).metrics?.lastIngressDeniedAt) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "mt-1 text-[11px] text-gray-600 space-y-0.5" },
            });
            if (__VLS_ctx.getChannelStatus(def.type).metrics?.lastDeliveryError) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "truncate" },
                    title: (__VLS_ctx.getChannelStatus(def.type).metrics?.lastDeliveryError),
                });
                (__VLS_ctx.getChannelStatus(def.type).metrics?.lastDeliveryError);
            }
            if (__VLS_ctx.getChannelStatus(def.type).health?.error) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "truncate" },
                    title: (__VLS_ctx.getChannelStatus(def.type).health?.error),
                });
                (__VLS_ctx.getChannelStatus(def.type).health?.error);
            }
            if (__VLS_ctx.getChannelStatus(def.type).metrics?.lastIngressDeniedAt) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
                (__VLS_ctx.formatTimestamp(__VLS_ctx.getChannelStatus(def.type).metrics?.lastIngressDeniedAt));
            }
        }
        __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
            ...{ onClick: (...[$event]) => {
                    if (!!(!__VLS_ctx.gateway.connected))
                        return;
                    if (!!(__VLS_ctx.channelsStore.loading && !__VLS_ctx.channelsStore.channels.length))
                        return;
                    if (!!(__VLS_ctx.channelsStore.error))
                        return;
                    void __VLS_ctx.openChannelForm(def);
                } },
            disabled: (!__VLS_ctx.gateway.connected),
            ...{ class: "icon-btn shrink-0" },
            title: "Configure",
        });
    }
}
if (__VLS_ctx.siteForm.open) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.siteForm.open))
                    return;
                __VLS_ctx.siteForm.open = false;
            } },
        ...{ class: "modal-backdrop" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "modal-box" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "modal-header" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({
        ...{ class: "font-semibold text-gray-100" },
    });
    (__VLS_ctx.siteForm.editing ? 'Edit Site' : 'Add Site');
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.siteForm.open))
                    return;
                __VLS_ctx.siteForm.open = false;
            } },
        ...{ class: "modal-close" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "space-y-4 p-5" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "text-red-400" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        value: (__VLS_ctx.siteForm.hostname),
        type: "text",
        ...{ class: "input-box" },
        placeholder: "e.g. github.com",
        disabled: (!!__VLS_ctx.siteForm.editing),
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "text-red-400" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        value: (__VLS_ctx.siteForm.username),
        type: "text",
        ...{ class: "input-box" },
        placeholder: "Email or username",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "text-red-400" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "ml-1 text-gray-600 font-normal text-xs" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        type: "password",
        ...{ class: "input-box" },
        autocomplete: "new-password",
        placeholder: "$MY_PASSWORD or secret:mykey",
    });
    (__VLS_ctx.siteForm.password);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        value: (__VLS_ctx.siteForm.loginUrl),
        type: "text",
        ...{ class: "input-box" },
        placeholder: "https://site.com/login",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "flex items-center justify-between mb-2" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label mb-0" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (__VLS_ctx.addUrlEntry) },
        type: "button",
        ...{ class: "text-xs text-purple-400 hover:text-purple-300 transition-colors" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "space-y-2" },
    });
    for (const [entry, i] of __VLS_getVForSourceType((__VLS_ctx.siteForm.urlEntries))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            key: (i),
            ...{ class: "flex gap-2 items-center" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
            value: (entry.label),
            type: "text",
            ...{ class: "input-box w-28 shrink-0" },
            placeholder: "label",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
            value: (entry.url),
            type: "text",
            ...{ class: "input-box flex-1" },
            placeholder: "https://…",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.siteForm.open))
                        return;
                    __VLS_ctx.siteForm.urlEntries.splice(i, 1);
                } },
            ...{ class: "text-gray-600 hover:text-red-400 transition-colors px-1 text-lg leading-none" },
        });
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        value: (__VLS_ctx.siteForm.notes),
        type: "text",
        ...{ class: "input-box" },
        placeholder: "Optional reminder",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.details, __VLS_intrinsicElements.details)({
        ...{ class: "text-xs text-gray-500" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.summary, __VLS_intrinsicElements.summary)({
        ...{ class: "cursor-pointer hover:text-purple-400 transition-colors select-none" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "space-y-2 mt-2" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        value: (__VLS_ctx.siteForm.usernameSelector),
        type: "text",
        ...{ class: "input-box" },
        placeholder: "Username selector",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        value: (__VLS_ctx.siteForm.passwordSelector),
        type: "text",
        ...{ class: "input-box" },
        placeholder: "Password selector",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        value: (__VLS_ctx.siteForm.submitSelector),
        type: "text",
        ...{ class: "input-box" },
        placeholder: "Submit button selector",
    });
    if (__VLS_ctx.siteForm.error) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "px-5 pb-2 text-sm text-red-400" },
        });
        (__VLS_ctx.siteForm.error);
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "modal-footer" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.siteForm.open))
                    return;
                __VLS_ctx.siteForm.open = false;
            } },
        ...{ class: "btn-ghost px-4 py-2 rounded-xl text-sm" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (__VLS_ctx.submitSiteForm) },
        disabled: (__VLS_ctx.sites.loading),
        ...{ class: "btn-grad px-5 py-2 rounded-xl text-sm" },
    });
    (__VLS_ctx.sites.loading ? 'Saving…' : 'Save');
}
if (__VLS_ctx.channelForm.open) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.channelForm.open))
                    return;
                __VLS_ctx.channelForm.open = false;
            } },
        ...{ class: "modal-backdrop" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "modal-box" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "modal-header" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({
        ...{ class: "font-semibold text-gray-100" },
    });
    (__VLS_ctx.channelForm.label);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.channelForm.open))
                    return;
                __VLS_ctx.channelForm.open = false;
            } },
        ...{ class: "modal-close" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "space-y-4 p-5" },
    });
    if (__VLS_ctx.channelRuntimeSupport.supported === false) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-200" },
        });
        (__VLS_ctx.channelRuntimeSupport.reason ?? 'Channel runtime is not implemented yet');
    }
    if (__VLS_ctx.channelForm.loadingDetails) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "rounded-xl border border-purple-500/10 bg-gray-950/50 px-3 py-2 text-sm text-gray-500" },
        });
    }
    else if (__VLS_ctx.channelForm.details?.status) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "channel-detail-panel" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "flex items-center justify-between gap-3 flex-wrap" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-sm text-gray-200" },
        });
        if (__VLS_ctx.channelForm.details.status.operatorState?.summary) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "text-xs mt-1" },
                ...{ class: (__VLS_ctx.operatorStateTextClass(__VLS_ctx.channelForm.details.status)) },
            });
            (__VLS_ctx.channelForm.details.status.operatorState?.summary);
        }
        if (__VLS_ctx.channelForm.details.status.operatorState) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: (__VLS_ctx.operatorStateBadgeClass(__VLS_ctx.channelForm.details.status)) },
            });
            (__VLS_ctx.channelForm.details.status.operatorState?.severity);
        }
        if (__VLS_ctx.channelForm.details.status.metrics) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "channel-detail-metrics mt-3" },
            });
            if (__VLS_ctx.channelForm.details.status.metrics.deliveryWindows?.last5m) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "channel-detail-stat" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "text-gray-500" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.strong, __VLS_intrinsicElements.strong)({
                    ...{ class: (__VLS_ctx.windowSuccessRateClass(__VLS_ctx.channelForm.details.status.metrics.deliveryWindows?.last5m?.successRatePct)) },
                });
                (__VLS_ctx.formatPercent(__VLS_ctx.channelForm.details.status.metrics.deliveryWindows?.last5m?.successRatePct));
            }
            if (__VLS_ctx.channelForm.details.status.metrics.deliveryWindows?.last1h) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "channel-detail-stat" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "text-gray-500" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.strong, __VLS_intrinsicElements.strong)({
                    ...{ class: (__VLS_ctx.windowSuccessRateClass(__VLS_ctx.channelForm.details.status.metrics.deliveryWindows?.last1h?.successRatePct)) },
                });
                (__VLS_ctx.formatPercent(__VLS_ctx.channelForm.details.status.metrics.deliveryWindows?.last1h?.successRatePct));
            }
            if (__VLS_ctx.channelForm.details.status.metrics.deliveryLatency?.p95Ms !== undefined) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "channel-detail-stat" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "text-gray-500" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.strong, __VLS_intrinsicElements.strong)({
                    ...{ class: "text-gray-100" },
                });
                (__VLS_ctx.channelForm.details.status.metrics.deliveryLatency?.p95Ms);
            }
            if (__VLS_ctx.channelForm.details.status.metrics.deliveryLatency?.p99Ms !== undefined) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "channel-detail-stat" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "text-gray-500" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.strong, __VLS_intrinsicElements.strong)({
                    ...{ class: "text-gray-100" },
                });
                (__VLS_ctx.channelForm.details.status.metrics.deliveryLatency?.p99Ms);
            }
        }
        if (__VLS_ctx.channelForm.details.operator?.recentDeadLetters?.length) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "mt-3" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "text-xs uppercase tracking-[0.18em] text-gray-500" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "mt-2 space-y-2" },
            });
            for (const [entry] of __VLS_getVForSourceType((__VLS_ctx.channelForm.details.operator.recentDeadLetters))) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    key: (`${entry.channel}-${entry.ts}-${entry.error}`),
                    ...{ class: "channel-incident-row" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "flex items-center justify-between gap-3" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "text-xs text-red-300" },
                });
                (entry.error);
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "text-[11px] text-gray-600" },
                });
                (__VLS_ctx.formatTimestamp(entry.ts));
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "text-[11px] text-gray-500 mt-1" },
                });
                (entry.attempts);
                (entry.messagePreview || 'No preview available');
            }
        }
        if (__VLS_ctx.channelForm.details.operator?.recoveryProcedures?.length) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "mt-3" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "text-xs uppercase tracking-[0.18em] text-gray-500" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.ul, __VLS_intrinsicElements.ul)({
                ...{ class: "mt-2 space-y-1.5 text-xs text-gray-400 list-disc pl-4" },
            });
            for (const [step] of __VLS_getVForSourceType((__VLS_ctx.channelForm.details.operator.recoveryProcedures))) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.li, __VLS_intrinsicElements.li)({
                    key: (step),
                });
                (step);
            }
        }
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "flex items-center justify-between gap-4" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "text-sm text-gray-200" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "text-xs text-gray-500 mt-0.5" },
    });
    /** @type {[typeof ToggleSwitch, ]} */ ;
    // @ts-ignore
    const __VLS_41 = __VLS_asFunctionalComponent(ToggleSwitch, new ToggleSwitch({
        ...{ 'onChange': {} },
        value: (!!__VLS_ctx.channelForm.config.enabled),
    }));
    const __VLS_42 = __VLS_41({
        ...{ 'onChange': {} },
        value: (!!__VLS_ctx.channelForm.config.enabled),
    }, ...__VLS_functionalComponentArgsRest(__VLS_41));
    let __VLS_44;
    let __VLS_45;
    let __VLS_46;
    const __VLS_47 = {
        onChange: (...[$event]) => {
            if (!(__VLS_ctx.channelForm.open))
                return;
            __VLS_ctx.channelForm.config.enabled = $event;
        }
    };
    var __VLS_43;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div)({
        ...{ class: "border-t border-purple-500/10" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "text-xs text-gray-500" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "grid grid-cols-1 md:grid-cols-2 gap-3 border-t border-purple-500/10 pt-3" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        type: "number",
        min: "1",
        max: "500",
        ...{ class: "input-box" },
        placeholder: "50",
    });
    (__VLS_ctx.channelForm.config.historyLimit);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        type: "number",
        min: "1",
        max: "200",
        ...{ class: "input-box" },
        placeholder: "12",
    });
    (__VLS_ctx.channelForm.config.perSenderRateLimitCount);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "md:col-span-2" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        type: "number",
        min: "1000",
        max: "3600000",
        ...{ class: "input-box" },
        placeholder: "60000",
    });
    (__VLS_ctx.channelForm.config.perSenderRateLimitWindowMs);
    if (__VLS_ctx.channelForm.type === 'telegram') {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
            ...{ class: "field-label" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
            type: "password",
            ...{ class: "input-box" },
            autocomplete: "off",
            placeholder: "123456:ABC...",
        });
        (__VLS_ctx.channelForm.config.botToken);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
            ...{ class: "field-label" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "text-gray-500 font-normal" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
            ...{ onInput: (...[$event]) => {
                    if (!(__VLS_ctx.channelForm.open))
                        return;
                    if (!(__VLS_ctx.channelForm.type === 'telegram'))
                        return;
                    __VLS_ctx.channelForm.config.allowedUserIds = $event.target.value.split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n));
                } },
            value: ((__VLS_ctx.channelForm.config.allowedUserIds ?? []).join(', ')),
            type: "text",
            ...{ class: "input-box" },
            placeholder: "Leave empty to allow all Telegram users",
        });
    }
    if (__VLS_ctx.channelForm.type !== 'telegram') {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
            ...{ class: "field-label" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.select, __VLS_intrinsicElements.select)({
            value: (__VLS_ctx.channelForm.config.dmPolicy),
            ...{ class: "input-box" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
            value: "pairing",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
            value: "open",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
            value: "allowlist",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
            value: "disabled",
        });
    }
    if (__VLS_ctx.channelForm.type === 'slack') {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
            ...{ class: "field-label" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "text-gray-500 font-normal" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
            type: "password",
            ...{ class: "input-box" },
            autocomplete: "off",
            placeholder: "xoxb-...",
        });
        (__VLS_ctx.channelForm.config.botToken);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
            ...{ class: "field-label" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
            type: "password",
            ...{ class: "input-box" },
            autocomplete: "off",
            placeholder: "Signing secret from Slack Basic Info",
        });
        (__VLS_ctx.channelForm.config.signingSecret);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
            ...{ class: "field-label" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "text-gray-500 font-normal" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
            type: "password",
            ...{ class: "input-box" },
            autocomplete: "off",
            placeholder: "xapp-... (Socket Mode only)",
        });
        (__VLS_ctx.channelForm.config.appToken);
    }
    if (__VLS_ctx.channelForm.fields.includes('token') && __VLS_ctx.channelForm.type === 'discord') {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
            ...{ class: "field-label" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
            type: "password",
            ...{ class: "input-box" },
            autocomplete: "off",
            placeholder: "Discord bot token",
        });
        (__VLS_ctx.channelForm.config.token);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
            ...{ class: "field-label" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "text-gray-500 font-normal" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
            ...{ onInput: (...[$event]) => {
                    if (!(__VLS_ctx.channelForm.open))
                        return;
                    if (!(__VLS_ctx.channelForm.fields.includes('token') && __VLS_ctx.channelForm.type === 'discord'))
                        return;
                    __VLS_ctx.channelForm.config.guildIds = $event.target.value.split(',').map(s => s.trim()).filter(Boolean);
                } },
            value: ((__VLS_ctx.channelForm.config.guildIds ?? []).join(', ')),
            type: "text",
            ...{ class: "input-box" },
            placeholder: "Leave empty for all guilds + DMs",
        });
    }
    if (__VLS_ctx.channelForm.fields.includes('verifyToken')) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
            ...{ class: "field-label" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
            value: (__VLS_ctx.channelForm.config.verifyToken),
            type: "text",
            ...{ class: "input-box" },
            placeholder: "Set same value in Meta Console",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
            ...{ class: "field-label" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "text-gray-500 font-normal" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
            type: "password",
            ...{ class: "input-box" },
            autocomplete: "off",
            placeholder: "Meta app secret",
        });
        (__VLS_ctx.channelForm.config.appSecret);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
            ...{ class: "field-label" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
            type: "password",
            ...{ class: "input-box" },
            autocomplete: "off",
            placeholder: "Permanent access token",
        });
        (__VLS_ctx.channelForm.config.accessToken);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
            ...{ class: "field-label" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
            value: (__VLS_ctx.channelForm.config.phoneNumberId),
            type: "text",
            ...{ class: "input-box" },
            placeholder: "Phone number ID from Meta Console",
        });
    }
    if (__VLS_ctx.channelForm.fields.includes('imapHost')) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "border-t border-purple-500/10 pt-2" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
            ...{ class: "text-xs text-gray-500 mb-3 uppercase tracking-wide" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
            ...{ class: "field-label" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
            value: (__VLS_ctx.channelForm.config.imapHost),
            type: "text",
            ...{ class: "input-box" },
            placeholder: "imap.gmail.com",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
            ...{ class: "field-label" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
            value: (__VLS_ctx.channelForm.config.imapUser),
            type: "text",
            ...{ class: "input-box" },
            placeholder: "you@example.com",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
            ...{ class: "field-label" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
            type: "password",
            ...{ class: "input-box" },
            autocomplete: "off",
            placeholder: "App password or $ENV_VAR",
        });
        (__VLS_ctx.channelForm.config.imapPassword);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "border-t border-purple-500/10 pt-2" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
            ...{ class: "text-xs text-gray-500 mb-3 uppercase tracking-wide" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
            ...{ class: "field-label" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
            value: (__VLS_ctx.channelForm.config.smtpHost),
            type: "text",
            ...{ class: "input-box" },
            placeholder: "smtp.gmail.com",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
            ...{ class: "field-label" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
            value: (__VLS_ctx.channelForm.config.smtpUser),
            type: "text",
            ...{ class: "input-box" },
            placeholder: "you@example.com",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
            ...{ class: "field-label" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
            type: "password",
            ...{ class: "input-box" },
            autocomplete: "off",
            placeholder: "App password or $ENV_VAR",
        });
        (__VLS_ctx.channelForm.config.smtpPassword);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
            ...{ class: "field-label" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
            value: (__VLS_ctx.channelForm.config.smtpFrom),
            type: "text",
            ...{ class: "input-box" },
            placeholder: "bot@example.com",
        });
    }
    if (__VLS_ctx.channelForm.fields.includes('account')) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
            ...{ class: "field-label" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "text-gray-500 font-normal" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
            value: (__VLS_ctx.channelForm.config.account),
            type: "text",
            ...{ class: "input-box" },
            placeholder: "+1234567890",
        });
    }
    if (__VLS_ctx.channelForm.error) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "px-5 pb-2 text-sm text-red-400" },
        });
        (__VLS_ctx.channelForm.error);
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "modal-footer" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (__VLS_ctx.closeChannelForm) },
        ...{ class: "btn-ghost px-4 py-2 rounded-xl text-sm" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (__VLS_ctx.submitChannelForm) },
        disabled: (__VLS_ctx.channelsStore.loading),
        ...{ class: "btn-grad px-5 py-2 rounded-xl text-sm" },
    });
    (__VLS_ctx.channelsStore.loading ? 'Saving…' : 'Save');
}
if (__VLS_ctx.sceneForm.open) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.sceneForm.open))
                    return;
                __VLS_ctx.sceneForm.open = false;
            } },
        ...{ class: "modal-backdrop" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "modal-box" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "modal-header" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({
        ...{ class: "font-semibold text-gray-100" },
    });
    (__VLS_ctx.sceneForm.editing ? 'Edit Scene' : 'Add Scene');
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.sceneForm.open))
                    return;
                __VLS_ctx.sceneForm.open = false;
            } },
        ...{ class: "modal-close" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "space-y-4 p-5" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "text-red-400" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "ml-1 text-gray-600 font-normal text-xs" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        value: (__VLS_ctx.sceneForm.name),
        type: "text",
        ...{ class: "input-box font-mono" },
        placeholder: "e.g. apply_jobs",
        disabled: (!!__VLS_ctx.sceneForm.editing),
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "text-red-400" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        value: (__VLS_ctx.sceneForm.description),
        type: "text",
        ...{ class: "input-box" },
        placeholder: "One-line description shown in the UI",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "text-red-400" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.textarea)({
        value: (__VLS_ctx.sceneForm.task),
        ...{ class: "input-box font-mono text-xs resize-none" },
        rows: "9",
        placeholder: "The full prompt sent to the orchestrator when this scene is triggered.",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "ml-1 text-gray-600 font-normal text-xs" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        value: (__VLS_ctx.sceneForm.webhookKey),
        type: "text",
        ...{ class: "input-box font-mono" },
        placeholder: "$MY_SCENE_KEY or a literal secret",
    });
    if (__VLS_ctx.sceneForm.error) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "px-5 pb-2 text-sm text-red-400" },
        });
        (__VLS_ctx.sceneForm.error);
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "modal-footer" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.sceneForm.open))
                    return;
                __VLS_ctx.sceneForm.open = false;
            } },
        ...{ class: "btn-ghost px-4 py-2 rounded-xl text-sm" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (__VLS_ctx.submitSceneForm) },
        disabled: (__VLS_ctx.scenesStore.loading),
        ...{ class: "btn-grad px-5 py-2 rounded-xl text-sm" },
    });
    (__VLS_ctx.scenesStore.loading ? 'Saving…' : 'Save');
}
/** @type {__VLS_StyleScopedClasses['settings-page']} */ ;
/** @type {__VLS_StyleScopedClasses['settings-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['space-y-5']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['p-5']} */ ;
/** @type {__VLS_StyleScopedClasses['section-title']} */ ;
/** @type {__VLS_StyleScopedClasses['space-y-4']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
/** @type {__VLS_StyleScopedClasses['pt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-grad']} */ ;
/** @type {__VLS_StyleScopedClasses['px-4']} */ ;
/** @type {__VLS_StyleScopedClasses['py-2']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-xl']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-ghost']} */ ;
/** @type {__VLS_StyleScopedClasses['px-4']} */ ;
/** @type {__VLS_StyleScopedClasses['py-2']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-xl']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['p-5']} */ ;
/** @type {__VLS_StyleScopedClasses['section-title']} */ ;
/** @type {__VLS_StyleScopedClasses['space-y-3']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-400']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
/** @type {__VLS_StyleScopedClasses['border-t']} */ ;
/** @type {__VLS_StyleScopedClasses['border-purple-500/10']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-400']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['bg-gray-800/60']} */ ;
/** @type {__VLS_StyleScopedClasses['px-2']} */ ;
/** @type {__VLS_StyleScopedClasses['py-1']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-lg']} */ ;
/** @type {__VLS_StyleScopedClasses['border-t']} */ ;
/** @type {__VLS_StyleScopedClasses['border-purple-500/10']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-400']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-red-400']} */ ;
/** @type {__VLS_StyleScopedClasses['space-y-1.5']} */ ;
/** @type {__VLS_StyleScopedClasses['pt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-start']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-3']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['min-w-0']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['text-red-400']} */ ;
/** @type {__VLS_StyleScopedClasses['truncate']} */ ;
/** @type {__VLS_StyleScopedClasses['border-t']} */ ;
/** @type {__VLS_StyleScopedClasses['border-purple-500/10']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-400']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-red-400']} */ ;
/** @type {__VLS_StyleScopedClasses['space-y-2']} */ ;
/** @type {__VLS_StyleScopedClasses['pt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['model-endpoint-row']} */ ;
/** @type {__VLS_StyleScopedClasses['min-w-0']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['truncate']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['truncate']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-red-400']} */ ;
/** @type {__VLS_StyleScopedClasses['truncate']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['shrink-0']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['p-5']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['mb-4']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-3']} */ ;
/** @type {__VLS_StyleScopedClasses['section-title']} */ ;
/** @type {__VLS_StyleScopedClasses['mb-0']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-ghost']} */ ;
/** @type {__VLS_StyleScopedClasses['px-3']} */ ;
/** @type {__VLS_StyleScopedClasses['py-1.5']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-lg']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-ghost']} */ ;
/** @type {__VLS_StyleScopedClasses['px-3']} */ ;
/** @type {__VLS_StyleScopedClasses['py-1.5']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-lg']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-state']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-state']} */ ;
/** @type {__VLS_StyleScopedClasses['space-y-4']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-xl']} */ ;
/** @type {__VLS_StyleScopedClasses['border']} */ ;
/** @type {__VLS_StyleScopedClasses['border-cyan-500/15']} */ ;
/** @type {__VLS_StyleScopedClasses['bg-cyan-500/5']} */ ;
/** @type {__VLS_StyleScopedClasses['px-3']} */ ;
/** @type {__VLS_StyleScopedClasses['py-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-cyan-100/80']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['text-cyan-200']} */ ;
/** @type {__VLS_StyleScopedClasses['multimodal-health-panel']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-3']} */ ;
/** @type {__VLS_StyleScopedClasses['flex-wrap']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['uppercase']} */ ;
/** @type {__VLS_StyleScopedClasses['tracking-[0.18em]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-ghost']} */ ;
/** @type {__VLS_StyleScopedClasses['px-3']} */ ;
/** @type {__VLS_StyleScopedClasses['py-1.5']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-lg']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-3']} */ ;
/** @type {__VLS_StyleScopedClasses['multimodal-health-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['multimodal-health-card']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['break-all']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-red-300']} */ ;
/** @type {__VLS_StyleScopedClasses['multimodal-health-card']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['break-all']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['break-all']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-red-300']} */ ;
/** @type {__VLS_StyleScopedClasses['multimodal-health-card']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['break-all']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-red-300']} */ ;
/** @type {__VLS_StyleScopedClasses['multimodal-health-card']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['break-all']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-red-300']} */ ;
/** @type {__VLS_StyleScopedClasses['multimodal-health-card']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['break-all']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-red-300']} */ ;
/** @type {__VLS_StyleScopedClasses['multimodal-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['border-t']} */ ;
/** @type {__VLS_StyleScopedClasses['border-purple-500/10']} */ ;
/** @type {__VLS_StyleScopedClasses['pt-3']} */ ;
/** @type {__VLS_StyleScopedClasses['space-y-3']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['uppercase']} */ ;
/** @type {__VLS_StyleScopedClasses['tracking-[0.18em]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['multimodal-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['md:col-span-2']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['md:col-span-2']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['font-normal']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['md:col-span-2']} */ ;
/** @type {__VLS_StyleScopedClasses['border-t']} */ ;
/** @type {__VLS_StyleScopedClasses['border-purple-500/10']} */ ;
/** @type {__VLS_StyleScopedClasses['pt-3']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['uppercase']} */ ;
/** @type {__VLS_StyleScopedClasses['tracking-[0.18em]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['mb-3']} */ ;
/** @type {__VLS_StyleScopedClasses['multimodal-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['md:col-span-2']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['font-normal']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['md:col-span-2']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['font-normal']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['md:col-span-2']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['font-normal']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['border-t']} */ ;
/** @type {__VLS_StyleScopedClasses['border-purple-500/10']} */ ;
/** @type {__VLS_StyleScopedClasses['pt-3']} */ ;
/** @type {__VLS_StyleScopedClasses['space-y-3']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['uppercase']} */ ;
/** @type {__VLS_StyleScopedClasses['tracking-[0.18em]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['multimodal-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['md:col-span-2']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['md:col-span-2']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['font-normal']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['border-t']} */ ;
/** @type {__VLS_StyleScopedClasses['border-purple-500/10']} */ ;
/** @type {__VLS_StyleScopedClasses['pt-3']} */ ;
/** @type {__VLS_StyleScopedClasses['space-y-3']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['uppercase']} */ ;
/** @type {__VLS_StyleScopedClasses['tracking-[0.18em]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['multimodal-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['md:col-span-2']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['font-normal']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['font-normal']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['font-normal']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['md:col-span-2']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['font-normal']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['md:col-span-2']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['font-normal']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['resize-none']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-xl']} */ ;
/** @type {__VLS_StyleScopedClasses['border']} */ ;
/** @type {__VLS_StyleScopedClasses['border-purple-500/10']} */ ;
/** @type {__VLS_StyleScopedClasses['bg-gray-950/40']} */ ;
/** @type {__VLS_StyleScopedClasses['p-3']} */ ;
/** @type {__VLS_StyleScopedClasses['space-y-3']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['uppercase']} */ ;
/** @type {__VLS_StyleScopedClasses['tracking-[0.18em]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['multimodal-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['md:col-span-2']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-end']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-ghost']} */ ;
/** @type {__VLS_StyleScopedClasses['px-4']} */ ;
/** @type {__VLS_StyleScopedClasses['py-2']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-xl']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['border-t']} */ ;
/** @type {__VLS_StyleScopedClasses['border-purple-500/10']} */ ;
/** @type {__VLS_StyleScopedClasses['pt-3']} */ ;
/** @type {__VLS_StyleScopedClasses['space-y-3']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['uppercase']} */ ;
/** @type {__VLS_StyleScopedClasses['tracking-[0.18em]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['multimodal-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['md:col-span-2']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['font-normal']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['font-normal']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['md:col-span-2']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['font-normal']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['md:col-span-2']} */ ;
/** @type {__VLS_StyleScopedClasses['space-y-2']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['font-normal']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['resize-none']} */ ;
/** @type {__VLS_StyleScopedClasses['w-full']} */ ;
/** @type {__VLS_StyleScopedClasses['space-y-1.5']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['flex-wrap']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-1.5']} */ ;
/** @type {__VLS_StyleScopedClasses['px-2.5']} */ ;
/** @type {__VLS_StyleScopedClasses['py-1']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-lg']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['border']} */ ;
/** @type {__VLS_StyleScopedClasses['border-purple-500/20']} */ ;
/** @type {__VLS_StyleScopedClasses['bg-purple-900/20']} */ ;
/** @type {__VLS_StyleScopedClasses['text-purple-200']} */ ;
/** @type {__VLS_StyleScopedClasses['hover:bg-purple-700/30']} */ ;
/** @type {__VLS_StyleScopedClasses['hover:border-purple-400/40']} */ ;
/** @type {__VLS_StyleScopedClasses['transition-colors']} */ ;
/** @type {__VLS_StyleScopedClasses['px-2.5']} */ ;
/** @type {__VLS_StyleScopedClasses['py-1']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-lg']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['border']} */ ;
/** @type {__VLS_StyleScopedClasses['border-red-500/20']} */ ;
/** @type {__VLS_StyleScopedClasses['bg-red-900/10']} */ ;
/** @type {__VLS_StyleScopedClasses['text-red-300']} */ ;
/** @type {__VLS_StyleScopedClasses['hover:bg-red-800/20']} */ ;
/** @type {__VLS_StyleScopedClasses['transition-colors']} */ ;
/** @type {__VLS_StyleScopedClasses['border-t']} */ ;
/** @type {__VLS_StyleScopedClasses['border-purple-500/10']} */ ;
/** @type {__VLS_StyleScopedClasses['pt-3']} */ ;
/** @type {__VLS_StyleScopedClasses['space-y-3']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-4']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['uppercase']} */ ;
/** @type {__VLS_StyleScopedClasses['tracking-[0.18em]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['multimodal-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['font-normal']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['md:col-span-2']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['font-normal']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['text-red-400']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-end']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-grad']} */ ;
/** @type {__VLS_StyleScopedClasses['px-5']} */ ;
/** @type {__VLS_StyleScopedClasses['py-2']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-xl']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['p-5']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['mb-4']} */ ;
/** @type {__VLS_StyleScopedClasses['section-title']} */ ;
/** @type {__VLS_StyleScopedClasses['mb-0']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['hover:text-purple-400']} */ ;
/** @type {__VLS_StyleScopedClasses['transition-colors']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-ghost']} */ ;
/** @type {__VLS_StyleScopedClasses['px-3']} */ ;
/** @type {__VLS_StyleScopedClasses['py-1.5']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-lg']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-state']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-state']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['text-red-400']} */ ;
/** @type {__VLS_StyleScopedClasses['space-y-4']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-start']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-4']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-200']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-0.5']} */ ;
/** @type {__VLS_StyleScopedClasses['border-t']} */ ;
/** @type {__VLS_StyleScopedClasses['border-purple-500/10']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-start']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-4']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-200']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-0.5']} */ ;
/** @type {__VLS_StyleScopedClasses['border-t']} */ ;
/** @type {__VLS_StyleScopedClasses['border-purple-500/10']} */ ;
/** @type {__VLS_StyleScopedClasses['space-y-2']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-200']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-0.5']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['text-purple-300']} */ ;
/** @type {__VLS_StyleScopedClasses['tabular-nums']} */ ;
/** @type {__VLS_StyleScopedClasses['w-full']} */ ;
/** @type {__VLS_StyleScopedClasses['accent-purple-500']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['border-t']} */ ;
/** @type {__VLS_StyleScopedClasses['border-purple-500/10']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-start']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-4']} */ ;
/** @type {__VLS_StyleScopedClasses['opacity-50']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-200']} */ ;
/** @type {__VLS_StyleScopedClasses['ml-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-amber-500']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-0.5']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-state']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['p-5']} */ ;
/** @type {__VLS_StyleScopedClasses['section-title']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['space-y-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-2']} */ ;
/** @type {__VLS_StyleScopedClasses['space-y-5']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['p-5']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['mb-4']} */ ;
/** @type {__VLS_StyleScopedClasses['section-title']} */ ;
/** @type {__VLS_StyleScopedClasses['mb-0']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-ghost']} */ ;
/** @type {__VLS_StyleScopedClasses['px-3']} */ ;
/** @type {__VLS_StyleScopedClasses['py-1.5']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-lg']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-grad']} */ ;
/** @type {__VLS_StyleScopedClasses['px-3']} */ ;
/** @type {__VLS_StyleScopedClasses['py-1.5']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-lg']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-state']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-state']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['text-red-400']} */ ;
/** @type {__VLS_StyleScopedClasses['space-y-2']} */ ;
/** @type {__VLS_StyleScopedClasses['site-row']} */ ;
/** @type {__VLS_StyleScopedClasses['min-w-0']} */ ;
/** @type {__VLS_StyleScopedClasses['flex-1']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
/** @type {__VLS_StyleScopedClasses['flex-wrap']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-100']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-0.5']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['truncate']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-0.5']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['flex-wrap']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-1']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-1.5']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['bg-purple-900/30']} */ ;
/** @type {__VLS_StyleScopedClasses['text-purple-300']} */ ;
/** @type {__VLS_StyleScopedClasses['border']} */ ;
/** @type {__VLS_StyleScopedClasses['border-purple-700/30']} */ ;
/** @type {__VLS_StyleScopedClasses['px-1.5']} */ ;
/** @type {__VLS_StyleScopedClasses['py-0.5']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-full']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['italic']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-0.5']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-1']} */ ;
/** @type {__VLS_StyleScopedClasses['shrink-0']} */ ;
/** @type {__VLS_StyleScopedClasses['icon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['icon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['opacity-40']} */ ;
/** @type {__VLS_StyleScopedClasses['cursor-not-allowed']} */ ;
/** @type {__VLS_StyleScopedClasses['icon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['icon-btn--danger']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-state']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['p-5']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['mb-4']} */ ;
/** @type {__VLS_StyleScopedClasses['section-title']} */ ;
/** @type {__VLS_StyleScopedClasses['mb-0']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-ghost']} */ ;
/** @type {__VLS_StyleScopedClasses['px-3']} */ ;
/** @type {__VLS_StyleScopedClasses['py-1.5']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-lg']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-grad']} */ ;
/** @type {__VLS_StyleScopedClasses['px-3']} */ ;
/** @type {__VLS_StyleScopedClasses['py-1.5']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-lg']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-state']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-state']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['text-red-400']} */ ;
/** @type {__VLS_StyleScopedClasses['space-y-2']} */ ;
/** @type {__VLS_StyleScopedClasses['scene-row']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-start']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-3']} */ ;
/** @type {__VLS_StyleScopedClasses['min-w-0']} */ ;
/** @type {__VLS_StyleScopedClasses['flex-1']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
/** @type {__VLS_StyleScopedClasses['flex-wrap']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-100']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-400']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-0.5']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-1']} */ ;
/** @type {__VLS_StyleScopedClasses['shrink-0']} */ ;
/** @type {__VLS_StyleScopedClasses['icon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['icon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['opacity-40']} */ ;
/** @type {__VLS_StyleScopedClasses['cursor-not-allowed']} */ ;
/** @type {__VLS_StyleScopedClasses['icon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['icon-btn--danger']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['cursor-pointer']} */ ;
/** @type {__VLS_StyleScopedClasses['hover:text-purple-400']} */ ;
/** @type {__VLS_StyleScopedClasses['transition-colors']} */ ;
/** @type {__VLS_StyleScopedClasses['select-none']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-1.5']} */ ;
/** @type {__VLS_StyleScopedClasses['whitespace-pre-wrap']} */ ;
/** @type {__VLS_StyleScopedClasses['break-words']} */ ;
/** @type {__VLS_StyleScopedClasses['bg-gray-950/60']} */ ;
/** @type {__VLS_StyleScopedClasses['border']} */ ;
/** @type {__VLS_StyleScopedClasses['border-purple-500/10']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-lg']} */ ;
/** @type {__VLS_StyleScopedClasses['p-2.5']} */ ;
/** @type {__VLS_StyleScopedClasses['max-h-40']} */ ;
/** @type {__VLS_StyleScopedClasses['overflow-y-auto']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-state']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['p-5']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['mb-4']} */ ;
/** @type {__VLS_StyleScopedClasses['section-title']} */ ;
/** @type {__VLS_StyleScopedClasses['mb-0']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-ghost']} */ ;
/** @type {__VLS_StyleScopedClasses['px-3']} */ ;
/** @type {__VLS_StyleScopedClasses['py-1.5']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-lg']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-state']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-state']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['text-red-400']} */ ;
/** @type {__VLS_StyleScopedClasses['space-y-4']} */ ;
/** @type {__VLS_StyleScopedClasses['routing-lab']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-start']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-3']} */ ;
/** @type {__VLS_StyleScopedClasses['flex-wrap']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-200']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-0.5']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['routing-lab-controls']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-3']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-grad']} */ ;
/** @type {__VLS_StyleScopedClasses['px-3']} */ ;
/** @type {__VLS_StyleScopedClasses['py-2']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-xl']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-ghost']} */ ;
/** @type {__VLS_StyleScopedClasses['px-3']} */ ;
/** @type {__VLS_StyleScopedClasses['py-2']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-xl']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-red-400']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-3']} */ ;
/** @type {__VLS_StyleScopedClasses['space-y-3']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-3']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-state']} */ ;
/** @type {__VLS_StyleScopedClasses['!py-4']} */ ;
/** @type {__VLS_StyleScopedClasses['space-y-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['uppercase']} */ ;
/** @type {__VLS_StyleScopedClasses['tracking-[0.18em]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['routing-result-card']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-start']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-3']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-100']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-0.5']} */ ;
/** @type {__VLS_StyleScopedClasses['text-right']} */ ;
/** @type {__VLS_StyleScopedClasses['shrink-0']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['routing-meta-row']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-2']} */ ;
/** @type {__VLS_StyleScopedClasses['routing-chip-row']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-2']} */ ;
/** @type {__VLS_StyleScopedClasses['routing-chip']} */ ;
/** @type {__VLS_StyleScopedClasses['space-y-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['uppercase']} */ ;
/** @type {__VLS_StyleScopedClasses['tracking-[0.18em]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['routing-result-card']} */ ;
/** @type {__VLS_StyleScopedClasses['routing-result-card--weak']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-start']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-3']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-100']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-0.5']} */ ;
/** @type {__VLS_StyleScopedClasses['routing-meta-row']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-2']} */ ;
/** @type {__VLS_StyleScopedClasses['agent-row']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['cursor-pointer']} */ ;
/** @type {__VLS_StyleScopedClasses['select-none']} */ ;
/** @type {__VLS_StyleScopedClasses['py-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-100']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['ml-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-3']} */ ;
/** @type {__VLS_StyleScopedClasses['space-y-3']} */ ;
/** @type {__VLS_StyleScopedClasses['pl-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['italic']} */ ;
/** @type {__VLS_StyleScopedClasses['mb-2']} */ ;
/** @type {__VLS_StyleScopedClasses['space-y-2']} */ ;
/** @type {__VLS_StyleScopedClasses['routing-chip-row']} */ ;
/** @type {__VLS_StyleScopedClasses['routing-chip']} */ ;
/** @type {__VLS_StyleScopedClasses['routing-meta-row']} */ ;
/** @type {__VLS_StyleScopedClasses['grid']} */ ;
/** @type {__VLS_StyleScopedClasses['grid-cols-2']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-3']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['md:col-span-2']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['font-normal']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['md:col-span-2']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['font-normal']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['md:col-span-2']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-4']} */ ;
/** @type {__VLS_StyleScopedClasses['pt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['font-normal']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-0.5']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-400']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-400']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['w-24']} */ ;
/** @type {__VLS_StyleScopedClasses['shrink-0']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-state']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['p-5']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['mb-4']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-3']} */ ;
/** @type {__VLS_StyleScopedClasses['section-title']} */ ;
/** @type {__VLS_StyleScopedClasses['mb-0']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-ghost']} */ ;
/** @type {__VLS_StyleScopedClasses['px-3']} */ ;
/** @type {__VLS_StyleScopedClasses['py-1.5']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-lg']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-ghost']} */ ;
/** @type {__VLS_StyleScopedClasses['px-3']} */ ;
/** @type {__VLS_StyleScopedClasses['py-1.5']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-lg']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-state']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-state']} */ ;
/** @type {__VLS_StyleScopedClasses['space-y-4']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-xl']} */ ;
/** @type {__VLS_StyleScopedClasses['border']} */ ;
/** @type {__VLS_StyleScopedClasses['border-cyan-500/15']} */ ;
/** @type {__VLS_StyleScopedClasses['bg-cyan-500/5']} */ ;
/** @type {__VLS_StyleScopedClasses['px-3']} */ ;
/** @type {__VLS_StyleScopedClasses['py-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-cyan-100/80']} */ ;
/** @type {__VLS_StyleScopedClasses['border-t']} */ ;
/** @type {__VLS_StyleScopedClasses['border-purple-500/10']} */ ;
/** @type {__VLS_StyleScopedClasses['pt-3']} */ ;
/** @type {__VLS_StyleScopedClasses['space-y-3']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-3']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['uppercase']} */ ;
/** @type {__VLS_StyleScopedClasses['tracking-[0.18em]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['multimodal-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['md:col-span-2']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['md:col-span-2']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['font-normal']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['md:col-span-2']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['font-normal']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-red-300']} */ ;
/** @type {__VLS_StyleScopedClasses['border-t']} */ ;
/** @type {__VLS_StyleScopedClasses['border-purple-500/10']} */ ;
/** @type {__VLS_StyleScopedClasses['pt-3']} */ ;
/** @type {__VLS_StyleScopedClasses['space-y-3']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-3']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['uppercase']} */ ;
/** @type {__VLS_StyleScopedClasses['tracking-[0.18em]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['multimodal-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['md:col-span-2']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['font-normal']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['md:col-span-2']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['font-normal']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['md:col-span-2']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['font-normal']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-red-300']} */ ;
/** @type {__VLS_StyleScopedClasses['border-t']} */ ;
/** @type {__VLS_StyleScopedClasses['border-purple-500/10']} */ ;
/** @type {__VLS_StyleScopedClasses['pt-3']} */ ;
/** @type {__VLS_StyleScopedClasses['space-y-3']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-4']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['uppercase']} */ ;
/** @type {__VLS_StyleScopedClasses['tracking-[0.18em]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
/** @type {__VLS_StyleScopedClasses['multimodal-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['md:col-span-2']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['md:col-span-2']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['md:col-span-2']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-red-300']} */ ;
/** @type {__VLS_StyleScopedClasses['border-t']} */ ;
/** @type {__VLS_StyleScopedClasses['border-purple-500/10']} */ ;
/** @type {__VLS_StyleScopedClasses['pt-3']} */ ;
/** @type {__VLS_StyleScopedClasses['space-y-3']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-4']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['uppercase']} */ ;
/** @type {__VLS_StyleScopedClasses['tracking-[0.18em]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
/** @type {__VLS_StyleScopedClasses['multimodal-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['md:col-span-2']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['md:col-span-2']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['md:col-span-2']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-red-300']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['text-red-400']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-end']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-grad']} */ ;
/** @type {__VLS_StyleScopedClasses['px-5']} */ ;
/** @type {__VLS_StyleScopedClasses['py-2']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-xl']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['p-5']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['mb-4']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-3']} */ ;
/** @type {__VLS_StyleScopedClasses['section-title']} */ ;
/** @type {__VLS_StyleScopedClasses['mb-0']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['px-2']} */ ;
/** @type {__VLS_StyleScopedClasses['py-0.5']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-full']} */ ;
/** @type {__VLS_StyleScopedClasses['bg-red-900/60']} */ ;
/** @type {__VLS_StyleScopedClasses['text-red-300']} */ ;
/** @type {__VLS_StyleScopedClasses['font-medium']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-ghost']} */ ;
/** @type {__VLS_StyleScopedClasses['px-3']} */ ;
/** @type {__VLS_StyleScopedClasses['py-1.5']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-lg']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-state']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-state']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['text-red-400']} */ ;
/** @type {__VLS_StyleScopedClasses['space-y-2']} */ ;
/** @type {__VLS_StyleScopedClasses['channel-incident-panel']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-3']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-200']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-0.5']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-red-300']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-3']} */ ;
/** @type {__VLS_StyleScopedClasses['space-y-2']} */ ;
/** @type {__VLS_StyleScopedClasses['channel-incident-row']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-3']} */ ;
/** @type {__VLS_StyleScopedClasses['badge-health-bad']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-2']} */ ;
/** @type {__VLS_StyleScopedClasses['break-words']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['channel-row']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-3']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-3']} */ ;
/** @type {__VLS_StyleScopedClasses['min-w-0']} */ ;
/** @type {__VLS_StyleScopedClasses['flex-1']} */ ;
/** @type {__VLS_StyleScopedClasses['shrink-0']} */ ;
/** @type {__VLS_StyleScopedClasses['min-w-0']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
/** @type {__VLS_StyleScopedClasses['flex-wrap']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['font-medium']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-100']} */ ;
/** @type {__VLS_StyleScopedClasses['badge-planned']} */ ;
/** @type {__VLS_StyleScopedClasses['badge-running']} */ ;
/** @type {__VLS_StyleScopedClasses['badge-config']} */ ;
/** @type {__VLS_StyleScopedClasses['badge-off']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-red-400']} */ ;
/** @type {__VLS_StyleScopedClasses['truncate']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-0.5']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-2']} */ ;
/** @type {__VLS_StyleScopedClasses['channel-metrics-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['space-y-0.5']} */ ;
/** @type {__VLS_StyleScopedClasses['truncate']} */ ;
/** @type {__VLS_StyleScopedClasses['truncate']} */ ;
/** @type {__VLS_StyleScopedClasses['icon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['shrink-0']} */ ;
/** @type {__VLS_StyleScopedClasses['modal-backdrop']} */ ;
/** @type {__VLS_StyleScopedClasses['modal-box']} */ ;
/** @type {__VLS_StyleScopedClasses['modal-header']} */ ;
/** @type {__VLS_StyleScopedClasses['font-semibold']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-100']} */ ;
/** @type {__VLS_StyleScopedClasses['modal-close']} */ ;
/** @type {__VLS_StyleScopedClasses['space-y-4']} */ ;
/** @type {__VLS_StyleScopedClasses['p-5']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['text-red-400']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['text-red-400']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['text-red-400']} */ ;
/** @type {__VLS_StyleScopedClasses['ml-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['font-normal']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['mb-2']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['mb-0']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-purple-400']} */ ;
/** @type {__VLS_StyleScopedClasses['hover:text-purple-300']} */ ;
/** @type {__VLS_StyleScopedClasses['transition-colors']} */ ;
/** @type {__VLS_StyleScopedClasses['space-y-2']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['w-28']} */ ;
/** @type {__VLS_StyleScopedClasses['shrink-0']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['flex-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['hover:text-red-400']} */ ;
/** @type {__VLS_StyleScopedClasses['transition-colors']} */ ;
/** @type {__VLS_StyleScopedClasses['px-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-lg']} */ ;
/** @type {__VLS_StyleScopedClasses['leading-none']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['cursor-pointer']} */ ;
/** @type {__VLS_StyleScopedClasses['hover:text-purple-400']} */ ;
/** @type {__VLS_StyleScopedClasses['transition-colors']} */ ;
/** @type {__VLS_StyleScopedClasses['select-none']} */ ;
/** @type {__VLS_StyleScopedClasses['space-y-2']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-2']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['px-5']} */ ;
/** @type {__VLS_StyleScopedClasses['pb-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['text-red-400']} */ ;
/** @type {__VLS_StyleScopedClasses['modal-footer']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-ghost']} */ ;
/** @type {__VLS_StyleScopedClasses['px-4']} */ ;
/** @type {__VLS_StyleScopedClasses['py-2']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-xl']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-grad']} */ ;
/** @type {__VLS_StyleScopedClasses['px-5']} */ ;
/** @type {__VLS_StyleScopedClasses['py-2']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-xl']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['modal-backdrop']} */ ;
/** @type {__VLS_StyleScopedClasses['modal-box']} */ ;
/** @type {__VLS_StyleScopedClasses['modal-header']} */ ;
/** @type {__VLS_StyleScopedClasses['font-semibold']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-100']} */ ;
/** @type {__VLS_StyleScopedClasses['modal-close']} */ ;
/** @type {__VLS_StyleScopedClasses['space-y-4']} */ ;
/** @type {__VLS_StyleScopedClasses['p-5']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-xl']} */ ;
/** @type {__VLS_StyleScopedClasses['border']} */ ;
/** @type {__VLS_StyleScopedClasses['border-amber-500/20']} */ ;
/** @type {__VLS_StyleScopedClasses['bg-amber-500/10']} */ ;
/** @type {__VLS_StyleScopedClasses['px-3']} */ ;
/** @type {__VLS_StyleScopedClasses['py-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['text-amber-200']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-xl']} */ ;
/** @type {__VLS_StyleScopedClasses['border']} */ ;
/** @type {__VLS_StyleScopedClasses['border-purple-500/10']} */ ;
/** @type {__VLS_StyleScopedClasses['bg-gray-950/50']} */ ;
/** @type {__VLS_StyleScopedClasses['px-3']} */ ;
/** @type {__VLS_StyleScopedClasses['py-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['channel-detail-panel']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-3']} */ ;
/** @type {__VLS_StyleScopedClasses['flex-wrap']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-200']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['channel-detail-metrics']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-3']} */ ;
/** @type {__VLS_StyleScopedClasses['channel-detail-stat']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['channel-detail-stat']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['channel-detail-stat']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-100']} */ ;
/** @type {__VLS_StyleScopedClasses['channel-detail-stat']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-100']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-3']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['uppercase']} */ ;
/** @type {__VLS_StyleScopedClasses['tracking-[0.18em]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-2']} */ ;
/** @type {__VLS_StyleScopedClasses['space-y-2']} */ ;
/** @type {__VLS_StyleScopedClasses['channel-incident-row']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-3']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-red-300']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-3']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['uppercase']} */ ;
/** @type {__VLS_StyleScopedClasses['tracking-[0.18em]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-2']} */ ;
/** @type {__VLS_StyleScopedClasses['space-y-1.5']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-400']} */ ;
/** @type {__VLS_StyleScopedClasses['list-disc']} */ ;
/** @type {__VLS_StyleScopedClasses['pl-4']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-4']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-200']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-0.5']} */ ;
/** @type {__VLS_StyleScopedClasses['border-t']} */ ;
/** @type {__VLS_StyleScopedClasses['border-purple-500/10']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['grid']} */ ;
/** @type {__VLS_StyleScopedClasses['grid-cols-1']} */ ;
/** @type {__VLS_StyleScopedClasses['md:grid-cols-2']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-3']} */ ;
/** @type {__VLS_StyleScopedClasses['border-t']} */ ;
/** @type {__VLS_StyleScopedClasses['border-purple-500/10']} */ ;
/** @type {__VLS_StyleScopedClasses['pt-3']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['md:col-span-2']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['font-normal']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['font-normal']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['font-normal']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['font-normal']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['font-normal']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['border-t']} */ ;
/** @type {__VLS_StyleScopedClasses['border-purple-500/10']} */ ;
/** @type {__VLS_StyleScopedClasses['pt-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['mb-3']} */ ;
/** @type {__VLS_StyleScopedClasses['uppercase']} */ ;
/** @type {__VLS_StyleScopedClasses['tracking-wide']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['border-t']} */ ;
/** @type {__VLS_StyleScopedClasses['border-purple-500/10']} */ ;
/** @type {__VLS_StyleScopedClasses['pt-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['mb-3']} */ ;
/** @type {__VLS_StyleScopedClasses['uppercase']} */ ;
/** @type {__VLS_StyleScopedClasses['tracking-wide']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['font-normal']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['px-5']} */ ;
/** @type {__VLS_StyleScopedClasses['pb-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['text-red-400']} */ ;
/** @type {__VLS_StyleScopedClasses['modal-footer']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-ghost']} */ ;
/** @type {__VLS_StyleScopedClasses['px-4']} */ ;
/** @type {__VLS_StyleScopedClasses['py-2']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-xl']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-grad']} */ ;
/** @type {__VLS_StyleScopedClasses['px-5']} */ ;
/** @type {__VLS_StyleScopedClasses['py-2']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-xl']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['modal-backdrop']} */ ;
/** @type {__VLS_StyleScopedClasses['modal-box']} */ ;
/** @type {__VLS_StyleScopedClasses['modal-header']} */ ;
/** @type {__VLS_StyleScopedClasses['font-semibold']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-100']} */ ;
/** @type {__VLS_StyleScopedClasses['modal-close']} */ ;
/** @type {__VLS_StyleScopedClasses['space-y-4']} */ ;
/** @type {__VLS_StyleScopedClasses['p-5']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['text-red-400']} */ ;
/** @type {__VLS_StyleScopedClasses['ml-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['font-normal']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['text-red-400']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['text-red-400']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['resize-none']} */ ;
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
/** @type {__VLS_StyleScopedClasses['ml-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['font-normal']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['input-box']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['px-5']} */ ;
/** @type {__VLS_StyleScopedClasses['pb-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['text-red-400']} */ ;
/** @type {__VLS_StyleScopedClasses['modal-footer']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-ghost']} */ ;
/** @type {__VLS_StyleScopedClasses['px-4']} */ ;
/** @type {__VLS_StyleScopedClasses['py-2']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-xl']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-grad']} */ ;
/** @type {__VLS_StyleScopedClasses['px-5']} */ ;
/** @type {__VLS_StyleScopedClasses['py-2']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-xl']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            ToggleSwitch: ToggleSwitch,
            ChannelIcon: ChannelIcon,
            gateway: gateway,
            guardrails: guardrails,
            sites: sites,
            scenesStore: scenesStore,
            channelsStore: channelsStore,
            runtime: runtime,
            agentsStore: agentsStore,
            multimodalStore: multimodalStore,
            routingLab: routingLab,
            multimodalLoaded: multimodalLoaded,
            IMAGE_GEN_NEGATIVE_PRESETS: IMAGE_GEN_NEGATIVE_PRESETS,
            multimodalForm: multimodalForm,
            savedVoiceForm: savedVoiceForm,
            modelEndpointForm: modelEndpointForm,
            resetModelEndpointConfig: resetModelEndpointConfig,
            getModelEndpointStatus: getModelEndpointStatus,
            fetchModelEndpointConfig: fetchModelEndpointConfig,
            submitModelEndpointConfig: submitModelEndpointConfig,
            applyNegativePreset: applyNegativePreset,
            resetMultimodalForm: resetMultimodalForm,
            onSavedVoiceFileSelected: onSavedVoiceFileSelected,
            saveVoiceSampleToLibrary: saveVoiceSampleToLibrary,
            submitMultimodalForm: submitMultimodalForm,
            siteForm: siteForm,
            openSiteForm: openSiteForm,
            addUrlEntry: addUrlEntry,
            submitSiteForm: submitSiteForm,
            confirmDeleteSite: confirmDeleteSite,
            sceneForm: sceneForm,
            openSceneForm: openSceneForm,
            submitSceneForm: submitSceneForm,
            confirmDeleteScene: confirmDeleteScene,
            CHANNEL_DEFS: CHANNEL_DEFS,
            channelForm: channelForm,
            channelRuntimeSupport: channelRuntimeSupport,
            getChannelStatus: getChannelStatus,
            operatorStateBadgeClass: operatorStateBadgeClass,
            operatorStateTextClass: operatorStateTextClass,
            windowSuccessRateClass: windowSuccessRateClass,
            formatPercent: formatPercent,
            formatTimestamp: formatTimestamp,
            formatHealthTitle: formatHealthTitle,
            openChannelForm: openChannelForm,
            submitChannelForm: submitChannelForm,
            closeChannelForm: closeChannelForm,
            formatRuntimeName: formatRuntimeName,
            formatModelEndpointRole: formatModelEndpointRole,
            runRoutingLab: runRoutingLab,
            clearRoutingLab: clearRoutingLab,
        };
    },
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
});
; /* PartiallyEnd: #4569/main.vue */
