/**
 * A progress message of the live turn (`agent.progress`, packages/core agent/turn-progress.ts):
 * what the turn posted while it worked — that it is looking for its tools, its plan, a step that
 * finished. It is a message of its own, before the bubble the turn is still writing, under the id
 * the transcript gives it, so a later read of the transcript keeps one copy.
 */

/** The live bubble of a running turn. */
const STREAMING_ID = "streaming";

export interface ProgressChatMessage {
  id: string;
  role: "assistant";
  content: string;
  timestamp: Date;
  progress: true;
  requestId?: string;
}

/** The message an `agent.progress` event carries, or null when it carries none. */
export function progressMessageFromEvent(data: Record<string, unknown>): ProgressChatMessage | null {
  const id = typeof data["id"] === "string" ? data["id"] : "";
  const text = typeof data["text"] === "string" ? data["text"].trim() : "";
  if (!id || !text) return null;
  const requestId = typeof data["requestId"] === "string" ? data["requestId"] : undefined;
  const at = typeof data["timestamp"] === "string" ? new Date(data["timestamp"]) : new Date();
  return {
    id,
    role: "assistant",
    content: text,
    timestamp: Number.isNaN(at.getTime()) ? new Date() : at,
    progress: true,
    ...(requestId ? { requestId } : {}),
  };
}

/**
 * Put the message before the live bubble — after the turn's earlier progress messages, which sit
 * there already — or at the end when there is none. False when the list already has it.
 */
export function placeProgressMessage<T extends { id: string }>(messages: T[], message: T): boolean {
  if (messages.some((entry) => entry.id === message.id)) return false;
  const streamingIndex = messages.findIndex((entry) => entry.id === STREAMING_ID);
  if (streamingIndex >= 0) messages.splice(streamingIndex, 0, message);
  else messages.push(message);
  return true;
}
