import { randomUUID } from "node:crypto";
import { childLogger } from "../logger.js";
import type { Identity } from "./accounts.js";
import { multiUserAuthActive, ownsRecord } from "./user-scope.js";
import { policyAdmitsRole } from "../gateway/route-policies.js";

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
   * (gateway/rpc.ts) and the field itself never leaves the gateway; under multi-user auth one
   * without goes to operators and above (notificationForCaller).
   */
  owner?: Identity;
  /**
   * The roles it is for (policyAdmitsRole: a listed name, and among the built-in roles every higher
   * one): one with an audience goes only to connections whose role it admits, never to one whose
   * role is not known. Like `owner`, the field never leaves the gateway. Unset: everybody, as before.
   */
  audienceRoles?: readonly string[];
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
  audienceRoles?: readonly string[];
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
    ...(input.audienceRoles?.length ? { audienceRoles: [...input.audienceRoles] } : {}),
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
 * A notification as it is sent to a connection, or nothing when it is not the caller's to see.
 * One with an audience (`audienceRoles`, a routed approval's approvers) goes to a caller whose role
 * it admits (`access.role`, the connection's), and to nobody whose role is not known. Otherwise, with
 * one operator there is nobody else, and every notification goes out. Under multi-user auth:
 *
 * - One with an owner goes to that owner alone.
 * - One with an audience and no owner goes to the roles it admits, whatever `access.seesUnowned`
 *   says.
 * - One with neither goes only to a caller for whom `access.seesUnowned` is set, which the gateway
 *   sets for operators and above. Such a notification is about a run that names no account (a job a
 *   scene trigger or an instance credential queued) and carries its job and session ids and its
 *   error text. Every signed-in viewer received it.
 *
 * Who a notification belongs to and who it is for are never part of what is sent.
 */
export function notificationForCaller(
  notification: RuntimeNotification,
  caller: Identity | undefined,
  access: { seesUnowned?: boolean; role?: string } = {},
): Omit<RuntimeNotification, "owner" | "audienceRoles"> | undefined {
  const { owner, audienceRoles, ...wire } = notification;
  if (audienceRoles && !(access.role !== undefined && policyAdmitsRole({ roles: [...audienceRoles] }, access.role))) {
    return undefined;
  }
  if (!multiUserAuthActive()) return wire;
  if (owner) return ownsRecord(caller, owner) ? wire : undefined;
  return audienceRoles || access.seesUnowned ? wire : undefined;
}

export function listRecentNotifications(limit = 20): RuntimeNotification[] {
  const normalizedLimit = Math.max(1, Math.min(MAX_RECENT_NOTIFICATIONS, Math.trunc(limit)));
  return recentNotifications.slice(0, normalizedLimit).map((notification) => ({ ...notification }));
}

export function resetNotificationsForTests(): void {
  subscribers.clear();
  recentNotifications.length = 0;
}