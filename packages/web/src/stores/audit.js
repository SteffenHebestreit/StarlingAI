import { defineStore } from "pinia";
import { ref, watch } from "vue";
import { useGatewayStore } from "./gateway.js";
export const useAuditStore = defineStore("audit", () => {
    const events = ref([]);
    const subscribed = ref(false);
    const MAX_EVENTS = 500;
    const gateway = useGatewayStore();
    async function subscribe() {
        if (!subscribed.value && gateway.connected) {
            await gateway.rpc("audit.subscribe");
            subscribed.value = true;
        }
    }
    function addEvent(event) {
        events.value.unshift(event); // newest first
        if (events.value.length > MAX_EVENTS) {
            events.value.splice(MAX_EVENTS);
        }
    }
    function clear() {
        events.value = [];
    }
    watch(() => gateway.connected, (connected) => {
        if (connected) {
            void subscribe();
            return;
        }
        subscribed.value = false;
    }, { immediate: true });
    return { events, subscribed, subscribe, addEvent, clear };
});
