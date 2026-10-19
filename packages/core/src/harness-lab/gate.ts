/**
 * The global gate. A lab edit goes into a prompt every turn reads, so a candidate is accepted only
 * when it wins on the tasks it was made for (targets) and does not lose on others (the guard set).
 * Every comparison is paired: base and candidate on the same task and attempt, interleaved.
 * Deterministic results decide; the selector counts only where they tie, and only consistently.
 */
import { signTestPValue } from "../e2e/stats.js";
import { compareScores, type RunScore } from "./scoring.js";
import type { PairWinner } from "./selector.js";

export interface PairedAttempt {
  base: RunScore;
  candidate: RunScore;
  /** Set where the deterministic score tied and the selector was asked. */
  selector?: PairWinner;
}

export interface GateTaskResult {
  taskId: string;
  role: "target" | "guard";
  attempts: PairedAttempt[];
}

export interface TaskTally {
  taskId: string;
  role: "target" | "guard";
  wins: number;
  losses: number;
  ties: number;
  unscored: number;
  selectorWins: number;
  selectorLosses: number;
}

export interface GateDecision {
  verdict: "accept" | "reject" | "no_verdict";
  evidence: "deterministic" | "selector-only" | "none";
  reasons: string[];
  tallies: TaskTally[];
  unscoredRate: number;
  /** One-sided sign test (candidate better) over every scored, decided pair: reported, never deciding. */
  signTestP: number | null;
}

export interface GateOptions {
  /** Above this share of unscored pairs the run is no verdict. */
  maxUnscoredRate: number;
  /** A guard task losing this many more pairs than it wins rejects the candidate. */
  guardTaskLossMargin: number;
  /** All guard tasks together may lose at most this many more pairs than they win. */
  guardTotalLossMargin: number;
  /** Targets together must win at least this many more pairs than they lose (deterministic evidence). */
  targetWinMargin: number;
  /** Selector-only evidence: share of target pairs the selector must win consistently, with no loss. */
  selectorWinShare: number;
}

export const DEFAULT_GATE: GateOptions = {
  maxUnscoredRate: 0.2,
  guardTaskLossMargin: 2,
  guardTotalLossMargin: 1,
  targetWinMargin: 2,
  selectorWinShare: 0.6,
};

export function tallyTask(result: GateTaskResult): TaskTally {
  const tally: TaskTally = { taskId: result.taskId, role: result.role, wins: 0, losses: 0, ties: 0, unscored: 0, selectorWins: 0, selectorLosses: 0 };
  for (const pair of result.attempts) {
    if (pair.base.unscored || pair.candidate.unscored) {
      tally.unscored += 1;
      continue;
    }
    const cmp = compareScores(pair.candidate, pair.base);
    if (cmp > 0) tally.wins += 1;
    else if (cmp < 0) tally.losses += 1;
    else {
      tally.ties += 1;
      if (pair.selector === "candidate") tally.selectorWins += 1;
      if (pair.selector === "base") tally.selectorLosses += 1;
    }
  }
  return tally;
}

export function gateDecision(results: readonly GateTaskResult[], opts: GateOptions = DEFAULT_GATE): GateDecision {
  const tallies = results.map(tallyTask);
  const pairs = results.reduce((sum, r) => sum + r.attempts.length, 0);
  const unscored = tallies.reduce((sum, t) => sum + t.unscored, 0);
  const unscoredRate = pairs === 0 ? 1 : unscored / pairs;
  const wins = tallies.reduce((sum, t) => sum + t.wins, 0);
  const losses = tallies.reduce((sum, t) => sum + t.losses, 0);
  const signTestP = wins + losses > 0 ? signTestPValue(wins, wins + losses) : null;
  const base = { tallies, unscoredRate, signTestP };

  if (pairs === 0 || unscoredRate > opts.maxUnscoredRate) {
    return { ...base, verdict: "no_verdict", evidence: "none", reasons: [`${unscored} of ${pairs} pairs could not be scored (limit ${Math.round(opts.maxUnscoredRate * 100)}%)`] };
  }

  const reasons: string[] = [];
  const guards = tallies.filter((t) => t.role === "guard");
  const targets = tallies.filter((t) => t.role === "target");
  for (const guard of guards) {
    if (guard.losses - guard.wins >= opts.guardTaskLossMargin) reasons.push(`guard ${guard.taskId} lost ${guard.losses} of its pairs against ${guard.wins} won`);
  }
  const guardNet = guards.reduce((sum, t) => sum + t.losses - t.wins, 0);
  if (guardNet > opts.guardTotalLossMargin) reasons.push(`the guard set lost ${guardNet} more pairs than it won (limit ${opts.guardTotalLossMargin})`);
  const regressedTarget = targets.find((t) => t.losses > t.wins);
  if (regressedTarget) reasons.push(`target ${regressedTarget.taskId} got worse (${regressedTarget.losses} lost, ${regressedTarget.wins} won)`);
  if (reasons.length > 0) return { ...base, verdict: "reject", evidence: "none", reasons };

  const targetNet = targets.reduce((sum, t) => sum + t.wins - t.losses, 0);
  if (targetNet >= opts.targetWinMargin) {
    return { ...base, verdict: "accept", evidence: "deterministic", reasons: [`targets won ${targetNet} more pairs than they lost; no guard regressed`] };
  }
  const targetPairs = targets.reduce((sum, t) => sum + t.wins + t.losses + t.ties, 0);
  const decided = targets.reduce((sum, t) => sum + t.wins + t.losses, 0);
  const selectorWins = targets.reduce((sum, t) => sum + t.selectorWins, 0);
  const selectorLosses = targets.reduce((sum, t) => sum + t.selectorLosses, 0);
  if (decided === 0 && targetPairs > 0 && selectorLosses === 0 && selectorWins / targetPairs >= opts.selectorWinShare) {
    return {
      ...base,
      verdict: "accept",
      evidence: "selector-only",
      reasons: [`checks tied on every target pair; the selector preferred the candidate consistently in ${selectorWins} of ${targetPairs}, never the base`],
    };
  }
  return { ...base, verdict: "reject", evidence: "none", reasons: [`no target improvement beyond noise (net ${targetNet}, selector ${selectorWins}:${selectorLosses} of ${targetPairs} pairs)`] };
}
