<template>
  <div ref="rootRef" class="nav-group" @keydown="onKeyDown">
    <button
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

    <Transition name="nav-popover">
      <div v-if="open" class="nav-group__popover" role="menu">
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
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";

export interface NavGroupItem {
  to: string;
  label: string;
  hint?: string;
}

const props = defineProps<{ label: string; items: NavGroupItem[] }>();

const route = useRoute();
const rootRef = ref<HTMLElement | null>(null);
const open = ref(false);

const isActive = computed(() => props.items.some((item) => route.path === item.to));

function toggle(): void {
  open.value = !open.value;
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key === "Escape") open.value = false;
}

function onClickOutside(event: MouseEvent): void {
  if (!open.value) return;
  if (!rootRef.value) return;
  if (rootRef.value.contains(event.target as Node)) return;
  open.value = false;
}

watch(() => route.path, () => { open.value = false; });

onMounted(() => { window.addEventListener("click", onClickOutside, true); });
onBeforeUnmount(() => { window.removeEventListener("click", onClickOutside, true); });
</script>

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

.nav-group__trigger--idle { color: rgb(156 163 175); }
.nav-group__trigger--idle:hover { color: rgb(229 231 235); }
.nav-group__trigger--active { color: rgb(216 180 254); }

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
  background: linear-gradient(90deg, rgb(168 85 247), rgb(236 72 153));
}

.nav-group__popover {
  position: absolute;
  top: calc(100% - 4px);
  right: 0;
  min-width: 11rem;
  background: rgba(15, 23, 42, 0.97);
  backdrop-filter: blur(10px);
  border: 1px solid rgba(168, 85, 247, 0.25);
  border-radius: 12px;
  padding: 0.35rem;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  box-shadow: 0 24px 48px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(168, 85, 247, 0.06);
  z-index: 30;
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
  background: rgba(124, 58, 237, 0.18);
  color: rgb(241 245 249);
}

.nav-group__item--active {
  background: linear-gradient(90deg, rgba(124, 58, 237, 0.22), rgba(217, 70, 239, 0.18));
  color: rgb(233 213 255);
}

.nav-group__item-label {
  font-weight: 500;
}

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
