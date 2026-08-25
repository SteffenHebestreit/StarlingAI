/**
 * Turn plan — a first-class, lightweight plan the orchestrator forms before
 * fanning out on a complex task. It ties the decision flow together:
 *   - a human checkpoint (surfaced in the operator dock, optionally approved),
 *   - the acceptance criteria the risk-gated QA pass checks the answer against,
 *   - a re-plan/anchor reference for sub-agents (read via readTurnPlan).
 *
 * The plan is soft: complex turns are nudged to record one, but the model may
 * still answer directly when the task is trivial. It is persisted in a reserved
 * per-session slot (NOT the shared-facts hash) so the raw JSON never leaks into
 * human-facing context.
 */
import { writeTurnPlan, readTurnPlan, clearTurnPlan, PLAN_VALUE_MAX } from "../swarm/memory.js";
import { childLogger } from "../logger.js";

const log = childLogger("turn-plan");

export type TurnPlanStepKind = "reuse" | "delegate" | "direct";
export type TurnRiskTier = "low" | "high";

export interface TurnPlanStep {
  /** Stable id within the plan (e.g. "s1"); used for dependsOn references. */
  id: string;
  /** One-line description of the step. */
  description: string;
  /** reuse = run an existing scene/job/workflow; delegate = hand to an agent;
   *  direct = the orchestrator does it itself. */
  kind: TurnPlanStepKind;
  /** Target agent for a delegate step (optional). */
  agent?: string;
  /**
   * Scene or job name for a `reuse` step.
   *
   * The mirror of `agent` above, and what makes a reuse step DISPATCHABLE rather than a note
   * to self: "run an existing workflow" cannot be executed by anything that does not know
   * which one. Optional, because a plan may legitimately name the workflow only in prose —
   * the executor then reports the step as one the orchestrator has to run itself.
   */
  workflow?: string;
  /**
   * Tool to run for a `direct` step, and the arguments to run it with.
   *
   * The third leg. `agent` makes a delegate step dispatchable and `workflow` makes a reuse step
   * dispatchable; this makes a direct step dispatchable, so one plan can chain tools, agents and
   * workflows in a single dependency order instead of the orchestrator hand-carrying the tool
   * calls between the delegations. Optional, because a direct step is often reasoning rather than
   * a call ("decide the framing") — without a tool it stays the orchestrator's own work.
   *
   * Args are literal: a tool takes structured arguments, so unlike a delegate step there is no
   * prose slot to carry an upstream result into. A step that genuinely needs a previous step's
   * OUTPUT as input belongs to the agent that can read it.
   */
  tool?: string;
  toolArgs?: Record<string, unknown>;
  /** Steps sharing a parallelGroup may run concurrently (independent work). */
  parallelGroup?: number;
  /** Ids of steps that must complete first. */
  dependsOn?: string[];
}

/** What became of one step. `pending` steps have not been attempted this turn. */
export type TurnPlanStepStatus = "pending" | "running" | "done" | "failed" | "manual";

export interface TurnPlanStepOutcome {
  id: string;
  status: TurnPlanStepStatus;
  /** Short note: the failure, or why the step is the orchestrator's to run. */
  detail?: string;
  /**
   * What the step produced, clipped. Persisted because the executor's whole purpose is to hand
   * these back: without it a resumed call reports a step as `done` while the work it produced is
   * gone, and the orchestrator is told to synthesize an answer from results it cannot see.
   */
  result?: string;
}

export interface TurnPlan {
  objective: string;
  steps: TurnPlanStep[];
  acceptanceCriteria: string[];
  stopConditions: string[];
  riskTier: TurnRiskTier;
  /** True when the planned fan-out is wide (more parallel work than the caps). */
  wide: boolean;
  createdAt: string;
  /**
   * What actually happened to each step, written by the plan executor.
   *
   * Without this the only record of execution is a COUNT of delegation tool calls, which cannot
   * say which step ran, cannot see a `reuse` step at all, and cannot tell a step the
   * orchestrator did itself from one nobody did. Present only once the executor has run.
   */
  outcomes?: TurnPlanStepOutcome[];
}

const MAX_STEPS = 12;
const MAX_CRITERIA = 12;
const MAX_STRING = 600;

function rootSessionId(sessionId: string): string {
  // Strip `sub:` nesting hops to reach the orchestrator's root session, where
  // the plan lives (mirrors deriveRootSessionId in sub-agent.ts).
  let current = sessionId;
  while (current.startsWith("sub:")) {
    const inner = current.slice("sub:".length);
    const lastColon = inner.lastIndexOf(":");
    if (lastColon === -1) return inner;
    const secondLastColon = inner.lastIndexOf(":", lastColon - 1);
    if (secondLastColon === -1) return inner;
    current = inner.slice(0, secondLastColon);
  }
  return current;
}

