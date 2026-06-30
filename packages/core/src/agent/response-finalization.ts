/**
 * Terminal user-facing response sanitize/rewrite cluster (god-file seam): pure
 * detectors and helpers that decide whether a turn's final assistant text needs
 * sanitizing, resynthesizing, or terminal-rewriting, plus the recovery-evidence
 * fallback inspectors. Extracted verbatim from runtime.ts.
 *
 * NOTE: rewriteTerminalResponseIfNeeded / finalizeUserFacingAssistantResponse /
 * resolveEmptyAssistantResponseFallback were LEFT in runtime.ts because they call
 * runtime main-loop singletons (forceSynthesis, enforceDelegateCoverage,
 * findRecentDelegateEvidence) and moving them would force a back-import cycle.
 *
 * INVARIANT: this module imports ONLY from leaf/sibling modules (sanitize-response,
 * text-dedup, intent-classifier, runtime-utils). It must NEVER import from
 * runtime.js — keep it cycle-free.
 */
import { sanitizeAssistantContent, NARRATED_TOOL_TEXT_RE } from "./sanitize-response.js";
import { looksLikeDegenerateRepetition, collapseRepeatedMarkdownSections } from "./text-dedup.js";
import {
  buildDynamicTurnGuidance,
  WORKFLOW_HINT_TERMS,
  WORKFLOW_REQUEST_PATTERNS,
} from "./intent-classifier.js";
import { DELEGATE_TOOL_RESULT_RE, looksLikeDelegateMetadata } from "./runtime-utils.js";

export function sanitizeUserFacingAssistantResponse(value: string, toolIterations: number): string {
  const cleaned = sanitizeAssistantContent(value, toolIterations > 0);
  // Final safety net: a slow local model can collapse into a repetition loop during
  // synthesis and emit the same section many times. Never ship that verbatim — keep
  // the first occurrence of each unique section (audit 9fd16384: 17× repeated block).
  return looksLikeDegenerateRepetition(cleaned) ? collapseRepeatedMarkdownSections(cleaned) : cleaned;
}

export const EMPTY_ASSISTANT_RESPONSE_FALLBACK = "I wasn't able to generate a usable reply for that turn. Please try again.";

export function looksLikeGenericNoUsableReply(value: string): boolean {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized === EMPTY_ASSISTANT_RESPONSE_FALLBACK
    || /^i wasn'?t able to generate a usable reply\b/i.test(normalized)
    || /^please try again\.?$/i.test(normalized);
}

export function shouldResynthesizeUserFacingResponse(raw: string, cleaned: string, toolIterations: number): boolean {
  if (!raw.trim() || cleaned.length === 0) return true;
  if (toolIterations > 0 && looksLikeGenericNoUsableReply(cleaned)) return true;
  if (toolIterations === 0) return false;
  if (!NARRATED_TOOL_TEXT_RE.test(raw)) return false;
  return cleaned.length === 0 || cleaned.length < Math.min(120, Math.ceil(raw.length / 3));
}

