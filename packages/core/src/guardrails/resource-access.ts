/**
 * Per-user resource ownership guard.
 *
 * Shared resources (mail accounts, stored site credentials, compute nodes) are
 * global by default. When multi-user auth is enabled, an operator can bind a
 * resource to specific users via an `allowedUsers` list; this helper is the
 * single decision point every tool uses to enforce that binding.
 *
 * Rules:
 * - allowedUsers empty / unset  → shared resource, everyone may use it.
 *   (Unbound is shared BY DESIGN; private-by-default would need a per-resource
 *   owner model — a separate feature.)
 * - allowedUsers set + userId undefined:
 *     · multi-user auth OFF → single-operator / token mode, allow (back-compat).
 *     · multi-user auth ON  → FAIL CLOSED: a restricted resource must never leak
 *       to an unauthenticated / user-less caller under active auth.
 * - allowedUsers set + userId present → allow IFF allowedUsers includes the user.
 *
 * Usernames are compared case-insensitively (auth lowercases usernames).
 */
import { getConfig } from "../config/loader.js";

export interface OwnedResource {
  /** Usernames permitted to use this resource. Empty/undefined = shared. */
  allowedUsers?: string[] | null;
}

export function canAccessResource(userId: string | undefined, resource: OwnedResource | undefined | null): boolean {
  const allowed = resource?.allowedUsers;
  if (!allowed || allowed.length === 0) return true; // shared / unbound resource
  if (!userId) return getConfig().auth?.enabled !== true; // bound + no user: closed under auth, open when off
  const u = userId.toLowerCase();
  return allowed.some((a) => a.toLowerCase() === u);
}

/**
 * Filter a list of owned resources to those the user may access.
 */
export function filterAccessibleResources<T extends OwnedResource>(userId: string | undefined, resources: readonly T[]): T[] {
  return resources.filter((r) => canAccessResource(userId, r));
}

/**
 * Standard denial message for a resource the user is not permitted to use.
 * Deliberately does not leak whether the resource exists beyond its id.
 */
export function resourceDeniedMessage(kind: string, id: string): string {
  return `Access to ${kind} '${id}' is restricted to specific users and is not available to the current user.`;
}
