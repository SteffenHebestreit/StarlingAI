<template>
  <div class="page-shell cost-page">
    <header class="page-header">
      <div class="page-header__text">
        <h1 class="page-title">Cost Governance</h1>
        <p class="page-subtitle">
          Token usage and estimated dollar spend rolled up from audit events.
          Pricing is best-effort — operators can override the rate card via <code>cost.models[]</code>.
        </p>
      </div>
      <div class="page-actions">
        <select v-model.number="rangeDays" class="cost-page__select">
          <option :value="1">Last 24h</option>
          <option :value="7">Last 7d</option>
          <option :value="30">Last 30d</option>
          <option :value="90">Last 90d</option>
        </select>
        <button type="button" class="btn-ghost px-4 py-2 rounded-xl text-sm" :disabled="loading" @click="refresh">{{ loading ? "Refreshing…" : "Refresh" }}</button>
      </div>
    </header>

    <div v-if="!enabled" class="cost-disabled">
      <p>
        Cost governance is currently disabled. Set <code>cost.enabled = true</code> in
        <code>starlingai.json</code> to start collecting per-session and per-agent rollups.
        Optionally set <code>cost.budgets.{dailyUsd,monthlyUsd}</code> to receive
        threshold alerts at 75% (warn) and 100% (error) of the cap.
      </p>
    </div>

    <div v-if="errorMessage" class="notice notice--error cost-page__error" role="alert">{{ errorMessage }}</div>

    <section class="cost-stat-row">
      <article class="cost-stat-card">
        <div class="cost-stat-card__label">Total cost · {{ rangeDays }}d</div>
        <div class="cost-stat-card__value">{{ summary ? formatCurrency(summary.totalCost, currency) : noValue }}</div>
        <div class="cost-stat-card__hint">{{ summary ? formatNumber(summary.totalTokens) + " tokens" : noValueHint }}</div>
      </article>
      <article class="cost-stat-card">
        <div class="cost-stat-card__label">Avg / day<template v-if="projection"> · last {{ projection.windowDays }}d</template></div>
        <div class="cost-stat-card__value">{{ projection ? formatCurrency(projection.averageDailyCost, currency) : noValue }}</div>
        <div class="cost-stat-card__hint">{{ projection ? "excl. today (in-progress)" : noValueHint }}</div>
      </article>
      <article class="cost-stat-card cost-stat-card--projection">
        <div class="cost-stat-card__label">Projected / month</div>
        <div class="cost-stat-card__value">{{ projection ? formatCurrency(projection.projectedMonthlyCost, currency) : noValue }}</div>
        <div class="cost-stat-card__hint">{{ projection ? "at current daily rate × 30" : noValueHint }}</div>
      </article>
      <article v-if="budgets.monthlyUsd > 0" class="cost-stat-card cost-stat-card--budget">
        <div class="cost-stat-card__label">Monthly budget</div>
        <div class="cost-stat-card__value">{{ formatCurrency(budgets.monthlyUsd, currency) }}</div>
        <div class="cost-stat-card__hint">
          <span v-if="summary" :class="monthlyClass">
            {{ monthSpendLabel }} ({{ Math.round((monthSpend / budgets.monthlyUsd) * 100) }}%)
          </span>
          <span v-else>{{ noValueHint }}</span>
        </div>
      </article>
    </section>

    <section v-if="byDayChart.length > 0" class="cost-chart">
      <h3 class="cost-chart__title">Daily spend</h3>
      <!-- The bars share the card's width at every range, and each one is a button: a tap, a
           focus or the pointer over it puts its day in the line below. One tab stop for the
           whole chart; the arrow keys move between the days. -->
      <div
        ref="barsEl"
        class="cost-chart__bars"
        role="group"
        aria-label="Daily spend. The left and right arrow keys move between the days."
        :style="{ gap: `${chartLayout.gapPx}px` }"
        @pointermove="onChartPointer"
      >
        <button
          v-for="(bar, index) in byDayChart"
          :key="bar.day"
          type="button"
          :class="['cost-chart__col', bar.day === activeBar?.day && 'cost-chart__col--active']"
          :tabindex="bar.day === tabStopDay ? 0 : -1"
          :aria-label="`${bar.day}: ${formatCurrency(bar.estimatedCost, currency)}`"
          @click="pickBar(bar.day, $event)"
          @focus="activeDay = bar.day"
          @keydown="onBarKey($event, index)"
        >
          <span class="cost-chart__track">
            <span class="cost-chart__bar" :style="{ height: `${bar.heightPct}%` }"></span>
          </span>
          <span class="cost-chart__tick" aria-hidden="true">
            <span
              v-if="labelPlace(index) !== 'none'"
              :class="['cost-chart__col-label', `cost-chart__col-label--${labelPlace(index)}`]"
            >{{ shortDay(bar.day) }}</span>
          </span>
        </button>
      </div>
      <p class="cost-chart__readout">
        <template v-if="activeBar">
          <span class="cost-chart__readout-day">{{ activeBar.day }}</span>
          · <strong class="cost-chart__readout-value">{{ formatCurrency(activeBar.estimatedCost, currency) }}</strong>
          · {{ formatNumber(activeBar.totalTokens) }} tokens
        </template>
        <template v-else>
          Select a bar to see that day's spend<span class="cost-chart__readout-keys"> · ← → step through the days</span>
        </template>
      </p>
    </section>

    <section class="cost-tables">
      <article class="cost-table">
        <h3 class="cost-table__title">Top sessions</h3>
        <ol class="cost-table__list">
          <li v-for="row in summary?.bySession ?? []" :key="row.source" class="cost-table__row">
            <code v-if="row.source === NO_SESSION" class="cost-table__source">{{ row.source }}</code>
            <span v-else class="cost-table__session">
              <button
                type="button"
                class="cost-table__source cost-table__source--copy"
                :title="`${row.source} — click to copy`"
                :aria-label="`Copy session id ${row.source}`"
                @click="copyId('Session', row.source)"
              >{{ row.source.slice(0, 14) }}</button>
              <RouterLink
                :to="{ path: '/sessions', query: { sessionId: row.source } }"
                class="cost-table__open"
                title="Open this session"
                :aria-label="`Open session ${row.source}`"
              >Open</RouterLink>
            </span>
            <span class="cost-table__cost">{{ formatCurrency(row.estimatedCost, currency) }}</span>
            <span class="cost-table__tokens">{{ formatNumber(row.totalTokens) }}</span>
          </li>
          <li v-if="!summary" class="cost-table__empty">{{ noValueHint }}</li>
          <li v-else-if="summary.bySession.length === 0" class="cost-table__empty">No session activity yet.</li>
        </ol>
      </article>

      <article class="cost-table">
        <h3 class="cost-table__title">Top agents</h3>
        <ol class="cost-table__list">
          <li v-for="row in summary?.byAgent ?? []" :key="row.source" class="cost-table__row">
            <code class="cost-table__source">{{ row.source }}</code>
            <span class="cost-table__cost">{{ formatCurrency(row.estimatedCost, currency) }}</span>
            <span class="cost-table__tokens">{{ formatNumber(row.totalTokens) }}</span>
          </li>
          <li v-if="!summary" class="cost-table__empty">{{ noValueHint }}</li>
          <li v-else-if="summary.byAgent.length === 0" class="cost-table__empty">No agent activity yet.</li>
        </ol>
      </article>

      <article class="cost-table">
        <h3 class="cost-table__title">By model</h3>
        <ol class="cost-table__list">
          <li v-for="row in summary?.byModel ?? []" :key="row.source" class="cost-table__row">
            <code class="cost-table__source">{{ row.source }}</code>
            <span class="cost-table__cost">{{ formatCurrency(row.estimatedCost, currency) }}</span>
            <span class="cost-table__tokens">{{ formatNumber(row.totalTokens) }}</span>
          </li>
          <li v-if="!summary" class="cost-table__empty">{{ noValueHint }}</li>
          <li v-else-if="summary.byModel.length === 0" class="cost-table__empty">No model activity yet.</li>
        </ol>
      </article>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useElementSize } from "@vueuse/core";
