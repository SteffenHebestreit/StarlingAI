<template>
  <div class="settings-page">

    <div class="settings-grid">

      <!-- ══ LEFT COLUMN ══════════════════════════════════════════════════════ -->
      <div class="space-y-5">

        <!-- ── Gateway Connection ─────────────────────────────────────────── -->
        <div class="glass-card p-5">
          <h3 class="section-title">Gateway Connection</h3>
          <div class="space-y-4">
            <div>
              <label class="field-label">WebSocket URL</label>
              <input v-model="gateway.wsUrl" type="text" class="input-box" />
            </div>
            <div>
              <label class="field-label">Token</label>
              <input v-model="gateway.token" type="password" class="input-box" autocomplete="current-password" />
            </div>
            <div class="flex gap-2 pt-1">
              <button @click="gateway.connect()" class="btn-grad px-4 py-2 rounded-xl text-sm">Reconnect</button>
              <button @click="gateway.disconnect()" class="btn-ghost px-4 py-2 rounded-xl text-sm">Disconnect</button>
            </div>
          </div>
        </div>

        <!-- ── Status ─────────────────────────────────────────────────────── -->
        <div class="glass-card p-5">
          <h3 class="section-title">Status</h3>
          <div class="space-y-3 text-sm">
            <div class="flex justify-between items-center">
              <span class="text-gray-400">Gateway</span>
              <div class="flex items-center gap-2">
                <span :class="['status-dot', gateway.connected ? 'status-dot--on' : 'status-dot--off']" />
                <span :class="gateway.connected ? 'text-green-400' : 'text-red-400'">
                  {{ gateway.connected ? 'Connected' : 'Disconnected' }}
                </span>
              </div>
            </div>
            <div class="border-t border-purple-500/10" />
            <div class="flex justify-between items-center">
              <span class="text-gray-400">Active Session</span>
              <span class="font-mono text-xs text-gray-300 bg-gray-800/60 px-2 py-1 rounded-lg">
                {{ gateway.currentSessionId?.substring(0, 12) ?? 'None' }}
              </span>
            </div>
            <div class="border-t border-purple-500/10" />
            <div class="flex justify-between items-center">
              <span class="text-gray-400">Runtime Sync</span>
              <div class="flex items-center gap-2">
                <span :class="['status-dot', runtime.snapshot?.healthy ? 'status-dot--on' : 'status-dot--off']" />
                <span :class="runtime.snapshot?.healthy ? 'text-green-400' : 'text-amber-400'">
                  {{ runtime.snapshot?.healthy ? 'Healthy' : 'Needs Attention' }}
                </span>
              </div>
            </div>
            <div v-if="runtime.loading" class="text-xs text-gray-500">Loading runtime status…</div>
            <div v-else-if="runtime.error" class="text-xs text-red-400">{{ runtime.error }}</div>
            <div v-else-if="runtime.snapshot" class="space-y-1.5 pt-1">
              <div v-for="component in runtime.snapshot.components" :key="component.name" class="flex items-start justify-between gap-3 text-xs">
                <div class="min-w-0">
                  <div class="text-gray-300">{{ formatRuntimeName(component.name) }}</div>
                  <div v-if="component.lastError" class="text-red-400 truncate" :title="component.lastError">{{ component.lastError }}</div>
                </div>
                <span :class="component.healthy ? 'text-green-400' : 'text-amber-400'">{{ component.healthy ? 'ok' : 'degraded' }}</span>
              </div>
            </div>
            <div class="border-t border-purple-500/10" />
            <div class="flex justify-between items-center">
              <span class="text-gray-400">Model Endpoints</span>
              <div class="flex items-center gap-2">
                <span :class="['status-dot', runtime.modelEndpoints?.healthy ? 'status-dot--on' : 'status-dot--off']" />
                <span :class="runtime.modelEndpoints?.healthy ? 'text-green-400' : 'text-amber-400'">
                  {{ runtime.modelEndpoints?.healthy ? 'Healthy' : 'Needs Attention' }}
                </span>
              </div>
            </div>
            <div v-if="runtime.modelEndpointError" class="text-xs text-red-400">{{ runtime.modelEndpointError }}</div>
            <div v-else-if="runtime.modelEndpoints?.endpoints?.length" class="space-y-2 pt-1">
              <div v-for="endpoint in runtime.modelEndpoints.endpoints" :key="`${endpoint.role}-${endpoint.baseUrl}-${endpoint.model}`" class="model-endpoint-row">
                <div class="min-w-0">
                  <div class="text-gray-300 text-xs">{{ formatModelEndpointRole(endpoint.role) }}</div>
                  <div class="text-[11px] text-gray-500 font-mono truncate" :title="endpoint.model">{{ endpoint.model }}</div>
                  <div class="text-[11px] text-gray-600 font-mono truncate" :title="endpoint.baseUrl">{{ endpoint.baseUrl }}</div>
                  <div v-if="endpoint.error" class="text-[11px] text-red-400 truncate" :title="endpoint.error">{{ endpoint.error }}</div>
                </div>
                <span :class="endpoint.ok ? 'text-green-400' : 'text-amber-400'" class="text-xs shrink-0">{{ endpoint.ok ? 'ok' : 'down' }}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="glass-card p-5">
          <div class="flex items-center justify-between mb-4 gap-3">
            <div>
              <h3 class="section-title mb-0">Multimodal</h3>
              <div class="text-xs text-gray-500 mt-1">Set file ingestion, STT, TTS, and wake-word defaults.</div>
            </div>
            <div class="flex items-center gap-2">
              <button v-if="gateway.connected" @click="multimodalStore.fetch()" :disabled="multimodalStore.loading || multimodalStore.saving" class="btn-ghost px-3 py-1.5 rounded-lg text-xs">Reload</button>
              <button @click="resetMultimodalForm" :disabled="multimodalStore.loading || multimodalStore.saving" class="btn-ghost px-3 py-1.5 rounded-lg text-xs">Reset</button>
            </div>
          </div>

          <div v-if="!gateway.connected" class="empty-state">Connect to configure multimodal services.</div>
          <div v-else-if="multimodalStore.loading && !multimodalLoaded" class="empty-state">Loading…</div>
          <div v-else class="space-y-4">
            <div class="rounded-xl border border-cyan-500/15 bg-cyan-500/5 px-3 py-2 text-xs text-cyan-100/80">
              Saving here updates <span class="font-mono text-cyan-200">starlingai.json</span> and syncs the browser wake-word settings used by chat.
            </div>

            <div v-if="multimodalStore.status" class="multimodal-health-panel">
              <div class="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <div class="text-xs uppercase tracking-[0.18em] text-gray-500">Service Health</div>
                  <div class="text-xs text-gray-500 mt-1">Chat icons only appear when the corresponding backend is reachable.</div>
                </div>
                <button @click="multimodalStore.fetchStatus()" :disabled="multimodalStore.statusLoading || multimodalStore.loading || multimodalStore.saving" class="btn-ghost px-3 py-1.5 rounded-lg text-xs">
                  {{ multimodalStore.statusLoading ? 'Checking…' : 'Check Health' }}
                </button>
              </div>

              <div class="mt-3 multimodal-health-grid">
                <div class="multimodal-health-card">
                  <div class="flex items-center justify-between gap-2">
                    <span class="text-gray-300 text-sm">Files</span>
                    <span :class="multimodalStore.status.files.ok ? 'badge-running' : 'badge-health-bad'">
                      {{ multimodalStore.status.files.ok ? 'available' : 'offline' }}
                    </span>
                  </div>
                  <div class="mt-2 text-[11px] text-gray-500 font-mono break-all">{{ multimodalForm.filesBaseUrl }}</div>
                  <div v-if="multimodalStore.status.files.error" class="mt-1 text-[11px] text-red-300">{{ multimodalStore.status.files.error }}</div>
                </div>

                <div v-if="multimodalStore.status.vision !== null" class="multimodal-health-card">
                  <div class="flex items-center justify-between gap-2">
                    <span class="text-gray-300 text-sm">Vision</span>
                    <span :class="multimodalStore.status.vision?.ok ? 'badge-running' : 'badge-health-bad'">
                      {{ multimodalStore.status.vision?.ok ? 'available' : 'offline' }}
                    </span>
                  </div>
                  <div class="mt-2 text-[11px] text-gray-500 font-mono break-all">{{ multimodalForm.visionBaseUrl || multimodalForm.filesBaseUrl }}</div>
                  <div class="mt-1 text-[11px] text-gray-600 font-mono break-all">{{ multimodalForm.visionModel || 'uses default model' }}</div>
                  <div v-if="multimodalStore.status.vision?.error" class="mt-1 text-[11px] text-red-300">{{ multimodalStore.status.vision.error }}</div>
                </div>

                <div class="multimodal-health-card">
                  <div class="flex items-center justify-between gap-2">
                    <span class="text-gray-300 text-sm">Speech To Text</span>
                    <span :class="multimodalStore.status.stt.ok ? 'badge-running' : 'badge-health-bad'">
                      {{ multimodalStore.status.stt.ok ? 'available' : 'offline' }}
                    </span>
                  </div>
                  <div class="mt-2 text-[11px] text-gray-500 font-mono break-all">{{ multimodalForm.sttBaseUrl }}</div>
                  <div v-if="multimodalStore.status.stt.error" class="mt-1 text-[11px] text-red-300">{{ multimodalStore.status.stt.error }}</div>
                </div>

                <div class="multimodal-health-card">
                  <div class="flex items-center justify-between gap-2">
                    <span class="text-gray-300 text-sm">Text To Speech</span>
                    <span :class="multimodalStore.status.tts.ok ? 'badge-running' : 'badge-health-bad'">
                      {{ multimodalStore.status.tts.ok ? 'available' : 'offline' }}
                    </span>
                  </div>
                  <div class="mt-2 text-[11px] text-gray-500 font-mono break-all">{{ multimodalForm.ttsBaseUrl }}</div>
                  <div v-if="multimodalStore.status.tts.error" class="mt-1 text-[11px] text-red-300">{{ multimodalStore.status.tts.error }}</div>
                </div>

                <div v-if="multimodalStore.status.imageGeneration !== null" class="multimodal-health-card">
                  <div class="flex items-center justify-between gap-2">
                    <span class="text-gray-300 text-sm">Image Generation</span>
                    <span :class="multimodalStore.status.imageGeneration?.ok ? 'badge-running' : 'badge-health-bad'">
                      {{ multimodalStore.status.imageGeneration?.ok ? 'available' : 'offline' }}
                    </span>
                  </div>
                  <div class="mt-2 text-[11px] text-gray-500 font-mono break-all">{{ multimodalForm.imageGenBaseUrl }}</div>
                  <div v-if="multimodalStore.status.imageGeneration?.error" class="mt-1 text-[11px] text-red-300">{{ multimodalStore.status.imageGeneration.error }}</div>
                </div>
              </div>
            </div>

            <div class="multimodal-grid">
              <div>
                <label class="field-label">Max Upload Bytes</label>
                <input v-model.number="multimodalForm.maxUploadBytes" type="number" min="1024" class="input-box" />
              </div>
              <div>
                <label class="field-label">Wake Language</label>
                <select v-model="multimodalForm.wakeLanguage" class="input-box">
                  <option value="en-US">English (US)</option>
                  <option value="de-DE">German</option>
                  <option value="pl-PL">Polish</option>
                </select>
              </div>
            </div>

            <div class="border-t border-purple-500/10 pt-3 space-y-3">
              <div class="text-xs uppercase tracking-[0.18em] text-gray-500">File Conversion</div>
              <div class="multimodal-grid">
                <div class="md:col-span-2">
                  <label class="field-label">Files Endpoint</label>
                  <input v-model="multimodalForm.filesBaseUrl" type="text" class="input-box font-mono" placeholder="http://host.docker.internal:8010" />
                </div>
                <div>
                  <label class="field-label">Tool Name</label>
                  <input v-model="multimodalForm.fileToolName" type="text" class="input-box font-mono" placeholder="file_to_markdown" />
                </div>
                <div>
                  <label class="field-label">Timeout (ms)</label>
                  <input v-model.number="multimodalForm.filesTimeoutMs" type="number" min="1000" class="input-box" />
                </div>
                <div class="md:col-span-2">
                  <label class="field-label">API Key <span class="text-gray-600 font-normal">optional</span></label>
                  <input v-model="multimodalForm.filesApiKey" type="password" class="input-box" autocomplete="off" placeholder="Bearer token if required" />
                </div>
                <div class="md:col-span-2 border-t border-purple-500/10 pt-3 mt-1">
                  <div class="text-xs uppercase tracking-[0.18em] text-gray-500 mb-3">Vision Fallback</div>
                  <div class="multimodal-grid">
                    <div class="md:col-span-2">
                      <label class="field-label">Vision Model <span class="text-gray-600 font-normal">optional</span></label>
                      <input v-model="multimodalForm.visionModel" type="text" class="input-box font-mono" placeholder="lmstudio/qwen/qwen3.5-9b or Qwen/Qwen2.5-VL-7B-Instruct" />
                    </div>
                    <div class="md:col-span-2">
                      <label class="field-label">Vision Endpoint <span class="text-gray-600 font-normal">optional override</span></label>
                      <input v-model="multimodalForm.visionBaseUrl" type="text" class="input-box font-mono" placeholder="defaults to orchestrator endpoint" />
                    </div>
                    <div class="md:col-span-2">
                      <label class="field-label">Vision API Key <span class="text-gray-600 font-normal">optional</span></label>
                      <input v-model="multimodalForm.visionApiKey" type="password" class="input-box" autocomplete="off" placeholder="uses provider or dedicated vision key" />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div class="border-t border-purple-500/10 pt-3 space-y-3">
              <div class="text-xs uppercase tracking-[0.18em] text-gray-500">Speech To Text</div>
              <div class="multimodal-grid">
                <div class="md:col-span-2">
                  <label class="field-label">STT Endpoint</label>
                  <input v-model="multimodalForm.sttBaseUrl" type="text" class="input-box font-mono" placeholder="http://host.docker.internal:8000" />
                </div>
                <div>
                  <label class="field-label">Model</label>
                  <input v-model="multimodalForm.sttModel" type="text" class="input-box font-mono" placeholder="Qwen/Qwen3-ASR-1.7B" />
                </div>
                <div>
                  <label class="field-label">Timeout (ms)</label>
                  <input v-model.number="multimodalForm.sttTimeoutMs" type="number" min="1000" class="input-box" />
                </div>
                <div class="md:col-span-2">
                  <label class="field-label">API Key <span class="text-gray-600 font-normal">optional</span></label>
                  <input v-model="multimodalForm.sttApiKey" type="password" class="input-box" autocomplete="off" placeholder="Bearer token if required" />
                </div>
              </div>
            </div>

            <div class="border-t border-purple-500/10 pt-3 space-y-3">
              <div class="text-xs uppercase tracking-[0.18em] text-gray-500">Text To Speech</div>
              <div class="multimodal-grid">
                <div class="md:col-span-2">
                  <label class="field-label">TTS Endpoint</label>
                  <input v-model="multimodalForm.ttsBaseUrl" type="text" class="input-box font-mono" placeholder="http://host.docker.internal:5000" />
                </div>
                <div>
                  <label class="field-label">Model <span class="text-gray-600 font-normal">optional</span></label>
                  <input v-model="multimodalForm.ttsModel" type="text" class="input-box font-mono" placeholder="service default" />
                </div>
                <div>
                  <label class="field-label">Default Language</label>
                  <input v-model="multimodalForm.ttsDefaultLanguage" type="text" class="input-box font-mono" placeholder="English" />
                </div>
                <div>
                  <label class="field-label">Default Speaker</label>
                  <input v-model="multimodalForm.ttsDefaultSpeaker" type="text" class="input-box font-mono" placeholder="Vivian" />
                </div>
                <div>
                  <label class="field-label">Saved Voice ID <span class="text-gray-600 font-normal">optional</span></label>
                  <input v-model="multimodalForm.ttsDefaultVoiceId" type="text" class="input-box font-mono" placeholder="saved voice id from Qwen3 /voices" />
                </div>
                <div>
                  <label class="field-label">Timeout (ms)</label>
                  <input v-model.number="multimodalForm.ttsTimeoutMs" type="number" min="1000" class="input-box" />
                </div>
                <div>
                  <label class="field-label">API Key <span class="text-gray-600 font-normal">optional</span></label>
                  <input v-model="multimodalForm.ttsApiKey" type="password" class="input-box" autocomplete="off" placeholder="Bearer token if required" />
                </div>
                <div class="md:col-span-2">
                  <label class="field-label">Audio Example Path <span class="text-gray-600 font-normal">optional</span></label>
                  <input v-model="multimodalForm.ttsVoiceSamplePath" type="text" class="input-box font-mono" placeholder="workspace-relative sample, e.g. samples/my-voice.wav" />
                </div>
                <div class="md:col-span-2">
                  <label class="field-label">Audio Example Transcript <span class="text-gray-600 font-normal">optional</span></label>
                  <textarea v-model="multimodalForm.ttsVoiceSampleText" class="input-box font-mono text-xs resize-none" rows="3" placeholder="Exact words spoken in the audio example for higher quality cloning" />
                </div>
              </div>

              <div class="rounded-xl border border-purple-500/10 bg-gray-950/40 p-3 space-y-3">
                <div>
                  <div class="text-xs uppercase tracking-[0.18em] text-gray-500">Save Voice To Qwen3</div>
                  <div class="text-xs text-gray-500 mt-1">Upload a sample once, save it in the Qwen voice library, and reuse the returned voice ID for faster synthesis.</div>
                </div>
                <div class="multimodal-grid">
                  <div>
                    <label class="field-label">Voice Name</label>
                    <input v-model="savedVoiceForm.name" type="text" class="input-box" placeholder="e.g. Steffen Voice" />
                  </div>
                  <div>
                    <label class="field-label">Language</label>
                    <input v-model="savedVoiceForm.language" type="text" class="input-box font-mono" placeholder="English" />
                  </div>
                  <div class="md:col-span-2">
                    <label class="field-label">Voice Sample File</label>
                    <input type="file" accept="audio/*" class="input-box" @change="onSavedVoiceFileSelected" />
                    <div v-if="savedVoiceForm.fileName" class="mt-2 text-[11px] text-gray-500">Selected: {{ savedVoiceForm.fileName }}</div>
                  </div>
                </div>
                <div v-if="savedVoiceForm.message" class="text-xs" :class="savedVoiceForm.error ? 'text-red-400' : 'text-green-300'">{{ savedVoiceForm.message }}</div>
                <div class="flex justify-end">
                  <button @click="saveVoiceSampleToLibrary" :disabled="savedVoiceForm.saving || !savedVoiceForm.file" class="btn-ghost px-4 py-2 rounded-xl text-xs">
                    {{ savedVoiceForm.saving ? 'Saving Voice…' : 'Upload And Save Voice' }}
                  </button>
                </div>
              </div>
            </div>

            <div class="border-t border-purple-500/10 pt-3 space-y-3">
              <div class="text-xs uppercase tracking-[0.18em] text-gray-500">Image Generation</div>
              <div class="text-xs text-gray-500">Qwen-Image service for text-to-image generation. Leave endpoint empty to disable.</div>
              <div class="multimodal-grid">
                <div class="md:col-span-2">
                  <label class="field-label">Image Gen Endpoint <span class="text-gray-600 font-normal">optional</span></label>
                  <input v-model="multimodalForm.imageGenBaseUrl" type="text" class="input-box font-mono" placeholder="http://image-generation-service:5005" />
                </div>
                <div>
                  <label class="field-label">Model <span class="text-gray-600 font-normal">optional</span></label>
                  <input v-model="multimodalForm.imageGenModel" type="text" class="input-box font-mono" placeholder="black-forest-labs/FLUX.1-schnell" />
                </div>
                <div>
                  <label class="field-label">Timeout (ms)</label>
                  <input v-model.number="multimodalForm.imageGenTimeoutMs" type="number" min="1000" class="input-box" />
                </div>
                <div>
                  <label class="field-label">Default Width</label>
                  <input v-model.number="multimodalForm.imageGenDefaultWidth" type="number" min="256" max="2048" step="64" class="input-box" />
                </div>
                <div>
                  <label class="field-label">Default Height</label>
                  <input v-model.number="multimodalForm.imageGenDefaultHeight" type="number" min="256" max="2048" step="64" class="input-box" />
                </div>
                <div>
                  <label class="field-label">Default Steps</label>
                  <input v-model.number="multimodalForm.imageGenDefaultSteps" type="number" min="1" max="100" class="input-box" />
                </div>
                <div>
                  <label class="field-label">Guidance Scale</label>
                  <input v-model.number="multimodalForm.imageGenGuidanceScale" type="number" min="0" max="20" step="0.5" class="input-box" />
                </div>
                <div class="md:col-span-2">
                  <label class="field-label">API Key <span class="text-gray-600 font-normal">optional</span></label>
                  <input v-model="multimodalForm.imageGenApiKey" type="password" class="input-box" autocomplete="off" placeholder="Bearer token if required" />
                </div>
                <div class="md:col-span-2 space-y-2">
                  <label class="field-label">Default Negative Prompt <span class="text-gray-600 font-normal">applied to every generation unless overridden</span></label>
                  <textarea v-model="multimodalForm.imageGenDefaultNegativePrompt"
                    class="input-box font-mono text-xs resize-none w-full" rows="3"
                    placeholder="e.g. low quality, blurry, deformed fingers, watermark" />
                  <div class="space-y-1.5">
                    <div class="text-[11px] text-gray-500">Presets — click to append terms to the field above:</div>
                    <div class="flex flex-wrap gap-1.5">
                      <button
                        v-for="preset in IMAGE_GEN_NEGATIVE_PRESETS"
                        :key="preset.label"
                        @click="applyNegativePreset(preset.value)"
                        class="px-2.5 py-1 rounded-lg text-xs border border-purple-500/20 bg-purple-900/20 text-purple-200 hover:bg-purple-700/30 hover:border-purple-400/40 transition-colors"
                        :title="preset.value"
                      >{{ preset.label }}</button>
                      <button
                        @click="multimodalForm.imageGenDefaultNegativePrompt = ''"
                        class="px-2.5 py-1 rounded-lg text-xs border border-red-500/20 bg-red-900/10 text-red-300 hover:bg-red-800/20 transition-colors"
                      >Clear</button>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div class="border-t border-purple-500/10 pt-3 space-y-3">
              <div class="flex items-center justify-between gap-4">
                <div>
                  <div class="text-xs uppercase tracking-[0.18em] text-gray-500">Wake Word</div>
                  <div class="text-xs text-gray-500 mt-1">Browser-side wake listening defaults.</div>
                </div>
                <toggle-switch :value="multimodalForm.wakeEnabled" @change="multimodalForm.wakeEnabled = $event" />
              </div>
              <div class="multimodal-grid">
                <div>
                  <label class="field-label">Silence Timeout (ms)</label>
                  <input v-model.number="multimodalForm.wakeSilenceTimeoutMs" type="number" min="1000" max="15000" class="input-box" />
                </div>
                <div>
                  <label class="field-label">Wake Keywords <span class="text-gray-600 font-normal">comma-separated</span></label>
                  <input v-model="multimodalForm.wakeKeywordsText" type="text" class="input-box" placeholder="Hey Guarded, Okay Guarded, Luna" />
                </div>
                <div class="md:col-span-2">
                  <label class="field-label">Stop Phrases <span class="text-gray-600 font-normal">comma-separated</span></label>
                  <input v-model="multimodalForm.wakeStopPhrasesText" type="text" class="input-box" placeholder="stop recording, end recording, stop listening" />
                </div>
              </div>
            </div>

            <div v-if="multimodalStore.error || multimodalForm.error" class="text-sm text-red-400">{{ multimodalForm.error || multimodalStore.error }}</div>

            <div class="flex justify-end">
              <button @click="submitMultimodalForm" :disabled="multimodalStore.saving || multimodalStore.loading" class="btn-grad px-5 py-2 rounded-xl text-sm">
                {{ multimodalStore.saving ? 'Saving…' : 'Save Multimodal Settings' }}
              </button>
            </div>
          </div>
        </div>

        <!-- ── Guardrails ──────────────────────────────────────────────────── -->
        <div class="glass-card p-5">
          <div class="flex items-center justify-between mb-4">
            <h3 class="section-title mb-0">Guardrails</h3>
            <div class="flex items-center gap-2">
              <button v-if="guardrails.state" @click="guardrails.reset()" :disabled="guardrails.loading"
                class="text-xs text-gray-500 hover:text-purple-400 transition-colors">Reset defaults</button>
              <button v-if="!guardrails.state && gateway.connected" @click="guardrails.fetch()" :disabled="guardrails.loading"
                class="btn-ghost px-3 py-1.5 rounded-lg text-xs">Load</button>
            </div>
          </div>

          <div v-if="!gateway.connected" class="empty-state">Connect to manage guardrails.</div>
          <div v-else-if="guardrails.loading && !guardrails.state" class="empty-state">Loading…</div>
          <div v-else-if="guardrails.error" class="text-sm text-red-400">{{ guardrails.error }}</div>

          <div v-else-if="guardrails.state" class="space-y-4">
            <div class="flex items-start justify-between gap-4">
              <div>
                <p class="text-sm text-gray-200">Prompt Injection Protection</p>
                <p class="text-xs text-gray-500 mt-0.5">Scan incoming messages for jailbreak and injection patterns.</p>
              </div>
              <toggle-switch :value="guardrails.state.promptInjectionBlock"
                @change="guardrails.update({ promptInjectionBlock: $event })" :disabled="guardrails.loading" />
            </div>
            <div class="border-t border-purple-500/10" />
            <div class="flex items-start justify-between gap-4">
              <div>
                <p class="text-sm text-gray-200">Output Secret Scanning</p>
                <p class="text-xs text-gray-500 mt-0.5">Redact API keys, tokens, and credentials from LLM responses.</p>
              </div>
              <toggle-switch :value="guardrails.state.outputSecretScan"
                @change="guardrails.update({ outputSecretScan: $event })" :disabled="guardrails.loading" />
            </div>
            <div class="border-t border-purple-500/10" />
            <div class="space-y-2">
              <div class="flex items-center justify-between">
                <div>
                  <p class="text-sm text-gray-200">Max Input Length</p>
                  <p class="text-xs text-gray-500 mt-0.5">Maximum characters per message.</p>
                </div>
                <span class="text-sm font-mono text-purple-300 tabular-nums">{{ guardrails.state.maxInputLength.toLocaleString() }}</span>
              </div>
              <input type="range" min="1000" max="100000" step="1000" :value="guardrails.state.maxInputLength"
                @change="guardrails.update({ maxInputLength: Number(($event.target as HTMLInputElement).value) })"
                :disabled="guardrails.loading" class="w-full accent-purple-500" />
              <div class="flex justify-between text-xs text-gray-600"><span>1 000</span><span>100 000</span></div>
            </div>
            <div class="border-t border-purple-500/10" />
            <div class="flex items-start justify-between gap-4 opacity-50">
              <div>
                <p class="text-sm text-gray-200">Shell Sandbox <span class="ml-1 text-xs text-amber-500">locked</span></p>
                <p class="text-xs text-gray-500 mt-0.5">Commands run inside an isolated Docker container. Cannot be disabled.</p>
              </div>
              <toggle-switch :value="true" :disabled="true" />
            </div>
          </div>

          <div v-else-if="gateway.connected && !guardrails.state && !guardrails.loading" class="empty-state">
            Click "Load" to fetch current guardrail state.
          </div>
        </div>

        <!-- ── About ──────────────────────────────────────────────────────── -->
        <div class="glass-card p-5">
          <h3 class="section-title">About StarlingAI</h3>
          <div class="text-sm text-gray-500 space-y-1">
            <p>Version: <span class="text-gray-300">0.1.0</span></p>
            <p>Security-hardened local AI assistant with multi-agent orchestration.</p>
            <p class="text-xs mt-2">All conversations are processed locally via LM Studio. No data is sent to external services unless you explicitly use web tools.</p>
          </div>
        </div>

      </div>

      <!-- ══ RIGHT COLUMN ═════════════════════════════════════════════════════ -->
      <div class="space-y-5">

        <!-- ── Site Credentials ───────────────────────────────────────────── -->
        <div class="glass-card p-5">
          <div class="flex items-center justify-between mb-4">
            <h3 class="section-title mb-0">Site Credentials</h3>
            <div class="flex gap-2">
              <button v-if="gateway.connected && !sites.sites.length" @click="sites.fetch()" class="btn-ghost px-3 py-1.5 rounded-lg text-xs">Reload</button>
              <button @click="openSiteForm(null)" :disabled="!gateway.connected" class="btn-grad px-3 py-1.5 rounded-lg text-xs">+ Add Site</button>
            </div>
          </div>

          <div v-if="!gateway.connected" class="empty-state">Connect to manage site credentials.</div>
          <div v-else-if="sites.loading && !sites.sites.length" class="empty-state">Loading…</div>
          <div v-else-if="sites.error" class="text-sm text-red-400">{{ sites.error }}</div>

          <div v-else-if="sites.sites.length" class="space-y-2">
            <div v-for="site in sites.sites" :key="site.hostname"
              class="site-row">
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="text-sm font-mono text-gray-100">{{ site.hostname }}</span>
                  <span :class="site.source === 'config' ? 'badge-config' : 'badge-store'">{{ site.source }}</span>
                </div>
                <div class="text-xs text-gray-500 mt-0.5">{{ site.username }}</div>
                <div v-if="site.loginUrl" class="text-xs text-gray-600 truncate mt-0.5">{{ site.loginUrl }}</div>
                <div v-if="site.urls && Object.keys(site.urls).length" class="flex flex-wrap gap-1 mt-1.5">
                  <span v-for="(url, label) in site.urls" :key="label"
                    class="text-xs bg-purple-900/30 text-purple-300 border border-purple-700/30 px-1.5 py-0.5 rounded-full" :title="url">
                    {{ label }}
                  </span>
                </div>
                <div v-if="site.notes" class="text-xs text-gray-600 italic mt-0.5">{{ site.notes }}</div>
              </div>
              <div class="flex gap-1 shrink-0">
                <button v-if="site.source === 'store'" @click="openSiteForm(site)" class="icon-btn" title="Edit">✏</button>
                <button v-else class="icon-btn opacity-40 cursor-not-allowed" title="Defined in starlingai.json" disabled>🔒</button>
                <button v-if="site.source === 'store'" @click="confirmDeleteSite(site.hostname)"
                  :disabled="sites.loading" class="icon-btn icon-btn--danger" title="Delete">✕</button>
              </div>
            </div>
          </div>

          <div v-else class="empty-state">No site credentials configured.</div>
        </div>

        <!-- ── Scenes ─────────────────────────────────────────────────────── -->
        <div class="glass-card p-5">
          <div class="flex items-center justify-between mb-4">
            <h3 class="section-title mb-0">Scenes</h3>
            <div class="flex gap-2">
              <button v-if="gateway.connected && !scenesStore.scenes.length" @click="scenesStore.fetch()" class="btn-ghost px-3 py-1.5 rounded-lg text-xs">Reload</button>
              <button @click="openSceneForm(null)" :disabled="!gateway.connected" class="btn-grad px-3 py-1.5 rounded-lg text-xs">+ Add Scene</button>
            </div>
          </div>

          <div v-if="!gateway.connected" class="empty-state">Connect to manage scenes.</div>
          <div v-else-if="scenesStore.loading && !scenesStore.scenes.length" class="empty-state">Loading…</div>
          <div v-else-if="scenesStore.error" class="text-sm text-red-400">{{ scenesStore.error }}</div>

          <div v-else-if="scenesStore.scenes.length" class="space-y-2">
            <div v-for="scene in scenesStore.scenes" :key="scene.name"
              class="scene-row">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span class="text-sm font-mono text-gray-100">{{ scene.name }}</span>
                    <span :class="scene.source === 'config' ? 'badge-config' : 'badge-store'">{{ scene.source }}</span>
                  </div>
                  <div class="text-xs text-gray-400 mt-0.5">{{ scene.description }}</div>
                </div>
                <div class="flex gap-1 shrink-0">
                  <button v-if="scene.source === 'store'" @click="openSceneForm(scene)" class="icon-btn" title="Edit">✏</button>
                  <button v-else class="icon-btn opacity-40 cursor-not-allowed" title="Defined in starlingai.json" disabled>🔒</button>
                  <button v-if="scene.source === 'store'" @click="confirmDeleteScene(scene.name)"
                    :disabled="scenesStore.loading" class="icon-btn icon-btn--danger" title="Delete">✕</button>
                </div>
              </div>
              <details class="mt-2">
                <summary class="text-xs text-gray-600 cursor-pointer hover:text-purple-400 transition-colors select-none">Task prompt</summary>
                <pre class="text-xs text-gray-500 mt-1.5 whitespace-pre-wrap break-words bg-gray-950/60 border border-purple-500/10 rounded-lg p-2.5 max-h-40 overflow-y-auto">{{ scene.task }}</pre>
              </details>
            </div>
          </div>

          <div v-else class="empty-state">No scenes configured.</div>
        </div>

        <!-- ── Sub-Agents ─────────────────────────────────────────────────── -->
        <div class="glass-card p-5">
          <div class="flex items-center justify-between mb-4">
            <h3 class="section-title mb-0">Sub-Agents</h3>
            <button v-if="gateway.connected" @click="agentsStore.fetch()" class="btn-ghost px-3 py-1.5 rounded-lg text-xs">Reload</button>
          </div>

          <div v-if="!gateway.connected" class="empty-state">Connect to manage agents.</div>
          <div v-else-if="agentsStore.loading && !agentsStore.agents.length" class="empty-state">Loading…</div>
          <div v-else-if="agentsStore.error" class="text-sm text-red-400">{{ agentsStore.error }}</div>

          <div v-else-if="agentsStore.agents.length" class="space-y-4">
            <div class="routing-lab">
              <div class="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <div class="text-sm text-gray-200">Routing Lab</div>
                  <div class="text-xs text-gray-500 mt-0.5">Probe agent resolution before changing prompts, tags, or models.</div>
                </div>
                <div v-if="agentsStore.routingResult" class="text-[11px] text-gray-500">
                  {{ agentsStore.routingResult.mode }} search • min {{ routingLab.minConfidence }}
                </div>
              </div>

              <div class="routing-lab-controls mt-3">
                <input
                  v-model="routingLab.query"
                  type="text"
                  class="input-box"
                  placeholder="Try: login form automation, financial analysis, draft customer reply"
                  @keydown.enter.prevent="runRoutingLab"
                />
                <select v-model="routingLab.minConfidence" class="input-box">
                  <option value="high">high</option>
                  <option value="medium">medium</option>
                  <option value="low">low</option>
                </select>
                <button @click="runRoutingLab" :disabled="agentsStore.routingLoading || !routingLab.query.trim()" class="btn-grad px-3 py-2 rounded-xl text-xs">
                  {{ agentsStore.routingLoading ? 'Testing…' : 'Resolve' }}
                </button>
                <button @click="clearRoutingLab" :disabled="agentsStore.routingLoading" class="btn-ghost px-3 py-2 rounded-xl text-xs">Clear</button>
              </div>

              <div v-if="agentsStore.routingError" class="text-xs text-red-400 mt-3">{{ agentsStore.routingError }}</div>

              <div v-else-if="agentsStore.routingResult" class="space-y-3 mt-3">
                <div v-if="!agentsStore.routingResult.results.length && !agentsStore.routingResult.weakCandidates.length" class="empty-state !py-4">
                  No routing candidates found for this query.
                </div>

                <div v-if="agentsStore.routingResult.results.length" class="space-y-2">
                  <div class="text-[11px] uppercase tracking-[0.18em] text-gray-500">Accepted Candidates</div>
                  <div v-for="candidate in agentsStore.routingResult.results" :key="`accepted-${candidate.name}`" class="routing-result-card">
                    <div class="flex items-start justify-between gap-3">
                      <div>
                        <div class="text-sm font-mono text-gray-100">{{ candidate.name }}</div>
                        <div class="text-xs text-gray-500 mt-0.5">{{ candidate.description }}</div>
                      </div>
                      <div class="text-right shrink-0">
                        <div :class="['routing-confidence', `routing-confidence--${candidate.confidence}`]">{{ candidate.confidence }}</div>
                        <div class="text-[11px] text-gray-600 mt-1">{{ candidate.model.split('/').pop() }}</div>
                      </div>
                    </div>
                    <div class="routing-meta-row mt-2">
                      <span>score {{ candidate.score.toFixed(2) }}</span>
                      <span v-if="candidate.matchedTerms.length">matches {{ candidate.matchedTerms.join(', ') }}</span>
                    </div>
                    <div v-if="candidate.capabilities.length" class="routing-chip-row mt-2">
                      <span v-for="capability in candidate.capabilities" :key="`${candidate.name}-${capability}`" class="routing-chip">{{ capability }}</span>
                    </div>
                  </div>
                </div>

                <div v-if="agentsStore.routingResult.weakCandidates.length" class="space-y-2">
                  <div class="text-[11px] uppercase tracking-[0.18em] text-gray-500">{{ agentsStore.routingResult.gated ? 'Gated Candidates' : 'Weak Candidates' }}</div>
                  <div v-for="candidate in agentsStore.routingResult.weakCandidates" :key="`weak-${candidate.name}`" class="routing-result-card routing-result-card--weak">
                    <div class="flex items-start justify-between gap-3">
                      <div>
                        <div class="text-sm font-mono text-gray-100">{{ candidate.name }}</div>
                        <div class="text-xs text-gray-500 mt-0.5">{{ candidate.description }}</div>
                      </div>
                      <div :class="['routing-confidence', `routing-confidence--${candidate.confidence}`]">{{ candidate.confidence }}</div>
                    </div>
                    <div class="routing-meta-row mt-2">
                      <span>score {{ candidate.score.toFixed(2) }}</span>
                      <span v-if="candidate.matchedTerms.length">matches {{ candidate.matchedTerms.join(', ') }}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <details v-for="agent in agentsStore.agents" :key="agent.name" class="agent-row">
              <summary class="flex items-center justify-between cursor-pointer select-none py-1">
                <div>
                  <span class="text-sm font-mono text-gray-100">{{ agent.name }}</span>
                  <span class="text-xs text-gray-500 ml-2">{{ agent.model.primary?.split('/').pop() }}</span>
                </div>
                <span class="text-xs text-gray-600">Advanced ▾</span>
              </summary>
              <div class="mt-3 space-y-3 pl-1">
                <div class="text-xs text-gray-500 italic mb-2">{{ agent.description }}</div>
                <div v-if="agent.capabilities?.length || agent.tags?.length" class="space-y-2">
                  <div v-if="agent.capabilities?.length" class="routing-chip-row">
                    <span v-for="capability in agent.capabilities" :key="`${agent.name}-cap-${capability}`" class="routing-chip">{{ capability }}</span>
                  </div>
                  <div v-if="agent.tags?.length" class="routing-meta-row">
                    <span>tags {{ agent.tags.join(', ') }}</span>
                  </div>
                </div>
                <div class="grid grid-cols-2 gap-3">
                  <div>
                    <label class="field-label text-xs">temperature</label>
                    <input type="number" step="0.05" min="0" max="2"
                      :value="agent.model.temperature ?? 0.3"
                      @change="agentsStore.patchModel(agent.name, { temperature: +($event.target as HTMLInputElement).value })"
                      class="input-box text-sm" />
                  </div>
                  <div>
                    <label class="field-label text-xs">maxTokens</label>
                    <input type="number" step="256" min="256" max="16384"
                      :value="agent.model.maxTokens ?? 4096"
                      @change="agentsStore.patchModel(agent.name, { maxTokens: +($event.target as HTMLInputElement).value })"
                      class="input-box text-sm" />
                  </div>
                  <div>
                    <label class="field-label text-xs">top_p</label>
                    <input type="number" step="0.01" min="0" max="1"
                      :value="agent.model.topP ?? ''"
                      placeholder="default"
                      @change="agentsStore.patchModel(agent.name, { topP: ($event.target as HTMLInputElement).value ? +($event.target as HTMLInputElement).value : undefined })"
                      class="input-box text-sm" />
                  </div>
                  <div>
                    <label class="field-label text-xs">top_k</label>
                    <input type="number" step="1" min="1" max="200"
                      :value="agent.model.topK ?? ''"
                      placeholder="default"
                      @change="agentsStore.patchModel(agent.name, { topK: ($event.target as HTMLInputElement).value ? +($event.target as HTMLInputElement).value : undefined })"
                      class="input-box text-sm" />
                  </div>
                  <div>
                    <label class="field-label text-xs">min_p</label>
                    <input type="number" step="0.01" min="0" max="1"
                      :value="agent.model.minP ?? ''"
                      placeholder="default"
                      @change="agentsStore.patchModel(agent.name, { minP: ($event.target as HTMLInputElement).value ? +($event.target as HTMLInputElement).value : undefined })"
                      class="input-box text-sm" />
                  </div>
                  <div>
                    <label class="field-label text-xs">repeat_penalty</label>
                    <input type="number" step="0.05" min="0.5" max="2"
                      :value="agent.model.repeatPenalty ?? ''"
                      placeholder="default"
                      @change="agentsStore.patchModel(agent.name, { repeatPenalty: ($event.target as HTMLInputElement).value ? +($event.target as HTMLInputElement).value : undefined })"
                      class="input-box text-sm" />
                  </div>
                  <div>
                    <label class="field-label text-xs">seed</label>
                    <input type="number" step="1"
                      :value="agent.model.seed ?? ''"
                      placeholder="random"
                      @change="agentsStore.patchModel(agent.name, { seed: ($event.target as HTMLInputElement).value ? +($event.target as HTMLInputElement).value : undefined })"
                      class="input-box text-sm" />
                  </div>
                  <div>
                    <label class="field-label text-xs">model</label>
                    <input type="text"
                      :value="agent.model.primary ?? ''"
                      @change="agentsStore.patchModel(agent.name, { primary: ($event.target as HTMLInputElement).value })"
                      class="input-box text-sm font-mono" />
                  </div>
                  <div class="md:col-span-2">
                    <label class="field-label text-xs">endpoint override <span class="text-gray-600 font-normal">optional</span></label>
                    <input type="text"
                      :value="agent.model.baseUrl ?? ''"
                      placeholder="uses provider default"
                      @change="agentsStore.patchModel(agent.name, { baseUrl: ($event.target as HTMLInputElement).value || undefined })"
                      class="input-box text-sm font-mono" />
                  </div>
                  <div class="md:col-span-2">
                    <label class="field-label text-xs">endpoint api key <span class="text-gray-600 font-normal">optional</span></label>
                    <input type="password"
                      :value="agent.model.apiKey ?? ''"
                      placeholder="uses provider default"
                      autocomplete="off"
                      @change="agentsStore.patchModel(agent.name, { apiKey: ($event.target as HTMLInputElement).value || undefined })"
                      class="input-box text-sm" />
                  </div>
                  <div class="md:col-span-2 flex items-center justify-between gap-4 pt-1">
                    <div>
                      <label class="field-label text-xs">thinking mode <span class="text-gray-600 font-normal">Qwen3.5 chain-of-thought reasoning</span></label>
                      <p class="text-[11px] text-gray-600 mt-0.5">When set, StarlingAI sends <code class="text-gray-400">enable_thinking</code> via <code class="text-gray-400">extra_body</code> and applies Qwen-recommended sampling (on: temp 0.6 / top_p 0.95 · off: temp 0.7 / top_p 0.8) unless you override top_p.</p>
                    </div>
                    <select
                      :value="agent.model.enableThinking === undefined ? '' : agent.model.enableThinking ? 'on' : 'off'"
                      @change="agentsStore.patchModel(agent.name, { enableThinking: ($event.target as HTMLSelectElement).value === '' ? undefined : ($event.target as HTMLSelectElement).value === 'on' })"
                      class="input-box text-sm w-24 shrink-0">
                      <option value="">auto</option>
                      <option value="on">on</option>
                      <option value="off">off</option>
                    </select>
                  </div>
                </div>
              </div>
            </details>
          </div>

          <div v-else class="empty-state">No agents found.</div>
        </div>

        <div class="glass-card p-5">
          <div class="flex items-center justify-between mb-4 gap-3">
            <div>
              <h3 class="section-title mb-0">Model Routing</h3>
              <div class="text-xs text-gray-500 mt-1">Persist endpoint overrides for the default orchestrator, embeddings, reranker, and guard model.</div>
            </div>
            <div class="flex items-center gap-2">
              <button v-if="gateway.connected" @click="fetchModelEndpointConfig" :disabled="modelEndpointForm.loading || modelEndpointForm.saving" class="btn-ghost px-3 py-1.5 rounded-lg text-xs">Reload</button>
              <button @click="resetModelEndpointConfig" :disabled="!modelEndpointForm.lastLoaded || modelEndpointForm.loading || modelEndpointForm.saving" class="btn-ghost px-3 py-1.5 rounded-lg text-xs">Reset</button>
            </div>
          </div>

          <div v-if="!gateway.connected" class="empty-state">Connect to edit model routing.</div>
          <div v-else-if="modelEndpointForm.loading && !modelEndpointForm.loaded" class="empty-state">Loading…</div>
          <div v-else class="space-y-4">
            <div class="rounded-xl border border-cyan-500/15 bg-cyan-500/5 px-3 py-2 text-xs text-cyan-100/80">
              Changes here write the same mutable config used by runtime hot-reload and the model-endpoint health checker.
            </div>

            <div class="border-t border-purple-500/10 pt-3 space-y-3">
              <div class="flex items-center justify-between gap-3">
                <div class="text-xs uppercase tracking-[0.18em] text-gray-500">Orchestrator</div>
                <span v-if="getModelEndpointStatus('orchestrator')" :class="getModelEndpointStatus('orchestrator')?.ok ? 'badge-running' : 'badge-health-bad'">
                  {{ getModelEndpointStatus('orchestrator')?.ok ? 'healthy' : 'mismatch' }}
                </span>
              </div>
              <div class="multimodal-grid">
                <div class="md:col-span-2">
                  <label class="field-label">Primary Model</label>
                  <input v-model="modelEndpointForm.orchestratorModel" type="text" class="input-box font-mono" placeholder="lmstudio/qwen/qwen3.5-35b-a3b" />
                </div>
                <div class="md:col-span-2">
                  <label class="field-label">Endpoint Override <span class="text-gray-600 font-normal">optional</span></label>
                  <input v-model="modelEndpointForm.orchestratorBaseUrl" type="text" class="input-box font-mono" placeholder="uses provider default when empty" />
                </div>
                <div class="md:col-span-2">
                  <label class="field-label">API Key <span class="text-gray-600 font-normal">optional</span></label>
                  <input v-model="modelEndpointForm.orchestratorApiKey" type="password" class="input-box" autocomplete="off" placeholder="uses provider default when empty" />
                </div>
              </div>
              <div v-if="getModelEndpointStatus('orchestrator')?.error" class="text-[11px] text-red-300">{{ getModelEndpointStatus('orchestrator')?.error }}</div>
            </div>

            <div class="border-t border-purple-500/10 pt-3 space-y-3">
              <div class="flex items-center justify-between gap-3">
                <div class="text-xs uppercase tracking-[0.18em] text-gray-500">Embeddings</div>
                <span v-if="getModelEndpointStatus('embeddings')" :class="getModelEndpointStatus('embeddings')?.ok ? 'badge-running' : 'badge-health-bad'">
                  {{ getModelEndpointStatus('embeddings')?.ok ? 'healthy' : 'mismatch' }}
                </span>
              </div>
              <div class="multimodal-grid">
                <div class="md:col-span-2">
                  <label class="field-label">Embedding Model <span class="text-gray-600 font-normal">optional</span></label>
                  <input v-model="modelEndpointForm.embeddingModel" type="text" class="input-box font-mono" placeholder="leave empty to disable semantic embeddings" />
                </div>
                <div class="md:col-span-2">
                  <label class="field-label">Embedding Endpoint <span class="text-gray-600 font-normal">optional override</span></label>
                  <input v-model="modelEndpointForm.embeddingBaseUrl" type="text" class="input-box font-mono" placeholder="uses orchestrator/provider endpoint when empty" />
                </div>
                <div class="md:col-span-2">
                  <label class="field-label">Embedding API Key <span class="text-gray-600 font-normal">optional</span></label>
                  <input v-model="modelEndpointForm.embeddingApiKey" type="password" class="input-box" autocomplete="off" placeholder="uses orchestrator/provider key when empty" />
                </div>
              </div>
              <div v-if="getModelEndpointStatus('embeddings')?.error" class="text-[11px] text-red-300">{{ getModelEndpointStatus('embeddings')?.error }}</div>
            </div>

            <div class="border-t border-purple-500/10 pt-3 space-y-3">
              <div class="flex items-center justify-between gap-4">
                <div>
                  <div class="text-xs uppercase tracking-[0.18em] text-gray-500">Reranker</div>
                  <div class="text-xs text-gray-500 mt-1">Optional retrieval reranking endpoint.</div>
                </div>
                <div class="flex items-center gap-2">
                  <span v-if="getModelEndpointStatus('reranker')" :class="getModelEndpointStatus('reranker')?.ok ? 'badge-running' : 'badge-health-bad'">
                    {{ getModelEndpointStatus('reranker')?.ok ? 'healthy' : 'mismatch' }}
                  </span>
                  <toggle-switch :value="modelEndpointForm.rerankerEnabled" @change="modelEndpointForm.rerankerEnabled = $event" />
                </div>
              </div>
              <div class="multimodal-grid">
                <div class="md:col-span-2">
                  <label class="field-label">Reranker Model</label>
                  <input v-model="modelEndpointForm.rerankerModel" type="text" class="input-box font-mono" placeholder="Qwen/Qwen3-Reranker-4B" />
                </div>
                <div class="md:col-span-2">
                  <label class="field-label">Reranker Endpoint</label>
                  <input v-model="modelEndpointForm.rerankerBaseUrl" type="text" class="input-box font-mono" placeholder="http://host.docker.internal:1234/v1" />
                </div>
                <div class="md:col-span-2">
                  <label class="field-label">Reranker API Key</label>
                  <input v-model="modelEndpointForm.rerankerApiKey" type="password" class="input-box" autocomplete="off" placeholder="lm-studio" />
                </div>
              </div>
              <div v-if="getModelEndpointStatus('reranker')?.error" class="text-[11px] text-red-300">{{ getModelEndpointStatus('reranker')?.error }}</div>
            </div>

            <div class="border-t border-purple-500/10 pt-3 space-y-3">
              <div class="flex items-center justify-between gap-4">
                <div>
                  <div class="text-xs uppercase tracking-[0.18em] text-gray-500">Guard Moderation</div>
                  <div class="text-xs text-gray-500 mt-1">Optional moderation model used before input/tool content reaches the assistant.</div>
                </div>
                <div class="flex items-center gap-2">
                  <span v-if="getModelEndpointStatus('guard')" :class="getModelEndpointStatus('guard')?.ok ? 'badge-running' : 'badge-health-bad'">
                    {{ getModelEndpointStatus('guard')?.ok ? 'healthy' : 'mismatch' }}
                  </span>
                  <toggle-switch :value="modelEndpointForm.guardEnabled" @change="modelEndpointForm.guardEnabled = $event" />
                </div>
              </div>
              <div class="multimodal-grid">
                <div class="md:col-span-2">
                  <label class="field-label">Guard Model</label>
                  <input v-model="modelEndpointForm.guardModel" type="text" class="input-box font-mono" placeholder="Qwen/Qwen3Guard-Gen-4B" />
                </div>
                <div class="md:col-span-2">
                  <label class="field-label">Guard Endpoint</label>
                  <input v-model="modelEndpointForm.guardBaseUrl" type="text" class="input-box font-mono" placeholder="http://host.docker.internal:1234/v1" />
                </div>
                <div class="md:col-span-2">
                  <label class="field-label">Guard API Key</label>
                  <input v-model="modelEndpointForm.guardApiKey" type="password" class="input-box" autocomplete="off" placeholder="lm-studio" />
                </div>
              </div>
              <div v-if="getModelEndpointStatus('guard')?.error" class="text-[11px] text-red-300">{{ getModelEndpointStatus('guard')?.error }}</div>
            </div>

            <div v-if="modelEndpointForm.error" class="text-sm text-red-400">{{ modelEndpointForm.error }}</div>

            <div class="flex justify-end">
              <button @click="submitModelEndpointConfig" :disabled="modelEndpointForm.loading || modelEndpointForm.saving" class="btn-grad px-5 py-2 rounded-xl text-sm">
                {{ modelEndpointForm.saving ? 'Saving…' : 'Save Model Routing' }}
              </button>
            </div>
          </div>
        </div>

        <!-- ── Channels ───────────────────────────────────────────────────── -->
        <div class="glass-card p-5">
          <div class="flex items-center justify-between mb-4">
            <div class="flex items-center gap-3">
              <h3 class="section-title mb-0">Channels</h3>
              <span v-if="channelsStore.deadLetterCount > 0" class="text-xs px-2 py-0.5 rounded-full bg-red-900/60 text-red-300 font-medium" title="Messages that failed all delivery retries">
                {{ channelsStore.deadLetterCount }} dead letter{{ channelsStore.deadLetterCount === 1 ? '' : 's' }}
              </span>
            </div>
            <button v-if="gateway.connected" @click="channelsStore.fetch(); channelsStore.fetchDeadLetterCount()" class="btn-ghost px-3 py-1.5 rounded-lg text-xs">Reload</button>
          </div>

          <div v-if="!gateway.connected" class="empty-state">Connect to manage channels.</div>
          <div v-else-if="channelsStore.loading && !channelsStore.channels.length" class="empty-state">Loading…</div>
          <div v-else-if="channelsStore.error" class="text-sm text-red-400">{{ channelsStore.error }}</div>

          <div v-else class="space-y-2">
            <div v-if="channelsStore.deadLetters.length" class="channel-incident-panel">
              <div class="flex items-center justify-between gap-3">
                <div>
                  <div class="text-sm text-gray-200">Recent Delivery Incidents</div>
                  <div class="text-xs text-gray-500 mt-0.5">Newest dead-letter entries across all channels.</div>
                </div>
                <div class="text-[11px] text-red-300">{{ channelsStore.deadLetters.length }} shown</div>
              </div>
              <div class="mt-3 space-y-2">
                <div v-for="entry in channelsStore.deadLetters.slice(0, 4)" :key="`${entry.channel}-${entry.ts}-${entry.error}`" class="channel-incident-row">
                  <div class="flex items-center justify-between gap-3">
                    <span class="badge-health-bad">{{ entry.channel }}</span>
                    <span class="text-[11px] text-gray-600">{{ formatTimestamp(entry.ts) }}</span>
                  </div>
                  <div class="text-xs text-gray-300 mt-2 break-words">{{ entry.error }}</div>
                  <div class="text-[11px] text-gray-500 mt-1">Attempts {{ entry.attempts }} · {{ entry.messagePreview || 'No preview available' }}</div>
                </div>
              </div>
            </div>

            <div v-for="def in CHANNEL_DEFS" :key="def.type" class="channel-row">
              <div class="flex items-center justify-between gap-3">
                <div class="flex items-center gap-3 min-w-0 flex-1">
                  <ChannelIcon :type="def.type" class="shrink-0" />
                  <div class="min-w-0">
                    <div class="flex items-center gap-2 flex-wrap">
                      <span class="text-sm font-medium text-gray-100">{{ def.label }}</span>
                      <span v-if="getChannelStatus(def.type).supported === false" class="badge-planned" :title="getChannelStatus(def.type).reason ?? 'Channel runtime is not implemented yet'">planned</span>
                      <span v-if="getChannelStatus(def.type).running" class="badge-running">running</span>
                      <span v-else-if="getChannelStatus(def.type).enabled" class="badge-config">enabled</span>
                      <span v-else class="badge-off">off</span>
                      <span v-if="getChannelStatus(def.type).health" :class="getChannelStatus(def.type).health?.healthy ? 'badge-running' : 'badge-health-bad'" :title="formatHealthTitle(getChannelStatus(def.type))">
                        {{ getChannelStatus(def.type).health?.healthy ? 'healthy' : 'degraded' }}
                      </span>
                      <span v-if="getChannelStatus(def.type).operatorState" :class="operatorStateBadgeClass(getChannelStatus(def.type))" :title="getChannelStatus(def.type).operatorState?.summary">
                        {{ getChannelStatus(def.type).operatorState?.severity }}
                      </span>
                      <span v-if="getChannelStatus(def.type).error" class="text-xs text-red-400 truncate" :title="getChannelStatus(def.type).error">error</span>
                    </div>
                    <div class="text-xs text-gray-500 mt-0.5">{{ def.description }}</div>
                    <div v-if="getChannelStatus(def.type).operatorState?.summary" class="mt-1 text-[11px]" :class="operatorStateTextClass(getChannelStatus(def.type))">
                      {{ getChannelStatus(def.type).operatorState?.summary }}
                    </div>
                    <div v-if="getChannelStatus(def.type).metrics" class="mt-2 channel-metrics-grid text-[11px] text-gray-500">
                      <span>Delivered <strong class="text-gray-300">{{ getChannelStatus(def.type).metrics?.delivered }}</strong></span>
                      <span>Failures <strong :class="getChannelStatus(def.type).metrics?.deliveryFailures ? 'text-red-300' : 'text-gray-300'">{{ getChannelStatus(def.type).metrics?.deliveryFailures }}</strong></span>
                      <span>Ingress blocks <strong :class="getChannelStatus(def.type).metrics?.ingressDenied ? 'text-amber-300' : 'text-gray-300'">{{ getChannelStatus(def.type).metrics?.ingressDenied }}</strong></span>
                      <span v-if="getChannelStatus(def.type).health?.latencyMs !== undefined">Latency <strong class="text-gray-300">{{ getChannelStatus(def.type).health?.latencyMs }} ms</strong></span>
                      <span v-if="getChannelStatus(def.type).metrics?.deliveryWindows?.last5m">5m success <strong :class="windowSuccessRateClass(getChannelStatus(def.type).metrics?.deliveryWindows?.last5m?.successRatePct)">{{ formatPercent(getChannelStatus(def.type).metrics?.deliveryWindows?.last5m?.successRatePct) }}</strong></span>
                      <span v-if="getChannelStatus(def.type).metrics?.deliveryLatency?.p95Ms !== undefined">p95 <strong class="text-gray-300">{{ getChannelStatus(def.type).metrics?.deliveryLatency?.p95Ms }} ms</strong></span>
                    </div>
                    <div v-if="getChannelStatus(def.type).metrics?.lastDeliveryError || getChannelStatus(def.type).health?.error || getChannelStatus(def.type).metrics?.lastIngressDeniedAt" class="mt-1 text-[11px] text-gray-600 space-y-0.5">
                      <div v-if="getChannelStatus(def.type).metrics?.lastDeliveryError" class="truncate" :title="getChannelStatus(def.type).metrics?.lastDeliveryError">Last delivery error: {{ getChannelStatus(def.type).metrics?.lastDeliveryError }}</div>
                      <div v-if="getChannelStatus(def.type).health?.error" class="truncate" :title="getChannelStatus(def.type).health?.error">Health: {{ getChannelStatus(def.type).health?.error }}</div>
                      <div v-if="getChannelStatus(def.type).metrics?.lastIngressDeniedAt">Last ingress block: {{ formatTimestamp(getChannelStatus(def.type).metrics?.lastIngressDeniedAt) }}</div>
                    </div>
                  </div>
                </div>
                <button @click="void openChannelForm(def)" :disabled="!gateway.connected"
                  class="icon-btn shrink-0" title="Configure">✏</button>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  </div>

  <!-- ── Site form modal ─────────────────────────────────────────────────── -->
  <div v-if="siteForm.open" class="modal-backdrop" @click.self="siteForm.open = false">
    <div class="modal-box">
      <div class="modal-header">
        <h3 class="font-semibold text-gray-100">{{ siteForm.editing ? 'Edit Site' : 'Add Site' }}</h3>
        <button @click="siteForm.open = false" class="modal-close">✕</button>
      </div>

      <div class="space-y-4 p-5">
        <div>
          <label class="field-label">Hostname <span class="text-red-400">*</span></label>
          <input v-model="siteForm.hostname" type="text" class="input-box"
            placeholder="e.g. github.com" :disabled="!!siteForm.editing" />
        </div>
        <div>
          <label class="field-label">Username <span class="text-red-400">*</span></label>
          <input v-model="siteForm.username" type="text" class="input-box" placeholder="Email or username" />
        </div>
        <div>
          <label class="field-label">Password <span class="text-red-400">*</span>
            <span class="ml-1 text-gray-600 font-normal text-xs">(use $ENV_VAR or secret:key)</span></label>
          <input v-model="siteForm.password" type="password" class="input-box" autocomplete="new-password" placeholder="$MY_PASSWORD or secret:mykey" />
        </div>
        <div>
          <label class="field-label">Login URL</label>
          <input v-model="siteForm.loginUrl" type="text" class="input-box" placeholder="https://site.com/login" />
        </div>

        <!-- Named URLs -->
        <div>
          <div class="flex items-center justify-between mb-2">
            <label class="field-label mb-0">Named URLs</label>
            <button @click="addUrlEntry" type="button" class="text-xs text-purple-400 hover:text-purple-300 transition-colors">+ Add URL</button>
          </div>
          <div class="space-y-2">
            <div v-for="(entry, i) in siteForm.urlEntries" :key="i" class="flex gap-2 items-center">
              <input v-model="entry.label" type="text" class="input-box w-28 shrink-0" placeholder="label" />
              <input v-model="entry.url" type="text" class="input-box flex-1" placeholder="https://…" />
              <button @click="siteForm.urlEntries.splice(i, 1)" class="text-gray-600 hover:text-red-400 transition-colors px-1 text-lg leading-none">✕</button>
            </div>
          </div>
        </div>

        <div>
          <label class="field-label">Notes</label>
          <input v-model="siteForm.notes" type="text" class="input-box" placeholder="Optional reminder" />
        </div>

        <details class="text-xs text-gray-500">
          <summary class="cursor-pointer hover:text-purple-400 transition-colors select-none">CSS selector overrides (advanced)</summary>
          <div class="space-y-2 mt-2">
            <input v-model="siteForm.usernameSelector" type="text" class="input-box" placeholder="Username selector" />
            <input v-model="siteForm.passwordSelector" type="text" class="input-box" placeholder="Password selector" />
            <input v-model="siteForm.submitSelector" type="text" class="input-box" placeholder="Submit button selector" />
          </div>
        </details>
      </div>

      <div v-if="siteForm.error" class="px-5 pb-2 text-sm text-red-400">{{ siteForm.error }}</div>

      <div class="modal-footer">
        <button @click="siteForm.open = false" class="btn-ghost px-4 py-2 rounded-xl text-sm">Cancel</button>
        <button @click="submitSiteForm" :disabled="sites.loading" class="btn-grad px-5 py-2 rounded-xl text-sm">
          {{ sites.loading ? 'Saving…' : 'Save' }}
        </button>
      </div>
    </div>
  </div>

  <!-- ── Channel form modal ──────────────────────────────────────────────── -->
  <div v-if="channelForm.open" class="modal-backdrop" @click.self="channelForm.open = false">
    <div class="modal-box">
      <div class="modal-header">
        <h3 class="font-semibold text-gray-100">Configure {{ channelForm.label }}</h3>
        <button @click="channelForm.open = false" class="modal-close">✕</button>
      </div>

      <div class="space-y-4 p-5">
        <div v-if="channelRuntimeSupport.supported === false" class="rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          {{ channelRuntimeSupport.reason ?? 'Channel runtime is not implemented yet' }} You can save credentials now, but the adapter will not start until runtime support is added.
        </div>
        <div v-if="channelForm.loadingDetails" class="rounded-xl border border-purple-500/10 bg-gray-950/50 px-3 py-2 text-sm text-gray-500">
          Loading channel status…
        </div>
        <div v-else-if="channelForm.details?.status" class="channel-detail-panel">
          <div class="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <div class="text-sm text-gray-200">Operator View</div>
              <div v-if="channelForm.details.status.operatorState?.summary" class="text-xs mt-1" :class="operatorStateTextClass(channelForm.details.status)">
                {{ channelForm.details.status.operatorState?.summary }}
              </div>
            </div>
            <span v-if="channelForm.details.status.operatorState" :class="operatorStateBadgeClass(channelForm.details.status)">
              {{ channelForm.details.status.operatorState?.severity }}
            </span>
          </div>

          <div v-if="channelForm.details.status.metrics" class="channel-detail-metrics mt-3">
            <div v-if="channelForm.details.status.metrics.deliveryWindows?.last5m" class="channel-detail-stat">
              <span class="text-gray-500">Last 5m success</span>
              <strong :class="windowSuccessRateClass(channelForm.details.status.metrics.deliveryWindows?.last5m?.successRatePct)">{{ formatPercent(channelForm.details.status.metrics.deliveryWindows?.last5m?.successRatePct) }}</strong>
            </div>
            <div v-if="channelForm.details.status.metrics.deliveryWindows?.last1h" class="channel-detail-stat">
              <span class="text-gray-500">Last 1h success</span>
              <strong :class="windowSuccessRateClass(channelForm.details.status.metrics.deliveryWindows?.last1h?.successRatePct)">{{ formatPercent(channelForm.details.status.metrics.deliveryWindows?.last1h?.successRatePct) }}</strong>
            </div>
            <div v-if="channelForm.details.status.metrics.deliveryLatency?.p95Ms !== undefined" class="channel-detail-stat">
              <span class="text-gray-500">p95 latency</span>
              <strong class="text-gray-100">{{ channelForm.details.status.metrics.deliveryLatency?.p95Ms }} ms</strong>
            </div>
            <div v-if="channelForm.details.status.metrics.deliveryLatency?.p99Ms !== undefined" class="channel-detail-stat">
              <span class="text-gray-500">p99 latency</span>
              <strong class="text-gray-100">{{ channelForm.details.status.metrics.deliveryLatency?.p99Ms }} ms</strong>
            </div>
          </div>

          <div v-if="channelForm.details.operator?.recentDeadLetters?.length" class="mt-3">
            <div class="text-xs uppercase tracking-[0.18em] text-gray-500">Recent Dead Letters</div>
            <div class="mt-2 space-y-2">
              <div v-for="entry in channelForm.details.operator.recentDeadLetters" :key="`${entry.channel}-${entry.ts}-${entry.error}`" class="channel-incident-row">
                <div class="flex items-center justify-between gap-3">
                  <div class="text-xs text-red-300">{{ entry.error }}</div>
                  <div class="text-[11px] text-gray-600">{{ formatTimestamp(entry.ts) }}</div>
                </div>
                <div class="text-[11px] text-gray-500 mt-1">Attempts {{ entry.attempts }} · {{ entry.messagePreview || 'No preview available' }}</div>
              </div>
            </div>
          </div>

          <div v-if="channelForm.details.operator?.recoveryProcedures?.length" class="mt-3">
            <div class="text-xs uppercase tracking-[0.18em] text-gray-500">Recovery Procedure</div>
            <ul class="mt-2 space-y-1.5 text-xs text-gray-400 list-disc pl-4">
              <li v-for="step in channelForm.details.operator.recoveryProcedures" :key="step">{{ step }}</li>
            </ul>
          </div>
        </div>
        <div class="flex items-center justify-between gap-4">
          <div>
            <p class="text-sm text-gray-200">Enabled</p>
            <p class="text-xs text-gray-500 mt-0.5">Activate this channel integration.</p>
          </div>
          <toggle-switch :value="!!channelForm.config.enabled"
            @change="channelForm.config.enabled = $event" />
        </div>
        <div class="border-t border-purple-500/10" />
        <div class="text-xs text-gray-500">
          Some channel runtime changes, especially Telegram and Discord tokens, take effect after the gateway restarts.
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-3 border-t border-purple-500/10 pt-3">
          <div>
            <label class="field-label">History Limit</label>
            <input v-model.number="channelForm.config.historyLimit" type="number" min="1" max="500" class="input-box" placeholder="50" />
          </div>
          <div>
            <label class="field-label">Rate Limit Count</label>
            <input v-model.number="channelForm.config.perSenderRateLimitCount" type="number" min="1" max="200" class="input-box" placeholder="12" />
          </div>
          <div class="md:col-span-2">
            <label class="field-label">Rate Limit Window (ms)</label>
            <input v-model.number="channelForm.config.perSenderRateLimitWindowMs" type="number" min="1000" max="3600000" class="input-box" placeholder="60000" />
          </div>
        </div>

        <template v-if="channelForm.type === 'telegram'">
          <div>
            <label class="field-label">Bot Token</label>
            <input v-model="channelForm.config.botToken" type="password" class="input-box" autocomplete="off" placeholder="123456:ABC..." />
          </div>
          <div>
            <label class="field-label">Allowed User IDs <span class="text-gray-500 font-normal">(comma-separated, optional)</span></label>
            <input :value="(channelForm.config.allowedUserIds ?? []).join(', ')"
              @input="channelForm.config.allowedUserIds = ($event.target as HTMLInputElement).value.split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n))"
              type="text" class="input-box" placeholder="Leave empty to allow all Telegram users" />
          </div>
        </template>

        <div v-if="channelForm.type !== 'telegram'">
          <label class="field-label">DM Policy</label>
          <select v-model="channelForm.config.dmPolicy" class="input-box">
            <option value="pairing">pairing — require /pair code</option>
            <option value="open">open — allow all senders</option>
            <option value="allowlist">allowlist — allow specific sender IDs</option>
            <option value="disabled">disabled — reject all</option>
          </select>
        </div>

        <!-- Slack fields -->
        <template v-if="channelForm.type === 'slack'">
          <div>
            <label class="field-label">Bot Token <span class="text-gray-500 font-normal">(xoxb-...)</span></label>
            <input v-model="channelForm.config.botToken" type="password" class="input-box" autocomplete="off" placeholder="xoxb-..." />
          </div>
          <div>
            <label class="field-label">Signing Secret</label>
            <input v-model="channelForm.config.signingSecret" type="password" class="input-box" autocomplete="off" placeholder="Signing secret from Slack Basic Info" />
          </div>
          <div>
            <label class="field-label">App Token <span class="text-gray-500 font-normal">(xapp-... optional)</span></label>
            <input v-model="channelForm.config.appToken" type="password" class="input-box" autocomplete="off" placeholder="xapp-... (Socket Mode only)" />
          </div>
        </template>

        <!-- Discord fields -->
        <template v-if="channelForm.fields.includes('token') && channelForm.type === 'discord'">
          <div>
            <label class="field-label">Bot Token</label>
            <input v-model="channelForm.config.token" type="password" class="input-box" autocomplete="off" placeholder="Discord bot token" />
          </div>
          <div>
            <label class="field-label">Guild IDs <span class="text-gray-500 font-normal">(comma-separated, optional)</span></label>
            <input :value="(channelForm.config.guildIds ?? []).join(', ')"
              @input="channelForm.config.guildIds = ($event.target as HTMLInputElement).value.split(',').map(s => s.trim()).filter(Boolean)"
              type="text" class="input-box" placeholder="Leave empty for all guilds + DMs" />
          </div>
        </template>

        <!-- WhatsApp fields -->
        <template v-if="channelForm.fields.includes('verifyToken')">
          <div>
            <label class="field-label">Verify Token</label>
            <input v-model="channelForm.config.verifyToken" type="text" class="input-box" placeholder="Set same value in Meta Console" />
          </div>
          <div>
            <label class="field-label">App Secret <span class="text-gray-500 font-normal">(for webhook signature verification)</span></label>
            <input v-model="channelForm.config.appSecret" type="password" class="input-box" autocomplete="off" placeholder="Meta app secret" />
          </div>
          <div>
            <label class="field-label">Access Token</label>
            <input v-model="channelForm.config.accessToken" type="password" class="input-box" autocomplete="off" placeholder="Permanent access token" />
          </div>
          <div>
            <label class="field-label">Phone Number ID</label>
            <input v-model="channelForm.config.phoneNumberId" type="text" class="input-box" placeholder="Phone number ID from Meta Console" />
          </div>
        </template>

        <!-- Email fields -->
        <template v-if="channelForm.fields.includes('imapHost')">
          <div class="border-t border-purple-500/10 pt-2">
            <p class="text-xs text-gray-500 mb-3 uppercase tracking-wide">IMAP (Incoming)</p>
          </div>
          <div>
            <label class="field-label">IMAP Host</label>
            <input v-model="channelForm.config.imapHost" type="text" class="input-box" placeholder="imap.gmail.com" />
          </div>
          <div>
            <label class="field-label">IMAP User</label>
            <input v-model="channelForm.config.imapUser" type="text" class="input-box" placeholder="you@example.com" />
          </div>
          <div>
            <label class="field-label">IMAP Password</label>
            <input v-model="channelForm.config.imapPassword" type="password" class="input-box" autocomplete="off" placeholder="App password or $ENV_VAR" />
          </div>
          <div class="border-t border-purple-500/10 pt-2">
            <p class="text-xs text-gray-500 mb-3 uppercase tracking-wide">SMTP (Outgoing)</p>
          </div>
          <div>
            <label class="field-label">SMTP Host</label>
            <input v-model="channelForm.config.smtpHost" type="text" class="input-box" placeholder="smtp.gmail.com" />
          </div>
          <div>
            <label class="field-label">SMTP User</label>
            <input v-model="channelForm.config.smtpUser" type="text" class="input-box" placeholder="you@example.com" />
          </div>
          <div>
            <label class="field-label">SMTP Password</label>
            <input v-model="channelForm.config.smtpPassword" type="password" class="input-box" autocomplete="off" placeholder="App password or $ENV_VAR" />
          </div>
          <div>
            <label class="field-label">From Address</label>
            <input v-model="channelForm.config.smtpFrom" type="text" class="input-box" placeholder="bot@example.com" />
          </div>
        </template>

        <!-- Signal fields -->
        <template v-if="channelForm.fields.includes('account')">
          <div>
            <label class="field-label">Signal Account <span class="text-gray-500 font-normal">(phone number)</span></label>
            <input v-model="channelForm.config.account" type="text" class="input-box" placeholder="+1234567890" />
          </div>
        </template>
      </div>

      <div v-if="channelForm.error" class="px-5 pb-2 text-sm text-red-400">{{ channelForm.error }}</div>

      <div class="modal-footer">
        <button @click="closeChannelForm" class="btn-ghost px-4 py-2 rounded-xl text-sm">Cancel</button>
        <button @click="submitChannelForm" :disabled="channelsStore.loading" class="btn-grad px-5 py-2 rounded-xl text-sm">
          {{ channelsStore.loading ? 'Saving…' : 'Save' }}
        </button>
      </div>
    </div>
  </div>

  <!-- ── Scene form modal ────────────────────────────────────────────────── -->
  <div v-if="sceneForm.open" class="modal-backdrop" @click.self="sceneForm.open = false">
    <div class="modal-box">
      <div class="modal-header">
        <h3 class="font-semibold text-gray-100">{{ sceneForm.editing ? 'Edit Scene' : 'Add Scene' }}</h3>
        <button @click="sceneForm.open = false" class="modal-close">✕</button>
      </div>

      <div class="space-y-4 p-5">
        <div>
          <label class="field-label">Name <span class="text-red-400">*</span>
            <span class="ml-1 text-gray-600 font-normal text-xs">(letters, numbers, underscores)</span></label>
          <input v-model="sceneForm.name" type="text" class="input-box font-mono"
            placeholder="e.g. apply_jobs" :disabled="!!sceneForm.editing" />
        </div>
        <div>
          <label class="field-label">Description <span class="text-red-400">*</span></label>
          <input v-model="sceneForm.description" type="text" class="input-box" placeholder="One-line description shown in the UI" />
        </div>
        <div>
          <label class="field-label">Task Prompt <span class="text-red-400">*</span></label>
          <textarea v-model="sceneForm.task" class="input-box font-mono text-xs resize-none" rows="9"
            placeholder="The full prompt sent to the orchestrator when this scene is triggered." />
        </div>
        <div>
          <label class="field-label">Webhook Key
            <span class="ml-1 text-gray-600 font-normal text-xs">(≥16 chars; use $ENV_VAR for env)</span></label>
          <input v-model="sceneForm.webhookKey" type="text" class="input-box font-mono"
            placeholder="$MY_SCENE_KEY or a literal secret" />
        </div>
      </div>

      <div v-if="sceneForm.error" class="px-5 pb-2 text-sm text-red-400">{{ sceneForm.error }}</div>

      <div class="modal-footer">
        <button @click="sceneForm.open = false" class="btn-ghost px-4 py-2 rounded-xl text-sm">Cancel</button>
        <button @click="submitSceneForm" :disabled="scenesStore.loading" class="btn-grad px-5 py-2 rounded-xl text-sm">
          {{ scenesStore.loading ? 'Saving…' : 'Save' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import { useGatewayStore } from "@/stores/gateway";
import { useGuardrailsStore } from "@/stores/guardrails";
import { useSitesStore, type SiteSummary } from "@/stores/sites";
import { useScenesStore, type SceneDetail } from "@/stores/scenes";
import { useChannelsStore, type ChannelConfig, type ChannelDetail, type ChannelStatus } from "@/stores/channels";
import { useRuntimeStore } from "@/stores/runtime";
import { useAgentsStore } from "@/stores/agents";
import { useMultimodalStore, type MultimodalConfig } from "@/stores/multimodal";
import ToggleSwitch from "@/components/ToggleSwitch.vue";
import ChannelIcon from "@/components/ChannelIcon.vue";

const gateway = useGatewayStore();
const guardrails = useGuardrailsStore();
const sites = useSitesStore();
const scenesStore = useScenesStore();
const channelsStore = useChannelsStore();
const runtime = useRuntimeStore();
const agentsStore = useAgentsStore();
const multimodalStore = useMultimodalStore();

const routingLab = reactive({
  query: "",
  minConfidence: "medium" as "high" | "medium" | "low",
});

const multimodalLoaded = computed(() => Boolean(multimodalStore.config.files.baseUrl));

const IMAGE_GEN_NEGATIVE_PRESETS = [
  {
    label: "Quality",
    value: "low quality, worst quality, blurry, pixelated, noisy, grainy, jpeg artifacts, compression artifacts, oversaturated, washed out, overexposed, underexposed",
  },
  {
    label: "Human Realism",
    value: "deformed fingers, extra fingers, missing fingers, fused fingers, bad hands, mutated hands, distorted hands, ai-looking, uncanny valley, plastic skin, waxy skin, doll face, dead eyes, empty eyes",
  },
  {
    label: "Face Detail",
    value: "blurry face, distorted face, asymmetric face, cross-eyed, bad eyes, deformed eyes, no face details, flat face, zombie face, deformed nose, unnatural mouth, bad teeth",
  },
  {
    label: "Anatomy",
    value: "bad anatomy, deformed body, mutated, extra limbs, missing limbs, disproportionate body, floating limbs, disconnected limbs, malformed limbs, twisted spine",
  },
  {
    label: "Artifacts",
    value: "watermark, text, signature, logo, banner, border, frame, copyright, censored, cropped, out of frame, duplicate, tiling",
  },
  {
    label: "All",
    value: "low quality, worst quality, blurry, pixelated, noisy, grainy, jpeg artifacts, compression artifacts, deformed fingers, extra fingers, missing fingers, fused fingers, bad hands, mutated hands, ai-looking, uncanny valley, plastic skin, waxy skin, doll face, dead eyes, blurry face, distorted face, asymmetric face, no face details, flat face, bad anatomy, deformed body, mutated, extra limbs, missing limbs, disproportionate, floating limbs, watermark, text, signature, logo, border, frame, out of frame, duplicate",
  },
] as const;

const multimodalForm = reactive({
  maxUploadBytes: 20_971_520,
  filesBaseUrl: "",
  filesApiKey: "",
  filesTimeoutMs: 60_000,
  fileToolName: "file_to_markdown",
  visionModel: "",
  visionBaseUrl: "",
  visionApiKey: "",
  sttBaseUrl: "",
  sttApi: "auto" as "auto" | "openai-compatible" | "transcribe-only",
  sttApiKey: "",
  sttTimeoutMs: 60_000,
  sttModel: "Qwen/Qwen3-ASR-1.7B",
  ttsBaseUrl: "",
  ttsApi: "qwen-compatible" as "qwen-compatible" | "openai-compatible",
  ttsApiKey: "",
  ttsTimeoutMs: 60_000,
  ttsModel: "",
  ttsDefaultLanguage: "English",
  ttsDefaultSpeaker: "Vivian",
  ttsDefaultVoiceId: "",
  ttsVoiceSamplePath: "",
  ttsVoiceSampleText: "",
  ttsDefaultQuality: "medium",
  imageGenBaseUrl: "",
  imageGenApiKey: "",
  imageGenTimeoutMs: 120_000,
  imageGenModel: "",
  imageGenDefaultWidth: 1024,
  imageGenDefaultHeight: 1024,
  imageGenDefaultSteps: 28,
  imageGenGuidanceScale: 5.0,
  imageGenDefaultNegativePrompt: "",
  wakeEnabled: false,
  wakeLanguage: "en-US" as "de-DE" | "en-US" | "pl-PL",
  wakeSilenceTimeoutMs: 4000,
  wakeKeywordsText: "Hey Guarded, Okay Guarded, Luna",
  wakeStopPhrasesText: "stop recording, end recording, stop listening, luna stop",
  error: "",
});

const savedVoiceForm = reactive({
  file: null as File | null,
  fileName: "",
  name: "",
  language: "English",
  saving: false,
  error: false,
  message: "",
});

interface ModelEndpointEditorConfig {
  orchestrator: {
    primary: string;
    baseUrl?: string;
    apiKey?: string;
  };
  embeddings: {
    embeddingModel?: string;
    embeddingBaseUrl?: string;
    embeddingApiKey?: string;
  };
  reranker: {
    enabled: boolean;
    model: string;
    baseUrl: string;
    apiKey: string;
  };
  guard: {
    enabled: boolean;
    model: string;
    baseUrl: string;
    apiKey: string;
  };
}

const modelEndpointForm = reactive({
  loaded: false,
  loading: false,
  saving: false,
  error: "",
  lastLoaded: null as ModelEndpointEditorConfig | null,
  orchestratorModel: "",
  orchestratorBaseUrl: "",
  orchestratorApiKey: "",
  embeddingModel: "",
  embeddingBaseUrl: "",
  embeddingApiKey: "",
  rerankerEnabled: false,
  rerankerModel: "Qwen/Qwen3-Reranker-4B",
  rerankerBaseUrl: "http://host.docker.internal:1234/v1",
  rerankerApiKey: "lm-studio",
  guardEnabled: false,
  guardModel: "Qwen/Qwen3Guard-Gen-4B",
  guardBaseUrl: "http://host.docker.internal:1234/v1",
  guardApiKey: "lm-studio",
});

function settingsBaseUrl(): string {
  return (gateway.wsUrl ?? "ws://localhost:8765/ws").replace(/^ws(s?)/, "http$1").replace(/\/ws$/, "");
}

async function parseSettingsError(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("application/json")) {
    try {
      const body = await response.json() as { error?: string; detail?: string };
      return body.error ?? body.detail ?? response.statusText ?? `HTTP ${response.status}`;
    } catch {
      return response.statusText || `HTTP ${response.status}`;
    }
  }

  try {
    const text = (await response.text()).trim();
    return text || response.statusText || `HTTP ${response.status}`;
  } catch {
    return response.statusText || `HTTP ${response.status}`;
  }
}

function syncModelEndpointForm(config: ModelEndpointEditorConfig) {
  modelEndpointForm.lastLoaded = structuredClone(config);
  modelEndpointForm.loaded = true;
  modelEndpointForm.orchestratorModel = config.orchestrator.primary;
  modelEndpointForm.orchestratorBaseUrl = config.orchestrator.baseUrl ?? "";
  modelEndpointForm.orchestratorApiKey = config.orchestrator.apiKey ?? "";
  modelEndpointForm.embeddingModel = config.embeddings.embeddingModel ?? "";
  modelEndpointForm.embeddingBaseUrl = config.embeddings.embeddingBaseUrl ?? "";
  modelEndpointForm.embeddingApiKey = config.embeddings.embeddingApiKey ?? "";
  modelEndpointForm.rerankerEnabled = config.reranker.enabled;
  modelEndpointForm.rerankerModel = config.reranker.model;
  modelEndpointForm.rerankerBaseUrl = config.reranker.baseUrl;
  modelEndpointForm.rerankerApiKey = config.reranker.apiKey;
  modelEndpointForm.guardEnabled = config.guard.enabled;
  modelEndpointForm.guardModel = config.guard.model;
  modelEndpointForm.guardBaseUrl = config.guard.baseUrl;
  modelEndpointForm.guardApiKey = config.guard.apiKey;
  modelEndpointForm.error = "";
}

function resetModelEndpointConfig() {
  if (modelEndpointForm.lastLoaded) syncModelEndpointForm(modelEndpointForm.lastLoaded);
}

function getModelEndpointStatus(role: string) {
  return runtime.modelEndpoints?.endpoints.find((endpoint) => endpoint.role === role) ?? null;
}

async function fetchModelEndpointConfig() {
  if (!gateway.token) return;
  modelEndpointForm.loading = true;
  modelEndpointForm.error = "";

  try {
    const response = await window.fetch(`${settingsBaseUrl()}/api/model-endpoints/config`, {
      headers: { Authorization: `Bearer ${gateway.token}` },
    });
    if (!response.ok) {
      throw new Error(await parseSettingsError(response));
    }

    syncModelEndpointForm(await response.json() as ModelEndpointEditorConfig);
  } catch (error) {
    modelEndpointForm.error = error instanceof Error ? error.message : String(error);
  } finally {
    modelEndpointForm.loading = false;
  }
}

async function submitModelEndpointConfig() {
  if (!gateway.token) return;

  modelEndpointForm.error = "";
  if (!modelEndpointForm.orchestratorModel.trim()) {
    modelEndpointForm.error = "Orchestrator primary model is required";
    return;
  }
  if (!modelEndpointForm.rerankerModel.trim() || !modelEndpointForm.rerankerBaseUrl.trim()) {
    modelEndpointForm.error = "Reranker model and endpoint are required";
    return;
  }
  if (!modelEndpointForm.guardModel.trim() || !modelEndpointForm.guardBaseUrl.trim()) {
    modelEndpointForm.error = "Guard model and endpoint are required";
    return;
  }

  modelEndpointForm.saving = true;
  try {
    const payload: ModelEndpointEditorConfig = {
      orchestrator: {
        primary: modelEndpointForm.orchestratorModel.trim(),
        baseUrl: modelEndpointForm.orchestratorBaseUrl.trim() || undefined,
        apiKey: modelEndpointForm.orchestratorApiKey.trim() || undefined,
      },
      embeddings: {
        embeddingModel: modelEndpointForm.embeddingModel.trim() || undefined,
        embeddingBaseUrl: modelEndpointForm.embeddingBaseUrl.trim() || undefined,
        embeddingApiKey: modelEndpointForm.embeddingApiKey.trim() || undefined,
      },
      reranker: {
        enabled: modelEndpointForm.rerankerEnabled,
        model: modelEndpointForm.rerankerModel.trim(),
        baseUrl: modelEndpointForm.rerankerBaseUrl.trim(),
        apiKey: modelEndpointForm.rerankerApiKey.trim() || "lm-studio",
      },
      guard: {
        enabled: modelEndpointForm.guardEnabled,
        model: modelEndpointForm.guardModel.trim(),
        baseUrl: modelEndpointForm.guardBaseUrl.trim(),
        apiKey: modelEndpointForm.guardApiKey.trim() || "lm-studio",
      },
    };

    const response = await window.fetch(`${settingsBaseUrl()}/api/model-endpoints/config`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${gateway.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(await parseSettingsError(response));
    }

    syncModelEndpointForm(await response.json() as ModelEndpointEditorConfig);
    await runtime.fetch();
  } catch (error) {
    modelEndpointForm.error = error instanceof Error ? error.message : String(error);
  } finally {
    modelEndpointForm.saving = false;
  }
}

function applyNegativePreset(value: string) {
  const current = multimodalForm.imageGenDefaultNegativePrompt.trim();
  if (!current) {
    multimodalForm.imageGenDefaultNegativePrompt = value;
  } else {
    // Append only terms that aren't already present (case-insensitive)
    const existing = new Set(current.toLowerCase().split(",").map(s => s.trim()));
    const newTerms = value.split(",").map(s => s.trim()).filter(t => !existing.has(t.toLowerCase()));
    if (newTerms.length) {
      multimodalForm.imageGenDefaultNegativePrompt = current + ", " + newTerms.join(", ");
    }
  }
}

function listFromCsv(value: string): string[] {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function syncMultimodalForm(config: MultimodalConfig) {
  multimodalForm.maxUploadBytes = config.maxUploadBytes;
  multimodalForm.filesBaseUrl = config.files.baseUrl;
  multimodalForm.filesApiKey = config.files.apiKey ?? "";
  multimodalForm.filesTimeoutMs = config.files.timeoutMs;
  multimodalForm.fileToolName = config.files.toolName;
  multimodalForm.visionModel = config.files.visionModel ?? "";
  multimodalForm.visionBaseUrl = config.files.visionBaseUrl ?? "";
  multimodalForm.visionApiKey = config.files.visionApiKey ?? "";
  multimodalForm.sttBaseUrl = config.stt.baseUrl;
  multimodalForm.sttApi = config.stt.api;
  multimodalForm.sttApiKey = config.stt.apiKey ?? "";
  multimodalForm.sttTimeoutMs = config.stt.timeoutMs;
  multimodalForm.sttModel = config.stt.model;
  multimodalForm.ttsBaseUrl = config.tts.baseUrl;
  multimodalForm.ttsApi = config.tts.api;
  multimodalForm.ttsApiKey = config.tts.apiKey ?? "";
  multimodalForm.ttsTimeoutMs = config.tts.timeoutMs;
  multimodalForm.ttsModel = config.tts.model ?? "";
  multimodalForm.ttsDefaultLanguage = config.tts.defaultLanguage;
  multimodalForm.ttsDefaultSpeaker = config.tts.defaultSpeaker;
  multimodalForm.ttsDefaultVoiceId = config.tts.defaultVoiceId ?? "";
  multimodalForm.ttsVoiceSamplePath = config.tts.voiceSamplePath ?? "";
  multimodalForm.ttsVoiceSampleText = config.tts.voiceSampleText ?? "";
  multimodalForm.ttsDefaultQuality = config.tts.defaultQuality;
  savedVoiceForm.language = config.tts.defaultLanguage;
  multimodalForm.imageGenBaseUrl = config.imageGeneration?.baseUrl ?? "";
  multimodalForm.imageGenApiKey = config.imageGeneration?.apiKey ?? "";
  multimodalForm.imageGenTimeoutMs = config.imageGeneration?.timeoutMs ?? 120_000;
  multimodalForm.imageGenModel = config.imageGeneration?.model ?? "";
  multimodalForm.imageGenDefaultWidth = config.imageGeneration?.defaultWidth ?? 1024;
  multimodalForm.imageGenDefaultHeight = config.imageGeneration?.defaultHeight ?? 1024;
  multimodalForm.imageGenDefaultSteps = config.imageGeneration?.defaultSteps ?? 28;
  multimodalForm.imageGenGuidanceScale = config.imageGeneration?.defaultGuidanceScale ?? 5.0;
  multimodalForm.imageGenDefaultNegativePrompt = config.imageGeneration?.defaultNegativePrompt ?? "";
  multimodalForm.wakeEnabled = config.wakeWord.enabled;
  multimodalForm.wakeLanguage = config.wakeWord.language;
  multimodalForm.wakeSilenceTimeoutMs = config.wakeWord.silenceTimeoutMs;
  multimodalForm.wakeKeywordsText = config.wakeWord.keywords.join(", ");
  multimodalForm.wakeStopPhrasesText = config.wakeWord.stopPhrases.join(", ");
  multimodalForm.error = "";
}

function resetMultimodalForm() {
  syncMultimodalForm(multimodalStore.config);
}

function onSavedVoiceFileSelected(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0] ?? null;
  savedVoiceForm.file = file;
  savedVoiceForm.fileName = file?.name ?? "";
  savedVoiceForm.message = "";
  savedVoiceForm.error = false;
}

async function saveVoiceSampleToLibrary() {
  savedVoiceForm.message = "";
  savedVoiceForm.error = false;

  if (!savedVoiceForm.file) {
    savedVoiceForm.error = true;
    savedVoiceForm.message = "Select a voice sample file first";
    return;
  }
  if (!savedVoiceForm.name.trim()) {
    savedVoiceForm.error = true;
    savedVoiceForm.message = "Voice name is required";
    return;
  }

  savedVoiceForm.saving = true;
  try {
    const result = await gateway.saveTtsVoice({
      file: savedVoiceForm.file,
      name: savedVoiceForm.name.trim(),
      language: savedVoiceForm.language.trim() || undefined,
    });
    multimodalForm.ttsDefaultVoiceId = result.voice_id;
    if (!multimodalForm.ttsVoiceSampleText.trim() && result.ref_text) {
      multimodalForm.ttsVoiceSampleText = result.ref_text;
    }
    savedVoiceForm.error = false;
    savedVoiceForm.message = `Saved voice '${result.name}' as '${result.voice_id}'`;
  } catch (error) {
    savedVoiceForm.error = true;
    savedVoiceForm.message = error instanceof Error ? error.message : String(error);
  } finally {
    savedVoiceForm.saving = false;
  }
}

async function submitMultimodalForm() {
  multimodalForm.error = "";

  const wakeKeywords = listFromCsv(multimodalForm.wakeKeywordsText);
  const wakeStopPhrases = listFromCsv(multimodalForm.wakeStopPhrasesText);

  if (!multimodalForm.filesBaseUrl.trim() || !multimodalForm.sttBaseUrl.trim() || !multimodalForm.ttsBaseUrl.trim()) {
    multimodalForm.error = "Files, STT, and TTS endpoints are required";
    return;
  }
  if (!wakeKeywords.length) {
    multimodalForm.error = "At least one wake keyword is required";
    return;
  }
  if (!wakeStopPhrases.length) {
    multimodalForm.error = "At least one wake stop phrase is required";
    return;
  }

  const imageGenBaseUrl = multimodalForm.imageGenBaseUrl.trim();
  await multimodalStore.save({
    maxUploadBytes: multimodalForm.maxUploadBytes,
    files: {
      baseUrl: multimodalForm.filesBaseUrl.trim(),
      apiKey: multimodalForm.filesApiKey.trim() || undefined,
      timeoutMs: multimodalForm.filesTimeoutMs,
      toolName: multimodalForm.fileToolName.trim(),
      visionModel: multimodalForm.visionModel.trim() || undefined,
      visionBaseUrl: multimodalForm.visionBaseUrl.trim() || undefined,
      visionApiKey: multimodalForm.visionApiKey.trim() || undefined,
    },
    stt: {
      baseUrl: multimodalForm.sttBaseUrl.trim(),
      api: multimodalForm.sttApi,
      apiKey: multimodalForm.sttApiKey.trim() || undefined,
      timeoutMs: multimodalForm.sttTimeoutMs,
      model: multimodalForm.sttModel.trim(),
    },
    tts: {
      baseUrl: multimodalForm.ttsBaseUrl.trim(),
      api: multimodalForm.ttsApi,
      apiKey: multimodalForm.ttsApiKey.trim() || undefined,
      timeoutMs: multimodalForm.ttsTimeoutMs,
      model: multimodalForm.ttsModel.trim() || undefined,
      defaultLanguage: multimodalForm.ttsDefaultLanguage.trim(),
      defaultSpeaker: multimodalForm.ttsDefaultSpeaker.trim(),
      defaultVoiceId: multimodalForm.ttsDefaultVoiceId.trim() || undefined,
      voiceSamplePath: multimodalForm.ttsVoiceSamplePath.trim() || undefined,
      voiceSampleText: multimodalForm.ttsVoiceSampleText.trim() || undefined,
      defaultQuality: multimodalForm.ttsDefaultQuality.trim(),
    },
    wakeWord: {
      enabled: multimodalForm.wakeEnabled,
      language: multimodalForm.wakeLanguage,
      keywords: wakeKeywords,
      stopPhrases: wakeStopPhrases,
      silenceTimeoutMs: multimodalForm.wakeSilenceTimeoutMs,
    },
    imageGeneration: imageGenBaseUrl ? {
      baseUrl: imageGenBaseUrl,
      apiKey: multimodalForm.imageGenApiKey.trim() || undefined,
      timeoutMs: multimodalForm.imageGenTimeoutMs,
      model: multimodalForm.imageGenModel.trim() || undefined,
      defaultWidth: multimodalForm.imageGenDefaultWidth,
      defaultHeight: multimodalForm.imageGenDefaultHeight,
      defaultSteps: multimodalForm.imageGenDefaultSteps,
      defaultGuidanceScale: multimodalForm.imageGenGuidanceScale,
      cpuOffload: true,
      defaultNegativePrompt: multimodalForm.imageGenDefaultNegativePrompt.trim() || undefined,
    } : undefined,
  });

  if (!multimodalStore.error) {
    syncMultimodalForm(multimodalStore.config);
  } else {
    multimodalForm.error = multimodalStore.error;
  }
}

// ── Site form ────────────────────────────────────────────────────────────────

interface UrlEntry { label: string; url: string }

const siteForm = reactive({
  open: false,
  editing: null as string | null,
  hostname: "", username: "", password: "", loginUrl: "",
  urlEntries: [] as UrlEntry[],
  notes: "", usernameSelector: "", passwordSelector: "", submitSelector: "",
  error: "",
});

function openSiteForm(site: SiteSummary | null) {
  siteForm.error = "";
  if (site) {
    siteForm.editing = site.hostname;
    siteForm.hostname = site.hostname;
    siteForm.username = site.username;
    siteForm.password = "";
    siteForm.loginUrl = site.loginUrl ?? "";
    siteForm.urlEntries = Object.entries(site.urls ?? {}).map(([label, url]) => ({ label, url }));
    siteForm.notes = site.notes ?? "";
    siteForm.usernameSelector = "";
    siteForm.passwordSelector = "";
    siteForm.submitSelector = "";
  } else {
    siteForm.editing = null;
    siteForm.hostname = ""; siteForm.username = ""; siteForm.password = "";
    siteForm.loginUrl = ""; siteForm.urlEntries = []; siteForm.notes = "";
    siteForm.usernameSelector = ""; siteForm.passwordSelector = ""; siteForm.submitSelector = "";
  }
  siteForm.open = true;
}

function addUrlEntry() { siteForm.urlEntries.push({ label: "", url: "" }); }

async function submitSiteForm() {
  siteForm.error = "";
  if (!siteForm.hostname.trim()) { siteForm.error = "Hostname is required"; return; }
  if (!siteForm.username.trim()) { siteForm.error = "Username is required"; return; }
  if (!siteForm.password.trim() && !siteForm.editing) { siteForm.error = "Password is required"; return; }

  const urls: Record<string, string> = {};
  for (const e of siteForm.urlEntries) {
    if (e.label.trim() && e.url.trim()) urls[e.label.trim()] = e.url.trim();
  }

  await sites.save(siteForm.hostname.trim(), {
    username: siteForm.username.trim(),
    password: siteForm.password.trim() || undefined,
    loginUrl: siteForm.loginUrl.trim() || undefined,
    urls: Object.keys(urls).length ? urls : undefined,
    notes: siteForm.notes.trim() || undefined,
    usernameSelector: siteForm.usernameSelector.trim() || undefined,
    passwordSelector: siteForm.passwordSelector.trim() || undefined,
    submitSelector: siteForm.submitSelector.trim() || undefined,
  });

  if (!sites.error) siteForm.open = false;
  else siteForm.error = sites.error;
}

async function confirmDeleteSite(hostname: string) {
  if (confirm(`Delete credentials for ${hostname}?`)) await sites.remove(hostname);
}

// ── Scene form ───────────────────────────────────────────────────────────────

const sceneForm = reactive({
  open: false,
  editing: null as string | null,
  name: "", description: "", task: "", webhookKey: "",
  error: "",
});

function openSceneForm(scene: SceneDetail | null) {
  sceneForm.error = "";
  if (scene) {
    sceneForm.editing = scene.name;
    sceneForm.name = scene.name;
    sceneForm.description = scene.description;
    sceneForm.task = scene.task;
    sceneForm.webhookKey = scene.webhookKey ?? "";
  } else {
    sceneForm.editing = null;
    sceneForm.name = ""; sceneForm.description = ""; sceneForm.task = ""; sceneForm.webhookKey = "";
  }
  sceneForm.open = true;
}

async function submitSceneForm() {
  sceneForm.error = "";
  if (!sceneForm.name.trim()) { sceneForm.error = "Name is required"; return; }
  if (!sceneForm.description.trim()) { sceneForm.error = "Description is required"; return; }
  if (!sceneForm.task.trim()) { sceneForm.error = "Task prompt is required"; return; }

  await scenesStore.save(sceneForm.name.trim(), {
    description: sceneForm.description.trim(),
    task: sceneForm.task.trim(),
    webhookKey: sceneForm.webhookKey.trim() || undefined,
  });

  if (!scenesStore.error) sceneForm.open = false;
  else sceneForm.error = scenesStore.error;
}

async function confirmDeleteScene(name: string) {
  if (confirm(`Delete scene "${name}"?`)) await scenesStore.remove(name);
}

// ── Channel form ─────────────────────────────────────────────────────────────

const CHANNEL_DEFS = [
  { type: "telegram", label: "Telegram", description: "Grammy bot with optional user allowlist", fields: ["botToken", "allowedUserIds"] },
  { type: "slack", label: "Slack", description: "Connect your Slack workspace", fields: ["botToken", "signingSecret", "appToken"] },
  { type: "discord", label: "Discord", description: "Connect your Discord server", fields: ["token", "guildIds"] },
  { type: "whatsapp", label: "WhatsApp", description: "Meta Cloud API webhook", fields: ["verifyToken", "appSecret", "accessToken", "phoneNumberId"] },
  { type: "email", label: "Email", description: "IMAP polling + SMTP replies", fields: ["imapHost", "imapUser", "imapPassword", "smtpHost", "smtpUser", "smtpPassword", "smtpFrom"] },
  { type: "signal", label: "Signal", description: "signal-cli bridge", fields: ["account"] },
] as const;

const DEFAULT_CHANNEL_CONFIG: ChannelConfig = {
  enabled: false,
  dmPolicy: "pairing",
  allowFrom: [],
  historyLimit: 50,
  perSenderRateLimitCount: 12,
  perSenderRateLimitWindowMs: 60000,
};

const channelForm = reactive({
  open: false,
  type: "" as string,
  label: "" as string,
  fields: [] as string[],
  config: {} as ChannelConfig,
  details: null as ChannelDetail | null,
  loadingDetails: false,
  error: "",
});

const channelRuntimeSupport = computed(() => {
  return channelsStore.channels.find((channel) => channel.type === channelForm.type) ?? { supported: true, reason: undefined };
});

function getChannelStatus(type: string): ChannelStatus {
  return channelsStore.channels.find((channel) => channel.type === type) ?? {
    type,
    enabled: false,
    running: false,
  };
}

function operatorStateBadgeClass(channel: Pick<ChannelStatus, "operatorState">): string {
  const severity = channel.operatorState?.severity ?? "ok";
  if (severity === "critical") return "badge-health-bad";
  if (severity === "warning") return "badge-config";
  return "badge-running";
}

function operatorStateTextClass(channel: Pick<ChannelStatus, "operatorState">): string {
  const severity = channel.operatorState?.severity ?? "ok";
  if (severity === "critical") return "text-red-300";
  if (severity === "warning") return "text-amber-300";
  return "text-emerald-300";
}

function windowSuccessRateClass(rate?: number): string {
  if (rate === undefined) return "text-gray-300";
  if (rate < 90) return "text-red-300";
  if (rate < 99) return "text-amber-300";
  return "text-emerald-300";
}

function formatPercent(value?: number): string {
  return value === undefined ? "n/a" : `${value.toFixed(value % 1 === 0 ? 0 : 2)}%`;
}

function formatTimestamp(value?: string): string {
  if (!value) return "never";
  return new Date(value).toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function formatHealthTitle(channel: ReturnType<typeof getChannelStatus>): string {
  if (!channel.health) return "No health check yet";

  const parts = [channel.health.healthy ? "Healthy" : "Degraded"];
  if (channel.health.latencyMs !== undefined) parts.push(`${channel.health.latencyMs} ms`);
  if (channel.health.checkedAt) parts.push(`checked ${formatTimestamp(channel.health.checkedAt)}`);
  if (channel.health.error) parts.push(channel.health.error);
  return parts.join(" • ");
}

async function openChannelForm(def: typeof CHANNEL_DEFS[number]) {
  channelForm.error = "";
  channelForm.type = def.type;
  channelForm.label = def.label;
  channelForm.fields = [...def.fields];
  channelForm.config = { ...DEFAULT_CHANNEL_CONFIG };
  channelForm.details = null;
  channelForm.loadingDetails = true;
  channelForm.open = true;

  const detail = await channelsStore.fetchDetails(def.type);
  if (detail) {
    channelForm.details = detail;
    channelForm.config = { ...DEFAULT_CHANNEL_CONFIG, ...detail.config };
  }
  channelForm.loadingDetails = false;
}

async function submitChannelForm() {
  channelForm.error = "";
  await channelsStore.save(channelForm.type, channelForm.config);
  await channelsStore.fetchDeadLetterCount();
  await runtime.fetch();
  if (!channelsStore.error) closeChannelForm();
  else channelForm.error = channelsStore.error;
}

function closeChannelForm() {
  channelForm.open = false;
  channelForm.details = null;
  channelForm.loadingDetails = false;
}

function formatRuntimeName(name: string | undefined): string {
  return (name ?? "").replace(/_/g, " ");
}

function formatModelEndpointRole(role: string): string {
  return role.replace(/^subagent:/, "sub-agent: ").replace(/_/g, " ");
}

async function runRoutingLab() {
  const query = routingLab.query.trim();
  if (!query) return;
  await agentsStore.resolve(query, routingLab.minConfidence);
}

function clearRoutingLab() {
  routingLab.query = "";
  routingLab.minConfidence = "medium";
  agentsStore.clearRoutingResult();
}

// ── Auto-load when connected ─────────────────────────────────────────────────

watch(() => gateway.connected, (connected) => {
  if (connected) {
    if (!guardrails.state) guardrails.fetch();
    sites.fetch();
    scenesStore.fetch();
    channelsStore.fetch();
    channelsStore.fetchDeadLetterCount();
    runtime.fetch();
    agentsStore.fetch();
    multimodalStore.fetch();
    fetchModelEndpointConfig();
  }
}, { immediate: true });

watch(() => multimodalStore.config, (config) => {
  syncMultimodalForm(config);
}, { deep: true, immediate: true });
</script>

<style scoped>
.settings-page {
  height: calc(100vh - 57px);
  overflow-y: auto;
  padding: 1.5rem;
}

.settings-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.25rem;
  max-width: 1400px;
  margin: 0 auto;
}

.model-endpoint-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.55rem 0.7rem;
  border-radius: 0.9rem;
  border: 1px solid rgba(139, 92, 246, 0.12);
  background: rgba(8, 11, 24, 0.28);
}

@media (max-width: 900px) {
  .settings-grid { grid-template-columns: 1fr; }

  .routing-lab-controls {
    grid-template-columns: 1fr;
  }
}

.section-title {
  @apply font-semibold text-gray-100 mb-4 text-sm uppercase tracking-wide;
  background: linear-gradient(to right, #a855f7, #ec4899);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.field-label {
  @apply block text-xs text-gray-400 mb-1.5 font-medium;
}

.multimodal-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.75rem;
}

.multimodal-health-panel {
  @apply rounded-2xl border p-3;
  border-color: rgba(6, 182, 212, 0.12);
  background: rgba(3, 7, 18, 0.45);
}

.multimodal-health-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.75rem;
}

