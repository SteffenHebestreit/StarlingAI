/**
 * Anthropic provider — native Messages API (`/v1/messages`) via the official
 * @anthropic-ai/sdk, implementing the same ChatProvider surface as the
 * OpenAI-compatible providers so it slots into the failover chain, the
 * provider activity monitor, and the runtime status dashboards unchanged.
 *
 * Auth supports both Anthropic credential modes:
 *  - API key (`sk-ant-api...`)   → `x-api-key` header (console.anthropic.com, pay-per-use)
 *  - OAuth token (`sk-ant-oat...`) → `Authorization: Bearer` + the
 *    `anthropic-beta: oauth-2025-04-20` header. This is the credential Claude
 *    Code mints with `claude setup-token`, billed against a Claude Pro/Max
 *    subscription rather than API usage.
 * The mode is sniffed from the credential prefix so a single string can flow
 * through the existing endpoint/failover/container plumbing (which only
 * carries `apiKey`).
 *
 * Intentional omissions:
 *  - `temperature`/`top_p`/`top_k` are never sent — they are removed on the
 *    newest Opus-tier models (400) and Claude's defaults are correct.
 *  - Extended thinking is never requested: the internal LLMMessage history
 *    cannot round-trip thinking blocks, which the API requires ahead of
 *    tool_use continuations. `enableThinking` is therefore ignored here.
 *  - `embed()` throws — Anthropic has no embeddings endpoint; embeddings stay
 *    on the local/OpenAI-compatible provider (see resolveEmbeddingEndpoint).
 */

import Anthropic from "@anthropic-ai/sdk";
import { childLogger } from "../logger.js";
import type { ModelConfig } from "../config/schema.js";
import {
  computeOpenAICompatibleRequestTimeoutMs,
  computeOutputTokenBudget,
  estimatePromptTokensForRequest,
  isDeadlineAbort,
  MAX_STREAM_TOTAL_MS,
  PROMPT_ESTIMATE_CHARS_PER_TOKEN,
  ProviderHardTimeoutError,
  salvageToolCallArguments,
  type ChatProvider,
  type LLMMessage,
  type LLMResponse,
  type LLMToolDef,
  type OpenAICompatibleProviderRuntimeSnapshot,
  type StreamChunk,
} from "./lmstudio.js";
import { beginProviderCall, recordProviderToken, endProviderCall } from "../observability/provider-activity-monitor.js";
import { logAudit } from "../audit/logger.js";

const log = childLogger("provider:anthropic");

export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";

/**
 * Curated current-model choices for the dashboard picker. Static on purpose:
 * subscription OAuth tokens are inference-scoped and may not be allowed to
 * call /v1/models, so a live listing can't be relied on. The dashboard also
 * accepts a free-text model id for anything not listed here.
 */
export const ANTHROPIC_MODEL_CHOICES: ReadonlyArray<{ id: string; label: string; hint: string }> = [
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", hint: "Best speed/intelligence balance (default)" },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8", hint: "Most capable Opus — long-horizon agentic work" },
  { id: "claude-fable-5", label: "Claude Fable 5", hint: "Most powerful tier — highest cost" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", hint: "Fastest and most cost-effective" },
];
/**
 * Anthropic's REAL per-model output ceiling.
 *
 * On the OpenAI-compatible wire max_tokens is only a slice of the shared context
 * window, so the derived budget can safely be "whatever the window has left".
 * The Messages API is different: it rejects (400 invalid_request_error) a request
 * whose max_tokens exceeds the model's own output limit, so the derived budget
 * must be clamped by this as well as by the window.
 *
 * Longest matching prefix wins, so a dated/suffixed id resolves to its family.
 * An id that matches nothing falls back to ANTHROPIC_FALLBACK_MAX_OUTPUT_TOKENS:
 * under-asking truncates one answer, over-asking fails the request outright, so
 * the unknown case biases low (declare `maxTokens` in config to raise it for a
 * model not listed here). Exported for tests.
 */
export const ANTHROPIC_MODEL_OUTPUT_LIMITS: ReadonlyArray<{ prefix: string; maxOutputTokens: number }> = [
  { prefix: "claude-fable-5", maxOutputTokens: 128_000 },
  { prefix: "claude-mythos-5", maxOutputTokens: 128_000 },
  { prefix: "claude-opus-5", maxOutputTokens: 128_000 },
  { prefix: "claude-sonnet-5", maxOutputTokens: 128_000 },
  { prefix: "claude-opus-4-8", maxOutputTokens: 128_000 },
  { prefix: "claude-opus-4-7", maxOutputTokens: 128_000 },
  { prefix: "claude-opus-4-6", maxOutputTokens: 128_000 },
  { prefix: "claude-sonnet-4-6", maxOutputTokens: 128_000 },
  { prefix: "claude-opus-4-5", maxOutputTokens: 64_000 },
  { prefix: "claude-sonnet-4-5", maxOutputTokens: 64_000 },
  { prefix: "claude-sonnet-4-0", maxOutputTokens: 64_000 },
  { prefix: "claude-haiku-4-5", maxOutputTokens: 64_000 },
  { prefix: "claude-opus-4-1", maxOutputTokens: 32_000 },
  { prefix: "claude-opus-4-0", maxOutputTokens: 32_000 },
];
/** Conservative ceiling for a model id this build has never heard of. */
export const ANTHROPIC_FALLBACK_MAX_OUTPUT_TOKENS = 8_192;

