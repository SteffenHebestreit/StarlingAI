/**
 * Near-miss telemetry: the scores the admission floor throws away.
 *
 * computeHybridRoutingScore turns any sub-floor semantic score into a hard 0, and the
 * ranking then filters `> 0`. So a query where every agent scored 0.71 against the 0.72 gate
 * produced exactly the same log row as a query nothing matched at all — resultCount 0,
 * weakCount 0, gated false. That is the shape of the e1151d8 incident (49 agents at 0.7059)
 * and of a German paraphrase landing a few hundredths under a gate its English twin clears.
 *
 * Measured against the live backend before this was added: "ich braeuchte jemanden im schwarm
 * fuer uebersetzungen" put swarm_maintainer — the correct agent — at 0.7115, and routing
 * reported nothing at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FLOOR = 0.72;
/** routing score = (cos + 1) / 2, so a target routing score inverts to this cosine. */
const cosFor = (routingScore: number): number => routingScore * 2 - 1;

/** A unit vector at a given cosine to the query direction [1, 0]. */
function vectorAt(cos: number): Float32Array {
  return new Float32Array([cos, Math.sqrt(Math.max(0, 1 - cos * cos))]);
}

const AGENTS = {
  near_miss_agent: {
    description: "Handles the thing the query is about.", capabilities: ["work"], tags: ["work"],
    tools: ["web_search"], maxIterations: 4,
  },
  other_near_agent: {
    description: "Also handles the thing, slightly less well.", capabilities: ["work"], tags: ["work"],
    tools: ["web_search"], maxIterations: 4,
  },
  strong_agent: {
    description: "The clearly correct specialist.", capabilities: ["work"], tags: ["work"],
    tools: ["web_search"], maxIterations: 4,
  },
};

/**
 * Place each agent at an exact cosine from the query. `scores` maps agent name to the
 * ROUTING score it should end up with, so a test states the gate-relative position it means.
 */
function providerPlacing(scores: Record<string, number>): unknown {
  return {
    embed: vi.fn(async (texts: string[]) => texts.map((text) => {
      if (!text.startsWith("Agent:")) return vectorAt(1);
      const name = Object.keys(scores).find((candidate) => text.includes(candidate));
      return vectorAt(name ? cosFor(scores[name]!) : cosFor(0.30));
    })),
  };
}

let tempDir: string | undefined;

