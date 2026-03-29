import { createServer, type Server } from "node:http";
import { Buffer } from "node:buffer";
import { Hono } from "hono";
import { childLogger } from "../../logger.js";
import { RdpComputerAdapter } from "../computer-adapters/remote-rdp.js";
import { SshComputerAdapter } from "../computer-adapters/remote-ssh.js";
import { VncComputerAdapter } from "../computer-adapters/remote-vnc.js";
import type { ComputerAdapter } from "../computer-adapters/base.js";
import type { ComputerSession, ComputerSessionAdapter, DisplayTopology } from "../computer-session.js";
import type { RemoteAdapterConfig, SshAdapterConfig } from "../../config/computer-use-schema.js";
import type {
  ComputerRemoteActionRequest,
  ComputerRemoteActionResponse,
  ComputerRemoteHealthResponse,
  ComputerRemoteSessionHealthResponse,
  ComputerRemoteSessionStartRequest,
  ComputerRemoteSessionStartResponse,
  ComputerRemoteSessionStopRequest,
  ComputerRemoteSessionStopResponse,
  ComputerRemoteTargetSpec,
  ComputerRemoteTopologyResponse,
  ComputerRemoteWindowsResponse,
} from "./protocol.js";

const log = childLogger("computer-remote");

interface RemoteComputerServerOptions {
  host: string;
  port: number;
  authToken?: string;
  label?: string;
}

interface RemoteComputerServerHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface RemoteComputerSessionState {
  sessionId: string;
  adapter: ComputerAdapter;
  topology: DisplayTopology;
  target: ComputerRemoteTargetSpec;
  updatedAt: number;
}

function buildSessionShell(sessionId: string, adapter: ComputerSessionAdapter): ComputerSession {
  const now = Date.now();
  return {
    id: sessionId,
    adapter,
    state: "active",
    leaseOwner: "computer-remote-service",
    displayTopology: null,
    lastSnapshot: null,
    createdAt: now,
    updatedAt: now,
    lastHeartbeatAt: now,
    recordingEnabled: false,
  };
}

function createAdapterForTarget(target: ComputerRemoteTargetSpec): ComputerAdapter {
  switch (target.adapter) {
    case "remote_vnc":
      return new VncComputerAdapter(target.config as RemoteAdapterConfig);
    case "remote_rdp":
      return new RdpComputerAdapter(target.config as RemoteAdapterConfig);
    case "remote_ssh":
      return new SshComputerAdapter(target.config as SshAdapterConfig);
    default:
      throw new Error(`Unsupported remote adapter ${(target as { adapter: string }).adapter}`);
  }
}

