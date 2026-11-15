import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Server as NetServer, connect as connectTcp, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import WebSocket from "ws";
import { PRODUCT } from "../product/index.js";
import type { RoutePolicy } from "../gateway/route-policies.js";
import { testAccount } from "./support/test-account.js";

/**
 * Route policies reach the surfaces the Node server answers before Hono.
 *
 * The policy gate was Hono middleware on /api/*. The AG-UI stream (POST /api/chat/stream), the MCP
 * endpoint, the A2A routes, the agent card and the two WebSocket upgrades are answered by the
 * createServer handler or the upgrade listener and never reach Hono, so a policy an extension
 * declared for them was never consulted: a fork could not keep a low role off them. This runs the
 * real gateway on a loopback port and walks each surface under a deny policy and a roles policy.
 */

const SECRET = "r".repeat(40);
const viewer = testAccount("policy-viewer", "viewer");
const operator = testAccount("policy-operator", "operator");
const admin = testAccount("policy-admin", "admin");
// A fork's role at operator rank, registered as an extension registers it: it passes the mutation
// gate, but no built-in role list admits it (extension roles never inherit).
const doctor = testAccount("policy-doctor", "doctor");

const ENV_KEYS = [
  "SAI_CONFIG_PATH",
  "SAI_MUTABLE_CONFIG_PATH",
  "SAI_JWT_SECRET",
  "SAI_MASTER_KEY",
  "SAI_CRED_STORE",
  "SAI_AUDIT_LOG",
  "SAI_SESSION_STORE",
  "BROWSER_VNC_WS_URL",
] as const;
const savedEnv = new Map<string, string | undefined>();

// The gateway listens on gateway.host: 127.0.0.1 unless configured, 0.0.0.0 in a container. Its
// test instance must not be reachable from the network, with test accounts and a test secret: every
// listen of this file goes to the loopback interface. listenRewritten marks the gateway's own listen
// (its configured port) on loopback, whichever of the two hosts it asked for; freePort()'s probe
// listens on port 0 and does not count.
const realListen = NetServer.prototype.listen;
let listenRewritten = false;
function listenOnLoopback(this: NetServer, ...args: unknown[]): NetServer {
  if (args[1] === "0.0.0.0") args[1] = "127.0.0.1";
  if (port !== 0 && args[0] === port && args[1] === "127.0.0.1") listenRewritten = true;
  return (realListen as (...rest: unknown[]) => NetServer).apply(this, args);
}

// A token whose resolution a test holds open. The gateway resolves a caller asynchronously (the
// token's signature, the stores), and a test lands a connection reset inside that wait. Every other
// token resolves exactly as it would.
const HELD_TOKEN = "held-caller-token";
let heldResolution: { entered: () => void; released: Promise<void> } | null = null;
function holdNextResolution(): { entered: Promise<void>; release: () => void } {
  let entered!: () => void;
  let release!: () => void;
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  heldResolution = { entered, released };
  return { entered: enteredPromise, release: () => { heldResolution = null; release(); } };
}

let tempDir = "";
let port = 0;
let baseUrl = "";
let wsBase = "";
let gateway: { start(): Promise<void>; stop(): Promise<void> };
let policies: typeof import("../gateway/route-policies.js");
let auth: typeof import("../gateway/auth.js");
let audit: typeof import("../audit/logger.js");
let extensions: typeof import("../extension/index.js");
let knowledgeBaseRoutes: typeof import("../gateway/knowledge-base-routes.js");
let accountMigrationRoutes: typeof import("../gateway/account-migration-routes.js");
const tokens = { viewer: "", operator: "", admin: "", doctor: "" };

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

