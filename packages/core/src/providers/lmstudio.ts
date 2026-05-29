import OpenAI from "openai";
import type { ChatCompletion, ChatCompletionChunk, ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import type { Stream } from "openai/streaming";
import { childLogger } from "../logger.js";
import type { ModelConfig } from "../config/schema.js";

const log = childLogger("provider:openai-compatible");
const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;
const MAX_PROVIDER_TIMEOUT_MS = 300_000;

/**
 * Thrown when a single LLM call exceeds its own wall-clock hard timeout (a hung
 * or pathologically slow provider), as opposed to a transient network error or
 * external cancellation. It is NON-RETRYABLE: retrying a hung provider just
 * multiplies the wall-clock hang by the retry count (we observed a single
 * sub-agent delegation hang ~20 min = 4 × a 5-min hard timeout because the
 * retry loop treated the timeout abort as a transient error). Callers must
 * surface it immediately so the orchestrator can fall back or synthesize.
 */
export class ProviderHardTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`LLM call exceeded hard timeout of ${timeoutMs}ms`);
    this.name = "ProviderHardTimeoutError";
  }
}

interface LMStudioProviderOptions {
  timeoutMs?: number;
  maxRetries?: number;
}

export interface OpenAICompatibleProviderRuntimeSnapshot {
  baseUrl: string;
  healthy: boolean;
  loadedModel?: string;
  lastError?: string;
  requestTimeoutMs: number;
  configuredMaxRetries: number;
  requestCount: number;
  successCount: number;
  failureCount: number;
  lastLatencyMs?: number;
  averageLatencyMs?: number;
  lastUsedAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastHealthCheckAt?: string;
  lastHealthCheckLatencyMs?: number;
}

export function computeOpenAICompatibleRequestTimeoutMs(
  modelConfig: Partial<Pick<ModelConfig, "maxTokens">>,
  configuredTimeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS,
): number {
  const tokenBudgetTimeoutMs = 20_000 + Math.max(0, modelConfig.maxTokens ?? 0) * 25;
  return Math.min(MAX_PROVIDER_TIMEOUT_MS, Math.max(configuredTimeoutMs, tokenBudgetTimeoutMs));
}

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

export interface LLMToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LLMResponse {
  content: string | null;
  /** Chain-of-thought / reasoning text, when the model exposes it (qwen
   * thinking mode via LM Studio's `reasoning_content`, or inline `<think>`
   * tags). Stripped out of `content` so the answer stays clean. */
  reasoning?: string;
  tool_calls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  finishReason: string;
}

