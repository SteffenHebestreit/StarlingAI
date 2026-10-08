/**
 * Receptionist — the generic first-contact gatekeeper in front of the runtime.
 *
 * Every incoming user message hits this first. Trivial conversational turns
 * ("hi", "thanks", "how are you") do not need the full ~22KB system prompt, tool
 * loading, and the swarm loop that `_runTurn` pays for. The receptionist answers
 * them with a tiny routing-tier model + a compressed memory capsule, then
 * returns. EVERY miss falls through to the full runtime:
 *
 *   Stage 0 — deterministic gate (free): any detected task intent (reuses the
 *     runtime's own classifier), any registered/ configured escalate term, or
 *     anything that isn't short and conversational → escalate. No LLM call.
 *   Stage 1 — micro-call: a few-hundred-token prompt on `model.tiers.routing`.
 *     The model answers in one short sentence, or emits `<ESCALATE>` for any
 *     real request. Over-long / empty / error → escalate.
 *
 * Product-agnostic: core ships NO domain deny-list. Forks specialise it via
 * registerReceptionistPolicy() (receptionist-policy.ts) — e.g. a medical fork
 * registers a clinical/PII deny-list + a clinic persona. Because it is opt-in
 * (config.receptionist.enabled) and fail-safe (any miss escalates), enabling it
 * can only reduce latency on trivial turns — it never changes how real work is
 * handled.
 */

import { getConfig } from "../config/loader.js";
import { decideWithReadout } from "../decisions/incumbent-readout.js";
import { FAST_LANE } from "../decisions/points.js";
import { applyActiveModelPreset, createChatProvider, getChatProviderForTier, tierModelDefaults } from "../providers/index.js";
import { effectiveOrchestration } from "../runtime/effort-context.js";
import { runWithCallAttribution } from "../runtime/request-context.js";
import { scanOutput } from "../guardrails/output.js";
import { answerAssertsSpecifics } from "./citation-honesty.js";
import { buildDynamicTurnGuidance } from "./intent-classifier.js";
import { getReceptionistEscalateTerms, getReceptionistPersonaLines } from "./receptionist-policy.js";
import { listUserMemoryRecords, listWorkspaceMemoryRecords } from "../memory/service.js";
import { loadMainAssistantPersonality } from "../personality/service.js";
import type { ChatProvider, LLMMessage } from "../providers/lmstudio.js";
import { childLogger } from "../logger.js";
import { defaultReplyLanguage, languageIsUndetermined } from "./reply-language.js";
import { detectTextLanguage } from "./text-language.js";

const log = childLogger("agent:receptionist");

export const ESCALATE_SENTINEL = "<ESCALATE>";

const SHORT_MESSAGE_MAX_CHARS = 120;
const SHORT_MESSAGE_MAX_WORDS = 12;

export type FrontDeskDecision = { fastLane: true } | { fastLane: false; reason: string };

/**
 * Stage 0 — deterministic gate. No LLM. Conservative: escalates on any detected
 * task intent, any registered/configured escalate term, or anything that isn't
 * short and conversational. A `true` result only means "candidate for the fast
 * lane"; the micro-call is the final arbiter.
 */
