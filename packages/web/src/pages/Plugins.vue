<template>
  <div class="plugins-page" style="height: 100%; overflow-y: auto">
    <div class="plugins-page__header">
      <div>
        <h2 class="plugins-page__title">Plugins</h2>
        <p class="plugins-page__subtitle">
          Explicitly enabled third-party tool packages load from the configured directory.
          All plugin tools register at Tier 2 with per-call approval, but currently execute in the gateway process.
        </p>
      </div>
      <div class="plugins-page__actions">
        <button class="plugins-page__button" :disabled="loading" @click="loadPlugins">Refresh</button>
      </div>
    </div>

    <div v-if="!enabled" class="plugins-disabled">
      <p>
        Plugin loader is disabled.  Set <code>plugins.enabled = true</code> in
        <code>starlingai.json</code> and place a plugin's
        <code>index.mjs</code> in the configured directory to start using it.
      </p>
    </div>

    <p v-if="directory" class="plugins-page__directory">
      Plugins directory: <code>{{ directory }}</code>
    </p>

    <p v-if="errorMessage" class="plugins-page__error">{{ errorMessage }}</p>

    <div v-if="loading && plugins.length === 0" class="plugins-page__empty">Loading…</div>
    <div v-else-if="plugins.length === 0" class="plugins-page__empty">
      No plugins loaded.  Drop a plugin into <code>{{ directory ?? "the plugins directory" }}</code> and refresh.
    </div>

    <ul v-else class="plugin-grid">
      <li v-for="plugin in plugins" :key="plugin.name" class="plugin-card">
        <div class="plugin-card__top">
          <div>
            <h3 class="plugin-card__title">{{ plugin.name }}</h3>
            <span class="plugin-card__version">v{{ plugin.version }}</span>
            <span v-if="plugin.author" class="plugin-card__author">by {{ plugin.author }}</span>
          </div>
        </div>
        <p v-if="plugin.description" class="plugin-card__desc">{{ plugin.description }}</p>
        <details class="plugin-card__details">
          <summary>{{ plugin.toolNames.length }} tool{{ plugin.toolNames.length === 1 ? "" : "s" }}</summary>
          <ul class="plugin-card__tools">
            <li v-for="name in plugin.toolNames" :key="name">
              <code>{{ name }}</code>
            </li>
          </ul>
        </details>
        <p class="plugin-card__meta">
          Loaded {{ formatTimestamp(plugin.loadedAt) }} · source <code>{{ plugin.source }}</code>
        </p>
      </li>
    </ul>

    <section class="plugins-activity">
      <header class="plugins-activity__header">
        <h3 class="plugins-activity__title">Recent activity</h3>
        <span class="plugins-activity__hint">live · last {{ activity.length }}</span>
      </header>
      <p v-if="activity.length === 0" class="plugins-activity__empty">
        Plugin load / unload / rejection events will stream here as they happen.
      </p>
      <ol v-else class="plugins-activity__list">
        <li
          v-for="event in activity"
          :key="event.id"
          :class="['plugins-activity__item', activityToneClass(event.severity)]"
        >
          <div class="plugins-activity__item-head">
            <code class="plugins-activity__type">{{ event.type }}</code>
            <span class="plugins-activity__time">{{ formatActivityTime(event.timestamp) }}</span>
          </div>
          <div class="plugins-activity__body">{{ describeActivity(event) }}</div>
        </li>
      </ol>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useGatewayStore } from "@/stores/gateway";
import { useAuditStore } from "@/stores/audit";

interface PluginRecord {
  name: string;
  version: string;
  description?: string;
  author?: string;
  toolNames: string[];
  loadedAt: string;
  source: string;
}

interface ActivityEvent {
  id: string;
  timestamp: string;
  type: string;
  severity: "info" | "warn" | "error";
  data: Record<string, unknown>;
}

const gateway = useGatewayStore();
const auditStore = useAuditStore();

const enabled = ref(true);
const directory = ref<string | null>(null);
const plugins = ref<PluginRecord[]>([]);
const loading = ref(false);
const errorMessage = ref<string | null>(null);

