<template>
  <div class="p-4 h-full overflow-hidden flex flex-col" style="height: calc(100vh - 57px)">
    <div class="flex items-center justify-between mb-4">
      <h2 class="font-semibold text-lg">Audit Log</h2>
      <div class="flex gap-2">
        <select v-model="typeFilter" class="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm">
          <option value="">All Events</option>
          <option value="agent_routing_evaluated">Routing</option>
          <option value="turn_performance">Turn Performance</option>
          <option value="scene_job_completed">Scene Jobs</option>
          <option value="scene_job_failed">Scene Failures</option>
          <option value="parallel_delegate_started">Swarm Runs</option>
          <option value="ephemeral_agent_rejected">Factory Rejections</option>
          <option value="channel_delivery_failed">Channel Failures</option>
        </select>
        <select v-model="severityFilter" class="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm">
          <option value="">All</option>
          <option value="info">Info</option>
          <option value="warn">Warn</option>
          <option value="error">Error</option>
        </select>
        <button @click="audit.clear()" class="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-sm transition-colors">
          Clear
        </button>
      </div>
    </div>

    <div v-if="performanceSummary" class="mb-4 grid gap-3 md:grid-cols-4">
      <div :class="['rounded-xl px-4 py-3', performanceCardClass(performanceSummary.reliabilityState)]">
        <div class="flex items-center justify-between gap-3">
          <div class="text-[11px] uppercase tracking-wide" :class="performanceAccentClass(performanceSummary.reliabilityState)">Recent Turns</div>
          <span :class="performanceBadgeClass(performanceSummary.reliabilityState)">{{ performanceLabel(performanceSummary.reliabilityState) }}</span>
        </div>
        <div class="mt-1 text-xl font-semibold text-white">{{ performanceSummary.sampleSize }}</div>
        <div class="text-xs text-gray-400">Latest {{ performanceSummary.sampleLabel }}</div>
        <div class="mt-2 text-xs text-gray-300">Blocked {{ performanceSummary.blockedTurns }} · Max-iter {{ performanceSummary.maxIterationStops }}</div>
      </div>
      <div :class="['rounded-xl px-4 py-3', performanceCardClass(performanceSummary.turnState)]">
        <div class="flex items-center justify-between gap-3">
          <div class="text-[11px] uppercase tracking-wide" :class="performanceAccentClass(performanceSummary.turnState)">Avg Turn</div>
          <span :class="performanceBadgeClass(performanceSummary.turnState)">{{ performanceLabel(performanceSummary.turnState) }}</span>
        </div>
        <div class="mt-1 text-xl font-semibold text-white">{{ formatDuration(performanceSummary.avgTurnDurationMs) }}</div>
        <div class="text-xs text-gray-400">P95 {{ formatDuration(performanceSummary.p95TurnDurationMs) }}</div>
        <div class="mt-2 text-xs text-gray-300">Slow turns {{ performanceSummary.slowTurns }}</div>
      </div>
      <div :class="['rounded-xl px-4 py-3', performanceCardClass(performanceSummary.responseState)]">
        <div class="flex items-center justify-between gap-3">
          <div class="text-[11px] uppercase tracking-wide" :class="performanceAccentClass(performanceSummary.responseState)">First Response</div>
          <span :class="performanceBadgeClass(performanceSummary.responseState)">{{ performanceLabel(performanceSummary.responseState) }}</span>
        </div>
        <div class="mt-1 text-xl font-semibold text-white">{{ formatDuration(performanceSummary.avgFirstResponseMs) }}</div>
        <div class="text-xs text-gray-400">P95 {{ formatDuration(performanceSummary.p95FirstResponseMs) }}</div>
        <div class="mt-2 text-xs text-gray-300">Slow responses {{ performanceSummary.slowFirstResponses }}</div>
      </div>
      <div :class="['rounded-xl px-4 py-3', performanceCardClass(performanceSummary.promptState)]">
        <div class="flex items-center justify-between gap-3">
          <div class="text-[11px] uppercase tracking-wide" :class="performanceAccentClass(performanceSummary.promptState)">Prompt Budget</div>
          <span :class="performanceBadgeClass(performanceSummary.promptState)">{{ performanceLabel(performanceSummary.promptState) }}</span>
        </div>
        <div class="mt-1 text-xl font-semibold text-white">{{ formatCompactNumber(performanceSummary.avgPromptChars) }}</div>
        <div class="text-xs text-gray-400">Tools/turn {{ performanceSummary.avgToolCalls.toFixed(1) }}</div>
        <div class="mt-2 text-xs text-gray-300">High prompt {{ performanceSummary.promptHeavyTurns }} · Tool-heavy {{ performanceSummary.toolHeavyTurns }}</div>
      </div>
    </div>

    <div class="flex-1 overflow-y-auto space-y-1 font-mono text-xs">
      <div v-if="!filteredEvents.length" class="text-gray-600 text-center py-8">
        No audit events yet. Start chatting to see events here.
      </div>
      <div
        v-for="ev in filteredEvents"
        :key="ev.id"
        :class="[
          'px-3 py-3 rounded border space-y-2',
          ev.severity === 'error' ? 'bg-red-950/40 border-red-900/50 text-red-300' :
          ev.severity === 'warn' ? 'bg-yellow-950/40 border-yellow-900/50 text-yellow-300' :
          'bg-gray-900 border-gray-800 text-gray-400'
        ]"
      >
        <div class="flex gap-3 items-start">
          <span class="text-gray-600 flex-shrink-0">{{ formatTs(ev.timestamp) }}</span>
          <span :class="[
            'flex-shrink-0 w-40',
            ev.severity === 'error' ? 'text-red-400' :
            ev.severity === 'warn' ? 'text-yellow-400' : 'text-indigo-400'
          ]">{{ ev.type }}</span>
          <span v-if="ev.sessionId" class="text-gray-600 flex-shrink-0">{{ ev.sessionId.substring(0, 8) }}</span>
          <span v-if="ev.channel" class="text-gray-600 flex-shrink-0">{{ ev.channel }}</span>
        </div>

        <div class="pl-[10.5rem] sm:pl-[11.5rem]">
          <div class="text-gray-200 text-sm">{{ summarizeEvent(ev) }}</div>

          <div v-if="eventIntervention(ev)" class="mt-2 rounded-lg border border-amber-900/40 bg-amber-950/20 px-3 py-2">
            <div class="text-[11px] uppercase tracking-wide text-amber-300">Suggested Action</div>
            <div class="mt-1 text-gray-200">{{ eventIntervention(ev)?.summary }}</div>
            <div class="text-gray-400">{{ eventIntervention(ev)?.detail }}</div>
          </div>

          <div v-if="ev.type === 'agent_routing_evaluated'" class="mt-2 grid gap-2 md:grid-cols-2">
            <div class="rounded-lg border border-indigo-900/40 bg-indigo-950/20 px-3 py-2">
              <div class="text-[11px] uppercase tracking-wide text-indigo-300">Routing</div>
              <div class="mt-1 text-gray-300">Query: <span class="text-white">{{ String(ev.data.query ?? '') }}</span></div>
              <div class="text-gray-400">Mode: {{ ev.data.mode ?? 'unknown' }}</div>
              <div class="text-gray-400">Min confidence: {{ ev.data.minConfidence ?? 'medium' }}</div>
              <div class="text-gray-400">Top result: {{ ev.data.topResult ?? 'none' }}</div>
            </div>
            <div class="rounded-lg border border-gray-800 bg-black/20 px-3 py-2">
              <div class="text-[11px] uppercase tracking-wide text-gray-500">Outcome</div>
              <div class="mt-1 text-gray-300">Accepted: {{ ev.data.resultCount ?? 0 }}</div>
              <div class="text-gray-300">Weak: {{ ev.data.weakCount ?? 0 }}</div>
              <div :class="ev.data.gated ? 'text-amber-300' : 'text-gray-300'">Gated: {{ ev.data.gated ? 'yes' : 'no' }}</div>
            </div>
          </div>

          <div v-else-if="ev.type === 'parallel_delegate_started'" class="mt-2 rounded-lg border border-sky-900/40 bg-sky-950/20 px-3 py-2">
            <div class="text-[11px] uppercase tracking-wide text-sky-300">Swarm Launch</div>
            <div class="mt-1 text-gray-300">Tasks: {{ Number(ev.data.taskCount ?? 0) }}</div>
            <div class="text-gray-300">Agents: {{ formatAgentList(ev.data.agents) }}</div>
          </div>

          <div v-else-if="ev.type === 'turn_performance'" class="mt-2 grid gap-2 md:grid-cols-2">
            <div :class="['rounded-lg px-3 py-2', performanceDetailCardClass(ev.data)]">
              <div class="text-[11px] uppercase tracking-wide text-emerald-300">Latency</div>
              <div class="mt-1 text-gray-300">Turn: {{ formatDuration(ev.data.turnDurationMs) }}</div>
              <div class="text-gray-300">First model response: {{ formatDuration(ev.data.firstModelResponseMs) }}</div>
              <div class="text-gray-300">Model time: {{ formatDuration(ev.data.llmTimeMs) }}</div>
              <div class="text-gray-300">Tool time: {{ formatDuration(ev.data.toolExecutionTimeMs) }}</div>
            </div>
            <div :class="['rounded-lg px-3 py-2', performanceDetailCardClass(ev.data)]">
              <div class="text-[11px] uppercase tracking-wide text-gray-500">Prompt Budget</div>
              <div class="mt-1 text-gray-300">Prompt chars: {{ Number(ev.data.promptChars ?? 0) }}</div>
              <div class="text-gray-300">System chars: {{ Number(ev.data.systemPromptChars ?? 0) }}</div>
              <div class="text-gray-300">History messages: {{ Number(ev.data.collapsedHistoryMessages ?? 0) }}</div>
              <div class="text-gray-300">Tools: {{ Number(ev.data.toolCallsRequested ?? 0) }} requested / {{ Number(ev.data.toolIterations ?? 0) }} iterations</div>
              <div v-if="performanceFlags(ev.data).length" class="mt-2 text-amber-300">Flags: {{ performanceFlags(ev.data).join(' · ') }}</div>
            </div>
          </div>

          <div v-else-if="ev.type === 'scene_job_completed'" class="mt-2 grid gap-2 md:grid-cols-2">
            <div :class="['rounded-lg px-3 py-2', performanceDetailCardClass(ev.data)]">
              <div class="text-[11px] uppercase tracking-wide text-sky-300">Scene Job</div>
              <div class="mt-1 text-gray-300">Scene: {{ String(ev.data.sceneName ?? 'unknown') }}</div>
              <div class="text-gray-300">Job: {{ String(ev.data.jobId ?? 'n/a') }}</div>
              <div class="text-gray-300">Status: {{ String(ev.data.status ?? 'completed') }}</div>
              <div class="text-gray-300">Response chars: {{ Number(ev.data.responseLength ?? 0) }}</div>
            </div>
            <div :class="['rounded-lg px-3 py-2', performanceDetailCardClass(ev.data)]">
              <div class="text-[11px] uppercase tracking-wide text-gray-500">Performance</div>
              <div class="mt-1 text-gray-300">Turn: {{ formatDuration(ev.data.turnDurationMs) }}</div>
              <div class="text-gray-300">First response: {{ formatDuration(ev.data.firstModelResponseMs) }}</div>
              <div class="text-gray-300">Prompt chars: {{ Number(ev.data.promptChars ?? 0) }}</div>
              <div class="text-gray-300">Tools: {{ Number(ev.data.toolCallsRequested ?? 0) }} requested / {{ Number(ev.data.toolCallsExecuted ?? 0) }} executed</div>
              <div v-if="performanceFlags(ev.data).length" class="mt-2 text-amber-300">Flags: {{ performanceFlags(ev.data).join(' · ') }}</div>
            </div>
          </div>

          <div v-else-if="ev.type === 'scene_job_failed'" class="mt-2 rounded-lg border border-red-900/40 bg-red-950/20 px-3 py-2">
            <div class="text-[11px] uppercase tracking-wide text-red-300">Scene Failure</div>
            <div class="mt-1 text-gray-300">Scene: {{ String(ev.data.sceneName ?? 'unknown') }}</div>
            <div class="text-gray-300">Job: {{ String(ev.data.jobId ?? 'n/a') }}</div>
            <div class="mt-2 text-red-200">{{ String(ev.data.error ?? 'Unknown error') }}</div>
          </div>

          <div v-else-if="ev.type === 'ephemeral_agent_rejected'" class="mt-2 grid gap-2 md:grid-cols-2">
            <div class="rounded-lg border border-amber-900/40 bg-amber-950/20 px-3 py-2">
              <div class="text-[11px] uppercase tracking-wide text-amber-300">Rejected Agent</div>
              <div class="mt-1 text-gray-200">{{ String(ev.data.agentName ?? 'unknown') }}</div>
              <div class="text-gray-400">Granted: {{ formatAgentList(ev.data.grantedTools) }}</div>
            </div>
            <div class="rounded-lg border border-gray-800 bg-black/20 px-3 py-2">
              <div class="text-[11px] uppercase tracking-wide text-gray-500">Reason</div>
              <div class="mt-1 text-gray-300">{{ formatReasons(ev.data.reasons) }}</div>
            </div>
          </div>

          <details class="mt-2">
            <summary class="cursor-pointer text-gray-500 hover:text-gray-300 transition-colors">Details</summary>
            <pre class="mt-2 whitespace-pre-wrap break-words rounded-lg bg-black/20 border border-gray-800 p-3 text-[11px] text-gray-400">{{ formatEventData(ev.data) }}</pre>
          </details>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useAuditStore, type AuditEvent } from "@/stores/audit";

