<template>
  <!-- The shell is what scrolls, so it carries the scroll watch for the index. Any input from
       the reader hands the scroll position back to them (see holdCard in the script). -->
  <div
    ref="shellEl"
    class="page-shell"
    :style="indexHeight ? { '--settings-index-h': `${indexHeight}px` } : undefined"
    @scroll.passive="scheduleSpy"
    @wheel.passive="releaseHold"
    @touchmove.passive="releaseHold"
    @pointerdown="releaseHold"
    @keydown="releaseHold"
  >

    <!-- Held to the grid's width so the title lines up with the cards on a wide screen. -->
    <header class="page-header mx-auto max-w-[1400px]">
      <div class="page-header__text">
        <h1 class="page-title">{{ pageTitle }}</h1>
        <p class="page-subtitle">{{ pageDescription }}</p>
      </div>
    </header>

    <!-- Section index: a filter over this route's cards and one chip per card, in page order.
         Built from SETTINGS_CARDS, which also names the anchors other pages link to. -->
    <nav ref="indexEl" class="settings-index" aria-label="Sections on this page">
      <div class="settings-index__find">
        <label for="settings-find" class="sr-only">Find a setting</label>
        <input
          id="settings-find"
          ref="filterInputEl"
          v-model="settingFilter"
          type="search"
          class="input-box settings-index__input"
          placeholder="Find a setting…"
          autocomplete="off"
          spellcheck="false"
          @keydown.esc="clearFilter()"
        />
      </div>
      <ul ref="chipRowEl" class="settings-index__chips">
        <li v-for="card in pageCards" :key="card.id">
          <!-- A real link, so a chip can be copied or opened in a new tab; a plain click
               scrolls instead of navigating. A card with unsaved changes carries a dot. -->
          <a
            :href="`#${card.id}`"
            class="settings-index__chip"
            :class="{ 'settings-index__chip--dim': !isCardShown(card.id) }"
            :aria-current="currentCardId === card.id ? 'true' : undefined"
            :title="isCardDirty(card.id) ? 'Unsaved changes' : undefined"
            @click.exact.prevent="goToCard(card.id)"
          >{{ card.label }}<template v-if="isCardDirty(card.id)"><span class="settings-index__dot" aria-hidden="true"></span><span class="sr-only"> (unsaved changes)</span></template></a>
        </li>
      </ul>
    </nav>

    <!-- Always in the page, so a screen reader hears the line when it appears. -->
    <div class="settings-no-match" role="status">
      <p v-if="noCardShown" class="notice">
        No setting matches “{{ settingFilter.trim() }}”.
        <button type="button" class="btn-ghost ml-2 px-3 py-1 rounded-lg text-xs" @click="clearFilter(true)">Clear</button>
      </p>
    </div>

    <div ref="gridEl" class="settings-grid" :class="{ 'settings-grid--filtered': filterTerms.length > 0 }">

      <!-- ══ LEFT COLUMN ══════════════════════════════════════════════════════ -->
      <div class="space-y-5">

        <!-- ── Appearance ─────────────────────────────────────────────────── -->
        <div id="appearance" v-if="isSettingsPage" v-show="isCardShown('appearance')" class="glass-card settings-card p-5">
          <div class="flex items-baseline gap-3 flex-wrap mb-1">
            <h3 class="section-title mb-0" tabindex="-1">Appearance</h3>
            <span class="eyebrow applies-now" title="A preset, palette or typeface is used, and stored in this browser, as soon as you pick it.">Applies immediately</span>
          </div>
          <div class="text-xs text-gray-500 mb-4">Palette, typeface, and curated presets. Saved in this browser.</div>
          <AppearanceSettings />
        </div>

        <!-- ── Gateway Connection ─────────────────────────────────────────── -->
        <div id="gateway-connection" v-if="isSettingsPage" v-show="isCardShown('gateway-connection')" class="glass-card settings-card p-5">
          <div class="flex items-center justify-between mb-4 gap-3 flex-wrap">
            <h3 class="section-title mb-0" tabindex="-1">Gateway Connection</h3>
            <span v-if="isCardDirty('gateway-connection')" class="unsaved-chip">Unsaved</span>
          </div>
          <!-- Both fields edit a draft: the stored URL and token, which every page's requests
               read, change only when Reconnect is pressed. -->
          <div class="space-y-4">
            <div>
              <label for="gateway-ws-url" class="field-label">WebSocket URL</label>
              <input id="gateway-ws-url" v-model="gatewayDraft.wsUrl" type="text" class="input-box" autocomplete="off" spellcheck="false" />
            </div>
            <div>
              <label for="gateway-token" class="field-label">Token</label>
              <input id="gateway-token" v-model="gatewayDraft.token" type="password" class="input-box" autocomplete="current-password" />
            </div>
            <div class="text-xs text-gray-500">A changed URL or token is used from the moment you press Reconnect.</div>
            <div v-if="gatewayDraft.error" class="text-sm text-red-400" role="alert">{{ gatewayDraft.error }}</div>
            <div class="flex gap-2 pt-1 flex-wrap">
              <button type="button" @click="applyGatewayConnection" class="btn-grad px-4 py-2 rounded-xl text-sm">Reconnect</button>
              <button type="button" @click="gateway.disconnect()" class="btn-ghost px-4 py-2 rounded-xl text-sm">Disconnect</button>
              <button type="button" @click="revertGatewayDraft" :disabled="!isCardDirty('gateway-connection')" class="btn-ghost px-4 py-2 rounded-xl text-sm">Revert</button>
            </div>
          </div>
        </div>

        <!-- ── Status ─────────────────────────────────────────────────────── -->
        <div id="status" v-if="isSettingsPage" v-show="isCardShown('status')" class="glass-card settings-card p-5">
          <h3 class="section-title" tabindex="-1">Status</h3>
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
            <div v-else-if="runtime.error" class="text-xs text-red-400">{{ shownError(runtime.error) }}</div>
            <div v-else-if="runtime.snapshot" class="space-y-1.5 pt-1">
              <div v-for="component in runtime.snapshot.components" :key="component.name" class="flex items-start justify-between gap-3 text-xs">
                <div class="min-w-0">
                  <div class="text-gray-300">{{ formatRuntimeName(component.name) }}</div>
                  <div v-if="component.lastError" class="text-red-400 truncate" :title="component.lastError">{{ component.lastError }}</div>
                </div>
                <span :class="component.healthy ? 'text-green-400' : 'text-amber-400'">{{ component.healthy ? 'ok' : 'degraded' }}</span>
              </div>
            </div>
          </div>
        </div>

        <div id="personality" v-if="isAgentsPage" v-show="isCardShown('personality')" class="glass-card settings-card p-5">
          <div class="flex items-center justify-between mb-4 gap-3 flex-wrap">
            <div>
              <h3 class="section-title mb-0" tabindex="-1">Main AI Personality</h3>
              <div class="text-xs text-gray-500 mt-1">Persistent voice guidance injected into the main assistant prompt and shared with the assistant’s self-profile tools.</div>
            </div>
            <div class="flex items-center gap-2 flex-wrap">
              <span v-if="isCardDirty('personality')" class="unsaved-chip">Unsaved</span>
              <button type="button" v-if="gateway.connected" @click="personalityStore.fetch()" :disabled="personalityStore.loading || personalityStore.saving" class="btn-ghost px-3 py-1.5 rounded-lg text-xs">Reload</button>
              <button type="button" @click="revertCard('personality')" :disabled="!isCardDirty('personality') || personalityStore.loading || personalityStore.saving" class="btn-ghost px-3 py-1.5 rounded-lg text-xs">Revert</button>
              <button type="button" @click="restoreDefaultPersonality" :disabled="!gateway.connected || personalityStore.loading || personalityStore.saving" class="btn-ghost px-3 py-1.5 rounded-lg text-xs">Defaults</button>
            </div>
          </div>

          <div v-if="!gateway.connected" class="empty-state">Connect to edit the main assistant personality.</div>
          <div v-else-if="personalityStore.loading && !personalityStore.profile" class="empty-state">Loading…</div>
          <div v-else class="space-y-4">
            <div class="rounded-xl border border-cyan-500/15 bg-cyan-500/5 px-3 py-2 text-xs text-cyan-100/80">
              Keep this focused on tone, style, and durable preferences. It does not override safety rules or access boundaries.
            </div>

            <div class="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs text-gray-400">
              The main assistant now mirrors the user's language automatically. If the message language is unclear, it falls back to German.
            </div>

            <div v-if="personalityStore.profile" class="flex flex-wrap gap-2 text-[11px] text-gray-500">
              <span class="badge-store">rev {{ personalityStore.profile.revision }}</span>
              <span class="badge-config">updated by {{ personalityStore.profile.updatedBy }}</span>
              <span class="badge-config">{{ formatPersonalityUpdatedAt(personalityStore.profile.updatedAt) }}</span>
              <span v-if="personalityStore.profile.reason" class="badge-config max-w-full truncate" :title="personalityStore.profile.reason">{{ personalityStore.profile.reason }}</span>
            </div>

            <div>
              <label class="field-label">Assistant Name <span class="text-gray-600 font-normal">optional</span></label>
              <input v-model="personalityForm.name" type="text" class="input-box" placeholder="e.g. Luna" />
            </div>

            <div>
              <label for="personality-identity" class="field-label">Identity <span class="field-required" aria-hidden="true">*</span></label>
              <textarea id="personality-identity" v-model="personalityForm.identity" rows="3" required aria-required="true" class="input-box min-h-[96px]" placeholder="Core identity and overall vibe for the main assistant." />
            </div>

            <div class="multimodal-grid">
              <div>
                <label class="field-label">Tone <span class="text-gray-600 font-normal">one per line</span></label>
                <textarea v-model="personalityForm.toneText" rows="5" class="input-box min-h-[132px]" placeholder="Direct and plainspoken." />
              </div>
              <div>
                <label class="field-label">Style <span class="text-gray-600 font-normal">one per line</span></label>
                <textarea v-model="personalityForm.styleText" rows="5" class="input-box min-h-[132px]" placeholder="Lead with the decisive tradeoff." />
              </div>
              <div>
                <label class="field-label">Collaboration Defaults <span class="text-gray-600 font-normal">one per line</span></label>
                <textarea v-model="personalityForm.defaultsText" rows="4" class="input-box min-h-[112px]" placeholder="Lead with the decisive tradeoff before listing options." />
              </div>
              <div>
                <label class="field-label">Avoidances <span class="text-gray-600 font-normal">one per line</span></label>
                <textarea v-model="personalityForm.avoidancesText" rows="4" class="input-box min-h-[112px]" placeholder="Do not become flattering, theatrical, or vague." />
              </div>
              <div>
                <label class="field-label">Quirks <span class="text-gray-600 font-normal">one per line</span></label>
                <textarea v-model="personalityForm.quirksText" rows="4" class="input-box min-h-[112px]" placeholder="Dry humor when it helps." />
              </div>
              <div>
                <label class="field-label">Growth Notes <span class="text-gray-600 font-normal">one per line</span></label>
                <textarea v-model="personalityForm.growthNotesText" rows="4" class="input-box min-h-[112px]" placeholder="Stable lessons the assistant should carry forward." />
              </div>
            </div>

            <div>
              <label class="field-label">Change Note <span class="text-gray-600 font-normal">optional</span></label>
              <input v-model="personalityForm.reason" type="text" class="input-box" placeholder="Why this durable personality change matters." />
            </div>

            <div v-if="personalityForm.error || personalityStore.error" class="text-sm text-red-400">{{ shownError(personalityForm.error || personalityStore.error) }}</div>

            <div class="flex justify-end">
              <button type="button" @click="submitPersonalityForm" :disabled="personalityStore.loading || personalityStore.saving" class="btn-grad px-5 py-2 rounded-xl text-sm">
                {{ personalityStore.saving ? 'Saving…' : 'Save Personality' }}
              </button>
            </div>
          </div>
        </div>

        <div id="model-endpoints" v-if="isAgentsPage" v-show="isCardShown('model-endpoints')" class="glass-card settings-card p-5">
          <h3 class="section-title" tabindex="-1">Model Endpoints</h3>
          <div class="space-y-3 text-sm">
            <div class="flex justify-between items-center">
              <span class="text-gray-400">Endpoint Health</span>
              <div class="flex items-center gap-2">
                <span :class="['status-dot', runtime.modelEndpoints?.healthy ? 'status-dot--on' : 'status-dot--off']" />
                <span :class="runtime.modelEndpoints?.healthy ? 'text-green-400' : 'text-amber-400'">
                  {{ runtime.modelEndpoints?.healthy ? 'Healthy' : 'Needs Attention' }}
                </span>
              </div>
            </div>
            <div v-if="runtime.modelEndpointError" class="text-xs text-red-400">{{ shownError(runtime.modelEndpointError) }}</div>
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

        <!-- Orchestration Tuning, Skill Library and Document RAG stand in this column: in the
             right one they left /agents with two cards here and seven there. Only the column
             break moved; the order of the cards is the one they always had. -->
          <!-- ── Orchestration Tuning ────────────────────────────────── -->
          <div id="orchestration-tuning" v-if="isAgentsPage" v-show="isCardShown('orchestration-tuning')" class="glass-card settings-card p-5">
            <div class="flex items-center justify-between mb-4 gap-3 flex-wrap">
              <div>
                <h3 class="section-title mb-0" tabindex="-1">Orchestration Tuning</h3>
                <div class="text-xs text-gray-500 mt-1">Adjust limits to match your hardware. Leave a field at its default to use the built-in value.</div>
              </div>
              <div class="flex items-center gap-2 flex-wrap">
                <span v-if="isCardDirty('orchestration-tuning')" class="unsaved-chip">Unsaved</span>
                <button type="button" v-if="gateway.connected" @click="reloadOrchestrationConfig" :disabled="orchestrationSaving" class="btn-ghost px-3 py-1.5 rounded-lg text-xs">Reload</button>
                <button type="button" @click="revertCard('orchestration-tuning')" :disabled="!isCardDirty('orchestration-tuning') || orchestrationSaving" class="btn-ghost px-3 py-1.5 rounded-lg text-xs">Revert</button>
              </div>
            </div>

            <div v-if="!gateway.connected" class="empty-state">Connect to configure orchestration limits.</div>
            <div v-else class="space-y-4">
              <div class="rounded-xl border border-cyan-500/15 bg-cyan-500/5 px-3 py-2 text-xs text-cyan-100/80">
                The limits wait for Save Limits; once saved they take effect without a restart.
              </div>

              <!-- Default effort tier (seeds new sessions; per-session override in chat). The one
                   field of this card that does not wait for Save, so it says so. -->
              <div class="multimodal-grid">
                <div>
                  <div class="flex items-baseline justify-between gap-2 flex-wrap">
                    <label for="default-effort" class="field-label">Default Effort <span class="text-gray-600 font-normal">new sessions inherit this</span></label>
                    <span class="eyebrow applies-now" title="Saved as soon as you pick a tier; it does not wait for Save Limits.">Applies immediately</span>
                  </div>
                  <select id="default-effort" v-model="effortDefaultForm" @change="saveEffortDefaultUI" class="input-box">
                    <option value="low">Low — fast &amp; tight</option>
                    <option value="medium">Medium — balanced (default)</option>
                    <option value="high">High — thorough, quality gates kept</option>
                    <option value="max">Max — unbounded, gates relaxed</option>
                  </select>
                  <div class="text-xs text-gray-500 mt-1">Per session, change it from the chat composer (or <code class="font-mono">--effort TIER</code>). Per-tier profiles are tuned in config shards.</div>
                </div>
              </div>

              <!-- Parallel slices -->
              <div class="multimodal-grid">
                <div>
                  <label class="field-label">Max Parallel Research Slices <span class="text-gray-600 font-normal">default {{ orchestrationDefaults.maxParallelSlices ?? 2 }}</span></label>
                  <input v-model.number="orchestrationForm.maxParallelSlices" type="number" min="1" max="8" class="input-box" />
                  <div class="text-xs text-gray-500 mt-1">2 for a single local GPU · 3–4 for multi-GPU or API backends</div>
                </div>
              </div>

              <!-- Sub-agent caps -->
              <div class="border-t border-purple-500/10 pt-3 space-y-3">
                <div class="text-xs uppercase tracking-[0.18em] text-gray-500">Sub-Agent Caps</div>
                <div class="multimodal-grid">
                  <div>
                    <label class="field-label">web_search <span class="text-gray-600 font-normal">default {{ orchestrationDefaults.subAgentToolCaps?.web_search ?? 14 }}</span></label>
                    <input v-model.number="orchestrationForm.subAgentWebSearch" type="number" min="1" max="500"
                      :placeholder="String(orchestrationDefaults.subAgentToolCaps?.web_search ?? 14)" class="input-box" />
                  </div>
                  <div>
                    <label class="field-label">web_fetch <span class="text-gray-600 font-normal">default {{ orchestrationDefaults.subAgentToolCaps?.web_fetch ?? 16 }}</span></label>
                    <input v-model.number="orchestrationForm.subAgentWebFetch" type="number" min="1" max="500"
                      :placeholder="String(orchestrationDefaults.subAgentToolCaps?.web_fetch ?? 16)" class="input-box" />
                  </div>
                </div>
              </div>

              <!-- Coordinator caps -->
              <div class="border-t border-purple-500/10 pt-3 space-y-3">
                <div class="text-xs uppercase tracking-[0.18em] text-gray-500">Coordinator Caps</div>
                <div class="multimodal-grid">
                  <div>
                    <label class="field-label">web_search <span class="text-gray-600 font-normal">default {{ orchestrationDefaults.coordinatorToolCaps?.web_search ?? 20 }}</span></label>
                    <input v-model.number="orchestrationForm.coordWebSearch" type="number" min="1" max="500"
                      :placeholder="String(orchestrationDefaults.coordinatorToolCaps?.web_search ?? 20)" class="input-box" />
                  </div>
                  <div>
                    <label class="field-label">web_fetch <span class="text-gray-600 font-normal">default {{ orchestrationDefaults.coordinatorToolCaps?.web_fetch ?? 25 }}</span></label>
                    <input v-model.number="orchestrationForm.coordWebFetch" type="number" min="1" max="500"
                      :placeholder="String(orchestrationDefaults.coordinatorToolCaps?.web_fetch ?? 25)" class="input-box" />
                  </div>
                  <div>
                    <label class="field-label">delegate_to_agent <span class="text-gray-600 font-normal">default {{ orchestrationDefaults.coordinatorToolCaps?.delegate_to_agent ?? 6 }}</span></label>
                    <input v-model.number="orchestrationForm.coordDelegate" type="number" min="1" max="500"
                      :placeholder="String(orchestrationDefaults.coordinatorToolCaps?.delegate_to_agent ?? 6)" class="input-box" />
                  </div>
                </div>
              </div>

              <!-- Per-turn caps -->
              <div class="border-t border-purple-500/10 pt-3 space-y-3">
                <div class="text-xs uppercase tracking-[0.18em] text-gray-500">Per-Turn Caps (main agent)</div>
                <div class="multimodal-grid">
                  <div>
                    <label class="field-label">delegate_to_agent <span class="text-gray-600 font-normal">default {{ orchestrationDefaults.perTurnCaps?.delegate_to_agent ?? 5 }}</span></label>
                    <input v-model.number="orchestrationForm.perTurnDelegate" type="number" min="1" max="500"
                      :placeholder="String(orchestrationDefaults.perTurnCaps?.delegate_to_agent ?? 5)" class="input-box" />
                  </div>
                  <div>
                    <label class="field-label">computer_click <span class="text-gray-600 font-normal">default {{ orchestrationDefaults.perTurnCaps?.computer_click ?? 8 }}</span></label>
                    <input v-model.number="orchestrationForm.perTurnComputerClick" type="number" min="1" max="500"
                      :placeholder="String(orchestrationDefaults.perTurnCaps?.computer_click ?? 8)" class="input-box" />
                  </div>
                  <div>
                    <label class="field-label">computer_type <span class="text-gray-600 font-normal">default {{ orchestrationDefaults.perTurnCaps?.computer_type ?? 6 }}</span></label>
                    <input v-model.number="orchestrationForm.perTurnComputerType" type="number" min="1" max="500"
                      :placeholder="String(orchestrationDefaults.perTurnCaps?.computer_type ?? 6)" class="input-box" />
                  </div>
                </div>
              </div>

              <div v-if="orchestrationError" class="text-sm text-red-400">{{ orchestrationError }}</div>

              <div class="flex justify-end">
                <button type="button" @click="saveOrchestrationConfigUI" :disabled="orchestrationSaving" class="btn-grad px-5 py-2 rounded-xl text-sm">
                  {{ orchestrationSaving ? 'Saving…' : 'Save Limits' }}
                </button>
              </div>
            </div>
          </div>

          <!-- ── Skill Library & Automation ──────────────────────────── -->
          <div id="skill-library" v-if="isAgentsPage" v-show="isCardShown('skill-library')" class="glass-card settings-card p-5">
            <div class="flex items-center justify-between mb-4 gap-3 flex-wrap">
              <div>
                <h3 class="section-title mb-0" tabindex="-1">Skill Library &amp; Automation</h3>
                <div class="text-xs text-gray-500 mt-1">Self-authoring procedural memory and batched tool execution. Browse authored skills on the <RouterLink to="/skills" class="text-indigo-300 hover:underline">Skills</RouterLink> page.</div>
              </div>
              <div class="flex items-center gap-2 flex-wrap">
                <span v-if="isCardDirty('skill-library')" class="unsaved-chip">Unsaved</span>
                <button type="button" v-if="gateway.connected" @click="reloadSkillConfig" :disabled="skillConfigSaving" class="btn-ghost px-3 py-1.5 rounded-lg text-xs">Reload</button>
              </div>
            </div>

            <div v-if="!gateway.connected" class="empty-state">Connect to configure the Skill Library.</div>
            <div v-else class="space-y-4">
              <div class="rounded-xl border border-cyan-500/15 bg-cyan-500/5 px-3 py-2 text-xs text-cyan-100/80">
                Changes wait for Save; once saved they take effect without a restart.
              </div>

              <div class="flex items-center justify-between gap-4">
                <div>
                  <label for="skill-enabled" class="field-label field-label--switch">Enable Skill Library</label>
                  <div class="text-xs text-gray-500">Retrieve and inject learned procedures at planning time.</div>
                </div>
                <ToggleSwitch id="skill-enabled" label="Enable Skill Library" :value="skillForm.enabled" @change="skillForm.enabled = $event" />
              </div>
              <div class="flex items-center justify-between gap-4">
                <div>
                  <label for="skill-auto-author" class="field-label field-label--switch">Autonomous authoring</label>
                  <div class="text-xs text-gray-500">Distill skill drafts from successful multi-step turns.</div>
                </div>
                <ToggleSwitch id="skill-auto-author" label="Autonomous authoring" :value="skillForm.autoAuthor" :disabled="!skillForm.enabled" @change="skillForm.autoAuthor = $event" />
              </div>
              <div class="flex items-center justify-between gap-4">
                <div>
                  <label for="skill-auto-promote" class="field-label field-label--switch">Auto-promote to scenes</label>
                  <div class="text-xs text-gray-500">Graduate consistently reliable skills into reusable workflow scenes.</div>
                </div>
                <ToggleSwitch id="skill-auto-promote" label="Auto-promote to scenes" :value="skillForm.autoPromoteToScene" :disabled="!skillForm.enabled" @change="skillForm.autoPromoteToScene = $event" />
              </div>
              <div class="multimodal-grid">
                <div>
                  <label class="field-label">Max skills injected per turn <span class="text-gray-600 font-normal">default 3</span></label>
                  <input v-model.number="skillForm.maxInjected" type="number" min="1" max="10" class="input-box" />
                </div>
              </div>

              <div class="border-t border-purple-500/10 pt-3 space-y-3">
                <div class="text-xs uppercase tracking-[0.18em] text-gray-500">Tool Pipeline</div>
                <div class="flex items-center justify-between gap-4">
                  <div>
                    <label for="tool-pipeline-enabled" class="field-label field-label--switch">Enable run_tool_pipeline</label>
                    <div class="text-xs text-gray-500">Let granted agents batch several tool calls in one turn. Each step still passes tier + approval + the agent's own allowlist.</div>
                  </div>
                  <ToggleSwitch id="tool-pipeline-enabled" label="Enable run_tool_pipeline" :value="pipelineForm.enabled" @change="pipelineForm.enabled = $event" />
                </div>
              </div>

              <div v-if="skillConfigError" class="text-sm text-red-400">{{ skillConfigError }}</div>

              <div class="flex justify-end">
                <button type="button" @click="saveSkillConfigUI" :disabled="skillConfigSaving" class="btn-grad px-5 py-2 rounded-xl text-sm">
                  {{ skillConfigSaving ? 'Saving…' : 'Save' }}
                </button>
              </div>
            </div>
          </div>

          <!-- ── Document RAG ────────────────────────────────────────── -->
          <div id="document-rag" v-if="isAgentsPage" v-show="isCardShown('document-rag')" class="glass-card settings-card p-5">
            <div class="flex items-center justify-between mb-4 gap-3 flex-wrap">
              <div>
                <h3 class="section-title mb-0" tabindex="-1">Document RAG</h3>
                <div class="text-xs text-gray-500 mt-1">Retrieval-augmented context from attached/uploaded documents (engram graph-RAG). Files are extracted to text and indexed; relevant excerpts are injected into the conversation.</div>
              </div>
              <div class="flex items-center gap-2 flex-wrap">
                <span v-if="isCardDirty('document-rag')" class="unsaved-chip">Unsaved</span>
                <button type="button" v-if="gateway.connected" @click="reloadDocumentRagConfig" :disabled="docRagSaving" class="btn-ghost px-3 py-1.5 rounded-lg text-xs">Reload</button>
              </div>
            </div>

            <div v-if="!gateway.connected" class="empty-state">Connect to configure Document RAG.</div>
            <div v-else class="space-y-4">
              <div class="rounded-xl border border-cyan-500/15 bg-cyan-500/5 px-3 py-2 text-xs text-cyan-100/80">
                Changes wait for Save; once saved they take effect without a restart. Requires the engram + reranker services to be running.
              </div>

              <div class="flex items-center justify-between gap-4">
                <div>
                  <label for="docrag-enabled" class="field-label field-label--switch">Enable Document RAG</label>
                  <div class="text-xs text-gray-500">Master switch for indexing and retrieving from attached documents.</div>
                </div>
                <ToggleSwitch id="docrag-enabled" label="Enable Document RAG" :value="docRagForm.enabled" @change="docRagForm.enabled = $event" />
              </div>
              <div class="flex items-center justify-between gap-4">
                <div>
                  <label for="docrag-auto-ingest" class="field-label field-label--switch">Auto-ingest attachments</label>
                  <div class="text-xs text-gray-500">Index files attached to a message into that conversation's document library automatically.</div>
                </div>
                <ToggleSwitch id="docrag-auto-ingest" label="Auto-ingest attachments" :value="docRagForm.autoIngestAttachments" :disabled="!docRagForm.enabled" @change="docRagForm.autoIngestAttachments = $event" />
              </div>
              <div class="flex items-center justify-between gap-4">
                <div>
                  <label for="docrag-inject-context" class="field-label field-label--switch">Inject context automatically</label>
                  <div class="text-xs text-gray-500">Before answering, retrieve relevant excerpts and add them to the prompt.</div>
                </div>
                <ToggleSwitch id="docrag-inject-context" label="Inject context automatically" :value="docRagForm.injectContext" :disabled="!docRagForm.enabled" @change="docRagForm.injectContext = $event" />
              </div>

              <div class="border-t border-purple-500/10 pt-3 space-y-3">
                <div class="text-xs uppercase tracking-[0.18em] text-gray-500">Scope</div>
                <div class="text-xs text-gray-500 -mt-1">Documents are always searchable within the conversation they were attached to. Extend retrieval to shared libraries:</div>
                <div class="flex items-center justify-between gap-4">
                  <div>
                    <label for="docrag-user-docs" class="field-label field-label--switch">Include the user's personal library</label>
                    <div class="text-xs text-gray-500">Also search documents scoped to the signed-in user (user:&lt;id&gt;).</div>
                  </div>
                  <ToggleSwitch id="docrag-user-docs" label="Include the user's personal library" :value="docRagForm.includeUserDocs" :disabled="!docRagForm.enabled" @change="docRagForm.includeUserDocs = $event" />
                </div>
                <div class="flex items-center justify-between gap-4">
                  <div>
                    <label for="docrag-workspace-docs" class="field-label field-label--switch">Include the workspace library</label>
                    <div class="text-xs text-gray-500">Also search documents shared across the whole workspace.</div>
                  </div>
                  <ToggleSwitch id="docrag-workspace-docs" label="Include the workspace library" :value="docRagForm.includeWorkspaceDocs" :disabled="!docRagForm.enabled" @change="docRagForm.includeWorkspaceDocs = $event" />
                </div>
              </div>

              <div class="multimodal-grid">
                <div>
                  <label class="field-label">Excerpts injected per turn <span class="text-gray-600 font-normal">default 6</span></label>
                  <input v-model.number="docRagForm.retrievalTopK" type="number" min="1" max="20" class="input-box" :disabled="!docRagForm.enabled" />
                </div>
                <div>
                  <label class="field-label">Max context characters <span class="text-gray-600 font-normal">default 6000</span></label>
                  <input v-model.number="docRagForm.maxContextChars" type="number" min="500" max="50000" step="500" class="input-box" :disabled="!docRagForm.enabled" />
                </div>
              </div>

              <div v-if="docRagError" class="text-sm text-red-400">{{ docRagError }}</div>

              <div class="flex justify-end">
                <button type="button" @click="saveDocumentRagConfigUI" :disabled="docRagSaving" class="btn-grad px-5 py-2 rounded-xl text-sm">
                  {{ docRagSaving ? 'Saving…' : 'Save' }}
                </button>
              </div>
            </div>
          </div>

        <div id="multimodal" v-if="isSettingsPage" v-show="isCardShown('multimodal')" class="glass-card settings-card p-5">
          <div class="flex items-center justify-between mb-4 gap-3 flex-wrap">
            <div>
              <h3 class="section-title mb-0" tabindex="-1">Multimodal</h3>
              <div class="text-xs text-gray-500 mt-1">Set file ingestion, STT, TTS, and wake-word defaults.</div>
            </div>
            <div class="flex items-center gap-2 flex-wrap">
              <span v-if="isCardDirty('multimodal')" class="unsaved-chip">Unsaved</span>
              <button type="button" v-if="gateway.connected" @click="reloadMultimodal()" :disabled="multimodalStore.loading || multimodalStore.saving" class="btn-ghost px-3 py-1.5 rounded-lg text-xs">Reload</button>
              <button type="button" @click="revertCard('multimodal')" :disabled="!isCardDirty('multimodal') || multimodalStore.loading || multimodalStore.saving" class="btn-ghost px-3 py-1.5 rounded-lg text-xs">Revert</button>
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
                <button type="button" @click="multimodalStore.fetchStatus()" :disabled="multimodalStore.statusLoading || multimodalStore.loading || multimodalStore.saving" class="btn-ghost px-3 py-1.5 rounded-lg text-xs">
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
                    <span :class="multimodalStore.status.stt.ok ? 'badge-running' : (multimodalStore.status.stt.disabled ? 'badge-off' : 'badge-health-bad')">
                      {{ multimodalStore.status.stt.ok ? 'available' : (multimodalStore.status.stt.disabled ? 'disabled' : 'offline') }}
                    </span>
                  </div>
                  <div class="mt-2 text-[11px] text-gray-500 font-mono break-all">{{ multimodalForm.sttBaseUrl || 'not configured' }}</div>
                  <div v-if="multimodalStore.status.stt.error" class="mt-1 text-[11px] text-red-300">{{ multimodalStore.status.stt.error }}</div>
                </div>

                <div class="multimodal-health-card">
                  <div class="flex items-center justify-between gap-2">
                    <span class="text-gray-300 text-sm">Text To Speech</span>
                    <span :class="multimodalStore.status.tts.ok ? 'badge-running' : (multimodalStore.status.tts.disabled ? 'badge-off' : 'badge-health-bad')">
                      {{ multimodalStore.status.tts.ok ? 'available' : (multimodalStore.status.tts.disabled ? 'disabled' : 'offline') }}
                    </span>
                  </div>
                  <div class="mt-2 text-[11px] text-gray-500 font-mono break-all">{{ multimodalForm.ttsBaseUrl || 'not configured' }}</div>
                  <div v-if="multimodalStore.status.tts.modelName" class="mt-1 text-[11px] text-gray-600 font-mono break-all">{{ multimodalStore.status.tts.modelName }}</div>
                  <div v-if="multimodalStore.status.tts.capabilities?.length" class="mt-1 text-[11px] text-gray-600 break-all">Capabilities: {{ multimodalStore.status.tts.capabilities.join(', ') }}</div>
                  <div v-if="multimodalStore.status.tts.error" class="mt-1 text-[11px] text-red-300">{{ multimodalStore.status.tts.error }}</div>
                </div>

                <div v-if="multimodalStore.status.imageGeneration !== null" class="multimodal-health-card">
                  <div class="flex items-center justify-between gap-2">
                    <span class="text-gray-300 text-sm">Image Generation</span>
                    <span :class="multimodalStore.status.imageGeneration?.ok ? 'badge-running' : (multimodalStore.status.imageGeneration?.disabled ? 'badge-off' : 'badge-health-bad')">
                      {{ multimodalStore.status.imageGeneration?.ok ? 'available' : (multimodalStore.status.imageGeneration?.disabled ? 'disabled' : 'offline') }}
                    </span>
                  </div>
                  <div class="mt-2 text-[11px] text-gray-500 font-mono break-all">{{ multimodalForm.imageGenBaseUrl || 'not configured' }}</div>
                  <div class="mt-1 text-[11px] text-gray-600 font-mono break-all">{{ multimodalForm.imageGenApi }}</div>
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
                  <label for="multimodal-files-endpoint" class="field-label">Files Endpoint <span class="field-required" aria-hidden="true">*</span></label>
                  <input id="multimodal-files-endpoint" v-model="multimodalForm.filesBaseUrl" type="text" required aria-required="true" class="input-box font-mono" placeholder="http://host.docker.internal:8010" />
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
                  <div v-if="keysToReenter.has('filesApiKey')" class="text-xs text-amber-400 mt-1">The endpoint changed: enter the key again, or clear it.</div>
                </div>
                <div class="md:col-span-2 border-t border-purple-500/10 pt-3 mt-1">
                  <div class="text-xs uppercase tracking-[0.18em] text-gray-500 mb-3">Vision Fallback</div>
                  <div class="multimodal-grid">
                    <div class="md:col-span-2">
                      <label class="field-label">Vision Model <span class="text-gray-600 font-normal">optional</span></label>
                      <input v-model="multimodalForm.visionModel" type="text" class="input-box font-mono" placeholder="lmstudio/Qwen/Qwen2.5-VL-7B-Instruct or Qwen/Qwen2.5-VL-7B-Instruct" />
                    </div>
                    <div class="md:col-span-2">
                      <label class="field-label">Vision Endpoint <span class="text-gray-600 font-normal">optional override</span></label>
                      <input v-model="multimodalForm.visionBaseUrl" type="text" class="input-box font-mono" placeholder="defaults to orchestrator endpoint" />
                    </div>
                    <div class="md:col-span-2">
                      <label class="field-label">Vision API Key <span class="text-gray-600 font-normal">optional</span></label>
                      <input v-model="multimodalForm.visionApiKey" type="password" class="input-box" autocomplete="off" placeholder="uses provider or dedicated vision key" />
                      <div v-if="keysToReenter.has('visionApiKey') && !multimodalForm.visionApiKey" class="text-xs text-amber-400 mt-1">With no key here, this endpoint would be sent the provider's key: enter a key, or save again to send none.</div>
                      <div v-else-if="keysToReenter.has('visionApiKey')" class="text-xs text-amber-400 mt-1">The endpoint changed: enter the key again, or clear it.</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div class="border-t border-purple-500/10 pt-3 space-y-3">
              <div class="text-xs uppercase tracking-[0.18em] text-gray-500">Speech To Text</div>
              <div class="text-xs text-gray-500">Leave the endpoint empty to disable STT until an external service is configured.</div>
              <div class="multimodal-grid">
                <div class="md:col-span-2">
                  <label class="field-label">STT Endpoint <span class="text-gray-600 font-normal">optional</span></label>
                  <input v-model="multimodalForm.sttBaseUrl" type="text" class="input-box font-mono" placeholder="https://stt.example.com" />
                </div>
                <div>
                  <label class="field-label">API Mode</label>
                  <select v-model="multimodalForm.sttApi" class="input-box font-mono">
                    <option value="auto">auto</option>
                    <option value="openai-compatible">openai-compatible</option>
                    <option value="transcribe-only">transcribe-only</option>
                  </select>
                </div>
                <div>
                  <label class="field-label">Model</label>
                  <input v-model="multimodalForm.sttModel" type="text" class="input-box font-mono" placeholder="whisper-1" />
                </div>
                <div>
                  <label class="field-label">Timeout (ms)</label>
                  <input v-model.number="multimodalForm.sttTimeoutMs" type="number" min="1000" class="input-box" />
                </div>
                <div class="md:col-span-2">
                  <label class="field-label">API Key <span class="text-gray-600 font-normal">optional</span></label>
                  <input v-model="multimodalForm.sttApiKey" type="password" class="input-box" autocomplete="off" placeholder="Bearer token if required" />
                  <div v-if="keysToReenter.has('sttApiKey')" class="text-xs text-amber-400 mt-1">The endpoint changed: enter the key again, or clear it.</div>
                </div>
              </div>
            </div>

            <div class="border-t border-purple-500/10 pt-3 space-y-3">
              <div class="text-xs uppercase tracking-[0.18em] text-gray-500">Text To Speech</div>
              <div class="text-xs text-gray-500">Leave the endpoint empty to disable TTS until an external service is configured.</div>
              <div class="multimodal-grid">
                <div class="md:col-span-2">
                  <label class="field-label">TTS Endpoint <span class="text-gray-600 font-normal">optional</span></label>
                  <input v-model="multimodalForm.ttsBaseUrl" type="text" class="input-box font-mono" placeholder="https://tts.example.com" />
                </div>
                <div>
                  <label class="field-label">API Mode</label>
                  <select v-model="multimodalForm.ttsApi" class="input-box font-mono">
                    <option value="openai-compatible">openai-compatible</option>
                    <option value="qwen-compatible">qwen-compatible</option>
                    <option value="tts-stt-gateway">tts-stt-gateway</option>
                  </select>
                </div>
                <div>
                  <label class="field-label">Model <span class="text-gray-600 font-normal">optional</span></label>
                  <input v-model="multimodalForm.ttsModel" type="text" class="input-box font-mono" :placeholder="multimodalForm.ttsApi === 'openai-compatible' ? 'tts-1' : 'service default'" />
                </div>
                <div>
                  <label class="field-label">Default Language</label>
                  <input v-model="multimodalForm.ttsDefaultLanguage" type="text" class="input-box font-mono" placeholder="English" />
                </div>
                <div>
                  <label class="field-label">Default {{ multimodalForm.ttsApi === 'openai-compatible' ? 'Voice' : 'Speaker' }}</label>
                  <input v-model="multimodalForm.ttsDefaultSpeaker" type="text" class="input-box font-mono" :placeholder="multimodalForm.ttsApi === 'openai-compatible' ? 'Luna' : 'Luna'" />
                </div>
                <div>
                  <label class="field-label">Default Voice ID <span class="text-gray-600 font-normal">optional</span></label>
                  <input v-model="multimodalForm.ttsDefaultVoiceId" type="text" class="input-box font-mono" :placeholder="multimodalForm.ttsApi === 'openai-compatible' ? 'provider voice id' : 'saved voice id from /voices'" />
                </div>
                <div>
                  <label class="field-label">Timeout (ms)</label>
                  <input v-model.number="multimodalForm.ttsTimeoutMs" type="number" min="1000" class="input-box" />
                </div>
                <div>
                  <label class="field-label">API Key <span class="text-gray-600 font-normal">optional</span></label>
                  <input v-model="multimodalForm.ttsApiKey" type="password" class="input-box" autocomplete="off" placeholder="Bearer token if required" />
                  <div v-if="keysToReenter.has('ttsApiKey')" class="text-xs text-amber-400 mt-1">The endpoint changed: enter the key again, or clear it.</div>
                </div>
                <div v-if="multimodalForm.ttsApi === 'qwen-compatible'" class="md:col-span-2">
                  <label class="field-label">Audio Example Path <span class="text-gray-600 font-normal">optional</span></label>
                  <input v-model="multimodalForm.ttsVoiceSamplePath" type="text" class="input-box font-mono" placeholder="workspace-relative sample, e.g. samples/my-voice.wav" />
                </div>
                <div v-if="multimodalForm.ttsApi === 'qwen-compatible'" class="md:col-span-2">
                  <label class="field-label">Audio Example Transcript <span class="text-gray-600 font-normal">optional</span></label>
                  <textarea v-model="multimodalForm.ttsVoiceSampleText" class="input-box font-mono text-xs resize-none" rows="3" placeholder="Exact words spoken in the audio example for higher quality cloning" />
                </div>
              </div>

              <!-- A TTS-STT gateway's voices: per language, cloning, design, training. Shown once the
                   gateway mode is saved — its routes act on the saved configuration. -->
              <VoiceStudio v-if="multimodalForm.ttsApi === 'tts-stt-gateway' && multimodalStore.config.tts.api === 'tts-stt-gateway'" />
              <div v-else-if="multimodalForm.ttsApi === 'tts-stt-gateway'" class="text-xs text-gray-500">
                Save this mode to manage the speech service's voices here.
              </div>

              <div v-if="multimodalForm.ttsApi === 'qwen-compatible'" class="rounded-xl border border-purple-500/10 bg-gray-950/40 p-3 space-y-3">
                <div>
                  <div class="text-xs uppercase tracking-[0.18em] text-gray-500">Save Voice To Qwen-Compatible Library</div>
                  <div class="text-xs text-gray-500 mt-1">Upload a sample once, save it in a qwen-compatible voice library, and reuse the returned voice ID for faster synthesis.</div>
                  <div class="text-xs text-gray-500 mt-1">If auto-transcription struggles, fill "Audio Example Transcript" above and {{ product.name }} will forward it with the upload.</div>
                </div>
                <div v-if="qwenVoiceSaveSupported === false" class="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                  {{ qwenVoiceSaveMessage }}
                </div>
                <div v-else-if="qwenBuiltInSpeakerMessage" class="rounded-lg border border-cyan-500/20 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-100/90">
                  {{ qwenBuiltInSpeakerMessage }}
                </div>
                <div class="multimodal-grid">
                  <div>
                    <label for="saved-voice-name" class="field-label">Voice Name <span class="field-required" aria-hidden="true">*</span></label>
                    <input id="saved-voice-name" v-model="savedVoiceForm.name" type="text" required aria-required="true" class="input-box" placeholder="e.g. Steffen Voice" />
                  </div>
                  <div>
                    <label class="field-label">Language</label>
                    <input v-model="savedVoiceForm.language" type="text" class="input-box font-mono" placeholder="English" />
                  </div>
                  <div class="md:col-span-2">
                    <label for="saved-voice-file" class="field-label">Voice Sample File <span class="field-required" aria-hidden="true">*</span></label>
                    <input id="saved-voice-file" type="file" accept="audio/*" required aria-required="true" class="input-box" @change="onSavedVoiceFileSelected" />
                    <div v-if="savedVoiceForm.fileName" class="mt-2 text-[11px] text-gray-500">Selected: {{ savedVoiceForm.fileName }}</div>
                  </div>
                </div>
                <div v-if="savedVoiceForm.message" class="text-xs" :class="savedVoiceForm.error ? 'text-red-400' : 'text-green-300'">{{ savedVoiceForm.message }}</div>
                <div class="flex justify-end">
                  <button type="button" @click="saveVoiceSampleToLibrary" :disabled="savedVoiceForm.saving || !savedVoiceForm.file || qwenVoiceSaveSupported === false" class="btn-ghost px-4 py-2 rounded-xl text-xs">
                    {{ savedVoiceForm.saving ? 'Saving Voice…' : 'Upload And Save Voice' }}
                  </button>
                </div>
              </div>

              <div v-if="multimodalForm.ttsApi === 'qwen-compatible'" class="rounded-xl border border-purple-500/10 bg-gray-950/40 p-3 space-y-3">
                <div class="flex items-center justify-between">
                  <div>
                    <div class="text-xs uppercase tracking-[0.18em] text-gray-500">Saved Voice Library</div>
                    <div class="text-xs text-gray-500 mt-1">All voices saved in the qwen-compatible TTS backend. Click a voice ID to set it as Default Voice ID.</div>
                  </div>
                  <button type="button" @click="loadSavedVoices" :disabled="voiceLibrary.loading" class="btn-ghost px-3 py-1.5 rounded-xl text-xs flex items-center gap-1.5">
                    <svg v-if="!voiceLibrary.loading" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-3.5 h-3.5"><path fill-rule="evenodd" d="M15.312 11.424a5.5 5.5 0 0 1-9.201 2.466l-.312-.311h2.433a.75.75 0 0 0 0-1.5H3.989a.75.75 0 0 0-.75.75v4.242a.75.75 0 0 0 1.5 0v-2.43l.31.31a7 7 0 0 0 11.712-3.138.75.75 0 0 0-1.449-.39Zm1.23-3.723a.75.75 0 0 0 .219-.53V2.929a.75.75 0 0 0-1.5 0V5.36l-.31-.31A7 7 0 0 0 3.239 8.188a.75.75 0 1 0 1.448.389A5.5 5.5 0 0 1 13.89 6.11l.311.31h-2.432a.75.75 0 0 0 0 1.5h4.243a.75.75 0 0 0 .53-.219Z" clip-rule="evenodd" /></svg>
                    <svg v-else xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-3.5 h-3.5 animate-spin"><path fill-rule="evenodd" d="M15.312 11.424a5.5 5.5 0 0 1-9.201 2.466l-.312-.311h2.433a.75.75 0 0 0 0-1.5H3.989a.75.75 0 0 0-.75.75v4.242a.75.75 0 0 0 1.5 0v-2.43l.31.31a7 7 0 0 0 11.712-3.138.75.75 0 0 0-1.449-.39Zm1.23-3.723a.75.75 0 0 0 .219-.53V2.929a.75.75 0 0 0-1.5 0V5.36l-.31-.31A7 7 0 0 0 3.239 8.188a.75.75 0 1 0 1.448.389A5.5 5.5 0 0 1 13.89 6.11l.311.31h-2.432a.75.75 0 0 0 0 1.5h4.243a.75.75 0 0 0 .53-.219Z" clip-rule="evenodd" /></svg>
                    {{ voiceLibrary.loading ? 'Loading…' : 'Refresh' }}
                  </button>
                </div>
                <div v-if="voiceLibrary.error" class="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">{{ voiceLibrary.error }}</div>
                <div v-if="!voiceLibrary.loaded && !voiceLibrary.loading" class="text-xs text-gray-600 italic">Click Refresh to load voices from the backend.</div>
                <div v-else-if="voiceLibrary.loaded && voiceLibrary.voices.length === 0" class="text-xs text-gray-600 italic">No saved voices found in the backend.</div>
                <ul v-else class="divide-y divide-purple-500/10">
                  <li v-for="voice in voiceLibrary.voices" :key="voice.voice_id" class="flex items-center justify-between py-2 gap-3 group">
                    <div class="min-w-0 flex-1">
                      <button type="button" @click="multimodalForm.ttsDefaultVoiceId = voice.voice_id" class="text-left max-w-full">
                        <div class="text-xs font-semibold text-gray-200 truncate group-hover:text-purple-300 transition-colors" :class="{ 'text-purple-300': multimodalForm.ttsDefaultVoiceId === voice.voice_id }">{{ voice.name }}</div>
                        <div class="text-[11px] text-gray-500 font-mono truncate">{{ voice.voice_id }}<span v-if="voice.lang" class="ml-2 text-gray-600">{{ voice.lang }}</span></div>
                      </button>
                    </div>
                    <div class="flex items-center gap-2 flex-shrink-0">
                      <span v-if="multimodalForm.ttsDefaultVoiceId === voice.voice_id" class="text-[10px] text-purple-400 font-medium">active</span>
                      <button
                        type="button"
                        @click="removeSavedVoice(voice.voice_id)"
                        :disabled="voiceLibrary.removingId === voice.voice_id"
                        class="text-[11px] text-red-400/70 hover:text-red-300 transition-colors disabled:opacity-40"
                        title="Remove voice from library"
                      >{{ voiceLibrary.removingId === voice.voice_id ? 'Removing…' : 'Remove' }}</button>
                    </div>
                  </li>
                </ul>
              </div>
            </div>

            <div class="border-t border-purple-500/10 pt-3 space-y-3">
              <div class="text-xs uppercase tracking-[0.18em] text-gray-500">Image Generation</div>
              <div class="text-xs text-gray-500">External image backends only. Leave the endpoint empty to disable image generation.</div>
              <div class="multimodal-grid">
                <div class="md:col-span-2">
                  <label class="field-label">Image Gen Endpoint <span class="text-gray-600 font-normal">optional</span></label>
                  <input v-model="multimodalForm.imageGenBaseUrl" type="text" class="input-box font-mono" :placeholder="multimodalForm.imageGenApi === 'comfyui' ? 'http://localhost:8188' : multimodalForm.imageGenApi === 'openai-compatible' ? 'http://localhost:8000/v1' : 'http://localhost:7860'" />
                </div>
                <div>
                  <label class="field-label">API Mode</label>
                  <select v-model="multimodalForm.imageGenApi" class="input-box font-mono">
                    <option value="automatic1111-compatible">automatic1111-compatible</option>
                    <option value="comfyui">comfyui</option>
                    <option value="openai-compatible">openai-compatible</option>
                  </select>
                </div>
                <div>
                  <label class="field-label">Model <span class="text-gray-600 font-normal">optional</span></label>
                  <input v-model="multimodalForm.imageGenModel" type="text" class="input-box font-mono" :placeholder="multimodalForm.imageGenApi === 'comfyui' ? 'sd_xl_base_1.0.safetensors' : 'uses server default unless set'" />
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
                  <div v-if="keysToReenter.has('imageGenApiKey') && multimodalForm.imageGenApiKey" class="text-xs text-amber-400 mt-1">The endpoint changed: enter the key again, or clear it.</div>
                  <div v-if="tierKeyMoves" class="text-xs text-amber-400 mt-1">The quality tier's own saved key would follow this endpoint too. Saving drops it (enter or clear the key above first if it is masked); the tier then uses the image key.</div>
                </div>
                <div v-if="multimodalForm.imageGenApi === 'comfyui'" class="md:col-span-2 text-xs text-gray-500">
                  ComfyUI requires a checkpoint name. Set the model here or in the saved config before using generate_image.
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
                        type="button"
                        v-for="preset in IMAGE_GEN_NEGATIVE_PRESETS"
                        :key="preset.label"
                        @click="applyNegativePreset(preset.value)"
                        class="px-2.5 py-1 rounded-lg text-xs border border-purple-500/20 bg-purple-900/20 text-purple-200 hover:bg-purple-700/30 hover:border-purple-400/40 transition-colors"
                        :title="preset.value"
                      >{{ preset.label }}</button>
                      <button
                        type="button"
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
                <toggle-switch label="Wake word" :value="multimodalForm.wakeEnabled" @change="multimodalForm.wakeEnabled = $event" />
              </div>
              <div class="multimodal-grid">
                <div>
                  <label class="field-label">Silence Timeout (ms)</label>
                  <input v-model.number="multimodalForm.wakeSilenceTimeoutMs" type="number" min="1000" max="15000" class="input-box" />
                </div>
                <div>
                  <label for="multimodal-wake-keywords" class="field-label">Wake Keywords <span class="field-required" aria-hidden="true">*</span> <span class="text-gray-600 font-normal">comma-separated</span></label>
                  <input id="multimodal-wake-keywords" v-model="multimodalForm.wakeKeywordsText" type="text" required aria-required="true" class="input-box" placeholder="Hey Guarded, Okay Guarded, Luna" />
                </div>
                <div class="md:col-span-2">
                  <label for="multimodal-stop-phrases" class="field-label">Stop Phrases <span class="field-required" aria-hidden="true">*</span> <span class="text-gray-600 font-normal">comma-separated</span></label>
                  <input id="multimodal-stop-phrases" v-model="multimodalForm.wakeStopPhrasesText" type="text" required aria-required="true" class="input-box" placeholder="stop recording, end recording, stop listening" />
                </div>
              </div>
            </div>

            <div v-if="multimodalStore.error || multimodalForm.error" class="text-sm text-red-400">{{ shownError(multimodalForm.error || multimodalStore.error) }}</div>

            <div class="flex justify-end">
              <button type="button" @click="submitMultimodalForm" :disabled="multimodalStore.saving || multimodalStore.loading" class="btn-grad px-5 py-2 rounded-xl text-sm">
                {{ multimodalStore.saving ? 'Saving…' : 'Save Multimodal Settings' }}
              </button>
            </div>
          </div>
        </div>

        <!-- ── About ──────────────────────────────────────────────────────── -->
        <div id="about" v-if="isSettingsPage" v-show="isCardShown('about')" class="glass-card settings-card p-5">
          <h3 class="section-title" tabindex="-1">About {{ product.name }}</h3>
          <div class="text-sm text-gray-500 space-y-1">
            <p>Version: <span class="text-gray-300">{{ appVersion }}</span></p>
            <p>Security-hardened local AI assistant with multi-agent orchestration.</p>
            <p class="text-xs mt-2">All conversations are processed locally via LM Studio. No data is sent to external services unless you explicitly use web tools.</p>
          </div>
        </div>

      </div>

      <!-- ══ RIGHT COLUMN ═════════════════════════════════════════════════════ -->
      <div class="space-y-5">

        <!-- ── Guardrails ──────────────────────────────────────────────────── -->
        <div id="guardrails" v-if="isSettingsPage" v-show="isCardShown('guardrails')" class="glass-card settings-card p-5">
          <div class="flex items-center justify-between mb-4 gap-3 flex-wrap">
            <div class="flex items-baseline gap-3 flex-wrap">
              <h3 class="section-title mb-0" tabindex="-1">Guardrails</h3>
              <span class="eyebrow applies-now" title="Each switch and the slider are saved the moment you change them; there is no Save button.">Applies immediately</span>
            </div>
            <div class="flex items-center gap-2">
              <button type="button" v-if="guardrails.state" @click="resetGuardrails" :disabled="guardrails.loading"
                class="text-xs text-gray-500 hover:text-purple-400 transition-colors">Reset defaults</button>
              <button type="button" v-if="!guardrails.state && gateway.connected" @click="guardrails.fetch()" :disabled="guardrails.loading"
                class="btn-ghost px-3 py-1.5 rounded-lg text-xs">Load</button>
            </div>
          </div>

          <div v-if="!gateway.connected" class="empty-state">Connect to manage guardrails.</div>
          <div v-else-if="guardrails.loading && !guardrails.state" class="empty-state">Loading…</div>
          <div v-else-if="guardrails.error" class="text-sm text-red-400">{{ shownError(guardrails.error) }}</div>

          <div v-else-if="guardrails.state" class="space-y-4">
            <div class="flex items-start justify-between gap-4">
              <div>
                <p class="text-sm text-gray-200">Prompt Injection Protection</p>
                <p class="text-xs text-gray-500 mt-0.5">Scan incoming messages for jailbreak and injection patterns.</p>
              </div>
              <toggle-switch label="Prompt Injection Protection" :value="guardrails.state.promptInjectionBlock"
                @change="setProtection('promptInjectionBlock', $event)" :disabled="guardrails.loading" />
            </div>
            <div class="border-t border-purple-500/10" />
            <div class="flex items-start justify-between gap-4">
              <div>
                <p class="text-sm text-gray-200">Output Secret Scanning</p>
                <p class="text-xs text-gray-500 mt-0.5">Redact API keys, tokens, and credentials from LLM responses.</p>
              </div>
              <toggle-switch label="Output Secret Scanning" :value="guardrails.state.outputSecretScan"
                @change="setProtection('outputSecretScan', $event)" :disabled="guardrails.loading" />
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
              <input type="range" aria-label="Max Input Length" min="1000" max="100000" step="1000" :value="guardrails.state.maxInputLength"
                @change="updateGuardrails({ maxInputLength: Number(($event.target as HTMLInputElement).value) })"
                :disabled="guardrails.loading" class="w-full accent-purple-500" />
              <div class="flex justify-between text-xs text-gray-600"><span>1 000</span><span>100 000</span></div>
            </div>
            <div class="border-t border-purple-500/10" />
            <div class="flex items-start justify-between gap-4 opacity-50">
              <div>
                <p class="text-sm text-gray-200">Shell Sandbox <span class="ml-1 text-xs text-amber-500">locked</span></p>
                <p class="text-xs text-gray-500 mt-0.5">Commands run inside an isolated Docker container. Cannot be disabled.</p>
              </div>
              <toggle-switch label="Shell Sandbox" :value="true" :disabled="true" />
            </div>
          </div>

          <div v-else-if="gateway.connected && !guardrails.state && !guardrails.loading" class="empty-state">
            Click "Load" to fetch current guardrail state.
          </div>
        </div>

        <!-- ── Site Credentials ───────────────────────────────────────────── -->
        <div id="site-credentials" v-if="isSettingsPage" v-show="isCardShown('site-credentials')" class="glass-card settings-card p-5">
          <div class="flex items-center justify-between mb-4">
            <h3 class="section-title mb-0" tabindex="-1">Site Credentials</h3>
            <div class="flex gap-2">
              <button type="button" v-if="gateway.connected && !sites.sites.length" @click="sites.fetch()" class="btn-ghost px-3 py-1.5 rounded-lg text-xs">Reload</button>
              <button type="button" @click="openSiteForm(null)" :disabled="!gateway.connected" class="btn-grad px-3 py-1.5 rounded-lg text-xs">+ Add Site</button>
            </div>
          </div>

          <div v-if="!gateway.connected" class="empty-state">Connect to manage site credentials.</div>
          <div v-else-if="sites.loading && !sites.sites.length" class="empty-state">Loading…</div>
          <div v-else-if="sites.error" class="text-sm text-red-400">{{ shownError(sites.error) }}</div>

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
                <button type="button" v-if="site.source === 'store'" @click="openSiteForm(site)" class="icon-btn" title="Edit" :aria-label="`Edit the credentials for ${site.hostname}`">✏</button>
                <button type="button" v-else class="icon-btn opacity-40 cursor-not-allowed" title="Defined in starlingai.json" :aria-label="`${site.hostname} is defined in starlingai.json and cannot be edited here`" disabled>🔒</button>
                <button type="button" v-if="site.source === 'store'" @click="confirmDeleteSite(site.hostname)"
                  :disabled="sites.loading" class="icon-btn icon-btn--danger" title="Delete" :aria-label="`Delete the credentials for ${site.hostname}`">✕</button>
              </div>
            </div>
          </div>

          <div v-else class="empty-state">No site credentials configured.</div>
        </div>

        <!-- ── Scenes ─────────────────────────────────────────────────────── -->
        <div id="scenes" v-if="isSettingsPage" v-show="isCardShown('scenes')" class="glass-card settings-card p-5">
          <div class="flex items-center justify-between mb-4">
            <h3 class="section-title mb-0" tabindex="-1">Scenes</h3>
            <div class="flex gap-2">
              <button type="button" v-if="gateway.connected && !scenesStore.scenes.length" @click="scenesStore.fetch()" class="btn-ghost px-3 py-1.5 rounded-lg text-xs">Reload</button>
              <button type="button" @click="openSceneForm(null)" :disabled="!gateway.connected" class="btn-grad px-3 py-1.5 rounded-lg text-xs">+ Add Scene</button>
            </div>
          </div>

          <div v-if="!gateway.connected" class="empty-state">Connect to manage scenes.</div>
          <div v-else-if="scenesStore.loading && !scenesStore.scenes.length" class="empty-state">Loading…</div>
          <div v-else-if="scenesStore.error" class="text-sm text-red-400">{{ shownError(scenesStore.error) }}</div>

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
                  <button type="button" v-if="scene.source === 'store'" @click="openSceneForm(scene)" class="icon-btn" title="Edit" :aria-label="`Edit the scene ${scene.name}`">✏</button>
                  <button type="button" v-else class="icon-btn opacity-40 cursor-not-allowed" title="Defined in starlingai.json" :aria-label="`The scene ${scene.name} is defined in starlingai.json and cannot be edited here`" disabled>🔒</button>
                  <button type="button" v-if="scene.source === 'store'" @click="confirmDeleteScene(scene.name)"
                    :disabled="scenesStore.loading" class="icon-btn icon-btn--danger" title="Delete" :aria-label="`Delete the scene ${scene.name}`">✕</button>
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

        <div id="jobs" v-if="isSettingsPage" v-show="isCardShown('jobs')" class="glass-card settings-card p-5">
          <div class="flex items-center justify-between mb-4">
            <h3 class="section-title mb-0" tabindex="-1">Jobs</h3>
            <div class="flex gap-2">
              <button type="button" v-if="gateway.connected && !jobsStore.jobs.length" @click="jobsStore.fetch()" class="btn-ghost px-3 py-1.5 rounded-lg text-xs">Reload</button>
              <button type="button" @click="openJobForm(null)" :disabled="!gateway.connected" class="btn-grad px-3 py-1.5 rounded-lg text-xs">+ Add Job</button>
            </div>
          </div>

          <div v-if="!gateway.connected" class="empty-state">Connect to manage jobs.</div>
          <div v-else-if="jobsStore.loading && !jobsStore.jobs.length" class="empty-state">Loading…</div>
          <div v-else-if="jobsStore.error" class="text-sm text-red-400">{{ shownError(jobsStore.error) }}</div>

          <div v-else-if="jobsStore.jobs.length" class="space-y-2">
            <div v-for="job in jobsStore.jobs" :key="job.name" class="scene-row">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span class="text-sm font-mono text-gray-100">{{ job.name }}</span>
                    <span :class="job.source === 'config' ? 'badge-config' : 'badge-store'">{{ job.source }}</span>
                    <span class="badge-store">{{ job.steps.length }} step{{ job.steps.length === 1 ? '' : 's' }}</span>
                    <span v-if="job.triggers?.length" class="badge-running">{{ formatJobTriggerSummary(job.triggers) }}</span>
                  </div>
                  <div class="text-xs text-gray-400 mt-0.5">{{ job.description }}</div>
                </div>
                <div class="flex gap-1 shrink-0">
                  <button type="button" v-if="job.source === 'store'" @click="openJobForm(job)" class="icon-btn" title="Edit" :aria-label="`Edit the job ${job.name}`">✏</button>
                  <button type="button" v-else class="icon-btn opacity-40 cursor-not-allowed" title="Defined in starlingai.json" :aria-label="`The job ${job.name} is defined in starlingai.json and cannot be edited here`" disabled>🔒</button>
                  <button type="button" v-if="job.source === 'store'" @click="confirmDeleteJob(job.name)" :disabled="jobsStore.loading" class="icon-btn icon-btn--danger" title="Delete" :aria-label="`Delete the job ${job.name}`">✕</button>
                </div>
              </div>
              <details class="mt-2">
                <summary class="text-xs text-gray-600 cursor-pointer hover:text-purple-400 transition-colors select-none">Steps & triggers</summary>
                <pre class="text-xs text-gray-500 mt-1.5 whitespace-pre-wrap break-words bg-gray-950/60 border border-purple-500/10 rounded-lg p-2.5 max-h-56 overflow-y-auto">{{ formatJobPreview(job) }}</pre>
              </details>
            </div>
          </div>

          <div v-else class="empty-state">No jobs configured.</div>
        </div>

          <!-- ── User Model ──────────────────────────────────────────── -->
          <div id="user-model" v-if="isAgentsPage" v-show="isCardShown('user-model')" class="glass-card settings-card p-5">
            <div class="flex items-center justify-between mb-4 gap-3 flex-wrap">
              <div>
                <h3 class="section-title mb-0" tabindex="-1">User Model</h3>
                <div class="text-xs text-gray-500 mt-1">The swarm's evolving understanding of you — one item per line. The agent also refines this automatically as it learns; this is distinct from durable memory facts and the assistant's own personality.</div>
              </div>
              <div class="flex items-center gap-2 flex-wrap">
                <span v-if="isCardDirty('user-model')" class="unsaved-chip">Unsaved</span>
                <button type="button" v-if="gateway.connected" @click="reloadUserModel" :disabled="userModelSaving" class="btn-ghost px-3 py-1.5 rounded-lg text-xs">Reload</button>
                <button type="button" @click="resetUserModelUI" :disabled="userModelSaving" class="btn-ghost px-3 py-1.5 rounded-lg text-xs">Reset</button>
              </div>
            </div>

            <div v-if="!gateway.connected" class="empty-state">Connect to view the user model.</div>
            <div v-else class="space-y-3">
              <div>
                <label class="field-label">Goals</label>
                <textarea v-model="userModelForm.goals" rows="2" class="input-box" placeholder="One goal per line"></textarea>
              </div>
              <div>
                <label class="field-label">Expertise</label>
                <textarea v-model="userModelForm.expertise" rows="2" class="input-box" placeholder="Domains and skill level"></textarea>
              </div>
              <div>
                <label class="field-label">Working style</label>
                <textarea v-model="userModelForm.workingStyle" rows="2" class="input-box" placeholder="How you prefer to work"></textarea>
              </div>
              <div>
                <label class="field-label">Communication preferences</label>
                <textarea v-model="userModelForm.communication" rows="2" class="input-box" placeholder="Tone and format preferences"></textarea>
              </div>
              <div>
                <label class="field-label">Open questions <span class="text-gray-600 font-normal">hypotheses the agent is still testing</span></label>
                <textarea v-model="userModelForm.openQuestions" rows="2" class="input-box"></textarea>
              </div>

              <div v-if="userModelError" class="text-sm text-red-400">{{ userModelError }}</div>

              <div class="flex items-center justify-between">
                <div class="text-xs text-gray-500">rev {{ userModelRevision }}<span v-if="userModelUpdatedBy"> · last updated by {{ userModelUpdatedBy }}</span></div>
                <button type="button" @click="saveUserModelUI" :disabled="userModelSaving" class="btn-grad px-5 py-2 rounded-xl text-sm">
                  {{ userModelSaving ? 'Saving…' : 'Save' }}
                </button>
              </div>
            </div>
          </div>

          <div id="config-assistant" v-if="isAgentsPage" v-show="isCardShown('config-assistant')" class="glass-card settings-card p-5">
            <div class="flex items-center justify-between mb-4 gap-3">
              <div>
                <h3 class="section-title mb-0" tabindex="-1">Config Assistant</h3>
                <div class="text-xs text-gray-500 mt-1">Describe the setup or enhancement you want. {{ product.name }} drafts the changes, you review them, and nothing applies until you approve it.</div>
              </div>
              <div class="flex items-center gap-2 flex-wrap justify-end">
                <span v-if="isCardDirty('config-assistant')" class="unsaved-chip">Not sent</span>
                <button
                  type="button"
                  v-if="gateway.connected"
                  @click="reloadConfigAssistant"
                  :disabled="configAssistant.loading || configAssistant.flowLoading || configAssistant.proposing || Boolean(configAssistant.activeProposalId)"
                  class="btn-ghost px-3 py-1.5 rounded-lg text-xs"
                >Reload</button>
              </div>
            </div>

            <div v-if="!gateway.connected" class="empty-state">Connect to generate conversational configuration proposals.</div>
            <div v-else class="space-y-4">
              <div class="config-assistant-intro">
                <div>
                  <div class="text-sm text-gray-100">Conversation-driven configuration</div>
                  <div class="text-xs text-gray-500 mt-1">Drafts are stored as proposals, prompt changes are consent-gated, and your feedback becomes reusable flow memory.</div>
                </div>
                <div class="text-right text-xs text-gray-500">
                  <div>{{ configAssistant.pendingProposals.length }} pending</div>
                  <div class="text-cyan-200 mt-1">{{ configAssistant.flowEntries.length }} flow memories</div>
                </div>
              </div>

              <div class="space-y-3 rounded-2xl border border-cyan-500/15 bg-cyan-500/5 p-4">
                <div class="config-assistant-grid">
                  <div>
                    <label class="field-label">Mode</label>
                    <select v-model="configAssistantForm.mode" class="input-box">
                      <option value="setup">Initial setup</option>
                      <option value="enhancement">Enhancement</option>
                      <option value="prompt">Prompt improvement</option>
                    </select>
                  </div>
                  <div>
                    <label class="field-label">Target Agent <span class="text-gray-600 font-normal">optional</span></label>
                    <select v-model="configAssistantForm.targetAgent" class="input-box">
                      <option value="">General runtime</option>
                      <option value="main_assistant">Main Assistant</option>
                      <option v-for="agent in agentsStore.agents" :key="agent.name" :value="agent.name">{{ agent.name }}</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label for="config-assistant-request" class="field-label">Request <span class="field-required" aria-hidden="true">*</span></label>
                  <textarea
                    id="config-assistant-request"
                    v-model="configAssistantForm.request"
                    rows="5"
                    required
                    aria-required="true"
                    class="input-box config-assistant-textarea"
                    placeholder="Example: Improve browser_agent so it stops looping on stable pages, hands visible evidence to vision_browser_analyst, and records the lesson if the handoff works."
                  />
                </div>

                <div v-if="configAssistant.proposeError" class="text-sm text-red-400">{{ shownError(configAssistant.proposeError) }}</div>

                <div class="flex justify-end gap-2">
                  <button type="button" @click="resetConfigAssistantForm" :disabled="configAssistant.proposing || configAssistantFormBlank" class="btn-ghost px-4 py-2 rounded-xl text-xs">Clear</button>
                  <button type="button" @click="submitConfigAssistantRequest" :disabled="configAssistant.proposing || !configAssistantForm.request.trim()" class="btn-grad px-4 py-2 rounded-xl text-sm">
                    {{ configAssistant.proposing ? 'Drafting…' : 'Generate Proposal' }}
                  </button>
                </div>
              </div>

              <div v-if="configAssistant.flowError" class="text-sm text-red-400">{{ shownError(configAssistant.flowError) }}</div>
              <div v-else-if="configAssistant.recentLearnings.length" class="space-y-2">
                <div class="text-[11px] uppercase tracking-[0.18em] text-gray-500">Recent Learnings</div>
                <div class="space-y-2">
                  <div v-for="entry in configAssistant.recentLearnings" :key="entry.id" class="flow-memory-card">
                    <div class="flex items-start justify-between gap-3">
                      <div>
                        <div class="text-sm text-gray-100">{{ entry.summary ?? "Another account's change" }}</div>
                        <div class="text-[11px] text-gray-500 mt-1">
                          {{ formatConfigAssistantScope(entry.scope) }}<span v-if="entry.targetAgent"> • {{ entry.targetAgent }}</span> • {{ formatTimestamp(entry.ts) }}
                        </div>
                      </div>
                      <span :class="flowBadgeClass(entry.outcome)">{{ formatConfigAssistantOutcome(entry.outcome) }}</span>
                    </div>
                    <div v-if="entry.lesson" class="text-xs text-cyan-100/80 mt-2">{{ entry.lesson }}</div>
                    <div v-if="entry.actions?.length" class="routing-chip-row mt-2">
                      <span v-for="action in entry.actions" :key="`${entry.id}-${action}`" class="routing-chip">{{ action }}</span>
                    </div>
                  </div>
                </div>
              </div>

              <div v-if="configAssistant.mutationError" class="text-sm text-red-400">{{ shownError(configAssistant.mutationError) }}</div>
              <div v-if="configAssistant.error" class="text-sm text-red-400">{{ shownError(configAssistant.error) }}</div>

              <div v-if="configAssistant.loading && !configAssistant.proposals.length" class="empty-state">Loading proposals…</div>
              <div v-else-if="configAssistant.proposals.length" class="space-y-3">
                <div class="text-[11px] uppercase tracking-[0.18em] text-gray-500">Proposals</div>
                <details v-for="proposal in configAssistant.proposals" :key="proposal.id" class="config-proposal-card" :open="proposal.status === 'pending'">
                  <summary class="config-proposal-summary">
                    <div class="min-w-0">
                      <div class="flex items-center gap-2 flex-wrap">
                        <span class="text-sm font-medium text-gray-100">{{ proposal.summary ?? "Another account's proposal" }}</span>
                        <span :class="proposalBadgeClass(proposal.status)">{{ proposal.status }}</span>
                        <span class="routing-chip">{{ formatConfigAssistantScope(proposal.mode) }}</span>
                      </div>
                      <div class="text-[11px] text-gray-500 mt-1">
                        {{ proposal.assistantAgent }}<span v-if="proposal.targetAgent"> → {{ proposal.targetAgent }}</span> • {{ formatTimestamp(proposal.ts) }}
                      </div>
                    </div>
                    <span class="text-xs text-gray-600 shrink-0">Details ▾</span>
                  </summary>

                  <div class="mt-3 space-y-3 pl-1">
                    <div v-if="proposal.request" class="text-xs text-gray-400 whitespace-pre-wrap break-words">{{ proposal.request }}</div>

                    <div v-if="proposal.validations?.length" class="space-y-1.5">
                      <div class="text-[11px] uppercase tracking-[0.18em] text-gray-500">Checks</div>
                      <ul class="config-proposal-list">
                        <li v-for="validation in proposal.validations" :key="validation">{{ validation }}</li>
                      </ul>
                    </div>

                    <div v-if="proposal.configChanges.length" class="space-y-2">
                      <div class="text-[11px] uppercase tracking-[0.18em] text-gray-500">Config Changes</div>
                      <div v-for="change in proposal.configChanges" :key="`${proposal.id}-${change.path}`" class="config-change-card">
                        <div class="text-xs font-mono text-cyan-200">{{ change.path }}</div>
                        <div v-if="change.reason" class="text-[11px] text-gray-500 mt-1">{{ change.reason }}</div>
                        <pre v-if="'value' in change" class="config-change-preview">{{ stringifyPreview(change.value) }}</pre>
                      </div>
                    </div>

                    <div v-if="proposal.promptChanges.length" class="space-y-2">
                      <div class="text-[11px] uppercase tracking-[0.18em] text-gray-500">Prompt Proposals</div>
                      <div v-for="change in proposal.promptChanges" :key="`${proposal.id}-${change.agentName}`" class="config-change-card">
                        <div class="flex items-center gap-2 flex-wrap">
                          <span class="text-xs font-mono text-cyan-200">{{ change.agentName }}</span>
                          <span class="routing-chip">{{ change.strategy }}</span>
                        </div>
                        <div v-if="change.rationale" class="text-[11px] text-gray-500 mt-1">{{ change.rationale }}</div>
                        <pre v-if="change.prompt !== undefined" class="config-change-preview">{{ change.prompt }}</pre>
                      </div>
                    </div>

                    <div v-if="proposal.feedbackHistory.length" class="space-y-2">
                      <div class="text-[11px] uppercase tracking-[0.18em] text-gray-500">Feedback History</div>
                      <div v-for="feedback in proposal.feedbackHistory.slice().reverse()" :key="`${proposal.id}-${feedback.ts}-${feedback.outcome}`" class="flow-memory-card">
                        <div class="flex items-center justify-between gap-3">
                          <span :class="flowBadgeClass(feedback.outcome)">{{ formatConfigAssistantOutcome(feedback.outcome) }}</span>
                          <span class="text-[11px] text-gray-500">{{ formatTimestamp(feedback.ts) }}</span>
                        </div>
                        <div v-if="feedback.lesson" class="text-xs text-cyan-100/80 mt-2">{{ feedback.lesson }}</div>
                        <div v-if="feedback.notes" class="text-xs text-gray-500 mt-1">{{ feedback.notes }}</div>
                      </div>
                    </div>

                    <form
                      v-if="proposalNote.proposalId === proposal.id"
                      class="proposal-note"
                      @submit.prevent="sendProposalNote"
                      @keydown.esc="onProposalNoteEscape"
                    >
                      <div class="eyebrow">{{ PROPOSAL_NOTE_TEXT[proposalNote.outcome].heading }}</div>
                      <div>
                        <label for="proposal-note-lesson" class="field-label">{{ PROPOSAL_NOTE_TEXT[proposalNote.outcome].question }} <span class="text-gray-600 font-normal">optional</span></label>
                        <textarea id="proposal-note-lesson" v-model="proposalNote.lesson" rows="3" maxlength="400" class="input-box proposal-note__box" />
                      </div>
                      <div v-if="proposalNote.outcome === 'rejected'">
                        <label for="proposal-note-extra" class="field-label">Extra notes for the rejection <span class="text-gray-600 font-normal">optional</span></label>
                        <textarea id="proposal-note-extra" v-model="proposalNote.notes" rows="2" maxlength="600" class="input-box proposal-note__box" />
                      </div>
                      <div class="flex flex-wrap justify-end gap-2">
                        <button type="button" @click="cancelProposalNote" :disabled="configAssistant.activeProposalId === proposal.id" class="btn-ghost px-3 py-1.5 rounded-lg text-xs">Cancel</button>
                        <button type="submit" :disabled="configAssistant.activeProposalId === proposal.id" class="btn-grad px-3 py-1.5 rounded-lg text-xs">
                          {{ configAssistant.activeProposalId === proposal.id ? 'Sending…' : 'Send' }}
                        </button>
                      </div>
                    </form>

                    <div v-else class="flex flex-wrap justify-end gap-2 pt-1">
                      <button
                        type="button"
                        v-if="proposal.status === 'pending'"
                        @click="applyConfigProposal(proposal.id)"
                        :disabled="configAssistant.activeProposalId === proposal.id"
                        class="btn-grad px-3 py-1.5 rounded-lg text-xs"
                      >{{ configAssistant.activeProposalId === proposal.id ? 'Applying…' : 'Apply With Consent' }}</button>
                      <button
                        type="button"
                        v-if="proposal.status === 'pending'"
                        :data-proposal-verdict="`${proposal.id}:rejected`"
                        @click="openProposalNote(proposal.id, 'rejected')"
                        :disabled="configAssistant.activeProposalId === proposal.id || proposalNote.proposalId !== ''"
                        class="btn-ghost px-3 py-1.5 rounded-lg text-xs"
                      >Reject</button>
                      <button
                        type="button"
                        v-if="proposal.status === 'applied'"
                        :data-proposal-verdict="`${proposal.id}:success`"
                        @click="openProposalNote(proposal.id, 'success')"
                        :disabled="configAssistant.activeProposalId === proposal.id || proposalNote.proposalId !== ''"
                        class="btn-ghost px-3 py-1.5 rounded-lg text-xs"
                      >Worked</button>
                      <button
                        type="button"
                        v-if="proposal.status === 'applied'"
                        :data-proposal-verdict="`${proposal.id}:partial`"
                        @click="openProposalNote(proposal.id, 'partial')"
                        :disabled="configAssistant.activeProposalId === proposal.id || proposalNote.proposalId !== ''"
                        class="btn-ghost px-3 py-1.5 rounded-lg text-xs"
                      >Partial</button>
                      <button
                        type="button"
                        v-if="proposal.status === 'applied'"
                        :data-proposal-verdict="`${proposal.id}:failure`"
                        @click="openProposalNote(proposal.id, 'failure')"
                        :disabled="configAssistant.activeProposalId === proposal.id || proposalNote.proposalId !== ''"
                        class="btn-ghost px-3 py-1.5 rounded-lg text-xs"
                      >Did Not Work</button>
                    </div>
                  </div>
                </details>
              </div>
              <div v-else class="empty-state">No conversational proposals yet.</div>
            </div>
          </div>

        <div id="model-routing" v-if="isAgentsPage" v-show="isCardShown('model-routing')" class="glass-card settings-card p-5">
          <div class="flex items-center justify-between mb-4 gap-3">
            <div>
              <h3 class="section-title mb-0" tabindex="-1">Model Routing</h3>
              <div class="text-xs text-gray-500 mt-1">Persist endpoint overrides for the default orchestrator, embeddings, reranker, and guard model.</div>
            </div>
            <div class="flex items-center gap-2 flex-wrap justify-end">
              <span v-if="isCardDirty('model-routing')" class="unsaved-chip">Unsaved</span>
              <button type="button" v-if="gateway.connected" @click="fetchModelEndpointConfig" :disabled="modelEndpointForm.loading || modelEndpointForm.saving" class="btn-ghost px-3 py-1.5 rounded-lg text-xs">Reload</button>
              <button type="button" @click="revertCard('model-routing')" :disabled="!isCardDirty('model-routing') || modelEndpointForm.loading || modelEndpointForm.saving" class="btn-ghost px-3 py-1.5 rounded-lg text-xs">Revert</button>
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
                  <label for="model-routing-primary" class="field-label">Primary Model <span class="field-required" aria-hidden="true">*</span></label>
                  <input id="model-routing-primary" v-model="modelEndpointForm.orchestratorModel" type="text" required aria-required="true" class="input-box font-mono" placeholder="lmstudio/qwen/qwen3.6-35b-a3b" />
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
                  <input v-model="modelEndpointForm.embeddingApiKey" type="password" class="input-box" autocomplete="off" :placeholder="embeddingKeyPlaceholder(modelEndpointForm, modelEndpointForm.lastLoaded, modelEndpointForm.refusedField)" />
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
                  <toggle-switch label="Reranker" :value="modelEndpointForm.rerankerEnabled" @change="modelEndpointForm.rerankerEnabled = $event" />
                </div>
              </div>
              <div class="multimodal-grid">
                <div class="md:col-span-2">
                  <label for="model-routing-reranker-model" class="field-label">Reranker Model <span v-if="modelEndpointForm.rerankerEnabled" class="field-required" aria-hidden="true">*</span></label>
                  <input id="model-routing-reranker-model" v-model="modelEndpointForm.rerankerModel" type="text" :required="modelEndpointForm.rerankerEnabled" :aria-required="modelEndpointForm.rerankerEnabled ? 'true' : undefined" class="input-box font-mono" placeholder="Qwen/Qwen3-Reranker-4B" />
                </div>
                <div class="md:col-span-2">
                  <label for="model-routing-reranker-base-url" class="field-label">Reranker Endpoint <span v-if="modelEndpointForm.rerankerEnabled" class="field-required" aria-hidden="true">*</span></label>
                  <input id="model-routing-reranker-base-url" v-model="modelEndpointForm.rerankerBaseUrl" type="text" :required="modelEndpointForm.rerankerEnabled" :aria-required="modelEndpointForm.rerankerEnabled ? 'true' : undefined" class="input-box font-mono" placeholder="http://host.docker.internal:1234/v1" />
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
                  <toggle-switch label="Guard Moderation" :value="modelEndpointForm.guardEnabled" @change="modelEndpointForm.guardEnabled = $event" />
                </div>
              </div>
              <div class="multimodal-grid">
                <div class="md:col-span-2">
                  <label for="model-routing-guard-model" class="field-label">Guard Model <span v-if="modelEndpointForm.guardEnabled" class="field-required" aria-hidden="true">*</span></label>
                  <input id="model-routing-guard-model" v-model="modelEndpointForm.guardModel" type="text" :required="modelEndpointForm.guardEnabled" :aria-required="modelEndpointForm.guardEnabled ? 'true' : undefined" class="input-box font-mono" placeholder="Qwen/Qwen3Guard-Gen-4B" />
                </div>
                <div class="md:col-span-2">
                  <label for="model-routing-guard-base-url" class="field-label">Guard Endpoint <span v-if="modelEndpointForm.guardEnabled" class="field-required" aria-hidden="true">*</span></label>
                  <input id="model-routing-guard-base-url" v-model="modelEndpointForm.guardBaseUrl" type="text" :required="modelEndpointForm.guardEnabled" :aria-required="modelEndpointForm.guardEnabled ? 'true' : undefined" class="input-box font-mono" placeholder="http://host.docker.internal:1234/v1" />
                </div>
                <div class="md:col-span-2">
                  <label class="field-label">Guard API Key</label>
                  <input v-model="modelEndpointForm.guardApiKey" type="password" class="input-box" autocomplete="off" placeholder="lm-studio" />
                </div>
              </div>
              <div v-if="getModelEndpointStatus('guard')?.error" class="text-[11px] text-red-300">{{ getModelEndpointStatus('guard')?.error }}</div>
            </div>

            <div v-if="modelEndpointForm.error" class="text-sm text-red-400">{{ shownError(modelEndpointForm.error) }}</div>

            <div class="flex justify-end">
              <button type="button" @click="submitModelEndpointConfig" :disabled="modelEndpointForm.loading || modelEndpointForm.saving" class="btn-grad px-5 py-2 rounded-xl text-sm">
                {{ modelEndpointForm.saving ? 'Saving…' : 'Save Model Routing' }}
              </button>
            </div>
          </div>
        </div>

        <!-- ── Sub-Agents ─────────────────────────────────────────────────── -->
        <div id="sub-agents" v-if="isAgentsPage" v-show="isCardShown('sub-agents')" class="glass-card settings-card p-5">
          <div class="flex items-center justify-between mb-4 gap-3 flex-wrap">
            <div class="flex items-baseline gap-3 flex-wrap">
              <h3 class="section-title mb-0" tabindex="-1">Sub-Agents</h3>
              <span class="eyebrow applies-now" title="Each agent field is saved as soon as you change it and leave the field; there is no Save button.">Applies immediately</span>
            </div>
            <button type="button" v-if="gateway.connected" @click="agentsStore.fetch()" class="btn-ghost px-3 py-1.5 rounded-lg text-xs">Reload</button>
          </div>

          <div v-if="!gateway.connected" class="empty-state">Connect to manage agents.</div>
          <div v-else-if="agentsStore.loading && !agentsStore.agents.length" class="empty-state">Loading…</div>
          <div v-else-if="agentsStore.error" class="text-sm text-red-400">{{ shownError(agentsStore.error) }}</div>

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
                <button type="button" @click="runRoutingLab" :disabled="agentsStore.routingLoading || !routingLab.query.trim()" class="btn-grad px-3 py-2 rounded-xl text-xs">
                  {{ agentsStore.routingLoading ? 'Testing…' : 'Resolve' }}
                </button>
                <button type="button" @click="clearRoutingLab" :disabled="agentsStore.routingLoading" class="btn-ghost px-3 py-2 rounded-xl text-xs">Clear</button>
              </div>

              <div v-if="agentsStore.routingError" class="text-xs text-red-400 mt-3">{{ shownError(agentsStore.routingError) }}</div>

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
                      :value="agent.model.temperature ?? ''"
                      placeholder="default"
                      @change="patchAgentModel(agent.name, 'temperature', { temperature: ($event.target as HTMLInputElement).value === '' ? null : +($event.target as HTMLInputElement).value })"
                      class="input-box text-sm" />
                  </div>
                  <div>
                    <label class="field-label text-xs">maxTokens</label>
                    <input type="number" step="256" min="256" max="1048576"
                      :value="agent.model.maxTokens ?? ''"
                      placeholder="derived"
                      title="Leave empty to derive the output budget per request from the context window. A value here is a hard ceiling."
                      @change="patchAgentModel(agent.name, 'maxTokens', { maxTokens: ($event.target as HTMLInputElement).value ? +($event.target as HTMLInputElement).value : null })"
                      class="input-box text-sm" />
                  </div>
                  <div>
                    <label class="field-label text-xs">top_p</label>
                    <input type="number" step="0.01" min="0" max="1"
                      :value="agent.model.topP ?? ''"
                      placeholder="default"
                      @change="patchAgentModel(agent.name, 'top_p', { topP: ($event.target as HTMLInputElement).value ? +($event.target as HTMLInputElement).value : null })"
                      class="input-box text-sm" />
                  </div>
                  <div>
                    <label class="field-label text-xs">top_k</label>
                    <input type="number" step="1" min="1" max="200"
                      :value="agent.model.topK ?? ''"
                      placeholder="default"
                      @change="patchAgentModel(agent.name, 'top_k', { topK: ($event.target as HTMLInputElement).value ? +($event.target as HTMLInputElement).value : null })"
                      class="input-box text-sm" />
                  </div>
                  <div>
                    <label class="field-label text-xs">min_p</label>
                    <input type="number" step="0.01" min="0" max="1"
                      :value="agent.model.minP ?? ''"
                      placeholder="default"
                      @change="patchAgentModel(agent.name, 'min_p', { minP: ($event.target as HTMLInputElement).value ? +($event.target as HTMLInputElement).value : null })"
                      class="input-box text-sm" />
                  </div>
                  <div>
                    <label class="field-label text-xs">repeat_penalty</label>
                    <input type="number" step="0.05" min="0.5" max="2"
                      :value="agent.model.repeatPenalty ?? ''"
                      placeholder="default"
                      @change="patchAgentModel(agent.name, 'repeat_penalty', { repeatPenalty: ($event.target as HTMLInputElement).value ? +($event.target as HTMLInputElement).value : null })"
                      class="input-box text-sm" />
                  </div>
                  <div>
                    <label class="field-label text-xs">seed</label>
                    <input type="number" step="1"
                      :value="agent.model.seed ?? ''"
                      placeholder="random"
                      @change="patchAgentModel(agent.name, 'seed', { seed: ($event.target as HTMLInputElement).value ? +($event.target as HTMLInputElement).value : null })"
                      class="input-box text-sm" />
                  </div>
                  <div>
                    <label class="field-label text-xs">model</label>
                    <input type="text"
                      :value="agent.model.primary ?? ''"
                      @change="patchAgentModel(agent.name, 'model', { primary: ($event.target as HTMLInputElement).value.trim() || null })"
                      class="input-box text-sm font-mono" />
                  </div>
                  <div class="md:col-span-2">
                    <label class="field-label text-xs">endpoint override <span class="text-gray-600 font-normal">optional</span></label>
                    <input type="text"
                      :value="agentEndpointDrafts[agent.name]?.baseUrl ?? agent.model.baseUrl ?? ''"
                      placeholder="uses provider default"
                      @input="agentEndpointDraft(agent.name).baseUrl = ($event.target as HTMLInputElement).value"
                      @change="saveAgentEndpoint(agent)"
                      class="input-box text-sm font-mono" />
                  </div>
                  <div class="md:col-span-2">
                    <label class="field-label text-xs">endpoint api key <span class="text-gray-600 font-normal">optional</span></label>
                    <input type="password"
                      :value="agentEndpointDrafts[agent.name]?.apiKey ?? agent.model.apiKey ?? ''"
                      placeholder="uses the default key, or none at an endpoint of its own"
                      autocomplete="off"
                      @input="agentEndpointDraft(agent.name).apiKey = ($event.target as HTMLInputElement).value"
                      @change="saveAgentEndpoint(agent)"
                      class="input-box text-sm" />
                    <div v-if="agentEndpointDrafts[agent.name]?.error" class="text-xs text-amber-400 mt-1">{{ agentEndpointDrafts[agent.name]?.error }}</div>
                  </div>
                  <div class="md:col-span-2 flex items-center justify-between gap-4 pt-1">
                    <div>
                      <label class="field-label text-xs">thinking mode <span class="text-gray-600 font-normal">supported reasoning models</span></label>
                      <p class="text-[11px] text-gray-600 mt-0.5">When set, {{ product.name }} sends <code class="text-gray-400">enable_thinking</code> via <code class="text-gray-400">extra_body</code> for models that support it, including Gemma 4 and Qwen. Qwen also gets its recommended sampling defaults unless you explicitly override <code class="text-gray-400">top_p</code>.</p>
                    </div>
                    <select
                      :value="agent.model.enableThinking === undefined ? '' : agent.model.enableThinking ? 'on' : 'off'"
                      @change="patchAgentModel(agent.name, 'thinking mode', { enableThinking: ($event.target as HTMLSelectElement).value === '' ? null : ($event.target as HTMLSelectElement).value === 'on' })"
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

        <!-- ── Channels ───────────────────────────────────────────────────── -->
        <div id="channels" v-if="isSettingsPage" v-show="isCardShown('channels')" class="glass-card settings-card p-5">
          <div class="flex items-center justify-between mb-4">
            <div class="flex items-center gap-3">
              <h3 class="section-title mb-0" tabindex="-1">Channels</h3>
              <span v-if="channelsStore.deadLetterCount > 0" class="text-xs px-2 py-0.5 rounded-full bg-red-900/60 text-red-300 font-medium" title="Messages that failed all delivery retries">
                {{ channelsStore.deadLetterCount }} dead letter{{ channelsStore.deadLetterCount === 1 ? '' : 's' }}
              </span>
            </div>
            <button type="button" v-if="gateway.connected" @click="channelsStore.fetch(); channelsStore.fetchDeadLetterCount()" class="btn-ghost px-3 py-1.5 rounded-lg text-xs">Reload</button>
          </div>

          <div v-if="!gateway.connected" class="empty-state">Connect to manage channels.</div>
          <div v-else-if="channelsStore.loading && !channelsStore.channels.length" class="empty-state">Loading…</div>
          <div v-else-if="channelsStore.error" class="text-sm text-red-400">{{ shownError(channelsStore.error) }}</div>

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
                <button type="button" @click="void openChannelForm(def)" :disabled="!gateway.connected"
                  class="icon-btn shrink-0" title="Configure" :aria-label="`Configure the ${def.label} channel`">✏</button>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  </div>

  <!-- ── Site form modal ─────────────────────────────────────────────────── -->
  <div v-if="siteForm.open" class="modal-backdrop" @click.self="dismissSiteForm">
    <div ref="siteDialogEl" class="modal-box" role="dialog" aria-modal="true" aria-labelledby="site-dialog-title">
      <div class="modal-header">
        <h3 id="site-dialog-title" class="font-semibold text-gray-100">{{ siteForm.editing ? 'Edit Site' : 'Add Site' }}</h3>
        <button type="button" @click="siteForm.open = false" class="modal-close" aria-label="Close">✕</button>
      </div>

      <div class="space-y-4 p-5">
        <div>
          <label for="site-hostname" class="field-label">Hostname <span class="field-required" aria-hidden="true">*</span></label>
          <input id="site-hostname" v-model="siteForm.hostname" type="text" required aria-required="true" class="input-box"
            placeholder="e.g. github.com" :disabled="!!siteForm.editing" />
        </div>
        <div>
          <label for="site-username" class="field-label">Username <span class="field-required" aria-hidden="true">*</span></label>
          <input id="site-username" v-model="siteForm.username" type="text" required aria-required="true" class="input-box" placeholder="Email or username" />
        </div>
        <div>
          <label for="site-password" class="field-label">Password <span v-if="!siteForm.editing" class="field-required" aria-hidden="true">*</span>
            <span class="ml-1 text-gray-600 font-normal text-xs">(use $ENV_VAR or secret:key<template v-if="siteForm.editing">; leave empty to keep the stored one</template>)</span></label>
          <input id="site-password" v-model="siteForm.password" type="password" :required="!siteForm.editing" :aria-required="siteForm.editing ? undefined : 'true'" class="input-box" autocomplete="new-password" placeholder="$MY_PASSWORD or secret:mykey" />
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
              <button type="button" @click="siteForm.urlEntries.splice(i, 1)" class="text-gray-600 hover:text-red-400 transition-colors px-1 text-lg leading-none" aria-label="Remove this URL">✕</button>
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
        <button type="button" @click="siteForm.open = false" class="btn-ghost px-4 py-2 rounded-xl text-sm">Cancel</button>
        <button type="button" @click="submitSiteForm" :disabled="sites.loading" class="btn-grad px-5 py-2 rounded-xl text-sm">
          {{ sites.loading ? 'Saving…' : 'Save' }}
        </button>
      </div>
    </div>
  </div>

  <div v-if="jobForm.open" class="modal-backdrop" @click.self="dismissJobForm">
    <div ref="jobDialogEl" class="modal-box" role="dialog" aria-modal="true" aria-labelledby="job-dialog-title">
      <div class="modal-header">
        <h3 id="job-dialog-title" class="font-semibold text-gray-100">{{ jobForm.editing ? 'Edit Job' : 'Add Job' }}</h3>
        <button type="button" @click="jobForm.open = false" class="modal-close" aria-label="Close">✕</button>
      </div>

      <div class="space-y-4 p-5">
        <div>
          <label for="job-name" class="field-label">Name <span class="field-required" aria-hidden="true">*</span></label>
          <input id="job-name" v-model="jobForm.name" type="text" required aria-required="true" class="input-box font-mono" placeholder="e.g. morning_ops" :disabled="!!jobForm.editing" />
        </div>
        <div>
          <label for="job-description" class="field-label">Description <span class="field-required" aria-hidden="true">*</span></label>
          <input id="job-description" v-model="jobForm.description" type="text" required aria-required="true" class="input-box" placeholder="One-line summary of the workflow" />
        </div>
        <!-- Params, steps and triggers are written as JSON. Each box is checked a moment after
             the last keystroke and says what it found on the line beneath it. -->
        <div v-for="box in JOB_JSON_BOXES" :key="box.key">
          <label :for="`job-${box.key}-json`" class="field-label">{{ box.label }} <span v-if="box.required" class="field-required" aria-hidden="true">*</span></label>
          <textarea
            :id="`job-${box.key}-json`"
            v-model="jobForm[box.field]"
            class="input-box font-mono text-xs json-box"
            :rows="box.rows"
            :placeholder="box.placeholder"
            spellcheck="false"
            :required="box.required"
            :aria-required="box.required ? 'true' : undefined"
            :aria-invalid="jobJson[box.key].state === 'error' ? 'true' : undefined"
            :aria-describedby="`job-${box.key}-json-status`"
          />
          <p
            :id="`job-${box.key}-json-status`"
            class="json-status"
            :class="`json-status--${jobJson[box.key].state}`"
            :role="jobJson[box.key].state === 'error' ? 'alert' : 'status'"
          >{{ jobJson[box.key].message }}</p>
        </div>
      </div>

      <div v-if="jobJsonBroken.length" class="px-5 pb-2 text-sm text-amber-300" role="status">
        Can't save yet: {{ listInWords(jobJsonBroken) }} {{ jobJsonBroken.length === 1 ? 'needs' : 'need' }} fixing.
      </div>
      <div v-if="jobForm.error" class="px-5 pb-2 text-sm text-red-400">{{ jobForm.error }}</div>

      <div class="modal-footer">
        <button type="button" @click="jobForm.open = false" class="btn-ghost px-4 py-2 rounded-xl text-sm">Cancel</button>
        <button type="button" @click="submitJobForm" :disabled="jobsStore.loading || jobJsonBroken.length > 0" class="btn-grad px-5 py-2 rounded-xl text-sm">
          {{ jobsStore.loading ? 'Saving…' : 'Save' }}
        </button>
      </div>
    </div>
  </div>

  <!-- ── Channel form modal ──────────────────────────────────────────────── -->
  <div v-if="channelForm.open" class="modal-backdrop" @click.self="dismissChannelForm">
    <div ref="channelDialogEl" class="modal-box" role="dialog" aria-modal="true" aria-labelledby="channel-dialog-title">
      <div class="modal-header">
        <h3 id="channel-dialog-title" class="font-semibold text-gray-100">Configure {{ channelForm.label }}</h3>
        <button type="button" @click="channelForm.open = false" class="modal-close" aria-label="Close">✕</button>
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
          <toggle-switch :label="`${channelForm.label} channel`" :value="!!channelForm.config.enabled"
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
        <button type="button" @click="closeChannelForm" class="btn-ghost px-4 py-2 rounded-xl text-sm">Cancel</button>
        <button type="button" @click="submitChannelForm" :disabled="channelsStore.loading" class="btn-grad px-5 py-2 rounded-xl text-sm">
          {{ channelsStore.loading ? 'Saving…' : 'Save' }}
        </button>
      </div>
    </div>
  </div>

  <!-- ── Scene form modal ────────────────────────────────────────────────── -->
  <div v-if="sceneForm.open" class="modal-backdrop" @click.self="dismissSceneForm">
    <div ref="sceneDialogEl" class="modal-box" role="dialog" aria-modal="true" aria-labelledby="scene-dialog-title">
      <div class="modal-header">
        <h3 id="scene-dialog-title" class="font-semibold text-gray-100">{{ sceneForm.editing ? 'Edit Scene' : 'Add Scene' }}</h3>
        <button type="button" @click="sceneForm.open = false" class="modal-close" aria-label="Close">✕</button>
      </div>

      <div class="space-y-4 p-5">
        <div>
          <label for="scene-name" class="field-label">Name <span class="field-required" aria-hidden="true">*</span>
            <span class="ml-1 text-gray-600 font-normal text-xs">(letters, numbers, underscores)</span></label>
          <input id="scene-name" v-model="sceneForm.name" type="text" required aria-required="true" class="input-box font-mono"
            placeholder="e.g. apply_jobs" :disabled="!!sceneForm.editing" />
        </div>
        <div>
          <label for="scene-description" class="field-label">Description <span class="field-required" aria-hidden="true">*</span></label>
          <input id="scene-description" v-model="sceneForm.description" type="text" required aria-required="true" class="input-box" placeholder="One-line description shown in the UI" />
        </div>
        <div>
          <label for="scene-task" class="field-label">Task Prompt <span class="field-required" aria-hidden="true">*</span></label>
          <textarea id="scene-task" v-model="sceneForm.task" required aria-required="true" class="input-box font-mono text-xs resize-none" rows="9"
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
        <button type="button" @click="sceneForm.open = false" class="btn-ghost px-4 py-2 rounded-xl text-sm">Cancel</button>
        <button type="button" @click="submitSceneForm" :disabled="scenesStore.loading" class="btn-grad px-5 py-2 rounded-xl text-sm">
          {{ scenesStore.loading ? 'Saving…' : 'Save' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from "vue";
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter, type RouteLocationNormalized } from "vue-router";
import { useGatewayStore } from "@/stores/gateway";
import { useGuardrailsStore } from "@/stores/guardrails";
import { usePersonalityStore, type AssistantPersonalityProfile } from "@/stores/personality";
import { useSitesStore, type SiteSummary } from "@/stores/sites";
import { useScenesStore, type SceneDetail } from "@/stores/scenes";
import { useJobsStore, type JobDetail, type JobTriggerInput, type JobStepInput } from "@/stores/jobs";
import { useChannelsStore, type ChannelConfig, type ChannelDetail, type ChannelStatus } from "@/stores/channels";
import { useRuntimeStore } from "@/stores/runtime";
import { useAgentsStore, type AgentInfo } from "@/stores/agents";
import { useMultimodalStore, type MultimodalConfig } from "@/stores/multimodal";
import { buildMultimodalPatch, embeddingKeyPlaceholder, keyAsSaved, keysNeedingReentry, modelEndpointKeysAsSaved, tierKeyFollowsMove } from "@/composables/multimodalSettings";
import { useConfigAssistantStore, type ConfigAssistantFeedbackOutcome, type ConfigAssistantMode, type FlowMemoryOutcome, type FlowMemoryScope } from "@/stores/configAssistant";
import ToggleSwitch from "@/components/ToggleSwitch.vue";
import ChannelIcon from "@/components/ChannelIcon.vue";
import AppearanceSettings from "@/components/AppearanceSettings.vue";
import VoiceStudio from "@/components/settings/VoiceStudio.vue";
import { appVersion } from "@/appVersion";
import { useProductStore } from "@/stores/product";
import { confirmAction } from "@/composables/useConfirm";
import { useEscapeToClose } from "@/composables/useEscapeToClose";
import { useFocusTrap } from "@/composables/useFocusTrap";
import { errorText, useToast } from "@/composables/useToast";

// Product name comes from GET /api/product so a fork rebrands without editing this
// file (docs/fork-boilerplate-plan.md WS1).
const product = useProductStore();

const route = useRoute();
const gateway = useGatewayStore();
const guardrails = useGuardrailsStore();
const personalityStore = usePersonalityStore();
const sites = useSitesStore();
const scenesStore = useScenesStore();
const jobsStore = useJobsStore();
const channelsStore = useChannelsStore();
const runtime = useRuntimeStore();
const agentsStore = useAgentsStore();
const multimodalStore = useMultimodalStore();
const configAssistant = useConfigAssistantStore();
const toast = useToast();

// The stores keep a failure as String(error), which reads "Error: HTTP 503". Shown to a person,
// the class name in front says nothing: it is dropped here, where the text is displayed.
function shownError(text: string | null | undefined): string {
  return (text ?? "").replace(/^(?:[A-Za-z]*Error:\s*)+/, "");
}

/** "A", "A and B", "A, B, and C". */
function listInWords(items: readonly string[]): string {
  return new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(items);
}

const pageMode = computed<"settings" | "agents">(() => {
  if (route.path === "/agents") return "agents";
  return "settings";
});
const isSettingsPage = computed(() => pageMode.value === "settings");
const isAgentsPage = computed(() => pageMode.value === "agents");
// Each title is the name the navigation gives the route, so the menu and the page agree.
const pageTitle = computed(() => {
  if (isAgentsPage.value) return "Agent tuning";
  return "Settings";
});
const pageDescription = computed(() => {
  if (isAgentsPage.value) {
    return "Assistant personality, model endpoints and routing, orchestration tuning, skill automation, Document RAG, the user model, sub-agents, and configuration proposals live here.";
  }
  return "Appearance, gateway connection, runtime health, multimodal services, guardrails, site credentials, scenes, jobs, and channels live here.";
});

const routingLab = reactive({
  query: "",
  minConfidence: "medium" as "high" | "medium" | "low",
});

const configAssistantForm = reactive({
  request: "",
  mode: "enhancement" as ConfigAssistantMode,
  targetAgent: "",
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
  sttModel: "whisper-1",
  ttsBaseUrl: "",
  ttsApi: "openai-compatible" as "qwen-compatible" | "openai-compatible" | "tts-stt-gateway",
  ttsApiKey: "",
  ttsTimeoutMs: 60_000,
  ttsModel: "tts-1",
  ttsDefaultLanguage: "English",
  ttsDefaultSpeaker: "Luna",
  ttsDefaultVoiceId: "",
  ttsVoiceSamplePath: "",
  ttsVoiceSampleText: "",
  ttsDefaultQuality: "medium",
  imageGenBaseUrl: "",
  imageGenApi: "automatic1111-compatible" as "automatic1111-compatible" | "comfyui" | "openai-compatible",
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

const personalityForm = reactive({
  name: "",
  identity: "",
  toneText: "",
  styleText: "",
  defaultsText: "",
  avoidancesText: "",
  quirksText: "",
  growthNotesText: "",
  reason: "",
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

const qwenTtsStatus = computed(() => multimodalStore.status?.tts ?? null);
const qwenVoiceSaveSupported = computed(() => {
  if (multimodalForm.ttsApi !== "qwen-compatible") return undefined;
  return qwenTtsStatus.value?.voiceCloneSupported;
});
const qwenVoiceSaveMessage = computed(() => {
  if (qwenVoiceSaveSupported.value !== false) return "";
  const modelName = qwenTtsStatus.value?.modelName ?? qwenTtsStatus.value?.modelId ?? "The selected model";
  return `${modelName} cannot save or replay cloned voices. Switch the playground to a Base model with voice_clone capability before uploading a sample.`;
});
const qwenBuiltInSpeakerMessage = computed(() => {
  if (multimodalForm.ttsApi !== "qwen-compatible") return "";
  if (qwenTtsStatus.value?.customVoiceSupported === true) return "";
  if (qwenTtsStatus.value?.voiceCloneSupported !== true) return "";
  const modelName = qwenTtsStatus.value?.modelName ?? qwenTtsStatus.value?.modelId ?? "The selected model";
  return `${modelName} is a voice-clone model. Plain speaker synthesis may fail until you save a voice and set Default Voice ID, or switch to a model with custom_voice capability.`;
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
  /** The key the gateway named when it refused the last save (details.field). */
  refusedField: "",
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
  markSaved("model-routing");
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
  // The reranker and the guard need a model and an endpoint only while they are switched on.
  // The gateway wants both fields filled even for a section that is off, so one left empty
  // behind a switched-off toggle goes back as it was loaded.
  const stored = modelEndpointForm.lastLoaded;
  const reranker = modelEndpointForm.rerankerEnabled ? undefined : stored?.reranker;
  const rerankerModel = modelEndpointForm.rerankerModel.trim() || reranker?.model || "";
  const rerankerBaseUrl = modelEndpointForm.rerankerBaseUrl.trim() || reranker?.baseUrl || "";
  if (!rerankerModel || !rerankerBaseUrl) {
    modelEndpointForm.error = modelEndpointForm.rerankerEnabled
      ? "Reranker model and endpoint are required while the reranker is on"
      : "Reranker model and endpoint are required";
    return;
  }
  const guard = modelEndpointForm.guardEnabled ? undefined : stored?.guard;
  const guardModel = modelEndpointForm.guardModel.trim() || guard?.model || "";
  const guardBaseUrl = modelEndpointForm.guardBaseUrl.trim() || guard?.baseUrl || "";
  if (!guardModel || !guardBaseUrl) {
    modelEndpointForm.error = modelEndpointForm.guardEnabled
      ? "Guard model and endpoint are required while guard moderation is on"
      : "Guard model and endpoint are required";
    return;
  }

  modelEndpointForm.saving = true;
  try {
    // Left empty, the orchestrator key falls back to the provider's and the embeddings key to the
    // orchestrator's; the gateway sends neither to an endpoint it was not already going to, so an
    // empty key beside a moved endpoint is saved as "" — no key (see modelEndpointKeysAsSaved).
    const keys = modelEndpointKeysAsSaved(modelEndpointForm, modelEndpointForm.lastLoaded, modelEndpointForm.refusedField);
    const orchestratorBaseUrl = modelEndpointForm.orchestratorBaseUrl.trim();
    const embeddingBaseUrl = modelEndpointForm.embeddingBaseUrl.trim();
    const payload: ModelEndpointEditorConfig = {
      orchestrator: {
        primary: modelEndpointForm.orchestratorModel.trim(),
        baseUrl: orchestratorBaseUrl || undefined,
        apiKey: keys.apiKey,
      },
      embeddings: {
        embeddingModel: modelEndpointForm.embeddingModel.trim() || undefined,
        embeddingBaseUrl: embeddingBaseUrl || undefined,
        embeddingApiKey: keys.embeddingApiKey,
      },
      reranker: {
        enabled: modelEndpointForm.rerankerEnabled,
        model: rerankerModel,
        baseUrl: rerankerBaseUrl,
        apiKey: modelEndpointForm.rerankerApiKey.trim() || "lm-studio",
      },
      guard: {
        enabled: modelEndpointForm.guardEnabled,
        model: guardModel,
        baseUrl: guardBaseUrl,
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
      const refusal = await response.clone().json().catch(() => null) as { details?: { field?: unknown } } | null;
      modelEndpointForm.refusedField = typeof refusal?.details?.field === "string" ? refusal.details.field : "";
      throw new Error(await parseSettingsError(response));
    }

    modelEndpointForm.refusedField = "";
    syncModelEndpointForm(await response.json() as ModelEndpointEditorConfig);
    toast.success("Model routing saved", "The orchestrator, embeddings, reranker and guard endpoints are stored; their health is checked again.");
    await runtime.fetch();
  } catch (error) {
    modelEndpointForm.error = error instanceof Error ? error.message : String(error);
  } finally {
    modelEndpointForm.saving = false;
  }
}

// A sub-agent's endpoint and key are saved TOGETHER. The gateway sends a saved key only where it
// already went, so an endpoint patched alone was refused, and a key patched first was saved and
// then refused again at the endpoint patched after it. Each field keeps its draft until a save
// of both succeeds; a refusal is shown beside them.
const agentEndpointDrafts = reactive<Record<string, { baseUrl?: string; apiKey?: string; error?: string }>>({});

function agentEndpointDraft(name: string) {
  return (agentEndpointDrafts[name] ??= {});
}

async function saveAgentEndpoint(agent: AgentInfo) {
  const draft = agentEndpointDraft(agent.name);
  const baseUrl = (draft.baseUrl ?? agent.model.baseUrl ?? "").trim();
  // Left empty, the key falls back to the default one (see keyAsSaved); the mask stands for the saved key.
  const apiKey = keyAsSaved(draft.apiKey ?? agent.model.apiKey ?? "", baseUrl, { key: agent.model.apiKey, endpoint: agent.model.baseUrl });
  const refusal = await agentsStore.patchModel(agent.name, { baseUrl: baseUrl || null, apiKey: apiKey ?? null });
  if (refusal) {
    draft.error = refusal;
    return;
  }
  delete agentEndpointDrafts[agent.name];
  toast.success("Agent endpoint saved", `${agent.name} uses ${baseUrl || "the provider's default endpoint"}.`);
}

// A refused patch makes the store fetch the agents again, which clears its error line and snaps
// the field back to the old value: the reason is raised here, where it outlives that.
async function patchAgentModel(name: string, label: string, patch: Parameters<typeof agentsStore.patchModel>[1]) {
  const refusal = await agentsStore.patchModel(name, patch);
  if (refusal) {
    toast.error(`Couldn't change ${label} for ${name}`, refusal);
    return;
  }
  const value = Object.values(patch)[0];
  const state = value === null ? "back to its default" : `now ${value === true ? "on" : value === false ? "off" : String(value)}`;
  toast.success("Agent setting saved", `${name}: ${label} is ${state}.`);
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

function listFromLines(value: string): string[] {
  return value.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
}

function linesFromList(values: readonly string[]): string {
  return values.join("\n");
}

function syncPersonalityForm(profile: AssistantPersonalityProfile | null) {
  personalityForm.name = profile?.identity.name ?? "";
  personalityForm.identity = profile?.identity.core ?? "";
  personalityForm.toneText = linesFromList(profile?.voice.tone ?? []);
  personalityForm.styleText = linesFromList(profile?.voice.style ?? []);
  personalityForm.defaultsText = linesFromList(profile?.collaboration.defaults ?? []);
  personalityForm.avoidancesText = linesFromList(profile?.collaboration.avoidances ?? []);
  personalityForm.quirksText = linesFromList(profile?.voice.quirks ?? []);
  personalityForm.growthNotesText = linesFromList(profile?.growth.notes ?? []);
  personalityForm.reason = "";
  personalityForm.error = "";
  markSaved("personality");
}

function resetPersonalityForm() {
  syncPersonalityForm(personalityStore.lastLoaded);
}

async function submitPersonalityForm() {
  personalityForm.error = "";
  if (!personalityForm.identity.trim()) {
    personalityForm.error = "Identity is required";
    return;
  }

  await personalityStore.save({
    identity: {
      name: personalityForm.name.trim() || undefined,
      core: personalityForm.identity.trim(),
    },
    voice: {
      tone: listFromLines(personalityForm.toneText),
      style: listFromLines(personalityForm.styleText),
      quirks: listFromLines(personalityForm.quirksText),
    },
    collaboration: {
      defaults: listFromLines(personalityForm.defaultsText),
      avoidances: listFromLines(personalityForm.avoidancesText),
    },
    growth: {
      notes: listFromLines(personalityForm.growthNotesText),
    },
    reason: personalityForm.reason.trim() || undefined,
  });

  if (personalityStore.error) personalityForm.error = personalityStore.error;
  else toast.success("Personality saved", "The assistant uses it from the next turn.");
}

async function restoreDefaultPersonality() {
  const confirmed = await confirmAction({
    title: "Reset the personality to the built-in defaults?",
    message: "The assistant's name, identity, tone, style, collaboration notes, quirks and growth notes are replaced with the defaults. What is saved now cannot be brought back.",
    confirmLabel: "Reset personality",
    danger: true,
  });
  if (!confirmed) return;
  personalityForm.error = "";
  await personalityStore.reset();
  if (personalityStore.error) personalityForm.error = personalityStore.error;
  else toast.success("Personality reset", "The built-in defaults are in use again.");
}

function formatPersonalityUpdatedAt(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

type MultimodalFormFields = Omit<typeof multimodalForm, "error">;

/** The form's fields as a stored config has them. */
function multimodalFormFields(config: MultimodalConfig): MultimodalFormFields {
  return {
    maxUploadBytes: config.maxUploadBytes,
    filesBaseUrl: config.files.baseUrl,
    filesApiKey: config.files.apiKey ?? "",
    filesTimeoutMs: config.files.timeoutMs,
    fileToolName: config.files.toolName,
    visionModel: config.files.visionModel ?? "",
    visionBaseUrl: config.files.visionBaseUrl ?? "",
    visionApiKey: config.files.visionApiKey ?? "",
    sttBaseUrl: config.stt.baseUrl,
    sttApi: config.stt.api,
    sttApiKey: config.stt.apiKey ?? "",
    sttTimeoutMs: config.stt.timeoutMs,
    sttModel: config.stt.model,
    ttsBaseUrl: config.tts.baseUrl,
    ttsApi: config.tts.api,
    ttsApiKey: config.tts.apiKey ?? "",
    ttsTimeoutMs: config.tts.timeoutMs,
    ttsModel: config.tts.model ?? "",
    ttsDefaultLanguage: config.tts.defaultLanguage,
    ttsDefaultSpeaker: config.tts.defaultSpeaker,
    ttsDefaultVoiceId: config.tts.defaultVoiceId ?? "",
    ttsVoiceSamplePath: config.tts.voiceSamplePath ?? "",
    ttsVoiceSampleText: config.tts.voiceSampleText ?? "",
    ttsDefaultQuality: config.tts.defaultQuality,
    imageGenBaseUrl: config.imageGeneration?.baseUrl ?? "",
    imageGenApi: config.imageGeneration?.api ?? "automatic1111-compatible",
    imageGenApiKey: config.imageGeneration?.apiKey ?? "",
    imageGenTimeoutMs: config.imageGeneration?.timeoutMs ?? 120_000,
    imageGenModel: config.imageGeneration?.model ?? "",
    imageGenDefaultWidth: config.imageGeneration?.defaultWidth ?? 1024,
    imageGenDefaultHeight: config.imageGeneration?.defaultHeight ?? 1024,
    imageGenDefaultSteps: config.imageGeneration?.defaultSteps ?? 28,
    imageGenGuidanceScale: config.imageGeneration?.defaultGuidanceScale ?? 5.0,
    imageGenDefaultNegativePrompt: config.imageGeneration?.defaultNegativePrompt ?? "",
    wakeEnabled: config.wakeWord.enabled,
    wakeLanguage: config.wakeWord.language,
    wakeSilenceTimeoutMs: config.wakeWord.silenceTimeoutMs,
    wakeKeywordsText: config.wakeWord.keywords.join(", "),
    wakeStopPhrasesText: config.wakeWord.stopPhrases.join(", "),
  };
}

/** The whole form follows the stored config: a load, this card's Save, Revert. */
function syncMultimodalForm(config: MultimodalConfig) {
  Object.assign(multimodalForm, multimodalFormFields(config));
  savedVoiceForm.language = config.tts.defaultLanguage;
  multimodalForm.error = "";
  markSaved("multimodal");
}

function resetMultimodalForm() {
  syncMultimodalForm(multimodalStore.config);
}

// The store's config is replaced as a whole by every load and every save — also by a save made
// beside the form: the Voice Studio's voices, "Upload And Save Voice". Syncing the whole form
// to it then threw away whatever had been typed and not saved, and the "Unsaved" mark with it.
// So only a load and this card's own Save hand the form the whole stored config (counted here
// while one runs). Any other change brings in just the fields whose stored value changed.
let wholeMultimodalFormFollows = 0;

async function replacingMultimodalForm(run: () => Promise<void>) {
  wholeMultimodalFormFollows += 1;
  try {
    await run();
  } finally {
    wholeMultimodalFormFollows -= 1;
  }
}

function reloadMultimodal() {
  return replacingMultimodalForm(() => multimodalStore.fetch());
}

/** What a save beside the form changed in the stored config, and nothing else. */
function adoptStoredMultimodalFields(config: MultimodalConfig, previous: MultimodalConfig) {
  const before = multimodalFormFields(previous);
  const after = multimodalFormFields(config);
  const changed: Partial<Record<keyof MultimodalFormFields, unknown>> = {};
  for (const key of Object.keys(after) as Array<keyof MultimodalFormFields>) {
    if (after[key] !== before[key]) changed[key] = after[key];
  }
  Object.assign(multimodalForm, changed);
  if ("ttsDefaultLanguage" in changed) savedVoiceForm.language = config.tts.defaultLanguage;
  // These fields are stored as they now stand; the rest of the form is compared as before.
  markFieldsSaved("multimodal", changed);
}

// Key fields whose endpoint changed while they still show the saved key's mask: the gateway
// will not send a saved key to a new endpoint, so each says so beside itself. The field the
// gateway named in its last refusal counts too, for moves only it can see.
const refusedMultimodalKey = computed(() => (multimodalStore.error ? multimodalStore.errorField : ""));
const keysToReenter = computed(() => new Set(keysNeedingReentry(
  multimodalStore.config,
  multimodalForm,
  refusedMultimodalKey.value,
)));
// The quality tier has a saved key of its own and no endpoint of its own, and the image endpoint
// moved: its key would follow, and it has no field, so the save drops it (buildMultimodalConfig).
const tierKeyMoves = computed(() => tierKeyFollowsMove(multimodalStore.config, multimodalForm, refusedMultimodalKey.value));

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

  if (qwenVoiceSaveSupported.value === false) {
    savedVoiceForm.error = true;
    savedVoiceForm.message = qwenVoiceSaveMessage.value;
    return;
  }

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
      referenceText: multimodalForm.ttsVoiceSampleText.trim() || undefined,
    });
    multimodalForm.ttsDefaultVoiceId = result.voice_id;
    if (!multimodalForm.ttsVoiceSampleText.trim() && result.ref_text) {
      multimodalForm.ttsVoiceSampleText = result.ref_text;
    }

    // Only the two fields this action owns go back, as a patch the gateway merges. It used to
    // send a copy of the whole stored config — and making that copy failed in the browser (the
    // store's config cannot be cloned), so the voice was uploaded and never became the default.
    const ownFields: { defaultVoiceId: string; voiceSampleText?: string } = { defaultVoiceId: result.voice_id };
    if (!multimodalStore.config.tts.voiceSampleText && result.ref_text) {
      ownFields.voiceSampleText = result.ref_text;
    }
    await multimodalStore.save({ tts: ownFields });
    if (multimodalStore.error) {
      throw new Error(`Saved voice '${result.name}' as '${result.voice_id}', but failed to persist it as Default Voice ID: ${shownError(multimodalStore.error)}`);
    }

    savedVoiceForm.error = false;
    savedVoiceForm.message = `Saved voice '${result.name}' as '${result.voice_id}' and set it as Default Voice ID`;
    toast.success("Voice saved", `"${result.name}" is in the library and is now the default voice.`);
    void loadSavedVoices();
  } catch (error) {
    savedVoiceForm.error = true;
    savedVoiceForm.message = error instanceof Error ? error.message : String(error);
  } finally {
    savedVoiceForm.saving = false;
  }
}

const voiceLibrary = reactive({
  loading: false,
  loaded: false,
  voices: [] as Array<{ voice_id: string; name: string; lang?: string }>,
  removingId: null as string | null,
  error: "",
});

async function loadSavedVoices() {
  if (!multimodalForm.ttsBaseUrl.trim() || multimodalForm.ttsApi !== "qwen-compatible") return;
  voiceLibrary.loading = true;
  voiceLibrary.error = "";
  try {
    const catalog = await gateway.listVoices();
    voiceLibrary.voices = catalog.voices.map((v) => ({
      voice_id: v.voice_id,
      name: v.name ?? v.voice_id,
      lang: v.lang,
    }));
    voiceLibrary.loaded = true;
  } catch (error) {
    voiceLibrary.error = error instanceof Error ? error.message : String(error);
  } finally {
    voiceLibrary.loading = false;
  }
}

async function removeSavedVoice(voiceId: string) {
  const confirmed = await confirmAction({
    title: `Remove the voice "${voiceId}"?`,
    message: "It is deleted from the speech backend's voice library. This cannot be undone; to use it again you upload its sample again.",
    confirmLabel: "Remove voice",
    danger: true,
  });
  if (!confirmed) return;
  voiceLibrary.removingId = voiceId;
  voiceLibrary.error = "";
  try {
    await gateway.removeTtsVoice(voiceId);
    voiceLibrary.voices = voiceLibrary.voices.filter((v) => v.voice_id !== voiceId);
    if (multimodalForm.ttsDefaultVoiceId === voiceId) {
      multimodalForm.ttsDefaultVoiceId = "";
    }
    toast.success("Voice removed", `"${voiceId}" is gone from the library.`);
  } catch (error) {
    voiceLibrary.error = error instanceof Error ? error.message : String(error);
  } finally {
    voiceLibrary.removingId = null;
  }
}

async function submitMultimodalForm() {
  multimodalForm.error = "";

  const wakeKeywords = listFromCsv(multimodalForm.wakeKeywordsText);
  const wakeStopPhrases = listFromCsv(multimodalForm.wakeStopPhrasesText);

  if (!multimodalForm.filesBaseUrl.trim()) {
    multimodalForm.error = "A file conversion endpoint is required";
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

  // Caught here rather than by a refused save: the hint beside each key says what to do.
  if (keysNeedingReentry(multimodalStore.config, multimodalForm).length > 0) {
    multimodalForm.error = "An endpoint changed: enter its API key again, or clear the key field.";
    return;
  }

  // Only what the user changed goes back; the server merges it over what it stored (see
  // buildMultimodalPatch).
  await replacingMultimodalForm(() => multimodalStore.save(buildMultimodalPatch(multimodalStore.config, multimodalForm, {
    keywords: wakeKeywords,
    stopPhrases: wakeStopPhrases,
  }, refusedMultimodalKey.value)));

  if (!multimodalStore.error) {
    syncMultimodalForm(multimodalStore.config);
    toast.success("Multimodal settings saved", "File, speech and image services use the new settings, and the chat's wake-word settings are in sync.");
  } else {
    multimodalForm.error = shownError(multimodalStore.error);
  }
}

// ── Guardrails ───────────────────────────────────────────────────────────────

type GuardrailPatch = Parameters<typeof guardrails.update>[0];

function describeGuardrails(patch: GuardrailPatch): string {
  if (patch.promptInjectionBlock !== undefined) return `Prompt injection protection is ${patch.promptInjectionBlock ? "on" : "off"}.`;
  if (patch.outputSecretScan !== undefined) return `Output secret scanning is ${patch.outputSecretScan ? "on" : "off"}.`;
  return `Messages may be up to ${(patch.maxInputLength ?? 0).toLocaleString()} characters long.`;
}

// The store fetches the state again after a refused update, which clears its error line, and it
// returns nothing: whether the change took is read off the state that came back.
async function updateGuardrails(patch: GuardrailPatch) {
  await guardrails.update(patch);
  const state = guardrails.state;
  const applied = state !== null && (Object.keys(patch) as Array<keyof GuardrailPatch>).every((key) => state[key] === patch[key]);
  if (applied) toast.success("Guardrails updated", describeGuardrails(patch));
  else toast.error("Guardrail not changed", shownError(guardrails.error) || "The gateway did not take this value. The control shows what is in effect.");
}

// Switching a protection off took effect on one click. Off asks first, and says what is no
// longer checked; on needs no question. The switch shows the stored state, so backing out of the
// question leaves it where it was.
const PROTECTION_OFF_QUESTIONS = {
  promptInjectionBlock: {
    title: "Turn off prompt injection protection?",
    message: "Incoming messages, and what tools bring back from web pages and files, are no longer checked for jailbreak and injection patterns: text written to take over an agent reaches it unblocked. You can switch the protection back on here at any time.",
  },
  outputSecretScan: {
    title: "Turn off output secret scanning?",
    message: "Answers are no longer scanned for API keys, tokens and credentials: one that turns up in a reply is shown as it is instead of being redacted. Only the gateway's own secrets are still removed. You can switch the scanning back on here at any time.",
  },
} as const;

async function setProtection(protection: keyof typeof PROTECTION_OFF_QUESTIONS, on: boolean) {
  if (!on) {
    const confirmed = await confirmAction({
      ...PROTECTION_OFF_QUESTIONS[protection],
      confirmLabel: "Turn off",
      cancelLabel: "Keep it on",
      danger: true,
      eyebrow: "Lowers security",
    });
    if (!confirmed) return;
  }
  await updateGuardrails({ [protection]: on });
}

async function resetGuardrails() {
  const confirmed = await confirmAction({
    title: "Reset the guardrails to their defaults?",
    message: "Prompt injection protection, output secret scanning and the maximum input length go back to the defaults from the configuration. The values set here are discarded.",
    confirmLabel: "Reset guardrails",
    danger: true,
  });
  if (!confirmed) return;
  await guardrails.reset();
  if (guardrails.error) toast.error("Couldn't reset the guardrails", shownError(guardrails.error));
  else toast.success("Guardrails reset", "The defaults from the configuration are in effect again.");
}

// ── Dialogs ──────────────────────────────────────────────────────────────────

// A click beside a dialog closes it only while its form is as it was opened: a stray click must
// not throw away what was typed. Escape, ✕ and Cancel always close.
const dialogOpenedAs: Record<string, string> = {};

function rememberDialog(name: string, form: unknown) {
  dialogOpenedAs[name] = JSON.stringify(form);
}

function dialogUntouched(name: string, form: unknown): boolean {
  return dialogOpenedAs[name] === JSON.stringify(form);
}

// Each dialog covers the page: Tab goes round inside the one that is open.
const siteDialogEl = ref<HTMLElement | null>(null);
const sceneDialogEl = ref<HTMLElement | null>(null);
const jobDialogEl = ref<HTMLElement | null>(null);
const channelDialogEl = ref<HTMLElement | null>(null);
for (const dialogEl of [siteDialogEl, sceneDialogEl, jobDialogEl, channelDialogEl]) useFocusTrap(dialogEl);

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

useEscapeToClose(() => siteForm.open, () => { siteForm.open = false; });

function dismissSiteForm() {
  if (dialogUntouched("site", siteForm)) siteForm.open = false;
}

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
  rememberDialog("site", siteForm);
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

  if (sites.error) {
    siteForm.error = shownError(sites.error);
    return;
  }
  siteForm.open = false;
  toast.success(siteForm.editing ? "Site credentials updated" : "Site credentials saved", `The login for ${siteForm.hostname.trim()} is stored.`);
}

async function confirmDeleteSite(hostname: string) {
  const confirmed = await confirmAction({
    title: `Delete the credentials for ${hostname}?`,
    message: "The stored username, password and URLs for this site are removed. This cannot be undone.",
    confirmLabel: "Delete credentials",
    danger: true,
  });
  if (!confirmed) return;
  await sites.remove(hostname);
  if (sites.error) toast.error("Couldn't delete the credentials", shownError(sites.error));
  else toast.success("Credentials deleted", `The login for ${hostname} is no longer stored.`);
}

// ── Scene form ───────────────────────────────────────────────────────────────

const sceneForm = reactive({
  open: false,
  editing: null as string | null,
  name: "", description: "", task: "", webhookKey: "",
  error: "",
});

useEscapeToClose(() => sceneForm.open, () => { sceneForm.open = false; });

function dismissSceneForm() {
  if (dialogUntouched("scene", sceneForm)) sceneForm.open = false;
}

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
  rememberDialog("scene", sceneForm);
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

  if (scenesStore.error) {
    sceneForm.error = shownError(scenesStore.error);
    return;
  }
  sceneForm.open = false;
  toast.success(sceneForm.editing ? "Scene updated" : "Scene created", `"${sceneForm.name.trim()}" is saved and ready to run.`);
}

async function confirmDeleteScene(name: string) {
  const confirmed = await confirmAction({
    title: `Delete the scene "${name}"?`,
    message: "Its task prompt and webhook key are removed. This cannot be undone.",
    confirmLabel: "Delete scene",
    danger: true,
  });
  if (!confirmed) return;
  await scenesStore.remove(name);
  if (scenesStore.error) toast.error("Couldn't delete the scene", shownError(scenesStore.error));
  else toast.success("Scene deleted", `"${name}" is gone from the scene list.`);
}

const jobForm = reactive({
  open: false,
  editing: null as string | null,
  name: "",
  description: "",
  paramsJson: "{}",
  stepsJson: "[]",
  triggersJson: "[]",
  error: "",
});

useEscapeToClose(() => jobForm.open, () => { jobForm.open = false; });

function dismissJobForm() {
  if (dialogUntouched("job", jobForm)) jobForm.open = false;
}

// ── Job dialog: the JSON boxes ───────────────────────────────────────────────
// Params, steps and triggers are typed as JSON. Each box is checked a moment after the last
// keystroke and says what it found on the line beneath it; Save waits while one is broken.

const JOB_JSON_BOXES = [
  {
    key: "params", field: "paramsJson", label: "Params JSON", shape: "object", required: false, rows: 4,
    placeholder: '{"audience":{"default":"ops team"}}',
  },
  {
    key: "steps", field: "stepsJson", label: "Steps JSON", shape: "array", required: true, rows: 8,
    placeholder: '[{"scene":"verified_research_brief","label":"Research"},{"scene":"multi_channel_broadcast","params":{"channels":"slack,email"}}]',
  },
  {
    key: "triggers", field: "triggersJson", label: "Triggers JSON", shape: "array", required: false, rows: 5,
    placeholder: '[{"type":"api","webhookKey":"replace-with-secret"},{"type":"cron","expression":"0 8 * * 1-5","enabled":true},{"type":"channel","channels":["slack"],"pattern":"/ops-brief","mode":"prefix","captureRemainderAs":"topic","parseParams":false,"replyText":"Queued {{jobName}} for {{topic|status}} as {{jobId}}"}]',
  },
] as const;

type JobJsonBox = typeof JOB_JSON_BOXES[number];

interface JsonCheck {
  /** "hint": the text is fine as JSON, but there is something to say about it. */
  state: "ok" | "hint" | "error";
  message: string;
}

/**
 * Where a text stops being JSON: the offset of the first character that cannot stand there, and
 * what could. JSON.parse decides whether the text is valid; it does not say where it is not in
 * every browser, and never as a line and a column.
 */
function locateJsonError(text: string): { offset: number; expected: string } | null {
  let at = 0;
  const fail = (expected: string) => ({ offset: at, expected });
  const skipSpace = () => {
    while (at < text.length && " \t\n\r".includes(text.charAt(at))) at++;
  };
  const isDigit = (ch: string) => ch >= "0" && ch <= "9";
  const skipDigits = () => {
    while (isDigit(text.charAt(at))) at++;
  };

  function readString(): ReturnType<typeof fail> | null {
    at++;
    while (at < text.length) {
      const ch = text.charAt(at);
      if (ch === '"') {
        at++;
        return null;
      }
      if (ch < " ") return fail("the string to close first (a line break inside a string is written \\n)");
      if (ch === "\\") {
        at++;
        const escaped = text.charAt(at);
        if (escaped === "u") {
          for (let digits = 0; digits < 4; digits++) {
            at++;
            if (!/^[0-9a-fA-F]$/.test(text.charAt(at))) return fail("four hex digits after \\u");
          }
        } else if (escaped === "" || !'"\\/bfnrt'.includes(escaped)) {
          return fail("one of \\\" \\\\ \\/ \\b \\f \\n \\r \\t \\u after the backslash");
        }
      }
      at++;
    }
    return fail("a closing double quote");
  }

  function readValue(): ReturnType<typeof fail> | null {
    skipSpace();
    const ch = text.charAt(at);
    if (ch === '"') return readString();
    if (ch === "{" || ch === "[") {
      const close = ch === "{" ? "}" : "]";
      at++;
      skipSpace();
      if (text.charAt(at) === close) {
        at++;
        return null;
      }
      for (;;) {
        if (ch === "{") {
          skipSpace();
          if (text.charAt(at) !== '"') return fail("a property name in double quotes");
          const name = readString();
          if (name) return name;
          skipSpace();
          if (text.charAt(at) !== ":") return fail("“:” after the property name");
          at++;
        }
        const inner = readValue();
        if (inner) return inner;
        skipSpace();
        const next = text.charAt(at);
        at++;
        if (next === close) return null;
        if (next !== ",") {
          at--;
          return fail(`“,” or “${close}”`);
        }
      }
    }
    for (const word of ["true", "false", "null"]) {
      if (ch !== word.charAt(0)) continue;
      for (const letter of word) {
        if (text.charAt(at) !== letter) return fail(`“${word}”`);
        at++;
      }
      return null;
    }
    return readNumber();
  }

  function readNumber(): ReturnType<typeof fail> | null {
    const start = at;
    if (text.charAt(at) === "-") at++;
    if (!isDigit(text.charAt(at))) return fail(at === start ? "a value" : "a digit");
    // A number has no superfluous zero in front: "01" ends after the 0.
    if (text.charAt(at) === "0") at++;
    else skipDigits();
    if (text.charAt(at) === ".") {
      at++;
      if (!isDigit(text.charAt(at))) return fail("a digit after the decimal point");
      skipDigits();
    }
    if (text.charAt(at) === "e" || text.charAt(at) === "E") {
      at++;
      if (text.charAt(at) === "+" || text.charAt(at) === "-") at++;
      if (!isDigit(text.charAt(at))) return fail("a digit in the exponent");
      skipDigits();
    }
    return null;
  }

  const broken = readValue();
  if (broken) return broken;
  skipSpace();
  return at < text.length ? fail("the JSON to end here") : null;
}

function describeJsonError(text: string, error: unknown): string {
  let found: ReturnType<typeof locateJsonError> = null;
  try {
    found = locateJsonError(text);
  } catch {
    // Nested too deeply to walk: the parser's own words will do.
  }
  if (!found) return `Not valid JSON: ${errorText(error)}`;
  const before = text.slice(0, found.offset);
  const line = before.split("\n").length;
  const column = found.offset - before.lastIndexOf("\n");
  const ch = text.charAt(found.offset);
  const got = ch === "" ? "the end of the text" : ch === "\n" ? "a line break" : ch === "\t" ? "a tab" : `“${ch}”`;
  return `Line ${line}, column ${column}: expected ${found.expected}, found ${got}.`;
}

function checkJobJson(box: JobJsonBox, text: string): JsonCheck {
  const what = box.label.replace(" JSON", "");
  if (!text.trim()) {
    return box.required
      ? { state: "hint", message: "Empty. A job needs at least one step." }
      : { state: "ok", message: "Empty: counts as none." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { state: "error", message: describeJsonError(text, error) };
  }
  const fits = box.shape === "array"
    ? Array.isArray(parsed)
    : typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  if (!fits) {
    return { state: "error", message: `Valid JSON, but ${what} must be ${box.shape === "array" ? "an array: [ … ]" : "an object: { … }"}` };
  }
  if (box.required && (parsed as unknown[]).length === 0) {
    return { state: "hint", message: "Valid JSON. A job needs at least one step." };
  }
  return { state: "ok", message: "Valid JSON" };
}

const jobJson = reactive<Record<JobJsonBox["key"], JsonCheck>>({
  params: { state: "ok", message: "" },
  steps: { state: "ok", message: "" },
  triggers: { state: "ok", message: "" },
});

function checkJobJsonNow() {
  for (const box of JOB_JSON_BOXES) jobJson[box.key] = checkJobJson(box, jobForm[box.field]);
}

/** The boxes Save is waiting for, by label. */
const jobJsonBroken = computed(() => JOB_JSON_BOXES.filter((box) => jobJson[box.key].state === "error").map((box) => box.label));

// Looked at once the typing pauses, not on every keystroke: half a word is always invalid.
const JSON_CHECK_DELAY_MS = 300;
let jobJsonTimer: ReturnType<typeof setTimeout> | undefined;

watch(() => [jobForm.paramsJson, jobForm.stepsJson, jobForm.triggersJson], () => {
  clearTimeout(jobJsonTimer);
  jobJsonTimer = setTimeout(checkJobJsonNow, JSON_CHECK_DELAY_MS);
});

function openJobForm(job: JobDetail | null) {
  jobForm.error = "";
  if (job) {
    jobForm.editing = job.name;
    jobForm.name = job.name;
    jobForm.description = job.description;
    jobForm.paramsJson = JSON.stringify(job.params ?? {}, null, 2);
    jobForm.stepsJson = JSON.stringify(job.steps ?? [], null, 2);
    jobForm.triggersJson = JSON.stringify(job.triggers ?? [], null, 2);
  } else {
    jobForm.editing = null;
    jobForm.name = "";
    jobForm.description = "";
    jobForm.paramsJson = "{}";
    jobForm.stepsJson = "[]";
    jobForm.triggersJson = "[]";
  }
  checkJobJsonNow();
  jobForm.open = true;
  rememberDialog("job", jobForm);
}

async function submitJobForm() {
  jobForm.error = "";
  if (!jobForm.name.trim()) { jobForm.error = "Name is required"; return; }
  if (!jobForm.description.trim()) { jobForm.error = "Description is required"; return; }

  // Save can be pressed inside the pause the checker waits for: look now. A broken box is
  // named beside the button, which stays disabled until it is fixed.
  clearTimeout(jobJsonTimer);
  checkJobJsonNow();
  if (jobJsonBroken.value.length > 0) return;

  const steps = JSON.parse(jobForm.stepsJson.trim() || "[]") as JobStepInput[];
  if (steps.length === 0) { jobForm.error = "Steps JSON must be a non-empty array"; return; }
  const allParams = JSON.parse(jobForm.paramsJson.trim() || "{}") as Record<string, { description?: string; default?: string }>;
  const params = Object.keys(allParams).length > 0 ? allParams : undefined;
  const allTriggers = JSON.parse(jobForm.triggersJson.trim() || "[]") as JobTriggerInput[];
  const triggers = allTriggers.length > 0 ? allTriggers : undefined;

  await jobsStore.save(jobForm.name.trim(), {
    description: jobForm.description.trim(),
    params,
    steps,
    triggers,
  });

  if (jobsStore.error) {
    jobForm.error = shownError(jobsStore.error);
    return;
  }
  jobForm.open = false;
  toast.success(jobForm.editing ? "Job updated" : "Job created", `"${jobForm.name.trim()}" is saved with ${steps.length} step${steps.length === 1 ? "" : "s"}.`);
}

async function confirmDeleteJob(name: string) {
  const confirmed = await confirmAction({
    title: `Delete the job "${name}"?`,
    message: "Its steps and triggers are removed, so it no longer runs on a schedule, webhook or channel message. This cannot be undone.",
    confirmLabel: "Delete job",
    danger: true,
  });
  if (!confirmed) return;
  await jobsStore.remove(name);
  if (jobsStore.error) toast.error("Couldn't delete the job", shownError(jobsStore.error));
  else toast.success("Job deleted", `"${name}" is gone from the job list.`);
}

function formatJobPreview(job: JobDetail): string {
  return JSON.stringify({
    params: job.params ?? {},
    steps: job.steps,
    triggers: job.triggers ?? [],
  }, null, 2);
}

function formatJobTriggerSummary(triggers: JobTriggerInput[] | undefined): string {
  if (!triggers?.length) return "";
  const labels = triggers.map((trigger) => trigger.type);
  return labels.join(" + ");
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
  rememberDialog("channel", channelForm.config);

  const detail = await channelsStore.fetchDetails(def.type);
  if (detail) {
    channelForm.details = detail;
    channelForm.config = { ...DEFAULT_CHANNEL_CONFIG, ...detail.config };
    // The saved settings arrive after the dialog opened: they are what "untouched" means.
    rememberDialog("channel", channelForm.config);
  }
  channelForm.loadingDetails = false;
}

async function submitChannelForm() {
  channelForm.error = "";
  await channelsStore.save(channelForm.type, channelForm.config);
  await channelsStore.fetchDeadLetterCount();
  await runtime.fetch();
  if (channelsStore.error) {
    channelForm.error = shownError(channelsStore.error);
    return;
  }
  toast.success(`${channelForm.label} channel saved`, channelForm.config.enabled
    ? "The channel is enabled. Some changes, such as new bot tokens, take effect after the gateway restarts."
    : "The channel is saved and stays off until you enable it.");
  closeChannelForm();
}

function closeChannelForm() {
  channelForm.open = false;
  channelForm.details = null;
  channelForm.loadingDetails = false;
}

useEscapeToClose(() => channelForm.open, closeChannelForm);

function dismissChannelForm() {
  if (dialogUntouched("channel", channelForm.config)) closeChannelForm();
}

function formatRuntimeName(name: string | undefined): string {
  return (name ?? "").replace(/_/g, " ");
}

function formatModelEndpointRole(role: string): string {
  return role
    .replace(/^subagent:/, "sub-agent: ")
    .replace(/:cloudFallback$/, " cloud fallback")
    .replace(/:fallback$/, " fallback")
    .replace(/_/g, " ");
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

function resetConfigAssistantForm() {
  configAssistantForm.request = "";
  configAssistantForm.mode = "enhancement";
  configAssistantForm.targetAgent = "";
}

async function submitConfigAssistantRequest() {
  const request = configAssistantForm.request.trim();
  if (!request) return;
  const proposal = await configAssistant.propose({
    request,
    mode: configAssistantForm.mode,
    targetAgent: configAssistantForm.targetAgent || undefined,
  });
  if (proposal) {
    configAssistantForm.request = "";
    toast.success("Proposal drafted", "Review it under Proposals. Nothing changes until you apply it.");
  }
}

// ── Orchestration Tuning ──────────────────────────────────────────────────
const orchestrationSaving = ref(false);
const orchestrationError = ref("");
const orchestrationDefaults = ref<Record<string, any>>({});

// Default effort tier (seeds new sessions). Saved on change.
const effortDefaultForm = ref<"low" | "medium" | "high" | "max">("medium");
async function reloadEffortConfig() {
  try {
    const { config } = await gateway.getEffortConfig();
    effortDefaultForm.value = config?.default ?? "medium";
  } catch { /* leave at medium */ }
}
async function saveEffortDefaultUI() {
  try {
    await gateway.saveEffortDefault(effortDefaultForm.value);
    toast.success("Default effort saved", `New sessions start at ${effortDefaultForm.value} effort.`);
  } catch (e) {
    orchestrationError.value = `Failed to save default effort: ${e instanceof Error ? e.message : String(e)}`;
  }
}

const orchestrationForm = reactive<{
  maxParallelSlices: number | null;
  subAgentWebSearch: number | null;
  subAgentWebFetch: number | null;
  coordWebSearch: number | null;
  coordWebFetch: number | null;
  coordDelegate: number | null;
  perTurnDelegate: number | null;
  perTurnComputerClick: number | null;
  perTurnComputerType: number | null;
}>({
  maxParallelSlices: null,
  subAgentWebSearch: null,
  subAgentWebFetch: null,
  coordWebSearch: null,
  coordWebFetch: null,
  coordDelegate: null,
  perTurnDelegate: null,
  perTurnComputerClick: null,
  perTurnComputerType: null,
});

function applyOrchestrationConfigToForm(config: any) {
  orchestrationForm.maxParallelSlices = config.maxParallelSlices ?? null;
  orchestrationForm.subAgentWebSearch = config.subAgentToolCaps?.web_search ?? null;
  orchestrationForm.subAgentWebFetch = config.subAgentToolCaps?.web_fetch ?? null;
  orchestrationForm.coordWebSearch = config.coordinatorToolCaps?.web_search ?? null;
  orchestrationForm.coordWebFetch = config.coordinatorToolCaps?.web_fetch ?? null;
  orchestrationForm.coordDelegate = config.coordinatorToolCaps?.delegate_to_agent ?? null;
  orchestrationForm.perTurnDelegate = config.perTurnCaps?.delegate_to_agent ?? null;
  orchestrationForm.perTurnComputerClick = config.perTurnCaps?.computer_click ?? null;
  orchestrationForm.perTurnComputerType = config.perTurnCaps?.computer_type ?? null;
  markSaved("orchestration-tuning");
}

async function reloadOrchestrationConfig() {
  try {
    const { config, defaults } = await gateway.getOrchestrationConfig();
    orchestrationDefaults.value = defaults;
    applyOrchestrationConfigToForm(config);
    orchestrationError.value = "";
  } catch (e) {
    orchestrationError.value = `Failed to load: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function saveOrchestrationConfigUI() {
  orchestrationSaving.value = true;
  orchestrationError.value = "";
  try {
    const payload: any = {
      maxParallelSlices: orchestrationForm.maxParallelSlices ?? 2,
      subAgentToolCaps: {} as Record<string, number>,
      coordinatorToolCaps: {} as Record<string, number>,
      perTurnCaps: {} as Record<string, number>,
    };
    if (orchestrationForm.subAgentWebSearch) payload.subAgentToolCaps.web_search = orchestrationForm.subAgentWebSearch;
    if (orchestrationForm.subAgentWebFetch) payload.subAgentToolCaps.web_fetch = orchestrationForm.subAgentWebFetch;
    if (orchestrationForm.coordWebSearch) payload.coordinatorToolCaps.web_search = orchestrationForm.coordWebSearch;
    if (orchestrationForm.coordWebFetch) payload.coordinatorToolCaps.web_fetch = orchestrationForm.coordWebFetch;
    if (orchestrationForm.coordDelegate) payload.coordinatorToolCaps.delegate_to_agent = orchestrationForm.coordDelegate;
    if (orchestrationForm.perTurnDelegate) payload.perTurnCaps.delegate_to_agent = orchestrationForm.perTurnDelegate;
    if (orchestrationForm.perTurnComputerClick) payload.perTurnCaps.computer_click = orchestrationForm.perTurnComputerClick;
    if (orchestrationForm.perTurnComputerType) payload.perTurnCaps.computer_type = orchestrationForm.perTurnComputerType;
    await gateway.saveOrchestrationConfig(payload);
    markSaved("orchestration-tuning");
    toast.success("Orchestration limits saved", "They apply immediately, without a restart.");
  } catch (e) {
    orchestrationError.value = `Failed to save: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    orchestrationSaving.value = false;
  }
}

// ── Document RAG ───────────────────────────────────────────────────────────
const docRagSaving = ref(false);
const docRagError = ref("");
const docRagForm = reactive<{
  enabled: boolean;
  autoIngestAttachments: boolean;
  injectContext: boolean;
  includeUserDocs: boolean;
  includeWorkspaceDocs: boolean;
  retrievalTopK: number;
  maxContextChars: number;
}>({
  enabled: false,
  autoIngestAttachments: true,
  injectContext: true,
  includeUserDocs: false,
  includeWorkspaceDocs: false,
  retrievalTopK: 6,
  maxContextChars: 6000,
});

async function reloadDocumentRagConfig() {
  try {
    const cfg = await gateway.getDocumentRagConfig();
    docRagForm.enabled = cfg.enabled;
    docRagForm.autoIngestAttachments = cfg.autoIngestAttachments;
    docRagForm.injectContext = cfg.injectContext;
    docRagForm.includeUserDocs = cfg.includeUserDocs;
    docRagForm.includeWorkspaceDocs = cfg.includeWorkspaceDocs;
    docRagForm.retrievalTopK = cfg.retrievalTopK;
    docRagForm.maxContextChars = cfg.maxContextChars;
    docRagError.value = "";
    markSaved("document-rag");
  } catch (e) {
    docRagError.value = `Failed to load: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function saveDocumentRagConfigUI() {
  docRagSaving.value = true;
  docRagError.value = "";
  try {
    await gateway.saveDocumentRagConfig({
      enabled: docRagForm.enabled,
      autoIngestAttachments: docRagForm.autoIngestAttachments,
      injectContext: docRagForm.injectContext,
      includeUserDocs: docRagForm.includeUserDocs,
      includeWorkspaceDocs: docRagForm.includeWorkspaceDocs,
      retrievalTopK: docRagForm.retrievalTopK,
      maxContextChars: docRagForm.maxContextChars,
    });
    markSaved("document-rag");
    toast.success("Document RAG saved", docRagForm.enabled
      ? "Document retrieval is on; the settings apply immediately."
      : "Document retrieval is off.");
  } catch (e) {
    docRagError.value = `Failed to save: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    docRagSaving.value = false;
  }
}

// ── Skill Library & Tool Pipeline ─────────────────────────────────────────
const skillConfigSaving = ref(false);
const skillConfigError = ref("");
const skillForm = reactive<{
  enabled: boolean;
  autoAuthor: boolean;
  autoPromoteToScene: boolean;
  maxInjected: number;
}>({ enabled: true, autoAuthor: true, autoPromoteToScene: true, maxInjected: 3 });
const pipelineForm = reactive<{ enabled: boolean }>({ enabled: false });

async function reloadSkillConfig() {
  try {
    const { skillLibrary, toolPipeline } = await gateway.getSkillLibraryConfig();
    skillForm.enabled = skillLibrary.enabled;
    skillForm.autoAuthor = skillLibrary.autoAuthor;
    skillForm.autoPromoteToScene = skillLibrary.autoPromoteToScene;
    skillForm.maxInjected = skillLibrary.maxInjected;
    pipelineForm.enabled = toolPipeline.enabled;
    skillConfigError.value = "";
    markSaved("skill-library");
  } catch (e) {
    skillConfigError.value = `Failed to load: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function saveSkillConfigUI() {
  skillConfigSaving.value = true;
  skillConfigError.value = "";
  try {
    const current = await gateway.getSkillLibraryConfig();
    await gateway.saveSkillLibraryConfig({
      skillLibrary: {
        ...current.skillLibrary,
        enabled: skillForm.enabled,
        autoAuthor: skillForm.autoAuthor,
        autoPromoteToScene: skillForm.autoPromoteToScene,
        maxInjected: skillForm.maxInjected,
      },
      toolPipeline: {
        ...current.toolPipeline,
        enabled: pipelineForm.enabled,
      },
    });
    markSaved("skill-library");
    toast.success("Skill Library saved", "The skill library and tool pipeline settings apply immediately.");
  } catch (e) {
    skillConfigError.value = `Failed to save: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    skillConfigSaving.value = false;
  }
}

// ── User Model ─────────────────────────────────────────────────────────────
const userModelSaving = ref(false);
const userModelError = ref("");
const userModelRevision = ref(0);
const userModelUpdatedBy = ref("");
const userModelForm = reactive<{
  goals: string;
  expertise: string;
  workingStyle: string;
  communication: string;
  openQuestions: string;
}>({ goals: "", expertise: "", workingStyle: "", communication: "", openQuestions: "" });

function linesToList(value: string): string[] {
  return value.split("\n").map((x) => x.trim()).filter(Boolean);
}

function applyUserModel(p: import("@/stores/gateway").UserModelProfile) {
  userModelForm.goals = p.goals.join("\n");
  userModelForm.expertise = p.expertise.join("\n");
  userModelForm.workingStyle = p.workingStyle.join("\n");
  userModelForm.communication = p.communication.join("\n");
  userModelForm.openQuestions = p.openQuestions.join("\n");
  userModelRevision.value = p.revision;
  userModelUpdatedBy.value = p.updatedBy;
  markSaved("user-model");
}

async function reloadUserModel() {
  try {
    applyUserModel(await gateway.getUserModel());
    userModelError.value = "";
  } catch (e) {
    userModelError.value = `Failed to load: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function saveUserModelUI() {
  userModelSaving.value = true;
  userModelError.value = "";
  try {
    const p = await gateway.saveUserModel({
      goals: linesToList(userModelForm.goals),
      expertise: linesToList(userModelForm.expertise),
      workingStyle: linesToList(userModelForm.workingStyle),
      communication: linesToList(userModelForm.communication),
      openQuestions: linesToList(userModelForm.openQuestions),
      append: false,
    });
    applyUserModel(p);
    toast.success("User model saved", `Stored as revision ${p.revision}.`);
  } catch (e) {
    userModelError.value = `Failed to save: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    userModelSaving.value = false;
  }
}

async function resetUserModelUI() {
  const confirmed = await confirmAction({
    title: "Reset the user model?",
    message: "Everything the assistant has learned about you — goals, expertise, working style, communication preferences and open questions — is erased on the server. This cannot be undone.",
    confirmLabel: "Reset user model",
    danger: true,
  });
  if (!confirmed) return;
  userModelSaving.value = true;
  userModelError.value = "";
  try {
    applyUserModel(await gateway.resetUserModel());
    toast.success("User model reset", "What the assistant had learned about you is erased.");
  } catch (e) {
    userModelError.value = `Failed to reset: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    userModelSaving.value = false;
  }
}

async function reloadConfigAssistant() {
  await Promise.all([
    configAssistant.fetchProposals(),
    configAssistant.fetchFlowMemory(),
  ]);
}

async function applyConfigProposal(id: string) {
  const applied = await configAssistant.applyProposal(id);
  if (applied) toast.success("Proposal applied", applied.summary || "Its changes are applied.");
}

// ── Config assistant: a note with the verdict ────────────────────────────────
// A verdict on a proposal (worked, partly, failed, rejected) may carry a note. The note is
// written in a form that opens under the proposal, in place of its verdict buttons; one form
// is open at a time. Nothing is sent until "Send": Cancel and Escape send nothing.

const PROPOSAL_NOTE_TEXT: Record<ConfigAssistantFeedbackOutcome, { heading: string; question: string }> = {
  success: { heading: "Marking as worked", question: "What worked? This note becomes reusable flow memory." },
  partial: { heading: "Marking as partly worked", question: "What partly worked and what still needs adjustment?" },
  failure: { heading: "Marking as failed", question: "What failed? This note becomes reusable flow memory." },
  rejected: { heading: "Rejecting this proposal", question: "Why are you rejecting this proposal?" },
};

const proposalNote = reactive({
  /** The proposal the form is open under; empty while it is closed. */
  proposalId: "",
  outcome: "success" as ConfigAssistantFeedbackOutcome,
  lesson: "",
  /** Extra notes: a rejection only. */
  notes: "",
});

function openProposalNote(id: string, outcome: ConfigAssistantFeedbackOutcome) {
  proposalNote.proposalId = id;
  proposalNote.outcome = outcome;
  proposalNote.lesson = "";
  proposalNote.notes = "";
  void nextTick(() => document.getElementById("proposal-note-lesson")?.focus());
}

function closeProposalNote() {
  proposalNote.proposalId = "";
  proposalNote.lesson = "";
  proposalNote.notes = "";
}

function cancelProposalNote() {
  const verdict = `${proposalNote.proposalId}:${proposalNote.outcome}`;
  closeProposalNote();
  // The verdict buttons come back in the form's place: return to the one that was pressed.
  void nextTick(() => {
    for (const button of document.querySelectorAll<HTMLElement>("[data-proposal-verdict]")) {
      if (button.dataset.proposalVerdict === verdict) button.focus();
    }
  });
}

function onProposalNoteEscape(event: KeyboardEvent) {
  // Escape that ends an IME composition is not a cancel; nor is one pressed while the note is on its way.
  if (event.isComposing || configAssistant.activeProposalId === proposalNote.proposalId) return;
  // Taken here, so an open dialog's own Escape handling does not act on it as well.
  event.preventDefault();
  cancelProposalNote();
}

async function sendProposalNote() {
  const { proposalId, outcome } = proposalNote;
  if (!proposalId) return;
  const lesson = proposalNote.lesson.trim() || undefined;
  const notes = outcome === "rejected" ? proposalNote.notes.trim() || undefined : undefined;
  const updated = await configAssistant.submitFeedback(proposalId, { outcome, lesson, notes });
  // A refused send keeps the form, and what was typed, for another try; the reason shows above the list.
  if (!updated) return;
  closeProposalNote();
  toast.success(outcome === "rejected" ? "Proposal rejected" : "Feedback recorded", lesson
    ? "Your note is kept as flow memory for later proposals."
    : "The outcome is kept as flow memory for later proposals.");
}

// A reload may drop the proposal the form stands under: the form goes with it.
watch(() => configAssistant.proposals, (proposals) => {
  if (proposalNote.proposalId && !proposals.some((proposal) => proposal.id === proposalNote.proposalId)) closeProposalNote();
});

/** The request form as it starts: nothing to clear. */
const configAssistantFormBlank = computed(() => configAssistantForm.request === ""
  && configAssistantForm.mode === "enhancement"
  && configAssistantForm.targetAgent === "");

function stringifyPreview(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatConfigAssistantScope(scope: FlowMemoryScope): string {
  switch (scope) {
    case "setup": return "Initial setup";
    case "enhancement": return "Enhancement";
    case "prompt": return "Prompt";
    case "workflow": return "Workflow";
    default: return scope;
  }
}

function formatConfigAssistantOutcome(outcome: FlowMemoryOutcome): string {
  switch (outcome) {
    case "proposed": return "Proposed";
    case "applied": return "Applied";
    case "success": return "Worked";
    case "failure": return "Failed";
    case "partial": return "Partial";
    case "rejected": return "Rejected";
    default: return outcome;
  }
}

function proposalBadgeClass(status: string): string {
  if (status === "applied") return "badge-running";
  if (status === "rejected") return "badge-health-bad";
  return "badge-config";
}

function flowBadgeClass(outcome: FlowMemoryOutcome): string {
  if (outcome === "success" || outcome === "applied") return "badge-running";
  if (outcome === "failure" || outcome === "rejected") return "badge-health-bad";
  return "badge-config";
}

// ── Gateway connection: a draft, applied on Reconnect ────────────────────────
// The store keeps the URL and the token in the browser's storage, and every page's requests
// read them from there. Bound straight to the two fields, each keystroke was stored and used
// at once: a half-typed URL broke the app before Reconnect was pressed. The fields edit this
// draft instead, and Reconnect stores it.

const gatewayDraft = reactive({
  wsUrl: gateway.wsUrl ?? "",
  token: gateway.token ?? "",
  error: "",
});

function gatewayDraftDiffers(): boolean {
  return gatewayDraft.wsUrl !== gateway.wsUrl || gatewayDraft.token !== gateway.token;
}

function revertGatewayDraft() {
  gatewayDraft.wsUrl = gateway.wsUrl ?? "";
  gatewayDraft.token = gateway.token ?? "";
  gatewayDraft.error = "";
}

// The stored values also change from outside this card: a refused token is cleared, another
// tab may store new ones. A field the user has not touched follows them.
watch(() => [gateway.wsUrl, gateway.token] as const, ([wsUrl, token], [oldWsUrl, oldToken]) => {
  if (gatewayDraft.wsUrl === oldWsUrl) gatewayDraft.wsUrl = wsUrl;
  if (gatewayDraft.token === oldToken) gatewayDraft.token = token;
});

/** What the store can connect to: a ws(s) URL, or an http(s) one, which it turns into ws(s). */
function isGatewayUrl(value: string): boolean {
  try {
    return ["ws:", "wss:", "http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function applyGatewayConnection() {
  gatewayDraft.error = "";
  if (!gatewayDraftDiffers()) {
    gateway.connect();
    return;
  }
  // Left empty, the URL falls back to the default one. Anything else has to be a URL: the
  // store would replace a mistyped one with the default without a word, or fail to connect.
  const wsUrl = gatewayDraft.wsUrl.trim();
  if (wsUrl && !isGatewayUrl(wsUrl)) {
    gatewayDraft.error = "Enter a WebSocket URL, such as ws://localhost:8765/ws.";
    return;
  }
  gateway.wsUrl = wsUrl;
  gateway.token = gatewayDraft.token;
  // connect() leaves an open socket alone: the one opened with the old values goes first.
  gateway.disconnect();
  gateway.connect();
  // Connecting tidies the URL (http becomes ws, a missing /ws is added): show what is stored.
  revertGatewayDraft();
}

// ── Unsaved changes ──────────────────────────────────────────────────────────
// A card with a Save button edits a form that nothing stores until Save is pressed, and what
// was typed used to vanish without a word on the way out. Each such card is tracked here:
// while its form differs from what was last loaded or saved the card says "Unsaved", its chip
// in the section index carries a dot, and leaving the page asks first.

interface TrackedCard {
  /** True while the card holds something that is not stored. */
  dirty: () => boolean;
  /** Puts the card back to what is stored. */
  revert: () => void;
  /** Takes the form as it stands for the stored one. Cards that keep a snapshot only. */
  markSaved?: () => void;
  /** Takes the given fields for stored and leaves the rest of the snapshot as it is. */
  markFieldsSaved?: (fields: object) => void;
}

/** A form's fields without the listed ones: its own state (loading, error…) is not an edit. */
function fieldsOf<T extends object, K extends keyof T>(form: T, skip: readonly K[]): Omit<T, K> {
  const fields: Partial<T> = { ...form };
  for (const key of skip) delete fields[key];
  return fields as Omit<T, K>;
}

/**
 * Tracks a form against a snapshot of its fields. The snapshot is taken now, and again on
 * every markSaved(): when the card's data loads, after a save, after a revert.
 */
function trackForm<T extends object>(read: () => T, write: (fields: T) => void): TrackedCard {
  // An emptied number box holds "", one that never held a number null: the same to the user.
  const keyOf = (fields: T) => JSON.stringify(fields, (_name, value) => (value === "" ? null : value));
  const first = read();
  const saved = shallowRef({ fields: first, key: keyOf(first) });
  return {
    dirty: () => saved.value.key !== keyOf(read()),
    revert: () => write(saved.value.fields),
    markSaved: () => {
      const fields = read();
      saved.value = { fields, key: keyOf(fields) };
    },
    markFieldsSaved: (stored) => {
      const fields = { ...saved.value.fields, ...stored };
      saved.value = { fields, key: keyOf(fields) };
    },
  };
}

/** By card id (SETTINGS_CARDS). The other cards save on change, or have nothing to save. */
const trackedCards: Record<string, TrackedCard> = {
  "gateway-connection": { dirty: gatewayDraftDiffers, revert: revertGatewayDraft },
  multimodal: trackForm(() => fieldsOf(multimodalForm, ["error"]), resetMultimodalForm),
  personality: trackForm(() => fieldsOf(personalityForm, ["error"]), resetPersonalityForm),
  "orchestration-tuning": trackForm(() => ({ ...orchestrationForm }), (fields) => {
    Object.assign(orchestrationForm, fields);
    orchestrationError.value = "";
  }),
  "skill-library": trackForm(() => ({ ...skillForm, pipelineEnabled: pipelineForm.enabled }), ({ pipelineEnabled, ...skill }) => {
    Object.assign(skillForm, skill);
    pipelineForm.enabled = pipelineEnabled;
  }),
  "document-rag": trackForm(() => ({ ...docRagForm }), (fields) => {
    Object.assign(docRagForm, fields);
  }),
  "user-model": trackForm(() => ({ ...userModelForm }), (fields) => {
    Object.assign(userModelForm, fields);
  }),
  // Nothing here is "saved": a request that was typed and not sent, or a note on a proposal.
  "config-assistant": {
    dirty: () => configAssistantForm.request.trim() !== "" || proposalNote.lesson.trim() !== "" || proposalNote.notes.trim() !== "",
    revert: () => {
      resetConfigAssistantForm();
      closeProposalNote();
    },
  },
  "model-routing": trackForm(
    () => fieldsOf(modelEndpointForm, ["loaded", "loading", "saving", "error", "refusedField", "lastLoaded"]),
    (fields) => {
      Object.assign(modelEndpointForm, fields);
      modelEndpointForm.error = "";
    },
  ),
};

/** A card's form is as the gateway has it: called when its data loads and after each save. */
function markSaved(cardId: string) {
  trackedCards[cardId]?.markSaved?.();
}

/** Some of a card's fields are as the gateway has them; edits to its other fields stay unsaved. */
function markFieldsSaved(cardId: string, fields: object) {
  trackedCards[cardId]?.markFieldsSaved?.(fields);
}

/** The "Revert" buttons: the form goes back to what was loaded; nothing is sent. */
function revertCard(cardId: string) {
  trackedCards[cardId]?.revert();
}

const dirtyCardIds = computed(() => new Set(Object.keys(trackedCards).filter((cardId) => trackedCards[cardId]?.dirty())));

function isCardDirty(cardId: string): boolean {
  return dirtyCardIds.value.has(cardId);
}

// A dialog that is open with something typed into it is unsaved work too. It stands over the
// page, so it gets no chip; the question on the way out names it.
const dialogsWithEdits = computed(() => {
  const names: string[] = [];
  if (siteForm.open && !dialogUntouched("site", siteForm)) names.push("the site credentials dialog");
  if (sceneForm.open && !dialogUntouched("scene", sceneForm)) names.push("the scene dialog");
  if (jobForm.open && !dialogUntouched("job", jobForm)) names.push("the job dialog");
  if (channelForm.open && !dialogUntouched("channel", channelForm.config)) names.push(`the ${channelForm.label} channel dialog`);
  return names;
});

const hasUnsaved = computed(() => dirtyCardIds.value.size > 0 || dialogsWithEdits.value.length > 0);

// Asked before the route changes. /settings and /agents are two routes served by this one
// component instance: going from one to the other leaves a route, so the leave guard asks
// there too (the router hands a reused instance's guards on to the route it now serves). The
// update guard is for a routing table that would serve both paths from one route.
async function confirmLeaving(to: RouteLocationNormalized, from: RouteLocationNormalized): Promise<boolean> {
  // A new hash or query stays on the page: nothing is left behind.
  if (to.path === from.path || !hasUnsaved.value) return true;
  // The cards in page order, then any dialog.
  const names = [
    ...SETTINGS_CARDS.filter((card) => isCardDirty(card.id)).map((card) => card.label),
    ...dialogsWithEdits.value,
  ];
  const subject = listInWords(names);
  return confirmAction({
    title: "Leave without saving?",
    message: `${subject.charAt(0).toUpperCase()}${subject.slice(1)} ${names.length === 1 ? "has" : "have"} unsaved changes. Leaving discards them.`,
    confirmLabel: "Leave",
    cancelLabel: "Stay",
    danger: true,
    eyebrow: "Unsaved changes",
  });
}

onBeforeRouteLeave(confirmLeaving);
onBeforeRouteUpdate(confirmLeaving);

// "Leave" towards the sibling route keeps this instance, and its forms, alive. What was given
// up is put back, so that it does not wait out of sight to be stored by a later Save.
watch(pageMode, () => {
  for (const card of Object.values(trackedCards)) {
    if (card.dirty()) card.revert();
  }
  siteForm.open = false;
  sceneForm.open = false;
  jobForm.open = false;
  if (channelForm.open) closeChannelForm();
});

// Closing or reloading the tab cannot be asked about in the page's own dialog. The browser
// shows its own while this listener is there — so it is there only while something is unsaved.
function warnBeforeUnload(event: BeforeUnloadEvent) {
  event.preventDefault();
  // Older browsers look at this instead of preventDefault().
  event.returnValue = true;
}

watch(hasUnsaved, (unsaved) => {
  if (unsaved) window.addEventListener("beforeunload", warnBeforeUnload);
  else window.removeEventListener("beforeunload", warnBeforeUnload);
}, { immediate: true });

onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", warnBeforeUnload);
  clearTimeout(jobJsonTimer);
});

// When the gateway comes back while the page is open, the page's data loads again. A card
// with unsaved edits is left as the user has it (`keepEdits`): the reload would overwrite them.
function loadRuntimeSettingsData(keepEdits = false) {
  if (!guardrails.state) void guardrails.fetch();
  void sites.fetch();
  void scenesStore.fetch();
  void jobsStore.fetch();
  void channelsStore.fetch();
  void channelsStore.fetchDeadLetterCount();
  void runtime.fetch();
  if (keepEdits && isCardDirty("multimodal")) void multimodalStore.fetchStatus();
  else void reloadMultimodal();
}

function loadDefinitionsData(keepEdits = false) {
  const kept = (cardId: string) => keepEdits && isCardDirty(cardId);
  if (!kept("personality")) void personalityStore.fetch();
  void agentsStore.fetch();
  if (!kept("model-routing")) void fetchModelEndpointConfig();
  void configAssistant.fetchProposals();
  void configAssistant.fetchFlowMemory();
  void runtime.fetch();
  if (!kept("orchestration-tuning")) void reloadOrchestrationConfig();
  void reloadEffortConfig();
  if (!kept("skill-library")) void reloadSkillConfig();
  if (!kept("document-rag")) void reloadDocumentRagConfig();
  if (!kept("user-model")) void reloadUserModel();
}

// ── Auto-load when connected ─────────────────────────────────────────────────

watch([() => gateway.connected, () => pageMode.value], ([connected, mode], previous) => {
  if (!connected) return;
  // The same page as before, so the gateway reconnected: edits in progress are kept.
  const keepEdits = previous?.[1] === mode;
  if (mode === "agents") {
    loadDefinitionsData(keepEdits);
    return;
  }
  loadRuntimeSettingsData(keepEdits);
}, { immediate: true });

watch(() => personalityStore.profile, (profile) => {
  if (profile) syncPersonalityForm(profile);
}, { immediate: true, deep: true });

watch(() => multimodalStore.config, (config, previous) => {
  // Changed in place, there is no earlier config to compare with: everything follows, as on a load.
  if (!previous || previous === config || wholeMultimodalFormFollows > 0) syncMultimodalForm(config);
  else adoptStoredMultimodalFields(config, previous);
}, { deep: true, immediate: true });

// ── Section index, filter, and deep links ────────────────────────────────────
// One list drives the chips under the page header, the anchors other pages link
// to (/agents#document-rag), and the filter. Each route's cards are listed in the
// order they stand in the template: left column first, then right.

interface SettingsCard {
  /** The card's element id. Other pages link to these, so renaming one breaks their links. */
  id: string;
  /** The chip's text. */
  label: string;
  page: "settings" | "agents";
  /** Words a reader may type that the card prints only once the gateway is connected, or never. */
  keywords?: string;
}

const SETTINGS_CARDS: readonly SettingsCard[] = [
  { id: "appearance", label: "Appearance", page: "settings", keywords: "theme palette typeface font color colour preset" },
  { id: "gateway-connection", label: "Gateway Connection", page: "settings", keywords: "websocket url token reconnect disconnect" },
  { id: "status", label: "Status", page: "settings", keywords: "health runtime sync active session" },
  { id: "multimodal", label: "Multimodal", page: "settings", keywords: "upload files vision stt tts speech voice image generation comfyui negative prompt wake word" },
  { id: "about", label: "About", page: "settings", keywords: "version" },
  { id: "guardrails", label: "Guardrails", page: "settings", keywords: "prompt injection secret scanning max input length shell sandbox" },
  { id: "site-credentials", label: "Site Credentials", page: "settings", keywords: "login username password hostname" },
  { id: "scenes", label: "Scenes", page: "settings", keywords: "task prompt" },
  { id: "jobs", label: "Jobs", page: "settings", keywords: "steps triggers schedule" },
  { id: "channels", label: "Channels", page: "settings", keywords: "telegram slack discord whatsapp email signal dead letter delivery" },
  { id: "personality", label: "Personality", page: "agents", keywords: "main ai assistant name identity tone style avoidances quirks growth notes" },
  { id: "model-endpoints", label: "Model Endpoints", page: "agents", keywords: "endpoint health" },
  { id: "orchestration-tuning", label: "Orchestration Tuning", page: "agents", keywords: "default effort parallel research slices caps web_search web_fetch delegate_to_agent computer_click" },
  { id: "skill-library", label: "Skill Library", page: "agents", keywords: "automation autonomous authoring auto-promote scenes tool pipeline run_tool_pipeline" },
  { id: "document-rag", label: "Document RAG", page: "agents", keywords: "retrieval engram auto-ingest attachments inject context excerpts personal workspace library" },
  { id: "user-model", label: "User Model", page: "agents", keywords: "goals expertise working style communication preferences open questions" },
  { id: "config-assistant", label: "Config Assistant", page: "agents", keywords: "proposals flow memory initial setup enhancement prompt improvement" },
  { id: "model-routing", label: "Model Routing", page: "agents", keywords: "orchestrator primary model embeddings reranker guard moderation endpoint override api key" },
  { id: "sub-agents", label: "Sub-Agents", page: "agents", keywords: "routing lab temperature maxtokens top_p top_k min_p repeat_penalty seed thinking mode" },
];

const router = useRouter();
const shellEl = ref<HTMLElement | null>(null);
const gridEl = ref<HTMLElement | null>(null);
const indexEl = ref<HTMLElement | null>(null);
const chipRowEl = ref<HTMLElement | null>(null);
const filterInputEl = ref<HTMLInputElement | null>(null);

const pageCards = computed(() => SETTINGS_CARDS.filter((card) => card.page === pageMode.value));

// The filter. It lasts one visit: nothing about it is stored.
const settingFilter = ref("");
const filterTerms = computed(() => settingFilter.value.toLowerCase().split(/\s+/).filter(Boolean));

// What each card says, read off the page when the query changes rather than once at mount:
// most cards print their labels only after the gateway has connected. Hidden cards stay in
// the page (v-show), so their text is still there to read.
const cardText = ref<Record<string, string>>({});

watch(filterTerms, (terms) => {
  const text: Record<string, string> = {};
  if (terms.length) {
    for (const card of pageCards.value) {
      text[card.id] = (document.getElementById(card.id)?.textContent ?? "").replace(/\s+/g, " ").toLowerCase();
    }
  }
  cardText.value = text;
});

// A card stays when every word of the query is somewhere in its chip label, its keywords,
// or its own text.
const shownCardIds = computed(() => {
  const terms = filterTerms.value;
  const shown = new Set<string>();
  for (const card of pageCards.value) {
    const haystack = `${card.label} ${card.keywords ?? ""} ${cardText.value[card.id] ?? ""}`.toLowerCase();
    if (terms.every((term) => haystack.includes(term))) shown.add(card.id);
  }
  return shown;
});
const noCardShown = computed(() => filterTerms.value.length > 0 && shownCardIds.value.size === 0);

function isCardShown(id: string): boolean {
  return shownCardIds.value.has(id);
}

function clearFilter(refocus = false) {
  settingFilter.value = "";
  // The "Clear" button leaves the page with the line it stands in: hand focus to the box.
  if (refocus) filterInputEl.value?.focus();
}

// A jump names its card as current and keeps it at the top until the reader takes over.
// Two things would otherwise undo it: the scroll watch (the last cards of a page cannot
// rise to the top, so it would name a neighbour), and the cards above the target, which
// grow when the gateway answers a moment after a deep link has landed.
const HOLD_MS = 5000;
let heldCardId = "";
let heldUntil = 0;

function holdCard(id: string) {
  heldCardId = id;
  heldUntil = Date.now() + HOLD_MS;
}

function releaseHold() {
  heldCardId = "";
}

function heldCard(): string {
  return heldCardId && Date.now() < heldUntil ? heldCardId : "";
}

interface CardEdges {
  id: string;
  top: number;
  bottom: number;
}

/**
 * The card a reader is at: the last one whose top has risen into the upper third of what is
 * visible. Before any has (the top of the page), the highest one; at the very end, where the
 * last cards cannot rise that far, the lowest one in view. Side by side, the earlier card wins.
 */
function pickCurrentCard(cards: CardEdges[], viewTop: number, viewBottom: number, atEnd: boolean): string {
  const inView = cards.filter((card) => card.bottom > viewTop && card.top < viewBottom);
  const risen = inView.filter((card) => card.top <= viewTop + (viewBottom - viewTop) / 3);
  const pool = atEnd || !risen.length ? inView : risen;
  const lowest = atEnd || risen.length > 0;
  let pick: CardEdges | undefined;
  for (const card of pool) {
    if (!pick || (lowest ? card.top > pick.top : card.top < pick.top)) pick = card;
  }
  return pick?.id ?? "";
}

const currentCardId = ref("");
// The sticky index's height: the cards' scroll margin and the scroll watch both need it.
const indexHeight = ref(0);

function updateCurrentCard() {
  const shell = shellEl.value;
  if (!shell || heldCard()) return;
  const view = shell.getBoundingClientRect();
  const edges: CardEdges[] = [];
  for (const card of pageCards.value) {
    const el = isCardShown(card.id) ? document.getElementById(card.id) : null;
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    edges.push({ id: card.id, top: rect.top, bottom: rect.bottom });
  }
  const atEnd = shell.scrollTop > 0 && shell.scrollTop + shell.clientHeight >= shell.scrollHeight - 2;
  currentCardId.value = pickCurrentCard(edges, view.top + indexHeight.value, view.bottom, atEnd);
}

// Scroll events come faster than frames: one look per frame is enough.
let spyFrame = 0;

function scheduleSpy() {
  if (spyFrame) return;
  spyFrame = requestAnimationFrame(() => {
    spyFrame = 0;
    updateCurrentCard();
  });
}

function jumpToCard(id: string, smooth: boolean) {
  const card = document.getElementById(id);
  if (!card) return;
  currentCardId.value = id;
  holdCard(id);
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  card.scrollIntoView({ behavior: smooth && !reducedMotion ? "smooth" : "auto", block: "start" });
  // preventScroll: taking focus must not cut the smooth scroll short.
  card.querySelector<HTMLElement>(".section-title")?.focus({ preventScroll: true });
}

// The hash a chip has just written, so the watcher below does not jump a second time.
let hashFromChip = "";

function goToCard(id: string) {
  // The chip of a card the filter hides: the reader asked for that card, so the filter goes.
  if (!isCardShown(id)) settingFilter.value = "";
  void nextTick(() => {
    jumpToCard(id, true);
    const hash = `#${id}`;
    if (route.hash === hash) return;
    hashFromChip = hash;
    void router.replace({ path: route.path, query: route.query, hash }).then((failure) => {
      if (failure) hashFromChip = "";
    });
  });
}

/** Follows the URL's hash to its card. A hash that names no card of this route is left alone. */
async function followHash(smooth: boolean) {
  const id = route.hash.slice(1);
  if (!pageCards.value.some((card) => card.id === id)) return;
  if (!isCardShown(id)) settingFilter.value = "";
  // A route just entered has not put its cards in the page yet.
  await nextTick();
  jumpToCard(id, smooth);
}

watch([() => route.path, () => route.hash], ([path, hash], [previousPath]) => {
  const sameRoute = path === previousPath;
  // /settings and /agents share this component: the other route's cards are a new visit.
  if (!sameRoute) {
    settingFilter.value = "";
    releaseHold();
  }
  const ownHash = hash !== "" && hash === hashFromChip;
  hashFromChip = "";
  if (ownHash) return;
  void followHash(sameRoute).then(scheduleSpy);
});

// The filter changes which cards there are to be at, and where they are: typed from far
// down the page, the shorter list would show its end. Bring its start up under the index.
watch(shownCardIds, async () => {
  await nextTick();
  const shell = shellEl.value;
  const grid = gridEl.value;
  if (shell && grid && filterTerms.value.length) {
    const above = grid.getBoundingClientRect().top - (shell.getBoundingClientRect().top + indexHeight.value + 12);
    if (above < 0) shell.scrollTop += above;
  }
  scheduleSpy();
});

// On a narrow screen the chips are one row that scrolls sideways: keep the current one in sight.
watch(currentCardId, async () => {
  await nextTick();
  const row = chipRowEl.value;
  const chip = row?.querySelector<HTMLElement>('[aria-current="true"]');
  if (!row || !chip || row.scrollWidth <= row.clientWidth) return;
  const left = chip.offsetLeft;
  const right = left + chip.offsetWidth;
  if (left < row.scrollLeft) row.scrollLeft = left - 8;
  else if (right > row.scrollLeft + row.clientWidth) row.scrollLeft = right - row.clientWidth + 8;
});

// Runs when the index or the grid changes size: the chips wrapped, a card grew, the window
// was resized.
function onLayoutChange() {
  indexHeight.value = indexEl.value?.offsetHeight ?? 0;
  const held = heldCard();
  if (held) document.getElementById(held)?.scrollIntoView({ block: "start" });
  else scheduleSpy();
}

let layoutObserver: ResizeObserver | null = null;

onMounted(() => {
  if (typeof ResizeObserver !== "undefined") {
    layoutObserver = new ResizeObserver(onLayoutChange);
    if (indexEl.value) layoutObserver.observe(indexEl.value);
    if (gridEl.value) layoutObserver.observe(gridEl.value);
  }
  onLayoutChange();
  void followHash(false);
});

// The scroll and input listeners are bound in the template and go with the shell; these two
// are not.
onBeforeUnmount(() => {
  layoutObserver?.disconnect();
  if (spyFrame) cancelAnimationFrame(spyFrame);
});
</script>

<style scoped>
.settings-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.25rem;
  max-width: 1400px;
  margin: 0 auto;
}

/* While a filter is on, the two column wrappers step aside and the cards that are left flow
   two to a row: a lone match would otherwise sit beside an empty column. */
.settings-grid--filtered { align-items: start; }
.settings-grid--filtered > div { display: contents; }
/* The wrappers space their cards with a top margin; the grid's gap does that here. */
.settings-grid.settings-grid--filtered .settings-card { margin-top: 0; }

/* A jump leaves the card's title clear of the sticky index, whose height the script measures. */
.settings-card {
  /* the index's height, the gap it keeps above itself while stuck, and a little air */
  scroll-margin-top: calc(var(--settings-index-h, 3.25rem) + 1.75rem);
}

/* ── Section index ─────────────────────────────────────────────────────────
   Stays at the top of the shell while the cards scroll beneath it. */
.settings-index {
  position: sticky;
  top: 0;
  /* Over the cards (their glass gives each a stacking context), under the modals (z-50). */
  z-index: 20;
  display: flex;
  align-items: flex-start;
  gap: 0.5rem 0.75rem;
  max-width: 1400px;
  margin: 0 auto 1.25rem;
  padding: 0.5rem;
  border: 1px solid var(--hairline);
  border-radius: 0.3rem;
  /* The raised-surface tint is see-through by itself: the page colour under it keeps the
     cards that pass beneath from showing. */
  background: linear-gradient(var(--surface-2), var(--surface-2)), rgb(var(--app-bg));
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.35);
}

.settings-index__find {
  flex: 0 0 13rem;
}

.settings-index__input {
  height: 2rem;
  padding-top: 0;
  padding-bottom: 0;
  border-radius: 0.25rem;
}

.settings-index__chips {
  /* Chips measure their offset against the row when it scrolls sideways. */
  position: relative;
  display: flex;
  flex: 1 1 0;
  flex-wrap: wrap;
  gap: 0.35rem;
  min-width: 0;
}

.settings-index__chip {
  display: inline-flex;
  align-items: center;
  min-height: 2rem;
  padding: 0 0.7rem;
  border: 1px solid var(--hairline);
  border-radius: 0.25rem;
  font-family: var(--font-label);
  font-size: 0.68rem;
  font-weight: 600;
  letter-spacing: 0.13em;
  text-transform: uppercase;
  white-space: nowrap;
  color: rgba(165, 243, 252, 0.72);
  transition: color 160ms ease, border-color 160ms ease, background-color 160ms ease, opacity 160ms ease;
}

.settings-index__chip:hover {
  color: rgb(var(--logo-cyan));
  border-color: rgba(var(--accent-purple), 0.3);
  background-color: rgba(var(--accent-purple), 0.08);
}

.settings-index__chip:focus-visible {
  outline: 2px solid rgba(var(--logo-cyan), 0.7);
  outline-offset: 2px;
}

.settings-index__chip[aria-current="true"] {
  color: rgb(var(--logo-cyan));
  border-color: rgba(var(--logo-cyan), 0.45);
  box-shadow: inset 0 -2px 0 rgba(var(--logo-cyan), 0.8);
  text-shadow: 0 0 14px rgba(var(--logo-cyan), 0.45);
}

/* The chip of a card the filter hides. */
.settings-index__chip--dim {
  opacity: 0.35;
}

/* On the chip of a card with unsaved changes. */
.settings-index__dot {
  flex: none;
  width: 6px;
  height: 6px;
  margin-left: 0.45rem;
  border-radius: 9999px;
  background: #fbbf24;
  box-shadow: 0 0 8px rgba(251, 191, 36, 0.7);
}

/* "Unsaved", in the header of a card whose form differs from what is stored. */
.unsaved-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.25rem 0.55rem;
  border: 1px solid rgba(251, 191, 36, 0.4);
  border-radius: 0.25rem;
  background: rgba(251, 191, 36, 0.08);
  font-family: var(--font-label);
  font-size: 0.62rem;
  font-weight: 600;
  line-height: 1.1;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  white-space: nowrap;
  color: #fcd34d;
}

.unsaved-chip::before {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 9999px;
  background: #fbbf24;
  box-shadow: 0 0 8px rgba(251, 191, 36, 0.7);
}

/* "Applies immediately", on a card or a field that saves the moment it is changed. */
.applies-now {
  white-space: nowrap;
  color: rgba(var(--logo-cyan), 0.85);
  cursor: help;
}

.settings-no-match {
  max-width: 1400px;
  margin: 0 auto;
}

/* Where the cards stand in one column there is no width to wrap ten chips in: they become
   one row that scrolls sideways, and the script keeps the current chip in sight. */
@media (max-width: 900px) {
  .settings-index__chips {
    flex-wrap: nowrap;
    overflow-x: auto;
    /* Room for a chip's focus ring, which the scroll box would otherwise clip. */
    margin: -3px;
    padding: 3px;
    scrollbar-width: thin;
  }
}

/* A phone: the filter box takes the first row, the chips the second. */
@media (max-width: 639px) {
  .settings-index {
    flex-direction: column;
    align-items: stretch;
  }

  .settings-index__find,
  .settings-index__chips {
    flex: none;
  }
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

.config-assistant-intro {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.85rem 1rem;
  border-radius: 1rem;
  border: 1px solid rgba(6, 182, 212, 0.12);
  background: linear-gradient(135deg, rgba(8, 11, 24, 0.9), rgba(10, 32, 45, 0.55));
}

.config-assistant-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.75rem;
}

.config-assistant-textarea {
  min-height: 7.5rem;
  resize: vertical;
}

.flow-memory-card {
  padding: 0.85rem 1rem;
  border-radius: 1rem;
  border: 1px solid rgba(56, 189, 248, 0.14);
  background: rgba(2, 6, 23, 0.55);
}

.config-proposal-card {
  padding: 0.9rem 1rem;
  border-radius: 1.1rem;
  border: 1px solid rgba(168, 85, 247, 0.16);
  background: rgba(8, 11, 24, 0.42);
}

.config-proposal-summary {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  cursor: pointer;
  list-style: none;
}

.config-proposal-summary::-webkit-details-marker {
  display: none;
}

.config-proposal-list {
  margin: 0;
  padding-left: 1rem;
  color: rgb(148 163 184);
  font-size: 0.75rem;
  line-height: 1.5;
}

.config-change-card {
  padding: 0.8rem 0.9rem;
  border-radius: 0.95rem;
  border: 1px solid rgba(34, 211, 238, 0.12);
  background: rgba(2, 6, 23, 0.5);
}

.config-change-preview {
  margin-top: 0.6rem;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.72rem;
  line-height: 1.45;
  color: rgb(226 232 240);
  background: rgba(15, 23, 42, 0.72);
  border: 1px solid rgba(148, 163, 184, 0.14);
  border-radius: 0.85rem;
  padding: 0.7rem 0.8rem;
}

@media (max-width: 900px) {
  .settings-grid { grid-template-columns: 1fr; }

  .routing-lab-controls {
    grid-template-columns: 1fr;
  }

  .config-assistant-grid {
    grid-template-columns: 1fr;
  }

  .config-assistant-intro {
    align-items: flex-start;
    flex-direction: column;
  }
}

.section-title {
  @apply font-semibold text-gray-100 mb-4 text-sm uppercase tracking-wide;
  font-family: var(--font-label);
  background: linear-gradient(to right, rgb(var(--accent-purple)), rgb(var(--accent-pink)));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

/* A jump from the index moves focus to the card's heading: show that to keyboard users only. */
.section-title:focus {
  outline: none;
}

.section-title:focus-visible {
  outline: 2px solid rgba(var(--logo-cyan), 0.7);
  outline-offset: 4px;
}

.field-label {
  @apply block text-xs text-gray-400 mb-1.5 font-medium;
}

/* The label of a switch: as wide as its text, so a click beside it does not flip the switch. */
.field-label--switch {
  display: inline-block;
  cursor: pointer;
}

/* The * after the label of a field that has to be filled in. */
.field-required {
  color: #f87171;
}

/* A JSON box in the job dialog, and the line under it that says what the check found. */
.json-box {
  min-height: 4rem;
  resize: vertical;
}

.json-status {
  margin-top: 0.35rem;
  font-size: 0.72rem;
  line-height: 1.4;
  color: rgb(110, 231, 183);
}

.json-status--hint {
  color: rgb(156, 163, 175);
}

.json-status--error {
  color: rgb(252, 165, 165);
}

/* The note that goes with a verdict on a proposal. */
.proposal-note {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 0.85rem 1rem;
  border-radius: 0.95rem;
  border: 1px solid rgba(var(--logo-cyan), 0.22);
  background: rgba(2, 6, 23, 0.5);
}

.proposal-note__box {
  resize: vertical;
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
