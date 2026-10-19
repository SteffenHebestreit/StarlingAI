/**
 * The deterministic score of a lab attempt: what its own record shows, with no model asked.
 * Compared field by field, most important first, so a lab decision rests on a recorded defect
 * before anything is left to the selector.
 */
import type { LabRunRecord } from "./turn-runner.js";

export interface RunScore {
  /** The attempt says nothing about the harness (see LabRunRecord.unscored). */
  unscored: boolean;
  /** Every turn ended ok with a non-empty reply. */
  delivered: boolean;
  /** Checks of the task that failed, over all turns. */
  checksFailed: number;
  /** Turns whose scorecard recorded a defect (learningOutcome "failure"). */
  recordedDefects: number;
}

export function scoreRun(record: LabRunRecord): RunScore {
  return {
    unscored: record.unscored !== undefined,
    delivered: record.turns.length > 0 && record.turns.every((turn) => turn.status === "ok" && turn.reply.trim().length > 0),
    checksFailed: record.turns.reduce((sum, turn) => sum + turn.checkFailures.length, 0),
    recordedDefects: record.turns.filter((turn) => turn.scorecard?.learningOutcome === "failure").length,
  };
}

/** 1 when `a` is better, -1 when `b` is, 0 when the record cannot tell them apart. Unscored runs never compare. */
export function compareScores(a: RunScore, b: RunScore): -1 | 0 | 1 {
  if (a.unscored || b.unscored) return 0;
  if (a.delivered !== b.delivered) return a.delivered ? 1 : -1;
  if (a.checksFailed !== b.checksFailed) return a.checksFailed < b.checksFailed ? 1 : -1;
  if (a.recordedDefects !== b.recordedDefects) return a.recordedDefects < b.recordedDefects ? 1 : -1;
  return 0;
}

/** One number per run for totals: higher is better (delivery outweighs any count of checks). */
export function scoreValue(score: RunScore): number {
  return (score.delivered ? 100 : 0) - score.checksFailed * 2 - score.recordedDefects;
}
