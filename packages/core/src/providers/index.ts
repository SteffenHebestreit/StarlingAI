import { getConfig } from "../config/loader.js";
import { LMStudioProvider, type ChatProvider } from "./lmstudio.js";
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
  baseUrl: string;
  apiKey: string;
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

export function resolveProviderEndpoint(modelConfig: ModelConfig, config: Config = getConfig()): ResolvedProviderEndpoint {
  const providerId = getProviderId(modelConfig.primary);
  const providerConfig = getNamedOpenAICompatibleProvider(providerId, config);
  return {
    providerId,
    baseUrl: modelConfig.baseUrl ?? providerConfig?.baseUrl ?? config.providers.lmstudio?.baseUrl ?? DEFAULT_OPENAI_BASE_URL,
    apiKey: modelConfig.apiKey ?? providerConfig?.apiKey ?? config.providers.lmstudio?.apiKey ?? DEFAULT_OPENAI_API_KEY,
  };
}

export function resolveProviderEndpointForModel(
  modelName: string,
  overrides: { baseUrl?: string; apiKey?: string } = {},
  config: Config = getConfig(),
): ResolvedProviderEndpoint {
  return resolveProviderEndpoint(
    {
      ...config.agents.defaults.model,
      primary: modelName,
      baseUrl: overrides.baseUrl,
      apiKey: overrides.apiKey,
    },
    config,
  );
}

export function resolveEmbeddingEndpoint(modelConfig: ModelConfig, config: Config = getConfig()): ResolvedProviderEndpoint {
  const providerId = getProviderId(modelConfig.embeddingModel ?? modelConfig.primary);
  const providerConfig = getNamedOpenAICompatibleProvider(providerId, config);
  return {
    providerId,
    baseUrl: modelConfig.embeddingBaseUrl ?? modelConfig.baseUrl ?? providerConfig?.baseUrl ?? config.providers.lmstudio?.baseUrl ?? DEFAULT_OPENAI_BASE_URL,
    apiKey: modelConfig.embeddingApiKey ?? modelConfig.apiKey ?? providerConfig?.apiKey ?? config.providers.lmstudio?.apiKey ?? DEFAULT_OPENAI_API_KEY,
  };
}

export function createChatProvider(modelConfig: ModelConfig, endpoint = resolveProviderEndpoint(modelConfig)): LMStudioProvider {
  return new LMStudioProvider(endpoint.baseUrl, endpoint.apiKey, modelConfig);
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

export function getEmbeddingProvider(): LMStudioProvider {
  const config = getConfig();
  const modelConfig = config.agents.defaults.model;
  const endpoint = resolveEmbeddingEndpoint(modelConfig, config);
  const signature = JSON.stringify({ endpoint, embeddingModel: modelConfig.embeddingModel });

  if (_embeddingProvider && _embeddingProviderSignature === signature) return _embeddingProvider;

  _embeddingProviderSignature = signature;
  _embeddingProvider = createChatProvider(modelConfig, endpoint);
  return _embeddingProvider;
}

export function getLMStudioProvider(): ChatProvider {
  return getChatProvider();
}

export function getLMStudioProviderWithOverride(override: Partial<ModelConfig>): ChatProvider {
  return getChatProviderWithOverride(override);
}

export type { ChatProvider } from "./lmstudio.js";

export async function initProviders(): Promise<void> {
  markRuntimeComponentAttempt("providers");

  try {
    const config = getConfig();
    const endpoint = resolveProviderEndpoint(config.agents.defaults.model, config);
    const provider = getChatProvider();
    const health = await provider.checkHealth();
    logAudit("provider_health_check", { provider: endpoint.providerId, ...health }, { severity: health.healthy ? "info" : "warn" });

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

    const modelId = config.agents.defaults.model.primary.split("/").slice(1).join("/") || health.loadedModel!;
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
