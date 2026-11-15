import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bcrypt from "bcryptjs";
import WebSocket from "ws";
import { PRODUCT } from "../product/index.js";
import { testAccount, type TestAccount } from "./support/test-account.js";

/**
 * A role that neither core nor any loaded extension declares fails closed under multi-user auth.
 *
 * normalizeRole mapped such a role to operator, so that tokens from before roles kept working. When
 * an extension failed to load (a malformed manifest, a tool that shadows a built-in) or was no longer
 * installed, its roles went with it, and every account holding one signed in as an operator: a
 * fork's rank-10 patient read the account roster and drove sessions, and a typo in an account's role
 * made it an operator. Such an account now cannot sign in (401 after its password), every token that
 * carries such a role is refused wherever a revoked token is (REST 401, /ws closed with 4401, the
 * raw surfaces 401), and the gateway logs an error that names the role and the account id. Core
 * roles, the roles of extensions that did load, tokens without a role claim and single-operator mode
 * (auth off) are unchanged. This runs the real gateway on a loopback port.
 */

// The gateway's auth log lines at error level, recorded.
const authErrors = vi.hoisted(() => [] as Array<{ fields: Record<string, unknown>; message: string }>);
vi.mock("../logger.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../logger.js")>();
  return {
    ...original,
    childLogger: (name: string, meta?: Record<string, unknown>) => {
      const logger = original.childLogger(name, meta);
      if (name !== "gateway:auth") return logger;
      return new Proxy(logger, {
        get(target, property, receiver) {
          if (property === "error") {
            return (fields: unknown, message?: unknown) => {
              authErrors.push({ fields: (fields ?? {}) as Record<string, unknown>, message: String(message ?? "") });
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });
    },
  };
});

const SECRET = "u".repeat(40);
const PASSWORD = "correct-horse-battery";
// Cost 4: the sign-in route compares against any cost, and these tests sign in often.
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);

function withPassword(account: TestAccount): TestAccount {
  return { ...account, record: { ...account.record, passwordHash: PASSWORD_HASH } };
}

const vera = withPassword(testAccount("vera", "viewer"));
const otto = withPassword(testAccount("otto", "operator"));
const ada = withPassword(testAccount("ada", "admin"));
// The roles of the fork extension "praxis": a physician above operator rank, a patient at viewer rank.
const dora = withPassword(testAccount("dora", "doctor"));
const pat = withPassword(testAccount("pat", "patient"));
// A role that no extension declares: a typo of "doctor".
const tom = withPassword(testAccount("tom", "docter"));
// A role named after a property every object has.
const cora = withPassword(testAccount("cora", "constructor"));
const ACCOUNTS = [vera, otto, ada, dora, pat, tom, cora];
const PRAXIS_ROLES = [
  { name: "doctor", description: "a physician", rank: 80 },
  { name: "patient", description: "a patient", rank: 10 },
];

const ENV_KEYS = [
  "SAI_CONFIG_PATH",
  "SAI_MUTABLE_CONFIG_PATH",
  "SAI_JWT_SECRET",
  "SAI_MASTER_KEY",
  "SAI_CRED_STORE",
  "SAI_AUDIT_LOG",
  "SAI_SESSION_STORE",
  "SAI_EXTENSIONS_DIR",
  "BROWSER_VNC_WS_URL",
] as const;
const savedEnv = new Map<string, string | undefined>();

let tempDir = "";
let configPath = "";
let port = 0;
let baseUrl = "";
let wsBase = "";
let gateway: { start(): Promise<void>; stop(): Promise<void> };
let mods: Awaited<ReturnType<typeof loadModules>>;
const dirs: string[] = [];
const openSockets: WebSocket[] = [];

async function loadModules() {
  // Sequential: these modules import each other.
  const gatewayModule = await import("../gateway/index.js");
  const auth = await import("../gateway/auth.js");
  const loader = await import("../config/loader.js");
  const registry = await import("../runtime/account-registry.js");
  const extension = await import("../extension/index.js");
  const extensionLoader = await import("../extension/loader.js");
  const groups = await import("../tools/groups.js");
  const audit = await import("../audit/logger.js");
  const accounts = await import("../runtime/accounts.js");
  return { gatewayModule, auth, loader, registry, extension, extensionLoader, groups, audit, accounts };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const free = typeof address === "object" && address ? address.port : 0;
      server.close(() => (free >= 1024 ? resolve(free) : reject(new Error(`unusable port ${free}`))));
    });
  });
}

