/**
 * LLM boundary transformers — extension hooks on the wire between the swarm
 * and any chat provider (docs/fork-boilerplate-plan.md; built for the MFA
 * fork's DSGVO pseudonymization, generic by design).
 *
 * Every provider built by createChatProvider() is wrapped so that:
 * - `beforeRequest` sees the outbound message view of complete(),
 *   completeViaStream(), AND stream() — nothing leaves to a model without
 *   passing the transformers. The raw session history is untouched; only the
 *   provider-bound copy is transformed.
 * - `afterResponse` sees the model's text content (and reasoning) on the
 *   non-streaming paths before any caller stores or displays it.
 * - `createStreamTransform` (optional) transforms streaming text/reasoning
 *   deltas with cross-chunk buffering, so a replacement marker split across
 *   deltas ("[PAT" + "IENT_A]") is handled. Without it, streaming deltas pass
 *   through untouched — still privacy-safe (the sensitive OUTBOUND direction is
 *   always covered by beforeRequest).
 *
 * Transformer state (e.g. a pseudonym map) is the extension's own concern;
 * `ctx.stateKey` provides a stable per-user key (falls back to "global" when
 * no request context is active). Hook errors fail open with a log: a broken
 * transformer must not take the model path down — except `beforeRequest`,
 * which fails CLOSED (an outbound transform that throws may mean unredacted
 * data; the request is aborted).
 */

import { childLogger } from "../logger.js";
import { currentUserId } from "../runtime/request-context.js";
import type { ChatProvider, CompletionCallOptions, LLMMessage, LLMResponse, LLMToolDef, StreamCallOptions, StreamChunk } from "./lmstudio.js";

const log = childLogger("llm-boundary");

export interface LlmBoundaryContext {
  /** Stable key for transformer-managed state: the authenticated user id, or "global". */
  stateKey: string;
}

export interface LlmBoundaryTransformer {
  /**
   * Transform the outbound message view. Return the (possibly new) array.
   * Throwing ABORTS the provider call (fail closed — outbound is the
   * sensitive direction).
   */
  beforeRequest?(messages: LLMMessage[], ctx: LlmBoundaryContext): LLMMessage[];
  /** Transform inbound model text (content + reasoning) on non-streaming paths. Fails open. */
  afterResponse?(text: string, ctx: LlmBoundaryContext): string;
  /**
   * Factory for a per-stream, stateful inbound transform on the streaming path.
   * When present, streamed text and reasoning deltas are piped through it (each
   * gets its OWN instance) with cross-chunk buffering, and flush() drains the
   * tail when the stream ends. Fails open.
   */
  createStreamTransform?(ctx: LlmBoundaryContext): LlmStreamTransform;
}

export interface LlmStreamTransform {
  /** Feed a streamed delta; return the text safe to emit now (buffer the rest). */
  push(delta: string): string;
  /** Drain any buffered tail — called once when the stream ends. */
  flush(): string;
}

const _transformers: Array<{ source: string; transformer: LlmBoundaryTransformer }> = [];

/** @internal extension-loader-only. */
export function registerLlmBoundaryTransformer(source: string, transformer: LlmBoundaryTransformer): void {
  _transformers.push({ source, transformer });
}

/** Test hook. */
export function _resetLlmBoundaryForTests(): void {
  _transformers.length = 0;
}

function boundaryContext(): LlmBoundaryContext {
  return { stateKey: currentUserId() ?? "global" };
}

function applyBeforeRequest(messages: LLMMessage[]): LLMMessage[] {
  if (_transformers.length === 0) return messages;
  const ctx = boundaryContext();
  let view = messages;
  for (const { transformer } of _transformers) {
    if (!transformer.beforeRequest) continue;
    // No try/catch: outbound transforms fail closed by design.
    view = transformer.beforeRequest(view === messages ? messages.map((m) => ({ ...m })) : view, ctx);
  }
  return view;
}

function applyAfterResponse(response: LLMResponse): LLMResponse {
  if (_transformers.length === 0) return response;
  const ctx = boundaryContext();
  let content = response.content;
  let reasoning = response.reasoning;
  for (const { source, transformer } of _transformers) {
    if (!transformer.afterResponse) continue;
    try {
      if (typeof content === "string" && content) content = transformer.afterResponse(content, ctx);
      if (typeof reasoning === "string" && reasoning) reasoning = transformer.afterResponse(reasoning, ctx);
    } catch (err) {
      log.warn({ source, err }, "afterResponse transformer failed — passing text through");
    }
  }
  if (content === response.content && reasoning === response.reasoning) return response;
  return { ...response, content, ...(reasoning !== undefined ? { reasoning } : {}) };
}

