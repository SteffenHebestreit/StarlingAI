import { getConfig } from "../config/loader.js";
import { LMStudioProvider, type ChatProvider, type OpenAICompatibleProviderRuntimeSnapshot } from "./lmstudio.js";
import { FailoverChatProvider, type FailoverEndpointDescriptor, type FailoverEndpointRuntimeSnapshot, type FailoverProviderBinding } from "./failover.js";
import { buildAgentIndex } from "./embeddings.js";
import { childLogger } from "../logger.js";
import { markRuntimeComponentAttempt, markRuntimeComponentFailure, markRuntimeComponentSuccess } from "../runtime/status.js";
import { logAudit } from "../audit/logger.js";
import type { Config, ModelConfig } from "../config/schema.js";

const log = childLogger("providers");

const DEFAULT_OPENAI_BASE_URL = "http://host.docker.internal:1234/v1";
const DEFAULT_OPENAI_API_KEY = "lm-studio";

let _chatProvider: ChatProvider | null = null;
let _chatProviderSignature: string | null = null;
let _embeddingProvider: LMStudioProvider | null = null;
let _embeddingProviderSignature: string | null = null;

export interface ResolvedProviderEndpoint {
  providerId: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  priority: "primary" | "fallback" | "cloudFallback";
  timeoutMs?: number;
  maxRetries?: number;
}

export interface ProviderRuntimeEndpointStatus extends FailoverEndpointRuntimeSnapshot {}

export interface ProviderRuntimeStatusSnapshot {
  healthy: boolean;
  mode: "single" | "failover";
  activeProviderId?: string;
  activeModel?: string;
  activeBaseUrl?: string;
  endpoints: ProviderRuntimeEndpointStatus[];
}

function getProviderId(modelName: string | undefined): string {
  if (!modelName) return "lmstudio";
  const [providerId] = modelName.split("/");
  return providerId?.trim() || "lmstudio";
}

function getNamedOpenAICompatibleProvider(providerId: string, config: Config) {
  if (providerId === "lmstudio") return config.providers.lmstudio;
  return config.providers.openaiCompatible?.[providerId];
}

function createSingleProvider(modelConfig: ModelConfig, endpoint: ResolvedProviderEndpoint): LMStudioProvider {
  return new LMStudioProvider(endpoint.baseUrl, endpoint.apiKey, modelConfig, {
    timeoutMs: endpoint.timeoutMs,
    maxRetries: endpoint.maxRetries,
  });
}

function resolveEndpointForProviderModel(
  providerModel: string,
  overrides: { baseUrl?: string; apiKey?: string } = {},
  config: Config = getConfig(),
  priority: ResolvedProviderEndpoint["priority"] = "primary",
): ResolvedProviderEndpoint {
  const providerId = getProviderId(providerModel);
  const providerConfig = getNamedOpenAICompatibleProvider(providerId, config);
  return {
    providerId,
    model: providerModel,
    baseUrl: overrides.baseUrl ?? providerConfig?.baseUrl ?? config.providers.lmstudio?.baseUrl ?? DEFAULT_OPENAI_BASE_URL,
    apiKey: overrides.apiKey ?? providerConfig?.apiKey ?? config.providers.lmstudio?.apiKey ?? DEFAULT_OPENAI_API_KEY,
    priority,
    timeoutMs: providerConfig?.timeoutMs,
    maxRetries: providerConfig?.maxRetries,
  };
}

export function resolveProviderEndpoint(modelConfig: ModelConfig, config: Config = getConfig()): ResolvedProviderEndpoint {
  return resolveEndpointForProviderModel(
    modelConfig.primary,
    { baseUrl: modelConfig.baseUrl, apiKey: modelConfig.apiKey },
    config,
    "primary",
  );
}

export function resolveProviderEndpointForModel(
  modelName: string,
  overrides: { baseUrl?: string; apiKey?: string } = {},
  config: Config = getConfig(),
): ResolvedProviderEndpoint {
  return resolveEndpointForProviderModel(modelName, overrides, config, "primary");
}

