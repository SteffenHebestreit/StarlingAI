import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import type { AuditEvent } from "../audit/schema.js";
import type { ComputerSessionSnapshot } from "../agent/computer-session.js";
import { PRODUCT } from "../product/index.js";
import { testAccount } from "./support/test-account.js";

/**
 * Computer-use and browser sessions belong to the person whose chat runs them.
 *
 * Every authenticated socket and token could list every computer session with its last frame and
 * the text of its windows, push itself a fresh frame of any of them, revive a paused one, read the
 * computer-use config (node hosts, the remote-access URL), and emergency-stop any session with an
 * audit record whose operator was whatever `reason` the client sent. Browser sessions (the page a
 * run is on, why it waits on a person) and their handoff were open the same way.
 *
 * Here a real HTTP server on loopback serves the session routes, and a real WebSocket on it reaches
 * RpcConnection as the gateway's /ws does under multi-user auth.
 */

const captureMock = vi.hoisted(() => vi.fn<(sessionId: string) => Promise<ComputerSessionSnapshot>>());

// A frame comes from an adapter (a desktop, an RDP host); the test has none, so capture is stubbed.
vi.mock("../agent/computer-adapters/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent/computer-adapters/runtime.js")>()),
  captureComputerSessionSnapshot: captureMock,
}));

const SECRET = "c".repeat(40);
const FILE_DIR = mkdtempSync(join(tmpdir(), "starlingai-computer-scoping-"));
const CONFIG_PATH = join(FILE_DIR, "starlingai.json");
const WORKSPACE = join(FILE_DIR, "workspace");

// What a frame of someone's desktop shows: none of it may reach another account.
const PRIVATE_FRAME = "data:image/png;base64,UFJJVkFURS1GUkFNRQ==";
const PRIVATE_TEXT = "Invoice 4711 for Jane Example";
const PRIVATE_WINDOW = "Accounting - Jane Example";

const opA = testAccount("ana");
const opB = testAccount("ben");
const root = testAccount("root", "admin");
const vic = testAccount("vic", "viewer");

let mods: Awaited<ReturnType<typeof loadModules>>;
let server: Server;
let wss: WebSocketServer;
let base = "";

async function loadModules() {
  writeFileSync(CONFIG_PATH, JSON.stringify({ gateway: { jwtSecret: SECRET } }), "utf8");
  process.env["SAI_CONFIG_PATH"] = CONFIG_PATH;
  process.env["SAI_MUTABLE_CONFIG_PATH"] = CONFIG_PATH;
  process.env["SAI_SESSION_STORE"] = join(FILE_DIR, "sessions.json");
  process.env["SAI_MASTER_KEY"] = "m".repeat(32);
  process.env["SAI_CRED_STORE"] = join(FILE_DIR, PRODUCT.stateDirName, "credentials.enc");
  process.env["SAI_AUDIT_LOG"] = join(FILE_DIR, "audit.jsonl");
  const [rpc, auth, loader, sessions, registry, routes, computer, browser, audit, tools, e2e] = await Promise.all([
    import("../gateway/rpc.js"),
    import("../gateway/auth.js"),
    import("../config/loader.js"),
    import("../agent/session.js"),
    import("../runtime/account-registry.js"),
    import("../gateway/session-dashboard-routes.js"),
    import("../agent/computer-session.js"),
    import("../agent/browser-session.js"),
    import("../audit/logger.js"),
    import("../tools/registry.js"),
    import("../e2e/services.js"),
  ]);
  // Registers computer_session_start, whose reuse of an open session moves its lease.
  await import("../tools/computer-use.js");
  return { rpc, auth, loader, sessions, registry, routes, computer, browser, audit, tools, e2e };
}

function configure(authEnabled: boolean): void {
  writeFileSync(CONFIG_PATH, JSON.stringify({
    gateway: { jwtSecret: SECRET },
    workspacePath: WORKSPACE,
    auth: authEnabled
      ? { enabled: true, users: [opA.record, opB.record, root.record, vic.record] }
      : { enabled: false },
    computerUse: {
      enabled: true,
      maxConcurrentSessions: 10,
      nodes: { "office-pc": { adapter: "remote_rdp", host: "10.10.0.2", port: 3389, protocol: "rdp" } },
    },
  }), "utf8");
  mods.loader.resetConfigForTests();
  mods.registry.resetAccountRegistryForTests();
  mods.auth.resetAuthStateForTests();
}

/** The gateway's /ws handshake under multi-user auth (gateway/index.ts), on a real socket. */
function attachRpcSocket(httpServer: Server): WebSocketServer {
  const sockets = new WebSocketServer({ noServer: true });
  sockets.on("connection", async (ws, req: IncomingMessage) => {
    const token = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("token");
    let conn: InstanceType<typeof mods.rpc.RpcConnection>;
    if (mods.loader.getConfig().auth?.enabled === true) {
      const user = token ? await mods.auth.authenticatedUserFromToken(token) : null;
      if (!user) { ws.close(4401, "Unauthorized"); return; }
      conn = new mods.rpc.RpcConnection(ws, user.username, user.role, user);
    } else {
      const payload = token ? await mods.auth.verifyToken(token) : null;
      if (!payload) { ws.close(4401, "Unauthorized"); return; }
      conn = new mods.rpc.RpcConnection(ws, payload.sub, typeof payload["role"] === "string" ? payload["role"] : undefined);
    }
    ws.on("message", (raw) => { void conn.handleMessage(raw.toString()); });
    ws.on("close", () => conn.close());
  });
  httpServer.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://127.0.0.1").pathname !== "/ws") { socket.destroy(); return; }
    sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit("connection", ws, req));
  });
  return sockets;
}