function clampString(value: unknown, fallback = ""): string {
  return (typeof value === "string" ? value : fallback).trim().slice(0, MAX_STRING);
}

function clampStringList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => clampString(v)).filter(Boolean).slice(0, max);
}

/**
 * If the model wrapped the whole plan in a single envelope key, unwrap it.
 * Qwen (and others) reliably call record_plan as `{ plan: { objective, steps, … } }`
 * even though the tool schema declares the fields flat — which previously read as
 * an empty plan and failed every planned turn with "A plan needs at least an
 * objective or one step." Only unwraps when the real fields are NOT already at the
 * top level, so a correct flat call is untouched. Topic-agnostic.
 */
function unwrapPlanEnvelope(raw: Record<string, unknown>): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return raw ?? {};
  if ("objective" in raw || "steps" in raw || "acceptanceCriteria" in raw || "acceptance_criteria" in raw) return raw;
  for (const key of ["plan", "args", "input"]) {
    const inner = raw[key];
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      return inner as Record<string, unknown>;
    }
    // Some models pass the ENTIRE plan as a free-text string under `plan` (audit
    // session e5754140 turn 2: `{ plan: "Objective: …\nStep 1 …" }`). That read as
    // an empty plan and failed with "needs an objective or one step", cascading
    // into a warden stop. Coerce the string into the objective so the turn records
    // a minimal plan and proceeds. Sibling keys (e.g. riskTier) are preserved.
    if (typeof inner === "string" && inner.trim()) {
      return { ...raw, objective: inner.replace(/^\s*objective\s*[:-]\s*/i, "").trim() };
    }
  }
  return raw;
}

/** Read the first present key from a set of aliases (camelCase + snake_case). */
function pickRaw(raw: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (raw[k] !== undefined && raw[k] !== null) return raw[k];
  }
  return undefined;
}

/**
 * Coerce the `steps` argument into an array of step-shaped objects. Local models
 * sometimes emit `steps` as a single newline-bulleted STRING instead of an array
 * (audit df65c23a turn 2: `steps: "- delegate_to_agent(agentName='content_writer', …)"`
 * recorded stepCount:0 because a string is not an array — the lone delegate step was
 * dropped, gating OUT the plan-aware QA / request-coverage checks). Split the string
 * into lines, strip leading list markers, and turn each non-empty line into a
 * `{ description }` step, pulling an `agentName='X'` mention into `agent` when present.
 * Structural coercion, not topic/keyword matching.
 */
function coerceStepsValue(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) {
    return value
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const step: Record<string, unknown> = { description: line };
        const m = line.match(/agent(?:Name|_name)?\s*[=:]\s*['"]?([A-Za-z0-9_]+)/);
        if (m) step.agent = m[1];
        return step;
      });
  }
  return [];
}

/**
 * Coerce loosely-typed tool arguments (from the record_plan tool) into a
 * validated TurnPlan. Never throws — clamps sizes and drops malformed steps so
 * a sloppy model call still yields a usable plan.
 */
