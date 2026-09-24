/**
 * The structured user-input broker: one process-wide registry of open requests, keyed by the ROOT
 * chat session so a question raised four delegations deep reaches the tab the person is looking at.
 *
 * Why not the per-connection map ask_user uses: a request there died with its WebSocket (reload =
 * empty answer, and the model was told not to ask again), could only be answered from the socket
 * that received it, and settled nothing on Stop. Here a request belongs to the turn, not the
 * socket: it stays open across a disconnect until its own deadline, any tab of the session owner
 * (or an admin) can answer it, and the turn's end, a Stop, a supersede or the gateway watchdog
 * settle it.
 *
 * Every open request is also a HUMAN WAIT. The run clocks (the sub-agent deadline and supervisor,
 * the orchestrator turn deadline, the gateway watchdog) cannot see that a tool is parked on a
 * person, and a person who takes six minutes looks exactly like a wedged run. They subscribe here
 * through trackHumanWaits: no deadline fires while a wait under their run is open, and the waited
 * time is credited back when it closes.
 */

import { randomUUID } from "node:crypto";
import { childLogger } from "../logger.js";
import { logAudit } from "../audit/logger.js";
import { checkInput } from "../guardrails/input.js";
import { currentRequestContext } from "../runtime/request-context.js";
import { getSessionRecord } from "./session.js";
import {
  DEFAULT_MAX_ANSWER_BYTES,
  checkUserInputAnswer,
  clampUserInputTimeoutMs,
  type UserInputChannel,
  type UserInputFieldError,
  type UserInputNeededEvent,
  type UserInputOutcome,
  type UserInputPreview,
  type UserInputRequest,
  type UserInputResolvedEvent,
} from "./user-input.js";

const log = childLogger("agent:user-input");

/** How often a deadline that fired during a human wait looks again. The wait's end re-arms it
 *  directly; this only bounds how long a missed end could hold a clock. */
export const HUMAN_WAIT_RECHECK_MS = 30_000;
/** How long a turn that was stopped, superseded or timed out is remembered after it closed, so a
 *  tool of its run that asks late hears "cancelled" rather than "nobody to ask". */
const ABORTED_TURN_MEMORY_MS = 10 * 60_000;

const KIND_RE = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_TITLE_CHARS = 200;
const MAX_SUMMARY_CHARS = 200;
const EXPIRED: UserInputFieldError[] = [{ field: "inputId", message: "expired" }];

/** Who is answering. `isAdmin` is the auth role rank at admin — not operator, which every account
 *  holds by default and so would let anyone answer anyone's question. */
export interface UserInputCaller {
  userId?: string;
  isAdmin: boolean;
}

export type UserInputEmit = (event: { type: string; data: unknown }) => void;

/** A connection a root's events go to, and who is behind it when the gateway said so. */
interface UserInputSink {
  emit: UserInputEmit;
  caller?: UserInputCaller;
}

export type UserInputRespondResult = { ok: true } | { ok: false; errors: UserInputFieldError[] };

interface OpenTurn {
  rootSessionId: string;
  ownerUserId?: string;
  /** A graceful Stop: open requests were settled, and new ones are answered "cancelled". */
  stopped: boolean;
}

interface PendingUserInput {
  event: UserInputNeededEvent;
  ownerUserId?: string;
  createdAt: number;
  expiresAtMs: number;
  holdTimeoutMs: number;
  maxAnswerBytes: number;
  timer: ReturnType<typeof setTimeout>;
  request: UserInputRequest<unknown>;
  settle: (outcome: UserInputOutcome<unknown>) => void;
  expire: () => void;
}

export interface HumanWaitEvent {
  kind: "start" | "end";
  waitId: string;
  requesterSessionId: string;
  at: number;
  /** The turn the wait was opened under (RequestContext.turnId; absent only outside any turn).
   *  A wait left open by a stopped turn names that turn, so the next turn's clocks ignore it. */
  turnId?: string;
  /** What is being waited on: "person" for a question or a handoff, else a holdTurnClocks reason. */
  reason: string;
}

