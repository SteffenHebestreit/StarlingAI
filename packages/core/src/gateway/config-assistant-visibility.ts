/**
 * Who gets a config-assistant request's words back (found in review, 2026-10-08).
 *
 * The proposals store and flow memory are one file each for the whole deployment, and every
 * signed-in account, a viewer too, read every account's raw request text through
 * GET /api/flow-memory and GET /api/config-assistant/proposals; applying a proposal or giving it
 * feedback answered with it too. Nor is the request the only text written from it: the drafted
 * summary (the model's raw reply, when it could not be parsed), the reasons, the prompts and their
 * rationale, the checks, the lesson and the feedback notes all are. Under multi-user auth an item
 * goes whole only to its author, recorded on it as their user-scope segment, and to an admin. Every
 * other account gets its structure: ids, status, timestamps, config paths, prompt targets and
 * outcomes, which is enough to see that a change is pending or applied. The author's segment is
 * never sent. With one operator every item is theirs and goes out as it is stored.
 */
import { authenticatedUser, userHasRole } from "./auth.js";
import { canReadRecord, recordReader } from "../runtime/user-scope.js";
import type { ConversationConfigProposal } from "../agent/config-assistant-proposals.js";
import type { FlowMemoryEntry } from "../agent/flow-memory.js";

/** Whether an item written for `account` may go to this reader whole. */
export type RequestTextReader = (account: string | undefined) => boolean;

/** The reader the current request is: every item with multi-user auth off; under it an admin, or
 *  the item's author (a request with no user is neither). */
export async function requestTextReader(authHeader: string | undefined): Promise<RequestTextReader> {
  const reader = recordReader();
  if (reader.all) return () => true;
  const admin = userHasRole(await authenticatedUser(authHeader), "admin");
  return (account) => admin || canReadRecord(reader, account);
}

/** Every field of the item but the author's segment, in the order it is stored. */
function withoutAccount<T extends { account?: string }>(item: T): Omit<T, "account"> {
  const presented: Record<string, unknown> = { ...item };
  delete presented["account"];
  return presented as Omit<T, "account">;
}

/** A proposal as a response carries it: whole for a reader who may have it, else its structure. */
export function presentProposal(proposal: ConversationConfigProposal, mayRead: RequestTextReader): Record<string, unknown> {
  if (mayRead(proposal.account)) return withoutAccount(proposal);
  return {
    id: proposal.id,
    ts: proposal.ts,
    status: proposal.status,
    mode: proposal.mode,
    assistantAgent: proposal.assistantAgent,
    ...(proposal.targetAgent ? { targetAgent: proposal.targetAgent } : {}),
    configChanges: proposal.configChanges.map((change) => ({ path: change.path })),
    promptChanges: proposal.promptChanges.map((change) => ({ agentName: change.agentName, strategy: change.strategy })),
    ...(proposal.appliedAt ? { appliedAt: proposal.appliedAt } : {}),
    feedbackHistory: proposal.feedbackHistory.map((feedback) => ({ ts: feedback.ts, outcome: feedback.outcome })),
  };
}

/** A flow-memory entry as a response carries it: whole for a reader who may have it, else its
 *  structure. Its actions are not structure: an entry posted to /api/flow-memory names its own. */
export function presentFlowEntry(entry: FlowMemoryEntry, mayRead: RequestTextReader): Record<string, unknown> {
  if (mayRead(entry.account)) return withoutAccount(entry);
  return {
    id: entry.id,
    ts: entry.ts,
    scope: entry.scope,
    ...(entry.assistantAgent ? { assistantAgent: entry.assistantAgent } : {}),
    ...(entry.targetAgent ? { targetAgent: entry.targetAgent } : {}),
    outcome: entry.outcome,
  };
}
