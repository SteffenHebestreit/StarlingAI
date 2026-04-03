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

async function checkEndpoint(target: EndpointTarget): Promise<ModelEndpointHealth> {
  try {
    const headers = new Headers();
    if (target.apiKey) headers.set("Authorization", `Bearer ${target.apiKey}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const response = await fetch(toModelsUrl(target.baseUrl), { method: "GET", headers, signal: controller.signal });
    clearTimeout(timer);
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

    const matchedModel = findMatchingModel(target.model, availableModels);
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