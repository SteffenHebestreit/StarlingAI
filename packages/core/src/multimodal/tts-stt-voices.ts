/**
 * Managing a TTS-STT gateway's voices (multimodal.tts.api "tts-stt-gateway"): cloning a voice from
 * a recording, deleting one, designing one from a description, and the service's experimental
 * training. The dashboard's Voices settings call these through the gateway's /api/multimodal/voices
 * routes; the service itself is not reachable from the browser (no CORS, and it refuses a request
 * that carries a foreign Origin).
 *
 * The service runs ONE qwen3 model at a time, chosen explicitly and kept until changed: a Base
 * model speaks saved voices and clones, the VoiceDesign model designs. Designing therefore loads the
 * VoiceDesign model and loads the previous one back afterwards — left switched, every saved voice
 * (the cloned German voice the chat speaks with) failed until someone switched back by hand.
 */
import {
  extractUpstreamError,
  fetchWithTimeout,
  parseUpstreamJsonResponse,
  upstreamHeaders,
  upstreamUrl,
} from "../gateway/upstream-http.js";
import { hubLanguage, parseHubVoice, type HubConnection } from "./tts-stt-gateway.js";

/** The id the service gives a saved voice named `name` (its own derivation): "My Voice" → "my_voice". */
export function savedVoiceIdFor(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
}

/** A failure the service reported, with its status, for the route to pass on. */
export class HubVoiceError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function failed(response: Response, fallback: string): Promise<never> {
  throw new HubVoiceError(await extractUpstreamError(response, fallback), response.status);
}

async function getJson(connection: HubConnection, path: string, fallback: string): Promise<Record<string, unknown>> {
  const response = await fetchWithTimeout(upstreamUrl(connection.baseUrl, path), { headers: upstreamHeaders(connection.apiKey) }, connection.timeoutMs);
  if (!response.ok) await failed(response, fallback);
  return parseUpstreamJsonResponse(response, `${fallback}: the service returned a non-JSON response`);
}

/** The ids of the saved voices, and the model each was made with. */
async function savedVoices(connection: HubConnection): Promise<Array<{ id: string; modelUsed?: string }>> {
  const body = await getJson(connection, "/api/providers/qwen3/saved-voices", "Failed to list the saved voices");
  const voices = Array.isArray(body["voices"]) ? body["voices"] as Array<Record<string, unknown>> : [];
  return voices
    .filter((voice) => typeof voice["id"] === "string")
    .map((voice) => ({ id: voice["id"] as string, ...(typeof voice["model_used"] === "string" ? { modelUsed: voice["model_used"] } : {}) }));
}

export interface CloneVoiceInput {
  name: string;
  audio: Blob;
  filename: string;
  language?: string;
  /** The words spoken in the recording. Without them the service transcribes it itself. */
  referenceText?: string;
  /** "xvector": the voice's sound only, from any recording. "icl": closer, and needs the exact words. */
  mode?: "xvector" | "icl";
  /** Save over a voice of the same name. The service overwrites silently; this refuses unless asked. */
  replace?: boolean;
}

/** Saves a voice cloned from a recording; returns its reference ("saved:<id>"). */
export async function cloneHubVoice(connection: HubConnection, input: CloneVoiceInput): Promise<{ voice: string; name: string; referenceText?: string }> {
  const id = savedVoiceIdFor(input.name);
  if (!id) throw new HubVoiceError("Give the voice a name with letters or digits.", 400);
  if (!input.replace && (await savedVoices(connection)).some((voice) => voice.id === id)) {
    throw new HubVoiceError(`A voice named "${id}" already exists. Choose another name, or replace it.`, 409);
  }
  const form = new FormData();
  form.append("name", input.name.trim());
  form.append("file", input.audio, input.filename);
  form.append("lang", hubLanguage(input.language));
  form.append("mode", input.mode ?? "xvector");
  if (input.referenceText?.trim()) form.append("ref_text", input.referenceText.trim());
  const response = await fetchWithTimeout(
    upstreamUrl(connection.baseUrl, "/api/providers/qwen3/saved-voices"),
    { method: "POST", headers: upstreamHeaders(connection.apiKey), body: form },
    Math.max(connection.timeoutMs, 300_000),
  );
  if (!response.ok) await failed(response, "Failed to save the voice");
  const body = await parseUpstreamJsonResponse(response, "Saving the voice returned a non-JSON response");
  const savedId = typeof body["voice_id"] === "string" ? body["voice_id"] : id;
  return {
    voice: `saved:${savedId}`,
    name: typeof body["name"] === "string" ? body["name"] : input.name.trim(),
    ...(typeof body["ref_text"] === "string" && body["ref_text"] ? { referenceText: body["ref_text"] } : {}),
  };
}

