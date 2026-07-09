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
 * Honest correction for a turn that DID NOT FINISH NORMALLY — a forced synthesis emitted from an
 * early-return path that bypasses the terminal honesty guards. Two such paths exist: the internal
 * TIMEOUT cut-off, and the max-effort OVERSIGHT FLOOR (a stuck turn force-delivered). Those guards
 * never run there, and are fooled anyway by a partial run's thin shared findings, so a from-memory
 * partial can ship fabricated specifics dressed up as "verified against sources" (session e3cf6c22: a
 * full "Verifiziert gegen [URLs]" paper written after a cancelled task graph). The abnormal finish IS
 * proof the work is incomplete/unverified, so prepend a prominent bilingual banner unconditionally —
 * the model claiming partial-then-fabricating is exactly why a prompt instruction alone ("be explicit
 * about what was completed") is not enough. NEVER empties the answer. Sentinel-deduped so it never
 * stacks. Cause-neutral wording (fits timeout + oversight). Structural — no phrase matching. Pure.
 */
export function prependTurnIncompleteCaveat(text: string): string {
  // Dedup ONLY on the distinctive English sentinel (always emitted alongside the German half).
  // The German banner fragment "nicht vollständig abgeschlossen" is an ordinary German collocation —
  // an honest German partial admitting incompleteness ("Die Recherche wurde nicht vollständig
  // abgeschlossen") would otherwise trip it and SKIP this mandatory honesty banner on exactly the
  // guard-bypassing early-return path it protects. "did not finish normally" is robotic/distinctive.
  if (text.includes("did not finish normally")) {
    return text;
  }
  const german = answerLooksGerman(text);
  const de =
    "> ⚠️ **Dieser Durchlauf wurde nicht vollständig abgeschlossen** — der Inhalt unten ist ein "
    + "UNVOLLSTÄNDIGER Entwurf aus nicht abgeschlossener Arbeit und wurde NICHT gegen Quellen verifiziert. "
    + "Behandle alle konkreten Angaben (Daten, Zahlen, Maße, Quellen- und „verifiziert“-Aussagen) als unbestätigt. "
    + "Für das vollständige, geprüfte Ergebnis bitte mit höherer Effort-Stufe (medium/high) oder längerem Timeout erneut ausführen.";
  const en =
    "> ⚠️ **This run did not finish normally** — the content below is an INCOMPLETE draft from unfinished "
    + "work and was NOT verified against sources. Treat every specific (dates, figures, dimensions, and any "
    + "source or \"verified\" claims) as unconfirmed. Re-run at a higher effort tier (medium/high) or with a "
    + "longer timeout for the full, verified result.";
  const caveat = german
    ? `${de}\n> _(${en.replace(/^> /, "")})_`
    : `${en}\n> _(${de.replace(/^> /, "")})_`;
  return `${caveat}\n\n${text.trim()}`;
}

/**
 * Caveat for a QA-gate PASS that carried no verifiable evidence (orchestration.qaEvidenceRequired).
 * Unlike prependTurnIncompleteCaveat, the run DID finish normally — the honest gap is only that the
 * reviewer could not ground its PASS in a concrete tool-result/artifact fact, so the answer must not
 * be presented as QA-confirmed. Same structural bilingual shape (language chosen by answerLooksGerman,
 * both languages emitted so a third-language reader still gets it) and sentinel-phrase dedup. Pure.
 */
export function prependUnverifiedQaCaveat(text: string): string {
  // Dedup on a distinctive English phrase that EXACTLY matches the emitted banner (always present,
  // since both languages are emitted). The prior sentinels matched neither the emitted text
  // ("not confirmed" vs emitted "did NOT confirm") nor its case ("nicht" vs emitted "NICHT"), so
  // dedup never fired and a second call double-stamped.
  if (text.includes("did NOT confirm this answer against concrete evidence")) {
    return text;
  }
  const german = answerLooksGerman(text);
  const de =
    "> ⚠️ **Nicht verifiziert** — die Qualitätsprüfung hat diese Antwort NICHT gegen konkrete Nachweise "
    + "(Tool-Ergebnisse, Artefakte) bestätigt. Behandle konkrete Angaben (Daten, Zahlen, Quellen) als unbestätigt.";
  const en =
    "> ⚠️ **Unverified** — the QA check did NOT confirm this answer against concrete evidence "
    + "(tool results, artifacts). Treat specific claims (dates, figures, sources) as unconfirmed.";
  const caveat = german
    ? `${de}\n> _(${en.replace(/^> /, "")})_`
    : `${en}\n> _(${de.replace(/^> /, "")})_`;
  return `${caveat}\n\n${text.trim()}`;
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
  // /i on BOTH URL passes so they cover every scheme casing answerPresentsSourceCitations accepts
  // (also /i): a mixed-case "HTTPS://"/"Http://" (LLMs emit these at sentence start) otherwise
  // TRIGGERED the guard but SURVIVED the strip — a fabricated clickable 404 shipped while the audit
  // recorded a successful strip.
  return text
    .replace(/\[([^\]]+)\]\(\s*https?:\/\/[^)]*\)/gi, "$1")           // [label](404url) → label
    .replace(/\bhttps?:\/\/[^\s)\]]+/gi, "")                          // bare URLs removed
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
 * STRUCTURAL, language-free detector: a SUBSTANTIAL answer that asserts a DENSE, DIVERSE cluster of
 * hard, externally-verifiable specifics — numbers with units, currencies, percentages, calendar
 * years, dates, and part/version-code tokens (e.g. "IM73A135V01", "3,75 %", "0.95 mA", "3.3 V",
 * "2026"). On an orchestration_only turn that ran ZERO research, such a draft is the model reciting
 * current/external state from training memory and presenting it as fact — the general, no-URL sibling
 * of the URL-fabrication case (audit fe496ec5: a fabricated "news von heute" bulletin — DAX / EZB %
 * figures, zero delegations; bdbace34: fabricated mic specs "0.95 mA at 3.3 V"). NOT a topic/language
 * keyword table — it counts fact-SHAPE tokens (digits + universal units + code shapes), identical in
 * any language.
 *
 * TWO gates keep it off ordinary prose (both were needed — a prior version over-fired on a company-
 * history or WW2 answer that merely mentioned a couple of years): (1) ≥4 distinct tokens over a
 * 400-char floor; (2) tokens must span ≥2 distinct CATEGORIES — a data bulletin / spec sheet mixes
 * percentages + currencies + units + codes, whereas a historical narrative carries only years (one
 * category) and never trips. The code regex requires a CONTIGUOUS alphanumeric token containing both
 * a letter and a digit ("IM73A135V01"), so a prose "word number" pair ("in 1998", "by 2015") no
 * longer matches and no longer double-counts against the year regex. Consumed by the
 * ungroundedFactualAnswerGuard force-research gate. Pure/exported.
 */
