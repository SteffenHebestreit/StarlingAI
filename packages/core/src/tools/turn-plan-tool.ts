/**
 * record_plan — the orchestrator's first-class plan checkpoint.
 *
 * On a complex/multi-agent turn the orchestrator records a short structured plan
 * before fanning out. The plan is persisted in a reserved per-session slot (so
 * sub-agents and the risk-gated QA pass can read the same acceptance criteria),
 * and surfaces in the operator dock when a high-stakes/wide plan needs approval.
 * Recording a plan is soft and cheap — trivial turns skip it and answer directly.
 */
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";
import { getConfig } from "../config/loader.js";
import { currentEffortTier } from "../runtime/effort-context.js";
import { normalizeTurnPlan, persistTurnPlan, countParallelWidth, renderTurnPlan, type TurnPlan } from "../agent/turn-plan.js";

const log = childLogger("tool:record_plan");

/** D4: a large, high-risk, multi-delegate plan cannot finish inside the LOW-effort budget (~2 min) —
 * the fan-out gets cancelled and the turn back-fills a degraded, unverified answer (run e3cf6c22).
 * Pure/exported: fires only when the effort tier is "low", the plan is high-risk, and it has ≥3
 * delegate steps. Structural (effort tier + riskTier + delegate-step count), no topic/keyword matching. */
export function shouldWarnLowEffortBigPlan(
  effortTier: string | undefined,
  riskTier: string,
  delegateStepCount: number,
): boolean {
  return effortTier === "low" && riskTier === "high" && delegateStepCount >= 3;
}

registerTool({
  name: "record_plan",
  description:
    "Record a short structured plan for a complex, multi-step, or multi-agent turn BEFORE you fan out. " +
    "Skip it for anything you can answer directly or hand to a single specialist. " +
    "A good plan names the objective, the few steps (each tagged reuse | delegate | direct, with the agent for delegate steps and a parallelGroup for independent steps), " +
    "the acceptance criteria the final answer must meet, and the stop conditions. " +
    "Prefer a 'reuse' step (run an existing scene/job/workflow) over decomposing into agents when one fits.",
  parameters: {
    type: "object",
    properties: {
      objective: { type: "string", description: "One sentence: what a complete answer for this turn must deliver." },
      steps: {
        type: "array",
        description: "Ordered plan steps (keep it short — a handful, not a project plan).",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Short id, e.g. 's1' (referenced by dependsOn)." },
            description: { type: "string", description: "One line describing the step." },
            kind: { type: "string", enum: ["reuse", "delegate", "direct"], description: "reuse = run an existing scene/job/workflow; delegate = hand to an agent; direct = you do it." },
            agent: { type: "string", description: "Target agent name for a delegate step." },
            parallelGroup: { type: "number", description: "Steps sharing a parallelGroup are independent and may run concurrently." },
            dependsOn: { type: "array", items: { type: "string" }, description: "Ids of steps that must finish first." },
          },
          required: ["description", "kind"],
        },
      },
      acceptanceCriteria: { type: "array", items: { type: "string" }, description: "What the final answer must satisfy to be acceptable." },
      stopConditions: { type: "array", items: { type: "string" }, description: "When to stop / escalate (e.g. evidence not found, budget exhausted)." },
      riskTier: { type: "string", enum: ["low", "high"], description: "high if the plan touches external actions, spend, credentials, or makes sourced factual claims." },
    },
    required: ["objective", "steps"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const plan = normalizeTurnPlan(args);
    if (!plan.objective && plan.steps.length === 0) {
      return { success: false, output: "", error: "A plan needs at least an objective or one step." };
    }
    await persistTurnPlan(ctx.sessionId, plan);
    const width = countParallelWidth(plan.steps);
    logAudit("flow_plan_recorded", {
      agentName: ctx.currentAgentName ?? "main",
      stepCount: plan.steps.length,
      reuseSteps: plan.steps.filter((s) => s.kind === "reuse").length,
      delegateSteps: plan.steps.filter((s) => s.kind === "delegate").length,
      acceptanceCriteria: plan.acceptanceCriteria.length,
      riskTier: plan.riskTier,
      wide: plan.wide,
      parallelWidth: width,
    }, { sessionId: ctx.sessionId, severity: "info" });
    log.info({ steps: plan.steps.length, riskTier: plan.riskTier, wide: plan.wide }, "Turn plan recorded");

    // High-stakes / wide plan-approval pause (Phase 3c). Off by default; when on,
    // a high-risk or wide plan must be approved in the operator dock BEFORE the
    // orchestrator fans out. Degrades safely: a timeout or a missing channel
    // returns control without dead-ending or auto-executing the risky plan.
    const approvalResult = await maybeRequestPlanApproval(plan, ctx, width);
    if (approvalResult) return approvalResult;

    const delegateStepCount = plan.steps.filter((s) => s.kind === "delegate").length;
    const reuseStepCount = plan.steps.filter((s) => s.kind === "reuse").length;
    // Counter the "I planned, so I'm done" off-ramp: recording a plan is NOT
    // execution. Nudge the EXACT execution tool per step kind — reuse steps run via
    // run_workflow, delegate steps via the delegation tools — so a planned reuse step
    // actually fires the scene/job instead of being silently dropped.
    const execParts: string[] = [];
    if (reuseStepCount > 0) {
      execParts.push(`run the ${reuseStepCount} reuse step${reuseStepCount === 1 ? "" : "s"} via run_workflow (the planned scene/job)`);
    }
    if (delegateStepCount > 0) {
      execParts.push(`run the ${delegateStepCount} delegate step${delegateStepCount === 1 ? "" : "s"} — parallel_delegate for genuinely independent work, delegate_to_agent or run_task_graph otherwise`);
    }
    // D4 (session e3cf6c22): a large, high-risk, multi-delegate plan cannot finish inside the
    // LOW-effort budget (~2 min) — the fan-out gets cancelled and the turn back-fills a degraded,
    // unverified answer. Warn the orchestrator UP FRONT so it sets expectations with the user instead
    // of silently attempting a doomed run. Structural (delegate-step count + riskTier + effort tier);
    // no topic/keyword matching. Advisory only — it never blocks the plan.
    const budgetWarning = shouldWarnLowEffortBigPlan(currentEffortTier(), plan.riskTier, delegateStepCount)
      ? ` ⚠️ BUDGET NOTE: ${delegateStepCount} delegate steps at HIGH risk under LOW effort (~2 min budget) — this will very likely NOT finish in time. Prefer telling the user to re-run at a higher effort tier (medium/high) or with a longer --timeout; if you proceed anyway, keep the scope tight and make any partial result's limitations explicit in your final answer.`
      : "";
    return {
      success: true,
      output: `Plan recorded (${plan.steps.length} step${plan.steps.length === 1 ? "" : "s"}, risk: ${plan.riskTier}). `
        + (execParts.length > 0
          ? `Recording a plan is NOT execution. Now CALL the orchestration tools to ${execParts.join(", and ")}. Do NOT write the final answer until those steps have actually run; a tool-free answer after only record_plan does not satisfy this plan.`
          : `Now execute it and make sure the final answer meets the acceptance criteria.`)
        + budgetWarning,
      metadata: { stepCount: plan.steps.length, riskTier: plan.riskTier, wide: plan.wide, ...(budgetWarning ? { budgetWarning: true } : {}) },
    };
  },
});

