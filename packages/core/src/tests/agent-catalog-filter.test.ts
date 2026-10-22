import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../tools/registry.js";

/**
 * E2E 2026-10-22: a workflow step looked up its scene's next agents as "evidence analyst" and
 * "source verifier", found none (they are named evidence_analyst and source_verifier), and
 * delegated the step to no agent.
 */
describe("agent_catalog's filter", () => {
  let tempDir = "";
  afterEach(async () => {
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env["SAI_CONFIG_PATH"];
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
  });

  const catalog = async (filter: string) => {
    tempDir = mkdtempSync(join(tmpdir(), "sai-agent-catalog-"));
    writeFileSync(join(tempDir, "starlingai.json"), JSON.stringify({
      workspacePath: tempDir,
      subAgents: {
        evidence_analyst: { description: "Builds an evidence ledger.", systemPrompt: "Test.", tools: [], maxIterations: 2 },
        source_verifier: { description: "Checks claims against their sources.", systemPrompt: "Test.", tools: [], capabilities: ["claim-to-source checking"], maxIterations: 2 },
        summarizer: { description: "Condenses text.", systemPrompt: "Test.", tools: [], maxIterations: 2 },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = join(tempDir, "starlingai.json");
    vi.resetModules();
    const { getTool } = await import("../tools/registry.js");
    await import("../tools/sub-agent.js");
    return getTool("agent_catalog")!.execute({ filter }, { sessionId: "catalog-filter", workspacePath: tempDir } as ToolContext);
  };

  it.each([
    ["evidence analyst", "evidence_analyst"],
    ["Source-Verifier", "source_verifier"],
    ["claim to source", "source_verifier"],
    ["evidence_analyst", "evidence_analyst"],
  ])("finds %s as %s", async (filter, name) => {
    const result = await catalog(filter);
    expect(result.output).toContain(name);
    expect(result.metadata?.["count"]).toBe(1);
  }, 30_000);
});
