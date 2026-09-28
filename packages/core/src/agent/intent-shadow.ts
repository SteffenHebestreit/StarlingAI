/**
 * The intent readout in SHADOW (orchestration.intentReadout: "shadow"): after a top-level turn has
 * delivered its reply, ask the routing tier for the request's facets (decisions/intent-readout.ts)
 * and the pre-route question over the capsule the turn had, and log both beside what the turn DID,
 * so `pnpm intent:report` can say how often each would have agreed before anything reads them.
 *
 * WHY AFTER THE TURN, NOT BESIDE IT. The readout runs on the routing tier, which on this deployment
 * is the same llama-server as the receptionist, the source judge and the orchestrator. Asked during
 * the turn it would compete with the turn's own calls — one 25-token call measured 2.1 s alone and
 * 4.06 s with four in flight — and a shadow that slows the turn measures a different system from the
 * one it describes. Nothing a turn does depends on the answer yet, so the answer can wait until the
 * reply is out. The consumers that will read it (the workflow gate, the module include, the
 * pre-router) need it BEFORE the turn; this only measures whether it would have been right.
 *
 * NEVER IN THE WAY.
 *  - It is scheduled on a macrotask once runTurn has resolved: the gateway sends the reply in that
 *    promise's continuation (gateway/rpc.ts), which runs first.
 *  - Any turn start aborts it, as it aborts the warm-keeper (agent/cache-warmer.ts). Probe E5 prices
 *    an abort at about a second on the next head call — paid only when the user writes again within
 *    the second or two the shadow takes.
 *  - It is skipped while any turn runs, and while an earlier shadow's request is still open (an
 *    aborted request holds the slot until the provider has really let go of it). It is not asked
 *    of an Anthropic model (a Claude preset): no grammar, no logprobs, and a paid call.
 *  - Its provider rows carry callSite "intent_shadow", which latency:report keeps off the turn.
 *  - It starts right after the reply, and the warm-keeper re-warms the orchestrator's head only after
 *    its idle window (4 s default): the shadow's ~1k-token prefix, if it displaces that head on a
 *    one-slot server, is displaced before the re-warm rather than after it — when the shadow ends
 *    inside that window. It is capped at INTENT_SHADOW_TIMEOUT_MS, not at the window, so a slow one
 *    (a cold prefill of both prefixes) can still be on the wire when the re-warm goes out.
 *
 * WHICH TURNS. Every top-level turn that was not blocked, the fast lane's included: the front desk
 * answering is the one direct outcome the readout's decision=answer_direct can be checked against,
 * and leaving those turns out would measure "answer directly" only on turns the front desk had
 * already turned away. A nested turn (a workflow step inside a turn) is part of its parent's outcome
 * and never shadowed on its own; nor is a scene or job step, which was routed when it was authored
 * (the facet triage skips it for the same reason).
 *
 * WHAT THE TURN DID is read from what the turn already logs, while it runs: an audit tap on the
 * turn's own session reads the fast lane's verdict (message_received), the up-front source judge's
 * (guardrail_flagged), the first iteration's prompt sections (prompt_section_sizes — was the
 * orchestration module included), the facet triage's verdict when it ran, the specialists started
 * directly under the turn (their sessions are `sub:<session>:<agent>:<ts>`; a sub-agent's own
 * delegations and a workflow's are one level further down), and the workflows that completed (the
 * result-side test the turn's own tally uses, agent/turn-tool-contribution.ts, nested plan steps
 * included). The capsule's agent names are not in any row, so the prompt assembly notes them
 * (noteIntentShadowCapsule), and only when the capsule reached the prompt in time. Whether the score
 * threshold pressed a workflow comes from the turn's own guardrail events. A row or a note is taken
 * only from the turn's own request context (inTurn): a turn superseded on the same session keeps
 * writing while it unwinds. An ephemeral agent is recorded as "ephemeral" (agentLabel).
 *
 * PRIVACY. The user's message and the prior-turn digest are held in memory until the call is made
 * and go to the routing tier only. The row carries option keys, probabilities, agent names, enum
 * statuses, lengths and ids — never the message, the digest or the English restatement (its length
 * only). tests/intent-shadow.test.ts holds this with canary strings.
 */
