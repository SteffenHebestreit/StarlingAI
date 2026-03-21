/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { computed, ref } from "vue";
import { marked } from "marked";
import DOMPurify from "dompurify";
const props = defineProps();
const toolHistoryOpen = ref(false);
const thinkingOpen = ref(false);
const lightboxUrl = ref(null);
// ── Parse thinking blocks out of content ─────────────────────────────────────
const THINKING_RE = /<(thinking|think)>([\s\S]*?)<\/(thinking|think)>/gi;
function splitContent(raw) {
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
    if (!props.isStreaming)
        return false;
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
const blockLabel = computed(() => {
    const details = props.message.guardrailEvents?.[0]?.details ?? props.message.content ?? "";
    if (details.startsWith("LLM error:"))
        return "⚠ LLM connection error";
    if (details.startsWith("Request cancelled"))
        return "⚠ Request cancelled";
    if (/prompt injection|secret scan|output guardrail/i.test(details))
        return "⛔ Blocked by guardrails";
    return "⚠ Request blocked";
});
// ── Tool call label ───────────────────────────────────────────────────────────
const activeToolLabel = computed(() => {
    const tcs = props.message.toolCalls ?? [];
    const running = tcs.find(tc => tc.result === undefined);
    if (running)
        return `Calling ${running.name}…`;
    return `${tcs.length} tool call${tcs.length !== 1 ? "s" : ""} completed`;
});
// ── Rendered markdown ─────────────────────────────────────────────────────────
function renderMarkdown(raw) {
    const html = marked.parse(raw, { async: false });
    return DOMPurify.sanitize(html);
}
const renderedContent = computed(() => {
    const raw = mainContent.value;
    if (!raw)
        return "";
    return renderMarkdown(raw);
});
const renderedStreamingContent = computed(() => {
    const raw = mainStreamingText.value;
    if (!raw)
        return "<span class=\"cursor-blink\"></span>";
    return renderMarkdown(raw) + "<span class=\"cursor-blink\"></span>";
});
// ── Per-message export ────────────────────────────────────────────────────────
function exportMessageMarkdown() {
    const role = props.message.role === "user" ? "You" : "StarlingAI";
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
function exportMessagePDF() {
    const role = props.message.role === "user" ? "You" : "StarlingAI";
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
    if (!win)
        return;
    win.document.write(html);
    win.document.close();
    win.focus();
    setTimeout(() => { win.print(); }, 300);
}
function formatTime(date) {
    return new Date(date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function formatTokens(n) {
    if (n >= 1000)
        return `${(n / 1000).toFixed(1)}k`;
    return String(n);
}
function formatDuration(ms) {
    if (!ms || ms <= 0)
        return "0ms";
    if (ms < 1000)
        return `${Math.round(ms)}ms`;
    if (ms < 60000)
        return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
}
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['message-attachment-img']} */ ;
/** @type {__VLS_StyleScopedClasses['tool-status']} */ ;
/** @type {__VLS_StyleScopedClasses['tool-history__item']} */ ;
/** @type {__VLS_StyleScopedClasses['thinking-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['thinking-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['message-content']} */ ;
/** @type {__VLS_StyleScopedClasses['prose-content']} */ ;
/** @type {__VLS_StyleScopedClasses['prose-content']} */ ;
/** @type {__VLS_StyleScopedClasses['prose-content']} */ ;
/** @type {__VLS_StyleScopedClasses['prose-content']} */ ;
/** @type {__VLS_StyleScopedClasses['prose-content']} */ ;
/** @type {__VLS_StyleScopedClasses['prose-content']} */ ;
/** @type {__VLS_StyleScopedClasses['prose-content']} */ ;
/** @type {__VLS_StyleScopedClasses['prose-content']} */ ;
/** @type {__VLS_StyleScopedClasses['prose-content']} */ ;
/** @type {__VLS_StyleScopedClasses['prose-content']} */ ;
/** @type {__VLS_StyleScopedClasses['prose-content']} */ ;
/** @type {__VLS_StyleScopedClasses['prose-content']} */ ;
/** @type {__VLS_StyleScopedClasses['prose-content']} */ ;
/** @type {__VLS_StyleScopedClasses['prose-content']} */ ;
/** @type {__VLS_StyleScopedClasses['prose-content']} */ ;
/** @type {__VLS_StyleScopedClasses['prose-content']} */ ;
/** @type {__VLS_StyleScopedClasses['prose-content']} */ ;
/** @type {__VLS_StyleScopedClasses['prose-content']} */ ;
/** @type {__VLS_StyleScopedClasses['prose-content']} */ ;
/** @type {__VLS_StyleScopedClasses['prose-content']} */ ;
/** @type {__VLS_StyleScopedClasses['prose-content']} */ ;
/** @type {__VLS_StyleScopedClasses['prose-content']} */ ;
/** @type {__VLS_StyleScopedClasses['prose-content']} */ ;
/** @type {__VLS_StyleScopedClasses['prose-content']} */ ;
/** @type {__VLS_StyleScopedClasses['prose-content']} */ ;
/** @type {__VLS_StyleScopedClasses['prose-content']} */ ;
/** @type {__VLS_StyleScopedClasses['prose-content']} */ ;
/** @type {__VLS_StyleScopedClasses['message-bubble']} */ ;
/** @type {__VLS_StyleScopedClasses['message-export-actions']} */ ;
/** @type {__VLS_StyleScopedClasses['export-btn']} */ ;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: (['message-row', __VLS_ctx.message.role === 'user' ? 'message-row--user' : 'message-row--ai']) },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: (['message-bubble', __VLS_ctx.message.role === 'user' ? 'message-bubble--user' : 'message-bubble--ai', __VLS_ctx.message.blocked && 'message-bubble--error']) },
});
if (__VLS_ctx.message.blocked) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: (['guardrail-badge', __VLS_ctx.blockLabel.startsWith('⛔') ? 'guardrail-badge--blocked' : 'guardrail-badge--warn']) },
    });
    (__VLS_ctx.blockLabel);
}
if (__VLS_ctx.message.guardrailEvents?.length) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "guardrail-events" },
    });
    for (const [ev, i] of __VLS_getVForSourceType((__VLS_ctx.message.guardrailEvents))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            key: (i),
            ...{ class: "guardrail-badge guardrail-badge--warn" },
        });
        (ev.type);
        (ev.details);
    }
}
if (__VLS_ctx.message.toolCalls?.length) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "tool-status-wrap" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.message.toolCalls?.length))
                    return;
                __VLS_ctx.toolHistoryOpen = !__VLS_ctx.toolHistoryOpen;
            } },
        ...{ class: "tool-status" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "tool-status__icon" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "tool-status__label" },
    });
    (__VLS_ctx.activeToolLabel);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "tool-status__chevron" },
    });
    (__VLS_ctx.toolHistoryOpen ? '▲' : '▼');
    if (__VLS_ctx.toolHistoryOpen) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "tool-history" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "tool-history__header" },
        });
        for (const [tc, i] of __VLS_getVForSourceType((__VLS_ctx.message.toolCalls))) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                key: (i),
                ...{ class: "tool-history__item" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "tool-history__step" },
            });
            (i + 1);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "tool-history__name" },
            });
            (tc.name);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: (['tool-history__status', tc.result !== undefined ? 'tool-history__status--done' : 'tool-history__status--running']) },
            });
            (tc.result !== undefined ? '✓' : '…');
        }
    }
}
if (__VLS_ctx.thinkingContent || __VLS_ctx.isThinking) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "thinking-section" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.thinkingContent || __VLS_ctx.isThinking))
                    return;
                __VLS_ctx.thinkingOpen = !__VLS_ctx.thinkingOpen;
            } },
        ...{ class: "thinking-header" },
    });
    if (__VLS_ctx.isThinking) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "thinking-indicators" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "thinking-dot" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "thinking-dot" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "thinking-dot" },
        });
    }
    else {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "thinking-toggle-label" },
        });
        (__VLS_ctx.thinkingOpen ? 'Hide thinking' : 'Show thinking');
    }
    if (!__VLS_ctx.isThinking) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "thinking-chevron" },
        });
        (__VLS_ctx.thinkingOpen ? '▲' : '▼');
    }
    if (__VLS_ctx.thinkingOpen || __VLS_ctx.isThinking) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "thinking-body" },
        });
        (__VLS_ctx.thinkingContent);
    }
}
if (__VLS_ctx.message.attachments?.length) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "message-attachments" },
    });
    for (const [att, i] of __VLS_getVForSourceType((__VLS_ctx.message.attachments))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.img)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.message.attachments?.length))
                        return;
                    __VLS_ctx.lightboxUrl = att.dataUrl;
                } },
            key: (i),
            src: (att.dataUrl),
            alt: (att.filename),
            ...{ class: "message-attachment-img" },
            title: "Click to enlarge",
        });
    }
}
if (__VLS_ctx.isStreaming) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div)({
        ...{ class: "message-content prose-content" },
    });
    __VLS_asFunctionalDirective(__VLS_directives.vHtml)(null, { ...__VLS_directiveBindingRestFields, value: (__VLS_ctx.renderedStreamingContent) }, null, null);
}
else if (__VLS_ctx.mainContent) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div)({
        ...{ class: "message-content prose-content" },
    });
    __VLS_asFunctionalDirective(__VLS_directives.vHtml)(null, { ...__VLS_directiveBindingRestFields, value: (__VLS_ctx.renderedContent) }, null, null);
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "message-footer" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "message-time" },
});
(__VLS_ctx.formatTime(__VLS_ctx.message.timestamp));
if (!__VLS_ctx.isStreaming && __VLS_ctx.mainContent) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "message-export-actions" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (__VLS_ctx.exportMessageMarkdown) },
        title: "Download as Markdown",
        ...{ class: "export-btn" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (__VLS_ctx.exportMessagePDF) },
        title: "Export as PDF",
        ...{ class: "export-btn" },
    });
}
if (__VLS_ctx.message.usage && __VLS_ctx.message.role === 'assistant') {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "message-usage" },
    });
    (__VLS_ctx.formatTokens(__VLS_ctx.message.usage.totalTokens));
    if (__VLS_ctx.message.perf) {
        (__VLS_ctx.message.perf.llmCalls);
        (__VLS_ctx.formatDuration(__VLS_ctx.message.perf.turnDurationMs));
    }
}
const __VLS_0 = {}.Teleport;
/** @type {[typeof __VLS_components.Teleport, typeof __VLS_components.Teleport, ]} */ ;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({
    to: "body",
}));
const __VLS_2 = __VLS_1({
    to: "body",
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
__VLS_3.slots.default;
if (__VLS_ctx.lightboxUrl) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.lightboxUrl))
                    return;
                __VLS_ctx.lightboxUrl = null;
            } },
        ...{ onKeydown: (...[$event]) => {
                if (!(__VLS_ctx.lightboxUrl))
                    return;
                __VLS_ctx.lightboxUrl = null;
            } },
        ...{ class: "fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "relative max-w-4xl max-h-[90vh] p-2" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.img)({
        src: (__VLS_ctx.lightboxUrl),
        alt: "Attachment preview",
        ...{ class: "max-w-full max-h-[85vh] rounded-xl object-contain shadow-2xl" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.lightboxUrl))
                    return;
                __VLS_ctx.lightboxUrl = null;
            } },
        ...{ class: "absolute -top-2 -right-2 w-7 h-7 rounded-full bg-gray-800 border border-gray-600 text-gray-300 hover:text-white hover:bg-gray-700 flex items-center justify-center text-sm transition-colors" },
    });
}
var __VLS_3;
/** @type {__VLS_StyleScopedClasses['guardrail-events']} */ ;
/** @type {__VLS_StyleScopedClasses['guardrail-badge']} */ ;
/** @type {__VLS_StyleScopedClasses['guardrail-badge--warn']} */ ;
/** @type {__VLS_StyleScopedClasses['tool-status-wrap']} */ ;
/** @type {__VLS_StyleScopedClasses['tool-status']} */ ;
/** @type {__VLS_StyleScopedClasses['tool-status__icon']} */ ;
/** @type {__VLS_StyleScopedClasses['tool-status__label']} */ ;
/** @type {__VLS_StyleScopedClasses['tool-status__chevron']} */ ;
/** @type {__VLS_StyleScopedClasses['tool-history']} */ ;
/** @type {__VLS_StyleScopedClasses['tool-history__header']} */ ;
/** @type {__VLS_StyleScopedClasses['tool-history__item']} */ ;
/** @type {__VLS_StyleScopedClasses['tool-history__step']} */ ;
/** @type {__VLS_StyleScopedClasses['tool-history__name']} */ ;
/** @type {__VLS_StyleScopedClasses['thinking-section']} */ ;
/** @type {__VLS_StyleScopedClasses['thinking-header']} */ ;
/** @type {__VLS_StyleScopedClasses['thinking-indicators']} */ ;
/** @type {__VLS_StyleScopedClasses['thinking-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['thinking-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['thinking-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['thinking-toggle-label']} */ ;
/** @type {__VLS_StyleScopedClasses['thinking-chevron']} */ ;
/** @type {__VLS_StyleScopedClasses['thinking-body']} */ ;
/** @type {__VLS_StyleScopedClasses['message-attachments']} */ ;
/** @type {__VLS_StyleScopedClasses['message-attachment-img']} */ ;
/** @type {__VLS_StyleScopedClasses['message-content']} */ ;
/** @type {__VLS_StyleScopedClasses['prose-content']} */ ;
/** @type {__VLS_StyleScopedClasses['message-content']} */ ;
/** @type {__VLS_StyleScopedClasses['prose-content']} */ ;
/** @type {__VLS_StyleScopedClasses['message-footer']} */ ;
/** @type {__VLS_StyleScopedClasses['message-time']} */ ;
/** @type {__VLS_StyleScopedClasses['message-export-actions']} */ ;
/** @type {__VLS_StyleScopedClasses['export-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['export-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['message-usage']} */ ;
/** @type {__VLS_StyleScopedClasses['fixed']} */ ;
/** @type {__VLS_StyleScopedClasses['inset-0']} */ ;
/** @type {__VLS_StyleScopedClasses['z-50']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-center']} */ ;
/** @type {__VLS_StyleScopedClasses['bg-black/80']} */ ;
/** @type {__VLS_StyleScopedClasses['backdrop-blur-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['relative']} */ ;
/** @type {__VLS_StyleScopedClasses['max-w-4xl']} */ ;
/** @type {__VLS_StyleScopedClasses['max-h-[90vh]']} */ ;
/** @type {__VLS_StyleScopedClasses['p-2']} */ ;
/** @type {__VLS_StyleScopedClasses['max-w-full']} */ ;
/** @type {__VLS_StyleScopedClasses['max-h-[85vh]']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-xl']} */ ;
/** @type {__VLS_StyleScopedClasses['object-contain']} */ ;
/** @type {__VLS_StyleScopedClasses['shadow-2xl']} */ ;
/** @type {__VLS_StyleScopedClasses['absolute']} */ ;
/** @type {__VLS_StyleScopedClasses['-top-2']} */ ;
/** @type {__VLS_StyleScopedClasses['-right-2']} */ ;
/** @type {__VLS_StyleScopedClasses['w-7']} */ ;
/** @type {__VLS_StyleScopedClasses['h-7']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-full']} */ ;
/** @type {__VLS_StyleScopedClasses['bg-gray-800']} */ ;
/** @type {__VLS_StyleScopedClasses['border']} */ ;
/** @type {__VLS_StyleScopedClasses['border-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['hover:text-white']} */ ;
/** @type {__VLS_StyleScopedClasses['hover:bg-gray-700']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-center']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['transition-colors']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            toolHistoryOpen: toolHistoryOpen,
            thinkingOpen: thinkingOpen,
            lightboxUrl: lightboxUrl,
            thinkingContent: thinkingContent,
            mainContent: mainContent,
            isThinking: isThinking,
            blockLabel: blockLabel,
            activeToolLabel: activeToolLabel,
            renderedContent: renderedContent,
            renderedStreamingContent: renderedStreamingContent,
            exportMessageMarkdown: exportMessageMarkdown,
            exportMessagePDF: exportMessagePDF,
            formatTime: formatTime,
            formatTokens: formatTokens,
            formatDuration: formatDuration,
        };
    },
    __typeProps: {},
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
    __typeProps: {},
});
; /* PartiallyEnd: #4569/main.vue */
