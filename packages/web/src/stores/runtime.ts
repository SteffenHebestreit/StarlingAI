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

export interface ModelEndpointStatus {
  role: string;
  model: string;
  baseUrl: string;
  ok: boolean;
  status?: number;
  error?: string;
  source?: string;
}

export interface ModelEndpointStatusSnapshot {
  healthy: boolean;
  endpoints: ModelEndpointStatus[];
}

export const useRuntimeStore = defineStore("runtime", () => {
  const gateway = useGatewayStore();
  const snapshot = ref<RuntimeStatusSnapshot | null>(null);
  const modelEndpoints = ref<ModelEndpointStatusSnapshot | null>(null);
  const loading = ref(false);
  const error = ref("");
  const modelEndpointError = ref("");

  function baseUrl(): string {
    return (gateway.wsUrl ?? "ws://localhost:8765/ws").replace(/^ws/, "http").replace(/\/ws$/, "");
  }

  async function fetch(): Promise<void> {
    if (!gateway.token) return;
    loading.value = true;
    error.value = "";
    modelEndpointError.value = "";
    try {
      const headers = { Authorization: `Bearer ${gateway.token}` };
      const [runtimeRes, endpointRes] = await Promise.all([
        window.fetch(`${baseUrl()}/api/runtime/status`, { headers }),
        window.fetch(`${baseUrl()}/api/model-endpoints/status`, { headers }),
      ]);

      if (!runtimeRes.ok) throw new Error(`HTTP ${runtimeRes.status}`);
      snapshot.value = await runtimeRes.json() as RuntimeStatusSnapshot;

      if (!endpointRes.ok) {
        modelEndpoints.value = null;
        modelEndpointError.value = `HTTP ${endpointRes.status}`;
      } else {
        modelEndpoints.value = await endpointRes.json() as ModelEndpointStatusSnapshot;
      }
    } catch (err) {
      error.value = String(err);
    } finally {
      loading.value = false;
    }
  }

  return { snapshot, modelEndpoints, loading, error, modelEndpointError, fetch };
});