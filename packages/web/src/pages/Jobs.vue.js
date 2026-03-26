/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useGatewayStore } from "@/stores/gateway";
import { useScenesStore } from "@/stores/scenes";
const router = useRouter();
const gateway = useGatewayStore();
const scenesStore = useScenesStore();
const searchQuery = ref("");
const statusFilter = ref("all");
const filteredJobs = computed(() => {
    const query = searchQuery.value.trim().toLowerCase();
    return scenesStore.recentJobs.filter((job) => {
        if (statusFilter.value === "active" && !isCancelable(job.status))
            return false;
        if (statusFilter.value !== "all" && statusFilter.value !== "active" && job.status !== statusFilter.value)
            return false;
        if (!query)
            return true;
        return [
            job.id,
            job.sessionId,
            job.sceneName,
            job.progress.message ?? "",
            job.progress.currentAgent ?? "",
            job.progress.currentTool ?? "",
            job.error ?? "",
        ].some((value) => value.toLowerCase().includes(query));
    });
});
async function refreshJobs() {
    await Promise.all(scenesStore.recentJobs.map((job) => scenesStore.fetchJob(job.id)));
}
async function openJobSession(sessionId) {
    const session = gateway.sessions.find((entry) => entry.id === sessionId);
    if (session && !session.archivedAt) {
        await gateway.switchSession(sessionId);
        await router.push({ path: "/" });
        return;
    }
    await router.push({ path: "/sessions", query: { sessionId } });
}
function isCancelable(status) {
    return status === "queued" || status === "running" || status === "cancelling";
}
function formatSceneName(name) {
    return name.replace(/_/g, " ");
}
function shortJobId(value) {
    return `${value.slice(0, 8)}…`;
}
function formatTimestamp(value) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime()))
        return "unknown";
    return parsed.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function lifecycleLabel(job) {
    if (job.startedAt)
        return `Started ${formatTimestamp(job.startedAt)}`;
    if (job.createdAt)
        return `Queued ${formatTimestamp(job.createdAt)}`;
    return "Waiting for worker";
}
function formatDuration(value) {
    if (!Number.isFinite(value) || value <= 0)
        return "0 ms";
    if (value < 1_000)
        return `${Math.round(value)} ms`;
    if (value < 60_000)
        return `${(value / 1_000).toFixed(1)} s`;
    return `${(value / 60_000).toFixed(1)} min`;
}
function jobBadgeClass(status) {
    if (status === "completed")
        return "job-card__badge job-card__badge--completed";
    if (status === "failed")
        return "job-card__badge job-card__badge--failed";
    if (status === "cancelled")
        return "job-card__badge job-card__badge--cancelled";
    if (status === "cancelling")
        return "job-card__badge job-card__badge--cancelling";
    if (status === "queued")
        return "job-card__badge job-card__badge--queued";
    return "job-card__badge job-card__badge--running";
}
function jobToneClass(status) {
    if (status === "completed")
        return "job-card--completed";
    if (status === "failed")
        return "job-card--failed";
    if (status === "cancelled")
        return "job-card--cancelled";
    if (status === "cancelling")
        return "job-card--cancelling";
    if (status === "queued")
        return "job-card--queued";
    return "job-card--running";
}
onMounted(() => {
    void refreshJobs();
});
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['jobs-page__search']} */ ;
/** @type {__VLS_StyleScopedClasses['jobs-page__select']} */ ;
/** @type {__VLS_StyleScopedClasses['job-card__timeline']} */ ;
/** @type {__VLS_StyleScopedClasses['job-card__detail-row']} */ ;
/** @type {__VLS_StyleScopedClasses['job-card__top']} */ ;
/** @type {__VLS_StyleScopedClasses['job-card__actions']} */ ;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "jobs-page" },
    ...{ style: {} },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "jobs-page__header" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h2, __VLS_intrinsicElements.h2)({
    ...{ class: "jobs-page__title" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
    ...{ class: "jobs-page__subtitle" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "jobs-page__actions" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
    ...{ onClick: (__VLS_ctx.refreshJobs) },
    ...{ class: "jobs-page__button" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "jobs-page__filters" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.input, __VLS_intrinsicElements.input)({
    type: "search",
    ...{ class: "jobs-page__search" },
    placeholder: "Search by scene, job, tool, or agent",
});
(__VLS_ctx.searchQuery);
__VLS_asFunctionalElement(__VLS_intrinsicElements.select, __VLS_intrinsicElements.select)({
    value: (__VLS_ctx.statusFilter),
    ...{ class: "jobs-page__select" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
    value: "all",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
    value: "active",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
    value: "queued",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
    value: "running",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
    value: "cancelling",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
    value: "cancelled",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
    value: "completed",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
    value: "failed",
});
if (!__VLS_ctx.filteredJobs.length) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "jobs-page__empty" },
    });
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "jobs-grid" },
    });
    for (const [job] of __VLS_getVForSourceType((__VLS_ctx.filteredJobs))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.article, __VLS_intrinsicElements.article)({
            key: (job.id),
            ...{ class: (['job-card', __VLS_ctx.jobToneClass(job.status)]) },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "job-card__top" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "job-card__title-row" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({
            ...{ class: "job-card__title" },
        });
        (__VLS_ctx.formatSceneName(job.sceneName));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: (__VLS_ctx.jobBadgeClass(job.status)) },
        });
        (job.status);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "job-card__meta" },
        });
        (__VLS_ctx.shortJobId(job.id));
        (__VLS_ctx.shortJobId(job.sessionId));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "job-card__actions" },
        });
        if (__VLS_ctx.isCancelable(job.status)) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
                ...{ onClick: (...[$event]) => {
                        if (!!(!__VLS_ctx.filteredJobs.length))
                            return;
                        if (!(__VLS_ctx.isCancelable(job.status)))
                            return;
                        __VLS_ctx.scenesStore.cancel(job.id);
                    } },
                ...{ class: "job-card__button job-card__button--warn" },
            });
        }
        __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
            ...{ onClick: (...[$event]) => {
                    if (!!(!__VLS_ctx.filteredJobs.length))
                        return;
                    __VLS_ctx.openJobSession(job.sessionId);
                } },
            ...{ class: "job-card__button" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
            ...{ onClick: (...[$event]) => {
                    if (!!(!__VLS_ctx.filteredJobs.length))
                        return;
                    __VLS_ctx.scenesStore.dismissJob(job.id);
                } },
            ...{ class: "job-card__button" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "job-card__timeline" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
        (__VLS_ctx.lifecycleLabel(job));
        if (job.completedAt) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
            (__VLS_ctx.formatTimestamp(job.completedAt));
        }
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
        (Math.round(job.progress.percent ?? 0));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "job-card__progress" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div)({
            ...{ class: "job-card__progress-bar" },
            ...{ style: ({ width: `${Math.max(0, Math.min(100, job.progress.percent ?? 0))}%` }) },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
            ...{ class: "job-card__message" },
        });
        (job.progress.message ?? 'Waiting for worker updates');
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "job-card__stats" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "job-card__stat" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "job-card__stat-label" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "job-card__stat-value" },
        });
        (job.progress.toolCallsCompleted);
        (job.progress.toolCallsRequested);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "job-card__stat" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "job-card__stat-label" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "job-card__stat-value" },
        });
        (job.progress.approvalsRequested);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "job-card__stat" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "job-card__stat-label" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "job-card__stat-value" },
        });
        (job.progress.subAgentsStarted);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "job-card__stat" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "job-card__stat-label" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "job-card__stat-value" },
        });
        (job.progress.swarmTasksCompleted);
        (job.progress.swarmTasksTotal);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "job-card__detail-row" },
        });
        if (job.progress.currentAgent) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
            (job.progress.currentAgent);
        }
        if (job.progress.currentTool) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
            (job.progress.currentTool);
        }
        if (job.performance) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
            (__VLS_ctx.formatDuration(job.performance.turnDurationMs));
        }
        if (job.error) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
                ...{ class: "job-card__error" },
            });
            (job.error);
        }
        else if (job.response) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
                ...{ class: "job-card__response" },
            });
            (job.response);
        }
    }
}
/** @type {__VLS_StyleScopedClasses['jobs-page']} */ ;
/** @type {__VLS_StyleScopedClasses['jobs-page__header']} */ ;
/** @type {__VLS_StyleScopedClasses['jobs-page__title']} */ ;
/** @type {__VLS_StyleScopedClasses['jobs-page__subtitle']} */ ;
/** @type {__VLS_StyleScopedClasses['jobs-page__actions']} */ ;
/** @type {__VLS_StyleScopedClasses['jobs-page__button']} */ ;
/** @type {__VLS_StyleScopedClasses['jobs-page__filters']} */ ;
/** @type {__VLS_StyleScopedClasses['jobs-page__search']} */ ;
/** @type {__VLS_StyleScopedClasses['jobs-page__select']} */ ;
/** @type {__VLS_StyleScopedClasses['jobs-page__empty']} */ ;
/** @type {__VLS_StyleScopedClasses['jobs-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['job-card__top']} */ ;
/** @type {__VLS_StyleScopedClasses['job-card__title-row']} */ ;
/** @type {__VLS_StyleScopedClasses['job-card__title']} */ ;
/** @type {__VLS_StyleScopedClasses['job-card__meta']} */ ;
/** @type {__VLS_StyleScopedClasses['job-card__actions']} */ ;
/** @type {__VLS_StyleScopedClasses['job-card__button']} */ ;
/** @type {__VLS_StyleScopedClasses['job-card__button--warn']} */ ;
/** @type {__VLS_StyleScopedClasses['job-card__button']} */ ;
/** @type {__VLS_StyleScopedClasses['job-card__button']} */ ;
/** @type {__VLS_StyleScopedClasses['job-card__timeline']} */ ;
/** @type {__VLS_StyleScopedClasses['job-card__progress']} */ ;
/** @type {__VLS_StyleScopedClasses['job-card__progress-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['job-card__message']} */ ;
/** @type {__VLS_StyleScopedClasses['job-card__stats']} */ ;
/** @type {__VLS_StyleScopedClasses['job-card__stat']} */ ;
/** @type {__VLS_StyleScopedClasses['job-card__stat-label']} */ ;
/** @type {__VLS_StyleScopedClasses['job-card__stat-value']} */ ;
/** @type {__VLS_StyleScopedClasses['job-card__stat']} */ ;
/** @type {__VLS_StyleScopedClasses['job-card__stat-label']} */ ;
/** @type {__VLS_StyleScopedClasses['job-card__stat-value']} */ ;
/** @type {__VLS_StyleScopedClasses['job-card__stat']} */ ;
/** @type {__VLS_StyleScopedClasses['job-card__stat-label']} */ ;
/** @type {__VLS_StyleScopedClasses['job-card__stat-value']} */ ;
/** @type {__VLS_StyleScopedClasses['job-card__stat']} */ ;
/** @type {__VLS_StyleScopedClasses['job-card__stat-label']} */ ;
/** @type {__VLS_StyleScopedClasses['job-card__stat-value']} */ ;
/** @type {__VLS_StyleScopedClasses['job-card__detail-row']} */ ;
/** @type {__VLS_StyleScopedClasses['job-card__error']} */ ;
/** @type {__VLS_StyleScopedClasses['job-card__response']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            scenesStore: scenesStore,
            searchQuery: searchQuery,
            statusFilter: statusFilter,
            filteredJobs: filteredJobs,
            refreshJobs: refreshJobs,
            openJobSession: openJobSession,
            isCancelable: isCancelable,
            formatSceneName: formatSceneName,
            shortJobId: shortJobId,
            formatTimestamp: formatTimestamp,
            lifecycleLabel: lifecycleLabel,
            formatDuration: formatDuration,
            jobBadgeClass: jobBadgeClass,
            jobToneClass: jobToneClass,
        };
    },
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
});
; /* PartiallyEnd: #4569/main.vue */
