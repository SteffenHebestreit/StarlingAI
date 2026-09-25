/**
 * Whether a turn the page lost its connection to has finished.
 *
 * Once the connection drops, the turn's events go to the dead socket, so the page can only read
 * the transcript and decide. It used to decide from the transcript alone: more entries than
 * before, the last one from the assistant. But the runtime writes each step's tool-calling
 * message to the history BEFORE its tools run, so a turn half-way through a delegation already
 * looked finished — the page showed the partial state as the answer and stopped waiting for the
 * real one. And the "before" it counted from was only refreshed on a session load, so after a
 * few live turns it was far behind.
 *
 * The server now says whether a turn is running on the session (`activeTurn`); that decides.
 * The transcript still tells an ended turn with an answer from one that ended without.
 *
 * But the turn running there can be another one. A message sent from another tab replaces the
 * running turn (chat.send stops it), and a page following that turn by reading the transcript
 * took the new turn for its own: it spun the old turn's steps for all of the new one's run, never
 * showed the other tab's message, and once the new turn ended said the connection had dropped
 * (review of round 3, D #1). The server names the turn it runs (`activeTurnRequestId`); a name
 * that is not this turn's says this one has ended.
 *
 * Which message in the transcript opened this turn used to be guessed from its words, and a
 * message from another tab in the same words was taken for it: the page spun the ended turn, or
 * followed the other tab's turn as its own (review of round 4, Q7; round 5, V2). The server now
 * names the turn each entry belongs to (`requestId`); a transcript that names turns is read by
 * those names, and one that does not — an older server, history saved before — by the words.
 *
 * Deliberately free of Vue and of the store, so it can be exercised on its own.
 */

export type RecoveryVerdict =
  /** Still running on the server: keep waiting — its answer is not there yet. */
  | "running"
  /** Ended, with an answer in the transcript: show the transcript. */
  | "landed"
  /**
   * Ended, and the session went on to a turn opened after it — a message from another tab, which
   * replaced it or came once it had ended: show the transcript, and follow that turn if it runs.
   */
  | "moved-on"
  /** Ended without an answer to this turn's message: the turn failed or never started. */
  | "lost"
  /** An older server that does not say: keep reading until the answer shows or time runs out. */
  | "unknown";

interface RecoveryEntry {
  role: string;
  content: string;
  midTurn?: boolean;
  /** The turn the entry belongs to, when the server names it. */
  requestId?: string;
  toolCalls?: Array<{ result?: unknown }>;
}

