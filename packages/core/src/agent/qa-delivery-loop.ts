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
  /** The concrete, verifiable ground the reviewer cited for a PASS (a tool-result
   *  fact, artifact property, probe output). Empty/absent for a bare "PASS" or an
   *  unparseable fail-open pass — the signal that distinguishes an evidence-backed
   *  verdict from a rubber stamp. Consumed only when requireEvidence is on. */
  evidence?: string;
}

/**
 * Parse a QA reviewer's free-text verdict into a structured {@link QaVerdict}.
 * Convention: a standalone `PASS` (with no `FAIL`) passes; a `FAIL: <flaws>` fails
 * with the trailing text as the flaws; anything unparseable fails OPEN (passes) so
 * reviewer noise never blocks delivery. Pure + deterministic so it is unit-tested
 * directly; the runtime's model-backed check is a thin wrapper over a model call + this.
 *
 * Evidence extraction: when the reviewer is asked to justify a PASS, it replies
 * `PASS — evidence: <ground>` (also accepts `PASS (evidence: …)` / `PASS: evidence …`).
 * The trailing ground is captured into `evidence`; a bare `PASS` has none. This is
 * inert unless the caller opts into requireEvidence — a bare PASS still passes.
 */
export function parseQaVerdict(text: string): QaVerdict {
  const trimmed = (text ?? "").trim();
  // A verdict that LEADS with PASS is a pass regardless of any "fail" in its evidence tail —
  // evidence-bearing verdicts ("PASS — evidence: 0 failures", "...the build did not fail") very
  // commonly contain the word. Only when it does NOT lead with PASS do we look for a FAIL token,
  // matched at a WORD BOUNDARY (so "failures"/"failed" inside a garbled reply don't false-fail),
  // still allowing a prefix ("Verdict - FAIL: …"). extractVerdictEvidence pulls the ground.
  if (/^pass\b/i.test(trimmed)) return { pass: true, ...extractVerdictEvidence(trimmed) };
  const failMatch = /\bFAIL\b/i.exec(trimmed);
  // No explicit FAIL → pass. Covers an unparseable/empty verdict (fail open: reviewer noise
  // must never block delivery).
  if (!failMatch) return { pass: true, ...extractVerdictEvidence(trimmed) };
  const flaws = trimmed.slice(failMatch.index).replace(/^FAIL[:\s-]*/i, "").trim();
  return { pass: false, flaws: flaws || "One or more acceptance criteria are unmet." };
}

/** Pull a `PASS — evidence: <ground>` justification out of a passing verdict. Returns
 *  `{ evidence }` only when a non-empty ground is present; `{}` for a bare PASS. Pure. */
function extractVerdictEvidence(passText: string): { evidence?: string } {
  const m = /\bevidence\b\s*[:\-–—]?\s*(.+)$/is.exec(passText);
  // Trim a trailing bracket left by the `PASS (evidence: …)` parenthetical form.
  const ground = m?.[1]?.replace(/\s+/g, " ").replace(/[)\]\s]+$/, "").trim();
  return ground && ground.length >= 3 ? { evidence: ground } : {};
}

/** Whether a passing verdict carries a usable evidence justification. Pure/exported for tests. */
export function verdictHasEvidence(verdict: QaVerdict): boolean {
  return typeof verdict.evidence === "string" && verdict.evidence.trim().length >= 3;
}

export interface QaDeliveryDeps {
  /** Verify an answer against the criteria. Should never throw (treat a thrown
   *  or malformed verdict as a pass so the gate fails open, never blocking). */
  check: (answer: string, criteria: string[]) => Promise<QaVerdict>;
  /** Produce an improved answer addressing the flaws, or null if it could not.
   *  Cheap path: re-synthesise/re-word from evidence already in hand. */
  improve: (answer: string, flaws: string) => Promise<string | null>;
  /** OPTIONAL heavier repair: hand the flaws back to the coordinator to make a plan
   *  and do NEW work (re-research / re-build), not just re-word — the user's "send it
   *  back to the coordinator to make a plan to improve" step. Used only AFTER a cheap
   *  improve() round has already run and the re-check STILL fails: that re-word-didn't-
   *  move-the-verdict outcome is the structural signal the gap needs real work, not a
   *  rewrite (no topic/keyword classification). When absent, the loop is exactly the
   *  cheap improve-only loop. Returns the new answer, or null if it could not. */
  escalate?: (answer: string, flaws: string, criteria: string[]) => Promise<string | null>;
  /** Max improvement rounds (>=1). Each round is one check + one repair call. */
  maxRounds: number;
  /** When true, a PASS that carries no verifiable evidence is not trusted: the answer
   *  still SHIPS (fail-open preserved), but the result is marked `unverified` so the
   *  caller can stamp an honesty caveat instead of presenting it as QA-confirmed. This
   *  kills the rubber-stamp pass (a weak reviewer emitting a bare/parroted "PASS")
   *  without ever blocking delivery. Off by default → exact prior behavior. */
  requireEvidence?: boolean;
}

export interface QaDeliveryResult {
  /** The answer to deliver (improved if any round helped, else the original). */
  answer: string;
  /** Number of improvement passes actually run. */
  rounds: number;
  /** Whether the final answer passed the QA check. */
  passed: boolean;
  /** True if at least one round used the coordinator escalation path. */
  escalated: boolean;
  /** True when the answer ships but its PASS was not backed by verifiable evidence
   *  (only possible under requireEvidence). The answer is still delivered; the caller
   *  should stamp an honesty caveat rather than claim QA confirmation. Always false
   *  when requireEvidence is off. */
  unverified: boolean;
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
    return { answer, rounds: 0, passed: true, escalated: false, unverified: false };
  }

  let current = answer;
  let escalated = false;
  // Set once a cheap improve() round has run without yet passing the re-check. The
  // NEXT failed round then escalates to the coordinator (when provided): re-wording
  // demonstrably didn't fix it, so the gap needs real re-work.
  let cheapImproveExhausted = false;
  for (let round = 0; round < maxRounds; round += 1) {
    let verdict: QaVerdict;
    try {
      verdict = await deps.check(current, criteria);
    } catch {
      // Check failed → fail open, ship the current answer.
      return { answer: current, rounds: round, passed: true, escalated, unverified: false };
    }
    if (verdict.pass) {
      // Evidence gate: a PASS with no verifiable ground is not trusted — ship it, but
      // mark it unverified so the caller stamps a caveat instead of claiming QA passed.
      const unverified = !!deps.requireEvidence && !verdictHasEvidence(verdict);
      return { answer: current, rounds: round, passed: true, escalated, unverified };
    }

    const useEscalate = cheapImproveExhausted && !!deps.escalate;
    let improved: string | null = null;
    try {
      improved = useEscalate
        ? await deps.escalate!(current, verdict.flaws ?? "", criteria)
        : await deps.improve(current, verdict.flaws ?? "");
    } catch {
      improved = null;
    }
    if (useEscalate) escalated = true;
    else cheapImproveExhausted = true;
    // Repair failed or produced nothing usable → stop; ship the best so far.
    if (!improved || !improved.trim()) {
      return { answer: current, rounds: round + 1, passed: false, escalated, unverified: false };
    }
    current = improved;
  }

  // Budget exhausted: ship the last improvement. We deliberately do NOT spend an
  // extra check call to verify it — the answer ships either way, so a final verdict
  // would only refine an audit-only boolean at the cost of one whole slow-model call
  // per turn. Report passed=false (we never got a confirming PASS within budget).
  const finalPass = false;
  return { answer: current, rounds: maxRounds, passed: finalPass, escalated, unverified: false };
}
