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

export type QaVerdictStatus = "pass" | "fail" | "unverified";

export interface QaVerdict {
  /**
   * Canonical QA outcome. A parser-produced verdict always sets this field.
   * It remains optional only so existing injected check implementations that
   * return `{ pass }` continue to work while they migrate to the tri-state contract.
   */
  status?: QaVerdictStatus;
  /**
   * Legacy control-flow signal. `unverified` deliberately keeps this true so
   * delivery fails open; callers must use `status` to claim QA verification.
   */
  pass: boolean;
  /** Concrete flaws to fix, when pass=false (fed to the improvement pass). */
  flaws?: string;
  /** The concrete, verifiable ground the reviewer cited for a PASS (a tool-result
   *  fact, artifact property, probe output). Empty/absent for a bare "PASS" or an
   *  unparseable fail-open pass — the signal that distinguishes an evidence-backed
   *  verdict from a rubber stamp. Consumed only when requireEvidence is on. */
  evidence?: string;
  /** The reviewer gave NO verdict: an empty reply, or text carrying neither PASS nor FAIL.
   *  Distinct from a bare PASS, which is a verdict without its evidence. The thinking-on 35B
   *  sometimes spent ~600 tokens reasoning and then returned empty content (owner-measured
   *  2026-09-25). `pass` stays true so delivery fails open; the loop must still not record
   *  it as a pass. */
  noVerdict?: boolean;
}

/**
 * Parse a QA reviewer's free-text verdict into a structured {@link QaVerdict}.
 * Convention: only `PASS — evidence: <ground>` is verified; a `FAIL: <flaws>` fails
 * with the trailing text as the flaws; bare or malformed output is `unverified`.
 * `unverified` retains `pass: true` so reviewer noise never blocks delivery, but it
 * can never be surfaced as QA-confirmed. Pure + deterministic so it is unit-tested
 * directly; the runtime's model-backed check is a thin wrapper over a model call + this.
 *
 * Evidence extraction: when the reviewer is asked to justify a PASS, it replies
 * `PASS — evidence: <ground>` (also accepts `PASS (evidence: …)` / `PASS: evidence …`).
 * The trailing ground is captured into `evidence`; a bare `PASS` has none. This is
 * A bare or malformed PASS remains deliverable but is never a verified QA result.
 */
export function parseQaVerdict(text: string): QaVerdict {
  const trimmed = (text ?? "").trim();
  // A leading PASS is never overridden by "fail" in evidence text: valid evidence often
  // says "0 failures" or "did not fail". Without strict evidence it is unverified,
  // rather than a verified pass.
  const lead = leadingVerdict(trimmed);
  if (/^pass\b/i.test(lead)) {
    const evidence = extractVerdictEvidence(lead);
    return evidence.evidence
      ? { status: "pass", pass: true, ...evidence }
      : { status: "unverified", pass: true };
  }
  const failMatch = /\bFAIL\b/i.exec(trimmed);
  // No verdict word at all means reviewer noise, malformed output or nothing. Fail open for
  // delivery, but never let it certify the answer — and mark it as no verdict, so the loop does
  // not record it as a pass. A PASS further in is a verdict still, only not a verified one.
  if (!failMatch) return { status: "unverified", pass: true, ...(/\bPASS\b/i.test(trimmed) ? {} : { noVerdict: true }) };
  // Emphasis hugging the word and any dash after it go too: `**FAIL**: no chart` kept "**: no chart".
  const flaws = trimmed.slice(failMatch.index).replace(/^FAIL[*_`]*[:\s\-–—]*/i, "").trim();
  return { status: "fail", pass: false, flaws: flaws || "One or more acceptance criteria are unmet." };
}

/**
 * The verdict as written, without what a reviewer puts around it: leading marks and emoji, one
 * leading "<word>:" label, and emphasis or backticks hugging the verdict word. With reasoning off
 * the reviewer formats more, and `**PASS** — evidence: …`, `Verdict: PASS …` or `✅ PASS` read as
 * no verdict at all, which inflated the no-verdict rate the change was meant to measure (review of
 * the thinking-off verdicts, R1). Structural: no list of label words, in any language.
 */
function leadingVerdict(text: string): string {
  let lead = text.replace(/^[^\p{L}\p{N}]+/u, "");
  lead = lead.replace(/^\p{L}+\s*:\s*(?=[^\p{L}\p{N}]*(?:pass|fail)\b)/iu, "").replace(/^[^\p{L}\p{N}]+/u, "");
  return lead.replace(/^(pass|fail)[*_`]+/i, "$1");
}

/** Pull a `PASS — evidence: <ground>` justification out of a passing verdict. Returns
 *  `{ evidence }` only when a non-empty ground is present; `{}` for a bare PASS. Pure. */
function extractVerdictEvidence(passText: string): { evidence?: string } {
  const m = /^pass\s*(?:[—–-]\s*|:\s*|\(\s*)evidence\s*:\s*(.+?)\s*\)?$/is.exec(passText);
  // Trim a trailing bracket left by the `PASS (evidence: …)` parenthetical form.
  const ground = m?.[1]?.replace(/\s+/g, " ").replace(/[)\]\s]+$/, "").trim();
  return ground && ground.length >= 3 ? { evidence: ground } : {};
}

/** Whether a passing verdict carries a usable evidence justification. Pure/exported for tests. */
export function verdictHasEvidence(verdict: QaVerdict): boolean {
  return typeof verdict.evidence === "string" && verdict.evidence.trim().length >= 3;
}

