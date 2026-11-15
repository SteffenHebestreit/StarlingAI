import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunTurnOptions, TurnOutput } from "../agent/turn-types.js";
import type { AuditEvent } from "../audit/schema.js";
import { PRODUCT } from "../product/index.js";
import { testAccount } from "./support/test-account.js";

/**
 * Who may call which WebSocket RPC method (gateway/rpc-policy.ts).
 *
 * The /ws handshake admits any caller whose token resolves, and the methods read the role in one
 * place only (another account's session). So a viewer, or a fork's rank-10 role, opened sessions,
 * ran turns, answered approvals and used every inline override over the socket, while the REST
 * equivalents refused it with 403. Every method now has a minimum role; `--auto` has a floor of its
 * own; a client may not open a session on a channel whose turns are trusted as workflow text; and
 * gateway.status no longer counts every account's sessions.
 */

const runTurnMock = vi.hoisted(() => vi.fn<(opts: RunTurnOptions) => Promise<TurnOutput>>());

// The turn is stubbed: what these pin is whether a turn starts, and with which options.
vi.mock("../agent/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent/runtime.js")>()),
  runTurn: runTurnMock,
}));

const SECRET = "p".repeat(40);
// The config loader fixes its file when it loads, so the modules load once for this file and every
// test writes its configuration to that one file.
const FILE_DIR = mkdtempSync(join(tmpdir(), "starlingai-rpc-policy-"));
const CONFIG_PATH = join(FILE_DIR, "starlingai.json");
const ENV_KEYS = ["SAI_CONFIG_PATH", "SAI_MUTABLE_CONFIG_PATH", "SAI_SESSION_STORE", "SAI_MASTER_KEY", "SAI_CRED_STORE", "SAI_AUDIT_LOG"];
let mods: Awaited<ReturnType<typeof loadModules>>;

async function loadModules() {
  writeFileSync(CONFIG_PATH, JSON.stringify({ gateway: { jwtSecret: SECRET } }), "utf8");
  process.env["SAI_CONFIG_PATH"] = CONFIG_PATH;
  process.env["SAI_MUTABLE_CONFIG_PATH"] = CONFIG_PATH;
  process.env["SAI_SESSION_STORE"] = join(FILE_DIR, "sessions.json");
  process.env["SAI_MASTER_KEY"] = "m".repeat(32);
  process.env["SAI_CRED_STORE"] = join(FILE_DIR, PRODUCT.stateDirName, "credentials.enc");
  process.env["SAI_AUDIT_LOG"] = join(FILE_DIR, "audit.jsonl");
  // Sequential: these modules import each other.
  const rpc = await import("../gateway/rpc.js");
  const policy = await import("../gateway/rpc-policy.js");
  const authModule = await import("../gateway/auth.js");
  const loader = await import("../config/loader.js");
  const sessions = await import("../agent/session.js");
  const registry = await import("../runtime/account-registry.js");
  const audit = await import("../audit/logger.js");
  const extension = await import("../extension/index.js");
  const extensionLoader = await import("../extension/loader.js");
  const groups = await import("../tools/groups.js");
  const computer = await import("../agent/computer-session.js");
  const turnPrepare = await import("../agent/turn-prepare.js");
  return { rpc, policy, authModule, loader, sessions, registry, audit, extension, extensionLoader, groups, computer, turnPrepare };
}

/** Extension roles at the ranks the SDK's convention names: viewer-like, operator-like, below admin. */
const EXTENSION_ROLES = [
  { name: "ext-low", description: "rank 10", rank: 10 },
  { name: "ext-mid", description: "rank 50", rank: 50 },
  { name: "ext-high", description: "rank 80", rank: 80 },
];
const RANK: Record<string, number> = { viewer: 10, operator: 50, admin: 90, "ext-low": 10, "ext-mid": 50, "ext-high": 80 };
const ROLES = Object.keys(RANK);

function registerExtensionRoles(): void {
  mods.extension._recordLoadedExtension(
    { name: "rolesext", version: "1.0.0", toolNames: [], auditEvents: [], roles: EXTENSION_ROLES, loadedAt: "2026-01-01T00:00:00Z", source: "test" },
    { name: "rolesext", version: "1.0.0", roles: EXTENSION_ROLES },
  );
}

beforeAll(async () => {
  mods = await loadModules();
});

afterAll(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  rmSync(FILE_DIR, { recursive: true, force: true });
});

const dirs: string[] = [];
const openConnections: Array<{ close(): void }> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const conn of openConnections.splice(0)) conn.close();
  runTurnMock.mockReset();
  await mods.audit.flushAuditLog();
  mods.sessions.resetSessionsForTests();
  mods.registry.resetAccountRegistryForTests();
  mods.policy._resetRpcPoliciesForTests();
  mods.extension._resetExtensionsForTests();
  mods.extensionLoader._resetExtensionLoaderForTests();
  mods.extensionLoader.setExtensionImporterForTests(null);
  mods.groups._resetToolGroupsForTests();
  delete process.env["SAI_EXTENSIONS_DIR"];
  mods.loader.resetConfigForTests();
  mods.authModule.resetAuthStateForTests();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const vic = testAccount("vic", "viewer");
