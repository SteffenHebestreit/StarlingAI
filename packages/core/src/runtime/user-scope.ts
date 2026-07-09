/**
 * Per-user partitioning of the durable "user"-scope stores (user memory, the
 * dialectic user-model, and the personality override).
 *
 * Multi-user auth (Wave A) authenticates a user and stamps `ctx.userId` onto the
 * request context, but historically every user-scope store resolved to a SINGLE
 * shared path — so two logged-in operators shared one memory / user-model /
 * personality. These helpers key those stores by the ambient authenticated user
 * so each account gets its own bucket, while staying fully back-compatible:
 * when no userId is present (single-operator / auth-disabled — the default) the
 * store stays at its original shared path unchanged.
 */
import { resolve } from "node:path";
import { readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { currentUserId, currentUserScopeSegment } from "./request-context.js";
import { getConfig } from "../config/loader.js";

const USERS_SUBDIR = "users";

/**
 * Filesystem-safe, INJECTIVE segment for a userId (JWT `sub` / username).
 *
 * The readable prefix is for human/debug legibility only; the appended hash of the RAW
 * userId is what guarantees uniqueness. A pure char-replace (the previous implementation)
 * is LOSSY: `a.b` and `a_b` both collapse to `a_b`, and an 80-char truncation collides on a
 * shared prefix — so two DISTINCT valid accounts (builtin `alice.smith` vs `alice_smith`,
 * or IdP-controlled preferred_usernames that normalise together) silently shared ONE
 * durable-memory / personality / user-model bucket. The hash suffix makes distinct ids map
 * to distinct buckets, and also guarantees the segment can never BE a Windows reserved
 * device name (CON, PRN, NUL, …). NOTE: not reversible — sweeps that need to target an
 * existing bucket pass its on-disk segment via RequestContext.userScopeSegment, never back
 * through this function (which would double-hash).
 */
export function safeUserSegment(userId: string): string {
  const raw = userId.trim();
  const prefix = raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48).replace(/^-+/, "") || "u";
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  return `${prefix}-${hash}`;
}

/** Per-user partitioning only applies under active multi-user auth. */
function partitioningEnabled(): boolean {
  return getConfig().auth?.enabled === true;
}

/**
 * Partition a user-scope store directory by the ambient authenticated user.
 * `<base>/users/<safeUserId>/` when multi-user auth is on AND a userId is
 * present; `<base>` unchanged otherwise — so single-operator / auth-disabled
 * installs (the default) keep their original shared path (fully back-compat).
 * Pass an explicit `userId` (e.g. from a background sweep) to target a specific
 * user's bucket instead of the ambient one.
 */
export function userScopedDir(base: string, userId: string | undefined = currentUserId()): string {
  if (!partitioningEnabled()) return base;
  // A sweep enumerating existing buckets supplies the exact on-disk segment — use it
  // verbatim rather than re-deriving (and double-hashing) it from a userId.
  const segment = currentUserScopeSegment();
  if (segment) return resolve(base, USERS_SUBDIR, segment);
  if (!userId) return base;
  return resolve(base, USERS_SUBDIR, safeUserSegment(userId));
}

/**
 * The per-user store segments that exist under `<base>/users` — for background
 * drivers / admin surfaces that must enumerate every user's bucket rather than
 * only the ambient one. Returns the on-disk (already-safe) segment names.
 */
export function listUserScopeSegments(base: string): string[] {
  try {
    return readdirSync(resolve(base, USERS_SUBDIR), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}
