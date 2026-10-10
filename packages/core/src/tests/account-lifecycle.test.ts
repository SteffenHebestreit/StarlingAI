import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../runtime/accounts.js";
import { bootstrapClaims, testAccount } from "./support/test-account.js";

/**
 * What ends with an account (S4).
 *
 * Deleting a builtin account removed its record and closed its sockets, and nothing else: its chats
 * stayed open and a turn it had started ran to the end, its queued and running jobs ran, its
 * schedules kept firing and queued a turn as the account every time, and its name was free at once,
 * for a channel sender (whose bucket is the one the account kept before ids) and for a new
 * identity-provider subject (who would hold every grant written for it). Creating the name again was
 * refused for as long as the old account's archived sessions were kept. Retiring an identity-provider
 * account stopped its tokens and sockets only.
 *
 * These tests drive the real routes. The cron scheduler is recorded, not run.
 */

const cron = vi.hoisted(() => ({ next: 0, removed: [] as string[], ticks: new Map<string, () => unknown>() }));
vi.mock("../runtime/scheduler.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime/scheduler.js")>()),
  createCronJob: (_expression: string, _label: string, _action: string, onTick: () => unknown) => {
    const id = `cron_${++cron.next}`;
    cron.ticks.set(id, onTick);
    return { id };
  },
  removeCronJob: (id: string) => {
    cron.removed.push(id);
    return cron.ticks.delete(id);
  },
}));

const SECRET = "l".repeat(40);
const ISSUER = "https://idp.example.test/realms/sai";
// The config loader fixes its file when it loads, so the modules load once for this file and every
// test writes its configuration to that one file.
const FILE_DIR = mkdtempSync(join(tmpdir(), "starlingai-account-lifecycle-file-"));
const CONFIG_PATH = join(FILE_DIR, "starlingai.json");
const dirs: string[] = [];
let workspace = "";
let mods: Awaited<ReturnType<typeof loadModules>>;

async function loadModules() {
  writeFileSync(CONFIG_PATH, JSON.stringify({ gateway: { jwtSecret: SECRET } }), "utf8");
  process.env["SAI_CONFIG_PATH"] = CONFIG_PATH;
  process.env["SAI_MUTABLE_CONFIG_PATH"] = CONFIG_PATH;
  process.env["SAI_SESSION_STORE"] = join(FILE_DIR, "sessions.json");
  process.env["SAI_JOB_WAKE_DISABLED"] = "1";
  delete process.env["DATABASE_URL"];
  delete process.env["REDIS_URL"];
  const authModule = await import("../gateway/auth.js");
  const loader = await import("../config/loader.js");
  const sessions = await import("../agent/session.js");
  const registry = await import("../runtime/account-registry.js");
  const tombstones = await import("../runtime/account-tombstones.js");
  const { registerUserRoutes } = await import("../gateway/user-routes.js");
  const { registerAccountRoutes } = await import("../gateway/account-routes.js");
  const jobs = await import("../agent/jobs.js");
  const runner = await import("../runtime/scheduled-task-runner.js");
  const scheduled = await import("../runtime/scheduled-tasks.js");
  const warden = await import("../agent/warden.js");
  const connections = await import("../gateway/account-connections.js");
  const channels = await import("../channels/base.js");
  const oidcAccounts = await import("../gateway/oidc-accounts.js");
  const userScope = await import("../runtime/user-scope.js");
  const tools = await import("../tools/registry.js");
  await import("../tools/schedule.js");
  const audit = await import("../audit/logger.js");
  return {
    authModule, loader, sessions, registry, tombstones, registerUserRoutes, registerAccountRoutes, jobs, runner,
    scheduled, warden, connections, channels, oidcAccounts, userScope, tools, audit,
  };
}

// Loading the modules cold can take longer than a hook's default 10 s.
beforeAll(async () => {
  mods = await loadModules();
}, 60_000);

afterAll(() => {
  for (const key of ["SAI_CONFIG_PATH", "SAI_MUTABLE_CONFIG_PATH", "SAI_SESSION_STORE", "SAI_JOB_WAKE_DISABLED"]) delete process.env[key];
  rmSync(FILE_DIR, { recursive: true, force: true });
});

