import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { PRODUCT } from "../product/index.js";
import { bootstrapClaims, testAccount, testAccountId } from "./support/test-account.js";

/**
 * The role floor for agents that maintain the deployment (workspaceAccess "full").
 *
 * swarm_maintainer and prompt_optimizer work from the SHARED root with write_file and edit_file,
 * which ask for no approval per call, so whoever reached them could rewrite agents/, scenes/ and
 * jobs/ (a lasting change for every account) and read every account's root. They were reachable on
 * every surface: --agent, delegate_to_agent, run_workflow, both A2A routes and MCP agent__. A
 * viewer's token on /a2a/agents/swarm_maintainer ran it, and asked for no approval.
 *
 * Under multi-user auth a caller whose role ranks below agents.fullScopeMinRole (default
 * "operator") is now refused at runSubAgentWithStats, the point every path reaches, before any
 * model call and before anything is written; the gateway refuses `--agent` before the turn starts,
 * and search_agents/list_agents do not offer the agent. An extension's authorizeAgentRun hook is
 * asked first and its refusal wins. Queued work carries no role (`/job`, the scene and job run
 * routes, a scheduled run): its turn answers to the role its account holds when it runs, and runs
 * in a fresh context, so the role of whichever work woke the worker does not reach it. These run
 * against the whole gateway, listening on 127.0.0.1.
 */

/**
 * Every model call: the agent that made it and the caller role on its request context. A turn whose
 * message names `delegateMarker` (the queued scenes' task) delegates to swarm_maintainer, as an
 * orchestrator does with a step whose task names its agent.
 */
const model = vi.hoisted(() => ({
  calls: [] as Array<{ agentName?: string; callerRole?: string }>,
  delegateMarker: "Have swarm_maintainer shorten",
}));

vi.mock("../providers/lmstudio.js", async (importActual) => {
  const actual = await importActual<typeof import("../providers/lmstudio.js")>();
  const { currentRequestContext } = await import("../runtime/request-context.js");
  const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
  /** swarm_maintainer writes a note into the root it works in, then answers; any other caller answers. */
  const answer = async (messages: Array<{ role: string }>) => {
    const context = currentRequestContext();
    model.calls.push({ agentName: context?.agentName, callerRole: context?.callerRole });
    if (context?.agentName === "swarm_maintainer" && !messages.some((message) => message.role === "tool")) {
      return {
        content: "",
        tool_calls: [{ id: `call_${model.calls.length}`, name: "write_file", arguments: { path: "notes/maintenance.md", content: "Prompts tuned." } }],
        usage,
        finishReason: "tool_calls",
      };
    }
    return { content: "Maintenance done: the researcher's prompt is shorter now.", tool_calls: [], usage, finishReason: "stop" };
  };
  return {
    ...actual,
    LMStudioProvider: class {
      async checkHealth() { return { healthy: true }; }
      isHealthy() { return true; }
      async verifyToolCallSupport() { return true; }
      async complete(messages: Array<{ role: string }>) { return answer(messages); }
      async completeViaStream(messages: Array<{ role: string }>) { return answer(messages); }
      /** A turn's own calls stream: they answer in prose, or delegate a queued scene's task once. */
      async *stream(messages: Array<{ role: string; content?: unknown }>) {
        const context = currentRequestContext();
        model.calls.push({ agentName: context?.agentName, callerRole: context?.callerRole });
        const text = (content: unknown) => (typeof content === "string" ? content : JSON.stringify(content ?? ""));
        const delegate = messages.some((message) => message.role === "user" && text(message.content).includes(model.delegateMarker))
          && !messages.some((message) => message.role === "tool");
        if (delegate) {
          const toolCallId = `turn_call_${model.calls.length}`;
          yield { type: "tool_call_start", toolCallId, toolName: "delegate_to_agent" };
          yield { type: "tool_call_delta", toolCallId, argumentsDelta: JSON.stringify({ agentName: "swarm_maintainer", task: "Shorten the researcher's system prompt." }) };
          yield { type: "done", finishReason: "tool_calls", usage };
          return;
        }
        yield { type: "text_delta", content: "I will hand this to the maintainer." };
        yield { type: "done", finishReason: "stop", usage };
      }
      async embed() { return []; }
    },
  };
});

// The rate limiter asks Redis on every turn and tool call, and with none on this machine each ask
// waits out ioredis's growing reconnect backoff: the queued-work tests run enough turns to make that
// seconds per call. Rate limiting is not under test here.
vi.mock("../guardrails/rate-limiter.js", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 1_000, resetAt: new Date(Date.now() + 60_000) })),
}));

/** chat.send's turn, held when `held` is set: the turns that started, by the agent they direct to. */
const turns = vi.hoisted(() => ({ held: false, directed: [] as Array<string | undefined> }));
vi.mock("../agent/runtime.js", async (importActual) => {
  const actual = await importActual<typeof import("../agent/runtime.js")>();
  return {
    ...actual,
    runTurn: (opts: Parameters<typeof actual.runTurn>[0]) => {
      if (!turns.held) return actual.runTurn(opts);
      turns.directed.push(opts.directiveAgent);
      return new Promise(() => {});
    },
  };
});

const root = mkdtempSync(join(tmpdir(), "sai-full-scope-floor-"));
const workspace = join(root, "workspace");
const configFile = join(root, "config", "10-test.json");
/** The identity-provider account registry of the test workspace (runtime/account-registry.ts). */
const registryFile = join(workspace, PRODUCT.stateDirName, "accounts.json");
const extensionsDir = join(root, "extensions");
const ENV_KEYS = ["SAI_CONFIG_PATH", "SAI_MASTER_KEY", "SAI_CRED_STORE", "SAI_JOB_WAKE_DISABLED", "SAI_EXTENSIONS_DIR"];
const users = {
  root: testAccount("root", "admin"),
  alice: testAccount("alice", "operator"),
  vic: testAccount("vic", "viewer"),
};
type UserName = keyof typeof users;
const TASK = "Shorten the researcher's system prompt.";
/** A queued scene's task: the step's orchestrator turn delegates it to swarm_maintainer. */
const QUEUED_TASK = `${model.delegateMarker} the researcher's system prompt.`;

