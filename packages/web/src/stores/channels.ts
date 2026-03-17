import { defineStore } from "pinia";
import { ref } from "vue";
import { useGatewayStore } from "./gateway";

export interface ChannelOperatorState {
  severity: "ok" | "warning" | "critical";
  summary: string;
}

export interface ChannelDeliveryLatencySummary {
  sampleCount: number;
  lastMs?: number;
  maxMs?: number;
  p50Ms?: number;
  p95Ms?: number;
  p99Ms?: number;
}

export interface ChannelDeliverySloSummary {
  totalDeliveries: number;
  delivered: number;
  failed: number;
  successRatePct: number;
}

export interface ChannelDeliveryWindowSummary extends ChannelDeliverySloSummary {
  windowMs: number;
  maxMs?: number;
  p50Ms?: number;
  p95Ms?: number;
  p99Ms?: number;
}

export interface ChannelMetrics {
  delivered: number;
  deliveryFailures: number;
  ingressDenied: number;
  lastDeliveryError?: string;
  lastIngressDeniedAt?: string;
  deliveryLatency?: ChannelDeliveryLatencySummary;
  deliverySlo?: ChannelDeliverySloSummary;
  deliveryWindows?: {
    last5m?: ChannelDeliveryWindowSummary;
    last1h?: ChannelDeliveryWindowSummary;
  };
}

export interface ChannelDeadLetterEntry {
  channel: string;
  messagePreview: string;
  error: string;
  attempts: number;
  ts?: string;
}

export interface ChannelStatus {
  type: string;
  enabled: boolean;
  running: boolean;
  supported?: boolean;
  reason?: string;
  error?: string;
  health?: {
    healthy: boolean;
    latencyMs?: number;
    error?: string;
    checkedAt?: string;
  };
  metrics?: ChannelMetrics;
  operatorState?: ChannelOperatorState;
}

export interface ChannelDetail {
  type: string;
  source: string;
  config: ChannelConfig;
  status?: ChannelStatus;
  operator?: {
    recentDeadLetters: ChannelDeadLetterEntry[];
    recoveryProcedures: string[];
  };
}

export interface ChannelConfig {
  enabled?: boolean;
  dmPolicy?: string;
  allowFrom?: string[];
  historyLimit?: number;
  perSenderRateLimitCount?: number;
  perSenderRateLimitWindowMs?: number;
  // Telegram
  botToken?: string;
  allowedUserIds?: number[];
  // Slack
  appToken?: string;
  signingSecret?: string;
  // Discord
  token?: string;
  guildIds?: string[];
  // WhatsApp
  verifyToken?: string;
  appSecret?: string;
  accessToken?: string;
  phoneNumberId?: string;
  // Email
  imapHost?: string;
  imapPort?: number;
  imapUser?: string;
  imapPassword?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPassword?: string;
  smtpFrom?: string;
  // Signal
  account?: string;
  signalCliPath?: string;
}

export const useChannelsStore = defineStore("channels", () => {
  const gateway = useGatewayStore();
  const channels = ref<ChannelStatus[]>([]);
  const loading = ref(false);
  const error = ref("");
  const deadLetterCount = ref(0);
  const deadLetters = ref<ChannelDeadLetterEntry[]>([]);

  function baseUrl(): string {
    return (gateway.wsUrl ?? "ws://localhost:8765/ws").replace(/^ws/, "http").replace(/\/ws$/, "");
  }

  async function fetch(): Promise<void> {
    if (!gateway.token) return;
    loading.value = true;
    error.value = "";
    try {
      const res = await window.fetch(`${baseUrl()}/api/channels`, {
        headers: { Authorization: `Bearer ${gateway.token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      channels.value = await res.json() as ChannelStatus[];
    } catch (err) {
      error.value = String(err);
    } finally {
      loading.value = false;
    }
  }

  async function fetchDeadLetterCount(): Promise<void> {
    if (!gateway.token) return;
    try {
      const res = await window.fetch(`${baseUrl()}/api/channels/dead-letters`, {
        headers: { Authorization: `Bearer ${gateway.token}` },
      });
      if (!res.ok) return;
      const data = await res.json() as { count: number; entries?: ChannelDeadLetterEntry[] };
      deadLetterCount.value = data.count ?? 0;
      deadLetters.value = data.entries ?? [];
    } catch { /* non-critical */ }
  }

  async function fetchDetails(type: string): Promise<ChannelDetail | null> {
    if (!gateway.token) return null;
    try {
      const res = await window.fetch(`${baseUrl()}/api/channels/${type}`, {
        headers: { Authorization: `Bearer ${gateway.token}` },
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      return await res.json() as ChannelDetail;
    } catch (err) {
      error.value = String(err);
      return null;
    }
  }

  async function fetchConfig(type: string): Promise<ChannelConfig | null> {
    const detail = await fetchDetails(type);
    return detail?.config ?? null;
  }

  async function save(type: string, config: ChannelConfig): Promise<void> {
    if (!gateway.token) return;
    loading.value = true;
    error.value = "";
    try {
      const res = await window.fetch(`${baseUrl()}/api/channels/${type}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${gateway.token}` },
        body: JSON.stringify(config),
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      await fetch();
    } catch (err) {
      error.value = String(err);
    } finally {
      loading.value = false;
    }
  }

  async function remove(type: string): Promise<void> {
    if (!gateway.token) return;
    loading.value = true;
    error.value = "";
    try {
      const res = await window.fetch(`${baseUrl()}/api/channels/${type}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${gateway.token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fetch();
    } catch (err) {
      error.value = String(err);
    } finally {
      loading.value = false;
    }
  }

  return { channels, loading, error, deadLetterCount, deadLetters, fetch, fetchDeadLetterCount, fetchDetails, fetchConfig, save, remove };
});
