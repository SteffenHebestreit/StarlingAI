<template>
  <div class="isc" role="group" aria-label="Image settings">
    <div class="isc__head">
      <span class="isc__eyebrow">Image settings</span>
      <span class="isc__timer" :class="{ 'isc__timer--soon': leftMs !== null && leftMs < 15_000 }">
        {{ leftMs === null ? '' : `Auto in ${formatCountdown(leftMs)}` }}
      </span>
    </div>
    <p class="isc__summary">{{ summary }}<span v-if="eta" class="isc__eta"> · {{ eta }}</span></p>
    <p v-if="longWarning" class="isc__warn">{{ longWarning }}</p>
    <p v-if="waitNote" class="isc__note">{{ waitNote }}</p>
    <div v-if="maskPreview" class="isc__mask">
      <div class="isc__mask-frame" :style="maskFrameStyle">
        <img v-if="maskPreview.baseUrl" :src="maskPreview.baseUrl" alt="" class="isc__mask-base" />
        <img :src="maskPreview.maskUrl" alt="The region that may change" class="isc__mask-overlay" />
      </div>
      <span class="isc__mask-caption">{{ maskPreview.caption }}</span>
    </div>
    <p class="isc__prompt" :title="payload.agent.prompt">“{{ promptPreview }}”</p>

    <div class="isc__actions">
      <button type="button" class="btn-grad isc__button" :disabled="busy" title="Render with the agent's settings" @click="answer('auto')">Auto</button>
      <button type="button" class="btn-ghost isc__button" :disabled="busy" @click="openConfigure">Configure…</button>
      <button type="button" class="btn-ghost isc__button" :disabled="busy" title="Do not render this picture" @click="answer('skip')">Skip</button>
      <label class="isc__always" title="Renders in this chat stop asking and use the agent's settings">
        <input type="checkbox" :checked="alwaysAuto" @change="toggleAlwaysAuto" />
        Always Auto in this chat
      </label>
    </div>
    <p v-if="formError" class="isc__error" role="alert">{{ formError }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useGatewayStore } from "@/stores/gateway";
import {
  agentEstimateSeconds,
  agentMaskPreview,
  engineWaitNote,
  engineWaitSeconds,
  etaLabel,
  fitInSquare,
  longRenderWarning,
  summarizeProposal,
  type ImageSettingsPayload,
} from "@/composables/imageSettings";
import { fieldErrorMap, formatCountdown, localExpiresAt, remainingMs, type UserInputRequest } from "@/composables/userInputs";
import { useNow } from "@/composables/useNow";

const props = defineProps<{
  request: UserInputRequest;
  payload: ImageSettingsPayload;
}>();

const MASK_FRAME_REM = 4.5;

const gateway = useGatewayStore();
const now = useNow();
const busy = ref(false);
// The form is drawn by the page, not by this card: a message sent mid-turn cuts the bubble and
// re-mounts the card under its step in the new segment, and a form living here would lose
// everything typed or painted into it.
const configuring = computed(() => gateway.configuringUserInputId === props.request.inputId);

const leftMs = computed(() => remainingMs(localExpiresAt(props.request), now.value));
const summary = computed(() => summarizeProposal(props.payload));
// What the agent's settings should take — scaled by their steps and size, not the engine's usual time.
const agentSeconds = computed(() => agentEstimateSeconds(props.payload));
const eta = computed(() => etaLabel(agentSeconds.value));
const longWarning = computed(() => longRenderWarning(agentSeconds.value));
// After a timeout the engine is still on the abandoned render, and this one waits for it first.
const waitNote = computed(() => engineWaitNote(engineWaitSeconds(props.payload, props.payload.agent.tier, props.request.askedAt, now.value)));
const maskPreview = computed(() => agentMaskPreview(props.payload));
// The whole mask in its own shape, within the frame's square: never a crop of it.
const maskFrameStyle = computed(() => {
  if (!maskPreview.value) return {};
  const box = fitInSquare(maskPreview.value.width, maskPreview.value.height, MASK_FRAME_REM);
  return { width: `${box.width}rem`, height: `${box.height}rem` };
});
const promptPreview = computed(() => {
  const flat = props.payload.agent.prompt.replace(/\s+/g, " ").trim();
  return flat.length > 140 ? `${flat.slice(0, 139)}…` : flat;
});
// The session setting itself, so the card, the composer chip and the next render all agree.
const alwaysAuto = computed(() => gateway.currentSessionImageSettingsPrompt === "auto");
// Field errors belong to the form; on the compact card only what is not about a field shows.
const formError = computed(() => (configuring.value ? "" : Object.values(fieldErrorMap(props.request.errors)).join(" ")));

