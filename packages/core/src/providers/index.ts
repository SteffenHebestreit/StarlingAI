import { getConfig } from "../config/loader.js";
import { LMStudioProvider, type ChatProvider, type OpenAICompatibleProviderRuntimeSnapshot } from "./lmstudio.js";
import { AnthropicProvider, ANTHROPIC_DEFAULT_BASE_URL } from "./anthropic.js";
import { loadStoredTokenSet, getValidAccessToken, startAnthropicTokenRefresher, anthropicRefreshDisabledReason } from "./anthropic-oauth.js";
import { FailoverChatProvider, type FailoverEndpointDescriptor, type FailoverEndpointRuntimeSnapshot, type FailoverProviderBinding } from "./failover.js";
import { buildAgentIndex } from "./embeddings.js";
import { childLogger } from "../logger.js";
import { markRuntimeComponentAttempt, markRuntimeComponentFailure, markRuntimeComponentSuccess } from "../runtime/status.js";
import { logAudit } from "../audit/logger.js";
import type { Config, ModelConfig, ModelPreset } from "../config/schema.js";
import { wrapProviderWithBoundary } from "./llm-boundary.js";

const log = childLogger("providers");

const DEFAULT_OPENAI_BASE_URL = "http://host.docker.internal:1234/v1";
const DEFAULT_OPENAI_API_KEY = "lm-studio";

/** Resolve `$ENV_VAR` references in provider credentials at endpoint-resolution time. */
function resolveSecretRef(value: string | undefined): string | undefined {
  if (!value) return value;
  if (value.startsWith("$")) return process.env[value.slice(1)] || undefined;
  return value;
}

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
  const id = providerId?.trim() || "lmstudio";
  // Provider-neutral aliases for the PRIMARY OpenAI-compatible slot. It is keyed "lmstudio"
  // internally (so existing lmstudio/<model> ids keep resolving) but can point at any
  // OpenAI-compatible server — Ollama, vLLM, llama.cpp, LocalAI, OpenRouter, … — so a config
  // or model id can read primary/<model> or local/<model> instead of leaking "lmstudio".
  // parseModelId() strips the first segment regardless of its name, so the API still gets
  // the bare model id.
  return id === "primary" || id === "local" ? "lmstudio" : id;
}

function getNamedOpenAICompatibleProvider(providerId: string, config: Config) {
  if (providerId === "lmstudio") return config.providers.lmstudio;
  return config.providers.openaiCompatible?.[providerId];
}

