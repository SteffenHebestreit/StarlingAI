/**
 * Mid-turn user steering — let the user add guidance WHILE a turn is running,
 * without aborting it (Stop already aborts).
 *
 * On the slow single-GPU backend a turn can run for many minutes (research +
 * build; an image_sourcer run took 14 min). Today the only mid-turn control is
 * Stop. This lets the user instead say "those URLs are wrong, stop guessing" or
 * "also add a summary slide" and have it folded into the SAME turn at the next
 * safe point, instead of waiting it out or losing the work.
 *
 * Mechanics mirror the operator-stop latch (long-running-generation.ts): a
 * per-root (turn) queue the runtime DRAINS between tool-loop iterations and
 * appends to history as an authoritative user message before the next model
 * call. Scoped to the root session id so steering reaches the orchestrator turn
 * regardless of which sub-agent is mid-flight. Only queues while a turn is
 * actually active, so a stray message never leaks into the next turn.
 *
 * Each turn holds a TOKEN. A superseded turn unwinds asynchronously after its
 * replacement has started, and with a per-root flag its `finally` switched the
 * replacement off: every later steer then failed, and the client's fallback
 * cancelled the new turn too. Deactivating, closing and draining now name the
 * turn they belong to, and a stale token touches nothing.
 */

import { randomUUID } from "node:crypto";
import { childLogger } from "../logger.js";
import { logAudit } from "../audit/logger.js";
import { rootSessionOf } from "./session-ids.js";

const log = childLogger("agent:turn-steering");

/** A client-chosen message id is accepted only in this shape; anything else gets a server id. */
const STEERING_CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
/** Queues kept for turns another turn took over, until those turns close. */
const MAX_DISPLACED_QUEUES = 256;
/** Unread leftovers kept per session for a page that was not there to receive them, and for how long. */
const MAX_UNREAD_PER_SESSION = 50;
const UNREAD_TTL_MS = 3_600_000;
/** Sessions holding unread leftovers at once; the oldest goes first. */
const MAX_UNREAD_SESSIONS = 1_000;
/** Ids kept per session as queued since its last drop (_queuedSinceDrop); the oldest goes first. */
const MAX_QUEUED_SINCE_DROP = 256;
/** Messages one turn's log keeps for its specialists (turnLogOf); the oldest goes first. */
const MAX_TURN_LOG = 50;
/** Chat turns remembered as replaced by another (_replacedBy); the oldest goes first. */
const MAX_REPLACED_TURNS = 1_000;

/** What the client and the transcript see of one steering message. */
export interface SteeringMessage {
  id: string;
  text: string;
}

export interface SteeringEntry extends SteeringMessage {
  enqueuedAt: string;
}

export interface SteeringEnqueueResult {
  /** True when the message is in this turn's queue (or already was: a retry of the same id). */
  queued: boolean;
  /** Whether a turn is running for the session at all. */
  active: boolean;
  id?: string;
  /** The caller named a turn that does not own the session's steering: it ended, or another turn
   *  took the session over. Nothing was queued. */
  otherTurn?: true;
  /** With otherTurn: another turn took the session from the named one. Absent when the named turn
   *  simply ended. */
  replaced?: true;
  /** With replaced: that turn's chat.send id, when a chat turn took it. A turn no chat.send started
   *  (AG-UI, a job, a channel) has none to name. */
  replacedBy?: string;
}

/** A message a finished turn never read, kept for the session because nobody received it. */
export interface UnreadSteeringMessage extends SteeringMessage {
  /** The turn that queued it and ended without reading it. */
  requestId: string;
}

interface TurnSteeringState {
  token: string;
  /** The chat.send request id of the turn, when the gateway armed it for one. */
  requestId?: string;
  queue: SteeringEntry[];
  /** Every id this turn accepted, drained or not, so a retried POST is never folded twice. */
  seenIds: Set<string>;
  /** Every message this turn accepted, oldest first, for the specialists running in it (turnLogOf). */
  log: SteeringEntry[];
  /** Ids the turn's orchestrator has drained. */
  takenIds: Set<string>;
}

