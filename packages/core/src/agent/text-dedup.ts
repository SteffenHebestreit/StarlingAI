/**
 * Markdown repetition-collapse helpers — shared by every path that can ship a
 * model-authored deliverable (the runtime relay + final-answer sanitizer, and the
 * sub-agent single-delegation passthrough). A slow local model can collapse into a
 * repetition loop during synthesis and emit the same section many times (audit
 * 9fd16384: "Microphone Selection: …" emitted 17× with only one other unique
 * section). These helpers detect and de-duplicate that so it never reaches a user
 * or pollutes a parent agent's synthesis input.
 */

/** Split markdown into sections at heading lines (## or deeper); text before the
 * first heading is its own leading section. */
function splitMarkdownSections(text: string): string[] {
  const lines = text.split("\n");
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (/^#{2,6}\s/.test(line) && current.length > 0) {
      sections.push(current.join("\n"));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) sections.push(current.join("\n"));
  return sections;
}

/** Normalized fingerprint of a section for near-duplicate detection: drop heading
 * markers + ordinal numbering ("### 3. " ≡ "### 5. "), lowercase, collapse space. */
function sectionFingerprint(section: string): string {
  return section
    .replace(/#{2,6}\s+\d+[.)]?\s*/g, "")
    .replace(/#{2,6}\s+/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim()
    .slice(0, 300);
}

/** True when a deliverable is dominated by repeated near-identical heading sections. */
function looksLikeDegenerateSectionRepetition(text: string): boolean {
  const judged = splitMarkdownSections(text).filter((s) => sectionFingerprint(s).length >= 40);
  if (judged.length < 4) return false;
  const unique = new Set(judged.map(sectionFingerprint));
  return unique.size <= Math.ceil(judged.length * 0.5);
}

/** Normalized fingerprint of a single line for repetition detection: drop markdown
 * emphasis/heading/quote markers + leading list/ordinal bullets, lowercase, collapse
 * whitespace. Returns "" for lines too short (≤30 non-space chars) to judge — bullets,
 * separators, and blanks must never count toward a repetition verdict. */
function lineFingerprint(line: string): string {
  const fp = line
    .replace(/[*_`#>]+/g, " ")
    .replace(/^\s*(?:[-+]|\d+[.)])\s+/, " ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
  return fp.replace(/\s/g, "").length >= 30 ? fp : "";
}

/**
 * True when an answer is dominated by a repeated line/paragraph — the slow-local-model
 * "**Korrekte Komponente:** … Nein." loop (audit 9a6a8c7f turn 2: one 30+char line
 * emitted ~15× as the orchestrator's direct answer). Complements the heading-section
 * detector for loops that carry no intervening headings, which {@link splitMarkdownSections}
 * collapses into a single "unique" section and therefore misses.
 */
export function looksLikeDegenerateLineRepetition(text: string): boolean {
  const fps = text.split("\n").map(lineFingerprint).filter((f) => f.length > 0);
  if (fps.length < 6) return false;
  const counts = new Map<string, number>();
  for (const fp of fps) counts.set(fp, (counts.get(fp) ?? 0) + 1);
  let maxRepeat = 0;
  let duplicates = 0;
  for (const c of counts.values()) {
    if (c > maxRepeat) maxRepeat = c;
    if (c > 1) duplicates += c - 1;
  }
  // A 30+char line that recurs 4+ times is never legitimate prose; or duplicate lines
  // make up at least half of the judged body.
  return maxRepeat >= 4 || duplicates >= fps.length * 0.5;
}

/**
 * True when a deliverable is dominated by repeated near-identical sections OR by a
 * repeated line/paragraph — both are signatures of a slow local model that collapsed
 * into a repetition loop during synthesis. Such output must never ship verbatim.
 */
export function looksLikeDegenerateRepetition(text: string): boolean {
  return looksLikeDegenerateSectionRepetition(text) || looksLikeDegenerateLineRepetition(text);
}

/**
 * Collapse a line/paragraph-level repetition loop to the first occurrence of each
 * judged line, preserving order and every short/structural line, then squeeze the
 * blank-line runs left behind by dropped paragraphs.
 */
export function collapseRepeatedLines(text: string): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const fp = lineFingerprint(line);
    if (fp.length === 0) { kept.push(line); continue; }
    if (seen.has(fp)) continue;
    seen.add(fp);
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Collapse repeated near-identical markdown sections to their first occurrence,
 * preserving order and every genuinely-unique section. Turns a 17×-looped block
 * into the clean, de-duplicated answer the user should have received. Then, if a
 * line/paragraph-level loop survives (one carrying no intervening headings, e.g. a
 * single section full of repeated "… Nein." paragraphs), collapse that too.
 */
export function collapseRepeatedMarkdownSections(text: string): string {
  let result = text;
  const sections = splitMarkdownSections(text);
  if (sections.length >= 3) {
    const seen = new Set<string>();
    const kept: string[] = [];
    for (const section of sections) {
      const fp = sectionFingerprint(section);
      if (fp.length < 40) { kept.push(section); continue; } // too short to judge — keep
      if (seen.has(fp)) continue;
      seen.add(fp);
      kept.push(section);
    }
    result = kept.join("\n").trim();
  }
  return looksLikeDegenerateLineRepetition(result) ? collapseRepeatedLines(result) : result;
}
