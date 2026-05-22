<template>
  <div class="memory-page" style="height: 100%">
    <header class="memory-page__header">
      <div>
        <h1 class="memory-page__title">Memory &amp; Knowledge</h1>
        <p class="memory-page__subtitle">
          Two different stores live here. The Memory Store tab shows durable workspace or user memory
          records. The Knowledge Graph tab shows MemGraph nodes and edges, including durable memory
          write-through, FACT promotions, and explicit entity links created through
          <code>graph_upsert_entity</code> and <code>graph_relate</code>.
        </p>
      </div>
      <div class="memory-page__tabs" role="tablist" aria-label="Memory views">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          role="tab"
          :aria-selected="activeTab === tab.id"
          :class="['memory-page__tab', activeTab === tab.id ? 'memory-page__tab--active' : '']"
          @click="activeTab = tab.id"
        >{{ tab.label }}</button>
      </div>
    </header>

    <!-- Knowledge graph tab -->
    <section v-if="activeTab === 'graph'" class="memory-page__panel">
      <div class="graph-controls">
        <div class="graph-controls__group">
          <label class="graph-controls__label">Label</label>
          <select v-model="graphLabelFilter" @change="loadGraph()" class="graph-controls__select">
            <option value="">All labels</option>
            <option v-for="entry in graphLabels" :key="entry.label" :value="entry.label">
              {{ entry.label }} ({{ entry.count }})
            </option>
          </select>
        </div>
        <div class="graph-controls__group">
          <label class="graph-controls__label">Limit</label>
          <select v-model.number="graphLimit" @change="loadGraph()" class="graph-controls__select">
            <option :value="50">50 nodes</option>
            <option :value="150">150 nodes</option>
            <option :value="300">300 nodes</option>
            <option :value="500">500 nodes</option>
          </select>
        </div>
        <button class="graph-controls__refresh" @click="loadGraph()" :disabled="graphLoading">
          {{ graphLoading ? "Loading…" : "Refresh" }}
        </button>
        <span class="graph-controls__meta">
          {{ graphData.nodes.length }} nodes · {{ graphData.edges.length }} edges
          <span v-if="graphData.truncated" class="graph-controls__meta--warn">(capped at {{ graphLimit }})</span>
        </span>
      </div>

      <div v-if="graphError" class="memory-page__notice memory-page__notice--error">
        {{ graphError }}
      </div>
      <div v-else-if="!graphAvailable" class="memory-page__notice">
        {{ graphUnavailableNote || "MemGraph is not reachable." }}
      </div>
      <div v-else-if="graphData.nodes.length === 0 && !graphLoading" class="memory-page__notice">
        No graph nodes yet. This view is populated by MemGraph-backed memory write-through,
        FACT promotion, and explicit graph entity tools such as <code>graph_upsert_entity</code>
        and <code>graph_relate</code>.
      </div>

      <div ref="cyContainer" class="graph-canvas" />

      <aside v-if="selectedNode" class="graph-detail">
        <div class="graph-detail__header">
          <span class="graph-detail__label">{{ selectedNode.labels.join(" · ") || "Node" }}</span>
          <button class="graph-detail__close" @click="selectedNode = null" aria-label="Close detail">×</button>
        </div>
        <h3 class="graph-detail__title">{{ selectedNode.name || selectedNode.id }}</h3>
        <dl class="graph-detail__props">
          <template v-for="(value, key) in selectedNode.properties" :key="key">
            <dt>{{ key }}</dt>
            <dd>{{ formatPropValue(value) }}</dd>
          </template>
        </dl>
      </aside>
    </section>

    <!-- Memory store tab -->
    <section v-else class="memory-page__panel">
      <div class="memory-controls">
        <div class="memory-controls__group">
          <label class="memory-controls__label">Scope</label>
          <select v-model="memoryScope" @change="loadMemory()" class="memory-controls__select">
            <option value="workspace">Workspace</option>
            <option value="user">User</option>
          </select>
        </div>
        <div class="memory-controls__group memory-controls__group--grow">
          <label class="memory-controls__label">Search</label>
          <input
            v-model="memoryQuery"
            type="search"
            class="memory-controls__input"
            placeholder="Filter by content, subject, key, or tag"
            @input="onMemoryQueryChange"
          />
        </div>
        <button class="memory-controls__refresh" @click="loadMemory()" :disabled="memoryLoading">
          {{ memoryLoading ? "Loading…" : "Refresh" }}
        </button>
        <button
          v-if="memoryScope === 'workspace'"
          class="memory-controls__refresh"
          :disabled="curating || (curationReport?.removableDuplicates ?? 0) === 0"
          :title="(curationReport?.removableDuplicates ?? 0) === 0 ? 'No duplicates to consolidate' : 'Merge duplicate memories'"
          @click="runCurate()"
        >
          {{ curating ? "Curating…" : "Curate" }}
        </button>
      </div>
      <div v-if="curationReport && curationReport.nudge && memoryScope === 'workspace'" class="memory-page__notice memory-page__notice--info">
        {{ curationReport.nudge }}
      </div>
      <div v-if="memoryError" class="memory-page__notice memory-page__notice--error">{{ memoryError }}</div>
      <div v-else-if="memoryRecords.length === 0 && !memoryLoading" class="memory-page__notice">
        No memory entries match. Workspace memory is written by <code>memory_store</code>,
        <code>record_lesson</code>, and durable promotions from session memory. Session shared facts,
        trajectory cache entries, and arbitrary workspace files are not shown in this tab.
      </div>
      <div class="memory-list">
        <article
          v-for="record in memoryRecords"
          :key="record.id"
          class="memory-card"
        >
          <header class="memory-card__header">
            <span class="memory-card__kind">{{ record.kind }}</span>
            <span class="memory-card__scope">{{ record.scope }}</span>
            <span class="memory-card__owner">{{ record.ownerType }}:{{ record.ownerId }}</span>
            <span class="memory-card__date">{{ formatDate(record.updatedAt) }}</span>
          </header>
          <h3 class="memory-card__subject">{{ record.subject || record.key || record.id }}</h3>
          <p class="memory-card__content">{{ record.content }}</p>
          <footer v-if="record.tags && record.tags.length > 0" class="memory-card__tags">
            <span v-for="tag in record.tags" :key="tag" class="memory-card__tag">{{ tag }}</span>
          </footer>
        </article>
      </div>
      <div v-if="memoryTotal > memoryRecords.length" class="memory-page__notice memory-page__notice--info">
        Showing {{ memoryRecords.length }} of {{ memoryTotal }} matching entries.
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import fcose from "cytoscape-fcose";
import { useGatewayStore } from "@/stores/gateway";

