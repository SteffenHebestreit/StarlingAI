import { EventEmitter } from "node:events";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../runtime/accounts.js";
import { testAccount } from "./support/test-account.js";

/**
 * The AG-UI stream and a session only the durable store holds (found in review, 2026-11-14).
 *
 * handleAguiStream checked the owner of a session this process holds before it resolved the id,
 * and the owner of anything else after: resolveSession(resumeArchived) had by then hydrated the
 * store's record into this process, un-parked it if the turn watchdog had parked it (persisted, with
 * a `session.resumed` audit entry in the owner's name), and only then was the request refused. With
 * several gateway instances, or a store this process has not loaded, another account's chat was
 * woken up by a request that got a 404. The owner is now checked on the record the store hands back,
 * before anything is done with it, as chat.send does over the socket.
 */
const SESSION_STORE_DIR = vi.hoisted(() => {
  // The session store resolves its path when the module loads; a temp one, not the source tree's.
  const { mkdtempSync: mk } = require("node:fs") as typeof import("node:fs");
  const { tmpdir: tmp } = require("node:os") as typeof import("node:os");
  const { join: j } = require("node:path") as typeof import("node:path");
  const dir = mk(j(tmp(), "agui-durable-sessions-"));
  process.env["SAI_SESSION_STORE"] = j(dir, "sessions.json");
  return dir;
});

/** The durable session store (agent/session-redis.ts) as another gateway instance left it: records
 *  this process has never loaded, by id. */
const durableStore = vi.hoisted(() => new Map<string, string>());
vi.mock("../agent/session-redis.js", async (importActual) => ({
  ...(await importActual<typeof import("../agent/session-redis.js")>()),
  loadSessionFromRedis: async (id: string) => durableStore.get(id) ?? null,
}));

/** The sessions a turn ran on. The turn itself is not under test here. */
const turnsStarted = vi.hoisted(() => [] as string[]);
vi.mock("../agent/runtime.js", async (importActual) => ({
  ...(await importActual<typeof import("../agent/runtime.js")>()),
  runTurn: async (opts: { session: { id: string } }) => {
    turnsStarted.push(opts.session.id);
    return { response: "ok", toolCallsExecuted: 0, guardrailEvents: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, blocked: false };
  },
}));

class FakeResponse extends EventEmitter {
  statusCode?: number;
  writableEnded = false;
  chunks: string[] = [];
  writeHead(statusCode: number) { this.statusCode = statusCode; }
  write(chunk: string) { this.chunks.push(chunk); return true; }
  end(chunk?: string) { if (chunk) this.chunks.push(chunk); this.writableEnded = true; }
}

const ROSTER = { alice: "operator", bob: "operator", carol: "admin" } as const;
type Who = keyof typeof ROSTER;
const identityOf = (who: Who): Identity => ({ userId: who, account: testAccount(who).id });

const WORKSPACE = mkdtempSync(join(tmpdir(), "agui-durable-owner-"));
let mods: Awaited<ReturnType<typeof loadModules>>;

async function loadModules() {
  const configPath = join(WORKSPACE, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({
    gateway: { jwtSecret: "d".repeat(40), turnTimeoutMs: 30_000 },
    workspacePath: WORKSPACE,
    auth: { enabled: true, users: Object.entries(ROSTER).map(([name, role]) => testAccount(name, role).record) },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configPath;
  process.env["SAI_AUDIT_LOG"] = join(WORKSPACE, "audit.jsonl");
  // Sequential imports: these modules import each other.
  const agui = await import("../gateway/agui.js");
  const session = await import("../agent/session.js");
  const audit = await import("../audit/logger.js");
  return { agui, session, audit };
}

// Loading the modules cold can take longer than a hook's default 10 s.
beforeAll(async () => {
  mods = await loadModules();
}, 60_000);

afterEach(async () => {
  durableStore.clear();
  turnsStarted.length = 0;
  for (const active of mods.session.getAllSessions({ includeArchived: true })) mods.session.endSession(active.id);
  await mods.audit.flushAuditLog();
});

afterAll(() => {
  for (const key of ["SAI_SESSION_STORE", "SAI_CONFIG_PATH", "SAI_AUDIT_LOG"]) delete process.env[key];
  rmSync(SESSION_STORE_DIR, { recursive: true, force: true });
  rmSync(WORKSPACE, { recursive: true, force: true });
});

/** A chat of Bob's that only the durable store holds, live or parked by the turn watchdog. */
function storedChatOfBob(sessionId: string, extra: Record<string, unknown> = {}): string {
  const record = new mods.session.AgentSession({ sessionId, channel: "webchat:agui", ...identityOf("bob") }).toRecord();
  durableStore.set(sessionId, JSON.stringify({ ...record, ...extra }));
  return sessionId;
}
const PARKED = { archivedAt: new Date().toISOString(), archivedReason: "timeout" };

/** A request to the stream, the caller built as gateway/index.ts builds it. */
async function stream(who: Who, sessionId: string, message: string): Promise<FakeResponse> {
  const res = new FakeResponse();
  await mods.agui.handleAguiStream(res as never, { sessionId, message }, { userId: who, role: ROSTER[who], identity: identityOf(who) });
  return res;
}

describe("the AG-UI stream and a session only the durable store holds", () => {
  it("refuses another account's session before hydrating it, and does not wake it or take over its id", async () => {
    const live = storedChatOfBob("bob-on-another-instance");
    const parked = storedChatOfBob("bob-parked-elsewhere", PARKED);
    const storedBefore = new Map(durableStore);

    for (const sessionId of [live, parked]) {
      const res = await stream("alice", sessionId, "what did he ask you?");
      expect(res.statusCode, sessionId).toBe(404);
      // The opaque body of every ownership denial on this route.
      expect(res.chunks.join(""), sessionId).toBe(JSON.stringify({ error: "Session not found" }));
      // Neither hydrated into this process, nor woken up, nor adopted as a new session of Alice's.
      expect(mods.session.getSessionRecord(sessionId), sessionId).toBeUndefined();
    }
    expect(turnsStarted).toEqual([]);
    expect(durableStore).toEqual(storedBefore);
  });

  it("lets its owner drive it, the parked one un-parked, and an admin too", async () => {
    const live = storedChatOfBob("bob-on-another-instance");
    const parked = storedChatOfBob("bob-parked-elsewhere", PARKED);

    for (const sessionId of [live, parked]) {
      expect((await stream("bob", sessionId, "continue")).statusCode, sessionId).toBe(200);
    }
    expect(turnsStarted).toEqual([live, parked]);
    expect(mods.session.getSessionRecord(parked)?.isArchived()).toBe(false);
    expect(mods.session.getSessionRecord(parked)?.identity()).toMatchObject(identityOf("bob"));

    const audited = storedChatOfBob("bob-audited-elsewhere");
    expect((await stream("carol", audited, "audit")).statusCode).toBe(200);
    expect(turnsStarted.at(-1)).toBe(audited);
  });
});
