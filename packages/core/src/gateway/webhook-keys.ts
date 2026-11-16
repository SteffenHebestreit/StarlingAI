/**
 * Webhook-key authentication for `POST /api/scenes/:name/run` and `POST /api/jobs/:name/run`.
 *
 * Both routes take a resource's own webhook key in place of a gateway token. Reading that key meant
 * looking the named resource up first, and the lookup costs more for a name that exists (a stored
 * job is parsed and validated) than for one that does not (one store miss). So even with the same
 * 401 for both, a caller with no credential could tell the names apart by timing the answer, and
 * sending any `?key=` forced the lookup.
 *
 * Instead the keys of every scene and job are indexed by their SHA-256 digest. A presented key is
 * digested and looked up, and the name is admitted only if that key belongs to it. The work done
 * before the answer depends on the presented key, never on the name, so the name is looked up only
 * after the caller is authenticated. Looking a digest up in a map is safe where comparing the raw
 * key would not be: what its timing could reveal is how close the digest of a guess is to the
 * digest of a real key, and that says nothing about the key.
 *
 * The index is built from config and the credential store and built again when either changes
 * (a scene or job saved or deleted, a config reload), or when an environment variable a `$NAME`
 * key refers to changes.
 */
import { createHash } from "node:crypto";
import { getConfig } from "../config/loader.js";
import type { Config } from "../config/schema.js";
import { credentialStoreRevision } from "../credentials/store.js";
import { listAllScenes } from "../credentials/scenes.js";
import { getApiWebhookKeys, listAllJobs } from "../credentials/jobs.js";

/** A webhook key shorter than this never authenticates (the config schema's minimum). */
const MIN_WEBHOOK_KEY_LENGTH = 16;

type WebhookKeyKind = "scene" | "job";

interface WebhookKeyIndex {
  config: Config;
  storeRevision: number;
  /** The environment variables `$NAME` keys refer to, and their values when the index was built. */
  envNames: string[];
  envValues: string;
  /** Hex SHA-256 of a resolved key → the names of the scenes (or jobs) it opens. */
  digests: Record<WebhookKeyKind, Map<string, Set<string>>>;
}

let index: WebhookKeyIndex | null = null;

/** A configured key: a `$NAME` reference reads the environment variable NAME. */
export function resolveWebhookSecret(secret: string | undefined): string {
  if (!secret) return "";
  return secret.startsWith("$") ? (process.env[secret.slice(1)] ?? "") : secret;
}

function digestHex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function envSnapshot(names: string[]): string {
  return JSON.stringify(names.map((name) => process.env[name] ?? null));
}

function buildIndex(): WebhookKeyIndex {
  const digests: WebhookKeyIndex["digests"] = { scene: new Map(), job: new Map() };
  const envNames = new Set<string>();
  const add = (kind: WebhookKeyKind, name: string, key: string | undefined) => {
    if (key?.startsWith("$")) envNames.add(key.slice(1));
    const resolved = resolveWebhookSecret(key);
    if (resolved.length < MIN_WEBHOOK_KEY_LENGTH) return;
    const digest = digestHex(resolved);
    const names = digests[kind].get(digest) ?? new Set<string>();
    names.add(name);
    digests[kind].set(digest, names);
  };
  for (const scene of listAllScenes()) add("scene", scene.name, scene.webhookKey);
  for (const job of listAllJobs()) {
    for (const key of getApiWebhookKeys(job)) add("job", job.name, key);
  }
  const names = [...envNames];
  return { config: getConfig(), storeRevision: credentialStoreRevision(), envNames: names, envValues: envSnapshot(names), digests };
}

function currentIndex(): WebhookKeyIndex {
  if (
    !index ||
    index.config !== getConfig() ||
    index.storeRevision !== credentialStoreRevision() ||
    index.envValues !== envSnapshot(index.envNames)
  ) {
    index = buildIndex();
  }
  return index;
}

/**
 * Whether `presented` is a webhook key of the scene (or job) `name`. It never looks `name` up: an
 * empty key is refused at once, and any other key costs one digest and one map lookup, whether or
 * not `name` exists.
 */
export function webhookKeyAdmits(kind: WebhookKeyKind, name: string, presented: string): boolean {
  if (presented.length === 0) return false;
  return currentIndex().digests[kind].get(digestHex(presented))?.has(name) ?? false;
}
