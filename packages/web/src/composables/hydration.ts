/**
 * Reading a conversation back from the server without losing what only this page has.
 *
 * The page re-reads the transcript on every reconnect and on every session load. Replacing the
 * list outright threw away three kinds of thing the server cannot give back:
 *  - what the page added while the read was in flight — a message sent meanwhile and its live
 *    bubble, which left the turn running with nowhere to show its steps or its answer;
 *  - the live bubble of a turn still running here, and messages not yet delivered to one;
 *  - everything the live view knew about a finished turn — its steps as they happened, its
 *    reasoning, its figures — along with every message's id, so each bubble remounted and a
 *    step open in the side panel pointed at nothing. It did so on every reconnect, even when
 *    nothing at all had changed.
 *
 * So the server's list is taken as the truth for what was said, and this page's own copy of a
 * message is kept wherever the two agree about it. When they agree about everything, the result
 * is the page's own list, message for message, and nothing needs to render again.
 *
 * Deliberately free of Vue and of the store, so it can be exercised on its own.
 */
import { namesTurns, opensTurn, type TurnRef } from "./turnRecovery";

/** The minimum of a chat message this module needs — kept structural so it has no store import. */
export interface HydrationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  midTurn?: boolean;
  /** An assistant segment its turn continued past — not how the turn ended. */
  continued?: boolean;
  steer?: { clientId: string; state: string };
  /** Made by this page and never saved on the server: an error note, a stopped stub. */
  pageOnly?: boolean;
  /** A page-only note on a turn the user stopped — Stop, or a message that replaced it. */
  stopped?: boolean;
  /** The turn a message belongs to — for a page-only note, the turn it reports on. */
  requestId?: string;
  toolCalls?: Array<{ name: string }>;
  attachments?: HydrationAttachment[];
}

interface HydrationAttachment {
  filename: string;
  relativePath?: string;
  externalUrl?: string;
}

const STREAMING_ID = "streaming";

/** How many entries the server may have that this page never saw — a turn that ended while it was away. */
const MAX_UNSEEN_ENTRIES = 24;

const THINKING_BLOCK_RE = /<(thinking|think)>[\s\S]*?<\/(thinking|think)>/gi;
// The stand-in a tool-only answer gets (assistantContent). Built from the calls each side knows
// about, which differ — the live view also saw the specialists' calls — so any two stand-ins count
// as the same text.
const STAND_IN_RE = /^(?:Delegated work|Parallel delegation|Task graph execution|This turn) completed\b.*without a text summary/i;

function comparableText(content: string): string {
  const text = content.replace(THINKING_BLOCK_RE, "").replace(/\s+/g, " ").trim();
  return STAND_IN_RE.test(text) ? "" : text;
}

/**
 * Whether the server's entry and this page's message are the same message. A segment the turn
 * continued past is never the turn's end, even when neither has words: taken for it, a turn
 * followed by reading the transcript landed as its own running copy — no answer, no image, its
 * delegation spinning for good (review of #38).
 *
 * Two that name different turns are never the same, whatever their words: a message another tab
 * sent in the words of the page's own was taken for it, and the page's copy of its turn moved
 * below that message — the note on how its turn ended with it (review of round 4, Q7). Either
 * side without a name (an older server, a message from before) is told by its words.
 */
export function sameMessage(fetched: HydrationMessage, local: HydrationMessage): boolean {
  return fetched.role === local.role
    && Boolean(fetched.midTurn) === Boolean(local.midTurn)
    && Boolean(fetched.continued) === Boolean(local.continued)
    && (fetched.requestId === undefined || local.requestId === undefined || fetched.requestId === local.requestId)
    && comparableText(fetched.content) === comparableText(local.content);
}

function isUnsent(message: HydrationMessage): boolean {
  return message.role === "user" && message.steer !== undefined && message.steer.state !== "consumed";
}

function isPageOnly(message: HydrationMessage): boolean {
  return message.role === "system" || message.pageOnly === true;
}

