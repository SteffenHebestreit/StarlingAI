/**
 * Shared-facts / evidence / recovery-backstop cluster (god-file seam).
 *
 * Extracted verbatim from runtime.ts to shrink the hot file. These functions
 * format the swarm's curated shared findings for final synthesis, choose the
 * best available recovery evidence when a delegation fails or times out, and
 * build the honest user-facing backstop messages that present whatever grounded
 * evidence WAS gathered (never raw tool dumps). They are the "never ship a blank
 * or fabricated answer when the run collected real facts" safety net.
 *
 * The pure low-level helpers used here (countStructuredItems,
 * looksLikeOrchestrationOnlyEvidence, looksLikeDelegationTaskEcho,
 * stripPresentationFormatting) now live in the leaf module ./runtime-utils.ts, so
 * importing them no longer creates a cycle. Only forceSynthesis (which drives a
 * model call) still comes from runtime.ts; that import is call-time only (no
 * top-level use), so the one remaining runtime.ts ↔ evidence-recovery.ts edge is
 * safe under ESM.
 */
import { childLogger } from "../logger.js";
import { readAllFacts } from "../swarm/memory.js";
import {
  isJunkEvidenceValue,
  looksLikeRawSharedFactsDump,
  looksLikeRawWorkspaceToolDump,
  trimSharedFactDisplayTail,
} from "./runtime-evidence-dump.js";
import { looksEvidenceAnchored, sharesEvidenceVocabulary } from "./evidence-anchoring.js";
import {
  countStructuredItems,
  looksLikeOrchestrationOnlyEvidence,
  looksLikeDelegationTaskEcho,
  stripPresentationFormatting,
} from "./runtime-utils.js";
// `forceSynthesis` is NOT a pure leaf (it drives a model call + formats facts) so it
// stays in runtime.ts. This single call-time-only import is the remaining
// runtime.ts ↔ evidence-recovery.ts edge; the pure helpers above moved to the leaf.
import { forceSynthesis } from "./runtime.js";
import type { AgentSession } from "./session.js";
import type { ChatProvider } from "../providers/lmstudio.js";

const log = childLogger("agent:runtime");

export async function formatSharedFactsForFinalSynthesis(sessionId: string, maxChars = 4_000): Promise<string> {
  try {
    const facts = await readAllFacts(sessionId);
    const entries = Object.entries(facts)
      .filter(([, value]) => value.trim().length > 0)
      .sort(([left], [right]) => left.localeCompare(right));
    if (entries.length === 0) return "";

    const lines: string[] = [];
    let usedChars = 0;
    for (const [key, value] of entries) {
      const line = `- ${key}: ${value.replace(/\s+/g, " ").trim()}`;
      if (usedChars + line.length > maxChars && lines.length > 0) break;
      lines.push(line.length > maxChars ? `${line.slice(0, maxChars - 3)}...` : line);
      usedChars += line.length;
      if (lines.length >= 20) break;
    }

    return [
      "[SHARED FINDINGS AVAILABLE] Use these shared findings when producing the final answer. Do not duplicate work or answer from training data when a shared finding covers the fact.",
      ...lines,
    ].join("\n");
  } catch (err) {
    log.debug({ err, sessionId }, "Failed to load shared findings for final synthesis");
    return "";
  }
}

export async function hasSharedFactsForFinalSynthesis(sessionId: string): Promise<boolean> {
  try {
    const facts = await readAllFacts(sessionId);
    return Object.values(facts).some((value) => value.trim().length >= 80);
  } catch (err) {
    log.debug({ err, sessionId }, "Failed to check shared findings for final synthesis");
    return false;
  }
}

// True when most non-empty lines of an evidence blob are raw-tool junk — used to
// reject a long raw dump in favour of concise curated findings.
export function evidenceIsMostlyJunk(evidence: string): boolean {
  const lines = evidence.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  const junk = lines.filter((l) => isJunkEvidenceValue(l)).length;
  return junk / lines.length >= 0.5;
}

