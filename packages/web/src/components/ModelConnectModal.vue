<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" @click="close" />

      <div class="relative z-[81] w-full max-w-lg overflow-hidden rounded-2xl border border-white/10 bg-gray-950/95 shadow-2xl shadow-black/50">
        <div class="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div class="flex items-center gap-2">
            <span class="inline-block h-2 w-2 rounded-full" :class="connected ? 'bg-emerald-400' : 'bg-orange-400'" />
            <h2 class="text-sm font-semibold text-gray-100">Connect Claude subscription</h2>
          </div>
          <button class="rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-gray-400 transition hover:border-white/20 hover:text-gray-200" @click="close">
            Close
          </button>
        </div>

        <div class="px-5 py-4 text-sm text-gray-300">
          <!-- Already connected -->
          <template v-if="connected">
            <p class="text-emerald-300">Your Claude subscription is connected.</p>
            <p v-if="store.oauthExpiresAt" class="mt-1 text-[12px] text-gray-500">
              Access token renews automatically · expires {{ formatExpiry(store.oauthExpiresAt) }}
            </p>
            <p class="mt-3 text-[12px] leading-5 text-gray-400">
              The "Local ⇄ Claude" switch in the header now controls whether the swarm runs on Claude.
              Disconnecting clears the stored token and reverts to your local model.
            </p>

            <div class="mt-4 flex justify-end gap-2">
              <button
                class="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[12px] font-medium text-red-200 transition hover:bg-red-500/20 disabled:opacity-50"
                :disabled="store.oauthBusy"
                @click="disconnect"
              >
                Disconnect
              </button>
            </div>
          </template>

          <!-- Connect flow -->
          <template v-else>
            <p class="leading-5">
              Sign in with your Claude Pro/Max account to run the swarm on Claude models, billed to your
              subscription. This uses the same browser login as Claude Code — no API key needed.
            </p>

            <ol class="mt-4 space-y-3">
              <li class="flex gap-3">
                <span class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/10 text-[11px] text-gray-300">1</span>
                <div class="min-w-0 flex-1">
                  <button
                    class="rounded-lg border border-orange-400/30 bg-orange-500/15 px-3 py-1.5 text-[12px] font-medium text-orange-100 transition hover:bg-orange-500/25 disabled:opacity-50"
                    :disabled="store.oauthBusy"
                    @click="openAuthorize"
                  >
                    Open Claude authorization →
                  </button>
                  <p class="mt-1 text-[12px] text-gray-500">
                    Opens claude.ai in a new tab. Approve access, then copy the code it shows you.
                  </p>
                </div>
              </li>
              <li class="flex gap-3">
                <span class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/10 text-[11px] text-gray-300">2</span>
                <div class="min-w-0 flex-1">
                  <label class="block text-[12px] text-gray-400">Paste the authorization code</label>
                  <input
                    v-model="code"
                    type="text"
                    autocomplete="off"
                    spellcheck="false"
                    placeholder="code#state"
                    class="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 font-mono text-[12px] text-gray-100 outline-none transition focus:border-orange-400/40"
                    :disabled="!started || store.oauthBusy"
                    @keyup.enter="complete"
                  />
                </div>
              </li>
            </ol>

            <p v-if="store.oauthError" class="mt-3 text-[12px] text-red-300">{{ store.oauthError }}</p>

            <div class="mt-4 flex justify-end gap-2">
              <button
                class="rounded-lg border border-white/10 px-3 py-1.5 text-[12px] text-gray-300 transition hover:border-white/20 hover:text-white"
                @click="close"
              >
                Cancel
              </button>
              <button
                class="rounded-lg border border-emerald-400/30 bg-emerald-500/15 px-3 py-1.5 text-[12px] font-medium text-emerald-100 transition hover:bg-emerald-500/25 disabled:opacity-50"
                :disabled="!started || !code.trim() || store.oauthBusy"
                @click="complete"
              >
                {{ store.oauthBusy ? "Connecting…" : "Connect" }}
              </button>
            </div>

            <p class="mt-4 border-t border-white/10 pt-3 text-[11px] leading-4 text-gray-500">
              The token is stored encrypted on your gateway and only ever sent to Anthropic. Note: while
              Claude is active, agent context (messages, documents, tool results) is sent to Anthropic
              instead of staying on your machine. Subscription login is intended for Claude Code; an API
              key (providers.anthropic.apiKey) is the alternative.
            </p>
          </template>

          <!-- Claude model picker — which model the "Claude" preset runs.
               Shown whenever Claude is usable (subscription OR API key). -->
          <div v-if="connected || claudePresetExists" class="mt-4 border-t border-white/10 pt-4">
            <label class="block text-[12px] font-medium text-gray-300">Claude model</label>
            <p class="mt-0.5 text-[11px] text-gray-500">
              Used by the header switch. Applies immediately — even mid-session — and persists.
            </p>
            <div class="mt-2 flex items-center gap-2">
              <select
                v-model="selectedModel"
                class="min-w-0 flex-1 rounded-lg border border-white/10 bg-gray-900 px-2.5 py-2 text-[12px] text-gray-100 outline-none transition focus:border-orange-400/40"
                :disabled="store.modelSaving"
              >
                <option v-for="choice in store.anthropicModelChoices" :key="choice.id" :value="choice.id">
                  {{ choice.label }} — {{ choice.hint }}
                </option>
                <option value="__custom__">Custom model id…</option>
              </select>
              <button
                class="shrink-0 rounded-lg border border-emerald-400/30 bg-emerald-500/15 px-3 py-2 text-[12px] font-medium text-emerald-100 transition hover:bg-emerald-500/25 disabled:opacity-50"
                :disabled="store.modelSaving || !effectiveModel || effectiveModel === store.anthropicModel"
                @click="saveModel"
              >
                {{ store.modelSaving ? "Saving…" : "Save" }}
              </button>
            </div>
            <input
              v-if="selectedModel === '__custom__'"
              v-model="customModel"
              type="text"
              autocomplete="off"
              spellcheck="false"
              placeholder="claude-…"
              class="mt-2 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 font-mono text-[12px] text-gray-100 outline-none transition focus:border-orange-400/40"
              :disabled="store.modelSaving"
            />
            <p class="mt-1.5 text-[11px] text-gray-500">
              Current: <span class="font-mono text-gray-400">{{ store.anthropicModel }}</span>
            </p>
            <p v-if="store.modelError" class="mt-1.5 text-[11px] text-red-300">{{ store.modelError }}</p>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useModelPresetStore } from "@/stores/modelPreset";