export function classifyFrontDesk(
  userMessage: string,
  opts: { alwaysEscalateTerms?: readonly string[]; confidenceAttempt?: boolean; confidenceMaxChars?: number } = {},
): FrontDeskDecision {
  const normalized = userMessage.trim().toLowerCase();
  if (!normalized) return { fastLane: false, reason: "empty" };

  // Any task intent the runtime's classifier already recognises → full path. This is
  // the safety backbone for confidence-attempt mode: research/freshness/source/mail/
  // user-own-facts/computer/server/maintenance turns all set a guidance flag here and
  // escalate, so the relaxed gate below only ever sees questions with NO task signal.
  if (buildDynamicTurnGuidance(userMessage) !== null) {
    return { fastLane: false, reason: "task-intent" };
  }

  // Fork-registered + operator-configured escalate terms → never front-desk it.
  const deny = [
    ...getReceptionistEscalateTerms(),
    ...(opts.alwaysEscalateTerms ?? []).map((t) => t.toLowerCase()),
  ];
  if (deny.some((term) => term && normalized.includes(term))) {
    return { fastLane: false, reason: "escalate-term" };
  }

  // CONFIDENCE-ATTEMPT: a clearly-direct, self-contained question (no task intent, no
  // escalate term) up to a length ceiling is a candidate — the micro-call self-scores
  // confidence and abstains (escalates) when unsure. Without this flag the front desk
  // stays smalltalk-only (the original behaviour).
  if (opts.confidenceAttempt) {
    if (normalized.length > (opts.confidenceMaxChars ?? 400)) {
      return { fastLane: false, reason: "too-long-for-attempt" };
    }
    return { fastLane: true };
  }

  if (!isShortConversational(normalized)) {
    return { fastLane: false, reason: "not-short-conversational" };
  }

  return { fastLane: true };
}

function isShortConversational(normalized: string): boolean {
  if (normalized.length > SHORT_MESSAGE_MAX_CHARS) return false;
  const words = normalized.split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= SHORT_MESSAGE_MAX_WORDS;
}

export interface ReceptionistResult {
  /** true → answer directly with `response`; false → fall through to full runtime. */
  handled: boolean;
  response?: string;
  escalateReason?: string;
}

export type CompleteFn = (messages: LLMMessage[], signal?: AbortSignal) => Promise<string>;

export interface RunReceptionistDeps {
  complete: CompleteFn;
  memoryCapsule?: string;
  assistantName?: string;
  personaLines?: readonly string[];
  maxResponseChars?: number;
  alwaysEscalateTerms?: readonly string[];
  /** Confidence-attempt mode (config.receptionist.confidenceAttempt). */
  confidenceAttempt?: boolean;
  /** Candidate-length ceiling for the relaxed Stage-0 gate in confidence-attempt mode. */
  confidenceMaxChars?: number;
  /** For the decision ledger. */
  sessionId?: string;
  /** The language the conversation has been using, for a message that carries none. */
  conversationLanguage?: string;
  /** agents.mainAssistant.defaultLanguage. */
  defaultLanguage?: string;
  /**
   * The model `complete` runs on, for the logit readout of the same question (decisions.readout):
   * "small talk or task?" answered as one letter. Without it the readout is never asked.
   */
  readout?: { provider: Pick<ChatProvider, "complete">; signal?: AbortSignal };
}

/**
 * Run the front desk. Injectable `complete` keeps this unit-testable without a
 * provider. Never throws — any failure escalates.
 */