const MULTI_USER = { enabled: true, users: ACCOUNTS.map((account) => account.record) };

/** The one config file, read and written by the loader (SAI_MUTABLE_CONFIG_PATH is the same file). */
function writeConfig(auth: Record<string, unknown> = MULTI_USER): void {
  writeFileSync(configPath, JSON.stringify({
    gateway: { port, jwtSecret: SECRET },
    workspacePath: join(tempDir, "workspace"),
    agents: { defaultContainerized: false },
    auth,
    mcp: { expose: { enabled: true } },
    a2a: { enabled: true },
  }), "utf8");
  mods?.loader.resetConfigForTests();
  mods?.registry.resetAccountRegistryForTests();
}

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  tempDir = mkdtempSync(join(tmpdir(), "starlingai-unknown-role-"));
  configPath = join(tempDir, "starlingai.json");
  port = await freePort();
  writeConfig();
  process.env["SAI_CONFIG_PATH"] = configPath;
  process.env["SAI_MUTABLE_CONFIG_PATH"] = configPath;
  delete process.env["SAI_JWT_SECRET"];
  delete process.env["SAI_EXTENSIONS_DIR"];
  process.env["SAI_MASTER_KEY"] = "m".repeat(32);
  process.env["SAI_CRED_STORE"] = join(tempDir, PRODUCT.stateDirName, "credentials.enc");
  process.env["SAI_AUDIT_LOG"] = join(tempDir, PRODUCT.stateDirName, "audit.jsonl");
  process.env["SAI_SESSION_STORE"] = join(tempDir, "sessions.json");
  // No browser-vnc backend: an admitted VNC caller gets the proxy's own "not configured" close.
  process.env["BROWSER_VNC_WS_URL"] = "";
  vi.resetModules();
  mods = await loadModules();
  gateway = mods.gatewayModule.createGateway();
  await gateway.start();
  baseUrl = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}`;
}, 60_000);

afterAll(async () => {
  await gateway?.stop();
  await mods?.audit.flushAuditLog();
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

afterEach(async () => {
  for (const ws of openSockets.splice(0)) ws.terminate();
  unloadExtensions();
  mods.extensionLoader.setExtensionImporterForTests(null);
  delete process.env["SAI_EXTENSIONS_DIR"];
  writeConfig();
  mods.auth.resetAuthStateForTests();
  // Refused sign-ins and sockets count against the loopback address's auth-failure budget.
  mods.auth.clearAuthFailures("127.0.0.1");
  mods.auth.clearAuthFailures("::ffff:127.0.0.1");
  authErrors.length = 0;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Loads the fork extension "praxis" through the real loader, its manifest changed by `manifest`. */
async function loadPraxis(manifest: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "starlingai-unknown-role-ext-"));
  dirs.push(dir);
  mkdirSync(join(dir, "praxis"));
  writeFileSync(join(dir, "praxis", "index.mjs"), "// discovery marker: the importer is injected\n");
  mods.extensionLoader.setExtensionImporterForTests(async () => ({
    default: { name: "praxis", version: "1.0.0", roles: PRAXIS_ROLES, ...manifest },
  }));
  process.env["SAI_EXTENSIONS_DIR"] = dir;
  return mods.extensionLoader.loadCoreExtensions();
}

/** Forgets every extension, as a restart does before the loader runs again. */
function unloadExtensions(): void {
  mods.extension._resetExtensionsForTests();
  mods.extensionLoader._resetExtensionLoaderForTests();
  mods.groups._resetToolGroupsForTests();
}

function setRole(username: string, role: string): void {
  mods.loader.updateConfig((raw) => {
    const auth = raw["auth"] as { users: Array<{ username: string; role: string }> };
    for (const user of auth.users) if (user.username === username) user.role = role;
  });
}

const tokenOf = (account: TestAccount) => mods.auth.createToken(String(account.record["username"]), account.claims);

interface Answer {
  /** The HTTP status, 101 for a completed upgrade, or 0 when the server dropped the connection unanswered. */
  status: number;
  body?: Record<string, unknown>;
  /** WebSocket only: the close code, or "open" when the server greeted the socket. */
  ws?: number | "open";
}

async function http(method: string, path: string, token: string | null, body?: string, headers: Record<string, string> = {}): Promise<Answer> {
  const all: Record<string, string> = { ...headers };
  if (token) all["Authorization"] = `Bearer ${token}`;
  if (body !== undefined) all["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, { method, headers: all, ...(body !== undefined ? { body } : {}) });
  const text = await response.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { text };
  }
  return { status: response.status, body: parsed };
}

async function login(username: string, password = PASSWORD): Promise<Answer> {
  return http("POST", "/api/auth/login", null, JSON.stringify({ username, password }));
}

/** Opens a WebSocket with `?token=` and reports how the server answered: a refusal, a close code, or a greeting. */
async function socket(path: string, token: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}${path}?token=${encodeURIComponent(token)}`);
    let upgraded = false;
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`no answer on ${path}`));
    }, 10_000);
    const done = (answer: Answer) => {
      clearTimeout(timer);
      resolve(answer);
    };
    ws.on("upgrade", () => { upgraded = true; });
    ws.on("unexpected-response", (_req, res) => {
      done({ status: res.statusCode ?? 0 });
      ws.terminate();
    });
    ws.on("message", (raw) => {
      if ((JSON.parse(String(raw)) as { type?: string }).type === "hello-ok") {
        done({ status: 101, ws: "open" });
        ws.close();
      }
    });
    ws.on("close", (code) => done(upgraded ? { status: 101, ws: code } : { status: 0 }));
    ws.on("error", () => { /* reported through unexpected-response or close */ });
  });
}

