/**
 * The multimodal settings as the Settings page saves them.
 *
 * The page edits a few fields of each section. The server used to REPLACE a whole section with
 * what it was sent, so a save that sent only the page's fields erased every key the page does not
 * show — the quality engine, the engines' names, the edit-capable models — and one Save click
 * turned off editing and the quality tier. The server now MERGES what it is sent over what it has
 * stored, so the page sends only what the user changed (`buildMultimodalPatch`):
 *   - a field left as loaded is not sent at all. That matters beyond size: the config loader fills
 *     some values at read time (the image endpoint follows the chat endpoint when left empty), and
 *     sending them back would store them literally and cut that link. Secrets come back masked
 *     ("••••••••"), and an untouched mask is simply not sent.
 *   - a field the user cleared is sent as `null`, which is how the merge removes a key.
 *   - an untouched key whose endpoint changed is not saved at all: the gateway refuses to send a
 *     saved key to a new endpoint, so the page asks for the key again first (`keysNeedingReentry`).
 *   - an empty vision key beside a moved vision endpoint is saved as "" (no key), not left unset:
 *     unset hands the endpoint the provider's key, which the gateway refuses too (`keyAsSaved`).
 *     With the vision endpoint cleared, a key saved as "" goes back to unset (`null`).
 *
 * Deliberately free of Vue and of the store, so it can be exercised on its own.
 */
import type { MultimodalConfig, MultimodalImageGenerationConfig } from "../stores/multimodal";

/** The page's form: the fields it shows, as edited. */
export interface MultimodalFormValues {
  maxUploadBytes: number;
  filesBaseUrl: string;
  filesApiKey: string;
  filesTimeoutMs: number;
  fileToolName: string;
  visionModel: string;
  visionBaseUrl: string;
  visionApiKey: string;
  sttBaseUrl: string;
  sttApi: MultimodalConfig["stt"]["api"];
  sttApiKey: string;
  sttTimeoutMs: number;
  sttModel: string;
  ttsBaseUrl: string;
  ttsApi: MultimodalConfig["tts"]["api"];
  ttsApiKey: string;
  ttsTimeoutMs: number;
  ttsModel: string;
  ttsDefaultLanguage: string;
  ttsDefaultSpeaker: string;
  ttsDefaultVoiceId: string;
  ttsVoiceSamplePath: string;
  ttsVoiceSampleText: string;
  ttsDefaultQuality: string;
  imageGenBaseUrl: string;
  imageGenApi: MultimodalImageGenerationConfig["api"];
  imageGenApiKey: string;
  imageGenTimeoutMs: number;
  imageGenModel: string;
  imageGenDefaultWidth: number;
  imageGenDefaultHeight: number;
  imageGenDefaultSteps: number;
  imageGenGuidanceScale: number;
  imageGenDefaultNegativePrompt: string;
  wakeEnabled: boolean;
  wakeLanguage: MultimodalConfig["wakeWord"]["language"];
  wakeSilenceTimeoutMs: number;
}

/** A section as saved: the stored one, with the page's fields laid over it. */
function overStored<T extends object>(stored: T | undefined, fields: T): T {
  return { ...(stored ?? {}), ...fields } as T;
}

function optional(value: string): string | undefined {
  return value.trim() || undefined;
}

/**
 * A key field as saved when its key, left unset, falls back to another: the vision key and the
 * orchestrator and embeddings keys to their provider's key, a sub-agent's to the default key.
 *
 * The gateway will not send that stand-in to an endpoint it was not already going to, so an EMPTY
 * field beside an endpoint of its own is saved as "" — no key — when that endpoint moved, when a
 * saved key was cleared, or when the gateway refused the last save over this key (`refused`: a new
 * model can mean another provider's key). Otherwise an empty field stays unset and the stand-in
 * keeps going where it went; with no endpoint of its own it goes to the provider, which is what
 * clearing means there — a key saved as "" included, once its endpoint is cleared (checked the
 * other way round, that "" stuck, and the provider was sent no key). Beside an endpoint, a key
 * already saved as "" stays "".
 */
export function keyAsSaved(
  field: string,
  endpoint: string,
  stored: { key?: string; endpoint?: string },
  refused = false,
): string | undefined {
  const typed = field.trim();
  if (typed) return typed;
  const at = endpoint.trim();
  if (!at) return undefined;
  if (stored.key === "") return "";
  const moved = at !== (stored.endpoint ?? "").trim();
  return moved || stored.key !== undefined || refused ? "" : undefined;
}

