import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";
import { type ChatProvider, type LLMMessage, type LLMResponse, type LLMToolDef, type OpenAICompatibleProviderRuntimeSnapshot, type StreamChunk } from "./lmstudio.js";

const log = childLogger("provider:failover");

const CIRCUIT_BREAKER_THRESHOLD = 2;
const CIRCUIT_BREAKER_COOLDOWN_MS = 30_000;
const FAILOVER_BACKOFF_BASE_MS = 150;

export interface FailoverEndpointDescriptor {
  providerId: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  priority: "primary" | "fallback" | "cloudFallback";
}

export interface FailoverProviderBinding {
  endpoint: FailoverEndpointDescriptor;
  provider: ChatProvider;
}

interface BindingState {
  consecutiveFailures: number;
  circuitOpenUntil: number | null;
  lastError?: string;
  lastRecoveryAt?: number;
  /** Consecutive successes seen while the circuit was open (flap-damping). */
  recoverySuccesses?: number;
}

/** Consecutive successes required to clear an open circuit (damps flap-induced thrash). */
const CIRCUIT_RECOVERY_SUCCESSES = 2;

export interface FailoverEndpointRuntimeSnapshot {
  providerId: string;
  model: string;
  baseUrl: string;
  priority: FailoverEndpointDescriptor["priority"];
  active: boolean;
  healthy: boolean;
  available: boolean;
  circuitState: "open" | "closed";
  circuitOpenUntil?: string;
  consecutiveFailures: number;
  lastError?: string;
  requestTimeoutMs?: number;
  configuredMaxRetries?: number;
  requestCount?: number;
  successCount?: number;
  failureCount?: number;
  lastLatencyMs?: number;
  averageLatencyMs?: number;
  lastUsedAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastHealthCheckAt?: string;
  lastHealthCheckLatencyMs?: number;
  loadedModel?: string;
}

function providerKey(endpoint: FailoverEndpointDescriptor): string {
  return `${endpoint.priority}::${endpoint.providerId}::${endpoint.baseUrl}::${endpoint.model}`;
}

function parseModelId(providerModel: string): string {
  const parts = providerModel.split("/");
  return parts.length > 1 ? parts.slice(1).join("/") : providerModel;
}

export function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // Redact API keys that may appear in error messages. Capture the prefix +
  // separator and allow hyphens in the body so MULTI-SEGMENT modern keys
  // (sk-ant-api03-…, sk-ant-oat01-…, sk-proj-…) are covered too — the old
  // [a-zA-Z0-9]{10,} run stopped at the first hyphen and left them un-redacted.
  return raw.replace(/\b(sk|gsk|key)([-_])[A-Za-z0-9-]{6,}/g, "$1$2***");
}

function isTransientProviderError(error: unknown): boolean {
  const text = errorText(error).toLowerCase();
  return [
    "timeout",
    "timed out",
    "econnrefused",
    "econnreset",
    "enotfound",
    "socket hang up",
    "service unavailable",
    "bad gateway",
    "gateway timeout",
    "temporarily unavailable",
    "fetch failed",
    "network error",
    "connection",
    "http 429",
    "http 500",
    "http 502",
    "http 503",
    "http 504",
  ].some((fragment) => text.includes(fragment));
}

export class FailoverChatProvider implements ChatProvider {
  private readonly state = new Map<string, BindingState>();
  private activeBindingKey: string | null = null;

  constructor(private readonly bindings: FailoverProviderBinding[]) {
    for (const binding of bindings) {
      this.state.set(providerKey(binding.endpoint), {
        consecutiveFailures: 0,
        circuitOpenUntil: null,
      });
    }
  }

