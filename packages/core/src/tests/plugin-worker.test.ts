/**
 * SEC-105 (ADR-007): plugin worker isolation — REAL child processes.
 * Proves the acceptance criteria: import-time code runs outside the gateway,
 * the worker env carries no gateway secrets, a hung call times out without
 * killing the worker, and a crash degrades the plugin without touching us.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMinimalWorkerEnv, disposeAllPluginWorkers, importPluginViaWorker, spawnPluginWorker } from "../plugin/worker-host.js";
import type { ToolContext } from "../tools/registry.js";

const ctx = { sessionId: "pw-test", workspacePath: "/tmp" } as ToolContext;

const FIXTURE_PLUGIN = `
export default {
  name: "isotest",
  version: "1.0.0",
  tools: [
    { name: "echo", description: "echo", parameters: {},
      async execute(args) { return { success: true, output: String(args.msg ?? "") }; } },
    { name: "leak", description: "env probe", parameters: {},
      async execute() { return { success: true, output: JSON.stringify({
        jwt: process.env.SAI_JWT_SECRET ?? null,
        redis: process.env.REDIS_URL ?? null,
        declared: process.env.ISOTEST_DECLARED ?? null,
      }) }; } },
    { name: "hang", description: "never resolves", parameters: {},
      execute() { return new Promise(() => {}); } },
    { name: "die", description: "kills the worker", parameters: {},
      async execute() { process.exit(7); } },
  ],
};
`;

describe("plugin worker isolation (real child processes)", () => {
  let dir: string;
  let entry: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sai-worker-"));
    entry = join(dir, "isotest.mjs");
    writeFileSync(entry, FIXTURE_PLUGIN);
    process.env["SAI_JWT_SECRET"] = "super-secret-value";
    process.env["REDIS_URL"] = "redis://gateway-internal:6379";
    process.env["ISOTEST_DECLARED"] = "declared-value";
  });

  afterEach(() => {
    disposeAllPluginWorkers();
    delete process.env["SAI_JWT_SECRET"];
    delete process.env["REDIS_URL"];
    delete process.env["ISOTEST_DECLARED"];
    rmSync(dir, { recursive: true, force: true });
  });

  it("buildMinimalWorkerEnv withholds everything but baseline + allowlist", () => {
    const env = buildMinimalWorkerEnv(["ISOTEST_DECLARED"]);
    expect(env["SAI_JWT_SECRET"]).toBeUndefined();
    expect(env["REDIS_URL"]).toBeUndefined();
    expect(env["ISOTEST_DECLARED"]).toBe("declared-value");
  });

  it("imports and executes in the child; gateway secrets are INVISIBLE, declared vars visible", async () => {
    const mod = await importPluginViaWorker(entry, { pluginId: "isotest", envAllowlist: ["ISOTEST_DECLARED"] });
    const plugin = mod.default!;
    expect(plugin.name).toBe("isotest");

    const echo = await plugin.tools.find((t) => t.name === "echo")!.execute({ msg: "hello" }, ctx);
    expect(echo).toMatchObject({ success: true, output: "hello" });

    const leak = await plugin.tools.find((t) => t.name === "leak")!.execute({}, ctx);
    expect(leak.success).toBe(true);
    expect(JSON.parse(leak.output)).toEqual({ jwt: null, redis: null, declared: "declared-value" });
  }, 30_000);

  it("a hung tool times out per-call; the worker stays healthy for other calls", async () => {
    const { handle } = await spawnPluginWorker(entry, { pluginId: "isotest", defaultInvokeTimeoutMs: 800 });
    await expect(handle.invoke("hang", {}, { sessionId: "s", workspacePath: "/w" })).rejects.toThrow(/timed out/);
    const after = await handle.invoke("echo", { msg: "alive" }, { sessionId: "s", workspacePath: "/w" });
    expect(after).toMatchObject({ success: true, output: "alive" });
    handle.dispose();
  }, 30_000);

  it("a crashing tool degrades the plugin without touching the gateway; further calls fast-fail", async () => {
    const { handle } = await spawnPluginWorker(entry, { pluginId: "isotest", defaultInvokeTimeoutMs: 5_000 });
    await expect(handle.invoke("die", {}, { sessionId: "s", workspacePath: "/w" })).rejects.toThrow(/died|exit/i);
    expect(handle.degraded).toBe(true);
    await expect(handle.invoke("echo", { msg: "x" }, { sessionId: "s", workspacePath: "/w" })).rejects.toThrow(/degraded/);
  }, 30_000);

  it("a plugin whose import throws is rejected at the handshake, not half-loaded", async () => {
    const badEntry = join(dir, "bad.mjs");
    writeFileSync(badEntry, "throw new Error('import-time explosion');");
    await expect(importPluginViaWorker(badEntry, { pluginId: "bad" })).rejects.toThrow(/import failed|explosion/);
  }, 30_000);
});
