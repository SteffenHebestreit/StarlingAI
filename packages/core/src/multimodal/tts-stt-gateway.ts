/**
 * A TTS-STT gateway (multimodal.tts.api "tts-stt-gateway"): one service with several speech engines
 * behind it, addressed through its own API rather than its OpenAI-compatible one.
 *
 * A voice is named "<engine>:<voice>" — piper:de_DE-thorsten-medium, magpie:Sofia — or
 * "saved:<id>" for a voice cloned from a recording. The service's OpenAI route always speaks with its
 * default engine, and neither that route nor /api/tts can use a saved voice: a saved voice is spoken
 * only at /api/providers/qwen3/saved-voices/<id>/tts, with the language as `lang` (a `language` field
 * there is ignored, and the voice speaks German).
 */
import {
  extractUpstreamError,
  fetchWithTimeout,
  parseUpstreamJsonResponse,
  upstreamHeaders,
  upstreamUrl,
} from "../gateway/upstream-http.js";

export type HubVoice = { kind: "saved"; id: string } | { kind: "engine"; engine: string; voice?: string };

/** The engine a voice that names none is spoken by: piper is local, fast, and has German voices. */
export const HUB_DEFAULT_ENGINE = "piper";

/** A voice reference, or undefined for one that names no engine. */
export function parseHubVoice(ref: string | undefined): HubVoice | undefined {
  const value = ref?.trim();
  if (!value) return undefined;
  const colon = value.indexOf(":");
  if (colon <= 0) return undefined;
  const engine = value.slice(0, colon).trim().toLowerCase();
  const voice = value.slice(colon + 1).trim();
  if (engine === "saved") return voice ? { kind: "saved", id: voice } : undefined;
  return { kind: "engine", engine, ...(voice ? { voice } : {}) };
}

/** A voice reference as it is written: the inverse of parseHubVoice. */
export function formatHubVoice(voice: HubVoice): string {
  return voice.kind === "saved" ? `saved:${voice.id}` : `${voice.engine}:${voice.voice ?? ""}`;
}

const LANGUAGE_NAMES: Record<string, string> = {
  german: "de", deutsch: "de", english: "en", englisch: "en", polish: "pl", french: "fr", spanish: "es",
  italian: "it", dutch: "nl", portuguese: "pt", russian: "ru", japanese: "ja", chinese: "zh",
};

/** The language a request to the service carries: a two-letter code ("de" for "de-DE" or "German"), or "auto". */
export function hubLanguage(language: string | undefined): string {
  const value = language?.trim().toLowerCase().replace(/_/g, "-");
  if (!value || value === "auto") return "auto";
  if (LANGUAGE_NAMES[value]) return LANGUAGE_NAMES[value]!;
  const code = /^([a-z]{2,3})(?:-[a-z0-9]{2,8})*$/.exec(value)?.[1];
  return code ?? "auto";
}

/**
 * The voice that speaks text in `language`: the one the request names, else the voice configured for
 * that language (multimodal.tts.voices, keyed by two-letter code), else the one configured for "*".
 */
export function hubVoiceFor(
  voices: Record<string, string>,
  language: string | undefined,
  requested?: string,
): HubVoice | undefined {
  const own = parseHubVoice(requested);
  if (own) return own;
  const code = hubLanguage(language);
  return parseHubVoice(voices[code]) ?? parseHubVoice(voices["*"]);
}

export interface HubConnection {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
}