import { logAudit, subscribeToAudit } from "../audit/logger.js";
import type { AuditEvent } from "../audit/schema.js";
import { getConfig } from "../config/loader.js";
import { languageBucket, type LanguageBucket } from "../decisions/gate.js";
import {
  acceptPreRoute,
  askIntentReadout,
  askPreRouteReadout,
  INTENT_FACET_BY_NAME,
  INTENT_FACETS,
  INTENT_READOUT_VERSION,
  type IntentFacetName,
  type IntentReadoutResult,
  type PreRouteReadoutResult,
} from "../decisions/intent-readout.js";
import { agentDescriptionText, NONE_KEY } from "../decisions/pre-route-question.js";
import { childLogger } from "../logger.js";
import type { ChatProvider } from "../providers/lmstudio.js";
import { currentRequestContext, runWithRequestContext } from "../runtime/request-context.js";
import { resolveRoutingTierProvider, routingTierModelId } from "./routing-tier-provider.js";
import { detectTextLanguage } from "./text-language.js";
import { nestedCallContribution, readNestedToolCalls, toolResultContribution } from "./turn-tool-contribution.js";
import type { TurnOutput } from "./turn-types.js";

const log = childLogger("agent:intent-shadow");

/**
 * Wall-clock bound on the shadow's calls together. The readout measured 0.86-1.16 s warm and the
 * pre-route question is one token; a cold prefill of the ~1k-token prefix is a few seconds more. A
 * request still open after this is not a measurement worth holding the slot for.
 */
export const INTENT_SHADOW_TIMEOUT_MS = 15_000;

/**
 * The workflow_required guardrail events that only fire where the search score cleared the
 * threshold (runtime.ts: each sits behind shouldRequireWorkflowExecutionAfterSearch): the nudge
 * after a search, the deterministic rewrite to run_workflow, the rejected tool-free answer, and the
 * correction after a failed name. `workflow_run_released_after_search` is the same gate letting go,
 * so it is recorded but is not pressure.
 */
export const THRESHOLD_WORKFLOW_GATES: ReadonlySet<string> = new Set([
  "workflow_run_required_after_search",
  "workflow_run_forced_after_search",
  "tool_free_workflow_run_rejected",
  "workflow_run_correction_required",
]);

/** An agent name, an enum value, a status: never free text. Anything else is not copied. */
const IDENTIFIER_RE = /^[A-Za-z0-9_.:@-]{1,80}$/;

/** Distinct specialists kept on the row; the count is kept whole. */
const MAX_AGENTS_KEPT = 8;

/** tools/ephemeral-agent-factory.ts: every agent it mints runs as `ephemeral:<name>`. */
const EPHEMERAL_AGENT_PREFIX = "ephemeral:";

/** What the row says for any ephemeral agent (agentLabel). */
export const EPHEMERAL_AGENT_LABEL = "ephemeral";

export type IntentShadowFastLane = "answered" | "declined" | "not_offered";
export type IntentShadowJudgeStatus = "not_run" | "answered" | "no_answer" | "no_routing_tier";

