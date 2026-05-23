import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateWorkspaceConfig, resolveConfigRoot } from "../config/validate-workspace.js";

/**
 * Builds a minimal two-zone repo (config/ + workspace/) under a temp dir and
 * returns the workspace path an agent would run with (the workspace/ subdir).
 */
function buildRepo(shards: {
  providers?: unknown;
  subAgents?: Record<string, unknown>;
  scenes?: Record<string, unknown>;
  jobs?: Record<string, unknown>;
}): { repoRoot: string; workspacePath: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), "starlingai-validate-"));
  mkdirSync(join(repoRoot, "config", "providers"), { recursive: true });
  mkdirSync(join(repoRoot, "workspace", "agents"), { recursive: true });
  mkdirSync(join(repoRoot, "workspace", "scenes"), { recursive: true });
  mkdirSync(join(repoRoot, "workspace", "jobs"), { recursive: true });

  // A minimal provider block so the schema has its required-ish surface satisfied.
  writeFileSync(
    join(repoRoot, "config", "providers", "10-providers.jsonc"),
    JSON.stringify({ providers: shards.providers ?? { lmstudio: { baseUrl: "http://x/v1" } } }),
  );
  if (shards.subAgents) {
    writeFileSync(join(repoRoot, "workspace", "agents", "20-subagents.jsonc"), JSON.stringify({ subAgents: shards.subAgents }));
  }
  if (shards.scenes) {
    writeFileSync(join(repoRoot, "workspace", "scenes", "10-scenes.jsonc"), JSON.stringify({ scenes: shards.scenes }));
  }
  if (shards.jobs) {
    writeFileSync(join(repoRoot, "workspace", "jobs", "10-jobs.jsonc"), JSON.stringify({ jobs: shards.jobs }));
  }
  return { repoRoot, workspacePath: join(repoRoot, "workspace") };
}

const AGENT = { description: "x", systemPrompt: "y", tools: ["read_file"] };
const KNOWN_TOOLS = new Set(["read_file", "write_file"]);

describe("validateWorkspaceConfig", () => {
  let cleanup: string[] = [];
  beforeEach(() => { cleanup = []; });
  afterEach(() => { for (const dir of cleanup) rmSync(dir, { recursive: true, force: true }); });

  it("passes a coherent scene/job/agent set", () => {
    const { repoRoot, workspacePath } = buildRepo({
      subAgents: { researcher: AGENT },
      scenes: { daily: { description: "d", task: "t", allowedAgents: ["researcher"] } },
      jobs: { nightly: { description: "d", steps: [{ scene: "daily" }] } },
    });
    cleanup.push(repoRoot);

    const result = validateWorkspaceConfig(workspacePath, KNOWN_TOOLS);
    expect(result.ok).toBe(true);
    expect(result.summary).toEqual({ subAgents: 1, scenes: 1, jobs: 1 });
    expect(result.referenceErrors).toEqual([]);
  });

  it("flags a scene that references an unknown agent", () => {
    const { repoRoot, workspacePath } = buildRepo({
      subAgents: { researcher: AGENT },
      scenes: { daily: { description: "d", task: "t", allowedAgents: ["ghost_agent"] } },
    });
    cleanup.push(repoRoot);

    const result = validateWorkspaceConfig(workspacePath, KNOWN_TOOLS);
    expect(result.ok).toBe(false);
    expect(result.referenceErrors.some((e) => e.includes("ghost_agent") && e.includes("daily"))).toBe(true);
  });

  it("flags a job step that references an unknown scene", () => {
    const { repoRoot, workspacePath } = buildRepo({
      subAgents: { researcher: AGENT },
      scenes: { daily: { description: "d", task: "t", allowedAgents: ["researcher"] } },
      jobs: { nightly: { description: "d", steps: [{ scene: "missing_scene" }] } },
    });
    cleanup.push(repoRoot);

    const result = validateWorkspaceConfig(workspacePath, KNOWN_TOOLS);
    expect(result.ok).toBe(false);
    expect(result.referenceErrors.some((e) => e.includes("missing_scene") && e.includes("nightly"))).toBe(true);
  });

  it("warns (does not fail) on an unregistered tool grant", () => {
    const { repoRoot, workspacePath } = buildRepo({
      subAgents: { researcher: { description: "x", systemPrompt: "y", tools: ["selfdev__future_tool"] } },
    });
    cleanup.push(repoRoot);

    const result = validateWorkspaceConfig(workspacePath, KNOWN_TOOLS);
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.includes("selfdev__future_tool"))).toBe(true);
  });

  it("reports a JSON syntax error in a shard", () => {
    const { repoRoot, workspacePath } = buildRepo({ subAgents: { researcher: AGENT } });
    cleanup.push(repoRoot);
    writeFileSync(join(repoRoot, "workspace", "scenes", "10-scenes.jsonc"), "{ \"scenes\": { broken ");

    const result = validateWorkspaceConfig(workspacePath, KNOWN_TOOLS);
    expect(result.ok).toBe(false);
    expect(result.parseErrors.length).toBeGreaterThan(0);
    expect(result.parseErrors[0]).toContain("scenes/10-scenes.jsonc");
  });

  it("resolves the repo root from a workspace/ subdir path", () => {
    const { repoRoot, workspacePath } = buildRepo({ subAgents: { researcher: AGENT } });
    cleanup.push(repoRoot);
    expect(resolveConfigRoot(workspacePath)).toBe(repoRoot);
  });
});
