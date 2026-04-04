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

  it("preserves zero-valued inline overrides and disables the websocket timeout for --timeout 0", async () => {
    vi.useFakeTimers();

    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-rpc-zero-overrides-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      gateway: {
        jwtSecret: "t".repeat(32),
        turnTimeoutMs: 30_000,
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;

    const runTurnMock = vi.fn(() => new Promise(() => {}));
    vi.doMock("../agent/runtime.js", () => ({
      runTurn: runTurnMock,
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
        id: "req-zero-overrides",
        method: "chat.send",
        params: {
          sessionId: active.id,
          requestId: "turn-zero-overrides",
          message: "hello --iter 0 --timeout 0",
        },
      }));

      expect(runTurnMock).toHaveBeenCalledTimes(1);
      expect(runTurnMock.mock.calls[0]?.[0]).toMatchObject({
        userMessage: "hello",
        maxIterationsOverride: 0,
        turnTimeoutOverrideMs: 0,
      });

      await vi.advanceTimersByTimeAsync(60_000);

      expect(session.getSession(active.id)).toBeDefined();
      expect(session.getSessionRecord(active.id)?.isArchived()).toBe(false);

      const acceptedEvent = sent.find((event) => {
        if (event["type"] !== "status") return false;
        const data = event["data"] as Record<string, unknown> | undefined;
        return data?.["requestId"] === "turn-zero-overrides" && data?.["status"] === "accepted";
      });

      expect((acceptedEvent?.["data"] as Record<string, unknown> | undefined)?.["activeFlags"]).toEqual({
        maxIterations: 0,
        timeout: 0,
      });

      const timeoutEvent = sent.find((event) => {
        if (event["type"] !== "status") return false;
        const data = event["data"] as Record<string, unknown> | undefined;
        return data?.["requestId"] === "turn-zero-overrides" && data?.["status"] === "error";
      });

      expect(timeoutEvent).toBeUndefined();
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

  it("keeps an active turn running when the websocket disconnects", async () => {
    let capturedSignal: AbortSignal | undefined;
    let resolveTurn: ((value: {
      response: string;
      toolCallsExecuted: number;
      guardrailEvents: unknown[];
      usage: { promptTokens: number; completionTokens: number; totalTokens: number };
      performance: { turnDurationMs: number; llmCalls: number; llmTimeMs: number; toolIterations: number; finishReason: string };
      blocked?: boolean;
    }) => void) | undefined;

    vi.doMock("../agent/runtime.js", () => ({
      runTurn: vi.fn(({ signal }: { signal: AbortSignal }) => {
        capturedSignal = signal;
        return new Promise((resolve) => {
          resolveTurn = resolve;
        });
      }),
    }));

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
    const connection = new RpcConnection(ws as never);

    await connection.handleMessage(JSON.stringify({
      id: "req-disconnect",
      method: "chat.send",
      params: {
        sessionId: active.id,
        requestId: "turn-disconnect",
        message: "hello",
      },
    }));

    expect(capturedSignal?.aborted).toBe(false);

    connection.close();

    expect(capturedSignal?.aborted).toBe(false);

    resolveTurn?.({
      response: "done",
      toolCallsExecuted: 0,
      guardrailEvents: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      performance: { turnDurationMs: 1, llmCalls: 1, llmTimeMs: 1, toolIterations: 0, finishReason: "stop" },
      blocked: false,
    });

    await Promise.resolve();

    const errorEvent = sent.find((event) => {
      if (event["type"] !== "status") return false;
      const data = event["data"] as Record<string, unknown> | undefined;
      return data?.["requestId"] === "turn-disconnect" && data?.["status"] === "error";
    });

    expect(errorEvent).toBeUndefined();
  });

  it("blocks flag-only chat submissions before calling the provider", async () => {
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
    const connection = new RpcConnection(ws as never);

    await connection.handleMessage(JSON.stringify({
      id: "req-flag-only",
      method: "chat.send",
      params: {
        sessionId: active.id,
        requestId: "turn-flag-only",
        message: "--auto",
      },
    }));

    const statusEvent = sent.find((event) => {
      if (event["type"] !== "status") return false;
      const data = event["data"] as Record<string, unknown> | undefined;
      return data?.["requestId"] === "turn-flag-only";
    });

    expect((statusEvent?.["data"] as Record<string, unknown> | undefined)?.["status"]).toBe("blocked");
    expect(String((statusEvent?.["data"] as Record<string, unknown> | undefined)?.["response"] ?? "")).toContain("include an instruction");
    expect(active.getHistory()).toHaveLength(0);
  });
});