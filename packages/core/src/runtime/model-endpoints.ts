import { getConfig } from "../config/loader.js";
import { resolveEmbeddingEndpoint, resolveProviderChain, resolveProviderEndpointForModel } from "../providers/index.js";
import { markRuntimeComponentAttempt, markRuntimeComponentFailure, markRuntimeComponentSuccess } from "./status.js";

export interface ModelEndpointHealth {
  role: string;
  model: string;
  baseUrl: string;
  ok: boolean;
  status?: number;
  error?: string;
  source?: string;
  matchedModel?: string;
  availableModels?: string[];
}

interface EndpointTarget {
  role: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  source?: string;
  /** How the endpoint is read: its OpenAI model list (the default), or a rerank server's /health. */
  probe?: "models" | "health";
}

let lastSnapshot: ModelEndpointHealth[] = [];

function toModelsUrl(baseUrl: string): string {
  const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL("models", normalized).toString();
}

function normalizeModelId(value: string): string {
  return value.trim().toLowerCase();
}

function modelIdVariants(model: string): string[] {
  const trimmed = model.trim();
  const parts = trimmed.split("/").filter(Boolean);
  const variants = new Set<string>();

  if (trimmed) variants.add(normalizeModelId(trimmed));
  if (parts.length > 1) variants.add(normalizeModelId(parts.slice(1).join("/")));
  if (parts.length > 0) variants.add(normalizeModelId(parts.at(-1) ?? trimmed));

  return [...variants];
}

function extractAdvertisedModels(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];

  const parsed = body as {
    data?: Array<{ id?: unknown }>;
    models?: Array<{ id?: unknown } | string> | Record<string, unknown>;
    current_model?: unknown;
  };

  const ids = new Set<string>();

  for (const item of parsed.data ?? []) {
    if (typeof item?.id === "string" && item.id.trim()) ids.add(item.id.trim());
  }

  if (Array.isArray(parsed.models)) {
    for (const item of parsed.models) {
      if (typeof item === "string" && item.trim()) ids.add(item.trim());
      if (item && typeof item === "object" && typeof item.id === "string" && item.id.trim()) {
        ids.add(item.id.trim());
      }
    }
  } else if (parsed.models && typeof parsed.models === "object") {
    for (const key of Object.keys(parsed.models)) {
      if (key.trim()) ids.add(key.trim());
    }
  }

  if (typeof parsed.current_model === "string" && parsed.current_model.trim()) {
    ids.add(parsed.current_model.trim());
  }

  return [...ids];
}

function findMatchingModel(configuredModel: string, availableModels: string[]): string | undefined {
  const availablePairs = availableModels.map((model) => ({
    raw: model,
    variants: modelIdVariants(model),
  }));
  const configuredVariants = modelIdVariants(configuredModel);

  for (const configuredVariant of configuredVariants) {
    const match = availablePairs.find((candidate) => candidate.variants.includes(configuredVariant));
    if (match) return match.raw;
  }

  return undefined;
}

