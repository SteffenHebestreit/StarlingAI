<template>
  <div class="jobs-page" style="height: calc(100vh - 57px); overflow-y: auto">
    <div class="jobs-page__header">
      <div>
        <h2 class="jobs-page__title">Jobs</h2>
        <p class="jobs-page__subtitle">Monitor queued scene and job runs, cancel active work, and jump back into related sessions.</p>
      </div>
      <div class="jobs-page__actions">
        <button @click="refreshJobs" class="jobs-page__button">Refresh</button>
      </div>
    </div>

    <!-- Scheduled triggers panel — surfaces cron-driven scenes/jobs ambiently
         so operators can see what fires on its own without digging through
         JSONC. Reads from the in-memory scheduler via /api/triggers/cron;
         empty when no triggers are configured. -->
    <section v-if="cronTriggers.length > 0 || cronTriggersLoading" class="ambient-panel">
      <header class="ambient-panel__header">
        <h3 class="ambient-panel__title">Scheduled triggers</h3>
        <span class="ambient-panel__meta">{{ cronTriggers.length }} active · refreshes every 30s</span>
      </header>
      <div class="ambient-panel__grid">
        <article
          v-for="trigger in cronTriggers"
          :key="trigger.id"
          class="trigger-card"
        >
          <div class="trigger-card__top">
            <code class="trigger-card__expression">{{ trigger.expression }}</code>
            <span class="trigger-card__count">fired {{ trigger.fireCount }}×</span>
          </div>
          <h4 class="trigger-card__label">{{ trigger.label }}</h4>
          <p class="trigger-card__action">{{ trigger.action }}</p>
          <div class="trigger-card__times">
            <span>Next: {{ formatTriggerTime(trigger.nextFireAt) }}</span>
            <span>Last: {{ trigger.lastFiredAt ? formatTriggerTime(trigger.lastFiredAt) : "never" }}</span>
          </div>
        </article>
      </div>
    </section>

    <div class="jobs-page__filters">
      <input v-model="searchQuery" type="search" class="jobs-page__search" placeholder="Search by scene, job, tool, or agent">
      <select v-model="statusFilter" class="jobs-page__select">
        <option value="all">All jobs</option>
        <option value="active">Active</option>
        <option value="queued">Queued</option>
        <option value="running">Running</option>
        <option value="cancelling">Cancelling</option>
        <option value="cancelled">Cancelled</option>
        <option value="completed">Completed</option>
        <option value="failed">Failed</option>
      </select>
    </div>

    <div v-if="!filteredJobs.length" class="jobs-page__empty">No jobs match the current filters.</div>

    <div v-else class="jobs-grid">
      <article v-for="job in filteredJobs" :key="job.id" :class="['job-card', jobToneClass(job.status)]">
        <div class="job-card__top">
          <div>
            <div class="job-card__title-row">
              <h3 class="job-card__title">{{ formatSceneName(job.sceneName) }}</h3>
              <span class="badge-store">{{ job.definitionType === 'job' ? 'job' : 'scene' }}</span>
              <span :class="jobBadgeClass(job.status)">{{ job.status }}</span>
            </div>
            <div class="job-card__meta">Job {{ shortJobId(job.id) }} · Session {{ shortJobId(job.sessionId) }}</div>
          </div>
          <div class="job-card__actions">
            <button v-if="isCancelable(job.status)" class="job-card__button job-card__button--warn" @click="scenesStore.cancel(job.id)">Cancel</button>
            <button class="job-card__button" @click="openJobSession(job.sessionId)">Open Session</button>
            <button class="job-card__button" @click="scenesStore.dismissJob(job.id)">Dismiss</button>
          </div>
        </div>

        <div class="job-card__timeline">
          <span>{{ lifecycleLabel(job) }}</span>
          <span v-if="job.completedAt">Finished {{ formatTimestamp(job.completedAt) }}</span>
          <span>{{ Math.round(job.progress.percent ?? 0) }}%</span>
        </div>

        <div class="job-card__progress">
          <div class="job-card__progress-bar" :style="{ width: `${Math.max(0, Math.min(100, job.progress.percent ?? 0))}%` }" />
        </div>

        <p class="job-card__message">{{ job.progress.message ?? 'Waiting for worker updates' }}</p>
        <div v-if="job.progress.totalSteps" class="job-card__detail-row">
          <span>Steps: {{ job.progress.completedSteps ?? 0 }} / {{ job.progress.totalSteps }}</span>
          <span v-if="job.progress.currentStep">Current step: {{ job.progress.currentStep }}</span>
        </div>

        <div class="job-card__stats">
          <div class="job-card__stat">
            <span class="job-card__stat-label">Tools</span>
            <span class="job-card__stat-value">{{ job.progress.toolCallsCompleted }} / {{ job.progress.toolCallsRequested }}</span>
          </div>
          <div class="job-card__stat">
            <span class="job-card__stat-label">Approvals</span>
            <span class="job-card__stat-value">{{ job.progress.approvalsRequested }}</span>
          </div>
          <div class="job-card__stat">
            <span class="job-card__stat-label">Sub-agents</span>
            <span class="job-card__stat-value">{{ job.progress.subAgentsStarted }}</span>
          </div>
          <div class="job-card__stat">
            <span class="job-card__stat-label">Swarm tasks</span>
            <span class="job-card__stat-value">{{ job.progress.swarmTasksCompleted }} / {{ job.progress.swarmTasksTotal }}</span>
          </div>
        </div>

        <div class="job-card__detail-row">
          <span v-if="job.progress.currentAgent">Agent: {{ job.progress.currentAgent }}</span>
          <span v-if="job.progress.currentTool">Tool: {{ job.progress.currentTool }}</span>
          <span v-if="job.performance">Duration: {{ formatDuration(job.performance.turnDurationMs) }}</span>
        </div>

        <p v-if="job.error" class="job-card__error">{{ job.error }}</p>
        <p v-else-if="job.response" class="job-card__response">{{ job.response }}</p>
      </article>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useGatewayStore } from "@/stores/gateway";
