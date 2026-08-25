/**
 * Which plan steps can run right now — the pure half of the plan executor.
 *
 * The plan schema has always been able to express a mixed, dependency-ordered, partly-parallel
 * piece of work: every step carries a `kind` (reuse a workflow / delegate to an agent / do it
 * directly), plus `dependsOn` and `parallelGroup`. Nothing ever read that structure back. The
 * orchestrator was told "recording a plan is NOT execution" and left to re-derive the order by
 * hand, so the edges and groups were advice, and whether they were honoured was unobservable.
 *
 * This turns them into a schedule. Kept separate from the dispatch so the ordering rules can be
 * tested without running an agent, a workflow or a tool.
 */
import type { TurnPlan, TurnPlanStep, TurnPlanStepStatus } from "./turn-plan.js";

export interface PlanFrontier {
  /** Steps to run now. More than one only when the plan put them in a parallelGroup. */
  batch: TurnPlanStep[];
  /** Steps that can never run: they depend on something manual, failed, or missing. */
  blocked: Array<{ step: TurnPlanStep; reason: string }>;
}

/** A step is finished, one way or another, and no longer blocks its dependents. */
const SETTLED: ReadonlySet<TurnPlanStepStatus> = new Set<TurnPlanStepStatus>(["done"]);

/**
 * The next batch to execute, given what has already settled.
 *
 * PARALLELISM IS THE PLAN'S DECISION, NOT AN INFERENCE. Two steps with no declared dependency
 * are not necessarily independent — the model may simply not have written the edge — so the
 * absence of `dependsOn` is not permission to run them together. Only a shared `parallelGroup`,
 * which the schema defines as "independent and may run concurrently", widens the batch. Anything
 * else runs one at a time, in plan order, which is what a reader of the plan would expect.
 */
export function planFrontier(plan: TurnPlan, statuses: ReadonlyMap<string, TurnPlanStepStatus>): PlanFrontier {
  const byId = new Map(plan.steps.map((step) => [step.id, step]));
  const statusOf = (id: string): TurnPlanStepStatus => statuses.get(id) ?? "pending";
  const settled = (id: string): boolean => SETTLED.has(statusOf(id));

  const blocked: PlanFrontier["blocked"] = [];
  const runnable: TurnPlanStep[] = [];

  for (const step of plan.steps) {
    if (statusOf(step.id) !== "pending") continue;
    const deps = step.dependsOn ?? [];
    const missing = deps.filter((dep) => !byId.has(dep));
    if (missing.length > 0) {
      blocked.push({ step, reason: `depends on ${missing.join(", ")}, which the plan does not define` });
      continue;
    }
    const unsettled = deps.filter((dep) => !settled(dep));
    if (unsettled.length === 0) {
      runnable.push(step);
      continue;
    }
    // A dependency that will never settle blocks this step for good; one still pending just
    // means "not yet", and the caller comes back after the next batch.
    const dead = unsettled.filter((dep) => {
      const status = statusOf(dep);
      return status === "failed" || status === "manual";
    });
    if (dead.length > 0) {
      blocked.push({ step, reason: `depends on ${dead.join(", ")}, which did not complete` });
    }
  }

  const head = runnable[0];
  if (!head) return { batch: [], blocked };
  const batch = head.parallelGroup === undefined
    ? [head]
    : runnable.filter((step) => step.parallelGroup === head.parallelGroup);
  return { batch, blocked };
}

/**
 * A cycle makes a plan unschedulable, and it is better to say so than to run the steps that
 * happen to sit outside it and call that "the plan". Returns the ids involved, or an empty array.
 */
export function planCycle(plan: TurnPlan): string[] {
  const byId = new Map(plan.steps.map((step) => [step.id, step]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const walk = (id: string): string[] => {
    if (state.get(id) === "done") return [];
    if (state.get(id) === "visiting") return stack.slice(stack.indexOf(id));
    state.set(id, "visiting");
    stack.push(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dep)) continue;
      const cycle = walk(dep);
      if (cycle.length > 0) return cycle;
    }
    stack.pop();
    state.set(id, "done");
    return [];
  };

  for (const step of plan.steps) {
    const cycle = walk(step.id);
    if (cycle.length > 0) return cycle;
  }
  return [];
}