export async function runReceptionist(
  userMessage: string,
  deps: RunReceptionistDeps,
): Promise<ReceptionistResult> {
  const confidenceAttempt = deps.confidenceAttempt === true;
  const gate = classifyFrontDesk(userMessage, {
    alwaysEscalateTerms: deps.alwaysEscalateTerms,
    confidenceAttempt,
    ...(deps.confidenceMaxChars !== undefined ? { confidenceMaxChars: deps.confidenceMaxChars } : {}),
  });
  if (!gate.fastLane) return { handled: false, escalateReason: gate.reason };

  const messages = buildReceptionistMessages(userMessage, {
    memoryCapsule: deps.memoryCapsule,
    assistantName: deps.assistantName,
    personaLines: deps.personaLines ?? getReceptionistPersonaLines(),
    confidenceAttempt,
    ...(deps.conversationLanguage ? { conversationLanguage: deps.conversationLanguage } : {}),
    ...(deps.defaultLanguage ? { defaultLanguage: deps.defaultLanguage } : {}),
  });
  let raw: string;
  try {
    // Laya may call a message a task on its own: then it goes straight to the full assistant and
    // the micro-call — about two seconds on the shared GPU for a message that escalates anyway —
    // is never waited for. "Small talk" it may not decide alone: only the model can write the reply.
    // The same holds for the logit readout when it decides (decisions.readout "on"): its "task"
    // escalates without the micro-call, its "small talk" still needs the micro-call's reply.
    const outcome = await decideWithReadout<string>({
      point: FAST_LANE,
      state: { message: userMessage },
      languageOf: userMessage,
      layaMayTake: ["task"],
      incumbent: (signal) => deps.complete(messages, signal),
      toKey: (reply) => (receptionistEscalated(reply, confidenceAttempt) ? "task" : "small_talk"),
      fromKey: () => ESCALATE_SENTINEL,
      ...(deps.sessionId ? { sessionId: deps.sessionId } : {}),
      readout: {
        provider: deps.readout?.provider,
        agentName: "receptionist",
        parsedFor: ["small_talk"],
        ...(deps.readout?.signal ? { signal: deps.readout.signal } : {}),
      },
    });
    if (outcome.decidedBy === "laya") return { handled: false, escalateReason: "laya-task" };
    raw = outcome.value ?? "";
  } catch (err) {
    log.debug({ err }, "Receptionist micro-call failed — escalating");
    return { handled: false, escalateReason: "micro-call-error" };
  }

  let text: string;
  if (confidenceAttempt) {
    // Fail-safe: only a self-reported high-confidence, non-sentinel answer is kept;
    // low/unsure/unparseable/abstain all escalate to the full model.
    const verdict = parseReceptionistConfidence(raw);
    if (!verdict.confident) {
      return { handled: false, escalateReason: "low-confidence" };
    }
    text = verdict.answer;
  } else {
    text = raw.trim();
    if (!text || text.includes(ESCALATE_SENTINEL)) {
      return { handled: false, escalateReason: "model-escalated" };
    }
  }
  const maxChars = deps.maxResponseChars ?? 400;
  if (text.length > maxChars) {
    return { handled: false, escalateReason: "response-too-long" };
  }

  // Structural belt: the fast-lane returns BEFORE the full honesty chain (up-front
  // source-sensitivity classifier + post-draft judges), so a small routing model that
  // answered a source-sensitive question despite its prompt would otherwise ship totally
  // unvalidated. Refuse to keep a fast-lane answer that ASSERTS external-world specifics
  // (≥2 named-fact-shape tokens: prices/rates/stats/years/dates/part-codes) and escalate
  // to the full, verifiable path instead. Greeting / small-talk / about-you / definition /
  // calculation answers — the fast-lane's documented scope — carry no such tokens, so their
  // coverage is unaffected. Structural + language-independent, no keyword table.
  if (answerAssertsSpecifics(text)) {
    return { handled: false, escalateReason: "asserts-specifics" };
  }

  // Output guardrail — the same secret-scan + extension hooks the full path runs
  // on its final response. Unsafe-with-redaction → send the redacted text; a hard
  // block → escalate rather than surface a "[BLOCKED …]" placeholder.
  const scan = scanOutput(text);
  if (scan.safe === false) {
    const redacted = (scan.redacted ?? "").trim();
    if (!redacted || redacted.startsWith("[BLOCKED")) {
      return { handled: false, escalateReason: "output-guardrail" };
    }
    return { handled: true, response: redacted };
  }
  return { handled: true, response: text };
}

/** Did the front desk's model hand the message on, rather than answer it? */
export function receptionistEscalated(raw: string, confidenceAttempt: boolean): boolean {
  if (confidenceAttempt) return !parseReceptionistConfidence(raw).confident;
  const text = raw.trim();
  return !text || text.includes(ESCALATE_SENTINEL);
}

// Whether a message carries no language of its own. Defined beside the reply-language rule, so the
// full path answers a first "Good morning" in the language this desk does; re-exported here.
export { languageIsUndetermined };

