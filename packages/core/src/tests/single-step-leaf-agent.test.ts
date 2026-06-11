import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A workflow step scoped to exactly ONE leaf (non-coordinator) agent must run that
 * agent DIRECTLY rather than through a per-step orchestrator — on the slow local model
 * the orchestrator can answer tool-free and never delegate, so the deliverable is never
 * built (audit 4c01ce30: a single-`content_writer` build step shipped a 389-char stub
 * and produced no deck). Topic-neutral: this is the routing decision for ANY single-leaf
 * step, not one specific workflow.
 */
describe("resolveSingleStepLeafAgent", () => {
  afterEach(() => {
    delete process.env["SAI_CONFIG_PATH"];
    vi.resetModules();
  });

  async function load(): Promise<(allowedAgents: string[] | undefined) => string | null> {
    const dir = mkdtempSync(join(tmpdir(), "sai-leaf-step-"));
    const path = join(dir, "starlingai.json");
    writeFileSync(path, JSON.stringify({
      subAgents: {
        content_writer: { description: "Writer", systemPrompt: "Write.", tools: ["generate_presentation", "write_file"] },
        researcher: { description: "Researcher", systemPrompt: "Research.", tools: ["web_search", "share_finding"] },
        // A coordinator owns delegate_to_agent — orchestrating IS its job, so it must NOT
        // be short-circuited into a direct leaf run.
        mission_coordinator: { description: "Coordinator", systemPrompt: "Coordinate.", tools: ["delegate_to_agent", "parallel_delegate"] },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = path;
    vi.resetModules();
    const mod = await import("../tools/workflow-catalog.js");
    return mod.resolveSingleStepLeafAgent;
  }

  it("returns the lone leaf agent so it runs directly", async () => {
    const resolveSingleStepLeafAgent = await load();
    expect(resolveSingleStepLeafAgent(["content_writer"])).toBe("content_writer");
    expect(resolveSingleStepLeafAgent(["researcher"])).toBe("researcher");
  });

  it("returns null for a coordinator (keeps the orchestrator path)", async () => {
    const resolveSingleStepLeafAgent = await load();
    expect(resolveSingleStepLeafAgent(["mission_coordinator"])).toBeNull();
  });

  it("returns null when more than one agent is allowed (a real orchestration choice)", async () => {
    const resolveSingleStepLeafAgent = await load();
    expect(resolveSingleStepLeafAgent(["researcher", "content_writer"])).toBeNull();
  });

  it("returns null for no agents or an unknown agent", async () => {
    const resolveSingleStepLeafAgent = await load();
    expect(resolveSingleStepLeafAgent(undefined)).toBeNull();
    expect(resolveSingleStepLeafAgent([])).toBeNull();
    expect(resolveSingleStepLeafAgent(["does_not_exist"])).toBeNull();
  });
});
