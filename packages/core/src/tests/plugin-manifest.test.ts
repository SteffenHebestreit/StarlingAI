/**
 * ADR-007: data-only plugin manifests + trust-time compatibility scanning.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPluginManifest, scanPluginCompatibility } from "../plugin/manifest.js";

describe("readPluginManifest", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sai-manifest-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function pluginDir(name: string, manifest?: unknown, entry = "index.js"): string {
    const p = join(dir, name);
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, entry), "export default {};");
    if (manifest !== undefined) {
      writeFileSync(join(p, "plugin.manifest.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
    }
    return p;
  }

  it("absent manifest is legal (legacy plugins keep working under the digest gate)", () => {
    expect(readPluginManifest(pluginDir("legacy"), "legacy")).toEqual({ status: "absent" });
  });

  it("a valid manifest parses without importing any plugin code", () => {
    const result = readPluginManifest(pluginDir("greeter", {
      name: "greeter", version: "1.0.0", entry: "index.js",
      tools: [{ name: "greet" }],
      capabilities: { network: ["api.example.com"], env: ["GREETER_KEY"] },
    }), "greeter");
    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      expect(result.manifest.capabilities?.network).toEqual(["api.example.com"]);
    }
  });

  it("rejects identity mismatch, missing entry, traversal entries, and malformed JSON", () => {
    expect(readPluginManifest(pluginDir("a", { name: "other", version: "1", entry: "index.js" }), "a").status).toBe("invalid");
    expect(readPluginManifest(pluginDir("b", { name: "b", version: "1", entry: "missing.js" }), "b").status).toBe("invalid");
    expect(readPluginManifest(pluginDir("c", { name: "c", version: "1", entry: "../escape.js" }), "c").status).toBe("invalid");
    expect(readPluginManifest(pluginDir("d", "{not json"), "d").status).toBe("invalid");
  });
});

describe("scanPluginCompatibility", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sai-compat-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("flags gateway-state reliance: raw env, child processes, core-internal imports, process.exit", () => {
    const p = join(dir, "risky");
    mkdirSync(p);
    writeFileSync(join(p, "index.js"), [
      "import { exec } from 'node:child_process';",
      "import { helper } from '../../core/src/internal.js';",
      "const key = process.env.SAI_JWT_SECRET;",
      "if (!key) process.exit(1);",
    ].join("\n"));
    const patterns = scanPluginCompatibility(p).map((f) => f.pattern).sort();
    expect(patterns).toEqual(["child_process", "core_internals", "process_env", "process_exit"]);
  });

  it("declared env capabilities suppress their own findings; undeclared vars still flag", () => {
    const p = join(dir, "declared");
    mkdirSync(p);
    writeFileSync(join(p, "index.js"), "const k = process.env.GREETER_KEY;");
    expect(scanPluginCompatibility(p, ["GREETER_KEY"])).toEqual([]);
    expect(scanPluginCompatibility(p, []).map((f) => f.pattern)).toEqual(["process_env"]);
    writeFileSync(join(p, "index.js"), "const a = process.env.GREETER_KEY; const b = process.env.SECRET;");
    expect(scanPluginCompatibility(p, ["GREETER_KEY"]).map((f) => f.pattern)).toEqual(["process_env"]);
  });

  it("a clean SDK-style plugin produces no findings", () => {
    const p = join(dir, "clean");
    mkdirSync(p);
    writeFileSync(join(p, "index.js"), "export default { name: 'clean', version: '1', tools: [{ name: 'echo', description: 'd', parameters: {}, async execute(args) { return { success: true, output: String(args.msg) }; } }] };");
    expect(scanPluginCompatibility(p)).toEqual([]);
  });
});