export function buildReceptionistMessages(
  userMessage: string,
  opts: {
    memoryCapsule?: string;
    assistantName?: string;
    personaLines?: readonly string[];
    confidenceAttempt?: boolean;
    /** The language this conversation has been using (read off the previous reply), if any. */
    conversationLanguage?: string;
    /** agents.mainAssistant.defaultLanguage — used only when the conversation has none yet. */
    defaultLanguage?: string;
  } = {},
): LLMMessage[] {
  // ONE unconditional directive when the message carries no language of its own — a conditional
  // ("...if ambiguous, default to German") is not reliably followed by the fast-lane model. The
  // language it names is the conversation's when there is one: hard-coding German answered an
  // English speaker's "thanks" in German.
  const fallbackLanguage = opts.conversationLanguage ?? opts.defaultLanguage ?? defaultReplyLanguage();
  const fallbackReason = opts.conversationLanguage
    ? "it is the language this conversation has been using"
    : `${fallbackLanguage} is this assistant's default language`;
  const languageLine = languageIsUndetermined(userMessage)
    ? `Reply in ${fallbackLanguage.toUpperCase()}. This message is a bare greeting/acknowledgement that carries no language of its own, and ${fallbackReason}. Do NOT answer in any other language.`
    // KEEP THIS LINE AS IT IS, although it reads as if it forbade "answer in English" written in
    // German. Measured on the routing model (2026-09-25, 5 such requests x 3, 4 wordings): with it,
    // the model answered in the requested language or ESCALATED — the full assistant then applies
    // the whole reply-language rule — and answered in the wrong language once in 15. Every
    // "if the user asks for a language …" wording, whether a clause after this line, an entry in
    // the escalation list, or a rule stated first, was answered in the wrong language 3-5 times in
    // 15: the model took the mirror clause and dropped the exception.
    : "ALWAYS reply in the SAME language as the user's message (German → German, English → English). Never switch the language.";
  const common = [
    ...(opts.personaLines ?? []),
    opts.assistantName ? `If asked your name, you are "${opts.assistantName}".` : "Do not invent a name for yourself.",
    opts.memoryCapsule ? `Known context (use only if directly relevant):\n${opts.memoryCapsule}` : "",
  ];
  const lines = opts.confidenceAttempt
    ? [
        "You are the fast first-contact desk of an AI assistant — you see every incoming message before the full (larger, slower) assistant does.",
        "Answer the user yourself ONLY for a greeting, small talk, a question about YOU (your name, how you are, what you can broadly help with), a definition of a common concept, or a quick calculation.",
        `Do NOT answer a question that depends on SPECIFIC real-world facts — a named organisation / operator / company / brand, a price / fee / amount, a rate or statistic, a law or rule, an event, or exactly how a PARTICULAR real system, product, place, or scheme actually works. You would be reciting it from memory and could be wrong, and you cannot verify it here. Also do NOT answer anything that needs a tool, a lookup, current or live data, the user's own files/history, or multi-step work. In ANY of these cases do NOT guess — reply with exactly ${ESCALATE_SENTINEL} and nothing else; it is routed to the full assistant, which can verify. A confident-sounding guess is worse than escalating.`,
        // Language policy mirrors the main path (personality/service.ts), but the
        // undetermined-language case is resolved in code (see languageIsUndetermined).
        languageLine,
        "Keep it to at most a few sentences. Do not introduce yourself unless explicitly asked.",
        "After your answer, on a NEW final line, output exactly 'CONFIDENCE: high' if you are confident the answer is complete and correct, or 'CONFIDENCE: low' otherwise. When in any doubt, prefer to escalate.",
        ...common,
      ]
    : [
        "You are the first-contact desk of an AI assistant — you see every incoming user message before the full assistant does.",
        // Language policy mirrors the main path (personality/service.ts), but the
        // undetermined-language case is resolved in code (see languageIsUndetermined).
        languageLine,
        "You handle ONLY trivial SOCIAL turns yourself: greetings, thanks, acknowledgements, small talk, and questions about YOU (your name, how you are, what you can broadly help with).",
        `Escalate EVERYTHING else. In particular, ANY question asking for real-world information or how something actually works — a fact about a place, country, organisation, company, product, law, price, statistic, event, or exactly how a specific system / service / scheme works — you must NOT answer from your own memory (you would be guessing and could be wrong, and you cannot verify it here). Reply with exactly ${ESCALATE_SENTINEL} and nothing else; the full assistant can verify it. A confident-sounding guess is worse than escalating.`,
        `For anything that needs an action, a lookup, a task, files, or any real work, also reply with exactly ${ESCALATE_SENTINEL} and nothing else.`,
        `You have NO access to the user's files, documents, account, memory, or history. A question about the USER THEMSELVES — their CV, background, skills, projects, or what is stored about them (e.g. "do I have a CV on file?", "what's my role?") — you CANNOT answer, so reply with exactly ${ESCALATE_SENTINEL} and let the full assistant look it up.`,
        "When you do answer, keep it to ONE short, polite sentence. Do not introduce yourself unless explicitly asked.",
        ...common,
      ];
  return [
    { role: "system", content: lines.filter(Boolean).join("\n") },
    { role: "user", content: userMessage },
  ];
}

