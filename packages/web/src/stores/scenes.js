import { defineStore } from "pinia";
import { useStorage } from "@vueuse/core";
import { computed, ref, watch } from "vue";
import { useGatewayStore } from "./gateway";
export const useScenesStore = defineStore("scenes", () => {
    const gateway = useGatewayStore();
    const scenes = ref([]);
    const loading = ref(false);
    const error = ref(null);
    const runError = ref(null);
    const recentJobs = useStorage("gc_scene_jobs", []);
    const pollTimers = new Map();
    function restUrl(path) {
        const wsUrl = gateway.wsUrl ?? "ws://localhost:8765/ws";
        const base = wsUrl.replace(/^ws(s?)/, "http$1").replace(/\/ws$/, "");
        return `${base}${path}`;
    }
    function authHeaders() {
        return { Authorization: `Bearer ${gateway.token}`, "Content-Type": "application/json" };
    }
    function upsertJob(job) {
        const withoutCurrent = recentJobs.value.filter((entry) => entry.id !== job.id);
        recentJobs.value = [job, ...withoutCurrent]
            .sort((left, right) => {
            const leftTs = left.completedAt ?? left.startedAt;
            const rightTs = right.completedAt ?? right.startedAt;
            return rightTs.localeCompare(leftTs);
        })
            .slice(0, 12);
    }
    function dismissJob(jobId) {
        stopPolling(jobId);
        recentJobs.value = recentJobs.value.filter((entry) => entry.id !== jobId);
    }
    function stopPolling(jobId) {
        const timer = pollTimers.get(jobId);
        if (timer) {
            clearTimeout(timer);
            pollTimers.delete(jobId);
        }
    }
    async function fetchJob(jobId) {
        try {
            const res = await globalThis.fetch(restUrl(`/api/scenes/jobs/${encodeURIComponent(jobId)}`), {
                headers: authHeaders(),
            });
            if (!res.ok)
                throw new Error(`HTTP ${res.status}`);
            const job = await res.json();
            upsertJob(job);
            if (job.status !== "running")
                stopPolling(job.id);
            return job;
        }
        catch (e) {
            runError.value = String(e);
            stopPolling(jobId);
            return null;
        }
    }
    function schedulePoll(jobId, delayMs = 2000) {
        if (pollTimers.has(jobId))
            return;
        const timer = setTimeout(async () => {
            pollTimers.delete(jobId);
            const job = await fetchJob(jobId);
            if (job?.status === "running") {
                schedulePoll(jobId, 2000);
            }
        }, delayMs);
        pollTimers.set(jobId, timer);
    }
    function resumeRunningJobs() {
        if (!gateway.token)
            return;
        recentJobs.value
            .filter((job) => job.status === "running")
            .forEach((job) => schedulePoll(job.id, 0));
    }
    async function fetch() {
        loading.value = true;
        error.value = null;
        try {
            const res = await globalThis.fetch(restUrl("/api/scenes"), { headers: authHeaders() });
            if (!res.ok)
                throw new Error(`HTTP ${res.status}`);
            scenes.value = await res.json();
        }
        catch (e) {
            error.value = String(e);
        }
        finally {
            loading.value = false;
        }
    }
    async function save(name, input) {
        loading.value = true;
        error.value = null;
        try {
            const res = await globalThis.fetch(restUrl(`/api/scenes/${encodeURIComponent(name)}`), {
                method: "POST",
                headers: authHeaders(),
                body: JSON.stringify(input),
            });
            if (!res.ok) {
                const body = await res.json();
                throw new Error(body.error ?? `HTTP ${res.status}`);
            }
            await fetch();
        }
        catch (e) {
            error.value = String(e);
            loading.value = false;
        }
    }
    async function remove(name) {
        loading.value = true;
        error.value = null;
        try {
            const res = await globalThis.fetch(restUrl(`/api/scenes/${encodeURIComponent(name)}`), {
                method: "DELETE",
                headers: authHeaders(),
            });
            if (!res.ok) {
                const body = await res.json();
                throw new Error(body.error ?? `HTTP ${res.status}`);
            }
            await fetch();
        }
        catch (e) {
            error.value = String(e);
            loading.value = false;
        }
    }
    async function run(name, params) {
        runError.value = null;
        try {
            const res = await globalThis.fetch(restUrl(`/api/scenes/${encodeURIComponent(name)}/run`), {
                method: "POST",
                headers: authHeaders(),
                body: JSON.stringify(params && Object.keys(params).length > 0 ? { params } : {}),
            });
            if (!res.ok) {
                const body = await res.json();
                throw new Error(body.error ?? `HTTP ${res.status}`);
            }
            const data = await res.json();
            const job = {
                id: data.jobId,
                sceneName: data.sceneName,
                sessionId: data.sessionId,
                status: "running",
                startedAt: new Date().toISOString(),
            };
            upsertJob(job);
            schedulePoll(job.id, 0);
            return job;
        }
        catch (e) {
            runError.value = String(e);
            return null;
        }
    }
    const runningJobs = computed(() => recentJobs.value.filter((job) => job.status === "running"));
    watch(() => gateway.token, (token) => {
        if (token)
            resumeRunningJobs();
    }, { immediate: true });
    return {
        scenes,
        loading,
        error,
        runError,
        recentJobs,
        runningJobs,
        fetch,
        fetchJob,
        save,
        remove,
        run,
        dismissJob,
    };
});
