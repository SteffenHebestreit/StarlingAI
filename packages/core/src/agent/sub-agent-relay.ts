/**
 * A coordinator passing a specialist's answer on as it stands.
 *
 * A coordinator that hands a task to one specialist used to write that specialist's answer out a
 * second time as its own final answer: the same table, the same sources, reworded. In a live
 * weather turn (2026-11-14) that rewrite was the coordinator's last model call, 25 s of a 185 s
 * turn, for an answer the researcher had already finished. Whether an answer is complete is in
 * its words and the task's, in any language, so the model decides: a run that can delegate is
 * offered to reply with the marker alone (RELAY_OFFER), and the runtime then puts the last
 * delegation's answer in its place. Whether that answer CAN be passed on is the runtime's: only a
 * delegation that ended as a success, in full, with no figure its record had to mask, and only
 * the last one — a fan-out, a failure or a partial after it leaves nothing to pass on, and the
 * model is asked once to write the answer itself.
 *
 * The offer rides on the delegation's result (RELAY_OFFER), where the model reads it as it decides
 * what to answer. As a line in the run's head it was not taken up: 0 of 8 coordinator runs on the
 * live model used it, each writing the specialist's answer out again.
 */
import { readExecutionRecord, stripDelegatedRunRecord, unbackedFiguresMasked } from "./delegated-run-record.js";
import { stripDelegateRelayFrame } from "./runtime-evidence-dump.js";

export const RELAY_MARKER = "<relay/>";
const RELAY_MARKER_RE = /<relay\s*\/?>/gi;
/** Text beside the marker that still counts as the marker alone ("Here it is: <relay/>"). */
const RELAY_LEAD_IN_MAX_CHARS = 200;

/**
 * Appended to a delegate_to_agent result whose answer can be passed on (relayableDelegationAnswer),
 * when it was the only delegation of its response.
 */
export const RELAY_OFFER = "[PASS IT ON] This answer can go out as it stands. If it answers the whole task, reply with exactly "
  + RELAY_MARKER
  + " and nothing else instead of rewording it: rewording costs time and adds nothing. Write your own answer only when you must add, combine or correct something.";

/** The tools after which the last delegation's answer is no longer the one to pass on. */
export const RELAY_RESETTING_TOOLS: ReadonlySet<string> = new Set([
  "parallel_delegate",
  "run_task_graph",
  "run_workflow",
  "swarm_delegate",
  "execute_plan",
]);

export interface RelayableDelegation {
  agentName: string;
  answer: string;
}

interface DelegationToolResult {
  success: boolean;
  output: string;
  metadata?: Record<string, unknown>;
}

/**
 * The answer of a delegate_to_agent result when it can be passed on as it stands, else null: the
 * delegation succeeded in full (not a partial, a loop or a warden stop, a run that ran to its end)
 * and its record masked no figure. The answer is the specialist's own text, without the
 * "[agent]:" label, the routing note and the run record.
 */
export function relayableDelegationAnswer(result: DelegationToolResult): RelayableDelegation | null {
  const meta = result.metadata ?? {};
  if (!result.success || meta["delegationSucceeded"] !== true) return null;
  if ((meta["delegationOutcome"] ?? "success") !== "success") return null;
  if (meta["partialFallback"] || meta["loopEnforced"] || meta["wardenStop"]) return null;
  if (typeof meta["terminalState"] === "string" && meta["terminalState"] !== "completed") return null;
  if (unbackedFiguresMasked(readExecutionRecord(meta["specialistExecutions"]))) return null;
  const agentName = typeof meta["agentName"] === "string" ? meta["agentName"] : "";
  const answer = stripDelegatedRunRecord(stripDelegateRelayFrame(result.output ?? "")).trim();
  if (!agentName || answer.length === 0) return null;
  // A specialist that itself replied with the marker had nothing of its own to pass on.
  if (new RegExp(RELAY_MARKER_RE.source, "i").test(answer)) return null;
  return { agentName, answer };
}

/**
 * How a final reply reads: "relay" when it is the marker alone (or beside a short lead-in),
 * "own" when it carries the marker inside an answer of its own (the marker is dropped and the
 * answer stands), "none" without the marker.
 */
export function readRelayMarker(reply: string): { kind: "relay" | "own" | "none"; text: string } {
  if (!new RegExp(RELAY_MARKER_RE.source, "i").test(reply)) return { kind: "none", text: reply };
  const rest = reply.replace(RELAY_MARKER_RE, "").trim();
  return rest.length <= RELAY_LEAD_IN_MAX_CHARS ? { kind: "relay", text: rest } : { kind: "own", text: rest };
}

/**
 * For a run the main assistant delegated directly that holds share_finding (agent/sub-agent.ts,
 * directRunNotice): its answer is the result, so it is not published first. A run under a
 * coordinator, whose siblings read shared facts while it works, does not get it.
 */
export const DIRECT_RUN_SHARE_NOTICE = "This task came to you directly from the assistant and no other agent works beside you on it: your final answer is the result, and the pages you fetch are shared for you. Do not call share_finding to publish your answer before you write it.";

/** The one correction a run gets when it asks to pass on an answer there is none of. */
export const RELAY_UNAVAILABLE_CORRECTION = "There is no single finished delegation answer to pass on: the last delegation failed, fell short, or was one of several. Write your final answer yourself from the results above.";
