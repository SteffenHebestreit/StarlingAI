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
import { currentUserId } from "./request-context.js";
import { getConfig } from "../config/loader.js";

const USERS_SUBDIR = "users";

/** Filesystem-safe segment for a userId (JWT `sub` / username). */
export function safeUserSegment(userId: string): string {
  return userId.trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "_";
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
  if (!userId || !partitioningEnabled()) return base;
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
