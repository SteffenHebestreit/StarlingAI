import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { SubAgentRunOptions, SubAgentRunResult } from "../agent/sub-agent.js";
import { A2A_ERROR } from "../a2a/protocol.js";
import { testAccount, type TestAccount } from "./support/test-account.js";

/**
 * An ended account's MCP HTTP sessions and A2A tasks (S4).
 *
 * Deleting an account stopped its tokens, so its next MCP request and its next tasks/get were
 * refused. What it had open stayed in memory: each MCP session with a connected server until the
 * client closed it, each A2A task with its output and history for the retention window. A task that
 * was still running when its owner record went (deleted, or past the retention) was stored when it
 * finished with no owner at all, and tasks/get served a task with no owner to any caller.
 */

const run = vi.hoisted(() => ({ gate: null as Promise<void> | null, started: [] as string[] }));
vi.mock("../agent/sub-agent.js", async (importActual) => ({
  ...(await importActual<typeof import("../agent/sub-agent.js")>()),
  runSubAgentWithStats: async (opts: SubAgentRunOptions): Promise<SubAgentRunResult> => {
    run.started.push(opts.task);
    if (run.gate) await run.gate;
    return {
      output: `Answer to: ${opts.task}`,
      stats: {
        agentName: opts.agentName, sessionId: `sub:${opts.parentSessionId}:${opts.agentName}:1`, promptChars: 0, userContentChars: 0,
        toolCount: 0, toolNames: [], iterations: 1, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        maxIterations: 5, model: "mock", capabilities: [], terminalState: "completed", outcome: "success",
      },
    };
  },
}));

const root = testAccount("root", "admin");
const alice = testAccount("alice");
const bob = testAccount("bob");

const dirs: string[] = [];
const servers: HttpServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  run.gate = null;
  run.started.length = 0;
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  const { shutdownMcpHttpSessions } = await import("../mcp/server-http.js");
  await shutdownMcpHttpSessions();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
  await (await import("../audit/logger.js")).flushAuditLog();
  for (const key of ["SAI_CONFIG_PATH", "SAI_MUTABLE_CONFIG_PATH", "SAI_CRED_STORE", "SAI_SESSION_STORE", "SAI_AUDIT_LOG"]) delete process.env[key];
  (await import("../config/loader.js")).resetConfigForTests();
  (await import("../gateway/auth.js")).resetAuthStateForTests();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

/** A deployment where root (admin), alice and bob are accounts. */
async function deployment() {
  const dir = mkdtempSync(join(tmpdir(), "starlingai-lifecycle-bindings-"));
  dirs.push(dir);
  writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
    workspacePath: dir,
    gateway: { jwtSecret: "e".repeat(40) },
    auth: { enabled: true, users: [root.record, alice.record, bob.record] },
    mcp: { expose: { enabled: true, http: { enabled: true, requireAuth: true } } },
    a2a: { enabled: true, exposeAgents: [] },
    subAgents: { researcher: { description: "Finds sources.", systemPrompt: "Research.", maxIterations: 2 } },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
  process.env["SAI_MUTABLE_CONFIG_PATH"] = join(dir, "starlingai.json");
  process.env["SAI_CRED_STORE"] = join(dir, "credentials.enc");
  process.env["SAI_SESSION_STORE"] = join(dir, "sessions.json");
  process.env["SAI_AUDIT_LOG"] = join(dir, "audit.jsonl");
  vi.resetModules();
  const auth = await import("../gateway/auth.js");
  const mcp = await import("../mcp/server-http.js");
  const { registerUserRoutes } = await import("../gateway/user-routes.js");
  const token = (username: string, account: TestAccount) => auth.createToken(username, account.claims);
  const deleteAlice = async () => {
    const app = new Hono();
    registerUserRoutes(app);
    const reply = await app.request("/api/auth/users/alice", { method: "DELETE", headers: { Authorization: `Bearer ${await token("root", root)}` } });
    expect(reply.status).toBe(200);
    return (await reply.json()) as { ended: { bindingsEnded: Record<string, number>; failed: string[] } };
  };
  return { mcp, token, deleteAlice };
}

async function serveMcp(): Promise<string> {
  const { handleMcpHttpRequest } = await import("../mcp/server-http.js");
  const server = createServer((req, res) => {
    void handleMcpHttpRequest(req, res).then((handled) => {
      if (!handled) { res.writeHead(404); res.end(); }
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

async function connect(url: string, token: string): Promise<Client> {
  const { Client: McpClient } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new McpClient({ name: "lifecycle-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  clients.push(client);
  return client;
}

async function a2a(token: string, method: string, params: Record<string, unknown>): Promise<{ result?: { id?: string }; error?: { code: number } }> {
  const { handleA2ARequest } = await import("../a2a/server.js");
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const req = Object.assign(Readable.from([Buffer.from(body)]), {
    method: "POST",
    url: "/a2a/v1",
    headers: { host: "starling.test", authorization: `Bearer ${token}` },
  }) as unknown as IncomingMessage;
  const captured: { body?: string } = {};
  const res = { headersSent: false, writeHead() { /* status unread */ }, end(text?: string) { captured.body = text; } };
  await handleA2ARequest(req, res as unknown as ServerResponse);
  return JSON.parse(captured.body ?? "{}") as { result?: { id?: string }; error?: { code: number } };
}

const send = (text: string) => ({ agentId: "researcher", message: { role: "user", parts: [{ type: "text", text }] } });

describe("deleting an account ends its MCP sessions and A2A tasks", () => {
  it("closes its MCP sessions and forgets its finished A2A tasks; another account's stay", async () => {
    const { mcp, token, deleteAlice } = await deployment();
    const url = await serveMcp();
    await connect(url, await token("alice", alice));
    const his = await connect(url, await token("bob", bob));
    expect(mcp.getMcpHttpSessionCount()).toBe(2);
    const hersTask = (await a2a(await token("alice", alice), "tasks/send", send("hers"))).result?.id;
    const hisTask = (await a2a(await token("bob", bob), "tasks/send", send("his"))).result?.id;
    expect(hersTask).toBeDefined();

    const { ended } = await deleteAlice();
    expect(ended.bindingsEnded).toEqual({ mcpSessions: 1, a2aTasks: 1 });
    expect(ended.failed).toEqual([]);
    expect(mcp.getMcpHttpSessionCount()).toBe(1);
    // Bob's session and task go on.
    expect((await his.listTools()).tools.length).toBeGreaterThan(0);
    expect((await a2a(await token("bob", bob), "tasks/get", { id: hisTask })).result?.id).toBe(hisTask);
  });

  it("does not store the outcome of a task that was still running when its account ended", async () => {
    const { token, deleteAlice } = await deployment();
    let release!: () => void;
    run.gate = new Promise<void>((done) => { release = done; });
    const sending = a2a(await token("alice", alice), "tasks/send", send("hers"));
    await vi.waitFor(() => expect(run.started).toEqual(["hers"]));

    const { ended } = await deleteAlice();
    expect(ended.bindingsEnded["a2aTasks"]).toBe(1);
    release();
    const taskId = (await sending).result?.id;
    expect(taskId).toBeDefined();

    // Stored with no owner, any caller would read it.
    const read = await a2a(await token("bob", bob), "tasks/get", { id: taskId });
    expect(read.result).toBeUndefined();
    expect(read.error?.code).toBe(A2A_ERROR.TASK_NOT_FOUND.code);
  });
});
