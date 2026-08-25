/**
 * execute_plan — run the plan the orchestrator recorded, instead of re-deriving it by hand.
 *
 * THE PLAN COULD ALWAYS SAY THIS; NOTHING COULD RUN IT. `record_plan` has always accepted a
 * mixed, dependency-ordered, partly-parallel plan — each step tagged `reuse` (a scene/job),
 * `delegate` (an agent) or `direct` (the orchestrator itself), with `dependsOn` and
 * `parallelGroup`. Its own output then said "Recording a plan is NOT execution", and the three
 * executors underneath are each single-type: run_task_graph takes agent nodes only, run_workflow
 * takes one workflow, a job takes scenes. So the graph was flattened back into prose and
 * re-assembled by the model, and whether the order survived was unobservable.
 *
 * This walks the plan and dispatches per kind. It deliberately does NOT reimplement delegation
 * or workflow execution: it calls the registered tools, so every step inherits what those
 * already carry — tier gating, per-turn caps, approval callbacks, swarm state, artifact
 * propagation and audit. The scheduler is the only new logic, and it lives next door in
 * agent/plan-frontier.ts where it can be tested without running anything.
 *
 * All three kinds dispatch: `delegate` to the agent, `reuse` to the named workflow, `direct` to
 * the tool the step names — so one plan can chain tools, agents and workflows in a single
 * dependency order. A `direct` step that names no tool is reasoning rather than a call, and stays
 * the orchestrator's: those are reported back as work to do, along with anything blocked behind
 * them, and because the executor records per-step outcomes, calling it again after doing them
 * continues where it stopped.
 */
import { registerTool, executeTool, type ToolContext, type ToolResult } from "./registry.js";
import { childLogger } from "../logger.js";
import { logAudit } from "../audit/logger.js";
import { loadTurnPlan, persistTurnPlan, type TurnPlan, type TurnPlanStep, type TurnPlanStepOutcome, type TurnPlanStepStatus } from "../agent/turn-plan.js";
import { planFrontier, planCycle } from "../agent/plan-frontier.js";
import { BLOCKED_STEP_TOOLS } from "./tool-pipeline.js";

const log = childLogger("tool:execute_plan");

/** Hard stop on scheduler rounds, so a plan that never settles cannot spin. */
const MAX_ROUNDS = 16;
/** How much of a completed step's result is carried to the steps that depend on it. */
const CARRIED_RESULT_CHARS = 1_200;

function fail(error: string): ToolResult {
  return { success: false, output: "", error };
}

/**
 * The task text a dispatched step receives.
 *
 * A step description is one line, and one line is not a task. Run e95eec63 is what that costs: a
 * node whose task REFERRED to material it did not carry ("they pasted their config") produced an
 * entirely invented answer, because the specialist could not see the conversation. So a
 * dispatched step carries the objective it serves and the results of the steps it declared a
 * dependency on — which is exactly what `dependsOn` was already asserting is needed.
 */
function buildStepTask(plan: TurnPlan, step: TurnPlanStep, results: ReadonlyMap<string, string>): string {
  const parts = [
    `OBJECTIVE (the whole turn): ${plan.objective}`,
    `YOUR STEP: ${step.description}`,
  ];
  const upstream = (step.dependsOn ?? [])
    .map((id) => ({ id, text: results.get(id) }))
    .filter((entry): entry is { id: string; text: string } => Boolean(entry.text));
  if (upstream.length > 0) {
    parts.push(
      "RESULTS THIS STEP DEPENDS ON — use them; do not re-derive or re-ask for them:\n"
      + upstream.map((entry) => `[${entry.id}] ${entry.text.slice(0, CARRIED_RESULT_CHARS)}`).join("\n\n"),
    );
  }
  if (plan.acceptanceCriteria.length > 0) {
    parts.push(`ACCEPTANCE CRITERIA for the turn: ${plan.acceptanceCriteria.join("; ")}`);
  }
  return parts.join("\n\n");
}

interface StepRun {
  status: TurnPlanStepStatus;
  detail?: string;
  result?: string;
}

