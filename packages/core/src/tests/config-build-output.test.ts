/**
 * `SAI CONFIG BUILD` IS THE ONE WRITER OF THE CONFIG FILE NEXT TO config/.
 *
 * The build merges config/ + workspace/ into `<root>/starlingai.json` (the product's config file
 * name), the file Docker mounts into the gateway. The loader used to write the same path too, from
 * every load in a config directory: the config as validated, with every schema default filled in,
 * the env overrides laid over (SAI_JWT_SECRET and the provider keys in plain text), the runtime
 * overlay and this machine's absolute workspace path. So a gateway or script run from the
 * repository root replaced the build's output with another file, and a checkout that tracks it was
 * left changed. These tests run the real build, then load, save and reload from that root, and
 * hold the built file to its bytes.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRODUCT } from "../product/index.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const ENV_KEYS = ["SAI_CONFIG_PATH", "SAI_WORKSPACE_CONFIG_PATH", "SAI_MUTABLE_CONFIG_PATH", "SAI_JWT_SECRET", "SAI_PRIMARY_MODEL_KEY"] as const;
const JWT_SECRET = "jwt-secret-from-the-env-0123456789abcdef";
const PROVIDER_KEY = "provider-key-from-the-env-0123456789";

let root = "";
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

/** A link at `path` to the directory `target`: a junction on Windows (no privilege needed), a symlink elsewhere. */
function linkDirectory(target: string, path: string): void {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

/**
 * `sai config build` itself (scripts/config-layout.mjs), run on a copy of its scripts in `repo` so
 * it builds that layout; the same harness as workspace-zone-links.test.ts. A fork's product.json
 * goes along, so the build names its file as the loader does.
 */
function runBuild(repo: string): { status: number | null; stdout: string; stderr: string } {
  mkdirSync(join(repo, "scripts"), { recursive: true });
  for (const script of ["config-layout.mjs", "config-shards.mjs", "config-zones.mjs", "product.mjs"]) {
    copyFileSync(join(REPO_ROOT, "scripts", script), join(repo, "scripts", script));
  }
  if (existsSync(join(REPO_ROOT, "product.json"))) copyFileSync(join(REPO_ROOT, "product.json"), join(repo, "product.json"));
  // The build's one dependency, where node resolves it from the copy.
  const json5 = dirname(createRequire(join(REPO_ROOT, "scripts", "config-layout.mjs")).resolve("json5/package.json"));
  mkdirSync(join(repo, "node_modules"), { recursive: true });
  linkDirectory(json5, join(repo, "node_modules", "json5"));
  const run = spawnSync(process.execPath, [join(repo, "scripts", "config-layout.mjs"), "build"], { cwd: repo, encoding: "utf8" });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

/** A two-zone layout with JSONC comments, a key left to its schema default and a configRemovals entry. */
function writeLayout(repo: string): { config: string; workspace: string } {
  const config = join(repo, "config");
  const workspace = join(repo, "workspace");
  mkdirSync(join(config, "providers"), { recursive: true });
  mkdirSync(join(config, "gateway"), { recursive: true });
  mkdirSync(join(workspace, "agents"), { recursive: true });
  writeFileSync(join(config, "providers", "10-providers.jsonc"), `{
  // The operator's model server; its key comes from the env.
  "providers": { "lmstudio": { "baseUrl": "http://model-host:1234/v1", "apiKey": "lm-studio" } }
}
`);
  writeFileSync(join(config, "gateway", "10-gateway.jsonc"), `{ "gateway": { "port": 18765 } }\n`);
  writeFileSync(join(workspace, "agents", "10-agents.jsonc"), JSON.stringify({
    subAgents: {
      coder: { description: "Writes code." },
      retired: { description: "Removed by a later shard." },
    },
  }, null, 2));
  writeFileSync(join(workspace, "agents", "60-removals.jsonc"), JSON.stringify({ configRemovals: ["subAgents.retired"] }, null, 2));
  return { config, workspace };
}

/** The loader, fresh, reading `layout` as it does from the repository root, with secrets in the env. */
async function loaderFor(layout: { config: string; workspace: string }) {
  process.env["SAI_CONFIG_PATH"] = layout.config;
  process.env["SAI_WORKSPACE_CONFIG_PATH"] = layout.workspace;
  delete process.env["SAI_MUTABLE_CONFIG_PATH"];
  process.env["SAI_JWT_SECRET"] = JWT_SECRET;
  process.env["SAI_PRIMARY_MODEL_KEY"] = PROVIDER_KEY;
  vi.resetModules();
  return import("../config/loader.js");
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return condition();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sai-config-build-output-"));
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
});

afterEach(async () => {
  (await import("../config/loader.js")).resetConfigForTests();
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
  rmSync(root, { recursive: true, force: true });
});

describe("the file `sai config build` writes", () => {
  it("stays byte for byte through a load, a save and a reload from the repository root", async () => {
    const layout = writeLayout(root);
    const build = runBuild(root);
    expect(build.status, build.stderr).toBe(0);
    const builtPath = join(root, PRODUCT.configFileName);
    const built = readFileSync(builtPath);
    expect(JSON.parse(built.toString("utf8"))).toMatchObject({ configRemovals: ["subAgents.retired"], gateway: { port: 18765 } });

    const loader = await loaderFor(layout);

    // A cold boot: the env is laid over and the removal applied, in memory only.
    const config = loader.loadConfig();
    expect(config.gateway.jwtSecret).toBe(JWT_SECRET);
    expect(config.providers.lmstudio?.apiKey).toBe(PROVIDER_KEY);
    expect(Object.keys(config.subAgents)).toEqual(["coder"]);
    expect(readFileSync(builtPath).equals(built)).toBe(true);

    // A settings save goes to the runtime overlay in workspace/runtime/, never to the built file.
    const saved = loader.updateConfig((raw) => {
      (raw["gateway"] as Record<string, unknown>)["port"] = 18766;
    });
    expect(saved.gateway.port).toBe(18766);
    expect(readFileSync(join(layout.workspace, "runtime", "runtime.overrides.json"), "utf8")).toContain("18766");
    expect(readFileSync(builtPath).equals(built)).toBe(true);

    // A shard edit, picked up by the watcher: the reload changes a section and notifies.
    const onChange = vi.fn();
    loader.watchConfig(onChange);
    writeFileSync(join(layout.workspace, "agents", "10-agents.jsonc"), JSON.stringify({
      subAgents: { coder: { description: "Writes tests." }, retired: { description: "Removed by a later shard." } },
    }, null, 2));
    expect(await waitFor(() => onChange.mock.calls.length > 0, 10_000)).toBe(true);
    expect(loader.getConfig().subAgents["coder"]?.description).toBe("Writes tests.");
    expect(readFileSync(builtPath).equals(built)).toBe(true);

    const text = readFileSync(builtPath, "utf8");
    expect(text).not.toContain(JWT_SECRET);
    expect(text).not.toContain(PROVIDER_KEY);
  });

  it("is not created by a load where no build has run", async () => {
    const layout = writeLayout(root);
    const loader = await loaderFor(layout);
    expect(Object.keys(loader.loadConfig().subAgents)).toEqual(["coder"]);
    expect(existsSync(join(root, PRODUCT.configFileName))).toBe(false);
  });
});
