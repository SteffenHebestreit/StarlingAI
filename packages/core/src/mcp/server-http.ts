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
import { verifyToken, extractBearerToken } from "../gateway/auth.js";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";
import { createStarlingMcpServer } from "./server.js";

const log = childLogger("mcp:server-http");

interface McpHttpSession {
  transport: StreamableHTTPServerTransport;
  server: Server;
  caller: string;
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
  let caller = "anonymous";
  if (expose.http.requireAuth) {
    const headerToken = req.headers["authorization"]
      ? extractBearerToken(req.headers["authorization"] as string)
      : null;
    const queryToken = url.searchParams.get("token");
    const token = headerToken ?? queryToken;
    const verified = token ? await verifyToken(token) : null;
    if (!verified) {
      logAudit("mcp_server_request", {
        method: "auth",
        caller: "anonymous",
        outcome: "rejected",
      }, { severity: "warn" });
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return true;
    }
    caller = (verified as { sub?: string }).sub ?? "authenticated";
  }

  const sessionHeader = req.headers["mcp-session-id"];
  const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;

  if (req.method === "DELETE") {
    if (sessionId && _sessions.has(sessionId)) {
      await teardownSession(sessionId, "delete");
      res.writeHead(204);
      res.end();
      return true;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unknown MCP session" }));
    return true;
  }

  // Reuse an existing session when the client sent us a session id.
  // Otherwise, only initialize-style POSTs (and the bootstrap GET that some
  // clients issue) are allowed to mint a new session.
  let session = sessionId ? _sessions.get(sessionId) : undefined;

  if (!session) {
    if (req.method !== "POST" && req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed for new MCP session" }));
      return true;
    }
    session = await createHttpSession(caller);
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

async function createHttpSession(caller: string): Promise<McpHttpSession> {
  const generatedId = randomUUID();
  const server = createStarlingMcpServer({ caller });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => generatedId,
  });

  transport.onclose = () => {
    const id = transport.sessionId;
    if (id) void teardownSession(id, "transport_closed");
  };

  await server.connect(transport);
  const session: McpHttpSession = { transport, server, caller };
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
