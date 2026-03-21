import { getConfig } from "../config/loader.js";
import { LMStudioProvider } from "./lmstudio.js";
import { buildAgentIndex } from "./embeddings.js";
import { childLogger } from "../logger.js";
import { markRuntimeComponentAttempt, markRuntimeComponentFailure, markRuntimeComponentSuccess } from "../runtime/status.js";
import { logAudit } from "../audit/logger.js";
import type { ModelConfig } from "../config/schema.js";

const log = childLogger("providers");

let _lmstudio: LMStudioProvider | null = null;
let _lmstudioSignature: string | null = null;
let _embeddingProvider: LMStudioProvider | null = null;
let _embeddingProviderSignature: string | null = null;

function resolveEndpoint(modelConfig: ModelConfig): { baseUrl: string; apiKey: string } {
  const config = getConfig();
  const lmsCfg = config.providers.lmstudio;
  return {
    baseUrl: modelConfig.baseUrl ?? lmsCfg?.baseUrl ?? "http://host.docker.internal:1234/v1",
    apiKey: modelConfig.apiKey ?? lmsCfg?.apiKey ?? "lm-studio",
  };
}

function resolveEmbeddingEndpoint(modelConfig: ModelConfig): { baseUrl: string; apiKey: string } {
  const config = getConfig();
  const lmsCfg = config.providers.lmstudio;
  return {
    baseUrl: modelConfig.embeddingBaseUrl ?? modelConfig.baseUrl ?? lmsCfg?.baseUrl ?? "http://host.docker.internal:1234/v1",
    apiKey: modelConfig.embeddingApiKey ?? modelConfig.apiKey ?? lmsCfg?.apiKey ?? "lm-studio",
  };
}

export function getLMStudioProvider(): LMStudioProvider {
  const config = getConfig();
  const modelConfig = config.agents.defaults.model;
  const { baseUrl, apiKey } = resolveEndpoint(modelConfig);
  const signature = JSON.stringify({ baseUrl, apiKey, modelConfig });

  if (_lmstudio && _lmstudioSignature === signature) return _lmstudio;

  _lmstudioSignature = signature;
  _lmstudio = new LMStudioProvider(baseUrl, apiKey, modelConfig);
  return _lmstudio;
}

/** Create a one-off provider instance with per-turn model config overrides (e.g. enableThinking). */
export function getLMStudioProviderWithOverride(override: Partial<ModelConfig>): LMStudioProvider {
  const config = getConfig();
  const modelConfig = { ...config.agents.defaults.model, ...override };
  const { baseUrl, apiKey } = resolveEndpoint(modelConfig);
  return new LMStudioProvider(baseUrl, apiKey, modelConfig);
}

export function getEmbeddingProvider(): LMStudioProvider {
  const config = getConfig();
  const modelConfig = config.agents.defaults.model;
  const { baseUrl, apiKey } = resolveEmbeddingEndpoint(modelConfig);
  const signature = JSON.stringify({ baseUrl, apiKey, embeddingModel: modelConfig.embeddingModel });

  if (_embeddingProvider && _embeddingProviderSignature === signature) return _embeddingProvider;

  _embeddingProviderSignature = signature;
  _embeddingProvider = new LMStudioProvider(baseUrl, apiKey, modelConfig);
  return _embeddingProvider;
}

export async function initProviders(): Promise<void> {
  markRuntimeComponentAttempt("providers");

  try {
    const provider = getLMStudioProvider();
    const health = await provider.checkHealth();
    logAudit("provider_health_check", { provider: "lmstudio", ...health }, { severity: health.healthy ? "info" : "warn" });

    if (!health.healthy) {
      log.error(
        { error: health.error, baseUrl: resolveEndpoint(getConfig().agents.defaults.model).baseUrl },
        "Configured OpenAI-compatible model endpoint is not reachable. Start the model server and load the configured model, then restart StarlingAI."
      );
      markRuntimeComponentSuccess("providers", { provider: "lmstudio", healthy: false, error: health.error }, {
        healthy: false,
        error: health.error,
      });
      return;
    }

    log.info({ model: health.loadedModel, baseUrl: resolveEndpoint(getConfig().agents.defaults.model).baseUrl }, "Model endpoint connected");

    const config = getConfig();
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
      provider: "lmstudio",
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
  _lmstudio = null;
  _lmstudioSignature = null;
  _embeddingProvider = null;
  _embeddingProviderSignature = null;
}
