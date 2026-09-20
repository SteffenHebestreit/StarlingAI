/**
 * Surfacing near misses to the model when routing admitted nobody.
 *
 * The branch this exercises used to say "No agents matched X ... or use create_ephemeral_agent
 * only if this is a brand-new capability", which invites inventing a specialist. Measured
 * against the live catalog, that message is usually wrong about its own premise: 7 of 25
 * German requests admitted NOTHING while the correct agent sat just under the gate, and
 * "ich braeuchte jemanden im schwarm fuer uebersetzungen" put swarm_maintainer at 0.7115
 * against a 0.72 floor.
 *
 * `orchestration.surfaceRoutingNearMisses` replaces "nothing exists" with "nothing cleared
 * the bar, and here is what came closest". It admits nothing and lowers no floor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cosFor = (routingScore: number): number => routingScore * 2 - 1;
const vectorAt = (cos: number): Float32Array => new Float32Array([cos, Math.sqrt(Math.max(0, 1 - cos * cos))]);

const AGENTS = {
  swarm_maintainer: {
    description: "Maintains the swarm's own agents and scenes.",
    capabilities: ["agent authoring"], tags: ["swarm"], tools: ["write_file"], maxIterations: 4,
  },
  notification_agent: {
    description: "Sends notifications to channels.",
    capabilities: ["notify"], tags: ["comms"], tools: ["write_file"], maxIterations: 4,
  },
};

/** Both agents land just under the 0.72 gate, the shape the live run produced. */
const PLACEMENT: Record<string, number> = { swarm_maintainer: 0.7115, notification_agent: 0.7086 };

let tempDir: string | undefined;

async function searchWith(surfaceRoutingNearMisses: boolean) {
  vi.resetModules();
  tempDir = mkdtempSync(join(tmpdir(), "starlingai-near-miss-surface-"));
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({
    agents: { defaults: { model: { primary: "lmstudio/qwen", embeddingModel: "lmstudio/embed" } } },
    subAgents: AGENTS,
    retrieval: { reranker: { enabled: false } },
    orchestration: { surfaceRoutingNearMisses },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configPath;
  // The agent index is cached to disk and keyed by catalog text; without this the second
  // call would read the first call's vectors.
  process.env["SAI_EMBEDDING_CACHE"] = join(tempDir, "embedding-cache.json");

  const provider = {
    embed: vi.fn(async (texts: string[]) => texts.map((text) => {
      if (!text.startsWith("Agent:")) return vectorAt(1);
      const name = Object.keys(PLACEMENT).find((candidate) => text.includes(candidate));
      return vectorAt(cosFor(name ? PLACEMENT[name]! : 0.30));
    })),
  };
  vi.doMock("../providers/index.js", async () => ({
    ...(await vi.importActual<Record<string, unknown>>("../providers/index.js")),
    getEmbeddingProvider: () => provider,
  }));

  const { buildAgentIndex, resetEmbeddingSearchStateForTests } = await import("../providers/embeddings.js");
  resetEmbeddingSearchStateForTests();
  await buildAgentIndex(AGENTS as never, provider as never, "lmstudio/embed");

  // sub-agent.js is what REGISTERS search_agents; importing the registry alone finds an
  // empty one under a reset module registry.
  const [{ getTool }] = await Promise.all([
    import("../tools/registry.js"),
    import("../tools/sub-agent.js"),
  ]);
  const searchAgents = getTool("search_agents");
  if (!searchAgents) throw new Error("search_agents tool is not registered");
  return searchAgents.execute(
    { query: "ich braeuchte jemanden im schwarm fuer uebersetzungen", minConfidence: "high" },
    { sessionId: "near-miss-test", workspacePath: "/workspace" },
  );
}

describe("surfacing routing near misses", () => {
  beforeEach(() => {
    delete process.env["SAI_CONFIG_PATH"];
    delete process.env["SAI_EMBEDDING_CACHE"];
  });
  afterEach(async () => {
    vi.doUnmock("../providers/index.js");
    delete process.env["SAI_CONFIG_PATH"];
    delete process.env["SAI_EMBEDDING_CACHE"];
    if (tempDir) { rmSync(tempDir, { recursive: true, force: true }); tempDir = undefined; }
    vi.resetModules();
    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
  });

  it("names the agents that came closest, and says they were below the bar", async () => {
    const result = await searchWith(true);

    expect(result.success).toBe(true);
    expect(result.output).toContain("No agents matched");
    expect(result.output).toContain("Closest matches");
    expect(result.output).toContain("swarm_maintainer");
    // The score must travel with the name. A bare name reads as a recommendation; the number
    // is what makes it a near miss the model can weigh.
    expect(result.output).toContain("0.71");
    // The bar named must be the SEMANTIC ADMISSION FLOOR, not the requested confidence
    // level: sub-floor scores are zeroed before minConfidence is consulted, so 0.72 is what
    // actually applied. Printing "below the medium bar" beside a 0.71 would be nonsense,
    // since medium's own threshold is 0.45.
    expect(result.output).toContain("below the 0.72 semantic admission floor");
    expect(result.output).not.toContain("confidence bar");
    // Nothing was admitted, and the message must not pretend otherwise.
    expect((result.metadata as { resultCount: number }).resultCount).toBe(0);
  });

  it("stays silent with the flag off, which is the default", async () => {
    const result = await searchWith(false);

    // Discriminance control: identical catalog, identical scores, one config value.
    expect(result.output).toContain("No agents matched");
    expect(result.output).not.toContain("Closest matches");
    expect(result.output).not.toContain("swarm_maintainer");
  });

  it("records the near misses in metadata either way, so the flag's effect is measurable", async () => {
    const on = await searchWith(true);
    const off = await searchWith(false);

    for (const result of [on, off]) {
      const nearMisses = (result.metadata as { nearMisses?: Array<{ name: string; score: number }> }).nearMisses;
      expect(nearMisses, "metadata must carry the near misses regardless of the flag").toBeDefined();
      expect(nearMisses!.map((entry) => entry.name)).toContain("swarm_maintainer");
    }
  });
});
