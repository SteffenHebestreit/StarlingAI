<template>
  <div class="page-shell mcp-page">
    <header class="page-header">
      <div class="page-header__text">
        <h1 class="page-title">MCP Integration</h1>
        <p class="page-subtitle">
          Bridge external Model Context Protocol servers into the swarm — and
          publish {{ product.name }} itself as an MCP endpoint that Claude Desktop,
          Claude Code, Cursor, and Zed can talk to.
        </p>
      </div>
      <div class="page-actions">
        <button type="button" class="btn-ghost px-4 py-2 rounded-xl text-sm" :disabled="loading" @click="refresh">
          {{ loading ? "Refreshing…" : "Refresh" }}
        </button>
      </div>
    </header>

    <div v-if="errorMessage" class="notice notice--error mcp-page__notice" role="alert">{{ errorMessage }}</div>

    <!-- ── Outbound: this product as an MCP server ────────────────────────── -->
    <section class="mcp-section">
      <header class="mcp-section__header">
        <h3 class="mcp-section__title">Publish {{ product.name }} as MCP</h3>
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
              @change="toggleExpose($event, { enabled: !expose.enabled })"
            />
            <span>{{ expose.enabled ? "Enabled" : "Disabled" }}</span>
          </label>
          <label class="mcp-expose-card__toggle">
            <input
              type="checkbox"
              :checked="expose.http.enabled"
              :disabled="patching || !expose.enabled"
              @change="toggleExpose($event, { http: { ...expose.http, enabled: !expose.http.enabled } })"
            />
            <span>HTTP/SSE at <code>/mcp</code></span>
          </label>
          <label class="mcp-expose-card__toggle">
            <input
              type="checkbox"
              :checked="expose.http.requireAuth"
              :disabled="patching || !expose.enabled"
              @change="toggleRequireAuth($event)"
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
      <div v-else-if="exposeError" class="notice notice--error">{{ exposeError }}</div>
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
      <div v-else-if="serversLoaded && servers.length === 0" class="mcp-page__empty">
        No MCP servers configured.  Add one below — or edit
        <code>starlingai.json</code> directly under <code>mcp.servers</code>.
      </div>
      <div v-else-if="servers.length === 0" class="notice notice--error">
        The server list could not be loaded.
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
            <button type="button" class="btn-ghost px-3 py-1.5 rounded-lg text-sm" :disabled="busyId === server.id" @click="reconnect(server.id)">
              Reconnect
            </button>
            <button type="button" class="btn-danger px-3 py-1.5 rounded-lg text-sm" :disabled="busyId === server.id" @click="confirmRemove(server.id)">
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

      <!-- novalidate: a refused submit is answered in the line under the form, not by the
           browser's own bubble. -->
      <form ref="addFormEl" class="mcp-form" novalidate @submit.prevent="submitAdd">
        <label class="mcp-form__field">
          <span>ID <span class="text-red-400" aria-hidden="true">*</span></span>
          <input id="mcp-add-id" v-model="addForm.id" required aria-required="true" placeholder="e.g. playwright" autocomplete="off" />
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
            <span>Command <span class="text-red-400" aria-hidden="true">*</span></span>
            <input id="mcp-add-command" v-model="addForm.command" required aria-required="true" placeholder="npx" />
          </label>
          <label class="mcp-form__field">
            <span>Args (one per line)</span>
            <textarea v-model="addForm.argsText" rows="3" placeholder="-y&#10;@modelcontextprotocol/server-filesystem&#10;/data" />
          </label>
        </template>

        <template v-if="addForm.transport === 'docker'">
          <label class="mcp-form__field">
            <span>Image <span class="text-red-400" aria-hidden="true">*</span></span>
            <input id="mcp-add-image" v-model="addForm.image" required aria-required="true" placeholder="mcp/playwright" />
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
            <span>Container name or id <span class="text-red-400" aria-hidden="true">*</span></span>
            <input id="mcp-add-container" v-model="addForm.container" required aria-required="true" placeholder="my-running-container" />
          </label>
          <label class="mcp-form__field">
            <span>Args (one per line)</span>
            <textarea v-model="addForm.argsText" rows="2" placeholder="mcp&#10;run" />
          </label>
        </template>

        <template v-if="addForm.transport === 'http'">
          <label class="mcp-form__field">
            <span>URL <span class="text-red-400" aria-hidden="true">*</span></span>
            <input id="mcp-add-url" v-model="addForm.url" required aria-required="true" placeholder="https://example.com/mcp" />
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
            <span>Port <span class="text-red-400" aria-hidden="true">*</span></span>
            <input id="mcp-add-port" v-model.number="addForm.port" type="number" min="1" max="65535" required aria-required="true" />
          </label>
        </template>

        <label class="mcp-form__field mcp-form__field--inline">
          <input v-model="addForm.autoStart" type="checkbox" />
          <span>Auto-start on gateway boot</span>
        </label>

        <button class="btn-grad px-4 py-2 rounded-xl text-sm" type="submit" :disabled="adding">
          {{ adding ? "Connecting…" : "Add and connect" }}
        </button>

        <p v-if="addError" class="mcp-page__error" role="alert">{{ addError }}</p>
      </form>
    </section>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from "vue";