/** Hono over node:http, as the gateway forwards /api requests to it. */
function honoListener(app: Hono) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(key, value);
    const body = chunks.length > 0 && req.method !== "GET" ? Buffer.concat(chunks) : undefined;
    const response = await app.fetch(new Request(`http://127.0.0.1${req.url ?? "/"}`, { method: req.method, headers, body }));
    const outgoing: Record<string, string> = {};
    response.headers.forEach((value, key) => { outgoing[key] = value; });
    res.writeHead(response.status, outgoing);
    res.end(Buffer.from(await response.arrayBuffer()));
  };
}

beforeAll(async () => {
  mods = await loadModules();
  const app = new Hono();
  mods.routes.registerSessionDashboardRoutes(app);
  server = createServer(honoListener(app));
  wss = attachRpcSocket(server);
  // Loopback only: these sockets carry test tokens.
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const client of wss.clients) client.terminate();
  wss.close();
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const key of ["SAI_CONFIG_PATH", "SAI_MUTABLE_CONFIG_PATH", "SAI_SESSION_STORE", "SAI_MASTER_KEY", "SAI_CRED_STORE", "SAI_AUDIT_LOG"]) delete process.env[key];
  rmSync(FILE_DIR, { recursive: true, force: true });
});

let auditEvents: AuditEvent[] = [];
let stopAudit: (() => void) | undefined;
const openSockets: WebSocket[] = [];

beforeEach(() => {
  auditEvents = [];
  stopAudit = mods.audit.subscribeToAudit((event) => { auditEvents.push(event); });
  captureMock.mockReset();
  captureMock.mockImplementation(async (sessionId) => {
    const snapshot: ComputerSessionSnapshot = {
      screenshotHash: "hash",
      frameId: `frame-${sessionId.slice(0, 4)}`,
      timestamp: Date.now(),
      dataUrl: PRIVATE_FRAME,
      width: 1280,
      height: 800,
      accessibilityTree: PRIVATE_TEXT,
      activeWindow: { title: PRIVATE_WINDOW, processName: "erp.exe", bounds: { x: 0, y: 0, width: 1280, height: 800 } },
    };
    mods.computer.computerSessionManager.updateSnapshot(sessionId, snapshot);
    return snapshot;
  });
});

afterEach(async () => {
  for (const ws of openSockets.splice(0)) ws.terminate();
  stopAudit?.();
  mods.computer.computerSessionManager.resetForTests();
  mods.browser.browserSessionManager.resetForTests();
  await mods.audit.flushAuditLog();
  mods.sessions.resetSessionsForTests();
  mods.registry.resetAccountRegistryForTests();
  mods.loader.resetConfigForTests();
  mods.auth.resetAuthStateForTests();
});

type Account = ReturnType<typeof testAccount>;

async function tokenOf(username: string, account: Account): Promise<string> {
  return mods.auth.createToken(username, account.claims);
}

/** A dashboard socket of `username`, on the real /ws. */
async function openSocket(username: string, account: Account) {
  const ws = new WebSocket(`ws://${base}/ws?token=${encodeURIComponent(await tokenOf(username, account))}`);
  openSockets.push(ws);
  const received: Array<{ type: string; id?: string; ok?: boolean; payload?: unknown; error?: string; data?: unknown }> = [];
  const waiters: Array<() => void> = [];
  ws.on("message", (raw) => {
    received.push(JSON.parse(raw.toString()));
    for (const wake of waiters.splice(0)) wake();
  });
  const until = async <T>(pick: () => T | undefined): Promise<T> => {
    for (;;) {
      const found = pick();
      if (found !== undefined) return found;
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };
  await until(() => received.find((message) => message.type === "hello-ok"));
  let counter = 0;
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const id = `${method}-${++counter}`;
    ws.send(JSON.stringify({ id, method, params }));
    return until(() => received.find((message) => message.type === "rpc.response" && message.id === id));
  };
  const screenshots = () => received.filter((message) => message.type === "computer.screenshot");
  return { call, screenshots };
}