/** A turn to find in a transcript: by its id, or by the words of its opening message where turns have no names. */
export interface TurnRef {
  requestId?: string;
  openerText?: string;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Whether the transcript names the turn of each entry. Then only the name says which turn an
 * entry is: an entry without one is another kind of turn's (a job, a channel), never this page's
 * chat turn, whatever its words.
 */
export function namesTurns(transcript: ReadonlyArray<{ requestId?: string }>): boolean {
  return transcript.some((entry) => entry.requestId !== undefined);
}

/** Whether `entry`, a message that opened a turn, opened `turn` — by name in a transcript that names turns (`named`). */
export function opensTurn(entry: { content: string; requestId?: string }, turn: TurnRef, named: boolean): boolean {
  if (named) return entry.requestId !== undefined && entry.requestId === turn.requestId;
  return turn.openerText === undefined || normalize(entry.content) === normalize(turn.openerText);
}

/** Where the turn's opening message sits in the transcript, and where the newest message that opened a turn does. */
function openers(transcript: RecoveryEntry[], turn: TurnRef): { own: number; newest: number } {
  const named = namesTurns(transcript);
  let own = -1;
  let newest = -1;
  for (let index = transcript.length - 1; index >= 0 && own < 0; index -= 1) {
    const entry = transcript[index]!;
    if (entry.role !== "user" || entry.midTurn) continue;
    if (newest < 0) newest = index;
    if (opensTurn(entry, turn, named)) own = index;
  }
  return { own, newest };
}

/**
 * Where the message that opened the turn after `turn` sits in the transcript — the first after
 * it, not the newest: with two turns opened within one read, what the turn never read went below
 * the first one's message and work, as though typed into it (review of round 5, D E1). -1 when
 * the transcript has no such message.
 */
export function nextOpenerIndex(transcript: RecoveryEntry[], turn: TurnRef): number {
  const { own } = openers(transcript, turn);
  if (own < 0) return -1;
  return transcript.findIndex((entry, index) => index > own && entry.role === "user" && !entry.midTurn);
}

const THINKING_BLOCK_RE = /<(thinking|think)>[\s\S]*?<\/(thinking|think)>/gi;

/**
 * How `turn` ended, as the transcript saved it — for a turn the page did not see end. `answer`:
 * its last entry has words and every call answered. `cut`: a call never answered — the step it
 * was stopped in. `unclear`: nothing saved, or a step without words whose calls all answered,
 * which a stop between two calls and an answer made only of files both leave.
 *
 * A Stop on a followed turn that had already been stopped elsewhere took any entry for the
 * answer, and its partial step read as "completed without a text summary" with no stop note
 * (review of round 3, D #2).
 *
 * Its entries are those named for it where the transcript names turns: a stopped turn still
 * unwinding writes after the message of the turn that replaced it, and by position that write was
 * the other turn's while this one's ending went unseen.
 */
export function savedEnding(transcript: RecoveryEntry[], turn: TurnRef): "answer" | "cut" | "unclear" {
  const { own } = openers(transcript, turn);
  if (own < 0) return "unclear";
  let end = own + 1;
  while (end < transcript.length && !(transcript[end]!.role === "user" && !transcript[end]!.midTurn)) end += 1;
  const entries = namesTurns(transcript) ? transcript.filter((entry, index) => index > own && entry.requestId === turn.requestId) : transcript.slice(own + 1, end);
  const last = entries.filter((entry) => entry.role === "assistant").pop();
  if (!last) return "unclear";
  if (last.toolCalls?.some((call) => call.result === undefined)) return "cut";
  return normalize(last.content.replace(THINKING_BLOCK_RE, "")) ? "answer" : "unclear";
}

export function recoveryVerdict(input: {
  activeTurn?: boolean;
  transcript: RecoveryEntry[];
  totalMessages: number;
  baselineTotalMessages: number;
  /** The user's message that opened the turn, as this page shows it: found by it where the transcript names no turns. */
  openerText?: string;
  /** The turn this page follows. */
  requestId?: string;
  /** The turn the server says runs on the session now, when it names one. */
  activeTurnRequestId?: string;
  /** The user pressed Stop and the server stopped nothing: the turn has ended, whatever runs there now. */
  stopped?: boolean;
  /** Its opening message was read from the transcript (a reload, a second tab): the server has it. */
  openerSaved?: boolean;
}): RecoveryVerdict {
  const another = Boolean(input.activeTurnRequestId) && input.requestId !== undefined && input.activeTurnRequestId !== input.requestId;
  if (input.activeTurn === true && !input.stopped && !another) return "running";
  const { own, newest } = openers(input.transcript, input);
  const named = namesTurns(input.transcript);
  // The turn that replaced it has not saved its message yet: read again rather than end this
  // one on a transcript that does not show what came next.
  if (another && !input.stopped && own >= 0 && own === newest) return "running";
  // An assistant entry of the turn after the user's message that opened it. The newest message
  // that opened a turn must be this one — otherwise the server never got it, and whatever answer
  // follows belongs to an earlier turn — and, where the entries are named, the entry this turn's.
  const answered = own >= 0 && own === newest
    && input.transcript.slice(own + 1).some((later) => later.role === "assistant" && (!named || later.requestId === input.requestId));
  if (input.activeTurn !== undefined || input.stopped || another) {
    if (answered) return "landed";
    // A later message opened a turn. Seen running under another name, it replaced this one; with
    // an opening message the server had, it came after this one ended. The page's own message,
    // after a lost connection, may never have got there — that stays "lost". Found by its name,
    // the message is one the server has.
    if (own >= 0 && newest > own && (another || input.openerSaved || named)) return "moved-on";
    return "lost";
  }
  // No word from the server: an assistant entry still calling tools is a step, not the answer.
  const last = input.transcript[input.transcript.length - 1];
  return answered
    && input.totalMessages > input.baselineTotalMessages
    && last?.role === "assistant"
    && !last.toolCalls?.length
    ? "landed"
    : "unknown";
}
