/**
 * The user's own words, carried to a delegated specialist next to the orchestrator's task.
 *
 * A specialist starts from `task` and `context`, and both are the orchestrator's paraphrase. When
 * the paraphrase leaves out an explicit constraint, nothing downstream can recover it: in session
 * f4ebf47b the user wrote "nicht den fast-tier", the delegated task said nothing about the tier,
 * and image_creator rendered on the fast tier again. The specialist's own tool guidance ("choose
 * 'quality' ONLY when the user explicitly asked") depends on words it could not see.
 *
 * So the words a person actually typed this turn ride along, bounded and never translated, and
 * stay OUT of `task`: routing, the reuse signature, the language normalizer and the audit preview
 * all key on `task`, and none of them should change because of this.
 */
import { defangFramingMarkers } from "../guardrails/framing-markers.js";

/** What the user typed this turn: the message that opened it, then anything added while it ran. */
export interface TurnUserWords {
  opening: string;
  midTurn: string[];
}

/** Long pastes keep their head and tail; the middle is the part least likely to hold the ask. */
const OPENING_MAX_CHARS = 1_200;
const MID_TURN_MAX_CHARS = 400;
/** Only the latest additions: an older one has usually been superseded by a newer one. */
const MID_TURN_MAX_ENTRIES = 3;

// Deliberately NOT "Original user request:". runtime-utils.ts reads that phrase as a delegation
// task echoed back into an answer, and this block is a different thing.
const LABEL = "[USER'S OWN WORDS — this turn, verbatim, untranslated]";
const GUIDANCE =
  "The task above is the orchestrator's summary. Your assignment is still the task; use these words to honour any "
  + "explicit instruction or constraint the user stated that applies to your part (e.g. a model, quality tier, format, "
  + "language, something to avoid). Where the summary and the user's words disagree on such a constraint, follow the "
  + "user's words. Do not repeat this block.";

function clipMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.round((maxChars * 2) / 3);
  const tail = maxChars - head;
  return `${text.slice(0, head)}…(${text.length - head - tail} chars omitted)…${text.slice(text.length - tail)}`;
}

function normalizeForContainment(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The words specialists are told the user typed, from a chat entry point that received the typed
 * text separately from the message (the web chat's displayContent). That field is supplied by the
 * client and the input guardrail and moderation run on the message alone, so the typed text is
 * trusted only when the checked message contains it; otherwise the checked message is used.
 */
export function typedUserWords(checkedMessage: string, typed: string | undefined): string {
  const text = typed?.trim() ?? "";
  return text && checkedMessage.includes(text) ? text : checkedMessage;
}

/**
 * The user's words as lines another prompt can quote: clipped, framing markers defanged, mid-turn
 * additions marked. `isNew` drops a part the reader already has; by default only empty parts go.
 * Shared, so every prompt that quotes the user bounds and defangs the words the same way.
 */
export function userWordsLines(
  words: TurnUserWords | undefined,
  isNew: (part: string) => boolean = (part) => part.length > 0,
): string[] {
  if (!words) return [];
  const opening = words.opening.trim();
  const lines: string[] = [];
  if (isNew(opening)) lines.push(defangFramingMarkers(clipMiddle(opening, OPENING_MAX_CHARS)));
  for (const entry of words.midTurn.slice(-MID_TURN_MAX_ENTRIES)) {
    const trimmed = entry.trim();
    if (isNew(trimmed)) lines.push(`(added mid-turn) ${defangFramingMarkers(clipMiddle(trimmed, MID_TURN_MAX_CHARS))}`);
  }
  return lines;
}

/**
 * The block appended to a specialist's first message, or "" when there is nothing to add.
 *
 * A part the task or context already quotes is dropped, so a task that embeds the request itself
 * (the source-sensitive frames do) does not carry it twice. `alreadyCarried` is what the
 * specialist will see anyway: its task and its context.
 */
export function renderUserWordsBlock(words: TurnUserWords | undefined, alreadyCarried: string): string {
  if (!words) return "";
  const carried = normalizeForContainment(alreadyCarried);
  const lines = userWordsLines(words, (part) => {
    const normalized = normalizeForContainment(part);
    return normalized.length > 0 && !carried.includes(normalized);
  });
  if (lines.length === 0) return "";
  return `\n\n${LABEL}\n${GUIDANCE}\n${lines.join("\n")}`;
}

/**
 * The block for one specialist run. An A2A bridge agent forwards its task to another instance, so
 * the user's words are kept off it: they never leave this instance unless someone sends them.
 */
export function userWordsBlockForRun(
  agentDomain: string | undefined,
  words: TurnUserWords | undefined,
  task: string,
  context: string | undefined,
): string {
  if (agentDomain === "a2a") return "";
  return renderUserWordsBlock(words, `${task}\n${context ?? ""}`);
}
