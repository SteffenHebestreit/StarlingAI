<template>
  <div class="page-shell jobs-page">
    <header class="page-header">
      <div class="page-header__text">
        <h1 class="page-title">Jobs</h1>
        <p class="page-subtitle">Monitor queued scene and job runs, cancel active work, and jump back into related sessions.</p>
      </div>
      <div class="page-actions">
        <button type="button" class="btn-ghost px-4 py-2 rounded-xl text-sm" :disabled="refreshing" @click="refreshJobs">
          {{ refreshing ? "Refreshing…" : "Refresh" }}
        </button>
        <button
          v-if="finishedJobCount > 0"
          type="button"
          class="btn-danger px-4 py-2 rounded-xl text-sm"
          :disabled="clearingFinished"
          :title="`Delete every finished run from the store (${finishedJobCount})`"
          @click="clearFinished"
        >
          {{ clearingFinished ? "Clearing…" : `Clear finished (${finishedJobCount})` }}
        </button>
      </div>
    </header>

    <!-- What the assistant was asked to run later, to repeat or to watch (schedule_task): each
         with what it waits for, when it runs next, and a way to stop it without asking in a chat. -->
    <section v-if="schedules.length > 0 || schedulesError" class="ambient-panel">
      <header class="ambient-panel__header">
        <h3 class="ambient-panel__title">Follow-ups</h3>
        <span class="ambient-panel__meta">{{ schedules.length }} scheduled · results are posted into their conversation</span>
      </header>
      <p v-if="schedulesError" class="notice notice--error" role="alert">{{ schedulesError }}</p>
      <div class="ambient-panel__grid">
        <article v-for="schedule in schedules" :key="schedule.id" class="trigger-card">
          <div class="trigger-card__top">
            <code class="trigger-card__expression">{{ scheduleWhen(schedule) }}</code>
            <span class="trigger-card__count">{{ scheduleRuns(schedule) }}</span>
          </div>
          <h4 class="trigger-card__label">{{ schedule.label }}</h4>
          <p class="trigger-card__action">{{ schedule.task }}</p>
          <p v-if="schedule.until" class="trigger-card__note">Says nothing until: {{ schedule.until }}</p>
          <p v-if="schedule.disabled" class="trigger-card__note">Does not run: {{ schedule.disabled }}</p>
          <p v-if="schedule.userId" class="trigger-card__note">Owner: {{ schedule.userId }}</p>
          <div class="trigger-card__times">
            <span :title="isoTimestamp(schedule.nextRunAt)">Next: {{ formatTriggerTime(schedule.nextRunAt) }}</span>
            <span :title="isoTimestamp(schedule.lastRunAt)">Last: {{ schedule.lastRunAt ? `${formatTriggerTime(schedule.lastRunAt)}, ${lastOutcomeText(schedule.lastOutcome)}` : "never" }}</span>
          </div>
          <div class="trigger-card__actions">
            <button v-if="schedule.sessionId" type="button" class="btn-ghost px-3 py-1.5 rounded-lg text-sm" @click="openJobSession(schedule.sessionId)">Open conversation</button>
            <button
              type="button"
              class="btn-danger px-3 py-1.5 rounded-lg text-sm"
              :disabled="removingScheduleIds.has(schedule.id)"
              @click="removeSchedule(schedule)"
            >
              {{ removingScheduleIds.has(schedule.id) ? "Removing…" : "Remove" }}
            </button>
          </div>
        </article>
      </div>
    </section>

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
            <span :title="isoTimestamp(trigger.nextFireAt)">Next: {{ formatTriggerTime(trigger.nextFireAt) }}</span>
            <span :title="isoTimestamp(trigger.lastFiredAt)">Last: {{ trigger.lastFiredAt ? formatTriggerTime(trigger.lastFiredAt) : "never" }}</span>
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

    <div v-if="runErrorText" class="notice notice--error jobs-page__error" role="alert">
      The last jobs request failed: {{ runErrorText }}
    </div>

    <!-- "No jobs" is only true after a load that worked: before that the list is still loading,
         and after a failed one the notice above says so. -->
    <div v-if="!filteredJobs.length && refreshing && !jobsLoaded" class="jobs-page__empty">Loading jobs…</div>
    <!-- An empty list is one of two things: the filter hides every run, or nothing has run. -->
    <div v-else-if="!filteredJobs.length && jobsLoaded && filtersActive" class="empty-state">
      <p>{{ noMatchLine("jobs", searchQuery, statusFilter !== "all") }}</p>
      <p v-if="loadedSpan" class="mt-1 text-xs">Only {{ loadedSpan }} were looked through — older ones are not loaded.</p>
      <button type="button" class="btn-ghost mt-3 px-4 py-2 rounded-xl text-sm" @click="clearFilters">Clear filters</button>
    </div>
    <div v-else-if="!filteredJobs.length && jobsLoaded" class="empty-state">
      No runs yet. One is listed here each time a scene or job is started — from the chat, on a schedule,
      by a webhook or by a channel trigger.
    </div>

    <div v-else-if="filteredJobs.length" class="jobs-grid">
      <article v-for="job in jobWindow.visible" :key="job.id" :class="['job-card', jobToneClass(job.status)]">
        <div class="job-card__top">
          <div>
            <div class="job-card__title-row">
              <h3 class="job-card__title">{{ formatSceneName(job.sceneName) }}</h3>
              <span class="badge-store">{{ job.definitionType === 'job' ? 'job' : 'scene' }}</span>
              <span :class="jobBadgeClass(job.status)">{{ job.status }}</span>
            </div>
            <div class="job-card__meta">
              Job
              <button
                type="button"
                class="job-card__id"
                :title="`${job.id} — click to copy`"
                :aria-label="`Copy job id ${job.id}`"
                @click="copyId('Job', job.id)"
              >{{ shortJobId(job.id) }}</button>
              · Session
              <button
                type="button"
                class="job-card__id"
                :title="`${job.sessionId} — click to copy`"
                :aria-label="`Copy session id ${job.sessionId}`"
                @click="copyId('Session', job.sessionId)"
              >{{ shortJobId(job.sessionId) }}</button>
            </div>
          </div>
          <div class="job-card__actions">
            <button
              v-if="isCancelable(job.status)"
              type="button"
              class="btn-danger px-3 py-1.5 rounded-lg text-sm"
              :disabled="cancellingIds.has(job.id)"
              @click="cancelJob(job)"
            >
              {{ cancellingIds.has(job.id) ? "Cancelling…" : "Cancel" }}
            </button>
            <button type="button" class="btn-ghost px-3 py-1.5 rounded-lg text-sm" @click="openJobSession(job.sessionId)">Open Session</button>
            <button
              v-if="!isCancelable(job.status)"
              type="button"
              class="btn-danger px-3 py-1.5 rounded-lg text-sm"
              :disabled="deletingIds.has(job.id)"
              title="Remove this run from the store (the session transcript is kept)"
              @click="deleteRun(job)"
            >
              {{ deletingIds.has(job.id) ? "Deleting…" : "Delete" }}
            </button>
          </div>
        </div>

        <div class="job-card__timeline">
          <span :title="isoTimestamp(job.startedAt ?? job.createdAt)">{{ lifecycleLabel(job) }}</span>
          <span v-if="job.completedAt" :title="isoTimestamp(job.completedAt)">Finished {{ formatDateTime(job.completedAt) }}</span>
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

    <div v-if="filteredJobs.length && (jobWindow.paged || loadCapNote)" class="mt-4 flex flex-col items-center gap-2 text-center">
      <button v-if="jobWindow.hasMore" type="button" class="btn-ghost px-4 py-2 rounded-xl text-sm" @click="jobWindow.showMore()">
        Show {{ jobWindow.nextStep }} more
      </button>
      <p class="text-xs text-gray-400" aria-live="polite">
        {{ jobWindow.summary }} jobs<template v-if="loadCapNote"> · {{ loadCapNote }}</template>
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useGatewayStore } from "@/stores/gateway";
import { useScenesStore, type SceneJob } from "@/stores/scenes";
import { writeClipboard } from "@/composables/clipboard";
import { formatDateTime, isoTimestamp } from "@/composables/formatDate";
import { noMatchLine, useListWindow } from "@/composables/listWindow";
import { confirmAction } from "@/composables/useConfirm";
import { useLoadWhenConnected } from "@/composables/useLoadWhenConnected";
import { useToast } from "@/composables/useToast";

