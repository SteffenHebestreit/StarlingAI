<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useOperatorRequestsStore, type PendingApproval, type PendingLongRunning } from "../stores/operatorRequests";
import { useBrowserStore } from "../stores/browser";
import BrowserSessionPanel from "./BrowserSessionPanel.vue";

const requests = useOperatorRequestsStore();
const browser = useBrowserStore();

const open = ref(false);
const showBrowser = ref(false);

const browserSessions = computed(() => (browser.enabled ? browser.activeSessions : []));
const assistCount = computed(() => browser.awaitingAssist.length);
const longRunningCount = computed(() => requests.longRunning.length);
const totalCount = computed(() => requests.approvals.length + assistCount.value + longRunningCount.value);

// The dock is present whenever there's something to act on: a pending approval,
// a paused long-running sub-agent, or a live browser session.
const visible = computed(() =>
  requests.approvals.length > 0
  || browserSessions.value.length > 0
  || longRunningCount.value > 0,
);

// A CAPTCHA handoff is urgent — pop the dock and the live browser open so the
// operator sees the "your help is needed" prompt without hunting for it.
watch(assistCount, (n, prev) => {
  if (n > prev && n > 0) {
    open.value = true;
    showBrowser.value = true;
  }
});

// A paused long-running run is also urgent — the operator's answer is on the
// critical path of the sub-agent. Pop the dock open the moment one shows up.
watch(longRunningCount, (n, prev) => {
  if (n > prev && n > 0) open.value = true;
});

// First time there's anything to do, expand the dock.
watch(visible, (now, before) => {
  if (now && !before) open.value = true;
});

