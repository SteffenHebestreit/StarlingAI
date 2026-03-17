import { getConfig } from "../config/loader.js";
import { LMStudioProvider } from "./lmstudio.js";
import { buildAgentIndex } from "./embeddings.js";
import { childLogger } from "../logger.js";
import { markRuntimeComponentAttempt, markRuntimeComponentFailure, markRuntimeComponentSuccess } from "../runtime/status.js";
import { logAudit } from "../audit/logger.js";

const log = childLogger("providers");

let _lmstudio: LMStudioProvider | null = null;
let _lmstudioSignature: string | null = null;

export function getLMStudioProvider(): LMStudioProvider {
  const config = getConfig();
  const lmsCfg = config.providers.lmstudio;
  const baseUrl = lmsCfg?.baseUrl ?? "http://host.docker.internal:1234/v1";
  const apiKey = lmsCfg?.apiKey ?? "lm-studio";
  const modelConfig = config.agents.defaults.model;
  const signature = JSON.stringify({ baseUrl, apiKey, modelConfig });

  if (_lmstudio && _lmstudioSignature === signature) return _lmstudio;

  _lmstudioSignature = signature;
  _lmstudio = new LMStudioProvider(baseUrl, apiKey, modelConfig);
  return _lmstudio;
}

export async function initProviders(): Promise<void> {
  markRuntimeComponentAttempt("providers");

  try {
    const provider = getLMStudioProvider();
    const health = await provider.checkHealth();
    logAudit("provider_health_check", { provider: "lmstudio", ...health }, { severity: health.healthy ? "info" : "warn" });

    if (!health.healthy) {
      log.error(
        { error: health.error },
        "LM Studio is not reachable! Start LM Studio and load a model, then restart StarlingAI."
      );
      markRuntimeComponentSuccess("providers", { provider: "lmstudio", healthy: false, error: health.error }, {
        healthy: false,
        error: health.error,
      });
      return;
    }

    log.info({ model: health.loadedModel }, "LM Studio connected");

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
      buildAgentIndex(subAgents, provider, embeddingModel).catch(() => undefined);
    }
  } catch (err) {
    markRuntimeComponentFailure("providers", err);
    throw err;
  }
}

export function resetProvidersForTests(): void {
  _lmstudio = null;
  _lmstudioSignature = null;
}
