/**
 * The account migration: per-account storage keyed by the username's segment moves to the account's
 * immutable id, but only where an admin names the pair.
 *
 * Before account ids every per-user store was keyed by `safeUserSegment(username)`: the user
 * directories in three bases (the workspace, durable user memory, the user-model and personality
 * state), the account stamps in the deployment's shared ledgers, the sessions, the job and mission
 * rows, the schedules, the knowledge bases, the graph tenants and the `user:<username>` document
 * corpus. Since account ids, an account reads only what is keyed by its id, so that data is out of
 * reach until this migration runs, and nothing reads it by a guess in the meantime.
 *
 * What it does, decided per identity (a username, or a directory nobody's name maps to):
 *
 * - It classifies the identity by kind, first match wins: a builtin roster record; an identity-
 *   provider account in the registry; an extension provider's user; a bootstrap token's name; a
 *   scene, job or workflow run; a channel sender or A2A peer; an identity-provider user who has not
 *   signed in since the upgrade; a builtin account that was deleted; anything else. A mapped kind
 *   wins over a principal one: a workflow session alice started is alice's.
 * - Nothing moves to an account unless the request names the pair (`--adopt alice=<id>`, or
 *   `--adopt alice` for a record that gets its id now). A matching username alone never adopts: a
 *   name outlives its account, and the next person under it is not the one before.
 * - What is not adopted stays where it is (held), except a deleted builtin account's directories,
 *   which are archived to `users/.retired/` (reversible) because no living account needs them and a
 *   principal with the same raw name must not read them.
 * - A bootstrap token's name is never adoptable: on a deployment whose identity provider has a user
 *   called "admin", the bucket the default bootstrap token always used stays the token's.
 *
 * The dry run is the default, writes nothing and may run on the live gateway. An apply runs only in
 * a maintenance boot (SAI_MAINTENANCE=account-migration), in which no other writer of these stores
 * runs, and only for the plan hash its dry run printed: the hash covers the decisions (kinds,
 * targets, directories, conflicts, flags), never sizes or counts, so a chat between the dry run and
 * the apply does not invalidate it, and a changed decision does. Every step is idempotent: a re-run
 * after a failure picks up where it stopped, and an account whose steps did not all complete stays
 * unable to sign in (a builtin record gets its id last, an identity-provider account turns active
 * last). Each apply is recorded in the account ledger (`<workspace>/.starlingai/
 * account-migrations.ndjson`) and audited.
 *
 * `reset` is the wipe variant: every account starts empty, every account-like bucket is archived,
 * and the old stamps and graph tenants are retired. `purgeRetired` removes what a deleted or retired
 * account left, for good.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { getConfig, rosterWrittenByRuntime, updateConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";
import { logAudit } from "../audit/logger.js";
import { getExtensionAuthProvider } from "../extension/index.js";
import { CHANNEL_TYPES } from "../credentials/channels.js";
import {
  ACCOUNT_ID_RE,
  DEFAULT_BOOTSTRAP_SUB,
  accountLedgerPath,
  appendAccountLedgerEntry,
  mintBuiltinAccountId,
  principalSegment,
  readAccountLedger,
  sameAccountId,
  type AccountLedgerEntry,
} from "./accounts.js";
import {
  accountRegistryBootstrapSubs,
  accountRegistryEntries,
  accountRegistryReadable,
  changeAccountRegistry,
  type AccountRegistryEntry,
} from "./account-registry.js";
import { accountTombstones, loadAccountTombstones, type AccountTombstone } from "./account-tombstones.js";
import { USERS_SUBDIR } from "./user-scope.js";
import { disableScheduledTask, listScheduledTaskRecords, saveScheduledTask, type ScheduledTaskRecord } from "./scheduled-tasks.js";
import {
  checkedSessionMirror,
  getAllSessions,
  migrateMirroredSessionAccount,
  migrateSessionAccount,
  purgeAccountSessions,
  type PersistedSessionRecord,
  type SessionMirrorAccess,
} from "../agent/session.js";
import { loadEverySessionFromRedis } from "../agent/session-redis.js";
import { outcomeAccountCounts, rewriteOutcomeAccounts } from "../agent/outcomes.js";
import { flowMemoryAccountCounts, rewriteFlowMemoryAccounts } from "../agent/flow-memory.js";
import { conversationConfigProposalAccountCounts, rewriteConversationConfigProposalAccounts } from "../agent/config-assistant-proposals.js";
import { kbSource, listKnowledgeBases, mutateKnowledgeBase, removeKnowledgeBaseRecord, type KnowledgeBaseRecord } from "../retrieval/knowledge-bases.js";
import { listRegistry, unregisterDocument } from "../retrieval/document-registry.js";
import { addDocumentSourceAlias, aliasedDocumentSources, documentSourceAliasHolders, documentSourceAliases, removeDocumentSourceAliases } from "../retrieval/document-aliases.js";

const log = childLogger("runtime:account-migration");

/** The value of SAI_MAINTENANCE that boots the gateway for the account migration only. */
export const ACCOUNT_MIGRATION_MAINTENANCE = "account-migration";

/** Whether this process is a maintenance boot for the account migration. */
export function accountMigrationMaintenance(): boolean {
  return process.env["SAI_MAINTENANCE"]?.trim() === ACCOUNT_MIGRATION_MAINTENANCE;
}

// ── The request ──────────────────────────────────────────────────────────────

export interface AccountMigrationRequest {
  /** Execute the plan (maintenance boot only); a dry run otherwise. */
  apply: boolean;
  /** The hash of the plan the dry run printed; required with `apply`. */
  plan?: string;
  /** `<username>` (a record that gets its id now) or `<username>=<account id>`. */
  adopt: Array<{ username: string; id?: string }>;
  /** Adopt for every roster record without an id whose name no account adopted before. */
  adoptLegacyRecords: boolean;
  /** Archive the directories of identities nobody can be mapped to, instead of holding them. */
  archiveUnmapped: boolean;
  /** Usernames (or segments) whose directories stay in place, instead of being archived. */
  hold: string[];
  /** Restore an archive in `users/.retired` into a living account's directory. */
  adoptRetired: Array<{ archive: string; id: string }>;
  /** Rename an identity provider's issuer in the registry (a new hostname, a trailing slash). */
  oidcIssuerAlias?: { from: string; to: string };
  /** Every account starts empty: the wipe variant. */
  reset: boolean;
  /** Remove what the deleted or retired account with this id left. */
  purgeRetired?: string;
}

const MAX_LIST = 200;

function stringList(value: unknown, name: string): string[] | { error: string } {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string") || value.length > MAX_LIST) {
    return { error: `${name} must be a list of strings` };
  }
  return (value as string[]).map((item) => item.trim()).filter(Boolean);
}

/** The request a route body names, or why it names none. */
export function parseAccountMigrationRequest(body: unknown): AccountMigrationRequest | { error: string } {
  if (body === undefined || body === null) body = {};
  if (typeof body !== "object" || Array.isArray(body)) return { error: "The body must be a JSON object" };
  const raw = body as Record<string, unknown>;
  const known = new Set(["apply", "plan", "adopt", "adoptLegacyRecords", "archiveUnmapped", "hold", "adoptRetired", "oidcIssuerAlias", "reset", "purgeRetired"]);
  const unknown = Object.keys(raw).filter((key) => !known.has(key));
  if (unknown.length > 0) return { error: `Unknown field(s): ${unknown.join(", ")}` };
  for (const key of ["apply", "adoptLegacyRecords", "archiveUnmapped", "reset"]) {
    if (raw[key] !== undefined && typeof raw[key] !== "boolean") return { error: `${key} must be true or false` };
  }
  if (raw["plan"] !== undefined && (typeof raw["plan"] !== "string" || !/^[0-9a-f]{16}$/.test(raw["plan"]))) return { error: "plan must be the 16-digit hash a dry run printed" };

  const adoptRaw = stringList(raw["adopt"], "adopt");
  if ("error" in adoptRaw) return adoptRaw;
  const adopt: AccountMigrationRequest["adopt"] = [];
  for (const entry of adoptRaw) {
    const [username, id, ...rest] = entry.split("=");
    if (!username || rest.length > 0 || (id !== undefined && !ACCOUNT_ID_RE.test(id))) return { error: `adopt '${entry}' is not <username> or <username>=<account id>` };
    adopt.push({ username: username.toLowerCase(), ...(id !== undefined ? { id } : {}) });
  }
  const hold = stringList(raw["hold"], "hold");
  if ("error" in hold) return hold;

  const adoptRetired: AccountMigrationRequest["adoptRetired"] = [];
  if (raw["adoptRetired"] !== undefined) {
    if (!Array.isArray(raw["adoptRetired"]) || raw["adoptRetired"].length > MAX_LIST) return { error: "adoptRetired must be a list of { archive, id }" };
    for (const item of raw["adoptRetired"] as unknown[]) {
      const entry = item as { archive?: unknown; id?: unknown } | null;
      if (!entry || typeof entry.archive !== "string" || typeof entry.id !== "string" || !ACCOUNT_ID_RE.test(entry.id)
        || !/^[A-Za-z0-9_-]+$/.test(entry.archive)) {
        return { error: "adoptRetired entries need an archive name (as the dry run lists it) and an account id" };
      }
      adoptRetired.push({ archive: entry.archive, id: entry.id });
    }
  }

  let oidcIssuerAlias: AccountMigrationRequest["oidcIssuerAlias"];
  if (raw["oidcIssuerAlias"] !== undefined) {
    const alias = raw["oidcIssuerAlias"] as { from?: unknown; to?: unknown } | null;
    if (!alias || typeof alias.from !== "string" || typeof alias.to !== "string" || !alias.from.trim() || !alias.to.trim()) {
      return { error: "oidcIssuerAlias needs { from, to }" };
    }
    oidcIssuerAlias = { from: trimIssuer(alias.from), to: trimIssuer(alias.to) };
  }

  let purgeRetired: string | undefined;
  if (raw["purgeRetired"] !== undefined) {
    if (typeof raw["purgeRetired"] !== "string" || !ACCOUNT_ID_RE.test(raw["purgeRetired"])) return { error: "purgeRetired must be an account id" };
    purgeRetired = raw["purgeRetired"];
  }

  const request: AccountMigrationRequest = {
    apply: raw["apply"] === true,
    ...(typeof raw["plan"] === "string" ? { plan: raw["plan"] } : {}),
    adopt,
    adoptLegacyRecords: raw["adoptLegacyRecords"] === true,
    archiveUnmapped: raw["archiveUnmapped"] === true,
    hold,
    adoptRetired,
    ...(oidcIssuerAlias ? { oidcIssuerAlias } : {}),
    reset: raw["reset"] === true,
    ...(purgeRetired ? { purgeRetired } : {}),
  };
  const decisions = request.adopt.length > 0 || request.adoptLegacyRecords || request.archiveUnmapped || request.hold.length > 0 || request.adoptRetired.length > 0;
  if (request.purgeRetired && (decisions || request.reset || request.oidcIssuerAlias)) return { error: "purgeRetired runs on its own" };
  if (request.reset && decisions) return { error: "reset starts every account empty; it takes no adoption, hold or archive choices" };
  if (request.apply && !request.plan) return { error: "apply needs the plan hash the dry run printed" };
  return request;
}

