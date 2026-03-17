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

  it("ends the session when a websocket turn times out", async () => {
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

      const timeoutEvent = sent.find((event) => {
        if (event["type"] !== "status") return false;
        const data = event["data"] as Record<string, unknown> | undefined;
        return data?.["requestId"] === "turn-1" && String(data["error"] ?? "").includes("Session ended");
      });

      expect(timeoutEvent).toBeTruthy();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});