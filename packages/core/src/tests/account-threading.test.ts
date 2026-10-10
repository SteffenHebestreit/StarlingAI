import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { testAccount, testAccountId } from "./support/test-account.js";

/**
 * Every place an owner is recorded or a run is started carries the identity whole (S2): the
 * account id beside the username, or a principal's kind. A username alone is what an account
 * created again under an old name shares with the one before; under multi-user auth it would
 * either derive the old account's storage or, now, be refused by the identity guard. With one
 * operator nothing new is written anywhere.
 */

const pgCalls = vi.hoisted(() => [] as Array<{ sql: string; params: unknown[] }>);
vi.mock("pg", () => {
  class FakeClient {
    async query(sql: string, params: unknown[] = []) {
      pgCalls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }
    release() {}
  }
  class FakePool {
    async query(sql: string, params: unknown[] = []) {
      pgCalls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }
    async connect() { return new FakeClient(); }
    async end() {}
    on() {}
  }
  return { default: { Pool: FakePool } };
});

const turns = vi.hoisted(() => [] as Array<{ identity: unknown; root: string }>);
vi.mock("../agent/runtime.js", () => ({
  collectTurnArtifactAttachments: () => [],
  runTurn: async (opts: { session: { identity(): unknown; getWorkspacePath(): string } }) => {
    turns.push({ identity: opts.session.identity(), root: opts.session.getWorkspacePath() });
    return { response: "done", toolCallsExecuted: 0, guardrailEvents: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, blocked: false };
  },
}));

const rateSubjects = vi.hoisted(() => [] as string[]);
vi.mock("../guardrails/rate-limiter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../guardrails/rate-limiter.js")>();
  return {
    ...actual,
    checkRateLimit: async (subject: string) => {
      rateSubjects.push(subject);
      return { allowed: true, remaining: 10, resetAt: 0 };
    },
  };
});

const scheduled = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("../runtime/scheduled-task-runner.js", () => ({
  addAndActivateScheduledTask: (record: Record<string, unknown>) => { scheduled.push(record); },
  removeScheduledTask: () => true,
}));

const FILE_DIR = mkdtempSync(join(tmpdir(), "starlingai-account-threading-"));
const CONFIG_PATH = join(FILE_DIR, "starlingai.json");
let workspace = "";

async function loadModules() {
  writeFileSync(CONFIG_PATH, JSON.stringify({ gateway: { jwtSecret: "t".repeat(40) } }), "utf8");
  process.env["SAI_CONFIG_PATH"] = CONFIG_PATH;
  process.env["SAI_MUTABLE_CONFIG_PATH"] = CONFIG_PATH;
  process.env["SAI_SESSION_STORE"] = join(FILE_DIR, "sessions.json");
  process.env["SAI_AUDIT_LOG"] = join(FILE_DIR, "audit.jsonl");
  process.env["SAI_JOB_WAKE_DISABLED"] = "1";
  const loader = await import("../config/loader.js");
  const registry = await import("../runtime/account-registry.js");
  const context = await import("../runtime/request-context.js");
  const scope = await import("../runtime/user-scope.js");
  const tools = await import("../tools/registry.js");
  await import("../tools/workflow-catalog.js");
  await import("../tools/schedule.js");
  const sessions = await import("../agent/session.js");
  const jobs = await import("../agent/jobs.js");
  const kbs = await import("../retrieval/knowledge-bases.js");
  const missions = await import("../swarm/mission-store.js");
  const a2a = await import("../a2a/server.js");
  const container = await import("../agent/container-runner.js");
  const prepare = await import("../agent/turn-prepare.js");
  return { loader, registry, context, scope, tools, sessions, jobs, kbs, missions, a2a, container, prepare };
}

let mods: Awaited<ReturnType<typeof loadModules>>;

beforeAll(async () => {
  mods = await loadModules();
});