async function waitForHealth(url: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`gateway did not become ready: ${url}`);
}

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  NetServer.prototype.listen = listenOnLoopback as typeof realListen;
  tempDir = mkdtempSync(join(tmpdir(), "starlingai-raw-policy-"));
  port = await freePort();
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({
    gateway: { port, jwtSecret: SECRET },
    workspacePath: join(tempDir, "workspace"),
    agents: { defaultContainerized: false },
    auth: { enabled: true, users: [viewer.record, operator.record, admin.record, doctor.record] },
    mcp: { expose: { enabled: true } },
    a2a: { enabled: true },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configPath;
  process.env["SAI_MUTABLE_CONFIG_PATH"] = join(tempDir, "runtime.overrides.json");
  delete process.env["SAI_JWT_SECRET"];
  process.env["SAI_MASTER_KEY"] = "m".repeat(32);
  process.env["SAI_CRED_STORE"] = join(tempDir, PRODUCT.stateDirName, "credentials.enc");
  process.env["SAI_AUDIT_LOG"] = join(tempDir, PRODUCT.stateDirName, "audit.jsonl");
  process.env["SAI_SESSION_STORE"] = join(tempDir, "sessions.json");
  // No browser-vnc backend: an admitted VNC caller gets the proxy's own "not configured" close, and
  // nothing is dialled.
  process.env["BROWSER_VNC_WS_URL"] = "";

  vi.resetModules();
  vi.doMock("../gateway/auth.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../gateway/auth.js")>();
    return {
      ...actual,
      authenticatedUserFromToken: async (token: string) => {
        const hold = token === HELD_TOKEN ? heldResolution : null;
        if (hold) {
          hold.entered();
          await hold.released;
        }
        return actual.authenticatedUserFromToken(token);
      },
    };
  });
  const [gatewayModule, policyModule, authModule, auditModule, extensionModule, kbModule, migrationModule] = await Promise.all([
    import("../gateway/index.js"),
    import("../gateway/route-policies.js"),
    import("../gateway/auth.js"),
    import("../audit/logger.js"),
    import("../extension/index.js"),
    import("../gateway/knowledge-base-routes.js"),
    import("../gateway/account-migration-routes.js"),
  ]);
  policies = policyModule;
  auth = authModule;
  audit = auditModule;
  extensions = extensionModule;
  knowledgeBaseRoutes = kbModule;
  accountMigrationRoutes = migrationModule;
  const doctorRole = { name: "doctor", description: "a fork's role at operator rank", rank: 80 };
  extensions._recordLoadedExtension(
    { name: "test-extension", version: "1", toolNames: [], auditEvents: [], roles: [doctorRole], loadedAt: "", source: "test" },
    { name: "test-extension", version: "1", roles: [doctorRole] },
  );
  gateway = gatewayModule.createGateway();
  await gateway.start();
  expect(listenRewritten, "the gateway's listen went to the loopback interface").toBe(true);
  baseUrl = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}`;
  await waitForHealth(`${baseUrl}/healthz`);
  tokens.viewer = await auth.createToken(viewer.record["username"] as string, viewer.claims);
  tokens.operator = await auth.createToken(operator.record["username"] as string, operator.claims);
  tokens.admin = await auth.createToken(admin.record["username"] as string, admin.claims);
  tokens.doctor = await auth.createToken(doctor.record["username"] as string, doctor.claims);
}, 60_000);

afterAll(async () => {
  await gateway?.stop();
  await audit?.flushAuditLog();
  extensions?._resetExtensionsForTests();
  vi.doUnmock("../gateway/auth.js");
  NetServer.prototype.listen = realListen;
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

afterEach(() => {
  policies._resetRoutePoliciesForTests();
  // Anonymous WebSocket attempts count against the loopback address's auth-failure budget.
  auth.clearAuthFailures("127.0.0.1");
  auth.clearAuthFailures("::ffff:127.0.0.1");
});

function policy(p: RoutePolicy): void {
  policies.registerRoutePolicies("test-extension", [p]);
}

type Credential = { token: string | null; via: "header" | "query" };
const anonymous: Credential = { token: null, via: "header" };
const header = (token: string): Credential => ({ token, via: "header" });
const query = (token: string): Credential => ({ token, via: "query" });

/** What a caller got back: an HTTP status with its JSON body, or for a WebSocket that opened, how it ended. */
interface Answer {
  /** The HTTP status, 101 for a completed upgrade, or 0 when the server dropped the connection unanswered. */
  status: number;
  body?: Record<string, unknown>;
  /** WebSocket only: the close code, or "open" when the server greeted the socket and kept it. */
  ws?: number | "open";
}

function withCredential(path: string, credential: Credential, headers: Record<string, string>): string {
  if (!credential.token) return path;
  if (credential.via === "header") {
    headers["Authorization"] = `Bearer ${credential.token}`;
    return path;
  }
  return `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(credential.token)}`;
}

async function http(method: string, path: string, credential: Credential, init: { body?: string; headers?: Record<string, string> } = {}): Promise<Answer> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const url = `${baseUrl}${withCredential(path, credential, headers)}`;
  const response = await fetch(url, { method, headers, ...(init.body !== undefined ? { body: init.body } : {}) });
  const text = await response.text();
  let body: Record<string, unknown> | undefined;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { text };
  }
  return { status: response.status, body };
}

/** Opens a WebSocket and reports how the server answered: an HTTP refusal, a close code, a greeting, or nothing. */
async function socket(path: string, credential: Credential, extraHeaders: Record<string, string> = {}): Promise<Answer> {
  const headers: Record<string, string> = { ...extraHeaders };
  const url = `${wsBase}${withCredential(path, credential, headers)}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
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
      const message = JSON.parse(String(raw)) as { type?: string };
      if (message.type === "hello-ok") {
        done({ status: 101, ws: "open" });
        ws.close();
      }
    });
    // Closed without a handshake answer: the server dropped the connection.
    ws.on("close", (code) => done(upgraded ? { status: 101, ws: code } : { status: 0 }));
    ws.on("error", () => { /* reported through unexpected-response or close */ });
  });
}

