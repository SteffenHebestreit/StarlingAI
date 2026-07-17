/**
 * SEC-105: plugin trust-before-load — tree digests, receipts, and the loader
 * refusal path (default ON: no receipt, no import).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computePluginDigest, isPluginTrusted } from "../plugin/trust.js";
import { PRODUCT } from "../product/index.js";

describe("computePluginDigest", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sai-plugin-digest-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is deterministic for files and directories, and a single byte change revokes it", () => {
    const file = join(dir, "plugin.js");
    writeFileSync(file, "export default { name: 'x', version: '1', tools: [] };");
    const first = computePluginDigest(file);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(computePluginDigest(file)).toBe(first);

    writeFileSync(file, "export default { name: 'x', version: '1', tools: [] } ;"); // one byte
    expect(computePluginDigest(file)).not.toBe(first);
  });

  it("directory digests cover nested files; adding or renaming a file changes the digest", () => {
    const pluginDir = join(dir, "myplugin");
    mkdirSync(join(pluginDir, "lib"), { recursive: true });
    writeFileSync(join(pluginDir, "index.js"), "code");
    writeFileSync(join(pluginDir, "lib", "util.js"), "helper");
    const base = computePluginDigest(pluginDir);
    expect(computePluginDigest(pluginDir)).toBe(base);

    writeFileSync(join(pluginDir, "lib", "extra.js"), "vendored");
    const withExtra = computePluginDigest(pluginDir);
    expect(withExtra).not.toBe(base);

    rmSync(join(pluginDir, "lib", "extra.js"));
    writeFileSync(join(pluginDir, "lib", "util2.js"), "helper"); // same content, new name
    rmSync(join(pluginDir, "lib", "util.js"));
    expect(computePluginDigest(pluginDir)).not.toBe(base);
  });

  it("isPluginTrusted requires BOTH the id and the exact digest to match", () => {
    const receipts = [{ name: "myplugin", digest: "a".repeat(64) }];
    expect(isPluginTrusted("myplugin", "a".repeat(64), receipts)).toBe(true);
    expect(isPluginTrusted("other", "a".repeat(64), receipts)).toBe(false);
    expect(isPluginTrusted("myplugin", "b".repeat(64), receipts)).toBe(false);
    expect(isPluginTrusted("myplugin", "a".repeat(64), [])).toBe(false);
  });
});

describe("loader trust gate (SEC-105, requireTrust default ON)", () => {
  let tempDir: string;
  let pluginsDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "sai-plugin-trust-"));
    pluginsDir = join(tempDir, "plugins");
    mkdirSync(pluginsDir, { recursive: true });
    process.env["SAI_AUDIT_LOG"] = join(tempDir, "audit.jsonl");
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env["SAI_CONFIG_PATH"];
    delete process.env["SAI_AUDIT_LOG"];
    delete process.env[`${PRODUCT.envPrefix}_PLUGINS_DIR`];
    rmSync(tempDir, { recursive: true, force: true });
    vi.resetModules();
  });

  const fakeTool = {
    name: "echo", description: "echo back",
    parameters: { type: "object", properties: {} },
    async execute(): Promise<{ success: boolean; output: string }> { return { success: true, output: "" }; },
  };
  const fakePlugin = (version: string) => ({ default: { name: "greeter", version, tools: [fakeTool] } });

  function writeConfig(trust: Array<{ name: string; digest: string }>): void {
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      workspacePath: tempDir,
      plugins: { enabled: true, dir: pluginsDir, trust },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
  }

  it("refuses an untrusted plugin BEFORE import, loads it once its digest is trusted, and re-refuses after a byte change", async () => {
    const pluginFile = join(pluginsDir, "greeter.js");
    writeFileSync(pluginFile, "export default { name: 'greeter', version: '1.0.0', tools: [] };");

    // Phase 1: no receipt → refused, importer NEVER invoked.
    writeConfig([]);
    let loader = await import("../plugin/loader.js");
    const importerCalls: string[] = [];
    loader.setPluginImporterForTests(async (entryPath: string) => {
      importerCalls.push(entryPath);
      return fakePlugin("1.0.0");
    });
    let result = await loader.loadPlugins(pluginsDir);
    expect(result).toMatchObject({ loaded: 0, rejected: 1 });
    expect(importerCalls).toHaveLength(0);

    // Phase 2: trust the exact digest → loads.
    const digest = computePluginDigest(pluginFile);
    writeConfig([{ name: "greeter", digest }]);
    vi.resetModules();
    loader = await import("../plugin/loader.js");
    loader.setPluginImporterForTests(async (entryPath: string) => {
      importerCalls.push(entryPath);
      return fakePlugin("1.0.0");
    });
    result = await loader.loadPlugins(pluginsDir);
    expect(result.loaded).toBe(1);
    expect(importerCalls).toHaveLength(1);

    // Phase 3: modify one byte — the old receipt no longer matches → refused again.
    writeFileSync(pluginFile, "export default { name: 'greeter', version: '1.0.1', tools: [] };");
    vi.resetModules();
    loader = await import("../plugin/loader.js");
    const phase3Calls: string[] = [];
    loader.setPluginImporterForTests(async (entryPath: string) => {
      phase3Calls.push(entryPath);
      return fakePlugin("1.0.1");
    });
    result = await loader.loadPlugins(pluginsDir);
    expect(result).toMatchObject({ loaded: 0, rejected: 1 });
    expect(phase3Calls).toHaveLength(0);
  });
});