/** What one turn did, as far as the readout's facets and the pre-router can be checked against it. */
export interface IntentShadowFacts {
  /** "not_offered": the turn never reached the front desk (a task signal, an attachment, the lane off). */
  fastLane: IntentShadowFastLane;
  /** The front desk's escalation reason when it declined (its own enum). */
  fastLaneReason: string | null;
  /** The up-front source judge: whether it answered, and what. */
  judge: { status: IntentShadowJudgeStatus; verdict: boolean | null; decidedBy: "laya" | "incumbent" | null };
  /** The discovery capsule as the first iteration's prompt got it: "timeout" when it came too late to be used. */
  capsule: {
    status: "not_run" | "ok" | "timeout";
    agents: string[];
    /**
     * The prompt-budget trimmer dropped it after the fact (prompt_budget_exceeded): the orchestrator
     * never read it. A pre-router runs before the prompt is built, so it is still asked.
     */
    trimmed: boolean;
  };
  /** Specialists started directly under the turn's session, in start order (repeats kept). */
  subAgentRuns: string[];
  /** run_workflow calls that completed (a routing miss that returns success is not one). */
  workflowRuns: number;
  /** The first iteration's orchestrationModule prompt section, in characters; null without a prompt row. */
  moduleChars: number | null;
  /** The facet triage's verdict in the readout's keys, when the triage ran in the same turn. */
  triage: Partial<Record<IntentFacetName, string>> | null;
}

export interface IntentShadowTurnInput {
  sessionId: string;
  turnId: string;
  userId?: string;
  channel: string;
  userMessage: string;
  /** Read only for a turn that is shadowed, BEFORE the turn records its message. */
  priorTurnDigest: () => string | undefined;
  /** Started inside another turn: a workflow step run by a turn's tool. */
  nested: boolean;
}

interface CollectingTurn {
  readonly sessionId: string;
  readonly turnId: string;
  readonly userId: string | undefined;
  readonly userMessage: string;
  readonly priorTurnDigest: string | undefined;
  readonly startedAt: number;
  readonly facts: IntentShadowFacts;
  unsubscribe: () => void;
}

/** What runTurn holds between the start and the end of one turn. */
export interface IntentShadowHandle {
  readonly collecting: CollectingTurn | null;
}

/** Every turn, shadowed or not: a shadow is launched only when none runs. */
let activeTurns = 0;
/** Bumped by every turn start, so a shadow scheduled before one never launches after it. */
let generation = 0;
/** The shadow whose request is open. Aborted by a turn start, cleared only when the request ends. */
let inFlight: AbortController | null = null;
/** The turns being shadowed, by session: the tap and the capsule note find their turn here. */
const collecting = new Map<string, CollectingTurn>();
/** Launched shadows, so a test can wait for them. */
const pending = new Set<Promise<void>>();

export function intentShadowMode(): "off" | "shadow" {
  try {
    return getConfig().orchestration?.intentReadout === "shadow" ? "shadow" : "off";
  } catch {
    return "off";
  }
}

function emptyFacts(): IntentShadowFacts {
  return {
    fastLane: "not_offered",
    fastLaneReason: null,
    judge: { status: "not_run", verdict: null, decidedBy: null },
    capsule: { status: "not_run", agents: [], trimmed: false },
    subAgentRuns: [],
    workflowRuns: 0,
    moduleChars: null,
    triage: null,
  };
}

function identifier(value: unknown): string | null {
  return typeof value === "string" && IDENTIFIER_RE.test(value) ? value : null;
}

/**
 * A specialist's name as the row keeps it. An ephemeral agent's name is written by a model from the
 * task (the architect's snake_case `agentName`, or the orchestrator's for a knowledge-base worker),
 * so it can carry the request's own words — `ephemeral:bakery_landing_page_writer` passes the
 * identifier pattern. It is kept as EPHEMERAL_AGENT_LABEL: the pre-router is never offered one, so
 * the name adds nothing to a figure that the label does not.
 */
function agentLabel(value: unknown): string {
  const name = identifier(value);
  if (name === null) return "(other)";
  return name.startsWith(EPHEMERAL_AGENT_PREFIX) ? EPHEMERAL_AGENT_LABEL : name;
}

/**
 * Whether the code running now belongs to `turnId`'s turn. The session alone does not say: a send
 * supersedes a running turn of the same session without waiting for it to unwind (gateway/rpc.ts),
 * and the old turn, still in its first prompt assembly, would note its capsule and log its prompt
 * row into the new turn's facts — where the first note and the first prompt row stand. Everything a
 * turn runs carries its turn id in the request context (runTurn sets it; sub-agent.ts and
 * tools/registry.ts spread it into theirs), so a row or a note written under ANOTHER turn's id is
 * that turn's. Code outside any turn's context is not refused: it has nothing to tell it apart by.
 */
