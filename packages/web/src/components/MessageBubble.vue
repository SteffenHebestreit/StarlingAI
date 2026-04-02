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
            class="tool-history__item-wrap"
          >
            <div class="tool-history__item">
              <span class="tool-history__step">{{ i + 1 }}</span>
              <div class="tool-history__details">
                <span class="tool-history__name">{{ item.name }}</span>
                <span v-if="item.meta" class="tool-history__meta">{{ item.meta }}</span>
              </div>
              <span :class="['tool-history__status', `tool-history__status--${item.status}`]">
                {{ item.statusSymbol }}
              </span>
            </div>
            <div v-if="item.result" class="tool-history__result">
              <pre>{{ item.result.length > 600 ? item.result.substring(0, 600) + '…' : item.result }}</pre>
            </div>
          </div>
        </div>
      </div>

      <!-- Thinking section -->
      <div v-if="displayThinkingContent || isThinking" class="thinking-section">
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
        <div v-if="thinkingOpen || isThinking || (isStreaming && displayThinkingContent)" class="thinking-body">
          {{ displayThinkingContent }}
        </div>
      </div>

      <!-- Image attachments -->
      <div v-if="imageAttachments.length" class="message-attachments">
        <figure
          v-for="(att, i) in imageAttachments"
          :key="`${att.filename}-${i}`"
          class="message-attachment-figure"
        >
          <img
            :src="att.dataUrl"
            :alt="att.filename"
            class="message-attachment-img"
            @click="previewAttachment(att)"
            title="Click to enlarge"
          />
          <figcaption class="message-attachment-caption">
            <span class="message-attachment-name">{{ att.filename }}</span>
            <button class="artifact-action" @click="downloadAttachment(att)">Download</button>
          </figcaption>
        </figure>
      </div>

      <div v-if="artifactAttachments.length" class="artifact-list">
        <div
          v-for="(att, i) in artifactAttachments"
          :key="`${att.filename}-${i}`"
          class="artifact-card"
        >
          <div class="artifact-card__body">
            <div class="artifact-card__eyebrow">{{ attachmentLabel(att) }}</div>
            <div class="artifact-card__title">{{ att.title || att.filename }}</div>
            <div class="artifact-card__meta">
              <span>{{ att.filename }}</span>
              <span v-if="att.size">{{ formatAttachmentSize(att.size) }}</span>
            </div>
          </div>
          <div class="artifact-card__actions">
            <button
              v-if="isPreviewable(att)"
              class="artifact-action"
              :disabled="artifactPreviewLoading === att.filename"
              @click="previewAttachment(att)"
            >
              {{ artifactPreviewLoading === att.filename ? 'Loading…' : 'Preview' }}
            </button>
            <button
              v-if="!att.isDirectory"
              class="artifact-action"
              @click="downloadAttachment(att)"
            >
              Download
            </button>
            <button
              v-if="att.relativePath"
              class="artifact-action"
              @click="downloadAttachment(att, true)"
            >
              {{ att.isDirectory ? 'Download ZIP' : 'ZIP' }}
            </button>
          </div>
        </div>
      </div>

      <!-- Main content -->
      <div
        :class="['message-content-wrapper', { 'message-content-wrapper--collapsed': contentCollapsed && isLongContent && !isStreaming }]"
      >
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
      </div>
      <button
        v-if="isLongContent && !isStreaming"
        @click="contentCollapsed = !contentCollapsed"
        class="collapse-toggle"
      >
        {{ contentCollapsed ? 'Show more ▼' : 'Show less ▲' }}
      </button>

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

  <Teleport to="body">
    <div
      v-if="artifactPreview"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      @click.self="closeArtifactPreview"
      @keydown.esc.window="closeArtifactPreview"
    >
      <div class="artifact-preview-modal">
        <div class="artifact-preview-modal__header">
          <div>
            <div class="artifact-preview-modal__eyebrow">Artifact Preview</div>
            <div class="artifact-preview-modal__title">{{ artifactPreview.title }}</div>
          </div>
          <button @click="closeArtifactPreview" class="artifact-preview-modal__close">✕</button>
        </div>

        <div class="artifact-preview-modal__body">
          <iframe
            v-if="artifactPreview.kind === 'html' || artifactPreview.kind === 'pdf'"
            :src="artifactPreview.url"
            class="artifact-preview-frame"
            :sandbox="artifactPreview.kind === 'html' ? 'allow-scripts' : undefined"
          />
          <pre v-else-if="artifactPreview.kind === 'text'">{{ artifactPreview.text }}</pre>
          <audio v-else-if="artifactPreview.kind === 'audio'" :src="artifactPreview.url" controls class="artifact-preview-audio" />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { sanitizeAssistantMessageContent, useGatewayStore, type ChatAttachment, type ChatMessage } from "@/stores/gateway";

