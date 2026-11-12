<template>
  <div class="page-shell federation-page">
    <header class="page-header">
      <div class="page-header__text">
        <h1 class="page-title">Federation</h1>
        <p class="page-subtitle">Configured peer instances and recent cross-instance delegations.</p>
      </div>
      <div class="page-actions">
        <button type="button" class="btn-ghost px-4 py-2 rounded-xl text-sm" :disabled="loadingPeers" @click="refresh(false)">
          {{ loadingPeers && !pinging ? "Refreshing…" : "Refresh" }}
        </button>
        <button type="button" class="btn-ghost px-4 py-2 rounded-xl text-sm" :disabled="loadingPeers" @click="refresh(true)">
          {{ pinging ? "Pinging…" : "Ping all" }}
        </button>
      </div>
    </header>

    <div v-if="peersError" class="notice notice--error federation-page__error" role="alert">{{ peersError }}</div>

    <!-- "Disabled" is something the gateway has to have said: before the first answer the page
         does not know, and after a failed request it still does not. -->
    <p v-if="!peersLoaded && loadingPeers" class="federation-instance-row">Loading federation status…</p>

    <div v-else-if="peersLoaded && !enabled" class="federation-disabled">
      <p>
        Federation is currently disabled. Set <code>federation.enabled = true</code> in
        <code>starlingai.json</code> and configure <code>federation.sharedSecret</code>
        plus at least one peer to start delegating across instances.
      </p>
    </div>

    <div v-else-if="peersLoaded">
      <p class="federation-instance-row">
        This instance: <code>{{ instanceId }}</code>
        <span v-if="peers.length === 0" class="federation-instance-row__hint">
          · No peers configured. Add entries to <code>federation.peers[]</code> in starlingai.json.
        </span>
      </p>

      <div v-if="peers.length > 0" class="federation-peer-grid">
        <article v-for="peer in peers" :key="peer.id" class="federation-peer-card">
          <header class="federation-peer-card__header">
            <div>
              <h3 class="federation-peer-card__title">
                {{ peer.id }}
                <span v-if="peer.instanceId" class="federation-peer-card__instance"> → {{ peer.instanceId }}</span>
              </h3>
              <a class="federation-peer-card__url" :href="peer.url" target="_blank" rel="noreferrer">{{ peer.url }}</a>
            </div>
            <span :class="['federation-peer-card__pill', peerStatusClass(peer)]">{{ peerStatusLabel(peer) }}</span>
          </header>

          <p v-if="peer.description" class="federation-peer-card__desc">{{ peer.description }}</p>

          <div v-if="peer.capabilityError" class="federation-peer-card__error">
            Capability fetch failed: {{ peer.capabilityError }}
          </div>

          <div v-else class="federation-peer-card__details">
            <div class="federation-peer-card__stat">
              <span class="federation-peer-card__stat-label">Agents</span>
              <span class="federation-peer-card__stat-value">{{ peer.agents?.length ?? 0 }}</span>
            </div>
            <div class="federation-peer-card__stat">
              <span class="federation-peer-card__stat-label">Tools advertised</span>
              <span class="federation-peer-card__stat-value">{{ peer.toolNames?.length ?? 0 }}</span>
            </div>
            <div class="federation-peer-card__stat">
              <span class="federation-peer-card__stat-label">Protocol</span>
              <span class="federation-peer-card__stat-value">{{ peer.protocolVersion ?? "—" }}</span>
            </div>
            <div v-if="peer.ping" class="federation-peer-card__stat">
              <span class="federation-peer-card__stat-label">Latency</span>
              <span class="federation-peer-card__stat-value">{{ peer.ping.ok ? `${peer.ping.latencyMs}ms` : `fail (${peer.ping.error ?? "—"})` }}</span>
            </div>
          </div>

          <details v-if="peer.agents && peer.agents.length > 0" class="federation-peer-card__expand">
            <summary>{{ peer.agents.length }} exposed agent{{ peer.agents.length === 1 ? "" : "s" }}</summary>
            <ul class="federation-peer-card__agent-list">
              <li v-for="agent in peer.agents" :key="agent.name">
                <code>{{ agent.name }}</code>
                <span v-if="agent.description"> — {{ agent.description }}</span>
              </li>
            </ul>
          </details>

          <p v-if="peer.tags && peer.tags.length > 0" class="federation-peer-card__tags">
            <span v-for="tag in peer.tags" :key="tag" class="federation-peer-card__tag">{{ tag }}</span>
          </p>
        </article>
      </div>

      <section class="federation-activity">
        <header class="federation-activity__header">
          <h3 class="federation-activity__title">Recent federation activity</h3>
          <button type="button" class="btn-ghost px-3 py-1.5 rounded-lg text-sm" :disabled="loadingActivity" @click="loadActivity">
            {{ loadingActivity ? "Refreshing…" : "Refresh" }}
          </button>
        </header>
        <p v-if="activityError" class="notice notice--error federation-page__error" role="alert">{{ activityError }}</p>
        <p v-if="activity.length === 0 && loadingActivity && !activityLoaded" class="federation-activity__empty">Loading activity…</p>
        <p v-else-if="activity.length === 0 && activityLoaded" class="federation-activity__empty">
          No federation activity yet. Cross-instance delegations and capability fetches will show up here.
        </p>
        <ol v-else-if="activity.length > 0" class="federation-activity__list">
          <li v-for="event in activity" :key="event.id" :class="['federation-activity__item', activityToneClass(event.severity)]">
            <div class="federation-activity__item-head">
              <code class="federation-activity__type">{{ event.type }}</code>
              <span class="federation-activity__time">{{ formatActivityTime(event.timestamp) }}</span>
            </div>
            <div class="federation-activity__body">{{ describeActivity(event) }}</div>
          </li>
        </ol>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useGatewayStore } from "@/stores/gateway";
