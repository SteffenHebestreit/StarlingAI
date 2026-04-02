import { defineStore } from "pinia";
import { computed, ref } from "vue";

export type NotificationLevel = "info" | "success" | "warn" | "error";

export interface BrowserNotificationItem {
  id: string;
  title: string;
  message: string;
  level: NotificationLevel;
  createdAt: string;
  category?: string;
  sessionId?: string;
  jobId?: string;
  targetPath?: string;
  sticky?: boolean;
  source: "server" | "local";
}

interface NotificationInput {
  id?: string;
  title: string;
  message: string;
  level?: NotificationLevel;
  createdAt?: string;
  category?: string;
  sessionId?: string;
  jobId?: string;
  targetPath?: string;
  sticky?: boolean;
  source?: "server" | "local";
}

const MAX_NOTIFICATIONS = 25;
const DEFAULT_TIMEOUT_MS = 8_000;

export const useNotificationStore = defineStore("notifications", () => {
  const items = ref<BrowserNotificationItem[]>([]);
  const permission = ref<NotificationPermission>("default");
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const supported = computed(() => typeof window !== "undefined" && "Notification" in window);

  function syncPermission(): void {
    permission.value = supported.value ? window.Notification.permission : "denied";
  }

  async function requestPermission(): Promise<NotificationPermission> {
    if (!supported.value) {
      permission.value = "denied";
      return permission.value;
    }
    permission.value = await window.Notification.requestPermission();
    return permission.value;
  }

  function clearTimer(id: string): void {
    const timer = timers.get(id);
    if (!timer) return;
    clearTimeout(timer);
    timers.delete(id);
  }

  function dismiss(id: string): void {
    clearTimer(id);
    items.value = items.value.filter((item) => item.id !== id);
  }

  function notifyBrowser(item: BrowserNotificationItem): void {
    if (!supported.value || permission.value !== "granted") return;
    if (typeof document !== "undefined" && document.visibilityState === "visible") return;

    const notification = new window.Notification(item.title, {
      body: item.message,
      tag: `${item.source}:${item.id}`,
    });

    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  }

  function push(input: NotificationInput): void {
    const item: BrowserNotificationItem = {
      id: input.id?.trim() || globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      title: input.title.trim(),
      message: input.message.trim(),
      level: input.level ?? "info",
      createdAt: input.createdAt ?? new Date().toISOString(),
      category: input.category?.trim() || undefined,
      sessionId: input.sessionId?.trim() || undefined,
      jobId: input.jobId?.trim() || undefined,
      targetPath: input.targetPath?.trim() || undefined,
      sticky: input.sticky === true ? true : undefined,
      source: input.source ?? "local",
    };

    if (!item.title || !item.message) return;

    clearTimer(item.id);
    items.value = [item, ...items.value.filter((existing) => existing.id !== item.id)].slice(0, MAX_NOTIFICATIONS);

    if (!item.sticky) {
      timers.set(item.id, setTimeout(() => {
        dismiss(item.id);
      }, DEFAULT_TIMEOUT_MS));
    }

    notifyBrowser(item);
  }

  function pushServerNotification(input: NotificationInput): void {
    push({ ...input, source: "server" });
  }

  function pushLocalNotification(input: NotificationInput): void {
    push({ ...input, source: "local" });
  }

  function clear(): void {
    for (const id of timers.keys()) {
      clearTimer(id);
    }
    items.value = [];
  }

  syncPermission();

  return {
    items,
    permission,
    supported,
    syncPermission,
    requestPermission,
    dismiss,
    clear,
    pushServerNotification,
    pushLocalNotification,
  };
});