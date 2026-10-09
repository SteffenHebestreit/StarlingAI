/**
 * Questions a running turn puts to the user in a structured form — the image settings card is
 * the first kind — kept as a map keyed by the request's id.
 *
 * A map, not a single slot like the ask_user banner: two specialists can each wait on the user
 * at once (a parallel delegation of two image_creators), and a slot would let the second
 * overwrite the first. The server keeps a request open across a lost connection until it
 * expires, so the map is rebuilt from the session on reload rather than trusted to survive it.
 *
 * Each card sits under the step that is waiting — the generate_image row — rather than in a
 * banner outside the conversation. It is anchored by the tool call's id, so when a message the
 * user sends mid-turn cuts the bubble, the card moves with its step into the segment it belongs
 * to (see turnSegments).
 *
 * Deliberately free of Vue and of the store, like turnSteps and turnSegments.
 */
import { agentEstimateSeconds, engineWaitSeconds, readImageSettingsPayload } from "./imageSettings";
import type { TurnStep } from "./turnSteps";

export type UserInputOutcome = "configured" | "auto" | "cancelled";

export type UserInputReason =
  | "user" | "timeout" | "session_preference" | "no_channel" | "turn_aborted" | "user_skipped" | "disconnected_expired";

export interface UserInputFieldError {
  field: string;
  message: string;
}

export interface UserInputRequest {
  /** The turn that asked. */
  requestId: string;
  /** The chat session the question belongs to — a card for another session is never shown here. */
  sessionId: string;
  inputId: string;
  kind: string;
  title: string;
  /** The tool call that is waiting: what the card is anchored to. */
  toolCallId?: string;
  /** The specialist the waiting call runs inside, when it is not the orchestrator's own. */
  sourceAgent?: string;
  /** What the kind's card renders, built by the server. */
  payload: Record<string, unknown>;
  timeoutMs: number;
  /**
   * When the server stops waiting and goes ahead on its own, BY THE SERVER'S CLOCK. Moves when the
   * user opens Configure. Never compare it with this page's clock directly — see localDeadline.
   */
  expiresAt: string;
  /**
   * The server's clock minus this page's, learned when the question arrived live — it was asked
   * `timeoutMs` before `expiresAt`, and arrived at `askedAt` — or, for one read back from the
   * session's list after a reload, from the server's clock sent with that list (serverClockSkew).
   * Unknown only where the server sends no clock.
   */
  clockSkewMs?: number;
  /** Epoch ms the question was put, for how long the user was waited on. */
  askedAt: number;
  /** The step the card sits under, fixed when it is first found so it follows that step when the bubble is cut. */
  anchorStepId?: string;
  /** "configure" once the user opened the full form and the server extended the deadline for it. */
  phase: "choice" | "configure";
  /** The server's objections to the last answer; the request stays open while they stand. */
  errors?: UserInputFieldError[];
}

export interface UserInputResolution {
  requestId?: string;
  sessionId?: string;
  inputId: string;
  outcome: UserInputOutcome;
  reason?: UserInputReason;
  summary?: string;
}

export type UserInputMap = Record<string, UserInputRequest>;

/** How the question came out, kept on its step once the card is gone. */
export interface StepUserInput {
  kind: string;
  outcome: UserInputOutcome;
  reason?: UserInputReason;
  summary?: string;
  /** How long the step stood waiting on the user rather than working. */
  waitedMs?: number;
  /** The engine that renders — the user's when they configured one, the agent's on Auto. The step's hint reads this, not the agent's args. */
  tier?: string;
  /** What those settings should take once the render starts. */
  expectedSeconds?: number;
  /**
   * When the engine should be done with an earlier, abandoned render, by this page's clock — so
   * the running step counts that wait down, as the card and the form did, instead of repeating
   * what was left of it when the answer went in.
   */
  engineFreeAt?: number;
}

const OUTCOMES = new Set<UserInputOutcome>(["configured", "auto", "cancelled"]);
const REASONS = new Set<UserInputReason>([
  "user", "timeout", "session_preference", "no_channel", "turn_aborted", "user_skipped", "disconnected_expired",
]);

/** The tool whose step a request of each kind belongs under. */
const ANCHOR_TOOL: Record<string, string> = { image_settings: "generate_image" };

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * A request from an `agent.user_input_needed` event or a session's open list. Anything malformed is
 * null. `live` is for the event, which arrives as the question is put — so its window is counted
 * from its arrival on this page's clock, and the server's clock is never compared with this one.
 */