function writeConfig(opts: { floor?: "viewer" | "operator" | "admin"; auth?: boolean; provider?: "oidc" } = {}): void {
  writeFileSync(configFile, JSON.stringify({
    workspacePath: workspace,
    gateway: { port: 39_000 + Math.floor(Math.random() * 2_000), jwtSecret: "j".repeat(40) },
    ...(opts.auth === false ? {} : {
      auth: { enabled: true, ...(opts.provider ? { provider: opts.provider } : {}), users: Object.values(users).map((user) => user.record) },
    }),
    agents: { defaultContainerized: false, ...(opts.floor ? { fullScopeMinRole: opts.floor } : {}) },
    a2a: { enabled: true },
    mcp: { expose: { enabled: true, http: { enabled: true, requireAuth: true } } },
    subAgents: {
      swarm_maintainer: {
        description: "Maintains the swarm itself: edits agent definitions, scenes and jobs.",
        systemPrompt: "Maintain the swarm's agents, scenes and jobs.",
        capabilities: ["swarm maintenance", "agent definitions"],
        tools: ["write_file"],
        maxIterations: 3,
        workspaceAccess: "full",
      },
      note_taker: {
        description: "Writes meeting notes and agent definitions summaries.",
        systemPrompt: "Write notes.",
        capabilities: ["meeting notes", "agent definitions"],
        tools: ["write_file"],
        maxIterations: 3,
      },
    },
    scenes: {
      tune_swarm: { description: "Tune the swarm's prompts.", task: TASK, allowedAgents: ["swarm_maintainer"] },
      // Queued, its step runs as an orchestrator turn that delegates to swarm_maintainer, as the
      // shipped co_develop_capability's capture step does.
      tune_swarm_queued: { description: "Tune the swarm's prompts in the background.", task: QUEUED_TASK, allowedAgents: ["swarm_maintainer"] },
      // Two agents: run_workflow runs it as a nested turn on a workflow session, not as one agent's run.
      tune_swarm_turn: { description: "Tune the swarm's prompts and note it.", task: QUEUED_TASK, allowedAgents: ["swarm_maintainer", "note_taker"] },
    },
    jobs: {
      tune_job: { description: "Tune the swarm.", steps: [{ scene: "tune_swarm_queued", label: "Tune" }] },
    },
  }), "utf8");
  mods.config.resetConfigForTests();
}

type Mods = {
  config: typeof import("../config/loader.js");
  auth: typeof import("../gateway/auth.js");
  subAgent: typeof import("../agent/sub-agent.js");
  registry: typeof import("../tools/registry.js");
  context: typeof import("../runtime/request-context.js");
  audit: typeof import("../audit/logger.js");
  rpc: typeof import("../gateway/rpc.js");
  extensions: typeof import("../extension/index.js");
  loader: typeof import("../extension/loader.js");
  jobs: typeof import("../agent/jobs.js");
  worker: typeof import("../agent/scene-worker.js");
  schedules: typeof import("../runtime/scheduled-tasks.js");
  scheduleRunner: typeof import("../runtime/scheduled-task-runner.js");
};
let mods: Mods;
let baseUrl = "";
let stopGateway: () => Promise<void> = async () => {};
let unsubscribeAudit: () => void = () => {};
const refusals: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  mkdirSync(join(root, "config"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  process.env["SAI_CONFIG_PATH"] = join(root, "config");
  process.env["SAI_MASTER_KEY"] = "m".repeat(32);
  process.env["SAI_CRED_STORE"] = join(root, PRODUCT.stateDirName, "credentials.enc");
  process.env["SAI_JOB_WAKE_DISABLED"] = "1";
  // Sequential imports: these modules import each other.
  const config = await import("../config/loader.js");
  const auth = await import("../gateway/auth.js");
  const { createGateway } = await import("../gateway/index.js");
  const subAgent = await import("../agent/sub-agent.js");
  const registry = await import("../tools/registry.js");
  const context = await import("../runtime/request-context.js");
  const audit = await import("../audit/logger.js");
  const rpc = await import("../gateway/rpc.js");
  const extensions = await import("../extension/index.js");
  const loader = await import("../extension/loader.js");
  const jobs = await import("../agent/jobs.js");
  const worker = await import("../agent/scene-worker.js");
  const schedules = await import("../runtime/scheduled-tasks.js");
  const scheduleRunner = await import("../runtime/scheduled-task-runner.js");
  mods = { config, auth, subAgent, registry, context, audit, rpc, extensions, loader, jobs, worker, schedules, scheduleRunner };
  // Out of the workspace, whose snapshot the tests compare.
  schedules._setScheduledTasksPathForTests(join(root, "scheduled-tasks.json"));
  writeConfig();
  unsubscribeAudit = audit.subscribeToAudit((event) => {
    if (event.type === "agent_run_refused") refusals.push(event.data);
  });

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
  baseUrl = `http://127.0.0.1:${(server?.address() as AddressInfo).port}`;
  stopGateway = () => gateway.stop();
}, 60_000);

afterEach(() => {
  model.calls.length = 0;
  refusals.length = 0;
  turns.held = false;
  turns.directed.length = 0;
  rmSync(join(workspace, "notes"), { recursive: true, force: true });
});