/**
 * Returns a ToolResult to short-circuit the tool when the plan was not approved
 * (denied / timed out / channel missing-but-required-to-pause), or null to let
 * the orchestrator proceed (approved, or approval not required).
 */
async function maybeRequestPlanApproval(plan: TurnPlan, ctx: ToolContext, width: number): Promise<ToolResult | null> {
  const planApproval = getConfig().orchestration?.planApproval ?? false;
  if (!planApproval || (plan.riskTier !== "high" && !plan.wide)) return null;

  // No approval channel (e.g. autonomous scene) — proceed rather than block.
  if (!ctx.approvalCallback) return null;

  logAudit("plan_approval_requested", {
    agentName: ctx.currentAgentName ?? "main",
    riskTier: plan.riskTier,
    wide: plan.wide,
    parallelWidth: width,
    steps: plan.steps.length,
  }, { sessionId: ctx.sessionId, severity: "warn" });

  let approved: boolean;
  try {
    approved = await ctx.approvalCallback("record_plan", {
      summary: "Approve this plan before the swarm executes it?",
      riskTier: plan.riskTier,
      wide: plan.wide,
      plan: renderTurnPlan(plan),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const timedOut = /timed out/i.test(message);
    logAudit("plan_approval_resolved", { outcome: timedOut ? "timeout" : "denied" }, { sessionId: ctx.sessionId, severity: "warn" });
    return {
      success: true,
      output: timedOut
        ? "Plan approval timed out. I have NOT executed this high-stakes plan. Tell me to proceed as-is, or what to change, and I will continue."
        : "The operator did not approve this plan, so I have NOT executed it. Revise it to address their concern, or ask the user what to change before proceeding.",
      metadata: { approved: false, timedOut },
    };
  }

  logAudit("plan_approval_resolved", { outcome: approved ? "approved" : "denied" }, { sessionId: ctx.sessionId, severity: approved ? "info" : "warn" });
  if (!approved) {
    return {
      success: true,
      output: "The operator did not approve this plan, so I have NOT executed it. Revise it to address their concern, or ask the user what to change before proceeding.",
      metadata: { approved: false },
    };
  }
  return null; // approved → proceed
}