export function readUserInputRequest(raw: unknown, receivedAt: number = Date.now(), live = true): UserInputRequest | null {
  const data = record(raw);
  if (!data) return null;
  const requestId = str(data["requestId"]);
  const sessionId = str(data["sessionId"]);
  const inputId = str(data["inputId"]);
  const kind = str(data["kind"]);
  const expiresAt = str(data["expiresAt"]);
  if (!requestId || !sessionId || !inputId || !kind || !expiresAt || Number.isNaN(Date.parse(expiresAt))) return null;
  const timeoutMs = typeof data["timeoutMs"] === "number" && Number.isFinite(data["timeoutMs"]) ? data["timeoutMs"] : 0;
  return {
    requestId,
    sessionId,
    inputId,
    kind,
    title: str(data["title"]) ?? "The agent needs your input",
    ...(str(data["toolCallId"]) ? { toolCallId: str(data["toolCallId"]) } : {}),
    ...(str(data["sourceAgent"]) ? { sourceAgent: str(data["sourceAgent"]) } : {}),
    payload: record(data["payload"]) ?? {},
    timeoutMs,
    expiresAt,
    ...(live && timeoutMs > 0 ? { clockSkewMs: Date.parse(expiresAt) - timeoutMs - receivedAt } : {}),
    askedAt: receivedAt,
    phase: "choice",
  };
}

/**
 * When a request stops waiting, on THIS page's clock. The server stamps its deadline by its own
 * clock; a browser two minutes ahead of the gateway pruned every card as it arrived and settled it
 * as timed out, while the server waited its full window and then ran Auto — the user never saw the
 * question. Converted by the skew learned when the question arrived, so a deadline the server moves
 * later (opening Configure) converts the same way. Without a skew — a question listed by a server
 * that sent no clock with the list — the server's deadline is all there is.
 */
export function localDeadline(request: Pick<UserInputRequest, "expiresAt" | "clockSkewMs">): number {
  return Date.parse(request.expiresAt) - (request.clockSkewMs ?? 0);
}

/** localDeadline as a timestamp, for what takes one (a countdown). */
export function localExpiresAt(request: Pick<UserInputRequest, "expiresAt" | "clockSkewMs">): string {
  const at = localDeadline(request);
  return Number.isFinite(at) ? new Date(at).toISOString() : request.expiresAt;
}

/**
 * The server's clock minus this page's, from the clock `session.get` sends with its list
 * (`serverNow`): the server read it somewhere between the request leaving (`sentAt`) and the answer
 * arriving (`receivedAt`), so the midpoint is off by at most half the round trip. Undefined when
 * the server sent no clock.
 */
export function serverClockSkew(serverNow: unknown, sentAt: number, receivedAt: number): number | undefined {
  return typeof serverNow === "number" && Number.isFinite(serverNow) ? serverNow - (sentAt + receivedAt) / 2 : undefined;
}

/**
 * A session's open requests, from `session.get`. The client did not see these being asked, so
 * when they were asked is worked out from the deadline instead — good enough for a wait time.
 * `clockSkewMs` is the list's own (serverClockSkew): without it, a browser minutes ahead of the
 * gateway pruned a reloaded card at once and settled it as timed out while the server still waited.
 */
export function readUserInputList(raw: unknown, now: number = Date.now(), clockSkewMs?: number): UserInputRequest[] {
  if (!Array.isArray(raw)) return [];
  const skew = clockSkewMs ?? 0;
  return raw.flatMap((entry) => {
    const request = readUserInputRequest(entry, now, false);
    if (!request) return [];
    const asked = Date.parse(request.expiresAt) - request.timeoutMs - skew;
    return [{
      ...request,
      ...(clockSkewMs !== undefined ? { clockSkewMs } : {}),
      askedAt: request.timeoutMs > 0 && asked < now ? asked : now,
    }];
  });
}

export function readUserInputResolution(raw: unknown): UserInputResolution | null {
  const data = record(raw);
  const inputId = str(data?.["inputId"]);
  const outcome = data?.["outcome"];
  if (!data || !inputId || typeof outcome !== "string" || !OUTCOMES.has(outcome as UserInputOutcome)) return null;
  const reason = data["reason"];
  return {
    inputId,
    outcome: outcome as UserInputOutcome,
    ...(str(data["requestId"]) ? { requestId: str(data["requestId"]) } : {}),
    ...(str(data["sessionId"]) ? { sessionId: str(data["sessionId"]) } : {}),
    ...(typeof reason === "string" && REASONS.has(reason as UserInputReason) ? { reason: reason as UserInputReason } : {}),
    ...(str(data["summary"]) ? { summary: str(data["summary"]) } : {}),
  };
}