function createSingleProvider(modelConfig: ModelConfig, endpoint: ResolvedProviderEndpoint): ChatProvider {
  if (endpoint.providerId === "anthropic") {
    // Managed-OAuth mode: when the credential is the stored (browser-connected)
    // subscription access token, attach the auto-refresher so this long-lived
    // provider keeps using a fresh token. A manually-pasted authToken in config
    // is static (no refresher) — used verbatim until it expires.
    const stored = loadStoredTokenSet();
    const managedOAuth = stored !== null && endpoint.apiKey === stored.accessToken;
    return new AnthropicProvider(endpoint.baseUrl, endpoint.apiKey, modelConfig, {
      timeoutMs: endpoint.timeoutMs,
      maxRetries: endpoint.maxRetries,
      // Anthropic prompt caching is on by default (robust intra-turn win, no
      // downside); the model config opts out only with an explicit promptCache:false.
      promptCaching: modelConfig.promptCache !== false,
      ...(managedOAuth ? { tokenProvider: getValidAccessToken } : {}),
    });
  }
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

  if (providerId === "anthropic") {
    const anthropic = config.providers.anthropic;
    // Credential precedence: explicit per-model override → browser-connected
    // subscription token (encrypted store) → config authToken → config apiKey.
    // All flow through the single apiKey slot — AnthropicProvider sniffs the
    // sk-ant-oat prefix to pick the auth header mode, so the credential survives
    // failover descriptors and containerized sub-agent payloads unchanged. The
    // stored token is a snapshot here; the in-process provider auto-refreshes it.
    const credential = overrides.apiKey
      ?? resolveSecretRef(anthropic?.authToken)
      ?? loadStoredTokenSet()?.accessToken
      ?? resolveSecretRef(anthropic?.apiKey)
      ?? "";
    return {
      providerId,
      model: providerModel,
      baseUrl: overrides.baseUrl ?? anthropic?.baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL,
      apiKey: credential,
      priority,
      timeoutMs: anthropic?.timeoutMs,
      maxRetries: anthropic?.maxRetries,
    };
  }

  const providerConfig = getNamedOpenAICompatibleProvider(providerId, config);
  return {
    providerId,
    model: providerModel,
    baseUrl: overrides.baseUrl ?? providerConfig?.baseUrl ?? config.providers.lmstudio?.baseUrl ?? DEFAULT_OPENAI_BASE_URL,
    apiKey: resolveSecretRef(overrides.apiKey ?? providerConfig?.apiKey) ?? config.providers.lmstudio?.apiKey ?? DEFAULT_OPENAI_API_KEY,
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

// ─── Model presets (dashboard "Local ⇄ Claude" switch) ───────────────────────
// A preset is a named alternate for the default chat model identity. While a
// preset is active it overrides primary/fallback EVERYWHERE — orchestrator and
// sub-agents alike (including agents with their own model override) — so a
// capability test runs the whole swarm on the preset model. Behavioral config
// (tools, prompts, iteration caps, embeddings) is untouched, and the previous
// primary becomes the fallback so a broken cloud preset degrades back to local.

export interface ModelPresetDescriptor {
  name: string;
  label: string;
  primary: string;
  implicit: boolean;
}

const ANTHROPIC_FALLBACK_DEFAULT_MODEL = "claude-sonnet-4-6";

/** True when Claude is usable: a config credential (apiKey/authToken) OR a
 *  browser-connected subscription token in the encrypted store. */
export function anthropicProviderConfigured(config: Config): boolean {
  const anthropic = config.providers.anthropic;
  if (anthropic && (resolveSecretRef(anthropic.authToken) ?? resolveSecretRef(anthropic.apiKey))) return true;
  return loadStoredTokenSet() !== null;
}

function anthropicDefaultModel(config: Config): string {
  return config.providers.anthropic?.defaultModel ?? ANTHROPIC_FALLBACK_DEFAULT_MODEL;
}

/** All switchable presets: configured `agents.defaults.modelPresets` plus an
 *  implicit "claude" preset whenever Claude is usable (config credential or a
 *  browser-connected subscription token). */
export function listModelPresets(config: Config = getConfig()): ModelPresetDescriptor[] {
  const configured = config.agents.defaults.modelPresets ?? {};
  const presets: ModelPresetDescriptor[] = Object.entries(configured).map(([name, preset]) => ({
    name,
    label: preset.label ?? name,
    primary: preset.primary,
    implicit: false,
  }));
  if (!configured["claude"] && anthropicProviderConfigured(config)) {
    presets.push({
      name: "claude",
      label: "Claude",
      primary: `anthropic/${anthropicDefaultModel(config)}`,
      implicit: true,
    });
  }
  return presets;
}

export function findModelPreset(name: string, config: Config = getConfig()): ModelPreset | null {
  const configured = config.agents.defaults.modelPresets?.[name];
  if (configured) return configured;
  if (name === "claude" && anthropicProviderConfigured(config)) {
    return { label: "Claude", primary: `anthropic/${anthropicDefaultModel(config)}` };
  }
  return null;
}

export function getActiveModelPreset(config: Config = getConfig()): { name: string; preset: ModelPreset } | null {
  const name = config.agents.defaults.activeModelPreset;
  if (!name) return null;
  const preset = findModelPreset(name, config);
  if (!preset) {
    log.warn({ preset: name }, "activeModelPreset references an unknown preset — using the configured default model");
    return null;
  }
  return { name, preset };
}

/** Context for scoping which agents the active preset applies to (agents.defaults.modelPresetScope).
 *  Omitted at the orchestrator / infrastructure sites (they represent the coordinator path and are
 *  always in scope); passed by the sub-agent construction site to scope by role / explicit model. */
export interface PresetScopeContext {
  /** The agent set its OWN model (agentCfg.model.primary) — respected under the "unspecified" scope. */
  hasExplicitModel?: boolean;
  /** The agent's role — under "coordinator_qa" the preset applies only to coordinator/planner/reviewer. */
  role?: string;
}

/** Whether the active preset should replace THIS agent's model under the configured scope. No context
 *  = the orchestrator/infrastructure path (the coordinator), which is always in scope. */
function presetAppliesUnderScope(scope: string, ctx: PresetScopeContext | undefined): boolean {
  switch (scope) {
    case "unspecified":
      // The orchestrator (no ctx) uses the shared default → in scope; a sub-agent that named its own
      // model is out of scope.
      return !ctx?.hasExplicitModel;
    case "coordinator_qa":
      if (!ctx) return true; // the main orchestrator IS the coordinator/planner
      return ctx.role === "coordinator" || ctx.role === "planner" || ctx.role === "reviewer";
    case "all":
    default:
      return true;
  }
}

/** Overlay the active preset (if any) onto a resolved ModelConfig. Applied at
 *  every chat-provider construction site (orchestrator, sub-agents, tiers). */
export function applyActiveModelPreset(modelConfig: ModelConfig, config: Config = getConfig(), scopeCtx?: PresetScopeContext): ModelConfig {
  const active = getActiveModelPreset(config);
  if (!active) return modelConfig;
  if (!presetAppliesUnderScope(config.agents.defaults.modelPresetScope ?? "all", scopeCtx)) return modelConfig;
  const { preset } = active;
  if (modelConfig.primary === preset.primary) return modelConfig;
  return {
    ...modelConfig,
    primary: preset.primary,
    // The replaced model becomes the fallback so an unreachable cloud preset
    // degrades back to the local stack mid-turn via the failover chain.
    fallback: preset.fallback ?? modelConfig.primary,
    cloudFallback: undefined,
    // Per-model endpoint overrides belong to the replaced model — drop them so
    // the preset model resolves against its own provider's config.
    baseUrl: undefined,
    apiKey: undefined,
    ...(preset.maxTokens !== undefined ? { maxTokens: preset.maxTokens } : {}),
    ...(preset.contextWindow !== undefined ? { contextWindow: preset.contextWindow } : {}),
    // Tier-ladder models are tuned for the local stack; bypass while testing a preset.
    tiers: undefined,
  };
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

  const provider = bindings.length === 1
    ? bindings[0]!.provider
    : new FailoverChatProvider(bindings);
  // Extension LLM-boundary transformers (e.g. DSGVO pseudonymization) wrap
  // every provider built here — the single choke point for model traffic.
  return wrapProviderWithBoundary(provider);
}

export function getChatProvider(): ChatProvider {
  const config = getConfig();
  const modelConfig = applyActiveModelPreset(config.agents.defaults.model, config);
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
  const modelConfig = applyActiveModelPreset({ ...config.agents.defaults.model, ...override }, config);
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
 * Callers may pass additional overrides (temperature, maxTokens, etc.) that
 * layer on top of the tier model; the tier's `primary` is still preserved.
 *
 * Current wiring:
 *   - "routing"   → consumed by lightweight classifier-style LLM tool calls
 *   - "synthesis" → consumed by runtime.forceSynthesis to run the final
 *                   user-facing rewrite on a lighter / faster model
 */
export function getChatProviderForTier(
  tier: "routing" | "synthesis",
  override: Partial<ModelConfig> = {},
): ChatProvider | null {
  const config = getConfig();
  // While a model preset is active (dashboard Local ⇄ Claude switch) the tier
  // ladder is bypassed — tier models are tuned for the local stack, and a
  // capability test should run every path on the preset model.
  if (getActiveModelPreset(config)) return null;
  const tierModel = config.agents.defaults.model.tiers?.[tier];
  if (!tierModel) return null;
  return getChatProviderWithOverride({ ...override, primary: tierModel });
}

export function getEmbeddingProvider(): LMStudioProvider {
  const config = getConfig();
  // Embeddings are deliberately NOT affected by the active model preset:
  // Anthropic has no embeddings endpoint, and swapping embedding models would
  // invalidate every stored vector. They always resolve from the configured
  // default model / embeddingModel against an OpenAI-compatible endpoint.
  const modelConfig = config.agents.defaults.model;
  const endpoint = resolveEmbeddingEndpoint(modelConfig, config);
  const signature = JSON.stringify({ endpoint, embeddingModel: modelConfig.embeddingModel });

  if (_embeddingProvider && _embeddingProviderSignature === signature) return _embeddingProvider;

  _embeddingProviderSignature = signature;
  _embeddingProvider = new LMStudioProvider(endpoint.baseUrl, endpoint.apiKey, modelConfig, {
    timeoutMs: endpoint.timeoutMs,
    maxRetries: endpoint.maxRetries,
  });
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
      // Surfaced rather than only logged: once the background refresh disables itself
      // the logs go quiet, and quiet is indistinguishable from healthy unless the state
      // is readable somewhere an operator already looks.
      ...(anthropicRefreshDisabledReason()
        ? { anthropicOAuth: { refreshDisabled: true, reason: anthropicRefreshDisabledReason() } }
        : {}),
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
  const modelConfig = applyActiveModelPreset(config.agents.defaults.model, config);
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

  if (provider instanceof LMStudioProvider || provider instanceof AnthropicProvider) {
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

/**
 * Whether anything on this deployment can actually route to Anthropic.
 *
 * A stored OAuth token is not the test. A deployment that connected Claude once and
 * then moved to a local model still has the credential on disk, and refreshing it
 * accomplishes nothing — which is exactly the state that produced a token-endpoint
 * warning every four minutes with no consumer for the result.
 *
 * Evaluated fresh on each tick rather than latched at startup, so connecting Claude or
 * switching the active preset takes effect without a restart.
 */
export function isAnthropicInUse(config: Config = getConfig()): boolean {
  const anthropic = config.providers?.anthropic;
  if (anthropic?.apiKey || anthropic?.authToken) return true;
  if (process.env["ANTHROPIC_API_KEY"] || process.env["ANTHROPIC_AUTH_TOKEN"]
      || process.env["CLAUDE_CODE_OAUTH_TOKEN"]) return true;

  const usesAnthropic = (model: { primary?: string } | undefined): boolean =>
    typeof model?.primary === "string" && model.primary.startsWith("anthropic/");

  if (usesAnthropic(config.agents?.defaults?.model)) return true;
  if (usesAnthropic(getActiveModelPreset(config)?.preset)) return true;
  return Object.values(config.subAgents ?? {}).some((agent) => usesAnthropic(agent?.model));
}

export async function initProviders(): Promise<void> {
  markRuntimeComponentAttempt("providers");

  // Keep any browser-connected Claude subscription token fresh so sub-agent
  // dispatches (which snapshot the token at resolve time) never get a stale one —
  // but only while Anthropic is actually reachable from some model route, and only
  // until the grant is refused permanently. See isAnthropicInUse.
  startAnthropicTokenRefresher(() => isAnthropicInUse());

  try {
    const config = getConfig();
    const chain = resolveProviderChain(applyActiveModelPreset(config.agents.defaults.model, config), config);
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