import { useGatewayStore } from "@/stores/gateway";
import { writeClipboard } from "@/composables/clipboard";
import { useLoadWhenConnected } from "@/composables/useLoadWhenConnected";
import { useToast, errorText } from "@/composables/useToast";

interface CostBucket {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCost: number;
  count: number;
}
interface CostByDay extends CostBucket { day: string }
interface CostBySource extends CostBucket { source: string; lastSeen: string }
interface CostSummary {
  rangeDays: number;
  totalTokens: number;
  totalCost: number;
  currency: string;
  byDay: CostByDay[];
  byAgent: CostBySource[];
  byModel: CostBySource[];
  bySession: CostBySource[];
}
interface CostProjection {
  windowDays: number;
  averageDailyCost: number;
  projectedMonthlyCost: number;
  currency: string;
}
interface CostBudgets { dailyUsd: number; monthlyUsd: number }

const gateway = useGatewayStore();
const toast = useToast();

// Usage that belongs to no session is booked under this name (core: observability/cost.ts).
const NO_SESSION = "unknown";

const rangeDays = ref(7);
const enabled = ref(true);
const summary = ref<CostSummary | null>(null);
const projection = ref<CostProjection | null>(null);
const budgets = ref<CostBudgets>({ dailyUsd: 0, monthlyUsd: 0 });
const loading = ref(false);
const errorMessage = ref<string | null>(null);
// Counts loads, so a slow answer for an earlier range cannot land under a newer one.
let loadRun = 0;

