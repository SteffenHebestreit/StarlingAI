<template>
  <div class="settings-page">

    <div class="glass-card p-5 mb-5">
      <div class="flex items-center justify-between">
        <div>
          <div class="section-title mb-1">Swarm Health</div>
          <div class="text-sm text-gray-400 max-w-3xl">
            Live view of warden alerts, capability gaps, tool promotions, paused tasks, and circuit breaker states.
          </div>
        </div>
        <button @click="refresh" :disabled="loading" class="btn-ghost px-4 py-2 rounded-xl text-sm">
          {{ loading ? 'Refreshing…' : 'Refresh' }}
        </button>
      </div>
    </div>

    <div class="settings-grid">

      <!-- ══ LEFT COLUMN ══════════════════════════════════════════════════════ -->
      <div class="space-y-5">

        <!-- ── Warden Alerts ─────────────────────────────────────────────── -->
        <div class="glass-card p-5">
          <h3 class="section-title mb-3">Warden Alerts
            <span v-if="health.wardenAlerts.length" class="ml-2 text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-300">
              {{ health.wardenAlerts.length }}
            </span>
          </h3>
          <div v-if="!health.wardenAlerts.length" class="text-sm text-gray-500">No alerts — swarm is healthy.</div>
          <div v-else class="space-y-2 max-h-72 overflow-y-auto pr-1">
            <div v-for="alert in [...health.wardenAlerts].reverse()" :key="alert.ts + alert.type"
              :class="['rounded-lg p-3 text-xs border', alert.severity === 'error'
                ? 'bg-red-900/20 border-red-500/30 text-red-200'
                : 'bg-yellow-900/20 border-yellow-500/30 text-yellow-200']">
              <div class="flex justify-between items-start mb-1">
                <span class="font-mono font-bold">{{ alert.type }}</span>
                <span class="text-gray-400 text-[10px]">{{ formatTime(alert.ts) }}</span>
              </div>
              <div class="text-gray-300">{{ alert.detail }}</div>
              <div class="mt-1 text-gray-400">Subject: {{ alert.subject }} · Action: {{ alert.action }}</div>
            </div>
          </div>
        </div>

        <!-- ── Capability Gaps ───────────────────────────────────────────── -->
        <div class="glass-card p-5">
          <h3 class="section-title mb-3">Capability Gaps
            <span v-if="openGaps.length" class="ml-2 text-xs px-2 py-0.5 rounded-full bg-orange-500/20 text-orange-300">
              {{ openGaps.length }} open
            </span>
          </h3>
          <div v-if="!health.capabilityGaps.length" class="text-sm text-gray-500">No gaps detected.</div>
          <div v-else class="space-y-2 max-h-64 overflow-y-auto pr-1">
            <div v-for="gap in health.capabilityGaps" :key="gap.id"
              class="rounded-lg p-3 text-xs border border-purple-500/20 bg-purple-900/10">
              <div class="flex justify-between items-start mb-1">
                <span :class="['px-1.5 py-0.5 rounded text-[10px] font-bold', gapStatusClass(gap.status)]">
                  {{ gap.status }}
                </span>
                <span class="text-gray-400">{{ gap.failureCount }} failure{{ gap.failureCount !== 1 ? 's' : '' }}</span>
              </div>
              <div class="text-gray-200 line-clamp-2">{{ gap.description }}</div>
              <div v-if="gap.proposedToolName" class="mt-1 text-purple-300">Proposed: {{ gap.proposedToolName }}</div>
            </div>
          </div>
        </div>

        <!-- ── Paused Tasks (Checkpoints) ───────────────────────────────── -->
        <div class="glass-card p-5">
          <h3 class="section-title mb-3">Paused Tasks
            <span v-if="pausedCheckpoints.length" class="ml-2 text-xs px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-300">
              {{ pausedCheckpoints.length }}
            </span>
          </h3>
          <div v-if="!pausedCheckpoints.length" class="text-sm text-gray-500">No paused tasks.</div>
          <div v-else class="space-y-2 max-h-64 overflow-y-auto pr-1">
            <div v-for="cp in pausedCheckpoints" :key="cp.taskId"
              class="rounded-lg p-3 text-xs border border-blue-500/20 bg-blue-900/10">
              <div class="flex justify-between items-start mb-1">
                <span class="font-mono text-blue-300">{{ cp.agentName }}</span>
                <span class="text-gray-400">{{ Math.round(cp.elapsedMs / 1000) }}s elapsed</span>
              </div>
              <div class="text-gray-200 line-clamp-2">{{ cp.task }}</div>
              <div v-if="cp.progressNote" class="mt-1 text-gray-400 italic line-clamp-1">{{ cp.progressNote }}</div>
              <div class="mt-2">
                <button @click="resumeTask(cp.taskId)"
                  class="btn-ghost text-[10px] px-2 py-1 rounded-lg">Resume</button>
              </div>
            </div>
          </div>
        </div>

      </div>

      <!-- ══ RIGHT COLUMN ═════════════════════════════════════════════════════ -->
      <div class="space-y-5">

        <!-- ── Tool Promotion Queue ──────────────────────────────────────── -->
        <div class="glass-card p-5">
          <h3 class="section-title mb-3">Promotion Queue
            <span v-if="pendingPromotions.length" class="ml-2 text-xs px-2 py-0.5 rounded-full bg-green-500/20 text-green-300">
              {{ pendingPromotions.length }} pending
            </span>
          </h3>
          <div v-if="!health.promotionCandidates.length" class="text-sm text-gray-500">
            No tools are promotion candidates yet.
            <div class="mt-1 text-gray-600">
              Tools need {{ PROMOTION_MIN_CALLS }} calls at ≥80% success rate to qualify.
            </div>
          </div>
          <div v-else class="space-y-3 max-h-72 overflow-y-auto pr-1">
            <div v-for="cand in health.promotionCandidates" :key="cand.toolName"
              class="rounded-lg p-3 text-xs border border-green-500/20 bg-green-900/10">
              <div class="flex justify-between items-start mb-1">
                <span class="font-mono text-green-300">{{ cand.fullName }}</span>
                <span :class="['px-1.5 py-0.5 rounded text-[10px] font-bold', promotionStatusClass(cand.status)]">
                  {{ cand.status }}
                </span>
              </div>
              <div class="text-gray-300 mb-1 line-clamp-2">{{ cand.description }}</div>
              <div class="text-gray-400">
                {{ cand.callCount }} calls · {{ (cand.successRate * 100).toFixed(0) }}% success
              </div>
              <div v-if="cand.status === 'pending'" class="flex gap-2 mt-2">
                <button @click="approvePromotion(cand.toolName)"
                  class="btn-grad text-[10px] px-2 py-1 rounded-lg">Approve</button>
                <button @click="rejectPromotion(cand.toolName)"
                  class="btn-ghost text-[10px] px-2 py-1 rounded-lg text-red-400">Reject</button>
              </div>
            </div>
          </div>
        </div>

        <!-- ── Dynamic Tool Stats ────────────────────────────────────────── -->
        <div class="glass-card p-5">
          <h3 class="section-title mb-3">Dynamic Tools (selfdev__)</h3>
          <div v-if="!health.dynamicToolStats.length" class="text-sm text-gray-500">No self-developed tools deployed.</div>
          <div v-else class="space-y-1.5 max-h-64 overflow-y-auto pr-1">
            <div v-for="tool in health.dynamicToolStats" :key="tool.fullName"
              class="flex items-center justify-between text-xs p-2 rounded bg-white/5">
              <span class="font-mono text-purple-300 truncate max-w-[55%]">{{ tool.fullName }}</span>
              <div class="flex items-center gap-2 text-gray-400 shrink-0">
                <span>{{ tool.calls }}c</span>
                <span :class="tool.successRate >= 0.8 ? 'text-green-400' : 'text-yellow-400'">
                  {{ tool.calls > 0 ? (tool.successRate * 100).toFixed(0) + '%' : '–' }}
                </span>
                <span v-if="tool.promotionStatus === 'pending'" class="text-green-300">●</span>
                <span v-else-if="tool.promotionStatus === 'approved'" class="text-blue-300">✓</span>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useGatewayStore } from "@/stores/gateway";

