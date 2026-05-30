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
import { normalizeTurnPlan, persistTurnPlan, countParallelWidth } from "../agent/turn-plan.js";

const log = childLogger("tool:record_plan");

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

    return {
      success: true,
      output: `Plan recorded (${plan.steps.length} step${plan.steps.length === 1 ? "" : "s"}, risk: ${plan.riskTier}). `
        + `Now execute it: prefer reuse steps first, keep fan-out to genuinely independent work, and make sure the final answer meets the acceptance criteria.`,
      metadata: { stepCount: plan.steps.length, riskTier: plan.riskTier, wide: plan.wide },
    };
  },
});
