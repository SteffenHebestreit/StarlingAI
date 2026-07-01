// isBroadSourceSensitiveAdvisoryRequest (a bilingual product/BOM/wiring/quality keyword scorer)
// was DELETED in the de-lexicalization: it was a per-language keyword table and its only caller
// (hasRecentSparseSourceSensitiveMemoryReuse) sat behind the always-false sourceSensitive gate.

export function looksLikeTransparentIncompleteReport(text: string): boolean {
  const normalized = text.toLowerCase();
  return /\b(partial|incomplete|failed|failure|blocked|timed out|timeout|could not|unable|unverified|missing evidence|attempted)\b/.test(normalized);
}

/**
 * Build the `[SYNTHESIS REQUIRED]` directive injected after orchestration. Three
 * shapes, pure so the selection is unit-testable:
 *  - artifacts attached → a SHORT completion summary (don't paste file contents);
 *  - partial/thin evidence on a source-sensitive turn → an HONESTY directive that
 *    forbids asserting any unverified specific (audit 0dc158ad: the normal "copy the
 *    exact names and numbers" wording oversold ~500 chars of off-topic evidence and
 *    the model fabricated an analog mic's interface as I2S). This is the central
 *    "never made-up facts" rule applied at the exact point that induced the fabrication;
 *  - otherwise → the standard "synthesise from the grounded evidence" directive.
 */
export function buildSynthesisRequiredDirective(opts: {
  artifactPaths?: readonly string[];
  partialEvidence?: boolean;
}): string {
  const artifactPaths = (opts.artifactPaths ?? []).filter(Boolean);
  if (artifactPaths.length > 0) {
    return "[SYNTHESIS REQUIRED] The orchestration is COMPLETE and its deliverables are attached to this message as files ("
      + artifactPaths.slice(0, 12).join(", ")
      + "). Write a SHORT final answer in the user's language: state what was completed, list each attached artifact with a one-line description, and note anything the evidence marks as incomplete. Do NOT paste the documents' contents into the chat and do NOT delegate again.";
  }
  if (opts.partialEvidence) {
    return "[SYNTHESIS REQUIRED] The research for this turn did NOT complete — the evidence above is PARTIAL and is probably missing the specifics the request needs. "
      + "Write the most useful answer you honestly can in the user's language, but follow the quality rule strictly: state a concrete fact — a spec, interface, rating, dimension, price, part number, model name, URL, or figure — as confirmed ONLY if it appears verbatim in the evidence above. "
      + "For anything NOT in that evidence, including details you believe you already know, do NOT present it as verified: either omit it, or clearly mark it as UNVERIFIED and say it must be checked against the official datasheet/source. "
      + "Never invent a value to fill a gap. A shorter answer that cleanly separates confirmed facts from unverified suggestions is BETTER than a complete-looking one that fabricates specifics. Do NOT delegate again.";
  }
  return "[SYNTHESIS REQUIRED] The orchestration results above contain grounded evidence blocks. "
    + "You MUST now write your final answer using ONLY the details from those Observed evidence blocks. "
    + "Do NOT delegate again for the same information — the evidence is already collected. "
    + "Copy the exact names, numbers, values, task states, and statuses from the evidence into your answer.";
}

/** Lightweight German detection to localize the unverified-answer caveat. */
export function answerLooksGerman(text: string): boolean {
  const t = text.toLowerCase();
  if (/[äöüß]/.test(t)) return true;
  return /\b(ich|und|der|die|das|nicht|mit|für|oder|eine?|brauche|möchte|wie|was|kann|mir|dein|deine|ist|sind)\b/.test(t);
}

/**
 * Prepend a clear "unverified" banner to a source-sensitive answer that was
 * produced WITHOUT any research evidence (the model declined to delegate after
 * the research nudge, so no web/tool evidence backs it). This keeps the useful
 * general guidance but stops the swarm from presenting pre-assumptions — part
 * numbers, specs, prices, manufacturers — as confirmed facts. Regression:
 * session f59f85f5 (2026-05-29) shipped a wall of invented part numbers.
 */
export function prependUnverifiedSourceCaveat(answer: string, userMessage: string): string {
  if (answer.includes("NICHT mit aktuellen Online-Quellen") || answer.includes("NOT verified against live web sources")) {
    return answer;
  }
  const german = answerLooksGerman(userMessage) || answerLooksGerman(answer);
  const caveat = german
    ? "> ⚠️ **Ungeprüft:** Diese Antwort beruht auf allgemeinem Wissen und wurde NICHT mit aktuellen Online-Quellen verifiziert. Behandle konkrete Teilenummern, Spezifikationen, Preise und Herstellerangaben als unbestätigte Annahmen, die vor dem Verlass darauf noch zu prüfen sind."
    : "> ⚠️ **Unverified:** This answer is based on general knowledge and was NOT verified against live web sources. Treat specific part numbers, specifications, prices, and manufacturer claims as unconfirmed assumptions to verify before relying on them.";
  return `${caveat}\n\n${answer}`;
}