const untrack: Array<() => void> = [];

afterEach(async () => {
  for (const stop of untrack.splice(0)) stop();
  cron.removed.length = 0;
  cron.ticks.clear();
  mods.runner._resetScheduledTaskRuntimeForTests();
  mods.scheduled._setScheduledTasksPathForTests(null);
  await mods.jobs.resetJobsForTests();
  await mods.audit.flushAuditLog();
  mods.sessions.resetSessionsForTests();
  mods.registry.resetAccountRegistryForTests();
  mods.tombstones.resetAccountTombstonesForTests();
  mods.loader.resetConfigForTests();
  mods.authModule.resetAuthStateForTests();
  delete process.env["SAI_AUDIT_LOG"];
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const root = testAccount("root", "admin");
const alice = testAccount("alice");
const bob = testAccount("bob");
const ALICE: Identity = { userId: "alice", account: alice.id };
const BOB: Identity = { userId: "bob", account: bob.id };

function configure(auth: Record<string, unknown>, extra: Record<string, unknown> = {}): void {
  workspace = mkdtempSync(join(tmpdir(), "starlingai-account-lifecycle-"));
  dirs.push(workspace);
  writeFileSync(CONFIG_PATH, JSON.stringify({ gateway: { jwtSecret: SECRET }, workspacePath: workspace, auth, ...extra }), "utf8");
  process.env["SAI_AUDIT_LOG"] = join(workspace, "audit.jsonl");
  mods.loader.resetConfigForTests();
  mods.registry.resetAccountRegistryForTests();
  mods.tombstones.resetAccountTombstonesForTests();
  mods.authModule.resetAuthStateForTests();
  mods.scheduled._setScheduledTasksPathForTests(join(workspace, ".starlingai", "scheduled-tasks.json"));
}

function app(): Hono {
  const hono = new Hono();
  mods.registerUserRoutes(hono);
  mods.registerAccountRoutes(hono);
  return hono;
}

async function as(username: string, claims: Record<string, unknown>): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${await mods.authModule.createToken(username, claims)}`, "content-type": "application/json" };
}

/** What an account has running: two live chats (one in a turn), a running job, a schedule, an open
 *  socket. Its queued job comes from queuedJob, after every account's running job was claimed (a
 *  worker claims the oldest queued job). */
async function busy(who: Identity) {
  const turnChat = mods.sessions.createSession({ channel: "webchat", ...who, workspacePath: workspace });
  const idleChat = mods.sessions.createSession({ channel: "webchat", ...who, workspacePath: workspace });
  const turn = new AbortController();
  mods.warden.registerSessionAbortController(turnChat.id, turn);
  untrack.push(() => mods.warden.deregisterSessionAbortController(turnChat.id, turn));
  const running = await mods.jobs.createJob({ sceneName: `${who.userId}-running`, definitionType: "scene", task: "t", ...who } as never);
  expect((await mods.jobs.claimNextJob("worker-1"))?.id).toBe(running.id);
  const scheduleId = `sched_${who.userId}`;
  mods.runner.addAndActivateScheduledTask({ id: scheduleId, cron: "0 8 * * 1-5", label: `${who.userId}'s brief`, task: "brief me", ...who, createdAt: "2026-10-01T00:00:00Z" });
  const socket = { revoked: [] as string[], revoke(reason: string) { this.revoked.push(reason); stop(); } };
  const stop = mods.connections.trackAccountConnection(who.account!, socket);
  untrack.push(stop);
  return { turnChat, idleChat, turn, running, scheduleId, socket };
}

async function queuedJob(who: Identity) {
  return mods.jobs.createJob({ sceneName: `${who.userId}-queued`, definitionType: "scene", task: "t", ...who } as never);
}

describe("deleting a builtin account", () => {
  it("ends what it has running: its turn, chats, jobs, schedules and sockets; another account's go on", async () => {
    configure({ enabled: true, users: [root.record, alice.record, bob.record] });
    const hers = await busy(ALICE);
    const his = await busy(BOB);
    const herQueued = await queuedJob(ALICE);
    const hisQueued = await queuedJob(BOB);

    const reply = await app().request("/api/auth/users/alice", { method: "DELETE", headers: await as("root", root.claims) });
    expect(reply.status).toBe(200);
    const body = await reply.json() as { ended: Record<string, unknown> };
    expect(body.ended).toMatchObject({ socketsClosed: 1, sessionsArchived: 2, turnsStopped: 1, jobsCancelled: 2, schedulesDisabled: 1, failed: [] });

    // Her turn stopped, and both chats ended as an explicit end.
    expect(hers.turn.signal.aborted).toBe(true);
    for (const chat of [hers.turnChat, hers.idleChat]) {
      expect(mods.sessions.getSession(chat.id)).toBeUndefined();
      expect(mods.sessions.getSessionRecord(chat.id)?.getArchivedReason()).toBe("manual");
    }
    // Her queued job never runs; her running one is being cancelled through its worker.
    expect((await mods.jobs.getJob(herQueued.id))?.status).toBe("cancelled");
    expect((await mods.jobs.getJob(hers.running.id))?.status).toBe("cancelling");
    // Her schedule is kept, disabled, and its cron job is gone.
    const stored = mods.scheduled.listScheduledTaskRecords();
    expect(stored.find((record) => record.id === hers.scheduleId)?.disabled).toEqual({ at: expect.any(String), reason: "account deleted" });
    expect(cron.removed).toHaveLength(1);
    expect(hers.socket.revoked).toEqual(["account deleted"]);

    // Bob's go on.
    expect(his.turn.signal.aborted).toBe(false);
    expect(mods.sessions.getSession(his.turnChat.id)).toBeDefined();
    expect(mods.sessions.getSession(his.idleChat.id)).toBeDefined();
    expect((await mods.jobs.getJob(hisQueued.id))?.status).toBe("queued");
    expect((await mods.jobs.getJob(his.running.id))?.status).toBe("running");
    expect(stored.find((record) => record.id === his.scheduleId)?.disabled).toBeUndefined();
    expect(his.socket.revoked).toEqual([]);
    expect(mods.connections.accountConnectionCount(bob.id)).toBe(1);

    // A schedule disabled stays listed for an admin, marked.
    const listed = await mods.tools.getTool("schedule_list")!.execute({}, {
      sessionId: "chat-1", workspacePath: workspace, userId: "root", identity: { userId: "root", account: root.id }, userRole: "admin",
    });
    const lines = listed.output.split("\n");
    expect(lines.find((line) => line.includes(hers.scheduleId))).toBe(`- **${hers.scheduleId}** "alice's brief" — \`0 8 * * 1-5\` — brief me — disabled (account deleted)`);
    expect(lines.find((line) => line.includes(his.scheduleId))).toBe(`- **${his.scheduleId}** "bob's brief" — \`0 8 * * 1-5\` — brief me`);
  });

  it("records a tombstone that keeps the name from a channel sender and a new identity-provider subject", async () => {
    configure({ enabled: true, users: [root.record, alice.record] });
    expect(mods.channels.channelSenderRefusal("alice")).toBeDefined(); // her record holds it
    expect((await app().request("/api/auth/users/alice", { method: "DELETE", headers: await as("root", root.claims) })).status).toBe(200);

    const file = JSON.parse(readFileSync(join(workspace, ".starlingai", "accounts-retired.json"), "utf8")) as { tombstones: unknown[] };
    expect(file.tombstones).toEqual([{ id: alice.id, username: "alice", kind: "builtin", retiredAt: expect.any(String), by: "root" }]);

    // A Telegram user or a mail From named alice is not served: its bucket is the one alice kept
    // before account ids.
    expect(mods.channels.channelSenderRefusal("alice")).toMatch(/deleted builtin account/);
    expect(mods.channels.channelSenderRefusal("Alice")).toMatch(/deleted builtin account/);
    expect(mods.channels.channelSenderRefusal("carol")).toBeUndefined();
    // Nor is a name with no kind given a bucket.
    expect(() => mods.userScope.segmentFor({ userId: "alice" })).toThrow(mods.userScope.AccountNotThreadedError);
    // A new identity-provider subject does not get the name, or the grants written for it.
    expect(() => mods.oidcAccounts.resolveOidcSignIn({ issuer: ISSUER, subject: "subject-1", username: "alice", role: "operator" }))
      .toThrow(/held by a deleted builtin account/);
    expect(mods.registry.accountRegistryEntries()).toEqual([]);
  });

  it("deletes nothing when the tombstone cannot be recorded", async () => {
    configure({ enabled: true, users: [root.record, alice.record] });
    const chat = mods.sessions.createSession({ channel: "webchat", ...ALICE, workspacePath: workspace });
    // The state directory is a file: nothing can be written under it.
    writeFileSync(join(workspace, ".starlingai"), "not a directory");
    const refused = await app().request("/api/auth/users/alice", { method: "DELETE", headers: await as("root", root.claims) });
    expect(refused.status).toBe(500);
    expect(mods.loader.getConfig().auth.users.map((user) => user.username)).toEqual(["root", "alice"]);
    expect(mods.sessions.getSession(chat.id)).toBeDefined();
  });

  it("holds every name while the tombstones cannot be read, and never writes over them", async () => {
    configure({ enabled: true, users: [root.record, alice.record] });
    mkdirSync(join(workspace, ".starlingai"), { recursive: true });
    const file = join(workspace, ".starlingai", "accounts-retired.json");
    writeFileSync(file, "{ not the tombstones");
    expect(mods.channels.channelSenderRefusal("carol")).toMatch(/tombstones/);
    expect((await app().request("/api/auth/users/alice", { method: "DELETE", headers: await as("root", root.claims) })).status).toBe(500);
    expect(readFileSync(file, "utf8")).toBe("{ not the tombstones");
    expect(mods.loader.getConfig().auth.users.map((user) => user.username)).toEqual(["root", "alice"]);
  });

  it("lists the allowedUsers entries that still name the account", async () => {
    configure({ enabled: true, users: [root.record, alice.record, bob.record] }, {
      sites: {
        "crm.example.test": { username: "svc", password: "pw", allowedUsers: ["Alice", "bob", "principal:alice"] },
        "wiki.example.test": { username: "svc", password: "pw", allowedUsers: [`account:${alice.id}`] },
      },
    });
    const reply = await app().request("/api/auth/users/alice", { method: "DELETE", headers: await as("root", root.claims) });
    expect(reply.status).toBe(200);
    const body = await reply.json() as { aclReferences: unknown };
    expect(body.aclReferences).toEqual([
      { where: "sites.crm.example.test", entry: "Alice" },
      { where: "sites.wiki.example.test", entry: `account:${alice.id}` },
    ]);
    // The config is not edited.
    expect(mods.loader.getConfig().sites["crm.example.test"]?.allowedUsers).toEqual(["Alice", "bob", "principal:alice"]);
    await mods.audit.flushAuditLog();
    const deleted = readFileSync(join(workspace, "audit.jsonl"), "utf8").split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> })
      .find((event) => event.type === "auth_user_deleted");
    expect(deleted?.data["aclReferences"]).toEqual(body.aclReferences);
  });
});