export interface StreamChunk {
  type: "text_delta" | "reasoning_delta" | "tool_call_start" | "tool_call_delta" | "done";
  content?: string;
  toolCallId?: string;
  toolName?: string;
  argumentsDelta?: string;
  finishReason?: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

/**
 * Split a model response into clean answer text and reasoning, handling both
 * conventions LM Studio / vLLM use for qwen-style thinking models:
 *  1. A dedicated `reasoning_content` field (preferred — passed in via `field`).
 *  2. Inline `<think>...</think>` blocks embedded in the content.
 * Returns the answer with any `<think>` blocks removed plus the merged
 * reasoning text (field + inline). An unterminated `<think>` (the model ran
 * out of tokens mid-thought) is treated as all-reasoning.
 */
export function splitReasoning(
  rawContent: string | null | undefined,
  field?: string | null,
): { content: string | null; reasoning?: string } {
  const reasoningParts: string[] = [];
  if (typeof field === "string" && field.trim()) reasoningParts.push(field.trim());

  let answer = typeof rawContent === "string" ? rawContent : "";
  if (answer.includes("<think>")) {
    // Extract every closed <think>…</think> block.
    answer = answer.replace(/<think>([\s\S]*?)<\/think>/gi, (_m, inner: string) => {
      if (inner.trim()) reasoningParts.push(inner.trim());
      return "";
    });
    // Unterminated <think> with no closer: everything after it is reasoning.
    const openIdx = answer.indexOf("<think>");
    if (openIdx >= 0) {
      const tail = answer.slice(openIdx + "<think>".length).trim();
      if (tail) reasoningParts.push(tail);
      answer = answer.slice(0, openIdx);
    }
  }

  const reasoning = reasoningParts.join("\n\n").trim();
  // If we extracted reasoning, `answer` is the de-thought remainder (may be
  // empty → null). If we extracted nothing, leave the original content as-is.
  if (!reasoning) {
    return { content: typeof rawContent === "string" ? rawContent : null };
  }
  const cleaned = answer.trim();
  return { content: cleaned.length > 0 ? cleaned : null, reasoning };
}

const GEMMA_INSTRUCTION_PREAMBLE = "Follow these instructions for the entire conversation.";

function isGemmaModelId(modelId: string): boolean {
  return modelId.toLowerCase().includes("gemma");
}

function isQwenModelId(modelId: string): boolean {
  return modelId.toLowerCase().includes("qwen");
}

function supportsThinkingToggle(modelId: string): boolean {
  const normalized = modelId.toLowerCase();
  return normalized.includes("qwen") || normalized.includes("gemma-4");
}

export function normalizeMessagesForModel(
  messages: readonly LLMMessage[],
  providerModel: string,
): ChatCompletionMessageParam[] {
  const cloned = messages.map((message) => ({ ...message })) as ChatCompletionMessageParam[];
  if (!isGemmaModelId(providerModel)) return cloned;

  const leadingSystemPrompts: string[] = [];
  let leadingSystemCount = 0;
  for (const message of messages) {
    if (message.role !== "system") break;
    leadingSystemCount += 1;
    const content = typeof message.content === "string" ? message.content.trim() : "";
    if (content) leadingSystemPrompts.push(content);
  }

  if (leadingSystemCount === 0 || leadingSystemPrompts.length === 0) return cloned;

  const normalized = cloned.slice(leadingSystemCount);
  const instructionBlock = `${GEMMA_INSTRUCTION_PREAMBLE}\n\n${leadingSystemPrompts.join("\n\n")}`;
  const firstUserIndex = normalized.findIndex((message) => message.role === "user" && typeof message.content === "string");

  if (firstUserIndex >= 0) {
    const firstUser = normalized[firstUserIndex]!;
    const currentContent = typeof firstUser.content === "string" ? firstUser.content.trim() : "";
    normalized[firstUserIndex] = {
      ...firstUser,
      content: currentContent
        ? `${instructionBlock}\n\nCurrent request or continuation:\n${currentContent}`
        : instructionBlock,
    } as ChatCompletionMessageParam;
    return normalized;
  }

  return [{ role: "user", content: instructionBlock }, ...normalized];
}

export interface ChatProvider {
  checkHealth(): Promise<{ healthy: boolean; loadedModel?: string; error?: string }>;
  verifyToolCallSupport(modelId: string): Promise<boolean>;
  complete(messages: LLMMessage[], tools: LLMToolDef[], signal?: AbortSignal): Promise<LLMResponse>;
  stream(messages: LLMMessage[], tools: LLMToolDef[], signal?: AbortSignal): AsyncGenerator<StreamChunk>;
  embed(texts: string[], model: string): Promise<Float32Array[]>;
  isHealthy(): boolean;
}

export class LMStudioProvider {
  private client: OpenAI;
  private modelConfig: ModelConfig;
  private baseUrl: string;
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

  constructor(baseUrl: string, apiKey: string, modelConfig: ModelConfig, options: LMStudioProviderOptions = {}) {
    this.baseUrl = baseUrl;
    this.modelConfig = modelConfig;
    this.configuredMaxRetries = Math.max(0, options.maxRetries ?? 1);
    this.requestTimeoutMs = computeOpenAICompatibleRequestTimeoutMs(modelConfig, options.timeoutMs);
    this.client = new OpenAI({
      baseURL: baseUrl,
      apiKey: apiKey,
      timeout: this.requestTimeoutMs,
      maxRetries: 0, // We handle retries manually
    });
  }

