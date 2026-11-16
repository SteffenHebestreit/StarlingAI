import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import type { RunTurnOptions, TurnOutput } from "../agent/turn-types.js";
import { PRODUCT } from "../product/index.js";
import { testAccount } from "./support/test-account.js";

/**
 * The per-method minimum role on the real dashboard socket: the whole gateway, a real handshake
 * with a real token, on loopback. A viewer's session.create and chat.send are refused before any
 * turn starts; an operator's run.
 */

const runTurnMock = vi.hoisted(() => vi.fn<(opts: RunTurnOptions) => Promise<TurnOutput>>());

vi.mock("../agent/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent/runtime.js")>()),
  runTurn: runTurnMock,
}));

const SECRET = "s".repeat(40);
const ENV_KEYS = ["SAI_CONFIG_PATH", "SAI_MUTABLE_CONFIG_PATH", "SAI_SESSION_STORE", "SAI_MASTER_KEY", "SAI_CRED_STORE", "SAI_AUDIT_LOG", "SAI_JOB_WAKE_DISABLED"];
const vic = testAccount("vic", "viewer");
const olga = testAccount("olga", "operator");

let tempDir = "";
let wsBase = "";
let stopGateway: () => Promise<void> = async () => {};
let mods: {
  auth: typeof import("../gateway/auth.js");
  sessions: typeof import("../agent/session.js");
  config: typeof import("../config/loader.js");
};

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "starlingai-rpc-policy-socket-"));
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({
    gateway: { jwtSecret: SECRET, turnTimeoutMs: 30_000 },
    workspacePath: tempDir,
    auth: { enabled: true, users: [vic.record, olga.record] },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configPath;
  process.env["SAI_MUTABLE_CONFIG_PATH"] = configPath;
  process.env["SAI_SESSION_STORE"] = join(tempDir, "sessions.json");
  process.env["SAI_MASTER_KEY"] = "m".repeat(32);
  process.env["SAI_CRED_STORE"] = join(tempDir, PRODUCT.stateDirName, "credentials.enc");
  process.env["SAI_AUDIT_LOG"] = join(tempDir, "audit.jsonl");
  process.env["SAI_JOB_WAKE_DISABLED"] = "1";
  // Sequential: these modules import each other.
  const { createGateway } = await import("../gateway/index.js");
  mods = {
    auth: await import("../gateway/auth.js"),
    sessions: await import("../agent/session.js"),
    config: await import("../config/loader.js"),
  };

  const gateway = createGateway();
  // The gateway listens on <gateway.host>:<gateway.port> (127.0.0.1 outside Docker, 0.0.0.0 in a
  // container); the test binds loopback on a port the OS picks.
  let server: Server | undefined;
  const listen = Server.prototype.listen as (this: Server, port: number, host: string, onListening?: () => void) => Server;
  const listenSpy = vi.spyOn(Server.prototype, "listen").mockImplementation(function (this: Server, ...args: unknown[]) {
    const onListening = args.find((arg): arg is () => void => typeof arg === "function");
    server = listen.call(this, 0, "127.0.0.1", onListening);
    return server;
  } as typeof Server.prototype.listen);
  try {
    await gateway.start();
  } finally {
    listenSpy.mockRestore();
  }
  const address = server?.address() as AddressInfo;
  expect(address.address).toBe("127.0.0.1");
  wsBase = `ws://127.0.0.1:${address.port}/ws`;
  stopGateway = () => gateway.stop();
}, 60_000);

afterAll(async () => {
  await stopGateway();
  await (await import("../audit/logger.js")).flushAuditLog();
  mods.config.resetConfigForTests();
  mods.auth.resetAuthStateForTests();
  for (const key of ENV_KEYS) delete process.env[key];
  rmSync(tempDir, { recursive: true, force: true });
});

type Reply = { ok: boolean; payload?: unknown; error?: string };

/** A dashboard socket with `account`'s token, after hello-ok. */
async function connect(account: typeof vic) {
  const token = await mods.auth.createToken(String(account.record["username"]), account.claims);
  const socket = new WebSocket(wsBase, { headers: { Authorization: `Bearer ${token}` } });
  const replies = new Map<string, (reply: Reply) => void>();
  await new Promise<void>((resolve, reject) => {
    socket.on("message", (data) => {
      const message = JSON.parse(String(data)) as Record<string, unknown>;
      if (message["type"] === "hello-ok") resolve();
      if (message["type"] === "rpc.response") replies.get(String(message["id"]))?.(message as unknown as Reply);
    });
    socket.on("close", (code) => reject(new Error(`closed ${code}`)));
    socket.on("error", reject);
  });
  let counter = 0;
  const call = (method: string, params: Record<string, unknown> = {}) => new Promise<Reply>((resolve) => {
    const id = `${method}-${++counter}`;
    replies.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
  return { call, close: () => socket.close() };
}

describe("the dashboard socket checks each method's minimum role", () => {
  it("refuses a viewer's session.create and chat.send before a turn starts, and runs an operator's", { timeout: 30_000 }, async () => {
    runTurnMock.mockImplementation(async () => ({
      response: "Done.",
      toolCallsExecuted: 0,
      guardrailEvents: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      blocked: false,
    }));

    const viewer = await connect(vic);
    const operator = await connect(olga);
    try {
      expect(await viewer.call("session.create", { channel: "webchat" })).toMatchObject({ ok: false, error: "Forbidden: session.create requires role operator" });
      // A session of its own, from before: still read-only.
      const own = mods.sessions.createSession({ channel: "webchat", userId: "vic", account: vic.id, workspacePath: tempDir });
      expect(await viewer.call("chat.send", { sessionId: own.id, message: "hello", requestId: "viewer-turn" })).toMatchObject({
        ok: false,
        error: "Forbidden: chat.send requires role operator",
      });
      expect((await viewer.call("session.get", { sessionId: own.id })).ok).toBe(true);
      expect(runTurnMock).not.toHaveBeenCalled();
      expect(own.getHistory()).toEqual([]);

      const created = await operator.call("session.create", { channel: "webchat" });
      expect(created.ok).toBe(true);
      const sessionId = (created.payload as { sessionId: string }).sessionId;
      expect(await operator.call("chat.send", { sessionId, message: "hello", requestId: "operator-turn" })).toMatchObject({
        ok: true,
        payload: { accepted: true, requestId: "operator-turn" },
      });
      expect(runTurnMock).toHaveBeenCalledTimes(1);
      expect(runTurnMock.mock.calls[0]![0].session.id).toBe(sessionId);
    } finally {
      viewer.close();
      operator.close();
    }
  });
});
