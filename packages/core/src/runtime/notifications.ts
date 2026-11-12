import { randomUUID } from "node:crypto";
import { childLogger } from "../logger.js";
import type { Identity } from "./accounts.js";
import { multiUserAuthActive, ownsRecord } from "./user-scope.js";

const log = childLogger("runtime:notifications");
const MAX_RECENT_NOTIFICATIONS = 100;

export type RuntimeNotificationLevel = "info" | "success" | "warn" | "error";

export interface RuntimeNotification {
  id: string;
  title: string;
  message: string;
  level: RuntimeNotificationLevel;
  createdAt: string;
  category?: string;
  sessionId?: string;
  jobId?: string;
  targetPath?: string;
  sticky?: boolean;
  /**
   * Whose notification this is. One with an owner is forwarded to that owner's connections only
   * (gateway/rpc.ts) and the field itself never leaves the gateway; one without goes to everybody
   * signed in, as all of them did.
   */
  owner?: Identity;
}

export interface PublishNotificationInput {
  id?: string;
  title: string;
  message: string;
  level?: RuntimeNotificationLevel;
  createdAt?: string;
  category?: string;
  sessionId?: string;
  jobId?: string;
  targetPath?: string;
  sticky?: boolean;
  owner?: Identity;
}

type NotificationSubscriber = (notification: RuntimeNotification) => void;

const subscribers = new Set<NotificationSubscriber>();
const recentNotifications: RuntimeNotification[] = [];

export function publishNotification(input: PublishNotificationInput): RuntimeNotification {
  const notification: RuntimeNotification = {
    id: input.id?.trim() || randomUUID(),
    title: input.title.trim(),
    message: input.message.trim(),
    level: input.level ?? "info",
    createdAt: input.createdAt ?? new Date().toISOString(),
    category: input.category?.trim() || undefined,
    sessionId: input.sessionId?.trim() || undefined,
    jobId: input.jobId?.trim() || undefined,
    targetPath: input.targetPath?.trim() || undefined,
    sticky: input.sticky === true ? true : undefined,
    ...(input.owner ? { owner: input.owner } : {}),
  };

  if (!notification.title || !notification.message) {
    throw new Error("Notification title and message are required");
  }

  recentNotifications.unshift(notification);
  if (recentNotifications.length > MAX_RECENT_NOTIFICATIONS) {
    recentNotifications.length = MAX_RECENT_NOTIFICATIONS;
  }

  for (const subscriber of subscribers) {
    try {
      subscriber(notification);
    } catch (err) {
      log.warn({ err, notificationId: notification.id }, "Notification subscriber failed");
    }
  }

  return notification;
}

export function subscribeToNotifications(
  fn: NotificationSubscriber,
  opts: { replayLatest?: number } = {},
): () => void {
  subscribers.add(fn);

  const replayLatest = Math.max(0, Math.min(MAX_RECENT_NOTIFICATIONS, Math.trunc(opts.replayLatest ?? 0)));
  if (replayLatest > 0) {
    for (const notification of recentNotifications.slice(0, replayLatest).reverse()) {
      try {
        fn(notification);
      } catch (err) {
        log.warn({ err, notificationId: notification.id }, "Notification replay subscriber failed");
      }
    }
  }

  return () => {
    subscribers.delete(fn);
  };
}

/**
 * A notification as it is sent to a connection, or nothing when it is somebody else's. One with
 * an owner goes to that owner alone under multi-user auth (with one operator there is nobody else);
 * who it belongs to is never part of what is sent.
 */
export function notificationForCaller(
  notification: RuntimeNotification,
  caller: Identity | undefined,
): Omit<RuntimeNotification, "owner"> | undefined {
  const { owner, ...wire } = notification;
  if (owner && multiUserAuthActive() && !ownsRecord(caller, owner)) return undefined;
  return wire;
}

export function listRecentNotifications(limit = 20): RuntimeNotification[] {
  const normalizedLimit = Math.max(1, Math.min(MAX_RECENT_NOTIFICATIONS, Math.trunc(limit)));
  return recentNotifications.slice(0, normalizedLimit).map((notification) => ({ ...notification }));
}

export function resetNotificationsForTests(): void {
  subscribers.clear();
  recentNotifications.length = 0;
}