const olga = testAccount("olga", "operator");
const root = testAccount("root", "admin");
const pat = testAccount("pat", "ext-low");
const mia = testAccount("mia", "ext-mid");

let workspace = "";

function configure(auth: Record<string, unknown> | null, gateway: Record<string, unknown> = {}): void {
  workspace = mkdtempSync(join(tmpdir(), "starlingai-rpc-policy-ws-"));
  dirs.push(workspace);
  writeFileSync(CONFIG_PATH, JSON.stringify({
    gateway: { jwtSecret: SECRET, turnTimeoutMs: 30_000, ...gateway },
    workspacePath: workspace,
    ...(auth ? { auth } : {}),
  }), "utf8");
  mods.loader.resetConfigForTests();
  mods.registry.resetAccountRegistryForTests();
  mods.authModule.resetAuthStateForTests();
}

/** Multi-user auth with one account per role this file uses. */
function configureMultiUser(gateway: Record<string, unknown> = {}): void {
  registerExtensionRoles();
  configure({ enabled: true, users: [vic.record, olga.record, root.record, pat.record, mia.record] }, gateway);
}

type Sent = Array<Record<string, unknown>>;
type Reply = { ok: boolean; payload?: unknown; error?: string };

function socketOf(sent: Sent) {
  return { readyState: 1, send(payload: string) { sent.push(JSON.parse(payload) as Record<string, unknown>); }, close() { this.readyState = 3; } };
}

function caller(conn: { handleMessage(raw: string): Promise<void> }, sent: Sent) {
  let counter = 0;
  return async (method: unknown, params: Record<string, unknown> = {}): Promise<Reply> => {
    const id = `${String(method)}-${++counter}`;
    await conn.handleMessage(JSON.stringify({ id, method, params }));
    return sent.find((message) => message["type"] === "rpc.response" && message["id"] === id) as Reply;
  };
}

/** A dashboard socket of `account`, opened as gateway/index.ts opens one under multi-user auth. */
async function openSocket(account: { record: Record<string, unknown>; claims: Record<string, unknown> }) {
  const username = String(account.record["username"]);
  const sent: Sent = [];
  const user = await mods.authModule.authenticatedUserFromToken(await mods.authModule.createToken(username, account.claims));
  expect(user, `${username} signs in`).not.toBeNull();
  const conn = new mods.rpc.RpcConnection(socketOf(sent) as never, user!.username, user!.role, user!);
  openConnections.push(conn);
  return { sent, conn, call: caller(conn, sent) };
}

/** A socket with auth off, as gateway/index.ts opens one: the token's subject and role claim alone. */
function openSingleOperatorSocket(userId?: string, role?: string) {
  const sent: Sent = [];
  const conn = new mods.rpc.RpcConnection(socketOf(sent) as never, userId, role);
  openConnections.push(conn);
  return { sent, conn, call: caller(conn, sent) };
}

const turnOutput = (): TurnOutput => ({
  response: "Done.",
  toolCallsExecuted: 0,
  guardrailEvents: [],
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  blocked: false,
});

function rbacDenials(): { events: AuditEvent[]; stop: () => void } {
  const events: AuditEvent[] = [];
  const stop = mods.audit.subscribeToAudit((event) => {
    if (event.type === "rbac_denied") events.push(event);
  });
  return { events, stop };
}

const VIEWER_METHODS = [
  "gateway.status", "session.list", "session.get", "scenes.list", "jobs.list",
  "audit.subscribe", "audit.unsubscribe", "notifications.subscribe", "notifications.unsubscribe", "computer.list_sessions",
];
const OPERATOR_METHODS = [
  "session.create", "session.end", "session.archive", "session.delete", "session.reset", "session.rewind", "session.updateSettings",
  "chat.send", "chat.cancel", "approval.respond", "input.respond", "userInput.respond", "userInput.hold", "userInput.preview",
  "computer.emergency_stop", "computer.heartbeat", "computer.request_screenshot",
];

