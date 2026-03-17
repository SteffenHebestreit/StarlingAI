/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import SwarmStatusPanel from "@/components/SwarmStatusPanel.vue";
import { useGatewayStore } from "@/stores/gateway";
const gateway = useGatewayStore();
const route = useRoute();
const router = useRouter();
const sessions = ref([]);
const selectedSessionId = ref(null);
const selectedRunId = ref(null);
const searchQuery = ref("");
const statusFilter = ref("all");
const sessionCards = computed(() => {
    const activeById = new Map(sessions.value.map((session) => [session.id, session]));
    const ids = new Set([
        ...sessions.value.map((session) => session.id),
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
            isActive: Boolean(activeSession),
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
        if (statusFilter.value === "active" && !session.isActive)
            return false;
        if (statusFilter.value === "archived" && session.isActive)
            return false;
        if (statusFilter.value === "has-runs" && session.runCount === 0)
            return false;
        if (["ok", "blocked", "error"].includes(statusFilter.value) && session.lastStatus !== statusFilter.value)
            return false;
        if (!query)
            return true;
        return [
            session.id,
            session.channel ?? "",
            session.lastObjective ?? "",
            session.lastStatus ?? "",
        ].some((value) => value.toLowerCase().includes(query));
    });
});
const selectedRuns = computed(() => gateway.getSwarmRuns(selectedSessionId.value));
const selectedRun = computed(() => {
    if (!selectedRuns.value.length)
        return null;
    if (selectedRunId.value) {
        const matched = selectedRuns.value.find((run) => run.id === selectedRunId.value);
        if (matched)
            return matched;
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
    const result = await gateway.rpc("session.list");
    sessions.value = result;
    ensureSelection();
}
async function removeSession(sessionId) {
    await gateway.deleteSession(sessionId);
    // Remove from local sessions list too
    sessions.value = sessions.value.filter(s => s.id !== sessionId);
    if (selectedSessionId.value === sessionId) {
        selectedSessionId.value = null;
        selectedRunId.value = null;
    }
    ensureSelection();
}
async function clearArchivedSessions() {
    const archived = filteredSessionCards.value.filter(s => !s.isActive);
    for (const s of archived) {
        await gateway.deleteSession(s.id);
    }
    sessions.value = sessions.value.filter(s => archived.every(a => a.id !== s.id));
    ensureSelection();
}
function selectSession(id) {
    selectedSessionId.value = id;
    const runs = gateway.getSwarmRuns(id);
    selectedRunId.value = runs[runs.length - 1]?.id ?? null;
}
function selectRun(runId) {
    selectedRunId.value = runId;
}
function syncRouteSelection() {
    const nextSessionId = selectedSessionId.value ?? undefined;
    const nextRunId = selectedRunId.value ?? undefined;
    const currentSessionId = typeof route.query.sessionId === "string" ? route.query.sessionId : undefined;
    const currentRunId = typeof route.query.runId === "string" ? route.query.runId : undefined;
    if (currentSessionId === nextSessionId && currentRunId === nextRunId)
        return;
    const nextQuery = { ...route.query };
    if (nextSessionId)
        nextQuery.sessionId = nextSessionId;
    else
        delete nextQuery.sessionId;
    if (nextRunId)
        nextQuery.runId = nextRunId;
    else
        delete nextQuery.runId;
    router.replace({
        path: "/sessions",
        query: nextQuery,
    });
}
function formatDate(value) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime()))
        return "unknown";
    return parsed.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
