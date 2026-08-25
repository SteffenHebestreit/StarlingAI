/**
 * run_tool_pipeline — declarative, host-side batch tool execution.
 *
 * Collapses several tool calls that the model would otherwise make over many
 * round-trips into a single call, cutting the per-step context overhead of
 * observe→decide→call loops. A later step can reference an earlier step's output
 * via `{{steps.<id>.output}}` templating, so simple read→transform→write chains
 * run without returning to the model between steps.
 *
 * Security: this does NOT execute arbitrary code and does NOT open a channel out
 * of the sandbox. Every step is dispatched through the normal `executeTool`
 * path, so each sub-call keeps its tier check, per-call approval gate, sandbox
 * requirement, and audit span. The pipeline only batches — it cannot escalate.
 * Orchestration/delegation tools are blocked as steps to prevent fan-out
 * amplification and recursion. Opt-in via `toolPipeline.enabled`.
 */

import { registerTool, executeTool, type ToolContext, type ToolResult } from "./registry.js";
import { getConfig } from "../config/loader.js";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";

const log = childLogger("tool:pipeline");

/** Tools that must not run as pipeline steps — they fan out or recurse. */
export const BLOCKED_STEP_TOOLS = new Set<string>([
  "run_tool_pipeline",
  // Fans out exactly like the rest of this list, and nests: a plan whose step runs a pipeline
  // whose step runs the plan re-enters with the same pending step until the turn gives out.
  "execute_plan",
  "delegate_to_agent",
  "parallel_delegate",
  "swarm_delegate",
  "run_task_graph",
  "run_workflow",
  "create_ephemeral_agent",
]);

export interface PipelineStep {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface StepRecord {
  id: string;
  tool: string;
  success: boolean;
  output: string;
  error?: string;
}

export interface RunPipelineDeps {
  /** Guarded tool dispatch — production passes executeTool(name, args, ctx). */
  execute: (tool: string, args: Record<string, unknown>) => Promise<ToolResult>;
  stopOnError: boolean;
  maxTemplateOutputChars: number;
  /**
   * Tools the caller is allowed to use this turn. When provided, a step naming a
   * tool outside this set is rejected — so the pipeline cannot reach tools the
   * agent was not granted (executeTool only checks tier, not the per-agent
   * allowlist). Undefined means "not scoped" (no extra restriction).
   */
  allowedTools?: Set<string>;
  signal?: AbortSignal;
}

export interface RunPipelineResult {
  records: StepRecord[];
  aborted: boolean;
}

/** Pure pipeline core — sequential execution, templating, blocking, abort. */
export async function runPipeline(steps: PipelineStep[], deps: RunPipelineDeps): Promise<RunPipelineResult> {
  const records: StepRecord[] = [];
  let aborted = false;

  for (const step of steps) {
    if (deps.signal?.aborted) {
      aborted = true;
      break;
    }
    if (BLOCKED_STEP_TOOLS.has(step.tool)) {
      records.push({ id: step.id, tool: step.tool, success: false, output: "", error: `Tool '${step.tool}' is not allowed inside a pipeline.` });
      if (deps.stopOnError) break;
      continue;
    }
    if (deps.allowedTools && !deps.allowedTools.has(step.tool)) {
      records.push({ id: step.id, tool: step.tool, success: false, output: "", error: `Tool '${step.tool}' is not in this agent's allowed tool set.` });
      if (deps.stopOnError) break;
      continue;
    }

    const resolvedArgs = substituteTemplates(step.args, records, deps.maxTemplateOutputChars);
    const result = await deps.execute(step.tool, resolvedArgs);
    records.push({
      id: step.id,
      tool: step.tool,
      success: result.success,
      output: result.output ?? "",
      error: result.error,
    });

    if (!result.success && deps.stopOnError) break;
  }

  return { records, aborted };
}

registerTool({
  name: "run_tool_pipeline",
  description:
    "Run several tool calls in one step instead of separate round-trips. Provide steps "
    + "[{id, tool, args}]; a later step's args may reference an earlier output via "
    + "{{steps.<id>.output}}. Use for simple read→transform→write chains of primitive tools. "
    + "Delegation/workflow tools are not allowed as steps.",
  parameters: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        description: "Ordered tool calls to execute.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Short id for referencing this step's output." },
            tool: { type: "string", description: "Tool name to invoke." },
            args: { type: "object", description: "Arguments for the tool." },
          },
          required: ["tool"],
        },
      },
      stopOnError: { type: "boolean", description: "Stop the pipeline at the first failing step. Default: true." },
    },
    required: ["steps"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const config = getConfig().toolPipeline;
    if (!config.enabled) {
      return { success: false, output: "", error: "run_tool_pipeline is disabled. Set toolPipeline.enabled = true in config." };
    }

    const parsed = parseSteps(args["steps"], config.maxSteps);
    if (typeof parsed === "string") return { success: false, output: "", error: parsed };
    const steps = parsed;
    const stopOnError = args["stopOnError"] !== false;

    const { records, aborted } = await runPipeline(steps, {
      execute: (tool, stepArgs) => executeTool(tool, stepArgs, ctx),
      stopOnError,
      maxTemplateOutputChars: config.maxTemplateOutputChars,
      // Scope steps to the caller's grant (executeTool only checks tier). The
      // pipeline tool itself is excluded so it can't be nested via the allowlist.
      allowedTools: ctx.allowedTools ? new Set(ctx.allowedTools) : undefined,
      signal: ctx.signal,
    });

    const succeeded = records.filter((r) => r.success).length;
    logAudit("tool_pipeline_executed", {
      requestedSteps: steps.length,
      executedSteps: records.length,
      succeeded,
      aborted,
      tools: steps.map((s) => s.tool),
    }, { sessionId: ctx.sessionId, severity: "info" });
    log.info({ requested: steps.length, executed: records.length, succeeded }, "run_tool_pipeline");

    const blocks = records.map((r) =>
      `### ${r.id} — ${r.tool} ${r.success ? "✓" : "✗"}\n${r.success ? r.output : `ERROR: ${r.error ?? "failed"}`}`,
    );
    const summary = `Pipeline executed ${records.length}/${steps.length} step(s), ${succeeded} succeeded${aborted ? " (aborted: signal)" : ""}.`;
    const allOk = records.length === steps.length && succeeded === records.length && !aborted;

    return {
      success: allOk,
      output: [summary, "", ...blocks].join("\n\n"),
      error: allOk ? undefined : summary,
      metadata: {
        requestedSteps: steps.length,
        executedSteps: records.length,
        succeeded,
        steps: records.map((r) => ({ id: r.id, tool: r.tool, success: r.success })),
      },
    };
  },
});

