<template>
  <div class="missions-page" style="height: 100%; overflow-y: auto">
    <div class="missions-page__header">
      <div>
        <h2 class="missions-page__title">Missions</h2>
        <p class="missions-page__subtitle">
          The flight recorder: every mission's event timeline, cost, and status — who did what, when, and what it cost.
          Cancel reaches the owning process wherever it runs.
        </p>
      </div>
      <div class="missions-page__actions">
        <button class="missions-page__button" :disabled="loading" @click="refresh">{{ loading ? "Loading…" : "Refresh" }}</button>
      </div>
    </div>

    <p v-if="errorMessage" class="missions-page__error">{{ errorMessage }}</p>

    <div v-if="!loading && missions.length === 0" class="missions-page__empty">
      No missions recorded yet. Missions appear once the swarm delegates work with the mission store enabled
      (<code>mission.store: "shadow"</code> or beyond).
    </div>

    <div class="missions-grid">
      <article v-for="mission in missions" :key="mission.id" :class="['mission-card', `mission-card--${mission.status}`]">
        <div class="mission-card__top">
          <div>
            <div class="mission-card__title-row">
              <h3 class="mission-card__title">{{ mission.objective || "(no objective recorded)" }}</h3>
              <span :class="['mission-badge', `mission-badge--${mission.status}`]">{{ mission.status }}</span>
            </div>
            <div class="mission-card__meta">
              Mission {{ shortId(mission.id) }} · Session {{ shortId(mission.rootSessionId) }} ·
              {{ mission.eventCount }} events · {{ formatTokens(mission.budgetTokensSpent) }} tokens ·
              updated {{ formatTime(mission.updatedAt) }}
            </div>
          </div>
          <div class="mission-card__actions">
            <button
              v-if="auth.isOperator && mission.status === 'active'"
              class="mission-card__button mission-card__button--warn"
              :disabled="cancelling === mission.id"
              @click="cancelMission(mission)"
            >
              {{ cancelling === mission.id ? "Cancelling…" : "Cancel" }}
            </button>
            <button class="mission-card__button" @click="toggleTimeline(mission.id)">
              {{ expanded === mission.id ? "Hide timeline" : "Timeline" }}
            </button>
          </div>
        </div>

        <div v-if="expanded === mission.id" class="mission-timeline">
          <div v-if="timelineLoading" class="mission-timeline__loading">Loading timeline…</div>
          <template v-else-if="timeline">
            <div class="mission-timeline__budget">
              <span>Spent: {{ formatTokens(timeline.summary.tokensSpent) }} tokens</span>
              <span>{{ timeline.summary.toolCallsSpent }} tool calls</span>
              <span>{{ formatDuration(timeline.summary.activeTimeMsSpent) }} active</span>
              <span v-if="timeline.budget.limits.tokens > 0">limit {{ formatTokens(timeline.budget.limits.tokens) }}</span>
              <span v-else class="mission-timeline__unlimited">no token ceiling (shadow)</span>
            </div>
            <p v-if="timeline.truncated" class="mission-timeline__truncated">
              Showing the {{ timeline.events.length }} most recent of {{ timeline.summary.eventCount }} events.
            </p>
            <ol class="mission-timeline__list">
              <li v-for="event in timeline.events" :key="event.sequence" class="mission-event">
                <span class="mission-event__seq">#{{ event.sequence }}</span>
                <span :class="['mission-event__type', eventTone(event.type)]">{{ event.type }}</span>
                <span class="mission-event__actor">{{ event.actor }}</span>
                <span class="mission-event__ts">{{ formatTime(event.ts) }}</span>
                <code v-if="payloadPreview(event.payload)" class="mission-event__payload">{{ payloadPreview(event.payload) }}</code>
              </li>
            </ol>
          </template>
        </div>
      </article>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useGatewayStore } from "@/stores/gateway";
import { useAuthStore } from "@/stores/auth";

