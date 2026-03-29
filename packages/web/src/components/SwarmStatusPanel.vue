<template>
  <section class="swarm-panel">
    <!-- Always-visible header row -->
    <div class="swarm-panel__header" @click="toggleExpanded">
      <div class="swarm-panel__left">
        <div class="swarm-panel__eyebrow">{{ active ? 'Live swarm state' : 'Latest swarm state' }}</div>
      </div>
      <div class="swarm-panel__right">
        <span class="swarm-panel__stamp">{{ formatTimestamp(state.updatedAt) }}</span>
        <div class="swarm-panel__meta">
          <span v-if="counts.running" class="swarm-pill swarm-pill--running">{{ counts.running }} running</span>
          <span class="swarm-pill swarm-pill--completed">{{ counts.completed }} done</span>
          <span v-if="counts.pending" class="swarm-pill swarm-pill--pending">{{ counts.pending }} pending</span>
          <span v-if="counts.failed" class="swarm-pill swarm-pill--failed">{{ counts.failed }} failed</span>
          <span v-if="counts.blocked" class="swarm-pill swarm-pill--blocked">{{ counts.blocked }} blocked</span>
        </div>
        <button v-if="showArchiveAction" class="swarm-panel__link" @click.stop="$emit('open-archive')">Sessions</button>
        <span class="swarm-panel__chevron">{{ expanded ? '▲' : '▼' }}</span>
      </div>
    </div>

    <!-- Collapsible body -->
    <template v-if="expanded">

      <div v-if="runs.length > 0" class="swarm-runs">
        <button
          v-for="run in runs"
          :key="run.id"
          :class="['swarm-runs__item', selectedRunId === run.id && 'swarm-runs__item--active']"
          @click.stop="$emit('select-run', run.id)"
        >
          <span class="swarm-runs__status" :class="`swarm-runs__status--${run.status}`">{{ run.status }}</span>
          <span class="swarm-runs__time">{{ formatTimestamp(run.recordedAt) }}</span>
        </button>
      </div>

      <!-- Timeline — collapsed by default -->
      <div v-if="timeline.length" class="swarm-timeline">
        <button class="swarm-timeline__toggle" @click.stop="timelineOpen = !timelineOpen">
          <span class="swarm-timeline__label">Mission timeline ({{ timeline.length }})</span>
          <span class="swarm-result__chevron">{{ timelineOpen ? '▲' : '▼' }}</span>
        </button>
        <div v-if="timelineOpen" class="swarm-timeline__list">
          <div v-for="(entry, index) in timeline" :key="`${entry.taskId}-${entry.startedAt}-${index}`" class="swarm-timeline__item">
            <div class="swarm-timeline__dot" :class="`swarm-timeline__dot--${entry.status}`" />
            <div class="swarm-timeline__content">
              <div class="swarm-timeline__headline">
                <span class="swarm-timeline__task">{{ entry.taskTitle }}</span>
                <span class="swarm-timeline__agent">{{ entry.agentName }}</span>
              </div>
              <div class="swarm-timeline__meta">
                <span>{{ entry.status }}</span>
                <span>{{ formatTimestamp(entry.startedAt) }}</span>
                <span v-if="entry.durationLabel">{{ entry.durationLabel }}</span>
                <span v-if="entry.fallback">fallback</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Task cards -->
      <div v-if="tasks.length" class="swarm-grid">
        <article
          v-for="task in tasks"
          :key="task.id"
          :class="['swarm-card', `swarm-card--${task.status}`]"
        >
          <div class="swarm-card__top">
            <div>
              <div class="swarm-card__id">{{ task.id }}</div>
              <div class="swarm-card__title">{{ task.title }}</div>
            </div>
            <span :class="['swarm-card__status', `swarm-card__status--${task.status}`]">{{ task.status }}</span>
          </div>

          <div class="swarm-card__badges">
            <span v-if="taskDuration(task)" class="swarm-mini-badge swarm-mini-badge--duration">{{ taskDuration(task) }}</span>
            <span v-if="taskToolCount(task) > 0" class="swarm-mini-badge swarm-mini-badge--duration">{{ taskToolCount(task) }} tool{{ taskToolCount(task) === 1 ? '' : 's' }}</span>
            <span v-if="taskIterationCount(task) > 0" class="swarm-mini-badge swarm-mini-badge--duration">{{ taskIterationCount(task) }} iter{{ taskIterationCount(task) === 1 ? '' : 's' }}</span>
            <span v-if="fallbackCount(task) > 0" class="swarm-mini-badge swarm-mini-badge--fallback">{{ fallbackCount(task) }} fallback{{ fallbackCount(task) === 1 ? '' : 's' }}</span>
            <span v-if="task.selectedAgent" class="swarm-mini-badge swarm-mini-badge--agent">{{ task.selectedAgent }}</span>
          </div>

          <!-- Error shown inline (always visible — it's important) -->
          <div v-if="task.error" class="swarm-card__note swarm-card__note--error">{{ task.error }}</div>

          <!-- Output toggle -->
          <div v-if="task.output" class="swarm-result">
            <button class="swarm-result__toggle" @click.stop="toggleOutput(task.id)">
              <span>{{ outputLabel(task) }}</span>
              <span class="swarm-result__chevron">{{ outputOpen[task.id] ? '▲' : '▼' }}</span>
            </button>
            <div v-if="outputOpen[task.id]" class="swarm-result__body prose-output" v-html="renderOutput(task.output)" />
          </div>

          <!-- Attempts toggle — only show when there were fallbacks -->
          <div v-if="task.attempts.length > 1" class="swarm-attempts">
            <button class="swarm-attempts__toggle" @click.stop="toggleAttempts(task.id)">
              <span class="swarm-attempts__label">{{ task.attempts.length }} attempts</span>
              <span class="swarm-result__chevron">{{ attemptsOpen[task.id] ? '▲' : '▼' }}</span>
            </button>
            <div v-if="attemptsOpen[task.id]" class="swarm-attempts__list">
              <div v-for="(attempt, index) in task.attempts" :key="`${task.id}-${index}`" class="swarm-attempt">
                <span class="swarm-attempt__agent">{{ attempt.agentName }}</span>
                <span :class="['swarm-attempt__status', `swarm-attempt__status--${attempt.status}`]">{{ attempt.status }}</span>
                <span v-if="attempt.toolCount" class="swarm-attempt__summary">{{ attempt.toolCount }} tool{{ attempt.toolCount === 1 ? '' : 's' }}</span>
                <span v-if="attempt.iterations" class="swarm-attempt__summary">{{ attempt.iterations }} iter{{ attempt.iterations === 1 ? '' : 's' }}</span>
                <span v-if="attempt.summary" class="swarm-attempt__summary">{{ attempt.summary }}</span>
                <span v-if="attempt.toolNames?.length" class="swarm-attempt__summary">{{ summarize(attempt.toolNames.join(', '), 220) }}</span>
              </div>
            </div>
          </div>
        </article>
      </div>
      <div v-else class="swarm-empty">No delegated swarm tasks recorded for this turn yet.</div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { marked } from "marked";
import DOMPurify from "dompurify";
import type { SwarmRunRecord, SwarmState, SwarmTaskState } from "@/stores/gateway";

const props = defineProps<{
  state: SwarmState;
  active?: boolean;
  runs?: SwarmRunRecord[];
  selectedRunId?: string | null;
  showArchiveAction?: boolean;
}>();

defineEmits<{
  (event: "select-run", runId: string): void;
  (event: "open-archive"): void;
}>();

// Auto-expand when active (live run), collapse by default for historical state
const expanded = ref(props.active ?? false);
const timelineOpen = ref(false);

watch(() => props.active, (val) => {
  if (val) expanded.value = true;
});

function toggleExpanded(): void {
  expanded.value = !expanded.value;
}

const statusPriority: Record<SwarmTaskState["status"], number> = {
  running: 0,
  failed: 1,
  blocked: 2,
  pending: 3,
  completed: 4,
};

const tasks = computed(() => Object.values(props.state.tasks).sort((left, right) => {
  const statusDelta = statusPriority[left.status] - statusPriority[right.status];
  if (statusDelta !== 0) return statusDelta;
  return left.id.localeCompare(right.id);
}));

const counts = computed(() => tasks.value.reduce((acc, task) => {
  acc[task.status] += 1;
  return acc;
}, {
  running: 0,
  completed: 0,
  pending: 0,
  failed: 0,
  blocked: 0,
}));

const outputOpen = reactive<Record<string, boolean>>({});
const attemptsOpen = reactive<Record<string, boolean>>({});
const runs = computed(() => props.runs ?? []);

function toggleAttempts(taskId: string): void {
  attemptsOpen[taskId] = !attemptsOpen[taskId];
}

function summarize(text: string, maxLength = 180): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}

