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
import { getPerTurnToolCallLimit } from "../agent/delegation-response-collapse.js";
import { getLoadableDirectMainToolNames } from "../agent/default-tools.js";

const log = childLogger("tool:execute_plan");

/** Hard stop on scheduler rounds, so a plan that never settles cannot spin. */
const MAX_ROUNDS = 16;
/** How much of a completed step's result is carried to the steps that depend on it. */
const CARRIED_RESULT_CHARS = 1_200;
/**
 * How much of each step's result is handed BACK to the orchestrator, and the ceiling across all of
 * them. Handing the results back is the point of the tool — the orchestrator is told to write the
 * final answer from them, and a `direct` or `reuse` step's output reaches it through no other
 * channel — but a wide plan must not flood the turn either, so each is clipped and the total
 * bounded.
 */
const REPORTED_RESULT_CHARS = 4_000;
const REPORTED_RESULT_TOTAL_CHARS = 16_000;

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
      + upstream.map((entry) => {
        const slice = entry.text.slice(0, CARRIED_RESULT_CHARS);
        // Unmarked truncation is worse than a short excerpt: the step is told to use this and not
        // re-derive it, so a fragment cut mid-sentence reads as the complete finding.
        return `[${entry.id}] ${slice}${slice.length < entry.text.length ? "\n…(truncated — ask for the rest if you need it)" : ""}`;
      }).join("\n\n"),
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
  /** Artifacts the step produced, propagated so the parent turn can surface them as downloads. */
  artifacts?: unknown[];
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
  // ...but the lean tool catalog withholds the direct capability tools from the turn and lets the
  // orchestrator pull one in with load_tool, so the grant alone is narrower than the caller's real
  // reach: checking it by itself refused every `direct` step naming a normal tool. The loadable set
  // is "what this tool mode already permits", so honouring it widens nothing.
  const reachable = !ctx.allowedTools
    || ctx.allowedTools.includes(dispatch.tool)
    || getLoadableDirectMainToolNames().includes(dispatch.tool);
  if (!reachable) {
    return { status: "failed", detail: `'${dispatch.tool}' is not in this agent's allowed tool set` };
  }

  try {
    const result = await executeTool(dispatch.tool, dispatch.args, ctx);
    if (!result.success) {
      return { status: "failed", detail: (result.error ?? "step failed").slice(0, 300) };
    }
    // A workflow that does not exist comes back SUCCESSFUL: run_workflow deliberately returns a
    // routing miss rather than an error (audit bd3d60dc), flagged as workflowNotFound. Taken at
    // face value the step was recorded `done`, counted in "N/N completed", and its "no saved
    // workflow matches…" prose was carried into the dependent steps as though it were research.
    if (step.kind === "reuse" && result.metadata?.["workflowNotFound"] === true) {
      return {
        status: "failed",
        detail: `no workflow named "${step.workflow}" exists — re-record the step with a real workflow name, or make it a delegate step`,
      };
    }
    // Artifacts have to be forwarded explicitly: collectTurnArtifactAttachments walks the metadata
    // of the turn's TOOL MESSAGES, and a step's result is not one — it is a nested call inside this
    // tool. Dropping them leaves the user told a deck was built with nothing to download, and lets
    // the auto-build fire again for work already done. parallel_delegate and run_task_graph
    // aggregate the same way.
    const stepArtifacts = result.metadata?.["artifacts"];
    return {
      status: "done",
      result: result.output,
      ...(Array.isArray(stepArtifacts) && stepArtifacts.length > 0 ? { artifacts: stepArtifacts } : {}),
    };
  } catch (err) {
    return { status: "failed", detail: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300) };
  }
}

