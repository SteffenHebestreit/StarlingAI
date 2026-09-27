<template>
  <Teleport to="body">
    <div class="ism-backdrop">
      <div
        ref="dialogEl"
        class="ism"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ism-title"
        tabindex="-1"
      >
        <header class="ism__header">
          <div>
            <div class="ism__eyebrow">Image settings</div>
            <div id="ism-title" class="ism__title">{{ view === 'paint' ? 'Paint the region that may change' : request.title }}</div>
          </div>
          <span class="ism__timer" :class="{ 'ism__timer--soon': leftMs !== null && leftMs < 30_000 }">
            {{ leftMs === null ? '' : `Auto in ${formatCountdown(leftMs)}` }}
          </span>
          <button type="button" class="ism__close" aria-label="Close (Esc)" title="Close (Esc)" @click="close">✕</button>
        </header>

        <!-- Painting replaces the form, so the picture gets the whole dialog. -->
        <div v-if="view === 'paint' && paintBase" class="ism__body ism__body--paint">
          <MaskPainter
            :width="paintBase.width"
            :height="paintBase.height"
            :base-url="basePreview?.dataUrl ?? null"
            :base-error="basePreview?.error"
            :initial-mask-url="paintStartMask"
            @apply="onMaskApplied"
            @cancel="view = 'form'"
          />
        </div>

        <form v-else class="ism__body" @submit.prevent="submit">
          <!-- Engine -->
          <fieldset class="ism__section">
            <legend class="ism__legend">Engine</legend>
            <div class="ism__engines">
              <label
                v-for="engine in payload.engines"
                :key="engine.tier"
                :class="['ism__engine', { 'ism__engine--on': form.tier === engine.tier, 'ism__engine--off': editing && !engine.canEdit }]"
                :title="editing && !engine.canEdit ? `${engineLabel(engine)} cannot edit a picture` : undefined"
              >
                <input
                  type="radio"
                  name="ism-engine"
                  :value="engine.tier"
                  :checked="form.tier === engine.tier"
                  :disabled="editing && !engine.canEdit"
                  @change="form = selectEngine(form, payload, engine.tier)"
                />
                <span class="ism__engine-name">{{ engineLabel(engine) }}</span>
                <!-- With these settings on that engine, not its usual time: 57 steps at 1344×768 is ~8 min. -->
                <span v-if="etaLabel(engineEstimateSeconds(form, payload, engine.tier))" class="ism__muted">{{ etaLabel(engineEstimateSeconds(form, payload, engine.tier)) }}</span>
                <span v-if="engine.fixedSize" class="ism__badge">{{ payload.bounds.size.fixed }}×{{ payload.bounds.size.fixed }} only</span>
                <span v-if="engine.canEdit" class="ism__badge ism__badge--edit">can edit</span>
              </label>
            </div>
            <p v-if="errors.tier" class="ism__error">{{ errors.tier }}</p>
          </fieldset>

          <!-- Prompt -->
          <fieldset class="ism__section">
            <legend class="ism__legend">Prompt</legend>
            <div class="ism__field-head">
              <label for="ism-prompt" class="ism__label">What to draw</label>
              <span class="ism__muted">{{ form.prompt.trim().length }}/{{ payload.bounds.promptMax }}</span>
              <button v-if="form.prompt !== payload.agent.prompt" type="button" class="ism__link" @click="form.prompt = payload.agent.prompt">Reset to the agent's</button>
            </div>
            <textarea id="ism-prompt" v-model="form.prompt" class="ism__textarea" rows="4" :maxlength="payload.bounds.promptMax + 200" />
            <p v-if="errors.prompt" class="ism__error">{{ errors.prompt }}</p>

            <div class="ism__field-head">
              <label for="ism-negative" class="ism__label">Avoid (negative prompt)</label>
              <span class="ism__muted">{{ form.negativePrompt.trim().length }}/{{ payload.bounds.negativeMax }}</span>
              <button
                v-if="form.negativePrompt !== (payload.agent.negativePrompt ?? '')"
                type="button"
                class="ism__link"
                @click="form.negativePrompt = payload.agent.negativePrompt ?? ''; form.touched.negativePrompt = true"
              >Reset to the agent's</button>
            </div>
            <textarea
              id="ism-negative"
              v-model="form.negativePrompt"
              class="ism__textarea"
              rows="2"
              placeholder="Nothing to avoid"
              @input="form.touched.negativePrompt = true"
            />
            <p v-if="errors.negativePrompt" class="ism__error">{{ errors.negativePrompt }}</p>
            <p v-else-if="negativeNote" class="ism__warn">{{ negativeNote }}</p>
          </fieldset>

          <!-- Edit a picture -->
          <fieldset class="ism__section">
            <legend class="ism__legend">Start from</legend>
            <div class="ism__bases" role="radiogroup" aria-label="Picture to edit">
              <button
                type="button"
                role="radio"
                :aria-checked="!form.baseCandidateId"
                :class="['ism__base', 'ism__base--none', { 'ism__base--on': !form.baseCandidateId }]"
                @click="form = selectBase(form, payload, null)"
              >
                <span class="ism__base-thumb ism__base-thumb--none" aria-hidden="true">＋</span>
                <span class="ism__base-label">None — new picture</span>
              </button>
              <button
                v-for="candidate in payload.baseCandidates"
                :key="candidate.id"
                type="button"
                role="radio"
                :aria-checked="form.baseCandidateId === candidate.id"
                :disabled="!anyEditor"
                :title="anyEditor ? `${candidate.label} · ${candidate.width}×${candidate.height}` : 'No engine here can edit a picture'"
                :class="['ism__base', { 'ism__base--on': form.baseCandidateId === candidate.id }]"
                @click="form = selectBase(form, payload, candidate.id)"
              >
                <img v-if="candidate.thumbDataUrl" :src="candidate.thumbDataUrl" :alt="candidate.label" class="ism__base-thumb" />
                <span v-else class="ism__base-thumb ism__base-thumb--none" aria-hidden="true">?</span>
                <span class="ism__base-label">{{ candidate.label }}</span>
                <span class="ism__muted">{{ candidate.width ? `${candidate.width}×${candidate.height}` : 'size unknown' }} · {{ sourceLabel(candidate.source) }}</span>
                <span v-if="!candidate.fitsBounds" class="ism__muted">too large to edit at its size — renders at {{ payload.agent.width }}×{{ payload.agent.height }}</span>
              </button>
            </div>
            <p v-if="errors.baseCandidateId" class="ism__error">{{ errors.baseCandidateId }}</p>
            <p v-if="baseMissing && !form.baseCandidateId" class="ism__warn" role="alert">
              The agent's picture cannot be offered here, so rendering from this form makes a NEW picture.
              To keep the edit, use the agent's settings.
            </p>

            <template v-if="selectedBase">
              <div class="ism__field-head">
                <label for="ism-strength" class="ism__label">Strength</label>
                <span class="ism__value">{{ form.strength.toFixed(2) }}</span>
                <span class="ism__muted">{{ strengthBand(form.strength) }}</span>
              </div>
              <input
                id="ism-strength"
                v-model.number="form.strength"
                type="range"
                class="ism__range"
                :min="payload.bounds.strength[0]"
                :max="payload.bounds.strength[1]"
                step="0.05"
              />
              <p class="ism__muted ism__bands">0.2–0.35 changes tone and colour · 0.6–0.85 replaces a masked region</p>
              <p v-if="errors.strength" class="ism__error">{{ errors.strength }}</p>

              <div class="ism__mask">
                <span class="ism__label">Mask</span>
                <span class="ism__mask-state">{{ maskStateText }}</span>
                <button v-if="selectedBase.fitsBounds" type="button" class="btn-ghost ism__small" @click="startPainting">
                  {{ form.mask === 'none' ? 'Paint region…' : form.mask === 'agent' ? (payload.agentMask?.paintedEarlier ? 'Edit that region…' : 'Edit the agent’s mask…') : 'Repaint…' }}
                </button>
                <button v-if="form.mask !== 'none'" type="button" class="ism__link" @click="form.mask = 'none'; form.maskDataUrl = undefined">Remove mask</button>
                <span v-if="!selectedBase.fitsBounds" class="ism__muted">This picture is too large to paint a mask on.</span>
              </div>
              <p v-if="form.mask !== 'none' && form.strength < 0.6" class="ism__muted">A masked replacement usually needs a strength of 0.6–0.85.</p>
              <p v-if="errors.mask" class="ism__error">{{ errors.mask }}</p>

              <template v-if="form.mask !== 'none'">
                <div class="ism__field-head">
                  <label for="ism-blur" class="ism__label">Feather</label>
                  <span class="ism__value">{{ form.maskBlur }} px</span>
                  <span class="ism__muted">softens the mask's edge</span>
                </div>
                <input
                  id="ism-blur"
                  v-model.number="form.maskBlur"
                  type="range"
                  class="ism__range"
                  :min="payload.bounds.maskBlur[0]"
                  :max="Math.min(payload.bounds.maskBlur[1], 128)"
                  step="1"
                  @input="form.touched.maskBlur = true"
                />
                <p v-if="errors.maskBlur" class="ism__error">{{ errors.maskBlur }}</p>
              </template>
            </template>
          </fieldset>

          <!-- Size -->
          <fieldset class="ism__section">
            <legend class="ism__legend">Size</legend>
            <div v-if="!lock.locked" class="ism__presets">
              <button
                v-for="preset in presets"
                :key="preset.label"
                type="button"
                :class="['ism__chip', { 'ism__chip--on': form.width === preset.width && form.height === preset.height }]"
                @click="form.width = preset.width; form.height = preset.height"
              >{{ preset.label }} <span class="ism__muted">{{ preset.width }}×{{ preset.height }}</span></button>
            </div>
            <div class="ism__row">
              <label class="ism__inline">W
                <input v-model.number="form.width" type="number" class="ism__number" :min="payload.bounds.size.min" :max="payload.bounds.size.max" :step="payload.bounds.size.step" :disabled="lock.locked" />
              </label>
              <label class="ism__inline">H
                <input v-model.number="form.height" type="number" class="ism__number" :min="payload.bounds.size.min" :max="payload.bounds.size.max" :step="payload.bounds.size.step" :disabled="lock.locked" />
              </label>
              <span v-if="lock.reason === 'base'" class="ism__muted">{{ selectedBase?.fitsBounds === false
                ? `The picture is too large to edit at its own size, so it renders at ${form.width}×${form.height}.`
                : "An edit keeps the picture's own size." }}</span>
              <span v-else-if="lock.reason === 'fixed'" class="ism__muted">This engine renders {{ payload.bounds.size.fixed }}×{{ payload.bounds.size.fixed }} only.</span>
              <span v-else class="ism__muted">Multiples of {{ payload.bounds.size.step }}, {{ payload.bounds.size.min }}–{{ payload.bounds.size.max }}.</span>
            </div>
            <p v-if="errors.width || errors.height" class="ism__error">{{ errors.width ?? errors.height }}</p>
          </fieldset>

          <!-- Quality -->
          <fieldset class="ism__section">
            <legend class="ism__legend">Detail</legend>
            <div class="ism__field-head">
              <label for="ism-steps" class="ism__label">Steps</label>
              <input v-model.number="form.steps" type="number" class="ism__number" :min="payload.bounds.steps[0]" :max="payload.bounds.steps[1]" step="1" aria-label="Steps" @input="form.touched.steps = true" />
              <span class="ism__muted">engine default {{ selectedEngine?.defaults.steps }}</span>
            </div>
            <input id="ism-steps" v-model.number="form.steps" type="range" class="ism__range" :min="payload.bounds.steps[0]" :max="payload.bounds.steps[1]" step="1" @input="form.touched.steps = true" />
            <p v-if="errors.steps" class="ism__error">{{ errors.steps }}</p>

            <div class="ism__field-head">
              <label for="ism-guidance" class="ism__label">Guidance</label>
              <input v-model.number="form.guidanceScale" type="number" class="ism__number" :min="payload.bounds.guidance[0]" :max="payload.bounds.guidance[1]" step="0.1" aria-label="Guidance" @input="form.touched.guidanceScale = true" />
              <span class="ism__muted">engine default {{ selectedEngine?.defaults.guidanceScale }} · higher follows the prompt more literally</span>
            </div>
            <input id="ism-guidance" v-model.number="form.guidanceScale" type="range" class="ism__range" :min="payload.bounds.guidance[0]" :max="payload.bounds.guidance[1]" step="0.1" @input="form.touched.guidanceScale = true" />
            <p v-if="errors.guidanceScale" class="ism__error">{{ errors.guidanceScale }}</p>

            <div class="ism__row">
              <span class="ism__label">Seed</span>
              <label class="ism__inline">
                <input type="checkbox" :checked="form.seed === null" @change="toggleRandomSeed" />
                Random
              </label>
              <input
                v-if="form.seed !== null"
                v-model.number="form.seed"
                type="number"
                class="ism__number ism__number--wide"
                :min="payload.bounds.seed[0]"
                :max="payload.bounds.seed[1]"
                step="1"
                aria-label="Seed"
              />
              <button v-if="form.seed !== null" type="button" class="ism__link" title="A new random seed" @click="form.seed = randomSeed(payload.bounds.seed[1])">🎲 New</button>
              <span class="ism__muted">the same seed and settings give the same picture</span>
            </div>
            <p v-if="errors.seed" class="ism__error">{{ errors.seed }}</p>
          </fieldset>

          <footer class="ism__footer">
            <p v-if="errors._form" class="ism__error ism__footer-error" role="alert">{{ errors._form }}</p>
            <p v-if="longWarning" class="ism__warn ism__footer-error">{{ longWarning }}</p>
            <p v-if="waitNote" class="ism__muted ism__footer-error">{{ waitNote }}</p>
            <button type="button" class="ism__link ism__reset" @click="form = initialForm(payload); localErrors = []">Reset all</button>
            <button type="button" class="btn-ghost ism__action" :disabled="busy" @click="useAgentSettings">Use the agent's settings</button>
            <span v-if="etaLabel(estimateSeconds)" class="ism__muted ism__eta" title="How long these settings should take on this engine">{{ etaLabel(estimateSeconds) }}</span>
            <button type="submit" class="btn-grad ism__action" :disabled="busy">{{ busy ? 'Sending…' : 'Render with these settings' }}</button>
          </footer>
        </form>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import { useGatewayStore } from "@/stores/gateway";
