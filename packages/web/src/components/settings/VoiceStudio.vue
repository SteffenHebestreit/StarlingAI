<template>
  <div class="space-y-3">
    <!-- ── Which voice speaks which language ─────────────────────────────── -->
    <section class="vs-card">
      <div class="vs-head">
        <div>
          <div class="vs-eyebrow">Voice per language</div>
          <div class="vs-hint">The chat speaks each language with this voice. "Any other language" covers the rest.</div>
        </div>
        <button type="button" class="btn-ghost px-3 py-1.5 rounded-xl text-xs" :disabled="loading" @click="refresh">
          {{ loading ? 'Loading…' : 'Refresh' }}
        </button>
      </div>
      <div v-if="loadError" class="vs-error">{{ loadError }}</div>
      <div v-for="language in VOICE_LANGUAGES" :key="language.code" class="vs-row">
        <label class="vs-label" :for="`voice-${language.code}`">{{ language.label }}</label>
        <select :id="`voice-${language.code}`" v-model="assignments[language.code]" class="input-box text-xs">
          <option value="">Service default</option>
          <option v-for="voice in voicesFor(voices, language.code)" :key="voice.id" :value="voice.id">
            {{ voice.name }} — {{ voiceCaption(voice) }}
          </option>
        </select>
        <button
          type="button"
          class="btn-ghost px-3 py-1.5 rounded-xl text-xs"
          :disabled="previewing === language.code"
          @click="preview(language.code, assignments[language.code], language.code === '*' ? 'en' : language.code)"
        >{{ previewing === language.code ? '…' : 'Listen' }}</button>
      </div>
      <div class="vs-actions">
        <span v-if="assignMessage" class="text-xs" :class="assignError ? 'text-red-400' : 'text-green-300'">{{ assignMessage }}</span>
        <button type="button" class="btn-grad px-4 py-1.5 rounded-xl text-xs" :disabled="!assignmentsChanged || savingAssignments" @click="saveAssignments">
          {{ savingAssignments ? 'Saving…' : 'Save voices' }}
        </button>
      </div>
    </section>

    <!-- ── Your own voices ───────────────────────────────────────────────── -->
    <section class="vs-card">
      <div class="vs-eyebrow">Your voices</div>
      <div v-if="ownVoices.length === 0" class="vs-hint">None yet — clone one from a recording or design one below.</div>
      <ul v-else class="divide-y divide-purple-500/10">
        <li v-for="voice in ownVoices" :key="voice.id" class="flex items-center justify-between gap-3 py-2">
          <div class="min-w-0">
            <div class="text-xs font-semibold text-gray-200 truncate">{{ voice.name }}</div>
            <div class="text-[11px] text-gray-500 font-mono truncate">{{ voice.id }}<span v-if="usedFor(voice.id)" class="ml-2 text-purple-300">speaks {{ usedFor(voice.id) }}</span></div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <button type="button" class="text-[11px] text-gray-300 hover:text-white" @click="preview(voice.id, voice.id, languageOf(voice))">Listen</button>
            <button
              type="button"
              class="text-[11px] text-red-400/80 hover:text-red-300 disabled:opacity-40"
              :disabled="Boolean(usedFor(voice.id)) || removing === voice.id"
              :title="usedFor(voice.id) ? `It speaks ${usedFor(voice.id)} — choose another voice for it first` : 'Delete this voice from the speech service'"
              @click="remove(voice)"
            >{{ removing === voice.id ? 'Deleting…' : 'Delete' }}</button>
          </div>
        </li>
      </ul>
      <div class="vs-hint">{{ builtInSummary }}</div>
    </section>

    <!-- ── Clone a voice from a recording ────────────────────────────────── -->
    <section class="vs-card">
      <div class="vs-eyebrow">Clone a voice</div>
      <div class="vs-hint">3–10 seconds of clear speech from one person work best (at most 60 s, 20 MB).</div>
      <div class="vs-grid">
        <label class="vs-field"><span>Name</span><input v-model="clone.name" class="input-box text-xs" placeholder="e.g. Luna" /></label>
        <label class="vs-field">
          <span>Language</span>
          <select v-model="clone.language" class="input-box text-xs">
            <option value="de">German</option>
            <option value="en">English</option>
          </select>
        </label>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <button type="button" class="btn-ghost px-3 py-1.5 rounded-xl text-xs" :disabled="clone.saving" @click="toggleRecording">
          {{ recording ? 'Stop recording' : 'Record from the microphone' }}
        </button>
        <label class="btn-ghost px-3 py-1.5 rounded-xl text-xs cursor-pointer">
          Choose a file
          <input type="file" accept="audio/*" class="hidden" @change="onCloneFile" />
        </label>
        <span v-if="recording" class="vs-meter" aria-hidden="true"><span :style="{ width: `${Math.round(level * 100)}%` }" /></span>
        <span v-if="clone.sampleName && !recording" class="text-[11px] text-gray-400">{{ clone.sampleName }}</span>
      </div>
      <audio v-if="clone.sampleUrl" :src="clone.sampleUrl" controls class="w-full h-8" />
      <fieldset class="space-y-1">
        <label class="vs-choice">
          <input v-model="clone.mode" type="radio" value="xvector" />
          <span><strong>The sound of the voice</strong> — from any recording.</span>
        </label>
        <label class="vs-choice">
          <input v-model="clone.mode" type="radio" value="icl" />
          <span><strong>A closer match</strong> — needs the exact words spoken in the recording.</span>
        </label>
      </fieldset>
      <label class="vs-field">
        <span>Words spoken in the recording <span class="text-gray-600">{{ clone.mode === 'icl' ? 'recommended' : 'optional' }} — left empty, the service transcribes it</span></span>
        <textarea v-model="clone.transcript" rows="2" class="input-box text-xs resize-none" />
      </label>
      <label v-if="clone.conflict" class="vs-choice text-amber-200">
        <input v-model="clone.replace" type="checkbox" />
        <span>Replace the existing voice of this name</span>
      </label>
      <div class="vs-actions">
        <span v-if="clone.message" class="text-xs" :class="clone.error ? 'text-red-400' : 'text-green-300'">{{ clone.message }}</span>
        <button type="button" class="btn-grad px-4 py-1.5 rounded-xl text-xs" :disabled="!canClone" @click="saveClone">
          {{ clone.saving ? 'Saving…' : 'Save voice' }}
        </button>
      </div>
    </section>

    <!-- ── Design a voice from a description ─────────────────────────────── -->
    <section class="vs-card">
      <div class="vs-eyebrow">Design a voice</div>
      <div class="vs-hint">
        Describe a voice and hear it. Designing loads another speech model for about a minute; your saved
        voices pause meanwhile and come back by themselves.
      </div>
      <label class="vs-field">
        <span>Description</span>
        <textarea v-model="design.description" rows="2" class="input-box text-xs resize-none" placeholder="A warm, calm female voice in her thirties, friendly, unhurried" />
      </label>
      <div class="vs-grid">
        <label class="vs-field"><span>What it says</span><input v-model="design.text" class="input-box text-xs" /></label>
        <label class="vs-field">
          <span>Language</span>
          <select v-model="design.language" class="input-box text-xs" @change="design.text = sampleText(design.language)">
            <option value="de">German</option>
            <option value="en">English</option>
          </select>
        </label>
      </div>
      <div class="vs-actions">
        <span v-if="design.message" class="text-xs" :class="design.error ? 'text-red-400' : 'text-green-300'">{{ design.message }}</span>
        <button type="button" class="btn-ghost px-4 py-1.5 rounded-xl text-xs" :disabled="design.busy || !design.description.trim() || !design.text.trim()" @click="runDesign">
          {{ design.busy ? 'Designing… (about a minute)' : 'Design' }}
        </button>
      </div>
      <template v-if="design.audioUrl">
        <audio :src="design.audioUrl" controls class="w-full h-8" />
        <div class="vs-grid">
          <label class="vs-field"><span>Keep it as</span><input v-model="design.name" class="input-box text-xs" placeholder="Name for this voice" /></label>
          <div class="flex items-end justify-end">
            <button type="button" class="btn-grad px-4 py-1.5 rounded-xl text-xs" :disabled="design.saving || !cleanVoiceName(design.name)" @click="saveDesign">
              {{ design.saving ? 'Saving…' : 'Save as voice' }}
            </button>
          </div>
        </div>
      </template>
    </section>

    <!-- ── Training (experimental) ───────────────────────────────────────── -->
    <section class="vs-card">
      <div class="flex items-center gap-2">
        <div class="vs-eyebrow">Train a voice</div>
        <span class="vs-badge">experimental</span>
      </div>
      <!-- The service's own words about its trainer, which it asks not to be overstated. -->
      <div class="vs-warn">
        The speech service says of its trainer: "Experimental trainer: exported voices are NOT production quality."
        The audio it produces "is not expected to be intelligible speech". For a usable voice, clone one above.
      </div>
      <div v-if="training.enabled === false" class="vs-hint">Training is switched off on the speech service (ENABLE_TRAINING).</div>
      <template v-else-if="training.enabled">
        <div class="vs-grid">
          <label class="vs-field"><span>Name (letters, digits, - and _)</span><input v-model="training.name" class="input-box text-xs" placeholder="my_voice" /></label>
          <label class="vs-field">
            <span>Language</span>
            <select v-model="training.language" class="input-box text-xs">
              <option value="de">German</option>
              <option value="en">English</option>
            </select>
          </label>
        </div>
        <label class="vs-field">
          <span>Recordings — one speaker, clean audio; ten minutes or more</span>
          <input type="file" accept="audio/*" multiple class="input-box text-xs" @change="onTrainingFiles" />
        </label>
        <div class="vs-actions">
          <span v-if="training.message" class="text-xs" :class="training.error ? 'text-red-400' : 'text-green-300'">{{ training.message }}</span>
          <button type="button" class="btn-ghost px-4 py-1.5 rounded-xl text-xs" :disabled="!canTrain" @click="startTraining">
            {{ training.starting ? 'Starting…' : 'Start training' }}
          </button>
        </div>
        <ul v-if="training.jobs.length" class="divide-y divide-purple-500/10">
          <li v-for="job in training.jobs" :key="job.id" class="py-2 space-y-1">
            <div class="flex items-center justify-between gap-2 text-xs">
              <span class="text-gray-200">{{ job.modelName ?? job.id }} <span class="text-gray-500">· {{ job.status }}</span></span>
              <button v-if="isActive(job)" type="button" class="text-[11px] text-red-400/80 hover:text-red-300" @click="cancelTraining(job.id)">Cancel</button>
            </div>
            <div v-if="job.progress !== undefined" class="vs-progress"><span :style="{ width: `${Math.min(100, Math.max(0, job.progress))}%` }" /></div>
            <div class="text-[11px] text-gray-500">
              <template v-if="job.currentEpoch !== undefined && job.totalEpochs">Epoch {{ job.currentEpoch }} of {{ job.totalEpochs }}</template>
              <template v-if="job.message"> · {{ job.message }}</template>
            </div>
          </li>
        </ul>
      </template>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { useGatewayStore, type HubVoiceInfo, type VoiceTrainingJob } from "@/stores/gateway";
