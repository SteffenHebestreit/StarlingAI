<template>
  <div
    class="relative flex flex-col chat-viewport"
    @dragover="onChatDragOver"
    @dragleave="onChatDragLeave"
    @drop="onChatDrop"
  >

    <!-- Orb background canvas: fixed to the viewport so layout changes
         (input bay, panels) can never move or resize the entity. -->
    <div
      class="chat-orb-layer fixed inset-0 pointer-events-none flex items-center justify-center overflow-hidden"
      :class="orbBehindText ? 'chat-orb-layer--behind-text' : ''"
    >
      <OrbCanvas :ai-state="orbAiState" :ring="orbRing" :controls="orbControls" :suggestions="orbSuggestions" class="w-full h-full" />
    </div>

    <!-- The running turn at the orb: its steps orbit it, its newest words stand under it. The
         chat keeps the question and the answer. -->
    <OrbActivity
      :activity="orbActivity"
      :language="orbLanguage"
      :lane="podLane"
      :floor="orbStatusFloor"
      :ceiling="orbStatusCeiling"
      @open="openLiveSteps"
    />

    <!-- Drag-drop overlay: visible while a file drag is hovering the chat surface -->
    <div
      v-if="dropActive"
      class="chat-drop-overlay"
      aria-hidden="true"
    >
      <div class="chat-drop-overlay__panel">
        <div class="chat-drop-overlay__icon" aria-hidden="true">📎</div>
        <div class="chat-drop-overlay__title">{{ chatText.dropTitle(uiLanguage) }}</div>
        <div class="chat-drop-overlay__hint">{{ chatText.dropHint(uiLanguage) }}</div>
      </div>
    </div>

    <!-- The page's three round controls: the session, its actions, the message input
         (components/OrbNode.vue). On a wide window they stand on an orbit round the orb
         (composables/orbControls.ts) and their menus open away from it; on a narrow one, where
         the messages lie over the orb, they are parked at the page's edge and can be dragged.
         Teleported to <body> so no overlay or stacking context can swallow their clicks. They are
         chat controls and only exist while connected, so they never float above the login modal. -->
    <Teleport to="body">
    <div v-if="(actionsOpen || sessionOpen) && gateway.connected" class="fixed inset-0 z-[210]" @click="actionsOpen = false; sessionOpen = false" />

    <!-- Session: whether there is one, the picker behind it, and a new one. Starting a session
         stood at the head of the actions' list, among what can be done WITH a session. -->
    <div v-if="gateway.connected" class="orb-control" :class="controlClass" :style="sessionControlStyle">
      <OrbNode
        side="left"
        :docked="controlsDocked"
        :open="sessionOpen"
        :idle="!gateway.currentSessionId"
        :label="controlLabelled.session ? chatText.nodeSession(uiLanguage) : ''"
        :aria-expanded="sessionOpen"
        :aria-label="chatText.nodeSession(uiLanguage)"
        :title="controlTitle(chatText.nodeSession(uiLanguage))"
        @pointerdown="sessionOrbDown"
        @pointermove="sessionOrbMove"
        @pointerup="sessionOrbUp"
        @click="onSessionToggleClick"
        @pointerenter="wakeControl('session')"
        @pointerleave="restControl('session')"
        @focus="wakeControl('session')"
        @blur="restControl('session')"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3l9 5-9 5-9-5 9-5z" />
          <path d="M3 13l9 5 9-5" />
        </svg>
      </OrbNode>
      <Transition name="node-panel">
        <div v-if="sessionOpen" class="session-pod" :class="sessionPodLeft ? 'session-pod--left' : 'session-pod--right'">
          <div class="session-pod__row">
            <span class="session-pod__label">{{ chatText.nodeSession(uiLanguage) }}</span>
            <button
              v-if="gateway.currentSessionId"
              type="button"
              @click="copySessionId"
              :title="sessionIdCopied ? chatText.sessionIdCopied(uiLanguage) : chatText.copySessionId(uiLanguage, gateway.currentSessionId)"
              class="font-mono text-gray-300 inline-flex items-center gap-1 rounded px-1 hover:text-purple-300 hover:bg-purple-500/10 transition-colors cursor-pointer text-xs"
            >
              <code class="font-mono">{{ gateway.currentSessionId.substring(0, 8) }}…</code>
              <span class="text-[10px]" aria-hidden="true">{{ sessionIdCopied ? '✓' : '⧉' }}</span>
            </button>
            <span v-else class="italic text-gray-500 text-xs">{{ chatText.noActiveSession(uiLanguage) }}</span>
          </div>
          <select
            v-if="activeSessions.length > 0"
            :value="gateway.currentSessionId ?? ''"
            :aria-label="chatText.activeSession(uiLanguage)"
            class="w-full rounded-lg border border-purple-500/20 bg-gray-900/70 px-2 py-1 text-[11px] text-gray-300 truncate"
            @change="handleSessionSwitch"
          >
            <option value="">{{ chatText.selectActiveSession(uiLanguage) }}</option>
            <option v-for="session in activeSessions" :key="session.id" :value="session.id">
              {{ session.id.substring(0, 8) }}… · {{ chatText.sessionTurns(uiLanguage, session.turns) }}
            </option>
          </select>
          <button
            type="button"
            class="actions-pod__item session-pod__new"
            :disabled="newSessionBlockedReason !== ''"
            :title="newSessionBlockedReason || undefined"
            @click="startNewSession"
          >
            <span class="actions-pod__glyph" aria-hidden="true">＋</span>
            <span class="actions-pod__text">
              <span class="actions-pod__label">{{ chatText.newSession(uiLanguage) }}</span>
              <span class="actions-pod__hint">{{ newSessionBlockedReason || chatText.newSessionHint(uiLanguage) }}</span>
            </span>
          </button>
        </div>
      </Transition>
    </div>

    <!-- Session actions: what can be done with the session on the page, as a labelled list
         beside the control. They used to fan out on a full circle as bare glyphs (MD, DBG, AUD,
         ARC, RST): near a screen edge half of them left the screen, one landed on the header, and
         what a glyph did was told by a hover tooltip only. With no session there is nothing to
         act on: the control is drawn idle, and its panel says where a session starts. -->
    <div v-if="gateway.connected" class="orb-control" :class="controlClass" :style="actionsControlStyle">
      <OrbNode
        side="right"
        :docked="controlsDocked"
        :open="actionsOpen"
        :idle="sessionActions.length === 0"
        :label="controlLabelled.actions ? chatText.nodeActions(uiLanguage) : ''"
        :aria-expanded="actionsOpen"
        aria-haspopup="menu"
        :aria-label="chatText.nodeActionsLabel(uiLanguage)"
        :title="controlTitle(chatText.nodeActionsLabel(uiLanguage))"
        @pointerdown="actionsOrbDown"
        @pointermove="actionsOrbMove"
        @pointerup="actionsOrbUp"
        @click="onActionsToggleClick"
        @pointerenter="wakeControl('actions')"
        @pointerleave="restControl('actions')"
        @focus="wakeControl('actions')"
        @blur="restControl('actions')"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
          <path d="M4 7h10" /><circle cx="17" cy="7" r="2.2" />
          <path d="M20 12h-10" /><circle cx="7" cy="12" r="2.2" />
          <path d="M4 17h8" /><circle cx="15" cy="17" r="2.2" />
        </svg>
      </OrbNode>
      <Transition name="node-panel">
        <div
          v-if="actionsOpen"
          ref="actionsMenuEl"
          class="actions-pod"
          :class="[actionsPodLeft ? 'session-pod--left' : 'session-pod--right', actionsPodUp ? 'actions-pod--up' : '']"
          @keydown="onActionsMenuKeydown"
        >
          <p v-if="sessionActions.length === 0" class="actions-pod__empty">
            {{ chatText.noSessionActions(uiLanguage, chatText.nodeSession(uiLanguage)) }}
          </p>
          <!-- The list scrolls inside the panel: a panel that clipped its overflow would cut its own
               leader line off. -->
          <div v-else class="actions-pod__list" role="menu" :aria-label="chatText.nodeActionsLabel(uiLanguage)">
          <template v-for="(action, i) in sessionActions" :key="action.key">
            <div v-if="action.danger" class="actions-pod__rule" role="separator" />
            <button
              type="button"
              role="menuitem"
              class="actions-pod__item"
              :class="action.danger ? 'actions-pod__item--danger' : ''"
              :style="{ '--delay': `${i * 26}ms` }"
              :disabled="action.disabled"
              :title="action.disabled ? action.disabledReason : undefined"
              @click="action.run(); actionsOpen = false;"
            >
              <span class="actions-pod__glyph" aria-hidden="true">{{ action.glyph }}</span>
              <span class="actions-pod__text">
                <span class="actions-pod__label">{{ action.label }}</span>
                <span class="actions-pod__hint">{{ action.disabled ? action.disabledReason : action.hint }}</span>
              </span>
            </button>
          </template>
          </div>
        </div>
      </Transition>
    </div>

    <!-- The start suggestions of an empty chat, where the controls stand on their orbit: each a
         point of light with its words, on the front of a second, wider orbit round the lower half
         of the orb (composables/orbControls.ts starterLayout). The middle one stands in front,
         the others further round and further away; the orb canvas draws the arc they stand on.
         They fly out from the orb as they appear. On a narrow window they stay a row of pills at
         the foot of the page. -->
    <Transition name="orb-starters">
      <div v-if="showStarters && controlsDocked" class="orb-starters" role="group" :aria-label="starters.lead">
        <p
          v-if="starterSpots.leadY !== null"
          class="orb-starters__lead"
          :style="{ top: `calc(50% + ${Math.round(starterSpots.leadY)}px)` }"
        >{{ starters.lead }}</p>
        <button
          v-for="(starter, index) in starters.items"
          :key="starter.label"
          type="button"
          class="orb-starter"
          :class="`orb-starter--${starterSpots.stations[index]?.side ?? 'below'}`"
          :style="starterStyle(index)"
          @click="openComposer(starter.prompt)"
        >
          <span class="orb-starter__dot" aria-hidden="true" />
          <span class="orb-starter__label">{{ starter.label }}</span>
        </button>
        <p class="orb-starters__hint" :style="{ top: `calc(50% + ${Math.round(starterSpots.hintY)}px)` }">{{ starters.typeHint }}</p>
      </div>
    </Transition>

    </Teleport>

    <!-- Workspace -->
    <div class="relative z-10 flex-1 min-h-0 px-4 pb-4 pt-4 sm:px-5">
      <div class="chat-workspace h-full">
        <section class="chat-main-column relative">
          <!-- Smart-autoscroll resume pill: shown when the user has scrolled
               up and new messages have arrived since. Click to jump back to
               the bottom and re-enable auto-stick. -->
          <Transition name="scroll-resume">
            <button
              v-if="!isAtBottom && hasNewBelow"
              type="button"
              class="chat-scroll-resume"
              :class="composerOpen ? 'chat-scroll-resume--above-bay' : ''"
              @click="jumpToBottom"
              :aria-label="chatText.jumpToLatest(uiLanguage)"
            >
              <span aria-hidden="true">↓</span>
              <span>{{ gateway.isLoading ? chatText.newActivity(uiLanguage) : chatText.newMessages(uiLanguage) }}</span>
            </button>
          </Transition>
          <div ref="messagesEl" class="chat-message-scroll" :class="composerOpen ? 'chat-message-scroll--bay-open' : ''" :style="podLaneStyle">
            <div v-if="gateway.currentSessionHasOlderMessages" class="flex justify-center">
              <button
                @click="loadOlderMessages"
                :disabled="gateway.currentSessionTranscriptLoading"
                class="rounded-full border border-purple-500/25 bg-gray-900/70 px-4 py-1.5 text-xs text-purple-200 transition hover:border-purple-400/45 hover:text-purple-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {{ gateway.currentSessionTranscriptLoading ? chatText.loadingOlder(uiLanguage) : chatText.loadOlder(uiLanguage) }}
              </button>
            </div>

            <div v-if="collapsedMessageCount > 0" class="chat-history-collapsed">
              <button
                @click="expandedMessageHistory = !expandedMessageHistory"
                class="chat-history-collapsed__button"
              >
                {{ expandedMessageHistory ? chatText.hideOlder(uiLanguage, collapsedMessageCount) : chatText.showOlder(uiLanguage, collapsedMessageCount) }}
              </button>
            </div>

            <MessageBubble
              v-for="msg in visibleMessages"
              :key="msg.id"
              :message="msg"
              :is-streaming="msg.id === 'streaming'"
              :streaming-text="msg.id === 'streaming' ? gateway.streamingText : undefined"
              :streaming-reasoning="msg.id === 'streaming' ? gateway.streamingReasoning : undefined"
              :streaming-sub-agent-reasoning="msg.id === 'streaming' ? gateway.streamingSubAgentReasoning : undefined"
              :auto-collapse="msg.role === 'assistant' && msg.id !== 'streaming' && !latestTurnView.assistantIds.has(msg.id)"
              :fold-steps="msg.role === 'assistant' && msg.id !== 'streaming'"
              :allow-rewind="!gateway.isLoading && gateway.mayCall('session.rewind')"
              :live-at-orb="orbHasRoomForSteps"
              @rewind="handleRewind"
              @retry="handleRetry"
              @resend="handleResendSteer"
              @show-step="showStep"
            />

            <!-- Questions with no step on screen to sit under — after a reload the steps are
                 rebuilt from the transcript and the waiting call is not among them. They still
                 belong to the conversation, so they close it rather than float over it. -->
            <div v-if="gateway.userInputPlacement.floating.length" class="chat-floating-inputs">
              <UserInputCard
                v-for="inputId in gateway.userInputPlacement.floating"
                :key="inputId"
                :input-id="inputId"
                :language="orbLanguage"
              />
            </div>

            <!-- Nothing here yet: a start for the user to finish. (On a wide window the
                 suggestions stand round the orb instead: see the arc beside the controls.) -->
            <div v-if="showStarters && !controlsDocked" class="chat-starters">
              <p class="chat-starters__lead">{{ starters.lead }}</p>
              <div class="chat-starters__list">
                <button
                  v-for="starter in starters.items"
                  :key="starter.label"
                  type="button"
                  class="chat-starters__item"
                  @click="openComposer(starter.prompt)"
                >{{ starter.label }}</button>
              </div>
              <p class="chat-starters__hint">{{ starters.typeHint }}</p>
            </div>
          </div>
        </section>
      </div>
    </div>

    <!-- Off-canvas side panel: Live Context + Artifacts -->
    <SidePanel
      :language="uiLanguage"
      v-model="sidePanelOpen"
      :has-live-content="hasSidePanels"
      :artifact-count="sessionArtifacts.length"
      :step-count="stepDetailToolCount"
      :requested-tab="requestedPanelTab"
    >
      <!-- Steps slot: every step of the ONE answer whose row was clicked, that row opened. -->
      <template #steps>
        <StepDetailPanel :steps="stepDetailSteps" :focus-step-id="focusedStepId" :focus-request="focusRequest" :language="stepDetailLanguage" />
      </template>
      <!-- Live context slot: swarm, shell, computer sessions -->
      <template #live>
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
        <ShellSessionPanel v-if="shellStore.hasEntries" />
        <ComputerSessionPanel v-if="computerStore.loading || computerStore.sessions.length > 0 || gateway.isLoading" />
      </template>

      <!-- Artifacts slot: previewable and downloadable files produced by the agent -->
      <template #artifacts>
        <template v-if="sessionArtifacts.length > 0">
          <!-- Artifact selector pills -->
          <div class="panel-artifact-list" role="listbox" aria-label="Session artifacts">
            <button
              v-for="att in sessionArtifacts"
              :key="att.filename"
              role="option"
              class="panel-artifact-pill"
              :class="{ 'panel-artifact-pill--active': selectedPanelArtifact?.filename === att.filename }"
              :aria-selected="selectedPanelArtifact?.filename === att.filename"
              :title="att.title || att.filename"
              @click="selectPanelArtifact(att)"
            >
              <span class="panel-artifact-pill__icon" aria-hidden="true">{{ panelArtifactIcon(att) }}</span>
              <span class="panel-artifact-pill__name">{{ att.title || att.filename }}</span>
            </button>
          </div>

          <!-- Toolbar: download / ZIP buttons for the selected artifact -->
          <div v-if="selectedPanelArtifact" class="panel-artifact-toolbar">
            <button
              v-if="selectedPanelArtifact.isDirectory"
              class="btn-ghost px-3 py-1.5 rounded-lg text-xs flex items-center gap-1.5"
              title="Download as ZIP"
              @click="gateway.downloadWorkspaceArtifact(selectedPanelArtifact.relativePath!, { archive: true, suggestedFilename: (selectedPanelArtifact.title || selectedPanelArtifact.filename) + '.zip' })"
            >
              <span aria-hidden="true">⬇</span> Download ZIP
            </button>
            <button
              v-else
              class="btn-ghost px-3 py-1.5 rounded-lg text-xs flex items-center gap-1.5"
              title="Download file"
              @click="gateway.downloadWorkspaceArtifact(selectedPanelArtifact.relativePath!, { suggestedFilename: selectedPanelArtifact.filename })"
            >
              <span aria-hidden="true">⬇</span> Download
            </button>
          </div>

          <!-- Preview area -->
          <div class="panel-artifact-preview">
            <div v-if="!selectedPanelArtifact" class="panel-artifact-preview__hint">
              Select an artifact above to preview it.
            </div>
            <div v-else-if="panelArtifactLoading" class="panel-artifact-preview__loading" aria-live="polite">
              Loading preview…
            </div>
            <div v-else-if="panelArtifactError" class="panel-artifact-preview__error" role="alert">
              {{ panelArtifactError }}
            </div>
            <template v-else-if="panelArtifactPreview">
              <iframe
                v-if="panelArtifactPreview.kind === 'html' || panelArtifactPreview.kind === 'pdf'"
                :src="panelArtifactPreview.url"
                class="panel-artifact-frame"
                :sandbox="panelArtifactPreview.kind === 'html' ? 'allow-scripts' : undefined"
                referrerpolicy="no-referrer"
                title="Artifact preview"
              />
              <audio
                v-else-if="panelArtifactPreview.kind === 'audio'"
                :src="panelArtifactPreview.url"
                controls
                class="panel-artifact-audio"
              />
              <!-- Website preview: served directly from gateway so relative imports work -->
              <iframe
                v-else-if="panelArtifactPreview.kind === 'website'"
                :src="panelArtifactPreview.url"
                class="panel-artifact-frame"
                sandbox="allow-scripts"
                referrerpolicy="no-referrer"
                title="Website preview"
              />
              <!-- Download-only: no inline preview, just a prompt -->
              <div v-else-if="panelArtifactPreview.kind === 'download'" class="panel-artifact-download-prompt">
                <span class="panel-artifact-download-prompt__icon" aria-hidden="true">{{ panelArtifactIcon(selectedPanelArtifact!) }}</span>
                <p class="panel-artifact-download-prompt__name">{{ selectedPanelArtifact!.title || selectedPanelArtifact!.filename }}</p>
                <p class="panel-artifact-download-prompt__hint">No inline preview available for this file type.</p>
                <button
                  class="btn-grad px-5 py-2 rounded-xl text-sm mt-2"
                  @click="gateway.downloadWorkspaceArtifact(selectedPanelArtifact!.relativePath!, { suggestedFilename: selectedPanelArtifact!.filename })"
                >
                  Download file
                </button>
              </div>
              <pre v-else class="panel-artifact-text">{{ panelArtifactPreview.text }}</pre>
            </template>
          </div>
        </template>
      </template>
    </SidePanel>

    <Teleport to="body">
      <Transition name="approval">
        <div v-if="gateway.pendingApproval"
             role="alertdialog" aria-live="assertive"
             class="approval-banner">
          <div class="approval-banner__header">
            <span class="approval-banner__eyebrow">{{ chatText.approvalRequired(uiLanguage) }}</span>
            <span v-if="approvalCountdownLabel" class="approval-banner__timer">{{ approvalCountdownLabel }}</span>
          </div>
          <p class="approval-banner__copy">
            The agent wants to call
            <code class="approval-banner__tool">{{ gateway.pendingApproval.toolName }}</code>
            with these arguments:
          </p>
          <pre class="approval-banner__args">{{ JSON.stringify(gateway.pendingApproval.args, null, 2) }}</pre>
          <div class="approval-banner__actions">
            <button @click="approveAction(true)" class="btn-grad approval-banner__button">
              {{ chatText.approve(uiLanguage) }}
            </button>
            <button @click="approveAction(false)" class="btn-ghost approval-banner__button approval-banner__button--deny">
              {{ chatText.deny(uiLanguage) }}
            </button>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- Human-in-the-loop input request banner -->
    <Transition name="approval">
      <div v-if="gateway.pendingInputRequest"
           role="alertdialog" aria-live="assertive"
           class="relative z-20 mx-5 mb-2 rounded-2xl overflow-hidden"
           style="background: rgba(10,18,30,0.97); border: 1px solid rgba(56,189,248,0.5); box-shadow: 0 0 24px rgba(56,189,248,0.2);">
        <div class="px-5 py-4">
          <div class="flex items-center gap-2 mb-2">
            <span class="text-xs font-semibold tracking-widest uppercase"
                  style="background: linear-gradient(90deg,#38bdf8,#818cf8); -webkit-background-clip:text; -webkit-text-fill-color:transparent;">
              {{ chatText.question(uiLanguage) }}
            </span>
            <span v-if="inputRequestCountdownLabel" class="ml-auto text-xs tabular-nums text-gray-400">{{ inputRequestCountdownLabel }}</span>
          </div>
          <p class="text-sm text-gray-200 mb-3">{{ gateway.pendingInputRequest.question }}</p>
          <div v-if="gateway.pendingInputRequest.choices?.length" class="flex flex-wrap gap-2 mb-3">
            <button
              v-for="choice in gateway.pendingInputRequest.choices"
              :key="choice"
              @click="submitInputChoice(choice)"
              class="btn-ghost px-4 py-2 rounded-xl text-sm font-medium"
              style="border-color: rgba(56,189,248,0.35); color: #7dd3fc;">
              {{ choice }}
            </button>
          </div>
          <div class="flex gap-2">
            <input
              v-model="inputRequestText"
              type="text"
              :placeholder="chatText.answerPlaceholder(uiLanguage)"
              @keydown="onInputRequestKeydown"
              aria-label="Free-text answer to the agent's question"
              class="flex-1 rounded-xl bg-gray-800/60 border border-white/10 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-sky-500/50" />
            <button
              @click="submitInputFreeText"
              :disabled="!inputRequestText.trim()"
              class="btn-grad px-4 py-2 rounded-xl text-sm font-semibold disabled:opacity-40">
              {{ chatText.send(uiLanguage) }}
            </button>
            <!-- The floating steering bay (with its Stop button) is folded away while a question is
                 pending, so surface Stop here to keep the abort path available. -->
            <button
              v-if="gateway.isLoading"
              type="button"
              :disabled="stoppingTurn"
              @click="stopTurn"
              class="px-4 py-2 rounded-xl text-sm font-semibold shrink-0 bg-red-600/80 hover:bg-red-500/90 border border-red-400/40 text-white transition-colors disabled:opacity-60 disabled:cursor-progress"
              :title="chatText.stopTitle(uiLanguage)">
              {{ stoppingTurn ? chatText.stopping(uiLanguage) : chatText.stop(uiLanguage) }}
            </button>
          </div>
        </div>
      </div>
    </Transition>

    <Teleport to="body">
    <Transition name="approval">
      <div v-if="gateway.pendingIntervention"
           role="alert" aria-live="assertive"
           class="intervention-banner rounded-2xl overflow-hidden"
           :style="gateway.pendingApproval ? { bottom: 'calc(max(5.5rem, var(--bay-h, 0px) + 2.5rem) + 11rem)' } : undefined"
           :class="gateway.pendingIntervention.severity === 'error' ? 'border border-red-500/45' : 'border border-amber-500/45'"
           style="background: rgba(18,14,28,0.97); box-shadow: 0 0 24px rgba(245,158,11,0.16);">
        <div class="px-5 py-4">
          <div class="flex items-center justify-between gap-3 mb-2">
            <div>
              <div class="text-xs font-semibold tracking-widest uppercase text-amber-300">{{ chatText.operatorAction(uiLanguage) }}</div>
              <div class="mt-1 text-sm text-gray-100">{{ gateway.pendingIntervention.summary }}</div>
            </div>
            <button @click="gateway.dismissIntervention()"
                    class="rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-gray-400 transition hover:border-white/20 hover:text-gray-200">
              {{ chatText.dismiss(uiLanguage) }}
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
    </Teleport>

    <!-- Input bay: a floating bottom panel (no layout impact at all);
         recedes into depth while idle, summoned by the message input's control. -->
    <div class="chat-input-bay-wrap" :class="bayOpen ? 'chat-input-bay-wrap--open' : ''">
    <div
      ref="bayEl"
      class="chat-input-bay relative bg-gray-900/85 backdrop-blur-xl border border-purple-500/25 rounded-2xl px-5 py-4 shadow-2xl shadow-black/50"
      :class="bayOpen ? '' : 'chat-input-bay--hidden'"
      :inert="!bayOpen"
      @focusin="composerFocused = true"
      @focusout="onComposerFocusOut"
    >

      <!-- Pending image attachment chips -->
      <div v-if="pendingImageContexts.length > 0" class="flex flex-wrap gap-2 mb-2">
        <div
          v-for="(img, idx) in pendingImageContexts"
          :key="img.filename + idx"
          class="flex items-center gap-1.5 rounded-xl border border-purple-500/40 bg-purple-900/20 overflow-hidden pr-1"
        >
          <!-- Thumbnail — click opens preview modal -->
          <button
            type="button"
            @click="previewModalUrl = img.previewUrl"
            class="shrink-0 rounded-l-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70"
            :title="chatText.previewImage(uiLanguage)"
            :aria-label="chatText.previewFile(uiLanguage, img.filename)"
          >
            <img :src="img.previewUrl" :alt="img.filename" class="h-9 w-9 object-cover rounded-l-xl" />
          </button>
          <!-- Filename -->
          <span class="text-xs text-purple-300 max-w-[8rem] truncate select-none">{{ img.filename }}</span>
          <!-- Remove -->
          <button
            type="button"
            @click="removeImage(idx)"
            class="chip-remove text-purple-400 hover:text-red-300"
            :title="chatText.removeAttachment(uiLanguage)"
            :aria-label="chatText.removeNamed(uiLanguage, img.filename)"
          >✕</button>
        </div>
      </div>

      <!-- Pending document attachment chips (ingested into the document library on send) -->
      <div v-if="pendingDocumentContexts.length > 0" class="flex flex-wrap gap-2 mb-2">
        <div
          v-for="(doc, idx) in pendingDocumentContexts"
          :key="doc.filename + idx"
          class="flex items-center gap-1.5 rounded-xl border border-cyan-500/40 bg-cyan-900/20 pl-2 pr-1 py-1"
        >
          <span class="text-cyan-300 text-sm leading-none" aria-hidden="true">📄</span>
          <span class="text-xs text-cyan-200 max-w-[10rem] truncate select-none" :title="doc.filename">{{ doc.filename }}</span>
          <button
            type="button"
            @click="removeDocument(idx)"
            class="chip-remove text-cyan-400 hover:text-red-300"
            :title="chatText.removeAttachment(uiLanguage)"
            :aria-label="chatText.removeNamed(uiLanguage, doc.filename)"
          >✕</button>
        </div>
      </div>

      <!-- Inline override flag chips -->
      <div v-if="activeFlags.length > 0" class="flex flex-wrap gap-1.5 mb-2">
        <button
          v-for="flag in activeFlags"
          :key="flag.label"
          @click="removeFlag(flag.pattern)"
          type="button"
          :class="['flex items-center gap-1 px-2.5 py-1 text-xs rounded-full border transition-colors', flagChipClass(flag.color)]"
          :title="chatText.removeFlagTitle(uiLanguage)"
          :aria-label="chatText.removeNamed(uiLanguage, flag.label)"
        >
          {{ flag.label }}
          <span class="opacity-50 ml-0.5">✕</span>
        </button>
      </div>

      <div v-if="showMultimodalStatus && (voiceStatusWorthShowing || (showWakeMode && wakeListening))" class="mb-3 flex flex-wrap items-center gap-2 text-xs text-gray-300">
        <!-- A sentence, set as one: in the capitals and wide spacing of a label, "report.pdf
             attached" shouted its file name, and a long line read as a greyed-out input field. -->
        <span v-if="voiceStatusWorthShowing" class="multimodal-status rounded-xl px-3 py-1 text-xs" role="status">
          {{ voiceStatus }}
        </span>
        <span v-if="showWakeMode && wakeListening" class="multimodal-status multimodal-status-live rounded-full px-3 py-1 text-[11px] uppercase tracking-wide">
          {{ chatText.sayWakeWord(uiLanguage, wakeKeywords.join(" / ")) }}
        </span>
      </div>

      <div v-if="showWakeFeedbackCard" :class="['wake-feedback-card', `wake-feedback-card--${wakeFeedbackTone}`]">
        <div class="wake-feedback-card__header">
          <div>
            <div class="wake-feedback-card__eyebrow">{{ chatText.wakeEyebrow(uiLanguage) }}</div>
            <div class="wake-feedback-card__title">{{ wakeFeedbackTitle }}</div>
          </div>
          <div class="wake-feedback-card__steps">
            <span :class="['wake-feedback-card__step', wakeFeedbackStep >= 1 ? 'wake-feedback-card__step--active' : '']">{{ chatText.wakeStepListening(uiLanguage) }}</span>
            <span :class="['wake-feedback-card__step', wakeFeedbackStep >= 2 ? 'wake-feedback-card__step--active' : '']">{{ chatText.wakeStepRecording(uiLanguage) }}</span>
            <span :class="['wake-feedback-card__step', wakeFeedbackStep >= 3 ? 'wake-feedback-card__step--active' : '']">{{ chatText.wakeStepTranscribing(uiLanguage) }}</span>
            <span :class="['wake-feedback-card__step', wakeFeedbackStep >= 4 ? 'wake-feedback-card__step--active' : '']">{{ chatText.wakeStepReady(uiLanguage) }}</span>
          </div>
        </div>
        <div class="wake-feedback-card__message">{{ wakeFeedbackMessage }}</div>
        <div class="wake-feedback-card__meter">
          <span class="wake-feedback-card__meter-fill" />
        </div>
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
          multiple
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

      <!-- The voice: what is being said or heard, Stop, and the spoken answer's text. -->
      <div v-if="showVoiceBar" class="voice-bar" role="status" aria-live="polite">
        <div class="voice-bar__row">
          <span
            class="voice-bar__indicator"
            :class="voiceBarBusy ? 'voice-bar__indicator--speaking' : voiceBarListening ? 'voice-bar__indicator--listening' : ''"
            aria-hidden="true"
          ><span /><span /><span /></span>
          <div class="voice-bar__text">
            <div class="voice-bar__eyebrow">{{ chatText.voiceEyebrow(uiLanguage, voiceConversationMode) }}</div>
            <div class="voice-bar__label" :class="voiceNotice ? 'voice-bar__label--notice' : ''">{{ voiceNotice || voiceBarLabel }}</div>
          </div>
          <div v-if="voiceBarListening" class="voice-bar__meter" aria-hidden="true">
            <span :style="{ width: `${Math.round(micLevel * 100)}%` }" />
          </div>
          <div class="voice-bar__actions">
            <button v-if="voiceBarBusy" type="button" class="voice-bar__button voice-bar__button--stop" @click="voice.stopSpeaking()">{{ chatText.voiceStop(uiLanguage) }}</button>
            <button v-if="recordingState === 'recording'" type="button" class="voice-bar__button" @click="toggleRecording()">{{ chatText.voiceDone(uiLanguage) }}</button>
            <button v-if="lastReply?.summarized" type="button" class="voice-bar__button" @click="voice.readFullReply()">{{ chatText.readFull(uiLanguage) }}</button>
            <button v-if="lastReply && !voiceBarBusy" type="button" class="voice-bar__button" @click="voice.replay()">{{ chatText.replay(uiLanguage) }}</button>
            <button v-if="lastReply" type="button" class="voice-bar__button" @click="replyTextOpen = !replyTextOpen">{{ replyTextOpen ? chatText.hideText(uiLanguage) : chatText.showText(uiLanguage) }}</button>
            <button v-if="voiceConversationMode" type="button" class="voice-bar__button" @click="voice.toggleConversation()">{{ chatText.endConversation(uiLanguage) }}</button>
            <button
              v-if="!voiceBarBusy && !voiceConversationMode && recordingState === 'idle'"
              type="button"
              class="voice-bar__close"
              :aria-label="chatText.closeVoiceBar(uiLanguage)"
              @click="dismissVoiceBar()"
            >✕</button>
          </div>
        </div>
        <p v-if="lastReply && replyTextOpen" class="voice-bar__body">{{ lastReply.spokenText }}</p>
      </div>

      <div ref="composerEl" class="chat-composer" :class="[compactComposer ? 'chat-composer--compact' : '', optionsDocked ? 'chat-composer--docked' : '']">
        <div ref="composerFieldEl" class="chat-composer__field">
          <!-- Slash-command autocomplete popup. Shown when the textarea starts with '/'
               and the user is still typing the command name (no space yet). -->
          <div
            v-if="slashOpen && slashSuggestions.length > 0"
            class="slash-popup"
            role="listbox"
            :aria-label="chatText.slashSuggestions(uiLanguage)"
          >
            <div class="slash-popup__hint">{{ chatText.slashHint(uiLanguage) }}</div>
            <button
              v-for="(item, index) in slashSuggestions"
              :key="`${item.kind}:${item.name}`"
              type="button"
              :class="['slash-popup__item', index === slashIndex ? 'slash-popup__item--active' : '']"
              role="option"
              :aria-selected="index === slashIndex"
              @mousedown.prevent="acceptSlashSuggestion(index)"
              @mouseenter="slashIndex = index"
            >
              <span class="slash-popup__name">/{{ item.name }}</span>
              <span class="slash-popup__kind">{{ item.kind }}</span>
              <span v-if="item.description" class="slash-popup__desc">{{ item.description }}</span>
            </button>
          </div>
          <textarea
            ref="composerTextareaEl"
            v-model="inputText"
            @keydown="onComposerKeydown"
            :disabled="!gateway.connected || readOnly || Boolean(gateway.pendingInputRequest)"
            class="chat-composer__textarea"
            :class="compactComposer ? 'chat-composer__textarea--compact' : ''"
            :style="composerTextareaStyle"
            :placeholder="composerBlockedReason || (gateway.hasOpenUserInput
              ? chatText.cardPlaceholder(uiLanguage)
              : gateway.isLoading ? chatText.steerPlaceholder(uiLanguage) : composerPlaceholder)"
            :title="composerBlockedReason || undefined"
            rows="3"
          />
          <div
            v-if="steeringNote"
            class="chat-composer__steering-note"
            :class="steeringNoteTone === 'error' ? 'chat-composer__steering-note--error' : ''"
            :role="steeringNoteTone === 'error' ? 'alert' : 'status'"
          >{{ steeringNote }}</div>
        </div>

        <!-- The options: a row of chips in the bay, or — on a window with the room — nodes on
             the orbit's front, where the message input's own control stands while the bay is
             folded away (composables/orbControls.ts optionStations). The same elements either
             way: on the orbit each is placed from the bay's own box, whose centre line is the
             viewport's and whose foot stands a fixed way over the window's. -->
        <div class="chat-composer__controls">
          <div class="chat-composer__menus">
            <details
              v-if="showOptionsDropdown"
              ref="optionsDetailsEl"
              class="chat-dropdown"
              :class="optionClass('options')"
              :style="optionStyle('options')"
              data-option="options"
              @toggle="onComposerMenuToggle"
              @pointerenter="wakeControl('options')"
              @pointerleave="restControl('options')"
              @focusin="wakeControl('options')"
              @focusout="restControl('options')"
            >
              <summary
                class="chat-dropdown__summary"
                :title="optionsDocked ? chatText.options(uiLanguage) : undefined"
                :aria-label="optionsDocked ? chatText.options(uiLanguage) : undefined"
              >
                <OrbNode v-if="optionsDocked" as="span" side="below" docked :open="openMenus.options" :label="chatText.options(uiLanguage)">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
                    <path d="M12 5v14" /><path d="M5 12h14" />
                  </svg>
                </OrbNode>
                <template v-else>
                  <span>{{ chatText.options(uiLanguage) }}</span>
                  <span class="chat-dropdown__chevron">▾</span>
                </template>
              </summary>
              <div class="chat-dropdown__menu">
                <div class="chat-dropdown__group">
                  <div class="chat-dropdown__label">{{ chatText.attachmentsAndVoice(uiLanguage) }}</div>
                  <div class="chat-dropdown__actions">
                    <button
                      v-if="showFileInput"
                      @click="fileInputEl?.click()"
                      :disabled="multimodalBusy"
                      class="btn-brand-ghost multimodal-action multimodal-icon-button px-3 py-1.5 rounded-xl disabled:opacity-40"
                      :title="multimodalBusy ? chatText.audioBusy(uiLanguage) : chatText.attachTitle(uiLanguage)"
                      :aria-label="chatText.attachLabel(uiLanguage)"
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
                      :title="multimodalBusy ? chatText.audioBusy(uiLanguage) : chatText.uploadAudioTitle(uiLanguage)"
                      :aria-label="chatText.uploadAudioLabel(uiLanguage)"
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
                      :disabled="(multimodalBusy && recordingState !== 'recording') || voiceConversationMode"
                      class="btn-brand-ghost multimodal-action multimodal-icon-button px-3 py-1.5 rounded-xl disabled:opacity-40"
                      :class="recordingState === 'recording' ? 'multimodal-action-active' : ''"
                      :title="voiceConversationMode ? chatText.recordInConversation(uiLanguage) : recordingState === 'recording' ? chatText.stopMicRecording(uiLanguage) : multimodalBusy ? chatText.audioBusy(uiLanguage) : chatText.recordFromMic(uiLanguage)"
                      :aria-label="recordingState === 'recording' ? chatText.stopRecordingLabel(uiLanguage) : chatText.recordVoiceLabel(uiLanguage)"
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
                      :disabled="recordingState === 'processing' || voiceConversationMode"
                      class="btn-brand-ghost multimodal-action multimodal-icon-button px-3 py-1.5 rounded-xl disabled:opacity-40"
                      :class="wakeListening ? 'multimodal-action-active' : ''"
                      :title="voiceConversationMode ? chatText.conversationNeedsNoWakeWord(uiLanguage) : (wakeListening ? chatText.disableWakeWord(uiLanguage) : chatText.enableWakeWord(uiLanguage))"
                      :aria-label="wakeListening ? chatText.stopWakeMode(uiLanguage) : chatText.startWakeMode(uiLanguage)"
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
                      v-if="showVoiceConversation"
                      @click="voice.toggleConversation()"
                      :disabled="recordingState !== 'idle' || wakeListening"
                      class="btn-brand-ghost multimodal-action multimodal-icon-button px-3 py-1.5 rounded-xl disabled:opacity-40"
                      :class="voiceConversationMode ? 'multimodal-action-active' : ''"
                      :title="voiceConversationMode ? chatText.conversationRunning(uiLanguage) : chatText.startConversationTitle(uiLanguage)"
                      :aria-label="voiceConversationMode ? chatText.stopConversationLabel(uiLanguage) : chatText.startConversationLabel(uiLanguage)"
                      :aria-pressed="voiceConversationMode"
                    >
                      <svg class="multimodal-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3Z" />
                        <path d="M5 12a7 7 0 0 0 14 0" />
                        <path d="M12 19v3" />
                        <path d="M3 6.5L21 6.5" stroke-dasharray="2 3" stroke-width="1.25" />
                      </svg>
                    </button>
                    <button
                      v-if="showSpeechPlayback"
                      @click="voice.speakLatest()"
                      :disabled="!latestAssistantText"
                      class="btn-brand-ghost multimodal-action multimodal-icon-button px-3 py-1.5 rounded-xl disabled:opacity-40"
                      :title="chatText.readLatestAloud(uiLanguage)"
                      :aria-label="chatText.speakReplyLabel(uiLanguage)"
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
                      @click="voice.toggleSpeak()"
                      class="btn-brand-ghost multimodal-action multimodal-icon-button px-3 py-1.5 rounded-xl"
                      :class="speakReplyEnabled ? 'multimodal-action-active' : ''"
                      :title="speakReplyEnabled ? chatText.speechOnTitle(uiLanguage) : chatText.speechOffTitle(uiLanguage)"
                      :aria-label="speakReplyEnabled ? chatText.turnSpeechOff(uiLanguage) : chatText.turnSpeechOn(uiLanguage)"
                      :aria-pressed="speakReplyEnabled"
                    >
                      <svg class="multimodal-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M11 5 6 9H3v6h3l5 4V5Z" />
                        <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                        <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                      </svg>
                    </button>
                  </div>
                  <div v-if="showSpeechPlayback || showAudioUpload" class="chat-dropdown__voice-settings">
                    <label v-if="showAudioUpload" class="chat-dropdown__voice-setting">
                      <span>{{ chatText.spokenLanguage(uiLanguage) }}</span>
                      <select v-model="sttLanguage" class="chat-dropdown__select" :title="chatText.spokenLanguageTitle(uiLanguage)">
                        <option value="auto">{{ chatText.detectLanguage(uiLanguage) }}</option>
                        <option value="de">Deutsch</option>
                        <option value="en">English</option>
                        <option value="pl">Polski</option>
                      </select>
                    </label>
                    <label v-if="showSpeechPlayback" class="chat-dropdown__voice-setting">
                      <span>{{ chatText.whileTurnRuns(uiLanguage) }}</span>
                      <select v-model="speechUpdates" class="chat-dropdown__select" :title="chatText.speechUpdatesTitle(uiLanguage)">
                        <option value="voice">{{ chatText.spokenUpdates(uiLanguage) }}</option>
                        <option value="tones">{{ chatText.tonesOnly(uiLanguage) }}</option>
                        <option value="off">{{ chatText.silentUntilAnswer(uiLanguage) }}</option>
                      </select>
                    </label>
                  </div>
                </div>

                <div v-if="gateway.scenes.length > 0" class="chat-dropdown__group">
                  <div class="chat-dropdown__label">{{ chatText.scenes(uiLanguage) }}</div>
                  <div class="chat-dropdown__scene-grid">
                    <button
                      v-for="scene in gateway.scenes"
                      :key="scene.name"
                      @click="triggerScene(scene.name)"
                      :disabled="gateway.isLoading || !gateway.connected || readOnly || isSceneRunning(scene.name)"
                      :title="startButtonTitle(scene.description, startBlockedReason('scene', isSceneRunning(scene.name)))"
                      class="chat-scene-pill"
                    >
                      <span class="text-purple-500 transition-colors">{{ isSceneRunning(scene.name) ? '●' : '▶' }}</span>
                      {{ scene.name.replace(/_/g, ' ') }}
                    </button>
                  </div>
                </div>

                <div v-if="configuredJobs.length > 0" class="chat-dropdown__group">
                  <div class="chat-dropdown__label">{{ chatText.jobs(uiLanguage) }}</div>
                  <div class="chat-dropdown__scene-grid">
                    <button
                      v-for="job in configuredJobs"
                      :key="job.name"
                      @click="triggerJob(job.name)"
                      :disabled="gateway.isLoading || !gateway.connected || readOnly || isJobRunning(job.name)"
                      :title="startButtonTitle(job.description, startBlockedReason('job', isJobRunning(job.name)))"
                      class="chat-scene-pill"
                    >
                      <span class="text-cyan-400 transition-colors">{{ isJobRunning(job.name) ? '●' : '↻' }}</span>
                      {{ job.name.replace(/_/g, ' ') }}
                    </button>
                  </div>
                </div>
              </div>
            </details>

            <details
              v-if="showJobsDropdown"
              class="chat-dropdown"
              :class="optionClass('jobs')"
              :style="optionStyle('jobs')"
              data-option="jobs"
              @toggle="onComposerMenuToggle"
              @pointerenter="wakeControl('jobs')"
              @pointerleave="restControl('jobs')"
              @focusin="wakeControl('jobs')"
              @focusout="restControl('jobs')"
            >
              <summary
                class="chat-dropdown__summary"
                :title="optionsDocked ? jobsDropdownLabel : undefined"
                :aria-label="optionsDocked ? jobsDropdownLabel : undefined"
              >
                <OrbNode
                  v-if="optionsDocked"
                  as="span"
                  side="below"
                  docked
                  :open="openMenus.jobs"
                  :lit="scenesStore.runningJobs.length > 0"
                  :label="optionName(chatText.jobs(uiLanguage), Boolean(jobsNodeState))"
                  :state="jobsNodeState"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M4 6h9" /><path d="M4 12h6" /><path d="M4 18h9" /><path d="M15 9l5 3-5 3z" />
                  </svg>
                </OrbNode>
                <template v-else>
                  <span>{{ jobsDropdownLabel }}</span>
                  <span class="chat-dropdown__chevron">▾</span>
                </template>
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
                        {{ chatText.dismiss(uiLanguage) }}
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

            <!-- Effort: the four tiers as a list with what each one does. It used to be one button
                 that stepped through them — one click past "high" landed on "max", which relaxes
                 the quality gates, with no warning, and going back to "low" took three more. -->
            <details
              ref="effortDetailsEl"
              class="chat-dropdown chat-dropdown--effort"
              :class="optionClass('effort')"
              :style="optionStyle('effort')"
              data-option="effort"
              @toggle="onComposerMenuToggle"
              @pointerenter="wakeControl('effort')"
              @pointerleave="restControl('effort')"
              @focusin="wakeControl('effort')"
              @focusout="restControl('effort')"
            >
              <summary
                class="chat-dropdown__summary chat-dropdown__summary--effort"
                :class="optionsDocked ? '' : effortButtonClass"
                :title="chatText.effortTitle(uiLanguage, currentEffort)"
                :aria-label="chatText.effortLabel(uiLanguage, currentEffort)"
              >
                <!-- On the orbit the tier shows as on its chip: "high" lit, "low" drawn idle, "max" in amber. -->
                <OrbNode
                  v-if="optionsDocked"
                  as="span"
                  side="below"
                  docked
                  :open="openMenus.effort"
                  :lit="currentEffort === 'high'"
                  :idle="currentEffort === 'low'"
                  :tone="currentEffort === 'max' ? 'caution' : ''"
                  :label="optionName(chatText.optionEffort(uiLanguage), true)"
                  :state="chatText.effortName(uiLanguage, currentEffort)"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
                  </svg>
                </OrbNode>
                <template v-else>
                  <svg class="multimodal-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
                  </svg>
                  <span>{{ chatText.effortName(uiLanguage, currentEffort) }}</span>
                  <span class="chat-dropdown__chevron" aria-hidden="true">▾</span>
                </template>
              </summary>
              <div class="chat-dropdown__menu chat-dropdown__menu--effort" role="radiogroup" :aria-label="chatText.effortForSession(uiLanguage)">
                <div class="chat-dropdown__label">{{ chatText.effortForSession(uiLanguage) }}</div>
                <button
                  v-for="tier in EFFORT_TIERS"
                  :key="tier"
                  type="button"
                  role="radio"
                  class="effort-option"
                  :class="[tier === currentEffort ? 'effort-option--current' : '', tier === 'max' ? 'effort-option--caution' : '']"
                  :aria-checked="tier === currentEffort"
                  :disabled="!mayChangeSettings"
                  @click="chooseEffort(tier)"
                >
                  <span class="effort-option__name">
                    <span>{{ chatText.effortName(uiLanguage, tier) }}</span>
                    <span v-if="tier === 'max'" class="effort-option__flag">{{ chatText.relaxesGates(uiLanguage) }}</span>
                    <span v-if="tier === currentEffort" class="effort-option__check" aria-hidden="true">✓</span>
                  </span>
                  <span class="effort-option__text">{{ chatText.effortDescription(uiLanguage, tier) }}</span>
                </button>
              </div>
            </details>

            <!-- Whether a render in this chat stops for the user's settings first. The same
                 session setting as the card's "Always Auto in this chat". -->
            <div
              v-if="optionsDocked"
              :class="optionClass('images')"
              :style="optionStyle('images')"
              @pointerenter="wakeControl('images')"
              @pointerleave="restControl('images')"
              @focusin="wakeControl('images')"
              @focusout="restControl('images')"
            >
              <OrbNode
                side="below"
                docked
                :lit="gateway.currentSessionImageSettingsPrompt === 'ask'"
                :label="optionName(chatText.optionImages(uiLanguage), true)"
                :state="chatText.optionImagesState(uiLanguage, gateway.currentSessionImageSettingsPrompt)"
                :title="chatText.imagesTitle(uiLanguage, gateway.currentSessionImageSettingsPrompt)"
                :aria-label="chatText.imagesChip(uiLanguage, gateway.currentSessionImageSettingsPrompt)"
                :aria-pressed="gateway.currentSessionImageSettingsPrompt === 'ask'"
                :disabled="!mayChangeSettings"
                @click="toggleImageSettingsPrompt"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="3" y="4" width="18" height="16" rx="2" />
                  <circle cx="8.5" cy="9.5" r="1.5" />
                  <path d="m21 16-5-5L5 20" />
                </svg>
              </OrbNode>
            </div>
            <button
              v-else
              @click="toggleImageSettingsPrompt"
              :disabled="!mayChangeSettings"
              class="btn-brand-ghost px-3 py-3 rounded-2xl shrink-0 transition-colors text-xs font-semibold inline-flex items-center gap-1.5"
              :class="gateway.currentSessionImageSettingsPrompt === 'auto' ? 'opacity-60 hover:opacity-100' : 'opacity-80 hover:opacity-100'"
              :title="chatText.imagesTitle(uiLanguage, gateway.currentSessionImageSettingsPrompt)"
              :aria-label="chatText.imagesChip(uiLanguage, gateway.currentSessionImageSettingsPrompt)"
              :aria-pressed="gateway.currentSessionImageSettingsPrompt === 'ask'"
            >
              <svg class="multimodal-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <circle cx="8.5" cy="9.5" r="1.5" />
                <path d="m21 16-5-5L5 20" />
              </svg>
              <span>{{ chatText.imagesChip(uiLanguage, gateway.currentSessionImageSettingsPrompt) }}</span>
            </button>

            <!-- Thinking: its state in words, like the Images button beside it. Glow alone carried
                 it before, and "auto" and "off" were two shades of dim. -->
            <div
              v-if="optionsDocked"
              :class="optionClass('thinking')"
              :style="optionStyle('thinking')"
              @pointerenter="wakeControl('thinking')"
              @pointerleave="restControl('thinking')"
              @focusin="wakeControl('thinking')"
              @focusout="restControl('thinking')"
            >
              <OrbNode
                side="below"
                docked
                :lit="thinkingMode === true"
                :idle="thinkingMode === false"
                :label="optionName(chatText.optionThinking(uiLanguage), true)"
                :state="chatText.optionThinkingState(uiLanguage, thinkingMode)"
                :title="chatText.thinkingTitle(uiLanguage, thinkingMode)"
                :aria-label="chatText.thinkingChip(uiLanguage, thinkingMode)"
                :aria-pressed="thinkingMode === true"
                @click="cycleThinkingMode"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.44-3.16Z" />
                  <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.44-3.16Z" />
                </svg>
              </OrbNode>
            </div>
            <button
              v-else
              type="button"
              @click="cycleThinkingMode"
              class="btn-brand-ghost px-3 py-3 rounded-2xl shrink-0 transition-colors text-xs font-semibold inline-flex items-center gap-1.5"
              :class="thinkingMode === true
                ? 'multimodal-action-active thinking-toggle--on'
                : thinkingMode === false
                  ? 'opacity-40 border-dashed'
                  : 'opacity-60 hover:opacity-100'"
              :title="chatText.thinkingTitle(uiLanguage, thinkingMode)"
              :aria-label="chatText.thinkingChip(uiLanguage, thinkingMode)"
              :aria-pressed="thinkingMode === true"
            >
              <svg class="multimodal-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.44-3.16Z" />
                <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.44-3.16Z" />
              </svg>
              <span>{{ chatText.thinkingChip(uiLanguage, thinkingMode) }}</span>
            </button>
          </div>

          <div class="chat-composer__primary-actions" :class="gateway.isLoading ? 'chat-composer__primary-actions--running' : ''">
            <!-- While a turn runs: Stop, and Steer where Send stood — it sends the composer into
                 the turn, the same as Enter, for anyone not on a keyboard. In Send's place, a
                 second click on Send lands on Steer and never on Stop. Both are as wide as their
                 word: two buttons of Send's width did not fit the row, Steer lay on the chips and
                 Stop hung out of the bay. Stopping turns Stop's square into a spinner, at the
                 same width. -->
            <button
              v-if="gateway.isLoading"
              type="button"
              :disabled="stoppingTurn"
              :aria-busy="stoppingTurn"
              :aria-label="stoppingTurn ? chatText.stopping(uiLanguage) : undefined"
              @click="stopTurn"
              class="chat-stop px-4 py-3 rounded-2xl text-sm shrink-0 font-semibold transition-colors bg-red-600/80 hover:bg-red-500/90 border border-red-400/40 text-white disabled:opacity-60 disabled:cursor-progress"
              :title="stoppingTurn ? chatText.stopping(uiLanguage) : chatText.stopTitle(uiLanguage)"
            >
              <span class="chat-stop__glyph" :class="stoppingTurn ? 'chat-stop__glyph--busy' : ''" aria-hidden="true"></span>
              <span>{{ chatText.stop(uiLanguage) }}</span>
            </button>
            <button
              v-if="gateway.isLoading"
              @click="sendMessage"
              :disabled="!composerHasContent || !gateway.connected || readOnly"
              class="btn-brand-ghost px-4 py-3 rounded-2xl text-sm shrink-0 font-semibold"
              :title="sendBlockedReason || chatText.steerTitle(uiLanguage)"
            >
              {{ chatText.steer(uiLanguage) }}
            </button>
            <button
              v-else
              @click="sendMessage"
              :disabled="!composerHasContent || !gateway.connected || readOnly"
              class="btn-grad px-5 py-3 rounded-2xl text-sm shrink-0"
              :title="sendBlockedReason || undefined"
            >
              {{ chatText.send(uiLanguage) }}
            </button>
          </div>
        </div>
      </div>

      <div v-if="readOnly" class="text-xs text-gray-500 mt-1 px-1" role="note">
        {{ chatText.viewerReadOnly(uiLanguage) }}
      </div>
      <div v-else class="text-xs text-gray-500 mt-1 px-1">
        {{ chatText.guardrailsLine(uiLanguage) }} <code class="font-mono whitespace-nowrap">--auto</code> <code class="font-mono whitespace-nowrap">--iter N</code> <code class="font-mono whitespace-nowrap">--agent NAME</code> <code class="font-mono whitespace-nowrap">--timeout N</code> <code class="font-mono whitespace-nowrap">--effort TIER</code>
      </div>
    </div>
    </div>

    <!-- The message input's control: what is left on the page when the input bay has flown out.
         Click it, or just start typing, to summon the bay. On a wide window it stands at the front
         of the controls' orbit, under the orb. -->
    <Teleport to="body">
    <Transition name="composer-launcher">
      <div
        v-if="!composerOpen && gateway.connected"
        class="orb-control orb-control--message"
        :class="controlsDocked ? 'orb-control--docked' : ''"
        :style="messageControlStyle"
      >
        <OrbNode
          side="below"
          :docked="controlsDocked"
          :label="controlLabelled.message ? chatText.nodeMessage(uiLanguage) : ''"
          :title="chatText.launcherTitle(uiLanguage, product.name, !controlsDocked)"
          :aria-label="chatText.launcherLabel(uiLanguage)"
          @pointerdown="launcherOrbDown"
          @pointermove="launcherOrbMove"
          @pointerup="launcherOrbUp"
          @click="onLauncherClick"
          @pointerenter="wakeControl('message')"
          @pointerleave="restControl('message')"
          @focus="wakeControl('message')"
          @blur="restControl('message')"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 11.5a8.38 8.38 0 0 1-9 8.35 8.5 8.5 0 0 1-3.4-.7L3 21l1.85-5.6A8.38 8.38 0 0 1 12.5 3a8.5 8.5 0 0 1 8.5 8.5z" />
            <path d="M8 10h8" /><path d="M8 13.5h5" />
          </svg>
        </OrbNode>
      </div>
    </Transition>
    </Teleport>
  </div>

  <!-- Image preview modal -->
  <Teleport to="body">
    <Transition name="hud-pop">
    <div
      v-if="previewModalUrl"
      ref="previewModalEl"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Image preview"
      @click.self="previewModalUrl = null"
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
    </Transition>
  </Teleport>

  <!-- A settings card's full form. Drawn by the page, not by the card: a message sent mid-turn
       re-mounts the card in a new segment, and the form must not lose what was typed or painted. -->
  <ImageSettingsModal
    v-if="configuringImageRequest"
    :key="configuringImageRequest.request.inputId"
    :request="configuringImageRequest.request"
    :payload="configuringImageRequest.payload"
    :always-auto="gateway.currentSessionImageSettingsPrompt === 'auto'"
    :language="activeStreamingMessage ? orbLanguage : uiLanguage"
    @close="gateway.closeUserInputForm()"
  />