import {
  buildConfigureAnswer,
  candidateFor,
  editBaseMissing,
  engineEstimateSeconds,
  engineWaitNote,
  engineWaitSeconds,
  engineFor,
  engineLabel,
  etaLabel,
  formEstimateSeconds,
  imageFieldErrors,
  initialForm,
  longRenderWarning,
  negativePromptNote,
  renderLimitProblem,
  randomSeed,
  selectBase,
  selectEngine,
  sizeLock,
  sizePresets,
  strengthBand,
  validateForm,
  type BaseCandidate,
  type ImageSettingsForm,
  type ImageSettingsPayload,
} from "@/composables/imageSettings";
import { coverageLabel, type MaskCoverage } from "@/composables/maskPainter";
import { formatCountdown, localExpiresAt, remainingMs, type UserInputFieldError, type UserInputRequest } from "@/composables/userInputs";
import { useNow } from "@/composables/useNow";
import { useEscapeToClose } from "@/composables/useEscapeToClose";
import MaskPainter from "@/components/input/MaskPainter.vue";

const props = defineProps<{
  request: UserInputRequest;
  payload: ImageSettingsPayload;
  alwaysAuto: boolean;
}>();

const emit = defineEmits<{ close: [] }>();

const gateway = useGatewayStore();
const now = useNow();
const dialogEl = ref<HTMLElement | null>(null);
const form = ref<ImageSettingsForm>(initialForm(props.payload));
const view = ref<"form" | "paint">("form");
const busy = ref(false);
const localErrors = ref<UserInputFieldError[]>([]);
const paintedCoverage = ref<MaskCoverage | null>(null);
const previews = ref<Record<string, { dataUrl?: string; error?: string }>>({});

