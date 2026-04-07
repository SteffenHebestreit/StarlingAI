<template>
  <div class="sessions-page" style="height: calc(100vh - 57px); overflow-y: auto">
    <div class="sessions-page__header">
      <div>
        <h2 class="sessions-page__title">Sessions</h2>
        <p class="sessions-page__subtitle">Resume active conversations, inspect archived missions, and prune stored history.</p>
      </div>
      <div class="sessions-page__actions">
        <button @click="clearArchivedSessions" class="sessions-page__clear" title="Remove all archived session history">Clear archived</button>
        <button @click="refresh" class="sessions-page__refresh">Refresh</button>
      </div>
    </div>

    <div class="sessions-filters">
      <input
        v-model="searchQuery"
        type="search"
        class="sessions-filters__search"
        placeholder="Search sessions or mission objectives"
      >
      <select v-model="statusFilter" class="sessions-filters__select">
        <option value="all">All sessions</option>
        <option value="active">Active only</option>
        <option value="archived">Archived only</option>
        <option value="has-runs">With swarm history</option>
        <option value="ok">Latest run ok</option>
        <option value="blocked">Latest run blocked</option>
        <option value="error">Latest run error</option>
      </select>
    </div>

    <div class="sessions-layout">
      <section class="sessions-list">
        <div v-if="!filteredSessionCards.length" class="sessions-list__empty">
          No sessions match the current filters.
        </div>

        <div
          v-for="session in filteredSessionCards"
          :key="session.id"
          :class="['session-card', selectedSessionId === session.id && 'session-card--active']"
          @click="selectSession(session.id)"
        >
          <div class="session-card__top">
            <span class="session-card__id">{{ session.id.substring(0, 12) }}…</span>
            <div class="session-card__top-right">
              <span :class="['session-card__badge', session.isActive ? 'session-card__badge--active' : 'session-card__badge--archived']">
                {{ session.isActive ? 'Active' : 'Archived' }}
              </span>
              <button
                v-if="session.isActive"
                class="session-card__action"
                title="Continue this session in chat"
                @click.stop="continueSession(session.id)"
              >Continue</button>
              <button
                v-if="session.isActive"
                class="session-card__action session-card__action--secondary"
                title="Archive this session"
                @click.stop="archive(session.id)"
              >Archive</button>
              <button
                class="session-card__delete"
                :title="session.isActive ? 'Delete this session' : 'Remove session history'"
                @click.stop="removeSession(session.id)"
              >✕</button>
            </div>
          </div>
          <div class="session-card__meta">
            <span v-if="session.channel">{{ session.channel }}</span>
            <span v-if="session.createdAt">Created {{ formatDate(session.createdAt) }}</span>
            <span v-if="session.turns !== null">{{ session.turns }} turns</span>
          </div>
          <div v-if="session.runCount > 0" class="session-card__history">
            <span :class="['session-card__status', `session-card__status--${session.lastStatus}`]">{{ session.lastStatus }}</span>
            <span>{{ session.runCount }} swarm run{{ session.runCount === 1 ? '' : 's' }}</span>
            <span>{{ session.lastRecordedAt ? formatDate(session.lastRecordedAt) : 'unknown' }}</span>
          </div>
          <div v-if="session.preview" class="session-card__preview">{{ session.preview }}</div>
          <div v-else-if="session.lastObjective" class="session-card__objective">{{ session.lastObjective }}</div>
        </div>
      </section>

      <section class="sessions-preview">
        <div v-if="selectedSessionId" class="sessions-preview__stack">
          <SwarmStatusPanel
            v-if="selectedRun"
            :state="selectedRun.state"
            :runs="selectedRuns"
            :selected-run-id="selectedRunId"
            @select-run="selectRun"
          />
          <div v-else class="sessions-preview__empty">
            This session has no recorded swarm runs. Transcript history is still available below.
          </div>

          <section class="transcript-panel">
            <div class="transcript-panel__header">
              <div>
                <h3 class="transcript-panel__title">Transcript</h3>
                <p v-if="selectedTranscript?.session" class="transcript-panel__meta">
                  {{ selectedTranscript.session.messageCount }} messages
                  <span v-if="selectedTranscript.session.lastMessageAt"> · Last activity {{ formatDate(selectedTranscript.session.lastMessageAt) }}</span>
                </p>
              </div>
              <div v-if="selectedTranscript?.session" class="transcript-panel__header-actions">
                <span :class="['transcript-panel__badge', selectedTranscript.session.archivedAt ? 'transcript-panel__badge--archived' : 'transcript-panel__badge--active']">
                  {{ selectedTranscript.session.archivedAt ? 'Archived transcript' : 'Active transcript' }}
                </span>
                <button class="transcript-panel__action" @click="exportTranscriptMarkdown">Export Markdown</button>
                <button class="transcript-panel__action" @click="exportDebugMarkdown">Debug Markdown</button>
                <button class="transcript-panel__action" @click="exportTranscriptPDF">Export PDF</button>
              </div>
            </div>

            <div v-if="transcriptLoading" class="sessions-preview__empty">
              Loading transcript…
            </div>
            <div v-else-if="transcriptError" class="transcript-panel__error">
              {{ transcriptError }}
            </div>
            <div v-else-if="!selectedTranscript?.transcript.length" class="sessions-preview__empty">
              No transcript messages recorded for this session.
            </div>
            <div v-else>
              <div v-if="hiddenTranscriptCount > 0" class="transcript-panel__controls">
                <button class="transcript-panel__action" @click="showOlderTranscriptMessages">
                  Load {{ Math.min(hiddenTranscriptCount, transcriptPageSize) }} older message{{ Math.min(hiddenTranscriptCount, transcriptPageSize) === 1 ? '' : 's' }}
                </button>
                <span class="transcript-panel__meta">Showing {{ visibleTranscriptMessages.length }} of {{ selectedTranscript.transcript.length }} messages</span>
              </div>
              <div class="transcript-panel__messages">
              <article
                v-for="message in visibleTranscriptMessages"
                :key="message.id"
                :class="['transcript-message', `transcript-message--${message.role}`]"
              >
                <div class="transcript-message__top">
                  <span :class="['transcript-message__role', `transcript-message__role--${message.role}`]">{{ message.role }}</span>
                  <span class="transcript-message__time">{{ formatDate(message.timestamp) }}</span>
                </div>
                <p class="transcript-message__content">{{ message.content || 'No text content' }}</p>

                <div v-if="message.toolCalls?.length" class="transcript-message__tools">
                  <div
                    v-for="toolCall in message.toolCalls"
                    :key="`${message.id}:${toolCall.name}`"
                    class="transcript-tool"
                  >
                    <div class="transcript-tool__name">{{ toolCall.name }}</div>
                    <pre class="transcript-tool__args">{{ formatToolArgs(toolCall.args) }}</pre>
                    <pre v-if="toolCall.result" class="transcript-tool__result">{{ toolCall.result }}</pre>
                  </div>
                </div>
              </article>
              </div>
            </div>
          </section>
        </div>
        <div v-else class="sessions-preview__empty">
          Select a session to inspect its swarm history and transcript.
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { marked } from "marked";
import { useRoute, useRouter } from "vue-router";
import SwarmStatusPanel from "@/components/SwarmStatusPanel.vue";
import { sanitizeAssistantMessageContent, useGatewayStore, type GatewaySessionTranscript, type GatewaySessionTranscriptMessage, type SwarmRunRecord } from "@/stores/gateway";

