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

/**
 * True when a deliverable is dominated by repeated near-identical sections — the
 * signature of a slow local model that collapsed into a repetition loop during
 * synthesis. Such output must never ship verbatim.
 */
export function looksLikeDegenerateRepetition(text: string): boolean {
  const judged = splitMarkdownSections(text).filter((s) => sectionFingerprint(s).length >= 40);
  if (judged.length < 4) return false;
  const unique = new Set(judged.map(sectionFingerprint));
  return unique.size <= Math.ceil(judged.length * 0.5);
}

/**
 * Collapse repeated near-identical markdown sections to their first occurrence,
 * preserving order and every genuinely-unique section. Turns a 17×-looped block
 * into the clean, de-duplicated answer the user should have received.
 */
export function collapseRepeatedMarkdownSections(text: string): string {
  const sections = splitMarkdownSections(text);
  if (sections.length < 3) return text;
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const section of sections) {
    const fp = sectionFingerprint(section);
    if (fp.length < 40) { kept.push(section); continue; } // too short to judge — keep
    if (seen.has(fp)) continue;
    seen.add(fp);
    kept.push(section);
  }
  return kept.join("\n").trim();
}
