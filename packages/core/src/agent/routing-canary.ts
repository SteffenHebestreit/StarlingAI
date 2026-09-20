/**
 * Routing canary — a label-free guard on the routing SCORE DISTRIBUTION.
 *
 * WHY THIS EXISTS. Commit e1151d8 wrapped the routing query in the embedding model's
 * instruct prefix. Ranking was untouched, every ranking-shaped assertion still passed, and
 * production broke: `web_task_coordinator` fell from 0.8461 to 0.7059 against an absolute
 * 0.72 floor and 0 of 49 agents matched anything. A top-1/MRR eval cannot see that, because
 * the ORDER was fine — what moved was the absolute score relative to a fixed gate.
 *
 * So this canary asserts three things per catalog entry, and then a fourth across the run:
 *   1. an entry's own vocabulary retrieves that entry first (top-1 self-match),
 *   2. its score clears its family floor by a MARGIN (not just by a hair),
 *   3. the resolution is not gated (something was actually admitted),
 *   4. against a committed snapshot: no entry crossed its floor and the mean score did not
 *      shift more than a threshold — the two shapes an embedding/description change takes.
 *
 * It needs NO labels: every probe is derived from the catalog entry itself. That is also its
 * limit, and the limit is the point — a self-probe proves the index is HEALTHY, never that
 * routing is ACCURATE (the literature is explicit that self-description probes inflate
 * reliability). Accuracy is the golden set's job; this is the smoke alarm that runs in
 * seconds on every change to the embedding path, the scorers or the catalog.
 *
 * Pure by construction: the scoring function is injected, so the decision logic is unit
 * tested with a stub and the same code runs against the live backend from the CLI.
 */

import type { SubAgentConfig } from "../config/schema.js";

/** Family-specific admission floor. Agents use the rescaled (cos+1)/2 gate. */
export interface CanaryFloors {
  /** Absolute admission floor for agents — the production value, never lowered here. */
  agent: number;
  /**
   * How far ABOVE its floor a self-probe must score. A self-probe that only just clears
   * the gate is one description edit away from falling through it, which is exactly the
   * regression this file exists to catch.
   */
  margin: number;
}

export const DEFAULT_CANARY_FLOORS: CanaryFloors = { agent: 0.72, margin: 0.05 };

/** Probe text for a report line. A description probe runs to 300 chars; the head identifies it. */
function truncateProbe(query: string): string {
  return query.length <= 64 ? query : `${query.slice(0, 61)}...`;
}

/** One probe: a query derived from an entry, and the entry it must retrieve. */
export interface CanaryProbe {
  /** Catalog entry this probe belongs to. */
  entry: string;
  /** Where the probe text came from — for reporting which vocabulary failed. */
  kind: "description" | "capability" | "tag" | "name" | "authored";
  /** Probe language. Non-English probes are reported as their own slice. */
  language: "en" | "de" | "other";
  query: string;
}

/** What a scorer must return: the ranked, already-admitted candidates plus the gate state. */
export interface CanaryScoredResult {
  /** Admitted candidates in ranked order (highest first). */
  ranked: Array<{ name: string; score: number }>;
  /** True when candidates existed but none cleared the floor. */
  gated: boolean;
  /** The scoring mode actually used, so a degraded run is visible rather than silently weaker. */
  mode: string;
  /**
   * Every catalog entry with its embedding score, past the resolver's top-N cut.
   *
   * Optional, because the pure decision logic must stay runnable with a stub. Where a scorer
   * can supply it, a failure can say WHICH of two very different things happened: the entry
   * scored under the 0.72 floor, or it scored fine and was cut by `searchByEmbedding(query,
   * provider, 8)` before the floor was ever consulted. Reporting both as "not admitted" sent
   * a reader looking for a catalog problem that was really a top-N problem.
   */
  allScored?: Array<{ name: string; score: number }>;
}

export type CanaryScorer = (query: string) => Promise<CanaryScoredResult>;

export interface CanaryProbeOutcome {
  probe: CanaryProbe;
  /** Rank of the expected entry (1-based), or null when it was not admitted at all. */
  selfRank: number | null;
  selfScore: number | null;
  topName: string | null;
  topScore: number | null;
  gated: boolean;
  mode: string;
  /** Empty when the probe passed. */
  failures: string[];
}

