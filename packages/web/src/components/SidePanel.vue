<template>
  <Teleport to="body">
    <!-- Scrim overlay (mobile / tablet) -->
    <Transition name="sp-scrim">
      <div
        v-if="modelValue"
        class="sp-scrim"
        aria-hidden="true"
        @click="$emit('update:modelValue', false)"
      />
    </Transition>

    <!-- Toggle handle — always visible on the right edge -->
    <button
      ref="handleEl"
      type="button"
      class="sp-handle"
      :class="{
        'sp-handle--open': modelValue,
        'sp-handle--live': hasLiveContent && !modelValue,
      }"
      :disabled="!hasContent"
      :aria-label="modelValue ? chatText.closePanel(lang) : chatText.openPanel(lang)"
      :title="modelValue ? chatText.closePanel(lang) : (hasAnything ? chatText.openPanel(lang) : chatText.panelEmpty(lang))"
      @click="$emit('update:modelValue', !modelValue)"
    >
      <!-- Chevron: points left when open, right when closed -->
      <svg
        class="sp-handle__chevron"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path :d="modelValue ? 'M6 3l5 5-5 5' : 'M10 3L5 8l5 5'" />
      </svg>
      <!-- Activity pulse dot shown when live content is available and panel is closed -->
      <span v-if="hasLiveContent && !modelValue" class="sp-handle__dot" aria-hidden="true" />
    </button>

    <!-- The drawer panel. Closed, it is only moved off-screen (so it can slide), which left its
         tabs, step rows and previews in the tab order and in front of screen readers: inert
         takes all of it out until the panel is open again. -->
    <div
      ref="panelEl"
      class="sp-panel"
      :class="{ 'sp-panel--open': modelValue }"
      role="complementary"
      aria-label="Live context and artifacts"
      :inert="!modelValue"
    >
      <!-- Header with tabs + close -->
      <div class="sp-header">
        <div ref="tablistEl" class="sp-tabs" role="tablist" @keydown="onTabKeydown">
          <button
            :id="`${uid}-tab-live`"
            type="button"
            class="sp-tab"
            :class="{ 'sp-tab--active': activeTab === 'live' }"
            role="tab"
            data-tab="live"
            :aria-selected="activeTab === 'live'"
            :aria-controls="`${uid}-pane-live`"
            @click="activeTab = 'live'"
          >
            {{ chatText.tabLive(lang) }}
            <span v-if="hasLiveContent" class="sp-tab__dot" aria-hidden="true" />
          </button>
          <button
            :id="`${uid}-tab-steps`"
            type="button"
            class="sp-tab"
            :class="{ 'sp-tab--active': activeTab === 'steps' }"
            :disabled="(stepCount ?? 0) === 0"
            role="tab"
            data-tab="steps"
            :aria-selected="activeTab === 'steps'"
            :aria-controls="`${uid}-pane-steps`"
            @click="activeTab = 'steps'"
          >
            {{ chatText.tabSteps(lang) }}
            <span v-if="(stepCount ?? 0) > 0" class="sp-tab__badge">{{ stepCount }}</span>
          </button>
          <button
            :id="`${uid}-tab-artifacts`"
            type="button"
            class="sp-tab"
            :class="{ 'sp-tab--active': activeTab === 'artifacts' }"
            :disabled="(artifactCount ?? 0) === 0"
            role="tab"
            data-tab="artifacts"
            :aria-selected="activeTab === 'artifacts'"
            :aria-controls="`${uid}-pane-artifacts`"
            @click="activeTab = 'artifacts'"
          >
            {{ chatText.tabArtifacts(lang) }}
            <span v-if="(artifactCount ?? 0) > 0" class="sp-tab__badge">{{ artifactCount }}</span>
          </button>
        </div>

        <button
          type="button"
          class="sp-close-btn"
          :aria-label="chatText.closePanel(lang)"
          @click="$emit('update:modelValue', false)"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <path d="M3 3l10 10M13 3L3 13" />
          </svg>
        </button>
      </div>

      <!-- Scrollable body -->
      <div class="sp-body">
        <!-- Live context tab -->
        <div v-show="activeTab === 'live'" :id="`${uid}-pane-live`" class="sp-tab-pane" role="tabpanel" :aria-labelledby="`${uid}-tab-live`">
          <slot name="live">
            <div class="sp-empty">
              <div class="sp-empty__icon" aria-hidden="true">◎</div>
              <p class="sp-empty__title">No live activity</p>
              <p class="sp-empty__hint">Swarm state, computer sessions, and shell logs will appear here during active work.</p>
            </div>
          </slot>
        </div>

        <!-- Steps tab — the execution detail for ONE message, handed in by the chat page -->
        <div v-show="activeTab === 'steps'" :id="`${uid}-pane-steps`" class="sp-tab-pane" role="tabpanel" :aria-labelledby="`${uid}-tab-steps`">
          <slot name="steps">
            <div class="sp-empty">
              <div class="sp-empty__icon" aria-hidden="true">≡</div>
              <p class="sp-empty__title">No step detail</p>
              <p class="sp-empty__hint">Open the details link on an answer to see what each step did.</p>
            </div>
          </slot>
        </div>

        <!-- Artifacts tab -->
        <div v-show="activeTab === 'artifacts'" :id="`${uid}-pane-artifacts`" class="sp-tab-pane" role="tabpanel" :aria-labelledby="`${uid}-tab-artifacts`">
          <slot name="artifacts">
            <div class="sp-empty">
              <div class="sp-empty__icon" aria-hidden="true">⬡</div>
              <p class="sp-empty__title">No artifacts yet</p>
              <p class="sp-empty__hint">Files, websites, and documents produced by agents will appear here.</p>
            </div>
          </slot>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { chatText } from "@/composables/chatText";
