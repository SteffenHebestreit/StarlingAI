/**
 * A turn the user spoke into while it ran, laid out where their message was READ, not where it
 * was typed.
 *
 * A message sent into a running turn waits in a queue on the server until the model's next
 * step reads it. Until then, everything the turn does still happens before the model has seen
 * it; from then on, everything happens after. So the live bubble is cut at the moment the
 * server says it read the message: what the turn did so far becomes a settled segment, the
 * message moves directly below it, and a fresh live bubble follows for the rest of the turn and
 * its answer. A reload shows the same layout, because the transcript is cut at the same point.
 *
 * The bubbles of one turn share its `requestId`, which is how an event that arrives late — a
 * step that started before the cut and finishes after it — still finds the bubble it belongs to.
 *
 * Deliberately free of Vue and of the store, like turnSteps, so it can be exercised on its own.
 */
import type { StepSource, TurnStep } from "./turnSteps";

/** The id of the live bubble. Only ever one at a time: the newest segment of the running turn. */
export const STREAMING_ID = "streaming";

/** What the live bubble says between the cut and the turn's next event. */
export const FOLDING_IN_STATUS = "Folding in your message…";

/**
 * Where a message sent into a running turn stands.
 *  - queued: the server holds it; the model reads it at its next step.
 *  - consumed: the model read it — it sits between the segments before and after that step.
 *  - held: no turn could take it (the one it was sent into was already finishing); it is sent
 *    as the next turn once the running one settles.
 *  - undelivered: it never reached a model, and nothing will send it on its own.
 */
export type SteerState = "queued" | "consumed" | "held" | "undelivered";

export interface SteerMark {
  /** The id the server knows the message by: sent with it, echoed back when it is read. */
  clientId: string;
  state: SteerState;
  /** Why it was not delivered, when it was not. */
  error?: string;
}

interface SegmentToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
  result?: string;
  metadata?: Record<string, unknown>;
}

/** The minimum of a chat message this module needs — kept structural so it has no store import. */
export interface SegmentMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
  /** The turn a bubble belongs to. */
  requestId?: string;
  /** A user message that was read inside a running turn (live, or from a reloaded transcript). */
  midTurn?: boolean;
  /** An assistant segment the turn continued past — it is not the turn's answer. */
  continued?: boolean;
  steer?: SteerMark;
  steps?: TurnStep[];
  toolCalls?: SegmentToolCall[];
  attachments?: unknown[];
  swarmState?: unknown;
  statusText?: string;
  statusHistory?: string[];
  reasoning?: string;
  subAgentReasoning?: Array<{ agent: string; text: string }>;
}

export interface SteeringEntry {
  id: string;
  text: string;
}

/** The server's list of steering messages, from an event or a final status. Anything malformed is skipped. */
export function readSteeringEntries(raw: unknown): SteeringEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { id, text } = entry as Record<string, unknown>;
    return typeof id === "string" && id && typeof text === "string" ? [{ id, text }] : [];
  });
}

/** The bubble for a message typed into a running turn — pushed at the END, before it is even sent. */
export function newSteerMessage(input: { id: string; clientId: string; text: string; requestId: string; at: Date }): SegmentMessage {
  return {
    id: input.id,
    role: "user",
    content: input.text,
    timestamp: input.at,
    requestId: input.requestId,
    midTurn: true,
    steer: { clientId: input.clientId, state: "queued" },
  };
}

function cloneJson<V>(value: V): V {
  // Swarm state is plain data, but in the store it sits behind a reactive proxy, which
  // structuredClone refuses. A segment needs its own copy: the live one keeps being mutated.
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as V;
}

export interface SteeringRead {
  requestId: string;
  /** When the server read the messages — the start of the segment that follows. */
  at: Date;
  messages: SteeringEntry[];
}

/** The live bubble's state at the moment of the cut, which the store keeps outside the message. */
export interface LiveSnapshot {
  /** The segment's visible text: empty when the model's draft was thrown away. */
  content: string;
  reasoning?: string;
  subAgentReasoning?: Array<{ agent: string; text: string }>;
  /** What the new live bubble carries on with: the swarm keeps running across the cut. */
  swarmState?: unknown;
}

/**
 * Cut the running turn where the server read the user's messages.
 *
 * Returns `[...before, segment?, ...read messages, new live bubble, ...after]`. The segment is
 * only kept when the turn had done or said something — a read at the very start of a turn, or
 * two reads with nothing between them, puts the messages straight above the live bubble. Its
 * steps are NOT settled: a step still running at the cut can still finish, and will find it.
 * Messages still queued stay where they are, below the live bubble, until their own read.
 */