export interface CanaryEntrySummary {
  entry: string;
  probes: number;
  passed: number;
  /** Best self-score across this entry's probes — the value the snapshot tracks. */
  bestSelfScore: number | null;
  worstSelfScore: number | null;
  failures: string[];
}

export interface CanaryReport {
  floors: CanaryFloors;
  outcomes: CanaryProbeOutcome[];
  entries: CanaryEntrySummary[];
  /** Mean of every entry's best self-score — the distribution figure the snapshot compares. */
  meanBestSelfScore: number | null;
  /**
   * Every entry this run PROBED, scored or not. Needed to tell "fell below the floor and is
   * therefore unscored" from "no longer in the catalog": below the floor an entry vanishes
   * from the admitted set, so score-presence alone cannot distinguish the two — and the one
   * it would mislabel is precisely the regression this canary exists to catch.
   */
  probedEntries: string[];
  probeCount: number;
  failedProbeCount: number;
  /** Probe counts per language, so an empty German slice is reported rather than assumed green. */
  byLanguage: Record<string, number>;
  modes: Record<string, number>;
  passed: boolean;
}

/**
 * Derive probes for one agent from its own catalog text.
 *
 * Deliberately NOT hand-written queries: hand-written probes drift from the catalog and
 * quietly become a second, unmaintained description. Capability and tag phrases are the
 * entry's own declared vocabulary, which is what a user paraphrase is closest to.
 */
export function buildAgentProbes(name: string, cfg: SubAgentConfig, opts?: { maxPerKind?: number }): CanaryProbe[] {
  const maxPerKind = opts?.maxPerKind ?? 3;
  const probes: CanaryProbe[] = [];
  const firstSentence = (cfg.description ?? "")
    .split(/(?<=[.!?])\s+/)[0]
    ?.trim();
  if (firstSentence && firstSentence.length >= 12) {
    probes.push({ entry: name, kind: "description", language: "en", query: firstSentence.slice(0, 300) });
  }
  for (const capability of (cfg.capabilities ?? []).slice(0, maxPerKind)) {
    const text = capability.trim();
    if (text.length >= 4) probes.push({ entry: name, kind: "capability", language: "en", query: text });
  }
  // Tags are single words; alone they are too thin to retrieve anything, so they are probed
  // as a phrase. A tag set that cannot retrieve its own agent is a catalog-hygiene finding.
  const tags = (cfg.tags ?? []).slice(0, 6).map((tag) => tag.replace(/-/g, " ").trim()).filter(Boolean);
  if (tags.length >= 2) {
    probes.push({ entry: name, kind: "tag", language: "en", query: tags.join(", ") });
  }
  return probes;
}

/** Evaluate one probe against a scorer. Pure decision logic; no I/O of its own. */
export async function runCanaryProbe(
  probe: CanaryProbe,
  score: CanaryScorer,
  floors: CanaryFloors,
): Promise<CanaryProbeOutcome> {
  const result = await score(probe.query);
  const index = result.ranked.findIndex((candidate) => candidate.name === probe.entry);
  const selfRank = index >= 0 ? index + 1 : null;
  const selfScore = index >= 0 ? result.ranked[index]!.score : null;
  const failures: string[] = [];

  if (result.gated) {
    failures.push(`gated: ${result.ranked.length === 0 ? "no candidate cleared the floor" : "resolution reported gated"}`);
  }
  if (selfRank === null) {
    const deep = result.allScored?.find((entry) => entry.name === probe.entry);
    const deepRank = deep && result.allScored
      ? result.allScored.filter((entry) => entry.score > deep.score).length + 1
      : null;
    const why = deep === undefined
      ? "not admitted"
      : deep.score >= floors.agent
        ? `scored ${deep.score.toFixed(4)} — ABOVE the floor, cut by the top-N ranking at rank ${deepRank}`
        : `scored ${deep.score.toFixed(4)} — under the ${floors.agent} floor`;
    failures.push(`${why} (top: ${result.ranked[0]?.name ?? "none"} @ ${result.ranked[0]?.score.toFixed(4) ?? "n/a"})`);
  } else {
    if (selfRank !== 1) {
      failures.push(`self-match at rank ${selfRank}, behind ${result.ranked[0]!.name} (${result.ranked[0]!.score.toFixed(4)})`);
    }
    const required = floors.agent + floors.margin;
    if (selfScore !== null && selfScore < required) {
      failures.push(`score ${selfScore.toFixed(4)} below floor+margin ${required.toFixed(4)}`);
    }
  }

  return {
    probe,
    selfRank,
    selfScore,
    topName: result.ranked[0]?.name ?? null,
    topScore: result.ranked[0]?.score ?? null,
    gated: result.gated,
    mode: result.mode,
    failures,
  };
}