/**
 * Whether a request's session is the one on screen. A delegated specialist runs in a
 * sub-session of the chat (`sub:<chat>:…`); its question is still this chat's question.
 */
export function belongsToSession(requestSessionId: string, currentSessionId: string | null | undefined): boolean {
  if (!currentSessionId) return false;
  return requestSessionId === currentSessionId
    || requestSessionId.startsWith(`sub:${currentSessionId}:`)
    || requestSessionId.startsWith(`workflow:${currentSessionId}:`);
}

/**
 * The step a request's card sits under. By the waiting call's id first; without one — or when no
 * step carries it — the newest running step of the kind's tool inside the same specialist (the
 * orchestrator's own, when there is none). `bubbles` is the turn's bubbles, live one first.
 */
export function anchorStepFor(
  bubbles: Array<{ steps?: TurnStep[] }>,
  request: Pick<UserInputRequest, "kind" | "toolCallId" | "sourceAgent">,
): string | undefined {
  if (request.toolCallId) {
    // A call inside a specialist is recorded under the specialist's name as well (see
    // turnSegments liveCallId); the orchestrator's own under its bare id.
    const ids = request.sourceAgent ? [`${request.sourceAgent}:${request.toolCallId}`, request.toolCallId] : [request.toolCallId];
    for (const bubble of bubbles) {
      // Newest first: a reused id belongs to the later call.
      const byId = [...(bubble.steps ?? [])].reverse()
        .find((step) => ids.some((id) => step.id === id || step.id.startsWith(`${id}#`)));
      if (byId) return byId.id;
    }
  }
  const tool = ANCHOR_TOOL[request.kind];
  if (!tool) return undefined;
  for (const bubble of bubbles) {
    const byAgent = [...(bubble.steps ?? [])].reverse().find((step) => step.kind === "tool" && step.name === tool
      && step.status === "running" && step.agent === request.sourceAgent);
    if (byAgent) return byAgent.id;
  }
  return undefined;
}

/**
 * Add a request that arrived for the session on screen. One for another session is ignored —
 * the page shows one conversation. A request seen again (a rehydrate racing the live event)
 * keeps what the user already did with it: an open form, its errors, its anchor.
 */
export function addUserInput(map: UserInputMap, request: UserInputRequest, currentSessionId: string | null | undefined): UserInputMap {
  if (!belongsToSession(request.sessionId, currentSessionId)) return map;
  const existing = map[request.inputId];
  return {
    ...map,
    [request.inputId]: existing
      ? {
          ...request,
          askedAt: existing.askedAt,
          phase: existing.phase,
          ...(existing.errors ? { errors: existing.errors } : {}),
          ...(existing.anchorStepId || request.anchorStepId ? { anchorStepId: existing.anchorStepId ?? request.anchorStepId } : {}),
          // The skew was learned from the live event; a listed copy carries none.
          ...(existing.clockSkewMs !== undefined || request.clockSkewMs !== undefined
            ? { clockSkewMs: existing.clockSkewMs ?? request.clockSkewMs }
            : {}),
          // A deadline the user already extended by opening the form is not shortened by an older copy.
          expiresAt: Date.parse(existing.expiresAt) > Date.parse(request.expiresAt) ? existing.expiresAt : request.expiresAt,
        }
      : request,
  };
}

export function removeUserInput(map: UserInputMap, inputId: string): UserInputMap {
  if (!map[inputId]) return map;
  const { [inputId]: _gone, ...rest } = map;
  return rest;
}

/** Everything a turn asked, once it has ended — the server settles those itself. */
export function dropTurnInputs(map: UserInputMap, requestId: string | null | undefined): UserInputMap {
  if (!requestId) return map;
  const entries = Object.entries(map).filter(([, request]) => request.requestId !== requestId);
  return entries.length === Object.keys(map).length ? map : Object.fromEntries(entries);
}

/**
 * The session's open requests as the server lists them, replacing what the page had. What the
 * user already did with one still open is kept; one the server no longer lists, or whose
 * deadline has passed, is gone — except one that arrived live after the list was asked for
 * (`listedAt`), which the list is too old to know about.
 */
export function rehydrateUserInputs(
  map: UserInputMap,
  sessionId: string,
  open: UserInputRequest[],
  now: number,
  listedAt: number = now,
): UserInputMap {
  const next: UserInputMap = {};
  for (const request of open) {
    const existing = map[request.inputId];
    const merged = addUserInput(existing ? { [request.inputId]: existing } : {}, request, sessionId)[request.inputId];
    if (merged && localDeadline(merged) > now) next[request.inputId] = merged;
  }
  for (const request of Object.values(map)) {
    if (next[request.inputId] || request.askedAt < listedAt) continue;
    if (belongsToSession(request.sessionId, sessionId) && localDeadline(request) > now) next[request.inputId] = request;
  }
  return next;
}