export function splitAtSteering<T extends SegmentMessage>(
  messages: T[],
  read: SteeringRead,
  live: LiveSnapshot,
  newId: () => string,
): T[] {
  const moved = new Set<T>();
  const consumed: T[] = [];
  for (const entry of read.messages) {
    const existing = messages.find((message) => message.role === "user" && message.steer?.clientId === entry.id);
    // Already read: an event seen twice must not cut the turn twice.
    if (existing?.steer?.state === "consumed") continue;
    if (existing) moved.add(existing);
    // A message another tab sent has no bubble here yet; the event carries its text for that.
    consumed.push({
      ...(existing ?? { id: newId(), role: "user", content: entry.text }),
      timestamp: read.at,
      requestId: read.requestId,
      midTurn: true,
      steer: { clientId: entry.id, state: "consumed" },
    } as T);
  }
  if (consumed.length === 0) return messages;

  const rest = messages.filter((message) => !moved.has(message));
  const liveIndex = rest.findIndex((message) => message.id === STREAMING_ID);
  // Nothing to cut — the view was rebuilt under the running turn. The messages still belong
  // at the end, in the order they were read.
  if (liveIndex < 0) return [...rest, ...consumed];

  const running = rest[liveIndex]!;
  const hasWork = Boolean(running.steps?.length || running.toolCalls?.length || running.attachments?.length
    || live.content.trim());
  const segment: T[] = hasWork
    ? [{
        ...running,
        id: newId(),
        requestId: read.requestId,
        continued: true,
        content: live.content,
        steps: running.steps ? [...running.steps] : undefined,
        swarmState: cloneJson(running.swarmState),
        statusText: undefined,
        statusHistory: running.statusHistory ? [...running.statusHistory] : undefined,
        reasoning: live.reasoning?.trim() || undefined,
        subAgentReasoning: live.subAgentReasoning?.length ? live.subAgentReasoning.map((entry) => ({ ...entry })) : undefined,
      } as T]
    : [];
  const nextLive = {
    id: STREAMING_ID,
    role: "assistant",
    content: "",
    timestamp: read.at,
    requestId: read.requestId,
    statusText: FOLDING_IN_STATUS,
    statusHistory: [FOLDING_IN_STATUS],
    steps: [],
    ...(live.swarmState ? { swarmState: live.swarmState } : {}),
  } as unknown as T;
  return [...rest.slice(0, liveIndex), ...segment, ...consumed, nextLive, ...rest.slice(liveIndex + 1)];
}

/**
 * The bubbles of a turn that can still take an event: the live one first, then the segments it
 * was cut from, newest first. New steps only ever go to the live one; a late event for an
 * earlier step searches all of them.
 */
export function turnBubbles<T extends SegmentMessage>(messages: T[], requestId: string | null | undefined): T[] {
  const bubbles: T[] = [];
  const live = messages.find((message) => message.id === STREAMING_ID);
  if (live) bubbles.push(live);
  if (!requestId) return bubbles;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "assistant" && message.continued && message.requestId === requestId) bubbles.push(message);
  }
  return bubbles;
}

export interface ToolDoneRoute<T extends SegmentMessage> {
  /** The running step this completion closes, if one matches. */
  step?: TurnStep;
  /** The recorded call it answers, if one matches. */
  toolCall?: SegmentToolCall;
  /** The bubble whatever the call produced belongs in: the one holding its step or its call. */
  owner?: T;
}

/**
 * The id a live tool call is recorded under. A call made inside a delegated specialist is keyed
 * by that specialist as well: when the backend sends no ids the provider numbers calls itself
 * (`tc_0`, `tc_1`, …), so a specialist's first call and the orchestrator's delegation that runs
 * it can share one — and the specialist's start was then taken for the delegation announced
 * twice, and its finish closed the delegation's row.
 */
export function liveCallId(toolCallId: string, agent?: string): string {
  return agent ? `${agent}:${toolCallId}` : toolCallId;
}

/**
 * Where a finished tool call lands. Its step and its call are each looked up across the turn's
 * bubbles, live one first — a call that started before a cut finishes in the segment it started
 * in, not in the bubble that happens to be live when the result arrives.
 */
