<template>
  <div v-if="rows.length || (isStreaming && liveText)" class="tss">
    <!-- Finished turns get a one-line header that folds the stream away. Older answers start
         folded so scrolling back through a session is not scrolling past every step ever taken. -->
    <button
      v-if="!isStreaming && rows.length > 0"
      type="button"
      class="tss-header"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <span class="tss-header__chevron" aria-hidden="true">{{ expanded ? '▾' : '▸' }}</span>
      <span>{{ headerText }}</span>
    </button>

    <!-- A step waiting on the user keeps its list open: its card is under the row, and a folded
         segment would hide the question the turn is stuck on. -->
    <ol v-if="expanded || isStreaming || hasAwaiting" class="tss-list">
      <li
        v-for="row in rows"
        :key="row.step.id"
        :class="[
          'tss-row',
          `tss-row--${row.status}`,
          { 'tss-row--nested': row.step.depth === 1, 'tss-row--note': row.step.kind === 'note' },
        ]"
      >
        <!-- Narration: a sentence the runtime said between steps. Nothing more to open. -->
        <p v-if="row.step.kind === 'note'" class="tss-note">{{ row.title }}</p>

        <button
          v-else
          type="button"
          class="tss-row__btn"
          :title="row.tooltip"
          @click="emit('select', row.step.id)"
        >
          <span class="tss-mark" aria-hidden="true">
            <span v-if="row.step.status === 'running'" class="tss-spinner" />
            <template v-else>{{ markFor(row.status) }}</template>
          </span>
          <!-- The glyph is decorative, so the status is spoken separately: without this a
               failed step read exactly like a successful one to a screen reader. -->
          <span class="tss-sr">{{ statusWord(row.status) }}:</span>
          <span v-if="row.agentTag" class="tss-agent">{{ row.agentTag }}</span>
          <span class="tss-title">{{ row.title }}</span>
          <span v-if="row.subject" class="tss-subject">{{ row.subject }}</span>
          <span v-if="row.detail" :class="['tss-detail', { 'tss-detail--live': row.step.status === 'running' }]">
            {{ row.detail }}
          </span>
          <span v-if="row.duration" class="tss-time">{{ row.duration }}</span>
        </button>

        <!-- The question this step is waiting on, right under it (see userInputs). -->
        <div v-if="awaiting?.[row.step.id]" class="tss-input">
          <slot name="input" :step-id="row.step.id" />
        </div>
      </li>

      <!-- What is happening right now, when no step row says it — routing, synthesis. -->
      <li v-if="isStreaming && liveText && !anyVisibleRunning" class="tss-row tss-row--live">
        <span class="tss-mark" aria-hidden="true"><span class="tss-spinner" /></span>
        <span class="tss-detail tss-detail--live">{{ liveText }}</span>
      </li>
    </ol>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import {
  delegationTarget,
  displayStatus,
  formatDuration,
  isQuietStep,
  stepDurationMs,
  stepHint,
  stepOutcome,
  stepSubject,
  stepTitle,
  turnSpanMs,
  type StepDisplayStatus,
  type TurnStep,
} from "@/composables/turnSteps";
import { awaitingStepHint, awaitingStepTitle } from "@/composables/userInputs";

const props = defineProps<{
  steps: TurnStep[];
  isStreaming?: boolean;
  /** The live status line, shown when no running step already says what is happening. */
  liveText?: string;
  /** Start folded — for answers that are no longer the latest. */
  startCollapsed?: boolean;
  /** Steps waiting on the user's answer: their row says so, and the `input` slot renders under them. */
  awaiting?: Record<string, { kind: string; expiresAt: string }>;
}>();

const emit = defineEmits<{
  /** Open this step's detail in the side panel. */
  select: [stepId: string];
}>();

const expanded = ref(!props.startCollapsed);
watch(() => props.startCollapsed, (collapsed) => { expanded.value = !collapsed; });