interface MissionSummary {
  id: string;
  rootSessionId: string;
  objective: string;
  status: string;
  eventCount: number;
  updatedAt: string;
  budgetTokensSpent: number;
}

interface MissionEventRow { sequence: number; type: string; actor: string; ts: string; payload: Record<string, unknown> }

interface FlightRecord {
  mission: MissionSummary;
  events: MissionEventRow[];
  truncated: boolean;
  budget: { limits: { tokens: number }; spent: { tokens: number } };
  summary: { eventCount: number; tokensSpent: number; toolCallsSpent: number; activeTimeMsSpent: number };
}

const gateway = useGatewayStore();
const auth = useAuthStore();

const missions = ref<MissionSummary[]>([]);
const loading = ref(false);
const errorMessage = ref<string | null>(null);
const expanded = ref<string | null>(null);
const timeline = ref<FlightRecord | null>(null);
const timelineLoading = ref(false);
const cancelling = ref<string | null>(null);

function apiBase(): string {
  return gateway.wsUrl.replace(/^ws/, "http").replace(/\/ws$/, "");
}

async function refresh(): Promise<void> {
  loading.value = true;
  errorMessage.value = null;
  try {
    const res = await fetch(`${apiBase()}/api/missions?limit=200`, {
      headers: { Authorization: `Bearer ${gateway.token}` },
    });
    if (!res.ok) { errorMessage.value = `Failed to load missions (${res.status})`; return; }
    const body = await res.json() as { missions: MissionSummary[] };
    missions.value = body.missions;
  } catch (err) {
    errorMessage.value = `Failed to load missions: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    loading.value = false;
  }
}

async function toggleTimeline(id: string): Promise<void> {
  if (expanded.value === id) { expanded.value = null; timeline.value = null; return; }
  expanded.value = id;
  timeline.value = null;
  timelineLoading.value = true;
  try {
    const res = await fetch(`${apiBase()}/api/missions/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${gateway.token}` },
    });
    // Guard against a slow response for a card the operator already collapsed or
    // switched away from — only apply if THIS mission is still the expanded one.
    if (expanded.value !== id) return;
    if (res.ok) timeline.value = await res.json() as FlightRecord;
    else errorMessage.value = `Failed to load timeline (${res.status})`;
  } catch (err) {
    if (expanded.value === id) errorMessage.value = `Failed to load timeline: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    if (expanded.value === id) timelineLoading.value = false;
  }
}

