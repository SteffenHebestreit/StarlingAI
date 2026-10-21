/**
 * Lab tasks from the turns that failed live (harness lab P3).
 *
 * The lab's synthetic corpus only finds what its authors thought to write down. This reads the turns
 * the live swarm itself recorded as failures (turn_scorecard learningOutcome "failure"), and has the
 * lab's local anonymizer rewrite each one as a synthetic task: the same kind of request, deliverable,
 * capabilities and language, with every name, figure and address invented. A screen then refuses a
 * task that still carries an address, a phone number, an IBAN, a figure or a run of words from the
 * original, and lists the original's rarer words it shares for the reviewer. What passes lands in an
 * inbox, unreviewed: the lab runs a failure-derived task only once a person has accepted it
 * (task-schema.ts loadCorpus).
 *
 * The original text is read from the session store and handed to the local model only; it is never
 * written anywhere, logged, or kept in a report. A task remembers the turn it came from as a digest.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import JSON5 from "json5";
import { startsTurn } from "../agent/turn-boundary.js";
import { extractJsonObject } from "./edit-format.js";
import type { LabComplete } from "./lab-config.js";
import { HarnessTaskSchema, type HarnessTask } from "./task-schema.js";
import { LAB_UNAVAILABLE_SERVICES } from "./import-seeds.js";

/** Channels and principals whose turns are tests, never live use. */
const TEST_CHANNELS: ReadonlySet<string> = new Set(["eval", "scene", "test"]);
const TEST_PRINCIPAL_RE = /^(?:eval|harness-lab)/;

/**
 * A thrown turn ("error") is mostly the model or a service being down, which no prompt changes;
 * left out unless asked for. A timeout or a warden abort is usually a loop, and stays in.
 */
export const INFRASTRUCTURE_BASES: ReadonlySet<string> = new Set(["error"]);

/** A failed live turn as the audit and the session store recorded it. */
export interface FailedTurn {
  /** sha256 of the session and the turn's time: the task's source, never reversible to either. */
  digest: string;
  at: string;
  basis: string;
  /** The user message that opened the turn, and the one before it (context for a follow-up). */
  message: string;
  previous?: string;
  agents: string[];
  tools: string[];
  failedTools: string[];
  delegationCount: number;
  artifactCount: number;
}

export interface ScorecardRow {
  timestamp: string;
  sessionId: string;
  userId?: string | null;
  channel?: string | null;
  data: Record<string, unknown>;
}

export interface TurnEventRow {
  type: string;
  timestamp: string;
  sessionId: string;
  data: Record<string, unknown>;
}

