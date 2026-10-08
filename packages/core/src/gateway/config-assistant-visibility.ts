/**
 * Who gets a config-assistant request's own words back (found in review, 2026-10-08).
 *
 * The proposals store and flow memory are one file each for the whole deployment, and every
 * signed-in account, a viewer too, read every account's raw request text through
 * GET /api/flow-memory and GET /api/config-assistant/proposals; applying a proposal or giving it
 * feedback answered with its request too. Under multi-user auth the request text now goes only to
 * its author, recorded on the item as their user-scope segment, and to an admin. Everyone else gets
 * the item without it: the summary, the changes and the actions stay, so every account can still
 * review and apply a proposal. The author's segment is never sent. With one operator every request
 * is theirs and every item goes out as it is stored.
 */
import { authenticatedUser, userHasRole } from "./auth.js";
import { canReadRecord, recordReader } from "../runtime/user-scope.js";

/** Whether the request text of an item written for `account` may go to this reader. */
export type RequestTextReader = (account: string | undefined) => boolean;

/** The reader the current request is: every item with multi-user auth off; under it an admin, or
 *  the item's author (a request with no user is neither). */
export async function requestTextReader(authHeader: string | undefined): Promise<RequestTextReader> {
  const reader = recordReader();
  if (reader.all) return () => true;
  const admin = userHasRole(await authenticatedUser(authHeader), "admin");
  return (account) => admin || canReadRecord(reader, account);
}

/** The item as a response carries it: never the author's segment, and the request text only for a
 *  reader who may have it. Every other field stays where it was. */
export function presentRequestItem<T extends { request?: string; account?: string }>(
  item: T,
  mayRead: RequestTextReader,
): Omit<T, "account" | "request"> & { request?: string } {
  const presented: Record<string, unknown> = { ...item };
  delete presented["account"];
  if (!mayRead(item.account)) delete presented["request"];
  return presented as Omit<T, "account" | "request"> & { request?: string };
}
