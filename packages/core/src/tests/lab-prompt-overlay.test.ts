import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { PRODUCT } from "../product/index.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The harness lab's in-memory prompt overlay (config/loader.ts applyLabPromptOverlay): a candidate
 * harness's prompts for one arm of a lab run, never saved, and only in the lab's own process.
 */

const dirs: string[] = [];

function deployment(): string {
  const dir = mkdtempSync(join(tmpdir(), "lab-overlay-"));
  dirs.push(dir);
  writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
    workspacePath: dir,
    agents: { mainAssistant: { customInstructions: "Answer in the user's language." } },
    subAgents: {
      researcher: { description: "Researches.", systemPrompt: "You research carefully.", tools: [] },
    },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
  return dir;
}

async function load() {
  vi.resetModules();
  const loader = await import("../config/loader.js");
  loader.resetConfigForTests();
  const { defaultSystemPrompt } = await import("../agent/session.js");
  return { loader, defaultSystemPrompt };
}

describe("lab prompt overlay", () => {
  beforeEach(() => { process.env["SAI_HARNESS_LAB_PROCESS"] = "1"; });
  afterEach(async () => {
    delete process.env["SAI_HARNESS_LAB_PROCESS"];
    delete process.env["SAI_CONFIG_PATH"];
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("lays a candidate's prompts over the loaded config and restores the originals exactly", async () => {
    deployment();
    const { loader, defaultSystemPrompt } = await load();
    const before = defaultSystemPrompt();
    const researcherBefore = loader.getConfig().subAgents["researcher"];

    const restore = loader.applyLabPromptOverlay({
      mainAssistantInstructions: "Answer in the user's language.\nVerify every figure before you report it.",
      subAgentPrompts: { researcher: "You research carefully. Cite each source you used." },
    });
    expect(defaultSystemPrompt()).toContain("Verify every figure before you report it.");
    expect(loader.getConfig().subAgents["researcher"]?.systemPrompt).toBe("You research carefully. Cite each source you used.");
    // A candidate's agent stays a configured one: proposals for it are still possible.
    expect(loader.isRuntimeSubAgent("researcher")).toBe(false);

    restore();
    expect(defaultSystemPrompt()).toBe(before);
    expect(loader.getConfig().subAgents["researcher"]).toBe(researcherBefore);
  });

  it("is laid back over a reload while in force, and gone after restore", async () => {
    deployment();
    const { loader } = await load();
    const restore = loader.applyLabPromptOverlay({ subAgentPrompts: { researcher: "Candidate prompt." } });
    loader.resetConfigForTests();
    expect(loader.getConfig().subAgents["researcher"]?.systemPrompt).toBe("Candidate prompt.");
    restore();
    loader.resetConfigForTests();
    expect(loader.getConfig().subAgents["researcher"]?.systemPrompt).toBe("You research carefully.");
  });

  it("refuses outside the lab process, an unknown agent, and a second overlay", async () => {
    deployment();
    const { loader } = await load();
    expect(() => loader.applyLabPromptOverlay({ subAgentPrompts: { nobody: "x" } })).toThrow(/nobody/);
    const restore = loader.applyLabPromptOverlay({ mainAssistantInstructions: "x" });
    expect(() => loader.applyLabPromptOverlay({ mainAssistantInstructions: "y" })).toThrow(/already/);
    restore();
    delete process.env["SAI_HARNESS_LAB_PROCESS"];
    expect(() => loader.applyLabPromptOverlay({ mainAssistantInstructions: "x" })).toThrow(/harness-lab process/);
  });

  it("the lab process never writes the compiled config or the runtime overlay", async () => {
    // A shard directory, as deployed: only that layout writes a compiled artifact (next to it).
    const root = mkdtempSync(join(tmpdir(), "lab-overlay-shards-"));
    dirs.push(root);
    const configDir = join(root, "starling_config");
    mkdirSync(join(configDir, "agents"), { recursive: true });
    writeFileSync(join(configDir, "agents", "10-researcher.json"), JSON.stringify({
      subAgents: { researcher: { description: "Researches.", systemPrompt: "You research carefully.", tools: [] } },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configDir;
    const compiled = join(root, PRODUCT.configFileName);

    const { loader } = await load();
    loader.applyLabPromptOverlay({ subAgentPrompts: { researcher: "Candidate prompt." } });
    loader.resetConfigForTests();
    expect(loader.loadConfig().subAgents["researcher"]?.systemPrompt).toBe("Candidate prompt.");
    expect(existsSync(compiled)).toBe(false);
    expect(() => loader.updateConfig(() => undefined)).toThrow(/does not change/);
    expect(existsSync(join(configDir, "runtime"))).toBe(false);

    // The same load outside the lab process writes it: the check above can fail.
    delete process.env["SAI_HARNESS_LAB_PROCESS"];
    const outside = await load();
    outside.loader.loadConfig();
    expect(existsSync(compiled)).toBe(true);
  });
});
