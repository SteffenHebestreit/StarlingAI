<template>
  <div class="cost-page" style="height: 100%; overflow-y: auto">
    <div class="cost-page__header">
      <div>
        <h2 class="cost-page__title">Cost Governance</h2>
        <p class="cost-page__subtitle">
          Token usage and estimated dollar spend rolled up from audit events.
          Pricing is best-effort — operators can override the rate card via <code>cost.models[]</code>.
        </p>
      </div>
      <div class="cost-page__actions">
        <select v-model.number="rangeDays" class="cost-page__select">
          <option :value="1">Last 24h</option>
          <option :value="7">Last 7d</option>
          <option :value="30">Last 30d</option>
          <option :value="90">Last 90d</option>
        </select>
        <button class="cost-page__button" :disabled="loading" @click="refresh">Refresh</button>
      </div>
    </div>

    <div v-if="!enabled" class="cost-disabled">
      <p>
        Cost governance is currently disabled. Set <code>cost.enabled = true</code> in
        <code>starlingai.json</code> to start collecting per-session and per-agent rollups.
        Optionally set <code>cost.budgets.{dailyUsd,monthlyUsd}</code> to receive
        threshold alerts at 75% (warn) and 100% (error) of the cap.
      </p>
    </div>

    <div v-if="errorMessage" class="cost-page__error">{{ errorMessage }}</div>

    <section class="cost-stat-row">
      <article class="cost-stat-card">
        <div class="cost-stat-card__label">Total cost · {{ rangeDays }}d</div>
        <div class="cost-stat-card__value">{{ formatCurrency(summary?.totalCost ?? 0, currency) }}</div>
        <div class="cost-stat-card__hint">{{ formatNumber(summary?.totalTokens ?? 0) }} tokens</div>
      </article>
      <article class="cost-stat-card">
        <div class="cost-stat-card__label">Avg / day · last {{ projection?.windowDays ?? 0 }}d</div>
        <div class="cost-stat-card__value">{{ formatCurrency(projection?.averageDailyCost ?? 0, currency) }}</div>
        <div class="cost-stat-card__hint">excl. today (in-progress)</div>
      </article>
      <article class="cost-stat-card cost-stat-card--projection">
        <div class="cost-stat-card__label">Projected / month</div>
        <div class="cost-stat-card__value">{{ formatCurrency(projection?.projectedMonthlyCost ?? 0, currency) }}</div>
        <div class="cost-stat-card__hint">at current daily rate × 30</div>
      </article>
      <article v-if="budgets.monthlyUsd > 0" class="cost-stat-card cost-stat-card--budget">
        <div class="cost-stat-card__label">Monthly budget</div>
        <div class="cost-stat-card__value">{{ formatCurrency(budgets.monthlyUsd, currency) }}</div>
        <div class="cost-stat-card__hint">
          <span :class="monthlyClass">
            {{ monthSpendLabel }} ({{ Math.round((monthSpend / budgets.monthlyUsd) * 100) }}%)
          </span>
        </div>
      </article>
    </section>

    <section v-if="byDayChart.length > 0" class="cost-chart">
      <h3 class="cost-chart__title">Daily spend</h3>
      <div class="cost-chart__bars">
        <div
          v-for="bar in byDayChart"
          :key="bar.day"
          class="cost-chart__col"
          :title="`${bar.day} · ${formatCurrency(bar.estimatedCost, currency)} · ${formatNumber(bar.totalTokens)} tokens`"
        >
          <div class="cost-chart__bar" :style="{ height: `${bar.heightPct}%` }"></div>
          <div class="cost-chart__col-label">{{ shortDay(bar.day) }}</div>
        </div>
      </div>
    </section>

    <section class="cost-tables">
      <article class="cost-table">
        <h3 class="cost-table__title">Top sessions</h3>
        <ol class="cost-table__list">
          <li v-for="row in summary?.bySession ?? []" :key="row.source" class="cost-table__row">
            <code class="cost-table__source">{{ row.source.slice(0, 14) }}</code>
            <span class="cost-table__cost">{{ formatCurrency(row.estimatedCost, currency) }}</span>
            <span class="cost-table__tokens">{{ formatNumber(row.totalTokens) }}</span>
          </li>
          <li v-if="(summary?.bySession ?? []).length === 0" class="cost-table__empty">No session activity yet.</li>
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
          <li v-if="(summary?.byAgent ?? []).length === 0" class="cost-table__empty">No agent activity yet.</li>
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
          <li v-if="(summary?.byModel ?? []).length === 0" class="cost-table__empty">No model activity yet.</li>
        </ol>
      </article>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useGatewayStore } from "@/stores/gateway";

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

