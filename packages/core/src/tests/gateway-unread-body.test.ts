import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Agent, createServer, request, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { Server, connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { PRODUCT } from "../product/index.js";
import { discardUnreadBody } from "../gateway/unread-body.js";

/**
 * An early reply to a request whose body was not read must not strand the keep-alive connection.
 *
 * The bridge hands Hono `Readable.toWeb(req)`. When a handler answered without reading the body (a
 * 401 from an auth check, the 413 of the Content-Length limit), the rest of the body stayed on the
 * socket and the reply said `Connection: keep-alive`. Node does not drain a request a web stream
 * holds, so the client's next request on that socket was never parsed and failed with ECONNRESET
 * some 6 s later, when the server timed the socket out. Measured with a 400 KB unauthenticated
 * POST /api/chat; small bodies, which arrive whole with the headers, were not affected.
 *
 * The rest of such a body is now read and dropped after the reply, within bounds, so the
 * connection carries the next request; past the bounds the socket is closed, after the reply has
 * had time to arrive. The gateway tests run against the whole gateway, on 127.0.0.1.
 */

const tempDirs: string[] = [];
const ENV_KEYS = ["SAI_CONFIG_PATH", "SAI_MASTER_KEY", "SAI_CRED_STORE", "SAI_AUDIT_LOG", "SAI_JWT_SECRET"];

afterEach(async () => {
  const audit = await import("../audit/logger.js");
  await audit.flushAuditLog();
  (await import("../config/loader.js")).resetConfigForTests();
  (await import("../gateway/auth.js")).resetAuthStateForTests();
  for (const key of ENV_KEYS) delete process.env[key];
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

async function bootGateway() {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-unread-body-"));
  tempDirs.push(tempDir);
  const configDir = join(tempDir, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "10-test.json"), JSON.stringify({
    gateway: { port: 39_000, jwtSecret: "j".repeat(40) },
    workspacePath: tempDir,
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configDir;
  process.env["SAI_MASTER_KEY"] = "m".repeat(32);
  process.env["SAI_CRED_STORE"] = join(tempDir, PRODUCT.stateDirName, "credentials.enc");
  process.env["SAI_AUDIT_LOG"] = join(tempDir, "audit.jsonl");
  vi.resetModules();
  const { createGateway } = await import("../gateway/index.js");
  const gateway = createGateway();
  // The gateway's own start(), with its listen redirected from 0.0.0.0:<configured port> to an
  // ephemeral port on loopback, so the test neither exposes a port nor collides with one in use.
  const originalListen = Server.prototype.listen;
  let gatewayServer: Server | undefined;
  Server.prototype.listen = function redirectedListen(this: Server, ...args: unknown[]) {
    const redirected = args[1] === "0.0.0.0";
    if (redirected) {
      args[0] = 0;
      args[1] = "127.0.0.1";
    }
    const server = (originalListen as (...listenArgs: unknown[]) => Server).apply(this, args);
    if (redirected) gatewayServer = server;
    return server;
  } as typeof Server.prototype.listen;
  try {
    await gateway.start();
  } finally {
    Server.prototype.listen = originalListen;
  }
  if (!gatewayServer) throw new Error("the gateway did not listen");
  const { port } = gatewayServer.address() as AddressInfo;
  return { port, stop: () => gateway.stop() };
}

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  /** The client-side port of the socket the reply came on: equal ports mean a reused socket. */
  localPort: number | undefined;
  elapsedMs: number;
}

/** One request on `agent`; fails on a socket error or when no complete reply arrives within `timeoutMs`. */
function send(agent: Agent, port: number, method: string, path: string, body?: Buffer, timeoutMs = 3_000): Promise<Reply> {
  const startedAt = Date.now();
  return new Promise<Reply>((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      method,
      path,
      agent,
      headers: body ? { "Content-Type": "application/json", "Content-Length": String(body.length) } : {},
    }, (res) => {
      const localPort = res.socket.localPort;
      res.resume();
      res.on("end", () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, localPort, elapsedMs: Date.now() - startedAt });
      });
    });
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`${method} ${path}: no reply within ${timeoutMs} ms`));
    }, timeoutMs);
    req.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.end(body);
  });
}

/**
 * Starts a POST whose body never finishes: `headers` and `firstChunk` go out, the rest never does.
 * Resolves with the reply's status and headers, and with when the server closed the socket.
 */
