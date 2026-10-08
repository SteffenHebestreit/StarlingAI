/**
 * The run report: artifacts/evaluations/e2e/<timestamp>.json plus a Markdown summary beside it.
 * Per scenario: every attempt with its outcome, failures, duration, the audit-event type counts
 * and the tools and agents its turns used; overall: the attempt pass rate and pass^k (the share of
 * scenarios whose every attempt passed). With a baseline report, scenarios whose pass rate fell
 * are listed as regressions.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { E2EService } from "./scenario.js";
import type { ScenarioResult } from "./runner.js";

export interface E2ERunMeta {
  startedAt: string;
  finishedAt: string;
  gatewayUrl: string;
  repeat: number;
  concurrency: number;
  filters: { groups: string[]; tags: string[]; ids: string[] };
  /** "model @ url", or null when no judge is configured. */
  judge: string | null;
  /** "greenmail @ api (inbox x)", or null. */
  mail: string | null;
}

export interface E2EReportSummary {
  scenarios: number;
  run: number;
  passed: number;
  failed: number;
  skipped: number;
  attempts: number;
  attemptsPassed: number;
  attemptsFailed: number;
  attemptsErrored: number;
  /** attemptsPassed / attempts (0 when nothing ran). */
  passRate: number;
  /** pass^k: scenarios whose every attempt passed / scenarios run. */
  passAllRate: number;
}

export interface BaselineDelta {
  id: string;
  baselinePassRate: number;
  passRate: number;
  baselinePassAll: boolean;
  passAll: boolean;
}

export interface BaselineComparison {
  file: string;
  regressions: BaselineDelta[];
  improvements: BaselineDelta[];
  unchanged: number;
  /** Run now, not run in the baseline. */
  newScenarios: string[];
  /** Run in the baseline, not run now (filtered out or skipped). */
  missingScenarios: string[];
}

export interface E2EReport {
  kind: "e2e-evaluation";
  version: 1;
  meta: E2ERunMeta & { durationMs: number };
  summary: E2EReportSummary;
  /** suspect: the run says more about the environment than about the swarm. */
  environment: { suspect: boolean; reasons: string[] };
  scenarios: ScenarioResult[];
  baseline?: BaselineComparison;
}

const ERROR_SHARE_SUSPECT = 0.25;
/**
 * One service down for a fifth of the selected scenarios: the run measured that service. The full
 * run of 2026-10-07 22:07 skipped 47 of 52 scenarios after the model endpoint died mid-run (a down
 * probe is cached for a minute, and a skip ends at once), and read "4 passed, 1 failed".
 */
const SERVICE_SKIP_SHARE_SUSPECT = 0.2;

interface ServiceOutage {
  service: E2EService;
  skipped: number;
  /** The first skip's probe answer. */
  detail: string;
  /** The last scenario that saw the service up before the first skip: it went down during the run. */
  upBefore: string | null;
}

/** Per service, the scenarios skipped because it was down, in run order. */
function serviceOutages(results: readonly ScenarioResult[]): ServiceOutage[] {
  const outages = new Map<E2EService, ServiceOutage>();
  const lastUp = new Map<E2EService, string>();
  for (const result of results) {
    for (const state of result.services) {
      if (state.up) {
        lastUp.set(state.service, result.id);
      } else if (result.status === "skipped") {
        const outage = outages.get(state.service);
        if (outage) outage.skipped += 1;
        else outages.set(state.service, { service: state.service, skipped: 1, detail: state.detail, upBefore: lastUp.get(state.service) ?? null });
      }
    }
  }
  return [...outages.values()];
}

export function summarize(results: readonly ScenarioResult[]): E2EReportSummary {
  const ran = results.filter((result) => result.status !== "skipped");
  const attempts = ran.flatMap((result) => result.attempts);
  const attemptsPassed = attempts.filter((attempt) => attempt.outcome === "passed").length;
  const attemptsErrored = attempts.filter((attempt) => attempt.outcome === "error").length;
  const passed = ran.filter((result) => result.passAll).length;
  return {
    scenarios: results.length,
    run: ran.length,
    passed,
    failed: ran.length - passed,
    skipped: results.length - ran.length,
    attempts: attempts.length,
    attemptsPassed,
    attemptsFailed: attempts.length - attemptsPassed - attemptsErrored,
    attemptsErrored,
    passRate: attempts.length > 0 ? attemptsPassed / attempts.length : 0,
    passAllRate: ran.length > 0 ? passed / ran.length : 0,
  };
}