/**
 * Whether a message can place the page's copy in the server's list. One with nothing comparable
 * to say — a tool-only stand-in, a segment with no text — equals every other such message, so
 * anchoring on it paired the page's last answer with a newer turn the page never saw, and the
 * old answer took that turn's place.
 */
function anchorable(message: HydrationMessage): boolean {
  return !isPageOnly(message) && comparableText(message.content) !== "";
}

/**
 * The page's copy of a message the server agrees on — under the server's id when the page's is
 * a transcript id the server has since moved. A transcript id is a history index, and trimming
 * the history renumbers everything after the cut: a Restart on a message still carrying its old
 * index cut the server's history somewhere else, or nowhere, while the page cut at the message.
 * A page-made id is left alone; a Restart finds that message by its words.
 */
function keepLocal<T extends HydrationMessage>(local: T, fetched: T): T {
  return local.id !== fetched.id && local.id.includes(":") ? { ...local, id: fetched.id } : local;
}

/**
 * Whether `note` holds all that `entry` shows: every call it made, in order, and every file.
 * A turn the page lost can have gone on to make one — that entry is never hidden behind the note.
 */
function coveredBy(entry: HydrationMessage, note: HydrationMessage): boolean {
  const noted = (note.toolCalls ?? []).map((call) => call.name);
  let from = 0;
  for (const call of entry.toolCalls ?? []) {
    const at = noted.indexOf(call.name, from);
    if (at < 0) return false;
    from = at + 1;
  }
  const file = (attachment: HydrationAttachment) => attachment.relativePath ?? attachment.externalUrl ?? attachment.filename;
  const files = new Set((note.attachments ?? []).map(file));
  return (entry.attachments ?? []).every((attachment) => files.has(file(attachment)));
}

/** A note this page made on a turn, naming it — an error, a stopped stub — not a line such as "Connection lost". */
function isTurnNote(message: HydrationMessage): boolean {
  return message.pageOnly === true && message.role === "assistant" && Boolean(message.requestId);
}

/**
 * The page's own note on a turn — its error, its stopped stub — against the server's entries
 * for that turn (those after the same message). After a reconnect both used to show, two
 * failure bubbles under one message, and the turn's steps twice.
 *  - An entry with words records how a failed turn ended (the runtime's failure marker): the
 *    error note goes.
 *  - One without words is what a stopped turn left, shown as "completed without a text summary".
 *    Taken as the turn's end, it replaced "Turn cancelled by user." after every reconnect, and
 *    the stop read as a success (review of #31). The note stands in for it instead, when it holds
 *    every call and file the entry does; one the turn went on to fill after the page lost it stays.
 *  - A stop leaves no marker, so an entry's words never say how a stopped turn ended: they are
 *    the start of the step it cut short. Taken for the marker, they dropped the stop note, and
 *    that step read as the turn's answer (review of round 2, D #2). A stop note (`stopped`)
 *    stays beside such an entry, after it, where the turn ended.
 */
function withoutRecordedNotes<T extends HydrationMessage>(list: T[]): T[] {
  const dropped = new Set<T>();
  // Stop notes, by the entry of their turn they go after.
  const after = new Map<T, T[]>();
  list.forEach((note, index) => {
    if (!isTurnNote(note)) return;
    let start = index - 1;
    while (start >= 0 && list[start]!.role !== "user") start -= 1;
    let end = index + 1;
    while (end < list.length && list[end]!.role !== "user") end += 1;
    const entries = list.slice(start + 1, end).filter((other) => other.role === "assistant" && !other.pageOnly && !other.continued);
    const worded = (entry: T) => comparableText(entry.content) !== "";
    if (!note.stopped && entries.some(worded)) {
      dropped.add(note);
      return;
    }
    for (const entry of entries) if (!worded(entry) && coveredBy(entry, note)) dropped.add(entry);
    const last = entries.filter((entry) => !dropped.has(entry)).pop();
    if (note.stopped && last && list.indexOf(last) > index) after.set(last, [...(after.get(last) ?? []), note]);
  });
  if (!dropped.size && !after.size) return list;
  const moved = new Set([...after.values()].flat());
  return list.flatMap((message) => dropped.has(message) || moved.has(message) ? [] : [message, ...(after.get(message) ?? [])]);
}

