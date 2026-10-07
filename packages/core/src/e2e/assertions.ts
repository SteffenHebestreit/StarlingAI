/**
 * One evaluator per expectation of the scenario contract (scenario.ts TurnExpectationSchema).
 * Each returns failure strings precise enough to act on without opening the report, e.g.
 *   events.must sub_agent_steering_injected: expected ≥1, saw 0
 *   tools.mustNotCall web_search: expected no call, saw 2 (researcher×2)
 *
 * Sources, as the gateway emits them (verified against packages/core/src):
 *   - orchestrator tool calls: "tool_call_requested" {tool, args} — one per dispatched call;
 *     "tool_call_completed" is NOT counted (the loop detectors log extra ones for one call)
 *   - sub-agent tool calls: "sub_agent_tool_call" {agentName, tool, phase} — phase "start" is
 *     one dispatched call; a "done" with no "start" of the same toolCallId is a call the run
 *     refused before dispatch (malformed args, a cap, a block); "recovered" and
 *     "shared_finding_*" phases are bookkeeping, not calls
 *   - refused attempts: "tool_call_blocked" {tool}, "sub_agent_tool_blocked" {tool},
 *     "tool_restriction_refused" {tool} — reported beside the calls, never counted as calls
 *   - sub-agent runs: "sub_agent_started" {agentName} logged on the run's own session; the
 *     variant with a `stage` field (discovery_fallback_strip) is a note on the parent, not a run
 */
import type { E2EEventMatcher, E2ETurnExpectation } from "./scenario.js";
import type { AuditEventLike } from "./gateway-client.js";

export type FieldMatcher = NonNullable<E2EEventMatcher["where"]>[string];

/** A file the turn delivered: the attachments the runtime pinned on its answer and the files its
 *  tool results recorded (agent/artifact-metadata.ts), as session.get returns them. */
export interface ArtifactRef {
  /** relativePath, else externalUrl, else filename. */
  path: string;
  filename: string;
  contentType?: string;
  sourceTool?: string;
}

/** What one turn produced, as the runner observed it. */
export interface TurnObservation {
  status: "ok" | "error" | "blocked";
  reply: string;
  error?: string;
  durationMs: number;
  /** The turn's audit events: its root session and every sub-agent run / workflow under it. */
  events: AuditEventLike[];
  artifacts: ArtifactRef[];
}

export interface ToolSummary {
  /** Dispatched calls per tool, orchestrator and sub-agents together. */
  calls: Record<string, number>;
  /** Attempts refused before dispatch, per tool. */
  refused: Record<string, number>;
  /** Dispatched calls per caller ("orchestrator" or the sub-agent's name), then per tool. */
  byAgent: Record<string, Record<string, number>>;
}

const regexCache = new Map<string, RegExp | Error>();

/** A compiled regex, or the error its source raised (cached either way). */
export function compileRegex(source: string, flags = ""): RegExp | Error {
  const key = `${flags}/${source}`;
  const cached = regexCache.get(key);
  if (cached) return cached;
  let compiled: RegExp | Error;
  try {
    compiled = new RegExp(source, flags);
  } catch (err) {
    compiled = err instanceof Error ? err : new Error(String(err));
  }
  regexCache.set(key, compiled);
  return compiled;
}

/** The value at a dotted path ("data.agentName", "data.tasks.0.agentName"), or undefined. */
export function valueAtPath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return undefined;
      current = current[Number(segment)];
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function anyElement(actual: unknown, test: (value: unknown) => boolean): boolean {
  return Array.isArray(actual) ? actual.some(test) : test(actual);
}

function numeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/**
 * Whether one event field satisfies its matcher. A literal must be strictly equal; a regex (JS
 * syntax, no flags) must match the value's string form; gte/lte compare numbers; `in` lists the
 * allowed literals; `exists` asks whether the path is present (null counts as present). Against
 * an array field, a literal, a regex and `in` match when one element does.
 */
