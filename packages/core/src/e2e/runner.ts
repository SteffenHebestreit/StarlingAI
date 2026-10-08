/**
 * Runs scenarios against a live gateway: one attempt = the scenario's steps in order, in fresh
 * sessions, as the scenario's identity (a turn with `as` runs as another one, in that identity's
 * own session). A scenario repeated k times passes only when all k attempts pass
 * (pass^k). Scenarios run `concurrency` at a time (default 1: the model backend is shared);
 * scenarios with mail steps never overlap each other, because a purge empties every mailbox.
 *
 * Turns go through chat.send exactly as the dashboard sends them, `during` actions fire once
 * when their trigger fires (an audit event of the running turn, or a delay after the send), and
 * a turn that outlives its timeout — or the attempt's — is stopped with chat.cancel before the
 * attempt is reported, so a hung turn never keeps the shared backend busy.
 *
 * Event window: some audit events of a turn are logged after its final status (the intent
 * readout runs post-delivery; scorecards and latency rows trail). A turn's events are therefore
 * everything of its session from the send until the next step that is not a `wait` starts — a
 * wait extends the window — and its events/tools/agents expectations (and the judge, which runs
 * last) are evaluated when the window closes. After the last such step the window stays open
 * for `eventGraceMs` past the final status. Status, reply, artifacts and duration are settled by
 * the final status and checked at once; a failure there closes the window immediately.
 */
import { randomUUID } from "node:crypto";
import { basename, extname, resolve } from "node:path";
import type { E2EEventMatcher, E2EHttpStep, E2EMailStep, E2EScenario, E2EService, E2EStep, E2ETurnStep } from "./scenario.js";
import {
  describeError,
  E2EInfraError,
  isRecord,
  type GatewayClient,
  type GatewayConnection,
  type TurnStatusMessage,
} from "./gateway-client.js";
import {
  describeMatcher,
  evaluateCompletionExpectations,
  evaluateEventExpectations,
  eventTypeCounts,
  matchesEvent,
  summarizeAgents,
  summarizeTools,
  type ArtifactRef,
  type ToolSummary,
} from "./assertions.js";
import { judgeReply, JudgeError, type JudgeConfig } from "./judge.js";
import type { MailAdapter, MailMessageSummary } from "./mail.js";
import type { ServiceProber, ServiceState } from "./services.js";
import type { LoadedScenario } from "./loader.js";
import { E2E_ACCOUNTS } from "./setup.js";
import { attachmentEntryKey, extractArtifactsFromMetadata } from "../agent/artifact-metadata.js";

export interface RunnerDeps {
  client: GatewayClient;
  prober: ServiceProber;
  /** eval/e2e/fixtures — attachments resolve here. */
  fixturesDir: string;
  mail?: MailAdapter | null;
  /** null: `expect.judge` is reported as skipped. */
  judge?: JudgeConfig | null;
  log?: (line: string) => void;
}

export interface RunnerOptions {
  /** Attempts per scenario unless the scenario sets `repeat`. */
  repeat?: number;
  /** Scenarios run at once. */
  concurrency?: number;
  defaultTurnTimeoutMs?: number;
  /** Whole-attempt ceiling unless the scenario sets `timeoutMs`. */
  defaultAttemptTimeoutMs?: number;
  /** Least time between a turn's final status and the close of its event window. */
  settleMs?: number;
  /** After the attempt's last step, how long past the final status a turn's window stays open (E2E_EVENT_GRACE_MS). */
  eventGraceMs?: number;
  /** After chat.cancel, how long the cancelled turn's final status is awaited. */
  cancelGraceMs?: number;
  /** How long a mail expect waits for its `min` messages to arrive. */
  mailWaitMs?: number;
  mailPollMs?: number;
  /**
   * Empty the attempt identity's durable memory before each attempt, when attempts run one at a
   * time (concurrent attempts share the account, so one would delete another's). What a scenario
   * stores is in every later turn's prompt (the durable-facts capsule): the memory scenario's
   * German fact pulled a later English question's reply into German (2026-10-07). Only memory that
   * is provably the eval account's own is deleted (resetDurableMemory); the attempt's notes say
   * what was left and why.
   */
  resetDurableMemory?: boolean;
  /** Aborts the run (Ctrl+C): running turns are cancelled, scenarios not started are skipped. */
  signal?: AbortSignal;
}

type ResolvedOptions = Required<Omit<RunnerOptions, "signal">> & { signal?: AbortSignal };

export const RUNNER_DEFAULTS: Required<Omit<RunnerOptions, "signal">> = {
  repeat: 1,
  concurrency: 1,
  defaultTurnTimeoutMs: 10 * 60_000,
  defaultAttemptTimeoutMs: 15 * 60_000,
  settleMs: 1_500,
  eventGraceMs: 5_000,
  cancelGraceMs: 30_000,
  mailWaitMs: 30_000,
  mailPollMs: 1_000,
  resetDurableMemory: true,
};

export interface DuringRecord {
  index: number;
  trigger: string;
  action: "steer" | "stop";
  fired: boolean;
  /** Milliseconds after the send. */
  firedAfterMs?: number;
  ok?: boolean;
  detail?: string;
}

export interface JudgeRecord {
  minScore: number;
  score?: number;
  skipped?: string;
  error?: string;
}

export interface CancelRecord {
  cancelled?: boolean;
  known?: boolean;
  error?: string;
  /** The final status the cancelled turn sent within the grace period, if any. */
  finalStatus?: string;
}

export interface TurnRecord {
  requestId: string;
  sessionId: string;
  status: "ok" | "error" | "blocked" | "timeout";
  /** The reply (secrets redacted, at most 20 000 chars). */
  reply: string;
  error?: string;
  finishReason?: string;
  durationMs: number;
  /** How long after the final status the event window closed. */
  eventWindowMs: number;
  eventCount: number;
  eventTypeCounts: Record<string, number>;
  tools: ToolSummary;
  agents: Record<string, number>;
  artifacts: string[];
  /** WS message types the turn produced (status, agent.chunk, agent.tool_start, …). */
  wsMessageCounts: Record<string, number>;
  during: DuringRecord[];
  judge?: JudgeRecord;
  unconsumedSteering?: number;
  cancel?: CancelRecord;
}

export interface StepResult {
  index: number;
  kind: E2EStep["kind"];
  id?: string;
  /** "step 2 turn \"ask\"" — the prefix of the step's failures in the attempt. */
  label: string;
  passed: boolean;
  /** The step failed on the harness's environment, not on an expectation. */
  infraError?: boolean;
  durationMs: number;
  failures: string[];
  notes: string[];
  turn?: TurnRecord;
  http?: { identity: string; method: string; path: string; status: number; bodyPreview: string };
  mail?: { action: E2EMailStep["action"]; recipient?: string; matched?: number; subjects?: string[] };
}

export type AttemptOutcome = "passed" | "failed" | "error";

export interface AttemptResult {
  index: number;
  outcome: AttemptOutcome;
  startedAt: string;
  durationMs: number;
  /** Failures of the failed steps, in step order, each prefixed with its step label. */
  failures: string[];
  notes: string[];
  /** Sessions the attempt created, oldest first — open them in the audit/debug views. */
  sessions: string[];
  steps: StepResult[];
  eventTypeCounts: Record<string, number>;
  tools: Record<string, number>;
  agents: Record<string, number>;
}