function trimIssuer(issuer: string): string {
  return issuer.trim().replace(/\/+$/, "");
}

// ── What the migration reaches outside the files ─────────────────────────────

/** A Postgres connection (scene_jobs, missions, audit_events). */
export interface MigrationSql {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
}

/** A per-user base: buckets are `<path>/users/<segment>`. */
export interface MigrationBase {
  name: "workspace" | "user-memory" | "state";
  path: string;
}

export interface AccountMigrationBackends {
  /** The three bases, the same directory listed once. */
  bases: MigrationBase[];
  /** Postgres, when configured. */
  sql: MigrationSql | null;
  /** MemGraph, when configured: runs a write and returns the count the query returns as `n`. */
  cypher: ((query: string, params: Record<string, unknown>) => Promise<number>) | null;
  /** The Redis session mirror: every record, or null when none is configured. */
  mirroredSessions: () => Promise<Array<{ id: string; json: string }> | null>;
  mirror: SessionMirrorAccess;
  /** engram, when configured (a purge removes an account's documents). */
  documents: {
    list(): Promise<Array<{ id: string; sources: string[] }> | null>;
    remove(documentId: string, source: string): Promise<boolean>;
  } | null;
  /** Host directories bound by running served-app containers; null when Docker cannot be asked. */
  appBinds: () => Promise<string[] | null>;
}

let _defaultSql: MigrationSql | null | undefined;

/** The backends of this deployment, from its environment. */
export async function defaultAccountMigrationBackends(): Promise<AccountMigrationBackends> {
  const { userMemoryBaseDir } = await import("../memory/service.js");
  const { userStateBaseDir } = await import("./user-scope.js");
  const bases: MigrationBase[] = [];
  const add = (name: MigrationBase["name"], path: string) => {
    const resolved = resolve(path);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (!bases.some((base) => (process.platform === "win32" ? base.path.toLowerCase() : base.path) === key)) bases.push({ name, path: resolved });
  };
  add("workspace", getConfig().workspacePath);
  add("user-memory", userMemoryBaseDir());
  add("state", userStateBaseDir());

  if (_defaultSql === undefined) {
    const url = process.env["DATABASE_URL"]?.trim();
    if (url) {
      const pg = (await import("pg")).default;
      _defaultSql = new pg.Pool({ connectionString: url, max: 2 });
    } else {
      _defaultSql = null;
    }
  }

  const { getGraphDriver, runCypher } = await import("../db/neo4j.js");
  const cypher = getGraphDriver()
    ? async (query: string, params: Record<string, unknown>) => {
        const result = await runCypher(query, params, { write: true });
        const value = result?.records[0]?.get("n") as { toNumber?: () => number } | number | undefined;
        return typeof value === "number" ? value : value?.toNumber?.() ?? 0;
      }
    : null;

  const engram = await import("../retrieval/engram.js");
  const { listServedAppBinds } = await import("../tools/serve-app.js");
  return {
    bases,
    sql: _defaultSql,
    cypher,
    mirroredSessions: loadEverySessionFromRedis,
    mirror: checkedSessionMirror,
    documents: engram.engramConfigured()
      ? { list: engram.engramListDocuments, remove: engram.engramDeleteDocument }
      : null,
    appBinds: listServedAppBinds,
  };
}

// ── The inventory: what is stored where, read without writing anything ───────

type BaseName = MigrationBase["name"];

interface SessionFacts {
  id: string;
  userId?: string;
  account?: string;
  principal?: string;
  channel: string;
  /** Set for a session only the mirror holds. */
  mirrorJson?: string;
}

interface StoredUnder {
  buckets: Set<BaseName>;
  stamps: number;
  sessions: SessionFacts[];
  jobs: number;
  missions: number;
  schedules: ScheduledTaskRecord[];
  kbs: KnowledgeBaseRecord[];
  documents: number;
}

interface AuthFacts {
  builtin: number;
  oidc: number;
}

interface Inventory {
  bases: MigrationBase[];
  roster: Array<{ username: string; id?: string }>;
  rosterWritable: boolean;
  registry: readonly AccountRegistryEntry[];
  tombstones: readonly AccountTombstone[];
  bootstrapSubs: readonly string[];
  ledger: AccountLedgerEntry[];
  /** Lowercased ids of every living account (roster, registry). */
  accountIds: Set<string>;
  /** `users/<id>` directories of living accounts, by lowercased id. */
  accountDirs: Map<string, Set<BaseName>>;
  /** Archives in `users/.retired`, by name. */
  archives: Map<string, Set<BaseName>>;
  /** What is stored under each segment that is not an account id. */
  stored: Map<string, StoredUnder>;
  /** Every account stamp in the shared ledgers, account ids included (a purge counts them). */
  stampCounts: Map<string, number>;
  /** Every knowledge base (a purge removes an account's). */
  kbs: KnowledgeBaseRecord[];
  /** Registry entries per document source. */
  documentSources: Map<string, number>;
  /** A username for each segment it derives to, where one is known. */
  labels: Map<string, string>;
  /** Every session by its userId (kinded ones too: they tell a principal by its own kind). */
  sessionsByUser: Map<string, SessionFacts[]>;
  auth: Map<string, AuthFacts>;
  /** Account ids that signed in (auth_success rows that name one). */
  signedInAccounts: Set<string>;
  sqlTables: { jobs: boolean; missions: boolean };
  appBinds: string[] | null;
  /** Sources that could not be read. A blocking one refuses every apply. */
  problems: Array<{ source: string; reason: string; blocking: boolean }>;
}