/**
 * Extra ceiling for the NON-STREAMING path only.
 *
 * The Messages API refuses a non-streaming request whose max_tokens implies a
 * generation past its ~10-minute single-request cap ("… is the maximum allowed
 * number of output tokens for <model> with non-streaming requests. Please
 * consider streaming…"), and this provider's own complete() hard timeout is 10
 * minutes as well — so a budget derived from the whole context window would turn
 * an unreachable ceiling into a hard 400. The streaming paths
 * (stream/completeViaStream) carry the full derived budget; only the one-shot
 * complete() is clamped, and even clamped it is 4x the 4096 it used to send.
 */
export const ANTHROPIC_NONSTREAMING_MAX_OUTPUT_TOKENS = 16_384;

/** The output ceiling Anthropic itself enforces for `modelId`. Exported for tests. */
export function resolveAnthropicMaxOutputTokens(modelId: string): number {
  let best: { prefix: string; maxOutputTokens: number } | undefined;
  for (const entry of ANTHROPIC_MODEL_OUTPUT_LIMITS) {
    if (!modelId.startsWith(entry.prefix)) continue;
    if (!best || entry.prefix.length > best.prefix.length) best = entry;
  }
  return best?.maxOutputTokens ?? ANTHROPIC_FALLBACK_MAX_OUTPUT_TOKENS;
}

const OAUTH_BETA_HEADER = "oauth-2025-04-20";
/**
 * Subscription OAuth tokens are scoped to Claude Code, and the Messages API
 * rejects them unless the request presents as Claude Code — the first system
 * block must be this identity. We inject it as the FIRST block and append the
 * agent's real system prompt after it, so behaviour is driven by the real
 * prompt while the gate is satisfied. Only used in OAuth mode.
 */
const CLAUDE_CODE_SYSTEM_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

/** Claude Code / `ant auth` OAuth tokens are prefixed `sk-ant-oat...`; API keys `sk-ant-api...`. */
export function isAnthropicOAuthCredential(credential: string): boolean {
  return credential.startsWith("sk-ant-oat");
}

interface AnthropicProviderOptions {
  timeoutMs?: number;
  maxRetries?: number;
  /**
   * Managed-OAuth mode: returns a fresh (auto-refreshed) access token. When
   * set, the token is injected as a per-request `Authorization` header so a
   * long-lived provider instance always authenticates with a current token,
   * even after the constructor's snapshot has expired.
   */
  tokenProvider?: () => Promise<string | null>;
  /**
   * Anthropic prompt caching: place a `cache_control: ephemeral` breakpoint on
   * the (stable, large) system prompt and tool catalog so the API reuses a
   * cached prefill instead of re-billing/re-prefilling it on every tool-call
   * round-trip. Within a single agentic turn the system+tools prefix is
   * identical across every inner LLM call, so the first call writes the cache
   * (1.25× input) and each subsequent call reads it (0.1× input) — a large
   * cost and latency win on multi-step turns. Defaults ON (Anthropic always
   * supports caching and prefixes below the cache minimum are silently
   * uncached, so there's no downside); the construction site disables it only
   * when the model config sets `promptCache: false`.
   */
  promptCaching?: boolean;
}

function parseModelId(providerModel: string): string {
  // "anthropic/claude-sonnet-4-6" → "claude-sonnet-4-6"
  const parts = providerModel.split("/");
  return parts.length > 1 ? parts.slice(1).join("/") : providerModel;
}

function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function mapStopReason(stopReason: string | null | undefined): string {
  switch (stopReason) {
    case "end_turn": return "stop";
    case "tool_use": return "tool_calls";
    case "max_tokens": return "length";
    case null:
    case undefined: return "stop";
    default: return stopReason;
  }
}

/**
 * Translate the internal OpenAI-shaped LLMMessage history into the Anthropic
 * Messages API shape: leading system messages become the `system` parameter,
 * assistant tool_calls become tool_use blocks, tool results become
 * tool_result blocks grouped into user turns. Exported for tests.
 */
export function toAnthropicMessages(messages: readonly LLMMessage[]): {
  system?: string;
  messages: Anthropic.Messages.MessageParam[];
} {
  const systemParts: string[] = [];
  let index = 0;
  while (index < messages.length && messages[index]!.role === "system") {
    const content = messages[index]!.content;
    if (typeof content === "string" && content.trim()) systemParts.push(content);
    index += 1;
  }

  const out: Anthropic.Messages.MessageParam[] = [];
  const pushToolResult = (block: Anthropic.Messages.ToolResultBlockParam) => {
    const last = out[out.length - 1];
    if (last && last.role === "user" && Array.isArray(last.content)) {
      (last.content as Anthropic.Messages.ContentBlockParam[]).push(block);
      return;
    }
    out.push({ role: "user", content: [block] });
  };

  for (const message of messages.slice(index)) {
    switch (message.role) {
      case "system": {
        // Mid-conversation system text: deliver as user-turn context — the
        // top-level system parameter only covers the conversation head.
        const text = typeof message.content === "string" ? message.content : "";
        if (text.trim()) out.push({ role: "user", content: text });
        break;
      }
      case "user": {
        const text = typeof message.content === "string" && message.content.length > 0 ? message.content : " ";
        out.push({ role: "user", content: text });
        break;
      }
      case "assistant": {
        const blocks: Anthropic.Messages.ContentBlockParam[] = [];
        if (typeof message.content === "string" && message.content.trim()) {
          blocks.push({ type: "text", text: message.content });
        }
        for (const toolCall of message.tool_calls ?? []) {
          blocks.push({
            type: "tool_use",
            id: toolCall.id,
            name: toolCall.function.name,
            input: parseToolArguments(toolCall.function.arguments),
          });
        }
        if (blocks.length > 0) out.push({ role: "assistant", content: blocks });
        break;
      }
      case "tool": {
        pushToolResult({
          type: "tool_result",
          tool_use_id: message.tool_call_id ?? "",
          content: typeof message.content === "string" ? message.content : "",
        });
        break;
      }
    }
  }

  // The API requires the first message to be a user turn.
  if (out.length === 0 || out[0]!.role !== "user") {
    out.unshift({ role: "user", content: "(continuing session)" });
  }

  const pairing = enforceToolResultPairing(out);
  if (pairing.synthesizedResultIds.length > 0 || pairing.orphanedResultIds.length > 0) {
    log.warn(
      {
        synthesizedResultIds: pairing.synthesizedResultIds,
        orphanedResultIds: pairing.orphanedResultIds,
        messageCount: out.length,
      },
      "Repaired tool_use/tool_result pairing before Anthropic request — upstream history dropped or misplaced tool results",
    );
    logAudit("tool_call_recovered", {
      type: "anthropic_history_repaired",
      synthesizedResultIds: pairing.synthesizedResultIds,
      orphanedResultIds: pairing.orphanedResultIds,
      messageCount: out.length,
    }, { severity: "warn" });
  }

  return {
    ...(systemParts.length > 0 ? { system: systemParts.join("\n\n") } : {}),
    messages: pairing.messages,
  };
}

