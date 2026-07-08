<template>
  <div class="skills-page" style="height: 100%">
    <header class="skills-page__header">
      <div>
        <h1 class="skills-page__title">Skill Library</h1>
        <p class="skills-page__subtitle">
          Reusable procedures. The swarm authors them automatically from successful work (drafts graduate to
          <strong>active</strong> once they succeed in real use; reliable ones are promoted to workflow scenes) —
          or write one by hand with <strong>New skill</strong>. Configure auto-authoring on the Settings → Agents page.
        </p>
      </div>
      <button class="skills-page__new" @click="openCreate()">+ New skill</button>
    </header>

    <section class="skills-page__panel">
      <div class="skills-controls">
        <div class="skills-controls__group">
          <label class="skills-controls__label">Status</label>
          <select v-model="statusFilter" @change="loadSkills()" class="skills-controls__select">
            <option value="">Active &amp; draft</option>
            <option value="active">Active</option>
            <option value="draft">Draft</option>
            <option value="archived">Archived</option>
          </select>
        </div>
        <div class="skills-controls__group skills-controls__group--grow">
          <label class="skills-controls__label">Search</label>
          <input
            v-model="query"
            type="search"
            class="skills-controls__input"
            placeholder="Filter by name, description, when-to-use, or tag"
            @input="onQueryChange"
          />
        </div>
        <button class="skills-controls__refresh" @click="loadSkills()" :disabled="loading">
          {{ loading ? "Loading…" : "Refresh" }}
        </button>
      </div>

      <div v-if="error" class="skills-page__notice skills-page__notice--error">{{ error }}</div>
      <div v-else-if="skills.length === 0 && !loading" class="skills-page__notice">
        No skills yet. The swarm authors them automatically after successful multi-step turns (when
        <code>skillLibrary.autoAuthor</code> is on), an agent can author one with <code>record_skill</code>,
        or you can write one now with <strong>+ New skill</strong>.
      </div>

      <div class="skills-list">
        <article v-for="skill in skills" :key="skill.slug" class="skill-card">
          <header class="skill-card__header">
            <span :class="['skill-card__status', `skill-card__status--${skill.status}`]">{{ skill.status }}</span>
            <span class="skill-card__version">v{{ skill.version }}</span>
            <span class="skill-card__origin">{{ skill.origin }}</span>
            <span
              class="skill-card__rate"
              :title="`${skill.successes} ok / ${skill.failures} fail`"
            >{{ skill.uses > 0 ? Math.round(skill.successRate * 100) + '% over ' + skill.uses : 'untested' }}</span>
            <span class="skill-card__date">{{ formatDate(skill.updatedAt) }}</span>
          </header>
          <h3 class="skill-card__name">{{ skill.name }}</h3>
          <p class="skill-card__when"><span class="skill-card__when-label">When:</span> {{ skill.whenToUse }}</p>
          <p class="skill-card__desc">{{ skill.description }}</p>
          <div v-if="skill.agents.length || skill.tools.length" class="skill-card__meta">
            <span v-for="a in skill.agents" :key="'a-' + a" class="skill-card__chip skill-card__chip--agent">{{ a }}</span>
            <span v-for="t in skill.tools" :key="'t-' + t" class="skill-card__chip skill-card__chip--tool">{{ t }}</span>
          </div>
          <details class="skill-card__body">
            <summary>Procedure</summary>
            <pre>{{ skill.body }}</pre>
          </details>
          <footer class="skill-card__actions">
            <button class="skill-card__btn" @click="openEdit(skill)">Edit</button>
            <button
              v-if="skill.status !== 'archived'"
              class="skill-card__btn"
              @click="archiveSkill(skill.slug)"
            >Archive</button>
            <button class="skill-card__btn skill-card__btn--danger" @click="deleteSkill(skill.slug)">Delete</button>
          </footer>
        </article>
      </div>
    </section>

    <!-- Create / edit modal -->
    <div v-if="showModal" class="skill-modal__scrim" @click.self="closeModal()">
      <div class="skill-modal" role="dialog" aria-modal="true">
        <h2 class="skill-modal__title">{{ editingSlug ? "Edit skill" : "New skill" }}</h2>
        <div v-if="modalError" class="skills-page__notice skills-page__notice--error">{{ modalError }}</div>
        <div class="skill-modal__grid">
          <label class="skill-modal__field">
            <span>Name</span>
            <input v-model="form.name" type="text" placeholder="Build a reveal.js deck from research" />
          </label>
          <label class="skill-modal__field">
            <span>Status</span>
            <select v-model="form.status">
              <option value="active">Active (usable now)</option>
              <option value="draft">Draft</option>
            </select>
          </label>
          <label class="skill-modal__field skill-modal__field--full">
            <span>When to use <em>— the trigger condition</em></span>
            <input v-model="form.whenToUse" type="text" placeholder="When the user asks for a slide deck backed by sources" />
          </label>
          <label class="skill-modal__field skill-modal__field--full">
            <span>Description <em>— one-line summary</em></span>
            <input v-model="form.description" type="text" placeholder="What this procedure accomplishes" />
          </label>
          <label class="skill-modal__field skill-modal__field--full">
            <span>Procedure <em>— Markdown: the steps &amp; pitfalls</em></span>
            <textarea v-model="form.procedure" rows="10" placeholder="1. …&#10;2. …"></textarea>
          </label>
          <label class="skill-modal__field">
            <span>Tags <em>— comma-separated</em></span>
            <input v-model="form.tags" type="text" placeholder="presentation, research" />
          </label>
          <label class="skill-modal__field">
            <span>Agents <em>— comma-separated, advisory</em></span>
            <input v-model="form.agents" type="text" placeholder="researcher, content_writer" />
          </label>
          <label class="skill-modal__field skill-modal__field--full">
            <span>Tools <em>— comma-separated, advisory</em></span>
            <input v-model="form.tools" type="text" placeholder="web_search, generate_document" />
          </label>
        </div>
        <p class="skill-modal__hint">
          Guidance only — a skill never runs code or grants tools; the agents/tools you list are advisory hints for retrieval.
        </p>
        <div class="skill-modal__actions">
          <button class="skill-card__btn" @click="closeModal()" :disabled="saving">Cancel</button>
          <button class="skills-controls__refresh" @click="saveSkill()" :disabled="saving">
            {{ saving ? "Saving…" : (editingSlug ? "Save changes" : "Create skill") }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useGatewayStore } from "@/stores/gateway";

