import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TURN_TIMEOUT_SYNTHESIS_GRACE_MS = 65_000;

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

  it("keeps the session alive through the synthesis grace window and only archives if the turn never resolves", async () => {
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
      // Fix B: on timeout the watchdog recovers best-available content instead of an
      // empty error bubble. The recovery helper is exercised directly in
      // timeout-delivery.test.ts; here we just confirm the watchdog DELIVERS it.
      buildTimeoutDeliveryMessage: vi.fn(() => ({
        response: "⏱️ This turn hit its time budget before producing a final answer. Re-send with a higher effort tier.",
        recoveredAssistantText: false,
      })),
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

      expect(session.getSession(active.id)).toBeDefined();
      expect(session.getSessionRecord(active.id)?.isArchived()).toBe(false);

      await vi.advanceTimersByTimeAsync(TURN_TIMEOUT_SYNTHESIS_GRACE_MS);

      expect(session.getSession(active.id)).toBeUndefined();
      expect(session.getSessionRecord(active.id)?.isArchived()).toBe(true);

      // The watchdog now ships the recovered answer (status:ok + finishReason:timeout),
      // never a bare error bubble (audit b6f8336e / 0dc158ad turn 2).
      const timeoutEvent = sent.find((event) => {
        if (event["type"] !== "status") return false;
        const data = event["data"] as Record<string, unknown> | undefined;
        return data?.["requestId"] === "turn-1" && data["finishReason"] === "timeout";
      });
      expect(timeoutEvent).toBeTruthy();
      const data = timeoutEvent!["data"] as Record<string, unknown>;
      expect(data["status"]).toBe("ok");
      expect(String(data["response"] ?? "")).toContain("time budget");

      // ...and no bare error bubble was emitted for this turn.
      const errorEvent = sent.find((event) => {
        if (event["type"] !== "status") return false;
        const d = event["data"] as Record<string, unknown> | undefined;
        return d?.["requestId"] === "turn-1" && d?.["status"] === "error";
      });
      expect(errorEvent).toBeUndefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("caps --iter 0 to 200 and --timeout 0 to 7200s for safety", async () => {
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
      expect((runTurnMock.mock.calls as any[])[0]?.[0] as Record<string, unknown>).toMatchObject({
        userMessage: "hello",
        maxIterationsOverride: 200,
        turnTimeoutOverrideMs: 7200000,
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
        maxIterations: 200,
        timeout: 7200,
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

  it("keeps active turns running when the websocket disconnects unexpectedly", async () => {
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

  it("uses the configured webchat approval timeout and sends deadline metadata", async () => {
    vi.useFakeTimers();

    const tempDir = mkdtempSync(join(tmpdir(), "starlingai-rpc-approval-timeout-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      gateway: {
        jwtSecret: "t".repeat(32),
        approvalTimeoutMs: 120_000,
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
  vi.resetModules();

    let capturedApprovalCallback: ((toolName: string, args: Record<string, unknown>) => Promise<boolean>) | undefined;

    vi.doMock("../agent/runtime.js", () => ({
      runTurn: vi.fn(({ approvalCallback }: { approvalCallback?: (toolName: string, args: Record<string, unknown>) => Promise<boolean> }) => {
        capturedApprovalCallback = approvalCallback;
        return new Promise(() => {});
      }),
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
        id: "req-approval-timeout",
        method: "chat.send",
        params: {
          sessionId: active.id,
          requestId: "turn-approval-timeout",
          message: "fill the saved login form",
        },
      }));

      expect(capturedApprovalCallback).toBeDefined();
      const approvalPromise = capturedApprovalCallback!("site_fill_credentials", { hostname: "n8n.k2o" });
      const approvalRejection = approvalPromise.catch((err: unknown) => err);

      const approvalEvent = sent.find((event) => event["type"] === "agent.approval_needed");
      const approvalData = approvalEvent?.["data"] as Record<string, unknown> | undefined;
      expect(approvalData?.["requestId"]).toBe("turn-approval-timeout");
      expect(approvalData?.["timeoutMs"]).toBe(120_000);
      expect(typeof approvalData?.["expiresAt"]).toBe("string");

      await vi.advanceTimersByTimeAsync(120_000);
  const rejection = await approvalRejection;
  expect(rejection).toBeInstanceOf(Error);
  expect((rejection as Error).message).toContain("no response within 2 min");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reports an in-flight request as active via gateway.status", async () => {
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

    const [{ RpcConnection }, session] = await Promise.all([
      import("../gateway/rpc.js"),
      import("../agent/session.js"),
    ]);

    const active = session.createSession({ channel: "webchat" });
    const connection = new RpcConnection(ws as never);

    await connection.handleMessage(JSON.stringify({
      id: "req-active-turn",
      method: "chat.send",
      params: {
        sessionId: active.id,
        requestId: "turn-active",
        message: "hello",
      },
    }));

    await connection.handleMessage(JSON.stringify({
      id: "req-status",
      method: "gateway.status",
      params: {
        requestId: "turn-active",
      },
    }));

    const response = sent.find((event) => event["id"] === "req-status");
    expect(response?.["ok"]).toBe(true);
    expect((response?.["payload"] as Record<string, unknown> | undefined)?.["activeTurn"]).toBe(true);

    connection.close({ abortInFlightTurns: true });
  });

  it("can still abort active turns when the close is explicit", async () => {
    let capturedSignal: AbortSignal | undefined;

    vi.doMock("../agent/runtime.js", () => ({
      runTurn: vi.fn(({ signal }: { signal: AbortSignal }) => {
        capturedSignal = signal;
        return new Promise(() => {});
      }),
    }));

    const ws = {
      readyState: 1,
      send() {
        // No-op for this regression test.
      },
    };

    const [{ RpcConnection }, session] = await Promise.all([
      import("../gateway/rpc.js"),
      import("../agent/session.js"),
    ]);

    const active = session.createSession({ channel: "webchat" });
    const connection = new RpcConnection(ws as never);

    await connection.handleMessage(JSON.stringify({
      id: "req-explicit-abort",
      method: "chat.send",
      params: {
        sessionId: active.id,
        requestId: "turn-explicit-abort",
        message: "hello",
      },
    }));

    expect(capturedSignal?.aborted).toBe(false);

    connection.close({ abortInFlightTurns: true });

    expect(capturedSignal?.aborted).toBe(true);
  });

  it("supersedes an older in-flight turn when a newer message arrives for the same session", async () => {
    let firstSignal: AbortSignal | undefined;
    let secondSignal: AbortSignal | undefined;

    vi.doMock("../agent/runtime.js", () => ({
      runTurn: vi.fn(({ userMessage, signal }: { userMessage: string; signal: AbortSignal }) => {
        if (userMessage === "first") {
          firstSignal = signal;
          return new Promise(() => {});
        }

        secondSignal = signal;
        return new Promise(() => {});
      }),
    }));

    const ws = {
      readyState: 1,
      send() {
        // No-op for this regression test.
      },
    };

    const [{ RpcConnection }, session] = await Promise.all([
      import("../gateway/rpc.js"),
      import("../agent/session.js"),
    ]);

    const active = session.createSession({ channel: "webchat" });
    const connection = new RpcConnection(ws as never);

    await connection.handleMessage(JSON.stringify({
      id: "req-first",
      method: "chat.send",
      params: {
        sessionId: active.id,
        requestId: "turn-first",
        message: "first",
      },
    }));

    expect(firstSignal?.aborted).toBe(false);

    await connection.handleMessage(JSON.stringify({
      id: "req-second",
      method: "chat.send",
      params: {
        sessionId: active.id,
        requestId: "turn-second",
        message: "second",
      },
    }));

    expect(firstSignal?.aborted).toBe(true);
    expect(secondSignal?.aborted).toBe(false);
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