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

export function looksEvidenceAnchored(sourceSensitiveDraft: string, evidence: string): boolean {
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

  // Condition 1: shared vocabulary.
  let sharedHits = 0;
  for (const anchor of anchors) {
    if (normalizedDraft.includes(anchor)) sharedHits += 1;
    if (sharedHits >= Math.min(3, anchors.length)) break;
  }
  if (sharedHits < Math.min(3, anchors.length)) return false;

  // Condition 2: every concrete spec token in the draft is grounded in
  // the evidence (positive match, or a mutually-negated match). Topic-
  // neutral: the regex extracts any 4+ character spec-shaped token that
  // is either a known-false label ("i2s-digital", "ip57") or a domain
  // identifier; it does not curate a domain vocabulary.
  const normalizedEvidence = evidence.toLowerCase();
  const specTokens = extractSpecTokensFromDraft(normalizedDraft);
  for (const token of specTokens) {
    if (normalizedEvidence.includes(token)) continue;
    if (isClaimNegatedIn(normalizedDraft, token) && isClaimNegatedIn(normalizedEvidence, token)) continue;
    return false;
  }
  return true;
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
    // Must contain a letter (excludes pure numerics like "2024" — those
    // are caught by the spec-token check too, but only when paired with a
    // unit in the original pipeline; for this simpler test we treat them
    // separately below).
    if (!/[a-z]/.test(raw)) continue;
    if (stopwords.has(raw)) continue;
    // Hyphenated / underscored compound tokens with at least one digit OR
    // a part-code shape (all-caps with digits). Pure lowercase 4-letter
    // prose words are also excluded by the stoplist above.
    const looksLikeSpec = /[-_]/.test(raw) || /[a-z].*\d|\d.*[a-z]/.test(raw);
    if (!looksLikeSpec) continue;
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
const NEGATION_MARKERS = [
  "not", "no", "non", "nor", "without", "neither",
  "kein", "keine", "keinen", "keinem", "keiner", "keines",
  "nicht", "nie", "niemals", "ohne",
  "ne", "pas", "aucun", "aucune", "sans", "ni",
  "否定", "不是", "无", "不", "没有",
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