describe("the default minimum role of every RPC method", () => {
  it("classifies every method: reading for a viewer, everything that changes something for an operator", () => {
    const table = mods.policy.RPC_METHOD_MIN_ROLE;
    expect(Object.keys(table).sort()).toEqual([...VIEWER_METHODS, ...OPERATOR_METHODS].sort());
    for (const method of VIEWER_METHODS) expect(table[method as keyof typeof table], method).toBe("viewer");
    for (const method of OPERATOR_METHODS) expect(table[method as keyof typeof table], method).toBe("operator");
  });

  it("admits a role by rank, built-in and extension roles alike, under multi-user auth", () => {
    registerExtensionRoles();
    const minimumRank = { viewer: 10, operator: 50, admin: 90 } as const;
    for (const [method, min] of Object.entries(mods.policy.RPC_METHOD_MIN_ROLE)) {
      for (const role of ROLES) {
        const decision = mods.policy.authorizeRpc(method, role, true);
        const expected = RANK[role]! >= minimumRank[min];
        expect(decision.allowed, `${role} -> ${method}`).toBe(expected);
        if (!decision.allowed) expect(decision).toMatchObject({ reason: "forbidden", error: `Forbidden: ${method} requires role ${min}` });
      }
    }
    // A role nobody registered, or none at all, meets no minimum.
    expect(mods.policy.authorizeRpc("session.list", "ghost-role", true).allowed).toBe(false);
    expect(mods.policy.authorizeRpc("session.list", undefined, true).allowed).toBe(false);
  });

  it("allows every method, and any name, with auth off: there is one operator and no roles", () => {
    for (const method of [...VIEWER_METHODS, ...OPERATOR_METHODS, "no.such_method"]) {
      for (const role of [...ROLES, undefined]) expect(mods.policy.authorizeRpc(method, role, false).allowed).toBe(true);
    }
  });

  it("refuses a method the protocol does not have under multi-user auth, an Object prototype name included", () => {
    for (const method of ["no.such_method", "toString", "__proto__", "constructor", 42, undefined]) {
      expect(mods.policy.authorizeRpc(method, "admin", true)).toEqual({ allowed: false, reason: "unknown_method", error: `Unknown method: ${String(method)}` });
    }
  });
});