afterAll(async () => {
  unsubscribeAudit();
  mods.schedules._setScheduledTasksPathForTests(null);
  for (const client of mcpClients.splice(0)) await client.close().catch(() => undefined);
  await (await import("../mcp/server-http.js")).shutdownMcpHttpSessions();
  await stopGateway();
  await mods.audit.flushAuditLog();
  mods.config.resetConfigForTests();
  mods.auth.resetAuthStateForTests();
  for (const key of ENV_KEYS) delete process.env[key];
  rmSync(root, { recursive: true, force: true });
});

/** Every file under `dir` with a hash of its content. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (at: string): void => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else files[relative(dir, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  if (existsSync(dir)) walk(dir);
  return files;
}

const maintainerCalls = () => model.calls.filter((call) => call.agentName === "swarm_maintainer");
const wroteNote = () => existsSync(join(workspace, "notes", "maintenance.md"));

/** A bootstrap token's caller (`sai token`): an instance credential with a role, and no account. */
type BootstrapCaller = { bootstrap: "operator" | "admin" };
type Caller = UserName | BootstrapCaller;

async function tokenFor(caller: Caller): Promise<string> {
  return typeof caller === "string"
    ? mods.auth.createToken(caller, users[caller].claims)
    : mods.auth.createToken(`ops-${caller.bootstrap}`, bootstrapClaims(caller.bootstrap));
}

/** swarm_maintainer run directly, for a caller with `role` (none: a caller with no known role). */
async function runMaintainer(role?: string) {
  return mods.subAgent.runSubAgentWithStats({
    agentName: "swarm_maintainer",
    task: TASK,
    parentSessionId: "floor-test",
    workspacePath: workspace,
    ...(role ? { userRole: role } : {}),
  });
}

/** Load `manifest` as a core extension through the loader, as a fork's extension is loaded. */
async function loadExtension(manifest: Record<string, unknown>): Promise<{ loaded: number; failed: number }> {
  const name = String(manifest["name"]);
  mkdirSync(join(extensionsDir, name), { recursive: true });
  writeFileSync(join(extensionsDir, name, "index.js"), "// discovered; the test importer supplies the manifest\n", "utf8");
  process.env["SAI_EXTENSIONS_DIR"] = extensionsDir;
  mods.loader.setExtensionImporterForTests(async () => ({ default: manifest }));
  try {
    return await mods.loader.loadCoreExtensions();
  } finally {
    mods.loader.setExtensionImporterForTests(null);
    delete process.env["SAI_EXTENSIONS_DIR"];
    rmSync(join(extensionsDir, name), { recursive: true, force: true });
  }
}

function unloadExtensions(): void {
  mods.loader._resetExtensionLoaderForTests();
  mods.extensions._resetExtensionsForTests();
}

/**
 * Runs `body` with session.create and chat.send open to viewers, as a fork's extension opens them
 * (rpcPolicies). The socket refuses a viewer both by default (gateway/rpc-policy.ts), and these
 * tests need a viewer's own /job to reach the role floor at the run.
 */
async function withChatOpenToViewers(body: () => Promise<void>): Promise<void> {
  expect(await loadExtension({
    name: "viewer-chat",
    version: "1.0.0",
    rpcPolicies: [{ method: "session.create", roles: ["viewer"] }, { method: "chat.send", roles: ["viewer"] }],
  })).toMatchObject({ loaded: 1, failed: 0 });
  try {
    await body();
  } finally {
    unloadExtensions();
    (await import("../gateway/rpc-policy.js"))._resetRpcPoliciesForTests();
  }
}

/** What search_agents or list_agents offers a caller with `role`, for a query both agents match. */
async function offered(tool: "search_agents" | "list_agents", role: string): Promise<string> {
  const result = await mods.registry.executeTool(tool, { query: "edit the swarm's agent definitions", minConfidence: "low" }, {
    sessionId: `floor-routing-${role}`,
    workspacePath: workspace,
    userRole: role,
  });
  return result.output;
}

let chatTurns = 0;
/** chat.send `<task> --agent swarm_maintainer` from a WS connection of `user` (see sendChat). */
async function sendDirected(user: UserName, sessionId?: string): Promise<Array<Record<string, unknown>>> {
  return sendChat(user, `${TASK} --agent swarm_maintainer`, sessionId);
}

/**
 * chat.send `message` from a WS connection of `user`, opened as the handshake opens it under
 * multi-user auth, on `sessionId` or on a session the connection creates. Returns the status events
 * the connection was sent.
 */
async function sendChat(user: UserName, message: string, sessionId?: string): Promise<Array<Record<string, unknown>>> {
  const sent: Array<Record<string, unknown>> = [];
  const role = users[user].record["role"] as string;
  const connection = new mods.rpc.RpcConnection(
    { readyState: 1, send(data: string) { sent.push(JSON.parse(String(data)) as Record<string, unknown>); }, close() {} } as never,
    user,
    role,
    { username: user, role, account: users[user].id },
  );
  let target = sessionId;
  if (!target) {
    await connection.handleMessage(JSON.stringify({ id: "create", method: "session.create", params: {} }));
    target = (sent.find((event) => event["id"] === "create") as { payload: { sessionId: string } }).payload.sessionId;
  }
  await connection.handleMessage(JSON.stringify({
    id: "send", method: "chat.send",
    params: { sessionId: target, requestId: `turn-${user}-${++chatTurns}`, message },
  }));
  return sent.filter((event) => event["type"] === "status").map((event) => event["data"] as Record<string, unknown>);
}

const identityOf = (user: UserName) => ({ userId: user, account: users[user].id });

/** Removes the account registry a test wrote (or a bootstrap token's sign-in recorded), and its cache. */
async function forgetAccountRegistry(): Promise<void> {
  rmSync(registryFile, { force: true });
  (await import("../runtime/account-registry.js")).resetAccountRegistryForTests();
}