export function parseSteps(raw: unknown, maxSteps: number): PipelineStep[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return "steps must be a non-empty array";
  if (raw.length > maxSteps) return `Too many steps (${raw.length}); maximum is ${maxSteps}.`;

  const steps: PipelineStep[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i] as Record<string, unknown> | null;
    if (!entry || typeof entry !== "object") return `step ${i} is not an object`;
    const tool = typeof entry["tool"] === "string" ? entry["tool"].trim() : "";
    if (!tool) return `step ${i} is missing a tool name`;
    const id = typeof entry["id"] === "string" && entry["id"].trim() ? entry["id"].trim() : `step${i + 1}`;
    if (seenIds.has(id)) return `duplicate step id '${id}'`;
    seenIds.add(id);
    const argsValue = entry["args"];
    const stepArgs = argsValue && typeof argsValue === "object" && !Array.isArray(argsValue)
      ? (argsValue as Record<string, unknown>)
      : {};
    steps.push({ id, tool, args: stepArgs });
  }
  return steps;
}

/** Replace `{{steps.<id>.output}}` references in string args with prior outputs. */
export function substituteTemplates(
  args: Record<string, unknown>,
  records: StepRecord[],
  maxChars: number,
): Record<string, unknown> {
  const byId = new Map(records.map((r) => [r.id, r]));
  const replaceIn = (value: unknown): unknown => {
    if (typeof value === "string") {
      return value.replace(/\{\{steps\.([A-Za-z0-9_]+)\.output\}\}/g, (match, id: string) => {
        const rec = byId.get(id);
        if (!rec) return match;
        return rec.output.slice(0, maxChars);
      });
    }
    if (Array.isArray(value)) return value.map(replaceIn);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = replaceIn(v);
      return out;
    }
    return value;
  };
  return replaceIn(args) as Record<string, unknown>;
}
