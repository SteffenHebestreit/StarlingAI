import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../runtime/accounts.js";
import { bootstrapClaims, testAccount, type TestAccount } from "./support/test-account.js";

/**
 * Records other than sessions are their owner's by identity, not by name (S3, ownsRecord): knowledge
 * bases, schedules, the long-running dock, missions, scene and job runs. Each compared the
 * username, or nothing at all (the dock and the mission routes only wanted a valid token or the
 * operator role, which every account holds), so an account deleted and created again under the same
 * name saw and acted on everything the old one left. The re-created "alice" below holds a token bound
 * to her own new id; the old alice's records carry the old one.
 */

// Nothing here crawls, cancels a turn on the bus, or reaches engram.
vi.mock("../retrieval/kb-crawler.js", async (importActual) => ({
  ...(await importActual<typeof import("../retrieval/kb-crawler.js")>()),
  isCrawlActive: () => false,
  startKbCrawl: async () => ({ ok: true }),
  cancelKbCrawl: async () => true,
  deleteKnowledgeBase: async () => ({ ok: true, documentsRemoved: 0, documentsFailed: 0 }),
}));
vi.mock("../retrieval/engram.js", async (importActual) => ({
  ...(await importActual<typeof import("../retrieval/engram.js")>()),
  engramConfigured: () => true,
}));
const cancelled = vi.hoisted(() => [] as string[]);
vi.mock("../swarm/control.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../swarm/control.js")>()),
  requestDistributedSessionCancel: async (rootSessionId: string) => {
    cancelled.push(rootSessionId);
    return { commandId: "cmd-test", abortedLocally: true };
  },
}));

const SECRET = "r".repeat(40);
const FILE_DIR = mkdtempSync(join(tmpdir(), "starlingai-ownership-records-file-"));
const CONFIG_PATH = join(FILE_DIR, "starlingai.json");
const dirs: string[] = [];
let workspace = "";
let mods: Awaited<ReturnType<typeof loadModules>>;

async function loadModules() {
  writeFileSync(CONFIG_PATH, JSON.stringify({ gateway: { jwtSecret: SECRET } }), "utf8");
  process.env["SAI_CONFIG_PATH"] = CONFIG_PATH;
  process.env["SAI_MUTABLE_CONFIG_PATH"] = CONFIG_PATH;
  process.env["SAI_SESSION_STORE"] = join(FILE_DIR, "sessions.json");
  delete process.env["DATABASE_URL"];
  delete process.env["REDIS_URL"];
  const authModule = await import("../gateway/auth.js");
  const loader = await import("../config/loader.js");
  const sessions = await import("../agent/session.js");
  const registry = await import("../runtime/account-registry.js");
  const kb = await import("../retrieval/knowledge-bases.js");
  const { registerKnowledgeBaseRoutes } = await import("../gateway/knowledge-base-routes.js");
  const { registerLongRunningRoutes } = await import("../gateway/long-running-routes.js");
  const { registerMissionRoutes } = await import("../gateway/mission-routes.js");
  const lrg = await import("../agent/long-running-generation.js");
  const missions = await import("../swarm/mission-store.js");
  const budget = await import("../swarm/mission-budget.js");
  const scheduled = await import("../runtime/scheduled-tasks.js");
  const tools = await import("../tools/registry.js");
  await import("../tools/schedule.js");
  const rag = await import("../retrieval/document-rag.js");
  return {
    authModule, loader, sessions, registry, kb, registerKnowledgeBaseRoutes, registerLongRunningRoutes,
    registerMissionRoutes, lrg, missions, budget, scheduled, tools, rag,
  };
}

// Loading the modules cold can take longer than a hook's default 10 s.
beforeAll(async () => {
  mods = await loadModules();
}, 60_000);

afterAll(() => {
  for (const key of ["SAI_CONFIG_PATH", "SAI_MUTABLE_CONFIG_PATH", "SAI_SESSION_STORE"]) delete process.env[key];
  rmSync(FILE_DIR, { recursive: true, force: true });
});

