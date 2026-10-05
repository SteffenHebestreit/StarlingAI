/**
 * The suite-wide network guard (src/tests/vitest.setup.ts) keeps tests on this machine.
 *
 * Each case asserts the guard's OWN message, not just a failure: an unguarded run also fails
 * to reach `*.invalid`, and would hang (not fail) on the unroutable TEST-NET address, so a
 * guard that silently stopped loading would fail these rather than pass them by luck.
 */
import { createServer, type Server } from "node:http";
import net, { type AddressInfo } from "node:net";
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
