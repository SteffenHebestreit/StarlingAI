/**
 * `pnpm e2e:setup [--remove]` — the LOCAL accounts the harness logs in as:
 *   eval         role operator
 *   eval-viewer  role viewer
 *
 * Writes config/gateway/31-e2e.local.jsonc = { auth: { users: [...] } } with bcrypt hashes from
 * the gateway's own hashPassword, and the plaintext passwords ONLY to
 * eval/e2e/.credentials.local.json (both git-ignored). It touches nothing else in auth — not
 * `enabled`, not `provider`: POST /api/auth/login checks auth.users whatever the provider is, and
 * the token it mints carries the account's role. Then it runs `sai config build`, so the gateway,
 * which mounts the compiled starlingai.json and reloads it, picks the accounts up.
 *
 * It also writes config/mail/accounts.d/00-e2e-isolation.json5 = { accounts: [], isolatedUsers:
 * ["eval", "eval-viewer"] }: the mail-service unites isolatedUsers across its overlay documents and
 * withholds every SHARED account (one without allowedUsers) from those users, so an eval turn can
 * never read or send from the operator's real mailboxes — whenever the eval accounts exist, not
 * only while `pnpm e2e:env up` has the GreenMail account in place. (.json5 and config/mail/ both
 * stay out of `sai config build`; the mail-service re-reads the directory while it runs.)
 *
 * Config arrays REPLACE each other when shards merge, so the shard would silently erase (or be
 * erased by) any other auth.users. Setup therefore refuses while another shard, or the runtime
 * overlay, defines accounts — and writes nothing.
 *
 * Idempotent: accounts already in place whose passwords still verify are kept as they are.
 * `--remove` deletes the three files and rebuilds. Passwords are never printed.
 *
 * SAI_CONFIG_PATH (a config directory) and SAI_WORKSPACE_CONFIG_PATH point setup at another
 * config tree; the build then is skipped, because `sai config build` always builds the
 * repository's own config/ into its own starlingai.json.
 */
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import JSON5 from "json5";
import bcrypt from "bcryptjs";
import { hashPassword } from "../gateway/auth.js";
import { compareShardPaths, isNonConfigShardDirectory, NON_CONFIG_BASE_ZONES, NON_CONFIG_WORKSPACE_ZONES } from "../tools/workspace-path.js";
import { isRecord } from "./gateway-client.js";
import type { E2EIdentity } from "./scenario.js";

export interface E2EAccountSpec {
  identity: E2EIdentity;
  username: string;
  role: "operator" | "viewer";
  displayName: string;
}

export const E2E_ACCOUNTS: readonly E2EAccountSpec[] = [
  { identity: "eval", username: "eval", role: "operator", displayName: "E2E eval (operator)" },
  { identity: "eval-viewer", username: "eval-viewer", role: "viewer", displayName: "E2E eval (viewer)" },
];

export const E2E_SHARD_FILE = "31-e2e.local.jsonc";
export const E2E_MAIL_ISOLATION_FILE = "00-e2e-isolation.json5";

/** The isolation-only mail overlay document: no account, just the users kept off shared accounts. */
export const E2E_MAIL_ISOLATION_DOCUMENT = { accounts: [] as never[], isolatedUsers: ["eval", "eval-viewer"] };

export interface SetupPaths {
  repoRoot: string;
  configDir: string;
  workspaceDir: string | null;
  /** The runtime overlay laid over every shard (workspace/runtime/runtime.overrides.json). */
  mutableOverlayPath: string | null;
  shardPath: string;
  credentialsPath: string;
  /** config/mail/accounts.d/00-e2e-isolation.json5 — the mail-service overlay that isolates eval. */
  mailIsolationPath: string;
  /** The config dir is the repository's own config/, which `sai config build` builds. */
  canBuild: boolean;
}

