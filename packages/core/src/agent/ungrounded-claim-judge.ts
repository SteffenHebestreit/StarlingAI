/**
 * Semantic ungrounded-claim judge — the prose/named-entity sibling of the structural
 * `looksLikeUnsourcedSpecificClaims` detector (citation-honesty.ts).
 *
 * The structural detector counts fact-SHAPE tokens (numbers+units, currencies, percents,
 * years, dates, codes). It is blind to fabrication that carries NO such tokens: a wrong
 * operator/institution, a mis-stated law, or a confidently-wrong account of how a PARTICULAR
 * real-world system works (audit 57c99128: a tool-free "how does the Danish deposit system
 * work" answer named the wrong operator with zero numbers the counter could see, so the guard
 * never fired). This module lets a cheap routing-tier LLM read the user's question + the
 * assistant's tool-free draft and judge whether the draft asserts SPECIFIC, checkable
 * external-world facts AS IF confirmed — the exact "validate the assumptions" signal the
 * de-lex removed when it hardwired the sourceSensitive routing flag off.
 *
 * Pure + injectable (message-builder + verdict parser), mirroring receptionist.ts so the
 * runtime wiring stays a thin provider call and the judgment logic is unit-testable without a
 * provider. Language-independent — no topic/keyword table; the judge reasons about the draft
 * in whatever language it is written.
 */
import type { LLMMessage } from "../providers/lmstudio.js";

/** Drafts shorter than this are not worth a judge call — a terse reply asserts little, and the
 *  structural tier already has a 400-char floor, so the two tiers share the same eligibility. */
export const UNGROUNDED_JUDGE_MIN_CHARS = 400;

/** How much of the draft the judge reads. A few thousand chars is plenty to see whether the
 *  answer leans on specific external facts; keeps the routing-tier prompt cheap. */
const MAX_DRAFT_CHARS = 4_000;

/**
 * Build the routing-tier judge prompt. The draft was produced WITHOUT any retrieval this turn,
 * so the only question is whether it RELIES on specific external-world facts that a source would
 * be needed to trust. Deliberately conservative wording ("when genuinely unsure → no") so a
 * legitimate general-knowledge / reasoning / user-content answer is not force-delegated; the
 * failure mode this catches is the confidently-specific one, which is unambiguous. Pure.
 */
export function buildUngroundedClaimJudgeMessages(userMessage: string, draft: string): LLMMessage[] {
  const clippedDraft = draft.length > MAX_DRAFT_CHARS ? `${draft.slice(0, MAX_DRAFT_CHARS)}\n…[truncated]` : draft;
  const system = [
    "You are a source-honesty checker inside an AI assistant. You are shown the user's question and the assistant's DRAFT answer.",
    "The draft was written WITHOUT any web search, document lookup, or other tool call this turn — it is purely from the model's memory.",
    "Decide ONE thing: does the draft state SPECIFIC, CHECKABLE claims about the external world AS IF they were established fact — for example a named real organisation / operator / company / product / brand, a concrete price / fee / amount, a rate or statistic, a law or regulation, a date, or the specific mechanism of how a PARTICULAR real-world system, service, or place actually works — the kind of claim that would need a source to trust and could be wrong if recited from memory?",
    "Answer 'yes' if the draft leans on such specific external facts. Answer 'no' if the draft is general knowledge, reasoning, a definition, an opinion, advice, a calculation, code, small talk, or is about content the user themselves provided.",
    "When you are genuinely unsure, answer 'no' — do not over-trigger on ordinary explanations.",
    "Reply with EXACTLY one line and nothing else: 'VERDICT: yes' or 'VERDICT: no'.",
  ].join("\n");
  const user = `User question:\n${userMessage}\n\nAssistant draft answer:\n${clippedDraft}`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/**
 * Build the UP-FRONT source-sensitivity classifier prompt. Unlike the post-draft judge above,
 * this reads ONLY the user's question (no draft yet) and decides whether answering it will require
 * asserting specific external-world facts that should be verified first. A positive verdict lets the
 * runtime set the sourceSensitive signal BEFORE the model drafts, so the turn researches FIRST
 * (requiresDelegatedResearch → suppress the throwaway draft + force orchestration) instead of
 * "answer, then research". Same VERDICT contract, so parseUngroundedClaimVerdict handles the reply.
 * Deliberately conservative ("unsure → no") to avoid force-delegating ordinary general-knowledge
 * turns. Pure / language-independent — no topic keyword table.
 */
export function buildSourceSensitiveQuestionJudgeMessages(userMessage: string): LLMMessage[] {
  const system = [
    "You are a routing classifier inside an AI assistant. You see the user's message BEFORE any answer is written.",
    "Decide ONE thing: to answer this well, would the assistant have to assert SPECIFIC, checkable facts about the external world — a named real organisation / operator / company / product / brand, a concrete price / fee / amount, a rate or statistic, a law or regulation, a date, current or recent events, or exactly how a PARTICULAR real-world system, service, or place actually works — the kind of thing that should be verified against a source rather than recited from memory?",
    "Answer 'yes' if answering depends on such specific external facts (they should be researched first). Answer 'no' for general knowledge, concepts, definitions, reasoning, opinions, advice, maths, code, writing tasks, small talk, or questions about the user's own provided content or about the assistant itself.",
    "When you are genuinely unsure, answer 'no'.",
    "Reply with EXACTLY one line and nothing else: 'VERDICT: yes' or 'VERDICT: no'.",
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: userMessage },
  ];
}

/**
 * Parse the judge reply. Fail-SAFE toward NOT triggering: only an explicit affirmative verdict
 * returns true. A missing/garbled marker, an error echo, or anything ambiguous returns false, so
 * the runtime simply falls back to the structural tier's decision instead of force-delegating a
 * legitimate direct answer on a parse miss. Pure + exported for unit testing.
 */
export function parseUngroundedClaimVerdict(raw: string): boolean {
  const text = (raw ?? "").trim();
  if (!text) return false;
  const marker = text.match(/VERDICT\s*:\s*(yes|no)/i);
  if (marker) return marker[1]!.toLowerCase() === "yes";
  // A small routing model often drops the label and replies in prose ("Yes, because …" / "… so no").
  // Fall back to the LAST standalone yes/no token — models state their conclusion at the END, so a
  // reasoning trail that mentions "no" early but concludes "yes" resolves to the conclusion. This
  // keeps a verbose reply from silently failing to NO (which would drop the signal and let the very
  // draft this guards leak through). A reply with no yes/no token stays false (fail-safe). German
  // ja/nein are honored since the assistant context is often German.
  const tokens = [...text.matchAll(/\b(yes|no|ja|nein)\b/gi)];
  if (tokens.length > 0) {
    const last = tokens[tokens.length - 1]![1]!.toLowerCase();
    return last === "yes" || last === "ja";
  }
  return false;
}