/**
 * The model-endpoints page's two chat keys as saved (see keyAsSaved). The embeddings' key is judged
 * beside their OWN endpoint: with none, they borrow the orchestrator's key, which its own field
 * decides. Judged beside the orchestrator's endpoint, a moved orchestrator saved "" here and the
 * embeddings lost the key typed for it.
 *
 * With no endpoint of their own, an empty field is saved as "" when the gateway refused the last
 * save over the embeddings key — what they borrow is refused where they send it — whatever the
 * endpoint: judged beside an endpoint, with none set anywhere the retry sent the same body and was
 * refused for good. And a "" saved while they borrow stays "": dropped on the next save, the
 * borrowed key came back and every later save was refused once (r3 A-security #2, #3). Clearing an
 * endpoint of their own sends a saved "" back to the borrowed key, as for the vision key.
 *
 * Until the embeddings model changes: where the borrowed key goes follows the model, so a new model
 * is when borrowing may work again, and the save tries it (unset); refused, the retry saves "" as
 * above. Kept "" for good, a model moved back to the orchestrator's provider was sent no key at a
 * keyed endpoint and fell back to keyword search, and only typing the orchestrator's key in again
 * got out (r4 A-security #2).
 */
export function modelEndpointKeysAsSaved(
  form: { orchestratorBaseUrl: string; orchestratorApiKey: string; embeddingModel: string; embeddingBaseUrl: string; embeddingApiKey: string },
  loaded: {
    orchestrator: { baseUrl?: string; apiKey?: string };
    embeddings: { embeddingModel?: string; embeddingBaseUrl?: string; embeddingApiKey?: string };
  } | null | undefined,
  refusedField = "",
): { apiKey: string | undefined; embeddingApiKey: string | undefined } {
  const refusedEmbeddings = refusedField === "embeddings.embeddingApiKey";
  const embeddingBaseUrl = form.embeddingBaseUrl.trim();
  const storedEmbeddings = { key: loaded?.embeddings.embeddingApiKey, endpoint: loaded?.embeddings.embeddingBaseUrl };
  const modelChanged = form.embeddingModel.trim() !== (loaded?.embeddings.embeddingModel ?? "").trim();
  const savedNoneWhileBorrowing = storedEmbeddings.key === "" && !(storedEmbeddings.endpoint ?? "").trim() && !modelChanged;
  return {
    apiKey: keyAsSaved(
      form.orchestratorApiKey,
      form.orchestratorBaseUrl,
      { key: loaded?.orchestrator.apiKey, endpoint: loaded?.orchestrator.baseUrl },
      refusedField === "orchestrator.apiKey",
    ),
    embeddingApiKey: embeddingBaseUrl
      ? keyAsSaved(form.embeddingApiKey, embeddingBaseUrl, storedEmbeddings, refusedEmbeddings)
      : form.embeddingApiKey.trim() || (refusedEmbeddings || savedNoneWhileBorrowing ? "" : undefined),
  };
}

/**
 * The embeddings key field's placeholder: what the field, left empty, saves as. It always said the
 * orchestrator's key was used, also while a "" saved as no key stuck and none was sent (r4
 * A-security #2), and it names the change that sends them back to borrowing.
 */
export function embeddingKeyPlaceholder(
  form: Parameters<typeof modelEndpointKeysAsSaved>[0],
  loaded: Parameters<typeof modelEndpointKeysAsSaved>[1],
  refusedField = "",
): string {
  if (modelEndpointKeysAsSaved({ ...form, embeddingApiKey: "" }, loaded, refusedField).embeddingApiKey !== "") {
    return "uses orchestrator/provider key when empty";
  }
  // While the gateway's refusal stands, the empty field saves "" whatever the model or endpoint, so
  // naming a change that goes back to borrowing told the user to change the model they had just
  // changed (r5 A-security).
  if (refusedField === "embeddings.embeddingApiKey") return "no key: the gateway refused the last save over this key; type one";
  return form.embeddingBaseUrl.trim()
    ? "no key: type one, or clear the endpoint to use the orchestrator/provider key"
    : "no key: type one, or change the model to use the orchestrator/provider key";
}

/**
 * The quality tier's own saved key follows the image endpoint when the tier has no endpoint of its
 * own (resolveTierBackend), so moving the image endpoint moves it too — and the page has no field
 * for it. True when that is about to happen, or the gateway refused the last save over it.
 */
