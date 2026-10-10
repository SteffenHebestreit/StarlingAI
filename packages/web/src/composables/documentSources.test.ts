import { describe, expect, it } from "vitest";
import { ownUserSourceMatcher } from "./documentSources";

/**
 * The Documents page's "Personal library" shows the caller's own user corpora.
 *
 * Under multi-user auth the gateway keys a user's corpus by the account id and names the caller's
 * own (with any corpus the account adopted) in `currentUserSources`. The page matched
 * `user:<username>`, which under auth is no corpus of the caller's: an account created again under
 * a deleted one's name would have been shown that one's. With one operator the reply has no
 * `currentUserSources` and the name is matched, as before.
 */
describe("ownUserSourceMatcher", () => {
  const OWN = "user:alice-0123456789abcdef";
  const ADOPTED = "user:alice";
  const OTHER = "user:alice-fedcba9876543210";

  it("under multi-user auth, matches the sources the gateway names, not the username", () => {
    const own = ownUserSourceMatcher({ currentUser: "alice", currentUserSources: [OWN, ADOPTED] })!;
    expect(own(OWN)).toBe(true);
    expect(own(ADOPTED)).toBe(true);
    // Another account of the same name: its corpus is not this one's.
    const recreated = ownUserSourceMatcher({ currentUser: "alice", currentUserSources: [OTHER] })!;
    expect(recreated(OTHER)).toBe(true);
    expect(recreated(OWN)).toBe(false);
    expect(recreated(ADOPTED)).toBe(false);
  });

  it("under multi-user auth with no corpus of its own, matches nothing", () => {
    const own = ownUserSourceMatcher({ currentUser: "alice", currentUserSources: [] })!;
    expect(own(ADOPTED)).toBe(false);
  });

  it("with one operator, matches the username's source, as before", () => {
    const own = ownUserSourceMatcher({ currentUser: "alice" })!;
    expect(own(ADOPTED)).toBe(true);
    expect(own(OWN)).toBe(false);
    expect(ownUserSourceMatcher({ currentUser: null })).toBeUndefined();
  });
});