/** Run every probe and summarise per entry. Probes run sequentially: the backend is shared
 *  with production traffic and concurrent requests do not share its prefix cache. */
export async function runCanary(
  probes: readonly CanaryProbe[],
  score: CanaryScorer,
  floors: CanaryFloors = DEFAULT_CANARY_FLOORS,
): Promise<CanaryReport> {
  const outcomes: CanaryProbeOutcome[] = [];
  for (const probe of probes) {
    outcomes.push(await runCanaryProbe(probe, score, floors));
  }

  const byEntry = new Map<string, CanaryProbeOutcome[]>();
  for (const outcome of outcomes) {
    const list = byEntry.get(outcome.probe.entry) ?? [];
    list.push(outcome);
    byEntry.set(outcome.probe.entry, list);
  }

  const entries: CanaryEntrySummary[] = [...byEntry.entries()].map(([entry, entryOutcomes]) => {
    const selfScores = entryOutcomes.map((o) => o.selfScore).filter((s): s is number => s !== null);
    return {
      entry,
      probes: entryOutcomes.length,
      passed: entryOutcomes.filter((o) => o.failures.length === 0).length,
      bestSelfScore: selfScores.length ? Math.max(...selfScores) : null,
      worstSelfScore: selfScores.length ? Math.min(...selfScores) : null,
      // The probe TEXT is part of the failure, not decoration. Without it the report says an
      // entry failed a "capability" probe and leaves the reader unable to tell a real routing
      // defect from a capability phrase so generic that three agents legitimately advertise it.
      failures: entryOutcomes.flatMap((o) => o.failures.map(
        (f) => `[${o.probe.kind}] "${truncateProbe(o.probe.query)}" — ${f}`,
      )),
    };
  }).sort((a, b) => a.entry.localeCompare(b.entry));

  const bests = entries.map((e) => e.bestSelfScore).filter((s): s is number => s !== null);
  const byLanguage: Record<string, number> = {};
  const modes: Record<string, number> = {};
  for (const outcome of outcomes) {
    byLanguage[outcome.probe.language] = (byLanguage[outcome.probe.language] ?? 0) + 1;
    modes[outcome.mode] = (modes[outcome.mode] ?? 0) + 1;
  }

  const failedProbeCount = outcomes.filter((o) => o.failures.length > 0).length;
  return {
    floors,
    outcomes,
    entries,
    meanBestSelfScore: bests.length ? bests.reduce((sum, s) => sum + s, 0) / bests.length : null,
    probedEntries: entries.map((entry) => entry.entry),
    probeCount: outcomes.length,
    failedProbeCount,
    byLanguage,
    modes,
    passed: failedProbeCount === 0,
  };
}

// ── Snapshot comparison ───────────────────────────────────────────────────────

/**
 * Which scoring pipeline produced a set of scores.
 *
 * The admission floor is applied after the rerank blend, so a run WITH the reranker and a run
 * WITHOUT it are different systems measured against the same fixed gate. Measured on this
 * catalog and 22 realistic queries, the difference is not a perturbation: the legacy
 * admission blend admitted 25 candidates where the embedding admitted 71.
 */
export type CanaryPipeline = "embedding_only" | "embedding_rerank";

export interface CanarySnapshot {
  /** The embedding model the scores were produced with. Scores are not comparable across
   *  models, so a model change must reset the baseline rather than fail every entry. */
  embeddingModel: string;
  /**
   * The pipeline behind these scores. ABSENT in snapshots written before this field existed,
   * and an absent value is treated as a MISMATCH rather than a match: a baseline that cannot
   * say what produced it cannot be compared to anything.
   */
  pipeline?: CanaryPipeline;
  floors: CanaryFloors;
  meanBestSelfScore: number | null;
  /** entry → best self-score. */
  scores: Record<string, number>;
  /** Reranker participation at record time, for the human reading the file. */
  reranker?: { enabled: boolean; mode: string; applied: number };
}

