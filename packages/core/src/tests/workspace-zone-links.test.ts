/**
 * NO GATEWAY READER OF THE CONFIG ZONES FOLLOWS A LINK (review 2026-10-12).
 *
 * The full-scope maintenance sandbox writes agents/, jobs/, scenes/, tools/ and generated/, and can
 * leave a link there: `agents/x.jsonc` linked to any file the gateway can read, or a directory linked
 * anywhere. The gateway would read through it what the sandbox itself cannot (the state directory
 * included) and merge it into the live configuration, load it as a tool bundle, or write a bundle
 * through it as its own user. Every sweep of the zones now goes by lstat, skips a link with a
 * warning that names it, and reads and writes held to the zone.
 *
 * A directory link is a junction on Windows, which needs no privilege; a file link needs one there,
 * so the cases that need it run only where a file symlink can be made.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error — plain .mjs, no types
import * as configShardsModule from "../../../../scripts/config-shards.mjs";

const { collectShardPaths } = configShardsModule as { collectShardPaths: (dir: string, options?: { excludeZones?: string[] }) => string[] };

const warnings: Array<{ logger: string; fields: unknown; message: unknown }> = [];
const errors: Array<{ logger: string; fields: unknown; message: unknown }> = [];

vi.mock("../logger.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../logger.js")>();
  const capture = <T extends object>(name: string, target: T): T => new Proxy(target, {
    get(t, property, receiver) {
      if (property === "warn" || property === "error") {
        return (...args: unknown[]) => {
          (property === "warn" ? warnings : errors).push({ logger: name, fields: args[0], message: args[args.length - 1] });
        };
      }
      return Reflect.get(t, property, receiver) as unknown;
    },
  });
  return {
    ...original,
    logger: capture("root", original.logger),
    childLogger: (name: string, meta?: Record<string, unknown>) => capture(name, original.childLogger(name, meta)),
  };
});

const AGENT = { description: "x", systemPrompt: "y", tools: ["read_file"] };
const BUNDLE = (name: string) => ({
  name,
  description: "d",
  parameters: { type: "object", properties: {} },
  code: "export default () => 1;",
  version: 1,
  approvedAt: "2026-10-12T00:00:00.000Z",
  approvedBy: "operator",
  testResults: [],
});

/** A link at `path` to the directory `target`: a junction on Windows, a symlink elsewhere. */
function linkDirectory(target: string, path: string): void {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

/** Whether this machine can make a file symlink (Windows needs a privilege or developer mode). */
const canLinkFiles = (() => {
  const probe = mkdtempSync(join(tmpdir(), "sai-link-probe-"));
  try {
    writeFileSync(join(probe, "target"), "");
    symlinkSync(join(probe, "target"), join(probe, "link"), "file");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

const norm = (path: unknown) => String(path).replace(/\\/g, "/").toLowerCase();
const warnedAbout = (path: string) => warnings.some((warning) => norm((warning.fields as { path?: unknown } | null)?.path) === norm(path));
const erredAbout = (path: string) => errors.some((error) => norm((error.fields as { path?: unknown } | null)?.path) === norm(path));

let root = "";
let outside = "";
let savedEnv: Record<string, string | undefined> = {};

/**
 * A two-zone layout (config/ + workspace/) with a good agent shard, and outside it a directory with
 * a shard and a tool bundle the gateway must never read: the sandbox's links lead there.
 */
function buildLayout(): { config: string; workspace: string } {
  const config = join(root, "config");
  const workspace = join(root, "workspace");
  for (const dir of [config, join(workspace, "agents"), join(workspace, "scenes"), join(workspace, "tools"), outside]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(config, "00-base.jsonc"), JSON.stringify({ providers: { lmstudio: { baseUrl: "http://x/v1" } } }));
  writeFileSync(join(workspace, "agents", "10-agents.jsonc"), JSON.stringify({ subAgents: { good: AGENT } }));
  writeFileSync(join(outside, "secret.jsonc"), JSON.stringify({ subAgents: { evil: AGENT } }));
  writeFileSync(join(outside, "bundle.json"), JSON.stringify(BUNDLE("planted_tool")));
  return { config, workspace };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sai-zone-links-"));
  outside = join(root, "outside");
  savedEnv = {
    SAI_CONFIG_PATH: process.env["SAI_CONFIG_PATH"],
    SAI_WORKSPACE_CONFIG_PATH: process.env["SAI_WORKSPACE_CONFIG_PATH"],
    SAI_AUDIT_LOG: process.env["SAI_AUDIT_LOG"],
  };
  warnings.length = 0;
  errors.length = 0;
  vi.resetModules();
});

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  (await import("../config/loader.js")).resetConfigForTests();
  rmSync(root, { recursive: true, force: true });
});

/** The loader, fresh, reading this test's layout. */
async function loaderFor(layout: { config: string; workspace: string }) {
  process.env["SAI_CONFIG_PATH"] = layout.config;
  process.env["SAI_WORKSPACE_CONFIG_PATH"] = layout.workspace;
  process.env["SAI_AUDIT_LOG"] = join(root, "audit.jsonl");
  return import("../config/loader.js");
}

describe("the config loader", () => {
  it("skips a directory link in a zone, names it in a warning, and merges nothing behind it", async () => {
    const layout = buildLayout();
    const link = join(layout.workspace, "agents", "planted");
    linkDirectory(outside, link);
    const { loadConfig } = await loaderFor(layout);
    const config = loadConfig({ skipCompiledWrite: true });
    expect(Object.keys(config.subAgents)).toContain("good");
    expect(Object.keys(config.subAgents)).not.toContain("evil");
    expect(warnedAbout(link)).toBe(true);
  });

  it.skipIf(!canLinkFiles)("skips a shard that is a link to a file outside the zone, and names it", async () => {
    const layout = buildLayout();
    const link = join(layout.workspace, "agents", "20-planted.jsonc");
    symlinkSync(join(outside, "secret.jsonc"), link, "file");
    const { loadConfig } = await loaderFor(layout);
    expect(Object.keys(loadConfig({ skipCompiledWrite: true }).subAgents)).not.toContain("evil");
    expect(warnedAbout(link)).toBe(true);
  });

  it("says as an error, not a warning, that a linked directory at the top of a config tree is left out", async () => {
    const layout = buildLayout();
    const kept = join(root, "kept-gateway");
    mkdirSync(kept, { recursive: true });
    writeFileSync(join(kept, "10-gateway.jsonc"), JSON.stringify({ gateway: { port: 18_999 } }));
    const link = join(layout.config, "gateway");
    linkDirectory(kept, link);
    const { loadConfig } = await loaderFor(layout);
    loadConfig({ skipCompiledWrite: true });
    expect(erredAbout(link)).toBe(true);
    expect(warnedAbout(link)).toBe(false);
  });

  it("reads a config directory that is itself a link", async () => {
    const layout = buildLayout();
    const linkedConfig = join(root, "linked-config");
    linkDirectory(layout.config, linkedConfig);
    const { loadConfig } = await loaderFor({ ...layout, config: linkedConfig });
    expect(loadConfig({ skipCompiledWrite: true }).providers).toHaveProperty("lmstudio");
    expect(errors).toEqual([]);
  });
});

describe("swarm_validate's sweep (validateWorkspaceConfig)", () => {
  it("skips a link whose name looks like a shard, with a warning, instead of reading through it", async () => {
    const layout = buildLayout();
    // A directory link named like a shard: the sweep took every non-directory entry for a file and
    // read it, here failing on a directory; a file link it read through to its target.
    const link = join(layout.workspace, "agents", "20-planted.jsonc");
    linkDirectory(outside, link);
    const { validateWorkspaceConfig } = await import("../config/validate-workspace.js");
    const result = validateWorkspaceConfig(layout.workspace, new Set(["read_file"]));
    expect(result.parseErrors).toEqual([]);
    expect(result.warnings.some((warning) => warning.includes("20-planted.jsonc") && /link/.test(warning))).toBe(true);
    expect(result.summary.subAgents).toBe(1);
    expect(warnedAbout(link)).toBe(true);
  });

  it.skipIf(!canLinkFiles)("does not merge a shard that is a link to a file outside the zone", async () => {
    const layout = buildLayout();
    symlinkSync(join(outside, "secret.jsonc"), join(layout.workspace, "agents", "20-planted.jsonc"), "file");
    const { validateWorkspaceConfig } = await import("../config/validate-workspace.js");
    const result = validateWorkspaceConfig(layout.workspace, new Set(["read_file"]));
    expect(result.summary.subAgents).toBe(1);
  });
});

describe("the dynamic tools in tools/", () => {
  it("skips a link at a bundle's name, with a warning that names it", async () => {
    const layout = buildLayout();
    const link = join(layout.workspace, "tools", "planted_tool.json");
    linkDirectory(outside, link);
    await loaderFor(layout);
    const { loadDynamicTools, getLoadedDynamicTools } = await import("../tools/dynamic-tools.js");
    loadDynamicTools();
    expect(getLoadedDynamicTools().map((def) => def.name)).not.toContain("planted_tool");
    expect(warnedAbout(link)).toBe(true);
  });

  it.skipIf(!canLinkFiles)("loads no bundle through a file link, and writes none through one", async () => {
    const layout = buildLayout();
    symlinkSync(join(outside, "bundle.json"), join(layout.workspace, "tools", "planted_tool.json"), "file");
    const target = join(outside, "target.json");
    writeFileSync(target, "untouched");
    symlinkSync(target, join(layout.workspace, "tools", "deployed_tool.json"), "file");
    await loaderFor(layout);
    const { deployApprovedTool, loadDynamicTools, getLoadedDynamicTools } = await import("../tools/dynamic-tools.js");
    loadDynamicTools();
    expect(getLoadedDynamicTools().map((def) => def.name)).not.toContain("planted_tool");
    expect(() => deployApprovedTool(BUNDLE("deployed_tool"))).toThrow();
    expect(readFileSync(target, "utf8")).toBe("untouched");
  });

  it("still loads and writes a regular bundle", async () => {
    const layout = buildLayout();
    writeFileSync(join(layout.workspace, "tools", "real_tool.json"), JSON.stringify(BUNDLE("real_tool")));
    await loaderFor(layout);
    const { deployApprovedTool, loadDynamicTools, getLoadedDynamicTools } = await import("../tools/dynamic-tools.js");
    loadDynamicTools();
    expect(getLoadedDynamicTools().map((def) => def.name)).toContain("real_tool");
    deployApprovedTool(BUNDLE("another_tool"));
    expect(JSON.parse(readFileSync(join(layout.workspace, "tools", "another_tool.json"), "utf8")).name).toBe("another_tool");
  });
});

describe("the e2e setup's shard scan (scanAuthUsers)", () => {
  it("reports a link in the config trees, which it skips as the loader does", async () => {
    const layout = buildLayout();
    const link = join(layout.workspace, "agents", "planted");
    linkDirectory(outside, link);
    const { scanAuthUsers } = await import("../e2e/setup.js");
    const scan = scanAuthUsers({
      repoRoot: root,
      configDir: layout.config,
      workspaceDir: layout.workspace,
      mutableOverlayPath: null,
      shardPath: join(layout.config, "auth", "90-e2e.jsonc"),
      credentialsPath: join(root, "credentials.json"),
      mailIsolationPath: join(layout.config, "mail", "accounts.d", "00-e2e-isolation.json5"),
      canBuild: false,
    });
    expect(scan.links.map(norm)).toEqual([norm(link)]);
  });
});

/** `config build` itself (scripts/config-layout.mjs), run on a copy of its scripts beside `layout`. */
function runBuild(repo: string): { status: number | null; stdout: string; stderr: string } {
  const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  mkdirSync(join(repo, "scripts"), { recursive: true });
  for (const script of ["config-layout.mjs", "config-shards.mjs", "config-zones.mjs", "product.mjs"]) {
    copyFileSync(join(repoRoot, "scripts", script), join(repo, "scripts", script));
  }
  // The build's one dependency, where node resolves it from the copy.
  const json5 = dirname(createRequire(join(repoRoot, "scripts", "config-layout.mjs")).resolve("json5/package.json"));
  mkdirSync(join(repo, "node_modules"), { recursive: true });
  linkDirectory(json5, join(repo, "node_modules", "json5"));
  const run = spawnSync(process.execPath, [join(repo, "scripts", "config-layout.mjs"), "build"], { cwd: repo, encoding: "utf8" });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

describe("config build (scripts/config-layout.mjs)", () => {
  it("fails, naming it and how to fix it, on a linked directory at the top of a config tree, and writes nothing", () => {
    const layout = buildLayout();
    const kept = join(root, "kept-gateway");
    mkdirSync(kept, { recursive: true });
    writeFileSync(join(kept, "10-gateway.jsonc"), JSON.stringify({ gateway: { port: 18_999 } }));
    const link = join(layout.config, "gateway");
    linkDirectory(kept, link);
    const build = runBuild(root);
    expect(build.status).toBe(1);
    expect(norm(build.stderr)).toContain(norm(link));
    expect(build.stderr).toMatch(/Replace the link with what it points to/);
    expect(build.stdout).not.toMatch(/Built/);
    expect(existsSync(join(root, "starlingai.json"))).toBe(false);
  });

  it("builds from a config/ and a workspace/ that are themselves links", () => {
    const layout = buildLayout();
    const real = join(root, "real");
    mkdirSync(real, { recursive: true });
    const config = join(real, "config");
    const workspace = join(real, "workspace");
    // The layout moved aside, and config/ and workspace/ at the root are links to it.
    linkDirectory(layout.config, config);
    linkDirectory(layout.workspace, workspace);
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    linkDirectory(config, join(repo, "config"));
    linkDirectory(workspace, join(repo, "workspace"));
    const build = runBuild(repo);
    expect(build.status, build.stderr).toBe(0);
    expect(build.stdout).toMatch(/Built starlingai\.json/);
    const built = JSON.parse(readFileSync(join(repo, "starlingai.json"), "utf8")) as { providers?: unknown; subAgents?: Record<string, unknown> };
    expect(built.providers).toHaveProperty("lmstudio");
    expect(Object.keys(built.subAgents ?? {})).toEqual(["good"]);
  });
});

describe("the build's shard sweep (scripts/config-shards.mjs)", () => {
  it("skips a link, warning with its path", () => {
    const layout = buildLayout();
    const link = join(layout.workspace, "agents", "planted");
    linkDirectory(outside, link);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const shards = collectShardPaths(layout.workspace, { excludeZones: ["generated", "uploads", "tools", "users"] });
      expect(shards.map(norm)).toEqual([norm(join(layout.workspace, "agents", "10-agents.jsonc"))]);
      expect(warn.mock.calls.some(([message]) => norm(message).includes(norm(link)))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("a shard written by swarm_define_agent", () => {
  it("is never written through a link at its name", async () => {
    const layout = buildLayout();
    const link = join(layout.workspace, "agents", "50-authored-planted.jsonc");
    linkDirectory(outside, link);
    const { getConfig } = await loaderFor(layout);
    getConfig();
    const { getAllTools } = await import("../tools/registry.js");
    await import("../tools/swarm-authoring-tools.js");
    const define = getAllTools().find((tool) => tool.name === "swarm_define_agent")!;
    const result = await define.execute({ name: "planted", definition: AGENT }, { sessionId: "s-zone-links", workspacePath: layout.workspace });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/is a link/);
    expect(existsSync(join(outside, "50-authored-planted.jsonc"))).toBe(false);
  });
});
