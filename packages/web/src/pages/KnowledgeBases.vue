<template>
  <div class="knowledge-page" style="height:100%;overflow:auto;">
    <header class="knowledge-page__header">
      <div>
        <h1 class="knowledge-page__title">Knowledge Bases</h1>
        <p class="knowledge-page__subtitle">
          Named corpora crawled from documentation sites into the document-RAG library (engram). Each knowledge base is
          crawled recursively from its seed URLs; agents query it explicitly via <code>search_knowledge_base</code>, or
          — when <strong>ambient</strong> is on — its content joins every turn's document context automatically.
        </p>
      </div>
      <button v-if="gateway.connected" class="btn-ghost px-3 py-1.5 rounded-lg text-xs" :disabled="loading" @click="reload">
        {{ loading ? "Loading…" : "Reload" }}
      </button>
    </header>

    <div v-if="!gateway.connected" class="empty-state">Connect to manage knowledge bases.</div>

    <template v-else>
      <div v-if="!ragConfigured" class="knowledge-page__banner knowledge-page__banner--warn">
        Document RAG (engram) is not enabled — knowledge bases cannot crawl or search.
      </div>
      <div v-if="!enabled" class="knowledge-page__banner knowledge-page__banner--warn">
        Knowledge bases are disabled in config (<code>retrieval.knowledgeBases.enabled</code>). Existing entries are
        listed, but crawling and retrieval are off until the flag is enabled.
      </div>

      <!-- Create form -->
      <section class="glass-card p-5 mb-4">
        <div class="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h3 class="section-title mb-0">New knowledge base</h3>
            <div class="text-xs text-gray-500 mt-1">
              Point it at a documentation site; the crawl stays on the seed pages' path prefixes by default.
            </div>
          </div>
          <button class="btn-grad px-4 py-2 rounded-xl text-sm" @click="showCreate = !showCreate">
            {{ showCreate ? "Close" : "Create knowledge base" }}
          </button>
        </div>

        <div v-if="showCreate" class="knowledge-page__form">
          <div class="knowledge-page__form-grid">
            <label class="knowledge-page__field">
              <span class="knowledge-page__label">Name</span>
              <input v-model="form.name" class="input-box" placeholder="e.g. Vue 3 Docs" />
            </label>
            <label class="knowledge-page__field">
              <span class="knowledge-page__label">Description <span class="knowledge-page__hint">(optional)</span></span>
              <input v-model="form.description" class="input-box" placeholder="What this corpus covers" />
            </label>
          </div>
          <label class="knowledge-page__field">
            <span class="knowledge-page__label">Scope <span class="knowledge-page__hint">(who can see &amp; search it)</span></span>
            <select v-model="form.scope" class="input-box knowledge-page__scope-select">
              <option value="workspace">Workspace (shared with everyone)</option>
              <option value="user">Personal (only you)</option>
              <option v-if="currentSessionId" value="session">Current session</option>
            </select>
          </label>
          <label class="knowledge-page__field">
            <span class="knowledge-page__label">Seed URLs <span class="knowledge-page__hint">(one per line)</span></span>
            <textarea v-model="form.seedUrlsText" rows="3" class="input-box knowledge-page__textarea" placeholder="https://vuejs.org/guide/" />
          </label>
          <div class="knowledge-page__form-grid">
            <label class="knowledge-page__field">
              <span class="knowledge-page__label">Max pages <span class="knowledge-page__hint">(blank = default)</span></span>
              <input v-model="form.maxPagesText" type="number" min="1" class="input-box" placeholder="default" />
            </label>
            <label class="knowledge-page__field">
              <span class="knowledge-page__label">Max depth <span class="knowledge-page__hint">(blank = default)</span></span>
              <input v-model="form.maxDepthText" type="number" min="0" class="input-box" placeholder="default" />
            </label>
          </div>

          <button class="knowledge-page__advanced-toggle" type="button" @click="showAdvanced = !showAdvanced">
            {{ showAdvanced ? "▾" : "▸" }} Advanced — scope patterns &amp; crawl behavior
          </button>
          <div v-if="showAdvanced" class="knowledge-page__advanced">
            <label class="knowledge-page__field">
              <span class="knowledge-page__label">ID <span class="knowledge-page__hint">(optional slug — auto-derived from the name when blank)</span></span>
              <input v-model="form.id" class="input-box knowledge-page__textarea--mono" placeholder="e.g. wcag" />
            </label>
            <div class="knowledge-page__form-grid">
              <label class="knowledge-page__field">
                <span class="knowledge-page__label">Include patterns <span class="knowledge-page__hint">(one regex per line — widens the seed-prefix scope)</span></span>
                <textarea v-model="form.includeText" rows="3" class="input-box knowledge-page__textarea knowledge-page__textarea--mono" placeholder="^https://vuejs\.org/api/" />
              </label>
              <label class="knowledge-page__field">
                <span class="knowledge-page__label">Exclude patterns <span class="knowledge-page__hint">(one regex per line — a match is never crawled)</span></span>
                <textarea v-model="form.excludeText" rows="3" class="input-box knowledge-page__textarea knowledge-page__textarea--mono" placeholder="/changelog/" />
              </label>
            </div>
            <div class="knowledge-page__toggles">
              <label class="knowledge-page__check">
                <input v-model="form.respectRobots" type="checkbox" class="accent-purple-500" />
                <span>Respect robots.txt</span>
              </label>
              <label class="knowledge-page__check">
                <input v-model="form.ambientRetrieval" type="checkbox" class="accent-purple-500" />
                <span>Ambient retrieval <span class="knowledge-page__hint">(include in every turn's document context)</span></span>
              </label>
            </div>

            <div class="knowledge-page__worker-block">
              <div class="knowledge-page__worker-head">
                <span class="knowledge-page__label">Worker <span class="knowledge-page__hint">(optional)</span></span>
                <span class="knowledge-page__hint">The single-use agent that USES this KB when you ask <code>use {{ form.id.trim() || "<id>" }} to …</code> in chat.</span>
              </div>
              <label class="knowledge-page__field">
                <span class="knowledge-page__label">Worker instructions <span class="knowledge-page__hint">(how to apply this KB to a task — blank = default worker)</span></span>
                <textarea v-model="form.workerInstructions" rows="3" class="input-box knowledge-page__textarea" placeholder="e.g. Answer only from this knowledge base and cite the page URLs you used." />
              </label>
              <label class="knowledge-page__field">
                <span class="knowledge-page__label">Worker tools <span class="knowledge-page__hint">(one tool per line — KB search is always granted)</span></span>
                <textarea v-model="form.workerToolsText" rows="2" class="input-box knowledge-page__textarea knowledge-page__textarea--mono" placeholder="web_fetch&#10;browser_navigate" />
              </label>
            </div>
          </div>

          <div class="knowledge-page__form-actions">
            <button class="btn-grad px-4 py-2 rounded-xl text-sm" :disabled="creating || !enabled || !ragConfigured" @click="submitCreate">
              {{ creating ? "Creating…" : "Create & crawl" }}
            </button>
            <button class="btn-ghost px-3 py-2 rounded-xl text-sm" :disabled="creating" @click="resetCreate">Reset</button>
          </div>
          <div v-if="createError" class="text-sm text-red-400 mt-2">{{ createError }}</div>
        </div>
        <div v-if="createNote" class="text-sm text-emerald-300 mt-2">{{ createNote }}</div>
      </section>

      <!-- KB list -->
      <div v-if="kbs.length === 0 && !loading" class="empty-state">
        No knowledge bases yet. Create one above to crawl a documentation site into the RAG library.
      </div>

      <section v-for="kb in kbs" :key="kb.id" class="glass-card p-5 mb-4">
        <div class="knowledge-page__card-head">
          <div class="knowledge-page__card-title-row">
            <h3 class="knowledge-page__card-title">{{ kb.name }}</h3>
            <span class="knowledge-page__chip knowledge-page__chip--id" :title="`engram source: kb:${kb.id}`">{{ kb.id }}</span>
            <span class="knowledge-page__chip" :class="statusChipClass(kb.status)">{{ kb.status }}</span>
            <span class="knowledge-page__chip" :class="scopeChipClass(kb.scope)" :title="scopeTitle(kb)">{{ kb.scope }}</span>
            <span v-if="kb.hasWorker" class="knowledge-page__chip knowledge-page__chip--worker" title="Has a worker template — ask “use <id> to …” in chat to run it">worker</span>
            <span v-if="kb.ambientRetrieval" class="knowledge-page__chip knowledge-page__chip--ambient" title="Included in every turn's document context">ambient</span>
          </div>
          <div class="knowledge-page__card-actions">
            <button class="btn-ghost px-3 py-1 rounded-lg text-xs" @click="toggleDetail(kb)">
              {{ expandedId === kb.id ? "Hide details" : "Details" }}
            </button>
            <button
              v-if="kb.status !== 'crawling'"
              class="btn-ghost px-3 py-1 rounded-lg text-xs"
              :disabled="busyId === kb.id || !enabled || !ragConfigured"
              @click="recrawl(kb)"
            >{{ busyId === kb.id ? "…" : "Re-crawl" }}</button>
            <button
              v-else
              class="knowledge-page__btn-warn px-3 py-1 rounded-lg text-xs"
              :disabled="busyId === kb.id"
              @click="cancelCrawl(kb)"
            >{{ busyId === kb.id ? "…" : "Cancel crawl" }}</button>
            <button
              class="btn-ghost px-3 py-1 rounded-lg text-xs"
              :disabled="busyId === kb.id"
              :title="kb.ambientRetrieval ? 'Stop including this KB in every turn' : 'Include this KB in the document context of every turn'"
              @click="toggleAmbient(kb)"
            >{{ kb.ambientRetrieval ? "Ambient: on" : "Ambient: off" }}</button>
            <template v-if="confirmDeleteId === kb.id">
              <span class="knowledge-page__confirm">Delete corpus + index?</span>
              <button class="knowledge-page__btn-danger px-3 py-1 rounded-lg text-xs" :disabled="busyId === kb.id" @click="deleteKb(kb)">
                {{ busyId === kb.id ? "Deleting…" : "Confirm" }}
              </button>
              <button class="btn-ghost px-3 py-1 rounded-lg text-xs" @click="confirmDeleteId = null">Keep</button>
            </template>
            <button v-else class="knowledge-page__btn-danger px-3 py-1 rounded-lg text-xs" :disabled="busyId === kb.id" @click="confirmDeleteId = kb.id">
              Delete
            </button>
          </div>
        </div>

        <div v-if="kb.description" class="knowledge-page__desc">{{ kb.description }}</div>

        <div class="knowledge-page__meta">
          {{ kb.pageCount }} page{{ kb.pageCount === 1 ? "" : "s" }} · {{ kb.chunkCount }} chunk{{ kb.chunkCount === 1 ? "" : "s" }}
          · bounds {{ kb.maxPages }} pages / depth {{ kb.maxDepth }} · updated {{ formatDate(kb.updatedAt) }}
        </div>

        <ul class="knowledge-page__seeds">
          <li v-for="seed in kb.seedUrls" :key="seed" class="knowledge-page__seed">
            <a :href="seed" target="_blank" rel="noopener">{{ seed }}</a>
          </li>
        </ul>

        <div v-if="kb.lastCrawl" class="knowledge-page__crawl-summary">
          <span v-if="kb.status === 'crawling'">
            Crawling — {{ liveCrawlLine(kb.lastCrawl) }}
          </span>
          <span v-else>
            Last crawl {{ formatDate(kb.lastCrawl.startedAt) }} — {{ finishedCrawlLine(kb.lastCrawl) }}
            <span v-if="kb.lastCrawl.stopReason"> · stopped: {{ kb.lastCrawl.stopReason }}</span>
          </span>
        </div>
        <div v-if="kb.lastCrawl?.error" class="text-sm text-red-400 mt-1">{{ kb.lastCrawl.error }}</div>
        <div v-if="cardErrors[kb.id]" class="text-sm text-red-400 mt-1">{{ cardErrors[kb.id] }}</div>

        <!-- Detail expansion -->
        <div v-if="expandedId === kb.id" class="knowledge-page__detail">
          <div v-if="detailError" class="text-sm text-red-400">{{ detailError }}</div>
          <div v-else-if="!detail && detailLoading" class="text-sm text-gray-500">Loading details…</div>
          <template v-else-if="detail">
            <!-- Live crawl progress -->
            <div v-if="detail.crawling" class="knowledge-page__progress">
              <div class="knowledge-page__progress-grid">
                <div class="knowledge-page__stat"><span class="knowledge-page__stat-value">{{ detail.knowledgeBase.lastCrawl?.pagesVisited ?? 0 }}</span><span class="knowledge-page__stat-label">visited</span></div>
                <div class="knowledge-page__stat"><span class="knowledge-page__stat-value">{{ detail.knowledgeBase.lastCrawl?.pagesIngested ?? 0 }}</span><span class="knowledge-page__stat-label">ingested</span></div>
                <div class="knowledge-page__stat"><span class="knowledge-page__stat-value">{{ detail.knowledgeBase.lastCrawl?.pagesSkippedUnchanged ?? 0 }}</span><span class="knowledge-page__stat-label">unchanged</span></div>
                <div class="knowledge-page__stat"><span class="knowledge-page__stat-value">{{ detail.knowledgeBase.lastCrawl?.pagesFailed ?? 0 }}</span><span class="knowledge-page__stat-label">failed</span></div>
                <div class="knowledge-page__stat"><span class="knowledge-page__stat-value">{{ detail.knowledgeBase.lastCrawl?.queueRemaining ?? 0 }}</span><span class="knowledge-page__stat-label">queued</span></div>
              </div>
              <div v-if="detail.knowledgeBase.lastCrawl?.currentUrl" class="knowledge-page__current-url" :title="detail.knowledgeBase.lastCrawl.currentUrl">
                Fetching: {{ detail.knowledgeBase.lastCrawl.currentUrl }}
              </div>
            </div>

            <!-- Config recap -->
            <div class="knowledge-page__detail-config">
              <span>scope: {{ detail.knowledgeBase.scope }}</span>
              <span v-if="detail.knowledgeBase.ownerId">owner: {{ detail.knowledgeBase.ownerId }}</span>
              <span>same-origin: {{ detail.knowledgeBase.sameOriginOnly ? "yes" : "no" }}</span>
              <span>robots.txt: {{ detail.knowledgeBase.respectRobots ? "respected" : "ignored" }}</span>
              <span v-if="detail.knowledgeBase.createdBy">created by {{ detail.knowledgeBase.createdBy }}</span>
              <span v-if="detail.knowledgeBase.includePatterns.length" :title="detail.knowledgeBase.includePatterns.join('\n')">
                {{ detail.knowledgeBase.includePatterns.length }} include pattern{{ detail.knowledgeBase.includePatterns.length === 1 ? "" : "s" }}
              </span>
              <span v-if="detail.knowledgeBase.excludePatterns.length" :title="detail.knowledgeBase.excludePatterns.join('\n')">
                {{ detail.knowledgeBase.excludePatterns.length }} exclude pattern{{ detail.knowledgeBase.excludePatterns.length === 1 ? "" : "s" }}
              </span>
            </div>

            <!-- Worker template -->
            <div class="knowledge-page__worker-block">
              <div class="knowledge-page__worker-head">
                <span class="knowledge-page__label">Worker template</span>
                <span class="knowledge-page__hint">The single-use agent that uses this KB. Blank = a default worker (KB search + read-only web/site inspection).</span>
              </div>
              <label class="knowledge-page__field">
                <span class="knowledge-page__label">Instructions</span>
                <textarea v-model="editWorkerInstructions" rows="3" class="input-box knowledge-page__textarea" placeholder="How the worker should apply this KB to a task." />
              </label>
              <label class="knowledge-page__field">
                <span class="knowledge-page__label">Tools <span class="knowledge-page__hint">(one per line — KB search is always granted)</span></span>
                <textarea v-model="editWorkerToolsText" rows="2" class="input-box knowledge-page__textarea knowledge-page__textarea--mono" placeholder="web_fetch" />
              </label>
              <div class="knowledge-page__form-actions">
                <button class="btn-grad px-4 py-2 rounded-xl text-sm" :disabled="workerSaving" @click="saveWorker(detail.knowledgeBase)">
                  {{ workerSaving ? "Saving…" : "Save worker" }}
                </button>
                <button
                  class="btn-ghost px-3 py-2 rounded-xl text-sm"
                  :disabled="workerSaving || (!editWorkerInstructions.trim() && !editWorkerToolsText.trim() && !detail.knowledgeBase.hasWorker)"
                  @click="clearWorker(detail.knowledgeBase)"
                >Clear</button>
              </div>
              <div v-if="workerError" class="text-sm text-red-400">{{ workerError }}</div>
              <div v-else-if="workerNote" class="text-sm text-emerald-300">{{ workerNote }}</div>
              <div class="knowledge-page__worker-usage">
                To use this KB, ask in chat: <code>use {{ detail.knowledgeBase.id }} to …</code> — it runs this KB's worker.
              </div>
            </div>

            <!-- Pages list -->
            <template v-if="detail.pages.length > 0">
              <input
                v-model="pageFilter"
                type="search"
                class="input-box knowledge-page__page-filter"
                :placeholder="`Filter ${detail.pages.length} page${detail.pages.length === 1 ? '' : 's'} by URL or title`"
              />
              <div v-if="detail.pagesTruncated" class="knowledge-page__banner knowledge-page__banner--info">
                Showing the first {{ detail.pages.length }} pages — this knowledge base holds more.
              </div>
              <ul class="knowledge-page__pages">
                <li v-for="page in filteredPages" :key="page.url" class="knowledge-page__page-row">
                  <div class="knowledge-page__page-main">
                    <a :href="page.url" target="_blank" rel="noopener" class="knowledge-page__page-url">{{ page.url }}</a>
                    <div v-if="page.title" class="knowledge-page__page-title">{{ page.title }}</div>
                  </div>
                  <span class="knowledge-page__page-chunks">{{ page.chunkCount }} chunk{{ page.chunkCount === 1 ? "" : "s" }}</span>
                </li>
              </ul>
              <div v-if="filteredPages.length === 0" class="text-sm text-gray-500">No pages match the filter.</div>
            </template>
            <div v-else-if="!detail.crawling" class="text-sm text-gray-500">No pages ingested yet — run a crawl.</div>
          </template>
        </div>
      </section>

      <div v-if="loadError" class="text-sm text-red-400">{{ loadError }}</div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { useGatewayStore } from "@/stores/gateway";

const gateway = useGatewayStore();

// Current chat session — needed so session-scoped KBs are visible/manageable
// (the gateway derives the session access context from the ?sessionId= query).
const currentSessionId = computed(() => gateway.currentSessionId);

/** Append the current sessionId to a KB endpoint so session-scoped KBs resolve. */
function withSession(path: string): string {
  const sid = currentSessionId.value;
  if (!sid) return path;
  return `${path}${path.includes("?") ? "&" : "?"}sessionId=${encodeURIComponent(sid)}`;
}

// ── API shapes (mirror gateway/knowledge-base-routes.ts) ────────────────────
type KbStatus = "idle" | "crawling" | "ready" | "failed";
type KbScope = "session" | "user" | "workspace";

interface KbWorkerSpec {
  instructions?: string;
  tools?: string[];
  model?: { primary?: string; temperature?: number; maxTokens?: number };
  maxIterations?: number;
  timeoutMs?: number;
}

interface KbCrawlStats {
  startedAt: string;
  finishedAt?: string;
  pagesVisited: number;
  pagesIngested: number;
  pagesSkippedUnchanged: number;
  pagesFailed: number;
  pagesRemoved?: number;
  queueRemaining?: number;
  currentUrl?: string;
  stopReason?: string;
  error?: string;
}

interface KbSummary {
  id: string;
  name: string;
  description?: string;
  seedUrls: string[];
  status: KbStatus;
  ambientRetrieval: boolean;
  scope: KbScope;
  ownerId?: string;
  hasWorker: boolean;
  pageCount: number;
  chunkCount: number;
  maxPages: number;
  maxDepth: number;
  createdAt: string;
  updatedAt: string;
  lastCrawl?: KbCrawlStats;
}

interface KbDetailInfo extends KbSummary {
  includePatterns: string[];
  excludePatterns: string[];
  sameOriginOnly: boolean;
  respectRobots: boolean;
  createdBy: string | null;
  worker: KbWorkerSpec | null;
}

interface KbPage {
  url: string;
  title: string | null;
  chunkCount: number;
  lastIngestedAt: string;
}

interface KbDetail {
  knowledgeBase: KbDetailInfo;
  pages: KbPage[];
  pagesTruncated: boolean;
  crawling: boolean;
}

// ── List state ───────────────────────────────────────────────────────────────
const loading = ref(false);
const loadError = ref("");
const kbs = ref<KbSummary[]>([]);
const enabled = ref(true);
const ragConfigured = ref(true);

async function refreshList(quiet = false): Promise<void> {
  if (!quiet) {
    loading.value = true;
    loadError.value = "";
  }
  try {
    const res = await gateway.authorizedFetch(withSession("/api/knowledge-bases"));
    const data = await res.json() as { knowledgeBases: KbSummary[]; enabled: boolean; ragConfigured: boolean };
    kbs.value = Array.isArray(data.knowledgeBases) ? data.knowledgeBases : [];
    enabled.value = data.enabled !== false;
    ragConfigured.value = data.ragConfigured !== false;
  } catch (e) {
    if (!quiet) loadError.value = `Failed to load knowledge bases: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    if (!quiet) loading.value = false;
  }
}

async function reload(): Promise<void> {
  await refreshList();
  if (expandedId.value) await loadDetail(expandedId.value, true);
}

// ── Create form ──────────────────────────────────────────────────────────────
const showCreate = ref(false);
const showAdvanced = ref(false);
const creating = ref(false);
const createError = ref("");
const createNote = ref("");

function emptyForm() {
  return {
    name: "",
    id: "",
    description: "",
    scope: "workspace" as KbScope,
    seedUrlsText: "",
    maxPagesText: "",
    maxDepthText: "",
    includeText: "",
    excludeText: "",
    respectRobots: true,
    ambientRetrieval: false,
    workerInstructions: "",
    workerToolsText: "",
  };
}
const form = ref(emptyForm());

function linesToList(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

function parseIntOrNull(text: string | number, min: number): number | null {
  // <input type="number"> v-model coerces to a JS number, so this receives
  // either a string (blank) or a number — String() before trim covers both.
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? Math.max(min, Math.floor(n)) : null;
}

function resetCreate(): void {
  form.value = emptyForm();
  createError.value = "";
}

async function submitCreate(): Promise<void> {
  createError.value = "";
  createNote.value = "";
  const name = form.value.name.trim();
  const seedUrls = linesToList(form.value.seedUrlsText);
  if (!name) { createError.value = "Name is required."; return; }
  if (seedUrls.length === 0) { createError.value = "At least one seed URL is required."; return; }
  if (form.value.scope === "session" && !currentSessionId.value) {
    createError.value = "Open a chat first to create a session-scoped knowledge base.";
    return;
  }

  creating.value = true;
  try {
    const body: Record<string, unknown> = {
      name,
      seedUrls,
      scope: form.value.scope,
      respectRobots: form.value.respectRobots,
      ambientRetrieval: form.value.ambientRetrieval,
    };
    if (form.value.scope === "session" && currentSessionId.value) body["sessionId"] = currentSessionId.value;
    if (form.value.description.trim()) body["description"] = form.value.description.trim();
    const id = form.value.id.trim().toLowerCase();
    if (id) body["id"] = id;
    const maxPages = parseIntOrNull(form.value.maxPagesText, 1);
    if (maxPages !== null) body["maxPages"] = maxPages;
    const maxDepth = parseIntOrNull(form.value.maxDepthText, 0);
    if (maxDepth !== null) body["maxDepth"] = maxDepth;
    const include = linesToList(form.value.includeText);
    if (include.length > 0) body["includePatterns"] = include;
    const exclude = linesToList(form.value.excludeText);
    if (exclude.length > 0) body["excludePatterns"] = exclude;
    const workerInstructions = form.value.workerInstructions.trim();
    const workerTools = linesToList(form.value.workerToolsText);
    if (workerInstructions || workerTools.length > 0) {
      body["worker"] = {
        ...(workerInstructions ? { instructions: workerInstructions } : {}),
        ...(workerTools.length > 0 ? { tools: workerTools } : {}),
      };
    }

    const res = await gateway.authorizedFetch("/api/knowledge-bases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json() as { id: string; crawlStarted: boolean; crawlError?: string };
    createNote.value = data.crawlStarted
      ? `Created “${name}” — crawl started.`
      : `Created “${name}”${data.crawlError ? ` — crawl not started: ${data.crawlError}` : ""}.`;
    resetCreate();
    showCreate.value = false;
    await refreshList();
  } catch (e) {
    createError.value = e instanceof Error ? e.message : String(e);
  } finally {
    creating.value = false;
  }
}

// ── Per-KB actions ───────────────────────────────────────────────────────────
const busyId = ref<string | null>(null);
const confirmDeleteId = ref<string | null>(null);
const cardErrors = ref<Record<string, string>>({});

async function runAction(kb: KbSummary, action: () => Promise<void>): Promise<void> {
  busyId.value = kb.id;
  if (cardErrors.value[kb.id]) {
    const next = { ...cardErrors.value };
    delete next[kb.id];
    cardErrors.value = next;
  }
  try {
    await action();
    await refreshList(true);
    if (expandedId.value === kb.id) await loadDetail(kb.id, true);
  } catch (e) {
    cardErrors.value = { ...cardErrors.value, [kb.id]: e instanceof Error ? e.message : String(e) };
  } finally {
    busyId.value = null;
  }
}

function recrawl(kb: KbSummary): void {
  void runAction(kb, async () => {
    await gateway.authorizedFetch(withSession(`/api/knowledge-bases/${encodeURIComponent(kb.id)}/crawl`), { method: "POST" });
  });
}

function cancelCrawl(kb: KbSummary): void {
  void runAction(kb, async () => {
    await gateway.authorizedFetch(withSession(`/api/knowledge-bases/${encodeURIComponent(kb.id)}/cancel`), { method: "POST" });
  });
}

function toggleAmbient(kb: KbSummary): void {
  void runAction(kb, async () => {
    await gateway.authorizedFetch(withSession(`/api/knowledge-bases/${encodeURIComponent(kb.id)}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ambientRetrieval: !kb.ambientRetrieval }),
    });
  });
}

