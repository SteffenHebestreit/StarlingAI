/**
 * Turn-preparation phases (god-file seam).
 *
 * Cleanly-separable pre-loop setup phases of _runTurn, relocated verbatim as
 * top-level helpers so runtime.ts shrinks while the orchestration turn body stays
 * readable. Each helper threads its state EXPLICITLY (no shared closure): it takes
 * exactly the inputs the phase reads and returns exactly the values the rest of
 * the turn needs. Phases that can END the turn early return a discriminated result
 * so _runTurn keeps the early-`return` where it always was. Pure move: same audit
 * events, same order, same side effects.
 *
 * INVARIANT: this module imports its TYPES from turn-types.js (never runtime.js)
 * and its runtime dependencies from THEIR real modules. It must NEVER import from
 * runtime.js. The `blocked` TurnOutput builder lives here (the prepare-helpers and
 * runtime.ts's main loop both use it); runtime.ts imports it back from here — a
 * one-directional edge, no cycle.
 */
import { tryReceptionistFastLane } from "./receptionist.js";
import { checkInput } from "../guardrails/input.js";
import { moderateInputText } from "../guardrails/moderation.js";
import { checkRateLimit } from "../guardrails/rate-limiter.js";
import { getBudgetGateStatus } from "../observability/cost.js";
import { logAudit } from "../audit/logger.js";
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";
import type { AgentSession } from "./session.js";
import type { SwarmState } from "../tools/registry.js";
import { buildDynamicTurnGuidance, extractAssistantName } from "./intent-classifier.js";
import { buildProfileBiasedQuery } from "./user-profile-prefetch.js";
import { timedPhase, type TurnPerformanceMetrics } from "./turn-metrics.js";
import type { RunTurnOptions, TurnOutput } from "./turn-types.js";

const log = childLogger("agent:runtime");

export function blocked(reason: string, swarmState?: SwarmState, performance?: TurnPerformanceMetrics): TurnOutput {
  return {
    response: reason,
    toolCallsExecuted: 0,
    guardrailEvents: [{ type: "blocked", details: reason }],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    blocked: true,
    swarmState,
    performance,
  };
}

// ── Turn-preparation phases ──────────────────────────────────────────────────

/**
 * Phase 1 — Rate-limit check. Returns the blocked TurnOutput when the limit is
 * exceeded (caller returns it), else null (continue the turn).
 *
 * The limiter keys on the authenticated USER when multi-user auth is on, so a
 * single account cannot multiply its request budget by opening N sessions
 * (multi-tab, multiple channels). With auth off there is no userId, so it falls
 * back to the session id — the historical per-session behavior, unchanged.
 */
export async function prepareRateLimit(session: AgentSession): Promise<TurnOutput | null> {
  const subject = session.userId ?? session.id;
  const rl = await checkRateLimit(subject, "request");
  if (!rl.allowed) {
    logAudit("rate_limited", { remaining: 0, resetAt: rl.resetAt }, { sessionId: session.id });
    return blocked("Rate limit exceeded. Please wait before sending another message.");
  }
  return null;
}

/**
 * Phase 1b — Cost hard-budget gate. When cost enforcement is enabled and the
 * day's/month's priced spend has reached the hard budget, refuse the turn with a
 * clear message instead of running (and paying for) another request. No-op unless
 * `cost.enabled && cost.enforce` — the default alert-only deployment continues
 * exactly as before.
 */
export function prepareCostBudget(session: AgentSession): TurnOutput | null {
  const gate = getBudgetGateStatus();
  if (!gate.blocked) return null;
  logAudit("cost_budget_blocked", {
    scope: gate.scope, spend: gate.spend, budget: gate.budget, currency: gate.currency,
  }, { sessionId: session.id, severity: "error" });
  const scopeWord = gate.scope === "monthly" ? "monthly" : "daily";
  return blocked(
    `The ${scopeWord} cost budget has been reached (${gate.currency} ${gate.spend} of ${gate.budget}). ` +
    `New requests are paused until spend resets or an operator raises the limit.`,
  );
}

/**
 * Phase 2 — Input guardrail (pattern scanner + model moderation). Pushes
 * flagged/blocked events onto `guardrailEvents` (mutated in place, exactly as
 * before) and returns the blocked TurnOutput when input is rejected, else null.
 */
