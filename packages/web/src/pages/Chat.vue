<template>
  <div class="relative flex flex-col" style="height: calc(100vh - 56px)">

    <!-- Orb background canvas -->
    <div class="absolute inset-0 pointer-events-none flex items-center justify-center overflow-hidden">
      <OrbCanvas :ai-state="orbAiState" class="w-full h-full" />
    </div>

    <!-- Session bar -->
    <div class="relative z-10 bg-gray-900/60 backdrop-blur-md border-b border-purple-500/10 px-5 py-2 flex items-center justify-between">
      <div class="flex items-center gap-3 text-xs text-gray-500">
        <span v-if="gateway.currentSessionId">
          Session
          <code class="font-mono text-gray-400 ml-1">{{ gateway.currentSessionId.substring(0, 8) }}…</code>
        </span>
        <span v-else class="italic">No active session</span>
        <select
          v-if="activeSessions.length > 0"
          :value="gateway.currentSessionId ?? ''"
          aria-label="Active session"
          class="rounded-lg border border-purple-500/20 bg-gray-900/70 px-2 py-1 text-[11px] text-gray-300"
          @change="handleSessionSwitch"
        >
          <option value="">Select active session</option>
          <option v-for="session in activeSessions" :key="session.id" :value="session.id">
            {{ session.id.substring(0, 8) }}… · {{ session.turns }} turns
          </option>
        </select>
      </div>
      <div class="flex gap-2">
        <button @click="gateway.createSession()"
          class="btn-grad px-3 py-1 rounded-lg text-xs">New Session</button>
        <template v-if="gateway.currentSessionId">
          <button @click="exportMarkdown"
            :disabled="gateway.messages.length === 0 || exportingTranscript"
            class="btn-ghost px-3 py-1 rounded-lg text-xs disabled:opacity-40"
            title="Download conversation as Markdown">⬇ MD</button>
          <button @click="exportPDF"
            :disabled="gateway.messages.length === 0 || exportingTranscript"
            class="btn-ghost px-3 py-1 rounded-lg text-xs disabled:opacity-40"
            title="Export conversation as PDF">⬇ PDF</button>
          <button @click="archiveCurrentSession"
            class="btn-ghost px-3 py-1 rounded-lg text-xs">Archive</button>
          <button @click="resetSession"
            class="btn-ghost px-3 py-1 rounded-lg text-xs">Reset</button>
        </template>
      </div>
    </div>

    <!-- Workspace -->
    <div class="relative z-10 flex-1 min-h-0 px-4 pb-4 pt-4 sm:px-5">
      <div class="chat-workspace h-full">
        <section class="chat-main-column">
          <div ref="messagesEl" class="chat-message-scroll">
            <details v-if="hasSidePanels" class="chat-mobile-panels lg:hidden" :open="gateway.isLoading">
              <summary class="chat-mobile-panels__summary">
                <span>Live Context</span>
                <span class="chat-mobile-panels__meta">
                  <span v-if="gateway.visibleSwarmState">Swarm</span>
                  <span v-if="computerStore.sessions.length > 0 || computerStore.loading || gateway.isLoading">Computer</span>
                </span>
              </summary>
              <div class="chat-mobile-panels__body">
                <SwarmStatusPanel
                  v-if="gateway.visibleSwarmState"
                  :state="gateway.visibleSwarmState"
                  :active="gateway.isLoading"
                  :runs="gateway.currentSessionSwarmRuns"
                  :selected-run-id="gateway.selectedSwarmRunId"
                  :show-archive-action="Boolean(gateway.currentSessionId)"
                  @select-run="gateway.selectSwarmRun"
                  @open-archive="openInSessions"
                />
                <ComputerSessionPanel v-if="computerStore.loading || computerStore.sessions.length > 0 || gateway.isLoading" />
              </div>
            </details>

            <div v-if="gateway.currentSessionHasOlderMessages" class="flex justify-center">
              <button
                @click="loadOlderMessages"
                :disabled="gateway.currentSessionTranscriptLoading"
                class="rounded-full border border-purple-500/25 bg-gray-900/70 px-4 py-1.5 text-xs text-purple-200 transition hover:border-purple-400/45 hover:text-purple-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {{ gateway.currentSessionTranscriptLoading ? 'Loading older messages...' : 'Load older messages' }}
              </button>
            </div>

            <div v-if="collapsedMessageCount > 0" class="chat-history-collapsed">
              <button
                @click="expandedMessageHistory = !expandedMessageHistory"
                class="chat-history-collapsed__button"
              >
                {{ expandedMessageHistory ? `Hide ${collapsedMessageCount} older message${collapsedMessageCount === 1 ? '' : 's'}` : `Show ${collapsedMessageCount} older message${collapsedMessageCount === 1 ? '' : 's'}` }}
              </button>
            </div>

            <MessageBubble
              v-for="(msg, idx) in visibleMessages"
              :key="msg.id"
              :message="msg"
              :is-streaming="msg.id === 'streaming'"
              :streaming-text="msg.id === 'streaming' ? gateway.streamingText : undefined"
              :auto-collapse="msg.role === 'assistant' && idx !== lastAssistantVisibleIdx && msg.id !== 'streaming'"
            />
          </div>
        </section>

        <aside class="chat-side-column hidden lg:flex">
          <div class="chat-side-stack">
            <SwarmStatusPanel
              v-if="gateway.visibleSwarmState"
              :state="gateway.visibleSwarmState"
              :active="gateway.isLoading"
              :runs="gateway.currentSessionSwarmRuns"
              :selected-run-id="gateway.selectedSwarmRunId"
              :show-archive-action="Boolean(gateway.currentSessionId)"
              @select-run="gateway.selectSwarmRun"
              @open-archive="openInSessions"
            />
            <ComputerSessionPanel v-if="computerStore.loading || computerStore.sessions.length > 0 || gateway.isLoading" />
            <div v-if="!hasSidePanels" class="chat-sidebar-placeholder">
              <div class="chat-sidebar-placeholder__eyebrow">Live Context</div>
              <p class="chat-sidebar-placeholder__copy">Swarm state, computer sessions, and live previews appear here during active delegation and desktop control.</p>
            </div>
          </div>
        </aside>
      </div>
    </div>

    <!-- Human-in-the-loop approval banner -->
    <Transition name="approval">
      <div v-if="gateway.pendingApproval"
           role="alertdialog" aria-live="assertive"
           class="relative z-20 mx-5 mb-2 rounded-2xl overflow-hidden"
           style="background: rgba(15,12,30,0.97); border: 1px solid rgba(168,85,247,0.5); box-shadow: 0 0 24px rgba(168,85,247,0.25);">
        <div class="px-5 py-4">
          <div class="flex items-center gap-2 mb-2">
            <span class="text-xs font-semibold tracking-widest uppercase"
                  style="background: linear-gradient(90deg,#a855f7,#ec4899); -webkit-background-clip:text; -webkit-text-fill-color:transparent;">
              Approval Required
            </span>
          </div>
          <p class="text-sm text-gray-300 mb-1">
            The agent wants to call
            <code class="text-purple-300 bg-purple-900/30 px-1.5 py-0.5 rounded font-mono text-xs">{{ gateway.pendingApproval.toolName }}</code>
            with these arguments:
          </p>
          <pre class="text-xs text-gray-400 bg-gray-900/60 rounded-lg px-3 py-2 overflow-x-auto mb-4 max-h-36"
               style="border: 1px solid rgba(168,85,247,0.2);">{{ JSON.stringify(gateway.pendingApproval.args, null, 2) }}</pre>
          <div class="flex gap-3">
            <button @click="approveAction(true)"
                    class="btn-grad px-5 py-2 rounded-xl text-sm font-semibold">
              Approve
            </button>
            <button @click="approveAction(false)"
                    class="btn-ghost px-5 py-2 rounded-xl text-sm font-semibold"
                    style="border-color: rgba(239,68,68,0.4); color: #f87171;">
              Deny
            </button>
          </div>
        </div>
      </div>
    </Transition>

    <Transition name="approval">
      <div v-if="gateway.pendingIntervention"
           role="alert" aria-live="assertive"
           class="relative z-20 mx-5 mb-2 rounded-2xl overflow-hidden"
           :class="gateway.pendingIntervention.severity === 'error' ? 'border border-red-500/45' : 'border border-amber-500/45'"
           style="background: rgba(18,14,28,0.97); box-shadow: 0 0 24px rgba(245,158,11,0.16);">
        <div class="px-5 py-4">
          <div class="flex items-center justify-between gap-3 mb-2">
            <div>
              <div class="text-xs font-semibold tracking-widest uppercase text-amber-300">Operator Action Suggested</div>
              <div class="mt-1 text-sm text-gray-100">{{ gateway.pendingIntervention.summary }}</div>
            </div>
            <button @click="gateway.dismissIntervention()"
                    class="rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-gray-400 transition hover:border-white/20 hover:text-gray-200">
              Dismiss
            </button>
          </div>
          <p class="text-sm text-gray-300 mb-3">{{ gateway.pendingIntervention.detail }}</p>
          <div class="flex flex-wrap gap-3">
            <button
              v-for="action in gateway.pendingIntervention.actions"
              :key="action.kind"
              @click="handleInterventionAction(action)"
              :disabled="action.kind === 'stop_turn' && !gateway.isLoading"
              class="btn-ghost px-4 py-2 rounded-xl text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {{ action.label }}
            </button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- Input area -->
    <div class="relative z-10 bg-gray-900/70 backdrop-blur-lg border-t border-purple-500/15 px-5 py-4">

      <!-- Pending image attachment chips -->
      <div v-if="pendingImageContexts.length > 0" class="flex flex-wrap gap-2 mb-2">
        <div
          v-for="(img, idx) in pendingImageContexts"
          :key="img.filename + idx"
          class="flex items-center gap-1.5 rounded-xl border border-purple-500/40 bg-purple-900/20 overflow-hidden pr-1"
        >
          <!-- Thumbnail — click opens preview modal -->
          <button
            @click="previewModalUrl = img.previewUrl"
            class="shrink-0 focus:outline-none"
            title="Preview image"
          >
            <img :src="img.previewUrl" :alt="img.filename" class="h-9 w-9 object-cover rounded-l-xl" />
          </button>
          <!-- Filename -->
          <span class="text-xs text-purple-300 max-w-[8rem] truncate select-none">{{ img.filename }}</span>
          <!-- Remove -->
          <button
            @click="removeImage(idx)"
            class="text-purple-400 hover:text-red-300 transition-colors px-0.5 text-xs leading-none"
            title="Remove"
          >✕</button>
        </div>
      </div>

      <!-- Inline override flag chips -->
      <div v-if="activeFlags.length > 0" class="flex flex-wrap gap-1.5 mb-2">
        <button
          v-for="flag in activeFlags"
          :key="flag.label"
          @click="removeFlag(flag.pattern)"
          :class="['flex items-center gap-1 px-2 py-0.5 text-xs rounded-full border transition-colors', flagChipClass(flag.color)]"
          title="Click to remove flag"
        >
          {{ flag.label }}
          <span class="opacity-50 ml-0.5">✕</span>
        </button>
      </div>

      <div v-if="showMultimodalStatus" class="mb-3 flex flex-wrap items-center gap-2 text-xs text-gray-300">
        <span class="multimodal-status rounded-full px-3 py-1 text-[11px] uppercase tracking-wide">
          {{ voiceStatus }}
        </span>
        <span v-if="showWakeMode && wakeListening" class="multimodal-status multimodal-status-live rounded-full px-3 py-1 text-[11px] uppercase tracking-wide">
          Say {{ wakeKeywords.join(" / ") }}
        </span>
      </div>

      <div v-if="runningSceneJobs.length > 0" class="chat-job-strip">
        <div
          v-for="job in runningSceneJobs"
          :key="job.id"
          class="chat-job-strip__item"
        >
          <div class="chat-job-strip__title-row">
            <span class="chat-job-strip__title">{{ formatSceneName(job.sceneName) }}</span>
            <span class="chat-job-strip__percent">{{ Math.round(job.progress.percent ?? 0) }}%</span>
          </div>
          <div class="chat-job-strip__meta">
            {{ job.progress.currentStep || job.progress.currentTool || job.progress.message || (job.definitionType === 'job' ? 'Running in background' : 'Scene running in background') }}
          </div>
        </div>
      </div>

      <div class="hidden">
        <input
          ref="fileInputEl"
          type="file"
          class="hidden"
          accept=".pdf,.doc,.docx,.txt,.md,.csv,image/*"
          @change="onDocumentSelected"
        />
        <input
          ref="audioInputEl"
          type="file"
          class="hidden"
          accept="audio/*"
          @change="onAudioSelected"
        />
      </div>

      <div v-if="audioPreviewUrl" class="reply-audio-panel">
        <audio
          ref="audioPlayerEl"
          :src="audioPreviewUrl"
          class="hidden"
          preload="metadata"
          @loadedmetadata="syncAudioPreviewState"
          @timeupdate="syncAudioPreviewState"
          @play="syncAudioPreviewState"
          @pause="syncAudioPreviewState"
          @ended="handleAudioPreviewEnded"
        />

        <div class="reply-audio-panel__header">
          <div class="reply-audio-panel__headline">
            <div class="reply-audio-panel__eyebrow">Reply Audio</div>
            <div class="reply-audio-panel__meta">{{ audioPlaying ? 'Playing response' : 'Ready to play' }}</div>
          </div>
        </div>

        <div class="reply-audio-panel__transport">
          <button
            type="button"
            class="reply-audio-panel__play"
            :disabled="audioDuration <= 0"
            @click="toggleAudioPreviewPlayback"
          >
            {{ audioPlaying ? 'Pause' : 'Play' }}
          </button>

          <input
            type="range"
            min="0"
            max="100"
            step="0.1"
            :value="audioProgressPercent"
            class="reply-audio-panel__range"
            aria-label="Reply audio timeline"
            @input="seekAudioPreview"
          />

          <div class="reply-audio-panel__time">{{ formatMediaTime(audioCurrentTime) }} / {{ formatMediaTime(audioDuration) }}</div>

          <div class="reply-audio-panel__actions">
            <button
              v-if="lastSpokenSummary"
              type="button"
              class="reply-audio-panel__summary-toggle"
              @click="audioSummaryExpanded = !audioSummaryExpanded"
            >
              {{ audioSummaryExpanded ? 'Hide text' : 'Show text' }}
            </button>

            <button
              type="button"
              class="reply-audio-panel__restart"
              :disabled="audioDuration <= 0"
              @click="restartAudioPreview"
            >
              Restart
            </button>
          </div>
        </div>

        <p v-if="lastSpokenSummary && audioSummaryExpanded" class="reply-audio-panel__summary">
          <span class="reply-audio-panel__summary-label">Spoken summary</span>
          <span>{{ lastSpokenSummary }}</span>
        </p>
      </div>

      <div class="chat-composer" :class="compactComposer ? 'chat-composer--compact' : ''">
        <div class="chat-composer__field">
          <textarea
            ref="composerTextareaEl"
            v-model="inputText"
            @keydown.enter.exact.prevent="sendMessage"
            @keydown.enter.shift.exact="inputText += '\n'"
            :disabled="gateway.isLoading || !gateway.connected"
            class="chat-composer__textarea"
            :class="compactComposer ? 'chat-composer__textarea--compact' : ''"
            :style="composerTextareaStyle"
            placeholder="Message StarlingAI… (Enter to send, Shift+Enter for newline)"
            rows="3"
          />
        </div>

        <div class="chat-composer__controls">
          <div class="chat-composer__menus">
            <details v-if="showOptionsDropdown" class="chat-dropdown">
              <summary class="chat-dropdown__summary">
                <span>Options</span>
                <span class="chat-dropdown__chevron">▾</span>
              </summary>
              <div class="chat-dropdown__menu">
                <div class="chat-dropdown__group">
                  <div class="chat-dropdown__label">Attachments & Voice</div>
                  <div class="chat-dropdown__actions">
                    <button
                      v-if="showFileInput"
                      @click="fileInputEl?.click()"
                      :disabled="multimodalBusy"
                      class="btn-brand-ghost multimodal-action multimodal-icon-button px-3 py-1.5 rounded-xl disabled:opacity-40"
                      title="Attach a document or image"
                      aria-label="Attach file"
                    >
                      <svg class="multimodal-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                        <path d="M14 3v5h5" />
                        <path d="M8.5 15.5l2.5-2.5 2.5 2.5 2-2 1.5 1.5" />
                        <circle cx="9" cy="10" r="1" />
                      </svg>
                    </button>
                    <button
                      v-if="showAudioUpload"
                      @click="audioInputEl?.click()"
                      :disabled="multimodalBusy"
                      class="btn-brand-ghost multimodal-action multimodal-icon-button px-3 py-1.5 rounded-xl disabled:opacity-40"
                      title="Upload an audio file for transcription"
                      aria-label="Upload audio"
                    >
                      <svg class="multimodal-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M12 16V4" />
                        <path d="M8.5 7.5 12 4l3.5 3.5" />
                        <path d="M4 15v2a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-2" />
                        <path d="M8 12.5a4 4 0 0 0 8 0" />
                      </svg>
                    </button>
                    <button
                      v-if="showRecording"
                      @click="toggleRecording()"
                      :disabled="multimodalBusy && recordingState !== 'recording'"
                      class="btn-brand-ghost multimodal-action multimodal-icon-button px-3 py-1.5 rounded-xl disabled:opacity-40"
                      :class="recordingState === 'recording' ? 'multimodal-action-active' : ''"
                      :title="recordingState === 'recording' ? 'Stop microphone recording' : 'Record voice from the microphone'"
                      :aria-label="recordingState === 'recording' ? 'Stop recording' : 'Record voice'"
                    >
                      <svg class="multimodal-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3Z" />
                        <path d="M6.5 10.5a5.5 5.5 0 0 0 11 0" />
                        <path d="M12 16v4" />
                        <path d="M8.5 20h7" />
                      </svg>
                    </button>
                    <button
                      v-if="showWakeMode"
                      @click="toggleWakeListening()"
                      :disabled="recordingState === 'processing'"
                      class="btn-brand-ghost multimodal-action multimodal-icon-button px-3 py-1.5 rounded-xl disabled:opacity-40"
                      :class="wakeListening ? 'multimodal-action-active' : ''"
                      :title="wakeListening ? 'Disable wake-word detection' : 'Enable wake-word detection'"
                      :aria-label="wakeListening ? 'Stop wake mode' : 'Start wake mode'"
                    >
                      <svg class="multimodal-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M14.75 4.5c-2.9 0-5.25 2.35-5.25 5.25v4.5c0 2.07 1.68 3.75 3.75 3.75h.25" />
                        <path d="M14.25 7.5a2.75 2.75 0 0 0-2.75 2.75v3.5a1.75 1.75 0 0 0 1.75 1.75" />
                        <path d="M13.5 18.25c0 1.8 1.45 3.25 3.25 3.25S20 20.05 20 18.25 18.55 15 16.75 15c-1.17 0-2.19.62-2.76 1.54" />
                        <path d="M18.1 16.9 15.5 19.5" />
                        <path d="m15.5 16.9 2.6 2.6" />
                      </svg>
                    </button>
                    <button
                      v-if="showSpeechPlayback"
                      @click="speakLatestAssistant()"
                      :disabled="multimodalBusy || !latestAssistantText"
                      class="btn-brand-ghost multimodal-action multimodal-icon-button px-3 py-1.5 rounded-xl disabled:opacity-40"
                      title="Speak a summary of the latest assistant reply"
                      aria-label="Speak reply"
                    >
                      <svg class="multimodal-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M5 9v6" />
                        <path d="M9 7v10" />
                        <path d="M13 4v16" />
                        <path d="M17 8a4 4 0 0 1 0 8" />
                        <path d="M19 5a7.5 7.5 0 0 1 0 14" />
                      </svg>
                    </button>
                    <button
                      v-if="showSpeechPlayback"
                      @click="toggleSpeakReply()"
                      class="btn-brand-ghost multimodal-action multimodal-icon-button px-3 py-1.5 rounded-xl"
                      :class="speakReplyEnabled ? 'multimodal-action-active' : ''"
                      :title="speakReplyEnabled ? 'Auto-speak reply summary is ON — click to disable' : 'Auto-speak reply summary is OFF — click to enable'"
                      :aria-label="speakReplyEnabled ? 'Disable auto-speak' : 'Enable auto-speak'"
                      :aria-pressed="speakReplyEnabled"
                    >
                      <svg class="multimodal-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M11 5 6 9H3v6h3l5 4V5Z" />
                        <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                        <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                      </svg>
                    </button>
                  </div>
                </div>

                <div v-if="gateway.scenes.length > 0" class="chat-dropdown__group">
                  <div class="chat-dropdown__label">Scenes</div>
                  <div class="chat-dropdown__scene-grid">
                    <button
                      v-for="scene in gateway.scenes"
                      :key="scene.name"
                      @click="triggerScene(scene.name)"
                      :disabled="gateway.isLoading || !gateway.connected || isSceneRunning(scene.name)"
                      :title="scene.description"
                      class="chat-scene-pill"
                    >
                      <span class="text-purple-500 transition-colors">{{ isSceneRunning(scene.name) ? '●' : '▶' }}</span>
                      {{ scene.name.replace(/_/g, ' ') }}
                    </button>
                  </div>
                </div>

                <div v-if="configuredJobs.length > 0" class="chat-dropdown__group">
                  <div class="chat-dropdown__label">Jobs</div>
                  <div class="chat-dropdown__scene-grid">
                    <button
                      v-for="job in configuredJobs"
                      :key="job.name"
                      @click="triggerJob(job.name)"
                      :disabled="gateway.isLoading || !gateway.connected || isJobRunning(job.name)"
                      :title="job.description"
                      class="chat-scene-pill"
                    >
                      <span class="text-cyan-400 transition-colors">{{ isJobRunning(job.name) ? '●' : '↻' }}</span>
                      {{ job.name.replace(/_/g, ' ') }}
                    </button>
                  </div>
                </div>
              </div>
            </details>

            <details v-if="showJobsDropdown" class="chat-dropdown">
              <summary class="chat-dropdown__summary">
                <span>{{ jobsDropdownLabel }}</span>
                <span class="chat-dropdown__chevron">▾</span>
              </summary>
              <div class="chat-dropdown__menu chat-dropdown__menu--jobs">
                <div v-if="sceneJobs.length === 0 && scenesStore.runError" class="rounded-2xl border border-red-500/20 bg-red-950/15 px-3 py-3 text-xs text-red-200">
                  {{ scenesStore.runError }}
                </div>
                <div v-for="job in sceneJobs" :key="job.id" :class="['rounded-2xl border px-3 py-3 text-sm backdrop-blur-md', sceneCardClass(job.status)]">
                  <div class="flex items-start justify-between gap-3">
                    <div>
                      <div class="flex items-center gap-2">
                        <span class="text-sm font-medium text-gray-100">{{ formatSceneName(job.sceneName) }}</span>
                        <span class="rounded-full bg-white/10 px-2 py-0.5 text-[11px] uppercase tracking-wide text-gray-300">{{ job.definitionType === 'job' ? 'job' : 'scene' }}</span>
                        <span :class="sceneStatusClass(job.status)">{{ job.status }}</span>
                      </div>
                      <div class="mt-1 text-[11px] uppercase tracking-wide text-gray-500">Job {{ shortJobId(job.id) }}</div>
                    </div>
                    <div class="flex items-center gap-2">
                      <button
                        v-if="isSceneJobCancelable(job.status)"
                        @click="scenesStore.cancel(job.id)"
                        class="rounded-full border border-amber-500/25 px-2 py-0.5 text-[11px] text-amber-200 transition hover:border-amber-400/50 hover:text-amber-100"
                      >
                        Cancel
                      </button>
                      <button
                        @click="scenesStore.dismissJob(job.id)"
                        class="rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-gray-400 transition hover:border-white/20 hover:text-gray-200"
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>

                  <div class="mt-2 flex flex-wrap gap-2 text-[11px] text-gray-400">
                    <span>{{ sceneLifecycleLabel(job) }}</span>
                    <span v-if="job.completedAt">Finished {{ formatSceneTimestamp(job.completedAt) }}</span>
                    <span v-if="job.performance">{{ formatDuration(job.performance.turnDurationMs) }}</span>
                    <span v-if="typeof job.toolCallsExecuted === 'number'">{{ job.toolCallsExecuted }} tool call{{ job.toolCallsExecuted === 1 ? '' : 's' }}</span>
                  </div>

                  <div class="mt-3">
                    <div class="flex items-center justify-between text-[11px] text-gray-400">
                      <span>{{ job.progress.message ?? 'Waiting for worker updates' }}</span>
                      <span>{{ Math.round(job.progress.percent ?? 0) }}%</span>
                    </div>
                    <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-black/30">
                      <div class="h-full rounded-full bg-gradient-to-r from-sky-400 via-cyan-300 to-emerald-300 transition-[width] duration-300" :style="{ width: `${Math.max(0, Math.min(100, job.progress.percent ?? 0))}%` }" />
                    </div>
                  </div>

                  <div v-if="job.progress.totalSteps" class="mt-2 flex flex-wrap gap-2 text-[11px] text-gray-400">
                    <span>Steps {{ job.progress.completedSteps ?? 0 }} / {{ job.progress.totalSteps }}</span>
                    <span v-if="job.progress.currentStep">Current step: {{ job.progress.currentStep }}</span>
                  </div>

                  <div class="mt-3 grid grid-cols-2 gap-2 text-[11px] text-gray-300 sm:grid-cols-4">
                    <div class="rounded-xl bg-black/20 px-2 py-1.5">
                      <div class="text-gray-500">Tools</div>
                      <div class="mt-1 text-gray-100">{{ job.progress.toolCallsCompleted }} / {{ job.progress.toolCallsRequested }}</div>
                    </div>
                    <div class="rounded-xl bg-black/20 px-2 py-1.5">
                      <div class="text-gray-500">Approvals</div>
                      <div class="mt-1 text-gray-100">{{ job.progress.approvalsRequested }}</div>
                    </div>
                    <div class="rounded-xl bg-black/20 px-2 py-1.5">
                      <div class="text-gray-500">Sub-agents</div>
                      <div class="mt-1 text-gray-100">{{ job.progress.subAgentsStarted }}</div>
                    </div>
                    <div class="rounded-xl bg-black/20 px-2 py-1.5">
                      <div class="text-gray-500">Swarm tasks</div>
                      <div class="mt-1 text-gray-100">{{ job.progress.swarmTasksCompleted }} / {{ job.progress.swarmTasksTotal }}</div>
                    </div>
                  </div>

                  <p v-if="job.status === 'queued' || job.status === 'running' || job.status === 'cancelling'" class="mt-2 text-xs text-sky-200/90">
                    {{ job.progress.currentTool ? `Current tool: ${job.progress.currentTool}` : job.progress.currentAgent ? `Current agent: ${job.progress.currentAgent}` : job.definitionType === 'job' ? 'Job is running in the background.' : 'Scene is running in the background.' }}
                  </p>
                  <p v-else-if="job.error" class="mt-2 line-clamp-3 text-xs text-red-200/90">
                    {{ job.error }}
                  </p>
                  <p v-else-if="job.response" class="mt-2 line-clamp-4 text-xs text-gray-300/90">
                    {{ job.response }}
                  </p>
                </div>

                <div v-if="sceneJobs.length > 0" class="flex justify-end">
                  <button @click="openJobs" class="btn-ghost px-3 py-1 rounded-lg text-xs">Open Jobs Dashboard</button>
                </div>
              </div>
            </details>
          </div>

          <div class="chat-composer__primary-actions">
            <button
              @click="cycleThinkingMode"
              class="btn-brand-ghost multimodal-icon-button px-3 py-3 rounded-2xl shrink-0 transition-colors"
              :class="thinkingMode === true
                ? 'multimodal-action-active'
                : thinkingMode === false
                  ? 'opacity-40 border-dashed'
                  : 'opacity-60 hover:opacity-100'"
              :title="thinkingMode === undefined
                ? 'Thinking: auto — click to enable extended reasoning'
                : thinkingMode
                  ? 'Thinking: ON — click to disable'
                  : 'Thinking: OFF — click to reset to auto'"
              :aria-label="thinkingMode === undefined ? 'Thinking auto' : thinkingMode ? 'Thinking on' : 'Thinking off'"
              :aria-pressed="thinkingMode === true"
            >
              <svg class="multimodal-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.44-3.16Z" />
                <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.44-3.16Z" />
              </svg>
              <span v-if="thinkingMode !== undefined" class="text-[10px] leading-none mt-0.5">
                {{ thinkingMode ? 'on' : 'off' }}
              </span>
            </button>

            <button
              v-if="gateway.isLoading"
              @click="gateway.cancelTurn()"
              class="px-5 py-3 rounded-2xl text-sm shrink-0 font-semibold transition-colors bg-red-600/80 hover:bg-red-500/90 border border-red-400/40 text-white"
              title="Stop the current turn"
            >
              Stop
            </button>
            <button
              v-else
              @click="sendMessage"
              :disabled="(!inputText.trim() && pendingImageContexts.length === 0) || !gateway.connected"
              class="btn-grad px-5 py-3 rounded-2xl text-sm shrink-0"
            >
              Send
            </button>
          </div>
        </div>
      </div>

      <div class="text-xs text-gray-700 mt-2 px-1">
        Guardrails active · All messages audited · Overrides: <code class="font-mono">--auto</code> <code class="font-mono">--iter N</code> <code class="font-mono">--agent NAME</code> <code class="font-mono">--timeout N</code>
      </div>
    </div>
  </div>

  <!-- Image preview modal -->
  <Teleport to="body">
    <div
      v-if="previewModalUrl"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm"
      @click.self="previewModalUrl = null"
      @keydown.esc.window="previewModalUrl = null"
    >
      <div class="relative max-w-4xl max-h-[90vh] p-2">
        <img
          :src="previewModalUrl"
          alt="Image preview"
          class="max-w-full max-h-[85vh] rounded-xl object-contain shadow-2xl"
        />
        <button
          @click="previewModalUrl = null"
          class="absolute -top-2 -right-2 w-7 h-7 rounded-full bg-gray-800 border border-gray-600 text-gray-300 hover:text-white hover:bg-gray-700 flex items-center justify-center text-sm transition-colors"
          title="Close"
        >✕</button>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted, onUnmounted, defineAsyncComponent } from "vue";
