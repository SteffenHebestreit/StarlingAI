import { defineStore } from "pinia";
import { ref, watch } from "vue";
import { useGatewayStore } from "./gateway";

export interface AuditEvent {
  id: string;
  timestamp: string;
  type: string;
  sessionId?: string;
  channel?: string;
  severity: "info" | "warn" | "error";
  data: Record<string, unknown>;
}

/** How many events the live buffer keeps. Past this the oldest are dropped, and the Audit Log says so. */
export const MAX_AUDIT_EVENTS = 500;

export const useAuditStore = defineStore("audit", () => {
  const events = ref<AuditEvent[]>([]);
  const subscribed = ref(false);
  const gateway = useGatewayStore();

  async function subscribe() {
    if (!subscribed.value && gateway.connected) {
      await gateway.rpc("audit.subscribe");
      subscribed.value = true;
    }
  }

  function addEvent(event: AuditEvent) {
    events.value.unshift(event); // newest first
    if (events.value.length > MAX_AUDIT_EVENTS) {
      events.value.splice(MAX_AUDIT_EVENTS);
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
