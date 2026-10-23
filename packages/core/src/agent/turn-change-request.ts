/**
 * Whether the orchestrator's current turn asked for a file to be created or changed, and whether
 * one has been produced in it so far.
 *
 * Read from the session's history: the message that opened the turn (classifyDeliverableIntent)
 * and the artifacts this turn's tool results recorded (extractArtifactsFromMetadata). Only the
 * orchestrator's own session answers: a specialist's file reaches that history when its delegation
 * returns, after the run that wrote it, so a nested run would read "nothing produced" while it is
 * producing it. Null for a nested run, an unknown session, or a session with no turn.
 */
import { rootSessionOf } from "./session-ids.js";
import { getSession } from "./session.js";
import { currentTurnStartIndex } from "./turn-boundary.js";
import { classifyDeliverableIntent } from "./deliverable-intent.js";
import { extractArtifactsFromMetadata } from "./artifact-metadata.js";

export interface TurnChangeState {
  /** The turn's opening message asks for a file to be created or changed. */
  wantsChange: boolean;
  /** A tool result in this turn recorded a produced file. */
  produced: boolean;
}

export function orchestratorTurnChangeState(sessionId: string): TurnChangeState | null {
  if (rootSessionOf(sessionId) !== sessionId) return null;
  const history = getSession(sessionId)?.getHistory() as Array<{ role: string; content?: unknown; metadata?: Record<string, unknown> }> | undefined;
  if (!history) return null;
  const start = currentTurnStartIndex(history);
  const opening = start >= 0 ? history[start]!.content : undefined;
  if (typeof opening !== "string") return null;
  const produced: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const message of history.slice(start + 1)) {
    if (message.role === "tool" && message.metadata && typeof message.metadata === "object") {
      extractArtifactsFromMetadata(message.metadata, produced, seen);
    }
  }
  return { wantsChange: classifyDeliverableIntent(opening).wantsArtifactMutation, produced: produced.length > 0 };
}