// The currency/unit vocabularies are deliberately INTERNATIONAL: the detector claims to be
// language-independent ("identical in any language"), so it must not privilege $/€/abbreviated-
// metric over the rest of the world. A prior $-and-metric-only vocabulary counted a Danish-krone,
// spelled-out-"Liter" answer as a single token ("90 %") and let it slip the ungrounded-answer guard
// (a fabricated DK deposit-system explanation shipped with zero research). These are fact-SHAPE
// tokens, not topic keywords — no subject/language term is encoded.
const CURRENCY_SYMBOLS = "€$£¥₹₩₽₺₪₴฿₫₦₱";
// Inline currency codes/abbreviations that appear on EITHER side of the amount ("kr. 2,50" / "82 USD").
// Curated to distinctive currency tokens to avoid colliding with common words / unit abbreviations
// (e.g. "ft" is left to the imperial UNIT category, not Hungarian forint).
const CURRENCY_CODES = "kr|dkk|sek|nok|isk|øre|zł|pln|kč|czk|huf|bgn|uah|rub|eur|usd|gbp|jpy|chf|cny|aud|nzd|mxn|brl|zar|krw|sgd|hkd|inr|ils";
// ISO codes that are ALSO common English words: "TRY" (Turkish lira vs "try N"), "CAD" (Canadian
// dollar vs computer-aided design), "RON" (Romanian leu vs a name). Matched ONLY in their uppercase
// currency-code form via (?-i:…), so lowercase prose ("try 2 threads", "ron said 3 times") isn't
// counted as a monetary token — the same case-sensitive discipline the voltage [VW] branch uses.
// (?-i:…) locally disables the currency regex's global `i` flag for this group.
const CURRENCY_CODES_UPPER = "TRY|CAD|RON";
// Abbreviated metric/tech PLUS spelled-out volume/mass/imperial units (common in prose and in
// non-English answers, e.g. "1,5 Liter"). Multi-char only — bare single letters (l/g/t/m/w) are
// omitted to avoid prose false positives; the ≥2-category / ≥4-token gate is the real filter.
const UNIT_TOKENS = "mm|cm|km|kg|mg|ghz|mhz|khz|hz|mah|ma|kw|kwh|wh|nm|px|mb|gb|tb|fps|rpm|°c|°f"
  + "|liter|litre|liters|litres|ml|cl|dl|hl|oz|lb|lbs|gal|gallon|gallons|inch|inches|mile|miles"
  + "|meter|metre|meters|metres|gram|grams|tonne|tonnes";

