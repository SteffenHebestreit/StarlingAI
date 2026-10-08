/**
 * Run verdicts of the e2e harness (src/e2e): when a run is environment-suspect, when a scenario or
 * the whole suite regressed against a baseline (stats.ts), and what the run ran on
 * (provenance.ts). The seven reports of 2026-10-07 (fixtures/e2e-reports-2026-10-07.json: the
 * reports as the harness wrote them, reduced to the fields the verdicts read) are re-graded with
 * today's rules.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildReport, compareWithBaseline, exitCodeFor, renderMarkdown, type E2EReport, type E2ERunMeta } from "../e2e/report.js";
import type { AttemptResult, ScenarioResult } from "../e2e/runner.js";
import type { ServiceState } from "../e2e/services.js";
import { compareSuite, compareTallies, signTestPValue } from "../e2e/stats.js";
import {
  buildChanges,
  captureProvenance,
  describeProvenance,
  gatewayImageFromStatus,
  provenanceWarnings,
  readHarnessSource,
  type E2EProvenance,
  type GitRunner,
} from "../e2e/provenance.js";
import { findRepoRoot } from "../e2e/paths.js";

// ── helpers ──────────────────────────────────────────────────────────────────

const META: E2ERunMeta = {
  startedAt: "2026-10-08T10:00:00.000Z", finishedAt: "2026-10-08T10:10:00.000Z", gatewayUrl: "http://x",
  repeat: 1, concurrency: 1, filters: { groups: [], tags: [], ids: [] }, judge: null, mail: null,
};

function attempt(index: number, outcome: AttemptResult["outcome"]): AttemptResult {
  return {
    index, outcome, startedAt: META.startedAt, durationMs: 1, failures: outcome === "passed" ? [] : ["step 1 turn: reply.includes \"42\": not found"],
    notes: [], sessions: [], steps: [], eventTypeCounts: {}, tools: {}, agents: {},
  };
}

const up = (service: ServiceState["service"]): ServiceState => ({ service, up: true, detail: `${service}: ok` });
const down = (service: ServiceState["service"], detail = `${service}: unreachable`): ServiceState => ({ service, up: false, detail });

/** A scenario that ran, one letter per attempt: P passed, F failed, E ended on a harness error. */
function ran(id: string, outcomes: string, services: ServiceState[] = [up("gateway"), up("model")]): ScenarioResult {
  const attempts = [...outcomes].map((letter, index) => attempt(index, letter === "P" ? "passed" : letter === "E" ? "error" : "failed"));
  const passCount = attempts.filter((entry) => entry.outcome === "passed").length;
  const passAll = passCount === attempts.length;
  return {
    id, title: id, group: "core", tags: [], file: `${id}.jsonc`, status: passAll ? "passed" : "failed", services,
    repeat: attempts.length, attempts, passCount, passRate: passCount / attempts.length, passAll, durationMs: 1,
  };
}

/** A scenario skipped before it ran: for the services down among `services`, or (none down) by Ctrl+C. */
function skipped(id: string, services: ServiceState[]): ScenarioResult {
  const reason = services.filter((state) => !state.up).map((state) => `${state.service} down (${state.detail})`).join("; ");
  return {
    id, title: id, group: "core", tags: [], file: `${id}.jsonc`, status: "skipped", skipReason: reason || "run interrupted before it started",
    services, repeat: 1, attempts: [], passCount: 0, passRate: 0, passAll: false, durationMs: 0,
  };
}

// ── the seven reports of 2026-10-07 ──────────────────────────────────────────

interface FixtureReport {
  file: string;
  meta: E2EReport["meta"];
  summary: E2EReport["summary"];
  environment: E2EReport["environment"];
  scenarios: Array<Omit<ScenarioResult, "title" | "tags" | "file" | "attempts"> & {
    attempts: Array<Pick<AttemptResult, "index" | "outcome" | "startedAt" | "durationMs" | "failures">>;
  }>;
}

