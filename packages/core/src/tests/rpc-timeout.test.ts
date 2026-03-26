import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("rpc timeout cleanup", () => {
  afterEach(async () => {
    vi.useRealTimers();
    vi.resetModules();
    vi.unmock("../agent/runtime.js");
    delete process.env["SAI_CONFIG_PATH"];

    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();

    const session = await import("../agent/session.js");
    for (const active of session.getAllSessions()) {
      session.endSession(active.id);
    }
  });

  it("archives the session when a websocket turn times out", async () => {
    vi.useFakeTimers();

    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-rpc-timeout-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      gateway: {
        jwtSecret: "t".repeat(32),
        turnTimeoutMs: 30_000,
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;

    vi.doMock("../agent/runtime.js", () => ({
      runTurn: vi.fn(() => new Promise(() => {})),
    }));

    const sent: Array<Record<string, unknown>> = [];
    const ws = {
      readyState: 1,
      send(payload: string) {
        sent.push(JSON.parse(payload) as Record<string, unknown>);
      },
    };

    try {
      const [{ RpcConnection }, session] = await Promise.all([
        import("../gateway/rpc.js"),
        import("../agent/session.js"),
      ]);

      const active = session.createSession({ channel: "webchat" });
      const connection = new RpcConnection(ws as never);

      await connection.handleMessage(JSON.stringify({
        id: "req-0",
        method: "chat.send",
        params: {
          sessionId: active.id,
          requestId: "turn-1",
          message: "hello",
        },
      }));

      await vi.advanceTimersByTimeAsync(30_000);

      expect(session.getSession(active.id)).toBeUndefined();
      expect(session.getSessionRecord(active.id)?.isArchived()).toBe(true);

      const timeoutEvent = sent.find((event) => {
        if (event["type"] !== "status") return false;
        const data = event["data"] as Record<string, unknown> | undefined;
        return data?.["requestId"] === "turn-1" && String(data["error"] ?? "").includes("Session archived");
      });

      expect(timeoutEvent).toBeTruthy();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns paged transcript slices over RPC", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const ws = {
      readyState: 1,
      send(payload: string) {
        sent.push(JSON.parse(payload) as Record<string, unknown>);
      },
    };

    const [{ RpcConnection }, session] = await Promise.all([
      import("../gateway/rpc.js"),
      import("../agent/session.js"),
    ]);

    const active = session.createSession({ channel: "webchat" });
    active.addMessage({ role: "user", content: "one" });
    active.addMessage({ role: "assistant", content: "two" });
    active.addMessage({ role: "user", content: "three" });

    const connection = new RpcConnection(ws as never);

    await connection.handleMessage(JSON.stringify({
      id: "req-page-1",
      method: "session.get",
      params: {
        sessionId: active.id,
        limit: 2,
      },
    }));

    const latestResponse = sent.find((event) => event["id"] === "req-page-1");
    expect(latestResponse?.["ok"]).toBe(true);
    const latestPayload = latestResponse?.["payload"] as {
      transcript: Array<{ id: string; content: string }>;
      totalMessages: number;
      nextBeforeMessageId?: string;
    };
    expect(latestPayload.totalMessages).toBe(3);
    expect(latestPayload.transcript.map((message) => message.content)).toEqual(["two", "three"]);
    expect(latestPayload.nextBeforeMessageId).toBe(latestPayload.transcript[0]?.id);

    await connection.handleMessage(JSON.stringify({
      id: "req-page-2",
      method: "session.get",
      params: {
        sessionId: active.id,
        limit: 2,
        beforeMessageId: latestPayload.nextBeforeMessageId,
      },
    }));

    const olderResponse = sent.find((event) => event["id"] === "req-page-2");
    expect(olderResponse?.["ok"]).toBe(true);
    const olderPayload = olderResponse?.["payload"] as {
      transcript: Array<{ content: string }>;
      nextBeforeMessageId?: string;
    };
    expect(olderPayload.transcript.map((message) => message.content)).toEqual(["one"]);
    expect(olderPayload.nextBeforeMessageId).toBeUndefined();
  });
});