export interface HistoryMessage {
  role: string;
  content?: unknown;
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

export function turnDigest(sessionId: string, at: string): string {
  return createHash("sha256").update(`${sessionId}|${at}`).digest("hex");
}

/** Whether a failed scorecard comes from live use and names a defect a prompt could change. */
export function harvestable(row: ScorecardRow, includeErrors = false): { ok: true; basis: string } | { ok: false; reason: string } {
  if (row.data["learningOutcome"] !== "failure") return { ok: false, reason: "not a failure" };
  if (row.channel && TEST_CHANNELS.has(row.channel)) return { ok: false, reason: `test channel ${row.channel}` };
  if (row.userId && TEST_PRINCIPAL_RE.test(row.userId)) return { ok: false, reason: "test principal" };
  const basis = typeof row.data["learningBasis"] === "string" && row.data["learningBasis"] ? row.data["learningBasis"] : "failed";
  if (!includeErrors && INFRASTRUCTURE_BASES.has(basis)) return { ok: false, reason: `basis ${basis} (infrastructure)` };
  return { ok: true, basis };
}

/** The user message that opened the turn whose scorecard was written at `at`, and the one before it. */
export function turnMessages(history: readonly HistoryMessage[], at: string): { message: string; previous?: string } | null {
  const atMs = Date.parse(at);
  const opened = history
    .filter((message) => startsTurn({ role: message.role, metadata: message.metadata }))
    .filter((message) => typeof message.content === "string" && message.content.trim())
    .filter((message) => !message.timestamp || !Number.isFinite(atMs) || Date.parse(message.timestamp) <= atMs);
  const last = opened.at(-1);
  if (!last) return null;
  const before = opened.at(-2);
  return {
    message: String(last.content).trim(),
    ...(before ? { previous: String(before.content).trim() } : {}),
  };
}

/** What the turn ran: the agents it started and the tools they and the orchestrator called. */
export function turnPath(rows: readonly TurnEventRow[]): Pick<FailedTurn, "agents" | "tools" | "failedTools"> {
  const agents = new Set<string>();
  const tools = new Set<string>();
  const failed = new Set<string>();
  const name = (value: unknown) => (typeof value === "string" && /^[\w.:-]{1,80}$/.test(value) ? value : undefined);
  for (const row of rows) {
    if (row.type === "sub_agent_started") {
      const agent = name(row.data["agentName"]);
      if (agent) agents.add(agent);
      continue;
    }
    // A sub-agent call is logged when it starts and when it is done; only the latter carries success.
    if (row.type !== "sub_agent_tool_call" && row.type !== "tool_call_completed" && row.type !== "tool_call_failed") continue;
    const tool = name(row.data["tool"]);
    if (!tool) continue;
    tools.add(tool);
    if (row.type === "tool_call_failed" || row.data["success"] === false) failed.add(tool);
  }
  return { agents: [...agents].sort(), tools: [...tools].sort(), failedTools: [...failed].sort() };
}

/** The lab-unavailable services a turn's path needs (a browser, a mailbox, a desktop, images, speech). */
export function servicesNeeded(path: Pick<FailedTurn, "agents" | "tools">): string[] {
  const needed = new Set<string>();
  for (const id of [...path.agents, ...path.tools]) {
    const lower = id.toLowerCase();
    if (/^browser_|browser/.test(lower)) needed.add("browser");
    if (/^mail_|mail_agent/.test(lower)) needed.add("mail");
    if (/^computer_|computer_use/.test(lower)) needed.add("computer-desktop");
    if (/^(generate|edit)_image$|image_creator/.test(lower)) needed.add("image");
    if (/speech|^tts_|^stt_|transcribe/.test(lower)) needed.add("speech");
  }
  return [...needed].filter((service) => LAB_UNAVAILABLE_SERVICES.has(service)).sort();
}

// ── The anonymizer ──────────────────────────────────────────────────────────────────────────────

export const ANONYMIZER_SYSTEM = `You turn one real request to an AI agent swarm, which the swarm failed, into a SYNTHETIC test task for its lab.

Keep what made the request what it is: the kind of request, what it asks to have delivered, the capabilities it needed, its language, its tone and how it is phrased (length, level of detail, formality).
Invent EVERY specific: names of people, companies, places and products, figures, dates, file names, addresses. Web addresses only on example.com, example.org or *.example hosts; e-mail addresses only @example.com. Write no phone number, IBAN or other account number at all, not even an invented one: leave them out. Never copy a sentence or a distinctive phrase of the original.
If the request refers to an earlier message, put the context it needs into the new request itself.
If the request cannot be made synthetic without losing what it is about (it is about the person's own private records, accounts or messages), decline.

Answer with one JSON object only:
{"title": "<short title, in English>", "message": "<the synthetic request, in the original's language>", "deliverable": {"kind": "answer" | "file" | "site" | "data", "shape": "<what a good result looks like, one sentence>"}, "domain": "<one word>", "tags": ["<word>", ...]}
or {"skip": "<why>"}`;

export function anonymizerInput(turn: FailedTurn): string {
  return [
    turn.previous ? `Earlier user message (context only):\n${turn.previous}\n` : "",
    `The request:\n${turn.message}\n`,
    `What the swarm ran: agents ${turn.agents.join(", ") || "none"}; tools ${turn.tools.join(", ") || "none"}; ${turn.delegationCount} delegation(s), ${turn.artifactCount} file(s) produced.`,
    `Why the turn counted as failed: ${turn.basis}.`,
  ].filter(Boolean).join("\n");
}

export interface DerivedDraft {
  title: string;
  message: string;
  deliverable: { kind: "answer" | "file" | "site" | "data"; shape: string };
  domain: string;
  tags: string[];
}

/** The anonymizer's answer as a draft, its stated reason to decline, or why it is unusable. */
export function parseDraft(content: string): { draft: DerivedDraft } | { skip: string } | { malformed: string } {
  const raw = extractJsonObject(content);
  if (!raw) return { malformed: "no JSON object" };
  if (typeof raw["skip"] === "string") return { skip: raw["skip"].slice(0, 200) };
  const str = (value: unknown, max: number) => (typeof value === "string" && value.trim() && value.trim().length <= max ? value.trim() : undefined);
  const title = str(raw["title"], 120);
  const message = str(raw["message"], 4_000);
  if (!title) return { malformed: "title missing or over 120 characters" };
  if (!message || message.length < 10) return { malformed: "message missing, too short or over 4000 characters" };
  const deliverable = raw["deliverable"] && typeof raw["deliverable"] === "object" ? raw["deliverable"] as Record<string, unknown> : {};
  const kind = deliverable["kind"];
  if (kind !== "answer" && kind !== "file" && kind !== "site" && kind !== "data") return { malformed: "deliverable.kind is not answer, file, site or data" };
  const shape = str(deliverable["shape"], 400) ?? "";
  const domain = (str(raw["domain"], 40) ?? "general").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "") || "general";
  const tags = Array.isArray(raw["tags"])
    ? [...new Set(raw["tags"].filter((t): t is string => typeof t === "string").map((t) => t.trim().toLowerCase()).filter((t) => /^[\p{L}\p{N}-]{2,30}$/u.test(t)))].slice(0, 6)
    : [];
  return { draft: { title, message, deliverable: { kind, shape }, domain, tags } };
}