import { useRouter } from "vue-router";
import { useStorage } from "@vueuse/core";
import { sanitizeAssistantMessageContent, useGatewayStore } from "@/stores/gateway";
import { useJobsStore } from "@/stores/jobs";
import { useScenesStore } from "@/stores/scenes";
import { useMultimodalStore } from "@/stores/multimodal";
import { useComputerStore } from "@/stores/computer";
import type { GatewaySessionTranscriptMessage, InterventionAction } from "@/stores/gateway";
import { readSpeakReplySummaryStorage, writeSpeakReplySummaryStorage } from "@/stores/multimodal";
import { marked } from "marked";
import MessageBubble from "@/components/MessageBubble.vue";
import SwarmStatusPanel from "@/components/SwarmStatusPanel.vue";
import ComputerSessionPanel from "@/components/ComputerSessionPanel.vue";

const OrbCanvas = defineAsyncComponent(() => import("@/components/OrbCanvas.vue"));

const gateway = useGatewayStore();
const jobsStore = useJobsStore();
const scenesStore = useScenesStore();
const multimodalStore = useMultimodalStore();
const computerStore = useComputerStore();
const router = useRouter();
const inputText = ref("");
const composerTextareaEl = ref<HTMLTextAreaElement | null>(null);
const messagesEl = ref<HTMLElement | null>(null);
const fileInputEl = ref<HTMLInputElement | null>(null);
const audioInputEl = ref<HTMLInputElement | null>(null);
const audioPlayerEl = ref<HTMLAudioElement | null>(null);
const audioPreviewUrl = ref<string | null>(null);
const audioCurrentTime = ref(0);
const audioDuration = ref(0);
const audioPlaying = ref(false);
const audioSummaryExpanded = ref(false);
const multimodalBusy = ref(false);
const recordingState = ref<"idle" | "recording" | "processing">("idle");
const wakeListening = ref(false);
const wakeStatus = ref("Voice idle");
const wakeKeywords = useStorage<string[]>("gc_wake_keywords", ["Hey Guarded", "Okay Guarded", "Luna"]);
const wakeStopPhrases = useStorage<string[]>("gc_wake_stop_phrases", ["stop recording", "end recording", "stop listening", "luna stop"]);
const wakeLanguage = useStorage<string>("gc_wake_language", "en-US");
const wakeSilenceTimeoutMs = useStorage<number>("gc_wake_silence_ms", 4000);
const speakReplyEnabled = useStorage<boolean>("sai_speak_reply", false);
const lastSpokenSummary = ref<string | null>(null);
const exportingTranscript = ref(false);
/** Per-message thinking toggle for models that support enable_thinking: undefined = auto, true = on, false = off */
const thinkingMode = ref<boolean | undefined>(undefined);
/** Images queued for the current composer message — analyzed and sent together on submit. */
const pendingImageContexts = ref<Array<{ filename: string; file: File; previewUrl: string }>>([]);
const previewModalUrl = ref<string | null>(null);
const expandedMessageHistory = ref(false);

