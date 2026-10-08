/**
 * HTTP transport for the outbound MCP server.
 *
 * Mounted at `/mcp` directly on the gateway's raw Node HTTP server (before
 * Hono dispatch) so SSE streams can be held open for the full client session
 * without fighting Hono's request-response model.
 *
 * Auth model:
 *   - When `mcp.expose.http.requireAuth` is true (default), the same JWT
 *     used for `/api/*` is required.  Operators get full access; viewer
 *     tokens are accepted and inherit the read-only RBAC the rest of the
 *     gateway already enforces (Tier 2 calls still pause for approval).
 *     Under multi-user auth the token's account is resolved against the user
 *     store on every request (a removed account gets 401; the role is the
 *     account's live one), its calls run as that account in its own workspace
 *     root, and a session serves only the caller that opened it.
 *   - When false, any caller can hit `/mcp`.  Only acceptable when bound
 *     to a trusted local socket.
 *
 * Session lifecycle:
 *   - `StreamableHTTPServerTransport` issues a session id on the first
 *     POST.  We keep one transport + Server pair per session id and tear
 *     them down on `onclose`.
 *   - DELETE /mcp with the session id forces teardown (per MCP spec).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { randomUUID } from "node:crypto";

import { getConfig } from "../config/loader.js";
import { authenticatedUser, verifyToken, extractBearerToken, normalizeRole, type AuthRole } from "../gateway/auth.js";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";
import { createStarlingMcpServer, type ExposeContext } from "./server.js";

const log = childLogger("mcp:server-http");

interface McpHttpSession {
  transport: StreamableHTTPServerTransport;
  server: Server;
  /** The caller that created the session; under multi-user auth the only one that may use it. */
  caller: string;
  /** What the session's calls run with. Under multi-user auth its role is set again on every
   *  request, to the caller's live one. */
  ctx: ExposeContext;
}

const _sessions = new Map<string, McpHttpSession>();

/**
 * Match the request against the MCP HTTP transport.  Returns true when the
 * request was handled (or rejected) so the gateway router short-circuits
 * before delegating to Hono.
 */