async function rest(method: string, path: string, username: string, account: Account, body?: unknown) {
  const response = await fetch(`http://${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await tokenOf(username, account)}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json() as unknown };
}

/** A chat of `username` and a computer session whose lease a computer-agent run of that chat holds. */
function startComputerSessionFor(username: string, account: Account) {
  const chat = mods.sessions.createSession({ channel: "webchat", userId: username, account: account.id, workspacePath: WORKSPACE });
  const manager = mods.computer.computerSessionManager;
  // The lease is held by the sub-agent run, as computer_session_start records ctx.sessionId.
  const session = manager.startSession("remote_rdp", `sub:${chat.id}:computer_agent:1790000000000`, { nodeId: "office-pc" });
  manager.activateSession(session.id, { monitors: [{ id: 0, x: 0, y: 0, width: 1280, height: 800, dpiScale: 1 }], primary: 0 });
  manager.updateSnapshot(session.id, {
    screenshotHash: "hash",
    frameId: "frame-0",
    timestamp: Date.now(),
    dataUrl: PRIVATE_FRAME,
    accessibilityTree: PRIVATE_TEXT,
    activeWindow: { title: PRIVATE_WINDOW, processName: "erp.exe", bounds: { x: 0, y: 0, width: 1280, height: 800 } },
  });
  return { chat, session };
}

function idsOf(list: unknown): string[] {
  return (list as Array<{ id: string }>).map((entry) => entry.id).sort();
}

function entryFor(list: unknown, id: string): Record<string, unknown> {
  return (list as Array<Record<string, unknown>>).find((entry) => entry["id"] === id)!;
}

function expectRestricted(entry: Record<string, unknown>): void {
  expect(entry["restricted"]).toBe(true);
  expect(entry).not.toHaveProperty("lastSnapshot");
  expect(entry).not.toHaveProperty("leaseOwner");
  expect(Object.keys(entry).sort()).toEqual(expect.arrayContaining(["adapter", "createdAt", "id", "state"]));
}

function expectWhole(entry: Record<string, unknown>): void {
  expect(entry).not.toHaveProperty("restricted");
  expect((entry["lastSnapshot"] as { dataUrl?: string }).dataUrl).toBe(PRIVATE_FRAME);
  expect(entry["leaseOwner"]).toMatch(/^sub:/);
}

/** An emergency-stopped session as its owner (or an admin) sees it: its last frame, and whose lease the stop revoked. */
function expectWholeStopped(entry: Record<string, unknown>): void {
  expect(entry).not.toHaveProperty("restricted");
  expect(entry).toMatchObject({ state: "stopped", leaseOwner: "" });
  expect((entry["lastSnapshot"] as { dataUrl?: string }).dataUrl).toBe(PRIVATE_FRAME);
  expect(entry["revokedLeaseOwner"]).toMatch(/^sub:/);
}

/** What a tool call of a computer-agent run of `username`'s chat carries. */
function runContext(sessionId: string, username: string, account: Account) {
  return {
    sessionId,
    workspacePath: WORKSPACE,
    userId: username,
    identity: { userId: username, ...(account.id ? { account: account.id } : {}) },
    approvalCallback: async () => true,
  };
}

describe("computer sessions under multi-user auth", () => {
  it("lists a caller's own sessions whole, others' to an operator without frames, window text or lease owner, and none to a viewer", async () => {
    configure(true);
    const anas = startComputerSessionFor("ana", opA).session;
    const roots = startComputerSessionFor("root", root).session;
    const vics = startComputerSessionFor("vic", vic).session;
    const all = [anas.id, roots.id, vics.id].sort();

    for (const path of ["/api/computer-sessions", "/api/computer-sessions/active"]) {
      const ana = await rest("GET", path, "ana", opA);
      expect(ana.status).toBe(200);
      expect(idsOf(ana.json)).toEqual(all);
      expectWhole(entryFor(ana.json, anas.id));
      expectRestricted(entryFor(ana.json, roots.id));
      expectRestricted(entryFor(ana.json, vics.id));
      expect(entryFor(ana.json, roots.id)).toMatchObject({ adapter: "remote_rdp", nodeId: "office-pc", state: "active" });

      const ben = await rest("GET", path, "ben", opB);
      expect(idsOf(ben.json)).toEqual(all);
      for (const entry of ben.json as Array<Record<string, unknown>>) expectRestricted(entry);
      const benText = JSON.stringify(ben.json);
      for (const secret of [PRIVATE_FRAME, PRIVATE_TEXT, PRIVATE_WINDOW, "sub:"]) expect(benText).not.toContain(secret);

      const admin = await rest("GET", path, "root", root);
      for (const id of all) expectWhole(entryFor(admin.json, id));

      // A viewer sees its own session, whole, and nobody else's.
      const viewer = await rest("GET", path, "vic", vic);
      expect(idsOf(viewer.json)).toEqual([vics.id]);
      expectWhole(entryFor(viewer.json, vics.id));
    }

    // The socket lists the same.
    const benSocket = await openSocket("ben", opB);
    const listed = await benSocket.call("computer.list_sessions");
    expect(listed.ok).toBe(true);
    const sessions = (listed.payload as { sessions: unknown }).sessions;
    expect(idsOf(sessions)).toEqual(all);
    for (const entry of sessions as Array<Record<string, unknown>>) expectRestricted(entry);
    expect(JSON.stringify(sessions)).not.toContain(PRIVATE_TEXT);

    const anaSocket = await openSocket("ana", opA);
    const own = (await anaSocket.call("computer.list_sessions")).payload as { sessions: unknown };
    expectWhole(entryFor(own.sessions, anas.id));
    expectRestricted(entryFor(own.sessions, roots.id));

    const vicSocket = await openSocket("vic", vic);
    expect(idsOf(((await vicSocket.call("computer.list_sessions")).payload as { sessions: unknown }).sessions)).toEqual([vics.id]);
  });

  it("sends a fresh frame only to the session's owner or an admin", async () => {
    configure(true);
    const anas = startComputerSessionFor("ana", opA).session;

    const ben = await openSocket("ben", opB);
    expect((await ben.call("computer.request_screenshot", { computerSessionId: anas.id })).payload)
      .toEqual({ ok: false, error: `No active session: ${anas.id}` });
    // Refused before the desktop is touched, and answered as an unknown id is.
    expect(captureMock).not.toHaveBeenCalled();
    expect((await ben.call("computer.request_screenshot", { computerSessionId: "no-such-session" })).payload)
      .toEqual({ ok: false, error: "No active session: no-such-session" });
    // A viewer is refused the method itself, before any session rule: it needs operator rank
    // (gateway/rpc-policy.ts).
    const viewer = await openSocket("vic", vic);
    expect(await viewer.call("computer.request_screenshot", { computerSessionId: anas.id }))
      .toMatchObject({ ok: false, error: "Forbidden: computer.request_screenshot requires role operator" });

    const ana = await openSocket("ana", opA);
    expect((await ana.call("computer.request_screenshot", { computerSessionId: anas.id })).payload).toEqual({ ok: true });
    expect(ana.screenshots()).toHaveLength(1);
    expect(ana.screenshots()[0]!.data).toMatchObject({ computerSessionId: anas.id, dataUrl: PRIVATE_FRAME });

    const admin = await openSocket("root", root);
    expect((await admin.call("computer.request_screenshot", { computerSessionId: anas.id })).payload).toEqual({ ok: true });
    expect(admin.screenshots()).toHaveLength(1);

    // Ben's socket got no frame of it at any point.
    expect(ben.screenshots()).toEqual([]);
    expect(viewer.screenshots()).toEqual([]);
    expect(captureMock).toHaveBeenCalledTimes(2);
  });

  it("drops a frame whose session changed hands while it was taken", async () => {
    configure(true);
    const anas = startComputerSessionFor("ana", opA).session;
    const bensChat = mods.sessions.createSession({ channel: "webchat", userId: "ben", account: opB.id, workspacePath: WORKSPACE });
    const take = captureMock.getMockImplementation()!;
    // Ben's agent takes the lease over (computer_session_start with force) during Ana's capture.
    captureMock.mockImplementationOnce(async (sessionId) => {
      mods.computer.computerSessionManager.attachSession(sessionId, `sub:${bensChat.id}:computer_agent:1790000000001`, true);
      return take(sessionId);
    });

    const ana = await openSocket("ana", opA);
    expect((await ana.call("computer.request_screenshot", { computerSessionId: anas.id })).payload)
      .toEqual({ ok: false, error: `No active session: ${anas.id}` });
    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(ana.screenshots()).toEqual([]);
  });

  it("lets only the owner or an admin read a session or keep it alive", async () => {
    configure(true);
    const anas = startComputerSessionFor("ana", opA).session;
    const live = mods.computer.computerSessionManager.getSession(anas.id)!;
    const pause = () => { live.state = "paused"; };

    // GET /:id: another operator and a viewer get the reply an unknown id gets.
    for (const [name, account] of [["ben", opB], ["vic", vic]] as const) {
      const refused = await rest("GET", `/api/computer-sessions/${anas.id}`, name, account);
      expect(refused).toMatchObject({ status: 404, json: { error: "Session not found" } });
    }
    expect(await rest("GET", "/api/computer-sessions/no-such-session", "ben", opB)).toMatchObject({ status: 404, json: { error: "Session not found" } });
    const own = await rest("GET", `/api/computer-sessions/${anas.id}`, "ana", opA);
    expect(own.status).toBe(200);
    expectWhole(own.json as Record<string, unknown>);
    expect((await rest("GET", `/api/computer-sessions/${anas.id}`, "root", root)).status).toBe(200);

    // A heartbeat revives a paused session: not another account's.
    pause();
    const ben = await openSocket("ben", opB);
    expect((await ben.call("computer.heartbeat", { computerSessionId: anas.id })).payload)
      .toEqual({ ok: false, error: `Session not found: ${anas.id}` });
    expect(await rest("POST", `/api/computer-sessions/${anas.id}/heartbeat`, "ben", opB))
      .toMatchObject({ status: 404, json: { error: "Session not found" } });
    expect(live.state).toBe("paused");

    const ana = await openSocket("ana", opA);
    expect((await ana.call("computer.heartbeat", { computerSessionId: anas.id })).payload).toEqual({ ok: true });
    expect(live.state).toBe("active");

    pause();
    expect(await rest("POST", `/api/computer-sessions/${anas.id}/heartbeat`, "root", root)).toMatchObject({ status: 200, json: { ok: true } });
    expect(live.state).toBe("active");
  });

  it("lets any operator stop any session, refuses a viewer, and audits the caller rather than the reason", async () => {
    configure(true);
    const anas = startComputerSessionFor("ana", opA).session;
    const roots = startComputerSessionFor("root", root).session;
    const manager = mods.computer.computerSessionManager;

    const viewer = await openSocket("vic", vic);
    const refused = await viewer.call("computer.emergency_stop", { computerSessionId: anas.id, reason: "root" });
    expect(refused).toMatchObject({ ok: false, error: "Forbidden: computer.emergency_stop requires role operator" });
    expect(await rest("POST", `/api/computer-sessions/${roots.id}/emergency-stop`, "vic", vic, { reason: "x" }))
      .toMatchObject({ status: 403, json: { error: "Operator role required for this action" } });
    expect(manager.getSession(anas.id)!.state).toBe("active");
    expect(manager.getSession(roots.id)!.state).toBe("active");
    expect(auditEvents.filter((event) => event.type === "computer_session_emergency_stop")).toEqual([]);

    // Ben owns neither session, and may stop both: the reason he sends names someone else.
    const ben = await openSocket("ben", opB);
    expect((await ben.call("computer.emergency_stop", { computerSessionId: anas.id, reason: "root" })).payload).toEqual({ ok: true });
    expect(manager.getSession(anas.id)!.state).toBe("stopped");

    const longReason = `${"stop ".repeat(100)}now`;
    expect(await rest("POST", `/api/computer-sessions/${roots.id}/emergency-stop`, "ben", opB, { reason: longReason }))
      .toMatchObject({ status: 200, json: { ok: true } });
    expect(manager.getSession(roots.id)!.state).toBe("stopped");

    const stops = auditEvents.filter((event) => event.type === "computer_session_emergency_stop");
    expect(stops.map((event) => event.data)).toEqual([
      { sessionId: anas.id, actor: { userId: "ben", account: opB.id }, role: "operator", via: "rpc", reason: "root" },
      { sessionId: roots.id, actor: { userId: "ben", account: opB.id }, role: "operator", via: "rest", reason: longReason.slice(0, 200) },
    ]);
    for (const event of stops) {
      expect(event.userId).toBe("ben");
      expect(event.data).not.toHaveProperty("operator");
    }

    // The stop revokes the lease and keeps the last frame. That frame stays its owner's: Ben, who
    // pulled both stops, sees no more of either session than before.
    const benListing = await rest("GET", "/api/computer-sessions", "ben", opB);
    expect(idsOf(benListing.json)).toEqual([anas.id, roots.id].sort());
    for (const entry of benListing.json as Array<Record<string, unknown>>) {
      expectRestricted(entry);
      expect(entry).not.toHaveProperty("revokedLeaseOwner");
    }
    for (const secret of [PRIVATE_FRAME, PRIVATE_TEXT, PRIVATE_WINDOW, "sub:"]) expect(JSON.stringify(benListing.json)).not.toContain(secret);
    const benSocketListing = ((await ben.call("computer.list_sessions")).payload as { sessions: Array<Record<string, unknown>> }).sessions;
    for (const entry of benSocketListing) expectRestricted(entry);
    for (const id of [anas.id, roots.id]) {
      expect(await rest("GET", `/api/computer-sessions/${id}`, "ben", opB)).toMatchObject({ status: 404, json: { error: "Session not found" } });
    }

    // Ana still has her own stopped session whole, and not as "another user's".
    const anaListing = await rest("GET", "/api/computer-sessions", "ana", opA);
    expectWholeStopped(entryFor(anaListing.json, anas.id));
    expectRestricted(entryFor(anaListing.json, roots.id));
    const anaRead = await rest("GET", `/api/computer-sessions/${anas.id}`, "ana", opA);
    expect(anaRead.status).toBe(200);
    expectWholeStopped(anaRead.json as Record<string, unknown>);

    const adminListing = await rest("GET", "/api/computer-sessions", "root", root);
    for (const id of [anas.id, roots.id]) expectWholeStopped(entryFor(adminListing.json, id));
  });

  it("refuses a viewer every stop, heartbeat and fresh frame, its own sessions included; an operator stops them", async () => {
    configure(true);
    const vics = startComputerSessionFor("vic", vic).session;
    const manager = mods.computer.computerSessionManager;
    const live = manager.getSession(vics.id)!;

    // REST: under multi-user auth the gateway's role gate refuses every REST POST of a viewer.
    expect(await rest("POST", `/api/computer-sessions/${vics.id}/emergency-stop`, "vic", vic, { reason: "runaway" }))
      .toMatchObject({ status: 403, json: { error: "Operator role required for this action" } });
    expect(live.state).toBe("active");

    // The socket draws the same line: the methods that drive a session need operator rank
    // (gateway/rpc-policy.ts), and the refusal comes before any session rule, for its own session too.
    const socket = await openSocket("vic", vic);
    expect(await socket.call("computer.emergency_stop", { computerSessionId: vics.id, reason: "runaway" }))
      .toMatchObject({ ok: false, error: "Forbidden: computer.emergency_stop requires role operator" });
    expect(live.state).toBe("active");
    live.state = "paused";
    expect(await socket.call("computer.heartbeat", { computerSessionId: vics.id }))
      .toMatchObject({ ok: false, error: "Forbidden: computer.heartbeat requires role operator" });
    expect(live.state).toBe("paused");
    expect(await socket.call("computer.request_screenshot", { computerSessionId: vics.id }))
      .toMatchObject({ ok: false, error: "Forbidden: computer.request_screenshot requires role operator" });
    expect(captureMock).not.toHaveBeenCalled();
    expect(socket.screenshots()).toEqual([]);
    expect(auditEvents.filter((event) => event.type === "computer_session_emergency_stop")).toEqual([]);
    expect(auditEvents.filter((event) => event.type === "rbac_denied" && event.data["surface"] === "rpc").map((event) => event.data)).toEqual([
      expect.objectContaining({ method: "computer.emergency_stop", role: "viewer", required: "operator" }),
      expect.objectContaining({ method: "computer.heartbeat", role: "viewer", required: "operator" }),
      expect.objectContaining({ method: "computer.request_screenshot", role: "viewer", required: "operator" }),
    ]);

    // It still sees its own session whole.
    const listed = ((await socket.call("computer.list_sessions")).payload as { sessions: unknown }).sessions;
    expect(idsOf(listed)).toEqual([vics.id]);
    expectWhole(entryFor(listed, vics.id));

    // A runaway agent in a viewer's chat is stopped by an operator, who may stop any session; the
    // stopped session stays the viewer's, whole.
    const ben = await openSocket("ben", opB);
    expect((await ben.call("computer.emergency_stop", { computerSessionId: vics.id, reason: "runaway" })).payload).toEqual({ ok: true });
    expect(live.state).toBe("stopped");
    expect(auditEvents.filter((event) => event.type === "computer_session_emergency_stop").map((event) => event.data)).toEqual([
      { sessionId: vics.id, actor: { userId: "ben", account: opB.id }, role: "operator", via: "rpc", reason: "runaway" },
    ]);
    const after = ((await socket.call("computer.list_sessions")).payload as { sessions: unknown }).sessions;
    expectWholeStopped(entryFor(after, vics.id));
  });

  it("lets a role that an extension's rpcPolicies opens computer.emergency_stop to stop only a session of its own", async () => {
    configure(true);
    const anas = startComputerSessionFor("ana", opA).session;
    const vics = startComputerSessionFor("vic", vic).session;
    const manager = mods.computer.computerSessionManager;

    // A fork may open the method to a role below operator (rpcPolicies); the session rule then decides.
    const policy = await import("../gateway/rpc-policy.js");
    policy.registerRpcPolicies("fork-extension", [{ method: "computer.emergency_stop", roles: ["viewer"] }]);
    try {
      const socket = await openSocket("vic", vic);
      expect(await socket.call("computer.emergency_stop", { computerSessionId: anas.id, reason: "root" }))
        .toMatchObject({ ok: false, error: expect.stringContaining("Operator role required for this action") });
      expect(manager.getSession(anas.id)!.state).toBe("active");

      expect((await socket.call("computer.emergency_stop", { computerSessionId: vics.id, reason: "runaway" })).payload).toEqual({ ok: true });
      expect(manager.getSession(vics.id)!.state).toBe("stopped");
      expect(auditEvents.filter((event) => event.type === "computer_session_emergency_stop").map((event) => event.data)).toEqual([
        { sessionId: vics.id, actor: { userId: "vic", account: vic.id }, role: "viewer", via: "rpc", reason: "runaway" },
      ]);
    } finally {
      policy._resetRpcPoliciesForTests();
    }
  });

  it("keeps a session no run holds to admins", async () => {
    configure(true);
    const anas = startComputerSessionFor("ana", opA).session;
    // Released (detachSession): nobody's session now, its last frame included.
    mods.computer.computerSessionManager.detachSession(anas.id);

    for (const [name, account] of [["ana", opA], ["ben", opB]] as const) {
      const listing = await rest("GET", "/api/computer-sessions", name, account);
      expectRestricted(entryFor(listing.json, anas.id));
      expect(JSON.stringify(listing.json)).not.toContain(PRIVATE_FRAME);
      expect(await rest("GET", `/api/computer-sessions/${anas.id}`, name, account)).toMatchObject({ status: 404, json: { error: "Session not found" } });
    }
    expect(idsOf((await rest("GET", "/api/computer-sessions", "vic", vic)).json)).toEqual([]);
    const ana = await openSocket("ana", opA);
    expect((await ana.call("computer.request_screenshot", { computerSessionId: anas.id })).payload)
      .toEqual({ ok: false, error: `No active session: ${anas.id}` });
    expect(captureMock).not.toHaveBeenCalled();

    const admin = await rest("GET", `/api/computer-sessions/${anas.id}`, "root", root);
    expect(admin.status).toBe(200);
    expect((admin.json as { lastSnapshot: { dataUrl: string } }).lastSnapshot.dataUrl).toBe(PRIVATE_FRAME);
  });

  it("records a stop the gateway makes itself as a system stop, the old string form included", async () => {
    configure(true);
    const manager = mods.computer.computerSessionManager;
    const first = startComputerSessionFor("ana", opA).session;
    const second = startComputerSessionFor("ana", opA).session;

    manager.emergencyStop(first.id, { via: "system" }, "warden:clipboard_exfiltration");
    // A caller still on the old signature passed its reason where the operator went.
    manager.emergencyStop(second.id, "adapter_initialization_failed");

    const stops = auditEvents.filter((event) => event.type === "computer_session_emergency_stop");
    expect(stops.map((event) => event.data)).toEqual([
      { sessionId: first.id, via: "system", reason: "warden:clipboard_exfiltration" },
      { sessionId: second.id, via: "system", reason: "adapter_initialization_failed" },
    ]);
    expect(stops.map((event) => event.userId)).toEqual([undefined, undefined]);
  });

  it("keeps the computer-use config (node hosts, credential names) to admins, and tells anyone else only whether it is on", async () => {
    configure(true);
    for (const [name, account] of [["ana", opA], ["vic", vic]] as const) {
      // Exactly { enabled }: no nodes, hosts, ports, remote-access URL or credential names.
      expect(await rest("GET", "/api/computer-sessions/config", name, account)).toEqual({ status: 200, json: { enabled: true } });
    }
    const admin = await rest("GET", "/api/computer-sessions/config", "root", root);
    expect(admin.status).toBe(200);
    expect(admin.json).toMatchObject({ enabled: true, nodes: { "office-pc": { host: "10.10.0.2", port: 3389 } } });

    // The e2e harness's computer-desktop probe reads this route as its "eval" account, an operator:
    // a refusal would skip every scenario that requires a desktop.
    const prober = new mods.e2e.ServiceProber({
      gatewayUrl: `http://${base}`,
      authedGet: async (path) => {
        const reply = await rest("GET", path, "ben", opB);
        return { status: reply.status, ok: reply.status >= 200 && reply.status < 300, text: JSON.stringify(reply.json), json: reply.json };
      },
    });
    expect(await prober.check(["computer-desktop"])).toEqual([expect.objectContaining({ service: "computer-desktop", up: true })]);
  });
});