const currency = computed(() => summary.value?.currency ?? projection.value?.currency ?? "USD");

// What stands in for a figure that is not loaded. The cards used to print $0.00 while loading
// and after a failed load, which reads as "nothing was spent".
const noValue = computed(() => (loading.value ? "…" : "—"));
const noValueHint = computed(() => (loading.value ? "Loading…" : "Not loaded"));

const monthSpend = computed(() => {
  if (!summary.value || budgets.value.monthlyUsd <= 0) return 0;
  const monthKey = new Date().toISOString().slice(0, 7);
  return summary.value.byDay
    .filter((d) => d.day.startsWith(monthKey))
    .reduce((acc, d) => acc + d.estimatedCost, 0);
});
const monthSpendLabel = computed(() => formatCurrency(monthSpend.value, currency.value));
const monthlyClass = computed(() => {
  if (budgets.value.monthlyUsd <= 0) return "";
  const pct = monthSpend.value / budgets.value.monthlyUsd;
  if (pct >= 1) return "cost-budget--hard";
  if (pct >= 0.75) return "cost-budget--soft";
  return "cost-budget--ok";
});

const byDayChart = computed(() => {
  const days = summary.value?.byDay ?? [];
  if (days.length === 0) return [];
  const max = Math.max(...days.map((d) => d.estimatedCost), 0.0001);
  return days.map((d) => ({
    ...d,
    heightPct: Math.max(2, Math.round((d.estimatedCost / max) * 100)),
  }));
});

// ── The chart's fit ───────────────────────────────────────────────────────────
// Every bar had a floor of 1.5rem and the chart did not scroll: thirty days ran off a phone and
// ninety (about 2600px) off a desktop. The bars now share whatever width the card has, the gap
// between them narrows as they do, and the date labels thin out to every Nth before they touch.
const barsEl = ref<HTMLElement | null>(null);
const { width: chartWidth } = useElementSize(barsEl);
// A date label ("11-05") is about 32px wide.
const LABEL_WIDTH_PX = 36;
const LABEL_SPACING_PX = 40;
// Under bars narrower than a label, the first and last labels line up with the chart's edges
// instead of hanging over them, and so need more room to their neighbour.
const EDGE_LABEL_SPACING_PX = 56;

const chartLayout = computed(() => {
  const count = Math.max(1, byDayChart.value.length);
  // Not measured yet (the first frame): reckon with a phone, so nothing can overflow meanwhile.
  const width = chartWidth.value > 0 ? chartWidth.value : 280;
  const slot = width / count;
  const narrow = slot < LABEL_WIDTH_PX;
  return {
    slot,
    narrow,
    gapPx: Math.min(5.6, Math.max(1, Math.round(slot * 0.2))),
    labelEvery: Math.max(1, Math.ceil((narrow ? EDGE_LABEL_SPACING_PX : LABEL_SPACING_PX) / slot)),
  };
});

