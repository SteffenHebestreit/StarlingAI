import { randomUUID } from "node:crypto";
import { childLogger } from "../logger.js";
import { publishNotification } from "./notifications.js";

const log = childLogger("runtime:timers");
const MAX_DELAY_MS = 2_147_483_647;

export interface ScheduledTimer {
  id: string;
  label: string;
  durationMs: number;
  startedAt: string;
  dueAt: string;
  createdAt: string;
  message?: string;
  sessionId?: string;
  targetPath?: string;
  sticky?: boolean;
}

export interface StartTimerInput {
  id?: string;
  label: string;
  durationMs: number;
  message?: string;
  sessionId?: string;
  targetPath?: string;
  sticky?: boolean;
}

interface InternalTimer extends ScheduledTimer {
  timeout: ReturnType<typeof setTimeout>;
}

const timers = new Map<string, InternalTimer>();

export function startTimer(input: StartTimerInput): ScheduledTimer {
  const label = input.label.trim();
  const durationMs = Math.trunc(input.durationMs);

  if (!label) {
    throw new Error("Timer label is required");
  }
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error("Timer durationMs must be a positive number");
  }
  if (durationMs > MAX_DELAY_MS) {
    throw new Error("Timer duration is too long for the in-memory scheduler");
  }

  const timerId = input.id?.trim() || randomUUID();
  const startedAt = new Date();
  const dueAt = new Date(startedAt.getTime() + durationMs);
  const message = input.message?.trim() || undefined;

  const timerBase: ScheduledTimer = {
    id: timerId,
    label,
    durationMs,
    startedAt: startedAt.toISOString(),
    dueAt: dueAt.toISOString(),
    createdAt: startedAt.toISOString(),
    message,
    sessionId: input.sessionId?.trim() || undefined,
    targetPath: input.targetPath?.trim() || undefined,
    sticky: input.sticky === true ? true : undefined,
  };

  const timeout = setTimeout(() => {
    const timer = timers.get(timerId);
    if (!timer) return;

    timers.delete(timerId);
    publishNotification({
      id: timer.id,
      title: "Timer elapsed",
      message: timer.message ?? `${timer.label} finished.`,
      level: "info",
      createdAt: new Date().toISOString(),
      category: "timer",
      sessionId: timer.sessionId,
      targetPath: timer.targetPath,
      sticky: timer.sticky,
    });
    log.info({ timerId, dueAt: timer.dueAt, sessionId: timer.sessionId }, "Timer elapsed");
  }, durationMs);
  timeout.unref?.();

  const timer: InternalTimer = {
    ...timerBase,
    timeout,
  };

  timers.set(timerId, timer);
  log.info({ timerId, dueAt: timer.dueAt, sessionId: timer.sessionId }, "Timer started");

  return toPublic(timer);
}

export function listTimers(opts: { sessionId?: string } = {}): ScheduledTimer[] {
  const sessionId = opts.sessionId?.trim();
  return [...timers.values()]
    .filter((timer) => !sessionId || timer.sessionId === sessionId)
    .sort((left, right) => left.dueAt.localeCompare(right.dueAt))
    .map(toPublic);
}

export function cancelTimer(id: string, opts: { sessionId?: string } = {}): boolean {
  const timer = timers.get(id);
  if (!timer) return false;
  if (opts.sessionId && timer.sessionId && timer.sessionId !== opts.sessionId) {
    return false;
  }

  clearTimeout(timer.timeout);
  timers.delete(id);
  log.info({ timerId: id, sessionId: timer.sessionId }, "Timer cancelled");
  return true;
}

export function stopAllTimers(): void {
  for (const timer of timers.values()) {
    clearTimeout(timer.timeout);
  }
  timers.clear();
}

export function resetTimersForTests(): void {
  stopAllTimers();
}

function toPublic(timer: InternalTimer): ScheduledTimer {
  return {
    id: timer.id,
    label: timer.label,
    durationMs: timer.durationMs,
    startedAt: timer.startedAt,
    dueAt: timer.dueAt,
    createdAt: timer.createdAt,
    message: timer.message,
    sessionId: timer.sessionId,
    targetPath: timer.targetPath,
    sticky: timer.sticky,
  };
}