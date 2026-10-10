import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunTurnOptions, TurnOutput } from "../agent/turn-types.js";
import { PRODUCT } from "../product/index.js";
import { testAccount } from "./support/test-account.js";

/**
 * The entry points hand the caller on whole (S2): the account id travels with the username into
 * the request context, the sessions a socket or the AG-UI stream opens, and the runs a route or a
 * trigger queues; a run nobody signed in for carries its own principal kind. Under multi-user auth
 * a name alone is either the old account's storage or, with the identity guard, an error, and a
 * session or job from before account ids runs no turn: every entry point must say which it is.
 */

const turns = vi.hoisted(() => [] as Array<{ channel: string; identity: unknown }>);
vi.mock("../agent/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent/runtime.js")>()),
  runTurn: async (opts: RunTurnOptions): Promise<TurnOutput> => {
    turns.push({ channel: opts.session.channel, identity: opts.session.identity() });
    return { response: "ok", toolCallsExecuted: 0, guardrailEvents: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, blocked: false };
  },
}));

const cronTicks = vi.hoisted(() => [] as Array<() => Promise<void> | void>);
vi.mock("../runtime/scheduler.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime/scheduler.js")>()),
  createCronJob: (_expression: string, _label: string, _action: string, onTick: () => Promise<void> | void) => {
    cronTicks.push(onTick);
    return { id: `cron-${cronTicks.length}` };
  },
  removeCronJob: () => true,
}));

const SECRET = "g".repeat(40);
const WEBHOOK_KEY = "scene-webhook-key-0123456789";
const FILE_DIR = mkdtempSync(join(tmpdir(), "starlingai-gateway-identity-"));
const CONFIG_PATH = join(FILE_DIR, "starlingai.json");
let workspace = "";

async function loadModules() {
  writeFileSync(CONFIG_PATH, JSON.stringify({ gateway: { jwtSecret: SECRET } }), "utf8");
  process.env["SAI_CONFIG_PATH"] = CONFIG_PATH;
  process.env["SAI_MUTABLE_CONFIG_PATH"] = CONFIG_PATH;
  process.env["SAI_SESSION_STORE"] = join(FILE_DIR, "sessions.json");
  process.env["SAI_MASTER_KEY"] = "m".repeat(32);
  process.env["SAI_CRED_STORE"] = join(FILE_DIR, PRODUCT.stateDirName, "credentials.enc");
  process.env["SAI_JOB_WAKE_DISABLED"] = "1";
  const loader = await import("../config/loader.js");
  const registry = await import("../runtime/account-registry.js");
  const auth = await import("../gateway/auth.js");
  const sessions = await import("../agent/session.js");
  const jobs = await import("../agent/jobs.js");
  const rpc = await import("../gateway/rpc.js");
  const agui = await import("../gateway/agui.js");
  const channelTriggers = await import("../channels/job-triggers.js");
  const cronTriggers = await import("../runtime/job-triggers.js");
  const scope = await import("../runtime/user-scope.js");
  return { loader, registry, auth, sessions, jobs, rpc, agui, channelTriggers, cronTriggers, scope };
}

let mods: Awaited<ReturnType<typeof loadModules>>;

beforeAll(async () => {
  mods = await loadModules();
});