/** Resolve legacy injected verdicts into the canonical tri-state contract. */
export function resolveQaVerdictStatus(verdict: QaVerdict): QaVerdictStatus {
  if (verdict.status) return verdict.status;
  if (!verdict.pass) return "fail";
  return verdictHasEvidence(verdict) ? "pass" : "unverified";
}

export interface QaDeliveryDeps {
  /** Verify an answer against the criteria. A thrown or malformed verdict never
   *  blocks delivery: the answer ships, marked `unverified` under strict mode
   *  (legacy mode ships it uncaveated as before). */
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
  /** Strict tri-state surfacing (orchestration.qaStrictVerdicts, QPR-002). When true, an
   *  `unverified` verdict — bare PASS, malformed reviewer output, or a thrown check —
   *  sets `unverified: true` on the result so the caller stamps a caveat. When false
   *  (legacy), those ship uncaveated exactly as before the tri-state contract; the
   *  truthful `status` is still reported either way for scorecards/telemetry. */
  strict?: boolean;
}

/**
 * Whether the reviewer must be ASKED to ground its PASS in a concrete fact.
 *
 * Three flags demand it, and the third is the one that was missing. `qaEvidenceRequired` asks
 * for it directly. `qaToolJudge` implies it, because an uninspected bare PASS from a judge that
 * never opened the artifact is exactly the rubber stamp the judge exists to prevent. And
 * `qaStrictVerdicts` implies it most sharply of all: strict's whole contract is that a PASS
 * carrying no verifiable evidence is not trusted — so a strict deployment that never REQUESTS
 * evidence instructs its reviewer to "reply exactly: PASS", then downgrades that bare PASS to
 * `unverified` and caveats the answer. Every pass. The caveat becomes a constant, and a constant
 * warning is indistinguishable from no warning at all.
 *
 * Measured live (2026-09-08, same prompt, 4 runs per arm): strict alone caveated 3 of 4, every
 * one `status=unverified, rounds=0`; strict with the request caveated 0 of 4 — two evidence-backed
 * passes and one true FAIL that repaired a fabricated release into an honest gap.
 */
export function qaRequiresEvidence(flags: {
  requireEvidence?: boolean;
  qaToolJudge?: boolean;
  qaStrictVerdicts?: boolean;
}): boolean {
  return flags.requireEvidence === true || flags.qaToolJudge === true || flags.qaStrictVerdicts === true;
}

export interface QaDeliveryResult {
  /** The answer to deliver (improved if any round helped, else the original). */
  answer: string;
  /** Number of improvement passes actually run. */
  rounds: number;
  /** Whether the final answer passed the QA check. False when the reviewer gave no verdict
   *  (see noVerdict): an answer nobody judged did not pass, whatever ships. */
  passed: boolean;
  /** Canonical final QA state. `unverified` is delivered but must not be called verified. */
  status: QaVerdictStatus;
  /** Concrete ground from an evidence-backed PASS, when the reviewer supplied one. */
  evidence?: string;
  /** True if at least one round used the coordinator escalation path. */
  escalated: boolean;
  /** The last check produced no verdict — an empty or unparseable reply, or a thrown check.
   *  The answer ships (fail-open) with status `unverified` and `passed` false. */
  noVerdict?: boolean;
  /** True when the shipped answer must NOT be presented as QA-confirmed: its verdict
   *  was not an evidence-backed PASS. Under `strict` this covers a bare PASS, malformed
   *  reviewer output, and a thrown check; under legacy mode it is set only when
   *  `requireEvidence` demanded evidence and none was supplied. The answer is still
   *  delivered either way — this flag only selects the honesty caveat. The truthful
   *  tri-state `status` is reported independently of this policy flag. */
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
    return { answer, rounds: 0, passed: true, status: "unverified", escalated: false, unverified: false };
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
      // Check failed → fail open, ship the current answer. There is no verdict, so it did not
      // pass: the status is truthfully unverified, and whether that surfaces as a caveat is the
      // strict policy's call.
      return { answer: current, rounds: round, passed: false, status: "unverified", escalated, unverified: deps.strict === true, noVerdict: true };
    }
    if (verdict.pass) {
      // An empty or unparseable reply keeps pass:true so delivery fails open, but nobody judged
      // the answer: it is recorded as no verdict, never as a pass.
      const noVerdict = verdict.noVerdict === true;
      const status = resolveQaVerdictStatus(verdict);
      // The tri-state status is always the parser truth (for scorecards/telemetry).
      // The `unverified` caveat is policy: strict mode surfaces every non-evidence-
      // backed PASS; legacy mode only when requireEvidence explicitly demanded it.
      const unverified = (deps.strict === true && status === "unverified")
        || (!!deps.requireEvidence && !verdictHasEvidence(verdict));
      const evidence = verdictHasEvidence(verdict) ? verdict.evidence!.trim() : undefined;
      return {
        answer: current,
        rounds: round,
        passed: !noVerdict,
        status: unverified || noVerdict ? "unverified" : status,
        ...(evidence ? { evidence } : {}),
        escalated,
        unverified,
        ...(noVerdict ? { noVerdict: true } : {}),
      };
    }

    const useEscalate = cheapImproveExhausted && !!deps.escalate;
    let improved: string | null;
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
      return { answer: current, rounds: round + 1, passed: false, status: "fail", escalated, unverified: false };
    }
    current = improved;
  }

  // Budget exhausted: ship the last improvement. We deliberately do NOT spend an
  // extra check call to verify it — the answer ships either way, so a final verdict
  // would only refine an audit-only boolean at the cost of one whole slow-model call
  // per turn. Report passed=false (we never got a confirming PASS within budget).
  const finalPass = false;
  return { answer: current, rounds: maxRounds, passed: finalPass, status: "fail", escalated, unverified: false };
}
