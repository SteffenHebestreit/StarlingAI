import { defineStore } from "pinia";
import { ref } from "vue";
import { useGatewayStore } from "./gateway";
export const useRuntimeStore = defineStore("runtime", () => {
    const gateway = useGatewayStore();
    const snapshot = ref(null);
    const modelEndpoints = ref(null);
    const loading = ref(false);
    const error = ref("");
    const modelEndpointError = ref("");
    function baseUrl() {
        return (gateway.wsUrl ?? "ws://localhost:8765/ws").replace(/^ws/, "http").replace(/\/ws$/, "");
    }
    async function fetch() {
        if (!gateway.token)
            return;
        loading.value = true;
        error.value = "";
        modelEndpointError.value = "";
        try {
            const headers = { Authorization: `Bearer ${gateway.token}` };
            const [runtimeRes, endpointRes] = await Promise.all([
                window.fetch(`${baseUrl()}/api/runtime/status`, { headers }),
                window.fetch(`${baseUrl()}/api/model-endpoints/status`, { headers }),
            ]);
            if (!runtimeRes.ok)
                throw new Error(`HTTP ${runtimeRes.status}`);
            snapshot.value = await runtimeRes.json();
            if (!endpointRes.ok) {
                modelEndpoints.value = null;
                modelEndpointError.value = `HTTP ${endpointRes.status}`;
            }
            else {
                modelEndpoints.value = await endpointRes.json();
            }
        }
        catch (err) {
            error.value = String(err);
        }
        finally {
            loading.value = false;
        }
    }
    return { snapshot, modelEndpoints, loading, error, modelEndpointError, fetch };
});
