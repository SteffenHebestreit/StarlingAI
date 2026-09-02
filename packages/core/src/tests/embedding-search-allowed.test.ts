import { describe, expect, it, vi } from "vitest";
import { buildAgentIndex, searchByEmbedding } from "../providers/embeddings.js";

const AGENT_COUNT = 10;
const agents = Object.fromEntries(Array.from({ length: AGENT_COUNT }, (_, i) => [
  i === AGENT_COUNT - 1 ? "scene_only_agent" : `general_agent_${i}`,
  {
    description: i === AGENT_COUNT - 1 ? "The scene's own specialist." : `General worker number ${i}.`,
    capabilities: ["work"],
    tags: ["work"],
    tools: ["web_search"],
    maxIterations: 4,
  },
]));

// Nine agents near the query direction; the scene's agent orthogonal to it, so it ranks last.
const provider = {
  embed: vi.fn(async (texts: string[]) => {
    if (texts.every((t) => t.startsWith("Agent:"))) {
      return texts.map((t) => (t.includes("scene_only_agent") || t.includes("scene's own")
        ? new Float32Array([0, 1])
        : new Float32Array([1, 0.01])));
    }
    return [new Float32Array([1, 0])];
  }),
} as unknown as import("../providers/lmstudio.js").LMStudioProvider;

/**
 * A scene's (or a restricted turn's) allowed set used to be applied AFTER the top-8 cut, so a scene
 * whose agents ranked ninth and lower got no semantic candidates at all and fell back to keyword
 * routing without saying so.
 */
describe("semantic agent search honours the allowed set before the top-N cut", () => {
  it("returns the scoped agent that the unscoped top-8 would have cut", async () => {
    await buildAgentIndex(agents, provider, "lmstudio/qwen-embed");

    const open = await searchByEmbedding("do the work", provider, 8);
    expect(open).toHaveLength(8);
    expect(open.map((r) => r.agentName)).not.toContain("scene_only_agent");

    const scoped = await searchByEmbedding("do the work", provider, 8, { allowedAgents: ["scene_only_agent"] });
    expect(scoped.map((r) => r.agentName)).toEqual(["scene_only_agent"]);
  });
});
