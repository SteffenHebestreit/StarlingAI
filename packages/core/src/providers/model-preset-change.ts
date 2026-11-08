/**
 * Changing the active model preset, from the dashboard's switch (gateway/model-preset-routes.ts) or
 * from a sentence in the chat (tools/model-switch.ts). Takes a preset the caller has checked
 * exists: what to say about one that does not differs between the two.
 */
import { logAudit } from "../audit/logger.js";
import { getConfig, updateConfig } from "../config/loader.js";
import type { Config } from "../config/schema.js";
import { getActiveModelPreset } from "./index.js";

export const MODEL_PRESET_SCOPES = ["all", "unspecified", "coordinator_qa"] as const;
export type ModelPresetScope = (typeof MODEL_PRESET_SCOPES)[number];

export interface ModelPresetChange {
  /** The preset to activate; null goes back to the configured default. Left out, it stays as it is. */
  preset?: string | null;
  /** Left out, it stays as it is. */
  scope?: ModelPresetScope;
  via: "dashboard" | "chat";
}

/**
 * Who may change the model setup: the preset, the Claude account behind the "claude" one, and the
 * Claude model it runs. That is one setting for every user, and the model may be a paid one, so
 * under multi-user auth it is an admin's, and no role means no. Without auth there is one operator
 * and nobody else to ask. The chat's switch_model and every writing /api/models route ask here.
 * roleRank is resolved lazily to keep this module off the gateway's import graph at load time.
 */
export async function mayChangeModelSetup(role: string | undefined): Promise<boolean> {
  if (getConfig().auth?.enabled !== true) return true;
  if (!role) return false;
  const { roleRank } = await import("../gateway/auth.js");
  return roleRank(role) >= roleRank("admin");
}

export function changeModelPreset(change: ModelPresetChange): Config {
  const config = getConfig();
  const previous = config.agents.defaults.activeModelPreset ?? null;
  const previousScope = config.agents.defaults.modelPresetScope ?? "all";

  const updated = updateConfig((raw) => {
    const agents = (raw["agents"] as Record<string, unknown> | undefined) ?? {};
    const defaults = (agents["defaults"] as Record<string, unknown> | undefined) ?? {};
    const nextDefaults = { ...defaults };
    // "" (falsy → no active preset) instead of delete: the runtime overlay is
    // a diff against the base config, so a deletion could not switch the
    // preset off if the base config ever sets one.
    if (change.preset !== undefined) nextDefaults["activeModelPreset"] = change.preset ?? "";
    if (change.scope !== undefined) nextDefaults["modelPresetScope"] = change.scope;
    raw["agents"] = { ...agents, defaults: nextDefaults };
  });

  const active = getActiveModelPreset(updated);
  logAudit("model_preset_switched", {
    from: previous,
    to: active?.name ?? null,
    primary: active?.preset.primary ?? updated.agents.defaults.model.primary,
    scopeFrom: previousScope,
    scopeTo: updated.agents.defaults.modelPresetScope ?? "all",
    via: change.via,
  });
  return updated;
}