  async checkHealth(): Promise<{ healthy: boolean; loadedModel?: string; error?: string }> {
    const errors: string[] = [];

    for (const binding of this.bindings) {
      const health = await binding.provider.checkHealth();
      if (health.healthy) {
        return {
          healthy: true,
          loadedModel: health.loadedModel,
        };
      }
      errors.push(`${binding.endpoint.priority}:${binding.endpoint.baseUrl} ${health.error ?? "unhealthy"}`);
    }

    return {
      healthy: false,
      error: errors.join(" | "),
    };
  }

  async verifyToolCallSupport(_modelId: string): Promise<boolean> {
    for (const binding of this.availableBindings()) {
      try {
        const supported = await binding.provider.verifyToolCallSupport(parseModelId(binding.endpoint.model));
        if (supported) return true;
      } catch {
        continue;
      }
    }
    return false;
  }

  async complete(messages: LLMMessage[], tools: LLMToolDef[], signal?: AbortSignal): Promise<LLMResponse> {
    const attempts: string[] = [];
    const candidates = this.availableBindings();

    for (let index = 0; index < candidates.length; index += 1) {
      const binding = candidates[index]!;
      try {
        const response = await binding.provider.complete(messages, tools, signal);
        this.markSuccess(binding, "complete");
        return response;
      } catch (error) {
        const transient = isTransientProviderError(error);
        attempts.push(`${binding.endpoint.priority}:${binding.endpoint.baseUrl} => ${errorText(error)}`);
        this.markFailure(binding, error, transient);

        if (!transient || index === candidates.length - 1 || signal?.aborted) {
          throw error instanceof Error
            ? error
            : new Error(`Provider request failed: ${String(error)}`);
        }

        const next = candidates[index + 1]!;
        this.logFailover(binding, next, error, "complete");
        await new Promise(r => setTimeout(r, FAILOVER_BACKOFF_BASE_MS * Math.pow(2, index)));
      }
    }

    throw new Error(`All configured providers failed: ${attempts.join(" | ")}`);
  }

  async *stream(messages: LLMMessage[], tools: LLMToolDef[], signal?: AbortSignal, options?: { toolChoice?: "auto" | "required" | "none" }): AsyncGenerator<StreamChunk> {
    const candidates = this.availableBindings();
    const attempts: string[] = [];

    for (let index = 0; index < candidates.length; index += 1) {
      const binding = candidates[index]!;
      let emitted = false;

      try {
        for await (const chunk of binding.provider.stream(messages, tools, signal, options)) {
          emitted = true;
          yield chunk;
        }
        this.markSuccess(binding, "stream");
        return;
      } catch (error) {
        const transient = isTransientProviderError(error);
        attempts.push(`${binding.endpoint.priority}:${binding.endpoint.baseUrl} => ${errorText(error)}`);
        this.markFailure(binding, error, transient);

        if (emitted || !transient || index === candidates.length - 1 || signal?.aborted) {
          throw error instanceof Error
            ? error
            : new Error(`Provider stream failed: ${String(error)}`);
        }

        const next = candidates[index + 1]!;
        this.logFailover(binding, next, error, "stream");
        await new Promise(r => setTimeout(r, FAILOVER_BACKOFF_BASE_MS * Math.pow(2, index)));
      }
    }

    throw new Error(`All configured stream providers failed: ${attempts.join(" | ")}`);
  }

  async embed(texts: string[], model: string): Promise<Float32Array[]> {
    // Mirror complete()/stream(): embeddings must use the failover chain too, or a
    // dead primary embed endpoint hard-fails ALL embedding (memory recall, document
    // RAG, tool-rerank, supersession) even when a healthy fallback exists.
    const candidates = this.availableBindings();
    const attempts: string[] = [];

    for (let index = 0; index < candidates.length; index += 1) {
      const binding = candidates[index]!;
      try {
        const vectors = await binding.provider.embed(texts, model);
        this.markSuccess(binding, "embed");
        return vectors;
      } catch (error) {
        const transient = isTransientProviderError(error);
        attempts.push(`${binding.endpoint.priority}:${binding.endpoint.baseUrl} => ${errorText(error)}`);
        this.markFailure(binding, error, transient);

        if (!transient || index === candidates.length - 1) {
          throw error instanceof Error
            ? error
            : new Error(`Provider embed failed: ${String(error)}`);
        }

        const next = candidates[index + 1]!;
        this.logFailover(binding, next, error, "embed");
        await new Promise(r => setTimeout(r, FAILOVER_BACKOFF_BASE_MS * Math.pow(2, index)));
      }
    }

    throw new Error(`All configured embed providers failed: ${attempts.join(" | ")}`);
  }