function emptyStored(): StoredUnder {
  return { buckets: new Set(), stamps: 0, sessions: [], jobs: 0, missions: 0, schedules: [], kbs: [], documents: 0 };
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function listDirs(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** The lowercased ids of the accounts that were deleted or retired. */
function endedAccountIds(tombstones: readonly AccountTombstone[]): string[] {
  return tombstones.flatMap((tombstone) => (tombstone.id ? [tombstone.id.toLowerCase()] : []));
}

function isLegacyRecordOwner(owner: { userId?: string; account?: string; principal?: string }): owner is { userId: string } {
  return typeof owner.userId === "string" && owner.userId !== "" && !owner.account && !owner.principal;
}

async function takeInventory(backends: AccountMigrationBackends): Promise<Inventory> {
  const config = getConfig();
  const workspace = config.workspacePath;
  const problems: Inventory["problems"] = [];

  const roster = config.auth.users.map((user) => ({ username: user.username.toLowerCase(), ...(user.id ? { id: user.id } : {}) }));
  const registryReadable = accountRegistryReadable();
  if (!registryReadable) problems.push({ source: "account registry", reason: "cannot be read", blocking: true });
  const registry = accountRegistryEntries();
  const tombstonesReadable = loadAccountTombstones().readable;
  if (!tombstonesReadable) problems.push({ source: "account tombstones", reason: "cannot be read", blocking: true });
  const tombstones = accountTombstones();
  let ledger: AccountLedgerEntry[] = [];
  try {
    ledger = readAccountLedger(accountLedgerPath(workspace));
  } catch (err) {
    problems.push({ source: "account ledger", reason: reason(err), blocking: true });
  }

  // A directory under an id an earlier apply reserved, and moved data into before it stopped, is
  // that account's: never a bucket to offer, hold or archive again.
  const accountIds = new Set<string>([
    ...roster.flatMap((record) => (record.id ? [record.id.toLowerCase()] : [])),
    ...registry.map((entry) => entry.id.toLowerCase()),
    ...ledger.flatMap((entry) => (entry.event === "reserved" ? [entry.id.toLowerCase()] : [])),
  ]);
  // So is what a deleted account left under its id: it stays there until a purge removes it. It
  // was inventoried as an unknown identity's, so --archive-unmapped archived its directory and
  // --reset retired its stamps and graph tenants, after which a purge of the id matched none of
  // them and the deleted person's records survived it. Its id is never a living account's, so it
  // is kept apart from `accountIds`, which an archive is restored into.
  const knownIds = new Set<string>([...accountIds, ...endedAccountIds(tombstones)]);

  const stored = new Map<string, StoredUnder>();
  const under = (segment: string): StoredUnder => {
    let entry = stored.get(segment);
    if (!entry) stored.set(segment, (entry = emptyStored()));
    return entry;
  };
  const labels = new Map<string, string>();
  const label = (username: string | undefined) => {
    if (!username) return;
    const segment = principalSegment(username);
    if (!labels.has(segment)) labels.set(segment, username);
  };

  // Directories.
  const accountDirs = new Map<string, Set<BaseName>>();
  const archives = new Map<string, Set<BaseName>>();
  for (const base of backends.bases) {
    for (const name of listDirs(resolve(base.path, USERS_SUBDIR))) {
      if (name === ".retired") {
        for (const archive of listDirs(resolve(base.path, USERS_SUBDIR, name))) {
          if (!archives.has(archive)) archives.set(archive, new Set());
          archives.get(archive)!.add(base.name);
        }
        continue;
      }
      if (name.startsWith(".")) continue;
      if (knownIds.has(name.toLowerCase())) {
        if (!accountDirs.has(name.toLowerCase())) accountDirs.set(name.toLowerCase(), new Set());
        accountDirs.get(name.toLowerCase())!.add(base.name);
        continue;
      }
      under(name).buckets.add(base.name);
    }
  }

  // Stamps in the shared ledgers.
  const stampSources: Array<[string, (ws: string) => Map<string, number>]> = [
    ["agent outcomes", outcomeAccountCounts],
    ["flow memory", flowMemoryAccountCounts],
    ["config-assistant proposals", conversationConfigProposalAccountCounts],
  ];
  const stampCounts = new Map<string, number>();
  for (const [source, count] of stampSources) {
    try {
      for (const [segment, n] of count(workspace)) {
        stampCounts.set(segment, (stampCounts.get(segment) ?? 0) + n);
        if (knownIds.has(segment.toLowerCase()) || segment.startsWith("retired:")) continue;
        under(segment).stamps += n;
      }
    } catch (err) {
      problems.push({ source, reason: reason(err), blocking: true });
    }
  }

  // Sessions: this process's store and every record the mirror holds.
  const sessionsByUser = new Map<string, SessionFacts[]>();
  const seen = new Set<string>();
  const addSession = (facts: SessionFacts) => {
    if (!facts.userId) return;
    if (!sessionsByUser.has(facts.userId)) sessionsByUser.set(facts.userId, []);
    sessionsByUser.get(facts.userId)!.push(facts);
    label(facts.userId);
    if (isLegacyRecordOwner(facts)) under(principalSegment(facts.userId)).sessions.push(facts);
  };
  for (const session of getAllSessions({ includeArchived: true })) {
    seen.add(session.id);
    addSession({
      id: session.id,
      channel: session.channel,
      ...(session.userId !== undefined ? { userId: session.userId } : {}),
      ...(session.account ? { account: session.account } : {}),
      ...(session.principal ? { principal: session.principal } : {}),
    });
  }
  try {
    for (const entry of (await backends.mirroredSessions()) ?? []) {
      if (seen.has(entry.id)) continue;
      try {
        const record = JSON.parse(entry.json) as PersistedSessionRecord;
        addSession({
          id: entry.id,
          channel: String(record.channel ?? ""),
          ...(typeof record.userId === "string" ? { userId: record.userId } : {}),
          ...(record.account ? { account: record.account } : {}),
          ...(record.principal ? { principal: record.principal } : {}),
          mirrorJson: entry.json,
        });
      } catch { /* not a session record: nothing of anyone's */ }
    }
  } catch (err) {
    // A session only the mirror holds could be missed: every session step fails until it can be read.
    problems.push({ source: "Redis session mirror", reason: reason(err), blocking: false });
  }

  // Postgres: jobs and missions from before account ids, and the sign-ins on record.
  const auth = new Map<string, AuthFacts>();
  const signedInAccounts = new Set<string>();
  const sqlTables = { jobs: false, missions: false };
  if (backends.sql) {
    try {
      const tables = await backends.sql.query(
        "SELECT to_regclass('scene_jobs') IS NOT NULL AS jobs, to_regclass('missions') IS NOT NULL AS missions, to_regclass('audit_events') IS NOT NULL AS audit",
      );
      const row = tables.rows[0] ?? {};
      sqlTables.jobs = row["jobs"] === true;
      sqlTables.missions = row["missions"] === true;
      if (sqlTables.jobs) {
        const jobs = await backends.sql.query(
          "SELECT user_id, count(*)::int AS n FROM scene_jobs WHERE account_id IS NULL AND user_id IS NOT NULL AND (payload->>'principal') IS NULL GROUP BY user_id",
        );
        for (const job of jobs.rows) {
          const userId = String(job["user_id"]);
          label(userId);
          under(principalSegment(userId)).jobs += Number(job["n"] ?? 0);
        }
      }
      if (sqlTables.missions) {
        const missions = await backends.sql.query(
          "SELECT user_id, count(*)::int AS n FROM missions WHERE account_id IS NULL AND user_id IS NOT NULL GROUP BY user_id",
        );
        for (const mission of missions.rows) {
          const userId = String(mission["user_id"]);
          label(userId);
          under(principalSegment(userId)).missions += Number(mission["n"] ?? 0);
        }
      }
      if (row["audit"] === true) {
        // The type index serves this; it runs once per plan.
        const rows = await backends.sql.query(
          "SELECT user_id, data->>'via' AS via, data->>'account' AS account, count(*)::int AS n FROM audit_events WHERE type = 'auth_success' GROUP BY 1, 2, 3",
        );
        for (const signIn of rows.rows) {
          if (typeof signIn["account"] === "string") signedInAccounts.add(signIn["account"].toLowerCase());
          if (typeof signIn["user_id"] !== "string") continue;
          const userId = signIn["user_id"];
          label(userId);
          const facts = auth.get(userId) ?? { builtin: 0, oidc: 0 };
          if (signIn["via"] === "oidc") facts.oidc += Number(signIn["n"] ?? 0);
          else facts.builtin += Number(signIn["n"] ?? 0);
          auth.set(userId, facts);
        }
      }
    } catch (err) {
      problems.push({ source: "Postgres", reason: reason(err), blocking: false });
    }
  }

  // Schedules, knowledge bases and documents from before account ids.
  for (const task of listScheduledTaskRecords()) {
    label(task.userId);
    if (isLegacyRecordOwner(task)) under(principalSegment(task.userId)).schedules.push(task);
  }
  let kbs: KnowledgeBaseRecord[] = [];
  try {
    kbs = await listKnowledgeBases();
    for (const kb of kbs) {
      label(kb.ownerId);
      if (kb.scope === "user" && kb.ownerId && !kb.ownerAccount && !kb.ownerPrincipal) under(principalSegment(kb.ownerId)).kbs.push(kb);
    }
  } catch (err) {
    problems.push({ source: "knowledge-base registry", reason: reason(err), blocking: true });
  }
  const documentSources = new Map<string, number>();
  try {
    const aliased = aliasedDocumentSources(workspace);
    for (const entry of await listRegistry()) {
      documentSources.set(entry.source, (documentSources.get(entry.source) ?? 0) + 1);
      if (!entry.source.startsWith("user:") || aliased.has(entry.source)) continue;
      const owner = entry.source.slice("user:".length);
      // `user:<segment>` is a corpus keyed since account ids; `user:<username>` one from before.
      if (!owner || ACCOUNT_ID_RE.test(owner)) continue;
      label(owner);
      under(principalSegment(owner)).documents += 1;
    }
  } catch (err) {
    problems.push({ source: "document registry", reason: reason(err), blocking: false });
  }

  // Every name that can tell whose a segment is. A registry entry's own legacy segment names it
  // first: the sign-in recorded which bucket waited for it.
  for (const entry of registry) {
    if (entry.legacy?.segment) labels.set(entry.legacy.segment, entry.username);
  }
  for (const record of roster) label(record.username);
  for (const entry of registry) {
    label(entry.username);
    for (const former of entry.formerUsernames ?? []) label(former);
  }
  for (const tombstone of tombstones) label(tombstone.username);
  const bootstrapSubs = accountRegistryBootstrapSubs();
  for (const sub of [DEFAULT_BOOTSTRAP_SUB, ...bootstrapSubs]) label(sub);
  for (const entry of ledger) if ("username" in entry) label(entry.username);

  // What every identity that must get an id or an answer has stored, even when it is nothing.
  for (const record of roster) if (!record.id) under(principalSegment(record.username));
  for (const entry of registry) if (entry.status === "pending") under(principalSegment(entry.username));

  let appBinds: string[] | null = null;
  try {
    appBinds = await backends.appBinds();
  } catch { /* reported below */ }
  if (appBinds === null) problems.push({ source: "served-app containers", reason: "Docker could not be asked which directories running apps bind", blocking: false });

  return {
    bases: backends.bases,
    roster,
    rosterWritable: rosterWrittenByRuntime(),
    registry,
    tombstones,
    bootstrapSubs,
    ledger,
    accountIds,
    accountDirs,
    archives,
    stored,
    stampCounts,
    kbs,
    documentSources,
    labels,
    sessionsByUser,
    auth,
    signedInAccounts,
    sqlTables,
    appBinds,
    problems,
  };
}

// ── Classification ──────────────────────────────────────────────────────────

export type MigrationKind =
  | "builtin"
  | "oidc"
  | "extension"
  | "bootstrap"
  | "synthetic"
  | "channel-or-peer"
  | "oidc-unseen"
  | "deleted-builtin"
  | "unknown";

const PRINCIPAL_KINDS = new Set<MigrationKind>(["bootstrap", "synthetic", "channel-or-peer"]);

const KIND_DESCRIPTIONS: Record<MigrationKind, string> = {
  builtin: "a builtin account",
  oidc: "an identity-provider account",
  extension: "an extension provider's user",
  bootstrap: "a bootstrap token's name",
  synthetic: "a scene, job or workflow run",
  "channel-or-peer": "a channel sender or an A2A peer",
  "oidc-unseen": "an identity-provider user with no account yet",
  "deleted-builtin": "a deleted account",
  unknown: "an identity nobody's name maps to",
};

/** A session a channel sender or an A2A peer started: its own kind says so, or its channel does. */
function isChannelOrPeerSession(session: SessionFacts): boolean {
  if (session.principal === "channel" || session.principal === "peer") return true;
  return (CHANNEL_TYPES as readonly string[]).includes(session.channel) || session.id.startsWith("a2a-in:");
}

function isBootstrapName(username: string | undefined, inv: Inventory): boolean {
  return username !== undefined && (username === DEFAULT_BOOTSTRAP_SUB || inv.bootstrapSubs.includes(username));
}

/** The kind of the identity `username` names; first match wins (see the module comment). */
function classify(username: string | undefined, inv: Inventory): MigrationKind {
  if (username === undefined) return "unknown";
  const name = username.toLowerCase();
  if (inv.roster.some((record) => record.username === name)) return "builtin";
  if (inv.registry.some((entry) => entry.username === name)) return "oidc";
  if (getExtensionAuthProvider()?.getUserById(username)) return "extension";
  const sessions = inv.sessionsByUser.get(username) ?? [];
  const signIns = inv.auth.get(username);
  if (isBootstrapName(username, inv) || sessions.some((session) => session.principal === "bootstrap")) return "bootstrap";
  if (username.includes(":") || sessions.some((session) => session.principal === "synthetic")) return "synthetic";
  if (sessions.length > 0 && (sessions.every(isChannelOrPeerSession) || sessions.some((session) => session.principal === "channel" || session.principal === "peer"))) {
    return "channel-or-peer";
  }
  if (sessions.length > 0 && !signIns) {
    // A dashboard session and no sign-in on record: a bootstrap token minted offline logs none.
    return "bootstrap";
  }
  if (signIns && signIns.oidc > 0) return "oidc-unseen";
  if ((signIns && signIns.builtin > 0) || inv.tombstones.some((tombstone) => tombstone.kind === "builtin" && tombstone.username === name)) {
    return "deleted-builtin";
  }
  return "unknown";
}

// ── The plan ────────────────────────────────────────────────────────────────

export interface PlannedIdentity {
  segment: string;
  username?: string;
  kind: MigrationKind;
  /** The account the data goes to or that the record gets: an id, "fresh" (minted by the apply),
   *  or "manual" (a shard record: the id is pasted by hand). */
  account?: string;
  /** adopt: moved to the account; hold: stays where it is; archive: to users/.retired; in-place: a
   *  principal's, or an extension user's, which is where it belongs already. */
  data: "adopt" | "hold" | "archive" | "in-place";
  /** segment: a principal's user-scope graph nodes go from its raw name to its segment; retired: a
   *  reset's. */
  graph: "segment" | "retired" | "none";
  /** The record gets its id (written to the roster the runtime writes). */
  assignId: boolean;
  /** A pending identity-provider account becomes active. */
  activate: boolean;
  /** Schedules from before account ids are disabled. */
  disableSchedules: boolean;
  /** Why nothing is done for this identity. */
  refused?: string;
  /** The line to paste into a shard-held record. */
  idLine?: string;
  notes: string[];
  stored: {
    buckets: string[];
    stamps: number;
    sessions: number;
    mirrorOnlySessions: number;
    jobs: number;
    missions: number;
    schedules: number;
    knowledgeBases: number;
    documents: number;
  };
}

export interface PlannedMove {
  identity: string;
  base: BaseName;
  /** Relative to `<base>/users`. An archive's target ends in `-*`: its UTC stamp is set at apply. */
  from: string;
  to: string;
}

export interface PlannedRestore {
  archive: string;
  account: string;
  bases: BaseName[];
  refused?: string;
}

export interface PlannedPurge {
  account: string;
  username?: string;
  refused?: string;
  removes: { directories: string[]; archives: string[]; stamps: number; sessions: number; knowledgeBases: number; documents: number; aliases: number };
  keeps: string[];
}

export interface AccountMigrationPlan {
  hash: string;
  mode: "migrate" | "reset" | "purge";
  maintenance: boolean;
  identities: PlannedIdentity[];
  moves: PlannedMove[];
  restores: PlannedRestore[];
  issuerAlias?: { from: string; to: string; entries: number };
  purge?: PlannedPurge;
  /** Problems that refuse something (they are part of the hash). */
  conflicts: string[];
  /** What a flag could not apply to (not part of the hash). */
  flagNotes: string[];
  problems: Inventory["problems"];
  /** How many identities or other items the apply would change. */
  actionable: number;
  nothingToMigrate: boolean;
}

/** Ids suggested for shard-held records, kept for this process so repeated dry runs print the same. */
const _suggestedIds = new Map<string, string>();

function ledgerIds(inv: Inventory): string[] {
  return inv.ledger.flatMap((entry) => ("id" in entry ? [entry.id] : []));
}

function heldIds(inv: Inventory): string[] {
  return [
    ...inv.roster.flatMap((record) => (record.id ? [record.id] : [])),
    ...inv.registry.map((entry) => entry.id),
    ...inv.tombstones.flatMap((tombstone) => (tombstone.id ? [tombstone.id] : [])),
    ...ledgerIds(inv),
  ];
}

/** An id the ledger reserved for this id-less record by an apply that stopped part-way. */
function reservedIdFor(username: string, inv: Inventory): string | undefined {
  const reserved = [...inv.ledger].reverse().find((entry) => entry.event === "reserved" && entry.username === username);
  if (!reserved || !("id" in reserved)) return undefined;
  const id = reserved.id;
  const finished = inv.ledger.some((entry) => (entry.event === "assigned" || entry.event === "adopted") && sameAccountId(entry.id, id));
  const held = inv.roster.some((record) => record.id && sameAccountId(record.id, id))
    || inv.registry.some((entry) => sameAccountId(entry.id, id))
    || inv.tombstones.some((tombstone) => tombstone.id && sameAccountId(tombstone.id, id));
  return finished || held ? undefined : id;
}

function adoptionOf(username: string, inv: Inventory): Extract<AccountLedgerEntry, { event: "adopted" }> | undefined {
  return [...inv.ledger].reverse().find((entry): entry is Extract<AccountLedgerEntry, { event: "adopted" }> => entry.event === "adopted" && entry.username === username);
}

function storedSummary(stored: StoredUnder): PlannedIdentity["stored"] {
  return {
    buckets: [...stored.buckets].sort(),
    stamps: stored.stamps,
    sessions: stored.sessions.length,
    mirrorOnlySessions: stored.sessions.filter((session) => session.mirrorJson !== undefined).length,
    jobs: stored.jobs,
    missions: stored.missions,
    schedules: stored.schedules.length,
    knowledgeBases: stored.kbs.length,
    documents: stored.documents,
  };
}

function hasMovableData(stored: StoredUnder): boolean {
  return stored.buckets.size > 0 || stored.stamps > 0 || stored.sessions.length > 0 || stored.jobs > 0 || stored.missions > 0
    || stored.schedules.length > 0 || stored.kbs.length > 0 || stored.documents > 0;
}

function bindsSegment(binds: string[] | null, segment: string): boolean {
  if (!binds) return false;
  return binds.some((source) => source.replace(/\\/g, "/").split("/").some((part, index, parts) => part === segment && parts[index - 1] === USERS_SUBDIR));
}

function buildPlan(inv: Inventory, request: AccountMigrationRequest): AccountMigrationPlan {
  if (request.purgeRetired) return finishPlan(inv, request, "purge", [], [], [], [], [], planPurge(inv, request.purgeRetired));

  const conflicts: string[] = [];
  const flagNotes: string[] = [];
  const identities: PlannedIdentity[] = [];
  const moves: PlannedMove[] = [];
  const adoptFlags = new Map(request.adopt.map((flag) => [flag.username, flag]));
  const usedAdoptFlags = new Set<string>();
  const holds = new Set(request.hold.map((value) => value.toLowerCase()));

  // A roster id that names a directory nothing on record gave it: an id copied from another account
  // would hand this one that account's data.
  const unassignedIds = new Map<string, string>();
  for (const record of inv.roster) {
    if (!record.id) continue;
    const dirs = inv.accountDirs.get(record.id.toLowerCase());
    if (!dirs || dirs.size === 0) continue;
    const onRecord = inv.ledger.some((entry) => ("id" in entry && sameAccountId(entry.id, record.id!)) || (entry.event === "moved" && sameAccountId(entry.to, record.id!)));
    if (onRecord || inv.signedInAccounts.has(record.id.toLowerCase())) continue;
    const message = `the roster id ${record.id} of '${record.username}' names users/${record.id} in ${[...dirs].sort().join(", ")}, which nothing on record gave it: an id copied from another account would hand it that account's data`;
    unassignedIds.set(record.username, message);
    conflicts.push(message);
  }

  for (const [segment, stored] of [...inv.stored].sort(([left], [right]) => left.localeCompare(right))) {
    const username = inv.labels.get(segment);
    const kind = classify(username, inv);
    const name = username?.toLowerCase();
    const plan: PlannedIdentity = {
      segment,
      ...(username !== undefined ? { username } : {}),
      kind,
      data: "hold",
      graph: "none",
      assignId: false,
      activate: false,
      disableSchedules: false,
      notes: [],
      stored: storedSummary(stored),
    };
    const flag = name !== undefined ? adoptFlags.get(name) : undefined;
    if (flag && name !== undefined) usedAdoptFlags.add(name);
    const retaggedBefore = inv.ledger.some((entry) => entry.event === "retagged" && entry.segment === segment);
    const legacySchedules = stored.schedules.filter((task) => !task.disabled).length;
    const bootstrapName = isBootstrapName(name, inv);
    const refuseAdoption = (why: string) => {
      plan.refused = why;
      plan.data = "hold";
    };

    if (request.reset) {
      planReset(plan, inv, stored, retaggedBefore, legacySchedules);
    } else if (kind === "builtin") {
      const record = inv.roster.find((candidate) => candidate.username === name)!;
      const adopted = adoptionOf(record.username, inv);
      if (!record.id) {
        const reserved = reservedIdFor(record.username, inv);
        // After an adoption of the name, an id-less record under it is a new person: it gets an id of
        // its own and is never offered what the name stored before.
        const wants = !adopted && ((flag !== undefined && flag.id === undefined) || request.adoptLegacyRecords);
        if (flag?.id !== undefined) refuseAdoption(`'${record.username}' has no account id yet: adopt it with --adopt ${record.username}, which gives it one`);
        if (adopted) {
          const note = `'${record.username}' was adopted by ${adopted.id} on ${adopted.at.slice(0, 10)}; this record is a new account and gets an id of its own. Paste that id into it only if this is the same person`;
          plan.notes.push(note);
          if (flag) flagNotes.push(`--adopt ${record.username}: ${note}`);
        }
        if (inv.rosterWritable) {
          plan.account = reserved ?? "fresh";
          plan.assignId = true;
          if (wants && !plan.refused) plan.data = "adopt";
        } else {
          plan.account = "manual";
          const suggestion = _suggestedIds.get(record.username) ?? mintBuiltinAccountId(record.username, heldIds(inv));
          _suggestedIds.set(record.username, suggestion);
          plan.idLine = `"id": "${suggestion}"`;
          plan.notes.push(`the roster is in a config shard, which is not written here: add ${plan.idLine} to the record of '${record.username}', then run the dry run again${wants ? ` and adopt with --adopt ${record.username}=${suggestion}` : ""}`);
        }
      } else {
        const created = inv.ledger.find((entry) => entry.event === "created" && sameAccountId(entry.id, record.id!));
        if (created) plan.notes.push(`'${record.username}' was created on ${created.at.slice(0, 10)}, after account ids: adopt this data only if it is the same person`);
        else if (adopted && sameAccountId(adopted.id, record.id)) plan.notes.push(`adopted by ${adopted.id} on ${adopted.at.slice(0, 10)}`);
        plan.account = record.id;
        if (flag) {
          if (flag.id === undefined) refuseAdoption(`name the account: --adopt ${record.username}=${record.id}`);
          else if (!sameAccountId(flag.id, record.id)) refuseAdoption(`'${record.username}' holds the account id ${record.id}, not ${flag.id}`);
          else plan.data = "adopt";
        }
      }
      if (plan.data === "adopt" && unassignedIds.has(record.username)) refuseAdoption(unassignedIds.get(record.username)!);
    } else if (kind === "oidc") {
      const entry = inv.registry.find((candidate) => candidate.username === name)!;
      plan.account = entry.id;
      plan.notes.push(`identity provider ${entry.issuer}, subject ${entry.subject}, first sign-in ${entry.firstSeenAt.slice(0, 10)}, ${entry.status}`);
      if (flag) {
        if (flag.id === undefined) refuseAdoption(`name the account: --adopt ${entry.username}=${entry.id}`);
        else if (!sameAccountId(flag.id, entry.id)) refuseAdoption(`'${entry.username}' is the account ${entry.id}, not ${flag.id}`);
        else if (entry.status === "retired") refuseAdoption(`the account ${entry.id} is retired`);
        else {
          plan.data = "adopt";
          plan.activate = entry.status === "pending";
        }
      } else if (entry.status === "pending") {
        plan.notes.push(`stays pending (cannot sign in) until adopted with --adopt ${entry.username}=${entry.id} or declined (POST /api/admin/accounts/${entry.id}/decline-legacy)`);
      }
    } else if (kind === "extension") {
      plan.data = "in-place";
      plan.notes.push("an extension provider's user: its account id is this segment already");
    } else if (PRINCIPAL_KINDS.has(kind)) {
      plan.data = "in-place";
      plan.graph = retaggedBefore ? "none" : "segment";
    } else if (kind === "oidc-unseen") {
      plan.notes.push("signed in through the identity provider before account ids and not since: ask them to sign in once, then run the dry run again");
    } else if (kind === "deleted-builtin") {
      if (holds.has(name ?? "") || holds.has(segment.toLowerCase())) {
        plan.notes.push("held (--hold)");
      } else {
        plan.data = "archive";
      }
      plan.disableSchedules = legacySchedules > 0;
    } else {
      if (request.archiveUnmapped && !holds.has(name ?? "") && !holds.has(segment.toLowerCase())) plan.data = "archive";
    }

    // Adoption of a name the flags named but whose kind takes none.
    if (flag && !request.reset && !["builtin", "oidc"].includes(kind) && !plan.refused) {
      refuseAdoption(kind === "oidc-unseen"
        ? `'${username}' has no account yet: it gets one at its first sign-in`
        : `'${username}' is ${KIND_DESCRIPTIONS[kind]}, which no account adopts`);
    }
    // The bucket a bootstrap token's name always used stays the token's, whoever else has the name.
    // The account itself still gets its id (or turns active): it starts empty, and that never changes.
    if (bootstrapName && plan.data === "adopt") {
      const why = `'${username}' is a bootstrap token's name: what it stored stays with the bootstrap token (sai token), and the account starts empty`;
      plan.data = "hold";
      plan.notes.push(why);
      conflicts.push(`${username}: ${why}`);
    }
    // A directory a running app binds is not moved under it.
    if ((plan.data === "adopt" || plan.data === "archive") && bindsSegment(inv.appBinds, segment)) {
      const why = `a running served app binds users/${segment}: stop it first`;
      plan.refused = why;
      plan.data = "hold";
      conflicts.push(`${username ?? segment}: ${why}`);
    }
    // Data moved to an account that has a directory of its own is never merged into it.
    if (plan.data === "adopt" && plan.account && plan.account !== "fresh" && plan.account !== "manual") {
      const own = inv.accountDirs.get(plan.account.toLowerCase()) ?? new Set<BaseName>();
      const clash = [...stored.buckets].filter((base) => own.has(base));
      if (clash.length > 0) {
        const why = `users/${plan.account} exists already in ${clash.sort().join(", ")}: the account has data of its own, and nothing is merged`;
        plan.refused = why;
        plan.data = "hold";
        plan.activate = false;
        conflicts.push(`${username ?? segment}: ${why}`);
      }
    }
    if (plan.refused && !conflicts.some((conflict) => conflict.endsWith(plan.refused!))) conflicts.push(`${username ?? segment}: ${plan.refused}`);

    if (plan.data === "adopt" || plan.data === "archive") {
      for (const base of [...stored.buckets].sort()) {
        moves.push({ identity: segment, base, from: segment, to: plan.data === "adopt" ? plan.account ?? "fresh" : `.retired/${segment}-*` });
      }
    }
    identities.push(plan);
  }

  for (const value of holds) {
    if (!identities.some((plan) => plan.username?.toLowerCase() === value || plan.segment.toLowerCase() === value)) {
      flagNotes.push(`--hold ${value}: nothing is stored under that name or segment from before account ids`);
    }
  }
  for (const flag of request.adopt) {
    if (usedAdoptFlags.has(flag.username)) continue;
    const adopted = adoptionOf(flag.username, inv);
    flagNotes.push(adopted
      ? `--adopt ${flag.username}: adopted by ${adopted.id} on ${adopted.at.slice(0, 10)}; nothing is left to adopt`
      : `--adopt ${flag.username}: nothing is stored under that name from before account ids`);
  }

  const restores = request.adoptRetired.map((restore): PlannedRestore => {
    const bases = [...(inv.archives.get(restore.archive) ?? [])].sort();
    const living = inv.accountIds.has(restore.id.toLowerCase());
    const own = inv.accountDirs.get(restore.id.toLowerCase()) ?? new Set<BaseName>();
    const clash = bases.filter((base) => own.has(base));
    const refused = bases.length === 0
      ? `no archive '${restore.archive}' in users/.retired`
      : !living
        ? `${restore.id} is no living account`
        : clash.length > 0
          ? `users/${restore.id} exists already in ${clash.join(", ")}: nothing is merged`
          : undefined;
    if (refused) conflicts.push(`--adopt-retired ${restore.archive}: ${refused}`);
    return { archive: restore.archive, account: restore.id, bases, ...(refused ? { refused } : {}) };
  });
  const issuerAlias = request.oidcIssuerAlias
    ? { ...request.oidcIssuerAlias, entries: inv.registry.filter((entry) => entry.issuer === request.oidcIssuerAlias!.from).length }
    : undefined;

  return finishPlan(inv, request, request.reset ? "reset" : "migrate", identities, moves, restores, conflicts, flagNotes, undefined, issuerAlias);
}

/** The reset of one identity: every account starts empty, principals keep theirs. */
function planReset(plan: PlannedIdentity, inv: Inventory, stored: StoredUnder, retaggedBefore: boolean, legacySchedules: number): void {
  const name = plan.username?.toLowerCase();
  if (plan.kind === "builtin") {
    const record = inv.roster.find((candidate) => candidate.username === name)!;
    if (!record.id) {
      if (inv.rosterWritable) {
        plan.account = reservedIdFor(record.username, inv) ?? "fresh";
        plan.assignId = true;
      } else {
        plan.account = "manual";
        const suggestion = _suggestedIds.get(record.username) ?? mintBuiltinAccountId(record.username, heldIds(inv));
        _suggestedIds.set(record.username, suggestion);
        plan.idLine = `"id": "${suggestion}"`;
        plan.notes.push(`the roster is in a config shard, which is not written here: add ${plan.idLine} to the record of '${record.username}'`);
      }
    } else {
      plan.account = record.id;
    }
  } else if (plan.kind === "oidc") {
    const entry = inv.registry.find((candidate) => candidate.username === name)!;
    plan.account = entry.id;
    plan.activate = entry.status === "pending";
  }
  if (plan.kind === "extension") {
    plan.data = "in-place";
  } else if (PRINCIPAL_KINDS.has(plan.kind)) {
    plan.data = "in-place";
    plan.graph = retaggedBefore ? "none" : "segment";
  } else {
    plan.data = "archive";
    plan.graph = retaggedBefore ? "none" : "retired";
    plan.disableSchedules = legacySchedules > 0;
    if (stored.buckets.size === 0 && stored.stamps === 0) plan.notes.push("nothing stored under the name's segment");
  }
}

function planPurge(inv: Inventory, account: string): PlannedPurge {
  const key = account.toLowerCase();
  const tombstone = inv.tombstones.find((candidate) => candidate.id && sameAccountId(candidate.id, account));
  const entry = inv.registry.find((candidate) => sameAccountId(candidate.id, account));
  const live = inv.roster.some((record) => record.id && sameAccountId(record.id, account));
  const username = tombstone?.username ?? entry?.username;
  const refused = live
    ? `${account} is a living builtin account: delete it first`
    : entry && entry.status !== "retired"
      ? `${account} is a living identity-provider account: retire it first`
      : !tombstone && !entry
        ? `no deleted or retired account holds ${account}`
        : undefined;
  const directories = inv.bases.filter((base) => existsSync(resolve(base.path, USERS_SUBDIR, account))).map((base) => base.name);
  // Archives are named `<segment>-<UTC stamp>`, and the migration archives only buckets of names,
  // never an account's own directory: matching `<id>-` found none, and a prefix could match another
  // segment that starts with the id. The archives of what the account's name stored before account
  // ids are matched by the segments the ledger records the migration archived for it.
  const segments = new Set([key, ...archivedLegacySegments(inv, account, tombstone).map((segment) => segment.toLowerCase())]);
  const archives = [...inv.archives.keys()].filter((name) => {
    const segment = archivedSegment(name);
    return segment !== undefined && segments.has(segment.toLowerCase());
  }).sort();
  const stamps = [...inv.stampCounts].filter(([stamped]) => stamped.toLowerCase() === key).reduce((sum, [, n]) => sum + n, 0);
  const sessions = [...inv.sessionsByUser.values()].flat().filter((session) => session.account?.toLowerCase() === key).length;
  const knowledgeBases = inv.kbs.filter((kb) => kb.ownerAccount?.toLowerCase() === key).length;
  const corpora = new Set([`user:${key}`, ...purgedAliasSources(getConfig().workspacePath, account).map((source) => source.toLowerCase())]);
  const documents = [...inv.documentSources].filter(([source]) => corpora.has(source.toLowerCase())).reduce((sum, [, n]) => sum + n, 0);
  return {
    account,
    ...(username ? { username } : {}),
    ...(refused ? { refused } : {}),
    removes: { directories, archives, stamps, sessions, knowledgeBases, documents, aliases: documentSourceAliases(account).length },
    keeps: ["audit_events and audit.jsonl (history)", "scene_jobs and missions rows: their account_id is set to retired:<id>, so they stay an admin's and are never a name's again"],
  };
}

const ARCHIVE_STAMP_RE = /-\d{8}T\d{6}Z$/;

/** The segment an archive in `users/.retired` was moved from, or undefined for a name that is not
 *  `<segment>-<UTC stamp>`. */
function archivedSegment(archive: string): string | undefined {
  return ARCHIVE_STAMP_RE.test(archive) ? archive.replace(ARCHIVE_STAMP_RE, "") : undefined;
}

/**
 * The segments the migration archived for what a deleted builtin account's username stored before
 * account ids, when that was this account's: the ledger records each archive decision with its
 * username. It was not when the ledger records the account as created after account ids (an
 * earlier person had the name), or the name as adopted by another id (that one took it). An
 * identity-provider account's data from before account ids moved into its id when it was adopted,
 * and was not its when it was declined.
 */
function archivedLegacySegments(inv: Inventory, account: string, tombstone: AccountTombstone | undefined): string[] {
  if (!tombstone || tombstone.kind !== "builtin") return [];
  const name = tombstone.username.toLowerCase();
  const later = inv.ledger.some((entry) => entry.event === "created" && sameAccountId(entry.id, account));
  const adoptedElsewhere = inv.ledger.some((entry) => entry.event === "adopted" && entry.username === name && !sameAccountId(entry.id, account));
  if (later || adoptedElsewhere) return [];
  const segments = new Set<string>();
  for (const entry of inv.ledger) {
    if (entry.event !== "applied" || !Array.isArray(entry.decisions)) continue;
    for (const decision of entry.decisions as Array<{ segment?: unknown; username?: unknown; data?: unknown }>) {
      if (decision.data === "archive" && typeof decision.segment === "string" && typeof decision.username === "string" && decision.username.toLowerCase() === name) {
        segments.add(decision.segment);
      }
    }
  }
  return [...segments];
}

/**
 * The corpora from before account ids that `account` adopted (its document aliases) and that no
 * other account reads: a purge removes them with the account. Kept, an adopted `user:<username>`
 * corpus outlived the purge, and once the alias was gone the next dry run offered it as the name's
 * legacy data, to the next account of that name too.
 */
function purgedAliasSources(workspace: string, account: string): string[] {
  return documentSourceAliases(account).filter((source) => documentSourceAliasHolders(workspace, source).every((holder) => sameAccountId(holder, account)));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function finishPlan(
  inv: Inventory,
  request: AccountMigrationRequest,
  mode: AccountMigrationPlan["mode"],
  identities: PlannedIdentity[],
  moves: PlannedMove[],
  restores: PlannedRestore[],
  conflicts: string[],
  flagNotes: string[],
  purge?: PlannedPurge,
  issuerAlias?: AccountMigrationPlan["issuerAlias"],
): AccountMigrationPlan {
  // The decisions, and nothing that changes while the gateway runs: no sizes, no counts, no stamps.
  const decisions = {
    v: 1,
    mode,
    identities: identities.map((plan) => [plan.segment, plan.username ?? "", plan.kind, plan.account ?? "", plan.data, plan.graph, plan.assignId, plan.activate, plan.disableSchedules, plan.refused ?? ""]),
    moves: moves.map((move) => [move.base, move.from, move.to]).sort((left, right) => left.join("/").localeCompare(right.join("/"))),
    restores: restores.map((restore) => [restore.archive, restore.account, restore.bases, restore.refused ?? ""]),
    conflicts: [...conflicts].sort(),
    issuerAlias: issuerAlias ? [issuerAlias.from, issuerAlias.to] : null,
    purge: purge ? [purge.account, purge.refused ?? "", purge.removes.directories, purge.removes.archives] : null,
    flags: {
      adopt: request.adopt.map((flag) => `${flag.username}=${flag.id ?? ""}`).sort(),
      adoptLegacyRecords: request.adoptLegacyRecords,
      archiveUnmapped: request.archiveUnmapped,
      hold: [...request.hold].map((value) => value.toLowerCase()).sort(),
      adoptRetired: request.adoptRetired.map((restore) => `${restore.archive}=${restore.id}`).sort(),
      oidcIssuerAlias: request.oidcIssuerAlias ? `${request.oidcIssuerAlias.from}=${request.oidcIssuerAlias.to}` : "",
      reset: request.reset,
      purgeRetired: request.purgeRetired ?? "",
    },
  };
  const hash = createHash("sha256").update(canonical(decisions)).digest("hex").slice(0, 16);
  const actionable = identities.filter((plan) => !plan.refused && isActionable(plan, inv, mode)).length
    + restores.filter((restore) => !restore.refused).length
    + (issuerAlias && issuerAlias.entries > 0 ? 1 : 0)
    + (purge && !purge.refused ? 1 : 0);
  return {
    hash,
    mode,
    maintenance: accountMigrationMaintenance(),
    identities,
    moves,
    restores,
    ...(issuerAlias ? { issuerAlias } : {}),
    ...(purge ? { purge } : {}),
    conflicts,
    flagNotes,
    problems: inv.problems,
    actionable,
    nothingToMigrate: actionable === 0,
  };
}

/** Whether the apply would change anything for this identity. */
function isActionable(plan: PlannedIdentity, inv: Inventory, mode: AccountMigrationPlan["mode"]): boolean {
  if (plan.assignId || plan.activate || plan.disableSchedules || plan.graph !== "none") return true;
  const stored = inv.stored.get(plan.segment);
  if (!stored) return false;
  if (plan.data === "adopt") return hasMovableData(stored);
  // A reset also retires the stamps on the shared ledgers; an archive alone moves directories.
  if (plan.data === "archive") return stored.buckets.size > 0 || (mode === "reset" && stored.stamps > 0);
  return false;
}

// ── The apply ───────────────────────────────────────────────────────────────

export type StepOutcome = "done" | "nothing" | "skipped" | `failed: ${string}`;

export interface IdentityResult {
  segment: string;
  username?: string;
  account?: string;
  ok: boolean;
  steps: Record<string, StepOutcome>;
}

const RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

/** A rename that waits out a Windows sharing error for a moment (a reader holding the directory). */
async function renameRetrying(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 6 || !code || !RENAME_RETRY_CODES.has(code)) throw err;
      await new Promise((done) => setTimeout(done, 25 * attempt));
    }
  }
}

function utcStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

interface ApplyContext {
  inv: Inventory;
  backends: AccountMigrationBackends;
  ledgerPath: string;
  workspace: string;
  now: Date;
}

function ledger(ctx: ApplyContext, entry: AccountLedgerEntry): void {
  appendAccountLedgerEntry(ctx.ledgerPath, entry);
}

/** Runs the steps in order and stops at the first that fails: what has not run is "skipped". */
async function runSteps(steps: Array<[string, () => Promise<StepOutcome> | StepOutcome]>): Promise<{ ok: boolean; steps: Record<string, StepOutcome> }> {
  const outcomes: Record<string, StepOutcome> = {};
  let ok = true;
  for (const [name, step] of steps) {
    if (!ok) {
      outcomes[name] = "skipped";
      continue;
    }
    try {
      outcomes[name] = await step();
    } catch (err) {
      outcomes[name] = `failed: ${reason(err)}`;
    }
    if (outcomes[name]!.startsWith("failed")) ok = false;
  }
  return { ok, steps: outcomes };
}

function basePath(ctx: ApplyContext, name: BaseName): string {
  return resolve(ctx.inv.bases.find((base) => base.name === name)!.path, USERS_SUBDIR);
}

/** Moves the identity's directories to `target` (an account id, or the archive). Every base is
 *  checked before anything moves: a target that exists where a source does refuses all of them. */
