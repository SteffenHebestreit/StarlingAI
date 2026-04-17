import { defineStore } from "pinia";
import { ref, computed, watch } from "vue";
import { useGatewayStore } from "./gateway";

// ── Live-preview polling ─────────────────────────────────────────────────────
// Poll for a fresh screenshot every second while a session is being observed.
// This keeps the panel live even when no agent turn is running.
const LIVE_PREVIEW_INTERVAL_MS = 1_000;

export interface ComputerSession {
  id: string;
  adapter: string;
  state: string;
  createdAt: number;
  updatedAt?: number;
  lastHeartbeat: number;
  attachedScene?: string;
}

export interface ComputerMonitorInfo {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  dpiScale: number;
}

export interface ComputerDisplayTopology {
  monitors: ComputerMonitorInfo[];
  primary: number;
}

export interface ComputerActiveWindow {
  title: string;
  processName: string;
  bounds: { x: number; y: number; width: number; height: number };
}

export interface ComputerScreenshot {
  computerSessionId: string;
  dataUrl: string;
  width: number;
  height: number;
  timestamp: number;
  frameId?: string;
  activeWindow?: ComputerActiveWindow;
  displayTopology?: ComputerDisplayTopology;
}

export interface ComputerAction {
  computerSessionId: string;
  actionType: string;
  timestamp: number;
  detail?: Record<string, unknown>;
}