const leftMs = computed(() => remainingMs(localExpiresAt(props.request), now.value));
const selectedEngine = computed(() => engineFor(props.payload, form.value.tier));
const selectedBase = computed(() => candidateFor(props.payload, form.value.baseCandidateId));
const editing = computed(() => Boolean(form.value.baseCandidateId));
const anyEditor = computed(() => props.payload.engines.some((engine) => engine.canEdit));
const lock = computed(() => sizeLock(form.value, props.payload));
const presets = computed(() => sizePresets(props.payload.bounds));
// A negative prompt at guidance ≤ 1 changes nothing; said beside it rather than discovered later.
const negativeNote = computed(() => negativePromptNote(form.value, props.payload));
// What these settings should take; also the running step's ETA once they are sent.
const estimateSeconds = computed(() => formEstimateSeconds(form.value, props.payload));
// Past the image server's own limit the settings would fail, which outranks merely taking long.
const longWarning = computed(() => renderLimitProblem(form.value, props.payload) || longRenderWarning(estimateSeconds.value));
const waitNote = computed(() => engineWaitNote(engineWaitSeconds(props.payload, form.value.tier, props.request.askedAt, now.value)));
const baseMissing = computed(() => editBaseMissing(props.payload));
// This page's own checks first; what the server said about the last answer shows until the next.
const errors = computed(() => ({ ...imageFieldErrors(props.request.errors), ...imageFieldErrors(localErrors.value) }));

