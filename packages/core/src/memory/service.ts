import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readRecentOutcomes } from "../agent/outcomes.js";
import { readFlowMemoryEntries } from "../agent/flow-memory.js";
import { readAllFacts } from "../swarm/memory.js";

const MEMORY_SUBDIR = ".starlingai/memory";
const CONTENT_MERGE_MAX_CHARS = 560;

const TOKEN_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "had",
  "has",
  "have",
  "in",
  "into",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "this",
  "those",
  "to",
  "was",
  "were",
  "with",
]);

export type MemoryScope = "workspace" | "user" | "session" | "agent";
export type MemoryKind = "note" | "fact" | "preference" | "lesson" | "decision" | "summary";
export type MemoryOwnerType = "workspace" | "session" | "agent" | "user";
export type DurableMemoryScope = "workspace" | "user";

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  kind: MemoryKind;
  ownerType: MemoryOwnerType;
  ownerId: string;
  subject: string;
  content: string;
  tags: string[];
  source: string;
  createdAt: string;
  updatedAt: string;
  key?: string;
  score?: number;
}

export interface StoreWorkspaceMemoryInput {
  key: string;
  content: string;
  tags?: string[];
  kind?: MemoryKind;
  subject?: string;
}

export interface SearchMemoryOptions {
  limit?: number;
  scopes?: MemoryScope[];
  kinds?: MemoryKind[];
  sessionId?: string;
  targetAgent?: string;
}

export interface PromoteMemoryResult {
  promoted: MemoryRecord[];
  merged: MemoryRecord[];
  skipped: number;
  destinationScope: DurableMemoryScope;
}

export interface CompactMemoryResult {
  kept: number;
  removed: number;
  merged: number;
  dryRun: boolean;
  scope: DurableMemoryScope;
}

interface StoredWorkspaceMemoryRecord {
  id?: string;
  scope?: MemoryScope;
  kind?: MemoryKind;
  ownerType?: MemoryOwnerType;
  ownerId?: string;
  subject?: string;
  source?: string;
  key: string;
  content: string;
  tags?: string[];
  storedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export function storeWorkspaceMemoryRecord(workspacePath: string, input: StoreWorkspaceMemoryInput): MemoryRecord {
  return storeDurableMemoryRecord("workspace", workspacePath, input);
}

export function storeUserMemoryRecord(workspacePath: string, input: StoreWorkspaceMemoryInput): MemoryRecord {
  return storeDurableMemoryRecord("user", workspacePath, input);
}

export async function searchMemoryRecords(
  workspacePath: string,
  query: string,
  opts: SearchMemoryOptions = {},
): Promise<MemoryRecord[]> {
  const normalizedQuery = query.trim().toLowerCase();
  const tokens = tokenize(normalizedQuery);
  const scopes = new Set<MemoryScope>(opts.scopes?.length ? opts.scopes : ["workspace", "user", "session", "agent"]);
  const allowedKinds = opts.kinds?.length ? new Set(opts.kinds.map((kind) => normalizeKind(kind)).filter(Boolean) as MemoryKind[]) : null;
  const records: MemoryRecord[] = [];

  if (scopes.has("workspace")) {
    records.push(...readWorkspaceMemoryRecords(workspacePath));
  }

  if (scopes.has("user")) {
    records.push(...readUserMemoryRecords(workspacePath));
  }

  if (scopes.has("session") && opts.sessionId) {
    records.push(...await readSessionMemoryRecords(opts.sessionId));
  }

  if (scopes.has("agent")) {
    records.push(...readAgentMemoryRecords(workspacePath, opts.targetAgent));
  }

  const filtered = records.filter((record) => {
    if (allowedKinds && !allowedKinds.has(record.kind)) return false;
    if (!normalizedQuery) return true;
    return scoreRecord(record, normalizedQuery, tokens) > 0;
  });

  return filtered
    .map((record) => ({
      ...record,
      score: scoreRecord(record, normalizedQuery, tokens),
    }))
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0) || right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, Math.max(1, Math.min(50, Math.trunc(opts.limit ?? 10))));
}

