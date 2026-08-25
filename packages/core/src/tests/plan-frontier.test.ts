import { describe, expect, it } from "vitest";
import { planFrontier, planCycle } from "../agent/plan-frontier.js";
import { decidePlanContinuation, type TurnPlan, type TurnPlanStep, type TurnPlanStepStatus } from "../agent/turn-plan.js";

/**
 * THE PLAN COULD ALWAYS SAY THIS; NOTHING COULD RUN IT.
 *
 * record_plan has always accepted a mixed, dependency-ordered, partly-parallel plan — each step
 * tagged reuse / delegate / direct, with dependsOn and parallelGroup — and its own output then
 * said "Recording a plan is NOT execution". The three executors underneath are each single-type
 * (run_task_graph takes agent nodes, run_workflow takes one workflow, a job takes scenes), so
 * the graph was flattened into prose and re-assembled by the model. These pin the scheduler that
 * reads the structure back.
 */
const step = (over: Partial<TurnPlanStep> & { id: string }): TurnPlanStep => ({
  description: `do ${over.id}`,
  kind: "delegate",
  ...over,
});

const plan = (steps: TurnPlanStep[], over: Partial<TurnPlan> = {}): TurnPlan => ({
  objective: "ship the thing",
  steps,
  acceptanceCriteria: [],
  stopConditions: [],
  riskTier: "low",
  wide: false,
  createdAt: new Date(0).toISOString(),
  ...over,
});

const statuses = (entries: Record<string, TurnPlanStepStatus>): Map<string, TurnPlanStepStatus> =>
  new Map(Object.entries(entries));