/** Deletes a saved voice, or a voice trained into piper; a built-in voice cannot be deleted. */
export async function deleteHubVoice(connection: HubConnection, reference: string): Promise<void> {
  const voice = parseHubVoice(reference);
  const path = voice?.kind === "saved"
    ? `/api/providers/qwen3/saved-voices/${encodeURIComponent(voice.id)}`
    : voice?.kind === "engine" && voice.engine === "piper" && voice.voice
      ? `/api/providers/piper/custom-voices/${encodeURIComponent(voice.voice)}`
      : undefined;
  if (!path) throw new HubVoiceError("Only your own voices can be deleted — saved ones, or ones trained for piper.", 400);
  const response = await fetchWithTimeout(upstreamUrl(connection.baseUrl, path), { method: "DELETE", headers: upstreamHeaders(connection.apiKey) }, connection.timeoutMs);
  if (!response.ok) await failed(response, "Failed to delete the voice");
}

export interface QwenModel { id: string; capabilities: string[] }

async function qwenModels(connection: HubConnection): Promise<{ models: QwenModel[]; current?: string }> {
  const body = await getJson(connection, "/api/providers/qwen3/models", "Failed to list the speech models");
  const models = (Array.isArray(body["models"]) ? body["models"] as Array<Record<string, unknown>> : [])
    .filter((model) => typeof model["id"] === "string")
    .map((model) => ({
      id: model["id"] as string,
      capabilities: Array.isArray(model["capabilities"]) ? (model["capabilities"] as unknown[]).map(String) : [],
    }));
  const current = typeof body["current_model"] === "string" && body["current_model"] ? body["current_model"] : undefined;
  return { models, ...(current ? { current } : {}) };
}

/** Loading a model can take minutes the first time (a download); the service gives up after five. */
const MODEL_SWITCH_TIMEOUT_MS = 300_000;

async function selectModel(connection: HubConnection, model: string): Promise<void> {
  const response = await fetchWithTimeout(
    upstreamUrl(connection.baseUrl, "/api/providers/qwen3/models/select"),
    { method: "POST", headers: upstreamHeaders(connection.apiKey, { "Content-Type": "application/json" }), body: JSON.stringify({ model }) },
    MODEL_SWITCH_TIMEOUT_MS,
  );
  if (!response.ok) await failed(response, `Failed to load the speech model ${model}`);
}

/**
 * The model to load back after a design: the one loaded before it, else the one the saved voices
 * were made with (the service unloads an idle model and then reports none), else the first Base.
 */
export function modelToRestore(
  before: string | undefined,
  models: readonly QwenModel[],
  voices: ReadonlyArray<{ modelUsed?: string }>,
): string | undefined {
  const canClone = (id: string | undefined) => Boolean(id && models.some((model) => model.id === id && model.capabilities.includes("voice_clone")));
  if (before && !models.find((model) => model.id === before)?.capabilities.includes("voice_design")) return before;
  const used = voices.map((voice) => voice.modelUsed).find(canClone);
  if (used) return used;
  return models.find((model) => model.capabilities.includes("voice_clone"))?.id;
}

let designQueue: Promise<unknown> = Promise.resolve();

/**
 * A voice designed from a description, speaking `text` (WAV). Nothing is saved: the dashboard keeps
 * the audio and saves it as a voice with cloneHubVoice (mode "icl", `text` as the transcript).
 * Designs run one at a time — two at once would switch the shared model under each other.
 */
export function designHubVoice(connection: HubConnection, input: { description: string; text: string; language?: string }): Promise<Blob> {
  const run = designQueue.then(() => designNow(connection, input), () => designNow(connection, input));
  designQueue = run.catch(() => undefined);
  return run;
}

async function designNow(connection: HubConnection, input: { description: string; text: string; language?: string }): Promise<Blob> {
  const { models, current } = await qwenModels(connection);
  const designer = models.find((model) => model.capabilities.includes("voice_design"))?.id;
  if (!designer) throw new HubVoiceError("The speech service offers no voice-design model.", 400);
  // Found switched to the designer already (a design that never switched back): it goes back too.
  const restore = modelToRestore(current === designer ? undefined : current, models, await savedVoices(connection));
  if (current !== designer) await selectModel(connection, designer);
  try {
    const response = await fetchWithTimeout(
      upstreamUrl(connection.baseUrl, "/api/providers/qwen3/voice-design"),
      {
        method: "POST",
        headers: upstreamHeaders(connection.apiKey, { "Content-Type": "application/json" }),
        body: JSON.stringify({ text: input.text, voice_description: input.description, lang: hubLanguage(input.language) }),
      },
      Math.max(connection.timeoutMs, 600_000),
    );
    if (!response.ok) await failed(response, "Failed to design the voice");
    return new Blob([await response.arrayBuffer()], { type: response.headers.get("content-type") ?? "audio/wav" });
  } finally {
    if (restore && restore !== designer) await selectModel(connection, restore);
  }
}