async function moveBuckets(ctx: ApplyContext, plan: PlannedIdentity, target: (segment: string) => string): Promise<StepOutcome> {
  const stored = ctx.inv.stored.get(plan.segment);
  const bases = [...(stored?.buckets ?? [])].sort();
  const pending: Array<{ users: string; from: string; to: string }> = [];
  for (const base of bases) {
    const users = basePath(ctx, base);
    const from = plan.segment;
    const to = target(plan.segment);
    if (!existsSync(resolve(users, from))) continue; // moved by an earlier run
    if (existsSync(resolve(users, to))) return `failed: users/${to} exists already in ${base}; nothing was moved`;
    pending.push({ users, from, to });
  }
  if (pending.length === 0) return "nothing";
  for (const move of pending) {
    mkdirSync(resolve(move.users, move.to, ".."), { recursive: true });
    await renameRetrying(resolve(move.users, move.from), resolve(move.users, move.to));
    ledger(ctx, { event: "moved", base: move.users, from: move.from, to: move.to, at: new Date().toISOString() });
  }
  return "done";
}

function restamp(ctx: ApplyContext, from: string, to: string): StepOutcome {
  const rewrite = (account: string) => (account === from ? to : undefined);
  const changed = rewriteOutcomeAccounts(ctx.workspace, rewrite)
    + rewriteFlowMemoryAccounts(ctx.workspace, rewrite)
    + rewriteConversationConfigProposalAccounts(ctx.workspace, rewrite);
  return changed > 0 ? "done" : "nothing";
}