/** A dashboard socket that the server greeted, kept open to send RPC calls on. */
async function openDashboard(token: string) {
  const ws = new WebSocket(`${wsBase}/ws?token=${encodeURIComponent(token)}`);
  openSockets.push(ws);
  const messages: Array<Record<string, unknown>> = [];
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.on("close", (code, reason) => resolve({ code, reason: String(reason) }));
  });
  ws.on("message", (raw) => messages.push(JSON.parse(String(raw)) as Record<string, unknown>));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no hello-ok")), 10_000);
    ws.on("message", (raw) => {
      if ((JSON.parse(String(raw)) as { type?: string }).type === "hello-ok") {
        clearTimeout(timer);
        resolve();
      }
    });
    ws.on("close", (code) => {
      clearTimeout(timer);
      reject(new Error(`closed with ${code} before hello-ok`));
    });
  });
  let counter = 0;
  const call = (method: string, params: Record<string, unknown> = {}) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = `${method}-${++counter}`;
    const timer = setTimeout(() => reject(new Error(`no answer to ${method}`)), 10_000);
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(String(raw)) as Record<string, unknown>;
      if (message["type"] !== "rpc.response" || message["id"] !== id) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(message);
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { ws, messages, closed, call };
}

/**
 * The surfaces the Node server answers before the /api middleware, each with a request its handler
 * answers at once (no turn, no agent run), and the answers of an admitted and of a refused caller.
 */
const RAW_SURFACES: Array<{
  name: string;
  call: (token: string) => Promise<Answer>;
  /** The request for the refusal, where it differs. */
  refusedCall?: (token: string) => Promise<Answer>;
  admitted: (answer: Answer) => void;
  refused: (answer: Answer) => void;
}> = [
  {
    name: "POST /api/chat/stream",
    // Admitted, a body that is no JSON gets the handler's 400, and no turn runs.
    call: (token) => http("POST", "/api/chat/stream", token, "not json"),
    // The stream reads its body before it resolves the caller, so the refusal is shown with a
    // well-formed one: the caller is refused before any turn could start.
    refusedCall: (token) => http("POST", "/api/chat/stream", token, JSON.stringify({ message: "hello" })),
    admitted: (answer) => expect(answer).toMatchObject({ status: 400, body: { error: "Invalid JSON body" } }),
    refused: (answer) => expect(answer).toMatchObject({ status: 401, body: { error: "Unauthorized" } }),
  },
  {
    name: "/mcp",
    call: (token) => http("POST", "/mcp", token, "{}", { "mcp-session-id": "no-such-session" }),
    admitted: (answer) => expect(answer).toMatchObject({ status: 404, body: { error: "Unknown MCP session" } }),
    refused: (answer) => expect(answer).toMatchObject({ status: 401, body: { error: "Unauthorized" } }),
  },
  {
    name: "POST /a2a/v1",
    call: (token) => http("POST", "/a2a/v1", token, "not json"),
    admitted: (answer) => expect(answer).toMatchObject({ status: 400, body: { jsonrpc: "2.0", error: { code: -32700 } } }),
    refused: (answer) => expect(answer).toMatchObject({ status: 401, body: { jsonrpc: "2.0", error: { code: -32002 } } }),
  },
  {
    name: "POST /a2a/agents/:name",
    call: (token) => http("POST", "/a2a/agents/x", token, JSON.stringify({ jsonrpc: "2.0", method: "nope", id: 1 })),
    admitted: (answer) => expect(answer).toMatchObject({ status: 400, body: { error: { code: -32601 } } }),
    refused: (answer) => expect(answer).toMatchObject({ status: 401, body: { jsonrpc: "2.0", error: { code: -32001 } } }),
  },
  {
    name: "/ws/browser-vnc/:id",
    call: (token) => socket("/ws/browser-vnc/x", token),
    // Admitted, the proxy itself answers: no backend is configured here.
    admitted: (answer) => expect(answer).toEqual({ status: 101, ws: 4404 }),
    refused: (answer) => expect(answer).toEqual({ status: 401 }),
  },
];

