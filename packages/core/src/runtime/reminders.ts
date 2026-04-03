import { randomUUID } from "node:crypto";
import { childLogger } from "../logger.js";
import { publishNotification } from "./notifications.js";

const log = childLogger("runtime:reminders");
const MAX_DELAY_MS = 2_147_483_647;

export interface ScheduledReminder {
  id: string;
  title: string;
  message: string;
  dueAt: string;
  createdAt: string;
  sessionId?: string;
  targetPath?: string;
  sticky?: boolean;
}

export interface CreateReminderInput {
  id?: string;
  title: string;
  message: string;
  dueAt: string;
  sessionId?: string;
  targetPath?: string;
  sticky?: boolean;
}

interface InternalReminder extends ScheduledReminder {
  timeout: ReturnType<typeof setTimeout>;
}

const reminders = new Map<string, InternalReminder>();

export function createReminder(input: CreateReminderInput): ScheduledReminder {
  const title = input.title.trim();
  const message = input.message.trim();
  const dueDate = new Date(input.dueAt);

  if (!title || !message) {
    throw new Error("Reminder title and message are required");
  }
  if (Number.isNaN(dueDate.getTime())) {
    throw new Error("Reminder dueAt must be a valid ISO timestamp");
  }

  const delayMs = dueDate.getTime() - Date.now();
  if (delayMs <= 0) {
    throw new Error("Reminder dueAt must be in the future");
  }
  if (delayMs > MAX_DELAY_MS) {
    throw new Error("Reminder is too far in the future for the in-memory scheduler");
  }

  const reminderId = input.id?.trim() || randomUUID();
  const reminderBase: ScheduledReminder = {
    id: reminderId,
    title,
    message,
    dueAt: dueDate.toISOString(),
    createdAt: new Date().toISOString(),
    sessionId: input.sessionId?.trim() || undefined,
    targetPath: input.targetPath?.trim() || undefined,
    sticky: input.sticky === true ? true : undefined,
  };

  const timeout = setTimeout(() => {
    const reminder = reminders.get(reminderId);
    if (!reminder) return;

    reminders.delete(reminderId);
    publishNotification({
      id: reminder.id,
      title: reminder.title,
      message: reminder.message,
      level: "info",
      createdAt: new Date().toISOString(),
      category: "reminder",
      sessionId: reminder.sessionId,
      targetPath: reminder.targetPath,
      sticky: reminder.sticky,
    });
    log.info({ reminderId, dueAt: reminder.dueAt, sessionId: reminder.sessionId }, "Reminder fired");
  }, delayMs);
  timeout.unref?.();

  const reminder: InternalReminder = {
    ...reminderBase,
    timeout,
  };

  reminders.set(reminderId, reminder);
  log.info({ reminderId, dueAt: reminder.dueAt, sessionId: reminder.sessionId }, "Reminder scheduled");

  return toPublic(reminder);
}

export function listReminders(opts: { sessionId?: string } = {}): ScheduledReminder[] {
  const sessionId = opts.sessionId?.trim();
  return [...reminders.values()]
    .filter((reminder) => !sessionId || reminder.sessionId === sessionId)
    .sort((left, right) => left.dueAt.localeCompare(right.dueAt))
    .map(toPublic);
}

export function removeReminder(id: string, opts: { sessionId?: string } = {}): boolean {
  const reminder = reminders.get(id);
  if (!reminder) return false;
  if (opts.sessionId && reminder.sessionId && reminder.sessionId !== opts.sessionId) {
    return false;
  }

  clearTimeout(reminder.timeout);
  reminders.delete(id);
  log.info({ reminderId: id, sessionId: reminder.sessionId }, "Reminder removed");
  return true;
}

export function stopAllReminders(): void {
  for (const reminder of reminders.values()) {
    clearTimeout(reminder.timeout);
  }
  reminders.clear();
}

export function resetRemindersForTests(): void {
  stopAllReminders();
}

function toPublic(reminder: InternalReminder): ScheduledReminder {
  return {
    id: reminder.id,
    title: reminder.title,
    message: reminder.message,
    dueAt: reminder.dueAt,
    createdAt: reminder.createdAt,
    sessionId: reminder.sessionId,
    targetPath: reminder.targetPath,
    sticky: reminder.sticky,
  };
}