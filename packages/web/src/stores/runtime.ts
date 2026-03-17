import { defineStore } from "pinia";
import { ref } from "vue";
import { useGatewayStore } from "./gateway";

export interface RuntimeComponentStatus {
  name: string;
  healthy: boolean;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  details?: Record<string, unknown>;
}

export interface RuntimeStatusSnapshot {
  healthy: boolean;
  components: RuntimeComponentStatus[];
}

export const useRuntimeStore = defineStore("runtime", () => {
  const gateway = useGatewayStore();
  const snapshot = ref<RuntimeStatusSnapshot | null>(null);
  const loading = ref(false);
  const error = ref("");

  function baseUrl(): string {
    return (gateway.wsUrl ?? "ws://localhost:8765/ws").replace(/^ws/, "http").replace(/\/ws$/, "");
  }

  async function fetch(): Promise<void> {
    if (!gateway.token) return;
    loading.value = true;
    error.value = "";
    try {
      const res = await window.fetch(`${baseUrl()}/api/runtime/status`, {
        headers: { Authorization: `Bearer ${gateway.token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      snapshot.value = await res.json() as RuntimeStatusSnapshot;
    } catch (err) {
      error.value = String(err);
    } finally {
      loading.value = false;
    }
  }

  return { snapshot, loading, error, fetch };
});