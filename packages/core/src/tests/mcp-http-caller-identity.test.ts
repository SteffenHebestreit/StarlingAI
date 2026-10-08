import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { SubAgentRunOptions, SubAgentRunResult } from "../agent/sub-agent.js";
import type { ToolContext, ToolResult } from "../tools/registry.js";

/**
 * The MCP HTTP server at /mcp and the account its calls run as (found in review, 2026-10-09).
 *
 * The server checked a token's signature only, so under multi-user auth a deleted account kept
 * calling tools and agents for the rest of its token's lifetime, and the role came from the token's
 * claims, so a demoted account kept operator. Every call ran in the shared workspace root with no
 * account on the run or the request context. And a session id was served to whichever caller sent
 * it, with the identity and role of the caller that opened it. The same gaps the public A2A surface
 * had (e56df4d, 8b03cc6), closed the same way; with one operator everything stays as before.
 */
type Seen = { userId: string | undefined; contextUserId: string | undefined; workspacePath: string };
const runs = vi.hoisted(() => [] as Seen[]);
const toolCalls = vi.hoisted(() => [] as Array<Seen & { userRole: string | undefined }>);

vi.mock("../agent/sub-agent.js", async (importActual) => ({
  ...(await importActual<typeof import("../agent/sub-agent.js")>()),
  runSubAgentWithStats: async (opts: SubAgentRunOptions): Promise<SubAgentRunResult> => {
    // Imported at call time: the mock outlives vi.resetModules, and the request context to read
    // is the module instance the server loaded for this test.
    const { currentUserId } = await import("../runtime/request-context.js");
    runs.push({ userId: opts.userId, contextUserId: currentUserId(), workspacePath: opts.workspacePath });
    return {
      output: "The ferries leave at 07:40.",
      stats: {
        agentName: opts.agentName, sessionId: `sub:${opts.parentSessionId}:${opts.agentName}:1`, promptChars: 0, userContentChars: 0,
        toolCount: 0, toolNames: [], iterations: 1, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        maxIterations: 5, model: "mock", capabilities: [], terminalState: "completed", outcome: "success",
      },
    };
  },
}));

// One Tier-0 native tool, so a native call can be watched without touching the workspace.
vi.mock("../tools/registry.js", async (importActual) => ({
  ...(await importActual<typeof import("../tools/registry.js")>()),
  getAllTools: () => [{
    name: "read_file",
    description: "Read a file.",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    execute: async (): Promise<ToolResult> => ({ success: true, output: "" }),
  }],
  executeTool: async (_name: string, _args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
    const { currentUserId } = await import("../runtime/request-context.js");
    toolCalls.push({ userId: ctx.userId, userRole: ctx.userRole, contextUserId: currentUserId(), workspacePath: ctx.workspacePath });
    return { success: true, output: "timetable.md: 07:40, 09:10" };
  },
}));

const account = (username: string, role: string) => ({
  username, role, passwordHash: "scrypt$placeholder-hash-not-used-here", createdAt: "2026-10-09T00:00:00Z",
});

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
  runs.length = 0;
  toolCalls.length = 0;
  delete process.env["SAI_CONFIG_PATH"];
  delete process.env["SAI_CRED_STORE"];
  (await import("../config/loader.js")).resetConfigForTests();
  (await import("../gateway/auth.js")).resetAuthStateForTests();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

/** Write the deployment's config: Alice and Bob operators and Carol a viewer when `authEnabled`. */
function writeConfig(dir: string, authEnabled: boolean, roles: Record<string, string> = {}): void {
  const users = ["alice", "bob", "carol"].map((name) => account(name, roles[name] ?? (name === "carol" ? "viewer" : "operator")));
  writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
    workspacePath: dir,
    gateway: { jwtSecret: "m".repeat(40) },
    ...(authEnabled ? { auth: { enabled: true, users } } : {}),
    mcp: { expose: { enabled: true, http: { enabled: true, requireAuth: true } } },
    subAgents: { researcher: { description: "Finds sources.", systemPrompt: "Research.", maxIterations: 2 } },
    scenes: {
      ferry_brief: {
        description: "Brief on a ferry route.",
        task: "Summarise the timetable for {{route}}.",
        allowedAgents: ["researcher"],
        params: { route: { description: "The route." } },
      },
    },
  }), "utf8");
}