  async checkHealth(): Promise<{ healthy: boolean; loadedModel?: string; error?: string }> {
    const startedAt = Date.now();
    try {
      const modelsPage = await Promise.race([
        this.client.models.list(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Health check timeout")), 5000)
        ),
      ]);
      const modelList = modelsPage.data ?? [];
      if (modelList.length === 0) {
        this.healthy = false;
        this.lastHealthCheck = Date.now();
        this.lastHealthCheckLatencyMs = this.lastHealthCheck - startedAt;
        this.lastError = "No models loaded in the configured OpenAI-compatible provider";
        return { healthy: false, error: "No models loaded in the configured OpenAI-compatible provider" };
      }
      const first = modelList[0];
      this.healthy = true;
      this.lastHealthCheck = Date.now();
      this.lastHealthCheckLatencyMs = this.lastHealthCheck - startedAt;
      this.loadedModel = first?.id;
      this.lastError = undefined;
      return { healthy: true, loadedModel: first?.id };
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
  }

  private recordRequestFailure(startedAt: number, error: unknown): void {
    const finishedAt = Date.now();
    const latencyMs = finishedAt - startedAt;
    this.requestCount += 1;
    this.failureCount += 1;
    this.lastLatencyMs = latencyMs;
    this.lastUsedAt = new Date(finishedAt).toISOString();
    this.lastFailureAt = this.lastUsedAt;
    this.lastError = error instanceof Error ? error.message : String(error);
  }

  // The OpenAI SDK's `timeout` option has been observed not to fire when
  // LM Studio holds the HTTP connection open without sending data (we saw a
  // single `complete()` call run for 20 min past a 5-min SDK timeout). This
  // wrapper composes the caller's signal with a setTimeout-based abort so
  // every attempt has a true wall-clock ceiling we control.
  private async withHardTimeout<T>(
    parentSignal: AbortSignal | undefined,
    timeoutMs: number,
    fn: (combinedSignal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let parentListener: (() => void) | undefined;
    let timedOut = false;

    if (parentSignal?.aborted) {
      ac.abort(parentSignal.reason);
    } else if (parentSignal) {
      parentListener = () => ac.abort(parentSignal.reason);
      parentSignal.addEventListener("abort", parentListener, { once: true });
    }

    timer = setTimeout(() => {
      timedOut = true;
      ac.abort(new Error(`LLM call exceeded hard timeout of ${timeoutMs}ms`));
    }, timeoutMs);

    try {
      return await fn(ac.signal);
    } catch (err) {
      // Distinguish OUR wall-clock timeout from an external/parent cancel so
      // the retry loop can treat it as terminal (a hung provider must not be
      // retried — see ProviderHardTimeoutError).
      if (timedOut && !parentSignal?.aborted) {
        throw new ProviderHardTimeoutError(timeoutMs);
      }
      throw err;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (parentListener && parentSignal) parentSignal.removeEventListener("abort", parentListener);
    }
  }

  async verifyToolCallSupport(modelId: string): Promise<boolean> {
    try {
      const testMessages: ChatCompletionMessageParam[] = [
        { role: "user", content: "Call the test_tool function with x=1." }
      ];
      const tools: ChatCompletionTool[] = [{
        type: "function",
        function: {
          name: "test_tool",
          description: "Test function",
          parameters: { type: "object", properties: { x: { type: "number" } }, required: ["x"] },
        }
      }];

      const response = await this.client.chat.completions.create({
        model: modelId,
        messages: testMessages,
        tools,
        tool_choice: "auto",
        max_tokens: 64,
      });

      const hasToolCall = (response.choices[0]?.finish_reason === "tool_calls") ||
                          (response.choices[0]?.message?.tool_calls?.length ?? 0) > 0;
      return hasToolCall;
    } catch {
      return false;
    }
  }

  private parseModelId(providerModel: string): string {
    // "lmstudio/qwen3.5" → we need to ask LM Studio for the loaded model
    // If model specified after slash, use it; otherwise use first loaded model
    const parts = providerModel.split("/");
    return parts.length > 1 ? parts.slice(1).join("/") : providerModel;
  }

  async complete(
    messages: LLMMessage[],
    tools: LLMToolDef[],
    signal?: AbortSignal
  ): Promise<LLMResponse> {
    const modelId = this.parseModelId(this.modelConfig.primary);
    const openAIMessages = normalizeMessagesForModel(messages, modelId);
    const openAITools: ChatCompletionTool[] = tools.map(t => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));

    let attempt = 0;
    const maxAttempts = this.configuredMaxRetries + 1;
    const retryDelay = 2000;

    // Qwen3.5 thinking-mode: auto-apply recommended sampling params when enableThinking is set
    // and the user has not explicitly overridden topP. Explicit topP always wins.
    let effectiveTemp = this.modelConfig.temperature;
    let effectiveTopP = this.modelConfig.topP;
    if (isQwenModelId(modelId) && this.modelConfig.enableThinking !== undefined && effectiveTopP === undefined) {
      if (this.modelConfig.enableThinking) {
        effectiveTemp = 0.6;
        effectiveTopP = 0.95;
      } else {
        effectiveTemp = 0.7;
        effectiveTopP = 0.8;
      }
    }

    while (attempt < maxAttempts) {
      const startedAt = Date.now();
      try {
        const response = await this.withHardTimeout(signal, this.requestTimeoutMs + 5000, (s) => this.client.chat.completions.create(
          {
            model: modelId,
            messages: openAIMessages,
            tools: openAITools.length > 0 ? openAITools : undefined,
            tool_choice: openAITools.length > 0 ? "auto" : undefined,
            temperature: effectiveTemp,
            max_tokens: this.modelConfig.maxTokens,
            ...(effectiveTopP !== undefined && { top_p: effectiveTopP }),
            ...(this.modelConfig.topK !== undefined && { top_k: this.modelConfig.topK }),
            ...(this.modelConfig.minP !== undefined && { min_p: this.modelConfig.minP }),
            ...(this.modelConfig.repeatPenalty !== undefined && { repeat_penalty: this.modelConfig.repeatPenalty }),
            ...(this.modelConfig.seed !== undefined && { seed: this.modelConfig.seed }),
            // Qwen3.5 thinking toggle — extra_body is a LM Studio / vLLM extension.
            // The outer `as Parameters<...>[0]` cast suppresses the unknown-property error.
            ...(supportsThinkingToggle(modelId) && this.modelConfig.enableThinking !== undefined && {
              extra_body: { chat_template_kwargs: { enable_thinking: this.modelConfig.enableThinking } },
            }),
          } as Parameters<typeof this.client.chat.completions.create>[0],
          { signal: s }
        )) as ChatCompletion;

        const choice = response.choices[0];
        if (!choice) throw new Error("Empty response from OpenAI-compatible provider");

        const toolCalls = (choice.message.tool_calls ?? []).map(tc => ({
          id: tc.id,
          name: tc.function.name,
          arguments: (() => {
            try { return JSON.parse(tc.function.arguments) as Record<string, unknown>; }
            catch {
              log.warn({ toolName: tc.function.name, rawArgs: tc.function.arguments.slice(0, 200) }, "Failed to parse tool call arguments");
              return { _parse_error: true, _raw: tc.function.arguments } as Record<string, unknown>;
            }
          })(),
        }));

        this.recordRequestSuccess(startedAt);

        // `reasoning_content` is an LM Studio / vLLM extension for thinking
        // models — not in the OpenAI SDK types, so read it via a cast. Also
        // strips any inline <think> blocks out of the answer content.
        const reasoningField = (choice.message as { reasoning_content?: string }).reasoning_content;
        const split = splitReasoning(choice.message.content, reasoningField);

        return {
          content: split.content,
          ...(split.reasoning ? { reasoning: split.reasoning } : {}),
          tool_calls: toolCalls,
          usage: {
            promptTokens: response.usage?.prompt_tokens ?? 0,
            completionTokens: response.usage?.completion_tokens ?? 0,
            totalTokens: response.usage?.total_tokens ?? 0,
          },
          finishReason: choice.finish_reason ?? "stop",
        };
      } catch (err: unknown) {
        this.recordRequestFailure(startedAt, err);
        // A hard-timeout is terminal: retrying a hung/too-slow provider only
        // multiplies the wall-clock hang (e.g. 4 × 5-min = 20-min delegation).
        // Surface it immediately so the orchestrator can fall back or synthesize.
        if (err instanceof ProviderHardTimeoutError) {
          log.error({ attempt, timeoutMs: err.timeoutMs, model: modelId }, "OpenAI-compatible completion hit hard timeout — not retrying");
          throw err;
        }
        attempt++;
        if (signal?.aborted || attempt >= maxAttempts) {
          log.error({ err, attempt, model: modelId }, "OpenAI-compatible completion failed");
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`OpenAI-compatible request failed (model: ${modelId}): ${msg}`);
        }
        log.warn({ err, attempt, retryDelay }, "OpenAI-compatible request failed — retrying once");
        await new Promise(r => setTimeout(r, retryDelay));
      }
    }

    throw new Error("OpenAI-compatible completion failed after max retries");
  }

