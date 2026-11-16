import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRODUCT } from "../product/index.js";
import { testAccount } from "./support/test-account.js";

/**
 * GET /api/status, GET /api/channels/dead-letters, GET /api/channels/:type and who may read them
 * (found in review, 2026-11-14).
 *
 * /api/status listed every session's id, channel and turn count to any caller that signed in, and
 * the dead-letter route and each channel's details gave any caller undelivered channel messages:
 * their channel, a preview of their text and the error. Under multi-user auth /api/status now lists
 * what the socket's session list does (the caller's own sessions and unowned ones, every one for an
 * admin), the dead-letter count is for operators and above, and the entries, on either route, are
 * for admins. With auth off all three answer as before.
 *
 * These run against the whole gateway. Its start() listens on <gateway.host>:<gateway.port>
 * (127.0.0.1 outside Docker, 0.0.0.0 in a container), so it is never called: the gateway's HTTP
 * server is taken as it is created and listened on loopback, on a port the OS picks, here.
 */
const servers = vi.hoisted(() => [] as Server[]);
vi.mock("node:http", async (importActual) => {
  const actual = await importActual<typeof import("node:http")>();
  const createServer = ((...args: Parameters<typeof actual.createServer>) => {
    const server = actual.createServer(...args);
    servers.push(server);
    return server;
  }) as typeof actual.createServer;
  return { ...actual, createServer, default: { ...actual, createServer } };
});

const SESSION_STORE_DIR = vi.hoisted(() => {
  // The session store resolves its path when the module loads; a temp one, not the source tree's.
  const { mkdtempSync: mk } = require("node:fs") as typeof import("node:fs");
  const { tmpdir: tmp } = require("node:os") as typeof import("node:os");
  const { join: j } = require("node:path") as typeof import("node:path");
  const dir = mk(j(tmp(), "status-route-sessions-"));
  process.env["SAI_SESSION_STORE"] = j(dir, "sessions.json");
  return dir;
});

const tempDirs: string[] = [];
const ENV_KEYS = ["SAI_CONFIG_PATH", "SAI_MASTER_KEY", "SAI_CRED_STORE", "SAI_AUDIT_LOG", "SAI_JWT_SECRET"];
let stopGateway: (() => Promise<void>) | undefined;

