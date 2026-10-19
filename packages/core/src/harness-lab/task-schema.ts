/**
 * A harness-lab task: what to ask, and how a run of it is checked. The checks are the E2E suite's
 * turn expectations (e2e/scenario.ts), evaluated in-process (e2e/assertions.ts), so a task imported
 * from a scenario checks exactly what the scenario does.
 *
 * Tasks live as reviewed files under eval/harness-lab/tasks/*.jsonc. Their content is synthetic:
 * one derived from a live turn keeps the turn's shape and invents every name, figure and address,
 * and runs only once someone has reviewed it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import JSON5 from "json5";
import { z } from "zod";
import { TurnExpectationSchema } from "../e2e/scenario.js";

export const LabTurnSchema = z.object({
  message: z.string().min(1),
  /** Pin the turn to an agent, as the dashboard's `--agent` does. */
  agent: z.string().optional(),
  effort: z.enum(["low", "medium", "high", "max"]).optional(),
  timeoutMs: z.number().int().positive().optional(),
  expect: TurnExpectationSchema.optional(),
}).strict();

export const HarnessTaskSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, "lower-case letters, digits, '.', '_' and '-'"),
  title: z.string().min(1),
  origin: z.enum(["e2e", "agent-eval", "failure-derived", "manual"]),
  /** Where it came from: a scenario id, or a digest of the live turn it was derived from. */
  source: z.string().optional(),
  /** Set by the person who checked the task's content; a failure-derived task runs only with it. */
  reviewed: z.object({ by: z.string().min(1), at: z.string().min(1) }).strict().optional(),
  tags: z.array(z.string()).default([]),
  /** Groups tasks for the experience library and for spreading the guard set. */
  domain: z.string().default("general"),
  /** "target": the lab may improve the harness on it; "guard": it only protects against regressions. */
  role: z.enum(["target", "guard", "both"]).default("both"),
  turns: z.array(LabTurnSchema).min(1).max(3),
  /** What a practitioner would hand over, for the editors and the selector. */
  deliverable: z.object({
    kind: z.enum(["answer", "file", "site", "data"]),
    shape: z.string().max(400),
    sources: z.array(z.string()).optional(),
  }).strict().optional(),
  timeoutMs: z.number().int().positive().optional(),
}).strict();

export type HarnessTask = z.infer<typeof HarnessTaskSchema>;
export type LabTurn = z.infer<typeof LabTurnSchema>;

export interface CorpusLoad {
  tasks: HarnessTask[];
  /** Files or tasks left out, and why. */
  skipped: Array<{ file: string; reason: string }>;
}

/**
 * Every task file under `dir` (one task, or an array of them, per file). A failure-derived task
 * without a review is left out; so is a task whose id another file already used.
 */
export function loadCorpus(dir: string): CorpusLoad {
  const tasks: HarnessTask[] = [];
  const skipped: CorpusLoad["skipped"] = [];
  const seen = new Set<string>();
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonc") || f.endsWith(".json")).sort();
  } catch {
    return { tasks, skipped: [{ file: dir, reason: "no task directory" }] };
  }
  for (const file of files) {
    let raw: unknown;
    try {
      raw = JSON5.parse(readFileSync(join(dir, file), "utf8"));
    } catch (err) {
      skipped.push({ file, reason: `unreadable: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    for (const entry of Array.isArray(raw) ? raw : [raw]) {
      const parsed = HarnessTaskSchema.safeParse(entry);
      if (!parsed.success) {
        skipped.push({ file, reason: `invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` });
        continue;
      }
      const task = parsed.data;
      if (seen.has(task.id)) {
        skipped.push({ file, reason: `duplicate id ${task.id}` });
        continue;
      }
      if (task.origin === "failure-derived" && !task.reviewed) {
        skipped.push({ file, reason: `${task.id}: derived from a live turn and not reviewed yet` });
        continue;
      }
      seen.add(task.id);
      tasks.push(task);
    }
  }
  return { tasks, skipped };
}