export async function handleMcpHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/mcp") return false;

  const expose = getConfig().mcp.expose;

  if (!expose.enabled || !expose.http.enabled) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "MCP server is disabled" }));
    return true;
  }

  // Auth — JWT from Authorization or the `?token=` query parameter (the
  // streamable HTTP client SDKs vary; both forms are widely supported).
  const multiUser = getConfig().auth?.enabled === true;
  let caller = "anonymous";
  // No-auth (trusted local socket) callers get operator; authed callers get their
  // token's role so the MCP RBAC matches the REST gate (viewers → read-only).
  let role: AuthRole = "operator";
  let userId: string | undefined;
  if (expose.http.requireAuth) {
    const headerToken = req.headers["authorization"]
      ? extractBearerToken(req.headers["authorization"] as string)
      : null;
    const queryToken = url.searchParams.get("token");
    const token = headerToken ?? queryToken;
    const verified = token ? await verifyToken(token) : null;
    // Under multi-user auth a signed token is only as good as the account behind it. Any unexpired
    // one was accepted here and its claims stood, so a deleted or disabled account kept calling
    // tools and agents for the rest of the token's lifetime, and a demoted one kept the operator
    // role its token named (found in review, 2026-10-09). The caller is now resolved against the
    // user store on every request, as on /api, the AG-UI stream and the A2A routes: a token whose
    // account no longer resolves is refused, and the role is the account's live one. With one
    // operator there is no user store and the token's own claims stand, as before.
    const user = verified && multiUser ? await authenticatedUser(`Bearer ${token}`) : null;
    if (!verified || (multiUser && !user)) {
      logAudit("mcp_server_request", {
        method: "auth",
        caller: "anonymous",
        outcome: "rejected",
      }, { severity: "warn" });
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return true;
    }
    if (user) {
      caller = user.username;
      role = user.role;
      userId = user.username;
    } else {
      caller = (verified as { sub?: string }).sub ?? "authenticated";
      role = normalizeRole((verified as { role?: unknown }).role);
    }
  }

  const sessionHeader = req.headers["mcp-session-id"];
  const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;

  // Reuse an existing session when the client sent us a session id.
  // Otherwise, only initialize-style POSTs (and the bootstrap GET that some
  // clients issue) are allowed to mint a new session.
  let session = sessionId ? _sessions.get(sessionId) : undefined;

  // Under multi-user auth a session is its creator's. Any caller that sent its id was served on it,
  // with the creator's identity and role, so another account that learned the id ran calls as the
  // creator, or closed the session (found in review, 2026-10-09). Another caller now gets the reply
  // an unknown id gets, which says nothing about whose session it is. With one operator there is
  // nobody to keep apart, and any caller is served as before.
  if (session && multiUser && session.caller !== caller) {
    log.warn({ sessionId, caller }, "MCP request refused: the session belongs to another caller");
    logAudit("mcp_server_request", {
      method: "session",
      caller,
      outcome: "rejected",
    }, { severity: "warn" });
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unknown MCP session" }));
    return true;
  }
  // The caller's live role for this request's calls, should the account's role have changed since
  // the session opened.
  if (session && multiUser) session.ctx.role = role;

  if (req.method === "DELETE") {
    if (sessionId && session) {
      await teardownSession(sessionId, "delete");
      res.writeHead(204);
      res.end();
      return true;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unknown MCP session" }));
    return true;
  }

  if (!session) {
    // A present-but-unknown session id is stale / torn-down / forged — never mint a
    // session for it, or an attacker can grow _sessions without bound (the orphan
    // transport is never initialized, so its onclose never fires and it leaks a live
    // connected Server forever). A real initialize POST carries NO session-id header.
    if (sessionId) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unknown MCP session" }));
      return true;
    }
    if (req.method !== "POST" && req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed for new MCP session" }));
      return true;
    }
    session = await createHttpSession({ caller, role, ...(userId ? { userId } : {}) });
  }

  try {
    await session.transport.handleRequest(req, res);
  } catch (err) {
    log.error({ err, sessionId: session.transport.sessionId }, "MCP HTTP request handling failed");
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "MCP transport failure" }));
    }
  }
  return true;
}

async function createHttpSession(ctx: ExposeContext): Promise<McpHttpSession> {
  const { caller } = ctx;
  const generatedId = randomUUID();
  const server = createStarlingMcpServer(ctx);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => generatedId,
  });

  transport.onclose = () => {
    const id = transport.sessionId;
    if (id) void teardownSession(id, "transport_closed");
  };

  await server.connect(transport);
  const session: McpHttpSession = { transport, server, caller, ctx };
  // The transport mints its session id on first POST; track it under the
  // generated id immediately so subsequent requests with the right header
  // can find us, and also under the transport-assigned id once that lands.
  _sessions.set(generatedId, session);
  logAudit("mcp_server_session_opened", {
    caller,
    sessionId: generatedId,
    transport: "http",
  });
  return session;
}

async function teardownSession(sessionId: string, reason: string): Promise<void> {
  const session = _sessions.get(sessionId);
  if (!session) return;
  _sessions.delete(sessionId);
  logAudit("mcp_server_session_closed", {
    caller: session.caller,
    sessionId,
    reason,
    transport: "http",
  });
  try {
    await session.server.close();
  } catch (err) {
    log.debug({ err, sessionId }, "Error closing MCP server");
  }
  try {
    await session.transport.close();
  } catch (err) {
    log.debug({ err, sessionId }, "Error closing MCP HTTP transport");
  }
}

export async function shutdownMcpHttpSessions(): Promise<void> {
  for (const id of [..._sessions.keys()]) {
    await teardownSession(id, "shutdown");
  }
}

export function getMcpHttpSessionCount(): number {
  return _sessions.size;
}