import { useMultimodalStore } from "@/stores/multimodal";
import { unlockAudio } from "@/speech/audioOutput";
import { VoiceCapture } from "@/speech/voiceCapture";
import { VOICE_LANGUAGES, cleanVoiceName, voiceCaption, voicesFor } from "./voicePresets";

const gateway = useGatewayStore();
const multimodal = useMultimodalStore();

const voices = ref<HubVoiceInfo[]>([]);
const engines = ref<string[]>([]);
const loading = ref(false);
const loadError = ref("");

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function refresh(): Promise<void> {
  loading.value = true;
  loadError.value = "";
  try {
    const catalog = await gateway.listHubVoices();
    voices.value = catalog.voices;
    engines.value = catalog.engines;
  } catch (error) {
    loadError.value = errorText(error);
  } finally {
    loading.value = false;
  }
}

// ── Voice per language ──────────────────────────────────────────────────────
const configured = computed<Record<string, string>>(() => ({ ...(multimodal.config.tts.voices ?? {}) }));
const assignments = reactive<Record<string, string>>({});
function resetAssignments(): void {
  for (const language of VOICE_LANGUAGES) assignments[language.code] = configured.value[language.code] ?? "";
}
const assignmentsChanged = computed(() => VOICE_LANGUAGES.some((language) => (assignments[language.code] ?? "") !== (configured.value[language.code] ?? "")));
const savingAssignments = ref(false);
const assignMessage = ref("");
const assignError = ref(false);