  async *stream(
    messages: LLMMessage[],
    tools: LLMToolDef[],
    signal?: AbortSignal
  ): AsyncGenerator<StreamChunk> {
    const modelId = this.parseModelId(this.modelConfig.primary);
    const openAIMessages = normalizeMessagesForModel(messages, modelId);
    const openAITools: ChatCompletionTool[] = tools.map(t => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));

    // Qwen3.5 thinking-mode: same auto-sampling logic as complete()
    let streamEffectiveTemp = this.modelConfig.temperature;
    let streamEffectiveTopP = this.modelConfig.topP;
    if (isQwenModelId(modelId) && this.modelConfig.enableThinking !== undefined && streamEffectiveTopP === undefined) {
      if (this.modelConfig.enableThinking) {
        streamEffectiveTemp = 0.6;
        streamEffectiveTopP = 0.95;
      } else {
        streamEffectiveTemp = 0.7;
        streamEffectiveTopP = 0.8;
      }
    }

    // The hardTimeout here only guards the initial `create()` call (opening
    // the HTTP stream). Per-chunk inactivity is enforced below so a hung
    // mid-stream connection can't tie up the turn indefinitely.
    const streamAc = new AbortController();
    let streamParentListener: (() => void) | undefined;
    if (signal?.aborted) {
      streamAc.abort(signal.reason);
    } else if (signal) {
      streamParentListener = () => streamAc.abort(signal.reason);
      signal.addEventListener("abort", streamParentListener, { once: true });
    }

