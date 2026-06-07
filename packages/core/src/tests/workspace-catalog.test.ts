import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import JSON5 from "json5";

// Sub-agents are sharded into role-based files under workspace/agents/ — merge them all rather
// than reading a single monolith, so the catalog assertions are robust to the file layout.
const agentsDir = fileURLToPath(new URL("../../../../workspace/agents/", import.meta.url));
const scenesDir = fileURLToPath(new URL("../../../../workspace/scenes/", import.meta.url));

type AgentCatalog = { subAgents: Record<string, { description?: string; tools?: string[]; systemPrompt?: string }> };
type SceneCatalog = { scenes: Record<string, { allowedAgents?: string[]; description?: string }> };

function readJsonFile<T>(path: string): T {
  return JSON5.parse(readFileSync(path, "utf8")) as T;
}

function loadAgentCatalog(): AgentCatalog {
  const merged: AgentCatalog = { subAgents: {} };
  for (const file of readdirSync(agentsDir)) {
    if (!file.endsWith(".jsonc")) continue;
    const raw = readJsonFile<{ subAgents?: AgentCatalog["subAgents"] }>(join(agentsDir, file));
    Object.assign(merged.subAgents, raw.subAgents ?? {});
  }
  return merged;
}

// Scenes are sharded into category files under workspace/scenes/ — merge them all.
function loadSceneCatalog(): SceneCatalog {
  const merged: SceneCatalog = { scenes: {} };
  for (const file of readdirSync(scenesDir)) {
    if (!file.endsWith(".jsonc")) continue;
    const raw = readJsonFile<{ scenes?: SceneCatalog["scenes"] }>(join(scenesDir, file));
    Object.assign(merged.scenes, raw.scenes ?? {});
  }
  return merged;
}

// Scene catalog is optional — the workspace can run agent-only when an
// operator deletes workspace/scenes/.  Tests that touch the scene file
// short-circuit cleanly when it isn't present rather than throwing on
// readFileSync.
const scenesPresent = existsSync(scenesDir);

describe("workspace catalog integrity", () => {
  it("keeps the new specialist agents present in the workspace catalog", () => {
    const catalog = loadAgentCatalog();

    expect(catalog.subAgents["api_integrator"]?.description).toBeTruthy();
    expect(catalog.subAgents["distance_specialist"]?.description).toBeTruthy();
    expect(catalog.subAgents["git_developer"]?.description).toBeTruthy();
    expect(catalog.subAgents["swarm_maintainer"]?.description).toBeTruthy();
    expect(catalog.subAgents["translator"]?.description).toBeTruthy();
    expect(catalog.subAgents["project_planner"]?.description).toBeTruthy();
    expect(catalog.subAgents["notification_agent"]?.description).toBeTruthy();
    expect(catalog.subAgents["browser_agent"]?.description).toBeTruthy();
  });

  it("keeps browser_agent wired for Playwright navigation and evidence capture", () => {
    const catalog = loadAgentCatalog();
    const browserAgent = catalog.subAgents["browser_agent"];

    expect(browserAgent?.tools).toEqual(expect.arrayContaining([
      "browser_navigate",
      "browser_snapshot",
      "browser_screenshot",
    ]));
    expect(browserAgent?.systemPrompt).toContain("call get_site_credentials before the first navigation step");
    expect(browserAgent?.systemPrompt).toContain("use those saved URLs instead of the homepage or a guessed path");
  });

  it.skipIf(!scenesPresent)("keeps the new scenes present in the workspace catalog", () => {
    const catalog = loadSceneCatalog();

    // The scene catalog evolves alongside agent and workflow refactors;
    // earlier iterations of this test enumerated specific names that have
    // since been retired (`browser_inspection`, `api_test_suite`). Assert
    // against the load-bearing scenes that the workspace ships today —
    // these are referenced by the runtime's research and broadcast
    // routing paths and are required for those flows to work.
    expect(catalog.scenes["code_review"]?.description).toBeTruthy();
    expect(catalog.scenes["multi_channel_broadcast"]?.description).toBeTruthy();
    expect(catalog.scenes["source_backed_paper"]?.description).toBeTruthy();
  });

  it.skipIf(!scenesPresent)("ensures every scene allowedAgents entry points to a defined sub-agent", () => {
    const agents = loadAgentCatalog();
    const scenes = loadSceneCatalog();
    const agentNames = new Set(Object.keys(agents.subAgents));

    const missingReferences: string[] = [];
    for (const [sceneName, scene] of Object.entries(scenes.scenes)) {
      for (const agentName of scene.allowedAgents ?? []) {
        if (!agentNames.has(agentName)) {
          missingReferences.push(`${sceneName} -> ${agentName}`);
        }
      }
    }

    expect(missingReferences).toEqual([]);
  });
});