/**
 * Does the intent readout agree with what turns did? — offline, from the `intent_readout_shadow`
 * rows the post-turn shadow writes (agent/intent-shadow.ts, orchestration.intentReadout: "shadow").
 *
 * The readout was measured on synthetic gold (decisions/intent-readout.ts). These tables set it
 * beside real turns, per language, before any consumer reads it:
 *
 *  - source_sensitive against the up-front source judge it would replace (turns where the judge
 *    answered);
 *  - decision=answer_direct against turns that routed nothing (no specialist started, no workflow
 *    ran), and against the front desk answering;
 *  - decision=workflow against a workflow having run, split by whether the score threshold pressed
 *    it — the first consumer planned is that gate ("does this workflow deliver what the user
 *    wants?", with "no" protected);
 *  - the pre-router's pick against the first specialist the orchestrator started ("none" when it
 *    started none), top-1 and at confidence thresholds (coverage, precision, Wilson lower bound),
 *    and "none" recall on the turns that started none — the protected answer;
 *  - the orchestration module's EN/DE regex include against the readout's decision and mode, and
 *    each of the two against whether the turn then routed at all;
 *  - where the facet triage ran in the same turn, each facet's agreement with it.
 *
 * What the numbers are not. The "actual" side is what the orchestrator did, not what was right:
 * agreement with a first delegation is agreement with a routing choice the pre-router exists to
 * improve on, and a judge the readout disagrees with may be the one that is wrong. Treat these as
 * agreement, with the readout's own synthetic accuracy beside them. And the rows are whatever the
 * audit holds — often one user's sessions on a few topics — so the report states its scope and
 * warns below THIN_DATA_TURNS turns with a reading.
 *
 * The pre-router here is offered the turn's own capsule (at most four agents, CAPSULE_MAX_AGENTS)
 * plus "none". The bench's 72.5% was measured with eight options cut from the whole embedding
 * ranking, so the two top-1 figures are not the same measurement.
 *
 * Privacy: the rows hold no user text by construction; this module copies nothing out of a row
 * but identifiers that pass IDENTIFIER_RE, option keys that are the facet's own, and numbers.
 */
import { wilsonLowerBound } from "../decisions/gate.js";
import {
  DEFAULT_CONFIDENCE,
  INTENT_FACET_BY_NAME,
  INTENT_FACETS,
  INTENT_READOUT_VERSION,
  type IntentFacetName,
} from "../decisions/intent-readout.js";
import { NONE_KEY } from "../decisions/pre-route-question.js";
import type { AuditRow } from "./latency-attribution.js";

/** Below this many turns with a reading, every figure is an anecdote. */
export const THIN_DATA_TURNS = 30;

/** The pre-router's top-probability thresholds the coverage table is cut at; the margin is DEFAULT_CONFIDENCE's. */
export const PRE_ROUTE_THRESHOLDS: readonly number[] = Object.freeze([0.5, 0.7, 0.85, 0.9, 0.95]);

export type ReportLanguage = "de" | "en" | "other";
export const REPORT_LANGUAGES = ["all", "de", "en", "other"] as const;
export type ReportBucket = typeof REPORT_LANGUAGES[number];

/** The decisions under which a turn routes: the module is routing guidance for exactly these. */
const ROUTING_DECISIONS: ReadonlySet<string> = new Set(["single_agent", "workflow", "coordinate"]);

const IDENTIFIER_RE = /^[A-Za-z0-9_.:@()-]{1,80}$/;

// ── Reading the rows ─────────────────────────────────────────────────────────────────────────────

export interface FacetReading {
  choice: string;
  top: number;
  margin: number;
}