export function routeToolDone<T extends SegmentMessage>(
  messages: T[],
  requestId: string | null | undefined,
  done: { name: string; toolCallId?: string; agent?: string },
): ToolDoneRoute<T> {
  const bubbles = turnBubbles(messages, requestId);
  const route: ToolDoneRoute<T> = {};
  const key = done.toolCallId ? liveCallId(done.toolCallId, done.agent) : undefined;
  for (const bubble of bubbles) {
    // Newest first: when an id was reused, the running call is the later one.
    const step = [...(bubble.steps ?? [])].reverse().find((candidate) => candidate.status === "running" && (key
      ? candidate.id === key || candidate.id.startsWith(`${key}#`)
      : candidate.name === done.name && candidate.agent === done.agent));
    if (step) {
      route.step = step;
      route.owner = bubble;
      break;
    }
  }
  for (const bubble of bubbles) {
    const toolCall = key
      ? bubble.toolCalls?.find((call) => call.id === key)
      : bubble.toolCalls?.find((call) => call.name === done.name && call.result === undefined);
    if (toolCall) {
      route.toolCall = toolCall;
      route.owner ??= bubble;
      break;
    }
  }
  // A turn picked up again from its saved segments (resumeTurnSegments): the transcript keeps no
  // call ids, so the orchestrator's own completion finds its call by name — the oldest one still
  // waiting, since a step's calls are recorded in the order they run. Without this the call
  // stayed "no result" after it had finished and the turn had landed.
  if (!route.step && !route.toolCall && key && !done.agent) {
    for (const bubble of bubbles) {
      if (!bubble.continued) continue;
      const toolCall = bubble.toolCalls?.find((call) => call.id === undefined && call.name === done.name && call.result === undefined);
      if (!toolCall) continue;
      route.toolCall = toolCall;
      route.step = bubble.steps?.find((candidate) => candidate.depth === 0 && candidate.status === "running" && candidate.name === done.name);
      route.owner = bubble;
      break;
    }
  }
  route.owner ??= bubbles[0];
  return route;
}

/**
 * Pick a running turn up again from the segments the transcript saved of it — on returning to a
 * session left while the turn ran, after a reload, in a second tab. Each segment after the
 * message that opened the turn becomes one of its bubbles, so a late event still finds it.
 *
 * A call saved without its result is still RUNNING: the runtime writes a step's tool calls
 * before it runs them. Reconstructed as for a finished turn, it read "no result" — a delegation
 * in full swing shown as one that never reported back. `reconstruct` is turnSteps'
 * stepsFromToolCalls, passed in so this module keeps to type imports.
 */
export function resumeTurnSegments<T extends SegmentMessage>(
  messages: T[],
  requestId: string,
  reconstruct: (source: StepSource) => TurnStep[],
): T[] {
  let opener = -1;
  messages.forEach((message, index) => { if (message.role === "user" && !message.midTurn && !message.steer) opener = index; });
  return messages.map((message, index) => {
    if (index <= opener || message.role !== "assistant" || !message.continued || message.requestId) return message;
    const waiting = !message.steps?.length && message.toolCalls?.some((call) => call.result === undefined);
    return { ...message, requestId, ...(waiting ? { steps: runningSteps(message, reconstruct) } : {}) };
  });
}

/**
 * The list without the segments of a turn read from the transcript that the server's list has
 * moved past: one whose calls — which, and which of them answered — differ from the server's
 * copy under its id, or, with no such copy, one still waiting on a call (a step running, a call
 * with no result). Both continued and neither with words, such a copy matched the server's and
 * stood in its place: the turn landed with its delegation spinning and its result gone (review
 * of #38). Kept only while it waited, a segment whose calls had all answered was never replaced
 * again, and the call the turn started next never showed until it landed (review of round 2,
 * D #1). Without them the server's copies stand; the words are sameMessage's to compare.
 *
 * One the server saved as the turn's end — no longer continued — has been moved past too: the
 * turn is over. With words, the page's running copy was the newest message the merge could place
 * the page's list by, and the server had no such message: nothing was placed, and the note on how
 * the turn ended went with the rest of the page's own (review of round 3, D #1).
 */