export const useComputerStore = defineStore("computer", () => {
  const gateway = useGatewayStore();

  // ── State ───────────────────────────────────────────────────────────────
  const sessions = ref<ComputerSession[]>([]);
  const activeSessions = computed(() => sessions.value.filter(s => ["active", "initializing", "paused"].includes(s.state)));
  const latestScreenshot = ref<ComputerScreenshot | null>(null);
  const recentActions = ref<ComputerAction[]>([]);
  const observedSessionId = ref<string | null>(null);
  const screenshotsBySession = ref<Record<string, ComputerScreenshot>>({});
  const actionsBySession = ref<Record<string, ComputerAction[]>>({});
  const autoObserve = ref(true);
  const loading = ref(false);

  // ── Actions ─────────────────────────────────────────────────────────────

  async function fetchSessions() {
    loading.value = true;
    try {
      const res = await gateway.rpc("computer.list_sessions", {}) as { sessions?: ComputerSession[] };
      if (res?.sessions) {
        sessions.value = res.sessions.map((session) => normalizeSession(session as unknown as Record<string, unknown>)).sort((left, right) => right.createdAt - left.createdAt);
        ensureObservedSession();
      }
    } finally {
      loading.value = false;
    }
  }

  async function emergencyStop(computerSessionId: string, reason?: string) {
    await gateway.rpc("computer.emergency_stop", {
      computerSessionId,
      reason: reason ?? "ui:manual_stop",
    });
    await fetchSessions();
  }

  async function heartbeat(computerSessionId: string) {
    await gateway.rpc("computer.heartbeat", { computerSessionId });
  }

  function observeSession(sessionId: string | null) {
    autoObserve.value = sessionId !== null;
    observedSessionId.value = sessionId;
    syncObservedPreview();
  }

  function syncObservedPreview() {
    if (!observedSessionId.value) {
      latestScreenshot.value = null;
      recentActions.value = [];
      return;
    }

    latestScreenshot.value = screenshotsBySession.value[observedSessionId.value] ?? null;
    recentActions.value = [...(actionsBySession.value[observedSessionId.value] ?? [])];
  }

  function normalizeSession(session: Record<string, unknown>): ComputerSession {
    return {
      id: String(session.id ?? ""),
      adapter: String(session.adapter ?? "unknown"),
      state: String(session.state ?? "active"),
      createdAt: Number(session.createdAt ?? Date.now()),
      updatedAt: Number(session.updatedAt ?? Date.now()),
      lastHeartbeat: Number(session.lastHeartbeatAt ?? session.lastHeartbeat ?? session.updatedAt ?? Date.now()),
      attachedScene: typeof session.attachedScene === "string" ? session.attachedScene : undefined,
    };
  }

  function upsertSession(partial: Partial<ComputerSession> & { id: string }) {
    const now = Date.now();
    const idx = sessions.value.findIndex((session) => session.id === partial.id);
    if (idx >= 0) {
      const current = sessions.value[idx]!;
      sessions.value[idx] = {
        ...current,
        ...partial,
        updatedAt: partial.updatedAt ?? now,
        lastHeartbeat: partial.lastHeartbeat ?? current.lastHeartbeat ?? now,
      };
      return;
    }

    sessions.value = [{
      id: partial.id,
      adapter: partial.adapter ?? "unknown",
      state: partial.state ?? "active",
      createdAt: partial.createdAt ?? now,
      updatedAt: partial.updatedAt ?? now,
      lastHeartbeat: partial.lastHeartbeat ?? now,
      attachedScene: partial.attachedScene,
    }, ...sessions.value];
  }

  function ensureObservedSession(preferredSessionId?: string | null) {
    if (observedSessionId.value && sessions.value.some((session) => session.id === observedSessionId.value)) {
      syncObservedPreview();
      return;
    }

    if (!autoObserve.value) {
      observedSessionId.value = null;
      syncObservedPreview();
      return;
    }

    const preferred = preferredSessionId
      ? sessions.value.find((session) => session.id === preferredSessionId)
      : undefined;
    const fallback = preferred ?? activeSessions.value[0] ?? sessions.value[0];
    observedSessionId.value = fallback?.id ?? null;
    syncObservedPreview();
  }

  function rememberAction(action: ComputerAction) {
    const existing = actionsBySession.value[action.computerSessionId] ?? [];
    actionsBySession.value = {
      ...actionsBySession.value,
      [action.computerSessionId]: [...existing.slice(-49), action],
    };
  }

  function evictStaleSessions() {
    const MAX_CACHED_SESSIONS = 20;
    const allKeys = Object.keys(screenshotsBySession.value);
    if (allKeys.length <= MAX_CACHED_SESSIONS) return;

    const activeIds = new Set(activeSessions.value.map(s => s.id));
    const staleKeys = allKeys
      .filter(k => !activeIds.has(k))
      .sort((a, b) => (screenshotsBySession.value[a]?.timestamp ?? 0) - (screenshotsBySession.value[b]?.timestamp ?? 0));

    const toRemove = allKeys.length - MAX_CACHED_SESSIONS;
    const keysToEvict = staleKeys.slice(0, toRemove);
    if (keysToEvict.length === 0) return;

    const evictSet = new Set(keysToEvict);
    const nextScreenshots: Record<string, ComputerScreenshot> = {};
    const nextActions: Record<string, ComputerAction[]> = {};
    for (const key of allKeys) {
      if (!evictSet.has(key)) {
        if (screenshotsBySession.value[key]) nextScreenshots[key] = screenshotsBySession.value[key];
        if (actionsBySession.value[key]) nextActions[key] = actionsBySession.value[key];
      }
    }
    // Preserve action-only sessions not in screenshot keys
    for (const key of Object.keys(actionsBySession.value)) {
      if (!evictSet.has(key) && !(key in nextActions)) {
        nextActions[key] = actionsBySession.value[key];
      }
    }
    screenshotsBySession.value = nextScreenshots;
    actionsBySession.value = nextActions;
  }

  function rememberScreenshot(screenshot: ComputerScreenshot) {
    screenshotsBySession.value = {
      ...screenshotsBySession.value,
      [screenshot.computerSessionId]: screenshot,
    };
    evictStaleSessions();
  }

  // ── WebSocket event handlers ────────────────────────────────────────────

  function handleComputerAction(data: Record<string, unknown>) {
    const computerSessionId = String(data.computerSessionId ?? data.sessionId ?? "");
    if (computerSessionId) {
      upsertSession({ id: computerSessionId, state: "active", lastHeartbeat: Date.now() });
      ensureObservedSession(computerSessionId);
    }

    const action: ComputerAction = {
      computerSessionId,
      actionType: String(data.actionType ?? data.action ?? ""),
      timestamp: Date.now(),
      detail: data,
    };
    rememberAction(action);

    if (!observedSessionId.value) {
      ensureObservedSession(computerSessionId);
      return;
    }

    if (observedSessionId.value === computerSessionId) {
      recentActions.value = [...(actionsBySession.value[computerSessionId] ?? [])];
    }
  }

  function handleComputerScreenshot(data: Record<string, unknown>) {
    const rawTopology = data.displayTopology as Record<string, unknown> | undefined;
    const rawMonitors = Array.isArray(rawTopology?.monitors) ? rawTopology.monitors : [];
    const screenshot: ComputerScreenshot = {
      computerSessionId: String(data.computerSessionId ?? ""),
      dataUrl: String(data.dataUrl ?? ""),
      width: Number(data.width ?? 0),
      height: Number(data.height ?? 0),
      timestamp: Number(data.timestamp ?? Date.now()),
      frameId: typeof data.frameId === "string" ? data.frameId : undefined,
      activeWindow: data.activeWindow && typeof data.activeWindow === "object"
        ? {
            title: String((data.activeWindow as Record<string, unknown>).title ?? ""),
            processName: String((data.activeWindow as Record<string, unknown>).processName ?? ""),
            bounds: {
              x: Number(((data.activeWindow as Record<string, unknown>).bounds as Record<string, unknown> | undefined)?.x ?? 0),
              y: Number(((data.activeWindow as Record<string, unknown>).bounds as Record<string, unknown> | undefined)?.y ?? 0),
              width: Number(((data.activeWindow as Record<string, unknown>).bounds as Record<string, unknown> | undefined)?.width ?? 0),
              height: Number(((data.activeWindow as Record<string, unknown>).bounds as Record<string, unknown> | undefined)?.height ?? 0),
            },
          }
        : undefined,
      displayTopology: rawTopology
        ? {
            primary: Number(rawTopology.primary ?? 0),
            monitors: rawMonitors.map((monitor, index) => {
              const item = monitor as Record<string, unknown>;
              return {
                id: Number(item.id ?? index),
                x: Number(item.x ?? 0),
                y: Number(item.y ?? 0),
                width: Number(item.width ?? 0),
                height: Number(item.height ?? 0),
                dpiScale: Number(item.dpiScale ?? 1),
              };
            }),
          }
        : undefined,
    };

    if (screenshot.computerSessionId) {
      rememberScreenshot(screenshot);
    }

    if (screenshot.computerSessionId) {
      upsertSession({ id: screenshot.computerSessionId, state: "active", lastHeartbeat: screenshot.timestamp });
      ensureObservedSession(screenshot.computerSessionId);
    }

    if (observedSessionId.value && screenshot.computerSessionId === observedSessionId.value) {
      latestScreenshot.value = screenshot;
    }
  }

  function handleComputerSessionState(data: Record<string, unknown>) {
    const csId = String(data.computerSessionId ?? "");
    const newState = String(data.state ?? "");
    if (csId) {
      upsertSession({ id: csId, state: newState, lastHeartbeat: Date.now() });
      ensureObservedSession(newState === "stopped" ? null : csId);
    }

    void fetchSessions();
  }

  function handleServerMessage(msg: { type: string; data: unknown }) {
    switch (msg.type) {
      case "computer.action":
        handleComputerAction(msg.data as Record<string, unknown>);
        break;
      case "computer.screenshot":
        handleComputerScreenshot(msg.data as Record<string, unknown>);
        break;
      case "computer.session_state":
        handleComputerSessionState(msg.data as Record<string, unknown>);
        break;
    }
  }

  // ── Auto-refresh when gateway connects ──────────────────────────────────
  watch(
    () => gateway.connected,
    (connected) => {
      if (connected) fetchSessions();
    },
    { immediate: true },
  );

  // ── Live-preview polling ─────────────────────────────────────────────────
  // When a session is being observed, poll for a fresh screenshot every second
  // so the panel updates even when no agent turn is actively running.
  let livePreviewTimer: ReturnType<typeof setInterval> | null = null;

  function startLivePreview() {
    if (livePreviewTimer) return;
    livePreviewTimer = setInterval(() => {
      const csId = observedSessionId.value;
      if (!csId || !gateway.connected) return;
      const session = sessions.value.find((s) => s.id === csId);
      if (!session || session.state !== "active") return;
      // Skip poll if a fresh screenshot arrived in the last 600ms (agent is pushing them already)
      const cached = screenshotsBySession.value[csId];
      if (cached && Date.now() - cached.timestamp < 600) return;
      gateway.rpc("computer.request_screenshot", { computerSessionId: csId }).catch(() => {/* non-fatal */});
    }, LIVE_PREVIEW_INTERVAL_MS);
  }

  function stopLivePreview() {
    if (livePreviewTimer) {
      clearInterval(livePreviewTimer);
      livePreviewTimer = null;
    }
  }

  watch(observedSessionId, (id) => {
    if (id) {
      startLivePreview();
    } else {
      stopLivePreview();
    }
  }, { immediate: true });

  return {
    sessions,
    activeSessions,
    latestScreenshot,
    recentActions,
    observedSessionId,
    loading,
    fetchSessions,
    emergencyStop,
    heartbeat,
    observeSession,
    handleServerMessage,
  };
});
