<template>
  <div class="sessions-page" style="height: calc(100vh - 57px); overflow-y: auto">
    <div class="sessions-page__header">
      <div>
        <h2 class="sessions-page__title">Sessions</h2>
        <p class="sessions-page__subtitle">Inspect active conversations and archived swarm missions.</p>
      </div>
      <div class="sessions-page__actions">
        <button @click="clearArchivedSessions" class="sessions-page__clear" title="Remove all archived session history">Clear archived</button>
        <button @click="refresh" class="sessions-page__refresh">Refresh</button>
      </div>
    </div>

    <div class="sessions-filters">
      <input
        v-model="searchQuery"
        type="search"
        class="sessions-filters__search"
        placeholder="Search sessions or mission objectives"
      >
      <select v-model="statusFilter" class="sessions-filters__select">
        <option value="all">All sessions</option>
        <option value="active">Active only</option>
        <option value="archived">Archived only</option>
        <option value="has-runs">With swarm history</option>
        <option value="ok">Latest run ok</option>
        <option value="blocked">Latest run blocked</option>
        <option value="error">Latest run error</option>
      </select>
    </div>

    <div class="sessions-layout">
      <section class="sessions-list">
        <div v-if="!filteredSessionCards.length" class="sessions-list__empty">
          No sessions match the current filters.
        </div>

        <div
          v-for="session in filteredSessionCards"
          :key="session.id"
          :class="['session-card', selectedSessionId === session.id && 'session-card--active']"
          @click="selectSession(session.id)"
        >
          <div class="session-card__top">
            <span class="session-card__id">{{ session.id.substring(0, 12) }}…</span>
            <div class="session-card__top-right">
              <span :class="['session-card__badge', session.isActive ? 'session-card__badge--active' : 'session-card__badge--archived']">
                {{ session.isActive ? 'Active' : 'Archived' }}
              </span>
              <button
                class="session-card__delete"
                :title="session.isActive ? 'End and remove session' : 'Remove session history'"
                @click.stop="removeSession(session.id)"
              >✕</button>
            </div>
          </div>
          <div class="session-card__meta">
            <span v-if="session.channel">{{ session.channel }}</span>
            <span v-if="session.createdAt">Created {{ formatDate(session.createdAt) }}</span>
            <span v-if="session.turns !== null">{{ session.turns }} turns</span>
          </div>
          <div v-if="session.runCount > 0" class="session-card__history">
            <span :class="['session-card__status', `session-card__status--${session.lastStatus}`]">{{ session.lastStatus }}</span>
            <span>{{ session.runCount }} swarm run{{ session.runCount === 1 ? '' : 's' }}</span>
            <span>{{ session.lastRecordedAt ? formatDate(session.lastRecordedAt) : 'unknown' }}</span>
          </div>
          <div v-if="session.lastObjective" class="session-card__objective">{{ session.lastObjective }}</div>
        </div>
      </section>

      <section class="sessions-preview">
        <SwarmStatusPanel
          v-if="selectedRun"
          :state="selectedRun.state"
          :runs="selectedRuns"
          :selected-run-id="selectedRunId"
          @select-run="selectRun"
        />
        <div v-else class="sessions-preview__empty">
          Select a session with swarm history to inspect its latest mission.
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import SwarmStatusPanel from "@/components/SwarmStatusPanel.vue";
import { useGatewayStore, type GatewaySession, type SwarmRunRecord } from "@/stores/gateway";

interface SessionCard {
  id: string;
  channel: string | null;
  createdAt: string | null;
  turns: number | null;
  isActive: boolean;
  runCount: number;
  lastStatus: SwarmRunRecord["status"] | null;
  lastRecordedAt: string | null;
  lastObjective: string | null;
}

const gateway = useGatewayStore();
const route = useRoute();
const router = useRouter();
const sessions = ref<GatewaySession[]>([]);
const selectedSessionId = ref<string | null>(null);
const selectedRunId = ref<string | null>(null);
const searchQuery = ref("");
const statusFilter = ref<"all" | "active" | "archived" | "has-runs" | "ok" | "blocked" | "error">("all");

const sessionCards = computed<SessionCard[]>(() => {
  const activeById = new Map(sessions.value.map((session) => [session.id, session]));
  const ids = new Set<string>([
    ...sessions.value.map((session) => session.id),
    ...gateway.swarmSessionHistory.map((entry) => entry.sessionId),
  ]);

  return Array.from(ids).map((id) => {
    const activeSession = activeById.get(id);
    const history = gateway.swarmSessionHistory.find((entry) => entry.sessionId === id);
    return {
      id,
      channel: activeSession?.channel ?? null,
      createdAt: activeSession?.createdAt ?? null,
      turns: activeSession?.turns ?? null,
      isActive: Boolean(activeSession),
      runCount: history?.runCount ?? 0,
      lastStatus: history?.lastStatus ?? null,
      lastRecordedAt: history?.lastRecordedAt ?? null,
      lastObjective: history?.lastObjective ?? null,
    };
  }).sort((left, right) => {
    const leftTs = left.lastRecordedAt ?? left.createdAt ?? "";
    const rightTs = right.lastRecordedAt ?? right.createdAt ?? "";
    return rightTs.localeCompare(leftTs);
  });
});