/**
 * What a step dispatches to, or null when it is the orchestrator's own work.
 *
 * All three kinds go out through the normal tool path, so each inherits the tier gate, the
 * sandbox contract, approval prompts and audit exactly as a directly-issued call would — the
 * executor grants nothing that the caller could not already do.
 */
function dispatchFor(plan: TurnPlan, step: TurnPlanStep, results: ReadonlyMap<string, string>):
  { tool: string; args: Record<string, unknown> } | { manual: string } {
  if (step.kind === "direct") {
    if (!step.tool) {
      return { manual: "a `direct` step with no `tool` is yours: the plan names nothing to dispatch" };
    }
    // A plan that lists itself as one of its own steps would re-enter here with the same plan and
    // the same pending step, forever — the round limit is per-call and does not survive nesting.
    if (step.tool === "execute_plan") {
      return { manual: "a plan cannot run itself as one of its own steps" };
    }
    // Delegation belongs to `delegate` and `reuse` steps, where the plan accounts for it — as a
    // step of its own, in the dependency order, counted against the turn's delegate budget. Hidden
    // inside a `direct` step it is fan-out the plan does not know it is doing.
    if (BLOCKED_STEP_TOOLS.has(step.tool)) {
      return { manual: `\`${step.tool}\` fans out to other agents — make it a delegate or reuse step so the plan accounts for it, or run it yourself` };
    }
    return { tool: step.tool, args: { ...(step.toolArgs ?? {}) } };
  }
  if (step.kind === "reuse") {
    if (!step.workflow) {
      return { manual: "no workflow named on this reuse step — set `workflow` in the plan, or run it yourself" };
    }
    return { tool: "run_workflow", args: { name: step.workflow, context: buildStepTask(plan, step, results) } };
  }
  return {
    tool: "delegate_to_agent",
    args: { ...(step.agent ? { agentName: step.agent } : {}), task: buildStepTask(plan, step, results) },
  };
}

/** Dispatch one step to the tool that already knows how to run that kind of work. */
async function runStep(plan: TurnPlan, step: TurnPlanStep, results: ReadonlyMap<string, string>, ctx: ToolContext): Promise<StepRun> {
  const dispatch = dispatchFor(plan, step, results);
  if ("manual" in dispatch) return { status: "manual", detail: dispatch.manual };
  // ToolContext.allowedTools is a contract on every tool that fans out to other tools: it must not
  // reach outside the caller's grant. This one dispatches a tool name the MODEL wrote into a plan,
  // so without the check a step could name anything the tier gate happens to permit.
  if (ctx.allowedTools && !ctx.allowedTools.includes(dispatch.tool)) {
    return { status: "failed", detail: `'${dispatch.tool}' is not in this agent's allowed tool set` };
  }

  try {
    const result = await executeTool(dispatch.tool, dispatch.args, ctx);
    if (!result.success) {
      return { status: "failed", detail: (result.error ?? "step failed").slice(0, 300) };
    }
    return { status: "done", result: result.output };
  } catch (err) {
    return { status: "failed", detail: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300) };
  }
}

