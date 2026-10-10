/**
 * The gateway of a maintenance boot (SAI_MAINTENANCE=account-migration): HTTP only, and only
 *
 *   GET  /healthz, /health             — liveness, naming the maintenance
 *   GET  /api/auth/mode                — what the login screen asks, with `maintenance` set
 *   POST /api/admin/account-migration  — the account migration (gateway/account-migration-routes.ts)
 *
 * Everything else answers 503. No WebSocket, channel, schedule, job worker, swarm, sweep, MCP, A2A,
 * plugin or dynamic tool starts in this boot (src/index.ts), so nothing but the migration writes the
 * stores it rewrites. This is a list of what is served, not of what is turned off: a route or
 * writer added later is off here until it is added to it.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Hono } from "hono";
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";
import { runWithRequestContext } from "../runtime/request-context.js";
import { ACCOUNT_MIGRATION_MAINTENANCE, type AccountMigrationBackends } from "../runtime/account-migration.js";
import { authenticatedUser, callerIdentity } from "./auth.js";
import { findRoutePolicy, policyAdmitsRole } from "./route-policies.js";
import { registerAccountMigrationRoutes } from "./account-migration-routes.js";

const log = childLogger("gateway:maintenance");

/** The request bodies served here are a few flags. */
const MAX_BODY_BYTES = 64 * 1024;

export function createMaintenanceApp(backends?: () => Promise<AccountMigrationBackends>): Hono {
  const app = new Hono();
  // The same gates as the full gateway's /api routes: the route policy, then the caller's identity.
  app.use("/api/*", async (c, next) => {
    const policy = findRoutePolicy(c.req.method, c.req.path);
    if (!policy) return next();
    const user = await authenticatedUser(c.req.header("Authorization"));
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    if (!policyAdmitsRole(policy, user.role)) return c.json({ error: `Requires role: ${policy.roles.join(" | ")}` }, 403);
    return next();
  });
  app.use("/api/*", async (c, next) => {
    if (!getConfig().auth?.enabled) return next();
    const user = await authenticatedUser(c.req.header("Authorization"));
    return runWithRequestContext({ identity: callerIdentity(user) }, () => next());
  });

  const health = { status: "ok", maintenance: ACCOUNT_MIGRATION_MAINTENANCE };
  app.get("/healthz", (c) => c.json(health));
  app.get("/health", (c) => c.json(health));
  app.get("/api/auth/mode", (c) => {
    const auth = getConfig().auth;
    return c.json({ authEnabled: auth.enabled === true, provider: auth.enabled ? auth.provider : "builtin", maintenance: ACCOUNT_MIGRATION_MAINTENANCE });
  });
  registerAccountMigrationRoutes(app, backends);
  app.notFound((c) => c.json({
    error: `The gateway is in a maintenance boot (${ACCOUNT_MIGRATION_MAINTENANCE}): only the account migration is served. Remove SAI_MAINTENANCE and restart it when the migration is done`,
  }, 503));
  return app;
}

/** Reads a request body up to the cap; null when it is larger. */
function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(tooLarge ? null : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function createMaintenanceGateway(): { app: Hono; start(): Promise<void>; stop(): Promise<void> } {
  const app = createMaintenanceApp();
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const method = req.method ?? "GET";
      const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req);
      if (body === null) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Request body too large" }));
        return;
      }
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers[key] = value;
        else if (Array.isArray(value)) headers[key] = value.join(", ");
      }
      const response = await app.fetch(new Request(new URL(req.url ?? "/", "http://localhost"), { method, headers, ...(body ? { body: body.toString("utf8") } : {}) }));
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => { responseHeaders[key] = value; });
      res.writeHead(response.status, responseHeaders);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      log.error({ err }, "Maintenance gateway request failed");
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  // Upgrades (the dashboard socket, the browser view) are not served in maintenance.
  server.on("upgrade", (_req, socket) => socket.destroy());
  return {
    app,
    start: () => new Promise<void>((resolveStart, reject) => {
      const port = getConfig().gateway.port;
      server.once("error", reject);
      server.listen(port, "0.0.0.0", () => {
        server.off("error", reject);
        log.warn({ port }, `Maintenance boot (${ACCOUNT_MIGRATION_MAINTENANCE}): only the account migration is served`);
        resolveStart();
      });
    }),
    stop: () => new Promise<void>((resolveStop) => server.close(() => resolveStop())),
  };
}
