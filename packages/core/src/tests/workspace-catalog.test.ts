import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import JSON5 from "json5";
import { loadWorkspaceAgents, loadWorkspaceScenes } from "./support/workspace-shards.js";

// Sub-agents are sharded into role-based files under workspace/agents/ — merge them all rather
// than reading a single monolith, so the catalog assertions are robust to the file layout.
const agentsDir = fileURLToPath(new URL("../../../../workspace/agents/", import.meta.url));
const scenesDir = fileURLToPath(new URL("../../../../workspace/scenes/", import.meta.url));

type AgentCatalog = { subAgents: Record<string, { description?: string; capabilities?: string[]; tools?: string[]; systemPrompt?: string }> };
type SceneCatalog = { scenes: Record<string, { allowedAgents?: string[]; description?: string }> };

function readJsonFile<T>(path: string): T {
  return JSON5.parse(readFileSync(path, "utf8")) as T;
}

function loadAgentCatalog(): AgentCatalog {
  // Per-ENTRY merge: shards are overlays, and one that carries a single key per agent
  // (the generated routing taxonomy does) would otherwise replace the whole entry.
  return { subAgents: loadWorkspaceAgents<AgentCatalog["subAgents"][string]>() };
}

// Scenes are sharded into category files under workspace/scenes/ — merge them all.
function loadSceneCatalog(): SceneCatalog {
  return { scenes: loadWorkspaceScenes<SceneCatalog["scenes"][string]>() };
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
    expect(catalog.subAgents["git_developer"]?.description).toBeTruthy();
    expect(catalog.subAgents["swarm_maintainer"]?.description).toBeTruthy();
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

  // In the E2E order-form run the form refused express shipping for the article the user named.
  // browser_agent then chose standard shipping itself, resubmitted, and reported an order the user
  // had not asked for. Its prompt tells it to finish the whole task and to stop only at a hard
  // blocker, and said nothing about a refused value, so the refusal read as an obstacle to work
  // around. The line under that rule makes it a stop.
  //
  // Only for a refused CHOICE. The first wording named every "validation error" a hard blocker, and
  // the same fixture form (eval/e2e/site/kontakt.html) shows "Bitte prüfen Sie folgende Angaben: …"
  // whenever a required field is still unset, such as a privacy checkbox whose click did not
  // register. The sibling order-form-reference run completes by ticking it and submitting again,
  // which changes none of the user's choices; so does retyping a value in the format the page asks for.
  it("tells browser_agent that a refused submission is reported, not resubmitted with other choices", () => {
    const prompt = loadAgentCatalog().subAgents["browser_agent"]?.systemPrompt ?? "";
    const rule = "A form that refuses an option or value the user chose IS a hard blocker: report the page's error text and stop; never resubmit with a different choice than the user made (filling in a field you missed, or re-entering the same value in the format the page asks for, is fine).";
    expect(prompt).toContain(rule);
    expect(prompt.indexOf(rule)).toBeGreaterThan(prompt.indexOf("FINISH THE WHOLE TASK IN ONE RUN"));
    expect(prompt).not.toContain("(validation error, refused option)");
  });

  // search_agents ranks agents by an embedding of their catalog text, and the file format is often
  // the most specific word in a request. document_intake names DOCX as a format it READS, while no
  // agent that WRITES one said so: content_writer held generate_docx and generate_pptx, and its own
  // prompt sends DOCX/PPTX to them, but its description and capabilities never named either format.
  // A request to create a Word document then ranked the reader first and content_writer seventh,
  // outside the shortlist the orchestrator reads, and the job went to an agent that cannot produce
  // the file (session fa8bb08b). So each Office format a catalog tool produces is named, in the
  // description and in the capabilities (the text the embedding and the reranker both read), by at
  // least one agent that holds its producer.
  it("names each Office format the catalog can produce on an agent that holds its producer", () => {
    const catalog = loadAgentCatalog();
    const unclaimed: string[] = [];
    for (const [tool, format] of [["generate_docx", "docx"], ["generate_pptx", "pptx"]] as const) {
      const names = (text: string): boolean => text.toLowerCase().split(/[^a-z0-9]+/).includes(format);
      const holders = Object.entries(catalog.subAgents).filter(([, agent]) => agent.tools?.includes(tool));
      expect(holders.length, `no agent holds ${tool}`).toBeGreaterThan(0);
      const claimed = holders.some(([, agent]) => names(agent.description ?? "") && (agent.capabilities ?? []).some(names));
      if (!claimed) unclaimed.push(`${format}: held by ${holders.map(([name]) => name).join(", ")}, named by none of them`);
    }
    expect(unclaimed).toEqual([]);
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