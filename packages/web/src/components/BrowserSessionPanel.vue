<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted, nextTick } from "vue";
import RFB from "@novnc/novnc";
import { useBrowserStore } from "../stores/browser";
import { useFullscreen } from "../composables/useFullscreen";

const browser = useBrowserStore();

const vncStage = ref<HTMLElement | null>(null);
const { isFullscreen, toggle: toggleFullscreen } = useFullscreen(vncStage);

type VncStatus = "idle" | "connecting" | "connected" | "disconnected" | "error" | "auth_required";
const vncStatus = ref<VncStatus>("idle");
const vncDetail = ref<string>("");
const resolving = ref(false);

const sessions = computed(() => browser.sessions);
const observedId = computed(() => browser.observedSessionId);
const observed = computed(() => browser.observedSession);
const needsAssist = computed(() => observed.value?.state === "assist_requested");

let rfb: RFB | null = null;

function onConnect() { vncStatus.value = "connected"; vncDetail.value = ""; }
function onDisconnect(ev: Event) {
  const detail = (ev as CustomEvent<{ clean?: boolean; reason?: string }>).detail;
  vncStatus.value = "disconnected";
  vncDetail.value = detail?.reason || "";
}
function onSecurityFailure(ev: Event) {
  const detail = (ev as CustomEvent<{ status?: number; reason?: string }>).detail;
  vncStatus.value = "error";
  vncDetail.value = detail?.reason || `security failure (status ${detail?.status ?? "?"})`;
}
// If x11vnc is ever (re)configured to require a password, RFB will fire this
// instead of `connect` and otherwise hang silently. Surfacing it as a status
// makes the misconfig visible instead of presenting "connecting" forever.
function onCredentialsRequired() {
  vncStatus.value = "auth_required";
  vncDetail.value = "browser-vnc is asking for credentials — disable VNC password (the gateway already authenticates)";
}

function teardown() {
  if (rfb) {
    try {
      rfb.removeEventListener("connect", onConnect);
      rfb.removeEventListener("disconnect", onDisconnect);
      rfb.removeEventListener("securityfailure", onSecurityFailure);
      rfb.removeEventListener("credentialsrequired", onCredentialsRequired);
      rfb.disconnect();
    } catch { /* already gone */ }
    rfb = null;
  }
  // RFB injects a canvas into the stage; clear it so a stale frame doesn't linger.
  if (vncStage.value) vncStage.value.innerHTML = "";
}

function connect() {
  teardown();
  const id = observedId.value;
  if (!id || !browser.enabled || !vncStage.value) {
    vncStatus.value = "idle";
    return;
  }
  // Don't open a doomed WebSocket when the gateway already told us the
  // backend port is down — that's the original "connecting forever" trap.
  if (!browser.reachable) {
    vncStatus.value = "error";
    vncDetail.value = "browser-vnc container not reachable on the docker network";
    return;
  }
  vncStatus.value = "connecting";
  try {
    const client = new RFB(vncStage.value, browser.buildVncUrl(id), { shared: true });
    client.scaleViewport = true;   // fit the headed 1600x900 Chrome into the panel
    client.resizeSession = false;  // don't ask the fixed Xvfb display to resize
    client.viewOnly = false;       // interactive — the human must click the CAPTCHA
    client.background = "#0b0e14";
    client.addEventListener("connect", onConnect);
    client.addEventListener("disconnect", onDisconnect);
    client.addEventListener("securityfailure", onSecurityFailure);
    client.addEventListener("credentialsrequired", onCredentialsRequired);
    rfb = client;
  } catch {
    vncStatus.value = "error";
  }
}

function observe(id: string) {
  browser.observeSession(id);
}

async function resolveAssist() {
  const id = observedId.value;
  if (!id) return;
  resolving.value = true;
  try {
    await browser.resolveAssist(id);
  } finally {
    resolving.value = false;
  }
}

// Reconnect whenever the observed session changes or the feature toggles on.
// Reachability is included so the panel auto-recovers when the backend comes
// back online (e.g. after a browser-vnc restart). flush:"post" so the stage
// element is in the DOM before we attach RFB.
watch(
  () => [observedId.value, browser.enabled, browser.reachable] as const,
  () => { void nextTick(connect); },
  { flush: "post" },
);

onMounted(() => { void nextTick(connect); });
onUnmounted(teardown);
</script>

