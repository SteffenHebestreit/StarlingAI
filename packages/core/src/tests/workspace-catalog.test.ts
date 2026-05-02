import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import JSON5 from "json5";

const agentsPath = fileURLToPath(new URL("../../../../workspace/agents/20-subagents-general.jsonc", import.meta.url));
const scenesPath = fileURLToPath(new URL("../../../../workspace/scenes/10-scenes.jsonc", import.meta.url));

type AgentCatalog = { subAgents: Record<string, { description?: string; tools?: string[]; systemPrompt?: string }> };
type SceneCatalog = { scenes: Record<string, { allowedAgents?: string[]; description?: string }> };

function readJsonFile<T>(path: string): T {
  return JSON5.parse(readFileSync(path, "utf8")) as T;
}

// Scene catalog is optional — the workspace can run agent-only when an
// operator deletes workspace/scenes/.  Tests that touch the scene file
// short-circuit cleanly when it isn't present rather than throwing on
// readFileSync.
const scenesPresent = existsSync(scenesPath);

describe("workspace catalog integrity", () => {
  it("keeps the new specialist agents present in the workspace catalog", () => {
    const catalog = readJsonFile<AgentCatalog>(agentsPath);

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
    const catalog = readJsonFile<AgentCatalog>(agentsPath);
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
    const catalog = readJsonFile<SceneCatalog>(scenesPath);

    expect(catalog.scenes["browser_inspection"]?.description).toBeTruthy();
    expect(catalog.scenes["code_review"]?.description).toBeTruthy();
    expect(catalog.scenes["api_test_suite"]?.description).toBeTruthy();
    expect(catalog.scenes["multi_channel_broadcast"]?.description).toBeTruthy();
    expect(catalog.scenes["source_backed_paper"]?.description).toBeTruthy();
  });

  it.skipIf(!scenesPresent)("ensures every scene allowedAgents entry points to a defined sub-agent", () => {
    const agents = readJsonFile<AgentCatalog>(agentsPath);
    const scenes = readJsonFile<SceneCatalog>(scenesPath);
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