watch(() => gateway.swarmSessionHistory, ensureSelection, { deep: true });
watch(filteredSessionCards, ensureSelection, { deep: true });
watch(() => route.query, ensureSelection, { deep: true });
watch([selectedSessionId, selectedRunId], syncRouteSelection);
onMounted(refresh);
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['sessions-page__clear']} */ ;
/** @type {__VLS_StyleScopedClasses['sessions-page__clear']} */ ;
/** @type {__VLS_StyleScopedClasses['sessions-filters__search']} */ ;
/** @type {__VLS_StyleScopedClasses['sessions-filters__select']} */ ;
/** @type {__VLS_StyleScopedClasses['session-card']} */ ;
/** @type {__VLS_StyleScopedClasses['session-card__top']} */ ;
/** @type {__VLS_StyleScopedClasses['session-card__delete']} */ ;
/** @type {__VLS_StyleScopedClasses['session-card__meta']} */ ;
/** @type {__VLS_StyleScopedClasses['session-card__history']} */ ;
/** @type {__VLS_StyleScopedClasses['sessions-layout']} */ ;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "sessions-page" },
    ...{ style: {} },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "sessions-page__header" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h2, __VLS_intrinsicElements.h2)({
    ...{ class: "sessions-page__title" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
    ...{ class: "sessions-page__subtitle" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "sessions-page__actions" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
    ...{ onClick: (__VLS_ctx.clearArchivedSessions) },
    ...{ class: "sessions-page__clear" },
    title: "Remove all archived session history",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
    ...{ onClick: (__VLS_ctx.refresh) },
    ...{ class: "sessions-page__refresh" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "sessions-filters" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.input, __VLS_intrinsicElements.input)({
    type: "search",
    ...{ class: "sessions-filters__search" },
    placeholder: "Search sessions or mission objectives",
});
(__VLS_ctx.searchQuery);
__VLS_asFunctionalElement(__VLS_intrinsicElements.select, __VLS_intrinsicElements.select)({
    value: (__VLS_ctx.statusFilter),
    ...{ class: "sessions-filters__select" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
    value: "all",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
    value: "active",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
    value: "archived",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
    value: "has-runs",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
    value: "ok",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
    value: "blocked",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
    value: "error",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "sessions-layout" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.section, __VLS_intrinsicElements.section)({
    ...{ class: "sessions-list" },
});
if (!__VLS_ctx.filteredSessionCards.length) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "sessions-list__empty" },
    });
}
for (const [session] of __VLS_getVForSourceType((__VLS_ctx.filteredSessionCards))) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ onClick: (...[$event]) => {
                __VLS_ctx.selectSession(session.id);
            } },
        key: (session.id),
        ...{ class: (['session-card', __VLS_ctx.selectedSessionId === session.id && 'session-card--active']) },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "session-card__top" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "session-card__id" },
    });
    (session.id.substring(0, 12));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "session-card__top-right" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: (['session-card__badge', session.isActive ? 'session-card__badge--active' : 'session-card__badge--archived']) },
    });
    (session.isActive ? 'Active' : 'Archived');
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                __VLS_ctx.removeSession(session.id);
            } },
        ...{ class: "session-card__delete" },
        title: (session.isActive ? 'End and remove session' : 'Remove session history'),
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "session-card__meta" },
    });
    if (session.channel) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
        (session.channel);
    }
    if (session.createdAt) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
        (__VLS_ctx.formatDate(session.createdAt));
    }
    if (session.turns !== null) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
        (session.turns);
    }
    if (session.runCount > 0) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "session-card__history" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: (['session-card__status', `session-card__status--${session.lastStatus}`]) },
        });
        (session.lastStatus);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
        (session.runCount);
        (session.runCount === 1 ? '' : 's');
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
        (session.lastRecordedAt ? __VLS_ctx.formatDate(session.lastRecordedAt) : 'unknown');
    }
    if (session.lastObjective) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "session-card__objective" },
        });
        (session.lastObjective);
    }
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.section, __VLS_intrinsicElements.section)({
    ...{ class: "sessions-preview" },
});
if (__VLS_ctx.selectedRun) {
    /** @type {[typeof SwarmStatusPanel, ]} */ ;
    // @ts-ignore
    const __VLS_0 = __VLS_asFunctionalComponent(SwarmStatusPanel, new SwarmStatusPanel({
        ...{ 'onSelectRun': {} },
        state: (__VLS_ctx.selectedRun.state),
        runs: (__VLS_ctx.selectedRuns),
        selectedRunId: (__VLS_ctx.selectedRunId),
    }));
    const __VLS_1 = __VLS_0({
        ...{ 'onSelectRun': {} },
        state: (__VLS_ctx.selectedRun.state),
        runs: (__VLS_ctx.selectedRuns),
        selectedRunId: (__VLS_ctx.selectedRunId),
    }, ...__VLS_functionalComponentArgsRest(__VLS_0));
    let __VLS_3;
    let __VLS_4;
    let __VLS_5;
    const __VLS_6 = {
        onSelectRun: (__VLS_ctx.selectRun)
    };
    var __VLS_2;
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "sessions-preview__empty" },
    });
}
/** @type {__VLS_StyleScopedClasses['sessions-page']} */ ;
/** @type {__VLS_StyleScopedClasses['sessions-page__header']} */ ;
/** @type {__VLS_StyleScopedClasses['sessions-page__title']} */ ;
/** @type {__VLS_StyleScopedClasses['sessions-page__subtitle']} */ ;
/** @type {__VLS_StyleScopedClasses['sessions-page__actions']} */ ;
/** @type {__VLS_StyleScopedClasses['sessions-page__clear']} */ ;
/** @type {__VLS_StyleScopedClasses['sessions-page__refresh']} */ ;
/** @type {__VLS_StyleScopedClasses['sessions-filters']} */ ;
/** @type {__VLS_StyleScopedClasses['sessions-filters__search']} */ ;
/** @type {__VLS_StyleScopedClasses['sessions-filters__select']} */ ;
/** @type {__VLS_StyleScopedClasses['sessions-layout']} */ ;
/** @type {__VLS_StyleScopedClasses['sessions-list']} */ ;
/** @type {__VLS_StyleScopedClasses['sessions-list__empty']} */ ;
/** @type {__VLS_StyleScopedClasses['session-card__top']} */ ;
/** @type {__VLS_StyleScopedClasses['session-card__id']} */ ;
/** @type {__VLS_StyleScopedClasses['session-card__top-right']} */ ;
/** @type {__VLS_StyleScopedClasses['session-card__delete']} */ ;
/** @type {__VLS_StyleScopedClasses['session-card__meta']} */ ;
/** @type {__VLS_StyleScopedClasses['session-card__history']} */ ;
/** @type {__VLS_StyleScopedClasses['session-card__objective']} */ ;
/** @type {__VLS_StyleScopedClasses['sessions-preview']} */ ;
/** @type {__VLS_StyleScopedClasses['sessions-preview__empty']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            SwarmStatusPanel: SwarmStatusPanel,
            selectedSessionId: selectedSessionId,
            selectedRunId: selectedRunId,
            searchQuery: searchQuery,
            statusFilter: statusFilter,
            filteredSessionCards: filteredSessionCards,
            selectedRuns: selectedRuns,
            selectedRun: selectedRun,
            refresh: refresh,
            removeSession: removeSession,
            clearArchivedSessions: clearArchivedSessions,
            selectSession: selectSession,
            selectRun: selectRun,
            formatDate: formatDate,
        };
    },
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
});
; /* PartiallyEnd: #4569/main.vue */