export async function getSharedFactsEvidenceForFinalSynthesis(
  sessionId: string,
  maxChars = 4_000,
): Promise<{ evidence: string; itemCount: number } | null> {
  try {
    const facts = await readAllFacts(sessionId);
    const entries = Object.entries(facts)
      .filter(([, value]) => value.trim().length > 0)
      // Raw tool dumps (PDF bytes, bare HTTP probes) are not user-facing evidence
      // and would otherwise fill the budget ahead of curated findings.
      .filter(([, value]) => !isJunkEvidenceValue(value))
      // Curated share_finding entries (claims/specs, e.g. im73a135v01_verified_specs)
      // first; auto_<agent>_<tool>_<hash> raw shares last. The old plain
      // alphabetical sort let auto_* junk crowd out the verified findings.
      .sort(([left], [right]) => {
        const lj = left.startsWith("auto_") ? 1 : 0;
        const rj = right.startsWith("auto_") ? 1 : 0;
        if (lj !== rj) return lj - rj;
        return left.localeCompare(right);
      });
    if (entries.length === 0) return null;

    const lines: string[] = [];
    let usedChars = 0;
    for (const [key, value] of entries) {
      const line = `- ${key}: ${value.replace(/\s+/g, " ").trim()}`;
      if (usedChars + line.length > maxChars && lines.length > 0) break;
      lines.push(line.length > maxChars ? `${line.slice(0, maxChars - 3)}...` : line);
      usedChars += line.length;
      if (lines.length >= 20) break;
    }

    const evidence = lines.join("\n").trim();
    if (!evidence) return null;

    const itemCount = countStructuredItems(evidence);
    if (itemCount < 1 && evidence.length < 80) return null;

    return { evidence, itemCount };
  } catch (err) {
    log.debug({ err, sessionId }, "Failed to build shared-findings evidence for final synthesis");
    return null;
  }
}

/**
 * Reformat a raw shared-facts dump into a user-readable list. Strips the
 * `auto_<agent>_<tool>_<hash>:` keys and the `[agent/tool]` provenance tag
 * (still useful for the LLM context but noisy for end users), and rewrites
 * mid-word "..." truncations to clean ellipses at sentence/word boundaries.
 *
 * Handles both the bullet-line shape (`- auto_xxx: <value>`) and the
 * `read_shared_facts` heading shape (`## Shared Session Facts (N) **auto_xxx**:
 * <value> **auto_yyy**: <value>`), splitting on whichever marker is present.
 *
 * Non-shared-facts evidence (e.g. delegation evidence with structured
 * markdown) is returned unchanged so we don't accidentally damage real
 * dossiers that happen to land on this code path.
 */
function formatSharedFactsRecoveryForUserDisplay(evidence: string): string {
  if (!looksLikeRawSharedFactsDump(evidence)) return evidence;
  // Strip shared-facts framing that would otherwise leak into the output:
  //   `- read_shared_facts:` prefix the coordinator added when the
  //   tool result was harvested as a recovery evidence snippet, and the
  //   `## Shared Session Facts (N)` heading from `read_shared_facts`.
  const stripped = evidence
    .replace(/^[ \t]*-\s+read_shared_facts:\s*/im, "")
    .replace(/##\s+Shared\s+Session\s+Facts\s+\(\d+\)\s*/i, "")
    // Defense-in-depth: our own injected agent hint must never reach the user, even
    // for facts stored before result-shaping started stripping it (audit 65f46046).
    .replace(/💡?\s*If this content is useful for your task,?\s*call share_finding now[\s\S]*?(?:runs out\.?|(?=\n)|$)/gi, "")
    .trim();
  // Split on whichever auto-key marker is present:
  //   `- auto_xxx_yyy:` (bullet-line shape) — preserve the leading split
  //   `**auto_xxx_yyy**:` (heading shape) — preserve same
  const splitRe = /(?=(?:^|[\s])[ \t]*-?\s*(?:\*\*)?auto_[a-z0-9_]+(?:\*\*)?:)/gim;
  const blocks = stripped
    .split(splitRe)
    .map((block) => block.trim())
    .filter(Boolean);
  const cleanedBlocks: string[] = [];
  for (const rawBlock of blocks) {
    const cleaned = rawBlock
      .replace(/^[ \t]*-\s+/, "")
      .replace(/^\*\*auto_[a-z0-9_]+\*\*:\s*/i, "")
      .replace(/^auto_[a-z0-9_]+:\s*/i, "")
      .replace(/^\[[^\]]+\]\s*/, "")
      .trim();
    if (!cleaned) continue;
    cleanedBlocks.push(`- ${trimSharedFactDisplayTail(cleaned)}`);
  }
  if (cleanedBlocks.length === 0) return evidence;
  return cleanedBlocks.join("\n\n");
}