export function tierKeyFollowsMove(stored: MultimodalConfig, form: MultimodalFormValues, refusedField = ""): boolean {
  const tier = stored.imageGeneration?.qualityBackend;
  if (!tier?.apiKey || typeof tier.baseUrl === "string") return false;
  if (refusedField === "imageGeneration.qualityBackend.apiKey") return true;
  const now = form.imageGenBaseUrl.trim();
  return now !== "" && now !== (stored.imageGeneration?.baseUrl ?? "").trim();
}

export function buildMultimodalConfig(
  stored: MultimodalConfig,
  form: MultimodalFormValues,
  wake: { keywords: string[]; stopPhrases: string[] },
  refusedField = "",
): MultimodalConfig {
  const imageGenBaseUrl = form.imageGenBaseUrl.trim();
  // The tier's key is dropped (the tier then uses the image key) once the image key is dealt with:
  // typed in, cleared, or never set. A still-masked image key blocks the save on its own.
  const dropTierKey = tierKeyFollowsMove(stored, form, refusedField) && form.imageGenApiKey !== MASKED_KEY;
  return {
    ...stored,
    maxUploadBytes: form.maxUploadBytes,
    files: overStored(stored.files, {
      baseUrl: form.filesBaseUrl.trim(),
      apiKey: optional(form.filesApiKey),
      timeoutMs: form.filesTimeoutMs,
      toolName: form.fileToolName.trim(),
      visionModel: optional(form.visionModel),
      visionBaseUrl: optional(form.visionBaseUrl),
      visionApiKey: keyAsSaved(
        form.visionApiKey,
        form.visionBaseUrl,
        { key: stored.files.visionApiKey, endpoint: stored.files.visionBaseUrl },
        refusedField === "files.visionApiKey",
      ),
    }),
    stt: overStored(stored.stt, {
      baseUrl: form.sttBaseUrl.trim(),
      api: form.sttApi,
      apiKey: optional(form.sttApiKey),
      timeoutMs: form.sttTimeoutMs,
      model: form.sttModel.trim(),
    }),
    tts: overStored(stored.tts, {
      baseUrl: form.ttsBaseUrl.trim(),
      api: form.ttsApi,
      apiKey: optional(form.ttsApiKey),
      timeoutMs: form.ttsTimeoutMs,
      model: optional(form.ttsModel),
      defaultLanguage: form.ttsDefaultLanguage.trim(),
      defaultSpeaker: form.ttsDefaultSpeaker.trim(),
      defaultVoiceId: optional(form.ttsDefaultVoiceId),
      voiceSamplePath: optional(form.ttsVoiceSamplePath),
      voiceSampleText: optional(form.ttsVoiceSampleText),
      defaultQuality: form.ttsDefaultQuality.trim(),
    }),
    wakeWord: overStored(stored.wakeWord, {
      enabled: form.wakeEnabled,
      language: form.wakeLanguage,
      keywords: wake.keywords,
      stopPhrases: wake.stopPhrases,
      silenceTimeoutMs: form.wakeSilenceTimeoutMs,
    }),
    // An emptied endpoint is saved as "" beside the rest of the form, not by dropping the section:
    // "" switches a self-hosted backend off, and with the openai-compatible api it hands the
    // endpoint to the chat endpoint — which only works if the api chosen in the same save is kept.
    // With no section stored and no endpoint typed, there is nothing to save.
    imageGeneration: imageGenBaseUrl || stored.imageGeneration
      ? overStored(stored.imageGeneration, {
          baseUrl: imageGenBaseUrl,
          api: form.imageGenApi,
          apiKey: optional(form.imageGenApiKey),
          timeoutMs: form.imageGenTimeoutMs,
          model: optional(form.imageGenModel),
          defaultWidth: form.imageGenDefaultWidth,
          defaultHeight: form.imageGenDefaultHeight,
          defaultSteps: form.imageGenDefaultSteps,
          defaultGuidanceScale: form.imageGenGuidanceScale,
          defaultNegativePrompt: optional(form.imageGenDefaultNegativePrompt),
          ...(dropTierKey ? { qualityBackend: { ...stored.imageGeneration?.qualityBackend, apiKey: undefined } } : {}),
        })
      : undefined,
  };
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * What changed between the stored config and the page's next config, as a merge patch: objects
 * are compared key by key, a key that disappeared becomes `null`, arrays and plain values are
 * sent whole when they differ. `{}` when nothing changed.
 */
export function diffConfig(stored: unknown, next: unknown): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const before = (stored && typeof stored === "object" && !Array.isArray(stored)) ? stored as Record<string, unknown> : {};
  const after = (next && typeof next === "object" && !Array.isArray(next)) ? next as Record<string, unknown> : {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const was = before[key];
    const now = after[key];
    if (now === undefined) {
      // The form reads an empty field as "not set"; a key that was already "" (for tts.model,
      // "" means "skip the load-model preflight") has not changed, and clearing it would reset it
      // to the schema default.
      if (was !== undefined && was !== null && was !== "") patch[key] = null;
      continue;
    }
    const bothObjects = now && typeof now === "object" && !Array.isArray(now)
      && was && typeof was === "object" && !Array.isArray(was);
    if (bothObjects) {
      const nested = diffConfig(was, now);
      if (Object.keys(nested).length > 0) patch[key] = nested;
    } else if (!sameValue(was, now)) {
      patch[key] = now;
    }
  }
  return patch;
}