import { useScenesStore, type SceneJob } from "@/stores/scenes";

const router = useRouter();
const gateway = useGatewayStore();
const scenesStore = useScenesStore();
const searchQuery = ref("");
const statusFilter = ref<"all" | "active" | SceneJob["status"]>("all");

// ── Scheduled cron triggers ──────────────────────────────────────────────────
interface CronTrigger {
  id: string;
  label: string;
  expression: string;
  action: string;
  createdAt: string;
  lastFiredAt: string | null;
  fireCount: number;
  nextFireAt: string | null;
}
const cronTriggers = ref<CronTrigger[]>([]);
const cronTriggersLoading = ref(false);
let cronTriggersTimer: ReturnType<typeof setInterval> | null = null;

function apiBase(): string {
  return gateway.wsUrl.replace(/^ws/, "http").replace(/\/ws$/, "");
}

async function loadCronTriggers(): Promise<void> {
  if (!gateway.token) return;
  cronTriggersLoading.value = true;
  try {
    const res = await fetch(`${apiBase()}/api/triggers/cron`, {
      headers: { Authorization: `Bearer ${gateway.token}` },
    });
    if (!res.ok) return;
    const data = await res.json() as { jobs?: CronTrigger[] };
    cronTriggers.value = (data.jobs ?? []).slice().sort((a, b) => {
      // Soonest-next-fire first; null next sorts to the end.
      const at = a.nextFireAt ? new Date(a.nextFireAt).getTime() : Number.POSITIVE_INFINITY;
      const bt = b.nextFireAt ? new Date(b.nextFireAt).getTime() : Number.POSITIVE_INFINITY;
      return at - bt;
    });
  } catch {
    /* non-fatal — don't surface to keep the page snappy */
  } finally {
    cronTriggersLoading.value = false;
  }
}

function formatTriggerTime(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const diffMs = parsed.getTime() - Date.now();
  const absMs = Math.abs(diffMs);
  if (absMs < 60_000) return diffMs >= 0 ? "in <1m" : "<1m ago";
  if (absMs < 3_600_000) {
    const mins = Math.round(absMs / 60_000);
    return diffMs >= 0 ? `in ${mins}m` : `${mins}m ago`;
  }
  if (absMs < 86_400_000) {
    const hours = Math.round(absMs / 3_600_000);
    return diffMs >= 0 ? `in ${hours}h` : `${hours}h ago`;
  }
  return parsed.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const serverStatusFilter = computed<SceneJob["status"] | undefined>(() => {
  if (statusFilter.value === "all" || statusFilter.value === "active") return undefined;
  return statusFilter.value;
});

const filteredJobs = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  return scenesStore.recentJobs.filter((job) => {
    if (statusFilter.value === "active" && !isCancelable(job.status)) return false;
    if (statusFilter.value !== "all" && statusFilter.value !== "active" && job.status !== statusFilter.value) return false;
    if (!query) return true;
    return [
      job.id,
      job.sessionId,
      job.sceneName,
      job.progress.message ?? "",
      job.progress.currentAgent ?? "",
      job.progress.currentTool ?? "",
      job.error ?? "",
    ].some((value) => value.toLowerCase().includes(query));
  });
});

async function refreshJobs() {
  await scenesStore.fetchJobs({
    limit: statusFilter.value === "active" ? 100 : 200,
    status: serverStatusFilter.value,
  });
}