type ExecutionStatus = "running" | "done" | "failed";

interface ExecutionItem {
  key: string;
  kind: "subagent" | "subagent-tool" | "tool";
  name: string;
  meta?: string;
  status: ExecutionStatus;
  statusSymbol: string;
  startedAt?: string;
  result?: string;
}

interface ArtifactPreviewState {
  title: string;
  filename: string;
  kind: "html" | "pdf" | "text" | "audio";
  url?: string;
  text?: string;
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
  autoCollapse?: boolean;
}>();

const gateway = useGatewayStore();

const COLLAPSE_CHAR_THRESHOLD = 400;

const toolHistoryOpen = ref(false);
const thinkingOpen = ref(false);
const lightboxUrl = ref<string | null>(null);
const artifactPreview = ref<ArtifactPreviewState | null>(null);
const artifactPreviewLoading = ref<string | null>(null);
const contentCollapsed = ref(props.autoCollapse ?? false);

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

const parsed = computed(() => splitContent(
  props.message.role === "assistant"
    ? sanitizeAssistantMessageContent(props.message.content ?? "", props.message.toolCalls)
    : (props.message.content ?? "")
));
const thinkingContent = computed(() => parsed.value.thinking);
const mainContent = computed(() => parsed.value.main);

const streamingThinkingContent = computed(() => {
  if (!props.isStreaming) return "";
  const text = props.streamingText ?? "";
  const completed = Array.from(text.matchAll(THINKING_RE), (match) => (match[2] ?? "").trim())
    .filter(Boolean)
    .join("\n\n");
  const openMatch = text.match(/<(thinking|think)>([\s\S]*?)$/i);
  const open = (openMatch?.[2] ?? "").trim();
  return [completed, open].filter(Boolean).join("\n\n");
});
const displayThinkingContent = computed(() => props.isStreaming
  ? streamingThinkingContent.value
  : thinkingContent.value);

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
  const visibleText = text.replace(/<(thinking|think)>[\s\S]*$/i, "").trim();
  if (props.message.role !== "assistant") return visibleText;
  return sanitizeAssistantMessageContent(visibleText, props.message.toolCalls);
});

const isLongContent = computed(() => (mainContent.value?.length ?? 0) > COLLAPSE_CHAR_THRESHOLD);
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

const toolExecutionItems = computed<ExecutionItem[]>(() => (props.message.toolCalls ?? []).map((toolCall, index) => {
  const argsSummary = Object.entries(toolCall.args ?? {})
    .map(([k, v]) => `${k}: ${String(v).substring(0, 80)}`)
    .join(", ");
  const status: ExecutionStatus = toolCall.result === undefined
    ? "running"
    : toolCall.result.trim().startsWith("Error:")
      ? "failed"
      : "done";
  return {
    key: toolCall.id ?? `${toolCall.name}-${index}`,
    kind: "tool" as const,
    name: toolCall.name,
    meta: argsSummary || undefined,
    status,
    statusSymbol: executionStatusSymbol(status),
    result: toolCall.result,
  };
}));

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

