import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server as NetServer } from "node:net";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SwarmState, ToolContext } from "../tools/registry.js";
import { testAccount, testAccountId } from "./support/test-account.js";

/**
 * THE CALLER'S ROLE REACHES EVERY RUN, AND AN EXTENSION CAN REFUSE A CALL BEFORE ANYONE IS ASKED TO
 * APPROVE IT.
 *
 * Only the orchestrator's ToolContext carried the caller's role. A sub-agent's context had none, and
 * neither had the runs every other entry starts (run_workflow, A2A, MCP, a queued job), so the
 * role-aware tools read "no role": knowledge-base management and schedules treat that as "no
 * gating" and let a viewer's delegated call through, and the model switch refuses an admin's. The
 * role now rides the request context (RequestContext.callerRole) as the user-input channel does,
 * and every run hands it to its tools. These drive the real runner with a scripted model and a
 * probe tool that records the role it sees.
 *
 * An extension could not veto a call for a role at all: ExtensionToolDef had no `refuse` and there
 * was no registry hook, and a check inside execute() runs only after the approval card was shown.
 */

const completeMock = vi.hoisted(() => vi.fn());
/** The orchestrator's streamed responses (runTurn); a sub-agent's calls go to completeMock. */
const streamMock = vi.hoisted(() => vi.fn());
vi.mock("../providers/lmstudio.js", async (importActual) => ({
  ...(await importActual<typeof import("../providers/lmstudio.js")>()),
  LMStudioProvider: class {
    async complete(messages: unknown, tools: unknown, signal?: AbortSignal) {
      return completeMock(messages, tools, signal);
    }
    stream(...args: unknown[]) {
      return streamMock(...args);
    }
  },
}));

const auditSpy = vi.hoisted(() => vi.fn());
vi.mock("../audit/logger.js", async (importActual) => ({
  ...(await importActual<typeof import("../audit/logger.js")>()),
  logAudit: auditSpy,
}));

type Message = { role: string; content?: string | null };
const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const call = (id: string, name: string, args: Record<string, unknown>) =>
  ({ content: "", tool_calls: [{ id, name, arguments: args }], usage, finishReason: "tool_calls" });
const answer = (content: string) => ({ content, tool_calls: [], usage, finishReason: "stop" });
const toolResultsIn = (messages: Message[]) => messages.filter((m) => m.role === "tool").length;
const systemIncludes = (messages: Message[], marker: string) =>
  messages.some((m) => m.role === "system" && String(m.content ?? "").includes(marker));

/** The painter calls the probe once, then reports; the art director hands the work to the painter. */
function scriptedModel(messages: Message[]) {
  if (systemIncludes(messages, "LEAF-P41")) {
    return toolResultsIn(messages) === 0 ? call("probe-1", "role_probe", {}) : answer("Painted the harbour at dusk.");
  }
  if (systemIncludes(messages, "COORD-A77")) {
    return toolResultsIn(messages) === 0
      ? call("dl-1", "delegate_to_agent", { agentName: "painter", task: "Paint the harbour at dusk." })
      : answer("The harbour picture is done.");
  }
  return answer("ok");
}

const VERA = testAccount("vera", "viewer");
const OTTO = testAccount("otto", "operator");
const ADA = testAccount("ada", "admin");

const dirs: string[] = [];
/** The role each role_probe call saw (ToolContext.userRole), in call order. */
let probeRoles: Array<string | undefined> = [];

const SUB_AGENTS = {
  painter: {
    description: "Paints pictures.",
    systemPrompt: "LEAF-P41 Paint what you are asked for.",
    tools: ["role_probe"],
    maxIterations: 4,
  },
  art_director: {
    description: "Coordinates picture work.",
    systemPrompt: "COORD-A77 Hand the painting to a specialist.",
    tools: ["delegate_to_agent"],
    maxIterations: 4,
  },
};

/** A deployment with the painter and the art director; returns its root. */
function deployment(extra: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "sai-caller-role-"));
  dirs.push(dir);
  writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
    workspacePath: dir,
    gateway: { jwtSecret: "r".repeat(40), turnTimeoutMs: 30_000 },
    subAgents: SUB_AGENTS,
    ...extra,
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
  return dir;
}