function approvalSummary(a: PendingApproval): string {
  const host = a.args && typeof a.args["hostname"] === "string" ? String(a.args["hostname"]) : "";
  return host ? `${a.toolName} · ${host}` : a.toolName;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${seconds.toString().padStart(2, "0")}s` : `${seconds}s`;
}

function longRunningSummary(r: PendingLongRunning): string {
  return `${r.agentName} · ${formatElapsed(r.elapsedMs)} · ${r.completionTokens.toLocaleString()} tokens · ${r.iterations} iter`;
}
</script>

<template>
  <div v-if="visible" class="operator-dock">
    <!-- Collapsed pill -->
    <button v-if="!open" class="dock-pill" :class="{ urgent: assistCount > 0 }" @click="open = true">
      <span class="dock-pill-dot" />
      {{ totalCount }} request{{ totalCount === 1 ? "" : "s" }}
    </button>

    <!-- Expanded panel -->
    <div v-else class="dock-panel">
      <div class="dock-header">
        <h3>Operator Requests</h3>
        <button class="dock-icon-btn" title="Collapse" @click="open = false">–</button>
      </div>

      <!-- Pending approvals -->
      <div v-if="requests.approvals.length" class="dock-section">
        <div class="dock-section-title">Approvals</div>
        <div v-for="a in requests.approvals" :key="a.id" class="approval-card">
          <div class="approval-info">
            <span class="approval-tool">{{ approvalSummary(a) }}</span>
            <span v-if="a.sceneName" class="approval-scene">{{ a.sceneName }}</span>
          </div>
          <div class="approval-actions">
            <button class="btn-approve" :disabled="requests.isResponding(a.id)" @click="requests.respond(a.id, true)">Approve</button>
            <button class="btn-deny" :disabled="requests.isResponding(a.id)" @click="requests.respond(a.id, false)">Deny</button>
          </div>
        </div>
      </div>

      <!-- Paused long-running sub-agents waiting for "keep going / stop" -->
      <div v-if="requests.longRunning.length" class="dock-section">
        <div class="dock-section-title">Long-running runs</div>
        <div v-for="r in requests.longRunning" :key="r.id" class="lrg-card">
          <div class="lrg-info">
            <span class="lrg-summary">{{ longRunningSummary(r) }}</span>
            <span class="lrg-reason">{{ r.reason }}</span>
          </div>
          <div class="lrg-actions">
            <button class="btn-continue" :disabled="requests.isResponding(r.id)" @click="requests.respondLongRunning(r.id, 'continue')">+5 min</button>
            <button class="btn-unbounded" :disabled="requests.isResponding(r.id)" @click="requests.respondLongRunning(r.id, 'unbounded')">Run unbounded</button>
            <button class="btn-stop" :disabled="requests.isResponding(r.id)" @click="requests.respondLongRunning(r.id, 'stop')">Stop now</button>
          </div>
        </div>
      </div>

      <!-- Live browser sessions -->
      <div v-if="browserSessions.length" class="dock-section">
        <div class="dock-section-title">Browser</div>
        <div v-for="s in browserSessions" :key="s.id" class="browser-row" :class="{ waiting: s.state === 'assist_requested' }">
          <div class="browser-info">
            <span class="browser-page">{{ s.page || s.agentName }}</span>
            <span v-if="s.state === 'assist_requested'" class="browser-assist-reason">
              Needs you: {{ s.assistReason || "solve the challenge" }}
            </span>
            <span v-else class="browser-state">{{ s.state.replace("_", " ") }}</span>
          </div>
          <button class="btn-open-browser" :class="{ urgent: s.state === 'assist_requested' }" @click="showBrowser = true">
            {{ s.state === "assist_requested" ? "Help now" : "View" }}
          </button>
        </div>
      </div>
    </div>

    <!-- Live browser modal — the clickable browser + resolve control -->
    <Teleport to="body">
      <div v-if="showBrowser" class="browser-modal-overlay" @click.self="showBrowser = false">
        <div class="browser-modal">
          <div class="browser-modal-header">
            <span>Live Browser</span>
            <button class="dock-icon-btn" title="Close" @click="showBrowser = false">✕</button>
          </div>
          <div class="browser-modal-body">
            <BrowserSessionPanel />
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.operator-dock {
  position: fixed;
  right: 1rem;
  bottom: 1rem;
  z-index: 80;
  font-size: 0.85rem;
}

.dock-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.9rem;
  border-radius: 999px;
  border: 1px solid var(--color-border, #444);
  background: #1a1a2e;
  color: #eee;
  cursor: pointer;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}
.dock-pill.urgent { border-color: #ffb300; color: #ffb300; animation: dock-pulse 1.8s ease-in-out infinite; }
.dock-pill-dot { width: 8px; height: 8px; border-radius: 999px; background: #2196f3; }
.dock-pill.urgent .dock-pill-dot { background: #ffb300; }

@keyframes dock-pulse {
  0%, 100% { box-shadow: 0 8px 24px rgba(0,0,0,0.4); }
  50% { box-shadow: 0 0 0 4px rgba(255,179,0,0.2), 0 8px 24px rgba(0,0,0,0.4); }
}

.dock-panel {
  width: 340px;
  max-height: 70vh;
  overflow-y: auto;
  border-radius: 12px;
  border: 1px solid var(--color-border, #333);
  background: #14141f;
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.5);
}

.dock-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.6rem 0.85rem;
  border-bottom: 1px solid var(--color-border, #2a2a3a);
}
.dock-header h3 { margin: 0; font-size: 0.9rem; font-weight: 600; }

.dock-icon-btn {
  border: 1px solid var(--color-border, #444);
  background: transparent;
  color: #ccc;
  border-radius: 6px;
  width: 24px; height: 24px;
  cursor: pointer;
  line-height: 1;
}
.dock-icon-btn:hover { background: rgba(255,255,255,0.06); }

.dock-section { padding: 0.6rem 0.85rem; }
.dock-section-title {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #888;
  margin-bottom: 0.4rem;
}

.approval-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.5rem 0.6rem;
  border: 1px solid var(--color-border, #333);
  border-radius: 8px;
  margin-bottom: 0.4rem;
  background: #1a1a2e;
}
.approval-info { display: flex; flex-direction: column; gap: 0.1rem; min-width: 0; }
.approval-tool { font-family: monospace; font-size: 0.78rem; color: #eee; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.approval-scene { font-size: 0.7rem; color: #888; }
.approval-actions { display: flex; gap: 0.3rem; flex-shrink: 0; }

.btn-approve, .btn-deny, .btn-open-browser,
.btn-continue, .btn-unbounded, .btn-stop {
  font-size: 0.75rem;
  padding: 0.3rem 0.6rem;
  border-radius: 6px;
  cursor: pointer;
  border: 1px solid;
}
.btn-approve { border-color: #4caf50; background: #4caf50; color: #06210a; font-weight: 600; }
.btn-approve:hover:not(:disabled) { background: #5cca5e; }
.btn-deny { border-color: #f44336; background: transparent; color: #f44336; }
.btn-deny:hover:not(:disabled) { background: rgba(244,67,54,0.12); }
.btn-approve:disabled, .btn-deny:disabled, .btn-open-browser:disabled,
.btn-continue:disabled, .btn-unbounded:disabled, .btn-stop:disabled { opacity: 0.5; cursor: default; }

/* Long-running run cards — paused sub-agents waiting for "keep going / stop" */
.lrg-card {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.5rem 0.6rem;
  border: 1px solid #ffb300;
  border-radius: 8px;
  margin-bottom: 0.4rem;
  background: rgba(255, 179, 0, 0.08);
}
.lrg-info { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; }
.lrg-summary { font-family: monospace; font-size: 0.75rem; color: #eee; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lrg-reason { font-size: 0.72rem; color: #ffb300; }
.lrg-actions { display: flex; gap: 0.3rem; flex-wrap: wrap; }

.btn-continue { border-color: #4caf50; background: #4caf50; color: #06210a; font-weight: 600; }
.btn-continue:hover:not(:disabled) { background: #5cca5e; }
.btn-unbounded { border-color: #ffb300; background: transparent; color: #ffb300; font-weight: 600; }
.btn-unbounded:hover:not(:disabled) { background: rgba(255, 179, 0, 0.15); }
.btn-stop { border-color: #f44336; background: transparent; color: #f44336; }
.btn-stop:hover:not(:disabled) { background: rgba(244, 67, 54, 0.12); }

.browser-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.5rem 0.6rem;
  border: 1px solid var(--color-border, #333);
  border-radius: 8px;
  margin-bottom: 0.4rem;
  background: #1a1a2e;
}
.browser-row.waiting { border-color: #ffb300; background: rgba(255,179,0,0.08); }
.browser-info { display: flex; flex-direction: column; gap: 0.1rem; min-width: 0; }
.browser-page { font-size: 0.8rem; color: #eee; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.browser-state { font-size: 0.7rem; color: #888; }
.browser-assist-reason { font-size: 0.72rem; color: #ffb300; }
.btn-open-browser { border-color: #2196f3; background: transparent; color: #2196f3; flex-shrink: 0; }
.btn-open-browser.urgent { border-color: #ffb300; background: #ffb300; color: #2a1c00; font-weight: 600; }

/* Live browser modal */
.browser-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 90;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2vh 2vw;
}
.browser-modal {
  width: min(1200px, 96vw);
  max-height: 96vh;
  display: flex;
  flex-direction: column;
  background: #14141f;
  border: 1px solid var(--color-border, #333);
  border-radius: 12px;
  overflow: hidden;
}
.browser-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.6rem 0.9rem;
  border-bottom: 1px solid var(--color-border, #2a2a3a);
  font-weight: 600;
}
.browser-modal-body { overflow-y: auto; }
</style>
