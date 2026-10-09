import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import type { RunTurnOptions, TurnOutput } from "../agent/turn-types.js";
import { PRODUCT } from "../product/index.js";
import { testAccount } from "./support/test-account.js";

/**
 * A WebSocket's caller is the account the stores hold now, not the one its handshake named.
 *
 * The dashboard socket verified the token's signature once and kept its `sub` and `role` for the
 * life of the connection: a deleted account kept chatting through a tab it had open, and a demoted
 * admin kept every other account's sessions and audit stream. The iframe preview, the served-site
 * preview, the live-app proxy and the browser view took a token from the query string, past the
 * /api middleware that refuses a revoked account, and checked only its signature.
 */

const runTurnMock = vi.hoisted(() => vi.fn<(opts: RunTurnOptions) => Promise<TurnOutput>>());

// The turn is stubbed: what these pin is whether a turn starts at all.
vi.mock("../agent/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent/runtime.js")>()),
  runTurn: runTurnMock,
}));

const SECRET = "w".repeat(40);
// The config loader fixes its file when it loads, so the modules load once for this file and every
// test writes its configuration to that one file.
const FILE_DIR = mkdtempSync(join(tmpdir(), "starlingai-ws-identity-file-"));
const CONFIG_PATH = join(FILE_DIR, "starlingai.json");
const dirs: string[] = [];
let workspace = "";
let mods: Awaited<ReturnType<typeof loadModules>>;

async function loadModules() {
  writeFileSync(CONFIG_PATH, JSON.stringify({ gateway: { jwtSecret: SECRET } }), "utf8");
  process.env["SAI_CONFIG_PATH"] = CONFIG_PATH;
  process.env["SAI_MUTABLE_CONFIG_PATH"] = CONFIG_PATH;
  process.env["SAI_SESSION_STORE"] = join(FILE_DIR, "sessions.json");
  process.env["SAI_MASTER_KEY"] = "m".repeat(32);
  process.env["SAI_CRED_STORE"] = join(FILE_DIR, PRODUCT.stateDirName, "credentials.enc");
  const [rpc, authModule, loader, sessions, registry, { registerUserRoutes }, { registerWorkspaceRoutes }, connections, audit] = await Promise.all([
    import("../gateway/rpc.js"),
    import("../gateway/auth.js"),
    import("../config/loader.js"),
    import("../agent/session.js"),
    import("../runtime/account-registry.js"),
    import("../gateway/user-routes.js"),
    import("../gateway/workspace-routes.js"),
    import("../gateway/account-connections.js"),
    import("../audit/logger.js"),
  ]);
  return { rpc, authModule, loader, sessions, registry, registerUserRoutes, registerWorkspaceRoutes, connections, audit };
}

beforeAll(async () => {
  mods = await loadModules();
});

afterAll(() => {
  for (const key of ["SAI_CONFIG_PATH", "SAI_MUTABLE_CONFIG_PATH", "SAI_SESSION_STORE", "SAI_MASTER_KEY", "SAI_CRED_STORE"]) delete process.env[key];
  rmSync(FILE_DIR, { recursive: true, force: true });
});