export function normalizeTurnPlan(rawInput: Record<string, unknown>): TurnPlan {
  const raw = unwrapPlanEnvelope(rawInput);
  const rawSteps = coerceStepsValue(raw["steps"]);
  const steps: TurnPlanStep[] = [];
  for (let i = 0; i < rawSteps.length && steps.length < MAX_STEPS; i += 1) {
    const s = rawSteps[i];
    if (!s || typeof s !== "object") continue;
    const obj = s as Record<string, unknown>;
    // `desc`/`summary` aliases: local models routinely key a step's text as `desc`
    // (audit 8d480f5d turn 1: a 3-step plan with `desc`+`tag` keys recorded as
    // stepCount:0 because the step description read empty and the step was dropped,
    // even though the {plan:{…}} envelope unwrapped fine). Structural alias, not topic.
    const description = clampString(obj["description"] ?? obj["desc"] ?? obj["summary"] ?? obj["task"] ?? obj["title"]);
    if (!description) continue;
    const kindRaw = clampString(obj["kind"] ?? obj["tag"]).toLowerCase();
    const kind: TurnPlanStepKind = kindRaw === "reuse" || kindRaw === "direct" ? kindRaw : "delegate";
    const step: TurnPlanStep = {
      // Deliberately provisional — uniqueness is settled in one pass after the loop, because
      // `s${steps.length + 1}` cannot see an explicit id the model gives a LATER step.
      id: clampString(obj["id"]),
      description,
      kind,
    };
    const agent = clampString(obj["agent"] ?? obj["agentName"] ?? obj["agent_name"]);
    if (agent) step.agent = agent;
    const workflow = clampString(obj["workflow"] ?? obj["workflowName"] ?? obj["scene"] ?? obj["job"]);
    if (workflow) step.workflow = workflow;
    const tool = clampString(obj["tool"] ?? obj["toolName"] ?? obj["tool_name"]);
    if (tool) step.tool = tool;
    const toolArgs = obj["toolArgs"] ?? obj["tool_args"] ?? obj["args"] ?? obj["arguments"];
    if (toolArgs && typeof toolArgs === "object" && !Array.isArray(toolArgs)) {
      step.toolArgs = toolArgs as Record<string, unknown>;
    }
    const group = obj["parallelGroup"] ?? obj["parallel_group"];
    if (typeof group === "number" && Number.isFinite(group)) step.parallelGroup = group;
    const deps = clampStringList(obj["dependsOn"] ?? obj["depends_on"], MAX_STEPS);
    if (deps.length > 0) step.dependsOn = deps;
    steps.push(step);
  }

  // EVERY CONSUMER KEYS A STEP BY ITS ID — the scheduler's status map, the dependsOn edges, the
  // per-step outcomes. Two steps sharing one id therefore collapse into one: the first to run
  // marks the id `done`, the second is skipped as already-settled, and the plan reports both as
  // completed while one of them never ran. Reachable without the model repeating an id at all —
  // it need only leave one step's id blank and name a later step "s1".
  const usedIds = new Set<string>();
  // Explicit ids are reserved FIRST, across the whole plan: a dependsOn edge naming "s1" has to
  // keep pointing at the step the model called "s1", even when an earlier step left its own id
  // blank and would otherwise have been minted into that name. A repeated explicit id is cleared
  // here and re-minted below — first occurrence keeps it.
  for (const step of steps) {
    if (!step.id) continue;
    if (usedIds.has(step.id)) step.id = "";
    else usedIds.add(step.id);
  }
  let nextAutoId = 1;
  for (const step of steps) {
    if (step.id) continue;
    while (usedIds.has(`s${nextAutoId}`)) nextAutoId += 1;
    step.id = `s${nextAutoId}`;
    usedIds.add(step.id);
  }

  // Accept snake_case aliases for the multi-word keys. Local models routinely emit
  // `acceptance_criteria` / `stop_conditions` / `risk_tier` (audit e5754140 turn 1:
  // a 9-item acceptance_criteria array recorded as acceptanceCriteria:0), which
  // silently disabled BOTH the riskGatedQA gate and the qaDeliveryLoop because both
  // are gated on acceptanceCriteria.length. Structural alias, not topic/keyword.
  const riskRaw = clampString(pickRaw(raw, ["riskTier", "risk_tier"])).toLowerCase();
  return {
    objective: clampString(raw["objective"]),
    steps,
    acceptanceCriteria: clampStringList(pickRaw(raw, ["acceptanceCriteria", "acceptance_criteria"]), MAX_CRITERIA),
    stopConditions: clampStringList(pickRaw(raw, ["stopConditions", "stop_conditions"]), MAX_CRITERIA),
    riskTier: riskRaw === "high" ? "high" : "low",
    wide: raw["wide"] === true || countParallelWidth(steps) > 2,
    createdAt: new Date().toISOString(),
  };
}

/** Largest number of steps sharing one parallelGroup (the planned fan-out width). */
export function countParallelWidth(steps: TurnPlanStep[]): number {
  const groups = new Map<number, number>();
  let maxGroup = 0;
  for (const step of steps) {
    if (typeof step.parallelGroup !== "number") continue;
    const n = (groups.get(step.parallelGroup) ?? 0) + 1;
    groups.set(step.parallelGroup, n);
    if (n > maxGroup) maxGroup = n;
  }
  return maxGroup;
}

/** A copy whose per-step results are clipped to `budget`, or dropped entirely at 0. */
function withResultBudget(plan: TurnPlan, budget: number): TurnPlan {
  const outcomes = (plan.outcomes ?? []).map((outcome) => {
    if (!outcome.result) return outcome;
    if (budget <= 0) {
      const stripped: TurnPlanStepOutcome = { id: outcome.id, status: outcome.status };
      if (outcome.detail) stripped.detail = outcome.detail;
      return stripped;
    }
    return { ...outcome, result: outcome.result.slice(0, budget) };
  });
  return { ...plan, outcomes };
}

