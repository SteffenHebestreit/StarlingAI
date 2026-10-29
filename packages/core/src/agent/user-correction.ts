/**
 * The person's next message as feedback on the turn before it (skillLibrary.userCorrectionSignal).
 *
 * A turn's skill outcome is read from its own record (the scorecard), which sees only what the turn
 * itself checked. The clearest verdict on an answer often comes after it: "that's wrong", "I asked
 * for Leiden", "the PDF is blank". When the new message says the previous answer was wrong, missed
 * the request or did not work, that turn's recorded skill successes become failures, and a turn
 * nothing judged (no success recorded under the "verified" evidence rule) records one.
 *
 * Asked beside the new turn, which never waits for it: a decision point (corrects_previous) answered
 * by the routing tier, with the logit readout and Laya measured alongside as for every point. Only
 * the latest turn of a session that recorded skills is remembered, in memory: a restart forgets it,
 * which costs a signal, never a wrong one. The judgement reads the message, not keywords; "Ich hatte
 * Donnerstag gesagt" is a correction with no negation in it.
 */
import { logAudit } from "../audit/logger.js";
import { getConfig } from "../config/loader.js";
import { decideWithReadout } from "../decisions/incumbent-readout.js";
import { CORRECTS_PREVIOUS } from "../decisions/points.js";
import type { ChatProvider } from "../providers/index.js";
import { runWithCallAttribution } from "../runtime/request-context.js";
import { recordSkillHoldoutOutcomeAsync, recordSkillOutcomeAsync, reviseSkillSuccessToFailureAsync } from "../skills/store.js";

/** What a finished turn recorded for its skills, kept until the session's next message. */
export interface LearnedTurn {
  at: number;
  workspacePath: string;
  injectedSkillSlugs: string[];
  heldOutSkillSlugs: string[];
  /** The outcome recorded for those skills, or null when the turn was no evidence under the rule. */
  recorded: "success" | "failure" | null;
  /** The start of the answer, which the judgement compares the next message with. */
  answer: string;
}

const MAX_SESSIONS = 500;
/** A message this long after the answer is about something else: the person came back later. */
export const CORRECTION_MAX_AGE_MS = 6 * 3_600_000;
const ANSWER_CHARS = 1_200;
const MESSAGE_CHARS = 800;

const learned = new Map<string, LearnedTurn>();

/** Remember the session's latest turn that recorded skills; a turn that recorded none forgets the one before. */
export function rememberLearnedTurn(sessionId: string, turn: LearnedTurn | null): void {
  learned.delete(sessionId);
  if (!turn) return;
  learned.set(sessionId, { ...turn, answer: turn.answer.slice(0, ANSWER_CHARS) });
  while (learned.size > MAX_SESSIONS) learned.delete(learned.keys().next().value!);
}

/** The session's remembered turn, once: the next message is the only one that answers it. */
export function takeLearnedTurn(sessionId: string, now = Date.now()): LearnedTurn | undefined {
  const turn = learned.get(sessionId);
  learned.delete(sessionId);
  return turn && now - turn.at <= CORRECTION_MAX_AGE_MS ? turn : undefined;
}

export function resetUserCorrectionForTests(): void {
  learned.clear();
}

export const CORRECTION_JUDGE_SYSTEM = `You read an AI assistant's previous answer and the user's next message. Decide whether the new message says that the previous answer was wrong, incomplete, missed what was asked or did not work: a correction or complaint about it, however politely put, also without a word like "no" or "wrong".
Not a correction: a follow-up that builds on the answer, a new variant asked for on purpose, an answer to a question the assistant asked, a new topic, thanks.
Answer with one word: CORRECTS or CONTINUES.`;

export function correctionJudgeUser(answer: string, message: string): string {
  return `Previous answer:\n${answer.slice(0, ANSWER_CHARS)}\n\nThe user's next message:\n${message.slice(0, MESSAGE_CHARS)}`;
}