export function withoutOutdatedSegments<T extends SegmentMessage>(messages: T[], requestId: string, fetched: readonly SegmentMessage[]): T[] {
  const calls = (message: SegmentMessage) => (message.toolCalls ?? [])
    .map((call) => `${call.name}${call.result === undefined ? "?" : "!"}`)
    .join(",");
  const server = new Map(fetched.map((entry) => [entry.id, entry]));
  const outdated = (message: T) => {
    if (message.role !== "assistant" || !message.continued || message.requestId !== requestId) return false;
    const copy = server.get(message.id);
    if (copy && !copy.continued) return true;
    if (copy) return calls(copy) !== calls(message);
    return Boolean(message.steps?.some((step) => step.status === "running") || message.toolCalls?.some((call) => call.result === undefined));
  };
  return messages.some(outdated) ? messages.filter((message) => !outdated(message)) : messages;
}

function runningSteps(message: SegmentMessage, reconstruct: (source: StepSource) => TurnStep[]): TurnStep[] {
  const startedAt = message.timestamp.getTime();
  return reconstruct({ id: message.id, toolCalls: message.toolCalls, swarmState: message.swarmState as StepSource["swarmState"] })
    .map((step) => step.status !== "stopped" ? step : { ...step, status: "running" as const, ...(step.depth === 0 ? { startedAt } : {}) });
}

/**
 * The steps a progress line from inside a delegation is looked up in: the first of the turn's
 * bubbles still running a top-level step, live one first.
 */
export function progressSteps<T extends SegmentMessage>(messages: T[], requestId: string | null | undefined): TurnStep[] | undefined {
  return turnBubbles(messages, requestId)
    .find((bubble) => bubble.steps?.some((step) => step.depth === 0 && step.status === "running"))
    ?.steps;
}

/**
 * Freeze the stream when the turn ends. A step still marked running never reported back —
 * say exactly that, rather than leaving a spinner on a finished answer or guessing "failed".
 */
export function settleSteps(steps: TurnStep[] | undefined, now: number): TurnStep[] | undefined {
  if (!steps?.length) return undefined;
  return steps.map((step) => step.status === "running"
    ? { ...step, status: "stopped" as const, endedAt: now, progress: undefined }
    : { ...step });
}

/**
 * End a turn in the list: every segment of it is settled, and the live bubble is replaced by
 * `replacement` — the answer, an error, a stub — or dropped when there is none. Without a live
 * bubble to replace, the replacement goes at the end.
 */
export function landTurn<T extends SegmentMessage>(messages: T[], requestId: string | null | undefined, replacement: T | null, now: number): T[] {
  const next = messages.map((message) => message.role === "assistant" && message.continued && requestId && message.requestId === requestId
    && message.steps?.some((step) => step.status === "running")
    ? { ...message, steps: settleSteps(message.steps, now) }
    : message);
  const liveIndex = next.findIndex((message) => message.id === STREAMING_ID);
  if (liveIndex >= 0) {
    next.splice(liveIndex, 1, ...(replacement ? [replacement] : []));
  } else if (replacement) {
    next.push(replacement);
  }
  return next;
}

/**
 * The list with the live bubble of a turn picked up part-way holding the whole step the turn is
 * in, for the note that ends it. What the turn saved of that step before the pick-up is its last
 * resumed segment, directly above the live bubble; what came after is in the live bubble — and
 * the server keeps both as one entry, the turn's last. A note made from the live bubble alone
 * never held that entry's calls, so after every read of the transcript it sat beside the entry's
 * "completed without a text summary", and a stopped turn read as a finished one (review of
 * round 3, D #2 — the known limit of rounds 2 and 3). The segment's calls, steps and files go
 * first, the live bubble's after them, and the segment leaves the list.
 *
 * Only a segment without words: one with words stays, and the note beside it (hydration). A
 * segment the turn was cut at by a message it read is not above the live bubble — that message is.
 */
export function withResumedStep<T extends SegmentMessage>(messages: T[], requestId: string): T[] {
  const liveIndex = messages.findIndex((message) => message.id === STREAMING_ID);
  const segment = messages[liveIndex - 1];
  if (liveIndex < 1 || !segment || segment.role !== "assistant" || !segment.continued || segment.requestId !== requestId
    || segment.content.trim()) return messages;
  const live = messages[liveIndex]!;
  const joined = <V>(before: V[] | undefined, after: V[] | undefined) => before?.length || after?.length ? [...(before ?? []), ...(after ?? [])] : undefined;
  const whole = {
    ...live,
    steps: joined(segment.steps, live.steps) ?? live.steps,
    toolCalls: joined(segment.toolCalls, live.toolCalls),
    attachments: joined(segment.attachments, live.attachments),
    swarmState: live.swarmState ?? segment.swarmState,
  };
  return [...messages.slice(0, liveIndex - 1), whole, ...messages.slice(liveIndex + 1)];
}