function toolUseIdsOf(message: Anthropic.Messages.MessageParam): string[] {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content
    .filter((block): block is Anthropic.Messages.ToolUseBlockParam => block.type === "tool_use")
    .map((block) => block.id);
}

/**
 * The Messages API hard-rejects (400 invalid_request_error) any request where
 * an assistant `tool_use` block is not answered by a matching `tool_result`
 * block in the IMMEDIATELY following user message, or where a `tool_result`
 * references an id with no preceding `tool_use`. The internal history is
 * assembled by many mutators (evidence filters, mid-batch aborts, compaction)
 * and the lenient OpenAI-style providers never enforced this invariant, so a
 * latent producer bug surfaces here as a fatal rejection that kills the whole
 * sub-agent run (audit f0143008: one dropped read_shared_facts result 400'd
 * two research delegations). Repair instead of failing: re-home recorded
 * results to the message right after their tool_use, synthesize an error
 * result for ids with no recorded result, and downgrade orphaned results to
 * plain text. Exported for tests.
 */
export function enforceToolResultPairing(messages: Anthropic.Messages.MessageParam[]): {
  messages: Anthropic.Messages.MessageParam[];
  synthesizedResultIds: string[];
  orphanedResultIds: string[];
} {
  // Fast path: leave well-formed histories (the overwhelming majority) untouched.
  let valid = true;
  for (let i = 0; i < messages.length && valid; i += 1) {
    const message = messages[i]!;
    const useIds = toolUseIdsOf(message);
    if (useIds.length > 0) {
      const next = messages[i + 1];
      const nextResultIds = new Set(
        next && next.role === "user" && Array.isArray(next.content)
          ? next.content.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id)
          : [],
      );
      if (!useIds.every((id) => nextResultIds.has(id))) valid = false;
    }
    if (message.role === "user" && Array.isArray(message.content)) {
      const prevUseIds = new Set(i > 0 ? toolUseIdsOf(messages[i - 1]!) : []);
      for (const block of message.content) {
        if (block.type === "tool_result" && !prevUseIds.has(block.tool_use_id)) valid = false;
      }
    }
  }
  if (valid) return { messages, synthesizedResultIds: [], orphanedResultIds: [] };

  // Collect every recorded result (first occurrence wins) so it can be
  // re-homed next to the assistant message that owns its tool_use id.
  const resultById = new Map<string, Anthropic.Messages.ToolResultBlockParam>();
  for (const message of messages) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "tool_result" && !resultById.has(block.tool_use_id)) {
        resultById.set(block.tool_use_id, block);
      }
    }
  }

  const repaired: Anthropic.Messages.MessageParam[] = [];
  const synthesizedResultIds: string[] = [];
  const orphanedResultIds: string[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      repaired.push(message);
      const useIds = toolUseIdsOf(message);
      if (useIds.length > 0) {
        const blocks = useIds.map((id): Anthropic.Messages.ToolResultBlockParam => {
          const recorded = resultById.get(id);
          if (recorded) {
            resultById.delete(id);
            return recorded;
          }
          synthesizedResultIds.push(id);
          return {
            type: "tool_result",
            tool_use_id: id,
            content: "[tool result was not recorded for this call]",
            is_error: true,
          };
        });
        repaired.push({ role: "user", content: blocks });
      }
      continue;
    }
    if (!Array.isArray(message.content)) {
      repaired.push(message);
      continue;
    }
    // User message: claimed tool_results were re-homed above — drop them here.
    // Unclaimed ones reference no tool_use (orphans); keep their content as
    // plain text so the information survives without violating the protocol.
    const rest: Anthropic.Messages.ContentBlockParam[] = [];
    for (const block of message.content) {
      if (block.type !== "tool_result") {
        rest.push(block);
        continue;
      }
      if (resultById.get(block.tool_use_id) === block) {
        resultById.delete(block.tool_use_id);
        orphanedResultIds.push(block.tool_use_id);
        const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
        if (text.trim()) rest.push({ type: "text", text: `[tool result]\n${text}` });
      }
    }
    if (rest.length > 0) repaired.push({ role: "user", content: rest });
  }

  return { messages: repaired, synthesizedResultIds, orphanedResultIds };
}