/**
 * Requests past their deadline by more than `graceMs`. The server has gone ahead on its own by
 * then; its resolved event normally closes the card first, but after a reload the event goes to
 * the connection that is gone, and the card must not wait forever.
 */
export function expiredInputIds(map: UserInputMap, now: number, graceMs: number): string[] {
  return Object.values(map)
    .filter((request) => localDeadline(request) + graceMs <= now)
    .map((request) => request.inputId);
}

/** The soonest moment a request will need pruning, or null when there is none. */
export function nextExpiryAt(map: UserInputMap, graceMs: number): number | null {
  const times = Object.values(map).map((request) => localDeadline(request) + graceMs);
  return times.length ? Math.min(...times) : null;
}

/**
 * The session's requests, the first asked first — only those still inside their deadline when
 * `now` is given (without it, the ones the expiry timer has not pruned yet).
 */
export function openInputsFor(map: UserInputMap, sessionId: string | null | undefined, now?: number): UserInputRequest[] {
  return Object.values(map)
    .filter((request) => belongsToSession(request.sessionId, sessionId) && (now === undefined || localDeadline(request) > now))
    .sort((a, b) => a.askedAt - b.askedAt);
}

/** The server's objections to an answer, from `userInput.respond`. Anything malformed is skipped. */
export function readFieldErrors(raw: unknown): UserInputFieldError[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const error = record(entry);
    return error && typeof error["message"] === "string"
      ? [{ field: typeof error["field"] === "string" ? error["field"] : "_form", message: error["message"] }]
      : [];
  });
}

/**
 * Whether the page must not treat a quiet turn as stalled. While the turn waits on the user, no
 * progress event comes — and the stall recovery's answer to silence is to drop the connection
 * and reconnect, which the server reads as the user walking away from the question.
 */
export function holdsStallRecovery(map: UserInputMap, sessionId: string | null | undefined, now: number, askUserOpen: boolean): boolean {
  return askUserOpen || openInputsFor(map, sessionId, now).length > 0;
}

export interface UserInputPlacement {
  /** placementKey(bubble, step) → the requests whose card sits under that step of that bubble. */
  byStep: Record<string, string[]>;
  /** Requests with no step on screen to sit under — a reload, which rebuilt the steps from the transcript. */
  floating: string[];
}

/**
 * Where a card sits: one step of ONE bubble. Step ids are not unique across bubbles — a backend that
 * sends no tool-call ids gets them numbered per response (`tc_0`, `tc_1`, …), so every segment and
 * every turn has an `image_creator:tc_0` — and keyed by the step alone, the card also appeared
 * under an older answer's finished render and forced that folded step list open.
 */
export function placementKey(messageId: string, stepId: string): string {
  return `${messageId}\u241f${stepId}`;
}

/**
 * Where each open card is drawn: under its anchored step, in the bubble of the turn that asked
 * that holds it (newest first). A request with no anchor yet tries again against that turn's
 * bubbles (live one first).
 */
export function placeUserInputs(
  requests: UserInputRequest[],
  messages: Array<{ id: string; role: string; steps?: TurnStep[]; requestId?: string; continued?: boolean }>,
  liveId: string,
): UserInputPlacement {
  const placement: UserInputPlacement = { byStep: {}, floating: [] };
  // Nothing open is the usual case; it must not cost a walk over every step of the session.
  if (requests.length === 0) return placement;
  for (const request of requests) {
    // Only the bubbles of the turn that asked: another turn's running render is not this one. The
    // live bubble counts when it names no turn yet.
    const ofTurn = (message: (typeof messages)[number]) => message.requestId === request.requestId
      || (message.id === liveId && !message.requestId);
    const live = messages.find((message) => message.id === liveId && ofTurn(message));
    const bubbles = [
      ...(live ? [live] : []),
      ...[...messages].reverse().filter((message) => message !== live && ofTurn(message)
        && (message.role === "assistant" || (message.steps?.length ?? 0) > 0)),
    ];
    const stepId = request.anchorStepId ?? anchorStepFor(bubbles.filter((message) => message === live || message.continued), request);
    const holder = stepId ? bubbles.find((message) => (message.steps ?? []).some((step) => step.id === stepId)) : undefined;
    if (holder && stepId) (placement.byStep[placementKey(holder.id, stepId)] ??= []).push(request.inputId);
    else placement.floating.push(request.inputId);
  }
  return placement;
}

