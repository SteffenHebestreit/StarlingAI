/**
 * What setup does with the SAI_MASTER_KEY it finds in .env.
 *
 * The master key seals the credential store (packages/core/src/credentials/store.ts: AES-256-GCM
 * under scrypt(SAI_MASTER_KEY, <store>.salt)). A key copied from a template is public, so it seals
 * nothing; setup replaces it. But a key that already sealed data cannot simply be replaced: the data
 * would stay behind, unreadable under the new key. Setup then keeps the key and says how to rotate.
 *
 * Node built-ins only: scripts/setup-wizard.mjs imports this inside a bare node:22-alpine container.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/** The value .env.example shipped for SAI_MASTER_KEY before it was left empty. */
export const SHIPPED_MASTER_KEY_PLACEHOLDER = "your-256-bit-master-key-for-credential-encryption";

/** The credential store refuses a shorter key (credentials/store.ts). */
export const MIN_MASTER_KEY_LENGTH = 32;

/**
 * Fragments that betray a template value, case-insensitive. The gateway warns at boot about a secret
 * that contains one (PLACEHOLDER_FRAGMENTS in packages/core/src/observability/secret-hygiene.ts);
 * every fragment here must also be one there, so setup never replaces a key the gateway accepts.
 */
export const PLACEHOLDER_FRAGMENTS = [
  "your-256-bit",
  "change-me",
  "changeme",
  "your-example",
  "example-secret",
  "example-key",
  "placeholder",
  "replace-with",
];

/** True for a value copied from a template, such as the master key .env.example used to ship. */
export function isPlaceholderSecret(value) {
  const lower = String(value ?? "").trim().toLowerCase();
  return lower !== "" && PLACEHOLDER_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

/**
 * The directories that can hold a state directory with data sealed with the repo's key, as
 * `sai reset` knows them (MEMORY_FLATFILE_ZONES in scripts/sai.mjs), plus the home directory:
 * - the repo root: docker-compose.yml pins SAI_CRED_STORE to it, and CLIs run there use <cwd>/<stateDir>;
 * - workspace/: the host side of SAI_WORKSPACE_CONFIG_PATH, where workspace-rooted state lives;
 * - packages/core/ (and its workspace/): the cwd of the host dev gateway and of the core CLIs;
 * - the home directory: the credential store's fallback, ~/<stateDir>/credentials.enc.
 */
export function stateRoots({ cwd, home }) {
  const roots = ["", "workspace", join("packages", "core"), join("packages", "core", "workspace")]
    .map((dir) => resolve(cwd, dir));
  if (home) roots.push(resolve(home));
  return roots;
}

const isSealedName = (name) => name === "credentials.enc" || name.endsWith(".salt");

/**
 * Files that hold data sealed with the current master key: the credential store (credentials.enc)
 * and every scrypt salt file (*.salt), which each store that derives its key from SAI_MASTER_KEY
 * keeps beside its data. Looks at `credStore` (SAI_CRED_STORE, resolved against `cwd`) and walks each
 * state directory `<root>/<name>` for every root (default: `cwd` alone) and every name. A link
 * with a matching name counts without being read; a link to a directory is walked like one, within
 * the same depth and entry bounds. A directory it cannot read, and a state directory larger than
 * `maxEntries`, count as sealed: setup must not rotate the key over data it did not see.
 */
export function findSealedStores({ cwd, roots = [cwd], stateDirNames, credStore, maxDepth = 4, maxEntries = 20000 }) {
  const found = new Set();
  if (credStore?.trim()) {
    const path = resolve(cwd, credStore.trim());
    if (existsSync(path)) found.add(path);
  }
  const stateDirs = new Set(roots.flatMap((root) => stateDirNames.map((name) => resolve(root, name))));
  for (const stateDir of stateDirs) {
    if (!existsSync(stateDir)) continue;
    let seen = 0;
    const pending = [{ dir: stateDir, depth: 0 }];
    while (pending.length > 0) {
      const { dir, depth } = pending.pop();
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        found.add(dir);
        continue;
      }
      seen += entries.length;
      if (seen > maxEntries) {
        found.add(stateDir);
        break;
      }
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if ((entry.isFile() || entry.isSymbolicLink()) && isSealedName(entry.name)) {
          found.add(path);
        } else if (depth < maxDepth && (entry.isDirectory() || (entry.isSymbolicLink() && isLinkedDirectory(path)))) {
          pending.push({ dir: path, depth: depth + 1 });
        }
      }
    }
  }
  return [...found];
}

function isLinkedDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false; // a dangling link holds nothing
  }
}

/**
 * Setup's decision for the SAI_MASTER_KEY in .env:
 * - `{ action: "generate", reason: "missing" | "short" }` for no key, or one the credential store refuses;
 * - `{ action: "generate", reason: "placeholder" }` for a template value that seals nothing yet;
 * - `{ action: "keep", reason: "placeholder-sealed", sealedStores }` for a template value that already
 *   seals data (replacing it would leave that data unreadable);
 * - `{ action: "keep" }` for a real key.
 * `findSealed` returns the sealed files (see findSealedStores); it runs only for a template value.
 */
export function decideMasterKey(current, findSealed) {
  const value = String(current ?? "");
  if (!value) return { action: "generate", reason: "missing" };
  if (value.length < MIN_MASTER_KEY_LENGTH) return { action: "generate", reason: "short" };
  if (!isPlaceholderSecret(value)) return { action: "keep" };
  const sealedStores = findSealed();
  return sealedStores.length === 0
    ? { action: "generate", reason: "placeholder" }
    : { action: "keep", reason: "placeholder-sealed", sealedStores };
}

/** Where setup keeps the master keys it replaced, inside its state directory. */
export const REPLACED_KEYS_FILE = "replaced-master-keys.txt";

/**
 * Appends a master key setup is about to replace to `<dir>/replaced-master-keys.txt` (owner-only), so
 * that a wrong "nothing is sealed" decision can be undone: data sealed with the old key, by a store
 * the scan does not know or by a gateway that kept running on the old key, becomes readable again
 * once the old value is back in .env. Returns the file's path.
 */
export function keepReplacedKey({ dir, value, reason, now = new Date() }) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, REPLACED_KEYS_FILE);
  appendFileSync(
    file,
    `# ${now.toISOString()}: replaced by setup (${reason}). Data sealed with it is readable only with this value as SAI_MASTER_KEY in .env.\n`
      + `SAI_MASTER_KEY=${value}\n`,
    { mode: 0o600 },
  );
  return file;
}