describe("rpcPolicies from extensions", () => {
  it("lets a roles policy replace a method's default, so a fork can open a method to a role of its own", () => {
    registerExtensionRoles();
    mods.policy.registerRpcPolicies("portal", [{ method: "chat.send", roles: ["ext-low", "operator"] }]);
    expect(mods.policy.authorizeRpc("chat.send", "ext-low", true).allowed).toBe(true);
    // The built-in chain: a listed operator admits an admin.
    expect(mods.policy.authorizeRpc("chat.send", "operator", true).allowed).toBe(true);
    expect(mods.policy.authorizeRpc("chat.send", "admin", true).allowed).toBe(true);
    // Replaced, not added to: a role the list leaves out is refused even at operator rank.
    expect(mods.policy.authorizeRpc("chat.send", "ext-mid", true)).toMatchObject({
      allowed: false, reason: "forbidden", error: "Forbidden: chat.send requires role ext-low or operator", policy: "portal",
    });
    expect(mods.policy.authorizeRpc("chat.send", "viewer", true).allowed).toBe(false);
    // Other methods keep their default.
    expect(mods.policy.authorizeRpc("session.create", "ext-low", true).allowed).toBe(false);
  });

  it("lets a denyRoles policy refuse the roles it names and leave everyone else to the default", () => {
    registerExtensionRoles();
    mods.policy.registerRpcPolicies("kiosk", [{ method: "session.list", denyRoles: ["ext-mid"] }]);
    expect(mods.policy.authorizeRpc("session.list", "ext-mid", true)).toMatchObject({
      allowed: false, reason: "forbidden", error: "Forbidden: session.list is not available to role ext-mid", policy: "kiosk",
    });
    expect(mods.policy.authorizeRpc("session.list", "viewer", true).allowed).toBe(true);
    expect(mods.policy.authorizeRpc("chat.send", "ext-mid", true).allowed).toBe(true);
    expect(mods.policy.authorizeRpc("chat.send", "viewer", true).allowed).toBe(false);
  });

  it("matches a method exactly, by 'prefix.*', or with '*'", () => {
    registerExtensionRoles();
    mods.policy.registerRpcPolicies("kiosk", [{ method: "session.*", denyRoles: ["ext-mid"] }]);
    for (const method of ["session.create", "session.get", "session.updateSettings"]) {
      expect(mods.policy.authorizeRpc(method, "ext-mid", true).allowed, method).toBe(false);
    }
    expect(mods.policy.authorizeRpc("chat.send", "ext-mid", true).allowed).toBe(true);
    mods.policy._resetRpcPoliciesForTests();

    mods.policy.registerRpcPolicies("lockdown", [{ method: "*", denyRoles: ["ext-high"] }]);
    for (const method of [...VIEWER_METHODS, ...OPERATOR_METHODS]) expect(mods.policy.authorizeRpc(method, "ext-high", true).allowed, method).toBe(false);
    expect(mods.policy.authorizeRpc("chat.send", "operator", true).allowed).toBe(true);
  });

  it("takes the first policy that matches, in registration order", () => {
    registerExtensionRoles();
    mods.policy.registerRpcPolicies("a", [{ method: "chat.send", roles: ["ext-low", "operator"] }]);
    mods.policy.registerRpcPolicies("b", [{ method: "*", denyRoles: ["ext-low"] }]);
    expect(mods.policy.authorizeRpc("chat.send", "ext-low", true).allowed).toBe(true);
    expect(mods.policy.authorizeRpc("session.list", "ext-low", true)).toMatchObject({ allowed: false, policy: "b" });

    mods.policy._resetRpcPoliciesForTests();
    mods.policy.registerRpcPolicies("b", [{ method: "*", denyRoles: ["ext-low"] }]);
    mods.policy.registerRpcPolicies("a", [{ method: "chat.send", roles: ["ext-low", "operator"] }]);
    expect(mods.policy.authorizeRpc("chat.send", "ext-low", true)).toMatchObject({ allowed: false, policy: "b" });

    // A deny that does not name the caller decides as the default does, not as a later policy.
    mods.policy._resetRpcPoliciesForTests();
    mods.policy.registerRpcPolicies("b", [{ method: "*", denyRoles: ["ext-high"] }]);
    mods.policy.registerRpcPolicies("a", [{ method: "chat.send", roles: ["ext-low", "operator"] }]);
    expect(mods.policy.authorizeRpc("chat.send", "ext-low", true)).toMatchObject({ allowed: false, error: "Forbidden: chat.send requires role operator" });
  });

  it("refuses a malformed policy and registers none of a list that holds one", () => {
    const bad: unknown[] = [
      { method: "chat.*.send", roles: ["operator"] },
      { method: "", roles: ["operator"] },
      { method: "*chat", roles: ["operator"] },
      { method: "chat.send ", roles: ["operator"] },
      { method: 5, roles: ["operator"] },
      { method: "chat.send" },
      { method: "chat.send", roles: ["operator"], denyRoles: ["viewer"] },
      { method: "chat.send", roles: "operator" },
      { method: "chat.send", denyRoles: [""] },
      null,
    ];
    for (const policy of bad) expect(() => mods.policy.validateRpcPolicy("ext", policy), JSON.stringify(policy)).toThrow(/rpc policy from "ext"/);
    expect(() => mods.policy.registerRpcPolicies("ext", [
      { method: "*", roles: ["viewer"] },
      { method: "chat.*.send", roles: ["viewer"] },
    ])).toThrow();
    // The well-formed first entry was not registered either: the default still applies.
    expect(mods.policy.authorizeRpc("chat.send", "viewer", true).allowed).toBe(false);
  });

  it("registers an extension's rpcPolicies when the loader loads it, and none of an extension that fails to load", async () => {
    const dir = mkdtempSync(join(tmpdir(), "starlingai-rpc-policy-ext-"));
    dirs.push(dir);
    const names = ["portal", "shadow"];
    for (const name of names) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, "index.mjs"), "// discovery marker: the importer is injected\n");
    }
    const tool = (name: string) => ({ name, description: name, tier: 0, parameters: { type: "object", properties: {} }, execute: async () => "" });
    const manifests: Record<string, unknown> = {
      portal: { name: "portal", version: "1.0.0", roles: [{ name: "portal-user", description: "portal", rank: 10 }], rpcPolicies: [{ method: "chat.send", roles: ["portal-user", "operator"] }] },
      // Well-formed policies, but a tool that shadows a built-in: the load fails after validation.
      shadow: { name: "shadow", version: "1.0.0", tools: [tool("read_file")], rpcPolicies: [{ method: "session.*", roles: ["viewer"] }, { method: "chat.send", roles: ["viewer"] }] },
    };
    mods.extensionLoader.setExtensionImporterForTests(async (entry) => ({ default: manifests[names.find((name) => entry.includes(name))!] }));
    process.env["SAI_EXTENSIONS_DIR"] = dir;
    configure(null);
    const result = await mods.extensionLoader.loadCoreExtensions();
    expect(result).toMatchObject({ loaded: 1, failed: 1 });
    expect(mods.policy.authorizeRpc("chat.send", "portal-user", true).allowed).toBe(true);
    // Nothing of the failed extension took effect: its policies would have opened session.create and
    // chat.send to viewers.
    for (const method of ["session.create", "chat.send", "session.delete"]) {
      expect(mods.policy.authorizeRpc(method, "viewer", true).allowed, method).toBe(false);
    }
  });

  it("loads an extension whose rpcPolicies are malformed: its role stays, and a malformed entry refuses its method to every caller", async () => {
    // Failing the load dropped the extension's roles, and a role nobody declares signs in as
    // operator: a typo in one policy raised a fork's portal role to an operator, with every method.
    const dir = mkdtempSync(join(tmpdir(), "starlingai-rpc-policy-ext-"));
    dirs.push(dir);
    mkdirSync(join(dir, "portal"));
    writeFileSync(join(dir, "portal", "index.mjs"), "// discovery marker: the importer is injected\n");
    mods.extensionLoader.setExtensionImporterForTests(async () => ({
      default: {
        name: "portal",
        version: "1.0.0",
        roles: [{ name: "portal-user", description: "portal", rank: 10 }],
        rpcPolicies: [
          { method: "chat.send", roles: ["portal-user", "operator"] },
          // A role list written as a string, and both forms at once.
          { method: "session.create", roles: "portal-user" },
          { method: "session.list", roles: ["admin"], denyRoles: ["viewer"] },
        ],
      },
    }));
    process.env["SAI_EXTENSIONS_DIR"] = dir;
    const pia = testAccount("pia", "portal-user");
    configure({ enabled: true, users: [pia.record, olga.record, root.record] });
    expect(await mods.extensionLoader.loadCoreExtensions()).toMatchObject({ loaded: 1, failed: 0 });

    // The account keeps its role: it signs in as portal-user, below operator, not as an operator.
    const tab = await openSocket(pia);
    const hello = tab.sent.find((message) => message["type"] === "hello-ok") as { data: { methods: string[] } };
    expect(hello.data.methods).toContain("chat.send");
    for (const method of ["session.create", "session.list", "approval.respond", "computer.emergency_stop"]) {
      expect(hello.data.methods, method).not.toContain(method);
    }
    expect((await tab.call("session.create", { channel: "webchat" })).ok).toBe(false);
    const user = await mods.authModule.authenticatedUserFromToken(await mods.authModule.createToken("pia", pia.claims));
    expect(user?.role).toBe("portal-user");
    expect(mods.authModule.userHasRole(user, "operator")).toBe(false);
    // The well-formed entry registers as declared. Each malformed one refuses its method to every
    // caller, an admin included, until it is fixed; the other methods keep their default.
    expect(mods.policy.authorizeRpc("chat.send", "portal-user", true).allowed).toBe(true);
    for (const role of ["portal-user", "viewer", "operator", "admin"]) {
      expect(mods.policy.authorizeRpc("session.create", role, true), role).toMatchObject({ allowed: false, error: "Forbidden: session.create requires role (none)", policy: "portal" });
      expect(mods.policy.authorizeRpc("session.list", role, true).allowed, role).toBe(false);
    }
    expect(mods.policy.authorizeRpc("session.get", "viewer", true).allowed).toBe(true);
    expect(mods.policy.authorizeRpc("session.delete", "operator", true).allowed).toBe(true);
  });

  it("registers a malformed manifest entry as one that refuses every caller, every method when its method cannot be read", () => {
    registerExtensionRoles();
    // The method is named: that method is closed.
    expect(mods.policy.registerManifestRpcPolicies("portal", [{ method: "session.create", roles: "ext-low" }])).toEqual([
      'rpc policy for "session.create": roles must be a list of role names; it refuses the method to every caller until it is fixed',
    ]);
    expect(mods.policy.authorizeRpc("session.create", "admin", true).allowed).toBe(false);
    expect(mods.policy.authorizeRpc("session.list", "viewer", true).allowed).toBe(true);

    // No method name ("session*" for "session.*"): there is no telling which methods it meant, so it
    // closes every method that a policy before it does not decide.
    mods.policy._resetRpcPoliciesForTests();
    expect(mods.policy.registerManifestRpcPolicies("portal", [
      { method: "chat.send", roles: ["ext-low", "operator"] },
      { method: "session*", roles: ["ext-low", "operator"] },
      { method: "session.list", roles: ["ext-low"] },
    ])).toEqual([
      'rpc policy: method must be a method name, "prefix.*" or "*" (got "session*"); it refuses every method to every caller until it is fixed',
    ]);
    expect(mods.policy.authorizeRpc("chat.send", "ext-low", true).allowed).toBe(true);
    for (const method of [...VIEWER_METHODS, ...OPERATOR_METHODS].filter((name) => name !== "chat.send")) {
      expect(mods.policy.authorizeRpc(method, "admin", true).allowed, method).toBe(false);
    }

    // So does an entry that is no object or names no method, and an rpcPolicies that is not a list.
    for (const value of [[null], [{ roles: ["viewer"] }], { method: "chat.send", roles: ["ext-low"] }, "chat.send"]) {
      mods.policy._resetRpcPoliciesForTests();
      expect(mods.policy.registerManifestRpcPolicies("portal", value), JSON.stringify(value)).toEqual([expect.stringMatching(/it refuses every method to every caller until it is fixed$/)]);
      for (const method of [...VIEWER_METHODS, ...OPERATOR_METHODS]) {
        expect(mods.policy.authorizeRpc(method, "admin", true).allowed, `${JSON.stringify(value)} ${method}`).toBe(false);
      }
    }

    // A well-formed list registers as declared, and no list at all is no problem.
    mods.policy._resetRpcPoliciesForTests();
    expect(mods.policy.registerManifestRpcPolicies("portal", [{ method: "chat.send", roles: ["ext-low", "operator"] }])).toEqual([]);
    expect(mods.policy.registerManifestRpcPolicies("portal", undefined)).toEqual([]);
    expect(mods.policy.authorizeRpc("chat.send", "ext-low", true).allowed).toBe(true);
    expect(mods.policy.authorizeRpc("session.list", "viewer", true).allowed).toBe(true);
  });
});

