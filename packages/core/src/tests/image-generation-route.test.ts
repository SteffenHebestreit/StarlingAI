import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PRODUCT } from "../product/index.js";

/**
 * POST /api/multimodal/generate-image answered steps or a size outside what may be rendered with a
 * 502, as if the image backend had failed: requestImageGeneration refuses them, and the route's
 * catch-all turned every refusal into a gateway error. The caller sent them; a 400 says so.
 */
describe("POST /api/multimodal/generate-image", () => {
  afterEach(async () => {
    for (const key of ["SAI_CONFIG_PATH", "SAI_JWT_SECRET", "SAI_MASTER_KEY", "SAI_CRED_STORE", "SAI_AUDIT_LOG"]) delete process.env[key];
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("answers a request outside the bounds with 400, and sends nothing to the backend", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "starlingai-image-route-"));
    const port = 19500 + Math.floor(Math.random() * 400);
    const configDir = join(tempDir, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "10-gateway.json"), JSON.stringify({ gateway: { port, jwtSecret: "q".repeat(32) } }), "utf8");
    writeFileSync(join(configDir, "20-multimodal.json"), JSON.stringify({
      multimodal: { imageGeneration: { baseUrl: "http://image-backend.invalid/v1", api: "openai-compatible", model: "image" } },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configDir;
    process.env["SAI_MASTER_KEY"] = "m".repeat(32);
    process.env["SAI_CRED_STORE"] = join(tempDir, PRODUCT.stateDirName, "credentials.enc");
    process.env["SAI_AUDIT_LOG"] = join(tempDir, PRODUCT.stateDirName, "audit.jsonl");
    vi.resetModules();

    const [{ createGateway }, auth] = await Promise.all([import("../gateway/index.js"), import("../gateway/auth.js")]);
    const gateway = createGateway();
    await gateway.start();
    const baseUrl = `http://127.0.0.1:${port}`;
    // The image backend answers every render with a failure, and counts what reaches it.
    const realFetch = globalThis.fetch;
    const upstream = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes("image-backend.invalid") ? upstream() : realFetch(input, init));

    try {
      await waitForHealth(`${baseUrl}/healthz`);
      const headers = { Authorization: `Bearer ${await auth.createToken("admin", { role: "admin" })}`, "Content-Type": "application/json" };
      const post = (body: Record<string, unknown>) => realFetch(`${baseUrl}/api/multimodal/generate-image`, { method: "POST", headers, body: JSON.stringify(body) });

      const tooMany = await post({ prompt: "a harbour", steps: 1000, width: 4096 });
      expect(tooMany.status).toBe(400);
      expect(await tooMany.json()).toEqual({
        error: "steps must be a whole number from 1 to 100 (asked for 1000); width must be a whole number of pixels up to 2048"
          + " (asked for 4096). Nothing was rendered.",
      });
      expect(upstream).not.toHaveBeenCalled();

      // A backend that fails is still the gateway's 502.
      const failed = await post({ prompt: "a harbour", steps: 20 });
      expect(failed.status).toBe(502);
      expect(upstream).toHaveBeenCalled();
    } finally {
      await gateway.stop();
      auth.resetAuthStateForTests();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 45_000);
});

async function waitForHealth(url: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Gateway did not become ready: ${url}`);
}
