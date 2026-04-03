import { createJob } from "../agent/jobs.js";
import { getConfig } from "../config/loader.js";
import type { JobTriggerConfig } from "../config/schema.js";
import type { ChannelType } from "../credentials/channels.js";
import { getChannelTriggers, listAllJobs, resolveJobSteps } from "../credentials/jobs.js";
import { childLogger } from "../logger.js";

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

      const params: Record<string, string> = {
        ...(trigger.params ?? {}),
        channel: ctx.channel,
        senderId: ctx.senderId,
        sender_id: ctx.senderId,
        message: ctx.text,
      };

      if (trigger.captureMessageAs) {
        params[trigger.captureMessageAs] = ctx.text;
      }
      if (trigger.captureRemainderAs && match.remainder !== undefined) {
        params[trigger.captureRemainderAs] = match.remainder;
      }
      if (trigger.parseParams !== false && match.remainder) {
        Object.assign(params, parseChannelTriggerKeyValuePairs(match.remainder));
      }

      const steps = resolveJobSteps(job, params);
      const queued = await createJob({
        sceneName: job.name,
        definitionType: "job",
        userId: `${ctx.channel}:${ctx.senderId}`,
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