import { useGatewayStore } from "@/stores/gateway";
import { useProductStore } from "@/stores/product";
import { confirmAction } from "@/composables/useConfirm";
import { useLoadWhenConnected } from "@/composables/useLoadWhenConnected";
import { useToast, errorText } from "@/composables/useToast";

// Product name comes from GET /api/product so a fork rebrands without editing this
// file (docs/fork-boilerplate-plan.md WS1).
const product = useProductStore();

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
const toast = useToast();

const expose = ref<ExposeStatus | null>(null);
// Why there is no expose status to show, once its load has failed.
const exposeError = ref<string | null>(null);
const servers = ref<McpServerEntry[]>([]);
// True while the last load of the list succeeded: only then does an empty list mean "no servers".
const serversLoaded = ref(false);
const loading = ref(false);
const patching = ref(false);
const adding = ref(false);
const errorMessage = ref<string | null>(null);
const addError = ref<string | null>(null);
const busyId = ref<string | null>(null);
const addFormEl = ref<HTMLFormElement | null>(null);

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
  serversLoaded.value = false;
  if (!gateway.token) {
    errorMessage.value = "Not signed in to the gateway — sign in, then refresh.";
    exposeError.value = "The expose status could not be loaded.";
    return;
  }
  loading.value = true;
  errorMessage.value = null;
  exposeError.value = null;
  try {
    const [serversRes, exposeRes] = await Promise.all([
      fetch(`${apiBase()}/api/mcp/servers`, { headers: authHeaders() }),
      fetch(`${apiBase()}/api/mcp/expose`, { headers: authHeaders() }),
    ]);
    if (serversRes.ok) {
      const body = await serversRes.json() as { servers: McpServerEntry[] };
      servers.value = body.servers;
      serversLoaded.value = true;
    } else {
      errorMessage.value = `Failed to load servers (${serversRes.status})`;
    }
    if (exposeRes.ok) {
      expose.value = (await exposeRes.json()) as ExposeStatus;
    } else {
      exposeError.value = `Failed to load expose status (${exposeRes.status})`;
    }
  } catch (err) {
    errorMessage.value = errorText(err);
    exposeError.value = "The expose status could not be loaded.";
  } finally {
    loading.value = false;
  }
}

/** Resolves to true when the gateway took the change. */
async function patchExpose(patch: Record<string, unknown>, saved: string): Promise<boolean> {
  if (!gateway.token || !expose.value) return false;
  patching.value = true;
  try {
    const res = await fetch(`${apiBase()}/api/mcp/expose`, {
      method: "PATCH",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      toast.error("Couldn't change the MCP endpoint", body.error || `PATCH failed (${res.status})`);
      return false;
    }
    toast.success("MCP endpoint updated", saved);
    await refresh();
    return true;
  } catch (err) {
    toast.error("Couldn't change the MCP endpoint", errorText(err));
    return false;
  } finally {
    patching.value = false;
  }
}

function describeExposePatch(patch: { enabled?: boolean; http?: ExposeStatus["http"] }): string {
  if (patch.enabled !== undefined) {
    return patch.enabled ? `${product.name} is published as an MCP server.` : `${product.name} is no longer published as an MCP server.`;
  }
  if (patch.http && patch.http.enabled !== expose.value?.http.enabled) {
    return patch.http.enabled ? "The /mcp endpoint answers over HTTP/SSE." : "The /mcp endpoint is closed.";
  }
  return patch.http?.requireAuth ? "Callers of /mcp need a gateway JWT again." : "The /mcp endpoint no longer asks for a gateway JWT.";
}

async function toggleExpose(event: Event, patch: { enabled?: boolean; http?: ExposeStatus["http"] }): Promise<void> {
  const box = event.target as HTMLInputElement;
  const clicked = box.checked;
  const saved = await patchExpose(patch, describeExposePatch(patch));
  // The click already flipped the box; a change the gateway did not take puts it back.
  if (!saved) box.checked = !clicked;
}

async function toggleRequireAuth(event: Event): Promise<void> {
  if (!expose.value) return;
  const box = event.target as HTMLInputElement;
  const requireAuth = box.checked;
  // Asked only on the way to less protection; turning the check back on needs no second thought.
  if (!requireAuth) {
    const confirmed = await confirmAction({
      title: "Stop requiring a gateway JWT on /mcp?",
      message: `Anyone who can reach this gateway will be able to call ${product.name}'s tools, agents and scenes over /mcp without signing in, with operator rights.`,
      confirmLabel: "Turn off authentication",
      danger: true,
      eyebrow: "Lowers security",
    });
    if (!confirmed) {
      box.checked = true;
      return;
    }
  }
  await toggleExpose(event, { http: { ...expose.value.http, requireAuth } });
}

async function reconnect(id: string): Promise<void> {
  busyId.value = id;
  try {
    const res = await fetch(`${apiBase()}/api/mcp/servers/${encodeURIComponent(id)}/reconnect`, {
      method: "POST",
      headers: authHeaders(),
    });
    // Toasts, not the page's error line: the refresh below clears that line.
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      toast.error(`Couldn't reconnect "${id}"`, body.error || `Reconnect failed (${res.status})`);
    } else {
      const body = await res.json().catch(() => ({})) as { status?: string; toolCount?: number };
      if (body.status === "disconnected") toast.error(`"${id}" did not connect`, "Auto-start is off for it, or the gateway could not reach it.");
      else toast.success(`Reconnected "${id}"`, toolCountText(body.toolCount));
    }
    await refresh();
  } catch (err) {
    toast.error(`Couldn't reconnect "${id}"`, errorText(err));
  } finally {
    busyId.value = null;
  }
}

