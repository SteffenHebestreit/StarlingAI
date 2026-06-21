/**
 * Deliverable self-consistency QA — the plan-less complement to the acceptance-criteria
 * QA gates (riskGatedQA / qaDeliveryLoop).
 *
 * Those gates only run when the turn recorded a plan with acceptance criteria, and they
 * check GROUNDING (are claims in the evidence?) and CRITERIA coverage. Neither checks
 * whether the deliverable's own numbers and claims COHERE. A single research delegation
 * that synthesizes a deliverable records no plan, so a self-contradictory answer ships
 * unchecked — e.g. a price quote that recommends 10k for ~10 weeks while itself stating a
 * 90–120 €/h market rate (which implies ~37 €/h); the user had to correct it three times
 * (audit 17f53ed0).
 *
 * This module supplies the consistency-specific CHECK prompt, REPAIR instruction, and the
 * structural trigger; the bounded check→improve loop is the existing pure
 * `runQaDeliveryLoop`, and verdicts reuse `parseQaVerdict`. The check asks only for
 * concrete, objective contradictions (figures, arithmetic, claims that conflict with each
 * other or with what the USER explicitly stated) — never style, completeness, or taste —
 * so it stays topic-agnostic and low on false positives, and the whole gate fails open.
 */
import type { LLMMessage } from "../providers/lmstudio.js";

/** Don't spend a slow-model check on a one-liner; only audit a real synthesized deliverable. */
export const DELIVERABLE_CONSISTENCY_MIN_CHARS = 600;

/** Synthetic criterion fed to runQaDeliveryLoop so it does not bail on an empty criteria set.
 *  The consistency CHECK does the real work; this is only the loop's non-empty guard. */
export const DELIVERABLE_CONSISTENCY_CRITERION =
  "The deliverable is internally consistent (its own figures, quantities, prices, dates and arithmetic agree) and contradicts no fact, figure, or constraint the user explicitly stated.";

/**
 * Structural trigger: fire only on a substantive synthesized deliverable that the
 * acceptance-criteria QA gates did NOT already cover. Keyed on length + whether an
 * acceptance-criteria check ran — not on topic or keywords. Pure for unit testing.
 */
export function shouldCheckDeliverableConsistency(input: {
  enabled: boolean;
  aborted: boolean;
  finalResponse: string;
  /** True when an acceptance-criteria QA (riskGatedQA verify or qaDeliveryLoop) already ran
   *  this turn — those fold a consistency check in, so skip to avoid a redundant slow call. */
  acceptanceCriteriaQaRan: boolean;
  /** Delegations executed this turn. The consistency check targets DELIVERABLES synthesized
   *  from real work; requiring >0 keeps it off long pure-chat answers, refusals, and
   *  multi-question clarifications that happen to exceed the length floor (saves a slow-model
   *  call). The audit case (a synthesized price quote) always delegated research first. */
  delegationCount: number;
}): boolean {
  if (!input.enabled || input.aborted) return false;
  if (input.acceptanceCriteriaQaRan) return false;
  if (input.delegationCount <= 0) return false;
  return input.finalResponse.trim().length >= DELIVERABLE_CONSISTENCY_MIN_CHARS;
}

/**
 * Most-recent user statements, newest-last, capped to `maxChars` (keeps the tail). The
 * consistency check cross-references the deliverable against what the user actually said
 * (their stated figures, durations, constraints). Generic message shape so it stays
 * decoupled from the runtime session type. Pure.
 */
export function collectUserStatements(
  history: ReadonlyArray<{ role: string; content: unknown }>,
  maxChars: number,
): string {
  const texts: string[] = [];
  for (const m of history) {
    if (m.role !== "user") continue;
    const c = typeof m.content === "string" ? m.content.trim() : "";
    if (c) texts.push(c);
  }
  const joined = texts.join("\n---\n");
  return joined.length > maxChars ? joined.slice(joined.length - maxChars) : joined;
}

/** The consistency-check messages for the verdict model. Replies PASS / FAIL: … so the
 *  existing parseQaVerdict consumes it unchanged. */
export function buildDeliverableConsistencyCheckMessages(answer: string, userStatements: string): LLMMessage[] {
  const system =
    "You are a precise consistency auditor. You do NOT rewrite, rate quality, or judge completeness, style, or tone. " +
    "Report ONLY concrete, objective contradictions: figures, quantities, prices, dates, or claims in the DELIVERABLE that conflict with EACH OTHER, " +
    "or that conflict with a specific fact, figure, or constraint the USER explicitly stated. " +
    "If the deliverable does arithmetic (rate × time = total, sums, percentages, discounts), check it actually adds up. " +
    "Do NOT invent facts and do NOT impose external benchmarks the deliverable never claimed. " +
    "Different figures for clearly-labeled different tiers, options, phases, line items, or scenarios are NOT contradictions — only two mutually-exclusive claims about the SAME thing are. " +
    "When a total is broken into line items or phases, verify they SUM correctly rather than treating them as conflicting. " +
    "Read European number formatting correctly (1.000,00 € = one thousand euros; a range like 8.000–12.000 € is ONE range, not two conflicting figures).";
  const user = [
    userStatements.trim()
      ? `USER'S STATED FACTS / CONSTRAINTS (verbatim):\n${userStatements.trim()}`
      : "The user stated no specific figures or constraints to cross-check; audit the deliverable for INTERNAL contradictions only.",
    "",
    "DELIVERABLE TO AUDIT:",
    answer,
    "",
    "Reply on a SINGLE line. If the deliverable is internally consistent and contradicts none of the user's stated facts, reply exactly: PASS",
    "Otherwise reply: FAIL: <one concise sentence per concrete contradiction, naming the conflicting values>.",
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** Repair instruction handed to forceSynthesis when the check found contradictions. */
export function buildDeliverableConsistencyRepairInstruction(flaws: string): string {
  return (
    "CONSISTENCY REVIEW found concrete contradictions in your previous answer — values, arithmetic, or claims that conflict with each other or with what the user explicitly stated:\n" +
    flaws +
    "\nFix ONLY these contradictions so every figure, calculation, and claim is mutually consistent (and consistent with the user's stated facts), in the SAME language as the user's request. " +
    "Recompute any dependent totals. Keep everything else that was already correct. " +
    "Do NOT collapse tiers, options, phases, or line-item breakdowns into a single figure, and do NOT remove caveats, assumptions, or conditional estimates — preserve every legitimate distinction; only reconcile the values that actually conflict. " +
    "Do NOT invent new facts; if resolving a conflict needs a value you do not have, state the assumption explicitly rather than guessing. " +
    "Return the COMPLETE corrected answer (not a diff, not a note)."
  );
}
