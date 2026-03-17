/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { computed, reactive, ref, watch } from "vue";
import { marked } from "marked";
import DOMPurify from "dompurify";
const props = defineProps();
const __VLS_emit = defineEmits();
// Auto-expand when active (live run), collapse by default for historical state
const expanded = ref(props.active ?? false);
const timelineOpen = ref(false);
watch(() => props.active, (val) => {
    if (val)
        expanded.value = true;
});
function toggleExpanded() {
    expanded.value = !expanded.value;
}
const statusPriority = {
    running: 0,
    failed: 1,
    blocked: 2,
    pending: 3,
    completed: 4,
};
const tasks = computed(() => Object.values(props.state.tasks).sort((left, right) => {
    const statusDelta = statusPriority[left.status] - statusPriority[right.status];
    if (statusDelta !== 0)
        return statusDelta;
    return left.id.localeCompare(right.id);
}));
const counts = computed(() => tasks.value.reduce((acc, task) => {
    acc[task.status] += 1;
    return acc;
}, {
    running: 0,
    completed: 0,
    pending: 0,
    failed: 0,
    blocked: 0,
}));
const outputOpen = reactive({});
const attemptsOpen = reactive({});
const runs = computed(() => props.runs ?? []);
function toggleAttempts(taskId) {
    attemptsOpen[taskId] = !attemptsOpen[taskId];
}
function summarize(text, maxLength = 180) {
    const compact = text.replace(/\s+/g, " ").trim();
    return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}
function toggleOutput(taskId) {
    outputOpen[taskId] = !outputOpen[taskId];
}
function outputLabel(task) {
    const writerTask = /proposal|draft|application/i.test(task.title)
        || /proposal_writer|email_drafter|cv_generator/i.test(task.selectedAgent ?? "");
    return writerTask ? "Show generated proposal" : "Show task result";
}
function renderOutput(text) {
    const html = marked.parse(text, { async: false });
    return DOMPurify.sanitize(html);
}
function taskDuration(task) {
    const firstStart = task.attempts[0]?.startedAt;
    if (!firstStart)
        return null;
    const lastEnd = task.attempts[task.attempts.length - 1]?.finishedAt ?? props.state.updatedAt;
    return formatDuration(firstStart, lastEnd);
}
function fallbackCount(task) {
    return Math.max(0, task.attempts.length - 1);
}
const timeline = computed(() => Object.values(props.state.tasks)
    .flatMap((task) => task.attempts.map((attempt, index) => ({
    taskId: task.id,
    taskTitle: task.title,
    agentName: attempt.agentName,
    status: attempt.status,
    startedAt: attempt.startedAt,
    durationLabel: attempt.finishedAt ? formatDuration(attempt.startedAt, attempt.finishedAt) : null,
    fallback: index > 0,
    summary: attempt.summary,
})))
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt)));
function formatDuration(start, end) {
    const startTime = new Date(start).getTime();
    const endTime = new Date(end).getTime();
    if (Number.isNaN(startTime) || Number.isNaN(endTime) || endTime < startTime)
        return null;
    const seconds = Math.max(1, Math.round((endTime - startTime) / 1000));
    if (seconds < 60)
        return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}
function formatTimestamp(value) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime()))
        return "just now";
    return parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['swarm-panel__header']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-panel__eyebrow']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-timeline__toggle']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-result__toggle']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-attempts__toggle']} */ ;