describe("computer-session leases under multi-user auth", () => {
  it("hands a sub-run's lease back only to its own parent chat, not to a chat whose id begins the same", async () => {
    configure(true);
    const manager = mods.computer.computerSessionManager;
    // Ids a client may start chats under (clientMayCreateSessionId): Ben's "a" begins Ana's "ab".
    mods.sessions.createSession({ sessionId: "a", channel: "webchat", userId: "ben", account: opB.id, workspacePath: WORKSPACE });
    mods.sessions.createSession({ sessionId: "ab", channel: "webchat", userId: "ana", account: opA.id, workspacePath: WORKSPACE });
    const anaLease = "sub:ab:computer_agent:1790000000000";
    const benLease = "sub:a:computer_agent:1790000000001";
    // An ephemeral agent's name carries a colon of its own (agent/session-ids.ts).
    const benEphemeralLease = "sub:a:ephemeral:desk_helper:1790000000002";
    const anas = manager.startSession("remote_rdp", anaLease, { nodeId: "office-pc" });
    const bens = manager.startSession("remote_rdp", benLease, { nodeId: "office-pc" });
    const bensEphemeral = manager.startSession("remote_rdp", benEphemeralLease, { nodeId: "office-pc" });
    for (const session of [anas, bens, bensEphemeral]) manager.activateSession(session.id);

    // A sub-run of Ben's chat "a" ends: agent/sub-agent.ts hands its chat's leases back to "a".
    expect(manager.returnSubRunLeases("a")).toEqual([
      { sessionId: bens.id, from: benLease },
      { sessionId: bensEphemeral.id, from: benEphemeralLease },
    ]);
    expect(manager.getSession(bens.id)!.leaseOwner).toBe("a");
    expect(manager.getSession(bensEphemeral.id)!.leaseOwner).toBe("a");
    expect(manager.getSession(anas.id)!.leaseOwner).toBe(anaLease);
    // So Ben does not get Ana's desktop through it.
    expect((await rest("GET", `/api/computer-sessions/${anas.id}`, "ben", opB)).status).toBe(404);
    expect((await rest("GET", `/api/computer-sessions/${anas.id}`, "ana", opA)).status).toBe(200);
  });

  it("reuses a session open on a shared node only for a run of the same account", async () => {
    configure(true);
    const manager = mods.computer.computerSessionManager;
    const anas = startComputerSessionFor("ana", opA).session;
    // computer_session_start opens the 15-minute auto-approve window on every start and reuse.
    manager.refreshLeaseAutoApprove(anas.id);
    const anaLease = manager.getSession(anas.id)!.leaseOwner;

    // Ben's agent wants the same node (shared: no allowedUsers) inside that window.
    const bensChat = mods.sessions.createSession({ channel: "webchat", userId: "ben", account: opB.id, workspacePath: WORKSPACE });
    const benRun = runContext(`sub:${bensChat.id}:computer_agent:1790000000003`, "ben", opB);
    const refused = await mods.tools.executeTool("computer_session_start", { node: "office-pc" }, benRun);
    expect(refused.success).toBe(false);
    expect(refused.error).toContain("is already open");
    expect(manager.getSession(anas.id)!.leaseOwner).toBe(anaLease);
    expect((await rest("GET", `/api/computer-sessions/${anas.id}`, "ben", opB)).status).toBe(404);

    // Another chat of Ana's still picks it up.
    const anasOtherChat = mods.sessions.createSession({ channel: "webchat", userId: "ana", account: opA.id, workspacePath: WORKSPACE });
    const anaRun = runContext(`sub:${anasOtherChat.id}:computer_agent:1790000000004`, "ana", opA);
    const reused = await mods.tools.executeTool("computer_session_start", { node: "office-pc" }, anaRun);
    expect(reused).toMatchObject({ success: true, metadata: { sessionId: anas.id, reused: true } });
    expect(manager.getSession(anas.id)!.leaseOwner).toBe(anaRun.sessionId);
  });
});