export interface SnapshotDiff {
  /**
   * Entries whose best self-score moved across the floor in either direction. `after` is
   * null when the entry no longer scores at all — the worst form of falling below, since
   * the entry is then invisible to every ranked view of routing.
   */
  floorCrossings: Array<{ entry: string; before: number; after: number | null; direction: "fell_below" | "rose_above" }>;
  /** True when the baseline and this run were produced by different scoring pipelines. */
  pipelineChanged?: boolean;
  /** Entries present in one side only. */
  added: string[];
  removed: string[];
  meanShift: number | null;
  /** Largest absolute per-entry move, with the entry that made it. */
  largestMove: { entry: string; before: number; after: number; delta: number } | null;
  embeddingModelChanged: boolean;
  passed: boolean;
  reasons: string[];
}

export function buildSnapshot(
  report: CanaryReport,
  embeddingModel: string,
  pipeline: CanaryPipeline = "embedding_only",
): CanarySnapshot {
  const scores: Record<string, number> = {};
  for (const entry of report.entries) {
    if (entry.bestSelfScore !== null) scores[entry.entry] = Number(entry.bestSelfScore.toFixed(4));
  }
  return {
    embeddingModel,
    pipeline,
    floors: report.floors,
    meanBestSelfScore: report.meanBestSelfScore === null ? null : Number(report.meanBestSelfScore.toFixed(4)),
    scores,
  };
}

/**
 * Compare a fresh report against the committed snapshot.
 *
 * A floor crossing fails outright — that is the e1151d8 shape, and it is a production
 * outage rather than a metric wobble. A mean shift beyond `maxMeanShift` fails too: the same
 * commit moved EVERY agent by a similar amount, so the distribution moving as a block is the
 * earliest visible symptom even when nothing has crossed yet.
 */
export function diffSnapshot(
  snapshot: CanarySnapshot,
  report: CanaryReport,
  embeddingModel: string,
  opts?: { maxMeanShift?: number; pipeline?: CanaryPipeline },
): SnapshotDiff {
  const maxMeanShift = opts?.maxMeanShift ?? 0.02;
  const pipeline = opts?.pipeline ?? "embedding_only";
  const current = buildSnapshot(report, embeddingModel, pipeline);
  const reasons: string[] = [];
  const embeddingModelChanged = snapshot.embeddingModel !== embeddingModel;
  // An undefined stamp is a mismatch, not a pass. A baseline from before this field existed
  // cannot say whether the reranker took part, and guessing is how two different systems get
  // compared and the difference reported as a regression.
  const pipelineChanged = snapshot.pipeline !== pipeline;

  const floorCrossings: SnapshotDiff["floorCrossings"] = [];
  let largestMove: SnapshotDiff["largestMove"] = null;
  const floor = report.floors.agent;

  const probed = new Set(report.probedEntries);
  for (const [entry, before] of Object.entries(snapshot.scores)) {
    // Still in the catalog but no longer scoring anywhere = it fell through the floor. This
    // is the e1151d8 case and it must never be filed as "entry removed": the entry is still
    // configured, it just became unreachable.
    if (!(entry in current.scores)) {
      if (probed.has(entry)) floorCrossings.push({ entry, before, after: null, direction: "fell_below" });
      continue;
    }
    const after = current.scores[entry]!;
    if (before >= floor && after < floor) floorCrossings.push({ entry, before, after, direction: "fell_below" });
    else if (before < floor && after >= floor) floorCrossings.push({ entry, before, after, direction: "rose_above" });
    const delta = Math.abs(after - before);
    if (!largestMove || delta > largestMove.delta) largestMove = { entry, before, after, delta };
  }

  const added = Object.keys(current.scores).filter((entry) => snapshot.scores[entry] === undefined);
  // A newly probed entry that produced NO score is not "added" — it is an entry that cannot
  // retrieve itself at all. It has no baseline to cross, so the floor-crossing check above
  // cannot see it, and without this a broken new agent would enter the catalog silently.
  const unscoredNewEntries = report.probedEntries.filter(
    (entry) => snapshot.scores[entry] === undefined && current.scores[entry] === undefined,
  );
  // "Removed" means gone from the catalog — an entry that was probed and simply stopped
  // scoring is a crossing, handled above.
  const removed = Object.keys(snapshot.scores).filter((entry) => !probed.has(entry));
  const meanShift =
    current.meanBestSelfScore !== null && snapshot.meanBestSelfScore !== null
      ? Number((current.meanBestSelfScore - snapshot.meanBestSelfScore).toFixed(4))
      : null;

  if (embeddingModelChanged) {
    reasons.push(
      `embedding model changed (${snapshot.embeddingModel} → ${embeddingModel}); scores are not comparable — re-record the baseline`,
    );
  } else if (pipelineChanged) {
    reasons.push(
      `scoring pipeline changed (${snapshot.pipeline ?? "unrecorded"} → ${pipeline}); the admission floor is applied `
      + "after the rerank blend, so these are different systems measured against the same gate — "
      + "re-record the baseline from the pipeline you want to guard",
    );
  } else {
    for (const crossing of floorCrossings.filter((c) => c.direction === "fell_below")) {
      reasons.push(
        `${crossing.entry} fell below the floor: ${crossing.before} → ${crossing.after ?? "unadmitted (no score at all)"}`,
      );
    }
    if (meanShift !== null && Math.abs(meanShift) > maxMeanShift) {
      reasons.push(`mean self-score shifted ${meanShift > 0 ? "+" : ""}${meanShift} (limit ±${maxMeanShift})`);
    }
    for (const entry of unscoredNewEntries) {
      reasons.push(`${entry} is new to the catalog and retrieves nothing — it cannot be routed to`);
    }
  }

  return {
    floorCrossings,
    added,
    removed,
    meanShift,
    largestMove,
    embeddingModelChanged,
    pipelineChanged,
    passed: reasons.length === 0,
    reasons,
  };
}

