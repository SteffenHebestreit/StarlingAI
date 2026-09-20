/**
 * Routing-canary decision logic.
 *
 * The canary's VALUE is that it fails on the two shapes a routing regression takes when
 * ranking still looks fine: an entry crossing the absolute floor, and the whole score
 * distribution sliding. Both are asserted here against a stub scorer, so the logic is gated
 * in CI where no embedding backend exists — the live run against the real catalog is a
 * separate command (routing-canary-cli) that the eval packs invoke with a backend up.
 *
 * Each test states what it discriminates: flip the guard off and the named case passes
 * wrongly, which is the check the house rules require of a new test.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CANARY_FLOORS,
  buildAgentProbes,
  buildSnapshot,
  diffSnapshot,
  formatCanaryReport,
  runCanary,
  type CanaryProbe,
  type CanaryScorer,
} from "../agent/routing-canary.js";
import type { SubAgentConfig } from "../config/schema.js";

function agent(partial: Partial<SubAgentConfig> & { description: string }): SubAgentConfig {
  return {
    capabilities: [],
    tags: [],
    maxIterations: 5,
    ...partial,
  } as unknown as SubAgentConfig;
}

/** A scorer that returns a fixed table: entry → score, ranked descending. */
function tableScorer(table: Record<string, Record<string, number>>, floor = DEFAULT_CANARY_FLOORS.agent): CanaryScorer {
  return async (query: string) => {
    const scores = table[query] ?? {};
    const ranked = Object.entries(scores)
      .map(([name, score]) => ({ name, score }))
      .filter((candidate) => candidate.score >= floor)
      .sort((a, b) => b.score - a.score);
    return { ranked, gated: ranked.length === 0 && Object.keys(scores).length > 0, mode: "hybrid" };
  };
}

describe("buildAgentProbes", () => {
  it("derives probes from the entry's own vocabulary, never from hand-written queries", () => {
    const probes = buildAgentProbes("researcher", agent({
      description: "Finds and verifies external information on any topic. Distinct from source_verifier.",
      capabilities: ["web source research", "citation gathering", "fact verification", "fourth ignored"],
      tags: ["research", "web-search", "sources"],
    }));
    expect(probes.map((probe) => probe.kind)).toEqual(["description", "capability", "capability", "capability", "tag"]);
    // First SENTENCE only: the rest of a description is disambiguation prose ("Distinct
    // from …") that no user would type.
    expect(probes[0]!.query).toBe("Finds and verifies external information on any topic.");
    // Hyphenated tags are probed as words, as a user would phrase them.
    expect(probes.at(-1)!.query).toBe("research, web search, sources");
    expect(probes.every((probe) => probe.entry === "researcher")).toBe(true);
  });

  it("skips vocabulary too thin to retrieve anything", () => {
    const probes = buildAgentProbes("tiny", agent({ description: "Short.", capabilities: ["ok"], tags: ["one"] }));
    // 6-char description, 2-char capability, single tag → nothing probe-worthy.
    expect(probes).toEqual([]);
  });
});

describe("runCanary", () => {
  const probes: CanaryProbe[] = [
    { entry: "researcher", kind: "description", language: "en", query: "q-researcher" },
    { entry: "coder", kind: "description", language: "en", query: "q-coder" },
  ];

  it("passes when every entry retrieves itself first, clear of the floor", async () => {
    const report = await runCanary(probes, tableScorer({
      "q-researcher": { researcher: 0.86, coder: 0.74 },
      "q-coder": { coder: 0.88, researcher: 0.73 },
    }));
    expect(report.passed).toBe(true);
    expect(report.failedProbeCount).toBe(0);
    expect(report.meanBestSelfScore).toBeCloseTo(0.87, 5);
  });

  it("fails an entry that scores above the floor but inside the margin", async () => {
    // 0.75 clears the 0.72 gate — and is one description edit from falling through it.
    // DISCRIMINANCE: with floors.margin = 0 this case passes, which is the blind spot
    // that let a 0.8461 → 0.7059 slide look survivable until it crossed.
    const report = await runCanary(probes, tableScorer({
      "q-researcher": { researcher: 0.75 },
      "q-coder": { coder: 0.9 },
    }));
    expect(report.passed).toBe(false);
    const researcher = report.entries.find((entry) => entry.entry === "researcher")!;
    expect(researcher.failures.join(" ")).toContain("below floor+margin");

    const lenient = await runCanary(probes, tableScorer({
      "q-researcher": { researcher: 0.75 },
      "q-coder": { coder: 0.9 },
    }), { agent: 0.72, margin: 0 });
    expect(lenient.passed).toBe(true);
  });

  it("fails when a sibling outranks the entry on its own vocabulary", async () => {
    const report = await runCanary(probes, tableScorer({
      "q-researcher": { source_verifier: 0.91, researcher: 0.88 },
      "q-coder": { coder: 0.9 },
    }));
    expect(report.passed).toBe(false);
    expect(report.entries.find((entry) => entry.entry === "researcher")!.failures.join(" "))
      .toContain("behind source_verifier");
  });

  it("fails when nothing is admitted at all — the 0-of-49 shape", async () => {
    const report = await runCanary(probes, tableScorer({
      "q-researcher": { researcher: 0.70, coder: 0.69 },
      "q-coder": { coder: 0.71 },
    }));
    expect(report.passed).toBe(false);
    expect(report.outcomes.every((outcome) => outcome.gated)).toBe(true);
    expect(report.meanBestSelfScore).toBeNull();
  });

  it("reports the language slice so an unmeasured one cannot read as green", async () => {
    const report = await runCanary(probes, tableScorer({
      "q-researcher": { researcher: 0.9 },
      "q-coder": { coder: 0.9 },
    }));
    expect(report.byLanguage).toEqual({ en: 2 });
    expect(formatCanaryReport(report)).toContain("German slice is UNMEASURED, not green");
  });
});

