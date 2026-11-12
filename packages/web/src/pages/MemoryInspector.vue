<template>
  <div class="page-shell memory-page">
    <header class="page-header">
      <div class="page-header__text">
        <h1 class="page-title">Memory &amp; Knowledge</h1>
        <p class="page-subtitle">
          Two different stores live here. The Memory Store tab shows durable workspace or user memory
          records. The Knowledge Graph tab shows MemGraph nodes and edges, including durable memory
          write-through, FACT promotions, and explicit entity links created through
          <code>graph_upsert_entity</code> and <code>graph_relate</code>.
        </p>
      </div>
      <!-- The tabs wrap onto a second row on a narrow screen instead of leaving it. -->
      <div class="page-actions" role="tablist" aria-label="Memory views">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          type="button"
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
        <button type="button" class="graph-controls__refresh" @click="loadGraph()" :disabled="graphLoading">
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
      <!-- Nothing under one label is not the same as an empty graph. -->
      <div v-else-if="graphData.nodes.length === 0 && !graphLoading && graphLabelFilter" class="memory-page__notice">
        No graph nodes carry the label “{{ graphLabelFilter }}”.
        <button type="button" class="memory-card__btn ml-2" @click="clearGraphLabel()">Clear filters</button>
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
          <button type="button" class="graph-detail__close" @click="selectedNode = null" aria-label="Close detail">×</button>
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

    <!-- Session shared-facts tab -->
    <section v-if="activeTab === 'facts'" class="memory-page__panel">
      <div class="memory-controls">
        <div class="memory-controls__group memory-controls__group--grow">
          <label class="memory-controls__label">Session ID</label>
          <input
            v-model="factsSessionId"
            type="search"
            class="memory-controls__input"
            placeholder="Paste a session ID to inspect what the swarm shared during it"
            @keyup.enter="loadSharedFacts()"
          />
        </div>
        <button type="button" class="memory-controls__refresh" @click="loadSharedFacts()" :disabled="factsLoading || !factsSessionId.trim()">
          {{ factsLoading ? "Loading…" : "Load" }}
        </button>
      </div>
      <div v-if="factsError" class="memory-page__notice memory-page__notice--error">{{ factsError }}</div>
      <div v-else-if="!factsLoaded" class="memory-page__notice">
        Enter a session ID (from the Sessions page or an audit export) and press Load to see the
        <strong>shared facts</strong> that sub-agents published via <code>share_finding</code> — plus
        auto-extracted findings — during that swarm turn. These live for the session only and are not
        in the Memory Store tab.
      </div>
      <div v-else-if="sharedFacts.length === 0 && !factsLoading" class="memory-page__notice">
        No shared facts for this session. Either nothing was published this session, or it has expired.
      </div>
      <div v-else class="memory-list">
        <article v-for="fact in sharedFacts" :key="fact.key" class="memory-card">
          <header class="memory-card__header">
            <span :class="['fact-badge', fact.auto ? 'fact-badge--auto' : 'fact-badge--shared']">
              {{ fact.auto ? "auto-extracted" : "shared" }}
            </span>
            <span class="memory-card__owner">{{ fact.key }}</span>
          </header>
          <p class="memory-card__content">{{ fact.value }}</p>
        </article>
      </div>
      <div v-if="factsLoaded && sharedFacts.length > 0" class="memory-page__notice memory-page__notice--info">
        {{ sharedFacts.length }} fact(s) · shared session <code>{{ factsSharedSessionId }}</code>
      </div>
    </section>

    <!-- Memory store tab -->
    <section v-else-if="activeTab === 'memory'" class="memory-page__panel">
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
        <button type="button" class="memory-controls__refresh" @click="loadMemory()" :disabled="memoryLoading">
          {{ memoryLoading ? "Loading…" : "Refresh" }}
        </button>
        <button
          v-if="memoryScope === 'workspace'"
          type="button"
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
      <!-- An empty list after a load that worked is one of two things: the search hides every
           entry, or the store has none. -->
      <div v-else-if="memoryLoaded && memoryRecords.length === 0 && !memoryLoading && memoryLoaded.query" class="empty-state">
        <p>{{ noMatchLine("memory entries", memoryLoaded.query) }}</p>
        <button type="button" class="memory-controls__refresh mt-3" @click="clearMemorySearch()">Clear filters</button>
      </div>
      <div v-else-if="memoryLoaded && memoryRecords.length === 0 && !memoryLoading" class="empty-state">
        No memory entries yet. Workspace memory is written by <code>memory_store</code>,
        <code>record_lesson</code>, and durable promotions from session memory. Session shared facts,
        trajectory cache entries, and arbitrary workspace files are not shown in this tab.
      </div>
      <div class="memory-list">
        <article
          v-for="record in memoryWindow.visible"
          :key="record.id"
          class="memory-card"
        >
          <header class="memory-card__header">
            <span class="memory-card__kind">{{ record.kind }}</span>
            <span class="memory-card__scope">{{ record.scope }}</span>
            <span class="memory-card__owner">{{ record.ownerType }}:{{ record.ownerId }}</span>
            <time class="memory-card__date" :datetime="isoTimestamp(record.updatedAt)" :title="isoTimestamp(record.updatedAt)">{{ formatDateTime(record.updatedAt) }}</time>
          </header>

          <!-- Inline editor -->
          <template v-if="editingKey && editingKey === record.key">
            <input
              v-model="editSubject"
              class="memory-controls__input memory-edit__field"
              placeholder="Subject"
            />
            <textarea
              v-model="editContent"
              rows="4"
              class="memory-controls__input memory-edit__field memory-edit__textarea"
              placeholder="Content"
            />
            <input
              v-model="editTags"
              class="memory-controls__input memory-edit__field"
              placeholder="Comma-separated tags"
            />
            <div class="memory-card__actions">
              <button
                type="button"
                class="memory-card__btn memory-card__btn--save"
                :disabled="savingEdit || !editContent.trim()"
                @click="saveEdit(record)"
              >{{ savingEdit ? "Saving…" : "Save" }}</button>
              <button type="button" class="memory-card__btn" :disabled="savingEdit" @click="cancelEdit()">Cancel</button>
            </div>
          </template>

          <!-- Read view -->
          <template v-else>
            <h3 class="memory-card__subject">{{ record.subject || record.key || record.id }}</h3>
            <p class="memory-card__content">{{ record.content }}</p>
            <footer v-if="record.tags && record.tags.length > 0" class="memory-card__tags">
              <span v-for="tag in record.tags" :key="tag" class="memory-card__tag">{{ tag }}</span>
            </footer>
            <div class="memory-card__actions">
              <template v-if="confirmDeleteKey && confirmDeleteKey === record.key">
                <span class="memory-card__confirm">Delete permanently?</span>
                <button
                  type="button"
                  class="memory-card__btn memory-card__btn--danger"
                  :disabled="deletingKey === record.key"
                  @click="deleteRecord(record)"
                >{{ deletingKey === record.key ? "Deleting…" : "Confirm" }}</button>
                <button type="button" class="memory-card__btn" @click="confirmDeleteKey = null">Cancel</button>
              </template>
              <template v-else>
                <button
                  type="button"
                  class="memory-card__btn"
                  :disabled="!record.key"
                  :title="record.key ? 'Edit this entry' : 'This entry has no key and cannot be edited'"
                  @click="startEdit(record)"
                >Edit</button>
                <button
                  type="button"
                  class="memory-card__btn memory-card__btn--danger"
                  :disabled="!record.key"
                  @click="confirmDeleteKey = record.key ?? null"
                >Delete</button>
              </template>
            </div>
          </template>
        </article>
      </div>
      <!-- Under the list, which scrolls by itself: how much of it is drawn, and how much of what
           the gateway holds has been loaded at all. -->
      <div v-if="memoryRecords.length > 0 && (memoryWindow.paged || memoryCapNote)" class="mt-3 flex shrink-0 flex-col items-center gap-2 text-center">
        <div v-if="memoryWindow.hasMore || canLoadMoreMemory" class="flex flex-wrap justify-center gap-2">
          <button v-if="memoryWindow.hasMore" type="button" class="memory-controls__refresh" @click="memoryWindow.showMore()">
            Show {{ memoryWindow.nextStep }} more
          </button>
          <button v-if="canLoadMoreMemory" type="button" class="memory-controls__refresh" :disabled="memoryLoading" @click="loadMoreMemory()">
            {{ memoryLoading ? "Loading…" : "Load more from the gateway" }}
          </button>
        </div>
        <p class="text-xs text-gray-400" aria-live="polite">
          {{ memoryWindow.summary }} entries<template v-if="memoryCapNote"> · {{ memoryCapNote }}</template>
        </p>
      </div>
    </section>

    <!-- Assistant personality tab -->
    <section v-if="activeTab === 'personality'" class="memory-page__panel">
      <div class="memory-controls">
        <button type="button" class="memory-controls__refresh" :disabled="personality.loading || pEditing" @click="personality.fetch()">
          {{ personality.loading ? "Loading…" : "Refresh" }}
        </button>
        <button
          v-if="personality.profile && !pEditing"
          type="button"
          class="memory-controls__refresh"
          :disabled="personality.saving"
          @click="startPersonalityEdit()"
        >Edit</button>
        <RouterLink :to="{ path: '/agents', hash: '#personality' }" class="memory-controls__refresh memory-controls__refresh--link">
          Full editor in Manage → Agent tuning
        </RouterLink>
      </div>
      <div v-if="personality.error" class="memory-page__notice memory-page__notice--error">{{ personality.error }}</div>
      <!-- Its own chain: the error above used to head it, so a failed save hid the editor (and
           what was typed into it) behind the error line with no way back. -->
      <div v-if="!personality.profile && !personality.loading && !personality.error" class="memory-page__notice">
        No assistant personality saved yet. It is written by <code>assistant_personality_update</code>
        (the assistant's own name, voice, and quirks) and editable here or on
        <RouterLink :to="{ path: '/agents', hash: '#personality' }" class="underline decoration-dotted hover:text-white">Manage → Agent tuning</RouterLink>.
        This is a separate store from the durable memory records in the Memory Store tab.
      </div>

      <!-- Inline editor (reuses the same PUT /api/personality the Agent tuning page uses) -->
      <div v-else-if="pEditing" class="memory-list">
        <article class="memory-card">
          <header class="memory-card__header">
            <span class="memory-card__kind">personality</span>
            <span class="memory-card__scope">editing</span>
            <span class="memory-card__owner">rev {{ personality.profile?.revision }}</span>
          </header>
          <label class="personality-group__label" for="p-name">Name</label>
          <input id="p-name" v-model="pForm.name" class="memory-controls__input memory-edit__field" placeholder="e.g. Luna" />
          <label class="personality-group__label" for="p-core">Core identity</label>
          <textarea id="p-core" v-model="pForm.core" rows="3" class="memory-controls__input memory-edit__field memory-edit__textarea" placeholder="Core identity and overall vibe for the assistant." />
          <label class="personality-group__label" for="p-tone">Tone <span class="personality-hint">(one per line)</span></label>
          <textarea id="p-tone" v-model="pForm.toneText" rows="3" class="memory-controls__input memory-edit__field memory-edit__textarea" placeholder="Direct and plainspoken." />
          <label class="personality-group__label" for="p-style">Style <span class="personality-hint">(one per line)</span></label>
          <textarea id="p-style" v-model="pForm.styleText" rows="3" class="memory-controls__input memory-edit__field memory-edit__textarea" placeholder="Lead with the decisive tradeoff." />
          <label class="personality-group__label" for="p-quirks">Quirks <span class="personality-hint">(one per line)</span></label>
          <textarea id="p-quirks" v-model="pForm.quirksText" rows="3" class="memory-controls__input memory-edit__field memory-edit__textarea" placeholder="Dry humor when it helps." />
          <label class="personality-group__label" for="p-defaults">Collaboration defaults <span class="personality-hint">(one per line)</span></label>
          <textarea id="p-defaults" v-model="pForm.defaultsText" rows="3" class="memory-controls__input memory-edit__field memory-edit__textarea" placeholder="Lead with the decisive tradeoff before listing options." />
          <label class="personality-group__label" for="p-avoidances">Avoidances <span class="personality-hint">(one per line)</span></label>
          <textarea id="p-avoidances" v-model="pForm.avoidancesText" rows="3" class="memory-controls__input memory-edit__field memory-edit__textarea" placeholder="Do not become flattering, theatrical, or vague." />
          <label class="personality-group__label" for="p-growth">Growth notes <span class="personality-hint">(one per line)</span></label>
          <textarea id="p-growth" v-model="pForm.growthText" rows="3" class="memory-controls__input memory-edit__field memory-edit__textarea" placeholder="Stable lessons the assistant should carry forward." />
          <label class="personality-group__label" for="p-reason">Reason for this change <span class="personality-hint">(optional)</span></label>
          <input id="p-reason" v-model="pForm.reason" class="memory-controls__input memory-edit__field" placeholder="Why this durable personality change matters." />
          <div class="memory-card__actions">
            <button type="button" class="memory-card__btn memory-card__btn--save" :disabled="personality.saving || !pForm.core.trim()" @click="savePersonalityEdit()">
              {{ personality.saving ? "Saving…" : "Save" }}
            </button>
            <button type="button" class="memory-card__btn" :disabled="personality.saving" @click="cancelPersonalityEdit()">Cancel</button>
          </div>
        </article>
      </div>

      <!-- Read view -->
      <div v-else-if="personality.profile" class="memory-list">
        <article class="memory-card">
          <header class="memory-card__header">
            <span class="memory-card__kind">personality</span>
            <span class="memory-card__scope">assistant</span>
            <span class="memory-card__owner">rev {{ personality.profile.revision }}</span>
            <span class="memory-card__owner">by {{ personality.profile.updatedBy }}</span>
            <time class="memory-card__date" :datetime="isoTimestamp(personality.profile.updatedAt)" :title="isoTimestamp(personality.profile.updatedAt)">{{ formatDateTime(personality.profile.updatedAt) }}</time>
          </header>
          <h3 class="memory-card__subject">{{ personality.profile.identity.name || "Unnamed assistant" }}</h3>
          <p class="memory-card__content">{{ personality.profile.identity.core }}</p>

          <template v-for="group in personalityGroups" :key="group.label">
            <div v-if="group.items.length > 0" class="personality-group">
              <span class="personality-group__label">{{ group.label }}</span>
              <ul class="personality-group__list">
                <li v-for="(item, i) in group.items" :key="group.label + i">{{ item }}</li>
              </ul>
            </div>
          </template>

          <footer v-if="personality.profile.reason" class="memory-card__tags">
            <span class="memory-card__tag">reason: {{ personality.profile.reason }}</span>
          </footer>
        </article>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import fcose from "cytoscape-fcose";
import { useGatewayStore } from "@/stores/gateway";
import { usePersonalityStore } from "@/stores/personality";
import { formatDateTime, isoTimestamp } from "@/composables/formatDate";
import { noMatchLine, useListWindow } from "@/composables/listWindow";
import { confirmAction } from "@/composables/useConfirm";
import { useLoadWhenConnected } from "@/composables/useLoadWhenConnected";
import { useToast, errorText } from "@/composables/useToast";

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
const personality = usePersonalityStore();
const toast = useToast();

const tabs = [
  { id: "memory", label: "Memory Store" },
  { id: "personality", label: "Personality" },
  { id: "graph", label: "Knowledge Graph" },
  { id: "facts", label: "Session Facts" },
] as const;

// Open on the Memory Store — the durable records users mean by "memory". The
// Knowledge Graph tab is empty whenever MemGraph isn't running, which previously
// made a freshly-opened page look like it had "no entries".
const activeTab = ref<typeof tabs[number]["id"]>("memory");

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

// The gateway sends the first `limit` entries that match — 500 at most — and says how many match
// in all (core's gateway/memory-graph-routes.ts). It takes no offset, so past 500 the way to an
// entry is the search, which the gateway applies to the whole store before it cuts.
const MEMORY_FIRST_LIMIT = 200;
const MEMORY_MAX_LIMIT = 500;
const memoryLimit = ref(MEMORY_FIRST_LIMIT);
// What the list on screen was asked for; null until a load has worked.
const memoryLoaded = ref<{ scope: "workspace" | "user"; query: string; limit: number } | null>(null);
// Counts loads, so a slow answer to an earlier search cannot land under a newer one.
let memoryLoadRun = 0;

// The cards are drawn a page at a time; another scope or search starts again at the first page.
const memoryWindow = useListWindow(() => memoryRecords.value, {
  resetKey: () => `${memoryLoaded.value?.scope ?? ""}|${memoryLoaded.value?.query ?? ""}`,
});

const canLoadMoreMemory = computed(() =>
  memoryTotal.value > memoryRecords.value.length && (memoryLoaded.value?.limit ?? 0) < MEMORY_MAX_LIMIT);

// Said in the count line whenever the gateway holds more than was loaded, so that a cut list is
// not taken for the whole store.
const memoryCapNote = computed(() => {
  const loaded = memoryRecords.value.length;
  if (memoryTotal.value <= loaded) return "";
  const what = memoryLoaded.value?.query ? "matching entries" : "entries";
  const held = `the gateway has ${memoryTotal.value} ${what}; the first ${loaded} are loaded`;
  return canLoadMoreMemory.value
    ? held
    : `${held}, and it sends no more than ${MEMORY_MAX_LIMIT} — search to reach the rest`;
});

// ── Per-entry edit / delete state ─────────────────────────────────────────
const editingKey = ref<string | null>(null);
const editSubject = ref<string>("");
const editContent = ref<string>("");
const editTags = ref<string>("");
const savingEdit = ref(false);
const confirmDeleteKey = ref<string | null>(null);
const deletingKey = ref<string | null>(null);

// Flatten the assistant personality profile into labelled list groups for display.
const personalityGroups = computed<Array<{ label: string; items: string[] }>>(() => {
  const p = personality.profile;
  if (!p) return [];
  return [
    { label: "Tone", items: p.voice.tone },
    { label: "Style", items: p.voice.style },
    { label: "Quirks", items: p.voice.quirks },
    { label: "Collaboration defaults", items: p.collaboration.defaults },
    { label: "Avoidances", items: p.collaboration.avoidances },
    { label: "Growth notes", items: p.growth.notes },
  ];
});

// ── Inline personality editing (reuses the personality store's PUT save) ────
const pEditing = ref(false);
const pForm = ref({
  name: "",
  core: "",
  toneText: "",
  styleText: "",
  quirksText: "",
  defaultsText: "",
  avoidancesText: "",
  growthText: "",
  reason: "",
});

function linesToList(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

function startPersonalityEdit(): void {
  const p = personality.profile;
  if (!p) return;
  pForm.value = {
    name: p.identity.name ?? "",
    core: p.identity.core ?? "",
    toneText: (p.voice.tone ?? []).join("\n"),
    styleText: (p.voice.style ?? []).join("\n"),
    quirksText: (p.voice.quirks ?? []).join("\n"),
    defaultsText: (p.collaboration.defaults ?? []).join("\n"),
    avoidancesText: (p.collaboration.avoidances ?? []).join("\n"),
    growthText: (p.growth.notes ?? []).join("\n"),
    reason: "",
  };
  pEditing.value = true;
}

function cancelPersonalityEdit(): void {
  pEditing.value = false;
}

async function savePersonalityEdit(): Promise<void> {
  const f = pForm.value;
  if (!f.core.trim()) return;
  // The store's save() returns without a word when there is no token; say so instead of
  // reporting a save that never went out.
  if (!gateway.token) {
    toast.error("Couldn't save the personality", "Not connected to the gateway. Sign in and save again.");
    return;
  }
  // Send every field back — the PUT replaces the whole profile, so omitting a
  // list would wipe it. personality.save() catches its own errors into
  // personality.error; only leave edit mode when the save actually succeeded.
  await personality.save({
    identity: { core: f.core.trim(), name: f.name.trim() || undefined },
    voice: {
      tone: linesToList(f.toneText),
      style: linesToList(f.styleText),
      quirks: linesToList(f.quirksText),
    },
    collaboration: {
      defaults: linesToList(f.defaultsText),
      avoidances: linesToList(f.avoidancesText),
    },
    growth: { notes: linesToList(f.growthText) },
    ...(f.reason.trim() ? { reason: f.reason.trim() } : {}),
  });
  if (personality.error) {
    // The store's error line sits at the top of the tab, a long form away from this button.
    toast.error("Couldn't save the personality", personality.error);
    return;
  }
  pEditing.value = false;
  toast.success("Personality saved", `Revision ${personality.profile?.revision ?? "—"} is what the assistant uses from now on.`);
}

interface CurationReport {
  totalRecords: number;
  duplicateClusters: number;
  removableDuplicates: number;
  staleVolatile: number;
  nudge: string;
}
const curationReport = ref<CurationReport | null>(null);
const curating = ref(false);

// ── Session shared-facts state ──────────────────────────────────────────────
const factsSessionId = ref<string>("");
const factsLoading = ref(false);
const factsError = ref<string | null>(null);
const factsLoaded = ref(false);
const factsSharedSessionId = ref<string>("");
const sharedFacts = ref<Array<{ key: string; value: string; auto: boolean }>>([]);

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
  const run = ++memoryLoadRun;
  const request = { scope: memoryScope.value, query: memoryQuery.value.trim(), limit: memoryLimit.value };
  memoryLoading.value = true;
  memoryError.value = null;
  try {
    const params = new URLSearchParams({
      scope: request.scope,
      limit: String(request.limit),
    });
    if (request.query) params.set("query", request.query);
    const res = await fetch(`${apiBase()}/api/memory/entries?${params}`, { headers: authHeaders() });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json() as { records: MemoryRecord[]; total: number };
    if (run !== memoryLoadRun) return; // a newer load owns the list now
    memoryRecords.value = data.records ?? [];
    memoryTotal.value = data.total ?? memoryRecords.value.length;
    memoryLoaded.value = request;
  } catch (err) {
    if (run === memoryLoadRun) memoryError.value = err instanceof Error ? err.message : String(err);
  } finally {
    if (run === memoryLoadRun) memoryLoading.value = false;
  }
}

async function loadMoreMemory(): Promise<void> {
  memoryLimit.value = MEMORY_MAX_LIMIT;
  await loadMemory();
}

function clearMemorySearch(): void {
  if (memoryQueryTimer) clearTimeout(memoryQueryTimer);
  memoryQuery.value = "";
  void loadMemory();
}

function clearGraphLabel(): void {
  graphLabelFilter.value = "";
  void loadGraph();
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
  if (curating.value) return;
  const duplicates = curationReport.value?.removableDuplicates ?? 0;
  const groups = curationReport.value?.duplicateClusters ?? 0;
  if (!(await confirmAction({
    title: `Merge ${duplicates} duplicate ${duplicates === 1 ? "memory" : "memories"}?`,
    message: `Workspace memory has ${groups} group${groups === 1 ? "" : "s"} of entries that say nearly the same thing. Each group is folded into one entry and the other ${duplicates === 1 ? "copy is" : `${duplicates} copies are`} deleted. This cannot be undone.`,
    confirmLabel: "Merge duplicates",
    danger: true,
  }))) return;
  curating.value = true;
  try {
    const res = await fetch(`${apiBase()}/api/memory/curate`, { method: "POST", headers: authHeaders() });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const result = await res.json().catch(() => ({})) as { after?: { removed?: number; merged?: number; kept?: number } };
    const removed = result.after?.removed ?? duplicates;
    toast.success(
      "Duplicates merged",
      `${removed} duplicate ${removed === 1 ? "entry was" : "entries were"} folded away`
        + (typeof result.after?.kept === "number" ? `; ${result.after.kept} remain in workspace memory.` : "."),
    );
    await Promise.all([loadMemory(), loadCuration()]);
  } catch (err) {
    toast.error("Couldn't merge the duplicates", errorText(err));
  } finally {
    curating.value = false;
  }
}

async function loadSharedFacts(): Promise<void> {
  const sid = factsSessionId.value.trim();
  if (!sid) return;
  factsLoading.value = true;
  factsError.value = null;
  try {
    const res = await fetch(`${apiBase()}/api/sessions/${encodeURIComponent(sid)}/shared-facts`, { headers: authHeaders() });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json() as { sharedSessionId: string; facts: Array<{ key: string; value: string; auto: boolean }> };
    sharedFacts.value = data.facts ?? [];
    factsSharedSessionId.value = data.sharedSessionId ?? "";
    factsLoaded.value = true;
  } catch (err) {
    factsError.value = err instanceof Error ? err.message : String(err);
    factsLoaded.value = true;
  } finally {
    factsLoading.value = false;
  }
}

function onMemoryQueryChange(): void {
  if (memoryQueryTimer) clearTimeout(memoryQueryTimer);
  memoryQueryTimer = setTimeout(() => { void loadMemory(); }, 250);
}

function startEdit(record: MemoryRecord): void {
  if (!record.key) return;
  confirmDeleteKey.value = null;
  editingKey.value = record.key;
  editSubject.value = record.subject ?? "";
  editContent.value = record.content ?? "";
  editTags.value = (record.tags ?? []).join(", ");
}

function cancelEdit(): void {
  editingKey.value = null;
}

async function saveEdit(record: MemoryRecord): Promise<void> {
  if (!record.key || !editContent.value.trim()) return;
  savingEdit.value = true;
  try {
    const params = new URLSearchParams({ scope: memoryScope.value });
    const res = await fetch(`${apiBase()}/api/memory/entries/${encodeURIComponent(record.key)}?${params}`, {
      method: "PATCH",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        subject: editSubject.value,
        content: editContent.value,
        tags: editTags.value.split(",").map((t) => t.trim()).filter(Boolean),
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    editingKey.value = null;
    toast.success("Memory entry saved", `“${editSubject.value.trim() || record.key}” was updated.`);
    await Promise.all([loadMemory(), loadCuration()]);
  } catch (err) {
    // A toast, not the line above the list: the card being edited can be far down the page.
    toast.error("Couldn't save the memory entry", errorText(err));
  } finally {
    savingEdit.value = false;
  }
}

async function deleteRecord(record: MemoryRecord): Promise<void> {
  if (!record.key) return;
  deletingKey.value = record.key;
  try {
    const params = new URLSearchParams({ scope: memoryScope.value });
    const res = await fetch(`${apiBase()}/api/memory/entries/${encodeURIComponent(record.key)}?${params}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    confirmDeleteKey.value = null;
    toast.success("Memory entry deleted", `“${record.subject || record.key}” was removed from ${memoryScope.value} memory.`);
    await Promise.all([loadMemory(), loadCuration()]);
  } catch (err) {
    toast.error("Couldn't delete the memory entry", errorText(err));
  } finally {
    deletingKey.value = null;
  }
}

watch(activeTab, (tab) => {
  if (tab === "graph") {
    nextTick(() => { void loadGraph(); });
  } else if (tab === "facts") {
    if (factsSessionId.value.trim() && !factsLoaded.value) void loadSharedFacts();
  } else if (tab === "personality") {
    if (!personality.profile) void personality.fetch();
  } else {
    void loadMemory();
    void loadCuration();
  }
});

// Also when the gateway comes up after the page did (opened by URL, or signed in to here).
useLoadWhenConnected(async () => {
  await Promise.all([
    loadGraphLabels(),
    loadMemory(),
    loadCuration(),
    // Not under an open editor: its Refresh is disabled while editing, and so is this.
    pEditing.value ? Promise.resolve() : personality.fetch(),
  ]);
  await nextTick();
  void loadGraph();
});

onBeforeUnmount(() => {
  if (memoryQueryTimer) clearTimeout(memoryQueryTimer);
  cy?.destroy();
  cy = null;
});
</script>

<style scoped>
.memory-page {
  display: flex;
  flex-direction: column;
  /* Near-transparent scrim — the themed app canvas glows through. */
  background: rgba(8, 10, 18, 0.30);
  color: rgb(229 231 235);
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

/* Each tab scrolls inside its panel. The floor fits the graph's controls and the canvas's
   own 24rem; in a window shorter than that the page scrolls instead. */
.memory-page__panel {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-height: 28rem;
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

/* Offsets are from the panel, which no longer has padding of its own. */
.graph-detail {
  position: absolute;
  top: 4.5rem;
  right: 0;
  width: 22rem;
  max-height: calc(100% - 4.5rem);
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

/* ── Per-card edit / delete controls ────────────────────────────────────── */
.memory-card__actions {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
  margin-top: 0.6rem;
}

.memory-card__btn {
  appearance: none;
  background: rgba(31, 41, 55, 0.55);
  color: rgb(209 213 219);
  border: 1px solid rgba(168, 85, 247, 0.25);
  border-radius: 0.5rem;
  padding: 0.25rem 0.7rem;
  font-size: 0.76rem;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease;
}

.memory-card__btn:hover:not(:disabled) { background: rgba(168, 85, 247, 0.2); }
.memory-card__btn:disabled { opacity: 0.5; cursor: not-allowed; }

.memory-card__btn--save {
  background: rgba(52, 211, 153, 0.18);
  color: rgb(167 243 208);
  border-color: rgba(52, 211, 153, 0.4);
}

.memory-card__btn--danger {
  background: rgba(248, 113, 113, 0.14);
  color: rgb(254 202 202);
  border-color: rgba(248, 113, 113, 0.4);
}

.memory-card__btn--danger:hover:not(:disabled) { background: rgba(248, 113, 113, 0.26); }

.memory-card__confirm {
  font-size: 0.76rem;
  color: rgb(254 202 202);
  margin-right: 0.2rem;
}

.memory-edit__field { margin-top: 0.4rem; width: 100%; }
.memory-edit__textarea { resize: vertical; min-height: 5rem; font: inherit; }

/* ── Personality tab groups ─────────────────────────────────────────────── */
.memory-controls__refresh--link {
  text-decoration: none;
  display: inline-flex;
  align-items: center;
}

.personality-group { margin-top: 0.65rem; }

.personality-group__label {
  display: block;
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: rgb(196 181 253);
  margin-bottom: 0.2rem;
}

.personality-group__list {
  margin: 0;
  padding-left: 1.1rem;
  display: grid;
  gap: 0.15rem;
  font-size: 0.83rem;
  color: rgb(229 231 235);
}

.personality-hint {
  text-transform: none;
  letter-spacing: 0;
  color: rgb(120 128 145);
  font-size: 0.92em;
}

/* ── Session shared-facts badges ────────────────────────────────────────── */
.fact-badge {
  text-transform: uppercase;
  font-weight: 700;
  font-size: 0.62rem;
  letter-spacing: 0.05em;
  border-radius: 999px;
  padding: 0.05rem 0.5rem;
}

.fact-badge--shared {
  background: rgba(52, 211, 153, 0.16);
  color: rgb(167 243 208);
  border: 1px solid rgba(52, 211, 153, 0.4);
}

.fact-badge--auto {
  background: rgba(148, 163, 184, 0.16);
  color: rgb(203 213 225);
  border: 1px solid rgba(148, 163, 184, 0.35);
}
</style>