import type { TurnLanguage } from "@/composables/turnText";
import { ref, computed, nextTick, useId, watch } from "vue";
import { useEscapeToClose } from "@/composables/useEscapeToClose";

type PanelTab = "live" | "steps" | "artifacts";

const props = defineProps<{
  /** The language of the panel's own labels: the page's. */
  language?: TurnLanguage;
  /** Whether the panel is currently open */
  modelValue: boolean;
  /** Whether there is active live content (swarm, computer session, shell) */
  hasLiveContent?: boolean;
  /** Number of previewable artifacts in the current session */
  artifactCount?: number;
  /** Number of execution steps currently handed to the Steps tab (0 disables it) */
  stepCount?: number;
  /**
   * Lets a caller open the panel ON a chosen tab — a message bubble asking to show ITS steps
   * needs the panel to land there rather than on whatever was last viewed. Kept as a plain
   * prop watched into local state rather than a v-model, so existing call sites that only
   * pass `modelValue` keep working untouched.
   */
  requestedTab?: PanelTab | null;
}>();
const lang = computed<TurnLanguage>(() => props.language ?? "en");
/** Whether the panel has anything in it: its handle says why it is dimmed when it has not. */
const hasAnything = computed(() => Boolean(props.hasLiveContent) || (props.stepCount ?? 0) > 0 || (props.artifactCount ?? 0) > 0);

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
}>();

const activeTab = ref<PanelTab>("live");
const uid = useId();
const handleEl = ref<HTMLButtonElement | null>(null);
const panelEl = ref<HTMLElement | null>(null);
const tablistEl = ref<HTMLElement | null>(null);

useEscapeToClose(() => props.modelValue, () => emit("update:modelValue", false));

// A closed panel is inert, so the focus that was inside it (on its close button, say) would fall
// to <body>: the handle that opens it again takes it instead. Focus anywhere else stays put.
watch(() => props.modelValue, (open) => {
  if (!open && panelEl.value?.contains(document.activeElement)) handleEl.value?.focus({ preventScroll: true });
});

/** Left and Right move between the tabs that have something in them, like any tab list. */
function onTabKeydown(event: KeyboardEvent): void {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const enabled: PanelTab[] = ["live"];
  if ((props.stepCount ?? 0) > 0) enabled.push("steps");
  if ((props.artifactCount ?? 0) > 0) enabled.push("artifacts");
  const at = Math.max(enabled.indexOf(activeTab.value), 0);
  const next = enabled[(at + (event.key === "ArrowRight" ? 1 : enabled.length - 1)) % enabled.length]!;
  event.preventDefault();
  activeTab.value = next;
  void nextTick(() => tablistEl.value?.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus());
}

