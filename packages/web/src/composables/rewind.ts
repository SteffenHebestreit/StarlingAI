/**
 * Where on the server a Restart cuts the conversation.
 *
 * A message read back from the transcript carries its history index in its id. One sent from
 * this page has only a local id, so it is found in the transcript by its words. The first match
 * was taken — the OLDEST — so restarting from the second of two "continue" messages cut the
 * server's history at the first while the page cut at the second, and the two told different
 * conversations from then on. The right match is counted from the end: as many identical
 * messages come after it in the transcript as come after it on the page.
 *
 * Deliberately free of Vue and of the store, so it can be exercised on its own.
 */

interface RewindMessage {
  id: string;
  role: string;
  content: string;
  midTurn?: boolean;
  steer?: unknown;
}

/** The history index in a transcript id (`<session>:<index>`); none in a local id or a mid-turn entry's `+k` id. */
export function transcriptHistoryIndex(id: string): number | null {
  const match = /:(\d+)$/.exec(id);
  return match ? Number(match[1]) : null;
}

/** A user message that opened a turn — the only kind a Restart is offered on. */
function opensTurn(message: RewindMessage): boolean {
  return message.role === "user" && !message.midTurn && !message.steer;
}

/**
 * The server history index to rewind before, for the page's message at `clickedIndex`; null when
 * the transcript does not have it (the caller then leaves both sides as they are).
 */
export function rewindHistoryIndex(local: RewindMessage[], clickedIndex: number, transcript: RewindMessage[]): number | null {
  const clicked = local[clickedIndex];
  if (!clicked || !opensTurn(clicked)) return null;
  const own = transcriptHistoryIndex(clicked.id);
  if (own !== null) return own;
  const laterOnPage = local.slice(clickedIndex + 1).filter((message) => opensTurn(message) && message.content === clicked.content).length;
  const matches = transcript.filter((entry) => entry.role === "user" && !entry.midTurn && entry.content === clicked.content);
  const match = matches[matches.length - 1 - laterOnPage];
  return match ? transcriptHistoryIndex(match.id) : null;
}

/** Whether the transcript read so far is enough to place the message, or older pages are needed. */
export function needsOlderTranscript(local: RewindMessage[], clickedIndex: number, transcript: RewindMessage[]): boolean {
  const clicked = local[clickedIndex];
  if (!clicked || transcriptHistoryIndex(clicked.id) !== null) return false;
  return rewindHistoryIndex(local, clickedIndex, transcript) === null;
}