function sendUnfinished(port: number, headers: Record<string, string>, firstChunk: Buffer) {
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const req = request({ host: "127.0.0.1", port, method: "POST", path: "/api/chat", agent, headers });
  req.on("error", () => { /* the server closing the socket mid-upload is the point */ });
  const replied = new Promise<{ status: number; headers: IncomingHttpHeaders; at: number }>((resolve) => {
    req.once("response", (res: IncomingMessage) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, headers: res.headers, at: Date.now() });
    });
  });
  const socketClosed = new Promise<number>((resolve) => {
    req.once("socket", (socket) => socket.once("close", () => resolve(Date.now())));
  });
  req.write(firstChunk);
  return { replied, socketClosed, abort: () => { req.destroy(); agent.destroy(); } };
}

/**
 * Starts a POST that declares `declaredBytes` and keeps writing its body as fast as the connection
 * takes it, whatever the server answers, the way curl or a browser uploads (Node's own http client
 * stops writing soon after an early reply). It is a raw socket, so the test sees what reaches the
 * client: `replied` settles with the reply's status and Connection header, or fails with the
 * socket error that came instead of them; `socketClosed` with when the socket closed.
 */
function sendUpload(port: number, declaredBytes: number) {
  const socket = connect({ host: "127.0.0.1", port });
  let received = "";
  const replied = new Promise<{ status: number; connection: string | undefined; at: number }>((resolve, reject) => {
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("latin1");
      const headEnd = received.indexOf("\r\n\r\n");
      if (headEnd === -1) return;
      const [statusLine = "", ...headerLines] = received.slice(0, headEnd).split("\r\n");
      const connection = headerLines.find((line) => /^connection:/i.test(line))?.slice("connection:".length).trim().toLowerCase();
      resolve({ status: Number(statusLine.split(" ")[1]), connection, at: Date.now() });
    });
    socket.once("error", reject);
    socket.once("close", () => reject(new Error("the socket closed before a reply came")));
  });
  socket.on("error", () => { /* after the reply, the server closing the socket mid-upload is expected */ });
  const socketClosed = new Promise<number>((resolve) => socket.once("close", () => resolve(Date.now())));
  socket.write(`POST /api/chat HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${declaredBytes}\r\n\r\n`);
  let written = 0;
  const piece = Buffer.alloc(256 * 1024, "a");
  const pump = () => {
    while (written + piece.length <= declaredBytes && !socket.destroyed) {
      written += piece.length;
      if (!socket.write(piece)) {
        socket.once("drain", pump);
        return;
      }
    }
  };
  pump();
  return { replied, socketClosed, written: () => written, abort: () => socket.destroy() };
}

