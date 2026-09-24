/**
 * Which user-role message opens a turn.
 *
 * Mid-turn steering and the oversight redirect are injected into the history as `role: "user"`
 * so the model treats them as the user's words — but they arrive INSIDE a turn. Every reader that
 * keyed "the current turn" on the last user-role message (the collapsed-history plan snippet, the
 * delegated-evidence backstops, this turn's artifacts, the timeout delivery, the prior-turn
 * window) therefore cut the turn at the steering message and lost everything before it: a plan
 * report clipped to 2,000 characters on the very turn answering from it, a turn's own artifacts
 * missed by the verification gate, pre-steering evidence dropped by the recovery backstops. Those
 * messages carry the marker below; a turn starts at a user message without it.
 */
export const MID_TURN_USER_MESSAGE_METADATA = "midTurn";

/**
 * Who a mid-turn message came from: "user" for steering the person sent, "oversight" for the
 * progress monitor's redirect. Only the first is the person's words, and only it is shown to them.
 */
export const MID_TURN_SOURCE_METADATA = "midTurnSource";
export type MidTurnSource = "user" | "oversight";

/** The person's own steering messages, `[{id, text}]`, on the history message that folded them in. */
export const STEERING_METADATA = "steering";

/** Opening of the model-facing steering message. The person never wrote it, so it is never shown. */
export const STEERING_PREFIX = "[USER STEERING — sent mid-turn]";

export interface TurnBoundaryMessage {
  role: string;
  metadata?: Record<string, unknown> | undefined;
}

/** True for the user message that opens a turn — not for one injected while the turn ran. */
export function startsTurn(message: TurnBoundaryMessage): boolean {
  return message.role === "user" && message.metadata?.[MID_TURN_USER_MESSAGE_METADATA] !== true;
}

/** Index of the user message that opened the current turn, or -1 when there is none. */
export function currentTurnStartIndex(history: readonly TurnBoundaryMessage[]): number {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (startsTurn(history[i]!)) return i;
  }
  return -1;
}

export interface MidTurnUserMessage {
  id?: string;
  text: string;
}

/**
 * What the person wrote in a mid-turn message, without the wrapper the model reads. Undefined
 * for a message that is not mid-turn; empty for one the person did not write (the oversight
 * redirect), which is then not shown at all. A message saved before the steering metadata
 * existed is read from its wrapper: the body lists each message on a "- " line.
 */
export function midTurnUserMessages(message: TurnBoundaryMessage & { content?: unknown }): MidTurnUserMessage[] | undefined {
  if (message.role !== "user" || message.metadata?.[MID_TURN_USER_MESSAGE_METADATA] !== true) return undefined;
  if (message.metadata[MID_TURN_SOURCE_METADATA] === "oversight") return [];
  const recorded = message.metadata[STEERING_METADATA];
  if (Array.isArray(recorded)) {
    return recorded.flatMap((entry): MidTurnUserMessage[] => {
      if (!entry || typeof entry !== "object") return [];
      const { id, text } = entry as { id?: unknown; text?: unknown };
      if (typeof text !== "string" || !text.trim()) return [];
      return [{ ...(typeof id === "string" && id ? { id } : {}), text: text.trim() }];
    });
  }
  const content = typeof message.content === "string" ? message.content : "";
  const newline = content.indexOf("\n");
  if (!content.startsWith(STEERING_PREFIX) || newline === -1) return [];
  const lines = content.slice(newline + 1).split("\n");
  const texts = lines.every((line) => line.startsWith("- "))
    ? lines.map((line) => line.slice(2))
    : [content.slice(newline + 1).replace(/^- /, "")];
  return texts.map((text) => text.trim()).filter(Boolean).map((text) => ({ text }));
}
