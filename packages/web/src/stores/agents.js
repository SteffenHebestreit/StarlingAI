import { defineStore } from "pinia";
import { ref } from "vue";
import { useGatewayStore } from "./gateway";
export const useAgentsStore = defineStore("agents", () => {
    const agents = ref([]);
    const loading = ref(false);
    const error = ref(null);
    const routingResult = ref(null);
    const routingLoading = ref(false);
    const routingError = ref(null);
    function restUrl(path) {
        const gateway = useGatewayStore();
        const base = (gateway.wsUrl ?? "ws://localhost:8765/ws").replace(/^ws(s?)/, "http$1").replace(/\/ws$/, "");
        return `${base}${path}`;
    }
    function authHeaders() {
        const gateway = useGatewayStore();
        return { Authorization: `Bearer ${gateway.token}`, "Content-Type": "application/json" };
    }
    async function fetch() {
        loading.value = true;
        error.value = null;
        try {
            const res = await globalThis.fetch(restUrl("/api/agents"), { headers: authHeaders() });
            if (!res.ok)
                throw new Error(`HTTP ${res.status}`);
            agents.value = await res.json();
        }
        catch (e) {
            error.value = String(e);
        }
        finally {
            loading.value = false;
        }
    }
    async function patchModel(name, patch) {
        error.value = null;
        // Optimistic update
        const agent = agents.value.find(a => a.name === name);
        if (agent)
            agent.model = { ...agent.model, ...patch };
        try {
            const res = await globalThis.fetch(restUrl(`/api/agents/${name}/model`), {
                method: "PATCH",
                headers: authHeaders(),
                body: JSON.stringify(patch),
            });
            if (!res.ok)
                throw new Error(`HTTP ${res.status}`);
            const updated = await res.json();
            if (agent)
                agent.model = updated.model;
        }
        catch (e) {
            error.value = String(e);
            // Revert by re-fetching
            await fetch();
        }
    }
    async function resolve(query, minConfidence) {
        routingLoading.value = true;
        routingError.value = null;
        try {
            const params = new URLSearchParams({ query, minConfidence });
            const res = await globalThis.fetch(restUrl(`/api/agents/resolve?${params.toString()}`), {
                headers: authHeaders(),
            });
            if (!res.ok)
                throw new Error(`HTTP ${res.status}`);
            routingResult.value = await res.json();
        }
        catch (e) {
            routingError.value = String(e);
            routingResult.value = null;
        }
        finally {
            routingLoading.value = false;
        }
    }
    function clearRoutingResult() {
        routingResult.value = null;
        routingError.value = null;
    }
    return {
        agents,
        loading,
        error,
        routingResult,
        routingLoading,
        routingError,
        fetch,
        patchModel,
        resolve,
        clearRoutingResult,
    };
});
