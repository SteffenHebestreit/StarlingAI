/**
 * Run verdicts of the e2e harness (src/e2e): when a run is environment-suspect, when a scenario or
 * the whole suite regressed against a baseline (stats.ts), and what the run ran on
 * (provenance.ts). The seven reports of 2026-10-07 (fixtures/e2e-reports-2026-10-07.json: the
 * reports as the harness wrote them, reduced to the fields the verdicts read) are re-graded with
 * today's rules.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs, no types
import * as buildProvenanceModule from "../../../../scripts/build-provenance.mjs";
// @ts-expect-error — plain .mjs, no types
import * as configDigestModule from "../../../../scripts/gateway-config-digest.mjs";
// @ts-expect-error — plain .mjs, no types
import * as serviceContainerModule from "../../../../scripts/service-container.mjs";
import { E2EInfraError, type HttpResult } from "../e2e/gateway-client.js";
import { buildReport, compareWithBaseline, describeBuildChanges, exitCodeFor, renderMarkdown, type E2EReport, type E2ERunMeta } from "../e2e/report.js";
import type { AttemptResult, ScenarioResult } from "../e2e/runner.js";
import type { ServiceState } from "../e2e/services.js";
import { compareSuite, compareTallies, signTestPValue } from "../e2e/stats.js";
import {
  buildChanges,
  captureProvenance,
  confounders,
  describeProvenance,
  gatewayConfigFromStatus,
  gatewayImageFromStatus,
  provenanceWarnings,
  readGatewayModel,
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

// ── the gateway image's build labels (scripts/build-provenance.mjs) ─────────

type GitAnswers = (args: string[]) => string | null;
type DockerRunner = (args: string[]) => { ok: boolean; out: string };

/** scripts/build-provenance.mjs, which `sai start` and `pnpm e2e:env` share. */
const buildProvenance = buildProvenanceModule as {
  BUILD_SHA_ARG: string;
  BUILD_DIRTY_ARG: string;
  BUILD_REVISION_LABEL: string;
  BUILD_DIRTY_LABEL: string;
  IMAGE_INSPECT_FORMAT: string;
  stampBuildRevision: (env: Record<string, string | undefined>, git: GitAnswers) => void;
  imageFromInspect: (id: string, inspected: string | null) => unknown;
  imageOfContainer: (docker: DockerRunner, container: string | null) => unknown;
};

/** scripts/gateway-config-digest.mjs, which `pnpm e2e:env status` runs in the gateway container. */
const configDigest = configDigestModule as {
  CONFIG_DIGEST_SCRIPT: string;
  configOfContainer: (docker: DockerRunner, container: string | null) => unknown;
};

/** The instructions of one Dockerfile stage: comments dropped, continuation lines joined. */
function dockerfileStage(text: string, stage: string): string[] {
  const instructions = text.replace(/\r\n/g, "\n").split("\n").filter((line) => !/^\s*#/.test(line)).join("\n")
    .replace(/\\\n/g, " ").split("\n").map((line) => line.trim()).filter(Boolean);
  const from = instructions.findIndex((line) => new RegExp(`^FROM\\s+\\S+\\s+AS\\s+${stage}$`, "i").test(line));
  if (from < 0) return [];
  const next = instructions.findIndex((line, index) => index > from && /^FROM\s/i.test(line));
  return instructions.slice(from + 1, next < 0 ? undefined : next);
}

/** The scalar entries of the block mapping at `path`, in YAML laid out as docker-compose.yml is. */
function yamlMapping(text: string, path: readonly string[]): Record<string, string> {
  const entries: Record<string, string> = {};
  const open: Array<{ indent: number; childIndent: number | null }> = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    while (open.length > 0 && indent <= open[open.length - 1]!.indent) open.pop();
    const parent = open[open.length - 1];
    if (parent) {
      parent.childIndent ??= indent;
      if (indent !== parent.childIndent) continue;
    } else if (indent !== 0) continue;
    const entry = /^([\w.-]+):(?:\s+(.*))?$/.exec(line.trim());
    if (!entry) continue;
    if (open.length === path.length) entries[entry[1]!] = (entry[2] ?? "").trim();
    else if (entry[1] === path[open.length]) open.push({ indent, childIndent: null });
  }
  return entries;
}

