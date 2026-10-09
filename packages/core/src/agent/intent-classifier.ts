/**
 * Turn Intent Classifier
 *
 * The runtime calls `buildDynamicTurnGuidance()` and
 * `buildLanguageAndIdentityTurnGuidance()` from here rather than resolving them
 * inline, keeping the runtime file focused on the execution loop.
 *
 * De-lexicalized (cleanup/lean-base): the topic/keyword/language routing-intent
 * tables were removed. Routing/intent is decided by the swarm from the agent
 * roster + tools + the LLM's semantic read, in any language — NOT from keyword
 * tables here. What remains is STRUCTURAL/format detection (a present URL,
 * substantial pasted technical content) and durable-MEMORY persistence
 * (assistant naming / lasting preferences). No new keyword/phrase/regex routing
 * matching may be added here.
 *
 * No LLM calls are made here — all classification is deterministic, fast,
 * and side-effect-free.
 */

import { getConfig } from "../config/loader.js";
import { loadMainAssistantPersonality } from "../personality/service.js";
import type { MainAssistantToolMode } from "./default-tools.js";
import { PRODUCT } from "../product/index.js";
import { buildTurnReplyLanguageInstruction, type TurnReplyLanguageOptions } from "./reply-language.js";

// ── Intent term / pattern tables ─────────────────────────────────────────────
//
// De-lexicalization (cleanup/lean-base): the routing/intent keyword tables that
// derived freshness/source/mail/computer/server/pentest/swarm/user-own-facts
// flags from topic words have been deleted. Routing/intent is now decided by the
// swarm from the agent roster + tools + the LLM's semantic read, in any language —
// not by keyword matching here. The remaining tables are STRUCTURAL/format
// signals (inline pasted technical content, an actionable URL) or durable-MEMORY
// persistence (assistant naming / lasting preferences), not topic routing.

// PRODUCT_RECOMMENDATION_PATTERNS (a bilingual product/component-recommendation keyword table)
// was DELETED in the de-lexicalization: it fed only the now-deleted, dead
// isBroadSourceSensitiveAdvisoryRequest scorer. Product/deliverable fit is decided by the
// swarm (roster + tools + the LLM's semantic read), never a core keyword table here.

// ── Inline-content analytical detection ──────────────────────────────────────
// When a user pastes substantial technical content inline (configs, code,
// command output) AND asks for explanation/tutorial/analysis of THAT content,
// the right path is direct synthesis — NOT delegating to a specialist to fetch
// or inspect live data the user already provided.  The classic failure mode
// (debug session 7b90ea2c, May 2026) was: user pastes a complete WireGuard
// config plus pfSense settings and asks for a tutorial; runtime delegates to
// shell_agent to inspect the live system; the container crashes; user sees a
// generic "please try again" placeholder instead of the tutorial that could
// have been written from the inline content alone.

