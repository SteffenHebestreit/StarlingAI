import { randomUUID } from "node:crypto";
import type { SwarmState } from "../tools/registry.js";
import type { InterventionNotice } from "./interventions.js";
import { createSession, endSession } from "./session.js";
import { archiveSession } from "./session.js";
import { runTurn, type TurnOutput, type TurnPerformanceMetrics } from "./runtime.js";
import {
  claimNextJob,
  completeJob,
  failJob,
  getJob,
  heartbeatJob,
  initSceneJobStore,
  markJobCancelled,
  recoverStaleSceneJobs,
  updateJobProgress,
  type ClaimedSceneJob,
  type SceneJobProgress,
} from "./jobs.js";
import { requestApprovalViaChannel } from "../approval/index.js";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";
import { publishNotification } from "../runtime/notifications.js";

const log = childLogger("agent:scene-worker");
const POLL_INTERVAL_MS = 1_000;
const MONITOR_INTERVAL_MS = 5_000;
const STALE_JOB_MS = 120_000;

interface ActiveSceneJob {
  controller: AbortController;
  completion: Promise<void>;
}

const workerId = `scene-worker-${process.pid}-${randomUUID().slice(0, 8)}`;
const activeJobs = new Map<string, ActiveSceneJob>();
let pumpTimer: ReturnType<typeof setInterval> | null = null;
let monitorTimer: ReturnType<typeof setInterval> | null = null;
let pumping = false;

export async function startSceneJobWorker(): Promise<void> {
  if (pumpTimer || monitorTimer) return;
  await initSceneJobStore();
  await recoverStaleSceneJobs(STALE_JOB_MS);

  pumpTimer = setInterval(() => {
    void pumpQueue();
  }, POLL_INTERVAL_MS);
  pumpTimer.unref();

  monitorTimer = setInterval(() => {
    void monitorActiveJobs();
  }, MONITOR_INTERVAL_MS);
  monitorTimer.unref();

  await pumpQueue();
  log.info({ workerId, concurrency: resolveWorkerConcurrency() }, "Scene job worker started");
}

export async function stopSceneJobWorker(): Promise<void> {
  if (pumpTimer) {
    clearInterval(pumpTimer);
    pumpTimer = null;
  }
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }

  const completions = [...activeJobs.values()].map(active => {
    if (!active.controller.signal.aborted) active.controller.abort("shutdown");
    return active.completion;
  });
  await Promise.allSettled(completions);
  activeJobs.clear();
}

export async function runSceneJobWorkerTick(): Promise<boolean> {
  await initSceneJobStore();
  return pumpQueue();
}

export function getSceneJobWorkerStatus(): { workerId: string; activeJobs: number; concurrency: number; running: boolean } {
  return {
    workerId,
    activeJobs: activeJobs.size,
    concurrency: resolveWorkerConcurrency(),
    running: pumpTimer !== null,
  };
}

async function pumpQueue(): Promise<boolean> {
  if (pumping) return false;
  pumping = true;
  let startedJob = false;

  try {
    while (activeJobs.size < resolveWorkerConcurrency()) {
      const job = await claimNextJob(workerId);
      if (!job) break;
      startedJob = true;
      startJob(job);
    }
  } finally {
    pumping = false;
  }

  return startedJob;
}

function startJob(job: ClaimedSceneJob): void {
  const controller = new AbortController();
  const completion = processJob(job, controller).finally(() => {
    activeJobs.delete(job.id);
  });
  activeJobs.set(job.id, { controller, completion });
}

async function monitorActiveJobs(): Promise<void> {
  if (activeJobs.size === 0) return;
  await recoverStaleSceneJobs(STALE_JOB_MS);

  await Promise.allSettled([...activeJobs.entries()].map(async ([jobId, active]) => {
    await heartbeatJob(jobId, workerId);
    const job = await getJob(jobId);
    if (job?.status === "cancelling" && !active.controller.signal.aborted) {
      active.controller.abort("cancelled");
    }
  }));
}

