import { afterEach, describe, expect, it, vi } from "vitest";
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
 * An open MCP HTTP session and an A2A task are their opener's by identity, not by name (S3,
 * ownsRecord). Both compared the caller's username: an account deleted and created again under the
 * same name was served on the old one's open MCP session (as the old one), and read the old one's
 * A2A task output and history by its id.
 */

vi.mock("../agent/sub-agent.js", async (importActual) => ({
  ...(await importActual<typeof import("../agent/sub-agent.js")>()),
  runSubAgentWithStats: async (opts: SubAgentRunOptions): Promise<SubAgentRunResult> => ({
    output: "The ferries leave at 07:40.",
    stats: {
      agentName: opts.agentName, sessionId: `sub:${opts.parentSessionId}:${opts.agentName}:1`, promptChars: 0, userContentChars: 0,
      toolCount: 0, toolNames: [], iterations: 1, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      maxIterations: 5, model: "mock", capabilities: [], terminalState: "completed", outcome: "success",
    },
  }),
}));

/** The same username under another id: an account deleted and created again. */
function recreated(username: string, role = "operator"): TestAccount {
  const base = testAccount(username, role);
  const id = `${username}-${"b".repeat(16)}`;
  return { id, record: { ...base.record, id }, claims: { ...base.claims, aid: id } };
}

const oldAlice = testAccount("alice");
const newAlice = recreated("alice");

const dirs: string[] = [];
const servers: HttpServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  const { shutdownMcpHttpSessions } = await import("../mcp/server-http.js");
  await shutdownMcpHttpSessions();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
  delete process.env["SAI_CONFIG_PATH"];
  delete process.env["SAI_CRED_STORE"];
  (await import("../config/loader.js")).resetConfigForTests();
  (await import("../gateway/auth.js")).resetAuthStateForTests();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

function writeConfig(dir: string, users: TestAccount[]): void {
  writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
    workspacePath: dir,
    gateway: { jwtSecret: "b".repeat(40) },
    auth: { enabled: true, users: users.map((user) => user.record) },
    mcp: { expose: { enabled: true, http: { enabled: true, requireAuth: true } } },
    a2a: { enabled: true, exposeAgents: [] },
    subAgents: { researcher: { description: "Finds sources.", systemPrompt: "Research.", maxIterations: 2 } },
  }), "utf8");
}

/** A deployment where alice is an account; `recreate` deletes her and creates her again. */
async function deployment() {
  const dir = mkdtempSync(join(tmpdir(), "starlingai-ownership-bindings-"));
  dirs.push(dir);
  writeConfig(dir, [oldAlice]);
  process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
  process.env["SAI_CRED_STORE"] = join(dir, "credentials.enc");
  vi.resetModules();
  const auth = await import("../gateway/auth.js");
  const recreate = async () => {
    writeConfig(dir, [newAlice]);
    (await import("../config/loader.js")).resetConfigForTests();
  };
  const token = (account: TestAccount) => auth.createToken("alice", account.claims);
  return { dir, recreate, token };
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

async function connect(url: string, token: string): Promise<string> {
  const { Client: McpClient } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new McpClient({ name: "ownership-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  clients.push(client);
  return transport.sessionId ?? "";
}

const LIST_TOOLS = { jsonrpc: "2.0", id: 7, method: "tools/list", params: {} };

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

describe("a re-created account and the old one's open bindings", () => {
  it("MCP: the old account's session is not served to the new one", async () => {
    const { recreate, token } = await deployment();
    const url = await serveMcp();
    const sessionId = await connect(url, await token(oldAlice));
    expect(sessionId).not.toBe("");

    await recreate();
    const reused = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await token(newAlice)}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify(LIST_TOOLS),
    });
    expect(reused.status).toBe(404);
    expect(await reused.text()).toContain("Unknown MCP session");
  });

  it("A2A: tasks/get of the old account's task answers as an unknown task", async () => {
    const { recreate, token } = await deployment();
    const sent = await a2a(await token(oldAlice), "tasks/send", {
      agentId: "researcher",
      message: { role: "user", parts: [{ type: "text", text: "When do the ferries leave?" }] },
    });
    const taskId = sent.result?.id;
    expect(taskId).toBeDefined();
    // Its own opener reads it.
    expect((await a2a(await token(oldAlice), "tasks/get", { id: taskId })).result?.id).toBe(taskId);

    await recreate();
    const read = await a2a(await token(newAlice), "tasks/get", { id: taskId });
    expect(read.result).toBeUndefined();
    expect(read.error?.code).toBe(A2A_ERROR.TASK_NOT_FOUND.code);
  });
});