/** Is `requester` the run itself or something it started? Sub-agent ids embed their parent's id
 *  (`sub:<parent>:<agent>:<ts>`), as do workflow sessions (`workflow:<parent>:<scene>:<uuid>`). */
export function isSameOrNestedSession(requester: string, runSessionId: string): boolean {
  if (!requester || !runSessionId) return false;
  return requester === runSessionId || requester.includes(`:${runSessionId}:`);
}

class UserInputBroker {
  private turns = new Map<string, OpenTurn>();
  private pending = new Map<string, PendingUserInput>();
  /** root session id → sink id (a connection) → where its events go. */
  private sinks = new Map<string, Map<string, UserInputSink>>();
  private waits = new Map<string, { requesterSessionId: string; startedAt: number; turnId?: string; reason: string }>();
  private waitListeners = new Set<(event: HumanWaitEvent) => void>();
  /** Turns closed by a stop, a supersede or a timeout: turn id → its root and when it closed. */
  private abortedTurns = new Map<string, { rootSessionId: string; closedAt: number }>();

  // ── Turns and sinks (the gateway's side) ─────────────────────────────────────────────────────

  /** A turn that may ask. Requests naming any other turn get "no_channel": a background run that
   *  outlived its turn has nobody to ask. */
  openTurn(turnId: string, rootSessionId: string, ownerUserId?: string): void {
    this.abortedTurns.delete(turnId);
    this.turns.set(turnId, { rootSessionId, ...(ownerUserId !== undefined ? { ownerUserId } : {}), stopped: false });
  }

  /**
   * The turn ended ("ended"), or was cancelled, superseded or timed out ("aborted"): settle what
   * it still has open, accept no more. An aborted turn is remembered for a while. Its run does not
   * stop at the abort — a tool already running finishes — and one that asked after the turn was
   * gone read "no_channel", an auto answer, so a render the person had just stopped went ahead
   * (review #16).
   */
  closeTurn(turnId: string, how: "ended" | "aborted" = "ended"): number {
    const turn = this.turns.get(turnId);
    const settled = this.settleWhere((entry) => entry.event.requestId === turnId, "turn_aborted");
    this.turns.delete(turnId);
    if (how === "aborted" && turn) {
      const now = Date.now();
      for (const [id, closed] of this.abortedTurns) {
        if (now - closed.closedAt > ABORTED_TURN_MEMORY_MS) this.abortedTurns.delete(id);
      }
      this.abortedTurns.set(turnId, { rootSessionId: turn.rootSessionId, closedAt: now });
    }
    return settled;
  }

  private wasAborted(channel: UserInputChannel): boolean {
    const closed = this.abortedTurns.get(channel.turnId);
    return closed !== undefined
      && closed.rootSessionId === channel.rootSessionId
      && Date.now() - closed.closedAt <= ABORTED_TURN_MEMORY_MS;
  }

  /** A graceful Stop for the session: settle every open request and refuse new ones, while the turn
   *  itself winds down on its own. */
  stopRoot(rootSessionId: string): number {
    for (const turn of this.turns.values()) {
      if (turn.rootSessionId === rootSessionId) turn.stopped = true;
    }
    return this.settleWhere((entry) => entry.event.sessionId === rootSessionId, "turn_aborted");
  }

  /**
   * Deliver this root's input events to a connection. Idempotent per (root, sink). `caller` is who
   * the connection is; a sink attached without one gets no event emitToOwner sends.
   */
  attachSink(rootSessionId: string, sinkId: string, emit: UserInputEmit, caller?: UserInputCaller): void {
    const forRoot = this.sinks.get(rootSessionId) ?? new Map<string, UserInputSink>();
    forRoot.set(sinkId, { emit, ...(caller ? { caller } : {}) });
    this.sinks.set(rootSessionId, forRoot);
  }

