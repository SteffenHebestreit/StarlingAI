/**
 * The discovery prefetch hands its capsule's agent names to an observer (the intent readout's
 * shadow, agent/intent-shadow.ts): exactly the agents the capsule lists, in its order — meta-factory
 * agents dropped and cut to maxAgents as the capsule is — and an observer's failure never costs the
 * capsule.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../tools/sub-agent.js", () => ({
  resolveAgentRouting: vi.fn(async () => ({
    results: [
      { name: "agent_factory", description: "Mints agents", confidence: "high" },
      { name: "researcher", description: "Finds sources", confidence: "high" },
      { name: "web_coder", description: "Builds sites", confidence: "medium" },
      { name: "data_analyst", description: "Tables", confidence: "medium" },
      { name: "writer", description: "Prose", confidence: "medium" },
      { name: "illustrator", description: "Images", confidence: "medium" },
    ],
  })),
}));
vi.mock("../tools/agent-routing.js", () => ({
  agentIsMetaFactory: (name: string) => name === "agent_factory",
  logRoutingEvaluated: () => {},
}));
vi.mock("../tools/workflow-catalog.js", () => ({ searchWorkflowCandidates: vi.fn(async () => []) }));

import { prefetchCapabilityCandidates } from "../agent/discovery-prefetch.js";
import { searchWorkflowCandidates } from "../tools/workflow-catalog.js";

describe("prefetchCapabilityCandidates onAgents", () => {
  it("names exactly the capsule's agents, in its order", async () => {
    const seen: string[][] = [];
    const capsule = await prefetchCapabilityCandidates("build me a site", { onAgents: (names) => seen.push([...names]) });
    expect(seen).toEqual([["researcher", "web_coder", "data_analyst", "writer"]]);
    const listed = capsule.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2).split(" ")[0]);
    expect(listed).toEqual(seen[0]);
  });

  it("honours maxAgents, and keeps the capsule when the observer throws", async () => {
    const seen: string[][] = [];
    await prefetchCapabilityCandidates("build me a site", { maxAgents: 2, onAgents: (names) => seen.push([...names]) });
    expect(seen).toEqual([["researcher", "web_coder"]]);
    const capsule = await prefetchCapabilityCandidates("build me a site", { onAgents: () => { throw new Error("observer"); } });
    expect(capsule).toContain("- researcher");
  });
});

// A scene or job step's turn runs without search_workflows and run_workflow (agent/runtime.ts). Its
// task matches the workflow it is running, so a capsule with workflows told it to "consider
// run_workflow" for that very workflow, with a tool it cannot call.
describe("prefetchCapabilityCandidates withoutWorkflows", () => {
  const RUNNING = { name: "verified_research_brief", workflowType: "scene", description: "Fact-checked brief." };

  it("looks up and names no workflow", async () => {
    vi.mocked(searchWorkflowCandidates).mockClear();
    vi.mocked(searchWorkflowCandidates).mockResolvedValue([RUNNING] as never);
    const capsule = await prefetchCapabilityCandidates("write the brief", { withoutWorkflows: true });
    expect(searchWorkflowCandidates).not.toHaveBeenCalled();
    expect(capsule).not.toContain("run_workflow");
    expect(capsule).not.toContain("verified_research_brief");
    expect(capsule).toContain("- researcher");
  });

  it("control: without it the capsule names the matched workflow", async () => {
    vi.mocked(searchWorkflowCandidates).mockResolvedValue([RUNNING] as never);
    const capsule = await prefetchCapabilityCandidates("write the brief");
    expect(capsule).toContain("- verified_research_brief (scene)");
  });
});
