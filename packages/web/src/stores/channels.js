import { defineStore } from "pinia";
import { ref } from "vue";
import { useGatewayStore } from "./gateway";
export const useChannelsStore = defineStore("channels", () => {
    const gateway = useGatewayStore();
    const channels = ref([]);
    const loading = ref(false);
    const error = ref("");
    const deadLetterCount = ref(0);
    const deadLetters = ref([]);
    function baseUrl() {
        return (gateway.wsUrl ?? "ws://localhost:8765/ws").replace(/^ws/, "http").replace(/\/ws$/, "");
    }
    async function fetch() {
        if (!gateway.token)
            return;
        loading.value = true;
        error.value = "";
        try {
            const res = await window.fetch(`${baseUrl()}/api/channels`, {
                headers: { Authorization: `Bearer ${gateway.token}` },
            });
            if (!res.ok)
                throw new Error(`HTTP ${res.status}`);
            channels.value = await res.json();
        }
        catch (err) {
            error.value = String(err);
        }
        finally {
            loading.value = false;
        }
    }
    async function fetchDeadLetterCount() {
        if (!gateway.token)
            return;
        try {
            const res = await window.fetch(`${baseUrl()}/api/channels/dead-letters`, {
                headers: { Authorization: `Bearer ${gateway.token}` },
            });
            if (!res.ok)
                return;
            const data = await res.json();
            deadLetterCount.value = data.count ?? 0;
            deadLetters.value = data.entries ?? [];
        }
        catch { /* non-critical */ }
    }
    async function fetchDetails(type) {
        if (!gateway.token)
            return null;
        try {
            const res = await window.fetch(`${baseUrl()}/api/channels/${type}`, {
                headers: { Authorization: `Bearer ${gateway.token}` },
            });
            if (res.status === 404)
                return null;
            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error ?? `HTTP ${res.status}`);
            }
            return await res.json();
        }
        catch (err) {
            error.value = String(err);
            return null;
        }
    }
    async function fetchConfig(type) {
        const detail = await fetchDetails(type);
        return detail?.config ?? null;
    }
    async function save(type, config) {
        if (!gateway.token)
            return;
        loading.value = true;
        error.value = "";
        try {
            const res = await window.fetch(`${baseUrl()}/api/channels/${type}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${gateway.token}` },
                body: JSON.stringify(config),
            });
            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error ?? `HTTP ${res.status}`);
            }
            await fetch();
        }
        catch (err) {
            error.value = String(err);
        }
        finally {
            loading.value = false;
        }
    }
    async function remove(type) {
        if (!gateway.token)
            return;
        loading.value = true;
        error.value = "";
        try {
            const res = await window.fetch(`${baseUrl()}/api/channels/${type}`, {
                method: "DELETE",
                headers: { Authorization: `Bearer ${gateway.token}` },
            });
            if (!res.ok)
                throw new Error(`HTTP ${res.status}`);
            await fetch();
        }
        catch (err) {
            error.value = String(err);
        }
        finally {
            loading.value = false;
        }
    }
    return { channels, loading, error, deadLetterCount, deadLetters, fetch, fetchDeadLetterCount, fetchDetails, fetchConfig, save, remove };
});