interface SessionCard {
  id: string;
  channel: string | null;
  createdAt: string | null;
  turns: number | null;
  preview: string | null;
  isActive: boolean;
  runCount: number;
  lastStatus: SwarmRunRecord["status"] | null;
  lastRecordedAt: string | null;
  lastObjective: string | null;
}

type TranscriptToolCall = NonNullable<GatewaySessionTranscriptMessage["toolCalls"]>[number];

const gateway = useGatewayStore();
const route = useRoute();
const router = useRouter();
const selectedSessionId = ref<string | null>(null);
const selectedRunId = ref<string | null>(null);
const searchQuery = ref("");
const statusFilter = ref<"all" | "active" | "archived" | "has-runs" | "ok" | "blocked" | "error">("all");
const selectedTranscript = ref<GatewaySessionTranscript | null>(null);
const transcriptLoading = ref(false);
const transcriptError = ref<string | null>(null);
const transcriptPageSize = 100;
const transcriptExporting = ref(false);
let transcriptRequestId = 0;

const visibleTranscriptMessages = computed(() => selectedTranscript.value?.transcript ?? []);

function sanitizeTranscriptMessage(message: GatewaySessionTranscriptMessage): GatewaySessionTranscriptMessage {
  if (message.role !== "assistant") return message;
  return {
    ...message,
    content: sanitizeAssistantMessageContent(message.content, message.toolCalls),
  };
}

