/**
 * What a finished turn has to say aloud. Only its own answer is read: after a Stop, or a turn that
 * left no message, the newest answer in the chat is the one before — and it was read out as though
 * it were this turn's.
 */

/** The minimum of a chat message this needs (stores/gateway.ts ChatMessage). */
export interface OutcomeMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  /** An error the page shows in place of an answer. */
  blocked?: boolean;
  /** The note of a turn the user stopped. */
  stopped?: boolean;
}

export type TurnOutcome<M extends OutcomeMessage> =
  | { kind: "answer"; message: M }
  | { kind: "failed" }
  | { kind: "silent" };

/** The live bubble of a running turn, which is not an answer yet. */
const STREAMING_ID = "streaming";

/** The newest assistant message, error notes included — what a turn's answer is compared with. */
export function lastAssistantMessage<M extends OutcomeMessage>(messages: readonly M[]): M | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant" && message.id !== STREAMING_ID) return message;
  }
  return undefined;
}

/**
 * How the turn that started after `previousAssistantId` ended: with an answer to read, with an
 * error, or with nothing to say (no new message, a Stop, an empty answer).
 */
export function turnOutcome<M extends OutcomeMessage>(messages: readonly M[], previousAssistantId: string | null): TurnOutcome<M> {
  const message = lastAssistantMessage(messages);
  if (!message || message.id === previousAssistantId || message.stopped) return { kind: "silent" };
  if (message.blocked) return { kind: "failed" };
  return message.content.trim() ? { kind: "answer", message } : { kind: "silent" };
}
