import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect } from "vitest";
import { Agent } from "undici";

/**
 * Regression: undici's transport-level bodyTimeout must not pre-empt this codebase's
 * own per-chunk stall guard.
 *
 * Node's global fetch is undici, and undici applies a default bodyTimeout of 300s to
 * the response body. providers/lmstudio.ts already owns stall policy — an inactivity
 * timer that re-arms on every chunk — so the undici timer is a second, invisible
 * authority with a shorter fuse. It won in production: a qwen3.8-27b content_writer
 * run with a 28k-token prompt went silent for ~5 minutes inside one reasoning block
 * and died with "BodyTimeoutError: terminated" after 4 useful iterations.
 *
 * The real values (300s vs 15min) are impractical to test directly, so this drives
 * the identical mechanism at 1/1000 scale: a server that sends one chunk, stays
 * silent past the dispatcher's bodyTimeout, then finishes. With a body timeout the
 * read throws; with it disabled — the shipped configuration — the body completes.
 *
 * RUNTIME-DEPENDENT, deliberately. Verified in the gateway image (Node 22, which CI
 * also uses): a strict dispatcher throws BodyTimeoutError and bodyTimeout:0 lets the
 * same stream finish. On Node 25 the userland undici Agent is not applied to global
 * fetch at all, so the mechanism cannot be exercised — the suite detects that and
 * skips rather than reporting a failure that says nothing about the fix.
 */
function silentMidStreamServer(silenceMs: number): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain", "Transfer-Encoding": "chunked" });
    res.write("first-chunk");
    setTimeout(() => { res.write("second-chunk"); res.end(); }, silenceMs);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => server.close() });
    });
  });
}

async function readWith(dispatcher: Agent, url: string): Promise<string> {
  const res = await (globalThis.fetch as unknown as (i: string, o: Record<string, unknown>) => Promise<Response>)(
    url, { dispatcher },
  );
  return await res.text();
}

/** True when this runtime actually applies a userland undici Agent to global fetch. */
async function dispatcherIsHonored(): Promise<boolean> {
  const server = await silentMidStreamServer(700);
  const strict = new Agent({ bodyTimeout: 150, headersTimeout: 10_000 });
  try {
    await readWith(strict, server.url);
    return false;   // no throw → the dispatcher was ignored
  } catch {
    return true;
  } finally {
    await strict.close();
    server.close();
  }
}

describe("provider transport — undici bodyTimeout", () => {
  const SILENCE_MS = 900;

  it("a SHORT body timeout kills a stream that merely went quiet (the bug)", async (ctx) => {
    if (!await dispatcherIsHonored()) {
      ctx.skip();   // runtime ignores the dispatcher (observed on Node 25); see the docblock
      return;
    }
    const server = await silentMidStreamServer(SILENCE_MS);
    const strict = new Agent({ bodyTimeout: 200, headersTimeout: 10_000 });
    try {
      await expect(readWith(strict, server.url)).rejects.toThrow();
    } finally {
      await strict.close();
      server.close();
    }
  }, 20_000);

  it("bodyTimeout:0 — the shipped setting — lets the same stream finish", async () => {
    const server = await silentMidStreamServer(SILENCE_MS);
    // Exactly how providerDispatcher is configured in providers/lmstudio.ts.
    const permissive = new Agent({ bodyTimeout: 0, headersTimeout: 120_000 });
    try {
      const body = await readWith(permissive, server.url);
      expect(body).toBe("first-chunksecond-chunk");
    } finally {
      await permissive.close();
      server.close();
    }
  }, 20_000);
});
