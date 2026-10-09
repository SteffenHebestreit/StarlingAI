<template>
  <ImageSettingsCard
    v-if="request && request.kind === 'image_settings' && imagePayload"
    :request="request"
    :payload="imagePayload"
  />

  <!-- A kind this page cannot draw, or a payload it cannot read: never a dead end — the agent's
       own choice is always one click away, and the deadline takes it anyway. -->
  <div v-else-if="request" class="uic" role="group" :aria-label="request.title">
    <div class="uic__head">
      <span class="uic__title">{{ request.title }}</span>
      <span v-if="countdown" class="uic__timer">Auto in {{ countdown }}</span>
    </div>
    <p class="uic__copy">This page cannot show the full question. The agent can go on with its own choice.</p>
    <div class="uic__actions">
      <button type="button" class="btn-grad uic__button" :disabled="busy" @click="answer('auto')">Continue with defaults</button>
      <button
        v-if="request.kind === 'image_settings'"
        type="button"
        class="btn-ghost uic__button"
        :disabled="busy"
        @click="answer('skip')"
      >Skip</button>
    </div>
    <p v-if="formError" class="uic__error" role="alert">{{ formError }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useGatewayStore } from "@/stores/gateway";
import { readImageSettingsPayload } from "@/composables/imageSettings";
import { fieldErrorMap, formatCountdown, localExpiresAt, remainingMs } from "@/composables/userInputs";
import { useNow } from "@/composables/useNow";
import ImageSettingsCard from "@/components/input/ImageSettingsCard.vue";

const props = defineProps<{ inputId: string }>();

const gateway = useGatewayStore();
const now = useNow();
const busy = ref(false);

const request = computed(() => gateway.userInputs[props.inputId]);
const imagePayload = computed(() => request.value?.kind === "image_settings" ? readImageSettingsPayload(request.value.payload) : null);
const countdown = computed(() => {
  const left = request.value ? remainingMs(localExpiresAt(request.value), now.value) : null;
  return left === null ? "" : formatCountdown(left);
});
const formError = computed(() => Object.values(fieldErrorMap(request.value?.errors)).join(" "));

async function answer(choice: "auto" | "skip"): Promise<void> {
  busy.value = true;
  try {
    await gateway.respondUserInput(props.inputId, { choice });
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.uic {
  max-width: 34rem;
  padding: 0.65rem 0.8rem;
  border-radius: 0.8rem;
  border: 1px solid rgba(var(--accent-purple), 0.35);
  background: var(--surface-2, rgba(34, 30, 52, 0.62));
  font-size: 0.8rem;
}
.uic__head { display: flex; align-items: baseline; gap: 0.6rem; }
.uic__title { font-weight: 600; }
.uic__timer { margin-left: auto; font-variant-numeric: tabular-nums; color: rgb(156 163 175); }
.uic__copy { margin: 0.3rem 0 0.55rem; color: rgb(203 213 225); }
.uic__actions { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.uic__button { padding: 0.3rem 0.8rem; border-radius: 0.6rem; font-size: 0.78rem; }
.uic__error { margin: 0.4rem 0 0; color: #fca5a5; }
</style>