/** The ids of the jobs waiting in the queue, once at least one is there (a schedule queues its run from a timer). */
async function queuedJobIds(): Promise<string[]> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const queued = await mods.jobs.listJobs({ status: "queued" });
    if (queued.length > 0) return queued.map((job) => job.id);
    if (Date.now() > deadline) throw new Error("No job was queued");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Runs the queued jobs to their end, as the scene worker does: claimed by a pump that runs inside
 * `wakingWork` when it is given, as a wake from that work's createJob or a schedule armed in it runs.
 */
async function runQueuedJobs(wakingWork?: Parameters<typeof mods.context.runWithRequestContext>[0]) {
  const ids = await queuedJobIds();
  const tick = () => mods.worker.runSceneJobWorkerTick();
  await (wakingWork ? mods.context.runWithRequestContext(wakingWork, tick) : tick());
  const deadline = Date.now() + 30_000;
  for (;;) {
    const jobs = await Promise.all(ids.map((id) => mods.jobs.getJob(id)));
    if (jobs.every((job) => job && ["completed", "failed", "cancelled"].includes(job.status))) return jobs;
    if (Date.now() > deadline) throw new Error(`Jobs did not finish: ${jobs.map((job) => job?.status).join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("runSubAgentWithStats: the role floor for a full-scope agent", () => {
  it("with the floor at admin, refuses an operator before any model call and writes nothing; an admin runs", async () => {
    writeConfig({ floor: "admin" });
    const before = snapshot(workspace);

    const refused = await runMaintainer("operator");

    expect(refused.output).toBe("Agent swarm_maintainer maintains the deployment and needs role admin");
    expect(refused.stats).toMatchObject({ outcome: "failure", terminalState: "refused", iterations: 0, toolCount: 0 });
    expect(maintainerCalls()).toHaveLength(0);
    expect(snapshot(workspace)).toEqual(before);
    expect(refusals).toEqual([expect.objectContaining({ agent: "swarm_maintainer", role: "operator", deniedBy: "role_floor" })]);

    const ran = await runMaintainer("admin");
    expect(ran.stats.terminalState).toBe("completed");
    expect(maintainerCalls().length).toBeGreaterThan(0);
    // What the refused run would have done: write into the shared root.
    expect(wroteNote()).toBe(true);
  });

  it("with the default floor, refuses a viewer and runs for an operator", async () => {
    writeConfig();

    const refused = await runMaintainer("viewer");
    expect(refused.output).toBe("Agent swarm_maintainer maintains the deployment and needs role operator");
    expect(maintainerCalls()).toHaveLength(0);
    expect(wroteNote()).toBe(false);

    const ran = await runMaintainer("operator");
    expect(ran.stats.terminalState).toBe("completed");
    expect(wroteNote()).toBe(true);
  });

  it("leaves a caller with no known role, a deployment with auth off and an agent without full scope as they were", async () => {
    writeConfig({ floor: "admin" });
    expect((await runMaintainer()).stats.terminalState).toBe("completed");

    const viewerRun = await mods.subAgent.runSubAgentWithStats({
      agentName: "note_taker", task: "Write the notes.", parentSessionId: "floor-test", workspacePath: workspace, userRole: "viewer",
    });
    expect(viewerRun.stats.terminalState).toBe("completed");

    writeConfig({ floor: "admin", auth: false });
    expect((await runMaintainer("viewer")).stats.terminalState).toBe("completed");
    expect(refusals).toHaveLength(0);
  });

  it("takes the role from the request context when its caller passes none, and hands its own role to its work", async () => {
    writeConfig({ floor: "admin" });
    const { runWithRequestContext } = mods.context;

    const nested = await runWithRequestContext({ callerRole: "operator" }, () => runMaintainer());
    expect(nested.stats.terminalState).toBe("refused");
    expect(maintainerCalls()).toHaveLength(0);

    await runMaintainer("admin");
    expect(maintainerCalls().length).toBeGreaterThan(0);
    expect(maintainerCalls().every((call) => call.callerRole === "admin")).toBe(true);
  });
});

describe("authorizeAgentRun: an extension's hook", () => {
  afterEach(unloadExtensions);

  it("refuses a run the floor allows, and its refusal wins", async () => {
    writeConfig();
    const asked: Array<Record<string, unknown>> = [];
    expect(await loadExtension({
      name: "gatekeeper",
      version: "1.0.0",
      authorizeAgentRun: (run: Record<string, unknown>) => {
        asked.push(run);
        return (run["agentConfig"] as { workspaceAccess?: string }).workspaceAccess === "full" ? "Maintenance is paused this week" : undefined;
      },
    })).toMatchObject({ loaded: 1, failed: 0 });

    const refused = await runMaintainer("admin");

    expect(refused.output).toBe("Maintenance is paused this week");
    expect(refused.stats.terminalState).toBe("refused");
    expect(maintainerCalls()).toHaveLength(0);
    expect(asked).toEqual([{ agentName: "swarm_maintainer", agentConfig: { workspaceAccess: "full" }, role: "admin" }]);
    expect(refusals).toEqual([expect.objectContaining({ agent: "swarm_maintainer", role: "admin", deniedBy: "gatekeeper" })]);
    // An agent the hook lets through runs.
    const notes = await mods.subAgent.runSubAgentWithStats({
      agentName: "note_taker", task: "Write the notes.", parentSessionId: "floor-test", workspacePath: workspace, userRole: "viewer",
    });
    expect(notes.stats.terminalState).toBe("completed");
  });

  it("can refuse a caller with no known role, which the floor lets through", async () => {
    writeConfig();
    await loadExtension({
      name: "gatekeeper",
      version: "1.0.0",
      authorizeAgentRun: (run: { role?: string; agentConfig: { workspaceAccess?: string } }) =>
        run.agentConfig.workspaceAccess === "full" && run.role === undefined ? "Only a signed-in staff account may run this" : undefined,
    });

    expect((await runMaintainer()).output).toBe("Only a signed-in staff account may run this");
    expect((await runMaintainer("operator")).stats.terminalState).toBe("completed");
  });

  it("refuses the run when the hook throws, and every run when it is not a function, keeping the extension's roles", async () => {
    writeConfig();
    await loadExtension({ name: "gatekeeper", version: "1.0.0", authorizeAgentRun: () => { throw new Error("roster unreadable"); } });

    const refused = await runMaintainer("admin");
    expect(refused.stats.terminalState).toBe("refused");
    expect(refused.output).toContain("gatekeeper extension could not authorize the run");
    expect(maintainerCalls()).toHaveLength(0);

    // Failing the load dropped the extension's roles, and a role nobody declares signs in as
    // operator: a typo in the hook raised the fork's lowest role. It loads, and refuses every run.
    unloadExtensions();
    expect(await loadExtension({
      name: "brokenhook",
      version: "1.0.0",
      roles: [{ name: "patient", description: "a fork's lowest role", rank: 10 }],
      authorizeAgentRun: "deny",
    })).toMatchObject({ loaded: 1, failed: 0 });
    expect(mods.auth.normalizeRole("patient")).toBe("patient");
    const maintenance = await runMaintainer("admin");
    expect(maintenance.stats.terminalState).toBe("refused");
    expect(maintenance.output).toBe("Agent swarm_maintainer cannot run: the brokenhook extension's authorizeAgentRun is not a function");
    const notes = await mods.subAgent.runSubAgentWithStats({
      agentName: "note_taker", task: "Write the notes.", parentSessionId: "floor-test", workspacePath: workspace, userRole: "admin",
    });
    expect(notes.stats.terminalState).toBe("refused");
    expect(maintainerCalls()).toHaveLength(0);
    expect(refusals).toEqual(expect.arrayContaining([expect.objectContaining({ agent: "swarm_maintainer", role: "admin", deniedBy: "brokenhook" })]));
  });

  it("may answer asynchronously, refuses when its promise rejects, and routing does not offer what it refuses", async () => {
    writeConfig();
    await loadExtension({
      name: "gatekeeper",
      version: "1.0.0",
      authorizeAgentRun: async (run: { agentName: string; role?: string }) =>
        run.agentName === "note_taker" && run.role === "viewer" ? "Notes are kept by staff" : undefined,
    });
    const takeNotes = (role: string) => mods.subAgent.runSubAgentWithStats({
      agentName: "note_taker", task: "Write the notes.", parentSessionId: "floor-test", workspacePath: workspace, userRole: role,
    });

    const refused = await takeNotes("viewer");
    expect(refused.output).toBe("Notes are kept by staff");
    expect(refused.stats.terminalState).toBe("refused");
    expect((await takeNotes("operator")).stats.terminalState).toBe("completed");
    expect(await offered("search_agents", "operator")).toContain("note_taker");
    expect(await offered("search_agents", "viewer")).not.toContain("note_taker");

    unloadExtensions();
    await loadExtension({ name: "gatekeeper", version: "1.0.0", authorizeAgentRun: async () => { throw new Error("roster unreadable"); } });
    expect((await runMaintainer("admin")).output).toContain("gatekeeper extension could not authorize the run");
    expect(maintainerCalls()).toHaveLength(0);
  });

  it("a long refusal comes back from delegate_to_agent as the failure it is, not as a partial result", async () => {
    writeConfig();
    // Longer than the 200 characters past which a failed run's text was kept as a partial answer.
    const reason = "Maintenance agents change the assistant for every account at once: they rewrite agent definitions, "
      + "scenes and jobs in the shared workspace. In this deployment they run only from the administration console, "
      + "after a second administrator has reviewed the change. Ask an administrator to schedule it.";
    expect(reason.length).toBeGreaterThan(200);
    await loadExtension({
      name: "gatekeeper",
      version: "1.0.0",
      authorizeAgentRun: (run: { agentConfig: { workspaceAccess?: string } }) => (run.agentConfig.workspaceAccess === "full" ? reason : undefined),
    });

    const result = await mods.registry.executeTool("delegate_to_agent", { agentName: "swarm_maintainer", task: TASK }, {
      sessionId: "floor-long-refusal",
      workspacePath: workspace,
      userId: "root",
      identity: identityOf("root"),
      userRole: "admin",
      allowedAgents: ["swarm_maintainer"],
    });

    expect(result.success).toBe(false);
    expect(`${result.output}\n${result.error ?? ""}`).toContain(reason);
    expect(result.metadata?.["partialFallback"]).not.toBe(true);
    expect(maintainerCalls()).toHaveLength(0);
    expect(refusals).toEqual([expect.objectContaining({ agent: "swarm_maintainer", role: "admin", deniedBy: "gatekeeper" })]);
  });
});

const mcpClients: Client[] = [];

/** Who `caller` is to a turn's tools: its name, identity and role. */
function callerOf(caller: Caller): { userId: string; identity: { userId: string; account?: string; principal?: "bootstrap" }; role: string } {
  if (typeof caller === "string") return { userId: caller, identity: identityOf(caller), role: users[caller].record["role"] as string };
  const userId = `ops-${caller.bootstrap}`;
  return { userId, identity: { userId, principal: "bootstrap" }, role: caller.bootstrap };
}

/** Each path to swarm_maintainer, for an account or a bootstrap token's caller; returns the text the caller got back. */
const paths: Record<string, (caller: Caller) => Promise<string>> = {
  async delegate_to_agent(caller) {
    // Called as a turn's tool is, with the caller on the tool context and none on the request context.
    const { userId, identity, role } = callerOf(caller);
    const result = await mods.registry.executeTool("delegate_to_agent", { agentName: "swarm_maintainer", task: TASK }, {
      sessionId: `floor-delegate-${userId}`,
      workspacePath: workspace,
      userId,
      identity,
      userRole: role,
      allowedAgents: ["swarm_maintainer"],
    });
    return `${result.output}\n${result.error ?? ""}`;
  },
  async run_workflow(caller) {
    // Inside a turn, as the turn's request context carries its session's role.
    const { userId, identity, role } = callerOf(caller);
    const result = await mods.context.runWithRequestContext({ identity, callerRole: role }, () =>
      mods.registry.executeTool("run_workflow", { name: "tune_swarm" }, {
        sessionId: `floor-workflow-${userId}`,
        workspacePath: workspace,
        userId,
        identity,
        userRole: role,
      }));
    return `${result.output}\n${result.error ?? ""}`;
  },
  async a2a_v1(caller) {
    const response = await fetch(`${baseUrl}/a2a/v1`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${await tokenFor(caller)}` },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tasks/send",
        params: { agentId: "swarm_maintainer", message: { role: "user", parts: [{ type: "text", text: TASK }] } },
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { result: { artifacts: Array<{ parts: Array<{ text: string }> }> } };
    return body.result.artifacts[0]!.parts[0]!.text;
  },
  async a2a_legacy(caller) {
    const response = await fetch(`${baseUrl}/a2a/agents/swarm_maintainer`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${await tokenFor(caller)}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tasks/send", params: { task: TASK } }),
    });
    expect(response.status).toBe(200);
    return (await response.json() as { result: { output: string } }).result.output;
  },
  async mcp_agent(caller) {
    const { Client: McpClient } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const client = new McpClient({ name: "full-scope-floor-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${await tokenFor(caller)}` } },
    }));
    mcpClients.push(client);
    const result = await client.callTool({ name: "agent__swarm_maintainer", arguments: { task: TASK } });
    return (result.content as Array<{ text?: string }>).map((part) => part.text ?? "").join("");
  },
};