export function buildReport(results: readonly ScenarioResult[], meta: E2ERunMeta): E2EReport {
  const summary = summarize(results);
  const reasons: string[] = [];
  if (summary.scenarios > 0 && summary.run === 0) {
    reasons.push(`every selected scenario was skipped (${summary.skipped}) — required services were down`);
  } else {
    for (const outage of serviceOutages(results)) {
      if (outage.skipped / summary.scenarios < SERVICE_SKIP_SHARE_SUSPECT) continue;
      reasons.push(`${outage.skipped} of ${summary.scenarios} selected scenarios were skipped because ${outage.service} was down (${outage.detail})`
        + (outage.upBefore ? `; it was up when ${outage.upBefore} started, so it went down during the run` : ""));
    }
  }
  if (summary.attempts > 0 && summary.attemptsErrored / summary.attempts >= ERROR_SHARE_SUSPECT) {
    reasons.push(`${summary.attemptsErrored} of ${summary.attempts} attempts ended on a harness/environment error, not on an expectation`);
  }
  return {
    kind: "e2e-evaluation",
    version: 1,
    meta: { ...meta, durationMs: Date.parse(meta.finishedAt) - Date.parse(meta.startedAt) },
    summary,
    environment: { suspect: reasons.length > 0, reasons },
    scenarios: [...results],
  };
}

