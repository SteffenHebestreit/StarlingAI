/**
 * THE TTS ROUTE'S AUDIO SAMPLE FOLLOWS NO LINK OUT OF ITS ZONE (review 2026-10-11).
 *
 * POST /api/multimodal/tts reads `audioExamplePath` from the workspace and sends its bytes to the
 * TTS service. The path was held to the workspace by its string alone, so a link a sandbox left in
 * generated/ sent whatever it leads to upstream. It is held to its zone now
 * (containedWorkspaceRealPath), before any request goes out.
 *
 * The TTS service is a local listener that records whether it was called; a link to a directory is
 * a junction where this machine cannot make symbolic links.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PRODUCT } from "../product/index.js";

function linkDir(target: string, at: string): void {
  try {
    symlinkSync(target, at, "dir");
  } catch {
    symlinkSync(target, at, "junction");
  }
}

const dirs: string[] = [];
const saved = { config: process.env["SAI_CONFIG_PATH"], jwt: process.env["SAI_JWT_SECRET"], master: process.env["SAI_MASTER_KEY"], cred: process.env["SAI_CRED_STORE"], audit: process.env["SAI_AUDIT_LOG"] };

afterEach(() => {
  for (const [key, env] of [["config", "SAI_CONFIG_PATH"], ["jwt", "SAI_JWT_SECRET"], ["master", "SAI_MASTER_KEY"], ["cred", "SAI_CRED_STORE"], ["audit", "SAI_AUDIT_LOG"]] as const) {
    if (saved[key] === undefined) delete process.env[env];
    else process.env[env] = saved[key];
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("POST /api/multimodal/tts", () => {
  it("sends no audio sample a link leads to", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "sai-tts-link-"));
    const outside = mkdtempSync(join(tmpdir(), "sai-tts-link-outside-"));
    dirs.push(tempDir, outside);
    const ws = join(tempDir, "ws");
    mkdirSync(join(ws, "generated"), { recursive: true });
    writeFileSync(join(outside, "sample.wav"), "gateway-secret-canary");
    linkDir(outside, join(ws, "generated", "out"));

    let upstreamCalls = 0;
    const upstream = createServer((_req, res) => {
      upstreamCalls += 1;
      res.writeHead(500);
      res.end();
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const port = 26600 + Math.floor(Math.random() * 1000);
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      workspacePath: ws,
      gateway: { port, jwtSecret: "j".repeat(32) },
      multimodal: { tts: { baseUrl: `http://127.0.0.1:${upstreamPort}`, api: "qwen-compatible", model: "m", defaultLanguage: "English", defaultSpeaker: "Vivian" } },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    delete process.env["SAI_JWT_SECRET"];
    process.env["SAI_MASTER_KEY"] = "m".repeat(32);
    process.env["SAI_CRED_STORE"] = join(tempDir, PRODUCT.stateDirName, "credentials.enc");
    process.env["SAI_AUDIT_LOG"] = join(tempDir, PRODUCT.stateDirName, "audit.jsonl");

    vi.resetModules();
    const [{ createGateway }, auth] = await Promise.all([import("../gateway/index.js"), import("../gateway/auth.js")]);
    const gateway = createGateway();
    await gateway.start();
    try {
      const token = await auth.createToken("admin", { role: "admin" });
      const response = await fetch(`http://127.0.0.1:${port}/api/multimodal/tts`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text: "speak this", audioExamplePath: "generated/out/sample.wav" }),
      });
      expect(response.status).toBe(502);
      expect(await response.text()).toMatch(/escapes the workspace/);
      expect(upstreamCalls).toBe(0);
    } finally {
      await gateway.stop();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  }, 45_000);
});
