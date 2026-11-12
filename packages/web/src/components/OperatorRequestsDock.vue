<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useOperatorRequestsStore, type PendingApproval, type PendingLongRunning } from "../stores/operatorRequests";
import { useBrowserStore } from "../stores/browser";
import { useEscapeToClose } from "../composables/useEscapeToClose";
import BrowserSessionPanel from "./BrowserSessionPanel.vue";

const requests = useOperatorRequestsStore();
const browser = useBrowserStore();

const open = ref(false);
const showBrowser = ref(false);

const browserSessions = computed(() => (browser.enabled ? browser.activeSessions : []));
const assistCount = computed(() => browser.awaitingAssist.length);
const longRunningCount = computed(() => requests.longRunning.length);
// What waits for an answer: approvals, a browser asking for help, a paused run.
const requestCount = computed(() => requests.approvals.length + assistCount.value + longRunningCount.value);
// A browser that only runs is not a request: it can be watched, and nothing waits on it.
const watchableBrowserCount = computed(() => browserSessions.value.filter((s) => s.state !== "assist_requested").length);

// The collapsed pill names what the dock holds. It used to count requests only, so a dock that
// was there for a running browser alone read "0 requests".
const pillLabel = computed(() => {
  const parts: string[] = [];
  if (requestCount.value > 0) parts.push(`${requestCount.value} request${requestCount.value === 1 ? "" : "s"}`);
  if (watchableBrowserCount.value > 0) parts.push(`${watchableBrowserCount.value} live browser${watchableBrowserCount.value === 1 ? "" : "s"}`);
  return parts.join(" · ") || "Operator requests";
});

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

// The live browser is a dialog: it takes the focus while it is up, hands it back to where it
// was, and Escape closes it. A key pressed inside the remote browser never gets this far — the
// viewer keeps it — so Escape there still goes to the page being driven.
const browserDialog = ref<HTMLElement | null>(null);
let focusBeforeBrowser: HTMLElement | null = null;
watch(showBrowser, (shown) => {
  if (shown) {
    focusBeforeBrowser = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    void nextTick(() => browserDialog.value?.focus({ preventScroll: true }));
  } else {
    if (focusBeforeBrowser?.isConnected) focusBeforeBrowser.focus({ preventScroll: true });
    focusBeforeBrowser = null;
  }
});
useEscapeToClose(() => showBrowser.value, () => { showBrowser.value = false; });
// No focus trap here (composables/useFocusTrap.ts), unlike the other dialogs: Tab is a key the
// page in the remote browser needs — it moves between that page's fields — so it is never taken
// from the viewer or turned round at this dialog's edge.

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
    <button v-if="!open" type="button" class="dock-pill" :class="{ urgent: assistCount > 0 }" @click="open = true">
      <span class="dock-pill-dot" aria-hidden="true" />
      {{ pillLabel }}
    </button>

    <!-- Expanded panel -->
    <div v-else class="dock-panel">
      <div class="dock-header">
        <h3>Operator Requests</h3>
        <button type="button" class="hud-btn dock-icon-btn" title="Collapse" aria-label="Collapse operator requests" @click="open = false">
          <span aria-hidden="true">–</span>
        </button>
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
            <button type="button" class="btn-grad dock-btn" :disabled="requests.isResponding(a.id)" @click="requests.respond(a.id, true)">Approve</button>
            <button type="button" class="btn-ghost dock-btn dock-btn--refuse" :disabled="requests.isResponding(a.id)" @click="requests.respond(a.id, false)">Deny</button>
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
            <button type="button" class="btn-grad dock-btn" :disabled="requests.isResponding(r.id)" @click="requests.respondLongRunning(r.id, 'continue')">+5 min</button>
            <button type="button" class="btn-ghost dock-btn dock-btn--caution" :disabled="requests.isResponding(r.id)" @click="requests.respondLongRunning(r.id, 'unbounded')">Run unbounded</button>
            <button type="button" class="btn-ghost dock-btn dock-btn--refuse" :disabled="requests.isResponding(r.id)" @click="requests.respondLongRunning(r.id, 'stop')">Stop now</button>
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
          <button
            type="button"
            class="dock-btn"
            :class="s.state === 'assist_requested' ? 'btn-grad' : 'btn-brand-ghost'"
            @click="showBrowser = true"
          >
            {{ s.state === "assist_requested" ? "Help now" : "View" }}
          </button>
        </div>
      </div>
    </div>

    <!-- Live browser modal — the clickable browser + resolve control -->
    <Teleport to="body">
      <div v-if="showBrowser" class="browser-modal-overlay" @click.self="showBrowser = false">
        <div
          ref="browserDialog"
          class="browser-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="live-browser-title"
          tabindex="-1"
        >
          <div class="browser-modal-header">
            <span id="live-browser-title">Live Browser</span>
            <button type="button" class="hud-btn dock-icon-btn" title="Close (Esc)" aria-label="Close the live browser" @click="showBrowser = false">
              <span aria-hidden="true">✕</span>
            </button>
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
/* Every colour here comes from the theme's tokens, so the dock follows the palette. Two are fixed
   on purpose, as everywhere else in the app: amber for "this waits for you", red for refusing. */
.operator-dock {
  position: fixed;
  right: 1rem;
  bottom: 1rem;
  /* above the chat's composer launcher, which shares this corner: a request waiting for an answer wins */
  z-index: var(--z-dock);
  font-size: 0.85rem;
  color: rgb(229, 231, 235);
}

