<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from "vue";
import { useComputerStore, type ComputerMonitorInfo } from "../stores/computer";

const computer = useComputerStore();

// Tick counter to force re-evaluation of age-based computed properties
const _markerTick = ref(0);
const _markerTimer = setInterval(() => { _markerTick.value++; }, 500);
onUnmounted(() => clearInterval(_markerTimer));

const sessions = computed(() => computer.sessions);
const activeSessions = computed(() => computer.activeSessions);
const screenshot = computed(() => computer.latestScreenshot);
const observing = computed(() => computer.observedSessionId);
const previewSessionId = computed(() => observing.value);
const recentActions = computed(() => computer.recentActions
  .filter((action) => !previewSessionId.value || action.computerSessionId === previewSessionId.value)
  .slice(-10)
  .reverse());

/** Agent action markers — show where the agent clicked/scrolled on screen */
interface AgentActionMarker {
  percentX: number;
  percentY: number;
  actionType: string;
  age: number; // ms since the action
}

const agentActionMarkers = computed<AgentActionMarker[]>(() => {
  void _markerTick.value; // trigger reactivity on timer tick
  if (!screenshot.value) return [];
  const now = Date.now();
  const maxAge = 12_000; // show markers for up to 12 seconds
  return computer.recentActions
    .filter((a) => {
      if (previewSessionId.value && a.computerSessionId !== previewSessionId.value) return false;
      const age = now - a.timestamp;
      if (age > maxAge) return false;
      const x = Number(a.detail?.x);
      const y = Number(a.detail?.y);
      return (a.actionType === "click" || a.actionType === "scroll" || a.actionType === "drag")
        && Number.isFinite(x) && Number.isFinite(y);
    })
    .map((a) => ({
      percentX: (Number(a.detail!.x) / screenshot.value!.width) * 100,
      percentY: (Number(a.detail!.y) / screenshot.value!.height) * 100,
      actionType: a.actionType,
      age: now - a.timestamp,
    }));
});

const screenshotAge = computed<string>(() => {
  void _markerTick.value; // re-evaluate on timer tick
  if (!screenshot.value?.timestamp) return "";
  const ageMs = Date.now() - screenshot.value.timestamp;
  if (ageMs < 1_500) return "live";
  if (ageMs < 60_000) return `${Math.round(ageMs / 1000)}s ago`;
  return `${Math.round(ageMs / 60_000)}m ago`;
});
const screenshotImage = ref<HTMLImageElement | null>(null);
const copyStatus = ref("");
const mappedClick = ref<{
  desktopX: number;
  desktopY: number;
  renderedX: number;
  renderedY: number;
  normalizedX: number;
  normalizedY: number;
  percentX: number;
  percentY: number;
  monitor?: ComputerMonitorInfo;
  monitorLocalX?: number;
  monitorLocalY?: number;
} | null>(null);

const clickCommand = computed(() => {
  if (!mappedClick.value || !previewSessionId.value) return "";
  return `computer_click({ sessionId: \"${previewSessionId.value}\", x: ${mappedClick.value.desktopX}, y: ${mappedClick.value.desktopY} })`;
});

watch(screenshot, () => {
  mappedClick.value = null;
  copyStatus.value = "";
});

function observe(sessionId: string) {
  computer.observeSession(sessionId);
}

function stopObserving() {
  computer.observeSession(null);
}

function emergencyStop(sessionId: string) {
  computer.emergencyStop(sessionId);
}

function refresh() {
  computer.fetchSessions();
}

function findMonitorForPoint(x: number, y: number): ComputerMonitorInfo | undefined {
  return screenshot.value?.displayTopology?.monitors.find((monitor) => (
    x >= monitor.x &&
    x < monitor.x + monitor.width &&
    y >= monitor.y &&
    y < monitor.y + monitor.height
  ));
}

function inspectClick(event: MouseEvent) {
  if (!screenshot.value || !screenshotImage.value) return;
  const rect = screenshotImage.value.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;

  const renderedX = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
  const renderedY = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
  const normalizedX = renderedX / rect.width;
  const normalizedY = renderedY / rect.height;
  const desktopX = Math.round(normalizedX * screenshot.value.width);
  const desktopY = Math.round(normalizedY * screenshot.value.height);
  const monitor = findMonitorForPoint(desktopX, desktopY);

  mappedClick.value = {
    desktopX,
    desktopY,
    renderedX,
    renderedY,
    normalizedX,
    normalizedY,
    percentX: normalizedX * 100,
    percentY: normalizedY * 100,
    monitor,
    monitorLocalX: monitor ? desktopX - monitor.x : undefined,
    monitorLocalY: monitor ? desktopY - monitor.y : undefined,
  };
  copyStatus.value = "";
}