export function resolveProviderChain(
  modelConfig: ModelConfig,
  config: Config = getConfig(),
  primaryEndpoint = resolveProviderEndpoint(modelConfig, config),
): ResolvedProviderEndpoint[] {
  const chain: ResolvedProviderEndpoint[] = [];
  const seen = new Set<string>();

  const pushUnique = (endpoint: ResolvedProviderEndpoint) => {
    const key = `${endpoint.providerId}::${endpoint.baseUrl}::${endpoint.model}`;
    if (seen.has(key)) return;
    seen.add(key);
    chain.push(endpoint);
  };

  pushUnique({
    ...primaryEndpoint,
    model: modelConfig.primary,
    priority: "primary",
  });

  if (modelConfig.fallback) {
    pushUnique(resolveEndpointForProviderModel(modelConfig.fallback, {}, config, "fallback"));
  }

  if (modelConfig.cloudFallback) {
    pushUnique(resolveEndpointForProviderModel(modelConfig.cloudFallback, {}, config, "cloudFallback"));
  }

  return chain;
}

export function resolveEmbeddingEndpoint(modelConfig: ModelConfig, config: Config = getConfig()): ResolvedProviderEndpoint {
  const model = modelConfig.embeddingModel ?? modelConfig.primary;
  const providerId = getProviderId(model);
  const providerConfig = getNamedOpenAICompatibleProvider(providerId, config);
  return {
    providerId,
    model,
    baseUrl: modelConfig.embeddingBaseUrl ?? modelConfig.baseUrl ?? providerConfig?.baseUrl ?? config.providers.lmstudio?.baseUrl ?? DEFAULT_OPENAI_BASE_URL,
    apiKey: modelConfig.embeddingApiKey ?? modelConfig.apiKey ?? providerConfig?.apiKey ?? config.providers.lmstudio?.apiKey ?? DEFAULT_OPENAI_API_KEY,
    priority: "primary",
    timeoutMs: providerConfig?.timeoutMs,
    maxRetries: providerConfig?.maxRetries,
  };
}

export function createChatProvider(modelConfig: ModelConfig, endpoint = resolveProviderEndpoint(modelConfig)): ChatProvider {
  const config = getConfig();
  const chain = resolveProviderChain(modelConfig, config, endpoint);
  const bindings: FailoverProviderBinding[] = chain.map((resolved): FailoverProviderBinding => {
    const perEndpointModelConfig: ModelConfig = {
      ...modelConfig,
      primary: resolved.model,
      baseUrl: resolved.baseUrl,
      apiKey: resolved.apiKey,
      fallback: undefined,
      cloudFallback: undefined,
    };

    return {
      endpoint: resolved as FailoverEndpointDescriptor,
      provider: createSingleProvider(perEndpointModelConfig, resolved),
    };
  });

  return bindings.length === 1
    ? bindings[0]!.provider
    : new FailoverChatProvider(bindings);
}

export function getChatProvider(): ChatProvider {
  const config = getConfig();
  const modelConfig = config.agents.defaults.model;
  const endpoint = resolveProviderEndpoint(modelConfig, config);
  const signature = JSON.stringify({ endpoint, modelConfig });

  if (_chatProvider && _chatProviderSignature === signature) return _chatProvider;

  _chatProviderSignature = signature;
  _chatProvider = createChatProvider(modelConfig, endpoint);
  return _chatProvider;
}

/** Create a one-off provider instance with per-turn model config overrides (e.g. enableThinking). */
export function getChatProviderWithOverride(override: Partial<ModelConfig>): ChatProvider {
  const config = getConfig();
  const modelConfig = { ...config.agents.defaults.model, ...override };
  return createChatProvider(modelConfig, resolveProviderEndpoint(modelConfig, config));
}

/**
 * E25 — Model tier ladder.
 *
 * Returns a ChatProvider configured with the tier-specific model (inheriting
 * sampling/context settings from the default ModelConfig). Returns `null`
 * when no tier model is configured so callers can fall back to the default
 * provider without building a second one.
 *
 * Current wiring:
 *   - "routing"   → reserved; no runtime consumer yet
 *   - "synthesis" → consumed by runtime.forceSynthesis to run the final
 *                   user-facing rewrite on a lighter / faster model
 */