async function saveAssignments(): Promise<void> {
  savingAssignments.value = true;
  assignMessage.value = "";
  // A merge patch: a language set back to the service default is removed with null.
  const patch: Record<string, string | null> = {};
  for (const language of VOICE_LANGUAGES) patch[language.code] = assignments[language.code] || null;
  await multimodal.save({ tts: { voices: patch } });
  savingAssignments.value = false;
  assignError.value = Boolean(multimodal.error);
  assignMessage.value = multimodal.error || "Saved — the chat speaks with these voices now.";
  if (!multimodal.error) resetAssignments();
}

/** The languages a voice speaks in the chat ("German, English"), or "". */
function usedFor(id: string): string {
  return VOICE_LANGUAGES.filter((language) => configured.value[language.code] === id).map((language) => language.label).join(", ");
}

// ── Listening ───────────────────────────────────────────────────────────────
const previewing = ref<string | null>(null);
let previewAudio: HTMLAudioElement | null = null;
let previewUrl: string | null = null;

function stopPreview(): void {
  previewAudio?.pause();
  previewAudio = null;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
}

function sampleText(code: string): string {
  return VOICE_LANGUAGES.find((language) => language.code === code)?.sample ?? VOICE_LANGUAGES[1]!.sample;
}

/** The language a voice is heard in when listened to: its own, German for a German voice. */
function languageOf(voice: HubVoiceInfo): string {
  return /^(de|german)/i.test(voice.language ?? "") ? "de" : "en";
}

