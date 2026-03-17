import { defineStore } from "pinia";
import { ref } from "vue";
import { useGatewayStore } from "./gateway";
export const useGuardrailsStore = defineStore("guardrails", () => {
    const state = ref(null);
    const loading = ref(false);
    const error = ref(null);
    function restUrl(path) {
        const gateway = useGatewayStore();
        // derive HTTP base URL from WS URL: ws://host:port → http://host:port
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
            const res = await globalThis.fetch(restUrl("/api/guardrails"), { headers: authHeaders() });
            if (!res.ok)
                throw new Error(`HTTP ${res.status}`);
            state.value = await res.json();
        }
        catch (e) {
            error.value = String(e);
        }
        finally {
            loading.value = false;
        }
    }
    async function update(patch) {
        loading.value = true;
        error.value = null;
        try {
            const res = await globalThis.fetch(restUrl("/api/guardrails"), {
                method: "PUT",
                headers: authHeaders(),
                body: JSON.stringify(patch),
            });
            if (!res.ok)
                throw new Error(`HTTP ${res.status}`);
            state.value = await res.json();
        }
        catch (e) {
            error.value = String(e);
            // revert optimistic UI by re-fetching
            await fetch();
        }
        finally {
            loading.value = false;
        }
    }
    async function reset() {
        loading.value = true;
        error.value = null;
        try {
            const res = await globalThis.fetch(restUrl("/api/guardrails/reset"), {
                method: "POST",
                headers: authHeaders(),
            });
            if (!res.ok)
                throw new Error(`HTTP ${res.status}`);
            state.value = await res.json();
        }
        catch (e) {
            error.value = String(e);
        }
        finally {
            loading.value = false;
        }
    }
    return { state, loading, error, fetch, update, reset };
});
