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
import { getChatProviderForTier } from "../providers/index.js";
import { scanOutput } from "../guardrails/output.js";
import { answerAssertsSpecifics } from "./citation-honesty.js";
import { buildDynamicTurnGuidance } from "./intent-classifier.js";
import { getReceptionistEscalateTerms, getReceptionistPersonaLines } from "./receptionist-policy.js";
import { listUserMemoryRecords, listWorkspaceMemoryRecords } from "../memory/service.js";
import { loadMainAssistantPersonality } from "../personality/service.js";
import type { LLMMessage } from "../providers/lmstudio.js";
import { childLogger } from "../logger.js";

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

export type CompleteFn = (messages: LLMMessage[]) => Promise<string>;

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

  let raw: string;
  try {
    raw = await deps.complete(
      buildReceptionistMessages(userMessage, {
        memoryCapsule: deps.memoryCapsule,
        assistantName: deps.assistantName,
        personaLines: deps.personaLines ?? getReceptionistPersonaLines(),
        confidenceAttempt,
      }),
    );
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

export function buildReceptionistMessages(
  userMessage: string,
  opts: { memoryCapsule?: string; assistantName?: string; personaLines?: readonly string[]; confidenceAttempt?: boolean } = {},
): LLMMessage[] {
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
        "Reply in the user's language, in at most a few sentences. Do not introduce yourself unless explicitly asked.",
        "After your answer, on a NEW final line, output exactly 'CONFIDENCE: high' if you are confident the answer is complete and correct, or 'CONFIDENCE: low' otherwise. When in any doubt, prefer to escalate.",
        ...common,
      ]
    : [
        "You are the first-contact desk of an AI assistant — you see every incoming user message before the full assistant does.",
        "ALWAYS reply in the SAME language as the user's message (German → German, English → English). Never switch the language.",
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
    const line = `- ${singleLine(record.content)}`.slice(0, 160);
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
 * Production entry used by the runtime. Returns the response when the front desk
 * handled the turn, or `null` to fall through to the full runtime. Never throws.
 */
export async function tryReceptionistFastLane(
  userMessage: string,
  signal?: AbortSignal,
): Promise<FastLaneOutcome | null> {
  const config = getConfig();
  if (!config.receptionist?.enabled) return null;

  // No routing tier → there is no cheap model to answer with; use the full path.
  const provider = getChatProviderForTier("routing");
  if (!provider) return null;

  let capsule = "";
  try {
    capsule = buildMemoryCapsule(config.workspacePath);
  } catch (err) {
    log.debug({ err }, "Memory capsule build failed — continuing without it");
  }

  let assistantName: string | undefined;
  try {
    assistantName = loadMainAssistantPersonality().identity?.name;
  } catch { /* default: unnamed */ }

  const result = await runReceptionist(userMessage, {
    complete: async (messages) => (await provider.complete(messages, [], signal)).content ?? "",
    memoryCapsule: capsule || undefined,
    assistantName,
    personaLines: getReceptionistPersonaLines(),
    maxResponseChars: config.receptionist.maxResponseChars,
    alwaysEscalateTerms: config.receptionist.alwaysEscalateTerms,
    confidenceAttempt: config.receptionist.confidenceAttempt === true,
    confidenceMaxChars: config.receptionist.confidenceAttemptMaxChars,
  });

  return result.handled && result.response ? { response: result.response } : null;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