// ── The leak screen ─────────────────────────────────────────────────────────────────────────────

const RESERVED_HOST_RE = /(?:^|\.)(?:example\.(?:com|org|net)|[a-z0-9-]+\.(?:example|test|invalid|localhost))$/i;
const EMAIL_RE = /[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/g;
const URL_RE = /\b(?:https?:\/\/|www\.)([^\s/:?#"'<>)]+)/gi;
/** A number dialled: a leading + or 0, then at least eight more digits, spaces, slashes or dashes. */
const PHONE_RE = /(?:\+|\b0)\d[\d /-]{7,}\d/g;
const IBAN_RE = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,4})?\b/g;
/** A run of this many of the original's words, in order, is a copied phrase. */
const COPIED_RUN = 6;

function tokens(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

export interface LeakScreen {
  /** The task is refused: what it still carries (named by kind, never quoted). */
  hard: string[];
  /** For the reviewer: the original's rarer words the task shares. */
  shared: string[];
}

/**
 * What the derived text still carries of the original. `commonWords` are words common enough not to
 * identify anyone (the lab's own synthetic tasks and the swarm's prompts): a shared word outside them
 * is listed for the reviewer, never refused, since it is often just the request's subject ("Rechnung").
 */
export function leakScreen(derived: string, original: string, commonWords: ReadonlySet<string>): LeakScreen {
  const hard = new Set<string>();
  for (const match of derived.matchAll(EMAIL_RE)) if (!RESERVED_HOST_RE.test(match[1]!)) hard.add("an e-mail address outside example.com");
  for (const match of derived.matchAll(URL_RE)) if (!RESERVED_HOST_RE.test(match[1]!.replace(/\.$/, ""))) hard.add("a web address outside the reserved example hosts");
  if (PHONE_RE.test(derived)) hard.add("a phone number");
  PHONE_RE.lastIndex = 0;
  if (IBAN_RE.test(derived)) hard.add("an IBAN");
  IBAN_RE.lastIndex = 0;

  const originalTokens = tokens(original);
  const derivedTokens = tokens(derived);
  const originalNumbers = new Set(originalTokens.filter((t) => /\d/.test(t) && t.replace(/\D/g, "").length >= 3));
  if (derivedTokens.some((t) => originalNumbers.has(t))) hard.add("a figure from the original");
  // A copied run is a leak when it carries a word that could say who or what it was about; a request's
  // stock opening ("Erstelle mir bitte ein PDF-Angebot für die") copied whole identifies nobody.
  const rare = (t: string) => t.length >= 5 && !/\d/.test(t) && !commonWords.has(t);
  const runs = new Set<string>();
  for (let i = 0; i + COPIED_RUN <= originalTokens.length; i += 1) runs.add(originalTokens.slice(i, i + COPIED_RUN).join(" "));
  for (let i = 0; i + COPIED_RUN <= derivedTokens.length; i += 1) {
    const run = derivedTokens.slice(i, i + COPIED_RUN);
    if (runs.has(run.join(" ")) && run.some(rare)) { hard.add(`a run of ${COPIED_RUN} words from the original, with a rare one`); break; }
  }

  const originalSet = new Set(originalTokens);
  const shared = [...new Set(derivedTokens)].filter((t) => originalSet.has(t) && rare(t)).sort();
  return { hard: [...hard].sort(), shared };
}

/** The words of the lab's own tasks and the swarm's prompts: vocabulary that identifies nobody. */
export function commonVocabulary(texts: Iterable<string>): Set<string> {
  const words = new Set<string>();
  for (const text of texts) for (const word of tokens(text)) words.add(word);
  return words;
}

// ── The task ────────────────────────────────────────────────────────────────────────────────────

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "failed";
}

/** The task a draft becomes: unreviewed, its checks only what the deliverable makes certain. */
export function draftToTask(draft: DerivedDraft, turn: Pick<FailedTurn, "digest" | "basis">): HarnessTask {
  const expect = draft.deliverable.kind === "site"
    ? { artifacts: { minCount: 1, pathMatches: ["\\.html?$"] } }
    : draft.deliverable.kind === "file"
      ? { artifacts: { minCount: 1 } }
      : undefined;
  return HarnessTaskSchema.parse({
    id: `fd.${slug(turn.basis)}.${turn.digest.slice(0, 8)}`,
    title: draft.title,
    origin: "failure-derived",
    source: `turn:${turn.digest.slice(0, 16)}`,
    tags: [...new Set([...draft.tags, "failure-derived"])],
    domain: draft.domain,
    role: "both",
    requires: [],
    turns: [{ message: draft.message, ...(expect ? { expect } : {}) }],
    deliverable: draft.deliverable,
  });
}

// ── Harvest ─────────────────────────────────────────────────────────────────────────────────────

export interface HarvestStores {
  /** The failed scorecards since `sinceIso`, newest first, at most `limit`. */
  failedScorecards(sinceIso: string, limit: number): Promise<ScorecardRow[]>;
  /** When the turn that wrote the scorecard at `at` started (its message_received), or null. */
  turnStart(sessionId: string, at: string): Promise<string | null>;
  /** The audit rows of the session and every sub-agent run under it between two times. */
  turnEvents(sessionId: string, fromIso: string, toIso: string): Promise<TurnEventRow[]>;
  /** The session's history from the session store, or null when it is no longer stored. */
  sessionHistory(sessionId: string): Promise<HistoryMessage[] | null>;
}

export interface HarvestOptions {
  sinceIso: string;
  limit: number;
  includeErrors?: boolean;
  /** Turn digests already in the inbox, the corpus or the rejected list. */
  known: ReadonlySet<string>;
  commonWords: ReadonlySet<string>;
  complete: LabComplete;
  log?: (line: string) => void;
}

export interface HarvestResult {
  derived: Array<{ task: HarnessTask; shared: string[]; basis: string }>;
  /** One line per turn left out, without anything of its content. */
  skipped: Array<{ basis?: string; reason: string }>;
  scanned: number;
}

/** Read the failed live turns and derive one screened, unreviewed task from each that allows it. */
export async function harvestFailures(stores: HarvestStores, opts: HarvestOptions): Promise<HarvestResult> {
  const result: HarvestResult = { derived: [], skipped: [], scanned: 0 };
  // Over-fetch: test traffic and infrastructure failures are filtered here, not in the query.
  const rows = await stores.failedScorecards(opts.sinceIso, opts.limit * 5);
  for (const row of rows) {
    if (result.derived.length >= opts.limit) break;
    result.scanned += 1;
    const check = harvestable(row, opts.includeErrors);
    if (!check.ok) { result.skipped.push({ reason: check.reason }); continue; }
    const basis = check.basis;
    const digest = turnDigest(row.sessionId, row.timestamp);
    if (opts.known.has(digest.slice(0, 16))) { result.skipped.push({ basis, reason: "already harvested" }); continue; }
    const history = await stores.sessionHistory(row.sessionId);
    if (!history) { result.skipped.push({ basis, reason: "session no longer stored" }); continue; }
    const messages = turnMessages(history, row.timestamp);
    if (!messages) { result.skipped.push({ basis, reason: "no user message for the turn" }); continue; }
    const start = await stores.turnStart(row.sessionId, row.timestamp);
    const events = start ? await stores.turnEvents(row.sessionId, start, row.timestamp) : [];
    const path = turnPath(events);
    const needed = servicesNeeded(path);
    if (needed.length > 0) { result.skipped.push({ basis, reason: `needs ${needed.join(", ")}, which the lab does not run` }); continue; }
    const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
    const turn: FailedTurn = {
      digest,
      at: row.timestamp,
      basis,
      ...messages,
      ...path,
      delegationCount: num(row.data["delegationCount"]),
      artifactCount: num(row.data["artifactCount"]),
    };
    let parsed: ReturnType<typeof parseDraft>;
    try {
      parsed = parseDraft(await opts.complete("anonymizer", ANONYMIZER_SYSTEM, anonymizerInput(turn)));
    } catch (err) {
      result.skipped.push({ basis, reason: `anonymizer call failed: ${err instanceof Error ? err.message.slice(0, 120) : "unknown"}` });
      continue;
    }
    if ("skip" in parsed) { result.skipped.push({ basis, reason: `anonymizer declined: ${parsed.skip}` }); continue; }
    if ("malformed" in parsed) { result.skipped.push({ basis, reason: `anonymizer answer unusable: ${parsed.malformed}` }); continue; }
    const derivedText = [parsed.draft.title, parsed.draft.message, parsed.draft.deliverable.shape].join("\n");
    const original = [turn.message, turn.previous ?? ""].join("\n");
    const screen = leakScreen(derivedText, original, opts.commonWords);
    if (screen.hard.length > 0) { result.skipped.push({ basis, reason: `refused by the leak screen: carries ${screen.hard.join(", ")}` }); continue; }
    const task = draftToTask(parsed.draft, turn);
    result.derived.push({ task, shared: screen.shared, basis });
    opts.log?.(`derived ${task.id} (${basis})`);
  }
  return result;
}

// ── Inbox and review ────────────────────────────────────────────────────────────────────────────

export const REJECTED_FILE = "rejected.txt";
const SOURCE_RE = /"source"\s*:\s*"turn:([0-9a-f]{16})"/g;

/** The turn digests (16 hex) already in these directories' task files, and the inbox's rejected list. */
export function knownDigests(dirs: readonly string[]): Set<string> {
  const known = new Set<string>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      const path = join(dir, file);
      if (file === REJECTED_FILE) {
        for (const line of readFileSync(path, "utf8").split(/\r?\n/)) if (/^[0-9a-f]{16}$/.test(line.trim())) known.add(line.trim());
        continue;
      }
      if (!file.endsWith(".jsonc") && !file.endsWith(".json")) continue;
      for (const match of readFileSync(path, "utf8").matchAll(SOURCE_RE)) known.add(match[1]!);
    }
  }
  return known;
}

