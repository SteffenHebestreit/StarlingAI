import { EventEmitter } from "node:events";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunTurnOptions, TurnOutput } from "../agent/turn-types.js";
import type { Identity } from "../runtime/accounts.js";
import { bootstrapClaims, testAccount, type TestAccount } from "./support/test-account.js";

/**
 * A session is its owner's by identity, not by name (S3, runtime/user-scope.ts ownsRecord).
 *
 * Every session check compared usernames: the /api/sessions routes, the dashboard socket's list,
 * open, send and audit stream, the AG-UI stream, session search and the user-input broker. An
 * account deleted and created again under the same name therefore listed, read and drove every
 * chat the old account left; so did any caller whose name a channel sender's session carried. The
 * re-created "alice" below holds a token bound to her own new id; the old alice's records carry the
 * old one.
 */

const runTurnMock = vi.hoisted(() => vi.fn<(opts: RunTurnOptions) => Promise<TurnOutput>>());

// The turn is stubbed: what these pin is whether one starts at all.
vi.mock("../agent/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent/runtime.js")>()),
  runTurn: runTurnMock,
}));

const SECRET = "o".repeat(40);
// The config loader fixes its file when it loads, so the modules load once for this file and each
// test writes its configuration to that one file.
const FILE_DIR = mkdtempSync(join(tmpdir(), "starlingai-ownership-sessions-file-"));
const CONFIG_PATH = join(FILE_DIR, "starlingai.json");
const dirs: string[] = [];
let workspace = "";
let mods: Awaited<ReturnType<typeof loadModules>>;

async function loadModules() {
  writeFileSync(CONFIG_PATH, JSON.stringify({ gateway: { jwtSecret: SECRET } }), "utf8");
  process.env["SAI_CONFIG_PATH"] = CONFIG_PATH;
  process.env["SAI_MUTABLE_CONFIG_PATH"] = CONFIG_PATH;
  process.env["SAI_SESSION_STORE"] = join(FILE_DIR, "sessions.json");
  const [rpc, authModule, loader, sessions, registry, access, agui, search, broker, audit, turnPrepare] = await Promise.all([
    import("../gateway/rpc.js"),
    import("../gateway/auth.js"),
    import("../config/loader.js"),
    import("../agent/session.js"),
    import("../runtime/account-registry.js"),
    import("../gateway/session-route-access.js"),
    import("../gateway/agui.js"),
    import("../agent/session-search.js"),
    import("../agent/user-input-broker.js"),
    import("../audit/logger.js"),
    import("../agent/turn-prepare.js"),
  ]);
  return { rpc, authModule, loader, sessions, registry, access, agui, search, broker, audit, turnPrepare };
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
  for (const conn of openConnections.splice(0)) conn.close();
  runTurnMock.mockReset();
  mods.broker.userInputBroker.resetForTests();
  await mods.audit.flushAuditLog();
  mods.sessions.resetSessionsForTests();
  mods.registry.resetAccountRegistryForTests();
  mods.loader.resetConfigForTests();
  mods.authModule.resetAuthStateForTests();
  delete process.env["SAI_AUDIT_LOG"];
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
const MARKER = "quandrifex";

function configure(auth: Record<string, unknown>): void {
  workspace = mkdtempSync(join(tmpdir(), "starlingai-ownership-sessions-"));
  dirs.push(workspace);
  writeFileSync(CONFIG_PATH, JSON.stringify({
    gateway: { jwtSecret: SECRET, turnTimeoutMs: 30_000 },
    workspacePath: workspace,
    auth,
  }), "utf8");
  process.env["SAI_AUDIT_LOG"] = join(workspace, "audit.jsonl");
  mods.loader.resetConfigForTests();
  mods.registry.resetAccountRegistryForTests();
  mods.authModule.resetAuthStateForTests();
}

/** The old alice is gone; a new account holds her name. Root is an admin. */
function afterRecreation(): void {
  configure({ enabled: true, users: [root.record, newAlice.record] });
}

/** A chat of `owner`, with a message search can find. */
function chatOf(owner: Identity | undefined, channel = "webchat") {
  const session = mods.sessions.createSession({ channel, ...(owner ?? {}), workspacePath: workspace });
  session.addMessage({ role: "user", content: `Plan the ${MARKER} rollout for ${owner?.userId ?? "nobody"}` });
  session.addMessage({ role: "assistant", content: `The ${MARKER} plan is drafted.` });
  return session;
}

async function signedIn(username: string, claims: Record<string, unknown>) {
  const user = await mods.authModule.authenticatedUserFromToken(await mods.authModule.createToken(username, claims));
  expect(user, `${username} signs in`).not.toBeNull();
  return user!;
}

const openConnections: Array<{ close(): void }> = [];

/** A dashboard socket, opened as gateway/index.ts opens one under multi-user auth. */
async function openSocket(username: string, claims: Record<string, unknown>) {
  const sent: Array<Record<string, unknown>> = [];
  const ws = {
    readyState: 1,
    send(payload: string) { sent.push(JSON.parse(payload) as Record<string, unknown>); },
    close() { this.readyState = 3; },
  };
  const user = await signedIn(username, claims);
  const conn = new mods.rpc.RpcConnection(ws as never, user.username, user.role, user);
  openConnections.push(conn);
  let counter = 0;
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const id = `${method}-${++counter}`;
    await conn.handleMessage(JSON.stringify({ id, method, params }));
    return sent.find((message) => message["type"] === "rpc.response" && message["id"] === id) as { ok: boolean; payload?: unknown; error?: string };
  };
  return { sent, call };
}