function toAnthropicTools(tools: LLMToolDef[]): Anthropic.Messages.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters as Anthropic.Messages.Tool.InputSchema,
  }));
}

function toAnthropicToolChoice(
  toolChoice: "auto" | "required" | "none" | undefined,
): Anthropic.Messages.ToolChoice {
  switch (toolChoice) {
    case "required": return { type: "any" };
    case "none": return { type: "none" };
    default: return { type: "auto" };
  }
}

export class AnthropicProvider implements ChatProvider {
  private client: Anthropic;
  private modelConfig: ModelConfig;
  private baseUrl: string;
  private oauthMode: boolean;
  private tokenProvider?: () => Promise<string | null>;
  private promptCaching: boolean;
  private healthy = false;
  private lastHealthCheck = 0;
  private configuredMaxRetries: number;
  private requestTimeoutMs: number;
  private loadedModel?: string;
  private lastError?: string;
  private requestCount = 0;
  private successCount = 0;
  private failureCount = 0;
  private latencyTotalMs = 0;
  private latencySamples = 0;
  private lastLatencyMs?: number;
  private lastUsedAt?: string;
  private lastSuccessAt?: string;
  private lastFailureAt?: string;
  private lastHealthCheckLatencyMs?: number;

  constructor(baseUrl: string, credential: string, modelConfig: ModelConfig, options: AnthropicProviderOptions = {}) {
    this.baseUrl = baseUrl || ANTHROPIC_DEFAULT_BASE_URL;
    this.modelConfig = modelConfig;
    this.tokenProvider = options.tokenProvider;
    // OAuth mode if the credential is an oat token OR a refresher is attached
    // (managed mode, where the snapshot may briefly be empty before first fetch).
    this.oauthMode = isAnthropicOAuthCredential(credential) || Boolean(options.tokenProvider);
    this.promptCaching = options.promptCaching ?? true;
    this.configuredMaxRetries = Math.max(0, options.maxRetries ?? 1);
    this.requestTimeoutMs = computeOpenAICompatibleRequestTimeoutMs(modelConfig, options.timeoutMs ?? 120_000);
    // Pass the unused credential slot as null so the SDK does not pick up a
    // conflicting ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN from the
    // environment (sending both headers is rejected by the API).
    this.client = new Anthropic({
      baseURL: this.baseUrl,
      apiKey: this.oauthMode ? null : credential,
      authToken: this.oauthMode ? credential : null,
      timeout: this.requestTimeoutMs,
      maxRetries: 0, // retries handled manually, mirroring LMStudioProvider
      ...(this.oauthMode ? { defaultHeaders: { "anthropic-beta": OAUTH_BETA_HEADER } } : {}),
    });
  }

  /** True when authenticating with a Claude subscription OAuth token rather than an API key. */
  isOAuthMode(): boolean {
    return this.oauthMode;
  }