describe("retiring an identity-provider account", () => {
  const oidcAuth = { enabled: true, provider: "oidc", oidc: { issuer: ISSUER, clientId: "sai" }, users: [] };

  it("ends what it has running and records a tombstone that holds nothing once its names are released", async () => {
    configure(oidcAuth, { sites: { "crm.example.test": { username: "svc", password: "pw", allowedUsers: ["carol"] } } });
    const { entry } = mods.oidcAccounts.resolveOidcSignIn({ issuer: ISSUER, subject: "subject-1", username: "carol", role: "operator" });
    const carol: Identity = { userId: "carol", account: entry.id };
    const hers = await busy(carol);
    const herQueued = await queuedJob(carol);

    const reply = await app().request(`/api/admin/accounts/${entry.id}/retire`, { method: "POST", headers: await as("admin", bootstrapClaims()) });
    expect(reply.status).toBe(200);
    const body = await reply.json() as { ended: Record<string, unknown>; aclReferences: unknown };
    expect(body.ended).toMatchObject({ socketsClosed: 1, sessionsArchived: 2, turnsStopped: 1, jobsCancelled: 2, schedulesDisabled: 1, failed: [] });
    expect(body.aclReferences).toEqual([{ where: "sites.crm.example.test", entry: "carol" }]);
    expect(hers.turn.signal.aborted).toBe(true);
    expect(mods.sessions.getSession(hers.idleChat.id)).toBeUndefined();
    expect((await mods.jobs.getJob(herQueued.id))?.status).toBe("cancelled");
    expect(mods.scheduled.listScheduledTaskRecords()[0]?.disabled?.reason).toBe("account retired");
    expect(mods.tombstones.accountTombstones()).toEqual([{ id: entry.id, username: "carol", kind: "oidc", retiredAt: expect.any(String), by: "admin" }]);

    // The registry entry holds the name until an admin releases it; the tombstone never does.
    expect(() => mods.oidcAccounts.resolveOidcSignIn({ issuer: ISSUER, subject: "subject-2", username: "carol", role: "operator" }))
      .toThrow(/held by account/);
    expect((await app().request(`/api/admin/accounts/${entry.id}/release-username`, { method: "POST", headers: await as("admin", bootstrapClaims()) })).status).toBe(200);
    const next = mods.oidcAccounts.resolveOidcSignIn({ issuer: ISSUER, subject: "subject-2", username: "carol", role: "operator" });
    expect(next.entry.id).not.toBe(entry.id);
    expect(next.entry.status).toBe("active");
  });
});