const paintBase = computed<BaseCandidate | undefined>(() => selectedBase.value);
const basePreview = computed(() => (form.value.baseCandidateId ? previews.value[form.value.baseCandidateId] : undefined));
const paintStartMask = computed(() => form.value.mask === "painted"
  ? form.value.maskDataUrl
  : form.value.mask === "agent" ? props.payload.agentMask?.previewDataUrl : undefined);
const maskStateText = computed(() => {
  if (form.value.mask === "agent") return props.payload.agentMask?.paintedEarlier ? "The region you painted earlier" : "The agent's mask";
  if (form.value.mask === "painted") return paintedCoverage.value ? `Your mask — ${coverageLabel(paintedCoverage.value)} may change` : "Your mask";
  return "None — the whole picture may change";
});

function sourceLabel(source: BaseCandidate["source"]): string {
  if (source === "agent") return "the agent's pick";
  if (source === "latest_image") return "latest";
  if (source === "attachment") return "your upload";
  return "earlier";
}

function toggleRandomSeed(event: Event): void {
  const random = (event.target as HTMLInputElement).checked;
  form.value.seed = random ? null : (props.payload.agent.seed ?? randomSeed(props.payload.bounds.seed[1]));
}

async function startPainting(): Promise<void> {
  const base = selectedBase.value;
  if (!base) return;
  view.value = "paint";
  if (previews.value[base.id]?.dataUrl) return;
  previews.value = { ...previews.value, [base.id]: {} };
  try {
    const preview = await gateway.previewUserInputCandidate(props.request.inputId, base.id);
    previews.value = { ...previews.value, [base.id]: { dataUrl: preview.dataUrl } };
  } catch (error) {
    previews.value = { ...previews.value, [base.id]: { error: error instanceof Error ? error.message : String(error) } };
  }
}

