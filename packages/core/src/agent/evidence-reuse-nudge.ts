/**
 * Prior-evidence reuse-don't-re-research nudges (god-file seam, extracted from
 * runtime.ts).
 *
 * Two gates + their nudge/prompt builders that steer a follow-up turn to REUSE the
 * substantial delegated evidence already in the session instead of re-running an
 * expensive research mission:
 *  - the narrow source-sensitive contextual-decision path
 *    (shouldReusePriorDelegateEvidenceForSourceFollowUp / buildPriorEvidenceFollowUpPrompt),
 *  - the broader purely-structural session-evidence path
 *    (shouldNudgeSessionEvidenceReuse / buildSessionEvidenceReuseNudge).
 *
 * Pure text helpers — no runtime singletons. Re-exported from runtime.js so existing
 * importers (tests, tools) keep working unchanged.
 */
import type { DynamicTurnGuidance } from "./intent-classifier.js";

// Local copy of runtime.ts's `truncatePlainText` (it stays in runtime.ts for its many
// other callers; this module must not back-import from runtime.js). Identical logic.
function truncatePlainText(value: string, maxChars: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

const EXPLICIT_SOURCE_RECHECK_RE = /\b(verify|verification|check|recheck|validate|validation|source|sources|citation|citations|cite|official|datasheet|spec(?:ification)?s?|price|prices|supplier|suppliers|mouser|digikey|lcsc|aliexpress|search|lookup|look\s+up|find\s+online|recherch|pruef|pruefe|pruefen|verifiz|validier|quelle|quellen|beleg|belege)\b/i;
const CONTEXTUAL_DECISION_FOLLOW_UP_RE = /\b(ok|okay|thx|thanks|thank\s+you|danke|got\s+it|verstanden|we\s+will|we'll|wir\s+werden|wir\s+nutzen|wir\s+nehmen|i\s+will|ich\s+werde|ich\s+nehme|let'?s|lass\s+uns|use\s+them|using\s+them|go\s+with|nehmen\s+wir)\b/i;

export function shouldReusePriorDelegateEvidenceForSourceFollowUp(
  userMessage: string,
  guidance: DynamicTurnGuidance | null | undefined,
  priorEvidence: { evidence: string; itemCount: number } | null,
): boolean {
  if (!guidance?.sourceSensitive || guidance.freshnessSensitive || guidance.artifactSensitive) return false;
  if (!priorEvidence || priorEvidence.evidence.length < 400) return false;
  if (EXPLICIT_SOURCE_RECHECK_RE.test(userMessage)) return false;
  if (/[?？]/.test(userMessage)) return false;
  return userMessage.length <= 700 && CONTEXTUAL_DECISION_FOLLOW_UP_RE.test(userMessage);
}

export function buildPriorEvidenceFollowUpPrompt(evidence: { evidence: string; itemCount: number }): string {
  return [
    "CONTINUATION FROM PRIOR EVIDENCE: The latest user message appears to accept or refine a previously researched topic, not request fresh verification.",
    "Use the existing delegated evidence and the user's latest decision to answer directly.",
    "Do NOT call tools or delegate again unless the user explicitly asks for new source checks, current prices, supplier availability, or additional external facts.",
    `Prior delegated evidence preview (${evidence.evidence.length} chars, ${evidence.itemCount} structured items): ${truncatePlainText(evidence.evidence, 2200)}`,
  ].join(" ");
}

/**
 * Reuse-don't-re-research nudge (audit 17f53ed0). The narrow
 * `shouldReusePriorDelegateEvidenceForSourceFollowUp` only fires for source-sensitive
 * follow-ups matching a contextual-decision regex, so a plain refinement like "Mache ein
 * ordentliches Angebot" slipped through and the orchestrator re-ran a 15-minute research
 * mission whose evidence was still in the conversation. This is the broader, purely
 * STRUCTURAL gate: substantial delegated evidence already exists in this session AND the
 * new message introduces no new URL to fetch. It does NOT try to detect "same subject"
 * lexically — instead the injected nudge is conditional ("if it can be answered from the
 * existing evidence"), so a genuinely-new follow-up (e.g. an unrelated question not
 * covered by the prior evidence) still delegates fresh. A new URL is the one hard signal
 * of new external work, so its presence disables the nudge.
 */
export function shouldNudgeSessionEvidenceReuse(input: {
  enabled: boolean;
  narrowReuseAlreadyFired: boolean;
  priorEvidence: { evidence: string; itemCount: number } | null;
  userMessage: string;
}): boolean {
  if (!input.enabled) return false;
  // The narrow source-sensitive reuse path injects a stronger directive — don't double up.
  if (input.narrowReuseAlreadyFired) return false;
  // Need a real prior deliverable's worth of evidence, not a one-liner.
  if (!input.priorEvidence || input.priorEvidence.evidence.length < 800) return false;
  // A URL in the new message is a fresh fetch target = genuinely new external work.
  if (/\bhttps?:\/\//i.test(input.userMessage)) return false;
  return true;
}

export function buildSessionEvidenceReuseNudge(evidence: { evidence: string; itemCount: number }): string {
  const approxKb = Math.max(1, Math.round(evidence.evidence.length / 1000));
  return [
    `[SESSION EVIDENCE] Earlier in THIS session you already gathered sourced research evidence (~${approxKb}KB, ${evidence.itemCount} item(s)) — it is still in the conversation above.`,
    "If the latest request can be answered or REFINED from that evidence (e.g. re-pricing, restructuring, correcting, or extending the existing deliverable), reuse it and do NOT re-run the research.",
    "Delegate fresh research ONLY for specific facts the existing evidence does not already cover.",
  ].join(" ");
}