function deleteKb(kb: KbSummary): void {
  void runAction(kb, async () => {
    const res = await gateway.authorizedFetch(withSession(`/api/knowledge-bases/${encodeURIComponent(kb.id)}`), { method: "DELETE" });
    const data = await res.json() as { removed: boolean; documentsRemoved: number; documentsFailed: number };
    confirmDeleteId.value = null;
    if (expandedId.value === kb.id) {
      expandedId.value = null;
      detail.value = null;
    }
    createNote.value = `Deleted “${kb.name}” — ${data.documentsRemoved} document${data.documentsRemoved === 1 ? "" : "s"} removed from the index`
      + (data.documentsFailed > 0 ? ` (${data.documentsFailed} failed to delete)` : "") + ".";
  });
}

// ── Detail expansion ─────────────────────────────────────────────────────────
const expandedId = ref<string | null>(null);
const detail = ref<KbDetail | null>(null);
const detailLoading = ref(false);
const detailError = ref("");
const pageFilter = ref("");

// Worker template edit state. Seeded from the detail response the first time a
// KB's detail loads, then owned by the user — quiet polls (which fire during a
// live crawl) must not clobber an in-progress edit, so the draft is re-seeded
// only when workerInitializedFor changes (open a different KB, or after a save).
const editWorkerInstructions = ref("");
const editWorkerToolsText = ref("");
const workerInitializedFor = ref<string | null>(null);
const workerSaving = ref(false);
const workerError = ref("");
const workerNote = ref("");

