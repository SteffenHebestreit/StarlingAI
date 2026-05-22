<template>
  <div class="a2a-page" style="height: 100%; overflow-y: auto">
    <div class="a2a-page__header">
      <div>
        <h2 class="a2a-page__title">A2A Peers</h2>
        <p class="a2a-page__subtitle">
          Cross-vendor Agent-to-Agent peers (LangGraph, CrewAI, Vertex AI, …) bridged into the swarm.
          Each remote skill becomes a virtual sub-agent named
          <code>a2a__&lt;peer&gt;__&lt;skill&gt;</code> that the orchestrator can delegate to.
        </p>
      </div>
      <div class="a2a-page__actions">
        <button class="a2a-page__button" :disabled="loading" @click="refresh">Refresh</button>
      </div>
    </div>

    <p v-if="errorMessage" class="a2a-page__error">{{ errorMessage }}</p>

    <section class="a2a-section" v-if="status">
      <header class="a2a-section__header">
        <h3 class="a2a-section__title">This instance's A2A surface</h3>
      </header>
      <div class="a2a-self">
        <p>
          A2A protocol: <strong>{{ status.enabled ? "enabled" : "disabled" }}</strong>
          <template v-if="status.enabled">
            · Agent card at
            <code>/.well-known/agent-card.json</code>
            · JSON-RPC at <code>/a2a/v1</code>
          </template>
        </p>
        <p v-if="status.requireSharedBearer">
          Inbound auth: <strong>shared bearer token</strong>
          (configured in <code>a2a.inboundBearerToken</code>).
        </p>
        <p v-else-if="status.enabled">
          Inbound auth: <strong>gateway JWT</strong>
          — issue an operator token from <code>/users</code> and pass it as <code>Authorization: Bearer …</code>.
        </p>
        <p v-if="status.exposeAgents.length">
          Exposed agents: <code>{{ status.exposeAgents.join(", ") }}</code>
        </p>
      </div>
    </section>

    <section class="a2a-section">
      <header class="a2a-section__header">
        <h3 class="a2a-section__title">Configured peers</h3>
      </header>

      <div v-if="loading && peers.length === 0" class="a2a-page__empty">Loading…</div>
      <div v-else-if="peers.length === 0" class="a2a-page__empty">
        No A2A peers configured.  Add one below.
      </div>

      <ul v-else class="a2a-peer-grid">
        <li v-for="peer in peers" :key="peer.id" class="a2a-peer-card" :class="peer.lastError ? 'a2a-peer-card--error' : 'a2a-peer-card--ok'">
          <div class="a2a-peer-card__top">
            <h4>{{ peer.id }}</h4>
            <span class="a2a-peer-card__status">
              {{ peer.lastError ? "unreachable" : `${peer.skillCount} skill${peer.skillCount === 1 ? "" : "s"}` }}
            </span>
          </div>
          <p v-if="peer.description" class="a2a-peer-card__desc">{{ peer.description }}</p>
          <p class="a2a-peer-card__url"><code>{{ peer.url }}</code></p>
          <p v-if="peer.lastError" class="a2a-page__error">Last error: {{ peer.lastError }}</p>
          <details v-if="peer.skills.length" class="a2a-peer-card__skills">
            <summary>Skills bridged as virtual agents</summary>
            <ul>
              <li v-for="skill in peer.skills" :key="skill.id">
                <code>a2a__{{ peer.id }}__{{ skill.id }}</code>
                <span v-if="skill.description"> — {{ skill.description }}</span>
              </li>
            </ul>
          </details>
          <p class="a2a-peer-card__meta">Last polled: {{ formatTime(peer.lastPolledAt) }}</p>
          <div class="a2a-peer-card__actions">
            <button class="a2a-page__button a2a-page__button--danger" :disabled="busyId === peer.id" @click="confirmRemove(peer.id)">
              Remove
            </button>
          </div>
        </li>
      </ul>
    </section>

    <section class="a2a-section">
      <header class="a2a-section__header">
        <h3 class="a2a-section__title">Add A2A peer</h3>
      </header>
      <form class="a2a-form" @submit.prevent="submitAdd">
        <label class="a2a-form__field">
          <span>ID</span>
          <input v-model="addForm.id" placeholder="e.g. langgraph-prod" autocomplete="off" />
        </label>
        <label class="a2a-form__field">
          <span>Base URL</span>
          <input v-model="addForm.url" placeholder="https://peer.example.com" autocomplete="off" />
        </label>
        <label class="a2a-form__field">
          <span>Description (optional)</span>
          <input v-model="addForm.description" autocomplete="off" />
        </label>
        <label class="a2a-form__field">
          <span>Bearer token (optional, supports <code>$ENV_VAR</code>)</span>
          <input v-model="addForm.bearerToken" autocomplete="off" />
        </label>
        <label class="a2a-form__field a2a-form__field--inline">
          <input type="checkbox" v-model="addForm.enabled" />
          <span>Enabled</span>
        </label>
        <button class="a2a-page__button" type="submit" :disabled="adding">
          {{ adding ? "Adding…" : "Add peer" }}
        </button>
        <p v-if="addError" class="a2a-page__error">{{ addError }}</p>
      </form>
    </section>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { useGatewayStore } from "@/stores/gateway";

