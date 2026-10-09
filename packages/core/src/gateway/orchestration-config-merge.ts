import { OrchestrationSchema, type OrchestrationConfig } from "../config/schemas/orchestration.js";

export type OrchestrationConfigUpdate =
  | { ok: true; value: OrchestrationConfig; stored: Record<string, unknown> }
  | { ok: false; error: string; details: unknown };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Plain objects merge key by key — a cap map keeps the keys the body did not name; arrays and
 * scalars replace. Removing a nested key is a shard edit, not a PUT.
 */
export function mergePlainObjects(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const existing = out[key];
    out[key] = isPlainObject(existing) && isPlainObject(value) ? mergePlainObjects(existing, value) : value;
  }
  return out;
}

/**
 * Merge a PUT body over the stored orchestration section instead of replacing it.
 *
 * OrchestrationSchema fills every absent key with its default, so parsing a partial body and
 * storing the result silently reset every flag the caller did not mention — one dashboard toggle
 * turned the deployment's other sixty switches back to their defaults, and a form that knew one
 * cap tombstoned every cap the shards define. The body is validated as a partial (only the keys
 * it names), merged over the stored section, and the union is validated in full.
 *
 * Two views come back: `value` is the full resolved section (what the API answers with);
 * `stored` is the merged RAW section — only the keys that were stored or sent — which is what
 * the mutator persists, so the store never fills up with materialized defaults.
 */
export function mergeOrchestrationConfigUpdate(stored: unknown, body: unknown): OrchestrationConfigUpdate {
  const partial = OrchestrationSchema.partial().safeParse(body);
  if (!partial.success) {
    return { ok: false, error: "Invalid orchestration configuration", details: partial.error.flatten() };
  }
  const base = isPlainObject(stored) ? stored : {};
  const merged = mergePlainObjects(base, partial.data as Record<string, unknown>);
  const full = OrchestrationSchema.safeParse(merged);
  if (!full.success) {
    return { ok: false, error: "Invalid orchestration configuration", details: full.error.flatten() };
  }
  return { ok: true, value: full.data, stored: merged };
}