import { useAuditStore } from "@/stores/audit";
import { useLoadWhenConnected } from "@/composables/useLoadWhenConnected";
import { errorText } from "@/composables/useToast";

interface PeerAgent { name: string; description?: string; tags?: string[] }
interface PeerSummary {
  id: string;
  url: string;
  description: string | null;
  tags: string[];
  instanceId?: string;
  protocolVersion?: string;
  agents?: PeerAgent[];
  toolNames?: string[];
  capabilitiesFetchedAt?: string;
  capabilityError?: string;
  ping?: { ok: boolean; latencyMs: number; instanceId?: string; error?: string };
}

interface ActivityEvent {
  id: string;
  timestamp: string;
  type: string;
  severity: "info" | "warn" | "error";
  data: Record<string, unknown>;
  sessionId?: string;
}

const gateway = useGatewayStore();
const auditStore = useAuditStore();

const enabled = ref(false);
const instanceId = ref("primary");
const peers = ref<PeerSummary[]>([]);
const backfillActivity = ref<ActivityEvent[]>([]);
const loadingPeers = ref(false);
const loadingActivity = ref(false);
// The in-flight peer load is a ping round (labels the button that started it).
const pinging = ref(false);
// True while that part of the page comes from a load that succeeded.
const peersLoaded = ref(false);
const activityLoaded = ref(false);
const peersError = ref<string | null>(null);
const activityError = ref<string | null>(null);

/**
 * Live activity merges three sources, deduped by event id, newest first:
 * 1. The HTTP backfill from /api/federation/activity (events that fired
 *    before the page opened, up to the server-side ring's cap of 200).
 * 2. New federation_* events streamed live via the audit-store WS feed.
 * The audit store auto-subscribes when the gateway is connected, so as
 * long as we're online new events arrive without polling.
 */
const activity = computed<ActivityEvent[]>(() => {
  const live = auditStore.events.filter((e) => e.type.startsWith("federation_"));
  const seen = new Set<string>();
  const merged: ActivityEvent[] = [];
  for (const event of [...live, ...backfillActivity.value]) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    merged.push(event as ActivityEvent);
  }
  return merged;
});

function apiBase(): string {
  return gateway.wsUrl.replace(/^ws/, "http").replace(/\/ws$/, "");
}

async function loadPeers(ping = false): Promise<void> {
  if (!gateway.token) return;
  loadingPeers.value = true;
  pinging.value = ping;
  peersError.value = null;
  try {
    const url = new URL(`${apiBase()}/api/federation/peers`);
    if (ping) url.searchParams.set("ping", "1");
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${gateway.token}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as { enabled: boolean; instanceId: string; peers: PeerSummary[] };
    enabled.value = Boolean(data.enabled);
    instanceId.value = data.instanceId ?? "primary";
    peers.value = data.peers ?? [];
    peersLoaded.value = true;
  } catch (err) {
    // A failed first load leaves the page saying what failed, not "Federation is disabled".
    // After a good one the peers already on screen stay, under the error.
    peersError.value = `Failed to ${ping ? "ping the peers" : "load the federation peers"}: ${errorText(err)}`;
  } finally {
    loadingPeers.value = false;
    pinging.value = false;
  }
}