const PROMOTION_MIN_CALLS = 10;

const gateway = useGatewayStore();

interface WardenAlert {
  type: string;
  severity: "warn" | "error";
  subject: string;
  detail: string;
  action: string;
  ts: string;
}

interface CapabilityGap {
  id: string;
  description: string;
  status: string;
  failureCount: number;
  proposedToolName?: string;
}

interface PromotionCandidate {
  toolName: string;
  fullName: string;
  description: string;
  callCount: number;
  successCount: number;
  successRate: number;
  status: "pending" | "approved" | "rejected";
  nominatedAt: string;
}

interface DynamicToolStat {
  toolName: string;
  fullName: string;
  calls: number;
  successes: number;
  successRate: number;
  promotionStatus?: string;
}

interface TaskCheckpoint {
  taskId: string;
  agentName: string;
  task: string;
  progressNote: string;
  status: string;
  elapsedMs: number;
  iterationsCompleted: number;
  updatedAt: string;
}

interface SwarmHealth {
  wardenAlerts: WardenAlert[];
  capabilityGaps: CapabilityGap[];
  promotionCandidates: PromotionCandidate[];
  dynamicToolStats: DynamicToolStat[];
}

const loading = ref(false);
const health = ref<SwarmHealth>({
  wardenAlerts: [],
  capabilityGaps: [],
  promotionCandidates: [],
  dynamicToolStats: [],
});
const checkpoints = ref<TaskCheckpoint[]>([]);
const error = ref<string | null>(null);

