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
      <div v-if="visibleGuardrailEvents.length" class="guardrail-events">
        <div v-for="(label, i) in visibleGuardrailEvents" :key="i" class="guardrail-badge guardrail-badge--warn">
          {{ label }}
        </div>
      </div>

      <div v-if="message.statusText" class="message-progress">
        <div class="message-progress__current">{{ message.statusText }}</div>
        <div v-if="progressHistory.length > 1" class="message-progress__history">
          <div
            v-for="(entry, index) in progressHistory"
            :key="`${message.id}-progress-${index}`"
            class="message-progress__history-item"
          >
            {{ entry }}
          </div>
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
            <div v-if="att.previewMode === 'mermaid'" class="artifact-card__preview artifact-card__preview--mermaid">
              <div v-if="mermaidPreviewLoading[mermaidAttachmentKey(att)]" class="artifact-card__placeholder">Rendering diagram…</div>
              <div v-else-if="mermaidPreviewErrors[mermaidAttachmentKey(att)]" class="artifact-card__placeholder artifact-card__placeholder--error">
                {{ mermaidPreviewErrors[mermaidAttachmentKey(att)] }}
              </div>
              <div
                v-else-if="mermaidPreviewSvg[mermaidAttachmentKey(att)]"
                class="mermaid-inline-diagram"
                v-html="mermaidPreviewSvg[mermaidAttachmentKey(att)]"
              />
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
              v-if="att.externalUrl"
              class="artifact-action"
              @click="openExternalAttachment(att)"
            >
              Open
            </button>
            <button
              v-else-if="!att.isDirectory"
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
        @click="onMessageContentClick"
      >
        <div
          v-if="isStreaming"
          ref="renderedMessageRef"
          class="message-content prose-content"
          v-html="renderedStreamingContent"
        />
        <div
          v-else-if="mainContent"
          ref="renderedMessageRef"
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
          <button
            v-if="message.role === 'user'"
            @click="emit('rewind', message.id)"
            title="Restart the conversation from this message"
            class="export-btn"
          >↩ Restart</button>
        </div>
        <div
          v-if="(message.usage || message.perf) && message.role === 'assistant'"
          class="message-usage"
          :title="usageTooltip"
        >
          <span v-if="message.usage && message.usage.totalTokens > 0" class="message-usage__chip" aria-label="Total tokens">
            <span class="message-usage__value">{{ formatTokens(message.usage.totalTokens) }}</span>
            <span class="message-usage__label">tok</span>
          </span>
          <span v-if="message.perf && message.perf.turnDurationMs > 0" class="message-usage__chip" aria-label="Turn duration">
            <span class="message-usage__value">{{ formatDuration(message.perf.turnDurationMs) }}</span>
          </span>
          <span v-if="message.perf && message.perf.llmCalls > 1" class="message-usage__chip" aria-label="LLM call count">
            <span class="message-usage__value">{{ message.perf.llmCalls }}</span>
            <span class="message-usage__label">LLM</span>
          </span>
          <span v-if="message.perf && message.perf.toolIterations > 0" class="message-usage__chip" aria-label="Tool iterations">
            <span class="message-usage__value">{{ message.perf.toolIterations }}</span>
            <span class="message-usage__label">tools</span>
          </span>
          <span
            v-if="message.perf && finishReasonNeedsAttention"
            class="message-usage__chip message-usage__chip--warn"
            aria-label="Turn finish reason"
          >
            {{ message.perf.finishReason }}
          </span>
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
            :sandbox="artifactPreview.sandbox"
            referrerpolicy="no-referrer"
          />
          <div v-else-if="artifactPreview.kind === 'website'" class="artifact-preview-website">
            <div v-if="artifactPreview.websiteMeta" class="artifact-preview-website__meta">
              <span class="artifact-preview-website__chip">Inlined assets: {{ artifactPreview.websiteMeta.inlinedAssetCount }}</span>
              <span v-if="artifactPreview.websiteMeta.skippedAssetCount > 0" class="artifact-preview-website__chip artifact-preview-website__chip--warn">
                Skipped: {{ artifactPreview.websiteMeta.skippedAssetCount }}
              </span>
              <span v-if="artifactPreview.websiteMeta.note" class="artifact-preview-website__note">{{ artifactPreview.websiteMeta.note }}</span>
            </div>
            <iframe
              :srcdoc="artifactPreview.srcdoc"
              class="artifact-preview-frame"
              :sandbox="artifactPreview.sandbox"
              referrerpolicy="no-referrer"
            />
          </div>
          <div v-else-if="artifactPreview.kind === 'mermaid'" class="artifact-preview-mermaid">
            <div class="artifact-preview-mermaid__canvas" v-html="artifactPreview.svg" />
            <pre v-if="artifactPreview.text">{{ artifactPreview.text }}</pre>
          </div>
          <div v-else-if="artifactPreview.kind === 'markdown'" class="artifact-preview-markdown prose-content" v-html="artifactPreview.html" />
          <pre v-else-if="artifactPreview.kind === 'text'">{{ artifactPreview.text }}</pre>
          <audio v-else-if="artifactPreview.kind === 'audio'" :src="artifactPreview.url" controls class="artifact-preview-audio" />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { marked, type Tokens } from "marked";