function inTurn(turnId: string): boolean {
  const ambient = currentRequestContext()?.turnId;
  return ambient === undefined || ambient === turnId;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** A facet value only when it is one of that facet's own keys. */
function facetKey(name: IntentFacetName, value: unknown): string | undefined {
  return typeof value === "string" && INTENT_FACET_BY_NAME[name].keys.includes(value) ? value : undefined;
}

/** The facet triage's verdict (routing_triage_decided) in the readout's keys, as triageVerdictKeys maps it. */
function triageKeys(verdict: Record<string, unknown>): Partial<Record<IntentFacetName, string>> {
  const yesNo = (value: unknown) => (typeof value === "boolean" ? (value ? "yes" : "no") : undefined);
  const domains = Array.isArray(verdict["domain"]) ? verdict["domain"] : [];
  const keys: Partial<Record<IntentFacetName, string | undefined>> = {
    mode: facetKey("mode", verdict["mode"]),
    domain: facetKey("domain", domains[0] ?? "other"),
    deliverable: facetKey("deliverable", verdict["deliverable"]),
    multi: yesNo(verdict["multi"]),
    alone: yesNo(verdict["alone"]),
    source_sensitive: yesNo(verdict["sourceSensitive"]),
    decision: facetKey("decision", verdict["decision"]),
  };
  return Object.fromEntries(Object.entries(keys).filter(([, value]) => value !== undefined)) as Partial<Record<IntentFacetName, string>>;
}

/**
 * Fold one audit event into the facts of the turn it belongs to. Pure apart from the facts it
 * updates; exported so each fact's source row is tested directly.
 */
export function foldIntentShadowEvent(
  facts: IntentShadowFacts,
  sessionId: string,
  event: Pick<AuditEvent, "type" | "sessionId" | "data">,
): void {
  const rowSession = event.sessionId;
  if (!rowSession) return;
  const data = event.data ?? {};
  if (rowSession !== sessionId) {
    // A specialist the orchestrator started: sub-agent.ts logs its start under the run's own
    // session, `sub:<parent>:<agent>:<ts>`. A sub-agent's delegation is `sub:sub:…` and a workflow
    // step's `sub:workflow:…`, so neither matches the prefix.
    if (event.type === "sub_agent_started" && rowSession.startsWith(`sub:${sessionId}:`) && !("stage" in data)) {
      facts.subAgentRuns.push(agentLabel(data["agentName"]));
    }
    return;
  }
  switch (event.type) {
    case "message_received":
      // turn-prepare.ts: the front desk's verdict row. The row that opens the turn has no fastLane key.
      if (data["fastLane"] === true) {
        facts.fastLane = "answered";
      } else if (data["fastLane"] === false) {
        facts.fastLane = "declined";
        facts.fastLaneReason = identifier(data["escalateReason"]);
      }
      break;
    case "guardrail_flagged": {
      const type = data["type"];
      if (type === "upfront_source_sensitive_detected" || type === "upfront_source_sensitive_clear") {
        // `answered: false` is a reply with no yes/no in it, resolved to the fail-safe "clear": no verdict.
        const answered = data["answered"] !== false;
        facts.judge = {
          status: answered ? "answered" : "no_answer",
          verdict: answered ? type === "upfront_source_sensitive_detected" : null,
          decidedBy: data["decidedBy"] === "laya" ? "laya" : "incumbent",
        };
      } else if (type === "upfront_source_sensitive_no_routing_tier") {
        facts.judge = { status: "no_routing_tier", verdict: null, decidedBy: null };
      }
      break;
    }
    case "prompt_section_sizes":
      // Logged once per turn, on the first iteration: the head the turn was answered under.
      if (facts.moduleChars === null && typeof data["orchestrationModule"] === "number") facts.moduleChars = data["orchestrationModule"];
      break;
    case "prompt_budget_exceeded":
      // turn-system-prompt.ts's trimmer: the capsule it names was dropped from the prompt.
      if (Array.isArray(data["droppedSections"]) && data["droppedSections"].includes("discoveryCapsule")) facts.capsule.trimmed = true;
      break;
    case "tool_call_completed": {
      // The call's own row only: a replay of a cached result, and the loop rows the runtime writes
      // about a call already logged, are not another run.
      if (data["success"] !== true || data["cachedResult"] === true || data["repeatedIdenticalOutput"] === true
        || data["reusedDelegationLoop"] === true) break;
      const tool = typeof data["tool"] === "string" ? data["tool"] : "";
      const metadata = record(data["metadata"]);
      if (toolResultContribution(tool, { success: true, ...(metadata ? { metadata } : {}) }).workflowCompleted) facts.workflowRuns += 1;
      for (const nested of readNestedToolCalls(tool, metadata)) {
        if (nestedCallContribution(nested).workflowCompleted) facts.workflowRuns += 1;
      }
      break;
    }
    case "routing_triage_decided": {
      const verdict = record(data["verdict"]);
      if (verdict && !facts.triage) facts.triage = triageKeys(verdict);
      break;
    }
    default:
      break;
  }
}

/**
 * A turn is starting. Every turn calls this, shadowed or not: it aborts a shadow in flight — the
 * model is wanted — and counts the turn, so no shadow launches while one runs. Returns what the end
 * of the turn needs; `collecting` is null for a turn that is not shadowed.
 */
export function intentShadowTurnStarted(input: IntentShadowTurnInput): IntentShadowHandle {
  activeTurns += 1;
  generation += 1;
  // Not cleared here: the slot is held until the aborted request has really ended.
  inFlight?.abort();
  if (input.nested || input.channel === "scene" || !input.userMessage.trim() || intentShadowMode() !== "shadow") {
    return { collecting: null };
  }
  // runTurn has no catch around this call: a throw here would fail the turn. A digest that cannot
  // be read leaves the turn unshadowed — without it the readout would read another case than the
  // facet triage does — and still counted, so its end uncounts it.
  let priorTurnDigest: string | undefined;
  try {
    priorTurnDigest = input.priorTurnDigest();
  } catch (err) {
    log.debug({ err, sessionId: input.sessionId }, "intent shadow: prior-turn digest unavailable; turn not shadowed");
    return { collecting: null };
  }
  const turn: CollectingTurn = {
    sessionId: input.sessionId,
    turnId: input.turnId,
    userId: input.userId,
    userMessage: input.userMessage,
    priorTurnDigest,
    startedAt: Date.now(),
    facts: emptyFacts(),
    unsubscribe: () => {},
  };
  try {
    turn.unsubscribe = subscribeToAudit((event) => {
      // Called inside logAudit, so the ambient context is the writer's (inTurn).
      if (inTurn(turn.turnId)) foldIntentShadowEvent(turn.facts, turn.sessionId, event);
    });
  } catch (err) {
    // Without the tap the row still has the readout, the capsule and the guardrail events.
    log.debug({ err }, "intent shadow: audit tap unavailable");
  }
  collecting.set(input.sessionId, turn);
  return { collecting: turn };
}

/**
 * The prompt assembly's note of the capsule the first iteration got: the agent names when the
 * prefetch made its budget, "timeout" when the turn went on without it. The first note of a turn
 * stands. A no-op for a session nobody shadows.
 */
export function noteIntentShadowCapsule(
  sessionId: string,
  capsule: { status: "ok"; agents: readonly string[] } | { status: "timeout" },
): void {
  const turn = collecting.get(sessionId);
  // A superseded turn of the same session, still assembling its first prompt, notes into nothing.
  if (!turn || turn.facts.capsule.status !== "not_run" || !inTurn(turn.turnId)) return;
  turn.facts.capsule = capsule.status === "ok"
    ? { status: "ok", agents: capsule.agents.map((name) => identifier(name)).filter((name): name is string => name !== null), trimmed: false }
    : { status: "timeout", agents: [], trimmed: false };
}

/** The turn's outcome as the row states it: the facts, plus what only the returned turn knows. */
export interface IntentShadowOutcome extends IntentShadowFacts {
  wallMs: number;
  /** The workflow_required events the turn raised, distinct, in order (the runtime's own enums). */
  workflowPressure: string[];
  /** One of them came from the score threshold (THRESHOLD_WORKFLOW_GATES). */
  workflowForced: boolean;
  /** agents.performance.splitOrchestrationPrompt: without it the module is always in the base, and "included" says nothing. */
  moduleSplit: boolean;
}

/**
 * The turn has ended. Stops the tap and, for a shadowed turn that delivered a reply, schedules the
 * shadow on a macrotask — after the caller's own continuation, which is where the reply is sent.
 * A turn that threw, or was blocked before it routed (a guardrail, the rate limit, the budget), is
 * no routing outcome and gets no row.
 */
export function intentShadowTurnEnded(handle: IntentShadowHandle | undefined, output: TurnOutput | undefined): void {
  // No handle: the turn threw before it was counted, and must not uncount another one.
  if (!handle) return;
  if (activeTurns > 0) activeTurns -= 1;
  const turn = handle.collecting;
  if (!turn) return;
  turn.unsubscribe();
  if (collecting.get(turn.sessionId) === turn) collecting.delete(turn.sessionId);
  if (!output || output.blocked) return;
  const workflowPressure = [...new Set(output.guardrailEvents
    .filter((event) => event.type === "workflow_required")
    .map((event) => identifier(event.details))
    .filter((details): details is string => details !== null))];
  let moduleSplit = false;
  try {
    moduleSplit = getConfig().agents.performance.splitOrchestrationPrompt === true;
  } catch {
    // no config: the module's inclusion is reported as unknown
  }
  const outcome: IntentShadowOutcome = {
    ...turn.facts,
    capsule: { ...turn.facts.capsule, agents: [...turn.facts.capsule.agents] },
    subAgentRuns: [...turn.facts.subAgentRuns],
    wallMs: Date.now() - turn.startedAt,
    workflowPressure,
    workflowForced: workflowPressure.some((details) => THRESHOLD_WORKFLOW_GATES.has(details)),
    moduleSplit,
  };
  const scheduledGeneration = generation;
  const timer = setTimeout(() => {
    const run = launch(turn, outcome, scheduledGeneration);
    pending.add(run);
    void run.finally(() => pending.delete(run));
  }, 0);
  if (typeof timer.unref === "function") timer.unref();
}

export type IntentShadowStatus = "ok" | "failed" | "aborted" | "skipped";

/** What the shadow's calls came back with. */
export interface IntentShadowReadings {
  status: IntentShadowStatus;
  /** Why not ok: a skip reason (superseded, busy, in_flight, no_logprobs_provider), a failure (no_provider, timeout, no_logprobs, error), or new_turn. */
  reason: string | null;
  intent: IntentReadoutResult | null;
  preRoute: PreRouteReadoutResult | null;
}

async function launch(turn: CollectingTurn, outcome: IntentShadowOutcome, scheduledGeneration: number): Promise<void> {
  if (intentShadowMode() !== "shadow") return;
  const language = languageBucket(detectTextLanguage(turn.userMessage)?.code);
  const skip = generation !== scheduledGeneration ? "superseded" : activeTurns > 0 ? "busy" : inFlight ? "in_flight" : null;
  if (skip) {
    logIntentShadowRow(turn, outcome, language, { status: "skipped", reason: skip, intent: null, preRoute: null });
    return;
  }
  const controller = new AbortController();
  inFlight = controller;
  try {
    const readings = await askShadowReadings(turn, outcome, controller.signal);
    logIntentShadowRow(turn, outcome, language, readings);
  } catch (err) {
    // The askers never throw; a row that could not be written costs the measurement, never the user.
    log.debug({ err, sessionId: turn.sessionId }, "intent shadow failed");
  } finally {
    if (inFlight === controller) inFlight = null;
  }
}

async function askShadowReadings(turn: CollectingTurn, outcome: IntentShadowOutcome, turnStarted: AbortSignal): Promise<IntentShadowReadings> {
  const timeout = AbortSignal.timeout(INTENT_SHADOW_TIMEOUT_MS);
  const signal = AbortSignal.any([turnStarted, timeout]);
  // The readout needs a grammar and token logprobs, which only a llama.cpp server gives. Under a
  // Claude preset the routing tier falls back to the turn's own model (routing-tier-provider.ts):
  // a paid call per turn that comes back without a single logprob. Not asked.
  let modelId = "";
  try {
    modelId = routingTierModelId();
  } catch {
    // unknown: asked, and a reply without logprobs is recorded as that
  }
  if (modelId.split("/")[0]?.trim() === "anthropic") {
    return { status: "skipped", reason: "no_logprobs_provider", intent: null, preRoute: null };
  }
  let provider: ChatProvider;
  try {
    provider = resolveRoutingTierProvider();
  } catch {
    return { status: "failed", reason: "no_provider", intent: null, preRoute: null };
  }
  // Its own context, not the turn's: the rows name the turn they measure but not as its work.
  const context = {
    sessionId: turn.sessionId,
    turnId: turn.turnId,
    ...(turn.userId ? { userId: turn.userId } : {}),
    callSite: "intent_shadow" as const,
  };
  const intent = await runWithRequestContext({ ...context, agentName: "intent_readout" }, () => askIntentReadout(
    provider,
    { userMessage: turn.userMessage, ...(turn.priorTurnDigest ? { priorTurnDigest: turn.priorTurnDigest } : {}) },
    { signal },
  ));
  const stopped = (): string | null => (turnStarted.aborted ? "new_turn" : timeout.aborted ? "timeout" : null);
  let preRoute: PreRouteReadoutResult | null = null;
  if (!stopped() && outcome.capsule.status === "ok" && outcome.capsule.agents.length > 0) {
    const subAgents = getConfig().subAgents as Record<string, Parameters<typeof agentDescriptionText>[0]>;
    preRoute = await runWithRequestContext({ ...context, agentName: "pre_router_readout" }, () => askPreRouteReadout(provider, {
      message: turn.userMessage,
      candidates: outcome.capsule.agents,
      // The bench's default option text (pre-router-bench --describe description), so the figures compare.
      describe: (name) => agentDescriptionText(subAgents[name], "description"),
    }, { signal }));
  }
  if (intent.ok) return { status: "ok", reason: null, intent, preRoute };
  const why = stopped();
  if (why === "new_turn") return { status: "aborted", reason: why, intent, preRoute };
  return { status: "failed", reason: why ?? intent.reason, intent, preRoute };
}

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

/**
 * The row's data: letters mapped to option keys, probabilities, agent names, enum statuses,
 * lengths and ids. Never a string of the user's: the message and the digest are not in `turn`'s
 * part of it at all, and the restatement goes in as its length. Pure; exported for the tests.
 */
export function buildIntentShadowRowData(
  turn: { turnId: string; userMessage: string; priorTurnDigest: string | undefined },
  outcome: IntentShadowOutcome,
  language: LanguageBucket,
  readings: IntentShadowReadings,
): Record<string, unknown> {
  const intent = readings.intent?.ok ? readings.intent.readout : null;
  const facets: Record<string, unknown> = {};
  const misses: Record<string, string> = {};
  if (intent) {
    for (const definition of INTENT_FACETS) {
      const read = intent.facets[definition.name];
      if (read) {
        facets[definition.name] = {
          choice: read.choice,
          top: round4(read.top),
          margin: round4(read.margin),
          runnerUp: read.runnerUp ?? null,
          ...(read.sampled !== undefined ? { sampled: read.sampled } : {}),
        };
      } else {
        // The reason only: a miss's raw top token is model text, and not worth the doubt.
        misses[definition.name] = intent.misses[definition.name]?.reason ?? "no_slot";
      }
    }
  }
  const pre = readings.preRoute;
  const preRoute = !pre
    ? { status: outcome.capsule.status === "ok" && outcome.capsule.agents.length > 0 ? "not_asked" : "no_candidates" }
    : pre.ok
      ? {
          status: "ok",
          choice: identifier(pre.readout.choice) ?? "(other)",
          top: round4(pre.readout.top),
          margin: round4(pre.readout.margin),
          runnerUp: pre.readout.runnerUp !== undefined ? identifier(pre.readout.runnerUp) ?? "(other)" : null,
          none: pre.readout.choice === NONE_KEY,
          // "none" protected, at the default thresholds: what a pre-router would have done.
          accepted: identifier(acceptPreRoute(pre.readout)) ?? "(other)",
          probabilities: Object.fromEntries(Object.entries(pre.readout.probabilities)
            .map(([key, p]) => [identifier(key) ?? "(other)", round4(p)])),
          ms: pre.readout.ms,
        }
      : { status: pre.reason, ms: pre.ms };
  const agents = [...new Set(outcome.subAgentRuns)].slice(0, MAX_AGENTS_KEPT);
  return {
    version: INTENT_READOUT_VERSION,
    turnId: identifier(turn.turnId) ?? "(other)",
    status: readings.status,
    reason: readings.reason,
    language,
    messageChars: turn.userMessage.length,
    priorDigest: Boolean(turn.priorTurnDigest),
    readout: intent
      ? { ms: intent.ms, tokens: intent.tokens, queryEnChars: intent.queryEn.length, facets, misses }
      : null,
    readoutFailure: readings.intent && !readings.intent.ok ? readings.intent.reason : null,
    preRoute,
    actual: {
      fastLane: outcome.fastLane,
      fastLaneReason: outcome.fastLaneReason,
      judge: outcome.judge,
      capsule: { status: outcome.capsule.status, agents: outcome.capsule.agents.slice(0, MAX_AGENTS_KEPT), trimmed: outcome.capsule.trimmed },
      subAgentRuns: outcome.subAgentRuns.length,
      firstAgent: outcome.subAgentRuns[0] ?? null,
      agents,
      workflowRuns: outcome.workflowRuns,
      workflowForced: outcome.workflowForced,
      workflowPressure: outcome.workflowPressure,
      moduleSplit: outcome.moduleSplit,
      moduleChars: outcome.moduleChars,
      moduleIncluded: outcome.moduleSplit && outcome.moduleChars !== null ? outcome.moduleChars > 0 : null,
      wallMs: outcome.wallMs,
      triage: outcome.triage,
    },
  };
}

function logIntentShadowRow(turn: CollectingTurn, outcome: IntentShadowOutcome, language: LanguageBucket, readings: IntentShadowReadings): void {
  logAudit("intent_readout_shadow", buildIntentShadowRowData(turn, outcome, language, readings), {
    sessionId: turn.sessionId,
    severity: "info",
  });
}

/** Wait for every shadow scheduled so far to finish (tests; the timer is a macrotask). */
export async function settleIntentShadowForTests(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  while (pending.size > 0) await Promise.allSettled([...pending]);
}

/** The module's counters, for the tests. */
export function intentShadowStateForTests(): { activeTurns: number; inFlight: boolean; collecting: number } {
  return { activeTurns, inFlight: inFlight !== null, collecting: collecting.size };
}

export function resetIntentShadowForTests(): void {
  for (const turn of collecting.values()) turn.unsubscribe();
  collecting.clear();
  inFlight?.abort();
  inFlight = null;
  activeTurns = 0;
  generation = 0;
}
