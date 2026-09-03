import OpenAI from "openai";
import { Agent as UndiciAgent } from "undici";
import type { ChatCompletion, ChatCompletionChunk, ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import type { Stream } from "openai/streaming";
import { childLogger } from "../logger.js";
import type { ModelConfig } from "../config/schema.js";
import { resolveStreamTotalCapMs } from "./stream-budget.js";
import { beginProviderCall, recordProviderToken, endProviderCall } from "../observability/provider-activity-monitor.js";
// The burn threshold is the supervisor's, IMPORTED rather than restated. Copying the
// literal here is how the two would drift, and the whole point of this guard is that it
// fires on exactly the shape agent/progress-verifier.ts already classifies as "burning".
// The dependency is one-way at runtime: progress-verifier's only import from this module
// is `import type`, which is erased.
import {
  MIN_SUBSTANTIVE_OUTPUT_CHARS,
  REASONING_ABSOLUTE_CEILING_CHARS,
  REASONING_LOOP_WINDOW_CHARS,
  REASONING_SAMPLE_INTERVAL_CHARS,
  REASONING_DRIFT_SUSTAINED_SAMPLES,
  detectReasoningLoop,
  detectReasoningDrift,
  deriveTaskAnchors,
} from "../agent/progress-verifier.js";

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

// The total-stream budget lives in its own leaf module (see providers/stream-budget.ts)
// so the sub-agent's pure per-agent resolver can share the constants without importing
// this file's provider chain. Re-exported here because every existing importer reads
// MAX_STREAM_TOTAL_MS from this module.
export {
  BUILDER_MAX_STREAM_TOTAL_MS,
  MAX_STREAM_TOTAL_CEILING_MS,
  MAX_STREAM_TOTAL_MS,
  resolveStreamTotalCapMs,
} from "./stream-budget.js";

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
 * connection failure and should not wait on the silence budget. It is bounded at 10
 * minutes, not 2: on a single-GPU local endpoint the response headers arrive only once
 * the server has accepted and begun the request, so a queued call behind another agent's
 * generation, or a cold model load, legitimately sees nothing for minutes. At 120 s that
 * is a "connection failure" that was neither — the same mistake the sibling bodyTimeout
 * was zeroed for, one field over.
 */
const providerDispatcher = new UndiciAgent({
  bodyTimeout: 0,
  headersTimeout: 600_000,
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

/**
 * Abort reason raised by a caller's own WALL-CLOCK DEADLINE.
 *
 * It is NOT an operator cancel. The run hit its own budget, so whatever the model
 * already produced is still wanted: the provider salvages the partial, the caller
 * relays its evidence. An operator cancel arrives with no such reason and must still
 * discard. That distinction is the whole reason this is a typed reason rather than a
 * bare abort — completeViaStream's salvage keys off `signal.aborted` alone today and
 * would throw away a deadline-truncated partial.
 */
export class DeadlineAbort extends Error {
  readonly isDeadlineAbort = true as const;
  constructor(public readonly deadlineMs: number) {
    super(`Wall-clock deadline of ${deadlineMs}ms reached while a completion was in flight`);
    this.name = "DeadlineAbort";
  }
}

export function isDeadlineAbort(reason: unknown): boolean {
  return typeof reason === "object"
    && reason !== null
    && (reason as { isDeadlineAbort?: unknown }).isDeadlineAbort === true;
}

/**
 * Abort raised by the provider itself when the generation IN FLIGHT is burning:
 * reasoning past the supervisor's budget with no tool call and no answer text.
 *
 * Same contract as DeadlineAbort — the run produced something we still want, so the
 * partial is salvaged rather than thrown away — and deliberately NOT an operator
 * cancel, which must still propagate.
 *
 * It exists because the supervisor could not see this shape at all. It samples
 * BETWEEN iterations and on a timer that reads counters only a RETURNED call updates,
 * so a run parked inside one 20-minute completeViaStream call is invisible to it:
 * measured run 2026-08-17 19:12→19:33, backend_coder, one single stream, 59,418
 * reasoning characters, zero tool calls, zero iterations, and the detector built for
 * exactly that shape never fired once. reasoningChars was only knowable after the
 * stream ended, which is after the 20 minutes had already been spent.
 *
 * The message contains "aborted", which isRetryableStreamError treats as terminal —
 * a burning generation must not be re-issued.
 */
export class ReasoningBurnAbort extends Error {
  readonly isReasoningBurnAbort = true as const;
  constructor(public readonly reasoningChars: number, public readonly contentChars: number) {
    super(
      `LLM stream aborted mid-generation: ${reasoningChars} reasoning characters with no tool call and `
      + `${contentChars} characters of answer text (ceiling ${REASONING_ABSOLUTE_CEILING_CHARS}) `
      + "— the model is thinking, not working",
    );
    this.name = "ReasoningBurnAbort";
  }
}

export function isReasoningBurnAbort(reason: unknown): boolean {
  return typeof reason === "object"
    && reason !== null
    && (reason as { isReasoningBurnAbort?: unknown }).isReasoningBurnAbort === true;
}

/**
 * Live view of what an in-flight stream has produced so far.
 *
 * ONE object per stream, mutated in place and handed to the observer on every chunk —
 * read it, never retain it. Counters only, and that is a requirement rather than a
 * simplification: the observer runs per chunk on the hot path, so it must not copy the
 * reasoning text, allocate, or log.
 */
export interface StreamProgress {
  /** Reasoning characters yielded so far (dedicated deltas AND inline <think> spans). */
  reasoningChars: number;
  /** Answer-text characters yielded so far. Tool-call arguments are NOT counted here —
   *  `toolCallStarted` already says the run reached the productive phase. */
  contentChars: number;
  /** Has the model begun emitting a tool call? The single strongest "this run is
   *  working" signal, and the reason the healthy reference run is untouchable. */
  toolCallStarted: boolean;
  /**
   * Has a CONTENT sample found the reasoning going in circles?
   *
   * The one non-counter field, and the reason the doc above says "counters only" rather
   * than "counters only, no exceptions": deciding on length alone cannot tell a model
   * working hard from a model stuck, so the stream keeps a bounded tail of reasoning
   * (REASONING_LOOP_WINDOW_CHARS, never more) and samples it every
   * REASONING_SAMPLE_INTERVAL_CHARS. Latched: once circling, re-checking cannot unstick it.
   */
  reasoningLoopDetected: boolean;
  /**
   * Highest repeat ratio any content sample has seen (0 = all novel, 1 = pure re-tread).
   *
   * Recorded so the threshold can eventually be FITTED rather than guessed. It is the one
   * constant in progress-verifier.ts with no measured basis, because the audit deliberately
   * keeps reasoning text out of the log — so the number, not the text, is what gets
   * persisted: enough to build a distribution of healthy vs stuck runs, nothing that
   * reconstructs what the model was thinking.
   */
  reasoningRepeatRatio: number;
  /** Has the run sustainedly stopped reasoning about the task? (see detectReasoningDrift) */
  reasoningDriftDetected: boolean;
  /** Lowest task-anchor coverage any sample has seen. Logged for later fitting. */
  reasoningAnchorCoverage: number;
}

/** Options both completion paths accept. Separate from the streaming-only bag below so
 *  callers of completeViaStream cannot accidentally set transport-level switches. */
export interface CompletionCallOptions {
  /** Per-chunk observation of the in-flight generation (see StreamProgress). */
  onProgress?: (progress: Readonly<StreamProgress>) => void;
  /**
   * Does this run hold an operator's unbounded grant? A CALLBACK, not a boolean,
   * because the grant can land WHILE the stream is running (the dock is answered
   * mid-generation) and is consulted only at the moment the burn condition trips —
   * never per chunk.
   */
  isUnbounded?: () => boolean;
}

export interface StreamCallOptions extends CompletionCallOptions {
  toolChoice?: "auto" | "required" | "none";
  /**
   * Arm the mid-stream burn abort. Off by default and set by completeViaStream alone:
   * that is the path with the partial-result salvage, so an abort there costs nothing
   * that was already produced. A raw stream() consumer is handed the OBSERVATION either
   * way and decides for itself.
   */
  guardReasoningBurn?: boolean;
}

/**
 * The burn shape, mid-stream: thinking with nothing behind it.
 *
 * Same three facts agent/progress-verifier.ts's cold arm reads, and the same two
 * constants, so the two cannot disagree about what "burning" means. The healthy
 * reference run is safe on TWO independent counts: its opening think peaked at 23,876
 * characters (0.53x the budget), and it then started a tool call.
 */
export function isReasoningBurn(progress: Readonly<StreamProgress>): boolean {
  if (progress.toolCallStarted) return false;
  if (progress.contentChars >= MIN_SUBSTANTIVE_OUTPUT_CHARS) return false;
  // Content first. Length is the backstop, and it now sits far enough away that reaching it
  // is itself the finding rather than the policy (see REASONING_ABSOLUTE_CEILING_CHARS).
  // A LOOP ABORTS; DRIFT DOES NOT. Re-tread text is worthless by definition, so cutting a
  // loop mid-stream throws away nothing. Drift is the opposite risk: run d5747607 aborted a
  // model 50,045 novel characters into drafting the CSS/JS that would fill its markers, and
  // ~15 minutes of composition died with it. Absence of the task's PROSE vocabulary is not
  // evidence the model is lost when what it is producing is code.
  //
  // So drift stays an OBSERVATION — recorded on the progress object, logged per iteration,
  // and available to the between-iteration supervisor, which acts at a boundary where no
  // in-flight work can be destroyed. The stall rule already stops a run that drifts and
  // then produces nothing; it did exactly that on the measured run, independently.
  return progress.reasoningLoopDetected
    || progress.reasoningChars >= REASONING_ABSOLUTE_CEILING_CHARS;
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

/** Floor on the SILENCE budget, applied to every endpoint. Raised above 300_000 because a
 *  graded-thinking model legitimately emits nothing for ~5 minutes inside one reasoning
 *  block. It replaces the old `20_000 + maxTokens * 25` floor, which produced ~430s for the
 *  (now deleted) 16384-token pins and collapses to the bare configured 30s once maxTokens is
 *  absent — which is why the floor cannot simply be dropped. */
const MIN_PROVIDER_SILENCE_MS = 600_000;

/**
 * The provider's per-chunk SILENCE budget — how long the remote may send nothing
 * at all before we call it hung.
 *
 * It is no longer derived from maxTokens. That coupling was wrong in both directions:
 * it assumed 40 tok/s (25 ms/token) against a measured ~15.3 tok/s, and it meant that
 * raising the output budget silently stretched stall detection from 2 minutes to 15.
 * Now that the completion budget is derived per request there is no constant to derive
 * from, and TOTAL runtime is bounded by the caller's deadline signal, not by this.
 *
 * The floor is NOT waived for a remote endpoint any more, and the note that used to sit
 * here is why. It read: "a self-hosted thinking model reached over a PUBLIC hostname is
 * classified remote and therefore gets its configured budget, not the 10-minute floor —
 * raise providers.<name>.timeoutMs for it, otherwise a legitimate multi-minute reasoning
 * block reads as a stall." That is a documented way to kill healthy work, defaulted ON,
 * fixable only by an operator who has already read this file. `locallyServed: false`
 * collapsed the floor to 0, so the bare configured 30 s became the silence budget and any
 * reasoning block longer than half a minute was a "stall".
 *
 * The remote case it was written for — a DEAD cloud endpoint should hand over to the
 * failover chain in seconds, not minutes — is a connection failure, and connection
 * failures are caught by the dispatcher's headersTimeout above, not by the per-chunk
 * silence budget. Silence AFTER headers is a model thinking, wherever it is hosted.
 */
export function computeOpenAICompatibleRequestTimeoutMs(
  _modelConfig: Partial<Pick<ModelConfig, "maxTokens">>,
  configuredTimeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS,
): number {
  return Math.min(MAX_PROVIDER_TIMEOUT_MS, Math.max(configuredTimeoutMs, MIN_PROVIDER_SILENCE_MS));
}

/**
 * Deliberately pessimistic chars-per-token ratio.
 *
 * There is no tokenizer in this repo (no tiktoken / js-tiktoken / llama-tokenizer
 * dependency), so this is a heuristic. 4.0 is the English-prose average; code, JSON,
 * tool schemas and non-English text run 2.5-3.5. Under-counting the PROMPT is the only
 * error that can push prompt+completion past the served window — and the server's
 * response to that is to truncate the FRONT of the prompt, i.e. the system message —
 * so the divisor must sit at the BOTTOM of that band, not the top. 3.4 was the top of
 * it and under-counted German (~2.8-3.0 on a Qwen tokenizer), which this deployment
 * routes routinely.
 *
 * Known residual: CJK runs ~1-1.5 chars/token and is still under-counted here. A
 * divisor low enough for CJK would over-count Latin prose by ~3x and shrink every
 * request's derived completion budget accordingly, so the honest statement is: this
 * covers Latin-script prose, code and JSON, and the OUTPUT_BUDGET_RESERVE_FRACTION
 * absorbs the remainder. A real tokenizer is the only complete fix.
 */
export const PROMPT_ESTIMATE_CHARS_PER_TOKEN = 3.0;
/** Per-message role/JSON framing the char count cannot see. */
export const PROMPT_ESTIMATE_MESSAGE_OVERHEAD_TOKENS = 8;
/** Slack left unusable by EITHER side, absorbing the heuristic's error. */
export const OUTPUT_BUDGET_RESERVE_FRACTION = 0.08;
export const OUTPUT_BUDGET_MIN_RESERVE_TOKENS = 512;
/** Below this a shrunken request is not worth issuing — let the server refuse honestly. */
export const OUTPUT_BUDGET_FLOOR_TOKENS = 1_024;
/** Fallback window when a config carries a non-numeric/absent contextWindow. Matches
 *  ModelConfigSchema's default so a bad value degrades to the documented behaviour
 *  instead of putting NaN on the wire. */
export const FALLBACK_CONTEXT_WINDOW_TOKENS = 32_768;
/**
 * Completion headroom the INPUT side must leave free.
 *
 * Both trimmers (agent/session.ts for the orchestrator, agent/sub-agent-history.ts for
 * sub-agents) exist to guarantee this much room is still available AFTER the provider
 * takes its own reserve — see computePromptTokenBudget.
 */
export const MIN_USABLE_OUTPUT_TOKENS = 8_192;

/** The context window to budget against: the configured number when it is usable, the
 *  schema default otherwise. `PATCH /api/agents/:name/model` copies `contextWindow`
 *  through a bare allow-list cast, so a null/string/NaN can reach here; before the
 *  budget was derived it was inert, now it would serialise as `max_tokens: null`. */
function usableContextWindow(contextWindow: number): number {
  return Number.isFinite(contextWindow) && contextWindow > 0
    ? Math.floor(contextWindow)
    : FALLBACK_CONTEXT_WINDOW_TOKENS;
}

/**
 * INPUT bound: the largest prompt — measured in PROMPT_ESTIMATE_CHARS_PER_TOKEN tokens,
 * the same unit computeOutputTokenBudget re-measures it in — that still leaves
 * MIN_USABLE_OUTPUT_TOKENS of completion budget after the provider's reserve.
 *
 * A flat `contextWindow * 0.75` could not make that promise: at contextWindow 32768 it
 * leaves 8192 tokens minus the 8% reserve = 5570, and at 8192 the naive
 * `contextWindow - MIN_USABLE_OUTPUT_TOKENS` goes to zero, which makes a trimmer clamp
 * to its minKeep on every single turn. So: take the tighter of 0.75 and the real
 * headroom bound, then never let it fall below half the window.
 */
export function computePromptTokenBudget(contextWindow: number): number {
  const cw = usableContextWindow(contextWindow);
  const providerReserve = Math.max(
    OUTPUT_BUDGET_MIN_RESERVE_TOKENS,
    Math.ceil(cw * OUTPUT_BUDGET_RESERVE_FRACTION),
  );
  const headroomBound = cw - providerReserve - MIN_USABLE_OUTPUT_TOKENS;
  return Math.max(Math.floor(cw * 0.5), Math.min(Math.floor(cw * 0.75), headroomBound));
}

/**
 * Estimate the tokens a request's INPUT will occupy.
 *
 * Unlike agent/session.ts:734 this counts what actually goes on the wire:
 * tool_call arguments (a write_file argument is the single largest thing in a
 * builder agent's history and is invisible to the session-side estimator, which
 * is fed the collapsed view) and the tool schemas.
 */
export function estimatePromptTokensForRequest(
  messages: readonly LLMMessage[],
  tools: readonly LLMToolDef[] = [],
): number {
  let chars = 0;
  for (const message of messages) {
    chars += typeof message.content === "string" ? message.content.length : 0;
    if (message.tool_call_id) chars += message.tool_call_id.length;
    for (const call of message.tool_calls ?? []) {
      chars += call.function.name.length + call.function.arguments.length;
    }
  }
  for (const tool of tools) {
    chars += tool.name.length
      + tool.description.length
      + JSON.stringify(tool.parameters ?? {}).length;
  }
  return Math.ceil(chars / PROMPT_ESTIMATE_CHARS_PER_TOKEN)
    + messages.length * PROMPT_ESTIMATE_MESSAGE_OVERHEAD_TOKENS;
}

/**
 * The completion budget for THIS request: everything the context window has left
 * after the prompt, minus a reserve.
 *
 * This replaces a configured constant. On this API max_tokens is a SHARED
 * reasoning+content budget, so a fixed number does not bound "the answer" — it
 * bounds thinking, and the model is guillotined mid-<think> before it ever emits a
 * tool call. The window is the only genuinely scarce resource; a declared
 * maxTokens is honoured only as a deliberate ceiling on top of it.
 *
 * Every input is guarded for finiteness: this number now goes on the wire as
 * `max_tokens`, and `JSON.stringify` turns a NaN into `null`, which a server either
 * rejects or silently replaces with its own default — a discarded budget nobody logs.
 */
export function computeOutputTokenBudget(input: {
  contextWindow: number;
  estimatedPromptTokens: number;
  declaredMaxTokens?: number;
}): number {
  const contextWindow = usableContextWindow(input.contextWindow);
  const promptTokens = Number.isFinite(input.estimatedPromptTokens)
    ? Math.max(0, input.estimatedPromptTokens)
    : contextWindow; // unknown prompt size — assume it fills the window, fall to the floor
  const reserve = Math.max(
    OUTPUT_BUDGET_MIN_RESERVE_TOKENS,
    Math.ceil(contextWindow * OUTPUT_BUDGET_RESERVE_FRACTION),
  );
  const derived = contextWindow - promptTokens - reserve;
  const budget = Math.max(OUTPUT_BUDGET_FLOOR_TOKENS, derived);
  const declared = input.declaredMaxTokens;
  return typeof declared === "number" && Number.isFinite(declared) && declared > 0
    ? Math.min(Math.floor(declared), budget)
    : budget;
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

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** True when these numbers were NOT reported by the provider but reconstructed from
   *  the produced text (the salvage path — a cut stream never delivers the usage
   *  chunk). Cost and budget code can still spend them, but must not present them as
   *  metered. */
  estimated?: boolean;
  /** The share of `completionTokens` that is chain-of-thought rather than answer text
   *  or tool-call arguments. `completionTokens` stays whole (reasoning IS billed as
   *  completion), but a progress/stall check needs to tell "the model is thinking in
   *  circles" from "the model is producing output" — subtract this to get the latter.
   *  Only populated where the split is actually known (currently the salvage path). */
  reasoningTokens?: number;
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
  usage: LLMUsage;
  finishReason: string;
  /** Set when the response is known-incomplete and WHY. `finishReason: "length"` alone
   *  is ambiguous now: it is the real provider value on a genuine budget stop, and a
   *  fabricated one on the salvage path. Filling usage on salvage removes the accidental
   *  `completionTokens === 0` discriminator, so state it explicitly instead.
   *  `reasoning_burn` is the provider's own mid-stream stop (see ReasoningBurnAbort) —
   *  the caller must wind the run down, not retry it. */
  truncatedBy?: "output_budget" | "deadline" | "transport" | "reasoning_burn";
}

export interface StreamChunk {
  type: "text_delta" | "reasoning_delta" | "tool_call_start" | "tool_call_delta" | "done";
  content?: string;
  toolCallId?: string;
  toolName?: string;
  argumentsDelta?: string;
  finishReason?: string;
  usage?: LLMUsage;
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
 *  The 3.5/3.6 half of that sentence was wrong, and was measured wrong on
 *  2026-09-03: `enable_thinking:false` is inert on qwen3.6-35b-a3b too (identical
 *  reasoning to sending no control at all). The family split still holds — it
 *  decides which control is DOCUMENTED for the model — but the enable_thinking
 *  branch now sends `reasoning_effort` alongside the flag, so both generations
 *  actually stop thinking on this backend. See resolveThinkingControls. */
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

/**
 * The value actually put on the wire for `reasoning_effort`.
 *
 * An older LM Studio warned that only xhigh|medium|low were valid for the per-model
 * REASONING LEVEL CONFIG FIELD:
 *
 *   [WARN] Reasoning setting 'off' is not a valid option for reasoning level field
 *   '…qwen.qwen3.8-27b.reasoningEffort'. Valid options are: xhigh, medium, low.
 *   Skipping this field.
 *
 * That warning was read as a constraint on the API too, so "none" was folded to "low" and
 * every caller asking for no thinking got thinking. The API is its own surface and says so:
 * sending an invalid value returns 400 `Invalid 'reasoning_effort' value: 'off'. Supported
 * values: none, minimal, low, medium, high, xhigh.` Measured on qwen3.6-35b-a3b the difference
 * between the two is total — "low" 1,752 reasoning chars in 6.5 s, "none" 0 chars in 0.39 s.
 * So the requested value goes out as itself, and effortForEndpoint steps it down only if a
 * particular endpoint has actually refused it.
 *
 * "Skipping this field" is the dangerous part. A rejected value does not mean "no
 * thinking" — it means NO SETTING, so the model falls back to its own default, and
 * that default is xhigh: the rung measured at 9,034 reasoning characters and 183s,
 * which hits the completion cap. Sending "none" therefore did the exact opposite of
 * what it asked for, and silently: the agents configured as thinking-off (the
 * receptionist fast lane, content_writer) were the ones most likely to be running
 * the slowest setting available.
 *
 * So "none" goes on the wire as "low" — the lowest VALID rung, ~1.3k reasoning
 * characters. A valid field is always present, so nothing silently inherits xhigh.
 *
 * There is no true OFF for this model on this backend, and the code should not
 * pretend otherwise. chat_template_kwargs.enable_thinking:false was measured to have
 * NO effect on qwen3.8 here (2,892 / 6,040 reasoning characters across two runs
 * against a 4,395 / 6,789 baseline), and reasoning_effort has no "none". "low" is
 * the floor. Config may still say "none" — it reads as the intent, "as little
 * reasoning as possible" — but it resolves to the cheapest rung the server accepts,
 * not to silence.
 */
function wireQwenEffort(effort: ReasoningEffort): WireEffort {
  if (effort === "xhigh" || effort === "high") return "xhigh";
  if (effort === "medium") return "medium";
  if (effort === "low") return "low";
  return "none";
}

/** What goes on the wire for `reasoning_effort`. */
export type WireEffort = "none" | "low" | "medium" | "xhigh";

/**
 * Endpoints that rejected a `reasoning_effort` value, by base URL.
 *
 * An older LM Studio accepted only xhigh|medium|low and answered 400 for anything else; the
 * build measured here (2026-09-03) answers `Invalid 'reasoning_effort' value: 'off'. Supported
 * values: none, minimal, low, medium, high, xhigh.` So the correct value is sent first, and a
 * backend that refuses it says so once — after which every later call to that endpoint steps
 * down the ladder instead of failing.
 */
const _rejectedEfforts = new Map<string, Set<string>>();

export function noteRejectedReasoningEffort(endpoint: string, value: string): void {
  let set = _rejectedEfforts.get(endpoint);
  if (!set) { set = new Set(); _rejectedEfforts.set(endpoint, set); }
  set.add(value);
}

/** Test-only: forget what endpoints have rejected. */
export function _resetRejectedReasoningEffortsForTests(): void {
  _rejectedEfforts.clear();
}

/**
 * The value to send now: the requested one, or the next rung down if this endpoint has already
 * refused it. "none" steps down to "low" (thinking on, but the request succeeds) and then to
 * nothing at all — a degradation, never a hard failure.
 */
export function effortForEndpoint(endpoint: string, effort: WireEffort): WireEffort | undefined {
  const rejected = _rejectedEfforts.get(endpoint);
  if (!rejected) return effort;
  const ladder: WireEffort[] = effort === "none" ? ["none", "low"] : [effort];
  for (const rung of ladder) if (!rejected.has(rung)) return rung;
  return undefined;
}

/** True for the provider error that says this endpoint will not take that reasoning_effort. */
export function isRejectedReasoningEffortError(err: unknown): boolean {
  const status = (err as { status?: number } | undefined)?.status;
  if (status !== 400) return false;
  const message = String((err as { message?: unknown } | undefined)?.message ?? "");
  return /reasoning_effort/i.test(message);
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
      // One control, and the value the server names as valid. enable_thinking is NOT sent for
      // this family: measured inert on qwen3.8 here, so it would be a field that looks like an
      // off-switch while doing nothing — worse than no field at all.
      return { reasoningEffort: wireQwenEffort(effort) };
    }
    case "enable_thinking": {
      // BOTH CONTROLS, because on this backend the documented one does nothing. Measured
      // 2026-09-03 against qwen/qwen3.6-35b-a3b on LM Studio, judge-shaped prompt, 400-token cap:
      //   no control                     1,678 reasoning chars, 400 reasoning tokens, 6.8 s, EMPTY answer
      //   enable_thinking:false          1,678 / 400 / 6.5 s, EMPTY answer  ← byte-identical to no control
      //   reasoning_effort:"none"            0 /   0 / 0.35 s, "YES"
      // So the flag is not merely slow, it is inert: the verdict calls it was meant to make cheap
      // were still reasoning, and reasoning ate the whole token budget so they returned nothing.
      // The flag is still sent — vLLM and Qwen's own card honour it, and it is the documented
      // mechanism — with the effort field alongside for backends that honour that instead.
      const effort = cfg.reasoningEffort
        ? normalizeQwenEffort(cfg.reasoningEffort)
        : cfg.enableThinking === false ? "none" : undefined;
      const thinkingOff = cfg.enableThinking === false || effort === "none";
      return {
        ...(cfg.enableThinking !== undefined ? { chatTemplateKwargs: { enable_thinking: cfg.enableThinking } } : {}),
        // Only ever sent to turn thinking DOWN. Forcing a level upward is the model's own default
        // here, and a graded level is not part of this family's documented contract.
        ...(thinkingOff && effort ? { reasoningEffort: wireQwenEffort(effort) } : {}),
      };
    }
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
  completeViaStream?(messages: LLMMessage[], tools: LLMToolDef[], signal?: AbortSignal, options?: CompletionCallOptions): Promise<LLMResponse>;
  stream(messages: LLMMessage[], tools: LLMToolDef[], signal?: AbortSignal, options?: StreamCallOptions): AsyncGenerator<StreamChunk>;
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
  /** Per-agent total-stream backstop, resolved from the ModelConfig (see resolveStreamTotalCapMs). */
  private readonly maxStreamTotalMs: number;
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
    // Same derivation shape as requestTimeoutMs above: read off the ModelConfig, not
    // off the endpoint options, because the backstop is a property of the AGENT's run,
    // not of the endpoint.
    this.maxStreamTotalMs = resolveStreamTotalCapMs(modelConfig);
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
  /**
   * Learn from a `reasoning_effort` rejection: record it against this endpoint so the retry — and
   * every later call — sends the next rung down instead. Returns true when it recorded one, which
   * also tells the caller this failure is worth retrying.
   */
  private noteReasoningEffortRejection(modelId: string, err: unknown): boolean {
    if (!isRejectedReasoningEffortError(err)) return false;
    const requested = resolveThinkingControls(modelId, this.modelConfig).reasoningEffort;
    const sent = requested ? effortForEndpoint(this.baseUrl, requested as WireEffort) : undefined;
    if (!sent) return false;
    noteRejectedReasoningEffort(this.baseUrl, sent);
    log.warn({ endpoint: this.baseUrl, model: modelId, value: sent },
      "Endpoint rejected this reasoning_effort — stepping down for the retry and every later call");
    return true;
  }

  private buildProviderExtensions(modelId: string): Record<string, unknown> | undefined {
    const fields: Record<string, unknown> = {};
    const controls = resolveThinkingControls(modelId, this.modelConfig);
    if (controls.chatTemplateKwargs) {
      fields["chat_template_kwargs"] = controls.chatTemplateKwargs;
    }
    if (controls.reasoningEffort) {
      // Stepped down if THIS endpoint has already refused the value (see effortForEndpoint);
      // an older LM Studio takes only xhigh|medium|low, and a 400 must not end a turn.
      const wire = effortForEndpoint(this.baseUrl, controls.reasoningEffort as WireEffort);
      if (wire) fields["reasoning_effort"] = wire;
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

  /** Per-request completion budget. Estimated on the pre-normalisation messages;
   *  foldSystemMessages only merges/relabels, it does not change the byte count, and
   *  withReasoningSystemLine's one extra line is inside the reserve.
   *
   *  KNOWN LIMIT — `this.modelConfig.contextWindow` describes the model the OPERATOR
   *  configured, not necessarily the model this endpoint serves. providers/index.ts
   *  spreads one ModelConfig across every endpoint of a failover chain
   *  (createChatProvider) and overrides only `primary` for the tier ladder
   *  (getChatProviderForTier), so a small routing/fallback model can be handed a budget
   *  derived from the big model's window and ask a server for more than it serves.
   *  While max_tokens was a fixed small constant that was harmless; now it sizes the
   *  request. The fix belongs where the per-endpoint config is built (a per-endpoint
   *  `contextWindow`), not here — this class is handed one number and has no way to
   *  learn the served window without probing the endpoint. */
  private resolveMaxTokens(messages: readonly LLMMessage[], tools: readonly LLMToolDef[]): number {
    return computeOutputTokenBudget({
      contextWindow: this.modelConfig.contextWindow,
      estimatedPromptTokens: estimatePromptTokensForRequest(messages, tools),
      declaredMaxTokens: this.modelConfig.maxTokens,
    });
  }

  // The OpenAI SDK's `timeout` option has been observed not to fire when
  // LM Studio holds the HTTP connection open without sending data (we saw a
  // single `complete()` call run for 20 min past a 5-min SDK timeout). This
  // wrapper composes the caller's signal with a setTimeout-based abort so
  // every attempt has a true wall-clock ceiling we control.
  //
  // SIGNAL LIFETIME — the composition is AbortSignal.any, deliberately, and the
  // only thing this function cleans up is its own timer.
  //
  // The previous version bridged parent → a LOCAL controller with
  // addEventListener and unhooked it in `finally`. For a non-streaming call that
  // is harmless (the response is fully materialized when `fn` resolves), but at
  // the STREAMING call site `fn` resolves the moment the HTTP stream is OPEN —
  // before a single chunk is read. The unhook therefore ran at chunk zero and
  // orphaned the very controller the SDK was holding (openai v4 core.js
  // fetchWithTimeout reaches the real fetch controller ONLY by listening on
  // `options.signal`). From that instant the turn deadline, an operator STOP and
  // the inactivity timer all aborted a controller with no listeners, and the only
  // thing that could still stop the stream was the total-budget guillotine —
  // which is exactly why run f08195d2's agents died at MAX_STREAM_TOTAL_MS to the
  // millisecond.
  //
  // AbortSignal.any keeps the link alive for the lifetime of the composed signal
  // itself, so there is no un-hook step left that can run too early. Clearing a
  // timer cannot sever anything, so this class of bug has nowhere left to hide.
  private async withHardTimeout<T>(
    parentSignal: AbortSignal | undefined,
    timeoutMs: number,
    fn: (combinedSignal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const timeoutAc = new AbortController();
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      timeoutAc.abort(new Error(`LLM call exceeded hard timeout of ${timeoutMs}ms`));
    }, timeoutMs);

    const combined = parentSignal
      ? AbortSignal.any([parentSignal, timeoutAc.signal])
      : timeoutAc.signal;

    try {
      return await fn(combined);
    } catch (err) {
      // Distinguish OUR wall-clock timeout from an external/parent cancel so
      // the retry loop can treat it as terminal (a hung provider must not be
      // retried — see ProviderHardTimeoutError).
      if (timedOut && !parentSignal?.aborted) {
        throw new ProviderHardTimeoutError(timeoutMs);
      }
      throw err;
    } finally {
      // ONLY the timer. Disarming the open-phase ceiling must never disarm the
      // caller's ability to abort what the open phase produced.
      clearTimeout(timer);
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
        // `requestTimeoutMs` is a SILENCE budget — the streaming path re-arms it on every
        // chunk. This path has no chunks, so the same number becomes a bound on the whole
        // generation, and at the configured 30 s→600 s floor that is far too tight for the
        // calls that land here: the progress judge, the rescue prompts and the forced
        // timeout synthesis. A terminal ProviderHardTimeoutError on those discards exactly
        // the evidence they exist to preserve. Floored at 15 min (the same
        // MAX_PROVIDER_TIMEOUT_MS this deployment already tolerates for silence) so a truly
        // hung remote still ends, and still `+5000` so the SDK's own timeout wins the race
        // and reports the more specific error.
        const hardTimeoutMs = Math.max(this.requestTimeoutMs, MAX_PROVIDER_TIMEOUT_MS) + 5000;
        const response = await this.withHardTimeout(signal, hardTimeoutMs, (s) => this.client.chat.completions.create(
          {
            model: modelId,
            messages: openAIMessages,
            tools: openAITools.length > 0 ? openAITools : undefined,
            tool_choice: openAITools.length > 0 ? "auto" : undefined,
            temperature: effectiveTemp,
            max_tokens: this.resolveMaxTokens(messages, tools),
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
          // The provider's own budget stop, as opposed to the fabricated "length"
          // completeViaStream sets when it salvages a cut stream.
          ...(choice.finish_reason === "length" ? { truncatedBy: "output_budget" as const } : {}),
        };
      } catch (err: unknown) {
        endProviderCall(callId);
        this.recordRequestFailure(startedAt, err);
        this.noteReasoningEffortRejection(modelId, err);
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
    options?: CompletionCallOptions,
  ): Promise<LLMResponse> {
    let content = "";
    const reasoningParts: string[] = [];
    const toolBuffers = new Map<string, { id: string; name: string; args: string }>();
    const toolOrder: string[] = [];
    let finishReason = "stop";
    let truncatedBy: LLMResponse["truncatedBy"];
    let usage: LLMUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    try {
      // guardReasoningBurn is set HERE and only here: this is the path that salvages,
      // so a mid-stream abort keeps everything already produced.
      for await (const chunk of this.stream(messages, tools, signal, { ...options, guardReasoningBurn: true })) {
        // Second consumer-side abort check (streamOnce has the first). This is the
        // last loop between the transport and the caller, so it is the backstop
        // that holds even if a provider implementation of stream() has neither a
        // live signal nor its own check. The throw lands in the catch below, where
        // the SAME classification runs: DeadlineAbort → salvage, operator → rethrow.
        if (signal?.aborted) {
          throw signal.reason instanceof Error
            ? signal.reason
            : new Error(`LLM stream aborted by the caller: ${String(signal.reason)}`);
        }
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
            // The provider's OWN "length" — the request's max_tokens was reached.
            // Distinct from the fabricated "length" the salvage path below sets.
            if (finishReason === "length") truncatedBy = "output_budget";
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
      // A DEADLINE abort is not an operator cancel: the run hit its own wall clock,
      // and with no token ceiling that deadline is now the ONLY bound — so it fires
      // routinely on healthy long generations, and discarding their output would
      // convert every long run into a total loss.
      // A BURN abort is the same case one step earlier: this provider stopped a
      // generation that was producing nothing but chain-of-thought. The reasoning is
      // still the only evidence the run leaves behind, so it salvages exactly as a
      // deadline does — and it is never an operator cancel, so the check below cannot
      // mistake it for one (the caller's signal is untouched; streamAc carried it).
      const burned = isReasoningBurnAbort(err);
      const operatorCancelled = signal?.aborted === true && !isDeadlineAbort(signal.reason);
      const salvageable = content.trim().length > 0 || toolOrder.length > 0 || reasoningParts.length > 0;
      if (!salvageable || operatorCancelled) throw err;
      log.warn({
        err: err instanceof Error ? err.message : String(err),
        contentChars: content.length,
        toolCalls: toolOrder.length,
        reasoningChars: reasoningParts.join("").length,
        reasoningBurn: burned,
      }, "Stream failed after producing content — salvaging the partial result instead of failing the turn");
      // Usage arrives only in the final empty-choices chunk, which a cut stream never
      // reaches — so a salvaged run reported completionTokens: 0, and the cost
      // aggregator (observability/cost.ts prices promptTokens and completionTokens
      // SEPARATELY) under-reported the call to nothing.
      //
      // Both sides are reconstructed, not just the completion side: leaving
      // promptTokens at 0 would keep totalTokens wrong by the whole prompt — on a
      // 28k-token prompt that is a 3-4x under-count of the call, repeated on every
      // salvaged iteration, silently keeping a run under its budget threshold. The
      // prompt is estimated with the same heuristic resolveMaxTokens already used to
      // size this very request, so the two numbers at least agree with each other.
      //
      // `estimated: true` marks the whole record as reconstructed so downstream cost
      // code can tell metered numbers from inferred ones, and `reasoningTokens`
      // preserves the discriminator the old `completionTokens === 0` accidentally
      // provided: a run that emits ONLY chain-of-thought and never a tool call is
      // stalled, not progressing, and a stall check must be able to see that
      // (agent/progress-verifier.ts isHardStall reads the completion counter alone).
      if (usage.completionTokens === 0 || usage.promptTokens === 0) {
        const reasoningChars = reasoningParts.join("").length;
        const outputChars = content.length
          + toolOrder.reduce((sum, id) => sum + (toolBuffers.get(id)?.args.length ?? 0), 0);
        const estimatedReasoning = Math.ceil(reasoningChars / PROMPT_ESTIMATE_CHARS_PER_TOKEN);
        const completionTokens = usage.completionTokens > 0
          ? usage.completionTokens
          : estimatedReasoning + Math.ceil(outputChars / PROMPT_ESTIMATE_CHARS_PER_TOKEN);
        const promptTokens = usage.promptTokens > 0
          ? usage.promptTokens
          : estimatePromptTokensForRequest(messages, tools);
        usage = {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
          estimated: true,
          reasoningTokens: Math.min(estimatedReasoning, completionTokens),
        };
      }
      truncatedBy = burned ? "reasoning_burn" : isDeadlineAbort(signal?.reason) ? "deadline" : "transport";
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
      ...(truncatedBy ? { truncatedBy } : {}),
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
    options?: StreamCallOptions
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
        const effortRejected = this.noteReasoningEffortRejection(this.parseModelId(this.modelConfig.primary), err);
        if (yielded === 0 && attempt < maxAttempts && !signal?.aborted && (effortRejected || isRetryableStreamError(err))) {
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
    options?: StreamCallOptions
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
    //
    // streamAc carries the PROVIDER-side aborts (total-budget cap, inactivity
    // stall); it is composed with the caller's signal exactly once, and that
    // composed signal is what reaches the SDK and stays linked for the whole
    // life of the stream. Composed with AbortSignal.any rather than a hand-rolled
    // listener pair for the reason spelled out on withHardTimeout: there is then
    // no un-hook step that a `finally` can run at the wrong moment and leave the
    // caller unable to stop an open stream.
    const streamAc = new AbortController();
    const streamSignal = signal ? AbortSignal.any([signal, streamAc.signal]) : streamAc.signal;

    const createStream = this.client.chat.completions.create.bind(this.client.chat.completions);
    const stream = await this.withHardTimeout(streamSignal, this.requestTimeoutMs + 5000, (s) => createStream(
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
        max_tokens: this.resolveMaxTokens(messages, tools),
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

    // MID-STREAM VISIBILITY. Allocated ONCE and mutated in place — the observer sees
    // this same object on every chunk, which is what keeps the hot path free of
    // per-chunk allocation. Nothing outside this generator could previously learn any
    // of these three numbers until the call returned, which for the measured failure
    // was 20.7 minutes after they stopped being useful.
    const progress: StreamProgress = { reasoningChars: 0, contentChars: 0, toolCallStarted: false, reasoningLoopDetected: false, reasoningRepeatRatio: 0, reasoningDriftDetected: false, reasoningAnchorCoverage: 1 };
    // The task's own vocabulary, taken from the FIRST user turn — that is the request; later
    // user turns are tool results and corrections, which carry their own words.
    const taskAnchors = deriveTaskAnchors(
      String(messages.find((m) => m.role === "user")?.content ?? ""),
    );
    let consecutiveDriftSamples = 0;
    // Bounded tail of reasoning for the content sampler. Never exceeds the window, so the
    // memory held is ~12 KB regardless of how long the generation runs.
    let reasoningTail = "";
    let charsSinceLoopSample = 0;
    const sampleReasoningForLoop = (delta: string): void => {
      if (progress.reasoningLoopDetected || !options?.guardReasoningBurn) return;
      reasoningTail = (reasoningTail + delta).slice(-REASONING_LOOP_WINDOW_CHARS);
      charsSinceLoopSample += delta.length;
      if (charsSinceLoopSample < REASONING_SAMPLE_INTERVAL_CHARS) return;
      charsSinceLoopSample = 0;
      const drift = detectReasoningDrift(taskAnchors, reasoningTail);
      progress.reasoningAnchorCoverage = Math.min(progress.reasoningAnchorCoverage, drift.coverage);
      consecutiveDriftSamples = drift.drifting ? consecutiveDriftSamples + 1 : 0;
      if (consecutiveDriftSamples >= REASONING_DRIFT_SUSTAINED_SAMPLES && !progress.reasoningDriftDetected) {
        progress.reasoningDriftDetected = true;
        log.warn(
          { model: modelId, reasoningChars: progress.reasoningChars, anchorCoverage: Number(drift.coverage.toFixed(3)) },
          "Reasoning has lost the thread — the task's own vocabulary has been absent for several samples",
        );
      }
      const verdict = detectReasoningLoop(reasoningTail);
      progress.reasoningRepeatRatio = Math.max(progress.reasoningRepeatRatio, verdict.repeatRatio);
      if (verdict.looping) {
        progress.reasoningLoopDetected = true;
        log.warn(
          { model: modelId, reasoningChars: progress.reasoningChars, repeatRatio: Number(verdict.repeatRatio.toFixed(3)) },
          "Reasoning is re-treading ground — content sample says this generation is circling",
        );
      }
    };

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

    // TOTAL wall-clock cap, separate from the inactivity guard above.
    //
    // armInactivity only catches SILENCE, and it re-arms on every chunk — so a model
    // that streams continuously is never "stalled" no matter how long it runs. A
    // graded-thinking model can talk to itself indefinitely: an observed backend_coder
    // run emitted 97,714 characters of reasoning over 36 MINUTES, called zero tools,
    // and stopped only when the completion budget ran out. Its agent had a 600s turn
    // timeout; nothing enforced it against a call that was healthily producing tokens.
    //
    // This bounds the call itself. Paired with the partial-result salvage in
    // completeViaStream, hitting the cap keeps whatever was produced rather than
    // discarding the run.
    const streamStartedAt = Date.now();
    // NO-SIGNAL BACKSTOP ONLY — see the `signal === undefined` guard on the check below.
    //
    // This comment has always said the cap exists "so a caller that passes NO signal
    // still cannot hang forever", but the check ran unconditionally, so it was the one
    // wall clock a granted-unbounded run could not escape: an operator grant suspends the
    // sub-agent deadline and the runtime turn deadline, and this fired anyway. Gating on
    // the ABSENCE of a signal makes the stated scope real, and makes the grant reach here
    // by construction rather than by a flag the provider would have to be told about.
    //
    // Why that is sound rather than a hole (traced, not assumed): agent/runtime.ts always
    // composes a signal for a turn — wardenAbort is pushed unconditionally — and
    // agent/sub-agent.ts's composeLlmSignal returns that inherited `opts.signal` even for
    // an agent declaring `turnTimeoutMs: "unbound"`. So every delegated call arrives with a
    // signal, and the only callers left on this branch are the out-of-turn ones (a script,
    // a warm-up, a test double) that genuinely state no deadline — exactly the population
    // the backstop was written for.
    //
    // Historical note on the value: the old `Math.max(this.requestTimeoutMs, …)` was dead
    // code (requestTimeoutMs is clamped to MAX_PROVIDER_TIMEOUT_MS, always below the
    // constant). It scales per AGENT off the ModelConfig now — see resolveAgentStreamCapMs
    // in agent/sub-agent-model-config.ts.
    const totalCapMs = this.maxStreamTotalMs;

    try {
      for await (const chunk of stream) {
        // BELT AND BRACES over the composed signal above. The signal is what
        // actually tears the transport down; this makes the CONSUMER stop too, so
        // a future transport that quietly ignores its signal still cannot run past
        // the caller's deadline. Re-throwing the signal's own reason keeps the
        // existing classification intact downstream: completeViaStream reads
        // `signal.reason`, so a DeadlineAbort salvages the partial and an operator
        // cancel re-throws.
        if (signal?.aborted) {
          throw signal.reason instanceof Error
            ? signal.reason
            : new Error(`LLM stream aborted by the caller: ${String(signal.reason)}`);
        }
        if (signal === undefined && Date.now() - streamStartedAt > totalCapMs) {
          // THROW, do not break. A `break` leaves the try block normally: the catch
          // below never runs, recordRequestSuccess() fires, collectedFinishReason is
          // still undefined so `?? "stop"` reports a CLEAN STOP, and collectedUsage is
          // still undefined so the caller records {0,0,0} tokens. A guillotined
          // generation was being laundered into a successful one that no downstream
          // gate, scorecard or audit record could distinguish from a finished answer.
          // Throwing routes it through the catch (health counters see a failure) and
          // then through completeViaStream's salvage, which keeps the partial.
          const capErr = new Error(
            `LLM stream exceeded its total budget of ${Math.round(totalCapMs / 1000)}s while still producing output `
            + "— the model is generating without converging (most often a runaway reasoning block)",
          );
          streamAc.abort(capErr);
          throw capErr;
        }
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
          progress.reasoningChars += reasoningDelta.length; sampleReasoningForLoop(reasoningDelta);
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
                if (text) { progress.reasoningChars += text.length; sampleReasoningForLoop(text); yield { type: "reasoning_delta", content: text }; }
                text = "";
              } else {
                const inner = text.slice(0, close);
                if (inner) { progress.reasoningChars += inner.length; sampleReasoningForLoop(inner); yield { type: "reasoning_delta", content: inner }; }
                text = text.slice(close + "</think>".length);
                insideThink = false;
              }
            } else {
              const open = text.indexOf("<think>");
              if (open === -1) {
                if (text) { progress.contentChars += text.length; yield { type: "text_delta", content: text }; }
                text = "";
              } else {
                const before = text.slice(0, open);
                if (before) { progress.contentChars += before.length; yield { type: "text_delta", content: before }; }
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
              progress.toolCallStarted = true;
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

        // Hand the caller this chunk's reading. Cheap by contract: one call, no
        // allocation, no logging — see StreamProgress.
        options?.onProgress?.(progress);

        // THE BURN ABORT. The one pathology no clock upstream can catch, because the
        // call never returns to be judged: reasoning past the supervisor's budget with
        // no tool call started and effectively no answer text.
        //
        // The operator's unbounded grant outranks it, and is read HERE rather than
        // captured at call time so a grant answered mid-generation still lands. It is
        // only consulted once the burn shape holds, so a granted run pays nothing per
        // chunk and an ungranted healthy run never reaches the question at all.
        //
        // THROW, do not break — for the identical reason spelled out on the total-cap
        // check above: a break would report a guillotined generation as a clean stop.
        // Aborting streamAc first tears the transport down so the remote stops
        // generating, then the throw routes through completeViaStream's salvage.
        // THE GRANT WAIVES LENGTH, NOT PATHOLOGY.
        //
        // An operator answering the dock is saying "this may take as long as it needs" —
        // they are not saying "keep going even if it is going in circles", and run db88fa5b
        // is what conflating those costs: the grant disarmed the whole guard and one
        // iteration then spent 80,810 characters and 29 minutes to move a single <div>.
        // So a detected loop still trips through a grant; only the resource ceiling yields.
        if (
          options?.guardReasoningBurn
          && isReasoningBurn(progress)
          && (progress.reasoningLoopDetected || !(options.isUnbounded?.() ?? false))
        ) {
          const burnErr = new ReasoningBurnAbort(progress.reasoningChars, progress.contentChars);
          log.warn(
            { model: modelId, reasoningChars: progress.reasoningChars, contentChars: progress.contentChars, elapsedMs: Date.now() - streamStartedAt },
            "Aborting an in-flight generation that is burning reasoning with nothing behind it",
          );
          streamAc.abort(burnErr);
          throw burnErr;
        }
      }
    } catch (err) {
      this.recordRequestFailure(startedAt, err);
      // The burn abort is this provider's OWN typed decision and the caller classifies
      // on its identity (unlike a deadline, which survives on signal.reason). Wrapping
      // it in a generic Error — what every other failure here gets — would erase that
      // and leave the salvage unable to tell it from a transport drop.
      if (isReasoningBurnAbort(err)) throw err;
      log.error({ err, model: modelId }, "OpenAI-compatible streaming failed");
      throw new Error(`OpenAI-compatible stream failed (model: ${modelId}): ${String(err)}`);
    } finally {
      endProviderCall(callId);
      if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
      // No listener to unhook: streamSignal is an AbortSignal.any composite, which
      // the platform holds weakly and drops with the stream itself.
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