async function cancelMission(mission: MissionSummary): Promise<void> {
  if (!confirm(`Cancel mission "${mission.objective || mission.id}"? The owning process aborts its active turn.`)) return;
  cancelling.value = mission.id;
  try {
    const res = await fetch(`${apiBase()}/api/missions/${encodeURIComponent(mission.id)}/cancel`, {
      method: "POST",
      headers: { Authorization: `Bearer ${gateway.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "cancelled from dashboard" }),
    });
    const body = await res.json().catch(() => ({})) as { status?: string; reason?: string; unconfirmed?: boolean };
    if (res.status === 409 && body.unconfirmed) {
      // Cancel issued but not confirmed — the mission is still running, so leave
      // its status alone and tell the operator why (they can retry).
      errorMessage.value = `Cancel could not be confirmed: ${body.reason ?? "the owning process did not stop the turn"}.`;
      return;
    }
    if (!res.ok) { errorMessage.value = `Cancel failed (${res.status})`; return; }
    // Patch only the changed row instead of refetching all summaries (which
    // re-runs the server-side budget scan just to flip one badge).
    if (body.status) mission.status = body.status;
  } finally {
    cancelling.value = null;
  }
}

function shortId(id: string): string { return id.length > 8 ? id.slice(0, 8) : id; }
function formatTokens(n: number): string { return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n); }
function formatTime(ts: string): string { try { return new Date(ts).toLocaleString(); } catch { return ts; } }
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}min`;
}
function eventTone(type: string): string {
  if (type.includes("failed") || type.includes("cancelled")) return "mission-event__type--bad";
  if (type.includes("completed")) return "mission-event__type--good";
  return "";
}
function payloadPreview(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload);
  if (!json || json === "{}") return "";
  return json.length > 140 ? `${json.slice(0, 140)}…` : json;
}

onMounted(refresh);
</script>

<style scoped>
.missions-page { padding: 1.25rem 1.5rem; }
.missions-page__header { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; margin-bottom: 1rem; }
.missions-page__title { margin: 0 0 0.25rem; font-size: 1.25rem; }
.missions-page__subtitle { margin: 0; color: var(--text-secondary, #8b93a7); font-size: 0.85rem; max-width: 60ch; }
.missions-page__button { padding: 0.4rem 0.9rem; border-radius: 6px; border: 1px solid var(--border-color, #2c3242); background: transparent; color: inherit; cursor: pointer; }
.missions-page__button:disabled { opacity: 0.6; cursor: default; }
.missions-page__error { color: var(--danger, #e5534b); font-size: 0.85rem; }
.missions-page__empty { color: var(--text-secondary, #8b93a7); padding: 2rem 0; font-size: 0.9rem; }
.missions-grid { display: flex; flex-direction: column; gap: 0.75rem; }
.mission-card { border: 1px solid var(--border-color, #2c3242); border-radius: 10px; padding: 0.9rem 1.1rem; }
.mission-card--cancelled, .mission-card--failed { opacity: 0.75; }
.mission-card__top { display: flex; justify-content: space-between; gap: 1rem; align-items: flex-start; }
.mission-card__title-row { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
.mission-card__title { margin: 0; font-size: 0.98rem; font-weight: 600; }
.mission-card__meta { color: var(--text-secondary, #8b93a7); font-size: 0.78rem; margin-top: 0.25rem; }
.mission-card__actions { display: flex; gap: 0.5rem; flex-shrink: 0; }
.mission-card__button { padding: 0.3rem 0.7rem; border-radius: 6px; border: 1px solid var(--border-color, #2c3242); background: transparent; color: inherit; cursor: pointer; font-size: 0.8rem; }
.mission-card__button--warn { border-color: var(--danger, #e5534b); color: var(--danger, #e5534b); }
.mission-badge { font-size: 0.7rem; padding: 0.1rem 0.5rem; border-radius: 999px; border: 1px solid currentColor; text-transform: uppercase; letter-spacing: 0.04em; }
.mission-badge--active { color: var(--accent, #4c8dff); }
.mission-badge--completed { color: var(--success, #3fb950); }
.mission-badge--cancelled, .mission-badge--failed { color: var(--danger, #e5534b); }
.mission-timeline { margin-top: 0.8rem; border-top: 1px dashed var(--border-color, #2c3242); padding-top: 0.7rem; }
.mission-timeline__budget { display: flex; gap: 1rem; flex-wrap: wrap; font-size: 0.78rem; color: var(--text-secondary, #8b93a7); margin-bottom: 0.5rem; }
.mission-timeline__unlimited { font-style: italic; }
.mission-timeline__truncated { font-size: 0.75rem; color: var(--text-secondary, #8b93a7); font-style: italic; margin: 0 0 0.4rem; }
.mission-timeline__loading { color: var(--text-secondary, #8b93a7); font-size: 0.85rem; }
.mission-timeline__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.3rem; }
.mission-event { display: flex; gap: 0.6rem; align-items: baseline; font-size: 0.8rem; flex-wrap: wrap; }
.mission-event__seq { color: var(--text-secondary, #8b93a7); min-width: 2.2rem; }
.mission-event__type { font-weight: 600; }
.mission-event__type--good { color: var(--success, #3fb950); }
.mission-event__type--bad { color: var(--danger, #e5534b); }
.mission-event__actor { color: var(--accent, #4c8dff); }
.mission-event__ts { color: var(--text-secondary, #8b93a7); }
.mission-event__payload { color: var(--text-secondary, #8b93a7); font-size: 0.72rem; overflow-wrap: anywhere; }
</style>
