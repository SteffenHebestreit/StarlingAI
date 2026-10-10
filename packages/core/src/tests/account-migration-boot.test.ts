import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { jwtVerify } from "jose";
import { bootstrapClaims, DUMMY_PASSWORD_HASH, testAccount } from "./support/test-account.js";

/**
 * The account migration's boot side (S5): the maintenance boot serves the migration and nothing
 * else, and starts none of the writers of the stores the migration rewrites; a normal boot warns
 * about what waits for the migration; `sai migrate-account-ids` is a thin client of the route.
 */

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const run = promisify(execFile);

// What a full boot would start, recorded instead of started. The maintenance boot must start none.
const started = vi.hoisted(() => [] as string[]);
vi.mock("../runtime/scheduled-task-runner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime/scheduled-task-runner.js")>()),
  rehydrateScheduledTasks: () => { started.push("schedules"); },
}));
vi.mock("../channels/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../channels/runtime.js")>()),
  syncAllChannels: async () => { started.push("channels"); },
}));
vi.mock("../agent/scene-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent/scene-worker.js")>()),
  startSceneJobWorker: async () => { started.push("scene worker"); },
}));
vi.mock("../swarm/bus.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../swarm/bus.js")>()),
  startSwarmBus: async () => { started.push("swarm bus"); },
}));
vi.mock("../agent/warden.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent/warden.js")>()),
  startWarden: () => { started.push("warden"); },
}));
vi.mock("../mcp/registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../mcp/registry.js")>()),
  initMcpServers: async () => { started.push("mcp"); },
}));
vi.mock("../gateway/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/index.js")>()),
  createGateway: () => {
    started.push("gateway");
    return { start: async () => undefined, stop: async () => undefined };
  },
}));
vi.mock("../agent/session.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../agent/session.js")>();
  return { ...original, initSessionRedis: async () => { started.push("session store"); await original.initSessionRedis(); } };
});

// The Redis mirror's records, for a boot to hydrate.
const mirror = vi.hoisted(() => ({ records: [] as string[] }));
vi.mock("../agent/session-redis.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent/session-redis.js")>()),
  loadAllSessionsFromRedis: async () => mirror.records,
}));

// The account migration's warnings, recorded.
const warnings = vi.hoisted(() => [] as Array<{ logger: string; message: unknown }>);
vi.mock("../logger.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../logger.js")>();
  return {
    ...original,
    childLogger: (name: string) => {
      const logger = original.childLogger(name);
      return new Proxy(logger, {
        get(target, property, receiver) {
          if (property === "warn") {
            return (...args: unknown[]) => {
              warnings.push({ logger: name, message: args[args.length - 1] });
              return (target.warn as (...a: unknown[]) => void)(...args);
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });
    },
  };
});

const SECRET = "b".repeat(40);
const FILE_DIR = mkdtempSync(join(tmpdir(), "starlingai-migration-boot-"));
const CONFIG_PATH = join(FILE_DIR, "starlingai.json");
const dirs: string[] = [];

async function freePort(): Promise<number> {
  return new Promise((resolvePort) => {
    const server = createNetServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolvePort(port));
    });
  });
}

let mods: Awaited<ReturnType<typeof loadModules>>;

async function loadModules() {
  writeFileSync(CONFIG_PATH, JSON.stringify({ gateway: { jwtSecret: SECRET } }), "utf8");
  process.env["SAI_CONFIG_PATH"] = CONFIG_PATH;
  process.env["SAI_MUTABLE_CONFIG_PATH"] = CONFIG_PATH;
  process.env["SAI_SESSION_STORE"] = join(FILE_DIR, "sessions.json");
  process.env["SAI_JOB_WAKE_DISABLED"] = "1";
  delete process.env["DATABASE_URL"];
  delete process.env["REDIS_URL"];
  const loader = await import("../config/loader.js");
  const authModule = await import("../gateway/auth.js");
  const registry = await import("../runtime/account-registry.js");
  const tombstones = await import("../runtime/account-tombstones.js");
  const migration = await import("../runtime/account-migration.js");
  const maintenance = await import("../gateway/maintenance-gateway.js");
  const sessions = await import("../agent/session.js");
  const accounts = await import("../runtime/accounts.js");
  const scheduled = await import("../runtime/scheduled-tasks.js");
  return { loader, authModule, registry, tombstones, migration, maintenance, sessions, accounts, scheduled };
}