const audioProgressPercent = computed(() => {
  if (audioDuration.value <= 0) return 0;
  return Math.min(100, Math.max(0, (audioCurrentTime.value / audioDuration.value) * 100));
});

function removeImage(idx: number) {
  const img = pendingImageContexts.value[idx];
  if (img) URL.revokeObjectURL(img.previewUrl);
  pendingImageContexts.value.splice(idx, 1);
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function cycleThinkingMode() {
  if (thinkingMode.value === undefined) thinkingMode.value = true;
  else if (thinkingMode.value === true) thinkingMode.value = false;
  else thinkingMode.value = undefined;
}

interface SpeechRecognitionResultItem {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: SpeechRecognitionResultItem;
  length: number;
}

interface SpeechRecognitionEventLike extends Event {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionErrorEventLike extends Event {
  error?: string;
}

interface BrowserSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

declare global {
  interface Window {
    SpeechRecognition?: new () => BrowserSpeechRecognition;
    webkitSpeechRecognition?: new () => BrowserSpeechRecognition;
  }
}

let wakeRecognition: BrowserSpeechRecognition | null = null;
let wakeRestartTimer: number | null = null;
let mediaRecorder: MediaRecorder | null = null;
let mediaStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let audioIntervalId: number | null = null;
let lastAudioActivityAt = 0;
let observedSpeech = false;
const recordedChunks: Blob[] = [];

interface FlagChip {
  label: string;
  pattern: RegExp;
  color: "purple" | "sky" | "amber";
}

const activeFlags = computed<FlagChip[]>(() => {
  const text = inputText.value;
  const chips: FlagChip[] = [];
  if (/--auto\b/.test(text)) chips.push({ label: "--auto: skip approvals", pattern: /\s*--auto\b/g, color: "amber" });
  const iterMatch = text.match(/--iter\s+(\d+)\b/);
  if (iterMatch) chips.push({ label: `--iter ${iterMatch[1]}`, pattern: /\s*--iter\s+\d+\b/, color: "sky" });
  const agentMatch = text.match(/--agent\s+(\S+)/);
  if (agentMatch) chips.push({ label: `--agent ${agentMatch[1]}`, pattern: /\s*--agent\s+\S+/, color: "purple" });
  const timeoutMatch = text.match(/--timeout\s+(\d+)\b/);
  if (timeoutMatch) chips.push({ label: `--timeout ${timeoutMatch[1]}s`, pattern: /\s*--timeout\s+\d+\b/, color: "sky" });
  return chips;
});

function removeFlag(pattern: RegExp) {
  inputText.value = inputText.value.replace(pattern, "").trim();
}

function flagChipClass(color: "purple" | "sky" | "amber"): string {
  if (color === "amber") return "border-amber-500/40 bg-amber-900/25 text-amber-300 hover:border-red-500/40 hover:text-red-300";
  if (color === "sky") return "border-sky-500/40 bg-sky-900/25 text-sky-300 hover:border-red-500/40 hover:text-red-300";
  return "border-purple-500/40 bg-purple-900/25 text-purple-300 hover:border-red-500/40 hover:text-red-300";
}

/** True while image analysis is in-flight before the backend call starts. */
const analysing = ref(false);

const compactComposer = computed(() => gateway.isLoading || analysing.value);
const composerMinHeight = computed(() => compactComposer.value ? 64 : 92);
const composerMaxHeight = computed(() => compactComposer.value ? 160 : 248);
const composerTextareaStyle = computed(() => ({
  minHeight: `${composerMinHeight.value}px`,
  maxHeight: `${composerMaxHeight.value}px`,
}));

function adjustComposerHeight() {
  const textarea = composerTextareaEl.value;
  if (!textarea) return;
  textarea.style.height = "0px";
  const nextHeight = Math.min(Math.max(textarea.scrollHeight, composerMinHeight.value), composerMaxHeight.value);
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = textarea.scrollHeight > composerMaxHeight.value ? "auto" : "hidden";
}

const activeStreamingMessage = computed(() =>
  gateway.messages.find((message) => message.id === "streaming") ?? null,
);

const hasRunningToolCalls = computed(() =>
  Boolean(activeStreamingMessage.value?.toolCalls?.some((toolCall) => toolCall.result === undefined)),
);

const hasRunningSwarmTasks = computed(() => {
  const state = gateway.visibleSwarmState;
  if (!state) return false;
  return Object.values(state.tasks ?? {}).some((task) => task.status === "running" || task.status === "pending");
});

const orbAiState = computed(() => {
  if (!gateway.connected) return "default";
  if (gateway.isError)     return "error";
  if (gateway.isLoading || analysing.value) {
    if (
      analysing.value ||
      hasRunningToolCalls.value ||
      hasRunningSwarmTasks.value ||
      Boolean(gateway.pendingApproval) ||
      Boolean(gateway.pendingIntervention)
    ) {
      return "activity";
    }
    if (gateway.isStreaming) {
      return "output";
    }
    return "activity";
  }
  if (gateway.isStreaming)  return "output";
  return "default";
});

const displayMessages = computed(() => gateway.messages);
const sceneJobs = computed(() => scenesStore.recentJobs);
const configuredJobs = computed(() => jobsStore.jobs);
const activeSessions = computed(() => gateway.activeSessions);
const showJobsDropdown = computed(() => sceneJobs.value.length > 0 || Boolean(scenesStore.runError));
const jobsDropdownLabel = computed(() => {
  const running = scenesStore.runningJobs.length;
  if (running > 0) return `Jobs (${running})`;
  if (sceneJobs.value.length > 0) return `Jobs (${sceneJobs.value.length})`;
  return "Jobs";
});
const showOptionsDropdown = computed(() => (
  showFileInput.value
  || showAudioUpload.value
  || showRecording.value
  || showWakeMode.value
  || showSpeechPlayback.value
  || gateway.scenes.length > 0
  || configuredJobs.value.length > 0
));
const hasSidePanels = computed(() => Boolean(gateway.visibleSwarmState) || computerStore.loading || computerStore.sessions.length > 0 || gateway.isLoading);
const runningSceneJobs = computed(() => scenesStore.runningJobs.slice(0, 3));
const VISIBLE_TAIL = 6;
const visibleMessages = computed(() => {
  if (expandedMessageHistory.value || displayMessages.value.length <= VISIBLE_TAIL) {
    return displayMessages.value;
  }
  return displayMessages.value.slice(-VISIBLE_TAIL);
});
/** Index of the last assistant message inside visibleMessages (never auto-collapsed). */
const lastAssistantVisibleIdx = computed(() => {
  for (let i = visibleMessages.value.length - 1; i >= 0; i--) {
    if (visibleMessages.value[i].role === 'assistant') return i;
  }
  return -1;
});
const collapsedMessageCount = computed(() => Math.max(0, displayMessages.value.length - visibleMessages.value.length));
const latestAssistantText = computed(() => {
  for (let index = gateway.messages.length - 1; index >= 0; index -= 1) {
    const message = gateway.messages[index];
    if (message?.role === "assistant" && !message.blocked && message.content.trim()) {
      return message.content;
    }
  }
  return "";
});
const multimodalStatus = computed(() => multimodalStore.status);
const filesAvailable = computed(() => Boolean(multimodalStatus.value?.files.ok));
const sttAvailable = computed(() => Boolean(multimodalStatus.value?.stt.ok));
const ttsAvailable = computed(() => Boolean(multimodalStatus.value?.tts.ok));
const wakeConfigured = computed(() => Boolean(multimodalStore.config.wakeWord.enabled));
const browserRecordingAvailable = computed(() => typeof MediaRecorder !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia));
const browserSpeechRecognitionAvailable = computed(() => typeof window !== "undefined" && Boolean(window.SpeechRecognition ?? window.webkitSpeechRecognition));
const browserSpeechPlaybackAvailable = computed(() => typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined");
const showFileInput = computed(() => filesAvailable.value || typeof FileReader !== "undefined");
const showAudioUpload = computed(() => sttAvailable.value);
const showRecording = computed(() => sttAvailable.value && browserRecordingAvailable.value);
const showWakeMode = computed(() => sttAvailable.value && wakeConfigured.value && browserSpeechRecognitionAvailable.value);
const showSpeechPlayback = computed(() => ttsAvailable.value || browserSpeechPlaybackAvailable.value);
const showMultimodalStatus = computed(() =>
  showFileInput.value ||
  showAudioUpload.value ||
  showRecording.value ||
  showWakeMode.value ||
  showSpeechPlayback.value ||
  (sttAvailable.value && !browserRecordingAvailable.value) ||
  (sttAvailable.value && wakeConfigured.value && !browserSpeechRecognitionAvailable.value)
);
const voiceStatus = computed(() => {
  if (recordingState.value === "recording") return "Recording from microphone";
  if (recordingState.value === "processing") return "Transcribing audio";
  if (sttAvailable.value && !browserRecordingAvailable.value) return "Microphone recording is unavailable in this browser";
  if (sttAvailable.value && wakeConfigured.value && !browserSpeechRecognitionAvailable.value) return "Wake-word detection is unavailable in this browser";
  return wakeStatus.value;
});

function appendToComposer(text: string) {
  inputText.value = inputText.value.trim()
    ? `${inputText.value.trim()}\n\n${text.trim()}`
    : text.trim();
}

function isTextLikeFile(file: File): boolean {
  if (file.type.startsWith("text/")) return true;
  return /\.(txt|md|markdown|csv|json|log|yaml|yml|xml)$/i.test(file.name);
}

async function convertLocalTextFileToMarkdown(file: File): Promise<string> {
  const rawText = await file.text();
  const trimmed = rawText.trim();
  if (!trimmed) {
    throw new Error("Selected file is empty");
  }

  if (/\.(md|markdown)$/i.test(file.name)) {
    return trimmed;
  }
  if (/\.(json)$/i.test(file.name)) {
    return `\`\`\`json\n${trimmed}\n\`\`\``;
  }
  if (/\.(ya?ml)$/i.test(file.name)) {
    return `\`\`\`yaml\n${trimmed}\n\`\`\``;
  }
  if (/\.(xml)$/i.test(file.name)) {
    return `\`\`\`xml\n${trimmed}\n\`\`\``;
  }
  if (/\.(csv)$/i.test(file.name)) {
    return `\`\`\`csv\n${trimmed}\n\`\`\``;
  }
  return trimmed;
}

function revokeAudioPreview() {
  audioCurrentTime.value = 0;
  audioDuration.value = 0;
  audioPlaying.value = false;
  audioSummaryExpanded.value = false;
  if (!audioPreviewUrl.value) return;
  URL.revokeObjectURL(audioPreviewUrl.value);
  audioPreviewUrl.value = null;
}

function syncAudioPreviewState() {
  const player = audioPlayerEl.value;
  if (!player) return;
  audioCurrentTime.value = Number.isFinite(player.currentTime) ? player.currentTime : 0;
  audioDuration.value = Number.isFinite(player.duration) ? player.duration : 0;
  audioPlaying.value = !player.paused && !player.ended;
}

function handleAudioPreviewEnded() {
  syncAudioPreviewState();
  audioPlaying.value = false;
  audioCurrentTime.value = audioDuration.value;
}

async function toggleAudioPreviewPlayback() {
  const player = audioPlayerEl.value;
  if (!player) return;
  if (player.paused || player.ended) {
    if (player.ended) player.currentTime = 0;
    await player.play().catch(() => undefined);
  } else {
    player.pause();
  }
  syncAudioPreviewState();
}

async function restartAudioPreview() {
  const player = audioPlayerEl.value;
  if (!player) return;
  player.currentTime = 0;
  await player.play().catch(() => undefined);
  syncAudioPreviewState();
}

function seekAudioPreview(event: Event) {
  const player = audioPlayerEl.value;
  if (!player || audioDuration.value <= 0) return;
  const value = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(value)) return;
  player.currentTime = (value / 100) * audioDuration.value;
  syncAudioPreviewState();
}

function formatMediaTime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0:00";
  const totalSeconds = Math.max(0, Math.floor(value));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function createSpeechRecognition(): BrowserSpeechRecognition | null {
  const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  if (!Ctor) return null;
  const recognition = new Ctor();
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.lang = wakeLanguage.value;
  recognition.onresult = handleWakeResult;
  recognition.onerror = handleWakeError;
  recognition.onend = () => {
    if (wakeListening.value && recordingState.value === "idle") {
      scheduleWakeRestart(150);
    }
  };
  return recognition;
}

function scheduleWakeRestart(delayMs: number) {
  if (!wakeListening.value) return;
  if (wakeRestartTimer !== null) window.clearTimeout(wakeRestartTimer);
  wakeRestartTimer = window.setTimeout(() => {
    wakeRestartTimer = null;
    try {
      wakeRecognition?.start();
      wakeStatus.value = "Wake listening";
    } catch {
      scheduleWakeRestart(500);
    }
  }, delayMs);
}

function stopWakeRecognition() {
  if (wakeRestartTimer !== null) {
    window.clearTimeout(wakeRestartTimer);
    wakeRestartTimer = null;
  }
  wakeRecognition?.abort();
  wakeRecognition = null;
}

function handleWakeResult(event: SpeechRecognitionEventLike) {
  for (let index = event.resultIndex; index < event.results.length; index += 1) {
    const result = event.results[index];
    const transcript = result?.[0]?.transcript?.trim();
    if (!transcript) continue;
    const lowered = transcript.toLowerCase();

    if (wakeStopPhrases.value.some((phrase) => lowered.includes(phrase.toLowerCase()))) {
      void stopRecording(true);
      wakeStatus.value = "Stop phrase detected";
      return;
    }

    const matchedKeyword = wakeKeywords.value.find((phrase) => lowered.includes(phrase.toLowerCase()));
    if (matchedKeyword) {
      wakeStatus.value = `Wake phrase detected: ${matchedKeyword}`;
      void startRecording(true);
      return;
    }
  }
}

function handleWakeError(event: SpeechRecognitionErrorEventLike) {
  const error = event.error ?? "unknown";
  wakeStatus.value = `Wake recognition error: ${error}`;
  if (wakeListening.value && !["not-allowed", "service-not-allowed"].includes(error)) {
    scheduleWakeRestart(1000);
  }
}

async function toggleWakeListening() {
  if (wakeListening.value) {
    wakeListening.value = false;
    stopWakeRecognition();
    wakeStatus.value = "Wake mode off";
    return;
  }

  const recognition = createSpeechRecognition();
  if (!recognition) {
    wakeStatus.value = "SpeechRecognition unavailable in this browser";
    return;
  }

  wakeRecognition = recognition;
  wakeListening.value = true;
  wakeStatus.value = "Wake listening";
  recognition.start();
}

function cleanupRecordingResources() {
  if (audioIntervalId !== null) {
    window.clearInterval(audioIntervalId);
    audioIntervalId = null;
  }
  analyser?.disconnect();
  analyser = null;
  audioContext?.close().catch(() => undefined);
  audioContext = null;
  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = null;
}

async function startRecording(fromWakeWord = false) {
  if (recordingState.value !== "idle") return;
  if (!navigator.mediaDevices?.getUserMedia) {
    wakeStatus.value = "Microphone capture unavailable";
    return;
  }

  if (fromWakeWord) stopWakeRecognition();

  revokeAudioPreview();
  multimodalBusy.value = true;
  recordingState.value = "recording";
  wakeStatus.value = fromWakeWord ? "Wake-triggered recording" : "Recording from microphone";
  recordedChunks.length = 0;
  observedSpeech = false;
  lastAudioActivityAt = Date.now();

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(mediaStream);
    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) recordedChunks.push(event.data);
    };
    mediaRecorder.onstop = () => {
      void finalizeRecording();
    };

    audioContext = new AudioContext();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    const source = audioContext.createMediaStreamSource(mediaStream);
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);

    audioIntervalId = window.setInterval(() => {
      if (!analyser || recordingState.value !== "recording") return;
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((sum, value) => sum + value, 0) / data.length;
      if (avg > 18) {
        observedSpeech = true;
        lastAudioActivityAt = Date.now();
      }
      if (observedSpeech && Date.now() - lastAudioActivityAt > wakeSilenceTimeoutMs.value) {
        void stopRecording(true);
      }
    }, 150);

    mediaRecorder.start(250);
  } catch (error) {
    cleanupRecordingResources();
    recordingState.value = "idle";
    multimodalBusy.value = false;
    wakeStatus.value = error instanceof Error ? error.message : String(error);
    if (wakeListening.value) {
      wakeRecognition = createSpeechRecognition();
      scheduleWakeRestart(500);
    }
  }
}