export function getChatProviderForTier(tier: "routing" | "synthesis"): ChatProvider | null {
  const config = getConfig();
  const tierModel = config.agents.defaults.model.tiers?.[tier];
  if (!tierModel) return null;
  return getChatProviderWithOverride({ primary: tierModel });
}

export function getEmbeddingProvider(): LMStudioProvider {
  const config = getConfig();
  const modelConfig = config.agents.defaults.model;
  const endpoint = resolveEmbeddingEndpoint(modelConfig, config);
  const signature = JSON.stringify({ endpoint, embeddingModel: modelConfig.embeddingModel });

  if (_embeddingProvider && _embeddingProviderSignature === signature) return _embeddingProvider;

  _embeddingProviderSignature = signature;
  _embeddingProvider = createSingleProvider(modelConfig, endpoint);
  return _embeddingProvider;
}

export function getLMStudioProvider(): ChatProvider {
  return getChatProvider();
}

export function getLMStudioProviderWithOverride(override: Partial<ModelConfig>): ChatProvider {
  return getChatProviderWithOverride(override);
}

function toSingleEndpointRuntimeStatus(
  endpoint: ResolvedProviderEndpoint,
  snapshot: OpenAICompatibleProviderRuntimeSnapshot,
): ProviderRuntimeEndpointStatus {
  return {
    providerId: endpoint.providerId,
    model: endpoint.model,
    baseUrl: endpoint.baseUrl,
    priority: endpoint.priority,
    active: true,
    healthy: snapshot.healthy,
    available: true,
    circuitState: "closed",
    consecutiveFailures: 0,
    lastError: snapshot.lastError,
    requestTimeoutMs: snapshot.requestTimeoutMs,
    configuredMaxRetries: snapshot.configuredMaxRetries,
    requestCount: snapshot.requestCount,
    successCount: snapshot.successCount,
    failureCount: snapshot.failureCount,
    lastLatencyMs: snapshot.lastLatencyMs,
    averageLatencyMs: snapshot.averageLatencyMs,
    lastUsedAt: snapshot.lastUsedAt,
    lastSuccessAt: snapshot.lastSuccessAt,
    lastFailureAt: snapshot.lastFailureAt,
    lastHealthCheckAt: snapshot.lastHealthCheckAt,
    lastHealthCheckLatencyMs: snapshot.lastHealthCheckLatencyMs,
    loadedModel: snapshot.loadedModel,
  };
}

function updateProviderRuntimeComponent(status: ProviderRuntimeStatusSnapshot): void {
  const activeEndpoint = status.endpoints.find((entry) => entry.active) ?? status.endpoints[0];
  const firstUnhealthy = status.endpoints.find((entry) => !entry.healthy || !entry.available);

  markRuntimeComponentSuccess(
    "providers",
    {
      mode: status.mode,
      provider: status.activeProviderId,
      activeModel: status.activeModel,
      activeBaseUrl: status.activeBaseUrl,
      loadedModel: activeEndpoint?.loadedModel,
      endpoints: status.endpoints,
    },
    status.healthy
      ? undefined
      : {
          healthy: false,
          error: firstUnhealthy?.lastError ?? "Provider health check failed",
        },
  );
}