/**
 * Whether the page's note on a turn stands in for this entry of the server's: one without words,
 * holding nothing the note does not (withoutRecordedNotes drops it). The page has no copy of it,
 * so the two lists never agree about it — taken for a message they disagree about, it ended the
 * walk that keeps the page's copies. After a stopped turn and another after it, every message
 * above the note came back as the server's copy on every read: new ids, the live steps of the
 * earlier turns gone (review of round 4, D #5).
 */
function standsInFor(note: HydrationMessage, entry: HydrationMessage): boolean {
  return isTurnNote(note) && entry.role === "assistant" && !entry.continued && comparableText(entry.content) === "" && coveredBy(entry, note);
}

/**
 * The server's list, with this page's copy of every message the two agree on, followed by what
 * only this page has.
 *
 * `knownBefore` holds the ids the page had when it asked; anything newer was added while the
 * answer was on its way and is always kept, at the end. When the list is the same conversation
 * (`sameSession`), its live bubble and its undelivered messages are kept there too — unless the
 * server shows the turn already read one, in which case the server's copy, where it was read,
 * stands — and so are the page's own notes, where they were.
 *
 * The page's copies are matched from the newest message with something to say, starting where it
 * sits in the server's list: at the end, or before entries the page never saw. What the page has
 * after it is kept only where the server's list has it too, one for one, in the same order.
 */
export function mergeHydrated<T extends HydrationMessage>(
  fetched: T[],
  local: T[],
  options: { knownBefore: ReadonlySet<string>; sameSession: boolean },
): T[] {
  const readByServer = new Set(fetched.flatMap((message) => message.steer ? [message.steer.clientId] : []));
  const superseded = (message: T) => isUnsent(message) && readByServer.has(message.steer!.clientId);
  const extras = local.filter((message) => !superseded(message) && (
    !options.knownBefore.has(message.id)
    || (options.sameSession && (message.id === STREAMING_ID || isUnsent(message)))
  ));
  if (!options.sameSession) return [...fetched, ...extras];

  const extraSet = new Set(extras);
  const settled = local.filter((message) => !extraSet.has(message) && !superseded(message));
  let newest = settled.length - 1;
  while (newest >= 0 && !anchorable(settled[newest]!)) newest -= 1;
  let anchor = -1;
  if (newest >= 0) {
    for (let index = fetched.length - 1; index >= Math.max(0, fetched.length - 1 - MAX_UNSEEN_ENTRIES); index -= 1) {
      if (sameMessage(fetched[index]!, settled[newest]!)) {
        anchor = index;
        break;
      }
    }
  }
  if (anchor < 0) return [...fetched, ...extras];

  // After the anchor: the page's own notes, and its copies of what the server has next — a
  // tool-only answer, a segment with no text — as long as the two go on agreeing.
  const following: T[] = [];
  let next = anchor + 1;
  let agreeing = true;
  for (const message of settled.slice(newest + 1)) {
    if (isPageOnly(message)) {
      // The server's entries a note stands in for go with it, before it.
      while (agreeing && next < fetched.length && standsInFor(message, fetched[next]!)) following.push(fetched[next++]!);
      following.push(message);
    } else if (agreeing && next < fetched.length && sameMessage(fetched[next]!, message)) {
      following.push(keepLocal(message, fetched[next]!));
      next += 1;
    } else {
      agreeing = false;
    }
  }

  // Walk both lists back from the anchor. The page's own notes stay where they sit among the
  // messages around them, with the server's entries they stand in for; the first message the two
  // disagree about ends the walk, and from there back the server's list stands on its own.
  let index = anchor;
  let cursor = newest;
  const matched: T[] = [];
  while (index >= 0 && cursor >= 0) {
    const message = settled[cursor]!;
    if (isPageOnly(message)) {
      matched.push(message);
      cursor -= 1;
      while (index >= 0 && standsInFor(message, fetched[index]!)) matched.push(fetched[index--]!);
      continue;
    }
    if (!sameMessage(fetched[index]!, message)) break;
    matched.push(keepLocal(message, fetched[index]!));
    index -= 1;
    cursor -= 1;
  }
  const merged = [...fetched.slice(0, index + 1), ...matched.reverse(), ...following, ...fetched.slice(next)];
  return withExtrasInPlace(withoutRecordedNotes(merged), extras, local);
}