describe("mixed mode: builtin accounts beside the identity provider", () => {
  it("does not rename an identity-provider account to a deleted builtin account's name", async () => {
    configure({ enabled: true, provider: "oidc", oidc: { issuer: ISSUER, clientId: "sai" }, users: [root.record, alice.record] });
    expect((await app().request("/api/auth/users/alice", { method: "DELETE", headers: await as("root", root.claims) })).status).toBe(200);
    const { entry } = mods.oidcAccounts.resolveOidcSignIn({ issuer: ISSUER, subject: "subject-1", username: "carol", role: "operator" });
    // The IdP now claims alice for carol; an admin is asked to approve it.
    mods.oidcAccounts.resolveOidcSignIn({ issuer: ISSUER, subject: "subject-1", username: "alice", role: "operator" });
    expect(mods.registry.accountRegistryEntryById(entry.id)?.requestedUsername).toBe("alice");
    const refused = await app().request(`/api/admin/accounts/${entry.id}/rename`, { method: "POST", headers: await as("root", root.claims) });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toMatch(/deleted builtin account/);
    expect(mods.registry.accountRegistryEntryById(entry.id)?.username).toBe("carol");
  });
});

describe("a schedule of an ended account", () => {
  it("is not registered again at the next boot", async () => {
    configure({ enabled: true, users: [root.record, alice.record] });
    mods.runner.addAndActivateScheduledTask({ id: "sched_a", cron: "* * * * *", label: "a", task: "t", ...ALICE, createdAt: "x" });
    mods.runner.addAndActivateScheduledTask({ id: "sched_b", cron: "* * * * *", label: "b", task: "t", userId: "root", account: root.id, createdAt: "x" });
    expect(mods.runner.disableAccountScheduledTasks(alice.id, "account deleted")).toEqual(["sched_a"]);
    // Again: nothing more to disable.
    expect(mods.runner.disableAccountScheduledTasks(alice.id, "account deleted")).toEqual([]);

    // A restart: the store is read from disk, and only root's schedule runs.
    mods.runner._resetScheduledTaskRuntimeForTests();
    mods.scheduled._setScheduledTasksPathForTests(join(workspace, ".starlingai", "scheduled-tasks.json"));
    expect(existsSync(join(workspace, ".starlingai", "scheduled-tasks.json"))).toBe(true);
    mods.runner.rehydrateScheduledTasks();
    expect(mods.runner.activeScheduledTaskCount()).toBe(1);
  });
});
