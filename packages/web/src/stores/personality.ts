import { defineStore } from "pinia";
import { ref } from "vue";
import { useGatewayStore } from "./gateway";

export interface AssistantPersonalityProfile {
  schemaVersion: 2;
  identity: {
    core: string;
    name?: string;
  };
  voice: {
    tone: string[];
    style: string[];
    quirks: string[];
  };
  collaboration: {
    defaults: string[];
    avoidances: string[];
  };
  growth: {
    notes: string[];
  };
  revision: number;
  updatedAt: string;
  updatedBy: "user" | "assistant" | "system";
  reason?: string;
}

export interface AssistantPersonalityInput {
  schemaVersion?: 2;
  identity: {
    core: string;
    name?: string;
  };
  voice: {
    tone: string[];
    style: string[];
    quirks: string[];
  };
  collaboration: {
    defaults: string[];
    avoidances: string[];
  };
  growth: {
    notes: string[];
  };
  reason?: string;
}

function cloneProfile(profile: AssistantPersonalityProfile): AssistantPersonalityProfile {
  return {
    schemaVersion: 2,
    identity: {
      core: profile.identity.core,
      name: profile.identity.name,
    },
    voice: {
      tone: [...profile.voice.tone],
      style: [...profile.voice.style],
      quirks: [...profile.voice.quirks],
    },
    collaboration: {
      defaults: [...profile.collaboration.defaults],
      avoidances: [...profile.collaboration.avoidances],
    },
    growth: {
      notes: [...profile.growth.notes],
    },
    revision: profile.revision,
    updatedAt: profile.updatedAt,
    updatedBy: profile.updatedBy,
    reason: profile.reason,
  };
}

async function parseError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: string };
    return body.error ?? `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

export const usePersonalityStore = defineStore("personality", () => {
  const gateway = useGatewayStore();
  const profile = ref<AssistantPersonalityProfile | null>(null);
  const lastLoaded = ref<AssistantPersonalityProfile | null>(null);
  const loading = ref(false);
  const saving = ref(false);
  const error = ref<string | null>(null);

  function restUrl(path: string): string {
    const wsUrl = gateway.wsUrl ?? "ws://localhost:8765/ws";
    const base = wsUrl.replace(/^ws(s?)/, "http$1").replace(/\/ws$/, "");
    return `${base}${path}`;
  }

  function authHeaders(includeJson = false): Record<string, string> {
    const headers: Record<string, string> = { Authorization: `Bearer ${gateway.token}` };
    if (includeJson) headers["Content-Type"] = "application/json";
    return headers;
  }

  async function fetch(): Promise<void> {
    if (!gateway.token) return;
    loading.value = true;
    error.value = null;
    try {
      const response = await globalThis.fetch(restUrl("/api/personality"), {
        headers: authHeaders(),
      });
      if (!response.ok) throw new Error(await parseError(response));
      const nextProfile = await response.json() as AssistantPersonalityProfile;
      profile.value = cloneProfile(nextProfile);
      lastLoaded.value = cloneProfile(nextProfile);
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      loading.value = false;
    }
  }

  async function save(input: AssistantPersonalityInput): Promise<void> {
    if (!gateway.token) return;
    saving.value = true;
    error.value = null;
    try {
      const response = await globalThis.fetch(restUrl("/api/personality"), {
        method: "PUT",
        headers: authHeaders(true),
        body: JSON.stringify(input),
      });
      if (!response.ok) throw new Error(await parseError(response));
      const nextProfile = await response.json() as AssistantPersonalityProfile;
      profile.value = cloneProfile(nextProfile);
      lastLoaded.value = cloneProfile(nextProfile);
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      saving.value = false;
    }
  }

  async function reset(): Promise<void> {
    if (!gateway.token) return;
    saving.value = true;
    error.value = null;
    try {
      const response = await globalThis.fetch(restUrl("/api/personality/reset"), {
        method: "POST",
        headers: authHeaders(),
      });
      if (!response.ok) throw new Error(await parseError(response));
      const nextProfile = await response.json() as AssistantPersonalityProfile;
      profile.value = cloneProfile(nextProfile);
      lastLoaded.value = cloneProfile(nextProfile);
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      saving.value = false;
    }
  }

  return {
    profile,
    lastLoaded,
    loading,
    saving,
    error,
    fetch,
    save,
    reset,
  };
});