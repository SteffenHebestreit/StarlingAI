<template>
  <div class="page-shell">

    <!-- Held to the grid's width so the title lines up with the cards on a wide screen. -->
    <header class="page-header mx-auto max-w-[1400px]">
      <div class="page-header__text">
        <h1 class="page-title">Swarm Health</h1>
        <p class="page-subtitle">
          Live view of warden alerts, capability gaps, tool promotions, paused tasks, and circuit breaker states.
        </p>
      </div>
      <div class="page-actions">
        <button type="button" @click="refresh" :disabled="loading" class="btn-ghost px-4 py-2 rounded-xl text-sm">
          {{ loading ? 'Refreshing…' : 'Refresh' }}
        </button>
      </div>
    </header>

    <div v-if="error" class="notice notice--error mb-5" role="alert">
      {{ error }}
    </div>

    <div class="page-grid">

      <!-- ══ LEFT COLUMN ══════════════════════════════════════════════════════ -->
      <div class="space-y-5">

        <!-- ── Warden Alerts ─────────────────────────────────────────────── -->
        <div class="glass-card p-5">
          <h3 class="section-title mb-3">Warden Alerts
            <span v-if="health.wardenAlerts.length" class="ml-2 text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-300">
              {{ health.wardenAlerts.length }}
            </span>
          </h3>
          <div v-if="!health.wardenAlerts.length" class="text-sm text-gray-500">{{ emptyCopy(healthLoaded, "No alerts — swarm is healthy.") }}</div>
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
          <div v-if="!health.capabilityGaps.length" class="text-sm text-gray-500">{{ emptyCopy(healthLoaded, "No gaps detected.") }}</div>
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
          <div v-if="!pausedCheckpoints.length" class="text-sm text-gray-500">{{ emptyCopy(checkpointsLoaded, "No paused tasks.") }}</div>
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
                <button type="button" @click="resumeTask(cp)" :disabled="resumingTaskId === cp.taskId"
                  class="btn-ghost text-[10px] px-2 py-1 rounded-lg">{{ resumingTaskId === cp.taskId ? "Resuming…" : "Resume" }}</button>
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
            {{ emptyCopy(healthLoaded, "No tools are promotion candidates yet.") }}
            <div v-if="healthLoaded" class="mt-1 text-gray-600">
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
                <button type="button" @click="approvePromotion(cand)" :disabled="promotionBusy?.tool === cand.toolName"
                  class="btn-grad text-[10px] px-2 py-1 rounded-lg">{{ isPromotionBusy(cand, "approve") ? "Approving…" : "Approve" }}</button>
                <button type="button" @click="rejectPromotion(cand)" :disabled="promotionBusy?.tool === cand.toolName"
                  class="btn-ghost text-[10px] px-2 py-1 rounded-lg text-red-400">{{ isPromotionBusy(cand, "reject") ? "Rejecting…" : "Reject" }}</button>
              </div>
            </div>
          </div>
        </div>

        <!-- ── Dynamic Tool Stats ────────────────────────────────────────── -->
        <div class="glass-card p-5">
          <h3 class="section-title mb-3">Dynamic Tools (selfdev__)</h3>
          <div v-if="!health.dynamicToolStats.length" class="text-sm text-gray-500">{{ emptyCopy(healthLoaded, "No self-developed tools deployed.") }}</div>
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
import { confirmAction } from "@/composables/useConfirm";
import { useToast, errorText } from "@/composables/useToast";

const PROMOTION_MIN_CALLS = 10;

const gateway = useGatewayStore();
const toast = useToast();

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
// True while that part of the page comes from a load that succeeded.
const healthLoaded = ref(false);
const checkpointsLoaded = ref(false);
// The row whose request is in flight.
const promotionBusy = ref<{ tool: string; action: "approve" | "reject" } | null>(null);
const resumingTaskId = ref<string | null>(null);