    const createStream = this.client.chat.completions.create.bind(this.client.chat.completions);
    const stream = await this.withHardTimeout(streamAc.signal, this.requestTimeoutMs + 5000, (s) => createStream(
      {
        model: modelId,
        messages: openAIMessages,
        tools: openAITools.length > 0 ? openAITools : undefined,
        tool_choice: openAITools.length > 0 ? "auto" : undefined,
        temperature: streamEffectiveTemp,
        max_tokens: this.modelConfig.maxTokens,
        ...(streamEffectiveTopP !== undefined && { top_p: streamEffectiveTopP }),
        ...(this.modelConfig.topK !== undefined && { top_k: this.modelConfig.topK }),
        ...(this.modelConfig.minP !== undefined && { min_p: this.modelConfig.minP }),
        ...(this.modelConfig.repeatPenalty !== undefined && { repeat_penalty: this.modelConfig.repeatPenalty }),
        ...(this.modelConfig.seed !== undefined && { seed: this.modelConfig.seed }),
        // Qwen3.5 thinking toggle — extra_body is a LM Studio / vLLM extension.
        ...(supportsThinkingToggle(modelId) && this.modelConfig.enableThinking !== undefined && {
          extra_body: { chat_template_kwargs: { enable_thinking: this.modelConfig.enableThinking } },
        }),
        stream: true,
        stream_options: { include_usage: true },
      } as Parameters<typeof createStream>[0],
      { signal: s }
    )) as Stream<ChatCompletionChunk>;

    const toolCallBuffers = new Map<number, { id: string; name: string; args: string }>();
    let collectedFinishReason: string | undefined;
    let collectedUsage: StreamChunk["usage"] | undefined;
    const startedAt = Date.now();
    // Inline <think> stripping for providers that stream reasoning inside the
    // normal content field rather than a dedicated reasoning_content delta.
    let insideThink = false;