</template>

<script setup lang="ts">
import { ref, reactive, computed, nextTick, watch, onMounted, onUnmounted, onBeforeUnmount, defineAsyncComponent } from "vue";
import { useRouter } from "vue-router";
import { useStorage } from "@vueuse/core";
import { sanitizeAssistantMessageContent, useGatewayStore } from "@/stores/gateway";
import { useAgentsStore } from "@/stores/agents";
import { useJobsStore } from "@/stores/jobs";
import { useScenesStore } from "@/stores/scenes";
import { useMultimodalStore } from "@/stores/multimodal";
import { useComputerStore } from "@/stores/computer";
import { useShellStore } from "@/stores/shell";
import type { GatewaySessionTranscriptMessage, InterventionAction, EffortTier } from "@/stores/gateway";
import { marked } from "marked";
import { useVoice, type RecordingOutcome } from "@/speech/useVoice";
import MessageBubble from "@/components/MessageBubble.vue";
import StepDetailPanel from "@/components/StepDetailPanel.vue";
import OrbActivity from "@/components/OrbActivity.vue";
import OrbNode from "@/components/OrbNode.vue";
import { activityRing, freeHalfWidth, liveActivity } from "@/composables/orbActivity";
import {
  controlLayout, optionLabelLines, optionStations, optionsFit, optionsFloor, starterLayout, stationBox, stepLabelFloor,
  type ControlId,
} from "@/composables/orbControls";
import { turnLanguage } from "@/composables/turnText";
import { detectLanguage } from "@/speech/speechText";
import UserInputCard from "@/components/input/UserInputCard.vue";
import ImageSettingsModal from "@/components/input/ImageSettingsModal.vue";
import { chatStarters, startersVisible } from "@/composables/chatStarters";
import { readImageSettingsPayload } from "@/composables/imageSettings";
import { formatCountdown, remainingMs } from "@/composables/userInputs";
import { stepsFor } from "@/composables/turnSteps";
import { followFocusedStep, latestTurn } from "@/composables/turnSegments";
import { useEscapeToClose } from "@/composables/useEscapeToClose";
import { useFocusTrap } from "@/composables/useFocusTrap";
import { confirmAction } from "@/composables/useConfirm";
import { browserLanguage, chatText } from "@/composables/chatText";
import { podLanes } from "@/composables/podLanes";
import { followGrowth, LANDING_FOLLOW_MS } from "@/composables/scrollFollow";
import SwarmStatusPanel from "@/components/SwarmStatusPanel.vue";
import ComputerSessionPanel from "@/components/ComputerSessionPanel.vue";
import ShellSessionPanel from "@/components/ShellSessionPanel.vue";
import SidePanel from "@/components/SidePanel.vue";
import type { ChatAttachment } from "@/stores/gateway";
import { useProductStore } from "@/stores/product";
import { forbiddenReason } from "@/composables/rpcErrors";
import type { TurnLanguage } from "@/composables/turnText";

