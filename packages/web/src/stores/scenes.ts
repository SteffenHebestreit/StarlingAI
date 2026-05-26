import { defineStore } from "pinia";
import { useStorage } from "@vueuse/core";
import { computed, ref, watch } from "vue";
import { useGatewayStore } from "./gateway";

export interface SceneDetail {
  name: string;
  description: string;
  task: string;
  webhookKey?: string;
  source: "config" | "store";
}

export interface SceneInput {
  description: string;
  task: string;
  webhookKey?: string;
}

export interface SceneJobPerformance {
  turnDurationMs: number;
  firstModelResponseMs?: number;
  llmCalls: number;
  llmTimeMs: number;
  toolCallsRequested: number;
  toolExecutionTimeMs: number;
  systemPromptChars: number;
  collapsedHistoryMessages: number;
  collapsedHistoryChars: number;
  promptChars: number;
  completionChars: number;
  toolIterations: number;
  finishReason: string;
  blocked: boolean;
}

export interface SceneJobProgress {
  stage: string;
  message?: string;
  percent?: number;
  totalSteps?: number;
  completedSteps?: number;
  currentStep?: string;
  toolCallsRequested: number;
  toolCallsCompleted: number;
  approvalsRequested: number;
  subAgentsStarted: number;
  swarmTasksTotal: number;
  swarmTasksCompleted: number;
  lastEventAt: string;
  lastEventType?: string;
  currentTool?: string;
  currentAgent?: string;
}

export interface SceneJob {
  id: string;
  sceneName: string;
  definitionType?: "scene" | "job";
  sessionId: string;
  status: "queued" | "running" | "cancelling" | "cancelled" | "completed" | "failed";
  createdAt?: string;
  startedAt?: string;
  completedAt?: string;
  response?: string;
  toolCallsExecuted?: number;
  blocked?: boolean;
  performance?: SceneJobPerformance;
  error?: string;
  progress: SceneJobProgress;
}

interface SceneRunResponse {
  ok: boolean;
  sceneName: string;
  jobId: string;
  sessionId: string;
  status: "queued" | "running";
}

