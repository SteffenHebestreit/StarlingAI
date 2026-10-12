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
import { IN_REPLY_LANGUAGE } from "./reply-language.js";
import { effectiveMaxDelegatedResultChars } from "../runtime/effort-context.js";

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
  /** What each failing verdict named, in round order; absent when no verdict failed. Recorded so a
   *  turn whose reply is a repair can be read back: the verdict's text was logged nowhere. */
  flaws?: string[];
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
  // Every failing verdict's flaws, on every result from here on: a reply that is a repair cannot
  // be explained without what the repair was asked to fix.
  const failedVerdictFlaws: string[] = [];
  const named = (): { flaws?: string[] } => (failedVerdictFlaws.length > 0 ? { flaws: [...failedVerdictFlaws] } : {});
  for (let round = 0; round < maxRounds; round += 1) {
    let verdict: QaVerdict;
    try {
      verdict = await deps.check(current, criteria);
    } catch {
      // Check failed → fail open, ship the current answer. There is no verdict, so it did not
      // pass: the status is truthfully unverified, and whether that surfaces as a caveat is the
      // strict policy's call.
      return { answer: current, rounds: round, passed: false, status: "unverified", escalated, unverified: deps.strict === true, noVerdict: true, ...named() };
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
        ...named(),
      };
    }

    if (verdict.flaws?.trim()) failedVerdictFlaws.push(verdict.flaws.trim());
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
      return { answer: current, rounds: round + 1, passed: false, status: "fail", escalated, unverified: false, ...named() };
    }
    current = improved;
  }

  // Budget exhausted: ship the last improvement. We deliberately do NOT spend an
  // extra check call to verify it — the answer ships either way, so a final verdict
  // would only refine an audit-only boolean at the cost of one whole slow-model call
  // per turn. Report passed=false (we never got a confirming PASS within budget).
  const finalPass = false;
  return { answer: current, rounds: maxRounds, passed: finalPass, status: "fail", escalated, unverified: false, ...named() };
}

/** How much of one verdict's flaws an audit row keeps. */
const AUDIT_FLAWS_MAX_CHARS = 300;

/**
 * The failing verdicts' flaws as an audit row keeps them: each clipped, the cut marked; nothing when
 * no verdict failed. In E2E core-ix-browser-order-form-express-refused both rounds failed and the
 * reply was a repair, and what the verdicts had asked to fix could not be read back from anywhere.
 * These are the reviewer's sentences about the answer; logAudit's secret scan runs over them as
 * over every string it writes.
 */
export function qaFlawsForAudit(flaws: readonly string[] | undefined): { qaFlaws?: string[] } {
  if (!flaws || flaws.length === 0) return {};
  return { qaFlaws: flaws.map((text) => (text.length > AUDIT_FLAWS_MAX_CHARS ? `${text.slice(0, AUDIT_FLAWS_MAX_CHARS)}…` : text)) };
}

/**
 * How much of its own answer a repair call is handed: the budget a delegated result relayed verbatim
 * gets (performance.maxDelegatedResultChars, effort-scaled; tool-result-format.ts). The answer is the
 * model's own output, written in a turn whose prompts were sized to carry a result that large.
 */
export function answerRepairMaxChars(): number {
  return effectiveMaxDelegatedResultChars();
}

/**
 * Whether a repair call can be handed the whole answer. One asked for the complete answer that saw
 * only its head returns the head, and nothing downstream catches that: the improve step's shrink
 * guard rejects only a stub, and the verification accepts half the length. So a cheap rewrite does
 * not run on an answer that does not fit; the answer ships as it is.
 */
export function answerFitsRepair(current: string, maxChars = answerRepairMaxChars()): boolean {
  return current.length <= maxChars;
}

const REPAIR_ANSWER_LABEL = "Current answer to improve:";
/** The verification is told to return the answer unchanged when it holds, so it is not labelled as one to improve. */
const VERIFY_ANSWER_LABEL = "Your answer:";

/**
 * The answer a "fix your previous answer" call is about, for its instruction: whole up to
 * `maxChars`, and past that the head with the cut marked, so a reader never takes it for all of it.
 *
 * Those calls run through forceSynthesis, which reads the session's history, and the draft is not in
 * it yet: it is added only once the turn ships. So a rewrite saw the flaws and not the answer they
 * were found in, and wrote a new answer from the history. In E2E
 * core-ix-browser-order-form-express-refused every shipped reply was such a rewrite, and one turned
 * the specialist's disclosure (it had changed the shipping option) into "no automatic change was
 * made". The coordinator escalation was the only repair that passed the answer; every repair now
 * passes it the same way.
 */
export function currentAnswerBlock(current: string, label = REPAIR_ANSWER_LABEL, maxChars = answerRepairMaxChars()): string {
  if (current.length <= maxChars) return `\n\n${label}\n${current}`;
  return `\n\n${label}\n${current.slice(0, maxChars)}\n[… ${current.length - maxChars} more characters not shown]`;
}

/**
 * The QA delivery loop's cheap repair: fix the verdict's flaws in the answer it judged. Null when the
 * answer does not fit a repair call (answerFitsRepair): that rewrite is skipped.
 */
export function buildQaImproveInstruction(current: string, flaws: string, maxChars = answerRepairMaxChars()): string | null {
  if (!answerFitsRepair(current, maxChars)) return null;
  return "QA REVIEW found that your previous answer does not yet meet the task's acceptance criteria. "
    + `Fix ONLY these flaws while keeping everything that was already correct, ${IN_REPLY_LANGUAGE}:\n`
    + flaws
    + currentAnswerBlock(current, REPAIR_ANSWER_LABEL, maxChars)
    + "\n\nReturn the COMPLETE corrected answer (not a diff, not a note). Ground every claim in this conversation's tool results and shared findings; do not invent facts to satisfy a criterion — if something genuinely cannot be verified, mark it unverified rather than fabricating it.";
}

/**
 * riskGatedQA's one-shot verification: check the answer against the criteria, repair only a gap.
 * Null when the answer does not fit a repair call (answerFitsRepair): the verification is skipped.
 */
export function buildCriteriaVerifyInstruction(
  current: string,
  criteria: readonly string[],
  maxChars = answerRepairMaxChars(),
): string | null {
  if (!answerFitsRepair(current, maxChars)) return null;
  return "Before finalizing, verify your answer meets ALL of these acceptance criteria for the user's task:\n"
    + criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")
    + currentAnswerBlock(current, VERIFY_ANSWER_LABEL, maxChars)
    + "\n\nIf every criterion is met and every claim is grounded in this conversation's tool results and shared findings, return the SAME answer. "
    + "If a criterion is unmet or a claim is unsupported, return a corrected answer that fixes the gap or transparently marks what could not be verified. Do not add unsupported claims.";
}