async function copyClickCommand() {
  if (!clickCommand.value || typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    copyStatus.value = "Clipboard unavailable";
    return;
  }
  await navigator.clipboard.writeText(clickCommand.value);
  copyStatus.value = "Copied";
}
</script>

<template>
  <div class="computer-session-panel">
    <div class="panel-header">
      <h3>Computer Sessions</h3>
      <button class="btn-sm" @click="refresh">Refresh</button>
    </div>

    <!-- No sessions -->
    <div v-if="!computer.loading && sessions.length === 0" class="empty-state">
      No computer sessions active
    </div>
    <div v-else-if="computer.loading && sessions.length === 0" class="empty-state">
      Loading computer sessions...
    </div>

    <!-- Session list -->
    <div v-else class="session-list">
      <div
        v-for="session in sessions"
        :key="session.id"
        class="session-card"
        :class="{ active: session.state === 'active', observed: observing === session.id }"
      >
        <div class="session-info">
          <span class="session-id">{{ session.id.slice(0, 12) }}</span>
          <span class="session-adapter">{{ session.adapter }}</span>
          <span class="session-state" :class="session.state">{{ session.state }}</span>
        </div>
        <div class="session-actions">
          <button
            v-if="session.state === 'active' && observing !== session.id"
            class="btn-sm btn-observe"
            @click="observe(session.id)"
          >
            Observe
          </button>
          <button
            v-if="observing === session.id"
            class="btn-sm btn-stop-observe"
            @click="stopObserving()"
          >
            Stop Observing
          </button>
          <button
            v-if="session.state === 'active'"
            class="btn-sm btn-emergency"
            @click="emergencyStop(session.id)"
          >
            Emergency Stop
          </button>
        </div>
      </div>
    </div>

    <!-- Screenshot viewer -->
    <div v-if="previewSessionId && screenshot" class="screenshot-viewer">
      <h4>Live View — {{ previewSessionId.slice(0, 12) }}</h4>
      <p class="screenshot-help">
        Live preview updates automatically. Click anywhere on the screenshot to inspect the mapped desktop coordinates.
      </p>
      <div class="screenshot-stage" @click="inspectClick">
        <img
          ref="screenshotImage"
          :src="screenshot.dataUrl"
          :width="screenshot.width"
          :height="screenshot.height"
          class="screenshot-img"
          alt="Computer session screenshot"
        />
        <div
          v-if="mappedClick"
          class="click-marker"
          :style="{ left: `${mappedClick.percentX}%`, top: `${mappedClick.percentY}%` }"
        />
        <!-- Agent action markers (clicks, scrolls, drags) -->
        <div
          v-for="(marker, i) in agentActionMarkers"
          :key="`am-${i}`"
          class="agent-action-marker"
          :class="marker.actionType"
          :style="{
            left: `${marker.percentX}%`,
            top: `${marker.percentY}%`,
            opacity: Math.max(0.15, 1 - marker.age / 12000),
          }"
        >
          <span class="agent-action-label">{{ marker.actionType }}</span>
        </div>
      </div>
      <div class="screenshot-meta">
        <span>Frame: {{ screenshot.frameId ? screenshot.frameId.slice(0, 8) : "n/a" }}</span>
        <span>Bitmap: {{ screenshot.width }} x {{ screenshot.height }}</span>
        <span v-if="screenshot.displayTopology">Monitors: {{ screenshot.displayTopology.monitors.length }}</span>
        <span class="screenshot-age">{{ screenshotAge }}</span>
      </div>
      <div v-if="mappedClick" class="click-inspector">
        <div class="click-inspector-header">
          <h5>Click Inspector</h5>
          <button class="btn-sm btn-copy" @click="copyClickCommand">Copy Command</button>
        </div>
        <div class="click-grid">
          <span>Desktop</span>
          <span>{{ mappedClick.desktopX }}, {{ mappedClick.desktopY }}</span>
          <span>Rendered</span>
          <span>{{ Math.round(mappedClick.renderedX) }}, {{ Math.round(mappedClick.renderedY) }}</span>
          <span>Normalized</span>
          <span>{{ mappedClick.normalizedX.toFixed(4) }}, {{ mappedClick.normalizedY.toFixed(4) }}</span>
          <span>Monitor</span>
          <span>{{ mappedClick.monitor ? `${mappedClick.monitor.id} (${mappedClick.monitor.x}, ${mappedClick.monitor.y} ${mappedClick.monitor.width}x${mappedClick.monitor.height})` : "none" }}</span>
          <template v-if="mappedClick.monitor">
            <span>Monitor-local</span>
            <span>{{ mappedClick.monitorLocalX }}, {{ mappedClick.monitorLocalY }}</span>
          </template>
        </div>
        <code class="click-command">{{ clickCommand }}</code>
        <div v-if="copyStatus" class="copy-status">{{ copyStatus }}</div>
      </div>
      <div v-if="screenshot.activeWindow" class="active-window">
        <h5>Active Window</h5>
        <div>{{ screenshot.activeWindow.title || "Untitled window" }}</div>
        <div class="window-subline">{{ screenshot.activeWindow.processName }} · {{ screenshot.activeWindow.bounds.x }}, {{ screenshot.activeWindow.bounds.y }} · {{ screenshot.activeWindow.bounds.width }}x{{ screenshot.activeWindow.bounds.height }}</div>
      </div>
      <div v-if="screenshot.displayTopology" class="monitor-list">
        <h5>Display Topology</h5>
        <ul>
          <li v-for="monitor in screenshot.displayTopology.monitors" :key="monitor.id" class="monitor-item">
            <span>Monitor {{ monitor.id }}<span v-if="monitor.id === screenshot.displayTopology.primary"> (primary)</span></span>
            <span>{{ monitor.x }}, {{ monitor.y }} · {{ monitor.width }}x{{ monitor.height }} · dpi {{ monitor.dpiScale }}</span>
          </li>
        </ul>
      </div>
    </div>
    <div v-else-if="previewSessionId" class="empty-state">
      Waiting for the next screenshot from {{ previewSessionId.slice(0, 12) }}...
    </div>
    <div v-else-if="sessions.length > 0" class="empty-state">
      Observe a session to start the live preview.
    </div>

    <!-- Recent actions -->
    <div v-if="previewSessionId && recentActions.length > 0" class="recent-actions">
      <h4>Recent Actions</h4>
      <ul>
        <li v-for="(action, i) in recentActions" :key="i" class="action-item">
          <span class="action-type">{{ action.actionType }}</span>
          <span v-if="action.detail?.x != null" class="action-coords">({{ action.detail.x }}, {{ action.detail.y }})</span>
          <span class="action-time">{{ new Date(action.timestamp).toLocaleTimeString() }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.computer-session-panel {
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

.session-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.session-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--color-border, #333);
  border-radius: 6px;
  background: var(--color-bg-secondary, #1a1a1a);
}

.session-card.active {
  border-color: var(--color-success, #4caf50);
}

.session-card.observed {
  border-color: var(--color-primary, #2196f3);
  background: var(--color-bg-highlight, #1e2a3a);
}

.session-info {
  display: flex;
  gap: 0.75rem;
  align-items: center;
}

.session-id {
  font-family: monospace;
  font-size: 0.85rem;
}

.session-adapter {
  font-size: 0.8rem;
  color: var(--color-text-muted, #888);
}

.session-state {
  font-size: 0.75rem;
  padding: 0.1rem 0.4rem;
  border-radius: 3px;
  text-transform: uppercase;
}

.session-state.active { color: #4caf50; }
.session-state.idle { color: #ff9800; }
.session-state.stopped { color: #f44336; }
.session-state.error { color: #f44336; }

.session-actions {
  display: flex;
  gap: 0.5rem;
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

.btn-sm:hover {
  background: var(--color-bg-hover, #333);
}

.btn-emergency {
  border-color: #f44336;
  color: #f44336;
}

.btn-emergency:hover {
  background: rgba(244, 67, 54, 0.15);
}

.btn-observe {
  border-color: #2196f3;
  color: #2196f3;
}

.btn-stop-observe {
  border-color: #ff9800;
  color: #ff9800;
}

.screenshot-viewer {
  margin-top: 0.5rem;
}

.screenshot-viewer h4 {
  margin: 0 0 0.5rem;
  font-size: 0.9rem;
}

.screenshot-help {
  margin: 0 0 0.5rem;
  color: var(--color-text-muted, #888);
  font-size: 0.8rem;
}

.screenshot-stage {
  position: relative;
  display: inline-block;
  max-width: 100%;
  cursor: crosshair;
}

.screenshot-img {
  display: block;
  max-width: 100%;
  border-radius: 4px;
  border: 1px solid var(--color-border, #333);
}

.click-marker {
  position: absolute;
  width: 14px;
  height: 14px;
  border: 2px solid #ff7043;
  border-radius: 999px;
  transform: translate(-50%, -50%);
  pointer-events: none;
  box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.45);
}

.agent-action-marker {
  position: absolute;
  width: 20px;
  height: 20px;
  border-radius: 999px;
  transform: translate(-50%, -50%);
  pointer-events: none;
  border: 2px solid #00e5ff;
  box-shadow: 0 0 8px rgba(0, 229, 255, 0.6), 0 0 0 2px rgba(0, 0, 0, 0.5);
  animation: agent-marker-pulse 1.2s ease-out;
}

.agent-action-marker.click {
  border-color: #00e5ff;
  box-shadow: 0 0 8px rgba(0, 229, 255, 0.6), 0 0 0 2px rgba(0, 0, 0, 0.5);
}

.agent-action-marker.scroll {
  border-color: #76ff03;
  box-shadow: 0 0 8px rgba(118, 255, 3, 0.5), 0 0 0 2px rgba(0, 0, 0, 0.5);
  width: 16px;
  height: 16px;
}

.agent-action-marker.drag {
  border-color: #ffab40;
  box-shadow: 0 0 8px rgba(255, 171, 64, 0.5), 0 0 0 2px rgba(0, 0, 0, 0.5);
}

.agent-action-label {
  position: absolute;
  top: -18px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 0.6rem;
  font-family: monospace;
  color: #fff;
  background: rgba(0, 0, 0, 0.7);
  padding: 1px 4px;
  border-radius: 3px;
  white-space: nowrap;
}

@keyframes agent-marker-pulse {
  0% {
    transform: translate(-50%, -50%) scale(2);
    opacity: 0.3;
  }
  30% {
    transform: translate(-50%, -50%) scale(1);
    opacity: 1;
  }
  100% {
    transform: translate(-50%, -50%) scale(1);
    opacity: 1;
  }
}

.screenshot-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-top: 0.5rem;
  font-size: 0.78rem;
  color: var(--color-text-muted, #888);
}

.screenshot-age {
  color: var(--color-success, #4caf50);
  font-weight: 500;
}

.click-inspector,
.active-window,
.monitor-list {
  margin-top: 0.75rem;
  padding: 0.75rem;
  border: 1px solid var(--color-border, #333);
  border-radius: 6px;
  background: var(--color-bg-secondary, #1a1a1a);
}

.click-inspector-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.click-inspector h5,
.active-window h5,
.monitor-list h5 {
  margin: 0;
  font-size: 0.85rem;
}

.click-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.3rem 0.75rem;
  font-size: 0.8rem;
}

.click-command {
  display: block;
  margin-top: 0.75rem;
  padding: 0.5rem;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.25);
  overflow-x: auto;
  font-size: 0.78rem;
}

.copy-status,
.window-subline {
  margin-top: 0.4rem;
  color: var(--color-text-muted, #888);
  font-size: 0.78rem;
}

.monitor-list ul {
  list-style: none;
  margin: 0.5rem 0 0;
  padding: 0;
}

.monitor-item {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.25rem 0;
  font-size: 0.8rem;
  border-bottom: 1px solid var(--color-border-light, #222);
}

.monitor-item:last-child {
  border-bottom: 0;
}

.btn-copy {
  border-color: #ff7043;
  color: #ff7043;
}

.recent-actions h4 {
  margin: 0 0 0.25rem;
  font-size: 0.9rem;
}

.recent-actions ul {
  list-style: none;
  padding: 0;
  margin: 0;
}

.action-item {
  display: flex;
  justify-content: space-between;
  padding: 0.2rem 0;
  font-size: 0.8rem;
  border-bottom: 1px solid var(--color-border-light, #222);
}

.action-type {
  font-family: monospace;
}

.action-coords {
  font-family: monospace;
  font-size: 0.75rem;
  color: #00e5ff;
}

.action-time {
  color: var(--color-text-muted, #888);
}
</style>
