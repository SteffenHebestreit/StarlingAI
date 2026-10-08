/**
 * The end-to-end harness (src/e2e) against a FAKE gateway: a local http + ws server that speaks
 * just the protocol the harness uses — login, hello-ok, RPC (audit.subscribe, session.create,
 * chat.send, chat.cancel, session.get), audit.event and status messages, the steer route, the
 * upload route and an echo route — plus a fake OpenAI-compatible judge and a fake GreenMail
 * (REST + SMTP). Nothing here reaches a real gateway or model.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import bcrypt from "bcryptjs";
import JSON5 from "json5";
import {
  E2EInfraError,
  GatewayClient,
  readCredentialsFile,
  rootSessionOf,
  type E2ECredentials,
} from "../e2e/gateway-client.js";
import {
  adoptUnconfirmedTurns,
  runScenario,
  runScenarios,
  redactSecrets,
  unconfirmedTurnsOf,
  type RunnerDeps,
  type RunnerOptions,
} from "../e2e/runner.js";
import {
  environmentStatusFromScript,
  interpretEnvironmentStatus,
  mailIsolationCheck,
  mailIsolationVerdict,
  ServiceProber,
  type ServiceProbeContext,
} from "../e2e/services.js";
import { runE2ECli, runLockPath, type CliIo, type InterruptHooks } from "../e2e/cli.js";
import { filterScenarios, loadScenarios } from "../e2e/loader.js";
import { buildReport, compareWithBaseline, writeReport } from "../e2e/report.js";
import { resolveSetupPaths, runE2ESetup, SetupRefusedError } from "../e2e/setup.js";
import { detectReplyLanguage, fieldMatches, summarizeAgents, summarizeTools } from "../e2e/assertions.js";
import { parseJudgeScore } from "../e2e/judge.js";
import { GreenMailAdapter, parseMimeMessage, type MailAdapter } from "../e2e/mail.js";
import { findRepoRoot, resolveE2EPaths } from "../e2e/paths.js";
import type { E2EScenario } from "../e2e/scenario.js";

// ── fake gateway ─────────────────────────────────────────────────────────────

interface FakeTurn {
  requestId: string;
  sessionId: string;
  ws: WebSocket;
  steers: string[];
  steerWaiters: Array<(text: string) => void>;
  cancelled: boolean;
  onCancel: Array<() => void>;
  done: boolean;
}

interface TurnContext {
  sessionId: string;
  requestId: string;
  message: string;
  /** The account whose session the turn runs in. */
  user: string;
  audit: (type: string, data?: Record<string, unknown>, sessionId?: string) => void;
  finish: (status: "ok" | "error" | "blocked", response: string, extra?: Record<string, unknown>) => void;
  addTranscript: (entry: Record<string, unknown>) => void;
  waitForSteer: (timeoutMs: number) => Promise<string | null>;
  cancelled: Promise<void>;
}

type TurnScript = (turn: TurnContext) => Promise<void>;

const PASSWORDS = { eval: "pw-eval-0123456789abcdefXYZ", "eval-viewer": "pw-viewer-0123456789abcdefXYZ", alice: "pw-alice-0123456789abcdefXYZ" };
/** alice: an account of the deployment that is not an eval account. */
const ROLES: Record<string, "operator" | "viewer"> = { eval: "operator", "eval-viewer": "viewer", alice: "operator" };

type MemoryScope = "user" | "workspace";

class FakeGateway {
  url = "";
  healthy = true;
  judgeAnswer = "SCORE: 9";
  /** auth.enabled: off, every account's memory is the one shared single-operator store. */
  authEnabled = true;
  /** Workspace memory in one store for every account, as the routes before 5fc9a8e kept it. */
  sharedWorkspace = false;
  /** An HTTP status every memory listing answers with instead of the entries. */
  memoryListingStatus: number | null = null;
  /** The same, for one account's listings only. */
  readonly memoryListingFailures = new Map<string, number>();
  /** The next chat.send starts its turn, and the socket dies before the send is answered. */
  dropSocketOnNextSend = false;
  /** The next chat.send is answered with an error, and no turn starts. */
  refuseNextSend = false;
  /** When the gateway process started: gateway.status answers with the uptime since. */
  startedAt = Date.now();
  readonly judgeRequests: Array<Record<string, unknown>> = [];
  readonly chatSends: Array<Record<string, unknown>> = [];
  readonly sessionChannels: string[] = [];
  readonly steers: Array<{ sessionId: string; message: string; requestId?: string; clientMessageId?: string }> = [];
  readonly cancels: string[] = [];
  readonly httpPaths: string[] = [];
  /** HTTP requests ("<METHOD> <path>") and "chat.send", in the order they arrived. */
  readonly sequence: string[] = [];
  /** Durable memory by `<store>:<scope>` (store: the account, or "shared"), key → record. */
  readonly memory = new Map<string, Map<string, { id?: string; content: string }>>();
  private memoryCounter = 0;
  /** The dialectic user model by store (user-model/service.ts): its lists only. */
  readonly userModels = new Map<string, Record<string, string[]>>();
  private readonly server = http.createServer((req, res) => void this.handleHttp(req, res));
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly sessions = new Map<string, { owner: string; transcript: Array<Record<string, unknown>> }>();
  private readonly turns = new Map<string, FakeTurn>();
  private readonly activeBySession = new Map<string, string>();
  private readonly subscribers = new Map<WebSocket, string>();
  private sessionCounter = 0;
  private scripts: Array<{ match: RegExp; run: TurnScript }> = [];
  private readonly tokens = new Map<string, string>();
  logins = 0;

  setScripts(scripts: Array<{ match: RegExp; run: TurnScript }>): void {
    this.scripts = scripts;
  }

  /** Another chat of the account, so its events reach the account's audit stream. */
  adoptSession(sessionId: string, owner: string): void {
    this.sessions.set(sessionId, { owner, transcript: [] });
  }

  /** The store a request of `user` reaches, as the gateway resolves it from the request context. */
  storeOf(user: string, scope: MemoryScope): string {
    return !this.authEnabled || (scope === "workspace" && this.sharedWorkspace) ? "shared" : user;
  }

  /** A durable memory entry as memory_store writes one: a fresh id per entry (withoutId: listed without one). */
  remember(store: string, scope: MemoryScope, key: string, content = key, options: { withoutId?: boolean } = {}): void {
    const entries = this.memory.get(`${store}:${scope}`) ?? new Map<string, { id?: string; content: string }>();
    this.memory.set(`${store}:${scope}`, entries);
    this.memoryCounter += 1;
    entries.set(key, options.withoutId ? { content } : { id: `mem-${this.memoryCounter}`, content });
  }

  memoryKeys(store: string, scope: MemoryScope): string[] {
    return [...(this.memory.get(`${store}:${scope}`)?.keys() ?? [])];
  }

  async start(): Promise<void> {
    this.server.on("upgrade", (req, socket, head) => {
      if (!req.url?.startsWith("/ws")) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, req));
    });
    await new Promise<void>((resolveListen) => this.server.listen(0, "127.0.0.1", resolveListen));
    const address = this.server.address() as net.AddressInfo;
    this.url = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    for (const ws of this.wss.clients) ws.terminate();
    this.wss.close();
    this.server.closeAllConnections();
    await new Promise<void>((resolveClose) => this.server.close(() => resolveClose()));
  }

  private userOf(header: string | undefined): string | null {
    const token = /^Bearer\s+(.+)$/i.exec(header ?? "")?.[1];
    return token ? this.tokens.get(token) ?? null : null;
  }

  /** Every token issued so far stops working, and every socket is dropped (e.g. a rotated secret). */
  revokeTokens(): void {
    this.tokens.clear();
    for (const ws of this.wss.clients) ws.terminate();
  }

  private emitAudit(type: string, sessionId: string, data: Record<string, unknown>): void {
    const root = rootSessionOf(sessionId);
    const owner = this.sessions.get(root)?.owner;
    const event = { id: `ev-${Math.random().toString(36).slice(2)}`, timestamp: new Date().toISOString(), type, sessionId, data, severity: "info" };
    for (const [ws, user] of this.subscribers) {
      if (owner === user) ws.send(JSON.stringify({ type: "audit.event", data: event }));
    }
  }

  private onConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const user = this.userOf(req.headers["authorization"]);
    if (!user) {
      ws.close(4401, "Unauthorized");
      return;
    }
    ws.send(JSON.stringify({ type: "hello-ok", data: { connId: "fake", version: "0.1.0", sessions: [] } }));
    ws.on("close", () => this.subscribers.delete(ws));
    ws.on("message", (raw) => {
      const { id, method, params = {} } = JSON.parse(raw.toString()) as { id: string; method: string; params?: Record<string, unknown> };
      const respond = (payload: unknown): void => ws.send(JSON.stringify({ type: "rpc.response", id, ok: true, payload }));
      const fail = (error: string): void => ws.send(JSON.stringify({ type: "rpc.response", id, ok: false, error }));
      switch (method) {
        case "audit.subscribe":
          this.subscribers.set(ws, user);
          respond({ subscribed: true });
          return;
        case "session.create": {
          this.sessionCounter += 1;
          const sessionId = `sess-${this.sessionCounter}`;
          this.sessions.set(sessionId, { owner: user, transcript: [] });
          this.sessionChannels.push(String(params["channel"]));
          // Like the real gateway: the session's first event goes out before the RPC answer.
          this.emitAudit("session_created", sessionId, { channel: params["channel"] });
          respond({ sessionId });
          return;
        }
        case "session.get": {
          const session = this.sessions.get(String(params["sessionId"]));
          if (!session || session.owner !== user) return fail(`Error: Session not found: ${String(params["sessionId"])}`);
          // Like gateway/rpc.ts: whether a turn still runs in the session, a stopped one unwinding included.
          respond({ transcript: session.transcript, totalMessages: session.transcript.length, activeTurn: this.activeBySession.has(String(params["sessionId"])) });
          return;
        }
        case "chat.send":
          this.startTurn(ws, user, params, respond, fail);
          return;
        case "gateway.status":
          respond({ status: "running", sessions: this.sessions.size, uptime: (Date.now() - this.startedAt) / 1000 });
          return;
        case "chat.cancel": {
          const requestId = String(params["requestId"]);
          this.cancels.push(requestId);
          const turn = this.turns.get(requestId);
          if (!turn || turn.done || turn.cancelled) return respond({ cancelled: false, requestId, known: Boolean(turn) });
          turn.cancelled = true;
          for (const callback of turn.onCancel) callback();
          respond({ cancelled: true, requestId, known: true });
          return;
        }
        default:
          fail(`Error: Unknown method: ${method}`);
      }
    });
  }

  private startTurn(ws: WebSocket, user: string, params: Record<string, unknown>, respond: (payload: unknown) => void, fail: (error: string) => void): void {
    const sessionId = String(params["sessionId"]);
    const requestId = String(params["requestId"]);
    const message = String(params["message"]);
    const session = this.sessions.get(sessionId);
    if (!session || session.owner !== user) return fail(`Error: Session not found: ${sessionId}`);
    if (this.refuseNextSend) {
      this.refuseNextSend = false;
      return fail("Error: chat.send refused");
    }
    this.chatSends.push(params);
    this.sequence.push("chat.send");
    const turn: FakeTurn = { requestId, sessionId, ws, steers: [], steerWaiters: [], cancelled: false, onCancel: [], done: false };
    this.turns.set(requestId, turn);
    this.activeBySession.set(sessionId, requestId);
    if (this.dropSocketOnNextSend) {
      this.dropSocketOnNextSend = false;
      ws.terminate();
    } else {
      ws.send(JSON.stringify({ type: "status", data: { requestId, status: "accepted" } }));
      respond({ accepted: true, requestId });
    }
    const script = this.scripts.find((candidate) => candidate.match.test(message))?.run;
    const context: TurnContext = {
      sessionId,
      requestId,
      message,
      user,
      audit: (type, data = {}, sid = sessionId) => this.emitAudit(type, sid, data),
      finish: (status, response, extra = {}) => {
        if (turn.done) return;
        turn.done = true;
        if (this.activeBySession.get(sessionId) === requestId) this.activeBySession.delete(sessionId);
        ws.send(JSON.stringify({ type: "status", data: { status, requestId, ...(status === "error" ? {} : { response }), ...extra } }));
      },
      addTranscript: (entry) => session.transcript.push(entry),
      waitForSteer: (timeoutMs) => new Promise((resolveSteer) => {
        if (turn.steers.length > 0) return resolveSteer(turn.steers[0]!);
        const timer = setTimeout(() => resolveSteer(null), timeoutMs);
        turn.steerWaiters.push((text) => {
          clearTimeout(timer);
          resolveSteer(text);
        });
      }),
      cancelled: new Promise<void>((resolveCancel) => turn.onCancel.push(resolveCancel)),
    };
    setImmediate(() => {
      ws.send(JSON.stringify({ type: "status", data: { requestId, status: "delegating", message: "working" } }));
      ws.send(JSON.stringify({ type: "agent.chunk", data: { requestId, text: "…" } }));
      void (script ? script(context) : Promise.resolve(context.finish("ok", `echo: ${message}`)));
    });
  }

  private async readBody(req: http.IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fake");
    this.httpPaths.push(`${req.method} ${url.pathname}`);
    this.sequence.push(`${req.method} ${url.pathname}`);
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const body = await this.readBody(req);
    if (req.method === "GET" && url.pathname === "/healthz") return json(this.healthy ? 200 : 503, { status: this.healthy ? "ok" : "down" });
    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      const { username, password } = JSON.parse(body.toString()) as { username: string; password: string };
      const expected = PASSWORDS[username as keyof typeof PASSWORDS];
      if (!expected || expected !== password) return json(401, { error: "Invalid username or password" });
      this.logins += 1;
      const token = `tok-${username}-${this.logins}`;
      this.tokens.set(token, username);
      return json(200, { token, username, role: ROLES[username] });
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      this.judgeRequests.push(JSON.parse(body.toString()) as Record<string, unknown>);
      return json(200, { choices: [{ message: { role: "assistant", content: this.judgeAnswer } }] });
    }
    if (req.method === "GET" && url.pathname === "/api/auth/mode") return json(200, { authEnabled: this.authEnabled, provider: "builtin" });
    const user = this.userOf(req.headers["authorization"]);
    if (!user) return json(401, { error: "Unauthorized" });
    if (req.method === "GET" && url.pathname === "/api/auth/me") return json(200, { username: user, role: ROLES[user] });
    // The gateway's role gate (gateway/index.ts): under auth, every mutating /api route is operator-only.
    if (this.authEnabled && req.method !== "GET" && ROLES[user] !== "operator") return json(403, { error: "Operator role required for this action" });
    if (req.method === "GET" && url.pathname === "/api/health/subsystems") {
      return json(200, { healthy: true, degraded: false, checks: [{ name: "primary_model", status: "ok", detail: "fake reachable" }, { name: "engram", status: "ok", detail: "not configured (RAG enhancement off)" }] });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/echo/")) {
      return json(200, { hello: "world", user, session: decodeURIComponent(url.pathname.slice("/api/echo/".length)), token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJldmFsIn0.c2lnbmF0dXJlLXNpZ25hdHVyZQ" });
    }
    if (req.method === "GET" && url.pathname === "/api/memory/entries") {
      const failure = this.memoryListingStatus ?? this.memoryListingFailures.get(user) ?? null;
      if (failure !== null) return json(failure, { error: "memory store unavailable" });
      const scope = url.searchParams.get("scope") === "user" ? "user" : "workspace";
      const query = (url.searchParams.get("query") ?? "").toLowerCase();
      const limit = Number(url.searchParams.get("limit") ?? 200);
      const records = [...(this.memory.get(`${this.storeOf(user, scope)}:${scope}`) ?? new Map<string, { id?: string; content: string }>())]
        .map(([key, entry]) => ({ ...(entry.id ? { id: entry.id } : {}), key, subject: key, content: entry.content }))
        .filter((record) => !query || record.content.toLowerCase().includes(query) || record.key.toLowerCase().includes(query));
      const paged = records.slice(0, limit);
      return json(200, { scope, total: records.length, returned: paged.length, records: paged });
    }
    if (req.method === "GET" && url.pathname === "/api/user-model") {
      const lists = this.userModels.get(this.storeOf(user, "user")) ?? {};
      return json(200, { schemaVersion: 1, goals: [], expertise: [], workingStyle: [], communication: [], openQuestions: [], ...lists, revision: 1, updatedAt: "2026-10-08T00:00:00.000Z", updatedBy: "system" });
    }
    if (req.method === "POST" && url.pathname === "/api/user-model/reset") {
      this.userModels.delete(this.storeOf(user, "user"));
      return json(200, { schemaVersion: 1, goals: [], expertise: [], workingStyle: [], communication: [], openQuestions: [], revision: 2, updatedAt: "2026-10-08T00:00:00.000Z", updatedBy: "user" });
    }
    const memoryEntry = /^\/api\/memory\/entries\/([^/]+)$/.exec(url.pathname);
    if (req.method === "DELETE" && memoryEntry) {
      const scope = url.searchParams.get("scope") === "user" ? "user" : "workspace";
      const deleted = this.memory.get(`${this.storeOf(user, scope)}:${scope}`)?.delete(decodeURIComponent(memoryEntry[1]!)) ?? false;
      return deleted ? json(200, { scope, deleted: true }) : json(404, { error: "Memory entry not found" });
    }
    const steer = /^\/api\/sessions\/([^/]+)\/steer$/.exec(url.pathname);
    if (req.method === "POST" && steer) {
      const sessionId = decodeURIComponent(steer[1]!);
      const payload = JSON.parse(body.toString()) as { message: string; requestId?: string; clientMessageId?: string };
      this.steers.push({ sessionId, ...payload });
      const active = this.activeBySession.get(sessionId);
      const turn = active ? this.turns.get(active) : undefined;
      if (!turn || (payload.requestId && payload.requestId !== turn.requestId)) {
        return json(200, { steered: false, active: false, error: "The turn this was typed into has ended." });
      }
      turn.steers.push(payload.message);
      for (const waiter of turn.steerWaiters.splice(0)) waiter(payload.message);
      return json(200, { steered: true, active: true, id: payload.clientMessageId ?? "generated" });
    }
    if (req.method === "POST" && url.pathname === "/api/multimodal/persist-attachment") {
      const form = await new Response(new Uint8Array(body), { headers: { "content-type": String(req.headers["content-type"]) } }).formData();
      const file = form.get("file");
      const sessionId = String(form.get("sessionId"));
      if (!(file instanceof Blob)) return json(400, { error: "file is required" });
      const filename = (file as File).name;
      return json(200, { filename, relativePath: `uploads/${sessionId}/1-${filename}`, contentType: file.type, size: file.size });
    }
    json(404, { error: "not found" });
  }
}

