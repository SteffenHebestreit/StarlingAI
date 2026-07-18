/**
 * Source-sensitive evidence anchoring — decides whether a drafted answer is
 * actually grounded in the gathered evidence, or has drifted/fabricated.
 *
 * Extracted verbatim from runtime.ts (god-file decomposition): this is a
 * self-contained, pure cluster (string → boolean/string[], no runtime state)
 * with a single public entry point, `looksEvidenceAnchored`. The runtime's
 * synthesis backstops call it to reject a final answer that ignored the
 * findings or flipped a spec the evidence never stated.
 */

/**
 * Extract the distinctive "anchor" tokens from gathered evidence — identifiers,
 * spec-shaped tokens, and source hostnames — dropping generic scaffolding words.
 * These are what a grounded draft is expected to share with the evidence.
 */
function sourceSensitiveEvidenceTokens(evidence: string): string[] {
  const stopwords = new Set([
    "about", "after", "agent", "available", "before", "completed", "content", "current", "evidence", "fetch", "finding", "from", "generic", "matched", "observed", "official", "output", "partial", "progress", "research", "result", "source", "state", "strongly", "task", "title", "tools", "url", "with",
    "alle", "aus", "bisher", "bleiben", "diesem", "diese", "evidenz", "lauf", "quelle", "quellen", "recherche", "unvollstaendig", "unverifiziert", "wurde",
  ]);
  const tokens = new Set<string>();
  for (const match of evidence.matchAll(/[A-Za-z0-9][A-Za-z0-9._/-]{3,}/g)) {
    const token = match[0]!.toLowerCase();
    if (stopwords.has(token)) continue;
    if (/^https?:\/\//i.test(token)) {
      try {
        tokens.add(new URL(match[0]!).hostname.replace(/^www\./i, "").toLowerCase());
      } catch {
        tokens.add(token.slice(0, 80));
      }
      continue;
    }
    if (/^[a-z]{1,2}\d+$/i.test(token)) continue;
    tokens.add(token.slice(0, 80));
  }
  return [...tokens].slice(0, 80);
}

/**
 * Lighter sibling of looksEvidenceAnchored: true when the draft demonstrably
 * USED the evidence (shares its distinctive vocabulary), WITHOUT the strict
 * per-spec-token consistency check (condition 2).
 *
 * Used only for the source-sensitive RECOVERY synthesis — a second pass already
 * constrained by prompt to "use ONLY this evidence; mark anything unsupported as
 * unverified". There, condition 2 wrongly discards a correctly-hedged partial
 * answer the moment it names a requested topic the (often thin/partial) evidence
 * didn't cover, and the fallback is a raw tool-trace dump — strictly worse for the
 * user (audit f7928f57: a usable German "verified / not-yet-verified / next step"
 * synthesis was thrown away for the raw evidence list). The full
 * looksEvidenceAnchored stays the guard for the model's own free draft, where the
 * fabrication risk (e.g. flipping analog→I²S) actually lives.
 */
export function sharesEvidenceVocabulary(draft: string, evidence: string): boolean {
  const normalizedDraft = draft.toLowerCase();
  if (normalizedDraft.length < 120) return false;
  const anchors = sourceSensitiveEvidenceTokens(evidence);
  if (anchors.length === 0) return false;
  let sharedHits = 0;
  for (const anchor of anchors) {
    if (normalizedDraft.includes(anchor)) sharedHits += 1;
    if (sharedHits >= Math.min(3, anchors.length)) return true;
  }
  return false;
}

