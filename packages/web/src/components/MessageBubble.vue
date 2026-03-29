<template>
  <div :class="[
    'message-row',
    message.role === 'user'
      ? 'message-row--user'
      : message.role === 'system'
        ? 'message-row--system'
        : 'message-row--ai'
  ]">

    <div :class="[
      'message-bubble',
      message.role === 'user'
        ? 'message-bubble--user'
        : message.role === 'system'
          ? 'message-bubble--system'
          : 'message-bubble--ai',
      message.blocked && 'message-bubble--error'
    ]">

      <!-- Guardrail / blocked badge -->
      <div v-if="message.blocked" :class="['guardrail-badge', blockLabel.startsWith('⛔') ? 'guardrail-badge--blocked' : 'guardrail-badge--warn']">
        {{ blockLabel }}
      </div>
      <div v-if="message.guardrailEvents?.length" class="guardrail-events">
        <div v-for="(ev, i) in message.guardrailEvents" :key="i" class="guardrail-badge guardrail-badge--warn">
          ⚠ {{ ev.type }}: {{ ev.details }}
        </div>
      </div>

      <!-- Execution steps (prefer delegated sub-agent actions over wrapper tool calls) -->
      <div v-if="executionItems.length" class="tool-status-wrap">
        <div class="tool-status" @click="toolHistoryOpen = !toolHistoryOpen">
          <span class="tool-status__icon">⚙</span>
          <span class="tool-status__label">{{ activeExecutionLabel }}</span>
          <span class="tool-status__chevron">{{ toolHistoryOpen ? '▲' : '▼' }}</span>
        </div>
        <div v-if="toolHistoryOpen" class="tool-history">
          <div class="tool-history__header">{{ executionHistoryHeader }}</div>
          <div
            v-for="(item, i) in executionItems"
            :key="`${item.kind}-${item.key}`"
            class="tool-history__item"
          >
            <span class="tool-history__step">{{ i + 1 }}</span>
            <div class="tool-history__details">
              <span class="tool-history__name">{{ item.name }}</span>
              <span v-if="item.meta" class="tool-history__meta">{{ item.meta }}</span>
            </div>
            <span :class="['tool-history__status', `tool-history__status--${item.status}`]">
              {{ item.statusSymbol }}
            </span>
          </div>
        </div>
      </div>

      <!-- Thinking section -->
      <div v-if="thinkingContent || isThinking" class="thinking-section">
        <div class="thinking-header" @click="thinkingOpen = !thinkingOpen">
          <span v-if="isThinking" class="thinking-indicators">
            <span class="thinking-dot">·</span>
            <span class="thinking-dot">·</span>
            <span class="thinking-dot">·</span>
          </span>
          <span v-else class="thinking-toggle-label">
            {{ thinkingOpen ? 'Hide thinking' : 'Show thinking' }}
          </span>
          <span v-if="!isThinking" class="thinking-chevron">{{ thinkingOpen ? '▲' : '▼' }}</span>
        </div>
        <div v-if="thinkingOpen || isThinking" class="thinking-body">
          {{ thinkingContent }}
        </div>
      </div>

      <!-- Image attachments (user messages only) -->
      <div v-if="message.attachments?.length" class="message-attachments">
        <img
          v-for="(att, i) in message.attachments"
          :key="i"
          :src="att.dataUrl"
          :alt="att.filename"
          class="message-attachment-img"
          @click="lightboxUrl = att.dataUrl"
          title="Click to enlarge"
        />
      </div>

      <!-- Main content -->
      <div
        v-if="isStreaming"
        class="message-content prose-content"
        v-html="renderedStreamingContent"
      />
      <div
        v-else-if="mainContent"
        class="message-content prose-content"
        v-html="renderedContent"
      />

      <!-- Timestamp + usage row -->
      <div class="message-footer">
        <div class="message-time">{{ formatTime(message.timestamp) }}</div>
        <div v-if="!isStreaming && mainContent" class="message-export-actions">
          <button @click="exportMessageMarkdown" title="Download as Markdown" class="export-btn">⬇ MD</button>
          <button @click="exportMessagePDF" title="Export as PDF" class="export-btn">⬇ PDF</button>
        </div>
        <div v-if="message.usage && message.role === 'assistant'" class="message-usage">
          {{ formatTokens(message.usage.totalTokens) }} tok
          <template v-if="message.perf">
            · {{ message.perf.llmCalls }} LLM
            · {{ formatDuration(message.perf.turnDurationMs) }}
          </template>
        </div>
      </div>
    </div>

  </div>

  <!-- Image lightbox -->
  <Teleport to="body">
    <div
      v-if="lightboxUrl"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      @click.self="lightboxUrl = null"
      @keydown.esc.window="lightboxUrl = null"
    >
      <div class="relative max-w-4xl max-h-[90vh] p-2">
        <img :src="lightboxUrl" alt="Attachment preview" class="max-w-full max-h-[85vh] rounded-xl object-contain shadow-2xl" />
        <button
          @click="lightboxUrl = null"
          class="absolute -top-2 -right-2 w-7 h-7 rounded-full bg-gray-800 border border-gray-600 text-gray-300 hover:text-white hover:bg-gray-700 flex items-center justify-center text-sm transition-colors"
        >✕</button>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { marked } from "marked";