export function writeInboxTask(inboxDir: string, entry: HarvestResult["derived"][number], derivedAt: string): string {
  mkdirSync(inboxDir, { recursive: true });
  const { task, shared, basis } = entry;
  const header = [
    "// Failure-derived lab task, NOT reviewed: the lab ignores it until it is accepted.",
    `// Derived ${derivedAt} from a live turn that failed (${basis}); its content was invented by the lab's local anonymizer.`,
    shared.length > 0
      ? `// Check these words, which the original also used: ${shared.map((w) => `"${w}"`).join(", ")}.`
      : "// The leak screen found nothing, and no rarer word of the original.",
    `// Accept: pnpm harness-lab review --accept ${task.id}    Reject: pnpm harness-lab review --reject ${task.id}`,
  ];
  const file = join(inboxDir, `${task.id}.jsonc`);
  writeFileSync(file, `${header.join("\n")}\n${JSON.stringify(task, null, 2)}\n`, "utf8");
  return file;
}

export interface InboxEntry {
  id: string;
  file: string;
  title: string;
  notes: string[];
}

export function listInbox(inboxDir: string): InboxEntry[] {
  if (!existsSync(inboxDir)) return [];
  return readdirSync(inboxDir).filter((f) => f.endsWith(".jsonc")).sort().map((file) => {
    const text = readFileSync(join(inboxDir, file), "utf8");
    let title = "(unreadable)";
    try { title = String((JSON5.parse(text) as { title?: unknown }).title ?? title); } catch { /* listed as unreadable */ }
    return {
      id: file.replace(/\.jsonc$/, ""),
      file: join(inboxDir, file),
      title,
      notes: text.split(/\r?\n/).filter((line) => line.startsWith("// ")).map((line) => line.slice(3)),
    };
  });
}

