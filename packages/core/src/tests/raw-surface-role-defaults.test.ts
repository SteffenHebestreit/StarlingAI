import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import WebSocket from "ws";
import { PRODUCT } from "../product/index.js";
import type { SubAgentRunOptions, SubAgentRunResult } from "../agent/sub-agent.js";
import type { AuditEvent } from "../audit/schema.js";
import { testAccount, type TestAccount } from "./support/test-account.js";

/**
 * The raw surfaces that run agents or reach the live browser take the operator rank under
 * multi-user auth, as /api's mutation gate does.
 *
 * The AG-UI stream, the legacy POST /a2a/agents/:name route, tasks/send at /a2a/v1 and the
 * /ws/browser-vnc upgrade are served outside Hono, so the /api mutation gate never saw them, and
 * each checked only that the token resolved to an account. A viewer could run full turns, run any
 * configured agent (and on the legacy route have every approval-gated call of the run granted with
 * `autoApprove: true`), and drive the shared automation browser. Each now requires a role at
 * operator rank or higher, ranked like the mutation gate, so an extension role at that rank passes.
 *
 * These run against the whole gateway, pinned to an ephemeral port on 127.0.0.1.
 */
const runs = vi.hoisted(() => [] as SubAgentRunOptions[]);
const turns = vi.hoisted(() => [] as Array<{ userId: string | undefined; role: string | undefined }>);

vi.mock("../agent/sub-agent.js", async (importActual) => ({
  ...(await importActual<typeof import("../agent/sub-agent.js")>()),
  runSubAgent: async (opts: SubAgentRunOptions): Promise<string> => {
    runs.push(opts);
    return "done";
  },
  runSubAgentWithStats: async (opts: SubAgentRunOptions): Promise<SubAgentRunResult> => {
    runs.push(opts);
    return {
      output: "done",
      stats: {
        agentName: opts.agentName, sessionId: `sub:${opts.parentSessionId}:${opts.agentName}:1`, promptChars: 0, userContentChars: 0,
        toolCount: 0, toolNames: [], iterations: 1, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        maxIterations: 5, model: "mock", capabilities: [], terminalState: "completed", outcome: "success",
      },
    };
  },
}));

// The turn itself is not under test: the gate in front of it is.
vi.mock("../gateway/agui.js", async (importActual) => ({
  ...(await importActual<typeof import("../gateway/agui.js")>()),
  handleAguiStream: async (res: ServerResponse, _body: unknown, caller?: { userId?: string; role?: string }): Promise<void> => {
    turns.push({ userId: caller?.userId, role: caller?.role });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end("data: {\"type\":\"RUN_FINISHED\"}\n\n");
  },
}));

const CONFIG_PORT = 39_871;
const ENV_KEYS = ["SAI_CONFIG_PATH", "SAI_MASTER_KEY", "SAI_CRED_STORE", "SAI_AUDIT_LOG", "BROWSER_VNC_WS_URL"];
const SHARED_BEARER = "s".repeat(40);

const accounts: Record<string, TestAccount> = {
  vera: testAccount("vera", "viewer"),
  otto: testAccount("otto", "operator"),
  ada: testAccount("ada", "admin"),
  // Extension roles: one at operator rank, one at viewer rank.
  eddie: testAccount("eddie", "editor"),
  gus: testAccount("gus", "guest"),
};

const tempDirs: string[] = [];
const cleanups: Array<() => void> = [];