export function looksEvidenceAnchored(sourceSensitiveDraft: string, evidence: string, lengthScaled = false): boolean {
  // Two-condition anchor, topic-neutral. The original bug shipped a draft
  // that named the right part but flipped a spec ("I²S-Digital" against
  // evidence "analog differential") because the check counted only shared
  // vocabulary — every spec word the model mentioned, true or false,
  // satisfied the anchor. The fix is one extra condition: every falsifiable
  // spec token in the draft must either appear in the evidence, OR appear
  // in a NEGATED context in both texts (so a contrastive phrasing like
  // "not I²S" against evidence "NOT I²S / NOT PDM" is recognised as
  // consistent rather than fabricated).
  //
  // (1) shared vocabulary — at least min(3, |anchors|) distinct tokens
  //     from the evidence appear in the draft. Catches the "model wrote a
  //     generic answer that ignored the gathered findings" failure.
  // (2) spec-token consistency — for every concrete spec-shape token in
  //     the draft, the evidence either contains the token, denies the
  //     token, or the draft denies it AND the evidence does too. A draft
  //     that invents a new spec token (e.g. "I²S-Digital" for an analog
  //     mic) has nothing in the evidence that matches, so the answer is
  //     not anchored.
  const normalizedDraft = sourceSensitiveDraft.toLowerCase();
  if (normalizedDraft.length < 120) return false;
  const anchors = sourceSensitiveEvidenceTokens(evidence);
  if (anchors.length === 0) return false;

  // Condition 1: shared vocabulary. #8 (lengthScaled): a long draft sharing only 3 generic tokens is
  // weakly anchored — scale the required hits with draft length (3 + floor(len/1500)) so "used the
  // evidence" is proportional to answer size. Default (false) keeps the original min(3, anchors).
  const requiredHits = Math.min(lengthScaled ? 3 + Math.floor(normalizedDraft.length / 1500) : 3, anchors.length);
  let sharedHits = 0;
  for (const anchor of anchors) {
    if (normalizedDraft.includes(anchor)) sharedHits += 1;
    if (sharedHits >= requiredHits) break;
  }
  if (sharedHits < requiredHits) return false;

  // Condition 2: every concrete spec token in the draft is grounded in
  // the evidence (positive match, or a mutually-negated match). Topic-
  // neutral: the regex extracts any 4+ character spec-shaped token that
  // is either a known-false label ("i2s-digital", "ip57") or a domain
  // identifier; it does not curate a domain vocabulary.
  const normalizedEvidence = evidence.toLowerCase();
  const specTokens = extractSpecTokensFromDraft(normalizedDraft);
  for (const token of specTokens) {
    if (evidenceGroundsToken(normalizedEvidence, token)) continue;
    if (isClaimNegatedIn(normalizedDraft, token) && isClaimNegatedIn(normalizedEvidence, token)) continue;
    return false;
  }
  return true;
}

/** Whether a draft spec token is grounded in the evidence at a WORD BOUNDARY — not a raw
 *  substring. `includes` accepted a fabricated "v2.1" against evidence "v2.10", or "ip68" inside a
 *  part number "xip6800"; draft tokens are already extracted with \b, so the evidence side must
 *  match with \b too. The token starts/ends on alphanumerics (per the extraction regex), so \b is safe. */
function evidenceGroundsToken(normalizedEvidence: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`\\b${escaped}\\b`).test(normalizedEvidence)) return true;
  // A date written in another locale is the SAME fact, not a fabricated one: an answer
  // saying "20.02.2025" over evidence saying "2025-02-20" is faithful, yet a verbatim
  // match calls it invented (7 of 15 false positives in the corpus). Accept a DATE-shaped
  // token — exactly three numeric parts, one of them a 19xx/20xx year, the other two at
  // most two digits — when every part appears in the evidence as a number.
  //
  // Deliberately narrow: a bare year ("2027") has one part and stays under the strict
  // verbatim rule, and a dotted version ("24.18.0") carries no 4-digit year, so neither
  // can be laundered through this path.
  const parts = token.split(/[.\-/]/).filter(Boolean);
  const dateShaped = parts.length === 3
    && parts.every((part) => /^\d{1,4}$/.test(part))
    && parts.some((part) => /^(19|20)\d{2}$/.test(part))
    && parts.filter((part) => part.length <= 2).length === 2;
  if (!dateShaped) return false;
  return parts.every((part) => new RegExp(`\\b0*${Number(part)}\\b`).test(normalizedEvidence));
}

/**
 * Topic-neutral spec-token extraction. Pulls 4+ character spec-shaped
 * tokens (alphanumeric with at least one letter; allows hyphens / dots for
 * compound IDs and version-like suffixes). Pure prose words never match
 * because they either lack a digit, lack a letter-and-length combo, or
 * are in the stoplist. This is intentionally broader than the previous
 * "falsifiable claim" pipeline: it asks "is this token something the
 * evidence is supposed to confirm or deny?" and answers yes for any
 * candidate the model cited as a fact.
 */