  async checkHealth(): Promise<{ healthy: boolean; loadedModel?: string; error?: string }> {
    const startedAt = Date.now();
    const modelId = parseModelId(this.modelConfig.primary);
    try {
      if (this.tokenProvider) {
        // Subscription OAuth tokens are inference-scoped and may not permit
        // models.list — treat "a fresh token is obtainable" as healthy and
        // defer real failures (auth/scope) to the first inference call.
        const token = await this.tokenProvider();
        if (!token) throw new Error("No Anthropic OAuth token available — reconnect the Claude subscription");
      } else {
        await Promise.race([
          this.client.models.list({ limit: 1 }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Health check timeout")), 5000)),
        ]);
      }
      this.healthy = true;
      this.lastHealthCheck = Date.now();
      this.lastHealthCheckLatencyMs = this.lastHealthCheck - startedAt;
      this.loadedModel = modelId;
      this.lastError = undefined;
      return { healthy: true, loadedModel: modelId };
    } catch (err) {
      this.healthy = false;
      this.lastHealthCheck = Date.now();
      this.lastHealthCheckLatencyMs = this.lastHealthCheck - startedAt;
      this.lastError = String(err);
      return { healthy: false, error: String(err) };
    }
  }

  getRuntimeSnapshot(): OpenAICompatibleProviderRuntimeSnapshot {
    return {
      baseUrl: this.baseUrl,
      healthy: this.healthy,
      loadedModel: this.loadedModel,
      lastError: this.lastError,
      requestTimeoutMs: this.requestTimeoutMs,
      configuredMaxRetries: this.configuredMaxRetries,
      requestCount: this.requestCount,
      successCount: this.successCount,
      failureCount: this.failureCount,
      lastLatencyMs: this.lastLatencyMs,
      averageLatencyMs: this.latencySamples > 0 ? Math.round(this.latencyTotalMs / this.latencySamples) : undefined,
      lastUsedAt: this.lastUsedAt,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
      lastHealthCheckAt: this.lastHealthCheck > 0 ? new Date(this.lastHealthCheck).toISOString() : undefined,
      lastHealthCheckLatencyMs: this.lastHealthCheckLatencyMs,
    };
  }

  private recordRequestSuccess(startedAt: number): void {
    const finishedAt = Date.now();
    const latencyMs = finishedAt - startedAt;
    this.requestCount += 1;
    this.successCount += 1;
    this.lastLatencyMs = latencyMs;
    this.latencyTotalMs += latencyMs;
    this.latencySamples += 1;
    this.lastUsedAt = new Date(finishedAt).toISOString();
    this.lastSuccessAt = this.lastUsedAt;
    this.lastError = undefined;
    this.healthy = true;
    this.lastHealthCheck = finishedAt;
  }

  private recordRequestFailure(startedAt: number, error: unknown): void {
    const finishedAt = Date.now();
    this.requestCount += 1;
    this.failureCount += 1;
    this.lastLatencyMs = finishedAt - startedAt;
    this.lastUsedAt = new Date(finishedAt).toISOString();
    this.lastFailureAt = this.lastUsedAt;
    this.lastError = error instanceof Error ? error.message : String(error);
  }

  // Same wall-clock guard as LMStudioProvider: the SDK timeout has been seen
  // not to fire when a connection is held open without data, so every attempt
  // gets a setTimeout-based abort we control. Hard timeouts are terminal.
  private async withHardTimeout<T>(
    parentSignal: AbortSignal | undefined,
    timeoutMs: number,
    fn: (combinedSignal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const ac = new AbortController();
    let parentListener: (() => void) | undefined;
    let timedOut = false;

    if (parentSignal?.aborted) {
      ac.abort(parentSignal.reason);
    } else if (parentSignal) {
      parentListener = () => ac.abort(parentSignal.reason);
      parentSignal.addEventListener("abort", parentListener, { once: true });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort(new Error(`LLM call exceeded hard timeout of ${timeoutMs}ms`));
    }, timeoutMs);

    try {
      return await fn(ac.signal);
    } catch (err) {
      if (timedOut && !parentSignal?.aborted) throw new ProviderHardTimeoutError(timeoutMs);
      throw err;
    } finally {
      clearTimeout(timer);
      if (parentListener && parentSignal) parentSignal.removeEventListener("abort", parentListener);
    }
  }

  async verifyToolCallSupport(_modelId: string): Promise<boolean> {
    // Every current Claude model supports tool use natively — skip the paid probe call.
    return true;
  }

  /**
   * Per-request completion budget, derived the same way the OpenAI-compatible
   * providers derive theirs: what the context window has left after the prompt,
   * minus a reserve — then clamped by the model's real output ceiling.
   *
   * The previous `modelConfig.maxTokens ?? 4096` turned into a silent 4x CUT the
   * moment the per-agent maxTokens pins were removed: no preset in the repo
   * declares one, so every agent resolved to `undefined` and every Claude call
   * was pinned at 4096 — below the 16384 the builder agents used to carry, on
   * exactly the agents whose shard comments recorded truncation audits.
   *
   * A declared maxTokens is still honoured, but only as a CEILING on top of the
   * derived budget (the contract computeOutputTokenBudget already implements).
   *
   * The window used is the CONFIGURED one, not Claude's own (which is far larger
   * on current models). That is deliberate: one ModelConfig is shared across every
   * endpoint of a failover chain, so the configured window is the number the
   * session trimmer also budgets against. It under-uses Claude rather than
   * over-committing, and the model ceiling above is what actually keeps the
   * request legal.
   */
  private resolveMaxTokens(
    messages: readonly LLMMessage[],
    tools: readonly LLMToolDef[],
    mode: "complete" | "stream",
  ): number {
    const ceilings = [resolveAnthropicMaxOutputTokens(parseModelId(this.modelConfig.primary))];
    if (mode === "complete") ceilings.push(ANTHROPIC_NONSTREAMING_MAX_OUTPUT_TOKENS);
    if (this.modelConfig.maxTokens !== undefined) ceilings.push(this.modelConfig.maxTokens);
    return computeOutputTokenBudget({
      contextWindow: this.modelConfig.contextWindow,
      estimatedPromptTokens: estimatePromptTokensForRequest(messages, tools),
      declaredMaxTokens: Math.min(...ceilings),
    });
  }

  private buildRequestBase(
    messages: LLMMessage[],
    tools: LLMToolDef[],
    mode: "complete" | "stream",
    toolChoice?: "auto" | "required" | "none",
  ) {
    const modelId = parseModelId(this.modelConfig.primary);
    const { system, messages: anthropicMessages } = toAnthropicMessages(messages);
    let anthropicTools = toAnthropicTools(tools);

    const cacheBreakpoint = { type: "ephemeral" as const };

    // Cache the (large, stable) tool catalog: a breakpoint on the last tool
    // caches all tool definitions. Kept as its own segment — separate from the
    // system breakpoint below — so the catalog still hits even when the system
    // prompt carries per-turn content that would invalidate a combined prefix.
    if (this.promptCaching && anthropicTools.length > 0) {
      const lastIdx = anthropicTools.length - 1;
      anthropicTools = anthropicTools.map((tool, i) =>
        i === lastIdx ? { ...tool, cache_control: cacheBreakpoint } : tool,
      );
    }

    // In OAuth (subscription) mode the Messages API requires the request to
    // present as Claude Code: first system block is the identity, the agent's
    // real system prompt follows. In API-key mode the plain string is sent
    // (promoted to a one-element block array when caching, to carry the
    // breakpoint).
    let systemParam: string | Anthropic.Messages.TextBlockParam[] | undefined;
    if (this.oauthMode) {
      systemParam = [
        { type: "text", text: CLAUDE_CODE_SYSTEM_IDENTITY },
        ...(system ? [{ type: "text", text: system } as Anthropic.Messages.TextBlockParam] : []),
      ];
    } else if (system) {
      systemParam = this.promptCaching ? [{ type: "text", text: system }] : system;
    }

    // Cache the system prompt: a breakpoint on the last system block caches the
    // whole prefill up to it (tools + system, in Anthropic's canonical order).
    if (this.promptCaching && Array.isArray(systemParam) && systemParam.length > 0) {
      const lastIdx = systemParam.length - 1;
      systemParam = systemParam.map((block, i) =>
        i === lastIdx ? { ...block, cache_control: cacheBreakpoint } : block,
      );
    }

    return {
      modelId,
      params: {
        model: modelId,
        max_tokens: this.resolveMaxTokens(messages, tools, mode),
        ...(systemParam ? { system: systemParam } : {}),
        messages: anthropicMessages,
        ...(anthropicTools.length > 0
          ? { tools: anthropicTools, tool_choice: toAnthropicToolChoice(toolChoice) }
          : {}),
      },
    };
  }

  /**
   * Per-request options. In managed-OAuth mode this fetches a fresh
   * (auto-refreshed) access token and overrides the Authorization header so the
   * long-lived client never authenticates with an expired snapshot.
   */
  private async requestOptions(signal: AbortSignal): Promise<{ signal: AbortSignal; headers?: Record<string, string> }> {
    if (!this.tokenProvider) return { signal };
    const token = await this.tokenProvider();
    if (!token) return { signal };
    return { signal, headers: { Authorization: `Bearer ${token}` } };
  }

  /** Parse a Retry-After header (integer seconds OR HTTP-date) into ms, or null. */
  private parseRetryAfterMs(err: { headers?: unknown }): number | null {
    const headers = err.headers;
    let raw: string | undefined;
    if (headers && typeof (headers as Headers).get === "function") {
      raw = (headers as Headers).get("retry-after") ?? undefined; // Web Headers
    } else if (headers && typeof headers === "object") {
      const rec = headers as Record<string, string>;
      raw = rec["retry-after"] ?? rec["Retry-After"];
    }
    raw = raw?.trim();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) return parseInt(raw, 10) * 1000;
    const when = Date.parse(raw);
    return Number.isNaN(when) ? null : Math.max(0, when - Date.now());
  }