const hiddenTranscriptCount = computed(() => {
  const totalMessages = selectedTranscript.value?.totalMessages ?? 0;
  return Math.max(0, totalMessages - visibleTranscriptMessages.value.length);
});

const sessionCards = computed<SessionCard[]>(() => {
  const sessions = gateway.sessions;
  const activeById = new Map(sessions.map((session) => [session.id, session]));
  const ids = new Set<string>([
    ...sessions.map((session) => session.id),
    ...gateway.swarmSessionHistory.map((entry) => entry.sessionId),
  ]);

  return Array.from(ids).map((id) => {
    const activeSession = activeById.get(id);
    const history = gateway.swarmSessionHistory.find((entry) => entry.sessionId === id);
    return {
      id,
      channel: activeSession?.channel ?? null,
      createdAt: activeSession?.createdAt ?? null,
      turns: activeSession?.turns ?? null,
      preview: activeSession?.preview ?? null,
      isActive: Boolean(activeSession && !activeSession.archivedAt),
      runCount: history?.runCount ?? 0,
      lastStatus: history?.lastStatus ?? null,
      lastRecordedAt: history?.lastRecordedAt ?? null,
      lastObjective: history?.lastObjective ?? null,
    };
  }).sort((left, right) => {
    const leftTs = left.lastRecordedAt ?? left.createdAt ?? "";
    const rightTs = right.lastRecordedAt ?? right.createdAt ?? "";
    return rightTs.localeCompare(leftTs);
  });
});

const filteredSessionCards = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();

  return sessionCards.value.filter((session) => {
    if (statusFilter.value === "active" && !session.isActive) return false;
    if (statusFilter.value === "archived" && session.isActive) return false;
    if (statusFilter.value === "has-runs" && session.runCount === 0) return false;
    if (["ok", "blocked", "error"].includes(statusFilter.value) && session.lastStatus !== statusFilter.value) return false;

    if (!query) return true;

    return [
      session.id,
      session.channel ?? "",
      session.preview ?? "",
      session.lastObjective ?? "",
      session.lastStatus ?? "",
    ].some((value) => value.toLowerCase().includes(query));
  });
});

const selectedRuns = computed(() => gateway.getSwarmRuns(selectedSessionId.value));
const selectedRun = computed(() => {
  if (!selectedRuns.value.length) return null;
  if (selectedRunId.value) {
    const matched = selectedRuns.value.find((run) => run.id === selectedRunId.value);
    if (matched) return matched;
  }
  return selectedRuns.value[selectedRuns.value.length - 1] ?? null;
});

function ensureSelection() {
  const routedSessionId = typeof route.query.sessionId === "string" ? route.query.sessionId : null;
  const routedRunId = typeof route.query.runId === "string" ? route.query.runId : null;

  if (routedSessionId && sessionCards.value.some((session) => session.id === routedSessionId)) {
    selectedSessionId.value = routedSessionId;
    const routedRuns = gateway.getSwarmRuns(routedSessionId);
    if (routedRunId && routedRuns.some((run) => run.id === routedRunId)) {
      selectedRunId.value = routedRunId;
      return;
    }
    selectedRunId.value = routedRuns[routedRuns.length - 1]?.id ?? null;
    return;
  }

  if (selectedSessionId.value && filteredSessionCards.value.some((session) => session.id === selectedSessionId.value)) {
    const runs = gateway.getSwarmRuns(selectedSessionId.value);
    if (runs.length > 0 && !runs.some((run) => run.id === selectedRunId.value)) {
      selectedRunId.value = runs[runs.length - 1]?.id ?? null;
    }
    return;
  }

  const preferred = gateway.currentSessionId && filteredSessionCards.value.some((session) => session.id === gateway.currentSessionId)
    ? gateway.currentSessionId
    : filteredSessionCards.value.find((session) => session.runCount > 0)?.id ?? filteredSessionCards.value[0]?.id ?? null;

  selectedSessionId.value = preferred;
  const runs = gateway.getSwarmRuns(preferred);
  selectedRunId.value = runs[runs.length - 1]?.id ?? null;
}