/** A top-level function of a script, from its signature to its closing brace. */
function functionSource(source: string, signature: string): string {
  const text = source.replace(/\r\n/g, "\n");
  const start = text.indexOf(signature);
  if (start < 0) return "";
  const end = text.indexOf("\n}\n", start);
  return text.slice(start, end < 0 ? undefined : end + 2);
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
    // No trial in a run (every attempt errored): no pass rate to compare, which is not "too few attempts".
    expect(compareTallies({ passed: 1, trials: 1 }, { passed: 0, trials: 0 })).toEqual({ change: "no-trial", ci: null });
    expect(compareTallies({ passed: 0, trials: 0 }, { passed: 3, trials: 3 })).toEqual({ change: "no-trial", ci: null });
    expect(compareTallies({ passed: 0, trials: 0 }, { passed: 0, trials: 0 })).toEqual({ change: "no-trial", ci: null });

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
    expect(compareSuite([pair([1, 1], [2, 3]), pair([3, 3], [0, 1])])).toMatchObject({ change: "inconclusive", lower: 0, higher: 0, same: 0, unpaired: 2, noTrial: 0 });
    // A run without a trial has no pass count to compare, whatever the other run's count.
    expect(compareSuite([pair([3, 3], [0, 0]), pair([0, 0], [0, 0]), pair([1, 1], [1, 1])])).toMatchObject({ change: "unchanged", same: 1, unpaired: 0, noTrial: 2 });
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

  it("marks a run suspect for what the CLI saw around its scenarios, whatever the scenarios did", () => {
    // core-build-artifact-mermaid on 2026-10-08: one failure, every scenario run, and a reranker that
    // answered every /rerank with a 500. Graded on the scenarios alone, that run exited 1.
    const results = [ran("core-build-artifact-mermaid", "F"), ...["b", "c", "d"].map((id) => ran(id, "P"))];
    const reranker = "the stack's reranker was not ready when the run began (starlingai-reranker-1: running, unhealthy): every turn's routing reranks through it, so a scenario may have failed on that alone";
    const report = buildReport(results, META, [reranker]);
    expect(report.environment).toEqual({ suspect: true, reasons: [reranker] });
    expect(exitCodeFor(report)).toBe(3);
    expect(renderMarkdown(report)).toContain(`> **Environment suspect** — ${reranker}`);
    // After the reasons the scenarios give.
    const skippedToo = buildReport([...results, skipped("e", [up("gateway"), down("model")])], META, [reranker]);
    expect(skippedToo.environment.reasons).toEqual([
      "1 of 5 selected scenarios were skipped because model was down (model: unreachable); it was up when d started, so it went down during the run",
      reranker,
    ]);
    // Nothing seen around them: the report is the one the scenarios alone give.
    expect(buildReport(results, META, [])).toEqual(buildReport(results, META));
    expect(exitCodeFor(buildReport(results, META, []))).toBe(1);
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
    // At k=3 a uniform pair that disagrees is 3/3 → 0/3, which is decisive: the footnote says no more than that.
    expect(markdown).toContain("Inconclusive: each run was uniform, but they disagree, and so few attempts cannot tell that from chance; "
      + "with three attempts or more on both sides (`--repeat 3`) such a complete flip (3/3 → 0/3) is decisive.");
    expect(markdown).not.toContain("No trial:");
  });

  it("shows no estimate for a scenario without a trial in a run, and does not blame the attempt count", () => {
    // Every attempt now ended on a harness error (e.g. the gateway dropped the socket): no verdict on the swarm.
    const baseline = buildReport([ran("crashes", "PPP"), ran("recovered", "EE"), ran("dark", "EE"), ran("steady", "PPP")], META);
    const report = buildReport([ran("crashes", "EEE"), ran("recovered", "PP"), ran("dark", "EE"), ran("steady", "PPP")], META);
    const comparison = compareWithBaseline(report, baseline, "baseline.json");
    expect(comparison.noTrial.map((delta) => [delta.id, delta.change, delta.ci])).toEqual([
      ["crashes", "no-trial", null],
      ["recovered", "no-trial", null],
      ["dark", "no-trial", null],
    ]);
    expect(comparison.inconclusive).toEqual([]);
    expect(comparison.unchanged).toBe(1);
    expect(comparison.suite).toMatchObject({ change: "unchanged", same: 1, unpaired: 0, noTrial: 3 });

    report.baseline = comparison;
    const markdown = renderMarkdown(report);
    expect(markdown).toContain("0 regression(s), 0 improvement(s), 0 flaky, 0 inconclusive, 3 with no trial, 1 unchanged, 0 new, 0 not run now.");
    expect(markdown).toContain("- Suite: 0 lower, 0 higher, 1 the same, 3 with no trial in a run left out — unchanged");
    expect(markdown).toContain("| `crashes` | 3/3 | 0/0 | none: no trial now | no trial |");
    expect(markdown).toContain("| `recovered` | 0/0 | 2/2 | none: no trial in the baseline | no trial |");
    expect(markdown).toContain("| `dark` | 0/0 | 0/0 | none: no trial in either run | no trial |");
    expect(markdown).not.toContain("−100 pp");
    expect(markdown).not.toContain("+100 pp");
    // The footnote about the attempt count is for uniform runs that disagree, not for a run without a verdict.
    expect(markdown).not.toContain("Inconclusive:");
    expect(markdown).toContain("No trial: in a run, every attempt of the scenario ended on a harness error or was interrupted, so that run has no pass rate to compare.");
  });
});