/** Registers role_probe (a Tier-0 tool with an extension tier) in this test's module instances. */
async function registerProbe(): Promise<void> {
  await import("../tools/sub-agent.js");
  await import("../tools/workflow-catalog.js");
  const [{ registerTool }, { registerExtensionToolTier, ToolTier }] = await Promise.all([
    import("../tools/registry.js"),
    import("../guardrails/tool-tiers.js"),
  ]);
  registerExtensionToolTier("role_probe", {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Records the caller's role.",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  }, "test");
  registerTool({
    name: "role_probe",
    description: "Records the caller's role.",
    parameters: { type: "object", properties: {} },
    async execute(_args, ctx) {
      probeRoles.push(ctx.userRole);
      return { success: true, output: "probed" };
    },
  });
}

const freshSwarmState = (): SwarmState => ({
  objective: "test",
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  tasks: {},
});

beforeEach(() => {
  vi.resetModules();
  probeRoles = [];
  completeMock.mockImplementation(async (messages: Message[]) => scriptedModel(messages));
});

afterEach(async () => {
  completeMock.mockReset();
  auditSpy.mockReset();
  try {
    (await import("../tools/registry.js"))._resetToolCallAuthorizersForTests();
    await (await import("../swarm/memory.js")).resetSharedMemoryForTests();
    (await import("../gateway/auth.js")).resetAuthStateForTests();
    (await import("../config/loader.js")).resetConfigForTests();
  } catch {
    // module instances of a test that failed early
  }
  delete process.env["SAI_CONFIG_PATH"];
  delete process.env["SAI_EXTENSIONS_DIR"];
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

/** What a chat turn's work carries for a signed-in person (runTurn sets it); everything below inherits it. */
async function inTurn<T>(role: string, fn: () => Promise<T>): Promise<T> {
  const { runWithRequestContext } = await import("../runtime/request-context.js");
  return runWithRequestContext({ identity: { userId: "alice" }, sessionId: "chat-1", agentName: "main", callerRole: role }, fn);
}

describe("a delegated run's tools see the role of the person it answers to", () => {
  it.each(["viewer", "operator"])("delegate_to_agent from a %s's turn", async (role) => {
    const dir = deployment();
    await registerProbe();
    const { executeTool } = await import("../tools/registry.js");

    // The orchestrator's ToolContext carries the session's role, as runTurn builds it.
    const ctx: ToolContext = { sessionId: "chat-1", workspacePath: dir, userId: "alice", userRole: role, swarmState: freshSwarmState() };
    const result = await inTurn(role, () => executeTool("delegate_to_agent", { agentName: "painter", task: "Paint the harbour at dusk." }, ctx));

    expect(result.success, result.error).toBe(true);
    expect(probeRoles).toEqual([role]);
  }, 30_000);

  it("two delegations down, through a coordinator", async () => {
    const dir = deployment();
    await registerProbe();
    const { executeTool } = await import("../tools/registry.js");

    const ctx: ToolContext = { sessionId: "chat-1", workspacePath: dir, userId: "alice", userRole: "viewer", swarmState: freshSwarmState() };
    await inTurn("viewer", () => executeTool("delegate_to_agent", { agentName: "art_director", task: "Get the harbour painted." }, ctx));

    expect(probeRoles).toEqual(["viewer"]);
  }, 30_000);

  it("a run whose caller threads no role takes the one its work carries", async () => {
    // A path that builds its own run options and names no role (a workflow step, the QA judge):
    // the role comes from the request context.
    const dir = deployment();
    await registerProbe();
    const { runSubAgentWithStats } = await import("../agent/sub-agent.js");

    await inTurn("viewer", () => runSubAgentWithStats({ agentName: "painter", task: "Paint the harbour at dusk.", parentSessionId: "chat-1", workspacePath: dir }));

    expect(probeRoles).toEqual(["viewer"]);
  }, 30_000);

  it.each(["viewer", "operator"])("run_workflow from a %s's turn", async (role) => {
    const dir = deployment({
      scenes: { harbour_scene: { description: "Paints the harbour.", task: "Use painter to paint the harbour at dusk.", allowedAgents: ["painter"] } },
    });
    await registerProbe();
    const { executeTool } = await import("../tools/registry.js");

    const ctx: ToolContext = { sessionId: "chat-1", workspacePath: dir, userId: "alice", userRole: role, swarmState: freshSwarmState() };
    const result = await inTurn(role, () => executeTool("run_workflow", { name: "harbour_scene", workflowType: "scene" }, ctx));

    expect(result.success, result.error).toBe(true);
    expect(probeRoles).toEqual([role]);
  }, 30_000);

  it("delegate_to_agent hands down its ToolContext's role, with no role on the request context", async () => {
    const dir = deployment();
    await registerProbe();
    const { getTool } = await import("../tools/registry.js");

    const ctx: ToolContext = { sessionId: "chat-1", workspacePath: dir, userId: "alice", userRole: "viewer", swarmState: freshSwarmState() };
    const result = await getTool("delegate_to_agent")!.execute({ agentName: "painter", task: "Paint the harbour at dusk." }, ctx);

    expect(result.success, result.error).toBe(true);
    expect(probeRoles).toEqual(["viewer"]);
  }, 30_000);

  it("a tool that starts a run without threading a role hands down its call's own role", async () => {
    // run_workflow builds its runs' options itself and names no role; executeTool puts the call's
    // role on the context the tool runs in (an MCP client calling run_workflow natively, for one).
    const dir = deployment({
      scenes: { harbour_scene: { description: "Paints the harbour.", task: "Use painter to paint the harbour at dusk.", allowedAgents: ["painter"] } },
    });
    await registerProbe();
    const { executeTool } = await import("../tools/registry.js");

    const ctx: ToolContext = { sessionId: "mcp-1", workspacePath: dir, userId: "alice", userRole: "operator", swarmState: freshSwarmState() };
    const result = await executeTool("run_workflow", { name: "harbour_scene", workflowType: "scene" }, ctx);

    expect(result.success, result.error).toBe(true);
    expect(probeRoles).toEqual(["operator"]);
  }, 30_000);

  it("with nobody signed in (a channel, a cron run), the run's tools see no role, as before", async () => {
    const dir = deployment();
    await registerProbe();
    const { executeTool } = await import("../tools/registry.js");

    const ctx: ToolContext = { sessionId: "telegram-1", workspacePath: dir, swarmState: freshSwarmState() };
    const result = await executeTool("delegate_to_agent", { agentName: "painter", task: "Paint the harbour at dusk." }, ctx);

    expect(result.success, result.error).toBe(true);
    expect(probeRoles).toEqual([undefined]);
  }, 30_000);
});

describe("a turn hands its role to everything it runs", () => {
  /** One streamed response that calls `name`. */
  function toolStream(name: string, args: Record<string, unknown>) {
    return (async function* () {
      yield { type: "tool_call_start", toolCallId: `call_${name}`, toolName: name };
      yield { type: "tool_call_delta", toolCallId: `call_${name}`, argumentsDelta: JSON.stringify(args) };
      yield { type: "done", finishReason: "tool_calls", usage };
    })();
  }
  function answerStream(text: string) {
    return (async function* () {
      yield { type: "text_delta", content: text };
      yield { type: "done", finishReason: "stop", usage };
    })();
  }

  /** A deployment whose orchestrator delegates to the painter once, then answers; the turn's
   *  outside dependencies are stubbed. Returns its root. */
  async function delegatingOrchestrator(extra: Record<string, unknown> = {}): Promise<string> {
    const dir = deployment({ agents: { mainAssistant: { toolMode: "orchestration_only" } }, ...extra });
    vi.doMock("../guardrails/rate-limiter.js", () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })) }));
    vi.doMock("../guardrails/moderation.js", () => ({
      moderateInputText: vi.fn(async () => null),
      moderateToolResultText: vi.fn(async () => null),
    }));
    vi.doMock("../retrieval/document-rag.js", () => ({
      augmentTurnWithDocuments: async () => ({ ingested: 0, failed: 0, contextBlock: "", retrievalUnavailable: false }),
    }));
    await registerProbe();
    let streamed = 0;
    streamMock.mockImplementation(() => {
      streamed += 1;
      return streamed === 1
        ? toolStream("delegate_to_agent", { agentName: "painter", task: "Paint the harbour at dusk." })
        : answerStream("The harbour is painted.");
    });
    return dir;
  }

  /** The orchestrator delegates to the painter once (the turn is directed to it), then answers. */
  async function directedTurn(sessionRole: string | undefined, surfaceRole?: string) {
    const dir = await delegatingOrchestrator();
    const [{ AgentSession }, { runTurn }, { runWithRequestContext }] = await Promise.all([
      import("../agent/session.js"),
      import("../agent/runtime.js"),
      import("../runtime/request-context.js"),
    ]);
    const session = new AgentSession({
      channel: "test",
      workspacePath: dir,
      systemPrompt: "You are a test agent.",
      ...(sessionRole ? { userRole: sessionRole } : {}),
    });
    const turn = () => runTurn({ session, userMessage: "Paint the harbour at dusk.", allowedAgents: ["painter"], directiveAgent: "painter" });
    return surfaceRole ? runWithRequestContext({ callerRole: surfaceRole }, turn) : turn();
  }

  afterEach(() => {
    streamMock.mockReset();
    vi.doUnmock("../guardrails/rate-limiter.js");
    vi.doUnmock("../guardrails/moderation.js");
    vi.doUnmock("../retrieval/document-rag.js");
  });

  it.each(["viewer", "operator"])("a turn directed to an agent on a %s's session", async (role) => {
    await directedTurn(role);

    expect(probeRoles).toEqual([role]);
  }, 60_000);

  it("a session that holds no role takes the one its surface or enclosing work set", async () => {
    // A workflow step's nested turn runs on a session of its own, which no sign-in created. The
    // turn's own tool calls carry the role (its ToolContext.userRole), and so does the run it starts.
    const calls: Array<{ tool: string; role: string | undefined }> = [];
    vi.doMock("../tools/registry.js", async (importActual) => {
      const actual = await importActual<typeof import("../tools/registry.js")>();
      return {
        ...actual,
        executeTool: (name: string, args: Record<string, unknown>, ctx: ToolContext, meta?: { toolCallId?: string }) => {
          calls.push({ tool: name, role: ctx.userRole });
          return actual.executeTool(name, args, ctx, meta);
        },
      };
    });
    try {
      await directedTurn(undefined, "viewer");
    } finally {
      vi.doUnmock("../tools/registry.js");
    }

    expect(calls.filter((c) => c.tool === "delegate_to_agent")).toEqual([{ tool: "delegate_to_agent", role: "viewer" }]);
    expect(probeRoles).toEqual(["viewer"]);
  }, 60_000);

  it("a queued job with no role runs its agents' tools with none, though an admin's work woke the worker", async () => {
    // The real runTurn takes the context's role for a session with none, and a job's run started in
    // the context of whatever queued work woke the worker.
    await delegatingOrchestrator({ auth: { enabled: true, provider: "builtin", users: [ADA.record] } });
    const [jobs, scene, { runWithRequestContext }] = await Promise.all([
      import("../agent/jobs.js"),
      import("../agent/scene-worker.js"),
      import("../runtime/request-context.js"),
    ]);
    try {
      await scene.startSceneJobWorker();
      const job = await runWithRequestContext(
        { identity: { userId: "ada", account: ADA.id }, sessionId: "chat-ada", agentName: "main", callerRole: "admin" },
        () => jobs.createJob({ sceneName: "hook", task: "Paint the harbour at dusk.", turnTimeoutMs: 30_000, userId: "scene:hook", principal: "synthetic" }),
      );
      const deadline = Date.now() + 45_000;
      for (let current = await jobs.getJob(job.id); current?.status !== "completed"; current = await jobs.getJob(job.id)) {
        if (current?.status === "failed" || Date.now() > deadline) throw new Error(`job ${job.id} ended as ${current?.status}: ${current?.error ?? ""}`);
        await new Promise((done) => setTimeout(done, 25));
      }
    } finally {
      await scene.stopSceneJobWorker();
      await jobs.resetJobsForTests();
    }

    expect(probeRoles).toEqual([undefined]);
  }, 60_000);
});