type PerformanceState = "healthy" | "watch" | "regression";

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
  if (recentPerformanceEvents.value.length === 0) return null;

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

  const avg = (values: number[]) => values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
  const percentile = (values: number[], ratio: number) => {
    if (values.length === 0) return 0;
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
  if (severityFilter.value && event.severity !== severityFilter.value) return false;
  if (typeFilter.value && event.type !== typeFilter.value) return false;
  return true;
}));

function formatTs(ts: string): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function summarizeEvent(event: AuditEvent): string {
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

function formatAgentList(value: unknown): string {
  if (!Array.isArray(value)) return "none";
  const entries = value.map((item) => String(item)).filter(Boolean);
  return entries.length > 0 ? entries.join(", ") : "none";
}

function formatReasons(value: unknown): string {
  if (!Array.isArray(value)) return "No reason recorded.";
  const reasons = value.map((item) => String(item)).filter(Boolean);
  return reasons.length > 0 ? reasons.join(" ") : "No reason recorded.";
}

function formatEventData(data: Record<string, unknown>): string {
  return JSON.stringify(data, null, 2);
}

function eventIntervention(event: AuditEvent): { summary: string; detail: string } | null {
  const raw = event.data.intervention;
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.summary !== "string" || typeof value.detail !== "string") return null;
  return {
    summary: value.summary,
    detail: value.detail,
  };
}

