/**
 * Run verdicts of the e2e harness (src/e2e): when a run is environment-suspect. The seven reports
 * of 2026-10-07 (fixtures/e2e-reports-2026-10-07.json: the reports as the harness wrote them,
 * reduced to the fields the verdicts read) are re-graded with today's rules.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildReport, exitCodeFor, renderMarkdown, type E2EReport, type E2ERunMeta } from "../e2e/report.js";
import type { AttemptResult, ScenarioResult } from "../e2e/runner.js";
import type { ServiceState } from "../e2e/services.js";

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

const FULL_2207 = "2026-10-07T22-07-37-965Z.json";

// ── tests ────────────────────────────────────────────────────────────────────

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
});