const router = useRouter();
const gateway = useGatewayStore();
const scenesStore = useScenesStore();
const toast = useToast();
const searchQuery = ref("");
const statusFilter = ref<"all" | "active" | SceneJob["status"]>("all");
// Tracks per-row in-flight delete calls (button disabled state).
const deletingIds = ref<Set<string>>(new Set());
// Same for cancel calls.
const cancellingIds = ref<Set<string>>(new Set());
const clearingFinished = ref(false);
const refreshing = ref(false);
// True while the list on screen comes from a load that succeeded.
const jobsLoaded = ref(false);
// What the load on screen asked the gateway for.
const loadedQuery = ref<{ limit: number; status: "all" | "active" | SceneJob["status"] } | null>(null);

const runErrorText = computed(() => scenesStore.runError ?? "");

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

// ── Follow-ups: the scheduled tasks of schedule_task ────────────────────────────────────────
interface Schedule {
  id: string;
  label: string;
  task: string;
  cron?: string;
  at?: string;
  timeZone?: string;
  until?: string;
  maxRuns?: number;
  runs: number;
  lastRunAt?: string;
  lastOutcome?: "reported" | "nothing_new" | "failed";
  nextRunAt?: string;
  sessionId?: string;
  createdAt: string;
  disabled?: string;
  /** Only in an admin's listing: whose schedule it is. */
  userId?: string;
}
const schedules = ref<Schedule[]>([]);
const schedulesError = ref("");
const removingScheduleIds = ref<Set<string>>(new Set());