/** Whether the bar at `index` carries its date, and how the label sits under it. */
function labelPlace(index: number): "none" | "start" | "middle" | "end" {
  const { slot, narrow, labelEvery } = chartLayout.value;
  const last = byDayChart.value.length - 1;
  // Counted from the newest day, so that one always has its date.
  if ((last - index) % labelEvery !== 0) return "none";
  if (!narrow) return "middle";
  if (index === last) return "end";
  if (index === 0) return "start";
  // Too close to the left edge to stand centred without hanging over it.
  return (index + 0.5) * slot < LABEL_WIDTH_PX / 2 ? "none" : "middle";
}

// ── The day in the line under the chart ───────────────────────────────────────
// A bar's figures used to be in a hover title only, which a touch screen never shows.
const activeDay = ref<string | null>(null);
const activeBar = computed(() => byDayChart.value.find((bar) => bar.day === activeDay.value) ?? null);
// The chart is one tab stop: the chosen day, or the newest one while none is chosen.
const tabStopDay = computed(() => activeBar.value?.day ?? byDayChart.value[byDayChart.value.length - 1]?.day ?? null);

// The mouse over the chart, or a finger drawn along it, picks the day under it: a tap alone
// cannot be aimed at one bar of ninety on a phone.
function onChartPointer(event: PointerEvent): void {
  const count = byDayChart.value.length;
  const box = barsEl.value?.getBoundingClientRect();
  if (!box || box.width <= 0 || count === 0) return;
  const index = Math.floor(((event.clientX - box.left) / box.width) * count);
  activeDay.value = byDayChart.value[Math.min(count - 1, Math.max(0, index))]!.day;
}

// Safari does not focus a button it clicks, and the arrow keys work from the focused bar.
function pickBar(day: string, event: MouseEvent): void {
  activeDay.value = day;
  (event.currentTarget as HTMLElement | null)?.focus();
}

function onBarKey(event: KeyboardEvent, index: number): void {
  const last = byDayChart.value.length - 1;
  const target = event.key === "ArrowLeft" ? index - 1
    : event.key === "ArrowRight" ? index + 1
    : event.key === "Home" ? 0
    : event.key === "End" ? last
    : null;
  if (target === null) return;
  event.preventDefault();
  const next = Math.min(last, Math.max(0, target));
  activeDay.value = byDayChart.value[next]!.day;
  (barsEl.value?.children[next] as HTMLElement | undefined)?.focus();
}

// "Top sessions" shows ids cut to fourteen characters; this is how to get a whole one.
async function copyId(what: string, id: string): Promise<void> {
  try {
    await writeClipboard(id);
    toast.success("Copied", `${what} id is on the clipboard.`);
  } catch {
    toast.error("Couldn't copy", `The browser refused the clipboard. ${what} id: ${id}`);
  }
}

function apiBase(): string {
  return gateway.wsUrl.replace(/^ws/, "http").replace(/\/ws$/, "");
}