export function fieldMatches(actual: unknown, matcher: FieldMatcher): boolean {
  if (typeof matcher === "string" || typeof matcher === "number" || typeof matcher === "boolean") {
    return anyElement(actual, (value) => value === matcher);
  }
  if ("regex" in matcher) {
    const regex = compileRegex(matcher.regex);
    if (regex instanceof Error) return false;
    return anyElement(actual, (value) =>
      (typeof value === "string" || typeof value === "number" || typeof value === "boolean") && regex.test(String(value)));
  }
  if ("gte" in matcher) {
    const value = numeric(actual);
    return value !== null && value >= matcher.gte;
  }
  if ("lte" in matcher) {
    const value = numeric(actual);
    return value !== null && value <= matcher.lte;
  }
  if ("in" in matcher) {
    return anyElement(actual, (value) => matcher.in.some((allowed) => allowed === value));
  }
  return (actual !== undefined) === matcher.exists;
}

export function matchesEvent(matcher: E2EEventMatcher, event: AuditEventLike): boolean {
  if (event.type !== matcher.type) return false;
  for (const [path, fieldMatcher] of Object.entries(matcher.where ?? {})) {
    if (!fieldMatches(valueAtPath(event, path), fieldMatcher)) return false;
  }
  return true;
}

function describeField(matcher: FieldMatcher): string {
  if (typeof matcher === "string" || typeof matcher === "number" || typeof matcher === "boolean") return `=${String(matcher)}`;
  if ("regex" in matcher) return `~/${matcher.regex}/`;
  if ("gte" in matcher) return `≥${matcher.gte}`;
  if ("lte" in matcher) return `≤${matcher.lte}`;
  if ("in" in matcher) return ` in [${matcher.in.map(String).join(", ")}]`;
  return matcher.exists ? " exists" : " absent";
}

/** "sub_agent_started{data.agentName=researcher}" */
export function describeMatcher(matcher: E2EEventMatcher): string {
  const where = Object.entries(matcher.where ?? {});
  if (where.length === 0) return matcher.type;
  return `${matcher.type}{${where.map(([path, field]) => `${path}${describeField(field)}`).join(", ")}}`;
}

/** Regex errors of a matcher, as failure strings (empty when every regex compiles). */
function matcherRegexErrors(label: string, matcher: E2EEventMatcher): string[] {
  const errors: string[] = [];
  for (const [path, field] of Object.entries(matcher.where ?? {})) {
    if (typeof field === "object" && "regex" in field) {
      const compiled = compileRegex(field.regex);
      if (compiled instanceof Error) errors.push(`${label} ${matcher.type}: invalid regex for ${path} /${field.regex}/ (${compiled.message})`);
    }
  }
  return errors;
}

function describeCountRange(min: number, max: number | undefined): string {
  if (max === undefined) return `≥${min}`;
  if (min === max) return `exactly ${min}`;
  if (min === 0) return `≤${max}`;
  return `${min}..${max}`;
}