describe("every path to a full-scope agent, with the floor at admin", () => {
  for (const [name, reach] of Object.entries(paths)) {
    it(`${name}: refuses an operator, before the agent's first model call and writing nothing, and runs for an admin`, async () => {
      writeConfig({ floor: "admin" });
      const before = snapshot(workspace);

      const refused = await reach("alice");
      expect(refused).toContain("Agent swarm_maintainer maintains the deployment and needs role admin");
      expect(maintainerCalls()).toHaveLength(0);
      expect(snapshot(workspace)).toEqual(before);
      expect(refusals.length).toBeGreaterThan(0);
      expect(refusals.every((refusal) => refusal["role"] === "operator")).toBe(true);

      await reach("root");
      expect(maintainerCalls().length).toBeGreaterThan(0);
      expect(wroteNote()).toBe(true);
    }, 60_000);
  }

  it("--agent: refuses the turn before it starts for an operator, with the same words; an admin's turn starts", async () => {
    writeConfig({ floor: "admin" });
    turns.held = true;

    const refused = await sendDirected("alice");
    expect(refused.map((status) => status["status"])).toEqual(["blocked"]);
    expect(refused[0]!["response"]).toBe("Agent swarm_maintainer maintains the deployment and needs role admin");
    expect(turns.directed).toEqual([]);
    expect(refusals).toEqual([expect.objectContaining({ agent: "swarm_maintainer", role: "operator", deniedBy: "role_floor", via: "directive" })]);

    await sendDirected("root");
    expect(turns.directed).toEqual(["swarm_maintainer"]);
  });

  it("--agent: also asks for the role the session holds, which the run answers to", async () => {
    writeConfig({ floor: "admin" });
    turns.held = true;
    const { createSession } = await import("../agent/session.js");
    // alice's session holds her role; an admin may drive it, and its turns answer to that role.
    const session = createSession({ channel: "webchat", userId: "alice", account: users.alice.id, userRole: "operator" });

    const refused = await sendDirected("root", session.id);

    expect(refused.map((status) => status["status"])).toEqual(["blocked"]);
    expect(refused[0]!["response"]).toBe("Agent swarm_maintainer maintains the deployment and needs role admin");
    expect(turns.directed).toEqual([]);
    expect(refusals).toEqual([expect.objectContaining({ agent: "swarm_maintainer", role: "operator", via: "directive" })]);
  });

  it("--agent: a session that holds no role answers to the role its owner's account holds", async () => {
    writeConfig();
    turns.held = true;
    const { createSession } = await import("../agent/session.js");
    // vic's session, kept from before sessions held a role; an admin may drive it.
    const session = createSession({ channel: "webchat", userId: "vic", account: users.vic.id });

    const refused = await sendDirected("root", session.id);

    expect(refused.map((status) => status["status"])).toEqual(["blocked"]);
    expect(refused[0]!["response"]).toBe("Agent swarm_maintainer maintains the deployment and needs role operator");
    expect(turns.directed).toEqual([]);
    expect(refusals).toEqual([expect.objectContaining({ agent: "swarm_maintainer", role: "viewer", via: "directive" })]);
  });
});