/** Load the deployment and serve /mcp on a loopback port; returns the endpoint and the shared root. */
async function deployment(authEnabled: boolean): Promise<{ url: string; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "mcp-http-caller-"));
  dirs.push(dir);
  writeConfig(dir, authEnabled);
  process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
  // Scenes are also read from the credential store; a temp one, not the developer's.
  process.env["SAI_CRED_STORE"] = join(dir, "credentials.enc");
  vi.resetModules();
  const { handleMcpHttpRequest } = await import("../mcp/server-http.js");
  const server = createServer((req, res) => {
    void handleMcpHttpRequest(req, res).then((handled) => {
      if (!handled) { res.writeHead(404); res.end(); }
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, dir };
}

/** A gateway token signed for `username`, claiming the operator role. */
async function tokenFor(username: string): Promise<string> {
  const auth = await import("../gateway/auth.js");
  return auth.createToken(username, { role: "operator" });
}

/** An MCP client session opened with `token`; returns the client and its mcp-session-id. */
async function connect(url: string, token: string): Promise<{ client: Client; sessionId: string }> {
  const { Client: McpClient } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new McpClient({ name: "caller-identity-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  clients.push(client);
  return { client, sessionId: transport.sessionId ?? "" };
}

/** The text of a tools/call result. */
function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text?: string }>).map((part) => part.text ?? "").join("");
}

/** A raw JSON-RPC request on /mcp as `token`, naming `sessionId` when given. */
async function rawRequest(url: string, token: string, init: { method?: string; sessionId?: string; body?: unknown }): Promise<Response> {
  return fetch(url, {
    method: init.method ?? "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(init.sessionId ? { "mcp-session-id": init.sessionId } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

const INITIALIZE = {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "caller-identity-test", version: "1.0.0" } },
};
const CALL_RESEARCHER = {
  jsonrpc: "2.0", id: 2, method: "tools/call",
  params: { name: "agent__researcher", arguments: { task: "When do the ferries leave?" } },
};

describe("/mcp and the account behind a token", () => {
  it("under multi-user auth, refuses a signed token whose account is not in the user store", async () => {
    const { url } = await deployment(true);

    const response = await rawRequest(url, await tokenFor("mallory"), { body: INITIALIZE });

    expect(response.status).toBe(401);
    const { getMcpHttpSessionCount } = await import("../mcp/server-http.js");
    expect(getMcpHttpSessionCount()).toBe(0);
  });

  it("under multi-user auth, takes the role from the account, not from the token", async () => {
    const { url, dir } = await deployment(true);
    // Carol is a viewer whose token still says operator.
    const carol = await connect(url, await tokenFor("carol"));
    const refused = await carol.client.callTool({ name: "agent__researcher", arguments: { task: "When do the ferries leave?" } });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("requires the operator role");

    // Alice is demoted after she opened her session: her next call has the role she has now.
    const alice = await connect(url, await tokenFor("alice"));
    expect((await alice.client.callTool({ name: "agent__researcher", arguments: { task: "first" } })).isError).toBe(false);
    writeConfig(dir, true, { alice: "viewer" });
    (await import("../config/loader.js")).resetConfigForTests();
    const afterDemotion = await alice.client.callTool({ name: "agent__researcher", arguments: { task: "second" } });
    expect(afterDemotion.isError).toBe(true);
    expect(textOf(afterDemotion)).toContain("requires the operator role");
    expect(runs).toHaveLength(1);
  });

  it("with one operator, accepts any signed token and its role claim, as before", async () => {
    const { url } = await deployment(false);

    const { client } = await connect(url, await tokenFor("mallory"));
    const result = await client.callTool({ name: "agent__researcher", arguments: { task: "When do the ferries leave?" } });

    expect(result.isError).toBe(false);
    expect(runs).toHaveLength(1);
  });
});

describe("/mcp and the workspace root a call runs in", () => {
  it("under multi-user auth, runs a signed-in account's delegation, scene and tool call in its own root, as that account", async () => {
    const { url } = await deployment(true);
    const { client } = await connect(url, await tokenFor("alice"));

    await client.callTool({ name: "agent__researcher", arguments: { task: "Remember that I prefer the early ferry." } });
    const scene = await client.callTool({ name: "scene__ferry_brief", arguments: { route: "Kiel to Oslo" } });
    await client.callTool({ name: "read_file", arguments: { path: "timetable.md" } });

    expect(scene.isError).toBe(false);
    const { getConfig } = await import("../config/loader.js");
    const { safeUserSegment } = await import("../runtime/user-scope.js");
    const aliceRoot = resolve(getConfig().workspacePath, "users", safeUserSegment("alice"));
    expect(runs).toEqual([
      { userId: "alice", contextUserId: "alice", workspacePath: aliceRoot },
      { userId: "alice", contextUserId: "alice", workspacePath: aliceRoot },
    ]);
    expect(toolCalls).toEqual([{ userId: "alice", userRole: "operator", contextUserId: "alice", workspacePath: aliceRoot }]);
  });

  it("with one operator, runs calls in the shared root with no account, as before", async () => {
    const { url } = await deployment(false);
    const { client } = await connect(url, await tokenFor("alice"));

    await client.callTool({ name: "agent__researcher", arguments: { task: "Remember that I prefer the early ferry." } });
    const scene = await client.callTool({ name: "scene__ferry_brief", arguments: { route: "Kiel to Oslo" } });
    await client.callTool({ name: "read_file", arguments: { path: "timetable.md" } });

    expect(scene.isError).toBe(false);
    const { getConfig } = await import("../config/loader.js");
    const shared = getConfig().workspacePath;
    expect(runs).toEqual([
      { userId: undefined, contextUserId: undefined, workspacePath: shared },
      { userId: undefined, contextUserId: undefined, workspacePath: shared },
    ]);
    expect(toolCalls).toEqual([{ userId: undefined, userRole: undefined, contextUserId: undefined, workspacePath: shared }]);
  });
});

describe("/mcp and the caller a session belongs to", () => {
  it("under multi-user auth, serves a session only to the caller that opened it", async () => {
    const { url } = await deployment(true);
    const alice = await connect(url, await tokenFor("alice"));
    const bobToken = await tokenFor("bob");
    const { getMcpHttpSessionCount } = await import("../mcp/server-http.js");
    const open = getMcpHttpSessionCount();

    const call = await rawRequest(url, bobToken, { sessionId: alice.sessionId, body: CALL_RESEARCHER });
    expect(call.status).toBe(404);
    expect(await call.json()).toEqual({ error: "Unknown MCP session" });
    expect(runs).toHaveLength(0);

    const close = await rawRequest(url, bobToken, { method: "DELETE", sessionId: alice.sessionId });
    expect(close.status).toBe(404);
    expect(getMcpHttpSessionCount()).toBe(open);

    // Alice's own session still serves her.
    const mine = await alice.client.callTool({ name: "agent__researcher", arguments: { task: "When do the ferries leave?" } });
    expect(mine.isError).toBe(false);
    expect(runs.map((run) => run.userId)).toEqual(["alice"]);
  });

  it("with one operator, serves a session to any caller that names it, as before", async () => {
    const { url } = await deployment(false);
    const alice = await connect(url, await tokenFor("alice"));

    const call = await rawRequest(url, await tokenFor("bob"), { sessionId: alice.sessionId, body: CALL_RESEARCHER });
    expect(call.status).toBe(200);
    expect(await call.text()).toContain("The ferries leave at 07:40.");
    expect(runs).toHaveLength(1);
  });
});

describe("/mcp and a request that opens no session", () => {
  it("keeps no session for a GET or a non-initialize POST without a session id, and answers as the SDK does", async () => {
    // Regression (review, 2026-10-09): such a request got a transport of its own that never
    // initialized and was never closed, so each one left a live Server behind.
    const { url } = await deployment(true);
    const token = await tokenFor("alice");
    const { getMcpHttpSessionCount } = await import("../mcp/server-http.js");
    const notInitialized = { jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: Server not initialized" }, id: null };

    const get = await rawRequest(url, token, { method: "GET" });
    expect(get.status).toBe(400);
    expect(await get.json()).toEqual(notInitialized);
    const call = await rawRequest(url, token, { body: CALL_RESEARCHER });
    expect(call.status).toBe(400);
    expect(await call.json()).toEqual(notInitialized);
    expect(getMcpHttpSessionCount()).toBe(0);
    expect(runs).toHaveLength(0);

    // An initialize still opens one, and it serves its caller.
    const { client } = await connect(url, token);
    expect(getMcpHttpSessionCount()).toBe(1);
    expect((await client.callTool({ name: "agent__researcher", arguments: { task: "When do the ferries leave?" } })).isError).toBe(false);
  });
});