async function preview(key: string, voice: string | undefined, language: string): Promise<void> {
  unlockAudio();
  stopPreview();
  previewing.value = key;
  try {
    const blob = await gateway.synthesizeSpeech({ text: sampleText(language), language, ...(voice ? { voice } : {}) });
    previewUrl = URL.createObjectURL(blob);
    previewAudio = new Audio(previewUrl);
    await previewAudio.play();
  } catch (error) {
    loadError.value = errorText(error);
  } finally {
    previewing.value = null;
  }
}

// ── Your voices ─────────────────────────────────────────────────────────────
const ownVoices = computed(() => voices.value.filter((voice) => voice.kind === "saved" || voice.kind === "custom"));
const builtInSummary = computed(() => {
  const builtIn = voices.value.filter((voice) => voice.kind === "builtin");
  if (!builtIn.length) return "";
  const from = [...new Set(builtIn.map((voice) => voice.engine))].join(", ");
  return `Plus ${builtIn.length} built-in voices (${from}) to choose from above.`;
});
const removing = ref<string | null>(null);

async function remove(voice: HubVoiceInfo): Promise<void> {
  if (!window.confirm(`Delete the voice "${voice.name}" from the speech service? This cannot be undone.`)) return;
  removing.value = voice.id;
  try {
    await gateway.removeTtsVoice(voice.id);
    await refresh();
  } catch (error) {
    loadError.value = errorText(error);
  } finally {
    removing.value = null;
  }
}

// ── Clone ───────────────────────────────────────────────────────────────────
const clone = reactive({
  name: "",
  language: "de",
  mode: "xvector" as "xvector" | "icl",
  transcript: "",
  sample: null as Blob | null,
  sampleName: "",
  sampleUrl: "",
  replace: false,
  conflict: false,
  saving: false,
  message: "",
  error: false,
});
const recording = ref(false);
const level = ref(0);
let capture: VoiceCapture | null = null;

function setSample(blob: Blob, name: string): void {
  if (clone.sampleUrl) URL.revokeObjectURL(clone.sampleUrl);
  clone.sample = blob;
  clone.sampleName = name;
  clone.sampleUrl = URL.createObjectURL(blob);
}

function stopCapture(): void {
  capture?.close();
  capture = null;
  recording.value = false;
  level.value = 0;
}