describe("the surfaces that run an agent without a turn hand it the caller's role", () => {
  const accounts = { auth: { enabled: true, users: [VERA.record, OTTO.record, ADA.record] } };

  async function tokenFor(username: string, claims: Record<string, unknown>): Promise<string> {
    const auth = await import("../gateway/auth.js");
    return auth.createToken(username, claims);
  }

  /** tasks/send on the public A2A surface, to the painter. */
  async function a2aSend(bearer: string): Promise<{ status?: number; body?: string }> {
    const { handleA2ARequest } = await import("../a2a/server.js");
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tasks/send",
      params: { agentId: "painter", message: { role: "user", parts: [{ type: "text", text: "Paint the harbour at dusk." }] } },
    });
    const req = Object.assign(Readable.from([Buffer.from(body)]), {
      method: "POST",
      url: "/a2a/v1",
      headers: { host: "starling.test", authorization: `Bearer ${bearer}` },
    }) as unknown as IncomingMessage;
    const captured: { status?: number; body?: string } = {};
    const res = {
      headersSent: false,
      writeHead(status: number) { captured.status = status; },
      end(text?: string) { captured.body = text; },
    };
    await handleA2ARequest(req, res as unknown as ServerResponse);
    return captured;
  }

  // Operator and admin: raw-surface role defaults refuse a viewer on A2A, and the role must arrive
  // either way.
  it.each([["otto", OTTO, "operator"], ["ada", ADA, "admin"]] as const)("A2A tasks/send from %s", async (username, account, role) => {
    deployment({ ...accounts, a2a: { enabled: true, exposeAgents: [] } });
    await registerProbe();

    const { status } = await a2aSend(await tokenFor(username, account.claims));

    expect(status).toBe(200);
    expect(probeRoles).toEqual([role]);
  }, 30_000);

  it.each([["otto", OTTO, "operator"], ["ada", ADA, "admin"]] as const)("an MCP agent__ call from %s", async (username, account, role) => {
    // A viewer may not delegate over MCP at all (isMcpOperator), so the roles that may are checked.
    deployment({ ...accounts, mcp: { expose: { enabled: true, exposeAgents: [] } } });
    await registerProbe();
    const [{ createStarlingMcpServer }, { InMemoryTransport }, { Client }] = await Promise.all([
      import("../mcp/server.js"),
      import("@modelcontextprotocol/sdk/inMemory.js"),
      import("@modelcontextprotocol/sdk/client/index.js"),
    ]);
    const server = createStarlingMcpServer({
      caller: username,
      role,
      userId: username,
      identity: { userId: username, account: account.id },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "caller-role-test", version: "1.0.0" });
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({ name: "agent__painter", arguments: { task: "Paint the harbour at dusk." } });
      expect(result.isError).toBeFalsy();
    } finally {
      await client.close();
      await server.close();
    }

    expect(probeRoles).toEqual([role]);
  }, 30_000);

  it("an MCP scene__ call", async () => {
    deployment({
      ...accounts,
      mcp: { expose: { enabled: true, exposeAgents: [], exposeScenes: [] } },
      scenes: { harbour_scene: { description: "Paints the harbour.", task: "Use painter to paint the harbour at dusk.", allowedAgents: ["painter"] } },
    });
    await registerProbe();
    const [{ createStarlingMcpServer }, { InMemoryTransport }, { Client }] = await Promise.all([
      import("../mcp/server.js"),
      import("@modelcontextprotocol/sdk/inMemory.js"),
      import("@modelcontextprotocol/sdk/client/index.js"),
    ]);
    const server = createStarlingMcpServer({ caller: "otto", role: "operator", userId: "otto", identity: { userId: "otto", account: OTTO.id } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "caller-role-test", version: "1.0.0" });
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({ name: "scene__harbour_scene", arguments: {} });
      expect(result.isError).toBeFalsy();
    } finally {
      await client.close();
      await server.close();
    }

    expect(probeRoles).toEqual(["operator"]);
  }, 30_000);

  it("an AG-UI stream that resumes a session holding no role hands runTurn the caller's role", async () => {
    deployment();
    const seen: Array<{ callerRole: string | undefined; sessionRole: string | undefined }> = [];
    vi.doMock("../agent/runtime.js", () => ({
      runTurn: vi.fn(async (opts: { session: { userRole?: string } }) => {
        const { currentRequestContext } = await import("../runtime/request-context.js");
        seen.push({ callerRole: currentRequestContext()?.callerRole, sessionRole: opts.session.userRole });
        return { response: "done", toolCallsExecuted: 0, guardrailEvents: [], usage, blocked: false };
      }),
    }));
    try {
      const [{ handleAguiStream }, sessions] = await Promise.all([import("../gateway/agui.js"), import("../agent/session.js")]);
      // A session of vera's that no sign-in stamped with a role (a channel's, one restored from before roles).
      const resumed = sessions.createSession({ sessionId: "agui-resume-1", channel: "webchat:agui", userId: "vera" });
      const res = { writeHead() {}, write() { return true; }, end() {}, on() {}, once() {}, off() {}, writableEnded: false };

      await handleAguiStream(res as never, { sessionId: resumed.id, message: "Paint the harbour." }, { userId: "vera", role: "viewer" });

      expect(seen).toEqual([{ callerRole: "viewer", sessionRole: undefined }]);
    } finally {
      vi.doUnmock("../agent/runtime.js");
      const sessions = await import("../agent/session.js");
      for (const session of sessions.getAllSessions()) sessions.endSession(session.id);
    }
  });
});

