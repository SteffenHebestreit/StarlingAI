import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testAccount } from "./support/test-account.js";

/**
 * Which session a channel sender continues.
 *
 * The Redis mapping from a sender to its session lives for days and survives a rebuild. A sender
 * who wrote within that window before account ids was mapped to a session that names the sender
 * and no kind. Under multi-user auth it was continued, every turn on it was refused as predating
 * account ids, and that refusal went back as the reply to every message (an email for every mail)
 * until the mapping expired. The account migration never stamps such a session, so nothing cleared
 * it. A mapped session the sender does not own as a channel principal is left as it is now, and the
 * sender gets a fresh one.
 *
 * The Redis mirror and the channel mapping are fakes; everything else is the real module.
 */

const redis = vi.hoisted(() => ({ sessions: new Map<string, string>(), mapping: new Map<string, string>() }));
vi.mock("../agent/session-redis.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent/session-redis.js")>()),
  saveSessionToRedis: async (id: string, json: string) => { redis.sessions.set(id, json); },
  loadSessionFromRedis: async (id: string) => redis.sessions.get(id) ?? null,
  deleteSessionFromRedis: async (id: string) => { redis.sessions.delete(id); },
  getChannelSessionId: async (channel: string, sender: string) => redis.mapping.get(`${channel}:${sender}`) ?? null,
  setChannelSessionId: async (channel: string, sender: string, id: string) => { redis.mapping.set(`${channel}:${sender}`, id); },
}));

const SECRET = "c".repeat(40);
const FILE_DIR = mkdtempSync(join(tmpdir(), "starlingai-channel-session-"));
const CONFIG_PATH = join(FILE_DIR, "starlingai.json");
const root = testAccount("root", "admin");
let mods: Awaited<ReturnType<typeof loadModules>>;

async function loadModules() {
  writeFileSync(CONFIG_PATH, JSON.stringify({ gateway: { jwtSecret: SECRET } }), "utf8");
  process.env["SAI_CONFIG_PATH"] = CONFIG_PATH;
  process.env["SAI_MUTABLE_CONFIG_PATH"] = CONFIG_PATH;
  process.env["SAI_SESSION_STORE"] = join(FILE_DIR, "sessions.json");
  const loader = await import("../config/loader.js");
  const sessions = await import("../agent/session.js");
  const channels = await import("../channels/base.js");
  return { loader, sessions, channels };
}

function configure(authEnabled: boolean): string {
  const workspace = mkdtempSync(join(FILE_DIR, "ws-"));
  writeFileSync(CONFIG_PATH, JSON.stringify({
    gateway: { jwtSecret: SECRET },
    workspacePath: workspace,
    auth: { enabled: authEnabled, provider: "builtin", users: [root.record] },
  }), "utf8");
  mods.loader.resetConfigForTests();
  return workspace;
}

/** A session record in the Redis mirror and the sender's mapping to it, as another instance (or the
 *  gateway before the rebuild) left them. */
function mapped(id: string, channel: string, sender: string, workspace: string, extra: Record<string, unknown> = {}): void {
  redis.sessions.set(id, JSON.stringify({
    id,
    channel,
    userId: sender,
    createdAt: "2026-10-05T00:00:00.000Z",
    updatedAt: "2026-10-05T00:00:00.000Z",
    systemPrompt: "system",
    workspacePath: workspace,
    turnCount: 1,
    history: [{ role: "user", content: "hello" }],
    ...extra,
  }));
  redis.mapping.set(`${channel}:${sender}`, id);
}

beforeAll(async () => {
  mods = await loadModules();
}, 60_000);

afterEach(() => {
  mods.sessions.resetSessionsForTests();
  redis.sessions.clear();
  redis.mapping.clear();
});

afterAll(() => {
  for (const key of ["SAI_CONFIG_PATH", "SAI_MUTABLE_CONFIG_PATH", "SAI_SESSION_STORE"]) delete process.env[key];
  rmSync(FILE_DIR, { recursive: true, force: true });
});

describe("a channel sender's mapped session", () => {
  it("is not continued when it predates account ids: the sender gets a fresh session as a channel principal, and the mapping names it", async () => {
    const workspace = configure(true);
    mapped("s-legacy", "discord", "4711", workspace);

    const opened = await mods.channels.getOrCreateChannelSession("discord", "4711");
    expect("sessionId" in opened).toBe(true);
    const sessionId = (opened as { sessionId: string }).sessionId;
    expect(sessionId).not.toBe("s-legacy");
    expect(mods.sessions.getSession(sessionId)?.identity()).toEqual({ userId: "4711", principal: "channel" });
    expect(redis.mapping.get("discord:4711")).toBe(sessionId);
    // The old conversation is left as it was: read-only, for an admin.
    expect(mods.sessions.getSessionRecord("s-legacy")?.isLegacy()).toBe(true);

    // The next message continues the fresh session, from this instance's map and from the mapping.
    expect(await mods.channels.getOrCreateChannelSession("discord", "4711")).toEqual({ sessionId });
  });

  it("is not continued when it is another principal's of the same name", async () => {
    const workspace = configure(true);
    mapped("s-boot", "email", "ops@example.test", workspace, { principal: "bootstrap" });
    const opened = await mods.channels.getOrCreateChannelSession("email", "ops@example.test");
    expect((opened as { sessionId: string }).sessionId).not.toBe("s-boot");
  });

  it("is continued when it is the sender's as a channel principal", async () => {
    const workspace = configure(true);
    mapped("s-own", "slack", "U123", workspace, { principal: "channel" });
    expect(await mods.channels.getOrCreateChannelSession("slack", "U123")).toEqual({ sessionId: "s-own" });
  });

  it("is continued with one operator, as before", async () => {
    const workspace = configure(false);
    mapped("s-single", "whatsapp", "4912345", workspace);
    expect(await mods.channels.getOrCreateChannelSession("whatsapp", "4912345")).toEqual({ sessionId: "s-single" });
  });
});