describe("e2e provenance", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const fakeGit = (answers: Record<string, string | null>): GitRunner => (_root, args) => answers[args.join(" ")] ?? null;
  const committed = { "rev-parse HEAD": SHA, "status --porcelain=v1": "", "log -1 --format=%cI HEAD": "2026-10-08T12:00:00+02:00" };

  it("reads HEAD, the dirty flag and the commit date, and never calls an unreadable tree clean", () => {
    expect(readHarnessSource("/repo", fakeGit(committed))).toEqual({ sha: SHA, dirty: false, changes: null, committedAt: "2026-10-08T12:00:00+02:00" });
    const edited = { ...committed, "status --porcelain=v1": " M config/gateway/10-gateway.jsonc", "diff --no-ext-diff --binary HEAD": "diff --git a/config/gateway/10-gateway.jsonc b/config/gateway/10-gateway.jsonc", "ls-files --others --exclude-standard -z": "" };
    expect(readHarnessSource("/repo", fakeGit(edited))).toMatchObject({ dirty: true, changes: expect.stringMatching(/^[0-9a-f]{64}$/) });
    // Changes git cannot list are unknown, never "the same as before".
    expect(readHarnessSource("/repo", fakeGit({ ...edited, "diff --no-ext-diff --binary HEAD": null }))).toMatchObject({ dirty: true, changes: null });
    expect(readHarnessSource("/repo", fakeGit({ ...edited, "ls-files --others --exclude-standard -z": null }))).toMatchObject({ dirty: true, changes: null });
    expect(readHarnessSource("/repo", fakeGit({ ...edited, "status --porcelain=v1": null }))).toMatchObject({ dirty: true, changes: null });
    // An untracked file that cannot be read (gone since git listed it) leaves the changes unknown.
    expect(readHarnessSource("/repo", fakeGit({ ...edited, "ls-files --others --exclude-standard -z": "eval/e2e/scenarios/gone.jsonc\0" }))).toMatchObject({ dirty: true, changes: null });
    expect(readHarnessSource("/repo", fakeGit({ ...committed, "rev-parse HEAD": null }))).toBeNull();
    expect(readHarnessSource("/repo", fakeGit({ ...committed, "rev-parse HEAD": "fatal: not a git repository" }))).toBeNull();

    // The real checkout this test runs in.
    const real = readHarnessSource(findRepoRoot());
    expect(real?.sha).toMatch(/^[0-9a-f]{40}/);
    expect(Number.isFinite(Date.parse(real?.committedAt ?? ""))).toBe(true);
    expect(real?.changes).toEqual(real?.dirty ? expect.stringMatching(/^[0-9a-f]{64}$/) : null);
  });

  it("digests the uncommitted changes, untracked files included, so two dirty runs can tell the same changes from others", () => {
    const repo = mkdtempSync(join(tmpdir(), "e2e-provenance-"));
    try {
      const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.test", ...args], { cwd: repo, stdio: ["ignore", "pipe", "ignore"] });
      git("init", "-q");
      writeFileSync(join(repo, "scenario.jsonc"), "{ \"id\": \"a\" }\n");
      writeFileSync(join(repo, ".gitignore"), "out/\n");
      git("add", "-A");
      git("commit", "-q", "-m", "base");
      expect(readHarnessSource(repo)).toMatchObject({ dirty: false, changes: null });

      writeFileSync(join(repo, "scenario.jsonc"), "{ \"id\": \"b\" }\n");
      const edited = readHarnessSource(repo)!.changes;
      expect(edited).toMatch(/^[0-9a-f]{64}$/);
      expect(readHarnessSource(repo)!.changes).toBe(edited);
      // What git ignores (reports, local shards) is not the harness.
      mkdirSync(join(repo, "out"));
      writeFileSync(join(repo, "out", "report.json"), "{}\n");
      expect(readHarnessSource(repo)!.changes).toBe(edited);
      // A new scenario file counts, by its content: the same name with other content differs.
      writeFileSync(join(repo, "new.jsonc"), "{ \"id\": \"c\" }\n");
      const added = readHarnessSource(repo)!.changes;
      expect(added).not.toBe(edited);
      writeFileSync(join(repo, "new.jsonc"), "{ \"id\": \"d\" }\n");
      expect(readHarnessSource(repo)!.changes).not.toBe(added);
      rmSync(join(repo, "new.jsonc"));
      expect(readHarnessSource(repo)!.changes).toBe(edited);
      // Another edit of the same tracked file.
      writeFileSync(join(repo, "scenario.jsonc"), "{ \"id\": \"e\" }\n");
      expect(readHarnessSource(repo)!.changes).not.toBe(edited);

      // A diff past execFileSync's 1 MiB default output still has a digest.
      writeFileSync(join(repo, "fixture.txt"), `${"x".repeat(80)}\n`.repeat(16_000));
      git("add", "fixture.txt");
      git("commit", "-q", "-m", "fixture");
      writeFileSync(join(repo, "fixture.txt"), `${"y".repeat(80)}\n`.repeat(16_000));
      expect(readHarnessSource(repo)!.changes).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("reads the gateway image from the e2e environment status, and records why when it cannot", async () => {
    // An image built before `sai start` stamped labels: id and build time only.
    const status = { gateway: { running: true, image: { id: `sha256:${"3b".repeat(32)}`, created: "2026-10-07T21:09:32.557822715Z", revision: null, dirty: null } } };
    expect(gatewayImageFromStatus(status)).toEqual({ id: `sha256:${"3b".repeat(32)}`, createdAt: "2026-10-07T21:09:32.557822715Z", revision: null, dirty: null });
    expect(gatewayImageFromStatus({ gateway: { running: false, image: null } })).toBeNull();
    expect(gatewayImageFromStatus({ mailService: { running: false } })).toBeNull();
    // The labels, as scripts/e2e-env.mjs reads them; anything but a commit id or a boolean is unknown.
    const labelled = (revision: unknown, dirty: unknown) => gatewayImageFromStatus({ gateway: { image: { id: "sha256:aa", created: null, revision, dirty } } });
    expect(labelled(SHA, true)).toEqual({ id: "sha256:aa", createdAt: null, revision: SHA, dirty: true });
    expect(labelled("", false)).toMatchObject({ revision: null, dirty: false });
    expect(labelled("0123456", "true")).toMatchObject({ revision: null, dirty: null });

    const config = { compiled: "a7".repeat(32), overlay: "absent" };
    const model = { active: null, activePrimary: null, defaultPrimary: "local/qwen3.6-35b", scope: "all" };
    const full = await captureProvenance("/repo", async () => ({ json: { gateway: { ...status.gateway, config } } }), {
      git: fakeGit(committed),
      model: async () => ({ model }),
    });
    expect(full).toEqual({
      harness: { sha: SHA, dirty: false, changes: null, committedAt: "2026-10-08T12:00:00+02:00" },
      gatewayImage: { id: `sha256:${"3b".repeat(32)}`, createdAt: "2026-10-07T21:09:32.557822715Z", revision: null, dirty: null },
      gatewayConfig: config,
      model,
      missing: [],
      // Built the evening before HEAD was committed.
      warnings: [`the gateway image ${"3b".repeat(6)} was built 2026-10-07T21:09:32.557822715Z, before the harness's HEAD 0123456 was committed (2026-10-08T12:00:00+02:00): the stack may not run the code under test`],
    });
    expect(describeProvenance(full)).toBe(`harness 0123456 · gateway image ${"3b".repeat(6)} built 2026-10-07T21:09:32.557822715Z · config ${"a7".repeat(6)}, no overlay · model local/qwen3.6-35b`);

    const blind = await captureProvenance("/repo", async () => ({ error: "pnpm e2e:env status --json gave no status (e2e:env: Docker is not reachable)" }), {
      git: fakeGit({}),
      model: async () => ({ missing: "model: the gateway is down" }),
    });
    expect(blind).toEqual({
      harness: null,
      gatewayImage: null,
      gatewayConfig: null,
      model: null,
      missing: [
        "harness: git could not read the checkout at /repo",
        "gateway image and config: pnpm e2e:env status --json gave no status (e2e:env: Docker is not reachable)",
        "model: the gateway is down",
      ],
      warnings: [],
    });
    expect(describeProvenance(blind)).toBe("harness unknown · gateway image unknown · config unknown · model unknown");
    expect((await captureProvenance("/repo", null, { git: fakeGit(committed) })).missing).toEqual(["gateway image and config: scripts/e2e-env.mjs not found", "model: not read"]);
    expect((await captureProvenance("/repo", async () => ({ json: { mailService: { running: false } } }), { git: fakeGit(committed), model: async () => ({ model }) })).missing).toEqual([
      "gateway image: the e2e environment status names none (no running gateway container of this checkout)",
      "gateway config: the e2e environment status names none (no running gateway container of this checkout)",
    ]);
    // A running gateway docker could not read is not "no running gateway".
    expect((await captureProvenance("/repo", async () => ({ json: { gateway: { running: true, image: null, config: null } } }), { git: fakeGit(committed), model: async () => ({ model }) })).missing).toEqual([
      "gateway image: docker could not read the running gateway container's image",
      "gateway config: the running gateway container did not report the digests of its config",
    ]);
  });

  it("reads the digests of the config files the gateway reads, inside its container", () => {
    const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
    const dir = mkdtempSync(join(tmpdir(), "e2e-config-digest-"));
    try {
      // The script `pnpm e2e:env status` runs in the gateway container (docker exec … node -e), run here on two temp files.
      const compiled = join(dir, "starlingai.json");
      const overlay = join(dir, "starlingai.runtime.json");
      writeFileSync(compiled, "{\"agents\":{\"defaults\":{\"model\":{\"primary\":\"local/qwen3.6-35b\"}}}}\n");
      const inContainer = (paths: { SAI_CONFIG_PATH?: string; SAI_MUTABLE_CONFIG_PATH?: string }): unknown => {
        const env: NodeJS.ProcessEnv = { ...process.env };
        delete env["SAI_CONFIG_PATH"];
        delete env["SAI_MUTABLE_CONFIG_PATH"];
        return JSON.parse(execFileSync(process.execPath, ["-e", configDigest.CONFIG_DIGEST_SCRIPT], { env: { ...env, ...paths }, encoding: "utf8" }));
      };
      // No overlay yet: no runtime change was ever saved.
      expect(inContainer({ SAI_CONFIG_PATH: compiled, SAI_MUTABLE_CONFIG_PATH: overlay })).toEqual({ compiled: sha256(readFileSync(compiled, "utf8")), overlay: "absent" });
      // The dashboard switched the preset.
      writeFileSync(overlay, "{\"agents\":{\"defaults\":{\"activeModelPreset\":\"claude\"}}}");
      expect(inContainer({ SAI_CONFIG_PATH: compiled, SAI_MUTABLE_CONFIG_PATH: overlay })).toEqual({ compiled: sha256(readFileSync(compiled, "utf8")), overlay: sha256(readFileSync(overlay, "utf8")) });
      // Unset, or not a readable file: unknown, not absent.
      expect(inContainer({})).toEqual({ compiled: null, overlay: null });
      expect(inContainer({ SAI_CONFIG_PATH: dir, SAI_MUTABLE_CONFIG_PATH: overlay })).toMatchObject({ compiled: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // Through docker, into the status, into the provenance.
    const answer = { compiled: "a7".repeat(32), overlay: "absent" };
    const calls: string[][] = [];
    const exec = ["exec", "starlingai-gateway-1", "node", "-e", configDigest.CONFIG_DIGEST_SCRIPT];
    const docker = (out: string | null): DockerRunner => (args) => {
      calls.push(args);
      return out !== null && args.join(" ") === exec.join(" ") ? { ok: true, out } : { ok: false, out: "" };
    };
    const config = configDigest.configOfContainer(docker(JSON.stringify(answer)), "starlingai-gateway-1");
    expect(calls).toEqual([exec]);
    expect(config).toEqual(answer);
    expect(gatewayConfigFromStatus({ gateway: { running: true, config } })).toEqual(answer);
    expect(configDigest.configOfContainer(docker(JSON.stringify({ compiled: "not a digest", overlay: "b".repeat(64) })), "starlingai-gateway-1")).toEqual({ compiled: null, overlay: "b".repeat(64) });
    expect(configDigest.configOfContainer(docker("node: not found"), "starlingai-gateway-1")).toBeNull();
    expect(configDigest.configOfContainer(docker(null), "starlingai-gateway-1")).toBeNull();
    expect(configDigest.configOfContainer(docker(JSON.stringify(answer)), null)).toBeNull();
    expect(gatewayConfigFromStatus({ gateway: { running: true, config: null } })).toBeNull();
    expect(gatewayConfigFromStatus({ gateway: { running: true, config: { compiled: null, overlay: null } } })).toBeNull();
    expect(gatewayConfigFromStatus({ gateway: { config: { compiled: "a7".repeat(32), overlay: "b".repeat(63) } } })).toEqual({ compiled: "a7".repeat(32), overlay: null });

    // `pnpm e2e:env status` reports it.
    const environment = readFileSync(join(findRepoRoot(), "scripts", "e2e-env.mjs"), "utf8");
    expect(environment).toMatch(/^import \{ configOfContainer \} from "\.\/gateway-config-digest\.mjs";$/m);
    expect(functionSource(environment, "async function collectStatus(")).toMatch(/\bgateway: \{[^}]*\bconfig: configOfContainer\(docker, gatewayRunning\),/);
  });

  it("reads the models the gateway answers with from its preset route, and why when it cannot", async () => {
    const answer = (status: number, json: unknown) => async (path: string): Promise<HttpResult> => {
      expect(path).toBe("/api/models/preset");
      return { status, ok: status >= 200 && status < 300, text: JSON.stringify(json), json };
    };
    // Only the ids: not the preset list.
    expect(await readGatewayModel(answer(200, {
      active: "claude", activePrimary: "anthropic/claude-opus-4-1", defaultPrimary: "local/qwen3.6-35b", scope: "coordinator_qa",
      presets: [{ name: "claude", primary: "anthropic/claude-opus-4-1" }],
    }))).toEqual({ model: { active: "claude", activePrimary: "anthropic/claude-opus-4-1", defaultPrimary: "local/qwen3.6-35b", scope: "coordinator_qa" } });
    expect(await readGatewayModel(answer(200, { active: null, activePrimary: null, defaultPrimary: "local/qwen3.6-35b", scope: "all" })))
      .toEqual({ model: { active: null, activePrimary: null, defaultPrimary: "local/qwen3.6-35b", scope: "all" } });
    expect(await readGatewayModel(answer(404, { error: "not found" }))).toEqual({ missing: "model: GET /api/models/preset answered HTTP 404" });
    expect(await readGatewayModel(answer(200, { active: null }))).toEqual({ missing: "model: GET /api/models/preset named no model" });
    expect(await readGatewayModel(async () => { throw new E2EInfraError("GET /api/models/preset failed: fetch failed"); }))
      .toEqual({ missing: "model: GET /api/models/preset failed: fetch failed" });
  });

  it("without a revision label, warns only when the image was built before HEAD was committed", () => {
    const harness = { sha: SHA, dirty: false, changes: null, committedAt: "2026-10-07T18:27:27+02:00" };
    const unlabelled = (createdAt: string | null) => ({ id: "sha256:aa", createdAt, revision: null, dirty: null });
    expect(provenanceWarnings(harness, unlabelled("2026-10-07T21:09:32.557822715Z"))).toEqual([]);
    expect(provenanceWarnings(harness, unlabelled("2026-10-07T16:00:00Z"))).toHaveLength(1);
    expect(provenanceWarnings(harness, unlabelled(null))).toEqual([]);
    expect(provenanceWarnings(null, unlabelled("2026-10-07T16:00:00Z"))).toEqual([]);
  });

  it("compares an image that names its commit with HEAD, whatever its build time", () => {
    const other = "fedcba9876543210fedcba9876543210fedcba98";
    const clean = { sha: SHA, dirty: false, changes: null, committedAt: "2026-10-08T12:00:00+02:00" };
    const dirty = { ...clean, dirty: true, changes: "d1".repeat(32) };
    // Built before HEAD's commit date, yet from HEAD: the label is exact, the time only a fallback.
    const image = (revision: string, built: boolean | null, createdAt = "2026-10-07T21:09:32Z") => ({ id: `sha256:${"4c".repeat(32)}`, createdAt, revision, dirty: built });
    expect(provenanceWarnings(clean, image(SHA, false))).toEqual([]);
    expect(provenanceWarnings(dirty, image(SHA, true))).toEqual([]);
    expect(provenanceWarnings(dirty, image(SHA, false))).toEqual([]);
    // Built from another commit, though after HEAD was committed.
    expect(provenanceWarnings(clean, image(other, false, "2026-10-09T08:00:00Z"))).toEqual([
      `the gateway image ${"4c".repeat(6)} was built from fedcba9, but the harness runs 0123456: the stack may not run the code under test`,
    ]);
    // Built from HEAD plus changes the clean checkout no longer has.
    expect(provenanceWarnings(clean, image(SHA, true))).toEqual([
      `the gateway image ${"4c".repeat(6)} was built from 0123456 with uncommitted changes the checkout no longer has: the stack may not run the code under test`,
    ]);
    expect(describeProvenance({ harness: dirty, gatewayImage: image(SHA, true), gatewayConfig: null, model: null, missing: [], warnings: [] }))
      .toBe(`harness 0123456 (dirty) · gateway image ${"4c".repeat(6)} from 0123456 (dirty) built 2026-10-07T21:09:32Z · config unknown · model unknown`);
  });

  it("lists what differs between two runs' builds, and renders it with the baseline", () => {
    const CONFIG = { compiled: "a7".repeat(32), overlay: "absent" };
    const LOCAL = { active: null, activePrimary: null, defaultPrimary: "local/qwen3.6-35b", scope: "all" };
    const at = (sha: string, dirty: boolean, image: string | null, revision: string | null = null, changes: string | null = dirty ? "d1".repeat(32) : null): E2EProvenance => ({
      harness: { sha, dirty, changes, committedAt: null },
      gatewayImage: image ? { id: `sha256:${image}`, createdAt: null, revision, dirty: revision ? dirty : null } : null,
      gatewayConfig: CONFIG,
      model: LOCAL,
      missing: [],
      warnings: [],
    });
    const other = "fedcba9876543210fedcba9876543210fedcba98";
    expect(buildChanges(at(SHA, false, "a".repeat(64)), at(SHA, false, "a".repeat(64)))).toEqual([]);
    expect(describeBuildChanges([])).toBe("same gateway image, config, model and harness checkout");
    expect(buildChanges(at(SHA, false, "a".repeat(64)), at(other, true, "b".repeat(64)))).toEqual([
      `gateway image ${"a".repeat(12)} → ${"b".repeat(12)}`,
      "harness 0123456 → fedcba9 (dirty)",
    ]);
    expect(buildChanges(at(SHA, false, "a".repeat(64), SHA), at(other, true, "b".repeat(64), other))).toEqual([
      `gateway image ${"a".repeat(12)} from 0123456 → ${"b".repeat(12)} from fedcba9 (dirty)`,
      "harness 0123456 → fedcba9 (dirty)",
    ]);
    expect(buildChanges(at(SHA, true, null, null, null), at(SHA, true, "b".repeat(64)))).toEqual([
      "gateway image unknown in the baseline",
      "harness 0123456 (dirty) in both runs: the uncommitted changes may differ",
    ]);
    expect(buildChanges(undefined, at(SHA, false, null))).toBeNull();

    // Two dirty runs of one commit: the digest of the uncommitted changes tells.
    expect(buildChanges(at(SHA, true, "a".repeat(64)), at(SHA, true, "a".repeat(64)))).toEqual([]);
    expect(buildChanges(at(SHA, true, "a".repeat(64)), at(SHA, true, "a".repeat(64), null, "d2".repeat(32)))).toEqual([
      "harness 0123456 (dirty) in both runs: the uncommitted changes differ",
    ]);

    // Same image and checkout. A flag flipped in a gitignored *.local.jsonc shard: the compiled config differs.
    const same = at(SHA, false, "a".repeat(64));
    expect(buildChanges(same, { ...same, gatewayConfig: { ...CONFIG, compiled: "c3".repeat(32) } })).toEqual([`compiled config ${"a7".repeat(6)} → ${"c3".repeat(6)}`]);
    // The dashboard switched the preset: the runtime overlay and the model differ.
    const claude = { active: "claude", activePrimary: "anthropic/claude-opus-4-1", defaultPrimary: "local/qwen3.6-35b", scope: "all" };
    expect(buildChanges(same, { ...same, gatewayConfig: { ...CONFIG, overlay: "e5".repeat(32) }, model: claude })).toEqual([
      `runtime overlay none → ${"e5".repeat(6)}`,
      "model local/qwen3.6-35b → anthropic/claude-opus-4-1 (preset claude)",
    ]);
    // A preset for some agents only: the others keep the default.
    expect(buildChanges(same, { ...same, model: { ...claude, scope: "coordinator_qa" } })).toEqual([
      "model local/qwen3.6-35b → anthropic/claude-opus-4-1 for coordinator_qa, else local/qwen3.6-35b (preset claude)",
    ]);
    // Without a preset its scope changes nothing.
    expect(buildChanges(same, { ...same, model: { ...LOCAL, scope: "coordinator_qa" } })).toEqual([]);
    // Unknown on one side is said, never taken for "the same".
    expect(buildChanges({ ...same, gatewayConfig: null, model: null }, same)).toEqual(["gateway config unknown in the baseline", "model unknown in the baseline"]);
    expect(buildChanges(same, { ...same, gatewayConfig: { compiled: null, overlay: "absent" } })).toEqual(["compiled config unknown in this run"]);

    const before = buildReport([ran("a", "P")], { ...META, provenance: at(SHA, false, "a".repeat(64)) });
    const now = buildReport([ran("a", "P")], { ...META, provenance: { ...at(SHA, false, "b".repeat(64)), model: claude } });
    now.baseline = compareWithBaseline(now, before, "before.json");
    // A model or config change is what an A/B run is for: listed, not confounded.
    expect(now.baseline.confounded).toEqual([]);
    const markdown = renderMarkdown(now);
    expect(markdown).toContain(`- Build: harness 0123456 · gateway image ${"b".repeat(12)} · config ${"a7".repeat(6)}, no overlay · model anthropic/claude-opus-4-1 (preset claude)\n`);
    expect(markdown).toContain(`- Builds: gateway image ${"a".repeat(12)} → ${"b".repeat(12)}; model local/qwen3.6-35b → anthropic/claude-opus-4-1 (preset claude)`);
    expect(markdown).not.toContain("Confounded");
  });

  it("labels a baseline comparison confounded when either run's stack may not have run its checkout's code", () => {
    const stale = "the gateway image 4c4c4c4c4c4c was built from fedcba9, but the harness runs 0123456: the stack may not run the code under test";
    const old = "the gateway image 3b3b3b3b3b3b was built 2026-10-07T16:00:00Z, before the harness's HEAD 0123456 was committed (2026-10-07T18:27:27+02:00): the stack may not run the code under test";
    const at = (warnings: string[]): E2EProvenance => ({ harness: null, gatewayImage: null, gatewayConfig: null, model: null, missing: [], warnings });
    expect(confounders(at([old]), at([stale]))).toEqual([`this run: ${stale}`, `the baseline: ${old}`]);
    expect(confounders(at([]), at([]))).toEqual([]);
    // A baseline from before provenance tells nothing either way.
    expect(confounders(undefined, at([stale]))).toEqual([`this run: ${stale}`]);

    const before = buildReport([ran("a", "P")], META);
    const now = buildReport([ran("a", "P")], { ...META, provenance: at([stale]) });
    now.baseline = compareWithBaseline(now, before, "before.json");
    expect(now.baseline.confounded).toEqual([`this run: ${stale}`]);
    const markdown = renderMarkdown(now);
    expect(markdown).toContain(`> **Provenance** — ${stale}`);
    expect(markdown).toContain(`- **Confounded** — this run: ${stale}`);
  });
});

describe("e2e provenance — the gateway image's build labels, from git to the report", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const ID = `sha256:${"3b".repeat(32)}`;
  const CREATED = "2026-10-07T21:09:32.557822715Z";
  const { BUILD_SHA_ARG, BUILD_DIRTY_ARG, BUILD_REVISION_LABEL, BUILD_DIRTY_LABEL, IMAGE_INSPECT_FORMAT } = buildProvenance;
  const git = (answers: Record<string, string | null>): GitAnswers => (args) => answers[args.join(" ")] ?? null;
  /** Docker answering by its arguments; a command without an answer fails. */
  const docker = (answers: Record<string, string>, calls: string[][] = []): DockerRunner => (args) => {
    calls.push(args);
    const out = answers[args.join(" ")];
    return out === undefined ? { ok: false, out: "" } : { ok: true, out };
  };
  /** Docker for one running gateway container whose image carries these labels. */
  const gatewayContainer = (labels: Record<string, string> | null): DockerRunner => docker({
    "inspect --format {{.Image}} starlingai-gateway-1": ID,
    [`image inspect --format ${IMAGE_INSPECT_FORMAT} ${ID}`]: `${JSON.stringify(CREATED)}\t${JSON.stringify(labels)}`,
  });
  const root = findRepoRoot();

  it("stamps HEAD and the dirty flag for the build, and clears both outside a git checkout", () => {
    const env: Record<string, string | undefined> = {};
    buildProvenance.stampBuildRevision(env, git({ "rev-parse HEAD": SHA, "status --porcelain": "" }));
    expect(env).toEqual({ SAI_BUILD_SHA: SHA, SAI_BUILD_DIRTY: "false" });
    buildProvenance.stampBuildRevision(env, git({ "rev-parse HEAD": SHA, "status --porcelain": "?? eval/e2e/scenarios/new.jsonc" }));
    expect(env).toEqual({ SAI_BUILD_SHA: SHA, SAI_BUILD_DIRTY: "true" });
    // A status git could not produce is not a clean tree.
    buildProvenance.stampBuildRevision(env, git({ "rev-parse HEAD": SHA, "status --porcelain": null }));
    expect(env["SAI_BUILD_DIRTY"]).toBe("true");
    // Outside a checkout, values left in the shell must not label the image.
    for (const head of [null, "fatal: not a git repository (or any of the parent directories): .git"]) {
      const shell: Record<string, string | undefined> = { SAI_BUILD_SHA: SHA, SAI_BUILD_DIRTY: "false", PATH: "/usr/bin" };
      buildProvenance.stampBuildRevision(shell, git({ "rev-parse HEAD": head, "status --porcelain": "" }));
      expect(shell).toEqual({ PATH: "/usr/bin" });
    }
  });

  it("reads the image's build time and labels as docker image inspect prints them", () => {
    // The stack's gateway image on 2026-10-08, built before the labels: compose's own labels only.
    const unlabelled = `"${CREATED}"\t{"com.docker.compose.project":"starlingai","com.docker.compose.service":"gateway","com.docker.compose.version":"5.5.1"}`;
    expect(buildProvenance.imageFromInspect(ID, unlabelled)).toEqual({ id: ID, created: CREATED, revision: null, dirty: null });
    const labelled = (revision: string, dirty: string) => `"${CREATED}"\t${JSON.stringify({ [BUILD_REVISION_LABEL]: revision, [BUILD_DIRTY_LABEL]: dirty })}`;
    expect(buildProvenance.imageFromInspect(ID, labelled(SHA, "true"))).toEqual({ id: ID, created: CREATED, revision: SHA, dirty: true });
    expect(buildProvenance.imageFromInspect(ID, labelled(SHA, "false"))).toEqual({ id: ID, created: CREATED, revision: SHA, dirty: false });
    expect(buildProvenance.imageFromInspect(ID, labelled(SHA, "yes"))).toEqual({ id: ID, created: CREATED, revision: SHA, dirty: null });
    // Built another way: empty args, empty labels.
    expect(buildProvenance.imageFromInspect(ID, labelled("", ""))).toEqual({ id: ID, created: CREATED, revision: null, dirty: null });
    // No label at all prints null; a failed or garbled inspect leaves the id alone.
    expect(buildProvenance.imageFromInspect(ID, `"${CREATED}"\tnull`)).toEqual({ id: ID, created: CREATED, revision: null, dirty: null });
    expect(buildProvenance.imageFromInspect(ID, null)).toEqual({ id: ID, created: null, revision: null, dirty: null });
    expect(buildProvenance.imageFromInspect(ID, "Error: No such image")).toEqual({ id: ID, created: null, revision: null, dirty: null });
  });

  it("asks docker for the container's image, then for that image's build time and labels", () => {
    const calls: string[][] = [];
    const runner = docker({
      "inspect --format {{.Image}} starlingai-gateway-1": ID,
      [`image inspect --format ${IMAGE_INSPECT_FORMAT} ${ID}`]: `"${CREATED}"\tnull`,
    }, calls);
    expect(buildProvenance.imageOfContainer(runner, "starlingai-gateway-1")).toEqual({ id: ID, created: CREATED, revision: null, dirty: null });
    expect(calls).toEqual([
      ["inspect", "--format", "{{.Image}}", "starlingai-gateway-1"],
      ["image", "inspect", "--format", "{{json .Created}}\t{{json .Config.Labels}}", ID],
    ]);
    // No container (the stack is down, or not this checkout's): no docker call, no image.
    expect(buildProvenance.imageOfContainer(docker({}, calls), null)).toBeNull();
    expect(calls).toHaveLength(2);
    expect(buildProvenance.imageOfContainer(docker({}), "starlingai-gateway-1")).toBeNull();
    // The image id without its metadata.
    expect(buildProvenance.imageOfContainer(docker({ "inspect --format {{.Image}} starlingai-gateway-1": ID }), "starlingai-gateway-1"))
      .toEqual({ id: ID, created: null, revision: null, dirty: null });
  });

  it("carries the commit from sai start through the compose build args and the Dockerfile's labels to the report", () => {
    // docker-compose.yml: the gateway builds the runtime stage and passes both args from the environment.
    const compose = readFileSync(join(root, "docker-compose.yml"), "utf8");
    const build = yamlMapping(compose, ["services", "gateway", "build"]);
    expect(build["target"]).toBe("runtime");
    const composeArgs = yamlMapping(compose, ["services", "gateway", "build", "args"]);
    expect(Object.keys(composeArgs).sort()).toEqual([BUILD_DIRTY_ARG, BUILD_SHA_ARG].sort());

    // docker/gateway/Dockerfile: that stage declares both args, then labels the image with them.
    const stage = dockerfileStage(readFileSync(join(root, "docker", "gateway", "Dockerfile"), "utf8"), build["target"]!);
    const labelArgs = new Map<string, { arg: string; at: number }>();
    stage.forEach((instruction, at) => {
      if (!/^LABEL\s/i.test(instruction)) return;
      for (const [, label, arg] of instruction.matchAll(/([\w.-]+)="\$\{(\w+)\}"/g)) labelArgs.set(label!, { arg: arg!, at });
    });
    expect(labelArgs.get(BUILD_REVISION_LABEL)?.arg).toBe(BUILD_SHA_ARG);
    expect(labelArgs.get(BUILD_DIRTY_LABEL)?.arg).toBe(BUILD_DIRTY_ARG);
    for (const { arg, at } of labelArgs.values()) {
      // An ARG is in scope only after its declaration in the stage that uses it.
      const declared = stage.findIndex((instruction) => new RegExp(`^ARG\\s+${arg}(=.*)?$`).test(instruction));
      expect(declared, arg).toBeGreaterThanOrEqual(0);
      expect(declared, arg).toBeLessThan(at);
    }

    // The chain: the environment `sai start` stamps → compose substitutes the args → the labels →
    // `docker image inspect` → `pnpm e2e:env status --json` → the provenance a report records.
    const imageBuiltFrom = (env: Record<string, string | undefined>) => {
      const args = Object.fromEntries(Object.entries(composeArgs).map(([name, value]) => {
        const variable = /^\$\{(\w+)(?::-([^}]*))?\}$/.exec(value);
        expect(variable, `${name}: ${value}`).not.toBeNull();
        return [name, env[variable![1]!] || (variable![2] ?? "")];
      }));
      const labels = { "com.docker.compose.service": "gateway", ...Object.fromEntries([...labelArgs].map(([label, { arg }]) => [label, args[arg] ?? ""])) };
      const image = buildProvenance.imageOfContainer(gatewayContainer(labels), "starlingai-gateway-1");
      return gatewayImageFromStatus({ gateway: { running: true, image } });
    };
    const clean: Record<string, string | undefined> = {};
    buildProvenance.stampBuildRevision(clean, git({ "rev-parse HEAD": SHA, "status --porcelain": "" }));
    expect(imageBuiltFrom(clean)).toEqual({ id: ID, createdAt: CREATED, revision: SHA, dirty: false });
    const dirty: Record<string, string | undefined> = {};
    buildProvenance.stampBuildRevision(dirty, git({ "rev-parse HEAD": SHA, "status --porcelain": " M packages/core/src/e2e/report.ts" }));
    expect(imageBuiltFrom(dirty)).toEqual({ id: ID, createdAt: CREATED, revision: SHA, dirty: true });
    // Built without `sai start`: the image names no commit, and the harness falls back to the build time.
    expect(imageBuiltFrom({})).toEqual({ id: ID, createdAt: CREATED, revision: null, dirty: null });
  });

  it("is stamped by sai start before any image is built, and read by e2e:env status", () => {
    const sai = readFileSync(join(root, "scripts", "sai.mjs"), "utf8");
    expect(sai).toMatch(/^import \{ stampBuildRevision \} from "\.\/build-provenance\.mjs";$/m);
    const start = functionSource(sai, "async function cmdStart(");
    const stamp = start.indexOf("stampBuildRevision(process.env, ");
    expect(stamp).toBeGreaterThan(-1);
    for (const command of ['dc("build"', 'dc("up"']) {
      expect(start.indexOf(command), command).toBeGreaterThan(stamp);
    }
    const environment = readFileSync(join(root, "scripts", "e2e-env.mjs"), "utf8");
    expect(environment).toMatch(/^import \{ imageOfContainer \} from "\.\/build-provenance\.mjs";$/m);
    expect(functionSource(environment, "async function collectStatus(")).toMatch(/\bgateway: \{[^}]*\bimage: imageOfContainer\(docker, gatewayRunning\),/);
  });
});

// ── the stack's reranker, as `pnpm e2e:env status` reports it (scripts/service-container.mjs) ──

type DockerWithErrors = (args: string[]) => { ok: boolean; out: string; err: string };

/** scripts/service-container.mjs, which `pnpm e2e:env status` reads each container through. */
const serviceContainers = serviceContainerModule as {
  serviceContainer: (docker: DockerWithErrors, project: string, service: string) => unknown;
};

describe("e2e environment — the stack's reranker, as e2e:env status reports it", () => {
  const root = findRepoRoot();
  const NAME = "starlingai-reranker-1";
  const answering = (result: { ok: boolean; out: string; err: string }, calls: string[][] = []): DockerWithErrors => (args) => {
    calls.push(args);
    return result;
  };
  const read = (out: string, calls?: string[][]) => serviceContainers.serviceContainer(answering({ ok: true, out, err: "" }, calls), "starlingai", "reranker");

  it("reads the container's state and Docker's health of it, and tells a docker that could not be asked from no container", () => {
    const calls: string[][] = [];
    expect(read(`${NAME}\trunning\tUp 3 hours (healthy)`, calls)).toEqual({ name: NAME, state: "running", health: "healthy" });
    expect(calls).toEqual([["ps", "-a", "--filter", "label=com.docker.compose.project=starlingai", "--filter", "label=com.docker.compose.service=reranker", "--format", "{{.Names}}\t{{.State}}\t{{.Status}}"]]);
    expect(read(`${NAME}\trunning\tUp 2 minutes (unhealthy)`)).toEqual({ name: NAME, state: "running", health: "unhealthy" });
    expect(read(`${NAME}\trunning\tUp 20 seconds (health: starting)`)).toEqual({ name: NAME, state: "running", health: "health: starting" });
    expect(read(`${NAME}\trunning\tUp 3 hours`)).toEqual({ name: NAME, state: "running", health: "no healthcheck" });
    expect(read(`${NAME}\texited\tExited (0) 2 hours ago`)).toEqual({ name: NAME, state: "exited", health: "-" });
    // No such container: the rag profile is off.
    expect(read("")).toBeNull();
    // A docker that failed is not "no container", which the harness reads as a stack without a reranker.
    const daemonDown = answering({ ok: false, out: "", err: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.\nIs the docker daemon running?" });
    expect(serviceContainers.serviceContainer(daemonDown, "starlingai", "reranker")).toEqual({ error: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock." });
    expect(serviceContainers.serviceContainer(answering({ ok: false, out: "", err: "" }), "starlingai", "reranker")).toEqual({ error: "docker ps failed" });
  });

  it("is what e2e:env status reports as its reranker, a docker that could not be asked included", () => {
    const environment = readFileSync(join(root, "scripts", "e2e-env.mjs"), "utf8");
    expect(environment).toMatch(/^import \{ serviceContainer \} from "\.\/service-container\.mjs";$/m);
    const collect = functionSource(environment, "async function collectStatus(");
    expect(collect).toContain('const reranker = serviceContainer(docker, stack.project, "reranker");');
    expect(collect).toContain('reranker: reranker && !("error" in reranker) ? { container: reranker.name, state: reranker.state, health: reranker.health } : reranker,');
  });
});