function inboxFile(inboxDir: string, id: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) throw new Error(`not a task id: "${id}"`);
  const file = join(inboxDir, `${id}.jsonc`);
  if (!existsSync(file)) throw new Error(`no task ${id} in ${inboxDir}`);
  return file;
}

/** Move an inbox task into the corpus, stamped as reviewed by `by`. */
export function acceptInboxTask(inboxDir: string, tasksDir: string, id: string, by: string, at = new Date().toISOString()): string {
  const file = inboxFile(inboxDir, id);
  const task = HarnessTaskSchema.parse({ ...(JSON5.parse(readFileSync(file, "utf8")) as Record<string, unknown>), reviewed: { by, at } });
  mkdirSync(tasksDir, { recursive: true });
  const target = join(tasksDir, `${id}.jsonc`);
  if (existsSync(target)) throw new Error(`${target} exists already`);
  writeFileSync(target, `// Failure-derived lab task, reviewed by ${by} at ${at}: synthetic content, derived from a live turn that failed.\n${JSON.stringify(task, null, 2)}\n`, "utf8");
  unlinkSync(file);
  return target;
}

/** Drop an inbox task, and remember its turn so a later harvest does not derive it again. */
export function rejectInboxTask(inboxDir: string, id: string): void {
  const file = inboxFile(inboxDir, id);
  const source = [...readFileSync(file, "utf8").matchAll(SOURCE_RE)][0]?.[1];
  if (source) appendFileSync(join(inboxDir, REJECTED_FILE), `${source}\n`, "utf8");
  unlinkSync(file);
}
