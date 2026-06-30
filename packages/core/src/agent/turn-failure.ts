/**
 * Turn-failure & never-empty-output cluster (god-file seam, extracted from runtime.ts).
 *
 * Pure, non-loop helpers that classify why a turn failed, render the recoverable
 * marker text, persist a turn-failure record to the session, and enforce the
 * never-empty-response invariant on the runTurn boundary. None of these depend on
 * a runtime main-loop singleton — they operate purely on their arguments.
 *
 * TurnOutput is imported type-only from runtime.js (erased at compile time, so this
 * creates no runtime import cycle): it is the public runTurn return shape and stays
 * defined in runtime.ts alongside RunTurnOptions.
 */
import { logAudit } from "../audit/logger.js";
import type { AgentSession } from "./session.js";
import type { TurnOutput } from "./runtime.js";

/**
 * Why a turn threw — used to decide whether it is a recordable failure or an
 * intentional cancel. A caller-initiated abort with no turn-timeout and no
 * Warden cancel is a user stop or a superseding newer turn (chat.cancel / a
 * fresh message), which must NOT clutter the transcript with a failure marker.
 */
export type TurnFailureKind = "timeout" | "warden_abort" | "error" | "cancelled";

export function classifyTurnFailure(flags: {
  callerAborted: boolean;
  turnTimedOut: boolean;
  wardenAborted: boolean;
}): TurnFailureKind {
  if (flags.turnTimedOut) return "timeout";
  if (flags.wardenAborted) return "warden_abort";
  if (flags.callerAborted) return "cancelled";
  return "error";
}

export function turnFailureMarkerText(kind: TurnFailureKind): string {
  switch (kind) {
    case "timeout":
      return "This turn timed out before it could finish — the request was large or the model was slow. Please retry, lower the effort/scope, or break it into smaller parts.";
    case "warden_abort":
      return "This turn was stopped by the safety monitor before it completed. Please retry, or rephrase the request.";
    default:
      return "I wasn't able to complete this turn due to an error. Please retry, or rephrase the request — breaking a complex task into smaller parts usually helps.";
  }
}

/**
 * Record a turn failure so it is never silently absent from the session record:
 * emit a `turn_failed` audit event AND persist a recoverable assistant marker to
 * the transcript (which also advances the session's updatedAt). Intentional
 * cancels are skipped. Returns the marker text, or null when nothing was recorded.
 */
export function recordTurnFailure(session: AgentSession, err: unknown, kind: TurnFailureKind): string | null {
  if (kind === "cancelled") return null;
  const errorMessage = err instanceof Error ? err.message : String(err);
  logAudit("turn_failed", { kind, error: errorMessage }, {
    sessionId: session.id,
    channel: session.channel,
    severity: "error",
  });
  const text = turnFailureMarkerText(kind);
  session.addMessage({ role: "assistant", content: text, metadata: { turnFailed: true, failureKind: kind } });
  return text;
}

/**
 * Turn invariant — a chat turn must never hand the user a blank response.
 *
 * Most terminals build a non-empty message, but some suppression paths (e.g. a
 * tool call dropped as synthesis-required with no accompanying text, or an
 * unexpected early return) can leave `response` empty. This single chokepoint
 * on the runTurn boundary guarantees the user is never met with silence: an
 * empty/whitespace response is replaced with a graceful, recoverable message
 * and the occurrence is audited so the underlying cause stays visible.
 *
 * Non-empty responses pass through unchanged.
 */
export function finalizeTurnOutput(out: TurnOutput, sessionId: string): TurnOutput {
  if (out.response && out.response.trim().length > 0) return out;
  logAudit("guardrail_flagged", {
    type: "empty_response_recovered",
    blocked: out.blocked,
    finishReason: out.performance?.finishReason ?? "unknown",
  }, { sessionId, severity: "warn" });
  return {
    ...out,
    response: "I wasn't able to produce a complete answer this turn. Please retry, or rephrase the request — breaking a complex task into smaller parts usually helps.",
  };
}