function toggleOutput(taskId: string): void {
  outputOpen[taskId] = !outputOpen[taskId];
}

function outputLabel(task: SwarmTaskState): string {
  const writerTask = /proposal|draft|application/i.test(task.title)
    || /proposal_writer|email_drafter|cv_generator/i.test(task.selectedAgent ?? "");
  return writerTask ? "Show generated proposal" : "Show task result";
}

function renderOutput(text: string): string {
  const html = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(html);
}

function taskDuration(task: SwarmTaskState): string | null {
  const firstStart = task.attempts[0]?.startedAt;
  if (!firstStart) return null;
  const lastEnd = task.attempts[task.attempts.length - 1]?.finishedAt ?? props.state.updatedAt;
  return formatDuration(firstStart, lastEnd);
}

function fallbackCount(task: SwarmTaskState): number {
  return Math.max(0, task.attempts.length - 1);
}

function taskToolCount(task: SwarmTaskState): number {
  return task.attempts.reduce((total, attempt) => total + (attempt.toolCount ?? 0), 0);
}

function taskIterationCount(task: SwarmTaskState): number {
  return task.attempts.reduce((total, attempt) => total + (attempt.iterations ?? 0), 0);
}

const timeline = computed(() => Object.values(props.state.tasks)
  .flatMap((task) => task.attempts.map((attempt, index) => ({
    taskId: task.id,
    taskTitle: task.title,
    agentName: attempt.agentName,
    status: attempt.status,
    startedAt: attempt.startedAt,
    durationLabel: attempt.finishedAt ? formatDuration(attempt.startedAt, attempt.finishedAt) : null,
    fallback: index > 0,
    summary: attempt.summary,
  })))
  .sort((left, right) => left.startedAt.localeCompare(right.startedAt)));

