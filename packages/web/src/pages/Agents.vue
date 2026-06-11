<template>
  <div class="agents-page" style="height: 100%">
    <header class="agents-page__header">
      <div>
        <p class="eyebrow agents-page__eyebrow">Capability Directory</p>
        <h1 class="agents-page__title">Agent Catalog</h1>
        <p class="agents-page__subtitle">
          The specialist sub-agents the swarm can delegate to, and what each one does. This is the read-only
          capability directory — model tuning and the routing lab live on the Settings → Agents page.
        </p>
      </div>
    </header>

    <section class="agents-page__panel">
      <div class="agents-controls">
        <div class="agents-controls__group agents-controls__group--grow">
          <label class="agents-controls__label">Search</label>
          <input
            v-model="query"
            type="search"
            class="agents-controls__input"
            placeholder="Filter by name, description, capability, or tag"
          />
        </div>
        <span class="agents-count">{{ filtered.length }} / {{ store.agents.length }}</span>
        <button class="agents-controls__refresh" @click="store.fetch()" :disabled="store.loading">
          {{ store.loading ? "Loading…" : "Refresh" }}
        </button>
      </div>

      <div v-if="store.error" class="agents-page__notice agents-page__notice--error">{{ store.error }}</div>
      <div v-else-if="!store.agents.length && !store.loading" class="agents-page__notice">
        No specialist agents are configured.
      </div>
      <div v-else-if="!filtered.length && query" class="agents-page__notice">
        No agents match “{{ query }}”.
      </div>

      <div class="agents-list">
        <article v-for="agent in filtered" :key="agent.name" class="agent-card">
          <header class="agent-card__header">
            <h3 class="agent-card__name">{{ agent.name }}</h3>
            <span v-if="agent.model.primary" class="agent-card__model">{{ agent.model.primary.split('/').pop() }}</span>
          </header>
          <p class="agent-card__desc">{{ agent.description }}</p>
          <div v-if="(agent.capabilities && agent.capabilities.length) || (agent.tags && agent.tags.length)" class="agent-card__meta">
            <span v-for="c in agent.capabilities ?? []" :key="'c-' + c" class="agent-card__chip agent-card__chip--cap">{{ c }}</span>
            <span v-for="t in agent.tags ?? []" :key="'t-' + t" class="agent-card__chip agent-card__chip--tag">{{ t }}</span>
          </div>
        </article>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useAgentsStore } from "@/stores/agents";

const store = useAgentsStore();
const query = ref("");

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return store.agents;
  return store.agents.filter((a) => {
    const hay = `${a.name} ${a.description} ${(a.capabilities ?? []).join(" ")} ${(a.tags ?? []).join(" ")}`.toLowerCase();
    return hay.includes(q);
  });
});

onMounted(() => { if (!store.agents.length) void store.fetch(); });
</script>

<style scoped>
.agents-page {
  display: flex;
  flex-direction: column;
  /* Near-transparent scrim — the themed app canvas glows through. */
  background: rgba(8, 10, 18, 0.30);
  color: rgb(229 231 235);
  overflow: hidden;
}

.agents-page__header {
  padding: 1.25rem 1.5rem 0.75rem;
  border-bottom: 1px solid rgba(168, 85, 247, 0.18);
}

.agents-page__eyebrow {
  margin: 0 0 0.35rem;
}
.agents-page__title {
  font-size: 1.5rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin: 0 0 0.3rem;
}

.agents-page__subtitle {
  margin: 0;
  font-size: 0.85rem;
  color: rgb(156 163 175);
  max-width: 56rem;
}

.agents-page__panel {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 1rem 1.5rem 1.5rem;
  overflow: hidden;
}

.agents-page__notice {
  padding: 0.75rem 1rem;
  border-radius: 0.75rem;
  border: 1px solid rgba(156, 163, 175, 0.25);
  background: rgba(31, 41, 55, 0.45);
  color: rgb(209 213 219);
  font-size: 0.85rem;
  margin-bottom: 0.75rem;
}
.agents-page__notice--error {
  border-color: rgba(248, 113, 113, 0.45);
  background: rgba(127, 29, 29, 0.25);
  color: rgb(254 202 202);
}

.agents-controls {
  display: flex;
  align-items: center;
  gap: 0.85rem;
  flex-wrap: wrap;
  margin-bottom: 0.75rem;
}
.agents-controls__group { display: flex; align-items: center; gap: 0.4rem; }
.agents-controls__group--grow { flex: 1 1 auto; min-width: 14rem; }
.agents-controls__label {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: rgb(156 163 175);
}
.agents-controls__input {
  appearance: none;
  background: var(--surface-input);
  color: rgb(229 231 235);
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: var(--radius-sm);
  padding: 0.45rem 0.8rem;
  font-size: 0.85rem;
  flex: 1 1 auto;
  transition: border-color 200ms var(--ease-out), box-shadow 200ms var(--ease-out);
}
.agents-controls__input:focus {
  outline: none;
  border-color: var(--hairline-strong);
  box-shadow: 0 0 0 3px rgba(var(--accent-purple), 0.16);
}
.agents-count {
  font-size: 0.78rem;
  color: rgb(156 163 175);
  font-variant-numeric: tabular-nums;
}
.agents-controls__refresh {
  appearance: none;
  background: rgba(168, 85, 247, 0.18);
  color: rgb(243 232 255);
  border: 1px solid rgba(168, 85, 247, 0.4);
  border-radius: var(--radius-pill);
  padding: 0.4rem 1rem;
  font-size: 0.82rem;
  font-weight: 500;
  cursor: pointer;
  transition: background 200ms var(--ease-out), border-color 200ms var(--ease-out), transform 200ms var(--ease-out);
}
.agents-controls__refresh:hover:not(:disabled) {
  background: rgba(168, 85, 247, 0.28);
  border-color: var(--hairline-strong);
  transform: translateY(-1px);
}
.agents-controls__refresh:disabled { opacity: 0.55; cursor: not-allowed; }

.agents-list {
  flex: 1 1 auto;
  overflow-y: auto;
  display: grid;
  gap: 0.65rem;
}

.agent-card {
  border: 1px solid var(--hairline);
  background: var(--surface-1);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-1), inset 0 1px 0 var(--highlight-top);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  padding: 0.85rem 1rem 0.95rem;
  transition: border-color 200ms var(--ease-out), box-shadow 200ms var(--ease-out);
}
.agent-card:hover {
  border-color: var(--hairline-strong);
  box-shadow: var(--shadow-2), inset 0 1px 0 var(--highlight-top);
}
.agent-card__header {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
  margin-bottom: 0.25rem;
}
.agent-card__name {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 500;
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: -0.01em;
  color: rgb(243 232 255);
}
.agent-card__model {
  font-size: 0.72rem;
  color: rgb(156 163 175);
  margin-left: auto;
}
.agent-card__desc {
  margin: 0;
  font-size: 0.85rem;
  color: rgb(229 231 235);
}
.agent-card__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  margin-top: 0.5rem;
}
.agent-card__chip {
  font-size: 0.7rem;
  border-radius: 999px;
  padding: 0.05rem 0.5rem;
  border: 1px solid transparent;
}
.agent-card__chip--cap { background: rgba(34, 197, 94, 0.12); color: rgb(134 239 172); border-color: rgba(34, 197, 94, 0.28); }
.agent-card__chip--tag { background: rgba(56, 189, 248, 0.12); color: rgb(186 230 253); border-color: rgba(56, 189, 248, 0.28); }
</style>