  isHealthy(): boolean {
    return this.bindings.some((binding) => binding.provider.isHealthy());
  }

  async syncRuntimeStatus(): Promise<FailoverEndpointRuntimeSnapshot[]> {
    for (const binding of this.bindings) {
      try {
        await binding.provider.checkHealth();
      } catch (error) {
        log.warn({ err: error, provider: binding.endpoint.providerId, baseUrl: binding.endpoint.baseUrl }, "Provider health sync failed");
      }
    }

    return this.getRuntimeStatus();
  }

  getRuntimeStatus(): FailoverEndpointRuntimeSnapshot[] {
    const now = Date.now();
    const activeKey = this.activeBindingKey ?? (this.bindings[0] ? providerKey(this.bindings[0].endpoint) : null);

    return this.bindings.map((binding) => {
      const key = providerKey(binding.endpoint);
      const state = this.state.get(key) ?? { consecutiveFailures: 0, circuitOpenUntil: null };
      // Duck-typed: LMStudioProvider and AnthropicProvider both expose the
      // same runtime-snapshot shape; other ChatProviders fall back to isHealthy().
      const snapshotCapable = binding.provider as { getRuntimeSnapshot?: () => OpenAICompatibleProviderRuntimeSnapshot };
      const providerSnapshot: OpenAICompatibleProviderRuntimeSnapshot | undefined =
        typeof snapshotCapable.getRuntimeSnapshot === "function" ? snapshotCapable.getRuntimeSnapshot() : undefined;
      const circuitOpen = Boolean(state.circuitOpenUntil && state.circuitOpenUntil > now);

      return {
        providerId: binding.endpoint.providerId,
        model: binding.endpoint.model,
        baseUrl: binding.endpoint.baseUrl,
        priority: binding.endpoint.priority,
        active: key === activeKey,
        healthy: providerSnapshot?.healthy ?? binding.provider.isHealthy(),
        available: !circuitOpen,
        circuitState: circuitOpen ? "open" : "closed",
        circuitOpenUntil: circuitOpen ? new Date(state.circuitOpenUntil!).toISOString() : undefined,
        consecutiveFailures: state.consecutiveFailures,
        lastError: state.lastError ?? providerSnapshot?.lastError,
        requestTimeoutMs: providerSnapshot?.requestTimeoutMs,
        configuredMaxRetries: providerSnapshot?.configuredMaxRetries,
        requestCount: providerSnapshot?.requestCount,
        successCount: providerSnapshot?.successCount,
        failureCount: providerSnapshot?.failureCount,
        lastLatencyMs: providerSnapshot?.lastLatencyMs,
        averageLatencyMs: providerSnapshot?.averageLatencyMs,
        lastUsedAt: providerSnapshot?.lastUsedAt,
        lastSuccessAt: providerSnapshot?.lastSuccessAt,
        lastFailureAt: providerSnapshot?.lastFailureAt,
        lastHealthCheckAt: providerSnapshot?.lastHealthCheckAt,
        lastHealthCheckLatencyMs: providerSnapshot?.lastHealthCheckLatencyMs,
        loadedModel: providerSnapshot?.loadedModel,
      };
    });
  }