export async function formatScopedMemoryGuidance(
  workspacePath: string,
  query: string,
  opts: SearchMemoryOptions & { maxChars?: number } = {},
): Promise<string> {
  const records = await searchMemoryRecords(workspacePath, query, opts);
  if (records.length === 0) return "";

  const maxChars = Math.max(200, Math.min(4_000, Math.trunc(opts.maxChars ?? 1_200)));
  const lines: string[] = [];
  let totalChars = "## Relevant Memory".length + 1;

  for (const record of records) {
    const line = `- [${record.scope}/${record.kind}] ${truncate(record.subject, 120)}: ${truncate(singleLine(record.content), 220)}`;
    if (totalChars + line.length + 1 > maxChars) break;
    lines.push(line);
    totalChars += line.length + 1;
  }

  if (lines.length === 0) return "";
  return ["## Relevant Memory", ...lines].join("\n");
}

export async function promoteMemoryRecords(
  workspacePath: string,
  query: string,
  opts: SearchMemoryOptions & { destinationKind?: MemoryKind; destinationScope?: DurableMemoryScope; maxPromotions?: number } = {},
): Promise<PromoteMemoryResult> {
  const destinationScope = opts.destinationScope ?? "workspace";
  const candidates = await searchMemoryRecords(workspacePath, query, {
    ...opts,
    scopes: opts.scopes?.length
      ? opts.scopes.filter((scope): scope is MemoryScope => scope !== destinationScope)
      : defaultPromotionSourceScopes(destinationScope),
    limit: Math.max(1, Math.min(20, Math.trunc(opts.maxPromotions ?? opts.limit ?? 5))),
  });

  const existing = readDurableMemoryRecords(destinationScope, workspacePath);
  const promoted: MemoryRecord[] = [];
  const merged: MemoryRecord[] = [];
  let skipped = 0;

  for (const candidate of candidates) {
    const duplicate = findDurableMemoryDuplicate(existing, candidate);
    if (duplicate) {
      const updated = storeDurableMemoryRecord(destinationScope, workspacePath, {
        key: duplicate.key ?? safeKey(duplicate.subject),
        subject: duplicate.subject,
        content: mergeRecordContents([duplicate, candidate]),
        tags: normalizeTags([...duplicate.tags, ...candidate.tags, "promoted", `source:${candidate.scope}`]),
        kind: choosePreferredKind(duplicate.kind, opts.destinationKind ?? candidate.kind),
      });
      replaceDurableRecord(existing, updated);
      merged.push(updated);
      continue;
    }

    const created = storeDurableMemoryRecord(destinationScope, workspacePath, {
      key: nextPromotionKey(existing, candidate.subject),
      subject: candidate.subject,
      content: candidate.content,
      tags: normalizeTags([...candidate.tags, "promoted", `source:${candidate.scope}`]),
      kind: choosePreferredKind(opts.destinationKind ?? null, candidate.kind),
    });
    existing.push(created);
    promoted.push(created);
  }

  if (candidates.length === 0) skipped = 0;
  return { promoted, merged, skipped, destinationScope };
}

export function compactWorkspaceMemoryRecords(
  workspacePath: string,
  opts: { dryRun?: boolean } = {},
): CompactMemoryResult {
  return compactDurableMemoryRecords("workspace", workspacePath, opts);
}

export function compactUserMemoryRecords(
  workspacePath: string,
  opts: { dryRun?: boolean } = {},
): CompactMemoryResult {
  return compactDurableMemoryRecords("user", workspacePath, opts);
}