function seedWorkerDraft(worker: KbWorkerSpec | null): void {
  editWorkerInstructions.value = worker?.instructions ?? "";
  editWorkerToolsText.value = (worker?.tools ?? []).join("\n");
}

async function loadDetail(id: string, quiet = false): Promise<void> {
  if (!quiet) {
    detailLoading.value = true;
    detailError.value = "";
  }
  try {
    const res = await gateway.authorizedFetch(withSession(`/api/knowledge-bases/${encodeURIComponent(id)}`));
    const data = await res.json() as KbDetail;
    if (expandedId.value === id) {
      detail.value = data;
      detailError.value = ""; // any successful fetch (incl. a quiet poll) clears a stale error
      if (workerInitializedFor.value !== id) {
        seedWorkerDraft(data.knowledgeBase.worker);
        workerInitializedFor.value = id;
      }
    }
  } catch (e) {
    if (!quiet && expandedId.value === id) detailError.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (!quiet) detailLoading.value = false;
  }
}

function toggleDetail(kb: KbSummary): void {
  if (expandedId.value === kb.id) {
    expandedId.value = null;
    detail.value = null;
    detailError.value = "";
    workerInitializedFor.value = null;
    return;
  }
  expandedId.value = kb.id;
  detail.value = null;
  pageFilter.value = "";
  workerInitializedFor.value = null;
  workerError.value = "";
  workerNote.value = "";
  void loadDetail(kb.id);
}

