import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { useGatewayStore } from "./gateway";

export interface ModelPresetDescriptor {
  name: string;
  label: string;
  primary: string;
  implicit: boolean;
}

/**
 * The dashboard "Local ⇄ Claude" model switch. Mirrors the gateway's
 * GET/POST /api/models/preset: presets are named alternates for the default
 * chat model (an implicit "claude" preset appears whenever the Anthropic
 * provider is credentialed); activating one swaps the whole swarm onto that
 * model with the local model kept as fallback.
 */
export const useModelPresetStore = defineStore("modelPreset", () => {
  const gateway = useGatewayStore();

  const active = ref<string | null>(null);
  const activePrimary = ref<string | null>(null);
  const defaultPrimary = ref("");
  const presets = ref<ModelPresetDescriptor[]>([]);
  const loaded = ref(false);
  const switching = ref(false);
  const error = ref("");

  // Claude subscription OAuth (browser verification) state.
  const oauthConnected = ref(false);
  const oauthExpiresAt = ref<string | null>(null);
  const oauthBusy = ref(false);
  const oauthError = ref("");

  // Which Claude model the implicit "claude" preset uses (providers.anthropic.defaultModel).
  const anthropicModel = ref("claude-sonnet-4-6");
  const anthropicModelChoices = ref<Array<{ id: string; label: string; hint: string }>>([]);
  const modelSaving = ref(false);
  const modelError = ref("");

  const available = computed(() => presets.value.length > 0);

  function baseUrl(): string {
    return (gateway.wsUrl ?? "ws://localhost:8765/ws").replace(/^ws/, "http").replace(/\/ws$/, "");
  }

  function applyState(state: { active: string | null; activePrimary: string | null; defaultPrimary: string; presets: ModelPresetDescriptor[] }): void {
    active.value = state.active;
    activePrimary.value = state.activePrimary;
    defaultPrimary.value = state.defaultPrimary;
    presets.value = state.presets;
    loaded.value = true;
  }

  async function fetch(): Promise<void> {
    if (!gateway.token) return;
    error.value = "";
    try {
      const res = await window.fetch(`${baseUrl()}/api/models/preset`, {
        headers: { Authorization: `Bearer ${gateway.token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      applyState(await res.json());
    } catch (err) {
      error.value = String(err);
    }
  }

  /** Activate a preset by name, or null to return to the configured local default. */
  async function activate(name: string | null): Promise<void> {
    if (!gateway.token || switching.value) return;
    switching.value = true;
    error.value = "";
    try {
      const res = await window.fetch(`${baseUrl()}/api/models/preset`, {
        method: "POST",
        headers: { Authorization: `Bearer ${gateway.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ preset: name }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      applyState(await res.json());
    } catch (err) {
      error.value = String(err);
    } finally {
      switching.value = false;
    }
  }

  async function fetchOAuthStatus(): Promise<void> {
    if (!gateway.token) return;
    try {
      const res = await window.fetch(`${baseUrl()}/api/models/anthropic/oauth/status`, {
        headers: { Authorization: `Bearer ${gateway.token}` },
      });
      if (!res.ok) return;
      const body = await res.json() as { connected: boolean; expiresAt: string | null };
      oauthConnected.value = body.connected;
      oauthExpiresAt.value = body.expiresAt;
    } catch {
      // status is best-effort; leave prior values
    }
  }

  /** Step 1 of the browser login: get the authorize URL + the PKCE
   *  verifier/state this dashboard (the OAuth client) holds until completion. */
  async function startOAuth(): Promise<{ authorizeUrl: string; verifier: string; state: string } | null> {
    if (!gateway.token) return null;
    oauthError.value = "";
    try {
      const res = await window.fetch(`${baseUrl()}/api/models/anthropic/oauth/start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${gateway.token}`, "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      oauthError.value = String(err);
      return null;
    }
  }

  /** Step 2: exchange the pasted code for a token set (stored encrypted server-side). */
  async function completeOAuth(code: string, verifier: string, state: string): Promise<boolean> {
    if (!gateway.token) return false;
    oauthBusy.value = true;
    oauthError.value = "";
    try {
      const res = await window.fetch(`${baseUrl()}/api/models/anthropic/oauth/complete`, {
        method: "POST",
        headers: { Authorization: `Bearer ${gateway.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ code, verifier, state }),
      });
      const body = await res.json().catch(() => null) as { connected?: boolean; expiresAt?: string; error?: string } | null;
      if (!res.ok || !body?.connected) throw new Error(body?.error ?? `HTTP ${res.status}`);
      oauthConnected.value = true;
      oauthExpiresAt.value = body.expiresAt ?? null;
      await fetch(); // the implicit "claude" preset now exists
      return true;
    } catch (err) {
      oauthError.value = String(err instanceof Error ? err.message : err);
      return false;
    } finally {
      oauthBusy.value = false;
    }
  }

  async function fetchAnthropicModel(): Promise<void> {
    if (!gateway.token) return;
    try {
      const res = await window.fetch(`${baseUrl()}/api/models/anthropic/model`, {
        headers: { Authorization: `Bearer ${gateway.token}` },
      });
      if (!res.ok) return;
      const body = await res.json() as { model: string; choices: Array<{ id: string; label: string; hint: string }> };
      anthropicModel.value = body.model;
      anthropicModelChoices.value = body.choices;
    } catch {
      // best-effort; keep prior values
    }
  }

  /** Set the Claude model used by the implicit "claude" preset (persisted in the runtime overlay). */
  async function setAnthropicModel(model: string): Promise<boolean> {
    if (!gateway.token || modelSaving.value) return false;
    modelSaving.value = true;
    modelError.value = "";
    try {
      const res = await window.fetch(`${baseUrl()}/api/models/anthropic/model`, {
        method: "POST",
        headers: { Authorization: `Bearer ${gateway.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      });
      const body = await res.json().catch(() => null) as
        | { model?: string; active?: string | null; activePrimary?: string | null; defaultPrimary?: string; presets?: ModelPresetDescriptor[]; error?: string }
        | null;
      if (!res.ok || !body?.model) throw new Error(body?.error ?? `HTTP ${res.status}`);
      anthropicModel.value = body.model;
      if (body.presets) {
        applyState({
          active: body.active ?? null,
          activePrimary: body.activePrimary ?? null,
          defaultPrimary: body.defaultPrimary ?? defaultPrimary.value,
          presets: body.presets,
        });
      }
      return true;
    } catch (err) {
      modelError.value = String(err instanceof Error ? err.message : err);
      return false;
    } finally {
      modelSaving.value = false;
    }
  }

  async function disconnectOAuth(): Promise<void> {
    if (!gateway.token) return;
    oauthBusy.value = true;
    oauthError.value = "";
    try {
      const res = await window.fetch(`${baseUrl()}/api/models/anthropic/oauth/disconnect`, {
        method: "POST",
        headers: { Authorization: `Bearer ${gateway.token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      oauthConnected.value = false;
      oauthExpiresAt.value = null;
      await fetch();
    } catch (err) {
      oauthError.value = String(err);
    } finally {
      oauthBusy.value = false;
    }
  }

  return {
    active, activePrimary, defaultPrimary, presets, loaded, switching, error, available,
    oauthConnected, oauthExpiresAt, oauthBusy, oauthError,
    anthropicModel, anthropicModelChoices, modelSaving, modelError,
    fetch, activate, fetchOAuthStatus, startOAuth, completeOAuth, disconnectOAuth,
    fetchAnthropicModel, setAnthropicModel,
  };
});