// ── turn scripts ─────────────────────────────────────────────────────────────

const HELLO_REPLY = "Hello! The answer is 42, and it is the final answer to your question.";

const helloScript: TurnScript = async (turn) => {
  turn.audit("message_received", { chars: turn.message.length });
  turn.audit("tool_call_requested", { tool: "delegate_to_agent", args: { agentName: "researcher" } });
  const researcher = `sub:${turn.sessionId}:researcher:1700000000000`;
  turn.audit("sub_agent_started", { agentName: "researcher", task: "find the answer" }, researcher);
  turn.audit("sub_agent_tool_call", { agentName: "researcher", tool: "web_search", phase: "start", toolCallId: "call-1" }, researcher);
  turn.audit("sub_agent_tool_call", { agentName: "researcher", tool: "web_search", phase: "done", toolCallId: "call-1", success: true }, researcher);
  // Refused before dispatch: a "done" with no "start" — not a call.
  turn.audit("sub_agent_tool_call", { agentName: "researcher", tool: "fetch_url", phase: "done", toolCallId: "call-2", success: false }, researcher);
  turn.audit("sub_agent_tool_call", { agentName: "researcher", tool: "web_search", phase: "recovered", reason: "bookkeeping" }, researcher);
  const nested = `sub:${researcher}:summarizer:1700000000001`;
  turn.audit("sub_agent_started", { agentName: "summarizer" }, nested);
  // Not a run: the discovery-fallback note logged on the parent.
  turn.audit("sub_agent_started", { agentName: "researcher", stage: "discovery_fallback_strip" });
  turn.audit("sub_agent_completed", { agentName: "researcher" }, researcher);
  turn.addTranscript({ role: "user", requestId: turn.requestId, content: turn.message, attachments: [{ filename: "upload.txt", relativePath: "uploads/x/upload.txt" }] });
  turn.addTranscript({
    role: "assistant",
    requestId: turn.requestId,
    content: HELLO_REPLY,
    attachments: [{ filename: "answer.md", relativePath: "generated/answer.md" }],
    toolCalls: [{ name: "delegate_to_agent", args: {}, metadata: { artifacts: [{ outputPath: "generated/chart.png", filename: "chart.png" }] } }],
  });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  turn.finish("ok", HELLO_REPLY);
  // Trailing: logged right after the final status, collected in the settle window.
  turn.audit("turn_scorecard", { version: 2 });
};

const steerScript: TurnScript = async (turn) => {
  const writer = `sub:${turn.sessionId}:content_writer:1700000000002`;
  turn.audit("sub_agent_started", { agentName: "content_writer" }, writer);
  const note = await turn.waitForSteer(5_000);
  if (note) turn.audit("sub_agent_steering_injected", { agentName: "content_writer", runSessionId: writer, count: 1 });
  turn.finish("ok", note ? `Done, and I applied your note: ${note}` : "Done without any note.");
};

const hangScript: TurnScript = async (turn) => {
  turn.audit("sub_agent_started", { agentName: "researcher" }, `sub:${turn.sessionId}:researcher:1700000000003`);
  await turn.cancelled;
  turn.finish("error", "", { error: "Error: turn aborted" });
};

// ── fixtures ─────────────────────────────────────────────────────────────────

const scratch = mkdtempSync(join(tmpdir(), "sai-e2e-harness-"));
const fixturesDir = join(scratch, "fixtures");
mkdirSync(fixturesDir, { recursive: true });
writeFileSync(join(fixturesDir, "notes.md"), "# Synthetic notes\nThe launch code word is HERON.\n");

const gateway = new FakeGateway();
let client: GatewayClient;

function credentials(): E2ECredentials {
  return {
    eval: { username: "eval", password: PASSWORDS.eval },
    "eval-viewer": { username: "eval-viewer", password: PASSWORDS["eval-viewer"] },
  };
}

function deps(overrides: Partial<RunnerDeps> = {}): RunnerDeps {
  const base: RunnerDeps = {
    client,
    prober: new ServiceProber({ gatewayUrl: gateway.url, authedGet: (path) => client.http("eval", "GET", path), mail: null }),
    fixturesDir,
    mail: null,
    judge: null,
  };
  return { ...base, ...overrides };
}

const FAST: RunnerOptions = { settleMs: 40, eventGraceMs: 50, cancelGraceMs: 2_000, defaultTurnTimeoutMs: 10_000, defaultAttemptTimeoutMs: 20_000 };

function loaded(scenario: E2EScenario) {
  return { scenario, file: `${scenario.id}.jsonc`, template: false };
}

async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
}

beforeAll(async () => {
  await gateway.start();
});

afterAll(async () => {
  await gateway.stop();
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  gateway.healthy = true;
  gateway.judgeAnswer = "SCORE: 9";
  gateway.authEnabled = true;
  gateway.sharedWorkspace = false;
  gateway.memoryListingStatus = null;
  gateway.memoryListingFailures.clear();
  gateway.dropSocketOnNextSend = false;
  gateway.refuseNextSend = false;
  // A gateway that has run for an hour.
  gateway.startedAt = Date.now() - 3_600_000;
  gateway.memory.clear();
  gateway.userModels.clear();
  gateway.setScripts([
    { match: /^hello/i, run: helloScript },
    { match: /^steer/i, run: steerScript },
    { match: /^hang/i, run: hangScript },
  ]);
  client = new GatewayClient({ baseUrl: gateway.url, credentials: credentials(), rpcTimeoutMs: 5_000, connectTimeoutMs: 5_000 });
});

afterEach(() => {
  client.close();
});

const helloTurn = {
  kind: "turn" as const,
  id: "greet",
  message: "hello there",
  agent: "researcher",
  effort: "low" as const,
};

// ── tests ────────────────────────────────────────────────────────────────────

