import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { Hono } from "hono";
import type { AccountMigrationBackends, MigrationSql } from "../runtime/account-migration.js";
import { bootstrapClaims, DUMMY_PASSWORD_HASH, testAccount, testAccountId } from "./support/test-account.js";

/**
 * The account migration (S5): per-account storage keyed by the username's segment moves to the
 * account's immutable id, but only where an admin names the pair.
 *
 * Every test drives the real route through the maintenance gateway's app (its policy gate included)
 * against temp directories. Postgres, MemGraph and the Redis session mirror are fakes that record
 * every call; the Redis fake also stands in for the session module's mirror, so sessions from before
 * account ids are hydrated the way a boot hydrates them.
 */

const redis = vi.hoisted(() => ({
  store: new Map<string, string>(),
  /** Records the boot does not hydrate (past its cap): only the full index reads them. */
  hidden: new Set<string>(),
  /** Read-back returns a different record. */
  tamper: false,
}));
vi.mock("../agent/session-redis.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent/session-redis.js")>()),
  saveSessionToRedis: async (id: string, json: string) => { redis.store.set(id, json); },
  loadSessionFromRedis: async (id: string) => redis.store.get(id) ?? null,
  deleteSessionFromRedis: async (id: string) => { redis.store.delete(id); },
  loadAllSessionsFromRedis: async () => [...redis.store].filter(([id]) => !redis.hidden.has(id)).map(([, json]) => json),
  loadEverySessionFromRedis: async () => [...redis.store].map(([id, json]) => ({ id, json })),
  saveSessionToRedisChecked: async (id: string, json: string) => { redis.store.set(id, json); return true; },
  loadSessionFromRedisChecked: async (id: string) => {
    const json = redis.store.get(id) ?? null;
    return json && redis.tamper ? json.replace("\"account\"", "\"acount\"") : json;
  },
  deleteSessionFromRedisChecked: async (id: string) => { redis.store.delete(id); return true; },
}));

const SECRET = "m".repeat(40);
const FILE_DIR = mkdtempSync(join(tmpdir(), "starlingai-account-migration-file-"));
const BASE = join(FILE_DIR, "base.json");
const OVERLAY = join(FILE_DIR, "overlay.json");
const SESSION_STORE = join(FILE_DIR, "sessions.json");
const dirs: string[] = [];
let mods: Awaited<ReturnType<typeof loadModules>>;

async function loadModules() {
  writeFileSync(BASE, JSON.stringify({ gateway: { jwtSecret: SECRET } }), "utf8");
  writeFileSync(OVERLAY, "{}", "utf8");
  process.env["SAI_CONFIG_PATH"] = BASE;
  process.env["SAI_MUTABLE_CONFIG_PATH"] = OVERLAY;
  process.env["SAI_SESSION_STORE"] = SESSION_STORE;
  process.env["SAI_JOB_WAKE_DISABLED"] = "1";
  delete process.env["DATABASE_URL"];
  delete process.env["REDIS_URL"];
  const loader = await import("../config/loader.js");
  const authModule = await import("../gateway/auth.js");
  const sessions = await import("../agent/session.js");
  const registry = await import("../runtime/account-registry.js");
  const tombstones = await import("../runtime/account-tombstones.js");
  const migration = await import("../runtime/account-migration.js");
  const maintenance = await import("../gateway/maintenance-gateway.js");
  const scheduled = await import("../runtime/scheduled-tasks.js");
  const aliases = await import("../retrieval/document-aliases.js");
  const rag = await import("../retrieval/document-rag.js");
  const accounts = await import("../runtime/accounts.js");
  const audit = await import("../audit/logger.js");
  const extension = await import("../extension/index.js");
  return { loader, authModule, sessions, registry, tombstones, migration, maintenance, scheduled, aliases, rag, accounts, audit, extension };
}

beforeAll(async () => {
  mods = await loadModules();
}, 60_000);

afterAll(() => {
  for (const key of ["SAI_CONFIG_PATH", "SAI_MUTABLE_CONFIG_PATH", "SAI_SESSION_STORE", "SAI_JOB_WAKE_DISABLED", "SAI_MAINTENANCE"]) delete process.env[key];
  rmSync(FILE_DIR, { recursive: true, force: true });
});

