/**
 * The suite-wide network guard (src/tests/vitest.setup.ts) keeps tests on this machine.
 *
 * Each case asserts the guard's OWN message, not just a failure: an unguarded run also fails
 * to reach `*.invalid`, and would hang (not fail) on the unroutable TEST-NET address, so a
 * guard that silently stopped loading would fail these rather than pass them by luck.
 */
import { createServer, type Server } from "node:http";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const GUARD_MESSAGE = "blocked by the test network guard";

function connectError(options: net.NetConnectOpts): Promise<NodeJS.ErrnoException> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(options);
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error(`connected to ${JSON.stringify(options)}; the guard let it through`));
    });
    socket.once("error", (error: NodeJS.ErrnoException) => resolve(error));
  });
}

describe.skipIf(process.env["SAI_TEST_LIVE"] === "1")("test network guard", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer((_request, response) => response.end("local"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("refuses a hostname the way an unresolvable one fails in CI", async () => {
    const error = await connectError({ host: "model-server.invalid", port: 1234 });
    expect(error.code).toBe("ENOTFOUND");
    expect(error.message).toContain(GUARD_MESSAGE);
  });

  it("refuses an IP literal at once instead of waiting on a connect timeout", async () => {
    // 203.0.113.0/24 is TEST-NET-3: unroutable, so without the guard this would hang.
    const error = await connectError({ host: "203.0.113.7", port: 80, timeout: 5_000 });
    expect(error.code).toBe("EHOSTUNREACH");
    expect(error.message).toContain(GUARD_MESSAGE);
  });

  it("covers fetch, which is how the providers call a model", async () => {
    const failure = await fetch("http://host.docker.internal:1234/v1/models").then(
      () => null,
      (error: unknown) => (error as { cause?: NodeJS.ErrnoException }).cause ?? null,
    );
    expect(failure?.code).toBe("ENOTFOUND");
    expect(failure?.message).toContain(GUARD_MESSAGE);
  });

  it("lets loopback through, by address and by name", async () => {
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("local");
    expect(await (await fetch(`http://localhost:${port}/`)).text()).toBe("local");
  });
});

// Not skipped under SAI_TEST_LIVE=1: a live run reaches out, it never needs to be reached.
describe("test listen guard", () => {
  const servers: net.Server[] = [];
  afterAll(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  function listening(server: net.Server, ...args: unknown[]): Promise<AddressInfo | string | null> {
    servers.push(server);
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      (server.listen as (...listenArgs: unknown[]) => net.Server).apply(server, [...args, () => resolve(server.address())]);
    });
  }

  async function bound(server: net.Server, ...args: unknown[]): Promise<string> {
    return ((await listening(server, ...args)) as AddressInfo).address;
  }

  /** listen() as called, synchronously. The error listener only keeps an unguarded run's
   *  asynchronous bind failure from surfacing as an uncaught exception, so it fails on the
   *  assertion instead. */
  function listenNow(server: net.Server, ...args: unknown[]): net.Server {
    return (server.listen as (...listenArgs: unknown[]) => net.Server).apply(server.on("error", () => {}), args);
  }

  const PIPE = process.platform === "win32"
    ? `\\\\.\\pipe\\sai-listen-guard-${process.pid}`
    : join(tmpdir(), `sai-listen-guard-${process.pid}.sock`);
  // Spellings of a TCP bind that look like something else. Node binds TCP whenever `port` is there
  // and decides that before it looks at `path`, and it uses `_handle`, `handle` and `fd` only when
  // they hold a handle or a valid descriptor.
  const NOT_AN_IPC_LISTEN = [{ path: null }, { path: PIPE }, { fd: -1 }, { handle: null }, { _handle: null }];

  it("moves a bind to every interface onto loopback: 0.0.0.0, ::, an options object, and no host at all", async () => {
    expect(await bound(createServer(), 0, "0.0.0.0")).toBe("127.0.0.1");
    expect(await bound(createServer(), 0, "::")).toBe("127.0.0.1");
    expect(await bound(createServer(), 0)).toBe("127.0.0.1");
    expect(await bound(createServer(), 0, undefined, 511)).toBe("127.0.0.1");
    expect(await bound(net.createServer(), { port: 0 })).toBe("127.0.0.1");
    expect(await bound(net.createServer(), { port: 0, host: null })).toBe("127.0.0.1");
    expect(await bound(net.createServer(), { port: 0, host: "0.0.0.0" })).toBe("127.0.0.1");
  });

  it("reads the arguments the way Node does: a TCP bind spelled with a path, an empty handle or a string port is moved too", async () => {
    for (const extra of NOT_AN_IPC_LISTEN) {
      expect(await bound(net.createServer(), { port: 0, host: "0.0.0.0", ...extra })).toBe("127.0.0.1");
    }
    expect(await bound(net.createServer(), { port: undefined, path: PIPE })).toBe("127.0.0.1");
    // Node reads a string as a pipe name only when it is not a number >= 0.
    expect(await bound(createServer(), " 0")).toBe("127.0.0.1");
    expect(await bound(createServer(), "0x0", "0.0.0.0")).toBe("127.0.0.1");
  });

  it("leaves an explicit loopback bind as it is", async () => {
    expect(await bound(createServer(), 0, "127.0.0.1")).toBe("127.0.0.1");
    expect(await bound(net.createServer(), { port: 0, host: "localhost" })).toMatch(/^(127\.0\.0\.1|::1)$/);
  });

  it("leaves an IPC path as it is: a named pipe or Unix socket binds no interface", async () => {
    expect(await listening(net.createServer(), { path: PIPE })).toBe(PIPE);
  });

  it("refuses a bind to a non-loopback address instead of exposing it", () => {
    // 192.0.2.0/24 is TEST-NET-1: never a local interface, so an unguarded listen fails with
    // EADDRNOTAVAIL asynchronously, not with the guard's synchronous throw.
    expect(() => listenNow(createServer(), 0, "192.0.2.10")).toThrow(/test listen guard/);
    expect(() => listenNow(net.createServer(), { port: 0, host: "192.0.2.10" })).toThrow(/test listen guard/);
    // However the call is spelled.
    for (const extra of NOT_AN_IPC_LISTEN) {
      expect(() => listenNow(net.createServer(), { port: 0, host: "192.0.2.10", ...extra })).toThrow(/test listen guard/);
    }
    expect(() => listenNow(createServer(), " 0", "192.0.2.10")).toThrow(/test listen guard/);
    expect(() => listenNow(createServer(), "0x0", "192.0.2.10")).toThrow(/test listen guard/);
    expect(() => listenNow(createServer(), undefined, "192.0.2.10")).toThrow(/test listen guard/);
  });
});