/** One chat turn's key in a root's records: request ids are the client's, and two sessions may use
 *  the same one. */
function turnKey(root: string, requestId: string): string {
  return `${root}\u0000${requestId}`;
}

/** Strip `sub:` nesting hops to the root (turn) session id. Mirrors rootOf in
 *  long-running-generation.ts so steering is scoped to the whole turn. */
function rootOf(sessionId: string): string {
  return rootSessionOf(sessionId);
}

class TurnSteeringManager {
  /** root (turn) session id → the turn that owns steering for it right now. */
  private _turns = new Map<string, TurnSteeringState>();
  /**
   * What a turn had queued when a newer turn took the root from it, by the OLD turn's token.
   * Taking over used to drop that queue: the old turn's drain and closeTurn both read [] once the
   * token moved on, so a message the server had answered steered:true was folded into neither
   * turn and reported by neither (review #7). The old turn now gets it back at closeTurn, as its
   * own leftovers, on its own final status.
   */
  private _displaced = new Map<string, SteeringEntry[]>();
  /**
   * Leftovers whose turn's final status had no socket to go to, by root session, oldest first. A
   * turn's leftovers ride its final status to the connection that started it; after a reload that
   * socket is gone, and a message queued from the reloaded page stayed "Queued" there forever
   * (review of round 1, B #5). The page reads them from session.get instead, and the gateway also
   * pushes them to the session's open pages as agent.unread_steering. Kept until the next
   * turn of the session starts, whose send gets them back, and never longer than an hour.
   */
  private _unread = new Map<string, Array<UnreadSteeringMessage & { keptAt: number }>>();
  /**
   * For a root that was reset, rewound or deleted (dropUnread): the ids queued since its last drop,
   * each tagged when it is queued. A message queued before the drop belongs to the history that is
   * gone, and keepUnread keeps and pushes none of those (review of round 4, B #2). The queues
   * themselves are left alone: clearing them lost a message typed before a Reset, which does not
   * stop the turn, so the turn's own final status no longer listed it and the page showed it
   * "Queued" for good (turn-ids review, R1). Tagged by id rather than on the entry: a leftover
   * reaches keepUnread through the runtime's TurnOutput as a bare id and text, and the rule must
   * hold for a drop between the turn's close and its final status too. Each tag names the turn as
   * well as the id (tagOf): a message resent under the same id into a later turn is another
   * message, and its tag let the earlier turn's leftovers keep the first one (turn-ids review
   * round 2, INFO 3).
   */
  private _queuedSinceDrop = new Map<string, Set<string>>();
  /**
   * The chat turn that took the root from another, by the replaced turn's request id. A steer
   * typed into a replaced turn was refused like one typed into a turn that ended, and the page then
   * sent it on by itself as a new turn, though another tab had moved the chat on (turn-ids review,
   * LOW 2). Keyed by root and request id (turnKey): request ids are the client's, and one session's
   * id named another session's replacement (round 2, LOW 1). Recorded for any turn that takes the
   * root, not only a chat turn: a job or AG-UI turn moves the chat on as well (round 2, LOW 2).
   */
  private _replacedBy = new Map<string, { by?: string }>();

  /**
   * Open steering for a turn that is about to start. The gateway calls this before runTurn: the
   * runtime reaches markTurnActive only after its start-up awaits, and a message sent in that gap
   * used to find no turn, so the client fell back to a new send that cancelled the one starting.
   * Takes the root from any other turn: the newest turn owns steering, and what the old one had
   * queued becomes its leftovers.
   *
   * Returns what earlier turns of the session left unread and this start retires, so the send that
   * started it can hand them back to its page. The web stops its turn with chat.cancel and only
   * then sends the next message; a turn that unwound in that gap had its leftovers kept for the
   * session and then dropped here at once, shown to nobody (review of round 2, B #5).
   *
   * `requestId` is the chat.send id of the turn, which a steer may name to reach this turn only.
   */
  armTurn(sessionId: string, token: string, requestId?: string): UnreadSteeringMessage[] {
    return this.takeRoot(rootOf(sessionId), token, requestId);
  }

