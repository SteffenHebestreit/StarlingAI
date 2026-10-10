/**
 * A2A server — exposes locally-defined sub-agents via the public A2A
 * protocol so cross-vendor agents (LangGraph, CrewAI, Vertex, …) can call
 * us the same way they call any other A2A peer.
 *
 *   GET  /.well-known/agent-card.json   — discovery
 *   POST /a2a/v1                        — JSON-RPC 2.0 (tasks/send, tasks/get)
 *
 * Auth: bearer.  `a2a.inboundBearerToken` overrides; otherwise the same
 * gateway JWT used for `/api/*` is accepted.  Tier policy is identical to
 * federation — the peer's tools/agents stay on the peer's side; we run
 * the requested sub-agent inside our own `runSubAgentWithStats` runner so
 * humanInLoopSteps + tier gates apply unmodified.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { timingSafeEqual } from "node:crypto";

import { getConfig } from "../config/loader.js";
import { runSubAgentWithStats, type SubAgentRunOptions } from "../agent/sub-agent.js";
import { authenticatedUser, callerIdentity, verifyToken, extractBearerToken, type AuthenticatedUser } from "../gateway/auth.js";
import { verifyInboundA2aToken } from "../gateway/oidc.js";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";
import { PRODUCT } from "../product/index.js";
import { ownsRecord, principalIdentity } from "../runtime/user-scope.js";
import { ACCOUNT_ID_RE, principalSegment, sameAccountId, type Identity } from "../runtime/accounts.js";
import { registerAccountBindingTeardown } from "../gateway/account-connections.js";
import { runWithRequestContext } from "../runtime/request-context.js";
import { userWorkspaceRoot } from "../tools/workspace-path.js";
import {
  A2A_ERROR,
  A2A_PROTOCOL_VERSION,
  type A2AAgentCard,
  type A2AAgentSkill,
  type A2AJsonRpcRequest,
  type A2AJsonRpcResponse,
  type A2ATask,
  type A2ATasksSendParams,
} from "./protocol.js";

const log = childLogger("a2a:server");

/** In-memory task store.  Single-node by design — federation/A2A clients hit one instance. */
const _tasks = new Map<string, A2ATask>();
/** Resolved caller (JWT sub / shared-bearer) that submitted each task, with the identity it ran
 *  as, kept OFF the wire A2ATask so tasks/get can enforce per-caller ownership without leaking it. */
const _taskOwners = new Map<string, { caller: string; identity?: Identity }>();
const TASK_RETENTION_MS = 30 * 60_000;

/**
 * Forget every task an account submitted, once the account is deleted or retired. Its tasks/get
 * calls are refused already, but each task kept its output and history in memory for the retention
 * window. The task goes with its owner: a task left without an owner record would be readable by any
 * caller (tasks/get checks only a recorded owner).
 */
export function forgetA2ATasksOfAccount(account: string): number {
  let forgotten = 0;
  for (const [taskId, owner] of _taskOwners) {
    if (owner.identity?.account === undefined || !sameAccountId(owner.identity.account, account)) continue;
    _tasks.delete(taskId);
    _taskOwners.delete(taskId);
    forgotten += 1;
  }
  return forgotten;
}
registerAccountBindingTeardown("a2aTasks", (account) => forgetA2ATasksOfAccount(account));

/**
 * Stores a task's outcome, unless its owner record is gone: the account that submitted it ended
 * while it ran, or its retention ran out first. Stored without an owner, the outcome would be
 * readable by any caller that knew the id.
 */
function storeTaskWhileOwned(taskId: string, task: A2ATask): void {
  if (_taskOwners.has(taskId)) _tasks.set(taskId, task);
}

/** Match a path against the A2A surface; returns true when handled. */
export async function handleA2ARequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/.well-known/agent-card.json") {
    return handleAgentCardRequest(req, res);
  }
  if (req.method === "POST" && pathname === "/a2a/v1") {
    return handleJsonRpcRequest(req, res);
  }
  return false;
}

function handleAgentCardRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const config = getConfig();
  if (!config.a2a.enabled) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "A2A is disabled" }));
    return true;
  }

  const card = buildAgentCard(req);
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Cache-Control": "no-cache",
  });
  res.end(JSON.stringify(card));
  return true;
}