const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/e2e-reports-2026-10-07.json", import.meta.url), "utf8")) as FixtureReport[];

/** A report as the harness wrote it then, the fields the fixture leaves out filled back in. */
function written(file: string): E2EReport {
  const report = FIXTURE.find((entry) => entry.file === file);
  if (!report) throw new Error(`no report ${file} in the fixture`);
  return {
    kind: "e2e-evaluation",
    version: 1,
    meta: report.meta,
    summary: report.summary,
    environment: report.environment,
    scenarios: report.scenarios.map((scenario) => ({
      ...scenario,
      title: scenario.id,
      tags: [],
      file: `${scenario.id}.jsonc`,
      attempts: scenario.attempts.map((entry) => ({ ...entry, notes: [], sessions: [], steps: [], eventTypeCounts: {}, tools: {}, agents: {} })),
    })),
  };
}

/** The same run graded by today's rules. */
function regraded(file: string): E2EReport {
  const report = written(file);
  return buildReport(report.scenarios, report.meta);
}

/** The rule before 2026-10-08: any lower pass rate, or pass^k lost, was a regression. */
function oldRuleRegressions(report: E2EReport, baseline: E2EReport): string[] {
  const before = new Map(baseline.scenarios.filter((result) => result.status !== "skipped").map((result) => [result.id, result]));
  return report.scenarios.filter((result) => {
    const previous = result.status !== "skipped" ? before.get(result.id) : undefined;
    return previous !== undefined && (result.passRate < previous.passRate || (previous.passAll && !result.passAll));
  }).map((result) => result.id);
}

const SMOKE_1542 = "2026-10-07T15-42-55-888Z.json";
const SMOKE_2120 = "2026-10-07T21-20-07-177Z.json";
const SITE_RERUN_2139 = "2026-10-07T21-39-14-552Z.json";
const FULL_2207 = "2026-10-07T22-07-37-965Z.json";
const SITE_SCENARIOS = ["core-build-site-company-facts", "core-build-site-doc-only-facts"];

// ── tests ────────────────────────────────────────────────────────────────────