interface PeerSkill { id: string; name: string; description: string; tags?: string[] }
interface PeerEntry {
  id: string;
  url: string;
  description?: string;
  skillCount: number;
  skills: PeerSkill[];
  virtualAgents: string[];
  lastPolledAt: string;
  lastError?: string;
}
interface A2AStatus {
  enabled: boolean;
  exposeAgents: string[];
  requireSharedBearer: boolean;
  peers: PeerEntry[];
}

const gateway = useGatewayStore();
const status = ref<A2AStatus | null>(null);
const peers = ref<PeerEntry[]>([]);
const loading = ref(false);
const adding = ref(false);
const errorMessage = ref<string | null>(null);
const addError = ref<string | null>(null);
const busyId = ref<string | null>(null);

const addForm = reactive({
  id: "",
  url: "",
  description: "",
  bearerToken: "",
  enabled: true,
});

function apiBase(): string {
  return gateway.wsUrl.replace(/^ws/, "http").replace(/\/ws$/, "");
}
function authHeaders(): Record<string, string> {
  return gateway.token ? { Authorization: `Bearer ${gateway.token}` } : {};
}

async function refresh(): Promise<void> {
  if (!gateway.token) return;
  loading.value = true;
  errorMessage.value = null;
  try {
    const res = await fetch(`${apiBase()}/api/a2a/status`, { headers: authHeaders() });
    if (!res.ok) {
      errorMessage.value = `Failed to load A2A status (${res.status})`;
      return;
    }
    const body = await res.json() as A2AStatus;
    status.value = body;
    peers.value = body.peers;
  } catch (err) {
    errorMessage.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
}

async function submitAdd(): Promise<void> {
  addError.value = null;
  if (!/^[a-z0-9_-]+$/i.test(addForm.id)) {
    addError.value = "ID must match /^[a-z0-9_-]+$/i";
    return;
  }
  if (!addForm.url) {
    addError.value = "URL is required";
    return;
  }
  adding.value = true;
  try {
    const res = await fetch(`${apiBase()}/api/a2a/peers`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        id: addForm.id,
        url: addForm.url,
        description: addForm.description || undefined,
        bearerToken: addForm.bearerToken || undefined,
        enabled: addForm.enabled,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      addError.value = body.error ?? `POST failed (${res.status})`;
      return;
    }
    addForm.id = "";
    addForm.url = "";
    addForm.description = "";
    addForm.bearerToken = "";
    await refresh();
  } finally {
    adding.value = false;
  }
}

async function confirmRemove(id: string): Promise<void> {
  if (!window.confirm(`Remove A2A peer "${id}"?  Its virtual agents will be unregistered immediately.`)) return;
  busyId.value = id;
  try {
    const res = await fetch(`${apiBase()}/api/a2a/peers/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      errorMessage.value = body.error ?? `Delete failed (${res.status})`;
    }
    await refresh();
  } finally {
    busyId.value = null;
  }
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}

onMounted(() => { void refresh(); });
</script>

<style scoped>
.a2a-page { padding: 1.5rem; display: flex; flex-direction: column; gap: 1.5rem; }
.a2a-page__header { display: flex; justify-content: space-between; gap: 1rem; align-items: flex-start; }
.a2a-page__title { font-size: 1.4rem; font-weight: 600; margin: 0; }
.a2a-page__subtitle { margin: 0.25rem 0 0 0; color: rgb(156 163 175); max-width: 60rem; }
.a2a-page__button {
  background: rgb(67 56 202 / 0.6); color: white; border: 1px solid rgb(99 102 241 / 0.4);
  border-radius: 0.5rem; padding: 0.45rem 0.9rem; font-size: 0.85rem; cursor: pointer;
}
.a2a-page__button:disabled { opacity: 0.5; cursor: not-allowed; }
.a2a-page__button--danger { background: rgb(127 29 29 / 0.6); border-color: rgb(220 38 38 / 0.4); }
.a2a-page__error { color: rgb(248 113 113); font-size: 0.9rem; }
.a2a-page__empty { color: rgb(156 163 175); padding: 1rem 0; }

.a2a-section { border: 1px solid rgb(75 85 99 / 0.4); border-radius: 0.75rem; padding: 1rem 1.25rem; background: rgb(17 24 39 / 0.4); }
.a2a-section__header { margin-bottom: 0.75rem; }
.a2a-section__title { margin: 0; font-size: 1rem; font-weight: 600; }

.a2a-self p { margin: 0.25rem 0; font-size: 0.9rem; }

.a2a-peer-grid { list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(20rem, 1fr)); gap: 0.75rem; }
.a2a-peer-card { background: rgb(31 41 55 / 0.5); border: 1px solid rgb(75 85 99 / 0.4); border-radius: 0.6rem; padding: 0.75rem 0.9rem; display: flex; flex-direction: column; gap: 0.4rem; }
.a2a-peer-card--ok { border-color: rgb(34 197 94 / 0.4); }
.a2a-peer-card--error { border-color: rgb(248 113 113 / 0.4); }
.a2a-peer-card__top { display: flex; justify-content: space-between; align-items: center; }
.a2a-peer-card__top h4 { margin: 0; font-size: 1rem; font-weight: 600; }
.a2a-peer-card__status { font-size: 0.75rem; padding: 0.1rem 0.5rem; border-radius: 999px; background: rgb(55 65 81 / 0.6); }
.a2a-peer-card__desc { margin: 0; font-size: 0.85rem; color: rgb(209 213 219); }
.a2a-peer-card__url { margin: 0; font-size: 0.8rem; color: rgb(156 163 175); }
.a2a-peer-card__meta { font-size: 0.75rem; color: rgb(156 163 175); margin: 0; }
.a2a-peer-card__skills summary { cursor: pointer; }
.a2a-peer-card__skills ul { list-style: none; padding-left: 0.5rem; margin: 0.5rem 0 0 0; font-size: 0.85rem; }
.a2a-peer-card__actions { display: flex; gap: 0.5rem; margin-top: 0.5rem; }

.a2a-form { display: flex; flex-direction: column; gap: 0.6rem; max-width: 36rem; }
.a2a-form__field { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.85rem; }
.a2a-form__field--inline { flex-direction: row; align-items: center; gap: 0.5rem; }
.a2a-form__field input { background: rgb(17 24 39 / 0.7); border: 1px solid rgb(75 85 99 / 0.5); color: white; padding: 0.45rem 0.6rem; border-radius: 0.4rem; font-size: 0.85rem; }
</style>