async function migrateSessions(ctx: ApplyContext, plan: PlannedIdentity, account: string): Promise<StepOutcome> {
  const sessions = ctx.inv.stored.get(plan.segment)?.sessions ?? [];
  if (ctx.inv.problems.some((problem) => problem.source === "Redis session mirror")) {
    return "failed: the Redis session mirror could not be read, so a session only it holds could be missed";
  }
  let changed = 0;
  for (const session of sessions) {
    if (session.mirrorJson !== undefined) {
      if (await migrateMirroredSessionAccount(session.id, session.mirrorJson, account, ctx.backends.mirror)) changed += 1;
    } else if (await migrateSessionAccount(session.id, account, ctx.backends.mirror) === "migrated") {
      changed += 1;
    }
  }
  return changed > 0 ? "done" : "nothing";
}

async function backfillRows(ctx: ApplyContext, plan: PlannedIdentity, account: string): Promise<StepOutcome> {
  const stored = ctx.inv.stored.get(plan.segment);
  if (!stored || (stored.jobs === 0 && stored.missions === 0) || !plan.username) return "nothing";
  if (!ctx.backends.sql) return "nothing";
  if (ctx.inv.problems.some((problem) => problem.source === "Postgres")) return "failed: Postgres could not be read";
  if (ctx.inv.sqlTables.jobs) {
    await ctx.backends.sql.query(
      "UPDATE scene_jobs SET account_id = $1 WHERE user_id = $2 AND account_id IS NULL AND (payload->>'principal') IS NULL",
      [account, plan.username],
    );
  }
  if (ctx.inv.sqlTables.missions) {
    await ctx.backends.sql.query("UPDATE missions SET account_id = $1 WHERE user_id = $2 AND account_id IS NULL", [account, plan.username]);
  }
  return "done";
}

