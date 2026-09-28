/**
 * intent:report (agent/intent-report.ts, scripts/intent-report.ts): the agreement tables on a fixture
 * of shadow rows written by the shadow's own row builder, so a renamed field on either side fails
 * here rather than reading as "no data". Every expected figure is worked out by hand in the comments.
 */
import { isAbsolute, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { buildIntentReport, readShadowTurns, renderIntentReportMarkdown, type IntentReport } from "../agent/intent-report.js";
import { buildIntentShadowRowData, type IntentShadowOutcome } from "../agent/intent-shadow.js";
import type { AuditRow } from "../agent/latency-attribution.js";
import type { LanguageBucket } from "../decisions/gate.js";
import {
  INTENT_FACET_BY_NAME,
  INTENT_READOUT_VERSION,
  type IntentFacetName,
  type IntentFacetRead,
  type IntentReadoutResult,
  type PreRouteReadoutResult,
} from "../decisions/intent-readout.js";
import { parseIntentReportArgs } from "../scripts/intent-report.js";

/** A reading: each facet on `choice` at `top`, its runner-up at 1 − top (margin 2·top − 1). */
function readout(language: LanguageBucket, facets: Partial<Record<IntentFacetName, [string, number]>>): IntentReadoutResult {
  const out: Partial<Record<IntentFacetName, IntentFacetRead>> = {};
  for (const [name, [choice, top]] of Object.entries(facets) as Array<[IntentFacetName, [string, number]]>) {
    const runnerUp = INTENT_FACET_BY_NAME[name].keys.find((key) => key !== choice)!;
    out[name] = { choice, top, runnerUp, margin: 2 * top - 1, probabilities: { [choice]: top, [runnerUp]: 1 - top }, logScores: {}, mass: 1, temperature: 1 };
  }
  return { ok: true, readout: { version: INTENT_READOUT_VERSION, facets: out, misses: {}, queryEn: "Restated.", language, tokens: 40, ms: 1_000 } };
}

function preRoute(choice: string, top: number, keys: string[]): PreRouteReadoutResult {
  const runnerUp = keys.find((key) => key !== choice)!;
  return {
    ok: true,
    readout: { choice, top, runnerUp, margin: 2 * top - 1, probabilities: { [choice]: top, [runnerUp]: 1 - top }, logScores: {}, keys, mass: 1, temperature: 1, ms: 400 },
  };
}

function outcome(overrides: Partial<IntentShadowOutcome>): IntentShadowOutcome {
  return {
    fastLane: "declined",
    fastLaneReason: "task-intent",
    judge: { status: "not_run", verdict: null, decidedBy: null },
    capsule: { status: "ok", agents: [], trimmed: false },
    subAgentRuns: [],
    workflowRuns: 0,
    moduleChars: null,
    triage: null,
    wallMs: 5_000,
    workflowPressure: [],
    workflowForced: false,
    moduleSplit: true,
    ...overrides,
  };
}

const JUDGE_YES = { status: "answered" as const, verdict: true, decidedBy: "incumbent" as const };
const JUDGE_NO = { status: "answered" as const, verdict: false, decidedBy: "incumbent" as const };

let serial = 0;
function row(language: LanguageBucket, readings: Parameters<typeof buildIntentShadowRowData>[3], actual: IntentShadowOutcome): AuditRow {
  serial += 1;
  return {
    id: `row-${serial}`,
    timestamp: new Date(Date.UTC(2026, 8, 28, 10, serial)).toISOString(),
    type: "intent_readout_shadow",
    sessionId: `session-${serial}`,
    data: buildIntentShadowRowData({ turnId: `turn-${serial}`, userMessage: "x".repeat(40), priorTurnDigest: undefined }, actual, language, readings),
  };
}

/**
 * Eight rows: six with a reading (1, 2, 3, 4, 7, 8), one skipped (5), one of another version (6).
 *
 *   #  lang  source_sensitive  judge  decision       pre-route (capsule)                    did                     module
 *   1  en    yes 0.95          yes    single_agent   researcher 0.90 [researcher,web_coder]  researcher              13000
 *   2  en    no 0.90           yes    answer_direct  none 0.80 [researcher]                  nothing                 0
 *   3  de    yes 0.60          no     workflow       web_coder 0.70 [web_coder]              workflow, forced        13000
 *   4  de    no 0.97           –      answer_direct  – (fast lane, no capsule)               nothing, desk answered  –
 *   5  de    skipped (busy)
 *   6  en    another readout version
 *   7  en    –                 –      coordinate     researcher 0.95 [researcher]            web_coder (not offered) 13000
 *   8  en    –                 –      answer_direct  none 0.90 [researcher]                  researcher              13000
 */
function fixture(): AuditRow[] {
  serial = 0;
  return [
    row("en", { status: "ok", reason: null, intent: readout("en", { mode: ["GATHER", 0.9], source_sensitive: ["yes", 0.95], decision: ["single_agent", 0.9] }), preRoute: preRoute("researcher", 0.9, ["researcher", "web_coder", "none"]) },
      outcome({ judge: JUDGE_YES, capsule: { status: "ok", agents: ["researcher", "web_coder"], trimmed: false }, subAgentRuns: ["researcher"], moduleChars: 13_000, triage: { mode: "GATHER", source_sensitive: "yes", decision: "single_agent" } })),
    row("en", { status: "ok", reason: null, intent: readout("en", { mode: ["converse", 0.9], source_sensitive: ["no", 0.9], decision: ["answer_direct", 0.95] }), preRoute: preRoute("none", 0.8, ["researcher", "none"]) },
      outcome({ judge: JUDGE_YES, capsule: { status: "ok", agents: ["researcher"], trimmed: false }, moduleChars: 0 })),
    row("de", { status: "ok", reason: null, intent: readout("de", { mode: ["PRODUCE", 0.9], source_sensitive: ["yes", 0.6], decision: ["workflow", 0.88] }), preRoute: preRoute("web_coder", 0.7, ["web_coder", "none"]) },
      outcome({ fastLane: "not_offered", fastLaneReason: null, judge: JUDGE_NO, capsule: { status: "ok", agents: ["web_coder"], trimmed: false }, workflowRuns: 1, workflowForced: true, workflowPressure: ["workflow_run_forced_after_search"], moduleChars: 13_000 })),
    row("de", { status: "ok", reason: null, intent: readout("de", { mode: ["converse", 0.97], source_sensitive: ["no", 0.97], decision: ["answer_direct", 0.99] }), preRoute: null },
      outcome({ fastLane: "answered", fastLaneReason: null, capsule: { status: "not_run", agents: [], trimmed: false } })),
    row("de", { status: "skipped", reason: "busy", intent: null, preRoute: null }, outcome({})),
    {
      id: "row-old", timestamp: "2026-09-27T10:00:00.000Z", type: "intent_readout_shadow", sessionId: "session-old",
      data: { version: "intent-readout-v0", status: "ok", language: "en" },
    },
    row("en", { status: "ok", reason: null, intent: readout("en", { mode: ["ORCHESTRATE", 0.9], decision: ["coordinate", 0.9] }), preRoute: preRoute("researcher", 0.95, ["researcher", "none"]) },
      outcome({ capsule: { status: "ok", agents: ["researcher"], trimmed: false }, subAgentRuns: ["web_coder", "researcher"], moduleChars: 13_000 })),
    row("en", { status: "ok", reason: null, intent: readout("en", { mode: ["GATHER", 0.9], decision: ["answer_direct", 0.9] }), preRoute: preRoute("none", 0.9, ["researcher", "none"]) },
      outcome({ capsule: { status: "ok", agents: ["researcher"], trimmed: false }, subAgentRuns: ["researcher"], moduleChars: 13_000 })),
  ];
}

function rateOf(r: { k: number; n: number }): [number, number] {
  return [r.k, r.n];
}

describe("reading the rows", () => {
  it("reads the rows the shadow writes, and leaves another readout version out with a count", () => {
    const { turns, otherVersions } = readShadowTurns(fixture());
    expect(turns).toHaveLength(7);
    expect(otherVersions).toEqual({ "intent-readout-v0": 1 });
    const first = turns[0]!;
    expect(first.facets.decision).toEqual({ choice: "single_agent", top: 0.9, margin: 0.8 });
    expect(first.preRoute).toEqual({ status: "ok", choice: "researcher", top: 0.9, margin: 0.8 });
    expect(first.actual).toMatchObject({ judgeStatus: "answered", judgeVerdict: true, firstAgent: "researcher", subAgentRuns: 1, moduleIncluded: true, capsuleAgents: ["researcher", "web_coder"], capsuleTrimmed: false });
  });

  it("counts the capsules the prompt budget trimmed", () => {
    const rows = fixture();
    ((rows[1]!.data["actual"] as Record<string, unknown>)["capsule"] as Record<string, unknown>)["trimmed"] = true;
    expect(buildIntentReport(rows).coverage.capsuleTrimmed).toBe(1);
    expect(buildIntentReport(fixture()).coverage.capsuleTrimmed).toBe(0);
  });

  it("keeps an option only when it is the facet's own, and a name only when it is an identifier", () => {
    const rows = fixture();
    const data = rows[0]!.data as { readout: { facets: Record<string, { choice: string }> }; actual: Record<string, unknown> };
    data.readout.facets["decision"]!.choice = "delegate everything";
    data.actual["firstAgent"] = "a name with spaces";
    const turn = readShadowTurns(rows).turns[0]!;
    expect(turn.facets.decision).toBeUndefined();
    expect(turn.actual.firstAgent).toBeNull();
  });
});

describe("the tables", () => {
  const report: IntentReport = buildIntentReport(fixture());

  it("states its scope: rows, readings, statuses, languages, and THIN DATA below 30 readings", () => {
    expect(report.scope).toMatchObject({
      rows: 7,
      turnsWithReadout: 6,
      byStatus: { ok: 6, skipped: 1 },
      byReason: { busy: 1 },
      byLanguage: { de: 3, en: 4, other: 0 },
      thin: true,
    });
    expect(report.notes[0]).toMatch(/^THIN DATA: 6 turn/);
    expect(buildIntentReport(fixture(), { thinDataTurns: 6 }).scope.thin).toBe(false);
    // decision was read on all six ok rows; source_sensitive on four of them.
    expect(rateOf(report.coverage.facetRead.decision)).toEqual([6, 6]);
    expect(rateOf(report.coverage.facetRead.source_sensitive)).toEqual([4, 6]);
  });

  it("source_sensitive against the judge, on the turns where it answered (1, 2, 3)", () => {
    // 1: yes/yes; 2: no/yes; 3: yes/no. Row 4 had no judge (the front desk answered).
    expect(report.sourceSensitive.all).toMatchObject({ n: 3, both: 1, readoutOnly: 1, actualOnly: 1, neither: 0 });
    expect(rateOf(report.sourceSensitive.all.agreement)).toEqual([1, 3]);
    expect(report.sourceSensitive.en).toMatchObject({ n: 2, both: 1, actualOnly: 1 });
    expect(report.sourceSensitive.de).toMatchObject({ n: 1, readoutOnly: 1 });
    // Row 3's 0.60 is not confident: only 1 and 2 remain.
    expect(report.sourceSensitiveConfident.all).toMatchObject({ n: 2, both: 1, actualOnly: 1, readoutOnly: 0 });
  });

  it("answer_direct against a turn that routed nothing", () => {
    // Both: 2, 4. Readout only: 8 (it delegated). Neither: 1, 3 (workflow), 7.
    expect(report.answerDirect.all).toMatchObject({ n: 6, both: 2, readoutOnly: 1, actualOnly: 0, neither: 3 });
    expect(rateOf(report.answerDirect.all.agreement)).toEqual([5, 6]);
    expect(rateOf(report.answerDirect.all.precision)).toEqual([2, 3]);
    expect(rateOf(report.answerDirect.all.recall)).toEqual([2, 2]);
    expect(report.answerDirect.en).toMatchObject({ n: 4, both: 1, readoutOnly: 1, neither: 2 });
    expect(report.answerDirect.de).toMatchObject({ n: 2, both: 1, neither: 1 });
    expect(report.answerDirect.all.agreement.lower).toBeGreaterThan(0);
    expect(report.answerDirect.all.agreement.lower).toBeLessThan(5 / 6);
  });

  it("answer_direct by what the front desk did", () => {
    expect(rateOf(report.fastLane.all.answered)).toEqual([1, 1]);
    // Declined: 1, 2, 7, 8 — answer_direct on 2 and 8.
    expect(rateOf(report.fastLane.all.declined)).toEqual([2, 4]);
    expect(rateOf(report.fastLane.all.notOffered)).toEqual([0, 1]);
  });

  it("decision=workflow against a workflow having run, split by the threshold's pressure", () => {
    expect(report.workflow.all).toMatchObject({ n: 6, both: 1, readoutOnly: 0, actualOnly: 0, neither: 5 });
    expect(report.workflowForced.all.forced).toMatchObject({ n: 1, both: 1 });
    expect(report.workflowForced.all.unforced).toMatchObject({ n: 5, neither: 5 });
    expect(report.workflowForced.en.forced.n).toBe(0);
  });

  it("the pre-router's pick against the first specialist started, 'none' when none was", () => {
    // Asked on 1, 2, 3, 7, 8. Right: 1 (researcher), 2 (none). Wrong: 3 (gold none), 7 (web_coder), 8 (researcher).
    expect(rateOf(report.preRouter.all.top1)).toEqual([2, 5]);
    // Turns that delegated: 1, 7, 8 — right on 1 only. Row 7's web_coder was not among its options.
    expect(rateOf(report.preRouter.all.delegatedTop1)).toEqual([1, 3]);
    expect(report.preRouter.all.goldNotOffered).toBe(1);
    expect(rateOf(report.preRouter.en.top1)).toEqual([2, 4]);
    expect(rateOf(report.preRouter.de.top1)).toEqual([0, 1]);
    expect(report.preRouter.de.delegatedTop1.n).toBe(0);
  });

  it("the pre-router at thresholds: coverage and precision of the agent picks it would take", () => {
    // Agent picks: 1 at 0.90 (right), 3 at 0.70 (wrong), 7 at 0.95 (wrong); margins 0.8, 0.4, 0.9.
    const all = report.preRouterThresholds.filter((entry) => entry.language === "all");
    expect(all.map((entry) => [entry.minTop, rateOf(entry.coverage), rateOf(entry.precision)])).toEqual([
      [0.5, [3, 5], [1, 3]],
      [0.7, [3, 5], [1, 3]],
      [0.85, [2, 5], [1, 2]],
      [0.9, [2, 5], [1, 2]],
      [0.95, [1, 5], [0, 1]],
    ]);
    expect(all.every((entry) => entry.minMargin === 0.15)).toBe(true);
  });

  it("takes an agent pick only when its margin clears too, where the top alone would", () => {
    serial = 100;
    // 0.55 over 0.45: top clears 0.5, margin 0.10 does not clear 0.15 — two options near 0.5 are no answer.
    const rows = [
      row("en", { status: "ok", reason: null, intent: readout("en", { decision: ["single_agent", 0.9] }), preRoute: preRoute("researcher", 0.55, ["researcher", "none"]) },
        outcome({ capsule: { status: "ok", agents: ["researcher"], trimmed: false }, subAgentRuns: ["researcher"] })),
      row("en", { status: "ok", reason: null, intent: readout("en", { decision: ["answer_direct", 0.9] }), preRoute: preRoute("researcher", 0.6, ["researcher", "none"]) },
        outcome({ capsule: { status: "ok", agents: ["researcher"], trimmed: false } })),
    ];
    const at = buildIntentReport(rows).preRouterThresholds.find((entry) => entry.language === "all" && entry.minTop === 0.5)!;
    // Only the second (0.60, margin 0.20) is taken, and it is wrong: that turn started no specialist.
    expect(rateOf(at.coverage)).toEqual([1, 2]);
    expect(rateOf(at.precision)).toEqual([0, 1]);
  });

  it("'none' recall on the turns that started no specialist, raw and protected", () => {
    // Gold none: 2 (picked none) and 3 (picked web_coder at 0.70, under 0.85, so protected).
    expect(rateOf(report.noneRecall.all.raw)).toEqual([1, 2]);
    expect(rateOf(report.noneRecall.all.protected)).toEqual([2, 2]);
    expect(rateOf(report.noneRecall.de.raw)).toEqual([0, 1]);
    expect(rateOf(report.noneRecall.de.protected)).toEqual([1, 1]);
  });

  it("the module include against the readout, and each against whether the turn routed", () => {
    // Module known on 1, 2, 3, 7, 8 (row 4 was the front desk's: no prompt).
    const all = report.moduleInclude.all;
    expect(all.n).toBe(5);
    // Readout routes on 1, 3, 7; the module was in on 1, 3, 7, 8.
    expect(all.readoutRoutesVsModule).toMatchObject({ both: 3, readoutOnly: 0, actualOnly: 1, neither: 1 });
    // Routed: 1, 3, 7, 8. The module was in on exactly those; the readout missed 8.
    expect(rateOf(all.moduleVsRouted.agreement)).toEqual([5, 5]);
    expect(all.readoutVsRouted).toMatchObject({ both: 3, actualOnly: 1, neither: 1 });
    expect(all.byDecision).toEqual({
      single_agent: { included: 1, excluded: 0 },
      answer_direct: { included: 1, excluded: 1 },
      workflow: { included: 1, excluded: 0 },
      coordinate: { included: 1, excluded: 0 },
    });
    expect(all.byMode["GATHER"]).toEqual({ included: 2, excluded: 0 });
  });

  it("each facet against the facet triage where both ran", () => {
    expect(rateOf(report.triage.mode)).toEqual([1, 1]);
    expect(rateOf(report.triage.decision)).toEqual([1, 1]);
    expect(report.triage.deliverable.n).toBe(0);
  });
});

describe("the report never carries the user's words", () => {
  it("copies nothing but identifiers, option keys and numbers, whatever else a row holds", () => {
    const rows = fixture();
    const canary = "Zwitscherbaum Kanarienvogel Quarkstrudel";
    for (const entry of rows) {
      entry.data["message"] = canary;
      entry.data["queryEn"] = canary;
      entry.data["reason"] = canary;
      const actual = entry.data["actual"] as Record<string, unknown> | undefined;
      if (actual) {
        actual["fastLaneReason"] = canary;
        actual["agents"] = [canary];
        actual["workflowPressure"] = [canary];
        actual["capsule"] = { status: canary, agents: ["researcher", canary] };
      }
      const pre = entry.data["preRoute"] as Record<string, unknown> | undefined;
      if (pre) pre["runnerUp"] = canary;
    }
    const report = buildIntentReport(rows);
    const markdown = renderIntentReportMarkdown(report, { files: [{ path: "/tmp/audit.jsonl", rows: rows.length, malformedLines: 0 }], duplicates: 0 });
    for (const word of ["Zwitscherbaum", "Kanarienvogel", "Quarkstrudel"]) {
      expect(JSON.stringify(report)).not.toContain(word);
      expect(markdown).not.toContain(word);
    }
  });
});

describe("the Markdown report", () => {
  it("leads with the scope and the THIN DATA warning", () => {
    const markdown = renderIntentReportMarkdown(buildIntentReport(fixture()));
    const lines = markdown.split("\n");
    expect(lines[0]).toBe(`# Intent readout vs. real turns (${INTENT_READOUT_VERSION})`);
    expect(lines[2]).toMatch(/^> \*\*THIN DATA — 6 turn\(s\) with a reading/);
    // The pre-router's top-1 row: 2 of 5.
    expect(markdown).toContain("| all | 40.0% (2/5, LB ");
    expect(markdown).toContain("## Pre-router pick vs. the first specialist started");
  });
});

describe("intent:report arguments", () => {
  const root = resolve("/repo");

  it("takes a relative --audit from the repo root and an absolute one as it is, more than once", () => {
    const absolute = resolve("/data/export/audit.jsonl");
    const args = parseIntentReportArgs(["--audit", ".starlingai/audit.jsonl", "--audit", absolute, "--json"], root);
    expect(args.audits).toEqual([join(root, ".starlingai", "audit.jsonl"), absolute]);
    expect(args.audits.every((path) => isAbsolute(path))).toBe(true);
    expect(args.json).toBe(true);
  });

  it("takes the separating \"--\" pnpm passes through (`pnpm intent:report -- --audit x`)", () => {
    const absolute = resolve("/data/audit.jsonl");
    const args = parseIntentReportArgs(["--", "--audit", absolute, "--json"], root);
    expect(args.audits).toEqual([absolute]);
    expect(args.json).toBe(true);
  });

  it("defaults to the live log and the live-check folder, and refuses what it does not know", () => {
    const args = parseIntentReportArgs([], root);
    expect(args.audits).toEqual([join(root, ".starlingai", "audit.jsonl")]);
    expect(args.out).toBe(join(root, ".starlingai", "live-check", "intent-report"));
    expect(() => parseIntentReportArgs(["--audit"], root)).toThrow(/needs a path/);
    expect(() => parseIntentReportArgs(["--since", "1d"], root)).toThrow(/unknown argument/);
  });
});