  /**
   * Deliver an event that carries the person's own words to the root's connections whose caller
   * may answer for it: the owner rule session.get applies to its unreadSteering. A sink is
   * attached on the weaker session-access check when its connection starts a turn, so a
   * connection with no identity that drove a turn on someone's chat would otherwise be handed
   * what that person typed.
   */
  emitToOwner(rootSessionId: string, event: { type: string; data: unknown }): void {
    this.emit(rootSessionId, event, (sink) => sink.caller !== undefined && this.canAnswerFor(rootSessionId, sink.caller));
  }

  /** A connection went away. Its requests stay open: another tab, or this one reloaded, answers. */
  detachSink(sinkId: string): void {
    for (const [root, forRoot] of this.sinks) {
      forRoot.delete(sinkId);
      if (forRoot.size === 0) this.sinks.delete(root);
    }
  }

  hasSink(rootSessionId: string): boolean {
    return (this.sinks.get(rootSessionId)?.size ?? 0) > 0;
  }

  /** The owner check for a root: its owner, an admin, or anyone when the session has no owner
   *  (single-user mode, the same rule canAccessSession applies). */
  canAnswerFor(rootSessionId: string, caller: UserInputCaller): boolean {
    const owner = [...this.turns.values()].find((turn) => turn.rootSessionId === rootSessionId)?.ownerUserId
      ?? getSessionRecord(rootSessionId)?.userId;
    return this.ownerAllows(owner, caller);
  }

  /** Open requests of a root the caller may answer, for a page that was reloaded. */
  listOpen(rootSessionId: string, caller: UserInputCaller): UserInputNeededEvent[] {
    return [...this.pending.values()]
      .filter((entry) => entry.event.sessionId === rootSessionId && this.ownerAllows(entry.ownerUserId, caller))
      .map((entry) => ({ ...entry.event }));
  }

  // ── Requests (the tools' side) ────────────────────────────────────────────────────────────────