interface Surface {
  name: string;
  /** The policy pattern a fork would write for it. */
  pattern: string;
  method?: string;
  kind: "http" | "ws";
  /** Sends one request as `credential`. */
  call(credential: Credential): Promise<Answer>;
  /** The handler's own answer to a caller it admits (the policy did not refuse). */
  admitted(answer: Answer): void;
  /** The handler's own answer to a caller without a token. */
  anonymous(answer: Answer): void;
  /** The gate's refusal with `status` (401/403). */
  refused(answer: Answer, status: 401 | 403): void;
  /**
   * The surface's own operator floor (raw-surface-role-defaults) refusing a viewer, with no policy at
   * all. Absent where a viewer reaches the handler.
   */
  viewerFloor?(answer: Answer): void;
}

function jsonError(answer: Answer, status: number): void {
  expect(answer.status).toBe(status);
  expect(answer.body?.["error"]).toEqual(expect.any(String));
}

function jsonRpcError(answer: Answer, status: number, code: number): void {
  expect(answer.status).toBe(status);
  expect(answer.body).toMatchObject({ jsonrpc: "2.0", error: { code }, id: null });
}

const SURFACES: Surface[] = [
  {
    name: "POST /api/chat/stream",
    pattern: "/api/chat/stream",
    method: "POST",
    kind: "http",
    call: (credential) => http("POST", "/api/chat/stream", credential, { body: "not json" }),
    admitted: (answer) => expect(answer).toMatchObject({ status: 400, body: { error: "Invalid JSON body" } }),
    anonymous: (answer) => expect(answer).toMatchObject({ status: 401, body: { error: "Unauthorized" } }),
    refused: (answer, status) => jsonError(answer, status),
  },
  {
    name: "/mcp",
    pattern: "/mcp",
    kind: "http",
    // An unknown session id: the handler's answer after its own auth, and no session is opened.
    call: (credential) => http("POST", "/mcp", credential, { body: "{}", headers: { "mcp-session-id": "no-such-session" } }),
    admitted: (answer) => expect(answer).toMatchObject({ status: 404, body: { error: "Unknown MCP session" } }),
    anonymous: (answer) => expect(answer).toMatchObject({ status: 401, body: { error: "Unauthorized" } }),
    refused: (answer, status) => jsonError(answer, status),
  },
  {
    name: "POST /a2a/v1",
    pattern: "/a2a/v1",
    kind: "http",
    call: (credential) => http("POST", "/a2a/v1", credential, { body: "not json" }),
    admitted: (answer) => jsonRpcError(answer, 400, -32700),
    anonymous: (answer) => jsonRpcError(answer, 401, -32002),
    refused: (answer, status) => jsonRpcError(answer, status, status === 401 ? -32002 : -32003),
  },
  {
    name: "POST /a2a/agents/:name",
    pattern: "/a2a/agents/:name",
    kind: "http",
    // An unknown JSON-RPC method: answered after the handler's own auth, and no agent runs.
    call: (credential) => http("POST", "/a2a/agents/x", credential, { body: JSON.stringify({ jsonrpc: "2.0", method: "nope", id: 1 }) }),
    admitted: (answer) => expect(answer).toMatchObject({ status: 400, body: { error: { code: -32601 } } }),
    anonymous: (answer) => jsonRpcError(answer, 401, -32001),
    refused: (answer, status) => jsonRpcError(answer, status, status === 401 ? -32001 : -32003),
    // The same status and code as the gate's refusal; the message tells the two apart.
    viewerFloor: (answer) => expect(answer).toMatchObject({ status: 403, body: { jsonrpc: "2.0", error: { code: -32003, message: "Operator role required" }, id: null } }),
  },
  {
    name: "GET /.well-known/agent-card.json",
    pattern: "/.well-known/agent-card.json",
    kind: "http",
    call: (credential) => http("GET", "/.well-known/agent-card.json", credential),
    admitted: (answer) => expect(answer).toMatchObject({ status: 200, body: { name: expect.any(String) } }),
    // The card is public: its handler asks for no token.
    anonymous: (answer) => expect(answer).toMatchObject({ status: 200, body: { name: expect.any(String) } }),
    refused: (answer, status) => jsonError(answer, status),
  },
  {
    name: "/ws",
    pattern: "/ws",
    kind: "ws",
    call: (credential) => socket("/ws", credential),
    admitted: (answer) => expect(answer).toEqual({ status: 101, ws: "open" }),
    anonymous: (answer) => expect(answer).toEqual({ status: 101, ws: 4401 }),
    // A browser only sees close codes, so the refusal is one.
    refused: (answer, status) => expect(answer).toEqual({ status: 101, ws: status === 403 ? 4403 : 4401 }),
  },
  {
    name: "/ws/browser-vnc/:id",
    pattern: "/ws/browser-vnc/*",
    kind: "ws",
    call: (credential) => socket("/ws/browser-vnc/x", credential),
    // Admitted, the proxy itself answers: no backend is configured here.
    admitted: (answer) => expect(answer).toEqual({ status: 101, ws: 4404 }),
    anonymous: (answer) => expect(answer).toEqual({ status: 401 }),
    refused: (answer, status) => expect(answer).toEqual({ status }),
    // The same 403 as the gate's refusal.
    viewerFloor: (answer) => expect(answer).toEqual({ status: 403 }),
  },
];