describe("e2e harness against a fake gateway", () => {
  it("passes a scenario end to end: root-scoped events, tools, agents, artifacts, http, pass^k", async () => {
    const scenario: E2EScenario = {
      id: "fake-hello",
      title: "Fake hello",
      group: "core",
      requires: ["model"],
      steps: [
        {
          ...helloTurn,
          expect: {
            status: "ok",
            reply: { includes: ["answer is 42"], includesAny: ["hi", "hello"], excludes: ["sorry"], matches: ["\\b42\\b"], language: "en", minChars: 10, maxChars: 200 },
            events: {
              must: [
                { type: "sub_agent_started", where: { "data.agentName": "researcher", "data.stage": { exists: false } }, min: 1, max: 1 },
                { type: "sub_agent_started", where: { sessionId: { regex: "^sub:sub:" } } },
                { type: "turn_scorecard" },
                { type: "message_received", where: { "data.chars": { gte: 5 } } },
              ],
              mustNot: [{ type: "tool_call_blocked" }, { type: "sub_agent_started", where: { "data.agentName": "intruder" } }],
            },
            tools: { mustCall: ["web_search", "delegate_to_agent"], mustNotCall: ["fetch_url", "send_mail"], maxCalls: { web_search: 1 } },
            agents: { mustRun: ["researcher", "summarizer"], mustRunAny: ["coder", "summarizer"], mustNotRun: ["intruder"], maxRuns: 2 },
            artifacts: { minCount: 2, pathMatches: ["answer\\.md$", "CHART\\.PNG$"] },
            durationMs: { max: 10_000 },
            judge: { rubric: "The reply must state that the answer is 42.", minScore: 7 },
          },
        },
        { kind: "http", method: "GET", path: "/api/echo/{sessionId}", expect: { status: 200, bodyIncludes: ["\"user\":\"eval\""] } },
      ],
    };
    // An event of another session of the same account, mid-turn, must not count for this turn.
    const original = helloScript;
    gateway.adoptSession("sess-other", "eval");
    gateway.setScripts([{ match: /^hello/i, run: async (turn) => {
      turn.audit("sub_agent_started", { agentName: "intruder" }, "sub:sess-other:intruder:1");
      await original(turn);
    } }]);
    const result = await runScenario(loaded(scenario), deps(), { ...FAST, repeat: 2 });

    expect(result.attempts.map((attempt) => attempt.failures)).toEqual([[], []]);
    expect(result.status).toBe("passed");
    expect(result.passCount).toBe(2);
    expect(result.passAll).toBe(true);
    expect(result.services.map((state) => state.service)).toEqual(["gateway", "model"]);
    const first = result.attempts[0]!;
    expect(first.sessions).toHaveLength(1);
    const turn = first.steps[0]!.turn!;
    expect(turn.status).toBe("ok");
    expect(turn.agents).toEqual({ researcher: 1, summarizer: 1 });
    expect(turn.tools.calls).toEqual({ delegate_to_agent: 1, web_search: 1 });
    expect(turn.tools.refused).toEqual({ fetch_url: 1 });
    expect(turn.artifacts).toEqual(["generated/answer.md", "generated/chart.png"]);
    expect(turn.eventTypeCounts["turn_scorecard"]).toBe(1);
    expect(turn.wsMessageCounts["agent.chunk"]).toBe(1);
    expect(turn.judge).toEqual({ minScore: 7, skipped: "no judge configured" });
    expect(first.notes).toContain('step 1 turn "greet": judge: skipped (no judge configured)');
    // The message went out as the dashboard sends it, in an "eval" session.
    expect(gateway.chatSends.at(-1)).toMatchObject({ message: "hello there --agent researcher", effort: "low" });
    expect(gateway.sessionChannels.every((channel) => channel === "eval")).toBe(true);
    const httpStep = first.steps[1]!;
    expect(httpStep.http?.path).toBe(`/api/echo/${first.sessions[0]}`);
    // A token in a response body never reaches the report.
    expect(httpStep.http?.bodyPreview).toContain('"token":"[redacted]"');
    expect(httpStep.http?.bodyPreview).not.toContain("eyJ");

    const report = buildReport([result], {
      startedAt: "2026-10-07T10:00:00.000Z",
      finishedAt: "2026-10-07T10:00:05.000Z",
      gatewayUrl: gateway.url,
      repeat: 2,
      concurrency: 1,
      filters: { groups: [], tags: [], ids: [] },
      judge: null,
      mail: null,
    });
    expect(report.summary).toMatchObject({ scenarios: 1, run: 1, passed: 1, attempts: 2, attemptsPassed: 2, passRate: 1, passAllRate: 1 });
    const written = writeReport(report, join(scratch, "reports"));
    expect(JSON.parse(readFileSync(written.jsonPath, "utf8"))).toMatchObject({ kind: "e2e-evaluation", summary: { passAllRate: 1 } });
    expect(readFileSync(written.markdownPath, "utf8")).toContain("| `fake-hello` | core | pass | 2/2 |");
  });

  it("reports failing reply, event, tool and agent expectations with precise messages", async () => {
    const scenario: E2EScenario = {
      id: "fake-fail",
      title: "Fake failing expectations",
      group: "core",
      steps: [{
        ...helloTurn,
        expect: {
          reply: { includes: ["banana"], language: "de" },
          events: { must: [{ type: "sub_agent_steering_injected" }, { type: "sub_agent_started", min: 4 }], mustNot: [{ type: "turn_scorecard" }] },
          tools: { mustCall: ["fetch_url"], mustNotCall: ["web_search"], maxCalls: { delegate_to_agent: 0 } },
          agents: { mustRun: ["coder"], mustRunAny: ["coder", "tester"], mustNotRun: ["summarizer"], maxRuns: 1 },
          artifacts: { minCount: 3, pathMatches: ["\\.pdf$"] },
          judge: { rubric: "Not consulted while deterministic checks fail.", minScore: 5 },
        },
      }],
    };
    const result = await runScenario(loaded(scenario), deps({ judge: { url: `${gateway.url}/v1`, model: "fake-judge" } }), FAST);
    expect(result.status).toBe("failed");
    expect(result.attempts[0]!.outcome).toBe("failed");
    const prefix = 'step 1 turn "greet": ';
    expect(result.attempts[0]!.failures).toEqual([
      `${prefix}reply.includes "banana": not found`,
      `${prefix}reply.language: expected de, detected en (German markers 0, English markers 8)`,
      `${prefix}artifacts.minCount: expected ≥3, saw 2 (generated/answer.md, generated/chart.png)`,
      `${prefix}artifacts.pathMatches /\\.pdf$/i: no artifact path matched (generated/answer.md, generated/chart.png)`,
      `${prefix}events.must sub_agent_steering_injected: expected ≥1, saw 0`,
      `${prefix}events.must sub_agent_started: expected ≥4, saw 3`,
      `${prefix}events.mustNot turn_scorecard: expected none, saw 1`,
      `${prefix}tools.mustCall fetch_url: expected ≥1 call, saw 0 (1 refused attempt(s) not counted)`,
      `${prefix}tools.mustNotCall web_search: expected no call, saw 1 (researcher×1)`,
      `${prefix}tools.maxCalls delegate_to_agent: expected ≤0 call(s), saw 1 (orchestrator×1)`,
      `${prefix}agents.mustRun coder: expected ≥1 run, saw 0 (ran: researcher×1, summarizer×1)`,
      `${prefix}agents.mustRunAny coder | tester: none ran (ran: researcher×1, summarizer×1)`,
      `${prefix}agents.mustNotRun summarizer: expected no run, saw 1`,
      `${prefix}agents.maxRuns: expected ≤1 run(s), saw 2 (researcher×1, summarizer×1)`,
    ]);
    // The judge runs only when every deterministic check passed.
    expect(result.attempts[0]!.steps[0]!.turn!.judge).toEqual({ minScore: 5, skipped: "deterministic checks failed" });
    expect(gateway.judgeRequests).toHaveLength(0);
  });

  it("attributes events logged after the final status to the turn until the next step starts", async () => {
    // Like the intent readout: logged well after the turn delivered.
    gateway.setScripts([{ match: /^late/, run: async (turn) => {
      turn.finish("ok", "Done.");
      setTimeout(() => turn.audit("intent_readout_shadow", { letters: 3 }), 300);
    } }]);
    const lateTurn = { kind: "turn" as const, message: "late events please", expect: { events: { must: [{ type: "intent_readout_shadow" }] } } };
    const echo = { kind: "http" as const, method: "GET" as const, path: "/api/echo/{sessionId}" };

    // A wait extends the window: the event counts for the turn, and the next step runs.
    const waited = await runScenario(loaded({ id: "late-waited", title: "Late event, waited for", group: "core", steps: [lateTurn, { kind: "wait", ms: 700 }, echo] }), deps(), FAST);
    expect(waited.attempts[0]!.failures).toEqual([]);
    expect(waited.attempts[0]!.steps.map((step) => step.kind)).toEqual(["turn", "wait", "http"]);
    expect(waited.attempts[0]!.steps[0]!.turn!.eventTypeCounts["intent_readout_shadow"]).toBe(1);
    expect(waited.attempts[0]!.steps[0]!.turn!.eventWindowMs).toBeGreaterThanOrEqual(600);

    // The next step closes the window at once (after the settle time): the event comes too late,
    // the turn fails, and the step after it never runs.
    const echoes = gateway.httpPaths.filter((path) => path.startsWith("GET /api/echo/")).length;
    const hurried = await runScenario(loaded({ id: "late-hurried", title: "Late event, not waited for", group: "core", steps: [lateTurn, echo] }), deps(), FAST);
    expect(hurried.attempts[0]!.failures).toEqual(["step 1 turn: events.must intent_readout_shadow: expected ≥1, saw 0"]);
    expect(hurried.attempts[0]!.steps).toHaveLength(1);
    expect(gateway.httpPaths.filter((path) => path.startsWith("GET /api/echo/")).length).toBe(echoes);

    // After the last step, the window stays open for the grace period past the final status.
    const last = loaded({ id: "late-last", title: "Late event after the last step", group: "core", steps: [lateTurn] });
    expect((await runScenario(last, deps(), { ...FAST, eventGraceMs: 900 })).attempts[0]!.failures).toEqual([]);
    expect((await runScenario(last, deps(), { ...FAST, eventGraceMs: 50 })).attempts[0]!.failures)
      .toEqual(["step 1 turn: events.must intent_readout_shadow: expected ≥1, saw 0"]);
  });

  it("fails a turn that ends in a different status, by default expecting ok", async () => {
    gateway.setScripts([{ match: /^broken/, run: async (turn) => turn.finish("error", "", { error: "Error: provider exploded" }) }]);
    const scenario: E2EScenario = { id: "fake-error", title: "Fake error turn", group: "core", steps: [{ kind: "turn", message: "broken please" }] };
    const result = await runScenario(loaded(scenario), deps(), FAST);
    expect(result.attempts[0]!.failures).toEqual(["step 1 turn: status: expected ok, saw error (Error: provider exploded)"]);
  });

  it("fires a during steer on an audit event of the running turn, with the turn's request id", async () => {
    const scenario: E2EScenario = {
      id: "fake-steer",
      title: "Fake mid-turn steer",
      group: "new",
      steps: [{
        kind: "turn",
        message: "steer me while you write",
        during: [{ when: { event: { type: "sub_agent_started", where: { "data.agentName": "content_writer" } } }, do: { steer: "Use bullet points" } }],
        expect: {
          events: { must: [{ type: "sub_agent_steering_injected", where: { "data.agentName": "content_writer" } }] },
          reply: { includes: ["use bullet points"] },
        },
      }],
    };
    const result = await runScenario(loaded(scenario), deps(), FAST);
    expect(result.attempts[0]!.failures).toEqual([]);
    const turn = result.attempts[0]!.steps[0]!.turn!;
    expect(turn.during).toHaveLength(1);
    expect(turn.during[0]).toMatchObject({ fired: true, ok: true, action: "steer", trigger: "on sub_agent_started{data.agentName=content_writer}" });
    expect(gateway.steers.at(-1)).toMatchObject({ sessionId: result.attempts[0]!.sessions[0], message: "Use bullet points", requestId: turn.requestId });
    expect(gateway.steers.at(-1)?.clientMessageId).toMatch(/^e2e-[0-9a-f-]{36}$/);
  });

  it("fails a during action whose trigger never fired, naming the trigger", async () => {
    const scenario: E2EScenario = {
      id: "fake-steer-missed",
      title: "Fake steer that never fires",
      group: "new",
      steps: [{
        ...helloTurn,
        during: [{ when: { event: { type: "sub_agent_started", where: { "data.agentName": "coder" } } }, do: { stop: true } }],
      }],
    };
    const result = await runScenario(loaded(scenario), deps(), FAST);
    expect(result.attempts[0]!.failures).toEqual(['step 1 turn "greet": during[0] (on sub_agent_started{data.agentName=coder}): never fired before the turn ended']);
  });

  it("cancels a turn that outlives its timeout, and one that outlives the attempt", async () => {
    const turnTimeout: E2EScenario = {
      id: "fake-hang",
      title: "Fake hanging turn",
      group: "guards",
      steps: [{ kind: "turn", message: "hang forever", timeoutMs: 300 }],
    };
    const first = await runScenario(loaded(turnTimeout), deps(), FAST);
    const firstTurn = first.attempts[0]!.steps[0]!.turn!;
    expect(first.attempts[0]!.failures).toEqual(["step 1 turn: turn timed out after 300 ms (chat.cancel: cancelled=true, final status error)"]);
    expect(firstTurn.status).toBe("timeout");
    expect(firstTurn.cancel).toEqual({ cancelled: true, known: true, finalStatus: "error" });
    expect(gateway.cancels).toContain(firstTurn.requestId);

    const attemptTimeout: E2EScenario = {
      id: "fake-hang-attempt",
      title: "Fake attempt deadline",
      group: "guards",
      timeoutMs: 400,
      steps: [{ kind: "turn", message: "hang until the attempt ends" }, { kind: "wait", ms: 10 }],
    };
    const second = await runScenario(loaded(attemptTimeout), deps(), FAST);
    const secondTurn = second.attempts[0]!.steps[0]!.turn!;
    expect(second.attempts[0]!.failures).toEqual(["step 1 turn: attempt timed out after 400 ms while this turn ran (chat.cancel: cancelled=true, final status error)"]);
    expect(second.attempts[0]!.steps).toHaveLength(1);
    expect(gateway.cancels).toContain(secondTurn.requestId);
  });

  it("empties the attempt identity's durable memory before each attempt, when attempts run one at a time", async () => {
    // What a scenario stores is in every later turn's prompt: the memory scenario's German fact
    // pulled a later English question's reply into German (2026-10-07).
    gateway.remember("eval", "user", "favorite_tea");
    gateway.remember("eval", "workspace", "project_note");
    gateway.remember("eval-viewer", "user", "viewer_note");
    const scenario: E2EScenario = { id: "fake-reset", title: "Reset", group: "core", steps: [{ ...helloTurn }] };
    const reset = await runScenario(loaded(scenario), deps(), FAST);
    expect(gateway.memoryKeys("eval", "user")).toEqual([]);
    expect(gateway.memoryKeys("eval", "workspace")).toEqual([]);
    expect(reset.attempts[0]!.notes).toEqual([]);
    // Only the attempt's own identity.
    expect(gateway.memoryKeys("eval-viewer", "user")).toEqual(["viewer_note"]);

    // Attempts that run at once share the account: no reset.
    gateway.remember("eval", "user", "favorite_tea");
    await runScenario(loaded(scenario), deps(), { ...FAST, concurrency: 2 });
    expect(gateway.memoryKeys("eval", "user")).toEqual(["favorite_tea"]);
    // ...and none when switched off.
    await runScenario(loaded(scenario), deps(), { ...FAST, resetDurableMemory: false });
    expect(gateway.memoryKeys("eval", "user")).toEqual(["favorite_tea"]);
  });

  it("deletes only the eval account's own memory: not with auth off, not as another account, not in a shared store", async () => {
    // The memory routes resolve the caller's stores from the request context; without a user in
    // it they fall back to the shared single-operator stores, and a delete cannot be undone.
    const scenario: E2EScenario = { id: "fake-reset-own", title: "Reset own memory only", group: "core", steps: [{ ...helloTurn }] };
    gateway.remember("shared", "user", "operator_pref");
    gateway.remember("shared", "workspace", "operator_decision");

    // Auth switched off during a run: the cached token still verifies, every store is the shared one.
    gateway.authEnabled = false;
    const authOff = await runScenario(loaded(scenario), deps(), FAST);
    gateway.authEnabled = true;
    expect(gateway.memoryKeys("shared", "user")).toEqual(["operator_pref"]);
    expect(gateway.memoryKeys("shared", "workspace")).toEqual(["operator_decision"]);
    expect(authOff.attempts[0]!.notes).toEqual([
      "memory reset skipped: the gateway runs with auth off, so every account's memory is the shared single-operator store",
    ]);

    // A credentials file that maps the identity "eval" to another account of the deployment.
    gateway.remember("alice", "user", "alice_pref");
    const mapped = new GatewayClient({
      baseUrl: gateway.url,
      credentials: { ...credentials(), eval: { username: "alice", password: PASSWORDS.alice } },
      rpcTimeoutMs: 5_000,
      connectTimeoutMs: 5_000,
    });
    try {
      const otherAccount = await runScenario(loaded(scenario), deps({ client: mapped }), FAST);
      expect(gateway.memoryKeys("alice", "user")).toEqual(["alice_pref"]);
      expect(otherAccount.attempts[0]!.notes).toEqual(['memory reset skipped: eval logs in as account "alice", not as its eval account "eval"']);
    } finally {
      mapped.close();
    }

    // A gateway that keeps workspace memory in one store for every account (the routes before
    // 5fc9a8e): eval's own user memory goes, the shared workspace store stays.
    gateway.sharedWorkspace = true;
    gateway.remember("eval", "user", "favorite_tea");
    const shared = await runScenario(loaded(scenario), deps(), FAST);
    expect(gateway.memoryKeys("eval", "user")).toEqual([]);
    expect(gateway.memoryKeys("shared", "workspace")).toEqual(["operator_decision"]);
    expect(shared.attempts[0]!.notes).toEqual([
      "memory reset: eval's workspace memory left as it is: eval-viewer lists the same entries, so the gateway keeps that scope in one shared store",
    ]);
  });

  it("leaves a scope alone when nothing shows it is the eval account's own: no other eval account, its listing failed, an entry without an id", async () => {
    // Only another eval account's listing tells a shared store apart (a gateway older than 5fc9a8e
    // keeps workspace memory in one store for every account), so without it the reset proves
    // nothing, and a delete there takes the operator's memory for good.
    const scenario: E2EScenario = { id: "fake-reset-unproven", title: "Reset without proof", group: "core", steps: [{ ...helloTurn }] };
    gateway.sharedWorkspace = true;
    gateway.remember("shared", "workspace", "operator_decision");

    // A credentials file with eval alone (written by hand, or eval-viewer taken out).
    gateway.remember("eval", "user", "favorite_tea");
    const alone = new GatewayClient({ baseUrl: gateway.url, credentials: { eval: credentials()["eval"]! }, rpcTimeoutMs: 5_000, connectTimeoutMs: 5_000 });
    try {
      const evalOnly = await runScenario(loaded(scenario), deps({ client: alone }), FAST);
      expect(evalOnly.attempts[0]!.notes).toEqual([
        "memory reset: eval's user memory left as it is: cannot tell whether it is eval's own (no other eval account to compare with)",
        "memory reset: eval's workspace memory left as it is: cannot tell whether it is eval's own (no other eval account to compare with)",
      ]);
    } finally {
      alone.close();
    }
    expect(gateway.memoryKeys("shared", "workspace")).toEqual(["operator_decision"]);
    expect(gateway.memoryKeys("eval", "user")).toEqual(["favorite_tea"]);

    // eval-viewer's listing fails: no answer is no proof.
    gateway.memory.delete("eval:user");
    gateway.memoryListingFailures.set("eval-viewer", 500);
    const unlisted = await runScenario(loaded(scenario), deps(), FAST);
    expect(unlisted.attempts[0]!.notes).toEqual([
      "memory reset: eval's workspace memory left as it is: cannot tell whether it is eval's own (eval-viewer's listing answered HTTP 500)",
    ]);
    expect(gateway.memoryKeys("shared", "workspace")).toEqual(["operator_decision"]);

    // An entry listed without an id cannot be compared with another account's entries.
    gateway.memoryListingFailures.clear();
    gateway.sharedWorkspace = false;
    gateway.remember("eval", "user", "favorite_tea");
    gateway.remember("eval", "user", "legacy_note", "legacy_note", { withoutId: true });
    const idless = await runScenario(loaded(scenario), deps(), FAST);
    expect(idless.attempts[0]!.notes).toEqual([
      "memory reset: eval's user memory left as it is: cannot tell whether it is eval's own (an entry without an id)",
    ]);
    expect(gateway.memoryKeys("eval", "user")).toEqual(["favorite_tea", "legacy_note"]);
  });

  it("says what the reset left: entries the gateway refused to delete, a listing that failed; and empties more than one page", async () => {
    // eval-viewer is a viewer, and every mutating route is operator-only: its memory stays.
    const viewerScenario: E2EScenario = { id: "fake-reset-viewer", title: "Reset as the viewer", group: "core", identity: "eval-viewer", steps: [{ ...helloTurn }] };
    gateway.remember("eval-viewer", "user", "viewer_note");
    gateway.remember("eval-viewer", "workspace", "viewer_draft");
    const deletesBefore = gateway.httpPaths.filter((path) => path.startsWith("DELETE /api/memory/entries/")).length;
    const viewer = await runScenario(loaded(viewerScenario), deps(), FAST);
    expect(gateway.memoryKeys("eval-viewer", "user")).toEqual(["viewer_note"]);
    expect(viewer.attempts[0]!.notes).toEqual([
      "memory reset: 1 entry of eval-viewer's user memory not deleted (HTTP 403)",
      "memory reset: 1 entry of eval-viewer's workspace memory not deleted (HTTP 403)",
    ]);
    // A 403 is the role's answer: the other entries are not tried.
    expect(gateway.httpPaths.filter((path) => path.startsWith("DELETE /api/memory/entries/")).length - deletesBefore).toBe(1);

    const scenario: E2EScenario = { id: "fake-reset-report", title: "Reset reports", group: "core", steps: [{ ...helloTurn }] };
    gateway.memoryListingStatus = 500;
    const unlisted = await runScenario(loaded(scenario), deps(), FAST);
    gateway.memoryListingStatus = null;
    expect(unlisted.attempts[0]!.notes).toEqual([
      "memory reset: eval's user memory could not be listed (HTTP 500)",
      "memory reset: eval's workspace memory could not be listed (HTTP 500)",
    ]);

    // One listing holds at most 500 entries: the reset lists again until nothing is left.
    for (let index = 0; index < 501; index += 1) gateway.remember("eval", "user", `fact_${index}`);
    const paged = await runScenario(loaded(scenario), deps(), FAST);
    expect(gateway.memoryKeys("eval", "user")).toEqual([]);
    expect(paged.attempts[0]!.notes).toEqual([]);
  });

  it("leaves the memory alone while a turn it stopped may still run on the account, and resets again once it ended", async () => {
    // A turn that outlives chat.cancel (no final status within the grace) and stores memory after
    // its attempt ended: a reset before the next attempt would race it.
    let finishLingering: (() => void) | undefined;
    gateway.setScripts([
      { match: /^linger/, run: async (turn) => {
        await turn.cancelled;
        gateway.remember("eval", "user", "late_fact");
        await new Promise<void>((resolveFinish) => { finishLingering = resolveFinish; });
        turn.finish("ok", "Done after all.");
      } },
      { match: /^hello/i, run: helloScript },
    ]);
    const options: RunnerOptions = { ...FAST, cancelGraceMs: 300 };
    const lingering: E2EScenario = { id: "fake-linger", title: "A turn that outlives its cancel", group: "guards", steps: [{ kind: "turn", message: "linger after the cancel", timeoutMs: 200 }] };
    const scenario: E2EScenario = { id: "fake-after-linger", title: "The next attempt", group: "core", steps: [{ ...helloTurn }] };
    const stopped = await runScenario(loaded(lingering), deps(), options);
    const requestId = stopped.attempts[0]!.steps[0]!.turn!.requestId;
    expect(stopped.attempts[0]!.steps[0]!.turn!.cancel).toEqual({ cancelled: true, known: true });

    const next = await runScenario(loaded(scenario), deps(), options);
    expect(next.attempts[0]!.notes).toEqual([`memory reset skipped: turn ${requestId} of eval was stopped earlier and has not been seen to end`]);
    expect(gateway.memoryKeys("eval", "user")).toEqual(["late_fact"]);

    finishLingering?.();
    const later = await runScenario(loaded(scenario), deps(), options);
    expect(later.attempts[0]!.notes).toEqual([]);
    expect(gateway.memoryKeys("eval", "user")).toEqual([]);
  });

  it("waits the same way for a turn whose socket died, mid-turn or during the send, and learns from session.get that it ended", async () => {
    // Such a turn's final status goes to the dead socket, so only session.get can tell the harness
    // it ended; until it does, what the turn stores after a reset lands in the next attempt.
    const options: RunnerOptions = { ...FAST, cancelGraceMs: 300 };
    const next: E2EScenario = { id: "fake-after-drop", title: "The next attempt", group: "core", steps: [{ ...helloTurn }] };
    const held = (onStart: (turn: TurnContext) => Promise<void>) => {
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolveRelease) => { release = resolveRelease; });
      let markStored: () => void = () => undefined;
      const stored = new Promise<void>((resolveStored) => { markStored = resolveStored; });
      const run: TurnScript = async (turn) => {
        await onStart(turn);
        gateway.remember(turn.user, "user", "late_fact");
        markStored();
        await released;
        turn.finish("ok", "Done after all.");
      };
      return { run, stored, release: () => release() };
    };

    for (const drop of ["mid-turn", "send"] as const) {
      // Mid-turn: every socket drops 50 ms in (a rotated secret, a gateway restart behind a proxy),
      // and the harness stops the turn from a new connection. During the send: the gateway took the
      // turn, and the socket died before chat.send was answered.
      const turn = held(async (running) => {
        if (drop !== "mid-turn") return;
        setTimeout(() => gateway.revokeTokens(), 50);
        await running.cancelled;
      });
      gateway.setScripts([{ match: /^drop/, run: turn.run }, { match: /^hello/i, run: helloScript }]);
      gateway.dropSocketOnNextSend = drop === "send";
      const dropped = await runScenario(loaded({ id: `fake-drop-${drop}`, title: `Socket dies (${drop})`, group: "guards", steps: [{ kind: "turn", message: `drop the socket (${drop})` }] }), deps(), options);
      expect(dropped.attempts[0]!.outcome, drop).toBe("error");
      const requestId = String(gateway.chatSends.at(-1)!["requestId"]);
      // The gateway keeps a turn running when its socket closes: the harness stops it from a new one.
      expect(gateway.cancels, drop).toContain(requestId);
      expect(dropped.attempts[0]!.failures[0], drop).toMatch(/; chat\.cancel from a new connection: cancelled=true$/);
      await turn.stored;

      const blocked = await runScenario(loaded(next), deps(), options);
      expect(blocked.attempts[0]!.notes, drop).toEqual([`memory reset skipped: turn ${requestId} of eval was stopped earlier and has not been seen to end`]);
      expect(gateway.memoryKeys("eval", "user"), drop).toEqual(["late_fact"]);

      turn.release();
      const after = await runScenario(loaded(next), deps(), options);
      expect(after.attempts[0]!.notes, drop).toEqual([]);
      expect(gateway.memoryKeys("eval", "user"), drop).toEqual([]);
    }
  });

  it("stops waiting for a turn an earlier run left once the gateway has restarted since its send, also when its session is gone", async () => {
    // A wipe restarts the gateway and takes the session: session.get answers with an error, which
    // confirms nothing, and the turn held back every reset of its account in every later run.
    const options: RunnerOptions = { ...FAST, cancelGraceMs: 300 };
    adoptUnconfirmedTurns(client, [{ identity: "eval", requestId: "e2e-before-the-wipe", sessionId: "sess-wiped", sentAt: Date.now() - 60_000 }]);
    gateway.remember("eval", "user", "favorite_tea");
    const scenario: E2EScenario = { id: "fake-after-wipe", title: "After a wipe", group: "core", steps: [{ ...helloTurn }] };
    const waiting = await runScenario(loaded(scenario), deps(), options);
    expect(waiting.attempts[0]!.notes).toEqual(["memory reset skipped: turn e2e-before-the-wipe of eval was stopped earlier and has not been seen to end"]);
    expect(gateway.memoryKeys("eval", "user")).toEqual(["favorite_tea"]);

    gateway.startedAt = Date.now();
    const restarted = await runScenario(loaded(scenario), deps(), options);
    expect(restarted.attempts[0]!.notes).toEqual([]);
    expect(gateway.memoryKeys("eval", "user")).toEqual([]);
    expect(unconfirmedTurnsOf(client)).toEqual([]);
  });

  it("tracks no turn for a send the gateway refused", async () => {
    // No turn started: tracked, it would hold a reset back until session.get or a restart said so.
    gateway.refuseNextSend = true;
    const refused = await runScenario(loaded({ id: "fake-refused-send", title: "A refused send", group: "guards", steps: [{ ...helloTurn }] }), deps(), FAST);
    expect(refused.attempts[0]!.failures).toEqual(['step 1 turn "greet": chat.send failed: chat.send: Error: chat.send refused']);
    expect(unconfirmedTurnsOf(client)).toEqual([]);
  });

  it("runs a turn with `as` as that identity, in its own session, beside the scenario identity's", async () => {
    gateway.setScripts([{ match: /^whoami/, run: async (turn) => turn.finish("ok", `I am ${turn.user}`) }]);
    const scenario: E2EScenario = {
      id: "fake-as-turn",
      title: "A turn as another identity",
      group: "core",
      steps: [
        { kind: "turn", id: "own", message: "whoami first", expect: { reply: { includes: ["I am eval"] } } },
        { kind: "turn", id: "other", as: "eval-viewer", message: "whoami as the viewer", expect: { reply: { includes: ["I am eval-viewer"] } } },
        { kind: "turn", id: "own-again", message: "whoami again", expect: { reply: { includes: ["I am eval"] } } },
        // {sessionId} stays the scenario identity's session.
        { kind: "http", method: "GET", path: "/api/echo/{sessionId}", expect: { bodyIncludes: ['"user":"eval"'] } },
      ],
    };
    // The other identity's memory is reset before the attempt like the scenario identity's.
    gateway.remember("eval-viewer", "user", "viewer_note");
    const result = await runScenario(loaded(scenario), deps(), FAST);
    const attempt = result.attempts[0]!;
    expect(attempt.failures).toEqual([]);
    const [own, other, ownAgain] = attempt.steps.map((step) => step.turn?.sessionId);
    expect(ownAgain).toBe(own);
    expect(other).not.toBe(own);
    expect(attempt.sessions).toEqual([own, other]);
    expect(attempt.steps[3]!.http?.path).toBe(`/api/echo/${own}`);
    expect(attempt.notes).toEqual(["memory reset: 1 entry of eval-viewer's user memory not deleted (HTTP 403)"]);
  });

  it("checks that eval-viewer cannot recall eval's preference with that preference in place, whatever ran before", async () => {
    // The isolation scenario passed without testing anything when the memory scenario had not run
    // just before it (--id, --tag isolation): every eval attempt empties eval's memory first.
    const paths = resolveE2EPaths();
    const { selected } = filterScenarios(loadScenarios(paths.scenariosDir, paths.fixturesDir).scenarios, { tags: ["isolation"] });
    expect(selected.map((entry) => entry.scenario.id)).toEqual(["core-ix-memory-viewer-isolation"]);
    const store: TurnScript = async (turn) => {
      turn.audit("tool_call_requested", { tool: "memory_store", args: { scope: "user" } });
      gateway.remember(turn.user, "user", "lieblingstee", "Lieblingsteesorte: Polarstern-Rooibos");
      turn.audit("tool_call_completed", { tool: "memory_store", success: true });
      turn.finish("ok", "Gemerkt.");
    };
    const recall = (partition: "leaks" | "holds"): TurnScript => async (turn) => {
      const stores = partition === "leaks" ? [...gateway.memory.values()] : [gateway.memory.get(`${turn.user}:user`)];
      const known = stores.flatMap((entries) => [...(entries?.values() ?? [])].map((entry) => entry.content));
      turn.finish("ok", known.length > 0 ? `Gespeichert ist: ${known.join("; ")}` : "Dazu habe ich nichts über dich gespeichert.");
    };

    gateway.setScripts([{ match: /merke dir/i, run: store }, { match: /Teesorte/i, run: recall("leaks") }]);
    const leaking = await runScenarios(selected, deps(), FAST);
    expect(leaking[0]!.status).toBe("failed");
    expect(leaking[0]!.attempts[0]!.failures).toEqual(['step 2 turn "ask-other-account": reply.excludes "Polarstern": found']);

    gateway.setScripts([{ match: /merke dir/i, run: store }, { match: /Teesorte/i, run: recall("holds") }]);
    const holding = await runScenarios(selected, deps(), FAST);
    expect(holding[0]!.attempts[0]!.failures).toEqual([]);
    expect(holding[0]!.status).toBe("passed");

    // The remember turn answers without storing: the viewer has nothing to leak, so a pass would
    // prove nothing. The store must complete, or the attempt fails right there.
    gateway.setScripts([{ match: /merke dir/i, run: async (turn) => turn.finish("ok", "Gemerkt.") }, { match: /Teesorte/i, run: recall("leaks") }]);
    const unstored = await runScenarios(selected, deps(), FAST);
    expect(unstored[0]!.status).toBe("failed");
    expect(unstored[0]!.attempts[0]!.failures).toEqual([
      'step 1 turn "remember": events.must tool_call_completed{data.tool in [memory_store, user_model_update]}: expected ≥1, saw 0',
    ]);
  });

  it("empties the identity's user model before the attempt's first turn, which recall_context serves", async () => {
    // The memory scenario accepts user_model_update as the store: a model left from an earlier run
    // could answer its recall turn on its own.
    gateway.userModels.set("eval", { workingStyle: ["Lieblingsteesorte: Polarstern-Rooibos"] });
    gateway.userModels.set("eval-viewer", { goals: ["Teesorten kennenlernen"] });
    const scenario: E2EScenario = { id: "fake-reset-model", title: "Reset the user model", group: "core", steps: [{ ...helloTurn }] };
    const start = gateway.sequence.length;
    const result = await runScenario(loaded(scenario), deps(), FAST);
    expect(result.attempts[0]!.notes).toEqual([]);
    expect(gateway.userModels.has("eval")).toBe(false);
    const sequence = gateway.sequence.slice(start);
    expect(sequence.indexOf("POST /api/user-model/reset")).toBeGreaterThanOrEqual(0);
    expect(sequence.indexOf("POST /api/user-model/reset")).toBeLessThan(sequence.indexOf("chat.send"));
    // Only the attempt's own identity.
    expect(gateway.userModels.get("eval-viewer")).toEqual({ goals: ["Teesorten kennenlernen"] });

    // The viewer may not reset it (operator-only, like every mutating route): noted. An empty model
    // is not reset at all.
    const viewerScenario: E2EScenario = { id: "fake-reset-model-viewer", title: "Reset as the viewer", group: "core", identity: "eval-viewer", steps: [{ ...helloTurn }] };
    expect((await runScenario(loaded(viewerScenario), deps(), FAST)).attempts[0]!.notes).toEqual(["memory reset: eval-viewer's user model not emptied (HTTP 403)"]);
    const resets = gateway.sequence.filter((entry) => entry === "POST /api/user-model/reset").length;
    await runScenario(loaded(scenario), deps(), FAST);
    expect(gateway.sequence.filter((entry) => entry === "POST /api/user-model/reset").length).toBe(resets);
  });

  it("skips — never fails — a scenario whose required service is down", async () => {
    const port = await closedPort();
    const mail = new GreenMailAdapter({ apiBase: `http://127.0.0.1:${port}` });
    const prober = new ServiceProber({ gatewayUrl: gateway.url, authedGet: (path) => client.http("eval", "GET", path), mail, siteUrl: `http://127.0.0.1:${port}` });
    const sends = gateway.chatSends.length;
    const scenarios: E2EScenario[] = [
      { id: "needs-mail", title: "Needs the mailbox", group: "core", steps: [{ kind: "mail", action: "clear" }, { ...helloTurn }] },
      { id: "needs-site", title: "Needs the e2e site", group: "core", requires: ["e2e-site"], steps: [{ ...helloTurn }] },
      { id: "needs-engram", title: "Needs engram", group: "core", requires: ["engram"], steps: [{ ...helloTurn }] },
    ];
    const results = await runScenarios(scenarios.map(loaded), deps({ prober, mail }), FAST);
    expect(results.map((result) => result.status)).toEqual(["skipped", "skipped", "skipped"]);
    expect(results[0]!.skipReason).toMatch(/^mail down \(GreenMail API unreachable at http:\/\/127\.0\.0\.1:\d+/);
    expect(results[1]!.skipReason).toMatch(/^e2e-site down \(e2e site unreachable at http:\/\/127\.0\.0\.1:\d+/);
    // "ok" to the gateway, but the feature is off: down for a scenario that needs it.
    expect(results[2]!.skipReason).toBe("engram down (engram: ok — not configured (RAG enhancement off))");
    expect(gateway.chatSends.length).toBe(sends);

    gateway.healthy = false;
    const gatewayDown = await runScenario(loaded(scenarios[1]!), deps(), FAST);
    expect(gatewayDown.status).toBe("skipped");
    expect(gatewayDown.skipReason).toContain("gateway down (GET /healthz → 503)");

    const report = buildReport(results, {
      startedAt: "2026-10-07T10:00:00.000Z", finishedAt: "2026-10-07T10:00:01.000Z", gatewayUrl: gateway.url,
      repeat: 1, concurrency: 1, filters: { groups: [], tags: [], ids: [] }, judge: null, mail: null,
    });
    expect(report.summary).toMatchObject({ skipped: 3, run: 0, failed: 0 });
    expect(report.environment.suspect).toBe(true);
  });

  it("gates mail and the site on the e2e environment's own readiness check", async () => {
    const site = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolveListen) => site.listen(0, "127.0.0.1", resolveListen));
    const siteUrl = `http://127.0.0.1:${(site.address() as net.AddressInfo).port}`;
    const mailUp: MailAdapter = {
      name: "fake",
      inbox: "eval@e2e.test",
      deliver: async () => undefined,
      list: async () => [],
      clear: async () => undefined,
      probe: async () => ({ up: true, detail: "GreenMail ready" }),
    };
    const status = {
      ready: { mail: false, site: true },
      services: { "e2e-mail": { state: "running", health: "healthy" }, "e2e-site": { state: "running", health: "healthy" } },
      hostEndpoints: { mailApi: { up: true }, site: { up: true } },
      config: { mailOverlay: "config/mail/accounts.d/e2e.json5", compiledAllowsSite: true },
      mailService: { evalAccountLoaded: true, otherAccountsVisibleToEval: 2 },
      gateway: { imageSupportsAllowlist: true, resolvesSite: "172.18.0.9" },
    };
    const probe = (environment: ServiceProbeContext["environment"]) => new ServiceProber({
      gatewayUrl: gateway.url,
      authedGet: (path) => client.http("eval", "GET", path),
      mail: mailUp,
      siteUrl,
      ...(environment ? { environment } : {}),
    }).check(["mail", "e2e-site"]);
    try {
      const [mail, siteState] = await probe(async () => interpretEnvironmentStatus(status));
      // A turn could read a real mailbox while another account is visible to eval: never run.
      expect(mail).toEqual({ service: "mail", up: false, detail: "e2e environment not ready for mail: mailbox isolation unverified: 2 other account(s) visible to eval" });
      expect(siteState).toMatchObject({ service: "e2e-site", up: true });

      const [unverifiedMail, unverifiedSite] = await probe(async () => ({ error: "docker not found" }));
      expect(unverifiedMail).toEqual({ service: "mail", up: false, detail: "cannot verify the eval mailbox and its isolation: docker not found" });
      expect(unverifiedSite?.up).toBe(true);
      expect(unverifiedSite?.detail).toContain("environment not verified: docker not found");

      const [readyMail] = await probe(async () => interpretEnvironmentStatus({ ...status, ready: { mail: true, site: true }, mailService: { evalAccountLoaded: true, otherAccountsVisibleToEval: 0 } }));
      expect(readyMail).toEqual({ service: "mail", up: true, detail: "GreenMail ready; eval mailbox loaded and isolated" });
      expect(environmentStatusFromScript(scratch)).toBeNull();
    } finally {
      await new Promise<void>((resolveClose) => site.close(() => resolveClose()));
    }
  });

  it("judges a reply with a configured judge, and fails closed on a malformed judge answer", async () => {
    const scenario: E2EScenario = {
      id: "fake-judged",
      title: "Fake judged reply",
      group: "core",
      steps: [{ ...helloTurn, expect: { judge: { rubric: "The reply must state that the answer is 42.", minScore: 7 } } }],
    };
    const judge = { url: `${gateway.url}/v1`, model: "fake-judge" };
    const passing = await runScenario(loaded(scenario), deps({ judge }), FAST);
    expect(passing.attempts[0]!.failures).toEqual([]);
    expect(passing.attempts[0]!.steps[0]!.turn!.judge).toEqual({ minScore: 7, score: 9 });
    expect(gateway.judgeRequests.at(-1)).toMatchObject({ model: "fake-judge", temperature: 0 });

    gateway.judgeAnswer = "SCORE: 4";
    const low = await runScenario(loaded(scenario), deps({ judge }), FAST);
    expect(low.attempts[0]!.failures).toEqual(['step 1 turn "greet": judge: score 4 < minScore 7']);

    gateway.judgeAnswer = "Looks right to me. SCORE: 9";
    const malformed = await runScenario(loaded(scenario), deps({ judge }), FAST);
    expect(malformed.attempts[0]!.failures).toEqual([
      'step 1 turn "greet": judge: malformed answer "Looks right to me. SCORE: 9" (expected one line "SCORE: <0-10>")',
    ]);
  });

  it("uploads fixture attachments and sends them as chat.send attachments", async () => {
    const scenario: E2EScenario = {
      id: "fake-attach",
      title: "Fake attachment",
      group: "core",
      steps: [{ kind: "turn", message: "summarize the notes", attachments: ["notes.md"] }],
    };
    const result = await runScenario(loaded(scenario), deps(), FAST);
    expect(result.attempts[0]!.failures).toEqual([]);
    const sessionId = result.attempts[0]!.sessions[0]!;
    expect(gateway.chatSends.at(-1)).toMatchObject({
      message: "summarize the notes",
      displayContent: "📎 notes.md\nsummarize the notes",
      attachments: [{ filename: "notes.md", relativePath: `uploads/${sessionId}/1-notes.md`, contentType: "text/markdown", previewMode: "download" }],
    });
  });

  it("logs in again when the gateway refuses a cached token on the socket", async () => {
    const first = await client.connection("eval");
    const logins = gateway.logins;
    gateway.revokeTokens();
    for (let waited = 0; first.isOpen() && waited < 2_000; waited += 20) await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    expect(first.isOpen()).toBe(false);
    const second = await client.connection("eval");
    expect(second).not.toBe(first);
    expect(gateway.logins).toBe(logins + 1);
    expect(await second.createSession("eval")).toMatch(/^sess-\d+$/);
  });

  it("logs in with the credentials file and refuses without leaking a password", async () => {
    const file = join(scratch, "creds.local.json");
    writeFileSync(file, JSON.stringify(credentials()));
    expect(readCredentialsFile(file)["eval-viewer"]?.username).toBe("eval-viewer");

    // V8's message for this one quotes the text around the error — the password.
    writeFileSync(file, '{"eval": {"username": "eval", "password": hunter2-secret-value}}');
    expect(() => readCredentialsFile(file)).toThrow(E2EInfraError);
    try {
      readCredentialsFile(file);
    } catch (err) {
      expect(String(err)).not.toContain("hunter2");
    }

    const wrong = new GatewayClient({ baseUrl: gateway.url, credentials: { eval: { username: "eval", password: "hunter2-wrong-password" } } });
    const failure = await wrong.token("eval").catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(E2EInfraError);
    expect(String(failure)).toContain('login as "eval" (eval) failed: HTTP 401');
    expect(String(failure)).not.toContain("hunter2");
    wrong.close();
  });
});