async function stopRecording(restartWake = false) {
  if (recordingState.value !== "recording") return;
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  if (!restartWake) wakeListening.value = false;
}

async function finalizeRecording() {
  cleanupRecordingResources();
  recordingState.value = "processing";
  wakeStatus.value = "Transcribing recorded audio";

  try {
    const audioBlob = new Blob(recordedChunks, { type: mediaRecorder?.mimeType || "audio/webm" });
    const result = await gateway.transcribeAudio(audioBlob, { language: wakeLanguage.value });
    if (result.text.trim()) {
      appendToComposer(result.text);
      wakeStatus.value = `Transcript ready${result.language ? ` (${result.language})` : ""}`;
    } else {
      wakeStatus.value = "No transcription returned";
    }
  } catch (error) {
    wakeStatus.value = error instanceof Error ? error.message : String(error);
  } finally {
    mediaRecorder = null;
    recordingState.value = "idle";
    multimodalBusy.value = false;
    if (wakeListening.value) {
      wakeRecognition = createSpeechRecognition();
      scheduleWakeRestart(300);
    }
  }
}

async function toggleRecording() {
  if (recordingState.value === "recording") {
    await stopRecording(false);
    return;
  }
  await startRecording(false);
}

async function onDocumentSelected(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  multimodalBusy.value = true;

  const isImage = file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(file.name);

  try {
    // ── Image: queue the file — analysis happens at send time ────────────────
    if (isImage) {
      pendingImageContexts.value.push({ filename: file.name, file, previewUrl: URL.createObjectURL(file) });
      wakeStatus.value = `Image attached — click Send`;
      return;
    }

    // ── Document: convert to markdown and inline the text ──
    wakeStatus.value = `Converting ${file.name}`;
    let markdown = "";
    let sourceName = file.name;
    if (filesAvailable.value) {
      const result = await gateway.convertFileToMarkdown(file);
      markdown = result.markdown?.trim() ?? "";
      sourceName = result.filename ?? file.name;
      if (!markdown) throw new Error(result.error ?? "File conversion returned no markdown");
    } else {
      if (!isTextLikeFile(file)) {
        throw new Error("File conversion service is offline. Only text, markdown, CSV, JSON, YAML, and XML files can be attached locally right now.");
      }
      markdown = await convertLocalTextFileToMarkdown(file);
    }
    appendToComposer(`Context from ${sourceName}:\n\n${markdown}`);
    wakeStatus.value = `Attached ${file.name}`;
  } catch (error) {
    wakeStatus.value = error instanceof Error ? error.message : String(error);
  } finally {
    multimodalBusy.value = false;
  }
}