async function loadSchedules(): Promise<void> {
  if (!gateway.token) return;
  try {
    const res = await fetch(`${apiBase()}/api/schedules`, { headers: { Authorization: `Bearer ${gateway.token}` } });
    // A gateway from before follow-ups has no such route: then there is nothing to show, not an error.
    if (res.status === 404) { schedules.value = []; schedulesError.value = ""; return; }
    if (!res.ok) { schedulesError.value = `The follow-ups could not be loaded (HTTP ${res.status}).`; return; }
    const data = await res.json() as { schedules?: Schedule[] };
    schedules.value = Array.isArray(data.schedules) ? data.schedules : [];
    schedulesError.value = "";
  } catch (error) {
    schedulesError.value = `The follow-ups could not be loaded: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** When it runs: a cron expression on its maker's clock, or the one time, shown on this browser's. */
function scheduleWhen(schedule: Schedule): string {
  if (schedule.cron) return `${schedule.cron} (${schedule.timeZone ?? "UTC"})`;
  return schedule.at ? `once · ${formatDateTime(schedule.at)}` : "—";
}

function scheduleRuns(schedule: Schedule): string {
  const limit = schedule.maxRuns !== undefined ? ` of ${schedule.maxRuns}` : "";
  return `${schedule.runs}${limit} run${schedule.runs === 1 && !limit ? "" : "s"}`;
}

function lastOutcomeText(outcome: Schedule["lastOutcome"]): string {
  if (outcome === "failed") return "failed";
  if (outcome === "nothing_new") return "nothing new";
  return "posted";
}

async function removeSchedule(schedule: Schedule): Promise<void> {
  if (removingScheduleIds.value.has(schedule.id)) return;
  if (!(await confirmAction({
    title: "Remove this follow-up?",
    message: `"${schedule.label}" does not run again. What it already posted stays in its conversation.`,
    confirmLabel: "Remove",
    cancelLabel: "Keep it",
    danger: true,
  }))) return;
  removingScheduleIds.value = new Set(removingScheduleIds.value).add(schedule.id);
  try {
    const res = await fetch(`${apiBase()}/api/schedules/${encodeURIComponent(schedule.id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${gateway.token}` },
    });
    if (!res.ok && res.status !== 404) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      toast.error("Couldn't remove the follow-up", body.error ?? `The gateway answered HTTP ${res.status}.`);
      return;
    }
    schedules.value = schedules.value.filter((entry) => entry.id !== schedule.id);
    toast.success("Follow-up removed", `"${schedule.label}" does not run again.`);
  } catch (error) {
    toast.error("Couldn't remove the follow-up", error instanceof Error ? error.message : String(error));
  } finally {
    const next = new Set(removingScheduleIds.value);
    next.delete(schedule.id);
    removingScheduleIds.value = next;
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
  return formatDateTime(parsed);
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

const filtersActive = computed(() => searchQuery.value.trim() !== "" || statusFilter.value !== "all");

function clearFilters() {
  searchQuery.value = "";
  // The watcher below loads the unfiltered list.
  statusFilter.value = "all";
}

// The cards are drawn a page at a time; a new search or status starts again at the first page.
const jobWindow = useListWindow(() => filteredJobs.value, {
  resetKey: () => `${statusFilter.value}|${searchQuery.value.trim().toLowerCase()}`,
});

// The gateway sends the newest runs up to the limit it is asked for, 200 at most, and cannot be
// asked for the ones before them. A full answer therefore means "there may be older runs", and
// the count line says so. The status is applied by the gateway before the limit, so a status
// reaches further back than "All jobs" does.
// What a full answer covers ("the newest 200 failed runs"); empty when the answer was not full.
const loadedSpan = computed(() => {
  const loaded = loadedQuery.value;
  if (!loaded || scenesStore.recentJobs.length < loaded.limit) return "";
  const kind = loaded.status === "all" || loaded.status === "active" ? "" : `${loaded.status} `;
  return `the newest ${loaded.limit} ${kind}runs`;
});
const loadCapNote = computed(() => {
  if (!loadedSpan.value) return "";
  const note = `${loadedSpan.value} — older ones are not loaded`;
  if (loadedQuery.value?.status === "active") return `from ${note}`;
  return loadedQuery.value?.status === "all" ? `${note}; pick a status to reach further back` : note;
});

async function refreshJobs() {
  refreshing.value = true;
  const status = statusFilter.value;
  const limit = status === "active" ? 100 : 200;
  try {
    await scenesStore.fetchJobs({
      limit,
      status: serverStatusFilter.value,
    });
    jobsLoaded.value = scenesStore.runError === null;
    if (jobsLoaded.value) loadedQuery.value = { limit, status };
  } finally {
    refreshing.value = false;
  }
}

// Counts finished (non-active) jobs across the current local list, used by
// the "Clear finished" page button.
const finishedJobCount = computed(() =>
  scenesStore.recentJobs.filter((j) => j.status === "completed" || j.status === "failed" || j.status === "cancelled").length
);

async function cancelJob(job: SceneJob) {
  if (cancellingIds.value.has(job.id)) return;
  const name = formatSceneName(job.sceneName);
  if (!(await confirmAction({
    title: "Cancel this job?",
    message: `"${name}" is stopped before it finishes. A cancelled run cannot be resumed — it would have to be started again from the beginning.`,
    confirmLabel: "Cancel job",
    cancelLabel: "Keep running",
    danger: true,
  }))) return;
  cancellingIds.value = new Set(cancellingIds.value).add(job.id);
  try {
    const cancelled = await scenesStore.cancel(job.id);
    if (!cancelled) {
      toast.error("Couldn't cancel the job", runErrorText.value || "The gateway did not accept the cancel request.");
    } else if (cancelled.status === "cancelled") {
      toast.success("Job cancelled", `"${name}" has stopped.`);
    } else {
      toast.success("Cancel requested", `"${name}" is stopping; its card updates when the worker confirms.`);
    }
  } finally {
    const next = new Set(cancellingIds.value);
    next.delete(job.id);
    cancellingIds.value = next;
  }
}

async function deleteRun(job: SceneJob) {
  if (deletingIds.value.has(job.id)) return;
  const name = formatSceneName(job.sceneName);
  if (!(await confirmAction({
    title: "Delete this run?",
    message: `Run ${shortJobId(job.id)} of "${name}" is removed from the store and cannot be restored. The session transcript is kept.`,
    confirmLabel: "Delete run",
    danger: true,
  }))) return;
  deletingIds.value = new Set(deletingIds.value).add(job.id);
  try {
    const r = await scenesStore.deleteRun(job.id);
    if (r.ok) toast.success("Run deleted", `Run ${shortJobId(job.id)} of "${name}" was removed from the store.`);
    else toast.error("Couldn't delete the run", r.error || "Unknown error");
  } finally {
    const next = new Set(deletingIds.value);
    next.delete(job.id);
    deletingIds.value = next;
  }
}

async function clearFinished() {
  const n = finishedJobCount.value;
  if (n === 0) return;
  if (!(await confirmAction({
    title: `Delete ${n} finished run${n === 1 ? "" : "s"}?`,
    message: "They are removed from the store and cannot be restored. Session transcripts are kept. Active runs are not affected.",
    confirmLabel: "Delete finished runs",
    danger: true,
  }))) return;
  clearingFinished.value = true;
  try {
    const r = await scenesStore.clearFinishedRuns();
    if (r.failed > 0) {
      toast.error(
        "Some runs could not be deleted",
        `Deleted ${r.deleted}; ${r.failed} could not be deleted (they may have become active again).`,
      );
    } else {
      toast.success("Finished runs cleared", `${r.deleted} run${r.deleted === 1 ? "" : "s"} removed from the store.`);
    }
  } finally {
    clearingFinished.value = false;
  }
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

// The cards show ids cut to eight characters; this is how to get a whole one.
async function copyId(what: string, id: string): Promise<void> {
  try {
    await writeClipboard(id);
    toast.success("Copied", `${what} id is on the clipboard.`);
  } catch {
    toast.error("Couldn't copy", `The browser refused the clipboard. ${what} id: ${id}`);
  }
}

function lifecycleLabel(job: SceneJob): string {
  if (job.startedAt) return `Started ${formatDateTime(job.startedAt)}`;
  if (job.createdAt) return `Queued ${formatDateTime(job.createdAt)}`;
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

// Also when the gateway comes up after the page did (opened by URL, or signed in to here).
useLoadWhenConnected(() => {
  void refreshJobs();
  void loadCronTriggers();
  void loadSchedules();
});

onMounted(() => {
  cronTriggersTimer = setInterval(() => { void loadCronTriggers(); void loadSchedules(); }, 30_000);
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

.trigger-card__note {
  margin: 0;
  font-size: 0.74rem;
  color: rgb(148 163 184);
  overflow-wrap: anywhere;
}

.trigger-card__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.5rem;
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

.jobs-page__error {
  margin-bottom: 1rem;
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

/* An id is shown cut short: the button holds all of it (title) and copies it. */
.job-card__id {
  text-decoration: underline dotted;
  text-underline-offset: 2px;
  cursor: copy;
}
.job-card__id:hover {
  color: #f8fafc;
}
.job-card__id:focus-visible {
  outline: 2px solid rgba(var(--logo-cyan), 0.7);
  outline-offset: 2px;
  border-radius: 2px;
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