describe("the gateway's entries queue and run work with the caller's role", () => {
  /**
   * The gateway listens on gateway.host: 127.0.0.1 unless configured, 0.0.0.0 in a container. Every
   * listen in this test is rewritten to the loopback address so a test gateway with a test secret is
   * never reachable from the network; the hosts actually bound are recorded and checked.
   */
  function loopbackOnly(): { hosts: unknown[]; restore: () => void } {
    const hosts: unknown[] = [];
    const realListen = NetServer.prototype.listen;
    const spy = vi.spyOn(NetServer.prototype, "listen").mockImplementation(function (this: NetServer, ...args: unknown[]) {
      let rewritten = args;
      if (typeof args[0] === "object" && args[0] !== null) {
        rewritten = [{ ...(args[0] as Record<string, unknown>), host: "127.0.0.1" }, ...args.slice(1)];
      } else if (typeof args[0] === "number") {
        const rest = args.slice(1);
        if (typeof rest[0] === "string") rest[0] = "127.0.0.1";
        else rest.unshift("127.0.0.1");
        rewritten = [args[0], ...rest];
      }
      hosts.push(typeof rewritten[0] === "object" ? (rewritten[0] as { host?: unknown }).host : rewritten[1]);
      return realListen.apply(this, rewritten as Parameters<typeof realListen>);
    });
    return { hosts, restore: () => spy.mockRestore() };
  }

  const WEBHOOK_KEY = "w".repeat(24);

  it("the legacy A2A route runs as the caller's role, and the scene and job run routes queue it", { timeout: 90_000 }, async () => {
    const port = 41_000 + Math.floor(Math.random() * 2_000);
    const dir = deployment({
      gateway: { port, jwtSecret: "r".repeat(40), turnTimeoutMs: 30_000 },
      auth: { enabled: true, users: [VERA.record, OTTO.record, ADA.record] },
      scenes: { harbour_scene: { description: "Paints the harbour.", task: "Use painter to paint the harbour at dusk.", allowedAgents: ["painter"], webhookKey: WEBHOOK_KEY } },
      jobs: { harbour_job: { description: "Paints the harbour.", steps: [{ scene: "harbour_scene" }] } },
    });
    process.env["SAI_MASTER_KEY"] = "m".repeat(32);
    process.env["SAI_CRED_STORE"] = join(dir, "credentials.enc");
    process.env["SAI_JOB_WAKE_DISABLED"] = "1";
    const listen = loopbackOnly();
    await registerProbe();
    const { createGateway } = await import("../gateway/index.js");
    const [auth, jobs] = [await import("../gateway/auth.js"), await import("../agent/jobs.js")];
    const gateway = createGateway();
    try {
      await gateway.start();
      expect(listen.hosts.length).toBeGreaterThan(0);
      expect(listen.hosts.every((host) => host === "127.0.0.1")).toBe(true);
      const base = `http://127.0.0.1:${port}`;
      const bearer = async (username: string, claims: Record<string, unknown>) => ({ Authorization: `Bearer ${await auth.createToken(username, claims)}` });

      // The legacy A2A route: an admin's task runs, and its tools see the admin's role.
      const a2a = await fetch(`${base}/a2a/agents/painter`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await bearer("ada", ADA.claims)) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tasks/send", params: { task: "Paint the harbour at dusk." } }),
      });
      expect(a2a.status).toBe(200);
      expect(probeRoles).toEqual(["admin"]);

      // The run routes queue a signed-in caller's run with their role; a webhook key's with none.
      expect((await fetch(`${base}/api/scenes/harbour_scene/run`, { method: "POST", headers: await bearer("otto", OTTO.claims) })).status).toBe(200);
      expect((await fetch(`${base}/api/jobs/harbour_job/run`, { method: "POST", headers: await bearer("ada", ADA.claims) })).status).toBe(200);
      expect((await fetch(`${base}/api/scenes/harbour_scene/run?key=${WEBHOOK_KEY}`, { method: "POST" })).status).toBe(200);
      const queued: Array<{ userId?: string; requestedByRole?: string }> = [];
      for (let claimed = await jobs.claimNextJob("test-worker"); claimed; claimed = await jobs.claimNextJob("test-worker")) {
        queued.push({ userId: claimed.userId, requestedByRole: claimed.payload.requestedByRole });
      }
      expect(queued).toEqual([
        { userId: "otto", requestedByRole: "operator" },
        { userId: "ada", requestedByRole: "admin" },
        { userId: "scene:harbour_scene", requestedByRole: undefined },
      ]);
    } finally {
      await gateway.stop();
      listen.restore();
      await jobs.resetJobsForTests();
      for (const key of ["SAI_MASTER_KEY", "SAI_CRED_STORE", "SAI_JOB_WAKE_DISABLED"]) delete process.env[key];
    }
  });

  it("chat /job queues the run with the connection's role; a connection with no user, with none", async () => {
    deployment({
      scenes: { harbour_scene: { description: "Paints the harbour.", task: "Use painter to paint the harbour at dusk." } },
      jobs: { harbour_job: { description: "Paints the harbour.", steps: [{ scene: "harbour_scene" }] } },
    });
    process.env["SAI_JOB_WAKE_DISABLED"] = "1";
    // Sequential: these modules import each other.
    const { RpcConnection } = await import("../gateway/rpc.js");
    const sessions = await import("../agent/session.js");
    const jobs = await import("../agent/jobs.js");
    try {
      for (const [userId, role] of [["otto", "operator"], [undefined, undefined]] as const) {
        const active = sessions.createSession({ channel: "webchat", ...(userId ? { userId } : {}) });
        const connection = new RpcConnection({ readyState: 1, send() {} } as never, userId, role);
        await connection.handleMessage(JSON.stringify({ id: "req-job", method: "chat.send", params: { sessionId: active.id, requestId: `turn-${userId}`, message: "/job harbour_job" } }));
        connection.close();
      }
      const queued: Array<{ userId?: string; requestedByRole?: string }> = [];
      for (let claimed = await jobs.claimNextJob("test-worker"); claimed; claimed = await jobs.claimNextJob("test-worker")) {
        queued.push({ userId: claimed.userId, requestedByRole: claimed.payload.requestedByRole });
      }
      expect(queued).toEqual([
        { userId: "otto", requestedByRole: "operator" },
        { userId: "job:harbour_job", requestedByRole: undefined },
      ]);
    } finally {
      await jobs.resetJobsForTests();
      for (const session of sessions.getAllSessions()) sessions.endSession(session.id);
      delete process.env["SAI_JOB_WAKE_DISABLED"];
    }
  });

  it("the Postgres job store keeps the role in the payload and reads it back", async () => {
    deployment();
    const rows: Array<Record<string, unknown>> = [];
    vi.doMock("pg", () => {
      class FakePool {
        async query(sql: string, params: unknown[] = []) {
          if (sql.includes("INSERT INTO scene_jobs")) {
            rows.push({
              id: params[0], scene_name: params[1], definition_type: params[2], session_id: params[3], user_id: params[4],
              status: "running", created_at: params[6], progress: JSON.parse(String(params[7])), payload: JSON.parse(String(params[8])), account_id: params[9],
            });
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes("RETURNING jobs.*")) return { rows: rows.splice(0, 1), rowCount: 1 };
          return { rows: [], rowCount: 0 };
        }
        async connect() { return { query: this.query.bind(this), release() {} }; }
        async end() {}
        on() {}
      }
      return { default: { Pool: FakePool } };
    });
    process.env["DATABASE_URL"] = "postgres://user:pw@db.invalid:5432/db";
    try {
      const jobs = await import("../agent/jobs.js");
      await jobs.createJob({ sceneName: "nightly", task: "Summarise the day.", turnTimeoutMs: 30_000, userId: "otto", account: OTTO.id, requestedByRole: "operator" });

      const claimed = await jobs.claimNextJob("test-worker");

      expect(claimed?.payload.requestedByRole).toBe("operator");
    } finally {
      delete process.env["DATABASE_URL"];
      vi.doUnmock("pg");
      await (await import("../agent/jobs.js")).resetJobsForTests().catch(() => undefined);
    }
  });
});