cytoscape.use(fcose);

interface MemoryRecord {
  id: string;
  scope: string;
  kind: string;
  ownerType: string;
  ownerId: string;
  subject: string;
  content: string;
  tags: string[];
  source: string;
  createdAt: string;
  updatedAt: string;
  key?: string;
}

interface GraphNode {
  id: string;
  labels: string[];
  name: string;
  properties: Record<string, unknown>;
}

interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  properties: Record<string, unknown>;
}

interface GraphLabelEntry {
  label: string;
  count: number;
}

const gateway = useGatewayStore();

const tabs = [
  { id: "graph", label: "Knowledge Graph" },
  { id: "memory", label: "Memory Store" },
] as const;

const activeTab = ref<typeof tabs[number]["id"]>("graph");

// ── Knowledge graph state ────────────────────────────────────────────────
const cyContainer = ref<HTMLElement | null>(null);
let cy: Core | null = null;
const graphLabels = ref<GraphLabelEntry[]>([]);
const graphLabelFilter = ref<string>("");
const graphLimit = ref<number>(150);
const graphLoading = ref(false);
const graphError = ref<string | null>(null);
const graphAvailable = ref<boolean>(true);
const graphUnavailableNote = ref<string>("");
const graphData = ref<{ nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean }>({ nodes: [], edges: [], truncated: false });
const selectedNode = ref<GraphNode | null>(null);

// ── Memory state ─────────────────────────────────────────────────────────
const memoryScope = ref<"workspace" | "user">("workspace");
const memoryQuery = ref<string>("");
const memoryLoading = ref(false);
const memoryError = ref<string | null>(null);
const memoryRecords = ref<MemoryRecord[]>([]);
const memoryTotal = ref<number>(0);
let memoryQueryTimer: ReturnType<typeof setTimeout> | null = null;

interface CurationReport {
  totalRecords: number;
  duplicateClusters: number;
  removableDuplicates: number;
  staleVolatile: number;
  nudge: string;
}
const curationReport = ref<CurationReport | null>(null);
const curating = ref(false);