import DOMPurify from "dompurify";
import type { ChatMessage } from "@/stores/gateway";

type ExecutionStatus = "running" | "done" | "failed";

interface ExecutionItem {
  key: string;
  kind: "subagent" | "subagent-tool" | "tool";
  name: string;
  meta?: string;
  status: ExecutionStatus;
  statusSymbol: string;
  startedAt?: string;
}

function mapExecutionStatus(status: "running" | "completed" | "failed"): ExecutionStatus {
  if (status === "completed") return "done";
  return status;
}

function executionStatusSymbol(status: ExecutionStatus): string {
  if (status === "done") return "✓";
  if (status === "failed") return "!";
  return "…";
}

const props = defineProps<{
  message: ChatMessage;
  isStreaming?: boolean;
  streamingText?: string;
}>();

const toolHistoryOpen = ref(false);
const thinkingOpen = ref(false);
const lightboxUrl = ref<string | null>(null);

// ── Parse thinking blocks out of content ─────────────────────────────────────
const THINKING_RE = /<(thinking|think)>([\s\S]*?)<\/(thinking|think)>/gi;

function splitContent(raw: string): { thinking: string; main: string } {
  let thinking = "";
  const main = raw.replace(THINKING_RE, (_, _tag, content) => {
    thinking += content.trim();
    return "";
  }).trim();
  return { thinking, main };
}

const parsed = computed(() => splitContent(props.message.content ?? ""));
const thinkingContent = computed(() => parsed.value.thinking);
const mainContent = computed(() => parsed.value.main);

// During streaming, detect an open <think> tag that hasn't closed yet
const isThinking = computed(() => {
  if (!props.isStreaming) return false;
  const text = props.streamingText ?? "";
  const opens = (text.match(/<(thinking|think)>/gi) ?? []).length;
  const closes = (text.match(/<\/(thinking|think)>/gi) ?? []).length;
  return opens > closes;
});

const mainStreamingText = computed(() => {
  const text = props.streamingText ?? "";
  return text.replace(/<(thinking|think)>[\s\S]*$/i, "").trim();
});

// ── Block label — distinguish guardrail blocks from technical errors ──────────
const blockLabel = computed((): string => {
  const details = props.message.guardrailEvents?.[0]?.details ?? props.message.content ?? "";
  if (details.startsWith("LLM error:")) return "⚠ LLM connection error";
  if (details.startsWith("Request cancelled")) return "⚠ Request cancelled";
  if (/prompt injection|secret scan|output guardrail/i.test(details)) return "⛔ Blocked by guardrails";
  return "⚠ Request blocked";
});

