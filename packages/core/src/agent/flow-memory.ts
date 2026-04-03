import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { childLogger } from "../logger.js";

const log = childLogger("agent:flow-memory");

const FLOW_MEMORY_FILE = ".starlingai/flow_memory.ndjson";
const MAX_ACTIONS = 8;
const MAX_TAGS = 10;

export type FlowMemoryScope = "setup" | "enhancement" | "prompt" | "workflow";
export type FlowMemoryOutcome = "proposed" | "applied" | "success" | "failure" | "partial" | "rejected";

export interface FlowMemoryEntry {
  id: string;
  ts: string;
  scope: FlowMemoryScope;
  request: string;
  summary: string;
  assistantAgent?: string;
  targetAgent?: string;
  actions: string[];
  outcome: FlowMemoryOutcome;
  lesson?: string;
  tags: string[];
}

export interface FlowMemoryMatch extends FlowMemoryEntry {
  score: number;
}

export function appendFlowMemoryEntry(
  workspacePath: string,
  entry: Omit<FlowMemoryEntry, "id" | "ts" | "actions" | "tags"> & {
    id?: string;
    ts?: string;
    actions?: string[];
    tags?: string[];
  },
): FlowMemoryEntry {
  const normalized: FlowMemoryEntry = {
    id: entry.id ?? randomUUID(),
    ts: entry.ts ?? new Date().toISOString(),
    scope: entry.scope,
    request: entry.request.trim().slice(0, 4000),
    summary: entry.summary.trim().slice(0, 1200),
    assistantAgent: entry.assistantAgent?.trim() || undefined,
    targetAgent: entry.targetAgent?.trim() || undefined,
    actions: normalizeList(entry.actions, MAX_ACTIONS, 240),
    outcome: entry.outcome,
    lesson: entry.lesson?.trim().slice(0, 800) || undefined,
    tags: normalizeList(entry.tags, MAX_TAGS, 48),
  };

  try {
    const dir = resolve(workspacePath, ".starlingai");
    mkdirSync(dir, { recursive: true });
    appendFileSync(resolve(workspacePath, FLOW_MEMORY_FILE), `${JSON.stringify(normalized)}\n`, "utf-8");
  } catch (err) {
    log.warn({ err }, "Failed to persist flow memory entry");
  }

  return normalized;
}

export function readFlowMemoryEntries(workspacePath: string, limit = 100): FlowMemoryEntry[] {
  const file = resolve(workspacePath, FLOW_MEMORY_FILE);
  if (!existsSync(file)) return [];

  try {
    return readFileSync(file, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as FlowMemoryEntry;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is FlowMemoryEntry => entry !== null)
      .slice(-limit);
  } catch (err) {
    log.warn({ err }, "Failed to read flow memory entries");
    return [];
  }
}

export function searchFlowMemory(
  workspacePath: string,
  query: string,
  opts: {
    limit?: number;
    targetAgent?: string;
    assistantAgent?: string;
    outcomes?: FlowMemoryOutcome[];
  } = {},
): FlowMemoryMatch[] {
  const entries = readFlowMemoryEntries(workspacePath, 200);
  if (entries.length === 0) return [];

  const normalizedQuery = query.trim();
  const queryTokens = tokenize(normalizedQuery);
  const filtered = entries.filter((entry) => {
    if (opts.targetAgent && entry.targetAgent !== opts.targetAgent) return false;
    if (opts.assistantAgent && entry.assistantAgent !== opts.assistantAgent) return false;
    if (opts.outcomes && opts.outcomes.length > 0 && !opts.outcomes.includes(entry.outcome)) return false;
    return true;
  });

  const ranked = filtered
    .map((entry) => ({
      ...entry,
      score: scoreEntry(entry, normalizedQuery, queryTokens),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || right.ts.localeCompare(left.ts));

  const limit = Math.max(1, Math.min(8, opts.limit ?? 4));
  if (ranked.length > 0) return ranked.slice(0, limit);

  if (queryTokens.size > 0) return [];

  return filtered
    .map((entry) => ({ ...entry, score: recencyBoost(entry.ts) + outcomeWeight(entry.outcome) }))
    .sort((left, right) => right.score - left.score || right.ts.localeCompare(left.ts))
    .slice(0, limit);
}

export function formatFlowMemoryGuidance(
  workspacePath: string,
  query: string,
  opts: {
    limit?: number;
    targetAgent?: string;
    assistantAgent?: string;
  } = {},
): string {
  const matches = searchFlowMemory(workspacePath, query, {
    limit: opts.limit,
    targetAgent: opts.targetAgent,
    assistantAgent: opts.assistantAgent,
  });

  if (matches.length === 0) return "";

  const lines = matches.map((entry) => {
    const label = entry.outcome === "failure" || entry.outcome === "rejected"
      ? "Avoid"
      : entry.outcome === "partial"
        ? "Watch"
        : "Prefer";
    const actions = entry.actions.length > 0 ? ` Actions: ${entry.actions.join("; ")}.` : "";
    const lesson = entry.lesson ? ` Lesson: ${entry.lesson}.` : "";
    const agentHint = entry.targetAgent ? ` [target=${entry.targetAgent}]` : "";
    return `- ${label}${agentHint}: ${entry.summary}.${actions}${lesson}`;
  });

  return ["## Learned Flow Guidance", ...lines].join("\n");
}

function normalizeList(values: string[] | undefined, limit: number, itemMax: number): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of values ?? []) {
    const value = raw.trim().slice(0, itemMax);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(value);
    if (normalized.length >= limit) break;
  }
  return normalized;
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9_]+/i)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3),
  );
}

function scoreEntry(entry: FlowMemoryEntry, rawQuery: string, queryTokens: Set<string>): number {
  const corpus = [
    entry.request,
    entry.summary,
    entry.lesson ?? "",
    entry.assistantAgent ?? "",
    entry.targetAgent ?? "",
    ...entry.actions,
    ...entry.tags,
  ].join(" \n ").toLowerCase();

  let score = outcomeWeight(entry.outcome) + recencyBoost(entry.ts);
  if (!rawQuery) return score;

  if (corpus.includes(rawQuery.toLowerCase())) score += 0.6;
  for (const token of queryTokens) {
    if (corpus.includes(token)) score += 0.12;
  }

  return score;
}

function recencyBoost(ts: string): number {
  const ageMs = Math.max(0, Date.now() - Date.parse(ts));
  const ageDays = ageMs / 86_400_000;
  return Math.max(0, 0.2 - Math.min(0.2, ageDays * 0.01));
}

function outcomeWeight(outcome: FlowMemoryOutcome): number {
  switch (outcome) {
    case "success":
      return 0.45;
    case "applied":
      return 0.3;
    case "partial":
      return 0.18;
    case "failure":
      return 0.15;
    case "rejected":
      return 0.08;
    case "proposed":
    default:
      return 0.05;
  }
}