describe("browser sessions under multi-user auth", () => {
  function browserRunFor(username: string, account: Account) {
    const chat = mods.sessions.createSession({ channel: "webchat", userId: username, account: account.id, workspacePath: WORKSPACE });
    const runSessionId = `sub:${chat.id}:browser_agent:1790000000000`;
    const session = mods.browser.browserSessionManager.register({ agentName: "browser_agent", parentSessionId: runSessionId, runSessionId, page: `${username}'s bank login` });
    return session;
  }

  it("shows a browser run, and takes its handoff, only from the owner of its chat or an admin", async () => {
    configure(true);
    const anas = browserRunFor("ana", opA);
    const roots = browserRunFor("root", root);
    const browser = mods.browser.browserSessionManager;
    void browser.requestAssist(anas.id, "Solve the CAPTCHA on the login form", { timeoutMs: 60_000 });

    for (const path of ["/api/browser-sessions", "/api/browser-sessions/active"]) {
      expect(idsOf((await rest("GET", path, "ana", opA)).json)).toEqual([anas.id]);
      expect(idsOf((await rest("GET", path, "ben", opB)).json)).toEqual([]);
      expect(idsOf((await rest("GET", path, "vic", vic)).json)).toEqual([]);
      expect(idsOf((await rest("GET", path, "root", root)).json)).toEqual([anas.id, roots.id].sort());
    }

    expect(await rest("GET", `/api/browser-sessions/${anas.id}`, "ben", opB)).toMatchObject({ status: 404, json: { error: "Session not found" } });
    expect(await rest("GET", `/api/browser-sessions/${anas.id}`, "ana", opA)).toMatchObject({ status: 200, json: { id: anas.id, state: "assist_requested" } });
    expect((await rest("GET", `/api/browser-sessions/${anas.id}`, "root", root)).status).toBe(200);

    // Another operator cannot answer the handoff, and a viewer may change nothing.
    expect(await rest("POST", `/api/browser-sessions/${anas.id}/resolve-assist`, "ben", opB)).toMatchObject({ status: 404, json: { error: "Session not found" } });
    expect(await rest("POST", `/api/browser-sessions/${anas.id}/resolve-assist`, "vic", vic)).toMatchObject({ status: 403 });
    expect(browser.getSession(anas.id)!.state).toBe("assist_requested");

    expect(await rest("POST", `/api/browser-sessions/${anas.id}/resolve-assist`, "ana", opA)).toMatchObject({ status: 200, json: { ok: true } });
    expect(browser.getSession(anas.id)!.state).toBe("active_resolved");
    const resolved = auditEvents.filter((event) => event.type === "browser_session_assist_resolved");
    expect(resolved.map((event) => event.data)).toEqual([
      { sessionId: anas.id, operator: "ana", actor: { userId: "ana", account: opA.id }, role: "operator", via: "rest" },
    ]);
  });

  it("keeps a browser run no chat delegated to admins", async () => {
    configure(true);
    const browser = mods.browser.browserSessionManager;
    const orphan = browser.register({ agentName: "browser_agent", runSessionId: "orphan-run", page: "unattended login" });
    void browser.requestAssist(orphan.id, "Solve the CAPTCHA", { timeoutMs: 60_000 });

    for (const [name, account] of [["ana", opA], ["ben", opB], ["vic", vic]] as const) {
      expect(idsOf((await rest("GET", "/api/browser-sessions", name, account)).json)).toEqual([]);
      expect(await rest("GET", `/api/browser-sessions/${orphan.id}`, name, account)).toMatchObject({ status: 404, json: { error: "Session not found" } });
    }
    expect(await rest("POST", `/api/browser-sessions/${orphan.id}/resolve-assist`, "ana", opA)).toMatchObject({ status: 404 });
    expect(browser.getSession(orphan.id)!.state).toBe("assist_requested");

    expect(idsOf((await rest("GET", "/api/browser-sessions", "root", root)).json)).toEqual([orphan.id]);
    expect(await rest("GET", `/api/browser-sessions/${orphan.id}`, "root", root)).toMatchObject({ status: 200, json: { id: orphan.id } });
  });
});

