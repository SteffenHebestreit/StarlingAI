/**
 * The lab's experience library (Harness²'s second recursion): what each task taught about
 * improving the harness, as at most one entry per task, carried from run to run. The editors of a
 * later run see its index as examples, never as facts about their task: an edit that uses an entry
 * must name it and still cite a moment of its own run.
 *
 * An entry's verdict is set from what the run showed once the gate had decided (finalVerdict):
 * "helped" only for edits the gate accepted, "hurt" when the candidate lost pairs or a guard,
 * "confounded" when the run could not tell. Stored under the deployment's state directory
 * (harness-lab/library/entries.jsonl), with an INDEX.md beside it for a person.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspaceStateDir } from "../tools/workspace-state.js";
import type { GateDecision } from "./gate.js";
import { compareScores } from "./scoring.js";
import type { TaskWork } from "./cycle.js";

export type EntryVerdict = "helped" | "hurt" | "no effect" | "confounded";

export interface ExperienceEntry {
  id: string;
  ts: string;
  runId: string;
  taskId: string;
  domain: string;
  /** The shape of situation the lesson applies to, never the task's facts. */
  cue: string;
  /** The harness component the lesson concerns: "main_assistant", a sub-agent, or "skills". */
  component: string;
  lesson: string;
  /** The rows of the run the lesson rests on. */
  evidence: string[];
  confidence: "high" | "medium" | "low";
  verdict: EntryVerdict;
}

const INDEX_MAX_CHARS = 3_000;

export function libraryDir(liveWorkspacePath: string): string {
  return join(workspaceStateDir(liveWorkspacePath), "harness-lab", "library");
}

export function readEntries(dir: string): ExperienceEntry[] {
  const file = join(dir, "entries.jsonl");
  if (!existsSync(file)) return [];
  const entries: ExperienceEntry[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as ExperienceEntry);
    } catch {
      // A torn line is skipped, not fatal: the rest of the library still reads.
    }
  }
  return entries;
}

/** Append entries (ids assigned in order, L1, L2, …) and rewrite the index. */
export function appendEntries(dir: string, entries: Array<Omit<ExperienceEntry, "id" | "ts">>): ExperienceEntry[] {
  mkdirSync(dir, { recursive: true });
  const existing = readEntries(dir);
  let next = existing.reduce((max, e) => Math.max(max, Number(e.id.slice(1)) || 0), 0);
  const written: ExperienceEntry[] = entries.map((entry) => ({ ...entry, id: `L${(next += 1)}`, ts: new Date().toISOString() }));
  if (written.length > 0) appendFileSync(join(dir, "entries.jsonl"), written.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  writeFileSync(join(dir, "INDEX.md"), `# Harness lab experience\n\n${renderIndex([...existing, ...written], {}, Infinity)}\n`, "utf8");
  return written;
}

/**
 * The index the editors see: one line per entry, the task's own domain first, newest first, cut at
 * INDEX_MAX_CHARS.
 */
export function renderIndex(entries: readonly ExperienceEntry[], opts: { domain?: string }, maxChars = INDEX_MAX_CHARS): string {
  const ordered = [...entries].sort((a, b) => {
    const domain = Number(b.domain === opts.domain) - Number(a.domain === opts.domain);
    return domain !== 0 ? domain : b.ts.localeCompare(a.ts);
  });
  const lines: string[] = [];
  let used = 0;
  for (const e of ordered) {
    const line = `${e.id} [${e.verdict}, ${e.confidence}] (${e.component}) when ${e.cue} → ${e.lesson}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

/** What the run showed about a task's edits, once the gate decided (or there was no gate). */
export function finalVerdict(work: TaskWork, gate: GateDecision | undefined): EntryVerdict {
  const lost = work.pairs.some((pair) => !pair.base.unscored && !pair.candidate.unscored && compareScores(pair.candidate, pair.base) < 0);
  const unscored = work.pairs.length > 0 && work.pairs.every((pair) => pair.base.unscored || pair.candidate.unscored);
  if (unscored || work.references.every((r) => r.unscored !== undefined)) return "confounded";
  if (work.outcome !== "win") return lost ? "hurt" : "no effect";
  if (!gate) return "no effect";
  if (gate.verdict === "accept") return "helped";
  if (gate.verdict === "no_verdict") return "confounded";
  return gate.tallies.some((t) => t.role === "guard" && t.losses > t.wins) ? "hurt" : "no effect";
}