export type ScenarioStatus = "passed" | "failed" | "skipped";

export interface ScenarioResult {
  id: string;
  title: string;
  group: string;
  tags: string[];
  file: string;
  description?: string;
  status: ScenarioStatus;
  skipReason?: string;
  services: ServiceState[];
  /** k: attempts planned. */
  repeat: number;
  attempts: AttemptResult[];
  passCount: number;
  /** passCount / attempts run (0 when skipped). */
  passRate: number;
  /** pass^k: every attempt passed. */
  passAll: boolean;
  durationMs: number;
}

const MAX_REPLY_IN_REPORT = 20_000;

/** Services a scenario needs: its own `requires`, the gateway for any turn/http step, the mailbox for mail steps. */
export function requiredServices(scenario: E2EScenario): E2EService[] {
  const services = new Set<E2EService>();
  if (scenario.steps.some((step) => step.kind === "turn" || step.kind === "http")) services.add("gateway");
  for (const service of scenario.requires ?? []) services.add(service);
  if (scenario.steps.some((step) => step.kind === "mail")) services.add("mail");
  return [...services];
}

/** JWTs, bcrypt hashes and password/token/secret fields, masked for reports. */
export function redactSecrets(text: string): string {
  return text
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted-jwt]")
    .replace(/\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/g, "[redacted-hash]")
    .replace(/("(?:password|passwordHash|token|apiKey|api_key|secret|clientSecret|authToken)"\s*:\s*)"[^"]*"/gi, "$1\"[redacted]\"");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolveSleep) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolveSleep();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Serializes the scenarios that share an exclusive resource (the mailbox). */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolveRelease) => { release = resolveRelease; });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