afterEach(async () => {
  delete process.env["SAI_MAINTENANCE"];
  await mods.audit.flushAuditLog();
  delete process.env["SAI_AUDIT_LOG"];
  mods.sessions.resetSessionsForTests();
  await mods.sessions.flushSessionStore();
  redis.store.clear();
  redis.hidden.clear();
  redis.tamper = false;
  mods.extension._resetExtensionsForTests();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ── The deployment under test ───────────────────────────────────────────────

/** The segment a name's storage had before account ids. */
const S = (name: string) => mods.accounts.principalSegment(name);

interface Deployment {
  ws: string;
  um: string;
  st: string;
  sql: FakeSql;
  cypher: Array<{ query: string; params: Record<string, unknown> }>;
  app: Hono;
  backends: AccountMigrationBackends;
}

interface FakeSql extends MigrationSql {
  calls: Array<{ text: string; params: unknown[] }>;
  jobs: Array<{ user_id: string; account_id: string | null; principal?: string }>;
  missions: Array<{ user_id: string; account_id: string | null }>;
  signIns: Array<{ user_id: string; via?: string; account?: string }>;
}

function fakeSql(): FakeSql {
  const sql: FakeSql = {
    calls: [],
    jobs: [],
    missions: [],
    signIns: [],
    async query(text: string, params: unknown[] = []) {
      sql.calls.push({ text, params });
      const count = <T extends { user_id: string }>(rows: T[]) => {
        const counts = new Map<string, number>();
        for (const row of rows) counts.set(row.user_id, (counts.get(row.user_id) ?? 0) + 1);
        return [...counts].map(([user_id, n]) => ({ user_id, n }));
      };
      if (text.includes("to_regclass")) return { rows: [{ jobs: true, missions: true, audit: true }] };
      if (text.startsWith("SELECT user_id, count(*)::int AS n FROM scene_jobs")) {
        return { rows: count(sql.jobs.filter((row) => row.account_id === null && !row.principal)) };
      }
      if (text.startsWith("SELECT user_id, count(*)::int AS n FROM missions")) return { rows: count(sql.missions.filter((row) => row.account_id === null)) };
      if (text.includes("FROM audit_events")) {
        return { rows: sql.signIns.map((row) => ({ user_id: row.user_id, via: row.via ?? null, account: row.account ?? null, n: 1 })) };
      }
      if (text.startsWith("UPDATE scene_jobs SET account_id = $1 WHERE user_id = $2")) {
        const rows = sql.jobs.filter((row) => row.user_id === params[1] && row.account_id === null && !row.principal);
        for (const row of rows) row.account_id = String(params[0]);
        return { rows: [], rowCount: rows.length };
      }
      if (text.startsWith("UPDATE missions SET account_id = $1 WHERE user_id = $2")) {
        const rows = sql.missions.filter((row) => row.user_id === params[1] && row.account_id === null);
        for (const row of rows) row.account_id = String(params[0]);
        return { rows: [], rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return sql;
}

interface Setup {
  /** Roster records in the base config (a shard the runtime does not write). */
  shardUsers?: Array<Record<string, unknown>>;
  /** Roster records in the runtime overlay (written by the runtime). */
  overlayUsers?: Array<Record<string, unknown>>;
  provider?: "builtin" | "oidc";
  registry?: Array<Record<string, unknown>>;
  tombstones?: Array<Record<string, unknown>>;
  ledger?: Array<Record<string, unknown>>;
  appBinds?: string[];
}

const ISSUER = "https://idp.example.test/realms/sai";

function entry(username: string, status: "active" | "pending" | "retired", extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: testAccountId(`oidc:${username}`).replace(/^[^-]+/, "oidc"),
    issuer: ISSUER,
    subject: `sub-${username}`,
    username,
    status,
    firstSeenAt: "2026-10-01T00:00:00Z",
    lastSeenAt: "2026-10-01T00:00:00Z",
    ...extra,
  };
}

function setup(options: Setup = {}): Deployment {
  const ws = mkdtempSync(join(tmpdir(), "starlingai-migration-ws-"));
  const um = mkdtempSync(join(tmpdir(), "starlingai-migration-um-"));
  const st = mkdtempSync(join(tmpdir(), "starlingai-migration-st-"));
  dirs.push(ws, um, st);
  writeFileSync(BASE, JSON.stringify({
    gateway: { jwtSecret: SECRET },
    workspacePath: ws,
    auth: { enabled: true, provider: options.provider ?? "builtin", ...(options.shardUsers ? { users: options.shardUsers } : {}) },
  }), "utf8");
  writeFileSync(OVERLAY, JSON.stringify(options.overlayUsers ? { auth: { users: options.overlayUsers } } : {}), "utf8");
  const state = join(ws, ".starlingai");
  mkdirSync(state, { recursive: true });
  // The bootstrap token's subject is on record already: resolving a bst token records it the first
  // time, and the dry-run snapshot must see the migration's writes only.
  writeFileSync(join(state, "accounts.json"), JSON.stringify({ version: 1, accounts: options.registry ?? [], bootstrapSubs: ["admin"] }), "utf8");
  if (options.tombstones) writeFileSync(join(state, "accounts-retired.json"), JSON.stringify({ version: 1, tombstones: options.tombstones }), "utf8");
  if (options.ledger) writeFileSync(join(state, "account-migrations.ndjson"), options.ledger.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
  process.env["SAI_AUDIT_LOG"] = join(FILE_DIR, "audit.jsonl");
  mods.loader.resetConfigForTests();
  mods.registry.resetAccountRegistryForTests();
  mods.tombstones.resetAccountTombstonesForTests();
  mods.aliases.resetDocumentAliasesForTests();
  mods.migration.resetAccountMigrationForTests();
  mods.authModule.resetAuthStateForTests();
  mods.scheduled._setScheduledTasksPathForTests(join(state, "scheduled-tasks.json"));
  const sql = fakeSql();
  const cypher: Deployment["cypher"] = [];
  const backends: AccountMigrationBackends = {
    bases: [{ name: "workspace", path: ws }, { name: "user-memory", path: um }, { name: "state", path: st }],
    sql,
    cypher: async (query, params) => {
      cypher.push({ query, params });
      return 0;
    },
    mirroredSessions: async () => [...redis.store].map(([id, json]) => ({ id, json })),
    mirror: mods.sessions.checkedSessionMirror,
    documents: null,
    appBinds: async () => options.appBinds ?? [],
  };
  const app = mods.maintenance.createMaintenanceApp(async () => backends);
  return { ws, um, st, sql, cypher, app, backends };
}

function bucket(base: string, segment: string, file = "note.md", text = "kept"): string {
  const dir = join(base, "users", segment);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), text, "utf8");
  return dir;
}

function appendLines(file: string, lines: unknown[]): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, (existsSync(file) ? readFileSync(file, "utf8") : "") + lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
}

function outcome(account: string, task = "a task"): Record<string, unknown> {
  return { ts: "2026-09-01T00:00:00Z", agent: "researcher", task, outcome: "success", iterations: 1, totalTokens: 10, account };
}

/** A session record as it was written before account ids: a name, no kind. */
function legacySession(id: string, userId: string, workspace: string, channel = "webchat", extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    channel,
    userId,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    systemPrompt: "system",
    workspacePath: join(workspace, "users", S(userId)),
    turnCount: 1,
    history: [{ role: "user", content: `hello from ${userId}` }],
    ...extra,
  };
}

/** Puts records into the Redis mirror and hydrates them the way a boot does. */
async function mirrorSessions(records: Array<Record<string, unknown>>, opts: { hidden?: string[] } = {}): Promise<void> {
  for (const record of records) redis.store.set(String(record["id"]), JSON.stringify(record));
  for (const id of opts.hidden ?? []) redis.hidden.add(id);
  await mods.sessions.initSessionRedis();
}

async function token(username: string, claims: Record<string, unknown>): Promise<string> {
  return `Bearer ${await mods.authModule.createToken(username, claims)}`;
}

async function migrate(d: Deployment, body: Record<string, unknown> = {}, authorization?: string): Promise<{ status: number; json: Record<string, any> }> {
  const res = await d.app.request("/api/admin/account-migration", {
    method: "POST",
    headers: { Authorization: authorization ?? await token("admin", bootstrapClaims()), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as Record<string, any> };
}

async function dryRun(d: Deployment, body: Record<string, unknown> = {}) {
  const result = await migrate(d, body);
  expect(result.status, JSON.stringify(result.json)).toBe(200);
  return result.json["plan"];
}

async function apply(d: Deployment, body: Record<string, unknown> = {}) {
  const plan = await dryRun(d, body);
  process.env["SAI_MAINTENANCE"] = "account-migration";
  const result = await migrate(d, { ...body, apply: true, plan: plan.hash });
  expect(result.status, JSON.stringify(result.json)).toBe(200);
  return result.json;
}

function identity(plan: Record<string, any>, username: string): Record<string, any> {
  const found = (plan["identities"] as Array<Record<string, any>>).find((candidate) => candidate["username"] === username);
  expect(found, `${username} in ${JSON.stringify(plan["identities"].map((i: Record<string, unknown>) => i["username"] ?? i["segment"]))}`).toBeDefined();
  return found!;
}

/** Every file under the directories, with its content hash, plus the Redis mirror. */
function snapshot(roots: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (root: string, dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(root, path);
      else out[`${root}::${relative(root, path)}`] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  for (const root of roots) if (existsSync(root)) walk(root, root);
  for (const [id, json] of redis.store) out[`redis::${id}`] = json;
  return out;
}

function rosterOf(): Array<Record<string, unknown>> {
  return mods.loader.getConfig().auth.users as unknown as Array<Record<string, unknown>>;
}

const root = testAccount("root", "admin");

// ── The tests ───────────────────────────────────────────────────────────────

describe("the dry run", () => {
  it("writes nothing: the directories, the ledgers, the overlay, the registry, the session store and the mirror stay as they were", async () => {
    const d = setup({
      overlayUsers: [root.record, { username: "alice", passwordHash: DUMMY_PASSWORD_HASH, role: "operator" }],
      registry: [entry("dave", "pending", { legacy: { segment: S("dave") } })],
      tombstones: [{ username: "bob", kind: "builtin", retiredAt: "2026-10-01T00:00:00Z", by: "root" }],
    });
    bucket(d.ws, S("alice"));
    bucket(d.um, S("alice"));
    bucket(d.ws, S("bob"));
    bucket(d.ws, S("admin"));
    bucket(d.ws, S("zed"));
    appendLines(join(d.ws, ".starlingai", "agent_outcomes.ndjson"), [outcome(S("alice"))]);
    await mirrorSessions([legacySession("s-alice", "alice", d.ws)]);
    await mods.sessions.flushSessionStore();
    d.sql.jobs.push({ user_id: "alice", account_id: null });

    const before = snapshot([d.ws, d.um, d.st, FILE_DIR]);
    const plan = await dryRun(d, { adopt: ["alice"], adoptLegacyRecords: true });
    expect(plan.actionable).toBeGreaterThan(0);
    expect(identity(plan, "alice")).toMatchObject({ kind: "builtin", data: "adopt", account: "fresh", assignId: true });
    const after = snapshot([d.ws, d.um, d.st, FILE_DIR]);
    expect(after).toEqual(before);
    // Only reads reached Postgres and nothing reached MemGraph.
    expect(d.sql.calls.every((call) => call.text.startsWith("SELECT"))).toBe(true);
    expect(d.cypher).toEqual([]);
  });
});

describe("classification", () => {
  it("leaves the bootstrap token's bucket in place, and never lets an account of that name adopt it", async () => {
    const idpAdmin = entry("admin", "active");
    const d = setup({ provider: "oidc", overlayUsers: [root.record], registry: [idpAdmin] });
    bucket(d.ws, S("admin"));
    let plan = await dryRun(d, { adopt: [`admin=${idpAdmin["id"]}`] });
    const admin = identity(plan, "admin");
    expect(admin.data).toBe("hold");
    expect(plan.moves).toEqual([]);
    expect(plan.conflicts.join("\n")).toContain("bootstrap token's name");

    // Without an account of the name: the bootstrap principal's own, in place.
    const e = setup({ overlayUsers: [root.record] });
    bucket(e.ws, S("admin"));
    plan = await dryRun(e);
    expect(identity(plan, "admin")).toMatchObject({ kind: "bootstrap", data: "in-place", graph: "segment" });
    process.env["SAI_MAINTENANCE"] = "account-migration";
    const applied = await apply(e);
    expect(applied.applied.ok).toBe(true);
    expect(existsSync(join(e.ws, "users", S("admin"), "note.md"))).toBe(true);
    expect(e.cypher.map((call) => call.params)).toEqual([{ username: "admin", segment: S("admin") }]);
  });

  it("holds the data of an identity-provider user who has not signed in since account ids", async () => {
    const d = setup({ provider: "oidc", overlayUsers: [root.record] });
    bucket(d.ws, S("frank"));
    d.sql.signIns.push({ user_id: "frank", via: "oidc" });
    const plan = await dryRun(d, { archiveUnmapped: true });
    expect(identity(plan, "frank")).toMatchObject({ kind: "oidc-unseen", data: "hold" });
    expect(identity(plan, "frank").notes.join(" ")).toContain("sign in once");
    expect(plan.moves).toEqual([]);
  });

  it("leaves an extension provider's user where it is: its account id is its segment", async () => {
    const d = setup({ overlayUsers: [root.record] });
    mods.extension._recordLoadedExtension(
      { name: "store", version: "1", toolNames: [], auditEvents: [], roles: [], loadedAt: "", source: "test" },
      { name: "store", version: "1", authProvider: { verifyCredentials: async () => null, getUserById: (id: string) => (id === "u-17" ? { id, username: "carol", role: "operator" } : null) } },
    );
    bucket(d.ws, S("u-17"));
    await mirrorSessions([legacySession("s-u17", "u-17", d.ws)]);
    process.env["SAI_MAINTENANCE"] = "account-migration";
    const dry = await mods.migration.runAccountMigration(mods.migration.parseAccountMigrationRequest({ archiveUnmapped: true }) as never, d.backends, "test");
    expect(dry.status).toBe(200);
    const plan = (dry as { plan: Record<string, any> }).plan;
    expect(identity(plan, "u-17")).toMatchObject({ kind: "extension", data: "in-place" });
    const result = await mods.migration.runAccountMigration(mods.migration.parseAccountMigrationRequest({ archiveUnmapped: true, apply: true, plan: plan.hash }) as never, d.backends, "test");
    expect(result.status).toBe(200);
    expect(existsSync(join(d.ws, "users", S("u-17"), "note.md"))).toBe(true);
  });

  it("archives a deleted builtin account's directories, reversibly, and disables its schedules", async () => {
    const d = setup({
      overlayUsers: [root.record],
      tombstones: [{ username: "bob", kind: "builtin", retiredAt: "2026-10-01T00:00:00Z", by: "root" }],
    });
    bucket(d.ws, S("bob"));
    bucket(d.st, S("bob"), "model.json", "{}");
    mods.scheduled.saveScheduledTask({ id: "t-bob", cron: "0 * * * *", label: "bob's", task: "x", userId: "bob", createdAt: "2026-09-01T00:00:00Z" });
    const plan = await dryRun(d);
    expect(identity(plan, "bob")).toMatchObject({ kind: "deleted-builtin", data: "archive", disableSchedules: true });
    expect(plan.moves).toEqual([
      { identity: S("bob"), base: "state", from: S("bob"), to: `.retired/${S("bob")}-*` },
      { identity: S("bob"), base: "workspace", from: S("bob"), to: `.retired/${S("bob")}-*` },
    ]);
    const applied = await apply(d);
    expect(applied.applied.ok).toBe(true);
    expect(existsSync(join(d.ws, "users", S("bob")))).toBe(false);
    const archived = readdirSync(join(d.ws, "users", ".retired"));
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatch(new RegExp(`^${S("bob")}-\\d{8}T\\d{6}Z$`));
    expect(readFileSync(join(d.ws, "users", ".retired", archived[0]!, "note.md"), "utf8")).toBe("kept");
    expect(mods.scheduled.listScheduledTaskRecords().find((task) => task.id === "t-bob")?.disabled?.reason).toBe("account deleted");

    // --hold keeps one in place.
    const e = setup({ overlayUsers: [root.record], tombstones: [{ username: "bob", kind: "builtin", retiredAt: "2026-10-01T00:00:00Z", by: "root" }] });
    bucket(e.ws, S("bob"));
    expect(identity(await dryRun(e, { hold: ["bob"] }), "bob").data).toBe("hold");
  });

  it("counts a workflow session alice started as alice's, not as a principal's", async () => {
    const d = setup({ overlayUsers: [root.record] });
    bucket(d.ws, S("alice"));
    d.sql.signIns.push({ user_id: "alice" });
    await mirrorSessions([legacySession("s-wf", "alice", d.ws, "workflow")]);
    const plan = await dryRun(d);
    // A deleted builtin account (a sign-in on record, no record now), whose only session is a
    // workflow run: still the account's, so it is archived, not left to a principal of the name.
    expect(identity(plan, "alice")).toMatchObject({ kind: "deleted-builtin", data: "archive" });
    // A sender that only ever wrote through a channel is a principal.
    await mirrorSessions([legacySession("s-tg", "12345", d.ws, "telegram")]);
    bucket(d.ws, S("12345"));
    expect(identity(await dryRun(d), "12345")).toMatchObject({ kind: "channel-or-peer", data: "in-place" });
  });
});

describe("adoption is explicit", () => {
  it("without --adopt nothing moves: the record gets its id and its data stays held", async () => {
    const d = setup({ overlayUsers: [root.record, { username: "alice", passwordHash: DUMMY_PASSWORD_HASH, role: "operator" }] });
    bucket(d.ws, S("alice"));
    appendLines(join(d.ws, ".starlingai", "agent_outcomes.ndjson"), [outcome(S("alice"))]);
    await mirrorSessions([legacySession("s-alice", "alice", d.ws)]);
    const plan = await dryRun(d);
    expect(identity(plan, "alice")).toMatchObject({ data: "hold", assignId: true, account: "fresh" });
    const result = await apply(d);
    expect(result.applied.ok).toBe(true);
    const aliceId = String(rosterOf().find((user) => user["username"] === "alice")!["id"]);
    expect(aliceId).toMatch(mods.accounts.ACCOUNT_ID_RE);
    expect(existsSync(join(d.ws, "users", S("alice"), "note.md"))).toBe(true);
    expect(existsSync(join(d.ws, "users", aliceId))).toBe(false);
    expect(readFileSync(join(d.ws, ".starlingai", "agent_outcomes.ndjson"), "utf8")).toContain(S("alice"));
    expect(mods.sessions.getSessionRecord("s-alice")?.isLegacy()).toBe(true);
    const ledger = mods.accounts.readAccountLedger(join(d.ws, ".starlingai", "account-migrations.ndjson"));
    expect(ledger.some((line) => line.event === "assigned" && line.username === "alice" && line.id === aliceId)).toBe(true);
    expect(ledger.some((line) => line.event === "adopted")).toBe(false);
  });

  it("after a recorded adoption of a name, an id-less record of that name gets a fresh id and is not offered the name's data", async () => {
    const earlier = "alice-0123456789abcdef";
    const d = setup({
      overlayUsers: [root.record, { username: "alice", passwordHash: DUMMY_PASSWORD_HASH, role: "operator" }],
      ledger: [{ event: "adopted", id: earlier, username: "alice", segment: S("alice"), at: "2026-10-02T00:00:00Z" }],
    });
    bucket(d.ws, S("alice"));
    const plan = await dryRun(d, { adoptLegacyRecords: true, adopt: ["alice"] });
    const alice = identity(plan, "alice");
    expect(alice).toMatchObject({ data: "hold", assignId: true });
    expect(alice.notes.join(" ")).toContain(`adopted by ${earlier}`);
    const result = await apply(d, { adoptLegacyRecords: true, adopt: ["alice"] });
    expect(result.applied.ok).toBe(true);
    const id = String(rosterOf().find((user) => user["username"] === "alice")!["id"]);
    expect(id).not.toBe(earlier);
    expect(existsSync(join(d.ws, "users", S("alice"), "note.md"))).toBe(true);
    expect(existsSync(join(d.ws, "users", id))).toBe(false);
  });
});

describe("the apply", () => {
  async function richDeployment() {
    const carol = testAccount("carol");
    const d = setup({ overlayUsers: [root.record, { username: "alice", passwordHash: DUMMY_PASSWORD_HASH, role: "operator" }, carol.record] });
    bucket(d.ws, S("alice"));
    bucket(d.um, S("alice"), "facts.json", "[]");
    bucket(d.st, S("alice"), "user-model.json", "{}");
    appendLines(join(d.ws, ".starlingai", "agent_outcomes.ndjson"), [outcome(S("alice")), outcome(carol.id)]);
    writeFileSync(join(d.ws, ".starlingai", "agent_outcomes.ndjson"), `${readFileSync(join(d.ws, ".starlingai", "agent_outcomes.ndjson"), "utf8")}{"ts":"torn
`, "utf8");
    appendLines(join(d.ws, ".starlingai", "flow_memory.ndjson"), [{ id: "f1", ts: "2026-09-01T00:00:00Z", scope: "prompt", request: "r", summary: "s", actions: [], outcome: "success", tags: [], account: S("alice") }]);
    writeFileSync(join(d.ws, ".starlingai", "config_assistant_proposals.json"), JSON.stringify([{ id: "p1", ts: "2026-09-01T00:00:00Z", account: S("alice") }], null, 2) + "\n", "utf8");
    // One session the boot hydrated, one only the mirror holds (past the hydration cap).
    await mirrorSessions([legacySession("s-alice", "alice", d.ws), legacySession("s-alice-old", "alice", d.ws)], { hidden: ["s-alice-old"] });
    d.sql.jobs.push({ user_id: "alice", account_id: null }, { user_id: "alice", account_id: null }, { user_id: "bob", account_id: null });
    d.sql.missions.push({ user_id: "alice", account_id: null });
    mods.scheduled.saveScheduledTask({ id: "t-alice", cron: "0 * * * *", label: "alice's", task: "x", userId: "alice", createdAt: "2026-09-01T00:00:00Z" });
    mkdirSync(join(d.ws, "uploads"), { recursive: true });
    writeFileSync(join(d.ws, "uploads", ".knowledge-bases.json"), JSON.stringify({
      version: 1,
      kbs: [{ id: "kb-alice", name: "alice kb", seedUrls: [], maxPages: 1, maxDepth: 1, sameOriginOnly: true, respectRobots: true, ambientRetrieval: false, scope: "user", ownerId: "alice", createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", status: "ready", pages: {} }],
    }), "utf8");
    writeFileSync(join(d.ws, "uploads", ".registry.json"), JSON.stringify({ entries: [{ documentId: "d1", scope: "user", source: "user:alice", filename: "a.pdf", ingestedAt: "2026-09-01T00:00:00Z" }] }), "utf8");
    return { d, carol };
  }

  it("moves the directories, restamps, rewrites the sessions (awaited and read back), and issues the row and graph updates; a second apply is a no-op", async () => {
    const { d, carol } = await richDeployment();
    const result = await apply(d, { adopt: ["alice"] });
    expect(result.applied.ok).toBe(true);
    const aliceId = String(rosterOf().find((user) => user["username"] === "alice")!["id"]);
    expect(aliceId).toMatch(mods.accounts.ACCOUNT_ID_RE);

    // Directories, in all three bases.
    for (const [base, file] of [[d.ws, "note.md"], [d.um, "facts.json"], [d.st, "user-model.json"]] as const) {
      expect(existsSync(join(base, "users", S("alice")))).toBe(false);
      expect(existsSync(join(base, "users", aliceId, file))).toBe(true);
    }
    // Stamps: alice's moved, carol's and the torn line untouched.
    const outcomes = readFileSync(join(d.ws, ".starlingai", "agent_outcomes.ndjson"), "utf8");
    expect(outcomes).not.toContain(S("alice"));
    expect(outcomes).toContain(aliceId);
    expect(outcomes).toContain(carol.id);
    expect(outcomes).toContain(`{"ts":"torn`);
    expect(readFileSync(join(d.ws, ".starlingai", "flow_memory.ndjson"), "utf8")).toContain(aliceId);
    expect(readFileSync(join(d.ws, ".starlingai", "config_assistant_proposals.json"), "utf8")).toContain(aliceId);
    // Sessions: the hydrated one here and in the mirror, the mirror-only one in the mirror.
    const live = mods.sessions.getSessionRecord("s-alice")!;
    expect(live.account).toBe(aliceId);
    expect(live.getWorkspacePath()).toBe(join(d.ws, "users", aliceId));
    expect(JSON.parse(redis.store.get("s-alice")!)).toMatchObject({ account: aliceId, workspacePath: join(d.ws, "users", aliceId) });
    expect(JSON.parse(redis.store.get("s-alice-old")!)).toMatchObject({ account: aliceId, workspacePath: join(d.ws, "users", aliceId), updatedAt: "2026-09-02T00:00:00.000Z" });
    expect(JSON.parse(readFileSync(SESSION_STORE, "utf8")).sessions.find((record: { id: string }) => record.id === "s-alice").account).toBe(aliceId);
    // Rows and graph.
    expect(d.sql.calls.map((call) => [call.text, call.params]).filter(([text]) => String(text).startsWith("UPDATE"))).toEqual([
      ["UPDATE scene_jobs SET account_id = $1 WHERE user_id = $2 AND account_id IS NULL AND (payload->>'principal') IS NULL", [aliceId, "alice"]],
      ["UPDATE missions SET account_id = $1 WHERE user_id = $2 AND account_id IS NULL", [aliceId, "alice"]],
    ]);
    expect(d.sql.jobs.find((row) => row.user_id === "bob")!.account_id).toBeNull();
    expect(d.cypher.find((call) => call.params["tenant"] === aliceId)?.params).toEqual({ username: "alice", segment: S("alice"), tenant: aliceId });
    // Schedules and knowledge bases.
    expect(mods.scheduled.listScheduledTaskRecords().find((task) => task.id === "t-alice")).toMatchObject({ userId: "alice", account: aliceId });
    expect(JSON.parse(readFileSync(join(d.ws, "uploads", ".knowledge-bases.json"), "utf8")).kbs[0]).toMatchObject({ ownerId: "alice", ownerAccount: aliceId });
    // The ledger and the audit.
    const ledger = mods.accounts.readAccountLedger(join(d.ws, ".starlingai", "account-migrations.ndjson"));
    expect(ledger.filter((line) => line.event === "moved")).toHaveLength(3);
    expect(ledger.some((line) => line.event === "adopted" && line.username === "alice" && line.id === aliceId)).toBe(true);
    expect(ledger.some((line) => line.event === "applied")).toBe(true);
    await mods.audit.flushAuditLog();
    expect(readFileSync(join(FILE_DIR, "audit.jsonl"), "utf8")).toContain("account_migration_applied");

    // A second dry run has nothing to migrate, and its apply changes nothing.
    delete process.env["SAI_MAINTENANCE"];
    const again = await dryRun(d, { adopt: ["alice"] });
    expect(again.nothingToMigrate).toBe(true);
    expect(again.flagNotes.join(" ")).toContain(`adopted by ${aliceId}`);
    const before = snapshot([d.ws, d.um, d.st, FILE_DIR]);
    process.env["SAI_MAINTENANCE"] = "account-migration";
    const second = await migrate(d, { adopt: ["alice"], apply: true, plan: again.hash });
    expect(second.status).toBe(200);
    expect(second.json.applied.results).toEqual([]);
    const after = snapshot([d.ws, d.um, d.st, FILE_DIR]);
    delete after[`${FILE_DIR}::audit.jsonl`];
    delete before[`${FILE_DIR}::audit.jsonl`];
    expect(after).toEqual(before);
  });

  it("lets the adopting account read the old document corpus, and nobody else", async () => {
    const { d, carol } = await richDeployment();
    const result = await apply(d, { adopt: ["alice"] });
    expect(result.applied.ok).toBe(true);
    const aliceId = String(rosterOf().find((user) => user["username"] === "alice")!["id"]);
    expect(mods.rag.callerUserSources({ userId: "alice", identity: { userId: "alice", account: aliceId } })).toEqual([`user:${aliceId}`, "user:alice"]);
    expect(mods.rag.callerUserSources({ userId: "carol", identity: { userId: "carol", account: carol.id } })).toEqual([`user:${carol.id}`]);
    // An account created again under the name later gets a new id, and no alias.
    const recreated = "alice-fedcba9876543210";
    expect(mods.rag.callerUserSources({ userId: "alice", identity: { userId: "alice", account: recreated } })).toEqual([`user:${recreated}`]);
    // The corpus is not offered again.
    expect((await dryRun(d)).identities.some((entry: Record<string, unknown>) => entry["username"] === "alice")).toBe(false);
  });

  it("keeps its plan hash when a trajectory line or a ledger entry is written between dry run and apply, and refuses when a decision changed", async () => {
    const d = setup({ overlayUsers: [root.record, { username: "alice", passwordHash: DUMMY_PASSWORD_HASH, role: "operator" }] });
    bucket(d.ws, S("alice"), "trajectory_cache.ndjson", "{}\n");
    const plan = await dryRun(d, { adopt: ["alice"] });
    writeFileSync(join(d.ws, "users", S("alice"), "trajectory_cache.ndjson"), "{}\n{\"more\":1}\n", "utf8");
    appendLines(join(d.ws, ".starlingai", "agent_outcomes.ndjson"), [outcome(S("alice"))]);
    expect((await dryRun(d, { adopt: ["alice"] })).hash).toBe(plan.hash);

    // A new identity is a new decision.
    bucket(d.ws, S("newcomer"));
    process.env["SAI_MAINTENANCE"] = "account-migration";
    const stale = await migrate(d, { adopt: ["alice"], apply: true, plan: plan.hash });
    expect(stale.status).toBe(409);
    expect(stale.json.error).toContain("State changed");
    expect(existsSync(join(d.ws, "users", S("alice")))).toBe(true);
    // Other flags are other decisions too.
    expect((await dryRun(d, { adopt: ["alice"], archiveUnmapped: true })).hash).not.toBe((await dryRun(d, { adopt: ["alice"] })).hash);
  });

  it("refuses an apply outside a maintenance boot, and any caller without a bootstrap token", async () => {
    const d = setup({ overlayUsers: [root.record, { username: "alice", passwordHash: DUMMY_PASSWORD_HASH, role: "operator" }] });
    bucket(d.ws, S("alice"));
    const plan = await dryRun(d, { adopt: ["alice"] });
    const outside = await migrate(d, { adopt: ["alice"], apply: true, plan: plan.hash });
    expect(outside.status).toBe(409);
    expect(outside.json.error).toContain("SAI_MAINTENANCE=account-migration");
    expect(existsSync(join(d.ws, "users", S("alice")))).toBe(true);

    process.env["SAI_MAINTENANCE"] = "account-migration";
    // An admin account's token: an identity provider maps that role, so it is not enough.
    const asAdmin = await migrate(d, { adopt: ["alice"], apply: true, plan: plan.hash }, await token("root", root.claims));
    expect(asAdmin.status).toBe(403);
    // A bootstrap token below admin is stopped by the route policy.
    expect((await migrate(d, {}, await token("admin", bootstrapClaims("operator")))).status).toBe(403);
    expect((await migrate(d, {}, "Bearer not-a-token")).status).toBe(401);
    expect(existsSync(join(d.ws, "users", S("alice")))).toBe(true);
  });

  it("fails the session step when the mirror reads back a different record, and the account stays pending until a re-run completes", async () => {
    const dave = entry("dave", "pending", { legacy: { segment: S("dave") } });
    const d = setup({ provider: "oidc", overlayUsers: [root.record], registry: [dave] });
    bucket(d.ws, S("dave"));
    await mirrorSessions([legacySession("s-dave", "dave", d.ws)]);
    redis.tamper = true;
    const failed = await apply(d, { adopt: [`dave=${dave["id"]}`] });
    expect(failed.applied.ok).toBe(false);
    const steps = failed.applied.results[0].steps;
    expect(steps.directories).toBe("done");
    expect(steps.sessions).toMatch(/^failed: .*different record/);
    expect(steps.account).toBe("skipped");
    mods.registry.resetAccountRegistryForTests();
    expect(mods.registry.accountRegistryEntryById(String(dave["id"]))?.status).toBe("pending");
    expect(mods.sessions.getSessionRecord("s-dave")?.isLegacy()).toBe(true);

    // A re-run picks up where it stopped.
    redis.tamper = false;
    delete process.env["SAI_MAINTENANCE"];
    const done = await apply(d, { adopt: [`dave=${dave["id"]}`] });
    expect(done.applied.ok).toBe(true);
    expect(done.applied.results[0].steps).toMatchObject({ directories: "nothing", sessions: "done", account: "done" });
    mods.registry.resetAccountRegistryForTests();
    expect(mods.registry.accountRegistryEntryById(String(dave["id"]))).toMatchObject({ status: "active", legacy: { decision: "adopted" } });
  });

  it("continues a stopped adoption into the id it reserved, so nothing it moved is left under an id the record never gets", async () => {
    const d = setup({ overlayUsers: [root.record, { username: "alice", passwordHash: DUMMY_PASSWORD_HASH, role: "operator" }] });
    bucket(d.ws, S("alice"));
    bucket(d.um, S("alice"));
    await mirrorSessions([legacySession("s-alice", "alice", d.ws)]);
    redis.tamper = true;
    const failed = await apply(d, { adopt: ["alice"] });
    expect(failed.applied.ok).toBe(false);
    const reserved = String(failed.applied.results[0].account);
    expect(reserved).toMatch(mods.accounts.ACCOUNT_ID_RE);
    expect(existsSync(join(d.ws, "users", reserved, "note.md"))).toBe(true);
    expect(rosterOf().find((user) => user["username"] === "alice")!["id"]).toBeUndefined();

    // The moved directories are the reserved account's, never a bucket to archive.
    redis.tamper = false;
    delete process.env["SAI_MAINTENANCE"];
    const plan = await dryRun(d, { adopt: ["alice"], archiveUnmapped: true });
    expect(identity(plan, "alice").account).toBe(reserved);
    expect(plan.identities.some((entry: Record<string, unknown>) => entry["segment"] === reserved)).toBe(false);
    const done = await apply(d, { adopt: ["alice"], archiveUnmapped: true });
    expect(done.applied.ok).toBe(true);
    expect(rosterOf().find((user) => user["username"] === "alice")!["id"]).toBe(reserved);
    expect(existsSync(join(d.ws, "users", reserved, "note.md"))).toBe(true);
    expect(mods.sessions.getSessionRecord("s-alice")?.account).toBe(reserved);
  });

  it("renames an identity provider's issuer in the registry", async () => {
    const d = setup({ provider: "oidc", overlayUsers: [root.record], registry: [entry("erin", "active"), entry("fay", "active", { issuer: "https://other.example" })] });
    const plan = await dryRun(d, { oidcIssuerAlias: { from: `${ISSUER}/`, to: "https://idp.example.test/realms/new" } });
    expect(plan.issuerAlias).toEqual({ from: ISSUER, to: "https://idp.example.test/realms/new", entries: 1 });
    const result = await apply(d, { oidcIssuerAlias: { from: `${ISSUER}/`, to: "https://idp.example.test/realms/new" } });
    expect(result.applied.ok).toBe(true);
    mods.registry.resetAccountRegistryForTests();
    expect(mods.registry.accountRegistryEntries().map((account) => account.issuer)).toEqual(["https://idp.example.test/realms/new", "https://other.example"]);
  });

  it("refuses only the account with a conflict", async () => {
    const carol = testAccount("carol");
    const d = setup({
      overlayUsers: [root.record, { username: "alice", passwordHash: DUMMY_PASSWORD_HASH, role: "operator" }, carol.record],
      ledger: [{ event: "created", id: carol.id, username: "carol", at: "2026-10-03T00:00:00Z" }],
    });
    bucket(d.ws, S("alice"));
    bucket(d.ws, S("carol"));
    // carol signed in after the upgrade and has a directory of her own: nothing is merged into it.
    bucket(d.ws, carol.id, "mine.md");
    const plan = await dryRun(d, { adopt: ["alice", `carol=${carol.id}`] });
    expect(identity(plan, "carol").refused).toContain("exists already");
    expect(identity(plan, "alice").data).toBe("adopt");
    const result = await apply(d, { adopt: ["alice", `carol=${carol.id}`] });
    expect(result.applied.ok).toBe(true);
    expect(existsSync(join(d.ws, "users", S("carol"), "note.md"))).toBe(true);
    expect(readdirSync(join(d.ws, "users", carol.id))).toEqual(["mine.md"]);
    const aliceId = String(rosterOf().find((user) => user["username"] === "alice")!["id"]);
    expect(existsSync(join(d.ws, "users", aliceId, "note.md"))).toBe(true);
  });

  it("refuses to move a directory a running served app binds", async () => {
    const d = setup({ overlayUsers: [root.record, { username: "alice", passwordHash: DUMMY_PASSWORD_HASH, role: "operator" }], appBinds: [] });
    bucket(d.ws, S("alice"));
    d.backends.appBinds = async () => [`/host/workspace/users/${S("alice")}/site`];
    const plan = await dryRun(d, { adopt: ["alice"] });
    expect(identity(plan, "alice").refused).toContain("served app");
    expect(plan.moves).toEqual([]);
  });

  it("prints the id to paste for a roster in a config shard, and changes no data for that account", async () => {
    const d = setup({ shardUsers: [root.record, { username: "gina", passwordHash: DUMMY_PASSWORD_HASH, role: "operator" }] });
    bucket(d.ws, S("gina"));
    const plan = await dryRun(d, { adopt: ["gina"] });
    const gina = identity(plan, "gina");
    expect(gina).toMatchObject({ account: "manual", data: "hold", assignId: false });
    expect(gina.idLine).toMatch(/^"id": "gina-[0-9a-f]{16}"$/);
    expect(gina.notes.join(" ")).toContain(gina.idLine);
    // The same id on the next dry run, so what was pasted matches.
    expect(identity(await dryRun(d, { adopt: ["gina"] }), "gina").idLine).toBe(gina.idLine);
    const before = readFileSync(BASE, "utf8");
    await apply(d, { adopt: ["gina"] });
    expect(readFileSync(BASE, "utf8")).toBe(before);
    expect(readFileSync(OVERLAY, "utf8")).toBe("{}");
    expect(existsSync(join(d.ws, "users", S("gina"), "note.md"))).toBe(true);
  });
});

describe("reset and restore", () => {
  it("--reset archives every account-like bucket and leaves the principals'", async () => {
    const d = setup({
      overlayUsers: [root.record, { username: "alice", passwordHash: DUMMY_PASSWORD_HASH, role: "operator" }],
      tombstones: [{ username: "bob", kind: "builtin", retiredAt: "2026-10-01T00:00:00Z", by: "root" }],
    });
    bucket(d.ws, S("alice"));
    bucket(d.ws, S("bob"));
    bucket(d.ws, S("admin"));
    bucket(d.ws, S("12345"));
    await mirrorSessions([legacySession("s-tg", "12345", d.ws, "telegram")]);
    appendLines(join(d.ws, ".starlingai", "agent_outcomes.ndjson"), [outcome(S("alice")), outcome(S("admin"))]);
    const result = await apply(d, { reset: true });
    expect(result.applied.ok).toBe(true);
    const users = readdirSync(join(d.ws, "users"));
    expect(users).toContain(S("admin"));
    expect(users).toContain(S("12345"));
    expect(users).not.toContain(S("alice"));
    expect(users).not.toContain(S("bob"));
    expect(readdirSync(join(d.ws, "users", ".retired")).sort().map((name) => name.replace(/-\d{8}T\d{6}Z$/, ""))).toEqual([S("alice"), S("bob")].sort());
    const outcomes = readFileSync(join(d.ws, ".starlingai", "agent_outcomes.ndjson"), "utf8");
    expect(outcomes).toContain(`retired:${S("alice")}`);
    expect(outcomes).toContain(`"account":"${S("admin")}"`);
    expect(String(rosterOf().find((user) => user["username"] === "alice")!["id"])).toMatch(mods.accounts.ACCOUNT_ID_RE);
    expect(d.cypher.some((call) => call.params["tenant"] === `retired:${S("alice")}`)).toBe(true);
    // The reset is not repeated.
    delete process.env["SAI_MAINTENANCE"];
    expect((await dryRun(d, { reset: true })).nothingToMigrate).toBe(true);
  });

  it("--adopt-retired restores an archive into a living account", async () => {
    const carol = testAccount("carol");
    const d = setup({ overlayUsers: [root.record, carol.record] });
    const archive = `${S("carol")}-20261001T000000Z`;
    mkdirSync(join(d.ws, "users", ".retired", archive), { recursive: true });
    writeFileSync(join(d.ws, "users", ".retired", archive, "old.md"), "restored", "utf8");
    const refused = await dryRun(d, { adoptRetired: [{ archive, id: "nobody-0123456789abcdef" }] });
    expect(refused.restores[0].refused).toContain("no living account");
    const result = await apply(d, { adoptRetired: [{ archive, id: carol.id }] });
    expect(result.applied.ok).toBe(true);
    expect(readFileSync(join(d.ws, "users", carol.id, "old.md"), "utf8")).toBe("restored");
    expect(existsSync(join(d.ws, "users", ".retired", archive))).toBe(false);
  });
});

describe("purge", () => {
  it("removes what a deleted account left and keeps the history, and refuses a living account", async () => {
    const hank = "hank-0123456789abcdef";
    const d = setup({
      overlayUsers: [root.record],
      tombstones: [{ id: hank, username: "hank", kind: "builtin", retiredAt: "2026-10-01T00:00:00Z", by: "root" }],
    });
    bucket(d.ws, hank);
    bucket(d.um, hank);
    appendLines(join(d.ws, ".starlingai", "agent_outcomes.ndjson"), [outcome(hank), outcome(root.id)]);
    redis.store.set("s-hank", JSON.stringify({ ...legacySession("s-hank", "hank", d.ws), account: hank }));
    const plan = await dryRun(d, { purgeRetired: hank });
    expect(plan.purge).toMatchObject({ account: hank, username: "hank", removes: { directories: ["workspace", "user-memory"], stamps: 1, sessions: 1 } });
    expect(plan.purge.refused).toBeUndefined();
    const result = await apply(d, { purgeRetired: hank });
    expect(result.applied.ok).toBe(true);
    expect(existsSync(join(d.ws, "users", hank))).toBe(false);
    expect(existsSync(join(d.um, "users", hank))).toBe(false);
    const outcomes = readFileSync(join(d.ws, ".starlingai", "agent_outcomes.ndjson"), "utf8");
    expect(outcomes).not.toContain(hank);
    expect(outcomes).toContain(root.id);
    expect(redis.store.has("s-hank")).toBe(false);
    expect(d.sql.calls.filter((call) => call.text.startsWith("UPDATE")).map((call) => call.params)).toEqual([[hank, `retired:${hank}`], [hank, `retired:${hank}`]]);
    expect(d.cypher.some((call) => call.query.includes("DETACH DELETE") && call.params["account"] === hank)).toBe(true);

    delete process.env["SAI_MAINTENANCE"];
    expect((await dryRun(d, { purgeRetired: root.id })).purge.refused).toContain("living builtin account");
  });
});

describe("the request", () => {
  it("refuses malformed or contradictory flags", async () => {
    const d = setup({ overlayUsers: [root.record] });
    expect((await migrate(d, { adopt: ["alice=not-an-id"] })).status).toBe(400);
    expect((await migrate(d, { reset: true, adopt: ["alice"] })).status).toBe(400);
    expect((await migrate(d, { purgeRetired: root.id, reset: true })).status).toBe(400);
    expect((await migrate(d, { apply: true })).status).toBe(400);
    expect((await migrate(d, { surprise: 1 })).status).toBe(400);
  });
});