/** @type {__VLS_StyleScopedClasses['prose-output']} */ ;
/** @type {__VLS_StyleScopedClasses['prose-output']} */ ;
/** @type {__VLS_StyleScopedClasses['prose-output']} */ ;
/** @type {__VLS_StyleScopedClasses['prose-output']} */ ;
/** @type {__VLS_StyleScopedClasses['prose-output']} */ ;
/** @type {__VLS_StyleScopedClasses['prose-output']} */ ;
/** @type {__VLS_StyleScopedClasses['prose-output']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-panel__header']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-panel__meta']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-timeline__headline']} */ ;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.section, __VLS_intrinsicElements.section)({
    ...{ class: "swarm-panel" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ onClick: (__VLS_ctx.toggleExpanded) },
    ...{ class: "swarm-panel__header" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "swarm-panel__left" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "swarm-panel__eyebrow" },
});
(__VLS_ctx.active ? 'Live swarm state' : 'Latest swarm state');
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "swarm-panel__right" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "swarm-panel__stamp" },
});
(__VLS_ctx.formatTimestamp(__VLS_ctx.state.updatedAt));
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "swarm-panel__meta" },
});
if (__VLS_ctx.counts.running) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "swarm-pill swarm-pill--running" },
    });
    (__VLS_ctx.counts.running);
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "swarm-pill swarm-pill--completed" },
});
(__VLS_ctx.counts.completed);
if (__VLS_ctx.counts.pending) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "swarm-pill swarm-pill--pending" },
    });
    (__VLS_ctx.counts.pending);
}
if (__VLS_ctx.counts.failed) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "swarm-pill swarm-pill--failed" },
    });
    (__VLS_ctx.counts.failed);
}
if (__VLS_ctx.counts.blocked) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "swarm-pill swarm-pill--blocked" },
    });
    (__VLS_ctx.counts.blocked);
}
if (__VLS_ctx.showArchiveAction) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.showArchiveAction))
                    return;
                __VLS_ctx.$emit('open-archive');
            } },
        ...{ class: "swarm-panel__link" },
    });
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "swarm-panel__chevron" },
});
(__VLS_ctx.expanded ? '▲' : '▼');
if (__VLS_ctx.expanded) {
    if (__VLS_ctx.runs.length > 0) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "swarm-runs" },
        });
        for (const [run] of __VLS_getVForSourceType((__VLS_ctx.runs))) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
                ...{ onClick: (...[$event]) => {
                        if (!(__VLS_ctx.expanded))
                            return;
                        if (!(__VLS_ctx.runs.length > 0))
                            return;
                        __VLS_ctx.$emit('select-run', run.id);
                    } },
                key: (run.id),
                ...{ class: (['swarm-runs__item', __VLS_ctx.selectedRunId === run.id && 'swarm-runs__item--active']) },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "swarm-runs__status" },
                ...{ class: (`swarm-runs__status--${run.status}`) },
            });
            (run.status);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "swarm-runs__time" },
            });
            (__VLS_ctx.formatTimestamp(run.recordedAt));
        }
    }
    if (__VLS_ctx.timeline.length) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "swarm-timeline" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.expanded))
                        return;
                    if (!(__VLS_ctx.timeline.length))
                        return;
                    __VLS_ctx.timelineOpen = !__VLS_ctx.timelineOpen;
                } },
            ...{ class: "swarm-timeline__toggle" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "swarm-timeline__label" },
        });
        (__VLS_ctx.timeline.length);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "swarm-result__chevron" },
        });
        (__VLS_ctx.timelineOpen ? '▲' : '▼');
        if (__VLS_ctx.timelineOpen) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "swarm-timeline__list" },
            });
            for (const [entry, index] of __VLS_getVForSourceType((__VLS_ctx.timeline))) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    key: (`${entry.taskId}-${entry.startedAt}-${index}`),
                    ...{ class: "swarm-timeline__item" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div)({
                    ...{ class: "swarm-timeline__dot" },
                    ...{ class: (`swarm-timeline__dot--${entry.status}`) },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "swarm-timeline__content" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "swarm-timeline__headline" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "swarm-timeline__task" },
                });
                (entry.taskTitle);
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "swarm-timeline__agent" },
                });
                (entry.agentName);
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "swarm-timeline__meta" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
                (entry.status);
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
                (__VLS_ctx.formatTimestamp(entry.startedAt));
                if (entry.durationLabel) {
                    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
                    (entry.durationLabel);
                }
                if (entry.fallback) {
                    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
                }
            }
        }
    }
    if (__VLS_ctx.tasks.length) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "swarm-grid" },
        });
        for (const [task] of __VLS_getVForSourceType((__VLS_ctx.tasks))) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.article, __VLS_intrinsicElements.article)({
                key: (task.id),
                ...{ class: (['swarm-card', `swarm-card--${task.status}`]) },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "swarm-card__top" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "swarm-card__id" },
            });
            (task.id);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "swarm-card__title" },
            });
            (task.title);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: (['swarm-card__status', `swarm-card__status--${task.status}`]) },
            });
            (task.status);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "swarm-card__badges" },
            });
            if (__VLS_ctx.taskDuration(task)) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "swarm-mini-badge swarm-mini-badge--duration" },
                });
                (__VLS_ctx.taskDuration(task));
            }
            if (__VLS_ctx.fallbackCount(task) > 0) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "swarm-mini-badge swarm-mini-badge--fallback" },
                });
                (__VLS_ctx.fallbackCount(task));
                (__VLS_ctx.fallbackCount(task) === 1 ? '' : 's');
            }
            if (task.selectedAgent) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "swarm-mini-badge swarm-mini-badge--agent" },
                });
                (task.selectedAgent);
            }
            if (task.error) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "swarm-card__note swarm-card__note--error" },
                });
                (task.error);
            }
            if (task.output) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "swarm-result" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
                    ...{ onClick: (...[$event]) => {
                            if (!(__VLS_ctx.expanded))
                                return;
                            if (!(__VLS_ctx.tasks.length))
                                return;
                            if (!(task.output))
                                return;
                            __VLS_ctx.toggleOutput(task.id);
                        } },
                    ...{ class: "swarm-result__toggle" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
                (__VLS_ctx.outputLabel(task));
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "swarm-result__chevron" },
                });
                (__VLS_ctx.outputOpen[task.id] ? '▲' : '▼');
                if (__VLS_ctx.outputOpen[task.id]) {
                    __VLS_asFunctionalElement(__VLS_intrinsicElements.div)({
                        ...{ class: "swarm-result__body prose-output" },
                    });
                    __VLS_asFunctionalDirective(__VLS_directives.vHtml)(null, { ...__VLS_directiveBindingRestFields, value: (__VLS_ctx.renderOutput(task.output)) }, null, null);
                }
            }
            if (task.attempts.length > 1) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "swarm-attempts" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
                    ...{ onClick: (...[$event]) => {
                            if (!(__VLS_ctx.expanded))
                                return;
                            if (!(__VLS_ctx.tasks.length))
                                return;
                            if (!(task.attempts.length > 1))
                                return;
                            __VLS_ctx.toggleAttempts(task.id);
                        } },
                    ...{ class: "swarm-attempts__toggle" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "swarm-attempts__label" },
                });
                (task.attempts.length);
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "swarm-result__chevron" },
                });
                (__VLS_ctx.attemptsOpen[task.id] ? '▲' : '▼');
                if (__VLS_ctx.attemptsOpen[task.id]) {
                    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                        ...{ class: "swarm-attempts__list" },
                    });
                    for (const [attempt, index] of __VLS_getVForSourceType((task.attempts))) {
                        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                            key: (`${task.id}-${index}`),
                            ...{ class: "swarm-attempt" },
                        });
                        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                            ...{ class: "swarm-attempt__agent" },
                        });
                        (attempt.agentName);
                        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                            ...{ class: (['swarm-attempt__status', `swarm-attempt__status--${attempt.status}`]) },
                        });
                        (attempt.status);
                        if (attempt.summary) {
                            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                                ...{ class: "swarm-attempt__summary" },
                            });
                            (attempt.summary);
                        }
                    }
                }
            }
        }
    }
    else {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "swarm-empty" },
        });
    }
}
/** @type {__VLS_StyleScopedClasses['swarm-panel']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-panel__header']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-panel__left']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-panel__eyebrow']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-panel__right']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-panel__stamp']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-panel__meta']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-pill']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-pill--running']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-pill']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-pill--completed']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-pill']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-pill--pending']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-pill']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-pill--failed']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-pill']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-pill--blocked']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-panel__link']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-panel__chevron']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-runs']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-runs__status']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-runs__time']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-timeline']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-timeline__toggle']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-timeline__label']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-result__chevron']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-timeline__list']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-timeline__item']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-timeline__dot']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-timeline__content']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-timeline__headline']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-timeline__task']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-timeline__agent']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-timeline__meta']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-card__top']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-card__id']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-card__title']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-card__badges']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-mini-badge']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-mini-badge--duration']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-mini-badge']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-mini-badge--fallback']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-mini-badge']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-mini-badge--agent']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-card__note']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-card__note--error']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-result']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-result__toggle']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-result__chevron']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-result__body']} */ ;
/** @type {__VLS_StyleScopedClasses['prose-output']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-attempts']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-attempts__toggle']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-attempts__label']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-result__chevron']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-attempts__list']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-attempt']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-attempt__agent']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-attempt__summary']} */ ;
/** @type {__VLS_StyleScopedClasses['swarm-empty']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            expanded: expanded,
            timelineOpen: timelineOpen,
            toggleExpanded: toggleExpanded,
            tasks: tasks,
            counts: counts,
            outputOpen: outputOpen,
            attemptsOpen: attemptsOpen,
            runs: runs,
            toggleAttempts: toggleAttempts,
            toggleOutput: toggleOutput,
            outputLabel: outputLabel,
            renderOutput: renderOutput,
            taskDuration: taskDuration,
            fallbackCount: fallbackCount,
            timeline: timeline,
            formatTimestamp: formatTimestamp,
        };
    },
    __typeEmits: {},
    __typeProps: {},
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
    __typeEmits: {},
    __typeProps: {},
});
; /* PartiallyEnd: #4569/main.vue */
