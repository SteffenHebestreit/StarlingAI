<template>
  <div class="skills-page" :style="{ height: 'calc(100vh - 56px)' }">
    <header class="skills-page__header">
      <div>
        <h1 class="skills-page__title">Skill Library</h1>
        <p class="skills-page__subtitle">
          Reusable procedures the swarm authored from successful work. Drafts graduate to
          <strong>active</strong> after they succeed in real use; consistently reliable skills are promoted to
          workflow scenes. Configure authoring on the Settings → Agents page.
        </p>
      </div>
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
        <code>skillLibrary.autoAuthor</code> is on), or an agent can author one explicitly with
        <code>record_skill</code>.
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
  background: rgba(8, 10, 18, 0.92);
  color: rgb(229 231 235);
  overflow: hidden;
}

.skills-page__header {
  padding: 1.25rem 1.5rem 0.75rem;
  border-bottom: 1px solid rgba(168, 85, 247, 0.18);
}

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
</style>