export function eventTypeCounts(events: readonly AuditEventLike[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1;
  return counts;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function bump(record: Record<string, number>, key: string, by = 1): void {
  record[key] = (record[key] ?? 0) + by;
}

/** The agent a session id names: "sub:<parent>:<agent>:<ts>" → agent (best effort). */
function agentFromSessionId(sessionId: string | undefined): string {
  if (!sessionId?.startsWith("sub:")) return "orchestrator";
  const inner = sessionId.slice("sub:".length);
  const lastColon = inner.lastIndexOf(":");
  const before = lastColon > 0 ? inner.slice(0, lastColon) : inner;
  const agentStart = before.lastIndexOf(":");
  return agentStart >= 0 ? before.slice(agentStart + 1) || "sub-agent" : "sub-agent";
}

export function summarizeTools(events: readonly AuditEventLike[]): ToolSummary {
  const summary: ToolSummary = { calls: {}, refused: {}, byAgent: {} };
  const started = new Set<string>();
  const called = (tool: string, agent: string): void => {
    bump(summary.calls, tool);
    const perAgent = summary.byAgent[agent] ?? {};
    bump(perAgent, tool);
    summary.byAgent[agent] = perAgent;
  };
  for (const event of events) {
    if (event.type !== "sub_agent_tool_call" || text(event.data["phase"]) !== "start") continue;
    const id = text(event.data["toolCallId"]);
    if (id) started.add(`${event.sessionId ?? ""}|${id}`);
  }
  for (const event of events) {
    const tool = text(event.data["tool"]);
    if (!tool) continue;
    switch (event.type) {
      case "tool_call_requested":
        called(tool, "orchestrator");
        break;
      case "sub_agent_tool_call": {
        const phase = text(event.data["phase"]);
        const agent = text(event.data["agentName"]) || agentFromSessionId(event.sessionId);
        if (phase === "start") called(tool, agent);
        else if (phase === "done") {
          const id = text(event.data["toolCallId"]);
          if (id && !started.has(`${event.sessionId ?? ""}|${id}`)) bump(summary.refused, tool);
        }
        break;
      }
      case "tool_call_blocked":
      case "sub_agent_tool_blocked":
      case "tool_restriction_refused":
        bump(summary.refused, tool);
        break;
      default:
        break;
    }
  }
  return summary;
}

/** Sub-agent runs per agent name. */
export function summarizeAgents(events: readonly AuditEventLike[]): Record<string, number> {
  const runs: Record<string, number> = {};
  for (const event of events) {
    if (event.type !== "sub_agent_started" || event.data["stage"] !== undefined) continue;
    const agent = text(event.data["agentName"]);
    if (agent) bump(runs, agent);
  }
  return runs;
}

function breakdown(counts: Record<string, number>): string {
  const entries = Object.entries(counts).filter(([, count]) => count > 0);
  return entries.length === 0 ? "none" : entries.map(([name, count]) => `${name}×${count}`).join(", ");
}

// ── Reply language ─────────────────────────────────────────────────────────────
// Function words only, and none that both languages use ("in", "so", "was", "will", "die",
// "also", "an", "am", "war", "hat"), so a hit says something about the language.
const GERMAN_MARKERS = new Set([
  "der", "das", "und", "ist", "nicht", "ein", "eine", "einen", "einem", "einer", "ich", "sie", "es", "mit", "auf",
  "für", "von", "zu", "den", "dem", "des", "im", "sich", "auch", "wie", "wir", "ihr", "aber", "oder", "wenn", "dass",
  "noch", "nur", "bei", "aus", "nach", "kann", "können", "werden", "wird", "sind", "haben", "über", "um", "mehr",
  "sehr", "hier", "diese", "dieser", "dieses", "mir", "mich", "dir", "uns", "kein", "keine", "schon", "jetzt", "dann",
  "weil", "als", "bitte", "gerne", "danke", "zum", "zur", "vom", "beim", "ins", "sowie", "damit", "einfach",
  "habe", "hast", "gibt", "ihre", "ihren", "unsere", "wurde", "wurden", "sollte", "müssen", "soll", "zwischen",
]);
const ENGLISH_MARKERS = new Set([
  "the", "and", "is", "are", "not", "a", "of", "to", "it", "with", "on", "for", "you", "this", "that", "be", "were",
  "have", "has", "can", "would", "should", "your", "my", "we", "they", "but", "or", "if", "at", "from", "by", "as",
  "more", "very", "here", "these", "there", "what", "which", "who", "how", "just", "now", "then", "because", "please",
  "thanks", "into", "about", "been", "their", "our", "its", "than", "could", "does", "do", "did",
  "some", "any", "all", "only", "when", "where", "while", "after", "before", "between",
]);

export interface LanguageVerdict {
  language: "de" | "en" | "unknown";
  german: number;
  english: number;
}

/**
 * The reply's dominant language by function-word counts (code blocks, inline code and URLs left
 * out). "unknown" below three markers in all, or when neither side has 60 % of them.
 */
export function detectReplyLanguage(reply: string): LanguageVerdict {
  const prose = reply
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ");
  let german = 0;
  let english = 0;
  for (const word of prose.toLowerCase().match(/[a-zäöüß]+/g) ?? []) {
    if (GERMAN_MARKERS.has(word)) german += 1;
    else if (ENGLISH_MARKERS.has(word)) english += 1;
  }
  // Umlauts and ß are a strong German signal, one marker per word that carries one.
  german += (prose.toLowerCase().match(/[a-z]*[äöüß][a-zäöüß]*/g) ?? []).length;
  const total = german + english;
  if (total < 3) return { language: "unknown", german, english };
  if (german / total >= 0.6) return { language: "de", german, english };
  if (english / total >= 0.6) return { language: "en", german, english };
  return { language: "unknown", german, english };
}

// ── Evaluators ─────────────────────────────────────────────────────────────────

type ReplyExpectation = NonNullable<E2ETurnExpectation["reply"]>;
type EventsExpectation = NonNullable<E2ETurnExpectation["events"]>;
type ToolsExpectation = NonNullable<E2ETurnExpectation["tools"]>;
type AgentsExpectation = NonNullable<E2ETurnExpectation["agents"]>;
type ArtifactsExpectation = NonNullable<E2ETurnExpectation["artifacts"]>;

export function checkReply(expect: ReplyExpectation, reply: string): string[] {
  const failures: string[] = [];
  const haystack = reply.toLowerCase();
  for (const needle of expect.includes ?? []) {
    if (!haystack.includes(needle.toLowerCase())) failures.push(`reply.includes "${needle}": not found`);
  }
  if (expect.includesAny && expect.includesAny.length > 0
    && !expect.includesAny.some((needle) => haystack.includes(needle.toLowerCase()))) {
    failures.push(`reply.includesAny: none of ${expect.includesAny.map((needle) => `"${needle}"`).join(", ")} found`);
  }
  for (const needle of expect.excludes ?? []) {
    if (haystack.includes(needle.toLowerCase())) failures.push(`reply.excludes "${needle}": found`);
  }
  for (const source of expect.matches ?? []) {
    const regex = compileRegex(source, "i");
    if (regex instanceof Error) failures.push(`reply.matches /${source}/i: invalid regex (${regex.message})`);
    else if (!regex.test(reply)) failures.push(`reply.matches /${source}/i: no match`);
  }
  if (expect.language) {
    const verdict = detectReplyLanguage(reply);
    if (verdict.language !== expect.language) {
      failures.push(`reply.language: expected ${expect.language}, detected ${verdict.language} (German markers ${verdict.german}, English markers ${verdict.english})`);
    }
  }
  if (expect.minChars !== undefined && reply.length < expect.minChars) {
    failures.push(`reply.minChars: expected ≥${expect.minChars} chars, saw ${reply.length}`);
  }
  if (expect.maxChars !== undefined && reply.length > expect.maxChars) {
    failures.push(`reply.maxChars: expected ≤${expect.maxChars} chars, saw ${reply.length}`);
  }
  return failures;
}

export function checkEvents(expect: EventsExpectation, events: readonly AuditEventLike[]): string[] {
  const failures: string[] = [];
  for (const matcher of expect.must ?? []) {
    const regexErrors = matcherRegexErrors("events.must", matcher);
    if (regexErrors.length > 0) {
      failures.push(...regexErrors);
      continue;
    }
    const min = matcher.min ?? 1;
    const seen = events.filter((event) => matchesEvent(matcher, event)).length;
    if (seen < min || (matcher.max !== undefined && seen > matcher.max)) {
      failures.push(`events.must ${describeMatcher(matcher)}: expected ${describeCountRange(min, matcher.max)}, saw ${seen}`);
    }
  }
  for (const matcher of expect.mustNot ?? []) {
    const regexErrors = matcherRegexErrors("events.mustNot", matcher);
    if (regexErrors.length > 0) {
      failures.push(...regexErrors);
      continue;
    }
    const seen = events.filter((event) => matchesEvent(matcher, event)).length;
    if (seen > 0) failures.push(`events.mustNot ${describeMatcher(matcher)}: expected none, saw ${seen}`);
  }
  return failures;
}

export function checkTools(expect: ToolsExpectation, summary: ToolSummary): string[] {
  const failures: string[] = [];
  const callers = (tool: string): string => {
    const parts = Object.entries(summary.byAgent)
      .filter(([, tools]) => (tools[tool] ?? 0) > 0)
      .map(([agent, tools]) => `${agent}×${tools[tool]}`);
    return parts.length > 0 ? ` (${parts.join(", ")})` : "";
  };
  for (const tool of expect.mustCall ?? []) {
    if ((summary.calls[tool] ?? 0) === 0) {
      const refused = summary.refused[tool] ?? 0;
      failures.push(`tools.mustCall ${tool}: expected ≥1 call, saw 0${refused > 0 ? ` (${refused} refused attempt(s) not counted)` : ""}`);
    }
  }
  for (const tool of expect.mustNotCall ?? []) {
    const calls = summary.calls[tool] ?? 0;
    if (calls > 0) failures.push(`tools.mustNotCall ${tool}: expected no call, saw ${calls}${callers(tool)}`);
  }
  for (const [tool, max] of Object.entries(expect.maxCalls ?? {})) {
    const calls = summary.calls[tool] ?? 0;
    if (calls > max) failures.push(`tools.maxCalls ${tool}: expected ≤${max} call(s), saw ${calls}${callers(tool)}`);
  }
  return failures;
}

export function checkAgents(expect: AgentsExpectation, runs: Record<string, number>): string[] {
  const failures: string[] = [];
  const ran = breakdown(runs);
  for (const agent of expect.mustRun ?? []) {
    if ((runs[agent] ?? 0) === 0) failures.push(`agents.mustRun ${agent}: expected ≥1 run, saw 0 (ran: ${ran})`);
  }
  if (expect.mustRunAny && expect.mustRunAny.length > 0 && !expect.mustRunAny.some((agent) => (runs[agent] ?? 0) > 0)) {
    failures.push(`agents.mustRunAny ${expect.mustRunAny.join(" | ")}: none ran (ran: ${ran})`);
  }
  for (const agent of expect.mustNotRun ?? []) {
    const count = runs[agent] ?? 0;
    if (count > 0) failures.push(`agents.mustNotRun ${agent}: expected no run, saw ${count}`);
  }
  if (expect.maxRuns !== undefined) {
    const total = Object.values(runs).reduce((sum, count) => sum + count, 0);
    if (total > expect.maxRuns) failures.push(`agents.maxRuns: expected ≤${expect.maxRuns} run(s), saw ${total} (${ran})`);
  }
  return failures;
}

export function checkArtifacts(expect: ArtifactsExpectation, artifacts: readonly ArtifactRef[]): string[] {
  const failures: string[] = [];
  const listed = artifacts.length > 0 ? artifacts.map((artifact) => artifact.path).join(", ") : "no artifacts";
  if (expect.minCount !== undefined && artifacts.length < expect.minCount) {
    failures.push(`artifacts.minCount: expected ≥${expect.minCount}, saw ${artifacts.length} (${listed})`);
  }
  for (const source of expect.pathMatches ?? []) {
    const regex = compileRegex(source, "i");
    if (regex instanceof Error) failures.push(`artifacts.pathMatches /${source}/i: invalid regex (${regex.message})`);
    else if (!artifacts.some((artifact) => regex.test(artifact.path))) failures.push(`artifacts.pathMatches /${source}/i: no artifact path matched (${listed})`);
  }
  return failures;
}

/**
 * What the final status settles: status (always checked, default "ok" — a turn step without
 * `expect` still fails on an error), reply, artifacts and duration.
 */
export function evaluateCompletionExpectations(expect: E2ETurnExpectation | undefined, observation: Omit<TurnObservation, "events">): string[] {
  const failures: string[] = [];
  const wanted = expect?.status ?? "ok";
  if (observation.status !== wanted) {
    const detail = observation.error ? ` (${observation.error.length > 300 ? `${observation.error.slice(0, 300)}…` : observation.error})` : "";
    failures.push(`status: expected ${wanted}, saw ${observation.status}${detail}`);
  }
  if (!expect) return failures;
  if (expect.reply) failures.push(...checkReply(expect.reply, observation.reply));
  if (expect.artifacts) failures.push(...checkArtifacts(expect.artifacts, observation.artifacts));
  if (expect.durationMs && observation.durationMs > expect.durationMs.max) {
    failures.push(`durationMs: expected ≤${expect.durationMs.max} ms, took ${observation.durationMs} ms`);
  }
  return failures;
}

/**
 * What the audit stream settles: events, tools and agents. The runner evaluates these when the
 * turn's event window closes (the next step that is not a wait, or the end of the attempt plus a
 * grace period), because some events are logged after the final status.
 */
export function evaluateEventExpectations(expect: E2ETurnExpectation | undefined, events: readonly AuditEventLike[]): string[] {
  const failures: string[] = [];
  if (!expect) return failures;
  if (expect.events) failures.push(...checkEvents(expect.events, events));
  if (expect.tools) failures.push(...checkTools(expect.tools, summarizeTools(events)));
  if (expect.agents) failures.push(...checkAgents(expect.agents, summarizeAgents(events)));
  return failures;
}

/** Every deterministic expectation of a turn; the judge is the runner's and runs only when this is empty. */
export function evaluateTurnExpectations(expect: E2ETurnExpectation | undefined, observation: TurnObservation): string[] {
  return [...evaluateCompletionExpectations(expect, observation), ...evaluateEventExpectations(expect, observation.events)];
}