afterEach(async () => {
  cancelled.length = 0;
  mods.lrg.longRunningGenerationManager.resetForTests();
  await mods.missions.resetMissionStoreForTests();
  await mods.budget.resetMissionBudgetForTests();
  mods.scheduled._setScheduledTasksPathForTests(null);
  mods.sessions.resetSessionsForTests();
  mods.registry.resetAccountRegistryForTests();
  mods.loader.resetConfigForTests();
  mods.authModule.resetAuthStateForTests();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The same username under another id: an account deleted and created again. */
function recreated(username: string, role = "operator"): TestAccount {
  const base = testAccount(username, role);
  const id = `${username}-${"b".repeat(16)}`;
  return { id, record: { ...base.record, id }, claims: { ...base.claims, aid: id } };
}

const root = testAccount("root", "admin");
const oldAlice = testAccount("alice");
const newAlice = recreated("alice");
const OLD_ALICE: Identity = { userId: "alice", account: oldAlice.id };
const NEW_ALICE: Identity = { userId: "alice", account: newAlice.id };

function configure(auth: Record<string, unknown>): void {
  workspace = mkdtempSync(join(tmpdir(), "starlingai-ownership-records-"));
  dirs.push(workspace);
  writeFileSync(CONFIG_PATH, JSON.stringify({
    gateway: { jwtSecret: SECRET },
    workspacePath: workspace,
    auth,
    retrieval: { knowledgeBases: { enabled: true } },
  }), "utf8");
  mods.loader.resetConfigForTests();
  mods.registry.resetAccountRegistryForTests();
  mods.authModule.resetAuthStateForTests();
  mods.scheduled._setScheduledTasksPathForTests(join(workspace, "scheduled-tasks.json"));
}

/** The old alice is gone; a new account holds her name. Root is an admin. */
function afterRecreation(): void {
  configure({ enabled: true, users: [root.record, newAlice.record] });
}

async function bearer(username: string, claims: Record<string, unknown>): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${await mods.authModule.createToken(username, claims)}`, "Content-Type": "application/json" };
}

function app(): Hono {
  const hono = new Hono();
  mods.registerKnowledgeBaseRoutes(hono);
  mods.registerLongRunningRoutes(hono);
  mods.registerMissionRoutes(hono);
  return hono;
}

const ids = (items: Array<{ id: string }>): string[] => items.map((item) => item.id).sort();

describe("knowledge bases", () => {
  async function userKb(name: string, owner: Identity | undefined) {
    const created = await mods.kb.createKnowledgeBase({
      name,
      seedUrls: [`https://${name.toLowerCase().replace(/\W+/g, "-")}.example/`],
      scope: "user",
      ...(owner?.userId ? { ownerId: owner.userId } : {}),
      ...(owner?.account ? { ownerAccount: owner.account } : {}),
      ...(owner?.principal ? { ownerPrincipal: owner.principal } : {}),
    });
    if (!created.ok) throw new Error(created.error);
    return created.value.id;
  }

  it("a re-created account neither lists, reads nor deletes the old one's; an admin reaches one from before ids", async () => {
    afterRecreation();
    const old = await userKb("Old ferries", OLD_ALICE);
    const own = await userKb("New ferries", NEW_ALICE);
    // Written before account ids: a name and no kind.
    const legacy = await userKb("Legacy ferries", { userId: "alice" });
    const alice = await bearer("alice", newAlice.claims);
    const admin = await bearer("root", root.claims);

    const listed = await app().request("/api/knowledge-bases", { headers: alice });
    expect(listed.status).toBe(200);
    expect(ids(((await listed.json()) as { knowledgeBases: Array<{ id: string }> }).knowledgeBases)).toEqual([own]);
    expect((await app().request(`/api/knowledge-bases/${old}`, { headers: alice })).status).toBe(404);
    expect((await app().request(`/api/knowledge-bases/${legacy}`, { headers: alice })).status).toBe(404);
    expect((await app().request(`/api/knowledge-bases/${old}`, { method: "DELETE", headers: alice })).status).toBe(404);
    expect((await app().request(`/api/knowledge-bases/${own}`, { headers: alice })).status).toBe(200);

    const adminList = await app().request("/api/knowledge-bases", { headers: admin });
    expect(ids(((await adminList.json()) as { knowledgeBases: Array<{ id: string }> }).knowledgeBases)).toContain(legacy);
    // Ambient retrieval never takes one from before ids, or another account's.
    expect(mods.kb.callerCanAccessKb({ scope: "user", ownerId: "alice" }, { userId: "alice", identity: NEW_ALICE })).toBe(false);
    expect(mods.kb.callerCanAccessKb({ scope: "user", ownerId: "alice", ownerAccount: oldAlice.id }, { userId: "alice", identity: NEW_ALICE })).toBe(false);
  });

  it("a bootstrap token's KB is stamped with its kind and stays its own", async () => {
    const adminAccount = testAccount("admin");
    configure({ enabled: true, users: [root.record, adminAccount.record] });
    const created = await app().request("/api/knowledge-bases", {
      method: "POST",
      headers: await bearer("admin", bootstrapClaims("operator")),
      body: JSON.stringify({ name: "Token notes", seedUrls: ["https://token.example/"], scope: "user", crawlNow: false }),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const stored = await mods.kb.getKnowledgeBase(id);
    expect(stored).toMatchObject({ ownerId: "admin", ownerPrincipal: "bootstrap" });
    expect(stored?.ownerAccount).toBeUndefined();
    expect((await app().request(`/api/knowledge-bases/${id}`, { headers: await bearer("admin", bootstrapClaims("operator")) })).status).toBe(200);
    expect((await app().request(`/api/knowledge-bases/${id}`, { headers: await bearer("admin", adminAccount.claims) })).status).toBe(404);
  });

  it("with one operator, a user KB is its owner's by name, as before", () => {
    configure({ enabled: false });
    expect(mods.kb.callerCanAccessKb({ scope: "user", ownerId: "alice" }, { userId: "alice" })).toBe(true);
    expect(mods.kb.callerCanAccessKb({ scope: "user", ownerId: "alice" }, { userId: "bob" })).toBe(false);
  });
});