describe("e2e harness — loader", () => {
  const scenariosDir = join(scratch, "scenarios");

  beforeAll(() => {
    mkdirSync(join(scenariosDir, "family"), { recursive: true });
    const valid = (id: string, extra: Record<string, unknown> = {}) => JSON.stringify({ id, title: `Scenario ${id}`, group: "core", steps: [{ kind: "turn", message: "hi" }], ...extra });
    writeFileSync(join(scenariosDir, "valid.jsonc"), `// a comment\n${valid("valid-one", { tags: ["smoke"] })}`);
    writeFileSync(join(scenariosDir, "_template.jsonc"), valid("template-one"));
    writeFileSync(join(scenariosDir, "family", "many.jsonc"), `[${valid("many-a", { group: "family" })}, ${valid("many-b", { group: "family", tags: ["smoke"] })}]`);
    writeFileSync(join(scenariosDir, "bad.jsonc"), JSON.stringify({ id: "Bad Id", title: "x", group: "core", steps: [] }));
    writeFileSync(join(scenariosDir, "extra.jsonc"), valid("extra-key", { foo: 1 }));
    writeFileSync(join(scenariosDir, "zz-dup.jsonc"), valid("valid-one"));
    writeFileSync(join(scenariosDir, "syntax.jsonc"), "{ id: 'broken', ");
    writeFileSync(join(scenariosDir, "semantic.jsonc"), JSON.stringify({
      id: "semantic-issues",
      title: "Semantic issues",
      group: "core",
      steps: [
        { kind: "turn", message: "x", attachments: ["missing.txt", "../escape.txt"], expect: { reply: { matches: ["("], minChars: 10, maxChars: 5 }, events: { must: [{ type: "a", min: 3, max: 1, where: { "data.x": { regex: "[" } } }] } } },
        { kind: "http", method: "GET", path: "/api/x/{session}" },
        { kind: "mail", action: "deliver" },
        { kind: "mail", action: "clear", match: { subjectIncludes: ["x"] } },
      ],
    }));
  });

  it("reports every invalid file precisely and loads the valid ones", () => {
    const { scenarios, issues } = loadScenarios(scenariosDir, fixturesDir);
    const messages = issues.map((issue) => `${issue.file}: ${issue.message}`);
    expect(scenarios.map((entry) => entry.scenario.id).sort()).toEqual(["many-a", "many-b", "template-one", "valid-one"]);
    expect(messages).toEqual(expect.arrayContaining([
      "bad.jsonc: Bad Id: id: Invalid",
      "bad.jsonc: Bad Id: title: String must contain at least 3 character(s)",
      "bad.jsonc: Bad Id: steps: Array must contain at least 1 element(s)",
      "extra.jsonc: extra-key: (root): Unrecognized key(s) in object: 'foo'",
      'zz-dup.jsonc: duplicate id "valid-one" (first defined in valid.jsonc)',
      expect.stringMatching(/^syntax\.jsonc: not valid JSON5: /),
      'semantic.jsonc: semantic-issues: steps[0] (turn): attachment "missing.txt" not found in eval/e2e/fixtures/',
      'semantic.jsonc: semantic-issues: steps[0] (turn): attachment "../escape.txt" must be a path inside eval/e2e/fixtures/',
      expect.stringMatching(/^semantic\.jsonc: semantic-issues: steps\[0\] \(turn\) expect\.reply\.matches: \/\(\/ does not compile/),
      "semantic.jsonc: semantic-issues: steps[0] (turn): expect.reply.minChars 10 > maxChars 5",
      expect.stringMatching(/^semantic\.jsonc: semantic-issues: steps\[0\] \(turn\) expect\.events\.must\[0\]: where\.data\.x regex \/\[\/ does not compile/),
      "semantic.jsonc: semantic-issues: steps[0] (turn) expect.events.must[0] a: min 3 > max 1",
      "semantic.jsonc: semantic-issues: steps[1] (http): unknown placeholder {session} in path (only {sessionId})",
      "semantic.jsonc: semantic-issues: steps[2] (mail): deliver needs a message {from, subject, text}",
      "semantic.jsonc: semantic-issues: steps[3] (mail): match is only for expect",
    ]));
  });

  it("filters by group, tag and id; templates run only when named", () => {
    const { scenarios } = loadScenarios(scenariosDir, fixturesDir);
    const ids = (filter: Parameters<typeof filterScenarios>[1]) => filterScenarios(scenarios, filter).selected.map((entry) => entry.scenario.id).sort();
    expect(ids({})).toEqual(["many-a", "many-b", "valid-one"]);
    expect(ids({ groups: ["family"] })).toEqual(["many-a", "many-b"]);
    expect(ids({ tags: ["smoke"] })).toEqual(["many-b", "valid-one"]);
    expect(ids({ groups: ["family"], tags: ["smoke"] })).toEqual(["many-b"]);
    expect(ids({ ids: ["template-one"] })).toEqual(["template-one"]);
    expect(filterScenarios(scenarios, { ids: ["nope"] }).unknownIds).toEqual(["nope"]);
  });
});

describe("e2e harness — setup (temp config only)", () => {
  const root = join(scratch, "setup");
  const configDir = join(root, "config");
  const workspaceDir = join(root, "workspace");
  const credentialsPath = join(root, "eval", "e2e", ".credentials.local.json");
  const env = { SAI_CONFIG_PATH: configDir, SAI_WORKSPACE_CONFIG_PATH: workspaceDir };
  const builds: string[] = [];
  const build = async (repoRoot: string): Promise<void> => {
    builds.push(repoRoot);
  };

  beforeEach(() => {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(configDir, "gateway"), { recursive: true });
    mkdirSync(join(workspaceDir, "agents"), { recursive: true });
    writeFileSync(join(configDir, "gateway", "30-auth.jsonc"), "// the person's own auth shard: no users\n{ auth: { enabled: true, provider: 'oidc' } }\n");
    writeFileSync(join(workspaceDir, "agents", "10-agents.jsonc"), "{ subAgents: {} }\n");
    builds.length = 0;
  });

  function setupPaths() {
    // The real repo root: the temp config dir is not its config/, so `sai config build` is never run.
    const { paths } = resolveSetupPaths(findRepoRoot(), credentialsPath, env);
    expect(paths.configDir).toBe(configDir);
    expect(paths.canBuild).toBe(false);
    return paths;
  }

  it("refuses — writing nothing — while another shard or the runtime overlay defines auth.users", async () => {
    const shard = join(configDir, "gateway", "25-users.jsonc");
    writeFileSync(shard, JSON.stringify({ auth: { users: [{ username: "alice", passwordHash: "$2b$12$abcdefghijklmnopqrstuuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0", role: "operator" }] } }));
    const paths = setupPaths();
    const failure = await runE2ESetup({ paths, build }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(SetupRefusedError);
    expect(String((failure as Error).message)).toContain("25-users.jsonc defines auth.users (1 account(s))");
    expect(existsSync(paths.shardPath)).toBe(false);
    expect(existsSync(credentialsPath)).toBe(false);
    expect(existsSync(paths.mailIsolationPath)).toBe(false);
    expect(builds).toEqual([]);

    // An empty list merging AFTER the e2e shard would erase it; one before it is harmless.
    writeFileSync(shard, JSON.stringify({ auth: { users: [] } }));
    writeFileSync(join(workspaceDir, "agents", "90-late.jsonc"), JSON.stringify({ auth: { users: [] } }));
    const late = await runE2ESetup({ paths, build }).catch((err: unknown) => err);
    expect(String((late as Error).message)).toContain("sets auth.users to [] after 31-e2e.local.jsonc, which would erase the eval accounts");
    expect(String((late as Error).message)).not.toContain("25-users.jsonc");

    rmSync(join(workspaceDir, "agents", "90-late.jsonc"));
    mkdirSync(join(workspaceDir, "runtime"), { recursive: true });
    writeFileSync(join(workspaceDir, "runtime", "runtime.overrides.json"), JSON.stringify({ auth: { users: [{ username: "bob" }] } }));
    const overlay = await runE2ESetup({ paths, build }).catch((err: unknown) => err);
    expect(String((overlay as Error).message)).toContain("(runtime overrides, laid over every shard) defines auth.users (1 account(s))");
    expect(existsSync(paths.shardPath)).toBe(false);
  });

  it("writes only auth.users with hashed passwords, keeps them on a re-run, and removes them", async () => {
    // The mail-service's own files are not gateway config: accounts there never conflict.
    mkdirSync(join(configDir, "mail"), { recursive: true });
    writeFileSync(join(configDir, "mail", "accounts.json"), JSON.stringify({ auth: { users: [{ username: "not-config" }] }, accounts: [] }));
    const paths = setupPaths();
    expect(paths.mailIsolationPath).toBe(join(configDir, "mail", "accounts.d", "00-e2e-isolation.json5"));
    const logs: string[] = [];
    const created = await runE2ESetup({ paths, build, log: (line) => logs.push(line) });
    expect(created).toMatchObject({ action: "created", built: true });
    expect(builds).toHaveLength(1);

    const shardText = readFileSync(paths.shardPath, "utf8");
    const credentialsText = readFileSync(credentialsPath, "utf8");
    const shard = JSON.parse(shardText.split("\n").filter((line) => !line.startsWith("//")).join("\n")) as { auth: Record<string, unknown> };
    expect(Object.keys(shard)).toEqual(["auth"]);
    expect(Object.keys(shard.auth)).toEqual(["users"]);
    const users = shard.auth["users"] as Array<{ username: string; role: string; passwordHash: string }>;
    expect(users.map((user) => [user.username, user.role])).toEqual([["eval", "operator"], ["eval-viewer", "viewer"]]);
    const stored = JSON.parse(credentialsText) as Record<string, { username: string; password: string }>;
    for (const [identity, user] of [["eval", users[0]!], ["eval-viewer", users[1]!]] as const) {
      const password = stored[identity]!.password;
      expect(password.length).toBeGreaterThanOrEqual(24);
      expect(await bcrypt.compare(password, user.passwordHash)).toBe(true);
      expect(shardText).not.toContain(password);
      expect(logs.join("\n")).not.toContain(password);
    }
    // The mail-service overlay that keeps eval and eval-viewer off every shared mail account.
    const isolationText = readFileSync(paths.mailIsolationPath, "utf8");
    expect(JSON5.parse(isolationText)).toEqual({ accounts: [], isolatedUsers: ["eval", "eval-viewer"] });

    const kept = await runE2ESetup({ paths, build });
    expect(kept.action).toBe("kept");
    expect(readFileSync(paths.shardPath, "utf8")).toBe(shardText);
    expect(readFileSync(credentialsPath, "utf8")).toBe(credentialsText);
    expect(readFileSync(paths.mailIsolationPath, "utf8")).toBe(isolationText);

    // Accounts in place but the isolation gone (or edited): put back on the next run.
    rmSync(paths.mailIsolationPath);
    expect((await runE2ESetup({ paths, build })).action).toBe("kept");
    expect(readFileSync(paths.mailIsolationPath, "utf8")).toBe(isolationText);
    writeFileSync(paths.mailIsolationPath, JSON.stringify({ accounts: [], isolatedUsers: ["eval"] }));
    await runE2ESetup({ paths, build });
    expect(readFileSync(paths.mailIsolationPath, "utf8")).toBe(isolationText);

    const removed = await runE2ESetup({ paths, build, remove: true });
    expect(removed.action).toBe("removed");
    expect(existsSync(paths.shardPath)).toBe(false);
    expect(existsSync(credentialsPath)).toBe(false);
    expect(existsSync(paths.mailIsolationPath)).toBe(false);
    expect(builds).toHaveLength(5);
  });
});

describe("e2e harness — mail step against a fake GreenMail (REST + SMTP)", () => {
  let api: http.Server;
  let smtp: net.Server;
  let mail: MailAdapter;
  const mailboxes = new Map<string, string[]>();

  beforeAll(async () => {
    smtp = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      let inData = false;
      let data = "";
      let recipients: string[] = [];
      socket.write("220 fake ESMTP\r\n");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        for (let index = buffer.indexOf("\r\n"); index !== -1; index = buffer.indexOf("\r\n")) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (inData) {
            if (line === ".") {
              inData = false;
              for (const recipient of recipients) mailboxes.set(recipient, [...(mailboxes.get(recipient) ?? []), data]);
              data = "";
              recipients = [];
              socket.write("250 OK\r\n");
            } else {
              data += `${line.startsWith("..") ? line.slice(1) : line}\r\n`;
            }
            continue;
          }
          const verb = line.slice(0, 4).toUpperCase();
          if (verb === "EHLO") socket.write("250-fake\r\n250 8BITMIME\r\n");
          else if (verb === "RCPT") {
            recipients.push(/<([^>]+)>/.exec(line)?.[1] ?? "");
            socket.write("250 OK\r\n");
          } else if (verb === "DATA") {
            inData = true;
            socket.write("354 go ahead\r\n");
          } else if (verb === "QUIT") {
            socket.end("221 bye\r\n");
          } else socket.write("250 OK\r\n");
        }
      });
    });
    await new Promise<void>((resolveListen) => smtp.listen(0, "127.0.0.1", resolveListen));
    const smtpPort = (smtp.address() as net.AddressInfo).port;
    api = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://fake");
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === "/api/service/readiness") return send(200, { message: "Service running" });
      if (url.pathname === "/api/configuration") return send(200, { serverSetups: [{ protocol: "smtp", port: smtpPort, address: "127.0.0.1" }] });
      if (url.pathname === "/api/mail/purge" && req.method === "POST") {
        mailboxes.clear();
        return send(200, { message: "Purged mails" });
      }
      const list = /^\/api\/user\/([^/]+)\/messages\/INBOX$/.exec(url.pathname);
      if (list) {
        const messages = mailboxes.get(decodeURIComponent(list[1]!));
        if (!messages) return send(400, { message: `User '${decodeURIComponent(list[1]!)}' not found` });
        return send(200, messages.map((raw, index) => ({ uid: String(index + 1), subject: parseMimeMessage(raw).headers["subject"], contentType: "text/plain", mimeMessage: raw })));
      }
      send(404, { message: "not found" });
    });
    await new Promise<void>((resolveListen) => api.listen(0, "127.0.0.1", resolveListen));
    mail = new GreenMailAdapter({ apiBase: `http://127.0.0.1:${(api.address() as net.AddressInfo).port}`, inbox: "eval@e2e.test" });
  });

  afterAll(async () => {
    await new Promise<void>((resolveClose) => api.close(() => resolveClose()));
    await new Promise<void>((resolveClose) => smtp.close(() => resolveClose()));
  });

  it("clears, delivers over SMTP and finds the message by subject and decoded body", async () => {
    mailboxes.set("old@e2e.test", ["Subject: stale\r\n\r\nold"]);
    const scenario: E2EScenario = {
      id: "fake-mail",
      title: "Fake mailbox round trip",
      group: "core",
      steps: [
        { kind: "mail", action: "clear" },
        { kind: "mail", action: "deliver", message: { from: "sender@e2e.test", subject: "Quarterly räport", text: "Grüße — the code word is HERON." } },
        { kind: "mail", action: "expect", match: { subjectIncludes: ["RÄPORT"], bodyIncludes: ["code word is heron", "grüße"], min: 1, max: 1 } },
        { kind: "mail", action: "expect", match: { to: "nobody@e2e.test", min: 0, max: 0 } },
      ],
    };
    const result = await runScenario(loaded(scenario), deps({ mail, prober: new ServiceProber({ gatewayUrl: gateway.url, authedGet: (path) => client.http("eval", "GET", path), mail }) }), { ...FAST, mailWaitMs: 2_000, mailPollMs: 50 });
    expect(result.attempts[0]!.failures).toEqual([]);
    expect(mailboxes.has("old@e2e.test")).toBe(false);
    expect(result.attempts[0]!.steps[2]!.mail).toMatchObject({ action: "expect", recipient: "eval@e2e.test", matched: 1 });

    const missing: E2EScenario = {
      id: "fake-mail-missing",
      title: "Fake mailbox miss",
      group: "core",
      steps: [{ kind: "mail", action: "expect", match: { subjectIncludes: ["invoice"] } }],
    };
    const miss = await runScenario(loaded(missing), deps({ mail, prober: new ServiceProber({ gatewayUrl: gateway.url, authedGet: (path) => client.http("eval", "GET", path), mail }) }), { ...FAST, mailWaitMs: 200, mailPollMs: 50 });
    expect(miss.attempts[0]!.failures).toEqual(['step 1 mail: mail.expect to=eval@e2e.test subject∋"invoice": expected ≥1, saw 0 (1 message(s) in the mailbox: "Quarterly räport")']);
  });
});