afterAll(() => {
  mods.loader.resetConfigForTests();
  for (const key of ["SAI_CONFIG_PATH", "SAI_MUTABLE_CONFIG_PATH", "SAI_SESSION_STORE", "SAI_MASTER_KEY", "SAI_CRED_STORE", "SAI_JOB_WAKE_DISABLED", "SAI_AUDIT_LOG"]) delete process.env[key];
  rmSync(FILE_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  turns.length = 0;
  cronTicks.length = 0;
});

afterEach(async () => {
  await mods.jobs.resetJobsForTests();
  mods.sessions.resetSessionsForTests();
  mods.auth.resetAuthStateForTests();
});

const alice = testAccount("alice");
const root = testAccount("root", "admin");
const ALICE = { userId: "alice", account: alice.id };

function configure(authEnabled: boolean, extra: Record<string, unknown> = {}): void {
  workspace = mkdtempSync(join(FILE_DIR, "ws-"));
  process.env["SAI_AUDIT_LOG"] = join(workspace, "audit.jsonl");
  writeFileSync(CONFIG_PATH, JSON.stringify({
    gateway: { jwtSecret: SECRET, turnTimeoutMs: 30_000, ...((extra["gateway"] as object) ?? {}) },
    workspacePath: workspace,
    auth: { enabled: authEnabled, users: [root.record, alice.record] },
    scenes: { ferry_check: { description: "Checks the ferries.", task: "Check the Hamburg ferry times.", webhookKey: WEBHOOK_KEY } },
    jobs: {
      ops_brief: {
        description: "An ops brief.",
        steps: [{ scene: "ferry_check" }],
        triggers: [
          { type: "channel", channels: ["slack"], pattern: "/ops-brief", mode: "prefix" },
          { type: "cron", expression: "0 7 * * *" },
        ],
      },
    },
  }), "utf8");
  mods.loader.resetConfigForTests();
  mods.loader.loadConfig();
  mods.registry.resetAccountRegistryForTests();
  mods.auth.resetAuthStateForTests();
}

describe("the gateway's /api routes", () => {
  it("resolve a signed-in account's files and runs by its id", { timeout: 60_000 }, async () => {
    const port = 19900 + Math.floor(Math.random() * 90);
    configure(true, { gateway: { port } });
    // Alice's own file, and one under the bucket her username derives to (data from before ids).
    mkdirSync(join(workspace, "users", alice.id, "generated"), { recursive: true });
    writeFileSync(join(workspace, "users", alice.id, "generated", "note.txt"), "mine", "utf8");
    const nameBucket = mods.scope.safeUserSegment("alice");
    mkdirSync(join(workspace, "users", nameBucket, "generated"), { recursive: true });
    writeFileSync(join(workspace, "users", nameBucket, "generated", "old.txt"), "before ids", "utf8");

    const { createGateway } = await import("../gateway/index.js");
    const gateway = createGateway();
    await gateway.start();
    const base = `http://127.0.0.1:${port}`;
    const bearer = { Authorization: `Bearer ${await mods.auth.createToken("alice", alice.claims)}` };
    try {
      const own = await fetch(`${base}/api/workspace/file?path=generated/note.txt`, { headers: bearer });
      expect(own.status).toBe(200);
      expect(await own.text()).toBe("mine");
      expect((await fetch(`${base}/api/workspace/file?path=generated/old.txt`, { headers: bearer })).status).toBe(404);

      // A scene she runs is queued as her account; one a webhook key starts, as the scene itself.
      expect((await fetch(`${base}/api/scenes/ferry_check/run`, { method: "POST", headers: bearer })).status).toBe(200);
      expect((await fetch(`${base}/api/scenes/ferry_check/run?key=${WEBHOOK_KEY}`, { method: "POST" })).status).toBe(200);
      const queued = await mods.jobs.listJobs();
      expect(queued.map((job) => mods.jobs.sceneJobIdentity(job)).sort((a, b) => String(a?.userId).localeCompare(String(b?.userId)))).toEqual([
        ALICE,
        { userId: "scene:ferry_check", principal: "synthetic" },
      ]);
    } finally {
      await gateway.stop();
    }
  });
});

describe("sessions an entry point opens", () => {
  it("a dashboard socket opens them as the signed-in account", async () => {
    configure(true);
    const sent: string[] = [];
    const ws = { readyState: 1, send: (data: string) => { sent.push(data); }, close() {} };
    const caller = await mods.auth.authenticatedUserFromToken(await mods.auth.createToken("alice", alice.claims));
    const connection = new mods.rpc.RpcConnection(ws as never, caller!.username, caller!.role, caller!);
    await connection.handleMessage(JSON.stringify({ id: "c1", method: "session.create", params: {} }));
    const reply = sent.map((data) => JSON.parse(data) as { id?: string; ok?: boolean; payload?: { sessionId?: string } }).find((message) => message.id === "c1");
    expect(reply?.ok).toBe(true);
    const session = mods.sessions.getSession(reply!.payload!.sessionId!)!;
    expect(session.identity()).toEqual(ALICE);
    expect(session.getWorkspacePath()).toBe(join(workspace, "users", alice.id));
    connection.close();
  });

  it("the AG-UI stream opens them as the caller", async () => {
    configure(true);
    class FakeResponse extends EventEmitter {
      statusCode?: number;
      writableEnded = false;
      writeHead(status: number) { this.statusCode = status; }
      write() { return true; }
      end() { this.writableEnded = true; }
    }
    const res = new FakeResponse();
    await mods.agui.handleAguiStream(res as never, { message: "hi" }, { userId: "alice", role: "operator", identity: ALICE });
    expect(res.statusCode).toBe(200);
    expect(turns).toEqual([{ channel: "webchat:agui", identity: ALICE }]);
  });
});

describe("runs a trigger queues", () => {
  it("carry the trigger's own principal kind under multi-user auth", async () => {
    configure(true);
    await mods.channelTriggers.dispatchChannelTriggeredJob({ channel: "slack", senderId: "U123", text: "/ops-brief now" });
    mods.cronTriggers.syncConfiguredJobTriggers(30_000);
    for (const tick of cronTicks) await tick();
    const queued = (await mods.jobs.listJobs()).map((job) => mods.jobs.sceneJobIdentity(job));
    expect(queued).toEqual(expect.arrayContaining([
      { userId: "slack:U123", principal: "synthetic" },
      { userId: "job:ops_brief", principal: "synthetic" },
    ]));
    expect(queued).toHaveLength(2);
  });

  it("carry the name alone with one operator, as before", async () => {
    configure(false);
    await mods.channelTriggers.dispatchChannelTriggeredJob({ channel: "slack", senderId: "U123", text: "/ops-brief now" });
    const [job] = await mods.jobs.listJobs();
    expect(job).toMatchObject({ userId: "slack:U123" });
    expect(job).not.toHaveProperty("principal");
  });
});