  /**
   * Backoff for a retryable provider error: honor server-directed Retry-After on
   * 429/529, else exponential 2s·2^attempt — both clamped to [0, 60s] with ±20%
   * jitter so concurrent sub-agents don't form a synchronized retry storm.
   */
  private retryDelayForError(err: unknown, attempt: number): number {
    let baseMs = 2000 * Math.pow(2, attempt);
    if (err instanceof Anthropic.APIError && (err.status === 429 || err.status === 529)) {
      const ra = this.parseRetryAfterMs(err);
      if (ra !== null) baseMs = ra;
    }
    baseMs = Math.min(Math.max(baseMs, 0), 60_000);
    const jitter = baseMs * 0.2 * (Math.random() * 2 - 1);
    return Math.max(0, Math.round(baseMs + jitter));
  }

  /** Terminal errors that must not be retried (hard timeout, non-429 4xx). */
  private isRetryableProviderError(err: unknown): boolean {
    if (err instanceof ProviderHardTimeoutError) return false;
    if (err instanceof Anthropic.APIError && err.status !== undefined && err.status < 500 && err.status !== 429) return false;
    return true;
  }

  async complete(messages: LLMMessage[], tools: LLMToolDef[], signal?: AbortSignal): Promise<LLMResponse> {
    const { modelId, params } = this.buildRequestBase(messages, tools, "complete");

    let attempt = 0;
    const maxAttempts = this.configuredMaxRetries + 1;

    while (attempt < maxAttempts) {
      const startedAt = Date.now();
      const callId = beginProviderCall({ model: modelId, mode: "complete" });
      try {
        const response = await this.withHardTimeout(signal, this.requestTimeoutMs + 5000, async (s) =>
          this.client.messages.create(params, await this.requestOptions(s)),
        );
        endProviderCall(callId);

        let content = "";
        const toolCalls: LLMResponse["tool_calls"] = [];
        for (const block of response.content) {
          if (block.type === "text") content += block.text;
          else if (block.type === "tool_use") {
            toolCalls.push({
              id: block.id,
              name: block.name,
              arguments: (block.input ?? {}) as Record<string, unknown>,
            });
          }
        }

        this.recordRequestSuccess(startedAt);

        const usage = response.usage;
        const promptTokens = (usage.input_tokens ?? 0)
          + (usage.cache_read_input_tokens ?? 0)
          + (usage.cache_creation_input_tokens ?? 0);
        return {
          content: content.trim().length > 0 ? content : null,
          tool_calls: toolCalls,
          usage: {
            promptTokens,
            completionTokens: usage.output_tokens ?? 0,
            totalTokens: promptTokens + (usage.output_tokens ?? 0),
          },
          finishReason: mapStopReason(response.stop_reason),
          // Mirrors the OpenAI-compatible complete(): "length" alone is ambiguous
          // downstream, so state that the OUTPUT BUDGET is what cut this response.
          ...(response.stop_reason === "max_tokens" ? { truncatedBy: "output_budget" as const } : {}),
        };
      } catch (err: unknown) {
        endProviderCall(callId);
        this.recordRequestFailure(startedAt, err);
        if (err instanceof ProviderHardTimeoutError) {
          log.error({ attempt, timeoutMs: err.timeoutMs, model: modelId }, "Anthropic completion hit hard timeout — not retrying");
          throw err;
        }
        // Non-retryable API errors: auth, invalid request, permissions.
        if (err instanceof Anthropic.APIError && err.status !== undefined && err.status < 500 && err.status !== 429) {
          log.error({ status: err.status, model: modelId, error: err.message }, "Anthropic request rejected");
          throw new Error(`Anthropic request failed (model: ${modelId}, status: ${err.status}): ${err.message}`);
        }
        attempt++;
        if (signal?.aborted || attempt >= maxAttempts) {
          log.error({ err, attempt, model: modelId }, "Anthropic completion failed");
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`Anthropic request failed (model: ${modelId}): ${msg}`);
        }
        const retryDelay = this.retryDelayForError(err, attempt - 1);
        log.warn({ err, attempt, retryDelay }, "Anthropic request failed — retrying");
        await new Promise((r) => setTimeout(r, retryDelay));
      }
    }

