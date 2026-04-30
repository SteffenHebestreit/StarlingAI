<template>
  <div class="mcp-page" style="height: calc(100vh - 57px); overflow-y: auto">
    <div class="mcp-page__header">
      <div>
        <h2 class="mcp-page__title">MCP Integration</h2>
        <p class="mcp-page__subtitle">
          Bridge external Model Context Protocol servers into the swarm — and
          publish StarlingAI itself as an MCP endpoint that Claude Desktop,
          Claude Code, Cursor, and Zed can talk to.
        </p>
      </div>
      <div class="mcp-page__actions">
        <button class="mcp-page__button" :disabled="loading" @click="refresh">Refresh</button>
      </div>
    </div>

    <p v-if="errorMessage" class="mcp-page__error">{{ errorMessage }}</p>

    <!-- ── Outbound: StarlingAI as an MCP server ────────────────────────── -->
    <section class="mcp-section">
      <header class="mcp-section__header">
        <h3 class="mcp-section__title">Publish StarlingAI as MCP</h3>
        <span class="mcp-section__hint">
          When enabled, external clients can call swarm tools, agents, and
          scenes over <code>/mcp</code> (HTTP/SSE) or via the bundled stdio
          entrypoint.
        </span>
      </header>

      <div v-if="expose" class="mcp-expose-card">
        <div class="mcp-expose-card__row">
          <label class="mcp-expose-card__toggle">
            <input
              type="checkbox"
              :checked="expose.enabled"
              :disabled="patching"
              @change="patchExpose({ enabled: !expose.enabled })"
            />
            <span>{{ expose.enabled ? "Enabled" : "Disabled" }}</span>
          </label>
          <label class="mcp-expose-card__toggle">
            <input
              type="checkbox"
              :checked="expose.http.enabled"
              :disabled="patching || !expose.enabled"
              @change="patchExpose({ http: { ...expose.http, enabled: !expose.http.enabled } })"
            />
            <span>HTTP/SSE at <code>/mcp</code></span>
          </label>
          <label class="mcp-expose-card__toggle">
            <input
              type="checkbox"
              :checked="expose.http.requireAuth"
              :disabled="patching || !expose.enabled"
              @change="patchExpose({ http: { ...expose.http, requireAuth: !expose.http.requireAuth } })"
            />
            <span>Require gateway JWT</span>
          </label>
        </div>

        <div class="mcp-expose-card__metrics">
          <div class="mcp-metric">
            <span class="mcp-metric__label">Tools advertised</span>
            <span class="mcp-metric__value">{{ expose.toolCount }}</span>
          </div>
          <div class="mcp-metric">
            <span class="mcp-metric__label">Sub-agents</span>
            <span class="mcp-metric__value">{{ expose.agentCount }}</span>
          </div>
          <div class="mcp-metric">
            <span class="mcp-metric__label">Scenes</span>
            <span class="mcp-metric__value">{{ expose.sceneCount }}</span>
          </div>
          <div class="mcp-metric">
            <span class="mcp-metric__label">Active HTTP sessions</span>
            <span class="mcp-metric__value">{{ expose.activeHttpSessions }}</span>
          </div>
        </div>

        <details v-if="expose.tools.length || expose.agents.length || expose.scenes.length" class="mcp-expose-card__details">
          <summary>What's advertised</summary>
          <div class="mcp-expose-card__lists">
            <div v-if="expose.tools.length">
              <h4>Tools ({{ expose.tools.length }})</h4>
              <ul><li v-for="t in expose.tools" :key="t"><code>{{ t }}</code></li></ul>
            </div>
            <div v-if="expose.agents.length">
              <h4>Agents ({{ expose.agents.length }})</h4>
              <ul><li v-for="a in expose.agents" :key="a"><code>agent__{{ a }}</code></li></ul>
            </div>
            <div v-if="expose.scenes.length">
              <h4>Scenes ({{ expose.scenes.length }})</h4>
              <ul><li v-for="s in expose.scenes" :key="s"><code>scene__{{ s }}</code></li></ul>
            </div>
          </div>
        </details>

        <p class="mcp-expose-card__hint">
          stdio command for external clients:
          <code>{{ expose.stdioCommandHint }}</code>
        </p>
      </div>
      <div v-else class="mcp-page__empty">Loading expose status…</div>
    </section>

    <!-- ── Inbound: external MCP servers we consume ─────────────────────── -->
    <section class="mcp-section">
      <header class="mcp-section__header">
        <h3 class="mcp-section__title">External MCP servers</h3>
        <span class="mcp-section__hint">
          Each connected server's tools land in the swarm tool registry as
          <code>mcp__&lt;server&gt;__&lt;tool&gt;</code> and become routable on the next turn
          (embeddings warm up automatically).
        </span>
      </header>

      <div v-if="loading && servers.length === 0" class="mcp-page__empty">Loading…</div>
      <div v-else-if="servers.length === 0" class="mcp-page__empty">
        No MCP servers configured.  Add one below — or edit
        <code>starlingai.json</code> directly under <code>mcp.servers</code>.
      </div>

      <ul v-else class="mcp-server-grid">
        <li
          v-for="server in servers"
          :key="server.id"
          class="mcp-server-card"
          :class="`mcp-server-card--${server.status}`"
        >
          <div class="mcp-server-card__top">
            <h4 class="mcp-server-card__title">{{ server.id }}</h4>
            <span class="mcp-server-card__status">{{ server.status }}</span>
          </div>
          <p class="mcp-server-card__transport">
            Transport: <code>{{ server.config.transport }}</code>
            <template v-if="describeTransport(server.config)">
              · {{ describeTransport(server.config) }}
            </template>
          </p>
          <details v-if="server.tools.length" class="mcp-server-card__tools">
            <summary>{{ server.toolCount }} tool{{ server.toolCount === 1 ? "" : "s" }}</summary>
            <ul>
              <li v-for="t in server.tools" :key="t.name">
                <code>{{ t.name }}</code>
                <span v-if="t.description"> — {{ t.description }}</span>
              </li>
            </ul>
          </details>
          <div class="mcp-server-card__actions">
            <button class="mcp-page__button" :disabled="busyId === server.id" @click="reconnect(server.id)">
              Reconnect
            </button>
            <button class="mcp-page__button mcp-page__button--danger" :disabled="busyId === server.id" @click="confirmRemove(server.id)">
              Remove
            </button>
          </div>
        </li>
      </ul>
    </section>

    <!-- ── Add new ──────────────────────────────────────────────────────── -->
    <section class="mcp-section">
      <header class="mcp-section__header">
        <h3 class="mcp-section__title">Add MCP server</h3>
      </header>

      <form class="mcp-form" @submit.prevent="submitAdd">
        <label class="mcp-form__field">
          <span>ID</span>
          <input v-model="addForm.id" placeholder="e.g. playwright" autocomplete="off" />
        </label>

        <label class="mcp-form__field">
          <span>Transport</span>
          <select v-model="addForm.transport">
            <option value="stdio">stdio (local command)</option>
            <option value="docker">docker (run image)</option>
            <option value="docker-exec">docker-exec (existing container)</option>
            <option value="http">http (StreamableHTTP / legacy)</option>
            <option value="tcp">tcp (raw socket)</option>
          </select>
        </label>

        <template v-if="addForm.transport === 'stdio'">
          <label class="mcp-form__field">
            <span>Command</span>
            <input v-model="addForm.command" placeholder="npx" />
          </label>
          <label class="mcp-form__field">
            <span>Args (one per line)</span>
            <textarea v-model="addForm.argsText" rows="3" placeholder="-y\n@modelcontextprotocol/server-filesystem\n/data" />
          </label>
        </template>

        <template v-if="addForm.transport === 'docker'">
          <label class="mcp-form__field">
            <span>Image</span>
            <input v-model="addForm.image" placeholder="mcp/playwright" />
          </label>
          <label class="mcp-form__field">
            <span>Args (one per line, optional)</span>
            <textarea v-model="addForm.argsText" rows="2" />
          </label>
          <label class="mcp-form__field">
            <span>Network (optional)</span>
            <input v-model="addForm.network" placeholder="bridge" />
          </label>
        </template>

        <template v-if="addForm.transport === 'docker-exec'">
          <label class="mcp-form__field">
            <span>Container name or id</span>
            <input v-model="addForm.container" placeholder="my-running-container" />
          </label>
          <label class="mcp-form__field">
            <span>Args (one per line)</span>
            <textarea v-model="addForm.argsText" rows="2" placeholder="mcp\nrun" />
          </label>
        </template>

        <template v-if="addForm.transport === 'http'">
          <label class="mcp-form__field">
            <span>URL</span>
            <input v-model="addForm.url" placeholder="https://example.com/mcp" />
          </label>
          <label class="mcp-form__field">
            <span>Protocol</span>
            <select v-model="addForm.protocol">
              <option value="streamable">streamable (modern)</option>
              <option value="legacy-jsonrpc">legacy-jsonrpc</option>
            </select>
          </label>
        </template>

        <template v-if="addForm.transport === 'tcp'">
          <label class="mcp-form__field">
            <span>Host</span>
            <input v-model="addForm.host" placeholder="host.docker.internal" />
          </label>
          <label class="mcp-form__field">
            <span>Port</span>
            <input v-model.number="addForm.port" type="number" min="1" max="65535" />
          </label>
        </template>

        <label class="mcp-form__field mcp-form__field--inline">
          <input v-model="addForm.autoStart" type="checkbox" />
          <span>Auto-start on gateway boot</span>
        </label>

        <button class="mcp-page__button" type="submit" :disabled="adding">
          {{ adding ? "Connecting…" : "Add and connect" }}
        </button>

        <p v-if="addError" class="mcp-page__error">{{ addError }}</p>
      </form>
    </section>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { useGatewayStore } from "@/stores/gateway";

