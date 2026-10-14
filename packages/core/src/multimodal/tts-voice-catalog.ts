/**
 * The TTS voice catalog: the saved voices, the built-in speakers and the models of the configured
 * TTS backend, as the dashboard's voice route (/api/multimodal/voices) and the list_tts_voices tool
 * both report it.
 *
 * The two had a copy each, and when the route learned to read an OpenAI-compatible server's model
 * list at /v1/models (fetchOpenAiTtsModels), the tool's copy kept reading /models, which such a
 * server does not serve: the tool failed on a backend the dashboard listed (review 2026-10-11).
 */
import { fetchHubVoiceCatalog } from "./tts-stt-gateway.js";
import {
  extractUpstreamError,
  fetchOpenAiTtsModels,
  fetchWithTimeout,
  parseUpstreamJsonResponse,
  upstreamHeaders,
  upstreamUrl,
} from "../gateway/upstream-http.js";

export interface TtsCatalogConfig {
  api: "qwen-compatible" | "openai-compatible" | "tts-stt-gateway";
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
}

export async function fetchTtsVoiceCatalog(config: TtsCatalogConfig): Promise<Record<string, unknown>> {
  if (config.api === "tts-stt-gateway") {
    const { voices, engines } = await fetchHubVoiceCatalog(config);
    return { voices, engines, speakers: [], models: {} };
  }
  if (config.api === "openai-compatible") {
    const [voicesResponse, modelsResponse] = await Promise.all([
      fetchWithTimeout(upstreamUrl(config.baseUrl, "/voices"), { headers: upstreamHeaders(config.apiKey) }, config.timeoutMs),
      fetchOpenAiTtsModels(config),
    ]);

    if (!modelsResponse.ok) throw new Error(await extractUpstreamError(modelsResponse, "Failed to load TTS models"));

    const modelsBody = await parseUpstreamJsonResponse(modelsResponse, "Model list returned a non-JSON response");
    let voices: unknown[] = [];

    if (voicesResponse.ok) {
      const voicesBody = await parseUpstreamJsonResponse(voicesResponse, "Voice list returned a non-JSON response");
      voices = Array.isArray(voicesBody["voices"]) ? voicesBody["voices"] : [];
    } else if (voicesResponse.status !== 404 && voicesResponse.status !== 405) {
      throw new Error(await extractUpstreamError(voicesResponse, "Failed to load saved voices"));
    }

    return {
      voices,
      speakers: [],
      models: catalogModels(modelsBody),
      currentModel: modelsBody["current_model"] ?? undefined,
    };
  }

  const [voicesResponse, speakersResponse, modelsResponse] = await Promise.all([
    fetchWithTimeout(upstreamUrl(config.baseUrl, "/voices"), { headers: upstreamHeaders(config.apiKey) }, config.timeoutMs),
    fetchWithTimeout(upstreamUrl(config.baseUrl, "/speakers"), { headers: upstreamHeaders(config.apiKey) }, config.timeoutMs),
    fetchWithTimeout(upstreamUrl(config.baseUrl, "/models"), { headers: upstreamHeaders(config.apiKey) }, config.timeoutMs),
  ]);

  if (!voicesResponse.ok) throw new Error(await extractUpstreamError(voicesResponse, "Failed to load saved voices"));
  if (!speakersResponse.ok) throw new Error(await extractUpstreamError(speakersResponse, "Failed to load speakers"));
  if (!modelsResponse.ok) throw new Error(await extractUpstreamError(modelsResponse, "Failed to load TTS models"));

  const voicesBody = await parseUpstreamJsonResponse(voicesResponse, "Voice list returned a non-JSON response");
  const speakersBody = await parseUpstreamJsonResponse(speakersResponse, "Speaker list returned a non-JSON response");
  const modelsBody = await parseUpstreamJsonResponse(modelsResponse, "Model list returned a non-JSON response");
  return {
    voices: Array.isArray(voicesBody["voices"]) ? voicesBody["voices"] : [],
    speakers: Array.isArray(speakersBody["speakers"]) ? speakersBody["speakers"] : [],
    models: catalogModels(modelsBody),
    currentModel: modelsBody["current_model"] ?? undefined,
  };
}

/**
 * The `models` of a model-list body, in the shape the qwen-compatible server's /models has them: a
 * map from model id to its details. An OpenAI-compatible server lists `{ object: "list", data:
 * [{ id }] }` instead, which read as no models at all; its ids become the keys, each named by its id.
 */
function catalogModels(body: Record<string, unknown>): unknown {
  const models = body["models"];
  if (models != null) return models;
  const data = body["data"];
  if (!Array.isArray(data)) return {};
  return Object.fromEntries(data.flatMap((entry: unknown) => {
    const id = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>)["id"] : undefined;
    return typeof id === "string" && id.trim() ? [[id, { name: id }]] : [];
  }));
}
