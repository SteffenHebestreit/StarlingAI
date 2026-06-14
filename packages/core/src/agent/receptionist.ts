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
  opts: { alwaysEscalateTerms?: readonly string[] } = {},
): FrontDeskDecision {
  const normalized = userMessage.trim().toLowerCase();
  if (!normalized) return { fastLane: false, reason: "empty" };

  // Any task intent the runtime's classifier already recognises → full path.
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
}

/**
 * Run the front desk. Injectable `complete` keeps this unit-testable without a
 * provider. Never throws — any failure escalates.
 */
export async function runReceptionist(
  userMessage: string,
  deps: RunReceptionistDeps,
): Promise<ReceptionistResult> {
  const gate = classifyFrontDesk(userMessage, { alwaysEscalateTerms: deps.alwaysEscalateTerms });
  if (!gate.fastLane) return { handled: false, escalateReason: gate.reason };

  let raw: string;
  try {
    raw = await deps.complete(
      buildReceptionistMessages(userMessage, {
        memoryCapsule: deps.memoryCapsule,
        assistantName: deps.assistantName,
        personaLines: deps.personaLines ?? getReceptionistPersonaLines(),
      }),
    );
  } catch (err) {
    log.debug({ err }, "Receptionist micro-call failed — escalating");
    return { handled: false, escalateReason: "micro-call-error" };
  }

  const text = raw.trim();
  if (!text || text.includes(ESCALATE_SENTINEL)) {
    return { handled: false, escalateReason: "model-escalated" };
  }
  const maxChars = deps.maxResponseChars ?? 400;
  if (text.length > maxChars) {
    return { handled: false, escalateReason: "response-too-long" };
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
  opts: { memoryCapsule?: string; assistantName?: string; personaLines?: readonly string[] } = {},
): LLMMessage[] {
  const system = [
    "You are the first-contact desk of an AI assistant — you see every incoming user message before the full assistant does.",
    "Only handle trivial conversational turns yourself: greetings, thanks, acknowledgements, and simple questions about how you are or what you can broadly help with.",
    `For ANYTHING that needs an action, a lookup, a task, or any real work, reply with exactly ${ESCALATE_SENTINEL} and nothing else — it is routed to the full assistant.`,
    "When you do answer, reply in the user's language in ONE short, polite sentence. Do not introduce yourself unless explicitly asked.",
    ...(opts.personaLines ?? []),
    opts.assistantName ? `If asked your name, you are "${opts.assistantName}".` : "Do not invent a name for yourself.",
    opts.memoryCapsule ? `Known context (use only if directly relevant):\n${opts.memoryCapsule}` : "",
  ].filter(Boolean).join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: userMessage },
  ];
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
    .filter((r) => r.kind === "decision" || r.kind === "preference")
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
  });

  return result.handled && result.response ? { response: result.response } : null;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