function stampSchedules(ctx: ApplyContext, plan: PlannedIdentity, account: string): StepOutcome {
  const tasks = ctx.inv.stored.get(plan.segment)?.schedules ?? [];
  for (const task of tasks) {
    const { principal: _principal, ...rest } = task;
    saveScheduledTask({ ...rest, account });
  }
  return tasks.length > 0 ? "done" : "nothing";
}

function disableSchedules(ctx: ApplyContext, plan: PlannedIdentity, reasonText: string): StepOutcome {
  let changed = 0;
  for (const task of ctx.inv.stored.get(plan.segment)?.schedules ?? []) {
    if (disableScheduledTask(task.id, { at: new Date().toISOString(), reason: reasonText })) changed += 1;
  }
  return changed > 0 ? "done" : "nothing";
}

async function stampKnowledgeBases(ctx: ApplyContext, plan: PlannedIdentity, account: string): Promise<StepOutcome> {
  const kbs = ctx.inv.stored.get(plan.segment)?.kbs ?? [];
  for (const kb of kbs) {
    await mutateKnowledgeBase(kb.id, (record) => {
      record.ownerAccount = account;
      delete record.ownerPrincipal;
    });
  }
  return kbs.length > 0 ? "done" : "nothing";
}

async function retagGraph(ctx: ApplyContext, plan: PlannedIdentity, mode: "account" | "segment" | "retired", account?: string): Promise<StepOutcome> {
  if (!ctx.backends.cypher) return "nothing";
  if (mode === "segment") {
    if (!plan.username) return "nothing";
    await ctx.backends.cypher(
      "MATCH (m:MemoryRecord) WHERE m.scope = 'user' AND m.tenant = $username SET m.tenant = $segment RETURN count(m) AS n",
      { username: plan.username, segment: plan.segment },
    );
    return "done";
  }
  const tenant = mode === "account" ? account! : `retired:${plan.segment}`;
  await ctx.backends.cypher(
    "MATCH (m:MemoryRecord) WHERE (m.scope = 'user' AND m.tenant = $username) OR (m.scope = 'workspace' AND m.tenant = $segment) SET m.tenant = $tenant RETURN count(m) AS n",
    { username: plan.username ?? null, segment: plan.segment, tenant },
  );
  return "done";
}

function aliasDocuments(ctx: ApplyContext, plan: PlannedIdentity, account: string): StepOutcome {
  const stored = ctx.inv.stored.get(plan.segment);
  if (!stored || stored.documents === 0 || !plan.username) return "nothing";
  addDocumentSourceAlias(ctx.workspace, account, `user:${plan.username}`);
  return "done";
}

/** The id an id-less record gets: the one an earlier apply reserved for it, or a new one, reserved
 *  in the ledger before any data moves to it. */
function reserveId(ctx: ApplyContext, plan: PlannedIdentity): string {
  if (plan.account && plan.account !== "fresh" && plan.account !== "manual") return plan.account;
  const id = mintBuiltinAccountId(plan.username!, heldIds(ctx.inv));
  ledger(ctx, { event: "reserved", id, username: plan.username!.toLowerCase(), at: new Date().toISOString() });
  return id;
}

/** Writes a builtin record's id into the roster the runtime writes, last. */
function writeRosterId(ctx: ApplyContext, username: string, id: string): StepOutcome {
  let written = false;
  updateConfig((raw) => {
    const auth = (raw["auth"] as Record<string, unknown>) ?? {};
    const users = Array.isArray(auth["users"]) ? auth["users"] as Array<Record<string, unknown>> : [];
    for (const record of users) {
      if (String(record["username"] ?? "").toLowerCase() === username && !record["id"]) {
        record["id"] = id;
        written = true;
      }
    }
    raw["auth"] = { ...auth, users };
  });
  if (!written) throw new Error(`the roster holds no id-less record '${username}' any more`);
  ledger(ctx, { event: "assigned", id, username, at: new Date().toISOString() });
  return "done";
}

/** A pending identity-provider account becomes active, last; its legacy data is recorded adopted. */
function activateAccount(plan: PlannedIdentity, account: string, decision: "adopted" | "declined"): StepOutcome {
  changeAccountRegistry((doc) => {
    const entry = doc.accounts.find((candidate) => sameAccountId(candidate.id, account));
    if (!entry) throw new Error(`the registry holds no account ${account}`);
    if (entry.status === "retired") throw new Error(`the account ${account} is retired`);
    entry.status = "active";
    entry.legacy = { segment: entry.legacy?.segment ?? plan.segment, decision, decidedAt: new Date().toISOString() };
  });
  return "done";
}

async function applyIdentity(ctx: ApplyContext, plan: PlannedIdentity, mode: AccountMigrationPlan["mode"]): Promise<IdentityResult | null> {
  if (plan.refused || !isActionable(plan, ctx.inv, mode)) return null;
  const base: Omit<IdentityResult, "ok" | "steps"> = { segment: plan.segment, ...(plan.username ? { username: plan.username } : {}) };

  if (plan.data === "in-place" || (plan.data === "hold" && !plan.assignId && !plan.activate)) {
    if (plan.graph !== "segment") return null;
    const run = await runSteps([
      ["graph", () => retagGraph(ctx, plan, "segment")],
      ["record", () => {
        ledger(ctx, { event: "retagged", ...(plan.username ? { username: plan.username } : {}), segment: plan.segment, at: new Date().toISOString() });
        return "done";
      }],
    ]);
    return { ...base, ...run };
  }

  if (plan.data === "archive") {
    const stamp = utcStamp(ctx.now);
    const steps: Array<[string, () => Promise<StepOutcome> | StepOutcome]> = [
      ["directories", () => moveBuckets(ctx, plan, (segment) => `.retired/${segment}-${stamp}`)],
    ];
    if (mode === "reset") {
      steps.push(["stamps", () => restamp(ctx, plan.segment, `retired:${plan.segment}`)]);
      if (plan.graph === "retired") {
        steps.push(["graph", () => retagGraph(ctx, plan, "retired")]);
        steps.push(["graphRecord", () => {
          ledger(ctx, { event: "retagged", ...(plan.username ? { username: plan.username } : {}), segment: plan.segment, at: new Date().toISOString() });
          return "done";
        }]);
      }
    }
    if (plan.disableSchedules) steps.push(["schedules", () => disableSchedules(ctx, plan, mode === "reset" ? "account storage reset" : "account deleted")]);
    let account: string | undefined;
    if (plan.assignId && plan.username) {
      steps.push(["account", () => {
        account = reserveId(ctx, plan);
        return writeRosterId(ctx, plan.username!.toLowerCase(), account);
      }]);
    } else if (plan.activate && plan.account) {
      steps.push(["account", () => activateAccount(plan, plan.account!, "declined")]);
    }
    const run = await runSteps(steps);
    return { ...base, ...(account ?? plan.account ? { account: account ?? plan.account } : {}), ...run };
  }

  // Adoption, or an id (and activation) with the data held.
  let account = plan.account && plan.account !== "fresh" && plan.account !== "manual" ? plan.account : undefined;
  const steps: Array<[string, () => Promise<StepOutcome> | StepOutcome]> = [];
  if (plan.assignId && !account) {
    steps.push(["reserve", () => {
      account = reserveId(ctx, plan);
      return "done";
    }]);
  }
  if (plan.data === "adopt") {
    steps.push(
      ["directories", () => moveBuckets(ctx, plan, () => account!)],
      ["stamps", () => restamp(ctx, plan.segment, account!)],
      ["sessions", () => migrateSessions(ctx, plan, account!)],
      ["jobs", () => backfillRows(ctx, plan, account!)],
      ["schedules", () => stampSchedules(ctx, plan, account!)],
      ["knowledgeBases", () => stampKnowledgeBases(ctx, plan, account!)],
      ["graph", () => retagGraph(ctx, plan, "account", account!)],
      ["documents", () => aliasDocuments(ctx, plan, account!)],
    );
  }
  // Last: the account can sign in only once everything else is done.
  if (plan.assignId) steps.push(["account", () => writeRosterId(ctx, plan.username!.toLowerCase(), account!)]);
  else if (plan.activate) steps.push(["account", () => activateAccount(plan, account!, plan.data === "adopt" ? "adopted" : "declined")]);
  if (plan.data === "adopt") {
    steps.push(["ledger", () => {
      ledger(ctx, { event: "adopted", id: account!, username: plan.username!.toLowerCase(), segment: plan.segment, at: new Date().toISOString() });
      return "done";
    }]);
  }
  const run = await runSteps(steps);
  return { ...base, ...(account ? { account } : {}), ...run };
}

async function applyRestore(ctx: ApplyContext, restore: PlannedRestore): Promise<IdentityResult> {
  return {
    segment: restore.archive,
    account: restore.account,
    ...await runSteps([["directories", async () => {
      const pending: Array<{ users: string }> = [];
      for (const base of restore.bases) {
        const users = basePath(ctx, base);
        if (!existsSync(resolve(users, ".retired", restore.archive))) continue;
        if (existsSync(resolve(users, restore.account))) return `failed: users/${restore.account} exists already in ${base}; nothing was restored`;
        pending.push({ users });
      }
      if (pending.length === 0) return "nothing";
      for (const { users } of pending) {
        await renameRetrying(resolve(users, ".retired", restore.archive), resolve(users, restore.account));
        ledger(ctx, { event: "moved", base: users, from: `.retired/${restore.archive}`, to: restore.account, at: new Date().toISOString() });
      }
      return "done";
    }]]),
  };
}

function applyIssuerAlias(alias: { from: string; to: string }): StepOutcome {
  let changed = 0;
  changeAccountRegistry((doc) => {
    for (const entry of doc.accounts) {
      if (entry.issuer === alias.from) {
        entry.issuer = alias.to;
        changed += 1;
      }
    }
  });
  return changed > 0 ? "done" : "nothing";
}