/** A request to the endpoint with its key, given up on after 10 s. */
async function requestEndpoint(target: EndpointTarget, url: string, body?: unknown): Promise<Response> {
  const headers = new Headers();
  if (target.apiKey) headers.set("Authorization", `Bearer ${target.apiKey}`);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    return await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A cross-encoder rerank server (retrieval.reranker in "tei" mode) is not an OpenAI server: it serves
 * POST /rerank and GET /health at its root and no /models, so the model-list check reported it
 * unhealthy (HTTP 404) while it reranked every turn. Its /health answers once the model is loaded;
 * the bundled server also names the model it loaded, and that has to be the configured one. A server
 * with no /health (404), one that lists its models the OpenAI way instead, is read by that list.
 */
async function checkHealthEndpoint(target: EndpointTarget): Promise<ModelEndpointHealth> {
  const base = { role: target.role, model: target.model, baseUrl: target.baseUrl, source: target.source };
  try {
    const response = await requestEndpoint(target, `${target.baseUrl.replace(/\/+$/, "")}/health`);
    if (response.status === 404) return checkModelsEndpoint(target);
    if (!response.ok) return { ...base, ok: false, status: response.status, error: `HTTP ${response.status}` };
    const body = await response.json().catch(() => null) as { model?: unknown; loaded?: unknown } | null;
    if (body?.loaded === false) return { ...base, ok: false, status: response.status, error: "Model not loaded" };
    const served = typeof body?.model === "string" && body.model.trim() ? body.model.trim() : undefined;
    if (served && !findMatchingModel(target.model, [served])) {
      return { ...base, ok: false, status: response.status, error: `Endpoint serves ${served}, not the configured model` };
    }
    return { ...base, ok: true, status: response.status, matchedModel: served ?? target.model };
  } catch (error) {
    return { ...base, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Whether the endpoint embeds under the configured name, sent as the provider sends it (the part after
 * "<provider>/"). llama-swap serves a model's aliases without listing them in /v1/models, so an alias
 * failed the list check while every embedding call succeeded. One small request settles it, and the
 * embedding model is in use by every turn's routing, so it loads nothing. Chat models are not probed
 * this way: a generation could make the server swap the model it has loaded.
 */
async function embedsUnderConfiguredName(target: EndpointTarget): Promise<boolean> {
  const parts = target.model.split("/");
  const modelId = parts.length > 1 ? parts.slice(1).join("/") : target.model;
  try {
    const normalized = target.baseUrl.endsWith("/") ? target.baseUrl : `${target.baseUrl}/`;
    const response = await requestEndpoint(target, new URL("embeddings", normalized).toString(), {
      model: modelId,
      input: "health probe",
      encoding_format: "float",
    });
    if (!response.ok) return false;
    const body = await response.json().catch(() => null) as { data?: Array<{ embedding?: unknown }> } | null;
    const vector = body?.data?.[0]?.embedding;
    return Array.isArray(vector) && vector.length > 0;
  } catch {
    return false;
  }
}

async function checkEndpoint(target: EndpointTarget): Promise<ModelEndpointHealth> {
  return target.probe === "health" ? checkHealthEndpoint(target) : checkModelsEndpoint(target);
}

/** The endpoint read by its OpenAI model list (/models): healthy when it lists the configured model. */
async function checkModelsEndpoint(target: EndpointTarget): Promise<ModelEndpointHealth> {
  try {
    const response = await requestEndpoint(target, toModelsUrl(target.baseUrl));
    if (!response.ok) {
      return {
        role: target.role,
        model: target.model,
        baseUrl: target.baseUrl,
        source: target.source,
        ok: false,
        status: response.status,
        error: `HTTP ${response.status}`,
      };
    }

    let availableModels: string[];
    try {
      availableModels = extractAdvertisedModels(await response.json());
    } catch (error) {
      return {
        role: target.role,
        model: target.model,
        baseUrl: target.baseUrl,
        source: target.source,
        ok: false,
        status: response.status,
        error: `Invalid /v1/models response: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const matchedModel = findMatchingModel(target.model, availableModels)
      ?? (target.role === "embeddings" && await embedsUnderConfiguredName(target) ? target.model : undefined);
    if (!matchedModel) {
      const advertised = availableModels.slice(0, 6).join(", ");
      return {
        role: target.role,
        model: target.model,
        baseUrl: target.baseUrl,
        source: target.source,
        ok: false,
        status: response.status,
        error: availableModels.length > 0
          ? `Configured model not advertised by endpoint${advertised ? ` (available: ${advertised})` : ""}`
          : "Endpoint returned no models from /v1/models",
        availableModels: availableModels.slice(0, 12),
      };
    }

    return {
      role: target.role,
      model: target.model,
      baseUrl: target.baseUrl,
      source: target.source,
      ok: true,
      status: response.status,
      matchedModel,
      availableModels: availableModels.slice(0, 12),
    };
  } catch (error) {
    return {
      role: target.role,
      model: target.model,
      baseUrl: target.baseUrl,
      source: target.source,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function collectTargets(): EndpointTarget[] {
  const config = getConfig();
  const defaults = config.agents.defaults.model;
  const targets: EndpointTarget[] = [];

  const appendProviderChainTargets = (role: string, source: string, modelConfig: typeof defaults) => {
    for (const endpoint of resolveProviderChain(modelConfig, config)) {
      targets.push({
        role: endpoint.priority === "primary" ? role : `${role}:${endpoint.priority}`,
        model: endpoint.model,
        baseUrl: endpoint.baseUrl,
        apiKey: endpoint.apiKey,
        source: endpoint.priority === "primary" ? source : `${source}.${endpoint.priority}`,
      });
    }
  };

  appendProviderChainTargets("orchestrator", "agents.defaults.model", defaults);

  if (defaults.embeddingModel) {
    const embeddingEndpoint = resolveEmbeddingEndpoint(defaults, config);
    targets.push({
      role: "embeddings",
      model: defaults.embeddingModel,
      baseUrl: embeddingEndpoint.baseUrl,
      apiKey: embeddingEndpoint.apiKey,
      source: "agents.defaults.model.embeddingModel",
    });
  }

  for (const [name, agent] of Object.entries(config.subAgents ?? {})) {
    const model = { ...defaults, ...(agent.model ?? {}) };
    appendProviderChainTargets(`subagent:${name}`, `subAgents.${name}.model`, model);
  }

  if (config.multimodal.files.visionModel) {
    const visionEndpoint = resolveProviderEndpointForModel(
      config.multimodal.files.visionModel,
      {
        baseUrl: config.multimodal.files.visionBaseUrl,
        apiKey: config.multimodal.files.visionApiKey,
      },
      config,
    );
    targets.push({
      role: "vision",
      model: config.multimodal.files.visionModel,
      baseUrl: visionEndpoint.baseUrl,
      apiKey: visionEndpoint.apiKey,
      source: "multimodal.files.visionModel",
    });
  }

  if (config.retrieval.reranker.enabled) {
    targets.push({
      role: "reranker",
      model: config.retrieval.reranker.model,
      baseUrl: config.retrieval.reranker.baseUrl,
      apiKey: config.retrieval.reranker.apiKey,
      source: "retrieval.reranker",
      // "llm" scores through an OpenAI-compatible chat model; "tei" is a rerank server with no model list.
      probe: config.retrieval.reranker.mode === "llm" ? "models" : "health",
    });
  }

  if (config.guardrails.modelModeration.enabled) {
    targets.push({
      role: "guard",
      model: config.guardrails.modelModeration.model,
      baseUrl: config.guardrails.modelModeration.baseUrl,
      apiKey: config.guardrails.modelModeration.apiKey,
      source: "guardrails.modelModeration",
    });
  }

  const deduped = new Map<string, EndpointTarget>();
  for (const target of targets) {
    const key = `${target.role}::${target.baseUrl}::${target.model}`;
    deduped.set(key, target);
  }
  return [...deduped.values()];
}

export async function syncModelEndpointRuntimeStatus(): Promise<ModelEndpointHealth[]> {
  markRuntimeComponentAttempt("model_endpoints");
  try {
    const targets = collectTargets();
    const snapshot = await Promise.all(targets.map(checkEndpoint));
    lastSnapshot = snapshot;
    const unhealthy = snapshot.filter((entry) => !entry.ok);
    markRuntimeComponentSuccess(
      "model_endpoints",
      {
        total: snapshot.length,
        healthy: snapshot.length - unhealthy.length,
        unhealthy: unhealthy.length,
        endpoints: snapshot,
      },
      unhealthy.length > 0
        ? { healthy: false, error: `${unhealthy.length} model endpoint(s) unhealthy` }
        : undefined,
    );
    return snapshot;
  } catch (error) {
    markRuntimeComponentFailure("model_endpoints", error);
    lastSnapshot = [];
    return [];
  }
}

export function getModelEndpointHealthSnapshot(): ModelEndpointHealth[] {
  return lastSnapshot;
}

/**
 * Probes the model endpoints again on its own: every minute while one fails, so the dashboard clears
 * once it answers, and every ten minutes while all answer, so one that goes away is noticed.
 *
 * They were probed at boot, on a config reload, and when the status route was read. An endpoint that
 * was not up yet at boot — the gateway restarting with the rest of Docker, before a model server had
 * loaded — kept the dashboard on "1 model endpoint(s) unhealthy" for hours after it answered
 * (2026-10-15). Returns the function that stops the re-probing.
 */
export function startModelEndpointRechecks(options: {
  initiallyHealthy: boolean;
  probe?: () => Promise<ModelEndpointHealth[]>;
  healthyEveryMs?: number;
  unhealthyEveryMs?: number;
}): () => void {
  const probe = options.probe ?? syncModelEndpointRuntimeStatus;
  const healthyEveryMs = options.healthyEveryMs ?? 10 * 60_000;
  const unhealthyEveryMs = options.unhealthyEveryMs ?? 60_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const schedule = (healthy: boolean) => {
    if (stopped) return;
    timer = setTimeout(() => {
      void probe()
        .then((endpoints) => endpoints.every((endpoint) => endpoint.ok), () => false)
        .then(schedule);
    }, healthy ? healthyEveryMs : unhealthyEveryMs);
    // A pending re-probe never keeps the process alive.
    timer.unref?.();
  };
  schedule(options.initiallyHealthy);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}