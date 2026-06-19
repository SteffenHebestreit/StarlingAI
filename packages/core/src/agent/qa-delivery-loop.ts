/**
 * QA delivery gate with bounded loopback (staged orchestration — the final stage).
 *
 * After the orchestrator produces an answer, a QA check verifies it against the
 * turn plan's acceptance criteria. If it fails, the flaws are handed back for an
 * improvement pass, and the loop repeats — up to `maxRounds` — until the check
 * passes or the budget is exhausted (then the last improvement ships unverified;
 * the gate never blocks delivery and never spends a check call it can't act on).
 * This generalises the existing one-shot riskGatedQA
 * verify-and-repair into the bounded "until the QA agent says it's fine" loop.
 *
 * The core is a pure function with injectable `check` / `improve` so it is fully
 * unit-testable without a provider; the runtime supplies model-backed versions.
 * Gated by orchestration.qaDeliveryLoop (default off; pass^k before default-on)
 * because every round costs extra LLM calls on a slow local model.
 */

export interface QaVerdict {
  /** True when the answer satisfies the acceptance criteria. */
  pass: boolean;
  /** Concrete flaws to fix, when pass=false (fed to the improvement pass). */
  flaws?: string;
}

/**
 * Parse a QA reviewer's free-text verdict into a structured {@link QaVerdict}.
 * Convention: a standalone `PASS` (with no `FAIL`) passes; a `FAIL: <flaws>` fails
 * with the trailing text as the flaws; anything unparseable fails OPEN (passes) so
 * reviewer noise never blocks delivery. Pure + deterministic so it is unit-tested
 * directly; the runtime's model-backed check is a thin wrapper over a model call + this.
 */
export function parseQaVerdict(text: string): QaVerdict {
  const trimmed = (text ?? "").trim();
  const failIdx = trimmed.toUpperCase().indexOf("FAIL");
  // No explicit FAIL → pass. This covers a clean "PASS" AND an unparseable/empty
  // verdict (fail open: reviewer noise must never block delivery).
  if (failIdx === -1) return { pass: true };
  const flaws = trimmed.slice(failIdx).replace(/^FAIL[:\s-]*/i, "").trim();
  return { pass: false, flaws: flaws || "One or more acceptance criteria are unmet." };
}

export interface QaDeliveryDeps {
  /** Verify an answer against the criteria. Should never throw (treat a thrown
   *  or malformed verdict as a pass so the gate fails open, never blocking). */
  check: (answer: string, criteria: string[]) => Promise<QaVerdict>;
  /** Produce an improved answer addressing the flaws, or null if it could not. */
  improve: (answer: string, flaws: string) => Promise<string | null>;
  /** Max improvement rounds (>=1). Each round is one check + one improve call. */
  maxRounds: number;
}

export interface QaDeliveryResult {
  /** The answer to deliver (improved if any round helped, else the original). */
  answer: string;
  /** Number of improvement passes actually run. */
  rounds: number;
  /** Whether the final answer passed the QA check. */
  passed: boolean;
}

/**
 * Run the bounded QA → improve loop. Fails OPEN: with no criteria, an error, or a
 * failed/empty improvement, it returns the best answer so far rather than blocking.
 */
export async function runQaDeliveryLoop(
  answer: string,
  criteria: string[],
  deps: QaDeliveryDeps,
): Promise<QaDeliveryResult> {
  const maxRounds = Math.max(1, Math.floor(deps.maxRounds));
  // No acceptance criteria → nothing to check against; ship as-is.
  if (!criteria || criteria.length === 0 || !answer.trim()) {
    return { answer, rounds: 0, passed: true };
  }

  let current = answer;
  for (let round = 0; round < maxRounds; round += 1) {
    let verdict: QaVerdict;
    try {
      verdict = await deps.check(current, criteria);
    } catch {
      // Check failed → fail open, ship the current answer.
      return { answer: current, rounds: round, passed: true };
    }
    if (verdict.pass) {
      return { answer: current, rounds: round, passed: true };
    }

    let improved: string | null = null;
    try {
      improved = await deps.improve(current, verdict.flaws ?? "");
    } catch {
      improved = null;
    }
    // Improvement failed or produced nothing usable → stop; ship the best so far.
    if (!improved || !improved.trim()) {
      return { answer: current, rounds: round + 1, passed: false };
    }
    current = improved;
  }

  // Budget exhausted: ship the last improvement. We deliberately do NOT spend an
  // extra check call to verify it — the answer ships either way, so a final verdict
  // would only refine an audit-only boolean at the cost of one whole slow-model call
  // per turn. Report passed=false (we never got a confirming PASS within budget).
  const finalPass = false;
  return { answer: current, rounds: maxRounds, passed: finalPass };
}