/** Synthesises `text` with `voice` (WAV). */
export async function requestHubSpeech(input: HubConnection & {
  text: string;
  language: string | undefined;
  voice?: HubVoice;
  speed?: number;
}): Promise<Response> {
  const lang = hubLanguage(input.language);
  if (input.voice?.kind === "saved") {
    const form = new FormData();
    form.append("text", input.text);
    form.append("lang", lang);
    return fetchWithTimeout(
      upstreamUrl(input.baseUrl, `/api/providers/qwen3/saved-voices/${encodeURIComponent(input.voice.id)}/tts`),
      { method: "POST", headers: upstreamHeaders(input.apiKey), body: form },
      input.timeoutMs,
    );
  }
  const engine = input.voice?.engine ?? HUB_DEFAULT_ENGINE;
  return fetchWithTimeout(
    upstreamUrl(input.baseUrl, "/api/tts"),
    {
      method: "POST",
      headers: upstreamHeaders(input.apiKey, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        provider: engine,
        text: input.text,
        language: lang,
        output_format: "wav",
        ...(input.voice?.kind === "engine" && input.voice.voice ? { voice: input.voice.voice } : {}),
        ...(input.speed !== undefined ? { speed: input.speed } : {}),
      }),
    },
    input.timeoutMs,
  );
}

export interface HubCatalogVoice {
  /** The reference to configure or send: "piper:de_DE-thorsten-medium", "saved:luna". */
  id: string;
  name: string;
  engine: string;
  kind: "builtin" | "custom" | "saved";
  language?: string;
}

/** Every voice the service offers: each speech engine's own voices and the saved (cloned) ones. */
export async function fetchHubVoiceCatalog(connection: HubConnection): Promise<{ voices: HubCatalogVoice[]; engines: string[] }> {
  const get = (path: string) => fetchWithTimeout(upstreamUrl(connection.baseUrl, path), { headers: upstreamHeaders(connection.apiKey) }, connection.timeoutMs);
  const providersResponse = await get("/providers");
  if (!providersResponse.ok) throw new Error(await extractUpstreamError(providersResponse, "Failed to load the speech engines"));
  const providersBody = await parseUpstreamJsonResponse(providersResponse, "The engine list returned a non-JSON response");
  const providers = (providersBody["providers"] && typeof providersBody["providers"] === "object" ? providersBody["providers"] : {}) as Record<string, { kind?: unknown }>;
  const engines = Object.entries(providers).filter(([, info]) => info?.kind === "tts").map(([id]) => id);

  const voices: HubCatalogVoice[] = [];
  await Promise.all(engines.map(async (engine) => {
    if (engine === "qwen3") {
      const saved = await get("/api/providers/qwen3/saved-voices");
      if (!saved.ok) return;
      const body = await parseUpstreamJsonResponse(saved, "The saved-voice list returned a non-JSON response");
      for (const entry of Array.isArray(body["voices"]) ? body["voices"] as Array<Record<string, unknown>> : []) {
        const id = typeof entry["id"] === "string" ? entry["id"] : undefined;
        if (!id) continue;
        voices.push({
          id: `saved:${id}`,
          name: typeof entry["name"] === "string" ? entry["name"] : id,
          engine,
          kind: "saved",
          ...(typeof entry["language"] === "string" ? { language: entry["language"] } : {}),
        });
      }
      return;
    }
    const response = await get(`/api/providers/${encodeURIComponent(engine)}/voices`);
    if (!response.ok) return;
    const body = await parseUpstreamJsonResponse(response, "The voice list returned a non-JSON response");
    for (const entry of Array.isArray(body["voices"]) ? body["voices"] as Array<Record<string, unknown> | string> : []) {
      const voice = typeof entry === "string" ? entry : typeof entry["id"] === "string" ? entry["id"] : typeof entry["name"] === "string" ? entry["name"] : undefined;
      if (!voice) continue;
      const info = typeof entry === "string" ? {} : entry;
      voices.push({
        id: `${engine}:${voice}`,
        name: typeof info["name"] === "string" ? info["name"] : voice,
        engine,
        kind: info["kind"] === "custom" ? "custom" : "builtin",
        ...(typeof info["language"] === "string" ? { language: info["language"] } : {}),
      });
    }
  }));
  voices.sort((left, right) => left.id.localeCompare(right.id));
  return { voices, engines };
}