async function onAudioSelected(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  multimodalBusy.value = true;
  wakeStatus.value = `Transcribing ${file.name}`;
  try {
    const result = await gateway.transcribeAudio(file, { language: wakeLanguage.value });
    if (!result.text.trim()) throw new Error("Audio transcription returned no text");
    appendToComposer(result.text);
    wakeStatus.value = `Audio added from ${file.name}`;
  } catch (error) {
    wakeStatus.value = error instanceof Error ? error.message : String(error);
  } finally {
    multimodalBusy.value = false;
  }
}

async function speakLatestAssistant(forceFullText = false) {
  const text = latestAssistantText.value.trim();
  if (!text) return;
  multimodalBusy.value = true;
  lastSpokenSummary.value = null;
  wakeStatus.value = "Summarising reply";
  try {
    // Summarise first unless caller explicitly wants the full text
    let spoken = text;
    if (!forceFullText && ttsAvailable.value) {
      try {
        const maxSentences = multimodalStore.config.tts.speakReplySummaryMaxSentences ?? 3;
        spoken = await gateway.summarizeForSpeech({ text, maxSentences });
        lastSpokenSummary.value = spoken;
        audioSummaryExpanded.value = false;
      } catch {
        // Summarisation failed — fall back to speaking the full text
        spoken = text;
      }
    }

    wakeStatus.value = "Generating speech";
    if (ttsAvailable.value) {
      const audioBlob = await gateway.synthesizeSpeech({ text: spoken });
      revokeAudioPreview();
      audioPreviewUrl.value = URL.createObjectURL(audioBlob);
      await nextTick();
      await audioPlayerEl.value?.play().catch(() => undefined);
      wakeStatus.value = "Reply spoken";
    } else if (browserSpeechPlaybackAvailable.value) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(spoken);
      utterance.lang = multimodalStore.config.tts.defaultLanguage.replace("_", "-");
      await new Promise<void>((resolve, reject) => {
        utterance.onend = () => resolve();
        utterance.onerror = () => reject(new Error("Browser speech playback failed"));
        window.speechSynthesis.speak(utterance);
      });
      lastSpokenSummary.value = spoken;
      audioSummaryExpanded.value = false;
      wakeStatus.value = "Reply spoken in browser";
    } else {
      throw new Error("Speech playback is unavailable in this browser");
    }
  } catch (error) {
    wakeStatus.value = error instanceof Error ? error.message : String(error);
  } finally {
    multimodalBusy.value = false;
  }
}