  async request<T>(
    channel: UserInputChannel | undefined,
    req: UserInputRequest<T>,
    meta: { requesterSessionId: string; sourceAgent?: string; toolCallId?: string; signal?: AbortSignal },
  ): Promise<UserInputOutcome<T>> {
    // A stopped run first, whatever else holds: every hard stop aborts the run and closes its turn
    // in one step, so the turn lookup below found nothing and answered auto (review #16).
    if (meta.signal?.aborted) {
      return { outcome: "cancelled", reason: "turn_aborted", waitedMs: 0, ...(channel ? { rootSessionId: channel.rootSessionId } : {}) };
    }
    if (!channel || channel.mode !== "interactive") return { outcome: "auto", reason: "no_channel", waitedMs: 0 };
    const turn = this.turns.get(channel.turnId);
    if (!turn || turn.rootSessionId !== channel.rootSessionId) {
      return this.wasAborted(channel)
        ? { outcome: "cancelled", reason: "turn_aborted", waitedMs: 0, rootSessionId: channel.rootSessionId }
        : { outcome: "auto", reason: "no_channel", waitedMs: 0 };
    }
    const rootSessionId = channel.rootSessionId;
    if (turn.stopped) return { outcome: "cancelled", reason: "turn_aborted", waitedMs: 0, rootSessionId };
    if (!KIND_RE.test(req.kind)) {
      // A tool bug, not the person's doing: proceed as if nobody could be asked rather than fail the call.
      log.warn({ kind: req.kind }, "User input request with an invalid kind — answered auto");
      return { outcome: "auto", reason: "no_channel", waitedMs: 0 };
    }
    try {
      const settings = getSessionRecord(rootSessionId)?.getSettings();
      if (settings && req.autoIf?.(settings)) {
        return { outcome: "auto", reason: "session_preference", waitedMs: 0, rootSessionId };
      }
    } catch (err) {
      log.warn({ err, kind: req.kind }, "autoIf threw — asking instead");
    }

    let payload: Record<string, unknown>;
    try {
      payload = typeof req.payload === "function" ? await req.payload() : req.payload ?? {};
    } catch (err) {
      // Nothing to show means nothing to ask: proceed as if nobody could be asked.
      log.warn({ err, kind: req.kind }, "User input payload failed to build — answered auto");
      return { outcome: "auto", reason: "no_channel", waitedMs: 0 };
    }
    // Building it can take a moment; the turn may have been stopped or have ended meanwhile, and a
    // request opened after its turn closed would wait out its whole timeout.
    if (turn.stopped || meta.signal?.aborted || this.turns.get(channel.turnId) !== turn) {
      return { outcome: "cancelled", reason: "turn_aborted", waitedMs: 0, rootSessionId };
    }

    const inputId = randomUUID();
    const createdAt = Date.now();
    const timeoutMs = clampUserInputTimeoutMs(req.timeoutMs);
    const holdTimeoutMs = clampUserInputTimeoutMs(req.holdTimeoutMs, timeoutMs);
    const event: UserInputNeededEvent = {
      requestId: channel.turnId,
      sessionId: rootSessionId,
      inputId,
      kind: req.kind,
      title: String(req.title ?? "").trim().slice(0, MAX_TITLE_CHARS) || req.kind,
      ...(meta.toolCallId ? { toolCallId: meta.toolCallId } : {}),
      ...(meta.sourceAgent ? { sourceAgent: meta.sourceAgent } : {}),
      payload,
      timeoutMs,
      expiresAt: new Date(createdAt + timeoutMs).toISOString(),
    };

    return new Promise<UserInputOutcome<T>>((resolve) => {
      const endWait = this.beginHumanWait(meta.requesterSessionId, { turnId: channel.turnId });
      let onAbort: (() => void) | undefined;
      const settle = (outcome: UserInputOutcome<unknown>): void => {
        const entry = this.pending.get(inputId);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(inputId);
        if (onAbort) meta.signal?.removeEventListener("abort", onAbort);
        endWait();
        const resolved: UserInputResolvedEvent = {
          requestId: event.requestId,
          sessionId: rootSessionId,
          inputId,
          outcome: outcome.outcome,
          ...("reason" in outcome ? { reason: outcome.reason } : {}),
          ...(outcome.summary ? { summary: outcome.summary } : {}),
        };
        this.emit(rootSessionId, { type: "agent.user_input_resolved", data: resolved });
        logAudit("user_input_resolved", {
          inputId,
          kind: req.kind,
          outcome: outcome.outcome,
          ...("reason" in outcome ? { reason: outcome.reason } : {}),
          waitedMs: outcome.waitedMs,
          // The person's own summary, never the raw answer: it can hold a whole painted mask.
          ...(outcome.summary ? { summary: outcome.summary } : {}),
        }, { sessionId: rootSessionId, severity: "info" });
        resolve(outcome as UserInputOutcome<T>);
      };
      const expire = (): void => {
        // Nobody watching when the deadline passed: say so, the client shows "continued without you".
        const reason = this.hasSink(rootSessionId) ? "timeout" : "disconnected_expired";
        settle({ outcome: "auto", reason, waitedMs: Date.now() - createdAt, rootSessionId });
      };
      this.pending.set(inputId, {
        event,
        ...(turn.ownerUserId !== undefined ? { ownerUserId: turn.ownerUserId } : {}),
        createdAt,
        expiresAtMs: createdAt + timeoutMs,
        holdTimeoutMs,
        maxAnswerBytes: Math.max(1024, req.maxAnswerBytes ?? DEFAULT_MAX_ANSWER_BYTES),
        timer: setTimeout(expire, timeoutMs),
        request: req as UserInputRequest<unknown>,
        settle,
        expire,
      });
      if (meta.signal) {
        onAbort = () => settle({ outcome: "cancelled", reason: "turn_aborted", waitedMs: Date.now() - createdAt, rootSessionId });
        meta.signal.addEventListener("abort", onAbort, { once: true });
      }
      logAudit("user_input_requested", {
        inputId,
        kind: req.kind,
        timeoutMs,
        ...(meta.sourceAgent ? { sourceAgent: meta.sourceAgent } : {}),
        ...(meta.toolCallId ? { toolCallId: meta.toolCallId } : {}),
      }, { sessionId: rootSessionId, severity: "info" });
      this.emit(rootSessionId, { type: "agent.user_input_needed", data: { ...event } });
    });
  }

