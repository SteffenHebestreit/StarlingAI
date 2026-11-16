import { createJob } from "../agent/jobs.js";
import { getConfig } from "../config/loader.js";
import type { JobTriggerConfig } from "../config/schema.js";
import type { ChannelType } from "../credentials/channels.js";
import { getChannelTriggers, listAllJobs, resolveJobSteps } from "../credentials/jobs.js";
import { jobTaskParams, screenWorkflowParams, workflowParamRefusalMessage } from "../guardrails/workflow-params.js";
import { childLogger } from "../logger.js";
import { principalIdentity } from "../runtime/user-scope.js";

const log = childLogger("channels:job-triggers");

type InboundJobTriggerChannel = Exclude<ChannelType, "webchat">;

export interface ChannelJobTriggerContext {
  channel: InboundJobTriggerChannel;
  senderId: string;
  text: string;
}

export interface ChannelJobTriggerDispatchResult {
  matched: boolean;
  jobName?: string;
  jobId?: string;
  responseText?: string;
}

function applyTemplate(template: string, params: Record<string, string>): string {
  return template.replace(/\{\{(\w+)(?:\|([^}]*))?\}\}/g, (match, key: string, defaultVal?: string) => {
    if (key in params) return params[key] ?? "";
    if (defaultVal !== undefined) return defaultVal;
    return match;
  });
}

export function parseChannelTriggerKeyValuePairs(raw: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const match of raw.matchAll(/(\w+)=("(?:[^"\\]|\\.)*"|\S+)/g)) {
    params[match[1]!] = (match[2] ?? "").replace(/^"|"$/g, "").replace(/\\"/g, '"');
  }
  return params;
}

export function matchChannelTrigger(
  trigger: Extract<JobTriggerConfig, { type: "channel" }>,
  ctx: ChannelJobTriggerContext,
): { matched: boolean; remainder?: string } {
  if (trigger.channels?.length && !trigger.channels.includes(ctx.channel)) {
    return { matched: false };
  }

  const text = ctx.text.trim();
  const pattern = trigger.pattern.trim();
  if (!text || !pattern) return { matched: false };

  const source = trigger.ignoreCase !== false ? text.toLowerCase() : text;
  const needle = trigger.ignoreCase !== false ? pattern.toLowerCase() : pattern;

  switch (trigger.mode) {
    case "exact":
      return source === needle ? { matched: true, remainder: "" } : { matched: false };
    case "contains": {
      const index = source.indexOf(needle);
      return index >= 0 ? { matched: true, remainder: text.slice(index + pattern.length).trim() } : { matched: false };
    }
    case "regex": {
      try {
        const expression = new RegExp(pattern, trigger.ignoreCase !== false ? "i" : undefined);
        const match = text.match(expression);
        if (!match) return { matched: false };
        const namedRemainder = typeof match.groups?.["remainder"] === "string" ? match.groups["remainder"] : undefined;
        return { matched: true, remainder: (namedRemainder ?? match[1] ?? "").trim() };
      } catch (err) {
        log.warn({ err, pattern }, "Ignoring invalid channel job trigger regex");
        return { matched: false };
      }
    }
    case "prefix":
    default:
      return source.startsWith(needle) ? { matched: true, remainder: text.slice(pattern.length).trim() } : { matched: false };
  }
}

export async function dispatchChannelTriggeredJob(
  ctx: ChannelJobTriggerContext,
): Promise<ChannelJobTriggerDispatchResult> {
  const turnTimeoutMs = getConfig().gateway.turnTimeoutMs;

  for (const job of listAllJobs()) {
    for (const trigger of getChannelTriggers(job)) {
      const match = matchChannelTrigger(trigger, ctx);
      if (!match.matched) continue;

      // What the sender supplied: their id, their message and what is captured or parsed from it.
      // Untrusted input: what the job's scene tasks read of it is screened before it is templated
      // into them. The trigger's own `params` are configuration and are not.
      const supplied: Record<string, string> = {
        senderId: ctx.senderId,
        sender_id: ctx.senderId,
        message: ctx.text,
      };
      if (trigger.captureMessageAs) {
        supplied[trigger.captureMessageAs] = ctx.text;
      }
      if (trigger.captureRemainderAs && match.remainder !== undefined) {
        supplied[trigger.captureRemainderAs] = match.remainder;
      }
      if (trigger.parseParams !== false && match.remainder) {
        Object.assign(supplied, parseChannelTriggerKeyValuePairs(match.remainder));
      }
      const params: Record<string, string> = {
        ...(trigger.params ?? {}),
        channel: ctx.channel,
        ...supplied,
      };

      const screen = screenWorkflowParams(supplied, {
        source: "channel",
        workflow: job.name,
        taskParams: jobTaskParams(job),
        channel: ctx.channel,
        userId: ctx.senderId,
      });
      if (!screen.ok) {
        log.warn({ channel: ctx.channel, senderId: ctx.senderId, jobName: job.name, param: screen.param }, "Refused a channel-triggered job: a parameter failed the input guardrail");
        // The message is handled: the job is not queued, and it does not go on to a chat turn.
        return {
          matched: true,
          jobName: job.name,
          responseText: trigger.silent ? undefined : workflowParamRefusalMessage(job.name, screen),
        };
      }

      const steps = resolveJobSteps(job, params);
      const queued = await createJob({
        sceneName: job.name,
        definitionType: "job",
        ...principalIdentity(`${ctx.channel}:${ctx.senderId}`, "synthetic"),
        steps,
        turnTimeoutMs,
      });

      const responseParams = {
        ...params,
        jobName: job.name,
        jobId: queued.id,
        remainder: match.remainder ?? "",
      };

      log.info({ channel: ctx.channel, senderId: ctx.senderId, jobName: job.name, jobId: queued.id }, "Queued job from channel trigger");

      return {
        matched: true,
        jobName: job.name,
        jobId: queued.id,
        responseText: trigger.silent
          ? undefined
          : trigger.replyText
            ? applyTemplate(trigger.replyText, responseParams)
            : `Queued job ${job.name} as ${queued.id}. Track progress in Jobs.`,
      };
    }
  }

  return { matched: false };
}