export class SetupRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupRefusedError";
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function samePath(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function resolveSetupPaths(
  repoRoot: string,
  credentialsPath: string,
  env: NodeJS.ProcessEnv = process.env,
): { paths: SetupPaths; warnings: string[] } {
  const warnings: string[] = [];
  const repoConfig = join(repoRoot, "config");
  const explicitConfig = env["SAI_CONFIG_PATH"]?.trim();
  let configDir = repoConfig;
  let workspaceDir: string | null = isDirectory(join(repoRoot, "workspace")) ? join(repoRoot, "workspace") : null;
  if (explicitConfig) {
    if (isDirectory(explicitConfig)) {
      configDir = resolve(explicitConfig);
      const explicitWorkspace = env["SAI_WORKSPACE_CONFIG_PATH"]?.trim();
      workspaceDir = explicitWorkspace ? resolve(explicitWorkspace) : null;
    } else {
      warnings.push(`SAI_CONFIG_PATH (${explicitConfig}) is not a config directory; using ${repoConfig}`);
    }
  }
  const explicitMutable = env["SAI_MUTABLE_CONFIG_PATH"]?.trim();
  const mutableOverlayPath = explicitMutable
    ? (isDirectory(explicitMutable) ? join(resolve(explicitMutable), "runtime", "runtime.overrides.json") : resolve(explicitMutable))
    : join(workspaceDir ?? configDir, "runtime", "runtime.overrides.json");
  return {
    paths: {
      repoRoot,
      configDir,
      workspaceDir,
      mutableOverlayPath,
      shardPath: join(configDir, "gateway", E2E_SHARD_FILE),
      credentialsPath,
      mailIsolationPath: join(configDir, "mail", "accounts.d", E2E_MAIL_ISOLATION_FILE),
      canBuild: samePath(configDir, repoConfig),
    },
    warnings,
  };
}

/** Config shards of one directory, in merge order — the sweep the config loader does (config/mail/
 *  and the workspace's working zones are not config). */
function collectShards(directory: string, zones: ReadonlySet<string>): string[] {
  if (!isDirectory(directory)) return [];
  const shards: string[] = [];
  const visit = (current: string, depth: number): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!isNonConfigShardDirectory(entry.name, depth, zones)) visit(path, depth + 1);
        continue;
      }
      const extension = extname(entry.name).toLowerCase();
      if (!entry.isFile() || (extension !== ".json" && extension !== ".jsonc")) continue;
      if (entry.name === "runtime.overrides.json") continue;
      shards.push(path);
    }
  };
  visit(directory, 0);
  return shards.sort(compareShardPaths(directory));
}

interface ShardScan {
  conflicts: string[];
  /** auth.enabled as the shards leave it (undefined: never set). */
  authEnabled: boolean | undefined;
}

/**
 * Why the eval accounts cannot be written, from every shard the gateway would merge. Empty when
 * nothing else defines auth.users. A non-empty list anywhere conflicts (one list would replace
 * the other); an empty list conflicts only when it merges after ours, since it would erase it.
 */