.multimodal-health-card {
  @apply rounded-xl border px-3 py-2;
  border-color: rgba(6, 182, 212, 0.1);
  background: rgba(0, 0, 0, 0.2);
}

@media (max-width: 900px) {
  .multimodal-grid {
    grid-template-columns: 1fr;
  }

  .multimodal-health-grid {
    grid-template-columns: 1fr;
  }
}

.empty-state {
  @apply text-sm text-gray-500 italic py-2;
}

.channel-incident-panel {
  @apply rounded-2xl border p-3;
  border-color: rgba(239, 68, 68, 0.15);
  background: rgba(69, 10, 10, 0.2);
}

.channel-incident-row {
  @apply rounded-xl border p-3;
  border-color: rgba(239, 68, 68, 0.1);
  background: rgba(3, 7, 18, 0.6);
}

.channel-detail-panel {
  @apply rounded-2xl border p-4;
  border-color: rgba(168, 85, 247, 0.1);
  background: rgba(3, 7, 18, 0.6);
}

.channel-detail-metrics {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.75rem;
}

.channel-detail-stat {
  @apply rounded-xl border px-3 py-2 text-xs;
  border-color: rgba(168, 85, 247, 0.1);
  background: rgba(0, 0, 0, 0.2);
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

/* Status dot */
.status-dot {
  width: 8px; height: 8px;
  border-radius: 9999px;
  flex-shrink: 0;
}
.status-dot--on  { background: #4ade80; box-shadow: 0 0 6px rgba(74,222,128,0.6); }
.status-dot--off { background: #f87171; }

/* Site row */
.site-row {
  @apply flex items-start justify-between gap-3 p-3 rounded-xl;
  background: rgba(168, 85, 247, 0.04);
  border: 1px solid rgba(168, 85, 247, 0.1);
  transition: border-color 0.15s;
}
.site-row:hover { border-color: rgba(168, 85, 247, 0.25); }

/* Channel row */
.channel-row {
  @apply p-3 rounded-xl;
  background: rgba(168, 85, 247, 0.04);
  border: 1px solid rgba(168, 85, 247, 0.1);
  transition: border-color 0.15s;
}
.channel-row:hover { border-color: rgba(168, 85, 247, 0.25); }

.badge-running {
  @apply text-xs px-2 py-0.5 rounded-full font-medium;
  background: rgba(74, 222, 128, 0.15);
  color: #4ade80;
  border: 1px solid rgba(74, 222, 128, 0.3);
}
.badge-off {
  @apply text-xs px-2 py-0.5 rounded-full font-medium;
  background: rgba(156, 163, 175, 0.1);
  color: #6b7280;
  border: 1px solid rgba(156, 163, 175, 0.2);
}
.badge-planned {
  @apply text-xs px-2 py-0.5 rounded-full font-medium;
  background: rgba(251, 191, 36, 0.14);
  color: #fbbf24;
  border: 1px solid rgba(251, 191, 36, 0.28);
}

.badge-health-bad {
  @apply text-xs px-2 py-0.5 rounded-full font-medium;
  background: rgba(248, 113, 113, 0.14);
  color: #fca5a5;
  border: 1px solid rgba(248, 113, 113, 0.28);
}

.channel-metrics-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, max-content));
  gap: 0.25rem 1rem;
}

