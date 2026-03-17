import { defineStore } from "pinia";
import { ref } from "vue";
import { useGatewayStore } from "./gateway";
export const useRuntimeStore = defineStore("runtime", () => {
    const gateway = useGatewayStore();
    const snapshot = ref(null);
    const loading = ref(false);
    const error = ref("");
    function baseUrl() {
        return (gateway.wsUrl ?? "ws://localhost:8765/ws").replace(/^ws/, "http").replace(/\/ws$/, "");
    }
    async function fetch() {
        if (!gateway.token)
            return;
        loading.value = true;
        error.value = "";
        try {
            const res = await window.fetch(`${baseUrl()}/api/runtime/status`, {
                headers: { Authorization: `Bearer ${gateway.token}` },
            });
            if (!res.ok)
                throw new Error(`HTTP ${res.status}`);
            snapshot.value = await res.json();
        }
        catch (err) {
            error.value = String(err);
        }
        finally {
            loading.value = false;
        }
    }
    return { snapshot, loading, error, fetch };
});