const UNDECLARED_ROLE_LOG = /declared by neither core nor any loaded extension.*may have failed to load/;

/** The fields of each "role nobody declares" error line the gateway logged. */
function undeclaredRoleLines(): Array<Record<string, unknown>> {
  return authErrors.filter((entry) => UNDECLARED_ROLE_LOG.test(entry.message)).map((entry) => entry.fields);
}

async function auditEvents(type: string): Promise<Array<{ userId?: string; data: Record<string, unknown> }>> {
  await mods.audit.flushAuditLog();
  return readFileSync(process.env["SAI_AUDIT_LOG"]!, "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as { type: string; userId?: string; data: Record<string, unknown> })
    .filter((event) => event.type === type);
}

describe("under multi-user auth, a role that neither core nor any loaded extension declares", () => {
  it("keeps an account of an extension that is not loaded from signing in: 401 after its password, logged with the role and the account id", async () => {
    // No extension is loaded: doctor and patient are nobody's roles.
    const refused = await login("dora");
    expect(refused.status).toBe(401);
    expect(refused.body).toEqual({ error: mods.auth.UNDECLARED_ROLE_REFUSAL });
    expect((await login("pat")).status).toBe(401);
    // A wrong password gets the plain refusal: only whoever knows the password learns about the role.
    expect(await login("dora", "not-the-password")).toEqual({ status: 401, body: { error: "Invalid username or password" } });

    expect(undeclaredRoleLines()).toEqual([
      { role: "doctor", account: dora.id },
      { role: "patient", account: pat.id },
    ]);
    // The line names the role and the account id: no username, nothing of the password.
    for (const entry of authErrors) expect(JSON.stringify(entry)).not.toContain(PASSWORD);
    const refusals = await auditEvents("auth_account_refused");
    expect(refusals).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: "dora", data: { username: "dora", account: dora.id, role: "doctor", reason: mods.auth.UNDECLARED_ROLE_REFUSAL } }),
    ]));
  });

  it("refuses a token that carries such a role everywhere a revoked token is refused: REST 401, /ws closed with 4401, each raw surface", async () => {
    // Tokens minted while an extension declared the roles.
    const doctorToken = await tokenOf(dora);
    const patientToken = await tokenOf(pat);

    // REST: the /api middleware refuses it as it refuses a deleted account's token.
    expect(await http("GET", "/api/auth/me", doctorToken)).toEqual({ status: 401, body: { error: "Unauthorized (account no longer valid)" } });
    // Not raised to operator: the roster an operator reads is refused to both, the patient included.
    expect((await http("GET", "/api/auth/users", doctorToken)).status).toBe(401);
    expect((await http("GET", "/api/auth/users", patientToken)).status).toBe(401);
    // The dashboard socket closes as for any other caller that does not sign in.
    expect(await socket("/ws", doctorToken)).toEqual({ status: 101, ws: 4401 });
    expect(await socket("/ws", patientToken)).toEqual({ status: 101, ws: 4401 });
    for (const surface of RAW_SURFACES) {
      try {
        surface.refused(await (surface.refusedCall ?? surface.call)(doctorToken));
      } catch (err) {
        throw new Error(`${surface.name}: ${String(err)}`);
      }
    }
    // A queued job or a scheduled run of the account gets no role: it no longer signs in.
    expect(mods.auth.storedAccountRole({ userId: "dora", account: dora.id })).toBeNull();
    expect(undeclaredRoleLines()).toEqual(expect.arrayContaining([{ role: "doctor", account: dora.id }, { role: "patient", account: pat.id }]));
  });

  it("closes an open dashboard socket with 4401 at its next message once its account holds a role nobody declares", async () => {
    expect(await loadPraxis()).toMatchObject({ loaded: 1, failed: 0 });
    const tab = await openDashboard(await tokenOf(dora));
    expect((await tab.call("session.list")).ok).toBe(true);

    // An admin edits the account's role, and mistypes it.
    setRole("dora", "docter");
    expect(await tab.call("session.list")).toMatchObject({ ok: false, error: "Unauthorized (account no longer valid)" });
    expect(await tab.closed).toEqual({ code: 4401, reason: "Unauthorized (account no longer valid)" });
    expect(undeclaredRoleLines()).toEqual([{ role: "docter", account: dora.id }]);
  });

  it("refuses an account of an extension that failed to load, and every token it holds, instead of raising it to operator", async () => {
    // While the extension loads, the patient signs in at its own rank, below the roster.
    expect(await loadPraxis()).toMatchObject({ loaded: 1, failed: 0 });
    const patientToken = (await login("pat")).body?.["token"] as string;
    const doctorToken = (await login("dora")).body?.["token"] as string;
    expect(typeof patientToken).toBe("string");
    expect((await http("GET", "/api/auth/users", patientToken)).status).toBe(403);

    // The next boot: the manifest has a mistake the loader does not work around (a tool name it
    // refuses), so the extension is skipped, and its roles with it.
    unloadExtensions();
    const tool = { name: "Not A Tool Name", description: "x", parameters: {}, tier: 0, execute: async () => ({ success: true, output: "" }) };
    expect(await loadPraxis({ tools: [tool] })).toMatchObject({ loaded: 0, failed: 1 });
    expect(mods.extension.listExtensionRoles()).toEqual([]);

    // Neither account signs in, and neither earlier token is anyone: not the patient, not an operator.
    expect(await login("pat")).toEqual({ status: 401, body: { error: mods.auth.UNDECLARED_ROLE_REFUSAL } });
    expect((await login("dora")).status).toBe(401);
    expect(await http("GET", "/api/auth/users", patientToken)).toEqual({ status: 401, body: { error: "Unauthorized (account no longer valid)" } });
    expect((await http("GET", "/api/auth/me", doctorToken)).status).toBe(401);
    expect(await socket("/ws", patientToken)).toEqual({ status: 101, ws: 4401 });
    expect(await socket("/ws", doctorToken)).toEqual({ status: 101, ws: 4401 });
    expect(undeclaredRoleLines()).toEqual(expect.arrayContaining([{ role: "patient", account: pat.id }, { role: "doctor", account: dora.id }]));

    // Restored, the extension declares the roles again: the same tokens are the same accounts.
    unloadExtensions();
    expect(await loadPraxis()).toMatchObject({ loaded: 1, failed: 0 });
    expect(await http("GET", "/api/auth/me", doctorToken)).toMatchObject({ status: 200, body: { username: "dora", role: "doctor", account: dora.id } });
    expect((await http("GET", "/api/auth/users", patientToken)).status).toBe(403);
  });

  it("refuses a misspelt role and a role named after an object property", async () => {
    expect(await login("tom")).toEqual({ status: 401, body: { error: mods.auth.UNDECLARED_ROLE_REFUSAL } });
    expect((await http("GET", "/api/auth/me", await tokenOf(tom))).status).toBe(401);
    // "constructor" is a property of every object, not a built-in role: it was taken for one.
    expect((await login("cora")).status).toBe(401);
    expect((await http("GET", "/api/auth/me", await tokenOf(cora))).status).toBe(401);
    expect(mods.auth.declaredRole("constructor")).toBeUndefined();
    expect(mods.auth.roleRank("toString")).toBe(-1);
    expect(mods.auth.roleRank("constructor")).toBe(-1);
    expect(undeclaredRoleLines()).toEqual(expect.arrayContaining([{ role: "docter", account: tom.id }, { role: "constructor", account: cora.id }]));
  });

  it("logs each account and role once, however often its token is refused", async () => {
    const token = await tokenOf(dora);
    for (let attempt = 0; attempt < 3; attempt += 1) expect((await http("GET", "/api/auth/me", token)).status).toBe(401);
    expect((await login("dora")).status).toBe(401);
    expect(await socket("/ws", token)).toEqual({ status: 101, ws: 4401 });
    expect(undeclaredRoleLines()).toEqual([{ role: "doctor", account: dora.id }]);
  });

  it("refuses an extension credential store's user whose role nobody declares, at sign-in and on its tokens", async () => {
    // The store is one extension; the role "nurse" is another's ("ward"), which did not load. And a
    // record with no role at all: a store has no default role to give it.
    const users = {
      kim: { id: "u-kim", username: "kim", role: "nurse" },
      lou: { id: "u-lou", username: "lou" } as { id: string; username: string; role: string },
    };
    mods.extension._recordLoadedExtension(
      { name: "store", version: "1", toolNames: [], auditEvents: [], roles: [], loadedAt: "", source: "test" },
      {
        name: "store",
        version: "1",
        authProvider: {
          verifyCredentials: async (username: string, password: string) =>
            (password === PASSWORD ? Object.values(users).find((user) => user.username === username) ?? null : null),
          getUserById: (id: string) => Object.values(users).find((user) => user.id === id) ?? null,
        },
      },
    );
    expect(await login("kim")).toEqual({ status: 401, body: { error: mods.auth.UNDECLARED_ROLE_REFUSAL } });
    expect((await login("lou")).status).toBe(401);
    const kimToken = await mods.auth.createToken("u-kim", { role: "nurse" });
    expect((await http("GET", "/api/auth/me", kimToken)).status).toBe(401);
    expect(await socket("/ws", kimToken)).toEqual({ status: 101, ws: 4401 });
    expect((await http("GET", "/api/auth/me", await mods.auth.createToken("u-lou", {}))).status).toBe(401);
    const storeAccount = mods.accounts.extensionAccountId("u-kim");
    expect(undeclaredRoleLines()).toEqual(expect.arrayContaining([
      { role: "nurse", account: storeAccount },
      { role: "(none)", account: mods.accounts.extensionAccountId("u-lou") },
    ]));

    // Once "ward" declares the role, kim signs in with it, and the earlier token is kim again.
    mods.extension._recordLoadedExtension(
      { name: "ward", version: "1", toolNames: [], auditEvents: [], roles: [], loadedAt: "", source: "test" },
      { name: "ward", version: "1", roles: [{ name: "nurse", description: "a nurse", rank: 50 }] },
    );
    expect(await login("kim")).toMatchObject({ status: 200, body: { role: "nurse" } });
    expect(await http("GET", "/api/auth/me", kimToken)).toMatchObject({ status: 200, body: { username: "u-kim", role: "nurse", account: storeAccount } });
  });

  it("refuses a bootstrap token, or a token of the empty-store window, whose role claim nobody declares; one with no role claim stays an operator", async () => {
    // sai token --role doctor, with no extension declaring it.
    expect((await http("GET", "/api/auth/me", await mods.auth.createToken("admin", { role: "doctor", bst: true }))).status).toBe(401);
    expect(await http("GET", "/api/auth/me", await mods.auth.createToken("admin", { bst: true })))
      .toEqual({ status: 200, body: { username: "admin", role: "operator", principal: "bootstrap" } });
    expect(undeclaredRoleLines()).toEqual([{ role: "doctor", principal: "bootstrap" }]);

    // No account at all, the window in which the first one is created. An extension store's token is
    // one of these once that extension no longer loads (no aid, no bst): its role claim still counts.
    writeConfig({ enabled: true, users: [] });
    const storeToken = await mods.auth.createToken("u-17", { role: "doctor", kvnr: "A123456789" });
    expect((await http("GET", "/api/auth/me", storeToken)).status).toBe(401);
    expect(await socket("/ws", storeToken)).toEqual({ status: 101, ws: 4401 });
    expect(await http("GET", "/api/auth/me", await mods.auth.createToken("u-18", {}))).toEqual({ status: 200, body: { username: "u-18", role: "operator" } });
    expect(await http("GET", "/api/auth/me", await mods.auth.createToken("u-19", { role: "viewer" }))).toEqual({ status: 200, body: { username: "u-19", role: "viewer" } });
  });
});