function compactDurableMemoryRecords(
  scope: DurableMemoryScope,
  workspacePath: string,
  opts: { dryRun?: boolean } = {},
): CompactMemoryResult {
  const records = readDurableMemoryRecords(scope, workspacePath);
  const duplicateGroups = groupSimilarWorkspaceRecords(records);

  let removed = 0;
  let merged = 0;

  for (const group of duplicateGroups) {
    if (group.length <= 1) continue;
    merged++;
    removed += group.length - 1;

    if (opts.dryRun) continue;

    const canonical = selectCanonicalRecord(group);
    const combined = group
      .filter((record) => record.id !== canonical.id)
      .reduce((acc, record) => mergeWorkspaceRecords(acc, record), canonical);
    storeDurableMemoryRecord(scope, workspacePath, {
      key: combined.key ?? safeKey(combined.subject),
      subject: combined.subject,
      content: combined.content,
      tags: combined.tags,
      kind: combined.kind,
    });

    for (const record of group) {
      if (record.id === canonical.id) continue;
      if (record.key) {
        rmSync(join(memoryDirForScope(scope, workspacePath), `${record.key}.json`), { force: true });
      }
    }
  }

  return {
    kept: Math.max(0, records.length - removed),
    removed,
    merged,
    dryRun: opts.dryRun === true,
    scope,
  };
}

function readWorkspaceMemoryRecords(workspacePath: string): MemoryRecord[] {
  return readDurableMemoryRecords("workspace", workspacePath);
}

function readUserMemoryRecords(workspacePath: string): MemoryRecord[] {
  return readDurableMemoryRecords("user", workspacePath);
}

function readDurableMemoryRecords(scope: DurableMemoryScope, workspacePath: string): MemoryRecord[] {
  const dir = memoryDirForScope(scope, workspacePath);
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      try {
        return parseStoredWorkspaceMemory(readFileSync(resolve(dir, file), "utf-8"));
      } catch {
        return null;
      }
    })
    .filter((entry): entry is StoredWorkspaceMemoryRecord => entry !== null)
    .map(workspaceStoredToRecord);
}

