import { defineStore } from "pinia";
import { ref, computed, watch } from "vue";
import { useGatewayStore } from "./gateway";

// Poll browser-session state every couple of seconds. The live *pixels* stream
// over the noVNC WebSocket proxy (handled by the RFB client in the panel); this
// poll only tracks which sessions exist and which are waiting on a human.
const POLL_INTERVAL_MS = 2_000;

export interface BrowserSession {
  id: string;
  agentName: string;
  parentSessionId?: string;
  state: "active" | "assist_requested" | "active_resolved" | "stopped";
  page?: string;
  assistReason?: string;
  createdAt: number;
  updatedAt: number;
  assistRequestedAt?: number;
  assistResolvedAt?: number;
}

export const useBrowserStore = defineStore("browser", () => {
  const gateway = useGatewayStore();

  const enabled = ref(false);
  const sessions = ref<BrowserSession[]>([]);
  const observedSessionId = ref<string | null>(null);
  const loading = ref(false);

  const activeSessions = computed(() => sessions.value.filter((s) => s.state !== "stopped"));
  const awaitingAssist = computed(() => sessions.value.filter((s) => s.state === "assist_requested"));
  const observedSession = computed(() =>
    sessions.value.find((s) => s.id === observedSessionId.value) ?? null);

  async function fetchConfig() {
    try {
      const res = await gateway.authorizedFetch("/api/browser-sessions/config");
      const body = await res.json() as { enabled?: boolean };
      enabled.value = body.enabled === true;
    } catch {
      enabled.value = false;
    }
  }

  async function fetchSessions() {
    if (!enabled.value) return;
    loading.value = true;
    try {
      const res = await gateway.authorizedFetch("/api/browser-sessions/active");
      const list = await res.json() as BrowserSession[];
      sessions.value = Array.isArray(list)
        ? [...list].sort((a, b) => b.createdAt - a.createdAt)
        : [];
      ensureObserved();
    } catch {
      /* transient — keep last known state */
    } finally {
      loading.value = false;
    }
  }

  function ensureObserved() {
    // Prefer a session that needs help; else keep the current one if still live;
    // else fall back to the most recent active session.
    const waiting = awaitingAssist.value[0];
    if (waiting) {
      observedSessionId.value = waiting.id;
      return;
    }
    if (observedSessionId.value && sessions.value.some((s) => s.id === observedSessionId.value && s.state !== "stopped")) {
      return;
    }
    observedSessionId.value = activeSessions.value[0]?.id ?? null;
  }

  function observeSession(id: string | null) {
    observedSessionId.value = id;
  }

  async function resolveAssist(id: string) {
    await gateway.authorizedFetch(`/api/browser-sessions/${encodeURIComponent(id)}/resolve-assist`, { method: "POST" });
    await fetchSessions();
  }

  function buildVncUrl(id: string): string {
    return gateway.buildBrowserVncUrl(id);
  }

  // ── Polling lifecycle ─────────────────────────────────────────────────────
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      if (!gateway.connected) return;
      void fetchSessions();
    }, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  watch(
    () => gateway.connected,
    async (connected) => {
      if (connected) {
        await fetchConfig();
        if (enabled.value) {
          await fetchSessions();
          startPolling();
        }
      } else {
        stopPolling();
      }
    },
    { immediate: true },
  );

  return {
    enabled,
    sessions,
    activeSessions,
    awaitingAssist,
    observedSessionId,
    observedSession,
    loading,
    fetchConfig,
    fetchSessions,
    observeSession,
    resolveAssist,
    buildVncUrl,
  };
});