describe("e2e harness — pure helpers", () => {
  it("resolves sub-agent and workflow sessions to their chat, whatever the nesting or agent name", () => {
    expect(rootSessionOf("sess-1")).toBe("sess-1");
    expect(rootSessionOf("sub:sess-1:researcher:1700")).toBe("sess-1");
    expect(rootSessionOf("sub:sub:sess-1:researcher:1:summarizer:2")).toBe("sess-1");
    expect(rootSessionOf("workflow:sub:sess-1:researcher:1:deep_dive:0b5e")).toBe("sess-1");
    expect(rootSessionOf("sub:sess-1:ephemeral:quarkstrudel_writer:3")).toBe("sess-1");
    expect(rootSessionOf("sub:a:b:c:agent:1", new Set(["a:b:c"]))).toBe("a:b:c");
  });

  it("tells German from English replies and leaves code out", () => {
    expect(detectReplyLanguage("Hier ist die Zusammenfassung: Das Ergebnis ist gut, und wir können weitermachen.").language).toBe("de");
    expect(detectReplyLanguage("Here is the summary: the result is good and we can move on.").language).toBe("en");
    expect(detectReplyLanguage("```\nthe and is of to\n```\nOK").language).toBe("unknown");
  });

  it("matches event fields by literal, regex, range, list, presence and array element", () => {
    expect(fieldMatches("researcher", "researcher")).toBe(true);
    expect(fieldMatches(1, "1")).toBe(false);
    expect(fieldMatches("sub:x", { regex: "^sub:" })).toBe(true);
    expect(fieldMatches(5, { gte: 5 })).toBe(true);
    expect(fieldMatches("7", { lte: 6 })).toBe(false);
    expect(fieldMatches("b", { in: ["a", "b"] })).toBe(true);
    expect(fieldMatches(undefined, { exists: false })).toBe(true);
    expect(fieldMatches(null, { exists: true })).toBe(true);
    expect(fieldMatches(["web_search", "fetch_url"], "fetch_url")).toBe(true);
  });

  it("counts dispatched tool calls and real runs only", () => {
    const events = [
      { type: "tool_call_requested", sessionId: "s", data: { tool: "delegate_to_agent" } },
      { type: "tool_call_completed", sessionId: "s", data: { tool: "delegate_to_agent" } },
      { type: "tool_call_completed", sessionId: "s", data: { tool: "delegate_to_agent", repeatedIdenticalOutput: true } },
      { type: "tool_call_blocked", sessionId: "s", data: { tool: "send_mail", reason: "not_allowed" } },
      { type: "sub_agent_tool_call", sessionId: "sub:s:r:1", data: { agentName: "r", tool: "web_search", phase: "start", toolCallId: "1" } },
      { type: "sub_agent_tool_call", sessionId: "sub:s:r:1", data: { agentName: "r", tool: "web_search", phase: "done", toolCallId: "1" } },
      { type: "sub_agent_started", sessionId: "sub:s:r:1", data: { agentName: "r" } },
      { type: "sub_agent_started", sessionId: "s", data: { agentName: "r", stage: "discovery_fallback_strip" } },
    ];
    expect(summarizeTools(events)).toEqual({
      calls: { delegate_to_agent: 1, web_search: 1 },
      refused: { send_mail: 1 },
      byAgent: { orchestrator: { delegate_to_agent: 1 }, r: { web_search: 1 } },
    });
    expect(summarizeAgents(events)).toEqual({ r: 1 });
  });

  it("accepts exactly one judge score line", () => {
    expect(parseJudgeScore("SCORE: 8")).toBe(8);
    expect(parseJudgeScore("<think>weighing it</think>\n score: 10 ")).toBe(10);
    expect(parseJudgeScore("SCORE: 11")).toBeNull();
    expect(parseJudgeScore("SCORE: 8\nBecause it is good.")).toBeNull();
    expect(parseJudgeScore("")).toBeNull();
  });

  it("decodes quoted-printable, base64 and multipart message bodies", () => {
    const qp = parseMimeMessage("Subject: =?UTF-8?Q?Gr=C3=BC=C3=9Fe?=\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nSch=C3=B6ne W=\r\noche\r\n");
    expect(qp.headers["subject"]).toBe("Grüße");
    expect(qp.text).toBe("Schöne Woche");
    const multipart = parseMimeMessage([
      "Content-Type: multipart/mixed; boundary=\"b1\"",
      "",
      "--b1",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("plain part").toString("base64"),
      "--b1",
      "Content-Type: application/pdf",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("%PDF binary").toString("base64"),
      "--b1--",
    ].join("\r\n"));
    expect(multipart.text).toBe("plain part");
  });

  it("redacts tokens, hashes and secret fields", () => {
    const text = redactSecrets('{"token":"abc","password":"p","note":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXNpZw","h":"$2b$12$abcdefghijklmnopqrstuuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"}');
    expect(text).toBe('{"token":"[redacted]","password":"[redacted]","note":"[redacted-jwt]","h":"[redacted-hash]"}');
  });

  it("compares a run with a baseline and flags regressions", () => {
    const meta = {
      startedAt: "2026-10-07T10:00:00.000Z", finishedAt: "2026-10-07T10:00:01.000Z", gatewayUrl: "http://x",
      repeat: 2, concurrency: 1, filters: { groups: [], tags: [], ids: [] }, judge: null, mail: null,
    };
    const scenarioResult = (id: string, passCount: number) => ({
      id, title: id, group: "core", tags: [], file: `${id}.jsonc`, status: passCount === 2 ? "passed" as const : "failed" as const,
      services: [], repeat: 2, attempts: [], passCount, passRate: passCount / 2, passAll: passCount === 2, durationMs: 1,
    });
    const baseline = buildReport([scenarioResult("a", 2), scenarioResult("b", 1), scenarioResult("gone", 2)], meta);
    const current = buildReport([scenarioResult("a", 1), scenarioResult("b", 2), scenarioResult("new", 2)], meta);
    const comparison = compareWithBaseline(current, baseline, "baseline.json");
    expect(comparison.regressions.map((delta) => delta.id)).toEqual(["a"]);
    expect(comparison.improvements.map((delta) => delta.id)).toEqual(["b"]);
    expect(comparison.newScenarios).toEqual(["new"]);
    expect(comparison.missingScenarios).toEqual(["gone"]);
  });
});