const turnOutput = (): TurnOutput => ({
  response: "Done.",
  toolCallsExecuted: 0,
  guardrailEvents: [],
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  blocked: false,
});

class FakeResponse extends EventEmitter {
  statusCode?: number;
  writableEnded = false;
  chunks: string[] = [];
  writeHead(statusCode: number) { this.statusCode = statusCode; }
  write(chunk: string) { this.chunks.push(chunk); return true; }
  end(chunk?: string) { if (chunk) this.chunks.push(chunk); this.writableEnded = true; }
}

describe("a re-created account and the old one's sessions", () => {
  it("the session routes: refused to the new account, open to an admin", async () => {
    afterRecreation();
    const old = chatOf(OLD_ALICE);
    const own = chatOf(NEW_ALICE);
    const alice = await signedIn("alice", newAlice.claims);
    const admin = await signedIn("root", root.claims);

    expect(mods.access.callerMayUseSession(alice, old.id)).toBe(false);
    expect(mods.access.callerMayUseSession(alice, own.id)).toBe(true);
    expect(mods.access.callerMayUseSession(admin, old.id)).toBe(true);
  });

  it("the dashboard socket: not listed, not opened, not driven, and its audit events not pushed", async () => {
    afterRecreation();
    runTurnMock.mockImplementation(async () => turnOutput());
    const old = chatOf(OLD_ALICE);
    const own = chatOf(NEW_ALICE);
    const tab = await openSocket("alice", newAlice.claims);

    const listed = ((await tab.call("session.list")).payload as Array<{ id: string }>).map((summary) => summary.id);
    expect(listed).toContain(own.id);
    expect(listed).not.toContain(old.id);
    const opened = await tab.call("session.get", { sessionId: old.id });
    expect(opened.ok).toBe(false);
    expect(opened.error).toMatch(/not found/i);
    const driven = await tab.call("chat.send", { sessionId: old.id, message: "what did I ask last time?", requestId: "req-old" });
    expect(driven.ok).toBe(false);
    expect(runTurnMock).not.toHaveBeenCalled();
    expect((await tab.call("session.get", { sessionId: own.id })).ok).toBe(true);

    expect((await tab.call("audit.subscribe")).ok).toBe(true);
    const before = tab.sent.length;
    mods.audit.logAudit("tool_call_requested", { tool: "old-probe" }, { sessionId: old.id, userId: "alice" });
    mods.audit.logAudit("tool_call_requested", { tool: "own-probe" }, { sessionId: own.id, userId: "alice" });
    const pushed = tab.sent.slice(before)
      .filter((message) => message["type"] === "audit.event")
      .map((message) => ((message["data"] as { data: { tool: string } }).data.tool));
    expect(pushed).toEqual(["own-probe"]);

    // An event with no session names its user by name alone: under multi-user auth an admin's, not
    // pushed to an account of that name (a channel sender's refusal names the sender).
    const later = tab.sent.length;
    mods.audit.logAudit("channel_sender_refused", { channel: "telegram", reason: "reserved" }, { channel: "telegram", userId: "alice", severity: "warn" });
    expect(tab.sent.slice(later).some((message) => message["type"] === "audit.event")).toBe(false);
  });

  it("the dashboard socket: the owner's second tab stops a turn the first one started", async () => {
    afterRecreation();
    let signal: AbortSignal | undefined;
    runTurnMock.mockImplementation((opts) => {
      signal = opts.signal;
      return new Promise<TurnOutput>(() => { /* running */ });
    });
    const own = chatOf(NEW_ALICE);
    const first = await openSocket("alice", newAlice.claims);
    expect((await first.call("chat.send", { sessionId: own.id, message: "render the harbour", requestId: "req-own" })).ok).toBe(true);
    await vi.waitFor(() => expect(signal).toBeDefined());

    const second = await openSocket("alice", newAlice.claims);
    expect((await second.call("chat.cancel", { requestId: "req-own" })).payload).toEqual({ cancelled: true, requestId: "req-own", known: true });
    expect(signal!.aborted).toBe(true);
  });

  it("the AG-UI stream: the old chat answers as missing, and no turn runs", async () => {
    afterRecreation();
    runTurnMock.mockImplementation(async () => turnOutput());
    const old = chatOf(OLD_ALICE);
    const res = new FakeResponse();
    await mods.agui.handleAguiStream(res as never, { sessionId: old.id, message: "continue" }, { userId: "alice", role: "operator", identity: NEW_ALICE });
    expect(res.statusCode).toBe(404);
    expect(runTurnMock).not.toHaveBeenCalled();

    const own = chatOf(NEW_ALICE);
    const ownRes = new FakeResponse();
    await mods.agui.handleAguiStream(ownRes as never, { sessionId: own.id, message: "continue" }, { userId: "alice", role: "operator", identity: NEW_ALICE });
    expect(ownRes.statusCode).toBe(200);
    expect(runTurnMock).toHaveBeenCalledTimes(1);
  });

  it("session search: the old chats are not searched for the new account", () => {
    afterRecreation();
    const old = chatOf(OLD_ALICE);
    const own = chatOf(NEW_ALICE);
    const found = mods.search.searchSessions(MARKER, { limit: 10, requester: NEW_ALICE }).map((result) => result.id);
    expect(found).toEqual([own.id]);
    expect(found).not.toContain(old.id);
  });

  it("the user-input broker: the new account cannot answer, list or read the old one's questions", () => {
    afterRecreation();
    const old = chatOf(OLD_ALICE);
    const own = chatOf(NEW_ALICE);
    mods.broker.userInputBroker.openTurn("turn-old", old.id, OLD_ALICE);
    mods.broker.userInputBroker.openTurn("turn-own", own.id, NEW_ALICE);
    const caller = { userId: "alice", identity: NEW_ALICE, isAdmin: false };

    expect(mods.broker.userInputBroker.canAnswerFor(old.id, caller)).toBe(false);
    expect(mods.broker.userInputBroker.canAnswerFor(own.id, caller)).toBe(true);
    // An admin answers for anyone, as before.
    expect(mods.broker.userInputBroker.canAnswerFor(old.id, { userId: "root", isAdmin: true })).toBe(true);
  });
});