function extractSpecTokensFromDraft(normalizedDraft: string): string[] {
  const stopwords = new Set([
    "this", "that", "with", "from", "into", "they", "your", "have", "has",
    "had", "were", "been", "their", "them", "than", "then", "also", "just",
    "only", "even", "very", "more", "most", "some", "such", "each", "both",
    "used", "uses", "make", "made", "over", "into", "onto", "what", "when",
    "where", "while", "would", "could", "should", "about", "after", "before",
    "between", "under", "above", "again", "still", "using", "based", "around",
    "diese", "einer", "eines", "einem", "sowie", "auch", "noch", "sehr",
  ]);
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const match of normalizedDraft.matchAll(/\b[a-zA-Z0-9][a-zA-Z0-9._-]{3,}\b/g)) {
    const raw = match[0];
    if (seen.has(raw)) continue;
    if (stopwords.has(raw)) continue;
    if (/[a-z]/.test(raw)) {
      // Letter-bearing spec. A hyphen ALONE is not enough: ordinary prose hyphenates in
      // every language ("half-hour", "13-inch", "user-replaceable", "wartungs-release",
      // "bug-fixes"), and treating those as falsifiable specs made this condition reject
      // 83% of correctly-grounded answers (see tests/anchoring-corpus-measure.test.ts).
      // The falsifiable part of a compound is the segment that carries an identifier
      // SHAPE — letters and digits together ("i2s", "usb4", "v24", "im73a135v01") — so
      // split on hyphen/underscore and keep only those segments. "i2s-digital" still
      // yields "i2s" and is still caught against evidence saying "analog differential";
      // "four-usb4-connector" now checks "usb4" instead of the whole compound, which the
      // evidence could never contain verbatim.
      const segments = raw.split(/[-_]/).filter((seg) => /[a-z]/.test(seg) && /\d/.test(seg));
      if (segments.length === 0) continue;
      for (const seg of segments) {
        if (seen.has(seg)) continue;
        seen.add(seg);
        tokens.push(seg);
      }
      continue;
    } else {
      // Pure-numeric: a fabricated concrete number (a year "2027", a price "4999", a dotted
      // version "12.5.1") is one of the most common hallucination shapes and was previously
      // dropped entirely (the "treated separately below" that never existed). Keep a 4+ digit
      // run as a groundable spec token; short counts (≤3 digits) stay out — too ambiguous/common.
      if (raw.replace(/[.,\-_]/g, "").length < 4) continue;
    }
    seen.add(raw);
    tokens.push(raw);
  }
  return tokens;
}

/**
 * Negation markers in common languages used to flag a contrastive reference
 * ("not I2S", "kein 5G", "sans gluten"). Topic-neutral: the only property
 * we rely on is that the marker is a single token preceding the claim; we do
 * not encode any domain vocabulary.
 */
// Latin-script only: isClaimNegatedIn tokenizes with a Latin character class, so CJK markers
// were unreachable dead entries (every CJK codepoint is a separator, so they never landed in the
// word list). Dropped so the list reflects actual capability rather than implying CJK coverage.
const NEGATION_MARKERS = [
  "not", "no", "non", "nor", "without", "neither",
  "kein", "keine", "keinen", "keinem", "keiner", "keines",
  "nicht", "nie", "niemals", "ohne",
  "ne", "pas", "aucun", "aucune", "sans", "ni",
];

/**
 * True when the given claim-text appears in a NEGATED context inside the
 * provided text. We look back up to four tokens before the claim for a
 * negation marker ("not", "kein", "sans", ...), OR we look for a
 * coordination list of negated items ("not X, Y, or Z") where the same
 * negation governs several alternatives — the canonical example is
 * "not a PDM or I2S digital part" vs evidence "NOT PDM", where the
 * "not" governs both alternatives even though only "PDM" appears
 * verbatim in the evidence. Topic-neutral: any domain that uses
 * standard negation markers or coordination lists is covered.
 */
function isClaimNegatedIn(text: string, claimText: string): boolean {
  if (!claimText) return false;
  const idx = text.indexOf(claimText);
  if (idx < 0) return false;
  const before = text.slice(Math.max(0, idx - 32), idx);
  const words = before.split(/[^a-zA-ZÀ-ſ'-]+/).filter(Boolean);
  for (let i = Math.max(0, words.length - 4); i < words.length; i++) {
    if (NEGATION_MARKERS.includes(words[i]!.toLowerCase())) return true;
  }
  return false;
}
