/**
 * SEC-105 (ADR-007): plugin network capability guard — deny-by-default fetch
 * host allowlist. Direct unit tests plus a real-worker end-to-end block.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installNetworkGuard, PluginCapabilityError } from "../plugin/capability-guard.js";
import { disposeAllPluginWorkers, spawnPluginWorker } from "../plugin/worker-host.js";

describe("installNetworkGuard", () => {
  it("denies ALL fetch when no hosts are declared (deny-by-default)", async () => {
    const calls: unknown[] = [];
    const target = { fetch: ((u: unknown) => { calls.push(u); return Promise.resolve("real"); }) as unknown as typeof fetch };
    const guard = installNetworkGuard([], target);
    await expect(target.fetch!("https://api.example.com/x")).rejects.toBeInstanceOf(PluginCapabilityError);
    expect(calls).toHaveLength(0); // original fetch never reached
    guard.restore();
  });

  it("allows only declared hosts (exact match), blocks everything else", async () => {
    const reached: string[] = [];
    const target = { fetch: ((u: unknown) => { reached.push(String(u)); return Promise.resolve("real"); }) as unknown as typeof fetch };
    const guard = installNetworkGuard(["api.example.com"], target);

    await expect(target.fetch!("https://api.example.com/data")).resolves.toBe("real");
    expect(reached).toEqual(["https://api.example.com/data"]);

    await expect(target.fetch!("https://evil.example.com/steal")).rejects.toThrow(/blocked/);
    await expect(target.fetch!("https://api.example.com.evil.com/")).rejects.toThrow(/blocked/); // no suffix trickery
    guard.restore();
  });

  it("accepts URL and Request-like inputs, and fails closed on an unparseable URL", async () => {
    const target = { fetch: (() => Promise.resolve("real")) as unknown as typeof fetch };
    const guard = installNetworkGuard(["host.test"], target);
    await expect(target.fetch!(new URL("https://host.test/p"))).resolves.toBe("real");
    // Request-like object (has a .url string) — the guard reads .url at runtime.
    await expect(target.fetch!({ url: "https://host.test/p" } as unknown as Request)).resolves.toBe("real");
    await expect(target.fetch!("not a url")).rejects.toBeInstanceOf(PluginCapabilityError);
    guard.restore();
  });

  it("restore() puts the original fetch back", () => {
    const original = (() => Promise.resolve("orig")) as unknown as typeof fetch;
    const target = { fetch: original };
    const guard = installNetworkGuard(["a.test"], target);
    expect(target.fetch).not.toBe(original);
    guard.restore();
    expect(target.fetch).toBe(original);
  });
});

describe("network guard end-to-end in a real worker", () => {
  let dir: string;
  afterEach(() => { disposeAllPluginWorkers(); rmSync(dir, { recursive: true, force: true }); });
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sai-capguard-")); });

  it("a worker with NO declared network capability cannot fetch", async () => {
    const entry = join(dir, "netplugin.mjs");
    writeFileSync(entry, `
      export default {
        name: "netplugin", version: "1.0.0",
        tools: [{ name: "call", description: "fetch probe", parameters: {},
          async execute(args) {
            try { await fetch(String(args.url)); return { success: true, output: "reached" }; }
            catch (e) { return { success: false, output: "", error: String(e && e.message || e) }; }
          } }],
      };
    `);
    const { handle } = await spawnPluginWorker(entry, { pluginId: "netplugin", networkHosts: [] });
    const result = await handle.invoke("call", { url: "https://example.com/" }, { sessionId: "s", workspacePath: "/w" }) as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/blocked/);
    handle.dispose();
  }, 30_000);

  it("a worker WITH a declared host is blocked for other hosts", async () => {
    const entry = join(dir, "netplugin2.mjs");
    writeFileSync(entry, `
      export default {
        name: "netplugin2", version: "1.0.0",
        tools: [{ name: "call", description: "fetch probe", parameters: {},
          async execute(args) {
            try { await fetch(String(args.url)); return { success: true, output: "reached" }; }
            catch (e) { return { success: false, output: "", error: String(e && e.message || e) }; }
          } }],
      };
    `);
    const { handle } = await spawnPluginWorker(entry, { pluginId: "netplugin2", networkHosts: ["allowed.internal"] });
    const blocked = await handle.invoke("call", { url: "https://forbidden.example.com/" }, { sessionId: "s", workspacePath: "/w" }) as { success: boolean; error?: string };
    expect(blocked.success).toBe(false);
    expect(blocked.error).toMatch(/forbidden\.example\.com.*blocked|blocked/);
    handle.dispose();
  }, 30_000);
});