export const useScenesStore = defineStore("scenes", () => {
  const gateway = useGatewayStore();
  const scenes = ref<SceneDetail[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const runError = ref<string | null>(null);
  const recentJobs = useStorage<SceneJob[]>("gc_scene_jobs", []);
  const pollTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function restUrl(path: string): string {
    const wsUrl = gateway.wsUrl ?? "ws://localhost:8765/ws";
    const base = wsUrl.replace(/^ws(s?)/, "http$1").replace(/\/ws$/, "");
    return `${base}${path}`;
  }

  function authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${gateway.token}`, "Content-Type": "application/json" };
  }

  function upsertJob(job: SceneJob) {
    const withoutCurrent = recentJobs.value.filter((entry) => entry.id !== job.id);
    recentJobs.value = [job, ...withoutCurrent]
      .sort((left, right) => {
        const leftTs = left.completedAt ?? left.startedAt ?? left.createdAt ?? "";
        const rightTs = right.completedAt ?? right.startedAt ?? right.createdAt ?? "";
        return rightTs.localeCompare(leftTs);
      })
      .slice(0, 12);
  }

  function dismissJob(jobId: string) {
    stopPolling(jobId);
    recentJobs.value = recentJobs.value.filter((entry) => entry.id !== jobId);
  }

  function stopPolling(jobId: string) {
    const timer = pollTimers.get(jobId);
    if (timer) {
      clearTimeout(timer);
      pollTimers.delete(jobId);
    }
  }

  function stopAllPolling() {
    for (const timer of pollTimers.values()) clearTimeout(timer);
    pollTimers.clear();
  }

  async function fetchJob(jobId: string): Promise<SceneJob | null> {
    try {
      const res = await globalThis.fetch(restUrl(`/api/scenes/jobs/${encodeURIComponent(jobId)}`), {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const job = await res.json() as SceneJob;
      upsertJob(job);
      if (!["queued", "running", "cancelling"].includes(job.status)) stopPolling(job.id);
      return job;
    } catch (e) {
      runError.value = String(e);
      stopPolling(jobId);
      return null;
    }
  }

  async function fetchJobs(options: { limit?: number; status?: SceneJob["status"] } = {}): Promise<SceneJob[]> {
    try {
      const params = new URLSearchParams();
      if (options.limit) params.set("limit", String(options.limit));
      if (options.status) params.set("status", options.status);
      const query = params.size > 0 ? `?${params.toString()}` : "";
      const res = await globalThis.fetch(restUrl(`/api/scenes/jobs${query}`), {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json() as { jobs: SceneJob[] };
      recentJobs.value = body.jobs;
      resumeRunningJobs();
      return body.jobs;
    } catch (e) {
      runError.value = String(e);
      return recentJobs.value;
    }
  }

  function schedulePoll(jobId: string, delayMs = 2000) {
    if (pollTimers.has(jobId)) return;
    const timer = setTimeout(async () => {
      pollTimers.delete(jobId);
      const job = await fetchJob(jobId);
      if (job && ["queued", "running", "cancelling"].includes(job.status)) {
        schedulePoll(jobId, 2000);
      }
    }, delayMs);
    pollTimers.set(jobId, timer);
  }

  function resumeRunningJobs() {
    if (!gateway.token) return;
    recentJobs.value
      .filter((job) => ["queued", "running", "cancelling"].includes(job.status))
      .forEach((job) => schedulePoll(job.id, 0));
  }

  async function fetch() {
    loading.value = true;
    error.value = null;
    try {
      const res = await globalThis.fetch(restUrl("/api/scenes"), { headers: authHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      scenes.value = await res.json() as SceneDetail[];
    } catch (e) {
      error.value = String(e);
    } finally {
      loading.value = false;
    }
  }

  async function save(name: string, input: SceneInput): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const res = await globalThis.fetch(restUrl(`/api/scenes/${encodeURIComponent(name)}`), {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const body = await res.json() as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      await fetch();
    } catch (e) {
      error.value = String(e);
      loading.value = false;
    }
  }

  async function remove(name: string): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const res = await globalThis.fetch(restUrl(`/api/scenes/${encodeURIComponent(name)}`), {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!res.ok) {
        const body = await res.json() as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      await fetch();
    } catch (e) {
      error.value = String(e);
      loading.value = false;
    }
  }

  async function run(name: string, params?: Record<string, string>): Promise<SceneJob | null> {
    return queueRun(`/api/scenes/${encodeURIComponent(name)}/run`, name, params);
  }

  async function runJob(name: string, params?: Record<string, string>): Promise<SceneJob | null> {
    return queueRun(`/api/jobs/${encodeURIComponent(name)}/run`, name, params, "job");
  }

  async function queueRun(path: string, name: string, params?: Record<string, string>, definitionType: "scene" | "job" = "scene"): Promise<SceneJob | null> {
    runError.value = null;
    try {
      const res = await globalThis.fetch(restUrl(path), {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(params && Object.keys(params).length > 0 ? { params } : {}),
      });
      if (!res.ok) {
        const body = await res.json() as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }

      const data = await res.json() as SceneRunResponse;
      const job: SceneJob = {
        id: data.jobId,
        sceneName: data.sceneName,
        definitionType,
        sessionId: data.sessionId,
        status: data.status,
        createdAt: new Date().toISOString(),
        progress: {
          stage: data.status,
          message: data.status === "queued" ? "Queued for worker execution" : "Worker claimed job",
          percent: data.status === "queued" ? 0 : 5,
          toolCallsRequested: 0,
          toolCallsCompleted: 0,
          approvalsRequested: 0,
          subAgentsStarted: 0,
          swarmTasksTotal: 0,
          swarmTasksCompleted: 0,
          lastEventAt: new Date().toISOString(),
        },
      };
      upsertJob(job);
      schedulePoll(job.id, 0);
      return job;
    } catch (e) {
      runError.value = String(e);
      return null;
    }
  }

  /**
   * Server-side delete of a finished scene-job execution row. The gateway
   * refuses to delete an active job (status 409); cancel it first. Removes the
   * entry from recentJobs on success so the UI reflects it immediately.
   */
  async function deleteRun(jobId: string): Promise<{ ok: boolean; error?: string }> {
    runError.value = null;
    try {
      const res = await globalThis.fetch(restUrl(`/api/scenes/jobs/${encodeURIComponent(jobId)}`), {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        const msg = body.error ?? `HTTP ${res.status}`;
        runError.value = msg;
        return { ok: false, error: msg };
      }
      stopPolling(jobId);
      recentJobs.value = recentJobs.value.filter((entry) => entry.id !== jobId);
      return { ok: true };
    } catch (e) {
      const msg = String(e);
      runError.value = msg;
      return { ok: false, error: msg };
    }
  }

  /**
   * Delete every locally-known FINISHED job in one pass — convenience for
   * clearing accumulated completed/failed/cancelled rows. Active jobs are
   * left alone. Returns counts.
   */
  async function clearFinishedRuns(): Promise<{ deleted: number; failed: number }> {
    const targets = recentJobs.value
      .filter((j) => j.status === "completed" || j.status === "failed" || j.status === "cancelled")
      .map((j) => j.id);
    let deleted = 0;
    let failed = 0;
    for (const id of targets) {
      const r = await deleteRun(id);
      if (r.ok) deleted++; else failed++;
    }
    return { deleted, failed };
  }

  async function cancel(jobId: string): Promise<SceneJob | null> {
    runError.value = null;
    try {
      const res = await globalThis.fetch(restUrl(`/api/scenes/jobs/${encodeURIComponent(jobId)}/cancel`), {
        method: "POST",
        headers: authHeaders(),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const job = (await res.json() as { job: SceneJob }).job;
      upsertJob(job);
      if (["queued", "running", "cancelling"].includes(job.status)) {
        schedulePoll(job.id, 0);
      } else {
        stopPolling(job.id);
      }
      return job;
    } catch (e) {
      runError.value = String(e);
      return null;
    }
  }

  const runningJobs = computed(() => recentJobs.value.filter((job) => ["queued", "running", "cancelling"].includes(job.status)));

  watch(() => gateway.token, (token) => {
    if (token) resumeRunningJobs();
  }, { immediate: true });

  watch(() => gateway.connected, (isConnected) => {
    if (!isConnected) stopAllPolling();
  });

  return {
    scenes,
    loading,
    error,
    runError,
    recentJobs,
    runningJobs,
    fetch,
    fetchJobs,
    fetchJob,
    save,
    remove,
    run,
    runJob,
    cancel,
    deleteRun,
    clearFinishedRuns,
    dismissJob,
  };
});