.routing-lab {
  @apply rounded-2xl p-4;
  background: rgba(17, 24, 39, 0.45);
  border: 1px solid rgba(168, 85, 247, 0.14);
}

.routing-lab-controls {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 8rem auto auto;
  gap: 0.75rem;
}

.routing-result-card {
  @apply rounded-2xl p-3;
  background: rgba(17, 24, 39, 0.45);
  border: 1px solid rgba(168, 85, 247, 0.12);
}

.routing-result-card--weak {
  border-color: rgba(251, 191, 36, 0.2);
}

.routing-confidence {
  font-size: 0.7rem;
  line-height: 1rem;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  border-radius: 9999px;
  padding: 0.2rem 0.5rem;
  border: 1px solid transparent;
}

.routing-confidence--high {
  color: #86efac;
  background: rgba(34, 197, 94, 0.12);
  border-color: rgba(34, 197, 94, 0.2);
}

.routing-confidence--medium {
  color: #fde047;
  background: rgba(245, 158, 11, 0.12);
  border-color: rgba(245, 158, 11, 0.2);
}

.routing-confidence--low {
  color: #fca5a5;
  background: rgba(239, 68, 68, 0.12);
  border-color: rgba(239, 68, 68, 0.18);
}

.routing-meta-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  font-size: 0.7rem;
  color: #6b7280;
}

