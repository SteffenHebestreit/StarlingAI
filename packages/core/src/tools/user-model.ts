/**
 * User-model tools — the agent's reasoned, evolving profile of the user.
 *
 *   user_model_view   (Tier 0) — read the current working model of the user
 *   user_model_update (Tier 1) — revise it as understanding deepens (dialectic)
 *
 * Distinct from memory_store (discrete user-stated facts) and
 * assistant_personality_update (the assistant's own voice).
 */

import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";
import {
  formatUserModelGuidance,
  loadUserModel,
  updateUserModel,
  type UserModelUpdate,
} from "../user-model/service.js";

const log = childLogger("tool:user-model");

function toStringList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return undefined;
}

registerTool({
  name: "user_model_view",
  description:
    "View the agent's evolving model of the current user — their goals, expertise, working style, "
    + "communication preferences, and open questions. Use this to tailor your approach.",
  costHint: "low",
  latencyHint: "low",
  parameters: { type: "object", properties: {} },
  async execute(): Promise<ToolResult> {
    const guidance = formatUserModelGuidance();
    const profile = loadUserModel();
    return {
      success: true,
      output: guidance || "The user model is empty — nothing learned about this user yet.",
      metadata: { revision: profile.revision, updatedAt: profile.updatedAt },
    };
  },
});

registerTool({
  name: "user_model_update",
  description:
    "Revise the agent's model of the user when you learn something durable about how to work with them "
    + "(goals, expertise, workingStyle, communication, openQuestions). append=true adds without replacing. "
    + "Use memory_store for discrete facts; this is for stable understanding of the user.",
  parameters: {
    type: "object",
    properties: {
      goals: { type: "array", items: { type: "string" }, description: "What the user is trying to achieve." },
      expertise: { type: "array", items: { type: "string" }, description: "The user's domains and skill level." },
      workingStyle: { type: "array", items: { type: "string" }, description: "How the user prefers to work." },
      communication: { type: "array", items: { type: "string" }, description: "Tone/format preferences." },
      openQuestions: { type: "array", items: { type: "string" }, description: "Hypotheses about the user you are still verifying." },
      append: { type: "boolean", description: "Append to existing lists instead of replacing them. Default: false." },
      reset: { type: "boolean", description: "Reset the model to empty before applying updates. Default: false." },
    },
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const update: UserModelUpdate = {
      goals: toStringList(args["goals"]),
      expertise: toStringList(args["expertise"]),
      workingStyle: toStringList(args["workingStyle"]),
      communication: toStringList(args["communication"]),
      openQuestions: toStringList(args["openQuestions"]),
      append: args["append"] === true,
      reset: args["reset"] === true,
    };

    try {
      const profile = updateUserModel(update, "assistant");
      logAudit("user_model_updated", {
        revision: profile.revision,
        fields: Object.keys(update).filter((key) => key !== "append" && key !== "reset" && (update as Record<string, unknown>)[key] !== undefined),
      }, { sessionId: ctx.sessionId, severity: "info" });
      log.info({ revision: profile.revision }, "user_model_update");
      return {
        success: true,
        output: `User model updated (revision ${profile.revision}).`,
        metadata: { revision: profile.revision },
      };
    } catch (err) {
      return {
        success: false,
        output: "",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
});