async function refresh() {
  await gateway.refreshSessions();
  ensureSelection();
}

async function loadTranscript(sessionId: string | null, options: { beforeMessageId?: string; appendOlder?: boolean } = {}) {
  transcriptRequestId += 1;
  const requestId = transcriptRequestId;

  if (!sessionId) {
    selectedTranscript.value = null;
    transcriptError.value = null;
    transcriptLoading.value = false;
    return;
  }

  transcriptLoading.value = true;
  transcriptError.value = null;

  try {
    const transcript = await gateway.getSessionTranscript(sessionId, {
      limit: transcriptPageSize,
      beforeMessageId: options.beforeMessageId,
    });
    if (requestId !== transcriptRequestId) return;
    const sanitizedTranscript: GatewaySessionTranscript = {
      ...transcript,
      transcript: transcript.transcript.map(sanitizeTranscriptMessage),
    };
    selectedTranscript.value = options.appendOlder && selectedTranscript.value?.session.id === transcript.session.id
      ? {
          ...sanitizedTranscript,
          transcript: [...sanitizedTranscript.transcript, ...selectedTranscript.value.transcript],
        }
      : sanitizedTranscript;
  } catch (error) {
    if (requestId !== transcriptRequestId) return;
    selectedTranscript.value = null;
    transcriptError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (requestId === transcriptRequestId) {
      transcriptLoading.value = false;
    }
  }
}

function showOlderTranscriptMessages() {
  if (!selectedSessionId.value || !selectedTranscript.value?.nextBeforeMessageId) return;
  void loadTranscript(selectedSessionId.value, {
    beforeMessageId: selectedTranscript.value.nextBeforeMessageId,
    appendOlder: true,
  });
}

async function continueSession(sessionId: string) {
  await gateway.switchSession(sessionId);
  await router.push({ path: "/" });
}

async function archive(sessionId: string) {
  await gateway.archiveSession(sessionId);
  await gateway.refreshSessions();
  if (selectedSessionId.value === sessionId) {
    selectedSessionId.value = null;
    selectedRunId.value = null;
  }
  ensureSelection();
}

async function removeSession(sessionId: string) {
  await gateway.deleteSession(sessionId);
  if (selectedSessionId.value === sessionId) {
    selectedSessionId.value = null;
    selectedRunId.value = null;
  }
  ensureSelection();
}

async function clearArchivedSessions() {
  const archived = gateway.archivedSessions;
  for (const s of archived) {
    await gateway.deleteSession(s.id);
  }
  ensureSelection();
}

function selectSession(id: string) {
  selectedSessionId.value = id;
  const runs = gateway.getSwarmRuns(id);
  selectedRunId.value = runs[runs.length - 1]?.id ?? null;
}

function selectRun(runId: string) {
  selectedRunId.value = runId;
}