async function handleJsonRpcRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const config = getConfig();
  if (!config.a2a.enabled) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "A2A is disabled" }));
    return true;
  }

  const authResult = await authorizeInbound(req);
  if (!authResult.ok) {
    logAudit("a2a_request_failed", { reason: "unauthorized" }, { severity: "warn" });
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: A2A_ERROR.UNAUTHORIZED, id: null }));
    return true;
  }

  let body: string;
  try {
    body = await readBody(req, config.gateway.maxBodyBytes);
  } catch (err) {
    const tooLarge = err instanceof BodyTooLargeError;
    logAudit("a2a_request_failed", { reason: tooLarge ? "body_too_large" : "body_read_error" }, { severity: "warn" });
    res.writeHead(tooLarge ? 413 : 400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      jsonrpc: "2.0",
      error: tooLarge ? { code: -32600, message: "Request body too large" } : A2A_ERROR.PARSE,
      id: null,
    }));
    return true;
  }
  let rpc: A2AJsonRpcRequest;
  try {
    rpc = JSON.parse(body) as A2AJsonRpcRequest;
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: A2A_ERROR.PARSE, id: null }));
    return true;
  }

  const id = rpc.id ?? null;
  const caller = authResult.caller;

  logAudit("a2a_request_received", { method: rpc.method, caller, rpcId: id });

  try {
    let result: unknown;
    switch (rpc.method) {
      case "tasks/send": {
        const params = rpc.params as A2ATasksSendParams;
        // Under multi-user auth a sessionId must be a string. The body is parsed JSON, and a
        // non-string one was used as the task's session id as it came and as its string inside the
        // caller's namespace, two different values (found in review, 2026-10-09). With auth off the
        // id is taken as it comes, as before; a null one is no id there and here.
        const rawSessionId: unknown = params?.sessionId;
        if (rawSessionId !== undefined && rawSessionId !== null && typeof rawSessionId !== "string" && getConfig().auth?.enabled === true) {
          logAudit("a2a_request_failed", { method: rpc.method, caller, reason: "session_id_not_a_string" }, { severity: "warn" });
          return respondError(res, id, A2A_ERROR.INVALID_PARAMS);
        }
        result = await handleTasksSend(params, caller, authResult.user);
        break;
      }
      case "tasks/get": {
        const params = rpc.params as { id?: string };
        if (!params?.id) {
          return respondError(res, id, A2A_ERROR.INVALID_PARAMS);
        }
        const task = _tasks.get(params.id);
        if (!task) return respondError(res, id, A2A_ERROR.TASK_NOT_FOUND);
        // Per-caller ownership: don't let one authenticated caller read another
        // caller's task output/history by id. Shared-bearer callers all resolve to
        // the same synthetic id, so they still match. Reuse TASK_NOT_FOUND to avoid
        // disclosing that the task exists.
        const owner = _taskOwners.get(params.id);
        if (owner !== undefined && !sameTaskCaller(owner, caller, a2aRunIdentity(caller, authResult.user))) {
          logAudit("a2a_request_failed", { method: "tasks/get", caller, reason: "task_owner_mismatch" }, { severity: "warn" });
          return respondError(res, id, A2A_ERROR.TASK_NOT_FOUND);
        }
        result = task;
        break;
      }
      case "agent/authenticatedExtendedCard":
        result = buildAgentCard(req);
        break;
      default:
        return respondError(res, id, A2A_ERROR.METHOD_NOT_FOUND);
    }
    const ok: A2AJsonRpcResponse = { jsonrpc: "2.0", result, id };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(ok));
    return true;
  } catch (err) {
    log.error({ err, method: rpc.method }, "A2A request threw");
    logAudit("a2a_request_failed", { method: rpc.method, caller, reason: String(err) }, { severity: "warn" });
    res.writeHead(500, { "Content-Type": "application/json" });
    // Don't leak internal error detail to the remote caller; full detail is already
    // captured in the log + audit above.
    res.end(JSON.stringify({
      jsonrpc: "2.0",
      error: A2A_ERROR.INTERNAL,
      id,
    }));
    return true;
  }
}

function respondError(
  res: ServerResponse,
  id: string | number | null,
  err: { code: number; message: string },
): boolean {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: err, id }));
  return true;
}