describe("an early gateway reply to a request whose body was not read", () => {
  it("drops the rest of the body, so the next request on the same connection is answered at once", async () => {
    const gw = await bootGateway();
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    try {
      // 400 KB is under the 1 MiB body limit, so the route's own auth check refuses it unread.
      const refused = await send(agent, gw.port, "POST", "/api/chat", Buffer.alloc(400 * 1024, "a"));
      const next = await send(agent, gw.port, "GET", "/healthz", undefined, 1_000);
      expect(refused.status).toBe(401);
      expect(next.status).toBe(200);
      expect(next.elapsedMs).toBeLessThan(1_000);
      expect(refused.headers["connection"]).toBe("keep-alive");
      expect(next.localPort).toBe(refused.localPort);
    } finally {
      agent.destroy();
      await gw.stop();
    }
  }, 60_000);

  it("does the same for the 413 of the body limit, which never reads the body", async () => {
    const gw = await bootGateway();
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const refused = await send(agent, gw.port, "POST", "/api/chat", Buffer.alloc(1_048_576 + 1, "a"));
      const next = await send(agent, gw.port, "GET", "/healthz", undefined, 1_000);
      expect(refused.status).toBe(413);
      expect(next.status).toBe(200);
      expect(next.elapsedMs).toBeLessThan(1_000);
      expect(next.localPort).toBe(refused.localPort);
    } finally {
      agent.destroy();
      await gw.stop();
    }
  }, 60_000);

  it("keeps the connection for GETs, a body the handler read and a small body that came whole", async () => {
    const gw = await bootGateway();
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const first = await send(agent, gw.port, "GET", "/healthz");
      const second = await send(agent, gw.port, "GET", "/healthz");
      // A large body the handler reads to the end (the login route parses it, then answers 503
      // because username/password login is off in this config).
      const login = Buffer.from(JSON.stringify({ username: "alice", password: "p".repeat(400 * 1024) }));
      const read = await send(agent, gw.port, "POST", "/api/auth/login", login);
      const small = await send(agent, gw.port, "POST", "/api/chat", Buffer.from(JSON.stringify({ message: "hi" })));
      const last = await send(agent, gw.port, "GET", "/healthz");
      expect([first.status, second.status, read.status, small.status, last.status]).toEqual([200, 200, 503, 401, 200]);
      for (const reply of [first, second, read, small, last]) {
        expect(reply.headers["connection"]).toBe("keep-alive");
        expect(reply.localPort).toBe(first.localPort);
      }
    } finally {
      agent.destroy();
      await gw.stop();
    }
  }, 60_000);

  it("delivers the reply to a body declared larger than it would drop, then closes within the bounds", async () => {
    const gw = await bootGateway();
    const declared = 100 * 1024 * 1024;
    const upload = sendUpload(gw.port, declared);
    try {
      // Closing the connection with the reply (Connection: close) resets it while the body is still
      // coming in, and the client gets ECONNRESET instead of this 413.
      const reply = await upload.replied;
      expect(reply.status).toBe(413);
      expect(reply.connection).toBe("keep-alive");
      // The server then reads at most 64 MiB or 500 ms of the rest and closes the socket, so the
      // upload never completes; left alone, it held the socket until its 5 s keep-alive timeout.
      expect(await upload.socketClosed - reply.at).toBeLessThan(2_000);
      expect(upload.written()).toBeLessThan(declared);
    } finally {
      upload.abort();
      await gw.stop();
    }
  }, 60_000);

  it("stops waiting for the rest of a body that does not come", async () => {
    const gw = await bootGateway();
    // A chunked body, so nothing declares its length, that stops after its first chunk.
    const upload = sendUnfinished(gw.port, { "Content-Type": "application/json", "Transfer-Encoding": "chunked" }, Buffer.alloc(64 * 1024, "a"));
    try {
      const reply = await upload.replied;
      expect(reply.status).toBe(401);
      // The server gives up after 500 ms; left alone, it held the socket until its 5 s keep-alive timeout.
      expect(await upload.socketClosed - reply.at).toBeLessThan(2_000);
    } finally {
      upload.abort();
      await gw.stop();
    }
  }, 60_000);
});

describe("discardUnreadBody", () => {
  it("closes the socket once it has dropped more than its byte limit, without reading the rest", async () => {
    const limits = { maxBytes: 64 * 1024, timeoutMs: 10_000 };
    const bodyBytes = 8 * 1024 * 1024;
    let serverSide!: (seen: { complete: boolean; dropped: number }) => void;
    const closed = new Promise<{ complete: boolean; dropped: number }>((resolve) => { serverSide = resolve; });
    const server = createServer((req, res) => {
      // As in the gateway bridge: a web stream holds the request (and has started reading it by
      // the time a handler answers), and the reply ignores the body.
      void Readable.toWeb(req);
      let dropped = 0;
      res.once("finish", () => {
        discardUnreadBody(req, limits);
        req.on("data", (chunk: Buffer) => { dropped += chunk.length; });
      });
      req.socket.once("close", () => serverSide({ complete: req.complete, dropped }));
      setImmediate(() => {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("no");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const req = request({ host: "127.0.0.1", port, method: "POST", path: "/", headers: { "Content-Length": String(bodyBytes) } });
    req.on("error", () => { /* the server closing the socket mid-upload is the point */ });
    req.on("response", (res) => res.resume());
    // Written in pieces, so the body arrives over time and passes the limit on the way.
    const piece = Buffer.alloc(256 * 1024, "a");
    const pump = (left: number) => {
      if (left === 0 || req.destroyed) return;
      if (req.write(piece)) setImmediate(() => pump(left - 1));
      else req.once("drain", () => pump(left - 1));
    };
    pump(bodyBytes / piece.length);
    try {
      const seen = await Promise.race([
        closed,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the server kept the socket")), 5_000)),
      ]);
      expect(seen.complete).toBe(false);
      expect(seen.dropped).toBeGreaterThan(limits.maxBytes);
      expect(seen.dropped).toBeLessThan(bodyBytes);
    } finally {
      req.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