function formatDuration(start: string, end: string): string | null {
  const startTime = new Date(start).getTime();
  const endTime = new Date(end).getTime();
  if (Number.isNaN(startTime) || Number.isNaN(endTime) || endTime < startTime) return null;
  const seconds = Math.max(1, Math.round((endTime - startTime) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "just now";
  return parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
</script>

<style scoped>
.swarm-panel {
  border: 1px solid rgba(168, 85, 247, 0.18);
  background:
    linear-gradient(135deg, rgba(36, 21, 59, 0.92), rgba(17, 24, 39, 0.9)),
    radial-gradient(circle at top right, rgba(236, 72, 153, 0.18), transparent 38%);
  border-radius: 1.25rem;
  padding: 1rem;
  box-shadow: 0 12px 40px rgba(8, 10, 24, 0.35);
  backdrop-filter: blur(16px);
}

.swarm-panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  cursor: pointer;
  user-select: none;
}

.swarm-panel__header:hover .swarm-panel__eyebrow {
  color: #e9d5ff;
}

.swarm-panel__left { flex-shrink: 0; }

.swarm-panel__right {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.swarm-panel__chevron {
  font-size: 0.6rem;
  color: rgba(196, 181, 253, 0.5);
  flex-shrink: 0;
}

.swarm-panel__eyebrow {
  font-size: 0.68rem;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: #c084fc;
}

.swarm-panel__meta {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.45rem;
}

.swarm-panel__stamp {
  font-size: 0.68rem;
  color: rgba(226, 217, 243, 0.45);
  white-space: nowrap;
}

.swarm-panel__link {
  border-radius: 9999px;
  border: 1px solid rgba(196, 181, 253, 0.18);
  background: rgba(17, 24, 39, 0.42);
  color: #ddd6fe;
  padding: 0.35rem 0.7rem;
  font-size: 0.72rem;
}

.swarm-runs {
  margin-top: 0.9rem;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.swarm-runs__item {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  border-radius: 9999px;
  border: 1px solid rgba(196, 181, 253, 0.16);
  background: rgba(15, 23, 42, 0.4);
  padding: 0.35rem 0.7rem;
  font-size: 0.72rem;
  color: #ddd6fe;
}

.swarm-runs__item--active {
  border-color: rgba(216, 180, 254, 0.5);
  background: rgba(76, 29, 149, 0.28);
}

.swarm-runs__status {
  text-transform: uppercase;
  font-size: 0.64rem;
  letter-spacing: 0.08em;
}

.swarm-runs__status--ok { color: #86efac; }
.swarm-runs__status--blocked { color: #fcd34d; }
.swarm-runs__status--error { color: #fca5a5; }

.swarm-runs__time { color: rgba(226, 217, 243, 0.72); }

.swarm-timeline {
  margin-top: 1rem;
  border-radius: 1rem;
  border: 1px solid rgba(196, 181, 253, 0.12);
  background: rgba(2, 6, 23, 0.28);
  overflow: hidden;
}

.swarm-timeline__toggle {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.65rem 0.85rem;
  background: transparent;
  color: rgba(196, 181, 253, 0.72);
}

.swarm-timeline__toggle:hover {
  background: rgba(76, 29, 149, 0.12);
}

.swarm-timeline__label {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: rgba(196, 181, 253, 0.72);
}

.swarm-timeline__list {
  padding: 0 0.85rem 0.85rem;
  margin-top: 0.75rem;
  display: grid;
  gap: 0.7rem;
}

.swarm-timeline__item {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.7rem;
}

.swarm-timeline__dot {
  width: 0.7rem;
  height: 0.7rem;
  border-radius: 9999px;
  margin-top: 0.35rem;
  box-shadow: 0 0 0 4px rgba(255, 255, 255, 0.03);
}

.swarm-timeline__dot--running { background: #60a5fa; }
.swarm-timeline__dot--completed { background: #4ade80; }
.swarm-timeline__dot--failed { background: #f87171; }

.swarm-timeline__headline {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: baseline;
}

.swarm-timeline__task { color: #f5ecff; font-weight: 600; }
.swarm-timeline__agent { color: #c4b5fd; font-size: 0.8rem; }

.swarm-timeline__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.18rem;
  font-size: 0.72rem;
  color: rgba(226, 217, 243, 0.7);
}

.swarm-timeline__summary {
  margin-top: 0.24rem;
  font-size: 0.78rem;
  line-height: 1.4;
  color: rgba(226, 217, 243, 0.76);
}

.swarm-pill {
  border-radius: 9999px;
  padding: 0.24rem 0.6rem;
  font-size: 0.72rem;
  border: 1px solid transparent;
}

.swarm-pill--running { background: rgba(59, 130, 246, 0.14); color: #93c5fd; border-color: rgba(59, 130, 246, 0.28); }
.swarm-pill--completed { background: rgba(34, 197, 94, 0.14); color: #86efac; border-color: rgba(34, 197, 94, 0.28); }
.swarm-pill--pending { background: rgba(148, 163, 184, 0.14); color: #cbd5e1; border-color: rgba(148, 163, 184, 0.24); }
.swarm-pill--failed { background: rgba(248, 113, 113, 0.14); color: #fca5a5; border-color: rgba(248, 113, 113, 0.24); }
.swarm-pill--blocked { background: rgba(251, 191, 36, 0.14); color: #fcd34d; border-color: rgba(251, 191, 36, 0.24); }

.swarm-grid {
  margin-top: 0.95rem;
  display: grid;
  gap: 0.75rem;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
}

.swarm-card {
  border-radius: 1rem;
  padding: 0.85rem;
  background: rgba(15, 23, 42, 0.52);
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.swarm-card--running { border-color: rgba(59, 130, 246, 0.25); }
.swarm-card--completed { border-color: rgba(34, 197, 94, 0.24); }
.swarm-card--failed { border-color: rgba(248, 113, 113, 0.24); }
.swarm-card--blocked { border-color: rgba(251, 191, 36, 0.24); }

.swarm-card__top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.8rem;
}

.swarm-card__id {
  font-size: 0.68rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: rgba(196, 181, 253, 0.72);
}

.swarm-card__title {
  margin-top: 0.3rem;
  color: #f5ecff;
  font-weight: 600;
  line-height: 1.4;
}

.swarm-card__status {
  border-radius: 9999px;
  padding: 0.16rem 0.55rem;
  font-size: 0.68rem;
  text-transform: capitalize;
  border: 1px solid transparent;
}

.swarm-card__status--running { color: #93c5fd; background: rgba(59, 130, 246, 0.12); border-color: rgba(59, 130, 246, 0.25); }
.swarm-card__status--completed { color: #86efac; background: rgba(34, 197, 94, 0.12); border-color: rgba(34, 197, 94, 0.22); }
.swarm-card__status--pending { color: #cbd5e1; background: rgba(148, 163, 184, 0.12); border-color: rgba(148, 163, 184, 0.2); }
.swarm-card__status--failed { color: #fca5a5; background: rgba(248, 113, 113, 0.12); border-color: rgba(248, 113, 113, 0.2); }
.swarm-card__status--blocked { color: #fcd34d; background: rgba(251, 191, 36, 0.12); border-color: rgba(251, 191, 36, 0.2); }

.swarm-card__badges {
  margin-top: 0.65rem;
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.swarm-mini-badge {
  border-radius: 9999px;
  padding: 0.16rem 0.5rem;
  font-size: 0.68rem;
  border: 1px solid transparent;
}

.swarm-mini-badge--duration {
  color: #bfdbfe;
  background: rgba(30, 64, 175, 0.18);
  border-color: rgba(96, 165, 250, 0.18);
}

.swarm-mini-badge--fallback {
  color: #fcd34d;
  background: rgba(120, 53, 15, 0.22);
  border-color: rgba(251, 191, 36, 0.18);
}

.swarm-mini-badge--agent {
  color: #c4b5fd;
  background: rgba(76, 29, 149, 0.18);
  border-color: rgba(196, 181, 253, 0.18);
}

.swarm-card__note {
  font-size: 0.8rem;
  line-height: 1.45;
  color: rgba(226, 217, 243, 0.75);
}

.swarm-card__note--error { color: #fca5a5; }

.swarm-result {
  margin-top: 0.7rem;
  border-radius: 0.9rem;
  border: 1px solid rgba(196, 181, 253, 0.12);
  overflow: hidden;
  background: rgba(9, 14, 28, 0.38);
}

.swarm-result__toggle {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.65rem 0.8rem;
  font-size: 0.78rem;
  font-weight: 600;
  color: #d8b4fe;
  background: rgba(76, 29, 149, 0.14);
}

.swarm-result__toggle:hover {
  background: rgba(76, 29, 149, 0.22);
}

.swarm-result__chevron {
  font-size: 0.65rem;
  opacity: 0.8;
}

.swarm-result__body {
  padding: 0.85rem;
  max-height: 20rem;
  overflow: auto;
  color: #ece7f7;
}

.swarm-attempts {
  margin-top: 0.6rem;
  border-radius: 0.75rem;
  border: 1px solid rgba(255, 255, 255, 0.06);
  overflow: hidden;
}

.swarm-attempts__toggle {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.45rem 0.65rem;
  background: transparent;
  color: rgba(196, 181, 253, 0.56);
}

.swarm-attempts__toggle:hover {
  background: rgba(76, 29, 149, 0.1);
}

.swarm-attempts__label {
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: rgba(196, 181, 253, 0.56);
}

.swarm-attempts__list {
  display: grid;
  gap: 0.45rem;
  padding: 0.45rem 0.65rem 0.65rem;
}

.swarm-attempt {
  display: grid;
  gap: 0.22rem;
  padding: 0.45rem 0.55rem;
  border-radius: 0.75rem;
  background: rgba(3, 7, 18, 0.34);
}

.swarm-attempt__agent {
  font-size: 0.78rem;
  font-weight: 600;
  color: #f5ecff;
}

.swarm-attempt__status {
  width: fit-content;
  border-radius: 9999px;
  padding: 0.12rem 0.45rem;
  font-size: 0.68rem;
  text-transform: capitalize;
}

.swarm-attempt__status--running { color: #93c5fd; background: rgba(59, 130, 246, 0.12); }
.swarm-attempt__status--completed { color: #86efac; background: rgba(34, 197, 94, 0.12); }
.swarm-attempt__status--failed { color: #fca5a5; background: rgba(248, 113, 113, 0.12); }

.swarm-attempt__summary {
  font-size: 0.76rem;
  line-height: 1.4;
  color: rgba(226, 217, 243, 0.72);
}

.swarm-empty {
  margin-top: 0.95rem;
  border-radius: 1rem;
  border: 1px dashed rgba(196, 181, 253, 0.18);
  padding: 1rem;
  text-align: center;
  color: rgba(226, 217, 243, 0.68);
}

.prose-output :deep(p) { margin: 0 0 0.65rem; }
.prose-output :deep(p:last-child) { margin-bottom: 0; }
.prose-output :deep(code) {
  background: rgba(168, 85, 247, 0.12);
  color: #e9d5ff;
  padding: 0.08rem 0.35rem;
  border-radius: 0.3rem;
}
.prose-output :deep(pre) {
  margin: 0.65rem 0;
  padding: 0.75rem;
  border-radius: 0.75rem;
  overflow: auto;
  background: rgba(2, 6, 23, 0.72);
  border: 1px solid rgba(168, 85, 247, 0.14);
}
.prose-output :deep(pre code) {
  padding: 0;
  background: none;
}
.prose-output :deep(ul), .prose-output :deep(ol) {
  margin: 0.45rem 0;
  padding-left: 1.2rem;
}
.prose-output :deep(strong) { color: #faf5ff; }

@media (max-width: 768px) {
  .swarm-panel__header {
    flex-direction: column;
  }

  .swarm-panel__meta {
    justify-content: flex-start;
  }

  .swarm-timeline__headline {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.2rem;
  }
}
</style>