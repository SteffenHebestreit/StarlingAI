import { defineStore } from "pinia";
import { ref } from "vue";
import { useGatewayStore } from "./gateway";

export interface JobStepInput {
  scene: string;
  label?: string;
  params?: Record<string, string>;
}

export type JobTriggerInput =
  | { type: "api"; webhookKey?: string; params?: Record<string, string> }
  | { type: "cron"; expression: string; enabled?: boolean; params?: Record<string, string> }
  | {
      type: "channel";
      channels?: Array<"slack" | "discord" | "whatsapp" | "email" | "signal" | "telegram">;
      pattern: string;
      mode?: "prefix" | "exact" | "contains" | "regex";
      ignoreCase?: boolean;
      parseParams?: boolean;
      silent?: boolean;
      replyText?: string;
      captureMessageAs?: string;
      captureRemainderAs?: string;
      params?: Record<string, string>;
    };

export interface JobParamInput {
  description?: string;
  default?: string;
}

export interface JobDetail {
  name: string;
  description: string;
  params?: Record<string, JobParamInput>;
  steps: JobStepInput[];
  triggers?: JobTriggerInput[];
  source: "config" | "store";
}

export interface JobInput {
  description: string;
  params?: Record<string, JobParamInput>;
  steps: JobStepInput[];
  triggers?: JobTriggerInput[];
}

export const useJobsStore = defineStore("jobs", () => {
  const gateway = useGatewayStore();
  const jobs = ref<JobDetail[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  function restUrl(path: string): string {
    const wsUrl = gateway.wsUrl ?? "ws://localhost:8765/ws";
    const base = wsUrl.replace(/^ws(s?)/, "http$1").replace(/\/ws$/, "");
    return `${base}${path}`;
  }

  function authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${gateway.token}`, "Content-Type": "application/json" };
  }

  async function fetch() {
    loading.value = true;
    error.value = null;
    try {
      const res = await globalThis.fetch(restUrl("/api/jobs"), { headers: authHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      jobs.value = await res.json() as JobDetail[];
    } catch (e) {
      error.value = String(e);
    } finally {
      loading.value = false;
    }
  }

  async function save(name: string, input: JobInput): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const res = await globalThis.fetch(restUrl(`/api/jobs/${encodeURIComponent(name)}`), {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
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
      const res = await globalThis.fetch(restUrl(`/api/jobs/${encodeURIComponent(name)}`), {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      await fetch();
    } catch (e) {
      error.value = String(e);
      loading.value = false;
    }
  }

  return {
    jobs,
    loading,
    error,
    fetch,
    save,
    remove,
  };
});