<template>
  <div v-if="browser.enabled" class="browser-session-panel">
    <div class="panel-header">
      <h3>Browser Session</h3>
      <button class="btn-sm" @click="browser.fetchSessions()">Refresh</button>
    </div>

    <!-- Assist banner — the whole point: a human is needed right now -->
    <div v-if="needsAssist" class="assist-banner">
      <div class="assist-text">
        <strong>Your help is needed.</strong>
        <span>{{ observed?.assistReason || "Solve the challenge in the browser below, then continue." }}</span>
        <span v-if="observed?.page" class="assist-page">on {{ observed.page }}</span>
      </div>
      <button class="btn-resolve" :disabled="resolving" @click="resolveAssist">
        {{ resolving ? "Resuming…" : "I solved it — continue" }}
      </button>
    </div>

    <!-- Session switcher (usually one session) -->
    <div v-if="sessions.length > 1" class="session-list">
      <button
        v-for="s in sessions"
        :key="s.id"
        class="session-chip"
        :class="{ observed: observedId === s.id, waiting: s.state === 'assist_requested' }"
        @click="observe(s.id)"
      >
        {{ s.page || s.agentName }} · {{ s.state.replace("_", " ") }}
      </button>
    </div>

    <!-- Live, clickable browser -->
    <div v-if="observedId" class="live-view-header">
      <h4>
        Live Browser
        <span class="vnc-status" :class="vncStatus" :title="vncDetail">{{ vncStatus }}</span>
        <span v-if="vncDetail" class="vnc-detail">{{ vncDetail }}</span>
      </h4>
      <button class="btn-sm btn-fullscreen" :title="isFullscreen ? 'Exit fullscreen' : 'Fullscreen'" @click="toggleFullscreen">
        {{ isFullscreen ? "⤡ Exit fullscreen" : "⤢ Fullscreen" }}
      </button>
    </div>
    <div v-if="observedId" ref="vncStage" class="vnc-stage" />
    <p v-if="observedId" class="vnc-help">
      This is the real browser the agent is driving. Click and type directly to solve a CAPTCHA or sign in,
      then press “I solved it — continue”.
    </p>

    <div v-else class="empty-state">
      No active browser session. The live preview appears here when the agent opens a browser.
    </div>
  </div>
</template>

<style scoped>
.browser-session-panel {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1rem;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.panel-header h3 {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
}

.empty-state {
  color: var(--color-text-muted, #888);
  font-style: italic;
  padding: 1rem 0;
}

/* Assist banner — high-visibility call to action */
.assist-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  border: 1px solid #ffb300;
  border-radius: 8px;
  background: rgba(255, 179, 0, 0.12);
  animation: assist-pulse 2s ease-in-out infinite;
}

.assist-text {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  font-size: 0.85rem;
}

.assist-text strong { color: #ffb300; }
.assist-page { color: var(--color-text-muted, #888); font-size: 0.78rem; }

.btn-resolve {
  flex-shrink: 0;
  font-size: 0.85rem;
  font-weight: 600;
  padding: 0.5rem 0.9rem;
  border-radius: 6px;
  border: 1px solid #4caf50;
  background: #4caf50;
  color: #06210a;
  cursor: pointer;
}
.btn-resolve:hover:not(:disabled) { background: #5cca5e; }
.btn-resolve:disabled { opacity: 0.6; cursor: default; }

@keyframes assist-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(255, 179, 0, 0.0); }
  50% { box-shadow: 0 0 0 4px rgba(255, 179, 0, 0.18); }
}

.session-list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.session-chip {
  font-size: 0.75rem;
  padding: 0.25rem 0.6rem;
  border-radius: 999px;
  border: 1px solid var(--color-border, #444);
  background: var(--color-bg-tertiary, #252525);
  color: var(--color-text, #eee);
  cursor: pointer;
}
.session-chip.observed { border-color: #2196f3; color: #2196f3; }
.session-chip.waiting { border-color: #ffb300; color: #ffb300; }

.live-view-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.live-view-header h4 {
  margin: 0;
  font-size: 0.9rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.vnc-status {
  font-size: 0.7rem;
  text-transform: uppercase;
  padding: 0.1rem 0.4rem;
  border-radius: 3px;
  color: var(--color-text-muted, #888);
}
.vnc-status.connected { color: #4caf50; }
.vnc-status.connecting { color: #ff9800; }
.vnc-status.error { color: #f44336; }
.vnc-status.auth_required { color: #f44336; }

.vnc-detail {
  font-size: 0.7rem;
  color: var(--color-text-muted, #888);
  font-weight: normal;
}

.btn-fullscreen { white-space: nowrap; }

.vnc-stage {
  width: 100%;
  height: 460px;
  background: #0b0e14;
  border: 1px solid var(--color-border, #333);
  border-radius: 6px;
  overflow: hidden;
}

/* In fullscreen the stage fills the screen on a black backdrop. */
.vnc-stage:fullscreen {
  width: 100vw;
  height: 100vh;
  border: none;
  border-radius: 0;
  background: #000;
}

.vnc-help {
  margin: 0;
  color: var(--color-text-muted, #888);
  font-size: 0.78rem;
}

.btn-sm {
  font-size: 0.75rem;
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
  border: 1px solid var(--color-border, #444);
  background: var(--color-bg-tertiary, #252525);
  color: var(--color-text, #eee);
  cursor: pointer;
}
.btn-sm:hover { background: var(--color-bg-hover, #333); }
</style>