export function buildRecoveryEvidenceUserMessage(evidence: string): string {
  const formatted = formatSharedFactsRecoveryForUserDisplay(evidence);
  // Bilingual preamble + suffix so this works whether the user wrote in German
  // or English. Both are short — the evidence is the bulk of the message.
  return [
    "Die Recherche wurde unterbrochen, bevor ein vollständiges Dossier fertiggestellt werden konnte. Die bisher gesammelten Quellen und Fakten:",
    formatted,
    // Topic-agnostic footer. NEVER name domain-specific sections here (an earlier version
    // hardcoded "(Produkt-Empfehlungen, Verdrahtung, BOM, Verbesserungen)" — overfit to one
    // hardware-BOM request, audit 65f46046 surfaced it verbatim on a Dresden architecture deck).
    "Falls Abschnitte fehlen, starte den Lauf bei Bedarf mit einem engeren Fokus erneut, damit ein Spezialist die noch offenen Punkte vollständig abdecken kann.\n(If anything is missing, you can re-run with a narrower focus so a specialist can complete the remaining sections.)",
  ].join("\n\n");
}

export function formatRecoveryEvidenceForFinalUser(
  evidence: string,
  options?: { sourceSensitive?: boolean },
): string {
  if (looksLikeRawSharedFactsDump(evidence)) return buildRecoveryEvidenceUserMessage(evidence);
  if (options?.sourceSensitive) return formatSourceSensitiveEvidenceBackstop(evidence);
  return evidence;
}

/**
 * Honest user-facing message for the "research succeeded but the artifact step failed"
 * end-state. Surfaces the curated, sourced findings (so the gathered work isn't lost)
 * under a bilingual could-not-finish preamble — never the raw dump. Used by the
 * last-resort terminal guard.
 */
export function buildResearchGatheredFallback(curatedEvidence: string | null, isArtifactRequest = true): string {
  // The preamble must match what the user actually asked for. An artifact-creation turn
  // that couldn't finish the file gets the "build pending" framing; a plain research /
  // advice request never asked for a file, so apologizing about an unbuilt "HTML file" is
  // wrong and confusing (audit 49372c7a: a hardware-BOM Q&A is not an artifact build).
  // There the curated, sourced facts ARE the deliverable — present them as the answer.
  const head = isArtifactRequest
    ? [
        "Ich konnte das angeforderte Artefakt (z. B. die HTML-Datei) in diesem Lauf nicht fertigstellen. "
        + "Die Inhalte wurden jedoch recherchiert und mit Quellen belegt — bestätige bitte, dann lasse ich die Datei vom zuständigen Spezialisten erstellen.",
        "I couldn't finish the requested artifact (e.g. the HTML file) this turn, but the content was researched and sourced — confirm and I'll have the content specialist build the file.",
      ].join("\n\n")
    : [
        "Hier sind die recherchierten, mit Quellen belegten Fakten zu deiner Anfrage.",
        "Here are the researched, sourced facts for your request.",
      ].join("\n\n");
  const curated = curatedEvidence?.trim();
  if (curated) {
    return `${head}\n\n## Recherchierte Fakten & Quellen / Researched facts & sources\n\n${formatSharedFactsRecoveryForUserDisplay(curated)}`;
  }
  return head;
}