async function loadActivity(): Promise<void> {
  if (!gateway.token) return;
  loadingActivity.value = true;
  activityError.value = null;
  try {
    const res = await fetch(`${apiBase()}/api/federation/activity?limit=80`, {
      headers: { Authorization: `Bearer ${gateway.token}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as { events: ActivityEvent[] };
    // Most recent first.
    backfillActivity.value = (data.events ?? []).slice().reverse();
    activityLoaded.value = true;
  } catch (err) {
    activityLoaded.value = false;
    activityError.value = `Failed to load federation activity: ${errorText(err)}`;
  } finally {
    loadingActivity.value = false;
  }
}

async function refresh(ping: boolean): Promise<void> {
  await Promise.all([loadPeers(ping), loadActivity()]);
}

function peerStatusLabel(peer: PeerSummary): string {
  if (peer.capabilityError) return "unreachable";
  if (peer.ping && !peer.ping.ok) return "ping failed";
  if (peer.instanceId) return "online";
  return "unknown";
}

function peerStatusClass(peer: PeerSummary): string {
  const label = peerStatusLabel(peer);
  if (label === "online") return "federation-peer-card__pill--ok";
  if (label === "unknown") return "federation-peer-card__pill--neutral";
  return "federation-peer-card__pill--error";
}

function activityToneClass(severity: ActivityEvent["severity"]): string {
  if (severity === "error") return "federation-activity__item--error";
  if (severity === "warn") return "federation-activity__item--warn";
  return "federation-activity__item--info";
}

function describeActivity(event: ActivityEvent): string {
  const data = event.data ?? {};
  const peer = String(data["peerId"] ?? data["peer"] ?? "—");
  const agent = data["agentName"] ? String(data["agentName"]) : null;
  const error = data["error"] ? String(data["error"]) : null;
  const status = data["status"] ? String(data["status"]) : null;
  const remoteSessionId = data["remoteSessionId"] ? String(data["remoteSessionId"]).slice(0, 24) : null;
  const stream = data["streaming"] === true ? " · streamed" : "";

  switch (event.type) {
    case "federation_delegate_started":
      return `Started delegation to ${peer}${agent ? ` / ${agent}` : ""}${stream}`;
    case "federation_delegate_completed":
      return `Delegation to ${peer}${agent ? ` / ${agent}` : ""} completed${remoteSessionId ? ` (remote ${remoteSessionId})` : ""}${stream}`;
    case "federation_delegate_failed":
      return `Delegation to ${peer}${agent ? ` / ${agent}` : ""} failed${error ? `: ${error}` : status ? ` (HTTP ${status})` : ""}`;
    case "federation_request_received":
      return `Inbound request from ${peer}${agent ? ` for ${agent}` : ""}${stream}`;
    case "federation_request_completed":
      return `Inbound run for ${peer}${agent ? ` / ${agent}` : ""} completed`;
    case "federation_request_failed":
      return `Inbound run for ${peer}${agent ? ` / ${agent}` : ""} failed${error ? `: ${error}` : ""}`;
    case "federation_capabilities_served":
      return `Served capabilities to ${peer}`;
    case "federation_search_started":
      return `Broadcasting workspace_search to ${data["peerCount"] ?? "?"} peer(s)`;
    case "federation_search_completed":
      return `Workspace_search broadcast finished — ${data["totalMatches"] ?? 0} match(es) across ${data["okPeers"] ?? 0}/${data["peerCount"] ?? 0} peer(s)`;
    case "federation_search_served":
      return `Served workspace_search to ${peer} — ${data["matched"] ?? 0} match(es)`;
    case "federation_auth_failed":
      return `Auth failure on /${data["route"] ?? "?"}`;
    case "federation_delegate_denied":
      return `Denied delegation${agent ? ` for ${agent}` : ""}: ${data["reason"] ?? "policy"}`;
    default:
      return `${event.type}${peer !== "—" ? ` · ${peer}` : ""}`;
  }
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

// On mount, and again when the gateway comes up after the page did or reconnects (e.g. after a
// network blip): the HTTP backfill is read again, so events that fired while we were offline
// land in the timeline.  The audit-store WS subscription handles live updates independently —
// no polling timer needed.
useLoadWhenConnected(() => {
  void loadActivity();
  // Peers already on screen stay as they are: a reload would drop their ping results. They are
  // loaded here only when no load has worked yet.
  if (!peersLoaded.value && !loadingPeers.value) void loadPeers();
});
</script>

<style scoped>
.federation-page {
  color: rgb(229 231 235);
}

.federation-page__error {
  margin-bottom: 1rem;
}

.federation-disabled {
  border: 1px dashed rgba(168, 85, 247, 0.35);
  background: rgba(15, 23, 42, 0.7);
  border-radius: 14px;
  padding: 1.25rem 1.5rem;
  color: rgb(203 213 225);
  font-size: 0.9rem;
  line-height: 1.55;
}

.federation-disabled code {
  background: rgba(0, 0, 0, 0.4);
  padding: 0.05rem 0.35rem;
  border-radius: 4px;
  color: rgb(165 243 252);
  font-size: 0.85em;
}

.federation-instance-row {
  margin: 0 0 1.1rem;
  color: rgb(203 213 225);
  font-size: 0.85rem;
}

.federation-instance-row code {
  background: rgba(15, 23, 42, 0.6);
  padding: 0.05rem 0.5rem;
  border-radius: 6px;
  color: rgb(165 243 252);
  border: 1px solid rgba(34, 211, 238, 0.18);
}

.federation-instance-row__hint {
  color: rgb(148 163 184);
}

.federation-peer-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 0.85rem;
  margin-bottom: 2rem;
}

.federation-peer-card {
  background: rgba(15, 23, 42, 0.65);
  border: 1px solid rgba(168, 85, 247, 0.18);
  border-radius: 12px;
  padding: 0.85rem 1rem 0.95rem;
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}

.federation-peer-card__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.5rem;
}

.federation-peer-card__title {
  font-size: 1rem;
  font-weight: 600;
  margin: 0;
  color: rgb(241 245 249);
}

.federation-peer-card__instance {
  color: rgb(165 243 252);
  font-weight: 500;
  font-size: 0.85em;
}

.federation-peer-card__url {
  color: rgb(148 163 184);
  font-size: 0.78rem;
  text-decoration: none;
  word-break: break-all;
}

.federation-peer-card__url:hover {
  text-decoration: underline;
  color: rgb(196 181 253);
}

.federation-peer-card__pill {
  font-size: 0.7rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 0.18rem 0.6rem;
  border-radius: 999px;
  border: 1px solid currentColor;
  white-space: nowrap;
}

.federation-peer-card__pill--ok {
  color: rgb(110 231 183);
  background: rgba(16, 185, 129, 0.15);
}

.federation-peer-card__pill--error {
  color: rgb(252 165 165);
  background: rgba(239, 68, 68, 0.18);
}

.federation-peer-card__pill--neutral {
  color: rgb(148 163 184);
  background: rgba(71, 85, 105, 0.2);
}

.federation-peer-card__desc {
  margin: 0;
  font-size: 0.82rem;
  color: rgb(148 163 184);
}

.federation-peer-card__error {
  background: rgba(239, 68, 68, 0.12);
  border: 1px solid rgba(248, 113, 113, 0.35);
  color: rgb(252 165 165);
  font-size: 0.8rem;
  padding: 0.4rem 0.55rem;
  border-radius: 8px;
}

.federation-peer-card__details {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(80px, 1fr));
  gap: 0.4rem;
  font-size: 0.78rem;
}

.federation-peer-card__stat-label {
  display: block;
  color: rgb(148 163 184);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 0.65rem;
}

.federation-peer-card__stat-value {
  display: block;
  font-weight: 600;
  color: rgb(226 232 240);
  margin-top: 0.1rem;
}

.federation-peer-card__expand {
  font-size: 0.8rem;
  color: rgb(203 213 225);
}

.federation-peer-card__expand summary {
  cursor: pointer;
  color: rgb(196 181 253);
}

.federation-peer-card__agent-list {
  list-style: none;
  padding: 0.4rem 0 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.federation-peer-card__agent-list code {
  background: rgba(15, 23, 42, 0.7);
  padding: 0 0.35rem;
  border-radius: 4px;
  color: rgb(165 243 252);
}

.federation-peer-card__tags {
  margin: 0.1rem 0 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
}

.federation-peer-card__tag {
  font-size: 0.68rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  background: rgba(34, 211, 238, 0.12);
  border: 1px solid rgba(34, 211, 238, 0.22);
  color: rgb(165 243 252);
}

.federation-activity {
  background: rgba(15, 23, 42, 0.65);
  border: 1px solid rgba(168, 85, 247, 0.18);
  border-radius: 12px;
  padding: 1rem 1.1rem 1.1rem;
}

.federation-activity__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.65rem;
}

.federation-activity__title {
  margin: 0;
  font-size: 1rem;
  color: rgb(229 231 235);
}

.federation-activity__empty {
  margin: 0.5rem 0 0;
  color: rgb(148 163 184);
  font-size: 0.85rem;
}

.federation-activity__list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.federation-activity__item {
  border-radius: 10px;
  padding: 0.55rem 0.75rem;
  border-left: 2px solid currentColor;
  background: rgba(2, 6, 23, 0.4);
}

.federation-activity__item--info {
  color: rgb(165 243 252);
}

.federation-activity__item--warn {
  color: rgb(252 211 77);
}

.federation-activity__item--error {
  color: rgb(252 165 165);
}

.federation-activity__item-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.72rem;
}

.federation-activity__type {
  background: rgba(15, 23, 42, 0.7);
  padding: 0.05rem 0.35rem;
  border-radius: 4px;
  color: inherit;
}

.federation-activity__time {
  color: rgb(148 163 184);
  margin-left: auto;
}

.federation-activity__body {
  color: rgb(226 232 240);
  font-size: 0.82rem;
  margin-top: 0.25rem;
}
</style>