async function openJobSession(sessionId: string) {
  const session = gateway.sessions.find((entry) => entry.id === sessionId);
  if (session && !session.archivedAt) {
    await gateway.switchSession(sessionId);
    await router.push({ path: "/" });
    return;
  }

  await router.push({ path: "/sessions", query: { sessionId } });
}

function isCancelable(status: SceneJob["status"]): boolean {
  return status === "queued" || status === "running" || status === "cancelling";
}

function formatSceneName(name: string): string {
  return name.replace(/_/g, " ");
}

function shortJobId(value: string): string {
  return `${value.slice(0, 8)}…`;
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "unknown";
  return parsed.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function lifecycleLabel(job: SceneJob): string {
  if (job.startedAt) return `Started ${formatTimestamp(job.startedAt)}`;
  if (job.createdAt) return `Queued ${formatTimestamp(job.createdAt)}`;
  return "Waiting for worker";
}

function formatDuration(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 ms";
  if (value < 1_000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(1)} s`;
  return `${(value / 60_000).toFixed(1)} min`;
}

function jobBadgeClass(status: SceneJob["status"]): string {
  if (status === "completed") return "job-card__badge job-card__badge--completed";
  if (status === "failed") return "job-card__badge job-card__badge--failed";
  if (status === "cancelled") return "job-card__badge job-card__badge--cancelled";
  if (status === "cancelling") return "job-card__badge job-card__badge--cancelling";
  if (status === "queued") return "job-card__badge job-card__badge--queued";
  return "job-card__badge job-card__badge--running";
}

function jobToneClass(status: SceneJob["status"]): string {
  if (status === "completed") return "job-card--completed";
  if (status === "failed") return "job-card--failed";
  if (status === "cancelled") return "job-card--cancelled";
  if (status === "cancelling") return "job-card--cancelling";
  if (status === "queued") return "job-card--queued";
  return "job-card--running";
}

onMounted(() => {
  void refreshJobs();
  void loadCronTriggers();
  cronTriggersTimer = setInterval(() => { void loadCronTriggers(); }, 30_000);
});

onBeforeUnmount(() => {
  if (cronTriggersTimer) {
    clearInterval(cronTriggersTimer);
    cronTriggersTimer = null;
  }
});

watch(statusFilter, () => {
  void refreshJobs();
});
</script>

<style scoped>
.jobs-page {
  padding: 1.5rem;
}

.jobs-page__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1.25rem;
}

.jobs-page__title {
  font-size: 1.125rem;
  font-weight: 600;
  color: #f5ecff;
}

.jobs-page__subtitle {
  margin-top: 0.25rem;
  font-size: 0.85rem;
  color: rgba(226, 217, 243, 0.72);
}

.jobs-page__button {
  border-radius: 0.85rem;
  border: 1px solid rgba(196, 181, 253, 0.18);
  background: rgba(31, 41, 55, 0.78);
  color: #f3f4f6;
  padding: 0.5rem 0.85rem;
  font-size: 0.85rem;
  cursor: pointer;
}

/* Scheduled triggers panel — ambient view of cron-driven scenes/jobs.
   Sits above the filter row so operators see what fires on its own
   before scrolling into the recent-runs grid. */
.ambient-panel {
  margin-bottom: 1.25rem;
  padding: 0.85rem 1rem 1rem;
  border-radius: 1rem;
  border: 1px solid rgba(56, 189, 248, 0.22);
  background: rgba(8, 47, 73, 0.18);
}

.ambient-panel__header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 0.6rem;
}

.ambient-panel__title {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 600;
  color: rgb(186 230 253);
  letter-spacing: 0.01em;
}

.ambient-panel__meta {
  font-size: 0.72rem;
  color: rgb(125 211 252);
  letter-spacing: 0.04em;
}

.ambient-panel__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(20rem, 1fr));
  gap: 0.6rem;
}

.trigger-card {
  border-radius: 0.85rem;
  border: 1px solid rgba(56, 189, 248, 0.28);
  background: rgba(15, 23, 42, 0.62);
  padding: 0.7rem 0.85rem 0.85rem;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.trigger-card__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.trigger-card__expression {
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 0.78rem;
  background: rgba(56, 189, 248, 0.16);
  color: rgb(186 230 253);
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  letter-spacing: 0.01em;
}

.trigger-card__count {
  font-size: 0.7rem;
  color: rgb(148 163 184);
}

.trigger-card__label {
  margin: 0;
  font-size: 0.92rem;
  color: rgb(243 232 255);
}

.trigger-card__action {
  margin: 0;
  font-size: 0.78rem;
  color: rgb(203 213 225);
}

.trigger-card__times {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  font-size: 0.72rem;
  color: rgb(148 163 184);
  margin-top: 0.2rem;
}

.jobs-page__filters {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-bottom: 1rem;
}

.jobs-page__search,
.jobs-page__select {
  border-radius: 0.85rem;
  border: 1px solid rgba(196, 181, 253, 0.18);
  background: rgba(17, 24, 39, 0.82);
  color: #f5ecff;
  padding: 0.65rem 0.8rem;
  font-size: 0.85rem;
}

.jobs-page__search {
  flex: 1 1 320px;
}

.jobs-page__select {
  min-width: 180px;
}

.jobs-page__empty {
  border-radius: 1rem;
  border: 1px solid rgba(107, 114, 128, 0.24);
  background: rgba(17, 24, 39, 0.72);
  padding: 1rem;
  color: rgba(209, 213, 219, 0.72);
}

.jobs-grid {
  display: grid;
  gap: 1rem;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
}

.job-card {
  border-radius: 1.1rem;
  border: 1px solid rgba(75, 85, 99, 0.3);
  background: rgba(17, 24, 39, 0.84);
  padding: 1rem;
}

.job-card--queued {
  border-color: rgba(99, 102, 241, 0.32);
}

.job-card--running {
  border-color: rgba(56, 189, 248, 0.3);
}

.job-card--cancelling {
  border-color: rgba(245, 158, 11, 0.3);
}

.job-card--cancelled {
  border-color: rgba(107, 114, 128, 0.3);
}

.job-card--completed {
  border-color: rgba(16, 185, 129, 0.3);
}

.job-card--failed {
  border-color: rgba(239, 68, 68, 0.3);
}

.job-card__top,
.job-card__timeline,
.job-card__detail-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
  align-items: center;
  justify-content: space-between;
}

.job-card__title-row,
.job-card__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
}

.job-card__title {
  font-size: 1rem;
  color: #f8fafc;
}

.job-card__meta,
.job-card__timeline,
.job-card__detail-row {
  margin-top: 0.45rem;
  font-size: 0.74rem;
  color: rgba(209, 213, 219, 0.7);
}

.job-card__badge {
  border-radius: 9999px;
  padding: 0.18rem 0.5rem;
  font-size: 0.66rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.job-card__badge--queued {
  background: rgba(99, 102, 241, 0.16);
  color: #c7d2fe;
}

.job-card__badge--running {
  background: rgba(14, 165, 233, 0.16);
  color: #bae6fd;
}

.job-card__badge--cancelling {
  background: rgba(245, 158, 11, 0.16);
  color: #fde68a;
}

.job-card__badge--cancelled {
  background: rgba(107, 114, 128, 0.16);
  color: #d1d5db;
}

.job-card__badge--completed {
  background: rgba(16, 185, 129, 0.16);
  color: #a7f3d0;
}

.job-card__badge--failed {
  background: rgba(239, 68, 68, 0.16);
  color: #fecaca;
}

.job-card__button {
  border-radius: 9999px;
  border: 1px solid rgba(148, 163, 184, 0.2);
  background: rgba(15, 23, 42, 0.72);
  color: #e2e8f0;
  padding: 0.35rem 0.65rem;
  font-size: 0.72rem;
  cursor: pointer;
}

.job-card__button--warn {
  border-color: rgba(245, 158, 11, 0.24);
  color: #fde68a;
}

.job-card__progress {
  margin-top: 0.8rem;
  height: 0.42rem;
  overflow: hidden;
  border-radius: 9999px;
  background: rgba(15, 23, 42, 0.72);
}

.job-card__progress-bar {
  height: 100%;
  border-radius: 9999px;
  background: linear-gradient(90deg, #38bdf8, #67e8f9, #34d399);
  transition: width 0.3s ease;
}

.job-card__message {
  margin-top: 0.7rem;
  font-size: 0.82rem;
  color: #e2e8f0;
}

.job-card__stats {
  margin-top: 0.85rem;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.6rem;
}

.job-card__stat {
  border-radius: 0.9rem;
  background: rgba(15, 23, 42, 0.55);
  padding: 0.65rem 0.75rem;
}

.job-card__stat-label {
  display: block;
  font-size: 0.68rem;
  color: rgba(148, 163, 184, 0.8);
}

.job-card__stat-value {
  display: block;
  margin-top: 0.2rem;
  font-size: 0.82rem;
  color: #f8fafc;
}

.job-card__error {
  margin-top: 0.8rem;
  color: #fecaca;
  font-size: 0.78rem;
}

.job-card__response {
  margin-top: 0.8rem;
  color: rgba(226, 232, 240, 0.88);
  font-size: 0.78rem;
  line-height: 1.5;
}

@media (max-width: 720px) {
  .job-card__top {
    flex-direction: column;
    align-items: flex-start;
  }

  .job-card__actions {
    width: 100%;
  }
}
</style>