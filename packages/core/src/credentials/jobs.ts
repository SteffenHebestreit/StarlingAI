import { getCredential, setCredential, deleteCredential, listCredentialNames } from "./store.js";
import { getConfig } from "../config/loader.js";
import {
  JobConfigSchema,
  type JobConfig,
  type JobStepConfig,
  type JobTriggerConfig,
} from "../config/schema.js";
import { getScene } from "./scenes.js";
import { childLogger } from "../logger.js";

const log = childLogger("credentials:jobs");

const JOB_DEFINITION_KEY = (name: string) => `job:${name}:definition`;

export interface JobSummary extends JobConfig {
  name: string;
  source: "config" | "store";
}

export interface JobInput extends JobConfig {}

export interface ResolvedJobStep {
  sceneName: string;
  label: string;
  task: string;
  params?: Record<string, string>;
  allowedAgents?: string[];
  humanInLoopSteps?: string[];
  approvalChannel?: string;
}

export function listAllJobs(): JobSummary[] {
  const results: JobSummary[] = [];
  const seen = new Set<string>();

  const config = getConfig();
  for (const [name, job] of Object.entries(config.jobs ?? {})) {
    seen.add(name);
    results.push({
      name,
      source: "config",
      description: job.description,
      params: job.params,
      steps: job.steps,
      triggers: job.triggers,
    });
  }

  for (const key of listCredentialNames()) {
    if (!key.startsWith("job:") || !key.endsWith(":definition")) continue;
    const name = key.slice("job:".length, -":definition".length);
    if (seen.has(name)) continue;
    const raw = getCredential(JOB_DEFINITION_KEY(name));
    if (!raw) continue;
    try {
      const parsed = JobConfigSchema.parse(JSON.parse(raw) as unknown);
      results.push({ name, source: "store", ...parsed });
    } catch (err) {
      log.warn({ err, name }, "Ignoring invalid stored job definition");
    }
  }

  return results;
}

export function getJobDefinition(name: string): JobSummary | null {
  const configJob = getConfig().jobs?.[name];
  if (configJob) {
    return {
      name,
      source: "config",
      description: configJob.description,
      params: configJob.params,
      steps: configJob.steps,
      triggers: configJob.triggers,
    };
  }

  const raw = getCredential(JOB_DEFINITION_KEY(name));
  if (!raw) return null;
  try {
    return {
      name,
      source: "store",
      ...JobConfigSchema.parse(JSON.parse(raw) as unknown),
    };
  } catch (err) {
    log.warn({ err, name }, "Invalid stored job definition");
    return null;
  }
}

export function saveJobDefinition(name: string, input: JobInput): void {
  if (!name.match(/^[a-z0-9_-]+$/i)) {
    throw new Error("Job name must only contain letters, numbers, underscores, and hyphens");
  }
  const normalized = JobConfigSchema.parse(input);
  setCredential(JOB_DEFINITION_KEY(name), JSON.stringify(normalized));
  log.info({ name }, "Job saved to store");
}

export function deleteJobDefinition(name: string): void {
  deleteCredential(JOB_DEFINITION_KEY(name));
  log.info({ name }, "Job deleted from store");
}

export function resolveJobSteps(job: Pick<JobSummary, "name" | "params" | "steps">, overrides: Record<string, string> = {}): ResolvedJobStep[] {
  const mergedJobParams: Record<string, string> = {};
  for (const [key, def] of Object.entries(job.params ?? {})) {
    if (def.default !== undefined) mergedJobParams[key] = def.default;
  }
  Object.assign(mergedJobParams, overrides);

  return job.steps.map((step, index) => resolveStep(step, index, mergedJobParams));
}

export function getApiWebhookKeys(job: JobSummary): string[] {
  return (job.triggers ?? [])
    .filter((trigger): trigger is Extract<JobTriggerConfig, { type: "api" }> => trigger.type === "api")
    .map((trigger) => trigger.webhookKey)
    .filter((key): key is string => typeof key === "string" && key.length >= 16);
}

export function getCronTriggers(job: JobSummary): Array<{ key: string; expression: string; params?: Record<string, string> }> {
  return (job.triggers ?? [])
    .map((trigger, index) => ({ trigger, index }))
    .filter(isEnabledCronTrigger)
    .map(({ trigger, index }) => ({
      key: `${job.name}:${index}`,
      expression: trigger.expression,
      params: trigger.params,
    }));
}

export function getChannelTriggers(job: JobSummary): Array<Extract<JobTriggerConfig, { type: "channel" }>> {
  return (job.triggers ?? []).filter(
    (trigger): trigger is Extract<JobTriggerConfig, { type: "channel" }> => trigger.type === "channel",
  );
}

function isEnabledCronTrigger(
  value: { trigger: JobTriggerConfig; index: number },
): value is { trigger: Extract<JobTriggerConfig, { type: "cron" }>; index: number } {
  return value.trigger.type === "cron" && value.trigger.enabled !== false;
}

function resolveStep(step: JobStepConfig, index: number, jobParams: Record<string, string>): ResolvedJobStep {
  const scene = getScene(step.scene);
  if (!scene) {
    throw new Error(`Job step references unknown scene: ${step.scene}`);
  }

  const mergedSceneParams: Record<string, string> = {};
  for (const [key, def] of Object.entries(scene.params ?? {})) {
    if (def.default !== undefined) mergedSceneParams[key] = def.default;
  }
  for (const [key, value] of Object.entries(step.params ?? {})) {
    mergedSceneParams[key] = applyTemplate(value, jobParams);
  }

  return {
    sceneName: scene.name,
    label: step.label?.trim() || scene.description || `Step ${index + 1}`,
    task: applyTemplate(scene.task, mergedSceneParams),
    params: Object.keys(mergedSceneParams).length > 0 ? mergedSceneParams : undefined,
    allowedAgents: scene.allowedAgents,
    humanInLoopSteps: scene.humanInLoopSteps,
    approvalChannel: scene.approvalChannel,
  };
}

function applyTemplate(template: string, params: Record<string, string>): string {
  return template.replace(/\{\{(\w+)(?:\|([^}]*))?\}\}/g, (match, key: string, defaultVal?: string) => {
    if (key in params) return params[key] ?? "";
    if (defaultVal !== undefined) return defaultVal;
    return match;
  });
}