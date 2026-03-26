import OpenAI from "openai";
import type { ChatCompletion, ChatCompletionChunk, ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import type { Stream } from "openai/streaming";
import { childLogger } from "../logger.js";
import type { ModelConfig } from "../config/schema.js";

const log = childLogger("provider:openai-compatible");

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
  tool_calls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  finishReason: string;
}

export interface StreamChunk {
  type: "text_delta" | "tool_call_start" | "tool_call_delta" | "done";
  content?: string;
  toolCallId?: string;
  toolName?: string;
  argumentsDelta?: string;
  finishReason?: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
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

  constructor(baseUrl: string, apiKey: string, modelConfig: ModelConfig) {
    this.baseUrl = baseUrl;
    this.modelConfig = modelConfig;
    this.client = new OpenAI({
      baseURL: baseUrl,
      apiKey: apiKey,
      timeout: modelConfig.contextWindow > 16384 ? 60000 : 30000,
      maxRetries: 0, // We handle retries manually
    });
  }

  async checkHealth(): Promise<{ healthy: boolean; loadedModel?: string; error?: string }> {
    try {
      const modelsPage = await Promise.race([
        this.client.models.list(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Health check timeout")), 5000)
        ),
      ]);
      const modelList = modelsPage.data ?? [];
      if (modelList.length === 0) {
        return { healthy: false, error: "No models loaded in the configured OpenAI-compatible provider" };
      }
      const first = modelList[0];
      this.healthy = true;
      this.lastHealthCheck = Date.now();
      return { healthy: true, loadedModel: first?.id };
    } catch (err) {
      this.healthy = false;
      return { healthy: false, error: String(err) };
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
    const openAIMessages = messages as ChatCompletionMessageParam[];
    const openAITools: ChatCompletionTool[] = tools.map(t => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));

    let attempt = 0;
    // Limit retries to 1 retry (2 total). More retries × long timeouts = silent hangs.
    const maxAttempts = 2;
    const retryDelay = 2000;

    // Qwen3.5 thinking-mode: auto-apply recommended sampling params when enableThinking is set
    // and the user has not explicitly overridden topP. Explicit topP always wins.
    let effectiveTemp = this.modelConfig.temperature;
    let effectiveTopP = this.modelConfig.topP;
    if (this.modelConfig.enableThinking !== undefined && effectiveTopP === undefined) {
      if (this.modelConfig.enableThinking) {
        effectiveTemp = 0.6;
        effectiveTopP = 0.95;
      } else {
        effectiveTemp = 0.7;
        effectiveTopP = 0.8;
      }
    }

    while (attempt < maxAttempts) {
      try {
        const response = await this.client.chat.completions.create(
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
            ...(this.modelConfig.enableThinking !== undefined && {
              extra_body: { chat_template_kwargs: { enable_thinking: this.modelConfig.enableThinking } },
            }),
          } as Parameters<typeof this.client.chat.completions.create>[0],
          { signal }
        ) as ChatCompletion;

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

        return {
          content: choice.message.content ?? null,
          tool_calls: toolCalls,
          usage: {
            promptTokens: response.usage?.prompt_tokens ?? 0,
            completionTokens: response.usage?.completion_tokens ?? 0,
            totalTokens: response.usage?.total_tokens ?? 0,
          },
          finishReason: choice.finish_reason ?? "stop",
        };
      } catch (err: unknown) {
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
    const openAIMessages = messages as ChatCompletionMessageParam[];
    const openAITools: ChatCompletionTool[] = tools.map(t => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));

    // Qwen3.5 thinking-mode: same auto-sampling logic as complete()
    let streamEffectiveTemp = this.modelConfig.temperature;
    let streamEffectiveTopP = this.modelConfig.topP;
    if (this.modelConfig.enableThinking !== undefined && streamEffectiveTopP === undefined) {
      if (this.modelConfig.enableThinking) {
        streamEffectiveTemp = 0.6;
        streamEffectiveTopP = 0.95;
      } else {
        streamEffectiveTemp = 0.7;
        streamEffectiveTopP = 0.8;
      }
    }

    const stream = await this.client.chat.completions.create(
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
        ...(this.modelConfig.enableThinking !== undefined && {
          extra_body: { chat_template_kwargs: { enable_thinking: this.modelConfig.enableThinking } },
        }),
        stream: true,
        stream_options: { include_usage: true },
      } as Parameters<typeof this.client.chat.completions.create>[0],
      { signal }
    ) as Stream<ChatCompletionChunk>;

    const toolCallBuffers = new Map<number, { id: string; name: string; args: string }>();
    let collectedFinishReason: string | undefined;
    let collectedUsage: StreamChunk["usage"] | undefined;

    for await (const chunk of stream) {
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

      if (delta.content) {
        yield { type: "text_delta", content: delta.content };
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

    yield { type: "done", finishReason: collectedFinishReason ?? "stop", usage: collectedUsage };
  }

  async embed(texts: string[], model: string): Promise<Float32Array[]> {
    const response = await this.client.embeddings.create({ model, input: texts });
    return response.data.map(d => new Float32Array(d.embedding));
  }

  isHealthy(): boolean {
    const staleness = Date.now() - this.lastHealthCheck;
    return this.healthy && staleness < 120000; // 2 min
  }
}
