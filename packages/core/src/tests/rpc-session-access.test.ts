import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * RPC-3 (July 2026 review round 6): the WS RPC bridge must not let one
 * authenticated user read, mutate, or enumerate another user's sessions.
 * Enforced by RpcConnection.canAccessSession / visibleSessions; no-op for
 * auth-off (no connUserId) and for operators.
 */
describe("rpc session-access isolation", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "starlingai-rpc-access-"));
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({ gateway: { jwtSecret: "t".repeat(32), turnTimeoutMs: 30_000 } }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
  });

  afterEach(async () => {
    const session = await import("../agent/session.js");
    for (const active of session.getAllSessions()) session.endSession(active.id);
    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
    delete process.env["SAI_CONFIG_PATH"];
    rmSync(tempDir, { recursive: true, force: true });
  });

  function mockWs(): { readyState: number; send(p: string): void; sent: Array<Record<string, unknown>> } {
    const sent: Array<Record<string, unknown>> = [];
    return { readyState: 1, send(p: string) { sent.push(JSON.parse(p) as Record<string, unknown>); }, sent };
  }

  function responseFor(sent: Array<Record<string, unknown>>, id: string): { ok: boolean; payload?: unknown; error?: string } {
    const r = sent.find((m) => m["type"] === "rpc.response" && m["id"] === id);
    if (!r) throw new Error(`no rpc.response for ${id}`);
    return r as { ok: boolean; payload?: unknown; error?: string };
  }

  it("hides and refuses access to another user's session; permits your own", async () => {
    const [{ RpcConnection }, session] = await Promise.all([
      import("../gateway/rpc.js"),
      import("../agent/session.js"),
    ]);
    const aliceSession = session.createSession({ channel: "webchat", userId: "alice" });
    const bobSession = session.createSession({ channel: "webchat", userId: "bob" });

    const ws = mockWs();
    const conn = new RpcConnection(ws as never, "alice", "viewer");

    // session.list is scoped to alice's own sessions.
    await conn.handleMessage(JSON.stringify({ id: "list", method: "session.list", params: {} }));
    const list = responseFor(ws.sent, "list").payload as Array<{ id: string }>;
    const ids = list.map((s) => s.id);
    expect(ids).toContain(aliceSession.id);
    expect(ids).not.toContain(bobSession.id);

    // session.get on bob's session is refused with a not-found (no existence disclosure).
    await conn.handleMessage(JSON.stringify({ id: "getBob", method: "session.get", params: { sessionId: bobSession.id } }));
    const getBob = responseFor(ws.sent, "getBob");
    expect(getBob.ok).toBe(false);
    expect(String(getBob.error)).toContain("not found");

    // session.get on alice's own session works.
    await conn.handleMessage(JSON.stringify({ id: "getAlice", method: "session.get", params: { sessionId: aliceSession.id } }));
    expect(responseFor(ws.sent, "getAlice").ok).toBe(true);

    // session.delete on bob's session is refused AND does not delete it.
    await conn.handleMessage(JSON.stringify({ id: "delBob", method: "session.delete", params: { sessionId: bobSession.id } }));
    expect(responseFor(ws.sent, "delBob").ok).toBe(false);
    expect(session.getSessionRecord(bobSession.id)).toBeDefined();
  });

  it("lets an operator see and access every session", async () => {
    const [{ RpcConnection }, session] = await Promise.all([
      import("../gateway/rpc.js"),
      import("../agent/session.js"),
    ]);
    const aliceSession = session.createSession({ channel: "webchat", userId: "alice" });
    const bobSession = session.createSession({ channel: "webchat", userId: "bob" });

    const ws = mockWs();
    const conn = new RpcConnection(ws as never, "root", "operator");
    await conn.handleMessage(JSON.stringify({ id: "list", method: "session.list", params: {} }));
    const ids = (responseFor(ws.sent, "list").payload as Array<{ id: string }>).map((s) => s.id);
    expect(ids).toContain(aliceSession.id);
    expect(ids).toContain(bobSession.id);
  });

  it("does not enforce isolation when the connection has no authenticated user (auth off)", async () => {
    const [{ RpcConnection }, session] = await Promise.all([
      import("../gateway/rpc.js"),
      import("../agent/session.js"),
    ]);
    const s1 = session.createSession({ channel: "webchat", userId: "alice" });
    const s2 = session.createSession({ channel: "webchat" }); // unowned

    const ws = mockWs();
    const conn = new RpcConnection(ws as never); // no connUserId
    await conn.handleMessage(JSON.stringify({ id: "list", method: "session.list", params: {} }));
    const ids = (responseFor(ws.sent, "list").payload as Array<{ id: string }>).map((s) => s.id);
    expect(ids).toContain(s1.id);
    expect(ids).toContain(s2.id);
  });
});