registerTool({
  name: "execute_plan",
  description:
    "Execute the plan you recorded with record_plan: runs its steps in dependency order, running a parallelGroup concurrently, "
    + "dispatching each step by its kind — `delegate` steps to the specialist, `reuse` steps to the named workflow, `direct` steps "
    + "to the tool the step names — and passing each result to the steps that declared a dependency on it. It hands every step's "
    + "result back to you, which is what you write the final answer from. A `direct` step with no tool stays yours: it reports those "
    + "(and anything waiting on them), and once you have done them, call execute_plan again with completed:[\"<their ids>\"] to run "
    + "the steps that were waiting. Use this instead of re-issuing the plan's steps "
    + "as separate tool calls; the plan's order and parallelism are then actually honoured rather than reconstructed.",
  parameters: {
    type: "object",
    properties: {
      completed: {
        type: "array",
        items: { type: "string" },
        description: "Ids of steps you have since done yourself (the ones reported as YOURS TO DO). They are marked complete so the steps waiting on them can run.",
      },
      retry: {
        type: "array",
        items: { type: "string" },
        description: "Ids of failed steps to attempt again.",
      },
    },
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const plan = await loadTurnPlan(ctx.sessionId);
    if (!plan) {
      return fail("No plan recorded this turn. Call record_plan first, then execute_plan.");
    }
    if (plan.steps.length === 0) {
      // Reachable without the model doing anything odd: normalizeTurnPlan drops any step it cannot
      // read a description from, so a whole plan can normalize to nothing. Reported as finished, it
      // told the orchestrator to write the final answer for a plan that never existed.
      return fail("The recorded plan has no steps — record_plan could not read any. Re-record it with a description on each step.");
    }
    const cycle = planCycle(plan);
    if (cycle.length > 0) {
      return fail(`The plan's dependsOn edges form a cycle (${cycle.join(" -> ")}), so it has no run order. Re-record it without the cycle.`);
    }

    const byId = new Map(plan.steps.map((step) => [step.id, step]));
    const statuses = new Map<string, TurnPlanStepStatus>(
      (plan.outcomes ?? []).map((outcome) => [outcome.id, outcome.status]),
    );
    const details = new Map<string, string>((plan.outcomes ?? []).flatMap((o) => (o.detail ? [[o.id, o.detail]] : [])));
    // Seeded from the store, so a resumed call can still feed an earlier step's output into a
    // dependent — and still report it. Results the first call held only in memory were lost.
    const results = new Map<string, string>((plan.outcomes ?? []).flatMap((o) => (o.result ? [[o.id, o.result]] : [])));
    const artifacts: unknown[] = [];

    // THE RESUME PATH. Without these a `manual` step is terminal: it is not `pending`, so it is
    // never re-offered, and it never settles, so its dependents stay blocked for good. The tool
    // told the orchestrator to do the step and call again, and calling again could not do
    // anything — every later call returned byte-identical output while the plan never finished.
    const idList = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.length > 0) : [];
    const unknownIds: string[] = [];
    const accept = (ids: string[], from: (status: TurnPlanStepStatus) => boolean, to: TurnPlanStepStatus, detail: string): string[] => {
      const applied: string[] = [];
      for (const id of ids) {
        if (!byId.has(id)) { unknownIds.push(id); continue; }
        if (!from(statuses.get(id) ?? "pending")) continue;
        statuses.set(id, to);
        details.set(id, detail);
        applied.push(id);
      }
      return applied;
    };
    const marked = accept(idList(args["completed"]), (status) => status !== "done", "done", "done by the orchestrator");
    const retried = accept(idList(args["retry"]), (status) => status === "failed" || status === "manual", "pending", "retried");
    for (const id of retried) details.delete(id);
    // A step left "running" by an interrupted earlier call is retried rather than stranded.
    for (const [id, status] of statuses) if (status === "running") statuses.set(id, "pending");

    // execute_plan issues its delegations from INSIDE one tool call, so the turn loop's per-turn
    // cap never sees them. Left unbounded, a 12-step plan fans out 12 times in a turn that believes
    // it allows 5. Already-settled delegate steps count, so a resumed call continues the same
    // turn's budget rather than starting a fresh one.
    const delegateCap = getPerTurnToolCallLimit("delegate_to_agent");
    let delegateDispatched = plan.steps.filter(
      (step) => step.kind === "delegate" && ["done", "failed"].includes(statuses.get(step.id) ?? "pending"),
    ).length;
    let capHit = false;

    const ran: string[] = [];
    let blocked: ReturnType<typeof planFrontier>["blocked"] = [];

    for (let round = 0; round < MAX_ROUNDS; round++) {
      // The turn can be cancelled mid-plan; without this the scheduler walks the rest of it and
      // dispatches specialists nobody is waiting for any more.
      if (ctx.signal?.aborted) break;
      const frontier = planFrontier(plan, statuses);
      blocked = frontier.blocked;
      if (frontier.batch.length === 0) break;

      const batch = frontier.batch.filter((step) => {
        if (step.kind !== "delegate" || delegateCap === undefined) return true;
        if (delegateDispatched >= delegateCap) { capHit = true; return false; }
        delegateDispatched += 1;
        return true;
      });
      if (batch.length === 0) break;

      for (const step of batch) statuses.set(step.id, "running");
      const outcomes = await Promise.all(
        batch.map((step) => runStep(plan, step, results, ctx).then((run) => ({ step, run }))),
      );
      for (const { step, run } of outcomes) {
        statuses.set(step.id, run.status);
        if (run.detail) details.set(step.id, run.detail);
        if (run.result) results.set(step.id, run.result);
        if (run.artifacts) artifacts.push(...run.artifacts);
        if (run.status === "done" || run.status === "failed") ran.push(step.id);
      }
    }

    const finalOutcomes: TurnPlanStepOutcome[] = plan.steps.map((step) => {
      const status = statuses.get(step.id) ?? "pending";
      const detail = details.get(step.id);
      const result = results.get(step.id);
      return {
        id: step.id,
        status,
        ...(detail ? { detail } : {}),
        ...(result ? { result: result.slice(0, REPORTED_RESULT_CHARS) } : {}),
      };
    });
    await persistTurnPlan(ctx.sessionId, { ...plan, outcomes: finalOutcomes });

    const done = finalOutcomes.filter((o) => o.status === "done");
    const failed = finalOutcomes.filter((o) => o.status === "failed");
    const manual = finalOutcomes.filter((o) => o.status === "manual");
    const pending = finalOutcomes.filter((o) => o.status === "pending");
    // A dependency the plan never defined can never be satisfied — that is a malformed plan, not
    // work in progress, and it must not be reported as a finished one.
    const malformed = blocked.filter((b) => b.kind === "missing");
    const outstanding = failed.length + manual.length + pending.length;

    logAudit("plan_executed", {
      agentName: ctx.currentAgentName ?? "main",
      steps: plan.steps.length,
      done: done.length,
      failed: failed.length,
      manual: manual.length,
      pending: pending.length,
      dispatched: ran.length,
    }, { sessionId: ctx.sessionId, severity: failed.length > 0 || malformed.length > 0 ? "warn" : "info" });
    log.info({ done: done.length, failed: failed.length, manual: manual.length, dispatched: ran.length }, "Plan executed");

    const describe = (list: TurnPlanStepOutcome[]): string => list
      .map((o) => {
        const step = byId.get(o.id);
        return `  - ${o.id} (${step?.kind ?? "?"}) ${step?.description ?? ""}${o.detail ? ` — ${o.detail}` : ""}`;
      })
      .join("\n");

    // THE RESULTS THEMSELVES. Naming the steps and then saying "synthesize the answer from their
    // results" is what produces an invented answer: the orchestrator was handed the roll-call and
    // told to write up work it could not see.
    const reported: string[] = [];
    let budget = REPORTED_RESULT_TOTAL_CHARS;
    let omitted = 0;
    for (const outcome of done) {
      const text = results.get(outcome.id);
      if (!text) continue;
      if (budget <= 0) { omitted += 1; continue; }
      const slice = text.slice(0, Math.min(REPORTED_RESULT_CHARS, budget));
      budget -= slice.length;
      reported.push(`[${outcome.id}] ${byId.get(outcome.id)?.description ?? ""}\n${slice}${slice.length < text.length ? "\n…(clipped)" : ""}`);
    }

    const sections = [`Plan: ${done.length}/${plan.steps.length} step(s) completed.`];
    if (done.length > 0) sections.push(`COMPLETED:\n${describe(done)}`);
    if (reported.length > 0) {
      sections.push(`RESULTS — write the final answer from these:\n\n${reported.join("\n\n")}`
        + (omitted > 0 ? `\n\n(${omitted} further result(s) omitted for length.)` : ""));
    }
    if (failed.length > 0) sections.push(`FAILED — retry with execute_plan({retry:["<id>"]}), reroute, or tell the user:\n${describe(failed)}`);
    if (manual.length > 0) {
      sections.push(`YOURS TO DO — do these now, then call execute_plan({completed:["<id>"]}) with their ids to continue:\n${describe(manual)}`);
    }
    if (blocked.length > 0) {
      sections.push(`WAITING — cannot run yet:\n${blocked.map((b) => `  - ${b.step.id} — ${b.reason}`).join("\n")}`);
    }
    // Everything still pending that planFrontier did not name as blocked — a step sitting two hops
    // behind a manual or failed one is in neither list, and so was reported nowhere at all.
    const blockedIds = new Set(blocked.map((b) => b.step.id));
    const stranded = pending.filter((o) => !blockedIds.has(o.id));
    if (stranded.length > 0) {
      sections.push(`NOT RUN — waiting further back in the chain:
${describe(stranded)}`);
    }
    if (malformed.length > 0) {
      sections.push(`THE PLAN IS MALFORMED: ${malformed.map((b) => b.step.id).join(", ")} depend on ids the plan never defines, so they can never run. `
        + `Re-record the plan with dependsOn naming real step ids (s1, s2, …), then execute_plan again.`);
    }
    if (capHit) {
      sections.push(`DELEGATE BUDGET REACHED (${delegateCap} per turn): the remaining delegate step(s) were not dispatched. `
        + `Narrow the plan, do them yourself, or tell the user what is missing.`);
    }
    if (marked.length > 0 || retried.length > 0 || unknownIds.length > 0) {
      sections.push([
        marked.length > 0 ? `Marked done: ${marked.join(", ")}.` : "",
        retried.length > 0 ? `Retried: ${retried.join(", ")}.` : "",
        unknownIds.length > 0 ? `Ignored — no such step id: ${unknownIds.join(", ")}.` : "",
      ].filter(Boolean).join(" "));
    }
    sections.push(
      outstanding > 0
        ? "Do NOT write the final answer while steps above are outstanding."
        : "Every step has run. Synthesize the final answer from the results above, against the acceptance criteria.",
    );

    const ok = failed.length === 0 && malformed.length === 0;
    return {
      success: ok,
      output: sections.join("\n\n"),
      ...(ok ? {} : {
        error: failed.length > 0
          ? `${failed.length} plan step(s) failed`
          : `${malformed.length} plan step(s) depend on ids the plan does not define`,
      }),
      metadata: {
        steps: plan.steps.length,
        done: done.length,
        failed: failed.length,
        manual: manual.length,
        pending: pending.length,
        executed: ran,
        // Only the steps that actually delegated or ran a workflow. The turn counts this as its
        // delegation total, and that signal gates the honesty chain — a plan step that merely
        // called a tool is not orchestration and must not be reported as it.
        delegated: ran.filter((id) => byId.get(id)?.kind !== "direct").length,
        ...(artifacts.length > 0 ? { artifacts } : {}),
      },
    };
  },
});