describe("with auth off", () => {
  it("leaves the single operator every session, whole, as before", async () => {
    configure(false);
    const anas = startComputerSessionFor("ana", opA).session;
    const token: Account = { id: "", record: {}, claims: { role: "operator" } };
    const listed = await rest("GET", "/api/computer-sessions", "operator", token);
    expectWhole(entryFor(listed.json, anas.id));
    expect((await rest("GET", `/api/computer-sessions/${anas.id}`, "operator", token)).status).toBe(200);
    expect((await rest("GET", "/api/computer-sessions/config", "operator", token)).status).toBe(200);

    const socket = await openSocket("operator", token);
    expect((await socket.call("computer.request_screenshot", { computerSessionId: anas.id })).payload).toEqual({ ok: true });
    expect((await socket.call("computer.emergency_stop", { computerSessionId: anas.id })).payload).toEqual({ ok: true });
    const stop = auditEvents.find((event) => event.type === "computer_session_emergency_stop");
    expect(stop?.data).toEqual({ sessionId: anas.id, actor: { userId: "operator" }, role: "operator", via: "rpc", reason: "rpc:manual_stop" });
  });

  it("still lets another chat reuse a session open on the same node", async () => {
    configure(false);
    const manager = mods.computer.computerSessionManager;
    const anas = startComputerSessionFor("ana", opA).session;
    manager.refreshLeaseAutoApprove(anas.id);
    const otherChat = mods.sessions.createSession({ channel: "webchat", workspacePath: WORKSPACE });
    const run = { sessionId: `sub:${otherChat.id}:computer_agent:1790000000005`, workspacePath: WORKSPACE, approvalCallback: async () => true };
    const reused = await mods.tools.executeTool("computer_session_start", { node: "office-pc" }, run);
    expect(reused).toMatchObject({ success: true, metadata: { sessionId: anas.id, reused: true } });
    expect(manager.getSession(anas.id)!.leaseOwner).toBe(run.sessionId);
  });
});