  /**
   * An answer from a client. Checks run cheapest first: the request exists, the caller owns the
   * session, the answer fits the limits and passes the guardrail, then the tool's own validator.
   * Any rejection leaves the request open so the person can correct it. An id the caller may not
   * answer reads exactly like an expired one: the reply must not confirm that it exists.
   */
  async respond(inputId: string, answer: unknown, caller: UserInputCaller): Promise<UserInputRespondResult> {
    const entry = this.pending.get(inputId);
    if (!entry) return { ok: false, errors: EXPIRED };
    if (!this.ownerAllows(entry.ownerUserId, caller)) {
      logAudit("rbac_denied", { surface: "user_input", inputId, ...(caller.userId ? { username: caller.userId } : {}) }, {
        sessionId: entry.event.sessionId,
        ...(caller.userId ? { userId: caller.userId } : {}),
        severity: "warn",
      });
      return { ok: false, errors: EXPIRED };
    }
    const limitErrors = checkUserInputAnswer(answer, entry.maxAnswerBytes, (text) => checkInput(text));
    if (limitErrors.length > 0) return { ok: false, errors: limitErrors };

    let verdict: Awaited<ReturnType<UserInputRequest<unknown>["validate"]>>;
    try {
      verdict = await entry.request.validate(answer);
    } catch (err) {
      log.warn({ err, inputId, kind: entry.event.kind }, "User input validator threw — answer rejected");
      return { ok: false, errors: [{ field: "answer", message: "invalid" }] };
    }
    if (!verdict.ok) {
      return { ok: false, errors: verdict.errors.length > 0 ? verdict.errors : [{ field: "answer", message: "invalid" }] };
    }
    // The validator may have awaited (decoding an image): the request can have expired meanwhile.
    if (this.pending.get(inputId) !== entry) return { ok: false, errors: EXPIRED };
    const waitedMs = Date.now() - entry.createdAt;
    const rootSessionId = entry.event.sessionId;
    const summary = typeof verdict.summary === "string" && verdict.summary.trim()
      ? verdict.summary.trim().slice(0, MAX_SUMMARY_CHARS)
      : undefined;
    const extras = { ...(summary ? { summary } : {}), waitedMs, rootSessionId };
    if (verdict.outcome === "auto") {
      entry.settle({ outcome: "auto", reason: "user", ...(verdict.value !== undefined ? { value: verdict.value } : {}), ...extras });
    } else if (verdict.outcome === "cancelled") {
      entry.settle({ outcome: "cancelled", reason: "user_skipped", ...(verdict.value !== undefined ? { value: verdict.value } : {}), ...extras });
    } else {
      entry.settle({ outcome: "configured", value: verdict.value, ...extras });
    }
    return { ok: true };
  }

  /**
   * The person opened the full form: give them the request's configure window from now. Bounded by
   * the first window plus one configure window, so repeated holds cannot park a turn indefinitely.
   */
  hold(inputId: string, caller: UserInputCaller): { expiresAt: string } | null {
    const entry = this.pending.get(inputId);
    if (!entry || !this.ownerAllows(entry.ownerUserId, caller)) return null;
    const ceiling = entry.createdAt + entry.event.timeoutMs + entry.holdTimeoutMs;
    const next = Math.min(Date.now() + entry.holdTimeoutMs, ceiling);
    if (next > entry.expiresAtMs) {
      entry.expiresAtMs = next;
      clearTimeout(entry.timer);
      entry.timer = setTimeout(entry.expire, next - Date.now());
      entry.event.expiresAt = new Date(next).toISOString();
    }
    return { expiresAt: entry.event.expiresAt };
  }