async function resolveWith(scores: Record<string, number>, agents: Record<string, unknown> = AGENTS) {
  vi.resetModules();
  tempDir = mkdtempSync(join(tmpdir(), "starlingai-near-miss-"));
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({
    agents: { defaults: { model: { primary: "lmstudio/qwen", embeddingModel: "lmstudio/embed" } } },
    subAgents: agents,
    retrieval: { reranker: { enabled: false } },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configPath;
  // The agent embedding index is CACHED TO DISK, keyed by the catalog text. Two tests
  // using the same agent set therefore silently share vectors: the second one loads the
  // first one's placements and quietly measures the wrong scores. Without this the
  // "something was admitted" cases read back the previous test's sub-floor numbers and
  // looked like a bug in the code under test. It also keeps the run from writing into
  // packages/core/.starlingai.
  process.env["SAI_EMBEDDING_CACHE"] = join(tempDir, "embedding-cache.json");

  const provider = providerPlacing(scores);
  // doMock, not the hoisted vi.mock: inside a resetModules registry a hoisted mock does not
  // apply and the real provider factory runs instead.
  vi.doMock("../providers/index.js", async () => ({
    ...(await vi.importActual<Record<string, unknown>>("../providers/index.js")),
    getEmbeddingProvider: () => provider,
  }));

  const { buildAgentIndex, resetEmbeddingSearchStateForTests } = await import("../providers/embeddings.js");
  resetEmbeddingSearchStateForTests();
  await buildAgentIndex(agents as never, provider as never, "lmstudio/embed");
  const { resolveAgentRouting } = await import("../tools/agent-routing.js");
  return resolveAgentRouting("do the work", { minConfidence: "high" });
}

describe("near-miss telemetry", () => {
  beforeEach(() => {
    delete process.env["SAI_CONFIG_PATH"];
    delete process.env["SAI_EMBEDDING_CACHE"];
  });
  afterEach(() => {
    vi.doUnmock("../providers/index.js");
    vi.resetModules();
    delete process.env["SAI_CONFIG_PATH"];
    delete process.env["SAI_EMBEDDING_CACHE"];
    if (tempDir) { rmSync(tempDir, { recursive: true, force: true }); tempDir = undefined; }
  });

  it("reports the agents the floor discarded when nothing is admitted", async () => {
    const resolution = await resolveWith({
      near_miss_agent: 0.7115,
      other_near_agent: 0.7050,
      strong_agent: 0.6900,
    });

    // The condition the incident produced: routing found nothing.
    expect(resolution.results).toHaveLength(0);
    // ...and the scores that caused it are now on the record rather than zeroed away.
    expect(resolution.nearMisses.map((entry) => entry.name)).toEqual([
      "near_miss_agent", "other_near_agent", "strong_agent",
    ]);
    for (const entry of resolution.nearMisses) {
      expect(entry.score).toBeLessThan(FLOOR);
      expect(entry.score).toBeGreaterThan(0.6);
    }
    expect(resolution.nearMisses[0]!.score).toBeCloseTo(0.7115, 3);
  });

  it("stays empty when a candidate clears the floor, so a healthy turn logs nothing extra", async () => {
    const resolution = await resolveWith({
      strong_agent: 0.8600,
      near_miss_agent: 0.7115,
      other_near_agent: 0.7050,
    });

    // Discriminance control for the case above: the SAME two sub-floor agents, but something
    // was admitted. The field explains an empty result; on a healthy turn it must stay silent,
    // or every audit row carries three names nobody would act on.
    expect(resolution.results.length).toBeGreaterThan(0);
    expect(resolution.results[0]!.name).toBe("strong_agent");
    expect(resolution.nearMisses).toEqual([]);
  });

  it("puts the near misses on the audit row, where an operator would see them", async () => {
    const rows: Array<{ event: string; data: Record<string, unknown> }> = [];
    vi.resetModules();
    // doMock, not a hoisted vi.mock: inside a resetModules registry the hoisted form does not
    // apply and the REAL logger runs, so the assertion below would find nothing and pass.
    vi.doMock("../audit/logger.js", async () => ({
      ...(await vi.importActual<Record<string, unknown>>("../audit/logger.js")),
      logAudit: (event: string, data: Record<string, unknown>) => { rows.push({ event, data }); },
    }));

    const resolution = await resolveWith({
      near_miss_agent: 0.7115,
      other_near_agent: 0.7050,
      strong_agent: 0.6900,
    });
    const { logRoutingEvaluated } = await import("../tools/agent-routing.js");
    logRoutingEvaluated({ surface: "delegation", query: "do the work", resolution });

    const row = rows.find((entry) => entry.event === "agent_routing_evaluated");
    expect(row, "no agent_routing_evaluated row was emitted").toBeDefined();
    expect(row!.data["resultCount"]).toBe(0);
    expect(row!.data["weakCount"]).toBe(0);
    // Without this field the row above is indistinguishable from a query nothing matched.
    expect(row!.data["nearMisses"]).toEqual([
      { name: "near_miss_agent", score: 0.7115 },
      { name: "other_near_agent", score: 0.705 },
      { name: "strong_agent", score: 0.69 },
    ]);
    vi.doUnmock("../audit/logger.js");
  });

  it("caps the list so a wide catalog cannot flood the audit row", async () => {
    const many = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [
      `agent_${index}`,
      { description: `Worker ${index}.`, capabilities: ["work"], tags: ["work"], tools: ["web_search"], maxIterations: 4 },
    ]));
    const scores = Object.fromEntries(Object.keys(many).map((name, index) => [name, 0.715 - index * 0.002]));

    const resolution = await resolveWith(scores, many);
    expect(resolution.results).toHaveLength(0);
    expect(resolution.nearMisses).toHaveLength(3);
    // Highest first: the closest miss is the one worth acting on.
    expect(resolution.nearMisses[0]!.score).toBeGreaterThan(resolution.nearMisses[2]!.score);
  });
});