const SPECIFICITY_CATEGORIES: Record<string, RegExp> = {
  percent: /\d[\d.,]*\s?%/g,                                                       // 3,75 %
  currency: new RegExp(
    `[${CURRENCY_SYMBOLS}]\\s?\\d[\\d.,]*`                                         // €5 / $ 1,200
    + `|\\b(?:${CURRENCY_CODES}|(?-i:${CURRENCY_CODES_UPPER}))\\.?\\s?\\d[\\d.,]*` // kr. 2,50 / USD 5 / TRY 5 (not "try 5")
    + `|\\d[\\d.,]*\\s?(?:${CURRENCY_CODES}|(?-i:${CURRENCY_CODES_UPPER}))\\b`,    // 2,50 kr / 82 USD / 82 TRY
    "gi",
  ),
  unit: new RegExp(`\\b\\d[\\d.,]*\\s?(?:${UNIT_TOKENS})\\b`, "gi"),               // 1,5 Liter / 20 kHz
  voltage: /\b\d[\d.,]*\s?[VW]\b/g,                                                // volts/watts (case-sensitive)
  year: /\b(?:19|20)\d{2}\b/g,                                                     // calendar years
  date: /\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/g,                                    // dd.mm.yyyy
  code: /\b(?=[a-z0-9-]*[a-z])(?=[a-z0-9-]*\d)[a-z0-9]+(?:-[a-z0-9]+)*\b/gi,       // contiguous alnum w/ letter+digit: IM73A135V01
};

/** How many distinct fact-SHAPE tokens the text carries, and across how many distinct categories.
 * String.matchAll works on a clone, so reusing the module-level global regexes across calls is safe. */
function specificityProfile(text: string): { tokens: number; categories: number } {
  const tokens = new Set<string>();
  const categoriesHit = new Set<string>();
  for (const [category, re] of Object.entries(SPECIFICITY_CATEGORIES)) {
    for (const m of text.matchAll(re)) {
      tokens.add(m[0].toLowerCase());
      categoriesHit.add(category);
    }
  }
  return { tokens: tokens.size, categories: categoriesHit.size };
}

export function looksLikeUnsourcedSpecificClaims(text: string): boolean {
  const t = text ?? "";
  if (t.trim().length < 400) return false;
  const p = specificityProfile(t);
  return p.tokens >= 4 && p.categories >= 2;
}

/**
 * The answer ASSERTS concrete external specifics — ≥ `minTokens` fact-shape tokens (numbers with
 * units, currencies, percentages, years, dates, part codes). Used by the SHORT-answer branch of the
 * URL-not-fetched guard: a ~300-char fabricated page summary ("AI Engineer, 3+ Jahre, Remote, 90
 * EUR/h, Start 2026") slips under the 400-char floor, yet it plainly asserts the page's content. An
 * honest short "I couldn't fetch it — shall I?" carries no such specifics, so it is not flagged.
 * Structural / language-free — reuses the same fact-shape categories, no keyword table. Pure/exported.
 */
export function answerAssertsSpecifics(text: string, minTokens = 2): boolean {
  return specificityProfile(text ?? "").tokens >= minTokens;
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
