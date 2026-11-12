<template>
  <!-- The command palette: any page or common action, a few letters away (Ctrl/Cmd+K). The
       navigation is two levels deep behind a burger; this is the short way round it. -->
  <Teleport to="body">
    <Transition name="palette">
      <div v-if="open" class="palette-overlay z-modal" @click.self="emit('close')">
        <div class="palette glass-card modal-pop" role="dialog" aria-modal="true" aria-label="Command palette">
          <div class="palette__field">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="palette__icon" aria-hidden="true">
              <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />
            </svg>
            <input
              ref="inputEl"
              v-model="query"
              type="text"
              class="palette__input"
              placeholder="Go to a page or run an action…"
              role="combobox"
              aria-expanded="true"
              aria-controls="palette-list"
              :aria-activedescendant="matches[selected] ? `palette-item-${matches[selected]!.id}` : undefined"
              autocomplete="off"
              spellcheck="false"
              @keydown="onKeydown"
            />
            <kbd class="palette__kbd">Esc</kbd>
          </div>

          <ul id="palette-list" ref="listEl" class="palette__list" role="listbox" aria-label="Commands">
            <li
              v-for="(command, index) in matches"
              :id="`palette-item-${command.id}`"
              :key="command.id"
              role="option"
              class="palette__item"
              :class="index === selected ? 'palette__item--selected' : ''"
              :aria-selected="index === selected"
              @mousemove="selected = index"
              @click="choose(command)"
            >
              <span class="palette__group">{{ command.group }}</span>
              <span class="palette__text">
                <span class="palette__label">{{ command.label }}</span>
                <span v-if="command.hint" class="palette__hint">{{ command.hint }}</span>
              </span>
              <span v-if="command.to && command.to === currentPath" class="palette__here">You are here</span>
            </li>
            <li v-if="matches.length === 0" class="palette__empty" role="presentation">
              Nothing matches “{{ query.trim() }}”.
            </li>
          </ul>

          <div class="palette__foot" aria-hidden="true">
            <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
            <span><kbd>Enter</kbd> open</span>
            <span><kbd>Esc</kbd> close</span>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { filterCommands, moveSelection, type PaletteCommand } from "@/composables/commandPalette";
import { useEscapeToClose } from "@/composables/useEscapeToClose";

const props = defineProps<{
  open: boolean;
  commands: PaletteCommand[];
  /** The route on screen, to mark its own row. */
  currentPath: string;
}>();
const emit = defineEmits<{ (event: "close"): void; (event: "choose", command: PaletteCommand): void }>();

const query = ref("");
const selected = ref(0);
const inputEl = ref<HTMLInputElement | null>(null);
const listEl = ref<HTMLElement | null>(null);
/** What had the focus before the palette, to hand it back when it closes without a choice. */
let opener: HTMLElement | null = null;

const matches = computed(() => filterCommands(props.commands, query.value));

watch(() => props.open, (open) => {
  if (open) {
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    query.value = "";
    selected.value = 0;
    void nextTick(() => inputEl.value?.focus());
  } else {
    if (opener?.isConnected) opener.focus({ preventScroll: true });
    opener = null;
  }
});
// A new query starts at its best match.
watch(query, () => { selected.value = 0; });
// Keep the highlighted row in view when the keyboard walks off the visible part of the list.
watch(selected, () => {
  void nextTick(() => listEl.value?.querySelector(".palette__item--selected")?.scrollIntoView({ block: "nearest" }));
});

useEscapeToClose(() => props.open, () => emit("close"));

function choose(command: PaletteCommand): void {
  // Opening a page is its own change of focus: do not pull it back to where the palette was opened.
  opener = null;
  emit("choose", command);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    selected.value = moveSelection(selected.value, event.key === "ArrowDown" ? 1 : -1, matches.value.length);
  } else if (event.key === "Home" || event.key === "End") {
    if (matches.value.length === 0) return;
    event.preventDefault();
    selected.value = event.key === "Home" ? 0 : matches.value.length - 1;
  } else if (event.key === "Enter" && !event.isComposing) {
    event.preventDefault();
    const command = matches.value[selected.value];
    if (command) choose(command);
  } else if (event.key === "Tab") {
    // The palette is one field and one list: Tab has nowhere to go, and must not leave it open behind the page.
    event.preventDefault();
  }
}
</script>

<style scoped>
.palette-overlay {
  position: fixed;
  inset: 0;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: min(16vh, 9rem) 1rem 1rem;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}
.palette {
  width: min(36rem, 100%);
  max-height: min(70vh, 34rem);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 0;
}
.palette__field {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  padding: 0.9rem 1rem;
  border-bottom: 1px solid var(--hairline);
}
.palette__icon { flex: none; width: 1.1rem; height: 1.1rem; color: rgb(var(--logo-cyan)); }
.palette__input {
  flex: 1 1 auto;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  font-size: 1rem;
  color: rgb(243, 244, 246);
}
.palette__input::placeholder { color: rgb(107, 114, 128); }
.palette__kbd, .palette__foot kbd {
  font-family: var(--font-label);
  font-size: 0.62rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  padding: 0.15rem 0.4rem;
  border-radius: 0.3rem;
  border: 1px solid var(--hairline);
  color: rgb(156, 163, 175);
}
.palette__list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 0.4rem;
  margin: 0;
  list-style: none;
}
.palette__item {
  display: flex;
  align-items: center;
  gap: 0.8rem;
  min-height: 2.75rem;
  padding: 0.45rem 0.65rem;
  border-radius: 0.5rem;
  border: 1px solid transparent;
  cursor: pointer;
}
.palette__item--selected {
  background: rgba(var(--logo-cyan), 0.08);
  border-color: rgba(var(--logo-cyan), 0.32);
}
.palette__group {
  flex: none;
  width: 4.6rem;
  font-family: var(--font-label);
  font-size: 0.6rem;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: rgba(165, 243, 252, 0.55);
}
.palette__text { display: grid; min-width: 0; flex: 1 1 auto; }
.palette__label { font-size: 0.9rem; font-weight: 500; color: rgb(243, 244, 246); }
.palette__hint {
  font-size: 0.72rem;
  color: rgb(148, 163, 184);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.palette__here {
  flex: none;
  font-family: var(--font-label);
  font-size: 0.6rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: rgb(var(--logo-cyan));
}
.palette__empty { padding: 1.4rem 0.8rem; text-align: center; font-size: 0.875rem; color: rgb(156, 163, 175); }
.palette__foot {
  display: flex;
  gap: 1.1rem;
  padding: 0.55rem 1rem;
  border-top: 1px solid var(--hairline);
  font-size: 0.7rem;
  color: rgb(107, 114, 128);
}
.palette__foot kbd { margin-right: 0.3rem; }
.palette-enter-active, .palette-leave-active { transition: opacity 140ms var(--ease-out); }
.palette-enter-from, .palette-leave-to { opacity: 0; }
@media (max-width: 480px) {
  .palette__group { display: none; }
  .palette__foot { display: none; }
}
</style>