/**
 * What stays on the step once its question is settled. `chosen` is what the user's form said; an
 * Auto — theirs, the deadline's, another tab's — runs the agent's settings, whose time the card
 * showed, so the running step shows that too rather than the tier's usual "2–3 min". Either way
 * the engine may first finish a render abandoned earlier, and that wait is kept beside it.
 */
export function stepUserInputRecord(
  request: Pick<UserInputRequest, "kind" | "askedAt" | "payload">,
  resolution: Pick<UserInputResolution, "outcome" | "reason" | "summary">,
  now: number,
  chosen?: { tier?: string; expectedSeconds?: number },
): StepUserInput {
  const payload = request.kind === "image_settings" ? readImageSettingsPayload(request.payload) : null;
  const picked = chosen ?? (payload && resolution.outcome === "auto"
    ? { tier: payload.agent.tier, expectedSeconds: agentEstimateSeconds(payload) }
    : undefined);
  const waitSeconds = payload && picked?.tier ? engineWaitSeconds(payload, picked.tier, request.askedAt, now) : 0;
  return {
    kind: request.kind,
    outcome: resolution.outcome,
    ...(resolution.reason ? { reason: resolution.reason } : {}),
    ...(resolution.summary ? { summary: resolution.summary } : {}),
    waitedMs: Math.max(0, now - request.askedAt),
    ...(picked?.tier ? { tier: picked.tier } : {}),
    ...(picked?.expectedSeconds ? { expectedSeconds: picked.expectedSeconds } : {}),
    ...(waitSeconds > 0 ? { engineFreeAt: now + waitSeconds * 1000 } : {}),
  };
}

/** What the server will record for an answer the client sent and it accepted. */
export function outcomeOfChoice(choice: "auto" | "configure" | "skip"): { outcome: UserInputOutcome; reason: UserInputReason } {
  if (choice === "configure") return { outcome: "configured", reason: "user" };
  if (choice === "skip") return { outcome: "cancelled", reason: "user_skipped" };
  return { outcome: "auto", reason: "user" };
}

/** Field → message, for putting the server's objections next to the inputs they are about. */
export function fieldErrorMap(errors: UserInputFieldError[] | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  for (const error of errors ?? []) {
    const field = error.field?.trim() || "_form";
    map[field] = map[field] ? `${map[field]} ${error.message}` : error.message;
  }
  return map;
}

/** True when the server said the request is gone — answered elsewhere, or past its deadline. */
export function isExpiredAnswer(errors: UserInputFieldError[] | undefined): boolean {
  return Boolean(errors?.some((error) => error.field === "inputId"));
}

export function remainingMs(expiresAt: string | undefined, now: number): number | null {
  if (!expiresAt) return null;
  const at = Date.parse(expiresAt);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/** "1:52" — the time left, rounded up so it never shows 0:00 while there is still time. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * When an ask_user question stops waiting: the server's own deadline when it sends one, else its
 * timeout counted from now. Undefined when it says neither — the banner then shows no countdown.
 */
export function askUserExpiresAt(data: Record<string, unknown>, now: number): string | undefined {
  const expiresAt = data["expiresAt"];
  if (typeof expiresAt === "string" && !Number.isNaN(Date.parse(expiresAt))) return expiresAt;
  const timeoutMs = data["timeoutMs"];
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? new Date(now + timeoutMs).toISOString()
    : undefined;
}

/**
 * Whether a finished tool call is the ask_user the banner shows. Once that call is done the
 * question has been answered — here, in another tab, or by its timeout — and the banner is stale.
 */
export function closesAskUser(question: { requestId: string; toolCallId?: string } | null, done: Record<string, unknown>): boolean {
  if (!question || done["name"] !== "ask_user" || done["requestId"] !== question.requestId) return false;
  const toolCallId = done["toolCallId"];
  return !question.toolCallId || typeof toolCallId !== "string" || toolCallId === question.toolCallId;
}

/**
 * The row of a step that is waiting on the user. Its usual hint ("usually 2–3 min") would be
 * wrong here — nothing renders until the user answers or the deadline passes.
 */
export function awaitingStepTitle(kind: string): string {
  return kind === "image_settings" ? "Waiting for your image settings" : "Waiting for your answer";
}

export function awaitingStepHint(expiresAt: string | undefined, now: number): string {
  const left = remainingMs(expiresAt, now);
  return left === null ? "waiting for you" : `waiting for you · Auto in ${formatCountdown(left)}`;
}