describe("documents", () => {
  it("a re-created account manages its own corpus, not the old one's", () => {
    afterRecreation();
    const manageable = mods.rag.callerManageableSources({ userId: "alice", identity: NEW_ALICE });
    expect(manageable.has(`user:${newAlice.id}`)).toBe(true);
    expect(manageable.has(`user:${oldAlice.id}`)).toBe(false);
    expect(manageable.has("user:alice")).toBe(false);
  });
});

describe("schedules", () => {
  async function runTool(name: string, args: Record<string, unknown>, who: Identity, role = "operator") {
    const tool = mods.tools.getTool(name);
    if (!tool) throw new Error(`${name} is not registered`);
    return tool.execute(args, { sessionId: "chat-1", workspacePath: workspace, userId: who.userId, identity: who, userRole: role });
  }

  function schedule(id: string, owner: Identity) {
    mods.scheduled.saveScheduledTask({ id, cron: "0 8 * * 1-5", label: `${id} label`, task: `${id} task`, ...owner, createdAt: "2026-10-01T00:00:00Z" } as never);
  }

  it("a re-created account neither lists nor removes the old one's standing agents", async () => {
    afterRecreation();
    schedule("sched_old", OLD_ALICE);
    schedule("sched_own", NEW_ALICE);
    schedule("sched_legacy", { userId: "alice" });

    const listed = await runTool("schedule_list", {}, NEW_ALICE);
    expect(listed.output).toContain("sched_own");
    expect(listed.output).not.toContain("sched_old");
    expect(listed.output).not.toContain("sched_legacy");

    const removed = await runTool("schedule_remove", { scheduleId: "sched_old" }, NEW_ALICE);
    expect(removed.success).toBe(false);
    expect(mods.scheduled.listScheduledTaskRecords().map((record) => record.id)).toContain("sched_old");

    const adminList = await runTool("schedule_list", {}, { userId: "root", account: root.id }, "admin");
    expect(adminList.output).toContain("sched_old");
    expect(adminList.output).toContain("sched_legacy");
  });

  it("with one operator, every schedule is listed, as before", async () => {
    configure({ enabled: false });
    schedule("sched_a", { userId: "alice" });
    schedule("sched_b", { userId: "bob" });
    const listed = await runTool("schedule_list", {}, { userId: "alice" });
    expect(listed.output).toContain("sched_a");
    expect(listed.output).toContain("sched_b");
  });
});