describe("a queued job runs with its owner's role as it stands when the run starts", () => {
  const owner = { userId: "otto", account: testAccountId("otto") };
  /** The role of each run's session, and the role on the request context the run started in. The
   *  real runTurn takes the session's, else the context's (agent/runtime.ts). */
  let sessionRoles: Array<string | undefined> = [];
  let contextRoles: Array<string | undefined> = [];

  async function worker(users: Array<Record<string, unknown>>) {
    deployment({ auth: { enabled: true, provider: "builtin", users } });
    sessionRoles = [];
    contextRoles = [];
    vi.doMock("../agent/runtime.js", () => ({
      collectTurnArtifactAttachments: () => [],
      runTurn: vi.fn(async (opts: { session: { userRole?: string } }) => {
        const { currentRequestContext } = await import("../runtime/request-context.js");
        sessionRoles.push(opts.session.userRole);
        contextRoles.push(currentRequestContext()?.callerRole);
        return { response: "ran", toolCallsExecuted: 0, guardrailEvents: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, blocked: false };
      }),
    }));
    const [jobs, scene] = await Promise.all([import("../agent/jobs.js"), import("../agent/scene-worker.js")]);
    return { jobs, scene };
  }

  /** Waits until the job is completed or failed. */
  async function settled(mods: Awaited<ReturnType<typeof worker>>, jobId: string) {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const current = await mods.jobs.getJob(jobId);
      if (current && (current.status === "completed" || current.status === "failed")) return current;
      if (Date.now() > deadline) throw new Error(`job ${jobId} did not finish`);
      await new Promise((done) => setTimeout(done, 20));
    }
  }

  async function runOne(mods: Awaited<ReturnType<typeof worker>>, input: Record<string, unknown>) {
    const job = await mods.jobs.createJob({ sceneName: "nightly", task: "Summarise the day.", turnTimeoutMs: 30_000, ...input });
    expect(await mods.scene.runSceneJobWorkerTick()).toBe(true);
    return settled(mods, job.id);
  }

  afterEach(async () => {
    try {
      await (await import("../agent/scene-worker.js")).stopSceneJobWorker();
      await (await import("../agent/jobs.js")).resetJobsForTests();
      (await import("../runtime/scheduled-task-runner.js"))._resetScheduledTaskRuntimeForTests();
      const sessions = await import("../agent/session.js");
      for (const session of sessions.getAllSessions()) sessions.endSession(session.id);
    } catch {
      // module instances of a test that failed early
    }
    vi.doUnmock("../agent/runtime.js");
  });

  it("an operator's job runs as operator", async () => {
    const mods = await worker([OTTO.record]);

    const done = await runOne(mods, { ...owner, requestedByRole: "operator" });

    expect(done.status).toBe("completed");
    expect(sessionRoles).toEqual(["operator"]);
  });

  it("an owner demoted while the job waited runs with the new role", async () => {
    const mods = await worker([testAccount("otto", "viewer").record]);

    const done = await runOne(mods, { ...owner, requestedByRole: "operator" });

    expect(done.status).toBe("completed");
    expect(sessionRoles).toEqual(["viewer"]);
  });

  it("an owner deleted while the job waited fails the job, which never runs", async () => {
    const mods = await worker([VERA.record]);

    const done = await runOne(mods, { ...owner, requestedByRole: "operator" });

    expect(done.status).toBe("failed");
    expect(done.error).toBe(mods.scene.OWNER_SIGNED_OUT_JOB_REFUSAL);
    expect(sessionRoles).toEqual([]);
  });

  it("a job nobody signed in to queue (cron, webhook key, channel) runs with no role, as before", async () => {
    const mods = await worker([OTTO.record]);

    const done = await runOne(mods, { userId: "job:nightly", principal: "synthetic" });

    expect(done.status).toBe("completed");
    expect(sessionRoles).toEqual([undefined]);
  });

  it("a job with no role runs with none when work that carries one woke the worker", async () => {
    // createJob wakes the worker inside its caller's async context, and the pump claims the oldest
    // job, whoever queued it. An admin's tool call that queues (or a timer it armed) handed its role
    // to a job with none: a webhook-key run, a viewer's schedule.
    const mods = await worker([OTTO.record, ADA.record]);
    const { runWithRequestContext } = await import("../runtime/request-context.js");
    await mods.scene.startSceneJobWorker();

    const job = await runWithRequestContext(
      { identity: { userId: "ada", account: ADA.id }, sessionId: "chat-ada", agentName: "main", callerRole: "admin" },
      () => mods.jobs.createJob({ sceneName: "hook", task: "Summarise the day.", turnTimeoutMs: 30_000, userId: "scene:hook", principal: "synthetic" }),
    );
    const done = await settled(mods, job.id);

    expect(done.status).toBe("completed");
    expect(sessionRoles).toEqual([undefined]);
    expect(contextRoles).toEqual([undefined]);
  });

  it("a resumed job does not keep the role its first attempt's session was restored with", async () => {
    // After a restart the Postgres store queues the same row again, with the same session id, and the
    // session store restores that session as the first attempt left it: with the role it ran with.
    const mods = await worker([testAccount("otto", "viewer").record]);
    const sessions = await import("../agent/session.js");
    const job = await mods.jobs.createJob({ sceneName: "nightly", task: "Summarise the day.", turnTimeoutMs: 30_000, ...owner, requestedByRole: "operator" });
    sessions.createSession({ sessionId: job.sessionId, channel: "scene", ...owner, userRole: "operator" });

    expect(await mods.scene.runSceneJobWorkerTick()).toBe(true);
    const done = await settled(mods, job.id);

    expect(done.status).toBe("completed");
    expect(sessionRoles).toEqual(["viewer"]);
  });

  it("each run of a schedule a person made runs with the owner's role as it stands then", async () => {
    // otto made it as an operator and has been demoted since. Without the role on the record, the
    // run had none, which knowledge-base management reads as no gating.
    const mods = await worker([testAccount("otto", "viewer").record]);
    const runner = await import("../runtime/scheduled-task-runner.js");
    await mods.scene.startSceneJobWorker();

    runner.addAndActivateScheduledTask({
      id: "sched_role1",
      at: new Date().toISOString(),
      label: "Day summary",
      task: "Summarise the day.",
      ...owner,
      requestedByRole: "operator",
      createdAt: new Date().toISOString(),
    });
    const deadline = Date.now() + 10_000;
    while (sessionRoles.length === 0) {
      if (Date.now() > deadline) throw new Error("the schedule's run did not start");
      await new Promise((done) => setTimeout(done, 20));
    }

    expect(sessionRoles).toEqual(["viewer"]);
  });
});