export interface TrainingJob {
  id: string;
  status: string;
  progress?: number;
  modelName?: string;
  message?: string;
  currentEpoch?: number;
  totalEpochs?: number;
}

function readJob(raw: Record<string, unknown>): TrainingJob | undefined {
  const id = typeof raw["job_id"] === "string" ? raw["job_id"] : typeof raw["id"] === "string" ? raw["id"] : undefined;
  if (!id) return undefined;
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  const str = (value: unknown) => (typeof value === "string" && value.trim() ? value : undefined);
  const job: TrainingJob = { id, status: str(raw["status"]) ?? "unknown" };
  const progress = num(raw["progress"]);
  const modelName = str(raw["model_name"]) ?? str(raw["voice_name"]);
  const message = str(raw["message"]);
  const currentEpoch = num(raw["current_epoch"]);
  const totalEpochs = num(raw["total_epochs"]);
  if (progress !== undefined) job.progress = progress;
  if (modelName) job.modelName = modelName;
  if (message) job.message = message;
  if (currentEpoch !== undefined) job.currentEpoch = currentEpoch;
  if (totalEpochs !== undefined) job.totalEpochs = totalEpochs;
  return job;
}

/** The training jobs, or `enabled: false` where the service has training switched off (it answers 404). */
export async function listTrainingJobs(connection: HubConnection): Promise<{ enabled: boolean; jobs: TrainingJob[] }> {
  const response = await fetchWithTimeout(upstreamUrl(connection.baseUrl, "/api/training/jobs"), { headers: upstreamHeaders(connection.apiKey) }, connection.timeoutMs);
  if (response.status === 404) return { enabled: false, jobs: [] };
  if (!response.ok) await failed(response, "Failed to list the training jobs");
  const body = await response.json() as unknown;
  const rows = Array.isArray(body) ? body : Array.isArray((body as Record<string, unknown>)?.["jobs"]) ? (body as Record<string, unknown>)["jobs"] as unknown[] : [];
  return { enabled: true, jobs: rows.map((row) => readJob(row as Record<string, unknown>)).filter((job): job is TrainingJob => Boolean(job)) };
}

/**
 * Starts training a piper voice from recordings (raw audio; the service transcribes and cuts it).
 * Once done, the voice is "piper:<name>". The service's own words: not production quality, not
 * expected to be intelligible speech.
 */
export async function startTraining(
  connection: HubConnection,
  input: { name: string; language?: string; files: Array<{ audio: Blob; filename: string }>; epochs?: number },
): Promise<{ jobId: string }> {
  const name = input.name.trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new HubVoiceError("A training name is 1-64 letters, digits, dashes or underscores.", 400);
  if (input.files.length === 0) throw new HubVoiceError("Add at least one recording.", 400);
  const form = new FormData();
  form.append("model_name", name);
  form.append("language", hubLanguage(input.language) === "auto" ? "de" : hubLanguage(input.language));
  form.append("sample_rate", "22050");
  if (input.epochs) form.append("epochs", String(input.epochs));
  for (const file of input.files) form.append("audio_files", file.audio, file.filename);
  const response = await fetchWithTimeout(
    upstreamUrl(connection.baseUrl, "/api/training/train"),
    { method: "POST", headers: upstreamHeaders(connection.apiKey), body: form },
    Math.max(connection.timeoutMs, 300_000),
  );
  if (response.status === 404) throw new HubVoiceError("Training is switched off on the speech service (ENABLE_TRAINING).", 404);
  if (!response.ok) await failed(response, "Failed to start the training");
  const body = await parseUpstreamJsonResponse(response, "Starting the training returned a non-JSON response");
  const jobId = typeof body["job_id"] === "string" ? body["job_id"] : undefined;
  if (!jobId) throw new HubVoiceError("The speech service started no training job.", 502);
  return { jobId };
}

export async function cancelTraining(connection: HubConnection, jobId: string): Promise<void> {
  const response = await fetchWithTimeout(
    upstreamUrl(connection.baseUrl, `/api/training/job/${encodeURIComponent(jobId)}`),
    { method: "DELETE", headers: upstreamHeaders(connection.apiKey) },
    connection.timeoutMs,
  );
  if (!response.ok) await failed(response, "Failed to cancel the training");
}