export async function syncChatProviderRuntimeStatus(): Promise<ProviderRuntimeStatusSnapshot> {
  const config = getConfig();
  const modelConfig = config.agents.defaults.model;
  const endpoint = resolveProviderEndpoint(modelConfig, config);
  const provider = getChatProvider();

  if (provider instanceof FailoverChatProvider) {
    const endpoints = await provider.syncRuntimeStatus();
    const activeEndpoint = endpoints.find((entry) => entry.active) ?? endpoints[0];
    const status: ProviderRuntimeStatusSnapshot = {
      healthy: endpoints.some((entry) => entry.healthy && entry.available),
      mode: "failover",
      activeProviderId: activeEndpoint?.providerId,
      activeModel: activeEndpoint?.model,
      activeBaseUrl: activeEndpoint?.baseUrl,
      endpoints,
    };
    updateProviderRuntimeComponent(status);
    return status;
  }

  if (provider instanceof LMStudioProvider) {
    await provider.checkHealth();
    const endpointSnapshot = toSingleEndpointRuntimeStatus(endpoint, provider.getRuntimeSnapshot());
    const status: ProviderRuntimeStatusSnapshot = {
      healthy: endpointSnapshot.healthy,
      mode: "single",
      activeProviderId: endpointSnapshot.providerId,
      activeModel: endpointSnapshot.model,
      activeBaseUrl: endpointSnapshot.baseUrl,
      endpoints: [endpointSnapshot],
    };
    updateProviderRuntimeComponent(status);
    return status;
  }

  const health = await provider.checkHealth();
  const status: ProviderRuntimeStatusSnapshot = {
    healthy: health.healthy,
    mode: "single",
    activeProviderId: endpoint.providerId,
    activeModel: endpoint.model,
    activeBaseUrl: endpoint.baseUrl,
    endpoints: [{
      providerId: endpoint.providerId,
      model: endpoint.model,
      baseUrl: endpoint.baseUrl,
      priority: endpoint.priority,
      active: true,
      healthy: health.healthy,
      available: true,
      circuitState: "closed",
      consecutiveFailures: 0,
      lastError: health.error,
      loadedModel: health.loadedModel,
    }],
  };
  updateProviderRuntimeComponent(status);
  return status;
}

export type { ChatProvider } from "./lmstudio.js";

export async function initProviders(): Promise<void> {
  markRuntimeComponentAttempt("providers");

  try {
    const config = getConfig();
    const chain = resolveProviderChain(config.agents.defaults.model, config);
    const endpoint = chain[0]!;
    const provider = getChatProvider();
    const health = await provider.checkHealth();
    logAudit("provider_health_check", {
      provider: endpoint.providerId,
      model: endpoint.model,
      chain: chain.map((entry) => ({
        priority: entry.priority,
        provider: entry.providerId,
        model: entry.model,
        baseUrl: entry.baseUrl,
      })),
      ...health,
    }, { severity: health.healthy ? "info" : "warn" });

    if (!health.healthy) {
      log.error(
        { error: health.error, provider: endpoint.providerId, baseUrl: endpoint.baseUrl },
        "Configured OpenAI-compatible model endpoint is not reachable. Start the model server and load the configured model, then restart StarlingAI."
      );
      markRuntimeComponentSuccess("providers", { provider: endpoint.providerId, healthy: false, error: health.error }, {
        healthy: false,
        error: health.error,
      });
      return;
    }

    log.info({ model: health.loadedModel, provider: endpoint.providerId, baseUrl: endpoint.baseUrl }, "Model endpoint connected");

    const modelId = endpoint.model.split("/").slice(1).join("/") || health.loadedModel!;
    const toolsSupported = await provider.verifyToolCallSupport(modelId);

    if (!toolsSupported) {
      log.warn(
        { model: modelId },
        "Model may not support tool/function calling reliably — consider using Qwen3 14B+"
      );
    } else {
      log.info({ model: modelId }, "Tool calling verified OK");
    }

    markRuntimeComponentSuccess("providers", {
      provider: endpoint.providerId,
      providerChain: chain.map((entry) => ({
        priority: entry.priority,
        provider: entry.providerId,
        model: entry.model,
        baseUrl: entry.baseUrl,
      })),
      loadedModel: health.loadedModel,
      configuredModel: modelId,
      toolCallingVerified: toolsSupported,
    });

    // Build semantic agent search index if an embedding model is configured
    const embeddingModel = config.agents.defaults.model.embeddingModel;
    if (embeddingModel) {
      const subAgents = config.subAgents ?? {};
      buildAgentIndex(subAgents, getEmbeddingProvider(), embeddingModel).catch(() => undefined);
    }
  } catch (err) {
    markRuntimeComponentFailure("providers", err);
    throw err;
  }
}

export function resetProvidersForTests(): void {
  _chatProvider = null;
  _chatProviderSignature = null;
  _embeddingProvider = null;
  _embeddingProviderSignature = null;
}
