/**
 * The selector: which of two anonymized outputs of the same task is better, by a fixed order of
 * criteria. Asked twice with A and B swapped; only a verdict that survives the swap counts. Local
 * models pick the first position often enough to make a single call worthless (the report tracks
 * the first-position rate). It runs only where the deterministic score left the two runs tied.
 */
import { extractJsonObject } from "./edit-format.js";
import type { LabComplete } from "./lab-config.js";
import type { HarnessTask } from "./task-schema.js";
import type { LabRunRecord } from "./turn-runner.js";

const REPLY_CHARS = 3_000;

export type PairWinner = "base" | "candidate" | "tie" | "inconsistent";

export interface SelectorVerdict {
  winner: PairWinner;
  /** The raw picks: first with base as A, second with the candidate as A. */
  picks: [Pick, Pick];
}

type Pick = "A" | "B" | "tie" | "none";

const SYSTEM = `You compare two outputs of an AI assistant for the same task. Judge them by these criteria, in this order; the first criterion on which they differ decides:
1. Delivery: everything the task asked for is there, in the form asked for.
2. Conformance: only what was asked, in the requested shape; no unrequested extras.
3. Fidelity: nothing claimed beyond what the task and the work shown support; an invented fact loses.
4. Internal consistency: figures, names and cross-references agree with each other.
5. Operational fitness: the person can use it as delivered.
6. Finish: no placeholders, TODOs or empty required parts.
Length and polish are not merits in themselves. A tie is a valid answer.

Answer with JSON only: {"criterion": "<the deciding criterion>", "winner": "A" | "B" | "tie", "reason": "<at most 200 characters>"}`;

function present(record: LabRunRecord): string {
  const parts: string[] = [];
  for (const [i, turn] of record.turns.entries()) {
    parts.push(`Turn ${i + 1} reply:\n${turn.reply.slice(0, REPLY_CHARS)}${turn.reply.length > REPLY_CHARS ? "\n…" : ""}`);
    if (turn.artifacts.length > 0) parts.push(`Files delivered: ${turn.artifacts.map((a) => a.filename || a.path).join(", ")}`);
  }
  if (record.stubbedCalls.length > 0) parts.push(`Actions it took outside the conversation: ${record.stubbedCalls.map((c) => c.tool).join(", ")}`);
  return parts.join("\n");
}

function parsePick(content: string): Pick {
  const raw = extractJsonObject(content);
  const winner = typeof raw?.["winner"] === "string" ? (raw["winner"] as string).trim().toUpperCase() : "";
  if (winner === "A" || winner === "B") return winner;
  if (winner === "TIE") return "tie";
  return "none";
}

/** Map the two picks (base first as A, then the candidate first as A) to one verdict. */
export function combinePicks(first: Pick, second: Pick): PairWinner {
  const asOwner = (pick: Pick, baseIs: "A" | "B"): PairWinner | null => {
    if (pick === "tie") return "tie";
    if (pick === "none") return null;
    return pick === baseIs ? "base" : "candidate";
  };
  const a = asOwner(first, "A");
  const b = asOwner(second, "B");
  if (a === null || b === null) return "inconsistent";
  return a === b ? a : "inconsistent";
}

export async function selectPair(task: HarnessTask, base: LabRunRecord, candidate: LabRunRecord, complete: LabComplete): Promise<SelectorVerdict> {
  const taskText = task.turns.map((turn, i) => `Turn ${i + 1}: ${turn.message}`).join("\n")
    + (task.deliverable ? `\nExpected: ${task.deliverable.kind}: ${task.deliverable.shape}` : "");
  const ask = (a: LabRunRecord, b: LabRunRecord) =>
    complete("selector", SYSTEM, `## Task\n${taskText}\n\n## Output A\n${present(a)}\n\n## Output B\n${present(b)}`);
  const first = parsePick(await ask(base, candidate));
  const second = parsePick(await ask(candidate, base));
  return { winner: combinePicks(first, second), picks: [first, second] };
}