/** Who a caller's tasks run as, whole: a signed-in account (or a bootstrap token) as itself; the
 *  shared bearer, an identity-provider peer, and any caller with one operator as a peer principal. */
function a2aRunIdentity(caller: string, user: AuthenticatedUser | undefined): Identity | undefined {
  if (user) return callerIdentity(user);
  return caller === "anonymous" ? undefined : principalIdentity(caller, "peer");
}

/**
 * Whether a tasks/get caller is the one that submitted the task. By identity (ownsRecord), not by
 * the caller's name: an account created again under a deleted one's name read the old one's task
 * output and history, and so did a peer whose token `sub` was an account's username. With one
 * operator identities carry no kind and compare by name, as the caller string always did.
 */
function sameTaskCaller(owner: { caller: string; identity?: Identity }, caller: string, identity: Identity | undefined): boolean {
  if (owner.identity || identity) return ownsRecord(identity, owner.identity);
  return owner.caller === caller;
}

/** `user` is the account a gateway token resolved to under multi-user auth (authorizeInbound). */
async function handleTasksSend(params: A2ATasksSendParams, caller: string, user?: AuthenticatedUser): Promise<A2ATask> {
  const config = getConfig();
  if (!params || !params.message?.parts?.[0]?.text) {
    throw new Error("message.parts[0].text is required");
  }

  const agentName = params.agentId ?? "";
  if (!agentName) {
    throw new Error("agentId is required");
  }
  const allowed = config.a2a.exposeAgents;
  if (allowed.length > 0 && !allowed.includes(agentName)) {
    throw new Error(`Agent '${agentName}' is not exposed via A2A`);
  }
  if (!config.subAgents?.[agentName]) {
    throw new Error(`Agent '${agentName}' is not configured`);
  }

  const taskId = params.id ?? randomUUID();
  // A caller-supplied id must not clobber (or reveal) another caller's existing task.
  if (params.id && _tasks.has(taskId)) {
    throw new Error("task id already exists");
  }
  const sessionId = params.sessionId ?? `a2a-in:${randomUUID()}`;
  // Who the task runs as, whole (a2aRunIdentity).
  const runIdentity = a2aRunIdentity(caller, user);
  // The session the run works in. A caller-chosen id was used as it came, so under multi-user auth
  // a caller could name another account's session and the run would read and write its shared
  // facts, peer messages and checkpoints (found in review, 2026-10-08). There it now names a
  // session in the caller's own namespace; the task still reports the id the caller sent.
  const runSessionId = params.sessionId ? callerScopedSessionId(params.sessionId, runIdentity ?? { userId: caller }) : sessionId;
  const userText = params.message.parts.map((p) => p.text).join("\n").trim();
  const context =
    typeof (params.metadata?.["context"]) === "string"
      ? (params.metadata!["context"] as string)
      : undefined;

  const initialTask: A2ATask = {
    id: taskId,
    sessionId,
    status: { state: "working", timestamp: new Date().toISOString() },
    history: [params.message],
  };
  _tasks.set(taskId, initialTask);
  _taskOwners.set(taskId, { caller, ...(runIdentity ? { identity: runIdentity } : {}) });
  scheduleTaskExpiry(taskId);

  try {
    const runOptions: SubAgentRunOptions = {
      agentName,
      task: userText,
      context,
      parentSessionId: runSessionId,
      // The workspace root the run works in. Every task ran in the shared root, so under
      // multi-user auth a memory a caller stored with the default 'workspace' scope was the
      // shared root's, and every other account's Critical Memory, graph inspector and graph_query
      // read it: the storage directory, not the writer, decides a workspace record's tenant
      // (found in review, 2026-10-08). A signed-in account's task now runs in that account's own
      // root, as its chat runs and the legacy /a2a/agents route's do. The shared-bearer machine
      // caller and an OIDC peer are no account of this deployment and keep the shared root.
      workspacePath: user ? userWorkspaceRoot(config.workspacePath, runIdentity) : config.workspacePath,
      // Scope per-user resource guards (mail/credentials/compute) to the caller. A
      // machine "shared-bearer" caller carries no user identity, so it is correctly
      // denied user-restricted resources while still reaching shared ones.
      userId: caller === "anonymous" ? undefined : caller,
      ...(runIdentity ? { identity: runIdentity } : {}),
    };
    // The account on the request context too, which the run's own memory reads and per-user
    // stores take their account from; with no account there, as before.
    const run = user
      ? await runWithRequestContext({ identity: runIdentity }, () => runSubAgentWithStats(runOptions))
      : await runSubAgentWithStats(runOptions);

    const finalTask: A2ATask = {
      id: taskId,
      sessionId,
      status: { state: "completed", timestamp: new Date().toISOString() },
      history: [
        params.message,
        { role: "agent", parts: [{ type: "text", text: run.output }] },
      ],
      artifacts: [{ role: "agent", parts: [{ type: "text", text: run.output }] }],
    };
    storeTaskWhileOwned(taskId, finalTask);
    logAudit("a2a_task_completed", {
      taskId,
      sessionId,
      agentName,
      caller,
      tokens: run.stats.usage.totalTokens,
      iterations: run.stats.iterations,
    });
    return finalTask;
  } catch (err) {
    const failed: A2ATask = {
      id: taskId,
      sessionId,
      status: {
        state: "failed",
        // Generic remote-facing message; full detail stays in the audit log below.
        message: { role: "agent", parts: [{ type: "text", text: "Task failed due to an internal error." }] },
        timestamp: new Date().toISOString(),
      },
      history: [params.message],
    };
    storeTaskWhileOwned(taskId, failed);
    logAudit("a2a_request_failed", {
      taskId,
      sessionId,
      agentName,
      caller,
      reason: String(err),
    }, { severity: "warn" });
    throw err;
  }
}