describe("diffSnapshot", () => {
  const probes: CanaryProbe[] = [
    { entry: "web_task_coordinator", kind: "description", language: "en", query: "q-wtc" },
    { entry: "researcher", kind: "description", language: "en", query: "q-researcher" },
  ];
  const model = "lmstudio/text-embedding-qwen3-embedding-0.6b";

  async function reportFor(scores: Record<string, number>) {
    return runCanary(probes, tableScorer({
      "q-wtc": { web_task_coordinator: scores["web_task_coordinator"]! },
      "q-researcher": { researcher: scores["researcher"]! },
    }));
  }

  it("fails on the e1151d8 shape: order intact, an entry crosses the floor", async () => {
    const baseline = buildSnapshot(await reportFor({ web_task_coordinator: 0.8461, researcher: 0.86 }), model);
    const regressed = await reportFor({ web_task_coordinator: 0.7059, researcher: 0.80 });

    const diff = diffSnapshot(baseline, regressed, model);
    expect(diff.passed).toBe(false);
    // 0.7059 is BELOW the 0.72 gate, so the entry stops being admitted at all and its
    // score becomes unobservable — `after` is null. The diff must still call this a floor
    // crossing on a still-configured agent, not "entry removed from the catalog".
    expect(diff.floorCrossings).toContainEqual({
      entry: "web_task_coordinator",
      before: 0.8461,
      after: null,
      direction: "fell_below",
    });
    expect(diff.removed).toEqual([]);
    expect(diff.reasons.join(" ")).toContain("fell below the floor");
    // The probe-level run ALSO fails, but the snapshot is what names the regression.
    expect(regressed.passed).toBe(false);
  });

  it("fails on a whole-distribution slide even with no crossing yet", async () => {
    const baseline = buildSnapshot(await reportFor({ web_task_coordinator: 0.90, researcher: 0.90 }), model);
    const slid = await reportFor({ web_task_coordinator: 0.86, researcher: 0.85 });

    const diff = diffSnapshot(baseline, slid, model);
    expect(diff.floorCrossings).toEqual([]);
    expect(diff.passed).toBe(false);
    expect(diff.reasons.join(" ")).toContain("mean self-score shifted");
    // DISCRIMINANCE: a lax threshold accepts the same slide, which is what makes the
    // default 0.02 the guard rather than decoration.
    expect(diffSnapshot(baseline, slid, model, { maxMeanShift: 0.5 }).passed).toBe(true);
  });

  it("does not compare across SCORING PIPELINES either", async () => {
    // The admission floor is applied AFTER the rerank blend, so a run with the reranker and
    // a run without it are different systems measured against the same fixed gate. Measured
    // on the live catalog: the same 22 queries admitted 71 candidates through the embedding
    // and 25 through the legacy blend. Diffing one against the other reports that difference
    // as a regression in the catalog, which it is not.
    const baseline = buildSnapshot(
      await reportFor({ web_task_coordinator: 0.90, researcher: 0.90 }), model, "embedding_rerank",
    );
    // Kept within the mean-shift limit on purpose: the control below must fail for the
    // PIPELINE and nothing else, or it proves the wrong thing.
    const hostRun = await reportFor({ web_task_coordinator: 0.895, researcher: 0.895 });

    const diff = diffSnapshot(baseline, hostRun, model, { pipeline: "embedding_only" });
    expect(diff.pipelineChanged).toBe(true);
    expect(diff.passed).toBe(false);
    expect(diff.reasons.join(" ")).toContain("scoring pipeline changed");

    // DISCRIMINANCE: the same two runs compare cleanly when the pipelines match, so the
    // refusal is about the pipeline and not about the score difference.
    expect(diffSnapshot(baseline, hostRun, model, { pipeline: "embedding_rerank" }).passed).toBe(true);
  });

  it("treats a baseline with NO pipeline stamp as a mismatch, not as a match", async () => {
    const stamped = buildSnapshot(await reportFor({ web_task_coordinator: 0.90, researcher: 0.90 }), model);
    // A snapshot written before the field existed. Assuming it matches is how two different
    // systems get compared and the difference gets reported as a catalog regression.
    const legacyBaseline = { ...stamped };
    delete (legacyBaseline as { pipeline?: unknown }).pipeline;
    const run = await reportFor({ web_task_coordinator: 0.90, researcher: 0.90 });

    const diff = diffSnapshot(legacyBaseline, run, model, { pipeline: "embedding_rerank" });
    expect(diff.pipelineChanged).toBe(true);
    expect(diff.reasons.join(" ")).toContain("unrecorded");
  });

  it("fails a NEW entry that retrieves nothing at all", async () => {
    // The floor-crossing check can only see entries that HAVE a baseline. Once the exit code
    // is decided by the diff, a newly added agent that cannot retrieve itself would otherwise
    // enter the catalog silently: it has no score to cross a floor with.
    const baseline = buildSnapshot(await reportFor({ web_task_coordinator: 0.90, researcher: 0.90 }), model);
    const withNewAgent = await runCanary(
      [...probes, { entry: "brand_new_agent", kind: "description", language: "en", query: "q-new" }],
      tableScorer({
        "q-wtc": { web_task_coordinator: 0.90 },
        "q-researcher": { researcher: 0.90 },
        "q-new": { someone_else: 0.88 },
      }),
    );

    const diff = diffSnapshot(baseline, withNewAgent, model);
    expect(diff.passed).toBe(false);
    expect(diff.reasons.join(" ")).toContain("brand_new_agent is new to the catalog and retrieves nothing");

    // DISCRIMINANCE: a new agent that DOES retrieve itself is simply an addition.
    const healthyAddition = await runCanary(
      [...probes, { entry: "brand_new_agent", kind: "description", language: "en", query: "q-new" }],
      tableScorer({
        "q-wtc": { web_task_coordinator: 0.90 },
        "q-researcher": { researcher: 0.90 },
        "q-new": { brand_new_agent: 0.91 },
      }),
    );
    const healthyDiff = diffSnapshot(baseline, healthyAddition, model);
    expect(healthyDiff.added).toContain("brand_new_agent");
    expect(healthyDiff.passed).toBe(true);
  });

  it("does not compare across embedding models — it demands a fresh baseline", async () => {
    const baseline = buildSnapshot(await reportFor({ web_task_coordinator: 0.90, researcher: 0.90 }), model);
    const other = await reportFor({ web_task_coordinator: 0.60, researcher: 0.61 });

    const diff = diffSnapshot(baseline, other, "lmstudio/some-other-embedder");
    expect(diff.embeddingModelChanged).toBe(true);
    expect(diff.passed).toBe(false);
    expect(diff.reasons.join(" ")).toContain("re-record the baseline");
    // Crossings are NOT reported as regressions under a model change: they would all be
    // noise, and a wall of false failures is how a gate gets disabled.
    expect(diff.reasons.some((reason) => reason.includes("fell below the floor"))).toBe(false);
  });

  it("tolerates a stable catalog and reports added/removed entries", async () => {
    const baseline = buildSnapshot(await reportFor({ web_task_coordinator: 0.90, researcher: 0.90 }), model);
    const stable = await reportFor({ web_task_coordinator: 0.895, researcher: 0.905 });
    const diff = diffSnapshot(baseline, stable, model);
    expect(diff.passed).toBe(true);

    const withNewAgent = await runCanary(
      [...probes, { entry: "newcomer", kind: "description", language: "en", query: "q-new" }],
      tableScorer({
        "q-wtc": { web_task_coordinator: 0.9 },
        "q-researcher": { researcher: 0.9 },
        "q-new": { newcomer: 0.9 },
      }),
    );
    expect(diffSnapshot(baseline, withNewAgent, model).added).toEqual(["newcomer"]);
  });
});