// ── Execution history label ──────────────────────────────────────────────────
const swarmExecutionItems = computed<ExecutionItem[]>(() => Object.values(props.message.swarmState?.tasks ?? {})
  .flatMap((task) => task.attempts.flatMap((attempt, index) => {
    const status = mapExecutionStatus(attempt.status);
    const items: ExecutionItem[] = [{
      key: `${task.id}-${attempt.agentName}-${attempt.startedAt}-${index}`,
      kind: "subagent" as const,
      name: attempt.agentName,
      meta: [
        task.title,
        attempt.toolCount ? `${attempt.toolCount} tool${attempt.toolCount === 1 ? "" : "s"}` : "",
        attempt.iterations ? `${attempt.iterations} iter${attempt.iterations === 1 ? "" : "s"}` : "",
      ].filter(Boolean).join(" · "),
      status,
      statusSymbol: executionStatusSymbol(status),
      startedAt: attempt.startedAt,
    }];

    for (const [toolIndex, toolName] of (attempt.toolNames ?? []).entries()) {
      items.push({
        key: `${task.id}-${attempt.agentName}-${attempt.startedAt}-${index}-tool-${toolIndex}`,
        kind: "subagent-tool" as const,
        name: toolName,
        meta: `${attempt.agentName} · ${toolIndex + 1}/${attempt.toolNames?.length ?? 0}`,
        status,
        statusSymbol: executionStatusSymbol(status),
        startedAt: attempt.startedAt,
      });
    }

    return items;
  }))
  .sort((left, right) => {
    if (left.startedAt && right.startedAt) return left.startedAt.localeCompare(right.startedAt);
    if (left.startedAt) return -1;
    if (right.startedAt) return 1;
    return left.key.localeCompare(right.key);
  }));

const toolExecutionItems = computed<ExecutionItem[]>(() => (props.message.toolCalls ?? []).map((toolCall, index) => ({
  key: `${toolCall.name}-${index}`,
  kind: "tool" as const,
  name: toolCall.name,
  status: toolCall.result !== undefined ? "done" : "running",
  statusSymbol: toolCall.result !== undefined ? executionStatusSymbol("done") : executionStatusSymbol("running"),
})));

const executionItems = computed<ExecutionItem[]>(() => {
  if (swarmExecutionItems.value.length > 0) return swarmExecutionItems.value;
  return toolExecutionItems.value;
});

const executionHistoryHeader = computed(() => swarmExecutionItems.value.length > 0 ? "Sub-Agent Actions" : "Tool Execution Steps");

const swarmToolCallCount = computed(() => Object.values(props.message.swarmState?.tasks ?? {})
  .flatMap((task) => task.attempts)
  .reduce((total, attempt) => total + (attempt.toolCount ?? 0), 0));

const activeExecutionLabel = computed(() => {
  const items = executionItems.value;
  if (!items.length) return "";

  const running = items.find((item) => item.status === "running");
  if (running) {
    return running.kind === "subagent"
      ? `${running.name} working…`
      : `Calling ${running.name}…`;
  }

  const failedCount = items.filter((item) => item.status === "failed").length;
  if (failedCount > 0) {
    return swarmExecutionItems.value.length > 0
      ? `${failedCount} sub-agent action${failedCount !== 1 ? "s" : ""} failed`
      : `${failedCount} tool call${failedCount !== 1 ? "s" : ""} failed`;
  }

  return swarmExecutionItems.value.length > 0
    ? `${items.filter((item) => item.kind === "subagent").length} sub-agent action${items.filter((item) => item.kind === "subagent").length !== 1 ? "s" : ""} completed${swarmToolCallCount.value > 0 ? ` · ${swarmToolCallCount.value} tool call${swarmToolCallCount.value === 1 ? "" : "s"}` : ""}`
    : `${items.length} tool call${items.length !== 1 ? "s" : ""} completed`;
});

// ── Rendered markdown ─────────────────────────────────────────────────────────
function renderMarkdown(raw: string): string {
  const html = marked.parse(raw, { async: false }) as string;
  return DOMPurify.sanitize(html);
}

const renderedContent = computed(() => {
  const raw = mainContent.value;
  if (!raw) return "";
  return renderMarkdown(raw);
});

const renderedStreamingContent = computed(() => {
  const raw = mainStreamingText.value;
  if (!raw) return "<span class=\"cursor-blink\"></span>";
  return renderMarkdown(raw) + "<span class=\"cursor-blink\"></span>";
});