function syncRouteSelection() {
  const nextSessionId = selectedSessionId.value ?? undefined;
  const nextRunId = selectedRunId.value ?? undefined;
  const currentSessionId = typeof route.query.sessionId === "string" ? route.query.sessionId : undefined;
  const currentRunId = typeof route.query.runId === "string" ? route.query.runId : undefined;

  if (currentSessionId === nextSessionId && currentRunId === nextRunId) return;

  const nextQuery: Record<string, string | string[] | null | undefined> = { ...route.query as Record<string, string> };
  if (nextSessionId) nextQuery.sessionId = nextSessionId;
  else delete nextQuery.sessionId;
  if (nextRunId) nextQuery.runId = nextRunId;
  else delete nextQuery.runId;

  router.replace({
    path: "/sessions",
    query: nextQuery,
  });
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "unknown";
  return parsed.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatToolArgs(args: TranscriptToolCall["args"]): string {
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

function transcriptRoleLabel(role: GatewaySessionTranscriptMessage["role"]): string {
  if (role === "user") return "You";
  if (role === "assistant") return "StarlingAI";
  return "System";
}

function buildTranscriptMarkdownExport(transcriptPage: GatewaySessionTranscript): string {
  const session = transcriptPage.session;
  const lines = [
    `# StarlingAI Session Transcript`,
    ``,
    `- Session: ${session.id}`,
    `- Channel: ${session.channel}`,
    `- Created: ${new Date(session.createdAt).toLocaleString()}`,
    `- Updated: ${new Date(session.updatedAt).toLocaleString()}`,
    `- Status: ${session.archivedAt ? "Archived" : "Active"}`,
    `- Messages: ${session.messageCount}`,
    ``,
    `---`,
    ``,
  ];

  for (const message of transcriptPage.transcript) {
    const role = transcriptRoleLabel(message.role);
    const time = new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    lines.push(`### ${role} - ${time}`);
    lines.push("");
    lines.push(message.content || "(no text content)");
    lines.push("");

    if (message.toolCalls?.length) {
      lines.push(`#### Tool Calls`);
      lines.push("");
      for (const toolCall of message.toolCalls) {
        lines.push(`- ${toolCall.name}`);
        lines.push("");
        lines.push("```json");
        lines.push(formatToolArgs(toolCall.args));
        lines.push("```");
        if (toolCall.result) {
          lines.push("");
          lines.push("```text");
          lines.push(toolCall.result);
          lines.push("```");
        }
        lines.push("");
      }
    }

    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

async function exportTranscriptMarkdown(): Promise<void> {
  const transcript = await getTranscriptForExport();
  if (!transcript) return;
  const content = buildTranscriptMarkdownExport(transcript);

  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `starlingai-session-${transcript.session.id.slice(0, 8)}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

async function exportDebugMarkdown(): Promise<void> {
  const transcript = await getTranscriptForExport();
  if (!transcript) return;
  await gateway.downloadSessionDebugMarkdown(transcript.session.id);
}

async function exportTranscriptPDF(): Promise<void> {
  const transcriptPage = await getTranscriptForExport();
  if (!transcriptPage) return;

  const session = transcriptPage.session;
  const exportedAt = new Date().toLocaleString();
  const messageHtml = transcriptPage.transcript.map((message) => {
    const role = transcriptRoleLabel(message.role);
    const roleClass = `role-${message.role}`;
    const time = new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const bodyHtml = message.content
      ? marked.parse(message.content, { async: false }) as string
      : "<em>(no text content)</em>";
    const toolHtml = message.toolCalls?.map((toolCall) => `
      <div class="tool-call">
        <div class="tool-call-name">${escapeHtml(toolCall.name)}</div>
        <pre class="tool-call-block">${escapeHtml(formatToolArgs(toolCall.args))}</pre>
        ${toolCall.result ? `<pre class="tool-call-block tool-call-result">${escapeHtml(toolCall.result)}</pre>` : ""}
      </div>`).join("\n") ?? "";

    return `
      <div class="message ${roleClass}">
        <div class="message-header"><span class="role">${role}</span><span class="time">${time}</span></div>
        <div class="message-body">${bodyHtml}</div>
        ${toolHtml}
      </div>`;
  }).join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>StarlingAI Session Transcript</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 13px; color: #1a1a2e; max-width: 860px; margin: 0 auto; padding: 2rem; }
    h1 { font-size: 1.4rem; color: #4c1d95; margin-bottom: 0.25rem; }
    .meta { font-size: 0.78rem; color: #6b7280; margin-bottom: 1.5rem; }
    .message { margin-bottom: 1.25rem; border-radius: 8px; padding: 0.75rem 1rem; page-break-inside: avoid; }
    .role-user { background: #eff6ff; border: 1px solid #bfdbfe; }
    .role-assistant { background: #faf5ff; border: 1px solid #e9d5ff; }
    .role-system { background: #f8fafc; border: 1px solid #e5e7eb; }
    .message-header { display: flex; justify-content: space-between; margin-bottom: 0.5rem; }
    .role { font-weight: 700; font-size: 0.8rem; color: #6d28d9; }
    .time { font-size: 0.72rem; color: #9ca3af; }
    .message-body p { margin: 0 0 0.4rem; }
    .message-body p:last-child { margin-bottom: 0; }
    .message-body code { background: #f3f4f6; padding: 0.1em 0.3em; border-radius: 3px; font-size: 0.85em; }
    .message-body pre, .tool-call-block { background: #1e1e2e; color: #e2e8f0; padding: 0.75rem; border-radius: 6px; overflow-x: auto; font-size: 0.82em; white-space: pre-wrap; }
    .message-body pre code { background: none; color: inherit; padding: 0; }
    .message-body ul, .message-body ol { padding-left: 1.25rem; margin: 0.25rem 0; }
    .message-body h1, .message-body h2, .message-body h3 { margin: 0.5rem 0 0.25rem; }
    .message-body table { border-collapse: collapse; width: 100%; }
    .message-body th, .message-body td { border: 1px solid #d1d5db; padding: 0.3rem 0.5rem; }
    .message-body th { background: #f3f4f6; font-weight: 600; }
    .tool-call { margin-top: 0.75rem; }
    .tool-call-name { font-weight: 600; color: #6d28d9; margin-bottom: 0.35rem; }
    .tool-call-result { background: #0f172a; }
    @media print { body { padding: 0; } }
  </style>
</head>
<body>
  <h1>StarlingAI Session Transcript</h1>
  <div class="meta">Session: ${escapeHtml(session.id)} · Status: ${session.archivedAt ? "Archived" : "Active"} · Exported: ${escapeHtml(exportedAt)}</div>
  ${messageHtml}
</body>
</html>`;

  const win = window.open("", "_blank");
  if (!win) return;
  win.document.write(html);
  win.document.close();
  win.focus();
  setTimeout(() => { win.print(); }, 300);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function getTranscriptForExport(): Promise<GatewaySessionTranscript | null> {
  if (!selectedTranscript.value?.session) return null;
  if (transcriptExporting.value) return null;

  transcriptExporting.value = true;
  try {
    if (selectedTranscript.value.transcript.length >= selectedTranscript.value.totalMessages) {
      return selectedTranscript.value;
    }
    return await gateway.getSessionTranscript(selectedTranscript.value.session.id);
  } finally {
    transcriptExporting.value = false;
  }
}

watch(() => gateway.swarmSessionHistory, ensureSelection, { deep: true });
watch(filteredSessionCards, ensureSelection, { deep: true });
watch(() => route.query, ensureSelection, { deep: true });
watch([selectedSessionId, selectedRunId], syncRouteSelection);
watch(selectedSessionId, (sessionId) => {
  void loadTranscript(sessionId);
}, { immediate: true });

onMounted(refresh);
</script>

<style scoped>
.sessions-page {
  padding: 1.5rem;
}

.sessions-page__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1.25rem;
}

.sessions-page__title {
  font-size: 1.125rem;
  font-weight: 600;
  color: #f5ecff;
}

.sessions-page__subtitle {
  margin-top: 0.25rem;
  font-size: 0.85rem;
  color: rgba(226, 217, 243, 0.72);
}

.sessions-page__actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.sessions-page__refresh,
.sessions-page__clear {
  border-radius: 0.85rem;
  border: 1px solid rgba(196, 181, 253, 0.18);
  background: rgba(31, 41, 55, 0.78);
  color: #f3f4f6;
  padding: 0.5rem 0.85rem;
  font-size: 0.85rem;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.sessions-page__clear {
  border-color: rgba(239, 68, 68, 0.2);
  color: #fca5a5;
}

.sessions-page__clear:hover {
  border-color: rgba(239, 68, 68, 0.5);
  background: rgba(127, 29, 29, 0.3);
}

.sessions-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-bottom: 1rem;
}

.sessions-filters__search,
.sessions-filters__select {
  border-radius: 0.85rem;
  border: 1px solid rgba(196, 181, 253, 0.18);
  background: rgba(17, 24, 39, 0.82);
  color: #f5ecff;
  padding: 0.65rem 0.8rem;
  font-size: 0.85rem;
}

.sessions-filters__search {
  flex: 1 1 320px;
}

.sessions-filters__select {
  min-width: 190px;
}

.sessions-layout {
  display: grid;
  grid-template-columns: minmax(280px, 360px) minmax(0, 1fr);
  gap: 1rem;
}

.sessions-list {
  display: grid;
  gap: 0.75rem;
  align-content: start;
}

.sessions-list__empty,
.sessions-preview__empty {
  border-radius: 1rem;
  border: 1px solid rgba(107, 114, 128, 0.24);
  background: rgba(17, 24, 39, 0.72);
  padding: 1rem;
  color: rgba(209, 213, 219, 0.72);
}

.session-card {
  text-align: left;
  border-radius: 1rem;
  border: 1px solid rgba(75, 85, 99, 0.3);
  background: rgba(17, 24, 39, 0.82);
  padding: 0.95rem;
  transition: border-color 0.18s ease, transform 0.18s ease, background 0.18s ease;
}

.session-card:hover,
.session-card--active {
  border-color: rgba(168, 85, 247, 0.42);
  background: rgba(36, 21, 59, 0.75);
  transform: translateY(-1px);
}

.session-card__top,
.session-card__meta,
.session-card__history {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
  align-items: center;
}

.session-card__top {
  justify-content: space-between;
}

.session-card__top-right {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.session-card__delete {
  width: 1.35rem;
  height: 1.35rem;
  border-radius: 50%;
  border: 1px solid rgba(239, 68, 68, 0.25);
  background: transparent;
  color: rgba(252, 165, 165, 0.5);
  font-size: 0.6rem;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: border-color 0.15s, color 0.15s, background 0.15s;
  flex-shrink: 0;
}

.session-card__delete:hover {
  border-color: rgba(239, 68, 68, 0.7);
  color: #f87171;
  background: rgba(127, 29, 29, 0.3);
}

.session-card__action {
  border-radius: 9999px;
  border: 1px solid rgba(96, 165, 250, 0.25);
  background: rgba(30, 41, 59, 0.72);
  color: #bfdbfe;
  font-size: 0.68rem;
  line-height: 1;
  padding: 0.38rem 0.58rem;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, color 0.15s;
}

.session-card__action:hover {
  border-color: rgba(96, 165, 250, 0.5);
  background: rgba(30, 64, 175, 0.22);
}

.session-card__action--secondary {
  border-color: rgba(251, 191, 36, 0.24);
  color: #fcd34d;
}

.session-card__action--secondary:hover {
  border-color: rgba(251, 191, 36, 0.45);
  background: rgba(120, 53, 15, 0.24);
}

.session-card__id {
  font-family: monospace;
  font-size: 0.85rem;
  color: #c4b5fd;
}

.session-card__badge,
.session-card__status {
  border-radius: 9999px;
  padding: 0.18rem 0.5rem;
  font-size: 0.66rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.session-card__badge--active {
  background: rgba(79, 70, 229, 0.2);
  color: #a5b4fc;
}

.session-card__badge--archived {
  background: rgba(55, 65, 81, 0.5);
  color: #d1d5db;
}

.session-card__meta {
  margin-top: 0.55rem;
  font-size: 0.75rem;
  color: rgba(209, 213, 219, 0.7);
}

.session-card__history {
  margin-top: 0.7rem;
  font-size: 0.72rem;
  color: rgba(226, 217, 243, 0.8);
}

.session-card__status--ok {
  background: rgba(20, 83, 45, 0.32);
  color: #86efac;
}

.session-card__status--blocked {
  background: rgba(120, 53, 15, 0.28);
  color: #fcd34d;
}

.session-card__status--error {
  background: rgba(127, 29, 29, 0.28);
  color: #fca5a5;
}

.session-card__objective {
  margin-top: 0.65rem;
  font-size: 0.8rem;
  color: #f5ecff;
  line-height: 1.45;
}

.session-card__preview {
  margin-top: 0.65rem;
  font-size: 0.78rem;
  color: rgba(226, 217, 243, 0.88);
  line-height: 1.5;
}

.sessions-preview {
  min-width: 0;
}

.sessions-preview__stack {
  display: grid;
  gap: 1rem;
}

.transcript-panel {
  border-radius: 1rem;
  border: 1px solid rgba(107, 114, 128, 0.24);
  background: rgba(17, 24, 39, 0.72);
  padding: 1rem;
}

.transcript-panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.transcript-panel__header-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.transcript-panel__title {
  font-size: 0.95rem;
  font-weight: 600;
  color: #f5ecff;
}

.transcript-panel__meta {
  margin-top: 0.25rem;
  font-size: 0.78rem;
  color: rgba(209, 213, 219, 0.72);
}

.transcript-panel__badge {
  border-radius: 9999px;
  padding: 0.22rem 0.55rem;
  font-size: 0.66rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.transcript-panel__badge--active {
  background: rgba(79, 70, 229, 0.2);
  color: #a5b4fc;
}

.transcript-panel__badge--archived {
  background: rgba(55, 65, 81, 0.5);
  color: #d1d5db;
}

.transcript-panel__action {
  border-radius: 9999px;
  border: 1px solid rgba(196, 181, 253, 0.18);
  background: rgba(31, 41, 55, 0.78);
  color: #f3f4f6;
  padding: 0.38rem 0.7rem;
  font-size: 0.74rem;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.transcript-panel__action:hover {
  border-color: rgba(196, 181, 253, 0.42);
  background: rgba(49, 46, 129, 0.28);
}

.transcript-panel__error {
  margin-top: 0.9rem;
  border-radius: 0.9rem;
  border: 1px solid rgba(239, 68, 68, 0.25);
  background: rgba(127, 29, 29, 0.18);
  padding: 0.9rem;
  color: #fecaca;
  font-size: 0.82rem;
}

.transcript-panel__messages {
  margin-top: 1rem;
  display: grid;
  gap: 0.8rem;
}

.transcript-panel__controls {
  margin-top: 1rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.transcript-message {
  border-radius: 0.95rem;
  border: 1px solid rgba(75, 85, 99, 0.24);
  background: rgba(15, 23, 42, 0.48);
  padding: 0.85rem;
}

.transcript-message--user {
  border-color: rgba(59, 130, 246, 0.24);
}

.transcript-message--assistant {
  border-color: rgba(168, 85, 247, 0.24);
}

.transcript-message--system {
  border-color: rgba(148, 163, 184, 0.2);
}

.transcript-message__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.transcript-message__role {
  border-radius: 9999px;
  padding: 0.18rem 0.5rem;
  font-size: 0.66rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.transcript-message__role--user {
  background: rgba(37, 99, 235, 0.18);
  color: #bfdbfe;
}

.transcript-message__role--assistant {
  background: rgba(126, 34, 206, 0.18);
  color: #e9d5ff;
}

.transcript-message__role--system {
  background: rgba(71, 85, 105, 0.22);
  color: #cbd5e1;
}

.transcript-message__time {
  font-size: 0.72rem;
  color: rgba(148, 163, 184, 0.8);
}

.transcript-message__content {
  margin-top: 0.65rem;
  color: rgba(241, 245, 249, 0.92);
  font-size: 0.84rem;
  line-height: 1.55;
  white-space: pre-wrap;
}

.transcript-message__tools {
  margin-top: 0.8rem;
  display: grid;
  gap: 0.65rem;
}

.transcript-tool {
  border-radius: 0.85rem;
  background: rgba(2, 6, 23, 0.34);
  padding: 0.75rem;
}

.transcript-tool__name {
  font-size: 0.74rem;
  font-weight: 600;
  color: #c4b5fd;
}

.transcript-tool__args,
.transcript-tool__result {
  margin-top: 0.55rem;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.74rem;
  line-height: 1.45;
  color: rgba(226, 232, 240, 0.88);
}

.transcript-tool__result {
  color: rgba(186, 230, 253, 0.92);
}

@media (max-width: 960px) {
  .sessions-layout {
    grid-template-columns: 1fr;
  }

  .transcript-panel__header,
  .transcript-message__top,
  .transcript-panel__controls {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
