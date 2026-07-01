// Terminal honesty/guard blocks that fire on the assembled `finalResponse` near the
// END of the no-tool-calls turn pipeline, extracted from runtime.ts verbatim to shrink
// the god-file. Each guard READS the finalResponse + turn-state signals and PRODUCES the
// corrected finalResponse, pushing any guardrailEvents in place. Behavior-preserving: the
// blocks are moved unchanged (only closure-var reads became explicit params), so the audit
// events, severities, and ordering are identical to the inline originals.
import { getConfig } from "../config/loader.js";
import { logAudit } from "../audit/logger.js";
import { getSharedFactsEvidenceForFinalSynthesis } from "./evidence-recovery.js";
import {
  answerPresentsSourceCitations,
  stripFabricatedCitations,
  prependUnverifiedSourceCaveat,
  userMessageCarriesActionableUrl,
  prependUrlNotFetchedCaveat,
} from "./citation-honesty.js";

export interface CitationHonestyGuardParams {
  /** The assembled, user-facing answer this guard may rewrite. */
  finalResponse: string;
  /** The user's original message — passed to the unverified-source caveat. */
  userMessage: string;
  /** Session id used for shared-facts lookup and audit scoping. */
  sessionId: string;
  /** Names of every tool called this turn (Map<toolName, count>). */
  turnToolCallCounts: Map<string, number>;
  /** Number of agent delegations executed this turn. */
  turnDelegationCount: number;
  /** Whether a run_workflow actually SUCCEEDED this turn. */
  workflowRunCompletedThisTurn: boolean;
  /** Number of share_finding calls executed this turn. */
  turnShareFindingCount: number;
  /** Guardrail events array — appended to in place (mutated), mirroring the inline original. */
  guardrailEvents: Array<{ type: string; details: string }>;
}

/**
 * Citation-honesty guard (orchestration.citationHonestyGuard) — FULLY STRUCTURAL, no input
 * classification. ANY answer that presents URL citations but ran NO real web/research
 * execution this turn is fabricating sources (audit 1303e254: 7 invented 404 URLs, zero
 * delegation, only a failed run_workflow). Strip the fabricated URLs + prepend the honest
 * unverified caveat so no 404 link ever ships and any "verified" framing is corrected.
 * Both the trigger (answer carries URLs) and the gate (no real delegation / SUCCESSFUL
 * workflow / direct web tool / shared findings ran) are STRUCTURAL + language-free — there
 * is NO sourceSensitive keyword gate (de-lexicalized): a fabricated link is caught whatever
 * the question was, in any language; a genuinely-researched answer keeps its citations.
 *
 * Returns the (possibly rewritten) finalResponse. guardrailEvents is appended in place.
 */
export async function applyCitationHonestyGuard(
  params: CitationHonestyGuardParams,
): Promise<{ finalResponse: string }> {
  const {
    userMessage,
    sessionId,
    turnToolCallCounts,
    turnDelegationCount,
    workflowRunCompletedThisTurn,
    turnShareFindingCount,
    guardrailEvents,
  } = params;
  let finalResponse = params.finalResponse;

  if (getConfig().orchestration?.citationHonestyGuard === true) {
    const presentsCitations = answerPresentsSourceCitations(finalResponse);
    // The user handed the assistant a URL to READ and the answer is substantial enough to be
    // presenting the page's content (session 29796f86: a fabricated job posting from a link that
    // was never fetched). The 400-char floor keeps an honest short "I couldn't fetch it — shall
    // I?" out of the net. Both triggers are STRUCTURAL + language-free.
    const userGaveUrlToRead = userMessageCarriesActionableUrl(userMessage) && finalResponse.trim().length >= 400;

    if (presentsCitations || userGaveUrlToRead) {
      const isWebReachingTool = (t: string) => /^web_search/i.test(t) || /^web_fetch$/i.test(t) || /^browser_/i.test(t);
      const webToolCalledDirectly = [...turnToolCallCounts.keys()].some(isWebReachingTool);
      const sharedFactsForCitation = await getSharedFactsEvidenceForFinalSynthesis(sessionId);
      const hadRealResearch = turnDelegationCount > 0
        || workflowRunCompletedThisTurn
        || webToolCalledDirectly
        || turnShareFindingCount > 0
        || (sharedFactsForCitation?.itemCount ?? 0) > 0;

      if (presentsCitations && !hadRealResearch) {
        finalResponse = prependUnverifiedSourceCaveat(stripFabricatedCitations(finalResponse), userMessage);
        guardrailEvents.push({ type: "guardrail_flagged", details: "fabricated_citations_stripped" });
        logAudit("guardrail_flagged", {
          type: "fabricated_citations_stripped",
          trigger: "structural_url_citation_without_research",
        }, { sessionId, severity: "warn" });
      } else if (userGaveUrlToRead && !hadRealResearch) {
        // A URL the user gave was never fetched (no delegation / web tool / research this turn),
        // yet the answer speaks to its content → the content is fabricated. Prepend the honest
        // "not fetched" caveat so the invented page-content is never presented as authoritative.
        finalResponse = prependUrlNotFetchedCaveat(finalResponse);
        guardrailEvents.push({ type: "guardrail_flagged", details: "url_content_unverified_no_fetch" });
        logAudit("guardrail_flagged", {
          type: "url_content_unverified_no_fetch",
          trigger: "structural_user_url_without_fetch",
        }, { sessionId, severity: "warn" });
      }
    }
  }

  return { finalResponse };
}
