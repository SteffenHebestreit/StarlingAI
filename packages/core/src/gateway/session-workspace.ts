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
import { resolve, sep } from "node:path";

export type SessionWorkspaceResolution =
  | { ok: true; path: string }
  | { ok: false; reason: string };

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
): SessionWorkspaceResolution {
  if (requestedPath.startsWith("/") || requestedPath.startsWith("\\") || /^[A-Za-z]:/.test(requestedPath)) {
    return { ok: false, reason: "absolute paths are not allowed" };
  }
  if (requestedPath.split(/[\\/]/).includes("..")) {
    return { ok: false, reason: "path traversal is not allowed" };
  }
  if (!sessionWorkspaceRoot) {
    // Legacy behavior: store the relative path raw (resolves against process CWD).
    return { ok: true, path: requestedPath };
  }
  const root = resolve(sessionWorkspaceRoot);
  const resolved = resolve(root, requestedPath);
  // Containment belt: normalization must keep the path at or under the root.
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    return { ok: false, reason: "resolved path escapes the session workspace root" };
  }
  return { ok: true, path: resolved };
}