describe("e2e CLI (in process, against the fake gateway)", () => {
  const cliDir = join(scratch, "cli");
  const credsFile = join(cliDir, "creds.local.json");
  // The run locks of these runs: never the machine's own temp directory.
  const lockDir = join(cliDir, "locks");
  const notRunning = async () => ({ json: { mailService: { running: false } } });

  beforeAll(() => {
    mkdirSync(join(cliDir, "scenarios"), { recursive: true });
    writeFileSync(credsFile, JSON.stringify(credentials()));
    writeFileSync(join(cliDir, "scenarios", "pass.jsonc"), JSON.stringify({ id: "cli-pass", title: "CLI pass", group: "core", steps: [{ kind: "turn", message: "hello from the cli", expect: { reply: { includes: ["42"] } } }] }));
    writeFileSync(join(cliDir, "scenarios", "fail.jsonc"), JSON.stringify({ id: "cli-fail", title: "CLI fail", group: "guards", steps: [{ kind: "turn", message: "hello again", expect: { reply: { includes: ["banana"] } } }] }));
  });

  // A lock one test leaves behind must not refuse the next test's runs.
  beforeEach(() => {
    rmSync(lockDir, { recursive: true, force: true });
    mkdirSync(lockDir, { recursive: true });
  });

  // Only what the run needs: no E2E_* variable of the shell leaks in.
  const cliEnv = (): NodeJS.ProcessEnv => ({ E2E_GATEWAY_URL: gateway.url, E2E_CREDENTIALS_PATH: credsFile, INIT_CWD: cliDir, E2E_EVENT_GRACE_MS: "50" });

  async function cli(argv: string[], extra: Partial<CliIo> = {}): Promise<{ code: number; out: string; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runE2ECli(argv, {
      env: cliEnv(),
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      environment: notRunning,
      lockDir,
      ...extra,
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  }

  it("refuses to run any scenario while eval can see a shared mail account (fail closed)", async () => {
    const sends = gateway.chatSends.length;
    const injected = await cli(["evaluate", "--scenarios", "scenarios", "--out", "refused"], {
      mailIsolation: async () => ({ safe: false, detail: "eval can see 1 shared mail account(s) — rebuild the mail-service image and run pnpm e2e:setup" }),
    });
    expect(injected.code).toBe(2);
    expect(injected.err).toBe("Refusing to run: eval can see 1 shared mail account(s) — rebuild the mail-service image and run pnpm e2e:setup");
    expect(gateway.chatSends.length).toBe(sends);
    expect(existsSync(join(cliDir, "refused"))).toBe(false);

    // The default check reads the environment status: a running mail-service that shows eval two
    // accounts not bound to it — or one that cannot be asked — stops the run too.
    const shared = await cli(["evaluate", "--scenarios", "scenarios"], {
      environment: async () => ({ json: { mailService: { running: true, sharedAccountsVisibleToEval: 2, otherAccountsVisibleToEval: 2 } } }),
    });
    expect(shared.code).toBe(2);
    expect(shared.err).toBe("Refusing to run: eval can see 2 shared mail account(s) — rebuild the mail-service image and run pnpm e2e:setup");
    const unknown = await cli(["evaluate", "--scenarios", "scenarios"], { environment: async () => ({ error: "pnpm e2e:env status --json gave no status (e2e:env: Docker is not reachable)" }) });
    expect(unknown.code).toBe(2);
    expect(unknown.err).toBe("Refusing to run: cannot verify mail isolation: pnpm e2e:env status --json gave no status (e2e:env: Docker is not reachable)");
    expect(gateway.chatSends.length).toBe(sends);
  });

  it("reads the isolation verdict from the mail-service's own answer", async () => {
    expect(mailIsolationVerdict({ mailService: { running: false } })).toEqual({ safe: true, detail: "the mail-service container is not running" });
    expect(mailIsolationVerdict({ mailService: { running: true, sharedAccountsVisibleToEval: 0, otherAccountsVisibleToEval: 0 } })).toEqual({ safe: true, detail: "eval sees no shared mail account" });
    // An account bound to eval is not shared, whatever its id.
    expect(mailIsolationVerdict({ mailService: { running: true, sharedAccountsVisibleToEval: 0, otherAccountsVisibleToEval: 1 } }).safe).toBe(true);
    // An older status without the shared count falls back to the stricter one.
    expect(mailIsolationVerdict({ mailService: { running: true, otherAccountsVisibleToEval: 1 } }).safe).toBe(false);
    expect(mailIsolationVerdict({ mailService: { running: true, sharedAccountsVisibleToEval: null, otherAccountsVisibleToEval: null } }).detail)
      .toBe("cannot verify mail isolation: the mail-service runs, but the accounts it shows eval could not be read");
    expect(mailIsolationVerdict({}).safe).toBe(false);
    expect(await mailIsolationCheck(null)()).toEqual({ safe: false, detail: "cannot verify mail isolation: scripts/e2e-env.mjs not found" });
  });

  it("runs, reports and exits by the result; --id narrows; a baseline flags a regression", async () => {
    const all = await cli(["evaluate", "--scenarios", "scenarios", "--out", "out-1"]);
    expect(all.err).toBe("");
    expect(all.code).toBe(1);
    expect(all.out).toContain("Mail isolation: the mail-service container is not running");
    expect(all.out).toContain("Scenarios: 1 passed, 1 failed, 0 skipped of 2");
    expect(all.out).toMatch(/FAIL cli-fail attempt 1\/1 \([\d.]+ s\): step 1 turn: reply\.includes "banana": not found/);
    const files = readdirSync(join(cliDir, "out-1"));
    expect(files.filter((file) => file.endsWith(".json"))).toHaveLength(1);
    expect(files.filter((file) => file.endsWith(".md"))).toHaveLength(1);
    const reportPath = join(cliDir, "out-1", files.find((file) => file.endsWith(".json"))!);

    const one = await cli(["evaluate", "--scenarios", "scenarios", "--id", "cli-pass", "--out", "out-2"]);
    expect(one.code).toBe(0);
    expect(one.out).toContain("Scenarios: 1 passed, 0 failed, 0 skipped of 1");

    // The same scenario now fails: a regression against the first report.
    gateway.setScripts([{ match: /^hello from the cli/, run: async (turn) => turn.finish("ok", "no number here") }]);
    const regressed = await cli(["evaluate", "--scenarios", "scenarios", "--id", "cli-pass", "--out", "out-3", "--baseline", reportPath]);
    expect(regressed.code).toBe(1);
    expect(regressed.out).toContain("Baseline: 1 regression(s) — cli-pass");
  });

  it("logs in up front as every identity a turn runs as: a refused eval-viewer login stops the run before any turn", async () => {
    // eval-viewer's only use here is a turn's `as`: unchecked, its refused login would fail every
    // attempt the same way, one at a time.
    mkdirSync(join(cliDir, "as-scenarios"), { recursive: true });
    writeFileSync(join(cliDir, "as-scenarios", "as.jsonc"), JSON.stringify({
      id: "cli-as",
      title: "CLI turn as the viewer",
      group: "core",
      steps: [{ kind: "turn", message: "hello from eval" }, { kind: "turn", as: "eval-viewer", message: "hello from the viewer" }],
    }));
    const viewerRefused = join(cliDir, "viewer-refused.local.json");
    writeFileSync(viewerRefused, JSON.stringify({ ...credentials(), "eval-viewer": { username: "eval-viewer", password: "not-the-viewer-password" } }));
    const sends = gateway.chatSends.length;
    const refused = await cli(["evaluate", "--scenarios", "as-scenarios", "--out", "as-refused"], { env: { ...cliEnv(), E2E_CREDENTIALS_PATH: viewerRefused } });
    expect(refused.code).toBe(2);
    expect(refused.err).toContain('login as "eval-viewer" (eval-viewer) failed: HTTP 401');
    expect(gateway.chatSends.length).toBe(sends);
    expect(existsSync(join(cliDir, "as-refused"))).toBe(false);
  });

  it("runs one evaluate at a time per gateway, whatever accounts file: a live run's lock refuses, a dead run's is taken over", async () => {
    // Two runs share the gateway's eval accounts: one's reset before an attempt deleted what the
    // other's memory scenario stored between its two turns, and the concurrency gate sees only its
    // own process. The lock sat beside the credentials file, so a second checkout (with a copy of the
    // file) or another E2E_CREDENTIALS_PATH took a lock of its own against the same gateway.
    const lock = runLockPath(gateway.url, lockDir);
    const port = Number(new URL(gateway.url).port);
    for (const spelling of [`http://localhost:${port}/`, `http://[::1]:${port}`, `http://127.0.0.2:${port}`]) {
      expect(runLockPath(spelling, lockDir), spelling).toBe(lock);
    }
    expect(runLockPath(`http://127.0.0.1:${port + 1}`, lockDir)).not.toBe(lock);
    expect(runLockPath(`http://gateway.example:${port}`, lockDir)).not.toBe(lock);
    // This process stands in for the other run: it is alive.
    writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: "2026-10-08T10:00:00.000Z" }));
    const sends = gateway.chatSends.length;
    const copied = join(cliDir, "other-checkout", "eval", "e2e", ".credentials.local.json");
    mkdirSync(dirname(copied), { recursive: true });
    writeFileSync(copied, JSON.stringify(credentials()));
    const refused = await cli(["evaluate", "--scenarios", "scenarios", "--id", "cli-pass", "--out", "locked"], { env: { ...cliEnv(), E2E_CREDENTIALS_PATH: copied } });
    expect(refused.code).toBe(2);
    expect(refused.err).toBe(`Refusing to run: another e2e run (pid ${process.pid}, since 2026-10-08T10:00:00.000Z) is using the eval accounts, and two runs break each other's scenarios (one's memory reset or mail purge lands in the other's attempts). Wait for it, or delete ${lock} if no such run is left.`);
    expect(gateway.chatSends.length).toBe(sends);
    expect(existsSync(join(cliDir, "locked"))).toBe(false);

    // A lock that cannot be read may be one a starting run is writing this moment: held.
    writeFileSync(lock, "{ not json");
    const unreadable = await cli(["evaluate", "--scenarios", "scenarios", "--id", "cli-pass", "--out", "locked"]);
    expect(unreadable.code).toBe(2);
    expect(unreadable.err).toBe(`Refusing to run: another e2e run is using the eval accounts, and two runs break each other's scenarios (one's memory reset or mail purge lands in the other's attempts). Wait for it, or delete ${lock} if no such run is left.`);
    expect(gateway.chatSends.length).toBe(sends);
    expect(existsSync(join(cliDir, "locked"))).toBe(false);

    // A run that ended without removing its lock (a crash): the lock is taken over.
    const gone = spawnSync(process.execPath, ["-e", ""]).pid;
    writeFileSync(lock, JSON.stringify({ pid: gone, startedAt: "2026-10-08T09:00:00.000Z" }));
    const run = await cli(["evaluate", "--scenarios", "scenarios", "--id", "cli-pass", "--out", "unlocked"]);
    expect(run.code).toBe(0);
    // Released when the run ends.
    expect(existsSync(lock)).toBe(false);
  });

  it("leaves the turns it has not seen end in the lock when it quits, and the next run's reset waits for them", async () => {
    // A second Ctrl+C deleted the lock and quit while the turn the first one stopped was still
    // unwinding; the next run took the lock and reset the account under that turn, which could
    // still store memory into its first attempt.
    const lock = runLockPath(gateway.url, lockDir);
    mkdirSync(join(cliDir, "held-scenarios"), { recursive: true });
    writeFileSync(join(cliDir, "held-scenarios", "hold.jsonc"), JSON.stringify({ id: "cli-hold", title: "CLI held turn", group: "guards", steps: [{ kind: "turn", message: "hold on while I think" }] }));
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolveStarted) => { markStarted = resolveStarted; });
    let markStopped: () => void = () => undefined;
    const stopped = new Promise<void>((resolveStopped) => { markStopped = resolveStopped; });
    let finish: () => void = () => undefined;
    const finished = new Promise<void>((resolveFinished) => { finish = resolveFinished; });
    gateway.setScripts([
      { match: /^hold on/, run: async (turn) => {
        markStarted();
        await turn.cancelled;
        gateway.remember(turn.user, "user", "late_fact");
        markStopped();
        await finished;
        turn.finish("ok", "Done after all.");
      } },
      { match: /^hello/i, run: helloScript },
    ]);
    const keyboard: { ctrlC?: () => void } = {};
    let lockAtExit: unknown = null;
    const interrupts: InterruptHooks = {
      on: (listener) => { keyboard.ctrlC = listener; },
      off: () => { delete keyboard.ctrlC; },
      exit: (code) => {
        lockAtExit = existsSync(lock) ? JSON.parse(readFileSync(lock, "utf8")) : null;
        throw new Error(`exit ${code}`);
      },
    };
    const runner = { cancelGraceMs: 300 };

    const quitting = cli(["evaluate", "--scenarios", "held-scenarios", "--out", "quit"], { interrupts, runner });
    await started;
    const { requestId, sessionId } = gateway.chatSends.at(-1) as { requestId: string; sessionId: string };
    keyboard.ctrlC!();
    await stopped;
    expect(() => keyboard.ctrlC!()).toThrow("exit 130");
    expect(lockAtExit).toMatchObject({ pid: process.pid, ended: expect.any(String), turns: [{ identity: "eval", requestId, sessionId, sentAt: expect.any(Number) }] });
    // Here the process lives on: the run ends without the turn's final status, and leaves it in the
    // lock as well.
    await quitting;
    expect(JSON.parse(readFileSync(lock, "utf8"))).toMatchObject({ ended: expect.any(String), turns: [{ requestId }] });

    const waiting = await cli(["evaluate", "--scenarios", "scenarios", "--id", "cli-pass", "--out", "after-quit"], { runner });
    expect(waiting.code).toBe(0);
    expect(waiting.out).toContain(`An earlier run left 1 turn(s) it had not seen end (${requestId} of eval) in ${lock}`);
    expect(waiting.out).toContain(`memory reset skipped: turn ${requestId} of eval was stopped earlier and has not been seen to end`);
    expect(gateway.memoryKeys("eval", "user")).toEqual(["late_fact"]);

    finish();
    const resetting = await cli(["evaluate", "--scenarios", "scenarios", "--id", "cli-pass", "--out", "after-end"], { runner });
    expect(resetting.code).toBe(0);
    expect(resetting.out).not.toContain("memory reset skipped");
    expect(gateway.memoryKeys("eval", "user")).toEqual([]);
    expect(existsSync(lock)).toBe(false);
  });

  it("exits 2 on usage errors and unknown ids, 1 on invalid scenario files", async () => {
    expect((await cli(["evaluate", "--bogus"])).code).toBe(2);
    expect((await cli(["evaluate", "--scenarios", "scenarios", "--repeat", "0"])).code).toBe(2);
    const unknown = await cli(["evaluate", "--scenarios", "scenarios", "--id", "nope"]);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toBe("No scenario with id nope");
    mkdirSync(join(cliDir, "broken"), { recursive: true });
    writeFileSync(join(cliDir, "broken", "x.jsonc"), "{ id: 'Bad' }");
    const invalid = await cli(["validate", "--scenarios", "broken"]);
    expect(invalid.code).toBe(1);
    expect(invalid.err).toContain("INVALID x.jsonc:");
  });
});