/**
 * STRUCTURAL, language-free detection of source citations in an answer: a markdown link to an
 * http(s) URL, or a bare http(s) URL. The citation-honesty guard uses this to catch an answer
 * that presents URL citations without any real retrieval having run this turn (the audited
 * "7 fabricated 404 URLs" case, session 1303e254). NO language/phrase matching: a fabricated
 * link is a fabricated link in any language, and an honest answer that merely says "laut den
 * Datenblättern" / "según las fuentes" with no URL is NOT flagged (it has no clickable 404 to
 * strip). The false "verified" framing is corrected by the prepended caveat, not by hunting
 * verification phrases. Pure/exported.
 */
export function answerPresentsSourceCitations(text: string): boolean {
  return /\[[^\]]+\]\(\s*https?:\/\//i.test(text)
    || /\bhttps?:\/\/\S+/i.test(text);
}

/**
 * Remove fabricated URL citations from an answer that ran NO real retrieval: a markdown link
 * to a URL becomes its plain label (drops the clickable 404) and bare URLs are removed. NEVER
 * empties the answer — only the offending links are stripped; the body's substance survives,
 * and the honest unverified caveat (prependUnverifiedSourceCaveat) is prepended separately to
 * correct any "verified" framing. STRUCTURAL/language-free — no phrase neutralization. Pure.
 */
export function stripFabricatedCitations(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\(\s*https?:\/\/[^)]*\)/g, "$1")            // [label](404url) → label
    .replace(/\bhttps?:\/\/[^\s)\]]+/g, "")                           // bare URLs removed
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The user's message this turn carried an actionable http(s) URL — they handed the assistant a
 * page to READ. Structural / language-free (same regex family as intent-classifier's
 * containsActionableUrl). Used by the URL-not-fetched honesty guard below.
 */
export function userMessageCarriesActionableUrl(userMessage: string): boolean {
  return /\bhttps?:\/\/[^\s<>"'`)\]]+/i.test(userMessage ?? "");
}

/**
 * Honest correction for the case where the user supplied a URL to read, the turn ran NO web
 * fetch / delegation / research, yet the answer is substantial — i.e. it presented what the page
 * "says" from imagination (session 29796f86: a full fabricated job posting + the false claim "Ich
 * habe die Ausschreibung geladen", with zero web_fetch/delegate calls). Prepends a prominent
 * bilingual warning; NEVER empties the answer (a false-positive only adds an honest note).
 * Structural — no phrase matching. Pure.
 */
export function prependUrlNotFetchedCaveat(text: string, userMessage = ""): string {
  // Dedupe: if a sibling unverified banner (prependUnverifiedSourceCaveat) or a prior copy of THIS
  // banner already leads the answer, don't stack a second one — one honest caveat is enough. This
  // matters when the mid-loop unverified caveat and this terminal caveat can co-fire on the same
  // released-URL turn (both flags on). Sentinel-based, mirrors prependUnverifiedSourceCaveat.
  if (
    text.includes("NICHT abgerufen") || text.includes("NOT fetched this turn")
    || text.includes("NICHT mit aktuellen Online-Quellen") || text.includes("NOT verified against live web sources")
  ) {
    return text;
  }
  const german = answerLooksGerman(userMessage) || answerLooksGerman(text);
  const de =
    "> ⚠️ **Die verlinkte Seite wurde in diesem Durchlauf NICHT abgerufen** — alle darauf bezogenen "
    + "Angaben sind daher ungeprüft und möglicherweise erfunden. Bitte lass mich die Seite tatsächlich "
    + "abrufen (Web-Recherche), bevor du dich auf den Inhalt verlässt.";
  const en =
    "> ⚠️ **The linked page was NOT fetched this turn** — any details attributed to it are unverified and "
    + "may be fabricated. Ask me to fetch it for a grounded answer.";
  // Bilingual, but lead with the user's language; the secondary line is parenthesized+italic.
  const caveat = german
    ? `${de}\n> _(${en.replace(/^> /, "")})_`
    : `${en}\n> _(${de.replace(/^> /, "")})_`;
  return `${caveat}\n\n${text.trim()}`;
}