function toggleSpeakReply() {
  speakReplyEnabled.value = !speakReplyEnabled.value;
  writeSpeakReplySummaryStorage(speakReplyEnabled.value);
}

async function sendMessage() {
  const trimmedText = inputText.value.trim();
  if ((!trimmedText && pendingImageContexts.value.length === 0) || gateway.isLoading) return;

  const jobMatch = pendingImageContexts.value.length === 0
    ? trimmedText.match(/^\/job\s+(\S+)(?:\s+(.*))?$/s)
    : null;
  if (jobMatch && jobMatch[1]?.toLowerCase() !== "help") {
    inputText.value = "";
    const params = parseInlineParams(jobMatch[2] ?? "");
    await scenesStore.runJob(jobMatch[1]!, Object.keys(params).length > 0 ? params : undefined);
    return;
  }

  const pending = pendingImageContexts.value;
  pendingImageContexts.value = [];
  inputText.value = "";

  // What the user sees in their own bubble — filenames only, no analysis dump
  const displayParts: string[] = [];
  if (pending.length > 0) displayParts.push(`📎 ${pending.map(p => p.filename).join(", ")}`);
  if (trimmedText) displayParts.push(trimmedText);
  const displayContent = displayParts.join("\n");

  if (pending.length > 0) {
    analysing.value = true;
    wakeStatus.value = `Analysing image${pending.length > 1 ? "s" : ""}…`;
    try {
      const [analyses, dataUrls] = await Promise.all([
        Promise.all(pending.map(p => gateway.analyzeImageFile(p.file))),
        Promise.all(pending.map(p => fileToDataUrl(p.file))),
      ]);
      const imageContext = pending.map((p, i) => `Image analysis (${p.filename}):\n\n${analyses[i]}`).join("\n\n");
      const attachments = pending.map((p, i) => ({ filename: p.filename, dataUrl: dataUrls[i] }));
      const fullText = [imageContext, trimmedText].filter(Boolean).join("\n\n");
      wakeStatus.value = "";
      await gateway.sendMessage(fullText, thinkingMode.value, displayContent, attachments);
    } finally {
      analysing.value = false;
      for (const p of pending) URL.revokeObjectURL(p.previewUrl);
    }
  } else {
    await gateway.sendMessage(trimmedText, thinkingMode.value);
  }
}

async function triggerScene(name: string) {
  if (gateway.isLoading) return;
  await scenesStore.run(name);
}

async function triggerJob(name: string) {
  if (gateway.isLoading) return;
  await scenesStore.runJob(name);
}

async function approveAction(approved: boolean) {
  if (!gateway.pendingApproval) return;
  await gateway.respondApproval(gateway.pendingApproval.approvalId, approved);
}

async function handleInterventionAction(action: InterventionAction) {
  if (action.kind === "stop_turn") {
    await gateway.cancelTurn();
    gateway.dismissIntervention();
    return;
  }
  if (action.kind === "new_session") {
    await gateway.createSession();
    gateway.dismissIntervention();
    return;
  }
  if (action.kind === "request_approval") {
    inputText.value = action.prompt ?? "Stop the current external process and ask for approval before any destructive action.";
    gateway.dismissIntervention();
  }
}

async function resetSession() {
  if (!gateway.currentSessionId) {
    await gateway.createSession();
    return;
  }
  try {
    await gateway.rpc("session.reset", { sessionId: gateway.currentSessionId });
    await gateway.loadSession(gateway.currentSessionId);
  } catch {
    // If reset fails, create a fresh session instead
    await gateway.createSession();
  }
}

async function archiveCurrentSession() {
  if (!gateway.currentSessionId) return;
  await gateway.archiveSession(gateway.currentSessionId);
}

async function handleSessionSwitch(event: Event) {
  const sessionId = (event.target as HTMLSelectElement).value;
  if (!sessionId) return;
  await gateway.switchSession(sessionId);
}

function openInSessions() {
  if (!gateway.currentSessionId) return;
  const latestRunId = gateway.currentSessionSwarmRuns[gateway.currentSessionSwarmRuns.length - 1]?.id ?? null;
  const runId = gateway.selectedSwarmRunId ?? latestRunId;
  router.push({
    path: "/sessions",
    query: {
      sessionId: gateway.currentSessionId,
      ...(runId ? { runId } : {}),
    },
  });
}

function openJobs() {
  router.push({ path: "/jobs" });
}

function isSceneRunning(name: string): boolean {
  return scenesStore.runningJobs.some((job) => job.sceneName === name);
}

function isJobRunning(name: string): boolean {
  return scenesStore.runningJobs.some((job) => job.definitionType === "job" && job.sceneName === name);
}

function parseInlineParams(raw: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const match of raw.matchAll(/(\w+)=("(?:[^"\\]|\\.)*"|\S+)/g)) {
    params[match[1]!] = (match[2] ?? "").replace(/^"|"$/g, "").replace(/\\"/g, '"');
  }
  return params;
}

function formatSceneName(name: string | undefined): string {
  return (name ?? "").replace(/_/g, " ");
}

function shortJobId(jobId: string): string {
  return `${jobId.slice(0, 8)}…`;
}

function isSceneJobCancelable(status: "queued" | "running" | "cancelling" | "cancelled" | "completed" | "failed"): boolean {
  return status === "queued" || status === "running" || status === "cancelling";
}

function sceneStatusClass(status: "queued" | "running" | "cancelling" | "cancelled" | "completed" | "failed"): string {
  if (status === "completed") return "rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] uppercase tracking-wide text-emerald-300";
  if (status === "failed") return "rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] uppercase tracking-wide text-red-300";
  if (status === "cancelled") return "rounded-full bg-gray-500/15 px-2 py-0.5 text-[11px] uppercase tracking-wide text-gray-300";
  if (status === "cancelling") return "rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] uppercase tracking-wide text-amber-300";
  if (status === "queued") return "rounded-full bg-indigo-500/15 px-2 py-0.5 text-[11px] uppercase tracking-wide text-indigo-300";
  return "rounded-full bg-sky-500/15 px-2 py-0.5 text-[11px] uppercase tracking-wide text-sky-300";
}

function sceneCardClass(status: "queued" | "running" | "cancelling" | "cancelled" | "completed" | "failed"): string {
  if (status === "completed") return "border-emerald-500/20 bg-emerald-950/15";
  if (status === "failed") return "border-red-500/20 bg-red-950/15";
  if (status === "cancelled") return "border-gray-500/20 bg-gray-950/20";
  if (status === "cancelling") return "border-amber-500/20 bg-amber-950/15";
  if (status === "queued") return "border-indigo-500/20 bg-indigo-950/15";
  return "border-sky-500/20 bg-sky-950/15";
}