describe("every path, for a caller with no account (a bootstrap token): only the role the path carries can refuse it", () => {
  afterEach(forgetAccountRegistry);

  for (const [name, reach] of Object.entries(paths)) {
    it(`${name}: with the floor at admin, refuses an operator's token and runs for an admin's`, async () => {
      writeConfig({ floor: "admin" });
      // A bootstrap token's first sign-in records its subject in the account registry. Done before
      // the snapshot, which is of what the run writes.
      for (const role of ["operator", "admin"] as const) {
        expect(await mods.auth.authenticatedUser(`Bearer ${await tokenFor({ bootstrap: role })}`)).toMatchObject({ principal: "bootstrap", role });
      }
      const before = snapshot(workspace);

      const refused = await reach({ bootstrap: "operator" });
      expect(refused).toContain("Agent swarm_maintainer maintains the deployment and needs role admin");
      expect(snapshot(workspace)).toEqual(before);
      expectRefusedAs("operator");

      nextRun();
      await reach({ bootstrap: "admin" });
      expectRan();
    }, 60_000);
  }
});

/** Ends the queued work of a test: the worker, the job store and the armed schedules. */
async function clearQueuedWork(): Promise<void> {
  await mods.worker.stopSceneJobWorker();
  await mods.jobs.resetJobsForTests();
  mods.scheduleRunner._resetScheduledTaskRuntimeForTests();
  for (const record of mods.schedules.listScheduledTaskRecords()) mods.schedules.deleteScheduledTask(record.id);
}