const openGaps = computed(() =>
  health.value.capabilityGaps.filter(g => g.status === "detected" || g.status === "proposed")
);
const pendingPromotions = computed(() =>
  health.value.promotionCandidates.filter(c => c.status === "pending")
);
const pausedCheckpoints = computed(() =>
  checkpoints.value.filter(cp => cp.status === "paused")
);

function apiBase(): string {
  return gateway.wsUrl.replace(/^ws/, "http").replace(/\/ws$/, "");
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${gateway.token}` };
}

async function refresh() {
  loading.value = true;
  error.value = null;
  try {
    const [healthRes, cpRes] = await Promise.all([
      fetch(`${apiBase()}/api/swarm/health`, { headers: authHeaders() }),
      fetch(`${apiBase()}/api/checkpoints`, { headers: authHeaders() }),
    ]);
    if (healthRes.ok) health.value = await healthRes.json();
    if (cpRes.ok) {
      const data = await cpRes.json();
      checkpoints.value = data.checkpoints ?? [];
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Failed to load swarm health";
  } finally {
    loading.value = false;
  }
}

async function approvePromotion(toolName: string) {
  try {
    await fetch(`${apiBase()}/api/tools/dynamic/${toolName}/promote`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ reviewedBy: "operator" }),
    });
    await refresh();
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Promotion failed";
  }
}

async function rejectPromotion(toolName: string) {
  try {
    await fetch(`${apiBase()}/api/tools/dynamic/${toolName}/reject-promotion`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ reviewedBy: "operator" }),
    });
    await refresh();
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Rejection failed";
  }
}

async function resumeTask(taskId: string) {
  try {
    await fetch(`${apiBase()}/api/checkpoints/${taskId}/resume`, {
      method: "POST",
      headers: authHeaders(),
    });
    await refresh();
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Resume failed";
  }
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
}

function gapStatusClass(status: string): string {
  switch (status) {
    case "detected": return "bg-orange-500/20 text-orange-300";
    case "proposed": return "bg-yellow-500/20 text-yellow-300";
    case "developing": return "bg-blue-500/20 text-blue-300";
    case "deployed": return "bg-green-500/20 text-green-300";
    case "rejected": return "bg-red-500/20 text-red-300";
    default: return "bg-gray-500/20 text-gray-300";
  }
}

function promotionStatusClass(status: string): string {
  switch (status) {
    case "pending": return "bg-yellow-500/20 text-yellow-300";
    case "approved": return "bg-green-500/20 text-green-300";
    case "rejected": return "bg-red-500/20 text-red-300";
    default: return "bg-gray-500/20 text-gray-300";
  }
}

onMounted(refresh);
</script>
