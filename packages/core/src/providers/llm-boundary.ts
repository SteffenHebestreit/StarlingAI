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
 * - Streaming token deltas are NOT transformed in v1 (token boundaries would
 *   split replacement markers); a stream may therefore surface placeholder
 *   tokens (e.g. "[PATIENT_A]") live. That direction is privacy-safe — the
 *   sensitive direction (outbound) is always covered.
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
import type { ChatProvider, LLMMessage, LLMResponse, LLMToolDef } from "./lmstudio.js";

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
        return async (messages: LLMMessage[], tools: LLMToolDef[], signal?: AbortSignal) =>
          applyAfterResponse(await target.completeViaStream!(applyBeforeRequest(messages), tools, signal));
      }
      if (prop === "stream") {
        return (messages: LLMMessage[], tools: LLMToolDef[], signal?: AbortSignal, options?: { toolChoice?: "auto" | "required" | "none" }) =>
          target.stream(applyBeforeRequest(messages), tools, signal, options);
      }
      const value = Reflect.get(target, prop, receiver);
      // Preserve `this` for ordinary methods (class providers keep internals private).
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as T;
}