const expectRefusedAs = (role: string) => {
  expect(maintainerCalls()).toHaveLength(0);
  expect(wroteNote()).toBe(false);
  expect(refusals.length).toBeGreaterThan(0);
  expect(refusals.every((refusal) => refusal["role"] === role && refusal["deniedBy"] === "role_floor")).toBe(true);
};

const expectRan = () => {
  expect(maintainerCalls().length).toBeGreaterThan(0);
  expect(wroteNote()).toBe(true);
};

/** Forgets what the previous run of a test did: its model calls, refusals and note. */
function nextRun(): void {
  model.calls.length = 0;
  refusals.length = 0;
  rmSync(join(workspace, "notes"), { recursive: true, force: true });
}

describe("a run for an account that carries no role, as a queued job's or a scheduled run's turn starts one", () => {
  const runFor = (identity: { userId: string; account: string }) => mods.subAgent.runSubAgentWithStats({
    agentName: "swarm_maintainer", task: TASK, parentSessionId: "floor-account", workspacePath: workspace, identity,
  });

  afterEach(forgetAccountRegistry);

  it("answers to the role the account holds now, and is refused when its account no longer signs in", async () => {
    writeConfig();

    expect((await runFor(identityOf("vic"))).stats.terminalState).toBe("refused");
    expect((await runFor(identityOf("alice"))).stats.terminalState).toBe("completed");
    expect(refusals).toEqual([expect.objectContaining({ agent: "swarm_maintainer", role: "viewer", deniedBy: "role_floor" })]);

    nextRun();
    const gone = await runFor({ userId: "gone", account: testAccountId("gone") });
    expect(gone.output).toBe("Agent swarm_maintainer maintains the deployment and needs role operator");
    expect(maintainerCalls()).toHaveLength(0);
    expect(refusals).toEqual([expect.objectContaining({ agent: "swarm_maintainer", role: null, deniedBy: "role_floor" })]);
  });

  it("of an identity-provider account, whose role only its sign-in carries, has no known role: the floor does not invent one", async () => {
    writeConfig({ provider: "oidc" });
    mkdirSync(join(workspace, PRODUCT.stateDirName), { recursive: true });
    writeFileSync(registryFile, JSON.stringify({
      version: 1,
      bootstrapSubs: [],
      accounts: [{
        id: "oidc-0123456789abcdef", issuer: "https://idp.example", subject: "subject-1", username: "olga",
        status: "active", firstSeenAt: "2026-01-01T00:00:00Z", lastSeenAt: "2026-01-01T00:00:00Z",
      }],
    }), "utf8");
    (await import("../runtime/account-registry.js")).resetAccountRegistryForTests();

    expect((await runFor({ userId: "olga", account: "oidc-0123456789abcdef" })).stats.terminalState).toBe("completed");
    expect(refusals).toEqual([]);
    // A builtin account of the same deployment still answers to the role its record holds.
    expect((await runFor(identityOf("vic"))).stats.terminalState).toBe("refused");
  });
});

describe("queued work: /job, the scene and job run routes, a scheduled run", () => {
  afterEach(clearQueuedWork);

  it("/job: a viewer's job is refused the agent in its step's turn and writes nothing; an operator's job runs it", async () => {
    writeConfig();
    const before = snapshot(workspace);

    await withChatOpenToViewers(async () => {
      expect((await sendChat("vic", "/job tune_job")).map((status) => status["status"])).toEqual(["accepted", "ok"]);
      await runQueuedJobs();

      expectRefusedAs("viewer");
      expect(snapshot(workspace)).toEqual(before);

      nextRun();
      await sendChat("alice", "/job tune_job");
      await runQueuedJobs();
      expectRan();
    });
  }, 90_000);

  it("the scene and job run routes: with the floor at admin, an operator's queued run is refused and an admin's runs", async () => {
    writeConfig({ floor: "admin" });
    const queue = async (user: UserName, route: string) => {
      const response = await fetch(`${baseUrl}${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${await tokenFor(user)}` },
        body: "{}",
      });
      expect(response.status).toBe(200);
    };

    for (const route of ["/api/scenes/tune_swarm_queued/run", "/api/jobs/tune_job/run"]) {
      nextRun();
      await queue("alice", route);
      await runQueuedJobs();
      expectRefusedAs("operator");
    }

    nextRun();
    await queue("root", "/api/jobs/tune_job/run");
    await runQueuedJobs();
    expectRan();
  }, 120_000);

  it("a viewer's scheduled run, armed again at boot, is refused the agent and writes nothing; an operator's runs it", async () => {
    writeConfig();
    const before = snapshot(workspace);
    const schedule = (user: UserName) => mods.schedules.saveScheduledTask({
      id: `sched_${user}`,
      label: "Tune the swarm",
      task: QUEUED_TASK,
      ...identityOf(user),
      at: new Date(Date.now() - 60_000).toISOString(),
      createdAt: new Date().toISOString(),
    });

    schedule("vic");
    // As at boot: the stored schedules are armed with nobody's work around them, and this one is due.
    mods.scheduleRunner.rehydrateScheduledTasks();
    await runQueuedJobs();
    expectRefusedAs("viewer");
    expect(snapshot(workspace)).toEqual(before);

    nextRun();
    schedule("alice");
    mods.scheduleRunner.rehydrateScheduledTasks();
    await runQueuedJobs();
    expectRan();
  }, 90_000);
});