export function loadReport(path: string): E2EReport {
  if (!existsSync(path)) throw new Error(`baseline report not found: ${path}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`baseline report ${path} is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  const report = parsed as Partial<E2EReport>;
  if (report?.kind !== "e2e-evaluation" || !Array.isArray(report.scenarios)) {
    throw new Error(`baseline ${path} is not an e2e evaluation report`);
  }
  return report as E2EReport;
}

/** Scenarios run in both reports, compared by pass rate; a lower rate now is a regression. */
export function compareWithBaseline(report: E2EReport, baseline: E2EReport, file: string): BaselineComparison {
  const ranBefore = new Map(baseline.scenarios.filter((result) => result.status !== "skipped").map((result) => [result.id, result]));
  const ranNow = report.scenarios.filter((result) => result.status !== "skipped");
  const regressions: BaselineDelta[] = [];
  const improvements: BaselineDelta[] = [];
  const newScenarios: string[] = [];
  let unchanged = 0;
  for (const current of ranNow) {
    const before = ranBefore.get(current.id);
    if (!before) {
      newScenarios.push(current.id);
      continue;
    }
    const delta: BaselineDelta = {
      id: current.id,
      baselinePassRate: before.passRate,
      passRate: current.passRate,
      baselinePassAll: before.passAll,
      passAll: current.passAll,
    };
    if (current.passRate < before.passRate || (before.passAll && !current.passAll)) regressions.push(delta);
    else if (current.passRate > before.passRate) improvements.push(delta);
    else unchanged += 1;
  }
  const nowIds = new Set(ranNow.map((result) => result.id));
  const missingScenarios = [...ranBefore.keys()].filter((id) => !nowIds.has(id));
  return { file, regressions, improvements, unchanged, newScenarios, missingScenarios };
}

/**
 * The CLI's exit code for a finished run: 3 environment-suspect (it wins: the verdicts below it
 * are the environment's) · 1 a scenario failed · 0 otherwise. A baseline never sets it on its
 * own: a scenario, or the suite, can only fall below its baseline by failing attempts now.
 */
export function exitCodeFor(report: E2EReport): 0 | 1 | 3 {
  if (report.environment.suspect) return 3;
  return report.summary.failed > 0 ? 1 : 0;
}

function percent(rate: number): string {
  return `${(rate * 100).toFixed(1)} %`;
}

function duration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function topCounts(counts: Record<string, number>, limit = 6): string {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return "—";
  const shown = entries.slice(0, limit).map(([name, count]) => `${name}×${count}`).join(", ");
  return entries.length > limit ? `${shown}, …` : shown;
}

export function renderMarkdown(report: E2EReport): string {
  const { summary, meta } = report;
  const lines: string[] = [];
  lines.push(`# E2E evaluation ${meta.startedAt}`, "");
  lines.push(`- Gateway: ${meta.gatewayUrl}`);
  lines.push(`- Scenarios: ${summary.scenarios} selected — ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped`);
  lines.push(`- Attempts: ${summary.attemptsPassed}/${summary.attempts} passed (${percent(summary.passRate)}); ${summary.attemptsErrored} ended on a harness error`);
  lines.push(`- pass^k: ${summary.passed}/${summary.run} scenarios passed every attempt (${percent(summary.passAllRate)})`);
  lines.push(`- Repeat ${meta.repeat} · concurrency ${meta.concurrency} · ${duration(meta.durationMs)}`);
  const filters = [
    meta.filters.groups.length > 0 ? `group ${meta.filters.groups.join(", ")}` : "",
    meta.filters.tags.length > 0 ? `tag ${meta.filters.tags.join(", ")}` : "",
    meta.filters.ids.length > 0 ? `id ${meta.filters.ids.join(", ")}` : "",
  ].filter(Boolean);
  if (filters.length > 0) lines.push(`- Filters: ${filters.join(" · ")}`);
  lines.push(`- Judge: ${meta.judge ?? "not configured (judge expectations skipped)"} · Mail: ${meta.mail ?? "not configured"}`);
  if (report.environment.suspect) {
    lines.push("", `> **Environment suspect** — ${report.environment.reasons.join("; ")}`);
  }

  if (report.baseline) {
    const baseline = report.baseline;
    lines.push("", `## Baseline: ${baseline.file}`, "");
    lines.push(`${baseline.regressions.length} regression(s), ${baseline.improvements.length} improvement(s), ${baseline.unchanged} unchanged, ${baseline.newScenarios.length} new, ${baseline.missingScenarios.length} not run now.`);
    if (baseline.regressions.length > 0 || baseline.improvements.length > 0) {
      lines.push("", "| Scenario | Baseline | Now | |", "|---|---|---|---|");
      for (const delta of baseline.regressions) lines.push(`| \`${delta.id}\` | ${percent(delta.baselinePassRate)} | ${percent(delta.passRate)} | **regression** |`);
      for (const delta of baseline.improvements) lines.push(`| \`${delta.id}\` | ${percent(delta.baselinePassRate)} | ${percent(delta.passRate)} | improvement |`);
    }
  }

  const failed = report.scenarios.filter((result) => result.status === "failed");
  if (failed.length > 0) {
    lines.push("", "## Failures");
    for (const result of failed) {
      lines.push("", `### \`${result.id}\` — ${result.title} (group ${result.group}) — ${result.passCount}/${result.attempts.length} attempts passed`, "");
      for (const attempt of result.attempts) {
        if (attempt.outcome === "passed") continue;
        lines.push(`- attempt ${attempt.index + 1}: **${attempt.outcome}** after ${duration(attempt.durationMs)}${attempt.sessions.length > 0 ? ` · sessions ${attempt.sessions.join(", ")}` : ""}`);
        for (const failure of attempt.failures) lines.push(`  - ${failure}`);
        const failedStep = attempt.steps.find((step) => !step.passed);
        if (failedStep?.turn) {
          const reply = failedStep.turn.reply.replace(/\s+/g, " ").trim();
          lines.push(`  - reply (${failedStep.turn.status}, ${duration(failedStep.turn.durationMs)}): ${reply ? `"${reply.length > 280 ? `${reply.slice(0, 280)}…` : reply}"` : "(empty)"}`);
          lines.push(`  - agents: ${topCounts(failedStep.turn.agents)} · tools: ${topCounts(failedStep.turn.tools.calls)}`);
        }
      }
    }
  }

  const skipped = report.scenarios.filter((result) => result.status === "skipped");
  if (skipped.length > 0) {
    lines.push("", "## Skipped", "");
    for (const result of skipped) lines.push(`- \`${result.id}\` — ${result.skipReason ?? "skipped"}`);
  }

  lines.push("", "## Scenarios", "", "| Scenario | Group | Result | Attempts | Avg attempt | Agents | Tools |", "|---|---|---|---|---|---|---|");
  for (const result of report.scenarios) {
    const avg = result.attempts.length > 0
      ? duration(result.attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0) / result.attempts.length)
      : "—";
    const agents: Record<string, number> = {};
    const tools: Record<string, number> = {};
    for (const attempt of result.attempts) {
      for (const [name, count] of Object.entries(attempt.agents)) agents[name] = (agents[name] ?? 0) + count;
      for (const [name, count] of Object.entries(attempt.tools)) tools[name] = (tools[name] ?? 0) + count;
    }
    const outcome = result.status === "skipped" ? "skipped" : result.passAll ? "pass" : "**FAIL**";
    lines.push(`| \`${result.id}\` | ${cell(result.group)} | ${outcome} | ${result.passCount}/${result.attempts.length} | ${avg} | ${cell(topCounts(agents, 4))} | ${cell(topCounts(tools, 4))} |`);
  }
  lines.push("");
  return lines.join("\n");
}

/** Writes <stamp>.json and <stamp>.md into outDir and returns both paths. */
export function writeReport(report: E2EReport, outDir: string): { jsonPath: string; markdownPath: string } {
  mkdirSync(outDir, { recursive: true });
  const stamp = report.meta.startedAt.replace(/[:.]/g, "-");
  const jsonPath = join(outDir, `${stamp}.json`);
  const markdownPath = join(outDir, `${stamp}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(markdownPath, renderMarkdown(report), "utf8");
  return { jsonPath, markdownPath };
}