function formatDuration(value: unknown): string {
  const ms = Number(value ?? 0);
  if (!Number.isFinite(ms) || ms <= 0) return "n/a";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function formatCompactNumber(value: unknown): string {
  const num = Number(value ?? 0);
  if (!Number.isFinite(num) || num <= 0) return "0";
  if (num < 1000) return `${Math.round(num)}`;
  if (num < 1_000_000) return `${(num / 1000).toFixed(1)}k`;
  return `${(num / 1_000_000).toFixed(1)}m`;
}

function summarizeReliabilityState(blockedTurns: number, maxIterationStops: number): PerformanceState {
  if (blockedTurns >= 2 || maxIterationStops >= 2) return "regression";
  if (blockedTurns > 0 || maxIterationStops > 0) return "watch";
  return "healthy";
}

function summarizeTurnState(p95TurnDurationMs: number, slowTurns: number, sampleSize: number): PerformanceState {
  if (p95TurnDurationMs >= PERFORMANCE_THRESHOLDS.criticalTurnP95Ms || slowTurns >= Math.max(2, Math.ceil(sampleSize / 3))) {
    return "regression";
  }
  if (p95TurnDurationMs >= PERFORMANCE_THRESHOLDS.slowTurnMs || slowTurns > 0) {
    return "watch";
  }
  return "healthy";
}

function summarizeResponseState(p95FirstResponseMs: number, slowFirstResponses: number, sampleSize: number): PerformanceState {
  if (p95FirstResponseMs >= PERFORMANCE_THRESHOLDS.criticalFirstResponseP95Ms || slowFirstResponses >= Math.max(2, Math.ceil(sampleSize / 3))) {
    return "regression";
  }
  if (p95FirstResponseMs >= PERFORMANCE_THRESHOLDS.slowFirstResponseMs || slowFirstResponses > 0) {
    return "watch";
  }
  return "healthy";
}

function summarizePromptState(avgPromptChars: number, promptHeavyTurns: number, toolHeavyTurns: number, sampleSize: number): PerformanceState {
  if (avgPromptChars >= PERFORMANCE_THRESHOLDS.criticalPromptChars || promptHeavyTurns >= Math.max(2, Math.ceil(sampleSize / 3))) {
    return "regression";
  }
  if (avgPromptChars >= PERFORMANCE_THRESHOLDS.highPromptChars || promptHeavyTurns > 0 || toolHeavyTurns > 0) {
    return "watch";
  }
  return "healthy";
}

function performanceLabel(state: PerformanceState): string {
  if (state === "regression") return "Regression";
  if (state === "watch") return "Watch";
  return "Healthy";
}

function performanceCardClass(state: PerformanceState): string {
  if (state === "regression") return "border border-red-900/40 bg-red-950/20";
  if (state === "watch") return "border border-amber-900/40 bg-amber-950/20";
  return "border border-emerald-900/40 bg-emerald-950/20";
}

function performanceAccentClass(state: PerformanceState): string {
  if (state === "regression") return "text-red-300";
  if (state === "watch") return "text-amber-300";
  return "text-emerald-300";
}

function performanceBadgeClass(state: PerformanceState): string {
  if (state === "regression") return "rounded-full border border-red-800/60 bg-red-950/60 px-2 py-0.5 text-[10px] uppercase tracking-wide text-red-200";
  if (state === "watch") return "rounded-full border border-amber-800/60 bg-amber-950/60 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-200";
  return "rounded-full border border-emerald-800/60 bg-emerald-950/60 px-2 py-0.5 text-[10px] uppercase tracking-wide text-emerald-200";
}

function performanceFlags(data: Record<string, unknown>): string[] {
  const flags: string[] = [];
  if (Number(data.turnDurationMs ?? 0) >= PERFORMANCE_THRESHOLDS.slowTurnMs) flags.push("slow turn");
  if (Number(data.firstModelResponseMs ?? 0) >= PERFORMANCE_THRESHOLDS.slowFirstResponseMs) flags.push("slow first response");
  if (Number(data.promptChars ?? 0) >= PERFORMANCE_THRESHOLDS.highPromptChars) flags.push("high prompt");
  if (Number(data.toolCallsRequested ?? 0) >= PERFORMANCE_THRESHOLDS.toolHeavyCalls) flags.push("tool-heavy");
  if (Boolean(data.blocked)) flags.push("blocked");
  if (String(data.finishReason ?? "") === "max_tool_iterations") flags.push("max iterations");
  return flags;
}

function performanceDetailCardClass(data: Record<string, unknown>): string {
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
</script>