const imageAttachments = computed(() => (props.message.attachments ?? []).filter((attachment) =>
  Boolean(attachment.dataUrl?.startsWith("data:image/")) || attachment.previewMode === "image" || attachment.contentType?.startsWith("image/")
));

const artifactAttachments = computed(() => (props.message.attachments ?? []).filter((attachment) => !imageAttachments.value.includes(attachment)));

function attachmentLabel(attachment: ChatAttachment): string {
  if (attachment.isDirectory) {
    return "Folder artifact";
  }

  switch (attachment.previewMode) {
    case "html":
      return "HTML artifact";
    case "pdf":
      return "PDF artifact";
    case "audio":
      return "Audio artifact";
    case "json":
      return "JSON artifact";
    case "text":
      return "Document artifact";
    default:
      return attachment.sourceTool ? `${attachment.sourceTool} output` : "Workspace artifact";
  }
}

function formatAttachmentSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function isPreviewable(attachment: ChatAttachment): boolean {
  return Boolean(attachment.relativePath) && ["html", "pdf", "text", "json", "audio"].includes(attachment.previewMode ?? "download");
}

function closeArtifactPreview(): void {
  if (artifactPreview.value?.url) {
    URL.revokeObjectURL(artifactPreview.value.url);
  }
  artifactPreview.value = null;
}