/**
 * Serialize the plan so that it FITS.
 *
 * The store caps the value with a hard slice and the reader JSON.parses what comes back, so a plan
 * one character over the limit does not come back truncated — it does not come back AT ALL, and a
 * turn in the middle of its own plan is told that no plan was ever recorded. Step results made that
 * easy to reach: they are the only unbounded thing in a plan, and also exactly what a resumed call
 * needs. So they are what gets shed, largest-affordable budget first, and the plan itself survives.
 */
function serializePlanWithinStoreBudget(plan: TurnPlan): string {
  let json = JSON.stringify(plan);
  if (json.length <= PLAN_VALUE_MAX) return json;

  for (const budget of [1_000, 400, 120, 0]) {
    json = JSON.stringify(withResultBudget(plan, budget));
    if (json.length <= PLAN_VALUE_MAX) return json;
  }
  // Nothing of ours left to shed — the steps themselves are oversized (a model-supplied toolArgs
  // blob, most likely). Drop the outcomes rather than the plan: re-running a completed step is
  // recoverable, losing the plan mid-turn is not.
  log.warn({ chars: json.length, limit: PLAN_VALUE_MAX }, "Turn plan too large for the store — dropped step outcomes");
  return JSON.stringify({ ...plan, outcomes: [] as TurnPlanStepOutcome[] });
}

export async function persistTurnPlan(sessionId: string, plan: TurnPlan): Promise<void> {
  await writeTurnPlan(rootSessionId(sessionId), serializePlanWithinStoreBudget(plan));
}

