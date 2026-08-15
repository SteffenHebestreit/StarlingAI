import OpenAI from "openai";
import { Agent as UndiciAgent } from "undici";
import type { ChatCompletion, ChatCompletionChunk, ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import type { Stream } from "openai/streaming";
import { childLogger } from "../logger.js";
import type { ModelConfig } from "../config/schema.js";
import { beginProviderCall, recordProviderToken, endProviderCall } from "../observability/provider-activity-monitor.js";

const log = childLogger("provider:openai-compatible");
const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;
/**
 * Ceiling on the per-request budget, which streamOnce() uses as the SILENCE budget:
 * the inactivity timer resets on every chunk, so this bounds how long the provider
 * may go quiet, not how long a generation may take.
 *
 * Raised from 300_000. A graded-thinking model with a large prompt legitimately
 * emits nothing for minutes inside one reasoning block — an observed content_writer
 * run on qwen3.8-27b with a 28k-token prompt sat silent for ~5 minutes mid-think and
 * was killed, after 4 useful iterations, with only 95 completion tokens banked. The
 * model was working; the ceiling was not. 15 minutes of TOTAL silence is still a
 * decisive hung-provider signal while leaving a long reasoning block room to finish.
 */
const MAX_PROVIDER_TIMEOUT_MS = 900_000;

/**
 * Transport dispatcher with undici's body timeout DISABLED.
 *
 * This module already owns stall policy: armInactivity() in streamOnce() aborts when
 * no chunk arrives within requestTimeoutMs and re-arms on every chunk. Node's global
 * fetch is undici, and undici applies its own bodyTimeout (default 300s) underneath —
 * a second, invisible authority with a shorter fuse. It won: a stream that our guard
 * was still patiently waiting on died with "BodyTimeoutError: terminated", surfacing
 * as a sub-agent failure that looked like a model problem and was not.
 *
 * headersTimeout stays bounded — a server that never sends headers at all is a real
 * connection failure and should not wait on the silence budget.
 */
const providerDispatcher = new UndiciAgent({
  bodyTimeout: 0,
  headersTimeout: 120_000,
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 600_000,
});

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

/**
 * A streaming call that drops at the connection level — most importantly Node's
 * ERR_STREAM_PREMATURE_CLOSE during the long, byte-silent prefill of a large
 * prompt (~25-30s for a 29K-token prompt on a slow local model) — is transient
 * and worth a retry. Deliberately does NOT match our own hard-timeout /
 * inactivity-stall messages (those are real stalls, not connection drops) or an
 * intentional abort, so only genuine connection drops are retried.
 */
export function isRetryableStreamError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const code = String(
    (err as { code?: unknown })?.code
    ?? (err as { cause?: { code?: unknown } })?.cause?.code
    ?? "",
  );
  if (/exceeded hard timeout|stream stalled|aborted/.test(msg)) return false;
  return /premature close|econnreset|socket hang up|terminated|epipe|econnrefused|fetch failed|network error/.test(msg)
    || ["ERR_STREAM_PREMATURE_CLOSE", "ECONNRESET", "EPIPE", "ECONNREFUSED", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"].includes(code);
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
  // Inline reasoning blocks: <think>…</think> (qwen and most families) OR
  // <thought>…</thought> (Gemma 4). Both are moved to the reasoning channel so
  // the answer stays clean — even on backends that don't separate it into the
  // reasoning_content field.
  const OPEN_TAG_RE = /<(?:think|thought)>/i;
  if (OPEN_TAG_RE.test(answer)) {
    // Extract every closed block of either tag (matched pair via backreference).
    answer = answer.replace(/<(think|thought)>([\s\S]*?)<\/\1>/gi, (_m, _tag, inner: string) => {
      if (inner.trim()) reasoningParts.push(inner.trim());
      return "";
    });
    // Unterminated open tag (token budget exhausted mid-thought): the rest is reasoning.
    const open = OPEN_TAG_RE.exec(answer);
    if (open) {
      const tail = answer.slice(open.index + open[0].length).trim();
      if (tail) reasoningParts.push(tail);
      answer = answer.slice(0, open.index);
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

/**
 * Parse tool-call `arguments` tolerantly. The OpenAI-compatible field is
 * supposed to be a bare JSON object string, but thinking models that reason in
 * the same stream (notably **Gemma 4**, whose `<thought>` thinking llama.cpp
 * cannot reliably disable on the 12B/26B/31B sizes — ggml-org/llama.cpp#21338)
 * leak reasoning or markdown fences INTO the arguments string. The backend then
 * hands us e.g. `<thought>I should plan…</thought>{"plan":[…]}` or
 * ```json\n{…}\n``` — and a strict `JSON.parse` throws, surfacing as
 * "Could not parse arguments for tool 'record_plan'/'delegate_to_agent'".
 *
 * Strategy is purely structural (no per-model keywords): try the raw string,
 * then strip reasoning tags + code fences, then extract the first BALANCED
 * `{…}` object and parse that. Returns null only when nothing JSON-shaped is
 * recoverable.
 */
export function salvageToolCallArguments(raw: string | undefined | null): Record<string, unknown> | null {
  if (typeof raw !== "string" || !raw.trim()) return null;

  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(s) as unknown;
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };

  const direct = tryParse(raw.trim());
  if (direct) return direct;

  // Drop reasoning blocks (<think>/<thought>, closed or unterminated) and any
  // markdown code-fence markers (```json / ```tool_call / ```) the model wrapped
  // around the JSON. We do NOT keep the reasoning here — only the arguments.
  const s = raw
    .replace(/<(think|thought)>[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/?(?:think|thought)>/gi, "")
    .replace(/```[a-zA-Z_]*\n?/g, "")
    .replace(/```/g, "")
    .trim();

  const cleaned = tryParse(s);
  if (cleaned) return cleaned;

  // Extract the first balanced {…} object, honoring strings/escapes so braces
  // inside string values don't throw off the depth count.
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return tryParse(s.slice(start, i + 1));
    }
  }
  return null;
}

const GEMMA_INSTRUCTION_PREAMBLE = "Follow these instructions for the entire conversation.";

function isGemmaModelId(modelId: string): boolean {
  return modelId.toLowerCase().includes("gemma");
}

function isQwenModelId(modelId: string): boolean {
  return modelId.toLowerCase().includes("qwen");
}

/**
 * Qwen's own recommended sampling, which differs per generation and per mode.
 * Returns null when the caller already set top_p explicitly (never override an
 * operator's deliberate choice) or when the model is not a Qwen.
 *
 * Qwen 3.8 raised the thinking-mode temperature to 1.0 (3.5/3.6 recommended 0.6);
 * both generations use 0.7 / 0.80 for non-thinking.
 */
export function recommendedQwenSampling(
  modelId: string,
  cfg: { enableThinking?: boolean; reasoningEffort?: ReasoningEffort },
): { temperature: number; topP: number } | null {
  if (!isQwenModelId(modelId)) return null;
  const family = detectThinkingFamily(modelId);

  if (family === "qwen-effort") {
    // Thinking is on for this family unless the effort is explicitly "none".
    const effort = cfg.reasoningEffort ?? (cfg.enableThinking === false ? "none" : undefined);
    if (effort === "none") return { temperature: 0.7, topP: 0.8 };
    return { temperature: 1.0, topP: 0.95 };
  }

  if (cfg.enableThinking === undefined) return null;
  return cfg.enableThinking ? { temperature: 0.6, topP: 0.95 } : { temperature: 0.7, topP: 0.8 };
}

/** Reasoning/thinking control mechanism by model family (researched June 2026).
 *  Families are grouped by the API MECHANISM they share, not the vendor:
 *  - enable_thinking → chat_template_kwargs { enable_thinking: bool }. Shared by
 *      Qwen3/3.5/3.6, GLM-4.x, and **Gemma 4** (released 2026-04: E2B, E4B, 12B,
 *      26B-MoE `26b-a4b`, 31B dense — base + `-it`; all named `gemma-4-*`, same
 *      enable_thinking key). CAVEAT: on the larger Gemma 4 sizes (12B/26B/31B)
 *      disabling thinking can be unreliable in llama.cpp — the 26B MoE especially
 *      (ggml-org/llama.cpp#21338). The toggle call is correct; the backend may
 *      keep thinking on. Gemma 4 emits reasoning in <thought> tags (handled by
 *      splitReasoning) and small E2B/E4B think by default.
 *  - deepseek → chat_template_kwargs { thinking: bool } (DeepSeek-V3.1 hybrid;
 *      DIFFERENT key vs enable_thinking).
 *  - gpt-oss → reasoning_effort (low|medium|high). LM Studio IGNORES the API
 *      param (lmstudio-bug-tracker#988), so the effort is ALSO injected as a
 *      `Reasoning: <effort>` system line (harmony format).
 *  - none → no programmatic toggle; the backend/GUI default applies. */
export type ThinkingFamily = "qwen-effort" | "enable_thinking" | "deepseek" | "gpt-oss" | "none";

/** Qwen 3.8+ switched from the on/off `enable_thinking` toggle to graded
 *  `reasoning_effort`. Measured on LM Studio against qwen3.8-27b (2026-08-15):
 *
 *    reasoning_effort   reasoning chars   completion tokens
 *    none                            0                 917
 *    low                         1,344                 878
 *    medium                      1,634               1,091
 *    xhigh                       9,034               3,000 (hit the cap)
 *
 *  and, on the SAME model, `chat_template_kwargs.enable_thinking:false` did NOT
 *  disable thinking (2,892 / 6,040 reasoning chars across two runs vs a
 *  4,395 / 6,789 baseline). So routing 3.8 through the enable_thinking family
 *  would leave it with no working control at all.
 *
 *  Matched on the 3.8+ version marker rather than a bare "qwen" so 3.5/3.6 keep
 *  the enable_thinking mechanism that does work for them. */
const QWEN_EFFORT_VERSION_RE = /qwen-?3\.(?:[89]|\d{2,})/;

export function detectThinkingFamily(modelId: string): ThinkingFamily {
  const m = modelId.toLowerCase();
  if (m.includes("gpt-oss") || m.includes("gpt_oss")) return "gpt-oss";
  if (m.includes("deepseek")) return "deepseek";
  if (m.includes("qwen") && QWEN_EFFORT_VERSION_RE.test(m)) return "qwen-effort";
  if (m.includes("qwen") || m.includes("glm") || m.includes("gemma-4")) return "enable_thinking";
  return "none";
}

/** "none" and "xhigh" are Qwen 3.8+ levels; gpt-oss/o-series use low|medium|high. */
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";

/** Qwen 3.8 accepts none|low|medium|xhigh — it has no "high". A config written for
 *  a gpt-oss-style model must not silently send an unknown level, so fold it up. */
function normalizeQwenEffort(effort: ReasoningEffort): ReasoningEffort {
  return effort === "high" ? "xhigh" : effort;
}

/** Effort for gpt-oss-style models: explicit reasoningEffort wins; otherwise map
 *  the boolean toggle (off→low, on→high); undefined → leave the model/GUI default. */
function resolveReasoningEffort(
  cfg: { reasoningEffort?: ReasoningEffort; enableThinking?: boolean },
): ReasoningEffort | undefined {
  // gpt-oss knows low|medium|high only — fold the Qwen-only levels onto it rather
  // than sending a level the model will not recognise.
  if (cfg.reasoningEffort === "xhigh") return "high";
  if (cfg.reasoningEffort === "none") return "low";
  if (cfg.reasoningEffort) return cfg.reasoningEffort;
  if (cfg.enableThinking === false) return "low";
  if (cfg.enableThinking === true) return "high";
  return undefined;
}

/** Family-aware thinking controls for a model. Pure + exported for testing. */
export function resolveThinkingControls(
  modelId: string,
  cfg: { enableThinking?: boolean; reasoningEffort?: ReasoningEffort },
): { chatTemplateKwargs?: Record<string, boolean>; reasoningEffort?: ReasoningEffort; systemReasoningLine?: string } {
  switch (detectThinkingFamily(modelId)) {
    case "qwen-effort": {
      // Explicit effort wins; otherwise map the boolean toggle onto the ladder.
      const effort = cfg.reasoningEffort
        ? normalizeQwenEffort(cfg.reasoningEffort)
        : cfg.enableThinking === false ? "none"
          : cfg.enableThinking === true ? "medium"
            : undefined;
      if (!effort) return {};
      // Turning thinking OFF sends BOTH mechanisms, because the spec and this
      // backend disagree and each covers the other's gap:
      //  - Qwen's model card documents only xhigh|medium|low and says to disable
      //    thinking with chat_template_kwargs.enable_thinking:false. That is what
      //    vLLM honors (it maps reasoning_effort "none" onto the same flag).
      //  - Measured against LM Studio on qwen3.8-27b, the documented flag does
      //    NOTHING (thinking stayed on) while the undocumented reasoning_effort
      //    "none" produced 0 reasoning characters.
      // Sending both is correct on either backend and costs one extra field. It also
      // means a future LM Studio fix, or a move to vLLM, degrades to still-off
      // rather than to silently-thinking.
      if (effort === "none") {
        return { reasoningEffort: "none", chatTemplateKwargs: { enable_thinking: false } };
      }
      return { reasoningEffort: effort };
    }
    case "enable_thinking":
      return cfg.enableThinking !== undefined ? { chatTemplateKwargs: { enable_thinking: cfg.enableThinking } } : {};
    case "deepseek":
      return cfg.enableThinking !== undefined ? { chatTemplateKwargs: { thinking: cfg.enableThinking } } : {};
    case "gpt-oss": {
      const effort = resolveReasoningEffort(cfg);
      return effort ? { reasoningEffort: effort, systemReasoningLine: `Reasoning: ${effort}` } : {};
    }
    default:
      return {};
  }
}

/**
 * Fold the message list into the one shape every chat template accepts: at most one
 * system message, and only at the head.
 *
 * The turn assembly emits the system prompt as roughly ten separate system messages and
 * appends more mid-conversation as steering directives. That is legal OpenAI Chat
 * Completions and most servers accept it — but a chat template is free to be stricter,
 * and several are. Qwen3's raises `System message must be at the beginning` on the
 * SECOND system message, because only index 0 is `loop.first`. Measured against a live
 * LM Studio host: one leading system message returns 200, two return 400, and a system
 * message after a user message returns 400. So on such a model every single turn fails
 * before the agent does anything, and the operator sees "LLM error" with a Jinja stack
 * trace — a total outage presented as a template bug.
 *
 * Both mappings are already settled in this codebase: the Anthropic provider merges the
 * leading run into its top-level system parameter and delivers a mid-conversation system
 * message as user-turn context (`anthropic.ts`). This applies the same two rules here,
 * so the two providers no longer disagree about what a system message means.
 *
 * Deliberately NOT keyed on a model-family list. Which templates are strict is not
 * knowable up front and the list would be permanently incomplete; the folded shape is
 * accepted by the strict ones and identical in content for the lenient ones, so there is
 * nothing to detect.
 */
function foldSystemMessages(messages: readonly LLMMessage[]): LLMMessage[] {
  let leading = 0;
  while (leading < messages.length && messages[leading]!.role === "system") leading += 1;

  const head: LLMMessage[] = [];
  if (leading > 0) {
    const merged = messages
      .slice(0, leading)
      .map((message) => (typeof message.content === "string" ? message.content.trim() : ""))
      .filter(Boolean)
      .join("\n\n");
    // A run of system messages that is entirely empty leaves no head at all, rather than
    // an empty system message some servers reject outright.
    if (merged) head.push({ role: "system", content: merged });
  }

  const tail = messages.slice(leading).map((message) =>
    message.role === "system"
      // Mid-conversation steering, delivered as user-turn context. Position is preserved
      // rather than merged into the head: these directives are written to be the most
      // recent instruction the model has seen, and hoisting them to the top would
      // silently invert that.
      ? ({ ...message, role: "user" } as LLMMessage)
      : message,
  );

  return [...head, ...tail];
}

export function normalizeMessagesForModel(
  messages: readonly LLMMessage[],
  providerModel: string,
): ChatCompletionMessageParam[] {
  const folded = foldSystemMessages(messages);
  const cloned = folded.map((message) => ({ ...message })) as ChatCompletionMessageParam[];
  if (!isGemmaModelId(providerModel)) return cloned;
  // Gemma has no system role at all, so it needs the stronger transform below; it reads
  // the ORIGINAL list because folding has already collapsed the leading run it counts.
  messages = folded;

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
  /** Optional: a complete()-shaped result obtained by consuming the streaming
   *  endpoint and accumulating deltas. Callers that want live token-progress
   *  (provider activity monitor) and the per-chunk inactivity abort on otherwise
   *  non-streaming calls prefer this when present, falling back to complete(). */
  completeViaStream?(messages: LLMMessage[], tools: LLMToolDef[], signal?: AbortSignal): Promise<LLMResponse>;
  stream(messages: LLMMessage[], tools: LLMToolDef[], signal?: AbortSignal, options?: { toolChoice?: "auto" | "required" | "none" }): AsyncGenerator<StreamChunk>;
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
      // Use Node's native fetch (undici) instead of the SDK default (node-fetch@2).
      // node-fetch@2 drops the idle connection during a large prompt's long,
      // byte-silent PREFILL and surfaces ERR_STREAM_PREMATURE_CLOSE (~4s), killing
      // the turn; native fetch holds the identical ~28s prefill against LM Studio
      // (verified: a 29K-token streaming call from inside the gateway container).
      // Native fetch, but routed through providerDispatcher so undici's default
      // 300s bodyTimeout cannot pre-empt this file's own per-chunk stall guard.
      fetch: ((input: unknown, init?: Record<string, unknown>) =>
        (globalThis.fetch as unknown as (i: unknown, o?: Record<string, unknown>) => Promise<unknown>)(
          input,
          { ...(init ?? {}), dispatcher: providerDispatcher },
        )) as unknown as NonNullable<ConstructorParameters<typeof OpenAI>[0]>["fetch"],
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

  /**
   * Build the provider-extension request fields for this model: the thinking
   * controls plus the opt-in llama.cpp/LM Studio prompt-cache reuse.
   *
   * These are spread at the TOP LEVEL of the request body, NOT nested under an
   * `extra_body` key. `extra_body` is a *Python* OpenAI-SDK convenience: that
   * client merges its contents into the top-level JSON before sending, so
   * `extra_body` never appears on the wire. Sending a literal `extra_body`
   * object made the server see one unknown field and drop it, which silently
   * disabled EVERY control in here — the thinking toggle, the reasoning effort,
   * and the prompt-cache reuse. Measured against LM Studio on qwen3.8-27b:
   * top-level `reasoning_effort:"none"` → 0 reasoning chars, the same value
   * nested under `extra_body` → 2323. Keep these top-level.
   */
  private buildProviderExtensions(modelId: string): Record<string, unknown> | undefined {
    const fields: Record<string, unknown> = {};
    const controls = resolveThinkingControls(modelId, this.modelConfig);
    if (controls.chatTemplateKwargs) {
      fields["chat_template_kwargs"] = controls.chatTemplateKwargs;
    }
    if (controls.reasoningEffort) {
      fields["reasoning_effort"] = controls.reasoningEffort;
    }
    if (this.modelConfig.promptCache) {
      // llama.cpp / LM Studio: reuse the KV cache for the common prompt prefix
      // (the stable ~22KB base system message) instead of re-prefilling it.
      fields["cache_prompt"] = true;
    }
    return Object.keys(fields).length > 0 ? fields : undefined;
  }

  /** Prepend the gpt-oss `Reasoning: <effort>` system line — the only reasoning-
   *  effort control LM Studio honors over the API (it ignores reasoning_effort,
   *  #988). No-op for every other family. */
  private withReasoningSystemLine(modelId: string, msgs: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
    const line = resolveThinkingControls(modelId, this.modelConfig).systemReasoningLine;
    return line ? [{ role: "system", content: line } as ChatCompletionMessageParam, ...msgs] : msgs;
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
    const openAIMessages = this.withReasoningSystemLine(modelId, normalizeMessagesForModel(messages, modelId));
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
    if (effectiveTopP === undefined) {
      const rec = recommendedQwenSampling(modelId, this.modelConfig);
      if (rec) {
        effectiveTemp = rec.temperature;
        effectiveTopP = rec.topP;
      }
    }

    while (attempt < maxAttempts) {
      const startedAt = Date.now();
      // In-flight visibility: a non-streaming complete() is a black box (no token
      // deltas), so the monitor can only report how long it has been awaiting a
      // response — but that alone surfaces a remote that's stuck on a 20K-token
      // prompt or hung. (Token-level producing-vs-prefill needs the streaming path.)
      const callId = beginProviderCall({ model: modelId, mode: "complete" });
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
            // Provider extensions (thinking controls + prompt-cache reuse) go at the
            // TOP LEVEL — `extra_body` is a Python-SDK client-side concept and never
            // appears on the wire, so nesting them there silently dropped all of them.
            // Outer cast suppresses the unknown-property error.
            ...(this.buildProviderExtensions(modelId) ?? {}),
          } as Parameters<typeof this.client.chat.completions.create>[0],
          { signal: s }
        )) as ChatCompletion;
        endProviderCall(callId);

        const choice = response.choices[0];
        if (!choice) throw new Error("Empty response from OpenAI-compatible provider");

        const toolCalls = (choice.message.tool_calls ?? []).map(tc => ({
          id: tc.id,
          name: tc.function.name,
          arguments: (() => {
            const rawArgs = tc.function.arguments;
            // An empty argument body is a no-argument call (→ {}), not a parse
            // error — reserve the _parse_error sentinel for non-empty malformed JSON.
            if (!rawArgs || !rawArgs.trim()) return {} as Record<string, unknown>;
            const salvaged = salvageToolCallArguments(rawArgs);
            if (salvaged) return salvaged;
            log.warn({ toolName: tc.function.name, rawArgs: rawArgs.slice(0, 200) }, "Failed to parse tool call arguments");
            return { _parse_error: true, _raw: rawArgs } as Record<string, unknown>;
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
        endProviderCall(callId);
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

  /**
   * A complete()-shaped result obtained by consuming the streaming endpoint and
   * accumulating the deltas into one LLMResponse. Used by the sub-agent loop so
   * the long research/synthesis calls get (a) live token progress for the
   * provider activity monitor — telling "producing" from "stuck on the prompt"
   * from "stalled" — and (b) the per-chunk inactivity abort that stream()
   * enforces, which the plain non-streaming complete() lacks. The output shape
   * matches complete(): reasoning is already de-thought by stream(), so we only
   * concatenate the deltas. No internal retry — a hung/slow remote should surface
   * (mirrors complete()'s hard-timeout-is-terminal policy).
   */
  async completeViaStream(
    messages: LLMMessage[],
    tools: LLMToolDef[],
    signal?: AbortSignal,
  ): Promise<LLMResponse> {
    let content = "";
    const reasoningParts: string[] = [];
    const toolBuffers = new Map<string, { id: string; name: string; args: string }>();
    const toolOrder: string[] = [];
    let finishReason = "stop";
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
            if (chunk.usage) usage = chunk.usage;
            break;
        }
      }
    } catch (err) {
      // SALVAGE. A stream that produced real work and THEN died must not throw the
      // work away. Observed: a content_writer run emitted 278 chunks, went quiet
      // inside a reasoning block, and the transport killed it — the whole turn was
      // reported as an error with 4 useful iterations discarded.
      //
      // If nothing was produced there is nothing to salvage and the error is the
      // honest result. If there IS content or a tool call, return it with a
      // finishReason the callers already understand as incomplete: the iteration
      // loop can act on a recovered tool call, the QA and artifact gates can judge
      // recovered text, and the loop detector can still catch a genuine repeat.
      // Throwing here removes every one of those chances.
      // An operator cancel is NOT a salvage case — the user asked for it to stop, so
      // the abort must propagate. Only a failure the caller did not ask for
      // (transport drop, provider stall) salvages.
      const operatorCancelled = signal?.aborted === true;
      const salvageable = content.trim().length > 0 || toolOrder.length > 0 || reasoningParts.length > 0;
      if (!salvageable || operatorCancelled) throw err;
      log.warn({
        err: err instanceof Error ? err.message : String(err),
        contentChars: content.length,
        toolCalls: toolOrder.length,
        reasoningChars: reasoningParts.join("").length,
      }, "Stream failed after producing content — salvaging the partial result instead of failing the turn");
      finishReason = "length";
    }

    const tool_calls = toolOrder.map((id) => {
      const buf = toolBuffers.get(id)!;
      let args: Record<string, unknown>;
      if (!buf.args.trim()) {
        args = {};
      } else {
        const salvaged = salvageToolCallArguments(buf.args);
        if (salvaged) {
          args = salvaged;
        } else {
          log.warn({ toolName: buf.name, rawArgs: buf.args.slice(0, 200) }, "Failed to parse streamed tool call arguments");
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
    };
  }

  /**
   * Streaming completion with transient-drop resilience. A connection that drops
   * DURING prefill (the long, byte-silent window before the first token on a
   * large prompt) surfaces as "Premature close" and would otherwise kill the
   * whole turn, because — unlike complete() — the streaming path had no retry.
   * We retry ONLY when nothing has been yielded yet (so the consumer never sees
   * duplicated content) and the error is a connection-level drop (not our
   * hard-timeout / inactivity stall, and not an intentional cancel).
   */
  async *stream(
    messages: LLMMessage[],
    tools: LLMToolDef[],
    signal?: AbortSignal,
    options?: { toolChoice?: "auto" | "required" | "none" }
  ): AsyncGenerator<StreamChunk> {
    // A transient CONNECTION drop is always worth one retry, independent of
    // configuredMaxRetries (which governs semantic/API retries and is often 0 on
    // the slow local model). So floor the budget at 2 attempts.
    const maxAttempts = Math.max(2, this.configuredMaxRetries + 1);
    for (let attempt = 1; ; attempt++) {
      let yielded = 0;
      try {
        for await (const chunk of this.streamOnce(messages, tools, signal, options)) {
          yielded++;
          yield chunk;
        }
        return;
      } catch (err) {
        if (yielded === 0 && attempt < maxAttempts && !signal?.aborted && isRetryableStreamError(err)) {
          log.warn(
            { err: String(err), model: this.parseModelId(this.modelConfig.primary), attempt, maxAttempts },
            "transient stream drop before first chunk — retrying",
          );
          continue;
        }
        throw err;
      }
    }
  }

  private async *streamOnce(
    messages: LLMMessage[],
    tools: LLMToolDef[],
    signal?: AbortSignal,
    options?: { toolChoice?: "auto" | "required" | "none" }
  ): AsyncGenerator<StreamChunk> {
    const modelId = this.parseModelId(this.modelConfig.primary);
    const openAIMessages = this.withReasoningSystemLine(modelId, normalizeMessagesForModel(messages, modelId));
    const openAITools: ChatCompletionTool[] = tools.map(t => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));

    // Qwen3.5 thinking-mode: same auto-sampling logic as complete()
    let streamEffectiveTemp = this.modelConfig.temperature;
    let streamEffectiveTopP = this.modelConfig.topP;
    if (streamEffectiveTopP === undefined) {
      const rec = recommendedQwenSampling(modelId, this.modelConfig);
      if (rec) {
        streamEffectiveTemp = rec.temperature;
        streamEffectiveTopP = rec.topP;
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
        // Default "auto"; callers may force "required" to stop the model from
        // emitting a tool-free prose answer when the turn must orchestrate first
        // (source-sensitive / required-research) — that wasted full draft is a
        // multi-minute cost on the slow local model (audit 5d51862f).
        tool_choice: openAITools.length > 0 ? (options?.toolChoice ?? "auto") : undefined,
        temperature: streamEffectiveTemp,
        max_tokens: this.modelConfig.maxTokens,
        ...(streamEffectiveTopP !== undefined && { top_p: streamEffectiveTopP }),
        ...(this.modelConfig.topK !== undefined && { top_k: this.modelConfig.topK }),
        ...(this.modelConfig.minP !== undefined && { min_p: this.modelConfig.minP }),
        ...(this.modelConfig.repeatPenalty !== undefined && { repeat_penalty: this.modelConfig.repeatPenalty }),
        ...(this.modelConfig.seed !== undefined && { seed: this.modelConfig.seed }),
        // Top-level, not extra_body — see buildProviderExtensions.
        ...(this.buildProviderExtensions(modelId) ?? {}),
        stream: true,
        stream_options: { include_usage: true },
      } as Parameters<typeof createStream>[0],
      { signal: s }
    )) as Stream<ChatCompletionChunk>;

    const toolCallBuffers = new Map<number, { id: string; name: string; args: string }>();
    let collectedFinishReason: string | undefined;
    let collectedUsage: StreamChunk["usage"] | undefined;
    const startedAt = Date.now();
    // In-flight visibility: track token progress so the monitor can tell
    // producing (tokens flowing) from prefill (no first token yet) from stalled.
    const callId = beginProviderCall({ model: modelId, mode: "stream" });
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
        if (delta.content || (delta as { reasoning_content?: string }).reasoning_content || delta.tool_calls) {
          recordProviderToken(callId);
        }

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
      endProviderCall(callId);
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
    //
    // Guard with the same hard timeout + bounded retry as chat calls: the SDK
    // timeout is unreliable on a held-open connection, so a stalled embedding
    // server would otherwise hang the agent-index build and every live query
    // embed indefinitely. ProviderHardTimeoutError is terminal (the caller
    // schedules its own retry) so we never retry a hung provider.
    const EMBED_HARD_TIMEOUT_MS = 45_000;
    const EMBED_RETRY_DELAY_MS = 1_000;
    let attempt = 0;
    const maxAttempts = this.configuredMaxRetries + 1;
    for (;;) {
      try {
        const response = await this.withHardTimeout(undefined, EMBED_HARD_TIMEOUT_MS, (s) =>
          this.client.embeddings.create(
            { model: modelId, input: texts, encoding_format: "float" },
            { signal: s },
          ),
        );
        return response.data.map(d => new Float32Array(d.embedding));
      } catch (err) {
        if (err instanceof ProviderHardTimeoutError) throw err;
        attempt++;
        if (attempt >= maxAttempts) throw err;
        await new Promise((r) => setTimeout(r, EMBED_RETRY_DELAY_MS));
      }
    }
  }

  isHealthy(): boolean {
    const staleness = Date.now() - this.lastHealthCheck;
    return this.healthy && staleness < 120000; // 2 min
  }
}