interface AuthResult {
  ok: boolean;
  caller: string;
  /** The account a gateway token resolved to under multi-user auth; absent for the shared bearer,
   *  an OIDC peer, and with one operator. */
  user?: AuthenticatedUser;
}

async function authorizeInbound(req: IncomingMessage): Promise<AuthResult> {
  const config = getConfig();
  const authHeader = req.headers["authorization"];
  const token = authHeader ? extractBearerToken(authHeader as string) : null;
  if (!token) return { ok: false, caller: "anonymous" };

  // Custom A2A bearer overrides everything when set.
  if (config.a2a.inboundBearerToken) {
    const expected = resolveSecret(config.a2a.inboundBearerToken);
    return constantTimeEquals(token, expected)
      ? { ok: true, caller: "a2a-shared-bearer" }
      : { ok: false, caller: "anonymous" };
  }

  // Otherwise, accept a regular gateway JWT — operators get full access; viewer
  // tokens are accepted (tier policies still apply).
  const verified = await verifyToken(token);
  if (verified) {
    // Under multi-user auth a signed token is only as good as the account behind it. Any
    // unexpired one was accepted here, so a deleted or disabled account kept running tasks for
    // the rest of the token's lifetime (found in review, 2026-10-08). The caller is now resolved
    // against the user store, as on /api, the AG-UI stream and the legacy /a2a/agents route, and a
    // token whose account no longer resolves is refused. With one operator there is no user store
    // and the token's own claims stand, as before.
    if (getConfig().auth?.enabled === true) {
      const user = await authenticatedUser(`Bearer ${token}`);
      return user ? { ok: true, caller: user.username, user } : { ok: false, caller: "anonymous" };
    }
    return { ok: true, caller: (verified as { sub?: string }).sub ?? "authenticated" };
  }

  // OIDC A2A: accept a PEER's IdP token, validated against the issuer's JWKS
  // (signature + issuer + configured audience). Lets us trust other agents that
  // authenticate against the same identity provider.
  if (config.auth.provider === "oidc" && config.auth.oidc?.a2a.enabled) {
    const claims = await verifyInboundA2aToken(token);
    if (claims) return { ok: true, caller: typeof claims.sub === "string" ? claims.sub : "a2a-oidc" };
  }
  return { ok: false, caller: "anonymous" };
}

/**
 * A caller-chosen session id inside the caller's own namespace under multi-user auth; as it came
 * with one operator. A config that cannot be read counts as multi-user. The legacy
 * /a2a/agents/:name route (gateway/index.ts) uses it too, so an id names one session on both.
 *
 * The namespace is the caller's storage segment: an account's id, a principal's segment. It was
 * the segment of the username, so an account deleted and created again under the same name named
 * the old account's A2A sessions; those stay behind, admin-only, under the old segment.
 */