/* The popover surface over the page's own colour: opaque without a backdrop blur, which would be
   paid on every frame for as long as the dock is up. */
.dock-pill,
.dock-panel,
.browser-modal {
  background: linear-gradient(var(--surface-3), var(--surface-3)), rgb(var(--app-bg));
}

.dock-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 2.25rem;
  padding: 0.5rem 0.9rem;
  border-radius: var(--radius-pill);
  border: 1px solid var(--hairline-strong);
  color: inherit;
  cursor: pointer;
  box-shadow: var(--shadow-2);
}
.dock-pill:hover { border-color: rgba(var(--logo-cyan), 0.55); }
.dock-pill:focus-visible {
  outline: 2px solid rgba(var(--logo-cyan), 0.75);
  outline-offset: 2px;
}
.dock-pill.urgent {
  border-color: rgba(251, 191, 36, 0.7);
  color: rgb(252, 211, 77);
  animation: dock-pulse 1.8s ease-in-out infinite;
}
.dock-pill-dot { width: 8px; height: 8px; border-radius: 999px; background: rgb(var(--logo-cyan)); }
.dock-pill.urgent .dock-pill-dot { background: rgb(251, 191, 36); }

@keyframes dock-pulse {
  0%, 100% { box-shadow: var(--shadow-2), 0 0 0 0 rgba(251, 191, 36, 0); }
  50% { box-shadow: var(--shadow-2), 0 0 0 4px rgba(251, 191, 36, 0.2); }
}
/* The amber edge and dot already say "urgent" without the pulse. */
@media (prefers-reduced-motion: reduce) {
  .dock-pill.urgent { animation: none; }
}

.dock-panel {
  width: min(340px, calc(100vw - 2rem));
  max-height: 70vh;
  overflow-y: auto;
  border-radius: var(--radius-sm);
  border: 1px solid var(--hairline-strong);
  box-shadow: var(--shadow-3);
}

.dock-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.5rem 0.6rem 0.5rem 0.85rem;
  border-bottom: 1px solid var(--hairline);
}
.dock-header h3 { margin: 0; font-size: 0.9rem; font-weight: 600; }

/* 32px to look at; the ::before takes presses from 40px. */
.dock-icon-btn {
  position: relative;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  line-height: 1;
  cursor: pointer;
}
.dock-icon-btn::before {
  content: "";
  position: absolute;
  inset: -0.25rem;
}

.dock-section { padding: 0.6rem 0.85rem; }
.dock-section-title {
  font-family: var(--font-label);
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: rgb(156, 163, 175);
  margin-bottom: 0.4rem;
}

.approval-card,
.browser-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.5rem 0.6rem;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-xs);
  margin-bottom: 0.4rem;
  background: var(--surface-2);
}
.approval-info { display: flex; flex-direction: column; gap: 0.1rem; min-width: 0; }
.approval-tool { font-family: var(--font-mono); font-size: 0.78rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.approval-scene { font-size: 0.7rem; color: rgb(156, 163, 175); }
.approval-actions { display: flex; gap: 0.3rem; flex-shrink: 0; }

/* The shared button classes give the look; this is the dock's size for them. */
.dock-btn {
  flex-shrink: 0;
  min-height: 2rem;
  padding: 0.3rem 0.7rem;
  border-radius: var(--radius-xs);
  font-size: 0.75rem;
}
.dock-btn--refuse { border-color: rgba(239, 68, 68, 0.4); color: rgb(248, 113, 113); }
.dock-btn--refuse:hover:not(:disabled) { border-color: rgba(239, 68, 68, 0.65); color: rgb(252, 165, 165); }
.dock-btn--caution { border-color: rgba(251, 191, 36, 0.45); color: rgb(252, 211, 77); }
.dock-btn--caution:hover:not(:disabled) { border-color: rgba(251, 191, 36, 0.7); color: rgb(253, 230, 138); }

/* Long-running run cards — paused sub-agents waiting for "keep going / stop" */
.lrg-card {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.5rem 0.6rem;
  border: 1px solid rgba(251, 191, 36, 0.55);
  border-radius: var(--radius-xs);
  margin-bottom: 0.4rem;
  background: rgba(251, 191, 36, 0.08);
}
.lrg-info { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; }
.lrg-summary { font-family: var(--font-mono); font-size: 0.75rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lrg-reason { font-size: 0.72rem; color: rgb(252, 211, 77); }
.lrg-actions { display: flex; gap: 0.3rem; flex-wrap: wrap; }

.browser-row.waiting { border-color: rgba(251, 191, 36, 0.55); background: rgba(251, 191, 36, 0.08); }
.browser-info { display: flex; flex-direction: column; gap: 0.1rem; min-width: 0; }
.browser-page { font-size: 0.8rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.browser-state { font-size: 0.7rem; color: rgb(156, 163, 175); }
.browser-assist-reason { font-size: 0.72rem; color: rgb(252, 211, 77); }

/* Live browser modal */
.browser-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
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
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-3);
  color: rgb(229, 231, 235);
  overflow: hidden;
  outline: none;
}
.browser-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.5rem 0.6rem 0.5rem 0.9rem;
  border-bottom: 1px solid var(--hairline);
  font-weight: 600;
}
.browser-modal-body { overflow-y: auto; }
</style>