describe("sessions of other kinds", () => {
  it("a channel sender's session named like an account is an admin's, not the account's", async () => {
    configure({ enabled: true, users: [root.record, oldAlice.record] });
    const telegram = chatOf({ userId: "alice", principal: "channel" }, "telegram");
    const alice = await signedIn("alice", oldAlice.claims);
    const admin = await signedIn("root", root.claims);

    expect(mods.access.callerMayUseSession(alice, telegram.id)).toBe(false);
    expect(mods.access.callerMayUseSession(admin, telegram.id)).toBe(true);
    const tab = await openSocket("alice", oldAlice.claims);
    expect(((await tab.call("session.list")).payload as Array<{ id: string }>).map((summary) => summary.id)).not.toContain(telegram.id);
  });

  it("a bootstrap operator token sees its own sessions, and an account of the same name does not", async () => {
    const adminAccount = testAccount("admin");
    configure({ enabled: true, users: [root.record, adminAccount.record] });
    const tokens = chatOf({ userId: "admin", principal: "bootstrap" });
    const bootstrap = await signedIn("admin", bootstrapClaims("operator"));
    const account = await signedIn("admin", adminAccount.claims);

    expect(mods.access.callerMayUseSession(bootstrap, tokens.id)).toBe(true);
    expect(mods.access.callerMayUseSession(account, tokens.id)).toBe(false);
    const accountsChat = chatOf({ userId: "admin", account: adminAccount.id });
    expect(mods.access.callerMayUseSession(bootstrap, accountsChat.id)).toBe(false);
    expect(mods.access.callerMayUseSession(account, accountsChat.id)).toBe(true);
  });

  it("a session from before account ids is an admin's alone, and runs no turn", async () => {
    // Written while no account held the name (a record from before ids restores the same way).
    configure({ enabled: true, users: [root.record] });
    const legacy = chatOf({ userId: "alice" });
    configure({ enabled: true, users: [root.record, oldAlice.record] });
    const alice = await signedIn("alice", oldAlice.claims);
    const admin = await signedIn("root", root.claims);

    expect(mods.access.callerMayUseSession(alice, legacy.id)).toBe(false);
    expect(mods.access.callerMayUseSession(admin, legacy.id)).toBe(true);
    expect(mods.search.searchSessions(MARKER, { limit: 10, requester: OLD_ALICE })).toEqual([]);
    expect(mods.turnPrepare.prepareLegacySession(legacy)?.blocked).toBe(true);
  });

  it("with one operator, a session is its owner's by name, as before", async () => {
    configure({ enabled: false });
    const aliceChat = chatOf({ userId: "alice" });
    const bobChat = chatOf({ userId: "bob" });
    const sent: Array<Record<string, unknown>> = [];
    const ws = { readyState: 1, send(payload: string) { sent.push(JSON.parse(payload) as Record<string, unknown>); } };
    const tab = new mods.rpc.RpcConnection(ws as never, "alice", "operator");
    openConnections.push(tab);
    await tab.handleMessage(JSON.stringify({ id: "list", method: "session.list", params: {} }));
    const listed = ((sent.find((message) => message["id"] === "list") as { payload: Array<{ id: string }> }).payload).map((summary) => summary.id);
    expect(listed).toContain(aliceChat.id);
    expect(listed).not.toContain(bobChat.id);
    expect(mods.search.searchSessions(MARKER, { limit: 10, requester: { userId: "alice" } }).map((result) => result.id).sort())
      .toEqual([aliceChat.id, bobChat.id].sort());
    expect(mods.broker.userInputBroker.canAnswerFor(aliceChat.id, { userId: "alice", isAdmin: false })).toBe(true);
    expect(mods.broker.userInputBroker.canAnswerFor(bobChat.id, { userId: "alice", isAdmin: false })).toBe(false);
  });
});