export async function prepareInputGuardrails(
  userMessage: string,
  session: AgentSession,
  guardrailEvents: NonNullable<TurnOutput["guardrailEvents"]>,
): Promise<TurnOutput | null> {
  // Scene/job runs carry the operator-authored task text from config as the
  // "message" (channel "scene"). That is trusted input, so the prompt-injection
  // scanner flags but does not block it — otherwise a scene's own security
  // instruction (e.g. "Never expose credential values") would hard-block the run
  // with zero turns. Untrusted channels (chat, telegram, email, webhook, a2a, …)
  // remain strictly blocked.
  const trustedWorkflowInput = session.channel === "scene";
  const inputCheck = checkInput(userMessage, { trusted: trustedWorkflowInput });
  if (!inputCheck.allowed) {
    const details = inputCheck.reason ?? "Prompt injection detected";
    logAudit("guardrail_blocked", { type: "input", reason: details, patterns: inputCheck.detectedPatterns }, {
      sessionId: session.id,
      severity: "warn",
    });
    guardrailEvents.push({ type: "input_blocked", details });
    return blocked(`I can't process that message: ${details}`);
  }

  if (inputCheck.detectedPatterns && inputCheck.detectedPatterns.length > 0) {
    guardrailEvents.push({ type: "input_flagged", details: inputCheck.reason ?? "" });
    logAudit("guardrail_flagged", { patterns: inputCheck.detectedPatterns }, { sessionId: session.id, severity: "warn" });
  }

  const moderatedInput = await moderateInputText(userMessage);
  if (moderatedInput?.blocked) {
    const details = `Model moderation blocked input: ${moderatedInput.summary}`;
    logAudit("guardrail_blocked", { type: "input_model", reason: details, categories: moderatedInput.categories }, {
      sessionId: session.id,
      severity: "warn",
    });
    guardrailEvents.push({ type: "input_model_blocked", details });
    return blocked(`I can't process that message: ${details}`);
  }

  if (moderatedInput?.flagged) {
    const details = `Model moderation flagged input: ${moderatedInput.summary}`;
    guardrailEvents.push({ type: "input_model_flagged", details });
    logAudit("guardrail_flagged", { type: "input_model", categories: moderatedInput.categories }, { sessionId: session.id, severity: "warn" });
  }
  return null;
}

/**
 * Phase 3 — Record the user turn: append the user message (with display/attachment
 * metadata), prune transient per-turn system messages, increment the turn counter,
 * audit message_received, then deterministically persist an explicit assistant
 * rename. Side effects only.
 */
export async function recordUserTurnMessage(opts: RunTurnOptions, session: AgentSession, userMessage: string): Promise<void> {
  const userMetadata: Record<string, unknown> = {};
  if (opts.userDisplayContent?.trim()) {
    userMetadata["displayContent"] = opts.userDisplayContent.trim();
  }
  if (opts.userAttachments?.length) {
    userMetadata["attachments"] = opts.userAttachments;
  }
  session.addMessage({
    role: "user",
    content: userMessage,
    ...(Object.keys(userMetadata).length > 0 ? { metadata: userMetadata } : {}),
  });
  session.pruneTransientTurnSystemMessages();
  session.incrementTurn();

  logAudit("message_received", { length: userMessage.length }, {
    sessionId: session.id,
    channel: session.channel,
    userId: session.userId,
  });

  // ── Deterministic assistant-rename persistence ──────────────────────────────
  // An explicit naming command ("Ab jetzt heißt du Luna", "your name is now …")
  // must actually persist. Local models routinely just acknowledge it ("saved!")
  // without calling assistant_personality_update (audit b71523fb), so we set the
  // name here too — making the name durable AND the model's claim truthful.
  try {
    const namedAs = extractAssistantName(userMessage);
    if (namedAs) {
      const { setMainAssistantName, loadMainAssistantPersonality } = await import("../personality/service.js");
      const before = loadMainAssistantPersonality().identity.name;
      setMainAssistantName(namedAs, "user");
      if (before !== namedAs) log.info({ sessionId: session.id, name: namedAs }, "assistant renamed (deterministic persist)");
    }
  } catch (err) {
    log.warn({ err }, "deterministic assistant-name persist failed");
  }
}

/**
 * Phase 4 — Receptionist fast lane. Opt-in first-contact gatekeeper. On a hit it
 * records the assistant reply, emits the chunk + audit, and returns a complete
 * TurnOutput (the caller returns it). On any miss it returns null and the turn
 * falls through to the full path. The guard (no task intent, no attachments,
 * config enabled) is evaluated by the caller and passed as `eligible`.
 */