describe("e2e verdicts — interval and sign test (stats.ts)", () => {
  it("calls a scenario's change only when the 95 % interval of the difference excludes zero", () => {
    expect(compareTallies({ passed: 3, trials: 3 }, { passed: 0, trials: 3 }).change).toBe("regressed");
    expect(compareTallies({ passed: 0, trials: 3 }, { passed: 3, trials: 3 }).change).toBe("improved");
    expect(compareTallies({ passed: 5, trials: 5 }, { passed: 1, trials: 5 }).change).toBe("regressed");
    // One flip, or two, can be chance: each run was uniform, so inconclusive.
    expect(compareTallies({ passed: 1, trials: 1 }, { passed: 0, trials: 1 }).change).toBe("inconclusive");
    expect(compareTallies({ passed: 0, trials: 1 }, { passed: 1, trials: 1 }).change).toBe("inconclusive");
    expect(compareTallies({ passed: 2, trials: 2 }, { passed: 0, trials: 2 }).change).toBe("inconclusive");
    // Passed and failed within one run: flaky, whichever way the rate moved.
    expect(compareTallies({ passed: 5, trials: 5 }, { passed: 4, trials: 5 }).change).toBe("flaky");
    expect(compareTallies({ passed: 5, trials: 5 }, { passed: 2, trials: 5 }).change).toBe("flaky");
    expect(compareTallies({ passed: 0, trials: 1 }, { passed: 2, trials: 3 }).change).toBe("flaky");
    expect(compareTallies({ passed: 2, trials: 3 }, { passed: 2, trials: 3 }).change).toBe("flaky");
    expect(compareTallies({ passed: 3, trials: 3 }, { passed: 3, trials: 3 }).change).toBe("unchanged");
    expect(compareTallies({ passed: 0, trials: 2 }, { passed: 0, trials: 1 }).change).toBe("unchanged");
    // No trial in a run (every attempt errored): nothing to compare.
    expect(compareTallies({ passed: 1, trials: 1 }, { passed: 0, trials: 0 })).toEqual({ change: "inconclusive", ci: null });

    const drop = compareTallies({ passed: 3, trials: 3 }, { passed: 0, trials: 3 }).ci!;
    expect(drop.high).toBeLessThan(0);
    expect(drop.low).toBeGreaterThanOrEqual(-1);
    const flip = compareTallies({ passed: 1, trials: 1 }, { passed: 0, trials: 1 }).ci!;
    expect(flip.low).toBeLessThan(0);
    expect(flip.high).toBeGreaterThan(0);
  });

  it("computes the exact one-sided sign-test tail", () => {
    expect(signTestPValue(6, 6)).toBeCloseTo(1 / 64, 12);
    expect(signTestPValue(3, 4)).toBeCloseTo(5 / 16, 12);
    expect(signTestPValue(6, 8)).toBeCloseTo(37 / 256, 12);
    expect(signTestPValue(0, 5)).toBe(1);
    expect(signTestPValue(6, 5)).toBe(0);
    // P(X ≥ k) + P(X ≥ n − k + 1) = 1 by symmetry, also where the terms are tiny.
    for (const n of [1, 7, 52, 400]) {
      for (let k = 1; k <= n; k += Math.max(1, Math.floor(n / 9))) expect(signTestPValue(k, n) + signTestPValue(n - k + 1, n)).toBeCloseTo(1, 9);
    }
  });

  it("decides the suite by a sign test over the scenarios with equal attempt counts", () => {
    const pair = (before: [number, number], now: [number, number]) => ({ baseline: { passed: before[0], trials: before[1] }, now: { passed: now[0], trials: now[1] } });
    const flips = (lower: number, higher: number, same = 10) => [
      ...Array.from({ length: lower }, () => pair([1, 1], [0, 1])),
      ...Array.from({ length: higher }, () => pair([0, 1], [1, 1])),
      ...Array.from({ length: same }, () => pair([1, 1], [1, 1])),
    ];
    // At k=1 no scenario is decisive alone; six flips down and none up is.
    expect(compareSuite(flips(6, 0))).toMatchObject({ change: "regressed", lower: 6, higher: 0, same: 10, unpaired: 0 });
    expect(compareSuite(flips(6, 0)).pValue).toBeCloseTo(1 / 64, 12);
    expect(compareSuite(flips(5, 0)).change).toBe("inconclusive");
    expect(compareSuite(flips(0, 6)).change).toBe("improved");
    expect(compareSuite(flips(2, 3)).change).toBe("inconclusive");
    expect(compareSuite(flips(2, 3)).pValue).toBeCloseTo(0.5, 12);
    expect(compareSuite(flips(0, 0))).toMatchObject({ change: "unchanged", pValue: 1 });
    // More attempts see a failure more often: unequal counts stay out of the test.
    expect(compareSuite([pair([1, 1], [2, 3]), pair([3, 3], [0, 1])])).toMatchObject({ change: "inconclusive", lower: 0, higher: 0, same: 0, unpaired: 2 });
  });
});