afterAll(() => {
  mods.loader.resetConfigForTests();
  for (const key of ["SAI_CONFIG_PATH", "SAI_MUTABLE_CONFIG_PATH", "SAI_SESSION_STORE", "SAI_AUDIT_LOG", "SAI_JOB_WAKE_DISABLED", "DATABASE_URL"]) delete process.env[key];
  rmSync(FILE_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  pgCalls.length = 0;
  turns.length = 0;
  rateSubjects.length = 0;
  scheduled.length = 0;
});

afterEach(async () => {
  delete process.env["DATABASE_URL"];
  await mods.jobs.resetJobsForTests();
  await mods.missions.resetMissionStoreForTests();
  mods.sessions.resetSessionsForTests();
});

const ALICE = { userId: "alice", account: testAccountId("alice") };

function configure(authEnabled: boolean, extra: Record<string, unknown> = {}): void {
  workspace = mkdtempSync(join(FILE_DIR, "ws-"));
  writeFileSync(CONFIG_PATH, JSON.stringify({
    gateway: { jwtSecret: "t".repeat(40) },
    workspacePath: workspace,
    auth: { enabled: authEnabled, users: [testAccount("alice").record] },
    ...extra,
  }), "utf8");
  mods.loader.resetConfigForTests();
  mods.loader.loadConfig();
  mods.registry.resetAccountRegistryForTests();
}

describe("a workflow run belongs to its caller, whole", () => {
  const scenes = { scenes: { ferry_check: { description: "Checks the ferries.", task: "Check the Hamburg ferry times." } } };

  async function runScene(ctx: Record<string, unknown>, ambient?: { userId: string; account?: string }) {
    const tool = mods.tools.getTool("run_workflow")!;
    const run = () => tool.execute({ name: "ferry_check", workflowType: "scene" }, { sessionId: "chat-1", workspacePath: workspace, ...ctx });
    const result = ambient ? await mods.context.runWithRequestContext({ identity: ambient }, run) : await run();
    expect(result.success, result.error).toBe(true);
  }

  it("runs the scene's session as the calling account, in the account's root", async () => {
    configure(true, scenes);
    await runScene({ userId: "alice", identity: ALICE }, ALICE);
    expect(turns).toEqual([{ identity: ALICE, root: resolve(workspace, "users", ALICE.account) }]);
  });

  it("runs a scene nobody asked for as the workflow's own principal", async () => {
    configure(true, scenes);
    await runScene({});
    expect(turns).toEqual([{
      identity: { userId: "workflow:ferry_check", principal: "synthetic" },
      root: resolve(workspace, "users", mods.scope.safeUserSegment("workflow:ferry_check")),
    }]);
  });

  it("with one operator, runs it under the caller's name alone, as before", async () => {
    configure(false, scenes);
    await runScene({ userId: "alice" }, { userId: "alice" });
    expect(turns).toEqual([{ identity: { userId: "alice" }, root: workspace }]);
  });
});

describe("scene jobs carry their owner's account id or principal kind", () => {
  it("stamps the in-process store's jobs, and reads the owner back whole", async () => {
    configure(true);
    const forAlice = await mods.jobs.createJob({ sceneName: "s", task: "t", turnTimeoutMs: 1000, ...ALICE });
    const forScene = await mods.jobs.createJob({ sceneName: "s", task: "t", turnTimeoutMs: 1000, userId: "scene:s", principal: "synthetic" });
    expect(forAlice).toMatchObject(ALICE);
    expect(forAlice).not.toHaveProperty("principal");
    expect(forScene).toMatchObject({ userId: "scene:s", principal: "synthetic" });
    expect(mods.jobs.sceneJobIdentity(forAlice)).toEqual(ALICE);
    expect(mods.jobs.sceneJobIdentity(forScene)).toEqual({ userId: "scene:s", principal: "synthetic" });
    expect(mods.jobs.sceneJobIdentity({ userId: "alice" })).toEqual({ userId: "alice" });
  });

  it("writes account_id, and the principal kind into the payload, in Postgres", async () => {
    configure(true);
    process.env["DATABASE_URL"] = "postgres://user:pw@host:5432/db";
    await mods.jobs.createJob({ sceneName: "s", task: "t", turnTimeoutMs: 1000, ...ALICE });
    await mods.jobs.createJob({ sceneName: "s", task: "t", turnTimeoutMs: 1000, userId: "job:j", principal: "synthetic" });
    await mods.jobs.createJob({ sceneName: "s", task: "t", turnTimeoutMs: 1000, userId: "alice" });
    const inserts = pgCalls.filter((call) => call.sql.includes("INSERT INTO scene_jobs"));
    expect(inserts).toHaveLength(3);
    expect(inserts[0]!.sql.replace(/\s+/g, " ")).toContain("payload, account_id ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)");
    expect(inserts.map((call) => call.params[9])).toEqual([ALICE.account, null, null]);
    const payloads = inserts.map((call) => JSON.parse(String(call.params[8])) as Record<string, unknown>);
    expect(payloads.map((payload) => payload["principal"])).toEqual([undefined, "synthetic", undefined]);
  });
});

describe("knowledge bases record the owning account", () => {
  it("stamps a user-scoped KB with the account id, and only a user-scoped one", async () => {
    configure(true);
    const own = await mods.kbs.createKnowledgeBase({ name: "Ferries", seedUrls: ["https://example.test/"], scope: "user", ownerId: "alice", ownerAccount: ALICE.account });
    const shared = await mods.kbs.createKnowledgeBase({ name: "Shared", seedUrls: ["https://example.test/"], scope: "workspace", ownerId: "alice", ownerAccount: ALICE.account });
    expect(own.ok && own.value).toMatchObject({ ownerId: "alice", ownerAccount: ALICE.account });
    expect(shared.ok && shared.value).not.toHaveProperty("ownerAccount");

    // Moved to the workspace the stamp goes; back to a new owner, that owner's stamp comes.
    const moved = await mods.kbs.updateKnowledgeBase("ferries", { scope: "workspace" });
    expect(moved.ok && moved.value).not.toHaveProperty("ownerAccount");
    const reowned = await mods.kbs.updateKnowledgeBase("ferries", { scope: "user", ownerId: "bob", ownerAccount: testAccountId("bob") });
    expect(reowned.ok && reowned.value).toMatchObject({ ownerId: "bob", ownerAccount: testAccountId("bob") });
    const byName = await mods.kbs.updateKnowledgeBase("ferries", { scope: "user", ownerId: "carol" });
    expect(byName.ok && byName.value).not.toHaveProperty("ownerAccount");
  });
});

describe("missions record the owning account", () => {
  it("keeps the account id on the in-process record and writes account_id in Postgres", async () => {
    configure(true);
    const local = await (await mods.missions.getMissionStore()).getOrCreateMissionForSession({ rootSessionId: "root-1", ...ALICE });
    expect(local).toMatchObject(ALICE);
    await mods.missions.resetMissionStoreForTests();

    process.env["DATABASE_URL"] = "postgres://user:pw@host:5432/db";
    const store = await mods.missions.getMissionStore();
    await store.getOrCreateMissionForSession({ rootSessionId: "root-2", ...ALICE }).catch(() => undefined);
    const insert = pgCalls.find((call) => call.sql.includes("INSERT INTO missions"));
    expect(insert?.sql).toContain("account_id");
    expect(insert?.params.at(-1)).toBe(ALICE.account);
  });
});

describe("the A2A session namespace", () => {
  it("is the caller's account id or a principal's segment under multi-user auth, and nothing with one operator", () => {
    configure(true);
    expect(mods.a2a.callerScopedSessionId("trip", ALICE)).toBe(`a2a-in:${ALICE.account}:trip`);
    expect(mods.a2a.callerScopedSessionId("trip", { userId: "a2a-shared-bearer", principal: "peer" }))
      .toBe(`a2a-in:${mods.scope.safeUserSegment("a2a-shared-bearer")}:trip`);
    configure(false);
    expect(mods.a2a.callerScopedSessionId("trip", ALICE)).toBe("trip");
  });
});

describe("a containerized run carries the identity whole", () => {
  const build = (opts: Record<string, unknown>) => mods.container.buildContainerTaskPayload(
    { agentName: "coder", task: "t", parentSessionId: "p", workspacePath: "/w", ...opts } as never,
    { tools: [] } as never, { primary: "lmstudio/qwen" } as never, "http://x", "k");

  it("hands the container the run's identity, or the ambient one when the run names the same user", () => {
    configure(true);
    expect(build({ userId: "alice", identity: ALICE })).toMatchObject({ userId: "alice", identity: ALICE });
    expect(mods.context.runWithRequestContext({ identity: ALICE }, () => build({ userId: "alice" }))).toMatchObject({ userId: "alice", identity: ALICE });
    expect(mods.context.runWithRequestContext({ identity: ALICE }, () => build({}))).toMatchObject({ userId: "alice", identity: ALICE });
    expect(build({})).not.toHaveProperty("identity");
    // With one operator a caller is its name alone, and the payload is the one it was.
    configure(false);
    const payload = mods.context.runWithRequestContext({ identity: { userId: "alice" } }, () => build({ userId: "alice" }));
    expect(payload.userId).toBe("alice");
    expect(payload).not.toHaveProperty("identity");
  });
});

describe("the request rate limit", () => {
  it("keys on the owner's account id under multi-user auth, and on the username with one operator", async () => {
    configure(true);
    const session = mods.sessions.createSession({ channel: "webchat", ...ALICE });
    await mods.prepare.prepareRateLimit(session);
    configure(false);
    const offSession = mods.sessions.createSession({ channel: "webchat", userId: "alice" });
    await mods.prepare.prepareRateLimit(offSession);
    expect(rateSubjects).toEqual([ALICE.account, "alice"]);
  });
});

describe("schedule_task records its caller whole", () => {
  it("stamps the account id beside the name under multi-user auth, and the name alone with one operator", async () => {
    const tool = mods.tools.getTool("schedule_task")!;
    const args = { cron: "0 8 * * 1-5", label: "Brief", task: "research X" };
    configure(true);
    await mods.context.runWithRequestContext({ identity: ALICE }, () =>
      tool.execute(args, { sessionId: "s", workspacePath: workspace, userId: "alice", identity: ALICE }));
    configure(false);
    await mods.context.runWithRequestContext({ identity: { userId: "alice" } }, () =>
      tool.execute(args, { sessionId: "s", workspacePath: workspace, userId: "alice" }));
    expect(scheduled[0]).toMatchObject(ALICE);
    expect(scheduled[1]).toMatchObject({ userId: "alice" });
    expect(scheduled[1]).not.toHaveProperty("account");
    expect(scheduled[1]).not.toHaveProperty("principal");
  });
});