function onMaskApplied(dataUrl: string, coverage: MaskCoverage): void {
  form.value = { ...form.value, mask: "painted", maskDataUrl: dataUrl };
  paintedCoverage.value = coverage;
  view.value = "form";
}

async function submit(): Promise<void> {
  const problems = validateForm(form.value, props.payload);
  localErrors.value = problems;
  if (problems.length) return;
  busy.value = true;
  try {
    const result = await gateway.respondUserInput(
      props.request.inputId,
      buildConfigureAnswer(form.value, props.payload, props.alwaysAuto),
      { tier: form.value.tier, expectedSeconds: estimateSeconds.value },
    );
    if (result.ok) emit("close");
  } finally {
    busy.value = false;
  }
}

async function useAgentSettings(): Promise<void> {
  busy.value = true;
  try {
    const result = await gateway.respondUserInput(props.request.inputId, { choice: "auto", ...(props.alwaysAuto ? { alwaysAuto: true } : {}) });
    if (result.ok) emit("close");
  } finally {
    busy.value = false;
  }
}

function close(): void {
  // Closing is not an answer: the card stays, and the deadline decides if nothing else does.
  emit("close");
}

// On the shared overlay stack, so one Escape steps back once: out of the painter, then out of
// the form — and never also closes the side panel behind it.
useEscapeToClose(() => true, () => {
  if (view.value === "paint") view.value = "form";
  else close();
});