async function saveWorker(kb: KbSummary): Promise<void> {
  workerSaving.value = true;
  workerError.value = "";
  workerNote.value = "";
  try {
    const instructions = editWorkerInstructions.value.trim();
    const tools = linesToList(editWorkerToolsText.value);
    // Empty → send worker:null so the backend clears the template.
    const worker: KbWorkerSpec | null = instructions || tools.length > 0
      ? { ...(instructions ? { instructions } : {}), ...(tools.length > 0 ? { tools } : {}) }
      : null;
    await gateway.authorizedFetch(withSession(`/api/knowledge-bases/${encodeURIComponent(kb.id)}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worker }),
    });
    workerNote.value = worker ? "Worker template saved." : "Worker template cleared.";
    workerInitializedFor.value = null; // re-seed the draft from the persisted value
    await refreshList(true);
    if (expandedId.value === kb.id) await loadDetail(kb.id, true);
  } catch (e) {
    workerError.value = e instanceof Error ? e.message : String(e);
  } finally {
    workerSaving.value = false;
  }
}

function clearWorker(kb: KbSummary): void {
  editWorkerInstructions.value = "";
  editWorkerToolsText.value = "";
  void saveWorker(kb);
}

const filteredPages = computed<KbPage[]>(() => {
  const pages = detail.value?.pages ?? [];
  const needle = pageFilter.value.trim().toLowerCase();
  if (!needle) return pages;
  return pages.filter((p) => p.url.toLowerCase().includes(needle) || (p.title ?? "").toLowerCase().includes(needle));
});

// ── Polling: 2s while a crawl is live (list + open detail), stopped otherwise ─
const POLL_INTERVAL_MS = 2_000;
let pollTimer: ReturnType<typeof setInterval> | null = null;

const anyCrawling = computed(() => kbs.value.some((kb) => kb.status === "crawling"));
const shouldPoll = computed(() =>
  gateway.connected && (anyCrawling.value || (expandedId.value !== null && detail.value?.crawling === true)),
);

function startPolling(): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (!gateway.connected) return;
    void refreshList(true);
    if (expandedId.value) void loadDetail(expandedId.value, true);
  }, POLL_INTERVAL_MS);
}

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

watch(shouldPoll, (active) => {
  if (active) startPolling();
  else stopPolling();
}, { immediate: true });

onBeforeUnmount(stopPolling);

// ── Formatting helpers ───────────────────────────────────────────────────────
function statusChipClass(status: KbStatus): string {
  switch (status) {
    case "crawling": return "knowledge-page__chip--crawling animate-pulse";
    case "ready": return "knowledge-page__chip--ready";
    case "failed": return "knowledge-page__chip--failed";
    default: return "knowledge-page__chip--idle";
  }
}

function scopeChipClass(scope: KbScope): string {
  switch (scope) {
    case "user": return "knowledge-page__chip--scope-user";
    case "session": return "knowledge-page__chip--scope-session";
    default: return "knowledge-page__chip--scope-workspace";
  }
}

function scopeTitle(kb: KbSummary): string {
  switch (kb.scope) {
    case "user": return kb.ownerId ? `Personal knowledge base of ${kb.ownerId}` : "Personal knowledge base";
    case "session": return "Only the conversation that created it can see this knowledge base";
    default: return "Shared with everyone on this instance";
  }
}

function liveCrawlLine(c: KbCrawlStats): string {
  const parts = [
    `${c.pagesVisited} visited`,
    `${c.pagesIngested} ingested`,
    `${c.pagesSkippedUnchanged} unchanged`,
    `${c.pagesFailed} failed`,
  ];
  if (typeof c.queueRemaining === "number") parts.push(`${c.queueRemaining} queued`);
  return parts.join(" · ");
}

function finishedCrawlLine(c: KbCrawlStats): string {
  const parts = [
    `${c.pagesIngested} ingested`,
    `${c.pagesSkippedUnchanged} unchanged`,
    `${c.pagesFailed} failed`,
  ];
  if (typeof c.pagesRemoved === "number" && c.pagesRemoved > 0) parts.push(`${c.pagesRemoved} removed`);
  return parts.join(" · ");
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

onMounted(() => {
  if (gateway.connected) void refreshList();
});
watch(() => gateway.connected, (connected) => {
  if (connected) void refreshList();
});
</script>

<style scoped>
.knowledge-page { padding: 1.25rem 1.5rem 2rem; max-width: 980px; margin: 0 auto; }
.knowledge-page__header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 1.25rem; }
.knowledge-page__title { font-size: 1.5rem; font-weight: 700; }
.knowledge-page__subtitle { font-size: 0.85rem; color: var(--muted, #9aa4b2); max-width: 70ch; margin-top: 0.25rem; }
.knowledge-page__subtitle code { font-family: var(--font-mono, monospace); font-size: 0.9em; }

.knowledge-page__banner { border-radius: 0.75rem; padding: 0.6rem 0.9rem; font-size: 0.8rem; margin-bottom: 1rem; }
.knowledge-page__banner--warn { border: 1px solid rgba(245, 158, 11, 0.4); background: rgba(245, 158, 11, 0.08); color: #fcd9a8; }
.knowledge-page__banner--info { border: 1px solid rgba(56, 189, 248, 0.32); background: rgba(56, 189, 248, 0.08); color: #bae6fd; margin-bottom: 0.6rem; }
.knowledge-page__banner code { font-family: var(--font-mono, monospace); font-size: 0.9em; }

/* ── Create form ───────────────────────────────────────────────────────── */
.knowledge-page__form { margin-top: 1rem; display: flex; flex-direction: column; gap: 0.75rem; }
.knowledge-page__form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.75rem; }
.knowledge-page__field { display: flex; flex-direction: column; gap: 0.3rem; }
.knowledge-page__label { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted, #9aa4b2); }
.knowledge-page__hint { text-transform: none; letter-spacing: 0; opacity: 0.75; }
.knowledge-page__textarea { resize: vertical; min-height: 4.5rem; font: inherit; font-size: 0.85rem; }
.knowledge-page__textarea--mono { font-family: var(--font-mono, monospace); font-size: 0.78rem; }
.knowledge-page__advanced-toggle {
  appearance: none; background: transparent; border: none; cursor: pointer; text-align: left;
  font-size: 0.78rem; color: var(--muted, #9aa4b2); padding: 0.1rem 0;
}
.knowledge-page__advanced-toggle:hover { color: rgb(229 231 235); }
.knowledge-page__advanced { display: flex; flex-direction: column; gap: 0.75rem; padding: 0.75rem; border: 1px solid rgba(255,255,255,0.08); border-radius: 0.75rem; }
.knowledge-page__toggles { display: flex; gap: 1.25rem; flex-wrap: wrap; }
.knowledge-page__check { display: flex; align-items: center; gap: 0.45rem; font-size: 0.82rem; color: rgb(209 213 219); cursor: pointer; }
.knowledge-page__form-actions { display: flex; gap: 0.6rem; align-items: center; }
.knowledge-page__scope-select { max-width: 20rem; }
.knowledge-page__worker-block { display: flex; flex-direction: column; gap: 0.6rem; padding: 0.75rem; border: 1px solid rgba(255,255,255,0.08); border-radius: 0.75rem; }
.knowledge-page__worker-head { display: flex; flex-direction: column; gap: 0.15rem; }
.knowledge-page__worker-head code { font-family: var(--font-mono, monospace); font-size: 0.9em; }
.knowledge-page__worker-usage { font-size: 0.75rem; color: var(--muted, #9aa4b2); }
.knowledge-page__worker-usage code { font-family: var(--font-mono, monospace); font-size: 0.9em; color: rgb(209 213 219); }

/* ── KB cards ──────────────────────────────────────────────────────────── */
.knowledge-page__card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap; }
.knowledge-page__card-title-row { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; min-width: 0; }
.knowledge-page__card-title { font-size: 1.05rem; font-weight: 700; margin: 0; }
.knowledge-page__card-actions { display: flex; gap: 0.4rem; align-items: center; flex-wrap: wrap; }

.knowledge-page__chip {
  font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 700;
  border: 1px solid; border-radius: 999px; padding: 0.08rem 0.55rem; white-space: nowrap;
}
.knowledge-page__chip--id { text-transform: none; font-weight: 500; font-family: var(--font-mono, monospace); border-color: rgba(148, 163, 184, 0.3); color: var(--muted, #9aa4b2); background: rgba(148, 163, 184, 0.08); }
.knowledge-page__chip--idle { border-color: rgba(148, 163, 184, 0.4); color: rgb(203 213 225); background: rgba(148, 163, 184, 0.1); }
.knowledge-page__chip--crawling { border-color: rgba(34, 211, 238, 0.5); color: rgb(165 243 252); background: rgba(34, 211, 238, 0.1); }
.knowledge-page__chip--ready { border-color: rgba(52, 211, 153, 0.4); color: rgb(167 243 208); background: rgba(52, 211, 153, 0.1); }
.knowledge-page__chip--failed { border-color: rgba(248, 113, 113, 0.4); color: rgb(254 202 202); background: rgba(248, 113, 113, 0.1); }
.knowledge-page__chip--ambient { border-color: rgba(var(--accent-purple, 168, 85, 247), 0.45); color: rgb(233 213 255); background: rgba(var(--accent-purple, 168, 85, 247), 0.12); }
.knowledge-page__chip--worker { border-color: rgba(129, 140, 248, 0.45); color: rgb(199 210 254); background: rgba(129, 140, 248, 0.12); }
.knowledge-page__chip--scope-workspace { border-color: rgba(148, 163, 184, 0.4); color: rgb(203 213 225); background: rgba(148, 163, 184, 0.1); }
.knowledge-page__chip--scope-user { border-color: rgba(56, 189, 248, 0.4); color: rgb(186 230 253); background: rgba(56, 189, 248, 0.1); }
.knowledge-page__chip--scope-session { border-color: rgba(251, 191, 36, 0.4); color: rgb(253 230 138); background: rgba(251, 191, 36, 0.1); }

.knowledge-page__desc { font-size: 0.85rem; color: rgb(209 213 219); margin-top: 0.5rem; }
.knowledge-page__meta { font-size: 0.75rem; color: var(--muted, #9aa4b2); margin-top: 0.4rem; }
.knowledge-page__seeds { display: flex; flex-direction: column; gap: 0.1rem; margin-top: 0.4rem; }
.knowledge-page__seed { font-size: 0.75rem; font-family: var(--font-mono, monospace); overflow-wrap: anywhere; }
.knowledge-page__seed a { color: var(--muted, #9aa4b2); text-decoration: none; }
.knowledge-page__seed a:hover { color: rgb(229 231 235); text-decoration: underline; }
.knowledge-page__crawl-summary { font-size: 0.78rem; color: var(--muted, #9aa4b2); margin-top: 0.5rem; }

.knowledge-page__btn-warn { border: 1px solid rgba(245, 158, 11, 0.4); color: #fcd9a8; background: rgba(245, 158, 11, 0.08); transition: background 0.15s; }
.knowledge-page__btn-warn:hover:not(:disabled) { background: rgba(245, 158, 11, 0.18); }
.knowledge-page__btn-warn:disabled { opacity: 0.5; cursor: not-allowed; }
.knowledge-page__btn-danger { border: 1px solid rgba(248, 113, 113, 0.4); color: #fca5a5; background: rgba(248, 113, 113, 0.08); transition: background 0.15s; }
.knowledge-page__btn-danger:hover:not(:disabled) { background: rgba(248, 113, 113, 0.18); }
.knowledge-page__btn-danger:disabled { opacity: 0.5; cursor: not-allowed; }
.knowledge-page__confirm { font-size: 0.76rem; color: #fca5a5; }

/* ── Detail expansion ──────────────────────────────────────────────────── */
.knowledge-page__detail { margin-top: 0.9rem; padding-top: 0.9rem; border-top: 1px solid rgba(255,255,255,0.08); display: flex; flex-direction: column; gap: 0.65rem; }
.knowledge-page__progress { border: 1px solid rgba(34, 211, 238, 0.25); background: rgba(34, 211, 238, 0.05); border-radius: 0.75rem; padding: 0.7rem 0.9rem; }
.knowledge-page__progress-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(5.5rem, 1fr)); gap: 0.5rem; }
.knowledge-page__stat { display: flex; flex-direction: column; align-items: center; gap: 0.1rem; }
.knowledge-page__stat-value { font-size: 1.05rem; font-weight: 700; font-variant-numeric: tabular-nums; }
.knowledge-page__stat-label { font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted, #9aa4b2); }
.knowledge-page__current-url { font-size: 0.72rem; font-family: var(--font-mono, monospace); color: var(--muted, #9aa4b2); margin-top: 0.5rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.knowledge-page__detail-config { display: flex; gap: 0.9rem; flex-wrap: wrap; font-size: 0.75rem; color: var(--muted, #9aa4b2); }
.knowledge-page__page-filter { max-width: 26rem; }
.knowledge-page__pages { display: flex; flex-direction: column; gap: 0.35rem; max-height: 24rem; overflow-y: auto; }
.knowledge-page__page-row { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; padding: 0.4rem 0.6rem; border: 1px solid rgba(255,255,255,0.06); border-radius: 0.6rem; background: rgba(255,255,255,0.02); }
.knowledge-page__page-main { min-width: 0; }
.knowledge-page__page-url { font-size: 0.75rem; font-family: var(--font-mono, monospace); color: rgb(209 213 219); text-decoration: none; overflow-wrap: anywhere; }
.knowledge-page__page-url:hover { text-decoration: underline; }
.knowledge-page__page-title { font-size: 0.72rem; color: var(--muted, #9aa4b2); margin-top: 0.1rem; }
.knowledge-page__page-chunks { font-size: 0.7rem; color: var(--muted, #9aa4b2); white-space: nowrap; }

.section-title {
  font-weight: 600; color: rgb(243 244 246); font-size: 0.875rem; text-transform: uppercase; letter-spacing: 0.025em;
  font-family: var(--font-label);
  background: linear-gradient(to right, rgb(var(--accent-purple)), rgb(var(--accent-pink)));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}
.empty-state { color: var(--muted, #9aa4b2); font-size: 0.9rem; padding: 2rem; text-align: center; }

@media (max-width: 720px) {
  .knowledge-page__form-grid { grid-template-columns: 1fr; }
  .knowledge-page__card-head { flex-direction: column; }
}
</style>