function toggleAlwaysAuto(event: Event): void {
  const checked = (event.target as HTMLInputElement).checked;
  void gateway.updateSessionSettings({ imageSettingsPrompt: checked ? "auto" : "ask" });
}

async function answer(choice: "auto" | "skip"): Promise<void> {
  busy.value = true;
  try {
    await gateway.respondUserInput(props.request.inputId, { choice, ...(alwaysAuto.value ? { alwaysAuto: true } : {}) });
  } finally {
    busy.value = false;
  }
}

function openConfigure(): void {
  gateway.openUserInputForm(props.request.inputId);
}
</script>

<style scoped>
.isc {
  max-width: 34rem;
  padding: 0.65rem 0.8rem 0.7rem;
  border-radius: 0.8rem;
  border: 1px solid rgba(var(--accent-purple), 0.4);
  background: var(--surface-2, rgba(34, 30, 52, 0.62));
  box-shadow: 0 0 18px rgba(var(--accent-purple), 0.12);
  font-size: 0.8rem;
  line-height: 1.4;
}
.isc__head { display: flex; align-items: baseline; gap: 0.6rem; }
.isc__eyebrow {
  font-size: 0.68rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: rgb(var(--accent-purple));
}
.isc__timer { margin-left: auto; font-variant-numeric: tabular-nums; color: rgb(156 163 175); }
.isc__timer--soon { color: #fbbf24; }
.isc__summary { margin: 0.3rem 0 0.1rem; font-weight: 500; }
.isc__eta { color: rgb(156 163 175); font-weight: 400; }
.isc__warn { margin: 0 0 0.35rem; color: #fbbf24; font-size: 0.76rem; }
.isc__note { margin: 0 0 0.35rem; color: rgb(156 163 175); font-size: 0.76rem; }
.isc__mask { display: flex; align-items: center; gap: 0.55rem; margin: 0.15rem 0 0.5rem; }
.isc__mask-frame {
  position: relative;
  flex: none;
  /* Its size (maskFrameStyle) is the picture's shape; the border goes outside it, not into it. */
  box-sizing: content-box;
  overflow: hidden;
  border-radius: 0.4rem;
  border: 1px solid rgba(var(--accent-purple), 0.35);
  /* Where there is no thumbnail, the region that may change shows as this light ground. */
  background: rgb(203 213 225);
}
.isc__mask-base,
.isc__mask-overlay { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
/* The mask is black where the picture is protected and clear where it may change. */
.isc__mask-overlay { opacity: 0.62; }
.isc__mask-caption { color: rgb(203 213 225); font-size: 0.74rem; }
.isc__prompt {
  margin: 0 0 0.55rem;
  color: rgb(156 163 175);
  font-style: italic;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.isc__actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; }
.isc__button { padding: 0.3rem 0.85rem; border-radius: 0.6rem; font-size: 0.78rem; }
.isc__always {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  margin-left: auto;
  color: rgb(203 213 225);
  font-size: 0.74rem;
  cursor: pointer;
}
.isc__error { margin: 0.45rem 0 0; color: #fca5a5; }

@media (max-width: 640px) {
  .isc__always { margin-left: 0; }
}
</style>