export async function prepareReceptionistFastLane(args: {
  eligible: boolean;
  userMessage: string;
  signal: AbortSignal;
  opts: RunTurnOptions;
  session: AgentSession;
  guardrailEvents: NonNullable<TurnOutput["guardrailEvents"]>;
  turnStartedAt: number;
}): Promise<TurnOutput | null> {
  const { eligible, userMessage, signal, opts, session, guardrailEvents, turnStartedAt } = args;
  if (!eligible) return null;
  const fastLane = await timedPhase("receptionistFastLane", () => tryReceptionistFastLane(userMessage, signal).catch(() => null));
  if (!fastLane) return null;
  session.addMessage({ role: "assistant", content: fastLane.response });
  opts.onChunk?.(fastLane.response);
  logAudit("message_received", { fastLane: true, length: fastLane.response.length }, {
    sessionId: session.id,
    channel: session.channel,
    userId: session.userId,
  });
  return {
    response: fastLane.response,
    toolCallsExecuted: 0,
    guardrailEvents,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    blocked: false,
    performance: {
      turnDurationMs: Date.now() - turnStartedAt,
      llmCalls: 1,
      llmTimeMs: 0,
      toolCallsRequested: 0,
      toolExecutionTimeMs: 0,
      systemPromptChars: 0,
      collapsedHistoryMessages: 0,
      collapsedHistoryChars: 0,
      promptChars: userMessage.length,
      completionChars: fastLane.response.length,
      toolIterations: 0,
      finishReason: "receptionist_fast_lane",
      blocked: false,
    },
  };
}

/**
 * Phase 5 — Document-RAG augmentation. Auto-ingests this turn's attachments into
 * the session corpus and injects the most relevant excerpts as a transient
 * [DOCUMENT CONTEXT] system message. Returns whether a context block was injected
 * (`documentRagFoundDocs`), which the profile-prefetch path reads later. Never
 * fatal. The `detectedDynamicGuidance` decides the profile-biased query.
 */
export async function prepareDocumentRag(args: {
  detectedDynamicGuidance: ReturnType<typeof buildDynamicTurnGuidance>;
  userMessage: string;
  opts: RunTurnOptions;
  session: AgentSession;
}): Promise<{ documentRagFoundDocs: boolean }> {
  const { detectedDynamicGuidance, userMessage, opts, session } = args;
  // On a userOwnFacts turn with the profile prefetch active, the per-turn RAG is the
  // SINGLE document source: it uses the profile-biased query (reliable CV recall) and the
  // prefetch then skips its own duplicate doc retrieval. Captured so the prefetch knows
  // whether the CV was already surfaced — and so it cannot be lost (the [DOCUMENT CONTEXT]
  // here runs first and unconditionally).
  // The profile-biased query is only reachable via an explicit userOwnFacts signal,
  // which no classifier currently sets (de-lexicalization removed the keyword tables).
  // It deliberately stays that way: the prefetch's own gate now keys on whether this
  // RAG pass FOUND user documents, and that answer does not exist until after the pass
  // runs — biasing the query on it would be circular. Plain `userMessage` retrieval is
  // what decides it, and the prefetch adds memory + the confirmed-empty marker on top.
  const userOwnFactsTurn = detectedDynamicGuidance?.userOwnFacts === true
    && getConfig().orchestration?.userProfilePrefetch === true;
  const ragQuery = userOwnFactsTurn ? buildProfileBiasedQuery(userMessage) : userMessage;
  let documentRagFoundDocs = false;
  try {
    const { augmentTurnWithDocuments } = await import("../retrieval/document-rag.js");
    const aug = await timedPhase("documentRag", () => augmentTurnWithDocuments({
      ctx: { sessionId: session.id, ...(session.userId ? { userId: session.userId } : {}) },
      workspacePath: session.getWorkspacePath(),
      query: ragQuery,
      attachments: opts.userAttachments,
    }));
    if (aug.ingested > 0 || aug.failed > 0) {
      logAudit("document_rag_ingest", { ingested: aug.ingested, failed: aug.failed }, { sessionId: session.id });
    }
    if (aug.contextBlock) {
      session.addMessage({ role: "system", content: `[DOCUMENT CONTEXT]\n${aug.contextBlock}` });
      // Real document content grounds the answer — but the "[DOCUMENT RETRIEVAL UNAVAILABLE]"
      // failure placeholder (engram down / timed out) does NOT: it means retrieval FAILED, not that
      // the answer is sourced from the user's own documents. Counting it as grounding silently
      // disarmed the whole source-sensitivity honesty stack — the upfront classifier
      // (runtime.ts !documentRagFoundDocs) and both post-draft ungrounded guards are gated on this
      // flag — so an engram-down turn shipped memory-recited specifics (opening hours, prices) as
      // established fact with no research nudge and no unverified caveat (session 5d9136bd, turn 2).
      documentRagFoundDocs = !aug.retrievalUnavailable;
    }
  } catch (err) {
    log.warn({ err }, "document RAG augmentation failed — continuing without it");
  }
  return { documentRagFoundDocs };
}