const rangeDays = ref(7);
const enabled = ref(true);
const summary = ref<CostSummary | null>(null);
const projection = ref<CostProjection | null>(null);
const budgets = ref<CostBudgets>({ dailyUsd: 0, monthlyUsd: 0 });
const loading = ref(false);
const errorMessage = ref<string | null>(null);

const currency = computed(() => summary.value?.currency ?? "USD");

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

function apiBase(): string {
  return gateway.wsUrl.replace(/^ws/, "http").replace(/\/ws$/, "");
}

async function loadSummary(): Promise<void> {
  if (!gateway.token) return;
  const url = new URL(`${apiBase()}/api/cost/summary`);
  url.searchParams.set("range", String(rangeDays.value));
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${gateway.token}` } });
  if (!res.ok) {
    errorMessage.value = `Failed to load cost summary (${res.status})`;
    return;
  }
  const body = await res.json() as { enabled: boolean; budgets: CostBudgets; summary: CostSummary };
  enabled.value = body.enabled;
  budgets.value = body.budgets;
  summary.value = body.summary;
}

async function loadProjection(): Promise<void> {
  if (!gateway.token) return;
  const res = await fetch(`${apiBase()}/api/cost/projection`, {
    headers: { Authorization: `Bearer ${gateway.token}` },
  });
  if (!res.ok) return;
  projection.value = await res.json() as CostProjection;
}

async function refresh(): Promise<void> {
  loading.value = true;
  errorMessage.value = null;
  try {
    await Promise.all([loadSummary(), loadProjection()]);
  } catch (err) {
    errorMessage.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
}

watch(rangeDays, () => { void loadSummary(); });

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

onMounted(() => { void refresh(); });
</script>

<style scoped>
.cost-page {
  padding: 1.5rem 1.75rem 3rem;
  color: rgb(229 231 235);
}

.cost-page__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
  margin-bottom: 1.25rem;
}

.cost-page__title {
  font-size: 1.5rem;
  font-weight: 600;
  margin: 0;
  background: linear-gradient(90deg, rgb(165 243 252), rgb(196 181 253));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.cost-page__subtitle {
  margin: 0.4rem 0 0;
  color: rgb(156 163 175);
  font-size: 0.875rem;
  max-width: 36rem;
}

.cost-page__subtitle code,
.cost-disabled code {
  background: rgba(0, 0, 0, 0.4);
  padding: 0.05rem 0.35rem;
  border-radius: 4px;
  color: rgb(165 243 252);
  font-size: 0.85em;
}

.cost-page__actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.cost-page__select {
  background: rgba(15, 23, 42, 0.7);
  border: 1px solid rgba(168, 85, 247, 0.35);
  color: rgb(229 231 235);
  padding: 0.4rem 0.7rem;
  border-radius: 8px;
  font-size: 0.85rem;
}

.cost-page__button {
  background: rgba(76, 29, 149, 0.35);
  border: 1px solid rgba(168, 85, 247, 0.35);
  color: rgb(233 213 255);
  padding: 0.4rem 0.85rem;
  border-radius: 999px;
  font-size: 0.85rem;
  cursor: pointer;
  transition: all 120ms ease;
}

.cost-page__button:hover:not(:disabled) {
  background: rgba(124, 58, 237, 0.55);
  color: white;
}

.cost-page__button:disabled { opacity: 0.5; cursor: progress; }

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
  background: rgba(239, 68, 68, 0.12);
  border: 1px solid rgba(248, 113, 113, 0.4);
  border-radius: 8px;
  padding: 0.55rem 0.8rem;
  color: rgb(252 165 165);
  font-size: 0.85rem;
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
  display: flex;
  align-items: flex-end;
  gap: 0.35rem;
  height: 9rem;
}

.cost-chart__col {
  flex: 1 1 0;
  min-width: 1.5rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: 0.4rem;
}

.cost-chart__bar {
  width: 100%;
  min-height: 2px;
  border-radius: 4px 4px 0 0;
  background: linear-gradient(180deg, rgba(124, 58, 237, 0.85), rgba(34, 211, 238, 0.55));
}

.cost-chart__col-label {
  font-size: 0.65rem;
  color: rgb(148 163 184);
  font-family: ui-monospace, "SF Mono", monospace;
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
