import { defineStore } from "pinia";
import { ref } from "vue";
import { useGatewayStore } from "./gateway";

export interface AgentModelConfig {
  primary?: string;
  baseUrl?: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  repeatPenalty?: number;
  seed?: number;
  contextWindow?: number;
  /** Qwen3.5 thinking toggle. true = on, false = off, undefined = model default. */
  enableThinking?: boolean;
}

export interface AgentInfo {
  name: string;
  description: string;
  capabilities?: string[];
  tags?: string[];
  model: AgentModelConfig;
  maxIterations?: number;
}

export interface AgentRoutingCandidate {
  name: string;
  description: string;
  model: string;
  confidence: "high" | "medium" | "low";
  score: number;
  matchedTerms: string[];
  capabilities: string[];
  tags: string[];
}

export interface AgentRoutingResolution {
  query: string;
  minConfidence: "high" | "medium" | "low";
  mode: "keyword" | "hybrid";
  results: AgentRoutingCandidate[];
  weakCandidates: AgentRoutingCandidate[];
  gated: boolean;
}

export const useAgentsStore = defineStore("agents", () => {
  const agents = ref<AgentInfo[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const routingResult = ref<AgentRoutingResolution | null>(null);
  const routingLoading = ref(false);
  const routingError = ref<string | null>(null);

  function restUrl(path: string): string {
    const gateway = useGatewayStore();
    const base = (gateway.wsUrl ?? "ws://localhost:8765/ws").replace(/^ws(s?)/, "http$1").replace(/\/ws$/, "");
    return `${base}${path}`;
  }

  function authHeaders(): Record<string, string> {
    const gateway = useGatewayStore();
    return { Authorization: `Bearer ${gateway.token}`, "Content-Type": "application/json" };
  }

  async function fetch() {
    loading.value = true;
    error.value = null;
    try {
      const res = await globalThis.fetch(restUrl("/api/agents"), { headers: authHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      agents.value = await res.json() as AgentInfo[];
    } catch (e) {
      error.value = String(e);
    } finally {
      loading.value = false;
    }
  }

  /**
   * `null` for a field means CLEAR IT — the server deletes the key and the agent falls back to
   * the derived/default value. It cannot be `undefined`: JSON.stringify drops undefined
   * properties, so an emptied field used to send `{}` and the old value simply stayed.
   */
  async function patchModel(name: string, patch: Partial<Record<keyof AgentModelConfig, unknown>>) {
    error.value = null;
    // Optimistic update — a cleared key is removed locally too, so the input shows its
    // placeholder immediately instead of snapping back to the value it just cleared.
    const agent = agents.value.find(a => a.name === name);
    if (agent) {
      const next = { ...agent.model } as Record<string, unknown>;
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete next[key];
        else next[key] = value;
      }
      agent.model = next as AgentModelConfig;
    }
    try {
      const res = await globalThis.fetch(restUrl(`/api/agents/${name}/model`), {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const updated = await res.json() as { name: string; model: AgentModelConfig };
      if (agent) agent.model = updated.model;
    } catch (e) {
      error.value = String(e);
      // Revert by re-fetching
      await fetch();
    }
  }

  async function resolve(query: string, minConfidence: "high" | "medium" | "low") {
    routingLoading.value = true;
    routingError.value = null;
    try {
      const params = new URLSearchParams({ query, minConfidence });
      const res = await globalThis.fetch(restUrl(`/api/agents/resolve?${params.toString()}`), {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      routingResult.value = await res.json() as AgentRoutingResolution;
    } catch (e) {
      routingError.value = String(e);
      routingResult.value = null;
    } finally {
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