const filteredSessionCards = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();

  return sessionCards.value.filter((session) => {
    if (statusFilter.value === "active" && !session.isActive) return false;
    if (statusFilter.value === "archived" && session.isActive) return false;
    if (statusFilter.value === "has-runs" && session.runCount === 0) return false;
    if (["ok", "blocked", "error"].includes(statusFilter.value) && session.lastStatus !== statusFilter.value) return false;

    if (!query) return true;

    return [
      session.id,
      session.channel ?? "",
      session.lastObjective ?? "",
      session.lastStatus ?? "",
    ].some((value) => value.toLowerCase().includes(query));
  });
});

const selectedRuns = computed(() => gateway.getSwarmRuns(selectedSessionId.value));
const selectedRun = computed(() => {
  if (!selectedRuns.value.length) return null;
  if (selectedRunId.value) {
    const matched = selectedRuns.value.find((run) => run.id === selectedRunId.value);
    if (matched) return matched;
  }
  return selectedRuns.value[selectedRuns.value.length - 1] ?? null;
});

function ensureSelection() {
  const routedSessionId = typeof route.query.sessionId === "string" ? route.query.sessionId : null;
  const routedRunId = typeof route.query.runId === "string" ? route.query.runId : null;

  if (routedSessionId && sessionCards.value.some((session) => session.id === routedSessionId)) {
    selectedSessionId.value = routedSessionId;
    const routedRuns = gateway.getSwarmRuns(routedSessionId);
    if (routedRunId && routedRuns.some((run) => run.id === routedRunId)) {
      selectedRunId.value = routedRunId;
      return;
    }
    selectedRunId.value = routedRuns[routedRuns.length - 1]?.id ?? null;
    return;
  }

  if (selectedSessionId.value && filteredSessionCards.value.some((session) => session.id === selectedSessionId.value)) {
    const runs = gateway.getSwarmRuns(selectedSessionId.value);
    if (runs.length > 0 && !runs.some((run) => run.id === selectedRunId.value)) {
      selectedRunId.value = runs[runs.length - 1]?.id ?? null;
    }
    return;
  }

  const preferred = gateway.currentSessionId && filteredSessionCards.value.some((session) => session.id === gateway.currentSessionId)
    ? gateway.currentSessionId
    : filteredSessionCards.value.find((session) => session.runCount > 0)?.id ?? filteredSessionCards.value[0]?.id ?? null;

  selectedSessionId.value = preferred;
  const runs = gateway.getSwarmRuns(preferred);
  selectedRunId.value = runs[runs.length - 1]?.id ?? null;
}

async function refresh() {
  const result = await gateway.rpc("session.list");
  sessions.value = result as GatewaySession[];
  ensureSelection();
}

async function removeSession(sessionId: string) {
  await gateway.deleteSession(sessionId);
  // Remove from local sessions list too
  sessions.value = sessions.value.filter(s => s.id !== sessionId);
  if (selectedSessionId.value === sessionId) {
    selectedSessionId.value = null;
    selectedRunId.value = null;
  }
  ensureSelection();
}

async function clearArchivedSessions() {
  const archived = filteredSessionCards.value.filter(s => !s.isActive);
  for (const s of archived) {
    await gateway.deleteSession(s.id);
  }
  sessions.value = sessions.value.filter(s => archived.every(a => a.id !== s.id));
  ensureSelection();
}

function selectSession(id: string) {
  selectedSessionId.value = id;
  const runs = gateway.getSwarmRuns(id);
  selectedRunId.value = runs[runs.length - 1]?.id ?? null;
}

function selectRun(runId: string) {
  selectedRunId.value = runId;
}

function syncRouteSelection() {
  const nextSessionId = selectedSessionId.value ?? undefined;
  const nextRunId = selectedRunId.value ?? undefined;
  const currentSessionId = typeof route.query.sessionId === "string" ? route.query.sessionId : undefined;
  const currentRunId = typeof route.query.runId === "string" ? route.query.runId : undefined;

  if (currentSessionId === nextSessionId && currentRunId === nextRunId) return;

  const nextQuery: Record<string, string | string[] | null | undefined> = { ...route.query as Record<string, string> };
  if (nextSessionId) nextQuery.sessionId = nextSessionId;
  else delete nextQuery.sessionId;
  if (nextRunId) nextQuery.runId = nextRunId;
  else delete nextQuery.runId;

  router.replace({
    path: "/sessions",
    query: nextQuery,
  });
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "unknown";
  return parsed.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

watch(() => gateway.swarmSessionHistory, ensureSelection, { deep: true });
watch(filteredSessionCards, ensureSelection, { deep: true });
watch(() => route.query, ensureSelection, { deep: true });
watch([selectedSessionId, selectedRunId], syncRouteSelection);

onMounted(refresh);
</script>

<style scoped>
.sessions-page {
  padding: 1.5rem;
}

.sessions-page__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1.25rem;
}