describe("what a role nobody declares does not change", () => {
  it("signs in an account whose role a loaded extension declares, as before", async () => {
    expect(await loadPraxis()).toMatchObject({ loaded: 1, failed: 0 });
    const signedIn = await login("dora");
    expect(signedIn).toMatchObject({ status: 200, body: { username: "dora", role: "doctor" } });
    const token = signedIn.body?.["token"] as string;
    expect(await http("GET", "/api/auth/me", token)).toMatchObject({ status: 200, body: { username: "dora", role: "doctor", account: dora.id } });
    // At rank 80 it reads the roster, as an operator does; the patient, at rank 10, does not.
    expect((await http("GET", "/api/auth/users", token)).status).toBe(200);
    expect((await http("GET", "/api/auth/users", await tokenOf(pat))).status).toBe(403);
    expect(await socket("/ws", token)).toEqual({ status: 101, ws: "open" });
    for (const surface of RAW_SURFACES) {
      try {
        surface.admitted(await surface.call(token));
      } catch (err) {
        throw new Error(`${surface.name}: ${String(err)}`);
      }
    }
    expect(mods.auth.storedAccountRole({ userId: "dora", account: dora.id })).toBe("doctor");
    expect(undeclaredRoleLines()).toEqual([]);
  });

  it("signs in the core roles as before, with no extension loaded", async () => {
    for (const account of [vera, otto, ada]) {
      const role = String(account.record["role"]);
      const signedIn = await login(String(account.record["username"]));
      expect(signedIn, role).toMatchObject({ status: 200, body: { role } });
      const token = signedIn.body?.["token"] as string;
      expect(await http("GET", "/api/auth/me", token), role).toMatchObject({ status: 200, body: { role, account: account.id } });
      expect(await socket("/ws", token), role).toEqual({ status: 101, ws: "open" });
    }
    // An operator reaches every raw surface's handler.
    const operatorToken = await tokenOf(otto);
    for (const surface of RAW_SURFACES) {
      try {
        surface.admitted(await surface.call(operatorToken));
      } catch (err) {
        throw new Error(`${surface.name}: ${String(err)}`);
      }
    }
    expect(undeclaredRoleLines()).toEqual([]);
  });

  it("keeps single-operator mode as it was with auth off: the token's claims stand, a role nobody declares counting as operator", async () => {
    writeConfig({ enabled: false, users: [] });
    const token = await mods.auth.createToken("dora", { role: "doctor" });
    expect(await http("GET", "/api/auth/me", token)).toEqual({ status: 200, body: { username: "dora", role: "operator" } });
    expect(await socket("/ws", token)).toEqual({ status: 101, ws: "open" });
    expect(await http("GET", "/api/auth/me", await mods.auth.createToken("vera", { role: "viewer" }))).toEqual({ status: 200, body: { username: "vera", role: "viewer" } });
    // Password sign-in stays off with auth off.
    expect((await login("dora")).status).toBe(503);
    expect(undeclaredRoleLines()).toEqual([]);
  });

  it("reads a role claim as before where it is not refused: a declared one as it is, none as operator", () => {
    expect(mods.auth.normalizeRole(undefined)).toBe("operator");
    expect(mods.auth.normalizeRole("viewer")).toBe("viewer");
    expect(mods.auth.normalizeRole("doctor")).toBeUndefined();
    expect(mods.auth.normalizeRole(null)).toBeUndefined();
    expect(mods.auth.normalizeRole(42)).toBeUndefined();
    // A stored role has no default.
    expect(mods.auth.declaredRole(undefined)).toBeUndefined();
    // With auth off a role nobody declares counts as operator, as it always has.
    expect(mods.auth.singleOperatorRole("doctor")).toBe("operator");
    expect(mods.auth.singleOperatorRole("viewer")).toBe("viewer");
    mods.extension._recordLoadedExtension(
      { name: "praxis", version: "1", toolNames: [], auditEvents: [], roles: PRAXIS_ROLES, loadedAt: "", source: "test" },
      { name: "praxis", version: "1", roles: PRAXIS_ROLES },
    );
    expect(mods.auth.normalizeRole("doctor")).toBe("doctor");
    expect(mods.auth.declaredRole("patient")).toBe("patient");
    expect(mods.auth.roleRank("doctor")).toBe(80);
  });
});