/**
 * Parse a confidence-attempt reply. Fail-SAFE: returns confident=false unless the
 * model explicitly self-reported `CONFIDENCE: high` and produced a non-empty answer
 * with no escalate sentinel. Anything else (sentinel, low/medium/unsure, or a missing
 * marker) means "escalate to the full model". The CONFIDENCE line is stripped from
 * the returned answer. Pure + exported for unit testing.
 */
export function parseReceptionistConfidence(raw: string): { confident: boolean; answer: string } {
  const text = raw.trim();
  if (!text || text.includes(ESCALATE_SENTINEL)) return { confident: false, answer: "" };
  const marker = text.match(/CONFIDENCE\s*:\s*(high|low|medium|unsure|none)/i);
  const answer = text.replace(/\n?\s*CONFIDENCE\s*:\s*\w+.*$/is, "").trim();
  if (!marker) return { confident: false, answer }; // no self-report → do not trust
  return { confident: marker[1]!.toLowerCase() === "high" && answer.length > 0, answer };
}

/**
 * Compressed memory capsule — durable decisions + preferences only, capped hard.
 * The "compressed memory" the front desk gets instead of the full per-turn
 * retrieval; deeper recall stays on the full runtime path.
 */
export function buildMemoryCapsule(workspacePath: string, maxChars = 400): string {
  const records = [
    ...listUserMemoryRecords(workspacePath),
    ...listWorkspaceMemoryRecords(workspacePath),
  ]
    .filter((r) => r.kind === "decision" || r.kind === "preference" || r.kind === "fact")
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  const lines: string[] = [];
  let used = 0;
  for (const record of records) {
    // With its subject: the content alone often names no topic ("Polarstern-Rooibos" for the user's
    // favourite tea), and a capsule of bare values could not answer the question it was stored for.
    const content = singleLine(record.content);
    const subject = singleLine(record.subject ?? "");
    const fact = subject && !content.toLowerCase().includes(subject.toLowerCase()) ? `${subject}: ${content}` : content;
    const line = `- ${fact}`.slice(0, 160);
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

export interface FastLaneOutcome {
  response: string;
}

/**
 * Why the fast lane did not answer. Every one of these collapsed to `null` before, so a
 * production run showing 0 of 5 fast-lane hits could not say whether the gate rejected the
 * message, the small model escalated, or — the actual live cause — no routing tier exists
 * under a model preset, which makes the lane silently unreachable.
 */
export type FastLaneEscalateReason =
  | "disabled"
  | "no-routing-tier"
  | "error"
  | string;

/**
 * Production entry used by the runtime. Returns the response when the front desk
 * handled the turn, or `null` to fall through to the full runtime. Never throws.
 */
export async function tryReceptionistFastLane(
  userMessage: string,
  signal?: AbortSignal,
  context: FastLaneConversationContext = {},
): Promise<FastLaneOutcome | null> {
  const outcome = await tryReceptionistFastLaneDetailed(userMessage, signal, context);
  return outcome.handled ? { response: outcome.response } : null;
}

/** What the fast lane may know about the conversation it is answering inside. */
export interface FastLaneConversationContext {
  /** The assistant's previous reply in this session, if any — the language anchor for a
   *  message that carries none of its own. */
  previousReply?: string;
  /** For the decision ledger. */
  sessionId?: string;
  /** The session's workspace root: under multi-user auth the user's own root, where their workspace
   *  memories are. The configured root is the shared one. */
  workspacePath?: string;
}

/**
 * Same lane, but it reports WHY it declined. The runtime logs the reason; a caller that
 * only needs the answer can use {@link tryReceptionistFastLane}.
 */
export async function tryReceptionistFastLaneDetailed(
  userMessage: string,
  signal?: AbortSignal,
  context: FastLaneConversationContext = {},
): Promise<{ handled: true; response: string } | { handled: false; escalateReason: FastLaneEscalateReason }> {
  const config = getConfig();
  if (!config.receptionist?.enabled) return { handled: false, escalateReason: "disabled" };

  // No routing tier → there is no cheap model to answer with; use the full path.
  // reasoningEffort "none" is the point of this lane: it answers trivial turns ("hi")
  // cheaply, and on a graded-thinking model the default effort would otherwise spend
  // ~1.3k reasoning characters deciding how to say hello. Families that do not honor
  // the field ignore it, so this is safe across model swaps.
  // Under a model preset the tier resolver returns null for every turn, so the lane never
  // runs at all — the reason the live deployment recorded 0 of 5 hits. The fallback builds a
  // provider from the caller's own merged config carrying the tier's controls; it is
  // flag-gated because making the fast lane start answering on a deployment where it never
  // has is a behaviour change, not a repair.
  const provider = effectiveOrchestration().routingTierPresetFallback === true
    ? (getChatProviderForTier("routing", { reasoningEffort: "none" })
      ?? createChatProvider({
        ...applyActiveModelPreset(config.agents.defaults.model),
        ...tierModelDefaults("routing"),
        reasoningEffort: "none",
      }))
    : getChatProviderForTier("routing", { reasoningEffort: "none" });
  if (!provider) return { handled: false, escalateReason: "no-routing-tier" };

  let capsule = "";
  try {
    capsule = buildMemoryCapsule(context.workspacePath ?? config.workspacePath);
  } catch (err) {
    log.debug({ err }, "Memory capsule build failed — continuing without it");
  }

  let assistantName: string | undefined;
  try {
    assistantName = loadMainAssistantPersonality().identity?.name;
  } catch { /* default: unnamed */ }

  // Read the conversation's language off the previous reply, which is written in it. Only a
  // message with no language of its own uses it. Not awaited: the gateway loads the detector at
  // boot, and until it has, the configured default stands in.
  const conversationLanguage = context.previousReply?.trim() && languageIsUndetermined(userMessage)
    ? detectTextLanguage(context.previousReply)?.name
    : undefined;

  const result = await runReceptionist(userMessage, {
    ...(conversationLanguage ? { conversationLanguage } : {}),
    defaultLanguage: defaultReplyLanguage(),
    // A routing-tier call like the triage and the source-sensitivity judge, labelled like them.
    // Unlabelled it inherited the turn's own context, so its provider row read agentName main,
    // callSite main_turn — indistinguishable from the orchestrator's first call on the same model.
    complete: async (messages, callSignal) => (await runWithCallAttribution({ callSite: "routing_tier", agentName: "receptionist" }, () =>
      provider.complete(messages, [], callSignal && signal ? AbortSignal.any([signal, callSignal]) : callSignal ?? signal))).content ?? "",
    readout: { provider, ...(signal ? { signal } : {}) },
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    memoryCapsule: capsule || undefined,
    assistantName,
    personaLines: getReceptionistPersonaLines(),
    maxResponseChars: config.receptionist.maxResponseChars,
    alwaysEscalateTerms: config.receptionist.alwaysEscalateTerms,
    confidenceAttempt: config.receptionist.confidenceAttempt === true,
    confidenceMaxChars: config.receptionist.confidenceAttemptMaxChars,
  });

  return result.handled && result.response
    ? { handled: true, response: result.response }
    : { handled: false, escalateReason: result.escalateReason ?? "unhandled" };
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