// Product name comes from GET /api/product so a fork rebrands without editing this
// file (docs/fork-boilerplate-plan.md WS1).
const product = useProductStore();

const OrbCanvas = defineAsyncComponent(() => import("@/components/OrbCanvas.vue"));

const gateway = useGatewayStore();
const agentsStore = useAgentsStore();
const jobsStore = useJobsStore();
const scenesStore = useScenesStore();
const multimodalStore = useMultimodalStore();
const computerStore = useComputerStore();
const shellStore = useShellStore();
const router = useRouter();
const inputText = ref("");
const steeringNote = ref("");   // transient note shown after a mid-turn steering message is sent
// A note that something did NOT happen is not a green one, and it stays longer: it used to wear
// the colour of success and vanish after six seconds like the rest.
const steeringNoteTone = ref<"ok" | "error">("ok");
let steeringNoteTimer: number | null = null;
function showSteeringNote(text: string, tone: "ok" | "error" = "ok"): void {
  // One timer for the note, so an earlier note's timeout cannot clear a later one early.
  if (steeringNoteTimer !== null) window.clearTimeout(steeringNoteTimer);
  steeringNote.value = text;
  steeringNoteTone.value = tone;
  steeringNoteTimer = window.setTimeout(() => {
    steeringNote.value = "";
    steeringNoteTimer = null;
  }, tone === "error" ? 15_000 : 6000);
}
const sessionIdCopied = ref(false); // transient "Copied!" feedback for the session-id click-to-copy

/** Copy the full current session id to the clipboard (clicking the shortened id). */
async function copySessionId(): Promise<void> {
  const id = gateway.currentSessionId;
  if (!id) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(id);
    } else {
      const textarea = document.createElement("textarea");
      textarea.value = id;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
    sessionIdCopied.value = true;
    window.setTimeout(() => { sessionIdCopied.value = false; }, 1500);
  } catch {
    // Clipboard blocked (e.g. insecure context) — leave the id visible for manual copy.
  }
}
const composerTextareaEl = ref<HTMLTextAreaElement | null>(null);
const messagesEl = ref<HTMLElement | null>(null);
const fileInputEl = ref<HTMLInputElement | null>(null);
const audioInputEl = ref<HTMLInputElement | null>(null);
/** The spoken answer's text, opened under the voice bar. */
const replyTextOpen = ref(false);
const multimodalBusy = ref(false);
const wakeListening = ref(false);
const wakeStatus = ref("Voice idle");
const wakeFeedbackState = ref<"idle" | "listening" | "recording" | "processing" | "success" | "error">("idle");
const wakeFeedbackMessage = ref("");
const wakeKeywords = useStorage<string[]>("gc_wake_keywords", ["Hey Guarded", "Okay Guarded", "Luna"]);
const wakeStopPhrases = useStorage<string[]>("gc_wake_stop_phrases", ["stop recording", "end recording", "stop listening", "luna stop"]);
const wakeLanguage = useStorage<string>("gc_wake_language", "en-US");
const wakeSilenceTimeoutMs = useStorage<number>("gc_wake_silence_ms", 4000);
const exportingTranscript = ref(false);
/** Per-message thinking toggle for models that support enable_thinking: undefined = auto, true = on, false = off */
const thinkingMode = ref<boolean | undefined>(undefined);
/** Images queued for the current composer message — analyzed and sent together on submit. */
const pendingImageContexts = ref<Array<{ filename: string; file: File; previewUrl: string }>>([]);
/** Documents queued for the current composer message — persisted + ingested into
 *  the engram document library on submit (not inlined into the prompt). */
const pendingDocumentContexts = ref<Array<{ filename: string; file: File }>>([]);
const composerHasContent = computed(() =>
  Boolean(inputText.value.trim()) || pendingImageContexts.value.length > 0 || pendingDocumentContexts.value.length > 0);
const starters = chatStarters(navigator.language);
// The composer belongs to no message: its labels follow the browser, like the starters above it.
const uiLanguage = browserLanguage();
// "/ for commands" only where there are commands: scenes or jobs to run by name.
const composerPlaceholder = computed(() =>
  chatText.messagePlaceholder(uiLanguage, product.name, gateway.scenes.length > 0 || configuredJobs.value.length > 0));
// A disabled control says why. The field, Send, and the scene and job buttons were greyed out
// while the dashboard was not connected, or a turn ran, with nothing to tell the two apart.
const offlineReason = computed(() => {
  if (gateway.connected) return "";
  return gateway.connecting || gateway.reconnecting
    ? chatText.notConnectedConnecting(uiLanguage)
    : chatText.notConnectedSignIn(uiLanguage);
});
/**
 * Why this connection may not send at all, or "": its role may not call chat.send (a viewer, or an
 * extension role below operator), as the gateway listed the methods it may call at the handshake.
 */
const readOnlyReason = computed(() => (gateway.mayCall("chat.send") ? "" : chatText.viewerReadOnly(uiLanguage)));
const readOnly = computed(() => readOnlyReason.value !== "");
/** Whether the session's effort and image settings may be changed from here. */
const mayChangeSettings = computed(() => gateway.mayCall("session.updateSettings"));
/** Why nothing can be typed, for the field's placeholder — or "" while it can. */
const composerBlockedReason = computed(() =>
  offlineReason.value || readOnlyReason.value || (gateway.pendingInputRequest ? chatText.answerQuestionFirst(uiLanguage) : ""));
/** Why Send (or Steer) is disabled, or "". */
const sendBlockedReason = computed(() =>
  offlineReason.value || readOnlyReason.value || (composerHasContent.value ? "" : chatText.sendNeedsMessage(uiLanguage)));
/** Why a scene or job cannot be started from its button right now, or "". */
function startBlockedReason(kind: "scene" | "job", running: boolean): string {
  if (offlineReason.value) return offlineReason.value;
  if (readOnlyReason.value) return readOnlyReason.value;
  if (running) return kind === "scene" ? chatText.sceneRunning(uiLanguage) : chatText.jobRunning(uiLanguage);
  return gateway.isLoading ? chatText.waitForTurn(uiLanguage) : "";
}
/** A scene or job button's tooltip: the reason it is disabled first, then what it does. */
function startButtonTitle(description: string | undefined, reason: string): string | undefined {
  if (!reason) return description;
  return description ? `${reason}\n${description}` : reason;
}
const showStarters = computed(() => !readOnly.value && startersVisible({
  connected: gateway.connected,
  transcriptLoading: gateway.currentSessionTranscriptLoading,
  turnRunning: gateway.isLoading,
  questionOpen: gateway.hasOpenUserInput || Boolean(gateway.pendingInputRequest),
  messageCount: gateway.messages.length,
  composerOpen: composerOpen.value,
  composerHasContent: composerHasContent.value,
}));
/** The Options <details> element, so attaching a file can close it. */
const optionsDetailsEl = ref<HTMLDetailsElement | null>(null);
const previewModalUrl = ref<string | null>(null);
useEscapeToClose(() => previewModalUrl.value !== null, () => { previewModalUrl.value = null; });
const previewModalEl = ref<HTMLElement | null>(null);
useFocusTrap(previewModalEl);
const expandedMessageHistory = ref(false);
const approvalNowMs = ref(Date.now());
let approvalClockId: number | null = null;

const approvalRemainingMs = computed(() => {
  const expiresAt = gateway.pendingApproval?.expiresAt;
  if (!expiresAt) return null;
  const expiresAtMs = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiresAtMs)) return null;
  return Math.max(0, expiresAtMs - approvalNowMs.value);
});

const approvalCountdownLabel = computed(() => {
  const remaining = approvalRemainingMs.value;
  if (remaining === null) return "";
  if (remaining <= 0) return "Expiring now";
  return `Expires in ${formatApprovalCountdown(remaining)}`;
});

// The ask_user banner counts down to the server's deadline too; past it, the server stops waiting
// for an answer and the store takes the banner away.
const inputRequestCountdownLabel = computed(() => {
  const left = remainingMs(gateway.pendingInputRequest?.expiresAt, approvalNowMs.value);
  return left === null ? "" : `Expires in ${formatCountdown(left)}`;
});

/** The settings card whose full form is open, with its payload read — or null. */
const configuringImageRequest = computed(() => {
  const id = gateway.configuringUserInputId;
  const request = id ? gateway.userInputs[id] : undefined;
  const payload = request?.kind === "image_settings" ? readImageSettingsPayload(request.payload) : null;
  return request && payload ? { request, payload } : null;
});

function toggleImageSettingsPrompt(): void {
  void gateway.updateSessionSettings({
    imageSettingsPrompt: gateway.currentSessionImageSettingsPrompt === "auto" ? "ask" : "auto",
  });
}