/** One shadowed turn as the report reads it: identifiers, option keys and numbers only. */
export interface ShadowTurn {
  rowId: string;
  sessionId: string | null;
  turnId: string | null;
  status: string;
  reason: string | null;
  language: ReportLanguage;
  facets: Partial<Record<IntentFacetName, FacetReading>>;
  readoutMs: number | null;
  preRoute: { status: string; choice: string | null; top: number | null; margin: number | null };
  actual: {
    fastLane: "answered" | "declined" | "not_offered";
    judgeStatus: string;
    judgeVerdict: boolean | null;
    capsuleStatus: string;
    /** The prompt budget dropped the capsule: the orchestrator never read the options the pre-router was offered. */
    capsuleTrimmed: boolean;
    capsuleAgents: string[];
    subAgentRuns: number;
    firstAgent: string | null;
    workflowRuns: number;
    workflowForced: boolean;
    moduleIncluded: boolean | null;
    wallMs: number | null;
    triage: Partial<Record<IntentFacetName, string>> | null;
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function ident(value: unknown): string | null {
  return typeof value === "string" && IDENTIFIER_RE.test(value) ? value : null;
}

function facetKey(name: IntentFacetName, value: unknown): string | null {
  return typeof value === "string" && INTENT_FACET_BY_NAME[name].keys.includes(value) ? value : null;
}

function readFacets(value: unknown): Partial<Record<IntentFacetName, FacetReading>> {
  const raw = asRecord(value) ?? {};
  const out: Partial<Record<IntentFacetName, FacetReading>> = {};
  for (const definition of INTENT_FACETS) {
    const entry = asRecord(raw[definition.name]);
    const choice = facetKey(definition.name, entry?.["choice"]);
    const top = num(entry?.["top"]);
    const margin = num(entry?.["margin"]);
    if (choice !== null && top !== null && margin !== null) out[definition.name] = { choice, top, margin };
  }
  return out;
}

function readTriage(value: unknown): Partial<Record<IntentFacetName, string>> | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const out: Partial<Record<IntentFacetName, string>> = {};
  for (const definition of INTENT_FACETS) {
    const key = facetKey(definition.name, raw[definition.name]);
    if (key !== null) out[definition.name] = key;
  }
  return out;
}

/**
 * The shadow rows of the current readout version, and how many rows of other versions were left
 * out: a row names the prefix, grammar and case template it was read with, and two readouts are
 * never counted together.
 */
export function readShadowTurns(rows: readonly AuditRow[], version: string = INTENT_READOUT_VERSION): {
  turns: ShadowTurn[];
  otherVersions: Record<string, number>;
} {
  const turns: ShadowTurn[] = [];
  const otherVersions: Record<string, number> = {};
  for (const row of rows) {
    if (row.type !== "intent_readout_shadow") continue;
    const data = row.data;
    const rowVersion = typeof data["version"] === "string" ? data["version"] : "(none)";
    if (rowVersion !== version) {
      const key = ident(rowVersion) ?? "(other)";
      otherVersions[key] = (otherVersions[key] ?? 0) + 1;
      continue;
    }
    const readout = asRecord(data["readout"]);
    const pre = asRecord(data["preRoute"]) ?? {};
    const actual = asRecord(data["actual"]) ?? {};
    const judge = asRecord(actual["judge"]) ?? {};
    const capsule = asRecord(actual["capsule"]) ?? {};
    const language = data["language"] === "de" || data["language"] === "en" ? data["language"] : "other";
    const fastLane = actual["fastLane"] === "answered" || actual["fastLane"] === "declined" ? actual["fastLane"] : "not_offered";
    turns.push({
      rowId: row.id,
      sessionId: row.sessionId ?? null,
      turnId: ident(data["turnId"]),
      status: ident(data["status"]) ?? "(other)",
      reason: ident(data["reason"]),
      language,
      facets: readout ? readFacets(readout["facets"]) : {},
      readoutMs: readout ? num(readout["ms"]) : null,
      preRoute: {
        status: ident(pre["status"]) ?? "(other)",
        choice: ident(pre["choice"]),
        top: num(pre["top"]),
        margin: num(pre["margin"]),
      },
      actual: {
        fastLane,
        judgeStatus: ident(judge["status"]) ?? "not_run",
        judgeVerdict: typeof judge["verdict"] === "boolean" ? judge["verdict"] : null,
        capsuleStatus: ident(capsule["status"]) ?? "not_run",
        capsuleTrimmed: capsule["trimmed"] === true,
        capsuleAgents: Array.isArray(capsule["agents"]) ? capsule["agents"].map(ident).filter((name): name is string => name !== null) : [],
        subAgentRuns: num(actual["subAgentRuns"]) ?? 0,
        firstAgent: ident(actual["firstAgent"]),
        workflowRuns: num(actual["workflowRuns"]) ?? 0,
        workflowForced: actual["workflowForced"] === true,
        moduleIncluded: typeof actual["moduleIncluded"] === "boolean" ? actual["moduleIncluded"] : null,
        wallMs: num(actual["wallMs"]),
        triage: readTriage(actual["triage"]),
      },
    });
  }
  return { turns, otherVersions };
}

// ── Statistics ───────────────────────────────────────────────────────────────────────────────────

/** A share, with its sample count and Wilson lower bound (95%). Null share on no samples. */
export interface Rate {
  n: number;
  k: number;
  rate: number | null;
  lower: number | null;
}

export function rate(k: number, n: number): Rate {
  return { n, k, rate: n > 0 ? k / n : null, lower: n > 0 ? wilsonLowerBound(k, n) : null };
}

/**
 * The readout's yes against the turn's yes on one binary question: the four cells, agreement, and
 * the precision and recall of the readout's yes (each with its lower bound).
 */
export interface Agreement2x2 {
  n: number;
  both: number;
  readoutOnly: number;
  actualOnly: number;
  neither: number;
  agreement: Rate;
  precision: Rate;
  recall: Rate;
}

export function agreement2x2(pairs: ReadonlyArray<{ readout: boolean; actual: boolean }>): Agreement2x2 {
  let both = 0;
  let readoutOnly = 0;
  let actualOnly = 0;
  let neither = 0;
  for (const { readout, actual } of pairs) {
    if (readout && actual) both += 1;
    else if (readout) readoutOnly += 1;
    else if (actual) actualOnly += 1;
    else neither += 1;
  }
  return {
    n: pairs.length,
    both,
    readoutOnly,
    actualOnly,
    neither,
    agreement: rate(both + neither, pairs.length),
    precision: rate(both, both + readoutOnly),
    recall: rate(both, both + actualOnly),
  };
}

function isConfident(reading: { top: number; margin: number }): boolean {
  return reading.top >= DEFAULT_CONFIDENCE.minTop && reading.margin >= DEFAULT_CONFIDENCE.minMargin;
}

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

function byLanguage<T>(turns: readonly ShadowTurn[], build: (subset: readonly ShadowTurn[]) => T): Record<ReportBucket, T> {
  return Object.fromEntries(REPORT_LANGUAGES.map((bucket) => [
    bucket,
    build(bucket === "all" ? turns : turns.filter((turn) => turn.language === bucket)),
  ])) as Record<ReportBucket, T>;
}

/** Did the turn route: a specialist started under it, or a workflow ran. */
export function turnRouted(turn: ShadowTurn): boolean {
  return turn.actual.subAgentRuns > 0 || turn.actual.workflowRuns > 0;
}

/** What a right pre-router pick would have been, by what the orchestrator did: its first specialist, else "none". */
export function preRouteGold(turn: ShadowTurn): string {
  return turn.actual.firstAgent ?? NONE_KEY;
}

function preRouteAccepted(turn: ShadowTurn, minTop: number, minMargin: number): boolean {
  const { choice, top, margin } = turn.preRoute;
  return choice !== null && choice !== NONE_KEY && top !== null && margin !== null && top >= minTop && margin >= minMargin;
}

// ── The report ───────────────────────────────────────────────────────────────────────────────────

export interface PreRouteThresholdRow {
  language: ReportBucket;
  minTop: number;
  minMargin: number;
  n: number;
  /** Turns whose pick clears both thresholds and is an agent: the share a pre-router would dispatch. */
  coverage: Rate;
  /** Of those, the pick is the specialist the orchestrator started first. */
  precision: Rate;
}

export interface IntentReport {
  version: string;
  scope: {
    rows: number;
    sessions: number;
    /** Rows with a reading of the readout, the denominator the THIN DATA warning is on. */
    turnsWithReadout: number;
    byStatus: Record<string, number>;
    byReason: Record<string, number>;
    byLanguage: Record<ReportLanguage, number>;
    otherVersions: Record<string, number>;
    thin: boolean;
    thinDataTurns: number;
  };
  coverage: {
    facetRead: Record<IntentFacetName, Rate>;
    readoutMs: { n: number; p50: number | null; p90: number | null };
    preRouteStatus: Record<string, number>;
    capsuleStatus: Record<string, number>;
    capsuleTrimmed: number;
  };
  sourceSensitive: Record<ReportBucket, Agreement2x2>;
  sourceSensitiveConfident: Record<ReportBucket, Agreement2x2>;
  answerDirect: Record<ReportBucket, Agreement2x2>;
  fastLane: Record<ReportBucket, { answered: Rate; declined: Rate; notOffered: Rate }>;
  workflow: Record<ReportBucket, Agreement2x2>;
  workflowForced: Record<ReportBucket, { forced: Agreement2x2; unforced: Agreement2x2 }>;
  preRouter: Record<ReportBucket, { top1: Rate; delegatedTop1: Rate; goldNotOffered: number }>;
  preRouterThresholds: PreRouteThresholdRow[];
  noneRecall: Record<ReportBucket, { raw: Rate; protected: Rate }>;
  moduleInclude: Record<ReportBucket, {
    n: number;
    byDecision: Record<string, { included: number; excluded: number }>;
    byMode: Record<string, { included: number; excluded: number }>;
    readoutRoutesVsModule: Agreement2x2;
    moduleVsRouted: Agreement2x2;
    readoutVsRouted: Agreement2x2;
  }>;
  triage: Record<IntentFacetName, Rate>;
  notes: string[];
}

function tally(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

export function buildIntentReport(rows: readonly AuditRow[], options: { version?: string; thinDataTurns?: number } = {}): IntentReport {
  const version = options.version ?? INTENT_READOUT_VERSION;
  const thinDataTurns = options.thinDataTurns ?? THIN_DATA_TURNS;
  const { turns, otherVersions } = readShadowTurns(rows, version);
  const read = turns.filter((turn) => Object.keys(turn.facets).length > 0);

  const facetRead = Object.fromEntries(INTENT_FACETS.map((definition) => [
    definition.name,
    rate(turns.filter((turn) => turn.facets[definition.name]).length, turns.filter((turn) => turn.status === "ok").length),
  ])) as Record<IntentFacetName, Rate>;
  const ms = read.map((turn) => turn.readoutMs).filter((value): value is number => value !== null);

  const sourceSensitive = (confidentOnly: boolean) => byLanguage(read, (subset) => agreement2x2(subset
    .filter((turn) => turn.actual.judgeStatus === "answered" && turn.actual.judgeVerdict !== null && turn.facets.source_sensitive
      && (!confidentOnly || isConfident(turn.facets.source_sensitive)))
    .map((turn) => ({ readout: turn.facets.source_sensitive!.choice === "yes", actual: turn.actual.judgeVerdict === true }))));

  const withDecision = read.filter((turn) => turn.facets.decision);
  const decisionIs = (turn: ShadowTurn, value: string) => turn.facets.decision!.choice === value;

  const preRead = turns.filter((turn) => turn.preRoute.status === "ok" && turn.preRoute.choice !== null);

  const moduleTurns = withDecision.filter((turn) => turn.actual.moduleIncluded !== null);
  const crossTab = (subset: readonly ShadowTurn[], key: (turn: ShadowTurn) => string | undefined) => {
    const out: Record<string, { included: number; excluded: number }> = {};
    for (const turn of subset) {
      const value = key(turn);
      if (value === undefined) continue;
      const cell = out[value] ?? { included: 0, excluded: 0 };
      if (turn.actual.moduleIncluded) cell.included += 1;
      else cell.excluded += 1;
      out[value] = cell;
    }
    return out;
  };

  const triageTurns = read.filter((turn) => turn.actual.triage);
  const triage = Object.fromEntries(INTENT_FACETS.map((definition) => {
    const pairs = triageTurns.filter((turn) => turn.facets[definition.name] && turn.actual.triage![definition.name] !== undefined);
    return [definition.name, rate(pairs.filter((turn) => turn.facets[definition.name]!.choice === turn.actual.triage![definition.name]).length, pairs.length)];
  })) as Record<IntentFacetName, Rate>;

  const preRouterThresholds: PreRouteThresholdRow[] = [];
  for (const bucket of REPORT_LANGUAGES) {
    const subset = bucket === "all" ? preRead : preRead.filter((turn) => turn.language === bucket);
    for (const minTop of PRE_ROUTE_THRESHOLDS) {
      const accepted = subset.filter((turn) => preRouteAccepted(turn, minTop, DEFAULT_CONFIDENCE.minMargin));
      preRouterThresholds.push({
        language: bucket,
        minTop,
        minMargin: DEFAULT_CONFIDENCE.minMargin,
        n: subset.length,
        coverage: rate(accepted.length, subset.length),
        precision: rate(accepted.filter((turn) => turn.preRoute.choice === preRouteGold(turn)).length, accepted.length),
      });
    }
  }

  const report: IntentReport = {
    version,
    scope: {
      rows: turns.length,
      sessions: new Set(turns.map((turn) => turn.sessionId ?? "")).size,
      turnsWithReadout: read.length,
      byStatus: tally(turns.map((turn) => turn.status)),
      byReason: tally(turns.map((turn) => turn.reason).filter((reason): reason is string => reason !== null)),
      byLanguage: { de: turns.filter((turn) => turn.language === "de").length, en: turns.filter((turn) => turn.language === "en").length, other: turns.filter((turn) => turn.language === "other").length },
      otherVersions,
      thin: read.length < thinDataTurns,
      thinDataTurns,
    },
    coverage: {
      facetRead,
      readoutMs: { n: ms.length, p50: percentile(ms, 0.5), p90: percentile(ms, 0.9) },
      preRouteStatus: tally(turns.map((turn) => turn.preRoute.status)),
      capsuleStatus: tally(turns.map((turn) => turn.actual.capsuleStatus)),
      capsuleTrimmed: turns.filter((turn) => turn.actual.capsuleTrimmed).length,
    },
    sourceSensitive: sourceSensitive(false),
    sourceSensitiveConfident: sourceSensitive(true),
    answerDirect: byLanguage(withDecision, (subset) => agreement2x2(subset.map((turn) => ({
      readout: decisionIs(turn, "answer_direct"),
      actual: !turnRouted(turn),
    })))),
    fastLane: byLanguage(withDecision, (subset) => {
      const share = (lane: ShadowTurn["actual"]["fastLane"]) => {
        const group = subset.filter((turn) => turn.actual.fastLane === lane);
        return rate(group.filter((turn) => decisionIs(turn, "answer_direct")).length, group.length);
      };
      return { answered: share("answered"), declined: share("declined"), notOffered: share("not_offered") };
    }),
    workflow: byLanguage(withDecision, (subset) => agreement2x2(subset.map((turn) => ({
      readout: decisionIs(turn, "workflow"),
      actual: turn.actual.workflowRuns > 0,
    })))),
    workflowForced: byLanguage(withDecision, (subset) => {
      const pairs = (forced: boolean) => subset.filter((turn) => turn.actual.workflowForced === forced).map((turn) => ({
        readout: decisionIs(turn, "workflow"),
        actual: turn.actual.workflowRuns > 0,
      }));
      return { forced: agreement2x2(pairs(true)), unforced: agreement2x2(pairs(false)) };
    }),
    preRouter: byLanguage(preRead, (subset) => {
      const delegated = subset.filter((turn) => turn.actual.firstAgent !== null);
      return {
        top1: rate(subset.filter((turn) => turn.preRoute.choice === preRouteGold(turn)).length, subset.length),
        delegatedTop1: rate(delegated.filter((turn) => turn.preRoute.choice === preRouteGold(turn)).length, delegated.length),
        // The specialist the orchestrator started was not among the options: no pick could match it.
        goldNotOffered: delegated.filter((turn) => !turn.actual.capsuleAgents.includes(preRouteGold(turn))).length,
      };
    }),
    preRouterThresholds,
    noneRecall: byLanguage(preRead.filter((turn) => preRouteGold(turn) === NONE_KEY), (subset) => ({
      raw: rate(subset.filter((turn) => turn.preRoute.choice === NONE_KEY).length, subset.length),
      // acceptPreRoute at the defaults: an agent is taken only when it clears both thresholds.
      protected: rate(subset.filter((turn) => !preRouteAccepted(turn, DEFAULT_CONFIDENCE.minTop, DEFAULT_CONFIDENCE.minMargin)).length, subset.length),
    })),
    moduleInclude: byLanguage(moduleTurns, (subset) => ({
      n: subset.length,
      byDecision: crossTab(subset, (turn) => turn.facets.decision?.choice),
      byMode: crossTab(subset, (turn) => turn.facets.mode?.choice),
      readoutRoutesVsModule: agreement2x2(subset.map((turn) => ({ readout: ROUTING_DECISIONS.has(turn.facets.decision!.choice), actual: turn.actual.moduleIncluded === true }))),
      moduleVsRouted: agreement2x2(subset.map((turn) => ({ readout: turn.actual.moduleIncluded === true, actual: turnRouted(turn) }))),
      readoutVsRouted: agreement2x2(subset.map((turn) => ({ readout: ROUTING_DECISIONS.has(turn.facets.decision!.choice), actual: turnRouted(turn) }))),
    })),
    triage,
    notes: [],
  };

  const notes = report.notes;
  if (report.scope.thin) {
    notes.push(`THIN DATA: ${read.length} turn(s) with a reading, below the ${thinDataTurns} a figure here needs. Treat every rate as an anecdote.`);
  }
  if (Object.keys(otherVersions).length > 0) {
    notes.push(`Rows of another readout version were left out (${Object.entries(otherVersions).map(([name, count]) => `${name}: ${count}`).join(", ")}): a different prefix, grammar or case template is a different readout.`);
  }
  notes.push("\"Actual\" is what the orchestrator and the judge did, not what was right: these are agreement rates, not accuracy.");
  notes.push("The pre-router is offered the turn's own capsule (at most four agents) plus \"none\"; the bench's 72.5% top-1 was eight options from the whole embedding ranking.");
  return report;
}

// ── Markdown ─────────────────────────────────────────────────────────────────────────────────────

function pct(value: number | null): string {
  return value === null ? "–" : `${(value * 100).toFixed(1)}%`;
}

function rateCell(r: Rate): string {
  return r.n === 0 ? "– (n=0)" : `${pct(r.rate)} (${r.k}/${r.n}, LB ${pct(r.lower)})`;
}

function agreementRows(title: string, table: Record<ReportBucket, Agreement2x2>, yes: string, actualYes: string): string[] {
  const lines = [
    `### ${title}`,
    "",
    `| lang | n | ${yes} & ${actualYes} | ${yes} only | ${actualYes} only | neither | agreement | precision of ${yes} | recall of ${actualYes} |`,
    "|---|---:|---:|---:|---:|---:|---|---|---|",
  ];
  for (const bucket of REPORT_LANGUAGES) {
    const cell = table[bucket];
    lines.push(`| ${bucket} | ${cell.n} | ${cell.both} | ${cell.readoutOnly} | ${cell.actualOnly} | ${cell.neither} | ${rateCell(cell.agreement)} | ${rateCell(cell.precision)} | ${rateCell(cell.recall)} |`);
  }
  lines.push("");
  return lines;
}

/** The report as Markdown: scope first, so thin data is never mistaken for proof. */
export function renderIntentReportMarkdown(report: IntentReport, inputs?: { files: Array<{ path: string; rows: number; malformedLines: number }>; duplicates: number }): string {
  const { scope } = report;
  const lines: string[] = [`# Intent readout vs. real turns (${report.version})`, ""];
  if (scope.thin) lines.push(`> **THIN DATA — ${scope.turnsWithReadout} turn(s) with a reading (below ${scope.thinDataTurns}).** Every figure below is an anecdote, not a measurement.`, "");
  lines.push("## Scope", "");
  if (inputs) {
    for (const file of inputs.files) lines.push(`- Input: ${file.path} (${file.rows} rows${file.malformedLines ? `, ${file.malformedLines} malformed lines` : ""})`);
    if (inputs.duplicates) lines.push(`- Duplicate rows dropped: ${inputs.duplicates}`);
  }
  lines.push(
    `- Shadow rows: ${scope.rows} in ${scope.sessions} session(s); with a reading: ${scope.turnsWithReadout}`,
    `- By language: de ${scope.byLanguage.de}, en ${scope.byLanguage.en}, other ${scope.byLanguage.other}`,
    `- By status: ${Object.entries(scope.byStatus).map(([key, count]) => `${key} ${count}`).join(", ") || "none"}`,
    `- Reasons: ${Object.entries(scope.byReason).map(([key, count]) => `${key} ${count}`).join(", ") || "none"}`,
    `- Readout latency: p50 ${report.coverage.readoutMs.p50 ?? "–"} ms, p90 ${report.coverage.readoutMs.p90 ?? "–"} ms (n=${report.coverage.readoutMs.n})`,
    `- Facets read (of ok rows): ${INTENT_FACETS.map((definition) => `${definition.name} ${pct(report.coverage.facetRead[definition.name].rate)}`).join(", ")}`,
    `- Capsule: ${Object.entries(report.coverage.capsuleStatus).map(([key, count]) => `${key} ${count}`).join(", ") || "none"} (trimmed from the prompt: ${report.coverage.capsuleTrimmed}); pre-router: ${Object.entries(report.coverage.preRouteStatus).map(([key, count]) => `${key} ${count}`).join(", ") || "none"}`,
    "",
  );
  for (const note of report.notes) lines.push(`> ${note}`, "");

  lines.push("## Source sensitivity: readout vs. the up-front judge", "", "Turns where the judge answered.", "");
  lines.push(...agreementRows("All readings", report.sourceSensitive, "readout yes", "judge yes"));
  lines.push(...agreementRows(`Confident readings (top ≥ ${DEFAULT_CONFIDENCE.minTop}, margin ≥ ${DEFAULT_CONFIDENCE.minMargin})`, report.sourceSensitiveConfident, "readout yes", "judge yes"));

  lines.push("## decision=answer_direct vs. a turn that routed nothing", "", "Routed: a specialist started under the turn, or a workflow ran.", "");
  lines.push(...agreementRows("All turns with a decision", report.answerDirect, "answer_direct", "routed nothing"));
  lines.push("### answer_direct by what the front desk did", "", "| lang | front desk answered | declined | not offered |", "|---|---|---|---|");
  for (const bucket of REPORT_LANGUAGES) {
    const cell = report.fastLane[bucket];
    lines.push(`| ${bucket} | ${rateCell(cell.answered)} | ${rateCell(cell.declined)} | ${rateCell(cell.notOffered)} |`);
  }
  lines.push("");

  lines.push("## decision=workflow vs. a workflow ran", "");
  lines.push(...agreementRows("All turns with a decision", report.workflow, "workflow", "workflow ran"));
  lines.push(...agreementRows("Turns the score threshold pressed toward a workflow", Object.fromEntries(REPORT_LANGUAGES.map((bucket) => [bucket, report.workflowForced[bucket].forced])) as Record<ReportBucket, Agreement2x2>, "workflow", "workflow ran"));
  lines.push(...agreementRows("Turns it did not press", Object.fromEntries(REPORT_LANGUAGES.map((bucket) => [bucket, report.workflowForced[bucket].unforced])) as Record<ReportBucket, Agreement2x2>, "workflow", "workflow ran"));

  lines.push("## Pre-router pick vs. the first specialist started", "", "Gold: the first specialist the orchestrator started, \"none\" when it started none.", "");
  lines.push("| lang | top-1 (all) | top-1 (turns that delegated) | delegated to an agent not offered |", "|---|---|---|---:|");
  for (const bucket of REPORT_LANGUAGES) {
    const cell = report.preRouter[bucket];
    lines.push(`| ${bucket} | ${rateCell(cell.top1)} | ${rateCell(cell.delegatedTop1)} | ${cell.goldNotOffered} |`);
  }
  lines.push("", `### At thresholds (margin ≥ ${DEFAULT_CONFIDENCE.minMargin}): an agent pick taken only above them`, "", "| lang | min top | n | coverage | precision |", "|---|---:|---:|---|---|");
  for (const row of report.preRouterThresholds) lines.push(`| ${row.language} | ${row.minTop} | ${row.n} | ${rateCell(row.coverage)} | ${rateCell(row.precision)} |`);
  lines.push("", "### \"none\" recall on turns that started no specialist", "", "| lang | pick is none | none after protection (defaults) |", "|---|---|---|");
  for (const bucket of REPORT_LANGUAGES) {
    const cell = report.noneRecall[bucket];
    lines.push(`| ${bucket} | ${rateCell(cell.raw)} | ${rateCell(cell.protected)} |`);
  }
  lines.push("");

  lines.push("## The orchestration module's include (EN/DE regex) vs. the readout", "", "Turns with the prompt split on (agents.performance.splitOrchestrationPrompt) and a decision reading.", "");
  lines.push(...agreementRows("Readout routes (single_agent/workflow/coordinate) vs. module included", Object.fromEntries(REPORT_LANGUAGES.map((bucket) => [bucket, report.moduleInclude[bucket].readoutRoutesVsModule])) as Record<ReportBucket, Agreement2x2>, "readout routes", "module included"));
  lines.push(...agreementRows("Module included vs. the turn routed", Object.fromEntries(REPORT_LANGUAGES.map((bucket) => [bucket, report.moduleInclude[bucket].moduleVsRouted])) as Record<ReportBucket, Agreement2x2>, "module included", "routed"));
  lines.push(...agreementRows("Readout routes vs. the turn routed", Object.fromEntries(REPORT_LANGUAGES.map((bucket) => [bucket, report.moduleInclude[bucket].readoutVsRouted])) as Record<ReportBucket, Agreement2x2>, "readout routes", "routed"));
  const all = report.moduleInclude.all;
  lines.push("### Module included / excluded by readout decision and mode (all languages)", "", "| readout | included | excluded |", "|---|---:|---:|");
  for (const [key, cell] of Object.entries(all.byDecision)) lines.push(`| decision=${key} | ${cell.included} | ${cell.excluded} |`);
  for (const [key, cell] of Object.entries(all.byMode)) lines.push(`| mode=${key} | ${cell.included} | ${cell.excluded} |`);
  lines.push("");

  lines.push("## Per facet: readout vs. the facet triage (turns where both ran)", "", "| facet | agreement |", "|---|---|");
  for (const definition of INTENT_FACETS) lines.push(`| ${definition.name} | ${rateCell(report.triage[definition.name])} |`);
  lines.push("");
  return lines.join("\n");
}