beforeAll(async () => {
  mods = await loadModules();
}, 60_000);

afterAll(() => {
  for (const key of ["SAI_CONFIG_PATH", "SAI_MUTABLE_CONFIG_PATH", "SAI_SESSION_STORE", "SAI_JOB_WAKE_DISABLED", "SAI_MAINTENANCE"]) delete process.env[key];
  rmSync(FILE_DIR, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env["SAI_MAINTENANCE"];
  started.length = 0;
  warnings.length = 0;
  mirror.records = [];
  mods.sessions.resetSessionsForTests();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const root = testAccount("root", "admin");

function configure(extra: Record<string, unknown> = {}, users: unknown[] = [root.record]): string {
  const workspace = mkdtempSync(join(tmpdir(), "starlingai-migration-boot-ws-"));
  dirs.push(workspace);
  writeFileSync(CONFIG_PATH, JSON.stringify({ gateway: { jwtSecret: SECRET }, workspacePath: workspace, auth: { enabled: true, users }, ...extra }), "utf8");
  mods.loader.resetConfigForTests();
  mods.registry.resetAccountRegistryForTests();
  mods.tombstones.resetAccountTombstonesForTests();
  mods.authModule.resetAuthStateForTests();
  mods.migration.resetAccountMigrationForTests();
  mods.scheduled._setScheduledTasksPathForTests(join(workspace, ".starlingai", "scheduled-tasks.json"));
  return workspace;
}

async function bootstrapToken(role = "admin"): Promise<string> {
  return `Bearer ${await mods.authModule.createToken("admin", bootstrapClaims(role))}`;
}

describe("the maintenance boot", () => {
  it("serves health, the login mode and the migration, and nothing else", async () => {
    const workspace = configure();
    const app = mods.maintenance.createMaintenanceApp(async () => ({
      bases: [{ name: "workspace", path: workspace }],
      sql: null,
      cypher: null,
      mirroredSessions: async () => null,
      mirror: mods.sessions.checkedSessionMirror,
      documents: null,
      appBinds: async () => [],
    }));
    expect(await (await app.request("/healthz")).json()).toEqual({ status: "ok", maintenance: "account-migration" });
    expect(await (await app.request("/api/auth/mode")).json()).toMatchObject({ authEnabled: true, maintenance: "account-migration" });
    for (const path of ["/api/sessions", "/api/auth/users", "/api/auth/login", "/"]) {
      expect((await app.request(path)).status, path).toBe(503);
    }
    const plan = await app.request("/api/admin/account-migration", { method: "POST", headers: { Authorization: await bootstrapToken() }, body: "{}" });
    expect(plan.status).toBe(200);
    expect((await plan.json() as { plan: { hash: string } }).plan.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("main() under SAI_MAINTENANCE loads the stores, serves the migration over HTTP, and starts none of their writers", async () => {
    const port = await freePort();
    configure({ gateway: { jwtSecret: SECRET, port } });
    process.env["SAI_MAINTENANCE"] = "account-migration";
    const index = await import("../index.js");
    try {
      await index.main();
      const base = `http://127.0.0.1:${port}`;
      expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ status: "ok", maintenance: "account-migration" });
      expect((await fetch(`${base}/api/sessions`)).status).toBe(503);
      const plan = await fetch(`${base}/api/admin/account-migration`, {
        method: "POST",
        headers: { Authorization: await bootstrapToken(), "content-type": "application/json" },
        body: JSON.stringify({ adopt: ["nobody"] }),
      });
      expect(plan.status).toBe(200);
      expect((await plan.json() as { plan: { flagNotes: string[] } }).plan.flagNotes.join(" ")).toContain("nobody");
      expect(started).toEqual(["session store"]);
    } finally {
      await index.stopMaintenanceBootForTests();
    }
  }, 120_000);
});

describe("the boot warning", () => {
  it("counts what waits for the migration and warns once; a deployment with nothing waiting gets no warning", async () => {
    const workspace = configure({}, [root.record, { username: "alice", passwordHash: DUMMY_PASSWORD_HASH, role: "operator" }]);
    const S = mods.accounts.principalSegment;
    mkdirSync(join(workspace, ".starlingai"), { recursive: true });
    writeFileSync(join(workspace, ".starlingai", "accounts.json"), JSON.stringify({
      version: 1,
      accounts: [{ id: "oidc-0123456789abcdef", issuer: "https://idp", subject: "s", username: "dave", status: "pending", firstSeenAt: "2026-10-01T00:00:00Z", lastSeenAt: "2026-10-01T00:00:00Z" }],
      bootstrapSubs: ["admin"],
    }), "utf8");
    // A deleted account's storage stays under its id until a purge.
    const hank = "hank-0123456789abcdef";
    writeFileSync(join(workspace, ".starlingai", "accounts-retired.json"), JSON.stringify({
      version: 1,
      tombstones: [{ id: hank, username: "hank", kind: "builtin", retiredAt: "2026-10-01T00:00:00Z", by: "root" }],
    }), "utf8");
    // Counted: alice's old bucket. Not counted: the bootstrap token's, an account's own, a deleted
    // account's own, one an apply decided, a dot-directory.
    for (const name of [S("alice"), S("admin"), root.id, hank, S("held"), ".retired"]) mkdirSync(join(workspace, "users", name), { recursive: true });
    writeFileSync(join(workspace, ".starlingai", "account-migrations.ndjson"), `${JSON.stringify({ event: "applied", at: "x", planHash: "0", mode: "migrate", decisions: [{ segment: S("held") }], results: [] })}\n`, "utf8");
    // A session from before account ids, hydrated as a boot hydrates one.
    mirror.records = [JSON.stringify({ id: "s-legacy", channel: "webchat", userId: "alice", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", systemPrompt: "s", workspacePath: workspace, turnCount: 0, history: [] })];
    await mods.sessions.initSessionRedis();
    // A schedule from before account ids, skipped on every tick. Not counted: a disabled one, and one
    // that names its owner's kind.
    const schedule = { cron: "0 * * * *", label: "nightly", task: "x", createdAt: "2026-09-01T00:00:00Z" };
    mods.scheduled.saveScheduledTask({ ...schedule, id: "t-legacy", userId: "admin" });
    mods.scheduled.saveScheduledTask({ ...schedule, id: "t-disabled", userId: "alice", disabled: { at: "2026-10-01T00:00:00Z", reason: "account deleted" } });
    mods.scheduled.saveScheduledTask({ ...schedule, id: "t-kinded", userId: "admin", principal: "bootstrap" });
    const counts = mods.migration.reportAccountMigrationBacklog([workspace]);
    expect(counts).toEqual({ idless: 1, pending: 1, sessions: 1, schedules: 1, buckets: 1 });
    const warned = warnings.filter((warning) => warning.logger === "runtime:account-migration");
    expect(warned).toHaveLength(1);
    expect(String(warned[0]!.message)).toContain("sai migrate-account-ids");

    warnings.length = 0;
    mods.sessions.resetSessionsForTests();
    const clean = configure();
    mkdirSync(join(clean, "users", root.id), { recursive: true });
    expect(mods.migration.reportAccountMigrationBacklog([clean])).toEqual({ idless: 0, pending: 0, sessions: 0, schedules: 0, buckets: 0 });
    expect(warnings.filter((warning) => warning.logger === "runtime:account-migration")).toEqual([]);
  });
});

describe("sai migrate-account-ids", () => {
  async function gateway(reply: (body: Record<string, unknown>) => { status: number; json: unknown }) {
    const requests: Array<{ authorization?: string; body: Record<string, unknown>; path?: string }> = [];
    const server = createServer((req: IncomingMessage, res) => {
      let text = "";
      req.on("data", (chunk) => { text += chunk; });
      req.on("end", () => {
        const body = JSON.parse(text || "{}") as Record<string, unknown>;
        requests.push({ authorization: req.headers.authorization, body, path: req.url });
        const answer = reply(body);
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(JSON.stringify(answer.json));
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    return { url, requests, close: () => new Promise<void>((done) => server.close(() => done())) };
  }

  const plan = { hash: "0123456789abcdef", mode: "migrate", identities: [{ username: "alice", segment: "alice-x", kind: "builtin", data: "adopt", account: "fresh", graph: "none", assignId: true, activate: false, notes: [], stored: { buckets: ["workspace"] } }], moves: [], restores: [], conflicts: [], flagNotes: [], problems: [], actionable: 1, nothingToMigrate: false };

  async function sai(args: string[], url: string) {
    return run(process.execPath, [join(REPO_ROOT, "scripts", "sai.mjs"), "migrate-account-ids", ...args, "--url", url], {
      env: { ...process.env, SAI_JWT_SECRET: SECRET, NO_COLOR: "1" },
      encoding: "utf8",
    }).then(({ stdout }) => ({ code: 0, stdout }), (err: { code?: number; stdout?: string }) => ({ code: err.code ?? 1, stdout: err.stdout ?? "" }));
  }

  it("sends the flags with a bootstrap token it mints, and prints the plan with how to apply it", async () => {
    const server = await gateway(() => ({ status: 200, json: { plan } }));
    try {
      const json = await sai([
        "--adopt", "alice", "--adopt", "bob=bob-0123456789abcdef", "--hold", "carol", "--adopt-retired", "x-1=carol-0123456789abcdef",
        "--oidc-issuer-alias", "https://old.example/realms/a=https://new.example/realms/a", "--archive-unmapped", "--json",
      ], server.url);
      expect(json.code).toBe(0);
      expect(JSON.parse(json.stdout)).toEqual({ plan });
      expect(server.requests[0]!.path).toBe("/api/admin/account-migration");
      expect(server.requests[0]!.body).toEqual({
        adopt: ["alice", "bob=bob-0123456789abcdef"],
        hold: ["carol"],
        archiveUnmapped: true,
        adoptRetired: [{ archive: "x-1", id: "carol-0123456789abcdef" }],
        oidcIssuerAlias: { from: "https://old.example/realms/a", to: "https://new.example/realms/a" },
      });
      const token = server.requests[0]!.authorization!.replace(/^Bearer /, "");
      const { payload } = await jwtVerify(token, new TextEncoder().encode(SECRET));
      expect(payload).toMatchObject({ sub: "admin", role: "admin", bst: true });

      const human = await sai(["--adopt", "alice"], server.url);
      expect(human.code).toBe(0);
      expect(human.stdout).toContain("0123456789abcdef");
      expect(human.stdout).toContain("SAI_MAINTENANCE=account-migration");
      expect(human.stdout).toContain("--apply --plan 0123456789abcdef");

      const applied = await sai(["--adopt", "alice", "--apply", "--plan", "0123456789abcdef", "--json"], server.url);
      expect(applied.code).toBe(0);
      expect(server.requests[2]!.body).toEqual({ adopt: ["alice"], apply: true, plan: "0123456789abcdef" });
    } finally {
      await server.close();
    }
  }, 60_000);

  it("refuses --apply without the plan hash, and exits non-zero when the gateway refuses", async () => {
    const server = await gateway(() => ({ status: 409, json: { error: "Apply, reset and purge run only in a maintenance boot" } }));
    try {
      const noPlan = await sai(["--apply"], server.url);
      expect(noPlan.code).not.toBe(0);
      expect(server.requests).toHaveLength(0);
      const refused = await sai(["--adopt", "alice", "--apply", "--plan", "0123456789abcdef"], server.url);
      expect(refused.code).not.toBe(0);
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  }, 60_000);
});