import DOMPurify from "dompurify";
import mermaid from "mermaid";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import "highlight.js/styles/github-dark.css";
import { sanitizeAssistantMessageContent, useGatewayStore, type ChatAttachment, type ChatMessage } from "@/stores/gateway";

// ── highlight.js: register only the languages we expect to see in chat to keep
// the bundle small. Aliases (sh, ts, js, html, etc.) come from the language
// modules themselves. Unknown languages fall through to plaintext.
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("go", go);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("plaintext", plaintext);
hljs.registerLanguage("python", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("shell", shell);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function highlightCode(code: string, lang: string): string {
  const trimmed = (lang ?? "").trim().toLowerCase();
  if (trimmed && hljs.getLanguage(trimmed)) {
    try {
      return hljs.highlight(code, { language: trimmed, ignoreIllegals: true }).value;
    } catch {
      // fall through to escapeHtml below
    }
  }
  return code
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function sanitizeSvgMarkup(raw: string): string | null {
  const normalized = raw.replace(/^\uFEFF/, "").replace(/^<\?xml[^>]*>\s*/i, "").trim();
  const match = normalized.match(/<svg[\s\S]*?<\/svg>/i);
  if (!match) return null;
  const sanitized = DOMPurify.sanitize(match[0], {
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
  }).trim();
  return /<svg[\s\S]*?<\/svg>/i.test(sanitized) ? sanitized : null;
}

function renderSvgPreviewBlock(code: string, lang: string): string | null {
  const normalizedLang = (lang ?? "").trim().toLowerCase();
  if (normalizedLang && !["svg", "xml", "html"].includes(normalizedLang)) {
    return null;
  }
  const svg = sanitizeSvgMarkup(code);
  if (!svg) return null;
  return svg;
}

// Override marked's code renderer once at module load so every <pre><code> in
// the chat gets a header bar with an optional language label and a copy button.
// The button has data-copy-code so a single click handler on the message
// wrapper can find the matching <code> and copy its text.
marked.use({
  renderer: {
    code({ text, lang }: Tokens.Code): string {
      const language = (lang ?? "").trim();
      if (language === "mermaid") {
        // Leave mermaid blocks untouched so the existing inline mermaid
        // renderer / artifact preview can handle them downstream.
        return `<pre><code class="language-mermaid">${escapeAttr(text)}</code></pre>`;
      }
      const highlighted = highlightCode(text, language);
      const svgPreview = renderSvgPreviewBlock(text, language);
      const langLabel = language
        ? `<span class="code-block__lang">${escapeAttr(language)}</span>`
        : "<span class=\"code-block__lang code-block__lang--unknown\">code</span>";
      const actions = svgPreview
        ? `<div class="code-block__actions">
    <div class="code-block__toggle-group" role="tablist" aria-label="SVG block display mode">
      <button class="code-block__toggle code-block__toggle--active" data-svg-mode-button="preview" type="button" aria-pressed="true">Preview</button>
      <button class="code-block__toggle" data-svg-mode-button="code" type="button" aria-pressed="false">Code</button>
    </div>
    <button class="code-block__copy" data-copy-code="1" type="button" aria-label="Copy code to clipboard">Copy</button>
  </div>`
        : `<button class="code-block__copy" data-copy-code="1" type="button" aria-label="Copy code to clipboard">Copy</button>`;
      return `<div class="code-block${svgPreview ? " code-block--svg" : ""}"${svgPreview ? ' data-svg-mode="preview"' : ""}>
  <div class="code-block__header">
    ${langLabel}
    ${actions}
  </div>
  ${svgPreview ? `<div class="code-block__svg-preview" data-svg-panel="preview" aria-label="SVG preview">${svgPreview}</div>` : ""}
  <pre${svgPreview ? ' data-svg-panel="code"' : ""}><code class="language-${escapeAttr(language || "plaintext")} hljs">${highlighted}</code></pre>
</div>`;
    },
  },
});

type ExecutionStatus = "running" | "done" | "partial" | "failed";

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
  kind: "html" | "pdf" | "text" | "markdown" | "audio" | "mermaid" | "website";
  url?: string;
  /** For kind=website only — rendered into an iframe srcdoc with theme/asset CSS inlined. */
  srcdoc?: string;
  text?: string;
  html?: string;
  svg?: string;
  sandbox?: string;
  /** For kind=website only — extra info shown above the iframe (page count, sub-page links). */
  websiteMeta?: {
    pageCount?: number;
    inlinedAssetCount: number;
    skippedAssetCount: number;
    note?: string;
  };
}

let mermaidInitialized = false;
let mermaidRenderCounter = 0;
let mermaidInlineRenderToken = 0;

const MERMAID_START_RE = /^(?:%%\{.*\}%%|%%\s|flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph|quadrantChart|requirementDiagram|xychart-beta|block-beta|architecture-beta|packet-beta|kanban|sankey-beta|radar-beta|treemap-beta|info)\b/i;

function mapExecutionStatus(status: "running" | "completed" | "partial" | "failed"): ExecutionStatus {
  if (status === "completed") return "done";
  if (status === "partial") return "partial";
  return status;
}

function executionStatusSymbol(status: ExecutionStatus): string {
  if (status === "done") return "✓";
  if (status === "partial") return "~";
  if (status === "failed") return "!";
  return "…";
}

const props = defineProps<{
  message: ChatMessage;
  isStreaming?: boolean;
  streamingText?: string;
  autoCollapse?: boolean;
}>();

const emit = defineEmits<{
  rewind: [messageId: string];
}>();

const gateway = useGatewayStore();

const COLLAPSE_CHAR_THRESHOLD = 400;

const toolHistoryOpen = ref(false);
const thinkingOpen = ref(false);
const lightboxUrl = ref<string | null>(null);
const artifactPreview = ref<ArtifactPreviewState | null>(null);
const artifactPreviewLoading = ref<string | null>(null);
const renderedMessageRef = ref<HTMLElement | null>(null);
const contentCollapsed = ref(props.autoCollapse ?? false);
const progressHistory = computed(() => props.message.statusHistory?.slice(-4) ?? []);
const mermaidPreviewSvg = ref<Record<string, string>>({});
const mermaidPreviewErrors = ref<Record<string, string>>({});
const mermaidPreviewLoading = ref<Record<string, boolean>>({});

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
// Most guardrail events are benign internal orchestration mechanics — the
// orchestrator enforced delegation, nudged routing, deduped a tool call, or the
// turn was blocked (already shown via the block badge above). Those belong in
// the audit log, not surfaced to the user as warnings. Only genuinely
// user-relevant outcomes (e.g. output redaction) are shown in chat.
const HIDDEN_GUARDRAIL_TYPES = new Set([
  "delegation_required",
  "workflow_required",
  "routing_nudge_released",
  "tool_blocked",
  "blocked",
]);
const GUARDRAIL_LABELS: Record<string, string> = {
  output_redacted: "🔒 Sensitive output was redacted",
};
const visibleGuardrailEvents = computed(() =>
  (props.message.guardrailEvents ?? [])
    .filter((ev) => !HIDDEN_GUARDRAIL_TYPES.has(ev.type))
    .map((ev) => GUARDRAIL_LABELS[ev.type] ?? `⚠ ${ev.type}: ${ev.details}`),
);

const swarmTasks = computed(() => Object.values(props.message.swarmState?.tasks ?? {}));

// ── Execution history label ──────────────────────────────────────────────────
const swarmExecutionItems = computed<ExecutionItem[]>(() => swarmTasks.value
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

const executionHistoryHeader = computed(() => swarmExecutionItems.value.length > 0 ? "Swarm Task Timeline" : "Tool Execution Steps");

const activeExecutionLabel = computed(() => {
  if (swarmExecutionItems.value.length > 0) {
    const runningTaskCount = swarmTasks.value.filter((task) => task.status === "running" || task.status === "pending").length;
    const runningAttempt = swarmTasks.value
      .flatMap((task) => task.attempts.map((attempt) => ({ task, attempt })))
      .find(({ attempt }) => attempt.status === "running");

    if (runningAttempt) {
      return runningTaskCount > 1
        ? `${runningTaskCount} swarm task${runningTaskCount === 1 ? "" : "s"} running`
        : `${runningAttempt.attempt.agentName} working…`;
    }

    const completedCount = swarmTasks.value.filter((task) => task.status === "completed").length;
    const partialCount = swarmTasks.value.filter((task) => task.status === "partial").length;
    const failedCount = swarmTasks.value.filter((task) => task.status === "failed" || task.status === "blocked").length;
    const parts: string[] = [];

    if (completedCount > 0) parts.push(`${completedCount} task${completedCount === 1 ? "" : "s"} done`);
    if (partialCount > 0) parts.push(`${partialCount} partial`);
    if (failedCount > 0) parts.push(`${failedCount} failed`);

    if (parts.length > 0) {
      return parts.join(" · ");
    }

    return `${swarmTasks.value.length} swarm task${swarmTasks.value.length === 1 ? "" : "s"}`;
  }

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

  const partialCount = items.filter((item) => item.status === "partial").length;
  if (partialCount > 0) {
    return swarmExecutionItems.value.length > 0
      ? `${partialCount} sub-agent action${partialCount !== 1 ? "s" : ""} partial`
      : `${partialCount} tool call${partialCount !== 1 ? "s" : ""} partial`;
  }

  return `${items.length} tool call${items.length !== 1 ? "s" : ""} completed`;
});

watch(
  () => [props.isStreaming, executionItems.value.some((item) => item.status === "running")],
  ([isStreamingNow, hasRunningItems]) => {
    if (isStreamingNow && hasRunningItems) {
      toolHistoryOpen.value = true;
      contentCollapsed.value = false;
    }
  },
  { immediate: true },
);

const imageAttachments = computed(() => (props.message.attachments ?? []).filter((attachment) =>
  Boolean(attachment.dataUrl?.startsWith("data:image/")) || attachment.previewMode === "image" || attachment.contentType?.startsWith("image/")
));

const artifactAttachments = computed(() => (props.message.attachments ?? []).filter((attachment) => !imageAttachments.value.includes(attachment)));

const mermaidAttachments = computed(() => artifactAttachments.value.filter((attachment) => attachment.previewMode === "mermaid"));

watch(mermaidAttachments, (attachments) => {
  for (const attachment of attachments) {
    void ensureMermaidPreview(attachment);
  }
}, { immediate: true });

function mermaidAttachmentKey(attachment: ChatAttachment): string {
  return attachment.relativePath || attachment.filename;
}

function attachmentLabel(attachment: ChatAttachment): string {
  if (attachment.isDirectory) {
    return "Folder artifact";
  }

  if (attachment.externalUrl) {
    return "Live source";
  }

  switch (attachment.previewMode) {
    case "html":
      return "HTML artifact";
    case "pdf":
      return "PDF artifact";
    case "audio":
      return "Audio artifact";
    case "mermaid":
      return "Mermaid diagram";
    case "markdown":
      return "Markdown artifact";
    case "json":
      return "JSON artifact";
    case "text":
      return "Document artifact";
    case "website":
      return "Website artifact";
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
  return Boolean(attachment.relativePath || attachment.externalUrl)
    && ["html", "pdf", "text", "markdown", "json", "audio", "mermaid", "website"].includes(attachment.previewMode ?? "download");
}

function ensureMermaidInitialized(): void {
  if (mermaidInitialized) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "neutral",
  });
  mermaidInitialized = true;
}

/**
 * Pull every relative <link rel="stylesheet"> and <script src> in the HTML,
 * fetch each from the workspace, and inline it as a <style> / <script> tag so
 * the website renders correctly inside an iframe srcdoc (which is opaque to
 * the gateway's authenticated /api/workspace/file endpoint and therefore can't
 * resolve relative <link href="theme.css"> on its own).
 *
 * Returns the rewritten HTML plus counts so the preview chrome can flag if
 * anything was skipped (external CDN, absolute URL, base64 data URI, etc.).
 */
async function inlineWebsiteAssets(
  html: string,
  baseDir: string,
): Promise<{ srcdoc: string; inlinedCount: number; skippedCount: number }> {
  let result = html;
  let inlinedCount = 0;
  let skippedCount = 0;

  const isInlinable = (href: string): boolean => {
    return Boolean(href)
      && !href.startsWith("http://")
      && !href.startsWith("https://")
      && !href.startsWith("//")
      && !href.startsWith("data:")
      && !href.startsWith("#");
  };

  const resolveSibling = (href: string): string => {
    if (href.startsWith("/")) return href.slice(1);
    return baseDir ? `${baseDir}/${href}` : href;
  };

  // <link rel="stylesheet" href="theme.css">  →  <style>...</style>
  const linkRegex = /<link\b[^>]*\brel\s*=\s*["']stylesheet["'][^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*\/?>/gi;
  const linkMatches = Array.from(result.matchAll(linkRegex));
  for (const match of linkMatches) {
    const href = match[1] ?? "";
    if (!isInlinable(href)) {
      skippedCount++;
      continue;
    }
    try {
      const sibling = resolveSibling(href);
      const { blob } = await gateway.fetchWorkspaceArtifactBlob(sibling, { disposition: "inline" });
      const css = await blob.text();
      result = result.replace(match[0], `<style data-inlined-from="${escapeHtml(href)}">\n${css}\n</style>`);
      inlinedCount++;
    } catch {
      skippedCount++;
    }
  }

  // Inline local script-src tags as inline script blocks.
  // Only inlines workspace-local files; CDN scripts like mermaid stay as-is.
  // The regex and the closing tag in the replacement use a no-op character
  // class so the literal closing-script substring never appears in source —
  // otherwise Vue's SFC parser would treat it as the end of this script setup
  // block. Same reason we don't say the literal substring in this comment.
  const scriptCloseTag = "<\/scr" + "ipt>";
  const scriptRegex = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>\s*<\/scr[i]pt>/gi;
  const scriptMatches = Array.from(result.matchAll(scriptRegex));
  for (const match of scriptMatches) {
    const src = match[1] ?? "";
    if (!isInlinable(src)) {
      skippedCount++;
      continue;
    }
    try {
      const sibling = resolveSibling(src);
      const { blob } = await gateway.fetchWorkspaceArtifactBlob(sibling, { disposition: "inline" });
      const js = await blob.text();
      result = result.replace(
        match[0],
        `<scr` + `ipt data-inlined-from="${escapeHtml(src)}">\n${js}\n${scriptCloseTag}`,
      );
      inlinedCount++;
    } catch {
      skippedCount++;
    }
  }

  return { srcdoc: result, inlinedCount, skippedCount };
}

async function renderMermaidSvg(source: string, suffix: string): Promise<string> {
  ensureMermaidInitialized();
  const normalizedSource = normalizeMermaidSource(source);
  const id = `mermaid-${++mermaidRenderCounter}-${suffix.replace(/[^a-z0-9_-]/gi, "-")}`;
  const rendered = await mermaid.render(id, normalizedSource);
  return DOMPurify.sanitize(rendered.svg, {
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
  });
}

function normalizeMermaidSource(rawSource: string): string {
  const withoutBom = rawSource.replace(/^\uFEFF/, "").trim();
  const fenced = withoutBom.match(/```mermaid\s*\r?\n([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : withoutBom;
  const lines = candidate.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => MERMAID_START_RE.test(line.trim()));
  const diagram = startIndex >= 0 ? lines.slice(startIndex).join("\n").trim() : candidate;
  return collapseMermaidMultilineLabels(diagram);
}

function collapseMermaidMultilineLabels(source: string): string {
  const lines = source.split(/\r?\n/);
  const collapsed: string[] = [];
  let buffer = "";
  let squareDepth = 0;
  let roundDepth = 0;
  let curlyDepth = 0;

  const applyBalances = (line: string): void => {
    for (const char of line) {
      if (char === "[") squareDepth++;
      else if (char === "]") squareDepth = Math.max(0, squareDepth - 1);
      else if (char === "(") roundDepth++;
      else if (char === ")") roundDepth = Math.max(0, roundDepth - 1);
      else if (char === "{") curlyDepth++;
      else if (char === "}") curlyDepth = Math.max(0, curlyDepth - 1);
    }
  };

  const hasOpenLabel = (): boolean => squareDepth > 0 || roundDepth > 0 || curlyDepth > 0;
  const flush = (): void => {
    if (buffer) collapsed.push(buffer);
    buffer = "";
    squareDepth = 0;
    roundDepth = 0;
    curlyDepth = 0;
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!buffer) {
      buffer = line;
      applyBalances(line);
      continue;
    }

    if (hasOpenLabel()) {
      buffer += ` ${line.trim()}`;
      applyBalances(line);
      continue;
    }

    flush();
    buffer = line;
    applyBalances(line);
  }

  flush();
  return collapsed.join("\n");
}

async function renderInlineMermaidBlocks(): Promise<void> {
  const token = ++mermaidInlineRenderToken;
  await nextTick();
  if (token !== mermaidInlineRenderToken) return;

  const container = renderedMessageRef.value;
  if (!container) return;

  const mermaidBlocks = Array.from(container.querySelectorAll("pre > code.language-mermaid"));
  for (const block of mermaidBlocks) {
    if (token !== mermaidInlineRenderToken) return;

    const pre = block.parentElement;
    if (!(pre instanceof HTMLElement)) continue;

    const source = block.textContent?.trim();
    if (!source) continue;

    const mount = document.createElement("div");
    mount.className = "mermaid-inline-diagram";
    pre.replaceWith(mount);

    try {
      mount.innerHTML = await renderMermaidSvg(source, "inline-message");
    } catch (error) {
      mount.replaceWith(Object.assign(document.createElement("div"), {
        className: "artifact-card__placeholder artifact-card__placeholder--error",
        textContent: `Diagram preview failed: ${error instanceof Error ? error.message : String(error)}`,
      }));
    }
  }
}

async function ensureMermaidPreview(attachment: ChatAttachment): Promise<void> {
  const key = mermaidAttachmentKey(attachment);
  if (!attachment.relativePath || mermaidPreviewSvg.value[key] || mermaidPreviewErrors.value[key] || mermaidPreviewLoading.value[key]) {
    return;
  }

  mermaidPreviewLoading.value = { ...mermaidPreviewLoading.value, [key]: true };
  try {
    const { blob } = await gateway.fetchWorkspaceArtifactBlob(attachment.relativePath, { disposition: "inline" });
    const source = await blob.text();
    mermaidPreviewSvg.value = {
      ...mermaidPreviewSvg.value,
      [key]: await renderMermaidSvg(source, key),
    };
  } catch (error) {
    mermaidPreviewErrors.value = {
      ...mermaidPreviewErrors.value,
      [key]: `Diagram preview failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    mermaidPreviewLoading.value = { ...mermaidPreviewLoading.value, [key]: false };
  }
}

function closeArtifactPreview(): void {
  if (artifactPreview.value?.url?.startsWith("blob:")) {
    URL.revokeObjectURL(artifactPreview.value.url);
  }
  artifactPreview.value = null;
}

async function previewAttachment(attachment: ChatAttachment): Promise<void> {
  if (attachment.dataUrl?.startsWith("data:image/")) {
    lightboxUrl.value = attachment.dataUrl;
    return;
  }

  artifactPreviewLoading.value = attachment.filename;
  closeArtifactPreview();

  try {
    if (attachment.externalUrl) {
      artifactPreview.value = {
        title: attachment.title || attachment.filename,
        filename: attachment.filename,
        kind: attachment.previewMode === "pdf" ? "pdf" : attachment.previewMode === "audio" ? "audio" : "html",
        url: attachment.externalUrl,
        sandbox: attachment.previewMode === "html" ? "allow-scripts allow-same-origin allow-forms allow-popups" : undefined,
      };
      return;
    }

    if (!attachment.relativePath) return;

    const { blob, filename } = await gateway.fetchWorkspaceArtifactBlob(attachment.relativePath, { disposition: "inline" });
    if (attachment.previewMode === "mermaid") {
      const source = await blob.text();
      artifactPreview.value = {
        title: attachment.title || filename,
        filename,
        kind: "mermaid",
        text: source,
        svg: await renderMermaidSvg(source, filename),
      };
      return;
    }

    if (attachment.previewMode === "website") {
      const indexHtml = await blob.text();
      const baseDir = attachment.relativePath ? attachment.relativePath.replace(/\/[^/]*$/, "") : "";
      const inlined = await inlineWebsiteAssets(indexHtml, baseDir);
      artifactPreview.value = {
        title: attachment.title || filename,
        filename,
        kind: "website",
        srcdoc: inlined.srcdoc,
        sandbox: "allow-same-origin",
        websiteMeta: {
          inlinedAssetCount: inlined.inlinedCount,
          skippedAssetCount: inlined.skippedCount,
          note: inlined.skippedCount > 0
            ? "Some assets could not be inlined; download the bundle for the full multi-page site."
            : "Sub-page navigation is disabled in inline preview — use Download to browse the full site locally.",
        },
      };
      return;
    }

    if (attachment.previewMode === "markdown") {
      const text = await blob.text();
      artifactPreview.value = {
        title: attachment.title || filename,
        filename,
        kind: "markdown",
        text,
        html: renderMarkdown(text),
      };
      return;
    }

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
      sandbox: attachment.previewMode === "html" ? "allow-scripts" : undefined,
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

function openExternalAttachment(attachment: ChatAttachment): void {
  if (!attachment.externalUrl) return;
  window.open(attachment.externalUrl, "_blank", "noopener,noreferrer");
}

/**
 * Single delegated click handler on the message-content-wrapper that catches
 * clicks on any [data-copy-code] button injected by the marked code renderer
 * and copies the matching <code> block's text to the clipboard. Falls back to
 * a temporary <textarea> selectAll-and-copy when navigator.clipboard is
 * unavailable (older browsers, insecure context, etc.).
 */
function onMessageContentClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  if (!target) return;
  const toggleButton = target.closest("[data-svg-mode-button]") as HTMLButtonElement | null;
  if (toggleButton) {
    const wrapper = toggleButton.closest(".code-block--svg") as HTMLElement | null;
    const mode = toggleButton.dataset.svgModeButton;
    if (!wrapper || (mode !== "preview" && mode !== "code")) return;
    event.preventDefault();
    event.stopPropagation();
    wrapper.dataset.svgMode = mode;
    wrapper.querySelectorAll<HTMLButtonElement>("[data-svg-mode-button]").forEach((button) => {
      const active = button.dataset.svgModeButton === mode;
      button.setAttribute("aria-pressed", active ? "true" : "false");
      button.classList.toggle("code-block__toggle--active", active);
    });
    return;
  }
  const button = target.closest("[data-copy-code]") as HTMLButtonElement | null;
  if (!button) return;
  const wrapper = button.closest(".code-block");
  const codeEl = wrapper?.querySelector("pre code") as HTMLElement | null;
  if (!codeEl) return;
  event.preventDefault();
  event.stopPropagation();
  const text = codeEl.textContent ?? "";
  const flash = (label: string, modifier: string) => {
    button.textContent = label;
    button.classList.add(modifier);
    setTimeout(() => {
      button.textContent = "Copy";
      button.classList.remove(modifier);
    }, 1800);
  };
  const writePromise = (navigator.clipboard?.writeText
    ? navigator.clipboard.writeText(text)
    : Promise.reject(new Error("clipboard unavailable"))
  );
  writePromise
    .then(() => flash("Copied", "code-block__copy--copied"))
    .catch(() => {
      try {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
        flash("Copied", "code-block__copy--copied");
      } catch {
        flash("Failed", "code-block__copy--failed");
      }
    });
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
// breaks=true: single \n in source becomes <br> so multi-line user messages
//   don't get collapsed into one wrapped paragraph by CommonMark rules.
// gfm=true:    GitHub-flavored extras (tables, autolinks, ~~strikethrough~~)
//   that match the conventions assistant messages already use.
function renderMarkdown(raw: string): string {
  const html = marked.parse(raw, { async: false, breaks: true, gfm: true }) as string;
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
  });
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Stabilize a stream-in-progress so marked doesn't render half-open structures
 * as ugly artifacts that then snap into place when the closer arrives.
 *  - Unclosed fenced code block: append a closing ``` so the partial code is
 *    still rendered as a code block (with the right language class) instead of
 *    cascading into the rest of the message as paragraph text.
 *  - Half-typed inline code (``foo``) is a non-issue — a single ` rolls back
 *    to a literal backtick at render time.
 */
function stabilizePartialMarkdown(raw: string): string {
  const fenceCount = (raw.match(/^(```+)/gm) ?? []).length;
  if (fenceCount % 2 === 1) {
    const trailing = raw.endsWith("\n") ? "" : "\n";
    return `${raw}${trailing}\`\`\``;
  }
  return raw;
}

function renderStreamingMarkdown(raw: string): string {
  return renderMarkdown(stabilizePartialMarkdown(raw));
}

const renderedContent = computed(() => {
  const raw = mainContent.value;
  if (!raw) return "";
  return renderMarkdown(raw);
});

const renderedStreamingContent = computed(() => {
  const raw = mainStreamingText.value;
  if (!raw) return "<span class=\"cursor-blink\"></span>";
  // Render streamed text with the same Markdown pipeline as completed messages
  // so users see formatted output as it arrives instead of literal **bold**.
  // The cursor blink follows the rendered HTML rather than living inside it,
  // because the last block-level element (e.g. </p>) is the natural anchor.
  return `${renderStreamingMarkdown(raw)}<span class="cursor-blink"></span>`;
});

watch(
  [renderedContent, renderedStreamingContent, () => props.isStreaming],
  () => {
    void renderInlineMermaidBlocks();
  },
  { immediate: true, flush: "post" },
);

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

// Per-turn cost / perf chip tooltip — full breakdown for operators who care
// about prompt vs completion tokens, LLM time vs total turn time, etc.
const usageTooltip = computed(() => {
  const parts: string[] = [];
  const usage = props.message.usage;
  const perf = props.message.perf;
  if (usage) {
    parts.push(`Prompt tokens: ${usage.promptTokens.toLocaleString()}`);
    parts.push(`Completion tokens: ${usage.completionTokens.toLocaleString()}`);
    parts.push(`Total tokens: ${usage.totalTokens.toLocaleString()}`);
  }
  if (perf) {
    if (usage) parts.push("");
    parts.push(`Turn duration: ${formatDuration(perf.turnDurationMs)}`);
    parts.push(`LLM time: ${formatDuration(perf.llmTimeMs)} across ${perf.llmCalls} call${perf.llmCalls === 1 ? "" : "s"}`);
    parts.push(`Tool iterations: ${perf.toolIterations}`);
    parts.push(`Finish: ${perf.finishReason}`);
  }
  return parts.join("\n");
});

// Highlight finish reasons that meant the turn didn't end on its own (the
// user usually wants to know about these).
const finishReasonNeedsAttention = computed(() => {
  const reason = props.message.perf?.finishReason;
  if (!reason) return false;
  return ["max_iterations", "timeout", "budget_exceeded", "blocked", "interrupted", "error"].includes(reason);
});

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

.artifact-card__preview {
  margin-top: 0.65rem;
  border-radius: 0.8rem;
  overflow: hidden;
}

.artifact-card__preview--mermaid {
  background: rgba(245, 248, 255, 0.96);
  border: 1px solid rgba(125, 211, 252, 0.22);
  padding: 0.7rem;
}

.artifact-card__placeholder {
  color: #5b6b8a;
  font-size: 0.74rem;
}

.artifact-card__placeholder--error {
  color: #b91c1c;
}

.mermaid-inline-diagram :deep(svg) {
  width: 100%;
  height: auto;
  display: block;
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

.message-progress {
  display: grid;
  gap: 0.45rem;
  margin-bottom: 0.65rem;
  padding: 0.75rem 0.85rem;
  border-radius: 0.95rem;
  background: rgba(56, 189, 248, 0.08);
  border: 1px solid rgba(56, 189, 248, 0.18);
}

.message-progress__current {
  color: #dff7ff;
  font-size: 0.8rem;
  line-height: 1.45;
}

.message-progress__history {
  display: grid;
  gap: 0.18rem;
  color: #9fc6d9;
  font-size: 0.72rem;
}

.message-progress__history-item {
  line-height: 1.35;
}

.message-streaming-text {
  white-space: pre-wrap;
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

.artifact-preview-markdown {
  max-height: 68vh;
  overflow: auto;
  padding-right: 0.25rem;
}

.artifact-preview-mermaid {
  display: grid;
  gap: 1rem;
}

.artifact-preview-mermaid__canvas {
  padding: 1rem;
  border-radius: 0.9rem;
  background: rgba(250, 252, 255, 0.98);
}

.artifact-preview-mermaid__canvas :deep(svg) {
  width: 100%;
  height: auto;
  display: block;
}

.artifact-preview-frame {
  width: 100%;
  height: 68vh;
  border: none;
  border-radius: 0.9rem;
  background: white;
}

.artifact-preview-website {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.artifact-preview-website__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.45rem;
  font-size: 0.78rem;
  color: rgb(209 213 219);
}

.artifact-preview-website__chip {
  display: inline-flex;
  align-items: center;
  padding: 0.18rem 0.55rem;
  border-radius: 999px;
  background: rgba(56, 189, 248, 0.16);
  color: rgb(186 230 253);
  border: 1px solid rgba(56, 189, 248, 0.32);
  font-weight: 500;
}

.artifact-preview-website__chip--warn {
  background: rgba(251, 191, 36, 0.16);
  color: rgb(252 211 77);
  border-color: rgba(251, 191, 36, 0.36);
}

.artifact-preview-website__note {
  flex: 1 1 220px;
  color: rgb(156 163 175);
  font-style: italic;
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
.tool-history__status--partial { color: #fbbf24; }
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

/* Code-block wrapper produced by the marked code renderer override.
   Header strip with language label + Copy button; pre/code styles inherit
   from the surrounding .prose-content rules above and the github-dark
   highlight.js theme imported in the script section. */
.prose-content :deep(.code-block) {
  margin: 0.6rem 0;
  border: 1px solid rgba(168, 85, 247, 0.18);
  border-radius: 0.85rem;
  overflow: hidden;
  background: rgba(10, 7, 20, 0.85);
}
.prose-content :deep(.code-block__header) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.35rem 0.7rem;
  background: rgba(31, 41, 55, 0.55);
  border-bottom: 1px solid rgba(168, 85, 247, 0.14);
  font-size: 0.72rem;
  letter-spacing: 0.02em;
}
.prose-content :deep(.code-block__lang) {
  text-transform: uppercase;
  color: rgb(196 181 253);
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-weight: 600;
}
.prose-content :deep(.code-block__lang--unknown) {
  text-transform: none;
  color: rgb(156 163 175);
  font-weight: 500;
}
.prose-content :deep(.code-block__actions) {
  display: flex;
  align-items: center;
  gap: 0.55rem;
}
.prose-content :deep(.code-block__toggle-group) {
  display: inline-flex;
  align-items: center;
  padding: 0.12rem;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.7);
  border: 1px solid rgba(168, 85, 247, 0.18);
}
.prose-content :deep(.code-block__toggle) {
  appearance: none;
  border: none;
  background: transparent;
  color: rgb(156 163 175);
  padding: 0.18rem 0.6rem;
  border-radius: 999px;
  font-size: 0.7rem;
  letter-spacing: 0.04em;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.prose-content :deep(.code-block__toggle:hover) {
  color: rgb(226 232 240);
}
.prose-content :deep(.code-block__toggle--active) {
  background: rgba(6, 182, 212, 0.18);
  color: rgb(165 243 252);
}
.prose-content :deep(.code-block__copy) {
  appearance: none;
  border: 1px solid rgba(168, 85, 247, 0.35);
  background: rgba(168, 85, 247, 0.12);
  color: rgb(216 180 254);
  padding: 0.18rem 0.65rem;
  border-radius: 999px;
  font-size: 0.7rem;
  letter-spacing: 0.05em;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease, transform 120ms ease;
}
.prose-content :deep(.code-block__copy:hover) {
  background: rgba(168, 85, 247, 0.22);
  color: rgb(243 232 255);
  border-color: rgba(168, 85, 247, 0.55);
}
.prose-content :deep(.code-block__copy:active) { transform: scale(0.96); }
.prose-content :deep(.code-block__copy:focus-visible) {
  outline: 2px solid rgb(196 181 253);
  outline-offset: 2px;
}
.prose-content :deep(.code-block__copy--copied) {
  background: rgba(34, 197, 94, 0.18);
  color: rgb(187 247 208);
  border-color: rgba(34, 197, 94, 0.55);
}
.prose-content :deep(.code-block__copy--failed) {
  background: rgba(248, 113, 113, 0.18);
  color: rgb(254 202 202);
  border-color: rgba(248, 113, 113, 0.55);
}
.prose-content :deep(.code-block__svg-preview) {
  display: grid;
  place-items: center;
  padding: 1rem;
  background:
    radial-gradient(circle at top, rgba(6, 182, 212, 0.14), transparent 52%),
    linear-gradient(180deg, rgba(15, 23, 42, 0.96), rgba(10, 7, 20, 0.88));
  border-bottom: 1px solid rgba(168, 85, 247, 0.14);
  overflow: auto;
}
.prose-content :deep(.code-block__svg-preview svg) {
  display: block;
  max-width: min(100%, 26rem);
  height: auto;
  max-height: 24rem;
}
.prose-content :deep(.code-block--svg[data-svg-mode='preview'] pre[data-svg-panel='code']) {
  display: none;
}
.prose-content :deep(.code-block--svg[data-svg-mode='code'] .code-block__svg-preview[data-svg-panel='preview']) {
  display: none;
}
.prose-content :deep(.code-block pre) {
  margin: 0;
  border: none;
  border-radius: 0;
  background: transparent;
}
/* Tone the github-dark hljs theme into the surrounding panel so it doesn't
   look like a foreign element pasted in. */
.prose-content :deep(.code-block .hljs) {
  background: transparent;
  color: #e2d9f3;
  padding: 0;
}
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
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.7rem;
  color: rgba(216, 180, 254, 0.75);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.01em;
  cursor: help;
}

.message-usage__chip {
  display: inline-flex;
  align-items: baseline;
  gap: 0.25rem;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  border: 1px solid rgba(168, 85, 247, 0.22);
  background: rgba(168, 85, 247, 0.08);
  color: rgba(216, 180, 254, 0.85);
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}

.message-usage__chip:hover {
  background: rgba(168, 85, 247, 0.18);
  color: rgb(243 232 255);
  border-color: rgba(168, 85, 247, 0.42);
}

.message-usage__value {
  font-weight: 600;
}

.message-usage__label {
  font-size: 0.6rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: rgba(196, 181, 253, 0.65);
}

.message-usage__chip--warn {
  border-color: rgba(251, 191, 36, 0.45);
  background: rgba(251, 191, 36, 0.14);
  color: rgb(252 211 77);
  font-size: 0.62rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 600;
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