describe("a queued job answers to its owner, not to the work that wakes the worker", () => {
  afterEach(clearQueuedWork);

  it("a queued job answers to its owner's role, whoever's work wakes the worker that claims it", async () => {
    writeConfig();

    await withChatOpenToViewers(async () => {
      // An admin's job, claimed by a pump that a viewer's work woke: it runs.
      await sendChat("root", "/job tune_job");
      await runQueuedJobs({ identity: identityOf("vic"), callerRole: "viewer" });
      expect(refusals).toEqual([]);
      expectRan();

      // A viewer's job, claimed by a pump that an admin's work woke: it is refused.
      nextRun();
      await sendChat("vic", "/job tune_job");
      await runQueuedJobs({ identity: identityOf("root"), callerRole: "admin" });
      expectRefusedAs("viewer");
    });
  }, 90_000);

  it("a queued job with no role (a trigger's) keeps none when a signed-in admin's work wakes the worker", async () => {
    writeConfig();
    const { getJobDefinition, resolveJobSteps } = await import("../credentials/jobs.js");
    const { principalIdentity } = await import("../runtime/user-scope.js");
    // The hook docs/forking.md shows: a full-scope agent runs only for a run whose role is known.
    await loadExtension({
      name: "gatekeeper",
      version: "1.0.0",
      authorizeAgentRun: (run: { role?: string; agentConfig: { workspaceAccess?: string } }) =>
        run.agentConfig.workspaceAccess === "full" && run.role === undefined ? "Maintenance agents run only for a signed-in account" : undefined,
    });
    try {
      // As a cron or channel trigger queues it: the job's own principal, nobody's account.
      await mods.jobs.createJob({
        sceneName: "tune_job",
        definitionType: "job",
        ...principalIdentity("job:tune_job", "synthetic"),
        steps: resolveJobSteps(getJobDefinition("tune_job")!),
        turnTimeoutMs: 60_000,
      });

      await runQueuedJobs({ identity: identityOf("root"), callerRole: "admin" });

      const turnCalls = model.calls.filter((call) => call.agentName === "main");
      expect(turnCalls.length).toBeGreaterThan(0);
      expect(turnCalls.every((call) => call.callerRole === undefined)).toBe(true);
      expect(maintainerCalls()).toHaveLength(0);
      expect(wroteNote()).toBe(false);
      expect(refusals.length).toBeGreaterThan(0);
      expect(refusals.every((refusal) => refusal["role"] === null && refusal["deniedBy"] === "gatekeeper")).toBe(true);
    } finally {
      unloadExtensions();
    }
  }, 60_000);
});

describe("a turn and the caller role it carries", () => {
  /** A webchat turn of `user`'s session, directed to swarm_maintainer as `--agent` directs it. */
  async function directedTurn(user: UserName): Promise<void> {
    const { createSession } = await import("../agent/session.js");
    const { runTurn } = await import("../agent/runtime.js");
    const session = createSession({ channel: "webchat", userId: user, account: users[user].id, userRole: users[user].record["role"] as string });
    await runTurn({ session, userMessage: TASK, directiveAgent: "swarm_maintainer", allowedAgents: ["swarm_maintainer"] });
  }

  it("puts the session's role on the turn, so an operator's turn that reaches the agent past the gateway is refused at the run", async () => {
    writeConfig({ floor: "admin" });

    await directedTurn("alice");
    const turnCalls = model.calls.filter((call) => call.agentName === "main");
    expect(turnCalls.length).toBeGreaterThan(0);
    expect(turnCalls.every((call) => call.callerRole === "operator")).toBe(true);
    expect(maintainerCalls()).toHaveLength(0);
    expect(wroteNote()).toBe(false);
    expect(refusals).toEqual([expect.objectContaining({ agent: "swarm_maintainer", role: "operator", deniedBy: "role_floor" })]);

    await directedTurn("root");
    expect(maintainerCalls().length).toBeGreaterThan(0);
    expect(wroteNote()).toBe(true);
  }, 60_000);

  it("run_workflow's nested turn, on a workflow session no sign-in created, keeps the role of the turn that started it", async () => {
    writeConfig({ floor: "admin" });
    // A caller whose role is known and who has no account (a bootstrap token): only the role the
    // nested turn inherits can refuse it, as no account's role can be looked up for it. The scene
    // allows two agents, so run_workflow runs it as a nested orchestrator turn.
    const identity = { userId: "ops-token", principal: "bootstrap" as const };
    const runWorkflow = (role: string) => mods.context.runWithRequestContext({ identity, callerRole: role }, () =>
      mods.registry.executeTool("run_workflow", { name: "tune_swarm_turn" }, {
        sessionId: `floor-nested-${role}`,
        workspacePath: workspace,
        userId: identity.userId,
        identity,
        userRole: role,
      }));

    await runWorkflow("operator");
    expect(model.calls.some((call) => call.agentName === "main" && call.callerRole === "operator")).toBe(true);
    expectRefusedAs("operator");

    nextRun();
    await runWorkflow("admin");
    expectRan();
  }, 90_000);
});

describe("routing for a caller below the floor", () => {
  it("search_agents and list_agents leave the full-scope agent out for an operator and offer it to an admin", async () => {
    writeConfig({ floor: "admin" });

    for (const tool of ["search_agents", "list_agents"] as const) {
      expect(await offered(tool, "admin")).toContain("swarm_maintainer");
      const toOperator = await offered(tool, "operator");
      expect(toOperator).not.toContain("swarm_maintainer");
      expect(toOperator).toContain("note_taker");
    }
  });

  it("with the default floor, offers it to an operator and not to a viewer", async () => {
    writeConfig();

    expect(await offered("search_agents", "operator")).toContain("swarm_maintainer");
    expect(await offered("search_agents", "viewer")).not.toContain("swarm_maintainer");
  });
});
