/**
 * The end-to-end harness's view of a running gateway: login, the WebSocket RPC channel the
 * dashboard uses, the audit stream of the harness's own sessions, turn statuses, mid-turn
 * steering, uploads and authenticated HTTP.
 *
 * Protocol (gateway/rpc.ts, gateway/index.ts):
 *   - POST /api/auth/login {username, password} → {token}
 *   - WS /ws, token in the Authorization header (the gateway also takes ?token=, which would put
 *     it in URLs and logs) → {type:"hello-ok"}; close 4401 = token refused, 4429 = rate-limited
 *   - RPC {id, method, params} → {type:"rpc.response", id, ok, payload | error}
 *   - audit.subscribe → {type:"audit.event", data: AuditEvent} for every session the account
 *     owns, sub-agent runs ("sub:<root>:<agent>:<ts>", nested) and workflows included
 *   - chat.send {sessionId, requestId, message, displayContent?, attachments?, effort?}
 *     → {type:"status", data:{requestId, status}} — "accepted" and mid-turn phases, then one
 *     final "ok" | "error" | "blocked" with `response` (or `error`)
 *   - chat.cancel {requestId} → {cancelled, known}
 *   - POST /api/sessions/:id/steer {message, clientMessageId?, requestId?}
 *   - POST /api/multimodal/persist-attachment (multipart file + sessionId) → {relativePath, ...}
 *
 * Secrets: a password leaves this module only in the login body and a token only in the
 * Authorization header. No error, log line or report field carries either.
 */
import { WebSocket } from "ws";
import { existsSync, readFileSync } from "node:fs";

export const DEFAULT_GATEWAY_URL = "http://localhost:8765";
const DEFAULT_RPC_TIMEOUT_MS = 20_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_HTTP_TIMEOUT_MS = 120_000;
/** Audit events kept per root session; a turn of a busy swarm logs a few thousand at most. */
const MAX_EVENTS_PER_ROOT = 50_000;
/** Root sessions whose events are kept. Events of sessions the harness did not create (an older
 *  run's, the account's other chats) are stored too, because a session's first events arrive
 *  before session.create answers with its id; the oldest unclaimed roots go first. */
const MAX_ROOTS = 2_000;
const MAX_REMEMBERED_STATUSES = 2_000;

export function gatewayUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return (env["E2E_GATEWAY_URL"]?.trim() || DEFAULT_GATEWAY_URL).replace(/\/+$/, "");
}

/** A failure of the harness's environment (gateway down, login refused, socket lost) — not a
 *  verdict on the swarm under test. Attempts that end on one are reported as "error". */
export class E2EInfraError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "E2EInfraError";
  }
}

export interface E2EAccountCredentials {
  username: string;
  password: string;
}

/** eval/e2e/.credentials.local.json: identity → account. Written by `pnpm e2e:setup`. */
export type E2ECredentials = Record<string, E2EAccountCredentials>;

