import { createJob } from "../agent/jobs.js";
import { listAllJobs, getCronTriggers, resolveJobSteps } from "../credentials/jobs.js";
import { createCronJob, removeCronJob } from "./scheduler.js";
import { childLogger } from "../logger.js";

const log = childLogger("runtime:job-triggers");
const configuredCronSchedules = new Map<string, string>();

export function syncConfiguredJobTriggers(turnTimeoutMs: number): void {
  const staleKeys = new Set(configuredCronSchedules.keys());

  for (const job of listAllJobs()) {
    for (const trigger of getCronTriggers(job)) {
      staleKeys.delete(trigger.key);
      const previousScheduleId = configuredCronSchedules.get(trigger.key);
      if (previousScheduleId) {
        removeCronJob(previousScheduleId);
      }

      const schedule = createCronJob(
        trigger.expression,
        `job:${job.name}`,
        `Run configured job ${job.name}`,
        async () => {
          const steps = resolveJobSteps(job, trigger.params ?? {});
          const queued = await createJob({
            sceneName: job.name,
            definitionType: "job",
            userId: `job:${job.name}`,
            steps,
            turnTimeoutMs,
          });
          log.info({ jobName: job.name, triggerKey: trigger.key, queuedJobId: queued.id }, "Configured cron trigger queued job run");
        },
      );

      configuredCronSchedules.set(trigger.key, schedule.id);
    }
  }

  for (const key of staleKeys) {
    const scheduleId = configuredCronSchedules.get(key);
    if (scheduleId) removeCronJob(scheduleId);
    configuredCronSchedules.delete(key);
  }
}