  /**
   * Mark the start of a turn and return its token. A turn the gateway armed changes nothing
   * here: what was queued while it started up stays queued, and when a newer turn has armed
   * since, this one is already superseded and must not take steering back. Any other turn
   * takes over the root with a fresh, empty queue.
   */
  markTurnActive(sessionId: string, armedToken?: string): string {
    if (armedToken !== undefined) return armedToken;
    const token = randomUUID();
    this.takeRoot(rootOf(sessionId), token);
    return token;
  }

  /**
   * Keep leftovers of a turn whose final status reached nobody, for the session's next reader, and
   * return the ones kept: none that was queued before the session's last reset, rewind or delete
   * (_queuedSinceDrop). The rule is per message: refusing a whole turn that predated the drop also
   * refused what the person steered into it afterwards, which then stayed "Queued" on their page
   * (round 5, B #1).
   */
  keepUnread(sessionId: string, requestId: string, messages: readonly SteeringMessage[]): SteeringMessage[] {
    const root = rootOf(sessionId);
    const sinceDrop = this._queuedSinceDrop.get(root);
    const keep = sinceDrop ? messages.filter((message) => sinceDrop.has(tagOf(requestId, message.id))) : messages;
    if (keep.length === 0) return [];
    const now = Date.now();
    this.pruneUnread(now);
    const kept = (this._unread.get(root) ?? []).filter((entry) => !keep.some((message) => message.id === entry.id));
    kept.push(...keep.map(({ id, text }) => ({ id, text, requestId, keptAt: now })));
    // Re-inserted so the map's order stays oldest-written first for the cap below.
    this._unread.delete(root);
    this._unread.set(root, kept.slice(-MAX_UNREAD_PER_SESSION));
    if (this._unread.size > MAX_UNREAD_SESSIONS) {
      const oldest = this._unread.keys().next().value;
      if (oldest !== undefined) this._unread.delete(oldest);
    }
    return keep.map(({ id, text }) => ({ id, text }));
  }

  /** What the session's finished turns left unread and delivered to nobody, oldest first. */
  unreadOf(sessionId: string): UnreadSteeringMessage[] {
    this.pruneUnread(Date.now());
    return (this._unread.get(rootOf(sessionId)) ?? []).map(({ id, text, requestId }) => ({ id, text, requestId }));
  }

  /**
   * Forget what the session's finished turns left unread. For a history that was reset, rewound or
   * deleted: they belong to the part that is gone, and after a reset every session.get brought
   * them back into the emptied chat as undelivered, with a Resend (review of round 2, B #4). What
   * its turns have queued and not read yet stays queued: a running turn still reads it, and a final
   * status still lists it to the page that sent it, but the session never keeps or pushes it
   * (_queuedSinceDrop).
   */
  dropUnread(sessionId: string): void {
    const root = rootOf(sessionId);
    this._unread.delete(root);
    // Re-inserted to keep the oldest drop first. A session pushed out by a thousand other sessions'
    // drops keeps every leftover again, as before these marks.
    this._queuedSinceDrop.delete(root);
    this._queuedSinceDrop.set(root, new Set());
    if (this._queuedSinceDrop.size > MAX_UNREAD_SESSIONS) {
      const oldest = this._queuedSinceDrop.keys().next().value;
      if (oldest !== undefined) this._queuedSinceDrop.delete(oldest);
    }
  }

  private pruneUnread(now: number): void {
    for (const [root, entries] of this._unread) {
      const live = entries.filter((entry) => now - entry.keptAt < UNREAD_TTL_MS);
      if (live.length === 0) this._unread.delete(root);
      else if (live.length !== entries.length) this._unread.set(root, live);
    }
  }