interface ExposeStatus {
  enabled: boolean;
  http: { enabled: boolean; requireAuth: boolean };
  toolCount: number;
  agentCount: number;
  sceneCount: number;
  tools: string[];
  agents: string[];
  scenes: string[];
  activeHttpSessions: number;
  stdioCommandHint: string;
}

interface McpServerEntry {
  id: string;
  status: "connected" | "disconnected" | "disabled";
  config: { transport: string } & Record<string, unknown>;
  toolCount: number;
  tools: Array<{ name: string; description: string }>;
}

const gateway = useGatewayStore();

const expose = ref<ExposeStatus | null>(null);
const servers = ref<McpServerEntry[]>([]);
const loading = ref(false);
const patching = ref(false);
const adding = ref(false);
const errorMessage = ref<string | null>(null);
const addError = ref<string | null>(null);
const busyId = ref<string | null>(null);

const addForm = reactive({
  id: "",
  transport: "stdio" as "stdio" | "docker" | "docker-exec" | "http" | "tcp",
  command: "",
  image: "",
  container: "",
  url: "",
  protocol: "streamable" as "streamable" | "legacy-jsonrpc",
  host: "host.docker.internal",
  port: 0,
  network: "",
  argsText: "",
  autoStart: true,
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
    const [serversRes, exposeRes] = await Promise.all([
      fetch(`${apiBase()}/api/mcp/servers`, { headers: authHeaders() }),
      fetch(`${apiBase()}/api/mcp/expose`, { headers: authHeaders() }),
    ]);
    if (serversRes.ok) {
      const body = await serversRes.json() as { servers: McpServerEntry[] };
      servers.value = body.servers;
    } else {
      errorMessage.value = `Failed to load servers (${serversRes.status})`;
    }
    if (exposeRes.ok) {
      expose.value = (await exposeRes.json()) as ExposeStatus;
    }
  } catch (err) {
    errorMessage.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
}

async function patchExpose(patch: Record<string, unknown>): Promise<void> {
  if (!gateway.token || !expose.value) return;
  patching.value = true;
  try {
    const res = await fetch(`${apiBase()}/api/mcp/expose`, {
      method: "PATCH",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      errorMessage.value = body.error ?? `PATCH failed (${res.status})`;
      return;
    }
    await refresh();
  } finally {
    patching.value = false;
  }
}

async function reconnect(id: string): Promise<void> {
  busyId.value = id;
  try {
    const res = await fetch(`${apiBase()}/api/mcp/servers/${encodeURIComponent(id)}/reconnect`, {
      method: "POST",
      headers: authHeaders(),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      errorMessage.value = body.error ?? `Reconnect failed (${res.status})`;
    }
    await refresh();
  } finally {
    busyId.value = null;
  }
}

async function confirmRemove(id: string): Promise<void> {
  if (!window.confirm(`Remove MCP server "${id}"?  Its tools will disappear from the registry.`)) return;
  busyId.value = id;
  try {
    const res = await fetch(`${apiBase()}/api/mcp/servers/${encodeURIComponent(id)}`, {
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

function buildAddPayload(): Record<string, unknown> | null {
  const args = addForm.argsText
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const base = { autoStart: addForm.autoStart };
  switch (addForm.transport) {
    case "stdio":
      if (!addForm.command) { addError.value = "Command is required"; return null; }
      return { transport: "stdio", command: addForm.command, args, ...base };
    case "docker":
      if (!addForm.image) { addError.value = "Image is required"; return null; }
      return {
        transport: "docker",
        image: addForm.image,
        args,
        ...(addForm.network ? { network: addForm.network } : {}),
        ...base,
      };
    case "docker-exec":
      if (!addForm.container) { addError.value = "Container is required"; return null; }
      return { transport: "docker-exec", container: addForm.container, args, ...base };
    case "http":
      if (!addForm.url) { addError.value = "URL is required"; return null; }
      return { transport: "http", url: addForm.url, protocol: addForm.protocol, ...base };
    case "tcp":
      if (!addForm.port) { addError.value = "Port is required"; return null; }
      return { transport: "tcp", host: addForm.host, port: addForm.port, ...base };
  }
}

async function submitAdd(): Promise<void> {
  addError.value = null;
  if (!addForm.id || !/^[a-z0-9_-]+$/i.test(addForm.id)) {
    addError.value = "ID is required and must match /^[a-z0-9_-]+$/i";
    return;
  }
  const config = buildAddPayload();
  if (!config) return;

  adding.value = true;
  try {
    const res = await fetch(`${apiBase()}/api/mcp/servers`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ id: addForm.id, config }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      addError.value = body.error ?? `POST failed (${res.status})`;
      return;
    }
    addForm.id = "";
    addForm.command = "";
    addForm.image = "";
    addForm.container = "";
    addForm.url = "";
    addForm.argsText = "";
    addForm.network = "";
    await refresh();
  } finally {
    adding.value = false;
  }
}

function describeTransport(cfg: { transport: string } & Record<string, unknown>): string {
  switch (cfg.transport) {
    case "stdio": return String(cfg["command"] ?? "");
    case "docker": return String(cfg["image"] ?? "");
    case "docker-exec": return String(cfg["container"] ?? "");
    case "http": return String(cfg["url"] ?? "");
    case "tcp": return `${cfg["host"] ?? ""}:${cfg["port"] ?? ""}`;
    default: return "";
  }
}

onMounted(() => {
  void refresh();
});
</script>

<style scoped>
.mcp-page {
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}
.mcp-page__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}
.mcp-page__title {
  font-size: 1.4rem;
  font-weight: 600;
  margin: 0;
}
.mcp-page__subtitle {
  margin: 0.25rem 0 0 0;
  color: rgb(156 163 175);
  max-width: 60rem;
}
.mcp-page__button {
  background: rgb(67 56 202 / 0.6);
  color: white;
  border: 1px solid rgb(99 102 241 / 0.4);
  border-radius: 0.5rem;
  padding: 0.45rem 0.9rem;
  font-size: 0.85rem;
  cursor: pointer;
}
.mcp-page__button:disabled { opacity: 0.5; cursor: not-allowed; }
.mcp-page__button--danger {
  background: rgb(127 29 29 / 0.6);
  border-color: rgb(220 38 38 / 0.4);
}
.mcp-page__error {
  color: rgb(248 113 113);
  font-size: 0.9rem;
}
.mcp-page__empty {
  color: rgb(156 163 175);
  font-size: 0.9rem;
  padding: 1rem 0;
}
.mcp-section {
  border: 1px solid rgb(75 85 99 / 0.4);
  border-radius: 0.75rem;
  padding: 1rem 1.25rem;
  background: rgb(17 24 39 / 0.4);
}
.mcp-section__header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 0.75rem;
}
.mcp-section__title { font-size: 1rem; margin: 0; font-weight: 600; }
.mcp-section__hint { color: rgb(156 163 175); font-size: 0.85rem; max-width: 40rem; }

.mcp-expose-card { display: flex; flex-direction: column; gap: 0.75rem; }
.mcp-expose-card__row { display: flex; flex-wrap: wrap; gap: 1.5rem; }
.mcp-expose-card__toggle { display: flex; gap: 0.5rem; align-items: center; cursor: pointer; }
.mcp-expose-card__metrics { display: grid; grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr)); gap: 0.75rem; }
.mcp-metric { background: rgb(31 41 55 / 0.6); padding: 0.6rem 0.9rem; border-radius: 0.5rem; }
.mcp-metric__label { font-size: 0.75rem; color: rgb(156 163 175); display: block; }
.mcp-metric__value { font-size: 1.1rem; font-weight: 600; }
.mcp-expose-card__details summary { cursor: pointer; }
.mcp-expose-card__lists { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: 1rem; padding-top: 0.75rem; }
.mcp-expose-card__lists ul { list-style: none; padding: 0; margin: 0; max-height: 12rem; overflow-y: auto; }
.mcp-expose-card__hint { font-size: 0.8rem; color: rgb(156 163 175); }

.mcp-server-grid { list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr)); gap: 0.75rem; }
.mcp-server-card { background: rgb(31 41 55 / 0.5); border: 1px solid rgb(75 85 99 / 0.4); border-radius: 0.6rem; padding: 0.75rem 0.9rem; display: flex; flex-direction: column; gap: 0.4rem; }
.mcp-server-card--connected { border-color: rgb(34 197 94 / 0.5); }
.mcp-server-card--disconnected { border-color: rgb(248 113 113 / 0.4); }
.mcp-server-card__top { display: flex; justify-content: space-between; align-items: center; }
.mcp-server-card__title { margin: 0; font-size: 1rem; font-weight: 600; }
.mcp-server-card__status { font-size: 0.75rem; padding: 0.1rem 0.5rem; border-radius: 999px; background: rgb(55 65 81 / 0.6); }
.mcp-server-card--connected .mcp-server-card__status { background: rgb(22 101 52 / 0.6); }
.mcp-server-card--disconnected .mcp-server-card__status { background: rgb(127 29 29 / 0.6); }
.mcp-server-card__transport { margin: 0; font-size: 0.85rem; color: rgb(156 163 175); }
.mcp-server-card__tools { font-size: 0.85rem; }
.mcp-server-card__tools summary { cursor: pointer; }
.mcp-server-card__tools ul { list-style: none; padding-left: 0.5rem; margin: 0.5rem 0 0 0; }
.mcp-server-card__actions { display: flex; gap: 0.5rem; margin-top: 0.5rem; }

.mcp-form { display: flex; flex-direction: column; gap: 0.6rem; max-width: 36rem; }
.mcp-form__field { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.85rem; }
.mcp-form__field--inline { flex-direction: row; align-items: center; gap: 0.5rem; }
.mcp-form__field input,
.mcp-form__field select,
.mcp-form__field textarea {
  background: rgb(17 24 39 / 0.7);
  border: 1px solid rgb(75 85 99 / 0.5);
  color: white;
  padding: 0.45rem 0.6rem;
  border-radius: 0.4rem;
  font-family: inherit;
  font-size: 0.85rem;
}
.mcp-form__field textarea { font-family: ui-monospace, SFMono-Regular, monospace; }
</style>
