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
