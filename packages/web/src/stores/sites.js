import { defineStore } from "pinia";
import { ref } from "vue";
import { useGatewayStore } from "./gateway";
export const useSitesStore = defineStore("sites", () => {
    const sites = ref([]);
    const loading = ref(false);
    const error = ref(null);
    function restUrl(path) {
        const gw = useGatewayStore();
        const base = (gw.wsUrl ?? "ws://localhost:8765/ws").replace(/^ws(s?)/, "http$1").replace(/\/ws$/, "");
        return `${base}${path}`;
    }
    function authHeaders() {
        const gw = useGatewayStore();
        return { Authorization: `Bearer ${gw.token}`, "Content-Type": "application/json" };
    }
    async function fetch() {
        loading.value = true;
        error.value = null;
        try {
            const res = await globalThis.fetch(restUrl("/api/sites"), { headers: authHeaders() });
            if (!res.ok)
                throw new Error(`HTTP ${res.status}`);
            sites.value = await res.json();
        }
        catch (e) {
            error.value = String(e);
        }
        finally {
            loading.value = false;
        }
    }
    async function save(hostname, input) {
        loading.value = true;
        error.value = null;
        try {
            const res = await globalThis.fetch(restUrl(`/api/sites/${encodeURIComponent(hostname)}`), {
                method: "POST",
                headers: authHeaders(),
                body: JSON.stringify(input),
            });
            if (!res.ok)
                throw new Error(`HTTP ${res.status}`);
            await fetch();
        }
        catch (e) {
            error.value = String(e);
            loading.value = false;
        }
    }
    async function remove(hostname) {
        loading.value = true;
        error.value = null;
        try {
            const res = await globalThis.fetch(restUrl(`/api/sites/${encodeURIComponent(hostname)}`), {
                method: "DELETE",
                headers: authHeaders(),
            });
            if (!res.ok)
                throw new Error(`HTTP ${res.status}`);
            await fetch();
        }
        catch (e) {
            error.value = String(e);
            loading.value = false;
        }
    }
    return { sites, loading, error, fetch, save, remove };
});