async function processJob(job: ClaimedSceneJob, controller: AbortController): Promise<void> {
  const session = createSession({
    sessionId: job.sessionId,
    channel: "scene",
    userId: job.userId ?? `scene:${job.sceneName}`,
  });

  const counters = {
    toolCallsRequested: job.progress.toolCallsRequested,
    toolCallsCompleted: job.progress.toolCallsCompleted,
    approvalsRequested: job.progress.approvalsRequested,
    subAgentsStarted: job.progress.subAgentsStarted,
  };

  const turnTimeoutMs = Math.max(1_000, job.payload.turnTimeoutMs);
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    controller.abort("timeout");
  }, turnTimeoutMs);
  timeoutHandle.unref();

  await safeProgressUpdate(job.id, {
    stage: "running",
    message: job.payload.steps?.length ? "Job workflow running" : "Scene job running",
    percent: 5,
    totalSteps: job.payload.steps?.length ?? 0,
    completedSteps: 0,
    currentStep: job.payload.steps?.[0]?.label,
    lastEventAt: new Date().toISOString(),
    lastEventType: "job_started",
  });

  try {
    const output = job.payload.steps?.length
      ? await runWorkflowJob(job, session, controller, counters)
      : await runSingleSceneJob(job, session, controller, counters);

    const current = await getJob(job.id);
    if (current?.status === "cancelling" || (controller.signal.aborted && !timedOut)) {
      await markJobCancelled(job.id, "Scene job cancelled by operator");
      logAudit("scene_job_cancelled", {
        jobId: job.id,
        sceneName: job.sceneName,
        reason: "cancelled_by_operator",
      }, {
        sessionId: session.id,
        channel: "scene",
        severity: "warn",
      });
      return;
    }

    await completeJob(job.id, output);
    logAudit("scene_job_completed", {
      jobId: job.id,
      sceneName: job.sceneName,
      status: output.blocked ? "failed" : "completed",
      responseLength: output.response.length,
      toolCallsExecuted: output.toolCallsExecuted,
      blocked: output.blocked,
      ...(output.performance ?? {}),
    }, {
      sessionId: session.id,
      channel: "scene",
      severity: output.blocked ? "warn" : "info",
    });
  } catch (err) {
    const current = await getJob(job.id);
    if (timedOut) {
      const error = `Scene timed out after ${Math.round(turnTimeoutMs / 60000)} minutes`;
      await failJob(job.id, error);
      logAudit("scene_job_failed", {
        jobId: job.id,
        sceneName: job.sceneName,
        error,
      }, {
        sessionId: session.id,
        channel: "scene",
        severity: "error",
      });
    } else if (current?.status === "cancelling" || controller.signal.aborted) {
      await markJobCancelled(job.id, "Scene job cancelled by operator");
      logAudit("scene_job_cancelled", {
        jobId: job.id,
        sceneName: job.sceneName,
        reason: "cancelled_by_operator",
      }, {
        sessionId: session.id,
        channel: "scene",
        severity: "warn",
      });
    } else {
      const error = err instanceof Error ? err.message : String(err);
      await failJob(job.id, error);
      logAudit("scene_job_failed", {
        jobId: job.id,
        sceneName: job.sceneName,
        error,
      }, {
        sessionId: session.id,
        channel: "scene",
        severity: "error",
      });
      log.error({ err, jobId: job.id, sceneName: job.sceneName }, "Scene job failed");
    }
  } finally {
    clearTimeout(timeoutHandle);
    archiveSession(session.id);
  }
}

async function runSingleSceneJob(
  job: ClaimedSceneJob,
  session: ReturnType<typeof createSession>,
  controller: AbortController,
  counters: { toolCallsRequested: number; toolCallsCompleted: number; approvalsRequested: number; subAgentsStarted: number },
): Promise<TurnOutput> {
  return runTurn({
    session,
    userMessage: job.payload.task ?? "",
    ...buildTurnHooks(job, controller, counters),
  });
}