function sceneLifecycleLabel(job: { createdAt?: string; startedAt?: string }): string {
  if (job.startedAt) return `Started ${formatSceneTimestamp(job.startedAt)}`;
  if (job.createdAt) return `Queued ${formatSceneTimestamp(job.createdAt)}`;
  return "Waiting for worker";
}

function formatSceneTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "unknown";
  return parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDuration(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 ms";
  if (value < 1_000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(1)} s`;
  return `${(value / 60_000).toFixed(1)} min`;
}

function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat([], { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

// ── Export helpers ────────────────────────────────────────────────────────────

function exportRoleLabel(role: GatewaySessionTranscriptMessage["role"]): string {
  if (role === "user") return "**You**";
  if (role === "system") return "**System**";
  return "**StarlingAI**";
}

function sanitizeExportMessageContent(message: GatewaySessionTranscriptMessage): string {
  if (message.role === "assistant") {
    return sanitizeAssistantMessageContent(message.content, message.toolCalls) || message.content;
  }

  if (!/\[Tool:|<tool_call>|<function=|<parameter=/i.test(message.content)) {
    return message.content;
  }

  const paragraphs = message.content
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const kept: string[] = [];

  for (const paragraph of paragraphs) {
    if (/^\s*(let me|now let me|first let me|i(?:'ll| will)|i(?:'m| am) going to)\b/i.test(paragraph)) {
      break;
    }
    if (paragraph.split(/\r?\n/).some((line) => line.trim().startsWith("[Tool:"))) {
      break;
    }
    kept.push(paragraph);
  }

  return kept.length > 0 ? kept.join("\n\n") : message.content;
}

function sanitizeExportMessage(message: GatewaySessionTranscriptMessage): GatewaySessionTranscriptMessage {
  return {
    ...message,
    content: sanitizeExportMessageContent(message),
  };
}

async function getExportTranscriptMessages(): Promise<GatewaySessionTranscriptMessage[]> {
  if (gateway.currentSessionId) {
    const result = await gateway.getSessionTranscript(gateway.currentSessionId);
    return result.transcript.map(sanitizeExportMessage);
  }

  return gateway.messages
    .filter((message) => message.id !== "streaming")
    .map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      timestamp: message.timestamp.toISOString(),
      toolCalls: message.toolCalls,
    }))
    .map(sanitizeExportMessage);
}

function buildMarkdownExport(messages: GatewaySessionTranscriptMessage[]): string {
  const sessionId = gateway.currentSessionId ?? "unknown";
  const date = new Date().toLocaleString();
  const lines: string[] = [
    `# StarlingAI Conversation`,
    ``,
    `**Session:** \`${sessionId}\`  `,
    `**Exported:** ${date}`,
    ``,
    `---`,
    ``,
  ];
  for (const msg of messages) {
    const role = exportRoleLabel(msg.role);
    const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    lines.push(`### ${role} — ${time}`);
    lines.push(``);
    if (msg.content) lines.push(msg.content);
    lines.push(``);
    lines.push(`---`);
    lines.push(``);
  }
  return lines.join("\n");
}

async function exportMarkdown(): Promise<void> {
  exportingTranscript.value = true;
  try {
    const transcript = await getExportTranscriptMessages();
    const content = buildMarkdownExport(transcript);
    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `starlingai-${(gateway.currentSessionId ?? "session").slice(0, 8)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  } finally {
    exportingTranscript.value = false;
  }
}

async function exportPDF(): Promise<void> {
  exportingTranscript.value = true;
  try {
    const transcript = await getExportTranscriptMessages();
    const sessionId = gateway.currentSessionId ?? "unknown";
    const date = new Date().toLocaleString();

    const messageHtml = transcript.map((msg) => {
      const role = msg.role === "user" ? "You" : msg.role === "system" ? "System" : "StarlingAI";
      const roleClass = msg.role === "user" ? "role-user" : msg.role === "system" ? "role-system" : "role-ai";
      const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const bodyHtml = msg.content
        ? marked.parse(msg.content, { async: false }) as string
        : "<em>(no content)</em>";
      return `
        <div class="message ${roleClass}">
          <div class="message-header"><span class="role">${role}</span><span class="time">${time}</span></div>
          <div class="message-body">${bodyHtml}</div>
        </div>`;
    }).join("\n");

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>StarlingAI Conversation</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 13px; color: #1a1a2e; max-width: 860px; margin: 0 auto; padding: 2rem; }
    h1 { font-size: 1.4rem; color: #4c1d95; margin-bottom: 0.25rem; }
    .meta { font-size: 0.78rem; color: #6b7280; margin-bottom: 1.5rem; }
    .message { margin-bottom: 1.25rem; border-radius: 8px; padding: 0.75rem 1rem; page-break-inside: avoid; }
    .role-user { background: #f5f3ff; border: 1px solid #ddd6fe; }
    .role-ai { background: #fafafa; border: 1px solid #e5e7eb; }
    .role-system { background: #eff6ff; border: 1px solid #bfdbfe; }
    .message-header { display: flex; justify-content: space-between; margin-bottom: 0.5rem; }
    .role { font-weight: 700; font-size: 0.8rem; color: #6d28d9; }
    .role-user .role { color: #7c3aed; }
    .role-system .role { color: #1d4ed8; }
    .time { font-size: 0.72rem; color: #9ca3af; }
    .message-body p { margin: 0 0 0.4rem; }
    .message-body p:last-child { margin-bottom: 0; }
    .message-body code { background: #f3f4f6; padding: 0.1em 0.3em; border-radius: 3px; font-size: 0.85em; }
    .message-body pre { background: #1e1e2e; color: #e2e8f0; padding: 0.75rem; border-radius: 6px; overflow-x: auto; font-size: 0.82em; }
    .message-body pre code { background: none; color: inherit; padding: 0; }
    .message-body ul, .message-body ol { padding-left: 1.25rem; margin: 0.25rem 0; }
    .message-body h1, .message-body h2, .message-body h3 { margin: 0.5rem 0 0.25rem; }
    .message-body table { border-collapse: collapse; width: 100%; }
    .message-body th, .message-body td { border: 1px solid #d1d5db; padding: 0.3rem 0.5rem; }
    .message-body th { background: #f3f4f6; font-weight: 600; }
    @media print { body { padding: 0; } }
  </style>
</head>
<body>
  <h1>StarlingAI Conversation</h1>
  <div class="meta">Session: ${sessionId} &nbsp;·&nbsp; Exported: ${date}</div>
  ${messageHtml}
</body>
</html>`;

    const win = window.open("", "_blank");
    if (!win) return;
    win.document.write(html);
    win.document.close();
    win.focus();
    setTimeout(() => { win.print(); }, 300);
  } finally {
    exportingTranscript.value = false;
  }
}

async function loadOlderMessages(): Promise<void> {
  await gateway.loadOlderCurrentSessionTranscript();
}

function scrollToBottom() {
  nextTick(() => { if (messagesEl.value) messagesEl.value.scrollTop = messagesEl.value.scrollHeight; });
}

watch(() => gateway.messages.length, scrollToBottom);
watch(() => gateway.streamingText, scrollToBottom);
watch(compactComposer, () => {
  nextTick(() => { adjustComposerHeight(); });
}, { immediate: true });
watch(inputText, () => {
  nextTick(() => { adjustComposerHeight(); });
}, { flush: "post" });

// Auto-speak: fires when a turn finishes (isLoading flips false → true → false)
// and the speak-reply toggle is on and the user is in voice-input mode.
let _wasLoading = false;
watch(() => gateway.isLoading, (loading) => {
  if (_wasLoading && !loading && speakReplyEnabled.value && showSpeechPlayback.value) {
    speakLatestAssistant();
  }
  _wasLoading = loading;
});
watch(() => gateway.connected, async (connected) => {
  if (!connected) return;
  if (!gateway.currentSessionId) await gateway.createSession();
  await multimodalStore.fetch();
  await gateway.loadScenes();
  await jobsStore.fetch();
  await scenesStore.fetch();
}, { immediate: true });

// onMounted intentionally omitted — the watch above handles the initial case,
// including when connected is already true at mount time.

onMounted(() => {
  adjustComposerHeight();
});

onUnmounted(() => {
  stopWakeRecognition();
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  cleanupRecordingResources();
  revokeAudioPreview();
});
</script>

<style scoped>
.approval-enter-active,
.approval-leave-active {
  transition: all 0.25s ease;
}
.approval-enter-from,
.approval-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

.multimodal-action {
  display: inline-flex;
  align-items: center;
  color: rgb(191 219 254);
}

.multimodal-icon-button {
  justify-content: center;
  min-width: 2.75rem;
  min-height: 2.75rem;
  padding-left: 0.75rem;
  padding-right: 0.75rem;
}

.multimodal-action-active {
  color: rgb(207 250 254);
  border-color: rgba(var(--logo-cyan), 0.48);
  background: linear-gradient(180deg, rgba(14, 34, 65, 0.95), rgba(10, 24, 50, 0.78));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05), 0 0 0 1px rgba(var(--logo-cyan), 0.12), 0 16px 32px rgba(var(--logo-blue), 0.22);
}

.multimodal-icon {
  width: 1rem;
  height: 1rem;
  flex: none;
  opacity: 0.96;
}

.multimodal-status {
  border: 1px solid rgba(var(--logo-cyan), 0.18);
  background: linear-gradient(180deg, rgba(8, 16, 31, 0.78), rgba(8, 16, 31, 0.58));
  color: rgb(148 163 184);
}

.multimodal-status-live {
  border-color: rgba(var(--logo-cyan), 0.34);
  color: rgb(165 243 252);
  box-shadow: 0 0 20px rgba(var(--logo-cyan), 0.12);
}

.reply-audio-panel {
  display: grid;
  gap: 0.5rem;
  margin-bottom: 0.65rem;
  padding: 0.6rem 0.75rem;
  border-radius: 1rem;
  border: 1px solid rgba(125, 211, 252, 0.12);
  background: linear-gradient(180deg, rgba(8, 18, 32, 0.86), rgba(7, 14, 26, 0.68));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
}

.reply-audio-panel__header {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 0.45rem;
}

.reply-audio-panel__headline {
  display: flex;
  align-items: baseline;
  gap: 0.45rem;
  min-width: 0;
  flex-wrap: wrap;
}

.reply-audio-panel__eyebrow {
  font-size: 0.64rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: rgb(125 211 252);
}

.reply-audio-panel__meta {
  margin-top: 0;
  font-size: 0.72rem;
  color: rgb(148 163 184);
}

