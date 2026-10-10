/**
 * Which user-scope document sources are the signed-in caller's own, for the Documents page's
 * "Personal library".
 *
 * The page picked the source `user:<username>`. Under multi-user auth the gateway keys a user's
 * corpus by the account id (`user:<id>`), plus any corpus from before account ids that the account
 * adopted, and names them in `currentUserSources`; matching the name there showed nothing of the
 * caller's own and could only ever match a corpus another identity of that name left behind. With
 * one operator the reply carries no `currentUserSources`, and the page matches the name as it
 * always did.
 */
export interface DocumentListOwner {
  currentUser: string | null;
  currentUserSources?: string[];
}

/** A predicate for the caller's own user sources, or undefined to show every user-scope source
 *  (no signed-in user, with one operator). */
export function ownUserSourceMatcher(owner: DocumentListOwner): ((source: string) => boolean) | undefined {
  if (owner.currentUserSources) {
    const own = new Set(owner.currentUserSources);
    return (source) => own.has(source);
  }
  if (!owner.currentUser) return undefined;
  const legacy = `user:${owner.currentUser}`;
  return (source) => source === legacy;
}
