import { OrchestrationSchema, type OrchestrationConfig } from "../config/schemas/orchestration.js";

export type OrchestrationConfigUpdate =
  | { ok: true; value: OrchestrationConfig }
  | { ok: false; error: string; details: unknown };

/**
 * Merge a PUT body over the stored orchestration section instead of replacing it.
 *
 * OrchestrationSchema fills every absent key with its default, so parsing a partial body and
 * storing the result silently reset every flag the caller did not mention — one dashboard toggle
 * turned the deployment's other sixty switches back to their defaults. The body is validated as a
 * partial (only the keys it names), laid over the stored section, and the union is validated in
 * full, so what is stored is always a complete, well-formed section. Top-level keys merge; a nested
 * object named in the body replaces the stored one, which is how the dashboard already sends them.
 */
export function mergeOrchestrationConfigUpdate(stored: unknown, body: unknown): OrchestrationConfigUpdate {
  const partial = OrchestrationSchema.partial().safeParse(body);
  if (!partial.success) {
    return { ok: false, error: "Invalid orchestration configuration", details: partial.error.flatten() };
  }
  const base = stored && typeof stored === "object" && !Array.isArray(stored)
    ? (stored as Record<string, unknown>)
    : {};
  const merged = OrchestrationSchema.safeParse({ ...base, ...partial.data });
  if (!merged.success) {
    return { ok: false, error: "Invalid orchestration configuration", details: merged.error.flatten() };
  }
  return { ok: true, value: merged.data };
}