async function loadSummary(run: number): Promise<void> {
  if (!gateway.token) return;
  const url = new URL(`${apiBase()}/api/cost/summary`);
  url.searchParams.set("range", String(rangeDays.value));
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${gateway.token}` } });
  if (!res.ok) throw new Error(`Failed to load cost summary (HTTP ${res.status})`);
  const body = await res.json() as { enabled: boolean; budgets: CostBudgets; summary: CostSummary };
  if (run !== loadRun) return;
  enabled.value = body.enabled;
  budgets.value = body.budgets;
  summary.value = body.summary;
}

async function loadProjection(run: number): Promise<void> {
  if (!gateway.token) return;
  const res = await fetch(`${apiBase()}/api/cost/projection`, {
    headers: { Authorization: `Bearer ${gateway.token}` },
  });
  if (!res.ok) throw new Error(`Failed to load cost projection (HTTP ${res.status})`);
  const body = await res.json() as CostProjection;
  if (run !== loadRun) return;
  projection.value = body;
}

async function refresh(): Promise<void> {
  const run = ++loadRun;
  loading.value = true;
  errorMessage.value = null;
  // Settled, not all: one half failing must not hide the other half or its own error.
  const results = await Promise.allSettled([loadSummary(run), loadProjection(run)]);
  if (run !== loadRun) return; // a newer load owns the page now
  const failures = results.flatMap((result) => (result.status === "rejected" ? [errorText(result.reason)] : []));
  if (failures.length > 0) errorMessage.value = failures.join(" · ");
  loading.value = false;
}

// A new range goes through the normal load. The old range's figures are dropped first, so they
// never sit under the new range's label, and a failed request shows like any other.
watch(rangeDays, () => {
  summary.value = null;
  void refresh();
});

function formatCurrency(value: number, code: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: code, maximumFractionDigits: 2 }).format(value);
  } catch {
    return `${code} ${value.toFixed(2)}`;
  }
}

function formatNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function shortDay(day: string): string {
  return day.slice(5); // "MM-DD"
}

// Also when the gateway comes up after the page did (opened by URL, or signed in to here).
useLoadWhenConnected(refresh);
</script>

<style scoped>
.cost-page {
  color: rgb(229 231 235);
}

.cost-disabled code {
  background: rgba(0, 0, 0, 0.4);
  padding: 0.05rem 0.35rem;
  border-radius: 4px;
  color: rgb(165 243 252);
  font-size: 0.85em;
}

/* Sized to sit level with the header's buttons. */
.cost-page__select {
  background: rgba(15, 23, 42, 0.7);
  border: 1px solid var(--hairline-strong);
  color: rgb(229 231 235);
  padding: 0.5rem 0.75rem;
  border-radius: 0.75rem;
  font-size: 0.875rem;
  line-height: 1.25rem;
}

.cost-disabled {
  border: 1px dashed rgba(168, 85, 247, 0.35);
  background: rgba(15, 23, 42, 0.7);
  border-radius: 14px;
  padding: 1rem 1.25rem;
  color: rgb(203 213 225);
  font-size: 0.85rem;
  margin-bottom: 1rem;
  line-height: 1.55;
}

.cost-page__error {
  margin-bottom: 1rem;
}

.cost-stat-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 0.85rem;
  margin-bottom: 1.5rem;
}

.cost-stat-card {
  background: rgba(15, 23, 42, 0.65);
  border: 1px solid rgba(168, 85, 247, 0.18);
  border-radius: 12px;
  padding: 0.95rem 1.1rem 1rem;
}

.cost-stat-card--projection {
  border-color: rgba(34, 211, 238, 0.3);
}

.cost-stat-card--budget {
  border-color: rgba(217, 119, 6, 0.3);
}

.cost-stat-card__label {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: rgb(156 163 175);
}

.cost-stat-card__value {
  font-size: 1.65rem;
  font-weight: 600;
  color: rgb(241 245 249);
  margin: 0.3rem 0 0.2rem;
}

.cost-stat-card__hint {
  font-size: 0.75rem;
  color: rgb(148 163 184);
}

.cost-budget--ok { color: rgb(110 231 183); }
.cost-budget--soft { color: rgb(252 211 77); }
.cost-budget--hard { color: rgb(252 165 165); font-weight: 600; }

.cost-chart {
  background: rgba(15, 23, 42, 0.65);
  border: 1px solid rgba(168, 85, 247, 0.18);
  border-radius: 12px;
  padding: 1rem 1.1rem 1.1rem;
  margin-bottom: 1.5rem;
}

.cost-chart__title {
  margin: 0 0 0.8rem;
  font-size: 1rem;
  color: rgb(229 231 235);
}

.cost-chart__bars {
  position: relative;
  display: flex;
  align-items: stretch;
  gap: 0.35rem;
  height: 9rem;
  /* A finger drawn along the bars picks days; up and down still scrolls the page. */
  touch-action: pan-y;
}

/* The line the bars stand on: a bar two pixels tall then reads as a small day, not as a gap. */
.cost-chart__bars::before {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: 1.3rem; /* the label row and the gap above it */
  height: 1px;
  background: var(--hairline);
  pointer-events: none;
}

/* No floor on the width: the bars share the card, however many there are. */
.cost-chart__col {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  cursor: pointer;
}

/* The ring goes round the bar's track, not round the date under it. */
.cost-chart__col:focus-visible {
  outline: none;
}

.cost-chart__col:focus-visible .cost-chart__track {
  outline: 2px solid rgba(var(--logo-cyan), 0.75);
  outline-offset: 1px;
}

/* The bar stands in a track as tall as the plot, so its height is a share of that. The old bar
   took its height from a column with none of its own, and every bar came out 2px tall. */
.cost-chart__track {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  border-radius: 4px 4px 0 0;
}

/* Never wider than 1.5rem: a week of days stays a row of bars, not a row of slabs. */
.cost-chart__bar {
  position: absolute;
  left: 50%;
  bottom: 0;
  width: 100%;
  max-width: 1.5rem;
  min-height: 2px;
  transform: translateX(-50%);
  border-radius: 4px 4px 0 0;
  background: linear-gradient(180deg, rgba(124, 58, 237, 0.85), rgba(34, 211, 238, 0.55));
}

/* The chosen day: its whole column is washed, so a bar two pixels tall still shows as chosen. */
.cost-chart__col--active .cost-chart__track {
  background: rgba(var(--logo-cyan), 0.1);
}

.cost-chart__col--active .cost-chart__bar {
  background: linear-gradient(180deg, rgb(167, 139, 250), rgb(103, 232, 249));
  box-shadow: 0 0 10px rgba(var(--logo-cyan), 0.45);
}

/* Every bar keeps the row for a label, with or without one, so all tracks are equally tall. */
.cost-chart__tick {
  position: relative;
  flex: 0 0 auto;
  height: 0.9rem;
}

.cost-chart__col-label {
  position: absolute;
  top: 0;
  font-size: 0.65rem;
  line-height: 0.9rem;
  white-space: nowrap;
  color: rgb(148 163 184);
  font-family: ui-monospace, "SF Mono", monospace;
}

.cost-chart__col-label--middle { left: 50%; transform: translateX(-50%); }
.cost-chart__col-label--start { left: 0; }
.cost-chart__col-label--end { right: 0; }

.cost-chart__col--active .cost-chart__col-label {
  color: rgb(207 250 254);
}

.cost-chart__readout {
  min-height: 1.25rem;
  margin: 0.7rem 0 0;
  font-size: 0.8rem;
  line-height: 1.25rem;
  color: rgb(148 163 184);
}

.cost-chart__readout-day {
  font-family: ui-monospace, "SF Mono", monospace;
  color: rgb(203 213 225);
}

.cost-chart__readout-value {
  font-weight: 600;
  color: rgb(241 245 249);
}

/* No arrow keys on a touch screen. */
@media (hover: none) {
  .cost-chart__readout-keys { display: none; }
}

.cost-tables {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 0.85rem;
}

.cost-table {
  background: rgba(15, 23, 42, 0.65);
  border: 1px solid rgba(168, 85, 247, 0.18);
  border-radius: 12px;
  padding: 0.85rem 1rem 0.95rem;
}

.cost-table__title {
  margin: 0 0 0.5rem;
  font-size: 0.95rem;
  color: rgb(229 231 235);
}

.cost-table__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.cost-table__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 0.5rem;
  align-items: center;
  font-size: 0.8rem;
  padding: 0.25rem 0;
  border-bottom: 1px solid rgba(168, 85, 247, 0.08);
}

.cost-table__row:last-child { border-bottom: none; }

.cost-table__source {
  color: rgb(165 243 252);
  background: rgba(15, 23, 42, 0.7);
  padding: 0 0.35rem;
  border-radius: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* A session's id and the way to its page. */
.cost-table__session {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  min-width: 0;
}

/* The id is shown cut short: the button holds all of it (title) and copies it. */
.cost-table__source--copy {
  min-width: 0;
  /* A button does not get the <code> face on its own. */
  font-family: var(--font-mono, monospace);
  cursor: copy;
}

.cost-table__source--copy:hover {
  color: rgb(236 254 255);
  text-decoration: underline dotted;
  text-underline-offset: 2px;
}

.cost-table__open {
  flex-shrink: 0;
  font-size: 0.75rem;
  color: rgb(148 163 184);
  text-decoration: underline dotted;
  text-underline-offset: 2px;
}

.cost-table__open:hover {
  color: rgb(241 245 249);
}

.cost-table__source--copy:focus-visible,
.cost-table__open:focus-visible {
  outline: 2px solid rgba(var(--logo-cyan), 0.7);
  outline-offset: 2px;
  border-radius: 4px;
}

.cost-table__cost {
  color: rgb(241 245 249);
  font-weight: 600;
}

.cost-table__tokens {
  color: rgb(148 163 184);
  font-size: 0.75rem;
}

.cost-table__empty {
  color: rgb(148 163 184);
  font-size: 0.85rem;
  padding: 0.5rem 0;
}
</style>