function apiBase(): string {
  return gateway.wsUrl.replace(/^ws/, "http").replace(/\/ws$/, "");
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${gateway.token}` };
}

async function loadGraphLabels(): Promise<void> {
  try {
    const res = await fetch(`${apiBase()}/api/graph/labels`, { headers: authHeaders() });
    if (!res.ok) return;
    const data = await res.json() as { available: boolean; labels: GraphLabelEntry[] };
    graphLabels.value = data.labels ?? [];
  } catch {
    /* non-fatal */
  }
}

async function loadGraph(): Promise<void> {
  graphLoading.value = true;
  graphError.value = null;
  try {
    const params = new URLSearchParams({ limit: String(graphLimit.value) });
    if (graphLabelFilter.value) params.set("label", graphLabelFilter.value);
    const res = await fetch(`${apiBase()}/api/graph/overview?${params}`, { headers: authHeaders() });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json() as {
      available: boolean;
      nodes: GraphNode[];
      edges: GraphEdge[];
      truncated: boolean;
      note?: string;
    };
    graphAvailable.value = Boolean(data.available);
    graphUnavailableNote.value = data.note ?? "";
    graphData.value = {
      nodes: data.nodes ?? [],
      edges: data.edges ?? [],
      truncated: Boolean(data.truncated),
    };
    await nextTick();
    renderGraph();
  } catch (err) {
    graphError.value = err instanceof Error ? err.message : String(err);
  } finally {
    graphLoading.value = false;
  }
}

function renderGraph(): void {
  if (!cyContainer.value) return;
  const elements: ElementDefinition[] = [
    ...graphData.value.nodes.map((n): ElementDefinition => ({
      data: {
        id: n.id,
        label: n.name || n.id,
        primaryLabel: n.labels[0] ?? "Node",
        node: n,
      },
    })),
    ...graphData.value.edges.map((e): ElementDefinition => ({
      data: {
        id: e.id,
        source: e.source,
        target: e.target,
        relType: e.type,
      },
    })),
  ];
  if (cy) {
    cy.elements().remove();
    cy.add(elements);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cy.layout({ name: "fcose", animate: false } as any).run();
    return;
  }
  cy = cytoscape({
    container: cyContainer.value,
    elements,
    style: [
      {
        selector: "node",
        style: {
          "background-color": "#a78bfa",
          "border-color": "#7c3aed",
          "border-width": 1.5,
          "label": "data(label)",
          "font-size": 11,
          "color": "#e0e7ff",
          "text-valign": "bottom",
          "text-halign": "center",
          "text-margin-y": 4,
          "text-outline-color": "#0f172a",
          "text-outline-width": 2,
          "width": 28,
          "height": 28,
        },
      },
      {
        selector: "node:selected",
        style: { "background-color": "#f0abfc", "border-color": "#e879f9", "border-width": 3 },
      },
      {
        selector: "edge",
        style: {
          "width": 1.4,
          "line-color": "rgba(168,85,247,0.5)",
          "target-arrow-color": "rgba(168,85,247,0.7)",
          "target-arrow-shape": "triangle",
          "curve-style": "bezier",
          "label": "data(relType)",
          "font-size": 9,
          "color": "#a3a3a3",
          "text-rotation": "autorotate",
          "text-background-color": "#0f172a",
          "text-background-opacity": 0.6,
          "text-background-padding": "2",
        },
      },
    ],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    layout: { name: "fcose", animate: false } as any,
    wheelSensitivity: 0.25,
  });
  cy.on("tap", "node", (event) => {
    const data = event.target.data();
    selectedNode.value = data.node ?? null;
  });
  cy.on("tap", (event) => {
    if (event.target === cy) selectedNode.value = null;
  });
}

function formatPropValue(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try { return JSON.stringify(value); } catch { return String(value); }
}

// ── Memory loaders ────────────────────────────────────────────────────────

async function loadMemory(): Promise<void> {
  memoryLoading.value = true;
  memoryError.value = null;
  try {
    const params = new URLSearchParams({
      scope: memoryScope.value,
      limit: "200",
    });
    if (memoryQuery.value.trim()) params.set("query", memoryQuery.value.trim());
    const res = await fetch(`${apiBase()}/api/memory/entries?${params}`, { headers: authHeaders() });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json() as { records: MemoryRecord[]; total: number };
    memoryRecords.value = data.records ?? [];
    memoryTotal.value = data.total ?? memoryRecords.value.length;
  } catch (err) {
    memoryError.value = err instanceof Error ? err.message : String(err);
  } finally {
    memoryLoading.value = false;
  }
}

async function loadCuration(): Promise<void> {
  try {
    const res = await fetch(`${apiBase()}/api/memory/curation`, { headers: authHeaders() });
    if (!res.ok) return;
    curationReport.value = await res.json() as CurationReport;
  } catch {
    /* non-fatal */
  }
}

async function runCurate(): Promise<void> {
  curating.value = true;
  try {
    const res = await fetch(`${apiBase()}/api/memory/curate`, { method: "POST", headers: authHeaders() });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    await Promise.all([loadMemory(), loadCuration()]);
  } catch (err) {
    memoryError.value = err instanceof Error ? err.message : String(err);
  } finally {
    curating.value = false;
  }
}

function onMemoryQueryChange(): void {
  if (memoryQueryTimer) clearTimeout(memoryQueryTimer);
  memoryQueryTimer = setTimeout(() => { void loadMemory(); }, 250);
}

function formatDate(iso: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

watch(activeTab, (tab) => {
  if (tab === "graph") {
    nextTick(() => { void loadGraph(); });
  } else {
    void loadMemory();
    void loadCuration();
  }
});

onMounted(async () => {
  await Promise.all([loadGraphLabels(), loadMemory(), loadCuration()]);
  await nextTick();
  void loadGraph();
});

onBeforeUnmount(() => {
  if (memoryQueryTimer) clearTimeout(memoryQueryTimer);
  cy?.destroy();
  cy = null;
});

void computed; // silence unused-import lint without needing to remove it
</script>

<style scoped>
.memory-page {
  display: flex;
  flex-direction: column;
  background: rgba(8, 10, 18, 0.92);
  color: rgb(229 231 235);
  overflow: hidden;
}

.memory-page__header {
  padding: 1.25rem 1.5rem 0.75rem;
  border-bottom: 1px solid rgba(168, 85, 247, 0.18);
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1.5rem;
}

.memory-page__title {
  font-size: 1.4rem;
  font-weight: 700;
  letter-spacing: -0.01em;
  margin: 0 0 0.25rem;
}

.memory-page__subtitle {
  margin: 0;
  font-size: 0.85rem;
  color: rgb(156 163 175);
  max-width: 56rem;
}

.memory-page__subtitle code {
  font-family: 'SFMono-Regular', Consolas, monospace;
  background: rgba(168, 85, 247, 0.18);
  color: rgb(216 180 254);
  padding: 0.05rem 0.3rem;
  border-radius: 4px;
  font-size: 0.78em;
}

.memory-page__tabs {
  display: flex;
  gap: 0.4rem;
  flex-shrink: 0;
}

.memory-page__tab {
  appearance: none;
  border: 1px solid rgba(168, 85, 247, 0.2);
  background: rgba(31, 41, 55, 0.55);
  color: rgb(209 213 219);
  padding: 0.45rem 0.95rem;
  border-radius: 999px;
  font-size: 0.82rem;
  font-weight: 500;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}

.memory-page__tab:hover {
  background: rgba(168, 85, 247, 0.15);
  color: rgb(243 232 255);
}

.memory-page__tab--active {
  background: rgba(168, 85, 247, 0.32);
  color: #fff;
  border-color: rgba(168, 85, 247, 0.55);
}

.memory-page__panel {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 1rem 1.5rem 1.5rem;
  position: relative;
  overflow: hidden;
}

.memory-page__notice {
  padding: 0.75rem 1rem;
  border-radius: 0.75rem;
  border: 1px solid rgba(156, 163, 175, 0.25);
  background: rgba(31, 41, 55, 0.45);
  color: rgb(209 213 219);
  font-size: 0.85rem;
  margin-bottom: 0.75rem;
}

.memory-page__notice--error {
  border-color: rgba(248, 113, 113, 0.45);
  background: rgba(127, 29, 29, 0.25);
  color: rgb(254 202 202);
}

.memory-page__notice--info {
  margin-top: 0.5rem;
  border-color: rgba(56, 189, 248, 0.32);
  background: rgba(8, 47, 73, 0.35);
  color: rgb(186 230 253);
}

/* ── Graph controls + canvas ───────────────────────────────────────────── */
.graph-controls {
  display: flex;
  align-items: center;
  gap: 0.85rem;
  flex-wrap: wrap;
  margin-bottom: 0.75rem;
}

.graph-controls__group {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.graph-controls__label {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: rgb(156 163 175);
}

.graph-controls__select {
  appearance: none;
  background: rgba(31, 41, 55, 0.6);
  color: rgb(229 231 235);
  border: 1px solid rgba(168, 85, 247, 0.25);
  border-radius: 0.55rem;
  padding: 0.35rem 0.7rem;
  font-size: 0.85rem;
}

.graph-controls__refresh {
  appearance: none;
  background: rgba(168, 85, 247, 0.22);
  color: rgb(243 232 255);
  border: 1px solid rgba(168, 85, 247, 0.45);
  border-radius: 999px;
  padding: 0.35rem 0.95rem;
  font-size: 0.82rem;
  cursor: pointer;
}

.graph-controls__refresh:disabled { opacity: 0.55; cursor: not-allowed; }
.graph-controls__refresh:hover:not(:disabled) { background: rgba(168, 85, 247, 0.36); }

.graph-controls__meta {
  margin-left: auto;
  font-size: 0.78rem;
  color: rgb(156 163 175);
}

.graph-controls__meta--warn {
  color: rgb(252 211 77);
  margin-left: 0.4rem;
}

.graph-canvas {
  flex: 1 1 auto;
  min-height: 24rem;
  border-radius: 0.85rem;
  border: 1px solid rgba(168, 85, 247, 0.2);
  background: rgba(15, 23, 42, 0.55);
}

.graph-detail {
  position: absolute;
  top: 5.5rem;
  right: 1.5rem;
  width: 22rem;
  max-height: calc(100% - 7rem);
  overflow: auto;
  background: rgba(8, 10, 18, 0.96);
  border: 1px solid rgba(168, 85, 247, 0.4);
  border-radius: 0.85rem;
  padding: 0.85rem 1rem 1rem;
  box-shadow: 0 18px 38px rgba(15, 8, 32, 0.55);
  backdrop-filter: blur(6px);
}

.graph-detail__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.4rem;
}

.graph-detail__label {
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: rgb(196 181 253);
}

.graph-detail__close {
  appearance: none;
  background: transparent;
  border: none;
  color: rgb(156 163 175);
  font-size: 1.1rem;
  cursor: pointer;
}

.graph-detail__title {
  margin: 0 0 0.6rem;
  font-size: 1rem;
  word-break: break-word;
}

.graph-detail__props {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.25rem 0.6rem;
  margin: 0;
  font-size: 0.78rem;
}

.graph-detail__props dt {
  color: rgb(156 163 175);
  font-weight: 500;
}

.graph-detail__props dd {
  margin: 0;
  color: rgb(229 231 235);
  word-break: break-word;
}

/* ── Memory list ────────────────────────────────────────────────────────── */
.memory-controls {
  display: flex;
  align-items: center;
  gap: 0.85rem;
  flex-wrap: wrap;
  margin-bottom: 0.75rem;
}

.memory-controls__group { display: flex; align-items: center; gap: 0.4rem; }
.memory-controls__group--grow { flex: 1 1 auto; min-width: 14rem; }

.memory-controls__label {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: rgb(156 163 175);
}

.memory-controls__select,
.memory-controls__input {
  appearance: none;
  background: rgba(31, 41, 55, 0.6);
  color: rgb(229 231 235);
  border: 1px solid rgba(168, 85, 247, 0.25);
  border-radius: 0.55rem;
  padding: 0.35rem 0.7rem;
  font-size: 0.85rem;
}

.memory-controls__input { flex: 1 1 auto; }

.memory-controls__refresh {
  appearance: none;
  background: rgba(168, 85, 247, 0.22);
  color: rgb(243 232 255);
  border: 1px solid rgba(168, 85, 247, 0.45);
  border-radius: 999px;
  padding: 0.35rem 0.95rem;
  font-size: 0.82rem;
  cursor: pointer;
}

.memory-list {
  flex: 1 1 auto;
  overflow-y: auto;
  display: grid;
  gap: 0.65rem;
}

.memory-card {
  border: 1px solid rgba(168, 85, 247, 0.18);
  background: rgba(15, 23, 42, 0.55);
  border-radius: 0.85rem;
  padding: 0.7rem 0.95rem 0.85rem;
}

.memory-card__header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  font-size: 0.7rem;
  letter-spacing: 0.04em;
  color: rgb(156 163 175);
  margin-bottom: 0.35rem;
}

.memory-card__kind {
  text-transform: uppercase;
  font-weight: 700;
  color: rgb(216 180 254);
}

.memory-card__scope {
  text-transform: uppercase;
  background: rgba(75, 85, 99, 0.45);
  border-radius: 999px;
  padding: 0.05rem 0.45rem;
}

.memory-card__owner {
  font-family: 'SFMono-Regular', Consolas, monospace;
}

.memory-card__date {
  margin-left: auto;
}

.memory-card__subject {
  margin: 0 0 0.3rem;
  font-size: 0.92rem;
  color: rgb(243 232 255);
}

.memory-card__content {
  margin: 0;
  font-size: 0.85rem;
  white-space: pre-wrap;
  color: rgb(229 231 235);
}

.memory-card__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  margin-top: 0.45rem;
}

.memory-card__tag {
  font-size: 0.7rem;
  background: rgba(56, 189, 248, 0.15);
  color: rgb(186 230 253);
  border: 1px solid rgba(56, 189, 248, 0.32);
  border-radius: 999px;
  padding: 0.05rem 0.5rem;
}
</style>