afterEach(async () => {
  for (const conn of openConnections.splice(0)) conn.close();
  runTurnMock.mockReset();
  await mods.audit.flushAuditLog();
  mods.sessions.resetSessionsForTests();
  mods.registry.resetAccountRegistryForTests();
  mods.loader.resetConfigForTests();
  mods.authModule.resetAuthStateForTests();
  delete process.env["SAI_AUDIT_LOG"];
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const alice = testAccount("alice");
const root = testAccount("root", "admin");

function configure(auth: Record<string, unknown>, gateway: Record<string, unknown> = {}): void {
  workspace = mkdtempSync(join(tmpdir(), "starlingai-ws-identity-"));
  dirs.push(workspace);
  writeFileSync(CONFIG_PATH, JSON.stringify({
    gateway: { jwtSecret: SECRET, turnTimeoutMs: 30_000, ...gateway },
    workspacePath: workspace,
    auth,
  }), "utf8");
  process.env["SAI_AUDIT_LOG"] = join(workspace, "audit.jsonl");
  mods.loader.resetConfigForTests();
  mods.registry.resetAccountRegistryForTests();
  mods.authModule.resetAuthStateForTests();
}

function withoutUser(username: string): void {
  mods.loader.updateConfig((raw) => {
    const auth = raw["auth"] as { users: Array<{ username: string }> };
    auth.users = auth.users.filter((user) => user.username !== username);
  });
}

function setRole(username: string, role: string): void {
  mods.loader.updateConfig((raw) => {
    const auth = raw["auth"] as { users: Array<{ username: string; role: string }> };
    for (const user of auth.users) if (user.username === username) user.role = role;
  });
}

type Sent = Array<Record<string, unknown>>;

/** Sockets a test opened, closed after it as the gateway closes one (ws "close" -> conn.close()). */
const openConnections: Array<{ close(): void }> = [];

/** A dashboard socket of `username`, opened as gateway/index.ts opens one under multi-user auth. */
async function openSocket(username: string, claims: Record<string, unknown>) {
  const sent: Sent = [];
  const ws = {
    readyState: 1,
    closed: undefined as { code: number; reason: string } | undefined,
    send(payload: string) { sent.push(JSON.parse(payload) as Record<string, unknown>); },
    close(code: number, reason: string) { this.closed = { code, reason }; this.readyState = 3; },
  };
  const user = await mods.authModule.authenticatedUserFromToken(await mods.authModule.createToken(username, claims));
  expect(user, `${username} signs in`).not.toBeNull();
  const conn = new mods.rpc.RpcConnection(ws as never, user!.username, user!.role, user!);
  openConnections.push(conn);
  let counter = 0;
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const id = `${method}-${++counter}`;
    await conn.handleMessage(JSON.stringify({ id, method, params }));
    return sent.find((message) => message["type"] === "rpc.response" && message["id"] === id) as { ok: boolean; payload?: unknown; error?: string };
  };
  return { ws, sent, conn, call };
}

const turnOutput = (): TurnOutput => ({
  response: "Done.",
  toolCallsExecuted: 0,
  guardrailEvents: [],
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  blocked: false,
});

describe("a dashboard socket checks its caller before every message", () => {
  it("refuses the next message once the account is deleted, runs no turn, and closes with 4401", async () => {
    configure({ enabled: true, users: [root.record, alice.record] });
    runTurnMock.mockImplementation(async () => turnOutput());
    const tab = await openSocket("alice", alice.claims);
    const created = await tab.call("session.create", { channel: "webchat" });
    expect(created.ok).toBe(true);
    const sessionId = (created.payload as { sessionId: string }).sessionId;

    withoutUser("alice");
    const refused = await tab.call("chat.send", { sessionId, message: "keep going", requestId: "req-after-delete" });
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/no longer valid/);
    expect(tab.ws.closed?.code).toBe(4401);
    expect(runTurnMock).not.toHaveBeenCalled();
    expect(mods.sessions.getSessionRecord(sessionId)!.getHistory()).toEqual([]);
    // Nothing after it is answered: the socket is closed.
    expect(await tab.call("session.list")).toBeUndefined();
  });

  it("takes the role the store holds now, on the next message", async () => {
    const adminAlice = testAccount("alice", "admin");
    configure({ enabled: true, users: [adminAlice.record, testAccount("bob").record] });
    const bobs = mods.sessions.createSession({ channel: "webchat", userId: "bob", workspacePath: workspace });
    const tab = await openSocket("alice", adminAlice.claims);
    const ids = async () => ((await tab.call("session.list")).payload as Array<{ id: string }>).map((summary) => summary.id);
    expect(await ids()).toContain(bobs.id);

    setRole("alice", "operator");
    expect(await ids()).not.toContain(bobs.id);
    expect((await tab.call("session.get", { sessionId: bobs.id })).ok).toBe(false);
    expect(tab.ws.closed).toBeUndefined();
  });

  it("closes a listening socket when its account is deleted, and pushes nothing to it after", async () => {
    configure({ enabled: true, users: [root.record, alice.record] });
    // Deleted through the route: its sockets close at once.
    const listening = await openSocket("alice", alice.claims);
    expect(mods.connections.accountConnectionCount(alice.id)).toBe(1);
    const app = new Hono();
    mods.registerUserRoutes(app);
    const deleted = await app.request("/api/auth/users/alice", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${await mods.authModule.createToken("root", root.claims)}` },
    });
    expect(deleted.status).toBe(200);
    expect(listening.ws.closed?.code).toBe(4401);
    listening.conn.close();
    expect(mods.connections.accountConnectionCount(alice.id)).toBe(0);

    // Removed from the store some other way: the next push finds it gone.
    configure({ enabled: true, users: [root.record, alice.record] });
    const watcher = await openSocket("alice", alice.claims);
    const own = mods.sessions.createSession({ channel: "webchat", userId: "alice", workspacePath: workspace });
    expect((await watcher.call("audit.subscribe")).ok).toBe(true);
    mods.audit.logAudit("tool_call_requested", { tool: "probe" }, { sessionId: own.id, userId: "alice" });
    expect(watcher.sent.some((message) => message["type"] === "audit.event")).toBe(true);

    withoutUser("alice");
    const before = watcher.sent.length;
    mods.audit.logAudit("tool_call_requested", { tool: "probe" }, { sessionId: own.id, userId: "alice" });
    expect(watcher.sent.slice(before).some((message) => message["type"] === "audit.event")).toBe(false);
    expect(watcher.ws.closed?.code).toBe(4401);
    watcher.conn.close();
  });
});

describe("routes that take their token from a query string or a cookie", () => {
  const ghost = testAccount("ghost");

  async function workspaceApp() {
    const app = new Hono();
    mods.registerWorkspaceRoutes(app);
    const site = Buffer.from("generated/site", "utf8").toString("base64url");
    const paths = (token: string) => [
      `/api/workspace/preview?root=generated&file=index.html&token=${token}`,
      `/api/workspace/site/${site}/index.html?token=${token}`,
      `/api/app/no-such-app/?token=${token}`,
    ];
    return { app, paths };
  }

  it("refuses the token of an account the store does not hold", async () => {
    configure({ enabled: true, users: [root.record, alice.record] });
    const { app, paths } = await workspaceApp();
    // Signed, unexpired, and bound to an account id no record holds.
    const ghostToken = await mods.authModule.createToken("ghost", ghost.claims);
    for (const path of paths(ghostToken)) expect((await app.request(path)).status, path).toBe(401);
    const aliceToken = await mods.authModule.createToken("alice", alice.claims);
    for (const path of paths(aliceToken)) expect((await app.request(path)).status, path).not.toBe(401);
  });

  it("still takes any signed token without multi-user auth", async () => {
    configure({ enabled: false, users: [] });
    const { app, paths } = await workspaceApp();
    const token = await mods.authModule.createToken("admin", { role: "admin" });
    for (const path of paths(token)) expect((await app.request(path)).status, path).not.toBe(401);
    for (const path of paths("not-a-token")) expect((await app.request(path)).status, path).toBe(401);
  });
});

describe("the gateway's WebSocket handshakes", () => {
  it("resolve the caller against the stores: the dashboard socket and the browser view", { timeout: 45_000 }, async () => {
    const port = 19700 + Math.floor(Math.random() * 200);
    configure({ enabled: true, users: [root.record, alice.record] }, { port });
    const { createGateway } = await import("../gateway/index.js");
    const gateway = createGateway();
    await gateway.start();
    const ghostToken = await mods.authModule.createToken("ghost", testAccount("ghost").claims);
    const aliceToken = await mods.authModule.createToken("alice", alice.claims);

    const dashboard = (token: string) => new Promise<{ hello: boolean; code?: number }>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Authorization: `Bearer ${token}` } });
      socket.on("message", (data) => {
        if ((JSON.parse(String(data)) as { type?: string }).type === "hello-ok") {
          socket.close();
          resolve({ hello: true });
        }
      });
      socket.on("close", (code) => resolve({ hello: false, code }));
      socket.on("error", reject);
    });
    const browserView = (token: string) => new Promise<{ status?: number; code?: number }>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/browser-vnc/1?token=${token}`);
      socket.on("unexpected-response", (_req, res) => resolve({ status: res.statusCode }));
      socket.on("close", (code) => resolve({ code }));
      socket.on("error", () => { /* the unexpected-response or close settles it */ });
    });

    try {
      expect(await dashboard(ghostToken)).toEqual({ hello: false, code: 4401 });
      expect(await dashboard(aliceToken)).toEqual({ hello: true });
      expect(await browserView(ghostToken)).toEqual({ status: 401 });
      // A caller that resolves gets past the check, to a browser this test cannot reach.
      expect(await browserView(aliceToken)).not.toHaveProperty("status");
    } finally {
      await gateway.stop();
    }
  });
});
