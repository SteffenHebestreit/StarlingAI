/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { ref, computed, onMounted } from "vue";
import { useAuditStore } from "@/stores/audit";
const PERFORMANCE_THRESHOLDS = {
    slowTurnMs: 15_000,
    criticalTurnP95Ms: 30_000,
    slowFirstResponseMs: 5_000,
    criticalFirstResponseP95Ms: 10_000,
    highPromptChars: 12_000,
    criticalPromptChars: 20_000,
    toolHeavyCalls: 6,
};
const audit = useAuditStore();
const severityFilter = ref("");
const typeFilter = ref("");
const recentPerformanceEvents = computed(() => audit.events
    .filter((event) => event.type === "turn_performance")
    .slice(0, 25));
const performanceSummary = computed(() => {
    if (recentPerformanceEvents.value.length === 0)
        return null;
    const turnDurations = recentPerformanceEvents.value
        .map((event) => Number(event.data.turnDurationMs ?? 0))
        .filter((value) => Number.isFinite(value) && value > 0)
        .sort((left, right) => left - right);
    const firstResponses = recentPerformanceEvents.value
        .map((event) => Number(event.data.firstModelResponseMs ?? 0))
        .filter((value) => Number.isFinite(value) && value > 0);
    const promptChars = recentPerformanceEvents.value
        .map((event) => Number(event.data.promptChars ?? 0))
        .filter((value) => Number.isFinite(value) && value >= 0);
    const toolCalls = recentPerformanceEvents.value
        .map((event) => Number(event.data.toolCallsRequested ?? 0))
        .filter((value) => Number.isFinite(value) && value >= 0);
    const blockedTurns = recentPerformanceEvents.value.filter((event) => Boolean(event.data.blocked)).length;
    const maxIterationStops = recentPerformanceEvents.value.filter((event) => String(event.data.finishReason ?? "") === "max_tool_iterations").length;
    const slowTurns = turnDurations.filter((value) => value >= PERFORMANCE_THRESHOLDS.slowTurnMs).length;
    const slowFirstResponses = firstResponses.filter((value) => value >= PERFORMANCE_THRESHOLDS.slowFirstResponseMs).length;
    const promptHeavyTurns = promptChars.filter((value) => value >= PERFORMANCE_THRESHOLDS.highPromptChars).length;
    const toolHeavyTurns = toolCalls.filter((value) => value >= PERFORMANCE_THRESHOLDS.toolHeavyCalls).length;
    const avg = (values) => values.length > 0
        ? values.reduce((sum, value) => sum + value, 0) / values.length
        : 0;
    const percentile = (values, ratio) => {
        if (values.length === 0)
            return 0;
        const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * ratio) - 1));
        return values[index] ?? 0;
    };
    return {
        sampleSize: recentPerformanceEvents.value.length,
        sampleLabel: `${recentPerformanceEvents.value.length} performance events`,
        avgTurnDurationMs: avg(turnDurations),
        p95TurnDurationMs: percentile(turnDurations, 0.95),
        avgFirstResponseMs: avg(firstResponses),
        p95FirstResponseMs: percentile(firstResponses, 0.95),
        avgPromptChars: avg(promptChars),
        avgToolCalls: avg(toolCalls),
        slowTurns,
        slowFirstResponses,
        promptHeavyTurns,
        toolHeavyTurns,
        blockedTurns,
        maxIterationStops,
        reliabilityState: summarizeReliabilityState(blockedTurns, maxIterationStops),
        turnState: summarizeTurnState(percentile(turnDurations, 0.95), slowTurns, recentPerformanceEvents.value.length),
        responseState: summarizeResponseState(percentile(firstResponses, 0.95), slowFirstResponses, recentPerformanceEvents.value.length),
        promptState: summarizePromptState(avg(promptChars), promptHeavyTurns, toolHeavyTurns, recentPerformanceEvents.value.length),
    };
});
const filteredEvents = computed(() => audit.events.filter((event) => {
    if (severityFilter.value && event.severity !== severityFilter.value)
        return false;
    if (typeFilter.value && event.type !== typeFilter.value)
        return false;
    return true;
}));
function formatTs(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function summarizeEvent(event) {
    if (event.type === "agent_routing_evaluated") {
        const query = String(event.data.query ?? "");
        const topResult = String(event.data.topResult ?? "no match");
        const gated = Boolean(event.data.gated);
        if (gated) {
            return `Routing gated for \"${query}\". Top candidate was ${topResult}.`;
        }
        return `Resolved \"${query}\" to ${topResult}.`;
    }
    if (event.type === "channel_delivery_failed") {
        return `Channel delivery failed: ${String(event.data.error ?? "unknown error")}`;
    }
    if (event.type === "parallel_delegate_started") {
        return `Started a swarm run with ${Number(event.data.taskCount ?? 0)} parallel task(s).`;
    }
    if (event.type === "turn_performance") {
        const flags = performanceFlags(event.data);
        const flagged = flags.length > 0 ? ` Flags: ${flags.join(", ")}.` : "";
        return `Turn completed in ${formatDuration(event.data.turnDurationMs)} with ${Number(event.data.toolCallsRequested ?? 0)} tool call(s) and ${Number(event.data.promptChars ?? 0)} prompt chars.${flagged}`;
    }
    if (event.type === "scene_job_completed") {
        const flags = performanceFlags(event.data);
        const flagged = flags.length > 0 ? ` Flags: ${flags.join(", ")}.` : "";
        return `Scene ${String(event.data.sceneName ?? "unknown")} finished in ${formatDuration(event.data.turnDurationMs)} with ${Number(event.data.toolCallsExecuted ?? 0)} tool call(s).${flagged}`;
    }
    if (event.type === "scene_job_failed") {
        return `Scene ${String(event.data.sceneName ?? "unknown")} failed: ${String(event.data.error ?? "unknown error")}`;
    }
    if (event.type === "warden_alert") {
        return String(event.data.detail ?? "Warden flagged an operational issue.");
    }
    if (event.type === "tool_call_failed") {
        return `Tool ${String(event.data.tool ?? "unknown")} failed: ${String(event.data.error ?? event.data.reason ?? "unknown error")}`;
    }
    if (event.type === "tool_output_blocked") {
        return `Tool ${String(event.data.tool ?? "unknown")} output was blocked by guardrails.`;
    }
    if (event.type === "ephemeral_agent_rejected") {
        return `Rejected ephemeral agent ${String(event.data.agentName ?? "unknown")} due to policy constraints.`;
    }
    const json = JSON.stringify(event.data);
    return json.length > 140 ? `${json.slice(0, 140)}...` : json;
}
function formatAgentList(value) {
    if (!Array.isArray(value))
        return "none";
    const entries = value.map((item) => String(item)).filter(Boolean);
    return entries.length > 0 ? entries.join(", ") : "none";
}
function formatReasons(value) {
    if (!Array.isArray(value))
        return "No reason recorded.";
    const reasons = value.map((item) => String(item)).filter(Boolean);
    return reasons.length > 0 ? reasons.join(" ") : "No reason recorded.";
}
function formatEventData(data) {
    return JSON.stringify(data, null, 2);
}
function eventIntervention(event) {
    const raw = event.data.intervention;
    if (!raw || typeof raw !== "object")
        return null;
    const value = raw;
    if (typeof value.summary !== "string" || typeof value.detail !== "string")
        return null;
    return {
        summary: value.summary,
        detail: value.detail,
    };
}
function formatDuration(value) {
    const ms = Number(value ?? 0);
    if (!Number.isFinite(ms) || ms <= 0)
        return "n/a";
    if (ms < 1000)
        return `${Math.round(ms)} ms`;
    return `${(ms / 1000).toFixed(2)} s`;
}
function formatCompactNumber(value) {
    const num = Number(value ?? 0);
    if (!Number.isFinite(num) || num <= 0)
        return "0";
    if (num < 1000)
        return `${Math.round(num)}`;
    if (num < 1_000_000)
        return `${(num / 1000).toFixed(1)}k`;
    return `${(num / 1_000_000).toFixed(1)}m`;
}
function summarizeReliabilityState(blockedTurns, maxIterationStops) {
    if (blockedTurns >= 2 || maxIterationStops >= 2)
        return "regression";
    if (blockedTurns > 0 || maxIterationStops > 0)
        return "watch";
    return "healthy";
}
function summarizeTurnState(p95TurnDurationMs, slowTurns, sampleSize) {
    if (p95TurnDurationMs >= PERFORMANCE_THRESHOLDS.criticalTurnP95Ms || slowTurns >= Math.max(2, Math.ceil(sampleSize / 3))) {
        return "regression";
    }
    if (p95TurnDurationMs >= PERFORMANCE_THRESHOLDS.slowTurnMs || slowTurns > 0) {
        return "watch";
    }
    return "healthy";
}
function summarizeResponseState(p95FirstResponseMs, slowFirstResponses, sampleSize) {
    if (p95FirstResponseMs >= PERFORMANCE_THRESHOLDS.criticalFirstResponseP95Ms || slowFirstResponses >= Math.max(2, Math.ceil(sampleSize / 3))) {
        return "regression";
    }
    if (p95FirstResponseMs >= PERFORMANCE_THRESHOLDS.slowFirstResponseMs || slowFirstResponses > 0) {
        return "watch";
    }
    return "healthy";
}
function summarizePromptState(avgPromptChars, promptHeavyTurns, toolHeavyTurns, sampleSize) {
    if (avgPromptChars >= PERFORMANCE_THRESHOLDS.criticalPromptChars || promptHeavyTurns >= Math.max(2, Math.ceil(sampleSize / 3))) {
        return "regression";
    }
    if (avgPromptChars >= PERFORMANCE_THRESHOLDS.highPromptChars || promptHeavyTurns > 0 || toolHeavyTurns > 0) {
        return "watch";
    }
    return "healthy";
}
function performanceLabel(state) {
    if (state === "regression")
        return "Regression";
    if (state === "watch")
        return "Watch";
    return "Healthy";
}
function performanceCardClass(state) {
    if (state === "regression")
        return "border border-red-900/40 bg-red-950/20";
    if (state === "watch")
        return "border border-amber-900/40 bg-amber-950/20";
    return "border border-emerald-900/40 bg-emerald-950/20";
}
function performanceAccentClass(state) {
    if (state === "regression")
        return "text-red-300";
    if (state === "watch")
        return "text-amber-300";
    return "text-emerald-300";
}
function performanceBadgeClass(state) {
    if (state === "regression")
        return "rounded-full border border-red-800/60 bg-red-950/60 px-2 py-0.5 text-[10px] uppercase tracking-wide text-red-200";
    if (state === "watch")
        return "rounded-full border border-amber-800/60 bg-amber-950/60 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-200";
    return "rounded-full border border-emerald-800/60 bg-emerald-950/60 px-2 py-0.5 text-[10px] uppercase tracking-wide text-emerald-200";
}
function performanceFlags(data) {
    const flags = [];
    if (Number(data.turnDurationMs ?? 0) >= PERFORMANCE_THRESHOLDS.slowTurnMs)
        flags.push("slow turn");
    if (Number(data.firstModelResponseMs ?? 0) >= PERFORMANCE_THRESHOLDS.slowFirstResponseMs)
        flags.push("slow first response");
    if (Number(data.promptChars ?? 0) >= PERFORMANCE_THRESHOLDS.highPromptChars)
        flags.push("high prompt");
    if (Number(data.toolCallsRequested ?? 0) >= PERFORMANCE_THRESHOLDS.toolHeavyCalls)
        flags.push("tool-heavy");
    if (Boolean(data.blocked))
        flags.push("blocked");
    if (String(data.finishReason ?? "") === "max_tool_iterations")
        flags.push("max iterations");
    return flags;
}
function performanceDetailCardClass(data) {
    const flags = performanceFlags(data);
    if (flags.includes("blocked") || flags.includes("max iterations")) {
        return "border border-red-900/40 bg-red-950/20";
    }
    if (flags.length > 0) {
        return "border border-amber-900/40 bg-amber-950/20";
    }
    return "border border-gray-800 bg-black/20";
}
onMounted(() => audit.subscribe());
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "p-4 h-full overflow-hidden flex flex-col" },
    ...{ style: {} },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "flex items-center justify-between mb-4" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h2, __VLS_intrinsicElements.h2)({
    ...{ class: "font-semibold text-lg" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "flex gap-2" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.select, __VLS_intrinsicElements.select)({
    value: (__VLS_ctx.typeFilter),
    ...{ class: "bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
    value: "",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
    value: "agent_routing_evaluated",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
    value: "turn_performance",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
    value: "scene_job_completed",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
    value: "scene_job_failed",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
    value: "parallel_delegate_started",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
    value: "ephemeral_agent_rejected",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
    value: "channel_delivery_failed",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.select, __VLS_intrinsicElements.select)({
    value: (__VLS_ctx.severityFilter),
    ...{ class: "bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
    value: "",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
    value: "info",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
    value: "warn",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
    value: "error",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
    ...{ onClick: (...[$event]) => {
            __VLS_ctx.audit.clear();
        } },
    ...{ class: "px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-sm transition-colors" },
});
if (__VLS_ctx.performanceSummary) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "mb-4 grid gap-3 md:grid-cols-4" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: (['rounded-xl px-4 py-3', __VLS_ctx.performanceCardClass(__VLS_ctx.performanceSummary.reliabilityState)]) },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "flex items-center justify-between gap-3" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "text-[11px] uppercase tracking-wide" },
        ...{ class: (__VLS_ctx.performanceAccentClass(__VLS_ctx.performanceSummary.reliabilityState)) },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: (__VLS_ctx.performanceBadgeClass(__VLS_ctx.performanceSummary.reliabilityState)) },
    });
    (__VLS_ctx.performanceLabel(__VLS_ctx.performanceSummary.reliabilityState));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "mt-1 text-xl font-semibold text-white" },
    });
    (__VLS_ctx.performanceSummary.sampleSize);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "text-xs text-gray-400" },
    });
    (__VLS_ctx.performanceSummary.sampleLabel);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "mt-2 text-xs text-gray-300" },
    });
    (__VLS_ctx.performanceSummary.blockedTurns);
    (__VLS_ctx.performanceSummary.maxIterationStops);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: (['rounded-xl px-4 py-3', __VLS_ctx.performanceCardClass(__VLS_ctx.performanceSummary.turnState)]) },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "flex items-center justify-between gap-3" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "text-[11px] uppercase tracking-wide" },
        ...{ class: (__VLS_ctx.performanceAccentClass(__VLS_ctx.performanceSummary.turnState)) },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: (__VLS_ctx.performanceBadgeClass(__VLS_ctx.performanceSummary.turnState)) },
    });
    (__VLS_ctx.performanceLabel(__VLS_ctx.performanceSummary.turnState));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "mt-1 text-xl font-semibold text-white" },
    });
    (__VLS_ctx.formatDuration(__VLS_ctx.performanceSummary.avgTurnDurationMs));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "text-xs text-gray-400" },
    });
    (__VLS_ctx.formatDuration(__VLS_ctx.performanceSummary.p95TurnDurationMs));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "mt-2 text-xs text-gray-300" },
    });
    (__VLS_ctx.performanceSummary.slowTurns);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: (['rounded-xl px-4 py-3', __VLS_ctx.performanceCardClass(__VLS_ctx.performanceSummary.responseState)]) },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "flex items-center justify-between gap-3" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "text-[11px] uppercase tracking-wide" },
        ...{ class: (__VLS_ctx.performanceAccentClass(__VLS_ctx.performanceSummary.responseState)) },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: (__VLS_ctx.performanceBadgeClass(__VLS_ctx.performanceSummary.responseState)) },
    });
    (__VLS_ctx.performanceLabel(__VLS_ctx.performanceSummary.responseState));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "mt-1 text-xl font-semibold text-white" },
    });
    (__VLS_ctx.formatDuration(__VLS_ctx.performanceSummary.avgFirstResponseMs));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "text-xs text-gray-400" },
    });
    (__VLS_ctx.formatDuration(__VLS_ctx.performanceSummary.p95FirstResponseMs));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "mt-2 text-xs text-gray-300" },
    });
    (__VLS_ctx.performanceSummary.slowFirstResponses);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: (['rounded-xl px-4 py-3', __VLS_ctx.performanceCardClass(__VLS_ctx.performanceSummary.promptState)]) },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "flex items-center justify-between gap-3" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "text-[11px] uppercase tracking-wide" },
        ...{ class: (__VLS_ctx.performanceAccentClass(__VLS_ctx.performanceSummary.promptState)) },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: (__VLS_ctx.performanceBadgeClass(__VLS_ctx.performanceSummary.promptState)) },
    });
    (__VLS_ctx.performanceLabel(__VLS_ctx.performanceSummary.promptState));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "mt-1 text-xl font-semibold text-white" },
    });
    (__VLS_ctx.formatCompactNumber(__VLS_ctx.performanceSummary.avgPromptChars));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "text-xs text-gray-400" },
    });
    (__VLS_ctx.performanceSummary.avgToolCalls.toFixed(1));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "mt-2 text-xs text-gray-300" },
    });
    (__VLS_ctx.performanceSummary.promptHeavyTurns);
    (__VLS_ctx.performanceSummary.toolHeavyTurns);
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "flex-1 overflow-y-auto space-y-1 font-mono text-xs" },
});
if (!__VLS_ctx.filteredEvents.length) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "text-gray-600 text-center py-8" },
    });
}
for (const [ev] of __VLS_getVForSourceType((__VLS_ctx.filteredEvents))) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        key: (ev.id),
        ...{ class: ([
                'px-3 py-3 rounded border space-y-2',
                ev.severity === 'error' ? 'bg-red-950/40 border-red-900/50 text-red-300' :
                    ev.severity === 'warn' ? 'bg-yellow-950/40 border-yellow-900/50 text-yellow-300' :
                        'bg-gray-900 border-gray-800 text-gray-400'
            ]) },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "flex gap-3 items-start" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "text-gray-600 flex-shrink-0" },
    });
    (__VLS_ctx.formatTs(ev.timestamp));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: ([
                'flex-shrink-0 w-40',
                ev.severity === 'error' ? 'text-red-400' :
                    ev.severity === 'warn' ? 'text-yellow-400' : 'text-indigo-400'
            ]) },
    });
    (ev.type);
    if (ev.sessionId) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "text-gray-600 flex-shrink-0" },
        });
        (ev.sessionId.substring(0, 8));
    }
    if (ev.channel) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "text-gray-600 flex-shrink-0" },
        });
        (ev.channel);
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "pl-[10.5rem] sm:pl-[11.5rem]" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "text-gray-200 text-sm" },
    });
    (__VLS_ctx.summarizeEvent(ev));
    if (__VLS_ctx.eventIntervention(ev)) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "mt-2 rounded-lg border border-amber-900/40 bg-amber-950/20 px-3 py-2" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-[11px] uppercase tracking-wide text-amber-300" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "mt-1 text-gray-200" },
        });
        (__VLS_ctx.eventIntervention(ev)?.summary);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-gray-400" },
        });
        (__VLS_ctx.eventIntervention(ev)?.detail);
    }
    if (ev.type === 'agent_routing_evaluated') {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "mt-2 grid gap-2 md:grid-cols-2" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "rounded-lg border border-indigo-900/40 bg-indigo-950/20 px-3 py-2" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-[11px] uppercase tracking-wide text-indigo-300" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "mt-1 text-gray-300" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "text-white" },
        });
        (String(ev.data.query ?? ''));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-gray-400" },
        });
        (ev.data.mode ?? 'unknown');
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-gray-400" },
        });
        (ev.data.minConfidence ?? 'medium');
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-gray-400" },
        });
        (ev.data.topResult ?? 'none');
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "rounded-lg border border-gray-800 bg-black/20 px-3 py-2" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-[11px] uppercase tracking-wide text-gray-500" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "mt-1 text-gray-300" },
        });
        (ev.data.resultCount ?? 0);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-gray-300" },
        });
        (ev.data.weakCount ?? 0);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: (ev.data.gated ? 'text-amber-300' : 'text-gray-300') },
        });
        (ev.data.gated ? 'yes' : 'no');
    }
    else if (ev.type === 'parallel_delegate_started') {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "mt-2 rounded-lg border border-sky-900/40 bg-sky-950/20 px-3 py-2" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-[11px] uppercase tracking-wide text-sky-300" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "mt-1 text-gray-300" },
        });
        (Number(ev.data.taskCount ?? 0));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-gray-300" },
        });
        (__VLS_ctx.formatAgentList(ev.data.agents));
    }
    else if (ev.type === 'turn_performance') {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "mt-2 grid gap-2 md:grid-cols-2" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: (['rounded-lg px-3 py-2', __VLS_ctx.performanceDetailCardClass(ev.data)]) },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-[11px] uppercase tracking-wide text-emerald-300" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "mt-1 text-gray-300" },
        });
        (__VLS_ctx.formatDuration(ev.data.turnDurationMs));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-gray-300" },
        });
        (__VLS_ctx.formatDuration(ev.data.firstModelResponseMs));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-gray-300" },
        });
        (__VLS_ctx.formatDuration(ev.data.llmTimeMs));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-gray-300" },
        });
        (__VLS_ctx.formatDuration(ev.data.toolExecutionTimeMs));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: (['rounded-lg px-3 py-2', __VLS_ctx.performanceDetailCardClass(ev.data)]) },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-[11px] uppercase tracking-wide text-gray-500" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "mt-1 text-gray-300" },
        });
        (Number(ev.data.promptChars ?? 0));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-gray-300" },
        });
        (Number(ev.data.systemPromptChars ?? 0));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-gray-300" },
        });
        (Number(ev.data.collapsedHistoryMessages ?? 0));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-gray-300" },
        });
        (Number(ev.data.toolCallsRequested ?? 0));
        (Number(ev.data.toolIterations ?? 0));
        if (__VLS_ctx.performanceFlags(ev.data).length) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "mt-2 text-amber-300" },
            });
            (__VLS_ctx.performanceFlags(ev.data).join(' · '));
        }
    }
    else if (ev.type === 'scene_job_completed') {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "mt-2 grid gap-2 md:grid-cols-2" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: (['rounded-lg px-3 py-2', __VLS_ctx.performanceDetailCardClass(ev.data)]) },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-[11px] uppercase tracking-wide text-sky-300" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "mt-1 text-gray-300" },
        });
        (String(ev.data.sceneName ?? 'unknown'));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-gray-300" },
        });
        (String(ev.data.jobId ?? 'n/a'));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-gray-300" },
        });
        (String(ev.data.status ?? 'completed'));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-gray-300" },
        });
        (Number(ev.data.responseLength ?? 0));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: (['rounded-lg px-3 py-2', __VLS_ctx.performanceDetailCardClass(ev.data)]) },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-[11px] uppercase tracking-wide text-gray-500" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "mt-1 text-gray-300" },
        });
        (__VLS_ctx.formatDuration(ev.data.turnDurationMs));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-gray-300" },
        });
        (__VLS_ctx.formatDuration(ev.data.firstModelResponseMs));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-gray-300" },
        });
        (Number(ev.data.promptChars ?? 0));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-gray-300" },
        });
        (Number(ev.data.toolCallsRequested ?? 0));
        (Number(ev.data.toolCallsExecuted ?? 0));
        if (__VLS_ctx.performanceFlags(ev.data).length) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "mt-2 text-amber-300" },
            });
            (__VLS_ctx.performanceFlags(ev.data).join(' · '));
        }
    }
    else if (ev.type === 'scene_job_failed') {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "mt-2 rounded-lg border border-red-900/40 bg-red-950/20 px-3 py-2" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-[11px] uppercase tracking-wide text-red-300" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "mt-1 text-gray-300" },
        });
        (String(ev.data.sceneName ?? 'unknown'));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-gray-300" },
        });
        (String(ev.data.jobId ?? 'n/a'));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "mt-2 text-red-200" },
        });
        (String(ev.data.error ?? 'Unknown error'));
    }
    else if (ev.type === 'ephemeral_agent_rejected') {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "mt-2 grid gap-2 md:grid-cols-2" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "rounded-lg border border-amber-900/40 bg-amber-950/20 px-3 py-2" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-[11px] uppercase tracking-wide text-amber-300" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "mt-1 text-gray-200" },
        });
        (String(ev.data.agentName ?? 'unknown'));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-gray-400" },
        });
        (__VLS_ctx.formatAgentList(ev.data.grantedTools));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "rounded-lg border border-gray-800 bg-black/20 px-3 py-2" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "text-[11px] uppercase tracking-wide text-gray-500" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "mt-1 text-gray-300" },
        });
        (__VLS_ctx.formatReasons(ev.data.reasons));
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.details, __VLS_intrinsicElements.details)({
        ...{ class: "mt-2" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.summary, __VLS_intrinsicElements.summary)({
        ...{ class: "cursor-pointer text-gray-500 hover:text-gray-300 transition-colors" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.pre, __VLS_intrinsicElements.pre)({
        ...{ class: "mt-2 whitespace-pre-wrap break-words rounded-lg bg-black/20 border border-gray-800 p-3 text-[11px] text-gray-400" },
    });
    (__VLS_ctx.formatEventData(ev.data));
}
/** @type {__VLS_StyleScopedClasses['p-4']} */ ;
/** @type {__VLS_StyleScopedClasses['h-full']} */ ;
/** @type {__VLS_StyleScopedClasses['overflow-hidden']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['flex-col']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['mb-4']} */ ;
/** @type {__VLS_StyleScopedClasses['font-semibold']} */ ;
/** @type {__VLS_StyleScopedClasses['text-lg']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
/** @type {__VLS_StyleScopedClasses['bg-gray-800']} */ ;
/** @type {__VLS_StyleScopedClasses['border']} */ ;
/** @type {__VLS_StyleScopedClasses['border-gray-700']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded']} */ ;
/** @type {__VLS_StyleScopedClasses['px-2']} */ ;
/** @type {__VLS_StyleScopedClasses['py-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['bg-gray-800']} */ ;
/** @type {__VLS_StyleScopedClasses['border']} */ ;
/** @type {__VLS_StyleScopedClasses['border-gray-700']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded']} */ ;
/** @type {__VLS_StyleScopedClasses['px-2']} */ ;
/** @type {__VLS_StyleScopedClasses['py-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['px-3']} */ ;
/** @type {__VLS_StyleScopedClasses['py-1']} */ ;
/** @type {__VLS_StyleScopedClasses['bg-gray-700']} */ ;
/** @type {__VLS_StyleScopedClasses['hover:bg-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['transition-colors']} */ ;
/** @type {__VLS_StyleScopedClasses['mb-4']} */ ;
/** @type {__VLS_StyleScopedClasses['grid']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-3']} */ ;
/** @type {__VLS_StyleScopedClasses['md:grid-cols-4']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-3']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['uppercase']} */ ;
/** @type {__VLS_StyleScopedClasses['tracking-wide']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xl']} */ ;
/** @type {__VLS_StyleScopedClasses['font-semibold']} */ ;
/** @type {__VLS_StyleScopedClasses['text-white']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-400']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-3']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['uppercase']} */ ;
/** @type {__VLS_StyleScopedClasses['tracking-wide']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xl']} */ ;
/** @type {__VLS_StyleScopedClasses['font-semibold']} */ ;
/** @type {__VLS_StyleScopedClasses['text-white']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-400']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-3']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['uppercase']} */ ;
/** @type {__VLS_StyleScopedClasses['tracking-wide']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xl']} */ ;
/** @type {__VLS_StyleScopedClasses['font-semibold']} */ ;
/** @type {__VLS_StyleScopedClasses['text-white']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-400']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-between']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-3']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['uppercase']} */ ;
/** @type {__VLS_StyleScopedClasses['tracking-wide']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xl']} */ ;
/** @type {__VLS_StyleScopedClasses['font-semibold']} */ ;
/** @type {__VLS_StyleScopedClasses['text-white']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-400']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['flex-1']} */ ;
/** @type {__VLS_StyleScopedClasses['overflow-y-auto']} */ ;
/** @type {__VLS_StyleScopedClasses['space-y-1']} */ ;
/** @type {__VLS_StyleScopedClasses['font-mono']} */ ;
/** @type {__VLS_StyleScopedClasses['text-xs']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['text-center']} */ ;
/** @type {__VLS_StyleScopedClasses['py-8']} */ ;
/** @type {__VLS_StyleScopedClasses['flex']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-3']} */ ;
/** @type {__VLS_StyleScopedClasses['items-start']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['flex-shrink-0']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['flex-shrink-0']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-600']} */ ;
/** @type {__VLS_StyleScopedClasses['flex-shrink-0']} */ ;
/** @type {__VLS_StyleScopedClasses['pl-[10.5rem]']} */ ;
/** @type {__VLS_StyleScopedClasses['sm:pl-[11.5rem]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-200']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-2']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-lg']} */ ;
/** @type {__VLS_StyleScopedClasses['border']} */ ;
/** @type {__VLS_StyleScopedClasses['border-amber-900/40']} */ ;
/** @type {__VLS_StyleScopedClasses['bg-amber-950/20']} */ ;
/** @type {__VLS_StyleScopedClasses['px-3']} */ ;
/** @type {__VLS_StyleScopedClasses['py-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['uppercase']} */ ;
/** @type {__VLS_StyleScopedClasses['tracking-wide']} */ ;
/** @type {__VLS_StyleScopedClasses['text-amber-300']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-200']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-400']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-2']} */ ;
/** @type {__VLS_StyleScopedClasses['grid']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
/** @type {__VLS_StyleScopedClasses['md:grid-cols-2']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-lg']} */ ;
/** @type {__VLS_StyleScopedClasses['border']} */ ;
/** @type {__VLS_StyleScopedClasses['border-indigo-900/40']} */ ;
/** @type {__VLS_StyleScopedClasses['bg-indigo-950/20']} */ ;
/** @type {__VLS_StyleScopedClasses['px-3']} */ ;
/** @type {__VLS_StyleScopedClasses['py-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['uppercase']} */ ;
/** @type {__VLS_StyleScopedClasses['tracking-wide']} */ ;
/** @type {__VLS_StyleScopedClasses['text-indigo-300']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['text-white']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-400']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-400']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-400']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-lg']} */ ;
/** @type {__VLS_StyleScopedClasses['border']} */ ;
/** @type {__VLS_StyleScopedClasses['border-gray-800']} */ ;
/** @type {__VLS_StyleScopedClasses['bg-black/20']} */ ;
/** @type {__VLS_StyleScopedClasses['px-3']} */ ;
/** @type {__VLS_StyleScopedClasses['py-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['uppercase']} */ ;
/** @type {__VLS_StyleScopedClasses['tracking-wide']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-2']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-lg']} */ ;
/** @type {__VLS_StyleScopedClasses['border']} */ ;
/** @type {__VLS_StyleScopedClasses['border-sky-900/40']} */ ;
/** @type {__VLS_StyleScopedClasses['bg-sky-950/20']} */ ;
/** @type {__VLS_StyleScopedClasses['px-3']} */ ;
/** @type {__VLS_StyleScopedClasses['py-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['uppercase']} */ ;
/** @type {__VLS_StyleScopedClasses['tracking-wide']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sky-300']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-2']} */ ;
/** @type {__VLS_StyleScopedClasses['grid']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
/** @type {__VLS_StyleScopedClasses['md:grid-cols-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['uppercase']} */ ;
/** @type {__VLS_StyleScopedClasses['tracking-wide']} */ ;
/** @type {__VLS_StyleScopedClasses['text-emerald-300']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['uppercase']} */ ;
/** @type {__VLS_StyleScopedClasses['tracking-wide']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-amber-300']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-2']} */ ;
/** @type {__VLS_StyleScopedClasses['grid']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
/** @type {__VLS_StyleScopedClasses['md:grid-cols-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['uppercase']} */ ;
/** @type {__VLS_StyleScopedClasses['tracking-wide']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sky-300']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['uppercase']} */ ;
/** @type {__VLS_StyleScopedClasses['tracking-wide']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-amber-300']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-2']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-lg']} */ ;
/** @type {__VLS_StyleScopedClasses['border']} */ ;
/** @type {__VLS_StyleScopedClasses['border-red-900/40']} */ ;
/** @type {__VLS_StyleScopedClasses['bg-red-950/20']} */ ;
/** @type {__VLS_StyleScopedClasses['px-3']} */ ;
/** @type {__VLS_StyleScopedClasses['py-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['uppercase']} */ ;
/** @type {__VLS_StyleScopedClasses['tracking-wide']} */ ;
/** @type {__VLS_StyleScopedClasses['text-red-300']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-red-200']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-2']} */ ;
/** @type {__VLS_StyleScopedClasses['grid']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
/** @type {__VLS_StyleScopedClasses['md:grid-cols-2']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-lg']} */ ;
/** @type {__VLS_StyleScopedClasses['border']} */ ;
/** @type {__VLS_StyleScopedClasses['border-amber-900/40']} */ ;
/** @type {__VLS_StyleScopedClasses['bg-amber-950/20']} */ ;
/** @type {__VLS_StyleScopedClasses['px-3']} */ ;
/** @type {__VLS_StyleScopedClasses['py-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['uppercase']} */ ;
/** @type {__VLS_StyleScopedClasses['tracking-wide']} */ ;
/** @type {__VLS_StyleScopedClasses['text-amber-300']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-200']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-400']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-lg']} */ ;
/** @type {__VLS_StyleScopedClasses['border']} */ ;
/** @type {__VLS_StyleScopedClasses['border-gray-800']} */ ;
/** @type {__VLS_StyleScopedClasses['bg-black/20']} */ ;
/** @type {__VLS_StyleScopedClasses['px-3']} */ ;
/** @type {__VLS_StyleScopedClasses['py-2']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['uppercase']} */ ;
/** @type {__VLS_StyleScopedClasses['tracking-wide']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-2']} */ ;
/** @type {__VLS_StyleScopedClasses['cursor-pointer']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-500']} */ ;
/** @type {__VLS_StyleScopedClasses['hover:text-gray-300']} */ ;
/** @type {__VLS_StyleScopedClasses['transition-colors']} */ ;
/** @type {__VLS_StyleScopedClasses['mt-2']} */ ;
/** @type {__VLS_StyleScopedClasses['whitespace-pre-wrap']} */ ;
/** @type {__VLS_StyleScopedClasses['break-words']} */ ;
/** @type {__VLS_StyleScopedClasses['rounded-lg']} */ ;
/** @type {__VLS_StyleScopedClasses['bg-black/20']} */ ;
/** @type {__VLS_StyleScopedClasses['border']} */ ;
/** @type {__VLS_StyleScopedClasses['border-gray-800']} */ ;
/** @type {__VLS_StyleScopedClasses['p-3']} */ ;
/** @type {__VLS_StyleScopedClasses['text-[11px]']} */ ;
/** @type {__VLS_StyleScopedClasses['text-gray-400']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            audit: audit,
            severityFilter: severityFilter,
            typeFilter: typeFilter,
            performanceSummary: performanceSummary,
            filteredEvents: filteredEvents,
            formatTs: formatTs,
            summarizeEvent: summarizeEvent,
            formatAgentList: formatAgentList,
            formatReasons: formatReasons,
            formatEventData: formatEventData,
            eventIntervention: eventIntervention,
            formatDuration: formatDuration,
            formatCompactNumber: formatCompactNumber,
            performanceLabel: performanceLabel,
            performanceCardClass: performanceCardClass,
            performanceAccentClass: performanceAccentClass,
            performanceBadgeClass: performanceBadgeClass,
            performanceFlags: performanceFlags,
            performanceDetailCardClass: performanceDetailCardClass,
        };
    },
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
});
; /* PartiallyEnd: #4569/main.vue */
