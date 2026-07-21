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
import { runSubAgentWithStats } from "../agent/sub-agent.js";
import { verifyToken, extractBearerToken } from "../gateway/auth.js";
import { verifyInboundA2aToken } from "../gateway/oidc.js";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";
import { PRODUCT } from "../product/index.js";
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
/** Resolved caller (JWT sub / shared-bearer) that submitted each task, kept OFF the
 *  wire A2ATask so tasks/get can enforce per-caller ownership without leaking it. */
const _taskOwners = new Map<string, string>();
const TASK_RETENTION_MS = 30 * 60_000;

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
      case "tasks/send":
        result = await handleTasksSend(rpc.params as A2ATasksSendParams, caller);
        break;
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
        if (owner !== undefined && owner !== caller) {
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

async function handleTasksSend(params: A2ATasksSendParams, caller: string): Promise<A2ATask> {
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
  _taskOwners.set(taskId, caller);
  scheduleTaskExpiry(taskId);

  try {
    const run = await runSubAgentWithStats({
      agentName,
      task: userText,
      context,
      parentSessionId: sessionId,
      workspacePath: config.workspacePath,
      // Scope per-user resource guards (mail/credentials/compute) to the caller. A
      // machine "shared-bearer" caller carries no user identity, so it is correctly
      // denied user-restricted resources while still reaching shared ones.
      userId: caller === "anonymous" ? undefined : caller,
    });

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
    _tasks.set(taskId, finalTask);
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
    _tasks.set(taskId, failed);
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

interface AuthResult { ok: boolean; caller: string }

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
  if (verified) return { ok: true, caller: (verified as { sub?: string }).sub ?? "authenticated" };

  // OIDC A2A: accept a PEER's IdP token, validated against the issuer's JWKS
  // (signature + issuer + configured audience). Lets us trust other agents that
  // authenticate against the same identity provider.
  if (config.auth.provider === "oidc" && config.auth.oidc?.a2a.enabled) {
    const claims = await verifyInboundA2aToken(token);
    if (claims) return { ok: true, caller: typeof claims.sub === "string" ? claims.sub : "a2a-oidc" };
  }
  return { ok: false, caller: "anonymous" };
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