function storeDurableMemoryRecord(scope: DurableMemoryScope, workspacePath: string, input: StoreWorkspaceMemoryInput): MemoryRecord {
  const dir = ensureDirForScope(scope, workspacePath);
  const key = safeKey(input.key);
  const filePath = join(dir, `${key}.json`);
  const existing = existsSync(filePath)
    ? parseStoredWorkspaceMemory(readFileSync(filePath, "utf-8"))
    : null;
  const now = new Date().toISOString();

  const stored: StoredWorkspaceMemoryRecord = {
    id: existing?.id ?? randomUUID(),
    scope,
    kind: normalizeKind(input.kind) ?? existing?.kind ?? "note",
    ownerType: scope === "user" ? "user" : "workspace",
    ownerId: scope === "user" ? "user" : "workspace",
    subject: (input.subject ?? key).trim() || key,
    source: "memory_store",
    key,
    content: input.content.trim(),
    tags: normalizeTags(input.tags),
    storedAt: existing?.createdAt ?? now,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  writeFileSync(filePath, JSON.stringify(stored, null, 2), "utf-8");
  return workspaceStoredToRecord(stored);
}

async function readSessionMemoryRecords(sessionId: string): Promise<MemoryRecord[]> {
  const facts = await readAllFacts(sessionId);
  const now = new Date().toISOString();
  return Object.entries(facts).map(([key, value]) => ({
    id: `session:${sessionId}:${key}`,
    scope: "session",
    kind: "fact",
    ownerType: "session",
    ownerId: sessionId,
    subject: key,
    content: value,
    tags: ["shared", "session"],
    source: "shared_fact",
    createdAt: now,
    updatedAt: now,
    key,
  }));
}

function readAgentMemoryRecords(workspacePath: string, targetAgent?: string): MemoryRecord[] {
  const records: MemoryRecord[] = [];

  for (const outcome of readRecentOutcomes(workspacePath, 60)) {
    if (targetAgent && outcome.agent !== targetAgent) continue;
    if (!outcome.lesson?.trim()) continue;

    records.push({
      id: `outcome:${outcome.agent}:${outcome.ts}`,
      scope: "agent",
      kind: "lesson",
      ownerType: "agent",
      ownerId: outcome.agent,
      subject: outcome.task || `Lesson for ${outcome.agent}`,
      content: outcome.lesson.trim(),
      tags: ["outcome", outcome.outcome, outcome.agent],
      source: "agent_outcome",
      createdAt: outcome.ts,
      updatedAt: outcome.ts,
    });
  }

  for (const entry of readFlowMemoryEntries(workspacePath, 120)) {
    if (targetAgent && entry.targetAgent !== targetAgent && entry.assistantAgent !== targetAgent) continue;
    records.push({
      id: entry.id,
      scope: "agent",
      kind: entry.outcome === "success" || entry.outcome === "applied" ? "summary" : "lesson",
      ownerType: "agent",
      ownerId: entry.targetAgent ?? entry.assistantAgent ?? "orchestrator",
      subject: entry.summary,
      content: [entry.request, entry.lesson, ...entry.actions].filter(Boolean).join("\n"),
      tags: [...entry.tags, entry.scope, entry.outcome],
      source: "flow_memory",
      createdAt: entry.ts,
      updatedAt: entry.ts,
    });
  }

  return records;
}

function workspaceStoredToRecord(entry: StoredWorkspaceMemoryRecord): MemoryRecord {
  return {
    id: entry.id ?? randomUUID(),
    scope: entry.scope ?? "workspace",
    kind: normalizeKind(entry.kind) ?? "note",
    ownerType: entry.ownerType ?? "workspace",
    ownerId: entry.ownerId ?? "workspace",
    subject: entry.subject?.trim() || entry.key,
    content: entry.content,
    tags: normalizeTags(entry.tags),
    source: entry.source ?? "memory_store",
    createdAt: entry.createdAt ?? entry.storedAt ?? entry.updatedAt ?? new Date().toISOString(),
    updatedAt: entry.updatedAt ?? entry.createdAt ?? entry.storedAt ?? new Date().toISOString(),
    key: entry.key,
  };
}

function parseStoredWorkspaceMemory(raw: string): StoredWorkspaceMemoryRecord | null {
  const parsed = JSON.parse(raw) as Partial<StoredWorkspaceMemoryRecord>;
  if (typeof parsed.key !== "string" || typeof parsed.content !== "string") {
    return null;
  }
  return {
    ...parsed,
    key: parsed.key,
    content: parsed.content,
  };
}

function scoreRecord(record: MemoryRecord, normalizedQuery: string, tokens: string[]): number {
  if (!normalizedQuery) return scopeWeight(record.scope) + recencyBoost(record.updatedAt);

  const subject = record.subject.toLowerCase();
  const content = record.content.toLowerCase();
  const tags = record.tags.map((tag) => tag.toLowerCase());
  const corpus = `${subject}\n${content}\n${tags.join(" ")}\n${record.kind}\n${record.source}`;

  let score = scopeWeight(record.scope) + recencyBoost(record.updatedAt);
  if (corpus.includes(normalizedQuery)) {
    score += 0.7;
  }

  for (const token of tokens) {
    if (subject.includes(token)) score += 0.28;
    else if (tags.some((tag) => tag.includes(token))) score += 0.22;
    else if (content.includes(token)) score += 0.14;
  }

  return score;
}

function scopeWeight(scope: MemoryScope): number {
  switch (scope) {
    case "session":
      return 0.45;
    case "user":
      return 0.34;
    case "workspace":
      return 0.3;
    case "agent":
    default:
      return 0.2;
  }
}

function recencyBoost(value: string): number {
  const ageMs = Math.max(0, Date.now() - Date.parse(value));
  const ageDays = ageMs / 86_400_000;
  return Math.max(0, 0.15 - Math.min(0.15, ageDays * 0.01));
}

function tokenize(value: string): string[] {
  return value
    .split(/[^a-z0-9_]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function normalizeKind(value: unknown): MemoryKind | null {
  switch (String(value ?? "").trim().toLowerCase()) {
    case "note":
    case "fact":
    case "preference":
    case "lesson":
    case "decision":
    case "summary":
      return String(value).trim().toLowerCase() as MemoryKind;
    default:
      return null;
  }
}

function normalizeTags(values: string[] | undefined): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of values ?? []) {
    const tag = String(raw).trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

function memoryDir(workspacePath: string): string {
  return memoryDirForScope("workspace", workspacePath);
}

function memoryDirForScope(scope: DurableMemoryScope, workspacePath: string): string {
  if (scope === "user") {
    const override = process.env["SAI_USER_MEMORY_PATH"]?.trim();
    return override ? resolve(override) : resolve(homedir(), ".starlingai", "user-memory");
  }
  return resolve(workspacePath, MEMORY_SUBDIR);
}

function ensureDir(workspacePath: string): string {
  return ensureDirForScope("workspace", workspacePath);
}

function ensureDirForScope(scope: DurableMemoryScope, workspacePath: string): string {
  const dir = memoryDirForScope(scope, workspacePath);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function safeKey(raw: string): string {
  return raw.trim().replace(/[^a-z0-9_-]/gi, "_").slice(0, 100);
}

function replaceDurableRecord(records: MemoryRecord[], updated: MemoryRecord): void {
  const index = records.findIndex((record) => record.key && updated.key && record.key === updated.key);
  if (index >= 0) {
    records.splice(index, 1, updated);
    return;
  }
  records.push(updated);
}

function findWorkspaceDuplicate(records: MemoryRecord[], candidate: MemoryRecord): MemoryRecord | null {
  return findDurableMemoryDuplicate(records, candidate);
}

function findDurableMemoryDuplicate(records: MemoryRecord[], candidate: MemoryRecord): MemoryRecord | null {
  return records.find((record) => areNearDuplicateRecords(record, candidate)) ?? null;
}

function duplicateFingerprint(record: MemoryRecord): string {
  return `${normalizeForCompare(record.subject)}|${normalizeForCompare(record.content)}`;
}

function normalizeForCompare(value: string): string {
  return singleLine(value).toLowerCase();
}

function nextPromotionKey(records: MemoryRecord[], subject: string): string {
  const base = safeKey(subject) || "memory";
  const keys = new Set(records.map((record) => record.key).filter((value): value is string => Boolean(value)));
  if (!keys.has(base)) return base;
  let index = 2;
  while (keys.has(`${base}_${index}`)) {
    index++;
  }
  return `${base}_${index}`;
}

function defaultPromotionSourceScopes(destinationScope: DurableMemoryScope): MemoryScope[] {
  return destinationScope === "user"
    ? ["workspace", "session", "agent"]
    : ["session", "agent"];
}

function choosePreferredKind(left: MemoryKind | null, right: MemoryKind | null): MemoryKind {
  const rank: Record<MemoryKind, number> = {
    decision: 6,
    preference: 5,
    fact: 4,
    summary: 3,
    lesson: 2,
    note: 1,
  };
  const resolvedLeft = left ?? "note";
  const resolvedRight = right ?? "note";
  return rank[resolvedLeft] >= rank[resolvedRight] ? resolvedLeft : resolvedRight;
}

function mergeWorkspaceRecords(left: MemoryRecord, right: MemoryRecord): MemoryRecord {
  return {
    ...left,
    subject: left.subject.length >= right.subject.length ? left.subject : right.subject,
    content: mergeRecordContents([left, right]),
    tags: normalizeTags([...left.tags, ...right.tags]),
    updatedAt: left.updatedAt >= right.updatedAt ? left.updatedAt : right.updatedAt,
    kind: choosePreferredKind(left.kind, right.kind),
  };
}

function groupSimilarWorkspaceRecords(records: MemoryRecord[]): MemoryRecord[][] {
  const groups: MemoryRecord[][] = [];
  const sorted = records.slice().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  for (const record of sorted) {
    const group = groups.find((candidate) => candidate.some((existing) => areNearDuplicateRecords(existing, record)));
    if (group) {
      group.push(record);
      continue;
    }
    groups.push([record]);
  }

  return groups;
}

function selectCanonicalRecord(records: MemoryRecord[]): MemoryRecord {
  return records
    .slice()
    .sort((left, right) => {
      const seedRankDelta = mergeSeedRank(left) - mergeSeedRank(right);
      if (seedRankDelta !== 0) return seedRankDelta;
      const updatedDelta = right.updatedAt.localeCompare(left.updatedAt);
      if (updatedDelta !== 0) return updatedDelta;
      return (left.key ?? left.subject).localeCompare(right.key ?? right.subject);
    })[0]!;
}

function areNearDuplicateRecords(left: MemoryRecord, right: MemoryRecord): boolean {
  if (left.id === right.id) return true;
  if (duplicateFingerprint(left) === duplicateFingerprint(right)) return true;

  const leftSubject = normalizeForCompare(left.subject);
  const rightSubject = normalizeForCompare(right.subject);
  const leftContent = normalizeForCompare(left.content);
  const rightContent = normalizeForCompare(right.content);

  if (leftContent === rightContent) return true;
  if (leftSubject === rightSubject && (leftContent.includes(rightContent) || rightContent.includes(leftContent))) {
    return true;
  }

  const subjectOverlap = overlapCoefficient(tokenSet(left.subject), tokenSet(right.subject));
  const contentOverlap = overlapCoefficient(tokenSet(left.content), tokenSet(right.content));
  const summaryPair = isSummaryLike(left) || isSummaryLike(right);

  if (leftSubject === rightSubject && contentOverlap >= 0.45) return true;
  if (subjectOverlap >= 0.75 && contentOverlap >= 0.62) return true;
  if (subjectOverlap >= 0.75 && summaryPair && contentOverlap >= 0.38) return true;

  return false;
}

function mergeSeedRank(record: MemoryRecord): number {
  let rank = Math.min(400, singleLine(record.content).length);
  if (record.kind === "summary") rank -= 160;
  if (record.kind === "decision" || record.kind === "preference" || record.kind === "fact") rank -= 30;
  if (isSummaryLike(record)) rank -= 80;
  return rank;
}

function isSummaryLike(record: Pick<MemoryRecord, "kind" | "content">): boolean {
  if (record.kind === "summary") return true;
  const content = singleLine(record.content);
  if (content.length <= 160) return true;
  return splitContentUnits(record.content).length <= 2;
}

function mergeRecordContents(records: MemoryRecord[]): string {
  const [seed, ...rest] = records
    .slice()
    .sort((left, right) => mergeSeedRank(left) - mergeSeedRank(right) || right.updatedAt.localeCompare(left.updatedAt));

  const units: string[] = [];
  const appendUnits = (value: string): void => {
    for (const unit of splitContentUnits(value)) {
      if (units.some((existing) => areNearDuplicateUnits(existing, unit))) continue;
      const next = units.length > 0 ? `${units.join(" ")} ${unit}` : unit;
      if (next.length > CONTENT_MERGE_MAX_CHARS && units.length > 0) continue;
      units.push(unit);
      if (units.join(" ").length >= CONTENT_MERGE_MAX_CHARS) break;
    }
  };

  appendUnits(seed?.content ?? "");
  for (const record of rest.sort((left, right) => right.content.length - left.content.length)) {
    appendUnits(record.content);
  }

  const merged = units.join(" ").trim();
  if (merged) return merged;

  return records
    .slice()
    .sort((left, right) => right.content.length - left.content.length)[0]?.content.trim() ?? "";
}

function splitContentUnits(value: string): string[] {
  const units: string[] = [];
  for (const line of value.split(/\r?\n+/).map((entry) => entry.trim()).filter(Boolean)) {
    const parts = line.split(/(?<=[.!?])\s+/).map((entry) => entry.trim()).filter(Boolean);
    if (parts.length === 0) {
      units.push(singleLine(line));
      continue;
    }
    units.push(...parts.map((entry) => singleLine(entry)).filter(Boolean));
  }
  return units;
}

function areNearDuplicateUnits(left: string, right: string): boolean {
  const normalizedLeft = normalizeForCompare(left);
  const normalizedRight = normalizeForCompare(right);
  if (!normalizedLeft || !normalizedRight) return true;
  if (normalizedLeft === normalizedRight) return true;
  if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) return true;
  return overlapCoefficient(tokenSet(left), tokenSet(right)) >= 0.8;
}

function tokenSet(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9_]+/i)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !TOKEN_STOPWORDS.has(token)),
  );
}

function overlapCoefficient(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap++;
  }
  return overlap / Math.min(left.size, right.size);
}