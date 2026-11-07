/**
 * Switching the swarm's model in plain words, typed or spoken: "schalte auf Claude um". The same
 * switch as the dashboard's, and as global: every user's next turn runs on the new model, and that
 * model may be a paid one. Hence the approval on every call (guardrails/tool-tiers.ts) and the
 * admin role here. A turn without a person behind it has no approval channel and is refused.
 */
import { getConfig } from "../config/loader.js";
import { getActiveModelPreset, listModelPresets } from "../providers/index.js";
import { changeModelPreset } from "../providers/model-preset-change.js";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";

/** The name for "no preset": the models the configuration sets. */
const CONFIGURED_MODELS = "default";

const fail = (error: string): ToolResult => ({ success: false, output: "", error });

/**
 * Admin only under multi-user auth, and no role means no: a channel turn threads none, and this is
 * not the place to assume one. roleRank is resolved lazily, as in knowledge-bases.ts, to keep this
 * leaf module off the gateway's import graph at load time.
 */
async function adminRefusal(ctx: ToolContext): Promise<ToolResult | null> {
  if (getConfig().auth?.enabled !== true) return null;
  const { roleRank } = await import("../gateway/auth.js");
  if (ctx.userRole && roleRank(ctx.userRole) >= roleRank("admin")) return null;
  return fail(`Switching the model changes it for everyone, so it takes the admin role. The role of this conversation is ${ctx.userRole ? `"${ctx.userRole}"` : "unknown"}. Nothing was switched. Tell the user, and do not try again or look for another way: an admin has to do it.`);
}

registerTool({
  name: "switch_model",
  description:
    "Switch the whole swarm, for every user, to another model setup until someone switches it back. "
    + "Only when the user asks for exactly that. The user approves each call.",
  embeddingDescription:
    "switch change the model swarm local cloud claude preset; auf ein anderes Modell umschalten, zurück auf lokal",
  parameters: {
    type: "object",
    properties: {
      preset: {
        type: "string",
        description: `The setup's name, such as "claude", or "${CONFIGURED_MODELS}" for the configured, usually local, models.`,
      },
    },
    required: ["preset"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const refused = await adminRefusal(ctx);
    if (refused) return refused;

    const config = getConfig();
    const presets = listModelPresets(config);
    const requested = String(args["preset"] ?? "").trim();
    // A preset someone did name "default" stays reachable: it is what they asked for by that name.
    const target = presets.find((preset) => preset.name.toLowerCase() === requested.toLowerCase());
    if (!target && requested.toLowerCase() !== CONFIGURED_MODELS) {
      const names = [...presets.map((preset) => preset.name), CONFIGURED_MODELS].join(", ");
      return fail(`There is no model setup "${requested}". There is: ${names}. Nothing was switched.`);
    }

    const name = target?.name ?? null;
    if ((getActiveModelPreset(config)?.name ?? null) === name) {
      const running = target?.primary ?? config.agents.defaults.model.primary;
      return { success: true, output: `Already on ${target?.label ?? "the configured models"} (${running}). Nothing changed.`, metadata: { changed: false } };
    }

    const updated = changeModelPreset({ preset: name, via: "chat" });
    const active = getActiveModelPreset(updated);
    const label = active && target ? target.label : "the configured models";
    const primary = active?.preset.primary ?? updated.agents.defaults.model.primary;
    return {
      success: true,
      output: `Switched to ${label} (${primary}) for every user, from their next message on. This reply still comes from the model before.`,
      metadata: { changed: true, active: active?.name ?? null, primary },
    };
  },
});