/** The verdict in the judge's answer: true for CORRECTS, false for CONTINUES, undefined for neither. */
export function parseCorrectionVerdict(content: string | null | undefined): boolean | undefined {
  const word = /\b(CORRECTS|CONTINUES)\b/i.exec(content ?? "")?.[1]?.toUpperCase();
  return word === "CORRECTS" ? true : word === "CONTINUES" ? false : undefined;
}

/** Whether `message` corrects `answer`, by the corrects_previous point; undefined when nothing judged it. */
export async function judgeCorrection(
  provider: ChatProvider,
  answer: string,
  message: string,
  opts: { sessionId?: string; signal?: AbortSignal } = {},
): Promise<boolean | undefined> {
  const outcome = await decideWithReadout<boolean>({
    point: CORRECTS_PREVIOUS,
    state: { previousAnswer: answer.slice(0, ANSWER_CHARS), message: message.slice(0, MESSAGE_CHARS) },
    languageOf: message,
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    incumbent: async (decisionSignal) => {
      const response = await runWithCallAttribution({ callSite: "routing_tier", agentName: "correction_judge" }, () => provider.complete(
        [{ role: "system", content: CORRECTION_JUDGE_SYSTEM }, { role: "user", content: correctionJudgeUser(answer, message) }],
        [],
        opts.signal ? AbortSignal.any([opts.signal, decisionSignal]) : decisionSignal,
      ));
      return parseCorrectionVerdict(response.content);
    },
    toKey: (corrects) => (corrects ? "corrects" : "continues"),
    fromKey: (key) => key === "corrects",
    readout: { provider, agentName: "correction_judge" },
  });
  return outcome.value;
}

/**
 * What a correction changes: each recorded success becomes a failure; a turn that recorded nothing
 * records a failure. A turn that already recorded a failure is left as it is.
 */
export async function applyCorrection(turn: LearnedTurn): Promise<{ revised: number; recorded: number }> {
  if (turn.recorded === "failure") return { revised: 0, recorded: 0 };
  const writes: Array<Promise<void>> = [];
  for (const slug of turn.injectedSkillSlugs) {
    writes.push(turn.recorded === "success"
      ? reviseSkillSuccessToFailureAsync(turn.workspacePath, slug)
      : recordSkillOutcomeAsync(turn.workspacePath, slug, "failure"));
  }
  for (const slug of turn.heldOutSkillSlugs) {
    writes.push(turn.recorded === "success"
      ? reviseSkillSuccessToFailureAsync(turn.workspacePath, slug, true)
      : recordSkillHoldoutOutcomeAsync(turn.workspacePath, slug, "failure"));
  }
  await Promise.allSettled(writes);
  const count = turn.injectedSkillSlugs.length + turn.heldOutSkillSlugs.length;
  return turn.recorded === "success" ? { revised: count, recorded: 0 } : { revised: 0, recorded: count };
}

/**
 * At the start of a turn: whether this message corrects the session's previous answer, and if so what
 * it changes. Fire-and-forget; the turn never waits for it.
 */
export function checkPreviousTurnCorrection(params: {
  sessionId: string;
  channel: string;
  userMessage: string;
  provider: () => ChatProvider;
}): Promise<void> | undefined {
  if (!getConfig().skillLibrary.userCorrectionSignal || params.channel === "eval") return undefined;
  const turn = takeLearnedTurn(params.sessionId);
  if (!turn || turn.recorded === "failure" || !params.userMessage.trim()) return undefined;
  return (async () => {
    const corrects = await judgeCorrection(params.provider(), turn.answer, params.userMessage, { sessionId: params.sessionId });
    if (corrects !== true) return;
    const changed = await applyCorrection(turn);
    logAudit("user_correction_detected", {
      previousTurnAgeMs: Date.now() - turn.at,
      previousOutcome: turn.recorded ?? "no_evidence",
      skills: turn.injectedSkillSlugs.slice(0, 10),
      heldOutSkills: turn.heldOutSkillSlugs.slice(0, 10),
      ...changed,
    }, { sessionId: params.sessionId, channel: params.channel, severity: "info" });
  })().catch(() => undefined);
}