// ── Per-message export ────────────────────────────────────────────────────────
function exportMessageMarkdown(): void {
  const role = props.message.role === "user" ? "You" : props.message.role === "system" ? "System" : "StarlingAI";
  const time = formatTime(props.message.timestamp);
  const content = mainContent.value;
  const md = `# ${role} — ${time}\n\n${content}\n`;
  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${role.toLowerCase().replace(" ", "-")}-${time.replace(/[: ]/g, "-")}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

function exportMessagePDF(): void {
  const role = props.message.role === "user" ? "You" : props.message.role === "system" ? "System" : "StarlingAI";
  const time = formatTime(props.message.timestamp);
  const bodyHtml = renderedContent.value;
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${role} — ${time}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 13px; color: #1a1a2e; max-width: 860px; margin: 2rem auto; padding: 0 1.5rem; }
    .header { font-size: 0.8rem; color: #6d28d9; font-weight: 700; margin-bottom: 0.5rem; }
    .time { font-size: 0.72rem; color: #9ca3af; margin-left: 0.5rem; font-weight: 400; }
    p { margin: 0 0 0.4rem; }
    p:last-child { margin-bottom: 0; }
    code { background: #f3f4f6; padding: 0.1em 0.3em; border-radius: 3px; font-size: 0.85em; }
    pre { background: #1e1e2e; color: #e2e8f0; padding: 0.75rem; border-radius: 6px; overflow-x: auto; font-size: 0.82em; }
    pre code { background: none; color: inherit; padding: 0; }
    ul, ol { padding-left: 1.25rem; margin: 0.25rem 0; }
    h1, h2, h3 { margin: 0.5rem 0 0.25rem; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #d1d5db; padding: 0.3rem 0.5rem; }
    th { background: #f3f4f6; font-weight: 600; }
    @media print { body { margin: 0; } }
  </style>
</head>
<body>
  <div class="header">${role}<span class="time">${time}</span></div>
  ${bodyHtml}
</body>
</html>`;
  const win = window.open("", "_blank");
  if (!win) return;
  win.document.write(html);
  win.document.close();
  win.focus();
  setTimeout(() => { win.print(); }, 300);
}

function formatTime(date: Date): string {
  return new Date(date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}
</script>

<style scoped>
/* ── Image attachments ───────────────────────────────────────────────────────── */
.message-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
  margin-bottom: 0.5rem;
}
.message-attachment-img {
  max-width: 220px;
  max-height: 160px;
  object-fit: cover;
  border-radius: 0.5rem;
  cursor: zoom-in;
  border: 1px solid rgba(139, 92, 246, 0.25);
  transition: opacity 0.15s;
}
.message-attachment-img:hover { opacity: 0.85; }

/* ── Layout ──────────────────────────────────────────────────────────────────── */
.message-row {
  display: flex;
  margin-bottom: 1rem;
}
.message-row--user { justify-content: flex-end; }
.message-row--ai   { justify-content: flex-start; }
.message-row--system { justify-content: center; }

/* ── Bubble ──────────────────────────────────────────────────────────────────── */
.message-bubble {
  max-width: 80%;
  padding: 0.75rem 1rem;
  font-size: 0.875rem;
  line-height: 1.6;
  backdrop-filter: blur(8px);
  position: relative;
}

.message-bubble--user {
  background: rgba(168, 85, 247, 0.15);
  border: 1px solid rgba(168, 85, 247, 0.35);
  box-shadow: 0 0 16px rgba(168, 85, 247, 0.2);
  border-radius: 1.25rem 1.25rem 0.25rem 1.25rem;
  color: #f3e8ff;
}

.message-bubble--ai {
  background: rgba(30, 27, 46, 0.7);
  border: 1px solid rgba(168, 85, 247, 0.12);
  box-shadow: 0 2px 20px rgba(0, 0, 0, 0.3);
  border-radius: 1.25rem 1.25rem 1.25rem 0.25rem;
  color: #e8e3f5;
}

.message-bubble--system {
  max-width: min(82%, 42rem);
  background: rgba(120, 113, 108, 0.12);
  border: 1px solid rgba(251, 191, 36, 0.22);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  border-radius: 1rem;
  color: #f8e7b9;
}

.message-bubble--error {
  background: rgba(220, 38, 38, 0.08);
  border-color: rgba(220, 38, 38, 0.3);
  box-shadow: 0 0 16px rgba(220, 38, 38, 0.15);
}

/* ── Guardrail badges ─────────────────────────────────────────────────────────── */
.guardrail-badge {
  font-size: 0.75rem;
  padding: 0.25rem 0.5rem;
  border-radius: 0.375rem;
  margin-bottom: 0.5rem;
}
.guardrail-badge--blocked { color: #f87171; background: rgba(239, 68, 68, 0.12); border: 1px solid rgba(239,68,68,0.25); }
.guardrail-badge--warn    { color: #fbbf24; background: rgba(251, 191, 36, 0.08); border: 1px solid rgba(251,191,36,0.2); }
.guardrail-events { margin-bottom: 0.5rem; display: flex; flex-direction: column; gap: 0.25rem; }

/* ── Tool status ─────────────────────────────────────────────────────────────── */
.tool-status-wrap { margin-bottom: 0.625rem; position: relative; }

.tool-status {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.2rem 0.7rem;
  border-radius: 9999px;
  font-size: 0.78rem;
  font-style: italic;
  font-weight: 500;
  cursor: pointer;
  color: #c084fc;
  background: rgba(168, 85, 247, 0.1);
  border: 1px solid rgba(168, 85, 247, 0.25);
  user-select: none;
  transition: background 0.15s;
}
.tool-status:hover { background: rgba(168, 85, 247, 0.18); }
.tool-status__icon  { font-style: normal; }
.tool-status__chevron { font-size: 0.6rem; opacity: 0.6; font-style: normal; }

.tool-history {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 1000;
  min-width: 280px;
  background: rgba(15, 12, 28, 0.95);
  border: 1px solid rgba(168, 85, 247, 0.25);
  border-radius: 0.75rem;
  overflow: hidden;
  box-shadow: 0 8px 32px rgba(0,0,0,0.5);
  backdrop-filter: blur(16px);
}
.tool-history__header {
  padding: 0.5rem 0.75rem;
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: #a78bfa;
  background: rgba(168, 85, 247, 0.1);
  border-bottom: 1px solid rgba(168, 85, 247, 0.15);
}
.tool-history__item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.75rem;
  font-size: 0.78rem;
  border-bottom: 1px solid rgba(255,255,255,0.04);
  color: #c4b5fd;
}
.tool-history__item:last-child { border-bottom: none; }
.tool-history__step  { color: #a78bfa; font-weight: 700; min-width: 1rem; }
.tool-history__details {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}
.tool-history__name  { font-family: monospace; color: #e2d9f3; }
.tool-history__meta {
  color: #b8a7d9;
  font-size: 0.68rem;
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tool-history__status { font-size: 0.75rem; }
.tool-history__status--done    { color: #4ade80; }
.tool-history__status--running { color: #e879f9; animation: pulse 1s infinite; }
.tool-history__status--failed  { color: #f87171; }

/* ── Thinking section ────────────────────────────────────────────────────────── */
.thinking-section {
  border-left: 2px solid rgba(168, 85, 247, 0.4);
  background: rgba(168, 85, 247, 0.04);
  border-radius: 0 0.5rem 0.5rem 0;
  margin-bottom: 0.625rem;
  overflow: hidden;
}
.thinking-header {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.35rem 0.625rem;
  cursor: pointer;
  font-size: 0.75rem;
  color: #a78bfa;
  user-select: none;
}
.thinking-toggle-label { flex: 1; font-style: italic; opacity: 0.8; }
.thinking-chevron { font-size: 0.6rem; opacity: 0.5; }

.thinking-indicators { display: flex; gap: 3px; align-items: center; }
.thinking-dot {
  color: #c084fc;
  font-weight: 900;
  font-size: 1.2rem;
  line-height: 1;
  animation: thinking-jump 1.2s ease-in-out infinite;
}
.thinking-dot:nth-child(2) { animation-delay: 0.15s; }
.thinking-dot:nth-child(3) { animation-delay: 0.3s; }

.thinking-body {
  padding: 0.5rem 0.625rem;
  font-size: 0.75rem;
  color: #9ca3af;
  font-style: italic;
  max-height: 300px;
  overflow-y: auto;
  white-space: pre-wrap;
}

/* ── Message content ──────────────────────────────────────────────────────────── */
.message-content { white-space: pre-wrap; }
.message-content.prose-content { white-space: normal; }

.prose-content :deep(p)           { margin: 0 0 0.5rem; }
.prose-content :deep(p:last-child){ margin-bottom: 0; }
.prose-content :deep(code)        { background: rgba(168,85,247,0.12); color: #d8b4fe; padding: 0.1em 0.35em; border-radius: 4px; font-size: 0.82em; border: 1px solid rgba(168,85,247,0.2); }
.prose-content :deep(pre)         { background: rgba(10, 7, 20, 0.8); border: 1px solid rgba(168,85,247,0.15); padding: 0.75rem; border-radius: 0.75rem; overflow-x: auto; margin: 0.5rem 0; }
.prose-content :deep(pre code)    { background: none; border: none; padding: 0; color: #e2d9f3; }
.prose-content :deep(ul), .prose-content :deep(ol) { padding-left: 1.25rem; margin: 0.25rem 0; }
.prose-content :deep(li)          { margin: 0.15rem 0; }
.prose-content :deep(a)           { color: #a78bfa; text-decoration: underline; }
.prose-content :deep(a:hover)     { color: #c4b5fd; }
.prose-content :deep(strong)      { color: #f3e8ff; font-weight: 600; }
.prose-content :deep(em)          { color: #d8b4fe; font-style: italic; }
.prose-content :deep(blockquote)  { border-left: 2px solid rgba(168,85,247,0.4); padding-left: 0.75rem; color: #9ca3af; font-style: italic; margin: 0.5rem 0; }
.prose-content :deep(h1), .prose-content :deep(h2), .prose-content :deep(h3),
.prose-content :deep(h4), .prose-content :deep(h5), .prose-content :deep(h6) {
  color: #f3e8ff; font-weight: 600; margin: 0.75rem 0 0.35rem; line-height: 1.3;
}
.prose-content :deep(h1) { font-size: 1.15em; }
.prose-content :deep(h2) { font-size: 1.05em; border-bottom: 1px solid rgba(168,85,247,0.15); padding-bottom: 0.2rem; }
.prose-content :deep(h3) { font-size: 0.97em; color: #e9d5ff; }
.prose-content :deep(hr) { border: none; border-top: 1px solid rgba(168,85,247,0.2); margin: 0.75rem 0; }
.prose-content :deep(table)       { width: 100%; border-collapse: collapse; font-size: 0.82em; margin: 0.5rem 0; }
.prose-content :deep(th)          { background: rgba(168,85,247,0.12); color: #d8b4fe; font-weight: 600; text-align: left; padding: 0.35rem 0.6rem; border: 1px solid rgba(168,85,247,0.2); }
.prose-content :deep(td)          { padding: 0.3rem 0.6rem; border: 1px solid rgba(168,85,247,0.12); color: #e2d9f3; }
.prose-content :deep(tr:nth-child(even) td) { background: rgba(168,85,247,0.04); }

/* ── Cursor ───────────────────────────────────────────────────────────────────── */
.cursor-blink {
  display: inline-block;
  width: 2px; height: 16px;
  background: linear-gradient(to bottom, #a855f7, #ec4899);
  margin-left: 2px;
  vertical-align: middle;
  border-radius: 1px;
  animation: pulse 0.9s infinite;
}

/* ── Footer (timestamp + usage) ──────────────────────────────────────────────── */
.message-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 0.4rem;
  gap: 0.5rem;
}

.message-export-actions {
  display: flex;
  gap: 0.25rem;
  opacity: 0;
  transition: opacity 0.15s;
}
.message-bubble:hover .message-export-actions { opacity: 1; }

.export-btn {
  font-size: 0.62rem;
  padding: 0.15rem 0.45rem;
  border-radius: 0.375rem;
  border: 1px solid rgba(168, 85, 247, 0.25);
  background: rgba(168, 85, 247, 0.08);
  color: #a78bfa;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
  line-height: 1.4;
}
.export-btn:hover {
  background: rgba(168, 85, 247, 0.18);
  border-color: rgba(168, 85, 247, 0.45);
  color: #c4b5fd;
}
.message-time {
  font-size: 0.68rem;
  color: rgba(255,255,255,0.2);
}
.message-usage {
  font-size: 0.65rem;
  color: rgba(168,85,247,0.4);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.01em;
}

/* ── Animations ───────────────────────────────────────────────────────────────── */
@keyframes thinking-jump {
  0%, 100% { transform: translateY(0); opacity: 0.4; }
  50%       { transform: translateY(-5px); opacity: 1; }
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.2; }
}
</style>