  private availableBindings(): FailoverProviderBinding[] {
    const now = Date.now();
    const available = this.bindings.filter((binding) => {
      const state = this.state.get(providerKey(binding.endpoint));
      return !state?.circuitOpenUntil || state.circuitOpenUntil <= now;
    });
    if (available.length > 0) return available;
    // Total outage — every circuit is open. Rather than sweeping ALL known-dead
    // endpoints (N full-cost trial requests), send a SINGLE half-open probe: the
    // binding whose circuit reopens soonest, tie-broken by declaration order to
    // keep the primary→fallback→cloud cost preference. "All providers failed"
    // then degrades cleanly to synthesis.
    let probe = this.bindings[0];
    let best = Number.POSITIVE_INFINITY;
    for (const binding of this.bindings) {
      const openUntil = this.state.get(providerKey(binding.endpoint))?.circuitOpenUntil ?? 0;
      if (openUntil < best) { best = openUntil; probe = binding; }
    }
    return probe ? [probe] : this.bindings;
  }

  private markFailure(binding: FailoverProviderBinding, error: unknown, transient: boolean): void {
    const key = providerKey(binding.endpoint);
    const existing = this.state.get(key) ?? { consecutiveFailures: 0, circuitOpenUntil: null };
    const nextFailures = transient ? existing.consecutiveFailures + 1 : existing.consecutiveFailures;
    const circuitOpenUntil = transient && nextFailures >= CIRCUIT_BREAKER_THRESHOLD
      ? Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS
      : existing.circuitOpenUntil;

    this.state.set(key, {
      consecutiveFailures: nextFailures,
      circuitOpenUntil,
      lastError: errorText(error),
      lastRecoveryAt: existing.lastRecoveryAt,
    });

    log.warn({
      provider: binding.endpoint.providerId,
      model: binding.endpoint.model,
      baseUrl: binding.endpoint.baseUrl,
      transient,
      circuitOpenUntil,
      err: error,
    }, "Provider endpoint failed");
  }

  private markSuccess(binding: FailoverProviderBinding, operation: "complete" | "stream" | "embed"): void {
    const key = providerKey(binding.endpoint);
    const existing = this.state.get(key);
    this.activeBindingKey = key;

    // Flap damping: a single success on an OPEN circuit no longer instantly clears
    // it (a fail→succeed→fail endpoint would never trip the breaker). Require
    // CIRCUIT_RECOVERY_SUCCESSES consecutive successes before clearing.
    if (existing?.circuitOpenUntil) {
      const recoverySuccesses = (existing.recoverySuccesses ?? 0) + 1;
      if (recoverySuccesses < CIRCUIT_RECOVERY_SUCCESSES) {
        this.state.set(key, { ...existing, recoverySuccesses, lastError: undefined });
        return; // still probationary — don't clear the circuit or emit recovery yet
      }
    }

    const hadFailures = (existing?.consecutiveFailures ?? 0) > 0 || Boolean(existing?.circuitOpenUntil);
    this.state.set(key, {
      consecutiveFailures: 0,
      circuitOpenUntil: null,
      lastError: undefined,
      lastRecoveryAt: Date.now(),
      recoverySuccesses: 0,
    });

    if (hadFailures) {
      logAudit("provider_recovered", {
        provider: binding.endpoint.providerId,
        model: binding.endpoint.model,
        baseUrl: binding.endpoint.baseUrl,
        priority: binding.endpoint.priority,
        operation,
      }, { severity: "info" });
    }
  }

  private logFailover(
    from: FailoverProviderBinding,
    to: FailoverProviderBinding,
    error: unknown,
    operation: "complete" | "stream" | "embed",
  ): void {
    logAudit("provider_failover", {
      operation,
      fromProvider: from.endpoint.providerId,
      fromModel: from.endpoint.model,
      fromBaseUrl: from.endpoint.baseUrl,
      fromPriority: from.endpoint.priority,
      toProvider: to.endpoint.providerId,
      toModel: to.endpoint.model,
      toBaseUrl: to.endpoint.baseUrl,
      toPriority: to.endpoint.priority,
      error: errorText(error),
    }, { severity: "warn" });
  }
}