.routing-chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
}

.routing-chip {
  font-size: 0.7rem;
  color: #d8b4fe;
  background: rgba(88, 28, 135, 0.24);
  border: 1px solid rgba(147, 51, 234, 0.2);
  border-radius: 9999px;
  padding: 0.18rem 0.5rem;
}

/* Scene row */
.scene-row {
  @apply p-3 rounded-xl;
  background: rgba(168, 85, 247, 0.04);
  border: 1px solid rgba(168, 85, 247, 0.1);
  transition: border-color 0.15s;
}
.scene-row:hover { border-color: rgba(168, 85, 247, 0.25); }

/* Agent row */
.agent-row {
  @apply p-3 rounded-xl;
  background: rgba(168, 85, 247, 0.04);
  border: 1px solid rgba(168, 85, 247, 0.1);
  transition: border-color 0.15s;
}
.agent-row:hover { border-color: rgba(168, 85, 247, 0.25); }

/* Icon buttons */
.icon-btn {
  @apply p-1.5 rounded-lg text-gray-500 hover:text-gray-200 transition-all text-sm;
}

.icon-btn:hover {
  background: rgba(255, 255, 255, 0.05);
}

.icon-btn--danger {
  @apply hover:text-red-400;
}

.icon-btn--danger:hover {
  background: rgba(239, 68, 68, 0.1);
}

/* Modal */
.modal-backdrop {
  @apply fixed inset-0 flex items-center justify-center z-50 p-4;
  background: rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(8px);
}

.modal-box {
  @apply w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl;
  background: rgba(15, 12, 30, 0.97);
  border: 1px solid rgba(168, 85, 247, 0.25);
  box-shadow: 0 24px 64px rgba(0,0,0,0.6), 0 0 0 1px rgba(168,85,247,0.1) inset;
}

.modal-header {
  @apply flex items-center justify-between px-5 py-4;
  border-bottom: 1px solid rgba(168, 85, 247, 0.12);
}

.modal-close {
  @apply text-gray-500 hover:text-gray-200 transition-colors text-lg leading-none w-7 h-7 flex items-center justify-center rounded-lg;
}

.modal-close:hover {
  background: rgba(255, 255, 255, 0.05);
}

.modal-footer {
  @apply flex justify-end gap-2 px-5 py-4;
  border-top: 1px solid rgba(168, 85, 247, 0.12);
}
</style>