async function deniedAuditEvents(): Promise<Array<{ type: string; userId?: string; data: Record<string, unknown> }>> {
  await audit.flushAuditLog();
  return readFileSync(process.env["SAI_AUDIT_LOG"]!, "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as { type: string; userId?: string; data: Record<string, unknown> })
    .filter((event) => event.type === "rbac_denied");
}

describe("route policies on the surfaces answered before Hono", () => {
  it("leaves every surface as it was when no policy matches", async () => {
    for (const surface of SURFACES) {
      // A viewer reaches every handler but two: the legacy A2A agent route and the VNC bridge have an
      // operator floor of their own (raw-surface-role-defaults), which refuses it with no policy.
      const asViewer = await surface.call(header(tokens.viewer));
      if (surface.viewerFloor) surface.viewerFloor(asViewer);
      else surface.admitted(asViewer);
      surface.admitted(await surface.call(header(tokens.operator)));
      // The doctor ranks at operator: every floor lets it through, so a refusal of it below is the
      // policy's alone.
      surface.admitted(await surface.call(header(tokens.doctor)));
      surface.anonymous(await surface.call(anonymous));
    }
  });

  describe.each(SURFACES.map((surface) => [surface.name, surface] as const))("%s", (_name, surface) => {
    it("a deny policy refuses the listed role by header and by ?token=, and lets everyone else reach the handler", async () => {
      // Denied: the doctor, which the operator floors admit, so on the legacy A2A route and the VNC
      // bridge too only the policy refuses it (a viewer the floor refuses anyway).
      policy({ pattern: surface.pattern, ...(surface.method ? { method: surface.method } : {}), denyRoles: ["doctor"] });
      surface.refused(await surface.call(header(tokens.doctor)), 403);
      surface.refused(await surface.call(query(tokens.doctor)), 403);
      surface.admitted(await surface.call(header(tokens.operator)));
      // No token: the policy passes the caller on, and the handler's own auth answers.
      surface.anonymous(await surface.call(anonymous));
    });

    it("a roles policy admits only the listed role, and refuses a caller without a token itself", async () => {
      policy({ pattern: surface.pattern, ...(surface.method ? { method: surface.method } : {}), roles: ["admin"] });
      surface.refused(await surface.call(header(tokens.viewer)), 403);
      surface.refused(await surface.call(header(tokens.operator)), 403);
      surface.refused(await surface.call(query(tokens.operator)), 403);
      surface.admitted(await surface.call(header(tokens.admin)));
      surface.refused(await surface.call(anonymous), 401);
    });
  });

  it("checks every token a request presents, whichever one the handler reads", async () => {
    // The dashboard socket reads ?token= before the header: a denied role's query token is refused
    // even when the header names an admitted account.
    policy({ pattern: "/ws", denyRoles: ["viewer"] });
    expect(await socket(`/ws?token=${encodeURIComponent(tokens.viewer)}`, header(tokens.operator))).toEqual({ status: 101, ws: 4403 });
    // A token that resolves to nobody does not hide the one that does.
    expect(await socket(`/ws?token=${encodeURIComponent(tokens.viewer)}`, header("not-a-token"))).toEqual({ status: 101, ws: 4403 });
  });

  it("names the refused role in the 403 and audits it as rbac_denied", async () => {
    policy({ pattern: "/mcp", denyRoles: ["viewer"] });
    policy({ pattern: "/ws", roles: ["admin"] });
    expect(await http("POST", "/mcp", header(tokens.viewer), { body: "{}" })).toMatchObject({ status: 403, body: { error: "Not permitted for role viewer" } });
    expect(await http("GET", "/.well-known/agent-card.json", header(tokens.viewer))).toMatchObject({ status: 200 });
    await socket("/ws", header(tokens.operator));
    expect(await deniedAuditEvents()).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: "policy-viewer", data: expect.objectContaining({ surface: "raw", method: "POST", path: "/mcp", role: "viewer" }) }),
      expect.objectContaining({ userId: "policy-operator", data: expect.objectContaining({ surface: "ws", method: "GET", path: "/ws", role: "operator" }) }),
    ]));
  });

  it("never polices the federation stream, which authenticates a peer, not a user", async () => {
    policy({ pattern: "/api/*", roles: ["admin"] });
    // Federation is off here, and its own handler says so before any user check.
    expect(await http("POST", "/api/federation/delegate/stream", header(tokens.viewer), { body: "{}" })).toMatchObject({ status: 404, body: { error: "federation disabled" } });
    expect(await http("POST", "/api/federation/delegate/stream", anonymous, { body: "{}" })).toMatchObject({ status: 404 });
  });

  it("matches the legacy A2A agent name as its handler reads it, percent-decoded", async () => {
    // The handler decodes the name, so /a2a/agents/%78 runs agent "x": a policy for "x" covers it.
    // The caller refused is an operator, whom the route's own operator floor lets through, and the
    // message is the policy's: the floor answers a viewer with the same status and code.
    const call = (path: string, token: string) => http("POST", path, header(token), { body: JSON.stringify({ jsonrpc: "2.0", method: "nope", id: 1 }) });
    const variants: Array<[RoutePolicy, string]> = [
      [{ pattern: "/a2a/agents/x", roles: ["admin"] }, "Requires role: admin"],
      [{ pattern: "/a2a/agents/x", denyRoles: ["operator"] }, "Not permitted for role operator"],
    ];
    for (const [variant, message] of variants) {
      policies._resetRoutePoliciesForTests();
      policy(variant);
      for (const path of ["/a2a/agents/x", "/a2a/agents/%78", "/a2a/agents/%78?via=encoded"]) {
        expect(await call(path, tokens.operator), path).toMatchObject({ status: 403, body: { jsonrpc: "2.0", error: { code: -32003, message }, id: null } });
      }
      // A caller the policy admits still reaches the handler under the encoded name.
      expect(await call("/a2a/agents/%78", tokens.admin)).toMatchObject({ status: 400, body: { error: { code: -32601 } } });
    }
  });

  it("hands the browser view only /ws/browser-vnc and the paths under it", async () => {
    // The proxy ignores the rest of the path, so a path the policy pattern does not cover must not
    // reach it: /ws/browser-vncX is dropped like any unknown upgrade. The caller refused is an
    // operator, whom the bridge's own operator floor lets through (it answers a viewer with the same
    // 403): on /ws/browser-vnc itself only the policy refuses it.
    for (const variant of [{ denyRoles: ["operator"] }, { roles: ["admin"] }]) {
      policies._resetRoutePoliciesForTests();
      policy({ pattern: "/ws/browser-vnc/*", ...variant } as RoutePolicy);
      for (const path of ["/ws/browser-vncX", "/ws/browser-vnc-live/1"]) {
        expect(await socket(path, query(tokens.operator))).toEqual({ status: 0 });
        expect(await socket(path, query(tokens.admin))).toEqual({ status: 0 });
      }
      expect(await socket("/ws/browser-vnc", query(tokens.operator))).toEqual({ status: 403 });
      expect(await socket("/ws/browser-vnc/x", query(tokens.operator))).toEqual({ status: 403 });
      expect(await socket("/ws/browser-vnc/x", query(tokens.admin))).toEqual({ status: 101, ws: 4404 });
    }
  });
});