describe("a schedule keeps the role of the person who made it, and none of the call that made it", () => {
  afterEach(async () => {
    try {
      (await import("../runtime/scheduled-task-runner.js"))._resetScheduledTaskRuntimeForTests();
      await (await import("../agent/jobs.js")).resetJobsForTests();
    } catch {
      // module instances of a test that failed early
    }
  });

  it("schedule_task stores the role of the call that made it; one nobody signed in to makes none", async () => {
    const dir = deployment({ auth: { enabled: true, provider: "builtin", users: [OTTO.record] } });
    await import("../tools/schedule.js");
    const [{ executeTool }, { getScheduledTask }] = await Promise.all([import("../tools/registry.js"), import("../runtime/scheduled-tasks.js")]);
    const approvalCallback = async () => true;
    const schedule = { kind: "once", inMinutes: 30, label: "Day summary", task: "Summarise the day." };

    const signedIn = await executeTool("schedule_task", schedule, {
      sessionId: "chat-otto", workspacePath: dir, userId: "otto", identity: { userId: "otto", account: OTTO.id }, userRole: "operator", approvalCallback,
    });
    const nobody = await executeTool("schedule_task", schedule, { sessionId: "telegram-1", workspacePath: dir, approvalCallback });

    expect(signedIn.success, signedIn.error).toBe(true);
    expect(nobody.success, nobody.error).toBe(true);
    const stored = (result: typeof signedIn) => getScheduledTask(String(result.metadata?.["scheduleId"]));
    expect(stored(signedIn)).toMatchObject({ userId: "otto", account: OTTO.id, requestedByRole: "operator" });
    expect(stored(nobody)).toBeDefined();
    expect(stored(nobody)).not.toHaveProperty("requestedByRole");
  });

  it("a schedule's timer fires outside the call that made it", async () => {
    // A timer keeps the async context it was created in. Armed inside schedule_task's call, every run
    // was queued inside that call's context (its turn's role, its session), long after it returned.
    deployment();
    const [runner, jobs, { currentRequestContext, runWithRequestContext }] = await Promise.all([
      import("../runtime/scheduled-task-runner.js"),
      import("../agent/jobs.js"),
      import("../runtime/request-context.js"),
    ]);
    const queuedIn: Array<{ callerRole?: string; sessionId?: string } | undefined> = [];
    const unsubscribe = jobs.onJobQueued(() => queuedIn.push({ ...currentRequestContext() }));
    try {
      runWithRequestContext({ identity: { userId: "ada" }, sessionId: "chat-ada", agentName: "main", callerRole: "admin" }, () =>
        runner.addAndActivateScheduledTask({ id: "sched_ctx1", at: new Date().toISOString(), label: "Check", task: "Check the harbour.", createdAt: new Date().toISOString() }));
      const deadline = Date.now() + 10_000;
      while (queuedIn.length === 0) {
        if (Date.now() > deadline) throw new Error("the schedule's run was not queued");
        await new Promise((done) => setTimeout(done, 20));
      }
    } finally {
      unsubscribe();
    }

    expect(queuedIn).toEqual([{}]);
  });
});