export function scanAuthUsers(paths: SetupPaths): ShardScan {
  const conflicts: string[] = [];
  let authEnabled: boolean | undefined;
  const show = (path: string): string => relative(paths.repoRoot, path).split("\\").join("/") || path;
  const ordered = [
    ...collectShards(paths.configDir, NON_CONFIG_BASE_ZONES).map((path) => ({ path, zone: "config" as const })),
    ...(paths.workspaceDir ? collectShards(paths.workspaceDir, NON_CONFIG_WORKSPACE_ZONES).map((path) => ({ path, zone: "workspace" as const })) : []),
  ];
  const ownKey = relative(paths.configDir, paths.shardPath).split("\\").join("/");
  const mergesAfterOurs = (path: string, zone: "config" | "workspace"): boolean =>
    zone === "workspace" || relative(paths.configDir, path).split("\\").join("/") > ownKey;

  const inspect = (path: string, raw: unknown, after: boolean, label: string): void => {
    if (!isRecord(raw)) return;
    const removals = raw["configRemovals"];
    if (Array.isArray(removals) && removals.some((entry) => entry === "auth" || entry === "auth.users")) {
      conflicts.push(`${label} removes auth.users through configRemovals`);
    }
    const auth = raw["auth"];
    if (!isRecord(auth)) return;
    if (typeof auth["enabled"] === "boolean") authEnabled = auth["enabled"];
    const users = auth["users"];
    if (users === undefined) return;
    if (!Array.isArray(users)) {
      conflicts.push(`${label} sets auth.users to a non-list value`);
    } else if (users.length > 0) {
      conflicts.push(`${label} defines auth.users (${users.length} account(s))`);
    } else if (after) {
      conflicts.push(`${label} sets auth.users to [] after ${E2E_SHARD_FILE}, which would erase the eval accounts`);
    }
  };

  for (const { path, zone } of ordered) {
    if (samePath(path, paths.shardPath)) continue;
    let raw: unknown;
    try {
      raw = JSON5.parse(readFileSync(path, "utf8"));
    } catch (err) {
      conflicts.push(`cannot parse ${show(path)} (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    inspect(path, raw, mergesAfterOurs(path, zone), show(path));
  }
  if (paths.mutableOverlayPath && existsSync(paths.mutableOverlayPath)) {
    try {
      inspect(paths.mutableOverlayPath, JSON5.parse(readFileSync(paths.mutableOverlayPath, "utf8")), true, `${show(paths.mutableOverlayPath)} (runtime overrides, laid over every shard)`);
    } catch {
      // The loader ignores an unparseable overlay too.
    }
  }
  return { conflicts, authEnabled };
}

interface CredentialsEntry {
  username: string;
  password: string;
}

function readJsonRecord(path: string, json5 = false): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = json5 ? JSON5.parse(readFileSync(path, "utf8")) : JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Both files exist, name both accounts with their roles, and every password verifies. */
async function accountsInPlace(paths: SetupPaths): Promise<boolean> {
  const shard = readJsonRecord(paths.shardPath, true);
  const credentials = readJsonRecord(paths.credentialsPath);
  const auth = shard && isRecord(shard["auth"]) ? shard["auth"] : null;
  const users = auth && Array.isArray(auth["users"]) ? auth["users"].filter(isRecord) : [];
  if (!credentials || users.length !== E2E_ACCOUNTS.length) return false;
  for (const account of E2E_ACCOUNTS) {
    const entry = credentials[account.identity];
    const user = users.find((candidate) => candidate["username"] === account.username);
    if (!isRecord(entry) || entry["username"] !== account.username || typeof entry["password"] !== "string") return false;
    if (!user || user["role"] !== account.role || typeof user["passwordHash"] !== "string") return false;
    if (!await bcrypt.compare(entry["password"], user["passwordHash"])) return false;
  }
  return true;
}

function isolationText(): string {
  return [
    "// GENERATED by `pnpm e2e:setup`: keeps the e2e identities off every SHARED mail account (one",
    "// without allowedUsers). The mail-service unites isolatedUsers across its overlay documents and",
    "// re-reads this directory while it runs. Removed by `pnpm e2e:setup --remove`.",
    JSON.stringify(E2E_MAIL_ISOLATION_DOCUMENT, null, 2),
    "",
  ].join("\n");
}

/** Writes the isolation overlay unless it already says exactly that; true when it was written. */
function ensureMailIsolation(paths: SetupPaths): boolean {
  try {
    const current = JSON5.parse(readFileSync(paths.mailIsolationPath, "utf8")) as unknown;
    if (JSON.stringify(current) === JSON.stringify(E2E_MAIL_ISOLATION_DOCUMENT)) return false;
  } catch {
    // Missing or unreadable: written below.
  }
  mkdirSync(dirname(paths.mailIsolationPath), { recursive: true });
  writeFileSync(paths.mailIsolationPath, isolationText(), "utf8");
  return true;
}

function newPassword(): string {
  return randomBytes(24).toString("base64url"); // 32 characters
}

function shardText(users: Array<Record<string, unknown>>): string {
  return [
    "// GENERATED by `pnpm e2e:setup`: the local end-to-end test accounts (eval = operator,",
    "// eval-viewer = viewer). Git-ignored (config/**/*.local.jsonc); remove with `pnpm e2e:setup --remove`.",
    "// The passwords are only in eval/e2e/.credentials.local.json.",
    JSON.stringify({ auth: { users } }, null, 2),
    "",
  ].join("\n");
}

export function defaultConfigBuild(repoRoot: string): Promise<void> {
  return new Promise((resolveBuild, rejectBuild) => {
    const child = spawn(process.execPath, [join(repoRoot, "scripts", "sai.mjs"), "config", "build"], { cwd: repoRoot, stdio: "inherit" });
    child.on("error", rejectBuild);
    child.on("exit", (code) => (code === 0 ? resolveBuild() : rejectBuild(new Error(`sai config build exited with code ${String(code)}`))));
  });
}

export interface SetupOptions {
  paths: SetupPaths;
  remove?: boolean;
  /** Rebuilds the compiled config; null skips the build. Default: `sai config build` when paths.canBuild. */
  build?: ((repoRoot: string) => Promise<void>) | null;
  log?: (line: string) => void;
  now?: () => Date;
}

export interface SetupResult {
  action: "created" | "kept" | "removed" | "nothing-to-remove";
  built: boolean;
  warnings: string[];
}

export async function runE2ESetup(opts: SetupOptions): Promise<SetupResult> {
  const { paths } = opts;
  const log = opts.log ?? (() => undefined);
  const show = (path: string): string => relative(paths.repoRoot, path).split("\\").join("/") || path;
  const build = opts.build === undefined ? (paths.canBuild ? defaultConfigBuild : null) : opts.build;
  const warnings: string[] = [];

  const rebuild = async (): Promise<boolean> => {
    if (!build) {
      log(`Skipped \`sai config build\`: ${show(paths.configDir)} is not the repository's config/ — build that config yourself.`);
      return false;
    }
    log("Rebuilding starlingai.json (`sai config build`) — the gateway reloads it on its own.");
    await build(paths.repoRoot);
    return true;
  };

  if (opts.remove) {
    const present = [paths.shardPath, paths.credentialsPath, paths.mailIsolationPath].filter((path) => existsSync(path));
    for (const path of present) rmSync(path, { force: true });
    log(present.length > 0 ? `Removed ${present.map(show).join(" and ")}.` : "No e2e accounts to remove.");
    const built = await rebuild();
    return { action: present.length > 0 ? "removed" : "nothing-to-remove", built, warnings };
  }

  const scan = scanAuthUsers(paths);
  if (scan.conflicts.length > 0) {
    throw new SetupRefusedError([
      `Refusing to write ${show(paths.shardPath)}: config arrays replace each other when shards merge, so the eval accounts cannot sit beside other auth.users.`,
      ...scan.conflicts.map((conflict) => `  - ${conflict}`),
      "Nothing was written. To run the harness beside those accounts, add the two eval accounts to that list yourself",
      `(usernames ${E2E_ACCOUNTS.map((account) => `${account.username} = ${account.role}`).join(", ")}; hashes from the gateway's hashPassword)`,
      `and put their passwords in ${show(paths.credentialsPath)} as { "<identity>": { "username", "password" } }.`,
    ].join("\n"));
  }
  if (scan.authEnabled !== true) {
    warnings.push("auth.enabled is not true in the config shards: unless the gateway turns auth on through its environment (SAI_AUTH_PROVIDER), username/password login stays off and the harness cannot log in.");
  }

  let action: SetupResult["action"];
  if (await accountsInPlace(paths)) {
    action = "kept";
    log(`The e2e accounts in ${show(paths.shardPath)} are in place and match ${show(paths.credentialsPath)}; kept.`);
  } else {
    const createdAt = (opts.now?.() ?? new Date()).toISOString();
    const users: Array<Record<string, unknown>> = [];
    const credentials: Record<string, CredentialsEntry> = {};
    for (const account of E2E_ACCOUNTS) {
      const password = newPassword();
      users.push({ username: account.username, passwordHash: await hashPassword(password), displayName: account.displayName, role: account.role, createdAt });
      credentials[account.identity] = { username: account.username, password };
    }
    mkdirSync(dirname(paths.shardPath), { recursive: true });
    mkdirSync(dirname(paths.credentialsPath), { recursive: true });
    writeFileSync(paths.shardPath, shardText(users), "utf8");
    writeFileSync(paths.credentialsPath, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    action = "created";
    log(`Wrote ${E2E_ACCOUNTS.map((account) => `${account.username} (${account.role})`).join(" and ")} to ${show(paths.shardPath)}; passwords in ${show(paths.credentialsPath)}.`);
  }
  log(ensureMailIsolation(paths)
    ? `Wrote ${show(paths.mailIsolationPath)}: the mail-service withholds every shared account from eval and eval-viewer.`
    : `${show(paths.mailIsolationPath)} is in place.`);
  for (const warning of warnings) log(`Warning: ${warning}`);
  const built = await rebuild();
  return { action, built, warnings };
}
