import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { useGatewayStore } from "./gateway";

export type ConfigAssistantMode = "setup" | "enhancement" | "prompt";
export type ConfigAssistantProposalStatus = "pending" | "applied" | "rejected";
export type ConfigAssistantFeedbackOutcome = "success" | "failure" | "partial" | "rejected";
export type FlowMemoryOutcome = "proposed" | "applied" | "success" | "failure" | "partial" | "rejected";
export type FlowMemoryScope = "setup" | "enhancement" | "prompt" | "workflow";

export interface FlowMemoryEntry {
  id: string;
  ts: string;
  scope: FlowMemoryScope;
  request: string;
  summary: string;
  assistantAgent?: string;
  targetAgent?: string;
  actions: string[];
  outcome: FlowMemoryOutcome;
  lesson?: string;
  tags: string[];
}

export interface ConfigAssistantConfigChange {
  path: string;
  value: unknown;
  reason: string;
}

export interface ConfigAssistantPromptChange {
  agentName: string;
  strategy: "replace" | "append";
  prompt: string;
  rationale: string;
}

export interface ConfigAssistantProposalFeedback {
  ts: string;
  outcome: ConfigAssistantFeedbackOutcome;
  lesson?: string;
  notes?: string;
}

export interface ConfigAssistantProposal {
  id: string;
  ts: string;
  status: ConfigAssistantProposalStatus;
  mode: ConfigAssistantMode;
  request: string;
  summary: string;
  assistantAgent: string;
  targetAgent?: string;
  configChanges: ConfigAssistantConfigChange[];
  promptChanges: ConfigAssistantPromptChange[];
  validations: string[];
  tags: string[];
  lesson?: string;
  appliedAt?: string;
  feedbackHistory: ConfigAssistantProposalFeedback[];
}

interface ProposalListResponse {
  proposals: ConfigAssistantProposal[];
  totalEntries: number;
}

interface ProposalCreateResponse {
  proposal: ConfigAssistantProposal;
  flowMemoryId: string;
}

interface FlowMemoryResponse {
  entries: FlowMemoryEntry[];
  totalEntries: number;
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useConfigAssistantStore = defineStore("configAssistant", () => {
  const gateway = useGatewayStore();
  const proposals = ref<ConfigAssistantProposal[]>([]);
  const flowEntries = ref<FlowMemoryEntry[]>([]);
  const loading = ref(false);
  const flowLoading = ref(false);
  const proposing = ref(false);
  const error = ref("");
  const flowError = ref("");
  const proposeError = ref("");
  const mutationError = ref("");
  const activeProposalId = ref<string | null>(null);

  function restUrl(path: string): string {
    return (gateway.wsUrl ?? "ws://localhost:8765/ws").replace(/^ws(s?)/, "http$1").replace(/\/ws$/, "") + path;
  }

  function authHeaders(includeJson = false): Record<string, string> {
    return includeJson
      ? { Authorization: `Bearer ${gateway.token}`, "Content-Type": "application/json" }
      : { Authorization: `Bearer ${gateway.token}` };
  }

  async function parseError(response: Response): Promise<string> {
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.includes("application/json")) {
      try {
        const body = await response.json() as { error?: string; detail?: string };
        return body.error ?? body.detail ?? response.statusText ?? `HTTP ${response.status}`;
      } catch {
        return response.statusText || `HTTP ${response.status}`;
      }
    }

    try {
      const text = (await response.text()).trim();
      return text || response.statusText || `HTTP ${response.status}`;
    } catch {
      return response.statusText || `HTTP ${response.status}`;
    }
  }

  async function fetchProposals(limit = 30): Promise<void> {
    if (!gateway.token) return;
    loading.value = true;
    error.value = "";
    try {
      const response = await window.fetch(restUrl(`/api/config-assistant/proposals?limit=${limit}`), {
        headers: authHeaders(),
      });
      if (!response.ok) throw new Error(await parseError(response));
      const body = await response.json() as ProposalListResponse;
      proposals.value = body.proposals;
    } catch (err) {
      error.value = normalizeError(err);
    } finally {
      loading.value = false;
    }
  }

  async function fetchFlowMemory(limit = 24): Promise<void> {
    if (!gateway.token) return;
    flowLoading.value = true;
    flowError.value = "";
    try {
      const response = await window.fetch(restUrl(`/api/flow-memory?limit=${limit}`), {
        headers: authHeaders(),
      });
      if (!response.ok) throw new Error(await parseError(response));
      const body = await response.json() as FlowMemoryResponse;
      flowEntries.value = body.entries;
    } catch (err) {
      flowError.value = normalizeError(err);
    } finally {
      flowLoading.value = false;
    }
  }

  async function propose(payload: { request: string; mode: ConfigAssistantMode; targetAgent?: string }): Promise<ConfigAssistantProposal | null> {
    if (!gateway.token) return null;
    proposing.value = true;
    proposeError.value = "";
    mutationError.value = "";
    try {
      const response = await window.fetch(restUrl("/api/config-assistant/proposals"), {
        method: "POST",
        headers: authHeaders(true),
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(await parseError(response));
      const body = await response.json() as ProposalCreateResponse;
      proposals.value = [body.proposal, ...proposals.value.filter((proposal) => proposal.id !== body.proposal.id)];
      await fetchFlowMemory();
      return body.proposal;
    } catch (err) {
      proposeError.value = normalizeError(err);
      return null;
    } finally {
      proposing.value = false;
    }
  }

  async function applyProposal(id: string): Promise<ConfigAssistantProposal | null> {
    return mutateProposal(id, `/api/config-assistant/proposals/${encodeURIComponent(id)}/apply`, {});
  }

  async function submitFeedback(
    id: string,
    payload: { outcome: ConfigAssistantFeedbackOutcome; lesson?: string; notes?: string },
  ): Promise<ConfigAssistantProposal | null> {
    return mutateProposal(id, `/api/config-assistant/proposals/${encodeURIComponent(id)}/feedback`, payload);
  }

  async function mutateProposal(id: string, path: string, payload: Record<string, unknown>): Promise<ConfigAssistantProposal | null> {
    if (!gateway.token) return null;
    activeProposalId.value = id;
    mutationError.value = "";
    try {
      const response = await window.fetch(restUrl(path), {
        method: "POST",
        headers: authHeaders(true),
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(await parseError(response));
      const body = await response.json() as { proposal: ConfigAssistantProposal };
      proposals.value = proposals.value.map((proposal) => proposal.id === id ? body.proposal : proposal);
      await fetchFlowMemory();
      return body.proposal;
    } catch (err) {
      mutationError.value = normalizeError(err);
      return null;
    } finally {
      activeProposalId.value = null;
    }
  }

  const recentLearnings = computed(() => flowEntries.value.slice(0, 6));
  const pendingProposals = computed(() => proposals.value.filter((proposal) => proposal.status === "pending"));

  return {
    proposals,
    flowEntries,
    recentLearnings,
    pendingProposals,
    loading,
    flowLoading,
    proposing,
    error,
    flowError,
    proposeError,
    mutationError,
    activeProposalId,
    fetchProposals,
    fetchFlowMemory,
    propose,
    applyProposal,
    submitFeedback,
  };
});