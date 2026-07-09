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
import { listInScopeDocuments, retrieveDocumentContext } from "../retrieval/document-rag.js";

function truncate(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Profile-biased document query. Biases retrieval toward the user's CV/profile instead of
 * echoing a vague self-referential question ("passt X zu meinem Skillset?" matches a CV
 * only borderline). Shared so the per-turn document-RAG and this prefetch use the IDENTICAL
 * query — the per-turn RAG is the single doc retrieval on a userOwnFacts turn (dedup), and
 * its reliability hinges on this same bias.
 */
export function buildProfileBiasedQuery(query: string): string {
  return `${query}\nProfil des Nutzers: Lebenslauf, beruflicher Werdegang, Berufserfahrung, `
    + `Fähigkeiten, Qualifikationen, Projekte, Ausbildung — the user's professional `
    + `background, work experience, skills, qualifications, projects, education (CV / resume).`;
}

export interface RenderProfileOpts {
  /** The per-turn document-RAG is the single doc source this turn — omit the documents
   *  section here (the [DOCUMENT CONTEXT] message already carries the CV). */
  docsHandledElsewhere?: boolean;
  /** Whether the per-turn RAG actually injected a document context this turn — drives the
   *  confirmed-empty marker when docsHandledElsewhere is set. */
  documentsAlreadyInjected?: boolean;
  /** In-scope documents the user HAS on file (titles), independent of query relevance. When
   *  no excerpt reached the model this turn but this list is non-empty, the confirmed-empty
   *  marker becomes an honest "you have these documents on file" note instead of "found
   *  nothing" — so an existence/access question never falsely denies holding the user's CV. */
  availableDocuments?: ReadonlyArray<{ title?: string; documentId?: string; invalidated?: boolean }>;
}

/**
 * Pure renderer over already-retrieved records + chunks. Exported for unit testing
 * without hitting the memory/engram backends. With `docsHandledElsewhere`, documents are
 * NOT re-rendered here (the per-turn [DOCUMENT CONTEXT] carries them) and the confirmed-
 * empty fact keys off `documentsAlreadyInjected` instead of `chunks`.
 */
export function renderUserProfileEvidence(
  records: ReadonlyArray<{ scope: string; kind: string; subject: string; content: string }> | null,
  chunks: ReadonlyArray<{ title?: string; documentId: string; text: string }> | null,
  opts: RenderProfileOpts = {},
): string {
  const { docsHandledElsewhere = false, documentsAlreadyInjected = false, availableDocuments } = opts;
  // Both sources unavailable (only meaningful when this prefetch owns the doc lookup).
  if (records === null && chunks === null && !docsHandledElsewhere) return "";

  const sections: string[] = [];
  if (records && records.length > 0) {
    sections.push(
      "Stored memory about this user:\n"
      + records.map((r) => `- [${r.scope}/${r.kind}] ${r.subject}: ${truncate(r.content, 180)}`).join("\n"),
    );
  }
  if (!docsHandledElsewhere && chunks && chunks.length > 0) {
    sections.push(
      "Excerpts from documents this user has on file (e.g. an uploaded CV / profile):\n"
      + chunks.map((c) => `- [${c.title?.trim() || c.documentId.slice(0, 8)}] ${truncate(c.text, 240)}`).join("\n"),
    );
  }

  if (sections.length === 0) {
    // No memory evidence to add. Emit the confirmed-empty fact ONLY if NO documents were
    // found or injected anywhere this turn — otherwise the CV is already present (via the
    // per-turn [DOCUMENT CONTEXT] or the docs section above) and an empty profile block
    // would be noise (and would wrongly claim "found nothing").
    const docsFound = docsHandledElsewhere ? documentsAlreadyInjected : !!(chunks && chunks.length > 0);
    if (docsFound) return "";
    // The user HAS documents on file, but no excerpt ranked relevant to THIS question (an
    // existence/access question reranks every CV chunk negative). Tell the model the docs
    // EXIST so it never falsely denies access — but withhold their content (none matched),
    // so it can't fabricate from titles alone.
    if (availableDocuments && availableDocuments.length > 0) {
      const titles = availableDocuments
        .map((d) => {
          const name = d.title?.trim() || d.documentId?.slice(0, 8) || "document";
          // An outdated document is on file but its content is permanently un-retrievable
          // until re-uploaded — say so, so the model doesn't imply it can still be read.
          return d.invalidated ? `${name} (marked outdated — content not retrievable)` : name;
        })
        .join(", ");
      return "[USER PROFILE EVIDENCE — retrieved this turn]\n"
        + `The user HAS documents on file in their library: ${titles}. A profile lookup ran THIS turn, but no `
        + "excerpt from them ranked as relevant to this specific question — so you have their TITLES, not their "
        + "matched content, right now. Do NOT claim you have no access to the user's CV / documents — you DO have "
        + "them. Do NOT invent their contents. Acknowledge the document(s) by name; if you need their content, ask "
        + "the user to point to the relevant part or rephrase so the right section can be retrieved.";
    }
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
  opts: { skipDocRetrieval?: boolean; documentsAlreadyInjected?: boolean } = {},
): Promise<string> {
  // DEDUP: on a userOwnFacts turn the per-turn document-RAG already retrieved the CV with
  // the SAME profile-biased query (buildProfileBiasedQuery) and injected it as [DOCUMENT
  // CONTEXT]. So with skipDocRetrieval we do NOT re-fetch documents (that was the
  // duplicate ~4s engram round-trip + duplicate CV tokens) — we add only memory records,
  // and the renderer keys the confirmed-empty marker off whether the per-turn RAG found
  // docs. Memory records still use the raw query (subject-keyed).
  const [records, chunks] = await Promise.all([
    searchMemoryRecords(workspacePath, query, { limit: 6, sessionId }).catch(() => null),
    opts.skipDocRetrieval
      ? Promise.resolve(null)
      : retrieveDocumentContext(buildProfileBiasedQuery(query), { sessionId, ...(userId ? { userId } : {}) }).catch(() => null),
  ]);

  // When NO document excerpt reached the model this turn (the per-turn RAG injected nothing,
  // or our own retrieval matched nothing — e.g. an existence/access question reranks the CV
  // chunks negative), look up whether the user nonetheless HAS documents on file. This lets
  // the confirmed-empty marker honestly acknowledge the CV instead of denying access to it.
  const docsReachedModel = opts.skipDocRetrieval ? opts.documentsAlreadyInjected === true : !!(chunks && chunks.length > 0);
  const hasMemory = !!(records && records.length > 0);
  let availableDocuments: { title?: string; documentId: string }[] | undefined;
  if (!docsReachedModel && !hasMemory) {
    const inventory = await listInScopeDocuments({ sessionId, ...(userId ? { userId } : {}) }).catch(() => []);
    if (inventory.length > 0) {
      availableDocuments = inventory.map((d) => ({ ...(d.title ? { title: d.title } : {}), documentId: d.id, ...(d.invalidated ? { invalidated: true } : {}) }));
    }
  }

  return renderUserProfileEvidence(records, chunks, {
    docsHandledElsewhere: opts.skipDocRetrieval === true,
    documentsAlreadyInjected: opts.documentsAlreadyInjected === true,
    ...(availableDocuments && availableDocuments.length > 0 ? { availableDocuments } : {}),
  });
}