    throw new Error("Anthropic completion failed after max retries");
  }

  /** Same contract as LMStudioProvider.completeViaStream — a complete()-shaped
   *  result accumulated from the streaming endpoint, giving the activity
   *  monitor live token progress and the per-chunk inactivity abort, and the
   *  same partial-result salvage on a stream that dies after producing work. */
  async completeViaStream(messages: LLMMessage[], tools: LLMToolDef[], signal?: AbortSignal): Promise<LLMResponse> {
    let content = "";
    const reasoningParts: string[] = [];
    const toolBuffers = new Map<string, { id: string; name: string; args: string }>();
    const toolOrder: string[] = [];
    let finishReason = "stop";
    let truncatedBy: LLMResponse["truncatedBy"];
    let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    try {
      for await (const chunk of this.stream(messages, tools, signal)) {
        switch (chunk.type) {
          case "text_delta":
            content += chunk.content ?? "";
            break;
          case "reasoning_delta":
            if (chunk.content) reasoningParts.push(chunk.content);
            break;
          case "tool_call_start": {
            const id = chunk.toolCallId ?? `tc_${toolOrder.length}`;
            if (!toolBuffers.has(id)) {
              toolBuffers.set(id, { id, name: chunk.toolName ?? "", args: "" });
              toolOrder.push(id);
            }
            break;
          }
          case "tool_call_delta": {
            const buf = chunk.toolCallId ? toolBuffers.get(chunk.toolCallId) : undefined;
            if (buf) buf.args += chunk.argumentsDelta ?? "";
            break;
          }
          case "done":
            finishReason = chunk.finishReason ?? finishReason;
            // The provider's OWN "length" (stop_reason max_tokens) — distinct from
            // the fabricated one the salvage path below sets.
            if (finishReason === "length") truncatedBy = "output_budget";
            if (chunk.usage) usage = chunk.usage;
            break;
        }
      }
    } catch (err) {
      // SALVAGE — identical semantics to LMStudioProvider.completeViaStream. Without
      // it the DeadlineAbort design ("the run hit its own budget, so whatever the
      // model already produced is still wanted") simply did not hold on this
      // provider: a deadline crossing threw away every token Anthropic had already
      // streamed AND billed, and the caller's usage accounting never saw them.
      // An OPERATOR cancel is still not a salvage case — the user asked for it to
      // stop, so that abort propagates untouched.
      const operatorCancelled = signal?.aborted === true && !isDeadlineAbort(signal.reason);
      const salvageable = content.trim().length > 0 || toolOrder.length > 0 || reasoningParts.length > 0;
      if (!salvageable || operatorCancelled) throw err;
      log.warn({
        err: err instanceof Error ? err.message : String(err),
        model: parseModelId(this.modelConfig.primary),
        contentChars: content.length,
        toolCalls: toolOrder.length,
        reasoningChars: reasoningParts.join("").length,
      }, "Anthropic stream failed after producing content — salvaging the partial result instead of failing the turn");
      // Usage only reaches us on the final `done` chunk, which a cut stream never
      // emits — so a salvaged run reported completionTokens: 0. Both stall detectors
      // read "did completionTokens increase?" as progress, and the cost aggregator
      // would under-report output Anthropic already billed. Estimate it, and say so
      // via truncatedBy.
      if (usage.completionTokens === 0) {
        const producedChars = content.length
          + reasoningParts.join("").length
          + toolOrder.reduce((sum, id) => sum + (toolBuffers.get(id)?.args.length ?? 0), 0);
        const estimated = Math.ceil(producedChars / PROMPT_ESTIMATE_CHARS_PER_TOKEN);
        usage = {
          promptTokens: usage.promptTokens,
          completionTokens: estimated,
          totalTokens: usage.promptTokens + estimated,
        };
      }
      truncatedBy = isDeadlineAbort(signal?.reason) ? "deadline" : "transport";
      finishReason = "length";
    }

    const tool_calls = toolOrder.map((id) => {
      const buf = toolBuffers.get(id)!;
      let args: Record<string, unknown>;
      if (!buf.args.trim()) {
        args = {};
      } else {
        // Tolerant parse: a salvaged stream cuts the argument JSON mid-object, and
        // parseToolArguments would silently return {} — an empty-args tool call the
        // caller cannot tell from a genuinely argument-less one.
        const salvaged = salvageToolCallArguments(buf.args);
        if (salvaged) {
          args = salvaged;
        } else {
          log.warn({ toolName: buf.name, rawArgs: buf.args.slice(0, 200) }, "Failed to parse streamed Anthropic tool call arguments");
          args = { _parse_error: true, _raw: buf.args };
        }
      }
      return { id: buf.id, name: buf.name, arguments: args };
    });

    const reasoning = reasoningParts.join("").trim();
    return {
      content: content.length > 0 ? content : null,
      ...(reasoning ? { reasoning } : {}),
      tool_calls,
      usage,
      finishReason,
      ...(truncatedBy ? { truncatedBy } : {}),
    };
  }

  async *stream(
    messages: LLMMessage[],
    tools: LLMToolDef[],
    signal?: AbortSignal,
    options?: { toolChoice?: "auto" | "required" | "none" },
  ): AsyncGenerator<StreamChunk> {
    const { modelId, params } = this.buildRequestBase(messages, tools, "stream", options?.toolChoice);

    const streamAc = new AbortController();
    let streamParentListener: (() => void) | undefined;
    if (signal?.aborted) {
      streamAc.abort(signal.reason);
    } else if (signal) {
      streamParentListener = () => streamAc.abort(signal.reason);
      signal.addEventListener("abort", streamParentListener, { once: true });
    }

    // Open the stream with the same bounded retry/backoff as complete(). The 429
    // (and 529) happens at open time, before any chunk; previously this threw with
    // ZERO retry, so concurrent sub-agents hitting a rate limit all failed at once.
    const openStream = () => this.withHardTimeout(streamAc.signal, this.requestTimeoutMs + 5000, async (s) =>
      this.client.messages.create({ ...params, stream: true }, await this.requestOptions(s)),
    );
    let stream: Awaited<ReturnType<typeof openStream>>;
    {
      let openAttempt = 0;
      const maxOpenAttempts = this.configuredMaxRetries + 1;
      for (;;) {
        try {
          stream = await openStream();
          break;
        } catch (err) {
          openAttempt++;
          if (signal?.aborted || streamAc.signal.aborted || openAttempt >= maxOpenAttempts || !this.isRetryableProviderError(err)) {
            throw err;
          }
          const delay = this.retryDelayForError(err, openAttempt - 1);
          log.warn({ err, attempt: openAttempt, delay, model: modelId }, "Anthropic stream open failed — retrying");
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    // index → tool id mapping: Anthropic streams tool args per content-block index.
    const toolBlockIds = new Map<number, string>();
    let promptTokens = 0;
    let outputTokens = 0;
    let collectedStopReason: string | undefined;
    const startedAt = Date.now();
    const callId = beginProviderCall({ model: modelId, mode: "stream" });

    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
    const armInactivity = () => {
      if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        streamAc.abort(new Error(`LLM stream stalled (no chunk in ${this.requestTimeoutMs}ms)`));
      }, this.requestTimeoutMs);
    };
    armInactivity();

    // TOTAL wall-clock BACKSTOP, separate from the inactivity guard above, which
    // measures SILENCE and re-arms on every chunk — so it can never stop a model
    // that keeps emitting. This path had no total bound at all. The real bound is
    // the caller's deadline signal; this exists so a caller that passes NO signal
    // still cannot hang forever, and it matters more here than on the local
    // provider because a runaway generation on a priced model also burns money.
    const streamStartedAt = Date.now();

    try {
      for await (const event of stream) {
        if (Date.now() - streamStartedAt > MAX_STREAM_TOTAL_MS) {
          // THROW, do not break: a break would leave the try normally, record a
          // SUCCESS, and report the guillotined generation as a clean stop.
          const capErr = new Error(
            `LLM stream exceeded its total budget of ${Math.round(MAX_STREAM_TOTAL_MS / 1000)}s while still producing output `
            + "— the model is generating without converging (most often a runaway reasoning block)",
          );
          streamAc.abort(capErr);
          throw capErr;
        }
        armInactivity();
        switch (event.type) {
          case "message_start": {
            const usage = event.message.usage;
            promptTokens = (usage.input_tokens ?? 0)
              + (usage.cache_read_input_tokens ?? 0)
              + (usage.cache_creation_input_tokens ?? 0);
            break;
          }
          case "content_block_start": {
            if (event.content_block.type === "tool_use") {
              recordProviderToken(callId);
              toolBlockIds.set(event.index, event.content_block.id);
              yield { type: "tool_call_start", toolCallId: event.content_block.id, toolName: event.content_block.name };
            }
            break;
          }
          case "content_block_delta": {
            recordProviderToken(callId);
            if (event.delta.type === "text_delta") {
              yield { type: "text_delta", content: event.delta.text };
            } else if (event.delta.type === "thinking_delta") {
              yield { type: "reasoning_delta", content: event.delta.thinking };
            } else if (event.delta.type === "input_json_delta") {
              const toolCallId = toolBlockIds.get(event.index);
              if (toolCallId) {
                yield { type: "tool_call_delta", toolCallId, argumentsDelta: event.delta.partial_json };
              }
            }
            break;
          }
          case "message_delta": {
            collectedStopReason = event.delta.stop_reason ?? collectedStopReason;
            outputTokens = event.usage.output_tokens ?? outputTokens;
            break;
          }
          default:
            break;
        }
      }
    } catch (err) {
      this.recordRequestFailure(startedAt, err);
      log.error({ err, model: modelId }, "Anthropic streaming failed");
      throw new Error(`Anthropic stream failed (model: ${modelId}): ${String(err)}`);
    } finally {
      endProviderCall(callId);
      if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
      if (streamParentListener && signal) signal.removeEventListener("abort", streamParentListener);
    }

    this.recordRequestSuccess(startedAt);
    yield {
      type: "done",
      finishReason: mapStopReason(collectedStopReason),
      usage: {
        promptTokens,
        completionTokens: outputTokens,
        totalTokens: promptTokens + outputTokens,
      },
    };
  }

  async embed(_texts: string[], _model: string): Promise<Float32Array[]> {
    throw new Error(
      "The Anthropic provider does not support embeddings — configure agents.defaults.model.embeddingModel on a local/OpenAI-compatible provider",
    );
  }

  isHealthy(): boolean {
    const staleness = Date.now() - this.lastHealthCheck;
    return this.healthy && staleness < 120000; // 2 min, same policy as LMStudioProvider
  }
}