function safePush(t: LlmStreamTransform, s: string): string {
  try { return t.push(s); } catch (err) { log.warn({ err }, "stream transform push failed — passing text through"); return s; }
}
function safeFlush(t: LlmStreamTransform): string {
  try { return t.flush(); } catch (err) { log.warn({ err }, "stream transform flush failed"); return ""; }
}
function pipePush(transforms: LlmStreamTransform[], s: string): string {
  for (const t of transforms) s = safePush(t, s);
  return s;
}
/** Flush chained transforms, feeding each one's tail through the ones after it. */
function drainFlush(transforms: LlmStreamTransform[]): string {
  let out = "";
  for (let i = 0; i < transforms.length; i++) {
    let piece = safeFlush(transforms[i]!);
    for (let j = i + 1; j < transforms.length; j++) piece = safePush(transforms[j]!, piece);
    out += piece;
  }
  return out;
}

/**
 * Pipe streaming text/reasoning deltas through the transformers' per-stream
 * transforms. Text and reasoning get INDEPENDENT instances (their buffers must
 * not mix). `ctx` is captured EAGERLY by the caller (at stream() invocation, in
 * the request's async context) so the transform keys its state to the right
 * user even though this generator body runs lazily on consumption.
 */
async function* applyStreamTransforms(source: AsyncGenerator<StreamChunk>, ctx: LlmBoundaryContext): AsyncGenerator<StreamChunk> {
  const factories = _transformers.filter((t) => t.transformer.createStreamTransform);
  if (factories.length === 0) { yield* source; return; }
  const mk = (): LlmStreamTransform[] =>
    factories
      .map((f) => { try { return f.transformer.createStreamTransform!(ctx); } catch { return null; } })
      .filter((t): t is LlmStreamTransform => t !== null);
  const textT = mk();
  const reasT = mk();
  let flushed = false;
  function* emitFlush(): Generator<StreamChunk> {
    const r = drainFlush(reasT);
    if (r) yield { type: "reasoning_delta", content: r };
    const t = drainFlush(textT);
    if (t) yield { type: "text_delta", content: t };
  }
  for await (const chunk of source) {
    if (chunk.type === "text_delta" && typeof chunk.content === "string") {
      const out = pipePush(textT, chunk.content);
      if (out) yield { ...chunk, content: out };
    } else if (chunk.type === "reasoning_delta" && typeof chunk.content === "string") {
      const out = pipePush(reasT, chunk.content);
      if (out) yield { ...chunk, content: out };
    } else if (chunk.type === "done") {
      yield* emitFlush();
      flushed = true;
      yield chunk;
    } else {
      yield chunk;
    }
  }
  if (!flushed) yield* emitFlush();
}

/**
 * Wrap a provider so every model call passes through the registered
 * transformers. Implemented as a Proxy so the wrapper is transparent to
 * everything else about the provider: `instanceof` checks (failover status
 * reporting), provider-specific telemetry methods, and optional-method
 * presence all behave exactly as on the unwrapped instance. Transformers are
 * consulted per call, so registration order vs. provider construction order
 * doesn't matter.
 */
export function wrapProviderWithBoundary<T extends ChatProvider>(provider: T): T {
  return new Proxy(provider, {
    get(target, prop, receiver) {
      if (prop === "complete") {
        return async (messages: LLMMessage[], tools: LLMToolDef[], signal?: AbortSignal) =>
          applyAfterResponse(await target.complete(applyBeforeRequest(messages), tools, signal));
      }
      if (prop === "completeViaStream" && typeof target.completeViaStream === "function") {
        // `options` is forwarded, not dropped: it carries the per-chunk observation hook
        // and the operator's unbounded grant, and a wrapper that swallows them silently
        // disarms the mid-stream burn guard for every deployment with a transformer
        // registered — the same class of bypass FailoverChatProvider shipped once.
        return async (messages: LLMMessage[], tools: LLMToolDef[], signal?: AbortSignal, options?: CompletionCallOptions) =>
          applyAfterResponse(await target.completeViaStream!(applyBeforeRequest(messages), tools, signal, options));
      }
      if (prop === "stream") {
        return (messages: LLMMessage[], tools: LLMToolDef[], signal?: AbortSignal, options?: StreamCallOptions) => {
          // Capture the boundary context EAGERLY (in the caller's request async
          // context) so the inbound stream transform keys its state to the same
          // user that beforeRequest pseudonymized under.
          const outbound = applyBeforeRequest(messages);
          const ctx = boundaryContext();
          return applyStreamTransforms(target.stream(outbound, tools, signal, options), ctx);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      // Preserve `this` for ordinary methods (class providers keep internals private).
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as T;
}
