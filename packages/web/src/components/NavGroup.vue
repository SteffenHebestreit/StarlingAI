<template>
  <div ref="rootRef" class="nav-group" @keydown="onKeyDown">
    <button
      ref="triggerRef"
      type="button"
      class="nav-group__trigger"
      :class="[isActive ? 'nav-group__trigger--active' : 'nav-group__trigger--idle']"
      :aria-expanded="open"
      :aria-haspopup="true"
      @click="toggle"
    >
      <span>{{ label }}</span>
      <svg class="nav-group__caret" :class="{ 'nav-group__caret--open': open }" viewBox="0 0 8 5" aria-hidden="true">
        <path d="M0 0l4 5 4-5z" fill="currentColor" />
      </svg>
      <span v-if="isActive" class="nav-group__active-bar" aria-hidden="true" />
    </button>

    <!--
      Teleport the popover to <body> so it escapes the parent <nav>'s
      overflow-x clip — without this, the dropdown gets cut off
      vertically because CSS coerces overflow-y to auto whenever
      overflow-x is set to anything other than visible.
    -->
    <Teleport to="body">
      <Transition name="nav-popover">
        <div
          v-if="open"
          ref="popoverRef"
          class="nav-group__popover"
          role="menu"
          :style="popoverStyle"
        >
          <RouterLink
            v-for="item in items"
            :key="item.to"
            :to="item.to"
            class="nav-group__item"
            :class="{ 'nav-group__item--active': route.path === item.to }"
            role="menuitem"
            @click="open = false"
          >
            <span class="nav-group__item-label">{{ item.label }}</span>
            <span v-if="item.hint" class="nav-group__item-hint">{{ item.hint }}</span>
          </RouterLink>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";

export interface NavGroupItem {
  to: string;
  label: string;
  hint?: string;
}

const props = defineProps<{ label: string; items: NavGroupItem[] }>();

const route = useRoute();
const rootRef = ref<HTMLElement | null>(null);
const triggerRef = ref<HTMLElement | null>(null);
const popoverRef = ref<HTMLElement | null>(null);
const open = ref(false);
const popoverStyle = ref<Record<string, string>>({});

const isActive = computed(() => props.items.some((item) => route.path === item.to));

function updatePopoverPosition(): void {
  const trigger = triggerRef.value;
  if (!trigger) return;
  const rect = trigger.getBoundingClientRect();
  // Anchor below the trigger.  Right-align so the popover stays inside the
  // viewport when the trigger sits near the right edge of the nav.
  const top = rect.bottom - 4;
  const right = window.innerWidth - rect.right;
  popoverStyle.value = {
    position: "fixed",
    top: `${top}px`,
    right: `${right}px`,
  };
}

function toggle(): void {
  open.value = !open.value;
  if (open.value) void nextTick(updatePopoverPosition);
}

function close(): void {
  open.value = false;
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key === "Escape") close();
}

function onClickOutside(event: MouseEvent): void {
  if (!open.value) return;
  const target = event.target as Node | null;
  if (!target) return;
  // Click on the trigger itself is handled by the toggle button — don't
  // double-fire.  Click inside the teleported popover is also fine; the
  // RouterLink's own @click handler closes it.
  if (rootRef.value?.contains(target)) return;
  if (popoverRef.value?.contains(target)) return;
  close();
}

function onResizeOrScroll(): void {
  // Recompute on resize so the popover stays anchored to the trigger; close
  // on outer scroll because the trigger's coords may have shifted off-
  // screen.  We only listen while open to keep the cost negligible.
  if (!open.value) return;
  updatePopoverPosition();
}

watch(() => route.path, () => { close(); });

onMounted(() => {
  window.addEventListener("click", onClickOutside, true);
  window.addEventListener("resize", onResizeOrScroll);
  window.addEventListener("scroll", onResizeOrScroll, true);
});

onBeforeUnmount(() => {
  window.removeEventListener("click", onClickOutside, true);
  window.removeEventListener("resize", onResizeOrScroll);
  window.removeEventListener("scroll", onResizeOrScroll, true);
});
</script>

<style>
/*
 * Popover styles live in the global stylesheet (no `scoped`) because
 * Vue's <Teleport to="body"> renders the popover outside this component's
 * DOM subtree, so scoped attribute-selectors on its children would not
 * match.  The selectors are namespaced under `.nav-group__popover` to
 * keep them out of other components' way.
 */
.nav-group__popover {
  min-width: 12rem;
  background: var(--surface-3);
  backdrop-filter: blur(10px);
  border: 1px solid rgba(var(--accent-purple), 0.25);
  border-radius: 12px;
  padding: 0.35rem;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  box-shadow: 0 24px 48px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(var(--accent-purple), 0.06);
  z-index: 60;
}

.nav-group__item {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.5rem 0.7rem;
  border-radius: 8px;
  font-size: 0.85rem;
  color: rgb(203 213 225);
  text-decoration: none;
  transition: background-color 100ms ease, color 100ms ease;
}

.nav-group__item:hover {
  background: rgba(var(--accent-purple), 0.18);
  color: rgb(241 245 249);
}

.nav-group__item--active {
  background: linear-gradient(90deg, rgba(var(--accent-purple), 0.22), rgba(var(--accent-pink), 0.18));
  color: rgb(var(--acc1-200));
}

.nav-group__item-label { font-weight: 500; }

.nav-group__item-hint {
  font-size: 0.7rem;
  color: rgb(148 163 184);
}

.nav-popover-enter-active,
.nav-popover-leave-active {
  transition: opacity 120ms ease, transform 120ms ease;
}

.nav-popover-enter-from,
.nav-popover-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>

<style scoped>
.nav-group {
  position: relative;
  display: inline-flex;
  align-items: stretch;
  flex-shrink: 0;
}

.nav-group__trigger {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 18px 0.625rem;
  font-size: 0.875rem;
  font-weight: 500;
  background: transparent;
  border: none;
  cursor: pointer;
  transition: color 120ms ease;
}

@media (min-width: 640px) {
  .nav-group__trigger { padding: 18px 0.75rem; }
}

.nav-group__trigger--idle { color: rgb(209 213 219); }
.nav-group__trigger--idle:hover { color: rgb(243 244 246); }
.nav-group__trigger--active { color: rgb(var(--acc1-300)); }

.nav-group__caret {
  width: 0.55rem;
  height: 0.4rem;
  transition: transform 120ms ease;
}

.nav-group__caret--open { transform: rotate(180deg); }

.nav-group__active-bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  border-radius: 2px 2px 0 0;
  background: linear-gradient(90deg, rgb(var(--accent-purple)), rgb(var(--accent-pink)));
}
</style>
