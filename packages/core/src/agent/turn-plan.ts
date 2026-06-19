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
import { writeTurnPlan, readTurnPlan, clearTurnPlan } from "../swarm/memory.js";

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
  /** Steps sharing a parallelGroup may run concurrently (independent work). */
  parallelGroup?: number;
  /** Ids of steps that must complete first. */
  dependsOn?: string[];
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
      return { ...raw, objective: inner.replace(/^\s*objective\s*[:\-]\s*/i, "").trim() };
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
 * Coerce loosely-typed tool arguments (from the record_plan tool) into a
 * validated TurnPlan. Never throws — clamps sizes and drops malformed steps so
 * a sloppy model call still yields a usable plan.
 */
export function normalizeTurnPlan(rawInput: Record<string, unknown>): TurnPlan {
  const raw = unwrapPlanEnvelope(rawInput);
  const rawSteps = Array.isArray(raw["steps"]) ? raw["steps"] : [];
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
      id: clampString(obj["id"]) || `s${steps.length + 1}`,
      description,
      kind,
    };
    const agent = clampString(obj["agent"] ?? obj["agentName"] ?? obj["agent_name"]);
    if (agent) step.agent = agent;
    const group = obj["parallelGroup"] ?? obj["parallel_group"];
    if (typeof group === "number" && Number.isFinite(group)) step.parallelGroup = group;
    const deps = clampStringList(obj["dependsOn"] ?? obj["depends_on"], MAX_STEPS);
    if (deps.length > 0) step.dependsOn = deps;
    steps.push(step);
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

export async function persistTurnPlan(sessionId: string, plan: TurnPlan): Promise<void> {
  await writeTurnPlan(rootSessionId(sessionId), JSON.stringify(plan));
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