/**
 * What a turn never read, once it has ended. `held` when it ended on its own — those are sent
 * next; `undelivered` after a stop or an error — nothing sends those without the user asking.
 *
 * `leftovers` is the server's own list. A message still queued that is NOT on it is left as it
 * is: its request is still out, and its reply decides. On `undelivered` every message the turn
 * still had queued or held goes too, since nothing further can read it.
 */
export function markUnread<T extends SegmentMessage>(
  messages: T[],
  requestId: string,
  leftovers: SteeringEntry[],
  state: "held" | "undelivered",
  options: { at: Date; newId: () => string; error?: string },
): T[] {
  const leftoverIds = new Set(leftovers.map((entry) => entry.id));
  const next = messages.map((message) => {
    const steer = message.steer;
    if (!steer || steer.state === "consumed") return message;
    const listed = leftoverIds.has(steer.clientId);
    const unreadHere = state === "undelivered" && message.requestId === requestId && (steer.state === "queued" || steer.state === "held");
    return listed || unreadHere ? { ...message, steer: unreadMark(steer.clientId, state, options.error) } : message;
  });
  // Sent from another tab, never read: this tab has no bubble for it yet.
  return appendUnread(next, requestId, leftovers, state, options);
}

function unreadMark(clientId: string, state: "held" | "undelivered", error?: string): SteerMark {
  return { clientId, state, ...(state === "undelivered" && error ? { error } : {}) };
}

/**
 * A bubble at the end for each message a turn never read that the page shows none for — sent
 * from another tab, or dropped from the page when the user moved to another session while it
 * waited. Every other message is left as it is.
 *
 * With `before`, the bubbles go above that message instead, when the list has it: the message
 * that opened the next turn, for messages typed before it. At the end they came below that
 * turn's answer, as though said after it (review of round 3, B INFO #3).
 */
export function appendUnread<T extends SegmentMessage>(
  messages: T[],
  requestId: string,
  leftovers: SteeringEntry[],
  state: "held" | "undelivered",
  options: { at: Date; newId: () => string; error?: string; before?: string },
): T[] {
  const known = new Set(messages.flatMap((message) => message.steer ? [message.steer.clientId] : []));
  const added: T[] = [];
  for (const entry of leftovers) {
    if (known.has(entry.id)) continue;
    known.add(entry.id);
    added.push({
      id: options.newId(),
      role: "user",
      content: entry.text,
      timestamp: options.at,
      requestId,
      midTurn: true,
      steer: unreadMark(entry.id, state, options.error),
    } as T);
  }
  if (!added.length) return messages;
  const at = options.before === undefined ? -1 : messages.findIndex((message) => message.id === options.before);
  return at < 0 ? [...messages, ...added] : [...messages.slice(0, at), ...added, ...messages.slice(at)];
}

/**
 * The bubbles of messages `requestId` never read that sit below `before`, moved just above it in
 * their order: `before` is the message that opened the turn after it. Typed into a turn another
 * tab's message replaced, or told by the server, such a bubble stayed where it was when that
 * turn ended — below the new turn's message and its work, as though typed into the new turn
 * (review of round 4, D #1).
 */
export function unreadAbove<T extends SegmentMessage>(messages: T[], requestId: string, before: string): T[] {
  const at = messages.findIndex((message) => message.id === before);
  if (at < 0) return messages;
  const below = messages.slice(at + 1).filter((message) => message.requestId === requestId && message.steer !== undefined && message.steer.state !== "consumed");
  if (!below.length) return messages;
  const moved = new Set(below);
  return [...messages.slice(0, at), ...below, ...messages.slice(at).filter((message) => !moved.has(message))];
}

/**
 * The next turn made of every held message: ONE turn, so the model reads them together, as it
 * would have mid-turn. The first bubble takes the combined text and moves to the end, directly
 * above the answer it is about to get; the others fold into it — which is also how a reload
 * shows it, one user message for one turn.
 *
 * Only what `belongs` accepts goes: the list can still hold another session's messages while
 * the one switched to loads, and a message typed into that session must never run as a turn in
 * this one. `clientIds` names the messages taken, which no longer carry their mark.
 *
 * With `newId`, the turn's message is a new one, as it is for a message typed now. Under the
 * first bubble's id, a read of the session already out when it went (a Resend during a reload
 * or a Continue) took it for a message the page had when it asked, which the server did not
 * have yet — and dropped it: the message the user had just sent vanished (review of round 2, D #4).
 */