.reply-audio-panel__transport {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 0.55rem;
}

.reply-audio-panel__play,
.reply-audio-panel__restart,
.reply-audio-panel__summary-toggle {
  border-radius: 9999px;
  border: 1px solid rgba(125, 211, 252, 0.18);
  background: rgba(11, 26, 44, 0.7);
  color: rgb(224 242 254);
  font-size: 0.7rem;
  padding: 0.38rem 0.68rem;
  line-height: 1;
  transition: border-color 0.15s ease, background 0.15s ease, color 0.15s ease;
}

.reply-audio-panel__play:hover:not(:disabled),
.reply-audio-panel__restart:hover:not(:disabled),
.reply-audio-panel__summary-toggle:hover:not(:disabled) {
  border-color: rgba(125, 211, 252, 0.38);
  background: rgba(16, 38, 63, 0.8);
  color: white;
}

.reply-audio-panel__play:disabled,
.reply-audio-panel__restart:disabled,
.reply-audio-panel__summary-toggle:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.reply-audio-panel__actions {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}

.reply-audio-panel__range {
  width: 100%;
  appearance: none;
  min-width: 0;
  height: 0.22rem;
  border-radius: 9999px;
  background: linear-gradient(90deg, rgba(56, 189, 248, 0.85), rgba(34, 211, 238, 0.55));
  outline: none;
}

.reply-audio-panel__range::-webkit-slider-thumb {
  appearance: none;
  width: 0.72rem;
  height: 0.72rem;
  border-radius: 9999px;
  border: 2px solid rgba(7, 14, 26, 0.95);
  background: rgb(224 242 254);
  box-shadow: 0 0 0 2px rgba(125, 211, 252, 0.18);
}

.reply-audio-panel__range::-moz-range-thumb {
  width: 0.72rem;
  height: 0.72rem;
  border-radius: 9999px;
  border: 2px solid rgba(7, 14, 26, 0.95);
  background: rgb(224 242 254);
  box-shadow: 0 0 0 2px rgba(125, 211, 252, 0.18);
}

.reply-audio-panel__time {
  min-width: 4.2rem;
  text-align: right;
  font-size: 0.7rem;
  color: rgb(148 163 184);
  font-variant-numeric: tabular-nums;
}

.reply-audio-panel__summary {
  display: grid;
  gap: 0.12rem;
  margin: 0;
  padding-top: 0.2rem;
  font-size: 0.7rem;
  line-height: 1.4;
  color: rgb(148 163 184);
}

.reply-audio-panel__summary-label {
  font-size: 0.62rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: rgb(100 116 139);
}

@media (max-width: 640px) {
  .reply-audio-panel__transport {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .reply-audio-panel__time {
    grid-column: 1 / 2;
    text-align: left;
  }

  .reply-audio-panel__actions {
    grid-column: 2 / 3;
    justify-self: end;
  }
}

.chat-workspace {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 1rem;
}

.chat-main-column,
.chat-side-column {
  min-height: 0;
}

.chat-message-scroll {
  height: 100%;
  overflow-y: auto;
  padding: 0.15rem 0.1rem 0.35rem 0;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.chat-side-stack {
  height: 100%;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding-right: 0.25rem;
}

.chat-sidebar-placeholder {
  border-radius: 1.5rem;
  border: 1px dashed rgba(125, 211, 252, 0.18);
  background: linear-gradient(180deg, rgba(5, 15, 32, 0.72), rgba(7, 13, 24, 0.58));
  padding: 1.25rem;
  color: rgb(148 163 184);
}

.chat-sidebar-placeholder__eyebrow {
  font-size: 0.68rem;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: rgb(125 211 252);
  margin-bottom: 0.5rem;
}

.chat-sidebar-placeholder__copy {
  font-size: 0.9rem;
  line-height: 1.6;
  margin: 0;
}

.chat-mobile-panels {
  border-radius: 1.1rem;
  border: 1px solid rgba(125, 211, 252, 0.16);
  background: rgba(6, 12, 24, 0.76);
  overflow: hidden;
}

.chat-mobile-panels__summary {
  list-style: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.8rem 1rem;
  cursor: pointer;
  color: rgb(226 232 240);
  font-size: 0.82rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.chat-mobile-panels__summary::-webkit-details-marker,
.chat-dropdown__summary::-webkit-details-marker {
  display: none;
}

.chat-mobile-panels__meta {
  display: flex;
  gap: 0.4rem;
  color: rgb(125 211 252);
  font-size: 0.68rem;
}

.chat-mobile-panels__body {
  display: grid;
  gap: 0.85rem;
  padding: 0 0.85rem 0.85rem;
}

.chat-history-collapsed {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.65rem;
  padding: 0.75rem 0.9rem;
  border-radius: 1rem;
  border: 1px solid rgba(125, 211, 252, 0.12);
  background: linear-gradient(180deg, rgba(7, 20, 38, 0.72), rgba(6, 14, 28, 0.52));
}

.chat-history-collapsed__button {
  border-radius: 9999px;
  border: 1px solid rgba(125, 211, 252, 0.28);
  background: rgba(14, 32, 54, 0.72);
  color: rgb(186 230 253);
  padding: 0.42rem 0.9rem;
  font-size: 0.78rem;
  transition: border-color 0.15s ease, color 0.15s ease, background 0.15s ease;
}

.chat-history-collapsed__button:hover {
  border-color: rgba(125, 211, 252, 0.48);
  color: white;
}

.chat-composer {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}

.chat-composer__field {
  min-width: 0;
  width: 100%;
  flex: 1 1 auto;
}

.chat-composer__textarea {
  width: 100%;
  resize: none;
  border-radius: 1.5rem;
  border: 1px solid rgba(168, 85, 247, 0.2);
  background: rgba(31, 41, 55, 0.58);
  padding: 0.78rem 1rem;
  color: rgb(243 244 246);
  font-size: 0.92rem;
  line-height: 1.42;
  transition: border-color 0.2s ease, background 0.2s ease, padding 0.2s ease, min-height 0.2s ease;
}

.chat-composer__textarea:hover {
  border-color: rgba(168, 85, 247, 0.38);
}

.chat-composer__textarea:focus {
  outline: none;
  border-color: rgba(168, 85, 247, 0.62);
  background: rgba(31, 41, 55, 0.76);
}

.chat-composer__textarea:disabled {
  opacity: 0.55;
}

.chat-composer__textarea--compact {
  padding-top: 0.68rem;
  padding-bottom: 0.68rem;
}

.chat-job-strip {
  display: grid;
  gap: 0.55rem;
  margin-bottom: 0.8rem;
}

.chat-job-strip__item {
  border-radius: 1rem;
  border: 1px solid rgba(56, 189, 248, 0.18);
  background: rgba(8, 23, 38, 0.58);
  padding: 0.7rem 0.85rem;
}

.chat-job-strip__title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.chat-job-strip__title {
  color: #dff7ff;
  font-size: 0.8rem;
  font-weight: 600;
}

.chat-job-strip__percent {
  color: #7dd3fc;
  font-size: 0.72rem;
  font-variant-numeric: tabular-nums;
}

.chat-job-strip__meta {
  margin-top: 0.22rem;
  color: #9fc6d9;
  font-size: 0.72rem;
  line-height: 1.35;
}

.chat-composer__controls {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
  align-items: flex-start;
}

.chat-composer__menus,
.chat-composer__primary-actions {
  display: flex;
  align-items: stretch;
  justify-content: flex-start;
  gap: 0.55rem;
  flex-wrap: wrap;
}

.chat-dropdown {
  position: relative;
}

.chat-dropdown__summary {
  list-style: none;
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.55rem;
  min-width: 6.5rem;
  border-radius: 1rem;
  border: 1px solid rgba(125, 211, 252, 0.2);
  background: linear-gradient(180deg, rgba(9, 18, 34, 0.85), rgba(8, 15, 28, 0.68));
  color: rgb(224 242 254);
  padding: 0.7rem 0.9rem;
  font-size: 0.8rem;
  cursor: pointer;
  user-select: none;
}

.chat-dropdown[open] .chat-dropdown__summary {
  border-color: rgba(125, 211, 252, 0.42);
  color: white;
}

.chat-dropdown__chevron {
  font-size: 0.72rem;
  color: rgb(125 211 252);
}

.chat-dropdown__menu {
  position: absolute;
  right: 0;
  bottom: calc(100% + 0.65rem);
  width: min(24rem, calc(100vw - 2.5rem));
  max-height: min(70vh, 32rem);
  overflow-y: auto;
  z-index: 30;
  border-radius: 1.3rem;
  border: 1px solid rgba(168, 85, 247, 0.18);
  background: linear-gradient(180deg, rgba(6, 10, 20, 0.96), rgba(10, 14, 28, 0.92));
  box-shadow: 0 24px 50px rgba(0, 0, 0, 0.38);
  padding: 0.9rem;
  display: grid;
  gap: 0.9rem;
}

.chat-dropdown__menu--jobs {
  width: min(30rem, calc(100vw - 2.5rem));
}

.chat-dropdown__group {
  display: grid;
  gap: 0.7rem;
}

.chat-dropdown__label {
  font-size: 0.68rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: rgb(125 211 252);
}

.chat-dropdown__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
}

.chat-dropdown__scene-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 0.55rem;
}

.chat-scene-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.45rem 0.8rem;
  font-size: 0.74rem;
  font-weight: 500;
  border-radius: 9999px;
  border: 1px solid rgba(168, 85, 247, 0.34);
  background: rgba(88, 28, 135, 0.22);
  color: rgb(216 180 254);
  transition: border-color 0.15s ease, color 0.15s ease, background 0.15s ease;
}

.chat-scene-pill:hover:enabled {
  border-color: rgba(168, 85, 247, 0.6);
  color: rgb(243 232 255);
  background: rgba(126, 34, 206, 0.28);
}

.chat-scene-pill:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

@media (min-width: 1024px) {
  .chat-workspace {
    grid-template-columns: minmax(0, 1fr) minmax(21rem, 28rem);
  }

  .chat-composer {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    column-gap: 0.9rem;
    align-items: flex-end;
  }

  .chat-composer__controls {
    width: max-content;
    max-width: 100%;
    min-width: 0;
    justify-self: start;
  }

  .chat-composer__menus,
  .chat-composer__primary-actions {
    flex-wrap: nowrap;
  }
}
</style>
