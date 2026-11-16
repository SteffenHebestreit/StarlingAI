/**
 * Caller-supplied workflow parameters are untrusted input.
 *
 * A scene's task text is operator-authored, so scene and job runs execute on channel "scene",
 * which the input guardrail trusts: prompt-injection patterns there are noted, not blocked
 * (agent/turn-prepare.ts), because a scene's own security instructions trip the scanner. The
 * parameters a caller passes into such a run are not operator-authored, yet they are substituted
 * into that trusted task text: `/job` and `/run` from chat, the REST run routes, an MCP `scene__`
 * call and a channel trigger's captured message. Each of those entry points screens the values it
 * was handed here, as the untrusted input they are, before any template is applied, and queues
 * nothing when one is refused.
 *
 * Only the values the run puts into task text are screened (`taskParams`): a value under a name no
 * task reads reaches no model, so a channel trigger's whole message, a sender id or a REST body
 * key that no template reads does not refuse the run. The check is the untrusted input scanner's
 * without its repetition limit: that limit is a heuristic for a padded message, not for injected
 * instructions, a code banner or a markdown table rule trips it, and a queued scene or job run
 * still applies it to its whole task. The length limit stays: it also bounds what the pattern scan
 * costs.
 *
 * Values the configuration declares are not screened: a scene param's default, a job step's
 * `params`, a channel trigger's `params` and a cron trigger's `params` are as operator-authored as
 * the task itself. The run as a whole stays trusted; only what the caller supplied is screened.
 */
import { logAudit } from "../audit/logger.js";
import { getScene } from "../credentials/scenes.js";
import { checkInput } from "./input.js";

/** The parameter names a template reads: its `{{name}}` and `{{name|default}}` placeholders, as every scene and job template is filled. */
export function templateParamNames(template: string): Set<string> {
  return new Set(Array.from(template.matchAll(/\{\{(\w+)(?:\|[^}]*)?\}\}/g), (match) => match[1]!));
}

/**
 * The run parameters a job puts into its step tasks, as credentials/jobs.ts resolveStep templates
 * them: a name a step's `params` template reads, under a param name the step's scene task reads. A
 * run parameter reaches a task no other way. A step whose scene is unknown adds nothing
 * (resolveJobSteps refuses the job).
 */
export function jobTaskParams(job: { steps: ReadonlyArray<{ scene: string; params?: Record<string, string> }> }): Set<string> {
  const names = new Set<string>();
  for (const step of job.steps) {
    const scene = getScene(step.scene);
    if (!scene) continue;
    const taskReads = templateParamNames(scene.task);
    for (const [param, template] of Object.entries(step.params ?? {})) {
      if (!taskReads.has(param)) continue;
      for (const name of templateParamNames(template)) names.add(name);
    }
  }
  return names;
}

/** The entry point that received the values. */
export type WorkflowParamSource = "rpc" | "rest" | "mcp" | "channel";

export interface WorkflowParamScreenContext {
  source: WorkflowParamSource;
  /** The scene or job the values were meant for. */
  workflow: string;
  /**
   * The names whose values the run puts into task text: a scene task's placeholders
   * (templateParamNames), a job's step tasks' (jobTaskParams). A value under any other name is not
   * screened. Absent, every value is.
   */
  taskParams?: ReadonlySet<string>;
  /** Attribution for the audit entry, when the entry point knows it. */
  sessionId?: string;
  userId?: string;
  channel?: string;
}

export type WorkflowParamScreenResult =
  | { ok: true }
  | { ok: false; param: string; reason: string };

/**
 * Screens every caller-supplied value the run puts into task text with the untrusted input
 * scanner. The first refused value ends the screening: the refusal names the parameter and the
 * scanner's reason, and is audited as `workflow_param_blocked` with the parameter's name and the
 * matched patterns, never its value (the value is the injection attempt).
 */
export function screenWorkflowParams(
  params: Record<string, string>,
  ctx: WorkflowParamScreenContext,
): WorkflowParamScreenResult {
  for (const [param, value] of Object.entries(params)) {
    if (ctx.taskParams && !ctx.taskParams.has(param)) continue;
    const check = checkInput(value, { trusted: false, repetitionLimit: false });
    if (check.allowed) continue;
    const reason = check.reason ?? "Prompt injection detected";
    logAudit("workflow_param_blocked", {
      source: ctx.source,
      workflow: ctx.workflow,
      param,
      reason,
      ...(check.detectedPatterns ? { patterns: check.detectedPatterns } : {}),
    }, {
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
      ...(ctx.userId ? { userId: ctx.userId } : {}),
      ...(ctx.channel ? { channel: ctx.channel } : {}),
      severity: "warn",
    });
    return { ok: false, param, reason };
  }
  return { ok: true };
}

/** A refusal as one sentence for the caller. */
export function workflowParamRefusalMessage(workflow: string, refusal: { param: string; reason: string }): string {
  return `Parameter "${refusal.param}" for ${workflow} was refused: ${refusal.reason}. Nothing was run.`;
}