describe("an extension refuses a tool call before anyone is asked to approve it", () => {
  /** Loads one extension through the real loader: its tools and its authorizer. */
  async function loadExtension(manifest: Record<string, unknown>): Promise<void> {
    const extDir = mkdtempSync(join(tmpdir(), "sai-caller-role-ext-"));
    dirs.push(extDir);
    mkdirSync(join(extDir, String(manifest["name"])), { recursive: true });
    writeFileSync(join(extDir, String(manifest["name"]), "index.mjs"), "// discovery marker\n");
    process.env["SAI_EXTENSIONS_DIR"] = extDir;
    const loader = await import("../extension/loader.js");
    loader.setExtensionImporterForTests(async () => ({ default: manifest }));
    try {
      const { loaded, failed } = await loader.loadCoreExtensions();
      expect({ loaded, failed }).toEqual({ loaded: 1, failed: 0 });
    } finally {
      loader.setExtensionImporterForTests(null);
    }
  }

  let executed: string[] = [];
  /** A tool every call of which needs approval, so a refusal that came after the card would show. */
  async function deskTool() {
    const { ToolTier } = await import("../guardrails/tool-tiers.js");
    return {
      name: "desk_release",
      description: "Releases a record.",
      tier: ToolTier.ONE_WRITE,
      requiresPerCallApproval: true,
      parameters: { type: "object", properties: { record: { type: "string" } } },
      execute: async (args: Record<string, unknown>) => {
        executed.push(String(args["record"]));
        return { success: true, output: "released" };
      },
    };
  }

  beforeEach(() => {
    executed = [];
  });

  it("refuses a viewer's call without an approval card, and audits it without the arguments", async () => {
    const dir = deployment();
    await loadExtension({
      name: "deskguard",
      version: "1.0.0",
      tools: [await deskTool()],
      authorizeToolCall: ({ name, ctx }: { name: string; ctx: ToolContext }) =>
        name === "desk_release" && ctx.userRole === "viewer" ? "Releasing a record takes the operator role." : undefined,
    });
    const { executeTool } = await import("../tools/registry.js");
    const approvalCallback = vi.fn(async () => true);

    const refused = await executeTool("desk_release", { record: "R-17" }, { sessionId: "chat-1", workspacePath: dir, userRole: "viewer", approvalCallback });

    expect(refused).toEqual({ success: false, output: "", error: "Releasing a record takes the operator role." });
    expect(approvalCallback).not.toHaveBeenCalled();
    expect(executed).toEqual([]);
    const rows = auditSpy.mock.calls.filter(([type]) => type === "tool_call_refused");
    expect(rows).toHaveLength(1);
    expect(rows[0]![1]).toEqual({ tool: "desk_release", role: "viewer", source: "deskguard" });
    expect(JSON.stringify(rows[0])).not.toContain("R-17");

    // An operator's call goes on to the approval card and runs.
    const allowed = await executeTool("desk_release", { record: "R-18" }, { sessionId: "chat-1", workspacePath: dir, userRole: "operator", approvalCallback });
    expect(allowed.success, allowed.error).toBe(true);
    expect(approvalCallback).toHaveBeenCalledTimes(1);
    expect(executed).toEqual(["R-18"]);
  });

  it("judges a call whose ToolContext names no role by the role its work carries", async () => {
    // A context built without a role (a caller's own executeTool, say) inside a viewer's turn: the
    // authorizer is asked with the viewer's role, not with none.
    const dir = deployment();
    await loadExtension({
      name: "deskguard",
      version: "1.0.0",
      tools: [await deskTool()],
      authorizeToolCall: ({ name, ctx }: { name: string; ctx: ToolContext }) =>
        name === "desk_release" && ctx.userRole === "viewer" ? "Releasing a record takes the operator role." : undefined,
    });
    const { executeTool } = await import("../tools/registry.js");
    const approvalCallback = vi.fn(async () => true);

    const refused = await inTurn("viewer", () => executeTool("desk_release", { record: "R-22" }, { sessionId: "chat-1", workspacePath: dir, approvalCallback }));

    expect(refused).toEqual({ success: false, output: "", error: "Releasing a record takes the operator role." });
    expect(approvalCallback).not.toHaveBeenCalled();
    expect(executed).toEqual([]);
    expect(auditSpy.mock.calls.filter(([type]) => type === "tool_call_refused").map(([, data]) => data))
      .toEqual([{ tool: "desk_release", role: "viewer", source: "deskguard" }]);
  });

  it("asks the authorizers in load order, and the first refusal wins", async () => {
    const dir = deployment();
    const asked: string[] = [];
    await loadExtension({
      name: "firstguard",
      version: "1.0.0",
      tools: [await deskTool()],
      authorizeToolCall: ({ args }: { args: Record<string, unknown> }) => {
        asked.push("firstguard");
        return args["record"] === "R-1" ? "firstguard holds R-1." : undefined;
      },
    });
    await loadExtension({
      name: "secondguard",
      version: "1.0.0",
      authorizeToolCall: ({ args }: { args: Record<string, unknown> }) => {
        asked.push("secondguard");
        return String(args["record"]).startsWith("R-") ? "secondguard holds every record." : undefined;
      },
    });
    const { executeTool } = await import("../tools/registry.js");
    const approvalCallback = vi.fn(async () => true);
    const ctx: ToolContext = { sessionId: "chat-1", workspacePath: dir, userRole: "operator", approvalCallback };

    // Both would refuse R-1: the one loaded first answers, and the other is not asked.
    expect((await executeTool("desk_release", { record: "R-1" }, ctx)).error).toBe("firstguard holds R-1.");
    expect(asked).toEqual(["firstguard"]);

    // The first lets R-2 through, so the second decides.
    asked.length = 0;
    expect((await executeTool("desk_release", { record: "R-2" }, ctx)).error).toBe("secondguard holds every record.");
    expect(asked).toEqual(["firstguard", "secondguard"]);

    // Both let D-3 through: the call goes on to the approval card and runs.
    asked.length = 0;
    const allowed = await executeTool("desk_release", { record: "D-3" }, ctx);
    expect(allowed.success, allowed.error).toBe(true);
    expect(asked).toEqual(["firstguard", "secondguard"]);
    expect(approvalCallback).toHaveBeenCalledTimes(1);
    expect(executed).toEqual(["D-3"]);
    expect(auditSpy.mock.calls.filter(([type]) => type === "tool_call_refused").map(([, data]) => (data as { source: string }).source))
      .toEqual(["firstguard", "secondguard"]);
  });

  it("sees the role inside a delegated run, where the role comes from the context", async () => {
    const dir = deployment();
    await registerProbe();
    await loadExtension({
      name: "probeguard",
      version: "1.0.0",
      authorizeToolCall: ({ name, ctx }: { name: string; ctx: ToolContext }) =>
        name === "role_probe" && ctx.userRole === "viewer" ? "Not for viewers." : undefined,
    });
    const { runSubAgentWithStats } = await import("../agent/sub-agent.js");

    await inTurn("viewer", () => runSubAgentWithStats({ agentName: "painter", task: "Paint the harbour at dusk.", parentSessionId: "chat-1", workspacePath: dir }));
    await inTurn("operator", () => runSubAgentWithStats({ agentName: "painter", task: "Paint the harbour at dusk.", parentSessionId: "chat-1", workspacePath: dir }));

    // The viewer's probe was refused before it ran; the operator's ran.
    expect(probeRoles).toEqual(["operator"]);
    expect(auditSpy.mock.calls.filter(([type]) => type === "tool_call_refused").map(([, data]) => data))
      .toEqual([{ tool: "role_probe", role: "viewer", source: "probeguard" }]);
  }, 30_000);

  it("an authorizer that throws refuses the call", async () => {
    const dir = deployment();
    await loadExtension({
      name: "brokenguard",
      version: "1.0.0",
      tools: [await deskTool()],
      authorizeToolCall: () => { throw new Error("store unreachable"); },
    });
    const { executeTool } = await import("../tools/registry.js");
    const approvalCallback = vi.fn(async () => true);

    const result = await executeTool("desk_release", { record: "R-19" }, { sessionId: "chat-1", workspacePath: dir, userRole: "admin", approvalCallback });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/authorization check failed/);
    expect(approvalCallback).not.toHaveBeenCalled();
    expect(executed).toEqual([]);
  });

  it("with no authorizer, nothing changes: the call goes to the approval card", async () => {
    const dir = deployment();
    await loadExtension({ name: "deskonly", version: "1.0.0", tools: [await deskTool()] });
    const { executeTool } = await import("../tools/registry.js");
    const approvalCallback = vi.fn(async () => true);

    const result = await executeTool("desk_release", { record: "R-20" }, { sessionId: "chat-1", workspacePath: dir, userRole: "viewer", approvalCallback });

    expect(result.success, result.error).toBe(true);
    expect(approvalCallback).toHaveBeenCalledTimes(1);
    expect(executed).toEqual(["R-20"]);
    expect(auditSpy.mock.calls.filter(([type]) => type === "tool_call_refused")).toEqual([]);
  });

  it("an extension tool's own refuse runs before the approval card", async () => {
    const dir = deployment();
    const tool = await deskTool();
    await loadExtension({
      name: "deskcheck",
      version: "1.0.0",
      tools: [{ ...tool, refuse: (args: Record<string, unknown>) => (String(args["record"] ?? "").startsWith("R-") ? undefined : "Name the record as R-<number>.") }],
    });
    const { executeTool } = await import("../tools/registry.js");
    const approvalCallback = vi.fn(async () => true);

    const refused = await executeTool("desk_release", { record: "17" }, { sessionId: "chat-1", workspacePath: dir, approvalCallback });

    expect(refused).toEqual({ success: false, output: "", error: "Name the record as R-<number>." });
    expect(approvalCallback).not.toHaveBeenCalled();
    expect(executed).toEqual([]);
  });

  it("an extension tool's effect reaches the effect policy", async () => {
    // An irreversible external mutation needs approval under effectContracts "enforce" even at a
    // tier that asks for none; dropped by the loader, the tool ran unasked.
    const dir = deployment({ guardrails: { effectContracts: "enforce" } });
    const tool = await deskTool();
    await loadExtension({
      name: "deskmail",
      version: "1.0.0",
      tools: [{ ...tool, requiresPerCallApproval: false, effect: { domain: "messaging", reversibility: "irreversible" } }],
    });
    const { executeTool } = await import("../tools/registry.js");
    const approvalCallback = vi.fn(async () => false);

    const result = await executeTool("desk_release", { record: "R-21" }, { sessionId: "chat-1", workspacePath: dir, approvalCallback });

    expect(approvalCallback).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(executed).toEqual([]);
  });

  it("an extension that fails to load leaves no authorizer behind", async () => {
    // Its tool shadows a built-in, so the loader skips it after the manifest check; an authorizer
    // registered before its tools kept refusing every call of a deployment told it was not loaded.
    const dir = deployment();
    await registerProbe();
    const { ToolTier } = await import("../guardrails/tool-tiers.js");
    const extDir = mkdtempSync(join(tmpdir(), "sai-caller-role-ext-"));
    dirs.push(extDir);
    mkdirSync(join(extDir, "shadowguard"), { recursive: true });
    writeFileSync(join(extDir, "shadowguard", "index.mjs"), "// discovery marker\n");
    process.env["SAI_EXTENSIONS_DIR"] = extDir;
    const loader = await import("../extension/loader.js");
    loader.setExtensionImporterForTests(async () => ({
      default: {
        name: "shadowguard",
        version: "1.0.0",
        authorizeToolCall: () => "Refused by shadowguard.",
        tools: [{ name: "read_file", description: "Reads.", tier: ToolTier.ZERO_READ_ONLY, parameters: { type: "object", properties: {} }, execute: async () => ({ success: true, output: "" }) }],
      },
    }));
    try {
      expect(await loader.loadCoreExtensions()).toMatchObject({ loaded: 0, failed: 1 });
    } finally {
      loader.setExtensionImporterForTests(null);
    }
    const { executeTool } = await import("../tools/registry.js");

    const result = await executeTool("role_probe", {}, { sessionId: "chat-1", workspacePath: dir, userRole: "viewer" });

    expect(result.success, result.error).toBe(true);
    expect(probeRoles).toEqual(["viewer"]);
    expect(auditSpy.mock.calls.filter(([type]) => type === "tool_call_refused")).toEqual([]);
  });

  it("an extension whose authorizeToolCall is not a function loads with its role, and refuses every call", async () => {
    // Failing the load dropped the extension's roles, and a role nobody declares signs in as
    // operator: a typo in the hook raised the fork's lowest role to an operator.
    const pat = testAccount("pat", "patient");
    const dir = deployment({ auth: { enabled: true, users: [pat.record] } });
    await registerProbe();
    await loadExtension({
      name: "badguard",
      version: "1.0.0",
      roles: [{ name: "patient", description: "a fork's lowest role", rank: 10 }],
      authorizeToolCall: "operator-only",
    });
    const auth = await import("../gateway/auth.js");
    const user = await auth.authenticatedUserFromToken(await auth.createToken("pat", pat.claims));
    expect(user?.role).toBe("patient");
    expect(auth.userHasRole(user, "operator")).toBe(false);
    const { executeTool } = await import("../tools/registry.js");

    const result = await executeTool("role_probe", {}, { sessionId: "chat-1", workspacePath: dir, userRole: "admin" });

    expect(result).toEqual({ success: false, output: "", error: "Tool 'role_probe' was refused: the badguard extension's authorizeToolCall is not a function." });
    expect(probeRoles).toEqual([]);
    expect(auditSpy.mock.calls.filter(([type]) => type === "tool_call_refused").map(([, data]) => data))
      .toEqual([{ tool: "role_probe", role: "admin", source: "badguard" }]);
  });

  it("a tool whose refuse is not a function is not registered, and the rest of its extension loads", async () => {
    const pat = testAccount("pat", "patient");
    const dir = deployment({ auth: { enabled: true, users: [pat.record] } });
    const tool = await deskTool();
    await loadExtension({
      name: "deskcheck",
      version: "1.0.0",
      roles: [{ name: "patient", description: "a fork's lowest role", rank: 10 }],
      tools: [
        { ...tool, refuse: "Name the record as R-<number>." },
        { ...tool, name: "desk_status", requiresPerCallApproval: false },
      ],
    });
    const auth = await import("../gateway/auth.js");
    expect((await auth.authenticatedUserFromToken(await auth.createToken("pat", pat.claims)))?.role).toBe("patient");
    const { executeTool, getTool } = await import("../tools/registry.js");
    expect(getTool("desk_release")).toBeUndefined();
    expect(getTool("desk_status")).toBeDefined();
    const approvalCallback = vi.fn(async () => true);

    const result = await executeTool("desk_release", { record: "R-17" }, { sessionId: "chat-1", workspacePath: dir, userRole: "operator", approvalCallback });

    expect(result.success).toBe(false);
    expect(approvalCallback).not.toHaveBeenCalled();
    expect(executed).toEqual([]);
  });
});