/**
 * The save the page sends: only what the user changed, cleared fields as `null`. `refusedField` is
 * the key the gateway named when it refused the last save.
 */
export function buildMultimodalPatch(
  stored: MultimodalConfig,
  form: MultimodalFormValues,
  wake: { keywords: string[]; stopPhrases: string[] },
  refusedField = "",
): Record<string, unknown> {
  const next = buildMultimodalConfig(stored, form, wake, refusedField);
  const patch = diffConfig(stored, next);
  // The vision key is the one key here whose unset is not "": unset hands its endpoint the
  // provider's key. The diff keeps an unchanged "" (elsewhere "" means something the form cannot
  // show), so a "" that keyAsSaved turns back into unset is removed here, by name.
  if (stored.files?.visionApiKey === "" && next.files.visionApiKey === undefined) {
    patch["files"] = { ...(patch["files"] as Record<string, unknown> | undefined), visionApiKey: null };
  }
  return patch;
}

/** What a stored key reads as over the API (the gateway's SECRET_PLACEHOLDER). */
export const MASKED_KEY = "••••••••";

type KeyField = "filesApiKey" | "visionApiKey" | "sttApiKey" | "ttsApiKey" | "imageGenApiKey";

/**
 * Each key field on the page, the endpoint field it is sent to, and the keys the server may name
 * for it — the image key's field answers for the quality tier's key too, which has no field.
 */
const KEY_ENDPOINTS: ReadonlyArray<{
  key: KeyField;
  endpoint: keyof MultimodalFormValues;
  paths: readonly string[];
  stored: (config: MultimodalConfig) => string | undefined;
}> = [
  { key: "filesApiKey", endpoint: "filesBaseUrl", paths: ["files.apiKey"], stored: (c) => c.files.baseUrl },
  { key: "visionApiKey", endpoint: "visionBaseUrl", paths: ["files.visionApiKey"], stored: (c) => c.files.visionBaseUrl },
  { key: "sttApiKey", endpoint: "sttBaseUrl", paths: ["stt.apiKey"], stored: (c) => c.stt.baseUrl },
  { key: "ttsApiKey", endpoint: "ttsBaseUrl", paths: ["tts.apiKey"], stored: (c) => c.tts.baseUrl },
  {
    key: "imageGenApiKey",
    endpoint: "imageGenBaseUrl",
    paths: ["imageGeneration.apiKey", "imageGeneration.qualityBackend.apiKey"],
    stored: (c) => c.imageGeneration?.baseUrl,
  },
];

/**
 * The key fields that need the key again before the page can save.
 *
 * The gateway will not send a saved key to an endpoint it was not already sent to, so a save that
 * moves an endpoint while its key still shows the untouched mask is refused. Say so beside the key
 * as soon as the endpoint changes, instead of letting the save fail: typing the key in, or clearing
 * the field (sent as `null`), is what the save needs. An emptied endpoint sends its key nowhere and
 * is left to the gateway, which alone knows where an empty image endpoint leads. `serverField` is
 * the key the gateway named when it refused the last save, for moves only it can see (the vision
 * model's provider, the chat endpoint, the quality tier's key); that one is named while its field
 * is still masked or empty, since an empty vision key is what hands over the provider's key.
 */
export function keysNeedingReentry(
  stored: MultimodalConfig,
  form: MultimodalFormValues,
  serverField = "",
): KeyField[] {
  return KEY_ENDPOINTS
    .filter(({ key, endpoint, paths, stored: storedEndpoint }) => {
      if (paths.includes(serverField) && (form[key] === MASKED_KEY || form[key].trim() === "")) return true;
      if (form[key] !== MASKED_KEY) return false;
      const now = String(form[endpoint]).trim();
      return now !== "" && now !== (storedEndpoint(stored) ?? "").trim();
    })
    .map(({ key }) => key);
}