function toolCountText(count: number | undefined): string {
  if (count === undefined) return "Its tools are in the registry.";
  return `${count} tool${count === 1 ? " is" : "s are"} in the registry.`;
}

async function confirmRemove(id: string): Promise<void> {
  const confirmed = await confirmAction({
    title: `Remove the MCP server "${id}"?`,
    message: "Its connection is closed, its tools disappear from the registry, and its configuration is deleted. To get it back you add it again.",
    confirmLabel: "Remove server",
    danger: true,
  });
  if (!confirmed) return;
  busyId.value = id;
  try {
    const res = await fetch(`${apiBase()}/api/mcp/servers/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      toast.error(`Couldn't remove "${id}"`, body.error || `Delete failed (${res.status})`);
    } else {
      toast.success("Server removed", `"${id}" and its tools are gone from the registry.`);
    }
    await refresh();
  } catch (err) {
    toast.error(`Couldn't remove "${id}"`, errorText(err));
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

/** The fields the chosen transport cannot do without, in the order the form shows them. */
function requiredAddFields(): Array<{ id: string; label: string; filled: boolean }> {
  const fields = [{ id: "mcp-add-id", label: "ID", filled: addForm.id.trim() !== "" }];
  switch (addForm.transport) {
    case "stdio": fields.push({ id: "mcp-add-command", label: "Command", filled: addForm.command.trim() !== "" }); break;
    case "docker": fields.push({ id: "mcp-add-image", label: "Image", filled: addForm.image.trim() !== "" }); break;
    case "docker-exec": fields.push({ id: "mcp-add-container", label: "Container name or id", filled: addForm.container.trim() !== "" }); break;
    case "http": fields.push({ id: "mcp-add-url", label: "URL", filled: addForm.url.trim() !== "" }); break;
    case "tcp": fields.push({ id: "mcp-add-port", label: "Port", filled: Boolean(addForm.port) }); break;
  }
  return fields;
}

function focusAddField(id: string): void {
  addFormEl.value?.querySelector<HTMLElement>(`#${id}`)?.focus();
}

async function submitAdd(): Promise<void> {
  addError.value = null;
  // The first required field left empty is named under the form and gets the cursor.
  const missing = requiredAddFields().find((field) => !field.filled);
  if (missing) {
    addError.value = `${missing.label} is required.`;
    focusAddField(missing.id);
    return;
  }
  if (!/^[a-z0-9_-]+$/i.test(addForm.id)) {
    addError.value = "ID must match /^[a-z0-9_-]+$/i";
    focusAddField("mcp-add-id");
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
    const added = await res.json().catch(() => ({})) as { status?: string; toolCount?: number };
    const addedId = addForm.id;
    if (added.status === "disconnected") toast.info(`Added "${addedId}", not connected`, "It is saved, but auto-start is off or the gateway could not reach it.");
    else toast.success(`Added "${addedId}"`, toolCountText(added.toolCount));
    addForm.id = "";
    addForm.command = "";
    addForm.image = "";
    addForm.container = "";
    addForm.url = "";
    addForm.argsText = "";
    addForm.network = "";
    await refresh();
  } catch (err) {
    toast.error("Couldn't add the server", errorText(err));
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

// Also when the gateway comes up after the page did (opened by URL, or signed in to here).
useLoadWhenConnected(refresh);
</script>

<style scoped>
/* The sections keep their 1.5rem rhythm; the shared header brings its own margin. */
.mcp-page > .mcp-page__notice { margin-bottom: 1.5rem; }
.mcp-section + .mcp-section { margin-top: 1.5rem; }
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