  /** A full-size view of something the payload offered, through the request's own resolver, so an
   *  id it never offered resolves to nothing and no path ever comes from the client. */
  async preview(inputId: string, candidateId: string, caller: UserInputCaller): Promise<UserInputPreview | null> {
    const entry = this.pending.get(inputId);
    if (!entry || !entry.request.preview || !this.ownerAllows(entry.ownerUserId, caller)) return null;
    try {
      return (await entry.request.preview(candidateId)) ?? null;
    } catch (err) {
      log.warn({ err, inputId }, "User input preview failed");
      return null;
    }
  }

  // ── Human waits (the clocks' side) ────────────────────────────────────────────────────────────

  /**
   * Mark a person being waited on by a tool of `requesterSessionId`; call the result when done
   * (idempotent). ask_user uses this directly, structured requests through request(), bounded
   * work the person approved through holdTurnClocks. The wait names the turn it was opened under
   * — the turn in the request context unless given — so it holds that turn's clocks only.
   */
  beginHumanWait(requesterSessionId: string, opts: { turnId?: string; reason?: string } = {}): () => void {
    const waitId = randomUUID();
    const startedAt = Date.now();
    const ambient = currentRequestContext();
    const turnId = opts.turnId ?? ambient?.turnId ?? ambient?.userInput?.turnId;
    const reason = opts.reason ?? "person";
    const scope = { ...(turnId ? { turnId } : {}), reason };
    this.waits.set(waitId, { requesterSessionId, startedAt, ...scope });
    this.notifyWait({ kind: "start", waitId, requesterSessionId, at: startedAt, ...scope });
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.waits.delete(waitId);
      this.notifyWait({ kind: "end", waitId, requesterSessionId, at: Date.now(), ...scope });
    };
  }

  onHumanWait(listener: (event: HumanWaitEvent) => void): () => void {
    this.waitListeners.add(listener);
    return () => { this.waitListeners.delete(listener); };
  }

  openHumanWaits(): HumanWaitEvent[] {
    return [...this.waits].map(([waitId, wait]) => ({
      kind: "start",
      waitId,
      requesterSessionId: wait.requesterSessionId,
      at: wait.startedAt,
      ...(wait.turnId ? { turnId: wait.turnId } : {}),
      reason: wait.reason,
    }));
  }

  resetForTests(): void {
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
    this.turns.clear();
    this.abortedTurns.clear();
    this.sinks.clear();
    this.waits.clear();
    this.waitListeners.clear();
  }

  private ownerAllows(ownerUserId: string | undefined, caller: UserInputCaller): boolean {
    if (caller.isAdmin || ownerUserId === undefined) return true;
    return caller.userId !== undefined && caller.userId === ownerUserId;
  }

  private settleWhere(match: (entry: PendingUserInput) => boolean, reason: "turn_aborted"): number {
    const hits = [...this.pending.values()].filter(match);
    for (const entry of hits) {
      entry.settle({ outcome: "cancelled", reason, waitedMs: Date.now() - entry.createdAt, rootSessionId: entry.event.sessionId });
    }
    return hits.length;
  }

  private emit(rootSessionId: string, event: { type: string; data: unknown }, only?: (sink: UserInputSink) => boolean): void {
    for (const sink of this.sinks.get(rootSessionId)?.values() ?? []) {
      if (only && !only(sink)) continue;
      try {
        sink.emit(event);
      } catch (err) {
        log.warn({ err, type: event.type }, "User input sink failed");
      }
    }
  }

  private notifyWait(event: HumanWaitEvent): void {
    for (const listener of this.waitListeners) {
      try {
        listener(event);
      } catch (err) {
        log.warn({ err }, "Human wait listener failed");
      }
    }
  }
}