// A running step shows a live elapsed time, so the clock ticks only while something runs —
// a finished transcript of fifty turns should not be re-rendering once a second.
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
// Only rows that are actually shown count: a hidden bookkeeping call that is still running
// must neither keep the clock ticking nor suppress the live status line.
const anyVisibleRunning = computed(() => props.steps.some(step => step.status === "running" && !isQuietStep(step)));
watch(anyVisibleRunning, (running) => {
  if (running && !timer) {
    timer = setInterval(() => { now.value = Date.now(); }, 1000);
  } else if (!running && timer) {
    clearInterval(timer);
    timer = undefined;
  }
}, { immediate: true });
onBeforeUnmount(() => { if (timer) clearInterval(timer); });

const rows = computed(() => {
  // A nested row normally belongs to the delegation just above it. When it does not — a
  // coordinator's own specialists, or several running in parallel — it names its agent, or
  // three web_search rows from three specialists would be indistinguishable.
  let parentTarget: string | undefined;
  return props.steps.filter(step => !isQuietStep(step)).map(step => {
    if (step.depth === 0 && step.kind === "tool") parentTarget = delegationTarget(step);
    const agentTag = step.depth === 1 && step.agent && step.agent !== parentTarget && step.name !== "specialist_run"
      ? step.agent
      : undefined;
    return { ...describe(step), agentTag };
  });
});

const hasAwaiting = computed(() => Boolean(props.awaiting && props.steps.some(step => props.awaiting![step.id])));

function describe(step: TurnStep) {
  const waiting = step.status === "running" ? props.awaiting?.[step.id] : undefined;
  const title = waiting ? awaitingStepTitle(waiting.kind) : stepTitle(step);
  const outcome = stepOutcome(step);
  // While running: the specialist's own progress line if it sent one, otherwise what to
  // expect. Finished: how it came out. While it waits on the user, neither — the countdown.
  const detail = waiting
    ? awaitingStepHint(waiting.expiresAt, now.value)
    : step.status === "running" ? (step.progress ?? stepHint(step, now.value)) : outcome;
  const duration = formatDuration(stepDurationMs(step, now.value));
  const waited = step.userInput?.waitedMs;
  return {
    step,
    status: displayStatus(step),
    title,
    subject: stepSubject(step),
    detail,
    duration,
    tooltip: [
      step.agent ? `inside ${step.agent}` : undefined,
      step.kind === "tool" ? step.name : undefined,
      // The row's time leaves the wait out; this is where it is still told.
      waited ? `waited ${formatDuration(waited)} for your answer` : undefined,
      "click for details",
    ].filter(Boolean).join(" · "),
  };
}

const toolCount = computed(() => props.steps.filter(step => step.kind === "tool" && !isQuietStep(step)).length);

const headerText = computed(() => {
  const agents = [...new Set(props.steps
    .filter(step => step.depth === 0 && step.kind === "tool")
    .map(delegationTarget)
    .filter((name): name is string => Boolean(name)))];
  // A render the user skipped is their choice, not a failure of the turn.
  const failed = props.steps.filter(step => displayStatus(step) === "failed").length;
  const span = formatDuration(turnSpanMs(props.steps, now.value));
  // A turn can consist of narration only (a steering or correction line and no tool call);
  // it still needs a header, or folding it made the whole record disappear.
  const notes = rows.value.length - toolCount.value;
  return [
    toolCount.value
      ? `${toolCount.value} step${toolCount.value === 1 ? "" : "s"}`
      : `${notes} note${notes === 1 ? "" : "s"}`,
    agents.length ? agents.join(", ") : undefined,
    failed ? `${failed} failed` : undefined,
    span || undefined,
  ].filter(Boolean).join(" · ");
});

function statusWord(status: StepDisplayStatus): string {
  if (status === "running") return "running";
  if (status === "failed") return "failed";
  if (status === "stopped") return "no result";
  if (status === "skipped") return "skipped by you";
  return "done";
}

function markFor(status: StepDisplayStatus): string {
  if (status === "done") return "✓";
  if (status === "failed") return "✕";
  return "–";
}
</script>