describe("the socket checks the method's minimum role before it runs", () => {
  it("refuses a viewer every method that changes something, with nothing of it run", async () => {
    configureMultiUser();
    const emergencyStop = vi.spyOn(mods.computer.computerSessionManager, "emergencyStop");
    const own = mods.sessions.createSession({ channel: "webchat", userId: "vic", account: vic.id, workspacePath: workspace });
    own.addMessage({ role: "user", content: "an earlier question" });
    const settingsBefore = own.getSettings();
    const tab = await openSocket(vic);
    for (const method of OPERATOR_METHODS) {
      const reply = await tab.call(method, { sessionId: own.id, message: "hello", historyIndex: 0, effort: "max", computerSessionId: "cs-1" });
      expect(reply, method).toEqual({ type: "rpc.response", id: expect.any(String), ok: false, error: `Forbidden: ${method} requires role operator` });
    }
    expect(runTurnMock).not.toHaveBeenCalled();
    expect(emergencyStop).not.toHaveBeenCalled();
    const after = mods.sessions.getSessionRecord(own.id);
    expect(after, "session.delete did not run").toBeDefined();
    expect(after!.isArchived(), "session.archive/end did not run").toBe(false);
    expect(after!.getHistory().map((message) => message.content), "session.reset/rewind did not run").toEqual(["an earlier question"]);
    expect(after!.getSettings(), "session.updateSettings did not run").toEqual(settingsBefore);
    expect(mods.sessions.getAllSessions({ includeArchived: true }).map((session) => session.id), "session.create did not run").toEqual([own.id]);
  });

  it("still lets a viewer read its own sessions and the catalogue", async () => {
    configureMultiUser();
    const own = mods.sessions.createSession({ channel: "webchat", userId: "vic", account: vic.id, workspacePath: workspace });
    const tab = await openSocket(vic);
    for (const method of VIEWER_METHODS) expect((await tab.call(method, { sessionId: own.id })).ok, method).toBe(true);
    expect(((await tab.call("session.list")).payload as Array<{ id: string }>).map((summary) => summary.id)).toEqual([own.id]);
  });

  it("lets an operator, an admin and an operator-rank extension role start a session and a turn", async () => {
    configureMultiUser();
    runTurnMock.mockImplementation(async () => turnOutput());
    for (const account of [olga, root, mia]) {
      const tab = await openSocket(account);
      const created = await tab.call("session.create", { channel: "webchat" });
      expect(created.ok, String(account.record["username"])).toBe(true);
      const sessionId = (created.payload as { sessionId: string }).sessionId;
      const sent = await tab.call("chat.send", { sessionId, message: "hello", requestId: `req-${String(account.record["username"])}` });
      expect(sent.payload).toMatchObject({ accepted: true });
    }
    expect(runTurnMock).toHaveBeenCalledTimes(3);
  });

  it("refuses a rank-10 extension role a turn, as a viewer", async () => {
    configureMultiUser();
    const own = mods.sessions.createSession({ channel: "webchat", userId: "pat", account: pat.id, workspacePath: workspace });
    const tab = await openSocket(pat);
    expect(await tab.call("chat.send", { sessionId: own.id, message: "hello" })).toMatchObject({ ok: false, error: "Forbidden: chat.send requires role operator" });
    expect(runTurnMock).not.toHaveBeenCalled();
  });

  it("takes the role the store holds now: a demoted operator is refused on its next message", async () => {
    configureMultiUser();
    const tab = await openSocket(olga);
    expect((await tab.call("session.create", { channel: "webchat" })).ok).toBe(true);
    mods.loader.updateConfig((raw) => {
      for (const user of (raw["auth"] as { users: Array<{ username: string; role: string }> }).users) if (user.username === "olga") user.role = "viewer";
    });
    expect(await tab.call("session.create", { channel: "webchat" })).toMatchObject({ ok: false, error: "Forbidden: session.create requires role operator" });
  });

  it("applies an extension's policy on the socket", async () => {
    configureMultiUser();
    mods.policy.registerRpcPolicies("portal", [{ method: "session.create", roles: ["ext-low", "operator"] }, { method: "chat.send", roles: ["ext-low", "operator"] }]);
    runTurnMock.mockImplementation(async () => turnOutput());
    const tab = await openSocket(pat);
    const created = await tab.call("session.create", { channel: "webchat" });
    expect(created.ok).toBe(true);
    const sent = await tab.call("chat.send", { sessionId: (created.payload as { sessionId: string }).sessionId, message: "hello" });
    expect(sent.payload).toMatchObject({ accepted: true });
    expect(runTurnMock.mock.calls[0]![0].session.userRole).toBe("ext-low");
  });

  it("changes nothing with auth off: a token without a role, or with viewer in it, still runs a turn", async () => {
    configure(null);
    runTurnMock.mockImplementation(async () => turnOutput());
    for (const [userId, role] of [[undefined, undefined], ["solo", "viewer"]] as const) {
      const tab = openSingleOperatorSocket(userId, role);
      const created = await tab.call("session.create", {});
      expect(created.ok).toBe(true);
      const sent = await tab.call("chat.send", { sessionId: (created.payload as { sessionId: string }).sessionId, message: "hello" });
      expect(sent.payload).toMatchObject({ accepted: true });
    }
    expect(runTurnMock).toHaveBeenCalledTimes(2);
  });

  it("lists in hello-ok the methods the connection may call, so a client need not guess from role names", async () => {
    const methodsOf = (sent: Sent) => {
      const hello = sent.find((message) => message["type"] === "hello-ok");
      return [...((hello?.["data"] as { methods?: string[] } | undefined)?.methods ?? ["(none listed)"])].sort();
    };
    const all = [...VIEWER_METHODS, ...OPERATOR_METHODS].sort();
    configureMultiUser();
    expect(methodsOf((await openSocket(vic)).sent)).toEqual([...VIEWER_METHODS].sort());
    expect(methodsOf((await openSocket(pat)).sent)).toEqual([...VIEWER_METHODS].sort());
    for (const account of [olga, mia, root]) expect(methodsOf((await openSocket(account)).sent)).toEqual(all);
    // An extension's policy shows: chat opened to the rank-10 role, the session list closed to it.
    mods.policy.registerRpcPolicies("portal", [{ method: "chat.send", roles: ["ext-low", "operator"] }, { method: "session.list", denyRoles: ["ext-low"] }]);
    expect(methodsOf((await openSocket(pat)).sent)).toEqual([...VIEWER_METHODS.filter((method) => method !== "session.list"), "chat.send"].sort());
    // With auth off every method, whatever role the token claims.
    configure(null);
    expect(methodsOf(openSingleOperatorSocket("solo", "viewer").sent)).toEqual(all);
    expect(methodsOf(openSingleOperatorSocket().sent)).toEqual(all);
  });

  it("answers a method the protocol does not have as before, without an audit record", async () => {
    configureMultiUser();
    const { events, stop } = rbacDenials();
    try {
      const tab = await openSocket(root);
      expect(await tab.call("no.such_method")).toMatchObject({ ok: false, error: "Error: Unknown method: no.such_method" });
      expect(await tab.call("toString")).toMatchObject({ ok: false, error: "Error: Unknown method: toString" });
      expect(events).toEqual([]);
    } finally {
      stop();
    }
  });
});