onMounted(() => {
  void nextTick(() => dialogEl.value?.focus());
});
</script>

<style scoped>
.ism-backdrop {
  position: fixed;
  inset: 0;
  z-index: 240;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.72);
  backdrop-filter: blur(4px);
}
.ism {
  display: flex;
  flex-direction: column;
  width: min(94vw, 900px);
  max-height: 92vh;
  background: var(--surface-3, rgba(13, 17, 29, 0.96));
  border: 1px solid var(--hairline-strong, rgba(168, 85, 247, 0.3));
  border-radius: 1.1rem;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.5);
  overflow: hidden;
  outline: none;
  font-size: 0.84rem;
}
.ism__header {
  display: flex;
  align-items: center;
  gap: 0.8rem;
  padding: 0.8rem 1rem;
  border-bottom: 1px solid var(--hairline, rgba(168, 85, 247, 0.14));
}
.ism__eyebrow {
  font-size: 0.68rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: rgb(var(--accent-purple));
}
.ism__title { font-weight: 600; }
.ism__timer { margin-left: auto; font-variant-numeric: tabular-nums; color: rgb(156 163 175); }
.ism__timer--soon { color: #fbbf24; }
.ism__close {
  width: 1.8rem;
  height: 1.8rem;
  border-radius: 999px;
  border: 1px solid rgba(148, 163, 184, 0.35);
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.ism__body { overflow-y: auto; padding: 0.4rem 1rem 0; }
.ism__body--paint { padding: 0.8rem 1rem; }

.ism__section { margin: 0; padding: 0.7rem 0; border: none; border-bottom: 1px solid var(--hairline, rgba(168, 85, 247, 0.14)); }
.ism__legend { padding: 0; margin-bottom: 0.45rem; font-weight: 600; font-size: 0.8rem; }
.ism__label { font-weight: 500; }
.ism__muted { color: rgb(156 163 175); font-size: 0.76rem; }
.ism__value { font-variant-numeric: tabular-nums; }
.ism__error { margin: 0.3rem 0 0; color: #fca5a5; font-size: 0.78rem; }
.ism__link {
  border: none;
  background: transparent;
  padding: 0;
  color: rgb(var(--accent-purple));
  font: inherit;
  font-size: 0.76rem;
  cursor: pointer;
}
.ism__link:hover { text-decoration: underline; }

.ism__engines { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.ism__engine {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.4rem;
  padding: 0.45rem 0.7rem;
  border-radius: 0.7rem;
  border: 1px solid var(--hairline-strong, rgba(168, 85, 247, 0.3));
  cursor: pointer;
}
.ism__engine--on { background: rgba(var(--accent-purple), 0.18); border-color: rgba(var(--accent-purple), 0.7); }
.ism__engine--off { opacity: 0.45; cursor: not-allowed; }
.ism__engine-name { font-weight: 600; }
.ism__badge {
  padding: 0 0.35rem;
  border-radius: 0.3rem;
  background: rgba(148, 163, 184, 0.16);
  font-size: 0.7rem;
}
.ism__badge--edit { background: rgba(74, 222, 128, 0.16); color: #86efac; }

.ism__field-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.5rem; margin: 0.5rem 0 0.25rem; }
.ism__textarea {
  width: 100%;
  padding: 0.45rem 0.6rem;
  border-radius: 0.6rem;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: var(--surface-input, rgba(13, 12, 23, 0.55));
  color: inherit;
  font: inherit;
  resize: vertical;
}
.ism__range { width: 100%; }
.ism__bands { margin: 0.1rem 0 0; }
.ism__row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 0.8rem; margin-top: 0.4rem; }
.ism__inline { display: inline-flex; align-items: center; gap: 0.35rem; }
.ism__number {
  width: 5.2rem;
  padding: 0.2rem 0.4rem;
  border-radius: 0.45rem;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: var(--surface-input, rgba(13, 12, 23, 0.55));
  color: inherit;
  font: inherit;
  font-variant-numeric: tabular-nums;
}
.ism__number:disabled { opacity: 0.5; }
.ism__number--wide { width: 8.5rem; }
.ism__presets { display: flex; flex-wrap: wrap; gap: 0.35rem; }
.ism__chip {
  padding: 0.2rem 0.55rem;
  border-radius: 999px;
  border: 1px solid var(--hairline-strong, rgba(168, 85, 247, 0.3));
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 0.76rem;
  cursor: pointer;
}
.ism__chip--on { background: rgba(var(--accent-purple), 0.2); }

.ism__bases { display: grid; grid-template-columns: repeat(auto-fill, minmax(7.5rem, 1fr)); gap: 0.5rem; }
.ism__base {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  padding: 0.35rem;
  border-radius: 0.7rem;
  border: 1px solid var(--hairline, rgba(168, 85, 247, 0.14));
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.ism__base:disabled { opacity: 0.45; cursor: not-allowed; }
.ism__base--on { border-color: rgba(var(--accent-purple), 0.8); box-shadow: 0 0 0 1px rgba(var(--accent-purple), 0.6); }
.ism__base-thumb {
  width: 100%;
  aspect-ratio: 1;
  object-fit: cover;
  border-radius: 0.45rem;
  background: rgba(148, 163, 184, 0.1);
}
.ism__base-thumb--none { display: flex; align-items: center; justify-content: center; font-size: 1.4rem; color: rgb(156 163 175); }
.ism__base-label { font-size: 0.76rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.ism__mask { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; margin-top: 0.7rem; }
.ism__mask-state { color: rgb(203 213 225); }
.ism__small { padding: 0.25rem 0.7rem; border-radius: 0.55rem; font-size: 0.76rem; }

.ism__footer {
  position: sticky;
  bottom: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 0.6rem;
  padding: 0.75rem 0;
  background: var(--surface-3, rgba(13, 17, 29, 0.96));
  /* The surface is translucent in the glass themes; the form scrolling under a sticky footer
     otherwise reads straight through its warning line. */
  backdrop-filter: blur(12px);
}
.ism__footer-error { flex-basis: 100%; margin: 0; }
.ism__warn { margin: 0.35rem 0 0; color: #fbbf24; font-size: 0.78rem; }
.ism__reset { margin-right: auto; }
.ism__eta { font-variant-numeric: tabular-nums; }
.ism__action { padding: 0.45rem 1.1rem; border-radius: 0.75rem; font-size: 0.84rem; }

/* The bubble is too narrow for the painter, and so is a phone: the dialog takes the screen. */
@media (max-width: 640px) {
  .ism { width: 100vw; max-height: none; height: 100dvh; border-radius: 0; }
  .ism__body { flex: 1 1 auto; }
}
</style>