// An empty list means "nothing there" only after a load that worked: "No alerts — swarm is
// healthy." under a failed request told the operator the opposite of what was known.
function emptyCopy(loaded: boolean, whenEmpty: string): string {
  if (loaded) return whenEmpty;
  return loading.value ? "Loading…" : "Could not be loaded.";
}

function isPromotionBusy(cand: PromotionCandidate, action: "approve" | "reject"): boolean {
  return promotionBusy.value?.tool === cand.toolName && promotionBusy.value.action === action;
}

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
    const failed: string[] = [];
    if (healthRes.ok) health.value = await healthRes.json();
    else failed.push(`swarm health (HTTP ${healthRes.status})`);
    healthLoaded.value = healthRes.ok;
    if (cpRes.ok) {
      const data = await cpRes.json();
      checkpoints.value = data.checkpoints ?? [];
    } else {
      failed.push(`paused tasks (HTTP ${cpRes.status})`);
    }
    checkpointsLoaded.value = cpRes.ok;
    if (failed.length > 0) error.value = `Failed to load ${failed.join(" and ")}.`;
  } catch (e) {
    healthLoaded.value = false;
    checkpointsLoaded.value = false;
    error.value = `Failed to load swarm health: ${errorText(e)}`;
  } finally {
    loading.value = false;
  }
}

/** The gateway's own reason when it sent one, else the status. */
async function failureText(res: Response): Promise<string> {
  const body = await res.json().catch(() => ({})) as { error?: string };
  return body.error || `HTTP ${res.status}`;
}

// The three actions below report through toasts: the refresh() that follows them clears the
// page's error line, so a failure written there was gone before it could be read.
async function approvePromotion(cand: PromotionCandidate) {
  if (promotionBusy.value) return;
  promotionBusy.value = { tool: cand.toolName, action: "approve" };
  try {
    const res = await fetch(`${apiBase()}/api/tools/dynamic/${encodeURIComponent(cand.toolName)}/promote`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ reviewedBy: "operator" }),
    });
    if (!res.ok) throw new Error(await failureText(res));
    toast.success("Promotion approved", `${cand.fullName} is now also registered as ${cand.toolName}.`);
    await refresh();
  } catch (e) {
    toast.error("Couldn't approve the promotion", errorText(e));
  } finally {
    promotionBusy.value = null;
  }
}

async function rejectPromotion(cand: PromotionCandidate) {
  if (promotionBusy.value) return;
  if (!(await confirmAction({
    title: "Reject this promotion?",
    message: `${cand.fullName} is marked rejected and is not nominated again. The tool itself stays available under its selfdev name. This page cannot take a rejection back.`,
    confirmLabel: "Reject promotion",
    danger: true,
  }))) return;
  promotionBusy.value = { tool: cand.toolName, action: "reject" };
  try {
    const res = await fetch(`${apiBase()}/api/tools/dynamic/${encodeURIComponent(cand.toolName)}/reject-promotion`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ reviewedBy: "operator" }),
    });
    if (!res.ok) throw new Error(await failureText(res));
    toast.success("Promotion rejected", `${cand.fullName} stays a self-developed tool and will not be nominated again.`);
    await refresh();
  } catch (e) {
    toast.error("Couldn't reject the promotion", errorText(e));
  } finally {
    promotionBusy.value = null;
  }
}

async function resumeTask(cp: TaskCheckpoint) {
  if (resumingTaskId.value) return;
  resumingTaskId.value = cp.taskId;
  try {
    const res = await fetch(`${apiBase()}/api/checkpoints/${cp.taskId}/resume`, {
      method: "POST",
      headers: authHeaders(),
    });
    if (!res.ok) throw new Error(await failureText(res));
    toast.success("Task resumed", `The paused task of ${cp.agentName} is marked resumed.`);
    await refresh();
  } catch (e) {
    toast.error("Couldn't resume the task", errorText(e));
  } finally {
    resumingTaskId.value = null;
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
