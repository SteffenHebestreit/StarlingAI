import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect } from "vitest";

/**
 * Regression: a CDP connect timeout must not crash the process.
 *
 * `ws` reports a handshake abort asynchronously — close() on a still-CONNECTING
 * socket calls abortHandshake, which emits 'error' on a process.nextTick. The
 * connect promise in render/cdp-pdf.ts removes its own 'error' listener in
 * cleanup() and then closes the socket in `finally`, so without a listener that
 * OUTLIVES cleanup the emission is unhandled — an uncaught throw, which the
 * gateway's uncaughtException handler turns into a full shutdown.
 *
 * This test drives the real socket lifecycle against a server that accepts the
 * upgrade and never completes it, and asserts the late 'error' is delivered to a
 * handler rather than escaping. It discriminates: with the permanent listener
 * removed from cdp-pdf.ts, the equivalent standalone script exits non-zero via
 * uncaughtException.
 */
describe("CDP connect timeout", () => {
  it("delivers a post-cleanup handshake abort to a listener instead of throwing", async () => {
    const server = http.createServer((_req, res) => res.end("no"));
    // Accept the upgrade and hold it open without ever answering.
    server.on("upgrade", (_req, socket) => { socket.on("error", () => { /* held */ }); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    const { default: WebSocket } = await import("ws");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/devtools/page/ABC`, { perMessageDeflate: false });

    // The permanent listener under test (mirrors render/cdp-pdf.ts).
    const lateErrors: Error[] = [];
    ws.on("error", (err: Error) => { lateErrors.push(err); });

    // The per-phase connect handlers, which remove themselves on timeout.
    let timedOut = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const onOpen = (): void => { cleanup(); resolve(); };
        const onError = (err: Error): void => { cleanup(); reject(err); };
        const timer = setTimeout(() => { cleanup(); reject(new Error("timed out connecting to the browser")); }, 1000);
        const cleanup = (): void => { clearTimeout(timer); ws.off("open", onOpen); ws.off("error", onError); };
        ws.once("open", onOpen);
        ws.once("error", onError);
      });
    } catch (err) {
      timedOut = /timed out connecting/.test(err instanceof Error ? err.message : "");
    } finally {
      try { ws.close(); } catch { /* already closing */ }
    }

    expect(timedOut).toBe(true);

    // Let the nextTick abort emission land.
    await new Promise((r) => setTimeout(r, 250));

    // The abort fired AFTER cleanup removed the phase listener — the permanent
    // listener is what keeps it from becoming an uncaught throw.
    expect(lateErrors.length).toBeGreaterThan(0);
    expect(lateErrors[0]!.message).toMatch(/closed before the connection is established|closed before the connection was established/i);

    server.close();
  }, 15_000);
});