describe("rbac_denied for a refused RPC call", () => {
  it("is written once per connection, method and minute", async () => {
    configureMultiUser();
    const { events, stop } = rbacDenials();
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const tab = await openSocket(vic);
      for (let attempt = 0; attempt < 5; attempt++) await tab.call("chat.send", { message: "hello" });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "rbac_denied",
        userId: "vic",
        severity: "warn",
        data: { surface: "rpc", method: "chat.send", role: "viewer", required: "operator" },
      });

      // Another method is another record; the same one again only after the minute.
      await tab.call("session.create", {});
      expect(events.map((event) => event.data["method"])).toEqual(["chat.send", "session.create"]);
      now += 59_999;
      await tab.call("chat.send", { message: "hello" });
      expect(events).toHaveLength(2);
      now += 1;
      await tab.call("chat.send", { message: "hello" });
      expect(events.map((event) => event.data["method"])).toEqual(["chat.send", "session.create", "chat.send"]);

      // The window is the connection's: a second tab of the same account is audited at once.
      const second = await openSocket(vic);
      await second.call("chat.send", { message: "hello" });
      expect(events).toHaveLength(4);
    } finally {
      stop();
    }
  });
});

describe("--auto has a role floor of its own", () => {
  async function sendAuto(account: typeof olga) {
    const tab = await openSocket(account);
    const created = await tab.call("session.create", { channel: "webchat" });
    expect(created.ok).toBe(true);
    const sessionId = (created.payload as { sessionId: string }).sessionId;
    const requestId = `req-auto-${String(account.record["username"])}`;
    const reply = await tab.call("chat.send", { sessionId, message: "--auto clean up the build folder", requestId });
    const status = tab.sent.find((message) => message["type"] === "status" && (message["data"] as { requestId?: string }).requestId === requestId);
    return { reply, status: status?.["data"] as Record<string, unknown> | undefined };
  }

  it("is honoured at the default floor, operator, for an operator and an operator-rank extension role", async () => {
    configureMultiUser();
    runTurnMock.mockImplementation(async () => turnOutput());
    for (const account of [olga, mia]) {
      runTurnMock.mockClear();
      const { reply } = await sendAuto(account);
      expect(reply.payload).toMatchObject({ accepted: true });
      expect(runTurnMock).toHaveBeenCalledTimes(1);
      expect(runTurnMock.mock.calls[0]![0].autoApprove).toBe(true);
      expect(runTurnMock.mock.calls[0]![0].userMessage).toBe("clean up the build folder");
    }
  });

  it("starts no turn below the floor, says why, and audits it", async () => {
    configureMultiUser({ overrides: { autoApproveMinRole: "admin" } });
    runTurnMock.mockImplementation(async () => turnOutput());
    const { events, stop } = rbacDenials();
    try {
      const { reply, status } = await sendAuto(olga);
      expect(reply).toMatchObject({ ok: true, payload: { accepted: false, requestId: "req-auto-olga" } });
      expect(status).toEqual({ status: "blocked", requestId: "req-auto-olga", response: "--auto requires role admin" });
      expect(runTurnMock).not.toHaveBeenCalled();
      expect(events).toHaveLength(1);
      expect(events[0]!.data).toMatchObject({ surface: "rpc", method: "chat.send", flag: "--auto", role: "operator", required: "admin" });
    } finally {
      stop();
    }
    // At the floor it runs, with the approvals waived.
    const atFloor = await sendAuto(root);
    expect(atFloor.reply.payload).toMatchObject({ accepted: true });
    expect(runTurnMock.mock.calls[0]![0].autoApprove).toBe(true);
  });

  it("is honoured for nobody when disabled, with auth off too", async () => {
    configureMultiUser({ overrides: { autoApproveMinRole: "disabled" } });
    const { reply, status } = await sendAuto(root);
    expect(reply.payload).toMatchObject({ accepted: false });
    expect(status).toMatchObject({ status: "blocked", response: "--auto is disabled on this gateway" });

    configure(null, { overrides: { autoApproveMinRole: "disabled" } });
    const tab = openSingleOperatorSocket();
    const created = await tab.call("session.create", {});
    const offReply = await tab.call("chat.send", { sessionId: (created.payload as { sessionId: string }).sessionId, message: "--auto go" });
    expect(offReply.payload).toMatchObject({ accepted: false });
    expect(runTurnMock).not.toHaveBeenCalled();
  });

  it("changes nothing with auth off at the default floor", async () => {
    configure(null);
    runTurnMock.mockImplementation(async () => turnOutput());
    const tab = openSingleOperatorSocket();
    const created = await tab.call("session.create", {});
    const reply = await tab.call("chat.send", { sessionId: (created.payload as { sessionId: string }).sessionId, message: "--auto go" });
    expect(reply.payload).toMatchObject({ accepted: true });
    expect(runTurnMock.mock.calls[0]![0].autoApprove).toBe(true);
  });
});