function compactSourceSensitiveEvidenceForDisplay(evidence: string): string {
  const lines = evidence
    .split("\n")
    .map((rawLine) => rawLine.trim())
    .filter(Boolean)
    .map((rawLine) => {
      let line = rawLine
        .replace(/^-\s+auto_[a-z0-9_]+:\s*/i, "- ")
        .replace(/\s*###\s*Page state\b[\s\S]*$/i, "")
        .replace(/\s*Page Snapshot:\s*[\s\S]*$/i, "")
        .replace(/```[\s\S]*?```/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (line.length > 900) line = `${line.slice(0, 897)}...`;
      return line;
    })
    .filter((line) => !looksLikeOrchestrationOnlyEvidence(line))
    // Drop raw PDF bytes / bare HTTP-probe lines — never show binary or
    // header-only junk to the user as "evidence".
    .filter((line) => !isJunkEvidenceValue(line))
    .filter((line) => line.length > 0);
  return lines.join("\n").trim() || "In diesem Lauf wurde keine verwertbare fachliche Evidenz erzeugt.";
}

export function formatSourceSensitiveEvidenceBackstop(evidence: string): string {
  const compactEvidence = compactSourceSensitiveEvidenceForDisplay(evidence);
  return [
    "Die bisher belastbare Evidenz aus diesem Lauf:",
    compactEvidence,
    "Alle übrigen angefragten Aussagen bleiben unverifiziert oder unvollständig, bis eine erfolgreiche Quellenrecherche vorliegt.",
  ].join("\n\n");
}

/**
 * QA evidence-anchoring decision (gated by orchestration.qaEvidenceAnchoring).
 * True when a source-sensitive answer that shipped on the SUCCESS path (the
 * failure-path backstop never fired) should be re-grounded: there ARE usable
 * curated findings, the answer is substantial, yet it references none of the
 * verified tokens — i.e. the model likely answered from training data while the
 * run's verified facts sit unused in shared findings. Pure + exported for tests.
 */
export function answerNeedsEvidenceAnchoringRepair(
  finalResponse: string,
  evidence: string | null | undefined,
): boolean {
  if (!evidence) return false;
  if (looksLikeWeakRecoveryEvidence(evidence)) return false;
  const draft = stripPresentationFormatting(finalResponse).trim();
  if (draft.length <= 200) return false;
  return !looksEvidenceAnchored(draft, evidence);
}

export async function synthesizeSourceSensitiveEvidenceBackstop(
  session: AgentSession,
  provider: ChatProvider,
  signal: AbortSignal,
  evidence: string,
): Promise<string | null> {
  const instruction = [
    "SOURCE-SENSITIVE RECOVERY SYNTHESIS:",
    "The prior delegation failed or timed out, but the evidence below was recovered. Answer the user in German using ONLY this recovered evidence and shared findings.",
    "Do not invent missing manufacturer, interface, protocol, pricing, layout, BOM, or product claims. If a requested section is not supported by the evidence, mark it as unverifiziert/unvollstaendig.",
    "Do not dump raw page snapshots or tool traces. Convert supported evidence into a concise useful partial answer with: 1) Verifiziert, 2) Noch nicht belegt, 3) Naechster sinnvoller Recherche-Schritt.",
    "Recovered evidence:",
    evidence.trim(),
  ].join("\n");
  const synthesized = await forceSynthesis(session, provider, signal, instruction);
  if (!synthesized) return null;
  const cleaned = stripPresentationFormatting(synthesized).trim();
  // Lighter gate than the model's free draft: this pass is prompt-constrained to
  // evidence-only with explicit unverified-marking, so accept it as long as it
  // demonstrably USED the evidence. Requiring the full per-spec anchoring here just
  // discards a usable hedged partial for the raw-dump fallback (audit f7928f57).
  if (!sharesEvidenceVocabulary(cleaned, evidence)) return null;
  return cleaned;
}

export function looksLikeWeakRecoveryEvidence(evidence: string): boolean {
  const trimmed = evidence.trim();
  if (!trimmed) return true;
  if (looksLikeRawWorkspaceToolDump(trimmed)) return true;
  if (/^Sub-agent '[^']+' timed out/i.test(trimmed)) return true;
  if (/Partial progress before interruption:/i.test(trimmed)) return true;
  if (/^Recovered evidence snippets from completed tools:/im.test(trimmed)) return true;
  if (/^(?:-\s*)?(?:search_agents|search_workflows)\s+\[partial\]/im.test(trimmed)) return true;
  if (/No (?:agents|workflows) matched/i.test(trimmed)) return true;
  if (looksLikeDelegationTaskEcho(trimmed)) return true;
  return false;
}

export function chooseBetterRecoveryEvidence(
  delegateEvidence: { evidence: string; itemCount: number } | null,
  sharedFactsEvidence: { evidence: string; itemCount: number } | null,
  options?: { preferHigherScore?: boolean },
): { evidence: string; itemCount: number } | null {
  if (!delegateEvidence) return sharedFactsEvidence;
  if (looksLikeWeakRecoveryEvidence(delegateEvidence.evidence)) {
    return sharedFactsEvidence;
  }
  // A delegate "evidence" blob that is mostly raw tool junk (PDF bytes, HTTP
  // probes) must not win on length over concise curated findings — that is what
  // shipped %PDF garbage instead of the verified specs the swarm had gathered.
  if (sharedFactsEvidence && evidenceIsMostlyJunk(delegateEvidence.evidence)) {
    return sharedFactsEvidence;
  }
  if (!sharedFactsEvidence) return delegateEvidence;

  if (options?.preferHigherScore === false) {
    return delegateEvidence;
  }

  const delegateScore = delegateEvidence.evidence.length + (delegateEvidence.itemCount * 200);
  const sharedScore = sharedFactsEvidence.evidence.length + (sharedFactsEvidence.itemCount * 200);
  return sharedScore > delegateScore ? sharedFactsEvidence : delegateEvidence;
}
