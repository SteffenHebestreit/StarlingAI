<template>
  <!-- The dashboard's one "are you sure?" dialog (composables/useConfirm.ts). Mounted once, in
       App.vue; anything may ask through confirmAction(). -->
  <Teleport to="body">
    <Transition name="confirm">
      <div
        v-if="request"
        class="confirm-overlay z-confirm"
        @click.self="answerConfirm(false)"
      >
        <div
          ref="dialogEl"
          class="confirm-dialog glass-card modal-pop"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="confirm-title"
          :aria-describedby="request.message ? 'confirm-message' : undefined"
          @keydown.tab="keepFocusInside"
        >
          <p class="eyebrow" :class="request.danger ? 'confirm-dialog__eyebrow--danger' : ''">
            {{ request.danger ? "Cannot be undone" : "Please confirm" }}
          </p>
          <h2 id="confirm-title" class="confirm-dialog__title">{{ request.title }}</h2>
          <p v-if="request.message" id="confirm-message" class="confirm-dialog__message">{{ request.message }}</p>
          <div class="confirm-dialog__actions">
            <!-- The way back takes the focus: Enter on a dialog that just appeared must not destroy anything. -->
            <button ref="cancelEl" type="button" class="btn-ghost confirm-dialog__button" @click="answerConfirm(false)">
              {{ request.cancelLabel ?? "Cancel" }}
            </button>
            <button
              type="button"
              class="confirm-dialog__button"
              :class="request.danger ? 'btn-danger' : 'btn-grad'"
              @click="answerConfirm(true)"
            >
              {{ request.confirmLabel }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { answerConfirm, pendingConfirm } from "@/composables/useConfirm";
import { useEscapeToClose } from "@/composables/useEscapeToClose";

const request = computed(() => pendingConfirm.value);
const dialogEl = ref<HTMLElement | null>(null);
const cancelEl = ref<HTMLButtonElement | null>(null);
/** What had the focus before the question, to hand it back afterwards. */
let asker: HTMLElement | null = null;

watch(request, (now, before) => {
  if (now && !before) {
    asker = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    void nextTick(() => cancelEl.value?.focus());
  } else if (!now && before) {
    if (asker?.isConnected) asker.focus({ preventScroll: true });
    asker = null;
  }
});

useEscapeToClose(() => request.value !== null, () => answerConfirm(false));

/** Tab stays between the dialog's two buttons while it is up. */
function keepFocusInside(event: KeyboardEvent): void {
  const buttons = [...(dialogEl.value?.querySelectorAll<HTMLElement>("button") ?? [])];
  if (buttons.length === 0) return;
  const first = buttons[0]!;
  const last = buttons[buttons.length - 1]!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
</script>

<style scoped>
.confirm-overlay {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}
.confirm-dialog {
  width: min(26rem, 100%);
  padding: 1.4rem 1.5rem 1.25rem;
}
.confirm-dialog__eyebrow--danger { color: rgb(252, 165, 165); }
.confirm-dialog__title {
  margin-top: 0.5rem;
  font-family: var(--font-display);
  font-size: 1.1rem;
  font-weight: 600;
  line-height: 1.35;
  color: rgb(243, 244, 246);
}
.confirm-dialog__message {
  margin-top: 0.6rem;
  font-size: 0.875rem;
  line-height: 1.55;
  color: rgb(156, 163, 175);
}
.confirm-dialog__actions {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 0.6rem;
  margin-top: 1.4rem;
}
.confirm-dialog__button {
  min-height: 2.5rem;
  padding: 0.5rem 1.1rem;
  border-radius: 0.75rem;
  font-size: 0.875rem;
}
.confirm-enter-active, .confirm-leave-active { transition: opacity 160ms var(--ease-out); }
.confirm-enter-from, .confirm-leave-to { opacity: 0; }
</style>