const CONTINUATION_PROMISE_RE = /\b(i(?:'ll| will)(?:\s+now)?|i am going to|ich werde(?:\s+nun)?|ich beauftrage(?:\s+nun)?|n[äa]chste orchestrierung|next orchestration|next logical step|n[äa]chste logische aktion)\b/i;
const IMPLICIT_CONTINUATION_EXECUTION_RE = /\b(?:i(?:\s+have|'ve)[\s\S]{0,80}\b(?:corrected|fixed|updated|adjusted)\b[\s\S]{0,80}\b(?:am\s+)?(?:now\s+)?(?:running|executing|starting|retrying|restarting)\b|ich\s+habe[\s\S]{0,80}\b(?:korrigiert|angepasst|berichtigt)\b[\s\S]{0,80}\b(?:und\s+)?(?:f(?:[üu]hre|uehre)|starte|versuche|sto(?:ss|ß)e)\b[\s\S]{0,40}\b(?:nun|jetzt)\b[\s\S]{0,20}\b(?:aus|an)\b)/i;
const MAINTENANCE_EXECUTION_PROMISE_RE = /\b(?:i(?:'ll| will)\s+(?:create|generate|delegate|build)|ich\s+(?:werde|erstelle|generiere|delegiere|beauftrage)|(?:erstelle|generiere|delegiere|beauftrage)\s+ich(?:\s+nun|\s+jetzt)?)\b/i;
const MISLEADING_EXECUTED_NEXT_STEP_RE = /\b(the next (?:logical )?(?:step|action)|der n[äa]chste(?: logische)?(?: schritt| aktion)|die n[äa]chste(?: logische)? aktion)\b[\s\S]{0,80}\b(which has been executed|has been executed|was executed|has already been executed|wurde(?:\s+bereits)?\s+ausgef[üu]hrt|ist bereits erfolgt)\b/i;
const NEXT_TURN_HANDOFF_RE = /\b(would you like me to (?:initiate|start|retry)|in the next turn|im n[äa]chsten zug|im n[äa]chsten turn|neue[nr]? delegations(?:strategie|versuch)|new delegation attempt|no further tool calls can be made in this turn|keine weiteren tool calls .* in diesem zug)\b/i;

export function looksLikeContinuationPromise(value: string): boolean {
  return CONTINUATION_PROMISE_RE.test(value) || IMPLICIT_CONTINUATION_EXECUTION_RE.test(value);
}

export function looksLikeMaintenanceExecutionPromise(value: string): boolean {
  return looksLikeContinuationPromise(value) || MAINTENANCE_EXECUTION_PROMISE_RE.test(value);
}

export function shouldRewriteTerminalResponse(value: string, toolIterations: number): boolean {
  if (toolIterations === 0) return false;
  return looksLikeContinuationPromise(value)
    || MISLEADING_EXECUTED_NEXT_STEP_RE.test(value)
    || NEXT_TURN_HANDOFF_RE.test(value);
}

export function hasRecentUnresolvedDelegatedAction(history: readonly { role: string; content?: string | null; metadata?: Record<string, unknown> }[]): boolean {
  const recentMessages = [...history].reverse().slice(0, 12);

  for (const message of recentMessages) {
    if (message.role !== "tool") continue;

    const metadata = message.metadata ?? {};
    const delegationOutcome = typeof metadata["delegationOutcome"] === "string"
      ? String(metadata["delegationOutcome"]).toLowerCase()
      : undefined;
    const terminalState = typeof metadata["terminalState"] === "string"
      ? String(metadata["terminalState"]).toLowerCase()
      : undefined;
    const content = String(message.content ?? "");

    if (
      delegationOutcome === "partial"
      || delegationOutcome === "failure"
      || terminalState === "max_iterations"
      || terminalState === "timeout"
      || terminalState === "cancelled"
      || /PARTIAL RESULT|max_iterations|timed out|could not complete|delegation limit/i.test(content)
    ) {
      return true;
    }
  }

  return false;
}

export function hasRecentWorkflowAuthoringMaintenanceContext(history: readonly { role: string; content?: string | null }[]): boolean {
  let skippedCurrentUser = false;
  let inspectedPriorUserMessages = 0;

  for (const message of [...history].reverse()) {
    if (message.role !== "user") continue;

    const content = String(message.content ?? "").trim();
    if (!content) continue;

    if (!skippedCurrentUser) {
      skippedCurrentUser = true;
      continue;
    }

    inspectedPriorUserMessages += 1;
    const normalized = content.toLowerCase();
    const guidance = buildDynamicTurnGuidance(content);
    const workflowLike = WORKFLOW_REQUEST_PATTERNS.some((pattern) => pattern.test(normalized))
      || WORKFLOW_HINT_TERMS.some((term) => normalized.includes(term));

    if (guidance?.swarmMaintenanceSensitive && workflowLike) {
      return true;
    }

    if (inspectedPriorUserMessages >= 2) {
      break;
    }
  }

  return false;
}

export function isForcedSynthesisSystemMessage(message: { role: string; content?: string | null }): boolean {
  return message.role === "system"
    && typeof message.content === "string"
    && (
      message.content.startsWith("[SYNTHESIS REQUIRED]")
      || message.content.startsWith("[WARDEN STOP — FORCED SYNTHESIS]")
    );
}

const PRIOR_DELEGATION_JUNK_SUBSTANCE_FLOOR = 1500;

/**
 * Walk recent history for the most recent delegation tool result and decide
 * whether it qualifies as "junk" — i.e. a partial/timeout result whose
 * actual substantive evidence is below the usability floor. Used by the
 * synthesis-required guardrail (Fix 3) to allow ONE recovery delegation
 * through instead of locking the model into synthesizing from a truncated
 * stub. Returns null when the most recent delegation is either substantial
 * or absent.
 */
export function findRecentJunkDelegationResult(
  history: readonly { role: string; content?: string | null; metadata?: Record<string, unknown> }[],
): { agentName: string; substanceChars: number; terminalState: string | null } | null {
  const recent = [...history].reverse().slice(0, 12);
  for (const message of recent) {
    if (message.role !== "tool") continue;
    const content = String(message.content ?? "");
    const meta = message.metadata ?? {};
    const isDelegate = DELEGATE_TOOL_RESULT_RE.test(content) || looksLikeDelegateMetadata(meta);
    if (!isDelegate) continue;

    const terminalState = typeof meta["terminalState"] === "string" ? String(meta["terminalState"]) : null;
    const delegationOutcome = typeof meta["delegationOutcome"] === "string" ? String(meta["delegationOutcome"]) : null;
    const isPartialOrTimeout = terminalState === "timeout"
      || delegationOutcome === "partial"
      || /—\s*PARTIAL PROGRESS|TIMEOUT|TASK FAILED/i.test(content);
    if (!isPartialOrTimeout) {
      // Most recent delegation succeeded with full evidence — there is no
      // recovery scenario to authorize. Stop walking.
      return null;
    }

    // Measure substantive evidence: strip the "Delegated result from / IMPORTANT / Observed evidence:" wrapper and count the body.
    const evidenceMatch = /Observed evidence:\s*([\s\S]+?)(?:\n\n|$)/.exec(content);
    const body = evidenceMatch ? evidenceMatch[1]!.trim() : content.trim();
    // A body containing the "Recovered delegated specialist body (full):"
    // marker is NOT junk — Fix 2 already surfaced the full delegated answer.
    if (/Recovered delegated specialist body \(full\):/i.test(body)) return null;
    if (body.length >= PRIOR_DELEGATION_JUNK_SUBSTANCE_FLOOR) return null;

    const agentName = typeof meta["agentName"] === "string" && meta["agentName"]
      ? meta["agentName"]
      : (content.match(/Delegated result from\s+([^\s—]+)/)?.[1] ?? "a specialist agent");
    return { agentName, substanceChars: body.length, terminalState };
  }
  return null;
}

export function hasRecentForcedSynthesisNudge(
  history: readonly { role: string; content?: string | null }[],
): boolean {
  const recent = [...history].reverse().slice(0, 16);
  return recent.some((message) => isForcedSynthesisSystemMessage(message));
}

/**
 * Walk recent history for a failed delegation tool result.  Returns a
 * short user-facing diagnostic message naming the agent and reason —
 * better UX than the generic empty-response placeholder when the model
 * produced no recoverable text and we already know one specific thing
 * went wrong.  Returns null when the recent transcript shows successful
 * delegations or no delegations at all (in those cases the placeholder
 * remains correct).
 */
export function findRecentFailedDelegation(
  history: readonly { role: string; content?: string | null; metadata?: Record<string, unknown> }[],
): { agentName: string; reason: string; message: string } | null {
  const recent = [...history].reverse().slice(0, 8);
  for (const message of recent) {
    if (message.role !== "tool") continue;
    const content = String(message.content ?? "");
    const meta = message.metadata ?? {};
    const isDelegate = DELEGATE_TOOL_RESULT_RE.test(content) || looksLikeDelegateMetadata(meta);
    if (!isDelegate) continue;
    // Only fire on visible-failure shape — the runtime's
    // buildModelVisibleToolResult rewrites the heading to "TASK FAILED"
    // when the underlying output looked like a failure.  Reading that
    // marker keeps us aligned with what the model itself saw.
    if (!/TASK FAILED\b/i.test(content)) {
      // Successful delegation in scope — don't fire a failure diagnostic.
      return null;
    }
    const agentName = typeof meta["agentName"] === "string" && meta["agentName"]
      ? meta["agentName"]
      : (content.match(/Delegated result from\s+([^\s—]+)/)?.[1] ?? "a specialist agent");
    const evidenceMatch = /Observed evidence:\s*([\s\S]+?)(?:\n\n|$)/.exec(content);
    const reason = evidenceMatch ? evidenceMatch[1]!.trim().slice(0, 280) : "";
    const reasonHint = reason ? ` Reason: ${reason}` : "";
    return {
      agentName,
      reason,
      message:
        `I delegated this task to ${agentName} but the attempt failed before producing an answer.${reasonHint} `
        + `Try the request again, or rephrase it so it can be answered without that specialist.`,
    };
  }
  return null;
}
