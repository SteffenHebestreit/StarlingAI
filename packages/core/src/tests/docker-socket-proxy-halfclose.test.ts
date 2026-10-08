/**
 * The docker-socket proxy keeps relaying an attach stream after the client half-closes it
 * (found 2026-10-07).
 *
 * The docker CLI half-closes an attach connection as soon as it has no stdin to send, then reads
 * the container's output on it. The proxy's server ended the client socket on that FIN, so every
 * attached `docker run` through it exited 0 with no output: the sandbox's shell_exec and
 * run_script returned "(no output)" for every command. Driven through the real server
 * (createProxyServer) against a fake daemon on DOCKER_SOCKET_PATH; the hijack tests in
 * docker-socket-proxy.test.ts hand spliceHijack a socket of their own and cannot see this.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import net from "node:net";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const socketPath = process.platform === "win32"
  ? `\\\\.\\pipe\\sai-proxy-halfclose-${process.pid}`
  : join(tmpdir(), `sai-proxy-halfclose-${process.pid}.sock`);

let daemon: net.Server;
let proxy: net.Server;
let proxyPort = 0;

beforeAll(async () => {
  // Like dockerd: answers an attach with 101, tolerates the client's half-close, and writes the
  // container's output afterwards.
  daemon = net.createServer({ allowHalfOpen: true }, (sock) => {
    sock.on("error", () => { /* the proxy may close first */ });
    sock.once("data", () => {
      sock.write("HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.multiplexed-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
      setTimeout(() => { sock.write("CONTAINER-OUTPUT"); sock.end(); }, 150);
    });
  });
  if (process.platform !== "win32") rmSync(socketPath, { force: true });
  await new Promise<void>((resolve) => daemon.listen(socketPath, resolve));
  // Read by server.mjs when it loads, so it is set before the import.
  process.env["DOCKER_SOCKET_PATH"] = socketPath;
  // @ts-expect-error — plain .mjs, no types
  const { createProxyServer } = await import("../../../../docker/docker-socket-proxy/server.mjs");
  proxy = createProxyServer();
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  proxyPort = (proxy.address() as net.AddressInfo).port;
});

afterAll(async () => {
  delete process.env["DOCKER_SOCKET_PATH"];
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
  await new Promise<void>((resolve) => daemon.close(() => resolve()));
});

// Linux only: a Windows named pipe has no half-close, so the fake daemon's line cannot carry the
// stream past it. The proxy runs on Linux, and so does CI.
it.skipIf(process.platform === "win32")("relays the container's output after the client half-closes the attach", async () => {
  const received = await new Promise<string>((resolve, reject) => {
    const client = net.connect(proxyPort, "127.0.0.1");
    let got = "";
    let halfClosed = false;
    const timer = setTimeout(() => resolve(got), 3000);
    client.on("connect", () => {
      client.write(`POST /v1.55/containers/${"a".repeat(64)}/attach?stream=1&stdout=1&stderr=1 HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n`);
    });
    client.on("data", (chunk) => {
      got += chunk.toString("latin1");
      // What the docker CLI does with no stdin to send: close its write side once the stream is up.
      if (!halfClosed && got.includes("101 UPGRADED")) { halfClosed = true; client.end(); }
    });
    client.on("end", () => { clearTimeout(timer); resolve(got); });
    client.on("error", (err) => { clearTimeout(timer); reject(err); });
  });

  expect(received).toContain("101 UPGRADED");
  expect(received).toContain("CONTAINER-OUTPUT");
});

/** Writes `request`, half-closes, and reports what came back and whether the proxy closed the connection. */
function halfClosedRequest(request: string): Promise<{ got: string; closed: boolean }> {
  return new Promise((resolve, reject) => {
    const client = net.connect(proxyPort, "127.0.0.1");
    let got = "";
    let sent = false;
    const timer = setTimeout(() => { resolve({ got, closed: false }); client.destroy(); }, 2000);
    client.on("connect", () => { client.write(request); client.end(); sent = true; });
    client.on("data", (chunk) => { got += chunk.toString("latin1"); });
    // Once the request is out, a reset closes the connection as well; before it, the test is broken.
    client.on("error", (err) => { if (!sent) { clearTimeout(timer); reject(err); } });
    client.on("close", () => { clearTimeout(timer); resolve({ got, closed: true }); });
  });
}

// The half-open server keeps a socket open after the client's FIN, so a client that half-closes (or
// goes away) before its request is complete has to be closed by the proxy itself, or it holds a
// socket in the one container that holds docker.sock. The daemon is never contacted here, so these
// run on Windows as well.
it("closes a client that half-closes before its request head is complete", async () => {
  expect(await halfClosedRequest("GET /v1.55/_ping HTTP/1.1\r\nHost: dock")).toEqual({ got: "", closed: true });
});

it("refuses a create whose body a half-close cut short", async () => {
  const { got, closed } = await halfClosedRequest(
    "POST /v1.55/containers/create HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{\"Image\":",
  );
  expect(got).toMatch(/^HTTP\/1\.1 400 /);
  expect(got).toContain("create/exec body incomplete");
  expect(closed).toBe(true);
});