describe("e2e verdicts — environment-suspect runs", () => {
  it("marks a run suspect when one service was down for a fifth of the selected scenarios, and says it went down mid-run", () => {
    const results = [
      ran("a", "P", [up("gateway")]),
      ...["b", "c", "d", "e", "f", "g"].map((id) => ran(id, "P")),
      ran("h", "F"),
      skipped("i", [up("gateway"), down("model", "primary_model: unavailable (fetch failed)")]),
      skipped("j", [up("gateway"), down("model", "primary_model: unavailable (fetch failed)")]),
    ];
    const report = buildReport(results, META);
    expect(report.summary).toMatchObject({ scenarios: 10, passed: 7, failed: 1, skipped: 2 });
    expect(report.environment).toEqual({
      suspect: true,
      reasons: ["2 of 10 selected scenarios were skipped because model was down (primary_model: unavailable (fetch failed)); it was up when h started, so it went down during the run"],
    });
    // The verdicts below it are the environment's: suspect wins over the failure.
    expect(exitCodeFor(report)).toBe(3);
    expect(renderMarkdown(report)).toContain("> **Environment suspect** — 2 of 10 selected scenarios were skipped because model was down");

    // One skip in ten is the run's coverage, not its verdict.
    const one = buildReport(results.slice(0, 9).concat(ran("j", "P")), META);
    expect(one.environment).toEqual({ suspect: false, reasons: [] });
    expect(exitCodeFor(one)).toBe(1);
  });

  it("counts skips per service, names an outage from the start as such, and ignores scenarios Ctrl+C never started", () => {
    const passing = ["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => ran(id, "P"));
    // Two services down for one scenario each: no single outage reaches a fifth.
    const spread = buildReport([...passing, skipped("i", [up("gateway"), down("model")]), skipped("j", [up("gateway"), up("model"), down("mail")])], META);
    expect(spread.environment.suspect).toBe(false);
    expect(exitCodeFor(spread)).toBe(0);

    // Down from the first probe on: no "went down during the run".
    const site = buildReport([
      skipped("s1", [up("gateway"), up("model"), down("e2e-site", "e2e site unreachable")]),
      skipped("s2", [up("gateway"), up("model"), down("e2e-site", "e2e site unreachable")]),
      ...passing,
    ], META);
    expect(site.environment.reasons).toEqual(["2 of 10 selected scenarios were skipped because e2e-site was down (e2e site unreachable)"]);

    // Interrupted before they started: the user's doing, not the environment's.
    const interrupted = buildReport([...passing, skipped("i", []), skipped("j", [])], META);
    expect(interrupted.environment.suspect).toBe(false);
  });
});

describe("e2e verdicts — re-grading the reports of 2026-10-07", () => {
  it("re-grades the 22:07 full run — 47 of 52 skipped after the model endpoint died — as environment-suspect, exit 3", () => {
    const original = written(FULL_2207);
    // As written: "4 passed, 1 failed", not suspect, and the CLI exited 1.
    expect(original.summary).toMatchObject({ scenarios: 52, run: 5, passed: 4, failed: 1, skipped: 47 });
    expect(original.environment).toEqual({ suspect: false, reasons: [] });
    expect(exitCodeFor(original)).toBe(1);

    const report = regraded(FULL_2207);
    expect(report.summary).toEqual(original.summary);
    expect(report.environment).toEqual({
      suspect: true,
      reasons: [
        "47 of 52 selected scenarios were skipped because model was down (primary_model: unavailable — no model endpoint reachable — connect a provider (fetch failed)); "
          + "it was up when core-build-artifact-website started, so it went down during the run",
      ],
    });
    expect(exitCodeFor(report)).toBe(3);
  });

  it("leaves the other six runs as they were graded", () => {
    const others = FIXTURE.map((entry) => entry.file).filter((file) => file !== FULL_2207);
    expect(others).toHaveLength(6);
    for (const file of others) {
      const report = regraded(file);
      expect(report.environment, file).toEqual({ suspect: false, reasons: [] });
      expect(exitCodeFor(report), file).toBe(exitCodeFor(written(file)));
    }
    expect(others.map((file) => exitCodeFor(regraded(file)))).toEqual([1, 0, 1, 1, 1, 1]);
  });

  it("reads the site scenarios' k=1 failures as inconclusive and their 2/3 rerun as flaky, where the old rule saw regressions", () => {
    // 15:42 → 21:20, both smoke at k=1: the site scenarios went 1/1 → 0/1.
    expect(oldRuleRegressions(written(SMOKE_2120), written(SMOKE_1542))).toEqual(SITE_SCENARIOS);
    const smoke = compareWithBaseline(regraded(SMOKE_2120), regraded(SMOKE_1542), SMOKE_1542);
    expect(smoke.regressions).toEqual([]);
    expect(smoke.inconclusive.filter((delta) => SITE_SCENARIOS.includes(delta.id)).map((delta) => [delta.id, delta.baselineTally, delta.tally])).toEqual([
      ["core-build-site-company-facts", { passed: 1, trials: 1 }, { passed: 0, trials: 1 }],
      ["core-build-site-doc-only-facts", { passed: 1, trials: 1 }, { passed: 0, trials: 1 }],
    ]);
    // Taken together: 2 lower and 3 higher of 22 — no decisive change either.
    expect(smoke.suite).toMatchObject({ change: "inconclusive", lower: 2, higher: 3, same: 17, unpaired: 0 });
    expect(smoke.suite.pValue).toBeCloseTo(0.5, 12);

    // The rerun at k=3, 21:39 (same build): 2/3 each — flaky against either earlier run.
    for (const baseline of [SMOKE_2120, SMOKE_1542]) {
      const rerun = compareWithBaseline(regraded(SITE_RERUN_2139), regraded(baseline), baseline);
      expect(rerun.regressions, baseline).toEqual([]);
      expect(rerun.flaky.map((delta) => delta.id), baseline).toEqual(SITE_SCENARIOS);
    }
    expect(oldRuleRegressions(written(SITE_RERUN_2139), written(SMOKE_1542))).toEqual(SITE_SCENARIOS);
  });

  it("reads the English-question scenario's 5/5 then 4/5, three minutes apart, as flaky, not regressed", () => {
    const before = "2026-10-07T13-57-57-133Z.json";
    const after = "2026-10-07T14-00-13-648Z.json";
    expect(oldRuleRegressions(written(after), written(before))).toEqual(["guards-language-english-question"]);
    const comparison = compareWithBaseline(regraded(after), regraded(before), before);
    expect(comparison.regressions).toEqual([]);
    expect(comparison.flaky.map((delta) => [delta.id, delta.baselineTally, delta.tally])).toEqual([
      ["guards-language-english-question", { passed: 5, trials: 5 }, { passed: 4, trials: 5 }],
    ]);
  });
});

describe("e2e verdicts — baseline comparison", () => {
  it("compares each scenario by its trials, harness errors left out, and renders every verdict", () => {
    const baseline = buildReport([ran("drops", "PPP"), ran("recovers", "FFF"), ran("wobbles", "PPP"), ran("flips", "P"), ran("steady", "PPP"), ran("errs", "PPP"), ran("gone", "P")], META);
    const report = buildReport([ran("drops", "FFF"), ran("recovers", "PPP"), ran("wobbles", "PFP"), ran("flips", "F"), ran("steady", "PPP"), ran("errs", "PPE"), ran("new", "P")], META);
    const comparison = compareWithBaseline(report, baseline, "baseline.json");
    expect(comparison.regressions.map((delta) => delta.id)).toEqual(["drops"]);
    expect(comparison.improvements.map((delta) => delta.id)).toEqual(["recovers"]);
    expect(comparison.flaky.map((delta) => delta.id)).toEqual(["wobbles"]);
    expect(comparison.inconclusive.map((delta) => delta.id)).toEqual(["flips"]);
    // 3/3 → 2 passed + 1 harness error: two trials, both passed.
    expect(comparison.unchanged).toBe(2);
    expect(comparison.newScenarios).toEqual(["new"]);
    expect(comparison.missingScenarios).toEqual(["gone"]);
    // drops/flips lower, recovers higher, wobbles lower; errs has 2 trials now against 3.
    expect(comparison.suite).toMatchObject({ change: "inconclusive", lower: 3, higher: 1, same: 1, unpaired: 1 });
    expect(comparison.buildChanges).toBeNull();
    expect(comparison.regressions[0]).toMatchObject({ baselineTally: { passed: 3, trials: 3 }, tally: { passed: 0, trials: 3 }, change: "regressed" });

    report.baseline = comparison;
    expect(exitCodeFor(report)).toBe(1);
    const markdown = renderMarkdown(report);
    expect(markdown).toContain("1 regression(s), 1 improvement(s), 1 flaky, 1 inconclusive, 2 unchanged, 1 new, 1 not run now.");
    expect(markdown).toContain("- Suite: 3 lower, 1 higher, 1 the same, 1 with unequal attempt counts left out — no decisive change (sign test p = 0.313)");
    expect(markdown).toContain("- Builds: unknown (a report without provenance)");
    expect(markdown).toContain("| `drops` | 3/3 | 0/3 | −100 pp [−100, −10] | **regression** |");
    expect(markdown).toContain("| `recovers` | 0/3 | 3/3 | +100 pp [+10, +100] | improvement |");
    expect(markdown).toContain("| `wobbles` | 3/3 | 2/3 | −33 pp [−75, +35] | flaky |");
    expect(markdown).toContain("| `flips` | 1/1 | 0/1 | −100 pp [−100, +42] | inconclusive |");
  });
});

describe("e2e provenance", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const fakeGit = (answers: Record<string, string | null>): GitRunner => (_root, args) => answers[args.join(" ")] ?? null;
  const committed = { "rev-parse HEAD": SHA, "status --porcelain=v1": "", "log -1 --format=%cI HEAD": "2026-10-08T12:00:00+02:00" };

  it("reads HEAD, the dirty flag and the commit date, and never calls an unreadable tree clean", () => {
    expect(readHarnessSource("/repo", fakeGit(committed))).toEqual({ sha: SHA, dirty: false, committedAt: "2026-10-08T12:00:00+02:00" });
    expect(readHarnessSource("/repo", fakeGit({ ...committed, "status --porcelain=v1": " M config/gateway/10-gateway.jsonc" }))?.dirty).toBe(true);
    expect(readHarnessSource("/repo", fakeGit({ ...committed, "status --porcelain=v1": null }))?.dirty).toBe(true);
    expect(readHarnessSource("/repo", fakeGit({ ...committed, "rev-parse HEAD": null }))).toBeNull();
    expect(readHarnessSource("/repo", fakeGit({ ...committed, "rev-parse HEAD": "fatal: not a git repository" }))).toBeNull();

    // The real checkout this test runs in.
    const real = readHarnessSource(findRepoRoot());
    expect(real?.sha).toMatch(/^[0-9a-f]{40}/);
    expect(Number.isFinite(Date.parse(real?.committedAt ?? ""))).toBe(true);
  });

  it("reads the gateway image from the e2e environment status, and records why when it cannot", async () => {
    const status = { gateway: { running: true, image: { id: `sha256:${"3b".repeat(32)}`, created: "2026-10-07T21:09:32.557822715Z" } } };
    expect(gatewayImageFromStatus(status)).toEqual({ id: `sha256:${"3b".repeat(32)}`, createdAt: "2026-10-07T21:09:32.557822715Z" });
    expect(gatewayImageFromStatus({ gateway: { running: false, image: null } })).toBeNull();
    expect(gatewayImageFromStatus({ mailService: { running: false } })).toBeNull();

    const full = await captureProvenance("/repo", async () => ({ json: status }), fakeGit(committed));
    expect(full).toEqual({
      harness: { sha: SHA, dirty: false, committedAt: "2026-10-08T12:00:00+02:00" },
      gatewayImage: { id: `sha256:${"3b".repeat(32)}`, createdAt: "2026-10-07T21:09:32.557822715Z" },
      missing: [],
      // Built the evening before HEAD was committed.
      warnings: [`the gateway image ${"3b".repeat(6)} was built 2026-10-07T21:09:32.557822715Z, before the harness's HEAD 0123456 was committed (2026-10-08T12:00:00+02:00): the stack may not run the code under test`],
    });
    expect(describeProvenance(full)).toBe(`harness 0123456 · gateway image ${"3b".repeat(6)} built 2026-10-07T21:09:32.557822715Z`);

    const blind = await captureProvenance("/repo", async () => ({ error: "pnpm e2e:env status --json gave no status (e2e:env: Docker is not reachable)" }), fakeGit({}));
    expect(blind).toEqual({
      harness: null,
      gatewayImage: null,
      missing: ["harness: git could not read the checkout at /repo", "gateway image: pnpm e2e:env status --json gave no status (e2e:env: Docker is not reachable)"],
      warnings: [],
    });
    expect(describeProvenance(blind)).toBe("harness unknown · gateway image unknown");
    expect((await captureProvenance("/repo", null, fakeGit(committed))).missing).toEqual(["gateway image: scripts/e2e-env.mjs not found"]);
    expect((await captureProvenance("/repo", async () => ({ json: { mailService: { running: false } } }), fakeGit(committed))).missing)
      .toEqual(["gateway image: the e2e environment status names none (no running gateway container of this checkout)"]);
  });

  it("warns only when the image was built before HEAD was committed", () => {
    const harness = { sha: SHA, dirty: false, committedAt: "2026-10-07T18:27:27+02:00" };
    expect(provenanceWarnings(harness, { id: "sha256:aa", createdAt: "2026-10-07T21:09:32.557822715Z" })).toEqual([]);
    expect(provenanceWarnings(harness, { id: "sha256:aa", createdAt: "2026-10-07T16:00:00Z" })).toHaveLength(1);
    expect(provenanceWarnings(harness, { id: "sha256:aa", createdAt: null })).toEqual([]);
    expect(provenanceWarnings(null, { id: "sha256:aa", createdAt: "2026-10-07T16:00:00Z" })).toEqual([]);
  });

  it("lists what differs between two runs' builds, and renders it with the baseline", () => {
    const at = (sha: string, dirty: boolean, image: string | null): E2EProvenance => ({
      harness: { sha, dirty, committedAt: null },
      gatewayImage: image ? { id: `sha256:${image}`, createdAt: null } : null,
      missing: [],
      warnings: [],
    });
    const other = "fedcba9876543210fedcba9876543210fedcba98";
    expect(buildChanges(at(SHA, false, "a".repeat(64)), at(SHA, false, "a".repeat(64)))).toEqual([]);
    expect(buildChanges(at(SHA, false, "a".repeat(64)), at(other, true, "b".repeat(64)))).toEqual([
      `gateway image ${"a".repeat(12)} → ${"b".repeat(12)}`,
      "harness 0123456 → fedcba9 (dirty)",
    ]);
    expect(buildChanges(at(SHA, true, null), at(SHA, true, "b".repeat(64)))).toEqual([
      "gateway image unknown in the baseline",
      "harness 0123456 (dirty) in both runs: the uncommitted changes may differ",
    ]);
    expect(buildChanges(undefined, at(SHA, false, null))).toBeNull();

    const before = buildReport([ran("a", "P")], { ...META, provenance: at(SHA, false, "a".repeat(64)) });
    const now = buildReport([ran("a", "P")], { ...META, provenance: at(SHA, false, "b".repeat(64)) });
    now.baseline = compareWithBaseline(now, before, "before.json");
    const markdown = renderMarkdown(now);
    expect(markdown).toContain(`- Build: harness 0123456 · gateway image ${"b".repeat(12)}\n`);
    expect(markdown).toContain(`- Builds: gateway image ${"a".repeat(12)} → ${"b".repeat(12)}`);
  });
});