describe("a deny policy in front of core's own role policies", () => {
  it("passes a caller it does not name on to them, so adding it never widens access", async () => {
    // As at boot: an extension's policies register first, core's own after them (createGateway).
    policy({ pattern: "/api/*", denyRoles: ["guest"] });
    knowledgeBaseRoutes.registerKnowledgeBaseRoutes(new Hono());
    accountMigrationRoutes.registerAccountMigrationRoutes(new Hono());
    // The doctor passes the mutation gate (operator rank), but core's knowledge-base policy lists the
    // built-in operator only. With the deny policy ending the search it reached the handler.
    expect(await http("POST", "/api/knowledge-bases", header(tokens.doctor), { body: "{}" })).toMatchObject({ status: 403, body: { error: "Requires role: operator" } });
    expect(await http("POST", "/api/knowledge-bases", anonymous, { body: "{}" })).toMatchObject({ status: 401 });
    // The account migration registers its admin-only policy even though the deny policy matches too.
    expect(await http("POST", "/api/admin/account-migration", header(tokens.operator), { body: "{}" })).toMatchObject({ status: 403, body: { error: "Requires role: admin" } });
  });
});

describe("deny policies on /api routes that take a token outside the Authorization header", () => {
  it("refuses a denied role's ?token= and cookie, audits it, and passes everyone else to the route's own auth", async () => {
    policy({ pattern: "/api/workspace/*", denyRoles: ["viewer"] });
    // The iframe preview reads ?token= only; without the query check a denied role walked past.
    expect(await http("GET", "/api/workspace/preview", query(tokens.viewer))).toMatchObject({ status: 403, body: { error: "Not permitted for role viewer" } });
    expect(await deniedAuditEvents()).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: "policy-viewer", data: expect.objectContaining({ surface: "rest", method: "GET", path: "/api/workspace/preview", role: "viewer" }) }),
    ]));
    expect(await http("GET", "/api/workspace/preview", query(tokens.operator))).toMatchObject({ status: 400 });
    expect(await http("GET", "/api/workspace/preview", anonymous)).toMatchObject({ status: 401 });
    // The served-site preview also takes its path-scoped cookie.
    const cookie = { Cookie: `sai_site_token=${encodeURIComponent(tokens.viewer)}` };
    expect(await http("GET", "/api/workspace/site/eA/index.html", anonymous, { headers: cookie })).toMatchObject({ status: 403 });
  });

  it("keeps a roles policy on the Authorization header, as before", async () => {
    policy({ pattern: "/api/workspace/*", roles: ["operator"] });
    expect(await http("GET", "/api/workspace/preview", query(tokens.operator))).toMatchObject({ status: 401, body: { error: "Unauthorized" } });
    expect(await http("GET", "/api/workspace/preview", header(tokens.viewer))).toMatchObject({ status: 403, body: { error: "Requires role: operator" } });
  });
});