  /** Mark a turn finished; a no-op unless `token` is the turn that owns the root. */
  markTurnDone(sessionId: string, token: string): void {
    this._displaced.delete(token);
    const root = rootOf(sessionId);
    if (this._turns.get(root)?.token === token) this._turns.delete(root);
  }

  /**
   * End the turn and hand back what it never drained, in one synchronous step, so no message can
   * be accepted between the last read of the queue and the switch-off. For a turn a newer one
   * took the root from, that is what it had queued at that moment; empty for any other token.
   */
  closeTurn(sessionId: string, token: string): SteeringEntry[] {
    const displaced = this._displaced.get(token);
    if (displaced) {
      this._displaced.delete(token);
      return displaced;
    }
    const root = rootOf(sessionId);
    const state = this._turns.get(root);
    if (!state || state.token !== token) return [];
    this._turns.delete(root);
    return state.queue;
  }

  private takeRoot(root: string, token: string, requestId?: string): UnreadSteeringMessage[] {
    // A new turn has started: what an earlier one left unread is now older than the conversation.
    const retired = this.unreadOf(root);
    this._unread.delete(root);
    const previous = this._turns.get(root);
    if (previous && previous.token !== token && previous.queue.length > 0) {
      this._displaced.set(previous.token, previous.queue);
      // Bounded: every turn closes or finishes, but a crash between the two must not let this grow.
      if (this._displaced.size > MAX_DISPLACED_QUEUES) {
        const oldest = this._displaced.keys().next().value;
        if (oldest !== undefined) this._displaced.delete(oldest);
      }
    }
    // Named to a steer still typed into the old turn (enqueue).
    if (previous?.requestId && previous.requestId !== requestId) {
      this._replacedBy.set(turnKey(root, previous.requestId), requestId ? { by: requestId } : {});
      if (this._replacedBy.size > MAX_REPLACED_TURNS) {
        const oldest = this._replacedBy.keys().next().value;
        if (oldest !== undefined) this._replacedBy.delete(oldest);
      }
    }
    // A request id used again for a new turn names that turn now, not the one it replaced: a client
    // reusing ids had a steer into a turn that simply ended refused as replaced (final review, LOW 2).
    if (requestId) this._replacedBy.delete(turnKey(root, requestId));
    this._turns.set(root, { token, ...(requestId ? { requestId } : {}), queue: [], seenIds: new Set(), log: [], takenIds: new Set() });
    return retired;
  }

  /** Is a turn currently running for this (root) session? */
  isTurnActive(sessionId: string): boolean {
    return this._turns.has(rootOf(sessionId));
  }

  /**
   * Queue a steering message — but ONLY if a turn is actually in flight for the session, so a
   * stray message never leaks into a later turn. `clientId` becomes the message id when it has
   * the accepted shape, else the server picks one; an id this turn already accepted is not
   * queued again, which makes a retried request safe.
   *
   * With `requestId`, only the chat turn of that id takes it. A page still showing a turn another
   * tab had replaced steered the replacement, and its message then belonged to a turn the page
   * never ran.
   */
  enqueue(sessionId: string, text: string, clientId?: string, requestId?: string): SteeringEnqueueResult {
    const root = rootOf(sessionId);
    const state = this._turns.get(root);
    const trimmed = (text ?? "").trim();
    if (requestId !== undefined && state?.requestId !== requestId) {
      const replaced = this._replacedBy.get(turnKey(root, requestId));
      return {
        queued: false,
        active: Boolean(state),
        otherTurn: true,
        ...(replaced ? { replaced: true as const } : {}),
        ...(replaced?.by ? { replacedBy: replaced.by } : {}),
      };
    }
    if (!state) return { queued: false, active: false };
    if (!trimmed) return { queued: false, active: true };
    const id = typeof clientId === "string" && STEERING_CLIENT_ID_RE.test(clientId) ? clientId : randomUUID();
    if (state.seenIds.has(id)) return { queued: true, active: true, id };
    state.seenIds.add(id);
    const entry = { id, text: trimmed, enqueuedAt: new Date().toISOString() };
    state.queue.push(entry);
    state.log.push(entry);
    if (state.log.length > MAX_TURN_LOG) state.log.shift();
    // Typed into the chat as it is now, after its last drop if it had one (_queuedSinceDrop).
    const sinceDrop = this._queuedSinceDrop.get(root);
    if (sinceDrop) {
      sinceDrop.add(tagOf(state.requestId, id));
      if (sinceDrop.size > MAX_QUEUED_SINCE_DROP) {
        const oldest = sinceDrop.values().next().value;
        if (oldest !== undefined) sinceDrop.delete(oldest);
      }
    }
    logAudit("turn_steering_enqueued", {
      length: trimmed.length,
      queued: state.queue.length,
    }, { sessionId: root, severity: "info" });
    log.info({ root, queued: state.queue.length }, "Mid-turn steering message queued");
    return { queued: true, active: true, id };
  }