    // Per-chunk inactivity timer: if the provider stops sending data for
    // longer than the configured request timeout, abort the stream.
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
    const armInactivity = () => {
      if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        streamAc.abort(new Error(`LLM stream stalled (no chunk in ${this.requestTimeoutMs}ms)`));
      }, this.requestTimeoutMs);
    };
    armInactivity();

    try {
      for await (const chunk of stream) {
        armInactivity();
        // Usage arrives in a final chunk with empty choices (stream_options.include_usage)
        if (chunk.usage) {
          collectedUsage = {
            promptTokens: chunk.usage.prompt_tokens ?? 0,
            completionTokens: chunk.usage.completion_tokens ?? 0,
            totalTokens: chunk.usage.total_tokens ?? 0,
          };
        }

        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        // Dedicated reasoning delta (LM Studio / vLLM thinking models). Not in
        // the OpenAI SDK delta type, so read via a cast.
        const reasoningDelta = (delta as { reasoning_content?: string }).reasoning_content;
        if (reasoningDelta) {
          yield { type: "reasoning_delta", content: reasoningDelta };
        }

        if (delta.content) {
          // Some providers stream reasoning inline as <think>…</think> within
          // the content field. Route those spans to reasoning_delta and only
          // emit the de-thought remainder as answer text.
          let text = delta.content;
          while (text.length > 0) {
            if (insideThink) {
              const close = text.indexOf("</think>");
              if (close === -1) {
                if (text) yield { type: "reasoning_delta", content: text };
                text = "";
              } else {
                const inner = text.slice(0, close);
                if (inner) yield { type: "reasoning_delta", content: inner };
                text = text.slice(close + "</think>".length);
                insideThink = false;
              }
            } else {
              const open = text.indexOf("<think>");
              if (open === -1) {
                if (text) yield { type: "text_delta", content: text };
                text = "";
              } else {
                const before = text.slice(0, open);
                if (before) yield { type: "text_delta", content: before };
                text = text.slice(open + "<think>".length);
                insideThink = true;
              }
            }
          }
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (!toolCallBuffers.has(idx)) {
              const id = tc.id ?? `tc_${idx}`;
              const name = tc.function?.name ?? "";
              toolCallBuffers.set(idx, { id, name, args: "" });
              yield { type: "tool_call_start", toolCallId: id, toolName: name };
            }
            const buf = toolCallBuffers.get(idx)!;
            if (tc.function?.arguments) {
              buf.args += tc.function.arguments;
              yield { type: "tool_call_delta", toolCallId: buf.id, argumentsDelta: tc.function.arguments };
            }
          }
        }

        const finishReason = chunk.choices[0]?.finish_reason;
        if (finishReason) {
          collectedFinishReason = finishReason;
        }
      }
    } catch (err) {
      this.recordRequestFailure(startedAt, err);
      log.error({ err, model: modelId }, "OpenAI-compatible streaming failed");
      throw new Error(`OpenAI-compatible stream failed (model: ${modelId}): ${String(err)}`);
    } finally {
      if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
      if (streamParentListener && signal) signal.removeEventListener("abort", streamParentListener);
    }

    this.recordRequestSuccess(startedAt);
    yield { type: "done", finishReason: collectedFinishReason ?? "stop", usage: collectedUsage };
  }

  async embed(texts: string[], model: string): Promise<Float32Array[]> {
    const modelId = this.parseModelId(model);
    // Force `encoding_format: "float"`. The OpenAI SDK otherwise defaults to
    // base64-encoded embeddings, and LM Studio's base64 payload is decoded by
    // the SDK into all-zero vectors — silently breaking every semantic feature
    // (agent routing, skill/memory retrieval, RAG). Requesting plain floats
    // returns the real vectors.
    const response = await this.client.embeddings.create({ model: modelId, input: texts, encoding_format: "float" });
    return response.data.map(d => new Float32Array(d.embedding));
  }

  isHealthy(): boolean {
    const staleness = Date.now() - this.lastHealthCheck;
    return this.healthy && staleness < 120000; // 2 min
  }
}