describe("an upgrade whose caller is still being checked", () => {
  it("survives the client resetting the connection meanwhile", async () => {
    // Node takes its own error listener off a socket before it emits "upgrade". The /ws route policy
    // and the browser view's own check await the caller; a reset in that wait raised an "error" with
    // no listener, an uncaught exception, which shuts the gateway down (src/index.ts).
    policy({ pattern: "/ws", denyRoles: ["viewer"] });
    const uncaught: unknown[] = [];
    const record = (err: unknown) => { uncaught.push(err); };
    process.on("uncaughtException", record);
    try {
      for (const path of ["/ws", "/ws/browser-vnc/x"]) {
        const hold = holdNextResolution();
        const client = connectTcp(port, "127.0.0.1");
        client.on("error", () => { /* the reset is ours */ });
        await once(client, "connect");
        client.write([
          `GET ${path}?token=${HELD_TOKEN} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"));
        await hold.entered;
        client.resetAndDestroy();
        // The gateway reads the reset while the check still waits.
        await new Promise((resolve) => setTimeout(resolve, 200));
        hold.release();
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(uncaught).toEqual([]);
      expect((await fetch(`${baseUrl}/healthz`)).ok).toBe(true);
      expect(await socket("/ws", header(tokens.operator))).toEqual({ status: 101, ws: "open" });
    } finally {
      process.off("uncaughtException", record);
    }
  });
});