<style scoped>
/* Modelled on the VS Code Claude panel: flat, left-aligned, one line per step, the detail
   muted and the time pushed right. Nested rows hang off a thin guide line so a specialist's
   own calls read as belonging to the delegation above them. */
.tss { margin: 0 0 0.7rem; font-size: 0.8rem; line-height: 1.35; }

.tss-header {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.1rem 0.4rem 0.1rem 0.15rem;
  margin-bottom: 0.2rem;
  border: none;
  border-radius: 0.35rem;
  background: transparent;
  color: rgb(156 163 175);
  font: inherit;
  cursor: pointer;
}
.tss-header:hover { color: inherit; background: rgba(148, 163, 184, 0.1); }
.tss-header__chevron { width: 0.8rem; font-size: 0.7rem; }

.tss-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.05rem; }

.tss-row { position: relative; }
.tss-row--nested { padding-left: 1.15rem; }
.tss-row--nested::before {
  content: "";
  position: absolute;
  left: 0.42rem;
  top: 0;
  bottom: 0;
  width: 1px;
  background: rgba(148, 163, 184, 0.28);
}

.tss-row__btn {
  display: flex;
  align-items: baseline;
  gap: 0.45rem;
  width: 100%;
  min-width: 0;
  padding: 0.18rem 0.35rem 0.18rem 0.15rem;
  border: none;
  border-radius: 0.35rem;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.tss-row__btn:hover { background: rgba(148, 163, 184, 0.1); }
.tss-row__btn:focus-visible { outline: 2px solid rgba(var(--accent-purple), 0.8); outline-offset: 1px; }

.tss-mark {
  flex: 0 0 0.85rem;
  display: inline-flex;
  justify-content: center;
  font-size: 0.72rem;
  color: rgb(156 163 175);
}
.tss-row--done .tss-mark { color: #4ade80; }
.tss-row--failed .tss-mark { color: #f87171; }
.tss-row--stopped .tss-mark { color: #fbbf24; }

.tss-spinner {
  width: 0.62rem;
  height: 0.62rem;
  margin-top: 0.12rem;
  border-radius: 50%;
  border: 1.5px solid rgba(var(--accent-purple), 0.3);
  border-top-color: rgb(var(--accent-purple));
  animation: tss-spin 0.8s linear infinite;
}
@keyframes tss-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .tss-spinner { animation-duration: 2.4s; } }

/* In a narrow bubble the outcome gives way first (basis 0, so it only takes spare room), then
   the title ellipsizes — and the time never moves. A non-shrinking title used to push the
   time straight past the bubble's edge. */
.tss-title {
  flex: 0 1 auto;
  min-width: 0;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tss-row--failed .tss-title { color: #fca5a5; }
.tss-subject {
  flex: 0 1 auto;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 0.74rem;
  color: rgb(156 163 175);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tss-detail {
  flex: 1 1 0;
  min-width: 0;
  color: rgb(156 163 175);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tss-detail--live { font-style: italic; }
.tss-time {
  flex: 0 0 auto;
  white-space: nowrap;
  margin-left: auto;
  padding-left: 0.5rem;
  font-variant-numeric: tabular-nums;
  font-size: 0.72rem;
  color: rgb(156 163 175);
}

.tss-agent {
  flex: 0 0 auto;
  padding: 0 0.3rem;
  border-radius: 0.3rem;
  background: rgba(var(--accent-purple), 0.12);
  font-size: 0.7rem;
  color: rgb(203 213 225);
  white-space: nowrap;
}

.tss-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.tss-input {
  margin: 0.25rem 0 0.45rem 1.3rem;
}

.tss-note {
  margin: 0.1rem 0 0.15rem 1.3rem;
  font-style: italic;
  color: rgb(156 163 175);
}
.tss-row--live {
  display: flex;
  align-items: baseline;
  gap: 0.45rem;
  padding: 0.18rem 0.35rem 0.18rem 0.15rem;
}

@media (max-width: 640px) {
  .tss-subject { display: none; }
}
</style>