watch(() => props.requestedTab, (tab) => { if (tab) activeTab.value = tab; });

// If the steps tab is showing and its content goes away (a new turn clears the selection),
// fall back rather than stranding the reader on an empty pane they cannot leave by reading.
watch(() => props.stepCount ?? 0, (count) => {
  if (count === 0 && activeTab.value === "steps") activeTab.value = "live";
});

const hasContent = computed(() =>
  props.hasLiveContent || (props.artifactCount ?? 0) > 0 || (props.stepCount ?? 0) > 0);
</script>

<style scoped>
/* ── Scrim (mobile) ───────────────────────────────────────────────── */
.sp-scrim {
  position: fixed;
  inset: 0;
  /* above the floating HUD pods (220) so the open panel dims them too */
  z-index: 221;
  background: rgba(0, 0, 0, 0.52);
  backdrop-filter: blur(2px);
}

/* ── Handle (always-visible tab on the right edge) ────────────────── */
.sp-handle {
  position: fixed;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  z-index: 201;
  width: 1.625rem;
  height: 4.5rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  background: rgba(12, 8, 28, 0.94);
  border: 1px solid rgba(168, 85, 247, 0.22);
  border-right: none;
  border-radius: 0.5rem 0 0 0.5rem;
  color: rgb(167 139 250);
  cursor: pointer;
  transition:
    background 0.15s,
    border-color 0.15s,
    color 0.15s,
    right 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

/* 26px is narrow for a finger: the handle takes presses from 40px, at its visible size. Not
   while it is disabled, where the wider strip would only swallow clicks meant for the page. */
.sp-handle::before {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  right: 0;
  /* measured from inside the 1px border */
  left: calc(-0.875rem - 1px);
}
.sp-handle:disabled::before { display: none; }
/* It takes the focus when the panel closes, so it shows it. */
.sp-handle:focus-visible {
  outline: 2px solid rgba(var(--logo-cyan), 0.75);
  outline-offset: 2px;
}

.sp-handle:disabled {
  color: rgb(71 85 105);
  border-color: rgba(71, 85, 105, 0.25);
  cursor: not-allowed;
  opacity: 0.6;
}

.sp-handle:not(:disabled):hover {
  background: rgba(88, 28, 135, 0.5);
  border-color: rgba(168, 85, 247, 0.5);
  color: rgb(216 180 254);
}

/* When the panel is open, the handle moves to the panel's left edge and
   rises with it (closed it stays at 201, under the HUD pods). */
.sp-handle--open {
  right: min(22rem, calc(100vw - 1.75rem)); /* matches panel width */
  z-index: 223;
}

@media (min-width: 640px) {
  .sp-handle--open {
    right: 26rem; /* matches wider panel width on sm+ */
  }
}

.sp-handle__chevron {
  width: 0.85rem;
  height: 0.85rem;
}

.sp-handle__dot {
  width: 0.42rem;
  height: 0.42rem;
  border-radius: 50%;
  background: #a855f7;
  box-shadow: 0 0 5px #a855f7;
  animation: sp-dot-pulse 2s ease-in-out infinite;
}

@keyframes sp-dot-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%       { opacity: 0.55; transform: scale(0.75); }
}

/* ── Panel drawer ─────────────────────────────────────────────────── */
.sp-panel {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  /* above the floating HUD pods (220), below the nav scrim/panel (225/230) —
     the open drawer always covers the draggable toggles */
  z-index: 222;
  /* never wider than the screen less the handle: at 22rem flat it overflowed a small phone */
  width: min(22rem, calc(100vw - 1.75rem));
  display: flex;
  flex-direction: column;
  background: rgba(9, 6, 20, 0.98);
  border-left: 1px solid rgba(168, 85, 247, 0.22);
  box-shadow: -10px 0 40px rgba(0, 0, 0, 0.55);
  transform: translateX(100%);
  transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  will-change: transform;
}