async function toggleRecording(): Promise<void> {
  if (recording.value) {
    capture?.finish();
    return;
  }
  unlockAudio();
  clone.message = "";
  // Long pauses are part of reading a passage; Stop (or a minute) ends it. 24 kHz: the model's rate.
  const next = new VoiceCapture({
    onUtterance: (utterance) => {
      stopCapture();
      if (!utterance) {
        clone.error = true;
        clone.message = "No speech was heard. Speak a little longer and try again.";
        return;
      }
      setSample(utterance.audio, `Recording (${Math.round(utterance.speechMs / 1000)} s of speech)`);
    },
    onLevel: (value) => { level.value = value; },
  }, { endSilenceMs: 6_000, noSpeechTimeoutMs: 12_000, wavRate: 24_000 });
  try {
    await next.open();
  } catch (error) {
    clone.error = true;
    clone.message = errorText(error);
    return;
  }
  capture = next;
  recording.value = true;
  next.record();
}

function onCloneFile(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (file) setSample(file, file.name);
}

const canClone = computed(() => Boolean(clone.sample && cleanVoiceName(clone.name) && !clone.saving && !recording.value && (!clone.conflict || clone.replace)));

async function saveClone(): Promise<void> {
  if (!clone.sample) return;
  clone.saving = true;
  clone.message = "";
  try {
    const saved = await gateway.cloneHubVoice({
      name: cleanVoiceName(clone.name),
      audio: clone.sample,
      filename: clone.sample instanceof File ? clone.sample.name : "recording.wav",
      language: clone.language,
      mode: clone.mode,
      ...(clone.transcript.trim() ? { referenceText: clone.transcript.trim() } : {}),
      ...(clone.replace ? { replace: true } : {}),
    });
    clone.error = false;
    clone.conflict = false;
    clone.replace = false;
    clone.message = `Saved "${saved.name}". Choose it above to have the chat speak with it.`;
    if (!clone.transcript.trim() && saved.referenceText) clone.transcript = saved.referenceText;
    await refresh();
  } catch (error) {
    clone.error = true;
    clone.message = errorText(error);
    clone.conflict = /already exists/i.test(clone.message);
  } finally {
    clone.saving = false;
  }
}

// ── Design ──────────────────────────────────────────────────────────────────
const design = reactive({
  description: "",
  text: sampleText("de"),
  language: "de",
  audio: null as Blob | null,
  audioUrl: "",
  name: "",
  busy: false,
  saving: false,
  message: "",
  error: false,
});

async function runDesign(): Promise<void> {
  design.busy = true;
  design.message = "";
  try {
    const audio = await gateway.designHubVoice({ description: design.description.trim(), text: design.text.trim(), language: design.language });
    if (design.audioUrl) URL.revokeObjectURL(design.audioUrl);
    design.audio = audio;
    design.audioUrl = URL.createObjectURL(audio);
    design.error = false;
  } catch (error) {
    design.error = true;
    design.message = errorText(error);
  } finally {
    design.busy = false;
  }
}

/** A designed voice is kept by cloning its own audio, with the words it spoke as the transcript. */
async function saveDesign(): Promise<void> {
  if (!design.audio) return;
  design.saving = true;
  design.message = "";
  try {
    const saved = await gateway.cloneHubVoice({
      name: cleanVoiceName(design.name),
      audio: design.audio,
      filename: "designed.wav",
      language: design.language,
      referenceText: design.text.trim(),
      mode: "icl",
    });
    design.error = false;
    design.message = `Saved "${saved.name}". Choose it above to have the chat speak with it.`;
    await refresh();
  } catch (error) {
    design.error = true;
    design.message = errorText(error);
  } finally {
    design.saving = false;
  }
}

// ── Training ────────────────────────────────────────────────────────────────
const training = reactive({
  enabled: undefined as boolean | undefined,
  jobs: [] as VoiceTrainingJob[],
  name: "",
  language: "de",
  files: [] as File[],
  starting: false,
  message: "",
  error: false,
});
let trainingTimer: number | null = null;
const FINISHED = new Set(["completed", "failed", "cancelled", "interrupted"]);
const isActive = (job: VoiceTrainingJob) => !FINISHED.has(job.status);