.sessions-page__title {
  font-size: 1.125rem;
  font-weight: 600;
  color: #f5ecff;
}

.sessions-page__subtitle {
  margin-top: 0.25rem;
  font-size: 0.85rem;
  color: rgba(226, 217, 243, 0.72);
}

.sessions-page__actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.sessions-page__refresh,
.sessions-page__clear {
  border-radius: 0.85rem;
  border: 1px solid rgba(196, 181, 253, 0.18);
  background: rgba(31, 41, 55, 0.78);
  color: #f3f4f6;
  padding: 0.5rem 0.85rem;
  font-size: 0.85rem;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.sessions-page__clear {
  border-color: rgba(239, 68, 68, 0.2);
  color: #fca5a5;
}

.sessions-page__clear:hover {
  border-color: rgba(239, 68, 68, 0.5);
  background: rgba(127, 29, 29, 0.3);
}

.sessions-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-bottom: 1rem;
}

.sessions-filters__search,
.sessions-filters__select {
  border-radius: 0.85rem;
  border: 1px solid rgba(196, 181, 253, 0.18);
  background: rgba(17, 24, 39, 0.82);
  color: #f5ecff;
  padding: 0.65rem 0.8rem;
  font-size: 0.85rem;
}

.sessions-filters__search {
  flex: 1 1 320px;
}

.sessions-filters__select {
  min-width: 190px;
}

.sessions-layout {
  display: grid;
  grid-template-columns: minmax(280px, 360px) minmax(0, 1fr);
  gap: 1rem;
}

.sessions-list {
  display: grid;
  gap: 0.75rem;
  align-content: start;
}

.sessions-list__empty,
.sessions-preview__empty {
  border-radius: 1rem;
  border: 1px solid rgba(107, 114, 128, 0.24);
  background: rgba(17, 24, 39, 0.72);
  padding: 1rem;
  color: rgba(209, 213, 219, 0.72);
}

.session-card {
  text-align: left;
  border-radius: 1rem;
  border: 1px solid rgba(75, 85, 99, 0.3);
  background: rgba(17, 24, 39, 0.82);
  padding: 0.95rem;
  transition: border-color 0.18s ease, transform 0.18s ease, background 0.18s ease;
}

.session-card:hover,
.session-card--active {
  border-color: rgba(168, 85, 247, 0.42);
  background: rgba(36, 21, 59, 0.75);
  transform: translateY(-1px);
}

.session-card__top,
.session-card__meta,
.session-card__history {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
  align-items: center;
}

.session-card__top {
  justify-content: space-between;
}

.session-card__top-right {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.session-card__delete {
  width: 1.35rem;
  height: 1.35rem;
  border-radius: 50%;
  border: 1px solid rgba(239, 68, 68, 0.25);
  background: transparent;
  color: rgba(252, 165, 165, 0.5);
  font-size: 0.6rem;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: border-color 0.15s, color 0.15s, background 0.15s;
  flex-shrink: 0;
}

.session-card__delete:hover {
  border-color: rgba(239, 68, 68, 0.7);
  color: #f87171;
  background: rgba(127, 29, 29, 0.3);
}

.session-card__id {
  font-family: monospace;
  font-size: 0.85rem;
  color: #c4b5fd;
}

.session-card__badge,
.session-card__status {
  border-radius: 9999px;
  padding: 0.18rem 0.5rem;
  font-size: 0.66rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.session-card__badge--active {
  background: rgba(79, 70, 229, 0.2);
  color: #a5b4fc;
}

.session-card__badge--archived {
  background: rgba(55, 65, 81, 0.5);
  color: #d1d5db;
}

.session-card__meta {
  margin-top: 0.55rem;
  font-size: 0.75rem;
  color: rgba(209, 213, 219, 0.7);
}

.session-card__history {
  margin-top: 0.7rem;
  font-size: 0.72rem;
  color: rgba(226, 217, 243, 0.8);
}

.session-card__status--ok {
  background: rgba(20, 83, 45, 0.32);
  color: #86efac;
}

.session-card__status--blocked {
  background: rgba(120, 53, 15, 0.28);
  color: #fcd34d;
}

.session-card__status--error {
  background: rgba(127, 29, 29, 0.28);
  color: #fca5a5;
}

.session-card__objective {
  margin-top: 0.65rem;
  font-size: 0.8rem;
  color: #f5ecff;
  line-height: 1.45;
}

.sessions-preview {
  min-width: 0;
}

@media (max-width: 960px) {
  .sessions-layout {
    grid-template-columns: 1fr;
  }
}
</style>