afterEach(async () => {
  await stopGateway?.();
  stopGateway = undefined;
  servers.length = 0;
  const session = await import("../agent/session.js");
  for (const active of session.getAllSessions()) session.endSession(active.id);
  await (await import("../audit/logger.js")).flushAuditLog();
  (await import("../config/loader.js")).resetConfigForTests();
  (await import("../gateway/auth.js")).resetAuthStateForTests();
  for (const key of ENV_KEYS) delete process.env[key];
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

afterAll(() => {
  delete process.env["SAI_SESSION_STORE"];
  rmSync(SESSION_STORE_DIR, { recursive: true, force: true });
});

const ROSTER = { alice: "operator", bob: "operator", vera: "viewer", carol: "admin" } as const;
type Who = keyof typeof ROSTER;

/** The gateway with Alice's and Bob's chats and one undelivered channel message. */
async function bootGateway(authEnabled: boolean) {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-status-route-"));
  tempDirs.push(tempDir);
  const configDir = join(tempDir, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "10-test.json"), JSON.stringify({
    // No port: start() is never called, and the server listens where bootGateway says.
    gateway: { jwtSecret: "j".repeat(40) },
    workspacePath: tempDir,
    ...(authEnabled ? { auth: { enabled: true, users: Object.entries(ROSTER).map(([name, role]) => testAccount(name, role).record) } } : {}),
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configDir;
  process.env["SAI_MASTER_KEY"] = "m".repeat(32);
  process.env["SAI_CRED_STORE"] = join(tempDir, PRODUCT.stateDirName, "credentials.enc");
  process.env["SAI_AUDIT_LOG"] = join(tempDir, "audit.jsonl");
  vi.resetModules();
  // Sequential imports: these modules import each other.
  const { createGateway } = await import("../gateway/index.js");
  const auth = await import("../gateway/auth.js");
  const session = await import("../agent/session.js");
  const { appendDeadLetter } = await import("../channels/dead-letter.js");

  servers.length = 0;
  const gateway = createGateway();
  const http = servers.at(0);
  if (!http) throw new Error("the gateway created no HTTP server");
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  stopGateway = () => gateway.stop();
  const baseUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

  const chatOf = (who: Who) => session.createSession({
    channel: "webchat", userId: who, ...(authEnabled ? { account: testAccount(who).id } : {}),
  }).id;
  const alices = chatOf("alice");
  const bobs = chatOf("bob");
  appendDeadLetter({ channel: "email", messagePreview: "Your results for patient 4711 are ready", error: "SMTP 550", attempts: 3 });

  const get = async (who: Who, path: string) => {
    const claims = authEnabled ? testAccount(who, ROSTER[who]).claims : { role: ROSTER[who] };
    const response = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${await auth.createToken(who, claims)}` } });
    return { status: response.status, text: await response.text() };
  };
  const sessionsListedTo = async (who: Who): Promise<string[]> => {
    const status = await get(who, "/api/status");
    expect(status.status).toBe(200);
    return (JSON.parse(status.text) as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id).sort();
  };
  return { get, sessionsListedTo, alices, bobs };
}

describe("GET /api/status and the sessions it lists", () => {
  it("under multi-user auth, lists each account its own sessions, and every one to an admin", async () => {
    const gw = await bootGateway(true);
    expect(await gw.sessionsListedTo("alice")).toEqual([gw.alices]);
    expect(await gw.sessionsListedTo("bob")).toEqual([gw.bobs]);
    expect(await gw.sessionsListedTo("vera")).toEqual([]);
    expect(await gw.sessionsListedTo("carol")).toEqual([gw.alices, gw.bobs].sort());
  }, 60_000);

  it("with auth off, lists every session, as before", async () => {
    const gw = await bootGateway(false);
    expect(await gw.sessionsListedTo("alice")).toEqual([gw.alices, gw.bobs].sort());
  }, 60_000);
});

describe("GET /api/channels/dead-letters and who may read it", () => {
  it("under multi-user auth, refuses a viewer, gives an operator the count and an admin the entries", async () => {
    const gw = await bootGateway(true);

    const viewer = await gw.get("vera", "/api/channels/dead-letters");
    expect(viewer.status).toBe(403);
    expect(viewer.text).not.toContain("4711");

    const operator = await gw.get("alice", "/api/channels/dead-letters");
    expect(operator.status).toBe(200);
    expect(JSON.parse(operator.text)).toEqual({ count: 1, entries: [] });

    const admin = await gw.get("carol", "/api/channels/dead-letters");
    expect(admin.status).toBe(200);
    expect(JSON.parse(admin.text)).toMatchObject({ count: 1, entries: [{ channel: "email", error: "SMTP 550" }] });
  }, 60_000);

  it("with auth off, gives the count and the entries, as before", async () => {
    const gw = await bootGateway(false);
    const read = await gw.get("alice", "/api/channels/dead-letters");
    expect(read.status).toBe(200);
    expect(JSON.parse(read.text)).toMatchObject({ count: 1, entries: [{ channel: "email" }] });
  }, 60_000);
});

describe("GET /api/channels/:type and the dead letters it shows", () => {
  // The channel's settings page reads its five most recent dead letters from here, previews
  // included, so the rule of the dead-letter route is this route's too (found in review,
  // 2026-11-14): a viewer refused the dead-letter list read the same entries, channel by channel.
  type ChannelDetails = { status: { operatorState: { severity: string } }; operator: { recentDeadLetters: Array<Record<string, unknown>> } };

  it("under multi-user auth, shows the entries to an admin only, and the same health to every caller", async () => {
    const gw = await bootGateway(true);
    const detailsFor = async (who: Who) => {
      const reply = await gw.get(who, "/api/channels/email");
      expect(reply.status, who).toBe(200);
      return { text: reply.text, details: JSON.parse(reply.text) as ChannelDetails };
    };

    for (const who of ["vera", "alice"] as const) {
      const { text, details } = await detailsFor(who);
      expect(details.operator.recentDeadLetters, who).toEqual([]);
      expect(text, who).not.toContain("4711");
      // The health summary still counts the entries it does not show.
      expect(details.status.operatorState.severity, who).toBe("warning");
    }

    const admin = await detailsFor("carol");
    expect(admin.details.operator.recentDeadLetters).toMatchObject([{ channel: "email", messagePreview: "Your results for patient 4711 are ready" }]);
    expect(admin.details.status.operatorState.severity).toBe("warning");
  }, 60_000);

  it("with auth off, shows the entries, as before", async () => {
    const gw = await bootGateway(false);
    const reply = await gw.get("alice", "/api/channels/email");
    expect(reply.status).toBe(200);
    expect((JSON.parse(reply.text) as ChannelDetails).operator.recentDeadLetters).toMatchObject([{ channel: "email", error: "SMTP 550" }]);
  }, 60_000);
});