async function loadTraining(): Promise<void> {
  try {
    const result = await gateway.listTrainingJobs();
    training.enabled = result.enabled;
    training.jobs = result.jobs;
  } catch (error) {
    training.error = true;
    training.message = errorText(error);
  }
  const active = training.jobs.some(isActive);
  if (active && trainingTimer === null) trainingTimer = window.setInterval(() => { void loadTraining(); }, 10_000);
  if (!active && trainingTimer !== null) {
    window.clearInterval(trainingTimer);
    trainingTimer = null;
    void refresh();
  }
}

function onTrainingFiles(event: Event): void {
  training.files = Array.from((event.target as HTMLInputElement).files ?? []);
}

const canTrain = computed(() => /^[A-Za-z0-9_-]{1,64}$/.test(training.name) && training.files.length > 0 && !training.starting);

async function startTraining(): Promise<void> {
  training.starting = true;
  training.message = "";
  try {
    await gateway.startVoiceTraining({ name: training.name, language: training.language, files: training.files });
    training.error = false;
    training.message = "Training started. It takes hours; the voice appears under Your voices when it is done.";
    await loadTraining();
  } catch (error) {
    training.error = true;
    training.message = errorText(error);
  } finally {
    training.starting = false;
  }
}

async function cancelTraining(jobId: string): Promise<void> {
  try {
    await gateway.cancelVoiceTraining(jobId);
    await loadTraining();
  } catch (error) {
    training.error = true;
    training.message = errorText(error);
  }
}

onMounted(() => {
  resetAssignments();
  void refresh();
  void loadTraining();
});

onBeforeUnmount(() => {
  stopPreview();
  stopCapture();
  if (trainingTimer !== null) window.clearInterval(trainingTimer);
  for (const url of [clone.sampleUrl, design.audioUrl]) if (url) URL.revokeObjectURL(url);
});
</script>

<style scoped>
.vs-card {
  display: grid;
  gap: 0.6rem;
  padding: 0.75rem;
  border-radius: 0.75rem;
  border: 1px solid rgba(168, 85, 247, 0.1);
  background: rgba(3, 7, 18, 0.4);
}
.vs-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.75rem; }
.vs-eyebrow { font-size: 0.72rem; letter-spacing: 0.18em; text-transform: uppercase; color: rgb(107 114 128); }
.vs-hint { font-size: 0.72rem; color: rgb(107 114 128); }
.vs-error { font-size: 0.72rem; color: rgb(252 165 165); border: 1px solid rgba(239, 68, 68, 0.2); background: rgba(239, 68, 68, 0.1); border-radius: 0.5rem; padding: 0.4rem 0.6rem; }
.vs-warn { font-size: 0.72rem; color: rgb(253 230 138); border: 1px solid rgba(245, 158, 11, 0.22); background: rgba(245, 158, 11, 0.08); border-radius: 0.5rem; padding: 0.45rem 0.6rem; }
.vs-badge { font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.08em; color: rgb(253 230 138); border: 1px solid rgba(245, 158, 11, 0.35); border-radius: 9999px; padding: 0.05rem 0.45rem; }
.vs-row { display: grid; grid-template-columns: 9rem minmax(0, 1fr) auto; align-items: center; gap: 0.5rem; }
.vs-label { font-size: 0.75rem; color: rgb(156 163 175); }
.vs-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.6rem; }
.vs-field { display: grid; gap: 0.3rem; font-size: 0.72rem; color: rgb(156 163 175); }
.vs-choice { display: flex; align-items: baseline; gap: 0.45rem; font-size: 0.74rem; color: rgb(203 213 225); }
.vs-actions { display: flex; align-items: center; justify-content: flex-end; gap: 0.6rem; flex-wrap: wrap; }
.vs-meter, .vs-progress { display: inline-block; width: 5rem; height: 0.22rem; border-radius: 9999px; background: rgba(56, 189, 248, 0.12); overflow: hidden; }
.vs-progress { width: 100%; }
.vs-meter > span, .vs-progress > span { display: block; height: 100%; background: rgb(56 189 248); border-radius: inherit; transition: width 0.1s linear; }
@media (max-width: 640px) {
  .vs-row { grid-template-columns: minmax(0, 1fr) auto; }
  .vs-label { grid-column: 1 / -1; }
  .vs-grid { grid-template-columns: 1fr; }
}
</style>