export function createRemoteComputerServer(options: RemoteComputerServerOptions): RemoteComputerServerHandle {
  const app = new Hono();
  let server: Server | null = null;
  const sessions = new Map<string, RemoteComputerSessionState>();

  app.onError((error, c) => {
    const message = error instanceof Error ? error.message : String(error);
    log.error({ error: message, path: c.req.path, method: c.req.method }, "Remote access request failed");
    return c.json({ error: message }, 500);
  });

  async function stopSession(sessionId: string): Promise<void> {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    try {
      await session.adapter.cleanup();
    } catch (error) {
      log.warn({ sessionId, error }, "Remote access session cleanup failed");
    }
  }

  function requireSession(sessionId: string): RemoteComputerSessionState {
    const session = sessions.get(sessionId);
    if (!session) {
      throw new Error(`Remote access session '${sessionId}' was not found`);
    }
    return session;
  }

  app.use("*", async (c, next) => {
    if (!options.authToken) {
      await next();
      return;
    }

    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (token !== options.authToken) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });

  app.get("/health", async (c) => {
    const body: ComputerRemoteHealthResponse = {
      ok: true,
      healthy: true,
      label: options.label ?? "Remote access sidecar",
      activeSessions: sessions.size,
    };
    return c.json(body);
  });

  app.post("/sessions/start", async (c) => {
    const { sessionId, target } = await c.req.json<ComputerRemoteSessionStartRequest>();
    const existing = sessions.get(sessionId);
    if (existing) {
      const body: ComputerRemoteSessionStartResponse = { ok: true, sessionId, topology: existing.topology };
      return c.json(body);
    }

    const adapter = createAdapterForTarget(target);
    const session = buildSessionShell(sessionId, target.adapter);
    await adapter.initialize(session);
    const topology = await adapter.getDisplayTopology();
    sessions.set(sessionId, { sessionId, adapter, topology, target, updatedAt: Date.now() });
    log.info({ sessionId, adapter: target.adapter }, "Remote access session started");
    const body: ComputerRemoteSessionStartResponse = { ok: true, sessionId, topology };
    return c.json(body);
  });

  app.post("/sessions/stop", async (c) => {
    const { sessionId } = await c.req.json<ComputerRemoteSessionStopRequest>();
    await stopSession(sessionId);
    const body: ComputerRemoteSessionStopResponse = { ok: true, sessionId };
    return c.json(body);
  });

  app.get("/sessions/:sessionId/health", async (c) => {
    const session = requireSession(c.req.param("sessionId"));
    const body: ComputerRemoteSessionHealthResponse = {
      ok: true,
      healthy: await session.adapter.isHealthy(),
      sessionId: session.sessionId,
    };
    return c.json(body);
  });

  app.get("/sessions/:sessionId/display-topology", async (c) => {
    const session = requireSession(c.req.param("sessionId"));
    session.topology = await session.adapter.getDisplayTopology();
    session.updatedAt = Date.now();
    const body: ComputerRemoteTopologyResponse = { topology: session.topology };
    return c.json(body);
  });

  app.get("/sessions/:sessionId/snapshot", async (c) => {
    const session = requireSession(c.req.param("sessionId"));
    const snapshot = await session.adapter.captureSnapshot();
    session.updatedAt = Date.now();
    return c.json(snapshot);
  });

  app.get("/sessions/:sessionId/windows", async (c) => {
    const session = requireSession(c.req.param("sessionId"));
    const body: ComputerRemoteWindowsResponse = { windows: await session.adapter.listWindows() };
    session.updatedAt = Date.now();
    return c.json(body);
  });

  app.post("/sessions/:sessionId/action", async (c) => {
    const session = requireSession(c.req.param("sessionId"));
    const { action } = await c.req.json<ComputerRemoteActionRequest>();
    const result = await session.adapter.executeAction(action);
    session.updatedAt = Date.now();
    return c.json(result as ComputerRemoteActionResponse, result.success ? 200 : 400);
  });

  return {
    async start() {
      if (server) return;
      server = createServer((req, res) => {
        const requestUrl = new URL(req.url ?? "/", `http://${options.host}:${options.port}`);
        const honoReq = new Request(requestUrl, {
          method: req.method,
          headers: req.headers as HeadersInit,
          body: req.method === "GET" || req.method === "HEAD" ? undefined : req,
          duplex: "half",
        } as RequestInit & { duplex: "half" });

        void Promise.resolve(app.fetch(honoReq)).then(async (response) => {
          const responseHeaders: Record<string, string> = {};
          response.headers.forEach((value, key) => {
            responseHeaders[key] = value;
          });
          res.writeHead(response.status, responseHeaders);
          const body = Buffer.from(await response.arrayBuffer());
          res.end(body);
        }).catch((error) => {
          log.error({ error }, "Remote access request failed");
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Internal server error" }));
        });
      });

      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(options.port, options.host, () => {
          server!.off("error", reject);
          resolve();
        });
      });

      log.info({ host: options.host, port: options.port }, "Remote access server started");
    },
    async stop() {
      const activeSessionIds = [...sessions.keys()];
      for (const sessionId of activeSessionIds) {
        await stopSession(sessionId);
      }
      if (!server) return;
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      server = null;
    },
  };
}