async function previewAttachment(attachment: ChatAttachment): Promise<void> {
  if (attachment.dataUrl?.startsWith("data:image/")) {
    lightboxUrl.value = attachment.dataUrl;
    return;
  }

  if (!attachment.relativePath) return;

  artifactPreviewLoading.value = attachment.filename;
  closeArtifactPreview();

  try {
    const { blob, filename } = await gateway.fetchWorkspaceArtifactBlob(attachment.relativePath, { disposition: "inline" });
    if ((attachment.previewMode ?? "download") === "text" || attachment.previewMode === "json") {
      artifactPreview.value = {
        title: attachment.title || filename,
        filename,
        kind: "text",
        text: await blob.text(),
      };
      return;
    }

    const url = URL.createObjectURL(blob);
    artifactPreview.value = {
      title: attachment.title || filename,
      filename,
      kind: attachment.previewMode === "audio" ? "audio" : attachment.previewMode === "pdf" ? "pdf" : "html",
      url,
    };
  } catch (error) {
    artifactPreview.value = {
      title: attachment.title || attachment.filename,
      filename: attachment.filename,
      kind: "text",
      text: `Preview failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    artifactPreviewLoading.value = null;
  }
}

async function downloadAttachment(attachment: ChatAttachment, archive = false): Promise<void> {
  if (attachment.relativePath) {
    await gateway.downloadWorkspaceArtifact(attachment.relativePath, {
      archive,
      suggestedFilename: archive ? `${attachment.filename}.zip` : attachment.filename,
    });
    return;
  }

  if (!attachment.dataUrl) return;
  const anchor = document.createElement("a");
  anchor.href = attachment.dataUrl;
  anchor.download = attachment.filename;
  anchor.click();
}

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

onBeforeUnmount(() => {
  closeArtifactPreview();
});
</script>

<style scoped>
/* ── Image attachments ───────────────────────────────────────────────────────── */
.message-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
  margin-bottom: 0.5rem;
}
.message-attachment-figure {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  margin: 0;
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
.message-attachment-caption {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.message-attachment-name {
  color: #cdbce6;
  font-size: 0.72rem;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.artifact-list {
  display: grid;
  gap: 0.6rem;
  margin-bottom: 0.65rem;
}

.artifact-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.75rem 0.85rem;
  border-radius: 0.9rem;
  background: rgba(11, 16, 29, 0.56);
  border: 1px solid rgba(125, 211, 252, 0.2);
}

.artifact-card__body {
  min-width: 0;
  display: grid;
  gap: 0.18rem;
}

.artifact-card__eyebrow {
  color: #7dd3fc;
  font-size: 0.68rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.artifact-card__title {
  color: #f4f0ff;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.artifact-card__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  color: #b8a7d9;
  font-size: 0.72rem;
}

.artifact-card__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.artifact-action {
  border: 1px solid rgba(125, 211, 252, 0.24);
  background: rgba(125, 211, 252, 0.08);
  color: #dff7ff;
  border-radius: 999px;
  padding: 0.28rem 0.7rem;
  font-size: 0.72rem;
  transition: background 0.15s, border-color 0.15s;
}

.artifact-action:hover:not(:disabled) {
  background: rgba(125, 211, 252, 0.16);
  border-color: rgba(125, 211, 252, 0.4);
}

.artifact-action:disabled {
  opacity: 0.5;
  cursor: wait;
}

.artifact-preview-modal {
  width: min(92vw, 1080px);
  max-height: 88vh;
  background: rgba(13, 17, 29, 0.96);
  border: 1px solid rgba(125, 211, 252, 0.2);
  border-radius: 1.2rem;
  overflow: hidden;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
}

.artifact-preview-modal__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  padding: 1rem 1.1rem 0.85rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.artifact-preview-modal__eyebrow {
  color: #7dd3fc;
  font-size: 0.7rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.artifact-preview-modal__title {
  color: #f4f0ff;
  font-size: 1rem;
  font-weight: 600;
}

.artifact-preview-modal__close {
  width: 2rem;
  height: 2rem;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #d6c8ff;
}

.artifact-preview-modal__body {
  padding: 1rem 1.1rem 1.1rem;
}

.artifact-preview-modal__body pre {
  margin: 0;
  max-height: 68vh;
  overflow: auto;
  padding: 1rem;
  border-radius: 0.9rem;
  background: rgba(5, 8, 18, 0.86);
  color: #d7efff;
  white-space: pre-wrap;
  word-break: break-word;
}

.artifact-preview-frame {
  width: 100%;
  height: 68vh;
  border: none;
  border-radius: 0.9rem;
  background: white;
}

.artifact-preview-audio {
  width: 100%;
}

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
  margin-top: 4px;
  min-width: 280px;
  max-width: 100%;
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
.tool-history__item-wrap {
  border-bottom: 1px solid rgba(255,255,255,0.04);
}
.tool-history__item-wrap:last-child { border-bottom: none; }
.tool-history__item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.75rem;
  font-size: 0.78rem;
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

.tool-history__result {
  padding: 0 0.75rem 0.4rem 2.25rem;
}
.tool-history__result pre {
  margin: 0;
  padding: 0.35rem 0.5rem;
  font-size: 0.68rem;
  line-height: 1.4;
  color: #9ca3af;
  background: rgba(0, 0, 0, 0.3);
  border-radius: 0.375rem;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 120px;
  overflow-y: auto;
}

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

/* ── Content collapse ────────────────────────────────────────────────────────── */
.message-content-wrapper { position: relative; }
.message-content-wrapper--collapsed {
  max-height: 150px;
  overflow: hidden;
}
.message-content-wrapper--collapsed::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 60px;
  background: linear-gradient(transparent, rgba(30, 27, 46, 0.95));
  pointer-events: none;
}
.message-bubble--user .message-content-wrapper--collapsed::after {
  background: linear-gradient(transparent, rgba(48, 20, 80, 0.95));
}
.collapse-toggle {
  display: block;
  width: 100%;
  margin-top: 0.25rem;
  padding: 0.2rem 0;
  background: none;
  border: none;
  font-size: 0.72rem;
  color: #a78bfa;
  cursor: pointer;
  text-align: center;
  opacity: 0.7;
  transition: opacity 0.12s;
}
.collapse-toggle:hover { opacity: 1; }

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