export function readCredentialsFile(path: string): E2ECredentials {
  if (!existsSync(path)) {
    throw new E2EInfraError(`credentials file not found: ${path} — run \`pnpm e2e:setup\` to create the eval accounts`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // Not the parser's message: it quotes the text around the error, which is a password.
    throw new E2EInfraError(`credentials file ${path} is not valid JSON — re-run \`pnpm e2e:setup\``);
  }
  if (!isRecord(parsed)) throw new E2EInfraError(`credentials file ${path} must hold an object of identity → {username, password}`);
  const credentials: E2ECredentials = {};
  for (const [identity, value] of Object.entries(parsed)) {
    const username = isRecord(value) && typeof value["username"] === "string" ? value["username"].trim() : "";
    const password = isRecord(value) && typeof value["password"] === "string" ? value["password"] : "";
    if (!username || !password) {
      throw new E2EInfraError(`credentials file ${path}: identity "${identity}" needs a username and a password — re-run \`pnpm e2e:setup\``);
    }
    credentials[identity] = { username, password };
  }
  return credentials;
}

/** An audit event as the gateway streams it (audit/schema.ts AuditEvent). */
export interface AuditEventLike {
  id?: string;
  timestamp?: string;
  type: string;
  sessionId?: string;
  userId?: string;
  channel?: string;
  severity?: string;
  data: Record<string, unknown>;
}

export interface ReceivedAuditEvent {
  /** Position in this connection's message stream: orders events against turn statuses. */
  seq: number;
  receivedAt: number;
  /** The chat session the event belongs to (sub-agent and workflow sessions resolved). */
  root: string;
  event: AuditEventLike;
}

export type FinalTurnStatus = "ok" | "error" | "blocked";

export interface TurnStatusMessage {
  requestId: string;
  status: FinalTurnStatus;
  /** The reply; "" for an error status. */
  response: string;
  error?: string;
  finishReason?: string;
  /** Mid-turn messages the turn never read (they ride on the final status). */
  unconsumedSteering: number;
  seq: number;
  receivedAt: number;
}

export interface HttpResult {
  status: number;
  ok: boolean;
  text: string;
  /** The parsed body, or undefined when it is not JSON. */
  json: unknown;
}

export interface UploadedAttachment {
  filename: string;
  relativePath: string;
  contentType: string;
  size: number;
}

export interface SteerResult {
  httpStatus: number;
  steered: boolean;
  active: boolean;
  id?: string;
  error?: string;
  activeTurnRequestId?: string;
}

export interface ChatSendParams {
  sessionId: string;
  requestId: string;
  message: string;
  displayContent?: string;
  attachments?: Array<Record<string, unknown>>;
  effort?: string;
}

/**
 * The chat session a session id belongs to. Sub-agent runs are "sub:<parent>:<agent>:<ts>" and
 * workflows "workflow:<parent>:<name>:<id>", nested to any depth, so the root is what remains at
 * the front once every prefix is stripped. A known root is matched first, so a root id holding a
 * colon still resolves; otherwise the root is everything before the first colon (session ids are
 * UUIDs). Agent names may hold colons ("ephemeral:x"), which is why the root is not taken by
 * counting colons from the end.
 */
export function rootSessionOf(sessionId: string, knownRoots?: ReadonlySet<string>): string {
  let current = sessionId;
  for (;;) {
    const prefix = current.startsWith("sub:") ? "sub:" : current.startsWith("workflow:") ? "workflow:" : null;
    if (!prefix) break;
    current = current.slice(prefix.length);
  }
  if (knownRoots && knownRoots.size > 0) {
    if (knownRoots.has(current)) return current;
    const head = current.indexOf(":") === -1 ? current : current.slice(0, current.indexOf(":"));
    if (knownRoots.has(head)) return head;
    for (const root of knownRoots) {
      if (current.startsWith(`${root}:`)) return root;
    }
    return head;
  }
  const colon = current.indexOf(":");
  return colon === -1 ? current : current.slice(0, colon);
}

interface PendingRpc {
  method: string;
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** One authenticated WebSocket to the gateway, subscribed to the account's audit stream. */
export class GatewayConnection {
  private seqCounter = 0;
  private rpcCounter = 0;
  private readonly pending = new Map<string, PendingRpc>();
  private readonly finalStatuses = new Map<string, TurnStatusMessage>();
  private readonly statusWaiters = new Map<string, Set<() => void>>();
  private readonly closeWaiters = new Set<(reason: string) => void>();
  private readonly auditByRoot = new Map<string, ReceivedAuditEvent[]>();
  private readonly auditListeners = new Set<(event: ReceivedAuditEvent) => void>();
  private readonly turnMessageCounts = new Map<string, Record<string, number>>();
  private readonly knownRoots = new Set<string>();
  private droppedEvents = 0;
  private closeReason: string | null = null;
  private helloResolve: (() => void) | null = null;

  private constructor(private readonly ws: WebSocket, private readonly rpcTimeoutMs: number) {}

  static open(
    wsUrl: string,
    token: string,
    opts: { connectTimeoutMs?: number; rpcTimeoutMs?: number } = {},
  ): Promise<GatewayConnection> {
    const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const socket = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${token}` } });
    const connection = new GatewayConnection(socket, opts.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS);
    return new Promise<GatewayConnection>((resolve, reject) => {
      let settled = false;
      const fail = (message: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { socket.terminate(); } catch { /* already gone */ }
        reject(new E2EInfraError(message));
      };
      const timer = setTimeout(() => fail(`gateway WebSocket ${wsUrl}: no hello-ok within ${connectTimeoutMs} ms`), connectTimeoutMs);
      connection.helloResolve = () => {
        if (settled) return;
        clearTimeout(timer);
        // Subscribed before the connection is handed out, so no event of a turn sent on it is missed.
        connection.rpc("audit.subscribe", {}).then(() => {
          if (settled) return;
          settled = true;
          resolve(connection);
        }, (err: unknown) => fail(`audit.subscribe failed: ${describeError(err)}`));
      };
      socket.on("message", (raw: WebSocket.RawData) => connection.handleRaw(raw));
      socket.on("error", (err: Error) => fail(`gateway WebSocket ${wsUrl}: ${err.message}`));
      socket.on("close", (code: number, reason: Buffer) => {
        const why = describeClose(code, reason.toString());
        connection.markClosed(why);
        fail(`gateway WebSocket ${wsUrl} closed before it was ready: ${why}`);
      });
    });
  }

  isOpen(): boolean {
    return this.closeReason === null && this.ws.readyState === WebSocket.OPEN;
  }

  /** The newest message position; events and statuses after a send have a higher one. */
  currentSeq(): number {
    return this.seqCounter;
  }

  /** Events dropped because a root exceeded its buffer (reported, never silent). */
  droppedEventCount(): number {
    return this.droppedEvents;
  }

  /** Marks a session as one the harness drives, so its sub-sessions resolve to it. */
  registerRoot(sessionId: string): void {
    this.knownRoots.add(sessionId);
  }

  onAudit(listener: (event: ReceivedAuditEvent) => void): () => void {
    this.auditListeners.add(listener);
    return () => this.auditListeners.delete(listener);
  }

  /** The root's events with afterSeq < seq ≤ uptoSeq, in arrival order. */
  eventsOf(root: string, afterSeq: number, uptoSeq = Number.POSITIVE_INFINITY): ReceivedAuditEvent[] {
    return (this.auditByRoot.get(root) ?? []).filter((entry) => entry.seq > afterSeq && entry.seq <= uptoSeq);
  }

  /** WS message types received for one turn (agent.chunk, agent.tool_start, …). */
  turnMessageTypeCounts(requestId: string): Record<string, number> {
    return { ...(this.turnMessageCounts.get(requestId) ?? {}) };
  }

  finalStatusOf(requestId: string): TurnStatusMessage | undefined {
    return this.finalStatuses.get(requestId);
  }

  rpc<T = unknown>(method: string, params: Record<string, unknown>, timeoutMs = this.rpcTimeoutMs): Promise<T> {
    if (this.closeReason !== null) {
      return Promise.reject(new E2EInfraError(`${method}: gateway connection is closed (${this.closeReason})`));
    }
    const id = `e2e-rpc-${++this.rpcCounter}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new E2EInfraError(`${method}: no answer within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: (payload) => resolve(payload as T), reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new E2EInfraError(`${method}: send failed (${describeError(err)})`));
      }
    });
  }

  async createSession(channel = "eval"): Promise<string> {
    const payload = await this.rpc<Record<string, unknown>>("session.create", { channel });
    const sessionId = isRecord(payload) && typeof payload["sessionId"] === "string" ? payload["sessionId"] : "";
    if (!sessionId) throw new E2EInfraError("session.create answered without a sessionId");
    this.registerRoot(sessionId);
    return sessionId;
  }

  /** Starts a turn; its final status arrives later (waitForFinalStatus). */
  async sendChat(params: ChatSendParams): Promise<{ accepted: boolean }> {
    const payload = await this.rpc<Record<string, unknown>>("chat.send", {
      sessionId: params.sessionId,
      requestId: params.requestId,
      message: params.message,
      ...(params.displayContent !== undefined ? { displayContent: params.displayContent } : {}),
      ...(params.attachments && params.attachments.length > 0 ? { attachments: params.attachments } : {}),
      ...(params.effort ? { effort: params.effort } : {}),
    });
    return { accepted: isRecord(payload) && payload["accepted"] === true };
  }

  async cancel(requestId: string): Promise<{ cancelled: boolean; known: boolean }> {
    const payload = await this.rpc<Record<string, unknown>>("chat.cancel", { requestId });
    return {
      cancelled: isRecord(payload) && payload["cancelled"] === true,
      known: isRecord(payload) && payload["known"] === true,
    };
  }

  async getSession(sessionId: string): Promise<Record<string, unknown>> {
    const payload = await this.rpc<unknown>("session.get", { sessionId });
    if (!isRecord(payload)) throw new E2EInfraError("session.get answered without a transcript");
    return payload;
  }

  /**
   * The turn's final status: at once when it already arrived, else when it does. "timeout" when
   * none came within timeoutMs, "aborted" when the signal fired first. Rejects when the socket
   * closes, since a status sent to a closed socket is never delivered.
   */
  waitForFinalStatus(requestId: string, timeoutMs: number, signal?: AbortSignal): Promise<TurnStatusMessage | "timeout" | "aborted"> {
    const existing = this.finalStatuses.get(requestId);
    if (existing) return Promise.resolve(existing);
    if (this.closeReason !== null) {
      return Promise.reject(new E2EInfraError(`gateway connection closed before turn ${requestId} ended (${this.closeReason})`));
    }
    if (signal?.aborted) return Promise.resolve("aborted");
    return new Promise((resolve, reject) => {
      const waiters = this.statusWaiters.get(requestId) ?? new Set<() => void>();
      this.statusWaiters.set(requestId, waiters);
      const cleanup = (): void => {
        clearTimeout(timer);
        waiters.delete(onStatus);
        if (waiters.size === 0) this.statusWaiters.delete(requestId);
        this.closeWaiters.delete(onClose);
        signal?.removeEventListener("abort", onAbort);
      };
      const onStatus = (): void => {
        const status = this.finalStatuses.get(requestId);
        if (!status) return;
        cleanup();
        resolve(status);
      };
      const onAbort = (): void => {
        cleanup();
        resolve("aborted");
      };
      const onClose = (reason: string): void => {
        cleanup();
        reject(new E2EInfraError(`gateway connection closed before turn ${requestId} ended (${reason})`));
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve("timeout");
      }, Math.max(0, timeoutMs));
      waiters.add(onStatus);
      this.closeWaiters.add(onClose);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  close(): void {
    this.markClosed("closed by the harness");
    try { this.ws.close(); } catch { /* already closed */ }
  }

  private markClosed(reason: string): void {
    if (this.closeReason !== null) return;
    this.closeReason = reason;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new E2EInfraError(`${pending.method}: gateway connection closed (${reason})`));
      this.pending.delete(id);
    }
    for (const waiter of [...this.closeWaiters]) waiter(reason);
    this.closeWaiters.clear();
  }

  private handleRaw(raw: WebSocket.RawData): void {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw.toString());
      if (!isRecord(parsed)) return;
      message = parsed;
    } catch {
      return;
    }
    const seq = ++this.seqCounter;
    const receivedAt = Date.now();
    const type = typeof message["type"] === "string" ? message["type"] : undefined;

    if (type === "hello-ok") {
      this.helloResolve?.();
      return;
    }
    const id = message["id"];
    if (typeof id === "string" && this.pending.has(id) && type !== "audit.event" && type !== "status") {
      const pending = this.pending.get(id)!;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (message["ok"] === true) pending.resolve(message["payload"]);
      else pending.reject(new Error(`${pending.method}: ${typeof message["error"] === "string" ? message["error"] : "RPC error"}`));
      return;
    }
    if (type === "audit.event") {
      this.takeAuditEvent(message["data"], seq, receivedAt);
      return;
    }
    const data = isRecord(message["data"]) ? message["data"] : undefined;
    const requestId = typeof data?.["requestId"] === "string" ? data["requestId"] : undefined;
    if (!requestId || !type) return;
    this.countTurnMessage(requestId, type);
    if (type === "status" && data) this.takeStatus(requestId, data, seq, receivedAt);
  }

  private takeAuditEvent(raw: unknown, seq: number, receivedAt: number): void {
    if (!isRecord(raw) || typeof raw["type"] !== "string") return;
    const sessionId = typeof raw["sessionId"] === "string" ? raw["sessionId"] : undefined;
    if (!sessionId) return;
    const event: AuditEventLike = {
      ...(typeof raw["id"] === "string" ? { id: raw["id"] } : {}),
      ...(typeof raw["timestamp"] === "string" ? { timestamp: raw["timestamp"] } : {}),
      type: raw["type"],
      sessionId,
      ...(typeof raw["userId"] === "string" ? { userId: raw["userId"] } : {}),
      ...(typeof raw["channel"] === "string" ? { channel: raw["channel"] } : {}),
      ...(typeof raw["severity"] === "string" ? { severity: raw["severity"] } : {}),
      data: isRecord(raw["data"]) ? raw["data"] : {},
    };
    const root = rootSessionOf(sessionId, this.knownRoots);
    const received: ReceivedAuditEvent = { seq, receivedAt, root, event };
    let bucket = this.auditByRoot.get(root);
    if (!bucket) {
      bucket = [];
      this.auditByRoot.set(root, bucket);
      if (this.auditByRoot.size > MAX_ROOTS) this.evictOldestUnclaimedRoot();
    }
    bucket.push(received);
    if (bucket.length > MAX_EVENTS_PER_ROOT) {
      bucket.shift();
      this.droppedEvents += 1;
    }
    for (const listener of [...this.auditListeners]) {
      try { listener(received); } catch { /* a listener's failure is its own */ }
    }
  }

  private evictOldestUnclaimedRoot(): void {
    for (const root of this.auditByRoot.keys()) {
      if (this.knownRoots.has(root)) continue;
      this.auditByRoot.delete(root);
      return;
    }
  }

  private countTurnMessage(requestId: string, type: string): void {
    let counts = this.turnMessageCounts.get(requestId);
    if (!counts) {
      counts = {};
      this.turnMessageCounts.set(requestId, counts);
      if (this.turnMessageCounts.size > MAX_REMEMBERED_STATUSES) {
        const oldest = this.turnMessageCounts.keys().next().value;
        if (oldest !== undefined) this.turnMessageCounts.delete(oldest);
      }
    }
    counts[type] = (counts[type] ?? 0) + 1;
  }

  private takeStatus(requestId: string, data: Record<string, unknown>, seq: number, receivedAt: number): void {
    const status = data["status"];
    if (status !== "ok" && status !== "error" && status !== "blocked") return;
    if (this.finalStatuses.has(requestId)) return;
    const unconsumed = data["unconsumedSteering"];
    this.finalStatuses.set(requestId, {
      requestId,
      status,
      response: typeof data["response"] === "string" ? data["response"] : "",
      ...(typeof data["error"] === "string" ? { error: data["error"] } : {}),
      ...(typeof data["finishReason"] === "string" ? { finishReason: data["finishReason"] } : {}),
      unconsumedSteering: Array.isArray(unconsumed) ? unconsumed.length : 0,
      seq,
      receivedAt,
    });
    if (this.finalStatuses.size > MAX_REMEMBERED_STATUSES) {
      const oldest = this.finalStatuses.keys().next().value;
      if (oldest !== undefined) this.finalStatuses.delete(oldest);
    }
    for (const waiter of [...(this.statusWaiters.get(requestId) ?? [])]) waiter();
  }
}

export interface GatewayClientOptions {
  baseUrl?: string;
  credentials: E2ECredentials;
  rpcTimeoutMs?: number;
  connectTimeoutMs?: number;
  httpTimeoutMs?: number;
}

export interface HttpRequestOptions {
  /** JSON body. */
  body?: unknown;
  /** Multipart body (uploads); wins over `body`. */
  form?: FormData;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Logins, one WebSocket per identity, and authenticated HTTP against one gateway. */
export class GatewayClient {
  readonly baseUrl: string;
  private readonly credentials: E2ECredentials;
  private readonly tokens = new Map<string, Promise<string>>();
  private readonly connections = new Map<string, Promise<GatewayConnection>>();
  private readonly rpcTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly httpTimeoutMs: number;

  constructor(opts: GatewayClientOptions) {
    this.baseUrl = (opts.baseUrl ?? gatewayUrlFromEnv()).replace(/\/+$/, "");
    this.credentials = opts.credentials;
    this.rpcTimeoutMs = opts.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.httpTimeoutMs = opts.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  }

  get wsUrl(): string {
    return `${this.baseUrl.replace(/^http/i, "ws")}/ws`;
  }

  hasIdentity(identity: string): boolean {
    return this.credentials[identity] !== undefined;
  }

  /** A session token for the identity; one login per identity, shared by concurrent callers. */
  token(identity: string): Promise<string> {
    const cached = this.tokens.get(identity);
    if (cached) return cached;
    const pending = this.login(identity);
    this.tokens.set(identity, pending);
    pending.catch(() => this.tokens.delete(identity));
    return pending;
  }

  private async login(identity: string): Promise<string> {
    const account = this.credentials[identity];
    if (!account) {
      throw new E2EInfraError(`no account for identity "${identity}" in the credentials file — run \`pnpm e2e:setup\``);
    }
    let response: Response;
    try {
      response = await fetchWithTimeout(`${this.baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: account.username, password: account.password }),
      }, this.httpTimeoutMs);
    } catch (err) {
      throw new E2EInfraError(`login as "${identity}" failed: gateway unreachable at ${this.baseUrl} (${describeError(err)})`);
    }
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      const hint = response.status === 401
        ? " — the gateway does not know this account: run `pnpm e2e:setup` and let the gateway reload starlingai.json"
        : response.status === 503
          ? " — username/password login is disabled (auth.enabled is not true)"
          : response.status === 429
            ? " — rate-limited after failed logins; wait five minutes"
            : "";
      throw new E2EInfraError(`login as "${identity}" (${account.username}) failed: HTTP ${response.status}${hint}`);
    }
    const body = safeJsonParse(text);
    const token = isRecord(body) && typeof body["token"] === "string" ? body["token"] : "";
    if (!token) throw new E2EInfraError(`login as "${identity}" answered HTTP ${response.status} without a token`);
    return token;
  }

  /** The identity's WebSocket, opened on first use and reopened when it closed. */
  async connection(identity: string): Promise<GatewayConnection> {
    const existing = this.connections.get(identity);
    if (existing) {
      const connection = await existing.catch(() => null);
      if (connection && connection.isOpen()) return connection;
      if (this.connections.get(identity) === existing) this.connections.delete(identity);
    }
    const open = async (): Promise<GatewayConnection> => GatewayConnection.open(this.wsUrl, await this.token(identity), {
      connectTimeoutMs: this.connectTimeoutMs,
      rpcTimeoutMs: this.rpcTimeoutMs,
    });
    const reused = this.tokens.has(identity);
    const opening = (async () => {
      try {
        return await open();
      } catch (err) {
        // A token from an earlier login the gateway no longer takes (expired, secret rotated): log in once more.
        if (!reused || !(err instanceof E2EInfraError) || !err.message.includes("(4401)")) throw err;
        this.tokens.delete(identity);
        return await open();
      }
    })();
    this.connections.set(identity, opening);
    try {
      return await opening;
    } catch (err) {
      if (this.connections.get(identity) === opening) this.connections.delete(identity);
      throw err;
    }
  }

  /**
   * An HTTP request to the gateway, authenticated as the identity (null: no token). A 401 on a
   * token from an earlier login logs in once more and retries, so a run outlasting a token works.
   */
  async http(identity: string | null, method: string, path: string, opts: HttpRequestOptions = {}): Promise<HttpResult> {
    const send = async (token: string | null): Promise<HttpResult> => {
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;
      let body: string | FormData | undefined;
      if (opts.form) body = opts.form;
      else if (opts.body !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(opts.body);
      }
      const response = await fetchWithTimeout(`${this.baseUrl}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) }, opts.timeoutMs ?? this.httpTimeoutMs, opts.signal);
      const text = await response.text();
      return { status: response.status, ok: response.ok, text, json: safeJsonParse(text) };
    };
    try {
      if (identity === null) return await send(null);
      const reused = this.tokens.has(identity);
      const result = await send(await this.token(identity));
      if (result.status !== 401 || !reused) return result;
      this.tokens.delete(identity);
      return await send(await this.token(identity));
    } catch (err) {
      if (err instanceof E2EInfraError) throw err;
      if (opts.signal?.aborted) throw err;
      throw new E2EInfraError(`${method} ${path} failed: ${describeError(err)}`);
    }
  }

  async steer(identity: string, sessionId: string, message: string, opts: { requestId?: string; clientMessageId?: string; signal?: AbortSignal } = {}): Promise<SteerResult> {
    const result = await this.http(identity, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/steer`, {
      body: {
        message,
        ...(opts.clientMessageId ? { clientMessageId: opts.clientMessageId } : {}),
        ...(opts.requestId ? { requestId: opts.requestId } : {}),
      },
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const body = isRecord(result.json) ? result.json : {};
    const error = typeof body["error"] === "string" ? body["error"] : !result.ok ? `HTTP ${result.status}` : undefined;
    return {
      httpStatus: result.status,
      steered: result.ok && body["steered"] === true,
      active: body["active"] === true,
      ...(typeof body["id"] === "string" ? { id: body["id"] } : {}),
      ...(error ? { error } : {}),
      ...(typeof body["activeTurnRequestId"] === "string" ? { activeTurnRequestId: body["activeTurnRequestId"] } : {}),
    };
  }

  /** Stores a file in the session's uploads/ the way the web client does before it sends it. */
  async uploadAttachment(
    identity: string,
    sessionId: string,
    file: { path: string; filename: string; contentType: string },
    signal?: AbortSignal,
  ): Promise<UploadedAttachment> {
    const bytes = new Uint8Array(readFileSync(file.path));
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: file.contentType }), file.filename);
    form.append("sessionId", sessionId);
    const result = await this.http(identity, "POST", "/api/multimodal/persist-attachment", { form, ...(signal ? { signal } : {}) });
    const body = isRecord(result.json) ? result.json : {};
    if (!result.ok || typeof body["relativePath"] !== "string") {
      throw new Error(`upload of ${file.filename} failed: HTTP ${result.status}${typeof body["error"] === "string" ? ` (${body["error"]})` : ""}`);
    }
    return {
      filename: typeof body["filename"] === "string" ? body["filename"] : file.filename,
      relativePath: body["relativePath"],
      contentType: typeof body["contentType"] === "string" ? body["contentType"] : file.contentType,
      size: typeof body["size"] === "number" ? body["size"] : bytes.length,
    };
  }

  /** The vision analysis the web client inlines into a message for an attached image. */
  async analyzeImage(identity: string, file: { path: string; filename: string; contentType: string }, signal?: AbortSignal): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(readFileSync(file.path))], { type: file.contentType }), file.filename);
    const result = await this.http(identity, "POST", "/api/multimodal/analyze-image", { form, ...(signal ? { signal } : {}) });
    const body = isRecord(result.json) ? result.json : {};
    if (!result.ok || typeof body["analysis"] !== "string" || !body["analysis"]) {
      throw new Error(`image analysis of ${file.filename} failed: HTTP ${result.status}${typeof body["error"] === "string" ? ` (${body["error"]})` : ""}`);
    }
    return body["analysis"];
  }

  close(): void {
    for (const pending of this.connections.values()) {
      void pending.then((connection) => connection.close(), () => undefined);
    }
    this.connections.clear();
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
  return fetch(url, { ...init, signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
}

function describeClose(code: number, reason: string): string {
  if (code === 4401) return "token refused by the gateway (4401)";
  if (code === 4429) return "rate-limited after failed logins (4429)";
  return `code ${code}${reason ? ` ${reason}` : ""}`;
}

export function describeError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError") return "timed out";
    const cause = (err as { cause?: unknown }).cause;
    const causeText = cause instanceof Error && cause.message && cause.message !== err.message ? ` (${cause.message})` : "";
    return `${err.message}${causeText}`;
  }
  return String(err);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function safeJsonParse(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