export async function runScenarios(
  loaded: readonly LoadedScenario[],
  deps: RunnerDeps,
  options: RunnerOptions = {},
): Promise<ScenarioResult[]> {
  const opts: ResolvedOptions = { ...RUNNER_DEFAULTS, ...options };
  const results: ScenarioResult[] = new Array<ScenarioResult>(loaded.length);
  const mailLock = new Mutex();
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= loaded.length) return;
      results[index] = await runScenario(loaded[index]!, deps, opts, mailLock);
    }
  };
  const workers = Math.max(1, Math.min(opts.concurrency, loaded.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

export async function runScenario(
  loaded: LoadedScenario,
  deps: RunnerDeps,
  options: RunnerOptions = {},
  mailLock?: Mutex,
): Promise<ScenarioResult> {
  const opts: ResolvedOptions = { ...RUNNER_DEFAULTS, ...options };
  const { scenario } = loaded;
  const log = deps.log ?? (() => undefined);
  const started = Date.now();
  const base = {
    id: scenario.id,
    title: scenario.title,
    group: scenario.group,
    tags: scenario.tags ?? [],
    file: loaded.file,
    ...(scenario.description ? { description: scenario.description } : {}),
  };
  const repeat = scenario.repeat ?? opts.repeat;
  if (opts.signal?.aborted) {
    return { ...base, status: "skipped", skipReason: "run interrupted before it started", services: [], repeat, attempts: [], passCount: 0, passRate: 0, passAll: false, durationMs: 0 };
  }
  const services = await deps.prober.check(requiredServices(scenario));
  const down = services.filter((state) => !state.up);
  if (down.length > 0) {
    const skipReason = down.map((state) => `${state.service} down (${state.detail})`).join("; ");
    log(`SKIP ${scenario.id}: ${skipReason}`);
    return { ...base, status: "skipped", skipReason, services, repeat, attempts: [], passCount: 0, passRate: 0, passAll: false, durationMs: Date.now() - started };
  }

  const runAll = async (): Promise<AttemptResult[]> => {
    const attempts: AttemptResult[] = [];
    for (let index = 0; index < repeat; index += 1) {
      if (opts.signal?.aborted) break;
      log(`RUN  ${scenario.id} attempt ${index + 1}/${repeat}`);
      const attempt = await runAttempt(scenario, index, deps, opts);
      attempts.push(attempt);
      const verdict = attempt.outcome === "passed" ? "PASS" : attempt.outcome === "error" ? "ERR " : "FAIL";
      log(`${verdict} ${scenario.id} attempt ${index + 1}/${repeat} (${seconds(attempt.durationMs)})${attempt.failures[0] ? `: ${attempt.failures[0]}` : ""}`);
    }
    return attempts;
  };
  const usesMail = scenario.steps.some((step) => step.kind === "mail");
  const attempts = usesMail && mailLock ? await mailLock.run(runAll) : await runAll();
  if (attempts.length === 0) {
    return { ...base, status: "skipped", skipReason: "run interrupted before it started", services, repeat, attempts, passCount: 0, passRate: 0, passAll: false, durationMs: Date.now() - started };
  }
  const passCount = attempts.filter((attempt) => attempt.outcome === "passed").length;
  const passAll = attempts.length > 0 && passCount === attempts.length;
  return {
    ...base,
    status: passAll ? "passed" : "failed",
    services,
    repeat,
    attempts,
    passCount,
    passRate: attempts.length > 0 ? passCount / attempts.length : 0,
    passAll,
    durationMs: Date.now() - started,
  };
}

interface AttemptContext {
  scenario: E2EScenario;
  identity: string;
  deps: RunnerDeps;
  opts: ResolvedOptions;
  signal: AbortSignal;
  deadline: number;
  attemptTimeoutMs: number;
  /** The run was interrupted (not the attempt's own deadline). */
  interrupted: boolean;
  /** Each identity's current session; a turn with `as` runs in its identity's own. */
  sessionIds: Map<string, string>;
  sessions: string[];
}

/** A finished turn whose event window is still open. */
interface OpenTurnWindow {
  step: E2ETurnStep;
  connection: GatewayConnection;
  sessionId: string;
  requestId: string;
  startSeq: number;
  /** When the final status arrived (or the turn was given up). */
  endedAt: number;
  /** The completion checks and the during actions passed: the judge may run at the close. */
  completionPassed: boolean;
  reply: string;
  unconsumedSteering: number;
}

interface StepOutcome {
  failures: string[];
  notes: string[];
  turn?: TurnRecord;
  http?: StepResult["http"];
  mail?: StepResult["mail"];
  /** A turn whose event window stays open past this step. */
  window?: OpenTurnWindow;
}

function stepLabel(step: E2EStep, index: number): string {
  const id = "id" in step && step.id ? ` "${step.id}"` : "";
  return `step ${index + 1} ${step.kind}${id}`;
}

function attemptTimeoutFailure(ctx: AttemptContext): string {
  return ctx.interrupted ? "run interrupted" : `attempt timed out after ${ctx.attemptTimeoutMs} ms`;
}

function addCounts(target: Record<string, number>, source: Record<string, number>): void {
  for (const [key, count] of Object.entries(source)) target[key] = (target[key] ?? 0) + count;
}

/** A turn whose end the run has not seen. */
export interface UnconfirmedTurn {
  identity: string;
  requestId: string;
  sessionId: string;
  /** When the harness sent it (ms since the epoch, this machine's clock). */
  sentAt: number;
}

/**
 * Turns whose end the run has not seen, by client, identity and request id: tracked from before
 * chat.send until the final status arrives. One still here after its step was stopped without the
 * harness seeing it end: chat.cancel got no final status within cancelGraceMs, or the socket died
 * during the send or mid-turn. Such a turn may still be running on the gateway, and what it stores
 * after the next attempt's reset lands in that attempt's memory. It may outlive the process too, so
 * a run that ends or quits leaves its turns to the next one (unconfirmedTurnsOf,
 * adoptUnconfirmedTurns).
 */
const unconfirmedTurns = new WeakMap<GatewayClient, Map<string, Map<string, UnconfirmedTurn>>>();
const TURN_END_POLL_MS = 250;
/** gateway.status reports the gateway's uptime as it answers; this much slack covers the way back. */
const RESTART_SLACK_MS = 1_000;

function turnsOf(client: GatewayClient, identity: string): Map<string, UnconfirmedTurn> {
  let byIdentity = unconfirmedTurns.get(client);
  if (!byIdentity) {
    byIdentity = new Map();
    unconfirmedTurns.set(client, byIdentity);
  }
  let turns = byIdentity.get(identity);
  if (!turns) {
    turns = new Map();
    byIdentity.set(identity, turns);
  }
  return turns;
}

/** Every identity's turns the client's run has not seen end, oldest first. */
export function unconfirmedTurnsOf(client: GatewayClient): UnconfirmedTurn[] {
  return [...(unconfirmedTurns.get(client)?.values() ?? [])]
    .flatMap((turns) => [...turns.values()])
    .sort((a, b) => a.sentAt - b.sentAt);
}

/** Turns an earlier run left: a reset of their identity waits for them as for the run's own. */
export function adoptUnconfirmedTurns(client: GatewayClient, turns: readonly UnconfirmedTurn[]): void {
  for (const turn of turns) turnsOf(client, turn.identity).set(turn.requestId, { ...turn });
}

/**
 * The turn's final status reached this client, or the gateway says no turn runs in its session:
 * session.get's activeTurn covers a stopped turn that is still unwinding (gateway/rpc.ts), and an
 * answer without the field confirms nothing. When session.get fails, a gateway process that started
 * after the send does not run the turn. A wipe restarts the gateway and takes the session with it,
 * and the session.get error alone would hold every reset of the account back, in every later run.
 */
async function turnEnded(turn: UnconfirmedTurn, deps: RunnerDeps): Promise<boolean> {
  try {
    const connection = await deps.client.connection(turn.identity);
    if (connection.finalStatusOf(turn.requestId)) return true;
    const session = await connection.getSession(turn.sessionId).catch(() => null);
    if (session) return session["activeTurn"] === false;
    const status = await connection.rpc<unknown>("gateway.status", {});
    const uptimeS = isRecord(status) && typeof status["uptime"] === "number" ? status["uptime"] : null;
    return uptimeS !== null && Date.now() - uptimeS * 1000 > turn.sentAt + RESTART_SLACK_MS;
  } catch {
    return false;
  }
}

/** The identity's turns not seen to end within waitMs; those that ended are forgotten. */
async function turnsStillRunning(identity: string, deps: RunnerDeps, waitMs: number, signal?: AbortSignal): Promise<string[]> {
  const turns = unconfirmedTurns.get(deps.client)?.get(identity);
  if (!turns || turns.size === 0) return [];
  const deadline = Date.now() + waitMs;
  for (;;) {
    for (const turn of [...turns.values()]) {
      if (await turnEnded(turn, deps)) turns.delete(turn.requestId);
    }
    if (turns.size === 0 || Date.now() >= deadline || signal?.aborted) return [...turns.keys()];
    await sleep(Math.min(TURN_END_POLL_MS, deadline - Date.now()), signal);
  }
}

/** What the memory reset before an attempt did, and why it left anything. */
export interface MemoryResetResult {
  /** Durable memory entries deleted. */
  removed: number;
  /** The user model held something and was emptied. */
  userModelEmptied: boolean;
  /** One line per reason the reset was skipped or left something; they become attempt notes. */
  notes: string[];
}

type MemoryEntryScope = "user" | "workspace";

interface MemoryListing {
  total: number;
  records: Array<{ id: string; key: string }>;
}

/** The most entries one listing returns (the route's own cap, gateway/memory-graph-routes.ts). */
const MEMORY_PAGE = 500;
/** Listings per scope before the reset gives up on a store that does not shrink. */
const MEMORY_RESET_MAX_PASSES = 10;

function entries(count: number): string {
  return `${count} ${count === 1 ? "entry" : "entries"}`;
}

/** One page of the identity's durable memory in a scope, or the reason it could not be listed. */
async function listMemory(identity: string, scope: MemoryEntryScope, deps: RunnerDeps, signal?: AbortSignal): Promise<MemoryListing | string> {
  const listed = await deps.client.http(identity, "GET", `/api/memory/entries?scope=${scope}&limit=${MEMORY_PAGE}`, signal ? { signal } : {});
  if (!listed.ok) return `HTTP ${listed.status}`;
  const body = isRecord(listed.json) ? listed.json : {};
  const records = (Array.isArray(body["records"]) ? body["records"] : []).flatMap((record) =>
    isRecord(record) && typeof record["key"] === "string" && record["key"]
      ? [{ id: typeof record["id"] === "string" ? record["id"] : "", key: record["key"] }]
      : []);
  return { total: typeof body["total"] === "number" ? body["total"] : records.length, records };
}

/**
 * Why the identity's memory may not be deleted at all, or null. The memory routes resolve the
 * caller's stores from the request context, and with auth off there is no user in it: every
 * request reaches the shared single-operator stores, while the token the harness got at login still
 * verifies (auth reloads without a restart, so this is asked before every reset). And a credentials
 * file may map the identity to any account, whose memory is not the eval account's to empty.
 */
async function resetRefusal(identity: string, deps: RunnerDeps, signal?: AbortSignal): Promise<string | null> {
  const account = E2E_ACCOUNTS.find((candidate) => candidate.identity === identity);
  if (!account) return `${identity} is not an eval identity (pnpm e2e:setup creates ${E2E_ACCOUNTS.map((candidate) => candidate.identity).join(" and ")})`;
  const mode = await deps.client.http(null, "GET", "/api/auth/mode", signal ? { signal } : {});
  if (!mode.ok) return `GET /api/auth/mode answered HTTP ${mode.status}`;
  if (!isRecord(mode.json) || mode.json["authEnabled"] !== true) {
    return "the gateway runs with auth off, so every account's memory is the shared single-operator store";
  }
  const me = await deps.client.http(identity, "GET", "/api/auth/me", signal ? { signal } : {});
  if (!me.ok) return `GET /api/auth/me as ${identity} answered HTTP ${me.status}`;
  const username = isRecord(me.json) && typeof me.json["username"] === "string" ? me.json["username"] : "";
  if (username !== account.username) {
    return `${identity} logs in as ${username ? `account "${username}"` : "an account without a name"}, not as its eval account "${account.username}"`;
  }
  return null;
}

/**
 * Whether the listed records are the identity's own: no other eval account lists any of them. A
 * gateway older than the per-user workspace routes (5fc9a8e) lists and deletes workspace memory at
 * the shared root for every account, and nothing else in its answers tells that store apart.
 * Null when they are the identity's own; otherwise why the scope is left as it is.
 */
async function sharedStoreReason(identity: string, scope: MemoryEntryScope, listing: MemoryListing, deps: RunnerDeps, signal?: AbortSignal): Promise<string | null> {
  const ids = new Set(listing.records.map((record) => record.id));
  if (ids.has("")) return `cannot tell whether it is ${identity}'s own (an entry without an id)`;
  const others = E2E_ACCOUNTS.filter((account) => account.identity !== identity && deps.client.hasIdentity(account.identity));
  if (others.length === 0) return `cannot tell whether it is ${identity}'s own (no other eval account to compare with)`;
  for (const other of others) {
    const theirs = await listMemory(other.identity, scope, deps, signal);
    if (typeof theirs === "string") return `cannot tell whether it is ${identity}'s own (${other.identity}'s listing answered ${theirs})`;
    if (theirs.records.some((record) => ids.has(record.id))) {
      return `${other.identity} lists the same entries, so the gateway keeps that scope in one shared store`;
    }
  }
  return null;
}

/**
 * Empty the identity's durable memory (user and workspace scope) and its user model before an
 * attempt, but only what is provably the eval account's own: a delete cannot be undone, and a store
 * the reset should not touch is the operator's or another account's (resetRefusal,
 * sharedStoreReason). Whatever it skips or cannot delete comes back as notes: the reset used to drop
 * failed listings and deletes without a word, and eval-viewer's memory was never emptied, because
 * every mutating route is operator-only (the gateway's role gate) while memory_store has no role
 * gate at all.
 *
 * The user model is a store of its own (user-model/service.ts), and recall_context serves it: the
 * memory scenario accepts user_model_update as the place its preference is kept, so a model left
 * from an earlier run could answer the recall by itself. It is kept per account wherever auth is on,
 * so the gate above is all it needs.
 *
 * Nothing is reset either while a turn stopped on the account may still run (waited for up to
 * turnWaitMs), whether this run stopped it or an earlier one left it in the run lock: attempts
 * running one at a time is all the concurrency gate sees, and a turn that outlived its chat.cancel
 * can store memory after the reset, into the next attempt.
 */
export async function resetDurableMemory(identity: string, deps: RunnerDeps, signal?: AbortSignal, turnWaitMs = 0): Promise<MemoryResetResult> {
  const notes: string[] = [];
  let removed = 0;
  let userModelEmptied = false;
  // A 401 or 403 is the account's answer, not the entry's: the remaining deletes are not tried.
  let forbidden: string | null = null;
  try {
    const refusal = await resetRefusal(identity, deps, signal);
    const running = refusal ? [] : await turnsStillRunning(identity, deps, turnWaitMs, signal);
    if (refusal) {
      notes.push(`memory reset skipped: ${refusal}`);
    } else if (running.length > 0) {
      notes.push(`memory reset skipped: ${running.length === 1 ? "turn" : "turns"} ${running.join(", ")} of ${identity} ${running.length === 1 ? "was" : "were"} stopped earlier and ${running.length === 1 ? "has" : "have"} not been seen to end`);
    } else {
      for (const scope of ["user", "workspace"] as const) {
        for (let pass = 1; ; pass += 1) {
          const listing = await listMemory(identity, scope, deps, signal);
          if (typeof listing === "string") {
            notes.push(`memory reset: ${identity}'s ${scope} memory could not be listed (${listing})`);
            break;
          }
          if (listing.records.length === 0) break;
          if (pass === 1) {
            const shared = await sharedStoreReason(identity, scope, listing, deps, signal);
            if (shared) {
              notes.push(`memory reset: ${identity}'s ${scope} memory left as it is: ${shared}`);
              break;
            }
          }
          if (pass > MEMORY_RESET_MAX_PASSES) {
            notes.push(`memory reset: ${entries(listing.total)} of ${identity}'s ${scope} memory still listed after ${MEMORY_RESET_MAX_PASSES} rounds of deletes`);
            break;
          }
          const refused = new Map<string, number>();
          let progress = 0;
          for (const record of listing.records) {
            if (forbidden) {
              refused.set(forbidden, (refused.get(forbidden) ?? 0) + 1);
              continue;
            }
            const deleted = await deps.client.http(identity, "DELETE", `/api/memory/entries/${encodeURIComponent(record.key)}?scope=${scope}`, signal ? { signal } : {});
            if (deleted.ok) {
              removed += 1;
              progress += 1;
            } else if (deleted.status !== 404) { // 404: gone already
              const why = `HTTP ${deleted.status}`;
              refused.set(why, (refused.get(why) ?? 0) + 1);
              if (deleted.status === 401 || deleted.status === 403) forbidden = why;
            }
          }
          for (const [why, count] of refused) notes.push(`memory reset: ${entries(count)} of ${identity}'s ${scope} memory not deleted (${why})`);
          if (refused.size > 0 || progress === 0 || listing.total <= listing.records.length) break;
        }
      }
      const model = await deps.client.http(identity, "GET", "/api/user-model", signal ? { signal } : {});
      if (!model.ok) {
        notes.push(`memory reset: ${identity}'s user model could not be read (HTTP ${model.status})`);
      } else if (Object.values(isRecord(model.json) ? model.json : {}).some((value) => Array.isArray(value) && value.length > 0)) {
        const reset = forbidden ? null : await deps.client.http(identity, "POST", "/api/user-model/reset", signal ? { signal } : {});
        if (reset?.ok) userModelEmptied = true;
        else notes.push(`memory reset: ${identity}'s user model not emptied (${reset ? `HTTP ${reset.status}` : forbidden})`);
      }
    }
  } catch (err) {
    if (!signal?.aborted) notes.push(`memory reset stopped: ${describeError(err)}`);
  }
  if (removed > 0) {
    deps.log?.(`     reset: removed ${removed} durable memory entr${removed === 1 ? "y" : "ies"} of ${identity}${userModelEmptied ? " and emptied its user model" : ""}`);
  } else if (userModelEmptied) {
    deps.log?.(`     reset: emptied the user model of ${identity}`);
  }
  for (const note of notes) deps.log?.(`     ${note}`);
  return { removed, userModelEmptied, notes };
}

export async function runAttempt(
  scenario: E2EScenario,
  index: number,
  deps: RunnerDeps,
  options: RunnerOptions = {},
): Promise<AttemptResult> {
  const opts: ResolvedOptions = { ...RUNNER_DEFAULTS, ...options };
  const attemptTimeoutMs = scenario.timeoutMs ?? opts.defaultAttemptTimeoutMs;
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
  const ctx: AttemptContext = {
    scenario,
    identity: scenario.identity ?? "eval",
    deps,
    opts,
    signal: controller.signal,
    deadline: startedAt + attemptTimeoutMs,
    attemptTimeoutMs,
    interrupted: false,
    sessionIds: new Map(),
    sessions: [],
  };
  const onRunAbort = (): void => {
    ctx.interrupted = true;
    controller.abort();
  };
  if (opts.signal?.aborted) onRunAbort();
  else opts.signal?.addEventListener("abort", onRunAbort, { once: true });
  const resetNotes: string[] = [];
  if (opts.resetDurableMemory && opts.concurrency === 1 && !controller.signal.aborted) {
    // Every identity a turn of the attempt runs as: what any of them stored before would steer it.
    const identities = new Set([ctx.identity, ...scenario.steps.flatMap((step) => (step.kind === "turn" && step.as ? [step.as] : []))]);
    for (const identity of identities) {
      if (controller.signal.aborted) break;
      resetNotes.push(...(await resetDurableMemory(identity, deps, controller.signal, opts.cancelGraceMs)).notes);
    }
  }
  const steps: StepResult[] = [];
  let open: { window: OpenTurnWindow; result: StepResult } | null = null;
  const closeOpenWindow = async (minimumGapMs: number): Promise<boolean> => {
    if (!open) return true;
    const { window, result } = open;
    open = null;
    await closeTurnWindow(window, result, ctx, minimumGapMs);
    return result.passed;
  };
  try {
    for (const [stepIndex, step] of scenario.steps.entries()) {
      // A wait extends the open turn's window; any other step closes it first.
      if (step.kind !== "wait" && !await closeOpenWindow(opts.settleMs)) break;
      const { result, window } = await runStep(step, stepIndex, ctx);
      steps.push(result);
      if (!result.passed) break;
      if (window) open = { window, result };
    }
    // The last turn's window: open for the grace period past its final status.
    await closeOpenWindow(Math.max(opts.settleMs, opts.eventGraceMs));
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onRunAbort);
  }
  const failed = steps.filter((step) => !step.passed);
  // An interrupted attempt says nothing about the swarm.
  const outcome: AttemptOutcome = failed.length === 0 ? "passed" : failed.some((step) => step.infraError) || ctx.interrupted ? "error" : "failed";
  const counts: Record<string, number> = {};
  const tools: Record<string, number> = {};
  const agents: Record<string, number> = {};
  for (const step of steps) {
    if (!step.turn) continue;
    addCounts(counts, step.turn.eventTypeCounts);
    addCounts(tools, step.turn.tools.calls);
    addCounts(agents, step.turn.agents);
  }
  return {
    index,
    outcome,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    failures: failed.flatMap((step) => step.failures.map((failure) => `${step.label}: ${failure}`)),
    notes: [...resetNotes, ...steps.flatMap((step) => step.notes.map((note) => `${step.label}: ${note}`))],
    sessions: ctx.sessions,
    steps,
    eventTypeCounts: counts,
    tools,
    agents,
  };
}

async function runStep(step: E2EStep, index: number, ctx: AttemptContext): Promise<{ result: StepResult; window?: OpenTurnWindow }> {
  const label = stepLabel(step, index);
  const started = Date.now();
  const base = { index, kind: step.kind, ...("id" in step && step.id ? { id: step.id } : {}), label };
  if (ctx.signal.aborted) {
    return { result: { ...base, passed: false, durationMs: 0, failures: [attemptTimeoutFailure(ctx)], notes: [] } };
  }
  try {
    const { window, ...outcome } = await runStepBody(step, ctx);
    const result: StepResult = { ...base, ...outcome, passed: outcome.failures.length === 0, durationMs: Date.now() - started };
    return window ? { result, window } : { result };
  } catch (err) {
    const durationMs = Date.now() - started;
    if (ctx.signal.aborted && !(err instanceof E2EInfraError)) {
      return { result: { ...base, passed: false, durationMs, failures: [attemptTimeoutFailure(ctx)], notes: [] } };
    }
    if (err instanceof E2EInfraError) {
      return { result: { ...base, passed: false, infraError: true, durationMs, failures: [`harness: ${err.message}`], notes: [] } };
    }
    return { result: { ...base, passed: false, durationMs, failures: [describeError(err)], notes: [] } };
  }
}

function runStepBody(step: E2EStep, ctx: AttemptContext): Promise<StepOutcome> {
  switch (step.kind) {
    case "turn":
      return runTurnStep(step, ctx);
    case "http":
      return runHttpStep(step, ctx);
    case "wait":
      return sleep(Math.min(step.ms, Math.max(0, ctx.deadline - Date.now())), ctx.signal).then(() => {
        if (ctx.signal.aborted) throw new Error("aborted");
        return { failures: [], notes: [] };
      });
    case "newSession":
      ctx.sessionIds.clear();
      return Promise.resolve({ failures: [], notes: [] });
    case "mail":
      return runMailStep(step, ctx);
    default: {
      const unknown: never = step;
      throw new Error(`unknown step ${JSON.stringify(unknown)}`);
    }
  }
}

async function ensureSession(ctx: AttemptContext, identity = ctx.identity): Promise<string> {
  const current = ctx.sessionIds.get(identity);
  if (current) return current;
  const connection = await ctx.deps.client.connection(identity);
  let sessionId: string;
  try {
    // "eval": the runtime keeps eval traffic out of its learning loops (LRN-403).
    sessionId = await connection.createSession("eval");
  } catch (err) {
    if (err instanceof E2EInfraError) throw err;
    throw new E2EInfraError(`session.create failed: ${describeError(err)}`);
  }
  ctx.sessionIds.set(identity, sessionId);
  ctx.sessions.push(sessionId);
  return sessionId;
}

// ── turn ─────────────────────────────────────────────────────────────────────

type DuringAction = NonNullable<E2ETurnStep["during"]>[number];

function describeTrigger(when: DuringAction["when"]): string {
  return "event" in when ? `on ${describeMatcher(when.event as E2EEventMatcher)}` : `after ${when.afterMs} ms`;
}

/** Fires each `during` action once, while the turn runs. */
class DuringController {
  readonly records: DuringRecord[];
  private unsubscribe: (() => void) | null = null;
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  private readonly inflight: Array<Promise<void>> = [];
  private sentAt = 0;

  constructor(
    private readonly actions: readonly DuringAction[],
    private readonly ctx: {
      connection: GatewayConnection;
      client: GatewayClient;
      identity: string;
      sessionId: string;
      requestId: string;
      startSeq: number;
    },
  ) {
    this.records = actions.map((action, index) => ({
      index,
      trigger: describeTrigger(action.when),
      action: "steer" in action.do ? "steer" : "stop",
      fired: false,
    }));
  }

  private turnEnded(): boolean {
    return this.ctx.connection.finalStatusOf(this.ctx.requestId) !== undefined;
  }

  /** Right before the send: event triggers watch the turn's own events from the first one on. */
  attach(sentAt: number): void {
    this.sentAt = sentAt;
    if (!this.actions.some((action) => "event" in action.when)) return;
    this.unsubscribe = this.ctx.connection.onAudit((received) => {
      if (received.root !== this.ctx.sessionId || received.seq <= this.ctx.startSeq || this.turnEnded()) return;
      this.actions.forEach((action, index) => {
        if (this.records[index]!.fired || !("event" in action.when)) return;
        if (matchesEvent(action.when.event, received.event)) this.fire(index);
      });
    });
  }

  /** Once the send went out: delays count from the send. */
  armTimers(): void {
    this.actions.forEach((action, index) => {
      if (!("afterMs" in action.when)) return;
      const delay = Math.max(0, this.sentAt + action.when.afterMs - Date.now());
      this.timers.push(setTimeout(() => {
        if (!this.turnEnded()) this.fire(index);
      }, delay));
    });
  }

  private fire(index: number): void {
    const record = this.records[index]!;
    if (record.fired) return;
    record.fired = true;
    record.firedAfterMs = Date.now() - this.sentAt;
    const action = this.actions[index]!;
    const execute = async (): Promise<void> => {
      if ("steer" in action.do) {
        const result = await this.ctx.client.steer(this.ctx.identity, this.ctx.sessionId, action.do.steer, {
          requestId: this.ctx.requestId,
          clientMessageId: `e2e-${randomUUID()}`,
        });
        record.ok = result.steered;
        record.detail = result.steered
          ? `steered${result.id ? ` (id ${result.id})` : ""}`
          : `not taken by the running turn (HTTP ${result.httpStatus}, steered=false, active=${result.active}${result.error ? `: ${result.error}` : ""})`;
      } else {
        const result = await this.ctx.connection.cancel(this.ctx.requestId);
        record.ok = result.cancelled;
        record.detail = result.cancelled ? "turn stopped" : `chat.cancel did not stop the turn (cancelled=false, known=${result.known})`;
      }
    };
    this.inflight.push(execute().catch((err: unknown) => {
      record.ok = false;
      record.detail = `failed: ${describeError(err)}`;
    }));
  }

  async settle(): Promise<void> {
    await Promise.allSettled(this.inflight);
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  failures(): string[] {
    return this.records.flatMap((record) => {
      if (!record.fired) return [`during[${record.index}] (${record.trigger}): never fired before the turn ended`];
      if (record.ok !== true) return [`during[${record.index}] ${record.action}: ${record.detail ?? "failed"}`];
      return [];
    });
  }
}

const CONTENT_TYPES: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".htm": "text/html",
  ".xml": "application/xml",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

export function contentTypeFor(filename: string): string {
  return CONTENT_TYPES[extname(filename).toLowerCase()] ?? "application/octet-stream";
}

interface PreparedMessage {
  message: string;
  displayContent?: string;
  attachments?: Array<Record<string, unknown>>;
}

/**
 * The chat.send message as the web client builds it: `--agent` appended to the typed text;
 * documents stored in the session's uploads/ and sent as attachments; images stored too, with
 * their vision analysis inlined ahead of the text; the bubble text names the files.
 */
async function prepareMessage(step: E2ETurnStep, sessionId: string, ctx: AttemptContext, identity: string): Promise<PreparedMessage> {
  const typed = step.agent ? `${step.message} --agent ${step.agent}` : step.message;
  if (!step.attachments || step.attachments.length === 0) return { message: typed };
  const attachments: Array<Record<string, unknown>> = [];
  const imageContexts: string[] = [];
  const names: string[] = [];
  for (const relativePath of step.attachments) {
    const path = resolve(ctx.deps.fixturesDir, relativePath);
    const filename = basename(path);
    const contentType = contentTypeFor(filename);
    names.push(filename);
    const file = { path, filename, contentType };
    if (contentType.startsWith("image/")) {
      const [stored, analysis] = await Promise.all([
        ctx.deps.client.uploadAttachment(identity, sessionId, file, ctx.signal),
        ctx.deps.client.analyzeImage(identity, file, ctx.signal),
      ]);
      attachments.push({ filename, contentType: stored.contentType, previewMode: "image", size: stored.size, relativePath: stored.relativePath });
      imageContexts.push(`Image analysis (${filename}):\n\n${analysis}`);
    } else {
      const stored = await ctx.deps.client.uploadAttachment(identity, sessionId, file, ctx.signal);
      attachments.push({ filename: stored.filename, relativePath: stored.relativePath, contentType: stored.contentType, size: stored.size, previewMode: "download" });
    }
  }
  return {
    message: [imageContexts.join("\n\n"), typed].filter(Boolean).join("\n\n"),
    displayContent: `📎 ${names.join(", ")}\n${typed}`,
    attachments,
  };
}

/** Files the turn delivered: attachments pinned on its assistant entries and the artifacts its
 *  tool calls recorded, from session.get (the transcript the dashboard renders). */
async function collectArtifacts(connection: GatewayConnection, sessionId: string, requestId: string): Promise<ArtifactRef[]> {
  const page = await connection.getSession(sessionId);
  const transcript = Array.isArray(page["transcript"]) ? page["transcript"] : [];
  const entries: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const message of transcript) {
    if (!isRecord(message) || message["requestId"] !== requestId || message["role"] !== "assistant") continue;
    for (const attachment of Array.isArray(message["attachments"]) ? message["attachments"] : []) {
      if (!isRecord(attachment)) continue;
      const key = attachmentEntryKey(attachment);
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(attachment);
    }
    for (const call of Array.isArray(message["toolCalls"]) ? message["toolCalls"] : []) {
      if (isRecord(call) && isRecord(call["metadata"])) extractArtifactsFromMetadata(call["metadata"], entries, seen);
    }
  }
  return entries.flatMap((entry): ArtifactRef[] => {
    const str = (key: string): string => (typeof entry[key] === "string" ? String(entry[key]).trim() : "");
    const path = str("relativePath") || str("externalUrl") || str("filename");
    if (!path) return [];
    return [{
      path,
      filename: str("filename") || path,
      ...(str("contentType") ? { contentType: str("contentType") } : {}),
      ...(str("sourceTool") ? { sourceTool: str("sourceTool") } : {}),
    }];
  });
}

/** Best effort: stop a turn whose socket died, from a fresh connection (chat.cancel works across
 *  connections for a session the caller owns). */
async function cancelFromFreshConnection(ctx: AttemptContext, identity: string, requestId: string): Promise<string> {
  try {
    const connection = await ctx.deps.client.connection(identity);
    const result = await connection.cancel(requestId);
    return `chat.cancel from a new connection: cancelled=${result.cancelled}`;
  } catch (err) {
    return `chat.cancel from a new connection failed: ${describeError(err)}`;
  }
}

/**
 * Closes a turn's event window: its session's events from the send until now (at least
 * `minimumGapMs` past the final status), then the events/tools/agents expectations and — when
 * every check passed — the judge. Updates the step's result and turn record in place.
 */
async function closeTurnWindow(window: OpenTurnWindow, result: StepResult, ctx: AttemptContext, minimumGapMs: number): Promise<void> {
  // The attempt's deadline (or an interrupt) ends the wait; the events in hand are evaluated.
  await sleep(window.endedAt + minimumGapMs - Date.now(), ctx.signal);
  const turn = result.turn!;
  const events = window.connection.eventsOf(window.sessionId, window.startSeq, window.connection.currentSeq()).map((received) => received.event);
  const counts = eventTypeCounts(events);
  turn.eventWindowMs = Date.now() - window.endedAt;
  turn.eventCount = events.length;
  turn.eventTypeCounts = counts;
  turn.tools = summarizeTools(events);
  turn.agents = summarizeAgents(events);

  const failures: string[] = [];
  if (turn.status !== "timeout") failures.push(...evaluateEventExpectations(window.step.expect, events));
  const rubric = window.step.expect?.judge;
  if (rubric && turn.status !== "timeout") {
    const judge: JudgeRecord = { minScore: rubric.minScore };
    turn.judge = judge;
    if (!window.completionPassed || failures.length > 0) {
      judge.skipped = "deterministic checks failed";
    } else if (!ctx.deps.judge) {
      judge.skipped = "no judge configured";
      result.notes.push("judge: skipped (no judge configured)");
    } else if (ctx.signal.aborted) {
      // An unverified rubric is never a pass.
      judge.skipped = attemptTimeoutFailure(ctx);
      failures.push(`judge: not run (${judge.skipped})`);
    } else {
      try {
        const verdict = await judgeReply(ctx.deps.judge, { rubric: rubric.rubric, userMessage: window.step.message, reply: window.reply }, ctx.signal);
        judge.score = verdict.score;
        if (verdict.score < rubric.minScore) failures.push(`judge: score ${verdict.score} < minScore ${rubric.minScore}`);
      } catch (err) {
        judge.error = err instanceof JudgeError ? err.message : describeError(err);
        failures.push(`judge: ${judge.error}`);
      }
    }
  }

  const askedPeople = (counts["user_input_requested"] ?? 0) + (counts["approval_requested"] ?? 0);
  if (askedPeople > 0) {
    result.notes.push(`the turn asked a person ${askedPeople} time(s) (user_input_requested/approval_requested); the harness answers no prompts — add --auto to the message to auto-approve`);
  }
  if (window.unconsumedSteering > 0) result.notes.push(`${window.unconsumedSteering} mid-turn message(s) were never read by the turn`);
  if (window.connection.droppedEventCount() > 0) result.notes.push(`${window.connection.droppedEventCount()} audit event(s) dropped by the per-session buffer cap`);
  result.failures.push(...failures);
  result.passed = result.failures.length === 0;
}

async function runTurnStep(step: E2ETurnStep, ctx: AttemptContext): Promise<StepOutcome> {
  const { client } = ctx.deps;
  // A turn with `as` runs as that identity, in its own session.
  const identity = step.as ?? ctx.identity;
  const connection = await client.connection(identity);
  const sessionId = await ensureSession(ctx, identity);
  connection.registerRoot(sessionId);
  const notes: string[] = [];
  const prepared = await prepareMessage(step, sessionId, ctx, identity);
  const requestId = `e2e-${randomUUID()}`;
  const ownTimeoutMs = step.timeoutMs ?? ctx.opts.defaultTurnTimeoutMs;
  const remainingMs = Math.max(0, ctx.deadline - Date.now());
  const turnTimeoutMs = Math.min(ownTimeoutMs, remainingMs);
  // When the attempt's deadline is the nearer one, a timeout here is the attempt's.
  const limitedByAttempt = remainingMs < ownTimeoutMs;
  const startSeq = connection.currentSeq();
  const during = new DuringController(step.during ?? [], { connection, client, identity, sessionId, requestId, startSeq });
  const sentAt = Date.now();
  during.attach(sentAt);
  // Until its final status arrives the turn may be running: a reset of the account waits for it.
  const tracked = turnsOf(client, identity);
  tracked.set(requestId, { identity, requestId, sessionId, sentAt });
  try {
    await connection.sendChat({
      sessionId,
      requestId,
      message: prepared.message,
      ...(prepared.displayContent !== undefined ? { displayContent: prepared.displayContent } : {}),
      ...(prepared.attachments ? { attachments: prepared.attachments } : {}),
      ...(step.effort ? { effort: step.effort } : {}),
    });
  } catch (err) {
    during.detach();
    if (err instanceof E2EInfraError) {
      // The gateway may have taken the send before the socket failed, and it keeps a turn running
      // when its socket closes (gateway/rpc.ts close): stopped like a turn whose socket dies
      // mid-turn, it stays tracked until a reset sees it end.
      const cancelled = await cancelFromFreshConnection(ctx, identity, requestId);
      throw new E2EInfraError(`${err.message}; ${cancelled}`);
    }
    tracked.delete(requestId);
    return { failures: [`chat.send failed: ${describeError(err)}`], notes };
  }
  during.armTimers();

  let waited: TurnStatusMessage | "timeout" | "aborted";
  try {
    waited = await connection.waitForFinalStatus(requestId, turnTimeoutMs, ctx.signal);
  } catch (err) {
    during.detach();
    if (err instanceof E2EInfraError) {
      // The final status goes to the dead socket: the turn stays tracked until a reset sees it end.
      const cancelled = await cancelFromFreshConnection(ctx, identity, requestId);
      throw new E2EInfraError(`${err.message}; ${cancelled}`);
    }
    throw err;
  }

  const failures: string[] = [];
  let final: TurnStatusMessage | null = typeof waited === "string" ? null : waited;
  let timedOut = false;
  let cancel: CancelRecord | undefined;
  if (typeof waited === "string") {
    // The turn outlived its budget: stop it before anything else, so it does not keep a model slot.
    timedOut = true;
    during.detach();
    cancel = await connection.cancel(requestId).then(
      (result): CancelRecord => ({ cancelled: result.cancelled, known: result.known }),
      (err: unknown): CancelRecord => ({ error: describeError(err) }),
    );
    const after = await connection.waitForFinalStatus(requestId, ctx.opts.cancelGraceMs).catch(() => "timeout" as const);
    if (typeof after !== "string") {
      final = after;
      cancel.finalStatus = after.status;
    }
    const cancelText = cancel.error
      ? `chat.cancel failed: ${cancel.error}`
      : `chat.cancel: cancelled=${String(cancel.cancelled)}${cancel.finalStatus ? `, final status ${cancel.finalStatus}` : `, no final status within ${ctx.opts.cancelGraceMs} ms`}`;
    failures.push(waited === "aborted" || limitedByAttempt
      ? `${attemptTimeoutFailure(ctx)} while this turn ran (${cancelText})`
      : `turn timed out after ${turnTimeoutMs} ms (${cancelText})`);
  }
  // Seen to end. A turn stopped without its final status stays tracked.
  if (final) tracked.delete(requestId);

  await during.settle();
  during.detach();
  const endedAt = final?.receivedAt ?? Date.now();
  const durationMs = endedAt - sentAt;

  let artifacts: ArtifactRef[] = [];
  if (final) {
    try {
      artifacts = await collectArtifacts(connection, sessionId, requestId);
    } catch (err) {
      notes.push(`artifacts unavailable: ${describeError(err)}`);
    }
  }

  const reply = final?.response ?? "";
  if (final && !timedOut) {
    failures.push(...evaluateCompletionExpectations(step.expect, {
      status: final.status,
      reply,
      ...(final.error ? { error: final.error } : {}),
      durationMs,
      artifacts,
    }));
    failures.push(...during.failures());
  }

  const turn: TurnRecord = {
    requestId,
    sessionId,
    status: timedOut ? "timeout" : final?.status ?? "timeout",
    reply: redactSecrets(reply).slice(0, MAX_REPLY_IN_REPORT),
    ...(final?.error ? { error: redactSecrets(final.error).slice(0, 2_000) } : {}),
    ...(final?.finishReason ? { finishReason: final.finishReason } : {}),
    durationMs,
    // Filled when the event window closes.
    eventWindowMs: 0,
    eventCount: 0,
    eventTypeCounts: {},
    tools: { calls: {}, refused: {}, byAgent: {} },
    agents: {},
    artifacts: artifacts.map((artifact) => artifact.path),
    wsMessageCounts: connection.turnMessageTypeCounts(requestId),
    during: during.records,
    ...(final?.unconsumedSteering ? { unconsumedSteering: final.unconsumedSteering } : {}),
    ...(cancel ? { cancel } : {}),
  };
  const window: OpenTurnWindow = {
    step,
    connection,
    sessionId,
    requestId,
    startSeq,
    endedAt,
    completionPassed: failures.length === 0,
    reply,
    unconsumedSteering: final?.unconsumedSteering ?? 0,
  };
  if (failures.length === 0) return { failures, notes, turn, window };
  // The turn already failed: close its window now (after the settle time), so the report still
  // shows its events and every expectation the events decide.
  const result: StepResult = { index: 0, kind: "turn", label: "", passed: false, durationMs, failures, notes, turn };
  await closeTurnWindow(window, result, ctx, ctx.opts.settleMs);
  return { failures: result.failures, notes: result.notes, turn };
}

// ── http ─────────────────────────────────────────────────────────────────────

async function runHttpStep(step: E2EHttpStep, ctx: AttemptContext): Promise<StepOutcome> {
  const identity = step.as ?? ctx.identity;
  const path = step.path.includes("{sessionId}")
    ? step.path.split("{sessionId}").join(encodeURIComponent(await ensureSession(ctx)))
    : step.path;
  const result = await ctx.deps.client.http(identity, step.method, path, {
    ...(step.body !== undefined ? { body: step.body } : {}),
    signal: ctx.signal,
    timeoutMs: Math.max(1, ctx.deadline - Date.now()),
  });
  const preview = redactSecrets(result.text.replace(/\s+/g, " ").trim()).slice(0, 300);
  const failures: string[] = [];
  const expected = step.expect?.status;
  const allowed = expected === undefined ? null : Array.isArray(expected) ? expected : [expected];
  const statusOk = allowed ? allowed.includes(result.status) : result.status >= 200 && result.status < 300;
  if (!statusOk) {
    failures.push(`status: expected ${allowed ? allowed.join(" or ") : "2xx"}, saw ${result.status}${preview ? ` (body: ${preview})` : ""}`);
  }
  for (const needle of step.expect?.bodyIncludes ?? []) {
    if (!result.text.includes(needle)) failures.push(`bodyIncludes "${needle}": not found${preview ? ` (body: ${preview})` : ""}`);
  }
  return { failures, notes: [], http: { identity, method: step.method, path, status: result.status, bodyPreview: preview } };
}

// ── mail ─────────────────────────────────────────────────────────────────────

type MailMatch = NonNullable<E2EMailStep["match"]>;

function mailMatches(message: MailMessageSummary, match: MailMatch): boolean {
  const subject = message.subject.toLowerCase();
  const body = message.body.toLowerCase();
  return (match.subjectIncludes ?? []).every((needle) => subject.includes(needle.toLowerCase()))
    && (match.bodyIncludes ?? []).every((needle) => body.includes(needle.toLowerCase()));
}

function describeMailMatch(recipient: string, match: MailMatch): string {
  const parts = [`to=${recipient}`];
  if (match.subjectIncludes?.length) parts.push(`subject∋${match.subjectIncludes.map((needle) => `"${needle}"`).join(",")}`);
  if (match.bodyIncludes?.length) parts.push(`body∋${match.bodyIncludes.map((needle) => `"${needle}"`).join(",")}`);
  return parts.join(" ");
}

async function withMailAdapter<T>(ctx: AttemptContext, action: (mail: MailAdapter) => Promise<T>): Promise<T> {
  const mail = ctx.deps.mail;
  if (!mail) throw new E2EInfraError("no mail adapter configured");
  try {
    return await action(mail);
  } catch (err) {
    if (err instanceof E2EInfraError) throw err;
    throw new E2EInfraError(`mail (${mail.name}): ${describeError(err)}`);
  }
}

async function runMailStep(step: E2EMailStep, ctx: AttemptContext): Promise<StepOutcome> {
  switch (step.action) {
    case "deliver": {
      const message = step.message;
      if (!message) return { failures: ["deliver needs a message"], notes: [] };
      const recipient = await withMailAdapter(ctx, async (mail) => {
        await mail.deliver({ to: mail.inbox, from: message.from, subject: message.subject, text: message.text });
        return mail.inbox;
      });
      return { failures: [], notes: [`delivered "${message.subject}" to ${recipient}`], mail: { action: "deliver", recipient } };
    }
    case "clear":
      await withMailAdapter(ctx, (mail) => mail.clear());
      return { failures: [], notes: [], mail: { action: "clear" } };
    case "expect": {
      const match: MailMatch = step.match ?? {};
      const min = match.min ?? 1;
      return withMailAdapter(ctx, async (mail) => {
        const recipient = match.to ?? mail.inbox;
        const waitUntil = Math.min(Date.now() + ctx.opts.mailWaitMs, ctx.deadline);
        let all: MailMessageSummary[];
        let matching: MailMessageSummary[];
        for (;;) {
          all = await mail.list(recipient);
          matching = all.filter((message) => mailMatches(message, match));
          if (matching.length >= min || Date.now() >= waitUntil || ctx.signal.aborted) break;
          await sleep(Math.min(ctx.opts.mailPollMs, waitUntil - Date.now()), ctx.signal);
        }
        const failures: string[] = [];
        if (matching.length < min || (match.max !== undefined && matching.length > match.max)) {
          const range = match.max === undefined ? `≥${min}` : min === match.max ? `exactly ${min}` : min === 0 ? `≤${match.max}` : `${min}..${match.max}`;
          const inbox = all.length > 0 ? `: ${all.slice(0, 5).map((message) => JSON.stringify(message.subject)).join(", ")}${all.length > 5 ? ", …" : ""}` : "";
          failures.push(`mail.expect ${describeMailMatch(recipient, match)}: expected ${range}, saw ${matching.length} (${all.length} message(s) in the mailbox${inbox})`);
        }
        return {
          failures,
          notes: [],
          mail: { action: "expect" as const, recipient, matched: matching.length, subjects: all.map((message) => message.subject).slice(0, 20) },
        };
      });
    }
    default: {
      const unknown: never = step.action;
      throw new Error(`unknown mail action ${String(unknown)}`);
    }
  }
}