export const userInputBroker = new UserInputBroker();

/**
 * The ToolContext.requestUserInput of one run. The channel comes from the request context the run
 * was started under — runTurn sets it for an interactive chat turn, and every in-process delegation
 * inherits it — so no delegation path has to thread it by hand. The tool call id is read when the
 * tool asks: executeTool puts it in the context around each call.
 */
export function bindRequestUserInput(level: {
  requesterSessionId: string;
  sourceAgent?: string;
  signal?: AbortSignal;
}): <T>(request: UserInputRequest<T>) => Promise<UserInputOutcome<T>> {
  const boundChannel = currentRequestContext()?.userInput;
  return (request) => {
    const ambient = currentRequestContext();
    return userInputBroker.request(ambient?.userInput ?? boundChannel, request, {
      requesterSessionId: level.requesterSessionId,
      ...(level.sourceAgent ? { sourceAgent: level.sourceAgent } : {}),
      ...(ambient?.toolCallId ? { toolCallId: ambient.toolCallId } : {}),
      ...(level.signal ? { signal: level.signal } : {}),
    });
  };
}

export interface HumanWaitTracker {
  /** Is a person being waited on by this run or anything it started? */
  isWaiting(): boolean;
  dispose(): void;
}

/**
 * Follow the human waits of one run (its own tool calls and every run nested under it). While one
 * is open the run's clocks must not fire; `onWaitEnded` gets the wall time the run spent waiting —
 * overlapping waits counted once — so the clock can move its deadline by exactly that much.
 *
 * `turnId` is the turn the run belongs to (RequestContext.turnId). Waits are matched by session,
 * and every turn of a chat shares its root session: an ask_user left open by a stopped turn held
 * the next turn's clocks and was then credited to it in full, minutes from before that turn began
 * (review #17).
 * A wait that names another turn is not this run's; one adopted at creation counts from then.
 */
export function trackHumanWaits(
  runSessionId: string,
  onWaitEnded?: (waitedMs: number) => void,
  opts: { turnId?: string } = {},
): HumanWaitTracker {
  const createdAt = Date.now();
  const isOurs = (wait: HumanWaitEvent): boolean =>
    isSameOrNestedSession(wait.requesterSessionId, runSessionId)
    && (!opts.turnId || !wait.turnId || wait.turnId === opts.turnId);
  const open = new Set<string>();
  let since = 0;
  for (const wait of userInputBroker.openHumanWaits()) {
    if (!isOurs(wait)) continue;
    since = createdAt;
    open.add(wait.waitId);
  }
  const unsubscribe = userInputBroker.onHumanWait((event) => {
    if (!isOurs(event)) return;
    if (event.kind === "start") {
      if (open.size === 0) since = event.at;
      open.add(event.waitId);
      return;
    }
    if (!open.delete(event.waitId) || open.size > 0) return;
    const waitedMs = Math.max(0, event.at - since);
    if (waitedMs > 0) onWaitEnded?.(waitedMs);
  });
  return { isWaiting: () => open.size > 0, dispose: unsubscribe };
}

/**
 * Hold every clock of the run around bounded external work the person already approved, exactly
 * as a human wait holds them, and credit the time when it is released: the sub-agent deadline, its
 * supervisor and soft deadline, the orchestrator deadline, the gateway watchdogs and the
 * long-running-generation threshold. A quality render the person configured in the settings step
 * can run for many minutes by design; image_creator's own deadline, and the "keep going?" prompt,
 * read those minutes as a stall (session 807684e9). Only for work that is bounded by its own
 * timeout and that the person asked for — a hold with no end would park the turn to its ceiling.
 *
 * `sessionId` is the tool's ToolContext.sessionId. Returns the release: call it in a finally; a
 * second call does nothing.
 */
export function holdTurnClocks(sessionId: string, reason: string): () => void {
  return userInputBroker.beginHumanWait(sessionId, { reason });
}