/**
 * The list with the page's extras where the page has them: above the message that followed them
 * there, when the list still has that one, else at the end. The live bubble and the messages
 * waiting on it are the page's last, so they stay at the end. A message never delivered does
 * not: nothing will read it any more, and at the end it sat below every turn after it, as though
 * said after them — a message typed into a turn another one replaced came below the new turn's
 * answer, and every undelivered message jumped to the bottom on the next read (review of
 * round 3, B INFO #3).
 */
function withExtrasInPlace<T extends HydrationMessage>(list: T[], extras: T[], local: T[]): T[] {
  const inList = new Set(list);
  const above = new Map<T, T[]>();
  const rest: T[] = [];
  for (const message of extras) {
    let follower: T | undefined;
    for (let index = local.indexOf(message) + 1; index < local.length && !follower; index += 1) {
      if (inList.has(local[index]!)) follower = local[index];
    }
    if (follower) above.set(follower, [...(above.get(follower) ?? []), message]);
    else rest.push(message);
  }
  if (!above.size) return [...list, ...extras];
  return [...list.flatMap((message) => [...(above.get(message) ?? []), message]), ...rest];
}

/** Whether two lists hold the same messages in the same order — then there is nothing to re-render. */
export function sameList<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((message, index) => message === right[index]);
}

/**
 * A transcript read while its last turn still runs: that turn's assistant entries so far are
 * segments it will continue past, not its answer — so they get no stand-in text, and they stay
 * open with the rest of the turn.
 */
export function markRunningTail<T extends { role: string; midTurn?: boolean; continued?: boolean }>(transcript: T[]): T[] {
  let opener = -1;
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const entry = transcript[index]!;
    if (entry.role === "user" && !entry.midTurn) {
      opener = index;
      break;
    }
  }
  return transcript.map((entry, index) => index > opener && entry.role === "assistant" && !entry.continued
    ? { ...entry, continued: true }
    : entry);
}

/**
 * A transcript read while THIS page follows the session's running turn as it happens: what the
 * turn saved since its newest user message is what the live bubble is showing, step by step.
 * Kept, it read as a finished answer above the live bubble — the running work shown twice, and
 * left behind as a "completed without a text summary" once the turn landed.
 *
 * Only once the server has the turn's opening message: before that, the newest entries are the
 * previous turn's — by name where the transcript names turns, else by `openerText`, its words.
 */
export function dropRunningTail<T extends { role: string; content: string; midTurn?: boolean; requestId?: string }>(
  transcript: T[],
  turn: TurnRef,
): T[] {
  let opener = transcript.length - 1;
  while (opener >= 0 && !(transcript[opener]!.role === "user" && !transcript[opener]!.midTurn)) opener -= 1;
  const named = namesTurns(transcript);
  if (opener < 0 || (!named && turn.openerText === undefined) || !opensTurn(transcript[opener]!, turn, named)) return transcript;
  let last = transcript.length - 1;
  while (last > opener && transcript[last]!.role === "assistant") last -= 1;
  return last === transcript.length - 1 ? transcript : transcript.slice(0, last + 1);
}