export function takeFollowUp<T extends SegmentMessage>(
  messages: T[],
  at: Date,
  belongs: (message: T) => boolean = () => true,
  newId?: () => string,
): { messages: T[]; messageId: string; text: string; clientIds: string[] } | null {
  const held = messages.filter((message) => message.role === "user" && message.steer?.state === "held" && belongs(message));
  if (held.length === 0) return null;
  const text = held.map((message) => message.content.trim()).filter(Boolean).join("\n\n");
  const first = held[0]!;
  const { steer: _steer, midTurn: _midTurn, requestId: _requestId, ...plain } = first;
  const opener = { ...plain, ...(newId ? { id: newId() } : {}), content: text, timestamp: at } as unknown as T;
  const heldSet = new Set(held);
  return {
    messages: [...messages.filter((message) => !heldSet.has(message)), opener],
    messageId: opener.id,
    text,
    clientIds: held.map((message) => message.steer!.clientId),
  };
}

/**
 * Put a message back in play at the end of the conversation — where it is now being said — as
 * `queued` into the running turn or `held` for the next one. It keeps its id towards the
 * server, so a resend of something the server did receive after all is still queued once.
 */
export function resteer<T extends SegmentMessage>(messages: T[], messageId: string, state: "queued" | "held", requestId: string | null, at: Date): T[] {
  const message = messages.find((entry) => entry.id === messageId);
  if (!message?.steer) return messages;
  const moved = {
    ...message,
    timestamp: at,
    steer: { clientId: message.steer.clientId, state },
    ...(requestId ? { requestId } : {}),
  } as T;
  return [...messages.filter((entry) => entry !== message), moved];
}

/**
 * The newest turn: its assistant bubbles, and where it starts. Every segment of it stays open
 * and in view while older turns fold away — the turn is one answer, told in parts.
 *
 * Found by shape, not by `requestId`, so a reloaded transcript (which has none) reads the same:
 * from the last assistant bubble back through the messages read mid-turn and the segments
 * continued past, to the message that opened the turn. Messages still waiting to be read or
 * sent sit after the turn and are passed over.
 */
export function latestTurn<T extends SegmentMessage>(messages: T[]): { start: number; assistantIds: Set<string> } {
  const assistantIds = new Set<string>();
  const readMidTurn = (message: T) => message.role === "user" && message.midTurn === true
    && (message.steer === undefined || message.steer.state === "consumed");
  const waiting = (message: T) => message.role === "user" && message.steer !== undefined && message.steer.state !== "consumed";
  let index = messages.length - 1;
  while (index >= 0 && (waiting(messages[index]!) || messages[index]!.role === "system")) index -= 1;
  if (index < 0 || messages[index]!.role !== "assistant") return { start: messages.length, assistantIds };
  assistantIds.add(messages[index]!.id);
  index -= 1;
  while (index >= 0) {
    const message = messages[index]!;
    if (message.role === "system" || readMidTurn(message)) {
      index -= 1;
      continue;
    }
    if (message.role === "assistant" && message.continued) {
      assistantIds.add(message.id);
      index -= 1;
      continue;
    }
    break;
  }
  const start = index >= 0 && messages[index]!.role === "user" ? index : index + 1;
  return { start, assistantIds };
}

/** The settled message that now holds a step — where a step being shown went when its bubble was cut or landed. */
export function messageHoldingStep<T extends SegmentMessage>(messages: T[], stepId: string): T | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.id !== STREAMING_ID && message.steps?.some((step) => step.id === stepId)) return message;
  }
  return undefined;
}

/**
 * Where a side panel showing a step of the live bubble must point once that bubble no longer
 * holds it: the settled message that took it, or null when none did. Undefined while nothing
 * has moved.
 *
 * A step leaves the live bubble in two ways — the turn lands (its answer replaces the bubble),
 * or a mid-turn message is read (the steps so far move into a segment and a fresh live bubble
 * takes over). The second never removes "streaming", so waiting for that is not enough.
 */
export function followFocusedStep<T extends SegmentMessage>(messages: T[], detailMessageId: string | null, stepId: string | null): string | null | undefined {
  if (detailMessageId !== STREAMING_ID || !stepId) return undefined;
  const live = messages.find((message) => message.id === STREAMING_ID);
  if (live?.steps?.some((step) => step.id === stepId)) return undefined;
  return messageHoldingStep(messages, stepId)?.id ?? null;
}
