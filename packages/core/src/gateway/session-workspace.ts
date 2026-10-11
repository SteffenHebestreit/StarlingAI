/**
 * EVL-401: resolution of client-supplied session workspace overrides.
 *
 * `session.create` accepts a RELATIVE workspacePath so eval harnesses (and other
 * trusted local tooling) can run a session inside a specific fixture directory.
 * Historically the relative path was stored raw, which resolves against the
 * gateway process CWD — inside a container that is /app (the built image), not
 * the mounted repository, so gateway-routed eval fixtures were invisible to the
 * agents being evaluated.
 *
 * When `gateway.sessionWorkspaceRoot` is configured, relative overrides resolve
 * against that root with containment enforced (a path that escapes the root
 * after normalization is rejected). When unset, legacy raw-relative behavior is
 * preserved so existing deployments are unaffected.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";
import { sameAccountId } from "../runtime/accounts.js";
import { USERS_SUBDIR } from "../tools/workspace-zones.js";

export type SessionWorkspaceResolution =
  | { ok: true; path: string }
  | { ok: false; reason: string };

/** Whose override this is, and the deployment it runs in. */
export interface SessionWorkspaceCaller {
  /** The caller's own per-account segment (runtime/user-scope.ts segmentFor); undefined for nobody. */
  ownSegment: string | undefined;
  /** The deployment's shared workspace root, under which every account has `users/<segment>`. */
  deploymentRoot: string;
}

/**
 * The first `users/<segment>` level in `parts` that is not the caller's own, as written, or
 * undefined. A bare `users` with nothing after it counts too: it is no one's own root.
 */
function foreignUsersLevel(parts: string[], ownSegment: string | undefined): string | undefined {
  for (let i = 0; i < parts.length; i++) {
    if (parts[i]!.toLowerCase() !== USERS_SUBDIR) continue;
    const segment = parts[i + 1];
    if (!segment || !ownSegment || !sameAccountId(segment, ownSegment)) return parts.slice(0, i + 2).join("/");
  }
  return undefined;
}

/**
 * ANOTHER ACCOUNT'S ROOT IS NOT A PLACE TO ROOT A SESSION.
 *
 * The session roots itself at `<override>/users/<own segment>` (agent/session.ts,
 * userWorkspaceRoot), so an override of `users/<B>` put account A's session at
 * `users/<B>/users/<A>`: inside B's root, where B's agents read what A's write and A's agents
 * read what B leaves there. The same holds one level down for any prefix: the override `x`
 * roots B's session at `x/users/<B>`, so `x/users/<B>` is inside it too. So every
 * `users/<segment>` level the override names must be the caller's own, both in the requested
 * path (which is what the session root and the legacy working directory resolve it under) and
 * in where it lands relative to the deployment root (a session root configured inside one
 * account's tree is that account's, whatever the request says). Compared without case: a
 * case-insensitive mount makes `Users/B` the same directory.
 */
function foreignAccountProblem(requestedPath: string, resolvedPath: string, caller: SessionWorkspaceCaller): string | undefined {
  const requested = foreignUsersLevel(requestedPath.split(/[\\/]/).filter((part) => part !== "" && part !== "."), caller.ownSegment);
  if (requested) return `'${requested}' is not your own account's workspace`;
  const fromDeployment = relative(resolve(caller.deploymentRoot), resolvedPath);
  if (fromDeployment === "" || fromDeployment.startsWith("..") || isAbsolute(fromDeployment)) return undefined;
  const landed = foreignUsersLevel(fromDeployment.split(sep), caller.ownSegment);
  return landed ? `it resolves into '${landed}', which is not your own account's workspace` : undefined;
}

/**
 * Resolve a client-requested session workspace override.
 *
 * The caller (rpc.ts session.create) has already rejected absolute paths and
 * `..` segments; this function re-checks both so it fails closed even if the
 * call-site guard drifts.
 */
export function resolveSessionWorkspaceOverride(
  requestedPath: string,
  sessionWorkspaceRoot: string | undefined,
  caller: SessionWorkspaceCaller,
): SessionWorkspaceResolution {
  if (requestedPath.startsWith("/") || requestedPath.startsWith("\\") || /^[A-Za-z]:/.test(requestedPath)) {
    return { ok: false, reason: "absolute paths are not allowed" };
  }
  if (requestedPath.split(/[\\/]/).includes("..")) {
    return { ok: false, reason: "path traversal is not allowed" };
  }
  if (!sessionWorkspaceRoot) {
    // Legacy behavior: store the relative path raw (resolves against process CWD).
    const foreign = foreignAccountProblem(requestedPath, resolve(requestedPath), caller);
    if (foreign) return { ok: false, reason: foreign };
    return { ok: true, path: requestedPath };
  }
  const root = resolve(sessionWorkspaceRoot);
  const resolved = resolve(root, requestedPath);
  // Containment belt: normalization must keep the path at or under the root.
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    return { ok: false, reason: "resolved path escapes the session workspace root" };
  }
  const foreign = foreignAccountProblem(requestedPath, resolved, caller);
  if (foreign) return { ok: false, reason: foreign };
  return { ok: true, path: resolved };
}