async function runWorkflowJob(
  job: ClaimedSceneJob,
  session: ReturnType<typeof createSession>,
  controller: AbortController,
  counters: { toolCallsRequested: number; toolCallsCompleted: number; approvalsRequested: number; subAgentsStarted: number },
): Promise<TurnOutput> {
  const steps = job.payload.steps ?? [];
  const outputs: TurnOutput[] = [];

  for (const [index, step] of steps.entries()) {
    if (controller.signal.aborted) break;

    await safeProgressUpdate(job.id, {
      stage: "step",
      message: `Running step ${index + 1}/${steps.length}: ${step.label}`,
      totalSteps: steps.length,
      completedSteps: index,
      currentStep: step.label,
      percent: Math.max(5, Math.round((index / Math.max(1, steps.length)) * 100)),
      lastEventAt: new Date().toISOString(),
      lastEventType: "job_step_started",
    });

    const output = await runTurn({
      session,
      userMessage: step.task,
      allowedAgents: step.allowedAgents,
      humanInLoopSteps: step.humanInLoopSteps,
      approvalCallback: buildApprovalCallback(job, controller, counters, step.approvalChannel),
      signal: controller.signal,
      ...buildTurnStreamingHooks(job, counters, {
        totalSteps: steps.length,
        completedSteps: index,
        currentStep: step.label,
      }),
    });

    outputs.push(output);

    await safeProgressUpdate(job.id, {
      stage: output.blocked ? "failed" : "step",
      message: output.blocked
        ? `Step ${index + 1}/${steps.length} blocked: ${step.label}`
        : `Completed step ${index + 1}/${steps.length}: ${step.label}`,
      totalSteps: steps.length,
      completedSteps: index + 1,
      currentStep: step.label,
      percent: Math.max(5, Math.min(95, Math.round(((index + 1) / Math.max(1, steps.length)) * 100))),
      lastEventAt: new Date().toISOString(),
      lastEventType: output.blocked ? "job_step_blocked" : "job_step_completed",
    });

    if (output.blocked) {
      return mergeWorkflowOutputs(outputs, steps);
    }
  }

  return mergeWorkflowOutputs(outputs, steps);
}

function buildTurnHooks(
  job: ClaimedSceneJob,
  controller: AbortController,
  counters: { toolCallsRequested: number; toolCallsCompleted: number; approvalsRequested: number; subAgentsStarted: number },
) {
  return {
    allowedAgents: job.payload.allowedAgents,
    humanInLoopSteps: job.payload.humanInLoopSteps,
    approvalCallback: buildApprovalCallback(job, controller, counters),
    signal: controller.signal,
    ...buildTurnStreamingHooks(job, counters),
  };
}

function buildTurnStreamingHooks(
  job: ClaimedSceneJob,
  counters: { toolCallsRequested: number; toolCallsCompleted: number; approvalsRequested: number; subAgentsStarted: number },
  stepMeta?: { totalSteps?: number; completedSteps?: number; currentStep?: string },
) {
  return {
    onToolCall: (_toolCallId: string, name: string) => {
      counters.toolCallsRequested += 1;
      void safeProgressUpdate(job.id, {
        stage: "tool",
        message: `Running tool ${name}`,
        currentTool: name,
        totalSteps: stepMeta?.totalSteps,
        completedSteps: stepMeta?.completedSteps,
        currentStep: stepMeta?.currentStep,
        toolCallsRequested: counters.toolCallsRequested,
        toolCallsCompleted: counters.toolCallsCompleted,
        approvalsRequested: counters.approvalsRequested,
        subAgentsStarted: counters.subAgentsStarted,
        percent: computeRuntimePercent(counters.toolCallsRequested, counters.toolCallsCompleted),
        lastEventAt: new Date().toISOString(),
        lastEventType: "tool_call_requested",
      });
    },
    onToolResult: (_toolCallId: string, name: string) => {
      counters.toolCallsCompleted += 1;
      void safeProgressUpdate(job.id, {
        stage: "tool",
        message: `Completed tool ${name}`,
        currentTool: name,
        totalSteps: stepMeta?.totalSteps,
        completedSteps: stepMeta?.completedSteps,
        currentStep: stepMeta?.currentStep,
        toolCallsRequested: counters.toolCallsRequested,
        toolCallsCompleted: counters.toolCallsCompleted,
        approvalsRequested: counters.approvalsRequested,
        subAgentsStarted: counters.subAgentsStarted,
        percent: computeRuntimePercent(counters.toolCallsRequested, counters.toolCallsCompleted),
        lastEventAt: new Date().toISOString(),
        lastEventType: "tool_call_completed",
      });
    },
    onIntervention: (notice: InterventionNotice) => {
      void safeProgressUpdate(job.id, {
        ...progressFromIntervention(notice, counters),
        totalSteps: stepMeta?.totalSteps,
        completedSteps: stepMeta?.completedSteps,
        currentStep: stepMeta?.currentStep,
      });
    },
    onSwarmState: (state: SwarmState) => {
      void safeProgressUpdate(job.id, {
        ...progressFromSwarmState(state, counters),
        totalSteps: stepMeta?.totalSteps,
        completedSteps: stepMeta?.completedSteps,
        currentStep: stepMeta?.currentStep,
      });
    },
  };
}