  /** Boolean form of enqueue: true when queued, false when no turn is active. */
  enqueueIfActive(sessionId: string, text: string): boolean {
    return this.enqueue(sessionId, text).queued;
  }

  /** Take and clear all queued steering messages for a (root) session. With `token`, only the
   *  turn that owns the root gets them: a superseded turn still unwinding must not take its
   *  replacement's messages. */
  drain(sessionId: string, token?: string): SteeringEntry[] {
    const state = this._turns.get(rootOf(sessionId));
    if (!state || state.queue.length === 0) return [];
    if (token !== undefined && state.token !== token) return [];
    const queue = state.queue;
    state.queue = [];
    for (const entry of queue) state.takenIds.add(entry.id);
    return queue;
  }

  /**
   * What this turn has accepted so far, oldest first, and whether its orchestrator has drained each
   * one. Read-only, for the specialists running in the turn (agent/sub-agent.ts): the orchestrator
   * folds a message in at its own next iteration, and that iteration waits for the delegation to
   * return — in session ffe08297 a message reached the orchestrator five minutes later and never the
   * run doing the work. Any (sub-)session id of the turn resolves to its root.
   */
  turnLogOf(sessionId: string): Array<SteeringMessage & { taken: boolean }> {
    const state = this._turns.get(rootOf(sessionId));
    if (!state) return [];
    return state.log.map(({ id, text }) => ({ id, text, taken: state.takenIds.has(id) }));
  }

  hasPending(sessionId: string): boolean {
    const state = this._turns.get(rootOf(sessionId));
    return Boolean(state && state.queue.length > 0);
  }

  /** Reset for tests. */
  resetForTests(): void {
    this._turns.clear();
    this._displaced.clear();
    this._unread.clear();
    this._queuedSinceDrop.clear();
    this._replacedBy.clear();
  }
}

/** A message's tag in _queuedSinceDrop: the turn it was queued into, and its id. */
function tagOf(requestId: string | undefined, id: string): string {
  return `${requestId ?? ""}\u0000${id}`;
}

// Singleton
export const turnSteeringManager = new TurnSteeringManager();

/**
 * Steering a FAILED turn never drained. A thrown turn has no TurnOutput to carry them, so the
 * runtime records them against the error it rethrows and the gateway reads them back for the
 * error status.
 */
const unconsumedByError = new WeakMap<object, SteeringMessage[]>();

export function recordUnconsumedSteering(err: unknown, messages: readonly SteeringMessage[]): void {
  if (messages.length === 0 || !err || typeof err !== "object") return;
  unconsumedByError.set(err, messages.map(({ id, text }) => ({ id, text })));
}

export function unconsumedSteeringOf(err: unknown): SteeringMessage[] {
  if (!err || typeof err !== "object") return [];
  return unconsumedByError.get(err) ?? [];
}