async function applyPurge(ctx: ApplyContext, purge: PlannedPurge): Promise<IdentityResult> {
  const account = purge.account;
  return {
    segment: account,
    ...(purge.username ? { username: purge.username } : {}),
    account,
    ...await runSteps([
      ["directories", () => {
        let removed = 0;
        for (const base of ctx.inv.bases) {
          const users = resolve(base.path, USERS_SUBDIR);
          if (existsSync(resolve(users, account))) {
            rmSync(resolve(users, account), { recursive: true, force: true });
            removed += 1;
          }
          // The archives the plan named, and no other.
          for (const archive of purge.removes.archives) {
            if (existsSync(resolve(users, ".retired", archive))) {
              rmSync(resolve(users, ".retired", archive), { recursive: true, force: true });
              removed += 1;
            }
          }
        }
        return removed > 0 ? "done" : "nothing";
      }],
      ["stamps", () => {
        const drop = (stamped: string) => (sameAccountId(stamped, account) ? null : undefined);
        const changed = rewriteOutcomeAccounts(ctx.workspace, drop) + rewriteFlowMemoryAccounts(ctx.workspace, drop) + rewriteConversationConfigProposalAccounts(ctx.workspace, drop);
        return changed > 0 ? "done" : "nothing";
      }],
      ["sessions", async () => {
        if (ctx.inv.problems.some((problem) => problem.source === "Redis session mirror")) return "failed: the Redis session mirror could not be read";
        const mirrored = (await ctx.backends.mirroredSessions()) ?? [];
        return await purgeAccountSessions(account, mirrored, ctx.backends.mirror) > 0 ? "done" : "nothing";
      }],
      ["jobs", async () => {
        if (!ctx.backends.sql) return "nothing";
        // Not cleared: a row with no account id is a name's again, and an adoption of that name
        // would take it over. Retired, it stays an admin's.
        if (ctx.inv.sqlTables.jobs) await ctx.backends.sql.query("UPDATE scene_jobs SET account_id = $2 WHERE account_id = $1", [account, `retired:${account}`]);
        if (ctx.inv.sqlTables.missions) await ctx.backends.sql.query("UPDATE missions SET account_id = $2 WHERE account_id = $1", [account, `retired:${account}`]);
        return "done";
      }],
      ["knowledgeBases", async () => {
        const owned = (await listKnowledgeBases()).filter((kb) => kb.ownerAccount && sameAccountId(kb.ownerAccount, account));
        for (const kb of owned) {
          await removeDocumentsOfSource(ctx, kbSource(kb.id));
          await removeKnowledgeBaseRecord(kb.id);
        }
        return owned.length > 0 ? "done" : "nothing";
      }],
      ["documents", async () => {
        let removed = await removeDocumentsOfSource(ctx, `user:${account}`);
        // The adopted corpora go before their aliases, so a re-run after a failure still finds them.
        for (const source of purgedAliasSources(ctx.workspace, account)) removed += await removeDocumentsOfSource(ctx, source);
        const aliases = removeDocumentSourceAliases(ctx.workspace, account);
        return removed + aliases.length > 0 ? "done" : "nothing";
      }],
      ["graph", async () => {
        if (!ctx.backends.cypher) return "nothing";
        await ctx.backends.cypher("MATCH (m:MemoryRecord) WHERE m.tenant = $account DETACH DELETE m RETURN 0 AS n", { account });
        return "done";
      }],
    ]),
  };
}

/** Removes every document registered under `source`, in engram and in the registry. */
async function removeDocumentsOfSource(ctx: ApplyContext, source: string): Promise<number> {
  const registered = (await listRegistry()).filter((entry) => entry.source === source);
  const ids = new Set(registered.map((entry) => entry.documentId));
  if (ctx.backends.documents) {
    const listed = await ctx.backends.documents.list();
    if (listed === null) throw new Error("engram did not list its documents");
    for (const doc of listed) if (doc.sources.includes(source)) ids.add(doc.id);
    for (const id of ids) {
      if (!await ctx.backends.documents.remove(id, source)) throw new Error(`engram did not remove document ${id}`);
    }
  }
  for (const id of ids) await unregisterDocument(id, source);
  return ids.size;
}

// ── One run ─────────────────────────────────────────────────────────────────

export type AccountMigrationResult =
  | { status: 200; plan: AccountMigrationPlan; applied?: { results: IdentityResult[]; ok: boolean } }
  | { status: 409; error: string; plan?: AccountMigrationPlan };

let _running: Promise<unknown> | null = null;

/**
 * One dry run, or one apply of the plan the request names. One run at a time: a second request
 * while one runs is refused, so two applies never interleave their steps.
 */
export async function runAccountMigration(request: AccountMigrationRequest, backends: AccountMigrationBackends, actor: string): Promise<AccountMigrationResult> {
  if (_running) return { status: 409, error: "An account migration run is in progress; try again when it has finished" };
  const run = (async (): Promise<AccountMigrationResult> => {
    if (request.apply && !accountMigrationMaintenance()) {
      return { status: 409, error: `Apply, reset and purge run only in a maintenance boot: restart the gateway with SAI_MAINTENANCE=${ACCOUNT_MIGRATION_MAINTENANCE}` };
    }
    const inv = await takeInventory(backends);
    const plan = buildPlan(inv, request);
    if (!request.apply) return { status: 200, plan };
    if (request.plan !== plan.hash) return { status: 409, error: "State changed since the dry run: run the dry run again and apply its plan", plan };
    const blocking = inv.problems.filter((problem) => problem.blocking);
    if (blocking.length > 0) {
      return { status: 409, error: `Nothing was applied: ${blocking.map((problem) => `${problem.source} ${problem.reason}`).join("; ")}`, plan };
    }
    if (plan.nothingToMigrate) return { status: 200, plan, applied: { results: [], ok: true } };

    const ctx: ApplyContext = { inv, backends, ledgerPath: accountLedgerPath(getConfig().workspacePath), workspace: getConfig().workspacePath, now: new Date() };
    const results: IdentityResult[] = [];
    if (plan.purge) {
      if (!plan.purge.refused) results.push(await applyPurge(ctx, plan.purge));
    } else {
      for (const identity of plan.identities) {
        const result = await applyIdentity(ctx, identity, plan.mode);
        if (result) results.push(result);
      }
      for (const restore of plan.restores) if (!restore.refused) results.push(await applyRestore(ctx, restore));
      if (plan.issuerAlias && plan.issuerAlias.entries > 0) {
        results.push({ segment: "issuer", ...await runSteps([["registry", () => applyIssuerAlias(plan.issuerAlias!)]]) });
      }
    }
    const ok = results.every((result) => result.ok);
    try {
      ledger(ctx, {
        event: "applied",
        at: new Date().toISOString(),
        planHash: plan.hash,
        mode: plan.mode,
        decisions: plan.identities.map((identity) => ({ segment: identity.segment, username: identity.username, kind: identity.kind, account: identity.account, data: identity.data, graph: identity.graph })),
        results,
      });
    } catch (err) {
      log.error({ err }, "Could not record the account migration's apply in the account ledger");
    }
    logAudit("account_migration_applied", {
      actor,
      planHash: plan.hash,
      mode: plan.mode,
      identities: results.length,
      failed: results.filter((result) => !result.ok).length,
    }, { userId: actor, severity: "warn" });
    return { status: 200, plan, applied: { results, ok } };
  })();
  _running = run;
  try {
    return await run;
  } finally {
    _running = null;
  }
}

// ── The boot warning ────────────────────────────────────────────────────────

/**
 * What still waits for the account migration, counted cheaply at boot under multi-user auth: roster
 * records without an id (they cannot sign in), identity-provider accounts pending, sessions from
 * before account ids (read-only, admins only), and directories under `users/` that are no account's
 * and that no apply decided. Logs one warning when anything waits; writes nothing.
 */
export function reportAccountMigrationBacklog(bases: string[]): { idless: number; pending: number; sessions: number; buckets: number } {
  const config = getConfig();
  const idless = config.auth.users.filter((user) => !user.id).length;
  const pending = accountRegistryEntries().filter((entry) => entry.status === "pending").length;
  const sessions = getAllSessions({ includeArchived: true }).filter((session) => session.isLegacy()).length;
  // A deleted account's directory stays under its id until a purge: it is no legacy bucket.
  const accountIds = new Set([
    ...config.auth.users.flatMap((user) => (user.id ? [user.id.toLowerCase()] : [])),
    ...accountRegistryEntries().map((entry) => entry.id.toLowerCase()),
    ...endedAccountIds(accountTombstones()),
  ]);
  const known = new Set([DEFAULT_BOOTSTRAP_SUB, ...accountRegistryBootstrapSubs()].map((sub) => principalSegment(sub)));
  for (const session of getAllSessions({ includeArchived: true })) {
    if (session.principal && session.userId) known.add(principalSegment(session.userId));
  }
  try {
    for (const entry of readAccountLedger(accountLedgerPath(config.workspacePath))) {
      if (entry.event !== "applied" || !Array.isArray(entry.decisions)) continue;
      for (const decision of entry.decisions as Array<{ segment?: unknown }>) if (typeof decision.segment === "string") known.add(decision.segment);
    }
  } catch { /* an unreadable ledger decides nothing: every bucket is counted */ }
  const buckets = new Set<string>();
  for (const base of bases) {
    for (const name of listDirs(resolve(base, USERS_SUBDIR))) {
      if (name.startsWith(".") || accountIds.has(name.toLowerCase()) || known.has(name)) continue;
      buckets.add(name);
    }
  }
  const counts = { idless, pending, sessions, buckets: buckets.size };
  if (idless + pending + sessions + buckets.size > 0) {
    log.warn(
      { accountsWithoutId: idless, pendingIdentityProviderAccounts: pending, legacySessions: sessions, legacyBuckets: buckets.size },
      "Account storage from before account ids waits for the account migration: accounts without an id cannot sign in, pending identity-provider accounts wait for an admin, and older sessions are read-only. Run `sai migrate-account-ids` (a dry run, which writes nothing) to see the plan",
    );
  }
  return counts;
}

/** Test-only: forget the ids suggested for shard-held records and the default Postgres pool. */
export function resetAccountMigrationForTests(): void {
  _suggestedIds.clear();
  _defaultSql = undefined;
  _running = null;
}