export function callerScopedSessionId(sessionId: string, caller: Identity): string {
  let multiUser = true;
  try {
    multiUser = getConfig().auth?.enabled === true;
  } catch { /* fail closed */ }
  if (!multiUser) return sessionId;
  if (caller.account && !ACCOUNT_ID_RE.test(caller.account)) throw new Error(`'${caller.account}' is not an account id`);
  return `a2a-in:${caller.account ?? principalSegment(caller.userId ?? "anonymous")}:${sessionId}`;
}

function resolveSecret(value: string): string {
  if (value.startsWith("$")) return process.env[value.slice(1)] ?? "";
  return value;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

/** Warn-once guard so the roster notice below doesn't fire on every card fetch. */
let _warnedFullRosterExposed = false;

function buildAgentCard(req: IncomingMessage): A2AAgentCard {
  const config = getConfig();
  const baseUrl = inferPublicUrl(req);
  const curated = config.a2a.exposeAgents.length > 0;
  const agentNames = curated
    ? config.a2a.exposeAgents.filter((n) => config.subAgents[n])
    : Object.keys(config.subAgents ?? {});

  // `exposeAgents: []` means "expose all", which reads like "expose none" — and
  // this card is an UNAUTHENTICATED public discovery surface, so the default
  // publishes every internal sub-agent's name, description and tags to anyone who
  // fetches it. Enabling A2A is a deliberate opt-in (a2a.enabled defaults false),
  // so this stays a warning rather than a behaviour change, but the operator
  // should know the roster is going out.
  if (!curated && agentNames.length > 0 && !_warnedFullRosterExposed) {
    _warnedFullRosterExposed = true;
    log.warn(
      { agentCount: agentNames.length },
      "a2a.exposeAgents is empty — publishing EVERY sub-agent on the public agent card. Set a2a.exposeAgents to curate it.",
    );
    logAudit("a2a_full_roster_exposed", { agentCount: agentNames.length }, { severity: "warn" });
  }

  const skills: A2AAgentSkill[] = agentNames.map((name) => {
    const cfg = config.subAgents[name];
    return {
      id: name,
      name,
      description: cfg?.description ?? `${PRODUCT.name} sub-agent ${name}`,
      tags: cfg?.tags ?? [],
    };
  });

  return {
    name: `${PRODUCT.name} (${config.federation?.instanceId ?? "primary"})`,
    description:
      `${PRODUCT.name} multi-agent swarm exposed via the public A2A protocol.  ` +
      "Each skill maps to a configured sub-agent; tier policies and " +
      "human-in-the-loop gates are enforced server-side.",
    url: `${baseUrl}/a2a/v1`,
    version: "0.7.1",
    protocolVersion: A2A_PROTOCOL_VERSION,
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    authentication: {
      schemes: config.a2a.inboundBearerToken ? ["bearer"] : ["bearer"],
    },
    skills,
  };
}

function inferPublicUrl(req: IncomingMessage): string {
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ?? "http";
  const host = (req.headers["host"] as string | undefined) ?? "localhost";
  return `${proto}://${host}`;
}

class BodyTooLargeError extends Error {
  constructor(public readonly limit: number) {
    super(`request body exceeds ${limit} bytes`);
    this.name = "BodyTooLargeError";
  }
}

/**
 * Read a raw request body with a hard byte cap and error/abort handlers. The
 * earlier version buffered the whole body unbounded with no 'error'/'aborted'
 * listener, so a large body OOM'd the gateway and a mid-stream socket error left
 * the Promise pending forever (this raw-http path bypasses Hono's body-limit
 * middleware). Buffers reject the body before it is fully read; concat-then-decode
 * also avoids per-chunk multi-byte mojibake.
 */
function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new BodyTooLargeError(maxBytes));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
    req.on("aborted", () => reject(new Error("request aborted before body completed")));
  });
}

function scheduleTaskExpiry(taskId: string): void {
  const timer = setTimeout(() => { _tasks.delete(taskId); _taskOwners.delete(taskId); }, TASK_RETENTION_MS);
  timer.unref();
}