.sp-panel--open {
  transform: translateX(0);
}

@media (min-width: 640px) {
  .sp-panel {
    width: 26rem;
  }
}

/* ── Header ───────────────────────────────────────────────────────── */
.sp-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 0.75rem 0;
  flex-shrink: 0;
}

.sp-tabs {
  flex: 1;
  display: flex;
  gap: 0.25rem;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 0.75rem;
  padding: 0.2rem;
}

.sp-tab {
  flex: 1;
  padding: 0.3rem 0.5rem;
  border-radius: 0.55rem;
  font-size: 0.75rem;
  font-weight: 500;
  letter-spacing: 0.04em;
  color: rgb(100 116 139);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
  white-space: nowrap;
}

.sp-tab:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.sp-tab--active {
  background: rgba(88, 28, 135, 0.45);
  color: rgb(216 180 254);
}

.sp-tab:not(:disabled):not(.sp-tab--active):hover {
  background: rgba(255, 255, 255, 0.06);
  color: rgb(148 163 184);
}

.sp-tab__dot {
  width: 0.38rem;
  height: 0.38rem;
  border-radius: 50%;
  background: #a855f7;
  box-shadow: 0 0 4px #a855f7;
  flex-shrink: 0;
}

.sp-tab__badge {
  font-size: 0.62rem;
  background: rgba(168, 85, 247, 0.32);
  color: rgb(192 132 252);
  padding: 0.04rem 0.35rem;
  border-radius: 999px;
  min-width: 1.15rem;
  text-align: center;
  flex-shrink: 0;
}

/* Close button */
.sp-close-btn {
  position: relative;
  flex-shrink: 0;
  width: 1.75rem;
  height: 1.75rem;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 0.45rem;
  color: rgb(100 116 139);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

/* 28px to look at, 40px to hit. */
.sp-close-btn::before {
  content: "";
  position: absolute;
  inset: -0.375rem;
}

.sp-close-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  color: rgb(226 232 240);
}

.sp-close-btn svg {
  width: 0.875rem;
  height: 0.875rem;
}

/* ── Body ─────────────────────────────────────────────────────────── */
.sp-body {
  flex: 1;
  min-height: 0;
  padding: 0.75rem;
  position: relative;
}

.sp-tab-pane {
  position: absolute;
  inset: 0.75rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.875rem;
  /* Custom scrollbar */
  scrollbar-width: thin;
  scrollbar-color: rgba(168, 85, 247, 0.25) transparent;
}

.sp-tab-pane::-webkit-scrollbar {
  width: 4px;
}

.sp-tab-pane::-webkit-scrollbar-track {
  background: transparent;
}

.sp-tab-pane::-webkit-scrollbar-thumb {
  background: rgba(168, 85, 247, 0.25);
  border-radius: 2px;
}

/* ── Empty state ──────────────────────────────────────────────────── */
.sp-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 2.5rem 1.5rem;
  gap: 0.6rem;
  color: rgb(71 85 105);
  flex: 1;
}

.sp-empty__icon {
  font-size: 1.75rem;
  opacity: 0.4;
  line-height: 1;
}

.sp-empty__title {
  font-size: 0.85rem;
  font-weight: 500;
  color: rgb(100 116 139);
  margin: 0;
}

.sp-empty__hint {
  font-size: 0.78rem;
  line-height: 1.55;
  margin: 0;
}

/* ── Scrim transition ─────────────────────────────────────────────── */
.sp-scrim-enter-active,
.sp-scrim-leave-active {
  transition: opacity 0.3s ease;
}

.sp-scrim-enter-from,
.sp-scrim-leave-to {
  opacity: 0;
}

/* Reduced motion: the drawer and its handle are simply there or not, and the live dot holds still. */
@media (prefers-reduced-motion: reduce) {
  .sp-panel { transition: none; }
  .sp-handle { transition: background 0.15s, border-color 0.15s, color 0.15s; }
  .sp-handle__dot { animation: none; }
}
</style>