export async function loadTurnPlan(sessionId: string): Promise<TurnPlan | null> {
  const raw = await readTurnPlan(rootSessionId(sessionId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as TurnPlan;
    return parsed && Array.isArray(parsed.steps) ? parsed : null;
  } catch {
    return null;
  }
}

export async function clearTurnPlanForSession(sessionId: string): Promise<void> {
  await clearTurnPlan(rootSessionId(sessionId));
}

export interface TurnRiskSignals {
  /** Risk tier the orchestrator declared in its plan, if any. */
  planRiskTier?: TurnRiskTier;
  /** The turn makes sourced factual claims (dynamic guidance: source-sensitive). */
  sourceSensitive?: boolean;
  /** The turn asks for current/external state — news, weather, live data, etc.
   *  (dynamic guidance: freshness-sensitive). Such an answer is ungrounded
   *  unless this turn actually retrieved, so it enters the grounding QA gate. */
  freshnessSensitive?: boolean;
  /** The turn invoked at least one approval-gated tool (external/destructive/credential). */
  invokedApprovalGatedTool?: boolean;
}

/**
 * Risk-proportional gate input. A turn is high-stakes when it makes sourced or
 * current factual claims, takes an approval-gated (external/destructive/credential)
 * action, or the orchestrator itself flagged the plan high-risk. Everything else
 * (chat, low-stakes single-domain work) is low — and skips the QA pass entirely.
 */
export function classifyTurnRisk(signals: TurnRiskSignals): TurnRiskTier {
  if (signals.planRiskTier === "high") return "high";
  if (signals.sourceSensitive === true) return "high";
  if (signals.freshnessSensitive === true) return "high";
  if (signals.invokedApprovalGatedTool === true) return "high";
  return "low";
}

export interface PlanContinuationInput {
  /** The plan the orchestrator recorded this turn (null when none). */
  plan: TurnPlan | null;
  /** Successful delegations/workflows completed so far this turn (progress proxy). */
  executedDelegations: number;
  /** The per-turn delegate cap (loop backstop — never continue past it). */
  delegationCap: number;
  /** True when the just-finished orchestration SUCCEEDED (disposition === synthesize).
   *  We only extend a plan on progress, never after a failure. */
  lastDelegationSucceeded: boolean;
  /** orchestration.planDrivenContinuation — off ⇒ identity (today's behavior). */
  enabled: boolean;
}

export interface PlanContinuationDecision {
  /** True ⇒ keep orchestrating this turn (execute the next planned deliverable)
   *  instead of synthesizing / relaying after the first delegation. */
  continue: boolean;
  /** Delegations executed so far (progress). */
  done: number;
  /** Total deliverable-producing steps the plan declared. */
  total: number;
}

/**
 * Decide whether a multi-step recorded plan should keep executing instead of
 * synthesizing after the first delegation. THE fix for the truncation defect
 * (audit 763394da): a 3-deliverable request (paper → slides → speaker notes)
 * recorded a 4-step plan but shipped only the paper, because the post-
 * orchestration disposition defaulted to "synthesize" after one delegation and
 * never consulted the plan.
 *
 * Bounded so it cannot loop: it only fires when a genuine multi-step plan exists,
 * the last delegation SUCCEEDED, fewer delegations have run than the plan has
 * steps, AND we are strictly under the per-turn delegate cap (the existing
 * runaway-loop backstop). Each continuation leads to either another delegation
 * (progress, monotone toward the cap) or a final answer (the turn ends normally),
 * so it terminates. Purely structural (step count vs delegation count); no
 * topic/keyword inspection.
 */
export function decidePlanContinuation(input: PlanContinuationInput): PlanContinuationDecision {
  const { plan, executedDelegations, delegationCap, lastDelegationSucceeded, enabled } = input;
  // WHAT ACTUALLY RAN, when anything knows. execute_plan records a per-step outcome, so the
  // question "is the plan finished" has a real answer: no step still waiting to be dispatched.
  // Counting is the fallback for a plan the orchestrator executed by hand.
  const outcomes = plan?.outcomes;
  if (plan && outcomes && outcomes.length > 0) {
    // DONE MEANS DONE. Counting `failed` here made the [CONTINUE PLAN] directive tell the model it
    // had finished work that had in fact failed.
    const settled = outcomes.filter((o) => o.status === "done").length;
    const outstanding = outcomes.some((o) => o.status === "pending" || o.status === "manual");
    // The same single-deliverable exemption the counting branch has: a plan with one dispatchable
    // step is finished when that step is, and nudging it onward only re-delegates the same work.
    const dispatchable = plan.steps.filter((step) => step.kind !== "direct").length;
    if (!enabled || !lastDelegationSucceeded || !outstanding || dispatchable < 2) {
      return { continue: false, done: settled, total: outcomes.length };
    }
    if (executedDelegations >= delegationCap) return { continue: false, done: settled, total: outcomes.length };
    return { continue: true, done: settled, total: outcomes.length };
  }
  // COUNT ONLY WHAT THE COUNTER COUNTS. `executedDelegations` comes from the turn's delegation
  // tally, which counts delegate_to_agent / parallel_delegate / run_task_graph / swarm_delegate /
  // create_ephemeral_agent — and run_workflow, which a `reuse` step uses. It does NOT count a
  // `direct` step, which is the orchestrator's own tool call. Measuring those against ALL steps
  // made a completed mixed plan read as unfinished and pushed the orchestrator to keep
  // delegating past the end of its own plan.
  const total = plan?.steps.filter((step) => step.kind !== "direct").length ?? 0;
  const noContinue: PlanContinuationDecision = { continue: false, done: executedDelegations, total };
  if (!enabled || !plan || !lastDelegationSucceeded) return noContinue;
  if (total < 2) return noContinue;                          // single-deliverable plan → synthesize as before
  if (executedDelegations >= total) return noContinue;       // every planned step has run
  if (executedDelegations >= delegationCap) return noContinue; // loop backstop: never exceed the delegate cap
  return { continue: true, done: executedDelegations, total };
}

/** The [CONTINUE PLAN] directive shown to the orchestrator when a multi-step plan
 *  still has un-produced deliverables. Names the whole plan + progress so the model
 *  picks the next un-done step itself (delegation↔step order is not assumed). */
export function renderPlanContinuationDirective(plan: TurnPlan, done: number, total: number): string {
  return (
    `[CONTINUE PLAN] You recorded a ${total}-step plan and have completed ${done} of them this turn — the remaining deliverables are NOT done yet. ` +
    "Do NOT synthesize a final answer or stop until every planned deliverable has actually been produced (each has its own completed tool result this turn), or you hit a genuine blocker you must ask the user about. " +
    "Execute the NEXT not-yet-done step now via the appropriate tool. Do NOT repeat a step already completed, and do NOT claim a later step is done without its tool result.\n" +
    renderTurnPlan(plan)
  );
}

/** Compact human-readable rendering of a plan (for QA prompts / context). */
export function renderTurnPlan(plan: TurnPlan): string {
  const lines = [`Objective: ${plan.objective}`];
  if (plan.steps.length > 0) {
    lines.push("Steps:");
    for (const s of plan.steps) {
      const tags = [s.kind, s.agent, s.parallelGroup != null ? `group ${s.parallelGroup}` : ""].filter(Boolean).join(", ");
      lines.push(`  - [${s.id}] ${s.description}${tags ? ` (${tags})` : ""}`);
    }
  }
  if (plan.acceptanceCriteria.length > 0) {
    lines.push("Acceptance criteria:");
    for (const c of plan.acceptanceCriteria) lines.push(`  - ${c}`);
  }
  return lines.join("\n");
}
