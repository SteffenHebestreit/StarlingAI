/**
 * Proactive user-profile prefetch (orchestration.userProfilePrefetch, default-off).
 *
 * For a userOwnFacts turn — a question about the user's OWN background / skills /
 * experience / projects / fit — retrieve the user's stored memory records AND the
 * documents attached to this conversation (e.g. an uploaded CV / profile) up-front,
 * and render an authoritative evidence block. On a clean miss it returns a CONFIRMED-
 * EMPTY marker rather than nothing, so the model treats "looked and found nothing" as
 * a fact instead of guessing. This grounds the answer in a REAL lookup result instead
 * of leaving retrieval to model discretion (the toolCalls=0 "I have no info about you"
 * failure on the audited CV/Lead-Dev turn).
 *
 * Best-effort: each source degrades independently. Returns "" ONLY when BOTH sources
 * hard-error — the caller then falls back to the on-demand retrieve-first digest rather
 * than asserting a confirmed-empty result it did not actually establish.
 */
import { searchMemoryRecords } from "../memory/service.js";
import { retrieveDocumentContext } from "../retrieval/document-rag.js";

function truncate(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Pure renderer over already-retrieved records + chunks. Exported for unit testing
 * without hitting the memory/engram backends. `bothErrored` distinguishes "looked and
 * found nothing" (→ confirmed-empty marker) from "could not look" (→ "").
 */
export function renderUserProfileEvidence(
  records: ReadonlyArray<{ scope: string; kind: string; subject: string; content: string }> | null,
  chunks: ReadonlyArray<{ title?: string; documentId: string; text: string }> | null,
): string {
  if (records === null && chunks === null) return "";

  const sections: string[] = [];
  if (records && records.length > 0) {
    sections.push(
      "Stored memory about this user:\n"
      + records.map((r) => `- [${r.scope}/${r.kind}] ${r.subject}: ${truncate(r.content, 180)}`).join("\n"),
    );
  }
  if (chunks && chunks.length > 0) {
    sections.push(
      "Excerpts from documents this user has on file (e.g. an uploaded CV / profile):\n"
      + chunks.map((c) => `- [${c.title?.trim() || c.documentId.slice(0, 8)}] ${truncate(c.text, 240)}`).join("\n"),
    );
  }

  if (sections.length === 0) {
    // Retrieval RAN and found nothing — an authoritative confirmed-empty fact.
    return "[USER PROFILE EVIDENCE — retrieved this turn]\n"
      + "A profile lookup ran THIS turn over the user's stored memory and the documents attached to this "
      + "conversation, and found NOTHING on file about their background, skills, experience, or projects. "
      + "You may now state plainly that you have no stored information about them and ask them to provide it "
      + "(paste a CV, a few lines, or a link). Do NOT invent a profile.";
  }

  return "[USER PROFILE EVIDENCE — authoritative, retrieved this turn]\n"
    + sections.join("\n\n")
    + "\n\nGround your answer about the user in the evidence above. If it is insufficient for the specific "
    + "question, say what is missing and ask for it. Do NOT add experience, skills, employers, or history not "
    + "present above.";
}

/**
 * Retrieve the user's profile evidence (memory records + attached documents) and render
 * it. Each source is caught independently so one failing backend does not suppress the
 * other; "" is returned only when both error.
 */
export async function buildUserProfileEvidence(
  workspacePath: string,
  query: string,
  sessionId: string,
  userId?: string,
): Promise<string> {
  // Bias the DOCUMENT query toward the user's PROFILE rather than echoing the (often
  // vague) self-referential question — "passt X zu meinem Skillset?" matches a CV only
  // borderline, so engram returns it unreliably. A profile-oriented query reliably
  // surfaces the CV/profile chunks; the original question stays in the conversation for
  // the actual assessment. Memory records still use the raw query (subject-keyed).
  const profileQuery =
    `${query}\nProfil des Nutzers: Lebenslauf, beruflicher Werdegang, Berufserfahrung, `
    + `Fähigkeiten, Qualifikationen, Projekte, Ausbildung — the user's professional `
    + `background, work experience, skills, qualifications, projects, education (CV / resume).`;
  const [records, chunks] = await Promise.all([
    searchMemoryRecords(workspacePath, query, { limit: 6, sessionId }).catch(() => null),
    retrieveDocumentContext(profileQuery, { sessionId, ...(userId ? { userId } : {}) }).catch(() => null),
  ]);
  return renderUserProfileEvidence(records, chunks);
}