interface SkillRecord {
  slug: string;
  name: string;
  description: string;
  whenToUse: string;
  version: number;
  status: "draft" | "active" | "archived";
  tags: string[];
  agents: string[];
  tools: string[];
  origin: string;
  uses: number;
  successes: number;
  failures: number;
  successRate: number;
  updatedAt: string;
  lastUsedAt?: string;
  body: string;
}

const gateway = useGatewayStore();

const skills = ref<SkillRecord[]>([]);
const statusFilter = ref<string>("");
const query = ref<string>("");
const loading = ref(false);
const error = ref<string | null>(null);
let queryTimer: ReturnType<typeof setTimeout> | null = null;

interface SkillForm {
  name: string;
  whenToUse: string;
  description: string;
  procedure: string;
  tags: string;
  agents: string;
  tools: string;
  status: "draft" | "active";
}
const emptyForm = (): SkillForm => ({ name: "", whenToUse: "", description: "", procedure: "", tags: "", agents: "", tools: "", status: "active" });
const showModal = ref(false);
const editingSlug = ref<string | null>(null);
const saving = ref(false);
const modalError = ref<string | null>(null);
const form = ref<SkillForm>(emptyForm());

function apiBase(): string {
  return gateway.wsUrl.replace(/^ws/, "http").replace(/\/ws$/, "");
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${gateway.token}` };
}

async function loadSkills(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const params = new URLSearchParams({ includeArchived: "true" });
    if (statusFilter.value) params.set("status", statusFilter.value);
    if (query.value.trim()) params.set("query", query.value.trim());
    const res = await fetch(`${apiBase()}/api/skills?${params}`, { headers: authHeaders() });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json() as { records: SkillRecord[] };
    skills.value = data.records ?? [];
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

async function archiveSkill(slug: string): Promise<void> {
  try {
    const res = await fetch(`${apiBase()}/api/skills/${encodeURIComponent(slug)}/archive`, {
      method: "POST",
      headers: authHeaders(),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await loadSkills();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function deleteSkill(slug: string): Promise<void> {
  if (!window.confirm(`Delete skill "${slug}"? This cannot be undone.`)) return;
  try {
    const res = await fetch(`${apiBase()}/api/skills/${encodeURIComponent(slug)}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await loadSkills();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

function onQueryChange(): void {
  if (queryTimer) clearTimeout(queryTimer);
  queryTimer = setTimeout(() => { void loadSkills(); }, 250);
}

function splitList(v: string): string[] {
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

function openCreate(): void {
  editingSlug.value = null;
  modalError.value = null;
  form.value = emptyForm();
  showModal.value = true;
}

function openEdit(skill: SkillRecord): void {
  editingSlug.value = skill.slug;
  modalError.value = null;
  form.value = {
    name: skill.name,
    whenToUse: skill.whenToUse ?? "",
    description: skill.description,
    procedure: skill.body ?? "",
    tags: (skill.tags ?? []).join(", "),
    agents: (skill.agents ?? []).join(", "),
    tools: (skill.tools ?? []).join(", "),
    status: skill.status === "draft" ? "draft" : "active",
  };
  showModal.value = true;
}

function closeModal(): void {
  showModal.value = false;
}

async function saveSkill(): Promise<void> {
  const f = form.value;
  if (!f.name.trim() || !f.description.trim() || !f.procedure.trim()) {
    modalError.value = "Name, description, and procedure are required.";
    return;
  }
  saving.value = true;
  modalError.value = null;
  try {
    const payload = {
      name: f.name.trim(),
      description: f.description.trim(),
      whenToUse: f.whenToUse.trim(),
      procedure: f.procedure,
      tags: splitList(f.tags),
      agents: splitList(f.agents),
      tools: splitList(f.tools),
      status: f.status,
    };
    const url = editingSlug.value
      ? `${apiBase()}/api/skills/${encodeURIComponent(editingSlug.value)}`
      : `${apiBase()}/api/skills`;
    const res = await fetch(url, {
      method: editingSlug.value ? "PUT" : "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    showModal.value = false;
    await loadSkills();
  } catch (err) {
    modalError.value = err instanceof Error ? err.message : String(err);
  } finally {
    saving.value = false;
  }
}

function formatDate(iso: string): string {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

onMounted(() => { void loadSkills(); });
</script>

<style scoped>
.skills-page {
  display: flex;
  flex-direction: column;
  /* Near-transparent scrim — the themed app canvas glows through. */
  background: rgba(8, 10, 18, 0.30);
  color: rgb(229 231 235);
  overflow: hidden;
}

.skills-page__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  padding: 1.25rem 1.5rem 0.75rem;
  border-bottom: 1px solid rgba(168, 85, 247, 0.18);
}

.skills-page__new {
  flex: 0 0 auto;
  appearance: none;
  background: rgba(168, 85, 247, 0.22);
  color: rgb(243 232 255);
  border: 1px solid rgba(168, 85, 247, 0.45);
  border-radius: 999px;
  padding: 0.4rem 1rem;
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}
.skills-page__new:hover { background: rgba(168, 85, 247, 0.32); }

.skills-page__title {
  font-size: 1.4rem;
  font-weight: 700;
  letter-spacing: -0.01em;
  margin: 0 0 0.25rem;
}

.skills-page__subtitle {
  margin: 0;
  font-size: 0.85rem;
  color: rgb(156 163 175);
  max-width: 56rem;
}

.skills-page__subtitle code {
  font-family: 'SFMono-Regular', Consolas, monospace;
  background: rgba(168, 85, 247, 0.18);
  color: rgb(216 180 254);
  padding: 0.05rem 0.3rem;
  border-radius: 4px;
  font-size: 0.78em;
}

.skills-page__panel {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 1rem 1.5rem 1.5rem;
  overflow: hidden;
}

.skills-page__notice {
  padding: 0.75rem 1rem;
  border-radius: 0.75rem;
  border: 1px solid rgba(156, 163, 175, 0.25);
  background: rgba(31, 41, 55, 0.45);
  color: rgb(209 213 219);
  font-size: 0.85rem;
  margin-bottom: 0.75rem;
}

.skills-page__notice--error {
  border-color: rgba(248, 113, 113, 0.45);
  background: rgba(127, 29, 29, 0.25);
  color: rgb(254 202 202);
}

.skills-controls {
  display: flex;
  align-items: center;
  gap: 0.85rem;
  flex-wrap: wrap;
  margin-bottom: 0.75rem;
}

.skills-controls__group { display: flex; align-items: center; gap: 0.4rem; }
.skills-controls__group--grow { flex: 1 1 auto; min-width: 14rem; }

.skills-controls__label {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: rgb(156 163 175);
}

.skills-controls__select,
.skills-controls__input {
  appearance: none;
  background: rgba(31, 41, 55, 0.6);
  color: rgb(229 231 235);
  border: 1px solid rgba(168, 85, 247, 0.25);
  border-radius: 0.55rem;
  padding: 0.35rem 0.7rem;
  font-size: 0.85rem;
}

.skills-controls__input { flex: 1 1 auto; }

.skills-controls__refresh {
  appearance: none;
  background: rgba(168, 85, 247, 0.22);
  color: rgb(243 232 255);
  border: 1px solid rgba(168, 85, 247, 0.45);
  border-radius: 999px;
  padding: 0.35rem 0.95rem;
  font-size: 0.82rem;
  cursor: pointer;
}

.skills-controls__refresh:disabled { opacity: 0.55; cursor: not-allowed; }

.skills-list {
  flex: 1 1 auto;
  overflow-y: auto;
  display: grid;
  gap: 0.65rem;
}

.skill-card {
  border: 1px solid rgba(168, 85, 247, 0.18);
  background: rgba(15, 23, 42, 0.55);
  border-radius: 0.85rem;
  padding: 0.7rem 0.95rem 0.85rem;
}

.skill-card__header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  font-size: 0.7rem;
  letter-spacing: 0.04em;
  color: rgb(156 163 175);
  margin-bottom: 0.35rem;
}

.skill-card__status {
  text-transform: uppercase;
  font-weight: 700;
  border-radius: 999px;
  padding: 0.05rem 0.5rem;
}
.skill-card__status--active { background: rgba(34, 197, 94, 0.18); color: rgb(134 239 172); }
.skill-card__status--draft { background: rgba(250, 204, 21, 0.16); color: rgb(253 224 71); }
.skill-card__status--archived { background: rgba(75, 85, 99, 0.45); color: rgb(209 213 219); }

.skill-card__origin { font-family: 'SFMono-Regular', Consolas, monospace; }
.skill-card__rate { color: rgb(216 180 254); font-weight: 600; }
.skill-card__date { margin-left: auto; }

.skill-card__name {
  margin: 0 0 0.2rem;
  font-size: 0.95rem;
  color: rgb(243 232 255);
}

.skill-card__when {
  margin: 0 0 0.3rem;
  font-size: 0.82rem;
  color: rgb(186 230 253);
}
.skill-card__when-label { color: rgb(125 211 252); font-weight: 600; }

.skill-card__desc {
  margin: 0;
  font-size: 0.85rem;
  color: rgb(229 231 235);
}

.skill-card__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  margin-top: 0.45rem;
}

.skill-card__chip {
  font-size: 0.7rem;
  border-radius: 999px;
  padding: 0.05rem 0.5rem;
  border: 1px solid transparent;
}
.skill-card__chip--agent { background: rgba(168, 85, 247, 0.15); color: rgb(216 180 254); border-color: rgba(168, 85, 247, 0.32); }
.skill-card__chip--tool { background: rgba(56, 189, 248, 0.12); color: rgb(186 230 253); border-color: rgba(56, 189, 248, 0.28); }

.skill-card__body {
  margin-top: 0.5rem;
  font-size: 0.8rem;
}
.skill-card__body summary {
  cursor: pointer;
  color: rgb(196 181 253);
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.skill-card__body pre {
  margin: 0.4rem 0 0;
  white-space: pre-wrap;
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 0.78rem;
  color: rgb(209 213 219);
  background: rgba(8, 10, 18, 0.6);
  border-radius: 0.5rem;
  padding: 0.5rem 0.65rem;
}

.skill-card__actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.55rem;
}

.skill-card__btn {
  appearance: none;
  background: rgba(31, 41, 55, 0.6);
  color: rgb(209 213 219);
  border: 1px solid rgba(168, 85, 247, 0.25);
  border-radius: 0.5rem;
  padding: 0.25rem 0.7rem;
  font-size: 0.78rem;
  cursor: pointer;
}
.skill-card__btn:hover { background: rgba(168, 85, 247, 0.15); }
.skill-card__btn--danger { border-color: rgba(248, 113, 113, 0.4); color: rgb(254 202 202); }
.skill-card__btn--danger:hover { background: rgba(127, 29, 29, 0.3); }

/* Create / edit modal */
.skill-modal__scrim {
  position: fixed;
  inset: 0;
  z-index: 50;
  background: rgba(2, 4, 10, 0.62);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.5rem;
}

.skill-modal {
  width: min(48rem, 100%);
  max-height: 88vh;
  overflow-y: auto;
  background: rgba(15, 18, 30, 0.98);
  border: 1px solid rgba(168, 85, 247, 0.3);
  border-radius: 1rem;
  padding: 1.25rem 1.4rem 1.4rem;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
}

.skill-modal__title { margin: 0 0 0.75rem; font-size: 1.15rem; color: rgb(243 232 255); }

.skill-modal__grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.7rem 0.9rem;
}

.skill-modal__field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.8rem;
  color: rgb(203 213 225);
}
.skill-modal__field--full { grid-column: 1 / -1; }
.skill-modal__field em { color: rgb(148 163 184); font-style: normal; font-size: 0.92em; }

.skill-modal__field input,
.skill-modal__field select,
.skill-modal__field textarea {
  appearance: none;
  background: rgba(31, 41, 55, 0.6);
  color: rgb(229 231 235);
  border: 1px solid rgba(168, 85, 247, 0.25);
  border-radius: 0.55rem;
  padding: 0.4rem 0.7rem;
  font-size: 0.85rem;
  font-family: inherit;
}
.skill-modal__field textarea {
  resize: vertical;
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 0.8rem;
  line-height: 1.5;
}

.skill-modal__hint { margin: 0.7rem 0 0; font-size: 0.76rem; color: rgb(148 163 184); }

.skill-modal__actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.6rem;
  margin-top: 1rem;
}

@media (max-width: 640px) {
  .skill-modal__grid { grid-template-columns: 1fr; }
}
</style>