describe("session.create takes the client's channel only in a safe shape", () => {
  it("refuses a channel whose turns are trusted as workflow text, and a malformed one, for any caller", async () => {
    expect([...mods.turnPrepare.TRUSTED_WORKFLOW_CHANNELS]).toEqual(["scene"]);
    const refusesEach = async (tab: { call: ReturnType<typeof caller> }) => {
      expect(await tab.call("session.create", { channel: "scene" })).toMatchObject({ ok: false, error: "Error: Invalid channel: scene is reserved for scene and job runs" });
      for (const channel of ["x".repeat(200), "", "web chat", "webchat\n", "<script>", { nested: true }]) {
        expect(await tab.call("session.create", { channel }), JSON.stringify(channel)).toMatchObject({ ok: false, error: "Error: Invalid channel" });
      }
    };
    configureMultiUser();
    await refusesEach(await openSocket(root));
    configure(null);
    await refusesEach(openSingleOperatorSocket());
    expect(mods.sessions.getAllSessions({ includeArchived: true })).toEqual([]);
  });

  it("keeps the channels clients use: webchat (the default), eval and webchat:agui", async () => {
    configureMultiUser();
    const tab = await openSocket(olga);
    for (const channel of ["webchat", "eval", "webchat:agui", undefined]) {
      const created = await tab.call("session.create", channel === undefined ? {} : { channel });
      expect(created.ok, String(channel)).toBe(true);
      expect(mods.sessions.getSessionRecord((created.payload as { sessionId: string }).sessionId)!.channel).toBe(channel ?? "webchat");
    }
  });
});

describe("gateway.status counts the sessions the caller may see", () => {
  it("counts an operator's own active sessions and unowned ones, as session.list, and every active session for an admin", async () => {
    configureMultiUser();
    const create = (userId: string, account: string) => mods.sessions.createSession({ channel: "webchat", userId, account, workspacePath: workspace });
    create("olga", olga.id);
    create("olga", olga.id);
    mods.sessions.archiveSession(create("olga", olga.id).id);
    create("vic", vic.id);
    create("root", root.id);
    // No owner: every caller lists it.
    mods.sessions.createSession({ channel: "webchat", workspacePath: workspace });
    const status = async (account: typeof olga) => ((await (await openSocket(account)).call("gateway.status")).payload as { sessions: number }).sessions;
    expect(await status(olga)).toBe(3);
    expect(await status(vic)).toBe(2);
    expect(await status(root)).toBe(5);
  });

  it("counts every active session with auth off", async () => {
    configure(null);
    mods.sessions.createSession({ channel: "webchat", userId: "a" });
    mods.sessions.createSession({ channel: "webchat", userId: "b" });
    expect(((await openSingleOperatorSocket().call("gateway.status")).payload as { sessions: number }).sessions).toBe(2);
  });
});