registerTool({
  name: "execute_plan",
  description:
    "Execute the plan you recorded with record_plan: runs its steps in dependency order, running a parallelGroup concurrently, "
    + "dispatching each step by its kind — `delegate` steps to the specialist, `reuse` steps to the named workflow, `direct` steps "
    + "to the tool the step names — and passing each result to the steps that declared a dependency on it. A `direct` step with no "
    + "tool stays yours: it reports those (and anything waiting on them) so you can do them and call execute_plan again to continue. Use this instead of re-issuing the plan's steps "
    + "as separate tool calls; the plan's order and parallelism are then actually honoured rather than reconstructed.",
  parameters: {
    type: "object",
    properties: {},
  },
  async execute(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const plan = await loadTurnPlan(ctx.sessionId);
    if (!plan) {
      return fail("No plan recorded this turn. Call record_plan first, then execute_plan.");
    }
    const cycle = planCycle(plan);
    if (cycle.length > 0) {
      return fail(`The plan's dependsOn edges form a cycle (${cycle.join(" -> ")}), so it has no run order. Re-record it without the cycle.`);
    }

    const statuses = new Map<string, TurnPlanStepStatus>(
      (plan.outcomes ?? []).map((outcome) => [outcome.id, outcome.status]),
    );
    // A step left "running" by an interrupted earlier call is retried rather than stranded.
    for (const [id, status] of statuses) if (status === "running") statuses.set(id, "pending");

    const details = new Map<string, string>((plan.outcomes ?? []).flatMap((o) => (o.detail ? [[o.id, o.detail]] : [])));
    const results = new Map<string, string>();
    const ran: string[] = [];
    let blocked: ReturnType<typeof planFrontier>["blocked"] = [];

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const frontier = planFrontier(plan, statuses);
      blocked = frontier.blocked;
      if (frontier.batch.length === 0) break;

      for (const step of frontier.batch) statuses.set(step.id, "running");
      const outcomes = await Promise.all(
        frontier.batch.map((step) => runStep(plan, step, results, ctx).then((run) => ({ step, run }))),
      );
      for (const { step, run } of outcomes) {
        statuses.set(step.id, run.status);
        if (run.detail) details.set(step.id, run.detail);
        if (run.result) results.set(step.id, run.result);
        if (run.status === "done" || run.status === "failed") ran.push(step.id);
      }
    }

    const finalOutcomes: TurnPlanStepOutcome[] = plan.steps.map((step) => {
      const status = statuses.get(step.id) ?? "pending";
      const detail = details.get(step.id);
      return detail ? { id: step.id, status, detail } : { id: step.id, status };
    });
    await persistTurnPlan(ctx.sessionId, { ...plan, outcomes: finalOutcomes });

    const done = finalOutcomes.filter((o) => o.status === "done");
    const failed = finalOutcomes.filter((o) => o.status === "failed");
    const manual = finalOutcomes.filter((o) => o.status === "manual");
    const pending = finalOutcomes.filter((o) => o.status === "pending");

    logAudit("plan_executed", {
      agentName: ctx.currentAgentName ?? "main",
      steps: plan.steps.length,
      done: done.length,
      failed: failed.length,
      manual: manual.length,
      pending: pending.length,
    }, { sessionId: ctx.sessionId, severity: failed.length > 0 ? "warn" : "info" });
    log.info({ done: done.length, failed: failed.length, manual: manual.length }, "Plan executed");

    const describe = (list: TurnPlanStepOutcome[]): string => list
      .map((o) => {
        const step = plan.steps.find((s) => s.id === o.id);
        return `  - ${o.id} (${step?.kind ?? "?"}) ${step?.description ?? ""}${o.detail ? ` — ${o.detail}` : ""}`;
      })
      .join("\n");

    const sections = [`Plan: ${done.length}/${plan.steps.length} step(s) completed.`];
    if (done.length > 0) sections.push(`COMPLETED:\n${describe(done)}`);
    if (failed.length > 0) sections.push(`FAILED — decide whether to retry, reroute or tell the user:\n${describe(failed)}`);
    if (manual.length > 0) sections.push(`YOURS TO DO — run these now, then call execute_plan again to continue:\n${describe(manual)}`);
    if (blocked.length > 0) {
      sections.push(`WAITING on the steps above:\n${blocked.map((b) => `  - ${b.step.id} — ${b.reason}`).join("\n")}`);
    }
    if (pending.length > 0 && manual.length === 0 && blocked.length === 0 && failed.length === 0) {
      sections.push(`NOT RUN (scheduler round limit reached): ${pending.map((o) => o.id).join(", ")}`);
    }
    sections.push(
      manual.length > 0 || failed.length > 0
        ? "Do NOT write the final answer while steps above are outstanding."
        : "Every dispatchable step has run. Synthesize the final answer from their results, against the acceptance criteria.",
    );

    return {
      success: failed.length === 0,
      output: sections.join("\n\n"),
      ...(failed.length > 0 ? { error: `${failed.length} plan step(s) failed` } : {}),
      metadata: {
        steps: plan.steps.length,
        done: done.length,
        failed: failed.length,
        manual: manual.length,
        executed: ran,
      },
    };
  },
});