afterEach(async () => {
  runs.length = 0;
  turns.length = 0;
  for (const cleanup of cleanups.splice(0)) cleanup();
  const audit = await import("../audit/logger.js");
  await audit.flushAuditLog();
  (await import("../extension/index.js"))._resetExtensionsForTests();
  (await import("../config/loader.js")).resetConfigForTests();
  (await import("../gateway/auth.js")).resetAuthStateForTests();
  for (const key of ENV_KEYS) delete process.env[key];
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

/**
 * The gateway listens on its configured port on gateway.host (127.0.0.1 outside Docker, 0.0.0.0 in a
 * container). Its listen call is moved to an ephemeral port on 127.0.0.1, so a run never puts a
 * gateway with a test secret on the network, and the server is kept to read the port it got.
 */
function pinGatewayToLoopback(): () => net.Server | undefined {
  let gatewayServer: net.Server | undefined;
  const original = net.Server.prototype.listen as (...args: unknown[]) => net.Server;
  const spy = vi.spyOn(net.Server.prototype, "listen").mockImplementation(function (this: net.Server, ...args: unknown[]) {
    if (args[0] !== CONFIG_PORT) return original.apply(this, args);
    gatewayServer = this;
    const callback = args.find((arg) => typeof arg === "function");
    return original.call(this, 0, "127.0.0.1", callback);
  } as typeof net.Server.prototype.listen);
  cleanups.push(() => spy.mockRestore());
  return () => gatewayServer;
}

interface BootOptions {
  authEnabled?: boolean;
  a2a?: Record<string, unknown>;
  overrides?: Record<string, unknown>;
}

async function bootGateway(options: BootOptions = {}) {
  const authEnabled = options.authEnabled ?? true;
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-raw-surface-roles-"));
  tempDirs.push(tempDir);
  writeFileSync(join(tempDir, "starlingai.json"), JSON.stringify({
    gateway: { port: CONFIG_PORT, jwtSecret: "j".repeat(40), ...(options.overrides ? { overrides: options.overrides } : {}) },
    workspacePath: tempDir,
    ...(authEnabled ? { auth: { enabled: true, users: Object.values(accounts).map((account) => account.record) } } : {}),
    a2a: { enabled: true, exposeAgents: [], ...options.a2a },
    subAgents: { researcher: { description: "Finds sources.", systemPrompt: "Research.", maxIterations: 2 } },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = join(tempDir, "starlingai.json");
  process.env["SAI_MASTER_KEY"] = "m".repeat(32);
  process.env["SAI_CRED_STORE"] = join(tempDir, PRODUCT.stateDirName, "credentials.enc");
  process.env["SAI_AUDIT_LOG"] = join(tempDir, "audit.jsonl");
  // No browser preview backend: an admitted VNC caller is told so (4404) instead of dialling one.
  process.env["BROWSER_VNC_WS_URL"] = "";
  const gatewayServer = pinGatewayToLoopback();
  vi.resetModules();
  // Sequential imports: these modules import each other.
  const { createGateway } = await import("../gateway/index.js");
  const auth = await import("../gateway/auth.js");
  const extension = await import("../extension/index.js");
  const audit = await import("../audit/logger.js");
  extension._recordLoadedExtension(
    { name: "test-roles", version: "1", toolNames: [], auditEvents: [], roles: [], loadedAt: "", source: "test" },
    {
      name: "test-roles",
      version: "1",
      roles: [
        { name: "editor", description: "Operator-rank test role.", rank: 50 },
        { name: "guest", description: "Viewer-rank test role.", rank: 10 },
      ],
    },
  );
  const events: AuditEvent[] = [];
  cleanups.push(audit.subscribeToAudit((event) => { events.push(event); }));

  const gateway = createGateway();
  await gateway.start();
  const address = gatewayServer()?.address() as AddressInfo | null | undefined;
  if (!address || address.address !== "127.0.0.1") throw new Error("the gateway did not listen on loopback");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const tokenOf = (name: string): Promise<string> => auth.createToken(name, accounts[name]!.claims);
  const post = async (path: string, bearer: string | null, body: unknown): Promise<{ status: number; json: Record<string, any> }> => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let json: Record<string, any> = {};
    try { json = JSON.parse(text) as Record<string, any>; } catch { /* SSE or empty */ }
    return { status: response.status, json };
  };
  const agui = async (name: string) => post("/api/chat/stream", await tokenOf(name), { message: "Summarise the notes." });
  const legacy = async (name: string | null, params: Record<string, unknown> = {}) =>
    post("/a2a/agents/researcher", name ? await tokenOf(name) : null, { jsonrpc: "2.0", id: 1, method: "tasks/send", params: { task: "Summarise the notes.", ...params } });
  const tasksSend = async (bearer: string) => post("/a2a/v1", bearer, {
    jsonrpc: "2.0",
    id: 1,
    method: "tasks/send",
    params: { agentId: "researcher", message: { role: "user", parts: [{ type: "text", text: "Summarise the notes." }] } },
  });
  /** The HTTP status that refused the upgrade, or the close code of the opened socket. */
  const vnc = async (name: string): Promise<{ refused?: number; closed?: number }> => {
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws/browser-vnc?token=${encodeURIComponent(await tokenOf(name))}`);
    return new Promise((resolve) => {
      ws.on("unexpected-response", (_req, res) => { resolve({ refused: res.statusCode }); ws.terminate(); });
      ws.on("close", (code) => resolve({ closed: code }));
      ws.on("error", () => { /* settled by unexpected-response or close */ });
    });
  };
  const flushedEvents = async (): Promise<AuditEvent[]> => {
    await audit.flushAuditLog();
    return events;
  };
  return { agui, legacy, tasksSend, vnc, tokenOf, events: flushedEvents, stop: () => gateway.stop() };
}

describe("the AG-UI stream under multi-user auth", () => {
  it("runs a turn for operator rank and above, and refuses a role below it", async () => {
    const gw = await bootGateway();
    try {
      const viewer = await gw.agui("vera");
      expect(viewer.status).toBe(403);
      expect(viewer.json).toEqual({ error: "Operator role required for this action" });
      expect((await gw.agui("gus")).status).toBe(403);
      expect(turns).toEqual([]);

      expect((await gw.agui("otto")).status).toBe(200);
      expect((await gw.agui("eddie")).status).toBe(200);
      expect((await gw.agui("ada")).status).toBe(200);
      expect(turns.map((turn) => turn.userId)).toEqual(["otto", "eddie", "ada"]);

      const denied = (await gw.events()).filter((event) => event.type === "rbac_denied");
      expect(denied.map((event) => [event.data["surface"], event.data["role"]])).toEqual([["agui", "viewer"], ["agui", "guest"]]);
    } finally {
      await gw.stop();
    }
  }, 60_000);
});

describe("the legacy /a2a/agents route", () => {
  it("under multi-user auth, runs an agent for operator rank and above, and refuses a role below it", async () => {
    const gw = await bootGateway();
    try {
      const viewer = await gw.legacy("vera");
      expect(viewer.status).toBe(403);
      expect(viewer.json["error"]).toEqual({ code: -32003, message: "Operator role required" });
      expect((await gw.legacy("gus")).status).toBe(403);
      expect(runs).toEqual([]);

      const operator = await gw.legacy("otto");
      expect(operator.status).toBe(200);
      expect(operator.json["result"]).toEqual({ output: "done", agentName: "researcher" });
      expect((await gw.legacy("eddie")).status).toBe(200);
      expect(runs.map((run) => run.userId)).toEqual(["otto", "eddie"]);
    } finally {
      await gw.stop();
    }
  }, 60_000);

  it("honours autoApprove from an operator by default, as before", async () => {
    const gw = await bootGateway();
    try {
      expect((await gw.legacy("otto", { autoApprove: true })).status).toBe(200);
      expect(typeof runs[0]?.approvalCallback).toBe("function");
      expect((await gw.events()).some((event) => event.type === "a2a_auto_approve_refused")).toBe(false);
    } finally {
      await gw.stop();
    }
  }, 60_000);

  it("ignores autoApprove below gateway.overrides.autoApproveMinRole, audits it, and honours it at the floor", async () => {
    const gw = await bootGateway({ overrides: { autoApproveMinRole: "admin" } });
    try {
      expect((await gw.legacy("otto", { autoApprove: true })).status).toBe(200);
      expect(runs[0]?.approvalCallback).toBeUndefined();
      const refused = (await gw.events()).filter((event) => event.type === "a2a_auto_approve_refused");
      expect(refused).toHaveLength(1);
      expect(refused[0]?.data).toMatchObject({ agent: "researcher", role: "operator", minRole: "admin" });

      expect((await gw.legacy("ada", { autoApprove: true })).status).toBe(200);
      expect(typeof runs[1]?.approvalCallback).toBe("function");
      expect(await runs[1]!.approvalCallback!("write_file", {})).toBe(true);
    } finally {
      await gw.stop();
    }
  }, 60_000);

  it("ignores autoApprove from every caller when the floor is disabled", async () => {
    const gw = await bootGateway({ overrides: { autoApproveMinRole: "disabled" } });
    try {
      expect((await gw.legacy("ada", { autoApprove: true })).status).toBe(200);
      expect(runs[0]?.approvalCallback).toBeUndefined();
    } finally {
      await gw.stop();
    }
  }, 60_000);

  it("answers 404 before any auth work when a2a.legacyAgentRoute is false", async () => {
    const gw = await bootGateway({ a2a: { legacyAgentRoute: false } });
    try {
      const operator = await gw.legacy("otto");
      expect(operator.status).toBe(404);
      expect(operator.json["error"]).toEqual({ code: -32601, message: "Method not found" });
      expect((await gw.legacy(null)).status).toBe(404);
      expect(runs).toEqual([]);
    } finally {
      await gw.stop();
    }
  }, 60_000);
});

describe("tasks/send at /a2a/v1", () => {
  it("under multi-user auth, refuses an account below operator rank and completes an operator's task", async () => {
    const gw = await bootGateway();
    try {
      const viewer = await gw.tasksSend(await gw.tokenOf("vera"));
      expect(viewer.json["error"]).toEqual({ code: -32003, message: "Operator role required" });
      expect(runs).toEqual([]);

      const operator = await gw.tasksSend(await gw.tokenOf("otto"));
      expect(operator.json["error"]).toBeUndefined();
      expect(operator.json["result"]?.status?.state).toBe("completed");
      expect(runs.map((run) => run.userId)).toEqual(["otto"]);

      const denied = (await gw.events()).filter((event) => event.type === "rbac_denied");
      expect(denied.map((event) => [event.data["surface"], event.data["role"]])).toEqual([["a2a", "viewer"]]);
    } finally {
      await gw.stop();
    }
  }, 60_000);

  it("leaves the shared-bearer machine caller as it was", async () => {
    const gw = await bootGateway({ a2a: { inboundBearerToken: SHARED_BEARER } });
    try {
      const machine = await gw.tasksSend(SHARED_BEARER);
      expect(machine.json["result"]?.status?.state).toBe("completed");
      expect(runs).toHaveLength(1);
    } finally {
      await gw.stop();
    }
  }, 60_000);
});

describe("the browser VNC bridge under multi-user auth", () => {
  it("refuses a viewer at the upgrade and admits an operator", async () => {
    const gw = await bootGateway();
    try {
      expect(await gw.vnc("vera")).toEqual({ refused: 403 });
      expect(await gw.vnc("gus")).toEqual({ refused: 403 });
      // Past the check, the unconfigured preview backend closes the socket.
      expect(await gw.vnc("otto")).toEqual({ closed: 4404 });
      expect(await gw.vnc("eddie")).toEqual({ closed: 4404 });
    } finally {
      await gw.stop();
    }
  }, 60_000);
});

describe("with auth off", () => {
  it("checks no role on these surfaces, as before", async () => {
    const gw = await bootGateway({ authEnabled: false });
    try {
      expect((await gw.agui("vera")).status).toBe(200);
      expect((await gw.legacy("vera", { autoApprove: true })).status).toBe(200);
      expect(typeof runs[0]?.approvalCallback).toBe("function");
      expect((await gw.tasksSend(await gw.tokenOf("vera"))).json["result"]?.status?.state).toBe("completed");
      expect(await gw.vnc("vera")).toEqual({ closed: 4404 });
    } finally {
      await gw.stop();
    }
  }, 60_000);
});