const emit = defineEmits<{ close: []; connected: [] }>();

const store = useModelPresetStore();
const connected = computed(() => store.oauthConnected);
const claudePresetExists = computed(() => store.presets.some((p) => p.name === "claude"));

const code = ref("");
const started = ref(false);
const verifier = ref("");
const state = ref("");

// Model picker: dropdown of curated choices + free-text escape hatch.
const selectedModel = ref(store.anthropicModel);
const customModel = ref("");
const effectiveModel = computed(() =>
  selectedModel.value === "__custom__" ? customModel.value.trim() : selectedModel.value,
);

onMounted(() => {
  void store.fetchAnthropicModel();
});

// Re-sync the dropdown when the stored model arrives/changes; fall back to
// the custom field for ids outside the curated list.
watch(
  () => [store.anthropicModel, store.anthropicModelChoices] as const,
  ([model, choices]) => {
    if (choices.some((c) => c.id === model)) {
      selectedModel.value = model;
    } else if (model) {
      selectedModel.value = "__custom__";
      customModel.value = model;
    }
  },
  { immediate: true },
);

async function saveModel(): Promise<void> {
  if (!effectiveModel.value) return;
  await store.setAnthropicModel(effectiveModel.value);
}

async function openAuthorize(): Promise<void> {
  const flow = await store.startOAuth();
  if (!flow) return;
  verifier.value = flow.verifier;
  state.value = flow.state;
  started.value = true;
  window.open(flow.authorizeUrl, "_blank", "noopener");
}

async function complete(): Promise<void> {
  if (!started.value || !code.value.trim()) return;
  const ok = await store.completeOAuth(code.value.trim(), verifier.value, state.value);
  if (ok) {
    emit("connected");
    emit("close");
  }
}

async function disconnect(): Promise<void> {
  await store.disconnectOAuth();
  if (!store.oauthConnected) emit("close");
}

function close(): void {
  emit("close");
}

function formatExpiry(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}
</script>
