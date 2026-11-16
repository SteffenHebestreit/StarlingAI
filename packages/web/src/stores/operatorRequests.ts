import { defineStore } from "pinia";
import { ref, computed, watch } from "vue";
import { useGatewayStore } from "./gateway";

// Pending human-in-the-loop approvals from ANY running session — including
// detached scene/job runs started from the dropdown, whose approvals would
// otherwise only reach the configured Slack/webhook channel. Polled so the
// operator can accept/deny from the dashboard regardless of which page they're on.
const POLL_INTERVAL_MS = 2_000;

export interface PendingApproval {
  id: string;
  /** "routed": a tool call whose approval policy names who may grant it; it waits for one of them.
   *  "channel" (or absent, from an older gateway): a scene or job run's approval. */
  kind?: "channel" | "routed";
  toolName: string;
  sceneName?: string;
  args?: Record<string, unknown>;
  createdAt: string;
  /** Routed only: who asked, as which role, and the roles that may decide it. */
  requester?: string;
  requesterRole?: string;
  approverRoles?: string[];
  /** Routed only: the requester may not approve it themselves. */
  distinctApprover?: boolean;
  expiresAt?: string;
}

export interface PendingLongRunning {
  id: string;
  agentName: string;
  parentSessionId?: string;
  runSessionId: string;
  reason: string;
  state: "pending" | "resolved" | "stopped";
  elapsedMs: number;
  completionTokens: number;
  iterations: number;
  createdAt: number;
  updatedAt: number;
}

export type LongRunningOutcome = "continue" | "unbounded" | "stop";

export const useOperatorRequestsStore = defineStore("operatorRequests", () => {
  const gateway = useGatewayStore();

  const approvals = ref<PendingApproval[]>([]);
  const longRunning = ref<PendingLongRunning[]>([]);
  const respondingIds = ref<Set<string>>(new Set());
  // Why the gateway refused an answer, by approval id (a second person must approve, a role it
  // does not admit), shown on the card until the next answer to it.
  const respondErrors = ref<Record<string, string>>({});

  const hasApprovals = computed(() => approvals.value.length > 0);
  const hasLongRunning = computed(() => longRunning.value.length > 0);
  const hasAnyPending = computed(() => hasApprovals.value || hasLongRunning.value);

  async function fetchApprovals() {
    try {
      const res = await gateway.authorizedFetch("/api/approvals/pending");
      const list = await res.json() as PendingApproval[];
      approvals.value = Array.isArray(list)
        ? [...list].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
        : [];
    } catch {
      /* transient — keep last known state */
    }
  }

  async function fetchLongRunning() {
    try {
      const res = await gateway.authorizedFetch("/api/long-running/active");
      const list = await res.json() as PendingLongRunning[];
      longRunning.value = Array.isArray(list)
        ? [...list].sort((a, b) => a.createdAt - b.createdAt)
        : [];
    } catch {
      /* transient — keep last known state */
    }
  }

  async function respond(id: string, approved: boolean) {
    respondingIds.value = new Set(respondingIds.value).add(id);
    const clearedErrors = { ...respondErrors.value };
    delete clearedErrors[id];
    respondErrors.value = clearedErrors;
    try {
      await gateway.authorizedFetch(`/api/approval/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved }),
      });
      // Drop it locally right away; the next poll reconciles.
      approvals.value = approvals.value.filter((a) => a.id !== id);
    } catch (err) {
      // Kept on the card: the request still waits, for someone else.
      respondErrors.value = { ...respondErrors.value, [id]: err instanceof Error ? err.message : String(err) };
    } finally {
      const next = new Set(respondingIds.value);
      next.delete(id);
      respondingIds.value = next;
    }
  }

  async function respondLongRunning(id: string, outcome: LongRunningOutcome) {
    respondingIds.value = new Set(respondingIds.value).add(id);
    try {
      await gateway.authorizedFetch(`/api/long-running/${encodeURIComponent(id)}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcome }),
      });
      longRunning.value = longRunning.value.filter((r) => r.id !== id);
    } finally {
      const next = new Set(respondingIds.value);
      next.delete(id);
      respondingIds.value = next;
    }
  }

  function isResponding(id: string): boolean {
    return respondingIds.value.has(id);
  }

  function respondError(id: string): string | undefined {
    return respondErrors.value[id];
  }

  // ── Polling lifecycle ─────────────────────────────────────────────────────
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      if (!gateway.connected) return;
      void fetchApprovals();
      void fetchLongRunning();
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
    (connected) => {
      if (connected) {
        void fetchApprovals();
        void fetchLongRunning();
        startPolling();
      } else {
        stopPolling();
      }
    },
    { immediate: true },
  );

  return {
    approvals,
    longRunning,
    hasApprovals,
    hasLongRunning,
    hasAnyPending,
    fetchApprovals,
    fetchLongRunning,
    respond,
    respondLongRunning,
    isResponding,
    respondError,
  };
});