function formatApprovalCountdown(value: number): string {
  const totalSeconds = Math.max(0, Math.ceil(value / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

/** Live estimate of context window usage based on last known prompt tokens + current input. */
/** "… attached — click Send" stands only while something is attached. */
let attachedNotice = "";
function clearAttachedNotice(): void {
  if (pendingImageContexts.value.length === 0 && pendingDocumentContexts.value.length === 0 && attachedNotice !== "" && wakeStatus.value === attachedNotice) {
    wakeStatus.value = "Voice idle";
  }
}

function removeImage(idx: number) {
  const img = pendingImageContexts.value[idx];
  if (img) URL.revokeObjectURL(img.previewUrl);
  pendingImageContexts.value.splice(idx, 1);
  clearAttachedNotice();
}

function removeDocument(idx: number) {
  pendingDocumentContexts.value.splice(idx, 1);
  clearAttachedNotice();
}

// Stop says it is stopping. The request takes a moment, and the button used to sit there
// unchanged meanwhile — so it got clicked again and again.
const stoppingTurn = ref(false);
async function stopTurn(): Promise<void> {
  if (stoppingTurn.value) return;
  stoppingTurn.value = true;
  try {
    await gateway.cancelTurn();
  } catch (err) {
    showSteeringNote(chatText.couldNotStop(uiLanguage, err instanceof Error ? err.message : String(err)), "error");
  } finally {
    stoppingTurn.value = false;
  }
}
watch(() => gateway.isLoading, (loading) => { if (!loading) stoppingTurn.value = false; });

// The composer's menus are native <details>: they stayed open on a click anywhere else and
// ignored Escape, so one could be left hanging over the conversation. A press outside closes
// them; Escape closes them through the same layered handler as every other overlay.
function openComposerMenus(): HTMLDetailsElement[] {
  return [...document.querySelectorAll<HTMLDetailsElement>(".chat-input-bay details.chat-dropdown[open]")];
}
function closeComposerMenus(except?: Element | null): void {
  for (const menu of openComposerMenus()) if (menu !== except) menu.open = false;
}
const composerMenuOpen = ref(false);
/** What the input bay offers beside its field: three menus and two switches. */
type OptionId = "options" | "jobs" | "effort" | "images" | "thinking";
/** Which of the menus is open, by its option: on the orbit its node turns into the way out. */
const openMenus = reactive({ options: false, jobs: false, effort: false });
function onComposerMenuToggle(event?: Event): void {
  composerMenuOpen.value = openComposerMenus().length > 0;
  const menu = event?.target instanceof HTMLDetailsElement ? event.target : null;
  const option = menu?.dataset["option"];
  if (menu && (option === "options" || option === "jobs" || option === "effort")) openMenus[option] = menu.open;
}
function onDocumentPointerDown(event: PointerEvent): void {
  if (!composerMenuOpen.value) return;
  const inside = (event.target as Element | null)?.closest?.("details.chat-dropdown") ?? null;
  closeComposerMenus(inside);
  composerMenuOpen.value = openComposerMenus().length > 0;
}
onMounted(() => document.addEventListener("pointerdown", onDocumentPointerDown));
onUnmounted(() => document.removeEventListener("pointerdown", onDocumentPointerDown));
useEscapeToClose(() => composerMenuOpen.value, () => { closeComposerMenus(); composerMenuOpen.value = false; });

/** Close the Options dropdown (a native <details>) — used after picking a file. */
function closeOptionsDropdown() {
  if (optionsDetailsEl.value) optionsDetailsEl.value.open = false;
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

// ── Effort selector ──────────────────────────────────────────────────────────
const EFFORT_TIERS: EffortTier[] = ["low", "medium", "high", "max"];
const currentEffort = computed<EffortTier>(() => gateway.currentSessionEffort);
const effortButtonClass = computed(() => {
  switch (currentEffort.value) {
    case "max": return "multimodal-action-active thinking-toggle--on ring-1 ring-amber-400/60";
    case "high": return "multimodal-action-active thinking-toggle--on";
    case "low": return "opacity-50 border-dashed";
    default: return "opacity-70 hover:opacity-100"; // medium
  }
});
const effortDetailsEl = ref<HTMLDetailsElement | null>(null);
function chooseEffort(tier: EffortTier): void {
  if (effortDetailsEl.value) effortDetailsEl.value.open = false;
  if (tier !== currentEffort.value) void gateway.updateSessionSettings({ effort: tier });
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
let wakeFeedbackTimer: number | null = null;

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

// ── The page's round controls: the session, its actions, the message input ──────────────────
// On a window wide enough for the orb to have a zone of its own (the messages stand at its
// sides) they stand on an orbit round the orb, in its own space (composables/orbControls.ts):
// the canvas draws each one's gimbal there, the page its glyph. Below that the messages lie over
// the orb, and the controls are parked at the page's edge, where they can be dragged anywhere; a
// short pointer movement still counts as a click. Parked positions are stored as viewport
// FRACTIONS so they realign on window resize.
const hudWin = ref({ w: 1920, h: 1080 });
function syncHudWin() { hudWin.value = { w: window.innerWidth, h: window.innerHeight }; }
onMounted(() => { syncHudWin(); window.addEventListener("resize", syncHudWin); });
onUnmounted(() => window.removeEventListener("resize", syncHudWin));
/** From this width the messages stand beside the orb (the page's CSS and OrbActivity share it). */
const controlsDocked = computed(() => hudWin.value.w >= 1100);
/** A parked control's face in pixels: the session's and the actions', and the message input's larger one. */
const PARKED_SIZE = 42;
const PARKED_MESSAGE_SIZE = 54;

function useDraggableOrb(storageKey: string, defaultFrac: { fx: number; fy: number }, size: number) {
  const frac = ref({ ...defaultFrac });
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null") as { fx: number; fy: number } | null;
    if (saved && typeof saved.fx === "number" && typeof saved.fy === "number") frac.value = saved;
  } catch { /* ignore broken storage */ }

  let pointerActive = false;
  let moved = false;
  let startX = 0, startY = 0, origX = 0, origY = 0;
  let captureEl: HTMLElement | null = null;
  let capturePointer = 0;

  const x = computed(() => Math.min(Math.max(frac.value.fx * hudWin.value.w, 8), hudWin.value.w - size - 10));
  const y = computed(() => Math.min(Math.max(frac.value.fy * hudWin.value.h, 68), hudWin.value.h - size - 10));
  const style = computed(() => ({ left: `${x.value}px`, top: `${y.value}px` }));

  function down(event: PointerEvent) {
    moved = false;
    // On its orbit a control stays where it stands.
    if (controlsDocked.value) return;
    pointerActive = true;
    startX = event.clientX; startY = event.clientY;
    origX = x.value; origY = y.value;
    // Capture immediately for reliable fast drags. The handlers live on the
    // toggle button itself, so the retargeted click still lands on the
    // element that owns @click — capturing on a wrapper would kill it.
    captureEl = event.currentTarget as HTMLElement;
    capturePointer = event.pointerId;
    try { captureEl.setPointerCapture(capturePointer); } catch { /* synthetic events */ }
  }
  function move(event: PointerEvent) {
    if (!pointerActive) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (!moved && Math.abs(dx) + Math.abs(dy) > 6) moved = true;
    if (moved) {
      frac.value = {
        fx: (origX + dx) / hudWin.value.w,
        fy: (origY + dy) / hudWin.value.h,
      };
    }
  }
  function up() {
    pointerActive = false;
    if (moved) {
      try { localStorage.setItem(storageKey, JSON.stringify(frac.value)); } catch { /* full/blocked */ }
    }
  }
  const wasDragged = () => moved;
  return { x, y, style, down, move, up, wasDragged };
}

const {
  x: actionsOrbX, y: actionsOrbY, style: actionsOrbStyle,
  down: actionsOrbDown, move: actionsOrbMove, up: actionsOrbUp,
  wasDragged: actionsOrbDragged,
} = useDraggableOrb("starlingai.hud.actionsOrb", { fx: 0.955, fy: 0.09 }, PARKED_SIZE);

const {
  x: sessionOrbX, style: sessionOrbStyle,
  down: sessionOrbDown, move: sessionOrbMove, up: sessionOrbUp,
  wasDragged: sessionOrbDragged,
} = useDraggableOrb("starlingai.hud.sessionOrb", { fx: 0.955, fy: 0.17 }, PARKED_SIZE);

const {
  x: launcherOrbX, style: launcherOrbStyle,
  down: launcherOrbDown, move: launcherOrbMove, up: launcherOrbUp,
  wasDragged: launcherOrbDragged,
} = useDraggableOrb("starlingai.hud.launcherOrb", { fx: 0.95, fy: 0.92 }, PARKED_MESSAGE_SIZE);

// Where the controls stand on their orbit for this window, and each one's box on the page: its
// station there, or the place it is parked at.
const controlStations = computed(() => controlLayout(hudWin.value.w, hudWin.value.h, freeHalfWidth(hudWin.value.w, hudWin.value.h, 16, 0)));
function controlStyle(id: ControlId, parked: { left: string; top: string }, parkedSize: number): Record<string, string> {
  if (!controlsDocked.value) return { ...parked, width: `${parkedSize}px`, height: `${parkedSize}px`, "--node-size": `${parkedSize}px` };
  const station = controlStations.value.stations.find((candidate) => candidate.id === id)!;
  const box = stationBox(station, hudWin.value.w, hudWin.value.h);
  return {
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.size}px`,
    height: `${box.size}px`,
    "--node-size": `${box.size}px`,
    // What a menu hanging from the control's top has of the window's height below it.
    "--panel-room": `${Math.max(160, hudWin.value.h - box.top - 12)}px`,
  };
}
/** Which controls carry their name beside them: the ones with room for it (orbControls.ts). */
const controlLabelled = computed(() => Object.fromEntries(
  controlStations.value.stations.map((station) => [station.id, station.labelled]),
) as Record<ControlId, boolean>);
/**
 * The session's and the actions' controls: on the orbit or parked; and behind the page while one
 * of the input bay's menus is open. Such a menu, hung from an option on the orbit, opens up past
 * them, and they are teleported out of the page's own stacking order, above all of it — the
 * session's name lay across the menu's first row.
 */
const controlClass = computed(() => [
  controlsDocked.value ? "orb-control--docked" : "",
  composerMenuOpen.value ? "orb-control--under" : "",
]);
const sessionControlStyle = computed(() => controlStyle("session", sessionOrbStyle.value, PARKED_SIZE));
const actionsControlStyle = computed(() => controlStyle("actions", actionsOrbStyle.value, PARKED_SIZE));
const messageControlStyle = computed(() => controlStyle("message", launcherOrbStyle.value, PARKED_MESSAGE_SIZE));

// ── Lanes for these buttons (composables/podLanes.ts) ─────────────────────────────────────
// The messages stand at their column's outer edges, which is where the buttons are parked: a
// long question ran under the one beside it. Each side keeps a lane free for the buttons at it,
// as wide as the innermost of them. The composer's button counts while it is hidden too, or the
// messages would jump sideways whenever the composer opens.
const messagesColumn = ref({ left: 0, right: 0 });
function measureMessagesColumn(): void {
  const box = messagesEl.value?.getBoundingClientRect();
  if (!box || (box.left === messagesColumn.value.left && box.right === messagesColumn.value.right)) return;
  messagesColumn.value = { left: box.left, right: box.right };
}
let messagesColumnObserver: ResizeObserver | null = null;
watch(messagesEl, (element) => {
  messagesColumnObserver?.disconnect();
  messagesColumnObserver = null;
  if (!element) return;
  measureMessagesColumn();
  if (typeof ResizeObserver === "undefined") return;
  messagesColumnObserver = new ResizeObserver(measureMessagesColumn);
  messagesColumnObserver.observe(element);
}, { immediate: true, flush: "post" });
watch(hudWin, measureMessagesColumn, { flush: "post" });
onUnmounted(() => messagesColumnObserver?.disconnect());
// On their orbit the controls are in the orb's zone, which the messages keep clear of anyway.
const podLaneWidths = computed(() => (controlsDocked.value ? { left: 0, right: 0 } : podLanes([
  { x: actionsOrbX.value, size: PARKED_SIZE },
  { x: sessionOrbX.value, size: PARKED_SIZE },
  { x: launcherOrbX.value, size: PARKED_MESSAGE_SIZE },
], messagesColumn.value)));
const podLaneStyle = computed(() => ({
  "--pod-lane-l": `${podLaneWidths.value.left}px`,
  "--pod-lane-r": `${podLaneWidths.value.right}px`,
}));
/** The wider of the two: what the orb's ring and its labels allow for (composables/orbActivity.ts). */
const podLane = computed(() => Math.max(podLaneWidths.value.left, podLaneWidths.value.right));

const sessionOpen = ref(false);
// A menu opens away from the orb when its control stands on the orbit (the session's to the left,
// the actions' to the right), and towards the middle of the screen from wherever a parked one was
// dragged to.
const sessionPodLeft = computed(() => (controlsDocked.value ? true : sessionOrbX.value > hudWin.value.w / 2));
const actionsPodLeft = computed(() => (controlsDocked.value ? false : actionsOrbX.value > hudWin.value.w / 2));
const actionsPodUp = computed(() => !controlsDocked.value && actionsOrbY.value > hudWin.value.h / 2);

// Which control or option the pointer or the keyboard is on: the canvas quickens that one's gimbal.
const wokenControl = ref<ControlId | OptionId | null>(null);
function wakeControl(id: ControlId | OptionId): void { wokenControl.value = id; }
function restControl(id: ControlId | OptionId): void { if (wokenControl.value === id) wokenControl.value = null; }
/** A parked control can be dragged, and says so; one on the orbit carries its name beside it. */
function controlTitle(name: string): string {
  return controlsDocked.value ? name : `${name} ${chatText.nodeDragHint(uiLanguage)}`;
}

// Disconnecting unmounts the controls; make sure their menus don't reopen in a
// stale-open state when the connection returns.
watch(() => gateway.connected, (connected) => {
  if (!connected) {
    actionsOpen.value = false;
    sessionOpen.value = false;
  }
});

function onActionsToggleClick() {
  if (!actionsOrbDragged()) actionsOpen.value = !actionsOpen.value;
}
function onSessionToggleClick() {
  if (!sessionOrbDragged()) sessionOpen.value = !sessionOpen.value;
}
function onLauncherClick() {
  if (!launcherOrbDragged()) openComposer();
}

// The session actions' menu: a list of its tools beside the control.
const actionsOpen = ref(false);
const actionsMenuEl = ref<HTMLElement | null>(null);
useEscapeToClose(() => actionsOpen.value, () => { actionsOpen.value = false; });
useEscapeToClose(() => sessionOpen.value, () => { sessionOpen.value = false; });
// The list takes the keyboard when it opens, and the arrow keys walk it.
watch(actionsOpen, (open) => {
  if (open) void nextTick(() => actionsMenuEl.value?.querySelector<HTMLElement>("button:not(:disabled)")?.focus({ preventScroll: true }));
});
function onActionsMenuKeydown(event: KeyboardEvent): void {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
  const items = [...(actionsMenuEl.value?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? [])];
  if (items.length === 0) return;
  event.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next = event.key === "Home" ? 0
    : event.key === "End" ? items.length - 1
    : (at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
  items[next]!.focus();
}

interface SessionAction {
  key: string; glyph: string; label: string; hint: string;
  disabled?: boolean; disabledReason?: string; danger?: boolean; run: () => void;
}

/** What can be done with the session on the page; nothing where there is none. */
const sessionActions = computed((): SessionAction[] => {
  if (!gateway.currentSessionId) return [];
  const l = uiLanguage;
  const busy = exportingTranscript.value;
  const noMessages = gateway.messages.length === 0;
  const whyNot = busy ? chatText.exportRunning(l) : chatText.nothingToExport(l);
  // What this connection's role may not do (a viewer may not archive or reset a session) is
  // offered greyed, with the reason, as the composer is.
  const unlessMay = (method: string): Partial<SessionAction> =>
    gateway.mayCall(method) ? {} : { disabled: true, disabledReason: chatText.notForYourRole(l) };
  return [
    { key: "md",    glyph: "MD",  label: chatText.markdownTitle(l), hint: chatText.actionMarkdownHint(l), disabled: noMessages || busy, disabledReason: whyNot, run: () => { void exportMarkdown(); } },
    { key: "pdf",   glyph: "PDF", label: chatText.pdfTitle(l),      hint: chatText.actionPdfHint(l),      disabled: noMessages || busy, disabledReason: whyNot, run: () => { void exportPDF(); } },
    { key: "debug", glyph: "DBG", label: chatText.actionDebug(l),   hint: chatText.actionDebugHint(l),    disabled: busy, disabledReason: whyNot, run: () => { void exportDebugMarkdown(); } },
    { key: "audit", glyph: "AUD", label: chatText.actionAudit(l),   hint: chatText.actionAuditHint(l),    disabled: busy, disabledReason: whyNot, run: () => { void exportAuditMarkdown(); } },
    { key: "arch",  glyph: "ARC", label: chatText.actionArchive(l), hint: chatText.actionArchiveHint(l),  ...unlessMay("session.archive"), run: () => { void archiveCurrentSession(); } },
    { key: "reset", glyph: "RST", label: chatText.actionReset(l),   hint: chatText.actionResetHint(l), danger: true, ...unlessMay("session.reset"), run: () => { void resetSession(); } },
  ];
});
/**
 * Why the session's menu offers no new session, or "": this connection's role may not call
 * session.create (a viewer). The entry is greyed with the reason, as the session actions are.
 */
const newSessionBlockedReason = computed(() =>
  gateway.mayCall("session.create") ? "" : chatText.notForYourRole(uiLanguage));
/** From the session's menu: a fresh conversation. */
function startNewSession(): void {
  if (newSessionBlockedReason.value) return;
  sessionOpen.value = false;
  void gateway.createSession();
}

const compactComposer = computed(() => gateway.isLoading || analysing.value);

// HUD input bay: the whole input area flies out of view while idle and is
// summoned back via the message input's control (or by typing). A drafted message, focus,
// attachments, or a running turn keep it open.
const composerOpen = ref(false);
const composerFocused = ref(false);
// While an ask_user question is pending, the QUESTION card IS the input surface (choices +
// free-text + Send). The floating steering bay is disabled anyway, and being fixed/z-215 it
// would float ON TOP of the QUESTION card and obscure its options — so fold it away until the
// question is answered. The bay's control stays hidden too (composerOpen is still true this turn).
const bayOpen = computed(() => composerOpen.value && !gateway.pendingInputRequest);

function openComposer(prefill?: string) {
  composerOpen.value = true;
  if (prefill !== undefined) inputText.value = prefill;
  void nextTick(() => {
    const textarea = composerTextareaEl.value;
    if (textarea) {
      textarea.focus();
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
    }
    adjustComposerHeight();
  });
}

function maybeCloseComposer() {
  if (
    inputText.value.trim() === ""
    && !gateway.isLoading
    && !analysing.value
    && pendingImageContexts.value.length === 0
    && pendingDocumentContexts.value.length === 0
    // The voice bar lives in the bay: while the microphone is open or an answer is read aloud,
    // folding the bay away would take Stop with it.
    && !showVoiceBar.value
  ) {
    composerOpen.value = false;
  }
}

// The bay floats over the page, and its height changes with what is in it (chips, the voice bar,
// two rows of controls on a phone). What has to stay clear of it — the newest message, the "new
// messages" pill, a banner that asks something — reads its height from --bay-h instead of a
// guessed constant, under which the pill and the banners ended up hidden behind the bay.
const bayEl = ref<HTMLElement | null>(null);
let bayObserver: ResizeObserver | null = null;
/** The composer (the field with the options' row under it, or with Send beside it) and its field. */
const composerEl = ref<HTMLElement | null>(null);
const composerFieldEl = ref<HTMLElement | null>(null);
/**
 * The bay as it stands, and as it is without the row of its options: its height while they stand
 * on the orbit. Taken as what is over and under the composer plus the field alone, so it reads
 * the same whichever way the options stand now — measured as "the bay less its row", the two
 * ways disagreed by a rule's worth of pixels, and the options went to and fro for ever.
 */
const bayHeight = ref(0);
const bayHeightSlim = ref(0);
function publishBayHeight(): void {
  const full = bayEl.value?.offsetHeight ?? 0;
  document.documentElement.style.setProperty("--bay-h", `${bayOpen.value ? full : 0}px`);
  bayHeight.value = full;
  const composer = composerEl.value?.offsetHeight ?? 0;
  const field = composerFieldEl.value?.offsetHeight ?? 0;
  bayHeightSlim.value = Math.max(0, full - composer + field);
}
onMounted(() => {
  if (typeof ResizeObserver !== "undefined" && bayEl.value) {
    bayObserver = new ResizeObserver(publishBayHeight);
    bayObserver.observe(bayEl.value);
  }
  publishBayHeight();
});
onUnmounted(() => {
  bayObserver?.disconnect();
  document.documentElement.style.removeProperty("--bay-h");
});
watch(bayOpen, publishBayHeight, { flush: "post" });

// Text can arrive in the input without a keystroke: a restart hands the old question back, a
// dropped audio file or a wake word is transcribed into it. It must not sit there unseen.
watch(inputText, (text) => {
  if (text.trim() !== "" && !composerOpen.value) openComposer();
});

function onComposerFocusOut(event: FocusEvent) {
  const root = event.currentTarget as HTMLElement | null;
  const next = event.relatedTarget as Node | null;
  // Focus left to a native dialog (e.g. the file picker) or to nothing focusable
  // → keep the input bay open. Opening the picker used to collapse the composer
  // and leave the Options dropdown stuck open. Only fold away on a real focus
  // move to an element outside the bay.
  if (next === null) return;
  if (!root?.contains(next)) {
    composerFocused.value = false;
    maybeCloseComposer();
  }
}

// While a turn runs the bay stays open (steering); when it ends and the user
// isn't mid-interaction, it folds away again.
watch(() => gateway.isLoading, (loading) => {
  if (loading) composerOpen.value = true;
  else if (!composerFocused.value) maybeCloseComposer();
});
// The page can be set up while a turn is already running (back from another page): the bay was
// left folded then — Stop and Steer out of sight, and the bay's control standing where the turn's
// status line stands.
if (gateway.isLoading) composerOpen.value = true;

// Typing anywhere on the page starts a message: the bay comes up with the key already in it. A
// "/" therefore still starts a command. It used to be "/" alone, announced only in the control's
// tooltip — every other key did nothing, on a page whose one purpose is to be typed into.
function onGlobalComposerKey(event: KeyboardEvent) {
  if (composerOpen.value || event.defaultPrevented || event.isComposing) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  // One printable character; a space scrolls the page and stays that.
  if (event.key.length !== 1 || event.key === " ") return;
  if (!gateway.connected || gateway.pendingInputRequest) return;
  const target = event.target as HTMLElement | null;
  if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
  // A dialog or a menu that is up owns the keyboard.
  if (document.querySelector("[role='dialog'], [role='alertdialog'], [role='menu'], .app-nav-panel")) return;
  event.preventDefault();
  openComposer(event.key);
}
onMounted(() => window.addEventListener("keydown", onGlobalComposerKey));
onUnmounted(() => window.removeEventListener("keydown", onGlobalComposerKey));

const composerMinHeight = computed(() => compactComposer.value ? 64 : 92);
const composerMaxHeight = computed(() => compactComposer.value ? 160 : 248);
const composerTextareaStyle = computed(() => ({
  minHeight: `${composerMinHeight.value}px`,
  maxHeight: `${composerMaxHeight.value}px`,
}));

function adjustComposerHeight() {
  const textarea = composerTextareaEl.value;
  if (!textarea) return;
  // Measure with the CSS height transition suppressed, then restore the old
  // height before applying the new one so dock/undock (and growth while
  // typing) animate from the real starting point instead of from 0.
  const previous = textarea.style.height;
  textarea.style.transition = "none";
  textarea.style.height = "0px";
  const nextHeight = Math.min(Math.max(textarea.scrollHeight, composerMinHeight.value), composerMaxHeight.value);
  textarea.style.height = previous;
  void textarea.offsetHeight;
  textarea.style.transition = "";
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
  // Connection lost is the only truly frozen state; during the initial
  // handshake stay calm instead of flashing red.
  if (!gateway.connected) return gateway.connecting ? "default" : "criticalError";
  if (gateway.isError || gateway.turnLikelyStalled) return "error";
  // Approval/input/intervention means the AI is idle waiting on the human —
  // show "waiting" (attention), not "activity" (working).
  if (gateway.pendingApproval || gateway.pendingInputRequest || gateway.pendingIntervention || gateway.hasOpenUserInput) {
    return "waiting";
  }
  // The answer read aloud is the assistant talking, as much as tokens arriving.
  if (speechActivity.value?.priority === "reply") return "speaking";
  // Tokens visibly arriving outranks still-unresolved tool calls.
  if (gateway.isStreaming) return "output";
  if (gateway.isLoading || analysing.value || hasRunningToolCalls.value || hasRunningSwarmTasks.value) {
    return "activity";
  }
  if (voicePhase.value === "listening" || voicePhase.value === "hearing" || recordingState.value === "recording") return "listening";
  return "default";
});

// A progress message (its plan, a finished step) is said at the orb while the turn runs, and
// spoken in voice mode; it is not a message of the conversation.
const displayMessages = computed(() => gateway.messages.filter((message) => !message.progress));

// The live turn's clock: durations at the orb tick while a turn runs, and only then.
const liveClock = ref(Date.now());
let liveClockTimer: ReturnType<typeof setInterval> | undefined;
watch(() => Boolean(activeStreamingMessage.value), (running) => {
  if (running && !liveClockTimer) {
    liveClock.value = Date.now();
    liveClockTimer = setInterval(() => { liveClock.value = Date.now(); }, 1000);
  } else if (!running && liveClockTimer) {
    clearInterval(liveClockTimer);
    liveClockTimer = undefined;
  }
}, { immediate: true });
onBeforeUnmount(() => { if (liveClockTimer) clearInterval(liveClockTimer); });
const orbLanguage = computed(() => (activeStreamingMessage.value ? turnLanguage(activeStreamingMessage.value.language ?? null) : uiLanguage));
const orbActivity = computed(() => liveActivity(gateway.messages, liveClock.value, orbLanguage.value));

// The step ring for the orb canvas: the same ring OrbActivity puts the steps on (a track of
// light round the orb), built while a turn runs and the window is wide enough to show the ring.
const viewportWidth = ref(typeof window === "undefined" ? 1600 : window.innerWidth);
const viewportHeight = ref(typeof window === "undefined" ? 900 : window.innerHeight);
function onViewportResize(): void {
  viewportWidth.value = window.innerWidth;
  viewportHeight.value = window.innerHeight;
}
onMounted(() => window.addEventListener("resize", onViewportResize, { passive: true }));
onBeforeUnmount(() => window.removeEventListener("resize", onViewportResize));
const orbRing = computed(() => ({
  ...activityRing(viewportWidth.value, viewportHeight.value, freeHalfWidth(viewportWidth.value, viewportHeight.value, 16, podLane.value)),
  active: Boolean(orbActivity.value) && viewportWidth.value >= 1100,
}));

// ── The start suggestions on their arc ───────────────────────────────────────────────────────
// Where each suggestion of an empty chat stands round the orb on a wide window, and the arc the
// canvas draws under them (composables/orbControls.ts starterLayout).
const starterSpots = computed(() => starterLayout(
  starters.items.length, hudWin.value.w, hudWin.value.h,
  controlStations.value.stations.find((station) => station.id === "message"),
));
function starterStyle(index: number): Record<string, string> {
  const { stations } = starterSpots.value;
  const station = stations[index];
  if (!station) return {};
  // 1 for the suggestion nearest the viewer, less for the ones further round: they are set a
  // little smaller and fainter, as they are further away.
  const depth = station.scale / Math.max(...stations.map((other) => other.scale));
  return {
    left: `calc(50% + ${station.x.toFixed(1)}px)`,
    top: `calc(50% + ${station.y.toFixed(1)}px)`,
    // It flies out from the orb's centre: the front one first, then the ones beside it.
    "--from-x": `${Math.round(-station.x)}px`,
    "--from-y": `${Math.round(-station.y)}px`,
    "--delay": `${Math.round(60 + 70 * Math.abs(index - (stations.length - 1) / 2))}ms`,
    "--depth": depth.toFixed(3),
    "--label-max": `${station.maxWidth}px`,
  };
}
const orbSuggestions = computed(() => {
  if (!controlsDocked.value || !gateway.connected) return null;
  const { orbit, span } = starterSpots.value;
  return { radius: orbit.radius, tilt: orbit.tilt, span, shown: showStarters.value };
});
// The page's controls for the orb canvas, while they stand on their orbit: the canvas draws each
// one's gimbal and its stretch of the orbit (the buttons themselves are the page's). The message
// input's goes while its bay is open; one the pointer is on, or whose menu is open, is awake.
const orbControls = computed(() => {
  if (!controlsDocked.value || !gateway.connected) return null;
  const { orbit, stations } = controlStations.value;
  return {
    orbit,
    nodes: [
      ...stations.map((station) => ({
        id: station.id as string,
        angle: station.angle,
        radius: station.radius,
        shown: station.id !== "message" || !composerOpen.value,
        lit: wokenControl.value === station.id
          || (station.id === "session" && sessionOpen.value)
          || (station.id === "actions" && actionsOpen.value),
      })),
      // The input's options, while they stand on the orbit and the bay is open.
      ...(optionsDocked.value ? optionLayout.value.map((station, index) => {
        const id = shownOptionIds.value[index]!;
        return {
          id: id as string,
          angle: station.angle,
          radius: station.radius,
          shown: bayOpen.value,
          lit: wokenControl.value === id || (id !== "images" && id !== "thinking" && openMenus[id]),
        };
      }) : []),
    ],
  };
});
// Below 1100 px the ring has no room and the orb shows no steps: the live bubble keeps its own
// list there, or a running turn's steps would be shown nowhere.
const orbHasRoomForSteps = computed(() => viewportWidth.value >= 1100);
// There the messages also lie over the orb, not beside it, and its bright rings came through
// the bubbles' glass: with a conversation on the page it steps back.
const orbBehindText = computed(() => viewportWidth.value < 1100 && gateway.messages.length > 0);
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
const hasSidePanels = computed(() => Boolean(gateway.visibleSwarmState) || shellStore.hasEntries || computerStore.loading || computerStore.sessions.length > 0 || gateway.isLoading);

// ── The input's options on the orbit ─────────────────────────────────────────────────────────
// What the bay offers beside its field stood in it as a row of chips. Where the window has the
// room they stand on the controls' orbit while the bay is open, fanned out either side of its
// front (composables/orbControls.ts optionStations); the bay keeps its field and Send. Where it
// has not — a low window, a bay grown tall with attachments or the voice bar, the controls parked
// at the page's edge — they stay in the bay as chips. The same elements either way.
const shownOptionIds = computed<OptionId[]>(() => [
  ...(showOptionsDropdown.value ? ["options" as const] : []),
  ...(showJobsDropdown.value ? ["jobs" as const] : []),
  "effort", "images", "thinking",
]);
const optionLayout = computed(() => optionStations(shownOptionIds.value.length, hudWin.value.w, hudWin.value.h, controlStations.value.orbit));
/** Two lines under an option on a tall window (its name, what it is set to); one below that. */
const optionLines = computed(() => optionLabelLines(hudWin.value.h));
/** The bay's height without the options' row and with an idle field: what it is never under for long. */
const BAY_SLIM_IDLE = 150;
/**
 * Whether the options stand on the orbit. Measured against the bay without their row, whichever
 * way they stand now, and against an idle field at the least, so a turn starting (the field
 * shrinks) does not move them. Coming back onto the orbit asks for a little more room than
 * staying on it: a bay a pixel either side of the limit would otherwise send them to and fro.
 */
const optionsDocked = ref(false);
function settleOptions(): void {
  const { w, h } = hudWin.value;
  const slack = optionsDocked.value ? 0 : 8;
  optionsDocked.value = controlsDocked.value && optionsFit(optionLayout.value, optionLines.value, h, {
    bayHeight: Math.max(bayHeightSlim.value, BAY_SLIM_IDLE) + slack,
    // Under the front step's label, whether a turn runs now or not: one will.
    over: stepLabelFloor(w, h, freeHalfWidth(w, h, 16, 0)),
  });
}
// Watched from the moment the page is mounted: which options there are is decided by what is
// declared further down this setup, and a watcher reads its sources the moment it is made.
onMounted(() => {
  publishBayHeight();
  settleOptions();
  watch([controlsDocked, optionLayout, optionLines, hudWin, bayHeightSlim], settleOptions);
});
// The bay is measured again once the options have moved in or out of it — on the next frame,
// never within the same turn of the event loop.
watch(optionsDocked, () => { requestAnimationFrame(publishBayHeight); }, { flush: "post" });

function optionStation(id: OptionId) {
  return optionLayout.value[shownOptionIds.value.indexOf(id)];
}
/** An option's classes on the orbit: which way its menu opens, and folded away with the bay. */
function optionClass(id: OptionId): string[] {
  const station = optionsDocked.value ? optionStation(id) : undefined;
  if (!station) return [];
  return ["orb-option", `orb-option--${station.side}`, bayOpen.value ? "" : "orb-option--away"];
}
/**
 * An option's place on the orbit, from the bay's own box: the bay is centred on the viewport like
 * the orb, and its foot stands 20 px over the window's (1 px of that its border).
 */
function optionStyle(id: OptionId): Record<string, string> | undefined {
  const station = optionsDocked.value ? optionStation(id) : undefined;
  if (!station) return undefined;
  const { w, h } = hudWin.value;
  const front = controlStations.value.stations.find((candidate) => candidate.id === "message")!;
  const left = w / 2 + station.x - station.size / 2;
  const top = h / 2 + station.y - station.size / 2;
  return {
    left: `calc(50% + ${Math.round(station.x - station.size / 2)}px)`,
    bottom: `${Math.round(h / 2 - 21 - station.y - station.size / 2)}px`,
    width: `${station.size}px`,
    height: `${station.size}px`,
    "--node-size": `${station.size}px`,
    // Folded away, an option is where the message input's control stands: that control opens into them.
    "--away-x": `${Math.round(front.x - station.x)}px`,
    "--away-y": `${Math.round(front.y - station.y)}px`,
    "--delay": `${station.index * 40}ms`,
    // Its menu stands on the option's own foot and grows upwards and away from the middle: up to
    // the header, out to the window's edge.
    "--panel-room": `${Math.round(Math.max(200, top + station.size - 76))}px`,
    "--panel-w": `${Math.round(Math.max(220, (station.side === "left" ? left : w - left - station.size) - 28))}px`,
  };
}
/** An option's name over what it is set to — where there is one line only, the setting stands alone. */
function optionName(name: string, hasState: boolean): string {
  return optionLines.value === 2 || !hasState ? name : "";
}
/** How many jobs the Jobs option counts: the running ones, else the recent ones. */
const jobsNodeState = computed(() => {
  const running = scenesStore.runningJobs.length;
  return running > 0 ? String(running) : sceneJobs.value.length > 0 ? String(sceneJobs.value.length) : "";
});
/** How far below the orb the options reach, for the turn's status line, which stands under them. */
const orbStatusFloor = computed(() => (optionsDocked.value && bayOpen.value ? optionsFloor(optionLayout.value, optionLines.value) : 0));
/** Where the open bay begins, in pixels below the viewport's centre: the status line ends above it. */
const orbStatusCeiling = computed(() => (bayOpen.value && bayHeight.value > 0 ? hudWin.value.h / 2 - 20 - bayHeight.value : undefined));

// ── Off-canvas side panel ───────────────────────────────────────────────
const sidePanelOpen = ref(false);

/**
 * Per-message execution detail, shown in the panel's Steps tab.
 *
 * The panel is otherwise session-scoped — the Live tab tracks whatever the swarm is doing now
 * — so this is the one place it becomes about a SPECIFIC message: whichever answer's step link
 * the reader last clicked.
 */
const stepDetailMessageId = ref<string | null>(null);
const focusedStepId = ref<string | null>(null);
/** Bumped on every click, so clicking the SAME row again still opens and scrolls to it. */
const focusRequest = ref(0);
const requestedPanelTab = ref<"live" | "steps" | "artifacts" | null>(null);

// Resolved by id on every render rather than holding the message object: a rewind can
// truncate it away, and a stale selection should render empty rather than frozen.
const stepDetailSteps = computed(() => {
  const id = stepDetailMessageId.value;
  const message = id ? gateway.messages.find(m => m.id === id) : undefined;
  return message ? stepsFor(message) : [];
});
// The tab badge counts steps, not the narration lines between them — the bubble's own header
// already does, and the two disagreeing reads like a bug.
const stepDetailToolCount = computed(() => stepDetailSteps.value.filter(step => step.kind === "tool").length);

// A step clicked WHILE the turn runs belongs to the "streaming" placeholder, and it leaves that
// bubble when the turn lands or when a message the user sent mid-turn is read (see
// followFocusedStep). Follow the STEP, not a guess at the message: step ids survive both moves,
// so the only message that can contain this one is the one that took it. Guessing "the last
// assistant message" picked the previous turn's answer when a turn was superseded, and another
// session's answer after a switch.
watch(() => followFocusedStep(gateway.messages, stepDetailMessageId.value, focusedStepId.value), (target) => {
  if (target === undefined) return;
  stepDetailMessageId.value = target;
  if (target === null) focusedStepId.value = null;
});

// Another session is another conversation; never leave its steps open against this one.
watch(() => gateway.currentSessionId, () => {
  stepDetailMessageId.value = null;
  focusedStepId.value = null;
});

/** The live turn's steps in the side panel, at this step when the orb's click named one. */
function openLiveSteps(stepId: string | undefined): void {
  stepDetailMessageId.value = "streaming";
  focusedStepId.value = stepId ?? null;
  focusRequest.value += 1;
  requestedPanelTab.value = "steps";
  sidePanelOpen.value = true;
  void nextTick(() => { requestedPanelTab.value = null; });
}

// The panel reads like the list it was opened from: in that answer's language.
const stepDetailLanguage = computed(() => {
  const message = gateway.messages.find((candidate) => candidate.id === stepDetailMessageId.value);
  return message ? turnLanguage(message.language ?? detectLanguage(message.content ?? "")) : orbLanguage.value;
});

function showStep(messageId: string, stepId: string): void {
  stepDetailMessageId.value = messageId;
  focusedStepId.value = stepId;
  focusRequest.value += 1;
  requestedPanelTab.value = "steps";
  sidePanelOpen.value = true;
  // Clear the request so a later manual tab change inside the panel is not undone by the
  // watcher firing again on an unrelated re-render.
  void nextTick(() => { requestedPanelTab.value = null; });
}

// Aggregate previewable, non-image attachments from all messages in the session
// Aggregate previewable and downloadable attachments from all messages in the session.
// Previously only "previewable" (non-download, non-image) attachments were shown here.
// We now include everything except raw inline images (those are shown inline in the message).
const sessionArtifacts = computed((): ChatAttachment[] => {
  const seen = new Set<string>();
  const results: ChatAttachment[] = [];
  for (const msg of gateway.messages) {
    for (const att of msg.attachments ?? []) {
      // Skip inline images — they are already shown within the chat bubble.
      if (att.previewMode === "image") continue;
      if (att.dataUrl?.startsWith("data:image/")) continue;
      // Must have an accessible path or external URL.
      if (!att.relativePath && !att.externalUrl) continue;
      if (seen.has(att.filename)) continue;
      seen.add(att.filename);
      results.push(att);
    }
  }
  return results;
});

const selectedPanelArtifact = ref<ChatAttachment | null>(null);
const panelArtifactLoading = ref(false);
const panelArtifactError = ref<string | null>(null);

interface PanelArtifactPreview {
  kind: "html" | "pdf" | "audio" | "website" | "text" | "download";
  url?: string;
  text?: string;
}

const panelArtifactPreview = ref<PanelArtifactPreview | null>(null);
let currentPanelObjectUrl: string | null = null;

function revokePanelObjectUrl() {
  if (currentPanelObjectUrl) {
    URL.revokeObjectURL(currentPanelObjectUrl);
    currentPanelObjectUrl = null;
  }
}

function panelArtifactIcon(att: ChatAttachment): string {
  if (att.isDirectory) return "⊞";
  switch (att.previewMode) {
    case "html":     return "⟨/⟩";
    case "pdf":      return "⊞";
    case "audio":    return "♪";
    case "website":  return "⊕";
    case "markdown": return "✎";
    case "json":     return "{}";
    case "mermaid":  return "⬡";
    case "download": {
      const ext = att.filename.split(".").pop()?.toLowerCase() ?? "";
      if (["docx","doc","odt","rtf"].includes(ext)) return "📄";
      if (["xlsx","xls","ods","csv"].includes(ext)) return "📊";
      if (["pptx","ppt","odp"].includes(ext)) return "📊";
      if (["zip","tar","gz"].includes(ext)) return "🗜";
      if (["mp4","mov","avi","mkv"].includes(ext)) return "▶";
      return "⬇";
    }
    default: return "▤";
  }
}

async function selectPanelArtifact(att: ChatAttachment): Promise<void> {
  if (selectedPanelArtifact.value?.filename === att.filename) return;
  selectedPanelArtifact.value = att;
  panelArtifactLoading.value = true;
  panelArtifactError.value = null;
  panelArtifactPreview.value = null;
  revokePanelObjectUrl();
  try {
    if (att.externalUrl) {
      panelArtifactPreview.value = {
        kind: att.previewMode === "pdf" ? "pdf" : att.previewMode === "audio" ? "audio" : "html",
        url: att.externalUrl,
      };
      return;
    }
    if (!att.relativePath) {
      panelArtifactError.value = "No file path available for this artifact.";
      return;
    }

    // Download-only artifacts: show the download prompt panel without fetching.
    if (att.previewMode === "download") {
      panelArtifactPreview.value = { kind: "download" };
      return;
    }

    // Directory (website project): serve from the gateway static-serve endpoint
    // so that relative CSS/JS/image imports resolve correctly inside the iframe.
    if (att.isDirectory || att.previewMode === "website") {
      const previewUrl = gateway.buildWorkspacePreviewUrl(att.relativePath);
      panelArtifactPreview.value = { kind: "website", url: previewUrl };
      return;
    }

    const { blob } = await gateway.fetchWorkspaceArtifactBlob(att.relativePath, { disposition: "inline" });
    if (att.previewMode === "html" || att.previewMode === "pdf" || att.previewMode === "audio") {
      const url = URL.createObjectURL(blob);
      currentPanelObjectUrl = url;
      panelArtifactPreview.value = { kind: att.previewMode, url };
      return;
    }
    panelArtifactPreview.value = { kind: "text", text: await blob.text() };
  } catch (err) {
    panelArtifactError.value = err instanceof Error ? err.message : "Failed to load artifact.";
  } finally {
    panelArtifactLoading.value = false;
  }
}
// ────────────────────────────────────────────────────────────────────────

watch(() => gateway.currentSessionId, () => {
  shellStore.reset();
  replyTextOpen.value = false;
  selectedPanelArtifact.value = null;
  panelArtifactPreview.value = null;
  panelArtifactError.value = null;
  revokePanelObjectUrl();
});
const runningSceneJobs = computed(() => scenesStore.runningJobs.slice(0, 3));
const VISIBLE_TAIL = 6;
/**
 * The newest turn, which stays open and in view as a whole: a turn the user spoke into runs
 * as several bubbles with their messages between them, and it is still one answer being told —
 * folding its first part away, or hiding it behind "show older", would cut it in half.
 */
const latestTurnView = computed(() => latestTurn(displayMessages.value));
const visibleMessages = computed(() => {
  if (expandedMessageHistory.value || displayMessages.value.length <= VISIBLE_TAIL) {
    return displayMessages.value;
  }
  return displayMessages.value.slice(Math.min(displayMessages.value.length - VISIBLE_TAIL, latestTurnView.value.start));
});
const collapsedMessageCount = computed(() => Math.max(0, displayMessages.value.length - visibleMessages.value.length));
const latestAssistantMessage = computed(() => {
  for (let index = gateway.messages.length - 1; index >= 0; index -= 1) {
    const message = gateway.messages[index];
    // A progress message (its plan, a finished step) is not an answer.
    if (message?.role === "assistant" && !message.blocked && !message.progress && message.content.trim()) {
      return message;
    }
  }
  return null;
});
const latestAssistantText = computed(() => latestAssistantMessage.value?.content ?? "");
const multimodalStatus = computed(() => multimodalStore.status);
const filesAvailable = computed(() => Boolean(multimodalStatus.value?.files.ok));
const sttAvailable = computed(() => Boolean(multimodalStatus.value?.stt.ok));
const ttsAvailable = computed(() => Boolean(multimodalStatus.value?.tts.ok));
const wakeConfigured = computed(() => Boolean(multimodalStore.config.wakeWord.enabled));
// The microphone is read through an AudioContext (speech/voiceCapture.ts), not a MediaRecorder.
const browserRecordingAvailable = computed(() => typeof window !== "undefined"
  && Boolean(navigator.mediaDevices?.getUserMedia)
  && Boolean(window.AudioContext ?? (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext));
const browserSpeechRecognitionAvailable = computed(() => typeof window !== "undefined" && Boolean(window.SpeechRecognition ?? window.webkitSpeechRecognition));
const browserSpeechPlaybackAvailable = computed(() => typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined");
const showFileInput = computed(() => filesAvailable.value || typeof FileReader !== "undefined");
const showAudioUpload = computed(() => sttAvailable.value);
const showRecording = computed(() => sttAvailable.value && browserRecordingAvailable.value);
const showWakeMode = computed(() => sttAvailable.value && wakeConfigured.value && browserSpeechRecognitionAvailable.value);
const showSpeechPlayback = computed(() => ttsAvailable.value || browserSpeechPlaybackAvailable.value);
/** A hands-free conversation needs a microphone, a transcriber and a voice — not the browser's wake-word recogniser. */
const showVoiceConversation = computed(() => showRecording.value && showSpeechPlayback.value);

const voice = useVoice({
  ttsAvailable,
  recordSilenceMs: wakeSilenceTimeoutMs,
  appendToComposer,
  submit: async (text) => {
    appendToComposer(text);
    await sendMessage();
  },
});
const {
  speakEnabled: speakReplyEnabled,
  speechUpdates,
  sttLanguage,
  conversation: voiceConversationMode,
  phase: voicePhase,
  activity: speechActivity,
  preparingReply,
  lastReply,
  micLevel,
  recording: recordingState,
  notice: voiceNotice,
} = voice;

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
  if (recordingState.value === "recording") return chatText.statusRecording(uiLanguage);
  if (recordingState.value === "processing") return chatText.statusTranscribing(uiLanguage);
  if (sttAvailable.value && !browserRecordingAvailable.value) return chatText.micUnavailable(uiLanguage);
  if (sttAvailable.value && wakeConfigured.value && !browserSpeechRecognitionAvailable.value) return chatText.wakeUnavailable(uiLanguage);
  return wakeStatus.value;
});
const voiceStatusWorthShowing = computed(() => voiceStatus.value.trim() !== "" && voiceStatus.value !== "Voice idle");
const showWakeFeedbackCard = computed(() => showWakeMode.value && wakeFeedbackState.value !== "idle");
const wakeFeedbackTone = computed(() => {
  if (wakeFeedbackState.value === "error") return "error";
  if (wakeFeedbackState.value === "success") return "success";
  if (wakeFeedbackState.value === "processing") return "processing";
  if (wakeFeedbackState.value === "recording") return "recording";
  return "listening";
});
const wakeFeedbackTitle = computed(() => chatText.wakeTitle(uiLanguage, wakeFeedbackState.value));
const wakeFeedbackStep = computed(() => {
  if (wakeFeedbackState.value === "success") return 4;
  if (wakeFeedbackState.value === "processing") return 3;
  if (wakeFeedbackState.value === "recording") return 2;
  if (wakeFeedbackState.value === "listening") return 1;
  if (wakeFeedbackState.value === "error") return 1;
  return 0;
});
function clearWakeFeedbackTimer() {
  if (wakeFeedbackTimer !== null) {
    window.clearTimeout(wakeFeedbackTimer);
    wakeFeedbackTimer = null;
  }
}

function setWakeFeedback(
  state: "idle" | "listening" | "recording" | "processing" | "success" | "error",
  message: string,
  autoHideMs = 0,
) {
  clearWakeFeedbackTimer();
  wakeFeedbackState.value = state;
  wakeFeedbackMessage.value = message;
  if (autoHideMs > 0) {
    wakeFeedbackTimer = window.setTimeout(() => {
      wakeFeedbackTimer = null;
      if (recordingState.value === "idle" && !wakeListening.value) {
        wakeFeedbackState.value = "idle";
        wakeFeedbackMessage.value = "";
      }
    }, autoHideMs);
  }
}

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
      wakeStatus.value = chatText.wakeListeningStatus(uiLanguage);
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
      voice.finishRecording();
      wakeStatus.value = chatText.stopPhraseDetected(uiLanguage);
      setWakeFeedback("processing", chatText.stopPhraseFeedback(uiLanguage));
      return;
    }

    const matchedKeyword = wakeKeywords.value.find((phrase) => lowered.includes(phrase.toLowerCase()));
    if (matchedKeyword && recordingState.value === "idle") {
      wakeStatus.value = chatText.wakePhraseDetected(uiLanguage, matchedKeyword);
      void startWakeRecording();
      return;
    }
  }
}

function handleWakeError(event: SpeechRecognitionErrorEventLike) {
  const error = event.error ?? "unknown";
  wakeStatus.value = chatText.wakeRecognitionError(uiLanguage, error);
  setWakeFeedback("error", wakeStatus.value, 6000);
  if (wakeListening.value && !["not-allowed", "service-not-allowed"].includes(error)) {
    scheduleWakeRestart(1000);
  }
}

async function toggleWakeListening() {
  if (wakeListening.value) {
    wakeListening.value = false;
    stopWakeRecognition();
    wakeStatus.value = chatText.wakeModeOff(uiLanguage);
    setWakeFeedback("idle", "");
    return;
  }

  const recognition = createSpeechRecognition();
  if (!recognition) {
    wakeStatus.value = chatText.speechRecognitionUnavailable(uiLanguage);
    setWakeFeedback("error", wakeStatus.value, 6000);
    return;
  }

  wakeRecognition = recognition;
  wakeListening.value = true;
  wakeStatus.value = chatText.wakeListeningStatus(uiLanguage);
  setWakeFeedback("listening", chatText.listeningFor(uiLanguage, wakeKeywords.value.join(" / ")));
  recognition.start();
}

function reportRecording(outcome: RecordingOutcome): void {
  if (outcome.kind === "transcribed") {
    wakeStatus.value = chatText.transcriptReady(uiLanguage, outcome.language || undefined);
    setWakeFeedback("success", wakeStatus.value, 5000);
  } else if (outcome.kind === "empty") {
    wakeStatus.value = chatText.noSpeechHeard(uiLanguage);
    setWakeFeedback("error", chatText.noSpeechHint(uiLanguage), 7000);
  } else {
    wakeStatus.value = outcome.message;
    setWakeFeedback("error", outcome.message, 7000);
  }
}

/** A wake phrase was heard: record what follows it, then listen for the phrase again. */
async function startWakeRecording(): Promise<void> {
  stopWakeRecognition();
  wakeStatus.value = chatText.wakeTriggeredRecording(uiLanguage);
  setWakeFeedback("recording", chatText.wakeRecordingStarted(uiLanguage));
  reportRecording(await voice.startRecording());
  if (wakeListening.value) {
    wakeRecognition = createSpeechRecognition();
    scheduleWakeRestart(300);
  }
}

async function toggleRecording() {
  if (recordingState.value === "recording") {
    setWakeFeedback("processing", chatText.recordingFinishedTranscribing(uiLanguage));
    voice.finishRecording();
    return;
  }
  if (recordingState.value !== "idle") return;
  wakeStatus.value = chatText.statusRecording(uiLanguage);
  reportRecording(await voice.startRecording());
}

function onDocumentSelected(event: Event) {
  const input = event.target as HTMLInputElement;
  // Read the list before clearing the input: clearing empties it.
  const files = [...(input.files ?? [])];
  input.value = "";
  closeOptionsDropdown();
  for (const file of files) queueAttachment(file);
}

/**
 * Queue a file for the current message instead of processing it immediately.
 * Images are analyzed at send time; documents are persisted + ingested into the
 * engram document library at send time (not inlined into the prompt). The
 * composer stays open so the user can type their message before sending.
 */
function queueAttachment(file: File): void {
  const isImage = file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(file.name);
  if (isImage) {
    pendingImageContexts.value.push({ filename: file.name, file, previewUrl: URL.createObjectURL(file) });
    attachedNotice = chatText.imageAttached(uiLanguage);
  } else {
    pendingDocumentContexts.value.push({ filename: file.name, file });
    attachedNotice = chatText.fileAttached(uiLanguage, file.name);
  }
  wakeStatus.value = attachedNotice;
  composerOpen.value = true;
}

async function onAudioSelected(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  await transcribeDroppedAudio(file);
}

async function transcribeDroppedAudio(file: File): Promise<void> {
  multimodalBusy.value = true;
  wakeStatus.value = chatText.transcribingFile(uiLanguage, file.name);
  try {
    const outcome = await voice.transcribeFile(file);
    wakeStatus.value = outcome.kind === "transcribed"
      ? chatText.audioAddedFrom(uiLanguage, file.name)
      : outcome.kind === "empty" ? chatText.audioNoText(uiLanguage) : outcome.message;
  } finally {
    multimodalBusy.value = false;
  }
}

// ── Drag-and-drop file ingestion ─────────────────────────────────────────────
// Files dropped anywhere on the chat surface are auto-routed by MIME / extension:
//   audio/*       → transcribed, transcript inserted into the composer
//   image/*       → queued for analysis at send time (same as the file picker)
//   everything    → converted to Markdown via the multimodal backend (or a
//                   local text-decode fallback when the backend is offline)
const dropActive = ref(false);
let dropDepth = 0;

function isAudioFile(file: File): boolean {
  return file.type.startsWith("audio/") || /\.(mp3|wav|m4a|aac|ogg|flac|webm)$/i.test(file.name);
}

async function ingestDroppedFile(file: File): Promise<void> {
  if (isAudioFile(file)) {
    await transcribeDroppedAudio(file);
    return;
  }
  // Images + documents are queued and processed at send time (see queueAttachment).
  queueAttachment(file);
}

function onChatDragOver(event: DragEvent): void {
  // Only intercept drags that carry actual files (ignore text selections etc.).
  if (!event.dataTransfer?.types?.includes("Files")) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  if (!dropActive.value) {
    dropActive.value = true;
    dropDepth = 0;
  }
  dropDepth++;
}

function onChatDragLeave(event: DragEvent): void {
  if (!dropActive.value) return;
  // dragleave fires on every child enter/exit too. Use a depth counter so we
  // only hide the overlay when we've truly left the chat surface.
  dropDepth = Math.max(0, dropDepth - 1);
  if (dropDepth === 0) {
    dropActive.value = false;
  }
  // Some browsers fire dragleave with relatedTarget=null when leaving the
  // window; force-close in that case.
  if (event.relatedTarget === null) {
    dropDepth = 0;
    dropActive.value = false;
  }
}

async function onChatDrop(event: DragEvent): Promise<void> {
  if (!event.dataTransfer?.types?.includes("Files")) return;
  event.preventDefault();
  dropDepth = 0;
  dropActive.value = false;
  const files = Array.from(event.dataTransfer.files ?? []);
  if (files.length === 0) return;
  // Process sequentially so wakeStatus messages stay coherent and we don't
  // overwhelm the multimodal backend with parallel uploads.
  for (const file of files) {
    await ingestDroppedFile(file);
  }
}

/** The voice-conversation toggle's tooltip: what the conversation is doing. */

const voiceBarBusy = computed(() => Boolean(speechActivity.value || preparingReply.value));
const voiceBarListening = computed(() =>
  voicePhase.value === "listening" || voicePhase.value === "hearing" || recordingState.value === "recording");
const showVoiceBar = computed(() => Boolean(
  voiceBarBusy.value || voiceConversationMode.value || lastReply.value || recordingState.value !== "idle" || voiceNotice.value));
// The voice bar is in the bay: it comes up with it (see maybeCloseComposer for the other half).
watch(showVoiceBar, (showing) => { if (showing) composerOpen.value = true; });

/** What the voice bar says is happening. */
const voiceBarLabel = computed(() => {
  const speaking = speechActivity.value;
  if (speaking?.priority === "reply") return speaking.label === "summary" ? chatText.speakingSummary(uiLanguage) : chatText.speakingAnswer(uiLanguage);
  if (speaking) return speaking.label ? `“${speaking.label}”` : chatText.speaking(uiLanguage);
  if (preparingReply.value) return chatText.preparingSummary(uiLanguage);
  if (voiceConversationMode.value) {
    if (voicePhase.value === "hearing") return chatText.hearingYou(uiLanguage);
    if (voicePhase.value === "transcribing") return chatText.transcribingShort(uiLanguage);
    if (voicePhase.value === "thinking") return chatText.workingOnIt(uiLanguage);
    if (voicePhase.value === "listening") return chatText.listeningJustTalk(uiLanguage);
  }
  if (recordingState.value === "recording") return chatText.recordingPauseOrDone(uiLanguage);
  if (recordingState.value === "processing") return chatText.transcribingShort(uiLanguage);
  if (lastReply.value) return lastReply.value.summarized ? chatText.spokeSummary(uiLanguage) : chatText.spokeAnswer(uiLanguage);
  return "";
});

function dismissVoiceBar(): void {
  voiceNotice.value = "";
  replyTextOpen.value = false;
  voice.dismissReply();
}

// ── Slash-command autocomplete ──────────────────────────────────────────────
// Triggered when the textarea starts with '/' and the user is still typing the
// command name (no whitespace yet). Surfaces matching scenes + configured jobs
// with name + description; Enter / Tab inserts the chosen name + a trailing
// space so the user can keep typing key=value args.
interface SlashSuggestion {
  kind: "scene" | "job";
  name: string;
  description: string;
}

const slashIndex = ref(0);

const slashQuery = computed<string | null>(() => {
  const text = inputText.value;
  if (!text.startsWith("/")) return null;
  // Stop suggesting once any whitespace separates the command name from args.
  if (/\s/.test(text)) return null;
  return text.slice(1).toLowerCase();
});

const slashSuggestions = computed<SlashSuggestion[]>(() => {
  const query = slashQuery.value;
  if (query === null) return [];
  const items: SlashSuggestion[] = [];
  for (const scene of gateway.scenes) {
    items.push({ kind: "scene", name: scene.name, description: scene.description ?? "" });
  }
  for (const job of configuredJobs.value) {
    items.push({ kind: "job", name: job.name, description: job.description ?? "" });
  }
  if (!query) return items.slice(0, 12);
  return items
    .filter((item) => {
      const lname = item.name.toLowerCase();
      if (lname.startsWith(query)) return true;
      if (lname.includes(query)) return true;
      if (item.description.toLowerCase().includes(query)) return true;
      return false;
    })
    // Prefix matches first, then substring matches.
    .sort((a, b) => {
      const aPref = a.name.toLowerCase().startsWith(query) ? 0 : 1;
      const bPref = b.name.toLowerCase().startsWith(query) ? 0 : 1;
      if (aPref !== bPref) return aPref - bPref;
      return a.name.localeCompare(b.name);
    })
    .slice(0, 12);
});

const slashOpen = computed(() => slashQuery.value !== null && slashSuggestions.value.length > 0);

watch(slashQuery, () => { slashIndex.value = 0; });

function acceptSlashSuggestion(index: number): void {
  const suggestion = slashSuggestions.value[index];
  if (!suggestion) return;
  inputText.value = `/${suggestion.name} `;
  // Refocus the textarea and move cursor to the end so the user can keep
  // typing arguments without an extra click.
  void nextTick(() => {
    const textarea = composerTextareaEl.value;
    if (!textarea) return;
    textarea.focus();
    const end = textarea.value.length;
    textarea.setSelectionRange(end, end);
  });
}

function onComposerKeydown(event: KeyboardEvent) {
  // Slash-popup navigation takes priority when it's open.
  if (slashOpen.value) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      slashIndex.value = (slashIndex.value + 1) % slashSuggestions.value.length;
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      const len = slashSuggestions.value.length;
      slashIndex.value = (slashIndex.value - 1 + len) % len;
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      acceptSlashSuggestion(slashIndex.value);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      // Close the popup without dropping the leading '/' in case the user
      // wants to continue typing — Esc again drops the unfinished command (below).
      // Force-close by appending a sentinel space then re-trim.
      inputText.value = `${inputText.value} `;
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
      // When the popup is open, Enter accepts the highlighted suggestion
      // instead of submitting the message. Hold Shift/Ctrl/etc. to insert a
      // newline normally.
      if (event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      acceptSlashSuggestion(slashIndex.value);
      return;
    }
  }

  // Escape puts the composer away: an unfinished command is dropped, an empty bay folds, a
  // drafted message stays where it is and only loses the focus.
  if (event.key === "Escape" && !event.isComposing) {
    event.preventDefault();
    // One step at a time: an open menu goes first, the composer on the next press.
    if (composerMenuOpen.value) {
      closeComposerMenus();
      composerMenuOpen.value = false;
      return;
    }
    if (/^\/\S*\s*$/.test(inputText.value)) inputText.value = "";
    composerTextareaEl.value?.blur();
    composerFocused.value = false;
    maybeCloseComposer();
    return;
  }

  if (event.key !== "Enter") return;
  // Let Shift/Ctrl/Alt/Meta+Enter pass through so the textarea inserts a
  // newline at the cursor position (its native behavior).
  if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
  // Skip while an IME composition is active so we don't submit on commit
  // (German autocomplete, CJK input methods, etc. dispatch keyCode 229).
  if (event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  void sendMessage();
}

async function sendMessage() {
  const trimmedText = inputText.value.trim();
  const hasImages = pendingImageContexts.value.length > 0;
  const hasDocs = pendingDocumentContexts.value.length > 0;
  if (!trimmedText && !hasImages && !hasDocs) return;
  // Whoever sends wants to see it land: scrolled up, both the message and its answer used to
  // arrive out of view.
  jumpToBottom();
  // Mid-turn steering: a turn is already running → fold this text into it. Never a new turn,
  // which would cancel the running one: a message that cannot be delivered stays in the chat
  // marked as such, with a resend.
  if (gateway.isLoading) {
    if (hasImages || hasDocs) {
      // Text-only — attachments cannot join a running turn. Say so rather than ignore Enter.
      showSteeringNote(chatText.attachmentsCannotJoin(uiLanguage), "error");
      return;
    }
    inputText.value = "";
    const state = await gateway.steerRunningTurn(trimmedText);
    if (state === null) {
      // Nothing went out. Whatever was typed while it was tried stays.
      if (!inputText.value.trim()) inputText.value = trimmedText;
      return;
    }
    showSteeringNote(state === "undelivered"
      ? chatText.steerUndelivered(uiLanguage)
      : state === "sent"
        ? chatText.steerSentAsNext(uiLanguage)
        : state === "held"
          ? chatText.steerHeld(uiLanguage)
          // Mid-turn messages are read between the turn's steps, and a step waiting on a card
          // does not finish until the card is answered.
          : gateway.hasOpenUserInput
            ? chatText.steerQueuedBehindCard(uiLanguage)
            : chatText.steerQueued(uiLanguage), state === "undelivered" ? "error" : "ok");
    return;
  }
  // The previous message's attachments are still being read, and its turn has not started. Sent
  // now, this one would start first — and the analysed one would then replace it. It waits.
  if (analysing.value) {
    showSteeringNote(chatText.stillReadingAttachments(uiLanguage), "error");
    return;
  }
  const jobMatch = !hasImages && !hasDocs
    ? trimmedText.match(/^\/job\s+(\S+)(?:\s+(.*))?$/s)
    : null;
  if (jobMatch && jobMatch[1]?.toLowerCase() !== "help") {
    inputText.value = "";
    const params = parseInlineParams(jobMatch[2] ?? "");
    await scenesStore.runJob(jobMatch[1]!, Object.keys(params).length > 0 ? params : undefined);
    return;
  }

  const pendingImages = pendingImageContexts.value;
  const pendingDocs = pendingDocumentContexts.value;
  pendingImageContexts.value = [];
  pendingDocumentContexts.value = [];
  inputText.value = "";

  // What the user sees in their own bubble — filenames only, no analysis/text dump
  const allNames = [...pendingImages.map(p => p.filename), ...pendingDocs.map(d => d.filename)];
  const displayParts: string[] = [];
  if (allNames.length > 0) displayParts.push(`📎 ${allNames.join(", ")}`);
  if (trimmedText) displayParts.push(trimmedText);
  const displayContent = displayParts.join("\n");

  if (pendingImages.length === 0 && pendingDocs.length === 0) {
    try {
      await gateway.sendMessage(trimmedText, thinkingMode.value);
    } catch (error) {
      giveBackUnsentText(trimmedText, error);
    }
    return;
  }

  analysing.value = true;
  let pendingUserMessageId: string | undefined;
  let attachmentsGivenBack = false;
  try {
    const attachments: ChatAttachment[] = [];

    // Documents: persist into the session's workspace so the runtime ingests them
    // into the engram document library. The prompt gets a hint + on-demand
    // retrieval (search_documents) instead of the whole file's text inlined.
    if (pendingDocs.length > 0) {
      wakeStatus.value = chatText.uploadingDocuments(uiLanguage, pendingDocs.length);
      const sid = gateway.currentSessionId ?? "shared";
      for (const d of pendingDocs) {
        // A document that did not arrive stops the send: the message is about it. It used to go
        // out without it, the reason passing through the status line and gone before the turn
        // began.
        const meta = await gateway.persistAttachment(d.file, sid).catch((err: unknown) => { throw namedFailure(d.filename, err); });
        attachments.push({
          filename: meta.filename,
          relativePath: meta.relativePath,
          contentType: meta.contentType,
          size: meta.size,
          previewMode: "download",
        });
      }
    }

    // Images: analyzed client-side; the analysis text is inlined. Each is also kept in the
    // session's workspace, like a document: with a workspace path an uploaded picture can be
    // offered as the base of a later edit, and it still opens after a reload. A failed upload
    // costs only that — the picture and its analysis still go out.
    let imageContext = "";
    if (pendingImages.length > 0) {
      wakeStatus.value = chatText.analysingImages(uiLanguage, pendingImages.length);
      const sid = gateway.currentSessionId ?? "shared";
      const [dataUrls, stored, analyses] = await Promise.all([
        Promise.all(pendingImages.map(p => fileToDataUrl(p.file))),
        Promise.all(pendingImages.map(p => gateway.persistAttachment(p.file, sid).catch(() => null))),
        Promise.all(pendingImages.map(p => gateway.analyzeImageFile(p.file).catch((err: unknown) => { throw namedFailure(p.filename, err); }))),
      ]);
      for (let i = 0; i < pendingImages.length; i++) {
        const kept = stored[i];
        attachments.push({
          filename: pendingImages[i]!.filename,
          dataUrl: dataUrls[i],
          contentType: kept?.contentType || pendingImages[i]!.file.type || "image/*",
          previewMode: "image",
          size: pendingImages[i]!.file.size,
          ...(kept ? { relativePath: kept.relativePath } : {}),
        });
      }
      imageContext = pendingImages.map((p, i) => `Image analysis (${p.filename}):\n\n${analyses[i]}`).join("\n\n");
    }

    pendingUserMessageId = await gateway.appendPendingUserMessage(displayContent, attachments);
    // Document text is NOT inlined — the runtime retrieves it from engram on demand.
    // When there's no user text, give the turn a short instruction so it isn't empty.
    const docNote = pendingDocs.length > 0 && !trimmedText
      ? `I've attached ${pendingDocs.length} document(s) (${pendingDocs.map(d => d.filename).join(", ")}). Let me know what you'd like to do with them.`
      : "";
    const fullText = [imageContext, trimmedText, docNote].filter(Boolean).join("\n\n");
    wakeStatus.value = "";
    await gateway.sendMessage(fullText, thinkingMode.value, displayContent, attachments, { userMessageId: pendingUserMessageId });
  } catch (error) {
    // Said once, as an error, under the field (giveBackUnsentText) — it stood in the status
    // line above it as well, in a label's capitals.
    wakeStatus.value = "";
    if (!pendingUserMessageId) {
      // Nothing reached the chat — no session could be made, or reading an attachment failed —
      // so the whole message goes back to the composer, attachments and all.
      pendingImageContexts.value = [...pendingImages, ...pendingImageContexts.value];
      pendingDocumentContexts.value = [...pendingDocs, ...pendingDocumentContexts.value];
      attachmentsGivenBack = true;
    }
    giveBackUnsentText(trimmedText, error);
  } finally {
    analysing.value = false;
    if (!attachmentsGivenBack) for (const p of pendingImages) URL.revokeObjectURL(p.previewUrl);
  }
}

/**
 * A send that failed must not take the words with it: the composer was cleared as the send
 * began. They go back unless something new was typed meanwhile. A failure after the message
 * reached the chat is also shown there, as an error under it.
 */
function giveBackUnsentText(text: string, error: unknown): void {
  if (text && !inputText.value.trim()) inputText.value = text;
  showSteeringNote(failureNote(chatText.notSent, error), "error");
}

/**
 * What the note under the field says when an action failed: `couldNot` with the reason, or, when the
 * gateway refused this connection's role ("Forbidden: ..."), an access message, not a failure to retry.
 */
function failureNote(couldNot: (language: TurnLanguage, reason: string) => string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const noAccess = forbiddenReason(message);
  return noAccess === null ? couldNot(uiLanguage, message) : chatText.noAccess(uiLanguage, noAccess);
}

/** Why an attachment failed, with the file it is about: there may be several. */
function namedFailure(filename: string, error: unknown): Error {
  return new Error(`${filename}: ${error instanceof Error ? error.message : String(error)}`);
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

const inputRequestText = ref("");

async function submitInputChoice(choice: string) {
  if (!gateway.pendingInputRequest) return;
  inputRequestText.value = "";
  await gateway.respondInput(gateway.pendingInputRequest.inputId, choice);
}

async function submitInputFreeText() {
  if (!gateway.pendingInputRequest) return;
  const answer = inputRequestText.value.trim();
  if (!answer) return;
  inputRequestText.value = "";
  const heard = await gateway.respondInput(gateway.pendingInputRequest.inputId, answer);
  // Too late to be read: keep what they wrote, so it can still go to the agent as a message.
  if (!heard && !inputText.value.trim()) inputText.value = answer;
}

// Same IME / Shift+Enter rules as the composer: bare Enter submits, modified
// Enter inserts a newline (here it'd just lose the keystroke since the input
// is single-line, but we still let the modifier through), and IME composition
// is skipped so German autocomplete-confirm and CJK input methods don't
// accidentally submit the buffer mid-composition.
function onInputRequestKeydown(event: KeyboardEvent) {
  if (event.key !== "Enter") return;
  if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
  if (event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  void submitInputFreeText();
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
  const count = gateway.messages.length;
  if (count > 0 && !(await confirmAction({
    title: chatText.resetConfirmTitle(uiLanguage),
    message: chatText.resetConfirmMessage(uiLanguage, count),
    confirmLabel: chatText.resetConfirmLabel(uiLanguage),
    cancelLabel: chatText.cancel(uiLanguage),
    eyebrow: chatText.cannotBeUndone(uiLanguage),
    danger: true,
  }))) return;
  try {
    await gateway.rpc("session.reset", { sessionId: gateway.currentSessionId });
    await gateway.loadSession(gateway.currentSessionId);
  } catch {
    // If reset fails, create a fresh session instead
    await gateway.createSession();
  }
}

async function handleRewind(messageId: string) {
  // Everything from that message on is cut, here and on the gateway: one small button must not
  // do that on a single click.
  const at = gateway.messages.findIndex((message) => message.id === messageId);
  const cut = at < 0 ? 0 : gateway.messages.length - at;
  if (cut > 1 && !(await confirmAction({
    title: chatText.restartConfirmTitle(uiLanguage),
    message: chatText.restartConfirmMessage(uiLanguage, cut - 1),
    confirmLabel: chatText.restartConfirmLabel(uiLanguage),
    cancelLabel: chatText.cancel(uiLanguage),
    eyebrow: chatText.cannotBeUndone(uiLanguage),
    danger: true,
  }))) return;
  try {
    const text = await gateway.rewindToMessage(messageId);
    openComposer(text);
  } catch (err) {
    // Nothing was cut, here or on the server; say why rather than leave the click unanswered.
    composerOpen.value = true;
    showSteeringNote(failureNote(chatText.couldNotRestart, err), "error");
  }
}

/** A failed answer's question, sent once more as a new turn; the failed answer stays in the record. */
async function handleRetry(messageId: string) {
  if (gateway.isLoading || analysing.value) return;
  const at = gateway.messages.findIndex((message) => message.id === messageId);
  if (at < 0) return;
  const question = gateway.messages.slice(0, at).reverse().find((message) => message.role === "user" && !message.midTurn && !message.steer);
  if (!question?.content?.trim()) return;
  // Whatever is being drafted is not overwritten: the question goes out only from an empty input.
  if (inputText.value.trim()) {
    showSteeringNote(chatText.sendOrClearFirst(uiLanguage), "error");
    return;
  }
  inputText.value = question.content;
  await nextTick();
  await sendMessage();
}

async function handleResendSteer(messageId: string) {
  await gateway.resendSteer(messageId);
}

async function archiveCurrentSession() {
  if (!gateway.currentSessionId) return;
  try {
    await gateway.archiveSession(gateway.currentSessionId);
  } catch (err) {
    composerOpen.value = true;
    showSteeringNote(failureNote(chatText.couldNotArchive, err), "error");
  }
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
  return `**${product.name}**`;
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
    `# ${product.name} Conversation`,
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

async function exportDebugMarkdown(): Promise<void> {
  if (!gateway.currentSessionId) return;
  exportingTranscript.value = true;
  try {
    await gateway.downloadSessionDebugMarkdown(gateway.currentSessionId);
  } finally {
    exportingTranscript.value = false;
  }
}

async function exportAuditMarkdown(): Promise<void> {
  if (!gateway.currentSessionId) return;
  exportingTranscript.value = true;
  try {
    await gateway.downloadSessionAuditMarkdown(gateway.currentSessionId);
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
      const role = msg.role === "user" ? "You" : msg.role === "system" ? "System" : product.name;
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
  <title>${product.name} Conversation</title>
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
  <h1>${product.name} Conversation</h1>
  <div class="meta">Session: ${sessionId} &nbsp;·&nbsp; Exported: ${date}</div>
  ${messageHtml}
</body>
</html>`;

    const win = window.open("", "_blank");
    if (!win) {
      composerOpen.value = true;
      showSteeringNote(chatText.printBlocked(uiLanguage), "error");
      return;
    }
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

// Smart-autoscroll: stick to bottom while the user is parked there, but bail
// out the moment they scroll up to re-read something. While they're up, queue
// a "↓ New messages" pill instead of yanking the viewport.
const isAtBottom = ref(true);
const hasNewBelow = ref(false);
const SCROLL_BOTTOM_TOLERANCE_PX = 80;

function recomputeScrollPosition() {
  const el = messagesEl.value;
  if (!el) return;
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
  isAtBottom.value = distance < SCROLL_BOTTOM_TOLERANCE_PX;
  if (isAtBottom.value) hasNewBelow.value = false;
}

function scrollToBottom() {
  nextTick(() => {
    const el = messagesEl.value;
    if (!el) return;
    if (isAtBottom.value) {
      el.scrollTop = el.scrollHeight;
    } else {
      hasNewBelow.value = true;
    }
  });
}

function jumpToBottom() {
  const el = messagesEl.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
  isAtBottom.value = true;
  hasNewBelow.value = false;
}

// The content's own size, measured. A turn that only runs tools grows inside its one live bubble
// and its answer replaces that bubble in place, so neither watcher further down ever fires for it
// (see scrollFollow). Each message row is observed, and rows come and go with the list.
let contentResizeObserver: ResizeObserver | null = null;
let contentChildObserver: MutationObserver | null = null;
let lastContentHeight = 0;
let turnFollowUntil = 0;

function onContentResize(): void {
  const el = messagesEl.value;
  if (!el) return;
  const height = el.scrollHeight;
  const action = followGrowth({
    grewBy: height - lastContentHeight,
    atBottom: isAtBottom.value,
    turnLive: gateway.isLoading || Date.now() < turnFollowUntil,
  });
  lastContentHeight = height;
  if (action === "stick") el.scrollTop = el.scrollHeight;
  else if (action === "mark") hasNewBelow.value = true;
}

function observeContent(el: HTMLElement | null): void {
  contentResizeObserver?.disconnect();
  contentChildObserver?.disconnect();
  contentResizeObserver = null;
  contentChildObserver = null;
  if (!el || typeof ResizeObserver === "undefined" || typeof MutationObserver === "undefined") return;
  lastContentHeight = el.scrollHeight;
  const resizeObserver = new ResizeObserver(onContentResize);
  for (const child of Array.from(el.children)) resizeObserver.observe(child);
  const childObserver = new MutationObserver((records) => {
    for (const record of records) {
      record.addedNodes.forEach((node) => { if (node instanceof Element) resizeObserver.observe(node); });
      record.removedNodes.forEach((node) => { if (node instanceof Element) resizeObserver.unobserve(node); });
    }
    onContentResize();
  });
  childObserver.observe(el, { childList: true });
  contentResizeObserver = resizeObserver;
  contentChildObserver = childObserver;
}

let scrollListenerEl: HTMLElement | null = null;
function attachScrollListener() {
  const el = messagesEl.value;
  if (scrollListenerEl === el) return;
  if (scrollListenerEl) scrollListenerEl.removeEventListener("scroll", recomputeScrollPosition);
  scrollListenerEl = el;
  observeContent(el);
  if (el) {
    el.addEventListener("scroll", recomputeScrollPosition, { passive: true });
    recomputeScrollPosition();
  }
}

onMounted(() => { attachScrollListener(); });
watch(messagesEl, attachScrollListener);
onBeforeUnmount(() => {
  if (scrollListenerEl) scrollListenerEl.removeEventListener("scroll", recomputeScrollPosition);
  scrollListenerEl = null;
  observeContent(null);
  revokePanelObjectUrl();
  if (steeringNoteTimer !== null) window.clearTimeout(steeringNoteTimer);
});

watch(() => gateway.messages.length, scrollToBottom);
watch(() => gateway.streamingText, scrollToBottom);
// A new question card grows the stream without adding a message; keep it in view.
watch(() => gateway.sessionUserInputs.length, (count, before) => { if (count > (before ?? 0)) scrollToBottom(); });
watch(compactComposer, () => {
  nextTick(() => { adjustComposerHeight(); });
}, { immediate: true });
watch(inputText, () => {
  nextTick(() => { adjustComposerHeight(); });
}, { flush: "post" });
watch(() => [gateway.pendingApproval?.approvalId, gateway.pendingInputRequest?.inputId], () => {
  approvalNowMs.value = Date.now();
});

// A turn landing here keeps the view following its answer. (Reading it aloud: speech/useVoice.ts.)
let _wasLoading = false;
// The session the running turn belongs to. Switching sessions mid-turn also clears the flag —
// the turn goes on there, unwatched.
let _loadingSessionId: string | null = null;
watch(() => gateway.isLoading, (loading) => {
  const landedHere = _wasLoading && !loading && gateway.currentSessionId === _loadingSessionId;
  if (loading) _loadingSessionId = gateway.currentSessionId;
  // The answer is laid out just after the flag flips; its growth still belongs to the turn.
  if (landedHere) turnFollowUntil = Date.now() + LANDING_FOLLOW_MS;
  _wasLoading = loading;
});
watch(() => gateway.connected, async (connected) => {
  if (!connected) return;
  // Only a connection that may open a session opens one (hello-ok lists what it may call): a viewer
  // reads its chats. A refusal thrown here left the scenes, the jobs and the media settings below
  // unloaded, so one that comes anyway (the role changed since the handshake) is let go: the next
  // send says why.
  if (!gateway.currentSessionId && gateway.mayCall("session.create")) {
    await gateway.createSession().catch(() => undefined);
  }
  await multimodalStore.fetch();
  await gateway.loadScenes();
  await jobsStore.fetch();
  await scenesStore.fetch();
}, { immediate: true });

// onMounted intentionally omitted — the watch above handles the initial case,
// including when connected is already true at mount time.

onMounted(() => {
  adjustComposerHeight();
  approvalClockId = window.setInterval(() => {
    if (gateway.pendingApproval || gateway.pendingInputRequest) approvalNowMs.value = Date.now();
  }, 1_000);
});

onUnmounted(() => {
  if (approvalClockId !== null) {
    window.clearInterval(approvalClockId);
    approvalClockId = null;
  }
  clearWakeFeedbackTimer();
  stopWakeRecognition();
});
</script>

<style scoped>
/* The app shell (.app-shell + main.flex-1.min-h-0) sizes this area to exactly
   viewport-minus-header, including the dynamic mobile viewport, so the chat
   just fills its parent. */
.chat-viewport {
  height: 100%;
}

.approval-enter-active,
.approval-leave-active {
  transition: all 0.25s ease;
}
.approval-enter-from,
.approval-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

.approval-banner {
  position: fixed;
  left: clamp(1rem, 4vw, 2rem);
  right: clamp(1rem, 4vw, 2rem);
  /* above the composer when it is up, above its parked control when it is not */
  bottom: max(5.5rem, calc(env(safe-area-inset-bottom) + 5rem), calc(var(--bay-h, 0px) + 2.5rem));
  /* a question that waits for an answer beats the page's round controls (220) */
  z-index: var(--z-popover);
  max-width: 48rem;
  margin: 0 auto;
  overflow: hidden;
  border-radius: 1rem;
  border: 1px solid rgba(168, 85, 247, 0.62);
  background: rgba(13, 11, 26, 0.98);
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.42), 0 0 0 1px rgba(236, 72, 153, 0.08), 0 0 34px rgba(168, 85, 247, 0.26);
  padding: 1rem;
}

.approval-banner__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.65rem;
}

.approval-banner__eyebrow {
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: rgb(216 180 254);
}

.approval-banner__timer {
  flex: none;
  border-radius: 999px;
  border: 1px solid rgba(251, 191, 36, 0.24);
  background: rgba(120, 53, 15, 0.24);
  color: rgb(253 230 138);
  font-size: 0.72rem;
  font-weight: 600;
  padding: 0.2rem 0.55rem;
}

.approval-banner__copy {
  margin-bottom: 0.5rem;
  color: rgb(203 213 225);
  font-size: 0.9rem;
  line-height: 1.45;
}

.approval-banner__tool {
  display: inline-block;
  border-radius: 0.4rem;
  background: rgba(88, 28, 135, 0.36);
  color: rgb(216 180 254);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 0.78rem;
  padding: 0.1rem 0.38rem;
}

.approval-banner__args {
  max-height: min(11rem, 28vh);
  overflow: auto;
  border-radius: 0.65rem;
  border: 1px solid rgba(168, 85, 247, 0.22);
  background: rgba(2, 6, 23, 0.68);
  color: rgb(148 163 184);
  font-size: 0.75rem;
  line-height: 1.45;
  margin-bottom: 0.85rem;
  padding: 0.65rem 0.75rem;
}

.approval-banner__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.65rem;
}

.approval-banner__button {
  min-width: 7rem;
  border-radius: 0.75rem;
  padding: 0.55rem 1.05rem;
  font-size: 0.88rem;
  font-weight: 700;
}

.approval-banner__button--deny {
  border-color: rgba(239, 68, 68, 0.4);
  color: rgb(248 113 113);
}

@media (max-width: 640px) {
  .approval-banner {
    bottom: max(4.75rem, calc(env(safe-area-inset-bottom) + 4.5rem));
    padding: 0.85rem;
  }

  .approval-banner__header,
  .approval-banner__actions {
    align-items: stretch;
  }

  .approval-banner__button {
    flex: 1 1 8rem;
  }
}

.multimodal-action {
  display: inline-flex;
  align-items: center;
  color: rgb(191 219 254);
}

.multimodal-icon-button {
  /* own display so buttons without .multimodal-action (e.g. the thinking
     toggle) still center their icon + label instead of inline baseline flow */
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.3rem;
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

.wake-feedback-card {
  display: grid;
  gap: 0.55rem;
  margin-bottom: 0.8rem;
  padding: 0.8rem 0.9rem;
  border-radius: 1rem;
  border: 1px solid rgba(125, 211, 252, 0.18);
  background: linear-gradient(180deg, rgba(7, 18, 35, 0.9), rgba(9, 16, 30, 0.72));
  box-shadow: 0 18px 30px rgba(3, 8, 20, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.04);
}

.wake-feedback-card--listening {
  border-color: rgba(56, 189, 248, 0.24);
}

.wake-feedback-card--recording {
  border-color: rgba(34, 211, 238, 0.34);
  box-shadow: 0 0 0 1px rgba(34, 211, 238, 0.12), 0 18px 34px rgba(8, 145, 178, 0.18);
}

.wake-feedback-card--processing {
  border-color: rgba(168, 85, 247, 0.3);
  box-shadow: 0 0 0 1px rgba(168, 85, 247, 0.12), 0 18px 34px rgba(107, 33, 168, 0.18);
}

.wake-feedback-card--success {
  border-color: rgba(74, 222, 128, 0.3);
  box-shadow: 0 0 0 1px rgba(74, 222, 128, 0.1), 0 18px 34px rgba(21, 128, 61, 0.16);
}

.wake-feedback-card--error {
  border-color: rgba(248, 113, 113, 0.34);
  box-shadow: 0 0 0 1px rgba(248, 113, 113, 0.12), 0 18px 34px rgba(153, 27, 27, 0.18);
}

.wake-feedback-card__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.8rem;
}

.wake-feedback-card__eyebrow {
  font-size: 0.64rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: rgb(125 211 252);
}

.wake-feedback-card__title {
  margin-top: 0.18rem;
  font-size: 0.95rem;
  font-weight: 600;
  color: rgb(226 232 240);
}

.wake-feedback-card__steps {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  justify-content: flex-end;
}

.wake-feedback-card__step {
  border-radius: 9999px;
  border: 1px solid rgba(148, 163, 184, 0.18);
  background: rgba(15, 23, 42, 0.58);
  color: rgb(100 116 139);
  padding: 0.22rem 0.55rem;
  font-size: 0.62rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.wake-feedback-card__step--active {
  border-color: rgba(125, 211, 252, 0.32);
  background: rgba(8, 47, 73, 0.6);
  color: rgb(186 230 253);
}

.wake-feedback-card__message {
  font-size: 0.82rem;
  line-height: 1.45;
  color: rgb(191 219 254);
}

.wake-feedback-card__meter {
  position: relative;
  overflow: hidden;
  height: 0.34rem;
  border-radius: 9999px;
  background: rgba(15, 23, 42, 0.72);
}

.wake-feedback-card__meter-fill {
  display: block;
  width: 42%;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, rgba(56, 189, 248, 0.92), rgba(34, 211, 238, 0.72), rgba(168, 85, 247, 0.72));
  animation: wake-feedback-pulse 1.4s ease-in-out infinite;
}

@keyframes wake-feedback-pulse {
  0% { transform: translateX(-12%); opacity: 0.72; }
  50% { transform: translateX(90%); opacity: 1; }
  100% { transform: translateX(210%); opacity: 0.72; }
}

.voice-bar {
  display: grid;
  gap: 0.45rem;
  margin-bottom: 0.65rem;
  padding: 0.55rem 0.75rem;
  border-radius: 1rem;
  border: 1px solid rgba(125, 211, 252, 0.14);
  background: linear-gradient(180deg, rgba(8, 18, 32, 0.86), rgba(7, 14, 26, 0.68));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
}

.voice-bar__row {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  min-width: 0;
  flex-wrap: wrap;
}

.voice-bar__indicator {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 1.1rem;
  flex-shrink: 0;
}

.voice-bar__indicator > span {
  width: 3px;
  height: 30%;
  border-radius: 9999px;
  background: rgb(100 116 139);
  transition: background 0.2s ease;
}

.voice-bar__indicator--speaking > span {
  background: rgb(52 211 153);
  animation: voice-bar-wave 0.9s ease-in-out infinite;
}

.voice-bar__indicator--listening > span {
  background: rgb(56 189 248);
  animation: voice-bar-wave 1.6s ease-in-out infinite;
}

.voice-bar__indicator > span:nth-child(2) { animation-delay: 0.15s; }
.voice-bar__indicator > span:nth-child(3) { animation-delay: 0.3s; }

@keyframes voice-bar-wave {
  0%, 100% { height: 30%; }
  50% { height: 100%; }
}

@media (prefers-reduced-motion: reduce) {
  .voice-bar__indicator > span { animation: none !important; height: 60%; }
}

.voice-bar__text {
  display: grid;
  gap: 0.05rem;
  min-width: 0;
  flex: 1 1 10rem;
}

.voice-bar__eyebrow {
  font-size: 0.62rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: rgb(125 211 252);
}

.voice-bar__label {
  font-size: 0.76rem;
  color: rgb(203 213 225);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.voice-bar__label--notice {
  color: rgb(252 165 165);
}

.voice-bar__meter {
  width: 4.5rem;
  height: 0.22rem;
  border-radius: 9999px;
  background: rgba(56, 189, 248, 0.12);
  overflow: hidden;
  flex-shrink: 0;
}

.voice-bar__meter > span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: rgb(56 189 248);
  transition: width 0.08s linear;
}

.voice-bar__actions {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
  margin-left: auto;
}

.voice-bar__button {
  border-radius: 9999px;
  border: 1px solid rgba(125, 211, 252, 0.18);
  background: rgba(11, 26, 44, 0.7);
  color: rgb(224 242 254);
  font-size: 0.7rem;
  padding: 0.38rem 0.68rem;
  line-height: 1;
  transition: border-color 0.15s ease, background 0.15s ease, color 0.15s ease;
}

.voice-bar__button:hover {
  border-color: rgba(125, 211, 252, 0.38);
  background: rgba(16, 38, 63, 0.8);
  color: white;
}

.voice-bar__button--stop {
  border-color: rgba(248, 113, 113, 0.4);
  background: rgba(127, 29, 29, 0.45);
  color: rgb(254 226 226);
}

.voice-bar__button--stop:hover {
  border-color: rgba(248, 113, 113, 0.7);
  background: rgba(153, 27, 27, 0.6);
}

.voice-bar__close {
  color: rgb(100 116 139);
  font-size: 0.75rem;
  padding: 0.2rem 0.35rem;
  line-height: 1;
}

.voice-bar__close:hover {
  color: rgb(226 232 240);
}

.voice-bar__body {
  margin: 0;
  padding-top: 0.15rem;
  font-size: 0.72rem;
  line-height: 1.45;
  color: rgb(148 163 184);
  max-height: 10rem;
  overflow-y: auto;
}

.chat-dropdown__voice-settings {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr));
  gap: 0.5rem;
}

.chat-dropdown__voice-setting {
  display: grid;
  gap: 0.25rem;
  font-size: 0.68rem;
  color: rgb(148 163 184);
}

.chat-dropdown__select {
  border-radius: 0.7rem;
  border: 1px solid rgba(125, 211, 252, 0.16);
  background: rgba(11, 26, 44, 0.75);
  color: rgb(224 242 254);
  font-size: 0.74rem;
  padding: 0.35rem 0.5rem;
}

.chat-workspace {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 1rem;
}

.chat-main-column {
  min-height: 0;
}

.chat-message-scroll {
  height: 100%;
  overflow-y: auto;
  /* generous inline inset so bubbles never touch the viewport edges */
  padding: 0.5rem 1.25rem 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

/* ── Orbit corridor ─────────────────────────────────────────────────────
   On wide screens the entity owns the center of the viewport. The
   conversation sits on the flanks, each side at its OUTER edge — the
   assistant on the left, the user on the right — and every bubble ends
   before the orb's zone, so the orb and the steps orbiting it
   (OrbActivity.vue) stay in view. */
/* ── 3D depth on scroll ─────────────────────────────────────────────────
   Messages arrive from deep space at the bottom of the scroller, hold full
   presence through the middle band, and recede back into space as they
   leave past the orb at the top. Scroll-driven (compositor-only), with
   graceful fallback where view() timelines aren't supported. */
@supports (animation-timeline: view()) {
  @media (prefers-reduced-motion: no-preference) {
    .chat-message-scroll :deep(.message-row) {
      animation: msg-depth linear both;
      animation-timeline: view();
    }
  }
}
@keyframes msg-depth {
  0%   { opacity: 0; transform: perspective(900px) translateZ(-180px) translateY(30px) rotateX(8deg); }
  12%  { opacity: 1; transform: perspective(900px) translateZ(0) translateY(0) rotateX(0deg); }
  80%  { opacity: 1; transform: perspective(900px) translateZ(0) translateY(0) rotateX(0deg); }
  100% { opacity: 0; transform: perspective(900px) translateZ(-220px) translateY(-44px) rotateX(-10deg); }
}

/* Each side keeps a lane free at its outer edge for the round buttons parked there
   (--pod-lane-l / -r, composables/podLanes.ts), at every width: a question stands at the right
   edge on a phone too, and ran under the buttons there. */
.chat-message-scroll :deep(.message-row--ai) { padding-left: var(--pod-lane-l, 0px); }
.chat-message-scroll :deep(.message-row--user) { padding-right: var(--pod-lane-r, 0px); }

@media (min-width: 1100px) {
  /* The orb's zone, measured from the center: its body reaches
     about 14% of the viewport height (OrbCanvas.vue frames it by height),
     the ring of steps around it about 17%, and a margin. A bubble ends
     there, but never narrower than a readable 28rem: on a small window wide
     content may still cover part of the orb — readable content wins. */
  .chat-message-scroll { --orb-clear: calc(24vh + 1.5rem); }
  .chat-message-scroll :deep(.message-row--ai),
  .chat-message-scroll :deep(.message-row--user) {
    width: 100%;
  }
  /* Here the bubbles give the lanes' room (below) up at their outer side: half of it comes off
     the row they measure by, the other half off their own width, so their inner edge stays where
     the orb's zone begins. */
  .chat-message-scroll :deep(.message-row--ai) { justify-content: flex-start; }
  .chat-message-scroll :deep(.message-row--user) { justify-content: flex-end; }
  .chat-message-scroll :deep(.message-bubble--ai) {
    max-width: min(52rem, max(28rem, calc(50% - var(--orb-clear) - var(--pod-lane-l, 0px) / 2)));
  }
  .chat-message-scroll :deep(.message-bubble--user) {
    max-width: min(52rem, max(28rem, calc(50% - var(--orb-clear) - var(--pod-lane-r, 0px) / 2)));
  }
}

/* ── Fly-out input bay ──────────────────────────────────────────────────
   While idle the whole input area folds away below the viewport with a 3D
   tilt and its layout space collapses; its round control remains. */
/* Floating bottom panel: fixed and centered, so showing/hiding can never
   shift the page layout. The bay itself only does depth + fade. */
.chat-input-bay-wrap {
  position: fixed;
  left: 50%;
  bottom: 1.25rem;
  transform: translateX(-50%);
  /* above content/side panel, below the open nav panel (230) */
  z-index: 215;
  width: min(46rem, calc(100vw - 2rem));
  pointer-events: none;
}
.chat-input-bay {
  pointer-events: auto;
  transform: perspective(1200px) translateZ(0) translateY(0);
  transform-origin: bottom center;
  transition: transform 460ms var(--ease-out), opacity 320ms var(--ease-out);
}
.chat-input-bay--hidden {
  opacity: 0;
  pointer-events: none;
  /* recede into depth and fade — the bay drifts away from the viewer */
  transform: perspective(1200px) translateZ(-260px) translateY(14%);
}

/* Keep the newest messages readable above the open floating bay. */
.chat-message-scroll {
  transition: padding-bottom 460ms var(--ease-out);
}
.chat-message-scroll--bay-open {
  /* the bay's own height (--bay-h, set by the page), not a guess at it */
  padding-bottom: calc(var(--bay-h, 12rem) + 1.75rem);
}

/* ── The page's round controls ──────────────────────────────────────────
   The session, its actions and the message input (components/OrbNode.vue draws each one's face).
   On a wide window each stands at its station on the orbit round the orb, where the orb canvas
   draws its gimbal (composables/orbControls.ts); on a narrow one it is parked at the page's
   edge. This box is the control's place and size; its menu hangs from it. */
.orb-control {
  position: fixed;
  /* above the closed side-panel handle (201) so clicks always land, but
     below the OPEN side panel (scrim/panel/handle at 221–223) */
  z-index: 220;
  touch-action: none;
}
/* Behind the page (its <main> is a stacking context of its own, at 10) while one of the input
   bay's menus is open: the menu covers what it opens over. */
.orb-control--under { z-index: 9; }
/* On its orbit a control follows a resized window without a jump; a parked one follows the
   pointer that drags it at once. */
.orb-control--docked {
  transition: left 420ms var(--ease-out), top 420ms var(--ease-out), width 320ms var(--ease-out), height 320ms var(--ease-out);
}
/* The message input's control goes into the bay it opens and comes back out of it: down and
   away, towards the foot of the page. */
.composer-launcher-enter-active,
.composer-launcher-leave-active { transition: transform 360ms var(--ease-out), opacity 260ms var(--ease-out); }
.composer-launcher-enter-from,
.composer-launcher-leave-to { transform: perspective(700px) translateY(90%) translateZ(-120px) scale(0.6); opacity: 0; }

/* ── The controls' menus ────────────────────────────────────────────────
   A panel hangs beside its control, on the side away from the orb, at the end of a short leader
   line, and swings out from that side like a door. */
.session-pod {
  position: absolute;
  top: 50%;
  /* centred on its control by `translate`, which leaves `transform` to the door's swing */
  translate: 0 -50%;
  --leader-y: 50%;
  width: min(18rem, calc(100vw - 5rem));
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 0.8rem;
  border-radius: 0.5rem;
  border: 1px solid rgba(var(--logo-cyan), 0.2);
  background: var(--surface-3);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.45);
}
.session-pod--right { left: calc(100% + 0.85rem); transform-origin: 0 var(--leader-y); }
.session-pod--left  { right: calc(100% + 0.85rem); transform-origin: 100% var(--leader-y); }
/* The leader line from the control to its panel. */
.session-pod--right::before,
.session-pod--left::before {
  content: "";
  position: absolute;
  top: var(--leader-y);
  width: 0.85rem;
  height: 1px;
  pointer-events: none;
}
.session-pod--right::before {
  right: 100%;
  background: linear-gradient(90deg, rgba(var(--logo-cyan), 0.15), rgba(var(--logo-cyan), 0.7));
}
.session-pod--left::before {
  left: 100%;
  background: linear-gradient(270deg, rgba(var(--logo-cyan), 0.15), rgba(var(--logo-cyan), 0.7));
}
/* The swing: hinged at the leader's end, the far edge comes forward out of the depth. */
.node-panel-enter-active { transition: opacity 220ms var(--ease-out), transform 340ms var(--ease-out); }
.node-panel-leave-active { transition: opacity 160ms ease, transform 200ms ease; }
.session-pod--right.node-panel-enter-from,
.session-pod--right.node-panel-leave-to {
  opacity: 0;
  transform: perspective(900px) rotateY(42deg) scale(0.96);
}
.session-pod--left.node-panel-enter-from,
.session-pod--left.node-panel-leave-to {
  opacity: 0;
  transform: perspective(900px) rotateY(-42deg) scale(0.96);
}
.session-pod__row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.session-pod__label {
  font-family: var(--font-label);
  font-size: 0.62rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  color: rgba(165, 243, 252, 0.6);
}

/* The session actions: a list with names beside its control. Each row keeps its glyph as a tag
   and flies in a beat after the one above. */
.actions-pod {
  position: absolute;
  top: 0;
  /* the leader meets the control at its middle: half the control's own height down the list */
  --leader-y: calc(var(--node-size, 2.6rem) / 2);
  width: min(17.5rem, calc(100vw - 5rem));
  border-radius: 0.6rem;
  border: 1px solid rgba(var(--logo-cyan), 0.2);
  background: var(--surface-3);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.45);
}
.actions-pod__list {
  /* on a low window the list keeps to what is left of it under the control, and scrolls */
  max-height: var(--panel-room, none);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  padding: 0.45rem;
}
.actions-pod--up { top: auto; bottom: 0; --leader-y: calc(100% - var(--node-size, 2.6rem) / 2); }
.actions-pod__item {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  min-height: 2.75rem;
  padding: 0.4rem 0.55rem;
  border-radius: 0.45rem;
  border: 1px solid transparent;
  text-align: left;
  color: rgb(226, 232, 240);
  cursor: pointer;
  animation: actions-pod-in 260ms var(--ease-out) var(--delay, 0ms) both;
  transition: background-color 140ms var(--ease-out), border-color 140ms var(--ease-out);
}
@keyframes actions-pod-in {
  from { opacity: 0; transform: translateY(-6px); }
  to   { opacity: 1; transform: none; }
}
.actions-pod__item:hover:not(:disabled),
.actions-pod__item:focus-visible {
  background: rgba(var(--logo-cyan), 0.08);
  border-color: rgba(var(--logo-cyan), 0.3);
  outline: none;
}
.actions-pod__item:disabled { opacity: 0.45; cursor: not-allowed; }
/* A row's glyph: a tag in a hairline frame, like the marks on the orb's instruments. */
.actions-pod__glyph {
  flex: none;
  display: grid;
  place-items: center;
  width: 2rem;
  height: 1.55rem;
  border-radius: 0.25rem;
  font-family: var(--font-mono);
  font-size: 0.55rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  color: rgba(var(--logo-cyan), 0.92);
  border: 1px solid rgba(var(--logo-cyan), 0.28);
}
.actions-pod__text { display: grid; min-width: 0; }
.actions-pod__label { font-size: 0.82rem; font-weight: 500; line-height: 1.25; }
.actions-pod__hint {
  font-size: 0.68rem;
  line-height: 1.3;
  color: rgb(148, 163, 184);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.actions-pod__rule { height: 1px; margin: 0.25rem 0.3rem; background: var(--hairline); }
/* With no session there is nothing in the list: one line says where a session starts. */
.actions-pod__empty {
  margin: 0;
  padding: 0.8rem 0.9rem;
  font-size: 0.8rem;
  line-height: 1.45;
  color: rgb(148, 163, 184);
}
/* In the session's menu: a new session, set off from the picker above it. */
.session-pod__new {
  width: 100%;
  margin-top: 0.1rem;
  padding-left: 0.3rem;
  border-top: 1px solid var(--hairline);
  border-radius: 0 0 0.45rem 0.45rem;
  padding-top: 0.6rem;
}
.actions-pod__item--danger .actions-pod__label { color: rgb(254, 202, 202); }
.actions-pod__item--danger .actions-pod__glyph {
  border-color: rgba(248, 113, 113, 0.45);
  color: rgba(254, 202, 202, 0.95);
}
.actions-pod__item--danger:hover:not(:disabled),
.actions-pod__item--danger:focus-visible {
  background: rgba(248, 113, 113, 0.1);
  border-color: rgba(248, 113, 113, 0.4);
}

.chat-mobile-panels__summary::-webkit-details-marker,
.chat-dropdown__summary::-webkit-details-marker {
  display: none;
}

.chat-floating-inputs {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

/* At the foot of the page, clear of the message input's control: the entity owns its middle. */
.chat-starters {
  margin-top: auto;
  padding-bottom: 5.5rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.7rem;
  text-align: center;
}
/* Where that control stands on its orbit under the orb, and not in the page's corner, the
   starters can stand lower: on a low window they would meet it. */
@media (min-width: 1100px) {
  .chat-starters { padding-bottom: 2rem; }
}
@media (min-width: 1100px) and (max-height: 600px) {
  .chat-starters__lead { display: none; }
}

.chat-starters__lead {
  margin: 0;
  color: rgb(186 230 253 / 0.8);
  font-size: 0.9rem;
}

/* ── The start suggestions on their arc ─────────────────────────────────
   Each stands with its point on its station of the arc (left and top, set by the page); its words
   hang under the point at the arc's front and stand on the outer side of it further round. */
.orb-starters {
  position: fixed;
  inset: 0;
  /* under the page's controls (220), over the conversation's column */
  z-index: 219;
  pointer-events: none;
}
.orb-starters-leave-active { transition: opacity 200ms ease; }
.orb-starters-leave-to { opacity: 0; }

.orb-starter {
  position: absolute;
  display: inline-flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.25rem 0;
  border: 0;
  background: none;
  color: rgb(186 230 253);
  cursor: pointer;
  pointer-events: auto;
  -webkit-tap-highlight-color: transparent;
  animation: orb-starter-out 640ms var(--ease-out) var(--delay, 0ms) both;
}
/* The point is 10 px across, and its centre is the station. */
.orb-starter--right { transform: translate(-5px, -50%); }
.orb-starter--left {
  flex-direction: row-reverse;
  transform: translate(calc(-100% + 5px), -50%);
}
.orb-starter--below {
  flex-direction: column;
  gap: 0.45rem;
  padding: 0 0.25rem;
  transform: translate(-50%, -5px);
}
@keyframes orb-starter-out {
  from {
    opacity: 0;
    translate: var(--from-x, 0px) var(--from-y, 0px);
    scale: 0.3;
  }
}

.orb-starter__dot {
  flex: none;
  width: 10px;
  height: 10px;
  border-radius: 999px;
  border: 1.5px solid rgb(var(--logo-cyan));
  box-shadow: 0 0 8px rgba(var(--logo-cyan), 0.6), inset 0 0 4px rgba(var(--logo-cyan), 0.5);
  opacity: calc(0.25 + 0.75 * var(--depth, 1));
  transition: background-color 180ms var(--ease-out), box-shadow 180ms var(--ease-out), transform 180ms var(--ease-out);
}
.orb-starter__label {
  max-width: var(--label-max, 16rem);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 0.3rem 0.8rem;
  border-radius: 999px;
  border: 1px solid rgba(var(--logo-cyan), 0.26);
  background: rgba(var(--app-bg), 0.78);
  /* nearer is larger: 0.86rem at the front of the arc */
  font-size: calc(0.86rem * var(--depth, 1));
  line-height: 1.35;
  opacity: calc(0.3 + 0.7 * var(--depth, 1));
  transition: border-color 180ms var(--ease-out), color 180ms var(--ease-out), opacity 180ms var(--ease-out);
}
.orb-starter:hover .orb-starter__label,
.orb-starter:focus-visible .orb-starter__label {
  border-color: rgba(var(--logo-cyan), 0.7);
  color: #fff;
  opacity: 1;
}
.orb-starter:hover .orb-starter__dot,
.orb-starter:focus-visible .orb-starter__dot {
  background: rgb(var(--logo-cyan));
  box-shadow: 0 0 14px rgba(var(--logo-cyan), 0.9);
  opacity: 1;
  transform: scale(1.25);
}
.orb-starter:focus-visible { outline: none; }
.orb-starter:focus-visible .orb-starter__label {
  outline: 2px solid rgba(var(--logo-cyan), 0.85);
  outline-offset: 2px;
}

/* The line over the suggestions and the one under them, centred under the orb. */
.orb-starters__lead,
.orb-starters__hint {
  position: absolute;
  left: 50%;
  margin: 0;
  white-space: nowrap;
  animation: orb-starters-fade 500ms ease 260ms both;
}
.orb-starters__lead {
  transform: translate(-50%, -50%);
  color: rgb(186 230 253 / 0.8);
  font-size: 0.9rem;
}
.orb-starters__hint {
  display: none;
  transform: translateX(-50%);
  font-family: var(--font-label);
  font-size: 0.66rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: rgba(165, 243, 252, 0.45);
}
@media (hover: hover) and (pointer: fine) {
  .orb-starters__hint { display: block; }
}
@keyframes orb-starters-fade {
  from { opacity: 0; }
}

/* Only where there is a keyboard to type on. */
.chat-starters__hint {
  display: none;
  margin: 0.15rem 0 0;
  font-family: var(--font-label);
  font-size: 0.66rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: rgba(165, 243, 252, 0.45);
}
@media (hover: hover) and (pointer: fine) {
  .chat-starters__hint { display: block; }
}

/* Where the conversation lies over the orb and not beside it, the orb steps back. */
.chat-orb-layer { transition: opacity 600ms var(--ease-out); }
.chat-orb-layer--behind-text { opacity: 0.28; }

.chat-starters__list {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.5rem;
  max-width: 46rem;
}

.chat-starters__item {
  border-radius: 9999px;
  border: 1px solid rgba(125, 211, 252, 0.28);
  background: rgba(14, 32, 54, 0.72);
  color: rgb(186 230 253);
  padding: 0.42rem 0.9rem;
  font-size: 0.82rem;
  transition: border-color 0.15s ease, color 0.15s ease;
}

.chat-starters__item:hover,
.chat-starters__item:focus-visible {
  border-color: rgba(125, 211, 252, 0.48);
  color: white;
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

/* Smart-autoscroll resume pill — sits over the bottom of the message list
   while the user is scrolled up and new messages have arrived. Centered
   horizontally, doesn't block clicks on the message below it (only the pill
   itself is clickable; the surrounding container is pointer-events:none). */
.chat-scroll-resume {
  position: absolute;
  bottom: 0.85rem;
  left: 50%;
  transform: translateX(-50%);
  z-index: 25;
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.95rem;
  border-radius: 999px;
  background: rgba(168, 85, 247, 0.92);
  color: #fff;
  border: 1px solid rgba(216, 180, 254, 0.55);
  font-size: 0.78rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  cursor: pointer;
  box-shadow: 0 10px 24px rgba(15, 8, 32, 0.45);
  transition: background 120ms ease, transform 120ms ease;
}
.chat-scroll-resume:hover {
  background: rgba(168, 85, 247, 1);
  transform: translateX(-50%) translateY(-1px);
}
.chat-scroll-resume:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
}

.scroll-resume-enter-active,
.scroll-resume-leave-active {
  transition: opacity 220ms var(--ease-out), transform 260ms var(--ease-out);
}
.scroll-resume-enter-from,
.scroll-resume-leave-to {
  opacity: 0;
  transform: translateX(-50%) perspective(700px) translateY(14px) translateZ(-60px) scale(0.9);
}
.scroll-resume-enter-to,
.scroll-resume-leave-from {
  opacity: 1;
  transform: translateX(-50%) perspective(700px) translateY(0) translateZ(0) scale(1);
}

/* Drag-and-drop overlay shown while a file drag is hovering the chat surface.
   Sits above all chat content but below modals (z-30 vs z-50). Pointer-events
   stay on so the overlay itself receives the drop event. */
.chat-drop-overlay {
  position: absolute;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 17, 28, 0.78);
  backdrop-filter: blur(4px);
  pointer-events: none;
  animation: chatDropOverlayIn 120ms ease-out;
}

.chat-drop-overlay__panel {
  pointer-events: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.6rem;
  padding: 2rem 3rem;
  border-radius: 1.25rem;
  border: 2px dashed rgba(168, 85, 247, 0.55);
  background: rgba(31, 41, 55, 0.65);
  color: rgb(243 232 255);
  text-align: center;
  max-width: 32rem;
}

.chat-drop-overlay__icon {
  font-size: 2.4rem;
  line-height: 1;
}

.chat-drop-overlay__title {
  font-size: 1.15rem;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.chat-drop-overlay__hint {
  font-size: 0.85rem;
  color: rgb(196 181 253);
}

@keyframes chatDropOverlayIn {
  from { opacity: 0; }
  to   { opacity: 1; }
}

.chat-composer__field {
  min-width: 0;
  width: 100%;
  flex: 1 1 auto;
  position: relative;
}

.chat-composer__steering-note {
  margin-top: 0.3rem;
  font-size: 0.72rem;
  color: rgb(110 231 183);
  display: flex;
  align-items: center;
  gap: 0.35rem;
}
.chat-composer__steering-note--error { color: rgb(252 165 165); }

/* With the bay up, the pill stands above it: under it, it was hidden exactly when it mattered. */
.chat-scroll-resume--above-bay { bottom: calc(var(--bay-h, 12rem) + 1.25rem); }

/* Slash-command autocomplete popup. Anchored to the bottom of the field so it
   floats above the textarea — keyboard nav (↑↓), Enter/Tab to accept, Esc to
   dismiss. Mouse hover updates the active index for parity. */
.slash-popup {
  position: absolute;
  bottom: calc(100% + 0.45rem);
  left: 0;
  right: 0;
  z-index: 30;
  max-height: 18rem;
  overflow-y: auto;
  border-radius: 1rem;
  border: 1px solid rgba(168, 85, 247, 0.32);
  background: rgba(15, 17, 28, 0.96);
  backdrop-filter: blur(14px);
  box-shadow: 0 18px 38px rgba(15, 8, 32, 0.55);
  padding: 0.4rem 0.35rem 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.slash-popup__hint {
  padding: 0.2rem 0.65rem 0.4rem;
  font-size: 0.68rem;
  color: rgb(156 163 175);
  letter-spacing: 0.04em;
}

.slash-popup__item {
  appearance: none;
  border: none;
  background: transparent;
  text-align: left;
  display: grid;
  grid-template-columns: max-content max-content 1fr;
  align-items: baseline;
  gap: 0.65rem;
  padding: 0.45rem 0.65rem;
  border-radius: 0.6rem;
  color: rgb(229 231 235);
  cursor: pointer;
  transition: background 100ms ease, color 100ms ease;
}

.slash-popup__item:hover,
.slash-popup__item--active {
  background: rgba(168, 85, 247, 0.18);
  color: rgb(243 232 255);
}

.slash-popup__name {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 0.85rem;
  color: rgb(216 180 254);
  font-weight: 600;
  white-space: nowrap;
}

.slash-popup__kind {
  font-size: 0.62rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: rgb(156 163 175);
  background: rgba(75, 85, 99, 0.45);
  border-radius: 999px;
  padding: 0.08rem 0.45rem;
  align-self: center;
}

.slash-popup__desc {
  font-size: 0.78rem;
  color: rgb(156 163 175);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.slash-popup__item--active .slash-popup__desc { color: rgb(209 213 219); }
.slash-popup__item--active .slash-popup__kind { color: rgb(216 180 254); background: rgba(168, 85, 247, 0.28); }

.chat-composer__textarea {
  width: 100%;
  resize: none;
  border-radius: var(--radius-xl);
  border: 1px solid var(--hairline);
  background: var(--surface-1);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  box-shadow: var(--shadow-1), inset 0 1px 0 var(--highlight-top);
  padding: 0.78rem 1rem;
  color: rgb(243 244 246);
  font-size: 0.92rem;
  line-height: 1.42;
  transition: border-color 0.2s ease, background 0.2s ease, box-shadow 0.25s ease, padding 0.2s ease, min-height 0.2s ease;
}

.chat-composer__textarea:hover {
  border-color: var(--hairline-strong);
}

.chat-composer__textarea:focus {
  outline: none;
  border-color: var(--hairline-strong);
  background: var(--surface-2);
  /* Soft accent halo — the "console is listening" cue. */
  box-shadow: var(--shadow-1),
              inset 0 1px 0 var(--highlight-top),
              0 0 0 3px rgba(var(--accent-purple), 0.14),
              0 0 24px rgba(var(--accent-purple), 0.18);
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

/* Two stacked control rows: dropdowns + thinking toggle on top, Send/Stop
   below stretched to the same width as the row above, items vertically
   centered on a 2.75rem line. */
.chat-composer__controls {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
  align-items: stretch;
}

.chat-composer__menus,
.chat-composer__primary-actions {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 0.55rem;
  flex-wrap: wrap;
}

/* Send/Stop fills the full column width. */
.chat-composer__primary-actions > button { flex: 1 1 auto; }

/* Stop: a square beside the word; a spinner in its place while the turn is being stopped. */
.chat-stop {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
}
.chat-stop__glyph {
  flex: none;
  width: 0.68rem;
  height: 0.68rem;
  border-radius: 2px;
  background: currentColor;
}
.chat-stop__glyph--busy {
  width: 0.8rem;
  height: 0.8rem;
  margin: -0.06rem;
  border-radius: 999px;
  background: transparent;
  border: 2px solid rgba(255, 255, 255, 0.32);
  border-top-color: #fff;
  animation: chatStopSpin 0.8s linear infinite;
}
@keyframes chatStopSpin {
  to { transform: rotate(360deg); }
}

/* Thinking ON: the state reads through glow alone — cyan halo on the
   button, bloom on the brain glyph. */
.thinking-toggle--on {
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.05),
    0 0 0 1px rgba(var(--logo-cyan), 0.25),
    0 0 18px rgba(var(--logo-cyan), 0.45);
}
.thinking-toggle--on .multimodal-icon {
  color: rgb(var(--logo-cyan));
  filter: drop-shadow(0 0 4px rgba(var(--logo-cyan), 0.9));
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
  min-height: 2.75rem;
  border-radius: 1rem;
  border: 1px solid rgba(125, 211, 252, 0.2);
  background: linear-gradient(180deg, rgba(9, 18, 34, 0.85), rgba(8, 15, 28, 0.68));
  color: rgb(224 242 254);
  padding: 0.5rem 0.9rem;
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
  /* From the chip's left edge, opening rightwards into the bay: the chips stand at the bay's left
     edge, and a menu hung from a chip's right edge opened out of the bay — at 1100 px the Options
     menu began 77 px left of the window, with Attach, audio and Record as its first items. */
  left: 0;
  bottom: calc(100% + 0.65rem);
  width: min(24rem, calc(100vw - 2.5rem));
  max-height: min(70vh, 32rem);
  overflow-y: auto;
  z-index: 30;
  border-radius: 1.3rem;
  border: 1px solid rgba(168, 85, 247, 0.18);
  /* opaque enough that the composer's text under it does not read through */
  background: linear-gradient(180deg, rgba(6, 10, 20, 0.985), rgba(10, 14, 28, 0.975));
  box-shadow: 0 24px 50px rgba(0, 0, 0, 0.38);
  padding: 0.9rem;
  display: grid;
  gap: 0.9rem;
  transform-origin: bottom left;
  animation: hud-rise 300ms var(--ease-out) both;
}

/* Entry-in-space for elements that mount via v-if (no <Transition> needed;
   the global motion law: depth + opacity + size on every appearance). */
.wake-feedback-card,
.chat-job-strip__item,
.multimodal-status {
  animation: hud-rise 340ms var(--ease-out) both;
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

/* ── Panel artifact viewer styles ──────────────────────────────────── */
.panel-artifact-list {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  flex-shrink: 0;
  max-height: 10rem;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(168, 85, 247, 0.2) transparent;
}

.panel-artifact-pill {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.45rem 0.65rem;
  border-radius: 0.6rem;
  border: 1px solid rgba(168, 85, 247, 0.15);
  background: rgba(255, 255, 255, 0.03);
  color: rgb(148 163 184);
  font-size: 0.78rem;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
  overflow: hidden;
}

.panel-artifact-pill:hover {
  background: rgba(88, 28, 135, 0.2);
  border-color: rgba(168, 85, 247, 0.35);
  color: rgb(216 180 254);
}

.panel-artifact-pill--active {
  background: rgba(88, 28, 135, 0.38);
  border-color: rgba(168, 85, 247, 0.5);
  color: rgb(233 213 255);
}

.panel-artifact-pill__icon {
  flex-shrink: 0;
  font-size: 0.8rem;
  line-height: 1;
  opacity: 0.8;
}

.panel-artifact-pill__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.panel-artifact-preview {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-radius: 0.75rem;
  border: 1px solid rgba(168, 85, 247, 0.15);
  overflow: hidden;
  background: rgba(5, 5, 15, 0.6);
}

.panel-artifact-preview__hint {
  padding: 2rem 1rem;
  text-align: center;
  font-size: 0.8rem;
  color: rgb(71 85 105);
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.panel-artifact-preview__loading {
  padding: 2rem 1rem;
  text-align: center;
  font-size: 0.8rem;
  color: rgb(148 163 184);
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
}

.panel-artifact-preview__error {
  padding: 1rem;
  font-size: 0.78rem;
  color: rgb(252 165 165);
  background: rgba(239, 68, 68, 0.08);
  border-top: 1px solid rgba(239, 68, 68, 0.2);
  flex: 1;
}

.panel-artifact-frame {
  flex: 1;
  width: 100%;
  border: none;
  background: #fff;
  min-height: 0;
  display: block;
}

.panel-artifact-audio {
  width: 100%;
  padding: 1rem;
}

.panel-artifact-text {
  flex: 1;
  overflow: auto;
  padding: 0.75rem;
  margin: 0;
  font-size: 0.72rem;
  line-height: 1.5;
  color: rgb(148 163 184);
  font-family: ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, Consolas, "DejaVu Sans Mono", monospace;
  white-space: pre-wrap;
  word-break: break-word;
  scrollbar-width: thin;
  scrollbar-color: rgba(168, 85, 247, 0.2) transparent;
}

.panel-artifact-toolbar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0;
  flex-shrink: 0;
}

.panel-artifact-download-prompt {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 2rem 1rem;
  text-align: center;
}

.panel-artifact-download-prompt__icon {
  font-size: 2rem;
  line-height: 1;
  opacity: 0.6;
}

.panel-artifact-download-prompt__name {
  font-size: 0.85rem;
  color: rgb(216 180 254);
  font-weight: 500;
  margin: 0;
  word-break: break-word;
}

.panel-artifact-download-prompt__hint {
  font-size: 0.75rem;
  color: rgb(71 85 105);
  margin: 0;
}

/* The message field takes the bay's whole width and the controls sit in one row under it. On a
   wide screen they used to stand BESIDE the field and left it some 300 px: a prompt wrapped
   after 35 characters, in a bay 736 px wide. */
@media (min-width: 1024px) {
  .chat-composer__controls {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    gap: 0.9rem;
  }
  /* The chips give way, the actions never: when the words get long (another language, a larger
     font) the chips wrap onto a second line — they used to be held on one, and the actions were
     pushed over them and out of the bay. */
  .chat-composer__menus { flex: 1 1 auto; min-width: 0; }
  .chat-composer__primary-actions { flex: none; flex-wrap: nowrap; }
  .chat-composer__primary-actions > button { flex: none; min-width: 8.5rem; }
  /* Two actions while a turn runs, each as wide as its word. */
  .chat-composer__primary-actions--running > button { min-width: 0; }
}

/* Below that the controls stack and the chips wrap, so a chip can stand anywhere in the row: the
   menus hang from the ROW's left edge there, no wider than the row. From its own chip the Effort
   menu ran 110 px out of a phone's right edge. */
@media (max-width: 1023px) {
  .chat-composer__menus { position: relative; }
  .chat-composer__menus > .chat-dropdown { position: static; }
  .chat-composer__menus > .chat-dropdown > .chat-dropdown__menu { max-width: 100%; }
}

/* Motion on request only (the bay's 3D recede, the controls' moves and menus, the fly-ins). */
@media (prefers-reduced-motion: reduce) {
  .chat-input-bay,
  .orb-control,
  .orb-starter,
  .orb-starters__lead,
  .orb-starters__hint,
  .orb-option,
  .orb-option > .chat-dropdown__menu,
  .session-pod,
  .actions-pod,
  .chat-orb-layer,
  .chat-scroll-resume,
  .chat-drop-overlay {
    transition-duration: 1ms !important;
    animation: none !important;
  }
  .chat-input-bay--hidden { transform: none; }
  .actions-pod__item,
  .chat-dropdown__menu,
  .wake-feedback-card,
  .chat-job-strip__item,
  .multimodal-status {
    animation: none !important;
  }
}

/* The ✕ on an attachment chip: a target a finger can hit, not a 12-pixel glyph. */
.chip-remove {
  display: inline-grid;
  place-items: center;
  min-width: 1.75rem;
  min-height: 1.75rem;
  border-radius: 999px;
  font-size: 0.75rem;
  line-height: 1;
  transition: color 0.15s, background-color 0.15s;
}
.chip-remove:hover, .chip-remove:focus-visible {
  background: rgba(248, 113, 113, 0.14);
  outline: none;
}

/* A suggestion to step in: it lay in the page's flow under the composer, which covered it while
   a turn ran — exactly when it appears. It floats above the composer now, like the approval. */
.intervention-banner {
  position: fixed;
  left: clamp(1rem, 4vw, 2rem);
  right: clamp(1rem, 4vw, 2rem);
  bottom: max(5.5rem, calc(var(--bay-h, 0px) + 2.5rem));
  z-index: var(--z-popover);
  max-width: 48rem;
  margin: 0 auto;
}

/* The Effort menu: one row per tier, the current one marked, "max" flagged. */
.chat-dropdown__summary--effort { min-width: 0; font-size: 0.75rem; font-weight: 600; }
.chat-dropdown__menu--effort { width: min(26rem, calc(100vw - 2.5rem)); gap: 0.35rem; }
.effort-option {
  display: grid;
  gap: 0.15rem;
  padding: 0.55rem 0.7rem;
  border-radius: 0.7rem;
  border: 1px solid transparent;
  text-align: left;
  cursor: pointer;
  transition: background-color 140ms var(--ease-out), border-color 140ms var(--ease-out);
}
.effort-option:hover, .effort-option:focus-visible {
  background: rgba(var(--logo-cyan), 0.07);
  border-color: rgba(var(--logo-cyan), 0.28);
  outline: none;
}
.effort-option--current { border-color: rgba(var(--logo-cyan), 0.45); background: rgba(var(--logo-cyan), 0.06); }
.effort-option__name {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.82rem;
  font-weight: 600;
  color: rgb(226, 232, 240);
}
.effort-option__check { margin-left: auto; color: rgb(var(--logo-cyan)); }
.effort-option__flag {
  font-family: var(--font-label);
  font-size: 0.58rem;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  padding: 0.1rem 0.4rem;
  border-radius: 999px;
  border: 1px solid rgba(251, 191, 36, 0.45);
  color: rgb(252, 211, 77);
}
.effort-option__text { font-size: 0.72rem; line-height: 1.4; color: rgb(148, 163, 184); }

/* ── The input's options on the orbit ───────────────────────────────────
   While they stand there (Chat.vue optionsDocked) the bay keeps its field and its Send button,
   side by side; the options are placed from the bay's own box, whose centre line is the
   viewport's and whose foot stands a fixed way over the window's, so each sits on its station of
   the controls' orbit, where the orb canvas draws its gimbal. (After the chips' own rules, which
   these replace.) */
.chat-composer--docked {
  flex-direction: row;
  align-items: flex-end;
  gap: 0.75rem;
}
.chat-composer--docked .chat-composer__field { flex: 1 1 auto; min-width: 0; }
.chat-composer--docked .chat-composer__controls,
.chat-composer--docked .chat-composer__menus { display: contents; }
.chat-composer--docked .chat-composer__primary-actions { flex: none; flex-wrap: nowrap; }

.orb-option {
  position: absolute;
  z-index: 2;
  /* Out from where the message input's control stands, each a beat after the one before; back
     into it as the bay folds away. */
  transition:
    transform 440ms var(--ease-out) var(--delay, 0ms),
    opacity 300ms var(--ease-out) var(--delay, 0ms),
    left 420ms var(--ease-out), bottom 420ms var(--ease-out);
}
.orb-option--away {
  opacity: 0;
  transform: translate(var(--away-x, 0px), var(--away-y, 0px)) scale(0.4);
  pointer-events: none;
}
/* An option's menu is above its neighbours on the orbit. */
.orb-option[open] { z-index: 3; }

/* A menu's summary is the node's face here, not a chip. */
.orb-option > .chat-dropdown__summary {
  position: absolute;
  inset: 0;
  display: block;
  min-width: 0;
  min-height: 0;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: none;
}
.orb-option > .chat-dropdown__summary:focus-visible {
  outline: 2px solid rgba(var(--logo-cyan), 0.85);
  outline-offset: 4px;
}
.orb-option > .chat-dropdown__summary:focus-visible :deep(.orb-node) { transform: scale(1.07); }

/* A menu hangs beside its option, on the side away from the middle, at the end of a short leader
   line; it stands on the option's foot and grows upwards, and swings out like a door. */
.orb-option > .chat-dropdown__menu {
  left: auto;
  right: auto;
  bottom: 0;
  width: min(24rem, var(--panel-w, 24rem));
  max-height: var(--panel-room, 32rem);
  border-radius: 0.6rem;
  border-color: rgba(var(--logo-cyan), 0.22);
}
.orb-option > .chat-dropdown__menu--jobs { width: min(30rem, var(--panel-w, 30rem)); }
.orb-option > .chat-dropdown__menu--effort { width: min(26rem, var(--panel-w, 26rem)); }
.orb-option--left > .chat-dropdown__menu {
  right: calc(100% + 0.85rem);
  transform-origin: 100% calc(100% - var(--node-size, 2.6rem) / 2);
  animation: option-panel-left 340ms var(--ease-out) both;
}
.orb-option--right > .chat-dropdown__menu {
  left: calc(100% + 0.85rem);
  transform-origin: 0 calc(100% - var(--node-size, 2.6rem) / 2);
  animation: option-panel-right 340ms var(--ease-out) both;
}
@keyframes option-panel-left {
  from { opacity: 0; transform: perspective(900px) rotateY(-42deg) scale(0.96); }
  to   { opacity: 1; transform: none; }
}
@keyframes option-panel-right {
  from { opacity: 0; transform: perspective(900px) rotateY(42deg) scale(0.96); }
  to   { opacity: 1; transform: none; }
}
.orb-option[open]::after {
  content: "";
  position: absolute;
  top: 50%;
  width: 0.85rem;
  height: 1px;
  pointer-events: none;
}
.orb-option--left[open]::after {
  right: 100%;
  background: linear-gradient(270deg, rgba(var(--logo-cyan), 0.15), rgba(var(--logo-cyan), 0.7));
}
.orb-option--right[open]::after {
  left: 100%;
  background: linear-gradient(90deg, rgba(var(--logo-cyan), 0.15), rgba(var(--logo-cyan), 0.7));
}

/* Small controls get a finger-sized target on touch screens; a mouse keeps the compact look. */
@media (pointer: coarse) {
  .voice-bar__button,
  .voice-bar__close { min-height: 2.5rem; min-width: 2.5rem; }
  .chat-job-strip__item button,
  .session-pod button { min-height: 2.25rem; }
  .actions-pod__item { min-height: 3rem; }
}
</style>
