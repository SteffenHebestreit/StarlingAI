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
      class="sp-handle"
      :class="{
        'sp-handle--open': modelValue,
        'sp-handle--live': hasLiveContent && !modelValue,
      }"
      :disabled="!hasContent"
      :aria-label="modelValue ? 'Close side panel' : 'Open side panel'"
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

    <!-- The drawer panel -->
    <div
      class="sp-panel"
      :class="{ 'sp-panel--open': modelValue }"
      role="complementary"
      aria-label="Live context and artifacts"
    >
      <!-- Header with tabs + close -->
      <div class="sp-header">
        <div class="sp-tabs" role="tablist">
          <button
            class="sp-tab"
            :class="{ 'sp-tab--active': activeTab === 'live' }"
            role="tab"
            :aria-selected="activeTab === 'live'"
            @click="activeTab = 'live'"
          >
            Live
            <span v-if="hasLiveContent" class="sp-tab__dot" aria-hidden="true" />
          </button>
          <button
            class="sp-tab"
            :class="{ 'sp-tab--active': activeTab === 'artifacts' }"
            :disabled="(artifactCount ?? 0) === 0"
            role="tab"
            :aria-selected="activeTab === 'artifacts'"
            @click="activeTab = 'artifacts'"
          >
            Artifacts
            <span v-if="(artifactCount ?? 0) > 0" class="sp-tab__badge">{{ artifactCount }}</span>
          </button>
        </div>

        <button
          class="sp-close-btn"
          aria-label="Close panel"
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
        <div v-show="activeTab === 'live'" class="sp-tab-pane">
          <slot name="live">
            <div class="sp-empty">
              <div class="sp-empty__icon" aria-hidden="true">◎</div>
              <p class="sp-empty__title">No live activity</p>
              <p class="sp-empty__hint">Swarm state, computer sessions, and shell logs will appear here during active work.</p>
            </div>
          </slot>
        </div>

        <!-- Artifacts tab -->
        <div v-show="activeTab === 'artifacts'" class="sp-tab-pane">
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
import { ref, computed } from "vue";

const props = defineProps<{
  /** Whether the panel is currently open */
  modelValue: boolean;
  /** Whether there is active live content (swarm, computer session, shell) */
  hasLiveContent?: boolean;
  /** Number of previewable artifacts in the current session */
  artifactCount?: number;
}>();

defineEmits<{
  "update:modelValue": [value: boolean];
}>();

const activeTab = ref<"live" | "artifacts">("live");

const hasContent = computed(() => props.hasLiveContent || (props.artifactCount ?? 0) > 0);
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
  right: 22rem; /* matches panel width */
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
  width: 22rem;
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
</style>