/** Patterns that indicate the user pasted technical state inline. */
export const INLINE_TECHNICAL_CONTENT_PATTERNS = [
  /```[\s\S]{40,}?```/,                              // fenced code block with content
  /(?:^|\n)\s*(?:root|admin|user)?@?[\w.-]*[:#$>]\s+\S/, // shell prompt + command
  /(?:^|\n)\s*\[[\w-]+\][^\n]*\n[^\n]*=\s*\S/,        // INI-style section + key=value
  /\b(?:postup|postdown|allowedips|listenport|publickey|privatekey|persistentkeepalive)\s*=/i, // WireGuard
  /\b(?:server\s*\{|location\s+[/\w]+\s*\{|upstream\s+\w+\s*\{)/i,  // nginx blocks
  /\b(?:\[Service\]|\[Install\]|\[Unit\])\s*\n[\w]+=/,            // systemd unit
  /\b(?:apiVersion|kind|metadata|spec):\s*\S/,                    // k8s YAML
  /(?:^|\n)\s*\w[\w-]*\s*=\s*\S+(?:\n\s*\w[\w-]*\s*=\s*\S+){4,}/, // 5+ key=value lines
];

/** Detect substantial pasted technical content. Each pattern is strict
 *  enough on its own (a fenced code block requires 40+ chars of body, a
 *  multi-line key=value block requires 5+ pairs, etc.) that any match
 *  represents real pasted state.  A small message-length floor of 200
 *  chars filters out single-line "the error was: foo=bar" cases that
 *  the user is just describing rather than pasting wholesale. This is a
 *  language-free FORMAT signal (kept after de-lexicalization): it tells the
 *  model to answer from pasted content rather than re-fetch the same state. */
export function hasSubstantialInlineTechnicalContent(message: string): boolean {
  if (message.length < 200) return false;
  return INLINE_TECHNICAL_CONTENT_PATTERNS.some((pattern) => pattern.test(message));
}

// The WORKFLOW_* keyword tables (hint terms / action terms / deliverable-hint terms /
// explicit-request regexes) were DELETED in the de-lexicalization: they were always-on
// topic-keyword tables matched against raw user text every turn and mis-routed. Workflow
// catalog routing is now OPT-IN only (scene/job author-declared triggers) — see
// workflow-catalog-routing.ts. An explicit "run the X workflow" request is handled by the
// LLM through the always-available search_workflows/run_workflow tools, not a core regex.

// (Removed: WORKFLOW_DISCOVERY_STOP_WORDS.) The previous workflow-catalog detector
// scored token overlap between the user message and a concatenated scene/job
// blob, requiring an ever-growing stop-word list to suppress noise (German
// pronouns, infra config keys, shell command names, ...). The new detector in
// runtime.ts uses opt-in regex triggers per scene/job, so the noise-token
// suppression list is no longer needed.

// ── Durable-memory persistence detection ─────────────────────────────────────
// Statements that establish something meant to OUTLIVE this session — naming
// the assistant, lasting preferences, standing instructions. Models tend to
// acknowledge such turns conversationally and persist nothing until the user
// adds an explicit "remember that" (observed live: "dein Name ist ab jetzt
// Luna" → name acknowledged but not stored until told to remember it). These
// patterns trigger guidance to persist in the SAME turn.
const ASSISTANT_NAMING_PATTERNS: readonly RegExp[] = [
  /\bdein name (?:ist|sei|lautet|wird)\b/,
  /\bdu hei(?:ß|ss)t (?:ab )?(?:jetzt|sofort|nun)\b/,
  // Verb-subject inversion: "Ab jetzt heißt du Luna" (the most common phrasing —
  // previously unmatched, so the turn only got generic durable-memory guidance).
  /\bhei(?:ß|ss)t du\b/,
  /\bich (?:nenne|taufe) dich\b/,
  /\b(?:werde|will) dich .{1,40}? nennen\b/,
  /\byour name is(?: now)?\b/,
  /\bi(?:'ll| will) call you\b/,
  /\byou are (?:now )?called\b/,
  // "ab jetzt bist du Luna" / "du bist (jetzt) Luna" — the German "you ARE X"
  // rename form (audit a6668324: `ab jetzt bist du "Luna"` was acknowledged but
  // never persisted). Broad here, but harmless: assistantNamingSensitive AND the
  // deterministic persist both gate on extractAssistantName, which requires a
  // QUOTED name for this form (German capitalizes every noun, so an unquoted
  // "du bist Entwickler" must NOT read as a rename).
  /\bbist du\b/,
  /\bdu bist\b/,
];

// Capturing variants used to extract the actual name for deterministic
// persistence (see extractAssistantName). Each captures the name token in $1.
// Global so every occurrence is judged: "Heißt du Claude? Nein — ab jetzt heißt
// du Luna." must reject the question and still find the statement.
// `nameEndsClause`: the verb is ambiguous ("call you" is also a phone call), so
// the name must end its clause — "I will call you Monday about the contract"
// names nobody (verified 2026-10-05: it renamed the assistant "Monday").
const ASSISTANT_NAMING_CAPTURE_PATTERNS: ReadonlyArray<{ re: RegExp; nameEndsClause?: boolean }> = [
  { re: /\bhei(?:ß|ss)t\s+du(?:\s+(?:ab|jetzt|sofort|nun))*\s+["“”'»]?\s*([\p{L}][\p{L}\p{M}\d_-]{1,39})/giu },
  { re: /\bdu\s+hei(?:ß|ss)t(?:\s+(?:ab|jetzt|sofort|nun))*\s+["“”'»]?\s*([\p{L}][\p{L}\p{M}\d_-]{1,39})/giu },
  { re: /\bdein\s+name\s+(?:ist|sei|lautet|wird)(?:\s+(?:ab|jetzt|nun))*\s+["“”'»]?\s*([\p{L}][\p{L}\p{M}\d_-]{1,39})/giu },
  { re: /\b(?:nenne|taufe)\s+dich(?:\s+ab\s+jetzt)?\s+["“”'»]?\s*([\p{L}][\p{L}\p{M}\d_-]{1,39})/giu },
  { re: /\byour\s+name\s+is(?:\s+now)?\s+["“”'«]?\s*([\p{L}][\p{L}\p{M}\d_-]{1,39})/giu },
  { re: /\bi(?:'ll|\s+will)\s+call\s+you\s+["“”'«]?\s*([\p{L}][\p{L}\p{M}\d_-]{1,39})/giu, nameEndsClause: true },
  { re: /\byou\s+are\s+(?:now\s+)?called\s+["“”'«]?\s*([\p{L}][\p{L}\p{M}\d_-]{1,39})/giu },
  // "ab jetzt bist du \"Luna\"" / "du bist (jetzt) \"Luna\"" — QUOTE REQUIRED.
  // Unlike "heißt du X" (where the verb unambiguously introduces a name), German
  // "du bist X" + noun-capitalization is ambiguous, so only an explicitly quoted
  // name counts as a rename here.
  { re: /\b(?:du\s+)?bist\s+(?:du\s+)?(?:ab\s+|jetzt\s+|sofort\s+|nun\s+)*["“”'«»]\s*([\p{L}][\p{L}\p{M}\d_-]{1,39})/giu },
];

// ── Is the naming clause an unambiguous STATEMENT? (verified misfires 2026-10-05) ──
// The name is persisted for good, so it is taken only from a plain naming statement.
// Three shapes looked like one and renamed the assistant permanently:
//   "Heißt du Claude?"                                          → a question
//   "In der Geschichte heißt du Robin, und du bist ein Ritter." → a story frame
//   "I will call you Monday about the contract."               → a phone call
// The checks below read STRUCTURE — sentence punctuation, quote parity, word order, what
// stands before and after the name. Where a word decides, it comes from a CLOSED class
// (temporal scope, discourse glue, tag questions, weekdays/months, fiction frames and
// third-person reporting verbs), never from the topic of the message.

// A colon does NOT end the sentence: "Er sagte: du heißt Max" keeps its frame.
const NAMING_SENTENCE_END_RE = /[.!?\n]/;
// Boundaries INSIDE a sentence that close a lead segment: "Übrigens: …", "Hey Claude, …",
// "Perfekt – …", "Nein — …", "Na gut - …".
const LEAD_SEGMENT_BOUNDARY_RE = /[:,–—]|\s-\s/u;
// Double-quote marks of every convention. Single quotes are left out: they double as the
// apostrophe ("I'll", "geht's"), so their parity says nothing.
const DOUBLE_QUOTE_MARKS_RE = /["“”„«»]/g;
// Quote marks that may open a quoted NAME right after the naming verb.
const NAME_OPENING_QUOTE_RE = /["“”„'‚‘’«»]$/u;
// The only words that may stand DIRECTLY before the naming clause (after the last boundary):
// temporal scope ("ab jetzt", "von nun an", "in Zukunft", "ab morgen", "from now on"),
// discourse glue ("also", "dann", "okay", "and", "so", "bitte") and the speaker as subject
// ("ich", "I"). Anything else there — "In der Geschichte", "Im Spiel", "In this story",
// "I know" — scopes the name to a frame or a belief, which is not a rename of the assistant.
const UNFRAMED_LEAD_WORDS = new Set([
  "ab", "von", "an", "seit", "jetzt", "nun", "sofort", "heute", "morgen", "übermorgen", "in", "zukunft",
  "künftig", "kuenftig", "zukünftig", "zukuenftig", "also", "dann", "und", "okay", "ok",
  "gut", "so", "ja", "nein", "doch", "bitte", "ich", "wir",
  "from", "now", "on", "going", "forward", "starting", "today", "tomorrow", "henceforth", "then",
  "and", "well", "alright", "please", "yes", "no", "i", "we",
  // The speaker's own decision ("I have decided your name is Nova", "Ich habe beschlossen …") —
  // a belief ("I know/think your name is Claude") stays out.
  "have", "decided", "hereby", "declare", "habe", "hab", "beschlossen", "entschieden", "hiermit",
]);
// A frame that scopes a name to fiction, a game or someone else's words: genre/frame nouns
// and third-person reporting verbs. Tested on every lead segment that ends in a boundary and on
// every EARLIER sentence of the message ("Write a story. Your name is Robin …").
const NAMING_FRAME_MARKER_RE = /(?<![\p{L}])(?:story|stories|tale|tales|novel|game|games|role-?play|roleplay|scene|script|character|pretend|imagine|fiction|geschichte|geschichten|erzählung|märchen|roman|spiel|spielen|rollenspiel|szene|hörspiel|theaterstück|theater|figur|rolle|stell\s+dir\s+vor|tu\s+so|says|said|told|tells|thinks|thought|believes|claims|claimed|wrote|writes|meint|meinte|sagt|sagte|gesagt|erzählt|erzählte|behauptet|behauptete|glaubt|glaubte|denkt|dachte|schreibt|schrieb|geschrieben)(?![\p{L}])/iu;
// A lasting scope makes the sentence a declaration even with a tag question after it.
const NAMING_SCOPE_MARKER_RE = /(?<![\p{L}])(?:ab\s+(?:jetzt|sofort|heute|morgen)|von\s+(?:nun|jetzt|heute)\s+an|in\s+zukunft|k(?:ü|ue)nftig|zuk(?:ü|ue)nftig|from\s+now\s+on|going\s+forward|henceforth|starting\s+(?:now|today|tomorrow)|from\s+(?:today|tomorrow)(?:\s+on)?)(?![\p{L}])/iu;
// Tag questions after a comma/dash that closes the naming statement. An AGREEMENT tag asks
// the assistant to accept the declaration ("…, okay?") — still a rename. A CONFIRMATION tag asks
// whether a belief is true ("Your name is Claude, right?") — a question, unless the sentence
// carries a lasting scope ("Ab jetzt heißt du Max, oder?").
const AGREEMENT_TAGS = new Set([
  "okay", "ok", "alright", "all right", "got it", "understood", "deal", "fine", "cool", "good", "agreed",
  "sounds good", "is that ok", "is that okay", "einverstanden", "in ordnung", "passt das", "passt", "klar",
  "alles klar", "verstanden", "gut", "geht das", "ist das ok", "ist das okay",
]);
const CONFIRMATION_TAGS = new Set([
  "right", "correct", "isn't it", "isnt it", "is it", "aren't you", "don't you", "no", "oder", "nicht wahr",
  "stimmt's", "stimmts", "stimmt das", "stimmt", "richtig", "ja", "gell", "ne", "nicht",
]);
const TAG_QUESTION_MAX_WORDS = 4;
// What may follow a "call you <Name>" in its clause: nothing, or a lasting-scope marker
// ("I'll call you Luna from now on").
const NAME_CLAUSE_TAIL_OK_RE = /^(?:from now on|going forward|henceforth|starting (?:now|today)|ab (?:jetzt|sofort|heute)|von nun an|in zukunft|k(?:ü|ue|u)nftig|zuk(?:ü|ue|u)nftig)?$/u;
// "I'll call you Monday" is a phone call: weekdays, months and time words are not a name
// after "call you" unless quoted.
const CALL_YOU_TIME_WORDS = new Set([
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
  "tomorrow", "tonight", "today", "later", "soon", "asap", "noon", "midnight", "morning", "evening",
]);

const lettersOnly = (value: string): string =>
  value.replace(/[^\p{L}\s'’]/gu, " ").replace(/\s+/gu, " ").trim().toLowerCase();

/** Whether the naming match at `matchStart`..`nameEnd` is a plain, unframed statement. */
function isUnframedNamingStatement(
  text: string,
  matchStart: number,
  matchText: string,
  nameEnd: number,
  nameEndsClause: boolean,
): boolean {
  // Inside quoted speech: an odd number of double-quote marks before the match.
  if ((text.slice(0, matchStart).match(DOUBLE_QUOTE_MARKS_RE) ?? []).length % 2 === 1) return false;

  // The sentence it sits in.
  let sentenceStart = 0;
  for (let i = matchStart - 1; i >= 0; i -= 1) {
    if (NAMING_SENTENCE_END_RE.test(text[i]!)) { sentenceStart = i + 1; break; }
  }
  const after = text.slice(nameEnd);
  const endOffset = after.search(NAMING_SENTENCE_END_RE);
  const sentenceRest = endOffset >= 0 ? after.slice(0, endOffset) : after;
  const scoped = NAMING_SCOPE_MARKER_RE.test(text.slice(sentenceStart, nameEnd + sentenceRest.length));

  // Not a question — except a short tag question that closes the statement (see AGREEMENT_TAGS).
  const tailMatch = /(?:[,–—]|\s-\s)([^,–—]*)$/u.exec(sentenceRest);
  const tail = tailMatch ? lettersOnly(tailMatch[1]!) : "";
  if (endOffset >= 0 && after[endOffset] === "?") {
    if (!tailMatch || !tail || tail.split(" ").length > TAG_QUESTION_MAX_WORDS) return false;
    if (!AGREEMENT_TAGS.has(tail) && !scoped) return false;
  } else if (tailMatch && CONFIRMATION_TAGS.has(tail) && !scoped) {
    return false; // "Your name is Claude, isn't it" without its question mark
  }

  const lead = text.slice(sentenceStart, matchStart).trim();
  // German verb-first ("Heißt du Claude", "Bist du \"Luna\"") is a yes/no question even
  // without its question mark; a statement puts something before the verb ("Ab jetzt heißt du").
  if (!lead && /^(?:hei(?:ß|ss)t|bist)\s+du\b/iu.test(matchText)) return false;
  // Lead segments closed by a boundary ("Übrigens:", "Hallo mein lieber Assistent,", "Perfekt –")
  // may hold anything but a frame; the segment directly before the naming clause holds only
  // closed-class unframing words.
  const segments = lead.split(LEAD_SEGMENT_BOUNDARY_RE);
  const directLead = segments.pop() ?? "";
  if (lettersOnly(directLead).split(" ").filter(Boolean).some((word) => !UNFRAMED_LEAD_WORDS.has(word))) return false;
  if (segments.some((segment) => NAMING_FRAME_MARKER_RE.test(segment))) return false;
  // A frame set up in an earlier sentence scopes this one too.
  if (NAMING_FRAME_MARKER_RE.test(text.slice(0, sentenceStart))) return false;

  if (nameEndsClause) {
    const clauseTail = lettersOnly(after.replace(/^["“”'»«]+/u, "").split(/[,;:.!?\n]/u)[0]!);
    if (!NAME_CLAUSE_TAIL_OK_RE.test(clauseTail)) return false;
  }
  return true;
}

// Common words that follow a naming phrase but are NOT names — guards the
// extractor against e.g. "heißt du wirklich so?" capturing "wirklich".
const NON_NAME_TOKENS = new Set([
  "wirklich", "eigentlich", "so", "denn", "nicht", "jetzt", "now", "not", "really",
  "ab", "der", "die", "das", "ein", "eine", "the", "a", "an", "you", "du", "wie",
]);

/**
 * Extract the assistant name from an explicit naming command, or undefined.
 * Conservative: the name must be quoted OR capitalized (a proper-noun signal),
 * and not a known filler word. Used by the runtime to persist the name
 * deterministically — local models tend to *acknowledge* a rename ("saved!")
 * without ever calling assistant_personality_update (audit b71523fb: "Ab jetzt
 * heißt du Luna" → claimed saved, toolCalls=0, nothing persisted).
 * Only a plain naming STATEMENT counts — not a question, not quoted speech, not a
 * story/role-play frame, not "call you <X> about …" (see isUnframedNamingStatement).
 */
export function extractAssistantName(message: string): string | undefined {
  const text = message.trim();
  for (const { re, nameEndsClause } of ASSISTANT_NAMING_CAPTURE_PATTERNS) {
    for (const match of text.matchAll(re)) {
      const captured = match[1];
      if (!captured) continue;
      const matchStart = match.index ?? 0;
      const nameStart = matchStart + match[0].length - captured.length;
      // Quoted means a quote mark right before the NAME — not the apostrophe of "I'll"
      // earlier in the match, which let a lowercase "I'll call you tomorrow" through.
      const quoted = NAME_OPENING_QUOTE_RE.test(text.slice(matchStart, nameStart).trimEnd());
      const name = captured.replace(/["“”'»«]+$/u, "").trim();
      if (name.length < 2) continue;
      if (NON_NAME_TOKENS.has(name.toLowerCase())) continue;
      // Require a proper-noun signal: quoted in the message, or capitalized.
      if (!quoted && !/^\p{Lu}/u.test(name)) continue;
      // "I'll call you Monday" schedules a call; a quoted "Monday" would be a name.
      if (nameEndsClause && !quoted && CALL_YOU_TIME_WORDS.has(name.toLowerCase())) continue;
      if (!isUnframedNamingStatement(text, matchStart, match[0], nameStart + captured.length, nameEndsClause === true)) continue;
      return name.charAt(0).toUpperCase() + name.slice(1);
    }
  }
  return undefined;
}
const DURABLE_PREFERENCE_PATTERNS: readonly RegExp[] = [
  /\b(?:ab jetzt|ab sofort|von nun an|in zukunft|zuk(?:ü|u)nftig|k(?:ü|u)nftig)\b/,
  /\b(?:from now on|going forward|for future reference)\b/,
  /\bich bevorzuge\b/,
  /\bi prefer\b/,
  /\bmerke? dir\b/,
  /\bremember (?:that|this|my)\b/,
];

// (Removed in de-lexicalization: the user-own-facts keyword tables —
// FIRST_PERSON_SELF_PATTERNS, SELF_IDENTITY_CONTEXT_TERMS, SELF_FIT_QUALITY_PATTERNS.
// The userOwnFacts routing flag now defaults off; the swarm decides from the
// roster + tools + the LLM's semantic read whether a turn needs the user's own
// profile evidence, in any language. The retrieve-before-answer behaviour is to
// be restored semantically later, never by re-adding a keyword pile.)

// ── DynamicTurnGuidance ───────────────────────────────────────────────────────

export interface DynamicTurnGuidance {
  prompt: string;
  sourceSensitive: boolean;
  freshnessSensitive: boolean;
  mailSensitive?: boolean;
  computerAccessSensitive?: boolean;
  serverAccessSensitive?: boolean;
  pentestSensitive?: boolean;
  pentestMethodologySensitive?: boolean;
  swarmMaintenanceSensitive?: boolean;
  artifactSensitive?: boolean;
  /** User pasted substantial technical content inline AND asked for
   *  explanation/analysis/tutorial — runtime should bias toward direct
   *  synthesis rather than delegating to fetch live state. */
  inlineAnalyticalContent?: boolean;
  /** The user stated something durable (lasting preference, standing
   *  instruction, naming) that should be persisted THIS turn without
   *  waiting for an explicit "remember this". */
  durableMemorySensitive?: boolean;
  /** Subset of durableMemorySensitive: the user is naming/renaming the
   *  assistant itself → assistant_personality_update, not memory_store. */
  assistantNamingSensitive?: boolean;
  /** The turn asks about the USER'S OWN background/skills/experience/projects/fit/
   *  identity — facts the assistant does not inherently have. Triggers retrieve-
   *  before-answer (recall_context/search_documents) and, when enabled, a proactive
   *  bounded profile prefetch, so the model never fabricates or admits blindly. */
  userOwnFacts?: boolean;
}

/**
 * Classify a user message and build prompt guidance injected into the system
 * prompt for the current turn.  Returns null when no guidance is needed
 * (generic message with no detectable intent signals).
 */
const _dynamicGuidanceCache = new Map<string, DynamicTurnGuidance | null>();
const DYNAMIC_GUIDANCE_CACHE_MAX = 256;

/**
 * Memoized by (toolMode, message). The result is a pure function of those two —
 * everything else the body reads is module-level constants, and `toolMode` already
 * captures the only getConfig()-derived input. runtime.ts calls this TWICE per turn
 * (once with the default toolMode, once with effectiveToolMode), so the second call
 * reuses the first whenever the modes match — skipping a full regex-matching pass over
 * the message. Bounded FIFO so the cache can't grow unbounded across turns; a config
 * reload that changes toolMode produces a fresh key, so there is no staleness.
 */
export function buildDynamicTurnGuidance(userMessage: string, toolMode: MainAssistantToolMode = getConfig().agents.mainAssistant.toolMode): DynamicTurnGuidance | null {
  const cacheKey = `${toolMode} ${userMessage}`;
  const cached = _dynamicGuidanceCache.get(cacheKey);
  if (cached !== undefined) return cached; // distinguishes a cached `null` from a miss
  const result = computeDynamicTurnGuidance(userMessage);
  if (_dynamicGuidanceCache.size >= DYNAMIC_GUIDANCE_CACHE_MAX) {
    const oldest = _dynamicGuidanceCache.keys().next().value;
    if (oldest !== undefined) _dynamicGuidanceCache.delete(oldest);
  }
  _dynamicGuidanceCache.set(cacheKey, result);
  return result;
}

function computeDynamicTurnGuidance(userMessage: string): DynamicTurnGuidance | null {
  const normalized = userMessage.trim().toLowerCase();
  if (!normalized) return null;

  // ── De-lexicalized routing (cleanup/lean-base) ───────────────────────────
  // The topic/keyword/language routing-intent tables were deleted. The swarm
  // decides routing/intent from the agent roster + tools + the LLM's semantic
  // read, in any language — not from keyword tables here. So every ROUTING flag
  // (freshness/source/mail/computer/server/pentest/swarm/artifact/user-own-facts)
  // now DEFAULTS OFF. Only structural/format signals and durable-MEMORY
  // persistence survive:
  //   • containsActionableUrl — a URL must be FETCHED (language-independent).
  //   • inlineAnalyticalContent — substantial pasted technical content (FORMAT
  //     detection only): answer from it rather than re-fetch the same state.
  //   • durableMemory / assistantNaming — persistence, not routing.

  // Routing flags — all default OFF after de-lexicalization.
  const freshnessSensitive = false;
  const sourceSensitive = false;
  const mailSensitive = false;
  const computerAccessSensitive = false;
  const serverAccessSensitive = false;
  const pentestSensitive = false;
  const pentestMethodologySensitive = false;
  const swarmMaintenanceSensitive = false;
  const artifactSensitive = false;
  const userOwnFacts = false;

  // A URL in the request is a language-independent STRUCTURAL signal that
  // external content must be FETCHED. Keyed on the URL's presence only — no
  // topic/intent lexicon.
  const containsActionableUrl = /\bhttps?:\/\/[^\s<>"'`)\]]+/i.test(userMessage);

  // Structural FORMAT detection only: the user pasted substantial technical
  // content inline. Tells the model to answer from the pasted content rather
  // than delegate to re-fetch the same state. No analytical keyword half.
  const inlineAnalyticalContent = hasSubstantialInlineTechnicalContent(userMessage);

  // A naming turn is durable-memory-sensitive only when a name is actually being
  // ASSIGNED (a command), not merely asked about. Gating on extractAssistantName
  // cleanly separates command from question. Naming/preference is durable-MEMORY
  // persistence, not topic routing, so these structural patterns are KEPT.
  const assistantNamingSensitive = ASSISTANT_NAMING_PATTERNS.some((pattern) => pattern.test(normalized))
    && extractAssistantName(userMessage) !== undefined;
  const durableMemorySensitive = assistantNamingSensitive
    || DURABLE_PREFERENCE_PATTERNS.some((pattern) => pattern.test(normalized));

  const flags = { containsActionableUrl, inlineAnalyticalContent, durableMemorySensitive };
  if (!Object.values(flags).some(Boolean)) return null;

  const promptParts: string[] = [];

  if (inlineAnalyticalContent) {
    promptParts.push(
      "The user has pasted substantial technical content (configuration, code, command output, structured state) directly into their message.",
      "Treat the pasted content as the authoritative current state for this turn and answer directly from it using your own knowledge, rather than delegating to a specialist that would fetch the same state the user already provided.",
      "Code execution or file inspection tools are still OK if you need to validate a draft snippet or run a small computation, but the goal is direct synthesis from the inline content.",
      "If the user explicitly switches focus mid-turn to live state ('check if the service is running'), THEN delegation is appropriate. Until then, write the answer.",
    );
  }

  if (containsActionableUrl) {
    promptParts.push(
      "A URL is present in the request. If you cannot fetch it directly, delegate to a web-capable agent to read it rather than asking the user to paste its contents.",
    );
  }

  if (durableMemorySensitive) {
    promptParts.push(
      assistantNamingSensitive
        ? "The user is giving YOU (the assistant) a name or changing it. That IS an explicitly requested durable personality change: call assistant_personality_update in THIS turn to set the preferred assistant name, then answer using that name. Do NOT wait for the user to say 'remember this'."
        : "The user just stated something durable — a lasting preference, standing instruction, or fact meant to apply beyond this session. Persist it in THIS turn with memory_store (kind 'preference' or 'fact'; scope 'user' for cross-workspace personal preferences when a user is signed in, otherwise 'workspace') alongside your answer. Do NOT wait for an explicit 'remember this'.",
      "Acknowledge what you saved in one short clause of your reply instead of asking whether to save it.",
      "If on reflection the statement only concerns the current task and is not durable, skip the store and just answer.",
    );
  }

  return {
    prompt: promptParts.join(" "),
    sourceSensitive,
    freshnessSensitive,
    mailSensitive,
    computerAccessSensitive,
    serverAccessSensitive,
    pentestSensitive,
    pentestMethodologySensitive,
    swarmMaintenanceSensitive,
    artifactSensitive,
    inlineAnalyticalContent,
    durableMemorySensitive,
    assistantNamingSensitive,
    userOwnFacts,
  };
}

// ── Language / identity guidance ──────────────────────────────────────────────

export function buildLanguageAndIdentityTurnGuidance(userMessage: string, opts: TurnReplyLanguageOptions = {}): string {
  const profile = loadMainAssistantPersonality();
  const languageInstruction = buildLanguageInstructionForTurn(userMessage, opts);
  const behaviorInstruction = "Be polite, brief, and efficient. Avoid small talk, filler, and unnecessary pleasantries. Do not introduce yourself or mention your name unless the user explicitly asks. The user already knows they are speaking to the assistant.";
  const nameInstruction = profile.identity.name
    ? `If the user explicitly asks for your name or what to call you, use ${JSON.stringify(profile.identity.name)} as your assistant name. Do not call yourself ${JSON.stringify(PRODUCT.name)} in conversation unless the user is explicitly asking about the product or platform name.`
    : `Do not use the platform name ${JSON.stringify(PRODUCT.name)} as your personal name in conversation. If the user did not ask for your name, reply without naming yourself.`;
  return `Language and identity for this turn: ${languageInstruction} ${behaviorInstruction} ${nameInstruction}`;
}

// shouldDefaultToGermanForMessage (a short-message German-default language guesser) was
// DELETED in the de-lexicalization. Language is decided by the LLM from the user's latest
// message in any language — never a keyword table that defaulted ambiguous openings to German.

/**
 * The reply-language line for this turn. It used to say only "reply in the same language as that
 * message", and as the one instruction that quotes the message it outranked everything else: a
 * German message asking for an English answer got German. The precedence is in reply-language.ts.
 */
export function buildLanguageInstructionForTurn(userMessage: string, opts: TurnReplyLanguageOptions = {}): string {
  return buildTurnReplyLanguageInstruction(userMessage, undefined, opts);
}

// ── Soft routing enforcement ──────────────────────────────────────────────────

/**
 * Reframe a hard, imperative routing-enforcement prompt as a strong but
 * overridable hint. Used when `agents.performance.softRoutingEnforcement` is on
 * to realize the trust-the-LLM direction (soft hints, not hard gates) for the
 * *routing-class* enforcement prompts (maintenance / workflow-catalog /
 * search-no-match). Anti-hallucination and correctness enforcement bypass this
 * and stay hard.
 *
 * Centralizing the softening here means future routing tuning is a single
 * transform rather than scattered edits across the per-intent prompt builders.
 */
/**
 * Whether a research request genuinely spans several distinct areas/deliverables
 * (a hardware build = BOM + power + layout + sourcing; a trip = activities +
 * transport + lodging). Only then does a coordinator earn its extra hop — the
 * Anthropic/Cognition consensus is that multi-agent only wins when the task
 * decomposes into independent threads. Single-domain lookups/validations go
 * straight to one specialist. Conservative: short asks are always single-domain.
 */
export function looksMultiDomainResearch(text: string): boolean {
  const raw = String(text ?? "");
  if (raw.trim().length < 300) return false;
  const questionCount = (raw.match(/\?/g) ?? []).length;
  const substantiveLines = raw.split(/\n/).map((l) => l.trim()).filter((l) => l.length > 20).length;
  // De-lexicalized: the German/English conjunction alternation was removed; only
  // the language-independent structural counts (length, question marks, long
  // lines) gate multi-domain decomposition now.
  return questionCount >= 3 || substantiveLines >= 5;
}

export function toSoftRoutingHint(text: string): string {
  if (!text.trim()) return text;
  const soft = text
    .replace(/\bYou MUST\b/g, "You should strongly prefer to")
    .replace(/\byou MUST\b/g, "you should strongly prefer to")
    .replace(/\bMUST\b/g, "should")
    .replace(/\b(Do|DO) NOT\b/g, "prefer not to")
    .replace(/\bdo NOT\b/g, "prefer not to")
    .replace(/\bNEVER\b/g, "avoid")
    .replace(/\bSTOP\b/g, "consider stopping")
    .replace(/\s+this turn\b/g, "");
  return `Routing hint (advisory — follow unless you have a clear reason not to):\n${soft}`;
}
