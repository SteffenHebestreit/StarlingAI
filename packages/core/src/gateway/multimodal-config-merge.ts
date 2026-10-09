import { MultimodalSchema } from "../config/schemas/multimodal.js";
import {
  multimodalSecretDestinations,
  refuseMovedSecrets,
  resolveSecretPlaceholders,
  type SecretEndpointContext,
} from "./config-secrets.js";
import type { z } from "zod";

type MultimodalConfig = z.infer<typeof MultimodalSchema>;

export type MultimodalConfigUpdate =
  | { ok: true; value: MultimodalConfig; stored: Record<string, unknown> }
  | { ok: false; error: string; details: unknown };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Objects merge key by key, `null` removes a key, arrays and scalars replace (JSON merge patch). */
function applyMergePatch(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) {
      delete out[key];
      continue;
    }
    const existing = out[key];
    out[key] = isPlainObject(value) ? applyMergePatch(isPlainObject(existing) ? existing : {}, value) : value;
  }
  return out;
}

/**
 * The patch as it will be stored: only the keys the schema knows (zod strips the rest, and so do
 * we), each leaf as the schema read it. Removals pass through.
 */
function patchAsParsed(patch: Record<string, unknown>, parsed: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isPlainObject(parsed)) return out;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      out[key] = null;
      continue;
    }
    if (!(key in parsed)) continue;
    const read = parsed[key];
    out[key] = isPlainObject(value) && isPlainObject(read) ? patchAsParsed(value, read) : read;
  }
  return out;
}

/**
 * Merge a PUT body over the stored multimodal section instead of replacing it.
 *
 * The route used to store the parsed body as the whole section. The Settings page sends the
 * fields it shows, so zod filled the rest with defaults and the overlay writer tombstoned every
 * key the shards set and the body did not name: one Save click turned off the quality tier and
 * image editing (qualityModel, initImageModels), dropped the engine names, the fixed-size guard,
 * the settings step and the vision timeout, and the loss survived reloads.
 *
 * Now a key the body does not send is kept. A key the body sends as `null` is removed, which is
 * how a client clears an optional field or switches image generation off (`imageGeneration:
 * null`). The union is validated in full.
 *
 * `value` is the full resolved section (what the API answers with); `stored` is the merged RAW
 * section, which is what the mutator persists, so no materialized default is written back.
 */
export function mergeMultimodalConfigUpdate(stored: unknown, body: unknown): MultimodalConfigUpdate {
  if (!isPlainObject(body)) {
    return { ok: false, error: "Invalid multimodal configuration", details: "The body must be a JSON object." };
  }
  const base = isPlainObject(stored) ? stored : {};
  const full = MultimodalSchema.safeParse(applyMergePatch(base, body));
  if (!full.success) {
    return { ok: false, error: "Invalid multimodal configuration", details: full.error.flatten() };
  }
  return { ok: true, value: full.data, stored: applyMergePatch(base, patchAsParsed(body, full.data)) };
}

/**
 * Everything PUT /api/multimodal/config checks before it persists anything, run against the
 * section as the GET served it (`current`). `patch` is the body with its masked keys restored,
 * ready to merge over the raw stored section.
 *
 * The moved-endpoint refusal runs HERE, on the merged result, because the merge is what keeps a
 * key the body leaves out: `{"imageGeneration":{"baseUrl":"https://collector.example"}}` carried
 * no placeholder, so a check on placeholders passed it, and the merge sent the stored key to the
 * new host. The Settings page did the same on every honest endpoint change.
 */
export function checkMultimodalConfigSave(
  current: unknown,
  body: unknown,
  ctx: SecretEndpointContext,
): { ok: true; patch: unknown } | { ok: false; error: string; details: unknown } {
  const patch = resolveSecretPlaceholders(body, current);
  const merged = mergeMultimodalConfigUpdate(current, patch);
  if (!merged.ok) return merged;
  const moved = refuseMovedSecrets(multimodalSecretDestinations(ctx), body, current, merged.value);
  if (!moved.ok) return { ok: false, error: moved.error, details: { field: moved.field } };
  return { ok: true, patch };
}