// Live activity comes from the audit-store WS feed, filtered to plugin_*
// events.  Newest first; the audit store already prepends incoming events.
const activity = computed<ActivityEvent[]>(() =>
  auditStore.events.filter((e) => e.type.startsWith("plugin_")) as ActivityEvent[],
);

function apiBase(): string {
  return gateway.wsUrl.replace(/^ws/, "http").replace(/\/ws$/, "");
}

async function loadPlugins(): Promise<void> {
  if (!gateway.token) return;
  loading.value = true;
  errorMessage.value = null;
  try {
    const res = await fetch(`${apiBase()}/api/plugins`, {
      headers: { Authorization: `Bearer ${gateway.token}` },
    });
    if (!res.ok) {
      errorMessage.value = `Failed to load plugins (${res.status})`;
      return;
    }
    const body = await res.json() as {
      enabled: boolean;
      directory: string;
      plugins: PluginRecord[];
    };
    enabled.value = body.enabled;
    directory.value = body.directory;
    plugins.value = body.plugins;
  } catch (err) {
    errorMessage.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
}

// Re-fetch the plugin list when a plugin_* event lands so the dashboard
// reflects hot-reload additions/removals without an explicit refresh.
watch(() => activity.value.length, (now, before) => {
  if (now > before) void loadPlugins();
});

function activityToneClass(severity: ActivityEvent["severity"]): string {
  if (severity === "error") return "plugins-activity__item--error";
  if (severity === "warn") return "plugins-activity__item--warn";
  return "plugins-activity__item--info";
}

function describeActivity(event: ActivityEvent): string {
  const data = event.data ?? {};
  const plugin = data["plugin"] ? String(data["plugin"]) : "?";
  const reason = data["reason"] ? String(data["reason"]) : null;
  const tools = Array.isArray(data["tools"]) ? (data["tools"] as string[]).length : null;

  switch (event.type) {
    case "plugin_loaded":
      return `Loaded ${plugin}${tools !== null ? ` (${tools} tool${tools === 1 ? "" : "s"})` : ""}`;
    case "plugin_unloaded":
      return `Unloaded ${plugin}${reason ? ` — ${reason}` : ""}`;
    case "plugin_tool_rejected":
      return `Rejected ${plugin}${data["tool"] ? `/${data["tool"]}` : ""}${reason ? ` — ${reason}` : ""}`;
    default:
      return `${event.type} · ${plugin}`;
  }
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function formatActivityTime(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  const diffMs = Date.now() - parsed.getTime();
  if (diffMs < 60_000) return "just now";
  if (diffMs < 3_600_000) return `${Math.round(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.round(diffMs / 3_600_000)}h ago`;
  return parsed.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

onMounted(() => {
  void loadPlugins();
});
</script>

<style scoped>
.plugins-page {
  padding: 1.5rem 1.75rem 3rem;
  color: rgb(229 231 235);
}

.plugins-page__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
  margin-bottom: 1.25rem;
}

.plugins-page__title {
  font-size: 1.5rem;
  font-weight: 600;
  margin: 0;
  background: linear-gradient(90deg, rgb(165 243 252), rgb(196 181 253));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.plugins-page__subtitle {
  margin: 0.4rem 0 0;
  color: rgb(156 163 175);
  font-size: 0.875rem;
  max-width: 36rem;
}

.plugins-page__actions {
  display: flex;
  gap: 0.5rem;
}

.plugins-page__button {
  background: rgba(76, 29, 149, 0.35);
  border: 1px solid rgba(168, 85, 247, 0.35);
  color: rgb(233 213 255);
  padding: 0.4rem 0.85rem;
  border-radius: 999px;
  font-size: 0.85rem;
  cursor: pointer;
  transition: all 120ms ease;
}

.plugins-page__button:hover:not(:disabled) {
  background: rgba(124, 58, 237, 0.55);
  color: white;
}

.plugins-page__button:disabled { opacity: 0.5; cursor: progress; }

.plugins-disabled {
  border: 1px dashed rgba(168, 85, 247, 0.35);
  background: rgba(15, 23, 42, 0.7);
  border-radius: 14px;
  padding: 1rem 1.25rem;
  color: rgb(203 213 225);
  font-size: 0.85rem;
  margin-bottom: 1rem;
  line-height: 1.55;
}

.plugins-disabled code,
.plugins-page__directory code {
  background: rgba(0, 0, 0, 0.4);
  padding: 0.05rem 0.35rem;
  border-radius: 4px;
  color: rgb(165 243 252);
  font-size: 0.85em;
}

.plugins-page__directory {
  color: rgb(148 163 184);
  font-size: 0.85rem;
  margin: 0 0 1rem;
}

.plugins-page__error {
  background: rgba(239, 68, 68, 0.12);
  border: 1px solid rgba(248, 113, 113, 0.4);
  border-radius: 8px;
  padding: 0.55rem 0.8rem;
  color: rgb(252 165 165);
  font-size: 0.85rem;
}

.plugins-page__empty {
  color: rgb(148 163 184);
  font-size: 0.9rem;
  padding: 1rem 0 1.5rem;
}

.plugin-grid {
  list-style: none;
  margin: 0 0 1.75rem;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 0.85rem;
}

.plugin-card {
  background: rgba(15, 23, 42, 0.65);
  border: 1px solid rgba(168, 85, 247, 0.18);
  border-radius: 12px;
  padding: 0.85rem 1rem 0.95rem;
}

.plugin-card__top {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  margin-bottom: 0.35rem;
}

.plugin-card__title {
  font-size: 1rem;
  font-weight: 600;
  margin: 0;
  color: rgb(241 245 249);
}

.plugin-card__version {
  font-size: 0.7rem;
  color: rgb(148 163 184);
  margin-right: 0.5rem;
}

.plugin-card__author {
  font-size: 0.75rem;
  color: rgb(156 163 175);
  font-style: italic;
}

.plugin-card__desc {
  margin: 0 0 0.5rem;
  color: rgb(203 213 225);
  font-size: 0.85rem;
}

.plugin-card__details {
  font-size: 0.8rem;
  color: rgb(203 213 225);
}

.plugin-card__details summary {
  cursor: pointer;
  color: rgb(196 181 253);
}

.plugin-card__tools {
  list-style: none;
  padding: 0.4rem 0 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.plugin-card__tools code {
  background: rgba(15, 23, 42, 0.7);
  padding: 0 0.35rem;
  border-radius: 4px;
  color: rgb(165 243 252);
}

.plugin-card__meta {
  margin: 0.55rem 0 0;
  font-size: 0.72rem;
  color: rgb(148 163 184);
}

.plugins-activity {
  background: rgba(15, 23, 42, 0.65);
  border: 1px solid rgba(168, 85, 247, 0.18);
  border-radius: 12px;
  padding: 1rem 1.1rem 1.1rem;
}

.plugins-activity__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.65rem;
}

.plugins-activity__title {
  margin: 0;
  font-size: 1rem;
  color: rgb(229 231 235);
}

.plugins-activity__hint {
  font-size: 0.7rem;
  color: rgb(148 163 184);
  text-transform: uppercase;
  letter-spacing: 0.07em;
}

.plugins-activity__empty {
  margin: 0.5rem 0 0;
  color: rgb(148 163 184);
  font-size: 0.85rem;
}

.plugins-activity__list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.plugins-activity__item {
  border-radius: 10px;
  padding: 0.55rem 0.75rem;
  border-left: 2px solid currentColor;
  background: rgba(2, 6, 23, 0.4);
}

.plugins-activity__item--info { color: rgb(165 243 252); }
.plugins-activity__item--warn { color: rgb(252 211 77); }
.plugins-activity__item--error { color: rgb(252 165 165); }

.plugins-activity__item-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.72rem;
}

.plugins-activity__type {
  background: rgba(15, 23, 42, 0.7);
  padding: 0.05rem 0.35rem;
  border-radius: 4px;
  color: inherit;
}

.plugins-activity__time {
  color: rgb(148 163 184);
  margin-left: auto;
}

.plugins-activity__body {
  color: rgb(226 232 240);
  font-size: 0.82rem;
  margin-top: 0.25rem;
}
</style>