/** Render a report + optional diff as the human-facing summary the CLI prints. */
export function formatCanaryReport(report: CanaryReport, diff?: SnapshotDiff): string {
  const lines: string[] = [];
  const modeSummary = Object.entries(report.modes).map(([mode, count]) => `${mode}×${count}`).join(", ");
  lines.push(
    `Routing canary: ${report.probeCount - report.failedProbeCount}/${report.probeCount} probes passed across ${report.entries.length} entries (mode: ${modeSummary || "n/a"})`,
  );
  lines.push(
    `Floor ${report.floors.agent} + margin ${report.floors.margin}; mean best self-score ${report.meanBestSelfScore?.toFixed(4) ?? "n/a"}`,
  );
  const languages = Object.entries(report.byLanguage).map(([language, count]) => `${language}:${count}`).join(" ");
  lines.push(`Probes by language — ${languages || "none"}`);
  if (!report.byLanguage["de"]) {
    lines.push("NOTE: no German probes ran. The German slice is UNMEASURED, not green.");
  }
  const failing = report.entries.filter((entry) => entry.failures.length > 0);
  if (failing.length) {
    lines.push("", `FAILING ENTRIES (${failing.length}):`);
    for (const entry of failing) {
      lines.push(`  ${entry.entry} (${entry.passed}/${entry.probes} probes)`);
      for (const failure of entry.failures.slice(0, 4)) lines.push(`    - ${failure}`);
    }
  }
  if (diff) {
    lines.push("", "Snapshot comparison:");
    lines.push(`  mean shift ${diff.meanShift ?? "n/a"}; largest move ${diff.largestMove ? `${diff.largestMove.entry} ${diff.largestMove.before}→${diff.largestMove.after}` : "n/a"}`);
    if (diff.added.length) lines.push(`  new entries: ${diff.added.join(", ")}`);
    if (diff.removed.length) lines.push(`  entries gone from the catalog: ${diff.removed.join(", ")}`);
    for (const reason of diff.reasons) lines.push(`  FAIL: ${reason}`);
    if (diff.passed) lines.push("  snapshot OK");
  }
  return lines.join("\n");
}