function mergeWorkflowOutputs(outputs: TurnOutput[], steps: NonNullable<ClaimedSceneJob["payload"]["steps"]>): TurnOutput {
  const combinedResponse = outputs.map((output, index) => {
    const label = steps[index]?.label ?? `Step ${index + 1}`;
    return `## ${label}\n\n${output.response.trim()}`.trim();
  }).join("\n\n").trim();

  return {
    response: combinedResponse,
    toolCallsExecuted: outputs.reduce((sum, output) => sum + output.toolCallsExecuted, 0),
    guardrailEvents: outputs.flatMap((output) => output.guardrailEvents),
    usage: outputs.reduce((usage, output) => ({
      promptTokens: usage.promptTokens + output.usage.promptTokens,
      completionTokens: usage.completionTokens + output.usage.completionTokens,
      totalTokens: usage.totalTokens + output.usage.totalTokens,
    }), { promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
    blocked: outputs.some((output) => output.blocked),
    swarmState: outputs.at(-1)?.swarmState,
    performance: aggregatePerformance(outputs.map((output) => output.performance).filter((value): value is TurnPerformanceMetrics => Boolean(value))),
  };
}

function aggregatePerformance(metrics: TurnPerformanceMetrics[]): TurnPerformanceMetrics | undefined {
  if (metrics.length === 0) return undefined;
  return {
    turnDurationMs: metrics.reduce((sum, entry) => sum + entry.turnDurationMs, 0),
    firstModelResponseMs: metrics.find((entry) => entry.firstModelResponseMs !== undefined)?.firstModelResponseMs,
    llmCalls: metrics.reduce((sum, entry) => sum + entry.llmCalls, 0),
    llmTimeMs: metrics.reduce((sum, entry) => sum + entry.llmTimeMs, 0),
    toolCallsRequested: metrics.reduce((sum, entry) => sum + entry.toolCallsRequested, 0),
    toolExecutionTimeMs: metrics.reduce((sum, entry) => sum + entry.toolExecutionTimeMs, 0),
    systemPromptChars: metrics.reduce((sum, entry) => sum + entry.systemPromptChars, 0),
    collapsedHistoryMessages: metrics.reduce((sum, entry) => sum + entry.collapsedHistoryMessages, 0),
    collapsedHistoryChars: metrics.reduce((sum, entry) => sum + entry.collapsedHistoryChars, 0),
    promptChars: metrics.reduce((sum, entry) => sum + entry.promptChars, 0),
    completionChars: metrics.reduce((sum, entry) => sum + entry.completionChars, 0),
    toolIterations: metrics.reduce((sum, entry) => sum + entry.toolIterations, 0),
    finishReason: metrics.at(-1)?.finishReason ?? "workflow_completed",
    blocked: metrics.some((entry) => entry.blocked),
  };
}

function buildApprovalCallback(
  job: ClaimedSceneJob,
  controller: AbortController,
  counters: { toolCallsRequested: number; toolCallsCompleted: number; approvalsRequested: number; subAgentsStarted: number },
  approvalChannelOverride?: string,
): ((toolName: string, args: Record<string, unknown>) => Promise<boolean>) | undefined {
  const approvalChannel = approvalChannelOverride ?? job.payload.approvalChannel;
  if (!approvalChannel || !job.payload.humanInLoopSteps?.length) return undefined;

  return async (toolName: string, args: Record<string, unknown>) => {
    counters.approvalsRequested += 1;
    await safeProgressUpdate(job.id, {
      stage: "approval",
      message: `Awaiting approval for ${toolName}`,
      currentTool: toolName,
      approvalsRequested: counters.approvalsRequested,
      toolCallsRequested: counters.toolCallsRequested,
      toolCallsCompleted: counters.toolCallsCompleted,
      subAgentsStarted: counters.subAgentsStarted,
      lastEventAt: new Date().toISOString(),
      lastEventType: "approval_requested",
    });

    publishNotification({
      title: "Approval required",
      message: `${job.sceneName} is waiting for approval to run ${toolName}.`,
      level: "warn",
      category: "approval",
      sessionId: job.sessionId,
      jobId: job.id,
      targetPath: "/jobs",
      sticky: true,
    });

    const approved = await raceAgainstAbort(
      requestApprovalViaChannel(approvalChannel, toolName, args, job.sceneName),
      controller.signal,
    );

    await safeProgressUpdate(job.id, {
      stage: approved ? "running" : "approval",
      message: approved ? `Approval granted for ${toolName}` : `Approval denied or cancelled for ${toolName}`,
      currentTool: toolName,
      approvalsRequested: counters.approvalsRequested,
      toolCallsRequested: counters.toolCallsRequested,
      toolCallsCompleted: counters.toolCallsCompleted,
      subAgentsStarted: counters.subAgentsStarted,
      lastEventAt: new Date().toISOString(),
      lastEventType: approved ? "approval_resolved" : "approval_cancelled",
    });

    return approved;
  };
}

async function raceAgainstAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | false> {
  if (signal.aborted) return false;

  return new Promise<T | false>((resolve, reject) => {
    const onAbort = () => resolve(false);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function progressFromIntervention(
  notice: InterventionNotice,
  counters: { toolCallsRequested: number; toolCallsCompleted: number; approvalsRequested: number; subAgentsStarted: number }
): Partial<SceneJobProgress> {
  return {
    stage: "intervention",
    message: notice.summary,
    currentTool: notice.toolName,
    toolCallsRequested: counters.toolCallsRequested,
    toolCallsCompleted: counters.toolCallsCompleted,
    approvalsRequested: counters.approvalsRequested,
    subAgentsStarted: counters.subAgentsStarted,
    lastEventAt: new Date().toISOString(),
    lastEventType: `intervention:${notice.reasonCode}`,
  };
}

function progressFromSwarmState(
  state: SwarmState,
  counters: { toolCallsRequested: number; toolCallsCompleted: number; approvalsRequested: number; subAgentsStarted: number }
): Partial<SceneJobProgress> {
  const tasks = Object.values(state.tasks);
  const completedTasks = tasks.filter(task => task.status === "completed").length;
  const runningTasks = tasks.filter(task => task.status === "running").length;
  const startedAttempts = tasks.reduce((sum, task) => sum + task.attempts.length, 0);

  return {
    stage: tasks.length > 0 ? "delegation" : "running",
    message: tasks.length > 0
      ? `${completedTasks}/${tasks.length} swarm tasks finished, ${runningTasks} still running`
      : "Running scene job",
    toolCallsRequested: counters.toolCallsRequested,
    toolCallsCompleted: counters.toolCallsCompleted,
    approvalsRequested: counters.approvalsRequested,
    subAgentsStarted: Math.max(counters.subAgentsStarted, startedAttempts),
    swarmTasksTotal: tasks.length,
    swarmTasksCompleted: completedTasks,
    percent: tasks.length > 0 ? Math.max(10, Math.min(95, Math.round((completedTasks / tasks.length) * 100))) : undefined,
    lastEventAt: new Date().toISOString(),
    lastEventType: "swarm_state_updated",
  };
}

async function safeProgressUpdate(jobId: string, patch: Partial<SceneJobProgress>): Promise<void> {
  try {
    await updateJobProgress(jobId, patch);
  } catch (err) {
    log.warn({ err, jobId }, "Failed to update scene job progress");
  }
}

function computeRuntimePercent(toolCallsRequested: number, toolCallsCompleted: number): number {
  if (toolCallsRequested <= 0) return 10;
  return Math.max(10, Math.min(95, Math.round(10 + (toolCallsCompleted / Math.max(1, toolCallsRequested)) * 70)));
}

function resolveWorkerConcurrency(): number {
  const raw = Number.parseInt(process.env["SAI_SCENE_WORKER_CONCURRENCY"] ?? "2", 10);
  if (!Number.isFinite(raw) || raw < 1) return 2;
  return Math.min(raw, 8);
}