describe("the long-running dock", () => {
  function pause(chatId: string, agentName: string): string {
    mods.lrg.longRunningGenerationManager.notifyLongRunning({
      agentName,
      runSessionId: `sub:${chatId}:${agentName}:1`,
      parentSessionId: chatId,
      reason: "ran long",
      elapsedMs: 200_000,
      completionTokens: 9_000,
      iterations: 7,
    });
    const request = mods.lrg.longRunningGenerationManager.listPending().find((entry) => entry.agentName === agentName);
    if (!request) throw new Error("no request surfaced");
    return request.id;
  }

  it("a re-created account neither sees nor decides the old one's paused runs; an admin does", async () => {
    afterRecreation();
    const oldChat = mods.sessions.createSession({ channel: "webchat", ...OLD_ALICE, workspacePath: workspace });
    const ownChat = mods.sessions.createSession({ channel: "webchat", ...NEW_ALICE, workspacePath: workspace });
    const oldRequest = pause(oldChat.id, "researcher");
    const ownRequest = pause(ownChat.id, "coder");
    const alice = await bearer("alice", newAlice.claims);

    const active = await app().request("/api/long-running/active", { headers: alice });
    expect(ids((await active.json()) as Array<{ id: string }>)).toEqual([ownRequest]);
    const refused = await app().request(`/api/long-running/${oldRequest}/respond`, { method: "POST", headers: alice, body: JSON.stringify({ outcome: "stop" }) });
    expect(refused.status).toBe(404);
    expect(mods.lrg.longRunningGenerationManager.getRequest(oldRequest)?.state).toBe("pending");

    const adminActive = await app().request("/api/long-running/active", { headers: await bearer("root", root.claims) });
    expect(ids((await adminActive.json()) as Array<{ id: string }>)).toEqual([oldRequest, ownRequest].sort());
    const decided = await app().request(`/api/long-running/${ownRequest}/respond`, { method: "POST", headers: alice, body: JSON.stringify({ outcome: "continue" }) });
    expect(decided.status).toBe(200);
  });

  it("with one operator, every paused run is listed, as before", async () => {
    configure({ enabled: false });
    const request = pause("chat-x", "researcher");
    const active = await app().request("/api/long-running/active", { headers: await bearer("admin", { role: "operator" }) });
    expect(ids((await active.json()) as Array<{ id: string }>)).toEqual([request]);
  });
});

describe("missions", () => {
  it("a re-created account neither lists, reads nor cancels the old one's; an admin does", async () => {
    afterRecreation();
    const store = await mods.missions.getMissionStore();
    const oldChat = mods.sessions.createSession({ channel: "webchat", ...OLD_ALICE, workspacePath: workspace });
    const ownChat = mods.sessions.createSession({ channel: "webchat", ...NEW_ALICE, workspacePath: workspace });
    // Owned through its root session, as the event bridge creates it (no owner stamped).
    const old = await store.getOrCreateMissionForSession({ rootSessionId: oldChat.id, objective: "old plans" });
    // Its chat gone from this process: owned through the account stamped on it.
    const stamped = await store.getOrCreateMissionForSession({ rootSessionId: "chat-gone", userId: "alice", account: oldAlice.id, objective: "older plans" });
    const own = await store.getOrCreateMissionForSession({ rootSessionId: ownChat.id, objective: "my plans" });
    const alice = await bearer("alice", newAlice.claims);

    const listed = await app().request("/api/missions", { headers: alice });
    expect(listed.status).toBe(200);
    expect(ids(((await listed.json()) as { missions: Array<{ id: string }> }).missions)).toEqual([own.id]);
    expect((await app().request(`/api/missions/${old.id}`, { headers: alice })).status).toBe(404);
    expect((await app().request(`/api/missions/${stamped.id}`, { headers: alice })).status).toBe(404);
    const refused = await app().request(`/api/missions/${old.id}/cancel`, { method: "POST", headers: alice, body: "{}" });
    expect(refused.status).toBe(404);
    expect(cancelled).toEqual([]);
    expect((await store.getMission(old.id))?.status).toBe("active");
    expect((await app().request(`/api/missions/${own.id}`, { headers: alice })).status).toBe(200);

    const adminList = await app().request("/api/missions", { headers: await bearer("root", root.claims) });
    expect(ids(((await adminList.json()) as { missions: Array<{ id: string }> }).missions)).toEqual([old.id, stamped.id, own.id].sort());
  });
});