describe("planFrontier — what can run now", () => {
  it("starts with the first step when nothing has run", () => {
    const p = plan([step({ id: "s1" }), step({ id: "s2", dependsOn: ["s1"] })]);
    expect(planFrontier(p, statuses({})).batch.map((s) => s.id)).toEqual(["s1"]);
  });

  it("releases a dependent only once its dependency is done", () => {
    const p = plan([step({ id: "s1" }), step({ id: "s2", dependsOn: ["s1"] })]);
    expect(planFrontier(p, statuses({ s1: "running" })).batch).toEqual([]);
    expect(planFrontier(p, statuses({ s1: "done" })).batch.map((s) => s.id)).toEqual(["s2"]);
  });

  it("widens the batch ONLY for a shared parallelGroup", () => {
    // Two steps with no declared dependency are not necessarily independent — the model may
    // simply not have written the edge. The schema says a shared parallelGroup means
    // "independent and may run concurrently", so that, and only that, is permission.
    const grouped = plan([
      step({ id: "a", parallelGroup: 1 }),
      step({ id: "b", parallelGroup: 1 }),
      step({ id: "c", parallelGroup: 2 }),
    ]);
    expect(planFrontier(grouped, statuses({})).batch.map((s) => s.id)).toEqual(["a", "b"]);

    const ungrouped = plan([step({ id: "a" }), step({ id: "b" })]);
    expect(planFrontier(ungrouped, statuses({})).batch.map((s) => s.id)).toEqual(["a"]);
  });

  it("does not let a parallelGroup carry in a member whose own dependency is unmet", () => {
    // The group widens the batch from what is RUNNABLE, not from the plan: sharing a group says
    // these may run concurrently, never that they may run early.
    const p = plan([
      step({ id: "a", parallelGroup: 1 }),
      step({ id: "b", parallelGroup: 1, dependsOn: ["c"] }),
      step({ id: "c" }),
    ]);
    expect(planFrontier(p, statuses({})).batch.map((s) => s.id)).toEqual(["a"]);
    expect(planFrontier(p, statuses({ c: "done" })).batch.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("blocks a step whose dependency will never settle", () => {
    const p = plan([
      step({ id: "s1", kind: "direct" }),
      step({ id: "s2", dependsOn: ["s1"] }),
    ]);
    const frontier = planFrontier(p, statuses({ s1: "manual" }));
    expect(frontier.batch).toEqual([]);
    expect(frontier.blocked.map((b) => b.step.id)).toEqual(["s2"]);
    expect(frontier.blocked[0]?.reason).toMatch(/did not complete/);
  });

  it("blocks a step that depends on something the plan never defined", () => {
    const p = plan([step({ id: "s1", dependsOn: ["nope"] })]);
    const frontier = planFrontier(p, statuses({}));
    expect(frontier.batch).toEqual([]);
    expect(frontier.blocked[0]?.reason).toMatch(/does not define/);
  });

  it("keeps a pending dependency out of `blocked` — it is not-yet, not never", () => {
    const p = plan([step({ id: "s1" }), step({ id: "s2", dependsOn: ["s1"] })]);
    expect(planFrontier(p, statuses({})).blocked).toEqual([]);
  });

  it("reports a dependency cycle rather than running the steps outside it", () => {
    const p = plan([
      step({ id: "a", dependsOn: ["b"] }),
      step({ id: "b", dependsOn: ["a"] }),
      step({ id: "c" }),
    ]);
    expect(planCycle(p).length).toBeGreaterThan(0);
    expect(planCycle(plan([step({ id: "a" }), step({ id: "b", dependsOn: ["a"] })]))).toEqual([]);
  });
});

/**
 * The only thing that ever read a plan back measured STEP COUNT against DELEGATION COUNT — a
 * cardinality check with two mismatches: it counted `direct` steps the orchestrator does itself,
 * and the counter it compared them to did not count run_workflow at all, so a `reuse` step that
 * ran perfectly registered as nothing having happened.
 */
describe("decidePlanContinuation — measuring the plan against what ran", () => {
  const mixed = plan([
    step({ id: "s1", kind: "reuse", workflow: "research_pack" }),
    step({ id: "s2", kind: "delegate" }),
    step({ id: "s3", kind: "direct" }),
  ]);

  it("does not count a `direct` step as work the orchestrator owes a delegation for", () => {
    // Two dispatchable steps ran; the third is the orchestrator's own. The plan is finished.
    const decision = decidePlanContinuation({
      plan: mixed, executedDelegations: 2, delegationCap: 5, lastDelegationSucceeded: true, enabled: true,
    });
    expect(decision.total).toBe(2);
    expect(decision.continue).toBe(false);
  });

  it("still continues while a dispatchable step is genuinely outstanding", () => {
    const decision = decidePlanContinuation({
      plan: mixed, executedDelegations: 1, delegationCap: 5, lastDelegationSucceeded: true, enabled: true,
    });
    expect(decision.continue).toBe(true);
  });

  it("prefers the executor's real outcomes over counting, when it has run", () => {
    const executed = plan(mixed.steps, {
      outcomes: [
        { id: "s1", status: "done" },
        { id: "s2", status: "done" },
        { id: "s3", status: "manual", detail: "yours" },
      ],
    });
    // A `manual` step is still outstanding — that is a real answer, not a count.
    expect(decidePlanContinuation({
      plan: executed, executedDelegations: 0, delegationCap: 5, lastDelegationSucceeded: true, enabled: true,
    })).toMatchObject({ continue: true, done: 2, total: 3 });

    const finished = plan(mixed.steps, {
      outcomes: [
        { id: "s1", status: "done" },
        { id: "s2", status: "done" },
        { id: "s3", status: "done" },
      ],
    });
    expect(decidePlanContinuation({
      plan: finished, executedDelegations: 0, delegationCap: 5, lastDelegationSucceeded: true, enabled: true,
    }).continue).toBe(false);
  });

  it("does not count a FAILED step as one it finished", () => {
    // The directive reports "done N of M". Counting a failed step among them told the model it had
    // finished work that had in fact failed.
    const decision = decidePlanContinuation({
      plan: plan(mixed.steps, {
        outcomes: [
          { id: "s1", status: "done" },
          { id: "s2", status: "failed" },
          { id: "s3", status: "pending" },
        ],
      }),
      executedDelegations: 2, delegationCap: 5, lastDelegationSucceeded: true, enabled: true,
    });
    expect(decision.done).toBe(1);
    expect(decision.total).toBe(3);
  });

  it("never continues past the delegate cap, or after a failure, or when disabled", () => {
    const base = { plan: mixed, delegationCap: 2, lastDelegationSucceeded: true, enabled: true };
    expect(decidePlanContinuation({ ...base, executedDelegations: 2 }).continue).toBe(false);
    expect(decidePlanContinuation({ ...base, executedDelegations: 0, lastDelegationSucceeded: false }).continue).toBe(false);
    expect(decidePlanContinuation({ ...base, executedDelegations: 0, enabled: false }).continue).toBe(false);
  });
});
